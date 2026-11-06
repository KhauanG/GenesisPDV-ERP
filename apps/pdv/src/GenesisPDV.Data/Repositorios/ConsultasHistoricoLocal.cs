using System.Globalization;
using System.Text.Json;
using GenesisPDV.Core.Vendas;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Um caixa (sessão) deste terminal que a Central consulta (Central do PDV, bloco G5): o aberto e os fechados dos últimos
/// <see cref="ConsultasHistoricoLocal.LimiteDias"/> dias (decisão do dono de 04/11/2026).
/// </summary>
/// <param name="QuantidadeVendas">Vendas encerradas (finalizadas e canceladas) da sessão.</param>
public sealed record CaixaConsultavel(
    Guid SessaoId,
    short NumeroCaixa,
    Guid OperadorId,
    DateOnly DiaOperacional,
    DateTimeOffset AbertaEm,
    DateTimeOffset? FechadaEm,
    int QuantidadeVendas)
{
    public bool Aberto => FechadaEm is null;
}

/// <summary>
/// Um caixa (sessão) deste terminal na aba 2 Caixas da Central (bloco G6; plano 4.3; PC-9): o aberto e os fechados nos
/// últimos <see cref="ConsultasHistoricoLocal.LimiteDias"/> dias, <b>como foram fechados</b> (o retrato do fechamento, sem
/// recalcular nada). Nunca traz o calculado nem a diferença (O3: só no ERP).
/// </summary>
/// <param name="QuantidadeVendas">Vendas encerradas (finalizadas e canceladas) da sessão.</param>
/// <param name="FechamentoId">O <c>fechamentos_caixa</c> da sessão (nulo no caixa aberto, ou fechado sem o retrato neste banco).</param>
/// <param name="TipoFechamento"><c>fechamento</c> (zerou) ou <c>troca_turno</c>.</param>
/// <param name="Contado">O total contado (<c>total_digitado</c>) que o relatório impresso mostrou.</param>
/// <param name="EnvioFechamento">A situação do <c>caixa.fechado</c> no outbox (<see cref="StatusEventoSaida"/>); nula sem o evento.</param>
/// <param name="CanceladasDepois">Vendas do caixa canceladas depois do fechamento dele (D23: nenhum caminho do PDV faz isso).</param>
public sealed record CaixaHistorico(
    Guid SessaoId,
    short NumeroCaixa,
    Guid OperadorId,
    DateOnly DiaOperacional,
    DateTimeOffset AbertaEm,
    DateTimeOffset? FechadaEm,
    decimal FundoTroco,
    int QuantidadeVendas,
    Guid? FechamentoId,
    string? TipoFechamento,
    decimal? Contado,
    string? EnvioFechamento,
    int CanceladasDepois,
    decimal TotalCanceladasDepois)
{
    public bool Aberto => FechadaEm is null;
}

/// <summary>Uma forma do fechamento como foi contada (só o contado: o calculado e a diferença ficam no ERP, PC-9).</summary>
public sealed record FormaContada(string Descricao, string TipoForma, decimal Contado);

/// <summary>
/// Uma sangria ou um reforço da sessão, como o relatório do fechamento os lista: a hora, o tipo, o valor e se foi
/// cancelado. Sem quem retirou nem a observação (o relatório não os traz; ficam no comprovante do movimento e no ERP).
/// </summary>
public sealed record MovimentoRetrato(string Tipo, decimal Valor, bool Cancelado, DateTimeOffset OcorridoEm);

/// <summary>Uma venda do caixa cancelada depois do fechamento dele (o selo "cancelada depois" da aba Vendas).</summary>
public sealed record VendaCanceladaDepois(Guid VendaId, string NumeroExibicao, decimal Total, DateTimeOffset CanceladaEm);

/// <summary>
/// O fechamento como foi gravado e impresso (<c>fechamentos_caixa</c>, <c>fechamentos_caixa_formas</c> e o
/// <c>resumo</c> do turno, SYNC 9.6): só o que o relatório do operador traz, sem o calculado nem a diferença (PC-9).
/// </summary>
/// <param name="ValorCaixa">O que ficou na gaveta para o próximo turno (troca de turno; 0 no fechamento que zera).</param>
/// <param name="Resumo">O resumo do turno guardado no fechamento; nulo se o JSON não tiver as chaves do contrato.</param>
public sealed record FechamentoRetrato(
    Guid Id,
    string Tipo,
    bool ZeraCaixa,
    DateTimeOffset OcorridoEm,
    decimal ValorCaixa,
    decimal TotalContado,
    string? Justificativa,
    IReadOnlyList<FormaContada> Formas,
    ResumoTurno? Resumo);

