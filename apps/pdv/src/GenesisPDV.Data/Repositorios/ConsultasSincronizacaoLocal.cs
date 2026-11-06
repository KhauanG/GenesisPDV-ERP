using System.Text.Json;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Um evento do outbox como a aba 4 Sincronização o mostra (Central do PDV, bloco G7; plano 4): o tipo, a sequência, a
/// situação, as tentativas, o primeiro envio do lote atual, a próxima tentativa, o último erro e a confirmação. <b>Nunca</b>
/// o <c>payload</c> nem o <c>contexto</c> (o tipo não tem essas propriedades e a consulta não lê essas colunas).
/// </summary>
/// <param name="Descartado">Recusado e descartado no ERP (<c>resultado.descartado</c>): decisão final na nuvem.</param>
/// <param name="Divergente">
/// Recusado por <c>EVENTO_DIVERGENTE</c> (SYNC 8.4 camada 3): a nuvem tem outro conteúdo com o mesmo id; quem resolve é o
/// suporte, não a fila de decisão do ERP.
/// </param>
public sealed record EventoSincronizacao(
    Guid Id,
    long Sequencia,
    string Tipo,
    string AgregadoTipo,
    Guid AgregadoId,
    DateTimeOffset OcorridoEm,
    DateTimeOffset CriadoEm,
    string Status,
    int Tentativas,
    DateTimeOffset? EnviadoEm,
    DateTimeOffset? ProximaTentativaEm,
    string? UltimoErro,
    DateTimeOffset? ConfirmadoEm,
    bool Descartado,
    bool Divergente)
{
    /// <summary>Recusado pela nuvem e ainda sem decisão final (a fila de decisão do ERP resolve).</summary>
    public bool Recusado => Status == StatusEventoSaida.Rejeitado && !Descartado;

    /// <summary>Ainda vai (ou volta) para a nuvem: pendente, enviando ou esperando a próxima tentativa.</summary>
    public bool AEnviar => ConsultasSincronizacaoLocal.StatusAEnviar.Contains(Status);
}

/// <summary>Uma dependência do evento (o agregado que precisa estar na nuvem antes) e a situação dele aqui.</summary>
/// <param name="Status">A situação do último evento do agregado no outbox; nula quando o caixa não tem evento dele.</param>
public sealed record DependenciaSincronizacao(string AgregadoTipo, Guid AgregadoId, string? Status);

/// <summary>
/// Uma venda que a nuvem ainda não confirmou (o pedido do dono de 04/11/2026, "vendas a copiar"): uma linha por venda, não
/// por evento. <see cref="Recusada"/> quando algum evento dela foi recusado (vermelho, a decisão é no ERP); senão pendente
/// (amarelo). A confirmada não aparece.
/// </summary>
/// <param name="Numero">O <c>numero_exibicao</c>; nulo quando a venda não está no banco local (só o evento).</param>
/// <param name="Hora">A finalização (ou o cancelamento, ou o início) da venda; nula sem a venda local.</param>
/// <param name="PrimeiraSequencia">
/// A sequência do primeiro evento da venda (o <c>venda.finalizada</c>, mesmo já confirmado): a ordem em que o caixa a
/// enviou, e a chave do cursor, que não muda quando um evento dela é confirmado entre as páginas.
/// </param>
/// <param name="Motivo">O último erro do evento recusado (ou do que espera nova tentativa), como a nuvem disse.</param>
public sealed record VendaNaoConfirmada(
    Guid VendaId,
    string? Numero,
    DateTimeOffset? Hora,
    decimal? Total,
    string? StatusVenda,
    Guid? OperadorId,
    bool Recusada,
    bool Enviando,
    bool Divergente,
    long PrimeiraSequencia,
    IReadOnlyList<string> Tipos,
    int Tentativas,
    DateTimeOffset? ProximaTentativaEm,
    string? Motivo,
    DateTimeOffset NaFilaDesde);

/// <summary>Onde a página seguinte das listas não confirmadas começa: as recusadas primeiro, depois a ordem de envio.</summary>
public sealed record CursorNaoConfirmados(bool Recusada, long Sequencia);

/// <summary>
/// Das vendas que estavam na tela e saíram da lista, as que o ERP resolveu: <see cref="Confirmadas"/> (a nuvem tem todos
/// os eventos: o envio passou ou o ERP reprocessou) e <see cref="Descartadas"/> (o ERP descartou: decisão final, a nuvem
/// não tem a venda e ela não estará no ERP).
/// </summary>
public sealed record VendasResolvidas(IReadOnlySet<Guid> Confirmadas, IReadOnlySet<Guid> Descartadas);

/// <summary>Os recusados do outbox inteiro: os que esperam a decisão do ERP e os já descartados lá (decisão final).</summary>
public sealed record ContagemRecusados(int SemDecisao, int Descartados);

