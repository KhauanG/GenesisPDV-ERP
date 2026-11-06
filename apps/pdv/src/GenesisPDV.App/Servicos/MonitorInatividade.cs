namespace GenesisPDV.App.Servicos;

/// <summary>
/// Quanto tempo a janela do caixa está sem uso (Central do PDV, bloco G11; PDV 7.4; PC-13): a janela avisa toda tecla,
/// clique, roda ou movimento do mouse (<see cref="RegistrarAtividade"/>) e o bloqueio por inatividade compara
/// <see cref="Ociosidade"/> com o <c>tela.bloqueio_inatividade_min</c>. Medido pelo relógio <b>monotônico</b>
/// (<see cref="TimeProvider.GetTimestamp"/>, como a liberação da Central): acertar a hora do Windows não bloqueia a tela
/// nem a impede de bloquear. O leitor de código de barras digita como teclado, então também conta como uso.
/// </summary>
public sealed class MonitorInatividade(TimeProvider? tempo = null)
{
    private readonly TimeProvider _tempo = tempo ?? TimeProvider.System;
    private long _ultimaAtividade = (tempo ?? TimeProvider.System).GetTimestamp();

    /// <summary>Tempo desde a última tecla ou mouse na janela (ou desde o app abrir).</summary>
    public TimeSpan Ociosidade => _tempo.GetElapsedTime(Interlocked.Read(ref _ultimaAtividade));

    public void RegistrarAtividade() => Interlocked.Exchange(ref _ultimaAtividade, _tempo.GetTimestamp());
}

/// <summary>
/// As ações e os textos do bloqueio da tela (PDV 7.4; Central do PDV, bloco G11; README › decisão 75). O
/// <see cref="AcaoBloqueio"/> já está no catálogo da nuvem e sobe no lote, com a entidade <see cref="Entidade"/> (no ERP,
/// <c>bloqueio</c> também é o da conta bloqueada por tentativas, de <c>usuarios</c>); o <see cref="AcaoDesbloqueio"/> pelo
/// PIN do próprio operador fica <b>só local</b> (fora do <c>CatalogosNuvem.AcoesAuditoria</c>, como o
/// <c>central_acessada</c>): o <c>OutboxSync</c> não o põe no lote e nada depende da nuvem conhecer a ação. O desbloqueio
/// pelo <b>supervisor</b> (a sessão de outra pessoa reaberta com o PIN dele) grava a <c>liberacao</c>, já no catálogo:
/// sobe, com o supervisor no <c>autorizado_por_id</c>, como as outras liberações. O PIN recusado grava o
/// <c>login_negado</c> (sobe e vira <c>historico_logins</c>), como o login e a Central.
/// </summary>
public static class BloqueioTela
{
    public const string AcaoBloqueio = "bloqueio";
    public const string AcaoDesbloqueio = "desbloqueio";

    /// <summary>O desbloqueio pelo supervisor (já no catálogo da nuvem; sobe).</summary>
    public const string AcaoLiberacao = "liberacao";

    /// <summary>A entidade das auditorias da tela bloqueada (no lote, no lugar do "pdv" genérico).</summary>
    public const string Entidade = "tela_pdv";

    /// <summary>Bloqueada sozinha, depois do <c>tela.bloqueio_inatividade_min</c> sem uso.</summary>
    public const string ComoInatividade = "inatividade";

    /// <summary>Bloqueada pelo operador (F11 › 7 ou Ctrl+Alt+B).</summary>
    public const string ComoManual = "manual";

    /// <summary>Desbloqueada com o PIN do próprio operador.</summary>
    public const string PeloPin = "pin";

    /// <summary>Desbloqueada pelo supervisor (usuário e PIN de quem tem <c>pdv.supervisor</c>; PDV 7.4).</summary>
    public const string PeloSupervisor = "supervisor";

    public const string Localizacao = "pdv.venda";
}
