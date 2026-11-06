using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Tests;

public class RateioTests
{
    [Fact]
    public void Exemplo_da_especificacao_12_4()
    {
        var itens = new[] { new BaseRateio(1, 10.00m), new BaseRateio(2, 20.00m), new BaseRateio(3, 30.01m) };
        var partes = Rateio.Distribuir(itens, 5.00m, TipoRateio.Desconto);
        Assert.Equal(0.83m, partes[1]);
        Assert.Equal(1.67m, partes[2]);
        Assert.Equal(2.50m, partes[3]);
    }

    [Fact]
    public void Valor_zero_gera_partes_zero()
    {
        var partes = Rateio.Distribuir([new BaseRateio(1, 10m), new BaseRateio(2, 5m)], 0m, TipoRateio.Desconto);
        Assert.All(partes.Values, p => Assert.Equal(0m, p));
    }

    [Fact]
    public void Ancora_absorve_o_residuo_de_um_centavo()
    {
        // 3 itens iguais, R$ 0,10: cada não-âncora 0,03; âncora (menor sequência) fica com 0,04.
        var partes = Rateio.Distribuir([new BaseRateio(1, 1m), new BaseRateio(2, 1m), new BaseRateio(3, 1m)], 0.10m, TipoRateio.Desconto);
        Assert.Equal(0.04m, partes[1]);
        Assert.Equal(0.03m, partes[2]);
        Assert.Equal(0.03m, partes[3]);
        Assert.Equal(0.10m, partes.Values.Sum());
    }

    [Fact]
    public void Empate_de_base_escolhe_ancora_pela_menor_sequencia()
    {
        // Âncora = sequência 3; o outro item recebe arred2(0,005) = 0,01 e a âncora absorve a diferença (0,00).
        var partes = Rateio.Distribuir([new BaseRateio(7, 2m), new BaseRateio(3, 2m)], 0.01m, TipoRateio.Desconto);
        Assert.Equal(0.00m, partes[3]);
        Assert.Equal(0.01m, partes[7]);
    }

    [Fact]
    public void Arredondamento_para_cima_de_muitos_itens_nunca_deixa_ancora_negativa()
    {
        // 10 itens iguais e R$ 0,05: arred2(0,005) = 0,01 em 9 itens somaria 0,09 > 0,05.
        var itens = Enumerable.Range(1, 10).Select(i => new BaseRateio(i, 10m)).ToList();
        var partes = Rateio.Distribuir(itens, 0.05m, TipoRateio.Desconto);
        Assert.Equal(0.05m, partes.Values.Sum());
        Assert.All(partes.Values, p => Assert.True(p >= 0m));
    }

    [Fact]
    public void Ancora_limitada_redistribui_excedente_sem_zerar_item()
    {
        // Itens pequenos são limitados (líquido >= 0,01) e o excedente volta para quem tem espaço.
        var itens = new[] { new BaseRateio(1, 1.00m), new BaseRateio(2, 0.99m), new BaseRateio(3, 0.02m) };
        var maximo = Rateio.DescontoMaximo(itens);
        Assert.Equal(1.98m, maximo);
        var partes = Rateio.Distribuir(itens, maximo, TipoRateio.Desconto);
        Assert.Equal(maximo, partes.Values.Sum());
        foreach (var item in itens)
        {
            Assert.Equal(0.01m, item.Base - partes[item.Sequencia]);
        }
    }

    [Fact]
    public void Desconto_acima_do_maximo_e_recusado()
    {
        Assert.Throws<RegraNegocioException>(() =>
            Rateio.Distribuir([new BaseRateio(1, 1m), new BaseRateio(2, 1m)], 1.99m, TipoRateio.Desconto));
    }

    [Fact]
    public void Acrescimo_nao_tem_limite_por_item()
    {
        var partes = Rateio.Distribuir([new BaseRateio(1, 0.01m), new BaseRateio(2, 0.02m)], 100m, TipoRateio.Acrescimo);
        Assert.Equal(100m, partes.Values.Sum());
        Assert.Equal(33.33m, partes[1]);
        Assert.Equal(66.67m, partes[2]);
    }

    [Fact]
    public void Valor_com_mais_de_duas_casas_e_invalido()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            Rateio.Distribuir([new BaseRateio(1, 1m)], 0.001m, TipoRateio.Desconto));
    }

    [Fact]
    public void Resultado_e_deterministico_independente_da_ordem_de_entrada()
    {
        var a = new[] { new BaseRateio(1, 3.33m), new BaseRateio(2, 3.33m), new BaseRateio(3, 3.34m), new BaseRateio(4, 9.99m) };
        var b = a.Reverse().ToArray();
        var pa = Rateio.Distribuir(a, 7.77m, TipoRateio.Desconto);
        var pb = Rateio.Distribuir(b, 7.77m, TipoRateio.Desconto);
        Assert.Equal(pa.OrderBy(p => p.Key), pb.OrderBy(p => p.Key));
    }

    [Fact]
    public void Propriedade_10000_vendas_aleatorias()
    {
        // Critério de aceite PDV 12.5: soma sempre igual ao valor e nenhum item com líquido <= 0.
        var aleatorio = new Random(20261030);
        for (var n = 0; n < 10_000; n++)
        {
            var quantidade = aleatorio.Next(1, 40);
            var itens = Enumerable.Range(1, quantidade)
                .Select(i => new BaseRateio(i, aleatorio.Next(1, aleatorio.Next(2) == 0 ? 50 : 500_000) / 100m))
                .ToList();
            var maximo = Rateio.DescontoMaximo(itens);
            if (maximo <= 0m)
            {
                continue;
            }

            var valor = aleatorio.Next(4) switch
            {
                0 => maximo,
                1 => 0.01m,
                _ => Math.Max(0.01m, decimal.Round(maximo * (decimal)aleatorio.NextDouble(), 2)),
            };
            var partes = Rateio.Distribuir(itens, valor, TipoRateio.Desconto);
            Assert.Equal(valor, partes.Values.Sum());
            foreach (var item in itens)
            {
                Assert.True(partes[item.Sequencia] >= 0m, $"parte negativa na venda {n}");
                Assert.True(item.Base - partes[item.Sequencia] >= 0.01m, $"líquido <= 0 na venda {n}");
                Assert.Equal(decimal.Round(partes[item.Sequencia], 2), partes[item.Sequencia]);
            }

            var acrescimo = Rateio.Distribuir(itens, valor, TipoRateio.Acrescimo);
            Assert.Equal(valor, acrescimo.Values.Sum());
            Assert.All(acrescimo.Values, p => Assert.True(p >= 0m));
        }
    }
}
