using System.Text.Json;
using System.Text.Json.Serialization;
using Velopack;

namespace GenesisPDV.Spike;

/// <summary>
/// O manifesto assinado de um canal (<c>manifesto.&lt;canal&gt;.json</c> + <c>.sig</c>, ao lado do feed do Velopack): o
/// sha256 do próprio <c>releases.&lt;canal&gt;.json</c>, o de cada pacote (completo e delta) e a versão mínima permitida.
/// O Velopack só confere o sha256 que vem no feed; quem invadisse o servidor de download trocaria os dois juntos. Com o
/// manifesto, o feed só vale se o sha256 dele for o que a chave do dono assinou.
/// </summary>
public sealed record Manifesto(
    [property: JsonPropertyName("formato")] int Formato,
    [property: JsonPropertyName("app")] string App,
    [property: JsonPropertyName("canal")] string Canal,
    [property: JsonPropertyName("versao")] string Versao,
    [property: JsonPropertyName("versao_minima_permitida")] string VersaoMinimaPermitida,
    [property: JsonPropertyName("feed")] ArquivoManifesto Feed,
    [property: JsonPropertyName("pacotes")] IReadOnlyList<PacoteManifesto> Pacotes)
{
    public const int FormatoAtual = 1;

    public SemanticVersion Minima => SemanticVersion.Parse(VersaoMinimaPermitida);

    public static Manifesto Ler(byte[] json)
    {
        var manifesto = JsonSerializer.Deserialize<Manifesto>(json)
            ?? throw new InvalidDataException("Manifesto vazio.");
        if (manifesto.Formato != FormatoAtual)
            throw new InvalidDataException($"Manifesto no formato {manifesto.Formato}; este app lê o {FormatoAtual}.");
        if (manifesto.Feed is null || manifesto.Pacotes is null || manifesto.Pacotes.Count == 0)
            throw new InvalidDataException("Manifesto sem o feed ou sem pacotes.");
        if (!SemanticVersion.TryParse(manifesto.Versao, out _) || !SemanticVersion.TryParse(manifesto.VersaoMinimaPermitida, out _))
            throw new InvalidDataException("Manifesto com versão inválida.");
        return manifesto;
    }

    public PacoteManifesto? Pacote(string arquivo) =>
        Pacotes.FirstOrDefault(p => string.Equals(p.Arquivo, arquivo, StringComparison.Ordinal));
}

public sealed record ArquivoManifesto(
    [property: JsonPropertyName("arquivo")] string Arquivo,
    [property: JsonPropertyName("sha256")] string Sha256);

/// <summary>
/// Um pacote do feed. O completo leva também o sha256 de cada arquivo de dentro dele (<see cref="Conteudo"/>): o completo
/// que o Velopack remonta a partir dos deltas tem os mesmos arquivos, byte a byte, mas o zip em volta sai diferente (outro
/// sha256 do .nupkg; conferido no ensaio do F3-B8). É pelo conteúdo que o remontado é conferido antes de aplicar.
/// </summary>
public sealed record PacoteManifesto(
    [property: JsonPropertyName("arquivo")] string Arquivo,
    [property: JsonPropertyName("tipo")] string Tipo,
    [property: JsonPropertyName("versao")] string Versao,
    [property: JsonPropertyName("tamanho")] long Tamanho,
    [property: JsonPropertyName("sha256")] string Sha256,
    [property: JsonPropertyName("conteudo")] IReadOnlyList<ArquivoManifesto>? Conteudo = null);
