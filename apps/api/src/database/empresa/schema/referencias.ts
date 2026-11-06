/**
 * MD 3.4 (referências nacionais: Fase 0 + `paises`, `ncms`, `cests` e `parametros_fiscais_uf` da Fase 1) e MD 3.7.1
 * (tipos de movimento de estoque).
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
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { colunasAutoria, colunasPadrao, colunasReferencia } from '../../colunas.js';

export const ufs = pgTable(
  'ufs',
  {
    sigla: char('sigla', { length: 2 }).notNull(),
    codigoIbge: smallint('codigo_ibge').notNull(),
    nome: varchar('nome', { length: 30 }).notNull(),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_ufs', columns: [t.sigla] }),
    uniqueIndex('uq_ufs_codigo_ibge').on(t.codigoIbge),
  ],
);

export const municipios = pgTable(
  'municipios',
  {
    codigoIbge: integer('codigo_ibge').notNull(),
    nome: varchar('nome', { length: 80 }).notNull(),
    uf: char('uf', { length: 2 }).notNull(),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_municipios', columns: [t.codigoIbge] }),
    foreignKey({ name: 'fk_municipios_uf', columns: [t.uf], foreignColumns: [ufs.sigla] }),
    index('ix_municipios_uf_nome').on(t.uf, t.nome),
  ],
);

export const bancos = pgTable(
  'bancos',
  {
    codigo: varchar('codigo', { length: 3 }).notNull(),
    ispb: varchar('ispb', { length: 8 }),
    nome: varchar('nome', { length: 120 }).notNull(),
    nomeCurto: varchar('nome_curto', { length: 40 }),
    destaque: smallint('destaque'),
    ativo: boolean('ativo').notNull().default(true),
    ...colunasReferencia(),
  },
  (t) => [primaryKey({ name: 'pk_bancos', columns: [t.codigo] })],
);

export const cfops = pgTable(
  'cfops',
  {
    codigo: varchar('codigo', { length: 4 }).notNull(),
    descricao: text('descricao').notNull(),
    tipo: varchar('tipo', { length: 7 }).notNull(),
    abrangencia: varchar('abrangencia', { length: 14 }).notNull(),
    ativo: boolean('ativo').notNull().default(true),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_cfops', columns: [t.codigo] }),
    check('ck_cfops_codigo', sql`codigo ~ '^[1-7][0-9]{3}$'`),
    check('ck_cfops_tipo', sql`tipo in ('entrada','saida')`),
    check('ck_cfops_abrangencia', sql`abrangencia in ('estadual','interestadual','exterior')`),
  ],
);

export const meiosPagamentoFiscais = pgTable(
  'meios_pagamento_fiscais',
  {
    codigo: varchar('codigo', { length: 2 }).notNull(),
    descricao: varchar('descricao', { length: 60 }).notNull(),
    exigeDescricao: boolean('exige_descricao').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_meios_pagamento_fiscais', columns: [t.codigo] }),
    check('ck_meios_pagamento_fiscais_codigo', sql`codigo ~ '^[0-9]{2}$'`),
  ],
);

export const unidadesMedida = pgTable(
  'unidades_medida',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    sigla: varchar('sigla', { length: 6 }).notNull(),
    descricao: varchar('descricao', { length: 40 }).notNull(),
    permiteFracao: boolean('permite_fracao').notNull().default(false),
    sistema: boolean('sistema').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_unidades_medida', columns: [t.id] }),
    uniqueIndex('uq_unidades_medida_sigla')
      .on(sql`upper(sigla)`)
      .where(sql`excluido_em is null`),
  ],
);

export const cfopsGrupos = pgTable(
  'cfops_grupos',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    grupo: varchar('grupo', { length: 30 }).notNull(),
    cfop: varchar('cfop', { length: 4 }).notNull(),
    padrao: boolean('padrao').notNull().default(false),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_cfops_grupos', columns: [t.id] }),
    foreignKey({ name: 'fk_cfops_grupos_cfop', columns: [t.cfop], foreignColumns: [cfops.codigo] }),
    index('ix_cfops_grupos_cfop').on(t.cfop),
    uniqueIndex('uq_cfops_grupos')
      .on(t.grupo, t.cfop)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_cfops_grupos_padrao')
      .on(t.grupo)
      .where(sql`padrao and excluido_em is null`),
    check(
      'ck_cfops_grupos_grupo',
      sql`grupo in ('global','venda_estado','venda_fora_estado','remessa_vendedor_estado','remessa_vendedor_fora_estado')`,
    ),
  ],
);

export const tiposMovimentoEstoque = pgTable(
  'tipos_movimento_estoque',
  {
    codigo: varchar('codigo', { length: 30 }).notNull(),
    nome: varchar('nome', { length: 80 }).notNull(),
    sinal: smallint('sinal').notNull(),
    documentoTipo: varchar('documento_tipo', { length: 20 }).notNull(),
    nomeNuvem3: varchar('nome_nuvem3', { length: 80 }),
    idNuvem3: smallint('id_nuvem3'),
    ativo: boolean('ativo').notNull().default(true),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_tipos_movimento_estoque', columns: [t.codigo] }),
    check('ck_tipos_movimento_estoque_sinal', sql`sinal in (-1,0,1)`),
  ],
);

export const paises = pgTable(
  'paises',
  {
    codigoBacen: varchar('codigo_bacen', { length: 4 }).notNull(),
    nome: varchar('nome', { length: 80 }).notNull(),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_paises', columns: [t.codigoBacen] }),
    check('ck_paises_codigo_bacen', sql`codigo_bacen ~ '^[0-9]{4}$'`),
  ],
);

export const ncms = pgTable(
  'ncms',
  {
    codigo: varchar('codigo', { length: 8 }).notNull(),
    descricao: text('descricao').notNull(),
    vigenciaInicio: date('vigencia_inicio'),
    vigenciaFim: date('vigencia_fim'),
    unidadeTributavel: varchar('unidade_tributavel', { length: 6 }),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_ncms', columns: [t.codigo] }),
    check('ck_ncms_codigo', sql`codigo ~ '^[0-9]{8}$'`),
    index('ix_ncms_busca').using('gin', sql`descricao gin_trgm_ops`),
  ],
);

export const cests = pgTable(
  'cests',
  {
    codigo: varchar('codigo', { length: 7 }).notNull(),
    descricao: text('descricao').notNull(),
    segmento: varchar('segmento', { length: 80 }),
    ncms: text('ncms').array().notNull(),
    vigenciaInicio: date('vigencia_inicio'),
    vigenciaFim: date('vigencia_fim'),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_cests', columns: [t.codigo] }),
    check('ck_cests_codigo', sql`codigo ~ '^[0-9]{7}$'`),
    index('ix_cests_ncms').using('gin', t.ncms),
  ],
);

/**
 * MD 3.4.3: parâmetros fiscais operacionais por UF e vigência (R com `id`, mantida pela plataforma via
 * `db:referencias`). A sobreposição de vigência por UF é barrada por `exclude using gist` na migração customizada.
 */
