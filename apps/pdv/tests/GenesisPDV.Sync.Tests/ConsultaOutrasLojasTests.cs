using System.Diagnostics;
using System.Net;
using System.Text;
using GenesisPDV.Core.Comum;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;
using GenesisPDV.Sync.Token;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// F4 "Outras lojas" (Fase 2, F2-B35; PDV 10.3), do cliente até o desfecho que a tela mostra: a rota, o token e a
/// fixture <c>saldos-outras-lojas.resposta.json</c> (a mesma do zod e da integração da API); o prazo de 3 s, o 404 da API
/// antiga, a rede fora e o caixa já offline viram "requer conexão" (sem exceção para a tela); o 404 do produto, o 403 da
/// chave desligada, o 429 e o hardware alterado têm o próprio aviso; o terminal sem nuvem nem consulta; e só o
/// cancelamento de quem chamou sai como exceção.
/// </summary>
public class ConsultaOutrasLojasTests
{
    private static readonly Guid Produto = Guid.Parse("01a18753-1a2b-7c3d-8e4f-5a6b7c8d9e01");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>API falsa de uma rota só: a resposta configurada e os envios.</summary>
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> responder) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Envios { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Envios.Add(request);
            return responder(request, cancellationToken);
        }
    }

    private sealed class SincronizacaoFixa(SituacaoSincronizacao situacao) : IServicoSincronizacao
    {
        public SituacaoSincronizacao Situacao => situacao;

        public event EventHandler<SituacaoSincronizacao>? SituacaoAlterada { add { } remove { } }

        public event EventHandler<string>? MensagemRecebida { add { } remove { } }

        public Task<ResultadoHandshake> HandshakeAsync(CancellationToken ct = default) => throw new NotSupportedException();

        public void Iniciar()
        {
        }

        public Task AcordarAsync(CancellationToken ct = default) => Task.CompletedTask;

        public void SincronizarAgora()
        {
        }

        public Task DeclararLacunaAsync(Guid autorizadoPorId, string? observacao, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null) =>
            throw new NotSupportedException();

        public Task AutorizarRecuperacaoLacunaAsync(Guid autorizadoPorId, CancellationToken ct = default, OrigemLiberacaoLacuna? origem = null) =>
            throw new NotSupportedException();
    }

    private static readonly SituacaoSincronizacao Online = new(true, 0, null);

    private static HttpResponseMessage Json(HttpStatusCode status, string corpo) =>
        new(status) { Content = new StringContent(corpo, Encoding.UTF8, "application/json") };

    private static HttpResponseMessage Erro(HttpStatusCode status, string codigo, string detalhes = "{}") =>
        Json(status, $$$"""{"erro":{"codigo":"{{{codigo}}}","mensagem":"recusado","detalhes":{{{detalhes}}},"requisicao_id":null}}""");

    private static (ConsultaOutrasLojasHttp Consulta, Handler Api) Montar(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> responder,
        SituacaoSincronizacao? situacao = null,
        TimeSpan? prazo = null)
    {
        var api = new Handler(responder);
        var cliente = new ClienteSyncHttp(
            new HttpClient(api) { BaseAddress = new Uri("https://api.exemplo/") },
            new ConfiguracaoClienteSync("0.11.0", "windows_x64", "3f1c9a2e8b7d4c6f"),
            new RelogioSistema(),
            new FonteTokenFixa(() => "token-de-teste"),
            tempos: prazo is { } p ? new TemposLimiteSync { Consulta = p } : null);
        return (new ConsultaOutrasLojasHttp(cliente, new SincronizacaoFixa(situacao ?? Online)), api);
    }

    private static Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> Responde(Func<HttpResponseMessage> r) =>
        (_, _) => Task.FromResult(r());

    [Fact]
    public async Task Online_devolve_os_saldos_da_fixture_pela_rota_com_o_token()
    {
        var (consulta, api) = Montar(Responde(() => Json(HttpStatusCode.OK, Fixtures.Sync("saldos-outras-lojas.resposta.json"))));

        var r = await consulta.ConsultarAsync(Produto, Ct);

        Assert.Null(r.Aviso);
        var saldos = Assert.IsType<RespostaSaldosOutrasLojas>(r.Saldos);
        Assert.Equal([24m, -3m, 1250.5m], saldos.Locais.Select(l => l.QuantidadeNumero));
        Assert.Equal([true, false, false], saldos.Locais.Select(l => l.LojaDoTerminal));
        Assert.Equal(SaldoLocalOnline.TipoDeposito, saldos.Locais[2].Tipo);
        Assert.Null(saldos.Locais[2].LojaCodigo);
        var envio = Assert.Single(api.Envios);
        Assert.Equal(HttpMethod.Get, envio.Method);
        Assert.Equal("/sync/consultas/saldos-outras-lojas", envio.RequestUri!.AbsolutePath);
        Assert.Equal($"?produto_id={Produto:D}", envio.RequestUri.Query);
        Assert.Equal("token-de-teste", envio.Headers.Authorization?.Parameter);
    }

    [Fact]
    public async Task Prazo_estourado_vira_requer_conexao_sem_esperar_mais_que_o_prazo()
    {
        // O prazo padrão é 3 s (a pesquisa nunca espera o prazo do pull); aqui, curto, com a API que não responde.
        Assert.Equal(TimeSpan.FromSeconds(3), TemposLimiteSync.Padrao.Consulta);
        var (consulta, _) = Montar(
            async (_, ct) =>
            {
                await Task.Delay(Timeout.Infinite, ct);
                return Json(HttpStatusCode.OK, "{}");
            },
            prazo: TimeSpan.FromMilliseconds(200));

        var relogio = Stopwatch.StartNew();
        var r = await consulta.ConsultarAsync(Produto, Ct);

        Assert.Equal(MensagensConsultaOutrasLojas.RequerConexao, r.Aviso);
        Assert.Null(r.Saldos);
        Assert.True(relogio.Elapsed < TimeSpan.FromSeconds(3), relogio.Elapsed.ToString());
    }

    [Fact]
    public async Task Api_antiga_sem_a_rota_e_rede_fora_viram_requer_conexao()
    {
        // A API anterior ao F2-B35 responde 404 sem `detalhes.produto_id` (a rota não existe nela).
        var (antiga, _) = Montar(Responde(() => Erro(HttpStatusCode.NotFound, "NAO_ENCONTRADO")));
        Assert.Equal(MensagensConsultaOutrasLojas.RequerConexao, (await antiga.ConsultarAsync(Produto, Ct)).Aviso);

        var (foraDoAr, _) = Montar((_, _) => throw new HttpRequestException("sem rota para o host"));
        Assert.Equal(MensagensConsultaOutrasLojas.RequerConexao, (await foraDoAr.ConsultarAsync(Produto, Ct)).Aviso);

        var (manutencao, _) = Montar(Responde(() => Erro(HttpStatusCode.ServiceUnavailable, "MANUTENCAO")));
        Assert.Equal(MensagensConsultaOutrasLojas.RequerConexao, (await manutencao.ConsultarAsync(Produto, Ct)).Aviso);
    }

    [Fact]
    public async Task Sem_nuvem_ou_ja_offline_nem_consulta()
    {
        var (demonstracao, api1) = Montar(Responde(() => Json(HttpStatusCode.OK, "{}")), new SituacaoSincronizacao(false, 0, null) { SemNuvem = true });
        Assert.Equal(MensagensConsultaOutrasLojas.RequerConexao, (await demonstracao.ConsultarAsync(Produto, Ct)).Aviso);
        Assert.Empty(api1.Envios);

        // Offline confirmado pelo ciclo (2 falhas seguidas, SYNC 18.3): o aviso na hora, sem os 3 s.
        var (offline, api2) = Montar(Responde(() => Json(HttpStatusCode.OK, "{}")), new SituacaoSincronizacao(false, 0, DateTimeOffset.UtcNow));
        Assert.Equal(MensagensConsultaOutrasLojas.RequerConexao, (await offline.ConsultarAsync(Produto, Ct)).Aviso);
        Assert.Empty(api2.Envios);

        // Ainda sem contato (a abertura antes do primeiro heartbeat): tenta, porque pode estar online.
        var (semContato, api3) = Montar(
            Responde(() => Json(HttpStatusCode.OK, Fixtures.Sync("saldos-outras-lojas.resposta.json"))), new SituacaoSincronizacao(false, 0, null));
        Assert.NotNull((await semContato.ConsultarAsync(Produto, Ct)).Saldos);
        Assert.Single(api3.Envios);
    }

    [Fact]
    public async Task Recusas_da_nuvem_tem_o_proprio_aviso()
    {
        var casos = new (HttpResponseMessage Resposta, string Aviso)[]
        {
            (Erro(HttpStatusCode.NotFound, "NAO_ENCONTRADO", $$"""{"produto_id":"{{Produto:D}}"}"""), MensagensConsultaOutrasLojas.ProdutoNaoEncontrado),
            (Erro(HttpStatusCode.Forbidden, "ESCOPO_INVALIDO", """{"chave":"pdv.consulta_outras_lojas"}"""), MensagensConsultaOutrasLojas.Desligada),
            // Sem `detalhes.chave` (o terminal em desativação, SYNC 3.8): a mensagem da API, nunca "desligada no ERP".
            (Erro(HttpStatusCode.Forbidden, "ESCOPO_INVALIDO"), "Consulta indisponível: recusado"),
            (Erro(HttpStatusCode.TooManyRequests, "LIMITE_TAXA"), MensagensConsultaOutrasLojas.Limite),
            (Erro(HttpStatusCode.Conflict, "HARDWARE_ALTERADO"), MensagensConsultaOutrasLojas.HardwareAlterado),
            (Erro(HttpStatusCode.Forbidden, "EMPRESA_SUSPENSA"), "Consulta indisponível: recusado"),
        };
        foreach (var (resposta, aviso) in casos)
        {
            var (consulta, _) = Montar(Responde(() => resposta));
            Assert.Equal(aviso, (await consulta.ConsultarAsync(Produto, Ct)).Aviso);
        }
    }

    [Fact]
    public async Task Cancelamento_de_quem_chamou_sai_como_excecao()
    {
        var (consulta, _) = Montar(async (_, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return Json(HttpStatusCode.OK, "{}");
        });
        using var cancelar = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var tarefa = consulta.ConsultarAsync(Produto, cancelar.Token);
        await cancelar.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => tarefa);
    }
}
