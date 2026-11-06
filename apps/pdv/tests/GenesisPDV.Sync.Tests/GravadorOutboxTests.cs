using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Outbox;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Eventos;
using GenesisPDV.Sync.Push;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Fase 1C (bloco C9): o <see cref="GravadorOutbox"/> contra a <see cref="ApiFalsa"/>. O evento de caixa e o de venda
/// sobem com o envelope completo da SYNC 7.3 (payload igual à fixture, operador, sessão e estoque no contexto,
/// dependências da 8.5, hora corrigida e monotônica da 12.3), e o tipo que a nuvem não anunciou em <c>versoes_schema</c>
/// não é gravado (T13): a abertura do caixa é recusada, e nada fica no banco.
/// </summary>
public sealed class GravadorOutboxTests
{
    private static readonly Guid Estoque = Guid.Parse("01a18753-5750-717c-87a0-ca6e0822e8f3");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Terminal ativado, com o handshake feito (versões anunciadas gravadas) e o espelho da loja com o estoque.</summary>
    private static async Task<AmbienteSync> ProntoAsync(Action<ApiFalsa>? ajustar = null)
    {
        var amb = await AmbienteSync.CriarAsync();
        ajustar?.Invoke(amb.Api);
        Assert.True((await amb.AtivarAsync()).Ativado);
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            db.Lojas.Add(new LojaRegistro { Id = ApiFalsa.LojaId, Codigo = 1, Nome = "Loja 1 - Ice Beer Hermes", EstoqueId = Estoque, Versao = 1 });
            await db.SaveChangesAsync(Ct);
        }

        using var ciclo = amb.CriarCiclo();
        Assert.Equal(Cliente.DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        return amb;
    }

    private static RepositorioCaixa Caixa(AmbienteSync amb, IRelogioOutbox? relogio = null) =>
        new(amb.Fabrica, amb.Relogio, new GravadorOutbox(relogio ?? amb.RelogioSync, amb.Maquina.VersaoApp));

    private static async Task<EventoSaida> EventoAsync(AmbienteSync amb, Guid id)
    {
        await using var db = amb.Fabrica.CreateDbContext();
        return await db.EventosSaida.AsNoTracking().SingleAsync(e => e.Id == id, Ct);
    }