/// <summary>O detalhe de um caixa na aba Caixas: a linha, o fechamento (nulo no aberto), as sangrias e reforços e as canceladas depois.</summary>
public sealed record RetratoCaixa(
    CaixaHistorico Caixa,
    FechamentoRetrato? Fechamento,
    IReadOnlyList<MovimentoRetrato> Movimentos,
    IReadOnlyList<VendaCanceladaDepois> CanceladasDepois);

/// <summary>Situação no filtro da aba Vendas: todas as encerradas, só as pagas (não canceladas) ou só as canceladas.</summary>
public enum SituacaoFiltroVenda
{
    Todas,
    Pagas,
    Canceladas,
}

/// <summary>
/// Filtros da aba Vendas e do F12 (plano 4.2), todos aplicados no SQL. <paramref name="SessaoId"/> nulo = todos os caixas
/// consultáveis (o aberto e os fechados no limite de dias).
/// </summary>
/// <param name="Texto">
/// O número (inteiro: "13", "000013", "L01-C02-000013" ou o novo que a nuvem deu, T27) ou o CPF/CNPJ da nota (com ou sem a
/// máscara), como o F12 de antes.
/// </param>
public sealed record FiltroVendas(
    Guid? SessaoId = null,
    string? Texto = null,
    SituacaoFiltroVenda Situacao = SituacaoFiltroVenda.Todas,
    Guid? OperadorId = null,
    Guid? FormaPagamentoId = null,
    decimal? ValorMinimo = null,
    decimal? ValorMaximo = null);

/// <summary>Onde a página seguinte começa: a hora e o número da última venda da página (a ordem da lista).</summary>
public sealed record CursorVendas(DateTimeOffset Hora, long Numero);

/// <summary>Uma página da aba Vendas.</summary>
/// <param name="Quantidade">Quantas vendas o filtro acha no total (o rodapé).</param>
/// <param name="Proxima">Cursor da página seguinte; nulo na última.</param>
/// <param name="TotalPagas">
/// A soma das pagas (não canceladas) do filtro, só quando pedida na primeira página (a tela a mostra só a quem vê o
/// calculado do caixa, O3); nulo nas outras.
/// </param>
public sealed record PaginaVendas(IReadOnlyList<VendaDaSessao> Vendas, int Quantidade, CursorVendas? Proxima, decimal? TotalPagas = null);

/// <summary>
/// Consulta histórica das vendas deste terminal (Central do PDV, bloco G5; plano 4.2 e 5.3; decisões do dono de
/// 04/11/2026): as do caixa aberto e as dos caixas fechados nos últimos <see cref="LimiteDias"/> dias (pelo fechamento),
/// tudo offline. Paginada por cursor <c>(hora desc, número desc)</c>, todos os filtros no SQL, <c>AsNoTracking</c>, projeção
/// e um contexto curto por consulta. O teto de dias fica aqui (nunca só na tela): sessão mais antiga não entra, nem pedida
/// pelo id. Quem decide se a pessoa vê só o caixa aberto (sem <c>pdv.venda.consultar_historico</c>) é o serviço do App.
/// O F12 da venda é o caso particular "uma sessão, sem página" (<see cref="VendasDaSessaoAsync"/>). A aba 2 Caixas (bloco
/// G6) lê os mesmos caixas pelo retrato do fechamento (<see cref="SessoesAsync"/>, <see cref="RetratoAsync"/>). Só leitura.
/// </summary>
public sealed class ConsultasHistoricoLocal(IDbContextFactory<PdvDbContext> fabrica)
{
    /// <summary>Teto local (dono, 04/11/2026: 30 dias, não os 90 do plano); mais antigo, só no ERP.</summary>
    public const int LimiteDias = 30;

    /// <summary>Linhas por página (plano 4).</summary>
    public const int TamanhoPagina = 50;

    public const string MensagemMaisAntigas = "Vendas e caixas com mais de 30 dias: consulte no ERP (Vendas / Fechamentos de caixa).";

    /// <summary>
    /// A faixa em que a nuvem renumera ("Aplicar com novo número", T27): o número novo é sempre maior que este
    /// (<c>INICIO_FAIXA_RENUMERACAO</c> de <c>apps/api/src/sync/handlers/vendas.ts</c>; o fim do número de exibição muda
    /// junto). O texto fora dela não procura o número novo no outbox.
    /// </summary>
    public const long InicioFaixaRenumeracao = 9_000_000;

