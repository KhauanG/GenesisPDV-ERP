namespace GenesisPDV.Core.Vendas;

/// <summary>
/// Evento a gravar no outbox (<c>eventos_saida</c>) na mesma transação do fato, pelo <c>GravadorOutbox</c> (Fase 1C, C9):
/// a <c>sequencia_terminal</c>, a hora do envelope (corrigida e monotônica a partir de <see cref="OcorridoEm"/>), o
/// relógio e o contexto são atribuídos dentro da transação.
/// </summary>
/// <param name="OcorridoEm">Hora do fato, a mesma do payload (já pelo relógio corrigido do caixa).</param>
public sealed record EventoParaOutbox(
    Guid Id,
    string Tipo,
    int VersaoSchema,
    string AgregadoTipo,
    Guid AgregadoId,
    DateTimeOffset OcorridoEm,
    string Payload,
    string PayloadSha256)
{
    /// <summary>Quem executou o fato (envelope <c>usuario_id</c>); o supervisor que liberou fica no payload.</summary>
    public Guid? UsuarioId { get; init; }

    /// <summary>Sessão de caixa do fato (envelope <c>contexto.sessao_caixa_id</c>).</summary>
    public Guid? SessaoCaixaId { get; init; }

    /// <summary>Agregados deste terminal que precisam estar aplicados antes (SYNC 8.5): a sessão, o movimento.</summary>
    public IReadOnlyList<DependenciaOutbox> Dependencias { get; init; } = [];
}

/// <summary>Item de <c>dependencias</c> do envelope (SYNC 7.3): <c>{agregado_tipo, agregado_id}</c>.</summary>
public sealed record DependenciaOutbox(string AgregadoTipo, Guid AgregadoId)
{
    public static DependenciaOutbox Sessao(Guid sessaoCaixaId) => new("sessao_caixa", sessaoCaixaId);
}

/// <summary>
/// Linha de <c>log_auditoria_local</c> gravada no mesmo commit da mudança da venda ou do caixa (PDV 32.1).
/// <paramref name="Motivo"/>: o da liberação do supervisor (31.3; sobe em <c>depois.motivo</c> no lote de auditoria).
/// <paramref name="Antes"/>/<paramref name="Depois"/>: JSON do valor mudado (o desconto liberado, como na SYNC 9.22).
/// </summary>
public sealed record RegistroAuditoria(
    string Acao,
    Guid? UsuarioId,
    string? Entidade = null,
    Guid? RegistroId = null,
    string? Descricao = null,
    Guid? AutorizadoPorId = null,
    string? Localizacao = "pdv.venda",
    string? Motivo = null,
    string? Antes = null,
    string? Depois = null);

/// <summary>Persistência da venda no banco local. Cada chamada é uma transação comitada (PDV 32.3).</summary>
public interface IRepositorioVendas
{
    /// <summary>Reserva o próximo número de venda do caixa (<c>sequencias_locais['venda']</c>); nunca volta.</summary>
    Task<long> ReservarNumeroVendaAsync(CancellationToken ct = default);

    /// <summary>Grava a venda em andamento (cabeçalho, itens, pagamentos, auditoria) e marca como venda atual da tela.</summary>
    Task SalvarEmAndamentoAsync(Venda venda, RegistroAuditoria? auditoria = null, CancellationToken ct = default);

    /// <summary>
    /// Como o anterior, com várias linhas de auditoria no mesmo commit (o desconto liberado grava o <c>desconto_*</c> e a
    /// <c>liberacao</c>, PDV 31.3).
    /// </summary>
    Task SalvarEmAndamentoAsync(Venda venda, IReadOnlyList<RegistroAuditoria> auditoria, CancellationToken ct = default);

    /// <summary>Venda que estava na tela (<c>estado_operacao.venda_atual_id</c>) se ainda estiver aberta.</summary>
    Task<Venda?> ObterVendaAtualAsync(CancellationToken ct = default);

    /// <summary>Qualquer venda gravada, como está no banco (F12 Gestão de vendas, reimpressão e cancelamento; PDV 22).</summary>
    Task<Venda?> ObterAsync(Guid id, CancellationToken ct = default);

    /// <summary>
    /// Snapshots da primeira inclusão dos produtos da venda (<c>produtos_venda_snapshot</c>, gravados com a venda), para
    /// a recuperação após queda não usar o espelho atual (PDV 11.3.1, 32.3).
    /// </summary>
    Task<IReadOnlyList<ProdutoRegistrado>> ObterSnapshotsAsync(Guid vendaId, CancellationToken ct = default);

    /// <summary>
    /// Grava a venda finalizada/cancelada, o evento do outbox e a auditoria num único commit; libera a tela. Sem
    /// <paramref name="evento"/> (venda em andamento cancelada no terminal real da Fase 1B, D18) nada vai para o outbox e
    /// a sequência devolvida é 0.
    /// </summary>
    Task<long> EncerrarAsync(Venda venda, EventoParaOutbox? evento, RegistroAuditoria? auditoria = null, CancellationToken ct = default);
}
