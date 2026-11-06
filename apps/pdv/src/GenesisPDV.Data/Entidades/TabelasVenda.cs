using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas de movimento da venda (modelo de dados 3.11.2–3.11.4 e 4.3): mesmas colunas e CHECKs da nuvem (migração
// 0012 da API; o EsquemaNuvemTests confere contra o Esquema.g.cs). As colunas que só a nuvem preenche existem e ficam
// nulas no PDV.

/// <summary>Colunas padrão (CP) das tabelas de movimento. <c>versao</c> fica 0 até a nuvem devolver a sua.</summary>
public abstract class LinhaMovimento
{
    public Guid Id { get; set; }
    public DateTimeOffset CriadoEm { get; set; }
    public DateTimeOffset AtualizadoEm { get; set; }
    public DateTimeOffset? ExcluidoEm { get; set; }
    public long Versao { get; set; }
}

/// <summary><c>vendas</c>.</summary>
public class VendaRegistro : LinhaMovimento
{
    public Guid? CriadoPorId { get; set; }
    public Guid? AtualizadoPorId { get; set; }
    public long Numero { get; set; }
    public string NumeroExibicao { get; set; } = string.Empty;
    public Guid LojaId { get; set; }
    public Guid CaixaId { get; set; }
    public short NumeroCaixa { get; set; }
    public Guid? TerminalId { get; set; }
    public Guid? SessaoCaixaId { get; set; }
    public string Tipo { get; set; } = "pdv";
    public string Canal { get; set; } = "pdv";
    public string Modo { get; set; } = "balcao";
    public string? IdExterno { get; set; }
    public string Status { get; set; } = "em_andamento";
    public string StatusFiscal { get; set; } = "nao_aplicavel";
    public string Devolucao { get; set; } = "nenhuma";
    public DateOnly? DiaOperacional { get; set; }
    public Guid OperadorId { get; set; }
    public Guid? VendedorId { get; set; }
    public Guid? ClienteId { get; set; }
    public string? CpfCnpjNota { get; set; }
    public string? NomeNota { get; set; }
    public string TipoPreco { get; set; } = "varejo";
    public Guid? OrcamentoId { get; set; }
    public Guid? ComandaId { get; set; }
    public Guid? PedidoId { get; set; }
    public int QtdItens { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal SubtotalBruto { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal DescontoItens { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal DescontoTotal { get; set; }
    [Escala(Escalas.Percentual)] public decimal? DescontoTotalPct { get; set; }
    public string? DescontoTotalOrigem { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal AcrescimoTotal { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal TaxaServico { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal TaxaEntrega { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal ValorFrete { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal Total { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal Troco { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? CustoTotal { get; set; }
    public Guid? EnderecoEntregaId { get; set; }
    public string? EnderecoEntrega { get; set; }
    public Guid? EnderecoFaturamentoId { get; set; }
    public DateOnly? DataEntrega { get; set; }
    public string? ObservacaoNfe { get; set; }
    public string? Observacao { get; set; }
    public string? FreteModalidade { get; set; }
    public string? FreteTipo { get; set; }
    public Guid? TransportadoraId { get; set; }
    public string? Volumes { get; set; }
    public short? QtdParcelas { get; set; }
    public DateTimeOffset IniciadaEm { get; set; }
    public DateTimeOffset? FinalizadaEm { get; set; }
    public DateTimeOffset? CanceladaEm { get; set; }
    public Guid? CanceladaPorId { get; set; }
    public Guid? CancelamentoAutorizadoPorId { get; set; }
    public string? MotivoCancelamento { get; set; }
    public string? CancelamentoOrigem { get; set; }
    public Guid? IdadeConfirmadaPorId { get; set; }
    public DateTimeOffset? IdadeConfirmadaEm { get; set; }
    public Guid? EventoFinalizacaoId { get; set; }

    /// <summary>
    /// <c>false</c> quando a venda foi finalizada sem hora confiável (SYNC 12.3–12.4; decisão técnica T5 da 1C). Na
    /// nuvem vem do envelope do <c>venda.finalizada</c>; aqui o gravador do outbox (bloco C9) preenche junto com o envelope.
    /// </summary>
    public bool RelogioConfiavel { get; set; } = true;

    public List<ItemVendaRegistro> Itens { get; set; } = [];
    public List<PagamentoVendaRegistro> Pagamentos { get; set; } = [];
}

/// <summary><c>itens_venda</c>.</summary>
public class ItemVendaRegistro : LinhaMovimento
{
    public Guid VendaId { get; set; }
    public int Sequencia { get; set; }
    public Guid ProdutoId { get; set; }
    public Guid? VariacaoId { get; set; }
    public string? CodigoLido { get; set; }
    public Guid? CodigoBarrasId { get; set; }
    public string? OrigemEntrada { get; set; }
    public bool PesoDigitado { get; set; }
    public string Descricao { get; set; } = string.Empty;
    public string Unidade { get; set; } = string.Empty;
    [Escala(Escalas.Quantidade)] public decimal Quantidade { get; set; }
    [Escala(Escalas.Preco)] public decimal PrecoTabela { get; set; }
    [Escala(Escalas.Preco)] public decimal PrecoUnitario { get; set; }
    public string OrigemPreco { get; set; } = "varejo";
    public Guid? GrupoPrecoQuantidadeId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal? QuantidadeReferenciaPreco { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal ValorBruto { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal DescontoItem { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal DescontoPromocao { get; set; }
    public Guid? PromocaoId { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal DescontoRateado { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal AcrescimoRateado { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal FreteRateado { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal ValorLiquido { get; set; }
    public Guid? LoteId { get; set; }
    public string? Lote { get; set; }
    public DateOnly? ValidadeLote { get; set; }
    public Guid? KitGrupoId { get; set; }
    public Guid? KitProdutoId { get; set; }
    public string? KitDescricao { get; set; }
    [Escala(Escalas.Quantidade)] public decimal? KitQuantidade { get; set; }
    [Escala(Escalas.Preco)] public decimal? KitPrecoUnitario { get; set; }
    public Guid? KitComponenteId { get; set; }
    public Guid? KitAlternativaId { get; set; }
    [Escala(Escalas.Preco)] public decimal KitAcrescimo { get; set; }
    public Guid? VasilhameItemOrigemId { get; set; }
    public Guid? ItemComandaId { get; set; }
    public Guid? ItemOrcamentoId { get; set; }
    public Guid? VendedorId { get; set; }
    [Escala(Escalas.Percentual)] public decimal? ComissaoPct { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? ValorComissao { get; set; }
    [Escala(Escalas.Preco)] public decimal? CustoUnitario { get; set; }
    public string? Cfop { get; set; }
    public string? Ncm { get; set; }
    public string? FiscalSnapshot { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? VIbs { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? VCbs { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? VIs { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? VFcp { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? VIcmsStRet { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? VFcpStRet { get; set; }
    [Escala(Escalas.Quantidade)] public decimal QuantidadeDevolvida { get; set; }
    public bool Cancelado { get; set; }
    public DateTimeOffset? CanceladoEm { get; set; }
    public Guid? CanceladoPorId { get; set; }
    public Guid? AutorizadoPorId { get; set; }
    public string? MotivoCancelamento { get; set; }
    public DateTimeOffset IncluidoEm { get; set; }
}

/// <summary><c>pagamentos_venda</c>.</summary>
public class PagamentoVendaRegistro : LinhaMovimento
{
    public Guid VendaId { get; set; }
    public short Sequencia { get; set; }
    public Guid FormaPagamentoId { get; set; }
    public string DescricaoForma { get; set; } = string.Empty;
    public string MeioPagamentoFiscal { get; set; } = string.Empty;
    public string TipoForma { get; set; } = string.Empty;
    [Escala(Escalas.Dinheiro)] public decimal Valor { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal? ValorRecebido { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal Troco { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal ValorTaxaServico { get; set; }
    public short Parcelas { get; set; } = 1;
    public string Status { get; set; } = "aprovado";
    public bool LancaQuitada { get; set; }
    [Escala(Escalas.Percentual)] public decimal TaxaPct { get; set; }
    public Guid? PessoaId { get; set; }
    public short IndicadorPagamento { get; set; }
    public DateOnly? DataPagamento { get; set; }
    public string? CnpjPagamento { get; set; }
    public string? UfPagamento { get; set; }
    public short? TipoIntegracao { get; set; }
    public string? Bandeira { get; set; }
    public string? BandeiraNome { get; set; }
    public string? Adquirente { get; set; }
    public string? CnpjCredenciadora { get; set; }
    public string? Nsu { get; set; }
    public string? Autorizacao { get; set; }
    public string? CartaoMascarado { get; set; }
    public string? CnpjBeneficiario { get; set; }
    public string? IdTerminalPagamento { get; set; }
    public Guid? TefTransacaoId { get; set; }
    public Guid? PixCobrancaId { get; set; }
    public Guid? ValeId { get; set; }
    public Guid? TransferidoDeId { get; set; }
    public Guid? AutorizadoPorId { get; set; }
    public Guid? ContaFinanceiraId { get; set; }

    public List<ParcelaVendaRegistro> ParcelasVenda { get; set; } = [];
}

/// <summary><c>parcelas_venda</c>.</summary>
public class ParcelaVendaRegistro : LinhaMovimento
{
    public Guid PagamentoVendaId { get; set; }
    public short Numero { get; set; }
    public DateOnly Vencimento { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal Valor { get; set; }
}

/// <summary>
/// <c>cobrancas_pix</c> (MD 3.11.6; Fase 1C, C11a): no PDV-1 só a estática (QR da chave da loja) ou a confirmação
/// manual, já paga, ligada ao pagamento da venda; sobe no <c>venda.finalizada</c>. Gravada no mesmo commit da venda,
/// para a venda em andamento voltar com ela depois de uma queda.
/// </summary>
public class CobrancaPixRegistro : LinhaMovimento
{
    public string Txid { get; set; } = string.Empty;
    public string Tipo { get; set; } = "estatico";
    public Guid LojaId { get; set; }
    public Guid TerminalId { get; set; }
    public Guid? VendaId { get; set; }
    public Guid? PagamentoVendaId { get; set; }
    public string? Psp { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal Valor { get; set; }
    public string Status { get; set; } = "ativa";
    public string QrcodePayload { get; set; } = string.Empty;
    public DateTimeOffset? ExpiraEm { get; set; }
    public DateTimeOffset? PagaEm { get; set; }
    public string? E2eId { get; set; }
    public string? PagadorNome { get; set; }
    public string? PagadorDocumento { get; set; }
    [Escala(Escalas.Dinheiro)] public decimal ValorDevolvido { get; set; }
    public DateTimeOffset? DevolvidaEm { get; set; }
}
