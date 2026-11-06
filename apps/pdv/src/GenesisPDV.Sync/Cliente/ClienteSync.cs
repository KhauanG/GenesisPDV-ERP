using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using GenesisPDV.Core.Comum;
using GenesisPDV.Sync.Protocolo;
using GenesisPDV.Sync.Relogio;
using GenesisPDV.Sync.Token;

namespace GenesisPDV.Sync.Cliente;

/// <summary>Chamadas do PDV à API de sincronização (sincronizacao.md 1.4).</summary>
public interface IClienteSync
{
    /// <summary><c>X-Requisicao-Id</c> = <c>requisicao_ativacao_id</c>: a repetição da mesma ativação leva o mesmo id.</summary>
    Task<RespostaAtivacao> AtivarAsync(Uri urlApi, RequisicaoAtivacao requisicao, CancellationToken ct = default);

    /// <summary><c>GET /sync/estado</c> (5): handshake da inicialização, antes do login.</summary>
    Task<RespostaEstado> EstadoAsync(CancellationToken ct = default);

    /// <param name="teto">
    /// <c>cursor_teto</c> da 1ª página da carga, repetido até <c>tem_mais = false</c> (6.3–6.4); nulo = teto atual da nuvem.
    /// </param>
    Task<RespostaPull> PullAsync(string fluxo, long desde, int limite, long? teto = null, CancellationToken ct = default);

    /// <summary>
    /// <c>POST /sync/push</c> (7.4). <c>X-Requisicao-Id</c> = <see cref="RequisicaoPush.LoteId"/>: o reenvio do mesmo lote leva
    /// o mesmo id e o mesmo corpo.
    /// </summary>
    Task<RespostaPush> PushAsync(RequisicaoPush lote, CancellationToken ct = default);

    /// <summary><c>POST /sync/heartbeat</c> (21.1).</summary>
    Task<RespostaHeartbeat> HeartbeatAsync(RequisicaoHeartbeat heartbeat, CancellationToken ct = default);

    /// <summary>
    /// <c>GET /sync/eventos-status?ids=</c> (7.2, 21.1): situação na nuvem de até 200 eventos deste terminal (os
    /// <c>rejeitado</c>). Só leitura: id novo a cada envio, nenhum ack.
    /// </summary>
    Task<RespostaEventosStatus> EventosStatusAsync(IReadOnlyCollection<Guid> ids, CancellationToken ct = default);

    /// <summary>
    /// <c>GET /sync/recuperar?desde_sequencia=&amp;limite=</c> (22.1, 22.2): uma página da re-hidratação (eventos deste
    /// terminal com sequência maior, em ordem). Só leitura.
    /// </summary>
    Task<RespostaRecuperar> RecuperarAsync(long desdeSequencia, int limite, CancellationToken ct = default);

    /// <summary>
    /// Chamada online que altera estado (reservas, comandas, PIX, renovação de token — SYNC 20.4): o
    /// <paramref name="requisicaoId"/> é gerado uma vez por operação lógica e repetido em toda nova tentativa, para a API
    /// devolver a mesma resposta. Na renovação de token ele fica em <c>configuracao_terminal['token.pendente']</c>.
    /// </summary>
    Task<T> AlterarAsync<T>(HttpMethod metodo, string rota, object? corpo, Guid requisicaoId, CancellationToken ct = default);

    Task<bool> SaudeAsync(Uri urlApi, CancellationToken ct = default);
}

/// <summary>Erro devolvido pela API no envelope padrão (2.4, 2.5).</summary>
public sealed class ErroSyncException(HttpStatusCode status, ErroApi? erro, string mensagem, TimeSpan? repetirApos = null) : Exception(mensagem)
{
    public HttpStatusCode Status { get; } = status;

    public ErroApi? Erro { get; } = erro;

    /// <summary><c>Retry-After</c> da resposta (429/503): a nova tentativa nunca sai antes disso (18.3); nulo = sem cabeçalho.</summary>
    public TimeSpan? RepetirApos { get; } = repetirApos;

