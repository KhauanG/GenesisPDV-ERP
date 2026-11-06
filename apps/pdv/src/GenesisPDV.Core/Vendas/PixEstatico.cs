using System.Globalization;
using System.Text;

namespace GenesisPDV.Core.Vendas;

/// <summary>
/// BR Code do PIX estático com valor (PDV 16.7; padrão EMV QRCPS-MPM do Manual de Padrões para Iniciação do Pix do
/// Bacen): gerado no caixa, offline, com a chave, o nome e a cidade do recebedor da loja (<c>lojas.chave_pix</c>,
/// <c>pix_nome_recebedor</c>, <c>pix_cidade_recebedor</c>), o valor e o <c>txid</c> = número da venda. O app do banco do
/// cliente lê o QR; a confirmação continua manual (o PDV não sabe se foi pago).
/// </summary>
public static class PixEstatico
{
    public const int NomeMaximo = 25;
    public const int CidadeMaximo = 15;
    public const int TxidMaximo = 25;

    /// <summary>Monta o "copia e cola" (o mesmo texto vai no QR) e termina com o CRC16 do campo 63.</summary>
    public static string Gerar(string chave, string nomeRecebedor, string cidadeRecebedor, decimal valor, string txid)
    {
        if (string.IsNullOrWhiteSpace(chave))
        {
            throw new Comum.RegraNegocioException("Loja sem chave PIX (ERP › Lojas): use a confirmação manual.");
        }

        if (valor <= 0m)
        {
            throw new Comum.RegraNegocioException("O PIX precisa de um valor maior que zero.");
        }

        var conta = Campo("00", "br.gov.bcb.pix") + Campo("01", chave.Trim());
        var id = Txid(txid);
        var sb = new StringBuilder()
            .Append(Campo("00", "01"))
            .Append(Campo("26", conta))
            .Append(Campo("52", "0000"))
            .Append(Campo("53", "986"))
            .Append(Campo("54", valor.ToString("0.00", CultureInfo.InvariantCulture)))
            .Append(Campo("58", "BR"))
            .Append(Campo("59", Texto(nomeRecebedor, NomeMaximo, "RECEBEDOR")))
            .Append(Campo("60", Texto(cidadeRecebedor, CidadeMaximo, "BRASIL")))
            .Append(Campo("62", Campo("05", id)))
            .Append("6304");
        return sb.Append(Crc16(sb.ToString()).ToString("X4", CultureInfo.InvariantCulture)).ToString();
    }

    /// <summary>
    /// <c>txid</c> do estático: letras e dígitos, até 25 (o número da venda sem os hífens: <c>L01C02000123</c>). A venda
    /// paga com dois PIX repete o <c>txid</c>; a nuvem só exige único no dinâmico (MD 3.11.6).
    /// </summary>
    public static string Txid(string? texto)
    {
        var limpo = string.Concat((texto ?? string.Empty).Where(char.IsAsciiLetterOrDigit));
        return limpo.Length == 0 ? "***" : limpo[..Math.Min(limpo.Length, TxidMaximo)];
    }

    /// <summary>CRC16/CCITT-FALSE (polinômio 0x1021, inicial 0xFFFF), como pede o manual do BR Code.</summary>
    public static ushort Crc16(string texto)
    {
        ArgumentNullException.ThrowIfNull(texto);
        ushort crc = 0xFFFF;
        foreach (var b in Encoding.UTF8.GetBytes(texto))
        {
            crc ^= (ushort)(b << 8);
            for (var i = 0; i < 8; i++)
            {
                crc = (crc & 0x8000) != 0 ? (ushort)((crc << 1) ^ 0x1021) : (ushort)(crc << 1);
            }
        }

        return crc;
    }

    private static string Campo(string id, string valor)
    {
        if (valor.Length > 99)
        {
            throw new Comum.RegraNegocioException("Chave PIX longa demais para o QR estático.");
        }

        return id + valor.Length.ToString("00", CultureInfo.InvariantCulture) + valor;
    }

    /// <summary>Nome e cidade do recebedor: sem acento, maiúsculas, só letras, dígitos e espaço, cortados no limite.</summary>
    private static string Texto(string? texto, int maximo, string padrao)
    {
        var normalizado = (texto ?? string.Empty).Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder();
        foreach (var c in normalizado)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            if (char.IsAsciiLetterOrDigit(c) || c == ' ')
            {
                sb.Append(char.ToUpperInvariant(c));
            }
        }

        var limpo = string.Join(' ', sb.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries));
        return limpo.Length == 0 ? padrao : limpo[..Math.Min(limpo.Length, maximo)].TrimEnd();
    }
}
