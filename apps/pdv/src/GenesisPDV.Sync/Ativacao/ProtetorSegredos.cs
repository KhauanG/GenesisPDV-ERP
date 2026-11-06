using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using GenesisPDV.Data;

namespace GenesisPDV.Sync.Ativacao;

/// <summary>
/// Proteção local dos segredos do terminal (SYNC 3.6): <c>identidade_terminal.token_protegido</c>,
/// <c>token.pendente</c>, <c>backup.chave</c> e a privada do terminal. A finalidade de cada valor
/// (ex.: <c>token:&lt;terminal_id&gt;</c>) entra como entropia/AAD: um valor protegido não abre no lugar de outro.
/// O primeiro byte diz o esquema, então um banco copiado de um sistema para outro falha ao decifrar (pede reativação)
/// em vez de devolver lixo.
/// </summary>
public interface IProtetorSegredos
{
    /// <summary>Nome do esquema para log e diagnóstico (nunca o segredo).</summary>
    string Esquema { get; }

    byte[] Proteger(ReadOnlySpan<byte> dados, string finalidade);

    /// <exception cref="CryptographicException">Valor adulterado, de outra finalidade, de outro esquema ou chave ausente.</exception>
    byte[] Desproteger(ReadOnlySpan<byte> protegido, string finalidade);
}

public static class ProtetorSegredos
{
    internal const byte EsquemaDpapi = 1;
    internal const byte EsquemaArquivo = 2;

    /// <summary>
    /// D21 (decisão do dono, 30/10/2026): os caixas da Ice Beer são Windows, então a prioridade é a DPAPI
    /// (<see cref="ProtetorDpapi"/>); no Linux, AES-256-GCM com a chave local em arquivo <c>0600</c> + HKDF
    /// (<see cref="ProtetorArquivo"/>).
    /// </summary>
    public static IProtetorSegredos ParaEsteSistema(CaminhosPdv caminhos)
    {
        ArgumentNullException.ThrowIfNull(caminhos);
        return OperatingSystem.IsWindows()
            ? new ProtetorDpapi()
            : new ProtetorArquivo(caminhos.ArquivoChaveTerminal, () => IdHardware.LerIdMaquina() ?? string.Empty);
    }

    /// <summary>Finalidades usadas pelo PDV, todas amarradas ao terminal.</summary>
    public static string FinalidadeToken(Guid terminalId) => $"token:{terminalId:D}";

    public static string FinalidadeBackup(Guid terminalId) => $"backup.chave:{terminalId:D}";

    public static string FinalidadeChaveTerminal(Guid terminalId) => $"terminal.chave_privada:{terminalId:D}";

    internal static byte[] Entropia(string finalidade) => Encoding.UTF8.GetBytes("genesispdv:" + finalidade);
}

/// <summary>
/// Windows: DPAPI no escopo <b>CurrentUser</b> (D21) — a chave mestra é da conta do Windows que roda o PDV, protegida
/// pela senha/credencial dela; outro usuário da máquina ou outra máquina não decifra. <b>Não</b> se usa o escopo
/// <c>LocalMachine</c>, que qualquer processo local decifra (SYNC 3.6). A chave CNG não exportável com TPM da SYNC 3.6
/// fica para depois do piloto (README do PDV › decisões).
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ProtetorDpapi : IProtetorSegredos
{
    public string Esquema => "dpapi-usuario";

    public byte[] Proteger(ReadOnlySpan<byte> dados, string finalidade)
    {
        var blob = ProtectedData.Protect(dados.ToArray(), ProtetorSegredos.Entropia(finalidade), DataProtectionScope.CurrentUser);
        return [ProtetorSegredos.EsquemaDpapi, .. blob];
    }

    public byte[] Desproteger(ReadOnlySpan<byte> protegido, string finalidade)
    {
        if (protegido.Length < 2 || protegido[0] != ProtetorSegredos.EsquemaDpapi)
        {
            throw new CryptographicException("Segredo protegido por outro esquema (banco copiado de outra máquina?). Reative o terminal.");
        }

        return ProtectedData.Unprotect(protegido[1..].ToArray(), ProtetorSegredos.Entropia(finalidade), DataProtectionScope.CurrentUser);
    }
}

