using System.Globalization;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// O que o build grava no executável (implantação I3, README do PDV › decisão 62): a URL padrão da API do assistente de
/// ativação, pela propriedade MSBuild <c>GenesisUrlApiPadrao</c> (um <c>AssemblyMetadata</c>; o padrão do produto é
/// <see cref="UrlApiProduto"/> e o instalador do piloto sai com <c>-p:GenesisUrlApiPadrao=https://api.grupoicebeer.com.br</c>),
/// e se é um build de demonstração (<c>ModoDemonstracao</c>, fora de todo <c>dotnet publish</c>). A variável
/// <c>GENESISPDV_API</c> continua sobrepondo a URL, e o campo continua editável no assistente.
/// </summary>
public static class ConfiguracaoBuild
{
    public const string ChaveUrlApiPadrao = "GenesisUrlApiPadrao";

    public const string UrlApiProduto = "https://api.genesispdv.com.br";

    /// <summary>Argumento que grava o <see cref="InfoBuild"/> num arquivo e sai (a conferência do executável no CI).</summary>
    public const string ArgumentoInfoBuild = "--info-build";

    public static string UrlApiPadrao { get; } = Ler(typeof(ConfiguracaoBuild).Assembly, ChaveUrlApiPadrao) ?? UrlApiProduto;

#if MODO_DEMONSTRACAO
    public const bool ModoDemonstracao = true;
#else
    public const bool ModoDemonstracao = false;
#endif

    /// <summary>A URL que o assistente mostra: a da variável (desenvolvimento, homologação, e2e) ou a do build.</summary>
    public static string UrlApiInicial(string? variavel) => string.IsNullOrWhiteSpace(variavel) ? UrlApiPadrao : variavel.Trim();

    /// <summary>Valor de um <c>AssemblyMetadata</c> (vazio conta como ausente).</summary>
    public static string? Ler(Assembly assembly, string chave)
    {
        ArgumentNullException.ThrowIfNull(assembly);
        var valor = assembly.GetCustomAttributes<AssemblyMetadataAttribute>().LastOrDefault(a => a.Key == chave)?.Value;
        return string.IsNullOrWhiteSpace(valor) ? null : valor.Trim();
    }

    public static InfoBuild Info() => new(VersaoApp.Atual, UrlApiPadrao, ModoDemonstracao);

    /// <summary>
    /// <c>GenesisPDV --info-build arquivo.json</c>: grava versão, URL padrão e modo de demonstração e sai sem abrir tela
    /// nem banco. O CI confere o executável publicado (o instalador do piloto não pode sair com a demonstração nem com
    /// outra URL); num arquivo porque o <c>WinExe</c> não tem console no Windows.
    /// </summary>
    public static void GravarInfo(string arquivo) =>
        File.WriteAllText(arquivo, JsonSerializer.Serialize(Info(), InfoBuild.Json));
}

public sealed record InfoBuild(
    [property: JsonPropertyName("versao")] string Versao,
    [property: JsonPropertyName("url_api_padrao")] string UrlApiPadrao,
    [property: JsonPropertyName("modo_demonstracao")] bool ModoDemonstracao)
{
    internal static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
}

/// <summary>
/// Versão do app: a <c>&lt;Version&gt;</c> do <c>apps/pdv/Directory.Build.props</c> (ou a da tag <c>pdv-vX.Y.Z</c>, que o
/// CI passa com <c>-p:Version=</c>), a mesma do nome do instalador, do rodapé do login e do assistente e do
/// <c>versao_app</c> que vai à nuvem.
/// </summary>
public static class VersaoApp
{
    public static string Atual { get; } =
        typeof(VersaoApp).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>
    /// Compara como o <c>compararVersoes</c> da API (<c>apps/api/src/sync/versoes-app.ts</c>): núcleo numérico de 3
    /// partes e a pré-versão (<c>-beta</c>) abaixo da versão final; o <c>+build</c> não conta.
    /// </summary>
    public static int Comparar(string a, string b)
    {
        var (na, pa) = Partes(a);
        var (nb, pb) = Partes(b);
        for (var i = 0; i < 3; i++)
        {
            var d = na[i].CompareTo(nb[i]);
            if (d != 0)
            {
                return d < 0 ? -1 : 1;
            }
        }

        if (pa == pb)
        {
            return 0;
        }

        if (pa is null)
        {
            return 1;
        }

        if (pb is null)
        {
            return -1;
        }

        return string.CompareOrdinal(pa, pb) < 0 ? -1 : 1;
    }

    /// <summary>Esta versão está abaixo da mínima que a nuvem publicou (SYNC 17.3)?</summary>
    public static bool AbaixoDe(string? minima, string? atual = null) =>
        !string.IsNullOrWhiteSpace(minima) && Comparar(atual ?? Atual, minima.Trim()) < 0;

    private static (long[] Nucleo, string? Pre) Partes(string versao)
    {
        // Igual à API: o primeiro pedaço antes de "-" ou "+" é o núcleo; com "-" no texto, o segundo é a pré-versão.
        var pedacos = versao.Trim().Split('-', '+');
        var numeros = pedacos[0].Split('.');
        var nucleo = new long[3];
        for (var i = 0; i < 3 && i < numeros.Length; i++)
        {
            nucleo[i] = long.TryParse(numeros[i], NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : 0;
        }

        var pre = versao.Contains('-', StringComparison.Ordinal) ? (pedacos.Length > 1 ? pedacos[1] : string.Empty) : null;
        return (nucleo, pre);
    }
}
