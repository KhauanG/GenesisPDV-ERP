using GenesisPDV.Data.Convencoes;

namespace GenesisPDV.Data.Entidades;

// Tabelas espelho dos fluxos `catalogo` e `configuracao` usadas pela venda (modelo de dados 4.2, 6.1, 6.2): mesmo nome
// e mesmas colunas da nuvem, na projeção de 6.2 (colunas que não descem ficam fora). Somente leitura no PDV; sem FKs
// entre espelhos (fluxos diferentes chegam fora de ordem). Linhas com `excluido_em` continuam gravadas.

/// <summary>
/// Colunas comuns a todo espelho (datas, <c>versao</c> e <c>excluido_em</c>, MD 1.3), mais a coluna só local
/// <c>criado_localmente</c> (MD 4.2). As referências (<see cref="LinhaReferencia"/>) têm chave natural no lugar do
/// <c>id</c>.
/// </summary>
public abstract class LinhaVersionada
{
    public DateTimeOffset CriadoEm { get; set; }
    public DateTimeOffset AtualizadoEm { get; set; }
    public DateTimeOffset? ExcluidoEm { get; set; }

    /// <summary><c>INTEGER NOT NULL DEFAULT 0</c>: toda versão da nuvem é ≥ 1, então o pull sempre substitui a linha local.</summary>
    public long Versao { get; set; }

    /// <summary>Só local: linha criada por este terminal que também sobe por evento (MD 4.2). O pull nunca a sobrescreve.</summary>
    public bool CriadoLocalmente { get; set; }
}

/// <summary>Espelho com <c>id</c> e sem autoria (projeções P, como saldos e relevância de pessoas).</summary>
public abstract class LinhaEspelhoSemAutoria : LinhaVersionada
{
    public Guid Id { get; set; }
}

/// <summary>CP + AU das tabelas espelho (MD 1.3), mais <c>criado_localmente</c>.</summary>
public abstract class LinhaEspelho : LinhaEspelhoSemAutoria
{
    public Guid? CriadoPorId { get; set; }
    public Guid? AtualizadoPorId { get; set; }
}

/// <summary>Referência com chave natural (R: <c>ufs.sigla</c>, <c>ncms.codigo</c>…), sem <c>id</c> nem autoria.</summary>
public abstract class LinhaReferencia : LinhaVersionada
{
}

