using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Produtos;
using GenesisPDV.Core.Vendas;
using static GenesisPDV.Core.Tests.CatalogoTeste;
using static GenesisPDV.Core.Tests.Fixtures;

namespace GenesisPDV.Core.Tests;

/// <summary>Combo/kit com troca de componente (PDV 10.9.1; decisões do dono de 30/10/2026).</summary>
public class ComboTests
{
    private static readonly int[] Padroes = [0, 0, 0];
    private static readonly int[] ComMonster = [0, 1, 0];

    [Fact]
    public void Combo_de_whisky_com_monster_no_lugar_do_red_bull_soma_o_acrescimo_e_baixa_o_monster()
    {
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(ComboWhisky(), ComMonster, 1m, "0500", Agora);

        Assert.Equal(3, linhas.Count);
        Assert.Equal([Whisky.Id, Monster.Id, GeloCoco.Id], linhas.Select(l => l.ProdutoId));
        Assert.DoesNotContain(linhas, l => l.ProdutoId == RedBull.Id);
        Assert.Equal([98.48m, 24.55m, 8.87m], linhas.Select(l => l.ValorBruto));
        Assert.Equal(131.90m, linhas.Sum(l => l.ValorBruto));
        Assert.Equal([98.48m, 24.55m, 4.435m], linhas.Select(l => l.PrecoUnitario));
        Assert.Equal([1m, 1m, 2m], linhas.Select(l => l.Quantidade));
        Assert.All(linhas, l =>
        {
            Assert.Equal(OrigemPreco.KitRateio, l.OrigemPreco);
            Assert.Equal(l.PrecoUnitario, l.PrecoTabela);
            Assert.Equal(131.90m, l.Kit!.PrecoUnitario);
            Assert.Equal(1m, l.Kit.Quantidade);
            Assert.Equal("COMBO DE WHISKY 1L", l.Kit.Descricao);
            Assert.Equal(linhas[0].Kit!.GrupoId, l.Kit.GrupoId);
        });

        var monster = linhas[1];
        Assert.Equal(AlternativaMonster, monster.Kit!.AlternativaId);
        Assert.Equal(2.0000m, monster.Kit.Acrescimo);
        Assert.Equal(PosicaoEnergetico, monster.Kit.ComponenteId);
        Assert.Null(linhas[0].Kit!.AlternativaId);
        Assert.Equal(131.90m, venda.Total);
    }

    [Fact]
    public void Enter_nos_padroes_inclui_o_combo_sem_acrescimo()
    {
        var combo = ComboWhisky();
        Assert.True(combo.ExigeEscolha);
        Assert.Equal(Padroes, combo.EscolhasPadrao);
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(combo, combo.EscolhasPadrao, 1m, "0500", Agora);
        Assert.Equal(129.90m, linhas.Sum(l => l.ValorBruto));
        Assert.All(linhas, l => Assert.Equal(0m, l.Kit!.Acrescimo));
        Assert.Equal(RedBull.Id, linhas[1].ProdutoId);
    }

    [Fact]
    public void Dois_combos_dobram_as_quantidades_e_o_valor()
    {
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(ComboWhisky(), ComMonster, 2m, "2*0500", Agora);
        Assert.Equal([2m, 2m, 4m], linhas.Select(l => l.Quantidade));
        Assert.Equal(263.80m, linhas.Sum(l => l.ValorBruto));
        Assert.All(linhas, l => Assert.Equal(2m, l.Kit!.Quantidade));
    }

    [Fact]
    public void Padrao_indisponivel_marca_a_primeira_alternativa_e_alternativa_indisponivel_e_recusada()
    {
        var combo = ComboWhisky(monsterDisponivel: false);
        Assert.Contains("indisponível", Assert.Throws<RegraNegocioException>(() =>
            VendaPreco().AdicionarCombo(combo, ComMonster, 1m, "0500", Agora)).Message);

        var semRedBull = combo with
        {
            Posicoes =
            [
                combo.Posicoes[0],
                combo.Posicoes[1] with { Opcoes = [new OpcaoCombo(null, RedBull, Disponivel: false), .. combo.Posicoes[1].Opcoes.Skip(1)] },
                combo.Posicoes[2],
            ],
        };
        Assert.Equal(2, semRedBull.Posicoes[1].IndiceInicial);
    }

    [Fact]
    public void Combo_sem_alternativas_nao_exige_escolha()
    {
        var combo = new ComboResolvido(
            Produto("KIT", 10m, tipo: TipoProduto.Kit),
            [new PosicaoCombo(Guid.NewGuid(), "A", 1m, 1, [new OpcaoCombo(null, Produto("A", 5m))])]);
        Assert.False(combo.ExigeEscolha);
    }

