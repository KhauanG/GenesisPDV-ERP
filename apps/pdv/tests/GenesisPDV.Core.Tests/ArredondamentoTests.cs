using System.Text.RegularExpressions;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Tests;

public partial class ArredondamentoTests
{
    [Theory]
    [InlineData("0.005", "0.01")]
    [InlineData("0.004", "0.00")]
    [InlineData("2.675", "2.68")]
    [InlineData("1.6664", "1.67")]
    [InlineData("0.8332", "0.83")]
    [InlineData("-0.005", "-0.01")]
    public void Arred2_usa_meio_para_cima(string entrada, string esperado)
    {
        Assert.Equal(decimal.Parse(esperado, System.Globalization.CultureInfo.InvariantCulture),
            Arredondamento.Arred2(decimal.Parse(entrada, System.Globalization.CultureInfo.InvariantCulture)));
    }

    [Fact]
    public void Valor_bruto_de_quantidade_pesada()
    {
        // 0,795 kg x 19,99 = 15,89205 -> 15,89 (wireframe arredonda etiqueta; aqui é cálculo puro)
        Assert.Equal(15.89m, Arredondamento.Arred2(0.795m * 19.99m));
        Assert.Equal(41.88m, Arredondamento.Arred2(12m * 3.49m));
    }

    [Fact]
    public void Percentual_vira_valor_arredondado()
    {
        Assert.Equal(3.33m, Arredondamento.ValorDoPercentual(33.33m, 10m));
        Assert.Equal(0.01m, Arredondamento.ValorDoPercentual(0.10m, 5m));
    }

    [Theory]
    [InlineData("12,50", true, "12.50")]
    [InlineData("12.5", true, "12.5")]
    [InlineData("R$ 7,00", true, "7.00")]
    [InlineData("0,750", true, "0.750")]
    [InlineData("1,2,3", false, "0")]
    [InlineData("abc", false, "0")]
    [InlineData("", false, "0")]
    [InlineData("-1", false, "0")]
    [InlineData(",5", false, "0")]
    [InlineData("1.256,97", true, "1256.97")]
    [InlineData("R$ 1.256,97", true, "1256.97")]
    [InlineData("12.345.678,90", true, "12345678.90")]
    [InlineData("1.000,00", true, "1000.00")]
    [InlineData("1.234,567", true, "1234.567")]
    [InlineData("1.256", true, "1.256")]
    [InlineData("1.25,97", false, "0")]
    [InlineData("1256.,97", false, "0")]
    [InlineData(".256,97", false, "0")]
    [InlineData("1.2567,97", false, "0")]
    [InlineData("1,256.97", false, "0")]
    [InlineData("1.256.789", false, "0")]
    public void NumeroBr_aceita_virgula_e_ponto(string texto, bool ok, string esperado)
    {
        Assert.Equal(ok, NumeroBr.TentarLer(texto, out var valor));
        if (ok)
        {
            Assert.Equal(decimal.Parse(esperado, System.Globalization.CultureInfo.InvariantCulture), valor);
        }
    }

    [Theory]
    [InlineData("0")]
    [InlineData("0.01")]
    [InlineData("999.99")]
    [InlineData("1000")]
    [InlineData("1256.97")]
    [InlineData("10000.5")]
    [InlineData("123456.78")]
    [InlineData("9999999.99")]
    public void NumeroBr_le_de_volta_o_que_escreve(string texto)
    {
        // O PDV pré-preenche campos com Dinheiro/Quantidade (pagamento, fundo de troco, fechamento) e lê com TentarLer:
        // a volta tem de dar o mesmo valor, inclusive com separador de milhar (venda de R$ 1.000 ou mais).
        var valor = decimal.Parse(texto, System.Globalization.CultureInfo.InvariantCulture);
        Assert.True(NumeroBr.TentarLer(NumeroBr.Dinheiro(valor), out var dinheiro));
        Assert.Equal(Arredondamento.Arred2(valor), dinheiro);
        Assert.True(NumeroBr.TentarLer(NumeroBr.Quantidade(valor), out var quantidade));
        Assert.Equal(valor, quantidade);
    }

