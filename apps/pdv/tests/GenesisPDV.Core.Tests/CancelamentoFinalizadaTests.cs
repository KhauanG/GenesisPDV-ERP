using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Cancelamento da venda finalizada (Fase 1C, bloco C11b; PDV 13.3; <c>venda.cancelada</c> forma A): só na sessão aberta
/// (O6 do dono), a devolução de cada pagamento escolhida pelo operador (O22), uma linha <c>estorno_venda</c> por forma,
/// o documento intacto e o esperado do fechamento contando o estorno uma vez só.
/// </summary>
public class CancelamentoFinalizadaTests
{
    private static readonly Guid Sessao = Guid.Parse("01a18755-98a1-7472-96da-1dac72ff5d2a");

    private static readonly FormaPagamentoInfo Debito = new(Guid.CreateVersion7(), "Cartão de débito", "04", "cartao_debito", PermiteTroco: false,
        LancaQuitada: false, Integracao: IntegracaoForma.PosExterno);

    private static readonly FormaPagamentoInfo Fiado = new(Guid.CreateVersion7(), "Fiado Balcão", "05", "outros", PermiteTroco: false, LancaQuitada: false);

    /// <summary>Venda de R$ 60,00 na sessão: 10,00 no débito, 20,00 no PIX e 30,00 em dinheiro (recebidos 50,00).</summary>
    private static Venda Paga()
    {
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 7, Contexto with { SessaoCaixaId = Sessao }, Operador, Agora);
        venda.AdicionarItem(Produto(60m), 1m, "1", Agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(Debito, 10m, Agora, new DetalhePagamento(2, "06", "Elo"));
        var pix = venda.LancarPagamento(Pix, 20m, Agora, pix: PixConfirmado);
        Assert.Equal(pix.Id, Assert.Single(venda.CobrancasPix).PagamentoVendaId);
        venda.LancarPagamento(Dinheiro, 50m, Agora);
        venda.Finalizar(Agora, Guid.CreateVersion7());
        return venda;
    }

    [Fact]
    public void Padrao_estorna_no_meio_original_e_o_dinheiro_sai_da_gaveta()
    {
        var venda = Paga();
        var (total, troco, dia) = (venda.Total, venda.Troco, venda.DiaOperacional);
        var depois = Agora.AddMinutes(10);

        var c = venda.CancelarFinalizada(Operador, "  Cliente desistiu da compra  ", depois, Sessao, Dinheiro.Id, autorizadoPorId: Supervisor);

        Assert.Equal(
            [EstornoPagamento.PosCanceladoNaMaquininha, EstornoPagamento.PixDevolucaoManual, EstornoPagamento.DinheiroDevolvido],
            c.Estornos.Select(e => e.Estorno));
        // Uma linha por forma, na ordem dos pagamentos; só a do dinheiro sai da gaveta.
        Assert.Equal([new EstornoPorForma(Debito.Id, 10m), new EstornoPorForma(Pix.Id, 20m), new EstornoPorForma(Dinheiro.Id, 30m)], c.Movimentos);
        Assert.Equal((30m, Sessao), (c.SaiDaGaveta, c.SessaoCaixaCancelamentoId));
        Assert.Equal((StatusVenda.Cancelada, depois, (Guid?)Operador, (Guid?)Supervisor, "Cliente desistiu da compra", "pdv"),
            (venda.Status, venda.CanceladaEm, venda.CanceladaPorId, venda.CancelamentoAutorizadoPorId, venda.MotivoCancelamento, venda.CancelamentoOrigem));
        Assert.All(venda.Pagamentos, p => Assert.Equal(StatusPagamento.Estornado, p.Status));
        Assert.Equal(StatusCobrancaPix.Devolvida, Assert.Single(venda.CobrancasPix).Status);
        // O documento é imutável: total, troco, finalização e dia operacional ficam como na venda.
        Assert.Equal((total, troco, dia), (venda.Total, venda.Troco, venda.DiaOperacional));
        Assert.NotNull(venda.FinalizadaEm);
    }

