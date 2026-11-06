using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Repositorios;

/// <summary>
/// Um evento do outbox como o <c>outbox.csv</c> do pacote de suporte o leva (Central do PDV, bloco G9; plano 4.6): o tipo,
/// a sequência, a situação, as tentativas, as datas, o último erro, as dependências (os agregados que precisam estar na
/// nuvem antes: tipo e id, nada do conteúdo) e se o ERP o descartou. <b>Nunca</b> o <c>payload</c>, o <c>contexto</c> nem o
/// <c>resultado</c> da nuvem (o tipo não tem essas propriedades e a consulta não lê essas colunas; o <c>resultado</c> só
/// do recusado, para o "descartado", como a aba 4).
/// </summary>
public sealed record EventoPacote(
    Guid Id,
    long Sequencia,
    string Tipo,
    string AgregadoTipo,
    Guid AgregadoId,
    string Status,
    int Tentativas,
    DateTimeOffset OcorridoEm,
    DateTimeOffset CriadoEm,
    DateTimeOffset? EnviadoEm,
    DateTimeOffset? ProximaTentativaEm,
    DateTimeOffset? ConfirmadoEm,
    Guid? LoteEnvioId,
    string? UltimoErro,
    string Dependencias,
    bool Descartado);

/// <summary>
/// Os eventos do outbox no pacote: todos os não confirmados (a enviar e recusados) até <paramref name="Limite"/> por
/// situação e os <c>confirmados</c> mais novos; <see cref="ConfirmadosTotal"/> diz quantos confirmados existem (o outbox
/// nunca é expurgado: o pacote leva só o fim dele).
/// </summary>
public sealed record OutboxPacote(IReadOnlyList<EventoPacote> Eventos, IReadOnlyDictionary<string, int> PorSituacao, int ConfirmadosTotal);

/// <summary>Um documento da fila de impressão no <c>fila-impressao.csv</c>: <b>sem os bytes</b> (o cupom tem CPF e o QR do PIX).</summary>
public sealed record ImpressaoPacote(
    Guid Id,
    string TipoDocumento,
    Guid? ReferenciaId,
    string Impressora,
    int Vias,
    string Status,
    int Tentativas,
    string? UltimoErro,
    DateTimeOffset CriadoEm,
    DateTimeOffset? ImpressoEm);

/// <summary>A identidade do terminal no manifesto: <b>sem o token</b> (o tipo não tem a coluna; a consulta não a lê).</summary>
public sealed record IdentidadePacote(
    Guid TerminalId,
    int EmpresaCodigo,
    Guid LojaId,
    int NumeroCaixa,
    string UrlApi,
    string Status,
    DateTimeOffset AtivadoEm,
    string NomeMaquina,
    bool Demonstracao,
    DateTimeOffset? UltimoBackupEm,
    DateTimeOffset? RestauradoEm)
{
    /// <summary>O código curto do terminal (<c>cx2-9f3a01bc</c>, o mesmo do <see cref="IdentidadeTerminal.CodigoCurto"/>).</summary>
    public string CodigoCurto => new IdentidadeTerminal { TerminalId = TerminalId, NumeroCaixa = NumeroCaixa }.CodigoCurto;
}

/// <summary>
/// As leituras do pacote de suporte da Central do PDV (bloco G9; plano 4.6; README › decisão 76): só leitura,
/// <c>AsNoTracking</c>, projeção e um contexto curto por consulta, como as abas. <b>Lista de permitidos</b>: cada consulta
/// lê só as colunas que o pacote leva — nunca o <c>payload</c>/<c>contexto</c>/<c>resultado</c> do outbox, os bytes da
/// impressão, o <c>token_protegido</c> da identidade nem as chaves internas do terminal
/// (<see cref="ChavesConfiguracaoTerminal.Internas"/>: o filtro é pela <see cref="ChavesExibiveis"/>, no SQL). O resto (o
/// mascaramento, o CSV, o zip) é do App. Toda consulta entra por um índice que já existe: o outbox pela situação
/// (<c>ix_eventos_saida_status</c>, uma consulta por situação, com a igualdade, como a aba 4), a fila pela situação e a hora
/// (<c>ix_fila_impressao_status</c>), o <c>log_local</c> pela hora (<c>ix_log_local_ocorrido_em</c>) e a auditoria pela
/// hora (<c>ix_log_auditoria_local_ocorrido_em</c>). Nenhuma migração.
/// </summary>
public sealed class ConsultasPacoteSuporte(IDbContextFactory<PdvDbContext> fabrica)
{
    /// <summary>Eventos não confirmados levados por situação (uns dias sem internet dão uns poucos milhares).</summary>
    public const int LimiteNaoConfirmados = 20_000;

