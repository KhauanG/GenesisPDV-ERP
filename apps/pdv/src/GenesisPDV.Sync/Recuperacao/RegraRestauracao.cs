using System.Globalization;
using System.Text.Json;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data;
using GenesisPDV.Data.Backup;
using GenesisPDV.Data.Entidades;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Protocolo;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace GenesisPDV.Sync.Recuperacao;

/// <summary>Os números locais que a regra da 22.1 compara com a nuvem.</summary>
public sealed record NumerosLocais(long Evento, long Venda, long Vale);

/// <summary>Desfecho da regra no handshake: se saltou, por quê, e o texto do log.</summary>
public sealed record DesfechoRestauracao(bool Saltou, string Motivo, string Detalhe);

/// <summary>
/// Regra de numeração depois de restaurar, de regressão ou de perda provável (SYNC 5, 22.1; PDV 32.5; Fase 1C, C17),
/// aplicada no handshake online, depois da reidratação. Salto obrigatório de +1000 em venda e vale sobre
/// <c>greatest(local, numeracoes, informado por heartbeat)</c> (o <c>numeracoes</c> do <c>/sync/estado</c> já é o maior
/// entre o recebido e o informado) quando houve regressão, perda provável ou restauração — esta, salvo a <b>prova de que
/// nada se perdeu</b>: (a) nenhum heartbeat depois do <c>ultimo_backup_em</c> do arquivo, (b) os números locais ≥ os da
/// nuvem e ≥ a <c>ultima_sequencia_gerada</c> informada e (c) o arquivo é o backup de saída com o <c>encerramento.json</c>
/// conferido. Se o "modo restaurado" offline já saltou (<see cref="RestauracaoPendente.SaltoAplicadoEm"/>), o salto online
/// só se repete quando a nuvem conhece um número acima do local. Na perda provável de eventos (a sequência local abaixo da
/// <c>ultima_sequencia_gerada</c> informada), a sequência local vai até a informada: os eventos perdidos viram a lacuna
/// que o supervisor declara (8.6), e não números reaproveitados. A NFC-e (série nova ou +500) é da 1D.
/// </summary>
public static class RegraRestauracao
{
    public const string MotivoRegressao = "regressao";
    public const string MotivoPerdaProvavel = "perda_provavel";
    public const string MotivoRestauracao = "restauracao";
    public const string MotivoProva = "prova_de_que_nada_se_perdeu";
    public const string MotivoSaltoOffline = "salto_offline_suficiente";

    /// <summary>A sequência ou a numeração local está abaixo do que o terminal já informou ou a nuvem já recebeu (SYNC 5).</summary>
    public static bool PerdaProvavel(RespostaEstado estado, NumerosLocais local)
    {
        ArgumentNullException.ThrowIfNull(estado);
        ArgumentNullException.ThrowIfNull(local);
        return local.Evento < estado.InformadoPeloTerminal.UltimaSequenciaGerada
               || local.Venda < estado.Numeracoes.Venda.UltimoNumero
               || local.Vale < estado.Numeracoes.Vale.UltimoNumero;
    }

    /// <summary>As três condições da prova de que nada se perdeu (22.1), com os números locais já reidratados.</summary>
    public static bool ProvaDeQueNadaSePerdeu(RestauracaoPendente restauracao, RespostaEstado estado, NumerosLocais local)
    {
        ArgumentNullException.ThrowIfNull(restauracao);
        ArgumentNullException.ThrowIfNull(estado);
        var heartbeat = estado.InformadoPeloTerminal.UltimoHeartbeatEm is { } h
            ? DateTimeOffset.Parse(h, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal)
            : (DateTimeOffset?)null;
        var semHeartbeatDepois = heartbeat is null || (restauracao.UltimoBackupEm is { } backup && heartbeat <= backup);
        return restauracao.BackupDeSaida && semHeartbeatDepois && !PerdaProvavel(estado, local)
               && local.Evento >= estado.SequenciaTerminal.UltimaRecebida;
    }

