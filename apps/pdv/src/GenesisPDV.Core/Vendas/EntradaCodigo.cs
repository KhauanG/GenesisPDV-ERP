using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Vendas;

public enum TipoEntrada
{
    Vazia,
    Produto,
    DefinirMultiplicador,
    Pesquisa,
    Incrementar,
    Decrementar,
    Invalida,
}

/// <param name="Quantidade">Multiplicador a aplicar (1 quando não informado nem pendente).</param>
public sealed record EntradaInterpretada(TipoEntrada Tipo, string? Codigo = null, decimal Quantidade = 1m, string? Mensagem = null);

/// <summary>
/// Gramática do campo de código da tela de venda (PDV 10.1): <c>código</c>, <c>qtd*código</c> (ou <c>x</c>/<c>X</c>),
/// <c>qtd*</c> para fixar o multiplicador da próxima leitura, <c>+</c>/<c>-</c> e texto livre para pesquisa.
/// </summary>
public static class EntradaCodigo
{
    public const int TamanhoMaximoCodigo = 30;

    public static EntradaInterpretada Interpretar(string? texto, decimal? multiplicadorPendente = null)
    {
        var t = (texto ?? string.Empty).Trim();
        if (t.Length == 0)
        {
            return new EntradaInterpretada(TipoEntrada.Vazia);
        }

        if (t == "+")
        {
            return new EntradaInterpretada(TipoEntrada.Incrementar);
        }

        if (t == "-")
        {
            return new EntradaInterpretada(TipoEntrada.Decrementar);
        }

        var separador = t.IndexOfAny(['*', 'x', 'X']);
        if (separador > 0 && EhQuantidade(t[..separador].TrimEnd()))
        {
            var textoQtd = t[..separador].TrimEnd();
            var resto = t[(separador + 1)..].Trim();
            if (!LerQuantidade(textoQtd, out var qtd, out var erro))
            {
                return new EntradaInterpretada(TipoEntrada.Invalida, Mensagem: erro);
            }

            if (resto.Length == 0)
            {
                return new EntradaInterpretada(TipoEntrada.DefinirMultiplicador, Quantidade: qtd);
            }

            return EhCodigo(resto)
                ? new EntradaInterpretada(TipoEntrada.Produto, resto, qtd)
                : new EntradaInterpretada(TipoEntrada.Invalida, Mensagem: $"Código inválido: {resto}");
        }

        if (EhCodigo(t))
        {
            return new EntradaInterpretada(TipoEntrada.Produto, t, multiplicadorPendente ?? 1m);
        }

        return new EntradaInterpretada(TipoEntrada.Pesquisa, t);
    }

    private static bool EhCodigo(string s) => s.Length is > 0 and <= TamanhoMaximoCodigo && s.All(char.IsAsciiDigit);

    private static bool EhQuantidade(string s) => s.Length > 0 && s.All(c => char.IsAsciiDigit(c) || c is ',' or '.');

    private static bool LerQuantidade(string texto, out decimal quantidade, out string? erro)
    {
        erro = null;
        if (!NumeroBr.TentarLer(texto, out quantidade))
        {
            erro = $"Quantidade inválida: {texto}";
            return false;
        }

        if (quantidade <= 0m || quantidade > Venda.QuantidadeMaxima)
        {
            erro = "Quantidade deve ser maior que zero e no máximo 9.999,999.";
            return false;
        }

        if (!Arredondamento.CabeEm(quantidade, Arredondamento.CasasQuantidade))
        {
            erro = "Quantidade com no máximo 3 casas decimais.";
            return false;
        }

        return true;
    }
}
