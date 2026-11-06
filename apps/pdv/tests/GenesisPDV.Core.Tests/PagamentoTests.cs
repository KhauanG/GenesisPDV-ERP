using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

public class PagamentoTests
{
    [Fact]
    public void Pagamento_exige_item()
    {
        var venda = NovaVenda();
        Assert.Throws<RegraNegocioException>(venda.IniciarPagamento);
    }

    [Fact]
    public void Dinheiro_com_troco_grava_valor_sem_troco()
    {
        var venda = VendaComItens(45.18m);
        venda.IniciarPagamento();
        var pagamento = venda.LancarPagamento(Dinheiro, 50m, Agora);
        Assert.Equal(45.18m, pagamento.Valor);
        Assert.Equal(50m, pagamento.ValorRecebido);
        Assert.Equal(4.82m, pagamento.Troco);
        Assert.Equal(4.82m, venda.Troco);
        Assert.Equal(0m, venda.Falta);
        Assert.Equal(venda.Total, venda.Pagamentos.Sum(p => p.Valor));
        Assert.Equal(new DateOnly(2026, 10, 29), pagamento.DataPagamento);
    }

    [Fact]
    public void Pagamento_misto_pix_e_dinheiro_exemplo_do_wireframe()
    {
        var venda = VendaComItens(75.18m);
        venda.IniciarPagamento();
        venda.LancarPagamento(Pix, 30m, Agora, pix: PixConfirmado);
        Assert.Equal(45.18m, venda.Falta);
        venda.LancarPagamento(Dinheiro, 50m, Agora);
        Assert.Equal(80m, venda.Recebido);
        Assert.Equal(4.82m, venda.Troco);
        Assert.Equal(75.18m, venda.Pago);
    }