    [Fact]
    public async Task Caixa_aberto_e_sangria_sobem_com_o_envelope_da_fixture_e_a_dependencia_da_sessao()
    {
        using var amb = await ProntoAsync();
        var caixa = Caixa(amb);
        Assert.True(await caixa.TipoAceitoAsync("caixa.aberto", ct: Ct));
        var aberto = FabricaEventosCaixa.CaixaAberto(CaixaDaFixture.SessaoAberta(), CaixaDaFixture.Abertura(), CaixaDaFixture.CedulasAbertura, Guid.CreateVersion7());
        Assert.Equal(1, await caixa.AbrirAsync(CaixaDaFixture.SessaoAberta(), CaixaDaFixture.Abertura(), aberto, Ct));
        var sangria = FabricaEventosCaixa.CaixaSangria(CaixaDaFixture.SangriaDoDia(), 1284.50m, CaixaDaFixture.CedulasSangria, Guid.CreateVersion7());
        Assert.Equal(2, await caixa.RegistrarMovimentoAsync(CaixaDaFixture.SangriaDoDia(), sangria, Ct));

        var linha = await EventoAsync(amb, aberto.Id);
        var identidade = (await amb.Terminal.ObterIdentidadeAsync(Ct))!;
        var envelope = OutboxSync.Envelope(linha, identidade, amb.Maquina.VersaoApp);
        Assert.Equal(("caixa.aberto", "sessao_caixa", CaixaDaFixture.Sessao, 1L), (envelope.Tipo, envelope.AgregadoTipo, envelope.AgregadoId, envelope.Sequencia));
        Assert.Equal((Guid?)CaixaDaFixture.Maria, envelope.UsuarioId);
        Assert.Empty(envelope.Dependencias);
        // Contexto do momento do fato (7.3): a sessão aberta e o estoque vigente no espelho da loja.
        Assert.Equal((ApiFalsa.LojaId, ApiFalsa.CaixaId, 2, (Guid?)Estoque, (Guid?)CaixaDaFixture.Sessao, "1.4.2"), (
            envelope.Contexto.LojaId, envelope.Contexto.CaixaId, envelope.Contexto.NumeroCaixa!.Value, envelope.Contexto.EstoqueId,
            envelope.Contexto.SessaoCaixaId, envelope.Contexto.VersaoApp));
        // Hora do envelope = a do payload (aberta_em), sem evento anterior; o local é o do SO no momento da gravação.
        Assert.Equal("2026-10-29T11:01:15.000Z", envelope.OcorridoEm);
        Assert.Equal(Protocolo.FormatoProtocolo.DataHora(amb.Relogio.Agora), envelope.OcorridoEmLocal);
        Assert.Equal((amb.RelogioSync.Confiavel, (bool?)null), (envelope.RelogioConfiavel!.Value, envelope.RelogioRegrediu));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(Fixtures.Sync("caixa.aberto.payload.json")), JsonNode.Parse(envelope.Payload.GetRawText())));

        var envelopeSangria = OutboxSync.Envelope(await EventoAsync(amb, sangria.Id), identidade, amb.Maquina.VersaoApp);
        Assert.Equal(new[] { new Protocolo.DependenciaEvento("sessao_caixa", CaixaDaFixture.Sessao) }, envelopeSangria.Dependencias);

        // Pelo push: a "nuvem" recebe as dependências e o payload da fixture como estão.
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        var recebido = amb.Api.EventosRecebidos[sangria.Id];
        Assert.Equal("""[{"agregado_tipo":"sessao_caixa","agregado_id":"01a18755-98a1-7472-96da-1dac72ff5d2a"}]""", recebido["dependencias"]!.ToJsonString());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(Fixtures.Sync("caixa.sangria.payload.json")), recebido["payload"]));
        Assert.Equal(CaixaDaFixture.Sessao.ToString(), recebido["contexto"]!["sessao_caixa_id"]!.GetValue<string>());
    }

    [Fact]
    public async Task Api_sem_o_tipo_anunciado_bloqueia_a_abertura_sem_gravar_nada_e_a_auditoria_continua()
    {
        // A API da 1B (só os tipos dela no versoes_schema): o caixa.aberto voltaria SCHEMA_DESCONHECIDO e pararia o lote.
        using var amb = await ProntoAsync(api => api.VersoesSchema = new(StringComparer.Ordinal)
        {
            ["auditoria.registros"] = [1],
            ["terminal.configuracao_alterada"] = [1],
        });
        var caixa = Caixa(amb);
        Assert.False(await caixa.TipoAceitoAsync("caixa.aberto", ct: Ct));
        var evento = FabricaEventosCaixa.CaixaAberto(CaixaDaFixture.SessaoAberta(), CaixaDaFixture.Abertura(), null, Guid.CreateVersion7());

        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => caixa.AbrirAsync(CaixaDaFixture.SessaoAberta(), CaixaDaFixture.Abertura(), evento, Ct));

        Assert.Equal(GravadorOutbox.MensagemTipoNaoAnunciado("caixa.aberto", 1), recusa.Message);
        Assert.Equal((0L, 0L, 0L), (amb.Contar("sessoes_caixa"), amb.Contar("movimentos_caixa"), amb.Contar("eventos_saida")));
        Assert.Equal(0L, (long)amb.Escalar("select ultimo_valor from sequencias_locais where chave = 'evento'")!);
        // O lote de auditoria é da 1B e não depende do anúncio.
        await amb.Terminal.RegistrarAuditoriaAsync("login", CaixaDaFixture.Maria, descricao: "Login de 'maria'", localizacao: "pdv.login", ct: Ct);
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));

        // A API atualizada anuncia o tipo no próximo handshake: a abertura passa.
        amb.Api.VersoesSchema["caixa.aberto"] = [1];
        using (var ciclo = amb.CriarCiclo())
        {
            await ciclo.HandshakeAsync(Ct);
        }

        Assert.Equal(2, await caixa.AbrirAsync(CaixaDaFixture.SessaoAberta(), CaixaDaFixture.Abertura(), evento, Ct));
    }

    [Fact]
    public async Task Sem_nenhum_handshake_desde_a_migracao_o_caixa_abre_offline()
    {
        // Terminal da 1B atualizado que reabre sem internet: a coluna nasce nula na TabelasCaixa e só o handshake a
        // preenche. O caixa nunca trava por falta de internet (O18); a implantação é API primeiro (padrão até a
        // confirmação do dono, README › decisão 51).
        using var amb = await AmbienteSync.CriarAsync();
        Assert.True((await amb.AtivarAsync()).Ativado);
        Assert.Equal(DBNull.Value, amb.Escalar("select versoes_schema_nuvem from estado_conexao") ?? DBNull.Value);
        var caixa = Caixa(amb);
        Assert.True(await caixa.TipoAceitoAsync("caixa.aberto", ct: Ct));
        var evento = FabricaEventosCaixa.CaixaAberto(CaixaDaFixture.SessaoAberta(), CaixaDaFixture.Abertura(), null, Guid.CreateVersion7());

        Assert.Equal(1, await caixa.AbrirAsync(CaixaDaFixture.SessaoAberta(), CaixaDaFixture.Abertura(), evento, Ct));

        // Depois do primeiro handshake vale o anúncio: a API sem o tipo recusa o próximo fato (aqui, o reforço).
        amb.Api.VersoesSchema = new(StringComparer.Ordinal) { ["auditoria.registros"] = [1], ["caixa.aberto"] = [1] };
        using (var ciclo = amb.CriarCiclo())
        {
            Assert.Equal(Cliente.DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        }

        var reforco = FabricaEventosCaixa.CaixaReforco(CaixaDaFixture.Reforco(), null, null, Guid.CreateVersion7());
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => caixa.RegistrarMovimentoAsync(CaixaDaFixture.Reforco(), reforco, Ct));
        Assert.Equal(GravadorOutbox.MensagemTipoNaoAnunciado("caixa.reforco", 1), recusa.Message);
    }

    [Theory]
    [InlineData("""{"caixa.aberto":[1]}""", "caixa.aberto", 1, true)]
    [InlineData("""{"caixa.aberto":[1]}""", "caixa.aberto", 2, false)]
    [InlineData("""{"caixa.aberto":[1,2]}""", "caixa.aberto", 2, true)]
    [InlineData("""{"venda.finalizada":[1]}""", "caixa.aberto", 1, false)]
    [InlineData(null, "caixa.aberto", 1, true)]
    [InlineData("", "venda.finalizada", 1, true)]
    [InlineData("{}", "caixa.aberto", 1, false)]
    [InlineData("não é json", "caixa.aberto", 1, false)]
    [InlineData(null, "auditoria.registros", 1, true)]
    [InlineData("{}", "terminal.configuracao_alterada", 1, true)]
    public void Tipo_anunciado_confere_tipo_e_versao(string? versoes, string tipo, int versao, bool aceito) =>
        Assert.Equal(aceito, GravadorOutbox.TipoAnunciado(versoes, tipo, versao));

    [Fact]
    public async Task Hora_do_envelope_e_monotonica_e_marca_relogio_regrediu_quando_nao_aplica()
    {
        using var amb = await ProntoAsync();
        var caixa = Caixa(amb);
        var agora = amb.Relogio.Agora;
        var sessao = CaixaDaFixture.SessaoAberta();
        sessao.AbertaEm = agora;
        sessao.FundoTroco = 0m;
        await caixa.AbrirAsync(sessao, null, FabricaEventosCaixa.CaixaAberto(sessao, null, null, Guid.CreateVersion7()), Ct);

        // 30 s antes do anterior (ajuste pequeno do relógio): o envelope vai 1 ms depois dele, o payload fica com a hora dele.
        var reforco = CaixaDaFixture.Reforco();
        reforco.OcorridoEm = agora.AddSeconds(-30);
        var evento = FabricaEventosCaixa.CaixaReforco(reforco, null, null, Guid.CreateVersion7());
        await caixa.RegistrarMovimentoAsync(reforco, evento, Ct);
        var linha = await EventoAsync(amb, evento.Id);
        Assert.Equal((agora.AddMilliseconds(1), (bool?)null), (linha.OcorridoEm, linha.RelogioRegrediu));

        // Mais de 2 min antes (o anterior estava adiantado): não segura no futuro; usa a hora do fato e marca a regressão.
        var outro = CaixaDaFixture.Reforco();
        outro.Id = Guid.CreateVersion7();
        outro.OcorridoEm = agora.AddMinutes(-10);
        var regrediu = FabricaEventosCaixa.CaixaReforco(outro, null, null, Guid.CreateVersion7());
        await caixa.RegistrarMovimentoAsync(outro, regrediu, Ct);
        var envelope = OutboxSync.Envelope(await EventoAsync(amb, regrediu.Id), (await amb.Terminal.ObterIdentidadeAsync(Ct))!, amb.Maquina.VersaoApp);
        Assert.Equal((Protocolo.FormatoProtocolo.DataHora(agora.AddMinutes(-10)), (bool?)true), (envelope.OcorridoEm, envelope.RelogioRegrediu));

        // C16: auditoria local `relogio_regrediu` no mesmo commit (o anterior estava em agora + 1 ms: recuo de 600 001 ms),
        // uma por regressão (o evento seguinte compara com o marcado e segue a monotonicidade normal, sem outra auditoria).
        var depois = CaixaDaFixture.Reforco();
        depois.Id = Guid.CreateVersion7();
        depois.OcorridoEm = agora.AddMinutes(-9);
        await caixa.RegistrarMovimentoAsync(depois, FabricaEventosCaixa.CaixaReforco(depois, null, null, Guid.CreateVersion7()), Ct);
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            var auditoria = await db.LogAuditoriaLocal.AsNoTracking().Where(l => l.Acao == GravadorOutbox.AcaoRelogioRegrediu).ToListAsync(Ct);
            var registroLocal = Assert.Single(auditoria);
            Assert.Equal(("eventos_saida", (Guid?)regrediu.Id, "pdv.relogio", (Guid?)CaixaDaFixture.Sessao), (
                registroLocal.Entidade, registroLocal.RegistroId, registroLocal.Localizacao, registroLocal.SessaoCaixaId));
            Assert.Equal(agora.AddMinutes(-10), registroLocal.OcorridoEm);
            var dados = JsonNode.Parse(registroLocal.Depois!)!;
            Assert.Equal((regrediu.Id.ToString("D"), 3L, "caixa.reforco", 600_001L), (
                dados["evento_id"]!.GetValue<string>(), dados["sequencia"]!.GetValue<long>(), dados["tipo"]!.GetValue<string>(),
                dados["recuo_ms"]!.GetValue<long>()));
            Assert.Equal(Protocolo.FormatoProtocolo.DataHora(agora.AddMilliseconds(1)), dados["ultimo_ocorrido_em"]!.GetValue<string>());
            Assert.Equal(Protocolo.FormatoProtocolo.DataHora(agora.AddMinutes(-10)), dados["ocorrido_em"]!.GetValue<string>());
            Assert.StartsWith("Relógio regrediu: o evento anterior estava 10 min à frente", registroLocal.Descricao);
        }

        // Sobe no lote `auditoria.registros` (a ação está no catálogo da nuvem) e chega à "nuvem" com as horas.
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        Guid lote;
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            lote = await db.EventosSaida.AsNoTracking().Where(e => e.Tipo == OutboxSync.TipoAuditoria).Select(e => e.Id).SingleAsync(Ct);
        }

        var registro = Assert.Single(amb.Api.EventosRecebidos[lote]["payload"]!["registros"]!.AsArray(),
            r => r!["acao"]!.GetValue<string>() == "relogio_regrediu")!;
        Assert.Equal(regrediu.Id.ToString("D"), registro["registro_id"]!.GetValue<string>());
        Assert.Equal(600_001L, registro["depois"]!["recuo_ms"]!.GetValue<long>());
    }

    [Fact]
    public async Task Venda_finalizada_declara_a_sessao_e_grava_o_relogio_confiavel_do_envelope()
    {
        using var amb = await ProntoAsync();
        var relogio = new RelogioNaoConfiavel(amb.Relogio);
        var vendas = new RepositorioVendas(amb.Fabrica, amb.Relogio, new GravadorOutbox(relogio, amb.Maquina.VersaoApp));
        var agora = amb.Relogio.Agora;
        // A venda é da sessão aberta deste terminal (C11a: o repositório confere no encerramento).
        var sessao = CaixaDaFixture.SessaoAberta();
        sessao.FundoTroco = 0m;
        await Caixa(amb).AbrirAsync(sessao, null, FabricaEventosCaixa.CaixaAberto(sessao, null, null, Guid.CreateVersion7()), Ct);
        var contexto = new ContextoVenda(amb.Api.TerminalId, ApiFalsa.LojaId, 1, ApiFalsa.CaixaId, 2, CaixaDaFixture.Sessao);
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await vendas.ReservarNumeroVendaAsync(Ct), contexto, CaixaDaFixture.Maria, agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "ÁGUA", "UN", 2.50m)), 1m, "789", agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(new FormaPagamentoInfo(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", true), 2.50m, agora);
        var eventoId = Guid.CreateVersion7();
        venda.Finalizar(agora, eventoId);

        Assert.Equal(2, await vendas.EncerrarAsync(venda, FabricaEventos.VendaFinalizada(venda, eventoId), ct: Ct));

        var envelope = OutboxSync.Envelope(await EventoAsync(amb, eventoId), (await amb.Terminal.ObterIdentidadeAsync(Ct))!, amb.Maquina.VersaoApp);
        Assert.Equal(new[] { new Protocolo.DependenciaEvento("sessao_caixa", CaixaDaFixture.Sessao) }, envelope.Dependencias);
        Assert.Equal(((Guid?)CaixaDaFixture.Maria, (Guid?)CaixaDaFixture.Sessao, (bool?)false), (envelope.UsuarioId, envelope.Contexto.SessaoCaixaId, envelope.RelogioConfiavel));
        // T5: a coluna da venda acompanha o envelope (a nuvem não recebe `relogio_confiavel` no payload).
        Assert.Equal(0L, (long)amb.Escalar($"select relogio_confiavel from vendas where id = '{venda.Id:D}'")!);
    }

    [Fact]
    public void DuracaoLegivel_mesmas_faixas_do_shared()
    {
        // As mesmas do `duracaoLegivel` do @genesis/shared (alerta da nuvem e coluna "Relógio" do ERP).
        Assert.Equal(
            new[] { "45 s", "7 min", "3 h", "3 h 12 min", "47 h", "3 dias", "12 dias" },
            new[]
            {
                TimeSpan.FromSeconds(45), TimeSpan.FromMinutes(-7), TimeSpan.FromHours(3), TimeSpan.FromMinutes(192),
                TimeSpan.FromHours(47), TimeSpan.FromHours(72), TimeSpan.FromDays(12),
            }.Select(GravadorOutbox.DuracaoLegivel));
    }

    /// <summary>Relógio sem amostra no boot atual (12.2): a hora vale, mas <c>relogio_confiavel = false</c>.</summary>
    private sealed class RelogioNaoConfiavel(IRelogio relogio) : IRelogioOutbox
    {
        public HoraDoFato HoraDoFato(DateTimeOffset? ultimoOcorridoEm, DateTimeOffset? fato = null) =>
            Data.Outbox.HoraDoFato.Calcular(relogio.Agora, 1500, confiavel: false, ultimoOcorridoEm, fato);
    }
}
