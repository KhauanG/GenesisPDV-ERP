using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using GenesisPDV.Core.Comum;
using GenesisPDV.Sync.Acesso;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Protocolo;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Suíte de contrato do sync (SYNC 17), lado C#: cada fixture de <c>packages/shared/testes/sync</c> (as mesmas que o Vitest
/// passa pelo zod e o teste de integração da API confere contra as respostas reais) desserializa nos records de
/// <see cref="Protocolo"/> e volta ao mesmo JSON. Campo que a API manda e o record não tem quebra aqui.
/// </summary>
public class ContratosTests
{
    public static TheoryData<string, Type> Mensagens { get; } = new()
    {
        { "ativar.requisicao.json", typeof(RequisicaoAtivacao) },
        { "ativar.resposta.json", typeof(RespostaAtivacao) },
        { "estado.resposta.json", typeof(RespostaEstado) },
        { "pull.catalogo.resposta.json", typeof(RespostaPull) },
        { "push.auditoria.requisicao.json", typeof(RequisicaoPush) },
        { "push.auditoria.resposta.json", typeof(RespostaPush) },
        { "push.lacuna.requisicao.json", typeof(RequisicaoPush) },
        { "push.recuperar_lacuna.requisicao.json", typeof(RequisicaoPush) },
        { "push.lacuna.resposta.json", typeof(RespostaPush) },
        { "heartbeat.requisicao.json", typeof(RequisicaoHeartbeat) },
        { "heartbeat.resposta.json", typeof(RespostaHeartbeat) },
        { "eventos-status.resposta.json", typeof(RespostaEventosStatus) },
        { "recuperar.resposta.json", typeof(RespostaRecuperar) },
        { "token.renovar.requisicao.json", typeof(RequisicaoRenovarToken) },
        { "token.renovar.resposta.json", typeof(RespostaRenovarToken) },
    };

    [Fact]
    public void Toda_fixture_da_pasta_tem_record()
    {
        var arquivos = Directory.GetFiles(Fixtures.Pasta("sync"), "*.json").Select(Path.GetFileName).Order(StringComparer.Ordinal);
        // erros.json tem teste próprio, os *.payload.json e eventos.conferencias.json são do ContratosEventosTests,
        // argon2.vetores.json é dos testes do login offline (LoginOfflineTests) e caixa.apuracao.vetores.json é do
        // ApuracaoVetoresTests (GenesisPDV.Core.Tests).
        var cobertos = Mensagens.Select(m => m.Data.Item1)
            .Append("erros.json").Append("argon2.vetores.json").Append("eventos.conferencias.json").Append("caixa.apuracao.vetores.json")
            .Concat(ContratosEventosTests.Payloads)
            .Order(StringComparer.Ordinal);
        Assert.Equal(cobertos, arquivos);
    }

    [Theory]
    [MemberData(nameof(Mensagens))]
    public void Fixture_faz_ida_e_volta_pelo_record(string arquivo, Type tipo)
    {
        var json = Fixtures.Sync(arquivo);
        var objeto = JsonSerializer.Deserialize(json, tipo, Fixtures.Estritas);
        Assert.NotNull(objeto);
        Fixtures.AssertMesmoJson(json, JsonSerializer.Serialize(objeto, tipo, ContratosJson.Opcoes), arquivo);
    }

    [Fact]
    public void Auditoria_do_login_offline_so_usa_valores_do_catalogo_da_nuvem()
    {
        // A fixture passa pelo zod (`payloadAuditoriaRegistrosSchema` + `ehAcaoAuditoria`) no Vitest e num push real no
        // teste de integração da API; aqui, tudo o que o login offline grava precisa estar nela. Motivo ou ação fora
        // do catálogo derrubaria o `auditoria.registros` inteiro (PAYLOAD_INVALIDO) com os registros válidos junto.
        using var doc = JsonDocument.Parse(Fixtures.Sync("auditoria.registros.payload.json"));
        var acoes = doc.RootElement.GetProperty("registros").EnumerateArray().Select(r => r.GetProperty("acao").GetString()).ToHashSet();
        var motivos = doc.RootElement.GetProperty("logins").EnumerateArray()
            .Select(l => l.GetProperty("motivo_falha")).Where(m => m.ValueKind == JsonValueKind.String).Select(m => m.GetString()).ToHashSet();
        Assert.Empty(MotivoRecusa.Todos.Except(motivos));
        Assert.Contains(AutenticadorOffline.AcaoHashForaDosLimites, acoes);
        // Login e login negado (LoginViewModel) e a ativação (ServicoAtivacao).
        Assert.Empty(new[] { "login", "login_negado", "terminal_ativado" }.Except(acoes));
    }

