using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Fiscal;

/// <summary>
/// Tipo de emissão "Não fiscal" (PDV 18.1): só o comprovante de venda, <c>status_fiscal = nao_aplicavel</c>. As colunas
/// são lidas a cada venda (o papel da impressora configurada, I4).
/// </summary>
public sealed class EmissorNaoFiscal(Func<int> colunas) : IEmissorDocumento
{
    public EmissorNaoFiscal(int colunas = 48)
        : this(() => colunas)
    {
    }

    public string TipoEmissao => "nao_fiscal";

    public Task<DocumentoEmitido> EmitirAsync(Venda venda, CabecalhoDocumento cabecalho, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(venda);
        if (venda.Status != StatusVenda.Finalizada)
        {
            throw new InvalidOperationException("O comprovante só é emitido para venda finalizada.");
        }

        var bytes = LayoutComprovanteVenda.Gerar(venda, cabecalho, colunas());
        return Task.FromResult(new DocumentoEmitido(StatusFiscal.NaoAplicavel, bytes, "cupom"));
    }
}
