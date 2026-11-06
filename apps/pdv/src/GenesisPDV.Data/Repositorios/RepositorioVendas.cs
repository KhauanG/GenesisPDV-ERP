using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Outbox;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Venda no SQLite: cada operação é um commit antes de a tela mudar (PDV 32.3); a finalização grava venda e evento do
/// outbox no mesmo commit (ADR-08), pelo <see cref="GravadorOutbox"/> (Fase 1C, C9): envelope com a hora corrigida, o
/// operador, a sessão e a dependência dela, e <c>vendas.relogio_confiavel</c> igual ao do envelope (T5). Sem gravador
/// (testes do Data), o relógio do envelope é o <paramref name="relogio"/>, sem desvio.
/// </summary>
public sealed class RepositorioVendas(IDbContextFactory<PdvDbContext> fabrica, IRelogio relogio, GravadorOutbox? gravador = null) : IRepositorioVendas
{
    private readonly GravadorOutbox _gravador = gravador ?? new GravadorOutbox(new RelogioOutboxLocal(relogio));

    /// <summary>
    /// Mensagem da recusa de nova venda com o terminal em desativação ou desativado (SYNC 3.8): a partir do commit do
    /// <c>desativando</c>, nenhum número de venda é reservado.
    /// </summary>
    public const string MensagemTerminalDesativando = "Terminal em desativação pelo ERP: novas vendas não são permitidas.";

    /// <summary>
    /// A venda é da sessão de caixa aberta neste terminal (Fase 1C, C11a; SYNC 8.5): a venda de uma sessão fechada
    /// subiria dependendo de um <c>caixa.fechado</c> já aplicado, e a nuvem a aceitaria fora do fechamento contado.
    /// </summary>
    public const string MensagemSessaoDaVendaFechada =
        "A sessão de caixa desta venda não está mais aberta neste terminal: abra o caixa de novo e refaça a venda.";

    public async Task<long> ReservarNumeroVendaAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        // Conferido dentro da transação da reserva (SYNC 3.8): o `desativando` gravado pelo ciclo online vale já.
        if (await db.IdentidadeTerminal.AsNoTracking().AnyAsync(i => i.Status != StatusIdentidade.Ativo, ct))
        {
            throw new RegraNegocioException(MensagemTerminalDesativando);
        }

        // Modo restaurado (SYNC 22.1; C17): restaurado e sem o handshake online, a primeira reserva salta +1000.
        await Backup.SaltoNumeracao.AplicarOfflineSePendenteAsync(db, relogio.Agora, ct);
        var numero = await ProximoValorAsync(db, SequenciaLocal.Venda, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return numero;
    }

    public Task SalvarEmAndamentoAsync(Venda venda, RegistroAuditoria? auditoria = null, CancellationToken ct = default) =>
        SalvarEmAndamentoAsync(venda, auditoria is null ? [] : [auditoria], ct);

    public async Task SalvarEmAndamentoAsync(Venda venda, IReadOnlyList<RegistroAuditoria> auditoria, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(venda);
        ArgumentNullException.ThrowIfNull(auditoria);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await GravarAsync(db, venda, ct);
        await GravarSnapshotsAsync(db, venda, ct);
        foreach (var registro in auditoria)
        {
            AdicionarAuditoria(db, registro, venda.SessaoCaixaId);
        }

        var estado = await ObterEstadoOperacaoAsync(db, ct);
        estado.VendaAtualId = venda.Aberta ? venda.Id : null;
        estado.OperadorId = venda.OperadorId;
        estado.Modo = venda.Status == StatusVenda.EmPagamento ? "pagamento" : "balcao";
        estado.AtualizadoEm = relogio.Agora;
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
    }

    public async Task<Venda?> ObterVendaAtualAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var estado = await db.EstadoOperacao.AsNoTracking().FirstOrDefaultAsync(ct);
        if (estado?.VendaAtualId is not { } id)
        {
            return null;
        }