    [Fact]
    public void Cancelar_uma_linha_cancela_o_combo_inteiro_e_parcial_ou_quantidade_sao_recusados()
    {
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(ComboWhisky(), ComMonster, 1m, "0500", Agora);
        Assert.Contains("combo", Assert.Throws<RegraNegocioException>(() => venda.AlterarQuantidade(linhas[2].Sequencia, 1m, 0m)).Message);
        Assert.Contains("combo inteiro", Assert.Throws<RegraNegocioException>(() => venda.CancelarItem(linhas[2].Sequencia, Operador, Agora, 0m, 1m)).Message);
        Assert.Contains("combo", Assert.Throws<RegraNegocioException>(() => venda.IncrementarUltimoItem(1, 0m)).Message);

        venda.CancelarItem(linhas[1].Sequencia, Operador, Agora, 0m);
        Assert.All(linhas, l => Assert.True(l.Cancelado));
        Assert.Equal(0m, venda.Total);
    }

    [Fact]
    public void Desconto_de_item_numa_linha_do_combo_vale_para_o_combo_e_e_rateado_pelo_valor_bruto()
    {
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(ComboWhisky(), ComMonster, 1m, "0500", Agora);
        var r = venda.AplicarDescontoItem(linhas[2].Sequencia, Desconto.EmReais(10m), 100m);
        Assert.True(r.Aplicado);
        Assert.Equal(10m, linhas.Sum(l => l.DescontoItem));
        Assert.Equal([7.47m, 1.86m, 0.67m], linhas.Select(l => l.DescontoItem));
        Assert.Equal(121.90m, venda.Total);

        // Limite do operador medido sobre o valor do combo: 10% de 131,90 = 13,19.
        Assert.False(venda.AplicarDescontoItem(linhas[0].Sequencia, Desconto.EmReais(13.20m), 10m).Aplicado);
        Assert.True(venda.AplicarDescontoItem(linhas[0].Sequencia, Desconto.EmPercentual(10m), 10m).Aplicado);
        Assert.Equal(13.19m, linhas.Sum(l => l.DescontoItem));

        venda.RemoverDescontoItem(linhas[1].Sequencia);
        Assert.All(linhas, l => Assert.Equal(0m, l.DescontoItem));
    }

    [Fact]
    public void Desconto_no_combo_dentro_do_limite_nao_registra_a_liberacao_informada()
    {
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(ComboWhisky(), ComMonster, 1m, "0500", Agora);

        var dentro = venda.AplicarDescontoItem(linhas[0].Sequencia, Desconto.EmPercentual(10m), 10m, new Liberacao(Supervisor, 20m, "", Agora));
        Assert.True(dentro.Aplicado);
        Assert.Empty(venda.Liberacoes);
        Assert.All(linhas, l => Assert.Null(l.AutorizadoPorId));

        var acima = venda.AplicarDescontoItem(linhas[0].Sequencia, Desconto.EmPercentual(15m), 10m, new Liberacao(Supervisor, 20m, "Cliente fidelidade", Agora));
        Assert.True(acima.PorLiberacao);
        Assert.All(linhas, l => Assert.Equal(Supervisor, l.AutorizadoPorId));
        Assert.Equal((AcaoLiberacao.DescontoItem, (Guid?)linhas[0].Id), (Assert.Single(venda.Liberacoes).Acao, venda.Liberacoes[0].ItemVendaId));
    }

    [Fact]
    public void Combo_promocional_usa_o_menor_entre_varejo_e_promocao_e_ignora_atacado()
    {
        var combo = ComboWhisky(precosKit: new TabelaPreco(PrecoPromocional: 119.90m, PrecoAtacado: 99m, QtdMinimaAtacado: 1m));
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(combo, Padroes, 1m, "0500", Agora);
        Assert.Equal(119.90m, linhas[0].Kit!.PrecoUnitario);
        Assert.Equal(119.90m, linhas.Sum(l => l.ValorBruto));
    }

