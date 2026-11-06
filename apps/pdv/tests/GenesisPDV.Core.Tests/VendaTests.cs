using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

public class VendaTests
{
    [Fact]
    public void Inicia_em_andamento_com_numero_de_exibicao()
    {
        var venda = NovaVenda(123);
        Assert.Equal(StatusVenda.EmAndamento, venda.Status);
        Assert.Equal("L01-C02-000123", venda.NumeroExibicao);
        Assert.Equal(0m, venda.Total);
        Assert.Equal("pdv", venda.Tipo);
        Assert.Equal("balcao", venda.Modo);
    }

    [Fact]
    public void Adiciona_itens_e_soma_totais()
    {
        var venda = NovaVenda();
        venda.AdicionarItem(Produto(3.49m, "CERV BRAHMA LT 350ML"), 12m, "7891149103102", Agora);
        venda.AdicionarItem(Produto(2.50m, "ÁGUA CRYSTAL 500ML"), 2m, "7896045506873", Agora);
        Assert.Equal(2, venda.QtdItens);
        Assert.Equal(46.88m, venda.SubtotalBruto);
        Assert.Equal(46.88m, venda.Total);
        Assert.Equal(14m, venda.VolumeTotal);
        Assert.Equal([1, 2], venda.Itens.Select(i => i.Sequencia));
        Assert.Equal(41.88m, venda.Itens[0].ValorBruto);
    }

    [Fact]
    public void Item_pesado_aceita_quantidade_decimal_e_arredonda_valor_bruto()
    {
        var venda = NovaVenda();
        var item = venda.AdicionarItem(Produto(19.99m, "QUEIJO COALHO KG", "KG"), 0.795m, "0050", Agora);
        Assert.Equal(15.89m, item.ValorBruto);
    }

