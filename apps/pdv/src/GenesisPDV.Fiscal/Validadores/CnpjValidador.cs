namespace GenesisPDV.Fiscal.Validadores;

/// <summary>
/// CNPJ numérico ou alfanumérico (12 posições <c>0-9A-Z</c> + 2 DVs numéricos), MD 1.2. Mesmo algoritmo e mesma tabela
/// de casos de <c>packages/shared/src/validadores.ts</c> (<c>validadores.casos.json</c>).
/// </summary>
public static class CnpjValidador
{
    private static readonly int[] PesosDv1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    private static readonly int[] PesosDv2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

    /// <summary>Tira a máscara e põe em maiúsculas (o CNPJ alfanumérico aceita letras).</summary>
    public static string Normalizar(string? valor) =>
        string.Concat((valor ?? string.Empty).Where(char.IsAsciiLetterOrDigit)).ToUpperInvariant();

    public static bool Validar(string? valor)
    {
        var cnpj = Normalizar(valor);
        if (cnpj.Length != 14
            || !cnpj.Take(12).All(c => char.IsAsciiDigit(c) || char.IsAsciiLetterUpper(c))
            || !cnpj.Skip(12).All(char.IsAsciiDigit)
            || cnpj.All(c => c == cnpj[0]))
        {
            return false;
        }

        var dv1 = Dv(cnpj[..12]);
        var dv2 = Dv(cnpj[..12] + dv1);
        return cnpj[12] - '0' == dv1 && cnpj[13] - '0' == dv2;
    }

    /// <summary>Calcula os DVs de uma base de 12 posições.</summary>
    public static string Completar(string base12)
    {
        var b = Normalizar(base12);
        if (b.Length != 12)
        {
            throw new ArgumentException("A base do CNPJ tem 12 posições.", nameof(base12));
        }

        var dv1 = Dv(b);
        return $"{b}{dv1}{Dv(b + dv1)}";
    }

    private static int Dv(string base_)
    {
        var pesos = base_.Length == 12 ? PesosDv1 : PesosDv2;
        var soma = 0;
        for (var i = 0; i < base_.Length; i++)
        {
            soma += ValorModulo11.De(base_[i]) * pesos[i];
        }

        var resto = soma % 11;
        return resto < 2 ? 0 : 11 - resto;
    }
}

/// <summary>Valor de um caractere no módulo 11 do CNPJ alfanumérico e da chave de acesso: código ASCII − 48.</summary>
internal static class ValorModulo11
{
    public static int De(char c) => c - 48;
}
