using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Vendas;

public enum TipoRateio
{
    Desconto,
    Acrescimo,
}

/// <summary>Uma linha que participa do rateio: <c>base_i = valor_bruto − desconto_item − desconto_promocao</c>.</summary>
public readonly record struct BaseRateio(int Sequencia, decimal Base);

/// <summary>
/// Rateio de desconto/acréscimo do total entre os itens (PDV 12.4). Garantias: Σ partes = valor exatamente,
/// nenhuma parte negativa, nenhum líquido ≤ 0 no desconto e resultado determinístico.
/// </summary>
public static class Rateio
{
    /// <summary>Maior desconto no total que ainda deixa todo item com pelo menos R$ 0,01.</summary>
    public static decimal DescontoMaximo(IReadOnlyCollection<BaseRateio> itens) =>
        itens.Sum(i => i.Base) - (Arredondamento.Centavo * itens.Count);

    /// <returns>Parte de cada item, indexada por <see cref="BaseRateio.Sequencia"/>.</returns>
    public static IReadOnlyDictionary<int, decimal> Distribuir(IReadOnlyList<BaseRateio> itens, decimal valor, TipoRateio tipo)
    {
        ArgumentNullException.ThrowIfNull(itens);
        if (valor < 0 || !Arredondamento.CabeEm(valor, Arredondamento.CasasDinheiro))
        {
            throw new ArgumentOutOfRangeException(nameof(valor), valor, "O valor a ratear deve ser positivo e ter no máximo 2 casas.");
        }

        if (itens.Select(i => i.Sequencia).Distinct().Count() != itens.Count)
        {
            throw new ArgumentException("Sequências repetidas no rateio.", nameof(itens));
        }

        var partes = itens.ToDictionary(i => i.Sequencia, _ => 0m);
        if (valor == 0m || itens.Count == 0)
        {
            if (valor > 0m)
            {
                throw new RegraNegocioException("Não há itens para ratear o valor.");
            }

            return partes;
        }

        if (itens.Any(i => i.Base <= 0m))
        {
            throw new ArgumentException("Toda base de rateio deve ser positiva.", nameof(itens));
        }

        var total = itens.Sum(i => i.Base);
        if (tipo == TipoRateio.Desconto && valor > DescontoMaximo(itens))
        {
            throw new RegraNegocioException(
                $"Desconto de R$ {NumeroBr.Dinheiro(valor)} deixaria item com valor zero. Máximo: R$ {NumeroBr.Dinheiro(Math.Max(0m, DescontoMaximo(itens)))}.");
        }

        var ordem = itens.OrderByDescending(i => i.Base).ThenBy(i => i.Sequencia).ToList();
        var ancora = ordem[0];
        var limite = ordem.ToDictionary(
            i => i.Sequencia,
            i => tipo == TipoRateio.Desconto ? i.Base - Arredondamento.Centavo : decimal.MaxValue);

        foreach (var item in ordem.Skip(1))
        {
            partes[item.Sequencia] = Math.Min(Arredondamento.Arred2(valor * item.Base / total), limite[item.Sequencia]);
        }

        partes[ancora.Sequencia] = valor - partes.Where(p => p.Key != ancora.Sequencia).Sum(p => p.Value);

        // Muitos itens arredondados para cima podem passar do valor: devolve centavos, do fim da ordem para o começo.
        if (partes[ancora.Sequencia] < 0m)
        {
            var falta = -partes[ancora.Sequencia];
            partes[ancora.Sequencia] = 0m;
            var reverso = ordem.Skip(1).Reverse().ToList();
            while (falta > 0m)
            {
                foreach (var item in reverso)
                {
                    if (falta == 0m)
                    {
                        break;
                    }

                    if (partes[item.Sequencia] > 0m)
                    {
                        partes[item.Sequencia] -= Arredondamento.Centavo;
                        falta -= Arredondamento.Centavo;
                    }
                }
            }
        }

        // Âncora não pode zerar o próprio líquido: o excedente vai, centavo a centavo, aos próximos itens na ordem.
        if (partes[ancora.Sequencia] > limite[ancora.Sequencia])
        {
            var excedente = partes[ancora.Sequencia] - limite[ancora.Sequencia];
            partes[ancora.Sequencia] = limite[ancora.Sequencia];
            var proximos = ordem.Skip(1).ToList();
            while (excedente > 0m)
            {
                var distribuiu = false;
                foreach (var item in proximos)
                {
                    if (excedente == 0m)
                    {
                        break;
                    }

                    if (partes[item.Sequencia] < limite[item.Sequencia])
                    {
                        partes[item.Sequencia] += Arredondamento.Centavo;
                        excedente -= Arredondamento.Centavo;
                        distribuiu = true;
                    }
                }

                if (!distribuiu)
                {
                    throw new InvalidOperationException("Rateio sem espaço para distribuir o excedente.");
                }
            }
        }

        return partes;
    }
}
