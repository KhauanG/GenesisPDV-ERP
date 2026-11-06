using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas espelho do fluxo `configuracao` (MD 6.1, 6.2) que faltavam na Fase 1A.
// Mesmo nome e mesmas colunas da nuvem na projeção do pull (colunas que não descem ficam fora; `EsquemaNuvemTests`
// confere contra o Esquema.g.cs gerado). Somente leitura no PDV: o aplicador do pull grava por SQL.

/// <summary><c>atalhos_pdv</c>: Atalhos de teclado do PDV (empresa ou loja).</summary>
public class AtalhoPdvRegistro : LinhaEspelho
{
    public Guid? LojaId { get; set; }
    public string Acao { get; set; } = string.Empty;
    public string Tecla { get; set; } = string.Empty;
    public bool Habilitado { get; set; }
    public int Ordem { get; set; }
}

/// <summary><c>caixas</c>: Caixas da loja do terminal (3.2.3).</summary>
public class CaixaRegistro : LinhaEspelho
{
    public Guid LojaId { get; set; }
    public short Numero { get; set; }
    public string? Descricao { get; set; }
    public bool Sistema { get; set; }
    public int? NfceSerie { get; set; }
    public string? TefTerminal { get; set; }
    public string? PosIdTerminal { get; set; }
    public Guid? TerminalId { get; set; }
    public Guid? TerminalAnteriorId { get; set; }
    public bool Ativo { get; set; }
}

/// <summary><c>certificados_digitais</c>: Certificado da loja com NFC-e; arquivo e senha descem nulos até a entrega cifrada (MD 1.10).</summary>
public class CertificadoDigitalRegistro : LinhaEspelho
{
    public Guid LojaId { get; set; }
    public string Tipo { get; set; } = string.Empty;
    public byte[]? ArquivoCifrado { get; set; }
    public byte[]? SenhaCifrada { get; set; }
    public string Titular { get; set; } = string.Empty;
    public string Cnpj { get; set; } = string.Empty;
    public string NumeroSerie { get; set; } = string.Empty;
    public string? Emissor { get; set; }
    public DateTimeOffset ValidoDe { get; set; }
    public DateTimeOffset ValidoAte { get; set; }
    public string ImpressaoDigital { get; set; } = string.Empty;
    public bool Ativo { get; set; }
}

/// <summary><c>empresa</c>: Empresa (3.1.1): identificação, regime e parâmetros gerais.</summary>
public class EmpresaRegistro : LinhaEspelho
{
    public bool Unica { get; set; }
    public int Codigo { get; set; }
    public string RazaoSocial { get; set; } = string.Empty;
    public string? NomeFantasia { get; set; }
    public string Cnpj { get; set; } = string.Empty;
    public string? Ie { get; set; }
    public string? InscricaoMunicipal { get; set; }
    public string? Cep { get; set; }
    public string? Logradouro { get; set; }
    public string? Numero { get; set; }
    public string? Complemento { get; set; }
    public string? Bairro { get; set; }
    public int? MunicipioIbge { get; set; }
    public string? Uf { get; set; }
    public string? Telefone { get; set; }
    public string? Email { get; set; }
    public string? EmailContador { get; set; }
    public string FusoHorario { get; set; } = string.Empty;
}

/// <summary><c>estoques</c>: Estoque vinculado à loja do terminal (E).</summary>
public class EstoqueRegistro : LinhaEspelho
{
    public int Codigo { get; set; }
    public string Nome { get; set; } = string.Empty;
    public string Tipo { get; set; } = string.Empty;
    public string? Endereco { get; set; }
    public bool Ativo { get; set; }
}

/// <summary><c>impressoras_destino</c>: Destinos de impressão (cozinha, bar…).</summary>
public class ImpressoraDestinoRegistro : LinhaEspelho
{
    public string Nome { get; set; } = string.Empty;
    public string? Descricao { get; set; }
    public Guid? LojaId { get; set; }
    public int Ordem { get; set; }
    public bool Ativo { get; set; }
}

