using System.Text.Json;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using Microsoft.EntityFrameworkCore;

namespace GenesisPDV.Data.Backup;

/// <summary>
/// Salto da numeração depois de restaurar um backup ou de uma perda provável (SYNC 22.1; PDV 32.5; Fase 1C, C17): a
/// idempotência do push evita duplicar <b>eventos</b>, não a reutilização de <b>números</b> de venda e vale que o caixa
/// gerou entre o backup e a perda e que nunca subiram. A NFC-e (série nova ou +500) chega com a emissão, na 1D.
/// </summary>
public static class SaltoNumeracao
{
    /// <summary>Salto de venda e vale (22.1).</summary>
    public const long Margem = 1000;

    /// <summary>
    /// "Modo restaurado" offline (22.1): restauração pendente sem o salto ainda aplicado → venda e vale saltam
    /// <see cref="Margem"/> sobre o número local, uma vez, na mesma transação da reserva da primeira venda (o
    /// handshake online, que saberia mais, ainda não veio). Devolve se aplicou.
    /// </summary>
    public static async Task<bool> AplicarOfflineSePendenteAsync(PdvDbContext db, DateTimeOffset agora, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        var linha = await db.ConfiguracaoTerminal.FirstOrDefaultAsync(c => c.Chave == ChavesConfiguracaoTerminal.RestauracaoPendente, ct);
        if (linha is null || JsonSerializer.Deserialize<RestauracaoPendente>(linha.Valor) is not { SaltoAplicadoEm: null } pendente)
        {
            return false;
        }

        var saltos = await SaltarAsync(db, agora, _ => 0, ct);
        linha.Valor = JsonSerializer.Serialize(pendente with { SaltoAplicadoEm = agora });
        linha.AtualizadoEm = agora;
        db.LogLocal.Add(Ocorrencias.Nova(
            agora, NiveisOcorrencia.Aviso, CodigoOcorrencia.RestauradoOffline,
            $"Modo restaurado (SYNC 22.1): numeração saltou {Margem} sem o handshake online ({saltos})."));
        return true;
    }

    /// <summary>
    /// Venda e vale vão para <c>max(local, piso) + </c><see cref="Margem"/> (o <paramref name="piso"/> por chave, o que a
    /// nuvem sabe: <c>numeracoes</c> com o informado pelo heartbeat). As linhas que não existem são criadas. Devolve o
    /// resumo para o log (<c>venda 126→1126, vale 8→1008</c>).
    /// </summary>
    public static async Task<string> SaltarAsync(PdvDbContext db, DateTimeOffset agora, Func<string, long> piso, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(piso);
        var partes = new List<string>();
        foreach (var chave in new[] { SequenciaLocal.Venda, SequenciaLocal.Vale })
        {
            var sequencia = await db.SequenciasLocais.FirstOrDefaultAsync(s => s.Chave == chave, ct);
            if (sequencia is null)
            {
                sequencia = new SequenciaLocal { Chave = chave };
                db.SequenciasLocais.Add(sequencia);
            }

            var antes = sequencia.UltimoValor;
            sequencia.UltimoValor = Math.Max(antes, piso(chave)) + Margem;
            sequencia.AtualizadoEm = agora;
            partes.Add($"{chave} {antes}→{sequencia.UltimoValor}");
        }

        return string.Join(", ", partes);
    }
}
