using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas espelho do fluxo `operacao` (MD 6.1, 6.2; Fase 3, F3-B7): os orçamentos da loja e o status das vendas do
// caixa alteradas fora dele. Mesmo nome e mesmas colunas da nuvem (`EsquemaNuvemTests` confere contra o Esquema.g.cs
// gerado). Somente leitura no PDV: o aplicador do pull grava por SQL. O uso (F9, Gestão de vendas) é de blocos seguintes.

/// <summary>
/// <c>orcamentos</c> (MD 3.11.1): orçamentos da loja do terminal. <c>valido_ate</c> é gerada (<c>data +
/// dias_validade</c>) na nuvem e aqui: o pull a ignora e o SQLite a calcula. "Expirado" não é status: é <c>aberto</c>
/// com <c>valido_ate</c> antes de hoje.
/// </summary>
public class OrcamentoRegistro : LinhaEspelho
{
    public int Codigo { get; set; }
    public Guid LojaId { get; set; }
    public Guid? PessoaId { get; set; }
    public string Nome { get; set; } = string.Empty;
    public string? Email { get; set; }
    public string? Telefone { get; set; }
    public DateOnly Data { get; set; }
    public short DiasValidade { get; set; }
    public DateOnly ValidoAte { get; set; }
    public bool Ativo { get; set; } = true;
    public string Status { get; set; } = "aberto";
    public string Respondido { get; set; } = "nao";
    public DateTimeOffset? RespondidoEm { get; set; }
    public string? RespostaObservacao { get; set; }
    public Guid? VendedorId { get; set; }
    public string? DescontoTipo { get; set; }
    [Escala(2)] public decimal DescontoValor { get; set; }
    [Escala(4)] public decimal? DescontoPct { get; set; }
    [Escala(2)] public decimal SubtotalBruto { get; set; }
    [Escala(2)] public decimal Total { get; set; }
    public string? CondicoesPagamento { get; set; }
    public string? Observacoes { get; set; }
    public string Origem { get; set; } = "erp";
    public Guid? OrigemTerminalId { get; set; }
    public Guid? VendaId { get; set; }
    public DateTimeOffset? ConvertidoEm { get; set; }
    public Guid? ReservadoTerminalId { get; set; }
    public DateTimeOffset? ReservadoAte { get; set; }
}

/// <summary><c>itens_orcamento</c> (MD 3.11.1): itens do orçamento, na ordem de <c>sequencia</c>.</summary>
public class ItemOrcamentoRegistro : LinhaEspelhoSemAutoria
{
    public Guid OrcamentoId { get; set; }
    public int Sequencia { get; set; }
    public Guid ProdutoId { get; set; }
    public Guid? VariacaoId { get; set; }
    public string Descricao { get; set; } = string.Empty;
    public string Unidade { get; set; } = string.Empty;
    [Escala(3)] public decimal Quantidade { get; set; }
    [Escala(4)] public decimal PrecoUnitario { get; set; }
    [Escala(2)] public decimal DescontoItem { get; set; }
    [Escala(2)] public decimal ValorTotal { get; set; }
    public string? Observacao { get; set; }
}

/// <summary>
/// <c>vendas_status_pdv</c> (MD 3.11.9; SYNC 16.3): o estado das vendas deste caixa alteradas fora do terminal
/// (cancelamento pelo ERP, devolução em outro caixa, status fiscal da nuvem), dos últimos 90 dias; o <c>id</c> é o da
/// venda. Desce pelo caixa, então o terminal substituto recebe o das vendas do antigo. A tabela <c>vendas</c> local
/// nunca é regravada com estes valores; a Gestão de vendas (F3-B29) lê com <c>left join</c>. A linha com mais de 90 dias
/// sem mudança sai pela purga do pull de <c>operacao</c> (<c>PurgaJanelas</c>).
/// </summary>
public class VendaStatusPdvRegistro : LinhaEspelhoSemAutoria
{
    public Guid CaixaId { get; set; }
    public Guid TerminalId { get; set; }
    public string Status { get; set; } = string.Empty;
    public string StatusFiscal { get; set; } = string.Empty;
    public string Devolucao { get; set; } = string.Empty;
    public DateTimeOffset? CanceladaEm { get; set; }
    public string? CancelamentoOrigem { get; set; }
}
