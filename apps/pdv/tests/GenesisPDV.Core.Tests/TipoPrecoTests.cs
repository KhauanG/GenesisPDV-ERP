using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.CatalogoTeste;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>
/// <c>F8</c> Tipo de preço (PDV 11.2, 11.3.1; Fase 3, F3-B17; F3-Q2): o Atacado põe o candidato atacado sem a quantidade
/// mínima em todas as linhas recalculáveis, o menor continua valendo (fardo, faixa e mix) e o preço manual, o combo e os
/// adicionais dos complementos ficam como estavam.
/// </summary>
public class TipoPrecoTests
{
    private static Liberacao Supervisor(string motivo = "Cliente bar do bairro") => new(Fixtures.Supervisor, 0m, motivo, Agora);

    [Fact]
    public void Atacado_recalcula_e_mantem_os_manuais()
    {
        // Critério 11.5: "Trocar o tipo de preço para Atacado recalcula os itens e mantém os de preço manual".
        var venda = VendaPreco();
        var brahma = Brahma();
        var latas = venda.AdicionarItem(Lido(brahma), 3m, "1", Agora);
        var manual = venda.AdicionarItem(Lido(Skol()), 2m, "2", Agora);
        Assert.True(venda.AlterarPrecoItem(manual.Sequencia, 2.50m, 20m).Aplicado);
        var semAtacado = venda.AdicionarItem(Lido(Produto("COCA 2L", 9.99m)), 1m, "3", Agora);
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        var totalVarejo = venda.Total;

        var r = venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, temPermissaoAtacado: true);

        Assert.True(r.Aplicado);
        Assert.False(r.PorLiberacao);
        Assert.Equal(TipoPrecoVenda.Atacado, venda.TipoPreco);
        Assert.Equal(1, r.LinhasAlteradas);
        Assert.Equal(totalVarejo, r.TotalAntes);
        Assert.Equal(venda.Total, r.TotalDepois);
        // As 3 latas no atacado, sem o "12+" (o F8 não depende da quantidade), com o varejo riscado e a economia.
        Assert.Equal(3.19m, latas.PrecoUnitario);
        Assert.Equal(3.19m, latas.PrecoTabela);
        Assert.Equal(9.57m, latas.ValorBruto);
        Assert.Equal(OrigemPreco.Atacado, latas.OrigemPreco);
        Assert.Equal("ATAC", latas.EtiquetaPreco);
        // O preço veio do tipo da venda, não da quantidade: a quantidade_referencia_preco sobe nula (decisão 234 da API).
        Assert.Null(latas.QuantidadeReferenciaPreco);
        Assert.Equal(0.90m, venda.EconomiaAtacado);
        // O preço manual fica (com a tabela de antes) e o produto sem atacado fica no varejo.
        Assert.Equal(2.50m, manual.PrecoUnitario);
        Assert.Equal(OrigemPreco.Manual, manual.OrigemPreco);
        Assert.Equal(9.99m, semAtacado.PrecoUnitario);
        Assert.Equal(OrigemPreco.Varejo, semAtacado.OrigemPreco);
        Assert.Equal(9.57m + 5.00m + 9.99m, venda.Total);
        Assert.Empty(venda.Liberacoes);

