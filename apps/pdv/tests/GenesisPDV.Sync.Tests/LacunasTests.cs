using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;
using GenesisPDV.Sync.Push;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Lacunas de sequência no PDV (SYNC 8.6; Fase 1C, bloco C15) contra a <see cref="ApiFalsa"/>: no <c>fora_de_ordem</c>, o
/// que o caixa ainda tem (inclusive confirmado, a nuvem restaurada de backup) volta a <c>pendente</c> e sai de novo em
/// ordem; o que não existe mais é a lacuna, que bloqueia vendas até o supervisor declarar (<c>declarar_lacuna</c>); o
/// evento de uma lacuna já declarada espera a liberação do reenvio (<c>recuperar_lacuna</c>).
/// </summary>
public sealed class LacunasTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly Guid Supervisor = Guid.Parse("01a18755-09d1-76b6-8b81-48f6b38a088c");

    private static async Task<AmbienteSync> AtivadoAsync()
    {
        var amb = await AmbienteSync.CriarAsync();
        amb.Api.IntervaloS = 1;
        Assert.True((await amb.AtivarAsync()).Ativado);
        return amb;
    }

    /// <summary>Eventos no outbox com as sequências e os status dados (as que faltam simulam linhas perdidas).</summary>
    private static async Task GravarAsync(AmbienteSync amb, params (long Sequencia, string Status)[] eventos)
    {
        await using var db = amb.Fabrica.CreateDbContext();
        var seq = await db.SequenciasLocais.SingleAsync(s => s.Chave == SequenciaLocal.Evento, Ct);
        seq.UltimoValor = eventos.Max(e => e.Sequencia);
        foreach (var (sequencia, status) in eventos)
        {
            db.EventosSaida.Add(new EventoSaida
            {
                Id = IdGerador.Novo(),
                SequenciaTerminal = sequencia,
                Tipo = "auditoria.registros",
                AgregadoTipo = "auditoria",
                AgregadoId = Guid.CreateVersion7(),
                OcorridoEm = amb.Relogio.Agora,
                CriadoEm = amb.Relogio.Agora,
                Payload = "{}",
                PayloadSha256 = Jcs.Sha256Hex("{}"),
                Status = status,
                ConfirmadoEm = status == StatusEventoSaida.Confirmado ? amb.Relogio.Agora : null,
            });
        }

        await db.SaveChangesAsync(Ct);
    }

    private static async Task<List<EventoSaida>> EventosAsync(AmbienteSync amb)
    {
        await using var db = amb.Fabrica.CreateDbContext();
        return await db.EventosSaida.AsNoTracking().OrderBy(e => e.SequenciaTerminal).ToListAsync(Ct);
    }

    /// <summary>Push até o outbox esvaziar (o reenvio repete o lote da frente; os seguintes saem no lote seguinte).</summary>
    private static async Task EsvaziarAsync(AmbienteSync amb)
    {
        for (var i = 0; i < 10 && (await amb.Envio.EnviarAsync(Ct)).Desfecho == DesfechoPush.Enviado; i++)
        {
        }
    }

    private static JsonObject UltimoPush(AmbienteSync amb) => JsonNode.Parse(amb.Api.UltimoEnvio("/sync/push")!.Corpo!)!.AsObject();

    [Fact]
    public async Task Nuvem_restaurada_reenvia_os_confirmados_que_ela_esqueceu_sem_lacuna()
    {
        using var amb = await AtivadoAsync();
        // A nuvem recebeu 1 e 2 (o caixa os tem confirmados) e depois voltou de um backup sem eles (22.5).
        await GravarAsync(amb, (1, StatusEventoSaida.Pendente), (2, StatusEventoSaida.Pendente));
        await EsvaziarAsync(amb);
        Assert.All(await EventosAsync(amb), e => Assert.Equal(StatusEventoSaida.Confirmado, e.Status));
        amb.Api.EsquecerDesde(1);
        Assert.Equal(0, amb.Api.UltimaSequenciaRecebida);
        await GravarAsync(amb, (3, StatusEventoSaida.Pendente));

        var r = await amb.Envio.EnviarAsync(Ct);
        Assert.Equal(DesfechoPush.Enviado, r.Desfecho);
        Assert.Null(r.Lacuna);
        // Os dois voltaram à fila, e o do fora_de_ordem também, sem espera: o laço repete na hora.
        Assert.Equal(2, r.Enviados);
        Assert.All(await EventosAsync(amb), e => Assert.Equal((StatusEventoSaida.Pendente, (DateTimeOffset?)null), (e.Status, e.ProximaTentativaEm)));

        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        Assert.Equal([1L, 2L, 3L], UltimoPush(amb)["eventos"]!.AsArray().Select(e => e!["sequencia"]!.GetValue<long>()));
        Assert.All(await EventosAsync(amb), e => Assert.Equal(StatusEventoSaida.Confirmado, e.Status));
        Assert.Empty(amb.Api.Declaracoes);
    }

    [Fact]
    public async Task Sequencias_perdidas_viram_lacuna_e_a_declaracao_libera_a_fila()
    {
        using var amb = await AtivadoAsync();
        // As linhas 1 e 2 se perderam no banco local; 3 e 4 esperam o envio.
        await GravarAsync(amb, (3, StatusEventoSaida.Pendente), (4, StatusEventoSaida.Pendente));

        var r = await amb.Envio.EnviarAsync(Ct);
        Assert.Equal(new LacunaEventos(1, 2, false), r.Lacuna);
        Assert.Equal("1–2", r.Lacuna!.Faixa);
        Assert.Equal(0, r.Enviados);
        var eventos = await EventosAsync(amb);
        Assert.Equal(StatusEventoSaida.ErroTemporario, eventos[0].Status);
        Assert.NotNull(eventos[0].ProximaTentativaEm);

        var resposta = await amb.Envio.DeclararLacunaAsync(
            new DeclaracaoLacuna(1, 2, MotivosLacuna.BancoLocalPerdido, "Banco trocado", Supervisor), Ct);
        Assert.Equal(3, resposta.ProximaSequenciaEsperada);
        var lote = UltimoPush(amb);
        Assert.Empty(lote["eventos"]!.AsArray());
        Assert.Equal(
            """{"de":1,"ate":2,"motivo":"banco_local_perdido","observacao":"Banco trocado","autorizado_por_id":"01a18755-09d1-76b6-8b81-48f6b38a088c"}""",
            lote["declarar_lacuna"]!.ToJsonString());
        // A espera do fora_de_ordem caiu: o próximo push manda 3 e 4 na hora.
        Assert.All(await EventosAsync(amb), e => Assert.Null(e.ProximaTentativaEm));
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        await EsvaziarAsync(amb);
        Assert.All(await EventosAsync(amb), e => Assert.Equal(StatusEventoSaida.Confirmado, e.Status));

        // Reenvio da mesma declaração (resposta perdida): a nuvem aceita sem gravar de novo.
        await amb.Envio.DeclararLacunaAsync(new DeclaracaoLacuna(1, 2, MotivosLacuna.BancoLocalPerdido, null, Supervisor), Ct);
        Assert.Single(amb.Api.Declaracoes);
    }

    [Fact]
    public async Task Lacuna_comeca_na_esperada_e_vai_ate_a_primeira_sequencia_que_o_caixa_tem()
    {
        using var amb = await AtivadoAsync();
        // A 1 se perdeu; a 2 está confirmada (a nuvem a esqueceu); a 3 espera.
        await GravarAsync(amb, (2, StatusEventoSaida.Confirmado), (3, StatusEventoSaida.Pendente));

        var r = await amb.Envio.EnviarAsync(Ct);
        Assert.Equal(new LacunaEventos(1, 1, false), r.Lacuna);
        var eventos = await EventosAsync(amb);
        Assert.Equal((StatusEventoSaida.Pendente, EnvioPush.ReenvioLacuna), (eventos[0].Status, eventos[0].UltimoErro));
    }

    [Fact]
    public async Task Evento_de_lacuna_declarada_espera_a_liberacao_e_reenvia_com_recuperar_lacuna()
    {
        using var amb = await AtivadoAsync();
        amb.Api.DeclararPlaceholders(1, 2);
        await GravarAsync(amb, (1, StatusEventoSaida.Pendente), (2, StatusEventoSaida.Pendente), (3, StatusEventoSaida.Pendente));

        var r = await amb.Envio.EnviarAsync(Ct);
        Assert.Equal(new LacunaEventos(1, 2, true), r.Lacuna);
        var eventos = await EventosAsync(amb);
        Assert.Equal(StatusEventoSaida.ErroTemporario, eventos[0].Status);
        Assert.StartsWith(EnvioPush.PrefixoLacunaRecuperavel + "LACUNA_RECUPERAVEL", eventos[0].UltimoErro, StringComparison.Ordinal);
        Assert.Equal(DesfechoPush.Aguardando, (await amb.Envio.EnviarAsync(Ct)).Desfecho);

        amb.Envio.RecuperacaoAutorizada = new RecuperacaoLacuna(1, 2, Supervisor);
        await amb.Envio.LiberarEsperaAsync(Ct);
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        Assert.Equal("""{"de":1,"ate":2,"autorizado_por_id":"01a18755-09d1-76b6-8b81-48f6b38a088c"}""",
            UltimoPush(amb)["recuperar_lacuna"]!.ToJsonString());
        await EsvaziarAsync(amb);
        Assert.All(await EventosAsync(amb), e => Assert.Equal(StatusEventoSaida.Confirmado, e.Status));
        Assert.Empty(amb.Api.Placeholders);
    }

    [Fact]
    public async Task Ciclo_bloqueia_vendas_na_lacuna_e_a_declaracao_do_supervisor_libera()
    {
        using var amb = await AtivadoAsync();
        await GravarAsync(amb, (2, StatusEventoSaida.Pendente));
        using var ciclo = amb.CriarCiclo();
        // Sem lacuna conhecida, nada a declarar.
        await Assert.ThrowsAsync<RegraNegocioException>(() => ciclo.DeclararLacunaAsync(Supervisor, null, Ct));

        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Terminal == EstadoTerminalSync.Lacuna, "lacuna publicada");
        Assert.Equal(new LacunaEventos(1, 1, false), ciclo.Situacao.Lacuna);
        Assert.Equal(("■ Lacuna de eventos 1 — chame o supervisor (F11 › S)", NivelIndicador.Erro),
            IndicadorSync.Calcular(ciclo.Situacao, amb.Relogio.Agora));
        await Assert.ThrowsAsync<RegraNegocioException>(() => ciclo.AutorizarRecuperacaoLacunaAsync(Supervisor, Ct));

        await ciclo.DeclararLacunaAsync(Supervisor, "  Banco do caixa trocado  ", Ct);
        Assert.Equal(EstadoTerminalSync.Ativo, ciclo.Situacao.Terminal);
        Assert.Null(ciclo.Situacao.Lacuna);
        Assert.Equal("Banco do caixa trocado", amb.Api.Declaracoes.Single()["observacao"]!.GetValue<string>());
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).All(e => e.Status == StatusEventoSaida.Confirmado), "fila andou");
        // A liberação fica na auditoria local (sobe no auditoria.registros, com o supervisor).
        await using var db = amb.Fabrica.CreateDbContext();
        var liberacao = await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(l => l.Acao == "liberacao", Ct);
        Assert.Equal((Supervisor, "Banco do caixa trocado"), (liberacao.AutorizadoPorId, liberacao.Motivo));
        Assert.Equal(OrigemLiberacaoLacuna.LocalizacaoStatusSync, liberacao.Localizacao);
    }

    [Fact]
    public async Task Ciclo_avisa_a_lacuna_recuperavel_sem_bloquear_e_a_liberacao_reenvia()
    {
        using var amb = await AtivadoAsync();
        amb.Api.DeclararPlaceholders(1, 1);
        await GravarAsync(amb, (1, StatusEventoSaida.Pendente));
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Lacuna is { Recuperavel: true }, "lacuna recuperável");
        Assert.Equal(EstadoTerminalSync.Ativo, ciclo.Situacao.Terminal);
        Assert.Equal(NivelIndicador.Aviso, IndicadorSync.Calcular(ciclo.Situacao, amb.Relogio.Agora).Nivel);

        // Pedida na Central do PDV (aberta pelo login: sem operador na sessão), a auditoria leva quem pediu e a tela.
        var solicitante = Guid.CreateVersion7();
        await ciclo.AutorizarRecuperacaoLacunaAsync(Supervisor, Ct, new OrigemLiberacaoLacuna(solicitante, "PDV › Central do PDV › Sincronização"));
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).All(e => e.Status == StatusEventoSaida.Confirmado), "reenviado");
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Lacuna is null, "aviso limpo");
        Assert.Single(amb.Api.Recuperacoes);
        await using var db = amb.Fabrica.CreateDbContext();
        var liberacao = await db.LogAuditoriaLocal.AsNoTracking().SingleAsync(l => l.Acao == "liberacao", Ct);
        Assert.Equal((solicitante, Supervisor, "PDV › Central do PDV › Sincronização"), (liberacao.UsuarioId, liberacao.AutorizadoPorId, liberacao.Localizacao));
    }

    [Fact]
    public async Task Liberacao_vale_para_todos_os_lotes_da_faixa_maior_que_um_lote()
    {
        using var amb = await AtivadoAsync();
        // 120 eventos de uma lacuna já declarada: o reenvio sai em vários lotes de 50.
        const long Ultima = 120;
        amb.Api.DeclararPlaceholders(1, Ultima);
        await GravarAsync(amb, [.. Enumerable.Range(1, (int)Ultima).Select(s => ((long)s, StatusEventoSaida.Pendente))]);
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Lacuna is { Recuperavel: true }, "lacuna recuperável");
        Assert.Equal(new LacunaEventos(1, Ultima, true), ciclo.Situacao.Lacuna);
        var antes = amb.Api.Contar("/sync/push");

        await ciclo.AutorizarRecuperacaoLacunaAsync(Supervisor, Ct);
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).All(e => e.Status == StatusEventoSaida.Confirmado), "faixa reenviada");
        await AmbienteSync.EsperarAsync(() => amb.Envio.RecuperacaoAutorizada is null, "liberação encerrada");

        // Todo lote com eventos da faixa levou a liberação: nenhum voltou lacuna_recuperavel nem pediu o supervisor de novo.
        List<JsonObject> lotes;
        lock (amb.Api.Envios)
        {
            lotes = [.. amb.Api.Envios.Where(e => e.Rota.EndsWith("/sync/push", StringComparison.Ordinal)).Skip(antes)
                .Select(e => JsonNode.Parse(e.Corpo!)!.AsObject())
                .Where(l => l["eventos"]!.AsArray().Any(ev => ev!["sequencia"]!.GetValue<long>() <= Ultima))];
        }

        Assert.True(lotes.Count >= 3, $"{lotes.Count} lote(s)");
        Assert.All(lotes, l => Assert.Equal(
            """{"de":1,"ate":120,"autorizado_por_id":"01a18755-09d1-76b6-8b81-48f6b38a088c"}""", l["recuperar_lacuna"]?.ToJsonString()));
        Assert.Equal(lotes.Count, amb.Api.Recuperacoes.Count);
        Assert.Empty(amb.Api.Placeholders);
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Lacuna is null, "aviso limpo");
        await using var db = amb.Fabrica.CreateDbContext();
        Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "liberacao", Ct));
    }

    [Fact]
    public async Task Reabrir_o_app_revela_a_lacuna_na_hora_sem_esperar_o_backoff()
    {
        using var amb = await AtivadoAsync();
        await GravarAsync(amb, (2, StatusEventoSaida.Pendente));
        var primeiro = amb.CriarCiclo();
        primeiro.Iniciar();
        await AmbienteSync.EsperarAsync(() => primeiro.Situacao.Terminal == EstadoTerminalSync.Lacuna, "lacuna publicada");
        await primeiro.DisposeAsync();
        // O evento da frente ficou em backoff (o relógio dos testes não anda): sem a liberação da espera na abertura, o
        // push devolveria "aguardando" e as vendas ficariam liberadas até o backoff vencer.
        var frente = (await EventosAsync(amb)).Single();
        Assert.Equal(StatusEventoSaida.ErroTemporario, frente.Status);
        Assert.True(frente.ProximaTentativaEm > amb.Relogio.Agora);
        Assert.StartsWith(EnvioPush.PrefixoForaDeOrdem, frente.UltimoErro, StringComparison.Ordinal);

        using var reaberto = amb.CriarCiclo();
        reaberto.Iniciar();
        await AmbienteSync.EsperarAsync(() => reaberto.Situacao.Terminal == EstadoTerminalSync.Lacuna, "lacuna publicada de novo");
        Assert.Equal(new LacunaEventos(1, 1, false), reaberto.Situacao.Lacuna);
    }

    [Fact]
    public async Task Declaracao_recusada_com_lacuna_invalida_revela_a_faixa_certa_na_hora()
    {
        using var amb = await AtivadoAsync();
        await GravarAsync(amb, (3, StatusEventoSaida.Pendente));
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Lacuna == new LacunaEventos(1, 2, false), "lacuna 1–2");
        // Outro caminho declarou só a 1 na nuvem: a faixa 1–2 já não começa na esperada (2).
        amb.Api.DeclararPlaceholders(1, 1);

        var e = await Assert.ThrowsAsync<RegraNegocioException>(() => ciclo.DeclararLacunaAsync(Supervisor, null, Ct));
        Assert.StartsWith("A nuvem recusou a lacuna 1–2", e.Message, StringComparison.Ordinal);
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Lacuna == new LacunaEventos(2, 2, false), "lacuna 2 revelada");
        Assert.Equal(EstadoTerminalSync.Lacuna, ciclo.Situacao.Terminal);
    }
}