/// <summary>
/// Linux (e testes): AES-256-GCM com chave derivada por HKDF-SHA256 de 32 bytes aleatórios num arquivo <c>0600</c>
/// (<see cref="CaminhosPdv.ArquivoChaveTerminal"/>) com o <c>/etc/machine-id</c> como sal (SYNC 3.6): o arquivo copiado
/// para outra máquina não abre os segredos. Formato: <c>esquema(1) | nonce(12) | cifra | tag(16)</c>, AAD = finalidade.
/// O arquivo é criado na primeira proteção (a ativação); na leitura, ausente é erro (nunca gera chave nova que não
/// abriria nada). libsecret fica de fora (D21: sem paridade fina no Linux).
/// </summary>
public sealed class ProtetorArquivo(string arquivoChave, Func<string> idMaquina) : IProtetorSegredos
{
    private static readonly byte[] Info = Encoding.UTF8.GetBytes("genesispdv-segredos-v1");
    private readonly Lock _trava = new();
    private byte[]? _chave;

    public string Esquema => "arquivo-hkdf";

    public string ArquivoChave { get; } = arquivoChave;

    public byte[] Proteger(ReadOnlySpan<byte> dados, string finalidade)
    {
        var chave = Chave(criar: true);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cifra = new byte[dados.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(chave, 16);
        aes.Encrypt(nonce, dados, cifra, tag, ProtetorSegredos.Entropia(finalidade));
        return [ProtetorSegredos.EsquemaArquivo, .. nonce, .. cifra, .. tag];
    }

    public byte[] Desproteger(ReadOnlySpan<byte> protegido, string finalidade)
    {
        if (protegido.Length < 1 + 12 + 16 || protegido[0] != ProtetorSegredos.EsquemaArquivo)
        {
            throw new CryptographicException("Segredo protegido por outro esquema (banco copiado de outra máquina?). Reative o terminal.");
        }

        var chave = Chave(criar: false);
        var cifra = protegido[13..^16];
        var claro = new byte[cifra.Length];
        using var aes = new AesGcm(chave, 16);
        aes.Decrypt(protegido.Slice(1, 12), cifra, protegido[^16..], claro, ProtetorSegredos.Entropia(finalidade));
        return claro;
    }

    private byte[] Chave(bool criar)
    {
        lock (_trava)
        {
            if (_chave is not null)
            {
                return _chave;
            }

            if (!File.Exists(ArquivoChave))
            {
                if (!criar)
                {
                    throw new CryptographicException($"Chave local do terminal ausente ({ArquivoChave}). Reative o terminal.");
                }

                CriarArquivo();
            }

            GarantirPermissao();
            var semente = File.ReadAllBytes(ArquivoChave);
            if (semente.Length != 32)
            {
                throw new CryptographicException($"Chave local do terminal inválida ({ArquivoChave}).");
            }

            var sal = Encoding.UTF8.GetBytes(idMaquina().Trim().ToLowerInvariant());
            _chave = HKDF.DeriveKey(HashAlgorithmName.SHA256, semente, 32, sal, Info);
            CryptographicOperations.ZeroMemory(semente);
            return _chave;
        }
    }

    private void CriarArquivo()
    {
        var pasta = Path.GetDirectoryName(ArquivoChave)!;
        var opcoes = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(pasta);
        }
        else
        {
            Directory.CreateDirectory(pasta, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            opcoes.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        var semente = RandomNumberGenerator.GetBytes(32);
        try
        {
            using var arquivo = new FileStream(ArquivoChave, opcoes);
            arquivo.Write(semente);
            arquivo.Flush(flushToDisk: true);
        }
        catch (IOException) when (File.Exists(ArquivoChave))
        {
            // Outro processo criou ao mesmo tempo: vale o dele.
        }
        finally
        {
            CryptographicOperations.ZeroMemory(semente);
        }
    }

    /// <summary>Arquivo legível pelo grupo ou por outros volta a <c>0600</c> (cópia manual, <c>umask</c> errada).</summary>
    private void GarantirPermissao()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        const UnixFileMode SoDono = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        if ((File.GetUnixFileMode(ArquivoChave) & ~SoDono) != 0)
        {
            File.SetUnixFileMode(ArquivoChave, SoDono);
        }
    }
}