    /// <summary>Confirmados levados (os mais novos): o resto está na nuvem, e o outbox nunca é expurgado.</summary>
    public const int ConfirmadosLevados = 2_000;

    /// <summary>Documentos da fila de impressão levados por situação (os mais novos).</summary>
    public const int ImpressoesPorSituacao = 500;

    /// <summary>Ocorrências do <c>log_local</c> levadas (as mais novas do período).</summary>
    public const int LimiteOcorrencias = 20_000;

    /// <summary>Registros da auditoria contados (os mais novos do período; a contagem por ação e dia, nada do conteúdo).</summary>
    public const int LimiteAuditoria = 100_000;

    /// <summary>As situações da fila de impressão (o <c>ck_fila_impressao_status</c>).</summary>
    public static readonly IReadOnlyList<string> SituacoesImpressao = ["pendente", "imprimindo", "falhou", "impresso", "cancelado"];

    /// <summary>A identidade sem o token; nula com o terminal ainda não ativado.</summary>
    public async Task<IdentidadePacote?> IdentidadeAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.IdentidadeTerminal.AsNoTracking()
            .Select(i => new IdentidadePacote(
                i.TerminalId, i.EmpresaCodigo, i.LojaId, i.NumeroCaixa, i.UrlApi, i.Status, i.AtivadoEm, i.NomeMaquina, i.UrlApi == IdentidadeTerminal.UrlDemonstracao,
                i.UltimoBackupEm, i.RestauradoEm))
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// O outbox sem o conteúdo: todos os não confirmados (até <see cref="LimiteNaoConfirmados"/> por situação, na ordem de
    /// envio) e os <see cref="ConfirmadosLevados"/> confirmados mais novos, com a contagem por situação (pelo índice, sem ler
    /// as linhas).
    /// </summary>
    public async Task<OutboxPacote> OutboxAsync(int confirmados = ConfirmadosLevados, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var eventos = new List<EventoPacote>();
        var porSituacao = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var situacao in StatusEventoSaida.Todos)
        {
            var daSituacao = db.EventosSaida.AsNoTracking().Where(e => e.Status == situacao);
            porSituacao[situacao] = await daSituacao.CountAsync(ct);
            var ordem = situacao == StatusEventoSaida.Confirmado
                ? daSituacao.OrderByDescending(e => e.SequenciaTerminal).Take(confirmados)
                : daSituacao.OrderBy(e => e.SequenciaTerminal).Take(LimiteNaoConfirmados);
            var linhas = await ordem.Select(e => new
            {
                e.Id,
                e.SequenciaTerminal,
                e.Tipo,
                e.AgregadoTipo,
                e.AgregadoId,
                e.Status,
                e.Tentativas,
                e.OcorridoEm,
                e.CriadoEm,
                e.EnviadoEm,
                e.ProximaTentativaEm,
                e.ConfirmadoEm,
                e.LoteEnvioId,
                e.UltimoErro,
                e.Dependencias,
                Resultado = e.Status == StatusEventoSaida.Rejeitado ? e.Resultado : null,
            }).ToListAsync(ct);
            eventos.AddRange(linhas.Select(l => new EventoPacote(
                l.Id, l.SequenciaTerminal, l.Tipo, l.AgregadoTipo, l.AgregadoId, l.Status, l.Tentativas, l.OcorridoEm, l.CriadoEm, l.EnviadoEm,
                l.ProximaTentativaEm, l.ConfirmadoEm, l.LoteEnvioId, l.UltimoErro, l.Dependencias,
                l.Status == StatusEventoSaida.Rejeitado && ConsultasVendaLocal.Descartado(l.Resultado))));
        }

