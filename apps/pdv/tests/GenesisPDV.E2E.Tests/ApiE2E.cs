using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace GenesisPDV.E2E.Tests;

/// <summary>
/// Estado gravado pelo servidor do e2e (<c>apps/api/test/e2e-pdv/servidor.ts</c>) em <c>GENESIS_E2E_ESTADO</c>: URL da
/// API, empresa, credenciais do ERP, operador e gerente com PIN, os ids de loja (a "Treino" do piloto, O10), estoque,
/// caixas e produto, e o catálogo do caixa da Fase 1C (lata com fardo, retornável com casco e combo).
/// </summary>
public sealed record EstadoE2E(
    [property: JsonPropertyName("api")] string Api,
    [property: JsonPropertyName("codigoEmpresa")] int CodigoEmpresa,
    [property: JsonPropertyName("erp")] CredencialErp Erp,
    [property: JsonPropertyName("operador")] OperadorE2E Operador,
    [property: JsonPropertyName("gerente")] OperadorE2E Gerente,
    [property: JsonPropertyName("lojaId")] Guid LojaId,
    [property: JsonPropertyName("estoqueId")] Guid EstoqueId,
    [property: JsonPropertyName("caixas")] IReadOnlyList<Guid> Caixas,
    [property: JsonPropertyName("produto")] ProdutoE2E Produto,
    [property: JsonPropertyName("catalogo")] CatalogoE2E Catalogo)
{
    public const string VariavelApi = "GENESIS_E2E_API";
    public const string VariavelEstado = "GENESIS_E2E_ESTADO";

    /// <summary>
    /// Definida pelo <c>rodar.sh</c> (job <c>e2e-sync</c>): o roteiro roda mesmo sem <c>GENESIS_E2E_API</c> e falha dizendo
    /// o que falta, em vez de ser pulado em silêncio (o <c>EstadoE2ETests</c> sozinho deixaria o job verde).
    /// </summary>
    public const string VariavelExigir = "GENESIS_E2E_EXIGIR";

    /// <summary>Os testes só rodam com <c>GENESIS_E2E_API</c> (job <c>e2e-sync</c> do CI ou à mão, README do PDV) ou exigidos.</summary>
    public static bool Habilitado => Definida(VariavelApi) || Definida(VariavelExigir);

    private static bool Definida(string variavel) => !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(variavel));

    /// <summary>Espera o servidor gravar o estado (ele só grava com tudo pronto), por polling com tempo limite.</summary>
    public static async Task<EstadoE2E> CarregarAsync(TimeSpan limite)
    {
        var api = Environment.GetEnvironmentVariable(VariavelApi) is { Length: > 0 } definida
            ? definida.TrimEnd('/') + "/"
            : throw new InvalidOperationException($"{VariavelExigir} definida sem {VariavelApi}: o roteiro do e2e não tem a API para rodar.");
        var arquivo = Environment.GetEnvironmentVariable(VariavelEstado)
                      ?? throw new InvalidOperationException($"Defina {VariavelEstado} com o arquivo de estado do servidor do e2e.");
        var fim = DateTime.UtcNow + limite;
        while (!File.Exists(arquivo))
        {
            if (DateTime.UtcNow > fim)
            {
                throw new TimeoutException($"O servidor do e2e não gravou {arquivo} em {limite.TotalSeconds:0} s.");
            }

            await Task.Delay(250);
        }

        var estado = JsonSerializer.Deserialize<EstadoE2E>(await File.ReadAllTextAsync(arquivo))!;
        return estado.Api == api ? estado : throw new InvalidOperationException($"{VariavelApi}={api}, mas o servidor está em {estado.Api}.");
    }
}

public sealed record CredencialErp([property: JsonPropertyName("login")] string Login, [property: JsonPropertyName("senha")] string Senha);

public sealed record OperadorE2E(
    [property: JsonPropertyName("login")] string Login,
    [property: JsonPropertyName("pin")] string Pin,
    [property: JsonPropertyName("nome")] string Nome);

public sealed record ProdutoE2E(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("ean")] string Ean,
    [property: JsonPropertyName("preco")] string Preco);

/// <summary>Catálogo do caixa da Fase 1C criado pelo ERP no servidor do e2e (C13).</summary>
public sealed record CatalogoE2E(
    [property: JsonPropertyName("lata")] LataE2E Lata,
    [property: JsonPropertyName("retornavel")] CodigoE2E Retornavel,
    [property: JsonPropertyName("casco")] CodigoE2E Casco,
    [property: JsonPropertyName("combo")] CodigoE2E Combo,
    [property: JsonPropertyName("componentesCombo")] IReadOnlyList<Guid> ComponentesCombo);

/// <summary>Lata vendida por unidade (EAN) e pelo fardo de 12 (DUN).</summary>
public sealed record LataE2E(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("ean")] string Ean,
    [property: JsonPropertyName("dun")] string Dun);

