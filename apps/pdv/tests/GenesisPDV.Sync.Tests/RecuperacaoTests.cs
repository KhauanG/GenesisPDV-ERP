using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;
using GenesisPDV.Sync.Push;
using GenesisPDV.Sync.Recuperacao;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Recuperação 22.1 contra a <see cref="ApiFalsa"/> (Fase 1C, C17): o handshake com regressão reidrata pelo
/// <c>GET /sync/recuperar</c> (vendas, caixa e o placeholder da lacuna), uma transação por página e idempotente, salta a
/// numeração e só então libera; o banco restaurado com vendas offline leva os eventos do caixa para depois dos da
/// nuvem; a prova de que nada se perdeu dispensa o salto; a recuperação interrompida continua de onde parou, com o push
/// parado até ela terminar e o caixa gravando acima do que a nuvem tem; com a empresa suspensa, reidrata sem o estado.
/// </summary>
public class RecuperacaoTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly Guid Sessao = Guid.Parse("01a18755-98a1-7472-96da-1dac72ff5d2a");

    private static async Task<AmbienteSync> AtivadoAsync()
    {
        var amb = await AmbienteSync.CriarAsync();
        Assert.True((await amb.AtivarAsync()).Ativado);
        return amb;
    }

    /// <summary>Um evento que a "nuvem" recebeu, com o envelope completo e o payload da fixture (hash pelo JCS).</summary>
    private static Guid NaNuvem(AmbienteSync amb, long sequencia, string tipo, string agregadoTipo, Guid agregadoId, JsonObject payload, string status = "aplicado")
    {
        var id = Guid.CreateVersion7();
        var jcs = Jcs.Serializar(payload);
        amb.Api.EventosRecebidos[id] = new JsonObject
        {
            ["evento_id"] = id.ToString("D"),
            ["sequencia"] = sequencia,
            ["tipo"] = tipo,
            ["versao_schema"] = 1,
            ["agregado_tipo"] = agregadoTipo,
            ["agregado_id"] = agregadoId.ToString("D"),
            ["dependencias"] = new JsonArray(),
            ["ocorrido_em"] = "2026-10-29T15:00:00.000Z",
            ["relogio_confiavel"] = false,
            ["usuario_id"] = "01a18754-76cb-7b74-b2e7-06298fadc1a6",
            ["contexto"] = new JsonObject
            {
                ["loja_id"] = ApiFalsa.LojaId.ToString("D"),
                ["caixa_id"] = ApiFalsa.CaixaId.ToString("D"),
                ["numero_caixa"] = 2,
                ["sessao_caixa_id"] = Sessao.ToString("D"),
            },
            ["payload"] = payload,
            ["payload_sha256"] = Jcs.Sha256Hex(jcs),
        };
        amb.Api.StatusRecebido[id] = status;
        return id;
    }

    private static JsonObject Payload(string fixture) => JsonNode.Parse(Fixtures.Sync(fixture))!.AsObject();

    /// <summary>Abertura, venda finalizada, sangria com erro na nuvem e a lacuna declarada na 4.</summary>
    private static (Guid Abertura, Guid Venda, Guid Sangria, Guid VendaId) NuvemComCaixaEVenda(AmbienteSync amb)
    {
        var venda = Payload("venda.finalizada.payload.json");
        var vendaId = Guid.Parse(venda["vendas"]!["id"]!.GetValue<string>());
        var sangria = Payload("caixa.sangria.payload.json");
        var ab = NaNuvem(amb, 1, "caixa.aberto", "sessao_caixa", Sessao, Payload("caixa.aberto.payload.json"));
        var v = NaNuvem(amb, 2, "venda.finalizada", "venda", vendaId, venda);
        var s = NaNuvem(amb, 3, "caixa.sangria", "movimento_caixa", Guid.Parse(sangria["movimentos_caixa"]!["id"]!.GetValue<string>()), sangria, "erro");
        amb.Api.DeclararPlaceholders(4, 4);
        return (ab, v, s, vendaId);
    }

    private static async Task<List<EventoSaida>> EventosAsync(AmbienteSync amb)
    {
        await using var db = amb.Fabrica.CreateDbContext();
        return await db.EventosSaida.AsNoTracking().OrderBy(e => e.SequenciaTerminal).ToListAsync(Ct);
    }

    private static long Sequencia(AmbienteSync amb, string chave) =>
        (long)amb.Escalar($"select ultimo_valor from sequencias_locais where chave = '{chave}'")!;

    private static ReidratacaoLocal Reidratacao(AmbienteSync amb) =>
        new(amb.ClienteComRelogio, amb.Fabrica, amb.Relogio, NullLogger<ReidratacaoLocal>.Instance);

    [Fact]
    public async Task Regressao_reidrata_vendas_e_caixa_salta_a_numeracao_e_libera_sem_duplicar()
    {
        using var amb = await AtivadoAsync();
        var (ab, v, s, vendaId) = NuvemComCaixaEVenda(amb);
        using var ciclo = amb.CriarCiclo();

        var h = await ciclo.HandshakeAsync(Ct);
        Assert.True(h.Desfecho == DesfechoHandshake.Liberado, string.Join("\n", amb.Log.Linhas.Where(l => l.StartsWith("Error", StringComparison.Ordinal))));
        Assert.Equal(EstadoTerminalSync.Ativo, ciclo.Situacao.Terminal);
        Assert.Equal([0L], amb.Api.ConsultasRecuperar);

        // Os eventos com o mesmo id e a mesma sequência, na situação da nuvem; o placeholder só ocupa a 4.
        var eventos = await EventosAsync(amb);
        Assert.Equal(
            [(ab, 1L, StatusEventoSaida.Confirmado), (v, 2L, StatusEventoSaida.Confirmado), (s, 3L, StatusEventoSaida.Rejeitado)],
            eventos.Select(e => (e.Id, e.SequenciaTerminal, e.Status)));
        Assert.Equal(2_002L, eventos[1].VersaoNuvem);
        Assert.StartsWith("PAYLOAD_INVALIDO: ", eventos[2].UltimoErro, StringComparison.Ordinal);
        Assert.Equal(amb.Api.EventosRecebidos[v]["payload_sha256"]!.GetValue<string>(), eventos[1].PayloadSha256);
        Assert.Equal(eventos[1].PayloadSha256, Jcs.Sha256Hex(eventos[1].Payload));
        Assert.Equal(4L, Sequencia(amb, SequenciaLocal.Evento));

        // Os fatos recriados: a sessão aberta, a abertura e a sangria (o caixa fez, mesmo com erro na nuvem) e a venda inteira.
        Assert.Equal("aberta", amb.Escalar($"select status from sessoes_caixa where id = '{Sessao:D}'"));
        Assert.Equal(2L, amb.Escalar($"select count(*) from movimentos_caixa where sessao_caixa_id = '{Sessao:D}'"));
        Assert.Equal(("finalizada", 123L, 0L), (
            (string)amb.Escalar($"select status from vendas where id = '{vendaId:D}'")!,
            (long)amb.Escalar($"select numero from vendas where id = '{vendaId:D}'")!,
            (long)amb.Escalar($"select relogio_confiavel from vendas where id = '{vendaId:D}'")!));
        var payload = Payload("venda.finalizada.payload.json");
        Assert.Equal((long)payload["itens_venda"]!.AsArray().Count, amb.Escalar($"select count(*) from itens_venda where venda_id = '{vendaId:D}'"));
        Assert.Equal((long)payload["pagamentos_venda"]!.AsArray().Count, amb.Escalar($"select count(*) from pagamentos_venda where venda_id = '{vendaId:D}'"));
        Assert.Equal((long)payload["liberacoes"]!.AsArray().Count, amb.Escalar($"select count(*) from liberacoes_venda where venda_id = '{vendaId:D}'"));

        // Regressão = salto obrigatório (22.1): venda e vale +1000 sobre o maior entre o local e a nuvem.
        Assert.Equal(1126L + SaltoNumeracao.Margem, Sequencia(amb, SequenciaLocal.Venda));
        Assert.Equal(1008L + SaltoNumeracao.Margem, Sequencia(amb, SequenciaLocal.Vale));
        Assert.Equal(1L, amb.Escalar("select count(*) from log_local where mensagem like 'Recuperação 22.1 (regressao)%'"));

        // Idempotente: o handshake seguinte não reidrata nem salta de novo; a reidratação repetida não grava nada.
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Single(amb.Api.ConsultasRecuperar);
        var de_novo = await Reidratacao(amb).ExecutarAsync(0, Ct);
        Assert.Equal((4, 0, 3, 0, 4L), (de_novo.Recebidos, de_novo.Recriados, de_novo.JaExistiam, de_novo.Renumerados, de_novo.UltimaSequencia));
        Assert.Equal(3, (await EventosAsync(amb)).Count);
        Assert.Equal(1L, amb.Escalar("select count(*) from vendas"));
        Assert.Equal(1126L + SaltoNumeracao.Margem, Sequencia(amb, SequenciaLocal.Venda));
    }

    [Fact]
    public async Task Paginas_de_50_e_a_interrompida_repete_sem_duplicar()
    {
        using var amb = await AtivadoAsync();
        for (var i = 1; i <= 120; i++)
        {
            var aud = new JsonObject { ["registros"] = new JsonArray(), ["logins"] = new JsonArray() };
            NaNuvem(amb, i, "auditoria.registros", "auditoria", Guid.CreateVersion7(), aud);
        }

        // A terceira página cai: as duas primeiras ficam gravadas (uma transação por página) e as vendas seguem bloqueadas.
        var paginas = 0;
        amb.Api.AoRecuperar = _ => ++paginas == 3 ? ApiFalsa.Erro(HttpStatusCode.ServiceUnavailable, "MANUTENCAO", "Em manutenção.") : null;
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Regressao, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(EstadoTerminalSync.Regressao, ciclo.Situacao.Terminal);
        Assert.Equal([0L, 50L], amb.Api.ConsultasRecuperar);
        Assert.Equal(100, (await EventosAsync(amb)).Count);
        Assert.Equal(1126L, Sequencia(amb, SequenciaLocal.Venda));

        // A sequência local já subiu até a última da nuvem no passo 1 (o caixa grava acima dela); a pendência guarda a
        // regressão e o ponto de partida.
        Assert.Equal(120L, Sequencia(amb, SequenciaLocal.Evento));
        Assert.Equal((0L, true), await PendenteAsync(amb) is { } p ? (p.Desde, p.Regressao) : default);

        amb.Api.AoRecuperar = null;
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        // Recomeça do mesmo ponto e pula o que já gravou.
        Assert.Equal([0L, 50L, 0L, 50L, 100L], amb.Api.ConsultasRecuperar);
        Assert.Equal(120, (await EventosAsync(amb)).Count);
        Assert.Equal(120L, Sequencia(amb, SequenciaLocal.Evento));
        Assert.All(await EventosAsync(amb), e => Assert.Equal(StatusEventoSaida.Confirmado, e.Status));
        Assert.Null(await PendenteAsync(amb));
    }

    [Fact]
    public async Task Reidratacao_interrompida_para_o_push_e_o_evento_novo_so_sobe_depois_dos_deslocados()
    {
        using var amb = await AtivadoAsync();
        // Restaurado sem regressão (nuvem em 0, caixa em 2 do modo restaurado); o recuperar cai depois do passo 1.
        await amb.Terminal.GravarConfiguracaoAsync(ChavesConfiguracaoTerminal.RestauracaoPendente,
            new RestauracaoPendente(amb.Relogio.Agora, "pdv-20261104-100000-000-periodico.db.gz", false, 0, amb.Relogio.Agora.AddHours(-2)), ct: Ct);
        var local1 = await InserirAsync(amb, 1);
        var local2 = await InserirAsync(amb, 2);
        amb.Api.AoRecuperar = _ => ApiFalsa.Erro(HttpStatusCode.ServiceUnavailable, "MANUTENCAO", "Em manutenção.");
        using (var ciclo = amb.CriarCiclo())
        {
            Assert.Equal(DesfechoHandshake.SemConexao, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        }

        Assert.Equal([-2L, -1L], (await EventosAsync(amb)).Select(e => e.SequenciaTerminal));
        Assert.Equal((0L, false), await PendenteAsync(amb) is { } p ? (p.Desde, p.Regressao) : default);

        // O caixa segue (modo restaurado): a abertura grava acima dos deslocados, e nada sobe — nem com o app reaberto.
        var sessao = CaixaDaFixture.SessaoAberta();
        var abertura = CaixaDaFixture.Abertura();
        await new Data.Repositorios.RepositorioCaixa(amb.Fabrica, amb.Relogio)
            .AbrirAsync(sessao, abertura, Eventos.FabricaEventosCaixa.CaixaAberto(sessao, abertura, null, Guid.CreateVersion7()), Ct);
        Assert.Equal([-2L, -1L, 3L], (await EventosAsync(amb)).Select(e => e.SequenciaTerminal));
        Assert.Equal(DesfechoPush.ReidratacaoPendente, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        using (var reaberto = amb.CriarCiclo(new OpcoesSincronizacao { Debounce = TimeSpan.Zero }))
        {
            reaberto.Iniciar();
            await AmbienteSync.EsperarAsync(() => Task.FromResult(amb.Api.Contar("/sync/heartbeat") > 0), "heartbeat");
            await reaberto.DisposeAsync();
        }

        Assert.Equal(0, amb.Api.Contar("/sync/push"));

        // A nuvem volta: o handshake retoma a reidratação, os do caixa ficam em ordem (1, 2 e a abertura em 3) e sobem.
        amb.Api.AoRecuperar = null;
        using (var ciclo = amb.CriarCiclo())
        {
            Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        }

        var eventos = await EventosAsync(amb);
        Assert.Equal([(local1, 1L), (local2, 2L)], eventos.Take(2).Select(e => (e.Id, e.SequenciaTerminal)));
        Assert.Equal(("caixa.aberto", 3L), (eventos[2].Tipo, eventos[2].SequenciaTerminal));
        Assert.Null(await PendenteAsync(amb));
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        Assert.Equal(3L, amb.Api.UltimaSequenciaRecebida);
        Assert.All(await EventosAsync(amb), e => Assert.Equal(StatusEventoSaida.Confirmado, e.Status));
    }

    [Fact]
    public async Task Evento_do_caixa_durante_a_regressao_interrompida_grava_acima_da_nuvem_e_sobe_depois()
    {
        using var amb = await AtivadoAsync();
        for (var i = 1; i <= 120; i++)
        {
            NaNuvem(amb, i, "auditoria.registros", "auditoria", Guid.CreateVersion7(), new JsonObject { ["registros"] = new JsonArray(), ["logins"] = new JsonArray() });
        }

        // A segunda página cai (503): a primeira (1..50) fica gravada e a regressão continua.
        var paginas = 0;
        amb.Api.AoRecuperar = _ => ++paginas == 2 ? ApiFalsa.Erro(HttpStatusCode.ServiceUnavailable, "MANUTENCAO", "Em manutenção.") : null;
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Regressao, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(50, (await EventosAsync(amb)).Count);

        // A sangria, o fechamento, a auditoria: o evento do caixa no meio não bate no índice único da sequência.
        var sessao = CaixaDaFixture.SessaoAberta();
        var abertura = CaixaDaFixture.Abertura();
        await new Data.Repositorios.RepositorioCaixa(amb.Fabrica, amb.Relogio)
            .AbrirAsync(sessao, abertura, Eventos.FabricaEventosCaixa.CaixaAberto(sessao, abertura, null, Guid.CreateVersion7()), Ct);
        var doCaixa = (await EventosAsync(amb)).Single(e => e.Tipo == "caixa.aberto");
        Assert.Equal(121L, doCaixa.SequenciaTerminal);
        Assert.Equal(DesfechoPush.ReidratacaoPendente, (await amb.Envio.EnviarAsync(Ct)).Desfecho);

        amb.Api.AoRecuperar = null;
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(121, (await EventosAsync(amb)).Count);
        Assert.Equal(121L, (await EventosAsync(amb)).Single(e => e.Id == doCaixa.Id).SequenciaTerminal);
        Assert.Equal(121L, Sequencia(amb, SequenciaLocal.Evento));
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        Assert.Equal(121L, amb.Api.UltimaSequenciaRecebida);
    }

    [Fact]
    public async Task Empresa_suspensa_reidrata_depois_da_regressao_do_push_e_o_push_volta()
    {
        using var amb = await AtivadoAsync();
        // A nuvem tem 1 e 2 (o banco perdeu); o caixa gravou a 1 de novo com outro evento. Empresa suspensa: o estado dá 403.
        var perdido1 = NaNuvem(amb, 1, "caixa.aberto", "sessao_caixa", Sessao, Payload("caixa.aberto.payload.json"));
        var perdido2 = NaNuvem(amb, 2, "auditoria.registros", "auditoria", Guid.CreateVersion7(), new JsonObject { ["registros"] = new JsonArray(), ["logins"] = new JsonArray() });
        var local = await InserirAsync(amb, 1);
        amb.Api.EmpresaBloqueada = "EMPRESA_SUSPENSA";
        using var ciclo = amb.CriarCiclo(new OpcoesSincronizacao { Debounce = TimeSpan.Zero });
        ciclo.Iniciar();

        // O push leva 409 REGRESSAO_DETECTADA; o handshake recusado com 403 reidrata pelo recuperar (aceito na suspensão) e
        // o evento do caixa sobe em 3.
        await AmbienteSync.EsperarAsync(() => Task.FromResult(amb.Api.EventosRecebidos.TryGetValue(local, out var e) && e["sequencia"]!.GetValue<long>() == 3),
            "evento do caixa aceito depois dos da nuvem");
        Assert.Equal([0L], amb.Api.ConsultasRecuperar);
        Assert.Equal(EstadoTerminalSync.Regressao, ciclo.Situacao.Terminal);
        var eventos = await EventosAsync(amb);
        Assert.Equal([perdido1, perdido2, local], eventos.Select(e => e.Id));
        Assert.Null(await PendenteAsync(amb));

        // Reativada: o handshake aplica a regra 22.1 (regressão, salto) e libera as vendas.
        amb.Api.EmpresaBloqueada = null;
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(EstadoTerminalSync.Ativo, ciclo.Situacao.Terminal);
        Assert.Equal(1L, amb.Escalar("select count(*) from log_local where mensagem like 'Recuperação 22.1 (regressao)%'"));
    }

    private static async Task<ReidratacaoPendente?> PendenteAsync(AmbienteSync amb)
    {
        await using var db = amb.Fabrica.CreateDbContext();
        return await ReidratacaoLocal.PendenteAsync(db, Ct);
    }

    [Fact]
    public async Task Restaurado_com_eventos_offline_leva_os_do_caixa_para_depois_dos_da_nuvem()
    {
        using var amb = await AtivadoAsync();
        // O banco restaurado é de antes das sequências 1 e 2, que a nuvem recebeu (e o caixa perdeu); offline, o caixa
        // gravou a 1 e a 2 de novo com outros eventos (o modo restaurado não sabe o que a nuvem tem).
        var perdido1 = NaNuvem(amb, 1, "caixa.aberto", "sessao_caixa", Sessao, Payload("caixa.aberto.payload.json"));
        var perdido2 = NaNuvem(amb, 2, "auditoria.registros", "auditoria", Guid.CreateVersion7(), new JsonObject { ["registros"] = new JsonArray(), ["logins"] = new JsonArray() });
        await amb.Terminal.GravarConfiguracaoAsync(ChavesConfiguracaoTerminal.RestauracaoPendente,
            new RestauracaoPendente(amb.Relogio.Agora, "pdv-20261104-100000-000-periodico.db.gz", false, 0, amb.Relogio.Agora.AddHours(-2)), ct: Ct);
        var local1 = await InserirAsync(amb, 1);
        var local2 = await InserirAsync(amb, 2);

        // Sem regressão aparente (local 2 = nuvem 2): é a restauração pendente que manda reidratar desde a sequência do backup.
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal([0L], amb.Api.ConsultasRecuperar);
        var eventos = await EventosAsync(amb);
        Assert.Equal(
            [(perdido1, 1L, StatusEventoSaida.Confirmado), (perdido2, 2L, StatusEventoSaida.Confirmado),
                (local1, 3L, StatusEventoSaida.Pendente), (local2, 4L, StatusEventoSaida.Pendente)],
            eventos.Select(e => (e.Id, e.SequenciaTerminal, e.Status)));
        Assert.Equal(4L, Sequencia(amb, SequenciaLocal.Evento));
        Assert.Null(await amb.Terminal.ObterConfiguracaoAsync<RestauracaoPendente>(ChavesConfiguracaoTerminal.RestauracaoPendente, Ct));

        // O push manda os do caixa em 3 e 4: aplicados, nada duplicado.
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        Assert.Equal(3L, amb.Api.EventosRecebidos[local1]["sequencia"]!.GetValue<long>());
        Assert.Equal(4L, amb.Api.EventosRecebidos[local2]["sequencia"]!.GetValue<long>());
        Assert.Equal(4, amb.Api.EventosRecebidos.Count);
    }

    [Fact]
    public async Task Prova_de_que_nada_se_perdeu_dispensa_o_salto_e_sem_ela_a_restauracao_salta()
    {
        using var amb = await AtivadoAsync();
        // O backup de saída conferido, sem heartbeat depois dele e com os números locais à frente da nuvem: sem salto.
        var heartbeat = DateTimeOffset.Parse("2026-10-29T17:45:00.402Z", System.Globalization.CultureInfo.InvariantCulture);
        await amb.Terminal.GravarConfiguracaoAsync(ChavesConfiguracaoTerminal.RestauracaoPendente,
            new RestauracaoPendente(amb.Relogio.Agora, "pdv-saida.db.gz", true, 0, heartbeat.AddMinutes(1)), ct: Ct);
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(1126L, Sequencia(amb, SequenciaLocal.Venda));
        Assert.Equal(1L, amb.Escalar($"select count(*) from log_local where mensagem like 'Recuperação 22.1 ({RegraRestauracao.MotivoProva})%'"));
        Assert.Null(await amb.Terminal.ObterConfiguracaoAsync<RestauracaoPendente>(ChavesConfiguracaoTerminal.RestauracaoPendente, Ct));

        // Heartbeat depois do backup (o app rodou depois dele): a mesma restauração salta.
        await amb.Terminal.GravarConfiguracaoAsync(ChavesConfiguracaoTerminal.RestauracaoPendente,
            new RestauracaoPendente(amb.Relogio.Agora, "pdv-saida.db.gz", true, 0, heartbeat.AddMinutes(-1)), ct: Ct);
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(1126L + SaltoNumeracao.Margem, Sequencia(amb, SequenciaLocal.Venda));

        // O modo restaurado já saltou offline e a nuvem não conhece número acima do local: não salta de novo.
        await amb.Terminal.GravarConfiguracaoAsync(ChavesConfiguracaoTerminal.RestauracaoPendente,
            new RestauracaoPendente(amb.Relogio.Agora, "pdv.db.gz", false, 0, null, amb.Relogio.Agora), ct: Ct);
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(1126L + SaltoNumeracao.Margem, Sequencia(amb, SequenciaLocal.Venda));
        Assert.Equal(1L, amb.Escalar($"select count(*) from log_local where mensagem like 'Recuperação 22.1 ({RegraRestauracao.MotivoSaltoOffline})%'"));
    }

    [Fact]
    public async Task Perda_provavel_salta_e_leva_a_sequencia_ate_a_informada()
    {
        using var amb = await AtivadoAsync();
        // O terminal informou a venda 1500 e a sequência 9 por heartbeat; o banco local ficou na 1126 e na 0.
        amb.Api.AoEstado = _ =>
        {
            var estado = JsonNode.Parse(ApiFalsa.Fixture("estado.resposta.json"))!.AsObject();
            estado["terminal"]!["id"] = amb.Api.TerminalId.ToString("D");
            estado["sequencia_terminal"]!["ultima_recebida"] = 0;
            estado["informado_pelo_terminal"]!["ultima_sequencia_gerada"] = 9;
            estado["numeracoes"]!["venda"]!["ultimo_numero"] = 1500;
            estado["versoes_schema"] = JsonSerializer.SerializeToNode(amb.Api.VersoesSchema);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(estado.ToJsonString(), System.Text.Encoding.UTF8, "application/json") };
        };
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Empty(amb.Api.ConsultasRecuperar);
        Assert.Equal(1500L + SaltoNumeracao.Margem, Sequencia(amb, SequenciaLocal.Venda));
        // Os eventos 1..9 nunca chegaram: a próxima sequência é a 10, e a 1..9 vira a lacuna que o supervisor declara (8.6).
        Assert.Equal(9L, Sequencia(amb, SequenciaLocal.Evento));
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(1500L + SaltoNumeracao.Margem, Sequencia(amb, SequenciaLocal.Venda));
    }

    private static async Task<Guid> InserirAsync(AmbienteSync amb, long sequencia)
    {
        var id = IdGerador.Novo();
        await using var db = amb.Fabrica.CreateDbContext();
        var seq = await db.SequenciasLocais.SingleAsync(s => s.Chave == SequenciaLocal.Evento, Ct);
        seq.UltimoValor = Math.Max(seq.UltimoValor, sequencia);
        var payload = Jcs.Serializar(new JsonObject { ["registros"] = new JsonArray(), ["logins"] = new JsonArray() });
        db.EventosSaida.Add(new EventoSaida
        {
            Id = id,
            SequenciaTerminal = sequencia,
            Tipo = "auditoria.registros",
            AgregadoTipo = "auditoria",
            AgregadoId = Guid.CreateVersion7(),
            OcorridoEm = amb.Relogio.Agora,
            CriadoEm = amb.Relogio.Agora,
            Payload = payload,
            PayloadSha256 = Jcs.Sha256Hex(payload),
            Status = StatusEventoSaida.Pendente,
        });
        await db.SaveChangesAsync(Ct);
        return id;
    }
}
