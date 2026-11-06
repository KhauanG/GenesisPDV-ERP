/**
 * MD 3.6 – produtos e cadastros do catálogo (fluxo `catalogo` do pull): marcas, categorias, produtos, códigos de barras
 * (embalagem/fardo com fator e preço), variações, combo/kit e ficha técnica (posições e alternativas), preços por
 * quantidade, grupos de preço por quantidade (mix), dados por loja e por UF, lotes, fornecedores, imagens, histórico de
 * preços e restrições de horário de venda.
 *
 * Índices únicos com `nulls not distinct`, as restrições `exclude using gist` (faixas sem sobreposição), os triggers de
 * versão, de coluna de filtro imutável, de EAN único e de composição sem ciclo ficam na migração customizada.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { colunasAutoria, colunasLog, colunasPadrao, timestamptz } from '../../colunas.js';
import { estoques, impressorasDestino, lojas } from './estrutura.js';
import { pessoas } from './pessoas.js';
import { cfops, ufs, unidadesMedida } from './referencias.js';
import { arquivos } from './sistema.js';

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));
const preco = (nome: string) => numeric(nome, { precision: 15, scale: 4 });
const quantidade = (nome: string) => numeric(nome, { precision: 15, scale: 3 });
const percentual = (nome: string) => numeric(nome, { precision: 7, scale: 4 });

export const marcas = pgTable(
  'marcas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_marcas')`),
    descricao: varchar('descricao', { length: 60 }).notNull(),
    semMarca: boolean('sem_marca').notNull().default(false),
    exibeSite: boolean('exibe_site').notNull().default(false),
    ordem: integer('ordem').notNull().default(0),
    logotipoArquivoId: uuid('logotipo_arquivo_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_marcas', columns: [t.id] }),
    foreignKey({
      name: 'fk_marcas_logotipo_arquivo_id',
      columns: [t.logotipoArquivoId],
      foreignColumns: [arquivos.id],
    }),
    uniqueIndex('uq_marcas_codigo').on(t.codigo),
    uniqueIndex('uq_marcas_descricao')
      .on(sql`lower(fn_unaccent(descricao))`)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_marcas_sem_marca')
      .on(t.semMarca)
      .where(sql`sem_marca and excluido_em is null`),
    index('ix_marcas_logotipo_arquivo_id').on(t.logotipoArquivoId),
  ],
);

export const categorias = pgTable(
  'categorias',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    nome: varchar('nome', { length: 60 }).notNull(),
    categoriaPaiId: uuid('categoria_pai_id'),
    caminho: text('caminho').notNull(),
    caminhoNomes: text('caminho_nomes').notNull(),
    nivel: smallint('nivel').notNull().default(1),
    ordem: integer('ordem').notNull().default(0),
    ativa: boolean('ativa').notNull().default(true),
    exibePdv: boolean('exibe_pdv').notNull().default(true),
    exibeMenuDigital: boolean('exibe_menu_digital').notNull().default(false),
    exibeTotem: boolean('exibe_totem').notNull().default(false),
    exibeSite: boolean('exibe_site').notNull().default(false),
    imagemArquivoId: uuid('imagem_arquivo_id'),
    cor: varchar('cor', { length: 7 }),
  },
  (t) => [
    primaryKey({ name: 'pk_categorias', columns: [t.id] }),
    foreignKey({
      name: 'fk_categorias_categoria_pai_id',
      columns: [t.categoriaPaiId],
      foreignColumns: [t.id],
    }),
    foreignKey({
      name: 'fk_categorias_imagem_arquivo_id',
      columns: [t.imagemArquivoId],
      foreignColumns: [arquivos.id],
    }),
    // uq_categorias_nome_irmaos (nulls not distinct) fica na migração customizada; começa por categoria_pai_id.
    index('ix_categorias_categoria_pai_id').on(t.categoriaPaiId),
    index('ix_categorias_caminho').on(sql`caminho text_pattern_ops`),
    index('ix_categorias_imagem_arquivo_id').on(t.imagemArquivoId),
    check('ck_categorias_nivel', sql`nivel between 1 and 5`),
    check('ck_categorias_pai', sql`categoria_pai_id is distinct from id`),
    check('ck_categorias_cor', sql`cor is null or cor ~ '^#[0-9A-Fa-f]{6}$'`),
  ],
);

/** Grupo de preço por quantidade ("mix" do atacarejo, MD 3.6.13). Não é o "grupo de itens" do Nuvem3 (= kit). */
export const gruposPrecoQuantidade = pgTable(
  'grupos_preco_quantidade',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_grupos_preco_quantidade')`),
    nome: varchar('nome', { length: 60 }).notNull(),
    modoPreco: varchar('modo_preco', { length: 8 }).notNull().default('produto'),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_grupos_preco_quantidade', columns: [t.id] }),
    uniqueIndex('uq_grupos_preco_quantidade_codigo').on(t.codigo),
    uniqueIndex('uq_grupos_preco_quantidade_nome')
      .on(sql`lower(fn_unaccent(nome))`)
      .where(sql`excluido_em is null`),
    check('ck_grupos_preco_quantidade_modo_preco', sql`modo_preco in ('produto','grupo')`),
  ],
);

