using System.Globalization;
using System.Text.RegularExpressions;
using Sodium;

namespace GenesisPDV.Sync.Acesso;

/// <summary>Resultado da verificação local de uma senha (PIN do PDV, senha da forma, senha do cliente).</summary>
public enum ResultadoVerificacao
{
    Confere,
    NaoConfere,

    /// <summary>Hash fora dos limites da SYNC 4.2 (ou malformado): tratado como inválido, sem travar o caixa.</summary>
    ForaDosLimites,
}

/// <summary>
/// argon2id no formato PHC <c>$argon2id$v=19$m=…,t=…,p=…$&lt;sal&gt;$&lt;hash&gt;</c> (SYNC 4.2), verificado pelo
/// libsodium (<c>crypto_pwhash_str_verify</c>, comparação em tempo constante), o mesmo formato do node-argon2 da API
/// (vetores em <c>packages/shared/testes/sync/argon2.vetores.json</c>). Antes do libsodium, os limites aceitos pelo PDV:
/// só <c>argon2id</c> <c>v=19</c>, <c>19456 ≤ m ≤ 262144</c> KiB, <c>1 ≤ t ≤ 10</c>, <c>1 ≤ p ≤ 4</c>, sal ≥ 16 bytes e
/// hash de 32 — protege o caixa de parâmetros absurdos vindos de dado corrompido. O node-argon2 escreve
/// <c>m=,p=,t=</c> e o libsodium só lê a ordem canônica <c>m=,t=,p=</c>: a string é remontada nessa ordem. Uma
/// verificação por vez no processo (cada uma aloca até 256 MiB).
/// </summary>
public static partial class VerificadorArgon2
{
    public const int MemoriaMinimaKib = 19_456;
    public const int MemoriaMaximaKib = 262_144;
    public const int TempoMaximo = 10;
    public const int ParalelismoMaximo = 4;

    private static readonly SemaphoreSlim Uma = new(1, 1);

    public static async Task<ResultadoVerificacao> VerificarAsync(string? hash, string senha, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(senha);
        if (Canonico(hash) is not { } canonico)
        {
            return ResultadoVerificacao.ForaDosLimites;
        }

        await Uma.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // ~100–500 ms com m = 64 MiB: fora da thread da tela.
            return await Task.Run(() => PasswordHash.ArgonHashStringVerify(canonico, senha), ct).ConfigureAwait(false)
                ? ResultadoVerificacao.Confere
                : ResultadoVerificacao.NaoConfere;
        }
        finally
        {
            Uma.Release();
        }
    }

    /// <summary>String PHC na ordem canônica, ou nulo se o hash estiver fora dos limites ou malformado.</summary>
    public static string? Canonico(string? hash)
    {
        if (hash is null || PadraoPhc().Match(hash) is not { Success: true } m)
        {
            return null;
        }

        var parametros = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var par in m.Groups["parametros"].Value.Split(','))
        {
            var partes = par.Split('=');
            if (partes.Length != 2 || !int.TryParse(partes[1], NumberStyles.None, CultureInfo.InvariantCulture, out var valor)
                || !parametros.TryAdd(partes[0], valor))
            {
                return null;
            }
        }

        if (parametros.Count != 3
            || !parametros.TryGetValue("m", out var memoria) || memoria is < MemoriaMinimaKib or > MemoriaMaximaKib
            || !parametros.TryGetValue("t", out var tempo) || tempo is < 1 or > TempoMaximo
            || !parametros.TryGetValue("p", out var paralelismo) || paralelismo is < 1 or > ParalelismoMaximo)
        {
            return null;
        }

        var sal = m.Groups["sal"].Value;
        var saida = m.Groups["hash"].Value;
        if (BytesBase64(sal) < 16 || BytesBase64(saida) != 32)
        {
            return null;
        }

        return string.Create(CultureInfo.InvariantCulture, $"$argon2id$v=19$m={memoria},t={tempo},p={paralelismo}${sal}${saida}");
    }

    /// <summary>Bytes do base64 sem preenchimento do PHC (4 caracteres = 3 bytes).</summary>
    private static int BytesBase64(string texto) => texto.Length * 3 / 4;

    [GeneratedRegex(@"^\$argon2id\$v=19\$(?<parametros>[a-z=0-9,]{5,40})\$(?<sal>[A-Za-z0-9+/]{11,88})\$(?<hash>[A-Za-z0-9+/]{11,88})$", RegexOptions.CultureInvariant)]
    private static partial Regex PadraoPhc();
}
