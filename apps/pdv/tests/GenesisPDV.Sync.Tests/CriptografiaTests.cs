using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using GenesisPDV.Data;
using GenesisPDV.Sync.Ativacao;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Peças criptográficas da ativação (SYNC 3.2, 3.6, 20.2): id de hardware determinístico, X25519 com os formatos DER da
/// API, envelope ECIES com os vetores gerados pela API e os protetores locais (arquivo 0600 + HKDF no Linux, DPAPI no
/// Windows, D21) em ida e volta.
/// </summary>
public class CriptografiaTests
{
    private const string MaquinaTeste = "0123456789abcdef0123456789abcdef";

    [Fact]
    public void IdHardware_e_o_sha256_do_id_da_maquina_normalizado()
    {
        // sha256("abc")
        const string Esperado = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        Assert.Equal(Esperado, IdHardware.De("abc"));
        Assert.Equal(Esperado, IdHardware.De("  ABC\n"));
        Assert.NotEqual(Esperado, IdHardware.De("abd"));
        Assert.Matches("^[0-9a-f]{64}$", IdHardware.De(Guid.NewGuid().ToString()));
    }

    [Fact]
    public void IdHardware_desta_maquina_nao_muda_entre_leituras()
    {
        var pasta = Path.Combine(Path.GetTempPath(), "genesispdv-id", Guid.NewGuid().ToString("N"));
        try
        {
            var primeiro = IdHardware.Atual(pasta);
            Assert.Equal(primeiro, IdHardware.Atual(pasta));
            Assert.Matches("^[0-9a-f]{64}$", primeiro);
            if (IdHardware.LerIdMaquina() is { } bruto)
            {
                Assert.Equal(IdHardware.De(bruto), primeiro);
            }
        }
        finally
        {
            if (Directory.Exists(pasta))
            {
                Directory.Delete(pasta, recursive: true);
            }
        }
    }

