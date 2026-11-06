using System.Text.Json;
using GenesisPDV.Core.Caixa;
using GenesisPDV.Core.Comum;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Outbox;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Sessão de caixa no SQLite (Fase 1C, bloco C9; PDV 8, 20, 21; MD 3.12): cada fato do caixa grava as linhas e o evento
/// do outbox (<c>caixa.*</c>, <c>vasilhame.movimentado</c>, montado pela <c>FabricaEventosCaixa</c>) num commit só, pelo
/// <see cref="GravadorOutbox"/>. As regras de tela (fundo contado, fechamento cego, liberação do supervisor) são do C10a;
/// aqui ficam as que protegem o banco e o protocolo: uma sessão aberta por terminal, nada de abrir caixa com o terminal
/// em desativação (SYNC 3.8: fechar continua permitido), movimento só na sessão aberta, abertura com o fundo de troco e
/// cancelamento só de sangria e reforço (o que a nuvem recusaria para sempre não é gravado).
/// </summary>
public sealed class RepositorioCaixa(IDbContextFactory<PdvDbContext> fabrica, IRelogio relogio, GravadorOutbox? gravador = null)
{
    public const string MensagemTerminalDesativando = "Terminal em desativação pelo ERP: não é possível abrir o caixa.";
    public const string MensagemSessaoAberta = "Já existe uma sessão de caixa aberta neste terminal.";
    public const string MensagemSemSessao = "Não há sessão de caixa aberta neste terminal.";
    public const string MensagemAberturaSemFundo = "O movimento de abertura tem de ser o fundo de troco da sessão.";
    public const string MensagemMovimentoNaoCancelavel = "Só sangria e reforço se cancelam pelo caixa.";
    public const string MensagemVendaAberta = "Finalize ou cancele a venda atual antes de fechar o caixa.";

    private readonly GravadorOutbox _gravador = gravador ?? new GravadorOutbox(new RelogioOutboxLocal(relogio));

