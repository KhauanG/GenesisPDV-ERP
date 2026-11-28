using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.CatalogoTeste;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// Preço digitado do genérico e do "Solicita preço PDV" (PDV 10.4), alteração de preço no item (<c>Ctrl+F6</c>, 10.5) e
/// acréscimo no total (F6 › 3, 12.2) — Fase 3, F3-B16 — com os critérios da 12.5 e o rateio do acréscimo (12.4).
/// </summary>
public class PrecoManualTests
{
    private static ProdutoResolvido Generico(decimal preco = 0m) =>
        new(Produto("PRODUTO GENÉRICO", preco) with { Generico = true });

    private static ProdutoResolvido SolicitaPreco(decimal preco) =>
        new(Produto("CARVÃO SACO", preco) with { SolicitaPreco = true });

    private static Liberacao Supervisor(decimal limite) => new(Fixtures.Supervisor, limite, "Cliente fidelidade", Agora);

    // ------------------------------------------------------------ 10.4: genérico e "Solicita preço PDV"

    [Fact]
    public void Generico_entra_com_a_descricao_e_o_preco_digitados_e_origem_manual()
    {
        var venda = NovaVenda();
        var item = venda.AdicionarItem(Generico(), 2m, "9000", Agora, precoDigitado: new PrecoDigitado(12.50m, "  BRINQUEDO DE PRAIA  "));

        Assert.Equal("BRINQUEDO DE PRAIA", item.Descricao);
        Assert.Equal(OrigemPreco.Manual, item.OrigemPreco);
        Assert.Equal((12.50m, 12.50m, 25.00m), (item.PrecoTabela, item.PrecoUnitario, item.ValorBruto));
        // O preço digitado é a natureza do produto: não é redução de preço (12.3).
        Assert.Equal(0m, item.ReducaoPrecoManual);
        Assert.Equal(25.00m, venda.Total);
    }

