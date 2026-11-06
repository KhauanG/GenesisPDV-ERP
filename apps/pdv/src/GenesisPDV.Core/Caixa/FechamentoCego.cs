using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Numeros;

namespace GenesisPDV.Core.Caixa;

/// <summary>
/// Regras do fechamento (PDV 21.2–21.4; chaves <c>pdv.*</c> da nuvem, MD 3.1.2). O padrão é o da decisão O3 do dono
/// (31/10/2026), mais rígida que a especificação: o operador conta por forma sem ver o esperado, <b>ninguém</b> vê
/// Calculado × Contado × Diferença no PDV (nem o supervisor), não há recontagem e o relatório impresso não traz o
/// esperado — só o gerente vê, no ERP. A diferença não bloqueia o fechamento.
/// <para>
/// <see cref="MostraConferencia"/> (<c>pdv.fechamento_mostra_conferencia</c>, padrão desligado) devolve o fluxo da
/// especificação: depois de contar, a conferência aparece, a diferença em dinheiro acima da tolerância exige
/// justificativa e a recontagem (uma vez) vale com <see cref="PermiteRecontagem"/>; durante a contagem só quem tem
/// <c>pdv.caixa.ver_calculado_fechamento</c> vê o calculado. Sem a conferência a justificativa é opcional e sempre
/// oferecida: pedi-la só quando há diferença contaria ao operador que a contagem não bateu.
/// </para>
/// </summary>
public sealed record RegrasFechamento(
    bool FechamentoCego = true,
    decimal Tolerancia = 0m,
    bool PermiteRecontagem = false,
    bool ImprimeCalculado = false,
    bool MostraConferencia = false)
{
    public static RegrasFechamento PadraoDono { get; } = new();

    /// <summary>Calculado visível durante a contagem: fechamento não cego, ou conferência ligada e a permissão.</summary>
    public bool VeCalculadoNaContagem(bool temPermissao) => !FechamentoCego || (MostraConferencia && temPermissao);

    /// <summary>Passo 2 (Calculado × Digitado × Diferença) depois de contar.</summary>
    public bool TemConferencia => MostraConferencia || !FechamentoCego;

    /// <summary>Relatório com o calculado: quem viu na tela, ou a chave <c>pdv.imprime_calculado_no_fechamento</c>.</summary>
    public bool ImprimeCalculadoNoRelatorio(bool temPermissao) => ImprimeCalculado || VeCalculadoNaContagem(temPermissao);
}

/// <summary>O que o operador digitou numa forma (e o da primeira contagem, se recontou).</summary>
public sealed record FormaContada(FormaApurada Apurada, decimal Digitado, decimal? PrimeiraContagem)
{
    public decimal Diferenca => Digitado - Apurada.Calculado;
}

/// <summary>Resultado confirmado: vira <c>fechamentos_caixa</c> e <c>fechamentos_caixa_formas</c>.</summary>
public sealed record FechamentoConferido(
    IReadOnlyList<FormaContada> Formas,
    bool ZeraCaixa,
    string? Justificativa,
    bool Recontagem,
    bool FechamentoCego)
{
    public decimal TotalCalculado => Formas.Sum(f => f.Apurada.Calculado);

    public decimal TotalDigitado => Formas.Sum(f => f.Digitado);

    /// <summary>O dinheiro contado (a primeira linha, a de Dinheiro).</summary>
    public decimal DinheiroDigitado => Formas[0].Digitado;

    /// <summary>"Valor de Caixa" (21.2): o dinheiro que fica na gaveta para o próximo turno; 0 quando zera.</summary>
    public decimal ValorCaixa => ZeraCaixa ? 0m : DinheiroDigitado;
}

/// <summary>Etapas do fechamento cego (21.2).</summary>
public enum EtapaFechamento
{
    /// <summary>Passo 1: o operador digita o contado por forma.</summary>
    Contagem,

    /// <summary>Passo 2: Calculado × Digitado × Diferença (só com a conferência ligada).</summary>
    Conferencia,

    /// <summary>Contagem informada sem conferência: falta só confirmar.</summary>
    Pronto,

    /// <summary>Passo 3 feito: o fechamento foi gravado (<see cref="FechamentoCego.MarcarConfirmado"/>).</summary>
    Confirmado,
}

/// <summary>
/// Fluxo do fechamento cego (PDV 21.2, passos 1–3) como máquina de estados pura: contagem por forma, conferência (só com
/// <see cref="RegrasFechamento.TemConferencia"/>), recontagem uma vez e confirmação. Valores digitados: ≥ 0,00 e até R$
/// 9.999.999,99; vazio = 0,00. A tela nunca lê o calculado sem <see cref="CalculadoVisivel"/>.
/// </summary>
public sealed class FechamentoCego
{
    public const decimal ValorMaximo = 9_999_999.99m;
    public const int JustificativaMaxima = 255;
    public const string MensagemJustificativa = "Diferença no dinheiro acima da tolerância: informe a justificativa.";

    private readonly ResultadoApuracao _apuracao;
    private Dictionary<Guid, decimal> _contagem = [];
    private Dictionary<Guid, decimal>? _primeira;

    public FechamentoCego(ResultadoApuracao apuracao, RegrasFechamento regras, bool podeVerCalculado)
    {
        ArgumentNullException.ThrowIfNull(apuracao);
        ArgumentNullException.ThrowIfNull(regras);
        if (apuracao.Formas.Count == 0 || !ApuracaoCaixa.EhDinheiro(apuracao.Formas[0].Forma))
        {
            throw new ArgumentException("A apuração começa pela forma Dinheiro.", nameof(apuracao));
        }

        _apuracao = apuracao;
        Regras = regras;
        CalculadoVisivel = regras.VeCalculadoNaContagem(podeVerCalculado);
        ImprimeCalculado = regras.ImprimeCalculadoNoRelatorio(podeVerCalculado);
    }

