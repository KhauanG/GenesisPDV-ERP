using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.CatalogoTeste;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Preço gelada (<c>Alt+G</c>, PDV 11.4) e preço parcelado (PDV 11.2, 11.3 passo 9; D74) da Fase 3, F3-B18: o gelado soma
/// por unidade ao <c>preco_unitario</c> e ao <c>preco_tabela</c> na camada de acréscimos do item (depois da regra 11.3 e dos
/// complementos) e não se agrupa com o natural; o parcelado substitui os candidatos nos itens com <c>preco_parcelado</c>
/// quando o crédito vai em mais de uma parcela, e remover o pagamento volta os preços e o tipo do F8.
/// </summary>
public class GeladaParceladoTests
{
    private static readonly FormaPagamentoInfo Credito = new(
        Guid.CreateVersion7(), "Crédito", "03", "cartao_credito", PermiteTroco: false, Integracao: IntegracaoForma.PosExterno,
        PermiteParcelar: true, ParcelasMaximo: 6);

    private static readonly FormaPagamentoInfo Debito = new(
        Guid.CreateVersion7(), "Débito", "04", "cartao_debito", PermiteTroco: false, Integracao: IntegracaoForma.PosExterno);

    private static DetalhePagamento Cartao(int parcelas, FormaPagamentoInfo? forma = null) =>
        RegrasFormaPagamento.ValidarPos(forma ?? Credito, "01", null, null, parcelas);