    /// <summary>A sessão aberta (<c>status &lt;&gt; 'fechada'</c>) deste terminal, se houver.</summary>
    public async Task<SessaoCaixaRegistro?> SessaoAbertaAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await SessaoAbertaAsync(db, rastrear: false, ct);
    }

    /// <summary>T13: a nuvem anunciou o tipo (a tela pergunta antes de abrir o caixa ou de começar o movimento).</summary>
    public async Task<bool> TipoAceitoAsync(string tipo, int versao = 1, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.IdentidadeTerminal.AsNoTracking().AnyAsync(i => i.UrlApi == IdentidadeTerminal.UrlDemonstracao, ct)
               || await GravadorOutbox.TipoAceitoAsync(db, tipo, versao, ct);
    }

    /// <summary>
    /// <c>caixa.aberto</c> (SYNC 9.3): sessão, movimento <c>abertura</c> (nenhum com fundo 0,00) e
    /// <c>estado_operacao.sessao_caixa_id</c> num commit. Recusado com o terminal em desativação (3.8), com outra sessão
    /// aberta, com o tipo não anunciado pela nuvem (T13) ou com a abertura diferente do fundo (o <c>caixa.aberto</c> do
    /// contrato exige movimento = <c>fundo_troco</c>; fundo 0,00 sem movimento): nada fica gravado.
    /// </summary>
    /// <param name="auditoria">
    /// Registros do mesmo commit (liberação do supervisor, sessão de outro operador; C10a), com a sessão aberta.
    /// </param>
    public async Task<long> AbrirAsync(
        SessaoCaixaRegistro sessao,
        MovimentoCaixaRegistro? abertura,
        EventoParaOutbox evento,
        CancellationToken ct = default,
        IReadOnlyList<RegistroAuditoria>? auditoria = null)
    {
        ArgumentNullException.ThrowIfNull(sessao);
        ArgumentNullException.ThrowIfNull(evento);
        if (!AberturaDoFundo(sessao, abertura))
        {
            throw new RegraNegocioException(MensagemAberturaSemFundo);
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (await db.IdentidadeTerminal.AsNoTracking().AnyAsync(i => i.Status != StatusIdentidade.Ativo, ct))
        {
            throw new RegraNegocioException(MensagemTerminalDesativando);
        }

        if (await SessaoAbertaAsync(db, rastrear: false, ct) is not null)
        {
            throw new RegraNegocioException(MensagemSessaoAberta);
        }

        Carimbar(sessao);
        db.SessoesCaixa.Add(sessao);
        if (abertura is not null)
        {
            Carimbar(abertura);
            db.MovimentosCaixa.Add(abertura);
        }

        var gravado = await _gravador.GravarAsync(db, evento, ct);
        AdicionarAuditoria(db, auditoria, sessao.Id);
        var estado = await EstadoOperacaoAsync(db, ct);
        estado.SessaoCaixaId = sessao.Id;
        estado.OperadorId = sessao.OperadorId;
        estado.AtualizadoEm = relogio.Agora;
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return gravado.Sequencia;
    }

    /// <summary>
    /// <c>caixa.reforco</c>/<c>caixa.sangria</c> (SYNC 9.4): só na sessão aberta deste terminal. Só esses dois tipos
    /// (a abertura e a <c>sangria_fechamento</c> vão com a sessão; o estorno, com o cancelamento da venda).
    /// </summary>
    /// <param name="auditoria">Registros do mesmo commit (liberação do supervisor; C10b).</param>
    public async Task<long> RegistrarMovimentoAsync(
        MovimentoCaixaRegistro movimento, EventoParaOutbox evento, CancellationToken ct = default, IReadOnlyList<RegistroAuditoria>? auditoria = null)
    {
        ArgumentNullException.ThrowIfNull(movimento);
        ArgumentNullException.ThrowIfNull(evento);
        if (!TipoMovimentoCaixa.Cancelaveis.Contains(movimento.Tipo))
        {
            throw new InvalidOperationException("Movimento avulso é só sangria ou reforço.");
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await ExigirSessaoAsync(db, movimento.SessaoCaixaId, ct);
        Carimbar(movimento);
        db.MovimentosCaixa.Add(movimento);
        var gravado = await _gravador.GravarAsync(db, evento, ct);
        AdicionarAuditoria(db, auditoria, movimento.SessaoCaixaId);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return gravado.Sequencia;
    }

    /// <summary>
    /// <c>caixa.movimento_cancelado</c> (SYNC 9.5): só as colunas de cancelamento mudam (as que a imutabilidade da
    /// nuvem libera), na sessão ainda aberta e só de sangria ou reforço (<see cref="TipoMovimentoCaixa.Cancelaveis"/>):
    /// abertura, estorno e devolução cancelados aqui tirariam o valor da gaveta estimada, e a nuvem nunca os aplicaria.
    /// </summary>
    /// <param name="auditoria">Registros do mesmo commit (liberação do supervisor; C10b).</param>
    public async Task<long> CancelarMovimentoAsync(
        MovimentoCaixaRegistro cancelado, EventoParaOutbox evento, CancellationToken ct = default, IReadOnlyList<RegistroAuditoria>? auditoria = null)
    {
        ArgumentNullException.ThrowIfNull(cancelado);
        ArgumentNullException.ThrowIfNull(evento);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var linha = await db.MovimentosCaixa.FirstOrDefaultAsync(m => m.Id == cancelado.Id, ct)
                    ?? throw new RegraNegocioException("Movimento de caixa não encontrado.");
        if (linha.Cancelado)
        {
            throw new RegraNegocioException("Este movimento já foi cancelado.");
        }

        if (!TipoMovimentoCaixa.Cancelaveis.Contains(linha.Tipo))
        {
            throw new RegraNegocioException(MensagemMovimentoNaoCancelavel);
        }

        await ExigirSessaoAsync(db, linha.SessaoCaixaId, ct);
        linha.Cancelado = true;
        linha.CanceladoEm = cancelado.CanceladoEm;
        linha.CanceladoPorId = cancelado.CanceladoPorId;
        linha.AutorizadoCancelamentoPorId = cancelado.AutorizadoCancelamentoPorId;
        linha.MotivoCancelamento = cancelado.MotivoCancelamento;
        linha.AtualizadoEm = relogio.Agora;
        var gravado = await _gravador.GravarAsync(db, evento, ct);
        AdicionarAuditoria(db, auditoria, linha.SessaoCaixaId);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return gravado.Sequencia;
    }

    /// <summary>
    /// <c>caixa.fechado</c> (SYNC 9.6): fechamento, formas contadas e a <c>sangria_fechamento</c> (só no que zera o
    /// caixa); a sessão vira <c>fechada</c> e sai de <c>estado_operacao</c>. Permitido também em desativação (3.8).
    /// </summary>
    public async Task<long> FecharAsync(
        FechamentoCaixaRegistro fechamento,
        IReadOnlyList<FechamentoCaixaFormaRegistro> formas,
        MovimentoCaixaRegistro? sangriaFechamento,
        DateTimeOffset fechadaEm,
        EventoParaOutbox evento,
        CancellationToken ct = default,
        IReadOnlyList<RegistroAuditoria>? auditoria = null)
    {
        ArgumentNullException.ThrowIfNull(fechamento);
        ArgumentNullException.ThrowIfNull(formas);
        ArgumentNullException.ThrowIfNull(evento);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var sessao = await ExigirSessaoAsync(db, fechamento.SessaoCaixaId, ct);
        // PDV 21.2: venda em andamento (ou em pagamento) da sessão bloqueia o fechamento. A tela confere antes da
        // contagem (VendaPendenteAsync); aqui fica a guarda do commit.
        if (await VendaPendenteAsync(db, sessao.Id, ct))
        {
            throw new RegraNegocioException(MensagemVendaAberta);
        }

        sessao.Status = StatusSessaoCaixa.Fechada;
        sessao.FechadaEm = fechadaEm;
        sessao.AtualizadoEm = relogio.Agora;
        Carimbar(fechamento);
        db.FechamentosCaixa.Add(fechamento);
        foreach (var forma in formas)
        {
            Carimbar(forma);
            db.FechamentosCaixaFormas.Add(forma);
        }

        if (sangriaFechamento is not null)
        {
            Carimbar(sangriaFechamento);
            db.MovimentosCaixa.Add(sangriaFechamento);
        }

        var gravado = await _gravador.GravarAsync(db, evento, ct);
        AdicionarAuditoria(db, auditoria, sessao.Id);
        var estado = await EstadoOperacaoAsync(db, ct);
        if (estado.SessaoCaixaId == sessao.Id)
        {
            estado.SessaoCaixaId = null;
        }

        estado.AtualizadoEm = relogio.Agora;
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return gravado.Sequencia;
    }

    /// <summary>
    /// <c>venda.cancelada</c> forma A (SYNC 9.9 A; PDV 13.3; Fase 1C, bloco C11b): a venda finalizada cancelada pelo
    /// <see cref="Venda.CancelarFinalizada"/> — só as colunas de cancelamento, o <c>estornado</c> dos pagamentos e a
    /// cobrança PIX devolvida mudam (o documento é imutável) —, as linhas <c>estorno_venda</c> da sessão do cancelamento
    /// (<paramref name="estornos"/>, uma por forma), o evento e a auditoria num commit. Recusado fora da sessão aberta,
    /// com a venda de outra sessão (O6 do dono), que não está mais finalizada no banco ou com o <c>venda.finalizada</c>
    /// descartado no ERP: nada fica gravado.
    /// </summary>
    public async Task<long> CancelarVendaFinalizadaAsync(
        Venda venda,
        IReadOnlyList<MovimentoCaixaRegistro> estornos,
        EventoParaOutbox evento,
        CancellationToken ct = default,
        IReadOnlyList<RegistroAuditoria>? auditoria = null)
    {
        ArgumentNullException.ThrowIfNull(venda);
        ArgumentNullException.ThrowIfNull(estornos);
        ArgumentNullException.ThrowIfNull(evento);
        if (venda.Status != StatusVenda.Cancelada || venda.SessaoCaixaId is not { } sessaoId)
        {
            throw new InvalidOperationException("Só a venda finalizada cancelada (forma A), com a sessão, é gravada aqui.");
        }

        if (estornos.Any(m => m.Tipo != TipoMovimentoCaixa.EstornoVenda || m.SessaoCaixaId != sessaoId || m.FormaPagamentoId is null))
        {
            throw new InvalidOperationException("O cancelamento leva só linhas estorno_venda da sessão, com a forma.");
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await ExigirSessaoAsync(db, sessaoId, ct);
        var linha = await db.Vendas.Include(v => v.Pagamentos).FirstOrDefaultAsync(v => v.Id == venda.Id && v.ExcluidoEm == null, ct)
                    ?? throw new RegraNegocioException("Venda não encontrada neste caixa.");
        if (linha.Status != StatusVenda.Finalizada)
        {
            throw new RegraNegocioException(linha.Status == StatusVenda.Cancelada
                ? $"A venda {linha.NumeroExibicao} já está cancelada."
                : "Só a venda finalizada é cancelada pela gestão de vendas.");
        }

        if (linha.SessaoCaixaId != sessaoId)
        {
            throw new RegraNegocioException(Venda.MensagemCancelamentoForaDaSessao);
        }

        // O `venda.finalizada` descartado no ERP: a nuvem não tem a venda e recusaria o cancelamento para sempre.
        if (await ConsultasVendaLocal.FinalizadaDescartadaAsync(db, venda.Id, ct))
        {
            throw new RegraNegocioException(Venda.MensagemCancelamentoDescartada);
        }

        var agora = relogio.Agora;
        linha.Status = venda.Status;
        linha.CanceladaEm = venda.CanceladaEm;
        linha.CanceladaPorId = venda.CanceladaPorId;
        linha.CancelamentoAutorizadoPorId = venda.CancelamentoAutorizadoPorId;
        linha.MotivoCancelamento = venda.MotivoCancelamento;
        linha.CancelamentoOrigem = venda.CancelamentoOrigem;
        linha.AtualizadoEm = agora;
        var status = venda.Pagamentos.ToDictionary(p => p.Id, p => p.Status);
        foreach (var pagamento in linha.Pagamentos)
        {
            if (status.TryGetValue(pagamento.Id, out var novo) && novo != pagamento.Status)
            {
                pagamento.Status = novo;
                pagamento.AtualizadoEm = agora;
            }
        }

        var cobrancas = venda.CobrancasPix.ToDictionary(c => c.Id, c => c.Status);
        foreach (var cobranca in await db.CobrancasPix.Where(c => c.VendaId == venda.Id).ToListAsync(ct))
        {
            if (cobrancas.TryGetValue(cobranca.Id, out var novo) && novo != cobranca.Status)
            {
                cobranca.Status = novo;
                cobranca.AtualizadoEm = agora;
                // Como a nuvem grava no mesmo cancelamento (`cancelamento.ts`): o valor inteiro, na hora do cancelamento.
                if (novo == StatusCobrancaPix.Devolvida)
                {
                    cobranca.ValorDevolvido = cobranca.Valor;
                    cobranca.DevolvidaEm = venda.CanceladaEm;
                }
            }
        }

        foreach (var estorno in estornos)
        {
            Carimbar(estorno);
            db.MovimentosCaixa.Add(estorno);
        }

        var gravado = await _gravador.GravarAsync(db, evento, ct);
        AdicionarAuditoria(db, auditoria, sessaoId);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return gravado.Sequencia;
    }

    /// <summary>
    /// As linhas <c>estorno_venda</c> do cancelamento (MD 3.12.2): uma por forma, na sessão aberta, com quem cancelou
    /// (<paramref name="operadorId"/>) e quem liberou (<paramref name="autorizadoPorId"/>), na hora do cancelamento.
    /// </summary>
    public static IReadOnlyList<MovimentoCaixaRegistro> LinhasEstorno(
        SessaoCaixaRegistro sessao, Venda venda, CancelamentoFinalizada cancelamento, Func<Guid> novoId)
    {
        ArgumentNullException.ThrowIfNull(sessao);
        ArgumentNullException.ThrowIfNull(venda);
        ArgumentNullException.ThrowIfNull(cancelamento);
        ArgumentNullException.ThrowIfNull(novoId);
        return cancelamento.Movimentos.Select(m => new MovimentoCaixaRegistro
        {
            Id = novoId(),
            SessaoCaixaId = sessao.Id,
            LojaId = sessao.LojaId,
            CaixaId = sessao.CaixaId,
            NumeroCaixa = sessao.NumeroCaixa,
            TerminalId = sessao.TerminalId,
            Tipo = TipoMovimentoCaixa.EstornoVenda,
            FormaPagamentoId = m.FormaPagamentoId,
            Valor = m.Valor,
            OperadorId = venda.CanceladaPorId ?? venda.OperadorId,
            Observacao = $"Estorno da venda {venda.NumeroExibicao}",
            OcorridoEm = venda.CanceladaEm ?? throw new InvalidOperationException("Venda sem a hora do cancelamento."),
            AutorizadoPorId = venda.CancelamentoAutorizadoPorId,
        }).ToList();
    }

    /// <summary>
    /// Venda em andamento, em pagamento ou suspensa da sessão (PDV 21.2: bloqueia o fechamento antes do passo 1). Vem do
    /// banco, não da memória da tela: a venda deixada por uma queda de energia também conta, de qualquer operador.
    /// </summary>
    public async Task<bool> VendaPendenteAsync(Guid sessaoCaixaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await VendaPendenteAsync(db, sessaoCaixaId, ct);
    }

    private static Task<bool> VendaPendenteAsync(PdvDbContext db, Guid sessaoCaixaId, CancellationToken ct) =>
        db.Vendas.AsNoTracking().AnyAsync(
            v => v.SessaoCaixaId == sessaoCaixaId && v.ExcluidoEm == null
                 && (v.Status == StatusVenda.EmAndamento || v.Status == StatusVenda.EmPagamento || v.Status == StatusVenda.Suspensa), ct);

    /// <summary><c>vasilhame.movimentado</c> (SYNC 9.26): devolução avulsa de cascos na sessão aberta.</summary>
    public async Task<long> RegistrarVasilhameAsync(MovimentoVasilhameRegistro movimento, EventoParaOutbox evento, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(movimento);
        ArgumentNullException.ThrowIfNull(evento);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await ExigirSessaoAsync(db, movimento.SessaoCaixaId, ct);
        Carimbar(movimento);
        db.MovimentosVasilhame.Add(movimento);
        var gravado = await _gravador.GravarAsync(db, evento, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return gravado.Sequencia;
    }

    /// <summary>
    /// <c>dinheiro_gaveta</c> da sessão (PDV 20.4; C10b): limite de gaveta, sangria e o <c>dinheiro_estimado_gaveta</c> do
    /// heartbeat. Só os pagamentos e os movimentos, sem os itens (roda a cada venda e a cada heartbeat). Nulo sem a sessão.
    /// </summary>
    public async Task<decimal?> DinheiroGavetaAsync(Guid sessaoCaixaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await DinheiroGavetaAsync(db, sessaoCaixaId, ct);
    }

    /// <summary>O mesmo cálculo num contexto já aberto (o heartbeat do <c>GenesisPDV.Sync</c> monta tudo numa leitura).</summary>
    public static async Task<decimal?> DinheiroGavetaAsync(PdvDbContext db, Guid sessaoCaixaId, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        var fundo = await db.SessoesCaixa.AsNoTracking().Where(s => s.Id == sessaoCaixaId).Select(s => (decimal?)s.FundoTroco).FirstOrDefaultAsync(ct);
        if (fundo is null)
        {
            return null;
        }

        var pagamentos = await db.PagamentosVenda.AsNoTracking()
            .Where(p => (p.Status == StatusPagamento.Aprovado || p.Status == StatusPagamento.Estornado)
                        && db.Vendas.Any(v => v.Id == p.VendaId && v.SessaoCaixaId == sessaoCaixaId && v.ExcluidoEm == null && v.FinalizadaEm != null
                                              && (v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada)))
            .Select(p => new { p.FormaPagamentoId, p.DescricaoForma, p.TipoForma, p.Valor, p.Troco })
            .ToListAsync(ct);
        // O lançamento a prazo cancelado (`credito_cancelado`, que o `ApurarAsync` tira do calculado da forma) não é
        // dinheiro: aqui só pesaria o troco, que saiu da gaveta de qualquer jeito.
        var linhas = await db.MovimentosCaixa.AsNoTracking()
            .Where(m => m.SessaoCaixaId == sessaoCaixaId && m.ExcluidoEm == null && !m.Cancelado)
            .Select(m => new { m.Tipo, m.Valor, m.FormaPagamentoId })
            .ToListAsync(ct);
        var idsFormas = linhas.Where(m => m.FormaPagamentoId is not null).Select(m => m.FormaPagamentoId!.Value).Distinct().ToList();
        var tipos = await db.FormasPagamento.AsNoTracking().Where(f => idsFormas.Contains(f.Id)).ToDictionaryAsync(f => f.Id, f => f.TipoForma, ct);
        return ApuracaoCaixa.DinheiroGaveta(
            fundo.Value,
            pagamentos.Select(p => new PagamentoApurado(new FormaCaixa(p.FormaPagamentoId, p.DescricaoForma, p.TipoForma), p.Valor,
                p.TipoForma == ApuracaoCaixa.TipoDinheiro ? 0m : p.Troco)),
            linhas.Select(m => new MovimentoApurado(m.Tipo, m.Valor, false,
                m.FormaPagamentoId is { } f ? new FormaCaixa(f, "Forma", tipos.GetValueOrDefault(f, "outros")) : null)));
    }

    /// <summary>Movimentos da sessão, do mais antigo ao mais novo (F11 › 1/2 › F12 Movimentos, PDV 20.3).</summary>
    public async Task<IReadOnlyList<MovimentoCaixaRegistro>> MovimentosDaSessaoAsync(Guid sessaoCaixaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.MovimentosCaixa.AsNoTracking()
            .Where(m => m.SessaoCaixaId == sessaoCaixaId && m.ExcluidoEm == null)
            .OrderBy(m => m.OcorridoEm).ThenBy(m => m.CriadoEm)
            .ToListAsync(ct);
    }

    /// <summary>
    /// Resumo diário (PDV 21.6; C10b): vendas e sangrias/reforços deste terminal no período, montados pelo
    /// <see cref="ResumoDiario"/> do Core. <paramref name="valoresOcultos"/> é o fechamento cego da O3 (só as quantidades).
    /// </summary>
    public async Task<ResumoDiario> ResumoDiarioAsync(PeriodoResumo periodo, bool valoresOcultos, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(periodo);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        // Os instantes são texto UTC de largura fixa (`DataHoraUtcTexto`): a comparação no SQLite segue a ordem do tempo.
        var (de, ate) = (periodo.Inicio, periodo.Fim);
        var vendas = (await db.Vendas.AsNoTracking()
                .Where(v => v.ExcluidoEm == null && (v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada)
                            && ((v.FinalizadaEm >= de && v.FinalizadaEm < ate) || (v.CanceladaEm >= de && v.CanceladaEm < ate)))
                .Include(v => v.Pagamentos)
                .Include(v => v.Itens)
                .ToListAsync(ct))
            .Select(v =>
            {
                var cancelados = v.Itens.Where(i => i.Cancelado).ToList();
                return new VendaResumo(v.SessaoCaixaId, v.Status, v.FinalizadaEm, v.CanceladaEm, v.Total, v.DescontoItens + v.DescontoTotal,
                    cancelados.Count, cancelados.Sum(i => i.ValorBruto),
                    v.Pagamentos.Where(p => p.Status == StatusPagamento.Aprovado)
                        .Select(p => new PagamentoApurado(new FormaCaixa(p.FormaPagamentoId, p.DescricaoForma, p.TipoForma), p.Valor))
                        .ToList());
            })
            .ToList();
        var movimentos = await db.MovimentosCaixa.AsNoTracking()
            .Where(m => m.ExcluidoEm == null && (m.Tipo == TipoMovimentoCaixa.Sangria || m.Tipo == TipoMovimentoCaixa.Reforco)
                        && m.OcorridoEm >= de && m.OcorridoEm < ate)
            .Select(m => new MovimentoResumo(m.SessaoCaixaId, m.Tipo, m.Valor, m.Cancelado, m.OcorridoEm))
            .ToListAsync(ct);
        return ResumoDiario.Montar(periodo, vendas, movimentos, valoresOcultos);
    }

    /// <summary>
    /// Fatos da sessão para o fechamento e o dinheiro estimado na gaveta (PDV 20.4, 21.2, 21.4; C10a): os pagamentos
    /// aprovados das vendas <b>finalizadas na sessão</b> (mesmo que canceladas depois: o pagamento fica <c>estornado</c>
    /// e continua somando, e o estorno efetivado subtrai pela linha <c>estorno_venda</c>, C11b), os movimentos (com a
    /// forma do estorno, do espelho) e o resumo do turno (SYNC 9.6). O lançamento a prazo cancelado
    /// (<see cref="EstornoPagamento.SaiDoCalculado"/>) não gera linha nem deixa nada a contar: sai do calculado da forma
    /// (fica só o troco, se houve).
    /// </summary>
    public async Task<DadosApuracaoSessao> ApurarAsync(Guid sessaoCaixaId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var sessao = await db.SessoesCaixa.AsNoTracking().FirstOrDefaultAsync(s => s.Id == sessaoCaixaId, ct)
                     ?? throw new RegraNegocioException(MensagemSemSessao);
        var vendas = await db.Vendas.AsNoTracking()
            .Where(v => v.SessaoCaixaId == sessaoCaixaId && v.ExcluidoEm == null)
            .Include(v => v.Pagamentos)
            .Include(v => v.Itens)
            .ToListAsync(ct);
        var pagas = vendas.Where(v => v.FinalizadaEm is not null && (v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada)).ToList();
        var escolhidos = await EstornosEscolhidosAsync(db, pagas.Where(v => v.Status == StatusVenda.Cancelada).Select(v => v.Id).ToList(), ct);
        var pagamentos = pagas
            .SelectMany(v => v.Pagamentos)
            .Where(p => p.Status is StatusPagamento.Aprovado or StatusPagamento.Estornado)
            .OrderBy(p => p.VendaId).ThenBy(p => p.Sequencia)
            .Select(p => (
                Pagamento: p,
                Troco: p.TipoForma == ApuracaoCaixa.TipoDinheiro ? 0m : p.Troco,
                Desfeito: p.Status == StatusPagamento.Estornado && escolhidos.TryGetValue(p.Id, out var estorno)
                                                              && EstornoPagamento.SaiDoCalculado(estorno, p.LancaQuitada)))
            .Where(x => !x.Desfeito || x.Troco != 0m)
            .Select(x => new PagamentoApurado(new FormaCaixa(x.Pagamento.FormaPagamentoId, x.Pagamento.DescricaoForma, x.Pagamento.TipoForma),
                x.Desfeito ? 0m : x.Pagamento.Valor, x.Troco))
            .ToList();
        var linhas = await db.MovimentosCaixa.AsNoTracking()
            .Where(m => m.SessaoCaixaId == sessaoCaixaId && m.ExcluidoEm == null)
            .OrderBy(m => m.OcorridoEm)
            .ToListAsync(ct);
        var idsFormas = linhas.Where(m => m.FormaPagamentoId is not null).Select(m => m.FormaPagamentoId!.Value).Distinct().ToList();
        var formas = await db.FormasPagamento.AsNoTracking()
            .Where(f => idsFormas.Contains(f.Id))
            .ToDictionaryAsync(f => f.Id, f => new FormaCaixa(f.Id, f.Descricao, f.TipoForma), ct);
        var movimentos = linhas
            .Select(m => new MovimentoApurado(m.Tipo, m.Valor, m.Cancelado,
                m.FormaPagamentoId is { } forma ? formas.GetValueOrDefault(forma, new FormaCaixa(forma, "Forma", "outros")) : null))
            .ToList();

        var finalizadas = vendas.Where(v => v.Status == StatusVenda.Finalizada).ToList();
        var canceladas = vendas.Where(v => v.Status == StatusVenda.Cancelada).ToList();
        var itensCancelados = finalizadas.SelectMany(v => v.Itens).Where(i => i.Cancelado).ToList();
        var idsFinalizadas = finalizadas.Select(v => v.Id).ToList();
        var liberacoes = await db.LiberacoesVenda.AsNoTracking().CountAsync(l => idsFinalizadas.Contains(l.VendaId), ct);
        var resumo = new ResumoTurno(
            finalizadas.Count,
            finalizadas.Sum(v => v.Total),
            canceladas.Count,
            canceladas.Sum(v => v.Total),
            itensCancelados.Count,
            itensCancelados.Sum(i => i.ValorBruto),
            finalizadas.Sum(v => v.DescontoItens + v.DescontoTotal),
            liberacoes);
        return new DadosApuracaoSessao(sessao, pagamentos, movimentos, linhas, resumo);
    }

    /// <summary>
    /// O estorno escolhido para cada pagamento das vendas canceladas (<paramref name="vendas"/>), por id do pagamento: o
    /// banco local guarda só o <c>estornado</c>, e o estorno vem do payload do <c>venda.cancelada</c> forma A
    /// (<c>pagamentos_venda[].estorno</c>; o outbox não é expurgado). Payload sem o bloco (forma B) não traz nada.
    /// </summary>
    private static async Task<IReadOnlyDictionary<Guid, string>> EstornosEscolhidosAsync(PdvDbContext db, IReadOnlyCollection<Guid> vendas, CancellationToken ct)
    {
        var resultado = new Dictionary<Guid, string>();
        if (vendas.Count == 0)
        {
            return resultado;
        }

        var payloads = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Tipo == "venda.cancelada" && vendas.Contains(e.AgregadoId))
            .Select(e => e.Payload)
            .ToListAsync(ct);
        foreach (var payload in payloads)
        {
            using var doc = JsonDocument.Parse(payload);
            if (!doc.RootElement.TryGetProperty("pagamentos_venda", out var lista) || lista.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var p in lista.EnumerateArray())
            {
                if (p.TryGetProperty("id", out var id) && Guid.TryParse(id.GetString(), out var pagamentoId)
                    && p.TryGetProperty("estorno", out var estorno) && estorno.ValueKind == JsonValueKind.String)
                {
                    resultado[pagamentoId] = estorno.GetString()!;
                }
            }
        }

        return resultado;
    }

    /// <summary>
    /// Turno deixado para o próximo operador (21.3): o último fechamento deste terminal, se foi troca de turno (não
    /// zerou) e nenhuma sessão nasceu dele ainda. A nova abertura pré-preenche o fundo com o <c>valor_caixa</c> e grava a
    /// sessão anterior e o valor recebido.
    /// </summary>
    public async Task<TurnoHerdado?> TurnoHerdadoAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var ultimo = await db.FechamentosCaixa.AsNoTracking()
            .Where(f => f.ExcluidoEm == null)
            .OrderByDescending(f => f.OcorridoEm).ThenByDescending(f => f.CriadoEm)
            .FirstOrDefaultAsync(ct);
        if (ultimo is not { ZeraCaixa: false } || await db.SessoesCaixa.AsNoTracking().AnyAsync(s => s.SessaoAnteriorId == ultimo.SessaoCaixaId, ct))
        {
            return null;
        }

        return new TurnoHerdado(ultimo.SessaoCaixaId, ultimo.ValorCaixa, ultimo.UsuarioAnteriorId, ultimo.OcorridoEm);
    }

    /// <summary>
    /// Sequência do último evento gravado (<c>resumo.ultima_sequencia_evento</c> do <c>caixa.fechado</c>, SYNC 9.6): o
    /// fechamento é gravado logo depois, com a seguinte. Ao menos 1 (o <c>caixa.aberto</c> da sessão já é um evento).
    /// </summary>
    public async Task<long> UltimaSequenciaEventoAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var valor = await db.SequenciasLocais.AsNoTracking()
            .Where(s => s.Chave == SequenciaLocal.Evento).Select(s => (long?)s.UltimoValor).FirstOrDefaultAsync(ct);
        return Math.Max(1, valor ?? 0);
    }

    /// <summary>
    /// <c>payloadCaixaAbertoSchema</c>: o movimento de abertura é da própria sessão e vale o <c>fundo_troco</c>; fundo
    /// 0,00 vai sem movimento (<c>ck_movimentos_caixa_valor</c>: valor &gt; 0).
    /// </summary>
    public static bool AberturaDoFundo(SessaoCaixaRegistro sessao, MovimentoCaixaRegistro? abertura)
    {
        ArgumentNullException.ThrowIfNull(sessao);
        return abertura is null
            ? sessao.FundoTroco == 0m
            : abertura.Tipo == TipoMovimentoCaixa.Abertura && abertura.SessaoCaixaId == sessao.Id && abertura.Valor == sessao.FundoTroco;
    }

    private static Task<SessaoCaixaRegistro?> SessaoAbertaAsync(PdvDbContext db, bool rastrear, CancellationToken ct)
    {
        var consulta = db.SessoesCaixa.Where(s => s.Status != StatusSessaoCaixa.Fechada && s.ExcluidoEm == null);
        return (rastrear ? consulta : consulta.AsNoTracking()).FirstOrDefaultAsync(ct);
    }

    private static async Task<SessaoCaixaRegistro> ExigirSessaoAsync(PdvDbContext db, Guid sessaoCaixaId, CancellationToken ct) =>
        await SessaoAbertaAsync(db, rastrear: true, ct) is { } sessao && sessao.Id == sessaoCaixaId
            ? sessao
            : throw new RegraNegocioException(MensagemSemSessao);

    private void AdicionarAuditoria(PdvDbContext db, IReadOnlyList<RegistroAuditoria>? auditoria, Guid sessaoCaixaId)
    {
        foreach (var a in auditoria ?? [])
        {
            db.LogAuditoriaLocal.Add(new LogAuditoriaLocal
            {
                Id = IdGerador.Novo(),
                OcorridoEm = relogio.Agora,
                UsuarioId = a.UsuarioId,
                AutorizadoPorId = a.AutorizadoPorId,
                SessaoCaixaId = sessaoCaixaId,
                Acao = a.Acao,
                Entidade = a.Entidade,
                RegistroId = a.RegistroId,
                Localizacao = a.Localizacao,
                Descricao = a.Descricao,
                Motivo = a.Motivo,
                Antes = a.Antes,
                Depois = a.Depois,
            });
        }
    }

    private void Carimbar(LinhaMovimento linha)
    {
        var agora = relogio.Agora;
        linha.CriadoEm = agora;
        linha.AtualizadoEm = agora;
    }

    private static async Task<EstadoOperacao> EstadoOperacaoAsync(PdvDbContext db, CancellationToken ct)
    {
        var estado = await db.EstadoOperacao.FirstOrDefaultAsync(ct);
        if (estado is null)
        {
            estado = new EstadoOperacao();
            db.EstadoOperacao.Add(estado);
        }

        return estado;
    }
}

