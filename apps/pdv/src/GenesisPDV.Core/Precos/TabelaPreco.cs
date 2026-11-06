namespace GenesisPDV.Core.Precos;

/// <summary><c>grupos_preco_quantidade.modo_preco</c> (modelo 3.6.13).</summary>
public enum ModoPrecoGrupo
{
    /// <summary>A soma do grupo substitui a quantidade do produto no atacado e nas faixas do próprio produto.</summary>
    Produto,

    /// <summary>O preço vem das faixas do grupo, igual para todos os membros.</summary>
    Grupo,
}

/// <summary>
/// Faixa de <c>produtos_precos_quantidade</c> ou <c>grupos_preco_quantidade_faixas</c>: vale para
/// <c>quantidade_inicial ≤ Q ≤ quantidade_final</c> (final nulo = sem limite), PDV 11.3 passo 6.
/// </summary>
/// <param name="LojaId">Nulo = todas as lojas; a da loja do terminal prevalece sobre a geral na mesma quantidade.</param>
public sealed record FaixaPreco(decimal QuantidadeInicial, decimal? QuantidadeFinal, decimal Preco, Guid? LojaId = null)
{
    public bool Contem(decimal quantidade) =>
        quantidade >= QuantidadeInicial && (QuantidadeFinal is not { } final || quantidade <= final);
}

/// <summary>Grupo de preço por quantidade ("mix", modelo 3.6.13) com as faixas da loja do terminal e as gerais.</summary>
public sealed record GrupoPrecoQuantidade(Guid Id, string Nome, ModoPrecoGrupo Modo, bool Ativo = true, IReadOnlyList<FaixaPreco>? Faixas = null);

/// <summary>Embalagem (<c>produtos_codigos_barras</c> com fator, PDV 10.2): <see cref="Preco"/> nulo = regra 11.3.</summary>
public sealed record EmbalagemPreco(Guid CodigoBarrasId, decimal Fator, decimal? Preco, string? Sigla = null);

/// <summary>
/// Fontes de preço de um produto além do varejo geral (PDV 11.1), lidas do espelho local na primeira inclusão do
/// produto na venda: um pull no meio da venda não muda os itens já incluídos (11.3).
/// </summary>
/// <param name="PrecoVendaLoja"><c>produtos_lojas.preco_venda</c> da loja do terminal (nulo = preço geral).</param>
/// <param name="Faixas"><c>produtos_precos_quantidade</c> da loja do terminal e gerais (<c>loja_id</c> nulo).</param>
/// <param name="Embalagens">Embalagens do produto, para reconhecer as linhas lidas por <c>codigo_barras_id</c>.</param>
public sealed record TabelaPreco(
    decimal? PrecoVendaLoja = null,
    decimal? PrecoPromocional = null,
    DateTimeOffset? PromocaoInicio = null,
    DateTimeOffset? PromocaoFim = null,
    decimal? PrecoAtacado = null,
    decimal? QtdMinimaAtacado = null,
    IReadOnlyList<FaixaPreco>? Faixas = null,
    GrupoPrecoQuantidade? Grupo = null,
    IReadOnlyList<EmbalagemPreco>? Embalagens = null)
{
    /// <summary>Grupo que vale na venda: inativo = cada produto conta só a própria quantidade (3.6.13).</summary>
    public GrupoPrecoQuantidade? GrupoAtivo => Grupo is { Ativo: true } g ? g : null;

    /// <summary>Promoção vigente: <c>preco_promocional</c> &gt; 0 e dentro de <c>promocao_inicio</c>/<c>promocao_fim</c> (vazios = sempre).</summary>
    public bool PromocaoVigenteEm(DateTimeOffset instante) =>
        PrecoPromocional is > 0m
        && (PromocaoInicio is not { } inicio || instante >= inicio)
        && (PromocaoFim is not { } fim || instante <= fim);
}

/// <summary>Parâmetros da loja/venda que entram na regra de preço.</summary>
/// <param name="UsaPrecoVolume"><c>pdv.usa_preco_volume</c> ("Usa Produto Preço Volume"): habilita as faixas do produto e do grupo.</param>
/// <param name="TipoPreco"><c>vendas.tipo_preco</c>; <c>atacado</c> (F8, PDV-2) força o candidato atacado.</param>
public sealed record ParametrosPreco(Guid LojaId, bool UsaPrecoVolume, string TipoPreco = "varejo");