    /// <summary>
    /// O caixa aberto deste terminal (o mais novo, se houver mais de um), sem contar vendas: a consulta curta de cada
    /// leitura de quem vê só o caixa aberto.
    /// </summary>
    public async Task<Guid?> CaixaAbertoAsync(Guid terminalId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.SessoesCaixa.AsNoTracking()
            .Where(s => s.TerminalId == terminalId && s.ExcluidoEm == null && s.Status != StatusSessaoCaixa.Fechada)
            .OrderByDescending(s => s.AbertaEm)
            .Select(s => (Guid?)s.Id)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// O caixa aberto deste terminal (primeiro) e os fechados com o fechamento a partir de <paramref name="desde"/>, do mais
    /// novo ao mais antigo, com a quantidade de vendas encerradas de cada um.
    /// </summary>
    /// <param name="desde">O começo do dia operacional mais antigo que a tela mostra (o App calcula com a hora de corte).</param>
    public async Task<IReadOnlyList<CaixaConsultavel>> CaixasAsync(Guid terminalId, DateTimeOffset desde, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var sessoes = await SessoesPermitidas(db, terminalId, desde)
            .Select(s => new { s.Id, s.NumeroCaixa, s.OperadorId, s.DiaOperacional, s.AbertaEm, s.FechadaEm, s.Status })
            .ToListAsync(ct);
        if (sessoes.Count == 0)
        {
            return [];
        }

        var ids = sessoes.Select(s => (Guid?)s.Id).ToList();
        var quantidades = await db.Vendas.AsNoTracking()
            .Where(v => ids.Contains(v.SessaoCaixaId) && v.ExcluidoEm == null && (v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada))
            .GroupBy(v => v.SessaoCaixaId)
            .Select(g => new { Sessao = g.Key, Quantidade = g.Count() })
            .ToDictionaryAsync(g => g.Sessao!.Value, g => g.Quantidade, ct);
        return sessoes
            .Select(s => new CaixaConsultavel(
                s.Id, s.NumeroCaixa, s.OperadorId, s.DiaOperacional, s.AbertaEm,
                s.Status == StatusSessaoCaixa.Fechada ? s.FechadaEm ?? s.AbertaEm : null,
                quantidades.GetValueOrDefault(s.Id)))
            .OrderBy(c => c.Aberto ? 0 : 1)
            .ThenByDescending(c => c.FechadaEm)
            .ThenByDescending(c => c.AbertaEm)
            .ToList();
    }

    /// <summary>
    /// A aba 2 Caixas (bloco G6; plano 4.3 e 5.2; PC-9): o caixa aberto deste terminal (primeiro) e os fechados a partir de
    /// <paramref name="desde"/> (o mais novo primeiro), com o tipo e o contado do fechamento, a quantidade de vendas, as
    /// canceladas depois do fechamento e a situação do <c>caixa.fechado</c> no outbox. Lê o retrato (o que foi gravado no
    /// fechamento), nunca apura a sessão de novo: o calculado de um caixa fechado não se recalcula no PDV.
    /// </summary>
    public async Task<IReadOnlyList<CaixaHistorico>> SessoesAsync(Guid terminalId, DateTimeOffset desde, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await SessoesAsync(db, SessoesPermitidas(db, terminalId, desde), ct);
    }

    /// <summary>
    /// O detalhe de um caixa da aba Caixas pelo retrato: o fechamento (tipo, horários, o contado por forma, o resumo do
    /// turno guardado), as sangrias e os reforços (como o relatório os lista) e as vendas canceladas depois do fechamento.
    /// Nulo fora do teto de dias (ou de outro terminal), mesmo pedido pelo id.
    /// </summary>
    public async Task<RetratoCaixa?> RetratoAsync(Guid terminalId, DateTimeOffset desde, Guid sessaoId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        if ((await SessoesAsync(db, SessoesPermitidas(db, terminalId, desde).Where(s => s.Id == sessaoId), ct)).FirstOrDefault() is not { } caixa)
        {
            return null;
        }

        FechamentoRetrato? fechamento = null;
        if (caixa.FechamentoId is { } id)
        {
            var f = await db.FechamentosCaixa.AsNoTracking()
                .Where(x => x.Id == id)
                .Select(x => new { x.Tipo, x.ZeraCaixa, x.OcorridoEm, x.ValorCaixa, x.TotalDigitado, x.Justificativa, x.Resumo })
                .FirstAsync(ct);
            var formas = (await db.FechamentosCaixaFormas.AsNoTracking()
                    .Where(x => x.FechamentoId == id && x.ExcluidoEm == null)
                    .Select(x => new FormaContada(x.DescricaoForma, x.TipoForma, x.ValorDigitado))
                    .ToListAsync(ct))
                .OrderBy(x => x.TipoForma == "dinheiro" ? 0 : 1)
                .ThenBy(x => x.Descricao, StringComparer.CurrentCulture)
                .ToList();
            fechamento = new FechamentoRetrato(id, f.Tipo, f.ZeraCaixa, f.OcorridoEm, f.ValorCaixa, f.TotalDigitado, f.Justificativa, formas, LerResumo(f.Resumo));
        }

        var movimentos = await db.MovimentosCaixa.AsNoTracking()
            .Where(m => m.SessaoCaixaId == sessaoId && m.ExcluidoEm == null && (m.Tipo == TipoMovimentoCaixa.Sangria || m.Tipo == TipoMovimentoCaixa.Reforco))
            .OrderBy(m => m.OcorridoEm).ThenBy(m => m.CriadoEm)
            .Select(m => new MovimentoRetrato(m.Tipo, m.Valor, m.Cancelado, m.OcorridoEm))
            .ToListAsync(ct);
        IReadOnlyList<VendaCanceladaDepois> depois = [];
        if (caixa.FechadaEm is { } fechada && caixa.CanceladasDepois > 0)
        {
            var sessao = (Guid?)sessaoId;
            depois = (await db.Vendas.AsNoTracking()
                    .Where(v => v.SessaoCaixaId == sessao && v.ExcluidoEm == null && v.Status == StatusVenda.Cancelada && v.CanceladaEm != null)
                    .Select(v => new { v.Id, v.NumeroExibicao, v.Total, v.CanceladaEm })
                    .ToListAsync(ct))
                .Where(v => v.CanceladaEm > fechada)
                .OrderBy(v => v.CanceladaEm)
                .Select(v => new VendaCanceladaDepois(v.Id, v.NumeroExibicao, v.Total, v.CanceladaEm!.Value))
                .ToList();
        }

        return new RetratoCaixa(caixa, fechamento, movimentos, depois);
    }

    /// <summary>
    /// Os operadores das vendas encerradas dos caixas consultáveis (o filtro "Operador" da aba Vendas), sem repetir;
    /// com <paramref name="sessaoId"/>, só os daquele caixa.
    /// </summary>
    public async Task<IReadOnlyList<Guid>> OperadoresAsync(Guid terminalId, DateTimeOffset desde, Guid? sessaoId = null, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var sessoes = SessoesPermitidas(db, terminalId, desde).Where(s => sessaoId == null || s.Id == sessaoId).Select(s => (Guid?)s.Id);
        return await db.Vendas.AsNoTracking()
            .Where(v => sessoes.Contains(v.SessaoCaixaId) && v.ExcluidoEm == null && (v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada))
            .Select(v => v.OperadorId)
            .Distinct()
            .ToListAsync(ct);
    }

    /// <summary>
    /// As formas de pagamento usadas nas vendas dos caixas consultáveis (o filtro "Forma"), sem repetir, pelo nome; com
    /// <paramref name="sessaoId"/>, só as daquele caixa.
    /// </summary>
    public async Task<IReadOnlyList<(Guid Id, string Descricao)>> FormasAsync(
        Guid terminalId, DateTimeOffset desde, Guid? sessaoId = null, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var sessoes = SessoesPermitidas(db, terminalId, desde).Where(s => sessaoId == null || s.Id == sessaoId).Select(s => (Guid?)s.Id);
        var formas = await db.Vendas.AsNoTracking()
            .Where(v => sessoes.Contains(v.SessaoCaixaId) && v.ExcluidoEm == null && (v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada))
            .SelectMany(v => v.Pagamentos)
            .Where(p => p.Status == StatusPagamento.Aprovado || p.Status == StatusPagamento.Estornado)
            .Select(p => new { p.FormaPagamentoId, p.DescricaoForma })
            .Distinct()
            .ToListAsync(ct);
        return formas
            .GroupBy(f => f.FormaPagamentoId)
            .Select(g => (g.Key, g.Select(f => f.DescricaoForma).Order(StringComparer.Ordinal).First()))
            .OrderBy(f => f.Item2, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// Uma página das vendas encerradas (finalizadas e canceladas) dos caixas consultáveis deste terminal, da mais nova à
    /// mais antiga, com o filtro. <paramref name="depois"/> é o cursor da página anterior (nulo = a primeira). O caixa pedido
    /// fora do teto (ou de outro terminal) devolve a página vazia. <paramref name="somarPagas"/> soma as pagas do filtro na
    /// primeira página.
    /// </summary>
    public async Task<PaginaVendas> VendasAsync(
        Guid terminalId, DateTimeOffset desde, FiltroVendas filtro, CursorVendas? depois = null, int tamanho = TamanhoPagina, bool somarPagas = false,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(filtro);
        ArgumentOutOfRangeException.ThrowIfLessThan(tamanho, 1);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var sessoes = await SessoesPermitidas(db, terminalId, desde)
            .Where(s => filtro.SessaoId == null || s.Id == filtro.SessaoId)
            .Select(s => new { s.Id, s.Status, s.FechadaEm })
            .ToListAsync(ct);
        if (sessoes.Count == 0)
        {
            return new PaginaVendas([], 0, null, somarPagas && depois is null ? 0m : null);
        }

        var fechadas = sessoes.ToDictionary(s => s.Id, s => s.Status == StatusSessaoCaixa.Fechada ? s.FechadaEm : null);
        var consulta = await FiltrarAsync(db, [.. sessoes.Select(s => (Guid?)s.Id)], filtro, ct);
        var quantidade = await consulta.CountAsync(ct);
        var vendas = await PaginaAsync(db, consulta, depois, tamanho + 1, fechadas, ct);
        var proxima = vendas.Count > tamanho ? new CursorVendas(vendas[tamanho - 1].Hora, vendas[tamanho - 1].Numero) : null;
        // A soma no C#: o total é INTEGER escalado (EscalaDecimal), e só os valores das pagas do filtro são lidos.
        decimal? totalPagas = somarPagas && depois is null
            ? (await consulta.Where(v => v.Status == StatusVenda.Finalizada).Select(v => v.Total).ToListAsync(ct)).Sum()
            : null;
        return new PaginaVendas(vendas.Take(tamanho).ToList(), quantidade, proxima, totalPagas);
    }

    /// <summary>
    /// F12 Gestão de vendas (PDV 22.1; C11b): todas as vendas encerradas de uma sessão (sem página e sem o teto de dias:
    /// o F12 é a sessão aberta), da mais nova à mais antiga, com o filtro opcional pelo número ou pelo CPF/CNPJ.
    /// </summary>
    public async Task<IReadOnlyList<VendaDaSessao>> VendasDaSessaoAsync(Guid sessaoCaixaId, string? texto = null, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var sessao = await db.SessoesCaixa.AsNoTracking().Where(s => s.Id == sessaoCaixaId).Select(s => new { s.Status, s.FechadaEm }).FirstOrDefaultAsync(ct);
        var fechadas = new Dictionary<Guid, DateTimeOffset?> { [sessaoCaixaId] = sessao?.Status == StatusSessaoCaixa.Fechada ? sessao.FechadaEm : null };
        var consulta = await FiltrarAsync(db, [sessaoCaixaId], new FiltroVendas(sessaoCaixaId, texto), ct);
        return await PaginaAsync(db, consulta, null, int.MaxValue, fechadas, ct);
    }

    /// <summary>
    /// As sessões deste terminal que a consulta alcança: a aberta (qualquer data) e as fechadas a partir de
    /// <paramref name="desde"/> (o teto de <see cref="LimiteDias"/> dias).
    /// </summary>
    private static IQueryable<SessaoCaixaRegistro> SessoesPermitidas(PdvDbContext db, Guid terminalId, DateTimeOffset desde) =>
        db.SessoesCaixa.AsNoTracking()
            .Where(s => s.TerminalId == terminalId && s.ExcluidoEm == null
                        && (s.Status != StatusSessaoCaixa.Fechada || (s.FechadaEm != null && s.FechadaEm >= desde)));

    /// <summary>As linhas da aba Caixas das sessões da <paramref name="consulta"/>, o aberto primeiro e os fechados do mais novo ao mais antigo.</summary>
    private static async Task<List<CaixaHistorico>> SessoesAsync(PdvDbContext db, IQueryable<SessaoCaixaRegistro> consulta, CancellationToken ct)
    {
        var sessoes = await consulta
            .Select(s => new { s.Id, s.NumeroCaixa, s.OperadorId, s.DiaOperacional, s.AbertaEm, s.FechadaEm, s.Status, s.FundoTroco })
            .ToListAsync(ct);
        if (sessoes.Count == 0)
        {
            return [];
        }

        var ids = sessoes.Select(s => s.Id).ToList();
        var idsVenda = sessoes.Select(s => (Guid?)s.Id).ToList();
        // Um fechamento por sessão (uq_fechamentos_caixa_sessao_caixa_id): só as colunas que o relatório impresso mostrou.
        var fechamentos = await db.FechamentosCaixa.AsNoTracking()
            .Where(f => ids.Contains(f.SessaoCaixaId) && f.ExcluidoEm == null)
            .Select(f => new { f.SessaoCaixaId, f.Id, f.Tipo, f.TotalDigitado })
            .ToDictionaryAsync(f => f.SessaoCaixaId, ct);
        var quantidades = await db.Vendas.AsNoTracking()
            .Where(v => idsVenda.Contains(v.SessaoCaixaId) && v.ExcluidoEm == null && (v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada))
            .GroupBy(v => v.SessaoCaixaId)
            .Select(g => new { Sessao = g.Key, Quantidade = g.Count() })
            .ToDictionaryAsync(g => g.Sessao!.Value, g => g.Quantidade, ct);
        // As canceladas (poucas) com a hora; "depois" = depois do fechamento do caixa delas, comparado aqui.
        var canceladas = await db.Vendas.AsNoTracking()
            .Where(v => idsVenda.Contains(v.SessaoCaixaId) && v.ExcluidoEm == null && v.Status == StatusVenda.Cancelada && v.CanceladaEm != null)
            .Select(v => new { v.SessaoCaixaId, v.CanceladaEm, v.Total })
            .ToListAsync(ct);
        // A situação do caixa.fechado (agregado sessao_caixa) sem ler o payload.
        var envios = (await db.EventosSaida.AsNoTracking()
                .Where(e => e.Tipo == "caixa.fechado" && ids.Contains(e.AgregadoId))
                .Select(e => new { e.AgregadoId, e.Status, e.SequenciaTerminal })
                .ToListAsync(ct))
            .GroupBy(e => e.AgregadoId)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(e => e.SequenciaTerminal).First().Status);
        return sessoes
            .Select(s =>
            {
                var fechadaEm = s.Status == StatusSessaoCaixa.Fechada ? s.FechadaEm ?? s.AbertaEm : (DateTimeOffset?)null;
                var depois = fechadaEm is { } f
                    ? canceladas.Where(v => v.SessaoCaixaId == s.Id && v.CanceladaEm > f).ToList()
                    : [];
                var fechamento = fechamentos.GetValueOrDefault(s.Id);
                return new CaixaHistorico(
                    s.Id, s.NumeroCaixa, s.OperadorId, s.DiaOperacional, s.AbertaEm, fechadaEm, s.FundoTroco, quantidades.GetValueOrDefault(s.Id),
                    fechadaEm is null ? null : fechamento?.Id,
                    fechadaEm is null ? null : fechamento?.Tipo,
                    fechadaEm is null ? null : fechamento?.TotalDigitado,
                    envios.GetValueOrDefault(s.Id),
                    depois.Count,
                    depois.Sum(v => v.Total));
            })
            .OrderBy(c => c.Aberto ? 0 : 1)
            .ThenByDescending(c => c.FechadaEm)
            .ThenByDescending(c => c.AbertaEm)
            .ToList();
    }

    /// <summary>
    /// O resumo do turno guardado no fechamento (<c>fechamentos_caixa.resumo</c>, SYNC 9.6: os valores em texto com ponto,
    /// <c>"12.90"</c>); nulo se faltar alguma chave (o fechamento veio de outro caminho, por exemplo a nuvem).
    /// </summary>
    internal static ResumoTurno? LerResumo(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(json);
            var r = doc.RootElement;
            int Inteiro(string nome) => r.GetProperty(nome).GetInt32();
            decimal Dinheiro(string nome) => r.GetProperty(nome) is { ValueKind: JsonValueKind.String } t
                ? decimal.Parse(t.GetString()!, NumberStyles.Number, CultureInfo.InvariantCulture)
                : r.GetProperty(nome).GetDecimal();
            return new ResumoTurno(
                Inteiro("qtd_vendas"), Dinheiro("total_vendas"), Inteiro("qtd_canceladas"), Dinheiro("total_canceladas"),
                Inteiro("qtd_itens_cancelados"), Dinheiro("total_itens_cancelados"), Dinheiro("total_descontos"), Inteiro("qtd_liberacoes"));
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or OverflowException)
        {
            return null;
        }
    }

    /// <summary>Os filtros no SQL sobre as vendas encerradas das <paramref name="sessoes"/>.</summary>
    private static async Task<IQueryable<VendaRegistro>> FiltrarAsync(PdvDbContext db, List<Guid?> sessoes, FiltroVendas filtro, CancellationToken ct)
    {
        var consulta = db.Vendas.AsNoTracking()
            .Where(v => sessoes.Contains(v.SessaoCaixaId) && v.ExcluidoEm == null);
        consulta = filtro.Situacao switch
        {
            SituacaoFiltroVenda.Pagas => consulta.Where(v => v.Status == StatusVenda.Finalizada),
            SituacaoFiltroVenda.Canceladas => consulta.Where(v => v.Status == StatusVenda.Cancelada),
            _ => consulta.Where(v => v.Status == StatusVenda.Finalizada || v.Status == StatusVenda.Cancelada),
        };
        if (filtro.OperadorId is { } operador)
        {
            consulta = consulta.Where(v => v.OperadorId == operador);
        }

        if (filtro.FormaPagamentoId is { } forma)
        {
            consulta = consulta.Where(v => db.PagamentosVenda.Any(p => p.VendaId == v.Id && p.FormaPagamentoId == forma
                                                                       && (p.Status == StatusPagamento.Aprovado || p.Status == StatusPagamento.Estornado)));
        }

        if (filtro.ValorMinimo is { } minimo)
        {
            consulta = consulta.Where(v => v.Total >= minimo);
        }

        if (filtro.ValorMaximo is { } maximo)
        {
            consulta = consulta.Where(v => v.Total <= maximo);
        }

        var texto = (filtro.Texto ?? string.Empty).Trim();
        if (texto.Length == 0)
        {
            return consulta;
        }

        // Como o F12 de antes: o número casa inteiro (só o texto todo em dígitos é o número, sem os zeros à esquerda; "C02"
        // não é a venda 2), o numero_exibicao completo sem diferenciar maiúsculas, o novo número da nuvem (T27) e o CPF/CNPJ
        // com ou sem a máscara (os dígitos do texto).
        var digitos = new string(texto.Where(char.IsAsciiDigit).ToArray());
        var semZeros = texto.All(char.IsAsciiDigit) ? digitos.TrimStart('0') : string.Empty;
        var numero = semZeros.Length > 0 && long.TryParse(semZeros, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : -1L;
        var exibicao = texto.ToUpperInvariant();
        var documento = digitos.Length > 0 ? digitos : "\u0001";
        var renumeradas = NaFaixaRenumeracao(texto, numero)
            ? await RenumeradasQueCasamAsync(db, consulta, exibicao, numero, ct)
            : [];
        return consulta.Where(v => v.NumeroExibicao.ToUpper() == exibicao
                                   || v.Numero == numero
                                   || v.CpfCnpjNota == documento
                                   || renumeradas.Contains(v.Id));
    }

    /// <summary>
    /// O texto pode ser um número novo da nuvem (T27): o número inteiro, ou o fim do número de exibição, acima de
    /// <see cref="InicioFaixaRenumeracao"/> e com até 10 dígitos (o CPF tem 11 e o CNPJ 14; a nuvem conta de um em um a
    /// partir de 9.000.001 por caixa). Fora disso, a busca não lê o <c>resultado</c> do outbox: no "Todos os caixas" são
    /// dezenas de milhares de eventos, cada um depois do payload (que passa da página do SQLite), a cada tecla.
    /// </summary>
    internal static bool NaFaixaRenumeracao(string texto, long numero)
    {
        var fim = numero > 0 ? numero.ToString(CultureInfo.InvariantCulture) : new string(texto.Reverse().TakeWhile(char.IsAsciiDigit).Reverse().ToArray()).TrimStart('0');
        return fim.Length is > 0 and <= 10
               && long.TryParse(fim, NumberStyles.None, CultureInfo.InvariantCulture, out var n)
               && n > InicioFaixaRenumeracao;
    }

    /// <summary>
    /// As vendas do escopo que a nuvem renumerou ("Aplicar com novo número", T27) e cujo número novo casa com o texto. A
    /// renumeração é rara: só os <c>venda.finalizada</c> com <c>numero_original</c> no resultado são lidos.
    /// </summary>
    private static async Task<List<Guid>> RenumeradasQueCasamAsync(
        PdvDbContext db, IQueryable<VendaRegistro> escopo, string exibicao, long numero, CancellationToken ct)
    {
        var ids = escopo.Select(v => v.Id);
        var resultados = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Tipo == "venda.finalizada" && e.Resultado != null && e.Resultado.Contains("numero_original") && ids.Contains(e.AgregadoId))
            .Select(e => new { e.AgregadoId, e.Resultado })
            .ToListAsync(ct);
        return resultados
            .Select(r => (r.AgregadoId, Novo: NumeroRenumerado(r.Resultado)))
            .Where(r => r.Novo is { } novo && (string.Equals(novo.Exibicao, exibicao, StringComparison.OrdinalIgnoreCase) || novo.Numero == numero))
            .Select(r => r.AgregadoId)
            .Distinct()
            .ToList();
    }

    /// <summary>A página na ordem da lista (hora desc, número desc), com as formas e o número novo da nuvem de cada venda.</summary>
    private static async Task<List<VendaDaSessao>> PaginaAsync(
        PdvDbContext db, IQueryable<VendaRegistro> consulta, CursorVendas? depois, int limite, Dictionary<Guid, DateTimeOffset?> fechadas, CancellationToken ct)
    {
        // A hora da lista: a finalização ou, na venda em andamento cancelada, o cancelamento (a iniciada só por segurança).
        var ordenada = consulta.Select(v => new { Venda = v, Hora = v.FinalizadaEm ?? v.CanceladaEm ?? v.IniciadaEm });
        if (depois is { } c)
        {
            ordenada = ordenada.Where(x => x.Hora < c.Hora || (x.Hora == c.Hora && x.Venda.Numero < c.Numero));
        }

        var linhas = await ordenada
            .OrderByDescending(x => x.Hora)
            .ThenByDescending(x => x.Venda.Numero)
            .Take(limite)
            .Select(x => new
            {
                x.Venda.Id,
                x.Venda.Numero,
                x.Venda.NumeroExibicao,
                x.Venda.Status,
                x.Hora,
                x.Venda.Total,
                x.Venda.CpfCnpjNota,
                x.Venda.OperadorId,
                x.Venda.MotivoCancelamento,
                x.Venda.FinalizadaEm,
                x.Venda.CanceladaEm,
                x.Venda.SessaoCaixaId,
            })
            .ToListAsync(ct);
        if (linhas.Count == 0)
        {
            return [];
        }

        var ids = linhas.Select(l => l.Id).ToList();
        var formas = (await db.PagamentosVenda.AsNoTracking()
                .Where(p => ids.Contains(p.VendaId) && (p.Status == StatusPagamento.Aprovado || p.Status == StatusPagamento.Estornado))
                .Select(p => new { p.VendaId, p.Sequencia, p.DescricaoForma })
                .ToListAsync(ct))
            .GroupBy(p => p.VendaId)
            .ToDictionary(g => g.Key, g => string.Join(" + ", g.OrderBy(p => p.Sequencia).Select(p => p.DescricaoForma).Distinct()));
        var renumeradas = (await db.EventosSaida.AsNoTracking()
                .Where(e => e.Tipo == "venda.finalizada" && ids.Contains(e.AgregadoId) && e.Resultado != null)
                .Select(e => new { e.AgregadoId, e.Resultado })
                .ToListAsync(ct))
            .Select(e => (e.AgregadoId, Novo: NumeroRenumerado(e.Resultado)))
            .Where(e => e.Novo is not null)
            .GroupBy(e => e.AgregadoId)
            .ToDictionary(g => g.Key, g => g.First().Novo!.Value.Exibicao);
        return linhas
            .Select(l =>
            {
                var fechadaEm = l.SessaoCaixaId is { } s ? fechadas.GetValueOrDefault(s) : null;
                return new VendaDaSessao(
                    l.Id,
                    l.Numero,
                    l.NumeroExibicao,
                    l.Status,
                    l.Hora,
                    l.Total,
                    formas.GetValueOrDefault(l.Id, string.Empty),
                    l.CpfCnpjNota,
                    l.OperadorId,
                    l.MotivoCancelamento,
                    l.FinalizadaEm is not null,
                    renumeradas.GetValueOrDefault(l.Id),
                    l.SessaoCaixaId,
                    fechadaEm,
                    // "Cancelada depois": cancelada depois do fechamento do caixa dela (D23: nenhum caminho do PDV faz isso;
                    // o selo só aparece se o dado chegar assim por outro caminho, sem recalcular nada).
                    l.Status == StatusVenda.Cancelada && l.CanceladaEm is { } cancelada && fechadaEm is { } fechada && cancelada > fechada);
            })
            .ToList();
    }

    /// <summary>
    /// <c>numero_exibicao</c> e <c>numero</c> do resultado do "Aplicar com novo número" (<c>resultadoRenumeracao</c> da
    /// nuvem, que traz também o <c>numero_original</c>); nulo sem renumeração.
    /// </summary>
    internal static (string Exibicao, long Numero)? NumeroRenumerado(string? resultado)
    {
        if (string.IsNullOrWhiteSpace(resultado))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(resultado);
            var raiz = doc.RootElement;
            return raiz.ValueKind == JsonValueKind.Object
                   && raiz.TryGetProperty("numero_original", out _)
                   && raiz.TryGetProperty("numero_exibicao", out var n) && n.ValueKind == JsonValueKind.String
                   && raiz.TryGetProperty("numero", out var numero) && numero.ValueKind == JsonValueKind.Number && numero.TryGetInt64(out var valor)
                ? (n.GetString()!, valor)
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