        var registro = await CarregarAsync(db, id, rastrear: false, ct);
        return registro is not null && StatusVenda.Aberta(registro.Status)
            ? MapeadorVenda.ParaDominio(
                registro, await LiberacoesAsync(db, id, ct), await CobrancasAsync(db, id, ct), await FormasAsync(db, registro, ct),
                await CascosDescontadosAsync(db, id, ct))
            : null;
    }

    public async Task<Venda?> ObterAsync(Guid id, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var registro = await CarregarAsync(db, id, rastrear: false, ct);
        return registro is null
            ? null
            : MapeadorVenda.ParaDominio(
                registro, await LiberacoesAsync(db, id, ct), await CobrancasAsync(db, id, ct), await FormasAsync(db, registro, ct),
                await CascosDescontadosAsync(db, id, ct));
    }

    public async Task<long> EncerrarAsync(Venda venda, EventoParaOutbox? evento, RegistroAuditoria? auditoria = null, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(venda);
        if (venda.Aberta)
        {
            throw new InvalidOperationException("Só venda finalizada ou cancelada é encerrada.");
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        // Só com evento: o cancelamento sem evento (venda fora da sessão aberta, T13) tira a venda da tela mesmo com a
        // sessão dela fechada, em vez de prender o caixa.
        if (evento is not null && venda.SessaoCaixaId is { } sessaoId
            && !await db.SessoesCaixa.AsNoTracking().AnyAsync(s => s.Id == sessaoId && s.Status != StatusSessaoCaixa.Fechada && s.ExcluidoEm == null, ct))
        {
            throw new RegraNegocioException(MensagemSessaoDaVendaFechada);
        }

        await GravarAsync(db, venda, ct);
        AdicionarAuditoria(db, auditoria, venda.SessaoCaixaId);

        // Venda encerrada não é mais recuperada: o snapshot da primeira inclusão já não é necessário.
        await db.ProdutosVendaSnapshot.Where(s => s.VendaId == venda.Id).ExecuteDeleteAsync(ct);
        long sequencia = 0;
        if (evento is not null)
        {
            var gravado = await _gravador.GravarAsync(db, evento, ct);
            sequencia = gravado.Sequencia;
            // T5: a venda finalizada sem hora confiável fica marcada (a nuvem lê o mesmo do envelope).
            db.Vendas.Local.Single(v => v.Id == venda.Id).RelogioConfiavel = gravado.Hora.Confiavel;
        }

        var estado = await ObterEstadoOperacaoAsync(db, ct);
        if (estado.VendaAtualId == venda.Id)
        {
            estado.VendaAtualId = null;
        }

        estado.Modo = "balcao";
        estado.AtualizadoEm = relogio.Agora;
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return sequencia;
    }

    public async Task<IReadOnlyList<ProdutoRegistrado>> ObterSnapshotsAsync(Guid vendaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linhas = await db.ProdutosVendaSnapshot.AsNoTracking().Where(s => s.VendaId == vendaId).ToListAsync(ct);
        return linhas.Select(l => new ProdutoRegistrado(SnapshotProdutoJson.Desserializar(l.Dados), l.PromocaoVigente)).ToList();
    }

    /// <summary>Snapshot da primeira inclusão de cada produto (PDV 11.3): grava os novos e os que mudaram (embalagem lida depois).</summary>
    private async Task GravarSnapshotsAsync(PdvDbContext db, Venda venda, CancellationToken ct)
    {
        if (!venda.Aberta)
        {
            return;
        }

        var gravados = await db.ProdutosVendaSnapshot.Where(s => s.VendaId == venda.Id).ToDictionaryAsync(s => s.ProdutoId, ct);
        foreach (var (produtoId, registrado) in venda.Snapshots)
        {
            var dados = SnapshotProdutoJson.Serializar(registrado.Produto);
            if (gravados.TryGetValue(produtoId, out var linha))
            {
                if (linha.Dados != dados || linha.PromocaoVigente != registrado.PromocaoVigente)
                {
                    linha.Dados = dados;
                    linha.PromocaoVigente = registrado.PromocaoVigente;
                }

                continue;
            }

            db.ProdutosVendaSnapshot.Add(new ProdutoVendaSnapshot
            {
                VendaId = venda.Id,
                ProdutoId = produtoId,
                PromocaoVigente = registrado.PromocaoVigente,
                Dados = dados,
                RegistradoEm = relogio.Agora,
            });
        }
    }

    /// <param name="sessaoCaixaId">A sessão da venda (o <c>sessao_caixa_id</c> do registro no lote de auditoria, 9.22).</param>
    private void AdicionarAuditoria(PdvDbContext db, RegistroAuditoria? auditoria, Guid? sessaoCaixaId)
    {
        if (auditoria is null)
        {
            return;
        }

        db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
        {
            Id = IdGerador.Novo(),
            OcorridoEm = relogio.Agora,
            UsuarioId = auditoria.UsuarioId,
            AutorizadoPorId = auditoria.AutorizadoPorId,
            Acao = auditoria.Acao,
            Entidade = auditoria.Entidade,
            RegistroId = auditoria.RegistroId,
            Localizacao = auditoria.Localizacao,
            Descricao = auditoria.Descricao,
            Motivo = auditoria.Motivo,
            Antes = auditoria.Antes,
            Depois = auditoria.Depois,
            SessaoCaixaId = sessaoCaixaId,
        });
    }

    private async Task GravarAsync(PdvDbContext db, Venda venda, CancellationToken ct)
    {
        var registro = await CarregarAsync(db, venda.Id, rastrear: true, ct);
        if (registro is null)
        {
            registro = new VendaRegistro();
            MapeadorVenda.CopiarPara(venda, registro, relogio.Agora);
            db.Vendas.Add(registro);
        }
        else
        {
            if (!StatusVenda.Aberta(registro.Status))
            {
                throw new InvalidOperationException($"Venda {registro.NumeroExibicao} já está {registro.Status} e é imutável.");
            }

            var itensAntes = registro.Itens.Select(i => i.Id).ToHashSet();
            var pagamentosAntes = registro.Pagamentos.Select(p => p.Id).ToHashSet();
            MapeadorVenda.CopiarPara(venda, registro, relogio.Agora);
            foreach (var novo in registro.Itens.Where(i => !itensAntes.Contains(i.Id)))
            {
                db.ItensVenda.Add(novo);
            }

            foreach (var novo in registro.Pagamentos.Where(p => !pagamentosAntes.Contains(p.Id)))
            {
                db.PagamentosVenda.Add(novo);
            }
        }

        // Liberação é só acréscimo (a desfeita no Core nunca chegou a ser gravada): grava as que ainda não estão.
        var gravadas = (await db.LiberacoesVenda.Where(l => l.VendaId == venda.Id).Select(l => l.Id).ToListAsync(ct)).ToHashSet();
        foreach (var liberacao in venda.Liberacoes.Where(l => !gravadas.Contains(l.Id)))
        {
            db.LiberacoesVenda.Add(MapeadorVenda.ParaLinha(venda.Id, liberacao));
        }

        // Cascos descontados (C11c): espelham a lista do Core — a quantidade muda, e o desconto tirado (quantidade 0) sai.
        var cascos = await db.CascosDescontadosVenda.Where(c => c.VendaId == venda.Id).ToDictionaryAsync(c => c.ProdutoVasilhameId, ct);
        foreach (var casco in venda.CascosDescontados)
        {
            if (cascos.Remove(casco.ProdutoVasilhameId, out var linha))
            {
                linha.Quantidade = casco.Quantidade;
                linha.PrecoUnitario = casco.PrecoUnitario;
                linha.Descricao = casco.Descricao;
                continue;
            }

            db.CascosDescontadosVenda.Add(MapeadorVenda.ParaLinha(venda.Id, casco));
        }

        db.CascosDescontadosVenda.RemoveRange(cascos.Values);

        // Cobranças PIX (16.7): a nova entra depois do pagamento a que se liga (FK); a do pagamento removido muda o status.
        var cobrancas = await db.CobrancasPix.Where(c => c.VendaId == venda.Id).ToDictionaryAsync(c => c.Id, ct);
        foreach (var cobranca in venda.CobrancasPix)
        {
            if (!cobrancas.TryGetValue(cobranca.Id, out var linha))
            {
                linha = new CobrancaPixRegistro();
                db.CobrancasPix.Add(linha);
            }

            MapeadorVenda.CopiarCobranca(venda, cobranca, linha, relogio.Agora);
        }
    }

    /// <summary>Linhas do espelho das formas dos pagamentos da venda (as regras sem coluna em <c>pagamentos_venda</c>).</summary>
    private static async Task<Dictionary<Guid, FormaPagamentoRegistro>> FormasAsync(PdvDbContext db, VendaRegistro venda, CancellationToken ct)
    {
        var ids = venda.Pagamentos.Select(p => p.FormaPagamentoId).Distinct().ToList();
        return ids.Count == 0
            ? []
            : await db.FormasPagamento.AsNoTracking().Where(f => ids.Contains(f.Id)).ToDictionaryAsync(f => f.Id, ct);
    }

    private static async Task<List<CobrancaPixRegistro>> CobrancasAsync(PdvDbContext db, Guid vendaId, CancellationToken ct) =>
        await db.CobrancasPix.AsNoTracking().Where(c => c.VendaId == vendaId).ToListAsync(ct);

    private static async Task<List<CascoDescontadoVendaLocal>> CascosDescontadosAsync(PdvDbContext db, Guid vendaId, CancellationToken ct) =>
        await db.CascosDescontadosVenda.AsNoTracking().Where(c => c.VendaId == vendaId).ToListAsync(ct);

    private static async Task<List<LiberacaoVendaLocal>> LiberacoesAsync(PdvDbContext db, Guid vendaId, CancellationToken ct) =>
        await db.LiberacoesVenda.AsNoTracking().Where(l => l.VendaId == vendaId).ToListAsync(ct);

    private static Task<VendaRegistro?> CarregarAsync(PdvDbContext db, Guid id, bool rastrear, CancellationToken ct)
    {
        var consulta = db.Vendas.Include(v => v.Itens).Include(v => v.Pagamentos).AsSplitQuery();
        return (rastrear ? consulta : consulta.AsNoTracking()).FirstOrDefaultAsync(v => v.Id == id, ct);
    }

    private static async Task<EstadoOperacao> ObterEstadoOperacaoAsync(PdvDbContext db, CancellationToken ct)
    {
        var estado = await db.EstadoOperacao.FirstOrDefaultAsync(ct);
        if (estado is null)
        {
            estado = new EstadoOperacao();
            db.EstadoOperacao.Add(estado);
        }

        return estado;
    }

    internal async Task<long> ProximoValorAsync(PdvDbContext db, string chave, CancellationToken ct)
    {
        var sequencia = await db.SequenciasLocais.FirstOrDefaultAsync(s => s.Chave == chave, ct);
        if (sequencia is null)
        {
            sequencia = new SequenciaLocal { Chave = chave, UltimoValor = 0 };
            db.SequenciasLocais.Add(sequencia);
        }

        sequencia.UltimoValor++;
        sequencia.AtualizadoEm = relogio.Agora;
        return sequencia.UltimoValor;
    }
}