    [Fact]
    public void Formatacao_brasileira()
    {
        Assert.Equal("1.234,50", NumeroBr.Dinheiro(1234.5m));
        Assert.Equal("0,795", NumeroBr.Quantidade(0.795m));
        Assert.Equal("3,49", NumeroBr.Preco(3.4900m));
        Assert.Equal("3,4950", NumeroBr.Preco(3.495m));
    }

    [Fact]
    public void CabeEm_detecta_casas_excedentes()
    {
        Assert.True(Arredondamento.CabeEm(12.50m, 2));
        Assert.True(Arredondamento.CabeEm(12.500m, 2));
        Assert.False(Arredondamento.CabeEm(12.505m, 2));
    }

    [Fact]
    public void Arred_em_n_casas_usa_meio_para_cima()
    {
        Assert.Equal(12.3457m, Arredondamento.Arred(12.34565m, Arredondamento.CasasPercentual));
        Assert.Equal(0.125m, Arredondamento.Arred(0.1245m, 3));
        Assert.Equal(3m, Arredondamento.Arred(2.5m, 0));
    }

    /// <summary>
    /// Padrões da Fase 3 (F3-B16; PDV 12.1): todo arredondamento de decimal do PDV passa pelo <see cref="Arredondamento"/>.
    /// O padrão do .NET (<c>decimal.Round</c>/<c>Math.Round</c> sem o <see cref="MidpointRounding"/>) é o bancário, que dá
    /// 2,67 em 2,675 e um centavo diferente da NFC-e. O teste varre o código dos projetos do PDV e recusa a chamada fora do
    /// arquivo dele; ficam de fora só as de <c>double</c> (milissegundos do relógio e do boot), uma por linha, na lista.
    /// </summary>
    [Fact]
    public void Nenhum_arredondamento_de_decimal_fora_do_arquivo_do_arredondamento()
    {
        var src = Path.Combine(PastaPdv(), "src");
        var arquivos = Directory.EnumerateFiles(src, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .ToList();
        Assert.True(arquivos.Count > 50, "a varredura achou o código do PDV");

        var achados = new List<string>();
        foreach (var arquivo in arquivos)
        {
            if (Path.GetFileName(arquivo) == "Arredondamento.cs")
            {
                continue;
            }

            var linhas = File.ReadAllLines(arquivo);
            for (var i = 0; i < linhas.Length; i++)
            {
                var linha = linhas[i];
                if (ChamadaDeArredondamento().IsMatch(linha) && !linha.TrimStart().StartsWith("///", StringComparison.Ordinal) && !DeDouble(linha))
                {
                    achados.Add($"{Path.GetRelativePath(src, arquivo)}:{i + 1}: {linha.Trim()}");
                }
            }
        }

        Assert.True(achados.Count == 0, "Use o Arredondamento (Core/Numeros) no lugar de:\n" + string.Join('\n', achados));
    }

    /// <summary>As de <c>double</c> que o PDV tem: o desvio do relógio e o boot da máquina, em milissegundos e minutos.</summary>
    private static bool DeDouble(string linha) =>
        linha.Contains("Math.Round(", StringComparison.Ordinal)
        && (linha.Contains(".TotalMilliseconds", StringComparison.Ordinal) || linha.Contains("(double)", StringComparison.Ordinal));

    [GeneratedRegex(@"\b(Math|decimal|Decimal)\.Round\s*\(")]
    private static partial Regex ChamadaDeArredondamento();

    /// <summary><c>apps/pdv</c>, subindo a partir da saída do teste até achar o <c>GenesisPDV.slnx</c>.</summary>
    private static string PastaPdv()
    {
        for (var pasta = new DirectoryInfo(AppContext.BaseDirectory); pasta is not null; pasta = pasta.Parent)
        {
            if (File.Exists(Path.Combine(pasta.FullName, "GenesisPDV.slnx")))
            {
                return pasta.FullName;
            }
        }

        throw new InvalidOperationException("GenesisPDV.slnx não encontrado acima da pasta do teste.");
    }
}
