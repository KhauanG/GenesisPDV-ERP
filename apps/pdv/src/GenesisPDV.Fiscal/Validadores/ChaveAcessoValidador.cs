namespace GenesisPDV.Fiscal.Validadores;

/// <summary>
/// Chave de acesso NF-e/NFC-e (44 posições): cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1).
/// Só as 12 primeiras posições do CNPJ podem ter letras; DV por módulo 11 com pesos 2..9 sobre (ASCII − 48).
/// </summary>
public static class ChaveAcessoValidador
{
    public static bool Validar(string? valor)
    {
        var chave = string.Concat((valor ?? string.Empty).Where(c => !char.IsWhiteSpace(c))).ToUpperInvariant();
        if (chave.Length != 44)
        {
            return false;
        }

        for (var i = 0; i < 44; i++)
        {
            var letraPermitida = i is >= 6 and < 18;
            if (!(char.IsAsciiDigit(chave[i]) || (letraPermitida && char.IsAsciiLetterUpper(chave[i]))))
            {
                return false;
            }
        }

        return CalcularDv(chave[..43]) == chave[43] - '0';
    }

    public static int CalcularDv(string base43)
    {
        ArgumentNullException.ThrowIfNull(base43);
        var soma = 0;
        var peso = 2;
        for (var i = base43.Length - 1; i >= 0; i--)
        {
            soma += ValorModulo11.De(base43[i]) * peso;
            peso = peso == 9 ? 2 : peso + 1;
        }

        var resto = soma % 11;
        return resto < 2 ? 0 : 11 - resto;
    }
}
