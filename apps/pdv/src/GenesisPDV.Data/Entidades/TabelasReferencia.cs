using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas espelho do fluxo `referencia` (MD 6.1, 6.2): referências fiscais nacionais e da UF da loja.
// Mesmo nome e mesmas colunas da nuvem na projeção do pull (colunas que não descem ficam fora; `EsquemaNuvemTests`
// confere contra o Esquema.g.cs gerado). Somente leitura no PDV: o aplicador do pull grava por SQL.

/// <summary><c>cfops</c>: CFOP.</summary>
public class CfopRegistro : LinhaReferencia
{
    public string Codigo { get; set; } = string.Empty;
    public string Descricao { get; set; } = string.Empty;
    public string Tipo { get; set; } = string.Empty;
    public string Abrangencia { get; set; } = string.Empty;
    public bool Ativo { get; set; }
}

/// <summary><c>cfops_grupos</c>: Grupos de CFOP.</summary>
public class CfopGrupoRegistro : LinhaEspelho
{
    public string Grupo { get; set; } = string.Empty;
    public string Cfop { get; set; } = string.Empty;
    public bool Padrao { get; set; }
    public int Ordem { get; set; }
}

/// <summary><c>meios_pagamento_fiscais</c>: Meios de pagamento da NFC-e (tPag).</summary>
public class MeioPagamentoFiscalRegistro : LinhaReferencia
{
    public string Codigo { get; set; } = string.Empty;
    public string Descricao { get; set; } = string.Empty;
    public bool ExigeDescricao { get; set; }
    public bool Ativo { get; set; }
}

/// <summary><c>municipios</c>: Municípios (IBGE).</summary>
public class MunicipioRegistro : LinhaReferencia
{
    public int CodigoIbge { get; set; }
    public string Nome { get; set; } = string.Empty;
    public string Uf { get; set; } = string.Empty;
}

/// <summary><c>ncms</c>: NCM (tabela oficial).</summary>
public class NcmRegistro : LinhaReferencia
{
    public string Codigo { get; set; } = string.Empty;
    public string Descricao { get; set; } = string.Empty;
    public DateOnly? VigenciaInicio { get; set; }
    public DateOnly? VigenciaFim { get; set; }
    public string? UnidadeTributavel { get; set; }
}

/// <summary><c>paises</c>: Países (BACEN).</summary>
public class PaisRegistro : LinhaReferencia
{
    public string CodigoBacen { get; set; } = string.Empty;
    public string Nome { get; set; } = string.Empty;
}

/// <summary><c>parametros_fiscais_uf</c>: Parâmetros fiscais da UF da loja (vigência atual e futuras: o PDV escolhe a vigente).</summary>
public class ParametroFiscalUfRegistro : LinhaEspelhoSemAutoria
{
    public string Uf { get; set; } = string.Empty;
    public DateOnly VigenciaInicio { get; set; }
    public DateOnly? VigenciaFim { get; set; }
    public string[] TiposEmissaoPermitidos { get; set; } = [];
    public string[] RegimesDispensadosNfce { get; set; } = [];
    public string Autorizador { get; set; } = string.Empty;
    public string VersaoLeiaute { get; set; } = string.Empty;
    public string? Webservices { get; set; }
    public string UrlQrcodeProducao { get; set; } = string.Empty;
    public string UrlQrcodeHomologacao { get; set; } = string.Empty;
    public string UrlConsultaProducao { get; set; } = string.Empty;
    public string UrlConsultaHomologacao { get; set; } = string.Empty;
    public short[] QrcodeVersoesAceitas { get; set; } = [];
    public short QrcodeVersaoPadrao { get; set; }
    public short? CscMaxAtivosPorAmbiente { get; set; }
    public bool CscPorCnpjBase { get; set; }
    public short PrazoCancelamentoMin { get; set; }
    public short PrazoCancelamentoSubstituicaoH { get; set; }
    public bool? AceitaCancelamentoExtemporaneo { get; set; }
    public short PrazoTransmissaoContingenciaH { get; set; }
    public short[] ModalidadesContingenciaNfce { get; set; } = [];
    public short ContingenciaViasDanfe { get; set; }
    public short InutilizacaoPrazoDia { get; set; }
    [Escala(2)] public decimal IdentificacaoObrigatoriaValor { get; set; }
    public bool IdentificacaoObrigatoriaNaoPresencial { get; set; }
    [Escala(2)] public decimal? NfceValorMaximo { get; set; }
    public string[] DanfeModosPermitidos { get; set; } = [];
    public bool DanfeResumidoExigeConcordancia { get; set; }
    public string? ProgramaCidadania { get; set; }
    public bool? ProgramaCidadaniaSubstituiDanfe { get; set; }
    public int? IntervaloMinimoStatusS { get; set; }
    public short AtrasoMaxEmissaoMin { get; set; }
    public string? FcpNome { get; set; }
    public bool ExigeStRetidoNfce { get; set; }
    public bool ExigeVinculacaoPagamento { get; set; }
    public bool ExigeCbenef { get; set; }
    public bool ExigeCestBemListado { get; set; }
    public bool ExigeRespTec { get; set; }
    public bool ExigeCsrtNfce { get; set; }
    public DateOnly? ConferidoEm { get; set; }
}

/// <summary><c>ufs</c>: UFs.</summary>
public class UfRegistro : LinhaReferencia
{
    public string Sigla { get; set; } = string.Empty;
    public short CodigoIbge { get; set; }
    public string Nome { get; set; } = string.Empty;
}