/** Faixas do grupo `modo_preco = 'grupo'`; sem sobreposição por (grupo, loja) via `exclude` na migração. */
export const gruposPrecoQuantidadeFaixas = pgTable(
  'grupos_preco_quantidade_faixas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    grupoId: uuid('grupo_id').notNull(),
    lojaId: uuid('loja_id'),
    quantidadeInicial: quantidade('quantidade_inicial').notNull(),
    quantidadeFinal: quantidade('quantidade_final'),
    preco: preco('preco').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_grupos_preco_quantidade_faixas', columns: [t.id] }),
    foreignKey({
      name: 'fk_grupos_preco_quantidade_faixas_grupo_id',
      columns: [t.grupoId],
      foreignColumns: [gruposPrecoQuantidade.id],
    }),
    foreignKey({
      name: 'fk_grupos_preco_quantidade_faixas_loja_id',
      columns: [t.lojaId],
      foreignColumns: [lojas.id],
    }),
    index('ix_grupos_preco_quantidade_faixas_grupo_id').on(t.grupoId),
    index('ix_grupos_preco_quantidade_faixas_loja_id').on(t.lojaId),
    check(
      'ck_grupos_preco_quantidade_faixas_valores',
      sql`quantidade_inicial > 0 and (quantidade_final is null or quantidade_final > quantidade_inicial) and preco >= 0`,
    ),
  ],
);

export const TIPOS_PRODUTO = [
  'simples',
  'com_variacoes',
  'kit',
  'com_complementos',
  'materia_prima',
  'servico',
  'produzido',
  'vasilhame',
] as const;

