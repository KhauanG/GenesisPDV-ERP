using System.Globalization;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Caixa;

/// <summary>
/// Período do resumo diário (PDV 21.6): <c>[Inicio, Fim)</c>. Pela chave <c>pdv.resumo_diario_modo</c>, por intervalo
/// de <b>dias operacionais</b> (cada um começa na hora de corte da loja, MD 1.2; D7) ou por intervalo de <b>horário</b>
/// dentro de um dia operacional (o horário antes do corte é a madrugada seguinte, do mesmo dia operacional).
/// </summary>
public sealed record PeriodoResumo(DateTimeOffset Inicio, DateTimeOffset Fim, string Descricao)
{
    public const int DiasMaximos = 31;

    public bool Contem(DateTimeOffset instante) => instante >= Inicio && instante < Fim;

    public static PeriodoResumo PorDias(DateOnly de, DateOnly ate, TimeZoneInfo fuso, TimeOnly horaCorte)
    {
        ArgumentNullException.ThrowIfNull(fuso);
        if (ate < de)
        {
            throw new RegraNegocioException("A data final tem de ser igual ou depois da inicial.");
        }

        if (ate.DayNumber - de.DayNumber >= DiasMaximos)
        {
            throw new RegraNegocioException($"O resumo diário cobre até {DiasMaximos} dias.");
        }

        return new PeriodoResumo(Instante(de, horaCorte, fuso), Instante(ate.AddDays(1), horaCorte, fuso),
            de == ate ? $"Dia operacional {Data(de)}" : $"Dias operacionais {Data(de)} a {Data(ate)}");
    }

    public static PeriodoResumo PorHorario(DateOnly dia, TimeOnly das, TimeOnly ate, TimeZoneInfo fuso, TimeOnly horaCorte)
    {
        ArgumentNullException.ThrowIfNull(fuso);
        // Dentro do dia operacional: 08:00 é do próprio dia; 02:00 (antes do corte de 05:00) é da madrugada seguinte.
        var inicio = Instante(das < horaCorte ? dia.AddDays(1) : dia, das, fuso);
        var fim = Instante(ate < horaCorte ? dia.AddDays(1) : dia, ate, fuso).AddMinutes(1);
        if (fim <= inicio)
        {
            throw new RegraNegocioException("O horário final tem de ser depois do inicial, no mesmo dia operacional.");
        }

        return new PeriodoResumo(inicio, fim,
            $"Dia operacional {Data(dia)}, das {das.ToString("HH:mm", CultureInfo.InvariantCulture)} às {ate.ToString("HH:mm", CultureInfo.InvariantCulture)}");
    }

    private static DateTimeOffset Instante(DateOnly dia, TimeOnly hora, TimeZoneInfo fuso)
    {
        var local = dia.ToDateTime(hora, DateTimeKind.Unspecified);
        if (fuso.IsInvalidTime(local))
        {
            local = local.AddHours(1);
        }

        return new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(local, fuso), TimeSpan.Zero);
    }

    private static string Data(DateOnly dia) => dia.ToString("dd/MM/yyyy", CultureInfo.InvariantCulture);
}

/// <summary>Venda local para o resumo: status, quando fechou, totais e os pagamentos aprovados.</summary>
public sealed record VendaResumo(
    Guid? SessaoCaixaId,
    string Status,
    DateTimeOffset? FinalizadaEm,
    DateTimeOffset? CanceladaEm,
    decimal Total,
    decimal Descontos,
    int QtdItensCancelados,
    decimal TotalItensCancelados,
    IReadOnlyList<PagamentoApurado> Pagamentos);

/// <summary>Sangria ou reforço do terminal para o resumo.</summary>
public sealed record MovimentoResumo(Guid SessaoCaixaId, string Tipo, decimal Valor, bool Cancelado, DateTimeOffset OcorridoEm);

/// <summary>Uma forma de pagamento no resumo (quantidade de pagamentos e valor aplicado às vendas).</summary>
public sealed record FormaResumo(string Descricao, int Quantidade, decimal Valor);

