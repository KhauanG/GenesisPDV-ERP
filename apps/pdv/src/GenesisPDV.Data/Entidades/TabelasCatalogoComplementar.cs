using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas espelho do fluxo `catalogo` (MD 6.1, 6.2) que a venda da Fase 1A ainda não lia.
// Mesmo nome e mesmas colunas da nuvem na projeção do pull (colunas que não descem ficam fora; `EsquemaNuvemTests`
// confere contra o Esquema.g.cs gerado). Somente leitura no PDV: o aplicador do pull grava por SQL.

/// <summary><c>atributos_variacao</c>: Atributos de variação (cor, tamanho).</summary>
public class AtributoVariacaoRegistro : LinhaEspelho
{
    public string Nome { get; set; } = string.Empty;
    public int Ordem { get; set; }
}

/// <summary><c>atributos_variacao_valores</c>: Valores dos atributos de variação.</summary>
public class AtributoVariacaoValorRegistro : LinhaEspelho
{
    public Guid AtributoId { get; set; }
    public string Valor { get; set; } = string.Empty;
    public int Ordem { get; set; }
}

/// <summary><c>categorias</c>: Categorias (árvore).</summary>
public class CategoriaRegistro : LinhaEspelho
{
    public string Nome { get; set; } = string.Empty;
    public Guid? CategoriaPaiId { get; set; }
    public string Caminho { get; set; } = string.Empty;
    public string CaminhoNomes { get; set; } = string.Empty;
    public short Nivel { get; set; }
    public int Ordem { get; set; }
    public bool Ativa { get; set; }
    public bool ExibePdv { get; set; }
    public bool ExibeMenuDigital { get; set; }
    public bool ExibeTotem { get; set; }
    public bool ExibeSite { get; set; }
    public Guid? ImagemArquivoId { get; set; }
    public string? Cor { get; set; }

    /// <summary>Campo calculado do pull (F2-B45; SYNC 6.12): caminho estável da imagem (variante <c>pdv_256</c>).</summary>
    public string? ImagemUrl { get; set; }

    /// <summary>Campo calculado do pull: sha256 da variante, a chave do cache local de imagens.</summary>
    public string? ImagemSha256 { get; set; }
}

/// <summary><c>marcas</c>: Marcas.</summary>
public class MarcaRegistro : LinhaEspelho
{
    public int Codigo { get; set; }
    public string Descricao { get; set; } = string.Empty;
    public bool SemMarca { get; set; }
    public bool ExibeSite { get; set; }
    public int Ordem { get; set; }
    public Guid? LogotipoArquivoId { get; set; }

    /// <summary>Campo calculado do pull (F2-B45; SYNC 6.12): caminho estável do logotipo (variante <c>pdv_256</c>).</summary>
    public string? LogotipoUrl { get; set; }

    /// <summary>Campo calculado do pull: sha256 da variante, a chave do cache local de imagens.</summary>
    public string? LogotipoSha256 { get; set; }
}

/// <summary><c>produtos_categorias</c>: Categorias de cada produto.</summary>
public class ProdutoCategoriaRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public Guid CategoriaId { get; set; }
    public bool Principal { get; set; }
}

/// <summary><c>produtos_lotes</c>: Lotes do estoque da loja (ou sem estoque).</summary>
public class ProdutoLoteRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public Guid? VariacaoId { get; set; }
    public Guid? EstoqueId { get; set; }
    public string Lote { get; set; } = string.Empty;
    public DateOnly? Validade { get; set; }
    public DateOnly? Fabricacao { get; set; }
    public Guid? FornecedorId { get; set; }
    public bool Ativo { get; set; }
}

/// <summary><c>produtos_relacionados</c>: Produtos relacionados (sugestão no caixa).</summary>
public class ProdutoRelacionadoRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public Guid RelacionadoId { get; set; }
    public string Tipo { get; set; } = string.Empty;
    public int Ordem { get; set; }
}

/// <summary><c>produtos_tributacao_uf</c>: Tributação do produto na UF da loja.</summary>
public class ProdutoTributacaoUfRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public string Uf { get; set; } = string.Empty;
    public string? CfopVendaEstado { get; set; }
    public string? IcmsSituacao { get; set; }
    public string? IcmsModalidadeBc { get; set; }
    [Escala(4)] public decimal? IcmsAliquota { get; set; }
    [Escala(4)] public decimal? IcmsReducaoBcPct { get; set; }
    public string? IcmsModalidadeBcst { get; set; }
    [Escala(4)] public decimal? IcmsMvaPct { get; set; }
    [Escala(4)] public decimal? IcmsAliquotaSt { get; set; }
    [Escala(4)] public decimal? FcpAliquota { get; set; }
    [Escala(4)] public decimal? FcpStAliquota { get; set; }
    public string? BeneficioFiscalCodigo { get; set; }
}

/// <summary><c>produtos_variacoes</c>: Variações do produto, sem custo.</summary>
public class ProdutoVariacaoRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public string Nome { get; set; } = string.Empty;
    public string? CodigoInterno { get; set; }
    [Escala(4)] public decimal? PrecoVenda { get; set; }
    public bool Ativo { get; set; }
    public int Ordem { get; set; }
}

/// <summary><c>produtos_variacoes_valores</c>: Valores de atributo de cada variação.</summary>
public class ProdutoVariacaoValorRegistro : LinhaEspelho
{
    public Guid VariacaoId { get; set; }
    public Guid AtributoValorId { get; set; }
}

/// <summary>
/// <c>produtos_grupos_complementos</c> (MD 3.6.8; F2-B45; F2-Q1 = D43): grupos de complementos do produto
/// <c>com_complementos</c> ("Gelo", "Adicionais"). Só o espelho: o uso na venda é da Fase 3.
/// </summary>
public class ProdutoGrupoComplementosRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public string Nome { get; set; } = string.Empty;
    public short Minimo { get; set; }
    public short Maximo { get; set; }
    public bool Obrigatorio { get; set; }
    public int Ordem { get; set; }
}

/// <summary><c>produtos_complementos</c> (MD 3.6.8): opções de um grupo, vinculadas a um produto ou livres.</summary>
public class ProdutoComplementoRegistro : LinhaEspelho
{
    public Guid GrupoId { get; set; }
    public Guid? ProdutoId { get; set; }
    public string? Descricao { get; set; }
    [Escala(4)] public decimal PrecoAdicional { get; set; }
    public bool BaixaEstoque { get; set; }
    [Escala(3)] public decimal QuantidadeBaixa { get; set; }
    public int Ordem { get; set; }
    public bool Ativo { get; set; }
}