export const produtos = pgTable(
  'produtos',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    // Cabeçalho
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_produtos')`),
    nome: varchar('nome', { length: 120 }).notNull(),
    tipo: varchar('tipo', { length: 18 }).notNull().default('simples'),
    ativo: boolean('ativo').notNull().default(true),
    codigoInterno: varchar('codigo_interno', { length: 30 }),
    unidadeId: uuid('unidade_id').notNull(),
    unidadeTributavelId: uuid('unidade_tributavel_id'),
    fatorTributavel: quantidade('fator_tributavel'),
    permiteFracao: boolean('permite_fracao').notNull().default(false),
    // Sem FK de propósito (MD 3.6.3): o relatório "NCMs inválidos" precisa ver códigos que saíram da tabela.
    ncm: varchar('ncm', { length: 8 }),
    cest: varchar('cest', { length: 7 }),
    precoCusto: preco('preco_custo').notNull().default('0'),
    custoMedio: preco('custo_medio').notNull().default('0'),
    markupPct: numeric('markup_pct', { precision: 9, scale: 4 }).notNull().default('0'),
    precoVenda: preco('preco_venda').notNull().default('0'),
    // Preços complementares
    precoAtacado: preco('preco_atacado'),
    qtdMinimaAtacado: quantidade('qtd_minima_atacado'),
    precoPromocional: preco('preco_promocional'),
    promocaoInicio: timestamptz('promocao_inicio'),
    promocaoFim: timestamptz('promocao_fim'),
    precoMenuDigital: preco('preco_menu_digital'),
    precoIfood: preco('preco_ifood'),
    precoParcelado: preco('preco_parcelado'),
    grupoPrecoQuantidadeId: uuid('grupo_preco_quantidade_id'),
    // Ficha técnica
    usaFichaTecnica: boolean('usa_ficha_tecnica').notNull().default(false),
    // Dimensões e peso
    larguraCm: numeric('largura_cm', { precision: 10, scale: 2 }),
    alturaCm: numeric('altura_cm', { precision: 10, scale: 2 }),
    profundidadeCm: numeric('profundidade_cm', { precision: 10, scale: 2 }),
    pesoG: numeric('peso_g', { precision: 12, scale: 3 }),
    pesoAbatimentoG: numeric('peso_abatimento_g', { precision: 12, scale: 3 }),
    pesoPacoteKg: numeric('peso_pacote_kg', { precision: 12, scale: 3 }),
    // Outras informações
    localizacao: varchar('localizacao', { length: 40 }),
    impressoraDestinoId: uuid('impressora_destino_id'),
    qtdMinimaVenda: quantidade('qtd_minima_venda'),
    material: varchar('material', { length: 60 }),
    comissaoPct: percentual('comissao_pct'),
    marcaId: uuid('marca_id'),
    categoriaPrincipalId: uuid('categoria_principal_id'),
    solicitaPrecoPdv: boolean('solicita_preco_pdv').notNull().default(false),
    solicitaLotePdv: boolean('solicita_lote_pdv').notNull().default(false),
    generico: boolean('generico').notNull().default(false),
    usaMenuDigital: boolean('usa_menu_digital').notNull().default(false),
    insumo: boolean('insumo').notNull().default(false),
    reposicaoRodizio: boolean('reposicao_rodizio').notNull().default(false),
    usaTotem: boolean('usa_totem').notNull().default(false),
    maisVendido: boolean('mais_vendido').notNull().default(false),
    descricaoCurta: varchar('descricao_curta', { length: 250 }),
    descricaoLonga: text('descricao_longa'),
    fotoPrincipalArquivoId: uuid('foto_principal_arquivo_id'),
    controlaEstoque: boolean('controla_estoque').notNull().default(true),
    idadeMinima: smallint('idade_minima'),
    vasilhameProdutoId: uuid('vasilhame_produto_id'),
    vasilhameQuantidade: smallint('vasilhame_quantidade'),
    // Balança
    balancaTipo: varchar('balanca_tipo', { length: 8 }).notNull().default('nao_usa'),
    balancaPlu: integer('balanca_plu'),
    balancaValidadeDias: smallint('balanca_validade_dias'),
    // Tributação (nula = padrão de Configurações › Tributação, exceto NCM e CFOP: MD 3.6.3)
    cfopVendaEstado: varchar('cfop_venda_estado', { length: 4 }),
    cfopVendaForaEstado: varchar('cfop_venda_fora_estado', { length: 4 }),
    icmsSituacao: varchar('icms_situacao', { length: 3 }),
    icmsOrigem: char('icms_origem', { length: 1 }),
    icmsModalidadeBc: char('icms_modalidade_bc', { length: 1 }),
    icmsModalidadeBcst: char('icms_modalidade_bcst', { length: 1 }),
    icmsAliquota: percentual('icms_aliquota'),
    icmsReducaoBcPct: percentual('icms_reducao_bc_pct'),
    icmsMvaPct: percentual('icms_mva_pct'),
    icmsAliquotaSt: percentual('icms_aliquota_st'),
    fcpAliquota: percentual('fcp_aliquota'),
    fcpStAliquota: percentual('fcp_st_aliquota'),
    beneficioFiscalCodigo: varchar('beneficio_fiscal_codigo', { length: 10 }),
    pisSituacao: varchar('pis_situacao', { length: 2 }),
    cofinsSituacao: varchar('cofins_situacao', { length: 2 }),
    ipiSituacao: varchar('ipi_situacao', { length: 2 }),
    pisAliquota: percentual('pis_aliquota'),
    cofinsAliquota: percentual('cofins_aliquota'),
    ipiAliquota: percentual('ipi_aliquota'),
    ipiEnquadramento: varchar('ipi_enquadramento', { length: 3 }),
    // FKs para cst_ibs_cbs/classificacoes_tributarias_ibs_cbs entram com as tabelas da Reforma (fase fiscal).
    ibsCbsCst: varchar('ibs_cbs_cst', { length: 3 }),
    ibsCbsClassificacao: varchar('ibs_cbs_classificacao', { length: 6 }),
    isCst: varchar('is_cst', { length: 3 }),
    isClassificacao: varchar('is_classificacao', { length: 6 }),
    isAliquotaPct: percentual('is_aliquota_pct'),
    isAliquotaEspecifica: preco('is_aliquota_especifica'),
    isUnidade: varchar('is_unidade', { length: 6 }),
    servicoCodigoLc116: varchar('servico_codigo_lc116', { length: 5 }),
    busca: text('busca').notNull().default(''),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_unidade_id',
      columns: [t.unidadeId],
      foreignColumns: [unidadesMedida.id],
    }),
    foreignKey({
      name: 'fk_produtos_unidade_tributavel_id',
      columns: [t.unidadeTributavelId],
      foreignColumns: [unidadesMedida.id],
    }),
    foreignKey({
      name: 'fk_produtos_impressora_destino_id',
      columns: [t.impressoraDestinoId],
      foreignColumns: [impressorasDestino.id],
    }),
    foreignKey({ name: 'fk_produtos_marca_id', columns: [t.marcaId], foreignColumns: [marcas.id] }),
    foreignKey({
      name: 'fk_produtos_categoria_principal_id',
      columns: [t.categoriaPrincipalId],
      foreignColumns: [categorias.id],
    }),
    foreignKey({
      name: 'fk_produtos_cfop_venda_estado',
      columns: [t.cfopVendaEstado],
      foreignColumns: [cfops.codigo],
    }),
    foreignKey({
      name: 'fk_produtos_cfop_venda_fora_estado',
      columns: [t.cfopVendaForaEstado],
      foreignColumns: [cfops.codigo],
    }),
    foreignKey({
      name: 'fk_produtos_foto_principal_arquivo_id',
      columns: [t.fotoPrincipalArquivoId],
      foreignColumns: [arquivos.id],
    }),
    foreignKey({
      name: 'fk_produtos_grupo_preco_quantidade_id',
      columns: [t.grupoPrecoQuantidadeId],
      foreignColumns: [gruposPrecoQuantidade.id],
    }),
    foreignKey({
      name: 'fk_produtos_vasilhame_produto_id',
      columns: [t.vasilhameProdutoId],
      foreignColumns: [t.id],
    }),
    uniqueIndex('uq_produtos_codigo').on(t.codigo),
    uniqueIndex('uq_produtos_codigo_interno')
      .on(sql`lower(codigo_interno)`)
      .where(sql`codigo_interno is not null and excluido_em is null`),
    uniqueIndex('uq_produtos_balanca_plu')
      .on(t.balancaPlu)
      .where(sql`balanca_plu is not null and excluido_em is null`),
    index('ix_produtos_busca').using('gin', sql`busca gin_trgm_ops`),
    index('ix_produtos_ncm').on(t.ncm),
    index('ix_produtos_unidade_id').on(t.unidadeId),
    index('ix_produtos_unidade_tributavel_id').on(t.unidadeTributavelId),
    index('ix_produtos_impressora_destino_id').on(t.impressoraDestinoId),
    index('ix_produtos_marca_id').on(t.marcaId),
    index('ix_produtos_categoria_principal_id').on(t.categoriaPrincipalId),
    index('ix_produtos_cfop_venda_estado').on(t.cfopVendaEstado),
    index('ix_produtos_cfop_venda_fora_estado').on(t.cfopVendaForaEstado),
    index('ix_produtos_foto_principal_arquivo_id').on(t.fotoPrincipalArquivoId),
    index('ix_produtos_grupo_preco_quantidade_id')
      .on(t.grupoPrecoQuantidadeId)
      .where(sql`grupo_preco_quantidade_id is not null`),
    index('ix_produtos_vasilhame_produto_id')
      .on(t.vasilhameProdutoId)
      .where(sql`vasilhame_produto_id is not null`),
    check('ck_produtos_tipo', sql`tipo in (${listaSql(TIPOS_PRODUTO)})`),
    check('ck_produtos_balanca_tipo', sql`balanca_tipo in ('nao_usa','peso','unidade')`),
    check('ck_produtos_balanca_plu', sql`balanca_plu is null or balanca_plu between 1 and 999999`),
    check(
      'ck_produtos_precos',
      sql`preco_custo >= 0 and custo_medio >= 0 and preco_venda >= 0 and coalesce(preco_atacado, 0) >= 0 and coalesce(preco_promocional, 0) >= 0 and coalesce(preco_menu_digital, 0) >= 0 and coalesce(preco_ifood, 0) >= 0 and coalesce(preco_parcelado, 0) >= 0`,
    ),
    check('ck_produtos_ncm', sql`ncm is null or ncm ~ '^[0-9]{8}$'`),
    check('ck_produtos_cest', sql`cest is null or cest ~ '^[0-9]{7}$'`),
    check('ck_produtos_icms_origem', sql`icms_origem is null or icms_origem ~ '^[0-8]$'`),
    check(
      'ck_produtos_icms_modalidades',
      sql`(icms_modalidade_bc is null or icms_modalidade_bc ~ '^[0-3]$') and (icms_modalidade_bcst is null or icms_modalidade_bcst ~ '^[0-6]$')`,
    ),
    check(
      'ck_produtos_promocao',
      sql`promocao_fim is null or promocao_inicio is null or promocao_fim > promocao_inicio`,
    ),
    check('ck_produtos_servico_sem_estoque', sql`tipo <> 'servico' or not controla_estoque`),
    check('ck_produtos_ficha_tecnica', sql`tipo <> 'produzido' or usa_ficha_tecnica`),
    check(
      'ck_produtos_grupo_preco_tipo',
      sql`grupo_preco_quantidade_id is null or tipo in ('simples','com_variacoes','produzido')`,
    ),
    check(
      'ck_produtos_vasilhame',
      sql`(vasilhame_produto_id is null) = (vasilhame_quantidade is null) and (vasilhame_quantidade is null or vasilhame_quantidade > 0) and (vasilhame_produto_id is null or tipo <> 'vasilhame')`,
    ),
    check('ck_produtos_is', sql`is_aliquota_especifica is null or is_unidade is not null`),
    check(
      'ck_produtos_fcp',
      sql`(fcp_aliquota is null or fcp_aliquota between 0 and 100) and (fcp_st_aliquota is null or fcp_st_aliquota between 0 and 100)`,
    ),
    check('ck_produtos_idade_minima', sql`idade_minima is null or idade_minima between 1 and 99`),
    check(
      'ck_produtos_quantidades',
      sql`(qtd_minima_atacado is null or qtd_minima_atacado > 0) and (qtd_minima_venda is null or qtd_minima_venda > 0) and (fator_tributavel is null or fator_tributavel > 0)`,
    ),
  ],
);

