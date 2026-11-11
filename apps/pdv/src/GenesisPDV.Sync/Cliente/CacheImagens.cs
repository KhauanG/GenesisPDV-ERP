using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using GenesisPDV.Core.Comum;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace GenesisPDV.Sync.Cliente;

/// <summary>
/// Cache local das imagens do catálogo (Fase 2, F2-B45; SYNC 6.12; README › decisão 85): a variante <c>pdv_256</c> da foto
/// do produto, da imagem da categoria e do logotipo da marca, pelos campos calculados do pull (<c>*_url</c>,
/// <c>*_sha256</c>).
/// <list type="bullet">
/// <item><b>Nada vem da linha para o disco nem para a rede sem conferência:</b> do <c>*_url</c> só se aproveita o id do
/// arquivo, e só no formato exato <c>/sync/arquivos/{uuid}?variante=pdv_256</c> (a rota é montada pelo
/// <see cref="IClienteSync"/>, o token nunca vai a outro endereço); o nome local é <c>&lt;sha256&gt;.webp</c>, com o sha256
/// conferido como 64 dígitos hexadecimais (sem caminho vindo de fora, sem path traversal).</item>
/// <item><b>Integridade:</b> o download tem limite de tamanho (<see cref="LimiteBytes"/>), e o sha256 do conteúdo precisa
/// ser o da linha antes de gravar. A gravação é num temporário da mesma pasta, trocado de uma vez pelo nome final: nunca
/// fica meia imagem com o nome certo.</item>
/// <item><b>Offline-first:</b> <see cref="ObterAsync"/> nunca lança (salvo o cancelamento de quem chamou): sem rede, API
/// antiga (404), imagem trocada ou corrompida, disco cheio — devolve nulo, a tela mostra o placeholder e a venda e a
/// sincronização seguem. A falha de uma imagem espera <see cref="EsperaAposFalha"/> antes de tentar de novo.</item>
/// <item>No máximo <see cref="DownloadsSimultaneos"/> downloads ao mesmo tempo (SYNC 6.12). O descarte LRU (500 MB) e a
/// exibição da foto ficam para quando <c>pdv.exibe_foto_produto</c> for ligada (padrão <c>false</c>, fora da Fase 2).</item>
/// </list>
/// </summary>
public sealed partial class CacheImagens(IClienteSync cliente, string pasta, IRelogio relogio, ILogger<CacheImagens>? log = null)
{
    /// <summary>Teto do download (a <c>pdv_256</c> tem 10–20 KB; o mesmo limite do endpoint na API).</summary>
    public const int LimiteBytes = 512 * 1024;

    public const int DownloadsSimultaneos = 2;

    public static readonly TimeSpan EsperaAposFalha = TimeSpan.FromMinutes(10);

    private const string Extensao = ".webp";

    private readonly ILogger _log = log ?? NullLogger<CacheImagens>.Instance;
    private readonly SemaphoreSlim _vagas = new(DownloadsSimultaneos, DownloadsSimultaneos);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _falhas = new(StringComparer.Ordinal);

    public string Pasta { get; } = pasta;

    [GeneratedRegex("^/sync/arquivos/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\\?variante=pdv_256$", RegexOptions.CultureInvariant)]
    private static partial Regex FormatoUrl();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex FormatoSha256();

    /// <summary>O id do arquivo de um <c>*_url</c> do pull, só no formato estável da API (SYNC 6.12); outro texto = nulo.</summary>
    public static Guid? IdDaUrl(string? url) =>
        url is not null && FormatoUrl().Match(url) is { Success: true } m ? Guid.Parse(m.Groups[1].Value) : null;

    /// <summary>Caminho local de um sha256 válido (64 hexadecimais em minúsculas); outro texto = nulo.</summary>
    public string? CaminhoLocal(string? sha256) =>
        sha256 is not null && FormatoSha256().IsMatch(sha256) ? Path.Combine(Pasta, sha256 + Extensao) : null;

    /// <summary>
    /// O arquivo local da imagem (baixando se faltar), ou nulo quando não há imagem, os campos não estão no formato, ou o
    /// download falhou. Nunca lança por rede, API ou disco.
    /// </summary>
    public async Task<string?> ObterAsync(string? url, string? sha256, CancellationToken ct = default)
    {
        var id = IdDaUrl(url);
        var destino = CaminhoLocal(sha256);
        if (id is null || destino is null)
        {
            return null;
        }

        if (File.Exists(destino))
        {
            return destino;
        }

        if (_falhas.TryGetValue(sha256!, out var falhouEm) && relogio.Agora - falhouEm < EsperaAposFalha)
        {
            return null;
        }

        await _vagas.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Outro pedido da mesma imagem pode ter gravado enquanto este esperava a vaga.
            if (File.Exists(destino))
            {
                return destino;
            }

            var baixado = await cliente.BaixarArquivoAsync(id.Value, etag: null, LimiteBytes, ct).ConfigureAwait(false);
            if (baixado.Conteudo is not { Length: > 0 } conteudo)
            {
                return Falhou(sha256!, "a API não mandou o conteúdo");
            }

            var calculado = Convert.ToHexStringLower(SHA256.HashData(conteudo));
            if (!string.Equals(calculado, sha256, StringComparison.Ordinal))
            {
                return Falhou(sha256!, $"sha256 diferente do cadastro ({calculado})");
            }

            Directory.CreateDirectory(Pasta);
            var temporario = Path.Combine(Pasta, $".baixando-{Guid.NewGuid():N}.tmp");
            try
            {
                await File.WriteAllBytesAsync(temporario, conteudo, ct).ConfigureAwait(false);
                File.Move(temporario, destino, overwrite: true);
            }
            finally
            {
                if (File.Exists(temporario))
                {
                    File.Delete(temporario);
                }
            }

            _falhas.TryRemove(sha256!, out _);
            return destino;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e)
        {
            // Rede, prazo, API antiga (404), resposta fora do contrato, disco cheio ou sem permissão: só o placeholder.
            return Falhou(sha256!, e.Message);
        }
        finally
        {
            _vagas.Release();
        }
    }

    private string? Falhou(string sha256, string motivo)
    {
        _falhas[sha256] = relogio.Agora;
        _log.LogInformation("Imagem {Sha256} não baixada ({Motivo}); a tela segue com o placeholder", sha256, motivo);
        return null;
    }
}
