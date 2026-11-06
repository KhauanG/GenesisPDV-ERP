using System.Net;
using System.Text.Json.Nodes;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Pull;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Sync.Tests;

/// <summary>Carga inicial retomável (SYNC 6.9; PDV 5.3, 5.5): ordem da 6.1, teto estável, término vazio e retomada.</summary>
public sealed class CargaInicialTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static void PublicarMarcas(ApiFalsa api, int quantidade)
    {
        for (var i = 0; i < quantidade; i++)
        {
            api.Publicar("catalogo", "marcas", new JsonObject { ["id"] = Guid.CreateVersion7().ToString("D"), ["descricao"] = $"MARCA {i:000}", ["excluido_em"] = null });
        }
    }

    private static List<(string Fluxo, long Desde, string? Teto)> Pulls(ApiFalsa api) =>
        [.. api.Envios.Where(e => e.Rota.EndsWith("/sync/pull", StringComparison.Ordinal)).Select(e =>
        {
            var q = System.Web.HttpUtility.ParseQueryString(e.Consulta);
            return (q["fluxo"]!, long.Parse(q["desde"]!, System.Globalization.CultureInfo.InvariantCulture), q["teto"]);
        })];

    [Fact]
    public async Task Carga_percorre_os_7_fluxos_na_ordem_libera_o_login_e_operacao_vazio_termina()
    {
        using var amb = await AmbienteSync.CriarAsync();
        Assert.True((await amb.AtivarAsync()).Ativado);
        amb.Api.PublicarLojaECaixa();
        amb.Api.PublicarUsuario("maria", 7, hashPin: null);
        PublicarMarcas(amb.Api, CargaInicial.Limite + 5);
        amb.Api.Publicar("estoque", "saldos_estoque", new JsonObject
        {
            ["id"] = Guid.CreateVersion7().ToString("D"),
            ["produto_id"] = Guid.CreateVersion7().ToString("D"),
            ["tipo_estoque_id"] = Guid.CreateVersion7().ToString("D"),
            ["estoque_id"] = Guid.CreateVersion7().ToString("D"),
            ["quantidade"] = "24.000",
            ["excluido_em"] = null,
        });
        Assert.False(await CargaInicial.LoginLiberadoAsync(amb.Fabrica, Ct));

        var progresso = new List<ProgressoCarga>();
        await amb.Carga.ExecutarAsync(new ProgressoSincrono(progresso), Ct);

        Assert.True(await CargaInicial.LoginLiberadoAsync(amb.Fabrica, Ct));
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            Assert.All(await db.EstadoSincronizacao.ToListAsync(Ct), e => Assert.True(e.CargaInicialConcluida, e.Fluxo));
        }

        Assert.Equal(CargaInicial.Limite + 5, amb.Contar("marcas"));
        Assert.Equal(24000L, amb.Escalar("select quantidade from saldos_estoque"));
        Assert.Equal(1L, amb.Contar("usuarios"));
        var pulls = Pulls(amb.Api);
        Assert.Equal(CargaInicial.Ordem, pulls.Select(p => p.Fluxo).Distinct());
        // catalogo: 2 páginas; a 2ª repete o cursor_teto da 1ª (barra estável) e começa no cursor salvo.
        var catalogo = pulls.Where(p => p.Fluxo == "catalogo").ToList();
        Assert.Equal(2, catalogo.Count);
        Assert.Null(catalogo[0].Teto);
        Assert.NotNull(catalogo[1].Teto);
        Assert.True(catalogo[1].Desde > 0);
        Assert.Contains(progresso, p => p is { Fluxo: "operacao", FluxoConcluido: true, Percentual: 100 });
        // O login libera ao fim do estoque, antes de pessoas e operação.
        var liberou = progresso.FindIndex(p => p.LoginLiberado);
        Assert.Equal("estoque", progresso[liberou].Fluxo);

        // Rodar de novo não pede nada: tudo concluído.
        var antes = pulls.Count;
        await amb.Carga.ExecutarAsync(ct: Ct);
        Assert.Equal(antes, Pulls(amb.Api).Count);
    }

    [Fact]
    public async Task Carga_interrompida_retoma_do_cursor_de_cada_fluxo_sem_refazer_os_concluidos()
    {
        using var amb = await AmbienteSync.CriarAsync();
        Assert.True((await amb.AtivarAsync()).Ativado);
        amb.Api.PublicarLojaECaixa();
        PublicarMarcas(amb.Api, CargaInicial.Limite + 10);
        var paginasCatalogo = 0;
        amb.Api.AoPuxar = e => e.Consulta.Contains("fluxo=catalogo", StringComparison.Ordinal) && ++paginasCatalogo == 2
            ? throw new HttpRequestException("rede caiu no meio do catálogo")
            : null;

        await Assert.ThrowsAsync<HttpRequestException>(() => amb.Carga.ExecutarAsync(ct: Ct));
        Assert.False(await CargaInicial.LoginLiberadoAsync(amb.Fabrica, Ct));
        Assert.Equal(CargaInicial.Limite, amb.Contar("marcas"));
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            var estados = await db.EstadoSincronizacao.ToDictionaryAsync(e => e.Fluxo, Ct);
            Assert.True(estados["configuracao"].CargaInicialConcluida);
            Assert.True(estados["referencia"].CargaInicialConcluida);
            Assert.False(estados["catalogo"].CargaInicialConcluida);
            Assert.True(estados["catalogo"].Cursor > 0);
            Assert.Contains("rede caiu", estados["catalogo"].UltimoErro, StringComparison.Ordinal);
        }

        // App reaberto: retoma; o catálogo continua do cursor salvo e os fluxos concluídos não são pedidos de novo.
        var cursorCatalogo = (long)amb.Escalar("select cursor from estado_sincronizacao where fluxo = 'catalogo'")!;
        var antes = Pulls(amb.Api).Count;
        var carga = new CargaInicial(amb.Cliente, amb.Aplicador, amb.Fabrica, amb.Terminal, Microsoft.Extensions.Logging.Abstractions.NullLogger<CargaInicial>.Instance);
        await carga.ExecutarAsync(ct: Ct);
        var retomada = Pulls(amb.Api).Skip(antes).ToList();
        Assert.Equal(new[] { "catalogo", "estoque", "pessoas", "operacao" }, retomada.Select(p => p.Fluxo).Distinct());
        Assert.Equal(cursorCatalogo, retomada[0].Desde);
        Assert.Equal(CargaInicial.Limite + 10, amb.Contar("marcas"));
        Assert.True(await CargaInicial.LoginLiberadoAsync(amb.Fabrica, Ct));
        Assert.Equal(1L, amb.Escalar("select ultimo_erro is null from estado_sincronizacao where fluxo = 'catalogo'"));
    }

    [Fact]
    public async Task Nuvem_restaurada_com_teto_menor_que_o_cursor_nao_conclui_o_fluxo_e_grava_o_erro()
    {
        using var amb = await AmbienteSync.CriarAsync();
        Assert.True((await amb.AtivarAsync()).Ativado);
        amb.Api.PublicarLojaECaixa();
        PublicarMarcas(amb.Api, CargaInicial.Limite + 10);
        var paginasCatalogo = 0;
        amb.Api.AoPuxar = e => e.Consulta.Contains("fluxo=catalogo", StringComparison.Ordinal) && ++paginasCatalogo == 2
            ? throw new HttpRequestException("rede caiu no meio do catálogo")
            : null;
        await Assert.ThrowsAsync<HttpRequestException>(() => amb.Carga.ExecutarAsync(ct: Ct));
        var cursor = (long)amb.Escalar("select cursor from estado_sincronizacao where fluxo = 'catalogo'")!;

        // O banco da nuvem volta de um backup anterior ao cursor (SYNC 22.5): a API responde página vazia,
        // `novo_cursor = desde`, `tem_mais = false` e `cursor_teto` menor que o cursor.
        amb.Api.AoPuxar = null;
        amb.Api.Nuvem.RemoveAll(l => l.Versao >= cursor - 10);
        var erro = await Assert.ThrowsAsync<InvalidOperationException>(() => amb.Carga.ExecutarAsync(ct: Ct));
        Assert.Contains("Chame o suporte", erro.Message, StringComparison.Ordinal);
        var catalogo = Pulls(amb.Api).Last();
        Assert.Equal(("catalogo", cursor), (catalogo.Fluxo, catalogo.Desde));

        await using (var db = amb.Fabrica.CreateDbContext())
        {
            var estado = await db.EstadoSincronizacao.SingleAsync(e => e.Fluxo == "catalogo", Ct);
            Assert.False(estado.CargaInicialConcluida);
            Assert.True(estado.Ressincronizar);
            Assert.Equal(cursor, estado.Cursor);
            Assert.Contains("teto menor que o cursor", estado.UltimoErro, StringComparison.Ordinal);
        }

        Assert.False(await CargaInicial.LoginLiberadoAsync(amb.Fabrica, Ct));
        Assert.Equal(CargaInicial.Limite, amb.Contar("marcas"));
    }

    [Fact]
    public async Task Revogacao_durante_a_carga_grava_revogado_e_token_recusado_nao_muda_a_identidade()
    {
        using var amb = await AmbienteSync.CriarAsync();
        Assert.True((await amb.AtivarAsync()).Ativado);
        amb.Api.PublicarLojaECaixa();
        // Ativado no caixa errado: o gerente revoga no ERP (revogação imediata) antes do fim dos fluxos bloqueantes.
        amb.Api.AoPuxar = e => e.Consulta.Contains("fluxo=catalogo", StringComparison.Ordinal)
            ? ApiFalsa.Erro(HttpStatusCode.Unauthorized, "TERMINAL_REVOGADO", "Este terminal foi desativado no ERP.")
            : null;
        var erro = await Assert.ThrowsAsync<ErroSyncException>(() => amb.Carga.ExecutarAsync(ct: Ct));
        Assert.True(CargaInicial.Revogado(erro));
        Assert.False(CargaInicial.TokenRecusado(erro));
        Assert.Equal(StatusIdentidade.Revogado, (await amb.Terminal.ObterIdentidadeAsync(Ct))!.Status);
        Assert.Equal(1L, amb.Contar("identidade_terminal"));

        // Reaberto sem rede, o handshake já sabe: só a tela de desativado, nada de carga nem de login.
        amb.Api.ForaDoAr = true;
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Revogado, (await ciclo.HandshakeAsync(Ct)).Desfecho);

        // 401 TOKEN_INVALIDO: a tela de bloqueio "chame o suporte"; a identidade fica como está (a nuvem pode voltar a aceitar).
        using var outro = await AmbienteSync.CriarAsync();
        Assert.True((await outro.AtivarAsync()).Ativado);
        outro.Api.HashesValidos.Clear();
        var recusa = await Assert.ThrowsAsync<ErroSyncException>(() => outro.Carga.ExecutarAsync(ct: Ct));
        Assert.True(CargaInicial.TokenRecusado(recusa));
        Assert.Equal(StatusIdentidade.Ativo, (await outro.Terminal.ObterIdentidadeAsync(Ct))!.Status);
    }

    /// <summary><see cref="Progress{T}"/> posta no contexto; este grava na hora (a ordem importa no teste).</summary>
    private sealed class ProgressoSincrono(List<ProgressoCarga> lista) : IProgress<ProgressoCarga>
    {
        public void Report(ProgressoCarga value) => lista.Add(value);
    }
}