    [Fact]
    public void Forma_sem_troco_nao_aceita_valor_maior_que_a_falta()
    {
        var venda = VendaComItens(10m);
        venda.IniciarPagamento();
        var erro = Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(Pix, 10.01m, Agora, pix: PixConfirmado));
        Assert.Contains("não permite troco", erro.Message);
        Assert.Empty(venda.Pagamentos);
    }

    [Fact]
    public void Valor_exato_nao_gera_troco()
    {
        var venda = VendaComItens(10m);
        venda.IniciarPagamento();
        var pagamento = venda.LancarPagamento(Dinheiro, 10m, Agora);
        Assert.Equal(0m, pagamento.Troco);
        Assert.Equal(0m, venda.Troco);
    }

    [Fact]
    public void Nao_aceita_pagamento_com_venda_quitada_nem_valor_invalido()
    {
        var venda = VendaComItens(10m);
        venda.IniciarPagamento();
        Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(Dinheiro, 0m, Agora));
        Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(Dinheiro, 1.001m, Agora));
        venda.LancarPagamento(Dinheiro, 10m, Agora);
        Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(Dinheiro, 1m, Agora));
    }

    [Fact]
    public void Nao_inclui_item_durante_pagamento_e_esc_volta_mantendo_pagamentos()
    {
        var venda = VendaComItens(10m);
        venda.IniciarPagamento();
        venda.LancarPagamento(Pix, 4m, Agora, pix: PixConfirmado);
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Produto(1m), 1m, "1", Agora));
        venda.VoltarParaItens();
        Assert.Equal(StatusVenda.EmAndamento, venda.Status);
        Assert.Single(venda.PagamentosAtivos);
        venda.AdicionarItem(Produto(1m), 1m, "1", Agora);
        Assert.Equal(7m, venda.Falta);
    }

    [Fact]
    public void Com_pagamento_lancado_nao_reduz_o_total()
    {
        var venda = VendaComItens(10m, 5m);
        venda.IniciarPagamento();
        venda.LancarPagamento(Pix, 12m, Agora, pix: PixConfirmado);
        venda.VoltarParaItens();
        Assert.Throws<RegraNegocioException>(() => venda.CancelarItem(1, Operador, Agora, 100m));
        Assert.Throws<RegraNegocioException>(() => venda.AplicarDescontoTotal(Desconto.EmReais(1m), 100m));
        venda.IniciarPagamento();
        venda.RemoverPagamento(1);
        Assert.Equal(StatusPagamento.Cancelado, venda.Pagamentos[0].Status);
        venda.VoltarParaItens();
        venda.CancelarItem(1, Operador, Agora, 100m);
        Assert.Equal(5m, venda.Total);
    }

    [Fact]
    public void Finalizar_exige_pagamento_completo()
    {
        var venda = VendaComItens(10m);
        venda.IniciarPagamento();
        venda.LancarPagamento(Pix, 4m, Agora, pix: PixConfirmado);
        var erro = Assert.Throws<RegraNegocioException>(() => venda.Finalizar(Agora, Guid.CreateVersion7()));
        Assert.Contains("Falta R$ 6,00", erro.Message);
    }

    [Fact]
    public void Finalizar_grava_datas_evento_e_dia_operacional_no_fuso_da_loja()
    {
        // 02:30 UTC de 30/10 = 23:30 de 29/10 em São Paulo.
        var agora = new DateTimeOffset(2026, 10, 30, 2, 30, 0, TimeSpan.Zero);
        var venda = VendaComItens(10m);
        venda.IniciarPagamento();
        venda.LancarPagamento(Dinheiro, 20m, agora);
        var eventoId = Guid.CreateVersion7();
        venda.Finalizar(agora, eventoId);
        Assert.Equal(StatusVenda.Finalizada, venda.Status);
        Assert.Equal(agora, venda.FinalizadaEm);
        Assert.Equal(eventoId, venda.EventoFinalizacaoId);
        Assert.Equal(new DateOnly(2026, 10, 29), venda.DiaOperacional);
        Assert.Equal(StatusFiscal.NaoAplicavel, venda.StatusFiscal);
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Produto(1m), 1m, "1", agora));
        Assert.Throws<RegraNegocioException>(() => venda.Cancelar(Operador, "x", agora));
    }

    [Fact]
    public void Cancelar_venda_em_andamento_exige_motivo_e_cancela_pagamentos()
    {
        var venda = VendaComItens(10m);
        venda.IniciarPagamento();
        venda.LancarPagamento(Pix, 4m, Agora, pix: PixConfirmado);
        Assert.Throws<RegraNegocioException>(() => venda.Cancelar(Operador, "", Agora));
        // O6 (dono): de 15 a 255 caracteres, contados sem os espaços das pontas (é o que vai no venda.cancelada).
        Assert.Throws<RegraNegocioException>(() => venda.Cancelar(Operador, "   Desistiu    ", Agora));
        Assert.Throws<RegraNegocioException>(() => venda.Cancelar(Operador, new string('x', 256), Agora));
        venda.Cancelar(Operador, "Cliente desistiu", Agora);
        Assert.Equal(StatusVenda.Cancelada, venda.Status);
        Assert.Equal("pdv", venda.CancelamentoOrigem);
        Assert.All(venda.Pagamentos, p => Assert.Equal(StatusPagamento.Cancelado, p.Status));
    }

    [Fact]
    public void Restaurar_reconstroi_totais_a_partir_dos_itens()
    {
        var original = VendaComItens(10m, 20m, 30.01m);
        original.AplicarDescontoTotal(Desconto.EmReais(5m), 100m);
        original.CancelarItem(1, Operador, Agora, 100m);
        original.IniciarPagamento();
        original.LancarPagamento(Pix, 10m, Agora, pix: PixConfirmado);

        var estado = new EstadoVenda(original.Id, original.Numero, original.NumeroExibicao, original.LojaId, original.CaixaId,
            original.NumeroCaixa, original.TerminalId, original.SessaoCaixaId, original.Modo, original.Status, original.StatusFiscal,
            original.OperadorId, original.TipoPreco, original.DescontoTotal, original.DescontoTotalPct, original.AcrescimoTotal,
            original.IniciadaEm);
        var restaurada = Venda.Restaurar(estado, original.Itens, original.Pagamentos);
        Assert.Equal(original.Total, restaurada.Total);
        Assert.Equal(original.Falta, restaurada.Falta);
        Assert.Equal(original.QtdItens, restaurada.QtdItens);
        Assert.Equal(StatusVenda.EmPagamento, restaurada.Status);
    }

    [Fact]
    public void Maximo_de_pagamentos()
    {
        var venda = VendaComItens(100m);
        venda.IniciarPagamento();
        for (var i = 0; i < Venda.MaximoPagamentos; i++)
        {
            venda.LancarPagamento(Pix, 1m, Agora, pix: PixConfirmado);
        }

        Assert.Throws<RegraNegocioException>(() => venda.LancarPagamento(Pix, 1m, Agora, pix: PixConfirmado));
    }

    [Fact]
    public void Diminuir_acrescimo_com_pagamento_lancado_e_recusado()
    {
        var venda = VendaComItens(10m);
        venda.AplicarAcrescimoTotal(5m);
        venda.IniciarPagamento();
        venda.LancarPagamento(Pix, 15m, Agora, pix: PixConfirmado);
        venda.VoltarParaItens();
        Assert.Throws<RegraNegocioException>(() => venda.AplicarAcrescimoTotal(0m));
        Assert.Equal(15m, venda.Total);

        // Aumentar não quebra Σ pagamentos ≤ total.
        venda.AplicarAcrescimoTotal(6m);
        Assert.Equal(1m, venda.Falta);
    }

    [Fact]
    public void Finalizar_com_pagamentos_acima_do_total_tem_mensagem_propria()
    {
        var original = VendaComItens(10m, 5m);
        original.IniciarPagamento();
        original.LancarPagamento(Pix, 15m, Agora, pix: PixConfirmado);
        var estado = new EstadoVenda(original.Id, original.Numero, original.NumeroExibicao, original.LojaId, original.CaixaId,
            original.NumeroCaixa, original.TerminalId, original.SessaoCaixaId, original.Modo, original.Status, original.StatusFiscal,
            original.OperadorId, original.TipoPreco, 0m, null, 0m, original.IniciadaEm);
        var venda = Venda.Restaurar(estado, original.Itens.Where(i => i.Sequencia == 1), original.Pagamentos);
        var erro = Assert.Throws<RegraNegocioException>(() => venda.Finalizar(Agora, Guid.CreateVersion7()));
        Assert.Contains("passam do total", erro.Message);
        Assert.Equal(StatusVenda.EmPagamento, venda.Status);
    }
}
