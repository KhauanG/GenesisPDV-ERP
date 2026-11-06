using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas espelho do fluxo `estoque` (MD 6.1, 6.2): saldos do estoque da loja.
// Mesmo nome e mesmas colunas da nuvem na projeção do pull (colunas que não descem ficam fora; `EsquemaNuvemTests`
// confere contra o Esquema.g.cs gerado). Somente leitura no PDV: o aplicador do pull grava por SQL.

/// <summary><c>saldos_estoque</c>: Saldo do estoque da loja em tipo vendável, sem custo (MD 6.2).</summary>
public class SaldoEstoqueRegistro : LinhaEspelhoSemAutoria
{
    public Guid EstoqueId { get; set; }
    public Guid ProdutoId { get; set; }
    public Guid? VariacaoId { get; set; }
    public Guid TipoEstoqueId { get; set; }
    [Escala(3)] public decimal Quantidade { get; set; }
}

/// <summary><c>saldos_lote</c>: Saldo por lote do estoque da loja em tipo vendável.</summary>
public class SaldoLoteRegistro : LinhaEspelhoSemAutoria
{
    public Guid EstoqueId { get; set; }
    public Guid ProdutoId { get; set; }
    public Guid? VariacaoId { get; set; }
    public Guid LoteId { get; set; }
    public Guid TipoEstoqueId { get; set; }
    [Escala(3)] public decimal Quantidade { get; set; }
}
