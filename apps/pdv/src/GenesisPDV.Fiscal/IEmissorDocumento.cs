using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Fiscal;

/// <summary>Dados de cabeçalho/rodapé do comprovante (vêm de <c>empresa</c>, <c>lojas</c> e da sessão).</summary>
public sealed record CabecalhoDocumento(
    string NomeLoja,
    string RazaoSocial,
    string? Cnpj,
    string? InscricaoEstadual,
    string? Endereco,
    string? Telefone,
    string NomeOperador,
    string? FraseRodape = null,
    string TituloRecibo = "COMPROVANTE DE VENDA",
    string VersaoApp = "0.1.0",
    string FusoHorario = Core.Comum.DiaOperacional.FusoPadrao);

/// <param name="StatusFiscal">Valor para <c>vendas.status_fiscal</c>.</param>
/// <param name="Impressao">Documento pronto para a impressora (ESC/POS), que vai para a <c>fila_impressao</c>.</param>
/// <param name="TipoDocumentoImpressao">Valor de <c>fila_impressao.tipo_documento</c>.</param>
public sealed record DocumentoEmitido(string StatusFiscal, byte[] Impressao, string TipoDocumentoImpressao, string? ChaveAcesso = null);

/// <summary>
/// Emissão do documento de saída da venda finalizada (PDV 18). A venda já está gravada quando o emissor é chamado
/// (PDV 17.1): falha aqui nunca desfaz a venda.
/// </summary>
public interface IEmissorDocumento
{
    /// <summary>Valor de <c>lojas.tipo_emissao</c> atendido: <c>nao_fiscal</c>, <c>nfce</c>, <c>sat</c>, <c>mfe</c>.</summary>
    string TipoEmissao { get; }

    Task<DocumentoEmitido> EmitirAsync(Venda venda, CabecalhoDocumento cabecalho, CancellationToken ct = default);
}

/// <summary>
/// Emissor de documento fiscal (NFC-e na Fase 3F; SAT/MFE sob demanda), pela mesma interface do não fiscal
/// (ADR-11). Acrescenta o cancelamento, que só existe para documento fiscal.
/// </summary>
public interface IEmissorFiscal : IEmissorDocumento
{
    Task CancelarAsync(Venda venda, string justificativa, CancellationToken ct = default);
}
