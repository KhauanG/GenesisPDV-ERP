using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace GenesisPDV.Spike;

/// <summary>
/// Conferência de uma assinatura do <c>ssh-keygen -Y sign</c> (formato SSHSIG do OpenSSH, PROTOCOL.sshsig) com chave
/// Ed25519. O dono assina no PC dele com o OpenSSH que já vem no Windows 10/11, sem instalar nada (README do PDV ›
/// decisão 100); o caixa confere com a chave pública embutida no build. Só Ed25519: qualquer outro tipo é recusado.
/// </summary>
public static class AssinaturaSsh
{
    /// <summary>O "namespace" do SSHSIG: uma assinatura feita para outra coisa (um commit do git, um arquivo qualquer) não serve aqui.</summary>
    public const string Contexto = "genesispdv-atualizacao";

    private const string TipoChave = "ssh-ed25519";
    private static readonly byte[] Magica = "SSHSIG"u8.ToArray();

    /// <summary>Lança <see cref="AssinaturaInvalidaException"/> se a assinatura não for da chave, deste contexto e desta mensagem.</summary>
    public static void Conferir(byte[] mensagem, string assinaturaArmada, string linhaChavePublica)
    {
        var chaveEsperada = LerLinhaChavePublica(linhaChavePublica);
        var blob = Desarmar(assinaturaArmada);

        var leitor = new LeitorSsh(blob);
        if (!leitor.Bytes(Magica.Length).AsSpan().SequenceEqual(Magica))
            throw new AssinaturaInvalidaException("não é uma assinatura SSHSIG");
        if (leitor.UInt32() != 1)
            throw new AssinaturaInvalidaException("versão do SSHSIG desconhecida");
        var chaveBlob = leitor.Texto();
        var contexto = Encoding.UTF8.GetString(leitor.Texto());
        var reservado = leitor.Texto();
        var algoritmo = Encoding.UTF8.GetString(leitor.Texto());
        var assinaturaBlob = leitor.Texto();
        leitor.ConferirFim();

        if (!CryptographicOperations.FixedTimeEquals(chaveBlob, chaveEsperada.Blob))
            throw new AssinaturaInvalidaException("assinada por outra chave");
        if (contexto != Contexto)
            throw new AssinaturaInvalidaException($"contexto '{contexto}' em vez de '{Contexto}'");

        byte[] resumo = algoritmo switch
        {
            "sha512" => SHA512.HashData(mensagem),
            "sha256" => SHA256.HashData(mensagem),
            _ => throw new AssinaturaInvalidaException($"resumo '{algoritmo}' não aceito"),
        };

        var leitorAssinatura = new LeitorSsh(assinaturaBlob);
        if (Encoding.UTF8.GetString(leitorAssinatura.Texto()) != TipoChave)
            throw new AssinaturaInvalidaException("assinatura que não é Ed25519");
        var assinatura = leitorAssinatura.Texto();
        leitorAssinatura.ConferirFim();
        if (assinatura.Length != 64)
            throw new AssinaturaInvalidaException("assinatura Ed25519 com tamanho errado");

        // O que o ssh-keygen assina: MAGIC || string(contexto) || string(reservado) || string(algoritmo) || string(H(mensagem)).
        using var assinado = new MemoryStream();
        assinado.Write(Magica);
        EscreverTexto(assinado, Encoding.UTF8.GetBytes(contexto));
        EscreverTexto(assinado, reservado);
        EscreverTexto(assinado, Encoding.UTF8.GetBytes(algoritmo));
        EscreverTexto(assinado, resumo);
        var dados = assinado.ToArray();

        var verificador = new Ed25519Signer();
        verificador.Init(false, new Ed25519PublicKeyParameters(chaveEsperada.Chave, 0));
        verificador.BlockUpdate(dados, 0, dados.Length);
        if (!verificador.VerifySignature(assinatura))
            throw new AssinaturaInvalidaException("a assinatura não confere com o manifesto");
    }

    /// <summary>A linha do <c>.pub</c> ("ssh-ed25519 AAAA… comentário"): o blob da chave e os 32 bytes dela.</summary>
    public static (byte[] Blob, byte[] Chave) LerLinhaChavePublica(string linha)
    {
        var partes = linha.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (partes.Length < 2 || partes[0] != TipoChave)
            throw new AssinaturaInvalidaException("chave pública embutida ausente ou que não é ssh-ed25519");
        var blob = Convert.FromBase64String(partes[1]);
        var leitor = new LeitorSsh(blob);
        if (Encoding.UTF8.GetString(leitor.Texto()) != TipoChave)
            throw new AssinaturaInvalidaException("chave pública embutida inválida");
        var chave = leitor.Texto();
        leitor.ConferirFim();
        if (chave.Length != 32)
            throw new AssinaturaInvalidaException("chave Ed25519 com tamanho errado");
        return (blob, chave);
    }

    private static byte[] Desarmar(string armada)
    {
        const string inicio = "-----BEGIN SSH SIGNATURE-----";
        const string fim = "-----END SSH SIGNATURE-----";
        var texto = armada.Replace("\r", "", StringComparison.Ordinal);
        var a = texto.IndexOf(inicio, StringComparison.Ordinal);
        var b = texto.IndexOf(fim, StringComparison.Ordinal);
        if (a < 0 || b < a)
            throw new AssinaturaInvalidaException("arquivo de assinatura sem o cabeçalho do ssh-keygen");
        var base64 = string.Concat(texto[(a + inicio.Length)..b].Split('\n', StringSplitOptions.TrimEntries));
        try
        {
            return Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            throw new AssinaturaInvalidaException("assinatura com base64 inválido");
        }
    }

    private static void EscreverTexto(Stream destino, byte[] valor)
    {
        Span<byte> tamanho = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(tamanho, (uint)valor.Length);
        destino.Write(tamanho);
        destino.Write(valor);
    }

    private sealed class LeitorSsh(byte[] dados)
    {
        private int _posicao;

        public byte[] Bytes(int quantidade)
        {
            if (quantidade < 0 || _posicao + quantidade > dados.Length)
                throw new AssinaturaInvalidaException("assinatura truncada");
            var parte = dados.AsSpan(_posicao, quantidade).ToArray();
            _posicao += quantidade;
            return parte;
        }

        public uint UInt32() => BinaryPrimitives.ReadUInt32BigEndian(Bytes(4));

        public byte[] Texto()
        {
            var tamanho = UInt32();
            if (tamanho > 1_000_000)
                throw new AssinaturaInvalidaException("campo grande demais na assinatura");
            return Bytes((int)tamanho);
        }

        public void ConferirFim()
        {
            if (_posicao != dados.Length)
                throw new AssinaturaInvalidaException("bytes sobrando na assinatura");
        }
    }
}

public sealed class AssinaturaInvalidaException(string motivo) : Exception($"Assinatura recusada: {motivo}.");
