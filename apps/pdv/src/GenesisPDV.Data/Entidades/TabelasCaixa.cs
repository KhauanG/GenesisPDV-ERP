using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas de movimento do caixa (modelo de dados 3.12.1–3.12.3, 3.12.6 e 4.3; Fase 1C, bloco C9): mesmas colunas e
// CHECKs da nuvem (migração 0012 da API; o EsquemaNuvemTests confere contra o Esquema.g.cs). As colunas que só a nuvem
// preenche (fechamento forçado, conta corrente, cancelamento da devolução avulsa) existem e ficam no padrão. Sobem pelos
// eventos `caixa.*` e `vasilhame.movimentado` (FabricaEventosCaixa, gravados pelo GravadorOutbox no mesmo commit).

/// <summary><c>sessoes_caixa</c> (3.12.1): sessão aberta = <c>status &lt;&gt; 'fechada'</c>, uma por terminal.</summary>
public class SessaoCaixaRegistro : LinhaMovimento
{
    public Guid LojaId { get; set; }
    public Guid CaixaId { get; set; }
    public short NumeroCaixa { get; set; }
    public Guid TerminalId { get; set; }
    public Guid OperadorId { get; set; }
    public string Status { get; set; } = StatusSessaoCaixa.Aberta;
    public DateOnly DiaOperacional { get; set; }
    public DateTimeOffset AbertaEm { get; set; }
    public bool AberturaAutomatica { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal FundoTroco { get; set; }

    /// <summary>Sessão de quem passou o caixa (troca de turno, 21.3); o <c>caixa.aberto</c> depende dela.</summary>
    public Guid? SessaoAnteriorId { get; set; }

    [Escala(Escalas.Dinheiro)] public decimal? ValorRecebidoAnterior { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? DiferencaRecebimento { get; set; }
    public DateTimeOffset? FechadaEm { get; set; }

    /// <summary>Só a nuvem fecha à força (substituição ou revogação do terminal, MD 3.12.1); aqui fica <c>false</c>.</summary>
    public bool FechamentoForcado { get; set; }

    public string? FechamentoForcadoMotivo { get; set; }
}

/// <summary>
/// <c>sessoes_caixa.status</c> (<c>ck_sessoes_caixa_status</c>). Na Fase 1C só <see cref="Aberta"/> e
/// <see cref="Fechada"/> são gravados (PDV 34.2): o bloqueio pelo limite de gaveta é calculado a cada venda nova
/// (<c>ServicoCaixa.Gaveta</c>, 20.4) e o fechamento em curso é o diálogo; os outros dois valores ficam pelo CHECK.
/// </summary>
public static class StatusSessaoCaixa
{
    public const string Aberta = "aberta";

    /// <summary>Conceitual (PDV 34.2): não gravado na 1C; o bloqueio é <c>LimiteGaveta.Avaliar</c>.</summary>
    public const string BloqueadaSangria = "bloqueada_sangria";

    /// <summary>Conceitual (PDV 34.2): não gravado na 1C; o fechamento em curso é o diálogo.</summary>
    public const string EmFechamento = "em_fechamento";
    public const string Fechada = "fechada";
}

/// <summary><c>movimentos_caixa</c> (3.12.2): abertura, reforço, sangria, sangria do fechamento e estornos.</summary>
public class MovimentoCaixaRegistro : LinhaMovimento
{
    public Guid SessaoCaixaId { get; set; }
    public Guid LojaId { get; set; }
    public Guid CaixaId { get; set; }
    public short NumeroCaixa { get; set; }
    public Guid TerminalId { get; set; }
    public string Tipo { get; set; } = TipoMovimentoCaixa.Abertura;
    public Guid? FormaPagamentoId { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal Valor { get; set; }
    public Guid OperadorId { get; set; }
    public Guid? QuemRetiraUsuarioId { get; set; }
    public string? QuemRetiraNome { get; set; }
    public string? Observacao { get; set; }
    public string? InfAdicionais { get; set; }
    public DateTimeOffset OcorridoEm { get; set; }
    public Guid? AutorizadoPorId { get; set; }
    public Guid? TrocaId { get; set; }
    public bool Cancelado { get; set; }
    public DateTimeOffset? CanceladoEm { get; set; }
    public Guid? CanceladoPorId { get; set; }
    public Guid? AutorizadoCancelamentoPorId { get; set; }
    public string? MotivoCancelamento { get; set; }

    /// <summary>Conta corrente do financeiro (Fase 4): só a nuvem preenche.</summary>
    public Guid? MovimentoContaCorrenteId { get; set; }
}

/// <summary><c>movimentos_caixa.tipo</c> (<c>ck_movimentos_caixa_tipo</c>).</summary>
public static class TipoMovimentoCaixa
{
    public const string Abertura = "abertura";
    public const string Reforco = "reforco";
    public const string Sangria = "sangria";
    public const string SangriaFechamento = "sangria_fechamento";
    public const string DevolucaoTroca = "devolucao_troca";
    public const string EstornoVenda = "estorno_venda";

    /// <summary>
    /// Os que se cancelam pelo caixa (<c>caixa.movimento_cancelado</c>, PDV 20.3): a nuvem recusa os outros com
    /// <c>TRANSICAO_INVALIDA</c>, que é permanente. Mesma lista do <c>MOVIMENTOS_CAIXA_CANCELAVEIS</c> do contrato
    /// (conferida no <c>ContratosEventosTests</c>).
    /// </summary>
    public static readonly IReadOnlySet<string> Cancelaveis = new HashSet<string>(StringComparer.Ordinal) { Reforco, Sangria };
}

/// <summary><c>fechamentos_caixa</c> (3.12.3): um por sessão (fechamento ou troca de turno).</summary>
public class FechamentoCaixaRegistro : LinhaMovimento
{
    public Guid SessaoCaixaId { get; set; }
    public Guid LojaId { get; set; }
    public Guid CaixaId { get; set; }
    public Guid TerminalId { get; set; }
    public short NumeroCaixa { get; set; }

    /// <summary><c>fechamento</c> (zera o caixa) ou <c>troca_turno</c> (passa a gaveta adiante).</summary>
    public string Tipo { get; set; } = "fechamento";

    public bool ZeraCaixa { get; set; }
    public Guid UsuarioAnteriorId { get; set; }
    public Guid? UsuarioSubsequenteId { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal ValorCaixa { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal TotalCalculado { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal TotalDigitado { get; set; }

    /// <summary><c>total_digitado − total_calculado</c>, calculada pelo SQLite como na nuvem (nunca gravada pelo código).</summary>
    [Escala(Escalas.Dinheiro)] public decimal Diferenca { get; set; }

    public string? Justificativa { get; set; }
    public bool Recontagem { get; set; }
    public bool FechamentoCego { get; set; }
    public DateTimeOffset OcorridoEm { get; set; }
    public DateOnly DiaOperacional { get; set; }

    /// <summary>Resumo do turno (SYNC 9.6) em JSON: sobe inteiro no <c>caixa.fechado</c>.</summary>
    public string Resumo { get; set; } = "{}";
}

/// <summary><c>fechamentos_caixa_formas</c> (3.12.3): o contado por forma de pagamento.</summary>
public class FechamentoCaixaFormaRegistro : LinhaMovimento
{
    public Guid FechamentoId { get; set; }
    public Guid FormaPagamentoId { get; set; }
    public string DescricaoForma { get; set; } = string.Empty;
    public string TipoForma { get; set; } = string.Empty;
    [Escala(Escalas.Dinheiro)] public decimal ValorCalculado { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal ValorDigitado { get; set; }

    /// <summary><c>valor_digitado − valor_calculado</c>, calculada pelo SQLite como na nuvem.</summary>
    [Escala(Escalas.Dinheiro)] public decimal Diferenca { get; set; }

    public int QuantidadePagamentos { get; set; }
    public bool PreenchidoAutomatico { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? ValorPrimeiraContagem { get; set; }
}

/// <summary><c>movimentos_vasilhame</c> (3.12.6): devolução avulsa de cascos (F11 › V); na 1C só o destino <c>entrada</c>.</summary>
public class MovimentoVasilhameRegistro : LinhaMovimento
{
    public Guid SessaoCaixaId { get; set; }
    public Guid LojaId { get; set; }
    public Guid CaixaId { get; set; }
    public Guid TerminalId { get; set; }
    public Guid OperadorId { get; set; }
    public Guid? PessoaId { get; set; }
    public Guid ProdutoVasilhameId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal Quantidade { get; set; }

    /// <summary><c>entrada</c>, <c>baixa_comodato</c> ou <c>vale</c> (os dois últimos na Fase 3).</summary>
    public string Destino { get; set; } = "entrada";

    public Guid? ValeId { get; set; }
    public DateTimeOffset OcorridoEm { get; set; }

    /// <summary>O cancelamento da devolução avulsa não tem evento na 1C: as colunas existem e ficam no padrão.</summary>
    public bool Cancelado { get; set; }

    public DateTimeOffset? CanceladoEm { get; set; }
    public Guid? CanceladoPorId { get; set; }
    public string? MotivoCancelamento { get; set; }
}
