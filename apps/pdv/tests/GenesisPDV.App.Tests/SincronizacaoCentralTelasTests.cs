using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.VisualTree;
using CommunityToolkit.Mvvm.Input;
using GenesisPDV.App.Servicos;
using GenesisPDV.App.Servicos.Diagnostico;
using GenesisPDV.App.ViewModels;
using GenesisPDV.App.ViewModels.Central;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Push;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace GenesisPDV.App.Tests;

/// <summary>
/// Aba 4 Sincronização da Central do PDV (bloco G7; README › decisão 72; o pedido do dono de 04/11/2026, "vendas a
/// copiar"): o "⇅ N" da venda abre a lista das vendas não confirmadas pela nuvem — a recusada em vermelho com o motivo, a
/// pendente em amarelo —; o detalhe com os itens, os pagamentos, cada envio e as ocorrências ligadas, sem o payload; o
/// "Reenviar agora" que só força o ciclo de envio (nada se duplica); a venda que o ERP resolve fica verde sozinha e sai na
/// leitura seguinte; o caixa não confirmado, todos os registros e os comandos; nenhuma ação de descartar ou reprocessar; a
/// lacuna com <c>pdv.config.fiscal</c> na hora; o F11 › S com o atalho; e a liberação que acaba (a aba esvazia).
/// </summary>
public class SincronizacaoCentralTelasTests
{
    private static readonly Guid Carlos = Guid.Parse("019a0003-0000-7000-8000-000000000002");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static PdvDbContext Banco(AmbienteUi pdv) => pdv.Servicos.GetRequiredService<FabricaPdvDb>().CreateDbContext();

    /// <summary>
    /// O sync real do terminal de demonstração, como se tivesse nuvem (o "Reenviar agora" não diz "demonstração"), com os
    /// pendentes e a lacuna ligáveis pelo teste e o "Sincronizar agora" contado (nada vai à rede).
    /// </summary>
    private sealed class SincronizacaoEspia(IServicoSincronizacao real) : IServicoSincronizacao
    {
        public int Reenvios { get; private set; }

        public int Pendentes { get; set; }

        public LacunaEventos? Lacuna { get; set; }

        /// <summary>O último erro da conexão (401, DNS, TLS…), como o ciclo real o publica.</summary>
        public string? ErroConexao { get; set; }

        public List<(Guid Supervisor, string? Observacao, OrigemLiberacaoLacuna? Origem)> Declaracoes { get; } = [];

        public SituacaoSincronizacao Situacao => real.Situacao with
        {
            SemNuvem = false,
            Online = true,
            Erro = ErroConexao,
            Pendentes = Pendentes,
            Lacuna = Lacuna,
            Terminal = Lacuna is { Recuperavel: false } ? EstadoTerminalSync.Lacuna : EstadoTerminalSync.Ativo,
        };

        public event EventHandler<SituacaoSincronizacao>? SituacaoAlterada
        {
            add => real.SituacaoAlterada += value;
            remove => real.SituacaoAlterada -= value;
        }

        public event EventHandler<string>? MensagemRecebida
        {
            add => real.MensagemRecebida += value;
            remove => real.MensagemRecebida -= value;
        }

        public Task<ResultadoHandshake> HandshakeAsync(CancellationToken ct = default) => real.HandshakeAsync(ct);

        public void Iniciar() => real.Iniciar();

        public Task AcordarAsync(CancellationToken ct = default) => real.AcordarAsync(ct);

        public void SincronizarAgora() => Reenvios++;

        public Task DeclararLacunaAsync(Guid autorizadoPorId, string? observacao, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null)
        {
            Declaracoes.Add((autorizadoPorId, observacao, origem));
            Lacuna = null;
            return Task.CompletedTask;
        }

        public Task AutorizarRecuperacaoLacunaAsync(Guid autorizadoPorId, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null)
        {
            Lacuna = null;
            return Task.CompletedTask;
        }
    }

    private sealed class Tempo : TimeProvider
    {
        private long _ticks = 1;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => _ticks;

        public void Avancar(TimeSpan tempo) => _ticks += tempo.Ticks;
    }

    private static async Task<(AmbienteUi Pdv, VendaViewModel Venda, SincronizacaoEspia Sync, Tempo Tempo)> IniciarAsync(
        string usuario = "1", string senha = "1234")
    {
        SincronizacaoEspia? sync = null;
        var tempo = new Tempo();
        var pdv = await AmbienteUi.IniciarAsync(ajustar: s =>
        {
            AutenticadorComExtras.Registrar(s);
            s.AddSingleton<TimeProvider>(tempo);
            s.AddSingleton<IServicoSincronizacao>(sp => sync = new SincronizacaoEspia(sp.GetRequiredService<ServicoSincronizacaoHttp>()));
        });
        var venda = await pdv.AtivarDemonstracaoELogarAsync(usuario, senha, fundo: "100");
        return (pdv, venda, sync!, tempo);
    }