    [Fact]
    public void X25519_usa_os_formatos_der_da_api_e_o_acordo_e_simetrico()
    {
        var a = ParX25519.Gerar();
        var b = ParX25519.Gerar();
        Assert.Equal(44, a.PublicaSpki.Length);
        Assert.StartsWith("MCowBQYDK2VuAyEA", a.PublicaSpkiBase64, StringComparison.Ordinal);
        Assert.Equal(a.Publica, DerX25519.PublicaDeSpki(a.PublicaSpki));
        Assert.Equal(a.Acordo(b.Publica), b.Acordo(a.Publica));
        Assert.Equal(a.Publica, ParX25519.DaPrivada(a.Privada).Publica);
        Assert.Throws<CryptographicException>(() => DerX25519.PublicaDeSpki(new byte[44]));
        Assert.DoesNotContain(Convert.ToHexStringLower(a.Privada), a.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Envelopes_gerados_pela_api_abrem_com_a_privada_do_vetor()
    {
        var vetores = JsonNode.Parse(File.ReadAllText(Path.Combine(Fixtures.Pasta("ecies"), "vetores.json")))!["casos"]!.AsArray();
        Assert.NotEmpty(vetores);
        foreach (var caso in vetores)
        {
            var par = ParX25519.DaPrivada(DerX25519.PrivadaDePkcs8(Convert.FromBase64String(caso!["privada_pkcs8"]!.GetValue<string>())));
            Assert.Equal(caso["publica_spki"]!.GetValue<string>(), par.PublicaSpkiBase64);
            var claro = Ecies.Decifrar(Convert.FromBase64String(caso["envelope"]!.GetValue<string>()), par);
            Assert.Equal(Convert.FromBase64String(caso["claro"]!.GetValue<string>()), claro);
        }
    }

    [Fact]
    public void Ecies_so_abre_com_a_privada_certa_e_recusa_envelope_adulterado()
    {
        var destino = ParX25519.Gerar();
        var segredo = RandomNumberGenerator.GetBytes(32);
        var envelope = EciesApi.Cifrar(destino.PublicaSpki, segredo);
        Assert.Equal(segredo, Ecies.Decifrar(envelope, destino));
        Assert.ThrowsAny<CryptographicException>(() => Ecies.Decifrar(envelope, ParX25519.Gerar()));
        envelope[^1] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => Ecies.Decifrar(envelope, destino));
        Assert.ThrowsAny<CryptographicException>(() => Ecies.Decifrar([2, 0, 0], destino));
    }

    [Fact]
    public void Protetor_de_arquivo_faz_ida_e_volta_e_amarra_finalidade_maquina_e_arquivo()
    {
        var raiz = Path.Combine(Path.GetTempPath(), "genesispdv-protetor", Guid.NewGuid().ToString("N"));
        var arquivo = Path.Combine(raiz, "chave", "chave_terminal");
        try
        {
            var protetor = new ProtetorArquivo(arquivo, () => MaquinaTeste);
            var dados = Encoding.UTF8.GetBytes("01a18751-a521-7238-b924-56de3eb13b90.segredo");
            var protegido = protetor.Proteger(dados, "token:x");
            Assert.True(File.Exists(arquivo));
            Assert.Equal(32, new FileInfo(arquivo).Length);
            Assert.Equal(-1, protegido.AsSpan().IndexOf(dados));
            Assert.NotEqual(protegido, protetor.Proteger(dados, "token:x"));
            Assert.Equal(dados, protetor.Desproteger(protegido, "token:x"));

            // Outra instância (reinício do PDV) lê o mesmo arquivo.
            Assert.Equal(dados, new ProtetorArquivo(arquivo, () => MaquinaTeste.ToUpperInvariant()).Desproteger(protegido, "token:x"));
            Assert.ThrowsAny<CryptographicException>(() => protetor.Desproteger(protegido, "backup.chave:x"));
            Assert.ThrowsAny<CryptographicException>(() => new ProtetorArquivo(arquivo, () => "outra-maquina").Desproteger(protegido, "token:x"));
            var adulterado = protegido.ToArray();
            adulterado[20] ^= 1;
            Assert.ThrowsAny<CryptographicException>(() => protetor.Desproteger(adulterado, "token:x"));
            Assert.ThrowsAny<CryptographicException>(() => protetor.Desproteger([1, .. protegido[1..]], "token:x"));

            // Sem o arquivo, ler é erro e não cria chave nova (que não abriria nada).
            var semArquivo = Path.Combine(raiz, "outra", "chave_terminal");
            Assert.ThrowsAny<CryptographicException>(() => new ProtetorArquivo(semArquivo, () => MaquinaTeste).Desproteger(protegido, "token:x"));
            Assert.False(File.Exists(semArquivo));
        }
        finally
        {
            Directory.Delete(raiz, recursive: true);
        }
    }

    [Fact]
    public void Protetor_de_arquivo_cria_a_chave_0600_e_corrige_permissao_aberta()
    {
        if (OperatingSystem.IsWindows())
        {
            Assert.Skip("Permissões Unix: no Windows o token usa a DPAPI (D21).");
        }

        var raiz = Path.Combine(Path.GetTempPath(), "genesispdv-protetor", Guid.NewGuid().ToString("N"));
        var arquivo = Path.Combine(raiz, "chave", "chave_terminal");
        try
        {
            var protetor = new ProtetorArquivo(arquivo, () => MaquinaTeste);
            var protegido = protetor.Proteger([1, 2, 3], "f");
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(arquivo));
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(Path.GetDirectoryName(arquivo)!));
                File.SetUnixFileMode(arquivo, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
                Assert.Equal([1, 2, 3], new ProtetorArquivo(arquivo, () => MaquinaTeste).Desproteger(protegido, "f"));
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(arquivo));
            }
        }
        finally
        {
            Directory.Delete(raiz, recursive: true);
        }
    }

    [Fact]
    public void Protetor_dpapi_do_usuario_faz_ida_e_volta_no_windows()
    {
        if (OperatingSystem.IsWindows())
        {
            IdaEVoltaDpapi();
        }
        else
        {
            Assert.IsType<ProtetorArquivo>(ProtetorSegredos.ParaEsteSistema(CaminhosPdv.SobRaiz(Path.GetTempPath())));
            Assert.Skip("DPAPI só existe no Windows (o CI roda este teste no windows-latest).");
        }
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void IdaEVoltaDpapi()
    {
        var protetor = new ProtetorDpapi();
        var dados = Encoding.UTF8.GetBytes("token-de-teste");
        var protegido = protetor.Proteger(dados, "token:x");
        Assert.Equal(1, protegido[0]);
        Assert.Equal(dados, protetor.Desproteger(protegido, "token:x"));
        Assert.ThrowsAny<CryptographicException>(() => protetor.Desproteger(protegido, "token:y"));
        Assert.ThrowsAny<CryptographicException>(() => protetor.Desproteger([2, .. protegido[1..]], "token:x"));
        Assert.IsType<ProtetorDpapi>(ProtetorSegredos.ParaEsteSistema(CaminhosPdv.SobRaiz(Path.GetTempPath())));
    }

    [Fact]
    public void Chave_local_fica_fora_da_pasta_de_dados()
    {
        var caminhos = CaminhosPdv.SobRaiz(Path.Combine(Path.GetTempPath(), "raiz"));
        Assert.Equal(Path.Combine(Path.GetTempPath(), "raiz", "chave", "chave_terminal"), caminhos.ArquivoChaveTerminal);
        Assert.False(caminhos.ArquivoChaveTerminal.StartsWith(caminhos.PastaDados, StringComparison.Ordinal));
    }
}
