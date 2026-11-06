using GenesisPDV.Core.Numeros;
using GenesisPDV.Core.Precos;
using GenesisPDV.Core.Vendas;

namespace GenesisPDV.Core.Produtos;

/// <summary>Visão do produto que a venda precisa (projeção das tabelas espelho <c>produtos</c> e afins).</summary>
/// <param name="PrecoVenda"><c>produtos.preco_venda</c> (varejo geral). O da loja vem em <see cref="Precos"/>.</param>
public sealed record ProdutoVenda(
    Guid Id,
    int? Codigo,
    string? CodigoInterno,
    string Descricao,
    string Unidade,
    decimal PrecoVenda,
    bool Ativo = true,
    bool Vendavel = true)
{
    private static readonly HashSet<string> UnidadesFracionaveis = new(StringComparer.OrdinalIgnoreCase) { "KG", "L", "M", "M2", "M3" };

    /// <summary><c>produtos.tipo</c> (<see cref="TipoProduto"/>).</summary>
    public string Tipo { get; init; } = TipoProduto.Simples;

    /// <summary><c>produtos.permite_fracao</c>; nulo = deduzido da unidade (KG, L, M, M2, M3; PDV 10.1).</summary>
    public bool? PermiteFracao { get; init; }

    /// <summary>Demais fontes de preço da regra 11.3 (loja, promocional, atacado, faixas, mix, embalagens).</summary>
    public TabelaPreco? Precos { get; init; }

    /// <summary><c>produtos.vasilhame_produto_id</c>: casco devido por unidade vendida (PDV 10.12).</summary>
    public Guid? VasilhameProdutoId { get; init; }

    /// <summary><c>produtos.vasilhame_quantidade</c>: cascos por unidade vendida.</summary>
    public int? VasilhameQuantidade { get; init; }

    /// <summary>Código exibido na pesquisa (EAN principal ou código interno).</summary>
    public string? CodigoPrincipal { get; init; }

    /// <summary><c>produtos.controla_estoque</c>: sem controle, o saldo nunca avisa nem bloqueia (PDV 29.1).</summary>
    public bool ControlaEstoque { get; init; } = true;

    /// <summary>
    /// Ficha técnica do produto <c>produzido</c> (<c>produtos_componentes</c> tipo <c>ficha_tecnica</c>, PDV 10.9.2;
    /// D17 do dono): a venda baixa os insumos com a perda. Nula nos demais tipos.
    /// </summary>
    public IReadOnlyList<ComponenteFicha>? FichaTecnica { get; init; }

    /// <summary>
    /// <c>produtos.idade_minima</c> (bebida alcoólica, 18): a forma com <c>restringe_idade_minima</c> (VA/VR) não paga o
    /// item (MD 3.10.1). A confirmação de maioridade no caixa fica desligada (O20 do dono).
    /// </summary>
    public short? IdadeMinima { get; init; }

    public bool Fracionavel => PermiteFracao ?? UnidadesFracionaveis.Contains(Unidade);

    /// <summary>Varejo da regra 11.3 passo 3: <c>produtos_lojas.preco_venda ?? produtos.preco_venda</c>.</summary>
    public decimal PrecoBase => Precos?.PrecoVendaLoja ?? PrecoVenda;

    public bool EhKit => Tipo == TipoProduto.Kit;

    /// <summary>Tem idade mínima: fica fora do que a forma restrita (VA/VR) pode pagar.</summary>
    public bool RestritoPorIdade => IdadeMinima is > 0;

    /// <summary>Produto cheio retornável: a venda pergunta os cascos trazidos (PDV 10.12).</summary>
    public bool Retornavel => VasilhameProdutoId is not null && VasilhameQuantidade is > 0;
}

/// <summary>Insumo da ficha técnica por unidade do produzido, com a perda (MD 3.6.6 <c>perda_pct</c>).</summary>
public sealed record ComponenteFicha(Guid ProdutoId, Guid? VariacaoId, decimal Quantidade, decimal PerdaPct);

/// <summary>Linha de <c>componentes_estoque</c> do item (SYNC 9.7): a baixa já multiplicada pela quantidade.</summary>
public sealed record ComponenteBaixa(Guid ProdutoId, Guid? VariacaoId, decimal Quantidade);

