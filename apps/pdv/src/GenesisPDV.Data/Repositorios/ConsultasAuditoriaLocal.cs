using System.Linq.Expressions;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Os filtros do Histórico de uso (aba 6 da Central, bloco G10), todos no SQL: o período pela hora do registro
/// (<c>[Desde, Ate)</c>), a pessoa (<see cref="UsuarioId"/>: o que ela fez, <c>usuario_id</c>, e o que ela liberou com o PIN,
/// <c>autorizado_por_id</c> — resposta do dono de 05/11/2026, README › decisão 78), as ações de um grupo e um texto na
/// descrição ou no motivo. O texto
/// no SQL é uma <b>pré-seleção</b> sem diferença de acento nem de maiúscula (<see cref="BuscaSemAcento.PadraoLike"/>: pode
/// trazer a mais, nunca a menos); quem mostra confere de novo depois da máscara. <paramref name="AcoesDoTexto"/>: as linhas
/// dessas ações também entram (a frase da ação, que a lista mostra, tem o texto).
/// </summary>
public sealed record FiltroAuditoria(
    DateTimeOffset? Desde = null,
    DateTimeOffset? Ate = null,
    Guid? UsuarioId = null,
    IReadOnlyList<string>? Acoes = null,
    string? Texto = null,
    IReadOnlyList<string>? AcoesDoTexto = null);

/// <summary>
/// O começo da próxima página: a hora do registro mais antigo já mostrado e os ids já mostrados com essa mesma hora (o
/// <c>id</c> é texto no SQLite e não se compara com <c>&lt;</c> pelo EF; com a hora e os ids vistos, nada se repete nem se
/// pula, mesmo com vários registros no mesmo instante).
/// </summary>
public sealed record CursorAuditoria(DateTimeOffset OcorridoEm, IReadOnlyList<Guid> IdsNoInstante);

/// <summary>
/// Uma linha do <c>log_auditoria_local</c> como a aba 6 a lê (sem tracking), com a situação do lote em que subiu
/// (<see cref="StatusEvento"/> e <see cref="ResultadoEvento"/>: o <c>status</c> e o <c>resultado</c> do <c>eventos_saida</c>
/// do <c>evento_id</c>; nulos sem lote; o lote que o ERP descartou fica <c>rejeitado</c> e só o <c>resultado</c> diz,
/// <see cref="ConsultasVendaLocal.Descartado"/>). <see cref="VendaPaga"/>: só no <c>venda_cancelada</c>, se a venda
/// cancelada tinha sido paga (<see cref="ConsultasAuditoriaLocal.CancelamentoDeVendaPaga"/>); nulo nas outras ações. Texto
/// ainda sem máscara.
/// </summary>
public sealed record RegistroAuditoriaLocal(
    Guid Id,
    DateTimeOffset OcorridoEm,
    Guid? UsuarioId,
    Guid? AutorizadoPorId,
    Guid? SessaoCaixaId,
    string Acao,
    string? Entidade,
    Guid? RegistroId,
    string? Localizacao,
    string? Descricao,
    string? Motivo,
    string? Antes,
    string? Depois,
    Guid? EventoId,
    string? StatusEvento,
    string? ResultadoEvento = null,
    bool? VendaPaga = null);

public sealed record PaginaAuditoria(IReadOnlyList<RegistroAuditoriaLocal> Registros, CursorAuditoria? Proxima);

/// <summary>Quantas vezes cada pessoa fez cada ação no período (o resumo por operador).</summary>
public sealed record ContagemAuditoria(Guid? UsuarioId, string Acao, int Quantidade);

/// <summary>
/// Quantas vendas uma pessoa cancelou no período: as pagas (o F12 › cancelar, com o estorno do dinheiro) e as em andamento
/// (o Shift+F4 da venda aberta, que não tira nada da gaveta).
/// </summary>
public sealed record CancelamentosDeVenda(Guid UsuarioId, int Pagas, int EmAndamento);

/// <summary>A primeira e a última ação de uma pessoa no período.</summary>
public sealed record AtividadeUsuario(Guid UsuarioId, DateTimeOffset Primeira, DateTimeOffset Ultima);