    /// <summary>Gelo (12,90) pago com 20,00 em dinheiro.</summary>
    private static async Task VenderAsync(AmbienteUi pdv, VendaViewModel venda)
    {
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");
    }

    /// <summary>A venda que a nuvem recusou (como o push grava): o motivo e a ocorrência ligada no log_local.</summary>
    private static async Task<(VendaRegistro Venda, EventoSaida Evento)> RecusarAsync(AmbienteUi pdv, VendaRegistro venda, string motivo)
    {
        await using var db = Banco(pdv);
        var evento = await db.EventosSaida.SingleAsync(e => e.AgregadoId == venda.Id && e.Tipo == "venda.finalizada", Ct);
        evento.Status = StatusEventoSaida.Rejeitado;
        evento.Tentativas = 1;
        evento.UltimoErro = motivo;
        db.LogLocal.Add(new LogLocal
        {
            OcorridoEm = DateTimeOffset.UtcNow,
            Nivel = "aviso",
            Origem = EnvioPush.OrigemLog,
            Mensagem = $"A nuvem recusou o registro venda.finalizada nº {evento.SequenciaTerminal}: {motivo}",
            Detalhes = $$"""{"evento_id":"{{evento.Id}}","agregado_id":"{{venda.Id}}"}""",
        });
        await db.SaveChangesAsync(Ct);
        return (venda, evento);
    }