    public string? Codigo => Erro?.Codigo;

    /// <summary>Transitório = vale repetir com backoff (tabela 2.5).</summary>
    public bool Transitorio => (int)Status is 409 or 413 or 429 or >= 500
                               && Codigo is not ("REGRESSAO_DETECTADA" or "TERMINAL_CLONADO" or "HARDWARE_ALTERADO");
}

public sealed record ConfiguracaoClienteSync(string VersaoApp, string Plataforma, string IdHardware, int Protocolo = 1);

/// <summary>
/// Tempo limite por chamada (SYNC 2.1: pull 30 s, push 60 s, heartbeat 10 s, ativação 30 s; a conexão, 5 s, é do
/// handler). Estourado, a chamada termina em <see cref="TaskCanceledException"/> com <see cref="TimeoutException"/>
/// dentro, como o <c>Timeout</c> do <see cref="HttpClient"/>: no heartbeat é o "1 timeout de heartbeat" que já põe o
/// caixa offline (18.3). O handshake (<c>/sync/estado</c>, antes do login) usa o do heartbeat: numa rede que aceita a
/// conexão e não responde, o caixa abre com os dados locais em segundos (decisão 41), não em 1 min.
/// </summary>
public sealed record TemposLimiteSync
{
    public static readonly TemposLimiteSync Padrao = new();

    public TimeSpan Heartbeat { get; init; } = TimeSpan.FromSeconds(10);
    public TimeSpan Estado { get; init; } = TimeSpan.FromSeconds(10);
    public TimeSpan Pull { get; init; } = TimeSpan.FromSeconds(30);
    public TimeSpan Push { get; init; } = TimeSpan.FromSeconds(60);
    public TimeSpan Ativacao { get; init; } = TimeSpan.FromSeconds(30);

    /// <summary><c>/saude</c> do assistente e chamadas online que alteram estado (renovação do token, 20.4).</summary>
    public TimeSpan Outras { get; init; } = TimeSpan.FromSeconds(30);
}

