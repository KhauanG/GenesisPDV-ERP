namespace GenesisPDV.Fiscal.Validadores;

/// <summary>CPF (11 dígitos, 2 DVs módulo 11), MD 1.2; mesmos casos de <c>validadores.casos.json</c>.</summary>
public static class CpfValidador
{
    public static bool Validar(string? valor)
    {
        var cpf = string.Concat((valor ?? string.Empty).Where(char.IsAsciiDigit));
        if (cpf.Length != 11 || cpf.All(c => c == cpf[0]))
        {
            return false;
        }

        return Dv(cpf[..9], 10) == cpf[9] - '0' && Dv(cpf[..10], 11) == cpf[10] - '0';
    }

    private static int Dv(string base_, int pesoInicial)
    {
        var soma = 0;
        for (var i = 0; i < base_.Length; i++)
        {
            soma += (base_[i] - '0') * (pesoInicial - i);
        }

        var resto = soma * 10 % 11;
        return resto == 10 ? 0 : resto;
    }
}
