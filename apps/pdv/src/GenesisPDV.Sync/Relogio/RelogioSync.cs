using System.Globalization;
using GenesisPDV.Core.Comum;
using GenesisPDV.Data.Outbox;
using GenesisPDV.Data.Repositorios;
using GenesisPDV.Sync.Ativacao;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.Sync.Relogio;

/// <summary>Recebe a hora do servidor de cada resposta da API (SYNC 12.2), medida pelo <see cref="Cliente.ClienteSyncHttp"/>.</summary>
public interface IAmostrasRelogio
{
    /// <param name="enviadaEm">Relógio do SO (sem correção) no envio.</param>
    /// <param name="idaEVolta">Tempo monotônico entre o envio e a resposta.</param>
    /// <param name="agoraServidor">Cabeçalho <c>X-Agora-Servidor</c>.</param>
    void Registrar(DateTimeOffset enviadaEm, TimeSpan idaEVolta, DateTimeOffset agoraServidor);
}

/// <summary>
/// Relógio mínimo da Fase 1B (SYNC 12.2–12.3): o desvio é a mediana das últimas 5 amostras válidas
/// (<c>X-Agora-Servidor − (envio + ida_e_volta/2)</c>, descartada a amostra com ida e volta acima de 3 s) e fica em
/// <c>estado_conexao</c> com o par da amostra (UTC local e boot). Na abertura vale o desvio persistido; de outro boot,
/// ele continua sendo usado, mas o relógio passa a <c>relogio_confiavel = false</c> até a primeira amostra (a consulta
/// ao NTP do SO e às fontes SEFAZ/NTP direto da 12.2 ficam para a fase do fiscal). A hora do fato no envelope é
/// <c>agora_local + desvio</c> com a monotonicidade limitada a 2 min (12.3). O relógio do SO nunca é alterado. O
/// <see cref="IRelogio"/> do app continua sendo o do SO: a correção vale para o envelope dos eventos, o heartbeat e o
/// indicador; os fatos do caixa (venda, caixa, vasilhame) usam o <see cref="RelogioCorrigido"/> desde a 1C (bloco C9).
/// </summary>
public sealed class RelogioSync(IDbContextFactory<Data.PdvDbContext> fabrica, IRelogio relogioLocal, ILogger<RelogioSync>? log = null) : IAmostrasRelogio, IRelogioOutbox
{
    public static readonly TimeSpan IdaEVoltaMaxima = TimeSpan.FromSeconds(3);
    public static readonly TimeSpan LimiteMonotonicidade = Data.Outbox.HoraDoFato.LimiteMonotonicidade;
    public const int Amostras = 5;

    /// <summary>Desvio que muda menos que isso não é regravado (as amostras chegam a cada poucos segundos).</summary>
    private static readonly TimeSpan RegravarApos = TimeSpan.FromMinutes(1);

    private readonly ILogger _log = log ?? NullLogger<RelogioSync>.Instance;
    private readonly Lock _trava = new();
    private readonly List<long> _amostras = [];
    private long? _desvioMs;
    private bool _confiavel;
    private bool _carregado;
    private long? _gravadoMs;
    private DateTimeOffset _gravadoEm;

    /// <summary>Hora do SO, sem correção (cabeçalho <c>X-Genesis-Hora-Local</c>, <c>ocorrido_em_local</c>).</summary>
    public DateTimeOffset AgoraLocal => relogioLocal.Agora;

    /// <summary><c>agora_local + desvio</c> (sem desvio, a hora do SO).</summary>
    public DateTimeOffset Agora
    {
        get
        {
            lock (_trava)
            {
                return relogioLocal.Agora.AddMilliseconds(_desvioMs ?? 0);
            }
        }
    }

    public long? DesvioMs
    {
        get
        {
            lock (_trava)
            {
                return _desvioMs;
            }
        }
    }

    public bool Confiavel
    {
        get
        {
            lock (_trava)
            {
                return _confiavel;
            }
        }
    }

    /// <summary>Lê o desvio persistido (ativação ou sessões anteriores): no mesmo boot é confiável; de outro, não.</summary>
    public async Task CarregarAsync(CancellationToken ct = default)
    {
        await using var db = await fabrica.CreateDbContextAsync(ct);
        var conexao = await db.EstadoConexao.AsNoTracking().FirstOrDefaultAsync(ct);
        lock (_trava)
        {
            if (_carregado)
            {
                return;
            }

            _carregado = true;
            if (conexao?.DesvioRelogioMs is { } desvio)
            {
                _desvioMs = desvio;
                _gravadoMs = desvio;
                _confiavel = conexao.DesvioAmostraBootId == IdBoot.Atual();
            }
        }
    }

