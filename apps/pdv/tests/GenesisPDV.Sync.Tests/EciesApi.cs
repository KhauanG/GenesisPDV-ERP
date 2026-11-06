using System.Security.Cryptography;
using System.Text;
using GenesisPDV.Sync.Ativacao;

namespace GenesisPDV.Sync.Tests;

/// <summary>
/// Lado da API do envelope ECIES (<c>apps/api/src/seguranca/ecies.ts</c>), só para os testes do PDV montarem respostas
/// de ativação: o PDV de produção só decifra (<see cref="Ecies.Decifrar"/>). Mesmo formato e mesma derivação, escritos
/// de novo aqui (não reaproveita o lado do PDV, então os vetores e os testes de ida e volta conferem os dois).
/// </summary>
public static class EciesApi
{
    private static readonly byte[] Info = Encoding.UTF8.GetBytes("genesis-ecies-v1");

    public static byte[] Cifrar(byte[] publicaSpki, byte[] dados)
    {
        ArgumentNullException.ThrowIfNull(dados);
        var destino = DerX25519.PublicaDeSpki(publicaSpki);
        var efemera = ParX25519.Gerar();
        var spki = efemera.PublicaSpki;
        var chave = HKDF.DeriveKey(HashAlgorithmName.SHA256, efemera.Acordo(destino), 32, spki, Info);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cifra = new byte[dados.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(chave, 16);
        aes.Encrypt(nonce, dados, cifra, tag);
        return [1, (byte)(spki.Length >> 8), (byte)spki.Length, .. spki, .. nonce, .. cifra, .. tag];
    }
}
