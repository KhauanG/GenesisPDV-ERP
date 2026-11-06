using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.CatalogoTeste;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>Regra oficial de preço (PDV 11.3/11.3.1) e critérios de aceite de 11.5.</summary>
public class PrecosTests
{
    private static readonly ParametrosPreco SemVolume = new(Loja1, UsaPrecoVolume: false);
    private static readonly ParametrosPreco ComVolume = new(Loja1, UsaPrecoVolume: true);

    // ------------------------------------------------------------ MotorPreco (tabela de casos)

    public static TheoryData<string, TabelaPreco?, decimal, bool, decimal, string> Casos() => new()
    {
        // descrição, tabela, Q, usa volume, preço esperado, origem esperada
        { "sem tabela = varejo", null, 1m, false, 3.49m, OrigemPreco.Varejo },
        { "preço da loja substitui o do produto", new TabelaPreco(PrecoVendaLoja: 3.29m), 1m, false, 3.29m, OrigemPreco.Loja },
        { "preço da loja maior que o geral ainda vale (é o varejo da loja)", new TabelaPreco(PrecoVendaLoja: 3.99m), 1m, false, 3.99m, OrigemPreco.Loja },
        { "promocional menor", new TabelaPreco(PrecoPromocional: 2.99m), 1m, false, 2.99m, OrigemPreco.Promocional },
        { "promocional maior que o varejo não vale", new TabelaPreco(PrecoPromocional: 3.99m), 1m, false, 3.49m, OrigemPreco.Varejo },
        { "atacado abaixo da quantidade mínima", new TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m), 11m, false, 3.49m, OrigemPreco.Varejo },
        { "atacado na quantidade mínima", new TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m), 12m, false, 3.19m, OrigemPreco.Atacado },
        { "atacado sem quantidade mínima só pelo tipo de preço", new TabelaPreco(PrecoAtacado: 3.19m), 500m, false, 3.49m, OrigemPreco.Varejo },
        { "faixa sem Usa Produto Preço Volume é ignorada", new TabelaPreco(Faixas: [new FaixaPreco(12m, 9999m, 3.19m)]), 12m, false, 3.49m, OrigemPreco.Varejo },
        { "faixa 12–9999 com 11", new TabelaPreco(Faixas: [new FaixaPreco(12m, 9999m, 3.19m)]), 11m, true, 3.49m, OrigemPreco.Varejo },
        { "faixa 12–9999 com 12", new TabelaPreco(Faixas: [new FaixaPreco(12m, 9999m, 3.19m)]), 12m, true, 3.19m, OrigemPreco.Quantidade },
        { "faixa acima do final não vale", new TabelaPreco(Faixas: [new FaixaPreco(6m, 11m, 3.39m)]), 12m, true, 3.49m, OrigemPreco.Varejo },
        { "faixa final inclusivo", new TabelaPreco(Faixas: [new FaixaPreco(6m, 11m, 3.39m)]), 11m, true, 3.39m, OrigemPreco.Quantidade },
        { "duas faixas: vale a da quantidade", new TabelaPreco(Faixas: [new FaixaPreco(6m, 11m, 3.39m), new FaixaPreco(12m, null, 3.19m)]), 13m, true, 3.19m, OrigemPreco.Quantidade },
        { "faixas que se tocam no limite: a de maior início", new TabelaPreco(Faixas: [new FaixaPreco(6m, 12m, 3.39m), new FaixaPreco(12m, null, 3.29m)]), 12m, true, 3.29m, OrigemPreco.Quantidade },
        { "faixa da loja prevalece sobre a geral", new TabelaPreco(Faixas: [new FaixaPreco(12m, null, 3.19m), new FaixaPreco(12m, null, 3.09m, Loja1)]), 12m, true, 3.09m, OrigemPreco.Quantidade },
        { "faixa da loja prevalece mesmo mais cara", new TabelaPreco(Faixas: [new FaixaPreco(12m, null, 3.09m), new FaixaPreco(12m, null, 3.29m, Loja1)]), 12m, true, 3.29m, OrigemPreco.Quantidade },
        { "faixa de outra loja não vale", new TabelaPreco(Faixas: [new FaixaPreco(12m, null, 2.00m, Loja2)]), 12m, true, 3.49m, OrigemPreco.Varejo },
        { "menor entre atacado e faixa", new TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m, Faixas: [new FaixaPreco(12m, null, 3.09m)]), 12m, true, 3.09m, OrigemPreco.Quantidade },
        { "menor entre promocional e atacado", new TabelaPreco(PrecoPromocional: 3.09m, PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m), 12m, false, 3.09m, OrigemPreco.Promocional },
        { "empate promocional × atacado: promocional", new TabelaPreco(PrecoPromocional: 3.19m, PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m), 12m, false, 3.19m, OrigemPreco.Promocional },
        { "empate faixa × atacado: quantidade", new TabelaPreco(PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m, Faixas: [new FaixaPreco(12m, null, 3.19m)]), 12m, true, 3.19m, OrigemPreco.Quantidade },
        { "empate loja × atacado: atacado", new TabelaPreco(PrecoVendaLoja: 3.19m, PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m), 12m, false, 3.19m, OrigemPreco.Atacado },
        { "atacado maior que o varejo da loja: vale a loja", new TabelaPreco(PrecoVendaLoja: 2.99m, PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m), 12m, false, 2.99m, OrigemPreco.Loja },
    };

    [Theory]
    [MemberData(nameof(Casos))]
    public void Menor_candidato_vence(string caso, TabelaPreco? tabela, decimal q, bool usaVolume, decimal esperado, string origem)
    {
        var produto = Produto("CERV", 3.49m, tabela);
        var r = MotorPreco.Resolver(produto, promocaoVigente: true, q, null, null, usaVolume ? ComVolume : SemVolume);
        Assert.True(esperado == r.Preco, $"{caso}: {r.Preco} ≠ {esperado}");
        Assert.True(origem == r.Origem, $"{caso}: {r.Origem} ≠ {origem}");
        Assert.True(r.Preco <= produto.PrecoBase, $"{caso}: nunca mais que o varejo");
    }

    [Fact]
    public void Empate_embalagem_vence_todos()
    {
        var produto = Produto("CERV", 3.19m, new TabelaPreco(PrecoPromocional: 3.19m, PrecoAtacado: 3.19m, QtdMinimaAtacado: 12m));
        var r = MotorPreco.Resolver(produto, true, 12m, null, new EmbalagemPreco(Guid.NewGuid(), 12m, 38.28m), SemVolume);
        Assert.Equal(OrigemPreco.Embalagem, r.Origem);
        Assert.All(r.Candidatos, c => Assert.Equal(3.19m, c.Preco));
        Assert.Equal(4, r.Candidatos.Count);
    }

    [Fact]
    public void Promocao_fora_da_vigencia_nao_e_aplicada()
    {
        var ontem = Agora.AddDays(-1);
        var tabela = new TabelaPreco(PrecoPromocional: 2.99m, PromocaoInicio: Agora.AddDays(-10), PromocaoFim: ontem);
        Assert.False(tabela.PromocaoVigenteEm(Agora));
        Assert.True(tabela.PromocaoVigenteEm(ontem));
        Assert.False((tabela with { PromocaoInicio = Agora.AddHours(1), PromocaoFim = null }).PromocaoVigenteEm(Agora));
        Assert.True((tabela with { PromocaoInicio = null, PromocaoFim = null }).PromocaoVigenteEm(Agora));

        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Produto("CERV", 3.49m, tabela)), 1m, "1", Agora);
        Assert.Equal(3.49m, item.PrecoUnitario);
        Assert.Equal(OrigemPreco.Varejo, item.OrigemPreco);
    }

    [Fact]
    public void Produto_com_preco_da_loja_usa_o_da_loja()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Produto("COCA", 9.99m, new TabelaPreco(PrecoVendaLoja: 9.49m))), 2m, "1", Agora);
        Assert.Equal(9.49m, item.PrecoUnitario);
        Assert.Equal(18.98m, item.ValorBruto);
        Assert.Equal(OrigemPreco.Loja, item.OrigemPreco);
    }

    // ------------------------------------------------------------ atacado com recálculo de todas as linhas

    [Fact]
    public void A_12a_lata_passa_as_12_para_o_atacado_e_cancelar_uma_volta_ao_varejo()
    {
        var venda = VendaPreco();
        var brahma = Brahma();
        for (var i = 0; i < 11; i++)
        {
            venda.AdicionarItem(Lido(brahma), 1m, "7891149103102", Agora);
        }

        Assert.All(venda.ItensAtivos, i => Assert.Equal(3.49m, i.PrecoUnitario));
        Assert.Equal(38.39m, venda.Total);

        venda.AdicionarItem(Lido(brahma), 1m, "7891149103102", Agora);
        Assert.All(venda.ItensAtivos, i =>
        {
            Assert.Equal(3.19m, i.PrecoUnitario);
            Assert.Equal(3.19m, i.PrecoTabela);
            Assert.Equal(OrigemPreco.Atacado, i.OrigemPreco);
            Assert.Equal(12m, i.QuantidadeReferenciaPreco);
            Assert.Null(i.GrupoPrecoQuantidadeId);
            Assert.Equal("ATAC 12+", i.EtiquetaPreco);
        });
        Assert.Equal(38.28m, venda.Total);
        Assert.Equal(3.60m, venda.EconomiaAtacado);

        venda.CancelarItem(5, Operador, Agora, 0m);
        Assert.All(venda.ItensAtivos, i =>
        {
            Assert.Equal(3.49m, i.PrecoUnitario);
            Assert.Equal(OrigemPreco.Varejo, i.OrigemPreco);
            Assert.Null(i.QuantidadeReferenciaPreco);
        });
        Assert.Equal(38.39m, venda.Total);
        Assert.Equal(0m, venda.EconomiaAtacado);
    }

    [Fact]
    public void Doze_brahma_numa_linha_so_entram_em_oferta_e_alterar_para_11_volta()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Brahma()), 12m, "7891149103102", Agora);
        Assert.Equal(3.19m, item.PrecoUnitario);
        Assert.Equal(38.28m, item.ValorBruto);
        venda.AlterarQuantidade(item.Sequencia, 11m, 0m);
        Assert.Equal(3.49m, item.PrecoUnitario);
        Assert.Equal(38.39m, item.ValorBruto);
        venda.IncrementarUltimoItem(1, 0m);
        Assert.Equal(3.19m, item.PrecoUnitario);
    }

    [Fact]
    public void Diferenca_varejo_atacado_nao_e_desconto_nem_consome_limite()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Brahma()), 12m, "1", Agora);
        Assert.Equal(0m, item.ReducaoPrecoManual);
        Assert.Equal(0m, item.DescontoItem);
        Assert.Equal(0m, venda.DescontoItens);

        // Operador com limite 10% dá 10% sobre o valor já com atacado, sem senha (12.3: valor_tabela = preço aplicado).
        var r = venda.AplicarDescontoItem(item.Sequencia, Desconto.EmPercentual(10m), limiteOperadorPct: 10m);
        Assert.True(r.Aplicado);
        Assert.Equal(3.83m, item.DescontoItem);
    }

    // ------------------------------------------------------------ faixas por loja

    [Theory]
    [InlineData(true, 3.09)]
    [InlineData(false, 3.19)]
    public void Faixa_da_loja_2_prevalece_no_pdv_da_loja_2(bool pdvDaLoja2, decimal esperado)
    {
        var faixas = new List<FaixaPreco> { new(12m, null, 3.19m), new(12m, null, 3.09m, Loja2) };
        var venda = VendaPreco(usaPrecoVolume: true, loja: pdvDaLoja2 ? Loja2 : Loja1);
        var item = venda.AdicionarItem(Lido(Produto("CERV", 3.49m, new TabelaPreco(Faixas: faixas))), 12m, "1", Agora);
        Assert.Equal(esperado, item.PrecoUnitario);
        Assert.Equal(OrigemPreco.Quantidade, item.OrigemPreco);
    }

    [Fact]
    public void Faixas_progressivas_reprecificam_ao_cruzar_cada_limite()
    {
        var faixas = new List<FaixaPreco> { new(6m, 11m, 3.39m), new(12m, null, 3.19m) };
        var produto = Produto("CERV", 3.49m, new TabelaPreco(Faixas: faixas));
        var venda = VendaPreco(usaPrecoVolume: true);
        var item = venda.AdicionarItem(Lido(produto), 5m, "1", Agora);
        Assert.Equal(3.49m, item.PrecoUnitario);
        venda.AdicionarItem(Lido(produto), 1m, "1", Agora);
        Assert.All(venda.ItensAtivos, i => Assert.Equal(3.39m, i.PrecoUnitario));
        venda.AdicionarItem(Lido(produto), 6m, "1", Agora);
        Assert.All(venda.ItensAtivos, i => Assert.Equal(3.19m, i.PrecoUnitario));
        Assert.Equal(38.28m, venda.Total);
    }

    // ------------------------------------------------------------ mix (grupo de preço por quantidade)

    [Fact]
    public void Seis_brahma_e_seis_skol_no_mix_modo_produto_aplicam_o_atacado_de_cada_uma()
    {
        var mix = Mix(ModoPrecoGrupo.Produto);
        var venda = VendaPreco();
        var brahma = venda.AdicionarItem(Lido(Brahma(mix)), 6m, "7891149103102", Agora);
        var skol = venda.AdicionarItem(Lido(Skol(mix)), 5m, "7891991010856", Agora);
        Assert.Equal(3.49m, brahma.PrecoUnitario);
        Assert.Equal(2.99m, skol.PrecoUnitario);

        venda.IncrementarUltimoItem(1, 0m);
        Assert.Equal(3.19m, brahma.PrecoUnitario);
        Assert.Equal(2.79m, skol.PrecoUnitario);
        Assert.All(venda.ItensAtivos, i =>
        {
            Assert.Equal(OrigemPreco.Atacado, i.OrigemPreco);
            Assert.Equal(MixId, i.GrupoPrecoQuantidadeId);
            Assert.Equal(12m, i.QuantidadeReferenciaPreco);
        });
        Assert.Equal(19.14m + 16.74m, venda.Total);

        venda.IncrementarUltimoItem(-1, 0m);
        Assert.Equal(3.49m, brahma.PrecoUnitario);
        Assert.Equal(2.99m, skol.PrecoUnitario);
        Assert.Null(brahma.GrupoPrecoQuantidadeId);
    }

    [Fact]
    public void Mix_modo_grupo_5_brahma_4_skol_3_antarctica_ganham_o_preco_de_oferta_e_cancelar_uma_volta_ao_varejo()
    {
        var mix = Mix(ModoPrecoGrupo.Grupo, precoFaixa12: 2.99m);
        var venda = VendaPreco(usaPrecoVolume: true);
        venda.AdicionarItem(Lido(Brahma(mix)), 5m, "1", Agora);
        venda.AdicionarItem(Lido(Skol(mix)), 4m, "2", Agora);
        Assert.Equal([3.49m, 2.99m], venda.ItensAtivos.Select(i => i.PrecoUnitario));
        var antarctica = venda.AdicionarItem(Lido(Antarctica(mix)), 3m, "3", Agora);
        Assert.All(venda.ItensAtivos, i =>
        {
            Assert.Equal(2.99m, i.PrecoUnitario);
            Assert.Equal(OrigemPreco.GrupoMix, i.OrigemPreco);
            Assert.Equal(MixId, i.GrupoPrecoQuantidadeId);
            Assert.Equal(12m, i.QuantidadeReferenciaPreco);
            Assert.Equal("MIX 12+", i.EtiquetaPreco);
            Assert.Equal("MIX LATAS 350ML", i.NomeGrupoPreco);
        });
        Assert.Equal(35.88m, venda.Total);

        venda.CancelarItem(antarctica.Sequencia, Operador, Agora, 0m, quantidade: 1m);
        Assert.Equal([3.49m, 2.99m, 3.29m], venda.ItensAtivos.Select(i => i.PrecoUnitario));
    }

    [Theory]
    [InlineData(2.99, 2.99, OrigemPreco.GrupoMix)]
    [InlineData(3.29, 3.19, OrigemPreco.Atacado)]
    public void Mix_e_atacado_proprio_juntos_vale_o_menor(decimal precoMix, decimal esperado, string origem)
    {
        var venda = VendaPreco(usaPrecoVolume: true);
        var item = venda.AdicionarItem(Lido(Brahma(Mix(ModoPrecoGrupo.Grupo, precoMix))), 12m, "1", Agora);
        Assert.Equal(esperado, item.PrecoUnitario);
        Assert.Equal(origem, item.OrigemPreco);
    }

    [Fact]
    public void Grupo_inativo_cada_produto_conta_so_a_propria_quantidade()
    {
        var mix = Mix(ModoPrecoGrupo.Produto, ativo: false);
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(Brahma(mix)), 6m, "1", Agora);
        venda.AdicionarItem(Lido(Skol(mix)), 6m, "2", Agora);
        Assert.Equal([3.49m, 2.99m], venda.ItensAtivos.Select(i => i.PrecoUnitario));
    }

    [Fact]
    public void Faixas_do_grupo_so_com_usa_preco_volume()
    {
        var mix = Mix(ModoPrecoGrupo.Grupo, 2.99m);
        var venda = VendaPreco(usaPrecoVolume: false);
        venda.AdicionarItem(Lido(Produto("A", 3.49m, new TabelaPreco(Grupo: mix))), 6m, "1", Agora);
        venda.AdicionarItem(Lido(Produto("B", 3.49m, new TabelaPreco(Grupo: mix))), 6m, "2", Agora);
        Assert.All(venda.ItensAtivos, i => Assert.Equal(3.49m, i.PrecoUnitario));
    }

    // ------------------------------------------------------------ embalagem / fardo

    [Fact]
    public void Fardo_de_12_baixa_12_un_e_cobra_o_preco_do_fardo_quando_menor()
    {
        var fardoId = Guid.NewGuid();
        var brahma = Brahma(embalagens: [new EmbalagemPreco(fardoId, 12m, 37.90m, "FD")]);
        var venda = VendaPreco();
        var fardo = venda.AdicionarItem(Fardo(brahma, fardoId, 12m, 37.90m), 1m, "17891149103109", Agora);
        Assert.Equal(12m, fardo.Quantidade);
        Assert.Equal("UN", fardo.Unidade);
        Assert.Equal(37.90m, fardo.ValorBruto);
        Assert.Equal(3.1583m, fardo.PrecoUnitario);
        Assert.Equal(OrigemPreco.Embalagem, fardo.OrigemPreco);
        Assert.Equal(fardoId, fardo.CodigoBarrasId);

        // O fardo sozinho ativa o "12+": a lata avulsa entra no atacado, o fardo fica com o preço dele (menor).
        var avulsa = venda.AdicionarItem(Lido(brahma), 1m, "7891149103102", Agora);
        Assert.Equal(3.19m, avulsa.PrecoUnitario);
        Assert.Equal(OrigemPreco.Atacado, avulsa.OrigemPreco);
        Assert.Equal(13m, avulsa.QuantidadeReferenciaPreco);
        Assert.Equal(37.90m, fardo.ValorBruto);
        Assert.Equal(41.09m, venda.Total);

        // Três fardos: valor = arred2(preço × multiplicador), autoritativo.
        venda.AlterarQuantidade(fardo.Sequencia, 36m, 0m);
        Assert.Equal(113.70m, fardo.ValorBruto);
    }

    [Fact]
    public void Fardo_com_preco_maior_que_o_atacado_cai_para_o_atacado()
    {
        var fardoId = Guid.NewGuid();
        var venda = VendaPreco();
        var fardo = venda.AdicionarItem(Fardo(Brahma(), fardoId, 12m, 39.00m), 1m, "17891149103109", Agora);
        Assert.Equal(3.19m, fardo.PrecoUnitario);
        Assert.Equal(38.28m, fardo.ValorBruto);
        Assert.Equal(OrigemPreco.Atacado, fardo.OrigemPreco);
    }

    [Fact]
    public void Fardo_sem_preco_usa_a_regra_com_a_quantidade_total()
    {
        var venda = VendaPreco();
        var fardo = venda.AdicionarItem(Fardo(Brahma(), Guid.NewGuid(), 12m, null), 3m, "17891149103109", Agora);
        Assert.Equal(36m, fardo.Quantidade);
        Assert.Equal(3.19m, fardo.PrecoUnitario);
        Assert.Equal(114.84m, fardo.ValorBruto);
    }

    [Fact]
    public void Fardo_altera_e_cancela_em_multiplos_do_fator_e_mais_soma_um_fardo()
    {
        var venda = VendaPreco();
        var fardo = venda.AdicionarItem(Fardo(Brahma(), Guid.NewGuid(), 12m, 37.90m), 2m, "17891149103109", Agora);
        Assert.Contains("múltiplos de 12", Assert.Throws<RegraNegocioException>(() => venda.AlterarQuantidade(fardo.Sequencia, 13m, 0m)).Message);
        Assert.Contains("múltiplos de 12", Assert.Throws<RegraNegocioException>(() => venda.CancelarItem(fardo.Sequencia, Operador, Agora, 0m, 5m)).Message);
        venda.IncrementarUltimoItem(1, 0m);
        Assert.Equal(36m, fardo.Quantidade);
        Assert.Equal(113.70m, fardo.ValorBruto);
        var restante = venda.CancelarItem(fardo.Sequencia, Operador, Agora, 0m, 12m)!;
        Assert.Equal(24m, restante.Quantidade);
        Assert.Equal(75.80m, restante.ValorBruto);
    }

    // ------------------------------------------------------------ linhas que não contam

    [Fact]
    public void Linhas_de_combo_nao_ativam_o_atacado_das_latas_avulsas()
    {
        var brahma = Brahma();
        var combo = new ComboResolvido(
            Produto("KIT CHURRASCO", 49.90m, tipo: TipoProduto.Kit),
            [new PosicaoCombo(Guid.NewGuid(), "Latas", 6m, 1, [new OpcaoCombo(null, brahma)])]);
        var venda = VendaPreco();
        venda.AdicionarCombo(combo, [0], 1m, "0510", Agora);
        var avulsa = venda.AdicionarItem(Lido(brahma), 6m, "1", Agora);
        Assert.Equal(3.49m, avulsa.PrecoUnitario);
        Assert.Equal(OrigemPreco.KitRateio, venda.Itens[0].OrigemPreco);
        Assert.Equal(49.90m, venda.Itens[0].ValorBruto);
    }

    // ------------------------------------------------------------ descontos e rateio

    [Fact]
    public void Desconto_do_item_em_reais_e_mantido_e_limitado_quando_o_preco_cai()
    {
        var venda = VendaPreco();
        var brahma = Brahma();
        var item = venda.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        Assert.True(venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(3.40m), 100m).Aplicado);
        venda.AdicionarItem(Lido(brahma), 11m, "1", Agora);
        Assert.Equal(3.19m, item.PrecoUnitario);
        Assert.Equal(3.18m, item.DescontoItem);
        Assert.Contains(venda.ConsumirAvisos(), a => a.Contains("ajustado"));
    }

    [Fact]
    public void Desconto_do_item_em_percentual_e_reaplicado_quando_o_preco_muda()
    {
        var venda = VendaPreco();
        var brahma = Brahma();
        var item = venda.AdicionarItem(Lido(brahma), 6m, "1", Agora);
        venda.AplicarDescontoItem(item.Sequencia, Desconto.EmPercentual(10m), 10m);
        Assert.Equal(2.09m, item.DescontoItem);
        venda.AdicionarItem(Lido(brahma), 6m, "1", Agora);
        Assert.Equal(19.14m, item.ValorBruto);
        Assert.Equal(1.91m, item.DescontoItem);
    }

    [Fact]
    public void Desconto_no_total_em_percentual_e_recalculado_e_em_reais_fica_fixo_com_rateio_sobre_o_atacado()
    {
        var brahma = Brahma();
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(brahma), 11m, "1", Agora);
        venda.AplicarDescontoTotal(Desconto.EmPercentual(10m), 100m);
        Assert.Equal(3.84m, venda.DescontoTotal);
        venda.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        Assert.Equal(3.83m, venda.DescontoTotal);
        Assert.Equal(venda.DescontoTotal, venda.ItensAtivos.Sum(i => i.DescontoRateado));
        Assert.Equal(34.45m, venda.Total);

        var emReais = VendaPreco();
        emReais.AdicionarItem(Lido(brahma), 11m, "1", Agora);
        emReais.AplicarDescontoTotal(Desconto.EmReais(5m), 100m);
        emReais.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        Assert.Equal(5m, emReais.DescontoTotal);
        Assert.Equal(33.28m, emReais.Total);
    }

    [Fact]
    public void Com_pagamento_lancado_a_12a_lata_que_reduziria_o_total_e_recusada_sem_mudar_nada()
    {
        var brahma = Brahma();
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(brahma), 11m, "1", Agora);
        venda.IniciarPagamento();
        venda.LancarPagamento(Pix, 10m, Agora, pix: PixConfirmado);
        venda.VoltarParaItens();
        var erro = Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Lido(brahma), 1m, "1", Agora));
        Assert.Contains("pagamentos lançados", erro.Message);
        Assert.Single(venda.Itens);
        Assert.Equal(3.49m, venda.Itens[0].PrecoUnitario);
        Assert.Equal(38.39m, venda.Total);
    }

    [Fact]
    public void Dica_de_proxima_faixa_ate_metade_do_limiar()
    {
        var venda = VendaPreco();
        var item = venda.AdicionarItem(Lido(Brahma()), 5m, "1", Agora);
        Assert.Null(venda.DicaPreco(item));
        venda.AlterarQuantidade(item.Sequencia, 9m, 0m);
        var dica = venda.DicaPreco(item)!;
        Assert.Equal(3m, dica.Faltam);
        Assert.Equal(3.19m, dica.Preco);
        venda.AlterarQuantidade(item.Sequencia, 12m, 0m);
        Assert.Null(venda.DicaPreco(item));
    }

    [Fact]
    public void Venda_recuperada_registra_os_produtos_sem_mudar_valores_e_volta_a_recalcular()
    {
        var brahma = Brahma();
        var original = VendaPreco();
        for (var i = 0; i < 12; i++)
        {
            original.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        }

        var estado = new EstadoVenda(original.Id, 1, original.NumeroExibicao, original.LojaId, original.CaixaId, 2, null, null, "balcao",
            original.Status, original.StatusFiscal, Operador, "varejo", 0m, null, 0m, Agora);
        var copias = original.Itens.Select(i => new ItemVenda(
            i.Id, i.Sequencia, i.ProdutoId, i.CodigoLido, i.CodigoBarrasId, i.Descricao, i.Unidade, false, i.Quantidade, i.PrecoTabela,
            i.PrecoUnitario, i.OrigemPreco, i.ValorBruto, 0m, i.IncluidoEm, grupoPrecoQuantidadeId: i.GrupoPrecoQuantidadeId,
            quantidadeReferenciaPreco: i.QuantidadeReferenciaPreco)).ToList();
        var recuperada = Venda.Restaurar(estado, copias, []);
        recuperada.RegistrarProdutos(original.Snapshots.Select(s => s.Value), null, Agora);
        Assert.Equal("ATAC 12+", recuperada.Itens[0].EtiquetaPreco);
        Assert.Equal(38.28m, recuperada.Total);
        recuperada.CancelarItem(1, Operador, Agora, 0m);
        Assert.All(recuperada.ItensAtivos, i => Assert.Equal(3.49m, i.PrecoUnitario));
    }

    /// <summary>Reconstitui a venda como o repositório (só as colunas gravadas; nada do que é só memória).</summary>
    private static Venda Reler(Venda original)
    {
        var estado = new EstadoVenda(original.Id, 1, original.NumeroExibicao, original.LojaId, original.CaixaId, 2, null, null, "balcao",
            original.Status, original.StatusFiscal, Operador, "varejo", original.DescontoTotal, original.DescontoTotalPct, 0m, Agora,
            DescontoTotalOrigem: original.DescontoTotalOrigem);
        var copias = original.Itens.Select(i => new ItemVenda(
            i.Id, i.Sequencia, i.ProdutoId, i.CodigoLido, i.CodigoBarrasId, i.Descricao, i.Unidade, i.Fracionavel, i.Quantidade, i.PrecoTabela,
            i.PrecoUnitario, i.OrigemPreco, i.ValorBruto, i.DescontoItem, i.IncluidoEm, grupoPrecoQuantidadeId: i.GrupoPrecoQuantidadeId,
            quantidadeReferenciaPreco: i.QuantidadeReferenciaPreco, cancelado: i.Cancelado)).ToList();
        return Venda.Restaurar(estado, copias, []);
    }

    /// <summary>5 Brahma no atacado (3,19) + fardo de 12 a 36,00 = 51,95; depois o pull sobe o preço e apaga o DUN.</summary>
    private static (Venda Original, ProdutoVenda Novo) VendaComPullNoMeio()
    {
        var dun = Guid.CreateVersion7();
        var brahma = Brahma(embalagens: [new EmbalagemPreco(dun, 12m, 36.00m, "FD")]);
        var original = VendaPreco();
        original.AdicionarItem(Lido(brahma), 5m, "0123", Agora);
        original.AdicionarItem(Fardo(brahma, dun, 12m, 36.00m), 1m, "DUN", Agora);
        Assert.Equal(51.95m, original.Total);
        var novo = brahma with { PrecoVenda = 3.99m, Precos = new TabelaPreco(PrecoAtacado: 3.59m, QtdMinimaAtacado: 12m) };
        return (original, novo);
    }

    [Fact]
    public void Recuperada_usa_o_snapshot_da_primeira_inclusao_e_um_pull_no_meio_nao_sobe_o_preco()
    {
        var (original, _) = VendaComPullNoMeio();
        var recuperada = Reler(original);
        recuperada.RegistrarProdutos(original.Snapshots.Select(s => s.Value), null, Agora);
        Assert.Equal(12m, recuperada.Itens[1].Embalagem!.Fator);
        Assert.Equal(3.49m, recuperada.Itens[0].PrecoVarejo);
        Assert.Equal("ATAC 12+", recuperada.Itens[0].EtiquetaPreco);

        recuperada.AdicionarItem(Lido(Produto("BALA", 1.00m)), 1m, "9", Agora);
        Assert.Equal([15.95m, 36.00m, 1.00m], recuperada.Itens.Select(i => i.ValorBruto));
        Assert.Equal(52.95m, recuperada.Total);

        // A regra continua valendo com o snapshot: cancelar o fardo devolve as 5 latas ao varejo da primeira inclusão.
        recuperada.CancelarItem(2, Operador, Agora, 0m);
        Assert.Equal(3.49m, recuperada.Itens[0].PrecoUnitario);
    }

    [Fact]
    public void Recuperada_sem_snapshot_fixa_o_preco_gravado_e_nunca_usa_o_espelho_novo()
    {
        var (original, novo) = VendaComPullNoMeio();
        var recuperada = Reler(original);
        recuperada.RegistrarProdutos([], [novo], Agora);
        Assert.All(recuperada.Itens, i => Assert.True(i.PrecoFixado));
        Assert.Null(recuperada.Itens[0].PrecoVarejo);
        Assert.Equal("ATAC", recuperada.Itens[0].EtiquetaPreco);
        Assert.Equal(0m, recuperada.EconomiaAtacado);

        recuperada.AdicionarItem(Lido(Produto("BALA", 1.00m)), 1m, "9", Agora);
        Assert.Equal([15.95m, 36.00m, 1.00m], recuperada.Itens.Select(i => i.ValorBruto));
        Assert.Equal(52.95m, recuperada.Total);
    }

    [Fact]
    public void Fardo_cadastrado_no_meio_da_venda_entra_no_snapshot()
    {
        var brahma = Brahma();
        var venda = VendaPreco();
        venda.AdicionarItem(Lido(brahma), 1m, "0123", Agora);
        var dun = Guid.CreateVersion7();
        venda.AdicionarItem(Fardo(brahma, dun, 12m, 36.00m), 1m, "DUN", Agora);
        var snapshot = Assert.Single(venda.Snapshots).Value.Produto;
        Assert.Contains(snapshot.Precos!.Embalagens!, e => e.CodigoBarrasId == dun && e.Preco == 36.00m);
        Assert.Equal(3.49m, snapshot.PrecoBase);
    }

    [Fact]
    public void Desconto_em_reais_nao_passa_do_limite_quando_a_12a_lata_derruba_o_preco()
    {
        var venda = VendaPreco();
        var brahma = Brahma();
        var item = venda.AdicionarItem(Lido(brahma), 11m, "1", Agora);
        Assert.Equal(38.39m, item.ValorBruto);
        Assert.True(venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(3.83m), 10m).Aplicado);

        venda.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        Assert.Equal(35.09m, item.ValorBruto);
        Assert.Equal(3.50m, item.DescontoItem);
        Assert.True(item.DescontoItem / item.ValorTabela * 100m <= 10m);
        Assert.Contains(venda.ConsumirAvisos(), a => a.Contains("ajustado para R$ 3,50"));

        // Voltar ao varejo não devolve o desconto cortado (o operador pode dar de novo, dentro do limite).
        venda.CancelarItem(2, Operador, Agora, 10m);
        Assert.Equal(3.50m, item.DescontoItem);
    }

    [Fact]
    public void Desconto_em_reais_liberado_por_supervisor_mantem_o_percentual_liberado()
    {
        var venda = VendaPreco();
        var brahma = Brahma();
        var item = venda.AdicionarItem(Lido(brahma), 11m, "1", Agora);
        var r = venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(5.76m), 10m, new Liberacao(Supervisor, 20m, "Cliente fidelidade", Agora));
        Assert.True(r.Aplicado);
        venda.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        Assert.Equal(5.26m, item.DescontoItem); // 15,00% de 35,09 truncado
    }

    [Fact]
    public void Desconto_no_total_em_reais_nao_passa_do_limite_quando_o_preco_cai()
    {
        var venda = VendaPreco();
        var brahma = Brahma();
        venda.AdicionarItem(Lido(brahma), 11m, "1", Agora);
        Assert.True(venda.AplicarDescontoTotal(Desconto.EmReais(3.83m), 10m).Aplicado);
        venda.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        Assert.Equal(38.28m, venda.ItensAtivos.Sum(i => i.ValorBruto));
        Assert.Equal(3.82m, venda.DescontoTotal);
        Assert.Contains(venda.ConsumirAvisos(), a => a.Contains("Desconto no total ajustado"));
    }

    [Fact]
    public void Recuperada_usa_o_limite_do_operador_como_teto_do_desconto_gravado()
    {
        var venda = VendaPreco();
        var brahma = Brahma();
        var item = venda.AdicionarItem(Lido(brahma), 11m, "1", Agora);
        venda.AplicarDescontoItem(item.Sequencia, Desconto.EmReais(3.83m), 10m);
        var recuperada = Reler(venda);
        recuperada.RegistrarProdutos(venda.Snapshots.Select(s => s.Value), null, Agora, limiteOperadorPct: 10m);
        recuperada.AdicionarItem(Lido(brahma), 1m, "1", Agora);
        Assert.Equal(3.50m, recuperada.Itens[0].DescontoItem);
    }

    // ------------------------------------------------------------ propriedade: 10.000 vendas aleatórias

    /// <summary>
    /// Para qualquer sequência de inclusões, alterações e cancelamentos, o preço de toda linha é exatamente o menor
    /// candidato da regra 11.3 calculado do zero com as quantidades finais (a ordem das operações não importa), nunca
    /// passa do varejo, Σ valor_bruto = subtotal e o rateio do desconto no total fecha.
    /// </summary>
    [Fact]
    public void Propriedade_10000_vendas_com_atacado_faixas_mix_e_fardo()
    {
        var aleatorio = new Random(20261030);
        for (var n = 0; n < 10_000; n++)
        {
            var usaVolume = aleatorio.Next(2) == 0;
            var mix = aleatorio.Next(3) switch
            {
                0 => null,
                1 => Mix(ModoPrecoGrupo.Produto),
                _ => Mix(ModoPrecoGrupo.Grupo, Centavos(aleatorio, 150, 400)),
            };
            var produtos = Enumerable.Range(0, aleatorio.Next(1, 5)).Select(_ => ProdutoAleatorio(aleatorio, mix)).ToList();
            var venda = VendaPreco(usaVolume);
            for (var op = 0; op < aleatorio.Next(1, 25); op++)
            {
                try
                {
                    var ativos = venda.ItensAtivos.ToList();
                    switch (aleatorio.Next(6))
                    {
                        case 0 when ativos.Count > 0:
                            venda.CancelarItem(ativos[aleatorio.Next(ativos.Count)].Sequencia, Operador, Agora, 100m);
                            break;
                        case 1 when ativos.Count > 0:
                            var alvo = ativos[aleatorio.Next(ativos.Count)];
                            venda.AlterarQuantidade(alvo.Sequencia, (alvo.Embalagem?.Fator ?? 1m) * aleatorio.Next(1, 8), 100m);
                            break;
                        default:
                            var p = produtos[aleatorio.Next(produtos.Count)];
                            var embalagem = p.Precos!.Embalagens![0];
                            var resolvido = aleatorio.Next(4) == 0 ? new ProdutoResolvido(p, embalagem.CodigoBarrasId, embalagem.Fator, embalagem.Preco) : Lido(p);
                            venda.AdicionarItem(resolvido, aleatorio.Next(1, 9), "x", Agora, agrupar: aleatorio.Next(2) == 0);
                            break;
                    }
                }
                catch (RegraNegocioException)
                {
                    // Operação recusada (quantidade máxima etc.): a venda continua consistente.
                }
            }

            ConferirComCalculoDoZero(venda, produtos, usaVolume, n);

            if (venda.ItensAtivos.Any())
            {
                var maximo = Rateio.DescontoMaximo(venda.ItensAtivos.Select(i => new BaseRateio(i.Sequencia, i.BaseRateio)).ToList());
                if (maximo > 0m)
                {
                    venda.AplicarDescontoTotal(Desconto.EmReais(Math.Max(0.01m, decimal.Round(maximo * (decimal)aleatorio.NextDouble(), 2))), 100m);
                    Assert.Equal(venda.DescontoTotal, venda.ItensAtivos.Sum(i => i.DescontoRateado));
                    Assert.All(venda.ItensAtivos, i => Assert.True(i.ValorLiquido >= 0.01m, $"líquido <= 0 na venda {n}"));
                    Assert.Equal(venda.Total, venda.ItensAtivos.Sum(i => i.ValorLiquido));
                }
            }
        }
    }

    private static void ConferirComCalculoDoZero(Venda venda, List<ProdutoVenda> produtos, bool usaVolume, int n)
    {
        var ativos = venda.ItensAtivos.ToList();
        var porProduto = ativos.GroupBy(i => i.ProdutoId).ToDictionary(g => g.Key, g => g.Sum(i => i.Quantidade));
        var porGrupo = ativos.Where(i => produtos.First(p => p.Id == i.ProdutoId).Precos!.GrupoAtivo is not null).Sum(i => i.Quantidade);
        foreach (var item in ativos)
        {
            var p = produtos.First(x => x.Id == item.ProdutoId);
            var t = p.Precos!;
            var grupo = t.GrupoAtivo;
            var q = grupo is { Modo: ModoPrecoGrupo.Produto } ? porGrupo : porProduto[item.ProdutoId];
            var candidatos = new List<decimal> { p.PrecoBase };
            if (t.PrecoAtacado is { } at && q >= t.QtdMinimaAtacado)
            {
                candidatos.Add(at);
            }

            if (usaVolume && t.Faixas!.Where(f => f.Contem(q)).MaxBy(f => f.QuantidadeInicial) is { } f)
            {
                candidatos.Add(f.Preco);
            }

            if (usaVolume && grupo is { Modo: ModoPrecoGrupo.Grupo } && grupo.Faixas!.FirstOrDefault(fx => fx.Contem(porGrupo)) is { } fg)
            {
                candidatos.Add(fg.Preco);
            }

            if (item.Embalagem is { Preco: { } pe } e)
            {
                candidatos.Add(pe / e.Fator);
            }

            var menor = candidatos.Min();
            var embalagemVence = item.Embalagem is { Preco: { } pv } ev && pv / ev.Fator == menor;
            Assert.True(embalagemVence == (item.OrigemPreco == OrigemPreco.Embalagem), $"venda {n}: origem {item.OrigemPreco}");
            var esperadoBruto = embalagemVence
                ? Numeros.Arredondamento.Arred2(item.Embalagem!.Preco!.Value * (item.Quantidade / item.Embalagem.Fator))
                : Numeros.Arredondamento.Arred2(item.Quantidade * menor);
            Assert.True(esperadoBruto == item.ValorBruto, $"venda {n}, item {item.Sequencia}: bruto {item.ValorBruto} ≠ {esperadoBruto} ({item.OrigemPreco})");
            Assert.True(item.PrecoUnitario <= p.PrecoBase, $"venda {n}: preço acima do varejo");
            Assert.True(Numeros.Arredondamento.CabeEm(item.PrecoUnitario, 4), $"venda {n}: preço com mais de 4 casas");
        }

        Assert.Equal(venda.SubtotalBruto, ativos.Sum(i => i.ValorBruto));
    }

    private static ProdutoVenda ProdutoAleatorio(Random r, GrupoPrecoQuantidade? mix)
    {
        var varejo = Centavos(r, 100, 1500);
        var faixas = new List<FaixaPreco>();
        if (r.Next(2) == 0)
        {
            faixas.Add(new FaixaPreco(6m, 11m, varejo - Centavos(r, 1, 50)));
            faixas.Add(new FaixaPreco(12m, null, varejo - Centavos(r, 1, 90)));
        }

        var fator = r.Next(2) == 0 ? 6m : 12m;
        var tabela = new TabelaPreco(
            PrecoAtacado: r.Next(3) == 0 ? null : varejo - Centavos(r, 1, 80),
            QtdMinimaAtacado: r.Next(2) == 0 ? 12m : 6m,
            Faixas: faixas,
            Grupo: r.Next(2) == 0 ? mix : null,
            Embalagens: [new EmbalagemPreco(Guid.NewGuid(), fator, r.Next(2) == 0 ? null : Centavos(r, 100, (int)(varejo * fator * 100m)), "FD")]);
        return Produto($"P{r.Next(1000)}", varejo, tabela);
    }

    private static decimal Centavos(Random r, int minimo, int maximo) => r.Next(minimo, Math.Max(minimo + 1, maximo)) / 100m;
}