    /// <summary>Brahma 3,49 com atacado 12+ a 3,19, gelada R$ 1,00 na loja e parcelado a 3,69.</summary>
    private static ProdutoVenda BrahmaCompleta(decimal? gelada = 1.00m, decimal? parcelado = 3.69m) =>
        Produto("CERV BRAHMA LT 350ML", 3.49m,
            new TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m, AcrescimoGelada: gelada, PrecoParcelado: parcelado));

    /// <summary>A venda relida do banco (PDV 32.3): o estado e as linhas gravadas, com os snapshots registrados de novo.</summary>
    private static Venda Recuperar(Venda venda, IEnumerable<ItemVenda> itens, IEnumerable<ProdutoVenda>? semSnapshot = null)
    {
        var estado = new EstadoVenda(venda.Id, venda.Numero, venda.NumeroExibicao, venda.LojaId, venda.CaixaId, venda.NumeroCaixa, venda.TerminalId,
            null, venda.Modo, venda.Status, venda.StatusFiscal, venda.OperadorId, venda.TipoPreco, 0m, null, 0m, venda.IniciadaEm);
        var recuperada = Venda.Restaurar(estado, itens, []);
        recuperada.RegistrarProdutos(venda.Snapshots.Select(s => s.Value), semSnapshot, Agora);
        return recuperada;
    }

    private static ItemVenda Copia(ItemVenda item, string? origem = null) =>
        new(item.Id, item.Sequencia, item.ProdutoId, item.CodigoLido, null, item.Descricao, item.Unidade, false, item.Quantidade, item.PrecoTabela,
            item.PrecoUnitario, origem ?? item.OrigemPreco, item.ValorBruto, 0m, item.IncluidoEm, complementos: item.Complementos,
            acrescimoGelada: item.AcrescimoGelada);

    // ---------------------------------------------------------------- gelada

    [Fact]
    public void Alt_G_soma_o_acrescimo_por_unidade_e_desfaz()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(BrahmaCompleta()), 3m, "1", Agora);
        Assert.Equal(10.47m, venda.Total);

        var r = venda.AlternarGelado(item.Sequencia);

        Assert.True(r.Gelado);
        Assert.True(item.Gelado);
        Assert.Equal(1.00m, r.AcrescimoUnitario);
        Assert.Equal((10.47m, 13.47m), (r.TotalAntes, r.TotalDepois));
        // O acréscimo fica dentro do preço unitário, do de tabela e do bruto; a origem do preço não muda e não é acréscimo
        // da venda (nem desconto).
        Assert.Equal((4.49m, 4.49m, 13.47m), (item.PrecoUnitario, item.PrecoTabela, item.ValorBruto));
        Assert.Equal(OrigemPreco.Varejo, item.OrigemPreco);
        Assert.Equal(0m, venda.AcrescimoTotal);
        Assert.Equal(0m, item.ReducaoPrecoManual);
        Assert.Equal(13.47m, venda.Total);

        var volta = venda.AlternarGelado(item.Sequencia);
        Assert.False(volta.Gelado);
        Assert.Equal(1.00m, volta.AcrescimoUnitario);
        Assert.Equal((3.49m, 3.49m, 10.47m), (item.PrecoUnitario, item.PrecoTabela, item.ValorBruto));
        Assert.False(item.Gelado);
    }

    [Fact]
    public void Gelada_com_atacado_por_quantidade_e_com_o_F8()
    {
        var venda = VendaPreco();
        var brahma = BrahmaCompleta();
        var gelada = venda.AdicionarItem(Lido(brahma), 6m, "1", Agora);
        venda.AlternarGelado(gelada.Sequencia);
        var natural = venda.AdicionarItem(Lido(brahma), 5m, "1", Agora);
        Assert.Equal(4.49m, gelada.PrecoUnitario);
        Assert.Equal(3.49m, natural.PrecoUnitario);

        // A 12ª lata leva as duas linhas ao atacado: o gelado fica por cima do atacado (regra 11.3 → gelada).
        venda.AdicionarItem(Lido(brahma), 1m, "1", Agora, agrupar: true);
        Assert.Equal((4.19m, OrigemPreco.Atacado), (gelada.PrecoUnitario, gelada.OrigemPreco));
        Assert.Equal((3.19m, OrigemPreco.Atacado), (natural.PrecoUnitario, natural.OrigemPreco));
        // A economia do atacado é contra o varejo com o gelado (4,49), não contra o natural.
        Assert.Equal(1.80m + 1.80m, venda.EconomiaAtacado);

        // O F8 noutra venda: o gelado soma ao atacado do tipo da venda.
        var f8 = VendaPreco();
        var linha = f8.AdicionarItem(Lido(brahma), 2m, "1", Agora);
        f8.AlternarGelado(linha.Sequencia);
        f8.AlterarTipoPreco(TipoPrecoVenda.Atacado, temPermissaoAtacado: true);
        Assert.Equal((4.19m, 8.38m), (linha.PrecoUnitario, linha.ValorBruto));
        f8.AlterarTipoPreco(TipoPrecoVenda.Varejo, temPermissaoAtacado: true);
        Assert.Equal(4.49m, linha.PrecoUnitario);
    }

    [Fact]
    public void Gelado_e_natural_nao_se_agrupam_e_o_cancelamento_parcial_leva_o_gelado()
    {
        var venda = VendaPreco();
        var brahma = BrahmaCompleta();
        var gelada = venda.AdicionarItem(Lido(brahma), 2m, "1", Agora, agrupar: true);
        venda.AlternarGelado(gelada.Sequencia);

        var natural = venda.AdicionarItem(Lido(brahma), 1m, "1", Agora, agrupar: true);
        Assert.NotSame(gelada, natural);
        Assert.Equal(2m, gelada.Quantidade);
        Assert.False(natural.Gelado);
        // O natural seguinte agrupa no natural.
        Assert.Same(natural, venda.AdicionarItem(Lido(brahma), 1m, "1", Agora, agrupar: true));
        Assert.Equal(2m, natural.Quantidade);

        var restante = venda.CancelarItem(gelada.Sequencia, Operador, Agora, 0m, quantidade: 1m);
        Assert.NotNull(restante);
        Assert.True(restante.Gelado);
        Assert.Equal((4.49m, 4.49m), (restante.PrecoUnitario, restante.ValorBruto));
    }

    [Fact]
    public void Desconto_em_percentual_e_refeito_com_o_gelado()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(BrahmaCompleta()), 10m, "1", Agora);
        Assert.True(venda.AplicarDescontoItem(item.Sequencia, new Desconto(TipoDesconto.Percentual, 10m), 10m).Aplicado);
        Assert.Equal(3.49m, item.DescontoItem);

        venda.AlternarGelado(item.Sequencia);

        Assert.Equal(44.90m, item.ValorBruto);
        Assert.Equal(4.49m, item.DescontoItem);
    }

    [Fact]
    public void Recusas_do_Alt_G()
    {
        var venda = VendaPreco();
        var semGelada = venda.AdicionarItem(Lido(BrahmaCompleta(gelada: null)), 1m, "1", Agora);
        var erro = Assert.Throws<RegraNegocioException>(() => venda.AlternarGelado(semGelada.Sequencia));
        Assert.Equal("CERV BRAHMA LT 350ML não tem preço gelado nesta loja.", erro.Message);
        Assert.Throws<RegraNegocioException>(() => venda.AlternarGelado(semGelada.Sequencia + 99));

        // O preço digitado é o preço final (10.4, 10.5): o gelado não entra nele.
        var manual = venda.AdicionarItem(Lido(Produto("CERV SKOL LT", 2.99m, new TabelaPreco(AcrescimoGelada: 1.00m))), 1m, "2", Agora);
        Assert.True(venda.AlterarPrecoItem(manual.Sequencia, 2.50m, 20m).Aplicado);
        Assert.Throws<RegraNegocioException>(() => venda.AlternarGelado(manual.Sequencia));

        // O combo tem o preço fechado.
        var combo = venda.AdicionarCombo(ComboWhisky(), [0, 0, 0], 1m, "9", Agora);
        Assert.Throws<RegraNegocioException>(() => venda.AlternarGelado(combo[0].Sequencia));

        // Com pagamento: ligar pode (o total sobe); desligar, não (o total cairia, decisão 8).
        var gelavel = venda.AdicionarItem(Lido(BrahmaCompleta()), 1m, "1", Agora);
        venda.IniciarPagamento();
        Assert.Throws<RegraNegocioException>(() => venda.AlternarGelado(gelavel.Sequencia));
        venda.LancarPagamento(Dinheiro, 1m, Agora);
        venda.VoltarParaItens();
        Assert.True(venda.AlternarGelado(gelavel.Sequencia).Gelado);
        var ex = Assert.Throws<RegraNegocioException>(() => venda.AlternarGelado(gelavel.Sequencia));
        Assert.Contains("pagamentos", ex.Message, StringComparison.Ordinal);
        Assert.True(gelavel.Gelado);
        Assert.Equal(4.49m, gelavel.PrecoUnitario);
    }

    [Fact]
    public void Recusas_do_Alt_G_no_casco_no_preco_fechado_sem_snapshot_e_no_acrescimo_invalido()
    {
        // O casco cobrado é do produto cheio: o Alt+G nele é recusado, e o preço da garrafa não muda.
        var comCasco = VendaPreco();
        var cerveja = comCasco.AdicionarItem(Lido(Original600(new TabelaPreco(AcrescimoGelada: 1.00m))), 1m, "0600", Agora);
        var casco = comCasco.RegistrarCascosTrazidos(cerveja.Sequencia, 0m, Garrafa with { Precos = new TabelaPreco(AcrescimoGelada: 1.00m) }, Agora)!;
        var erro = Assert.Throws<RegraNegocioException>(() => comCasco.AlternarGelado(casco.Sequencia));
        Assert.Contains("casco", erro.Message, StringComparison.Ordinal);
        Assert.Equal(2.50m, casco.PrecoUnitario);

        // A etiqueta da balança tipo Valor e o orçamento têm o preço fechado (o valor impresso): o gelado não soma, mesmo com o
        // snapshot da loja com a gelada. A linha recuperada sem o snapshot (venda gravada antes da tabela) também recusa.
        var origem = VendaPreco();
        var brahma = BrahmaCompleta();
        var lida = origem.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        var semSnapshot = Produto("CERV SKOL LT", 2.99m, new TabelaPreco(AcrescimoGelada: 1.00m));
        var antiga = new ItemVenda(Guid.CreateVersion7(), 4, semSnapshot.Id, "2", null, semSnapshot.Descricao, "UN", false, 1m, 2.99m, 2.99m,
            OrigemPreco.Varejo, 2.99m, 0m, Agora);
        var recuperada = Recuperar(origem,
        [
            Copia(lida, OrigemPreco.Balanca),
            new ItemVenda(Guid.CreateVersion7(), 2, lida.ProdutoId, "1", null, lida.Descricao, "UN", false, 1m, 3.49m, 3.49m, OrigemPreco.Orcamento, 3.49m, 0m, Agora),
            new ItemVenda(Guid.CreateVersion7(), 3, lida.ProdutoId, "1", null, lida.Descricao, "UN", false, 1m, 3.49m, 3.49m, OrigemPreco.Varejo, 3.49m, 0m, Agora),
            antiga,
        ], [semSnapshot]);
        foreach (var sequencia in new[] { 1, 2 })
        {
            var fechado = Assert.Throws<RegraNegocioException>(() => recuperada.AlternarGelado(sequencia));
            Assert.Contains("preço fechado", fechado.Message, StringComparison.Ordinal);
            Assert.Equal((3.49m, false), (recuperada.ObterItem(sequencia).PrecoUnitario, recuperada.ObterItem(sequencia).Gelado));
        }

        var semCadastro = Assert.Throws<RegraNegocioException>(() => recuperada.AlternarGelado(4));
        Assert.Contains("sem o cadastro da inclusão", semCadastro.Message, StringComparison.Ordinal);
        Assert.Equal(2.99m, recuperada.ObterItem(4).PrecoUnitario);
        // A linha da mesma lata, recalculável e com o snapshot, aceita.
        Assert.True(recuperada.AlternarGelado(3).Gelado);

        // O acréscimo com mais casas que o preço (cadastro inválido) é recusado sem mudar a linha.
        var venda = VendaPreco();
        var invalido = venda.AdicionarItem(Lido(BrahmaCompleta(gelada: 1.00005m)), 1m, "1", Agora);
        var cadastro = Assert.Throws<RegraNegocioException>(() => venda.AlternarGelado(invalido.Sequencia));
        Assert.Contains("Acréscimo gelada inválido", cadastro.Message, StringComparison.Ordinal);
        Assert.Equal((3.49m, false), (invalido.PrecoUnitario, invalido.Gelado));
    }

    [Fact]
    public void Venda_recuperada_com_gelado_ou_complemento_no_atacado_mantem_a_etiqueta()
    {
        // 12 latas geladas no atacado (3,19 + 1,00): a linha relida tem o acréscimo no preço gravado e volta com o "ATAC 12+".
        var venda = VendaPreco();
        var latas = venda.AdicionarItem(Lido(BrahmaCompleta()), 12m, "1", Agora);
        venda.AlternarGelado(latas.Sequencia);
        Assert.Equal((4.19m, "ATAC 12+"), (latas.PrecoUnitario, latas.EtiquetaPreco));

        var recuperada = Recuperar(venda, [Copia(latas)]);
        Assert.Equal((4.19m, "ATAC 12+"), (recuperada.ObterItem(latas.Sequencia).PrecoUnitario, recuperada.ObterItem(latas.Sequencia).EtiquetaPreco));

        // A porção no atacado (22,00 a partir de 3) com o adicional de 4,50 por cima: "ATAC 3+".
        var porcao = ComplementosTests.Porcao(new TabelaPreco(PrecoAtacado: 22.00m, QtdMinimaAtacado: 3m));
        var outra = VendaPreco();
        var linha = outra.AdicionarItem(new ProdutoResolvido(porcao), 3m, "0300", Agora, complementos: [ComplementosTests.Barbecue, ComplementosTests.Cheddar]);
        Assert.Equal((26.50m, "ATAC 3+"), (linha.PrecoUnitario, linha.EtiquetaPreco));
        var relida = Recuperar(outra, [Copia(linha)]);
        Assert.Equal((26.50m, "ATAC 3+"), (relida.ObterItem(linha.Sequencia).PrecoUnitario, relida.ObterItem(linha.Sequencia).EtiquetaPreco));
    }

    [Fact]
    public void Venda_recuperada_mantem_o_gelado_o_agrupamento_e_o_desfazer()
    {
        var brahma = BrahmaCompleta();
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(brahma), 2m, "1", Agora);
        venda.AlternarGelado(item.Sequencia);
        // A gelada da loja muda depois (pull no meio da venda): a venda recuperada fica com a da primeira inclusão.
        var estado = new EstadoVenda(venda.Id, venda.Numero, venda.NumeroExibicao, venda.LojaId, venda.CaixaId, venda.NumeroCaixa, venda.TerminalId,
            null, venda.Modo, venda.Status, venda.StatusFiscal, venda.OperadorId, venda.TipoPreco, 0m, null, 0m, venda.IniciadaEm);
        var copia = new ItemVenda(item.Id, item.Sequencia, item.ProdutoId, item.CodigoLido, null, item.Descricao, item.Unidade, false, item.Quantidade,
            item.PrecoTabela, item.PrecoUnitario, item.OrigemPreco, item.ValorBruto, 0m, item.IncluidoEm, acrescimoGelada: item.AcrescimoGelada);

        var recuperada = Venda.Restaurar(estado, [copia], []);
        recuperada.RegistrarProdutos(venda.Snapshots.Select(s => s.Value), null, Agora);

        var linha = recuperada.ObterItem(item.Sequencia);
        Assert.True(linha.Gelado);
        Assert.Equal(4.49m, linha.PrecoUnitario);
        // O natural não agrupa na linha gelada recuperada; a 12ª lata recalcula com o gelado por cima.
        var natural = recuperada.AdicionarItem(Lido(brahma with { Precos = brahma.Precos! with { AcrescimoGelada = 2.00m } }), 10m, "1", Agora, agrupar: true);
        Assert.NotSame(linha, natural);
        Assert.Equal((4.19m, 3.19m), (linha.PrecoUnitario, natural.PrecoUnitario));
        // Desfazer tira o valor somado (1,00), não o do espelho novo.
        recuperada.AlternarGelado(linha.Sequencia);
        Assert.Equal(3.19m, linha.PrecoUnitario);
        // E ligar de novo usa a gelada do snapshot (1,00).
        recuperada.AlternarGelado(linha.Sequencia);
        Assert.Equal(4.19m, linha.PrecoUnitario);
    }

    // ---------------------------------------------------------------- parcelado

    [Fact]
    public void Credito_em_3x_aplica_o_parcelado_e_remover_volta()
    {
        // Critério 11.5: "Lançar crédito em 3 parcelas aplica o preço parcelado; remover o pagamento volta ao varejo".
        var venda = VendaPreco();
        var latas = venda.AdicionarItem(Lido(BrahmaCompleta()), 2m, "1", Agora);
        var semParcelado = venda.AdicionarItem(Lido(Produto("COCA 2L", 9.99m)), 1m, "2", Agora);
        venda.IniciarPagamento();
        Assert.Equal(16.97m, venda.Total);

        var previa = venda.PreverPrecoParcelado();
        Assert.True(previa.Aplica);
        Assert.Equal((16.97m, 17.37m, 1, 0.40m), (previa.TotalAntes, previa.TotalDepois, previa.LinhasAlteradas, previa.Diferenca));
        // A prévia não muda nada.
        Assert.Equal((TipoPrecoVenda.Varejo, 3.49m, 16.97m), (venda.TipoPreco, latas.PrecoUnitario, venda.Total));

        var r = venda.AplicarPrecoParcelado();
        Assert.Equal(previa, r);
        Assert.Equal(TipoPrecoVenda.Parcelado, venda.TipoPreco);
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPrecoAntesParcelado);
        Assert.Equal((3.69m, 3.69m, 7.38m, OrigemPreco.Parcelado), (latas.PrecoUnitario, latas.PrecoTabela, latas.ValorBruto, latas.OrigemPreco));
        Assert.Null(latas.QuantidadeReferenciaPreco);
        Assert.Equal("PARC", latas.EtiquetaPreco);
        Assert.Equal((9.99m, OrigemPreco.Varejo), (semParcelado.PrecoUnitario, semParcelado.OrigemPreco));
        Assert.Equal(17.37m, venda.Falta);

        var pagamento = venda.LancarPagamento(Credito, 17.37m, Agora, Cartao(3));
        Assert.Equal(3, pagamento.Parcelas);
        Assert.Equal(0m, venda.Falta);
        Assert.Equal(TipoPrecoVenda.Parcelado, venda.TipoPreco);

        venda.RemoverPagamento(pagamento.Sequencia);
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        Assert.Null(venda.TipoPrecoAntesParcelado);
        Assert.Equal((3.49m, OrigemPreco.Varejo), (latas.PrecoUnitario, latas.OrigemPreco));
        Assert.Equal(16.97m, venda.Total);

        // À vista (1 parcela) não há parcelado: a prévia sem o pagamento parcelado, e o lançamento em 1×, não mudam o preço.
        venda.LancarPagamento(Credito, 16.97m, Agora, Cartao(1));
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        venda.Finalizar(Agora, Guid.CreateVersion7());
        Assert.Equal(16.97m, venda.Total);
    }

    [Fact]
    public void Sem_preco_parcelado_nada_muda()
    {
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(BrahmaCompleta(parcelado: null)), 2m, "1", Agora);
        venda.IniciarPagamento();

        var r = venda.AplicarPrecoParcelado();

        Assert.False(r.Aplica);
        Assert.Equal(0m, r.Diferenca);
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        Assert.Null(venda.TipoPrecoAntesParcelado);
        venda.LancarPagamento(Credito, 6.98m, Agora, Cartao(3));
        venda.Finalizar(Agora, Guid.CreateVersion7());
        Assert.Equal((TipoPrecoVenda.Varejo, 6.98m), (venda.TipoPreco, venda.Total));
    }

    [Fact]
    public void Parcelado_com_o_F8_no_atacado_volta_ao_atacado()
    {
        var venda = VendaPreco();
        var brahma = venda.AdicionarItem(Lido(BrahmaCompleta()), 2m, "1", Agora);
        var skol = venda.AdicionarItem(Lido(Skol()), 2m, "2", Agora);
        venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, temPermissaoAtacado: true);
        venda.IniciarPagamento();
        Assert.Equal(6.38m + 5.58m, venda.Total);

        var r = venda.AplicarPrecoParcelado();

        Assert.Equal(TipoPrecoVenda.Atacado, venda.TipoPrecoAntesParcelado);
        // O parcelado substitui o atacado no produto que o tem; o outro continua no atacado do F8.
        Assert.Equal((3.69m, OrigemPreco.Parcelado), (brahma.PrecoUnitario, brahma.OrigemPreco));
        Assert.Equal((2.79m, OrigemPreco.Atacado), (skol.PrecoUnitario, skol.OrigemPreco));
        Assert.Equal(7.38m + 5.58m, r.TotalDepois);

        var pagamento = venda.LancarPagamento(Credito, 5m, Agora, Cartao(2));
        venda.RemoverPagamento(pagamento.Sequencia);
        Assert.Equal(TipoPrecoVenda.Atacado, venda.TipoPreco);
        Assert.Equal((3.19m, OrigemPreco.Atacado), (brahma.PrecoUnitario, brahma.OrigemPreco));
    }

    [Fact]
    public void Gelado_soma_ao_parcelado()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(BrahmaCompleta()), 2m, "1", Agora);
        venda.AlternarGelado(item.Sequencia);
        venda.IniciarPagamento();

        venda.AplicarPrecoParcelado();

        Assert.Equal((4.69m, 9.38m, OrigemPreco.Parcelado), (item.PrecoUnitario, item.ValorBruto, item.OrigemPreco));
        Assert.True(item.Gelado);
    }

    [Fact]
    public void Parcelado_recusado_com_pagamento_eletronico_aprovado()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(BrahmaCompleta()), 4m, "1", Agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(Debito, 5m, Agora, Cartao(1, Debito));

        Assert.NotNull(venda.MotivoParceladoRecusado);
        var erro = Assert.Throws<RegraNegocioException>(() => venda.AplicarPrecoParcelado());
        Assert.Contains("eletrônico", erro.Message, StringComparison.Ordinal);
        Assert.Equal((TipoPrecoVenda.Varejo, 3.49m), (venda.TipoPreco, item.PrecoUnitario));

        // O dinheiro lançado antes não impede (o cliente paga o resto parcelado: o falta sobe).
        var outra = VendaPreco();
        outra.AdicionarItem(Lido(BrahmaCompleta()), 4m, "1", Agora);
        outra.IniciarPagamento();
        outra.LancarPagamento(Dinheiro, 5m, Agora);
        Assert.Null(outra.MotivoParceladoRecusado);
        var r = outra.AplicarPrecoParcelado();
        Assert.Equal((13.96m, 14.76m), (r.TotalAntes, r.TotalDepois));
        Assert.Equal(9.76m, outra.Falta);
    }

    [Fact]
    public void Parcelado_menor_que_o_ja_pago_e_recusado()
    {
        // D125 (3): o parcelado de 9,00 substitui o varejo de 10,00 mesmo menor; (4) o dinheiro lançado antes não o recusa. Mas
        // com pagamento lançado o total não cai até o pago (decisão 8): sem valor para o cartão em parcelas, é recusado.
        static Venda Montar(decimal dinheiro)
        {
            var venda = VendaPreco();
            venda.AdicionarItem(Lido(Produto("VINHO TESTE", 10.00m, new TabelaPreco(PrecoParcelado: 9.00m))), 10m, "1", Agora);
            venda.IniciarPagamento();
            venda.LancarPagamento(Dinheiro, dinheiro, Agora);
            return venda;
        }

        var acima = Montar(95m);
        var previa = acima.PreverPrecoParcelado();
        Assert.Equal((100m, 90m), (previa.TotalAntes, previa.TotalDepois));
        Assert.NotNull(acima.MotivoParceladoSemValor(previa));
        var erro = Assert.Throws<RegraNegocioException>(() => acima.AplicarPrecoParcelado(5m));
        Assert.Contains("não sobra valor", erro.Message, StringComparison.Ordinal);
        Assert.Equal((TipoPrecoVenda.Varejo, 100m, 5m), (acima.TipoPreco, acima.Total, acima.Falta));

        // O total novo igual ao pago também (o cartão ficaria em R$ 0,00).
        var igual = Montar(90m);
        Assert.Throws<RegraNegocioException>(() => igual.AplicarPrecoParcelado());
        Assert.Equal((TipoPrecoVenda.Varejo, 100m), (igual.TipoPreco, igual.Total));

        // Sobra total, mas o valor informado para o cartão (5,00) menos a diferença (10,00) ficaria negativo.
        var parcial = Montar(50m);
        Assert.Null(parcial.MotivoParceladoSemValor(parcial.PreverPrecoParcelado()));
        Assert.NotNull(parcial.MotivoParceladoSemValor(parcial.PreverPrecoParcelado(), 5m));
        Assert.Throws<RegraNegocioException>(() => parcial.AplicarPrecoParcelado(5m));
        Assert.Equal(TipoPrecoVenda.Varejo, parcial.TipoPreco);
        // O resto todo (50,00) em parcelas: o cartão cobra 40,00 e o parcelado entra.
        var r = parcial.AplicarPrecoParcelado(50m);
        Assert.Equal((90m, 40m), (r.TotalDepois, parcial.Falta));
    }

    [Fact]
    public void Parcelado_recusado_com_vale_passado_na_maquininha_e_aceito_com_o_vale_de_papel()
    {
        var valeMaquininha = new FormaPagamentoInfo(Guid.CreateVersion7(), "VA Alelo", "10", "vale_alimentacao", PermiteTroco: false,
            Integracao: IntegracaoForma.PosExterno);
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(BrahmaCompleta()), 4m, "1", Agora);
        venda.IniciarPagamento();
        var va = venda.LancarPagamento(valeMaquininha, 5m, Agora, RegrasFormaPagamento.ValidarPos(valeMaquininha, "10", null, null, 1));
        Assert.True(va.Eletronico);
        Assert.NotNull(venda.MotivoParceladoRecusado);
        Assert.Throws<RegraNegocioException>(() => venda.AplicarPrecoParcelado());
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);

        // O vale de papel (lançado direto, sem a maquininha) não foi cobrado fora do caixa: o parcelado entra.
        var valePapel = new FormaPagamentoInfo(Guid.CreateVersion7(), "VA papel", "10", "vale_alimentacao", PermiteTroco: false);
        var outra = VendaPreco();
        outra.AdicionarItem(Lido(BrahmaCompleta()), 4m, "1", Agora);
        outra.IniciarPagamento();
        Assert.False(outra.LancarPagamento(valePapel, 5m, Agora).Eletronico);
        Assert.Null(outra.MotivoParceladoRecusado);
        Assert.True(outra.AplicarPrecoParcelado().Aplica);
    }

    [Fact]
    public void Lancamento_a_vista_ou_volta_aos_itens_desfazem_o_parcelado_confirmado_sem_pagamento()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(BrahmaCompleta()), 2m, "1", Agora);
        venda.IniciarPagamento();
        venda.AplicarPrecoParcelado();

        // A maquininha não aprovou e o operador pagou em dinheiro: o lançamento à vista volta os preços antes de medir.
        venda.LancarPagamento(Dinheiro, 10m, Agora);
        Assert.Equal((TipoPrecoVenda.Varejo, 3.49m, 6.98m, 3.02m), (venda.TipoPreco, item.PrecoUnitario, venda.Total, venda.Troco));

        var outra = VendaPreco();
        var linha = outra.AdicionarItem(Lido(BrahmaCompleta()), 2m, "1", Agora);
        outra.IniciarPagamento();
        outra.AplicarPrecoParcelado();
        outra.VoltarParaItens();
        Assert.Equal((TipoPrecoVenda.Varejo, 3.49m), (outra.TipoPreco, linha.PrecoUnitario));

        // Com o pagamento parcelado lançado, voltar aos itens mantém o parcelado, e o item novo já entra nele.
        outra.IniciarPagamento();
        outra.AplicarPrecoParcelado();
        outra.LancarPagamento(Credito, 5m, Agora, Cartao(3));
        outra.VoltarParaItens();
        Assert.Equal(TipoPrecoVenda.Parcelado, outra.TipoPreco);
        var nova = outra.AdicionarItem(Lido(BrahmaCompleta()), 1m, "1", Agora);
        Assert.Equal((3.69m, OrigemPreco.Parcelado), (nova.PrecoUnitario, nova.OrigemPreco));
    }

    [Fact]
    public void Venda_recuperada_no_parcelado()
    {
        var produto = BrahmaCompleta();
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(produto), 2m, "1", Agora);
        venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, temPermissaoAtacado: true);
        venda.IniciarPagamento();
        venda.AplicarPrecoParcelado();

        Venda Recuperar(IEnumerable<PagamentoVenda> pagamentos, string? tipoAntes)
        {
            var estado = new EstadoVenda(venda.Id, venda.Numero, venda.NumeroExibicao, venda.LojaId, venda.CaixaId, venda.NumeroCaixa,
                venda.TerminalId, null, venda.Modo, venda.Status, venda.StatusFiscal, venda.OperadorId, venda.TipoPreco, 0m, null, 0m,
                venda.IniciadaEm, TipoPrecoAntesParcelado: tipoAntes);
            var copia = new ItemVenda(item.Id, item.Sequencia, item.ProdutoId, item.CodigoLido, null, item.Descricao, item.Unidade, false,
                item.Quantidade, item.PrecoTabela, item.PrecoUnitario, item.OrigemPreco, item.ValorBruto, 0m, item.IncluidoEm);
            var recuperada = Venda.Restaurar(estado, [copia], pagamentos);
            recuperada.RegistrarProdutos(venda.Snapshots.Select(s => s.Value), null, Agora);
            return recuperada;
        }

        // A queda veio entre o "Confirmar" e a maquininha: a recuperada fica como gravada (o RegistrarProdutos também refaz a
        // venda depois de um erro, com a maquininha na tela), e a abertura do caixa a volta ao tipo do F8.
        var semPagamento = Recuperar([], TipoPrecoVenda.Atacado);
        Assert.Equal(TipoPrecoVenda.Parcelado, semPagamento.TipoPreco);
        Assert.True(semPagamento.VoltarDoPrecoParcelado());
        Assert.Equal(TipoPrecoVenda.Atacado, semPagamento.TipoPreco);
        Assert.Equal((3.19m, OrigemPreco.Atacado), (semPagamento.ObterItem(item.Sequencia).PrecoUnitario, semPagamento.ObterItem(item.Sequencia).OrigemPreco));

        // Com o pagamento parcelado gravado, fica no parcelado; removê-lo volta ao atacado guardado no caixa.
        var credito = venda.LancarPagamento(Credito, 3m, Agora, Cartao(3));
        PagamentoVenda CopiaPagamento() => new(credito.Id, credito.Sequencia, credito.FormaPagamentoId, credito.DescricaoForma,
            credito.MeioPagamentoFiscal, credito.TipoForma, credito.Valor, null, 0m, credito.Status, credito.LancaQuitada, credito.TaxaPct,
            credito.Parcelas, detalhe: credito.Detalhe);
        var comPagamento = Recuperar([CopiaPagamento()], TipoPrecoVenda.Atacado);
        Assert.False(comPagamento.VoltarDoPrecoParcelado());
        Assert.Equal((TipoPrecoVenda.Parcelado, TipoPrecoVenda.Atacado), (comPagamento.TipoPreco, comPagamento.TipoPrecoAntesParcelado));
        Assert.Equal(3.69m, comPagamento.ObterItem(item.Sequencia).PrecoUnitario);
        comPagamento.RemoverPagamento(credito.Sequencia);
        Assert.Equal((TipoPrecoVenda.Atacado, 3.19m), (comPagamento.TipoPreco, comPagamento.ObterItem(item.Sequencia).PrecoUnitario));

        // Sem o tipo guardado (o estado_operacao de outra venda), a volta é ao varejo.
        var semTipo = Recuperar([CopiaPagamento()], null);
        Assert.Equal(TipoPrecoVenda.Varejo, semTipo.TipoPrecoAntesParcelado);
    }

    [Fact]
    public void MotorPreco_passo_9_substitui_os_candidatos_so_no_parcelado()
    {
        var produto = BrahmaCompleta();
        var parametros = new ParametrosPreco(Loja1, UsaPrecoVolume: false);

        var normal = MotorPreco.Resolver(produto, false, 12m, null, null, parametros);
        Assert.Equal((3.19m, OrigemPreco.Atacado), (normal.Preco, normal.Origem));

        var parcelado = MotorPreco.Resolver(produto, false, 12m, null, null, parametros with { Parcelado = true });
        Assert.Equal((3.69m, OrigemPreco.Parcelado), (parcelado.Preco, parcelado.Origem));
        Assert.Null(parcelado.QuantidadeReferencia);
        Assert.Contains(parcelado.Candidatos, c => c.Origem == OrigemPreco.Atacado);

        var semParcelado = MotorPreco.Resolver(BrahmaCompleta(parcelado: 0m), false, 12m, null, null, parametros with { Parcelado = true });
        Assert.Equal((3.19m, OrigemPreco.Atacado), (semParcelado.Preco, semParcelado.Origem));
    }
}
