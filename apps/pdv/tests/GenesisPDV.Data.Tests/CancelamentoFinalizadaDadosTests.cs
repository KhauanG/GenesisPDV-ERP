using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Outbox;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Tests;

/// <summary>
/// Banco local do cancelamento da venda paga (Fase 1C, C11b; PDV 13.3): só as colunas de cancelamento, os pagamentos
/// estornados, a cobrança PIX (devolvida, com a hora e o valor) e os <c>estorno_venda</c> num commit com o evento; a
/// gaveta estimada e o fechamento contam o estorno uma vez, e o lançamento a prazo cancelado sai do calculado; só na sessão
/// aberta (O6) e nunca a venda descartada no ERP; a gestão de vendas da sessão (filtro pelo número inteiro e o número novo
/// da nuvem); e o saldo estimado devolve a baixa da venda cancelada até o estorno se refletir (SYNC 15.2).
/// </summary>
public class CancelamentoFinalizadaDadosTests
{
    private static readonly Guid Terminal = Guid.CreateVersion7();
    private static readonly Guid Loja = Guid.CreateVersion7();
    private static readonly Guid Operador = Guid.CreateVersion7();

    private static readonly FormaPagamentoInfo Dinheiro = new(Guid.CreateVersion7(), "Dinheiro", "01", "dinheiro", true);

    private static readonly FormaPagamentoInfo Debito = new(Guid.CreateVersion7(), "Cartão de débito", "04", "cartao_debito", false,
        Integracao: IntegracaoForma.PosExterno);

    private static readonly FormaPagamentoInfo Pix = new(Guid.CreateVersion7(), "PIX", "20", "pix", false, Integracao: IntegracaoForma.PixEstatico);

    /// <summary>Forma personalizada "outros" a prazo (C8b): sem quitação no caixa, o padrão do estorno é <c>credito_cancelado</c>.</summary>
    private static readonly FormaPagamentoInfo Fiado = new(Guid.CreateVersion7(), "Fiado", "99", "outros", false, LancaQuitada: false);

    /// <summary>"Outros" quitada no caixa (o cheque fica na gaveta): o <c>credito_cancelado</c> dela continua no calculado.</summary>
    private static readonly FormaPagamentoInfo Cheque = new(Guid.CreateVersion7(), "Cheque", "02", "outros", false);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>O bloco <c>pagamentos_venda</c> do <c>venda.cancelada</c> forma A, como a <c>FabricaEventos</c> o monta.</summary>
    private static string PayloadCancelamento(CancelamentoFinalizada cancelamento) => new JsonObject
    {
        ["pagamentos_venda"] = new JsonArray(cancelamento.Estornos
            .Select(e => (JsonNode)new JsonObject { ["id"] = e.PagamentoVendaId.ToString(), ["status"] = StatusPagamento.Estornado, ["estorno"] = e.Estorno })
            .ToArray()),
    }.ToJsonString();