/// <summary><c>produtos</c> (3.6.3) sem custo, markup, descrição longa, material, busca, preços de canais digitais, dimensões, peso e rodízio.</summary>
public class ProdutoRegistro : LinhaEspelho
{
    public int Codigo { get; set; }
    public string Nome { get; set; } = string.Empty;
    public string Tipo { get; set; } = "simples";
    public bool Ativo { get; set; } = true;
    public string? CodigoInterno { get; set; }
    public Guid UnidadeId { get; set; }
    public Guid? UnidadeTributavelId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal? FatorTributavel { get; set; }
    public bool PermiteFracao { get; set; }
    public string? Ncm { get; set; }
    public string? Cest { get; set; }
    [Escala(Escalas.Preco)] public decimal PrecoVenda { get; set; }
    [Escala(Escalas.Preco)] public decimal? PrecoAtacado { get; set; }
    [Escala(Escalas.Quantidade)] public decimal? QtdMinimaAtacado { get; set; }
    [Escala(Escalas.Preco)] public decimal? PrecoPromocional { get; set; }
    public DateTimeOffset? PromocaoInicio { get; set; }
    public DateTimeOffset? PromocaoFim { get; set; }
    [Escala(Escalas.Preco)] public decimal? PrecoParcelado { get; set; }
    public Guid? GrupoPrecoQuantidadeId { get; set; }
    public bool UsaFichaTecnica { get; set; }
    public string? Localizacao { get; set; }
    public Guid? ImpressoraDestinoId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal? QtdMinimaVenda { get; set; }
    [Escala(Escalas.Percentual)] public decimal? ComissaoPct { get; set; }
    public Guid? MarcaId { get; set; }
    public Guid? CategoriaPrincipalId { get; set; }
    public bool SolicitaPrecoPdv { get; set; }
    public bool SolicitaLotePdv { get; set; }
    public bool Generico { get; set; }
    public bool UsaMenuDigital { get; set; }
    public bool Insumo { get; set; }
    public bool UsaTotem { get; set; }
    public bool MaisVendido { get; set; }
    public string? DescricaoCurta { get; set; }
    public Guid? FotoPrincipalArquivoId { get; set; }
    public bool ControlaEstoque { get; set; } = true;
    public short? IdadeMinima { get; set; }
    public Guid? VasilhameProdutoId { get; set; }
    public short? VasilhameQuantidade { get; set; }
    public string BalancaTipo { get; set; } = "nao_usa";
    public int? BalancaPlu { get; set; }
    public short? BalancaValidadeDias { get; set; }
    public string? CfopVendaEstado { get; set; }
    public string? CfopVendaForaEstado { get; set; }
    public string? IcmsSituacao { get; set; }
    public string? IcmsOrigem { get; set; }
    public string? IcmsModalidadeBc { get; set; }
    public string? IcmsModalidadeBcst { get; set; }
    [Escala(Escalas.Percentual)] public decimal? IcmsAliquota { get; set; }
    [Escala(Escalas.Percentual)] public decimal? IcmsReducaoBcPct { get; set; }
    [Escala(Escalas.Percentual)] public decimal? IcmsMvaPct { get; set; }
    [Escala(Escalas.Percentual)] public decimal? IcmsAliquotaSt { get; set; }
    [Escala(Escalas.Percentual)] public decimal? FcpAliquota { get; set; }
    [Escala(Escalas.Percentual)] public decimal? FcpStAliquota { get; set; }
    public string? BeneficioFiscalCodigo { get; set; }
    public string? PisSituacao { get; set; }
    public string? CofinsSituacao { get; set; }
    public string? IpiSituacao { get; set; }
    [Escala(Escalas.Percentual)] public decimal? PisAliquota { get; set; }
    [Escala(Escalas.Percentual)] public decimal? CofinsAliquota { get; set; }
    [Escala(Escalas.Percentual)] public decimal? IpiAliquota { get; set; }
    public string? IpiEnquadramento { get; set; }
    public string? IbsCbsCst { get; set; }
    public string? IbsCbsClassificacao { get; set; }
    public string? IsCst { get; set; }
    public string? IsClassificacao { get; set; }
    [Escala(Escalas.Percentual)] public decimal? IsAliquotaPct { get; set; }
    [Escala(Escalas.Preco)] public decimal? IsAliquotaEspecifica { get; set; }
    public string? IsUnidade { get; set; }
    public string? ServicoCodigoLc116 { get; set; }

    /// <summary>
    /// Campo calculado do pull (3.6.3; F2-B45, SYNC 6.12): caminho estável da foto (variante <c>pdv_256</c>). O PDV não
    /// segue o texto: tira o id e monta a rota ele mesmo (<c>CacheImagens</c>).
    /// </summary>
    public string? FotoUrl { get; set; }

    /// <summary>Campo calculado do pull: sha256 da variante, a chave do cache local de imagens.</summary>
    public string? FotoSha256 { get; set; }
}

/// <summary><c>produtos_codigos_barras</c> (3.6.5): EAN principal, embalagens (fardo/DUN-14) e códigos internos.</summary>
public class ProdutoCodigoBarrasRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public Guid? VariacaoId { get; set; }
    public string Codigo { get; set; } = string.Empty;
    public string Tipo { get; set; } = "gtin";
    public bool Principal { get; set; }
    public string? Descricao { get; set; }
    public Guid? UnidadeId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal Fator { get; set; } = 1m;
    [Escala(Escalas.Preco)] public decimal? Preco { get; set; }
    public bool UsaVenda { get; set; } = true;
    public bool UsaCompra { get; set; } = true;
}

