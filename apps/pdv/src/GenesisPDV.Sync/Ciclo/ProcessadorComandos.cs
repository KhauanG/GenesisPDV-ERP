using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Protocolo;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.Sync.Ciclo;

/// <summary>Tipos de <c>comandos_terminal</c> (SYNC 21.1; <c>ck_comandos_terminal_tipo</c> da nuvem).</summary>
public static class TiposComando
{
    public const string Revogar = "revogar";
    public const string Ressincronizar = "ressincronizar";
    public const string RessincronizarFluxo = "ressincronizar_fluxo";
    public const string Mensagem = "mensagem";
    public const string EnviarLogs = "enviar_logs";
    public const string AtualizarApp = "atualizar_app";
    public const string ReservarFaixa = "reservar_faixa";
}

/// <summary>
/// Comandos da nuvem (SYNC 21.1): entrega ao menos uma vez, então cada <c>comando_id</c> é executado uma vez só e o
/// resultado fica em <c>comandos_recebidos</c>; a repetição devolve o resultado gravado. Na Fase 1B:
/// <list type="bullet">
/// <item><c>revogar</c>: grava <c>desativando</c> (3.8; a confirmação sai no heartbeat quando o outbox esvaziar).</item>
/// <item><c>ressincronizar</c> e <c>ressincronizar_fluxo</c>: cursor do fluxo (ou de todos) volta a 0 e o ciclo baixa de
/// novo em segundo plano, com o caixa funcionando. A ressincronização em sombra da 6.11 (apagar o que não voltou) fica
/// para depois: por ora a linha que saiu do filtro só sai pelo tombstone.</item>
/// <item><c>mensagem</c>: mostrada ao operador (<see cref="MensagemRecebida"/>).</item>
/// <item><c>enviar_logs</c>, <c>atualizar_app</c>, <c>reservar_faixa</c>: <c>falhou</c> com "não suportado".</item>
/// </list>
/// </summary>
public sealed class ProcessadorComandos(IDbContextFactory<PdvDbContext> fabrica, RepositorioTerminal terminal, IRelogio relogio, ILogger<ProcessadorComandos> log)
{
    public const string ErroNaoSuportado = "Comando não suportado nesta versão do PDV.";

    /// <summary>Texto de um comando <c>mensagem</c> (a tela mostra ao operador).</summary>
    public event EventHandler<string>? MensagemRecebida;

    /// <summary>O comando <c>revogar</c> gravou o <c>desativando</c>.</summary>
    public event EventHandler? DesativacaoIniciada;

    /// <summary>Executa (ou reaproveita) cada comando e devolve o ack para o próximo heartbeat.</summary>
    public async Task<IReadOnlyList<ResultadoComando>> ProcessarAsync(IReadOnlyList<ComandoTerminal> comandos, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(comandos);
        var acks = new List<ResultadoComando>();
        foreach (var comando in comandos)
        {
            acks.Add(await ProcessarAsync(comando, ct));
        }

        return acks;
    }