/// <summary>
/// Cliente HTTP do protocolo: cabeçalhos obrigatórios (2.2), token Bearer e tradução do envelope de erro, com os
/// contratos de <see cref="Protocolo"/> (os mesmos das fixtures de packages/shared). Os tokens vêm do
/// <see cref="IFonteToken"/> na ordem da rotação (3.7: pendente, depois atual): <c>401 TOKEN_INVALIDO</c> com um
/// candidato tenta o próximo, e o primeiro <c>200</c> é informado à fonte (que promove o pendente). Rotas relativas vão
/// contra <c>HttpClient.BaseAddress</c> ou, sem ela, contra <paramref name="urlBase"/> (a <c>url_api</c> da identidade).
/// O token nunca vai para log. Toda resposta com <c>X-Agora-Servidor</c> vira amostra de relógio (SYNC 12.2) para
/// <paramref name="amostras"/>, com a ida e volta medida no relógio monotônico; <paramref name="relogio"/> é o do SO
/// (o <c>X-Genesis-Hora-Local</c> vai sem correção). Cada rota tem o próprio tempo limite (<see cref="TemposLimiteSync"/>);
/// o <see cref="HttpClient"/> do app fica sem <c>Timeout</c> próprio.
/// </summary>
public sealed class ClienteSyncHttp(
    HttpClient http,
    ConfiguracaoClienteSync config,
    IRelogio relogio,
    IFonteToken tokens,
    Func<Uri?>? urlBase = null,
    IAmostrasRelogio? amostras = null,
    TemposLimiteSync? tempos = null) : IClienteSync
{
    private static readonly JsonSerializerOptions Json = ContratosJson.Opcoes;

    /// <summary>Máximo de ids por <c>GET /sync/eventos-status</c> (<c>MAXIMO_IDS_EVENTOS_STATUS</c> do shared, SYNC 7.2).</summary>
    public const int MaximoIdsEventosStatus = 200;

    /// <summary>Página do <c>GET /sync/recuperar</c> (<c>LIMITE_RECUPERAR_PADRAO</c>/<c>_MAXIMO</c> do shared, SYNC 22.2).</summary>
    public const int PaginaRecuperar = 50;

    public const int MaximoRecuperar = 200;

    private readonly TemposLimiteSync _tempos = tempos ?? TemposLimiteSync.Padrao;

    /// <summary>Token fixo (testes): nulo = sem <c>Authorization</c>.</summary>
    public ClienteSyncHttp(HttpClient http, ConfiguracaoClienteSync config, IRelogio relogio, Func<string?> obterToken)
        : this(http, config, relogio, new FonteTokenFixa(obterToken))
    {
    }

    public Task<RespostaAtivacao> AtivarAsync(Uri urlApi, RequisicaoAtivacao requisicao, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(urlApi);
        ArgumentNullException.ThrowIfNull(requisicao);
        return EnviarAsync<RespostaAtivacao>(HttpMethod.Post, new Uri(urlApi, "sync/ativar"), requisicao, requisicao.RequisicaoAtivacaoId, autenticar: false, _tempos.Ativacao, ct);
    }

    public Task<RespostaEstado> EstadoAsync(CancellationToken ct = default) =>
        EnviarAsync<RespostaEstado>(HttpMethod.Get, new Uri("sync/estado", UriKind.Relative), null, null, autenticar: true, _tempos.Estado, ct);

    public Task<RespostaPull> PullAsync(string fluxo, long desde, int limite, long? teto = null, CancellationToken ct = default)
    {
        var rota = string.Create(CultureInfo.InvariantCulture, $"sync/pull?fluxo={Uri.EscapeDataString(fluxo)}&desde={desde}&limite={limite}");
        if (teto is { } t)
        {
            rota += string.Create(CultureInfo.InvariantCulture, $"&teto={t}");
        }

        return EnviarAsync<RespostaPull>(HttpMethod.Get, new Uri(rota, UriKind.Relative), null, null, autenticar: true, _tempos.Pull, ct);
    }

    public Task<RespostaPush> PushAsync(RequisicaoPush lote, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(lote);
        return EnviarAsync<RespostaPush>(HttpMethod.Post, new Uri("sync/push", UriKind.Relative), lote, lote.LoteId, autenticar: true, _tempos.Push, ct);
    }

    public Task<RespostaHeartbeat> HeartbeatAsync(RequisicaoHeartbeat heartbeat, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(heartbeat);
        return EnviarAsync<RespostaHeartbeat>(HttpMethod.Post, new Uri("sync/heartbeat", UriKind.Relative), heartbeat, null, autenticar: true, _tempos.Heartbeat, ct);
    }

    public Task<RespostaEventosStatus> EventosStatusAsync(IReadOnlyCollection<Guid> ids, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(ids);
        if (ids.Count is 0 or > MaximoIdsEventosStatus)
        {
            throw new ArgumentException($"De 1 a {MaximoIdsEventosStatus} ids por consulta.", nameof(ids));
        }

        var rota = "sync/eventos-status?ids=" + string.Join(',', ids.Select(i => i.ToString("D")));
        return EnviarAsync<RespostaEventosStatus>(HttpMethod.Get, new Uri(rota, UriKind.Relative), null, null, autenticar: true, _tempos.Pull, ct);
    }

    public Task<RespostaRecuperar> RecuperarAsync(long desdeSequencia, int limite, CancellationToken ct = default)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(desdeSequencia);
        ArgumentOutOfRangeException.ThrowIfLessThan(limite, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(limite, MaximoRecuperar);
        var rota = string.Create(CultureInfo.InvariantCulture, $"sync/recuperar?desde_sequencia={desdeSequencia}&limite={limite}");
        return EnviarAsync<RespostaRecuperar>(HttpMethod.Get, new Uri(rota, UriKind.Relative), null, null, autenticar: true, _tempos.Pull, ct);
    }

    public Task<T> AlterarAsync<T>(HttpMethod metodo, string rota, object? corpo, Guid requisicaoId, CancellationToken ct = default)
    {
        if (requisicaoId == Guid.Empty)
        {
            throw new ArgumentException("Chamada que altera estado exige X-Requisicao-Id da operação.", nameof(requisicaoId));
        }

        return EnviarAsync<T>(metodo, new Uri(rota, UriKind.Relative), corpo, requisicaoId, autenticar: true, _tempos.Outras, ct);
    }

    public async Task<bool> SaudeAsync(Uri urlApi, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(urlApi);
        using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
        prazo.CancelAfter(_tempos.Outras);
        try
        {
            using var mensagem = Criar(HttpMethod.Get, new Uri(urlApi, "saude"), null, null, token: null);
            using var resposta = await http.SendAsync(mensagem, prazo.Token).ConfigureAwait(false);
            return resposta.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // Tempo limite: para o assistente é o mesmo que sem conexão.
            return false;
        }
    }

    /// <param name="requisicaoId">Id da operação lógica (mantido nas novas tentativas); nulo = leitura, id novo a cada envio.</param>
    private HttpRequestMessage Criar(HttpMethod metodo, Uri uri, object? corpo, Guid? requisicaoId, string? token)
    {
        var mensagem = new HttpRequestMessage(metodo, Absoluta(uri));
        mensagem.Headers.Add("X-Genesis-Protocolo", config.Protocolo.ToString(CultureInfo.InvariantCulture));
        mensagem.Headers.Add("X-Genesis-App-Versao", config.VersaoApp);
        mensagem.Headers.Add("X-Genesis-Plataforma", config.Plataforma);
        mensagem.Headers.Add("X-Requisicao-Id", (requisicaoId ?? IdGerador.Novo()).ToString("D"));
        mensagem.Headers.Add("X-Genesis-Hora-Local", FormatoProtocolo.DataHora(relogio.Agora));
        mensagem.Headers.Add("X-Genesis-Id-Hardware", config.IdHardware);
        if (token is not null)
        {
            mensagem.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        }

        if (corpo is not null)
        {
            mensagem.Content = JsonContent.Create(corpo, corpo.GetType(), options: Json);
        }

        return mensagem;
    }

    private Uri Absoluta(Uri uri)
    {
        if (uri.IsAbsoluteUri || http.BaseAddress is not null)
        {
            return uri;
        }

        var baseUri = urlBase?.Invoke() ?? throw new InvalidOperationException("Terminal sem endereço da API (não ativado).");
        return new Uri(baseUri, uri);
    }

    /// <summary>
    /// Um envio por candidato de token (3.7): <c>401 TOKEN_INVALIDO</c> passa ao próximo; qualquer outra resposta encerra.
    /// Depois de cada 401 os candidatos são relidos da fonte: uma chamada concorrente pode ter promovido o pendente
    /// recusado aqui (ele chegou à API antes do commit da renovação). Nesse caso a repetição vai com ele, uma vez, e não
    /// com o atual da lista antiga, que já virou o anterior e a API trataria como cópia do terminal. Sem candidato
    /// (terminal sem identidade), vai sem <c>Authorization</c> e a API responde 401.
    /// </summary>
    private async Task<T> EnviarAsync<T>(HttpMethod metodo, Uri uri, object? corpo, Guid? requisicaoId, bool autenticar, TimeSpan limite, CancellationToken ct)
    {
        using var prazo = CancellationTokenSource.CreateLinkedTokenSource(ct);
        prazo.CancelAfter(limite);
        try
        {
            return await EnviarComPrazoAsync<T>(metodo, uri, corpo, requisicaoId, autenticar, prazo.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException e) when (prazo.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            // Prazo da rota, não cancelamento de quem chamou: o mesmo formato do Timeout do HttpClient.
            var segundos = limite.TotalSeconds.ToString("0.#", CultureInfo.InvariantCulture);
            throw new TaskCanceledException($"Sem resposta da API em {segundos} s ({uri}).", new TimeoutException(e.Message, e), CancellationToken.None);
        }
    }

    private async Task<T> EnviarComPrazoAsync<T>(HttpMethod metodo, Uri uri, object? corpo, Guid? requisicaoId, bool autenticar, CancellationToken ct)
    {
        IReadOnlyList<string> candidatos = autenticar ? await tokens.CandidatosAsync(ct).ConfigureAwait(false) : [];
        var tentados = new HashSet<string>(StringComparer.Ordinal);
        var repetiuPromovido = false;
        string? token = candidatos.Count > 0 ? candidatos[0] : null;
        while (true)
        {
            using var mensagem = Criar(metodo, uri, corpo, requisicaoId, token);
            var enviadaEm = relogio.Agora;
            var cronometro = Stopwatch.StartNew();
            using var resposta = await http.SendAsync(mensagem, ct).ConfigureAwait(false);
            RegistrarAmostra(resposta, enviadaEm, cronometro.Elapsed);
            if (resposta.IsSuccessStatusCode)
            {
                var r = await resposta.Content.ReadFromJsonAsync<T>(Json, ct).ConfigureAwait(false)
                        ?? throw new ErroSyncException(resposta.StatusCode, null, "Resposta vazia da API.");
                if (token is not null)
                {
                    await tokens.SucessoAsync(token, ct).ConfigureAwait(false);
                }

                return r;
            }

            var erro = await LerErroAsync(resposta, ct).ConfigureAwait(false);
            if (token is not null && resposta.StatusCode == HttpStatusCode.Unauthorized && erro?.Codigo == "TOKEN_INVALIDO")
            {
                await tokens.RecusadoAsync(token, ct).ConfigureAwait(false);
                var eraPendente = candidatos.Count > 1 && candidatos[0] == token;
                tentados.Add(token);
                candidatos = await tokens.CandidatosAsync(ct).ConfigureAwait(false);
                string? proximo;
                if (eraPendente && !repetiuPromovido && candidatos.Count == 1 && candidatos[0] == token)
                {
                    // Promovido por outra chamada enquanto esta esperava: agora ele é o atual.
                    repetiuPromovido = true;
                    proximo = token;
                }
                else
                {
                    proximo = candidatos.FirstOrDefault(c => !tentados.Contains(c));
                }

                if (proximo is not null)
                {
                    token = proximo;
                    continue;
                }
            }

            throw new ErroSyncException(resposta.StatusCode, erro, erro?.Mensagem ?? $"Falha HTTP {(int)resposta.StatusCode}.", RepetirApos(resposta));
        }
    }

    private void RegistrarAmostra(HttpResponseMessage resposta, DateTimeOffset enviadaEm, TimeSpan idaEVolta)
    {
        if (amostras is not null
            && resposta.Headers.TryGetValues("X-Agora-Servidor", out var valores)
            && DateTimeOffset.TryParse(valores.FirstOrDefault(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var servidor))
        {
            amostras.Registrar(enviadaEm, idaEVolta, servidor.ToUniversalTime());
        }
    }

    private static async Task<ErroApi?> LerErroAsync(HttpResponseMessage resposta, CancellationToken ct)
    {
        try
        {
            return (await resposta.Content.ReadFromJsonAsync<EnvelopeErro>(Json, ct).ConfigureAwait(false))?.Erro;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary><c>Retry-After</c> em segundos (o que a API manda) ou como data HTTP, relativa ao relógio do PDV.</summary>
    private TimeSpan? RepetirApos(HttpResponseMessage resposta) => resposta.Headers.RetryAfter switch
    {
        { Delta: { } delta } => delta,
        { Date: { } data } => data > relogio.Agora ? data - relogio.Agora : TimeSpan.Zero,
        _ => null,
    };

    public static string PlataformaAtual() => OperatingSystem.IsWindows() ? "windows_x64" : "linux_x64";
}