/// <summary><c>produtos_lojas</c> (3.6.9) da loja do terminal, sem <c>estoque_maximo</c> e <c>st_nota_entrada_id</c>.</summary>
public class ProdutoLojaRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public Guid LojaId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal? EstoqueMinimo { get; set; }
    [Escala(Escalas.Preco)] public decimal? PrecoVenda { get; set; }
    [Escala(Escalas.Preco)] public decimal? AcrescimoGelada { get; set; }
    public bool AtivoNaLoja { get; set; } = true;
    [Escala(Escalas.Preco)] public decimal? StBcRetidoUnitario { get; set; }
    [Escala(Escalas.Percentual)] public decimal? StAliquotaPct { get; set; }
    [Escala(Escalas.Preco)] public decimal? StIcmsSubstitutoUnitario { get; set; }
    [Escala(Escalas.Preco)] public decimal? StIcmsRetidoUnitario { get; set; }
    [Escala(Escalas.Preco)] public decimal? FcpStBcRetidoUnitario { get; set; }
    [Escala(Escalas.Percentual)] public decimal? FcpStAliquotaPct { get; set; }
    [Escala(Escalas.Preco)] public decimal? FcpStRetidoUnitario { get; set; }
    public DateTimeOffset? StAtualizadoEm { get; set; }
}

/// <summary><c>produtos_precos_quantidade</c> (3.6.9): faixas do produto, da loja do terminal ou gerais.</summary>
public class ProdutoPrecoQuantidadeRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public Guid? VariacaoId { get; set; }
    public Guid? LojaId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal QuantidadeInicial { get; set; }
    [Escala(Escalas.Quantidade)] public decimal? QuantidadeFinal { get; set; }
    [Escala(Escalas.Preco)] public decimal Preco { get; set; }
}

/// <summary><c>grupos_preco_quantidade</c> (3.6.13): o "mix" do atacarejo.</summary>
public class GrupoPrecoQuantidadeRegistro : LinhaEspelho
{
    public int Codigo { get; set; }
    public string Nome { get; set; } = string.Empty;
    public string ModoPreco { get; set; } = "produto";
    public bool Ativo { get; set; } = true;
}

/// <summary><c>grupos_preco_quantidade_faixas</c> (3.6.13), da loja do terminal ou gerais.</summary>
public class GrupoPrecoQuantidadeFaixaRegistro : LinhaEspelho
{
    public Guid GrupoId { get; set; }
    public Guid? LojaId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal QuantidadeInicial { get; set; }
    [Escala(Escalas.Quantidade)] public decimal? QuantidadeFinal { get; set; }
    [Escala(Escalas.Preco)] public decimal Preco { get; set; }
}

/// <summary><c>produtos_componentes</c> (3.6.7): posições do combo (kit) e insumos da ficha técnica.</summary>
public class ProdutoComponenteRegistro : LinhaEspelho
{
    public Guid ProdutoId { get; set; }
    public string Tipo { get; set; } = "kit";
    public Guid ComponenteId { get; set; }
    public Guid? ComponenteVariacaoId { get; set; }
    [Escala(Escalas.Quantidade)] public decimal Quantidade { get; set; }
    [Escala(Escalas.Percentual)] public decimal PerdaPct { get; set; }
    public string? RotuloPosicao { get; set; }
    public bool PermiteSubstituicao { get; set; }
    public int Ordem { get; set; }
}

/// <summary><c>produtos_componentes_alternativas</c> (3.6.7): trocas permitidas numa posição do combo.</summary>
public class ProdutoComponenteAlternativaRegistro : LinhaEspelho
{
    public Guid ComponenteId { get; set; }
    public Guid ProdutoId { get; set; }
    public Guid? VariacaoId { get; set; }
    [Escala(Escalas.Preco)] public decimal Acrescimo { get; set; }
    public int Ordem { get; set; }
    public bool Ativo { get; set; } = true;
}

/// <summary><c>restricoes_horario_venda</c> (3.6.12), da loja do terminal ou gerais.</summary>
public class RestricaoHorarioVendaRegistro : LinhaEspelho
{
    public Guid? LojaId { get; set; }
    public Guid? CategoriaId { get; set; }
    public short? IdadeMinimaProduto { get; set; }

    /// <summary><c>smallint[]</c> da nuvem, gravado como JSON (<c>[0,6]</c>) em TEXT (MD 4.1, como <c>text[]</c>).</summary>
    public short[]? DiasSemana { get; set; }

    public TimeOnly HoraInicio { get; set; }
    public TimeOnly HoraFim { get; set; }
    public DateOnly? DataEspecifica { get; set; }
    public string Descricao { get; set; } = string.Empty;
    public bool Ativo { get; set; } = true;
}

