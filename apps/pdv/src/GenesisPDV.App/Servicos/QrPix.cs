using Avalonia.Media.Imaging;
using QRCoder;

namespace GenesisPDV.App.Servicos;

/// <summary>
/// Imagem do QR do PIX estático na tela de pagamento (PDV 16.7; Fase 1C, C11a): o BR Code vira um PNG em memória
/// (QRCoder, sem System.Drawing), com correção de erro M, como os apps de banco esperam.
/// </summary>
public static class QrPix
{
    public static Bitmap Imagem(string payload, int pixelsPorModulo = 8)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(payload);
        using var gerador = new QRCodeGenerator();
        using var dados = gerador.CreateQrCode(payload, QRCodeGenerator.ECCLevel.M);
        var png = new PngByteQRCode(dados).GetGraphic(pixelsPorModulo);
        using var fluxo = new MemoryStream(png);
        return new Bitmap(fluxo);
    }
}
