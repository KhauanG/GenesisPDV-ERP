using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.CatalogoTeste;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Desconto na venda atual pelo valor do casco (PDV 10.12, devolução avulsa; O14 do dono; Fase 1C, C11c): os vazios além
/// dos devidos viram desconto no total de origem <c>cliente</c>, fora do limite do operador, e entram nos
/// <c>devolvidos</c> do bloco <c>vasilhames</c>.
/// </summary>
public class CascosDescontadosTests
{
    private static readonly Guid Sessao = Guid.Parse("01a18755-98a1-7472-96da-1dac72ff5d2a");

    [Fact]
    public void Cascos_a_mais_viram_desconto_de_origem_cliente_e_devolvidos_no_bloco_vasilhames()
    {
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma()), 6m, "1", Agora);

        var descontado = venda.DescontarCascos(Garrafa, 3, Agora)!;

        Assert.Equal((Garrafa.Id, 3, 2.50m, 7.50m), (descontado.ProdutoVasilhameId, descontado.Quantidade, descontado.PrecoUnitario, descontado.Valor));
        Assert.Equal((20.94m, 7.50m, 7.50m, 13.44m), (venda.SubtotalBruto, venda.DescontoTotal, venda.DescontoCascos, venda.Total));
        Assert.Equal((Venda.OrigemDescontoCliente, (decimal?)null), (venda.DescontoTotalOrigem, venda.DescontoTotalPctDocumento));
        Assert.Equal(7.50m, venda.Itens.Sum(i => i.DescontoRateado));
        Assert.Equal(new ResumoVasilhame(Garrafa.Id, 3m, 0m, 0m, null), Assert.Single(venda.ResumoVasilhames()));
        Assert.Equal(3m, Assert.Single(venda.VaziosTrazidos()).Devolvidos);
    }

    [Fact]
    public void Somam_aos_trazidos_do_item_cheio_e_a_quantidade_substitui_a_anterior()
    {
        var venda = VendaPreco();
        var cerveja = venda.AdicionarItem(Lido(Original600()), 2m, "0600", Agora);
        Assert.Null(venda.RegistrarCascosTrazidos(cerveja.Sequencia, 2m, Garrafa, Agora));

        venda.DescontarCascos(Garrafa, 3, Agora);
        // O preço fica o da primeira vez (snapshot, 11.3): a mudança no espelho não muda o crédito já dado.
        var maisCaro = Garrafa with { PrecoVenda = 3m };
        var substituido = venda.DescontarCascos(maisCaro, 1, Agora.AddMinutes(1))!;

        Assert.Equal((1, 2.50m, Agora), (substituido.Quantidade, substituido.PrecoUnitario, substituido.RegistradoEm));
        Assert.Equal(new ResumoVasilhame(Garrafa.Id, 3m, 0m, 0m, null), Assert.Single(venda.ResumoVasilhames()));
        Assert.Equal(19.80m - 2.50m, venda.Total);

        Assert.Null(venda.DescontarCascos(Garrafa, 0, Agora));
        Assert.Empty(venda.CascosDescontados);
        Assert.Equal((0m, (string?)null, 19.80m), (venda.DescontoTotal, venda.DescontoTotalOrigem, venda.Total));
        Assert.Contains("Nenhum casco", Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Garrafa, 0, Agora)).Message);
    }

    [Fact]
    public void Desconto_do_operador_vem_por_cima_dos_cascos_e_os_cascos_nao_contam_no_limite()
    {
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma()), 10m, "1", Agora);
        venda.DescontarCascos(Garrafa, 4, Agora);

        // 10% de 34,90 = 3,49: dentro do limite de 10% mesmo com os R$ 10,00 dos cascos (28,65% da venda).
        var r = venda.AplicarDescontoTotal(Desconto.EmPercentual(10m), 10m);

        Assert.True(r.Aplicado);
        Assert.False(r.PorLiberacao);
        Assert.Equal((13.49m, 10m, (decimal?)null), (venda.DescontoTotal, venda.DescontoTotalPct, venda.DescontoTotalPctDocumento));
        Assert.Equal(Venda.OrigemDescontoOperador, venda.DescontoTotalOrigem);

        // Um item a mais refaz o % do operador; os cascos continuam R$ 10,00.
        venda.AdicionarItem(Lido(Brahma()), 1m, "1", Agora);
        Assert.Equal(3.84m + 10m, venda.DescontoTotal);

        venda.RemoverDescontoTotal();
        Assert.Equal((10m, Venda.OrigemDescontoCliente, (decimal?)null), (venda.DescontoTotal, venda.DescontoTotalOrigem, venda.DescontoTotalPct));
        Assert.Contains("F11", Assert.Throws<RegraNegocioException>(venda.RemoverDescontoTotal).Message);
        Assert.Equal(10m, venda.DescontoTotal);
    }

    [Fact]
    public void Desconto_do_operador_cabe_so_no_que_sobra_depois_dos_cascos()
    {
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Produto("GELO 5KG", 10m)), 1m, "1", Agora);
        venda.DescontarCascos(Garrafa, 3, Agora);

        // Máximo da venda: 9,99 (o item fica com R$ 0,01); os cascos já ocupam 7,50.
        Assert.Contains("2,49", Assert.Throws<RegraNegocioException>(() =>
            venda.AplicarDescontoTotal(Desconto.EmReais(2.50m), 100m)).Message);
        Assert.True(venda.AplicarDescontoTotal(Desconto.EmReais(2.49m), 100m).Aplicado);
        Assert.Equal(0.01m, venda.Total);
    }

    [Fact]
    public void Cascos_depois_do_desconto_do_operador_cabem_so_no_que_sobra_e_a_recusa_nao_tira_o_desconto_liberado()
    {
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Produto("GELO 5KG", 10m)), 1m, "1", Agora);
        // R$ 5,00 (50%) acima do limite de 10% do operador: o supervisor libera.
        Assert.True(venda.AplicarDescontoTotal(Desconto.EmReais(5m), 10m, new Liberacao(Supervisor, 100m, "Cliente fidelidade", Agora)).PorLiberacao);
        venda.ConsumirAvisos();

        // Máximo 9,99 com o do operador em 5,00: o crédito de 2 garrafas (5,00) não cabe, e a recusa diz quanto cabe.
        var recusa = Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Garrafa, 2, Agora)).Message;
        Assert.Contains("cabem até R$ 4,99", recusa);
        Assert.Contains("F6 › 4", recusa);
        Assert.Empty(venda.CascosDescontados);
        Assert.Equal((5m, Venda.OrigemDescontoOperador, 5m), (venda.DescontoTotal, venda.DescontoTotalOrigem, venda.Total));
        Assert.Equal(AcaoLiberacao.DescontoTotal, Assert.Single(venda.Liberacoes).Acao);
        Assert.Empty(venda.ConsumirAvisos());

        // O que cabe passa, com o desconto do operador intacto.
        venda.DescontarCascos(Garrafa, 1, Agora);
        Assert.Equal((7.50m, Venda.OrigemDescontoOperador, 2.50m), (venda.DescontoTotal, venda.DescontoTotalOrigem, venda.Total));
        Assert.Empty(venda.ConsumirAvisos());
    }

    [Fact]
    public void Cheio_incluido_depois_do_desconto_usa_primeiro_os_vazios_ja_descontados()
    {
        // O cliente trouxe 5 garrafas: o operador descontou na lata e só depois passou as cervejas retornáveis.
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma()), 6m, "1", Agora);
        venda.DescontarCascos(Garrafa, 5, Agora);
        venda.ConsumirAvisos();

        var cerveja = venda.AdicionarItem(Lido(Original600()), 2m, "0600", Agora);

        // 2 dos 5 vazios cobrem os devidos: 2 trazidos + 3 descontados (R$ 7,50), não 2 + 5.
        Assert.Equal(3, Assert.Single(venda.CascosDescontados).Quantidade);
        Assert.Equal(7.50m, venda.DescontoCascos);
        Assert.Contains(venda.ConsumirAvisos(), a => a.Contains("2 casco(s) GARRAFA") && a.Contains("passaram a trazidos do item 2"));
        Assert.Null(venda.RegistrarCascosTrazidos(cerveja.Sequencia, 2m, Garrafa, Agora));
        Assert.Equal(new ResumoVasilhame(Garrafa.Id, 5m, 0m, 0m, null), Assert.Single(venda.ResumoVasilhames()));

        // Aumentar o cheio também abate; sem descontados para cobrir, o resto é a pergunta de sempre (aqui, 1 cobrado).
        venda.AlterarQuantidade(cerveja.Sequencia, 4m, 10m);
        Assert.Equal(1, Assert.Single(venda.CascosDescontados).Quantidade);
        venda.AlterarQuantidade(cerveja.Sequencia, 6m, 10m);
        Assert.Empty(venda.CascosDescontados);
        Assert.Contains(venda.ConsumirAvisos(), a => a.Contains("desconto dos cascos retirado"));
        Assert.Equal(1m, venda.RegistrarCascosTrazidos(cerveja.Sequencia, 5m, Garrafa, Agora)!.Quantidade);
        Assert.Equal(new ResumoVasilhame(Garrafa.Id, 5m, 1m, 0m, null), Assert.Single(venda.ResumoVasilhames()));
        Assert.Equal(0m, venda.DescontoTotal);
    }

    [Fact]
    public void Liberacao_do_supervisor_vira_a_linha_desconto_cascos_e_o_preview_do_credito_usa_o_preco_fixado()
    {
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma()), 10m, "1", Agora);
        Assert.Equal(7.50m, venda.DescontoCascosCom(Garrafa, 3, Agora));
        venda.DescontarCascos(Garrafa, 3, Agora, new Liberacao(Supervisor, 0m, " Duas grades ", Agora));

        var linha = Assert.Single(venda.Liberacoes);
        Assert.Equal((AcaoLiberacao.DescontoCascos, (Guid?)null, (decimal?)null, Supervisor, "Duas grades"),
            (linha.Acao, linha.ItemVendaId, linha.ValorPct, linha.AutorizadoPorId, linha.Motivo));
        // O preço da primeira vez fica (snapshot): o espelho mais caro não muda a conta do teto.
        Assert.Equal(10m, venda.DescontoCascosCom(Garrafa with { PrecoVenda = 3m }, 4, Agora));
        Assert.Equal(0m, venda.DescontoCascosCom(Garrafa, 0, Agora));
    }

    [Fact]
    public void Recusas_nao_mudam_a_venda()
    {
        var vazia = VendaPreco();
        Assert.Contains("Inclua", Assert.Throws<RegraNegocioException>(() => vazia.DescontarCascos(Garrafa, 1, Agora)).Message);

        var venda = VendaPreco();
        var cerveja = venda.AdicionarItem(Lido(Original600()), 1m, "0600", Agora);
        Assert.Contains("passaria do total", Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Garrafa, 4, Agora)).Message);
        Assert.Empty(venda.CascosDescontados);
        Assert.Equal(9.90m, venda.Total);

        Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Garrafa, -1, Agora));
        Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Garrafa, Venda.MaximoCascosDescontados + 1, Agora));
        Assert.Contains("não é um casco", Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Brahma(), 1, Agora)).Message);
        Assert.Contains("sem preço", Assert.Throws<RegraNegocioException>(() =>
            venda.DescontarCascos(Garrafa with { PrecoVenda = 0m }, 1, Agora)).Message);

        // O casco ainda cobrado no item cheio: o cliente trouxe os vazios, então são trazidos, não desconto.
        venda.RegistrarCascosTrazidos(cerveja.Sequencia, 0m, Garrafa, Agora);
        Assert.Contains("cobrado", Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Garrafa, 1, Agora)).Message);
        venda.RegistrarCascosTrazidos(cerveja.Sequencia, 1m, Garrafa, Agora);
        venda.DescontarCascos(Garrafa, 1, Agora);
        // …e o inverso: com o casco descontado, cobrar o mesmo casco é recusado.
        Assert.Contains("descontado", Assert.Throws<RegraNegocioException>(() =>
            venda.RegistrarCascosTrazidos(cerveja.Sequencia, 0m, Garrafa, Agora)).Message);
        Assert.Equal(1, Assert.Single(venda.CascosDescontados).Quantidade);

        venda.IniciarPagamento();
        venda.LancarPagamento(Dinheiro, 5m, Agora);
        Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Garrafa, 2, Agora));
        Assert.Throws<RegraNegocioException>(() => venda.DescontarCascos(Garrafa, 0, Agora));
        Assert.Equal((7.40m, 1), (venda.Total, Assert.Single(venda.CascosDescontados).Quantidade));
    }

    [Fact]
    public void Item_cancelado_que_deixa_o_credito_maior_que_o_total_tira_os_cascos_com_aviso()
    {
        var venda = VendaPreco();
        var gelo = venda.AdicionarItem(Lido(Produto("GELO 5KG", 10m)), 1m, "1", Agora);
        venda.AdicionarItem(Lido(Produto("CARVAO 3KG", 2m)), 1m, "2", Agora);
        venda.DescontarCascos(Garrafa, 3, Agora);
        venda.ConsumirAvisos();

        venda.CancelarItem(gelo.Sequencia, Operador, Agora, 0m);

        Assert.Empty(venda.CascosDescontados);
        Assert.Empty(venda.ResumoVasilhames());
        Assert.Equal((0m, (string?)null, 2m), (venda.DescontoTotal, venda.DescontoTotalOrigem, venda.Total));
        Assert.Contains(venda.ConsumirAvisos(), a => a.Contains("Desconto dos cascos de R$ 7,50 removido"));
    }

    [Fact]
    public void Venda_recuperada_separa_a_parte_do_operador_do_credito_dos_cascos()
    {
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma()), 10m, "1", Agora);
        venda.DescontarCascos(Garrafa, 2, Agora);
        venda.AplicarDescontoTotal(Desconto.EmReais(1.90m), 10m);
        Assert.Equal(6.90m, venda.DescontoTotal);

        var estado = new EstadoVenda(
            venda.Id, venda.Numero, venda.NumeroExibicao, venda.LojaId, venda.CaixaId, venda.NumeroCaixa, venda.TerminalId, venda.SessaoCaixaId,
            venda.Modo, venda.Status, venda.StatusFiscal, venda.OperadorId, venda.TipoPreco, venda.DescontoTotal, venda.DescontoTotalPct,
            venda.AcrescimoTotal, venda.IniciadaEm, DescontoTotalOrigem: venda.DescontoTotalOrigem);
        var recuperada = Venda.Restaurar(estado, venda.Itens, venda.Pagamentos, cascosDescontados: venda.CascosDescontados);

        Assert.Equal((6.90m, 5m, venda.Total), (recuperada.DescontoTotal, recuperada.DescontoCascos, recuperada.Total));
        Assert.Equal(Venda.OrigemDescontoOperador, recuperada.DescontoTotalOrigem);
        recuperada.DescontarCascos(Garrafa, 0, Agora);
        Assert.Equal((1.90m, Venda.OrigemDescontoOperador), (recuperada.DescontoTotal, recuperada.DescontoTotalOrigem));
    }

    [Fact]
    public void Cancelar_a_venda_paga_devolve_os_cascos_descontados_e_o_que_foi_pago()
    {
        var venda = Venda.Iniciar(Guid.CreateVersion7(), 10, Contexto with { SessaoCaixaId = Sessao }, Operador, Agora);
        var cerveja = venda.AdicionarItem(Lido(Original600()), 2m, "0600", Agora);
        venda.RegistrarCascosTrazidos(cerveja.Sequencia, 2m, Garrafa, Agora);
        venda.DescontarCascos(Garrafa, 2, Agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(Dinheiro, 20m, Agora);
        venda.Finalizar(Agora, Guid.CreateVersion7());

        var cancelamento = venda.CancelarFinalizada(Operador, "Cliente desistiu da compra toda", Agora.AddMinutes(1), Sessao, Dinheiro.Id);

        // D29: os 4 vazios (2 trazidos + 2 descontados) voltam; o dinheiro devolvido é o pago, já com o crédito dos cascos.
        Assert.Equal(new ResumoVasilhame(Garrafa.Id, 4m, 0m, 0m, null), Assert.Single(venda.VaziosTrazidos()));
        Assert.Equal((14.80m, 14.80m), (venda.Total, cancelamento.SaiDaGaveta));
    }
}