    [Fact]
    public void Cartao_e_pix_devolvidos_em_dinheiro_somam_na_linha_da_forma_dinheiro()
    {
        var venda = Paga();
        var cartao = venda.Pagamentos[0].Id;
        var pix = venda.Pagamentos[1].Id;

        var c = venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", Agora, Sessao, Dinheiro.Id,
            new Dictionary<Guid, string> { [cartao] = EstornoPagamento.DevolvidoEmDinheiro, [pix] = EstornoPagamento.DevolvidoEmDinheiro });

        Assert.Equal([new EstornoPorForma(Dinheiro.Id, 60m)], c.Movimentos);
        Assert.Equal(60m, c.SaiDaGaveta);
        // A transação do PIX continua valendo (O22): a cobrança não é devolvida.
        Assert.Equal(StatusCobrancaPix.Paga, Assert.Single(venda.CobrancasPix).Status);

        // Na apuração da sessão: o pagamento estornado continua somando e o estorno subtrai uma vez (20.4, 21.2).
        var dinheiro = new FormaCaixa(Dinheiro.Id, "Dinheiro", "dinheiro");
        var pagamentos = venda.Pagamentos.Select(p => new PagamentoApurado(new FormaCaixa(p.FormaPagamentoId, p.DescricaoForma, p.TipoForma), p.Valor)).ToList();
        var movimentos = c.Movimentos.Select(m => new MovimentoApurado(TiposMovimento.EstornoVenda, m.Valor, Forma: dinheiro)).ToList();
        var apuracao = ApuracaoCaixa.Calcular(100m, pagamentos, movimentos, dinheiro);
        Assert.Equal(70m, apuracao.DinheiroGaveta);
        Assert.Equal(10m, apuracao.Formas.Single(f => f.Forma.Id == Debito.Id).Calculado);
        Assert.Equal(20m, apuracao.Formas.Single(f => f.Forma.Id == Pix.Id).Calculado);
    }

    [Fact]
    public void Valor_nao_devolvido_e_fiado_cancelado_nao_geram_movimento()
    {
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 8, Contexto with { SessaoCaixaId = Sessao }, Operador, Agora);
        venda.AdicionarItem(Produto(30m), 1m, "1", Agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(Fiado, 10m, Agora);
        venda.LancarPagamento(Dinheiro, 20m, Agora);
        venda.Finalizar(Agora, Guid.CreateVersion7());
        Assert.Equal(EstornoPagamento.CreditoCancelado, RegrasEstorno.Padrao(venda.Pagamentos[0]));

        var c = venda.CancelarFinalizada(Operador, "Cancelamento técnico do caixa", Agora, Sessao, Dinheiro.Id,
            new Dictionary<Guid, string> { [venda.Pagamentos[1].Id] = EstornoPagamento.DinheiroNaoDevolvido });

        Assert.Empty(c.Movimentos);
        Assert.Equal(0m, c.SaiDaGaveta);
        Assert.Equal([EstornoPagamento.CreditoCancelado, EstornoPagamento.DinheiroNaoDevolvido], c.Estornos.Select(e => e.Estorno));
    }

    [Fact]
    public void So_a_venda_paga_da_sessao_aberta_com_motivo_e_estorno_validos()
    {
        // O6: a venda de outra sessão (já fechada) só o ERP cancela, na Fase 3.
        var venda = Paga();
        var outra = Assert.Throws<RegraNegocioException>(() =>
            venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", Agora, Guid.CreateVersion7(), Dinheiro.Id));
        Assert.Equal(Venda.MensagemCancelamentoForaDaSessao, outra.Message);
        Assert.Throws<RegraNegocioException>(() => venda.CancelarFinalizada(Operador, "curto", Agora, Sessao, Dinheiro.Id));
        // A devolução tem de combinar com a forma (a nuvem recusaria com PAYLOAD_INVALIDO): PIX na maquininha, não.
        Assert.Throws<RegraNegocioException>(() => venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", Agora, Sessao, Dinheiro.Id,
            new Dictionary<Guid, string> { [venda.Pagamentos[1].Id] = EstornoPagamento.PosCanceladoNaMaquininha }));
        Assert.Equal(StatusVenda.Finalizada, venda.Status);
        Assert.All(venda.Pagamentos, p => Assert.Equal(StatusPagamento.Aprovado, p.Status));

        venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", Agora, Sessao, Dinheiro.Id);
        Assert.Contains("já está cancelada", Assert.Throws<RegraNegocioException>(() =>
            venda.CancelarFinalizada(Operador, "Cliente desistiu da compra", Agora, Sessao, Dinheiro.Id)).Message);

        // A venda em andamento cancela pela forma B (Shift+F4), não por aqui.
        var aberta = Venda.Iniciar(Guid.CreateVersion7(), 9, Contexto with { SessaoCaixaId = Sessao }, Operador, Agora);
        aberta.AdicionarItem(Produto(5m), 1m, "1", Agora);
        Assert.Throws<RegraNegocioException>(() => aberta.CancelarFinalizada(Operador, "Cliente desistiu da compra", Agora, Sessao, Dinheiro.Id));
    }

    [Fact]
    public void Opcoes_de_devolucao_por_forma_seguem_o_handler_da_nuvem()
    {
        PagamentoVenda Pagamento(string tipo, bool quitada = true) =>
            new(Guid.CreateVersion7(), 1, Guid.CreateVersion7(), tipo, "99", tipo, 10m, null, 0m, StatusPagamento.Aprovado, quitada, 0m);

        Assert.Equal([EstornoPagamento.DinheiroDevolvido, EstornoPagamento.DinheiroNaoDevolvido], RegrasEstorno.Opcoes(Pagamento("dinheiro")).Select(o => o.Estorno));
        foreach (var cartao in new[] { "cartao_credito", "cartao_debito", "vale_alimentacao", "vale_refeicao" })
        {
            Assert.Equal([EstornoPagamento.PosCanceladoNaMaquininha, EstornoPagamento.DevolvidoEmDinheiro], RegrasEstorno.Opcoes(Pagamento(cartao)).Select(o => o.Estorno));
        }

        Assert.Equal([EstornoPagamento.PixDevolucaoManual, EstornoPagamento.DevolvidoEmDinheiro], RegrasEstorno.Opcoes(Pagamento("pix")).Select(o => o.Estorno));
        Assert.Equal([EstornoPagamento.DevolvidoEmDinheiro, EstornoPagamento.CreditoCancelado], RegrasEstorno.Opcoes(Pagamento("outros")).Select(o => o.Estorno));
        Assert.Equal(EstornoPagamento.CreditoCancelado, RegrasEstorno.Padrao(Pagamento("outros", quitada: false)));
        Assert.True(EstornoPagamento.GeraMovimento(EstornoPagamento.PixDevolucaoManual));
        Assert.False(EstornoPagamento.SaiDaGaveta(EstornoPagamento.PixDevolucaoManual));
        Assert.False(EstornoPagamento.GeraMovimento(EstornoPagamento.CreditoCancelado));
    }

    [Fact]
    public void Vazios_trazidos_sao_os_do_bloco_vasilhames()
    {
        var casco = new ProdutoVenda(Guid.CreateVersion7(), 601, null, "GARRAFA 600ML", "UN", 2.50m) { Tipo = TipoProduto.Vasilhame };
        var cheio = new ProdutoVenda(Guid.CreateVersion7(), 600, null, "CERV 600ML", "UN", 9.90m) { VasilhameProdutoId = casco.Id, VasilhameQuantidade = 1 };
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 10, Contexto with { SessaoCaixaId = Sessao }, Operador, Agora);
        var item = venda.AdicionarItem(new ProdutoResolvido(cheio), 3m, "600", Agora);
        venda.RegistrarCascosTrazidos(item.Sequencia, 2m, casco, Agora);

        var vazio = Assert.Single(venda.VaziosTrazidos());
        Assert.Equal((casco.Id, 2m, 1m), (vazio.ProdutoVasilhameId, vazio.Devolvidos, vazio.Vendidos));
    }
}
