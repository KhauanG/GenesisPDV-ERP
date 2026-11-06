namespace GenesisPDV.Core.Numeros;

/// <summary>
/// Regras de arredondamento do PDV (especificação do PDV 12.1): contas em <see cref="decimal"/> sem arredondamento
/// intermediário; arredondamento só ao gravar, "meio para cima" (<see cref="MidpointRounding.AwayFromZero"/>).
/// </summary>
public static class Arredondamento
{
    public const int CasasDinheiro = 2;
    public const int CasasPreco = 4;
    public const int CasasQuantidade = 3;
    public const int CasasPercentual = 4;

    public static readonly decimal Centavo = 0.01m;

    public static decimal Arred2(decimal valor) => decimal.Round(valor, CasasDinheiro, MidpointRounding.AwayFromZero);

    public static decimal Arred3(decimal valor) => decimal.Round(valor, CasasQuantidade, MidpointRounding.AwayFromZero);

    public static decimal Arred4(decimal valor) => decimal.Round(valor, CasasPreco, MidpointRounding.AwayFromZero);

    /// <summary>Trunca em 2 casas (para baixo, valor ≥ 0): teto de desconto que nunca passa do % permitido.</summary>
    public static decimal Truncar2(decimal valor) => decimal.Round(valor, CasasDinheiro, MidpointRounding.ToZero);

    /// <summary>Verdadeiro quando o valor não tem mais casas decimais significativas que <paramref name="casas"/>.</summary>
    public static bool CabeEm(decimal valor, int casas) => decimal.Round(valor, casas) == valor;

    /// <summary>Converte percentual em valor no momento da aplicação: arred2(base × pct ÷ 100).</summary>
    public static decimal ValorDoPercentual(decimal baseCalculo, decimal percentual) => Arred2(baseCalculo * percentual / 100m);
}