export const produtosCategorias = pgTable(
  'produtos_categorias',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    categoriaId: uuid('categoria_id').notNull(),
    principal: boolean('principal').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_categorias', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_categorias_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_categorias_categoria_id',
      columns: [t.categoriaId],
      foreignColumns: [categorias.id],
    }),
    uniqueIndex('uq_produtos_categorias')
      .on(t.produtoId, t.categoriaId)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_produtos_categorias_principal')
      .on(t.produtoId)
      .where(sql`principal and excluido_em is null`),
    index('ix_produtos_categorias_produto_id').on(t.produtoId),
    index('ix_produtos_categorias_categoria_id').on(t.categoriaId),
  ],
);

// ---------------------------------------------------------------- Variações (MD 3.6.6)

export const atributosVariacao = pgTable(
  'atributos_variacao',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    nome: varchar('nome', { length: 30 }).notNull(),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_atributos_variacao', columns: [t.id] }),
    uniqueIndex('uq_atributos_variacao_nome')
      .on(sql`lower(nome)`)
      .where(sql`excluido_em is null`),
  ],
);

export const atributosVariacaoValores = pgTable(
  'atributos_variacao_valores',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    atributoId: uuid('atributo_id').notNull(),
    valor: varchar('valor', { length: 40 }).notNull(),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_atributos_variacao_valores', columns: [t.id] }),
    foreignKey({
      name: 'fk_atributos_variacao_valores_atributo_id',
      columns: [t.atributoId],
      foreignColumns: [atributosVariacao.id],
    }),
    uniqueIndex('uq_atributos_variacao_valores')
      .on(t.atributoId, sql`lower(valor)`)
      .where(sql`excluido_em is null`),
    index('ix_atributos_variacao_valores_atributo_id').on(t.atributoId),
  ],
);

