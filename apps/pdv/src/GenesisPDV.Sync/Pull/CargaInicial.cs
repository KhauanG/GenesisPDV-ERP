using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.Sync.Pull;

/// <summary>Andamento da carga, para a tela de progresso (PDV 5.3 passo 5).</summary>
/// <param name="Fluxo">Fluxo em andamento (ou o último concluído).</param>
/// <param name="Indice">Posição do fluxo na ordem da SYNC 6.1 (0 = <c>configuracao</c>).</param>
/// <param name="Linhas">Linhas recebidas no fluxo nesta execução.</param>
/// <param name="Percentual">0–100 do fluxo, pelo cursor entre o início e o teto (estável: o teto é o da 1ª página).</param>
/// <param name="FluxoConcluido">O fluxo terminou a carga (<c>carga_inicial_concluida = 1</c>).</param>
/// <param name="LoginLiberado">Os fluxos que bloqueiam as vendas terminaram (o login já pode ser liberado).</param>
public sealed record ProgressoCarga(string Fluxo, int Indice, long Linhas, int Percentual, bool FluxoConcluido, bool LoginLiberado);

/// <summary>
/// Carga inicial retomável (SYNC 6.9; PDV 5.3, 5.5): percorre os fluxos na ordem da 6.1 com <c>limite = 2000</c> e
/// <c>teto = cursor_teto</c> da primeira página (a barra de progresso fica estável), gravando página e cursor no mesmo
/// commit (<see cref="AplicadorPull"/>). Interrompida (rede, energia, app fechado), a próxima execução retoma do cursor
/// salvo de cada fluxo e pula os já concluídos. O fluxo termina quando <c>tem_mais = false</c> com
/// <c>novo_cursor ≥ cursor_teto</c> — inclusive vazio, como o <c>operacao</c> da Fase 1B. Teto menor que o cursor
/// (a nuvem voltou no tempo, SYNC 6.3 e 22.5) para a carga com erro, sem concluir o fluxo. Durante a carga o SQLite usa
/// <c>synchronous=NORMAL</c> (antes da primeira venda) e volta a <c>FULL</c> depois. O login é liberado depois de
/// <c>configuracao</c>, <c>acesso</c>, <c>referencia</c>, <c>catalogo</c> e <c>estoque</c>; <c>pessoas</c> e
/// <c>operacao</c> seguem em segundo plano. O snapshot NDJSON (SYNC 6.9) fica para depois: a API ainda não o oferece.
/// 401 <c>TERMINAL_REVOGADO</c> num pull grava <c>revogado</c> na identidade antes de subir (SYNC 3.8: como no ciclo
/// online, o terminal fica desativado também na reabertura sem rede); a tela vai para "Terminal desativado".
/// </summary>
public sealed class CargaInicial(
    IClienteSync cliente,
    AplicadorPull aplicador,
    IDbContextFactory<PdvDbContext> fabrica,
    RepositorioTerminal terminal,
    ILogger<CargaInicial> log)
{
    public const int Limite = 2000;

    /// <summary>Ordem da SYNC 6.1 (prioridade da carga e do ciclo).</summary>
    public static IReadOnlyList<string> Ordem { get; } = EstadoSincronizacao.Fluxos;

    /// <summary>Fluxos que bloqueiam o login e as vendas até concluir (SYNC 6.1).</summary>
    public static IReadOnlyList<string> Bloqueantes { get; } = ["configuracao", "acesso", "referencia", "catalogo", "estoque"];

    /// <summary>Os fluxos bloqueantes já concluíram a carga (o terminal pode ir para o login).</summary>
    public static async Task<bool> LoginLiberadoAsync(IDbContextFactory<PdvDbContext> fabrica, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(fabrica);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var concluidos = await db.EstadoSincronizacao.AsNoTracking()
            .Where(e => e.CargaInicialConcluida).Select(e => e.Fluxo).ToListAsync(ct);
        return Bloqueantes.All(concluidos.Contains);
    }

    /// <summary>
    /// Executa (ou retoma) a carga de todos os fluxos. Erro de rede ou da API sobe para a tela, com o cursor do fluxo
    /// intacto e o erro em <c>estado_sincronizacao.ultimo_erro</c>; a nova tentativa continua dali.
    /// </summary>
    public async Task ExecutarAsync(IProgress<ProgressoCarga>? progresso = null, CancellationToken ct = default)
    {
        var estados = await EstadosAsync(ct);
        var liberado = Bloqueantes.All(f => estados.TryGetValue(f, out var e) && e.CargaInicialConcluida);
        for (var i = 0; i < Ordem.Count; i++)
        {
            var fluxo = Ordem[i];
            var estado = estados.GetValueOrDefault(fluxo);
            if (estado is { CargaInicialConcluida: true })
            {
                progresso?.Report(new ProgressoCarga(fluxo, i, 0, 100, FluxoConcluido: true, liberado));
                continue;
            }

            var inicio = estado?.Cursor ?? 0;
            var cursor = inicio;
            long? teto = null;
            long linhas = 0;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                Protocolo.RespostaPull pagina;
                try
                {
                    pagina = await cliente.PullAsync(fluxo, cursor, Limite, teto, ct);
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    log.LogWarning(e, "Carga inicial: falha no pull de {Fluxo} a partir de {Cursor}", fluxo, cursor);
                    await aplicador.RegistrarErroAsync(fluxo, e.Message, CancellationToken.None);
                    if (Revogado(e))
                    {
                        await terminal.AvancarStatusAsync(StatusIdentidade.Revogado, CancellationToken.None);
                        log.LogWarning("Terminal desativado pelo ERP durante a carga inicial (401 no pull de {Fluxo}): o banco local fica intacto", fluxo);
                    }

                    throw;
                }

                if (pagina.CursorTeto < cursor)
                {
                    // O banco da nuvem voltou no tempo (SYNC 6.3, 22.5): a API devolve a página vazia com
                    // `novo_cursor = desde` e `tem_mais = false`, que pareceria fim de carga. As linhas gravadas depois da
                    // restauração teriam versão abaixo do cursor e nunca desceriam: nada é aplicado, o fluxo fica sem
                    // concluir, marcado para ressincronizar, e não libera o login.
                    log.LogError("Carga inicial de {Fluxo}: teto {Teto} menor que o cursor local {Cursor}", fluxo, pagina.CursorTeto, cursor);
                    const string Mensagem = "A nuvem devolveu um teto menor que o cursor local (banco restaurado?). Chame o suporte.";
                    await aplicador.RegistrarErroAsync(fluxo, Mensagem, CancellationToken.None, ressincronizar: true);
                    throw new InvalidOperationException(Mensagem);
                }

                teto ??= pagina.CursorTeto;
                var concluiu = !pagina.TemMais && pagina.NovoCursor >= pagina.CursorTeto;
                await aplicador.AplicarAsync(pagina, cargaInicial: true, concluirCarga: concluiu, ct);
                linhas += pagina.Alteracoes.Count;
                cursor = pagina.NovoCursor;
                if (concluiu && Bloqueantes.Contains(fluxo))
                {
                    estados[fluxo] = new EstadoSincronizacao { Fluxo = fluxo, Cursor = cursor, CargaInicialConcluida = true };
                    liberado = Bloqueantes.All(f => estados.TryGetValue(f, out var e) && e.CargaInicialConcluida);
                }

                progresso?.Report(new ProgressoCarga(fluxo, i, linhas, Percentual(inicio, cursor, teto.Value, concluiu), concluiu, liberado));
                if (!pagina.TemMais)
                {
                    log.LogInformation("Carga inicial de {Fluxo} concluída: {Linhas} linhas, cursor {Cursor}", fluxo, linhas, cursor);
                    break;
                }
            }
        }
    }

    /// <summary>401 <c>TERMINAL_REVOGADO</c> (revogação no ERP): a carga não continua, nem com Enter.</summary>
    public static bool Revogado(Exception erro) =>
        erro is ErroSyncException { Status: System.Net.HttpStatusCode.Unauthorized, Codigo: "TERMINAL_REVOGADO" };

    /// <summary>401 com outro código (<c>TOKEN_INVALIDO</c>): a nuvem não aceita o token; o bloqueio "chame o suporte".</summary>
    public static bool TokenRecusado(Exception erro) =>
        erro is ErroSyncException { Status: System.Net.HttpStatusCode.Unauthorized } && !Revogado(erro);

    private async Task<Dictionary<string, EstadoSincronizacao>> EstadosAsync(CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.EstadoSincronizacao.AsNoTracking().ToDictionaryAsync(e => e.Fluxo, StringComparer.Ordinal, ct);
    }

    private static int Percentual(long inicio, long cursor, long teto, bool concluiu)
    {
        if (concluiu || teto <= inicio)
        {
            return concluiu ? 100 : 0;
        }

        return (int)Math.Clamp((cursor - inicio) * 100 / (teto - inicio), 0, 99);
    }
}