    /// <summary>
    /// Aplica a regra numa transação: o salto (ou não), a sequência de eventos na informada (perda provável de eventos), a
    /// restauração pendente apagada e o <c>log_local</c>. Sem regressão, perda nem restauração pendente, não faz nada.
    /// </summary>
    public static async Task<DesfechoRestauracao?> AplicarAsync(
        PdvDbContext db, RespostaEstado estado, bool houveRegressao, IRelogio relogio, ILogger log, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(estado);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var linha = await db.ConfiguracaoTerminal.FirstOrDefaultAsync(c => c.Chave == ChavesConfiguracaoTerminal.RestauracaoPendente, ct);
        var restauracao = linha is null ? null : JsonSerializer.Deserialize<RestauracaoPendente>(linha.Valor);
        var sequencias = await db.SequenciasLocais.ToDictionaryAsync(s => s.Chave, ct);
        long Local(string chave) => sequencias.TryGetValue(chave, out var s) ? s.UltimoValor : 0;
        var local = new NumerosLocais(Local(SequenciaLocal.Evento), Local(SequenciaLocal.Venda), Local(SequenciaLocal.Vale));
        var perda = PerdaProvavel(estado, local);
        if (!houveRegressao && !perda && restauracao is null)
        {
            return null;
        }

        var agora = relogio.Agora;
        string motivo;
        var saltar = true;
        if (houveRegressao)
        {
            motivo = MotivoRegressao;
        }
        else if (perda)
        {
            motivo = MotivoPerdaProvavel;
        }
        else if (ProvaDeQueNadaSePerdeu(restauracao!, estado, local))
        {
            motivo = MotivoProva;
            saltar = false;
        }
        else
        {
            motivo = MotivoRestauracao;
        }

        // O modo restaurado offline já saltou +1000 sobre o backup: basta não haver número da nuvem acima do local.
        if (saltar && restauracao?.SaltoAplicadoEm is not null
            && local.Venda > estado.Numeracoes.Venda.UltimoNumero && local.Vale >= estado.Numeracoes.Vale.UltimoNumero)
        {
            motivo = MotivoSaltoOffline;
            saltar = false;
        }

        var detalhe = saltar
            ? await SaltoNumeracao.SaltarAsync(db, agora, chave => chave == SequenciaLocal.Venda
                ? estado.Numeracoes.Venda.UltimoNumero
                : estado.Numeracoes.Vale.UltimoNumero, ct)
            : "sem salto";
        if (local.Evento < estado.InformadoPeloTerminal.UltimaSequenciaGerada && sequencias.TryGetValue(SequenciaLocal.Evento, out var evento))
        {
            // Eventos gerados e nunca enviados (22.4): a sequência não os reaproveita; a lacuna é declarada pelo supervisor.
            detalhe += string.Create(CultureInfo.InvariantCulture, $", evento {evento.UltimoValor}→{estado.InformadoPeloTerminal.UltimaSequenciaGerada}");
            evento.UltimoValor = estado.InformadoPeloTerminal.UltimaSequenciaGerada;
            evento.AtualizadoEm = agora;
        }

        if (linha is not null)
        {
            db.ConfiguracaoTerminal.Remove(linha);
        }

        var mensagem = $"Recuperação 22.1 ({motivo}): {detalhe}" + (restauracao is { } r ? $"; backup {r.Arquivo} restaurado em {DataHoraTexto(r.RestauradoEm)}" : string.Empty);
        db.LogLocal.Add(Ocorrencias.Nova(agora, saltar ? NiveisOcorrencia.Aviso : NiveisOcorrencia.Info, CodigoOcorrencia.Recuperacao, mensagem));
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        log.LogWarning("Handshake: {Mensagem}", mensagem);
        return new DesfechoRestauracao(saltar, motivo, detalhe);
    }

    private static string DataHoraTexto(DateTimeOffset d) => Data.Convencoes.DataHoraUtcTexto.Formatar(d);
}