/// <summary>Uma página das vendas não confirmadas.</summary>
/// <param name="Quantidade">Quantas vendas não confirmadas há no total.</param>
/// <param name="Recusadas">Quantas delas foram recusadas (o resto está pendente).</param>
/// <param name="Descartadas">Vendas cujos eventos foram todos descartados no ERP (decisão final: não aparecem na lista).</param>
public sealed record PaginaVendasNaoConfirmadas(
    IReadOnlyList<VendaNaoConfirmada> Vendas, int Quantidade, int Recusadas, int Descartadas, CursorNaoConfirmados? Proxima);

/// <summary>
/// Uma página dos registros do caixa não confirmados (aberturas, sangrias, reforços, o cancelamento deles e os
/// fechamentos): os recusados primeiro, depois a ordem de envio; os descartados no ERP ficam de fora (só contam).
/// </summary>
public sealed record PaginaCaixaNaoConfirmado(
    IReadOnlyList<EventoSincronizacao> Eventos, int Quantidade, int Recusados, int Descartados, CursorNaoConfirmados? Proxima);

/// <summary>
/// O que o caixa sabe do agregado de um evento sem abrir o payload: a venda (número e total), o movimento do caixa (tipo,
/// valor e hora) ou a sessão (caixa nº e abertura).
/// </summary>
public sealed record AgregadoSincronizacao(
    Guid Id,
    string? NumeroVenda = null,
    decimal? Valor = null,
    string? TipoMovimento = null,
    bool MovimentoCancelado = false,
    short? NumeroCaixa = null,
    DateTimeOffset? Quando = null,
    Guid? OperadorId = null);

/// <summary>Situação no filtro da lista "Todos os registros".</summary>
public enum SituacaoFiltroEvento
{
    /// <summary>Pendentes, enviando e esperando nova tentativa (a ordem de envio: o mais antigo primeiro).</summary>
    AEnviar,

    /// <summary>Recusados pela nuvem (inclusive os descartados no ERP), o mais antigo primeiro.</summary>
    Recusados,

    /// <summary>Confirmados, o mais novo primeiro.</summary>
    Confirmados,

    /// <summary>Todos, o mais novo primeiro.</summary>
    Todos,
}

/// <summary>Filtro da lista de eventos: a situação, o tipo (nulo = todos) e os agregados (nulo = todos).</summary>
public sealed record FiltroEventos(SituacaoFiltroEvento Situacao, string? Tipo = null, IReadOnlyList<string>? AgregadoTipos = null)
{
    /// <summary>A ordem de envio (o mais antigo primeiro) nas situações que ainda vão ou voltam para a nuvem.</summary>
    public bool Crescente => Situacao is SituacaoFiltroEvento.AEnviar or SituacaoFiltroEvento.Recusados;
}

/// <summary>Uma página de eventos.</summary>
/// <param name="Proxima">A sequência depois da qual (ou antes da qual, na ordem decrescente) a página seguinte começa.</param>
public sealed record PaginaEventos(IReadOnlyList<EventoSincronizacao> Eventos, int Quantidade, long? Proxima);

/// <summary>Um comando recebido do ERP (<c>comandos_recebidos</c>, SYNC 21.1).</summary>
public sealed record ComandoSincronizacao(Guid Id, string Tipo, DateTimeOffset RecebidoEm, string Status, string? Resultado);

/// <summary>Uma ocorrência do <c>log_local</c> ligada a uma venda ou a um evento (pelo id ou pelo número).</summary>
public sealed record OcorrenciaSincronizacao(DateTimeOffset OcorridoEm, string Nivel, string Origem, string Mensagem);

/// <summary>
/// O detalhe de uma venda não confirmada (ou de qualquer agregado): os eventos dele (inclusive os confirmados), as
/// dependências de cada um com a situação delas aqui e as ocorrências do <c>log_local</c> ligadas. Sem payload.
/// </summary>
public sealed record DetalheSincronizacao(
    AgregadoSincronizacao? Agregado,
    IReadOnlyList<EventoSincronizacao> Eventos,
    IReadOnlyDictionary<Guid, IReadOnlyList<DependenciaSincronizacao>> Dependencias,
    IReadOnlyList<OcorrenciaSincronizacao> Ocorrencias);

