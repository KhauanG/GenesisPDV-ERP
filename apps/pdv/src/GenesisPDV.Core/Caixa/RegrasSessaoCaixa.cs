using System.Globalization;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Caixa;

/// <summary>Situação da sessão aberta para a tela de venda (PDV 8.1).</summary>
public enum SituacaoSessao
{
    Normal,

    /// <summary>Aberta há mais de <c>pdv.horas_alerta_sessao</c> ou de dia operacional anterior: faixa amarela.</summary>
    Alerta,

    /// <summary>De dia operacional anterior com <c>pdv.bloqueia_sessao_dia_anterior</c>: nenhuma venda nova até fechar.</summary>
    Bloqueada,
}

/// <param name="Mensagem">"Caixa aberto desde 28/10 08:02 — faça o fechamento" (nulo quando normal).</param>
public sealed record AvaliacaoSessao(SituacaoSessao Situacao, string? Mensagem);

/// <summary>
/// Regras da sessão de caixa (PDV 8.1–8.2, 21.3; Fase 1C, bloco C10a): fundo de troco, diferença de recebimento na troca
/// de turno e o alerta da sessão antiga. Puras: o App lê as chaves e grava pelo <c>RepositorioCaixa</c>.
/// </summary>
public static class RegrasSessaoCaixa
{
    public const decimal FundoMaximo = 99_999.99m;
    public const int HorasAlertaPadrao = 24;
    public const string MensagemFundoInvalido = "Informe o fundo de troco: de 0,00 a 99.999,99.";

    /// <summary>Fundo de troco ≥ 0,00, até R$ 99.999,99 e em centavos (8.2).</summary>
    public static decimal ValidarFundo(decimal fundo) =>
        fundo is >= 0m and <= FundoMaximo && Arredondamento.CabeEm(fundo, Arredondamento.CasasDinheiro)
            ? fundo
            : throw new RegraNegocioException(MensagemFundoInvalido);

    /// <summary>
    /// <c>sessoes_caixa.diferenca_recebimento</c> (8.2, 21.3): <c>fundo_troco − valor_recebido_anterior</c> quando o caixa
    /// veio de uma troca de turno; nulo sem turno anterior.
    /// </summary>
    public static decimal? DiferencaRecebimento(decimal fundo, decimal? valorRecebidoAnterior) =>
        valorRecebidoAnterior is { } recebido ? fundo - recebido : null;

    /// <summary>
    /// Sessão antiga (8.1): aberta há mais de <paramref name="horasAlerta"/> horas ou de dia operacional anterior ao de
    /// agora gera o alerta; com <paramref name="bloqueiaDiaAnterior"/>, a de dia anterior bloqueia a venda nova (a venda
    /// em andamento termina). O dono manteve o padrão (O1b: continua vendendo, com alerta depois de 24 h).
    /// </summary>
    public static AvaliacaoSessao Avaliar(
        DateTimeOffset abertaEm,
        DateOnly diaOperacionalSessao,
        DateTimeOffset agora,
        TimeZoneInfo fuso,
        TimeOnly horaCorte,
        int horasAlerta,
        bool bloqueiaDiaAnterior)
    {
        ArgumentNullException.ThrowIfNull(fuso);
        var diaAnterior = diaOperacionalSessao < DiaOperacional.Calcular(agora, fuso, horaCorte);
        var antiga = agora - abertaEm > TimeSpan.FromHours(horasAlerta > 0 ? horasAlerta : HorasAlertaPadrao);
        if (!diaAnterior && !antiga)
        {
            return new AvaliacaoSessao(SituacaoSessao.Normal, null);
        }

        var desde = TimeZoneInfo.ConvertTime(abertaEm, fuso).ToString("dd/MM HH:mm", CultureInfo.InvariantCulture);
        return diaAnterior && bloqueiaDiaAnterior
            ? new AvaliacaoSessao(SituacaoSessao.Bloqueada,
                $"Caixa aberto desde {desde}, de um dia anterior: feche o caixa (F11 › 3) e abra de novo para vender.")
            : new AvaliacaoSessao(SituacaoSessao.Alerta, $"Caixa aberto desde {desde} — faça o fechamento.");
    }
}

/// <summary>
/// "F2 Contar cédulas" (PDV 8.2, 21.2): quantidade por cédula e moeda; a soma preenche o campo e o detalhamento sobe no
/// <c>contagem_cedulas</c> do evento (a nuvem guarda na auditoria <c>caixa_contagem_cedulas</c>).
/// </summary>
public static class ContagemCedulas
{
    public static readonly IReadOnlyList<decimal> Valores = [200m, 100m, 50m, 20m, 10m, 5m, 2m, 1m, 0.50m, 0.25m, 0.10m, 0.05m];

    public const int QuantidadeMaxima = 99_999;

    /// <summary>Só as cédulas e moedas com quantidade &gt; 0; quantidade negativa ou fora da lista é recusada.</summary>
    public static IReadOnlyDictionary<decimal, int> Normalizar(IReadOnlyDictionary<decimal, int> quantidades)
    {
        ArgumentNullException.ThrowIfNull(quantidades);
        var resultado = new SortedDictionary<decimal, int>(Comparer<decimal>.Create((a, b) => b.CompareTo(a)));
        foreach (var (valor, quantidade) in quantidades)
        {
            if (!Valores.Contains(valor))
            {
                throw new RegraNegocioException($"Cédula ou moeda desconhecida: {NumeroBr.Dinheiro(valor)}.");
            }

            if (quantidade is < 0 or > QuantidadeMaxima)
            {
                throw new RegraNegocioException($"Quantidade inválida para {NumeroBr.Dinheiro(valor)}.");
            }

            if (quantidade > 0)
            {
                resultado[valor] = quantidade;
            }
        }

        return resultado;
    }

    public static decimal Somar(IReadOnlyDictionary<decimal, int> quantidades)
    {
        ArgumentNullException.ThrowIfNull(quantidades);
        return Arredondamento.Arred2(quantidades.Sum(q => q.Key * q.Value));
    }
}