    [AvaloniaFact]
    public async Task Vendas_a_copiar_pelo_contador_da_venda_recusada_em_vermelho_reenvio_sem_duplicar_e_a_verde_quando_o_erp_resolve()
    {
        var (pdv, venda, sync, tempo) = await IniciarAsync();
        using var _ = pdv;
        await VenderAsync(pdv, venda);
        await VenderAsync(pdv, venda);
        await pdv.Servicos.GetRequiredService<ServicoCaixa>().RegistrarMovimentoAsync(
            new DadosMovimentoCaixa(TipoMovimentoCaixa.Reforco, 50m, null, null, null, null), null, Ct);
        List<VendaRegistro> vendas;
        await using (var db = Banco(pdv))
        {
            vendas = await db.Vendas.AsNoTracking().OrderBy(v => v.Numero).ToListAsync(Ct);
            db.ComandosRecebidos.Add(new ComandoRecebido
            {
                ComandoId = Guid.CreateVersion7(),
                Tipo = "mensagem",
                RecebidoEm = DateTimeOffset.UtcNow,
                Status = "executado",
                // Como o ProcessadorComandos grava ({"erro": e.Message}): a quebra de linha e a aspa escapadas no JSON.
                Resultado = new System.Text.Json.Nodes.JsonObject { ["erro"] = "falhou ao ler\nsenha=SEGREDO1 e\nBearer SEGREDO2 e \"token\":\"SEGREDO3\"" }.ToJsonString(),
            });
            await db.SaveChangesAsync(Ct);
        }

        var (recusada, evento) = await RecusarAsync(pdv, vendas[0], "PRODUTO_INEXISTENTE: O produto GELO não existe na nuvem.");
        var pendente = vendas[1];

        // O "⇅ N" da barra é clicável: a Central › 4; a MARIA não vê o diagnóstico, então o cadeado pede quem pode.
        pdv.Clicar(pdv.Controle<Button>("BotaoPendentes"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is CentralPdvViewModel { Liberando: true }, "a aba 4 pede o supervisor");
        var central = (CentralPdvViewModel)pdv.Shell.PaginaAtual!;
        Assert.Equal("Liberar a aba 4 Sincronização", central.TituloLiberacao);
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "encarregado";
        central.PinLiberacao = AutenticadorComExtras.PinEncarregado;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaSincronizacaoViewModel, "aba 4 Sincronização");
        var aba = (AbaSincronizacaoViewModel)central.Conteudo!;
        await aba.Atualizacao;
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");

        // Uma linha por venda: a recusada primeiro (vermelha, com o motivo da nuvem), a pendente em amarelo.
        Assert.Equal(VisaoSincronizacao.Vendas, aba.Visao);
        Assert.Equal(2, aba.Linhas.Count);
        var vermelha = aba.Linhas[0];
        Assert.Equal((recusada.Id, "RECUSADA", true), (vermelha.Chave, vermelha.Situacao, vermelha.Recusada));
        Assert.Equal($"Venda {recusada.NumeroExibicao}", vermelha.Registro);
        Assert.Equal("PRODUTO_INEXISTENTE: O produto GELO não existe na nuvem.", vermelha.Motivo);
        Assert.Equal((pendente.Id, "AGUARDANDO", true), (aba.Linhas[1].Chave, aba.Linhas[1].Situacao, aba.Linhas[1].Pendente));
        Assert.Equal("Vendas não confirmadas (2)", aba.TextoVisaoVendas);
        Assert.StartsWith("Vendas 1 a 2 de 2 não confirmadas (1 recusada)", aba.Rodape, StringComparison.Ordinal);
        Assert.Contains("1 recusado", aba.Resumo, StringComparison.Ordinal);
        pdv.Captura("74-central-sincronizacao");

        // Enter: o detalhe com os itens, os pagamentos, cada envio e a ocorrência ligada; nunca o conteúdo do registro.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe");
        await pdv.EsperarFocoAsync("PainelDetalheSincronizacao");
        Assert.Equal($"Venda {recusada.NumeroExibicao} · RECUSADA", aba.TituloDetalhe);
        Assert.True(aba.DetalheRecusado);
        Assert.Equal("A nuvem recusou: PRODUTO_INEXISTENTE: O produto GELO não existe na nuvem. " + ServicoSincronizacaoCentral.OndeResolver, aba.SituacaoDetalhe);
        Assert.Contains("Total R$ 12,90", aba.LinhasDetalhe);
        Assert.Contains("  Dinheiro: R$ 12,90", aba.LinhasDetalhe);
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith($"  Venda · nº {evento.SequenciaTerminal} · RECUSADO", StringComparison.Ordinal));
        Assert.Contains("    último erro: PRODUTO_INEXISTENTE: O produto GELO não existe na nuvem.", aba.LinhasDetalhe);
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("    depende de: caixa (abertura e fechamento) — aguardando", StringComparison.Ordinal));
        Assert.Contains(aba.LinhasDetalhe, l => l.Contains($"aviso sync: A nuvem recusou o registro venda.finalizada nº {evento.SequenciaTerminal}", StringComparison.Ordinal));
        Assert.Contains(AbaSincronizacaoViewModel.MensagemSemPayload, aba.LinhasDetalhe);
        Assert.DoesNotContain(aba.LinhasDetalhe, l => l.Contains('{', StringComparison.Ordinal) || l.Contains(evento.PayloadSha256, StringComparison.Ordinal));
        Assert.Equal("F6  Conferir no ERP agora", aba.TextoBotaoReenvio);
        pdv.Captura("75-central-sincronizacao-detalhe");

        // F6 (ou o botão) "Reenviar agora": só o ciclo de envio de sempre; duas vezes, e nada se duplica.
        int eventosAntes;
        await using (var db = Banco(pdv))
        {
            eventosAntes = await db.EventosSaida.CountAsync(Ct);
        }

        pdv.Tecla(Key.F6);
        await pdv.EsperarAsync(() => sync.Reenvios == 1, "reenvio pedido");
        Assert.Equal(ServicoSincronizacaoCentral.MensagemReenvio, aba.Mensagem);
        pdv.Clicar(pdv.Controle<Button>("BotaoReenviarDetalheSync"));
        await pdv.EsperarAsync(() => sync.Reenvios == 2, "reenvio pelo botão");
        await using (var db = Banco(pdv))
        {
            Assert.Equal(eventosAntes, await db.EventosSaida.CountAsync(Ct));
            Assert.Equal(StatusEventoSaida.Rejeitado, (await db.EventosSaida.SingleAsync(e => e.Id == evento.Id, Ct)).Status);
        }

        // O ERP reprocessa e a nuvem aceita: o relógio da Central percebe o sync mudar e a venda fica verde sozinha (no
        // detalhe aberto e na lista); a leitura manual (F5) a tira da lista.
        await using (var db = Banco(pdv))
        {
            await db.EventosSaida.Where(e => e.Id == evento.Id).ExecuteUpdateAsync(u => u
                .SetProperty(e => e.Status, StatusEventoSaida.Confirmado).SetProperty(e => e.UltimoErro, (string?)null), Ct);
        }

        sync.Pendentes = 7;
        central.Atualizar();
        await aba.Atualizacao;
        await pdv.EsperarAsync(() => aba.DetalheConfirmado, "detalhe verde");
        Assert.Equal($"Venda {recusada.NumeroExibicao} · ✓ CONFIRMADA", aba.TituloDetalhe);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");
        Assert.Equal((recusada.Id, "✓ CONFIRMADA", true), (aba.Linhas[0].Chave, aba.Linhas[0].Situacao, aba.Linhas[0].Confirmada));
        Assert.Equal(pendente.Id, aba.Linhas[1].Chave);
        pdv.Captura("76-central-sincronizacao-verde");
        pdv.Tecla(Key.F5);
        await aba.Atualizacao;
        Assert.Equal(pendente.Id, Assert.Single(aba.Linhas).Chave);

        // F3: o caixa não confirmado (a segunda seção do pedido): a abertura e o reforço, em amarelo.
        pdv.Tecla(Key.F3);
        await pdv.EsperarAsync(() => aba.Visao == VisaoSincronizacao.Caixa && !aba.Carregando, "caixa não confirmado");
        await aba.Atualizacao;
        Assert.Contains(aba.Linhas, l => l.Registro.StartsWith("Reforço · nº", StringComparison.Ordinal) && l.Valor == "50,00" && l.Pendente);
        Assert.Contains(aba.Linhas, l => l.Registro.StartsWith("Abertura do caixa", StringComparison.Ordinal) && l.Valor == "100,00");
        // O valor da sessão é o fundo de troco: vale para a abertura, nunca para o fechamento (o conferido fica no ERP).
        var fechamento = new EventoSincronizacao(Guid.CreateVersion7(), 99, "caixa.fechado", "sessao_caixa", Guid.CreateVersion7(), DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow, StatusEventoSaida.Pendente, 0, null, null, null, null, false, false);
        var sessao = new AgregadoSincronizacao(fechamento.AgregadoId, Valor: 100m, NumeroCaixa: 2, Quando: DateTimeOffset.UtcNow);
        Assert.Equal("—", aba.LinhaEvento(fechamento, sessao).Valor);
        Assert.Equal("100,00", aba.LinhaEvento(fechamento with { Tipo = "caixa.aberto" }, sessao).Valor);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe do registro do caixa");
        Assert.Contains("AINDA NÃO CONFIRMADA", aba.TituloDetalhe, StringComparison.Ordinal);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");

        // Todos os registros (pelo botão): a enviar na ordem de envio; F7 até os confirmados, onde está a venda resolvida.
        pdv.Clicar(pdv.Controle<Button>("BotaoVisaoTodosSync"));
        await pdv.EsperarAsync(() => aba.Visao == VisaoSincronizacao.Todos && !aba.Carregando, "todos");
        await aba.Atualizacao;
        Assert.All(aba.Linhas, l => Assert.True(l.Pendente));
        pdv.Tecla(Key.F7);
        await aba.Atualizacao;
        Assert.Equal(SituacaoFiltroEvento.Recusados, aba.SituacaoTodos);
        pdv.Clicar(pdv.Controle<Button>("BotaoSituacaoSync"));
        await aba.Atualizacao;
        Assert.Equal(SituacaoFiltroEvento.Confirmados, aba.SituacaoTodos);
        Assert.Contains(aba.Linhas, l => l.Chave == evento.Id && l.Confirmada);

        // A venda que já está na nuvem, aberta pelos confirmados: o ENCARREGADO só tem o diagnóstico (sem o histórico de
        // vendas), então o detalhe traz os envios e não os itens nem os pagamentos (a regra da aba 1; o outbox não expira).
        aba.Selecionada = aba.Linhas.Single(l => l.Chave == evento.Id);
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe da confirmada");
        Assert.Equal($"Venda {recusada.NumeroExibicao} · ✓ CONFIRMADA", aba.TituloDetalhe);
        Assert.Contains(ServicoSincronizacaoCentral.MensagemItensForaDoAlcance, aba.LinhasDetalhe);
        Assert.DoesNotContain("Total R$ 12,90", aba.LinhasDetalhe);
        Assert.DoesNotContain("  Dinheiro: R$ 12,90", aba.LinhasDetalhe);
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith($"  Venda · nº {evento.SequenciaTerminal} · ✓ CONFIRMADO", StringComparison.Ordinal));
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");

        // Os comandos do ERP.
        pdv.Clicar(pdv.Controle<Button>("BotaoVisaoComandosSync"));
        await pdv.EsperarAsync(() => aba.Visao == VisaoSincronizacao.Comandos && !aba.Carregando, "comandos");
        await aba.Atualizacao;
        Assert.Equal(("Mensagem do ERP", "EXECUTADO"), (Assert.Single(aba.Linhas).Registro, aba.Linhas[0].Situacao));
        // O resultado mascarado valor a valor: nenhum dos três segredos depois da quebra de linha ou dentro das aspas.
        Assert.All(new[] { "SEGREDO1", "SEGREDO2", "SEGREDO3" }, segredo => Assert.DoesNotContain(segredo, aba.Linhas[0].Motivo, StringComparison.Ordinal));
        Assert.Contains("senha=***", aba.Linhas[0].Motivo, StringComparison.Ordinal);

        // Nenhuma ação de descartar ou reprocessar no PDV (a decisão é no ERP): nem comando, nem botão.
        Assert.DoesNotContain(typeof(AbaSincronizacaoViewModel).GetProperties().Where(p => typeof(IRelayCommand).IsAssignableFrom(p.PropertyType)),
            p => p.Name.Contains("Descart", StringComparison.Ordinal) || p.Name.Contains("Reprocess", StringComparison.Ordinal));
        Assert.DoesNotContain(pdv.Janela.GetVisualDescendants().OfType<Button>(),
            b => b.Content is string t && (t.Contains("Descartar", StringComparison.Ordinal) || t.Contains("Reprocessar", StringComparison.Ordinal)));

        // Pelo mouse e pelo numérico em 1024 × 700: os botões de 44 px.
        pdv.Janela.Width = 1024;
        pdv.Janela.Height = 700;
        pdv.Clicar(pdv.Controle<Button>("BotaoVisaoVendasSync"));
        await pdv.EsperarAsync(() => aba.Visao == VisaoSincronizacao.Vendas && !aba.Carregando, "de volta às vendas");
        await aba.Atualizacao;
        foreach (var nome in new[] { "BotaoVisaoVendasSync", "BotaoVisaoCaixaSync", "BotaoDetalheSync", "BotaoReenviarSync", "BotaoProximaSync" })
        {
            Assert.True(pdv.Controle<Button>(nome).Bounds.Height >= 44, nome);
        }

        // O que foi digitado na venda também passa pelo mascarador (o detalhe é diagnóstico): o CPF no motivo.
        await using (var db = Banco(pdv))
        {
            await db.Vendas.Where(v => v.Id == pendente.Id).ExecuteUpdateAsync(u => u
                .SetProperty(v => v.CanceladaEm, DateTimeOffset.UtcNow)
                .SetProperty(v => v.MotivoCancelamento, "cliente 123.456.789-09 desistiu"), Ct);
        }

        pdv.Tecla(Key.Multiply);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe pelo *");
        Assert.Equal("F6  Reenviar agora", aba.TextoBotaoReenvio);
        Assert.Contains("AINDA NÃO CONFIRMADA", aba.TituloDetalhe, StringComparison.Ordinal);
        Assert.Contains("Total R$ 12,90", aba.LinhasDetalhe);
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("Cancelada em", StringComparison.Ordinal) && l.EndsWith(": cliente ***.***.***-** desistiu", StringComparison.Ordinal));
        Assert.DoesNotContain(aba.LinhasDetalhe, l => l.Contains("123.456.789-09", StringComparison.Ordinal));
        pdv.Clicar(pdv.Controle<Button>("BotaoVoltarDetalheSync"));
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");

        // A liberação do ENCARREGADO acaba (5 min sem uso): a aba esvazia e a Central volta ao Painel.
        tempo.Avancar(AcessoCentral.ValidadeLiberacao + TimeSpan.FromSeconds(1));
        central.Atualizar();
        Assert.Equal("0", central.AbaSelecionada!.Codigo);
        Assert.Empty(aba.Linhas);
        Assert.False(aba.MostrandoDetalhe);
    }

    [AvaloniaFact]
    public async Task Lacuna_pelo_f4_pede_o_fiscal_na_hora_e_o_f11_s_leva_a_lista_completa()
    {
        var (pdv, venda, sync, _) = await IniciarAsync();
        using var __ = pdv;

        // F11 › S com a venda em andamento: o F3 fica com a mensagem (a Central exige o caixa livre).
        await pdv.EntrarCodigoAsync("0044");
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.S);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoStatusSyncViewModel, "status do sync");
        var status = (DialogoStatusSyncViewModel)venda.Dialogo!;
        Assert.Contains(DialogoStatusSyncViewModel.MensagemListaCompleta, status.Linhas);
        Assert.StartsWith("F3  Lista completa", DialogoStatusSyncViewModel.MensagemListaCompleta, StringComparison.Ordinal);
        pdv.Tecla(Key.F3);
        await pdv.EsperarAsync(() => status.Erro is not null, "caixa ocupado");
        Assert.Equal(VendaViewModel.MensagemCaixaLivre, status.Erro);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => venda.Dialogo is null, "status fechado");
        pdv.Tecla(Key.F10);
        await pdv.EsperarFocoAsync("CampoValorRecebido");
        pdv.Digitar("20");
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => venda.Dialogo is null && venda.CaixaLivre, "venda finalizada");

        // Com o caixa livre, o F3 (ou o botão) abre a Central › 4; a MARIA pede o ENCARREGADO.
        pdv.Tecla(Key.F11);
        await pdv.EsperarFocoAsync("DialogoFuncoes");
        pdv.Tecla(Key.S);
        await pdv.EsperarAsync(() => venda.Dialogo is DialogoStatusSyncViewModel, "status do sync");
        pdv.Clicar(pdv.Controle<Button>("BotaoListaCompletaSync"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is CentralPdvViewModel { Liberando: true }, "a aba 4 pede o supervisor");
        var central = (CentralPdvViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EsperarFocoAsync("CampoUsuarioLiberacaoCentral");
        central.UsuarioLiberacao = "encarregado";
        central.PinLiberacao = AutenticadorComExtras.PinEncarregado;
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => central.Conteudo is AbaSincronizacaoViewModel, "aba 4");
        var aba = (AbaSincronizacaoViewModel)central.Conteudo!;
        await aba.Atualizacao;
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");

        // Sem lacuna, o F4 só avisa.
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => aba.Mensagem is not null, "sem lacuna");
        Assert.Equal("Nenhuma lacuna de eventos neste caixa.", aba.Mensagem);
        Assert.Null(aba.Liberacao);

        // Lacuna a declarar: a linha vermelha e o F4, que pede pdv.config.fiscal na hora (a Central não a empresta: nem a
        // MARIA nem o ENCARREGADO que liberou a aba a têm); o CARLOS declara.
        sync.Lacuna = new LacunaEventos(1048, 1049, false);
        sync.Pendentes = 3;
        central.Atualizar();
        await aba.Atualizacao;
        Assert.Contains("Lacuna de eventos 1048–1049", aba.AcaoLacuna, StringComparison.Ordinal);
        Assert.True(pdv.Controle<Button>("BotaoLacunaSync").IsVisible);
        pdv.Tecla(Key.F4);
        await pdv.EsperarAsync(() => aba.Liberacao is not null, "pedido do fiscal");
        Assert.Equal(PermissoesPdv.ConfigFiscal, aba.Liberacao!.Permissao);
        aba.Liberacao.Usuario = "encarregado";
        aba.Liberacao.Pin = AutenticadorComExtras.PinEncarregado;
        aba.Liberacao.Motivo = "Eventos perdidos na troca do disco";
        await aba.Liberacao.ConfirmarCommand.ExecuteAsync(null);
        Assert.NotNull(aba.Liberacao.Erro);
        Assert.Empty(sync.Declaracoes);
        aba.Liberacao.Usuario = "2";
        aba.Liberacao.Pin = "4321";
        await aba.Liberacao.ConfirmarCommand.ExecuteAsync(null);
        await pdv.EsperarAsync(() => aba.Liberacao is null && sync.Declaracoes.Count == 1, "lacuna declarada");
        // Na auditoria: quem está na Central e pediu (a MARIA) e esta tela, não o "Status da sincronização".
        var maria = pdv.Servicos.GetRequiredService<AcessoCentral>().Usuario!.Id;
        Assert.Equal((Carlos, "Eventos perdidos na troca do disco", new OrigemLiberacaoLacuna(maria, AbaSincronizacaoViewModel.Localizacao)), sync.Declaracoes[0]);
        Assert.Contains("Lacuna de eventos 1048–1049 declarada na nuvem com liberação de CARLOS", aba.Mensagem, StringComparison.Ordinal);
        await aba.Atualizacao;
        Assert.Null(aba.AcaoLacuna);

        // Esc volta ao menu (o 4 de novo leva o foco à lista).
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() == "4", "menu");
    }

    [AvaloniaFact]
    public async Task Demonstracao_diz_que_nada_sobe_e_o_gerente_ve_sem_pedir_ninguem()
    {
        using var pdv = await AmbienteUi.IniciarAsync();
        var venda = await pdv.AtivarDemonstracaoELogarAsync("2", "4321", fundo: "100");
        await VenderAsync(pdv, venda);

        // O CARLOS (Master) tem o diagnóstico: o ⇅ abre direto a aba, com a venda pendente em amarelo.
        pdv.Clicar(pdv.Controle<Button>("BotaoPendentes"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is CentralPdvViewModel { Conteudo: AbaSincronizacaoViewModel }, "aba 4 direto");
        var central = (CentralPdvViewModel)pdv.Shell.PaginaAtual!;
        var aba = (AbaSincronizacaoViewModel)central.Conteudo!;
        await aba.Atualizacao;
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");
        Assert.Equal("AGUARDANDO", Assert.Single(aba.Linhas).Situacao);
        Assert.Empty(await AuditoriaAsync(pdv, "liberacao"));
        Assert.Single(await AuditoriaAsync(pdv, AcessoCentral.AcaoCentralAcessada));

        // Sem nuvem (demonstração), o reenvio diz que nada sobe.
        pdv.Clicar(pdv.Controle<Button>("BotaoReenviarSync"));
        await pdv.EsperarAsync(() => aba.Mensagem is not null, "demonstração");
        Assert.Equal(ServicoSincronizacaoCentral.MensagemDemonstracao, aba.Mensagem);

        // Com a venda em andamento, o ⇅ não abre a Central (a mesma regra do ⚙).
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.AbaFocada() is not null, "menu");
        pdv.Tecla(Key.Escape);
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is VendaViewModel, "venda");
        venda = (VendaViewModel)pdv.Shell.PaginaAtual!;
        await pdv.EntrarCodigoAsync("0044");
        pdv.Clicar(pdv.Controle<Button>("BotaoPendentes"));
        await AmbienteUi.Pausa();
        Assert.IsType<VendaViewModel>(pdv.Shell.PaginaAtual);
        Assert.Equal(VendaViewModel.MensagemCaixaLivre, pdv.Texto("TextoMensagem"));
    }

    [AvaloniaFact]
    public async Task Descartada_no_erp_fica_sem_cor_o_resumo_sai_do_vermelho_e_o_detalhe_nao_abre_vazio()
    {
        // O CARLOS (Master) tem o diagnóstico e o histórico: o ⇅ abre direto a aba.
        var (pdv, venda, sync, _) = await IniciarAsync("2", "4321");
        using var __ = pdv;
        await VenderAsync(pdv, venda);
        await VenderAsync(pdv, venda);
        List<VendaRegistro> vendas;
        await using (var db = Banco(pdv))
        {
            vendas = await db.Vendas.AsNoTracking().OrderBy(v => v.Numero).ToListAsync(Ct);
            // 60 vendas de outro caixa na fila (só o envio, sem a venda aqui): a lista passa de uma página.
            db.EventosSaida.AddRange(Enumerable.Range(0, 60).Select(i => new EventoSaida
            {
                Id = Guid.CreateVersion7(),
                SequenciaTerminal = 900_000 + i,
                Tipo = "venda.finalizada",
                AgregadoTipo = ConsultasSincronizacaoLocal.AgregadoVenda,
                AgregadoId = Guid.CreateVersion7(),
                OcorridoEm = DateTimeOffset.UtcNow,
                CriadoEm = DateTimeOffset.UtcNow,
                Payload = "{}",
                PayloadSha256 = new string('0', 64),
                Status = StatusEventoSaida.Pendente,
            }));
            await db.SaveChangesAsync(Ct);
        }

        var (recusada, evento) = await RecusarAsync(pdv, vendas[0], "PRODUTO_INEXISTENTE: O produto GELO não existe na nuvem.");
        var pendente = vendas[1];
        pdv.Clicar(pdv.Controle<Button>("BotaoPendentes"));
        await pdv.EsperarAsync(() => pdv.Shell.PaginaAtual is CentralPdvViewModel { Conteudo: AbaSincronizacaoViewModel }, "aba 4 direto");
        var central = (CentralPdvViewModel)pdv.Shell.PaginaAtual!;
        var aba = (AbaSincronizacaoViewModel)central.Conteudo!;
        await aba.Atualizacao;
        Assert.Equal((recusada.Id, "RECUSADA"), (aba.Linhas[0].Chave, aba.Linhas[0].Situacao));
        Assert.Contains("1 recusado", aba.Resumo, StringComparison.Ordinal);
        Assert.True(aba.ResumoComProblema);
        Assert.Null(aba.ErroConexao);

        // O ERP descarta a recusada (o heartbeat traz a decisão): a linha fica sem cor, "descartada no ERP", nunca verde
        // (a nuvem não tem a venda); o resumo sai do vermelho e cita a descartada à parte.
        await using (var db = Banco(pdv))
        {
            await db.EventosSaida.Where(e => e.Id == evento.Id).ExecuteUpdateAsync(u => u
                .SetProperty(e => e.Resultado, "{\"descartado\":true,\"justificativa\":\"Venda de teste\"}"), Ct);
        }

        sync.Pendentes = 61;
        central.Atualizar();
        await aba.Atualizacao;
        var descartada = aba.Linhas[0];
        Assert.Equal((recusada.Id, "DESCARTADA NO ERP", NivelLinhaSincronizacao.Neutra), (descartada.Chave, descartada.Situacao, descartada.Nivel));
        Assert.False(descartada.Confirmada);
        Assert.DoesNotContain(aba.Linhas, l => l.Confirmada || l.Situacao.Contains('✓', StringComparison.Ordinal));
        Assert.Contains("0 recusados · 1 descartado no ERP", aba.Resumo, StringComparison.Ordinal);
        Assert.False(aba.ResumoComProblema);

        // O detalhe da mesma venda diz o mesmo; o CARLOS tem o histórico e a venda é de hoje: os itens aparecem.
        pdv.Tecla(Key.Enter);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "detalhe da descartada");
        Assert.Equal($"Venda {recusada.NumeroExibicao} · DESCARTADA NO ERP", aba.TituloDetalhe);
        Assert.Contains("Total R$ 12,90", aba.LinhasDetalhe);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");

        // A troca de página é leitura manual: a descartada (como a verde) era da página que saiu e não vai para a seguinte.
        Assert.True(aba.TemProxima);
        pdv.Tecla(Key.PageDown);
        await aba.Atualizacao;
        Assert.Equal(2, aba.Pagina);
        Assert.DoesNotContain(aba.Linhas, l => l.Chave == recusada.Id);
        pdv.Tecla(Key.PageUp);
        await aba.Atualizacao;
        Assert.DoesNotContain(aba.Linhas, l => l.Chave == recusada.Id);

        // A releitura sozinha (o relógio, o sync que mudou) no meio da leitura do detalhe não o deixa vazio.
        var linhaPendente = aba.Linhas.Single(l => l.Chave == pendente.Id);
        var portao = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        aba.AntesDeLerDetalhe = () => portao.Task;
        var abrindo = aba.DetalharCommand.ExecuteAsync(linhaPendente);
        sync.Pendentes = 62;
        central.Atualizar();
        await aba.Atualizacao;
        portao.SetResult();
        await abrindo;
        aba.AntesDeLerDetalhe = null;
        Assert.True(aba.MostrandoDetalhe);
        Assert.Equal($"Venda {pendente.NumeroExibicao} · AINDA NÃO CONFIRMADA", aba.TituloDetalhe);
        Assert.Contains("Total R$ 12,90", aba.LinhasDetalhe);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");

        // O porquê de nada subir (o último erro da conexão) no topo, e o F9 (ou o botão) com tudo do F11 › S.
        sync.ErroConexao = "Falha de DNS ao falar com a nuvem (api.exemplo.com.br)";
        pdv.Tecla(Key.F5);
        await aba.Atualizacao;
        Assert.Equal("Último erro da conexão: Falha de DNS ao falar com a nuvem (api.exemplo.com.br) (F9 situação completa)", aba.ErroConexao);
        pdv.Tecla(Key.F9);
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe, "situação completa");
        await pdv.EsperarFocoAsync("PainelDetalheSincronizacao");
        Assert.Equal(AbaSincronizacaoViewModel.TituloSituacaoCompleta, aba.TituloDetalhe);
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("Pendentes de envio:", StringComparison.Ordinal) && l.Contains("venda.finalizada", StringComparison.Ordinal));
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("Cursores:", StringComparison.Ordinal));
        Assert.Contains(aba.LinhasDetalhe, l => l.StartsWith("Último heartbeat:", StringComparison.Ordinal));
        Assert.Contains("Último erro:         Falha de DNS ao falar com a nuvem (api.exemplo.com.br)", aba.LinhasDetalhe);
        pdv.Tecla(Key.Escape);
        await pdv.EsperarFocoAsync("PainelListaSincronizacao");
        pdv.Clicar(pdv.Controle<Button>("BotaoSituacaoCompletaSync"));
        await pdv.EsperarAsync(() => aba.MostrandoDetalhe && aba.TituloDetalhe == AbaSincronizacaoViewModel.TituloSituacaoCompleta, "situação pelo botão");
        pdv.Tecla(Key.F9);
        await pdv.EsperarAsync(() => !aba.MostrandoDetalhe, "F9 de novo fecha");
    }

    private static async Task<List<LogAuditoriaLocal>> AuditoriaAsync(AmbienteUi pdv, string acao)
    {
        await using var db = Banco(pdv);
        return await db.LogAuditoriaLocal.AsNoTracking().Where(l => l.Acao == acao).ToListAsync(Ct);
    }
}