    [Fact]
    public void Generico_com_preco_zero_e_recusado_e_sem_o_dialogo_continua_sem_preco()
    {
        var venda = NovaVenda();
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Generico(), 1m, "9000", Agora, precoDigitado: new PrecoDigitado(0m)));
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Generico(), 1m, "9000", Agora, precoDigitado: new PrecoDigitado(-1m)));
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Generico(), 1m, "9000", Agora, precoDigitado: new PrecoDigitado(1.005m)));
        Assert.Throws<RegraNegocioException>(() => RegrasPrecoManual.LerPreco("0"));
        Assert.Throws<RegraNegocioException>(() => RegrasPrecoManual.LerPreco("0,00"));
        Assert.Throws<RegraNegocioException>(() => RegrasPrecoManual.LerPreco("abc"));
        Assert.Equal(12.5m, RegrasPrecoManual.LerPreco("R$ 12,50"));

        // Sem o diálogo (o caixa sem o recurso da onda), o produto de preço zero continua recusado, como antes.
        var e = Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Generico(), 1m, "9000", Agora));
        Assert.Contains("sem preço", e.Message, StringComparison.Ordinal);
        Assert.Empty(venda.Itens);
    }

    [Fact]
    public void Descricao_do_generico_de_1_a_120_caracteres_e_so_no_generico()
    {
        var venda = NovaVenda();
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Generico(), 1m, null, Agora, precoDigitado: new PrecoDigitado(1m, "   ")));
        Assert.Throws<RegraNegocioException>(() =>
            venda.AdicionarItem(Generico(), 1m, null, Agora, precoDigitado: new PrecoDigitado(1m, new string('X', 121))));
        Assert.Equal(120, venda.AdicionarItem(Generico(), 1m, null, Agora, precoDigitado: new PrecoDigitado(1m, new string('X', 120))).Descricao.Length);
        Assert.Throws<RegraNegocioException>(() =>
            venda.AdicionarItem(SolicitaPreco(10m), 1m, null, Agora, precoDigitado: new PrecoDigitado(1m, "OUTRO NOME")));

        // Produto sem a marca não pede preço: o digitado é recusado (o preço é o do cadastro).
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Produto(10m), 1m, null, Agora, precoDigitado: new PrecoDigitado(8m)));
    }

    [Fact]
    public void Solicita_preco_menor_que_a_tabela_nao_conta_no_limite_nem_e_recalculado()
    {
        var venda = VendaPreco();
        var carvao = SolicitaPreco(20m);
        var item = venda.AdicionarItem(carvao, 1m, null, Agora, precoDigitado: new PrecoDigitado(15m));
        Assert.Equal("CARVÃO SACO", item.Descricao);
        Assert.Equal((15m, 15m), (item.PrecoTabela, item.PrecoUnitario));

        // Operador com limite 0%: o desconto no total de 1 centavo pede o supervisor, mas o preço digitado não pesou.
        var r = venda.AplicarDescontoTotal(Desconto.EmReais(0.01m), 0m);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, r.Situacao);
        Assert.Equal(0.01m / 15m * 100m, r.PercentualPedido);

        // Outra inclusão do mesmo produto é outra linha (o manual não agrupa).
        var segundo = venda.AdicionarItem(carvao, 1m, null, Agora, agrupar: true, precoDigitado: new PrecoDigitado(18m));
        Assert.NotEqual(item.Sequencia, segundo.Sequencia);
    }

    [Fact]
    public void Produto_de_preco_zero_sem_as_marcas_pede_o_preco_so_para_quem_pode_alterar_preco()
    {
        // Tabela da PDV 10.1: "Preço de venda = 0 e não é genérico/solicita preço → trata como Solicita preço PDV se o
        // operador tem pdv.venda.alterar_preco; senão 'Produto sem preço — procure o supervisor'".
        var venda = NovaVenda();
        var gelo = Produto(0m, "GELO 5KG");
        Assert.False(Venda.PedePreco(gelo.Produto, liberaSemPreco: false));
        Assert.True(Venda.PedePreco(gelo.Produto, liberaSemPreco: true));
        var semPermissao = Assert.Throws<RegraNegocioException>(() =>
            venda.AdicionarItem(gelo, 1m, null, Agora, precoDigitado: new PrecoDigitado(8.00m)));
        Assert.Contains("Produto sem preço", semPermissao.Message, StringComparison.Ordinal);
        Assert.Empty(venda.Itens);

        var item = venda.AdicionarItem(gelo, 2m, null, Agora, precoDigitado: new PrecoDigitado(8.00m), liberaSemPreco: true);
        Assert.Equal(("GELO 5KG", OrigemPreco.Manual), (item.Descricao, item.OrigemPreco));
        Assert.Equal((8.00m, 8.00m, 16.00m, 0m), (item.PrecoTabela, item.PrecoUnitario, item.ValorBruto, item.ReducaoPrecoManual));

        // A permissão não abre o preço do produto que tem preço, nem a descrição digitada fora do genérico.
        Assert.False(Venda.PedePreco(Produto(10m).Produto, liberaSemPreco: true));
        Assert.Throws<RegraNegocioException>(() =>
            venda.AdicionarItem(Produto(10m), 1m, null, Agora, precoDigitado: new PrecoDigitado(8m), liberaSemPreco: true));
        Assert.Throws<RegraNegocioException>(() =>
            venda.AdicionarItem(gelo, 1m, null, Agora, precoDigitado: new PrecoDigitado(8m, "OUTRO NOME"), liberaSemPreco: true));
        Assert.Single(venda.Itens);
    }

    [Fact]
    public void Generico_com_complementos_soma_o_adicional_ao_preco_digitado()
    {
        // O "com complementos" que pede preço (10.4): Rosé (0,00) e bacon (+3,00) sobre os 10,00 digitados.
        var venda = NovaVenda();
        var porcao = new ProdutoResolvido(ComplementosTests.Porcao() with { Generico = true });
        var item = venda.AdicionarItem(porcao, 2m, null, Agora,
            complementos: [ComplementosTests.Rose, ComplementosTests.Bacon], precoDigitado: new PrecoDigitado(10.00m, "PORÇÃO DA CASA"));

        Assert.Equal(("PORÇÃO DA CASA", OrigemPreco.Manual), (item.Descricao, item.OrigemPreco));
        Assert.Equal((13.00m, 13.00m, 26.00m, 3.00m), (item.PrecoTabela, item.PrecoUnitario, item.ValorBruto, item.AcrescimoUnitario));
        Assert.Equal(0m, item.ReducaoPrecoManual);
        Assert.Equal(["Rosé", "Bacon"], item.Complementos.Select(c => c.Descricao));
        Assert.Equal(26.00m, venda.Total);
    }

    [Fact]
    public void Preco_digitado_acima_do_teto_do_caixa_e_recusado_e_o_bruto_cabe_no_contrato()
    {
        // O pdv.limite_preco_digitado só pede o segundo Enter (e vazio nem isso): o teto recusa o dedo preso no 0, que a
        // nuvem recusaria com a venda inteira (preço com 11 dígitos inteiros no contrato).
        Assert.Equal(RegrasPrecoManual.PrecoMaximo, RegrasPrecoManual.ValidarPreco(RegrasPrecoManual.PrecoMaximo));
        Assert.Throws<RegraNegocioException>(() => RegrasPrecoManual.LerPreco("1000000000000"));
        var e = Assert.Throws<RegraNegocioException>(() => RegrasPrecoManual.ValidarPreco(RegrasPrecoManual.PrecoMaximo + 0.01m));
        Assert.Contains("máximo", e.Message, StringComparison.Ordinal);

        var venda = NovaVenda();
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Generico(), 1m, null, Agora, precoDigitado: new PrecoDigitado(1_000_000m)));
        Assert.Empty(venda.Itens);

        // No teto e na maior quantidade, o valor_bruto ainda cabe com folga nos 13 dígitos do contrato.
        var maior = venda.AdicionarItem(Generico(), 9999m, null, Agora, precoDigitado: new PrecoDigitado(RegrasPrecoManual.PrecoMaximo));
        Assert.True(maior.ValorBruto <= Venda.ValorBrutoMaximo);

        var outra = VendaComItens(10.00m);
        Assert.Throws<RegraNegocioException>(() => outra.AlterarPrecoItem(1, 1_000_000m, 100m));
        Assert.Equal(10.00m, outra.Itens[0].PrecoUnitario);

        // O preço do cadastro também: a linha cujo bruto passa do contrato é recusada no caixa, e não na nuvem.
        var bruto = Assert.Throws<RegraNegocioException>(() => NovaVenda().AdicionarItem(Produto(10_000_000_000m), 9999m, null, Agora));
        Assert.Contains("valor máximo", bruto.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Preco_digitado_acima_do_limite_pede_confirmacao()
    {
        Assert.False(RegrasPrecoManual.AcimaDoLimite(9999.99m, RegrasPrecoManual.LimitePadrao));
        Assert.True(RegrasPrecoManual.AcimaDoLimite(10000m, RegrasPrecoManual.LimitePadrao));
        Assert.False(RegrasPrecoManual.AcimaDoLimite(1_000_000m, null));
        Assert.Contains("R$ 9.999,99", RegrasPrecoManual.MensagemAcimaDoLimite(10000m, RegrasPrecoManual.LimitePadrao), StringComparison.Ordinal);
    }

    [Fact]
    public void Preco_manual_nao_muda_com_o_atacado_dos_outros_itens()
    {
        var venda = VendaPreco();
        var brahma = Brahma() with { SolicitaPreco = true };
        var manual = venda.AdicionarItem(new ProdutoResolvido(brahma), 1m, null, Agora, precoDigitado: new PrecoDigitado(3.00m));
        venda.AdicionarItem(new ProdutoResolvido(brahma), 11m, null, Agora);

        // 12 latas no total (a do preço digitado conta na quantidade): as recalculáveis vão ao atacado; a digitada fica 3,00.
        Assert.Equal((OrigemPreco.Manual, 3.00m), (manual.OrigemPreco, manual.PrecoUnitario));
        Assert.Equal(3.19m, venda.Itens[1].PrecoUnitario);
    }

    // ------------------------------------------------------------ 10.5 e 12.5: Ctrl+F6

    [Fact]
    public void Alterar_10_para_8_com_limite_de_10_pct_pede_a_senha_do_supervisor()
    {
        // Critério 12.5: "Alterar o preço de 10,00 para 8,00 com operador de limite 10% pede senha (20%)".
        var venda = VendaComItens(10.00m);
        var pedido = venda.AlterarPrecoItem(1, 8.00m, 10m);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, pedido.Situacao);
        Assert.Equal(20m, pedido.PercentualPedido);
        Assert.Equal((10.00m, OrigemPreco.Varejo), (venda.Itens[0].PrecoUnitario, venda.Itens[0].OrigemPreco));

        // O supervisor com 12% não libera 20%; com 20% libera.
        Assert.Equal(SituacaoDesconto.LiberacaoInsuficiente, venda.AlterarPrecoItem(1, 8.00m, 10m, Supervisor(12m)).Situacao);
        Assert.Empty(venda.Liberacoes);
        var liberado = venda.AlterarPrecoItem(1, 8.00m, 10m, Supervisor(20m));
        Assert.True(liberado.Aplicado && liberado.PorLiberacao);

        var item = venda.Itens[0];
        Assert.Equal((10.00m, 8.00m, 8.00m, OrigemPreco.Manual), (item.PrecoTabela, item.PrecoUnitario, item.ValorBruto, item.OrigemPreco));
        Assert.Equal(2.00m, item.ReducaoPrecoManual);
        Assert.Equal(Fixtures.Supervisor, item.AutorizadoPorId);
        var lib = Assert.Single(venda.Liberacoes);
        Assert.Equal((AcaoLiberacao.AlterarPreco, item.Id, 20m), (lib.Acao, lib.ItemVendaId, lib.ValorPct));
        Assert.Equal(8.00m, venda.Total);
    }

    [Fact]
    public void Reducao_dentro_do_limite_e_aumento_nao_pedem_supervisor()
    {
        var venda = VendaComItens(10.00m, 5.00m);
        var dentro = venda.AlterarPrecoItem(1, 9.00m, 10m);
        Assert.True(dentro.Aplicado && !dentro.PorLiberacao);
        Assert.Equal(10m, dentro.PercentualPedido);

        // Subir o preço não passa pelo limite, nem com o de 0% e a redução do item 1 já na venda.
        var aumento = venda.AlterarPrecoItem(2, 7.50m, 0m);
        Assert.True(aumento.Aplicado && !aumento.PorLiberacao);
        Assert.Equal((5.00m, 7.50m, 0m), (venda.Itens[1].PrecoTabela, venda.Itens[1].PrecoUnitario, venda.Itens[1].ReducaoPrecoManual));
        Assert.Empty(venda.Liberacoes);
        Assert.Equal(16.50m, venda.Total);
    }

    [Fact]
    public void Sem_a_permissao_toda_alteracao_e_do_supervisor()
    {
        var venda = VendaComItens(10.00m);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, venda.AlterarPrecoItem(1, 12.00m, 0m, exigeLiberacao: true).Situacao);
        Assert.Equal(10.00m, venda.Itens[0].PrecoUnitario);

        var r = venda.AlterarPrecoItem(1, 12.00m, 0m, Supervisor(0m), exigeLiberacao: true);
        Assert.True(r.Aplicado && r.PorLiberacao);
        Assert.Equal(12.00m, venda.Itens[0].PrecoUnitario);
        Assert.Equal(AcaoLiberacao.AlterarPreco, Assert.Single(venda.Liberacoes).Acao);

        // A redução também precisa caber no limite do supervisor.
        Assert.Equal(SituacaoDesconto.LiberacaoInsuficiente, venda.AlterarPrecoItem(1, 5.00m, 0m, Supervisor(10m), exigeLiberacao: true).Situacao);
    }

    [Fact]
    public void Reducao_de_preco_soma_com_o_desconto_no_total_no_limite_da_venda()
    {
        var venda = VendaComItens(10.00m, 10.00m);
        Assert.True(venda.AlterarPrecoItem(1, 9.00m, 10m).Aplicado);

        // 1,00 de redução + 1,00 de desconto no total = 10% de 20,00: cabe; 1,01 já passa.
        Assert.True(venda.AplicarDescontoTotal(Desconto.EmReais(1.00m), 10m).Aplicado);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, venda.AplicarDescontoTotal(Desconto.EmReais(1.01m), 10m).Situacao);
    }

    [Fact]
    public void Alteracao_recusada_no_combo_com_desconto_com_pagamento_e_no_mesmo_preco()
    {
        var venda = VendaComItens(10.00m, 10.00m);
        Assert.Throws<RegraNegocioException>(() => venda.AlterarPrecoItem(1, 10.00m, 10m));
        Assert.Throws<RegraNegocioException>(() => venda.AlterarPrecoItem(1, 0m, 10m));
        Assert.Throws<RegraNegocioException>(() => venda.AlterarPrecoItem(1, 8.005m, 10m));
        Assert.Throws<RegraNegocioException>(() => venda.AlterarPrecoItem(9, 8m, 10m));

        venda.AplicarDescontoItem(2, Desconto.EmReais(0.50m), 10m);
        var e = Assert.Throws<RegraNegocioException>(() => venda.AlterarPrecoItem(2, 8m, 10m));
        Assert.Contains("remova o desconto", e.Message, StringComparison.Ordinal);

        venda.IniciarPagamento();
        venda.LancarPagamento(Pix, 1m, Agora, pix: PixConfirmado);
        venda.VoltarParaItens();
        Assert.Throws<RegraNegocioException>(() => venda.AlterarPrecoItem(1, 12m, 10m));
    }

    [Fact]
    public void Quantidade_do_item_com_preco_alterado_segue_o_preco_manual_e_o_limite()
    {
        var venda = VendaComItens(10.00m);
        Assert.True(venda.AlterarPrecoItem(1, 9.00m, 10m).Aplicado);
        venda.AlterarQuantidade(1, 3m, 10m);
        var item = venda.Itens[0];
        Assert.Equal((9.00m, 27.00m, 30.00m, 3.00m), (item.PrecoUnitario, item.ValorBruto, item.ValorTabela, item.ReducaoPrecoManual));
    }

    [Fact]
    public void Preco_alterado_no_atacado_mede_a_reducao_contra_o_varejo_e_nao_some_ao_diminuir_a_quantidade()
    {
        // Brahma 3,49 com atacado 3,19 a partir de 12: 3,20 parece subir o preço, mas é 8,31% abaixo do varejo. Medida
        // contra o atacado congelado (redução 0), a linha manual com 1 unidade sairia a 3,20 sem passar pelo limite.
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma()), 12m, "1", Agora);
        var item = venda.Itens[0];
        Assert.Equal((OrigemPreco.Atacado, 3.19m, 3.49m), (item.OrigemPreco, item.PrecoTabela, item.PrecoTabelaParaPrecoManual));

        var pedido = venda.AlterarPrecoItem(1, 3.20m, 5m);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, pedido.Situacao);
        Assert.Equal(3.48m / 41.88m * 100m, pedido.PercentualPedido);
        Assert.Equal((OrigemPreco.Atacado, 3.19m), (item.OrigemPreco, item.PrecoTabela));

        Assert.True(venda.AlterarPrecoItem(1, 3.20m, 10m).Aplicado);
        Assert.Equal((3.49m, 3.20m, 38.40m, 3.48m, OrigemPreco.Manual),
            (item.PrecoTabela, item.PrecoUnitario, item.ValorBruto, item.ReducaoPrecoManual, item.OrigemPreco));

        // De 12 para 1: a redução continua medida contra o varejo (0,29 de 3,49, os mesmos 8,31%), no limite de quem a aceitou.
        venda.AlterarQuantidade(1, 1m, 10m);
        Assert.Equal((3.49m, 3.20m, 0.29m), (item.PrecoTabela, item.ValorBruto, item.ReducaoPrecoManual));
        Assert.Equal(0.29m, venda.Itens.Sum(i => i.ReducaoPrecoManual));
    }

    [Fact]
    public void Preco_alterado_no_mix_leva_o_varejo_como_tabela_e_o_cancelamento_do_grupo_nao_o_tira_do_limite()
    {
        var mix = Mix(ModoPrecoGrupo.Grupo, precoFaixa12: 2.99m);
        var venda = VendaPreco(usaPrecoVolume: true);
        venda.AdicionarItem(Lido(Brahma(mix)), 5m, "1", Agora);
        venda.AdicionarItem(Lido(Skol(mix)), 4m, "2", Agora);
        var antarctica = venda.AdicionarItem(Lido(Antarctica(mix)), 3m, "3", Agora);
        Assert.Equal((OrigemPreco.GrupoMix, 2.99m), (venda.Itens[0].OrigemPreco, venda.Itens[0].PrecoTabela));

        // 5 Brahma a 3,00: contra o varejo (17,45), 2,45 de redução (14,04%); contra o mix (14,95) seria um aumento.
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, venda.AlterarPrecoItem(1, 3.00m, 10m).Situacao);
        Assert.True(venda.AlterarPrecoItem(1, 3.00m, 15m).Aplicado);
        var brahma = venda.Itens[0];
        Assert.Equal((3.49m, 2.45m), (brahma.PrecoTabela, brahma.ReducaoPrecoManual));

        // Cancelar a linha que completava o grupo não muda a tabela da linha manual (nem a tira do limite).
        venda.CancelarItem(antarctica.Sequencia, Operador, Agora, 15m);
        Assert.Equal((3.49m, 3.00m, 2.45m), (brahma.PrecoTabela, brahma.PrecoUnitario, brahma.ReducaoPrecoManual));
    }

    // ------------------------------------------------------------ 12.2: F6 › 3 acréscimo no total

    [Fact]
    public void Acrescimo_em_percentual_vira_valor_e_e_rateado_com_soma_exata()
    {
        // Os itens do exemplo da 12.4 (10,00 · 20,00 · 30,01): 10% = arred2(6,001) = 6,00.
        var venda = VendaComItens(10.00m, 20.00m, 30.01m);
        Assert.Equal(6.00m, venda.AplicarAcrescimo(Desconto.LerAcrescimo("10%")));
        Assert.Equal(6.00m, venda.AcrescimoTotal);
        Assert.Equal(66.01m, venda.Total);
        Assert.Equal(6.00m, venda.Itens.Sum(i => i.AcrescimoRateado));
        Assert.Equal(venda.Total, venda.Itens.Sum(i => i.ValorLiquido));

        // Substitui o anterior; em R$ fica fixo quando os itens mudam.
        Assert.Equal(2.50m, venda.AplicarAcrescimo(Desconto.LerAcrescimo("2,50")));
        venda.AdicionarItem(Produto(5m), 1m, null, Agora);
        Assert.Equal(2.50m, venda.AcrescimoTotal);
        Assert.Equal(2.50m, venda.Itens.Sum(i => i.AcrescimoRateado));
    }

    [Fact]
    public void Acrescimo_recusado_sem_itens_zero_e_do_tamanho_da_venda_e_removido_pelo_f6_4()
    {
        var vazia = NovaVenda();
        Assert.Throws<RegraNegocioException>(() => vazia.AplicarAcrescimo(Desconto.EmReais(1m)));

        var venda = VendaComItens(10.00m);
        Assert.Throws<RegraNegocioException>(() => venda.AplicarAcrescimo(Desconto.EmReais(10.00m)));
        Assert.Throws<RegraNegocioException>(() => Desconto.LerAcrescimo("0"));
        Assert.Throws<RegraNegocioException>(() => Desconto.LerAcrescimo("100%"));
        var e = Assert.Throws<RegraNegocioException>(() => Desconto.LerAcrescimo("2,505"));
        Assert.Contains("acréscimo", e.Message, StringComparison.Ordinal);
        Assert.Throws<RegraNegocioException>(() => venda.RemoverAcrescimoTotal());

        venda.AplicarAcrescimo(Desconto.EmReais(9.99m));
        venda.RemoverAcrescimoTotal();
        Assert.Equal((0m, 10.00m), (venda.AcrescimoTotal, venda.Total));
    }

    /// <summary>
    /// Propriedade (PDV 12.4; Padrões da Fase 3, "líquido mínimo"): em vendas aleatórias com desconto no item, desconto e
    /// acréscimo no total em % ou em R$, Σ acréscimo rateado é exatamente o acréscimo, Σ líquidos é o total, e nenhum item
    /// que tinha líquido ≥ 0,01 fica abaixo disso.
    /// </summary>
    [Fact]
    public void Rateio_do_acrescimo_tem_soma_exata_e_nenhum_liquido_abaixo_do_minimo()
    {
        var aleatorio = new Random(20261127);
        for (var n = 0; n < 2_000; n++)
        {
            var venda = NovaVenda();
            var itens = aleatorio.Next(1, 9);
            for (var i = 0; i < itens; i++)
            {
                venda.AdicionarItem(Produto(aleatorio.Next(100, aleatorio.Next(2) == 0 ? 300 : 90_000) / 100m), aleatorio.Next(1, 4), null, Agora);
            }

            var item = venda.Itens[aleatorio.Next(venda.Itens.Count)];
            if (aleatorio.Next(3) == 0 && item.ValorBruto > 0.02m)
            {
                venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(Math.Max(0.01m, Numeros.Arredondamento.Truncar2(item.ValorBruto / 3m))), 100m);
            }

            if (aleatorio.Next(2) == 0)
            {
                venda.AplicarDescontoTotal(Desconto.EmPercentual(aleatorio.Next(1, 50)), 100m);
            }

            var acrescimo = aleatorio.Next(2) == 0
                ? Desconto.EmPercentual(aleatorio.Next(1, 9_000) / 100m)
                : Desconto.EmReais(Math.Max(0.01m, Numeros.Arredondamento.Truncar2(venda.Itens.Sum(i => i.BaseRateio) * aleatorio.Next(1, 99) / 100m)));
            // O % pequeno sobre uma base pequena dá R$ 0,00 (0,01% de R$ 1,00): a recusa é o esperado, não um defeito, e a
            // semente fixa só serve para reproduzir uma falha (outra semente ou mais um sorteio não deixam o teste vermelho).
            if (acrescimo.ValorSobre(venda.ItensAtivos.Sum(i => i.BaseRateio)) <= 0m)
            {
                var recusa = Assert.Throws<RegraNegocioException>(() => venda.AplicarAcrescimo(acrescimo));
                Assert.Contains("maior que zero", recusa.Message, StringComparison.Ordinal);
                Assert.Equal(0m, venda.AcrescimoTotal);
                continue;
            }

            var valor = venda.AplicarAcrescimo(acrescimo);

            Assert.Equal(valor, venda.AcrescimoTotal);
            Assert.Equal(venda.AcrescimoTotal, venda.ItensAtivos.Sum(i => i.AcrescimoRateado));
            Assert.Equal(venda.DescontoTotal, venda.ItensAtivos.Sum(i => i.DescontoRateado));
            Assert.Equal(venda.Total, venda.ItensAtivos.Sum(i => i.ValorLiquido));
            Assert.All(venda.ItensAtivos, i =>
            {
                Assert.True(i.AcrescimoRateado >= 0m);
                Assert.True(i.ValorLiquido >= 0.01m, $"item {i.Sequencia} com líquido {i.ValorLiquido}");
            });
        }
    }
}
