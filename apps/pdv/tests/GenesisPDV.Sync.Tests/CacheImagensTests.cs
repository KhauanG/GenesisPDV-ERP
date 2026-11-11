using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using GenesisPDV.Sync.Cliente;
using GenesisPDV.Sync.Token;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Cache das imagens do catálogo (Fase 2, F2-B45; SYNC 6.12; README › decisão 85), do campo calculado do pull até o
/// arquivo no disco: a rota montada pelo id com o token (nunca a URL da linha), o sha256 conferido antes de gravar, o
/// nome local gerado pelo PDV, o limite de tamanho, o tipo fixo, o <c>304</c> e as falhas (rede, 404 da API antiga,
/// conteúdo trocado) que viram nulo sem exceção, com a espera antes de tentar de novo; e o limite de
/// <see cref="CacheImagens.DownloadsSimultaneos"/> downloads ao mesmo tempo, com a releitura do disco ao ganhar a vaga.
/// </summary>
public sealed class CacheImagensTests : IDisposable
{
    private static readonly Guid Arquivo = Guid.Parse("01a18790-0000-7000-8000-0000000000f1");
    private static readonly string Url = $"/sync/arquivos/{Arquivo:D}?variante=pdv_256";

    /// <summary>Uma "imagem" WebP inventada (só o cabeçalho RIFF e bytes fixos): o cache não decodifica, só confere o sha256.</summary>
    private static readonly byte[] Webp = [.. "RIFF"u8, 0x24, 0, 0, 0, .. "WEBPVP8 "u8, .. Enumerable.Range(0, 200).Select(i => (byte)i)];

    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Webp));

    private readonly string _pasta = Path.Combine(Path.GetTempPath(), "genesispdv-imagens", Guid.NewGuid().ToString("N"));
    private readonly RelogioAjustavel _relogio = new();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> responder) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Envios { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Envios.Add(request);
            return Task.FromResult(responder(request));
        }
    }

    /// <summary>
    /// API que segura cada download até o teste liberar o arquivo dele (<see cref="Liberar"/>): conta quantos estão em
    /// andamento ao mesmo tempo e avisa quando <see cref="Chegaram"/> pedidos chegaram.
    /// </summary>
    private sealed class HandlerPreso(Func<Guid, byte[]> conteudoDe) : HttpMessageHandler
    {
        private readonly ConcurrentDictionary<Guid, TaskCompletionSource> _portas = new();
        private readonly ConcurrentQueue<Guid> _envios = new();
        private readonly TaskCompletionSource _doisChegaram = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly Lock _trava = new();
        private int _emAndamento;
        private int _maximo;

        public IReadOnlyCollection<Guid> Envios => _envios;

        public int MaximoAoMesmoTempo
        {
            get
            {
                lock (_trava)
                {
                    return _maximo;
                }
            }
        }

        /// <summary>Completa quando dois downloads estão presos no handler ao mesmo tempo.</summary>
        public Task Chegaram => _doisChegaram.Task;

        public void Liberar(Guid arquivo) => Porta(arquivo).TrySetResult();

        private TaskCompletionSource Porta(Guid arquivo) =>
            _portas.GetOrAdd(arquivo, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously));

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var arquivo = Guid.Parse(request.RequestUri!.Segments[^1]);
            _envios.Enqueue(arquivo);
            lock (_trava)
            {
                _emAndamento++;
                _maximo = Math.Max(_maximo, _emAndamento);
                if (_emAndamento >= 2)
                {
                    _doisChegaram.TrySetResult();
                }
            }

            try
            {
                await Porta(arquivo).Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                lock (_trava)
                {
                    _emAndamento--;
                }
            }

            return Imagem(conteudoDe(arquivo), etag: Convert.ToHexStringLower(SHA256.HashData(conteudoDe(arquivo))));
        }
    }

    private static Guid ArquivoNumero(int n) => Guid.Parse($"01a18790-0000-7000-8000-0000000001{n:x2}");

    private static byte[] WebpNumero(int n) => [.. Webp, (byte)n];

    private static string ShaNumero(int n) => Convert.ToHexStringLower(SHA256.HashData(WebpNumero(n)));

    private static string UrlNumero(int n) => $"/sync/arquivos/{ArquivoNumero(n):D}?variante=pdv_256";

    private CacheImagens MontarPreso(HandlerPreso api) =>
        new(
            new ClienteSyncHttp(
                new HttpClient(api) { BaseAddress = new Uri("https://api.exemplo/") },
                new ConfiguracaoClienteSync("0.12.0", "windows_x64", "3f1c9a2e8b7d4c6f"),
                _relogio,
                new FonteTokenFixa(() => "token-de-teste")),
            _pasta,
            _relogio);

    private static HttpResponseMessage Imagem(byte[] conteudo, string tipo = "image/webp", string? etag = null)
    {
        var r = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(conteudo) };
        r.Content.Headers.ContentType = new MediaTypeHeaderValue(tipo);
        r.Headers.ETag = new EntityTagHeaderValue($"\"{etag ?? Sha}\"");
        return r;
    }

    private (CacheImagens Cache, Handler Api, ClienteSyncHttp Cliente) Montar(Func<HttpRequestMessage, HttpResponseMessage> responder)
    {
        var api = new Handler(responder);
        var cliente = new ClienteSyncHttp(
            new HttpClient(api) { BaseAddress = new Uri("https://api.exemplo/") },
            new ConfiguracaoClienteSync("0.12.0", "windows_x64", "3f1c9a2e8b7d4c6f"),
            _relogio,
            new FonteTokenFixa(() => "token-de-teste"));
        return (new CacheImagens(cliente, _pasta, _relogio), api, cliente);
    }

    public void Dispose()
    {
        if (Directory.Exists(_pasta))
        {
            Directory.Delete(_pasta, recursive: true);
        }
    }

    [Fact]
    public async Task Baixa_a_variante_pela_rota_do_id_confere_o_sha256_e_grava_com_o_nome_gerado()
    {
        var (cache, api, _) = Montar(_ => Imagem(Webp));

        var caminho = await cache.ObterAsync(Url, Sha, Ct);

        Assert.Equal(Path.Combine(_pasta, $"{Sha}.webp"), caminho);
        Assert.Equal(Webp, await File.ReadAllBytesAsync(caminho!, Ct));
        var envio = Assert.Single(api.Envios);
        Assert.Equal(HttpMethod.Get, envio.Method);
        Assert.Equal($"https://api.exemplo/sync/arquivos/{Arquivo:D}?variante=pdv_256", envio.RequestUri!.ToString());
        Assert.Equal("token-de-teste", envio.Headers.Authorization?.Parameter);
        // Nenhum temporário sobra na pasta.
        Assert.Equal([$"{Sha}.webp"], Directory.GetFiles(_pasta).Select(Path.GetFileName));

        // Já no cache: nem vai à rede.
        Assert.Equal(caminho, await cache.ObterAsync(Url, Sha, Ct));
        Assert.Single(api.Envios);
    }

    [Theory]
    [InlineData("https://outro.exemplo/sync/arquivos/01a18790-0000-7000-8000-0000000000f1?variante=pdv_256")]
    [InlineData("/sync/arquivos/01a18790-0000-7000-8000-0000000000f1?variante=original")]
    [InlineData("/sync/arquivos/../../etc/passwd?variante=pdv_256")]
    [InlineData("/sync/arquivos/01a18790-0000-7000-8000-0000000000f1?variante=pdv_256&x=1")]
    [InlineData("")]
    [InlineData(null)]
    public async Task Url_fora_do_formato_estavel_nao_vai_a_rede(string? url)
    {
        var (cache, api, _) = Montar(_ => Imagem(Webp));
        Assert.Null(CacheImagens.IdDaUrl(url));
        Assert.Null(await cache.ObterAsync(url, Sha, Ct));
        Assert.Empty(api.Envios);
    }

    [Theory]
    [InlineData("../../../../tmp/x")]
    [InlineData("ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789")]
    [InlineData("abc")]
    [InlineData(null)]
    public async Task Sha256_fora_do_formato_nao_vira_caminho(string? sha)
    {
        var (cache, api, _) = Montar(_ => Imagem(Webp));
        Assert.Null(cache.CaminhoLocal(sha));
        Assert.Null(await cache.ObterAsync(Url, sha, Ct));
        Assert.Empty(api.Envios);
        Assert.False(Directory.Exists(_pasta));
    }

    [Fact]
    public async Task Conteudo_com_outro_sha256_nao_e_gravado_e_espera_antes_de_tentar_de_novo()
    {
        var conteudo = Webp;
        var (cache, api, _) = Montar(_ => Imagem(conteudo));
        var outro = new string('a', 64);

        Assert.Null(await cache.ObterAsync(Url, outro, Ct));
        Assert.False(File.Exists(Path.Combine(_pasta, $"{outro}.webp")));
        // Dentro da espera, nem tenta (não insiste na API a cada tela).
        Assert.Null(await cache.ObterAsync(Url, outro, Ct));
        Assert.Single(api.Envios);

        _relogio.Agora += CacheImagens.EsperaAposFalha + TimeSpan.FromSeconds(1);
        conteudo = Encoding.ASCII.GetBytes("a imagem certa nunca chegou");
        Assert.Null(await cache.ObterAsync(Url, outro, Ct));
        Assert.Equal(2, api.Envios.Count);
    }

    [Fact]
    public async Task Rede_fora_api_antiga_tipo_errado_e_imagem_grande_viram_nulo_sem_excecao()
    {
        HttpResponseMessage[] respostas =
        [
            new(HttpStatusCode.NotFound) { Content = new StringContent("""{"erro":{"codigo":"NAO_ENCONTRADO","mensagem":"x","detalhes":{},"requisicao_id":null}}""", Encoding.UTF8, "application/json") },
            Imagem(Webp, tipo: "text/html"),
            Imagem(new byte[CacheImagens.LimiteBytes + 1]),
        ];
        foreach (var resposta in respostas)
        {
            var (cache, _, _) = Montar(_ => resposta);
            Assert.Null(await cache.ObterAsync(Url, Sha, Ct));
        }

        var (foraDoAr, _, _) = Montar(_ => throw new HttpRequestException("sem rota para o host"));
        Assert.Null(await foraDoAr.ObterAsync(Url, Sha, Ct));
        Assert.False(Directory.Exists(_pasta) && Directory.GetFiles(_pasta).Length > 0);
    }

    [Fact]
    public async Task Corpo_maior_que_o_limite_sem_content_length_e_cortado()
    {
        var (_, _, cliente) = Montar(_ =>
        {
            var r = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new MemoryStream(new byte[100_000])) };
            r.Content.Headers.ContentType = new MediaTypeHeaderValue("image/webp");
            r.Content.Headers.ContentLength = null;
            return r;
        });

        var e = await Assert.ThrowsAsync<ErroSyncException>(() => cliente.BaixarArquivoAsync(Arquivo, null, 1024, Ct));
        Assert.Contains("1024", e.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task If_none_match_com_o_sha256_e_o_304_voltam_como_nao_modificado()
    {
        var (_, api, cliente) = Montar(_ => new HttpResponseMessage(HttpStatusCode.NotModified) { Headers = { ETag = new EntityTagHeaderValue($"\"{Sha}\"") } });

        var r = await cliente.BaixarArquivoAsync(Arquivo, Sha, CacheImagens.LimiteBytes, Ct);

        Assert.True(r.NaoModificado);
        Assert.Null(r.Conteudo);
        Assert.Equal(Sha, r.Etag);
        Assert.Equal($"\"{Sha}\"", Assert.Single(api.Envios).Headers.IfNoneMatch.Single().Tag);
    }

    [Fact]
    public async Task No_maximo_dois_downloads_ao_mesmo_tempo()
    {
        var numeros = Enumerable.Range(1, 4).ToArray();
        var porArquivo = numeros.ToDictionary(ArquivoNumero, WebpNumero);
        var api = new HandlerPreso(id => porArquivo[id]);
        var cache = MontarPreso(api);

        var pedidos = numeros.Select(n => cache.ObterAsync(UrlNumero(n), ShaNumero(n), Ct)).ToArray();
        await api.Chegaram.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        // Tempo para um terceiro download chegar ao handler se o limite não existisse.
        await Task.Delay(200, Ct);
        Assert.Equal(2, api.Envios.Count);

        foreach (var n in numeros)
        {
            api.Liberar(ArquivoNumero(n));
        }

        var caminhos = await Task.WhenAll(pedidos).WaitAsync(TimeSpan.FromSeconds(10), Ct);
        Assert.Equal(numeros.Select(n => Path.Combine(_pasta, $"{ShaNumero(n)}.webp")), caminhos);
        Assert.Equal(4, api.Envios.Count);
        Assert.Equal(CacheImagens.DownloadsSimultaneos, api.MaximoAoMesmoTempo);
    }

    [Fact]
    public async Task Mesma_imagem_pedida_enquanto_baixa_espera_a_vaga_e_usa_o_arquivo_gravado()
    {
        var porArquivo = new Dictionary<Guid, byte[]> { [ArquivoNumero(1)] = WebpNumero(1), [ArquivoNumero(2)] = WebpNumero(2) };
        var api = new HandlerPreso(id => porArquivo[id]);
        var cache = MontarPreso(api);

        // As duas vagas ocupadas: a imagem 1 e a 2 presas no handler; o segundo pedido da 1 fica esperando a vaga.
        var primeiro = cache.ObterAsync(UrlNumero(1), ShaNumero(1), Ct);
        var outra = cache.ObterAsync(UrlNumero(2), ShaNumero(2), Ct);
        await api.Chegaram.WaitAsync(TimeSpan.FromSeconds(10), Ct);
        var repetido = cache.ObterAsync(UrlNumero(1), ShaNumero(1), Ct);
        Assert.False(repetido.IsCompleted);

        // A 1 termina e grava; o pedido repetido ganha a vaga dela, relê o disco e não vai à rede.
        api.Liberar(ArquivoNumero(1));
        var caminho = Path.Combine(_pasta, $"{ShaNumero(1)}.webp");
        Assert.Equal(caminho, await primeiro.WaitAsync(TimeSpan.FromSeconds(10), Ct));
        Assert.Equal(caminho, await repetido.WaitAsync(TimeSpan.FromSeconds(10), Ct));
        Assert.Equal(1, api.Envios.Count(a => a == ArquivoNumero(1)));

        api.Liberar(ArquivoNumero(2));
        Assert.Equal(Path.Combine(_pasta, $"{ShaNumero(2)}.webp"), await outra.WaitAsync(TimeSpan.FromSeconds(10), Ct));
        Assert.Equal(2, api.Envios.Count);
    }
}
