using System.Net;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using GenesisPDV.Sync.Ciclo;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Push;
using GenesisPDV.Sync.Relogio;
using GenesisPDV.Sync.Token;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Ciclo online da Fase 1B (bloco B5) contra a <see cref="ApiFalsa"/>: lote de auditoria, push com reenvio do mesmo lote e
/// a máquina de status (SYNC 7), comandos com dedupe (21.1), handshake (5), desativação confirmada e revogação (3.8),
/// relógio (12.2) e o indicador (PDV 30.2).
/// </summary>
public sealed partial class CicloOnlineTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Terminal ativado contra a API falsa, que manda intervalos de 1 s (a fixture traz os 30 s de produção).</summary>
    private static async Task<AmbienteSync> AtivadoAsync()
    {
        var amb = await AmbienteSync.CriarAsync();
        amb.Api.IntervaloS = 1;
        Assert.True((await amb.AtivarAsync()).Ativado);
        return amb;
    }

    /// <summary>Login gravado como o <c>LoginViewModel</c> grava, um segundo depois do anterior (ordem estável no lote).</summary>
    private static Task LoginAsync(AmbienteSync amb, string login, string acao = "login", string? motivo = null)
    {
        amb.Relogio.Agora += TimeSpan.FromSeconds(1);
        return amb.Terminal.RegistrarAuditoriaAsync(
            acao, acao == "login" ? Guid.CreateVersion7() : null, descricao: $"Login de '{login}'", localizacao: "pdv.login", ct: Ct,
            motivo: motivo, depois: System.Text.Json.JsonSerializer.Serialize(new { login_informado = login }));
    }

    /// <summary><c>sequencias_locais.evento</c> (0 sem a linha).</summary>
    private static async Task<long> SequenciaEventoAsync(AmbienteSync amb)
    {
        await using var db = amb.Fabrica.CreateDbContext();
        return await db.SequenciasLocais.Where(s => s.Chave == SequenciaLocal.Evento).Select(s => s.UltimoValor).FirstOrDefaultAsync(Ct);
    }

    private static async Task<List<EventoSaida>> EventosAsync(AmbienteSync amb)
    {
        await using var db = amb.Fabrica.CreateDbContext();
        return await db.EventosSaida.AsNoTracking().OrderBy(e => e.SequenciaTerminal).ToListAsync(Ct);
    }

    [Fact]
    public async Task Liberacao_sobe_com_o_motivo_em_depois_junto_do_valor_ja_gravado()
    {
        // PDV 31.3 / SYNC 9.22 (Fase 1C, C10a): a nuvem não tem coluna de motivo; ele vai em `depois.motivo`.
        using var amb = await AtivadoAsync();
        var (operador, supervisor) = (Guid.CreateVersion7(), Guid.CreateVersion7());
        await amb.Terminal.RegistrarAuditoriaAsync("liberacao", operador, "sessoes_caixa", Guid.CreateVersion7(), "Fechamento liberado por CARLOS",
            "pdv.caixa", supervisor, Ct, motivo: "  Operador novo, treinamento ");
        amb.Relogio.Agora += TimeSpan.FromSeconds(1);
        await amb.Terminal.RegistrarAuditoriaAsync("liberacao", operador, "itens_venda", Guid.CreateVersion7(), "Desconto liberado", "PDV › Desconto",
            supervisor, Ct, motivo: "Cliente fidelidade", depois: """{"desconto_item":"0.50"}""");
        // Fora da liberação o motivo continua só local (o do login negado vai em `logins.motivo_falha`).
        amb.Relogio.Agora += TimeSpan.FromSeconds(1);
        await amb.Terminal.RegistrarAuditoriaAsync("logout", operador, localizacao: "pdv.caixa", ct: Ct, motivo: "não sobe");
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));

        var registros = JsonNode.Parse(Assert.Single(await EventosAsync(amb)).Payload)!["registros"]!.AsArray()
            .Where(r => r!["usuario_id"]?.GetValue<string>() == operador.ToString("D")).ToList();
        Assert.Equal(["liberacao", "liberacao", "logout"], registros.Select(r => r!["acao"]!.GetValue<string>()));
        Assert.Equal("""{"motivo":"Operador novo, treinamento"}""", registros[0]!["depois"]!.ToJsonString());
        Assert.Equal(supervisor.ToString("D"), registros[0]!["autorizado_por_id"]!.GetValue<string>());
        Assert.Equal("""{"desconto_item":"0.50","motivo":"Cliente fidelidade"}""", registros[1]!["depois"]!.ToJsonString());
        Assert.Null(registros[2]!["depois"]);
    }

    [Fact]
    public async Task Auditoria_do_catalogo_sobe_em_lote_com_logins_e_o_resto_fica_local()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        await LoginAsync(amb, "joão", "login_negado", "senha_invalida");
        await amb.Terminal.RegistrarAuditoriaAsync("desconto_item", Guid.CreateVersion7(), "item_venda", ct: Ct);

        // Menos de 200 e mais novo que 5 min: espera (18.2).
        Assert.False(await amb.Outbox.GerarAuditoriaAsync(ct: Ct));
        amb.Relogio.Agora += OutboxSync.EsperaAuditoria;
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(ct: Ct));
        Assert.False(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));

        var evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal(("auditoria.registros", 1L, "auditoria"), (evento.Tipo, evento.SequenciaTerminal, evento.AgregadoTipo));
        Assert.Equal(Protocolo.Jcs.Sha256Hex(evento.Payload), evento.PayloadSha256);
        var payload = JsonNode.Parse(evento.Payload)!;
        var registros = payload["registros"]!.AsArray();
        // Ativação + login + login negado; o desconto (fora do catálogo da nuvem) fica no banco local.
        Assert.Equal(["terminal_ativado", "login", "login_negado"], registros.Select(r => r!["acao"]!.GetValue<string>()));
        Assert.All(registros, r => Assert.False(string.IsNullOrEmpty(r!["entidade"]!.GetValue<string>())));
        var logins = payload["logins"]!.AsArray();
        Assert.Equal(["maria", "joão"], logins.Select(l => l!["login_informado"]!.GetValue<string>()));
        Assert.Equal([true, false], logins.Select(l => l!["sucesso"]!.GetValue<bool>()));
        Assert.Equal("senha_invalida", logins[1]!["motivo_falha"]!.GetValue<string>());
        Assert.Equal(1L, amb.Contar("log_auditoria_local where evento_id is null"));

        // Envelope com o contexto da identidade e o JSON que a API recalcula.
        var envelope = OutboxSync.Envelope(evento, (await amb.Terminal.ObterIdentidadeAsync(Ct))!, amb.Maquina.VersaoApp);
        Assert.Equal((ApiFalsa.LojaId, ApiFalsa.CaixaId, "1.4.2"), (envelope.Contexto.LojaId, envelope.Contexto.CaixaId, envelope.Contexto.VersaoApp));
        Assert.Equal(evento.PayloadSha256, Protocolo.Jcs.Sha256Hex(Protocolo.Jcs.Serializar(JsonNode.Parse(envelope.Payload.GetRawText()))));
    }

    [Fact]
    public async Task Catalogos_do_pdv_sao_os_da_nuvem()
    {
        var enums = File.ReadAllText(Path.Combine(Fixtures.Pasta("shared"), "enums.ts"));
        Assert.Equal(ListaTs(enums, "ACOES_AUDITORIA"), CatalogosNuvem.AcoesAuditoria);
        Assert.Equal(ListaTs(enums, "MOTIVOS_FALHA_LOGIN"), CatalogosNuvem.MotivosFalhaLogin);
    }

    [Fact]
    public void Hora_de_corte_padrao_do_pdv_e_a_do_catalogo()
    {
        // D7 (dono): 05:00 na empresa, ajustável por loja. Sem a chave no espelho, o caixa usa o mesmo padrão da nuvem.
        var catalogo = File.ReadAllText(Path.Combine(Fixtures.Pasta("shared"), "configuracoes.ts"));
        var linha = Regex.Match(catalogo, @"\['geral\.dia_operacional_hora_corte', hora, '([0-9]{2}:[0-9]{2})'");
        Assert.True(linha.Success);
        Assert.Equal(linha.Groups[1].Value, ChavesConfiguracao.HoraCortePadrao.ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Padroes_das_chaves_de_caixa_do_pdv_sao_os_do_catalogo()
    {
        // Fase 1C, C10a: sem a chave no espelho, o caixa usa o padrão da nuvem (O3 do dono: sem recontagem e sem a
        // conferência no PDV; O4: abertura obrigatória).
        var catalogo = File.ReadAllText(Path.Combine(Fixtures.Pasta("shared"), "configuracoes.ts"));
        foreach (var (chave, padrao) in ChavesConfiguracao.PadroesBool)
        {
            var linha = Regex.Match(catalogo, $@"\['{Regex.Escape(chave)}', bool, (true|false)");
            Assert.True(linha.Success, chave);
            Assert.True((linha.Groups[1].Value == "true") == padrao, chave);
        }

        Assert.Matches($@"\['{Regex.Escape(ChavesConfiguracao.ToleranciaDiferencaCaixa)}', dinheiro, '0\.00'", catalogo);
        Assert.Matches($@"\['{Regex.Escape(ChavesConfiguracao.HorasAlertaSessao)}', inteiro\(1, 720\), {ChavesConfiguracao.HorasAlertaSessaoPadrao},", catalogo);
        // C10b (O5 do dono): sem limite de gaveta no padrão; resumo diário por intervalo de dias.
        Assert.Matches($@"\['{Regex.Escape(ChavesConfiguracao.ValorLimiteSangria)}', dinheiro, null,", catalogo);
        // O18 do dono (C11a): sem tempo máximo offline — o PDV lê nulo como "sem limite".
        Assert.Matches($@"\['{Regex.Escape(ChavesConfiguracao.DiasMaxOffline)}', inteiro\(1, 60\), null,", catalogo);
        // C11c (D38): o teto do desconto pelos cascos sem supervisor.
        Assert.Matches($@"\['{Regex.Escape(ChavesConfiguracao.DescontoCascosMaxSemSupervisor)}', dinheiro, '50\.00',", catalogo);
        Assert.Equal(50m, ChavesConfiguracao.DescontoCascosMaxSemSupervisorPadrao);
        Assert.Matches($@"\['{Regex.Escape(ChavesConfiguracao.ResumoDiarioModo)}', umDe\(\['{ChavesConfiguracao.ResumoPorDias}', '{ChavesConfiguracao.ResumoPorHorario}'\]\), '{ChavesConfiguracao.ResumoPorDias}',", catalogo);
    }

    [Fact]
    public async Task Heartbeat_leva_a_sessao_aberta_e_o_dinheiro_estimado_e_o_status_detalhado_mostra_pendentes_e_quarentena()
    {
        // Fase 1C, C10b (SYNC 10.1, PDV 20.4 e 30.2): o ERP vê a sessão e a gaveta estimada do terminal; F11 › S lê o banco.
        using var amb = await AtivadoAsync();
        var caixa = new RepositorioCaixa(amb.Fabrica, amb.Relogio);
        var sessao = CaixaDaFixture.SessaoAberta();
        var abertura = CaixaDaFixture.Abertura();
        await caixa.AbrirAsync(sessao, abertura, Eventos.FabricaEventosCaixa.CaixaAberto(sessao, abertura, null, Guid.CreateVersion7()), Ct);
        var reforco = CaixaDaFixture.Reforco();
        await caixa.RegistrarMovimentoAsync(reforco, Eventos.FabricaEventosCaixa.CaixaReforco(reforco, 150m, null, Guid.CreateVersion7()), Ct);
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            var antes = await StatusDetalhadoSync.LerAsync(db, Ct);
            Assert.Equal([("caixa.aberto", 1), ("caixa.reforco", 1)], antes.PendentesPorTipo.Select(p => (p.Key, p.Value)));
            Assert.Equal((0, (DateTimeOffset?)null), (antes.QuarentenaTotal, antes.UltimoPushSucessoEm));
        }

        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(
            () => amb.Api.UltimoEnvio("/sync/heartbeat") is { Corpo: { } c } && JsonNode.Parse(c)!["dinheiro_estimado_gaveta"] is not null, "heartbeat com a gaveta");
        var corpo = JsonNode.Parse(amb.Api.UltimoEnvio("/sync/heartbeat")!.Corpo!)!;
        // 150,00 de fundo + 50,00 de reforço.
        Assert.Equal((sessao.Id.ToString("D"), "200.00"), (corpo["sessao_caixa_id"]!.GetValue<string>(), corpo["dinheiro_estimado_gaveta"]!.GetValue<string>()));
        Assert.Equal(0, amb.Api.HeartbeatsRecusados);

        await AmbienteSync.EsperarAsync(async () =>
        {
            await using var db = amb.Fabrica.CreateDbContext();
            return (await StatusDetalhadoSync.LerAsync(db, Ct)) is { PendentesPorTipo.Count: 0, UltimoPushSucessoEm: not null, UltimoPullSucessoEm: not null };
        }, "push confirmado");
        amb.Escalar("update eventos_saida set status = 'rejeitado', ultimo_erro = 'PAYLOAD_INVALIDO: valor' where tipo = 'caixa.reforco'");
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            var depois = await StatusDetalhadoSync.LerAsync(db, Ct);
            Assert.Equal(1, depois.QuarentenaTotal);
            Assert.Equal(("caixa.reforco", "PAYLOAD_INVALIDO: valor"), (depois.Quarentena[0].Tipo, depois.Quarentena[0].Erro));
            Assert.Contains(depois.Cursores, c => c.Fluxo == "catalogo");
        }
    }

    [Fact]
    public void Permissoes_do_caixa_e_o_perfil_do_operador_sao_os_do_shared()
    {
        var permissoes = File.ReadAllText(Path.Combine(Fixtures.Pasta("shared"), "permissoes.ts"));
        foreach (var chave in new[]
                 {
                     Core.Caixa.PermissoesPdv.Entrar, Core.Caixa.PermissoesPdv.Supervisor, Core.Caixa.PermissoesPdv.AbrirCaixa,
                     Core.Caixa.PermissoesPdv.FecharCaixa, Core.Caixa.PermissoesPdv.VerCalculadoFechamento, Core.Caixa.PermissoesPdv.OperarDeOutro,
                     Core.Caixa.PermissoesPdv.DescontoItem, Core.Caixa.PermissoesPdv.DescontoTotal, Core.Caixa.PermissoesPdv.Sangria,
                     Core.Caixa.PermissoesPdv.Reforco, Core.Caixa.PermissoesPdv.CancelarMovimento, Core.Caixa.PermissoesPdv.IgnorarLimiteSangria,
                     Core.Caixa.PermissoesPdv.ResumoDiario, Core.Caixa.PermissoesPdv.ConfirmarPixManual, Core.Caixa.PermissoesPdv.FormaComSenha,
                     Core.Caixa.PermissoesPdv.VenderSemEstoque, Core.Caixa.PermissoesPdv.CancelarItem,
                     Core.Caixa.PermissoesPdv.ConsultarHistoricoVendas, Core.Caixa.PermissoesPdv.ConsultarFechamentos,
                     Core.Caixa.PermissoesPdv.VerDiagnostico, Core.Caixa.PermissoesPdv.PacoteSuporte,
                     Core.Caixa.PermissoesPdv.VerAuditoriaLocal, Core.Caixa.PermissoesPdv.ParametrosLocais,
                 })
        {
            Assert.Contains($"['{chave}',", permissoes, StringComparison.Ordinal);
        }

        // F4 Remover item (decisão 65): o rótulo que o ERP mostra em Perfis de acesso, no grupo da venda, e no perfil do
        // operador (por padrão nada muda; o dono a tira do perfil para exigir o PIN do supervisor).
        Assert.Contains("['pdv.venda.cancelar_item', 'Cancelar item']", permissoes, StringComparison.Ordinal);
        Assert.Contains(Core.Caixa.PermissoesPdv.CancelarItem, Core.Caixa.PermissoesPdv.PerfilOperador);

        foreach (var chave in Core.Caixa.PermissoesPdv.SemLiberacao)
        {
            Assert.Matches($@"\['{Regex.Escape(chave)}', '[^']+', \{{ semLiberacao: true \}}\]", permissoes);
        }

        var perfis = File.ReadAllText(Path.Combine(Fixtures.Pasta("shared"), "perfis-padrao.ts"));
        Assert.Equal(ListaPerfil(perfis, "PDV_OPERADOR").Order(StringComparer.Ordinal), Core.Caixa.PermissoesPdv.PerfilOperador.Order(StringComparer.Ordinal));
        // As liberações da tela de pagamento e do estoque (C11a) são do supervisor padrão, não só do Master.
        Assert.Superset(
            new HashSet<string>(StringComparer.Ordinal)
            {
                Core.Caixa.PermissoesPdv.ConfirmarPixManual, Core.Caixa.PermissoesPdv.FormaComSenha, Core.Caixa.PermissoesPdv.VenderSemEstoque,
            },
            ListaPerfil(perfis, "PDV_SUPERVISOR").ToHashSet(StringComparer.Ordinal));

        // Central do PDV (decisão 66): as consultas são do supervisor (e, por ele, do Encarregado); o histórico de uso e
        // os parâmetros do caixa, não. O Encarregado (PC-8) é o Supervisor mais o cancelamento da venda paga do caixa aberto
        // (dono, 05/11/2026; decisão 78), que o Supervisor não tem; a de caixa fechado não tem permissão (D23 mantida).
        var supervisor = ListaPerfil(perfis, "PDV_SUPERVISOR");
        Assert.Superset(
            new HashSet<string>(StringComparer.Ordinal)
            {
                Core.Caixa.PermissoesPdv.ConsultarHistoricoVendas, Core.Caixa.PermissoesPdv.ConsultarFechamentos,
                Core.Caixa.PermissoesPdv.VerDiagnostico, Core.Caixa.PermissoesPdv.PacoteSuporte,
            },
            supervisor.ToHashSet(StringComparer.Ordinal));
        Assert.DoesNotContain(Core.Caixa.PermissoesPdv.VerAuditoriaLocal, supervisor);
        Assert.DoesNotContain(Core.Caixa.PermissoesPdv.ParametrosLocais, supervisor);
        Assert.DoesNotContain(Core.Caixa.PermissoesPdv.CancelarVendaFinalizada, supervisor);
        // Sem fixar a formatação do prettier: a declaração espalha o supervisor e acrescenta só o cancelamento da venda paga
        // (a composição exata fica no `permissoes.spec.ts`).
        var encarregado = DeclaracaoTs(perfis, "PDV_ENCARREGADO");
        Assert.Contains("...PDV_SUPERVISOR", encarregado, StringComparison.Ordinal);
        Assert.Equal([Core.Caixa.PermissoesPdv.CancelarVendaFinalizada], Regex.Matches(encarregado, "'([a-z_.]+)'").Select(m => m.Groups[1].Value));
        Assert.Contains("chaveSistema: 'encarregado'", perfis, StringComparison.Ordinal);
        Assert.DoesNotContain("cancelar_venda_sessao_fechada", permissoes, StringComparison.Ordinal);
    }

    private static string DeclaracaoTs(string fonte, string nome)
    {
        var inicio = fonte.IndexOf($"const {nome} =", StringComparison.Ordinal);
        Assert.True(inicio >= 0, nome);
        return fonte[inicio..fonte.IndexOf(';', inicio)];
    }

    private static List<string> ListaPerfil(string fonte, string nome)
    {
        var inicio = fonte.IndexOf($"const {nome} = [", StringComparison.Ordinal);
        Assert.True(inicio >= 0, nome);
        var fim = fonte.IndexOf("];", inicio, StringComparison.Ordinal);
        return [.. Regex.Matches(fonte[inicio..fim], "'([a-z_.]+)'").Select(m => m.Groups[1].Value)];
    }

    private static List<string> ListaTs(string fonte, string nome)
    {
        var inicio = fonte.IndexOf($"export const {nome} = [", StringComparison.Ordinal);
        Assert.True(inicio >= 0, nome);
        var fim = fonte.IndexOf("] as const", inicio, StringComparison.Ordinal);
        return [.. TextoTs().Matches(fonte[inicio..fim]).Select(m => m.Groups[1].Value)];
    }

    [GeneratedRegex("'([a-z_]+)'")]
    private static partial Regex TextoTs();

    [Fact]
    public async Task Push_sem_resposta_repete_o_mesmo_lote_com_o_mesmo_corpo_e_confirma()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));
        var tentativas = 0;
        amb.Api.AoEnviar = _ => ++tentativas == 1 ? throw new HttpRequestException("rede caiu") : null;

        var falha = await amb.Envio.EnviarAsync(Ct);
        Assert.Equal(DesfechoPush.Falhou, falha.Desfecho);
        var evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal((StatusEventoSaida.ErroTemporario, 1), (evento.Status, evento.Tentativas));
        Assert.True(evento.ProximaTentativaEm > amb.Relogio.Agora);
        Assert.Equal(DesfechoPush.Aguardando, (await amb.Envio.EnviarAsync(Ct)).Desfecho);

        amb.Relogio.Agora = evento.ProximaTentativaEm!.Value;
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        var envios = amb.Api.Envios.Where(e => e.Rota.EndsWith("/sync/push", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, envios.Count);
        Assert.Equal(envios[0].Corpo, envios[1].Corpo);
        Assert.Equal(envios[0].RequisicaoId, envios[1].RequisicaoId);
        Assert.Equal(evento.LoteEnvioId!.Value.ToString("D"), envios[0].RequisicaoId);
        evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal((StatusEventoSaida.Confirmado, 2_001L), (evento.Status, evento.VersaoNuvem));
        Assert.Equal(DesfechoPush.Vazio, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
    }

    [Fact]
    public async Task Erro_temporario_para_o_lote_e_os_seguintes_voltam_para_a_fila()
    {
        using var amb = await AtivadoAsync();
        // Um evento sem handler na nuvem (a venda da 1C) na frente de um lote de auditoria.
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            var seq = await db.SequenciasLocais.SingleAsync(s => s.Chave == SequenciaLocal.Evento, Ct);
            seq.UltimoValor = 1;
            db.EventosSaida.Add(new EventoSaida
            {
                Id = IdGerador.Novo(),
                SequenciaTerminal = 1,
                Tipo = "venda.finalizada",
                AgregadoTipo = "venda",
                AgregadoId = Guid.CreateVersion7(),
                OcorridoEm = amb.Relogio.Agora,
                CriadoEm = amb.Relogio.Agora,
                Payload = "{}",
                PayloadSha256 = Protocolo.Jcs.Sha256Hex("{}"),
            });
            await db.SaveChangesAsync(Ct);
        }

        await LoginAsync(amb, "maria");
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));
        amb.Api.StatusPorTipo["venda.finalizada"] = "erro_temporario";

        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        var eventos = await EventosAsync(amb);
        Assert.Equal((StatusEventoSaida.ErroTemporario, "SCHEMA_DESCONHECIDO: Tipo ainda sem handler."), (eventos[0].Status, eventos[0].UltimoErro));
        Assert.Equal((StatusEventoSaida.Pendente, (Guid?)null), (eventos[1].Status, eventos[1].LoteEnvioId));
        // A frente em backoff segura a fila inteira (prefixo contínuo, 7.5): o lote de auditoria não passa na frente.
        Assert.Equal(DesfechoPush.Aguardando, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        Assert.Empty(amb.Api.EventosRecebidos);
    }

    [Fact]
    public async Task Rejeitado_fica_em_quarentena_e_hardware_alterado_devolve_o_lote_intacto()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));

        amb.Api.HardwareConfere = false;
        Assert.Equal(DesfechoPush.HardwareAlterado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        var evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal(StatusEventoSaida.Pendente, evento.Status);
        Assert.NotNull(evento.LoteEnvioId);

        amb.Api.HardwareConfere = true;
        amb.Api.StatusPorTipo["auditoria.registros"] = "rejeitado";
        Assert.Equal(DesfechoPush.Enviado, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
        evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal((StatusEventoSaida.Rejeitado, "PAYLOAD_INVALIDO: Recusado pela API falsa."), (evento.Status, evento.UltimoErro));
        // A ocorrência ligada ao evento no log_local (Central do PDV, aba 4, bloco G7): o motivo e os ids, sem o payload.
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            var ocorrencia = await db.LogLocal.AsNoTracking().SingleAsync(l => l.Origem == EnvioPush.OrigemLog, Ct);
            Assert.Equal("aviso", ocorrencia.Nivel);
            Assert.Contains("PAYLOAD_INVALIDO: Recusado pela API falsa.", ocorrencia.Mensagem, StringComparison.Ordinal);
            Assert.Contains(evento.Id.ToString(), ocorrencia.Detalhes, StringComparison.Ordinal);
            Assert.Contains(evento.AgregadoId.ToString(), ocorrencia.Detalhes, StringComparison.Ordinal);
            // O código do PDV (bloco G8: a dica da aba 5) e o da nuvem, à parte.
            Assert.Equal(CodigoOcorrencia.RegistroRecusado.Codigo, Ocorrencias.CodigoDe(ocorrencia.Detalhes));
            Assert.Contains("\"codigo_nuvem\":\"PAYLOAD_INVALIDO\"", ocorrencia.Detalhes, StringComparison.Ordinal);
            Assert.DoesNotContain(evento.PayloadSha256, ocorrencia.Detalhes, StringComparison.Ordinal);
        }

        // Rejeitado não é reenviado: a nuvem já tem o evento (7.2).
        Assert.Equal(DesfechoPush.Vazio, (await amb.Envio.EnviarAsync(Ct)).Desfecho);
    }

    [Fact]
    public async Task Comandos_executam_uma_vez_e_a_repeticao_devolve_o_mesmo_resultado()
    {
        using var amb = await AtivadoAsync();
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            await db.EstadoSincronizacao.ExecuteUpdateAsync(s => s.SetProperty(e => e.Cursor, 500L), Ct);
        }

        var mensagens = new List<string>();
        amb.Comandos.MensagemRecebida += (_, t) => mensagens.Add(t);
        var mensagem = amb.Api.Comandar(TiposComando.Mensagem, new JsonObject { ["texto"] = "Inventário amanhã às 7h" });
        var fluxo = amb.Api.Comandar(TiposComando.RessincronizarFluxo, new JsonObject { ["fluxo"] = "catalogo" });
        var logs = amb.Api.Comandar(TiposComando.EnviarLogs);
        var comandos = amb.Api.Comandos.ToList();

        var primeira = await amb.Comandos.ProcessarAsync(comandos, Ct);
        var segunda = await amb.Comandos.ProcessarAsync(comandos, Ct);
        Assert.Equal(["executado", "executado", "falhou"], primeira.Select(a => a.Status));
        Assert.Equal(primeira.Select(a => a.Resultado?.GetRawText()), segunda.Select(a => a.Resultado?.GetRawText()));
        Assert.Equal(["Inventário amanhã às 7h"], mensagens);
        Assert.Equal(0L, amb.Escalar("select cursor from estado_sincronizacao where fluxo = 'catalogo'"));
        Assert.Equal(500L, amb.Escalar("select cursor from estado_sincronizacao where fluxo = 'acesso'"));
        Assert.Equal(ProcessadorComandos.ErroNaoSuportado, primeira[2].Resultado!.Value.GetProperty("erro").GetString());
        Assert.Equal(3L, amb.Contar("comandos_recebidos"));
        Assert.Equal([mensagem, fluxo, logs], primeira.Select(a => a.ComandoId));
        // As ocorrências da aba 5 da Central (bloco G8): a mensagem e o comando não feito, uma vez cada (a repetição devolve o
        // resultado gravado e não grava de novo).
        Assert.Equal(1L, amb.Escalar($"select count(*) from log_local where detalhes like '%\"{CodigoOcorrencia.ComandoFalhou.Codigo}\"%'"));
        Assert.Equal(1L, amb.Escalar($"select count(*) from log_local where detalhes like '%\"{CodigoOcorrencia.MensagemErp.Codigo}\"%'"));

        var revogar = amb.Api.Comandar(TiposComando.Revogar);
        Assert.Equal("executado", Assert.Single(await amb.Comandos.ProcessarAsync([amb.Api.Comandos.Single(c => c.Id == revogar)], Ct)).Status);
        Assert.Equal(StatusIdentidade.Desativando, (await amb.Terminal.ObterIdentidadeAsync(Ct))!.Status);
    }

    [Fact]
    public async Task Comando_que_falhou_grava_o_status_e_a_ocorrencia_juntos_ou_nenhum()
    {
        using var amb = await AtivadoAsync();
        amb.Api.Comandar(TiposComando.EnviarLogs);
        var comandos = amb.Api.Comandos.ToList();

        // O log_local recusa a linha (o SQLite ocupado no segundo passo): o "falhou" não fica sem a ocorrência — senão a
        // repetição devolveria o resultado gravado e a ocorrência sumiria de vez (Central do PDV, bloco G8).
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            await db.Database.ExecuteSqlRawAsync(
                "CREATE TRIGGER teste_log_ocupado BEFORE INSERT ON log_local BEGIN SELECT RAISE(ABORT, 'database is locked'); END;", Ct);
        }

        await Assert.ThrowsAsync<DbUpdateException>(() => amb.Comandos.ProcessarAsync(comandos, Ct));
        Assert.Equal("recebido", amb.Escalar("select status from comandos_recebidos"));
        Assert.Equal(0L, amb.Contar("log_local"));

        // Na repetição (o próximo heartbeat), com o banco livre: o status e a ocorrência, uma vez.
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            await db.Database.ExecuteSqlRawAsync("DROP TRIGGER teste_log_ocupado;", Ct);
        }

        Assert.Equal("falhou", Assert.Single(await amb.Comandos.ProcessarAsync(comandos, Ct)).Status);
        Assert.Equal("falhou", Assert.Single(await amb.Comandos.ProcessarAsync(comandos, Ct)).Status);
        Assert.Equal(1L, amb.Escalar($"select count(*) from log_local where detalhes like '%\"{CodigoOcorrencia.ComandoFalhou.Codigo}\"%'"));
    }

    [Fact]
    public async Task Desativando_para_de_reservar_numero_envia_tudo_e_confirma_com_os_numeros_finais()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        var vendas = new RepositorioVendas(amb.Fabrica, amb.Relogio);
        var numero = await vendas.ReservarNumeroVendaAsync(Ct);
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => amb.Api.UltimoHeartbeat is not null, "primeiro heartbeat");

        amb.Api.StatusTerminal = "desativando";
        // O laço publica na thread dele: fila concorrente, conferida depois que ele para.
        var estados = new System.Collections.Concurrent.ConcurrentQueue<EstadoTerminalSync>();
        ciclo.SituacaoAlterada += (_, s) => estados.Enqueue(s.Terminal);
        await AmbienteSync.EsperarAsync(() => amb.Api.DesativacaoConfirmada, "desativando_confirmado", 20_000);
        await AmbienteSync.EsperarAsync(async () => (await amb.Terminal.ObterIdentidadeAsync(Ct))!.Status == StatusIdentidade.Revogado, "revogado local");

        // A auditoria do login subiu antes da confirmação (o lote é forçado na desativação).
        Assert.Contains(amb.Api.EventosRecebidos.Values, e => e["tipo"]!.GetValue<string>() == "auditoria.registros");
        var hb = amb.Api.UltimoHeartbeat!;
        Assert.Equal("desativando_confirmado", hb["estado_local"]!.GetValue<string>());
        Assert.Equal(0, hb["eventos_pendentes"]!.GetValue<int>());
        Assert.Equal(numero, hb["venda_ultimo_numero"]!.GetValue<long>());
        Assert.Equal(amb.Api.UltimaSequenciaRecebida, hb["ultima_sequencia_gerada"]!.GetValue<long>());
        await AmbienteSync.EsperarAsync(() => !ciclo.Rodando, "ciclo parado");
        Assert.Contains(EstadoTerminalSync.Desativando, estados);
        Assert.Equal(EstadoTerminalSync.Revogado, ciclo.Situacao.Terminal);
        // Desde o desativando nenhum número é reservado; o banco local fica intacto.
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => vendas.ReservarNumeroVendaAsync(Ct));
        Assert.Equal(RepositorioVendas.MensagemTerminalDesativando, recusa.Message);
        Assert.True(amb.Contar("log_auditoria_local") >= 2);
    }

    [Fact]
    public async Task Revogacao_imediata_401_grava_revogado_e_para_o_ciclo_sem_apagar_nada()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => amb.Api.UltimoHeartbeat is not null, "primeiro heartbeat");
        amb.Api.Revogado = true;
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Terminal == EstadoTerminalSync.Revogado, "revogado");
        await AmbienteSync.EsperarAsync(() => !ciclo.Rodando, "ciclo parado");
        Assert.Equal(StatusIdentidade.Revogado, (await amb.Terminal.ObterIdentidadeAsync(Ct))!.Status);
        Assert.True(amb.Contar("log_auditoria_local") >= 2);
        Assert.Equal(1L, amb.Contar("identidade_terminal"));

        // Reaberto, o handshake já sabe (sem rede): só a tela de desativado.
        using var outro = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Revogado, (await outro.HandshakeAsync(Ct)).Desfecho);
    }

    [Fact]
    public async Task Handshake_com_o_token_de_outra_conta_do_sistema_vira_desfecho_proprio_sem_lancar()
    {
        // I3: o banco é da máquina (ProgramData, /var/lib/genesispdv) e o PDV abre para qualquer conta (Run em HKLM), mas a
        // DPAPI CurrentUser e a chave em ~/.config são da conta que ativou. A outra conta não decifra o token: o handshake
        // diz qual conta usar (gravada na ativação), nada sobe nem desce e o banco fica como estava.
        using var amb = await AtivadoAsync();
        Assert.Equal(ContaSistema.Atual(), await amb.Terminal.ObterConfiguracaoAsync<string>(ChavesConfiguracaoTerminal.ContaAtivacao, Ct));
        var outraConta = new ProtetorArquivo(Path.Combine(amb.Raiz, "outra-conta", "chave_terminal"), () => "0123456789abcdef0123456789abcdef");
        var cofre = new CofreToken(amb.Terminal, outraConta, amb.Relogio);
        var cliente = new ClienteSyncHttp(amb.Http, amb.Maquina.ParaCliente(), amb.Relogio, cofre, () => AmbienteSync.Url, amb.RelogioSync);
        using var ciclo = amb.CriarCiclo(cliente: cliente);
        var estadosAntes = amb.Api.Contar("/sync/estado");

        var r = await ciclo.HandshakeAsync(Ct);

        Assert.Equal(DesfechoHandshake.ContaDiferente, r.Desfecho);
        Assert.Contains($"\"{ContaSistema.Atual()}\"", r.Mensagem, StringComparison.Ordinal);
        Assert.Contains("Alt+F4", r.Mensagem, StringComparison.Ordinal);
        Assert.Equal(EstadoTerminalSync.Bloqueado, ciclo.Situacao.Terminal);
        Assert.Equal(r.Mensagem, ciclo.Situacao.Erro);
        Assert.Equal(estadosAntes, amb.Api.Contar("/sync/estado"));
        Assert.Equal(StatusIdentidade.Ativo, (await amb.Terminal.ObterIdentidadeAsync(Ct))!.Status);

        // Um protetor que lança CryptographicException de qualquer tipo (DPAPI de outra conta) dá o mesmo desfecho; um
        // banco ativado antes do I3 (sem a conta gravada) explica sem nome.
        await amb.Terminal.RemoverConfiguracaoAsync(ChavesConfiguracaoTerminal.ContaAtivacao, Ct);
        var dpapi = new CofreToken(amb.Terminal, new ProtetorQueRecusa(), amb.Relogio);
        using var outro = amb.CriarCiclo(cliente: new ClienteSyncHttp(amb.Http, amb.Maquina.ParaCliente(), amb.Relogio, dpapi, () => AmbienteSync.Url));
        var semNome = await outro.HandshakeAsync(Ct);
        Assert.Equal(DesfechoHandshake.ContaDiferente, semNome.Desfecho);
        Assert.Contains("por outra conta do ", semNome.Mensagem, StringComparison.Ordinal);
    }

    /// <summary>Como a DPAPI de outra conta do Windows: protege, mas nada abre.</summary>
    private sealed class ProtetorQueRecusa : Ativacao.IProtetorSegredos
    {
        public string Esquema => "recusa";

        public byte[] Proteger(ReadOnlySpan<byte> dados, string finalidade) => dados.ToArray();

        public byte[] Desproteger(ReadOnlySpan<byte> protegido, string finalidade) =>
            throw new System.Security.Cryptography.CryptographicException("Chave inválida para uso no estado especificado.");
    }

    [Fact]
    public async Task Handshake_bloqueia_regressao_e_hardware_e_aplica_desativando()
    {
        using var amb = await AtivadoAsync();
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);

        amb.Api.HardwareConfere = false;
        Assert.Equal(DesfechoHandshake.HardwareAlterado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(EstadoTerminalSync.HardwareAlterado, ciclo.Situacao.Terminal);
        amb.Api.HardwareConfere = true;

        // A nuvem já recebeu a sequência 7 deste terminal; o banco local está em 0 (backup antigo). Sem o GET
        // /sync/recuperar (fora do ar), a regressão bloqueia: as vendas só voltam com a reidratação (22.1, C17).
        amb.Api.EventosRecebidos[Guid.CreateVersion7()] = new JsonObject { ["sequencia"] = 7L, ["tipo"] = "auditoria.registros" };
        amb.Api.AoRecuperar = _ => ApiFalsa.Erro(HttpStatusCode.ServiceUnavailable, "MANUTENCAO", "Em manutenção.");
        var regressao = await ciclo.HandshakeAsync(Ct);
        Assert.Equal(DesfechoHandshake.Regressao, regressao.Desfecho);
        Assert.Equal(EstadoTerminalSync.Regressao, ciclo.Situacao.Terminal);
        // O passo 1 já levou a sequência local até a da nuvem (o caixa grava acima dela); a regressão fica na pendência.
        Assert.Equal(7L, await SequenciaEventoAsync(amb));

        // A nuvem volta: o Enter da tela refaz o handshake, que reidrata (o evento sem payload só ocupa a sequência) e
        // libera; o estado volta mesmo (nada fica herdado).
        amb.Api.AoRecuperar = null;
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal((EstadoTerminalSync.Ativo, (string?)null), (ciclo.Situacao.Terminal, ciclo.Situacao.Erro));
        Assert.Equal(7L, await SequenciaEventoAsync(amb));
        Assert.Equal([0L], amb.Api.ConsultasRecuperar);
        amb.Api.EventosRecebidos.Clear();

        amb.Api.StatusTerminal = "desativando";
        Assert.Equal(DesfechoHandshake.Desativando, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(StatusIdentidade.Desativando, (await amb.Terminal.ObterIdentidadeAsync(Ct))!.Status);

        amb.Api.Revogado = true;
        Assert.Equal(DesfechoHandshake.Revogado, (await ciclo.HandshakeAsync(Ct)).Desfecho);

        // Token recusado (TOKEN_INVALIDO): bloqueado, a nuvem não aceita mais este terminal como está.
        using var semRede = await AtivadoAsync();
        using var cicloSemRede = semRede.CriarCiclo();
        var hashes = semRede.Api.HashesValidos.ToList();
        semRede.Api.HashesValidos.Clear();
        var tokenRecusado = await cicloSemRede.HandshakeAsync(Ct);
        Assert.Equal(DesfechoHandshake.Bloqueado, tokenRecusado.Desfecho);
        Assert.Equal(EstadoTerminalSync.Bloqueado, cicloSemRede.Situacao.Terminal);

        // 401 passageiro (proxy, janela da rotação): Enter e o handshake libera; o indicador e as vendas voltam.
        semRede.Api.HashesValidos.UnionWith(hashes);
        Assert.Equal(DesfechoHandshake.Liberado, (await cicloSemRede.HandshakeAsync(Ct)).Desfecho);
        Assert.Equal(EstadoTerminalSync.Ativo, cicloSemRede.Situacao.Terminal);
        Assert.Equal("● Online", IndicadorSync.Calcular(cicloSemRede.Situacao with { Online = true }, DateTimeOffset.UtcNow).Texto);
    }

    [Fact]
    public async Task Ciclo_baixa_o_preco_novo_e_o_heartbeat_informa_o_cursor_no_teto()
    {
        using var amb = await AtivadoAsync();
        amb.Api.PublicarLojaECaixa();
        await amb.Carga.ExecutarAsync(ct: Ct);
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        var versao = amb.Api.Publicar("configuracao", "lojas", new JsonObject
        {
            ["id"] = ApiFalsa.LojaId.ToString("D"),
            ["codigo"] = 1,
            ["nome"] = "Loja 1 - Renomeada",
            ["razao_social"] = "ICE BEER",
            ["nome_fantasia"] = "Ice Beer",
            ["cnpj"] = "00000000000100",
            ["excluido_em"] = null,
        });
        await AmbienteSync.EsperarAsync(() => Equals(amb.Escalar("select nome from lojas"), "Loja 1 - Renomeada"), "loja renomeada pelo pull");
        await AmbienteSync.EsperarAsync(
            () => amb.Api.UltimoHeartbeat?["cursor_pull"]?["configuracao"]?.GetValue<long>() == versao, "cursor do heartbeat no teto");
        Assert.True(ciclo.Situacao.Online);
        Assert.Equal("● Online", IndicadorSync.Calcular(ciclo.Situacao with { Sincronizando = false }, DateTimeOffset.UtcNow).Texto);
    }

    [Fact]
    public async Task Relogio_usa_a_mediana_das_amostras_e_descarta_ida_e_volta_longa()
    {
        using var amb = await AtivadoAsync();
        var relogio = amb.RelogioSync;
        var t0 = amb.Relogio.Agora;
        relogio.Registrar(t0, TimeSpan.FromMilliseconds(200), t0.AddMilliseconds(1_100));
        relogio.Registrar(t0, TimeSpan.FromMilliseconds(200), t0.AddMilliseconds(1_300));
        relogio.Registrar(t0, TimeSpan.FromMilliseconds(200), t0.AddMilliseconds(9_100));
        relogio.Registrar(t0, TimeSpan.FromSeconds(4), t0.AddHours(3));
        Assert.Equal(1_200L, relogio.DesvioMs);
        Assert.True(relogio.Confiavel);

        // 12.3: corrigido = local + desvio; evento anterior até 2 min à frente → +1 ms; mais que isso → regrediu.
        var hora = relogio.HoraDoFato(null);
        Assert.Equal((amb.Relogio.Agora.AddMilliseconds(1_200), amb.Relogio.Agora, false), (hora.OcorridoEm, hora.OcorridoEmLocal, hora.Regrediu));
        var adiantado = hora.OcorridoEm.AddMinutes(1);
        Assert.Equal(adiantado.AddMilliseconds(1), relogio.HoraDoFato(adiantado).OcorridoEm);
        var muitoAdiantado = hora.OcorridoEm.AddHours(1);
        Assert.True(relogio.HoraDoFato(muitoAdiantado).Regrediu);

        await AmbienteSync.EsperarAsync(() => Equals(amb.Escalar("select desvio_relogio_ms from estado_conexao"), 1_200L), "desvio gravado");
        // Amostras vêm do X-Agora-Servidor de qualquer resposta.
        amb.Api.AgoraServidor = () => DateTimeOffset.UtcNow.AddMinutes(10);
        await amb.ClienteComRelogio.EstadoAsync(Ct);
        Assert.True(relogio.DesvioMs > 1_200);
    }

    [Fact]
    public void Indicador_segue_a_pdv_30_2()
    {
        var agora = DateTimeOffset.UtcNow;
        var online = new SituacaoSincronizacao(true, 3, null) { UltimoPullSucessoEm = agora };
        Assert.Equal(("● Online", NivelIndicador.Ok), IndicadorSync.Calcular(online, agora));
        Assert.Equal("⇅ Sincronizando", IndicadorSync.Calcular(online with { Sincronizando = true }, agora).Texto);
        Assert.Equal("● Offline há 12 min", IndicadorSync.Calcular(online with { Online = false, OfflineDesde = agora.AddMinutes(-12) }, agora).Texto);
        Assert.Equal("▲ Erro de sync", IndicadorSync.Calcular(online with { Rejeitados = 1 }, agora).Texto);
        Assert.Equal("▲ Cadastros de 3 dias atrás", IndicadorSync.Calcular(online with { UltimoPullSucessoEm = agora.AddDays(-3) }, agora).Texto);
        Assert.Equal(
            ("■ Hardware alterado — aguardando aprovação no ERP", NivelIndicador.Erro),
            IndicadorSync.Calcular(online with { Terminal = EstadoTerminalSync.HardwareAlterado }, agora));
        Assert.Equal("▲ Em desativação — enviando pendências (3)", IndicadorSync.Calcular(online with { Terminal = EstadoTerminalSync.Desativando }, agora).Texto);
        Assert.Equal("● Demonstração (sem nuvem)", IndicadorSync.Calcular(online with { SemNuvem = true }, agora).Texto);
    }

    [Fact]
    public void Backoff_vai_de_5_s_ao_teto()
    {
        Assert.Equal(TimeSpan.FromSeconds(5), EnvioPush.CalcularBackoff(1, EnvioPush.TetoBackoffEvento, 1));
        Assert.Equal(TimeSpan.FromSeconds(40), EnvioPush.CalcularBackoff(4, EnvioPush.TetoBackoffEvento, 1));
        Assert.Equal(TimeSpan.FromMinutes(10), EnvioPush.CalcularBackoff(30, EnvioPush.TetoBackoffEvento, 1));
        Assert.Equal(TimeSpan.FromSeconds(5), EnvioPush.CalcularBackoff(30, EnvioPush.TetoBackoffEvento, 0));
    }

    [Fact]
    public async Task Erro_401_no_push_devolve_o_lote_sem_perder_nada()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));
        amb.Api.Revogado = true;
        var erro = await Assert.ThrowsAsync<ErroSyncException>(() => amb.Envio.EnviarAsync(Ct));
        Assert.Equal((HttpStatusCode.Unauthorized, "TERMINAL_REVOGADO"), (erro.Status, erro.Codigo));
        Assert.Equal(StatusEventoSaida.Pendente, Assert.Single(await EventosAsync(amb)).Status);
    }

    [Fact]
    public async Task Relogio_de_outro_boot_nao_e_confiavel()
    {
        using var amb = await AtivadoAsync();
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.DesvioRelogioMs, 900L).SetProperty(c => c.DesvioAmostraBootId, "boot:outro"), Ct);
        }

        var relogio = new RelogioSync(amb.Fabrica, amb.Relogio);
        await relogio.CarregarAsync(Ct);
        Assert.Equal((900L, false), (relogio.DesvioMs, relogio.Confiavel));
    }
    /// <summary>Evento do outbox gravado direto (sequência à escolha), como o outbox grava.</summary>
    private static async Task<Guid> InserirEventoAsync(AmbienteSync amb, long sequencia, string status = StatusEventoSaida.Pendente)
    {
        var id = IdGerador.Novo();
        await using var db = amb.Fabrica.CreateDbContext();
        var seq = await db.SequenciasLocais.SingleAsync(s => s.Chave == SequenciaLocal.Evento, Ct);
        seq.UltimoValor = Math.Max(seq.UltimoValor, sequencia);
        db.EventosSaida.Add(new EventoSaida
        {
            Id = id,
            SequenciaTerminal = sequencia,
            Tipo = "auditoria.registros",
            AgregadoTipo = "auditoria",
            AgregadoId = Guid.CreateVersion7(),
            OcorridoEm = amb.Relogio.Agora,
            CriadoEm = amb.Relogio.Agora,
            Payload = "{}",
            PayloadSha256 = Protocolo.Jcs.Sha256Hex("{}"),
            Status = status,
        });
        await db.SaveChangesAsync(Ct);
        return id;
    }

    private static HttpResponseMessage Indisponivel(int retryAfterS)
    {
        var resposta = ApiFalsa.Erro(HttpStatusCode.ServiceUnavailable, "MANUTENCAO", "Manutenção programada.");
        resposta.Headers.Add("Retry-After", retryAfterS.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return resposta;
    }

    [Fact]
    public async Task Token_recusado_com_o_laco_rodando_espaca_o_heartbeat_para_push_e_pull_e_volta_quando_aceito()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => amb.Api.UltimoHeartbeat is not null, "primeiro heartbeat");

        // Token desconhecido na nuvem (banco copiado, token perdido na rotação, proxy que devolve 401).
        var hashes = amb.Api.HashesValidos.ToList();
        amb.Api.HashesValidos.Clear();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Terminal == EstadoTerminalSync.Bloqueado, "bloqueado");
        var (heartbeats, pulls, pushes) = (amb.Api.Contar("/sync/heartbeat"), amb.Api.Contar("/sync/pull"), amb.Api.Contar("/sync/push"));
        // Janela de medida (não é espera de condição): o laço não pode girar; o heartbeat espera o backoff (≥ 5 s).
        await Task.Delay(TimeSpan.FromSeconds(2), Ct);
        Assert.InRange(amb.Api.Contar("/sync/heartbeat") - heartbeats, 0, 1);
        Assert.Equal(pulls, amb.Api.Contar("/sync/pull"));
        Assert.Equal(pushes, amb.Api.Contar("/sync/push"));
        Assert.InRange(amb.Log.Linhas.Count(l => l.Contains("Token recusado", StringComparison.Ordinal)), 1, 4);
        Assert.True(ciclo.EsperaHeartbeat > TimeSpan.FromSeconds(2));
        Assert.True(ciclo.Rodando);

        // A nuvem volta a aceitar: o primeiro 200 do heartbeat libera push e pull, e o estado volta a ativo.
        amb.Api.HashesValidos.UnionWith(hashes);
        ciclo.SincronizarAgora();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Terminal == EstadoTerminalSync.Ativo, "ativo de novo");
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/pull") > pulls, "pull de volta");
    }

    [Fact]
    public async Task Retry_after_do_heartbeat_e_do_pull_nunca_e_encurtado()
    {
        using var amb = await AtivadoAsync();
        using var ciclo = amb.CriarCiclo();
        amb.Api.AoHeartbeat = _ => Indisponivel(120);
        amb.Api.AoPuxar = _ => Indisponivel(120);
        ciclo.Iniciar();
        // Sem o Retry-After, o backoff da 1ª falha seria de 5 a 10 s (18.3).
        await AmbienteSync.EsperarAsync(
            () => ciclo.EsperaHeartbeat > TimeSpan.FromSeconds(100) && ciclo.EsperaPull > TimeSpan.FromSeconds(100), "esperas do Retry-After");
        Assert.Equal((1, 1), (amb.Api.Contar("/sync/heartbeat"), amb.Api.Contar("/sync/pull")));
    }

    [Fact]
    public async Task Heartbeat_sem_resposta_estoura_em_10_s_e_nao_em_60_e_o_handshake_desiste_cedo()
    {
        using var amb = await AtivadoAsync();
        var tempos = new TemposLimiteSync
        {
            Heartbeat = TimeSpan.FromMilliseconds(300),
            Estado = TimeSpan.FromMilliseconds(300),
            Pull = TimeSpan.FromMilliseconds(300),
        };
        Assert.Equal((10, 10, 30, 60), ((int)TemposLimiteSync.Padrao.Heartbeat.TotalSeconds, (int)TemposLimiteSync.Padrao.Estado.TotalSeconds,
            (int)TemposLimiteSync.Padrao.Pull.TotalSeconds, (int)TemposLimiteSync.Padrao.Push.TotalSeconds));
        var cliente = new ClienteSyncHttp(amb.Http, amb.Maquina.ParaCliente(), amb.Relogio, amb.Cofre, () => AmbienteSync.Url, tempos: tempos);

        // Proxy que aceita a conexão e fica calado: o prazo da rota encerra, como o Timeout do HttpClient.
        amb.Api.RotasSemResposta.Add("/sync/estado");
        var cronometro = System.Diagnostics.Stopwatch.StartNew();
        using var ciclo = amb.CriarCiclo(cliente: cliente);
        Assert.Equal(DesfechoHandshake.SemConexao, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        Assert.True(cronometro.Elapsed < TimeSpan.FromSeconds(5), $"handshake levou {cronometro.Elapsed}");
        amb.Api.RotasSemResposta.Clear();

        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Online, "online");
        amb.Api.RotasSemResposta.UnionWith(["/sync/heartbeat", "/sync/pull"]);
        // 1 timeout de heartbeat já é offline (18.3).
        await AmbienteSync.EsperarAsync(() => !ciclo.Situacao.Online, "offline pelo timeout do heartbeat", 5_000);
        var erro = await Assert.ThrowsAsync<TaskCanceledException>(() => cliente.HeartbeatAsync(new Protocolo.RequisicaoHeartbeat(), Ct));
        Assert.IsType<TimeoutException>(erro.InnerException);
    }

    [Fact]
    public async Task Hardware_aprovado_durante_a_desativacao_libera_o_push_e_confirma()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        amb.Api.HardwareConfere = false;
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Terminal == EstadoTerminalSync.HardwareAlterado, "hardware alterado");

        // O gerente pede a desativação e aprova o hardware para as pendências subirem: o heartbeat passa a `desativando`.
        amb.Api.StatusTerminal = "desativando";
        amb.Api.HardwareConfere = true;
        await AmbienteSync.EsperarAsync(() => amb.Api.DesativacaoConfirmada, "desativando_confirmado", 20_000);
        Assert.Contains(amb.Api.EventosRecebidos.Values, e => e["tipo"]!.GetValue<string>() == "auditoria.registros");
    }

    [Fact]
    public async Task Desativando_com_venda_aberta_so_confirma_depois_que_ela_fecha()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            await db.EstadoOperacao.ExecuteUpdateAsync(s => s.SetProperty(o => o.VendaAtualId, Guid.CreateVersion7()), Ct);
        }

        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        amb.Api.StatusTerminal = "desativando";
        await AmbienteSync.EsperarAsync(() => amb.Api.EventosRecebidos.Count == 1, "auditoria enviada");
        var heartbeats = amb.Api.Contar("/sync/heartbeat");
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/heartbeat") >= heartbeats + 3, "heartbeats com o outbox vazio");
        Assert.False(amb.Api.DesativacaoConfirmada);
        Assert.Equal(("desativando", 0), (amb.Api.UltimoHeartbeat!["estado_local"]!.GetValue<string>(), amb.Api.UltimoHeartbeat!["eventos_pendentes"]!.GetValue<int>()));

        // A venda fecha (cancelada pelo operador): agora os números são os finais.
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            await db.EstadoOperacao.ExecuteUpdateAsync(s => s.SetProperty(o => o.VendaAtualId, (Guid?)null), Ct);
        }

        await AmbienteSync.EsperarAsync(() => amb.Api.DesativacaoConfirmada, "desativando_confirmado");
    }

    [Fact]
    public async Task Confirmacao_da_desativacao_trava_as_gravacoes_ate_a_resposta_e_sem_resposta_destrava()
    {
        // D22 (dono): entre montar o heartbeat com `desativando_confirmado` e receber o `revogado`, nada que suba é
        // gravado (logout, Ctrl+Alt+C, auditoria, evento): ficaria só no banco local, fora dos números finais.
        using var amb = await AtivadoAsync();
        using var liberar = new SemaphoreSlim(0);
        var confirmacoes = 0;
        var logoutGravado = 0;
        amb.Api.AoHeartbeat = envio =>
        {
            if (JsonNode.Parse(envio.Corpo!)!["estado_local"]!.GetValue<string>() != "desativando_confirmado")
            {
                return null;
            }

            // A primeira confirmação fica "na rede" até o teste soltar, e não volta resposta (queda no meio).
            if (Interlocked.Increment(ref confirmacoes) == 1)
            {
                Assert.True(liberar.Wait(TimeSpan.FromSeconds(30)));
                throw new HttpRequestException("rede caiu no meio da confirmação");
            }

            // Solta a trava, o ciclo volta a confirmar logo (o outbox ainda está vazio) e trava de novo. Até o teste
            // gravar, cada nova confirmação também cai: senão uma resposta `revogado` chegaria antes da gravação e
            // ela nunca subiria (corrida que o runner Windows, mais lento, pegou no CI).
            if (Volatile.Read(ref logoutGravado) == 0)
            {
                throw new HttpRequestException("rede ainda instável");
            }

            return null;
        };
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.Liberado, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        // O caixa abriu antes da desativação: fechá-lo continua permitido em desativação (SYNC 3.8), e é por esse
        // caminho (repositório → GravadorOutbox → eventos_saida) que a trava de evento se prova, não pela abertura, que o
        // repositório já recusa com o terminal em `desativando`.
        var caixa = new RepositorioCaixa(amb.Fabrica, amb.Relogio);
        var sessao = CaixaDaFixture.SessaoAberta();
        var abertura = CaixaDaFixture.Abertura();
        await caixa.AbrirAsync(sessao, abertura, Eventos.FabricaEventosCaixa.CaixaAberto(sessao, abertura, null, Guid.CreateVersion7()), Ct);
        ciclo.Iniciar();
        amb.Api.StatusTerminal = "desativando";
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.ConfirmandoDesativacao, "confirmação em voo");

        Assert.NotNull(amb.Escalar("select confirmando_desativacao_em from estado_conexao") as string);
        var (eventos, auditoria) = (amb.Contar("eventos_saida"), amb.Contar("log_auditoria_local"));
        var logout = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            amb.Terminal.RegistrarAuditoriaAsync("logout", Guid.CreateVersion7(), localizacao: "pdv.login", ct: Ct));
        Assert.Equal(TravaDesativacao.Mensagem, logout.Message);
        // O evento também não entra: o fechamento (permitido em desativação) é recusado pelo gatilho de eventos_saida, e a
        // sessão continua aberta (nada do fato comitou).
        var (fechamento, formas, _, fechadaEm) = CaixaDaFixture.Fechado(trocaTurno: true);
        var fechado = Eventos.FabricaEventosCaixa.CaixaFechado(fechamento, formas, null, fechadaEm, Guid.CreateVersion7());
        var recusaFechamento = await Assert.ThrowsAsync<RegraNegocioException>(() => caixa.FecharAsync(fechamento, formas, null, fechadaEm, fechado, Ct));
        Assert.Equal(TravaDesativacao.Mensagem, recusaFechamento.Message);
        Assert.Equal(sessao.Id, (await caixa.SessaoAbertaAsync(Ct))?.Id);
        Assert.Equal((eventos, auditoria), (amb.Contar("eventos_saida"), amb.Contar("log_auditoria_local")));

        // Sem resposta: destrava, a gravação feita agora entra no próximo lote e a desativação confirma com ela.
        liberar.Release();
        await AmbienteSync.EsperarAsync(() => !ciclo.Situacao.ConfirmandoDesativacao, "trava liberada");
        // A trava volta a cada nova tentativa de confirmar (que cai, acima): a gravação entra numa janela destravada.
        // Ela só passa com `confirmando_desativacao_em` nulo, o que prova que a trava solta sem resposta.
        await AmbienteSync.EsperarAsync(async () =>
        {
            try
            {
                await amb.Terminal.RegistrarAuditoriaAsync("logout", Guid.CreateVersion7(), localizacao: "pdv.login", ct: Ct);
                return true;
            }
            catch (RegraNegocioException e) when (e.Message == TravaDesativacao.Mensagem)
            {
                return false;
            }
        }, "logout gravado com a trava solta");
        Volatile.Write(ref logoutGravado, 1);
        await AmbienteSync.EsperarAsync(() => amb.Api.DesativacaoConfirmada, "desativando_confirmado", 20_000);
        await AmbienteSync.EsperarAsync(async () => (await amb.Terminal.ObterIdentidadeAsync(Ct))!.Status == StatusIdentidade.Revogado, "revogado local");
        Assert.Contains(amb.Api.EventosRecebidos.Values, e => e["payload"]!["registros"] is JsonArray registros && registros.Any(r => r!["acao"]!.GetValue<string>() == "logout"));
        Assert.True(confirmacoes >= 2);

        // Revogado: a trava fica (nada mais sobe deste terminal) e o banco local continua intacto.
        Assert.NotNull(amb.Escalar("select confirmando_desativacao_em from estado_conexao") as string);
        await Assert.ThrowsAsync<RegraNegocioException>(() => amb.Terminal.RegistrarAuditoriaAsync("logout", Guid.CreateVersion7(), ct: Ct));
    }

    [Fact]
    public async Task Trava_da_desativacao_que_sobrou_de_uma_queda_e_limpa_no_handshake()
    {
        // O app caiu esperando a resposta da confirmação: sem limpar, nem o login gravaria a auditoria na reabertura.
        using var amb = await AtivadoAsync();
        await amb.Terminal.AvancarStatusAsync(StatusIdentidade.Desativando, Ct);
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            await db.EstadoConexao.ExecuteUpdateAsync(s => s.SetProperty(c => c.ConfirmandoDesativacaoEm, DateTimeOffset.UtcNow), Ct);
        }

        await Assert.ThrowsAsync<RegraNegocioException>(() => LoginAsync(amb, "maria"));
        using var ciclo = amb.CriarCiclo();
        amb.Api.StatusTerminal = "desativando";
        Assert.Equal(DesfechoHandshake.Desativando, (await ciclo.HandshakeAsync(Ct)).Desfecho);

        Assert.Equal(DBNull.Value, amb.Escalar("select confirmando_desativacao_em from estado_conexao"));
        await LoginAsync(amb, "maria");
    }

    [Fact]
    public async Task Handshake_grava_as_versoes_anunciadas_pela_nuvem()
    {
        using var amb = await AtivadoAsync();
        amb.Api.VersoesSchema = new(StringComparer.Ordinal) { ["auditoria.registros"] = [1], ["caixa.aberto"] = [1, 2] };
        using var ciclo = amb.CriarCiclo();
        await ciclo.HandshakeAsync(Ct);

        var gravado = JsonNode.Parse((string)amb.Escalar("select versoes_schema_nuvem from estado_conexao")!)!;
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"auditoria.registros":[1],"caixa.aberto":[1,2]}"""), gravado));
    }

    [Fact]
    public async Task Fora_de_ordem_espera_o_backoff_e_o_laco_nao_reenvia_sem_parar()
    {
        using var amb = await AtivadoAsync();
        // A nuvem espera a sequência 1; o banco local só tem 2 e 3 (lacuna local, 8.6, ou nuvem restaurada, 22.5).
        var frente = await InserirEventoAsync(amb, 2);
        var seguinte = await InserirEventoAsync(amb, 3);
        var r = await amb.Envio.EnviarAsync(Ct);
        Assert.Equal((DesfechoPush.Enviado, 0), (r.Desfecho, r.Enviados));
        var eventos = await EventosAsync(amb);
        Assert.Equal(frente, eventos[0].Id);
        Assert.Equal(StatusEventoSaida.ErroTemporario, eventos[0].Status);
        Assert.True(eventos[0].ProximaTentativaEm > amb.Relogio.Agora);
        Assert.Equal((seguinte, StatusEventoSaida.Pendente, (Guid?)null), (eventos[1].Id, eventos[1].Status, eventos[1].LoteEnvioId));
        Assert.Equal(DesfechoPush.Aguardando, (await amb.Envio.EnviarAsync(Ct)).Desfecho);

        // No laço: um POST por backoff, nunca centenas por segundo.
        amb.Relogio.Agora = eventos[0].ProximaTentativaEm!.Value;
        var pushes = amb.Api.Contar("/sync/push");
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/push") > pushes, "reenvio do lote");
        await Task.Delay(TimeSpan.FromSeconds(1.5), Ct);
        Assert.InRange(amb.Api.Contar("/sync/push") - pushes, 1, 2);
    }

    [Fact]
    public async Task Duplicado_confirma_e_regressao_409_grava_os_resultados_parciais_e_para()
    {
        using var amb = await AtivadoAsync();
        var a = await InserirEventoAsync(amb, 1);
        var b = await InserirEventoAsync(amb, 2);
        // A nuvem já tem o evento 1 (resposta perdida) e uma sequência 2 de OUTRO evento (banco copiado para outra máquina).
        amb.Api.EventosRecebidos[a] = new JsonObject { ["sequencia"] = 1L, ["tipo"] = "auditoria.registros" };
        amb.Api.EventosRecebidos[Guid.CreateVersion7()] = new JsonObject { ["sequencia"] = 2L, ["tipo"] = "auditoria.registros" };

        var r = await amb.Envio.EnviarAsync(Ct);
        Assert.Equal(DesfechoPush.Regressao, r.Desfecho);
        Assert.Equal("REGRESSAO_DETECTADA", r.Erro!.Codigo);
        var eventos = await EventosAsync(amb);
        Assert.Equal((a, StatusEventoSaida.Confirmado, 2_001L), (eventos[0].Id, eventos[0].Status, eventos[0].VersaoNuvem));
        Assert.Equal((b, StatusEventoSaida.Pendente, (Guid?)null), (eventos[1].Id, eventos[1].Status, eventos[1].LoteEnvioId));

        // No laço (22.1, C17): a regressão para o push e o handshake refeito já reidrata a partir da sequência recusada; o
        // evento do caixa que a nuvem não tem vai para depois da última dela e sobe confirmado, sem duplicar o primeiro.
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => amb.Api.ConsultasRecuperar.Count > 0, "reidratação");
        Assert.Equal(1L, amb.Api.ConsultasRecuperar[0]);
        await AmbienteSync.EsperarAsync(() => amb.Api.EventosRecebidos.ContainsKey(b), "evento do caixa enviado depois da reidratação");
        Assert.Equal(3L, amb.Api.EventosRecebidos[b]["sequencia"]!.GetValue<long>());
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).All(e => e.Status == StatusEventoSaida.Confirmado), "tudo confirmado");
        Assert.Equal([(a, 1L), (b, 3L)], (await EventosAsync(amb)).Select(e => (e.Id, e.SequenciaTerminal)));
        Assert.Equal(EstadoTerminalSync.Ativo, ciclo.Situacao.Terminal);
    }

    [Fact]
    public async Task Retry_after_do_push_nunca_e_encurtado()
    {
        using var amb = await AtivadoAsync();
        await InserirEventoAsync(amb, 1);
        amb.Api.AoEnviar = _ => Indisponivel(120);
        var r = await amb.Envio.EnviarAsync(Ct);
        Assert.Equal(DesfechoPush.Falhou, r.Desfecho);
        var evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal(StatusEventoSaida.ErroTemporario, evento.Status);
        // O backoff da 1ª tentativa seria de 5 s; o Retry-After de 120 s vale.
        Assert.True(evento.ProximaTentativaEm >= amb.Relogio.Agora.AddSeconds(120), $"{evento.ProximaTentativaEm:O}");
    }

    [Fact]
    public async Task Evento_resolvido_no_erp_confirma_o_rejeitado_e_vai_no_ack()
    {
        using var amb = await AtivadoAsync();
        var rejeitado = await InserirEventoAsync(amb, 1, StatusEventoSaida.Rejeitado);
        amb.Api.EventosRecebidos[rejeitado] = new JsonObject { ["sequencia"] = 1L, ["tipo"] = "auditoria.registros" };
        amb.Api.EventosResolvidos.Add(new JsonObject
        {
            ["evento_id"] = rejeitado.ToString("D"),
            ["status"] = "aplicado",
            ["versao_nuvem"] = 3_001L,
            ["versao_nuvem_fim"] = 3_002L,
            ["resultado"] = new JsonObject(),
        });
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        // O ack sai no heartbeat seguinte (1 s): a nuvem tira o evento da lista.
        await AmbienteSync.EsperarAsync(() => amb.Api.EventosResolvidos.Count == 0, "ack do evento resolvido");
        var evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal((StatusEventoSaida.Confirmado, 3_001L, 3_002L), (evento.Status, evento.VersaoNuvem, evento.VersaoNuvemFim));
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Rejeitados == 0, "sem rejeitados no indicador");
    }

    [Fact]
    public async Task Eventos_status_resolve_os_rejeitados_sem_ack_ignora_erro_e_retido_e_repete_no_intervalo()
    {
        using var amb = await AtivadoAsync();
        var aplicado = await InserirEventoAsync(amb, 1, StatusEventoSaida.Rejeitado);
        var descartado = await InserirEventoAsync(amb, 2, StatusEventoSaida.Rejeitado);
        var retido = await InserirEventoAsync(amb, 3, StatusEventoSaida.Rejeitado);
        var jaDescartado = await InserirEventoAsync(amb, 4, StatusEventoSaida.Rejeitado);
        await InserirEventoAsync(amb, 5, StatusEventoSaida.Confirmado);
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            // Decisão final que já chegou (heartbeat): fica fora da consulta.
            await db.EventosSaida.Where(e => e.Id == jaDescartado)
                .ExecuteUpdateAsync(u => u.SetProperty(e => e.Resultado, "{\"descartado\":true,\"justificativa\":\"Teste do caixa\"}"), Ct);
            await db.EventosSaida.Where(e => e.Id == retido)
                .ExecuteUpdateAsync(u => u.SetProperty(e => e.UltimoErro, "DEPENDENCIA_PENDENTE: Aguardando a abertura."), Ct);
        }

        // O heartbeat não traz nada (a entrega dele se perdeu): só a rede de segurança resolve.
        amb.Api.SituacaoNaNuvem[aplicado] = new JsonObject
        {
            ["evento_id"] = aplicado.ToString("D"),
            ["status"] = "aplicado",
            ["versao_nuvem"] = 4_001L,
            ["versao_nuvem_fim"] = 4_003L,
            ["resultado"] = new JsonObject(),
        };
        amb.Api.SituacaoNaNuvem[descartado] = new JsonObject
        {
            ["evento_id"] = descartado.ToString("D"),
            ["status"] = "descartado",
            ["resultado"] = new JsonObject { ["descartado"] = true, ["justificativa"] = "Venda de teste lançada por engano" },
        };
        amb.Api.SituacaoNaNuvem[retido] = new JsonObject
        {
            ["evento_id"] = retido.ToString("D"),
            ["status"] = "erro",
            ["resultado"] = null,
            ["erro"] = new JsonObject { ["codigo"] = "DEPENDENCIA_DESCARTADA", ["mensagem"] = "A abertura foi descartada." },
        };

        using var ciclo = amb.CriarCiclo(new OpcoesSincronizacao
        {
            Heartbeat = TimeSpan.FromMilliseconds(200),
            Pull = TimeSpan.FromMilliseconds(200),
            PushPendente = TimeSpan.FromMilliseconds(200),
            Debounce = TimeSpan.FromMilliseconds(20),
            ConsultaEventosStatus = TimeSpan.FromMilliseconds(300),
        });
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).Single(e => e.Id == aplicado).Status == StatusEventoSaida.Confirmado,
            "aplicado pela consulta de eventos-status");
        // O motivo do retido é gravado logo depois das decisões da mesma fatia.
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).Single(e => e.Id == retido).UltimoErro!.StartsWith("DEPENDENCIA_DESCARTADA", StringComparison.Ordinal),
            "motivo atual do retido");
        var eventos = (await EventosAsync(amb)).ToDictionary(e => e.Id);
        Assert.Equal((4_001L, 4_003L), (eventos[aplicado].VersaoNuvem, eventos[aplicado].VersaoNuvemFim));
        Assert.Equal(StatusEventoSaida.Rejeitado, eventos[descartado].Status);
        Assert.True(ConsultasVendaLocal.Descartado(eventos[descartado].Resultado));
        // erro/retido: a situação não muda (a decisão continua no ERP), mas o motivo passa a ser o atual da nuvem (bloco G7:
        // o vermelho da aba 4 da Central diz por que a nuvem recusa agora, pedido do dono de 04/11/2026).
        Assert.Equal((StatusEventoSaida.Rejeitado, "DEPENDENCIA_DESCARTADA: A abertura foi descartada."), (eventos[retido].Status, eventos[retido].UltimoErro));
        Assert.Null(eventos[retido].Resultado);
        // A ocorrência de cada decisão do ERP no log_local, ligada ao evento (o detalhe da venda na aba 4 a mostra).
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            var ocorrencias = await db.LogLocal.AsNoTracking().Where(l => l.Origem == EnvioPush.OrigemLog).ToListAsync(Ct);
            Assert.Contains(ocorrencias, l => l.Nivel == "info" && l.Mensagem.StartsWith("O ERP reprocessou", StringComparison.Ordinal)
                                              && l.Detalhes!.Contains(aplicado.ToString(), StringComparison.Ordinal));
            Assert.Contains(ocorrencias, l => l.Mensagem.StartsWith("O ERP descartou", StringComparison.Ordinal)
                                              && l.Detalhes!.Contains(descartado.ToString(), StringComparison.Ordinal));
            Assert.DoesNotContain(ocorrencias, l => l.Detalhes!.Contains(jaDescartado.ToString(), StringComparison.Ordinal));
        }
        // Só os rejeitados, na ordem da sequência, sem o já descartado nem o confirmado.
        Assert.Equal([aplicado, descartado, retido], amb.Api.ConsultasEventosStatus[0]);

        // No intervalo seguinte sai de novo, só com o que continua sem decisão.
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/eventos-status") >= 2, "segunda consulta no intervalo");
        Assert.Equal([retido], amb.Api.ConsultasEventosStatus[1]);
        // Nenhum ack: quem confirma a entrega na nuvem é o heartbeat que a trouxer.
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/heartbeat") >= 2, "heartbeats");
        Assert.All(amb.Api.Envios.Where(e => e.Rota.EndsWith("/sync/heartbeat", StringComparison.Ordinal)).ToList(),
            e => Assert.DoesNotContain(aplicado.ToString("D"), e.Corpo!, StringComparison.Ordinal));
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Rejeitados == 3, "aplicado sai da quarentena no indicador");
    }

    [Fact]
    public async Task Eventos_status_nao_traz_o_erro_interno_cru_da_nuvem_para_o_caixa()
    {
        using var amb = await AtivadoAsync();
        var interno = await InserirEventoAsync(amb, 1, StatusEventoSaida.Rejeitado);
        var regra = await InserirEventoAsync(amb, 2, StatusEventoSaida.Rejeitado);
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            // O que o push gravou: o texto genérico que a nuvem devolve ao terminal no ERRO_INTERNO.
            await db.EventosSaida.Where(e => e.Id == interno)
                .ExecuteUpdateAsync(u => u.SetProperty(e => e.UltimoErro, "PRODUTO_INEXISTENTE: antes do reprocessamento."), Ct);
        }

        // A nuvem guarda (e o eventos-status devolve) a mensagem crua da falha: tabela, coluna e o valor do campo.
        const string Tecnica = "null value in column \"produto_id\" of relation \"itens_venda\" violates not-null constraint; valor 123.456.789-09";
        amb.Api.SituacaoNaNuvem[interno] = new JsonObject
        {
            ["evento_id"] = interno.ToString("D"),
            ["status"] = "erro",
            ["resultado"] = null,
            ["erro"] = new JsonObject { ["codigo"] = "ERRO_INTERNO", ["mensagem"] = Tecnica },
        };
        amb.Api.SituacaoNaNuvem[regra] = new JsonObject
        {
            ["evento_id"] = regra.ToString("D"),
            ["status"] = "erro",
            ["resultado"] = null,
            ["erro"] = new JsonObject { ["codigo"] = "PRODUTO_INEXISTENTE", ["mensagem"] = "O produto 123 não existe na nuvem." },
        };

        using var ciclo = amb.CriarCiclo(new OpcoesSincronizacao
        {
            Heartbeat = TimeSpan.FromMilliseconds(200),
            Pull = TimeSpan.FromMilliseconds(200),
            PushPendente = TimeSpan.FromMilliseconds(200),
            Debounce = TimeSpan.FromMilliseconds(20),
            ConsultaEventosStatus = TimeSpan.FromMilliseconds(300),
        });
        ciclo.Iniciar();
        // A segunda consulta só sai depois da primeira inteira (com os motivos gravados).
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/eventos-status") >= 2, "duas consultas de eventos-status");

        var eventos = (await EventosAsync(amb)).ToDictionary(e => e.Id);
        // A recusa de regra traz o motivo atual; a falha interna, só o texto genérico do push (nada técnico no banco local).
        Assert.Equal("PRODUTO_INEXISTENTE: O produto 123 não existe na nuvem.", eventos[regra].UltimoErro);
        Assert.Equal((StatusEventoSaida.Rejeitado, ServicoSincronizacaoHttp.MotivoErroInterno), (eventos[interno].Status, eventos[interno].UltimoErro));
        Assert.DoesNotContain("itens_venda", eventos[interno].UltimoErro!, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Rejeitado_por_evento_divergente_fica_em_quarentena_fora_da_consulta_e_do_heartbeat()
    {
        using var amb = await AtivadoAsync();
        var divergente = await InserirEventoAsync(amb, 1, StatusEventoSaida.Rejeitado);
        var comErro = await InserirEventoAsync(amb, 2, StatusEventoSaida.Rejeitado);
        const string erroDivergente = "EVENTO_DIVERGENTE: Mesmo evento_id com conteúdo diferente.";
        await using (var db = amb.Fabrica.CreateDbContext())
        {
            await db.EventosSaida.Where(e => e.Id == divergente)
                .ExecuteUpdateAsync(u => u.SetProperty(e => e.UltimoErro, erroDivergente), Ct);
        }

        // A linha da nuvem com esse evento_id é a do envio original (aplicado): a situação dela não vale para o local.
        var original = new JsonObject
        {
            ["evento_id"] = divergente.ToString("D"),
            ["status"] = "aplicado",
            ["versao_nuvem"] = 5_001L,
            ["versao_nuvem_fim"] = 5_002L,
            ["resultado"] = new JsonObject(),
        };
        amb.Api.SituacaoNaNuvem[divergente] = original;
        amb.Api.EventosResolvidos.Add((JsonObject)original.DeepClone());
        amb.Api.SituacaoNaNuvem[comErro] = new JsonObject
        {
            ["evento_id"] = comErro.ToString("D"),
            ["status"] = "aplicado",
            ["versao_nuvem"] = 5_003L,
            ["versao_nuvem_fim"] = 5_003L,
            ["resultado"] = new JsonObject(),
        };

        using var ciclo = amb.CriarCiclo(new OpcoesSincronizacao
        {
            Heartbeat = TimeSpan.FromMilliseconds(200),
            Pull = TimeSpan.FromMilliseconds(200),
            PushPendente = TimeSpan.FromMilliseconds(200),
            Debounce = TimeSpan.FromMilliseconds(20),
            ConsultaEventosStatus = TimeSpan.FromMilliseconds(300),
        });
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).Single(e => e.Id == comErro).Status == StatusEventoSaida.Confirmado,
            "o outro rejeitado resolvido pela consulta");
        // O heartbeat entrega a resolução do original e recebe o ack (a nuvem para de mandar), sem mudar o evento local.
        await AmbienteSync.EsperarAsync(() => amb.Api.EventosResolvidos.Count == 0, "ack da resolução do original");
        Assert.Equal([comErro], amb.Api.ConsultasEventosStatus[0]);
        var evento = (await EventosAsync(amb)).Single(e => e.Id == divergente);
        Assert.Equal((StatusEventoSaida.Rejeitado, erroDivergente, (long?)null), (evento.Status, evento.UltimoErro, evento.VersaoNuvem));
        Assert.Null(evento.ConfirmadoEm);
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Rejeitados == 1, "o divergente segue em quarentena no indicador");
    }

    [Fact]
    public async Task Eventos_status_so_sai_com_rejeitados_e_falha_espera_o_backoff_sem_parar_o_ciclo()
    {
        using var amb = await AtivadoAsync();
        var opcoes = new OpcoesSincronizacao
        {
            Heartbeat = TimeSpan.FromMilliseconds(100),
            Pull = TimeSpan.FromMilliseconds(100),
            PushPendente = TimeSpan.FromMilliseconds(100),
            Debounce = TimeSpan.FromMilliseconds(20),
            ConsultaEventosStatus = TimeSpan.FromMilliseconds(100),
        };
        using (var ciclo = amb.CriarCiclo(opcoes))
        {
            ciclo.Iniciar();
            await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/heartbeat") >= 4, "heartbeats sem rejeitados");
            Assert.Equal(0, amb.Api.Contar("/sync/eventos-status"));
        }

        await InserirEventoAsync(amb, 1, StatusEventoSaida.Rejeitado);
        amb.Api.AoEventosStatus = _ => Indisponivel(60);
        using var segundo = amb.CriarCiclo(opcoes);
        segundo.Iniciar();
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/eventos-status") >= 1, "consulta com rejeitado");
        var heartbeats = amb.Api.Contar("/sync/heartbeat");
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/heartbeat") >= heartbeats + 3, "o ciclo segue");
        // 503 com Retry-After de 60 s: a consulta não se repete a cada volta do laço.
        Assert.Equal(1, amb.Api.Contar("/sync/eventos-status"));
        Assert.True(segundo.Situacao.Online);
    }

    [Fact]
    public async Task Renovar_token_no_heartbeat_troca_o_token_e_os_heartbeats_seguintes_usam_o_novo()
    {
        using var amb = await AtivadoAsync();
        var antigo = ApiFalsa.HashDoSegredo(amb.Api.TokensEmitidos[^1]);
        amb.Api.PedirRenovacao = true;
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => !amb.Api.PedirRenovacao, "renovação aplicada");
        await AmbienteSync.EsperarAsync(
            () => amb.Api.UltimoEnvio("/sync/heartbeat") is { Token: { } t } && ApiFalsa.HashDoSegredo(t) != antigo, "heartbeat com o token novo");
        Assert.Equal(2, amb.Api.HashesValidos.Count);
        // Uma renovação lógica: o pendente vai primeiro (401, a nuvem ainda não o conhece), depois o atual, mesmo id.
        lock (amb.Api.Envios)
        {
            Assert.Single(amb.Api.Envios.Where(e => e.Rota.EndsWith("/sync/token/renovar", StringComparison.Ordinal)).Select(e => e.RequisicaoId).Distinct());
        }
    }

    [Fact]
    public async Task Handshake_sem_conexao_e_refeito_pelo_laco_quando_a_rede_volta()
    {
        using var amb = await AtivadoAsync();
        using var ciclo = amb.CriarCiclo();
        amb.Api.ForaDoAr = true;
        Assert.Equal(DesfechoHandshake.SemConexao, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        ciclo.Iniciar();
        // Enquanto estava fora, o suporte não recuperou nada: a nuvem já tem a sequência 7 (banco local restaurado).
        amb.Api.EventosRecebidos[Guid.CreateVersion7()] = new JsonObject { ["sequencia"] = 7L, ["tipo"] = "auditoria.registros" };
        amb.Api.ForaDoAr = false;
        ciclo.SincronizarAgora();
        // O handshake refeito vê a regressão e reidrata (22.1, C17) antes de qualquer push.
        await AmbienteSync.EsperarAsync(() => amb.Api.ConsultasRecuperar.Count > 0, "handshake refeito com a reidratação");
        await AmbienteSync.EsperarAsync(async () => await SequenciaEventoAsync(amb) == 7L, "sequência local na da nuvem");
        Assert.Equal(2, amb.Api.Contar("/sync/estado"));
        Assert.Equal(0, amb.Api.Contar("/sync/push"));
    }

    [Fact]
    public async Task Offline_por_mais_de_uma_hora_refaz_o_handshake_no_proximo_contato()
    {
        using var amb = await AtivadoAsync();
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao.Online, "online");
        Assert.Equal(0, amb.Api.Contar("/sync/estado"));

        amb.Api.ForaDoAr = true;
        await AmbienteSync.EsperarAsync(() => !ciclo.Situacao.Online, "offline");
        amb.Relogio.Agora += TimeSpan.FromHours(2);
        amb.Api.ForaDoAr = false;
        ciclo.SincronizarAgora();
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/estado") == 1, "handshake depois de 2 h offline");
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao is { Online: true, Terminal: EstadoTerminalSync.Ativo }, "online e ativo");
    }

    [Fact]
    public async Task Ao_voltar_online_o_backoff_do_outbox_zera_e_o_mesmo_lote_sobe_na_hora()
    {
        // SYNC 18.3 (Fase 1C, C13): o backoff de transporte da frente cresce durante a queda; o relógio falso só anda
        // quando o teste manda, então sem o zerar na reconexão o lote ficaria esperando o `proxima_tentativa_em`.
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));
        amb.Api.ForaDoAr = true;
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(async () => ciclo.Situacao is { Online: false, OfflineDesde: not null }
            && (await EventosAsync(amb)).Single() is { Status: StatusEventoSaida.ErroTemporario, ProximaTentativaEm: not null }, "offline com o lote em backoff");
        var primeira = Assert.Single(await EventosAsync(amb));
        Assert.Equal(1, primeira.Tentativas);
        Assert.StartsWith(EnvioPush.PrefixoTransporte, primeira.UltimoErro, StringComparison.Ordinal);
        // Mais uma falha offline: o relógio passa da espera, o push tenta de novo e o expoente cresce (5 s → 10 s).
        amb.Relogio.Agora = primeira.ProximaTentativaEm!.Value;
        ciclo.SincronizarAgora();
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).Single() is { Status: StatusEventoSaida.ErroTemporario, Tentativas: 2 },
            "segunda tentativa offline");
        var emBackoff = Assert.Single(await EventosAsync(amb));
        Assert.Equal(amb.Relogio.Agora + TimeSpan.FromSeconds(10), emBackoff.ProximaTentativaEm);

        amb.Api.ForaDoAr = false;
        ciclo.SincronizarAgora();
        await AmbienteSync.EsperarAsync(async () => (await EventosAsync(amb)).Single().Status == StatusEventoSaida.Confirmado,
            "lote confirmado logo depois da reconexão");
        var confirmado = Assert.Single(await EventosAsync(amb));
        Assert.Equal(emBackoff.LoteEnvioId, confirmado.LoteEnvioId);
        Assert.Null(confirmado.ProximaTentativaEm);
        // As tentativas recomeçaram na reconexão: a que confirmou é a primeira depois da volta.
        Assert.Equal(1, confirmado.Tentativas);
        Assert.True(ciclo.Situacao.Online);
    }

    /// <summary>Offline com a frente do outbox (a auditoria do login) em backoff de transporte; devolve o evento.</summary>
    private static async Task<EventoSaida> OfflineComOLoteEmBackoffAsync(AmbienteSync amb, ServicoSincronizacaoHttp ciclo)
    {
        await LoginAsync(amb, "maria");
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));
        amb.Api.ForaDoAr = true;
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(async () => ciclo.Situacao is { Online: false, OfflineDesde: not null }
            && (await EventosAsync(amb)).Single() is { Status: StatusEventoSaida.ErroTemporario, ProximaTentativaEm: not null }, "offline com o lote em backoff");
        return Assert.Single(await EventosAsync(amb));
    }

    [Fact]
    public async Task Retry_after_gravado_pelo_push_vale_mesmo_quando_a_volta_vem_de_um_503_do_heartbeat()
    {
        // SYNC 18.3 ("429 e 503: usa Retry-After, nunca menos que o informado"; C13): a rede volta com a API em
        // manutenção. O push recebe 503 com Retry-After de 300 s e o PDV segue offline; o heartbeat da mesma volta do laço
        // recebe outro 503 e marca online. Zerar o backoff ali reenviaria o lote na hora.
        using var amb = await AtivadoAsync();
        using var ciclo = amb.CriarCiclo();
        var emBackoff = await OfflineComOLoteEmBackoffAsync(amb, ciclo);
        amb.Api.AoEnviar = _ => Indisponivel(300);
        amb.Api.AoHeartbeat = _ => Indisponivel(300);
        amb.Api.AoPuxar = _ => Indisponivel(300);
        amb.Api.ForaDoAr = false;
        amb.Relogio.Agora = emBackoff.ProximaTentativaEm!.Value;
        var pushes = amb.Api.Contar("/sync/push");
        ciclo.SincronizarAgora();
        await AmbienteSync.EsperarAsync(() => Task.FromResult(ciclo.Situacao.Online), "online pelo 503 do heartbeat");
        await Task.Delay(TimeSpan.FromSeconds(1), Ct);

        Assert.Equal(pushes + 1, amb.Api.Contar("/sync/push"));
        var evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal(StatusEventoSaida.ErroTemporario, evento.Status);
        Assert.DoesNotContain(EnvioPush.PrefixoTransporte, evento.UltimoErro, StringComparison.Ordinal);
        Assert.True(evento.ProximaTentativaEm >= amb.Relogio.Agora.AddSeconds(300), $"{evento.ProximaTentativaEm:O}");
    }

    [Fact]
    public async Task Erro_temporario_devolvido_pela_nuvem_na_volta_espera_o_backoff_sem_as_tentativas_da_queda()
    {
        // O push é o primeiro contato depois da queda e a nuvem devolve `erro_temporario` por evento: esse backoff é da
        // nuvem e não é zerado ao marcar online (sem reenvio no Debounce), e as tentativas que só falharam no transporte
        // não contam no expoente (5 s da 1ª, não os 10 s da 2ª).
        using var amb = await AtivadoAsync();
        using var ciclo = amb.CriarCiclo();
        var emBackoff = await OfflineComOLoteEmBackoffAsync(amb, ciclo);
        amb.Api.StatusPorTipo["auditoria.registros"] = "erro_temporario";
        amb.Api.ForaDoAr = false;
        amb.Relogio.Agora = emBackoff.ProximaTentativaEm!.Value;
        var pushes = amb.Api.Contar("/sync/push");
        ciclo.SincronizarAgora();
        await AmbienteSync.EsperarAsync(() => Task.FromResult(ciclo.Situacao.Online), "online pelo push");
        await Task.Delay(TimeSpan.FromSeconds(1), Ct);

        Assert.Equal(pushes + 1, amb.Api.Contar("/sync/push"));
        var evento = Assert.Single(await EventosAsync(amb));
        Assert.Equal((StatusEventoSaida.ErroTemporario, 1), (evento.Status, evento.Tentativas));
        Assert.StartsWith("SCHEMA_DESCONHECIDO", evento.UltimoErro, StringComparison.Ordinal);
        Assert.Equal(amb.Relogio.Agora + TimeSpan.FromSeconds(5), evento.ProximaTentativaEm);
    }

    /// <summary>Tamanho de <c>comandos_resultado</c> de cada heartbeat recebido, na ordem.</summary>
    private static List<int> AcksPorHeartbeat(AmbienteSync amb)
    {
        lock (amb.Api.Envios)
        {
            return [.. amb.Api.Envios.Where(e => e.Rota.EndsWith("/sync/heartbeat", StringComparison.Ordinal))
                .Select(e => JsonNode.Parse(e.Corpo!)!["comandos_resultado"]?.AsArray().Count ?? 0)];
        }
    }

    [Fact]
    public async Task Mais_de_100_comandos_sobem_os_acks_em_fatias_de_100_e_todos_saem_da_fila()
    {
        using var amb = await AtivadoAsync();
        var mensagens = 0;
        amb.Comandos.MensagemRecebida += (_, _) => Interlocked.Increment(ref mensagens);
        // O caixa ficou offline no fim de semana e o ERP mandou 150 mensagens: a nuvem entrega todas de uma vez.
        var ids = Enumerable.Range(1, 150).Select(i => amb.Api.Comandar(TiposComando.Mensagem, new JsonObject { ["texto"] = $"Aviso {i}" })).ToList();
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => amb.Api.Comandos.Count == 0, "todos os comandos com ack", 30_000);

        // Nenhum heartbeat passou do máximo do contrato (a API recusaria com 400 para sempre); o resto foi no seguinte.
        Assert.Equal(0, amb.Api.HeartbeatsRecusados);
        var acks = AcksPorHeartbeat(amb);
        Assert.All(acks, n => Assert.InRange(n, 0, ServicoSincronizacaoHttp.MaximoAcksComandos));
        Assert.Contains(ServicoSincronizacaoHttp.MaximoAcksComandos, acks);
        Assert.All(ids, id => Assert.Equal("executado", amb.Api.AcksComandos[id]));
        Assert.Equal(150, Volatile.Read(ref mensagens));
        Assert.Equal(150L, amb.Contar("comandos_recebidos"));
    }

    [Fact]
    public async Task Heartbeat_recusado_como_invalido_descarta_os_acks_e_o_dedupe_os_refaz_sem_repetir_o_comando()
    {
        using var amb = await AtivadoAsync();
        var mensagens = 0;
        amb.Comandos.MensagemRecebida += (_, _) => Interlocked.Increment(ref mensagens);
        var id = amb.Api.Comandar(TiposComando.Mensagem, new JsonObject { ["texto"] = "Inventário amanhã às 7h" });
        // O primeiro heartbeat com o ack volta 400 (corpo que a API não aceita): repetir o mesmo corpo falharia sempre.
        var recusados = 0;
        amb.Api.AoHeartbeat = e => JsonNode.Parse(e.Corpo!)!["comandos_resultado"]!.AsArray().Count > 0 && Interlocked.Increment(ref recusados) == 1
            ? ApiFalsa.Erro(HttpStatusCode.BadRequest, "REQUISICAO_INVALIDA", "Requisição inválida.")
            : null;
        using var ciclo = amb.CriarCiclo();
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => Volatile.Read(ref recusados) == 1 && ciclo.EsperaHeartbeat > TimeSpan.FromSeconds(2), "heartbeat recusado, em backoff");
        ciclo.SincronizarAgora();
        await AmbienteSync.EsperarAsync(() => amb.Api.Comandos.Count == 0, "ack aceito depois da recusa");

        // Depois da recusa o heartbeat foi sem o ack; a nuvem entregou o comando de novo e o dedupe refez o mesmo ack.
        var acks = AcksPorHeartbeat(amb);
        var recusa = acks.IndexOf(1);
        Assert.Equal(0, acks[recusa + 1]);
        Assert.Equal("executado", amb.Api.AcksComandos[id]);
        Assert.Equal(1, Volatile.Read(ref mensagens));
        Assert.Equal(1L, amb.Contar("comandos_recebidos"));
    }

    [Fact]
    public async Task Handshake_com_503_espera_o_retry_after_e_o_laco_nao_o_repete_a_cada_volta()
    {
        using var amb = await AtivadoAsync();
        amb.Api.AoEstado = _ => Indisponivel(120);
        using var ciclo = amb.CriarCiclo();
        Assert.Equal(DesfechoHandshake.SemConexao, (await ciclo.HandshakeAsync(Ct)).Desfecho);
        // Sem o Retry-After, o backoff da 1ª falha seria de 5 a 10 s (18.3).
        Assert.True(ciclo.EsperaHandshake > TimeSpan.FromSeconds(100), $"{ciclo.EsperaHandshake}");

        // Heartbeat e pull respondem: o laço acorda várias vezes, mas o handshake só sai depois do prazo pedido.
        ciclo.Iniciar();
        var heartbeats = amb.Api.Contar("/sync/heartbeat");
        await AmbienteSync.EsperarAsync(() => amb.Api.Contar("/sync/heartbeat") >= heartbeats + 3, "heartbeats com a nuvem respondendo");
        Assert.Equal(1, amb.Api.Contar("/sync/estado"));
        Assert.True(ciclo.Situacao.Online);
    }

    [Fact]
    public async Task Empresa_suspensa_bloqueia_com_a_mensagem_propria_mantem_o_push_e_libera_quando_volta()
    {
        using var amb = await AtivadoAsync();
        await LoginAsync(amb, "maria");
        Assert.True(await amb.Outbox.GerarAuditoriaAsync(forcar: true, ct: Ct));

        // Cada 403 da empresa ou da loja tem desfecho e texto próprios, nunca "sem conexão".
        foreach (var (codigo, mensagem) in new[]
                 {
                     ("EMPRESA_CANCELADA", MensagensBloqueioNuvem.EmpresaCancelada),
                     ("PDV_DESABILITADO", MensagensBloqueioNuvem.PdvDesabilitado),
                     ("LOJA_INATIVA", MensagensBloqueioNuvem.LojaInativa),
                 })
        {
            amb.Api.EmpresaBloqueada = codigo;
            using var avulso = amb.CriarCiclo();
            var r = await avulso.HandshakeAsync(Ct);
            Assert.Equal((DesfechoHandshake.Suspenso, mensagem), (r.Desfecho, r.Mensagem));
            Assert.Equal((EstadoTerminalSync.Suspenso, codigo), (avulso.Situacao.Terminal, avulso.Situacao.BloqueioNuvem));
        }

        amb.Api.EmpresaBloqueada = "EMPRESA_SUSPENSA";
        using var ciclo = amb.CriarCiclo();
        var handshake = await ciclo.HandshakeAsync(Ct);
        Assert.Equal((DesfechoHandshake.Suspenso, MensagensBloqueioNuvem.EmpresaSuspensa), (handshake.Desfecho, handshake.Mensagem));
        Assert.Equal(("■ Empresa suspensa — novas vendas bloqueadas", NivelIndicador.Erro), IndicadorSync.Calcular(ciclo.Situacao, DateTimeOffset.UtcNow));
        Assert.Equal(MensagensBloqueioNuvem.EmpresaSuspensa, ciclo.Situacao.Erro);
        Assert.True(ciclo.EsperaHandshake > TimeSpan.FromSeconds(4), $"{ciclo.EsperaHandshake}");

        // Com a empresa suspensa a nuvem ainda aceita o push: a auditoria sobe. Estado, pull e heartbeat seguem com backoff.
        var estados = amb.Api.Contar("/sync/estado");
        ciclo.Iniciar();
        await AmbienteSync.EsperarAsync(() => amb.Api.EventosRecebidos.Count == 1, "push aceito com a empresa suspensa");
        // Janela de medida (não é espera de condição): o handshake espera o backoff dele, não sai a cada volta do laço.
        await Task.Delay(TimeSpan.FromSeconds(1.5), Ct);
        Assert.Equal(estados, amb.Api.Contar("/sync/estado"));
        Assert.Equal((EstadoTerminalSync.Suspenso, true), (ciclo.Situacao.Terminal, ciclo.Situacao.Online));

        // Reativada: a primeira resposta 200 libera as vendas.
        amb.Api.EmpresaBloqueada = null;
        ciclo.SincronizarAgora();
        await AmbienteSync.EsperarAsync(() => ciclo.Situacao is { Terminal: EstadoTerminalSync.Ativo, BloqueioNuvem: null }, "liberado");
    }
}
