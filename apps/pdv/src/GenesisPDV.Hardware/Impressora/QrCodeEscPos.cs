using QRCoder;

namespace GenesisPDV.Hardware.Impressora;

/// <summary>
/// QR Code na impressora térmica (PDV 6.2, 19.1; implantação I4): o comando nativo <c>GS ( k</c> (modelo 2, correção M)
/// das Epson TM-T20/TM-T88 ou, nos modelos sem ele (a Bematech MP-4200 TH em modo ESC/POS só tem o PDF417 no
/// <c>GS ( k</c>; a "Genérica"), a imagem <c>GS v 0</c> gerada pelo QRCoder com a mesma correção.
/// </summary>
public static class QrCodeEscPos
{
    /// <summary>Código de símbolo do QR no <c>GS ( k</c> (<c>cn = 49</c>; o 48 é o PDF417).</summary>
    public const byte SimboloQr = 49;

    /// <summary>Linhas por bloco <c>GS v 0</c>: imagens grandes num comando só estouram o buffer de modelos simples.</summary>
    public const int LinhasPorBloco = 128;

    /// <summary>
    /// Sequência nativa: modelo 2 (fn 65), tamanho do módulo em pontos (fn 67, 1–16), correção M (fn 69, 49), dados
    /// (fn 80) e impressão (fn 81).
    /// </summary>
    public static byte[] Nativo(byte[] dados, int modulo)
    {
        ArgumentNullException.ThrowIfNull(dados);
        var tamanho = dados.Length + 3;
        if (tamanho > ushort.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(dados), "Conteúdo grande demais para o QR Code.");
        }

        return
        [
            EscPos.Gs, (byte)'(', (byte)'k', 4, 0, SimboloQr, 65, 50, 0,
            EscPos.Gs, (byte)'(', (byte)'k', 3, 0, SimboloQr, 67, (byte)Math.Clamp(modulo, 1, 16),
            EscPos.Gs, (byte)'(', (byte)'k', 3, 0, SimboloQr, 69, 49,
            EscPos.Gs, (byte)'(', (byte)'k', (byte)(tamanho & 0xFF), (byte)(tamanho >> 8), SimboloQr, 80, 48, .. dados,
            EscPos.Gs, (byte)'(', (byte)'k', 3, 0, SimboloQr, 81, 48,
        ];
    }

    /// <summary>
    /// O QR como imagem (<c>GS v 0</c>, modo normal), com a zona de silêncio de 4 módulos, em blocos de
    /// <see cref="LinhasPorBloco"/> linhas. O módulo é o maior que cabe em <paramref name="larguraMaximaPontos"/> (2 a 8
    /// pontos).
    /// </summary>
    public static byte[] Imagem(byte[] dados, int larguraMaximaPontos)
    {
        ArgumentNullException.ThrowIfNull(dados);
        using var gerador = new QRCodeGenerator();
        using var qr = gerador.CreateQrCode(System.Text.Encoding.UTF8.GetString(dados), QRCodeGenerator.ECCLevel.M);
        var matriz = qr.ModuleMatrix;
        var modulos = matriz.Count;
        var modulo = Math.Clamp(larguraMaximaPontos / modulos, 2, 8);
        var largura = modulos * modulo;
        var bytesPorLinha = (largura + 7) / 8;
        var saida = new List<byte>();
        for (var inicio = 0; inicio < largura; inicio += LinhasPorBloco)
        {
            var linhas = Math.Min(LinhasPorBloco, largura - inicio);
            saida.AddRange([EscPos.Gs, (byte)'v', (byte)'0', 0,
                (byte)(bytesPorLinha & 0xFF), (byte)(bytesPorLinha >> 8), (byte)(linhas & 0xFF), (byte)(linhas >> 8)]);
            for (var y = inicio; y < inicio + linhas; y++)
            {
                var linhaMatriz = matriz[y / modulo];
                var linha = new byte[bytesPorLinha];
                for (var x = 0; x < largura; x++)
                {
                    if (linhaMatriz[x / modulo])
                    {
                        linha[x / 8] |= (byte)(0x80 >> (x % 8));
                    }
                }

                saida.AddRange(linha);
            }
        }

        return [.. saida];
    }
}
