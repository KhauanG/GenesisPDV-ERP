namespace GenesisPDV.Sync.Ativacao;

/// <summary>
/// Validação local dos campos do assistente de ativação (PDV 5.2, 5.3): código da empresa com 6 dígitos, código de
/// ativação de 8 caracteres do alfabeto sem <c>0 O 1 I L</c> agrupado <c>XXXX-XXXX</c>, URL HTTPS da API.
/// </summary>
public static class FormatoAtivacao
{
    public const string Alfabeto = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

    public static string? ValidarCodigoEmpresa(string? codigo)
    {
        var c = (codigo ?? string.Empty).Trim();
        return c.Length == 6 && c.All(char.IsAsciiDigit) ? null : "O código da empresa tem 6 dígitos (ex.: 100001).";
    }

    /// <summary>Maiúsculas automáticas e hífen depois do 4º caractere (como o operador vê no ERP).</summary>
    public static string NormalizarCodigoAtivacao(string? codigo)
    {
        var limpo = new string((codigo ?? string.Empty).ToUpperInvariant().Where(c => c != '-' && !char.IsWhiteSpace(c)).ToArray());
        return limpo.Length > 4 ? $"{limpo[..4]}-{limpo[4..]}" : limpo;
    }

    public static string? ValidarCodigoAtivacao(string? codigo)
    {
        var normalizado = NormalizarCodigoAtivacao(codigo);
        var semHifen = normalizado.Replace("-", string.Empty, StringComparison.Ordinal);
        if (semHifen.Length != 8)
        {
            return "O código de ativação tem 8 caracteres no formato XXXX-XXXX.";
        }

        var invalidos = semHifen.Where(c => !Alfabeto.Contains(c, StringComparison.Ordinal)).Distinct().ToArray();
        return invalidos.Length == 0
            ? null
            : $"Caractere inválido no código de ativação: {string.Join(", ", invalidos)} (o código não usa 0, O, 1, I nem L).";
    }

    public static string? ValidarUrlServidor(string? url)
    {
        if (!Uri.TryCreate((url ?? string.Empty).Trim(), UriKind.Absolute, out var uri))
        {
            return "Informe o endereço do servidor, por exemplo https://api.genesispdv.com.br.";
        }

        if (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback))
        {
            return "O servidor precisa usar HTTPS (http só é aceito para localhost em desenvolvimento).";
        }

        return null;
    }

    /// <summary>
    /// Endereço da API como base das rotas <c>sync/*</c>: sem consulta nem fragmento e com <c>/</c> no fim do caminho
    /// (sem a barra, <c>new Uri(base, "sync/ativar")</c> trocaria o último segmento de um caminho como <c>/genesis</c>).
    /// </summary>
    public static Uri NormalizarUrl(Uri url)
    {
        ArgumentNullException.ThrowIfNull(url);
        var construtor = new UriBuilder(url) { Query = string.Empty, Fragment = string.Empty };
        if (!construtor.Path.EndsWith('/'))
        {
            construtor.Path += "/";
        }

        return construtor.Uri;
    }
}