/// <summary>
/// Resumo diário / leitura do caixa (PDV 21.6; Fase 1C, bloco C10b): só os dados locais deste terminal. Vendas = as
/// finalizadas no período que continuam finalizadas (por forma, o valor aplicado: no dinheiro já sem o troco);
/// canceladas = as canceladas no período (em andamento ou finalizadas antes); descontos e itens cancelados das vendas do
/// período; sangrias e reforços não cancelados pelo <c>ocorrido_em</c> (os cancelados só contados). Com o fechamento
/// cego da O3 do dono, o resumo sai <b>sem os valores que compõem o esperado</b> (<see cref="ValoresOcultos"/>): o total
/// e o ticket das vendas, o valor por forma e os totais de sangria e reforço ficam zerados (só as quantidades), em todas
/// as sessões do período — a fechada também, porque as vendas por forma dela, com o fundo e as sangrias, são o esperado
/// e a diferença que só o gerente vê, no ERP. Cancelamentos, itens cancelados e descontos não entram no esperado e
/// aparecem.
/// </summary>
public sealed record ResumoDiario(
    PeriodoResumo Periodo,
    int QtdVendas,
    decimal TotalVendas,
    IReadOnlyList<FormaResumo> Formas,
    int QtdCanceladas,
    decimal TotalCanceladas,
    int QtdItensCancelados,
    decimal TotalItensCancelados,
    decimal TotalDescontos,
    int QtdSangrias,
    decimal TotalSangrias,
    int QtdReforcos,
    decimal TotalReforcos,
    int QtdMovimentosCancelados,
    bool ValoresOcultos)
{
    public decimal TicketMedio => QtdVendas == 0 ? 0m : Arredondamento.Arred2(TotalVendas / QtdVendas);

    /// <param name="valoresOcultos">Fechamento cego sem conferência (O3): zera os valores que compõem o esperado.</param>
    public static ResumoDiario Montar(
        PeriodoResumo periodo, IEnumerable<VendaResumo> vendas, IEnumerable<MovimentoResumo> movimentos, bool valoresOcultos = false)
    {
        ArgumentNullException.ThrowIfNull(periodo);
        ArgumentNullException.ThrowIfNull(vendas);
        ArgumentNullException.ThrowIfNull(movimentos);
        var todas = vendas.ToList();
        var finalizadas = todas.Where(v => v.Status == StatusVenda.Finalizada && v.FinalizadaEm is { } f && periodo.Contem(f)).ToList();
        var canceladas = todas.Where(v => v.Status == StatusVenda.Cancelada && v.CanceladaEm is { } c && periodo.Contem(c)).ToList();
        decimal Valor(decimal v) => valoresOcultos ? 0m : Arredondamento.Arred2(v);
        var formas = finalizadas.SelectMany(v => v.Pagamentos)
            .GroupBy(p => p.Forma.Id)
            .Select(g => (Forma: g.First().Forma, Linha: new FormaResumo(g.First().Forma.Descricao, g.Count(), Valor(g.Sum(p => p.Valor)))))
            .OrderBy(f => ApuracaoCaixa.EhDinheiro(f.Forma) ? 0 : 1)
            .ThenBy(f => f.Linha.Descricao, StringComparer.Ordinal)
            .Select(f => f.Linha)
            .ToList();
        var doPeriodo = movimentos
            .Where(m => periodo.Contem(m.OcorridoEm) && m.Tipo is TiposMovimento.Sangria or TiposMovimento.Reforco)
            .ToList();
        var validos = doPeriodo.Where(m => !m.Cancelado).ToList();
        return new ResumoDiario(
            periodo,
            finalizadas.Count,
            Valor(finalizadas.Sum(v => v.Total)),
            formas,
            canceladas.Count,
            Arredondamento.Arred2(canceladas.Sum(v => v.Total)),
            finalizadas.Sum(v => v.QtdItensCancelados),
            Arredondamento.Arred2(finalizadas.Sum(v => v.TotalItensCancelados)),
            Arredondamento.Arred2(finalizadas.Sum(v => v.Descontos)),
            validos.Count(m => m.Tipo == TiposMovimento.Sangria),
            Valor(validos.Where(m => m.Tipo == TiposMovimento.Sangria).Sum(m => m.Valor)),
            validos.Count(m => m.Tipo == TiposMovimento.Reforco),
            Valor(validos.Where(m => m.Tipo == TiposMovimento.Reforco).Sum(m => m.Valor)),
            doPeriodo.Count - validos.Count,
            valoresOcultos);
    }
}
