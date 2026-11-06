using System.Security.Cryptography;
using System.Text;
using Org.BouncyCastle.Crypto.Agreement;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Security;

namespace GenesisPDV.Sync.Ativacao;

/// <summary>
/// Par X25519 (RFC 7748) em bytes crus de 32. Os mesmos tipos que a API usa (<c>generateKeyPairSync('x25519')</c>): a
/// pública sobe em SPKI DER (<see cref="PublicaSpki"/>), a privada fica só no PDV (protegida, nunca em claro no banco).
/// O .NET não tem X25519 no Linux; a curva vem do BouncyCastle (gerenciado, igual nos dois sistemas).
/// </summary>
public sealed class ParX25519
{
    private ParX25519(byte[] privada, byte[] publica)
    {
        Privada = privada;
        Publica = publica;
    }

    public byte[] Privada { get; }

    public byte[] Publica { get; }

    public byte[] PublicaSpki => DerX25519.Spki(Publica);

    public string PublicaSpkiBase64 => Convert.ToBase64String(PublicaSpki);

    public static ParX25519 Gerar()
    {
        var privada = new X25519PrivateKeyParameters(new SecureRandom());
        return new ParX25519(privada.GetEncoded(), privada.GeneratePublicKey().GetEncoded());
    }

    public static ParX25519 DaPrivada(byte[] privada)
    {
        ArgumentNullException.ThrowIfNull(privada);
        if (privada.Length != X25519PrivateKeyParameters.KeySize)
        {
            throw new CryptographicException("Privada X25519 precisa de 32 bytes.");
        }

        var parametros = new X25519PrivateKeyParameters(privada);
        return new ParX25519([.. privada], parametros.GeneratePublicKey().GetEncoded());
    }

    /// <summary>Segredo compartilhado (32 bytes), como o <c>diffieHellman</c> do Node.</summary>
    public byte[] Acordo(byte[] publicaOutra)
    {
        var acordo = new X25519Agreement();
        acordo.Init(new X25519PrivateKeyParameters(Privada));
        var segredo = new byte[acordo.AgreementSize];
        acordo.CalculateAgreement(new X25519PublicKeyParameters(publicaOutra), segredo, 0);
        return segredo;
    }

    public override string ToString() => $"X25519 {Convert.ToHexStringLower(Publica)[..16]}…";
}

/// <summary>
/// Pares gerados pelo assistente para uma tentativa de ativação (SYNC 3.2): o <b>permanente</b> do terminal (a privada é
/// guardada protegida em <c>configuracao_terminal['terminal.chave_privada']</c>; todo segredo que descer vem cifrado para
/// ele, 20.2) e o <b>efêmero</b> de backup, que só abre a <c>chave_backup_cifrada</c> da resposta e é descartado.
/// </summary>
public sealed record ChavesTerminal(ParX25519 Terminal, ParX25519 Backup)
{
    /// <summary><c>chave_publica_terminal.algoritmo</c>: sem CNG/TPM nesta fase (D21), sempre X25519.</summary>
    public const string Algoritmo = "x25519";

    public static ChavesTerminal Gerar() => new(ParX25519.Gerar(), ParX25519.Gerar());
}

/// <summary>Formatos DER fixos de X25519 (RFC 8410): SPKI de 44 bytes e PKCS#8 de 48, com o OID 1.3.101.110.</summary>
public static class DerX25519
{
    private static readonly byte[] PrefixoSpki = Convert.FromHexString("302a300506032b656e032100");
    private static readonly byte[] PrefixoPkcs8 = Convert.FromHexString("302e020100300506032b656e04220420");

    public static byte[] Spki(byte[] publica) => Montar(PrefixoSpki, publica);

    public static byte[] PublicaDeSpki(byte[] spki) => Extrair(PrefixoSpki, spki, "SPKI");

    public static byte[] PrivadaDePkcs8(byte[] pkcs8) => Extrair(PrefixoPkcs8, pkcs8, "PKCS#8");

    private static byte[] Montar(byte[] prefixo, byte[] chave)
    {
        ArgumentNullException.ThrowIfNull(chave);
        if (chave.Length != 32)
        {
            throw new CryptographicException("Chave X25519 precisa de 32 bytes.");
        }

        return [.. prefixo, .. chave];
    }

    private static byte[] Extrair(byte[] prefixo, byte[] der, string formato)
    {
        ArgumentNullException.ThrowIfNull(der);
        if (der.Length != prefixo.Length + 32 || !der.AsSpan(0, prefixo.Length).SequenceEqual(prefixo))
        {
            throw new CryptographicException($"{formato} não é de uma chave X25519.");
        }

        return der[prefixo.Length..];
    }
}

/// <summary>
/// Envelope ECIES da API (<c>apps/api/src/seguranca/ecies.ts</c>; MD 1.10, SYNC 3.2, 20.2), lado do PDV: X25519 com a
/// chave efêmera do envelope, HKDF-SHA256 (sal = SPKI efêmera, info <c>genesis-ecies-v1</c>) e AES-256-GCM. Formato:
/// <c>versao(1) | tamanho da SPKI (2, big-endian) | SPKI | nonce(12) | cifra | tag(16)</c>. Os vetores gerados pela API
/// (<c>packages/shared/testes/ecies/vetores.json</c>) passam nos dois lados. O PDV só decifra: quem cifra é a API (os
/// testes têm o próprio lado da API, <c>EciesApi</c>).
/// </summary>
public static class Ecies
{
    private const byte Versao = 1;
    private static readonly byte[] Info = Encoding.UTF8.GetBytes("genesis-ecies-v1");

    public static byte[] Decifrar(byte[] envelope, ParX25519 destino)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        ArgumentNullException.ThrowIfNull(destino);
        if (envelope.Length < 3 || envelope[0] != Versao)
        {
            throw new CryptographicException("Versão de envelope ECIES desconhecida.");
        }

        var tamanho = (envelope[1] << 8) | envelope[2];
        if (envelope.Length < 3 + tamanho + 12 + 16)
        {
            throw new CryptographicException("Envelope ECIES truncado.");
        }

        var spki = envelope.AsSpan(3, tamanho).ToArray();
        var nonce = envelope.AsSpan(3 + tamanho, 12);
        var cifra = envelope.AsSpan(15 + tamanho, envelope.Length - 15 - tamanho - 16);
        var tag = envelope.AsSpan(envelope.Length - 16);
        var chave = Derivar(destino.Acordo(DerX25519.PublicaDeSpki(spki)), spki);
        var claro = new byte[cifra.Length];
        using var aes = new AesGcm(chave, 16);
        aes.Decrypt(nonce, cifra, tag, claro);
        return claro;
    }

    private static byte[] Derivar(byte[] segredo, byte[] spkiEfemera) =>
        HKDF.DeriveKey(HashAlgorithmName.SHA256, segredo, 32, spkiEfemera, Info);
}