export const produtosVariacoes = pgTable(
  'produtos_variacoes',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    nome: varchar('nome', { length: 120 }).notNull(),
    codigoInterno: varchar('codigo_interno', { length: 30 }),
    precoVenda: preco('preco_venda'),
    precoCusto: preco('preco_custo'),
    ativo: boolean('ativo').notNull().default(true),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_variacoes', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_variacoes_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    uniqueIndex('uq_produtos_variacoes_codigo_interno')
      .on(sql`lower(codigo_interno)`)
      .where(sql`codigo_interno is not null and excluido_em is null`),
    index('ix_produtos_variacoes_produto_id').on(t.produtoId),
    check(
      'ck_produtos_variacoes_precos',
      sql`coalesce(preco_venda, 0) >= 0 and coalesce(preco_custo, 0) >= 0`,
    ),
  ],
);

export const produtosVariacoesValores = pgTable(
  'produtos_variacoes_valores',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    variacaoId: uuid('variacao_id').notNull(),
    atributoValorId: uuid('atributo_valor_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_variacoes_valores', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_variacoes_valores_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_produtos_variacoes_valores_atributo_valor_id',
      columns: [t.atributoValorId],
      foreignColumns: [atributosVariacaoValores.id],
    }),
    uniqueIndex('uq_produtos_variacoes_valores')
      .on(t.variacaoId, t.atributoValorId)
      .where(sql`excluido_em is null`),
    index('ix_produtos_variacoes_valores_variacao_id').on(t.variacaoId),
    index('ix_produtos_variacoes_valores_atributo_valor_id').on(t.atributoValorId),
  ],
);

/**
 * MD 3.6.5: todos os códigos de barras do produto/variação (EAN principal, embalagem/fardo com `fator` e `preco`,
 * códigos internos). O índice de busca não é único (a migração do Nuvem3 traz duplicados); a regra "EAN único entre
 * produtos" (`geral.ean_duplicado`) é o trigger `tg_produtos_codigos_barras_ean_unico` da migração customizada.
 */
export const produtosCodigosBarras = pgTable(
  'produtos_codigos_barras',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    codigo: varchar('codigo', { length: 30 }).notNull(),
    tipo: varchar('tipo', { length: 10 }).notNull().default('gtin'),
    principal: boolean('principal').notNull().default(false),
    descricao: varchar('descricao', { length: 40 }),
    unidadeId: uuid('unidade_id'),
    fator: quantidade('fator').notNull().default('1'),
    preco: preco('preco'),
    usaVenda: boolean('usa_venda').notNull().default(true),
    usaCompra: boolean('usa_compra').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_codigos_barras', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_codigos_barras_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_codigos_barras_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_produtos_codigos_barras_unidade_id',
      columns: [t.unidadeId],
      foreignColumns: [unidadesMedida.id],
    }),
    index('ix_produtos_codigos_barras_codigo')
      .on(t.codigo)
      .where(sql`excluido_em is null`),
    index('ix_produtos_codigos_barras_variacao_id').on(t.variacaoId),
    index('ix_produtos_codigos_barras_unidade_id').on(t.unidadeId),
    check('ck_produtos_codigos_barras_tipo', sql`tipo in ('gtin','interno')`),
    check('ck_produtos_codigos_barras_fator', sql`fator > 0`),
    check('ck_produtos_codigos_barras_gtin', sql`tipo <> 'gtin' or codigo ~ '^([0-9]{8}|[0-9]{12,14})$'`),
    check('ck_produtos_codigos_barras_preco', sql`preco is null or preco >= 0`),
  ],
);

// ---------------------------------------------------------------- Combo (kit) e ficha técnica (MD 3.6.7)

