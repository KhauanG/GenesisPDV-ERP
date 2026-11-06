namespace GenesisPDV.Core.Vendas;

/// <summary>Valores de <c>vendas.status</c> (modelo 3.11.2, máquina de estados PDV 34.1).</summary>
public static class StatusVenda
{
    public const string EmAndamento = "em_andamento";
    public const string EmPagamento = "em_pagamento";
    public const string Suspensa = "suspensa";
    public const string PedidoPendente = "pedido_pendente";
    public const string Finalizada = "finalizada";
    public const string Cancelada = "cancelada";

    public static bool Aberta(string status) => status is EmAndamento or EmPagamento;
}

/// <summary>
/// Ações de <c>liberacoes</c> do payload da venda (sincronizacao.md 9.7; <c>ACOES_LIBERACAO_VENDA</c> do contrato): uma por
/// ação que exige supervisor. As demais (preço manual, limite de valor, PIX manual) entram com o diálogo de cada uma, e
/// cada constante nova entra também em <c>eventos.conferencias.json</c> (o <c>ContratosEventosTests</c> compara as listas).
/// </summary>
public static class AcaoLiberacao
{
    public const string DescontoItem = "desconto_item";
    public const string DescontoTotal = "desconto_total";

    /// <summary>Confirmação manual do PIX liberada pelo supervisor (PDV 16.7; O9b, <c>pdv.pix_manual_exige_supervisor</c>).</summary>
    public const string PixManual = "pix_manual";

    /// <summary>Forma com "exige supervisor" ou senha de liberação (16.2; C8b), lançada com a liberação.</summary>
    public const string FormaPagamento = "forma_pagamento";

    /// <summary>
    /// Desconto pelos cascos (F11 › V, C11c) liberado pelo supervisor: operador sem <c>pdv.venda.desconto_total</c> ou
    /// crédito acima de <c>pdv.desconto_cascos_max_sem_supervisor</c> (README › decisão 56). Item e % nulos.
    /// </summary>
    public const string DescontoCascos = "desconto_cascos";
}

/// <summary>Valores de <c>pagamentos_venda.status</c>.</summary>
public static class StatusPagamento
{
    public const string Pendente = "pendente";
    public const string Aprovado = "aprovado";
    public const string Cancelado = "cancelado";
    public const string Estornado = "estornado";
}

/// <summary>Valores de <c>itens_venda.origem_preco</c> (modelo 3.11.3, <c>ck_itens_venda_origem_preco</c>).</summary>
public static class OrigemPreco
{
    public const string Varejo = "varejo";
    public const string Loja = "loja";
    public const string Promocional = "promocional";
    public const string Atacado = "atacado";
    public const string Quantidade = "quantidade";
    public const string GrupoMix = "grupo_mix";
    public const string Parcelado = "parcelado";
    public const string Manual = "manual";
    public const string Balanca = "balanca";
    public const string Orcamento = "orcamento";
    public const string KitRateio = "kit_rateio";
    public const string Embalagem = "embalagem";

    public static readonly IReadOnlyList<string> Todas =
        [Varejo, Loja, Promocional, Atacado, Quantidade, GrupoMix, Parcelado, Manual, Balanca, Orcamento, KitRateio, Embalagem];

    /// <summary>Origens que a regra 11.3 recalcula quando a quantidade de referência muda (PDV 11.2, 11.3.1).</summary>
    public static bool Recalculavel(string origem) => origem is not (Manual or Balanca or Orcamento or KitRateio or Parcelado);

    /// <summary>Origens em que a quantidade (do produto ou do grupo) definiu o preço: grava <c>quantidade_referencia_preco</c>.</summary>
    public static bool PorQuantidade(string origem) => origem is Atacado or Quantidade or GrupoMix;
}

/// <summary>Valores de <c>produtos.tipo</c> (modelo 3.6.3).</summary>
public static class TipoProduto
{
    public const string Simples = "simples";
    public const string ComVariacoes = "com_variacoes";
    public const string Kit = "kit";
    public const string ComComplementos = "com_complementos";
    public const string MateriaPrima = "materia_prima";
    public const string Servico = "servico";
    public const string Produzido = "produzido";
    public const string Vasilhame = "vasilhame";
}

public static class StatusFiscal
{
    public const string NaoAplicavel = "nao_aplicavel";
}

public enum TipoDesconto
{
    Valor,
    Percentual,
}

/// <summary>Cascos de um item cheio (PDV 10.12): trazidos = devidos − cobrados.</summary>
public readonly record struct SituacaoCascos(decimal Devidos, decimal Cobrados, decimal Trazidos);

/// <summary>Linha do bloco <c>vasilhames</c> do <c>venda.finalizada</c> (sincronizacao.md 9.7).</summary>
public sealed record ResumoVasilhame(Guid ProdutoVasilhameId, decimal Devolvidos, decimal Vendidos, decimal Emprestados, Guid? PessoaId);

/// <summary>
/// Cascos vazios trazidos <b>além</b> dos devidos pela venda (o casco excedente) e descontados nela pelo valor do casco
/// (PDV 10.12, devolução avulsa; O14 do dono; Fase 1C, C11c). Não é item: soma no <c>desconto_total</c> (origem
/// <c>cliente</c>, fora do limite do operador) e nos <c>devolvidos</c> do bloco <c>vasilhames</c>, que dão a entrada dos
/// vazios na nuvem. O preço é o do casco na primeira vez que ele foi descontado na venda (como o snapshot da 11.3).
/// </summary>
public sealed record CascoDescontado(Guid ProdutoVasilhameId, string Descricao, int Quantidade, decimal PrecoUnitario, DateTimeOffset RegistradoEm)
{
    /// <summary>arred2(quantidade × preço do casco): a parte deste casco no desconto da venda.</summary>
    public decimal Valor => Numeros.Arredondamento.Arred2(Quantidade * PrecoUnitario);
}
