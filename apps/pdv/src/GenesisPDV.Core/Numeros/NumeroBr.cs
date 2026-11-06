using System.Globalization;

namespace GenesisPDV.Core.Numeros;

/// <summary>
/// Leitura e exibição de números no padrão brasileiro. Na digitação, vírgula e ponto valem como separador decimal
/// (a tecla "." do teclado numérico vira vírgula — PDV 32.8). O ponto só é separador de milhar quando o texto também
/// tem vírgula e os grupos estão bem formados ("1.256,97"): é o formato que o próprio PDV escreve nos campos com
/// <see cref="Dinheiro"/> e <see cref="Quantidade"/> (pagamento, fundo de troco, fechamento), e ele precisa ser lido
/// de volta — sem isso, qualquer valor a partir de R$ 1.000,00 pré-preenchido era recusado.
/// </summary>
public static class NumeroBr
{
    public static readonly CultureInfo Cultura = CultureInfo.GetCultureInfo("pt-BR");

    public static bool TentarLer(string? texto, out decimal valor)
    {
        valor = 0m;
        if (string.IsNullOrWhiteSpace(texto))
        {
            return false;
        }

        var limpo = texto.Trim();
        if (limpo.StartsWith("R$", StringComparison.OrdinalIgnoreCase))
        {
            limpo = limpo[2..].Trim();
        }

        if (limpo.Contains(',') && limpo.Contains('.'))
        {
            // Com vírgula, o ponto é separador de milhar: "1.256,97", "12.345.678,90". Exige grupos de 3 dígitos antes
            // da vírgula (e o primeiro com 1 a 3), para não aceitar "1.25,97" nem "1,256.97".
            if (!MilharBemFormado(limpo))
            {
                return false;
            }

            limpo = limpo.Replace(".", string.Empty);
        }

        limpo = limpo.Replace('.', ',');
        if (limpo.Count(c => c == ',') > 1 || limpo.StartsWith(',') || limpo.EndsWith(','))
        {
            return false;
        }

        foreach (var c in limpo)
        {
            if (!char.IsAsciiDigit(c) && c != ',')
            {
                return false;
            }
        }

        return decimal.TryParse(limpo.Replace(',', '.'), NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out valor);
    }

    private static bool MilharBemFormado(string texto)
    {
        var virgula = texto.IndexOf(',');
        if (virgula < 0 || texto.IndexOf('.', virgula) >= 0)
        {
            return false;
        }

        var grupos = texto[..virgula].Split('.');
        if (grupos[0].Length is < 1 or > 3)
        {
            return false;
        }

        for (var i = 1; i < grupos.Length; i++)
        {
            if (grupos[i].Length != 3)
            {
                return false;
            }
        }

        return true;
    }

    public static string Dinheiro(decimal valor) => valor.ToString("N2", Cultura);

    public static string Quantidade(decimal valor) => valor.ToString("N3", Cultura);

    public static string Percentual(decimal valor) => valor.ToString("0.00", Cultura);

    /// <summary>Preço unitário com 2 casas quando as demais são zero (exibição), senão 4.</summary>
    public static string Preco(decimal valor) =>
        Arredondamento.CabeEm(valor, 2) ? valor.ToString("N2", Cultura) : valor.ToString("N4", Cultura);
}