/// <summary>Resultado da resolução de um código lido (PDV 10.2).</summary>
/// <param name="CodigoBarrasId">Linha de <c>produtos_codigos_barras</c> lida, quando o código veio de lá.</param>
/// <param name="Fator">Fator da embalagem (fardo de 12 = 12); a quantidade do item é fator × multiplicador.</param>
/// <param name="PrecoEmbalagem"><c>produtos_codigos_barras.preco</c>: preço autoritativo da embalagem (nulo = regra 11.3).</param>
/// <param name="SiglaEmbalagem">Sigla da <c>unidade_id</c> da embalagem ("FD"), para tela e cupom.</param>
public sealed record ProdutoResolvido(
    ProdutoVenda Produto,
    Guid? CodigoBarrasId = null,
    decimal Fator = 1m,
    decimal? PrecoEmbalagem = null,
    string? SiglaEmbalagem = null)
{
    /// <summary>Embalagem lida (fator ≠ 1 ou com preço próprio); nulo para a unidade.</summary>
    public EmbalagemPreco? Embalagem => CodigoBarrasId is { } id && (Fator != 1m || PrecoEmbalagem is not null)
        ? new EmbalagemPreco(id, Fator, PrecoEmbalagem, SiglaEmbalagem)
        : null;
}

/// <summary>
/// Linha da pesquisa F2 (PDV 10.3): o produto já resolvido na embalagem do código que bateu. Na pesquisa só por números
/// (decisão 65) o DUN do fardo acha a linha do fardo, que entra como fardo (fator, preço e sigla da embalagem), igual ao
/// bipe; na pesquisa por nome e nos códigos da unidade, a unidade.
/// </summary>
/// <param name="CodigoEmbalagem">O código de barras da embalagem que bateu (nulo na unidade).</param>
public sealed record ProdutoPesquisado(ProdutoResolvido Resolvido, string? CodigoEmbalagem = null)
{
    public ProdutoVenda Produto => Resolvido.Produto;

    public string Descricao => Produto.Descricao;

    public string? CodigoInterno => Produto.CodigoInterno;

    /// <summary>Código mostrado na linha e o da inclusão: o da embalagem que bateu, ou o principal da unidade.</summary>
    public string Codigo => CodigoEmbalagem ?? Produto.CodigoPrincipal ?? Produto.CodigoInterno ?? string.Empty;

    public bool EhEmbalagem => Resolvido.Embalagem is not null;

    /// <summary>"UN", ou a embalagem com o fator ("FD 12").</summary>
    public string Unidade => EhEmbalagem
        ? $"{Resolvido.SiglaEmbalagem ?? "EMB"} {Resolvido.Fator.ToString("0.###", NumeroBr.Cultura)}"
        : Produto.Unidade;

    /// <summary>Preço de referência da linha: o da embalagem (ou fator × varejo, sem preço próprio); o motor decide na venda.</summary>
    public decimal Preco => EhEmbalagem
        ? Resolvido.PrecoEmbalagem ?? Arredondamento.Arred2(Produto.PrecoBase * Resolvido.Fator)
        : Produto.PrecoBase;
}

public interface ICatalogoProdutos
{
    /// <summary>Resolve código de barras, código interno ou código numérico do produto. Pode haver mais de um resultado.</summary>
    Task<IReadOnlyList<ProdutoResolvido>> ResolverAsync(string codigo, CancellationToken ct = default);

    /// <summary>Pesquisa por descrição/código (F2): todas as palavras, sem acento, em qualquer ordem.</summary>
    Task<IReadOnlyList<ProdutoVenda>> PesquisarAsync(string texto, int limite = 50, CancellationToken ct = default);

    /// <summary>
    /// Pesquisa só por código (a "pesquisa só por números" do terminal): <paramref name="digitos"/> no código interno, no
    /// código numérico do produto e nos códigos de barras de venda (EAN principal e códigos adicionais das embalagens),
    /// primeiro os que batem exato, depois os que começam com os dígitos e por fim os que os contêm (por nome em cada grupo).
    /// </summary>
    /// <remarks>
    /// Uma linha por produto e embalagem: o código da unidade (interno, numérico, EAN de fator 1) dá a linha da unidade; o
    /// código de uma embalagem (fator ≠ 1 ou preço próprio) dá a linha dela (<see cref="ProdutoPesquisado"/>).
    /// </remarks>
    Task<IReadOnlyList<ProdutoPesquisado>> PesquisarCodigoAsync(string digitos, int limite = 50, CancellationToken ct = default);

    /// <summary>Produto pelo id (casco do retornável, produtos de uma venda recuperada). Nulo se não existe.</summary>
    Task<ProdutoVenda?> ObterAsync(Guid produtoId, CancellationToken ct = default);

    /// <summary>Composição do combo (kit) no espelho local, com as alternativas vendáveis na loja (PDV 10.9.1).</summary>
    Task<ComboResolvido?> ObterComboAsync(Guid kitId, CancellationToken ct = default);
}