/// <summary>
/// Consultas da aba 4 Sincronização da Central do PDV (bloco G7; plano 4 e 5.5; o pedido do dono de 04/11/2026 "vendas a
/// copiar"): as vendas que a nuvem ainda não confirmou (uma linha por venda), os registros do caixa não confirmados
/// (aberturas, sangrias, reforços e fechamentos), o outbox inteiro paginado por situação e tipo, os comandos recebidos e o
/// detalhe de um agregado. Tudo offline, só leitura, <c>AsNoTracking</c>, projeção e um contexto curto por consulta.
/// <b>Nunca</b> lê o <c>payload</c> nem o <c>contexto</c> dos eventos (nem nos tipos devolvidos). As listas entram pelo
/// índice <c>ix_eventos_saida_status</c> (situação, sequência), que já existe: o que não foi confirmado é pouco mesmo com
/// o outbox de anos (nunca expurgado).
/// </summary>
public sealed class ConsultasSincronizacaoLocal(IDbContextFactory<PdvDbContext> fabrica)
{
    /// <summary>Linhas por página (plano 4).</summary>
    public const int TamanhoPagina = 50;

    /// <summary>Comandos do ERP listados (os mais novos; a tabela tem uma linha por comando, poucos por semana).</summary>
    public const int ComandosListados = 100;

    /// <summary>Ocorrências do <c>log_local</c> listadas no detalhe (as mais novas).</summary>
    public const int OcorrenciasListadas = 30;

    /// <summary>Código da recusa por conteúdo divergente (SYNC 8.4): fica em quarentena até o suporte.</summary>
    public const string CodigoEventoDivergente = "EVENTO_DIVERGENTE";

    /// <summary>O agregado de venda dos eventos <c>venda.*</c>.</summary>
    public const string AgregadoVenda = "venda";

    /// <summary>O primeiro evento de toda venda (gravado na finalização; o cancelamento vem depois).</summary>
    private const string TipoVendaFinalizada = "venda.finalizada";

    /// <summary>Os agregados do caixa: a sessão (abertura e fechamento) e o movimento (sangria, reforço e o cancelamento deles).</summary>
    public static readonly IReadOnlyList<string> AgregadosCaixa = ["sessao_caixa", "movimento_caixa"];

    /// <summary>Ainda vão para a nuvem (ou voltam, depois de uma falha): o "a enviar".</summary>
    public static readonly IReadOnlyList<string> StatusAEnviar = [StatusEventoSaida.Pendente, StatusEventoSaida.Enviando, StatusEventoSaida.ErroTemporario];

    /// <summary>Não confirmados: os a enviar e os recusados.</summary>
    private static readonly string[] NaoConfirmados = [.. StatusAEnviar, StatusEventoSaida.Rejeitado];

    /// <summary>
    /// As vendas que a nuvem ainda não confirmou, as recusadas primeiro e depois na ordem de envio (a sequência do primeiro
    /// evento de cada uma, mesmo confirmado). <paramref name="depois"/> é o cursor da página anterior (nulo = a primeira).
    /// A venda cujos eventos não confirmados foram todos descartados no ERP (decisão final) não entra; só conta em
    /// <see cref="PaginaVendasNaoConfirmadas.Descartadas"/>. Entre as páginas, a venda nova vai para o fim e a que tem um
    /// evento confirmado não muda de lugar (a chave é o primeiro evento dela, não o primeiro aberto); a pendente que vira
    /// recusada sobe para o grupo das recusadas, que fica antes do cursor: some das páginas seguintes e aparece na
    /// primeira (F5) — o limite de um cursor que põe as recusadas primeiro.
    /// </summary>
    public async Task<PaginaVendasNaoConfirmadas> VendasNaoConfirmadasAsync(
        CursorNaoConfirmados? depois = null, int tamanho = TamanhoPagina, CancellationToken ct = default)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(tamanho, 1);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var eventos = await NaoConfirmadosAsync(db, [AgregadoVenda], ct);
        var porVenda = eventos.GroupBy(e => e.AgregadoId).ToList();
        var descartadas = porVenda.Count(g => g.All(e => e.Descartado));
        var abertasPorVenda = porVenda
            .Select(g => (Venda: g.Key, Abertos: g.Where(e => !e.Descartado).OrderBy(e => e.Sequencia).ToList()))
            .Where(x => x.Abertos.Count > 0)
            .ToList();
        // A chave da ordem é o primeiro evento da venda, o venda.finalizada. Sem ele entre os abertos (já confirmado, e o
        // cancelamento na fila: poucas), a sequência dele vem pelo índice do agregado.
        var semFinalizada = abertasPorVenda.Where(x => x.Abertos.All(e => e.Tipo != TipoVendaFinalizada)).Select(x => x.Venda).ToList();
        var primeiras = semFinalizada.Count == 0 ? new Dictionary<Guid, long>() : (await db.EventosSaida.AsNoTracking()
                .Where(e => semFinalizada.Contains(e.AgregadoId) && e.AgregadoTipo == AgregadoVenda)
                .Select(e => new { e.AgregadoId, e.SequenciaTerminal })
                .ToListAsync(ct))
            .GroupBy(e => e.AgregadoId)
            .ToDictionary(g => g.Key, g => g.Min(e => e.SequenciaTerminal));
        var abertas = abertasPorVenda
            .Select(x => (x.Venda, x.Abertos, Recusada: x.Abertos.Any(e => e.Recusado),
                Primeira: Math.Min(x.Abertos[0].Sequencia, primeiras.GetValueOrDefault(x.Venda, long.MaxValue))))
            .OrderBy(x => x.Recusada ? 0 : 1)
            .ThenBy(x => x.Primeira)
            .ToList();
        var seguintes = depois is { } c
            ? abertas.Where(x => (x.Recusada ? 0 : 1) > (c.Recusada ? 0 : 1) || ((x.Recusada == c.Recusada) && x.Primeira > c.Sequencia))
            : abertas;
        var pagina = seguintes.Take(tamanho + 1).ToList();
        var proxima = pagina.Count > tamanho ? new CursorNaoConfirmados(pagina[tamanho - 1].Recusada, pagina[tamanho - 1].Primeira) : null;
        pagina = pagina.Take(tamanho).ToList();