        // Um item novo já entra no atacado; a volta ao varejo (sem permissão) refaz tudo.
        var nova = venda.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        Assert.Equal(3.19m, nova.PrecoUnitario);
        var volta = venda.AlterarTipoPreco(TipoPrecoVenda.Varejo, temPermissaoAtacado: false);
        Assert.True(volta.Aplicado);
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        Assert.All(new[] { latas, nova }, i =>
        {
            Assert.Equal(3.49m, i.PrecoUnitario);
            Assert.Equal(OrigemPreco.Varejo, i.OrigemPreco);
        });
        Assert.Equal(2.50m, manual.PrecoUnitario);
    }

    [Fact]
    public void Atacado_sem_a_permissao_pede_o_supervisor_e_grava_a_liberacao_da_venda()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Brahma()), 2m, "1", Agora);

        var pedido = venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, temPermissaoAtacado: false);
        Assert.Equal(SituacaoDesconto.ExigeLiberacao, pedido.Situacao);
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        Assert.Equal(3.49m, item.PrecoUnitario);

        Assert.Throws<RegraNegocioException>(() => venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, false, Supervisor("   ")));
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);

        var liberado = venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, false, Supervisor());
        Assert.True(liberado.Aplicado);
        Assert.True(liberado.PorLiberacao);
        Assert.Equal(3.19m, item.PrecoUnitario);
        var l = Assert.Single(venda.Liberacoes);
        Assert.Equal(AcaoLiberacao.TipoPreco, l.Acao);
        Assert.Null(l.ItemVendaId);
        Assert.Null(l.ValorPct);
        Assert.Equal(Fixtures.Supervisor, l.AutorizadoPorId);
        Assert.Equal("Cliente bar do bairro", l.Motivo);

        // Com a permissão, a liberação informada é ignorada (não vira linha de liberacoes).
        venda.AlterarTipoPreco(TipoPrecoVenda.Varejo, false);
        Assert.False(venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true, Supervisor()).PorLiberacao);
        Assert.Single(venda.Liberacoes);
    }

    [Fact]
    public void Recusas_do_F8()
    {
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma()), 1m, "1", Agora);

        Assert.Throws<RegraNegocioException>(() => venda.AlterarTipoPreco(TipoPrecoVenda.Varejo, true));
        Assert.Throws<RegraNegocioException>(() => venda.AlterarTipoPreco(TipoPrecoVenda.Parcelado, true));
        Assert.Throws<RegraNegocioException>(() => venda.AlterarTipoPreco("promocional", true));

        // Com pagamento lançado o total não muda pelo F8 (nem na tela de pagamento, nem de volta aos itens).
        venda.IniciarPagamento();
        Assert.Throws<RegraNegocioException>(() => venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true));
        venda.LancarPagamento(Dinheiro, 1m, Agora);
        venda.VoltarParaItens();
        var ex = Assert.Throws<RegraNegocioException>(() => venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true));
        Assert.Contains("pagamentos", ex.Message, StringComparison.Ordinal);
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        Assert.Equal(3.49m, venda.Itens[0].PrecoUnitario);
    }

    [Fact]
    public void Fardo_com_o_F8_vale_o_menor_entre_o_preco_do_fardo_e_o_atacado()
    {
        var barato = Guid.NewGuid();
        var caro = Guid.NewGuid();
        var brahma = Brahma(embalagens: [new EmbalagemPreco(barato, 6m, 18.00m, "FD"), new EmbalagemPreco(caro, 12m, 39.00m, "FD")]);
        var venda = VendaPreco();
        // O mínimo do atacado alto (100), para os 18 da soma dos fardos não ativarem o atacado pela quantidade.
        var produto = brahma with { Precos = brahma.Precos! with { QtdMinimaAtacado = 100m } };
        var fardoBarato = venda.AdicionarItem(Fardo(produto, barato, 6m, 18.00m), 1m, "DUN6", Agora);
        var fardoCaro = venda.AdicionarItem(Fardo(produto, caro, 12m, 39.00m), 1m, "DUN12", Agora);
        Assert.Equal(OrigemPreco.Embalagem, fardoBarato.OrigemPreco);
        Assert.Equal(OrigemPreco.Embalagem, fardoCaro.OrigemPreco);
        Assert.Equal(39.00m, fardoCaro.ValorBruto);

        var r = venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true);

        // 18,00 ÷ 6 = 3,00 < 3,19: o fardo de 6 fica no preço dele; 39,00 ÷ 12 = 3,25 > 3,19: o de 12 cai no atacado.
        Assert.Equal(1, r.LinhasAlteradas);
        Assert.Equal(OrigemPreco.Embalagem, fardoBarato.OrigemPreco);
        Assert.Equal(18.00m, fardoBarato.ValorBruto);
        Assert.Equal(OrigemPreco.Atacado, fardoCaro.OrigemPreco);
        Assert.Equal(3.19m, fardoCaro.PrecoUnitario);
        Assert.Equal(38.28m, fardoCaro.ValorBruto);
        Assert.Equal(56.28m, venda.Total);

        venda.AlterarTipoPreco(TipoPrecoVenda.Varejo, false);
        Assert.Equal(OrigemPreco.Embalagem, fardoCaro.OrigemPreco);
        Assert.Equal(39.00m, fardoCaro.ValorBruto);
    }

    [Fact]
    public void Mix_com_o_F8_nao_muda_e_vale_o_menor()
    {
        // 6 Brahma + 6 Skol no mix modo grupo (12+ a 2,99): o F8 não tira o mix da Brahma (2,99 é menor que o atacado
        // dela, 3,19) e a Skol cai para o atacado dela (2,79, menor que o mix).
        var mix = Mix(ModoPrecoGrupo.Grupo, 2.99m);
        var venda = VendaPreco(usaPrecoVolume: true);
        var brahma = venda.AdicionarItem(Lido(Brahma(mix)), 6m, "1", Agora);
        var skol = venda.AdicionarItem(Lido(Skol(mix)), 6m, "2", Agora);
        Assert.Equal(OrigemPreco.GrupoMix, brahma.OrigemPreco);
        Assert.Equal(OrigemPreco.GrupoMix, skol.OrigemPreco);
        Assert.Equal(2.99m, skol.PrecoUnitario);

        venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true);
        Assert.Equal(2.99m, brahma.PrecoUnitario);
        Assert.Equal(OrigemPreco.GrupoMix, brahma.OrigemPreco);
        Assert.Equal(12m, brahma.QuantidadeReferenciaPreco);
        Assert.Equal(MixId, brahma.GrupoPrecoQuantidadeId);
        Assert.Equal(2.79m, skol.PrecoUnitario);
        Assert.Equal(OrigemPreco.Atacado, skol.OrigemPreco);

        // Abaixo do mix (11 latas), o F8 ainda põe as duas no atacado de cada uma, sem a quantidade mínima.
        venda.AlterarQuantidade(brahma.Sequencia, 5m, 0m);
        Assert.Equal(3.19m, brahma.PrecoUnitario);
        Assert.Equal(OrigemPreco.Atacado, brahma.OrigemPreco);
        Assert.Null(brahma.GrupoPrecoQuantidadeId);
        Assert.Equal(2.79m, skol.PrecoUnitario);

        venda.AlterarTipoPreco(TipoPrecoVenda.Varejo, false);
        Assert.Equal(3.49m, brahma.PrecoUnitario);
        Assert.Equal(2.99m, skol.PrecoUnitario);
        Assert.Equal(OrigemPreco.Varejo, skol.OrigemPreco);
    }

    [Fact]
    public void F8_preserva_os_adicionais_dos_complementos_e_nao_mexe_no_combo()
    {
        var venda = VendaPreco();
        var porcao = ComplementosTests.Porcao(new TabelaPreco(PrecoAtacado: 22.00m, QtdMinimaAtacado: 3m));
        var item = venda.AdicionarItem(new ProdutoResolvido(porcao), 1m, "0300", Agora,
            complementos: [ComplementosTests.Barbecue, ComplementosTests.Cheddar]);
        Assert.Equal(29.50m, item.PrecoUnitario);
        var whisky = ComboWhisky();
        var combo = venda.AdicionarCombo(whisky, whisky.EscolhasPadrao, 1m, "0500", Agora);
        var valoresCombo = combo.Select(c => (c.PrecoUnitario, c.ValorBruto, c.OrigemPreco)).ToList();

        venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true);

        // 22,00 do atacado + 4,50 do cheddar, no unitário e na tabela.
        Assert.Equal(26.50m, item.PrecoUnitario);
        Assert.Equal(26.50m, item.PrecoTabela);
        Assert.Equal(OrigemPreco.Atacado, item.OrigemPreco);
        Assert.Equal(4.50m, item.AcrescimoUnitario);
        Assert.Equal(valoresCombo, combo.Select(c => (c.PrecoUnitario, c.ValorBruto, c.OrigemPreco)).ToList());
    }

    [Fact]
    public void Desconto_no_item_em_percentual_e_refeito_e_a_venda_recuperada_fica_no_tipo_gravado()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Brahma()), 10m, "1", Agora);
        Assert.True(venda.AplicarDescontoItem(item.Sequencia, Desconto.EmPercentual(10m), 10m).Aplicado);
        Assert.Equal(3.49m, item.DescontoItem);

        venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true);
        Assert.Equal(31.90m, item.ValorBruto);
        Assert.Equal(3.19m, item.DescontoItem);

        // A venda recuperada (o tipo gravado em vendas.tipo_preco) continua no atacado.
        var estado = new EstadoVenda(venda.Id, 1, venda.NumeroExibicao, venda.LojaId, venda.CaixaId, 2, null, null, "balcao",
            venda.Status, venda.StatusFiscal, Operador, venda.TipoPreco, 0m, null, 0m, Agora);
        var recuperada = Venda.Restaurar(estado, [], []);
        Assert.Equal(TipoPrecoVenda.Atacado, recuperada.TipoPreco);
    }

    [Fact]
    public void Desconto_no_item_em_reais_fica_dentro_do_teto_e_nao_sobe_na_volta()
    {
        // 10 latas a 3,49 (34,90) com R$ 3,49 de desconto (10%, o limite do operador). No atacado a tabela cai para 31,90:
        // o permitido é 3,19, e o desconto não volta a 3,49 sozinho no varejo (o operador pode dar de novo, no limite).
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Brahma()), 10m, "1", Agora);
        Assert.True(venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(3.49m), 10m).Aplicado);
        venda.ConsumirAvisos();

        venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true);
        Assert.Equal(31.90m, item.ValorBruto);
        Assert.Equal(3.19m, item.DescontoItem);
        Assert.Contains(venda.ConsumirAvisos(), a => a.Contains("Desconto do item 1 ajustado para R$ 3,19", StringComparison.Ordinal));

        venda.AlterarTipoPreco(TipoPrecoVenda.Varejo, false);
        Assert.Equal(34.90m, item.ValorBruto);
        Assert.Equal(3.19m, item.DescontoItem);
    }

    [Fact]
    public void Desconto_no_total_em_reais_fica_dentro_do_teto_e_nao_sobe_na_volta()
    {
        // O mesmo com o desconto no total (decisão 27): sem o ajuste ao teto no F8, os 3,49 ficariam em 10,9% da tabela do
        // atacado, acima do limite do operador.
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma()), 10m, "1", Agora);
        Assert.True(venda.AplicarDescontoTotal(Desconto.EmReais(3.49m), 10m).Aplicado);
        Assert.Equal(3.49m, venda.DescontoTotal);
        venda.ConsumirAvisos();

        venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true);
        Assert.Equal(3.19m, venda.DescontoTotal);
        Assert.Equal(31.90m - 3.19m, venda.Total);
        Assert.Contains(venda.ConsumirAvisos(), a => a.StartsWith("Desconto no total ajustado para R$ 3,19", StringComparison.Ordinal));

        venda.AlterarTipoPreco(TipoPrecoVenda.Varejo, false);
        Assert.Equal(3.19m, venda.DescontoTotal);
        Assert.Equal(34.90m - 3.19m, venda.Total);
        Assert.Empty(venda.ConsumirAvisos());
    }

    [Fact]
    public void Falha_no_recalculo_volta_o_tipo_e_as_linhas()
    {
        // Fracionável a 5,00 com atacado de 1,00: 0,003 kg dá 0,015 → 0,02 no varejo, mas 0,003 no atacado arredonda para
        // R$ 0,00 e a linha é recusada de dentro do Atomico. A foto volta as linhas e o tipo (sem ela, a venda ficaria
        // marcada atacado com as linhas no varejo, e o próximo item já entraria no atacado).
        var venda = VendaPreco();
        var granel = Produto("AMENDOIM GRANEL", 5.00m, new TabelaPreco(PrecoAtacado: 1.00m, QtdMinimaAtacado: 100m), unidade: "KG");
        var item = venda.AdicionarItem(Lido(granel), 0.003m, "1", Agora);
        Assert.Equal(0.02m, item.ValorBruto);
        var total = venda.Total;

        var ex = Assert.Throws<RegraNegocioException>(() => venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, true));
        Assert.Contains("R$ 0,00", ex.Message, StringComparison.Ordinal);

        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        Assert.Equal(5.00m, item.PrecoUnitario);
        Assert.Equal(OrigemPreco.Varejo, item.OrigemPreco);
        Assert.Equal(0.02m, item.ValorBruto);
        Assert.Equal(total, venda.Total);
        Assert.Equal(5.00m, venda.AdicionarItem(Lido(granel), 1m, "1", Agora).PrecoUnitario);
    }

    [Fact]
    public void Liberacao_com_motivo_longo_demais_e_recusada_sem_mudar_nada()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Brahma()), 1m, "1", Agora);
        Assert.Throws<RegraNegocioException>(() =>
            venda.AlterarTipoPreco(TipoPrecoVenda.Atacado, false, Supervisor(new string('x', Venda.MotivoLiberacaoMaximo + 1))));
        Assert.Equal(TipoPrecoVenda.Varejo, venda.TipoPreco);
        Assert.Equal(3.49m, item.PrecoUnitario);
        Assert.Empty(venda.Liberacoes);
    }

    [Fact]
    public void Motor_no_atacado_poe_o_candidato_sem_limiar_e_vale_o_menor()
    {
        var parametros = new ParametrosPreco(Loja1, UsaPrecoVolume: true, TipoPrecoVenda.Atacado);
        var faixa = new FaixaPreco(6m, null, 3.09m);
        var r = MotorPreco.Resolver(Brahma(faixas: [faixa]), false, 6m, null, null, parametros);
        Assert.Equal(OrigemPreco.Quantidade, r.Origem);
        Assert.Equal(3.09m, r.Preco);
        Assert.Contains(r.Candidatos, c => c is { Origem: OrigemPreco.Atacado, Preco: 3.19m, Limiar: null });

        // O atacado do F8 vence sem o limiar e sem a quantidade de referência; o por quantidade (varejo, 12+) guarda o Q.
        var f8 = MotorPreco.Resolver(Brahma(), false, 3m, null, null, parametros);
        Assert.Equal((OrigemPreco.Atacado, 3.19m), (f8.Origem, f8.Preco));
        Assert.Null(f8.Limiar);
        Assert.Null(f8.QuantidadeReferencia);
        var porQuantidade = MotorPreco.Resolver(Brahma(), false, 12m, null, null, parametros with { TipoPreco = TipoPrecoVenda.Varejo });
        Assert.Equal((OrigemPreco.Atacado, 12m, 12m), (porQuantidade.Origem, porQuantidade.Limiar, porQuantidade.QuantidadeReferencia));

        var sem = MotorPreco.Resolver(Produto("SEM ATACADO", 5.00m), false, 1m, null, null, parametros);
        Assert.Equal(OrigemPreco.Varejo, sem.Origem);
        Assert.Single(sem.Candidatos);
    }
}