/// <summary><c>lojas</c>: Loja do terminal (3.2.1); os segredos (<c>*_cifrado</c>) descem nulos até a entrega cifrada para o terminal (SYNC 20.2).</summary>
public class LojaRegistro : LinhaEspelho
{
    public short Codigo { get; set; }
    public string Nome { get; set; } = string.Empty;
    public string Tipo { get; set; } = string.Empty;
    public string RazaoSocial { get; set; } = string.Empty;
    public string NomeFantasia { get; set; } = string.Empty;
    public string Cnpj { get; set; } = string.Empty;
    public string? Ie { get; set; }
    public string? InscricaoMunicipal { get; set; }
    public string? Telefone { get; set; }
    public string? Celular { get; set; }
    public string? Email { get; set; }
    public Guid EstoqueId { get; set; }
    public string Cep { get; set; } = string.Empty;
    public string Logradouro { get; set; } = string.Empty;
    public string Numero { get; set; } = string.Empty;
    public string? Complemento { get; set; }
    public string Bairro { get; set; } = string.Empty;
    public int MunicipioIbge { get; set; }
    public string Uf { get; set; } = string.Empty;
    public string FusoHorario { get; set; } = string.Empty;
    public string? FraseRodapeCupom { get; set; }
    public int Ordem { get; set; }
    public bool Ativa { get; set; }
    public bool UsaPdv { get; set; }
    public bool UsaMenuDigital { get; set; }
    public string? ChavePublica { get; set; }
    public Guid? LogotipoArquivoId { get; set; }
    public Guid? FotoArquivoId { get; set; }
    public string? Regime { get; set; }
    public int? NfeSerie { get; set; }
    public short NfceAmbiente { get; set; }
    public string TipoEmissao { get; set; } = string.Empty;
    public string? CertificadoTipo { get; set; }
    public string? NfceCscId { get; set; }
    public byte[]? NfceCscCifrado { get; set; }
    public string? NfceCscHomologacaoId { get; set; }
    public byte[]? NfceCscHomologacaoCifrado { get; set; }
    public short? NfceQrcodeVersao { get; set; }
    public short NfcePrazoCancelamentoMin { get; set; }
    [Escala(2)] public decimal NfceValorExigeIdentificacao { get; set; }
    public byte[]? SatCodigoAtivacaoCifrado { get; set; }
    public string? TefProvedor { get; set; }
    public string? TefCodigoLoja { get; set; }
    public string? TefServidor { get; set; }
    public byte[]? TefTokenCifrado { get; set; }
    public string? TefCnpjCredenciadora { get; set; }
    public string? ChavePix { get; set; }
    public string? PixNomeRecebedor { get; set; }
    public string? PixCidadeRecebedor { get; set; }
}

/// <summary><c>lojas_banners</c>: Banners da tela de espera do PDV (<c>exibir_em = pdv_espera</c>).</summary>
public class LojaBannerRegistro : LinhaEspelho
{
    public Guid LojaId { get; set; }
    public Guid ArquivoId { get; set; }
    public string? Titulo { get; set; }
    public int Ordem { get; set; }
    public string ExibirEm { get; set; } = string.Empty;
    public DateTimeOffset? Inicio { get; set; }
    public DateTimeOffset? Fim { get; set; }
    public bool Ativo { get; set; }
}

/// <summary><c>numeracoes_faixas</c>: Faixas de numeração reservadas para este terminal (T).</summary>
public class NumeracaoFaixaRegistro : LinhaEspelhoSemAutoria
{
    public Guid NumeracaoId { get; set; }
    public Guid TerminalId { get; set; }
    public long Inicio { get; set; }
    public long Fim { get; set; }
    public string Status { get; set; } = string.Empty;
    public long? UltimoUsado { get; set; }
}

/// <summary><c>taxas_entrega</c>: Taxas de entrega da loja.</summary>
public class TaxaEntregaRegistro : LinhaEspelho
{
    public Guid LojaId { get; set; }
    public string Bairro { get; set; } = string.Empty;
    public int MunicipioIbge { get; set; }
    [Escala(2)] public decimal Valor { get; set; }
    public short? TempoEstimadoMin { get; set; }
    public bool Ativo { get; set; }
}

/// <summary><c>templates_documentos</c>: Templates impressos pelo PDV (cupom, vale, recibo de crediário).</summary>
public class TemplateDocumentoRegistro : LinhaEspelho
{
    public string Tipo { get; set; } = string.Empty;
    public string Nome { get; set; } = string.Empty;
    public string? Descricao { get; set; }
    public string? Assunto { get; set; }
    public string Formato { get; set; } = string.Empty;
    public string Conteudo { get; set; } = string.Empty;
    public Guid? LojaId { get; set; }
    public bool Padrao { get; set; }
    public bool Ativo { get; set; }
}

/// <summary><c>tipos_estoque</c>: Tipos de estoque (vendável, avaria…).</summary>
public class TipoEstoqueRegistro : LinhaEspelho
{
    public string Nome { get; set; } = string.Empty;
    public bool Vendavel { get; set; }
    public bool Padrao { get; set; }
    public bool Ativo { get; set; }
    public string? ChaveSistema { get; set; }
}
