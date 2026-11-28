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
/// ação que exige supervisor. As demais (limite de valor, tipo de preço, lote vencido…) entram com o diálogo de cada uma, e
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

    /// <summary>
    /// Preço do item alterado (<c>Ctrl+F6</c>, PDV 10.5; Fase 3, F3-B16) liberado pelo supervisor: a redução passou do
    /// limite do operador, ou o operador não tem <c>pdv.venda.alterar_preco</c>. Com o item e o % pedido.
    /// </summary>
    public const string AlterarPreco = "alterar_preco";

    /// <summary>
    /// Tipo de preço Atacado (<c>F8</c>, PDV 11.2; Fase 3, F3-B17) liberado pelo supervisor: o operador sem
    /// <c>pdv.venda.tipo_preco_atacado</c>. Da venda toda (item e % nulos); a volta ao varejo não pede liberação.
    /// </summary>
    public const string TipoPreco = "tipo_preco";
}

/// <summary>
/// Valores de <c>vendas.tipo_preco</c> (modelo 3.11.2, <c>ck_vendas_tipo_preco</c>; <c>TIPOS_PRECO_VENDA</c> do contrato).
/// O <c>F8</c> (PDV 11.2; F3-B17) escolhe entre <see cref="Varejo"/> e <see cref="Atacado"/>; o <see cref="Parcelado"/> vem
/// só do pagamento parcelado (11.2, F3-B18; <c>Venda.AplicarPrecoParcelado</c>), nunca do F8.
/// </summary>
public static class TipoPrecoVenda
{
    public const string Varejo = "varejo";
    public const string Atacado = "atacado";
    public const string Parcelado = "parcelado";

    /// <summary>Os tipos que o <c>F8</c> escolhe, na ordem da tela.</summary>
    public static readonly IReadOnlyList<string> DoF8 = [Varejo, Atacado];

    /// <summary>O nome na tela e na auditoria ("Varejo", "Atacado", "Parcelado").</summary>
    public static string Rotulo(string tipo) => tipo switch
    {
        Varejo => "Varejo",
        Atacado => "Atacado",
        Parcelado => "Parcelado",
        _ => tipo,
    };
}

/// <summary>
/// Resultado do <c>F8</c> (PDV 11.2; F3-B17). <see cref="SituacaoDesconto.ExigeLiberacao"/> = o Atacado pedido por
/// quem não tem <c>pdv.venda.tipo_preco_atacado</c>, sem a liberação. <paramref name="LinhasAlteradas"/> conta as linhas
/// cujo preço unitário mudou com o recálculo (as de preço manual, combo, casco e as fixadas ficam como estavam).
/// </summary>
public sealed record ResultadoTipoPreco(
    SituacaoDesconto Situacao, string Tipo, decimal TotalAntes, decimal TotalDepois, int LinhasAlteradas, bool PorLiberacao = false)
{
    public bool Aplicado => Situacao == SituacaoDesconto.Aplicado;
}

/// <summary>
/// Resultado do <c>Alt+G</c> (PDV 11.4; F3-B18): o item ficou <paramref name="Gelado"/> ou natural, com o acréscimo por
/// unidade somado ou tirado e o total antes e depois.
/// </summary>
public sealed record ResultadoGelado(int Sequencia, bool Gelado, decimal AcrescimoUnitario, decimal TotalAntes, decimal TotalDepois);

/// <summary>
/// Prévia ou resultado do preço parcelado (PDV 11.2; F3-B18): "total passa de R$ <paramref name="TotalAntes"/> para R$
/// <paramref name="TotalDepois"/>". <paramref name="LinhasAlteradas"/> conta as linhas que passaram a <c>origem_preco =
/// 'parcelado'</c>; zero = nenhum item tem o preço parcelado e a venda não muda (D74).
/// </summary>
public sealed record ResultadoParcelado(decimal TotalAntes, decimal TotalDepois, int LinhasAlteradas)
{
    public bool Aplica => LinhasAlteradas > 0;

    /// <summary>Quanto o parcelado soma ao total (o que o pagamento parcelado passa a cobrar a mais).</summary>
    public decimal Diferenca => TotalDepois - TotalAntes;
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

    /// <summary>
    /// Origens que a regra 11.3 recalcula quando a quantidade de referência ou o tipo de preço (<c>F8</c>, F3-B17) mudam
    /// (PDV 11.2, 11.3.1). A embalagem é recalculada (o preço do fardo é um candidato e vale o menor, 11.3.1; Padrões da
    /// Fase 3, que resolvem a divergência com a lista da 11.2); o preço manual, a balança tipo Valor, o orçamento e o
    /// combo ficam como estão. O parcelado (F3-B18) também é recalculado: ele vem do tipo da venda (o pagamento em parcelas)
    /// e volta aos preços do F8 quando o pagamento parcelado sai. Os adicionais dos complementos e o gelado voltam somados
    /// (a camada de acréscimos).
    /// </summary>
    public static bool Recalculavel(string origem) => origem is not (Manual or Balanca or Orcamento or KitRateio);

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
