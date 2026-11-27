using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Vendas;

/// <summary>
/// Preço digitado na inclusão do "Produto genérico" ou do "Solicita preço PDV" (PDV 10.4; Fase 3, F3-B16): o item entra com
/// <c>origem_preco = 'manual'</c> e o preço digitado também no <c>preco_tabela</c>, porque é a natureza do produto e não
/// conta como desconto (12.3). <paramref name="Descricao"/> só no genérico (nula = o nome do produto).
/// </summary>
public sealed record PrecoDigitado(decimal Preco, string? Descricao = null);

/// <summary>
/// Regras do preço que o operador digita (PDV 10.4 e 10.5; F3-B16): o do genérico e do "Solicita preço PDV" e o do
/// <c>Ctrl+F6</c> (alterar o preço do item). Valem as mesmas bordas nos dois: maior que zero, em R$ com até 2 casas, até
/// <see cref="PrecoMaximo"/>, e acima de <c>pdv.limite_preco_digitado</c> a tela pede uma confirmação (não recusa: o limite
/// pega o dedo que escorregou).
/// </summary>
public static class RegrasPrecoManual
{
    /// <summary><c>itens_venda.descricao</c> (MD 3.11.3; <c>textoPreenchido(120)</c> no contrato da venda).</summary>
    public const int DescricaoMaxima = 120;

    /// <summary><c>pdv.limite_preco_digitado</c> do catálogo (<c>packages/shared/src/configuracoes.ts</c>): R$ 9.999,99.</summary>
    public const decimal LimitePadrao = 9999.99m;

    /// <summary>
    /// O teto do preço digitado (F3-B16): R$ 999.999,99 por unidade. O <c>pdv.limite_preco_digitado</c> só pede o segundo
    /// Enter (e vazio nem isso); este recusa, porque o contrato da venda aceita o preço com 11 dígitos inteiros e o
    /// <c>valor_bruto</c> com 13 (<c>decimalTexto</c> do <c>venda.finalizada</c>): com a quantidade máxima (9.999,999), o
    /// bruto deste teto ainda cabe com folga, e a venda acima dele seria recusada inteira pela nuvem.
    /// </summary>
    public const decimal PrecoMaximo = 999_999.99m;

    public const string MensagemPrecoInvalido = "Informe um preço maior que zero, por exemplo 12,50.";

    /// <summary>Lê "12,50" ou "R$ 12,50": maior que zero e com até 2 casas (o preço é digitado em reais).</summary>
    public static decimal LerPreco(string? texto)
    {
        if (!NumeroBr.TentarLer(texto ?? string.Empty, out var preco) || preco <= 0m)
        {
            throw new RegraNegocioException(MensagemPrecoInvalido);
        }

        return ValidarPreco(preco);
    }

    /// <summary>O preço já em número (o Core confere de novo o que a tela leu).</summary>
    public static decimal ValidarPreco(decimal preco)
    {
        if (preco <= 0m)
        {
            throw new RegraNegocioException(MensagemPrecoInvalido);
        }

        if (!Arredondamento.CabeEm(preco, Arredondamento.CasasDinheiro))
        {
            throw new RegraNegocioException("O preço deve ter no máximo 2 casas decimais.");
        }

        if (preco > PrecoMaximo)
        {
            throw new RegraNegocioException($"Preço acima do máximo do caixa (R$ {NumeroBr.Dinheiro(PrecoMaximo)}). Confira o valor digitado.");
        }

        return preco;
    }

    /// <summary>Acima de <c>pdv.limite_preco_digitado</c> (nulo = sem limite) a tela pede a confirmação (10.4).</summary>
    public static bool AcimaDoLimite(decimal preco, decimal? limite) => limite is { } l && preco > l;

    public static string MensagemAcimaDoLimite(decimal preco, decimal limite) =>
        $"R$ {NumeroBr.Dinheiro(preco)} passa do limite de preço digitado (R$ {NumeroBr.Dinheiro(limite)}). Confira e tecle Enter de novo para confirmar.";

    /// <summary>A descrição do genérico: o texto aparado, de 1 a 120 caracteres.</summary>
    public static string DescricaoGenerico(string? texto)
    {
        var d = (texto ?? string.Empty).Trim();
        if (d.Length == 0 || d.Length > DescricaoMaxima)
        {
            throw new RegraNegocioException($"Informe a descrição do item (até {DescricaoMaxima} caracteres).");
        }

        return d;
    }
}
