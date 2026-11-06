using GenesisPDV.Data;
using GenesisPDV.Data.Entidades;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Sync.Cliente;

/// <summary>Cursor de um fluxo do pull (<c>estado_sincronizacao</c>).</summary>
public sealed record CursorFluxo(string Fluxo, long Cursor, DateTimeOffset? UltimoPullSucessoEm, string? UltimoErro);

/// <summary>Evento recusado pela nuvem (<c>rejeitado</c>, quarentena: SYNC 7.5, 11.2) com o erro devolvido.</summary>
public sealed record EventoQuarentena(long Sequencia, string Tipo, DateTimeOffset OcorridoEm, string? Erro);

/// <summary>
/// "F11 › S" (PDV 30.2; Fase 1C, bloco C10b): status detalhado da sincronização, só leitura do banco local — último
/// pull e push com sucesso, cursor por fluxo, pendentes por tipo, eventos em quarentena (com o erro), desvio do relógio
/// e a fila de impressão. A fila de NFC-e em contingência chega com a NFC-e (1D).
/// </summary>
public sealed record StatusDetalhadoSync(
    DateTimeOffset? UltimoPullSucessoEm,
    DateTimeOffset? UltimoPushSucessoEm,
    DateTimeOffset? UltimoHeartbeatEm,
    long? DesvioRelogioMs,
    IReadOnlyList<CursorFluxo> Cursores,
    IReadOnlyDictionary<string, int> PendentesPorTipo,
    IReadOnlyList<EventoQuarentena> Quarentena,
    int QuarentenaTotal,
    int FilaImpressao)
{
    /// <summary>Quantos eventos em quarentena a tela lista (o total aparece ao lado).</summary>
    public const int QuarentenaListada = 20;

    private static readonly string[] Pendentes = [StatusEventoSaida.Pendente, StatusEventoSaida.Enviando, StatusEventoSaida.ErroTemporario];

    public static async Task<StatusDetalhadoSync> LerAsync(PdvDbContext db, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        var conexao = await db.EstadoConexao.AsNoTracking().FirstOrDefaultAsync(ct);
        var cursores = (await db.EstadoSincronizacao.AsNoTracking().ToListAsync(ct))
            .OrderBy(c => Array.IndexOf(EstadoSincronizacao.Fluxos, c.Fluxo) is var i and >= 0 ? i : int.MaxValue)
            .Select(c => new CursorFluxo(c.Fluxo, c.Cursor, c.UltimoPullSucessoEm, c.UltimoErro))
            .ToList();
        var pendentes = (await db.EventosSaida.AsNoTracking()
                .Where(e => Pendentes.Contains(e.Status))
                .GroupBy(e => e.Tipo)
                .Select(g => new { Tipo = g.Key, Quantidade = g.Count() })
                .ToListAsync(ct))
            .OrderBy(p => p.Tipo, StringComparer.Ordinal)
            .ToDictionary(p => p.Tipo, p => p.Quantidade, StringComparer.Ordinal);
        var quarentenaTotal = await db.EventosSaida.CountAsync(e => e.Status == StatusEventoSaida.Rejeitado, ct);
        var quarentena = await db.EventosSaida.AsNoTracking()
            .Where(e => e.Status == StatusEventoSaida.Rejeitado)
            .OrderBy(e => e.SequenciaTerminal)
            .Take(QuarentenaListada)
            .Select(e => new EventoQuarentena(e.SequenciaTerminal, e.Tipo, e.OcorridoEm, e.UltimoErro))
            .ToListAsync(ct);
        // O ciclo não grava `ultimo_push_sucesso_em`: vale a última confirmação de evento (o push que a nuvem aceitou).
        var ultimaConfirmacao = await db.EventosSaida.AsNoTracking()
            .Where(e => e.ConfirmadoEm != null)
            .OrderByDescending(e => e.ConfirmadoEm)
            .Select(e => e.ConfirmadoEm)
            .FirstOrDefaultAsync(ct);
        var impressao = await db.FilaImpressao.CountAsync(f => f.Status == "pendente" || f.Status == "falhou", ct);
        return new StatusDetalhadoSync(
            cursores.Max(c => c.UltimoPullSucessoEm),
            conexao?.UltimoPushSucessoEm ?? ultimaConfirmacao,
            conexao?.UltimoHeartbeatEm,
            conexao?.DesvioRelogioMs,
            cursores,
            pendentes,
            quarentena,
            quarentenaTotal,
            impressao);
    }
}
