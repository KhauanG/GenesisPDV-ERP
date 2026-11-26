using System.Security.Cryptography;
using System.Text;
using Velopack;
using Velopack.Logging;
using Velopack.Sources;

namespace GenesisPDV.Spike;

/// <summary>
/// A fonte de atualização do Velopack com o manifesto assinado na frente (critério (b) do F3-B8). Antes de o
/// <see cref="UpdateManager"/> ver qualquer versão: lê o <c>manifesto.&lt;canal&gt;.json</c> e o <c>.sig</c>, confere a
/// assinatura com a chave embutida, o app, o canal e o piso da versão mínima; só então lê o feed, que tem de ter o sha256
/// assinado; cada pacote do feed tem de estar no manifesto com o mesmo nome, tamanho e sha256 (o sha256 é obrigatório:
/// sem ele o Velopack cairia para o SHA1) e os abaixo da mínima permitida saem. Cada download é conferido de novo contra o
/// manifesto. A pasta ou o endereço https vêm do build no PDV (F3-B32); no protótipo, do <c>--fonte</c> do roteiro.
/// </summary>
public sealed class FonteAssinada : IUpdateSource
{
    private readonly string _base;
    private readonly string _chavePublica;
    private readonly string _appId;
    private readonly EstadoLocal _estado;
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };

    public FonteAssinada(string baseFonte, string chavePublica, string appId, EstadoLocal estado)
    {
        if (baseFonte.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A fonte de atualização só pode ser https (ou uma pasta, no protótipo).");
        _base = baseFonte;
        _chavePublica = chavePublica;
        _appId = appId;
        _estado = estado;
    }

    /// <summary>O manifesto aceito na última consulta (o pacote baixado é conferido contra ele antes de aplicar).</summary>
    public Manifesto? ManifestoAceito { get; private set; }

    public async Task<VelopackAssetFeed> GetReleaseFeed(
        IVelopackLogger logger, string? appId, string channel, Guid? stagingId = null, VelopackAsset? latestLocalRelease = null)
    {
        ManifestoAceito = null;
        var nomeManifesto = $"manifesto.{channel}.json";
        var bytesManifesto = await LerAsync(nomeManifesto).ConfigureAwait(false);
        var assinatura = Encoding.UTF8.GetString(await LerAsync(nomeManifesto + ".sig").ConfigureAwait(false));

        // 1) a assinatura sobre os bytes exatos do manifesto, antes de interpretar qualquer campo dele.
        AssinaturaSsh.Conferir(bytesManifesto, assinatura, _chavePublica);
        var manifesto = Manifesto.Ler(bytesManifesto);

        // 2) o manifesto é deste app e deste canal (um manifesto do beta assinado não serve para o estável).
        if (manifesto.App != _appId)
            throw new RecusaAtualizacaoException($"o manifesto é do app '{manifesto.App}', não do '{_appId}'");
        if (manifesto.Canal != channel)
            throw new RecusaAtualizacaoException($"o manifesto é do canal '{manifesto.Canal}', não do '{channel}'");

        // 3) o piso só sobe: um manifesto antigo (assinado, mas com a mínima menor que a de um já aceito) é repetição.
        var piso = _estado.Piso is { } textoPiso ? SemanticVersion.Parse(textoPiso) : null;
        if (piso is not null && manifesto.Minima < piso)
            throw new RecusaAtualizacaoException(
                $"manifesto antigo: a mínima permitida dele ({manifesto.Minima}) é menor que a de um já aceito ({piso})");

        // 4) o feed do Velopack só vale com o sha256 assinado.
        if (manifesto.Feed.Arquivo != $"releases.{channel}.json")
            throw new RecusaAtualizacaoException($"o manifesto aponta outro feed ({manifesto.Feed.Arquivo})");
        var bytesFeed = await LerAsync(manifesto.Feed.Arquivo).ConfigureAwait(false);
        var sha256Feed = Convert.ToHexStringLower(SHA256.HashData(bytesFeed));
        if (!string.Equals(sha256Feed, manifesto.Feed.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new RecusaAtualizacaoException("o feed não é o que o manifesto assinou (sha256 diferente)");
        var feed = VelopackAssetFeed.FromJson(Encoding.UTF8.GetString(bytesFeed));

        // 5) cada pacote do feed precisa estar no manifesto, igual; abaixo da mínima permitida, sai.
        var aceitos = new List<VelopackAsset>();
        foreach (var pacote in feed.Assets ?? [])
        {
            var assinado = manifesto.Pacote(pacote.FileName)
                ?? throw new RecusaAtualizacaoException($"o pacote {pacote.FileName} está no feed e não no manifesto");
            if (string.IsNullOrEmpty(pacote.SHA256)
                || !string.Equals(pacote.SHA256, assinado.Sha256, StringComparison.OrdinalIgnoreCase)
                || pacote.Size != assinado.Tamanho
                || pacote.Version.ToString() != assinado.Versao
                || !string.Equals(pacote.Type.ToString(), assinado.Tipo, StringComparison.OrdinalIgnoreCase))
                throw new RecusaAtualizacaoException($"o pacote {pacote.FileName} do feed difere do manifesto");
            if (pacote.Version < manifesto.Minima)
            {
                logger.Info($"Pacote {pacote.FileName} abaixo da mínima permitida {manifesto.Minima}: ignorado.");
                continue;
            }
            aceitos.Add(pacote);
        }

        if (piso is null || manifesto.Minima > piso)
            _estado.Piso = manifesto.Minima.ToString();
        ManifestoAceito = manifesto;
        logger.Info($"Manifesto {nomeManifesto} aceito: versão {manifesto.Versao}, mínima permitida {manifesto.Minima}.");
        return feed with { Assets = aceitos.ToArray() };
    }

    public async Task DownloadReleaseEntry(
        IVelopackLogger logger, VelopackAsset releaseEntry, string localFile, Action<int> progress, CancellationToken cancelToken = default)
    {
        var assinado = ManifestoAceito?.Pacote(releaseEntry.FileName)
            ?? throw new RecusaAtualizacaoException($"download de {releaseEntry.FileName} sem manifesto aceito");
        var bytes = await LerAsync(releaseEntry.FileName, cancelToken).ConfigureAwait(false);
        await File.WriteAllBytesAsync(localFile, bytes, cancelToken).ConfigureAwait(false);
        progress(100);
        var sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (bytes.LongLength != assinado.Tamanho || !string.Equals(sha256, assinado.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            File.Delete(localFile);
            throw new RecusaAtualizacaoException($"o pacote baixado {releaseEntry.FileName} não confere com o manifesto");
        }
    }

    private async Task<byte[]> LerAsync(string nome, CancellationToken cancelamento = default)
    {
        if (nome.Contains('/', StringComparison.Ordinal) || nome.Contains('\\', StringComparison.Ordinal) || nome.Contains("..", StringComparison.Ordinal))
            throw new RecusaAtualizacaoException($"nome de arquivo inválido na fonte: {nome}");
        if (_base.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return await Http.GetByteArrayAsync(new Uri(new Uri(_base.TrimEnd('/') + "/"), nome), cancelamento).ConfigureAwait(false);
        var caminho = Path.Combine(_base, nome);
        if (!File.Exists(caminho))
            throw new RecusaAtualizacaoException($"a fonte não tem o arquivo {nome}");
        return await File.ReadAllBytesAsync(caminho, cancelamento).ConfigureAwait(false);
    }
}

public sealed class RecusaAtualizacaoException(string motivo) : Exception($"Atualização recusada: {motivo}.");