export const produtosComponentes = pgTable(
  'produtos_componentes',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    tipo: varchar('tipo', { length: 14 }).notNull(),
    componenteId: uuid('componente_id').notNull(),
    componenteVariacaoId: uuid('componente_variacao_id'),
    quantidade: quantidade('quantidade').notNull(),
    perdaPct: percentual('perda_pct').notNull().default('0'),
    rotuloPosicao: varchar('rotulo_posicao', { length: 40 }),
    permiteSubstituicao: boolean('permite_substituicao').notNull().default(false),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_componentes', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_componentes_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_componentes_componente_id',
      columns: [t.componenteId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_componentes_componente_variacao_id',
      columns: [t.componenteVariacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    // uq_produtos_componentes_ficha_tecnica (nulls not distinct, só ficha técnica) fica na migração customizada.
    index('ix_produtos_componentes_produto_id').on(t.produtoId),
    index('ix_produtos_componentes_componente_id').on(t.componenteId),
    index('ix_produtos_componentes_componente_variacao_id').on(t.componenteVariacaoId),
    check('ck_produtos_componentes_tipo', sql`tipo in ('kit','ficha_tecnica')`),
    check('ck_produtos_componentes_quantidade', sql`quantidade > 0`),
    check(
      'ck_produtos_componentes_perda',
      sql`perda_pct between 0 and 100 and (tipo = 'ficha_tecnica' or perda_pct = 0)`,
    ),
    check(
      'ck_produtos_componentes_kit',
      sql`tipo = 'kit' or (not permite_substituicao and rotulo_posicao is null)`,
    ),
    check('ck_produtos_componentes_ciclo_direto', sql`componente_id <> produto_id`),
  ],
);

/** Alternativas de uma posição do combo, com acréscimo opcional no preço de 1 combo (MD 3.6.7). */
export const produtosComponentesAlternativas = pgTable(
  'produtos_componentes_alternativas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    componenteId: uuid('componente_id').notNull(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    acrescimo: preco('acrescimo').notNull().default('0'),
    ordem: integer('ordem').notNull().default(0),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_componentes_alternativas', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_componentes_alternativas_componente_id',
      columns: [t.componenteId],
      foreignColumns: [produtosComponentes.id],
    }),
    foreignKey({
      name: 'fk_produtos_componentes_alternativas_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_componentes_alternativas_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    // uq_produtos_componentes_alternativas (nulls not distinct) fica na migração customizada.
    index('ix_produtos_componentes_alternativas_componente_id').on(t.componenteId),
    index('ix_produtos_componentes_alternativas_produto_id').on(t.produtoId),
    index('ix_produtos_componentes_alternativas_variacao_id').on(t.variacaoId),
    check('ck_produtos_componentes_alternativas_acrescimo', sql`acrescimo >= 0`),
  ],
);

// ---------------------------------------------------------------- Demais filhas (MD 3.6.9)

export const produtosRelacionados = pgTable(
  'produtos_relacionados',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    relacionadoId: uuid('relacionado_id').notNull(),
    tipo: varchar('tipo', { length: 10 }).notNull().default('sugestao'),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_relacionados', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_relacionados_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_relacionados_relacionado_id',
      columns: [t.relacionadoId],
      foreignColumns: [produtos.id],
    }),
    uniqueIndex('uq_produtos_relacionados')
      .on(t.produtoId, t.relacionadoId, t.tipo)
      .where(sql`excluido_em is null`),
    index('ix_produtos_relacionados_produto_id').on(t.produtoId),
    index('ix_produtos_relacionados_relacionado_id').on(t.relacionadoId),
    check('ck_produtos_relacionados_tipo', sql`tipo in ('sugestao','substituto','acessorio')`),
    check('ck_produtos_relacionados_proprio', sql`produto_id <> relacionado_id`),
  ],
);

/** Faixas de preço por quantidade do produto, por loja (nula = todas); sem sobreposição via `exclude`. */
export const produtosPrecosQuantidade = pgTable(
  'produtos_precos_quantidade',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    lojaId: uuid('loja_id'),
    quantidadeInicial: quantidade('quantidade_inicial').notNull(),
    quantidadeFinal: quantidade('quantidade_final'),
    preco: preco('preco').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_precos_quantidade', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_precos_quantidade_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_precos_quantidade_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_produtos_precos_quantidade_loja_id',
      columns: [t.lojaId],
      foreignColumns: [lojas.id],
    }),
    index('ix_produtos_precos_quantidade_produto_id').on(t.produtoId),
    index('ix_produtos_precos_quantidade_variacao_id').on(t.variacaoId),
    index('ix_produtos_precos_quantidade_loja_id').on(t.lojaId),
    check(
      'ck_produtos_precos_quantidade_valores',
      sql`quantidade_inicial > 0 and (quantidade_final is null or quantidade_final > quantidade_inicial) and preco >= 0`,
    ),
  ],
);