    [Fact]
    public void Campo_nulo_da_fixture_sem_propriedade_no_record_quebra_a_ida_e_volta()
    {
        // A ida e volta ignora nulos: é a desserialização estrita que pega o campo anulável novo que chega `null`.
        var estado = JsonNode.Parse(Fixtures.Sync("estado.resposta.json"))!;
        estado["terminal"]!["motivo_revogacao"] = null;
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<RespostaEstado>(estado.ToJsonString(), Fixtures.Estritas));
        // Em produção o PDV tolera o campo novo (a API pode evoluir antes do app).
        Assert.NotNull(JsonSerializer.Deserialize<RespostaEstado>(estado.ToJsonString(), ContratosJson.Opcoes));
    }

    [Fact]
    public void Push_recalcula_o_payload_sha256_pelo_jcs_do_payload()
    {
        var lote = Fixtures.Ler<RequisicaoPush>("push.auditoria.requisicao.json");
        Assert.NotEmpty(lote.Eventos);
        foreach (var ev in lote.Eventos)
        {
            Assert.Equal(lote.TerminalId, ev.TerminalId);
            var jcs = Jcs.Serializar(JsonNode.Parse(ev.Payload.GetRawText()));
            Assert.Equal(ev.PayloadSha256, Jcs.Sha256Hex(jcs));
        }
    }

    [Fact]
    public void Ativacao_traz_os_fluxos_na_ordem_da_carga_e_o_token_nao_aparece_no_ToString()
    {
        var resposta = Fixtures.Ler<RespostaAtivacao>("ativar.resposta.json");
        Assert.Equal(FluxosSync.NaOrdem, resposta.Fluxos);
        Assert.Equal(1126, resposta.Numeracoes.Venda.UltimoNumero);
        Assert.Contains("Token = ***", resposta.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(resposta.Token.Split('.')[1], resposta.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Pull_tem_tombstone_e_decimal_em_texto()
    {
        var pagina = Fixtures.Ler<RespostaPull>("pull.catalogo.resposta.json");
        Assert.False(pagina.TemMais);
        Assert.Equal(pagina.CursorTeto, pagina.NovoCursor);
        Assert.Contains(pagina.Alteracoes, a => a.Linha.GetProperty("excluido_em").ValueKind == JsonValueKind.String);
        var produto = pagina.Alteracoes.Single(a => a.Tabela == "produtos").Linha;
        Assert.Equal("4.9900", produto.GetProperty("preco_venda").GetString());
    }

    [Fact]
    public void Envelopes_de_erro_fazem_ida_e_volta()
    {
        var casos = JsonNode.Parse(Fixtures.Sync("erros.json"))!["casos"]!.AsArray();
        Assert.NotEmpty(casos);
        foreach (var caso in casos)
        {
            var corpo = caso!["corpo"]!.ToJsonString();
            var envelope = JsonSerializer.Deserialize<EnvelopeErro>(corpo, Fixtures.Estritas)!;
            Assert.Matches("^[A-Z][A-Z0-9_]*$", envelope.Erro.Codigo);
            Fixtures.AssertMesmoJson(corpo, JsonSerializer.Serialize(envelope, ContratosJson.Opcoes), caso["descricao"]!.GetValue<string>());
        }
    }

    [Theory]
    [InlineData("código de ativação errado", false)]
    [InlineData("terminal revogado", false)]
    [InlineData("regressão de sequência com os resultados já processados do lote", false)]
    [InlineData("IP bloqueado por força bruta (com Retry-After)", true)]
    public async Task Cliente_traduz_o_envelope_de_erro(string descricao, bool transitorio)
    {
        var caso = JsonNode.Parse(Fixtures.Sync("erros.json"))!["casos"]!.AsArray().Single(c => c!["descricao"]!.GetValue<string>() == descricao)!;
        var status = (HttpStatusCode)caso["status"]!.GetValue<int>();
        var cabecalhos = caso["cabecalhos"]?.AsObject().ToDictionary(c => c.Key, c => c.Value!.GetValue<string>()) ?? [];
        var handler = new HandlerFixtures { Erro = (status, caso["corpo"]!.ToJsonString(), cabecalhos) };
        var cliente = Cliente(handler, out var http);
        using (http)
        {
            var erro = await Assert.ThrowsAsync<ErroSyncException>(() => cliente.EstadoAsync(TestContext.Current.CancellationToken));
            Assert.Equal(status, erro.Status);
            Assert.Equal(caso["corpo"]!["erro"]!["codigo"]!.GetValue<string>(), erro.Codigo);
            Assert.Equal(transitorio, erro.Transitorio);
            var repetirApos = cabecalhos.TryGetValue("Retry-After", out var segundos)
                ? TimeSpan.FromSeconds(int.Parse(segundos, CultureInfo.InvariantCulture))
                : (TimeSpan?)null;
            Assert.Equal(repetirApos, erro.RepetirApos);
        }
    }

    [Fact]
    public async Task Cliente_envia_as_requisicoes_no_formato_das_fixtures()
    {
        var ct = TestContext.Current.CancellationToken;
        var handler = new HandlerFixtures();
        var cliente = Cliente(handler, out var http);
        using (http)
        {
            var ativar = Fixtures.Ler<RequisicaoAtivacao>("ativar.requisicao.json");
            var ativado = await cliente.AtivarAsync(new Uri("https://api.exemplo/"), ativar, ct);
            Assert.Equal(Guid.Parse("01a18751-a521-7238-b924-56de3eb13b90"), ativado.TerminalId);
            var envio = handler.Envios.Single(e => e.Rota == "/sync/ativar");
            Fixtures.AssertMesmoJson(Fixtures.Sync("ativar.requisicao.json"), envio.Corpo!, "corpo do /sync/ativar");
            Assert.Equal(ativar.RequisicaoAtivacaoId.ToString("D"), envio.RequisicaoId);
            Assert.False(envio.Autenticado);

            var estado = await cliente.EstadoAsync(ct);
            Assert.Equal("ativo", estado.Terminal.Status);
            Assert.Equal([1], estado.VersoesSchema["auditoria.registros"]);

            await cliente.PullAsync(FluxosSync.Catalogo, 1880000, 2000, teto: 1880412, ct: ct);
            await cliente.PullAsync(FluxosSync.Catalogo, 0, 500, ct: ct);
            var pulls = handler.Envios.Where(e => e.Rota == "/sync/pull").Select(e => e.Query).ToList();
            Assert.Equal(["?fluxo=catalogo&desde=1880000&limite=2000&teto=1880412", "?fluxo=catalogo&desde=0&limite=500"], pulls);

            // O reenvio do mesmo lote leva o mesmo X-Requisicao-Id (= lote_id) e o mesmo corpo.
            var lote = Fixtures.Ler<RequisicaoPush>("push.auditoria.requisicao.json");
            var push = await cliente.PushAsync(lote, ct);
            await cliente.PushAsync(lote, ct);
            Assert.Equal(StatusResultadoEvento.Duplicado, push.Resultados[0].Status);
            var pushes = handler.Envios.Where(e => e.Rota == "/sync/push").ToList();
            Assert.All(pushes, p => Assert.Equal(lote.LoteId.ToString("D"), p.RequisicaoId));
            Assert.All(pushes, p => Fixtures.AssertMesmoJson(Fixtures.Sync("push.auditoria.requisicao.json"), p.Corpo!, "corpo do /sync/push"));

            var hb = Fixtures.Ler<RequisicaoHeartbeat>("heartbeat.requisicao.json");
            var resposta = await cliente.HeartbeatAsync(hb, ct);
            Assert.Equal("ressincronizar_fluxo", resposta.Comandos[1].Tipo);
            Fixtures.AssertMesmoJson(Fixtures.Sync("heartbeat.requisicao.json"), handler.Envios.Single(e => e.Rota == "/sync/heartbeat").Corpo!, "corpo do heartbeat");
            // Os ids vão separados por vírgula numa query só (até 200); a resposta traz erro e retido com o código.
            var a = Guid.Parse("01a18771-4e5f-7061-8273-8d9e0f1a2b3c");
            var b = Guid.Parse("01a18774-7182-7394-b5a6-b02b3c4d5e6f");
            var status = await cliente.EventosStatusAsync([a, b], ct);
            Assert.Equal($"?ids={a:D},{b:D}", handler.Envios.Single(e => e.Rota == "/sync/eventos-status").Query);
            Assert.Equal(["aplicado", "descartado", "erro", "retido"], status.Eventos.Select(e => e.Status));
            Assert.Equal("DEPENDENCIA_PENDENTE", status.Eventos[3].Erro?.Codigo);
            Assert.Equal([StatusResultadoEvento.Aplicado, StatusResultadoEvento.Descartado],
                status.Eventos.Select(e => e.ComoResolvido()).OfType<EventoResolvido>().Select(r => r.Status));
            await Assert.ThrowsAsync<ArgumentException>(() => cliente.EventosStatusAsync([], ct));
            await Assert.ThrowsAsync<ArgumentException>(
                () => cliente.EventosStatusAsync([.. Enumerable.Range(0, ClienteSyncHttp.MaximoIdsEventosStatus + 1).Select(_ => Guid.NewGuid())], ct));
            Assert.All(handler.Envios.Where(e => e.Rota != "/sync/ativar"), e => Assert.True(e.Autenticado, e.Rota));
        }
    }

    [Fact]
    public void Heartbeat_minimo_nao_envia_nulos()
    {
        // O zod da API recusa null em campo só opcional (ex.: versao_app, so, cursor_pull): nulo não vai no corpo.
        var json = JsonNode.Parse(JsonSerializer.Serialize(new RequisicaoHeartbeat { EventosPendentes = 2 }, ContratosJson.Opcoes))!.AsObject();
        Assert.False(json.ContainsKey("versao_app"));
        Assert.False(json.ContainsKey("cursor_pull"));
        Assert.Equal("ativo", json["estado_local"]!.GetValue<string>());
        Assert.Equal(2, json["eventos_pendentes"]!.GetValue<int>());
    }

    private static ClienteSyncHttp Cliente(HttpMessageHandler handler, out HttpClient http)
    {
        http = new HttpClient(handler) { BaseAddress = new Uri("https://api.exemplo/") };
        return new ClienteSyncHttp(http, new ConfiguracaoClienteSync("1.4.2", "windows_x64", "3f1c9a2e8b7d4c6f"), new RelogioSistema(), () => "token-de-teste");
    }

    private sealed record Envio(string Rota, string Query, string RequisicaoId, bool Autenticado, string? Corpo);

    /// <summary>API falsa: responde cada rota do sync com a fixture de resposta (ou com o erro configurado) e grava o envio.</summary>
    private sealed class HandlerFixtures : HttpMessageHandler
    {
        private static readonly Dictionary<string, (HttpStatusCode Status, string Arquivo)> Respostas = new()
        {
            ["/sync/ativar"] = (HttpStatusCode.Created, "ativar.resposta.json"),
            ["/sync/estado"] = (HttpStatusCode.OK, "estado.resposta.json"),
            ["/sync/pull"] = (HttpStatusCode.OK, "pull.catalogo.resposta.json"),
            ["/sync/push"] = (HttpStatusCode.OK, "push.auditoria.resposta.json"),
            ["/sync/heartbeat"] = (HttpStatusCode.OK, "heartbeat.resposta.json"),
            ["/sync/eventos-status"] = (HttpStatusCode.OK, "eventos-status.resposta.json"),
        };

        public List<Envio> Envios { get; } = [];

        public (HttpStatusCode Status, string Corpo, Dictionary<string, string> Cabecalhos)? Erro { get; init; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            var corpo = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            Envios.Add(new Envio(uri.AbsolutePath, uri.Query, request.Headers.GetValues("X-Requisicao-Id").Single(), request.Headers.Authorization is not null, corpo));
            var (status, texto, cabecalhos) = Erro ?? (Respostas[uri.AbsolutePath].Status, Fixtures.Sync(Respostas[uri.AbsolutePath].Arquivo), []);
            var resposta = new HttpResponseMessage(status) { Content = new StringContent(texto, Encoding.UTF8, "application/json") };
            foreach (var (nome, valor) in cabecalhos)
            {
                resposta.Headers.Add(nome, valor);
            }

            return resposta;
        }
    }
}
