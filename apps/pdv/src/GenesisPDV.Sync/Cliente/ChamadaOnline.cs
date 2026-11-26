using System.Net;

namespace GenesisPDV.Sync.Cliente;

/// <summary>
/// Quantas vezes e com que espera a chamada online que altera estado é repetida com o mesmo <c>X-Requisicao-Id</c>
/// (SYNC 20.4; F3-B6), e quem chama decide o caminho offline (9.20) depois da última tentativa. A política só controla
/// as tentativas e a espera <b>entre</b> elas: o prazo de cada tentativa é o da rota no <see cref="ClienteSyncHttp"/>
/// (<see cref="TemposLimiteSync.Outras"/>, 30 s, o mesmo da renovação do token). Com a API que aceita a conexão e não
/// responde, o pior caso do padrão é 3 × 30 s + 2 × 0,5 s ≈ 91 s com o cliente no balcão; o prazo próprio das chamadas
/// do balcão (como o <see cref="TemposLimiteSync.Consulta"/> das consultas) é pendência do F3-B45, junto com as rotas.
/// </summary>
public sealed record RepeticaoOnline
{
    public static readonly RepeticaoOnline Padrao = new();

    /// <summary>Tentativas no total (a primeira e as repetições); no mínimo 1.</summary>
    public int Tentativas { get; init; } = 3;

    /// <summary>Espera entre uma tentativa e a seguinte.</summary>
    public TimeSpan Espera { get; init; } = TimeSpan.FromMilliseconds(500);

    /// <summary>Teto do <c>Retry-After</c> do <c>409 REQUISICAO_EM_ANDAMENTO</c> (a API manda 1 s).</summary>
    public TimeSpan EsperaMaxima { get; init; } = TimeSpan.FromSeconds(3);
}

/// <summary>
/// Repetição das chamadas online que alteram estado (reservas de vale e de orçamento, crédito, comanda, PIX; SYNC 20.4;
/// F3-B6, README do PDV › decisão 98). Toda tentativa leva o <b>mesmo</b> <c>X-Requisicao-Id</c> e o mesmo corpo: a
/// API guarda a resposta da primeira em <c>requisicoes_terminal</c> e devolve a mesma, sem refazer o efeito (a reserva
/// nunca sai duas vezes). Repete quando o caixa não sabe se a nuvem aplicou ou quando a nuvem pede:
/// <list type="bullet">
/// <item>o prazo da rota estourou (<see cref="TaskCanceledException"/> com <see cref="TimeoutException"/> dentro) ou a
/// conexão caiu (<see cref="HttpRequestException"/>);</item>
/// <item>o gateway respondeu sem o envelope da API (502/504): a API pode ter aplicado;</item>
/// <item><c>409 REQUISICAO_EM_ANDAMENTO</c>: a primeira ainda está sendo atendida (espera o <c>Retry-After</c>).</item>
/// </list>
/// O resto sobe na hora, inclusive <c>422 REQUISICAO_DIVERGENTE</c> (o mesmo id com outro corpo: bug, não se repete) e o
/// cancelamento de quem chamou. Depois da última tentativa sobe a última falha, e quem chama consulta o estado
/// (<c>GET …/vales/{codigo}</c>, <c>…/orcamentos/{codigo}</c>) antes de cair para o caminho offline.
/// </summary>
public static class ChamadaOnline
{
    /// <summary>
    /// <see cref="IClienteSync.AlterarAsync{T}"/> com as repetições de <paramref name="politica"/> (nula = a padrão).
    /// <paramref name="requisicaoId"/> é o da operação lógica, gerado uma vez por quem chama.
    /// </summary>
    public static async Task<T> AlterarComRepeticaoAsync<T>(
        this IClienteSync cliente,
        HttpMethod metodo,
        string rota,
        object? corpo,
        Guid requisicaoId,
        RepeticaoOnline? politica = null,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(cliente);
        var p = politica ?? RepeticaoOnline.Padrao;
        var tentativas = Math.Max(1, p.Tentativas);
        for (var tentativa = 1; ; tentativa++)
        {
            try
            {
                return await cliente.AlterarAsync<T>(metodo, rota, corpo, requisicaoId, ct).ConfigureAwait(false);
            }
            catch (Exception e) when (tentativa < tentativas && Repetivel(e, ct))
            {
                var espera = e is ErroSyncException { RepetirApos: { } apos } && apos > p.Espera
                    ? (apos < p.EsperaMaxima ? apos : p.EsperaMaxima)
                    : p.Espera;
                if (espera > TimeSpan.Zero)
                {
                    await Task.Delay(espera, ct).ConfigureAwait(false);
                }
            }
        }
    }

    /// <summary>A falha em que o caixa não sabe se a nuvem aplicou, ou em que a nuvem pede para repetir.</summary>
    public static bool Repetivel(Exception e, CancellationToken ct = default) => e switch
    {
        TaskCanceledException { InnerException: TimeoutException } => !ct.IsCancellationRequested,
        HttpRequestException => true,
        ErroSyncException { Codigo: "REQUISICAO_EM_ANDAMENTO" } => true,
        ErroSyncException { Erro: null, Status: HttpStatusCode.BadGateway or HttpStatusCode.GatewayTimeout } => true,
        _ => false,
    };
}