/// <summary>
/// As vendas pagas de um operador no período (pela hora em que foram pagas): quantas, e o desconto que ele deu nas que
/// continuam pagas — o do item (sem a promoção, que é da loja) e o no total (sem os cascos descontados, C11c) —, em quantas
/// vendas e quanto.
/// </summary>
public sealed record VendasDoOperador(Guid OperadorId, int Vendas, int VendasComDesconto, decimal ValorDescontos);

/// <summary>
/// O <c>log_auditoria_local</c> para a aba 6 Histórico de uso da Central do PDV (bloco G10; plano 4.4): quem fez o quê
/// neste caixa, o mais novo primeiro, <see cref="TamanhoPagina"/> por página, pelo cursor (hora e os ids do mesmo
/// instante). Entra pelos índices da migração <c>IndicesHistoricoUso</c>: <c>(ocorrido_em, id)</c> no período (a ordem da
/// lista sem ordenação à parte), <c>(usuario_id, ocorrido_em)</c> por quem fez e <c>(acao, ocorrido_em)</c> pelo grupo e no
/// resumo; e pelo <c>(autorizado_por_id, ocorrido_em)</c> da <c>IndiceAuditoriaAutorizadoPor</c> (decisão 78) no que a
/// pessoa liberou. Um <c>DbContext</c> curto por consulta, sem tracking. A frase, a máscara e quem pode ver são do App.
/// </summary>
public sealed class ConsultasAuditoriaLocal(IDbContextFactory<PdvDbContext> fabrica)
{
    public const int TamanhoPagina = 50;

    /// <summary>A venda cancelada, paga ou em andamento (o caminho normal das duas grava esta ação).</summary>
    public const string AcaoVendaCancelada = "venda_cancelada";

    /// <summary>A venda em andamento cancelada sem o <c>venda.cancelada</c> (fora da sessão aberta, ou a nuvem T13).</summary>
    public const string AcaoCancelarEmAndamento = "cancelar";

    public async Task<PaginaAuditoria> ListarAsync(FiltroAuditoria filtro, CursorAuditoria? depois = null, int tamanho = TamanhoPagina, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(filtro);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var consulta = Filtrar(db.LogAuditoriaLocal.AsNoTracking(), filtro);
        if (depois is { } c)
        {
            var vistos = c.IdsNoInstante.ToList();
            consulta = consulta.Where(l => l.OcorridoEm < c.OcorridoEm || (l.OcorridoEm == c.OcorridoEm && !vistos.Contains(l.Id)));
        }

        var linhas = await ComVendaPagaAsync(db, await Projetar(db, consulta
                    .OrderByDescending(l => l.OcorridoEm)
                    .ThenByDescending(l => l.Id)
                    .Take(tamanho + 1))
                .ToListAsync(ct), ct);
        if (linhas.Count <= tamanho)
        {
            return new PaginaAuditoria(linhas, null);
        }

        var pagina = linhas.GetRange(0, tamanho);
        return new PaginaAuditoria(pagina, Cursor(pagina, depois));
    }

    /// <summary>Um registro pelo id (o detalhe; nulo se não existe).</summary>
    public async Task<RegistroAuditoriaLocal?> ObterAsync(Guid id, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linhas = await Projetar(db, db.LogAuditoriaLocal.AsNoTracking().Where(l => l.Id == id)).ToListAsync(ct);
        return linhas.Count == 0 ? null : (await ComVendaPagaAsync(db, linhas, ct))[0];
    }