    [Fact]
    public void Combo_dentro_de_combo_e_produto_que_nao_e_kit_sao_recusados()
    {
        var venda = VendaPreco();
        var naoKit = new ComboResolvido(Produto("X", 10m), ComboWhisky().Posicoes);
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarCombo(naoKit, Padroes, 1m, "1", Agora));
        var aninhado = new ComboResolvido(
            Produto("KIT", 10m, tipo: TipoProduto.Kit),
            [new PosicaoCombo(Guid.NewGuid(), "A", 1m, 1, [new OpcaoCombo(null, Produto("K2", 5m, tipo: TipoProduto.Kit))])]);
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarCombo(aninhado, [0], 1m, "1", Agora));
        Assert.Contains("combo", Assert.Throws<RegraNegocioException>(() => venda.AdicionarItem(Lido(ComboWhisky().Kit), 1m, "1", Agora)).Message);
        Assert.Empty(venda.Itens);
    }

    [Fact]
    public void Componente_com_preco_zero_entra_no_combo_e_fica_com_o_minimo_de_um_centavo()
    {
        var geloBrinde = Produto("GELO BRINDE", 0m);
        var combo = new ComboResolvido(
            Produto("COMBO WHISKY + GELO BRINDE", 100.00m, tipo: TipoProduto.Kit),
            [
                new PosicaoCombo(PosicaoWhisky, "Whisky 1L", 1m, 1, [new OpcaoCombo(null, Whisky)]),
                new PosicaoCombo(PosicaoGelo, "Gelo", 2m, 2, [new OpcaoCombo(null, geloBrinde)]),
            ]);
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(combo, [0, 0], 1m, "0501", Agora);
        Assert.Equal([99.99m, 0.01m], linhas.Select(l => l.ValorBruto));
        Assert.Equal(100.00m, venda.Total);
        Assert.Equal(geloBrinde.Id, linhas[1].ProdutoId);
    }

    [Fact]
    public void Todos_os_componentes_com_preco_zero_rateiam_pela_quantidade()
    {
        var combo = new ComboResolvido(
            Produto("KIT BRINDES", 10.00m, tipo: TipoProduto.Kit),
            [
                new PosicaoCombo(Guid.CreateVersion7(), "Copo", 1m, 1, [new OpcaoCombo(null, Produto("COPO BRINDE", 0m))]),
                new PosicaoCombo(Guid.CreateVersion7(), "Gelo", 3m, 2, [new OpcaoCombo(null, Produto("GELO BRINDE", 0m))]),
            ]);
        var venda = VendaPreco();
        var linhas = venda.AdicionarCombo(combo, [0, 0], 1m, "0502", Agora);
        Assert.Equal([2.50m, 7.50m], linhas.Select(l => l.ValorBruto));
        Assert.Equal(10.00m, venda.Total);
    }

    [Fact]
    public void Kit_sem_preco_e_componente_com_preco_negativo_continuam_recusados()
    {
        var venda = VendaPreco();
        var kitZero = new ComboResolvido(Produto("KIT ZERO", 0m, tipo: TipoProduto.Kit), ComboWhisky().Posicoes);
        Assert.Contains("sem preço", Assert.Throws<RegraNegocioException>(() => venda.AdicionarCombo(kitZero, Padroes, 1m, "1", Agora)).Message);
        var negativo = new ComboResolvido(
            Produto("KIT", 10m, tipo: TipoProduto.Kit),
            [new PosicaoCombo(Guid.CreateVersion7(), "A", 1m, 1, [new OpcaoCombo(null, Produto("NEG", -1m))])]);
        Assert.Throws<RegraNegocioException>(() => venda.AdicionarCombo(negativo, [0], 1m, "1", Agora));
        Assert.Empty(venda.Itens);
    }

    [Fact]
    public void Componente_retornavel_ou_produzido_e_recusado_no_combo()
    {
        var venda = VendaPreco();
        var retornavel = new ComboResolvido(
            Produto("KIT 6 ORIGINAL 600 RET", 59.90m, tipo: TipoProduto.Kit),
            [new PosicaoCombo(Guid.CreateVersion7(), "Original 600", 6m, 1, [new OpcaoCombo(null, Original600())])]);
        Assert.Contains("retornável", Assert.Throws<RegraNegocioException>(() => venda.AdicionarCombo(retornavel, [0], 1m, "1", Agora)).Message);

        var produzido = new ComboResolvido(
            Produto("COMBO COPÃO + PORÇÃO", 39.90m, tipo: TipoProduto.Kit),
            [new PosicaoCombo(Guid.CreateVersion7(), "Copão", 1m, 1, [new OpcaoCombo(null, Produto("COPÃO GIN", 25m, tipo: TipoProduto.Produzido))])]);
        Assert.Contains("produzido", Assert.Throws<RegraNegocioException>(() => venda.AdicionarCombo(produzido, [0], 1m, "1", Agora)).Message);
        Assert.Empty(venda.Itens);
        Assert.Null(Venda.MotivoComponenteProibido(Whisky));
    }

    [Fact]
    public void Preco_do_kit_do_dialogo_e_o_da_inclusao_no_mesmo_instante()
    {
        var inicio = Agora.AddMinutes(10);
        var combo = ComboWhisky(precosKit: new TabelaPreco(PrecoPromocional: 119.90m, PromocaoInicio: inicio));
        Assert.Equal(129.90m, Venda.PrecoKit(combo.Kit, Agora));
        Assert.Equal(119.90m, Venda.PrecoKit(combo.Kit, inicio));
        var venda = VendaPreco();
        Assert.Equal(119.90m, venda.AdicionarCombo(combo, Padroes, 1m, "0500", inicio).Sum(l => l.ValorBruto));
    }

    // ------------------------------------------------------------ rateio do combo (base da NFC-e)

    public static TheoryData<decimal, decimal[], decimal[], decimal[]> CasosRateio() => new()
    {
        // valor, pesos, quantidades, esperado
        { 131.90m, [99.90m, 24.90m, 9.00m], [1m, 1m, 2m], [98.48m, 24.55m, 8.87m] },
        { 129.90m, [99.90m, 22.90m, 9.00m], [1m, 1m, 2m], [98.46m, 22.57m, 8.87m] },
        { 10.00m, [1m, 1m, 1m], [1m, 1m, 1m], [3.34m, 3.33m, 3.33m] },
        { 10.00m, [0m, 0m], [1m, 3m], [2.50m, 7.50m] },
        { 0.03m, [100m, 0.01m, 0.01m], [1m, 1m, 1m], [0.01m, 0.01m, 0.01m] },
        { 1.00m, [1m, 1m, 1m, 1m, 1m, 1m], [1m, 1m, 1m, 1m, 1m, 1m], [0.15m, 0.17m, 0.17m, 0.17m, 0.17m, 0.17m] },
        { 50.00m, [10m, 40m], [1m, 1m], [10.00m, 40.00m] },
    };

    [Theory]
    [MemberData(nameof(CasosRateio))]
    public void Rateio_proporcional_ao_preco_de_varejo_com_residuo_na_maior_linha(decimal valor, decimal[] pesos, decimal[] quantidades, decimal[] esperado)
    {
        var partes = RateioCombo.Distribuir(valor, pesos.Select((p, i) => new PesoComponente(p, quantidades[i])).ToList());
        Assert.Equal(esperado, partes);
        Assert.Equal(valor, partes.Sum());
    }

    [Fact]
    public void Rateio_recusa_valor_menor_que_um_centavo_por_linha()
    {
        Assert.Throws<RegraNegocioException>(() =>
            RateioCombo.Distribuir(0.02m, [new PesoComponente(1m, 1m), new PesoComponente(1m, 1m), new PesoComponente(1m, 1m)]));
    }

    [Fact]
    public void Propriedade_10000_combos_aleatorios_fecham_o_preco_do_combo()
    {
        var aleatorio = new Random(20261030);
        for (var n = 0; n < 10_000; n++)
        {
            var linhas = Enumerable.Range(0, aleatorio.Next(1, 8))
                .Select(_ => new PesoComponente(aleatorio.Next(5) == 0 ? 0m : aleatorio.Next(1, 50_000) / 100m, aleatorio.Next(1, 5)))
                .ToList();
            var valor = Math.Max(0.01m * linhas.Count, aleatorio.Next(1, 100_000) / 100m);
            var partes = RateioCombo.Distribuir(valor, linhas);
            Assert.Equal(valor, partes.Sum());
            Assert.All(partes, p => Assert.True(p >= 0.01m && decimal.Round(p, 2) == p, $"combo {n}: parte {p}"));
            Assert.Equal(partes, RateioCombo.Distribuir(valor, linhas));

            // Proporcional: nenhuma parte se afasta do ideal mais que o resíduo total (≤ meio centavo por linha) + o mínimo de 1 centavo.
            var pesos = linhas.Sum(l => l.Peso) > 0m ? linhas.Select(l => l.Peso).ToList() : linhas.Select(l => l.Quantidade).ToList();
            for (var i = 0; i < partes.Length; i++)
            {
                var ideal = valor * pesos[i] / pesos.Sum();
                Assert.True(Math.Abs(partes[i] - ideal) <= (0.005m * linhas.Count) + 0.01m * linhas.Count, $"combo {n}: {partes[i]} longe de {ideal}");
            }
        }
    }

    [Fact]
    public void Propriedade_combos_na_venda_sempre_somam_o_preco_do_combo_com_acrescimos()
    {
        var aleatorio = new Random(1030);
        for (var n = 0; n < 2_000; n++)
        {
            var combo = ComboWhisky(preco: aleatorio.Next(100, 50_000) / 100m);
            var escolhas = new[] { 0, aleatorio.Next(3), aleatorio.Next(2) };
            var qtd = aleatorio.Next(1, 4);
            var venda = VendaPreco();
            var linhas = venda.AdicionarCombo(combo, escolhas, qtd, "0500", Agora);
            var acrescimo = combo.Posicoes.Select((p, i) => p.Opcoes[escolhas[i]].Acrescimo).Sum();
            Assert.Equal(Numeros.Arredondamento.Arred2(qtd * (combo.Kit.PrecoVenda + acrescimo)), linhas.Sum(l => l.ValorBruto));
            Assert.Equal(venda.Total, linhas.Sum(l => l.ValorBruto));
            Assert.All(linhas, l => Assert.True(l.ValorBruto >= 0.01m));
        }
    }
}
