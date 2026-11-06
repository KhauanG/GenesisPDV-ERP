using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Caixa;

/// <summary>Forma de pagamento como o fechamento a lista (snapshot do espelho <c>formas_pagamento</c>).</summary>
public sealed record FormaCaixa(Guid Id, string Descricao, string TipoForma);

/// <summary>
/// Pagamento aprovado de venda <b>finalizada na sessão</b> (mesmo que cancelada depois: o estorno entra pelo movimento,
/// PDV 21.2). <paramref name="Valor"/> é o aplicado à venda (no dinheiro já sem o troco, 16.4); <paramref name="Troco"/>
/// é o que saiu da gaveta por uma forma que não é dinheiro com "dá troco" (20.4).
/// </summary>
public sealed record PagamentoApurado(FormaCaixa Forma, decimal Valor, decimal Troco = 0m);

/// <summary>Movimento de caixa (<c>movimentos_caixa</c>) da sessão; <paramref name="Forma"/> só no estorno.</summary>
public sealed record MovimentoApurado(string Tipo, decimal Valor, bool Cancelado = false, FormaCaixa? Forma = null);

/// <summary>Calculado de uma forma no fechamento (<c>fechamentos_caixa_formas.valor_calculado</c>).</summary>
public sealed record FormaApurada(FormaCaixa Forma, decimal Calculado, int QuantidadePagamentos);

/// <summary>Resultado da apuração: o dinheiro estimado na gaveta e o calculado por forma (Dinheiro primeiro).</summary>
public sealed record ResultadoApuracao(decimal DinheiroGaveta, IReadOnlyList<FormaApurada> Formas)
{
    public decimal TotalCalculado => Formas.Sum(f => f.Calculado);
}

/// <summary>
/// Apuração da sessão de caixa (PDV 20.4 e 21.2; Fase 1C, bloco C10a), só com fatos <b>registrados na própria
/// sessão</b> e movimentos não cancelados:
/// <code>
/// dinheiro_gaveta = fundo_troco + Σ pagamentos em dinheiro − Σ troco das outras formas + Σ reforço − Σ sangria
///                   − Σ sangria_fechamento − Σ estorno_venda em dinheiro − Σ devolucao_troca
/// calculado(dinheiro) = dinheiro_gaveta (antes da sangria do próprio fechamento)
/// calculado(forma f)  = Σ pagamentos da forma f − Σ estorno_venda da forma f
/// </code>
/// O movimento <c>abertura</c> é o próprio fundo (já somado por <c>fundo_troco</c>) e não conta de novo. A venda cancelada
/// continua somando na sessão em que foi paga; o estorno subtrai na sessão em que o dinheiro saiu (nunca em dobro). As
/// formas do tipo <c>dinheiro</c> são todas a mesma gaveta: o fechamento conta uma linha só, a da forma Dinheiro
/// informada. Recebimento de crediário (16.13) é da PDV-2.
/// </summary>
public static class ApuracaoCaixa
{
    public const string TipoDinheiro = "dinheiro";

    /// <param name="dinheiro">Forma da linha Dinheiro (sempre listada, mesmo sem venda).</param>
    /// <param name="formasOferecidas">Formas da loja listadas mesmo sem movimento (contagem por forma, O3).</param>
    public static ResultadoApuracao Calcular(
        decimal fundoTroco,
        IEnumerable<PagamentoApurado> pagamentos,
        IEnumerable<MovimentoApurado> movimentos,
        FormaCaixa dinheiro,
        IEnumerable<FormaCaixa>? formasOferecidas = null)
    {
        ArgumentNullException.ThrowIfNull(pagamentos);
        ArgumentNullException.ThrowIfNull(movimentos);
        ArgumentNullException.ThrowIfNull(dinheiro);
        var listaPagamentos = pagamentos.ToList();
        var validos = movimentos.Where(m => !m.Cancelado).ToList();
        var gaveta = DinheiroGaveta(fundoTroco, listaPagamentos, validos);

        var formas = new List<FormaApurada>
        {
            new(dinheiro, Arredondamento.Arred2(gaveta), listaPagamentos.Count(p => EhDinheiro(p.Forma))),
        };
        var outras = listaPagamentos.Select(p => p.Forma)
            .Concat(validos.Where(m => m.Tipo == TiposMovimento.EstornoVenda && m.Forma is not null).Select(m => m.Forma!))
            .Concat(formasOferecidas ?? [])
            .Where(f => !EhDinheiro(f))
            .DistinctBy(f => f.Id);
        foreach (var forma in outras)
        {
            var daForma = listaPagamentos.Where(p => p.Forma.Id == forma.Id).ToList();
            var estornos = validos.Where(m => m.Tipo == TiposMovimento.EstornoVenda && m.Forma?.Id == forma.Id).Sum(m => m.Valor);
            formas.Add(new FormaApurada(forma, Arredondamento.Arred2(daForma.Sum(p => p.Valor) - estornos), daForma.Count));
        }

        return new ResultadoApuracao(Arredondamento.Arred2(gaveta), formas);
    }

    /// <summary>
    /// <c>dinheiro_gaveta</c> da 20.4: o mesmo valor da linha Dinheiro do fechamento, usado também no limite de gaveta,
    /// na sangria (não retira mais que o estimado) e no heartbeat (<c>dinheiro_estimado_gaveta</c>; Fase 1C, C10b).
    /// </summary>
    public static decimal DinheiroGaveta(decimal fundoTroco, IEnumerable<PagamentoApurado> pagamentos, IEnumerable<MovimentoApurado> movimentos)
    {
        ArgumentNullException.ThrowIfNull(pagamentos);
        ArgumentNullException.ThrowIfNull(movimentos);
        var listaPagamentos = pagamentos as IReadOnlyCollection<PagamentoApurado> ?? pagamentos.ToList();
        var validos = movimentos.Where(m => !m.Cancelado).ToList();
        return Arredondamento.Arred2(fundoTroco
                                     + listaPagamentos.Where(p => EhDinheiro(p.Forma)).Sum(p => p.Valor)
                                     - listaPagamentos.Where(p => !EhDinheiro(p.Forma)).Sum(p => p.Troco)
                                     + Soma(validos, TiposMovimento.Reforco)
                                     - Soma(validos, TiposMovimento.Sangria)
                                     - Soma(validos, TiposMovimento.SangriaFechamento)
                                     - validos.Where(m => m.Tipo == TiposMovimento.EstornoVenda && (m.Forma is null || EhDinheiro(m.Forma))).Sum(m => m.Valor)
                                     - Soma(validos, TiposMovimento.DevolucaoTroca));
    }

    public static bool EhDinheiro(FormaCaixa forma)
    {
        ArgumentNullException.ThrowIfNull(forma);
        return forma.TipoForma == TipoDinheiro;
    }

    private static decimal Soma(IEnumerable<MovimentoApurado> movimentos, string tipo) => movimentos.Where(m => m.Tipo == tipo).Sum(m => m.Valor);
}

/// <summary><c>movimentos_caixa.tipo</c> (<c>ck_movimentos_caixa_tipo</c>), os mesmos do Data.</summary>
public static class TiposMovimento
{
    public const string Abertura = "abertura";
    public const string Reforco = "reforco";
    public const string Sangria = "sangria";
    public const string SangriaFechamento = "sangria_fechamento";
    public const string DevolucaoTroca = "devolucao_troca";
    public const string EstornoVenda = "estorno_venda";
}
