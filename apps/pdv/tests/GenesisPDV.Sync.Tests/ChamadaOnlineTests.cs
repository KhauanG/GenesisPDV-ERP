using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Token;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Repetição das chamadas online que alteram estado (SYNC 20.4; F3-B6): depois de um timeout, de uma queda de conexão,
/// de um 502/504 sem envelope ou do <c>409 REQUISICAO_EM_ANDAMENTO</c>, a nova tentativa sai com o <b>mesmo</b>
/// <c>X-Requisicao-Id</c> e o mesmo corpo, e a resposta é a da API (a mesma da primeira, que ela guardou); o
/// <c>422 REQUISICAO_DIVERGENTE</c>, as outras recusas e o cancelamento de quem chamou não se repetem; esgotadas as
/// tentativas, sobe a última falha.
/// </summary>
public class ChamadaOnlineTests
{
    private const string Rota = "sync/consultas/vales/01a18753-1a2b-7c3d-8e4f-5a6b7c8d9e01/reservar";

    private static readonly RepeticaoOnline SemEspera = new() { Espera = TimeSpan.Zero };

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>API falsa: uma resposta por tentativa, na ordem, com o id e o corpo de cada envio.</summary>
    private sealed class Handler(params Func<CancellationToken, Task<HttpResponseMessage>>[] respostas) : HttpMessageHandler
    {
        public List<(string Id, string Corpo)> Envios { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var corpo = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            Envios.Add((request.Headers.GetValues("X-Requisicao-Id").Single(), corpo));
            var i = Math.Min(Envios.Count, respostas.Length) - 1;
            return await respostas[i](cancellationToken);
        }
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string corpo, TimeSpan? repetirApos = null)
    {
        var r = new HttpResponseMessage(status) { Content = new StringContent(corpo, Encoding.UTF8, "application/json") };
        if (repetirApos is { } apos)
        {
            r.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(apos);
        }

        return r;
    }

    private static Func<CancellationToken, Task<HttpResponseMessage>> Responde(HttpStatusCode status, string corpo, TimeSpan? repetirApos = null) =>
        _ => Task.FromResult(Json(status, corpo, repetirApos));

    private static Func<CancellationToken, Task<HttpResponseMessage>> Erro(HttpStatusCode status, string codigo, TimeSpan? repetirApos = null) =>
        Responde(status, $$$"""{"erro":{"codigo":"{{{codigo}}}","mensagem":"recusado","detalhes":{},"requisicao_id":null}}""", repetirApos);

    /// <summary>A API que não responde: o prazo da rota (<see cref="TemposLimiteSync.Outras"/>, curto aqui) estoura.</summary>
    private static async Task<HttpResponseMessage> SemResposta(CancellationToken ct)
    {
        await Task.Delay(Timeout.Infinite, ct);
        throw new InvalidOperationException("inalcançável");
    }

    private static readonly Func<CancellationToken, Task<HttpResponseMessage>> Ok =
        Responde(HttpStatusCode.Created, """{"reserva_id":"r1","valor":"3.00"}""");

    private static ClienteSyncHttp Cliente(Handler api) => new(
        new HttpClient(api) { BaseAddress = new Uri("https://api.exemplo/") },
        new ConfiguracaoClienteSync("0.14.0", "windows_x64", "3f1c9a2e8b7d4c6f"),
        new RelogioSistema(),
        new FonteTokenFixa(() => "token-de-teste"),
        tempos: new TemposLimiteSync { Outras = TimeSpan.FromMilliseconds(150) });

    private static readonly object Corpo = new { pagamento_venda_id = "01a18753-0000-7000-8000-000000000001", valor = "3.00" };

    [Fact]
    public async Task Timeout_repete_com_o_mesmo_id_e_o_mesmo_corpo_e_devolve_a_resposta_da_api()
    {
        var api = new Handler(SemResposta, Ok);
        var operacao = Guid.CreateVersion7();

        var r = await Cliente(api).AlterarComRepeticaoAsync<JsonObject>(HttpMethod.Post, Rota, Corpo, operacao, SemEspera, Ct);

        Assert.Equal("r1", r["reserva_id"]!.GetValue<string>());
        Assert.Equal(2, api.Envios.Count);
        Assert.All(api.Envios, e => Assert.Equal(operacao.ToString("D"), e.Id));
        Assert.Equal(api.Envios[0].Corpo, api.Envios[1].Corpo);
        Assert.Contains("\"valor\":\"3.00\"", api.Envios[0].Corpo);
    }

    [Fact]
    public async Task Queda_de_conexao_e_gateway_sem_envelope_tambem_repetem()
    {
        var api = new Handler(
            _ => throw new HttpRequestException("conexão encerrada"),
            Responde(HttpStatusCode.GatewayTimeout, "<html>504</html>"),
            Ok);
        var operacao = Guid.CreateVersion7();

        await Cliente(api).AlterarComRepeticaoAsync<JsonObject>(HttpMethod.Post, Rota, Corpo, operacao, SemEspera, Ct);

        Assert.Equal(3, api.Envios.Count);
        Assert.Single(api.Envios.Select(e => e.Id).Distinct());
    }

