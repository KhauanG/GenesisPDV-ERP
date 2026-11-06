using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas espelho do fluxo `pessoas` (MD 3.5.4, 6.1, 6.2; D19): só as pessoas relevantes para a loja.
// Mesmo nome e mesmas colunas da nuvem na projeção do pull (colunas que não descem ficam fora; `EsquemaNuvemTests`
// confere contra o Esquema.g.cs gerado). Somente leitura no PDV: o aplicador do pull grava por SQL.

/// <summary><c>parcelas_credito_pessoas</c>: Parcelas abertas de crediário (3.5.5).</summary>
public class ParcelaCreditoPessoaRegistro : LinhaEspelhoSemAutoria
{
    public Guid PessoaId { get; set; }
    public Guid ParcelaFinanceiraId { get; set; }
    public string Documento { get; set; } = string.Empty;
    public short Numero { get; set; }
    public DateOnly Vencimento { get; set; }
    [Escala(2)] public decimal Valor { get; set; }
    [Escala(2)] public decimal Saldo { get; set; }
    public int DiasAtraso { get; set; }
}

/// <summary><c>pessoas</c>: Pessoas relevantes para a loja (3.5.4), sem observações nem origem.</summary>
public class PessoaRegistro : LinhaEspelho
{
    public int Codigo { get; set; }
    public string Tipo { get; set; } = string.Empty;
    public string Nome { get; set; } = string.Empty;
    public string? Apelido { get; set; }
    public bool Ativa { get; set; }
    public string? CpfCnpj { get; set; }
    public string? RgIe { get; set; }
    public string IndicadorIe { get; set; } = string.Empty;
    public DateOnly? Nascimento { get; set; }
    public string Sexo { get; set; } = string.Empty;
    public string? SenhaHash { get; set; }
    [Escala(2)] public decimal? LimiteCompras { get; set; }
    [Escala(4)] public decimal DescontoPct { get; set; }
    public bool BloqueadaCredito { get; set; }
    public string? ObservacaoPdv { get; set; }
}

/// <summary><c>pessoas_aliases</c>: Aliases de cadastro rápido mesclado (todas as lojas).</summary>
public class PessoaAliasRegistro : LinhaEspelho
{
    public Guid AliasId { get; set; }
    public Guid PessoaId { get; set; }
    public Guid? TerminalId { get; set; }
    public string Motivo { get; set; } = string.Empty;
}

/// <summary><c>pessoas_categorias</c>: Categorias da pessoa.</summary>
public class PessoaCategoriaRegistro : LinhaEspelho
{
    public Guid PessoaId { get; set; }
    public string Categoria { get; set; } = string.Empty;
}

/// <summary><c>pessoas_enderecos</c>: Endereços (não descem de quem é relevante só como funcionário, D19).</summary>
public class PessoaEnderecoRegistro : LinhaEspelho
{
    public Guid PessoaId { get; set; }
    public string Tipo { get; set; } = string.Empty;
    public string? Cep { get; set; }
    public string? Logradouro { get; set; }
    public string? Numero { get; set; }
    public string? Complemento { get; set; }
    public string? Bairro { get; set; }
    public string? Uf { get; set; }
    public int? MunicipioIbge { get; set; }
    public bool Exterior { get; set; }
    public string? PaisCodigo { get; set; }
    public string? CidadeExterior { get; set; }
    public string? Referencia { get; set; }
}

/// <summary><c>pessoas_relevancia_loja</c>: Por que a pessoa está no espelho; a linha excluída faz o PDV purgar a pessoa (3.5.4).</summary>
public class PessoaRelevanciaLojaRegistro : LinhaEspelhoSemAutoria
{
    public Guid PessoaId { get; set; }
    public Guid? LojaId { get; set; }
    public string Motivo { get; set; } = string.Empty;
    public DateTimeOffset UltimaOcorrenciaEm { get; set; }
}

/// <summary><c>pessoas_telefones</c>: Telefones (não descem de quem é relevante só como funcionário, D19).</summary>
public class PessoaTelefoneRegistro : LinhaEspelho
{
    public Guid PessoaId { get; set; }
    public string Tipo { get; set; } = string.Empty;
    public string Ddd { get; set; } = string.Empty;
    public string Numero { get; set; } = string.Empty;
    public string? Contato { get; set; }
    public bool Principal { get; set; }
}

/// <summary><c>saldos_credito_pessoas</c>: Crédito em aberto da pessoa (3.5.3).</summary>
public class SaldoCreditoPessoaRegistro : LinhaEspelhoSemAutoria
{
    public Guid PessoaId { get; set; }
    [Escala(2)] public decimal Limite { get; set; }
    [Escala(2)] public decimal SaldoAberto { get; set; }
    [Escala(2)] public decimal SaldoVencido { get; set; }
    public int MaiorAtrasoDias { get; set; }
    public int ParcelasAbertas { get; set; }
    public DateTimeOffset CalculadoEm { get; set; }
}

/// <summary><c>saldos_vasilhame_pessoas</c>: Vasilhames em comodato com a pessoa.</summary>
public class SaldoVasilhamePessoaRegistro : LinhaEspelhoSemAutoria
{
    public Guid PessoaId { get; set; }
    public Guid ProdutoVasilhameId { get; set; }
    [Escala(3)] public decimal Quantidade { get; set; }
}