export const produtosLojas = pgTable(
  'produtos_lojas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
    estoqueMinimo: quantidade('estoque_minimo'),
    estoqueMaximo: quantidade('estoque_maximo'),
    precoVenda: preco('preco_venda'),
    acrescimoGelada: preco('acrescimo_gelada'),
    ativoNaLoja: boolean('ativo_na_loja').notNull().default(true),
    // ICMS-ST retido anteriormente, por unidade base (grupo de ST retido da NFC-e com CST 60/CSOSN 500)
    stBcRetidoUnitario: preco('st_bc_retido_unitario'),
    stAliquotaPct: percentual('st_aliquota_pct'),
    stIcmsSubstitutoUnitario: preco('st_icms_substituto_unitario'),
    stIcmsRetidoUnitario: preco('st_icms_retido_unitario'),
    fcpStBcRetidoUnitario: preco('fcp_st_bc_retido_unitario'),
    fcpStAliquotaPct: percentual('fcp_st_aliquota_pct'),
    fcpStRetidoUnitario: preco('fcp_st_retido_unitario'),
    stAtualizadoEm: timestamptz('st_atualizado_em'),
    // FK para `notas_entrada` (MD 3.8.2) na migração customizada 0024 (o schema de entradas importa este arquivo).
    stNotaEntradaId: uuid('st_nota_entrada_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_lojas', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_lojas_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({ name: 'fk_produtos_lojas_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    uniqueIndex('uq_produtos_lojas')
      .on(t.produtoId, t.lojaId)
      .where(sql`excluido_em is null`),
    index('ix_produtos_lojas_produto_id').on(t.produtoId),
    index('ix_produtos_lojas_loja_id').on(t.lojaId),
    index('ix_produtos_lojas_st_nota_entrada_id').on(t.stNotaEntradaId),
    check(
      'ck_produtos_lojas_estoque',
      sql`estoque_maximo is null or estoque_minimo is null or estoque_maximo >= estoque_minimo`,
    ),
    check('ck_produtos_lojas_preco', sql`preco_venda is null or preco_venda >= 0`),
    check(
      'ck_produtos_lojas_st',
      sql`coalesce(st_bc_retido_unitario, 0) >= 0 and coalesce(st_aliquota_pct, 0) between 0 and 100 and coalesce(st_icms_substituto_unitario, 0) >= 0 and coalesce(st_icms_retido_unitario, 0) >= 0 and coalesce(fcp_st_bc_retido_unitario, 0) >= 0 and coalesce(fcp_st_aliquota_pct, 0) between 0 and 100 and coalesce(fcp_st_retido_unitario, 0) >= 0`,
    ),
    check('ck_produtos_lojas_acrescimo_gelada', sql`acrescimo_gelada is null or acrescimo_gelada >= 0`),
  ],
);

/** Sobreposições da tributação do produto numa UF (todas nulas = usar `produtos`). */
export const produtosTributacaoUf = pgTable(
  'produtos_tributacao_uf',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    uf: char('uf', { length: 2 }).notNull(),
    cfopVendaEstado: varchar('cfop_venda_estado', { length: 4 }),
    icmsSituacao: varchar('icms_situacao', { length: 3 }),
    icmsModalidadeBc: char('icms_modalidade_bc', { length: 1 }),
    icmsAliquota: percentual('icms_aliquota'),
    icmsReducaoBcPct: percentual('icms_reducao_bc_pct'),
    icmsModalidadeBcst: char('icms_modalidade_bcst', { length: 1 }),
    icmsMvaPct: percentual('icms_mva_pct'),
    icmsAliquotaSt: percentual('icms_aliquota_st'),
    fcpAliquota: percentual('fcp_aliquota'),
    fcpStAliquota: percentual('fcp_st_aliquota'),
    beneficioFiscalCodigo: varchar('beneficio_fiscal_codigo', { length: 10 }),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_tributacao_uf', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_tributacao_uf_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({ name: 'fk_produtos_tributacao_uf_uf', columns: [t.uf], foreignColumns: [ufs.sigla] }),
    foreignKey({
      name: 'fk_produtos_tributacao_uf_cfop_venda_estado',
      columns: [t.cfopVendaEstado],
      foreignColumns: [cfops.codigo],
    }),
    uniqueIndex('uq_produtos_tributacao_uf')
      .on(t.produtoId, t.uf)
      .where(sql`excluido_em is null`),
    index('ix_produtos_tributacao_uf_produto_id').on(t.produtoId),
    index('ix_produtos_tributacao_uf_uf').on(t.uf),
    index('ix_produtos_tributacao_uf_cfop_venda_estado').on(t.cfopVendaEstado),
    check(
      'ck_produtos_tributacao_uf_icms',
      sql`(icms_modalidade_bc is null or icms_modalidade_bc ~ '^[0-3]$') and (icms_modalidade_bcst is null or icms_modalidade_bcst ~ '^[0-6]$')`,
    ),
    check(
      'ck_produtos_tributacao_uf_fcp',
      sql`(fcp_aliquota is null or fcp_aliquota between 0 and 100) and (fcp_st_aliquota is null or fcp_st_aliquota between 0 and 100)`,
    ),
  ],
);

/** Bloco Validade (Loja, Data, Lote) e lotes de entrada (MD 3.6.9); saldo por estoque em `saldos_lote`. */
export const produtosLotes = pgTable(
  'produtos_lotes',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    estoqueId: uuid('estoque_id'),
    lote: varchar('lote', { length: 30 }).notNull(),
    validade: date('validade'),
    fabricacao: date('fabricacao'),
    fornecedorId: uuid('fornecedor_id'),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_lotes', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_lotes_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_lotes_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_produtos_lotes_estoque_id',
      columns: [t.estoqueId],
      foreignColumns: [estoques.id],
    }),
    foreignKey({
      name: 'fk_produtos_lotes_fornecedor_id',
      columns: [t.fornecedorId],
      foreignColumns: [pessoas.id],
    }),
    // uq_produtos_lotes (nulls not distinct) fica na migração customizada; começa por produto_id.
    index('ix_produtos_lotes_validade').on(t.validade),
    index('ix_produtos_lotes_estoque_id').on(t.estoqueId),
    index('ix_produtos_lotes_variacao_id').on(t.variacaoId),
    index('ix_produtos_lotes_fornecedor_id').on(t.fornecedorId),
    check('ck_produtos_lotes_datas', sql`validade is null or fabricacao is null or validade >= fabricacao`),
  ],
);