/// <summary>Resumo do turno (<c>fechamentos_caixa.resumo</c>, SYNC 9.6; relatório 21.4), das vendas da sessão.</summary>
public sealed record ResumoTurno(
    int QtdVendas,
    decimal TotalVendas,
    int QtdCanceladas,
    decimal TotalCanceladas,
    int QtdItensCancelados,
    decimal TotalItensCancelados,
    decimal TotalDescontos,
    int QtdLiberacoes)
{
    public decimal TicketMedio => QtdVendas == 0 ? 0m : decimal.Round(TotalVendas / QtdVendas, 2, MidpointRounding.AwayFromZero);
}

/// <param name="Linhas">Os movimentos da sessão como gravados (lista de sangrias e reforços do relatório).</param>
public sealed record DadosApuracaoSessao(
    SessaoCaixaRegistro Sessao,
    IReadOnlyList<PagamentoApurado> Pagamentos,
    IReadOnlyList<MovimentoApurado> Movimentos,
    IReadOnlyList<MovimentoCaixaRegistro> Linhas,
    ResumoTurno Resumo);

/// <summary>Troca de turno sem zerar (21.3): a sessão que passou o caixa, o valor deixado e quem deixou.</summary>
public sealed record TurnoHerdado(Guid SessaoAnteriorId, decimal ValorCaixa, Guid UsuarioAnteriorId, DateTimeOffset FechadoEm);