    private async Task<ResultadoComando> ProcessarAsync(ComandoTerminal comando, CancellationToken ct)
    {
        await using (var db = await fabrica.CreateDbContextAsync(ct))
        {
            var anterior = await db.ComandosRecebidos.AsNoTracking().FirstOrDefaultAsync(c => c.ComandoId == comando.Id, ct);
            if (anterior is { Status: not "recebido" })
            {
                return Ack(comando.Id, anterior.Status, anterior.Resultado);
            }

            if (anterior is null)
            {
                // Gravado antes de executar: queda no meio = executa de novo na repetição (todos são idempotentes).
                db.ComandosRecebidos.Add(new ComandoRecebido { ComandoId = comando.Id, Tipo = comando.Tipo, RecebidoEm = relogio.Agora });
                await db.SaveChangesAsync(ct);
            }
        }

        string status;
        JsonObject resultado;
        try
        {
            (status, resultado) = await ExecutarAsync(comando, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            log.LogError(e, "Comando {Comando} ({Tipo}) falhou", comando.Id, comando.Tipo);
            (status, resultado) = ("falhou", new JsonObject { ["erro"] = e.Message });
        }

        var texto = resultado.ToJsonString();
        await using (var db = await fabrica.CreateDbContextAsync(ct))
        {
            // O status e a ocorrência juntos: a ocorrência é "uma vez por comando" porque a repetição devolve o resultado
            // gravado e não chega aqui — gravar o "falhou" sem ela (o SQLite ocupado no segundo passo) a perderia de vez.
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            await db.ComandosRecebidos.Where(c => c.ComandoId == comando.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(c => c.Status, status).SetProperty(c => c.Resultado, texto), ct);
            if (status == "falhou")
            {
                // A ocorrência para a aba 5 da Central (bloco G8): o tipo e o porquê.
                db.LogLocal.Add(Ocorrencias.Nova(
                    relogio.Agora, NiveisOcorrencia.Aviso, CodigoOcorrencia.ComandoFalhou,
                    $"Comando do ERP não feito ({comando.Tipo}): {Texto(resultado, "erro") ?? "sem motivo"}",
                    new JsonObject { ["comando_id"] = comando.Id.ToString(), ["tipo"] = comando.Tipo }));
                await db.SaveChangesAsync(ct);
            }

            await tx.CommitAsync(ct);
        }

        log.LogInformation("Comando {Comando} ({Tipo}): {Status}", comando.Id, comando.Tipo, status);
        return Ack(comando.Id, status, texto);
    }

    private async Task<(string Status, JsonObject Resultado)> ExecutarAsync(ComandoTerminal comando, CancellationToken ct)
    {
        switch (comando.Tipo)
        {
            case TiposComando.Revogar:
                if (await terminal.AvancarStatusAsync(StatusIdentidade.Desativando, ct))
                {
                    DesativacaoIniciada?.Invoke(this, EventArgs.Empty);
                }

                return ("executado", new JsonObject { ["estado_local"] = StatusIdentidade.Desativando });
            case TiposComando.Ressincronizar:
                return ("executado", await ReiniciarAsync(EstadoSincronizacao.Fluxos, ct));
            case TiposComando.RessincronizarFluxo:
                var fluxo = Texto(comando.Parametros, "fluxo");
                if (fluxo is null || !EstadoSincronizacao.Fluxos.Contains(fluxo))
                {
                    return ("falhou", new JsonObject { ["erro"] = $"Fluxo desconhecido: {fluxo ?? "(vazio)"}." });
                }

                return ("executado", await ReiniciarAsync([fluxo], ct));
            case TiposComando.Mensagem:
                var texto = Texto(comando.Parametros, "texto");
                if (string.IsNullOrWhiteSpace(texto))
                {
                    return ("falhou", new JsonObject { ["erro"] = "Mensagem vazia." });
                }

                await terminal.RegistrarOcorrenciaAsync(NiveisOcorrencia.Info, CodigoOcorrencia.MensagemErp, $"Mensagem do ERP: {texto}", ct: ct);
                MensagemRecebida?.Invoke(this, texto);
                return ("executado", new JsonObject { ["exibida_em"] = FormatoProtocolo.DataHora(relogio.Agora) });
            default:
                // enviar_logs, atualizar_app, reservar_faixa (e qualquer tipo novo): fases seguintes.
                return ("falhou", new JsonObject { ["erro"] = ErroNaoSuportado, ["tipo"] = comando.Tipo });
        }
    }

    /// <summary>Cursor 0 nos fluxos: o ciclo baixa de novo (upsert por versão; nada local é apagado).</summary>
    private async Task<JsonObject> ReiniciarAsync(IReadOnlyList<string> fluxos, CancellationToken ct)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var lista = fluxos.ToArray();
        await db.EstadoSincronizacao.Where(e => lista.Contains(e.Fluxo)).ExecuteUpdateAsync(
            s => s.SetProperty(e => e.Cursor, 0L).SetProperty(e => e.Ressincronizar, false).SetProperty(e => e.UltimoErro, (string?)null),
            ct);
        log.LogInformation("Ressincronização pedida pela nuvem: cursor reiniciado em {Fluxos}", string.Join(", ", lista));
        return new JsonObject { ["fluxos"] = new JsonArray([.. lista.Select(f => JsonValue.Create(f))]), ["cursor"] = 0 };
    }

    private static string? Texto(JsonObject resultado, string chave) =>
        resultado[chave] is JsonValue v && v.TryGetValue<string>(out var texto) ? texto : null;

    private static string? Texto(JsonElement parametros, string chave) =>
        parametros.ValueKind == JsonValueKind.Object && parametros.TryGetProperty(chave, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static ResultadoComando Ack(Guid id, string status, string? resultado)
    {
        JsonElement? json = null;
        if (resultado is not null)
        {
            using var doc = JsonDocument.Parse(resultado);
            json = doc.RootElement.Clone();
        }

        return new ResultadoComando(id, status, json);
    }
}