/// <summary>
/// <c>formas_pagamento</c> (3.10.1) sem <c>conta_corrente_id</c>, <c>plano_contas_id</c> e <c>dias_recebimento</c> (6.2).
/// Desce só a forma que já valeu na loja do terminal; se vale aqui agora, quem diz é <see cref="FormaPagamentoLojaRegistro"/>.
/// </summary>
public class FormaPagamentoRegistro : LinhaEspelho
{
    public string Descricao { get; set; } = string.Empty;
    public int Ordem { get; set; }
    public string TipoForma { get; set; } = "dinheiro";
    public string MeioPagamentoFiscal { get; set; } = "01";
    public string? DescricaoFiscal { get; set; }
    public string Integracao { get; set; } = "nenhuma";
    public string? TipoPinpad { get; set; }
    [Escala(Escalas.Percentual)] public decimal TaxaPct { get; set; }
    public string? SenhaLiberacaoHash { get; set; }
    public bool SempreZeradoPdv { get; set; }
    public bool LancaQuitada { get; set; }
    public bool PermiteTroco { get; set; }
    public bool EBoleto { get; set; }
    public bool ExigePessoa { get; set; }
    public bool Ativa { get; set; } = true;
    public bool AbrirGaveta { get; set; }
    public bool UsaPdv { get; set; } = true;
    public bool UsaTotem { get; set; }
    public bool UsaMenuDigital { get; set; }
    public bool CreditoFuncionario { get; set; }
    public bool PermiteParcelar { get; set; }
    public short ParcelasMaximo { get; set; } = 1;
    [Escala(Escalas.Dinheiro)] public decimal? ParcelaValorMinimo { get; set; }
    public bool GeraQrcodePix { get; set; }
    public bool APrazo { get; set; }
    public bool ValeCompra { get; set; }
    public bool ExigeDadosPos { get; set; }
    public bool RestringeIdadeMinima { get; set; }

    /// <summary>O caixa pede a liberação de um supervisor (PIN, PDV 31.3) para lançar a forma (Fase 1C, C8b).</summary>
    public bool ExigeSupervisor { get; set; }
}

/// <summary>
/// <c>formas_pagamento_lojas</c> (3.10.1; Fase 1C, C8b): lojas em que a forma vale. Descem as linhas de "todas"
/// (<c>loja_id</c> nulo) e as da loja do terminal, vivas ou excluídas; a forma é oferecida no caixa com uma linha viva
/// (<c>CatalogoLocal.FormasPagamentoAsync</c>). A exclusão que desce (loja tirada da forma, ou "todas" trocada por lojas
/// escolhidas) tira a forma deste caixa sem apagar a linha da forma, que as vendas antigas citam.
/// </summary>
public class FormaPagamentoLojaRegistro : LinhaEspelho
{
    public Guid FormaPagamentoId { get; set; }
    public Guid? LojaId { get; set; }
}

/// <summary><c>unidades_medida</c> (3.4.1).</summary>
public class UnidadeMedidaRegistro : LinhaEspelho
{
    public string Sigla { get; set; } = string.Empty;
    public string Descricao { get; set; } = string.Empty;
    public bool PermiteFracao { get; set; }
    public bool Sistema { get; set; }
    public bool Ativo { get; set; } = true;
}

/// <summary>
/// <c>configuracoes</c> (3.1.1, fluxo <c>configuracao</c>): só as chaves marcadas PDV, da empresa e da loja do terminal
/// (MD 6.2). Só existem linhas para valores diferentes do padrão do catálogo de chaves; a da loja prevalece.
/// <c>valor_cifrado</c> desce nulo até a cifra para o terminal existir (MD 1.10).
/// </summary>
public class ConfiguracaoRegistro : LinhaEspelho
{
    public string Escopo { get; set; } = "empresa";
    public Guid? LojaId { get; set; }
    public string Chave { get; set; } = string.Empty;

    /// <summary><c>jsonb</c> da nuvem, gravado como TEXT JSON (<c>true</c>, <c>"texto"</c>, <c>12</c>).</summary>
    public string? Valor { get; set; }

    public byte[]? ValorCifrado { get; set; }
    public DateTimeOffset? SegredoDefinidoEm { get; set; }
}