public sealed record CodigoE2E(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("ean")] string? Ean = null);

/// <summary>O que o gerente faz no ERP durante o roteiro, pelas mesmas rotas da tela PDVs/Terminais e do cadastro de produto.</summary>
public sealed class ErpE2E : IDisposable
{
    private readonly HttpClient _http;

    private ErpE2E(HttpClient http) => _http = http;

    public static Task<ErpE2E> EntrarAsync(EstadoE2E estado)
    {
        ArgumentNullException.ThrowIfNull(estado);
        return EntrarAsync(estado.Api, estado.CodigoEmpresa, estado.Erp);
    }

    /// <summary>Login no ERP com a API, a empresa e a credencial (o ensaio do piloto tem um estado próprio, I5).</summary>
    public static async Task<ErpE2E> EntrarAsync(string api, int codigoEmpresa, CredencialErp erp)
    {
        ArgumentNullException.ThrowIfNull(erp);
        var http = new HttpClient { BaseAddress = new Uri(api), Timeout = TimeSpan.FromSeconds(60) };
        using var resposta = await http.PostAsJsonAsync("api/auth/login",
            new { codigoEmpresa, login = erp.Login, senha = erp.Senha });
        var corpo = await LerAsync(resposta);
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", corpo["tokenAcesso"]!.GetValue<string>());
        return new ErpE2E(http);
    }

    /// <summary>ERP 12.3: código de ativação para o caixa (o formato de tela, <c>XXXX-XXXX</c>).</summary>
    public async Task<string> GerarCodigoAsync(Guid lojaId, Guid caixaId)
    {
        using var r = await _http.PostAsJsonAsync("api/terminais/ativacoes", new { lojaId, caixaId, validadeHoras = 1 });
        return (await LerAsync(r))["codigo"]!.GetValue<string>();
    }

    /// <summary>Detalhe do terminal (ERP 12.4): status, <c>cursorPull</c> do último heartbeat, desativação confirmada.</summary>
    public async Task<JsonNode> TerminalAsync(Guid terminalId)
    {
        using var r = await _http.GetAsync(new Uri($"api/terminais/{terminalId:D}", UriKind.Relative));
        return await LerAsync(r);
    }

    /// <summary>Muda o preço como a tela do produto: o detalhe atual com o preço novo, no <c>PUT</c> (com a versão).</summary>
    public async Task AlterarPrecoAsync(Guid produtoId, string preco)
    {
        using var atual = await _http.GetAsync(new Uri($"api/produtos/{produtoId:D}", UriKind.Relative));
        var corpo = (await LerAsync(atual)).AsObject();
        corpo["precoVenda"] = preco;
        using var r = await _http.PutAsJsonAsync(new Uri($"api/produtos/{produtoId:D}", UriKind.Relative), corpo);
        await LerAsync(r);
    }

    /// <summary>
    /// ERP 12.4 › Revogar: <c>aceitar_pendencias</c>, <c>imediato</c> ou <c>perdido</c>; os dois últimos pedem o número do
    /// caixa digitado como confirmação (lido do detalhe, como a tela mostra).
    /// </summary>
    public async Task RevogarAsync(Guid terminalId, string modo)
    {
        object corpo = modo == "aceitar_pendencias"
            ? new { modo }
            : new { modo, confirmacaoCaixa = (await TerminalAsync(terminalId))["numeroCaixa"]!.GetValue<int>() };
        using var r = await _http.PostAsJsonAsync(new Uri($"api/terminais/{terminalId:D}/revogar", UriKind.Relative), corpo);
        if (!r.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"Revogar {modo}: HTTP {(int)r.StatusCode} {await r.Content.ReadAsStringAsync()}");
        }
    }

    /// <summary>Uma rota de consulta do ERP (vendas 15.4, sangrias 15.3, fechamentos 14.9, saldos…), o corpo em JSON.</summary>
    public async Task<JsonNode> ObterAsync(string rota)
    {
        using var r = await _http.GetAsync(new Uri(rota, UriKind.Relative));
        return await LerAsync(r);
    }

    /// <summary>Quantas linhas de auditoria de hoje a nuvem tem com a ação e a origem (ERP 17.3).</summary>
    public async Task<int> AuditoriaAsync(string acao, string origem)
    {
        using var r = await _http.GetAsync(new Uri($"api/auditoria?acao={acao}&origem={origem}", UriKind.Relative));
        return (await LerAsync(r))["total"]!.GetValue<int>();
    }

    public void Dispose() => _http.Dispose();

    private static async Task<JsonNode> LerAsync(HttpResponseMessage resposta)
    {
        var texto = await resposta.Content.ReadAsStringAsync();
        if (!resposta.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"{resposta.RequestMessage?.Method} {resposta.RequestMessage?.RequestUri}: HTTP {(int)resposta.StatusCode} {texto}");
        }

        return JsonNode.Parse(texto)!;
    }
}