    /// <summary>
    /// Quem fez ou liberou com o PIN alguma coisa no período (o filtro "Quem", decisão 78: o supervisor que só liberou também
    /// entra), sem repetir; o caixa sozinho (sem pessoa) fica de fora. Duas leituras, cada uma pelo seu índice.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> UsuariosAsync(DateTimeOffset? desde, DateTimeOffset? ate, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var fizeram = await Periodo(db.LogAuditoriaLocal.AsNoTracking(), desde, ate)
            .Where(l => l.UsuarioId != null)
            .Select(l => l.UsuarioId)
            .Distinct()
            .ToListAsync(ct);
        var liberaram = await Periodo(db.LogAuditoriaLocal.AsNoTracking(), desde, ate)
            .Where(l => l.AutorizadoPorId != null)
            .Select(l => l.AutorizadoPorId)
            .Distinct()
            .ToListAsync(ct);
        return [.. fizeram.Concat(liberaram).Select(i => i!.Value).Distinct()];
    }

    /// <summary>Quantas vezes cada pessoa fez cada uma das <paramref name="acoes"/> no período (o resumo por operador).</summary>
    public async Task<IReadOnlyList<ContagemAuditoria>> ContagensAsync(
        DateTimeOffset? desde, DateTimeOffset? ate, IReadOnlyList<string> acoes, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(acoes);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var lista = acoes.Distinct(StringComparer.Ordinal).ToList();
        return await Periodo(db.LogAuditoriaLocal.AsNoTracking(), desde, ate)
            .Where(l => lista.Contains(l.Acao))
            .GroupBy(l => new { l.UsuarioId, l.Acao })
            .Select(g => new ContagemAuditoria(g.Key.UsuarioId, g.Key.Acao, g.Count()))
            .ToListAsync(ct);
    }

    /// <summary>
    /// Quantas vendas cada pessoa cancelou no período, as pagas e as em andamento (<see cref="CancelamentoDeVendaPaga"/>):
    /// o <c>venda_cancelada</c> é a ação do caminho normal das duas, e o <c>cancelar</c>, a da em andamento sem o evento.
    /// Pelo <c>(acao, ocorrido_em)</c>; as vendas, pela chave (os cancelamentos são poucos).
    /// </summary>
    public async Task<IReadOnlyList<CancelamentosDeVenda>> CancelamentosDeVendaAsync(DateTimeOffset? desde, DateTimeOffset? ate, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        string[] acoes = [AcaoVendaCancelada, AcaoCancelarEmAndamento];
        var linhas = await Periodo(db.LogAuditoriaLocal.AsNoTracking(), desde, ate)
            .Where(l => acoes.Contains(l.Acao) && l.UsuarioId != null)
            .Select(l => new { l.UsuarioId, l.Acao, l.RegistroId, l.Depois })
            .ToListAsync(ct);
        var pagas = await PagasAsync(db, linhas.Where(l => l.Acao == AcaoVendaCancelada).Select(l => l.RegistroId), ct);
        return
        [
            .. linhas
                .Select(l => (Usuario: l.UsuarioId!.Value, Paga: l.Acao == AcaoVendaCancelada && CancelamentoDeVendaPaga(pagas, l.RegistroId, l.Depois)))
                .GroupBy(l => l.Usuario)
                .Select(g => new CancelamentosDeVenda(g.Key, g.Count(l => l.Paga), g.Count(l => !l.Paga))),
        ];
    }

    /// <summary>
    /// Se o <c>venda_cancelada</c> foi de uma venda paga: pela venda do <c>registro_id</c> (<c>finalizada_em</c>: a em
    /// andamento cancelada nunca foi paga); sem a venda no banco, pelo <c>sai_da_gaveta</c> do <c>depois</c>, que só o
    /// cancelamento da venda paga grava.
    /// </summary>
    public static bool CancelamentoDeVendaPaga(IReadOnlyDictionary<Guid, bool> pagas, Guid? registroId, string? depois)
    {
        ArgumentNullException.ThrowIfNull(pagas);
        return registroId is { } id && pagas.TryGetValue(id, out var paga)
            ? paga
            : depois?.Contains("\"sai_da_gaveta\"", StringComparison.Ordinal) == true;
    }

    /// <summary>
    /// Quantas liberações cada pessoa pediu a <b>outra</b> no período (<c>liberacao</c> pelo <c>usuario_id</c>, com quem
    /// autorizou diferente): a "pedida" a si mesmo, como o supervisor que libera o próprio caixa, não conta.
    /// </summary>
    public async Task<IReadOnlyDictionary<Guid, int>> LiberacoesPedidasAsync(DateTimeOffset? desde, DateTimeOffset? ate, string acaoLiberacao, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var pedidas = await Periodo(db.LogAuditoriaLocal.AsNoTracking(), desde, ate)
            .Where(l => l.Acao == acaoLiberacao && l.UsuarioId != null && l.AutorizadoPorId != null && l.AutorizadoPorId != l.UsuarioId)
            .GroupBy(l => l.UsuarioId)
            .Select(g => new { g.Key, Quantidade = g.Count() })
            .ToListAsync(ct);
        return pedidas.ToDictionary(p => p.Key!.Value, p => p.Quantidade);
    }

    /// <summary>Quantas liberações cada supervisor deu no período (<c>liberacao</c> pelo <c>autorizado_por_id</c>).</summary>
    public async Task<IReadOnlyDictionary<Guid, int>> LiberacoesDadasAsync(DateTimeOffset? desde, DateTimeOffset? ate, string acaoLiberacao, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var dadas = await Periodo(db.LogAuditoriaLocal.AsNoTracking(), desde, ate)
            .Where(l => l.Acao == acaoLiberacao && l.AutorizadoPorId != null && l.AutorizadoPorId != l.UsuarioId)
            .GroupBy(l => l.AutorizadoPorId)
            .Select(g => new { g.Key, Quantidade = g.Count() })
            .ToListAsync(ct);
        return dadas.ToDictionary(d => d.Key!.Value, d => d.Quantidade);
    }

    /// <summary>
    /// A primeira e a última ação de cada pessoa no período: duas leituras curtas por pessoa pelo
    /// <c>(usuario_id, ocorrido_em)</c> (são poucas pessoas por caixa), nunca a tabela do período na memória.
    /// </summary>
    public async Task<IReadOnlyList<AtividadeUsuario>> AtividadeAsync(
        IReadOnlyList<Guid> usuarios, DateTimeOffset? desde, DateTimeOffset? ate, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(usuarios);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var resultado = new List<AtividadeUsuario>();
        foreach (var usuario in usuarios.Distinct())
        {
            var doUsuario = Periodo(db.LogAuditoriaLocal.AsNoTracking(), desde, ate).Where(l => l.UsuarioId == usuario);
            var primeira = await doUsuario.OrderBy(l => l.OcorridoEm).Select(l => (DateTimeOffset?)l.OcorridoEm).FirstOrDefaultAsync(ct);
            var ultima = await doUsuario.OrderByDescending(l => l.OcorridoEm).Select(l => (DateTimeOffset?)l.OcorridoEm).FirstOrDefaultAsync(ct);
            if (primeira is { } p && ultima is { } u)
            {
                resultado.Add(new AtividadeUsuario(usuario, p, u));
            }
        }

        return resultado;
    }

    /// <summary>
    /// As vendas pagas de cada operador deste terminal no período (pela hora do pagamento, <c>finalizada_em</c>; a que foi
    /// cancelada depois conta como venda e o cancelamento aparece na auditoria) e o desconto que ele deu nas que continuam
    /// pagas: o do item (<c>desconto_item</c> dos itens não cancelados, sem a promoção) e o no total (<c>desconto_total</c>
    /// menos os cascos descontados). Entra pelas sessões do período (algumas por dia) e pelo
    /// <c>ix_vendas_sessao_caixa_id</c>: nada que cresce com as vendas é varrido.
    /// </summary>
    public async Task<IReadOnlyList<VendasDoOperador>> VendasPorOperadorAsync(
        Guid terminalId, DateTimeOffset? desde, DateTimeOffset? ate, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var sessoes = db.SessoesCaixa.AsNoTracking().Where(s => s.TerminalId == terminalId && s.ExcluidoEm == null);
        if (ate is { } fimSessao)
        {
            sessoes = sessoes.Where(s => s.AbertaEm < fimSessao);
        }

        if (desde is { } inicioSessao)
        {
            sessoes = sessoes.Where(s => s.FechadaEm == null || s.FechadaEm >= inicioSessao);
        }

        var ids = (await sessoes.Select(s => s.Id).ToListAsync(ct)).Select(i => (Guid?)i).ToList();
        if (ids.Count == 0)
        {
            return [];
        }

        var vendas = db.Vendas.AsNoTracking()
            .Where(v => ids.Contains(v.SessaoCaixaId) && v.TerminalId == terminalId && v.ExcluidoEm == null && v.FinalizadaEm != null
                        && (v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada));
        if (desde is { } d)
        {
            vendas = vendas.Where(v => v.FinalizadaEm >= d);
        }

        if (ate is { } a)
        {
            vendas = vendas.Where(v => v.FinalizadaEm < a);
        }

        var quantidades = await vendas.GroupBy(v => v.OperadorId)
            .Select(g => new { Operador = g.Key, Quantidade = g.Count() })
            .ToListAsync(ct);

        // Só as pagas com algum desconto (o do item já soma a promoção: é a pré-seleção; a conta exata vem dos itens).
        var comDesconto = await vendas
            .Where(v => v.Status == StatusVenda.Finalizada && (v.DescontoItens > 0m || v.DescontoTotal > 0m))
            .Select(v => new { v.Id, v.OperadorId, v.DescontoTotal })
            .ToListAsync(ct);
        var porVenda = new Dictionary<Guid, (Guid Operador, decimal Valor)>();
        if (comDesconto.Count > 0)
        {
            var idsVenda = comDesconto.Select(v => v.Id).ToList();
            var itens = (await db.ItensVenda.AsNoTracking()
                    .Where(i => idsVenda.Contains(i.VendaId) && !i.Cancelado && i.DescontoItem > 0m)
                    .Select(i => new { i.VendaId, i.DescontoItem })
                    .ToListAsync(ct))
                .GroupBy(i => i.VendaId)
                .ToDictionary(g => g.Key, g => g.Sum(i => i.DescontoItem));
            var cascos = (await db.CascosDescontadosVenda.AsNoTracking()
                    .Where(c => idsVenda.Contains(c.VendaId))
                    .Select(c => new { c.VendaId, c.Quantidade, c.PrecoUnitario })
                    .ToListAsync(ct))
                .GroupBy(c => c.VendaId)
                .ToDictionary(g => g.Key, g => g.Sum(c => Core.Numeros.Arredondamento.Arred2(c.Quantidade * c.PrecoUnitario)));
            foreach (var v in comDesconto)
            {
                var valor = itens.GetValueOrDefault(v.Id) + Math.Max(0m, v.DescontoTotal - cascos.GetValueOrDefault(v.Id));
                if (valor > 0m)
                {
                    porVenda[v.Id] = (v.OperadorId, valor);
                }
            }
        }

        return quantidades
            .Select(q =>
            {
                var descontos = porVenda.Values.Where(p => p.Operador == q.Operador).ToList();
                return new VendasDoOperador(q.Operador, q.Quantidade, descontos.Count, descontos.Sum(p => p.Valor));
            })
            .ToList();
    }

    private static IQueryable<LogAuditoriaLocal> Periodo(IQueryable<LogAuditoriaLocal> consulta, DateTimeOffset? desde, DateTimeOffset? ate)
    {
        if (desde is { } d)
        {
            consulta = consulta.Where(l => l.OcorridoEm >= d);
        }

        if (ate is { } a)
        {
            consulta = consulta.Where(l => l.OcorridoEm < a);
        }

        return consulta;
    }

    private static IQueryable<LogAuditoriaLocal> Filtrar(IQueryable<LogAuditoriaLocal> consulta, FiltroAuditoria filtro)
    {
        consulta = Periodo(consulta, filtro.Desde, filtro.Ate);
        if (filtro.UsuarioId is { } usuario)
        {
            // O que a pessoa fez e o que ela liberou para outra (decisão 78); quem mostra diz qual dos dois.
            consulta = consulta.Where(l => l.UsuarioId == usuario || l.AutorizadoPorId == usuario);
        }

        if (filtro.Acoes is { Count: > 0 } acoes)
        {
            var lista = acoes.Distinct(StringComparer.Ordinal).ToList();
            consulta = consulta.Where(l => lista.Contains(l.Acao));
        }

        if (filtro.Texto?.Trim() is { Length: > 0 } texto)
        {
            consulta = consulta.Where(Texto(texto, filtro.AcoesDoTexto ?? []));
        }

        return consulta;
    }

    /// <summary>O texto na descrição ou no motivo (<see cref="BuscaSemAcento.PadraoLike"/>), ou uma das ações cuja frase tem o texto.</summary>
    private static Expression<Func<LogAuditoriaLocal, bool>> Texto(string texto, IReadOnlyList<string> acoes)
    {
        var padrao = BuscaSemAcento.PadraoLike(texto);
        if (acoes.Count == 0)
        {
            return l => (l.Descricao != null && EF.Functions.Like(l.Descricao, padrao, "\\"))
                        || (l.Motivo != null && EF.Functions.Like(l.Motivo, padrao, "\\"));
        }

        var lista = acoes.Distinct(StringComparer.Ordinal).ToList();
        return l => (l.Descricao != null && EF.Functions.Like(l.Descricao, padrao, "\\"))
                    || (l.Motivo != null && EF.Functions.Like(l.Motivo, padrao, "\\"))
                    || lista.Contains(l.Acao);
    }

    private static IQueryable<RegistroAuditoriaLocal> Projetar(PdvDbContext db, IQueryable<LogAuditoriaLocal> consulta) =>
        from l in consulta
        join e in db.EventosSaida.AsNoTracking() on l.EventoId equals (Guid?)e.Id into lote
        from e in lote.DefaultIfEmpty()
        select new RegistroAuditoriaLocal(
            l.Id, l.OcorridoEm, l.UsuarioId, l.AutorizadoPorId, l.SessaoCaixaId, l.Acao, l.Entidade, l.RegistroId, l.Localizacao,
            l.Descricao, l.Motivo, l.Antes, l.Depois, l.EventoId, e == null ? null : e.Status, e == null ? null : e.Resultado);

    /// <summary>O <see cref="RegistroAuditoriaLocal.VendaPaga"/> dos <c>venda_cancelada</c> da página (as vendas pela chave).</summary>
    private static async Task<List<RegistroAuditoriaLocal>> ComVendaPagaAsync(PdvDbContext db, List<RegistroAuditoriaLocal> linhas, CancellationToken ct)
    {
        if (!linhas.Exists(l => l.Acao == AcaoVendaCancelada))
        {
            return linhas;
        }

        var pagas = await PagasAsync(db, linhas.Where(l => l.Acao == AcaoVendaCancelada).Select(l => l.RegistroId), ct);
        return
        [
            .. linhas.Select(l => l.Acao == AcaoVendaCancelada ? l with { VendaPaga = CancelamentoDeVendaPaga(pagas, l.RegistroId, l.Depois) } : l),
        ];
    }

    /// <summary>Das vendas pedidas (pelo id), quais foram pagas (<c>finalizada_em</c>); a que não está no banco fica de fora.</summary>
    private static async Task<Dictionary<Guid, bool>> PagasAsync(PdvDbContext db, IEnumerable<Guid?> vendas, CancellationToken ct)
    {
        var ids = vendas.OfType<Guid>().Distinct().ToList();
        if (ids.Count == 0)
        {
            return [];
        }

        return await db.Vendas.AsNoTracking()
            .Where(v => ids.Contains(v.Id))
            .Select(v => new { v.Id, Paga = v.FinalizadaEm != null })
            .ToDictionaryAsync(v => v.Id, v => v.Paga, ct);
    }

    /// <summary>A hora do último da página e os ids dela com essa hora (mais os da página de antes, se a hora é a mesma).</summary>
    private static CursorAuditoria Cursor(List<RegistroAuditoriaLocal> pagina, CursorAuditoria? anterior)
    {
        var hora = pagina[^1].OcorridoEm;
        var ids = pagina.Where(r => r.OcorridoEm == hora).Select(r => r.Id).ToList();
        if (anterior is { } a && a.OcorridoEm == hora)
        {
            ids.AddRange(a.IdsNoInstante);
        }

        return new CursorAuditoria(hora, ids);
    }
}