    [Fact]
    public void Produto_por_unidade_recusa_quantidade_decimal()
    {
        var venda = NovaVenda();
        var erro = Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Produto(1m), 1.5m, "1", Agora));
        Assert.Contains("quantidade inteira", erro.Message);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("10000")]
    [InlineData("1.0001")]
    public void Quantidade_fora_dos_limites_e_recusada(string qtd)
    {
        var venda = NovaVenda();
        Assert.Throws<RegraNegocioException>(() =>
            venda.AdicionarItem(Produto(1m, unidade: "KG"), decimal.Parse(qtd, System.Globalization.CultureInfo.InvariantCulture), "1", Agora));
    }

    [Fact]
    public void Produto_inativo_sem_preco_ou_nao_vendavel_e_recusado()
    {
        var venda = NovaVenda();
        var inativo = new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 1, null, "X", "UN", 1m, Ativo: false));
        var semPreco = new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 1, null, "X", "UN", 0m));
        var insumo = new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 1, null, "X", "UN", 1m, Vendavel: false));
        Assert.Contains("inativo", Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(inativo, 1, "1", Agora)).Message);
        Assert.Contains("sem preço", Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(semPreco, 1, "1", Agora)).Message);
        Assert.Contains("não é vendável", Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(insumo, 1, "1", Agora)).Message);
        Assert.Empty(venda.Itens);
    }

    [Fact]
    public void Embalagem_multiplica_pelo_fator()
    {
        var venda = NovaVenda();
        var fardo = new ProdutoResolvido(new ProdutoVenda(Guid.NewGuid(), 1, null, "CERV", "UN", 3.49m), Guid.NewGuid(), 12m);
        var item = venda.AdicionarItem(fardo, 3m, "17891149103109", Agora);
        Assert.Equal(36m, item.Quantidade);
        Assert.Equal(125.64m, item.ValorBruto);
        Assert.Equal(fardo.CodigoBarrasId, item.CodigoBarrasId);
    }

    [Fact]
    public void Agrupa_mesmo_produto_quando_ligado_mas_nao_itens_pesados_nem_com_desconto()
    {
        var venda = NovaVenda();
        var produto = Produto(2m);
        venda.AdicionarItem(produto, 1m, "1", Agora, agrupar: true);
        venda.AdicionarItem(produto, 2m, "1", Agora, agrupar: true);
        Assert.Single(venda.Itens);
        Assert.Equal(3m, venda.Itens[0].Quantidade);
        Assert.Equal(6m, venda.Total);

        venda.AplicarDescontoItem(1, Desconto.EmReais(0.50m), 100m);
        venda.AdicionarItem(produto, 1m, "1", Agora, agrupar: true);
        Assert.Equal(2, venda.Itens.Count);

        var pesado = Produto(10m, unidade: "KG");
        venda.AdicionarItem(pesado, 0.5m, "2", Agora, agrupar: true);
        venda.AdicionarItem(pesado, 0.5m, "2", Agora, agrupar: true);
        Assert.Equal(4, venda.Itens.Count);
    }

    [Fact]
    public void Altera_quantidade_e_incrementa_ultimo_item()
    {
        var venda = VendaComItens(2.50m);
        venda.AlterarQuantidade(1, 4m, 100m);
        Assert.Equal(10m, venda.Total);
        venda.IncrementarUltimoItem(1, 100m);
        Assert.Equal(5m, venda.Itens[0].Quantidade);
        venda.IncrementarUltimoItem(-1, 100m);
        venda.IncrementarUltimoItem(-1, 100m);
        Assert.Equal(3m, venda.Itens[0].Quantidade);
    }

    [Fact]
    public void Decrementar_nao_vai_abaixo_de_um()
    {
        var venda = VendaComItens(2.50m);
        Assert.Throws<RegraNegocioException>(() => venda.IncrementarUltimoItem(-1, 100m));
    }

    [Fact]
    public void Cancelar_item_mantem_a_linha_e_sai_dos_totais()
    {
        var venda = VendaComItens(10m, 9.99m, 5m);
        venda.CancelarItem(2, Operador, Agora, 100m, motivo: "Cliente desistiu");
        var cancelado = venda.ObterItem(2);
        Assert.True(cancelado.Cancelado);
        Assert.Equal(Operador, cancelado.CanceladoPorId);
        Assert.Equal(Agora, cancelado.CanceladoEm);
        Assert.Equal(3, venda.Itens.Count);
        Assert.Equal(2, venda.QtdItens);
        Assert.Equal(15m, venda.Total);
        Assert.Throws<RegraNegocioException>(() => venda.CancelarItem(2, Operador, Agora, 100m));
    }

    [Fact]
    public void Nova_linha_apos_cancelamento_nao_reaproveita_sequencia()
    {
        var venda = VendaComItens(1m, 2m);
        venda.CancelarItem(2, Operador, Agora, 100m);
        var novo = venda.AdicionarItem(Produto(3m), 1m, "3", Agora);
        Assert.Equal(3, novo.Sequencia);
    }

    [Fact]
    public void Cancelamento_parcial_cria_linha_com_o_restante()
    {
        var venda = NovaVenda();
        venda.AdicionarItem(Produto(3.49m), 12m, "789", Agora);
        var restante = venda.CancelarItem(1, Operador, Agora, 100m, quantidade: 2m);
        Assert.NotNull(restante);
        Assert.Equal(2, restante.Sequencia);
        Assert.Equal(10m, restante.Quantidade);
        Assert.True(venda.ObterItem(1).Cancelado);
        Assert.Equal(34.90m, venda.Total);
    }

    [Fact]
    public void Desconto_no_item_em_reais_e_percentual()
    {
        var venda = VendaComItens(10m, 20m);
        Assert.True(venda.AplicarDescontoItem(1, Desconto.EmReais(0.50m), 10m).Aplicado);
        Assert.Equal(0.50m, venda.DescontoItens);
        Assert.Equal(29.50m, venda.Total);
        // Substitui o desconto anterior do item.
        venda.AplicarDescontoItem(1, Desconto.EmPercentual(10m), 10m);
        Assert.Equal(1.00m, venda.ObterItem(1).DescontoItem);
        Assert.Equal(29.00m, venda.Total);
        Assert.Equal(9.00m, venda.ObterItem(1).ValorLiquido);
    }

    [Fact]
    public void Desconto_no_item_deve_ser_menor_que_o_valor_bruto()
    {
        var venda = VendaComItens(10m);
        Assert.Throws<RegraNegocioException>(() => venda.AplicarDescontoItem(1, Desconto.EmReais(10m), 100m));
        Assert.Throws<RegraNegocioException>(() => venda.AplicarDescontoItem(1, Desconto.EmReais(0m), 100m));
    }

    [Fact]
    public void Limite_de_desconto_10_porcento_aplica_sem_senha_e_10_01_pede_liberacao()
    {
        var venda = VendaComItens(100m);
        Assert.Equal(SituacaoDesconto.Aplicado, venda.AplicarDescontoItem(1, Desconto.EmPercentual(10m), 10m).Situacao);
        var pedido = venda.AplicarDescontoItem(1, Desconto.EmPercentual(10.01m), 10m);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, pedido.Situacao);
        Assert.Equal(10.01m, pedido.PercentualPedido);
        // Não aplicou: continua o desconto anterior.
        Assert.Equal(10m, venda.ObterItem(1).DescontoItem);
    }

    [Fact]
    public void Supervisor_com_limite_menor_nao_libera_e_com_limite_maior_libera()
    {
        var venda = VendaComItens(100m);
        var fraco = venda.AplicarDescontoTotal(Desconto.EmPercentual(15m), 10m, new Liberacao(Supervisor, 12m, "Cliente fidelidade", Agora));
        Assert.Equal(SituacaoDesconto.LiberacaoInsuficiente, fraco.Situacao);
        Assert.Equal(0m, venda.DescontoTotal);
        Assert.Empty(venda.Liberacoes);

        var forte = venda.AplicarDescontoTotal(Desconto.EmPercentual(15m), 10m, new Liberacao(Supervisor, 20m, "Cliente fidelidade", Agora));
        Assert.True(forte.Aplicado);
        Assert.Equal(15m, venda.DescontoTotal);
        Assert.Equal(85m, venda.Total);

        // A liberação usada sobe no `liberacoes` do venda.finalizada (sincronizacao.md 9.7).
        var liberacao = Assert.Single(venda.Liberacoes);
        Assert.Equal((AcaoLiberacao.DescontoTotal, (Guid?)null, Supervisor, "Cliente fidelidade", Agora), (liberacao.Acao, liberacao.ItemVendaId, liberacao.AutorizadoPorId, liberacao.Motivo, liberacao.OcorridoEm));
    }

    [Fact]
    public void Liberacao_exige_motivo()
    {
        var venda = VendaComItens(100m);
        Assert.Throws<RegraNegocioException>(() =>
            venda.AplicarDescontoTotal(Desconto.EmPercentual(15m), 10m, new Liberacao(Supervisor, 20m, " ", Agora)));
    }

    [Fact]
    public void Liberacao_dentro_do_limite_do_operador_nao_e_usada_nem_registrada()
    {
        // O diálogo do supervisor pode montar a liberação antes de saber se precisa (motivo em branco), ou o operador
        // reaplica um desconto menor com a mesma liberação: dentro do limite dele, nada vai em `liberacoes`, o item não
        // fica com o supervisor em `autorizado_por_id` e o `motivo: ""` não chega ao payload (a nuvem o recusaria).
        var venda = VendaComItens(100m, 50m);
        var semMotivo = venda.AplicarDescontoItem(1, Desconto.EmPercentual(5m), 10m, new Liberacao(Supervisor, 20m, " ", Agora));
        Assert.True(semMotivo.Aplicado);
        Assert.False(semMotivo.PorLiberacao);
        Assert.Null(venda.ObterItem(1).AutorizadoPorId);

        var comMotivo = venda.AplicarDescontoTotal(Desconto.EmReais(5m), 10m, new Liberacao(Supervisor, 20m, "Cliente fidelidade", Agora));
        Assert.True(comMotivo.Aplicado);
        Assert.False(comMotivo.PorLiberacao);
        Assert.Empty(venda.Liberacoes);

        // Acima do limite, a mesma chamada usa a liberação, e só então o motivo é exigido.
        Assert.Throws<RegraNegocioException>(() =>
            venda.AplicarDescontoItem(2, Desconto.EmPercentual(15m), 10m, new Liberacao(Supervisor, 20m, " ", Agora)));
        var usada = venda.AplicarDescontoItem(2, Desconto.EmPercentual(15m), 10m, new Liberacao(Supervisor, 20m, "Cliente fidelidade", Agora));
        Assert.True(usada.PorLiberacao);
        Assert.Equal(Supervisor, venda.ObterItem(2).AutorizadoPorId);
        Assert.Equal(venda.ObterItem(2).Id, Assert.Single(venda.Liberacoes).ItemVendaId);
    }

    [Fact]
    public void Limite_considera_desconto_da_venda_inteira()
    {
        // R$ 4 no item (8% do item, 4% da venda) + R$ 7 no total = 11% da venda > 10% do operador.
        var venda = VendaComItens(50m, 50m);
        Assert.True(venda.AplicarDescontoItem(1, Desconto.EmReais(4m), 10m).Aplicado);
        var resultado = venda.AplicarDescontoTotal(Desconto.EmReais(7m), 10m);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, resultado.Situacao);
        Assert.Equal(11m, resultado.PercentualPedido);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, venda.AplicarDescontoItem(2, Desconto.EmReais(6m), 10m).Situacao);
    }

    [Fact]
    public void Desconto_no_total_e_rateado_e_total_bate_com_soma_dos_liquidos()
    {
        var venda = VendaComItens(10.00m, 20.00m, 30.01m);
        venda.AplicarDescontoTotal(Desconto.EmReais(5.00m), 100m);
        Assert.Equal(55.01m, venda.Total);
        Assert.Equal([0.83m, 1.67m, 2.50m], venda.Itens.Select(i => i.DescontoRateado));
        Assert.Equal(venda.Total, venda.ItensAtivos.Sum(i => i.ValorLiquido));
    }

    [Fact]
    public void Desconto_percentual_no_total_e_recalculado_ao_mudar_itens()
    {
        var venda = VendaComItens(100m);
        venda.AplicarDescontoTotal(Desconto.EmPercentual(10m), 100m);
        Assert.Equal(10m, venda.DescontoTotal);
        venda.AdicionarItem(Produto(50m), 1m, "2", Agora);
        Assert.Equal(15m, venda.DescontoTotal);
        Assert.Equal(10m, venda.DescontoTotalPct);
        Assert.Equal(135m, venda.Total);
    }

    [Fact]
    public void Desconto_em_reais_no_total_fica_fixo_e_e_zerado_com_aviso_quando_passa_do_subtotal()
    {
        var venda = VendaComItens(10m, 5m);
        venda.AplicarDescontoTotal(Desconto.EmReais(6m), 100m);
        venda.CancelarItem(1, Operador, Agora, 100m);
        Assert.Equal(0m, venda.DescontoTotal);
        Assert.Equal(5m, venda.Total);
        Assert.Contains(venda.ConsumirAvisos(), a => a.Contains("removido"));
        Assert.Empty(venda.ConsumirAvisos());
    }

    [Fact]
    public void Desconto_no_total_maximo_deixa_um_centavo_por_item()
    {
        var venda = VendaComItens(1m, 1m, 1m);
        Assert.Throws<RegraNegocioException>(() => venda.AplicarDescontoTotal(Desconto.EmReais(2.98m), 100m));
        venda.AplicarDescontoTotal(Desconto.EmReais(2.97m), 100m);
        Assert.Equal(0.03m, venda.Total);
        Assert.All(venda.Itens, i => Assert.Equal(0.01m, i.ValorLiquido));
    }

    [Fact]
    public void Rateio_com_residuo_de_um_centavo_fecha_exato()
    {
        // 3 x 3,33 = 9,99 com 10% = 1,00 (arred2 de 0,999): o âncora fica com 0,34 e os demais 0,33.
        var venda = VendaComItens(3.33m, 3.33m, 3.33m);
        venda.AplicarDescontoTotal(Desconto.EmPercentual(10m), 100m);
        Assert.Equal(1.00m, venda.DescontoTotal);
        Assert.Equal([0.34m, 0.33m, 0.33m], venda.Itens.Select(i => i.DescontoRateado));
        Assert.Equal(8.99m, venda.Total);
        Assert.Equal(venda.Total, venda.ItensAtivos.Sum(i => i.ValorLiquido));
    }

    [Fact]
    public void Remover_desconto_do_total()
    {
        var venda = VendaComItens(10m);
        venda.AplicarDescontoTotal(Desconto.EmReais(1m), 100m);
        venda.RemoverDescontoTotal();
        Assert.Equal(10m, venda.Total);
        Assert.Null(venda.DescontoTotalPct);
    }

    [Fact]
    public void Acrescimo_no_total_e_rateado()
    {
        var venda = VendaComItens(10m, 20m);
        venda.AplicarAcrescimoTotal(1.00m);
        Assert.Equal(31m, venda.Total);
        Assert.Equal(1.00m, venda.Itens.Sum(i => i.AcrescimoRateado));
        Assert.Equal(venda.Total, venda.ItensAtivos.Sum(i => i.ValorLiquido));
    }

    [Fact]
    public void Desconto_do_texto()
    {
        Assert.Equal(Desconto.EmPercentual(10m), Desconto.Ler("10%"));
        Assert.Equal(Desconto.EmReais(2.5m), Desconto.Ler("2,50"));
        Assert.Equal(Desconto.EmReais(2.5m), Desconto.Ler("R$ 2.50"));
        Assert.Throws<RegraNegocioException>(() => Desconto.Ler("abc"));
        Assert.Throws<RegraNegocioException>(() => Desconto.Ler("100%"));
        Assert.Throws<RegraNegocioException>(() => Desconto.Ler("1,005"));

        // Os botões "Aplicar R$" / "Aplicar %" (decisão 65: o teclado numérico não tem a tecla %).
        Assert.Equal(Desconto.EmPercentual(10m), Desconto.Ler("10", TipoDesconto.Percentual));
        Assert.Equal(Desconto.EmPercentual(10m), Desconto.Ler("10%", TipoDesconto.Percentual));
        Assert.Equal(Desconto.EmPercentual(2.5m), Desconto.Ler("2,5", TipoDesconto.Percentual));
        Assert.Equal(Desconto.EmReais(10m), Desconto.Ler("10", TipoDesconto.Valor));
        Assert.Throws<RegraNegocioException>(() => Desconto.Ler("10%", TipoDesconto.Valor));
        Assert.Throws<RegraNegocioException>(() => Desconto.Ler("100", TipoDesconto.Percentual));
    }

    [Fact]
    public void Item_que_vale_zero_centavos_e_recusado_sem_mexer_na_venda()
    {
        var venda = VendaComItens(10m);
        venda.AplicarDescontoTotal(Desconto.EmReais(1m), 100m);
        var queijo = Produto(3.49m, "QUEIJO KG", "KG");
        var erro = Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(queijo, 0.001m, "0050", Agora));
        Assert.Contains("R$ 0,00", erro.Message);
        Assert.Single(venda.Itens);
        Assert.Equal(9m, venda.Total);

        // Depois da recusa a venda segue operável (antes ficava meio recalculada e todo Recalcular falhava).
        venda.AdicionarItem(Produto(5m), 1m, "2", Agora);
        Assert.Equal(14m, venda.Total);
    }

    [Fact]
    public void Alterar_quantidade_ou_cancelar_parcial_para_valor_zero_e_recusado()
    {
        var venda = NovaVenda();
        venda.AdicionarItem(Produto(3.49m, "QUEIJO KG", "KG"), 1m, "0050", Agora);
        Assert.Throws<RegraNegocioException>(() => venda.AlterarQuantidade(1, 0.001m, 100m));
        Assert.Throws<RegraNegocioException>(() => venda.CancelarItem(1, Operador, Agora, 100m, quantidade: 0.999m));
        Assert.Equal(1m, venda.ObterItem(1).Quantidade);
        Assert.False(venda.ObterItem(1).Cancelado);
        Assert.Single(venda.Itens);
        Assert.Equal(3.49m, venda.Total);
    }

    [Fact]
    public void Item_de_base_zero_gravado_antes_da_validacao_fica_fora_do_rateio()
    {
        var original = VendaComItens(10m);
        var estado = new EstadoVenda(original.Id, original.Numero, original.NumeroExibicao, original.LojaId, original.CaixaId,
            original.NumeroCaixa, original.TerminalId, original.SessaoCaixaId, original.Modo, original.Status, original.StatusFiscal,
            original.OperadorId, original.TipoPreco, DescontoTotal: 1m, DescontoTotalPct: null, AcrescimoTotal: 0m, original.IniciadaEm,
            DescontoTotalOrigem: Venda.OrigemDescontoOperador);
        var zerado = new ItemVenda(Guid.CreateVersion7(), 2, Guid.CreateVersion7(), "0050", null, "QUEIJO KG", "KG", true, 0.001m,
            3.49m, 3.49m, OrigemPreco.Varejo, 0m, 0m, Agora);
        var venda = Venda.Restaurar(estado, [original.Itens[0], zerado], []);
        Assert.Equal(9m, venda.Total);
        Assert.Equal(1m, venda.ObterItem(1).DescontoRateado);
        Assert.Equal(0m, venda.ObterItem(2).DescontoRateado);
    }

    [Fact]
    public void Diminuir_quantidade_revalida_o_limite_do_desconto_do_item()
    {
        // Limite 10%: 5 × 10,00 com 10% (R$ 5,00); em 1 unidade os mesmos R$ 5,00 seriam 50%.
        var venda = NovaVenda();
        venda.AdicionarItem(Produto(10m), 5m, "1", Agora);
        Assert.True(venda.AplicarDescontoItem(1, Desconto.EmPercentual(10m), 10m).Aplicado);
        var erro = Assert.Throws<RegraNegocioException>(() => venda.AlterarQuantidade(1, 1m, 10m));
        Assert.Contains("50,00%", erro.Message);
        Assert.Equal(5m, venda.ObterItem(1).Quantidade);
        Assert.Equal(5m, venda.ObterItem(1).DescontoItem);
        Assert.Equal(45m, venda.Total);

        // Aumentar continua livre, e quem tem limite para o novo % pode diminuir.
        venda.AlterarQuantidade(1, 6m, 10m);
        Assert.Equal(55m, venda.Total);
        venda.AlterarQuantidade(1, 1m, 50m);
        Assert.Equal(5m, venda.Total);

        venda.RemoverDescontoItem(1);
        Assert.Equal(10m, venda.Total);
    }

    [Fact]
    public void Cancelar_item_revalida_o_limite_do_desconto_fixo_no_total()
    {
        // R$ 5,00 fixos sobre 50,00 = 10%; sem o item de 25,00 passariam a 20%.
        var venda = VendaComItens(25m, 25m);
        Assert.True(venda.AplicarDescontoTotal(Desconto.EmReais(5m), 10m).Aplicado);
        Assert.Throws<RegraNegocioException>(() => venda.CancelarItem(2, Operador, Agora, 10m));
        Assert.False(venda.ObterItem(2).Cancelado);
        Assert.Equal(45m, venda.Total);

        // Desconto em % acompanha o subtotal e não muda o percentual.
        venda.AplicarDescontoTotal(Desconto.EmPercentual(10m), 10m);
        venda.CancelarItem(2, Operador, Agora, 10m);
        Assert.Equal(22.50m, venda.Total);
    }

    [Fact]
    public void Diminuir_quantidade_preserva_desconto_ja_liberado_quando_o_percentual_nao_sobe()
    {
        var venda = VendaComItens(10m, 10m);
        Assert.True(venda.AplicarDescontoTotal(Desconto.EmPercentual(15m), 10m, new Liberacao(Supervisor, 20m, "Fidelidade", Agora)).Aplicado);
        venda.CancelarItem(2, Operador, Agora, 10m);
        Assert.Equal(1.50m, venda.DescontoTotal);
    }

    [Theory]
    [InlineData("0.99")]
    [InlineData("0.95")]
    [InlineData("1.05")]
    public void Operador_com_limite_10_aplica_10_porcento_mesmo_com_arredondamento(string preco)
    {
        var p = decimal.Parse(preco, System.Globalization.CultureInfo.InvariantCulture);
        var item = VendaComItens(p).AplicarDescontoItem(1, Desconto.EmPercentual(10m), 10m);
        Assert.Equal(SituacaoDesconto.Aplicado, item.Situacao);
        Assert.True(item.PercentualPedido > 10m);

        var total = VendaComItens(p).AplicarDescontoTotal(Desconto.EmPercentual(10m), 10m);
        Assert.Equal(SituacaoDesconto.Aplicado, total.Situacao);
    }

    [Fact]
    public void Desconto_digitado_em_reais_acima_do_limite_continua_pedindo_liberacao()
    {
        // R$ 0,10 sobre 0,99 = 10,10%: digitado em R$ não tem a folga do arredondamento do %.
        var venda = VendaComItens(0.99m);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, venda.AplicarDescontoItem(1, Desconto.EmReais(0.10m), 10m).Situacao);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, VendaComItens(1.05m).AplicarDescontoTotal(Desconto.EmReais(0.11m), 10m).Situacao);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, VendaComItens(100m).AplicarDescontoItem(1, Desconto.EmPercentual(10.01m), 10m).Situacao);
    }

    [Fact]
    public void Usuario_master_tem_limite_de_100_porcento()
    {
        Assert.Equal(100m, LimiteDesconto.DoUsuario(0m, master: true));
        Assert.Equal(7.5m, LimiteDesconto.DoUsuario(7.5m, master: false));

        var venda = VendaComItens(100m);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, venda.AplicarDescontoTotal(Desconto.EmPercentual(50m), 0m).Situacao);
        var semMaster = venda.AplicarDescontoTotal(Desconto.EmPercentual(50m), 0m, new Liberacao(Supervisor, 0m, "Avaria", Agora));
        Assert.Equal(SituacaoDesconto.LiberacaoInsuficiente, semMaster.Situacao);
        var master = venda.AplicarDescontoTotal(Desconto.EmPercentual(50m), 0m, new Liberacao(Supervisor, 0m, "Avaria", Agora, SupervisorMaster: true));
        Assert.True(master.Aplicado);
        Assert.Equal(LimiteDesconto.DoUsuario(0m, master: true), new Liberacao(Supervisor, 0m, "x", Agora, SupervisorMaster: true).LimiteEfetivoPct);
    }

    [Fact]
    public void Desconto_no_total_registra_a_origem_operador()
    {
        var venda = VendaComItens(10m);
        Assert.Null(venda.DescontoTotalOrigem);
        venda.AplicarDescontoTotal(Desconto.EmReais(1m), 100m);
        Assert.Equal(Venda.OrigemDescontoOperador, venda.DescontoTotalOrigem);
        venda.RemoverDescontoTotal();
        Assert.Null(venda.DescontoTotalOrigem);
    }

    [Fact]
    public void Desconto_de_promocao_sai_da_base_do_rateio_e_do_liquido()
    {
        var original = VendaComItens(10m);
        var estado = new EstadoVenda(original.Id, original.Numero, original.NumeroExibicao, original.LojaId, original.CaixaId,
            original.NumeroCaixa, original.TerminalId, original.SessaoCaixaId, original.Modo, original.Status, original.StatusFiscal,
            original.OperadorId, original.TipoPreco, DescontoTotal: 0m, DescontoTotalPct: 10m, AcrescimoTotal: 0m, original.IniciadaEm,
            DescontoTotalOrigem: Venda.OrigemDescontoOperador);
        var promocional = new ItemVenda(Guid.CreateVersion7(), 2, Guid.CreateVersion7(), "2", null, "CERV", "UN", false, 1m,
            10m, 10m, OrigemPreco.Varejo, 10m, 0m, Agora, descontoPromocao: 2m, promocaoId: Guid.CreateVersion7());
        var venda = Venda.Restaurar(estado, [original.Itens[0], promocional], []);
        Assert.Equal(8m, promocional.BaseRateio);
        Assert.Equal(1.80m, venda.DescontoTotal);
        Assert.Equal(2m, venda.DescontoItens);
        Assert.Equal(16.20m, venda.Total);
        Assert.Equal(venda.Total, venda.ItensAtivos.Sum(i => i.ValorLiquido));
    }
}