        var ids = pagina.Select(x => x.Venda).ToList();
        var vendas = await db.Vendas.AsNoTracking()
            .Where(v => ids.Contains(v.Id))
            .Select(v => new { v.Id, v.NumeroExibicao, v.Total, v.Status, v.OperadorId, Hora = v.FinalizadaEm ?? v.CanceladaEm ?? v.IniciadaEm })
            .ToDictionaryAsync(v => v.Id, ct);
        var linhas = pagina.Select(x =>
        {
            var v = vendas.GetValueOrDefault(x.Venda);
            // O motivo: o do recusado (a decisão é no ERP) ou o do que espera nova tentativa (a falha da última).
            var motivo = x.Abertos.FirstOrDefault(e => e.Recusado)?.UltimoErro ?? x.Abertos.Select(e => e.UltimoErro).FirstOrDefault(m => m is not null);
            return new VendaNaoConfirmada(
                x.Venda,
                v?.NumeroExibicao,
                v?.Hora,
                v?.Total,
                v?.Status,
                v?.OperadorId,
                x.Recusada,
                x.Abertos.Any(e => e.Status == StatusEventoSaida.Enviando),
                x.Abertos.Any(e => e.Recusado && e.Divergente),
                x.Primeira,
                [.. x.Abertos.Select(e => e.Tipo).Distinct()],
                x.Abertos.Max(e => e.Tentativas),
                x.Abertos.Where(e => e.ProximaTentativaEm is not null).Select(e => e.ProximaTentativaEm).Min(),
                motivo,
                x.Abertos.Min(e => e.CriadoEm));
        }).ToList();
        return new PaginaVendasNaoConfirmadas(linhas, abertas.Count, abertas.Count(x => x.Recusada), descartadas, proxima);
    }

    /// <summary>
    /// A segunda seção da aba (o pedido do dono): os registros do caixa que a nuvem ainda não confirmou — abertura e
    /// fechamento (agregado <c>sessao_caixa</c>), sangria, reforço e o cancelamento deles (<c>movimento_caixa</c>) —, os
    /// recusados primeiro e depois na ordem de envio. O descartado no ERP (decisão final) não entra; só conta.
    /// </summary>
    public async Task<PaginaCaixaNaoConfirmado> CaixaNaoConfirmadoAsync(
        CursorNaoConfirmados? depois = null, int tamanho = TamanhoPagina, CancellationToken ct = default)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(tamanho, 1);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var eventos = await NaoConfirmadosAsync(db, AgregadosCaixa, ct);
        var abertos = eventos.Where(e => !e.Descartado).OrderBy(e => e.Recusado ? 0 : 1).ThenBy(e => e.Sequencia).ToList();
        var seguintes = depois is { } c
            ? abertos.Where(e => (e.Recusado ? 0 : 1) > (c.Recusada ? 0 : 1) || (e.Recusado == c.Recusada && e.Sequencia > c.Sequencia))
            : abertos;
        var pagina = seguintes.Take(tamanho + 1).ToList();
        var proxima = pagina.Count > tamanho ? new CursorNaoConfirmados(pagina[tamanho - 1].Recusado, pagina[tamanho - 1].Sequencia) : null;
        return new PaginaCaixaNaoConfirmado(
            [.. pagina.Take(tamanho)], abertos.Count, abertos.Count(e => e.Recusado), eventos.Count(e => e.Descartado), proxima);
    }

    /// <summary>
    /// Das <paramref name="vendas"/>, as que o ERP resolveu: confirmadas (todos os eventos confirmados: a linha que estava
    /// na lista fica verde até a próxima leitura manual) e descartadas (os não confirmados todos descartados no ERP: a
    /// linha fica sem cor, "descartada no ERP", nunca verde — a nuvem não tem a venda). As que continuam abertas, nenhuma.
    /// </summary>
    public async Task<VendasResolvidas> VendasResolvidasAsync(IReadOnlyCollection<Guid> vendas, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(vendas);
        if (vendas.Count == 0)
        {
            return new VendasResolvidas(new HashSet<Guid>(), new HashSet<Guid>());
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var ids = vendas.ToList();
        // Pelo índice do agregado: só as linhas destas vendas (algumas por venda), sem o payload.
        var eventos = await db.EventosSaida.AsNoTracking()
            .Where(e => ids.Contains(e.AgregadoId) && e.AgregadoTipo == AgregadoVenda)
            .Select(e => new { e.AgregadoId, e.Status, Resultado = e.Status == StatusEventoSaida.Rejeitado ? e.Resultado : null })
            .ToListAsync(ct);
        var resolvidas = eventos
            .GroupBy(e => e.AgregadoId)
            .Select(g => (Venda: g.Key, Descartados: g.Count(e => e.Status == StatusEventoSaida.Rejeitado && ConsultasVendaLocal.Descartado(e.Resultado)),
                Confirmados: g.Count(e => e.Status == StatusEventoSaida.Confirmado), Total: g.Count()))
            .Where(x => x.Descartados + x.Confirmados == x.Total)
            .ToList();
        return new VendasResolvidas(
            resolvidas.Where(x => x.Descartados == 0).Select(x => x.Venda).ToHashSet(),
            resolvidas.Where(x => x.Descartados > 0).Select(x => x.Venda).ToHashSet());
    }

    /// <summary>
    /// Quantos recusados há no outbox inteiro, separando os que esperam a decisão do ERP dos já descartados lá (o resumo
    /// da aba: o vermelho é só o que falta resolver). Pelo índice da situação; o <c>resultado</c> só dos recusados.
    /// </summary>
    public async Task<ContagemRecusados> ContagemRecusadosAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var resultados = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Status == StatusEventoSaida.Rejeitado)
            .OrderBy(e => e.SequenciaTerminal)
            .Select(e => e.Resultado)
            .ToListAsync(ct);
        var descartados = resultados.Count(ConsultasVendaLocal.Descartado);
        return new ContagemRecusados(resultados.Count - descartados, descartados);
    }

    /// <summary>
    /// Uma página de eventos com o filtro: nas situações a enviar e recusados, na ordem de envio (sequência crescente);
    /// nas outras, o mais novo primeiro. <paramref name="depois"/> é a sequência da última linha da página anterior.
    /// </summary>
    public async Task<PaginaEventos> EventosAsync(FiltroEventos filtro, long? depois = null, int tamanho = TamanhoPagina, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(filtro);
        ArgumentOutOfRangeException.ThrowIfLessThan(tamanho, 1);
        if (filtro.Tipo is not null && filtro.Situacao is SituacaoFiltroEvento.Confirmados or SituacaoFiltroEvento.Todos)
        {
            // O tipo nos confirmados leria o outbox inteiro (nunca expurgado) atrás de um tipo raro.
            throw new ArgumentException("O filtro de tipo vale só nas situações a enviar e recusados.", nameof(filtro));
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        int quantidade;
        var linhas = new List<LinhaEvento>();
        if (StatusDa(filtro.Situacao) is not { } situacoes)
        {
            // Todos: a contagem pelo índice (sem ler as linhas) e a página pela sequência, do mais novo para trás.
            quantidade = await db.EventosSaida.CountAsync(ct);
            var consulta = Filtrar(db.EventosSaida.AsNoTracking(), filtro);
            if (depois is { } d)
            {
                consulta = consulta.Where(e => e.SequenciaTerminal < d);
            }

            linhas = await Projetar(consulta.OrderByDescending(e => e.SequenciaTerminal).Take(tamanho + 1)).ToListAsync(ct);
        }
        else
        {
            // Uma consulta por situação, com a igualdade (o índice da situação e da sequência dá a ordem): o planejador do
            // SQLite não troca o índice por varrer a tabela, mesmo com as estatísticas de um outbox quase todo confirmado.
            quantidade = 0;
            foreach (var situacao in situacoes)
            {
                var consulta = Filtrar(db.EventosSaida.AsNoTracking().Where(e => e.Status == situacao), filtro);
                quantidade += await consulta.CountAsync(ct);
                if (depois is { } d)
                {
                    consulta = filtro.Crescente ? consulta.Where(e => e.SequenciaTerminal > d) : consulta.Where(e => e.SequenciaTerminal < d);
                }

                consulta = filtro.Crescente ? consulta.OrderBy(e => e.SequenciaTerminal) : consulta.OrderByDescending(e => e.SequenciaTerminal);
                linhas.AddRange(await Projetar(consulta.Take(tamanho + 1)).ToListAsync(ct));
            }

            linhas = [.. (filtro.Crescente ? linhas.OrderBy(l => l.Sequencia) : linhas.OrderByDescending(l => l.Sequencia)).Take(tamanho + 1)];
        }

        var eventos = linhas.Select(Evento).ToList();
        var proxima = eventos.Count > tamanho ? eventos[tamanho - 1].Sequencia : (long?)null;
        return new PaginaEventos(eventos.Take(tamanho).ToList(), quantidade, proxima);
    }

    /// <summary>Os tipos de evento que existem na situação (o filtro "Tipo"), pela ordem do nome.</summary>
    /// <remarks>Só nas situações a enviar e recusados (poucos eventos, pelo índice da situação): nos confirmados seria a tabela inteira.</remarks>
    public async Task<IReadOnlyList<string>> TiposAsync(SituacaoFiltroEvento situacao, CancellationToken ct = default)
    {
        if (situacao is not (SituacaoFiltroEvento.AEnviar or SituacaoFiltroEvento.Recusados))
        {
            return [];
        }

        await using var db = await fabrica.CreateDbContextAsync(ct);
        var tipos = new HashSet<string>(StringComparer.Ordinal);
        foreach (var s in StatusDa(situacao)!)
        {
            tipos.UnionWith(await db.EventosSaida.AsNoTracking().Where(e => e.Status == s).OrderBy(e => e.SequenciaTerminal).Select(e => e.Tipo).ToListAsync(ct));
        }

        return [.. tipos.Order(StringComparer.Ordinal)];
    }

    /// <summary>O que o caixa sabe dos agregados (venda, movimento, sessão), sem abrir o payload dos eventos.</summary>
    public async Task<IReadOnlyDictionary<Guid, AgregadoSincronizacao>> AgregadosAsync(
        IReadOnlyCollection<EventoSincronizacao> eventos, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(eventos);
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await AgregadosAsync(db, eventos.Select(e => (e.AgregadoTipo, e.AgregadoId)), ct);
    }

    /// <summary>
    /// O detalhe de um agregado (a venda das "vendas a copiar", ou o agregado de um evento): todos os eventos dele, as
    /// dependências de cada um com a situação delas aqui e as ocorrências do <c>log_local</c> que citam a venda (pelo id,
    /// pelo número) ou um dos eventos (pelo id). Nulo quando o caixa não tem evento nenhum do agregado.
    /// </summary>
    public async Task<DetalheSincronizacao?> DetalheAsync(Guid agregadoId, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linhas = await Projetar(db.EventosSaida.AsNoTracking().Where(e => e.AgregadoId == agregadoId).OrderBy(e => e.SequenciaTerminal))
            .ToListAsync(ct);
        if (linhas.Count == 0)
        {
            return null;
        }

        var eventos = linhas.Select(Evento).ToList();
        var agregado = (await AgregadosAsync(db, [(eventos[0].AgregadoTipo, agregadoId)], ct)).GetValueOrDefault(agregadoId);

        // As dependências (poucas linhas, só a coluna delas): o agregado e a situação do último evento dele aqui.
        var ids = eventos.Select(e => e.Id).ToList();
        var json = await db.EventosSaida.AsNoTracking().Where(e => ids.Contains(e.Id)).Select(e => new { e.Id, e.Dependencias }).ToListAsync(ct);
        var porEvento = json.ToDictionary(x => x.Id, x => LerDependencias(x.Dependencias));
        var agregados = porEvento.Values.SelectMany(d => d).Select(d => d.AgregadoId).Distinct().ToList();
        var situacoes = agregados.Count == 0 ? new Dictionary<Guid, string>() : (await db.EventosSaida.AsNoTracking()
                .Where(e => agregados.Contains(e.AgregadoId))
                .Select(e => new { e.AgregadoId, e.SequenciaTerminal, e.Status })
                .ToListAsync(ct))
            .GroupBy(e => e.AgregadoId)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(e => e.SequenciaTerminal).First().Status);
        var dependencias = porEvento.ToDictionary(
            p => p.Key,
            p => (IReadOnlyList<DependenciaSincronizacao>)[.. p.Value.Select(d => new DependenciaSincronizacao(d.AgregadoTipo, d.AgregadoId, situacoes.GetValueOrDefault(d.AgregadoId)))]);

        // As ocorrências ligadas: a partir de um pouco antes do primeiro evento (pelo índice da hora), as que citam a venda
        // (o id ou o número de exibição) ou um dos eventos (o id).
        var desde = eventos.Min(e => e.CriadoEm).AddMinutes(-5);
        var termos = new List<string> { agregadoId.ToString() };
        termos.AddRange(ids.Select(i => i.ToString()));
        if (agregado?.NumeroVenda is { Length: > 0 } numero)
        {
            termos.Add(numero);
        }

        var candidatas = await db.LogLocal.AsNoTracking()
            .Where(l => l.OcorridoEm >= desde)
            .OrderByDescending(l => l.OcorridoEm)
            .ThenByDescending(l => l.Id)
            .Select(l => new { l.OcorridoEm, l.Nivel, l.Origem, l.Mensagem, l.Detalhes })
            .Take(5_000)
            .ToListAsync(ct);
        var ocorrencias = candidatas
            .Where(l => termos.Any(t => l.Mensagem.Contains(t, StringComparison.OrdinalIgnoreCase)
                                        || (l.Detalhes?.Contains(t, StringComparison.OrdinalIgnoreCase) ?? false)))
            .Take(OcorrenciasListadas)
            .Select(l => new OcorrenciaSincronizacao(l.OcorridoEm, l.Nivel, l.Origem, l.Mensagem))
            .ToList();
        return new DetalheSincronizacao(agregado, eventos, dependencias, ocorrencias);
    }

    /// <summary>Os comandos recebidos do ERP, o mais novo primeiro (até <see cref="ComandosListados"/>), e quantos há.</summary>
    public async Task<(IReadOnlyList<ComandoSincronizacao> Comandos, int Quantidade)> ComandosAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var quantidade = await db.ComandosRecebidos.CountAsync(ct);
        var comandos = await db.ComandosRecebidos.AsNoTracking()
            .OrderByDescending(c => c.RecebidoEm)
            .Take(ComandosListados)
            .Select(c => new ComandoSincronizacao(c.ComandoId, c.Tipo, c.RecebidoEm, c.Status, c.Resultado))
            .ToListAsync(ct);
        return (comandos, quantidade);
    }

    /// <summary>
    /// Os eventos não confirmados (a enviar e recusados) dos agregados, uma consulta por situação pelo índice dela (a
    /// igualdade e a ordem da sequência); o resultado só dos recusados.
    /// </summary>
    private static async Task<List<EventoSincronizacao>> NaoConfirmadosAsync(PdvDbContext db, IReadOnlyList<string> agregados, CancellationToken ct)
    {
        var linhas = new List<LinhaEvento>();
        foreach (var situacao in NaoConfirmados)
        {
            linhas.AddRange(await Projetar(db.EventosSaida.AsNoTracking()
                    .Where(e => e.Status == situacao && agregados.Contains(e.AgregadoTipo))
                    .OrderBy(e => e.SequenciaTerminal))
                .ToListAsync(ct));
        }

        return [.. linhas.Select(Evento)];
    }

    /// <summary>As situações do outbox de cada filtro; nulo em "todos".</summary>
    private static IReadOnlyList<string>? StatusDa(SituacaoFiltroEvento situacao) => situacao switch
    {
        SituacaoFiltroEvento.AEnviar => StatusAEnviar,
        SituacaoFiltroEvento.Recusados => [StatusEventoSaida.Rejeitado],
        SituacaoFiltroEvento.Confirmados => [StatusEventoSaida.Confirmado],
        _ => null,
    };

    /// <summary>O tipo e os agregados do filtro (a situação fica com quem chama, uma consulta por situação).</summary>
    private static IQueryable<EventoSaida> Filtrar(IQueryable<EventoSaida> consulta, FiltroEventos filtro)
    {
        if (filtro.Tipo is { } tipo)
        {
            consulta = consulta.Where(e => e.Tipo == tipo);
        }

        if (filtro.AgregadoTipos is { } agregados)
        {
            consulta = consulta.Where(e => agregados.Contains(e.AgregadoTipo));
        }

        return consulta;
    }

    /// <summary>As colunas que a aba mostra; o <c>resultado</c> só do recusado (o descartado), nunca o payload nem o contexto.</summary>
    private static IQueryable<LinhaEvento> Projetar(IQueryable<EventoSaida> consulta) => consulta.Select(e => new LinhaEvento(
        e.Id, e.SequenciaTerminal, e.Tipo, e.AgregadoTipo, e.AgregadoId, e.OcorridoEm, e.CriadoEm, e.Status, e.Tentativas, e.EnviadoEm,
        e.ProximaTentativaEm, e.UltimoErro, e.ConfirmadoEm, e.Status == StatusEventoSaida.Rejeitado ? e.Resultado : null));

    private static EventoSincronizacao Evento(LinhaEvento l) => new(
        l.Id, l.Sequencia, l.Tipo, l.AgregadoTipo, l.AgregadoId, l.OcorridoEm, l.CriadoEm, l.Status, l.Tentativas, l.EnviadoEm,
        l.ProximaTentativaEm, l.UltimoErro, l.ConfirmadoEm,
        l.Status == StatusEventoSaida.Rejeitado && ConsultasVendaLocal.Descartado(l.ResultadoRecusado),
        l.Status == StatusEventoSaida.Rejeitado && l.UltimoErro?.StartsWith(CodigoEventoDivergente + ":", StringComparison.Ordinal) == true);

    private static async Task<Dictionary<Guid, AgregadoSincronizacao>> AgregadosAsync(
        PdvDbContext db, IEnumerable<(string Tipo, Guid Id)> agregados, CancellationToken ct)
    {
        var lista = agregados.Distinct().ToList();
        var vendas = lista.Where(a => a.Tipo == AgregadoVenda).Select(a => a.Id).ToList();
        var movimentos = lista.Where(a => a.Tipo == "movimento_caixa").Select(a => a.Id).ToList();
        var sessoes = lista.Where(a => a.Tipo == "sessao_caixa").Select(a => a.Id).ToList();
        var resultado = new Dictionary<Guid, AgregadoSincronizacao>();
        if (vendas.Count > 0)
        {
            foreach (var v in await db.Vendas.AsNoTracking().Where(v => vendas.Contains(v.Id))
                         .Select(v => new { v.Id, v.NumeroExibicao, v.Total, v.NumeroCaixa, Hora = v.FinalizadaEm ?? v.CanceladaEm ?? v.IniciadaEm, v.OperadorId })
                         .ToListAsync(ct))
            {
                resultado[v.Id] = new AgregadoSincronizacao(v.Id, NumeroVenda: v.NumeroExibicao, Valor: v.Total, NumeroCaixa: v.NumeroCaixa, Quando: v.Hora, OperadorId: v.OperadorId);
            }
        }

        if (movimentos.Count > 0)
        {
            foreach (var m in await db.MovimentosCaixa.AsNoTracking().Where(m => movimentos.Contains(m.Id))
                         .Select(m => new { m.Id, m.Tipo, m.Valor, m.Cancelado, m.NumeroCaixa, m.OcorridoEm, m.OperadorId })
                         .ToListAsync(ct))
            {
                resultado[m.Id] = new AgregadoSincronizacao(m.Id, Valor: m.Valor, TipoMovimento: m.Tipo, MovimentoCancelado: m.Cancelado, NumeroCaixa: m.NumeroCaixa,
                    Quando: m.OcorridoEm, OperadorId: m.OperadorId);
            }
        }

        if (sessoes.Count > 0)
        {
            foreach (var s in await db.SessoesCaixa.AsNoTracking().Where(s => sessoes.Contains(s.Id))
                         .Select(s => new { s.Id, s.NumeroCaixa, s.AbertaEm, s.OperadorId, s.FundoTroco })
                         .ToListAsync(ct))
            {
                resultado[s.Id] = new AgregadoSincronizacao(s.Id, Valor: s.FundoTroco, NumeroCaixa: s.NumeroCaixa, Quando: s.AbertaEm, OperadorId: s.OperadorId);
            }
        }

        return resultado;
    }

    /// <summary>O JSON das dependências do envelope (<c>[{"agregado_tipo", "agregado_id"}]</c>); o malformado vira lista vazia.</summary>
    internal static IReadOnlyList<(string AgregadoTipo, Guid AgregadoId)> LerDependencias(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return [];
        }

        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            var lista = new List<(string, Guid)>();
            foreach (var d in doc.RootElement.EnumerateArray())
            {
                if (d.ValueKind == JsonValueKind.Object
                    && d.TryGetProperty("agregado_tipo", out var t) && t.ValueKind == JsonValueKind.String
                    && d.TryGetProperty("agregado_id", out var i) && i.ValueKind == JsonValueKind.String && Guid.TryParse(i.GetString(), out var id))
                {
                    lista.Add((t.GetString()!, id));
                }
            }

            return lista;
        }
        catch (JsonException)
        {
            return [];
        }
    }

    /// <summary>A linha lida do outbox (sem o payload e o contexto; o resultado só do recusado).</summary>
    private sealed record LinhaEvento(
        Guid Id,
        long Sequencia,
        string Tipo,
        string AgregadoTipo,
        Guid AgregadoId,
        DateTimeOffset OcorridoEm,
        DateTimeOffset CriadoEm,
        string Status,
        int Tentativas,
        DateTimeOffset? EnviadoEm,
        DateTimeOffset? ProximaTentativaEm,
        string? UltimoErro,
        DateTimeOffset? ConfirmadoEm,
        string? ResultadoRecusado);
}