    /// <summary>Venda de um item de <paramref name="total"/>, paga com os <paramref name="pagamentos"/>, na sessão.</summary>
    private static async Task<Venda> VendaComAsync(BancoTemporario banco, Guid sessao, decimal total, params (FormaPagamentoInfo Forma, decimal Valor)[] pagamentos)
    {
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var agora = banco.Relogio.Agora;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(Ct), new ContextoVenda(Terminal, Loja, 1, Guid.CreateVersion7(), 2, sessao),
            Operador, agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "GELO", "UN", total)), 1m, "44", agora);
        venda.IniciarPagamento();
        foreach (var (forma, valor) in pagamentos)
        {
            venda.LancarPagamento(forma, valor, agora,
                pix: forma == Pix ? new ConfirmacaoPix("JOSE DA SILVA", agora.AddMinutes(-1), "000201xyz", "L01C02000001") : null);
        }

        var eventoId = Guid.CreateVersion7();
        venda.Finalizar(agora, eventoId);
        await repo.EncerrarAsync(venda, Evento("venda.finalizada", venda.Id, agora) with { Id = eventoId }, ct: Ct);
        return (await repo.ObterAsync(venda.Id, Ct))!;
    }

    private static async Task CancelarAsync(RepositorioCaixa caixa, SessaoCaixaRegistro sessao, Venda venda, DateTimeOffset agora,
        IReadOnlyDictionary<Guid, string>? escolhas = null)
    {
        var cancelamento = venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", agora, sessao.Id, Dinheiro.Id, escolhas);
        await caixa.CancelarVendaFinalizadaAsync(venda, RepositorioCaixa.LinhasEstorno(sessao, venda, cancelamento, IdGerador.Novo),
            Evento("venda.cancelada", venda.Id, agora, PayloadCancelamento(cancelamento)), Ct);
    }

    private static EventoParaOutbox Evento(string tipo, Guid agregado, DateTimeOffset quando, string payload = "{}") =>
        new(Guid.CreateVersion7(), tipo, 1, "venda", agregado, quando, payload, new string('0', 64));

    private static async Task<(BancoTemporario Banco, SessaoCaixaRegistro Sessao, RepositorioCaixa Caixa)> PrepararAsync(decimal fundo = 100m)
    {
        var banco = new BancoTemporario();
        await banco.InicializarAsync();
        var agora = banco.Relogio.Agora;
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.IdentidadeTerminal.Add(new IdentidadeTerminal
            {
                TerminalId = Terminal,
                LojaId = Loja,
                CaixaId = Guid.CreateVersion7(),
                NumeroCaixa = 2,
                UrlApi = "https://api.exemplo/",
                AtivadoEm = agora,
            });
            await db.SaveChangesAsync(Ct);
        }

        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(
            [
                new FormaPagamentoRegistro { Id = Dinheiro.Id, Descricao = "Dinheiro", TipoForma = "dinheiro", MeioPagamentoFiscal = "01", CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
                new FormaPagamentoRegistro { Id = Debito.Id, Descricao = "Cartão de débito", TipoForma = "cartao_debito", MeioPagamentoFiscal = "04", CriadoEm = agora, AtualizadoEm = agora, Versao = 1 },
            ],
            Ct);
        var sessao = new SessaoCaixaRegistro
        {
            Id = IdGerador.Novo(),
            LojaId = Loja,
            CaixaId = Guid.CreateVersion7(),
            NumeroCaixa = 2,
            TerminalId = Terminal,
            OperadorId = Operador,
            DiaOperacional = DateOnly.FromDateTime(agora.UtcDateTime),
            AbertaEm = agora,
            FundoTroco = fundo,
        };
        var caixa = new RepositorioCaixa(banco.Fabrica, banco.Relogio, new GravadorOutbox(new RelogioOutboxLocal(banco.Relogio)));
        var abertura = new MovimentoCaixaRegistro
        {
            Id = IdGerador.Novo(),
            SessaoCaixaId = sessao.Id,
            LojaId = Loja,
            CaixaId = sessao.CaixaId,
            NumeroCaixa = 2,
            TerminalId = Terminal,
            Tipo = TipoMovimentoCaixa.Abertura,
            Valor = fundo,
            OperadorId = Operador,
            OcorridoEm = agora,
        };
        await caixa.AbrirAsync(sessao, abertura, new EventoParaOutbox(Guid.CreateVersion7(), "caixa.aberto", 1, "sessao_caixa", sessao.Id, agora, "{}", new string('0', 64)), Ct);
        return (banco, sessao, caixa);
    }

    /// <summary>Venda paga e encerrada: R$ 30,00, 10,00 no débito e 20,00 em dinheiro.</summary>
    private static async Task<Venda> VendaPagaAsync(BancoTemporario banco, Guid sessao, Guid produto)
    {
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var agora = banco.Relogio.Agora;
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(Ct), new ContextoVenda(Terminal, Loja, 1, Guid.CreateVersion7(), 2, sessao),
            Operador, agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(produto, 1, null, "GELO", "UN", 15m)), 2m, "44", agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(Debito, 10m, agora, RegrasFormaPagamento.ValidarPos(Debito, "06", null, null, 1));
        venda.LancarPagamento(Dinheiro, 20m, agora);
        var eventoId = Guid.CreateVersion7();
        venda.Finalizar(agora, eventoId);
        var payload = new JsonObject
        {
            ["itens_venda"] = new JsonArray(new JsonObject { ["produto_id"] = produto.ToString(), ["quantidade"] = "2.000", ["cancelado"] = false, ["componentes_estoque"] = new JsonArray() }),
        }.ToJsonString();
        await repo.EncerrarAsync(venda, Evento("venda.finalizada", venda.Id, agora, payload) with { Id = eventoId }, ct: Ct);
        return (await repo.ObterAsync(venda.Id, Ct))!;
    }

    [Fact]
    public async Task Cancelamento_grava_so_o_cancelamento_e_os_estornos_e_a_gaveta_conta_uma_vez()
    {
        var (banco, sessao, caixa) = await PrepararAsync();
        using var _ = banco;
        var venda = await VendaPagaAsync(banco, sessao.Id, Guid.CreateVersion7());
        Assert.Equal(120m, await caixa.DinheiroGavetaAsync(sessao.Id, Ct));
        var (total, itens) = (venda.Total, venda.Itens.Count);

        var agora = banco.Relogio.Agora.AddMinutes(5);
        var cancelamento = venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", agora, sessao.Id, Dinheiro.Id,
            new Dictionary<Guid, string> { [venda.Pagamentos[0].Id] = EstornoPagamento.DevolvidoEmDinheiro });
        var linhas = RepositorioCaixa.LinhasEstorno(sessao, venda, cancelamento, IdGerador.Novo);
        var sequencia = await caixa.CancelarVendaFinalizadaAsync(venda, linhas, Evento("venda.cancelada", venda.Id, agora), Ct,
            [new RegistroAuditoria("venda_cancelada", Operador, "venda", venda.Id, "cancelada")]);

        Assert.True(sequencia > 0);
        // O fundo + 20,00 recebidos − 30,00 devolvidos (o débito saiu em dinheiro, O22).
        Assert.Equal(90m, await caixa.DinheiroGavetaAsync(sessao.Id, Ct));
        var dados = await caixa.ApurarAsync(sessao.Id, Ct);
        Assert.Equal(2, dados.Pagamentos.Count);
        Assert.Equal((0, 1, 30m), (dados.Resumo.QtdVendas, dados.Resumo.QtdCanceladas, dados.Resumo.TotalCanceladas));
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            var gravada = await db.Vendas.Include(v => v.Pagamentos).Include(v => v.Itens).SingleAsync(Ct);
            Assert.Equal((StatusVenda.Cancelada, "Cliente desistiu da compra", total, itens), (gravada.Status, gravada.MotivoCancelamento, gravada.Total, gravada.Itens.Count));
            Assert.NotNull(gravada.FinalizadaEm);
            Assert.All(gravada.Pagamentos, p => Assert.Equal(StatusPagamento.Estornado, p.Status));
            var estorno = Assert.Single(await db.MovimentosCaixa.Where(m => m.Tipo == TipoMovimentoCaixa.EstornoVenda).ToListAsync(Ct));
            Assert.Equal((30m, (Guid?)Dinheiro.Id, $"Estorno da venda {venda.NumeroExibicao}"), (estorno.Valor, estorno.FormaPagamentoId, estorno.Observacao));
            Assert.Equal(1, await db.EventosSaida.CountAsync(e => e.Tipo == "venda.cancelada", Ct));
            Assert.Equal(1, await db.LogAuditoriaLocal.CountAsync(l => l.Acao == "venda_cancelada", Ct));
        }

        // Duas vezes, não: a segunda é recusada e nada muda.
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            caixa.CancelarVendaFinalizadaAsync(venda, linhas.Select(l => new MovimentoCaixaRegistro
            {
                Id = IdGerador.Novo(),
                SessaoCaixaId = l.SessaoCaixaId,
                Tipo = l.Tipo,
                FormaPagamentoId = l.FormaPagamentoId,
                Valor = l.Valor,
                LojaId = l.LojaId,
                CaixaId = l.CaixaId,
                NumeroCaixa = l.NumeroCaixa,
                TerminalId = l.TerminalId,
                OperadorId = l.OperadorId,
                OcorridoEm = l.OcorridoEm,
            }).ToList(), Evento("venda.cancelada", venda.Id, agora), Ct));
        Assert.Contains("já está cancelada", recusa.Message);
        Assert.Equal(90m, await caixa.DinheiroGavetaAsync(sessao.Id, Ct));

        // A gestão de vendas da sessão lista a cancelada com as formas, e o filtro pelo número a acha.
        var consultas = new ConsultasVendaLocal(banco.Fabrica);
        var lista = Assert.Single(await consultas.VendasDaSessaoAsync(sessao.Id, ct: Ct));
        Assert.Equal((StatusVenda.Cancelada, "Cartão de débito + Dinheiro", true), (lista.Status, lista.Formas, lista.Finalizada));
        Assert.Single(await consultas.VendasDaSessaoAsync(sessao.Id, venda.Numero.ToString(System.Globalization.CultureInfo.InvariantCulture), Ct));
        Assert.Empty(await consultas.VendasDaSessaoAsync(sessao.Id, "99999", Ct));
        Assert.Empty(await consultas.VendasDaSessaoAsync(Guid.CreateVersion7(), ct: Ct));
    }

    [Fact]
    public async Task Venda_de_outra_sessao_nao_cancela_no_caixa()
    {
        var (banco, sessao, caixa) = await PrepararAsync();
        using var _ = banco;
        var repo = new RepositorioVendas(banco.Fabrica, banco.Relogio);
        var agora = banco.Relogio.Agora;
        var antiga = Guid.CreateVersion7();
        var venda = Venda.Iniciar(Guid.CreateVersion7(), await repo.ReservarNumeroVendaAsync(Ct), new ContextoVenda(Terminal, Loja, 1, sessao.CaixaId, 2, antiga),
            Operador, agora);
        venda.AdicionarItem(new ProdutoResolvido(new ProdutoVenda(Guid.CreateVersion7(), 1, null, "GELO", "UN", 15m)), 1m, "44", agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(Dinheiro, 15m, agora);
        venda.Finalizar(agora, Guid.CreateVersion7());
        await repo.EncerrarAsync(venda, null, ct: Ct);

        // Pelo Core (O6). Montado com a sessão da venda, que não é a aberta, o repositório recusa pela sessão.
        Assert.Equal(Venda.MensagemCancelamentoForaDaSessao, Assert.Throws<RegraNegocioException>(() =>
            venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", agora, sessao.Id, Dinheiro.Id)).Message);
        var cancelamento = venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", agora, antiga, Dinheiro.Id);
        var outraSessao = new SessaoCaixaRegistro { Id = antiga, LojaId = Loja, CaixaId = sessao.CaixaId, NumeroCaixa = 2, TerminalId = Terminal };
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() =>
            caixa.CancelarVendaFinalizadaAsync(venda, RepositorioCaixa.LinhasEstorno(outraSessao, venda, cancelamento, IdGerador.Novo),
                Evento("venda.cancelada", venda.Id, agora), Ct));
        Assert.Equal(RepositorioCaixa.MensagemSemSessao, recusa.Message);

        // A venda em memória da sessão aberta, mas gravada noutra (a linha do banco manda): o repositório reconfere a O6
        // dentro da transação.
        var daAberta = await VendaComAsync(banco, sessao.Id, 15m, (Dinheiro, 15m));
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.Vendas.Where(v => v.Id == daAberta.Id).ExecuteUpdateAsync(v => v.SetProperty(x => x.SessaoCaixaId, (Guid?)antiga), Ct);
        }

        var foraDaSessao = await Assert.ThrowsAsync<RegraNegocioException>(() => CancelarAsync(caixa, sessao, daAberta, agora));
        Assert.Equal(Venda.MensagemCancelamentoForaDaSessao, foraDaSessao.Message);
        await using var banco2 = banco.Fabrica.CreateDbContext();
        Assert.All(await banco2.Vendas.ToListAsync(Ct), v => Assert.Equal(StatusVenda.Finalizada, v.Status));
        Assert.Equal(0, await banco2.MovimentosCaixa.CountAsync(m => m.Tipo == TipoMovimentoCaixa.EstornoVenda, Ct));
        Assert.Equal(0, await banco2.EventosSaida.CountAsync(e => e.Tipo == "venda.cancelada", Ct));
    }

    [Fact]
    public async Task Saldo_estimado_devolve_a_baixa_da_venda_cancelada_ate_o_estorno_refletir()
    {
        var (banco, sessao, caixa) = await PrepararAsync();
        using var _ = banco;
        var gelo = Guid.CreateVersion7();
        var estoque = Guid.CreateVersion7();
        var agora = banco.Relogio.Agora;
        await new RepositorioEspelhos(banco.Fabrica).GravarAsync(
            [new LojaRegistro { Id = Loja, Codigo = 1, Nome = "Loja 1", EstoqueId = estoque, CriadoEm = agora, AtualizadoEm = agora, Versao = 1 }], Ct);
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            db.Set<SaldoEstoqueRegistro>().Add(new SaldoEstoqueRegistro
            {
                Id = Guid.CreateVersion7(),
                EstoqueId = estoque,
                ProdutoId = gelo,
                TipoEstoqueId = Guid.CreateVersion7(),
                Quantidade = 10m,
                Versao = 1_000,
                CriadoEm = agora,
                AtualizadoEm = agora,
            });
            db.EstadoSincronizacao.Add(new EstadoSincronizacao { Fluxo = "estoque", Cursor = 1_000 });
            await db.SaveChangesAsync(Ct);
        }

        var consultas = new ConsultasVendaLocal(banco.Fabrica);
        var venda = await VendaPagaAsync(banco, sessao.Id, gelo);
        Assert.Equal(8m, (await consultas.SaldosEstimadosAsync([gelo], Ct))[gelo]);

        var cancelamento = venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", agora, sessao.Id, Dinheiro.Id);
        await caixa.CancelarVendaFinalizadaAsync(venda, RepositorioCaixa.LinhasEstorno(sessao, venda, cancelamento, IdGerador.Novo),
            Evento("venda.cancelada", venda.Id, agora), Ct);
        Assert.Equal(10m, (await consultas.SaldosEstimadosAsync([gelo], Ct))[gelo]);

        // A venda refletida no espelho (saldo 8) com o cancelamento ainda pendente: o estorno volta ao estimado.
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            var finalizada = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.finalizada", Ct);
            (finalizada.Status, finalizada.VersaoNuvem, finalizada.VersaoNuvemFim) = (StatusEventoSaida.Confirmado, 900, 950);
            (await db.Set<SaldoEstoqueRegistro>().SingleAsync(Ct)).Quantidade = 8m;
            await db.SaveChangesAsync(Ct);
        }

        Assert.Equal(10m, (await consultas.SaldosEstimadosAsync([gelo], Ct))[gelo]);

        // O cancelamento confirmado (versões 1100–1150) e ainda não refletido (cursor 1000, linha na versão 1000): o
        // espelho continua com a baixa (8) e o estorno ainda volta ao estimado.
        async Task AjustarAsync(decimal quantidade, long versaoLinha, long cursor)
        {
            await using var db = banco.Fabrica.CreateDbContext();
            var cancelada = await db.EventosSaida.SingleAsync(e => e.Tipo == "venda.cancelada", Ct);
            (cancelada.Status, cancelada.VersaoNuvem, cancelada.VersaoNuvemFim) = (StatusEventoSaida.Confirmado, 1_100, 1_150);
            var saldo = await db.Set<SaldoEstoqueRegistro>().SingleAsync(Ct);
            (saldo.Quantidade, saldo.Versao) = (quantidade, versaoLinha);
            (await db.EstadoSincronizacao.SingleAsync(e => e.Fluxo == "estoque", Ct)).Cursor = cursor;
            await db.SaveChangesAsync(Ct);
        }

        await AjustarAsync(8m, 1_000, 1_000);
        Assert.Equal(10m, (await consultas.SaldosEstimadosAsync([gelo], Ct))[gelo]);

        // Refletido pela linha do saldo (versão 1200, acima da `versao_nuvem` do cancelamento): o espelho já tem o estorno
        // (10) e ele não volta de novo (seriam 12).
        await AjustarAsync(10m, 1_200, 1_000);
        Assert.Equal(10m, (await consultas.SaldosEstimadosAsync([gelo], Ct))[gelo]);

        // Refletido pelo cursor (1200 ≥ `versao_nuvem_fim`), com a linha numa versão anterior: o cancelamento sai da conta.
        await AjustarAsync(10m, 1_000, 1_200);
        Assert.Equal(10m, (await consultas.SaldosEstimadosAsync([gelo], Ct))[gelo]);
    }

    [Fact]
    public async Task Lancamento_a_prazo_cancelado_sai_do_calculado_e_o_quitado_continua()
    {
        var (banco, sessao, caixa) = await PrepararAsync();
        using var _ = banco;
        var agora = banco.Relogio.Agora.AddMinutes(5);
        // Fiado 10,00 (padrão: cancelar o lançamento) + cheque quitado 20,00 cancelado do mesmo jeito; outra venda no fiado
        // (15,00) e uma no fiado devolvida em dinheiro (5,00).
        var cancelada = await VendaComAsync(banco, sessao.Id, 30m, (Fiado, 10m), (Cheque, 20m));
        Assert.Equal(EstornoPagamento.CreditoCancelado, RegrasEstorno.Padrao(cancelada.Pagamentos[0]));
        await CancelarAsync(caixa, sessao, cancelada, agora,
            new Dictionary<Guid, string> { [cancelada.Pagamentos[1].Id] = EstornoPagamento.CreditoCancelado });
        await VendaComAsync(banco, sessao.Id, 15m, (Fiado, 15m));
        var emDinheiro = await VendaComAsync(banco, sessao.Id, 5m, (Fiado, 5m));
        await CancelarAsync(caixa, sessao, emDinheiro, agora,
            new Dictionary<Guid, string> { [emDinheiro.Pagamentos[0].Id] = EstornoPagamento.DevolvidoEmDinheiro });

        var dados = await caixa.ApurarAsync(sessao.Id, Ct);
        var dinheiro = new Core.Caixa.FormaCaixa(Dinheiro.Id, "Dinheiro", "dinheiro");
        var fiado = new Core.Caixa.FormaCaixa(Fiado.Id, "Fiado", "outros");
        var apuracao = Core.Caixa.ApuracaoCaixa.Calcular(sessao.FundoTroco, dados.Pagamentos, dados.Movimentos, dinheiro, [fiado]);
        // O fiado cancelado sai (nada a contar); o devolvido em dinheiro continua no fiado e sai da gaveta; o cheque fica.
        Assert.Equal(20m, apuracao.Formas.Single(f => f.Forma.Id == Fiado.Id).Calculado);
        Assert.Equal(20m, apuracao.Formas.Single(f => f.Forma.Id == Cheque.Id).Calculado);
        Assert.Equal(95m, apuracao.Formas.Single(f => f.Forma.Id == Dinheiro.Id).Calculado);
        Assert.Equal(95m, await caixa.DinheiroGavetaAsync(sessao.Id, Ct));
        Assert.Equal(2, apuracao.Formas.Single(f => f.Forma.Id == Fiado.Id).QuantidadePagamentos);
    }

    [Fact]
    public async Task Pix_devolvido_pelo_banco_grava_a_cobranca_devolvida_com_a_hora_e_o_valor()
    {
        var (banco, sessao, caixa) = await PrepararAsync();
        using var _ = banco;
        var venda = await VendaComAsync(banco, sessao.Id, 30m, (Pix, 30m));
        var agora = banco.Relogio.Agora.AddMinutes(5);
        Assert.Equal(EstornoPagamento.PixDevolucaoManual, RegrasEstorno.Padrao(venda.Pagamentos[0]));
        await CancelarAsync(caixa, sessao, venda, agora);

        await using var db = banco.Fabrica.CreateDbContext();
        var cobranca = await db.CobrancasPix.SingleAsync(Ct);
        // A mesma hora que a nuvem grava (`devolvida_em = cancelada_em`), no milissegundo do texto UTC do SQLite.
        Assert.Equal((StatusCobrancaPix.Devolvida, 30m, (long?)agora.ToUnixTimeMilliseconds()),
            (cobranca.Status, cobranca.ValorDevolvido, cobranca.DevolvidaEm?.ToUnixTimeMilliseconds()));
        var estorno = Assert.Single(await db.MovimentosCaixa.Where(m => m.Tipo == TipoMovimentoCaixa.EstornoVenda).ToListAsync(Ct));
        Assert.Equal((30m, (Guid?)Pix.Id), (estorno.Valor, estorno.FormaPagamentoId));
        // O PIX devolvido não sai da gaveta.
        Assert.Equal(100m, await caixa.DinheiroGavetaAsync(sessao.Id, Ct));
    }

    [Fact]
    public async Task Venda_descartada_no_erp_nao_cancela_no_caixa()
    {
        var (banco, sessao, caixa) = await PrepararAsync();
        using var _ = banco;
        var venda = await VendaComAsync(banco, sessao.Id, 15m, (Dinheiro, 15m));
        var consultas = new ConsultasVendaLocal(banco.Fabrica);
        Assert.False(await consultas.FinalizadaDescartadaAsync(venda.Id, Ct));
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            // O heartbeat grava o `resultado` do descarte da fila de decisão (C8) no `venda.finalizada`.
            await db.EventosSaida.Where(e => e.Tipo == "venda.finalizada")
                .ExecuteUpdateAsync(e => e.SetProperty(x => x.Resultado, """{"descartado":true,"motivo":"duplicada"}"""), Ct);
        }

        Assert.True(await consultas.FinalizadaDescartadaAsync(venda.Id, Ct));
        var recusa = await Assert.ThrowsAsync<RegraNegocioException>(() => CancelarAsync(caixa, sessao, venda, banco.Relogio.Agora));
        Assert.Equal(Venda.MensagemCancelamentoDescartada, recusa.Message);
        await using var banco2 = banco.Fabrica.CreateDbContext();
        Assert.Equal(StatusVenda.Finalizada, (await banco2.Vendas.SingleAsync(Ct)).Status);
        Assert.Equal(0, await banco2.MovimentosCaixa.CountAsync(m => m.Tipo == TipoMovimentoCaixa.EstornoVenda, Ct));
        Assert.Equal(0, await banco2.EventosSaida.CountAsync(e => e.Tipo == "venda.cancelada", Ct));
        Assert.Equal(115m, await caixa.DinheiroGavetaAsync(sessao.Id, Ct));
    }

    [Fact]
    public async Task Filtro_da_gestao_casa_o_numero_inteiro_e_o_novo_numero_da_nuvem()
    {
        var (banco, sessao, _) = await PrepararAsync();
        using var __ = banco;
        var um = await VendaComAsync(banco, sessao.Id, 15m, (Dinheiro, 15m));
        var dois = await VendaComAsync(banco, sessao.Id, 15m, (Dinheiro, 15m));
        var treze = await VendaComAsync(banco, sessao.Id, 15m, (Dinheiro, 15m));
        Assert.Equal((1L, 2L, "L01-C02-000001"), (um.Numero, dois.Numero, um.NumeroExibicao));
        await using (var db = banco.Fabrica.CreateDbContext())
        {
            await db.Vendas.Where(v => v.Id == treze.Id)
                .ExecuteUpdateAsync(v => v.SetProperty(x => x.Numero, 13L).SetProperty(x => x.NumeroExibicao, "L01-C02-000013"), Ct);
            // O "Aplicar com novo número" da fila de decisão (T27): o `resultadoRenumeracao` da nuvem no `venda.finalizada`.
            await db.EventosSaida.Where(e => e.Tipo == "venda.finalizada" && e.AgregadoId == dois.Id)
                .ExecuteUpdateAsync(e => e.SetProperty(x => x.Resultado,
                    $$"""{"venda_id":"{{dois.Id}}","numero_original":2,"numero_exibicao_original":"L01-C02-000002","numero":9000001,"numero_exibicao":"L01-C02-9000001","custo_total":"0.00","movimentos":1}"""), Ct);
            // Outro resultado (aplicado sem renumeração) não vira número novo.
            await db.EventosSaida.Where(e => e.Tipo == "venda.finalizada" && e.AgregadoId == um.Id)
                .ExecuteUpdateAsync(e => e.SetProperty(x => x.Resultado, $$"""{"venda_id":"{{um.Id}}","custo_total":"0.00","movimentos":1}"""), Ct);
        }

        var consultas = new ConsultasVendaLocal(banco.Fabrica);
        // Os números das vendas que o filtro acha, em ordem ("" sem nenhuma).
        async Task<string> NumerosAsync(string filtro) =>
            string.Join(",", (await consultas.VendasDaSessaoAsync(sessao.Id, filtro, Ct)).Select(v => v.Numero).Order());

        var todas = await consultas.VendasDaSessaoAsync(sessao.Id, ct: Ct);
        Assert.Equal([13L, 2L, 1L], todas.Select(v => v.Numero));
        Assert.Equal((string?)"L01-C02-9000001", todas.Single(v => v.Id == dois.Id).NumeroNuvem);
        Assert.All(todas.Where(v => v.Id != dois.Id), v => Assert.Null(v.NumeroNuvem));

        // Os dígitos da loja e do caixa do prefixo ("L01-C02") e os zeros não casam com tudo: o número casa inteiro.
        Assert.Equal("1", await NumerosAsync("1"));
        Assert.Equal("1", await NumerosAsync("000001"));
        Assert.Equal("13", await NumerosAsync("13"));
        Assert.Equal("13", await NumerosAsync("L01-C02-000013"));
        Assert.Equal("2", await NumerosAsync("l01-c02-000002"));
        Assert.Equal(string.Empty, await NumerosAsync("3"));
        Assert.Equal(string.Empty, await NumerosAsync("0"));
        Assert.Equal(string.Empty, await NumerosAsync("C02"));
        // O número novo da nuvem também acha a venda (o que o ERP imprime), além do original do caixa.
        Assert.Equal("2", await NumerosAsync("9000001"));
        Assert.Equal("2", await NumerosAsync("L01-C02-9000001"));
        Assert.Equal("2", await NumerosAsync("2"));
    }
}