export const parametrosFiscaisUf = pgTable(
  'parametros_fiscais_uf',
  {
    id: uuid('id')
      .notNull()
      .default(sql`fn_uuid_v7()`),
    uf: char('uf', { length: 2 }).notNull(),
    vigenciaInicio: date('vigencia_inicio').notNull(),
    vigenciaFim: date('vigencia_fim'),
    tiposEmissaoPermitidos: text('tipos_emissao_permitidos')
      .array()
      .notNull()
      .default(sql`'{nfce}'`),
    regimesDispensadosNfce: text('regimes_dispensados_nfce')
      .array()
      .notNull()
      .default(sql`'{}'`),
    autorizador: varchar('autorizador', { length: 10 }).notNull(),
    versaoLeiaute: varchar('versao_leiaute', { length: 5 }).notNull().default('4.00'),
    webservices: jsonb('webservices'),
    urlQrcodeProducao: text('url_qrcode_producao').notNull(),
    urlQrcodeHomologacao: text('url_qrcode_homologacao').notNull(),
    urlConsultaProducao: text('url_consulta_producao').notNull(),
    urlConsultaHomologacao: text('url_consulta_homologacao').notNull(),
    qrcodeVersoesAceitas: smallint('qrcode_versoes_aceitas')
      .array()
      .notNull()
      .default(sql`'{2}'`),
    qrcodeVersaoPadrao: smallint('qrcode_versao_padrao').notNull().default(2),
    cscMaxAtivosPorAmbiente: smallint('csc_max_ativos_por_ambiente'),
    cscPorCnpjBase: boolean('csc_por_cnpj_base').notNull().default(false),
    prazoCancelamentoMin: smallint('prazo_cancelamento_min').notNull(),
    prazoCancelamentoSubstituicaoH: smallint('prazo_cancelamento_substituicao_h').notNull(),
    aceitaCancelamentoExtemporaneo: boolean('aceita_cancelamento_extemporaneo'),
    prazoTransmissaoContingenciaH: smallint('prazo_transmissao_contingencia_h').notNull(),
    modalidadesContingenciaNfce: smallint('modalidades_contingencia_nfce')
      .array()
      .notNull()
      .default(sql`'{9}'`),
    contingenciaViasDanfe: smallint('contingencia_vias_danfe').notNull().default(1),
    inutilizacaoPrazoDia: smallint('inutilizacao_prazo_dia').notNull(),
    identificacaoObrigatoriaValor: numeric('identificacao_obrigatoria_valor', {
      precision: 15,
      scale: 2,
    }).notNull(),
    identificacaoObrigatoriaNaoPresencial: boolean('identificacao_obrigatoria_nao_presencial')
      .notNull()
      .default(true),
    nfceValorMaximo: numeric('nfce_valor_maximo', { precision: 15, scale: 2 }),
    danfeModosPermitidos: text('danfe_modos_permitidos')
      .array()
      .notNull()
      .default(sql`'{completo}'`),
    danfeResumidoExigeConcordancia: boolean('danfe_resumido_exige_concordancia').notNull().default(true),
    programaCidadania: varchar('programa_cidadania', { length: 40 }),
    programaCidadaniaSubstituiDanfe: boolean('programa_cidadania_substitui_danfe'),
    intervaloMinimoStatusS: integer('intervalo_minimo_status_s'),
    atrasoMaxEmissaoMin: smallint('atraso_max_emissao_min').notNull().default(5),
    fcpNome: varchar('fcp_nome', { length: 40 }),
    exigeStRetidoNfce: boolean('exige_st_retido_nfce').notNull().default(false),
    exigeVinculacaoPagamento: boolean('exige_vinculacao_pagamento').notNull().default(false),
    exigeCbenef: boolean('exige_cbenef').notNull().default(false),
    exigeCestBemListado: boolean('exige_cest_bem_listado').notNull().default(true),
    exigeRespTec: boolean('exige_resp_tec').notNull().default(true),
    exigeCsrtNfce: boolean('exige_csrt_nfce').notNull().default(false),
    fundamento: text('fundamento'),
    pendencias: text('pendencias'),
    conferidoEm: date('conferido_em'),
    ...colunasReferencia(),
  },
  (t) => [
    primaryKey({ name: 'pk_parametros_fiscais_uf', columns: [t.id] }),
    foreignKey({ name: 'fk_parametros_fiscais_uf_uf', columns: [t.uf], foreignColumns: [ufs.sigla] }),
    uniqueIndex('uq_parametros_fiscais_uf_uf_vigencia_inicio').on(t.uf, t.vigenciaInicio),
    check(
      'ck_parametros_fiscais_uf_prazos',
      sql`prazo_cancelamento_min > 0 and prazo_cancelamento_substituicao_h > 0 and prazo_transmissao_contingencia_h > 0`,
    ),
    check('ck_parametros_fiscais_uf_inutilizacao', sql`inutilizacao_prazo_dia between 1 and 28`),
    check('ck_parametros_fiscais_uf_qrcode', sql`qrcode_versao_padrao = any(qrcode_versoes_aceitas)`),
    check(
      'ck_parametros_fiscais_uf_danfe',
      sql`danfe_modos_permitidos <@ '{completo,resumido,eletronico_se_solicitado}'::text[] and 'completo' = any(danfe_modos_permitidos)`,
    ),
    check(
      'ck_parametros_fiscais_uf_tipos_emissao',
      sql`tipos_emissao_permitidos <@ '{nfce,sat,mfe}'::text[]`,
    ),
    check('ck_parametros_fiscais_uf_vigencia', sql`vigencia_fim is null or vigencia_fim >= vigencia_inicio`),
    check(
      'ck_parametros_fiscais_uf_valores',
      sql`identificacao_obrigatoria_valor >= 0 and (nfce_valor_maximo is null or nfce_valor_maximo > 0)`,
    ),
  ],
);
