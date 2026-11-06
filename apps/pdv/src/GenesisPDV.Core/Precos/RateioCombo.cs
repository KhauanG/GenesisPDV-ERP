using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Precos;

/// <summary>Uma linha do combo no rateio: peso = preço de varejo do componente escolhido × quantidade da linha.</summary>
public readonly record struct PesoComponente(decimal Peso, decimal Quantidade);

/// <summary>
/// Rateio do valor do combo entre as linhas dos componentes (PDV 10.9.1, também a base da NFC-e):
/// <c>valor_bruto = arred2(valor × peso ÷ Σ pesos)</c>; a diferença de centavos vai para a linha de maior peso (a
/// primeira, no empate), como na âncora da 12.4. Sem nenhum peso, o rateio é pela quantidade. Garantias: Σ partes =
/// valor; toda linha com pelo menos R$ 0,01 (um <c>det</c> da NFC-e não pode ter <c>vProd</c> zero).
/// </summary>
public static class RateioCombo
{
    public static decimal[] Distribuir(decimal valor, IReadOnlyList<PesoComponente> linhas)
    {
        ArgumentNullException.ThrowIfNull(linhas);
        if (linhas.Count == 0)
        {
            throw new ArgumentException("Combo sem componentes.", nameof(linhas));
        }

        if (!Arredondamento.CabeEm(valor, Arredondamento.CasasDinheiro) || valor < 0m)
        {
            throw new ArgumentOutOfRangeException(nameof(valor), valor, "Valor do combo inválido.");
        }

        if (linhas.Any(l => l.Peso < 0m || l.Quantidade <= 0m))
        {
            throw new ArgumentException("Peso negativo ou quantidade inválida no rateio do combo.", nameof(linhas));
        }

        if (valor < Arredondamento.Centavo * linhas.Count)
        {
            throw new RegraNegocioException(
                $"O preço do combo (R$ {NumeroBr.Dinheiro(valor)}) é menor que R$ 0,01 por componente — procure o gerente.");
        }

        var pesos = linhas.Sum(l => l.Peso) > 0m ? linhas.Select(l => l.Peso).ToArray() : linhas.Select(l => l.Quantidade).ToArray();
        var soma = pesos.Sum();
        var partes = pesos.Select(p => Arredondamento.Arred2(valor * p / soma)).ToArray();

        var ancora = 0;
        for (var i = 1; i < pesos.Length; i++)
        {
            if (pesos[i] > pesos[ancora])
            {
                ancora = i;
            }
        }

        partes[ancora] += valor - partes.Sum();

        // Linha zerada (peso muito pequeno ou nulo) recebe 1 centavo tirado da maior parte.
        for (var i = 0; i < partes.Length; i++)
        {
            while (partes[i] < Arredondamento.Centavo)
            {
                var maior = Array.IndexOf(partes, partes.Max());
                partes[maior] -= Arredondamento.Centavo;
                partes[i] += Arredondamento.Centavo;
            }
        }

        return partes;
    }
}