    public void Registrar(DateTimeOffset enviadaEm, TimeSpan idaEVolta, DateTimeOffset agoraServidor)
    {
        if (idaEVolta < TimeSpan.Zero || idaEVolta > IdaEVoltaMaxima)
        {
            return;
        }

        var amostra = (long)Math.Round((agoraServidor - (enviadaEm + (idaEVolta / 2))).TotalMilliseconds);
        long desvio;
        bool gravar;
        var agora = enviadaEm + idaEVolta;
        lock (_trava)
        {
            _amostras.Add(amostra);
            if (_amostras.Count > Amostras)
            {
                _amostras.RemoveAt(0);
            }

            desvio = Mediana(_amostras);
            _desvioMs = desvio;
            _confiavel = true;
            _carregado = true;
            gravar = _gravadoMs is not { } g || Math.Abs(g - desvio) >= 100 || agora - _gravadoEm >= RegravarApos;
            if (gravar)
            {
                _gravadoMs = desvio;
                _gravadoEm = agora;
            }
        }

        if (gravar)
        {
            _ = GravarAsync(desvio, agora, agoraServidor);
        }
    }

    /// <summary>
    /// Hora do fato para o outbox (12.3): <c>max(corrigida, último + 1 ms)</c> quando o último evento está até 2 min à
    /// frente; além disso, a hora corrigida pura com <see cref="HoraDoFato.Regrediu"/>. <paramref name="fato"/> é a hora
    /// do fato já corrigida (a do payload, pelo <see cref="RelogioCorrigido"/> do caixa); sem ela, agora corrigido.
    /// </summary>
    public HoraDoFato HoraDoFato(DateTimeOffset? ultimoOcorridoEm, DateTimeOffset? fato = null)
    {
        long? desvio;
        bool confiavel;
        lock (_trava)
        {
            desvio = _desvioMs;
            confiavel = _confiavel;
        }

        return Data.Outbox.HoraDoFato.Calcular(relogioLocal.Agora, desvio, confiavel, ultimoOcorridoEm, fato);
    }

    private async Task GravarAsync(long desvio, DateTimeOffset amostraEm, DateTimeOffset agoraServidor)
    {
        try
        {
            await using var db = await fabrica.CreateDbContextAsync();
            var conexao = await db.EstadoConexao.FirstOrDefaultAsync();
            if (conexao is null)
            {
                conexao = new Data.Entidades.EstadoConexao();
                db.EstadoConexao.Add(conexao);
            }

            conexao.DesvioRelogioMs = desvio;
            conexao.DesvioAmostraUtcLocal = amostraEm;
            conexao.DesvioAmostraBootId = IdBoot.Atual();
            conexao.AgoraServidorUltimo = agoraServidor;
            var corrigida = amostraEm.AddMilliseconds(desvio);
            if (conexao.MaiorHoraVista is null || corrigida > conexao.MaiorHoraVista)
            {
                conexao.MaiorHoraVista = corrigida;
            }

            await db.SaveChangesAsync();
        }
        catch (Exception e)
        {
            // O desvio segue valendo em memória; a próxima amostra tenta gravar de novo.
            _log.LogWarning(e, "Falha ao gravar o desvio do relógio ({Desvio} ms)", desvio.ToString(CultureInfo.InvariantCulture));
            lock (_trava)
            {
                _gravadoMs = null;
            }
        }
    }

    private static long Mediana(List<long> valores)
    {
        var ordenados = valores.Order().ToArray();
        var meio = ordenados.Length / 2;
        return ordenados.Length % 2 == 1 ? ordenados[meio] : (ordenados[meio - 1] + ordenados[meio]) / 2;
    }
}

/// <summary>
/// Relógio dos fatos do caixa (Fase 1C, bloco C9; SYNC 12.3): <c>agora_local + desvio</c> do <see cref="RelogioSync"/>.
/// A venda e os movimentos de caixa gravam com ele a hora do payload (<c>finalizada_em</c>, <c>aberta_em</c>,
/// <c>ocorrido_em</c>), a mesma que o <see cref="Data.Outbox.GravadorOutbox"/> põe no envelope. O resto do app (logs,
/// bloqueio de senha, backoff, amostras do relógio) continua no relógio do SO.
/// </summary>
public sealed class RelogioCorrigido(RelogioSync relogio) : IRelogio
{
    public DateTimeOffset Agora => relogio.Agora;
}
