using GenesisPDV.Core.Produtos;

namespace GenesisPDV.Core.Vendas;

/// <summary>
/// Snapshot do produto capturado na <b>primeira inclusão</b> na venda (PDV 11.3: preço base, loja, atacado, faixas,
/// grupo e embalagens usados nos recálculos são os desse momento; um pull no meio da venda não muda os itens já
/// incluídos, 11.3.1). A vigência da promoção também é fixada nesse instante. Gravado na tabela local
/// <c>produtos_venda_snapshot</c> no mesmo commit da venda, para a recuperação após queda (PDV 32.3).
/// </summary>
public sealed record ProdutoRegistrado(ProdutoVenda Produto, bool PromocaoVigente);