    [Fact]
    public async Task Em_andamento_espera_o_retry_after_limitado_e_repete_com_o_mesmo_id()
    {
        var api = new Handler(Erro(HttpStatusCode.Conflict, "REQUISICAO_EM_ANDAMENTO", TimeSpan.FromSeconds(30)), Ok);
        var politica = new RepeticaoOnline { Espera = TimeSpan.Zero, EsperaMaxima = TimeSpan.FromMilliseconds(200) };
        var relogio = System.Diagnostics.Stopwatch.StartNew();

        await Cliente(api).AlterarComRepeticaoAsync<JsonObject>(HttpMethod.Post, Rota, Corpo, Guid.CreateVersion7(), politica, Ct);

        Assert.Equal(2, api.Envios.Count);
        Assert.Equal(api.Envios[0].Id, api.Envios[1].Id);
        // O Retry-After de 30 s ficou no teto da política: o balcão não espera mais que isso, mas espera o teto (com a
        // `Espera` zerada, quem ignorasse o Retry-After repetiria na hora).
        Assert.True(relogio.Elapsed >= TimeSpan.FromMilliseconds(180), relogio.Elapsed.ToString());
        Assert.True(relogio.Elapsed < TimeSpan.FromSeconds(5), relogio.Elapsed.ToString());
    }

    [Fact]
    public async Task Em_andamento_espera_o_retry_after_abaixo_do_teto_e_nao_a_espera_da_politica()
    {
        var api = new Handler(Erro(HttpStatusCode.Conflict, "REQUISICAO_EM_ANDAMENTO", TimeSpan.FromSeconds(1)), Ok);
        var politica = new RepeticaoOnline { Espera = TimeSpan.FromMilliseconds(50), EsperaMaxima = TimeSpan.FromSeconds(3) };
        var relogio = System.Diagnostics.Stopwatch.StartNew();

        await Cliente(api).AlterarComRepeticaoAsync<JsonObject>(HttpMethod.Post, Rota, Corpo, Guid.CreateVersion7(), politica, Ct);

        Assert.Equal(2, api.Envios.Count);
        // O 1 s que a API pediu, não os 50 ms da política nem o teto de 3 s.
        Assert.True(relogio.Elapsed >= TimeSpan.FromMilliseconds(900), relogio.Elapsed.ToString());
        Assert.True(relogio.Elapsed < TimeSpan.FromSeconds(2.5), relogio.Elapsed.ToString());
    }

    [Theory]
    [InlineData(HttpStatusCode.UnprocessableEntity, "REQUISICAO_DIVERGENTE")]
    [InlineData(HttpStatusCode.Conflict, "SALDO_INSUFICIENTE")]
    [InlineData(HttpStatusCode.Conflict, "HARDWARE_ALTERADO")]
    [InlineData(HttpStatusCode.InternalServerError, "ERRO_INTERNO")]
    [InlineData(HttpStatusCode.NotFound, "NAO_ENCONTRADO")]
    public async Task Recusa_da_api_sobe_na_hora_sem_repetir(HttpStatusCode status, string codigo)
    {
        var api = new Handler(Erro(status, codigo), Ok);

        var e = await Assert.ThrowsAsync<ErroSyncException>(() =>
            Cliente(api).AlterarComRepeticaoAsync<JsonObject>(HttpMethod.Post, Rota, Corpo, Guid.CreateVersion7(), SemEspera, Ct));

        Assert.Equal(codigo, e.Codigo);
        Assert.Single(api.Envios);
    }

    [Fact]
    public async Task Esgotadas_as_tentativas_sobe_o_ultimo_timeout_e_todas_levaram_o_mesmo_id()
    {
        var api = new Handler(SemResposta);
        var operacao = Guid.CreateVersion7();
        var relogio = System.Diagnostics.Stopwatch.StartNew();

        var e = await Assert.ThrowsAsync<TaskCanceledException>(() =>
            Cliente(api).AlterarComRepeticaoAsync<JsonObject>(HttpMethod.Post, Rota, Corpo, operacao, SemEspera, Ct));

        Assert.IsType<TimeoutException>(e.InnerException);
        Assert.Equal(RepeticaoOnline.Padrao.Tentativas, api.Envios.Count);
        Assert.All(api.Envios, x => Assert.Equal(operacao.ToString("D"), x.Id));
        // Cada tentativa tem o prazo inteiro da rota (TemposLimiteSync.Outras, 150 ms aqui; 30 s no padrão): o pior caso
        // é Tentativas × Outras mais as esperas entre elas, e não um prazo total da política.
        Assert.True(relogio.Elapsed >= TimeSpan.FromMilliseconds(3 * 150 * 0.9), relogio.Elapsed.ToString());
        Assert.Equal(TimeSpan.FromSeconds(30), TemposLimiteSync.Padrao.Outras);
    }

    [Fact]
    public async Task Cancelamento_de_quem_chamou_nao_repete()
    {
        using var cancelar = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var api = new Handler(async ct =>
        {
            await cancelar.CancelAsync();
            return await SemResposta(ct);
        }, Ok);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Cliente(api).AlterarComRepeticaoAsync<JsonObject>(HttpMethod.Post, Rota, Corpo, Guid.CreateVersion7(), SemEspera, cancelar.Token));

        Assert.Single(api.Envios);
    }

    [Fact]
    public async Task Politica_com_uma_tentativa_nao_repete()
    {
        var api = new Handler(SemResposta, Ok);

        await Assert.ThrowsAsync<TaskCanceledException>(() =>
            Cliente(api).AlterarComRepeticaoAsync<JsonObject>(HttpMethod.Post, Rota, Corpo, Guid.CreateVersion7(), new RepeticaoOnline { Tentativas = 1 }, Ct));

        Assert.Single(api.Envios);
        Assert.Equal(3, RepeticaoOnline.Padrao.Tentativas);
    }
}