/** Não desce ao PDV (MD 3.6.9, "—"). */
export const produtosFornecedores = pgTable(
  'produtos_fornecedores',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    fornecedorId: uuid('fornecedor_id').notNull(),
    codigoFornecedor: varchar('codigo_fornecedor', { length: 60 }),
    eanFornecedor: varchar('ean_fornecedor', { length: 14 }),
    unidadeCompra: varchar('unidade_compra', { length: 6 }),
    fator: quantidade('fator').notNull().default('1'),
    ultimoCusto: preco('ultimo_custo'),
    ultimaCompraEm: date('ultima_compra_em'),
    /**
     * Custo do fornecedor (F2-B13; D49): digitado no cadastro, por unidade do produto (a mesma de `preco_custo` e
     * `ultimo_custo`); a compra não o muda. Migração 0022.
     */
    custoFornecedor: preco('custo_fornecedor'),
    principal: boolean('principal').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_fornecedores', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_fornecedores_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_fornecedores_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_produtos_fornecedores_fornecedor_id',
      columns: [t.fornecedorId],
      foreignColumns: [pessoas.id],
    }),
    uniqueIndex('uq_produtos_fornecedores_codigo')
      .on(t.fornecedorId, t.codigoFornecedor)
      .where(sql`codigo_fornecedor is not null and excluido_em is null`),
    index('ix_produtos_fornecedores_produto_id').on(t.produtoId),
    index('ix_produtos_fornecedores_variacao_id').on(t.variacaoId),
    index('ix_produtos_fornecedores_fornecedor_id').on(t.fornecedorId),
    check('ck_produtos_fornecedores_fator', sql`fator > 0`),
    check(
      'ck_produtos_fornecedores_custos',
      sql`(custo_fornecedor is null or custo_fornecedor >= 0) and (ultimo_custo is null or ultimo_custo >= 0)`,
    ),
  ],
);

/** Não desce ao PDV (MD 3.6.9, "—"). */
export const produtosImagens = pgTable(
  'produtos_imagens',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    produtoId: uuid('produto_id').notNull(),
    arquivoId: uuid('arquivo_id').notNull(),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_imagens', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_imagens_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_produtos_imagens_arquivo_id',
      columns: [t.arquivoId],
      foreignColumns: [arquivos.id],
    }),
    uniqueIndex('uq_produtos_imagens')
      .on(t.produtoId, t.arquivoId)
      .where(sql`excluido_em is null`),
    index('ix_produtos_imagens_produto_id').on(t.produtoId),
    index('ix_produtos_imagens_arquivo_id').on(t.arquivoId),
  ],
);

export const TIPOS_PRECO_HISTORICO = [
  'venda',
  'custo',
  'atacado',
  'promocional',
  'menu_digital',
  'ifood',
  'parcelado',
  'loja',
  'quantidade',
] as const;

/** L: histórico de alterações de preço (MD 3.6.10). */
export const produtosHistoricoPrecos = pgTable(
  'produtos_historico_precos',
  {
    ...colunasLog(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    lojaId: uuid('loja_id'),
    tipoPreco: varchar('tipo_preco', { length: 15 }).notNull(),
    valorAnterior: preco('valor_anterior'),
    valorNovo: preco('valor_novo'),
    origem: varchar('origem', { length: 15 }).notNull(),
    origemId: uuid('origem_id'),
    usuarioId: uuid('usuario_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_produtos_historico_precos', columns: [t.id] }),
    foreignKey({
      name: 'fk_produtos_historico_precos_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    index('ix_produtos_historico_precos_produto_id_criado_em').on(t.produtoId, t.criadoEm),
    check('ck_produtos_historico_precos_tipo_preco', sql`tipo_preco in (${listaSql(TIPOS_PRECO_HISTORICO)})`),
    // A lista é `ORIGENS_HISTORICO_PRECO` do shared (`historico-precos.spec.ts` confere): escrita à mão para não mudar
    // o CHECK da migração; origem nova vai nos dois lados.
    check(
      'ck_produtos_historico_precos_origem',
      sql`origem in ('cadastro','recebimento','nota_entrada','importacao','cadastro_massa','api')`,
    ),
  ],
);

/** Horários proibidos de venda (leis municipais de bebida, lei seca), PDV 10.11 (MD 3.6.12). */
export const restricoesHorarioVenda = pgTable(
  'restricoes_horario_venda',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    lojaId: uuid('loja_id'),
    categoriaId: uuid('categoria_id'),
    idadeMinimaProduto: smallint('idade_minima_produto'),
    diasSemana: smallint('dias_semana').array(),
    horaInicio: time('hora_inicio').notNull(),
    horaFim: time('hora_fim').notNull(),
    dataEspecifica: date('data_especifica'),
    descricao: varchar('descricao', { length: 100 }).notNull(),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_restricoes_horario_venda', columns: [t.id] }),
    foreignKey({
      name: 'fk_restricoes_horario_venda_loja_id',
      columns: [t.lojaId],
      foreignColumns: [lojas.id],
    }),
    foreignKey({
      name: 'fk_restricoes_horario_venda_categoria_id',
      columns: [t.categoriaId],
      foreignColumns: [categorias.id],
    }),
    index('ix_restricoes_horario_venda_loja_id').on(t.lojaId),
    index('ix_restricoes_horario_venda_categoria_id').on(t.categoriaId),
    check(
      'ck_restricoes_horario_venda_alvo',
      sql`categoria_id is not null or idade_minima_produto is not null`,
    ),
    check(
      'ck_restricoes_horario_venda_dias_semana',
      sql`dias_semana is null or (cardinality(dias_semana) between 1 and 7 and dias_semana <@ '{0,1,2,3,4,5,6}'::smallint[])`,
    ),
    check('ck_restricoes_horario_venda_horario', sql`hora_inicio <> hora_fim`),
  ],
);