        return new OutboxPacote([.. eventos.OrderBy(e => e.Sequencia)], porSituacao, porSituacao.GetValueOrDefault(StatusEventoSaida.Confirmado));
    }

    /// <summary>A fila de impressão sem os bytes: os <see cref="ImpressoesPorSituacao"/> mais novos de cada situação.</summary>
    public async Task<IReadOnlyList<ImpressaoPacote>> FilaImpressaoAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linhas = new List<ImpressaoPacote>();
        foreach (var situacao in SituacoesImpressao)
        {
            linhas.AddRange(await db.FilaImpressao.AsNoTracking()
                .Where(f => f.Status == situacao)
                .OrderByDescending(f => f.CriadoEm)
                .Take(ImpressoesPorSituacao)
                .Select(f => new ImpressaoPacote(f.Id, f.TipoDocumento, f.ReferenciaId, f.Impressora, f.Vias, f.Status, f.Tentativas, f.UltimoErro, f.CriadoEm, f.ImpressoEm))
                .ToListAsync(ct));
        }

        return [.. linhas.OrderByDescending(l => l.CriadoEm)];
    }

    /// <summary>As ocorrências do <c>log_local</c> desde <paramref name="desde"/>, a mais nova primeiro (até <see cref="LimiteOcorrencias"/>).</summary>
    public async Task<IReadOnlyList<OcorrenciaLocal>> OcorrenciasAsync(DateTimeOffset desde, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        return await db.LogLocal.AsNoTracking()
            .Where(l => l.OcorridoEm >= desde)
            .OrderByDescending(l => l.OcorridoEm)
            .ThenByDescending(l => l.Id)
            .Take(LimiteOcorrencias)
            .Select(l => new OcorrenciaLocal(l.Id, l.OcorridoEm, l.Nivel, l.Origem, l.Mensagem, l.Detalhes))
            .ToListAsync(ct);
    }

    /// <summary>
    /// A ação e a hora de cada registro da auditoria desde <paramref name="desde"/> (o <c>auditoria-resumo.csv</c> conta por
    /// ação e dia): <b>sem</b> quem, o motivo, a descrição nem o antes/depois.
    /// </summary>
    public async Task<IReadOnlyList<(string Acao, DateTimeOffset OcorridoEm)>> AuditoriaAsync(DateTimeOffset desde, CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linhas = await db.LogAuditoriaLocal.AsNoTracking()
            .Where(a => a.OcorridoEm >= desde)
            .OrderByDescending(a => a.OcorridoEm)
            .Take(LimiteAuditoria)
            .Select(a => new { a.Acao, a.OcorridoEm })
            .ToListAsync(ct);
        return [.. linhas.Select(l => (l.Acao, l.OcorridoEm))];
    }

    /// <summary>
    /// A configuração deste computador (<c>configuracao_terminal</c>) só das chaves exibíveis (<see cref="ChavesExibiveis"/>,
    /// no SQL: as internas — chave de backup, chave privada, token pendente — nunca são lidas), em JSON como está gravada.
    /// </summary>
    public async Task<IReadOnlyList<(string Chave, string Valor, DateTimeOffset AtualizadoEm)>> ConfiguracaoTerminalAsync(CancellationToken ct = default)
    {
        var exibiveis = ChavesExibiveis.Todas.Where(ChavesExibiveis.Exibivel).ToList();
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var linhas = await db.ConfiguracaoTerminal.AsNoTracking()
            .Where(c => exibiveis.Contains(c.Chave))
            .OrderBy(c => c.Chave)
            .Select(c => new { c.Chave, c.Valor, c.AtualizadoEm })
            .ToListAsync(ct);
        return [.. linhas.Select(l => (l.Chave, l.Valor, l.AtualizadoEm))];
    }
}