    public RegrasFechamento Regras { get; }

    public EtapaFechamento Etapa { get; private set; } = EtapaFechamento.Contagem;

    /// <summary>A tela pode mostrar o calculado já na contagem (fechamento não cego ou permissão com conferência).</summary>
    public bool CalculadoVisivel { get; }

    /// <summary>O relatório impresso traz o calculado e a diferença.</summary>
    public bool ImprimeCalculado { get; }

    public IReadOnlyList<FormaApurada> Formas => _apuracao.Formas;

    public bool Recontou => _primeira is not null;

    public bool PodeRecontar => Etapa == EtapaFechamento.Conferencia && Regras.PermiteRecontagem && !Recontou;

    /// <summary>Diferença em dinheiro acima da tolerância (só significa algo na conferência).</summary>
    public bool DiferencaDinheiroAcimaDaTolerancia =>
        Math.Abs(Digitado(Formas[0].Forma.Id) - Formas[0].Calculado) > Regras.Tolerancia;

    /// <summary>Justificativa obrigatória: só quando o operador viu a conferência (sem ela, pedir revelaria a diferença).</summary>
    public bool ExigeJustificativa => Regras.TemConferencia && DiferencaDinheiroAcimaDaTolerancia;

    /// <summary>
    /// Passo 1: grava a contagem (forma → valor; ausente = 0,00). Com conferência vai ao passo 2; sem ela, fica
    /// <see cref="EtapaFechamento.Pronto"/> para a confirmação (passo 3), e a contagem ainda pode ser corrigida.
    /// </summary>
    public void Contar(IReadOnlyDictionary<Guid, decimal> valores)
    {
        ArgumentNullException.ThrowIfNull(valores);
        // Sem conferência, a tela pode corrigir a contagem até confirmar (nada foi mostrado ao operador).
        if (Etapa is not (EtapaFechamento.Contagem or EtapaFechamento.Pronto))
        {
            throw new InvalidOperationException("A contagem já foi informada.");
        }

        var contagem = new Dictionary<Guid, decimal>();
        foreach (var forma in Formas)
        {
            var valor = valores.TryGetValue(forma.Forma.Id, out var v) ? v : 0m;
            if (valor < 0m || valor > ValorMaximo || !Arredondamento.CabeEm(valor, Arredondamento.CasasDinheiro))
            {
                throw new RegraNegocioException($"Valor contado inválido em {forma.Forma.Descricao}: informe de 0,00 a 9.999.999,99.");
            }

            contagem[forma.Forma.Id] = valor;
        }

        if (valores.Keys.Any(id => Formas.All(f => f.Forma.Id != id)))
        {
            throw new InvalidOperationException("Forma contada fora da lista do fechamento.");
        }

        _contagem = contagem;
        Etapa = Regras.TemConferencia ? EtapaFechamento.Conferencia : EtapaFechamento.Pronto;
    }

    /// <summary>Volta da conferência para recontar, uma vez (<c>pdv.permite_recontagem</c>): a primeira contagem fica.</summary>
    public void Recontar()
    {
        if (!PodeRecontar)
        {
            throw new RegraNegocioException("A recontagem não está disponível.");
        }

        _primeira = _contagem;
        _contagem = [];
        Etapa = EtapaFechamento.Contagem;
    }

    public decimal Digitado(Guid formaId) => _contagem.GetValueOrDefault(formaId);

    /// <summary>
    /// Passo 3: monta o fechamento a gravar, sem mudar a etapa. A justificativa (até 255, sem os espaços das pontas;
    /// vazia = nula) é obrigatória só com <see cref="ExigeJustificativa"/>. Se a gravação recusar (venda aberta,
    /// desativação em confirmação, tipo não anunciado), a máquina continua na conferência ou pronta, e o operador repete a
    /// confirmação sem recontar; só depois de gravado a tela chama <see cref="MarcarConfirmado"/>.
    /// </summary>
    public FechamentoConferido Confirmar(bool zeraCaixa, string? justificativa)
    {
        if (Etapa is not (EtapaFechamento.Conferencia or EtapaFechamento.Pronto))
        {
            throw new InvalidOperationException("Informe a contagem antes de confirmar.");
        }

        var texto = string.IsNullOrWhiteSpace(justificativa) ? null : justificativa.Trim();
        if (texto is { Length: > JustificativaMaxima })
        {
            throw new RegraNegocioException($"A justificativa tem no máximo {JustificativaMaxima} caracteres.");
        }

        if (texto is null && ExigeJustificativa)
        {
            throw new RegraNegocioException(MensagemJustificativa);
        }

        var formas = Formas
            .Select(f => new FormaContada(f, Digitado(f.Forma.Id), _primeira is null ? null : _primeira.GetValueOrDefault(f.Forma.Id)))
            .ToList();
        return new FechamentoConferido(formas, zeraCaixa, texto, Recontou, Regras.FechamentoCego);
    }

    /// <summary>O fechamento confirmado foi gravado: nada mais se conta, reconta ou confirma.</summary>
    public void MarcarConfirmado()
    {
        if (Etapa is not (EtapaFechamento.Conferencia or EtapaFechamento.Pronto))
        {
            throw new InvalidOperationException("Informe a contagem antes de confirmar.");
        }

        Etapa = EtapaFechamento.Confirmado;
    }
}
