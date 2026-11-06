/**
 * MD 3.5 – pessoas (clientes, fornecedores, funcionários…), filhas e projeções que descem ao PDV pelo fluxo `pessoas`
 * filtradas por relevância na loja (3.5.4).
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
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { colunasAutoria, colunasPadrao, timestamptz } from '../../colunas.js';
import { lojas } from './estrutura.js';
import { municipios, paises, ufs } from './referencias.js';
import { terminais } from './sincronizacao.js';

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));

export const ORIGENS_PESSOA = ['erp', 'pdv', 'importacao', 'nfe', 'integracao'] as const;

export const pessoas = pgTable(
  'pessoas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_pessoas')`),
    tipo: char('tipo', { length: 2 }).notNull().default('PF'),
    nome: varchar('nome', { length: 150 }).notNull(),
    apelido: varchar('apelido', { length: 150 }),
    ativa: boolean('ativa').notNull().default(true),
    cpfCnpj: varchar('cpf_cnpj', { length: 14 }),
    rgIe: varchar('rg_ie', { length: 20 }),
    indicadorIe: varchar('indicador_ie', { length: 16 }).notNull().default('nao_contribuinte'),
    inscricaoMunicipal: varchar('inscricao_municipal', { length: 20 }),
    nascimento: date('nascimento'),
    sexo: char('sexo', { length: 1 }).notNull().default('N'),
    senhaHash: varchar('senha_hash', { length: 255 }),
    limiteCompras: numeric('limite_compras', { precision: 15, scale: 2 }),
    descontoPct: numeric('desconto_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    bloqueadaCredito: boolean('bloqueada_credito').notNull().default(false),
    observacoes: text('observacoes'),
    observacaoPdv: varchar('observacao_pdv', { length: 200 }),
    origem: varchar('origem', { length: 12 }).notNull().default('erp'),
    origemTerminalId: uuid('origem_terminal_id'),
    anonimizadaEm: timestamptz('anonimizada_em'),
    busca: text('busca').notNull().default(''),
  },
  (t) => [
    primaryKey({ name: 'pk_pessoas', columns: [t.id] }),
    foreignKey({
      name: 'fk_pessoas_origem_terminal_id',
      columns: [t.origemTerminalId],
      foreignColumns: [terminais.id],
    }),
    uniqueIndex('uq_pessoas_codigo').on(t.codigo),
    uniqueIndex('uq_pessoas_cpf_cnpj')
      .on(t.cpfCnpj)
      .where(sql`cpf_cnpj is not null and excluido_em is null`),
    index('ix_pessoas_busca').using('gin', sql`busca gin_trgm_ops`),
    index('ix_pessoas_origem_terminal_id').on(t.origemTerminalId),
    check('ck_pessoas_tipo', sql`tipo in ('PF','PJ')`),
    check('ck_pessoas_sexo', sql`sexo in ('M','F','O','N')`),
    check('ck_pessoas_indicador_ie', sql`indicador_ie in ('contribuinte','isento','nao_contribuinte')`),
    check('ck_pessoas_origem', sql`origem in (${listaSql(ORIGENS_PESSOA)})`),
    check(
      'ck_pessoas_cpf_cnpj',
      sql`cpf_cnpj is null or (tipo = 'PF' and cpf_cnpj ~ '^[0-9]{11}$') or (tipo = 'PJ' and cpf_cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$')`,
    ),
    check('ck_pessoas_desconto', sql`desconto_pct between 0 and 100`),
    check('ck_pessoas_limite', sql`limite_compras is null or limite_compras >= 0`),
  ],
);

export const CATEGORIAS_PESSOA = [
  'cliente',
  'fornecedor',
  'funcionario',
  'transportadora',
  'representante',
  'consumidor',
] as const;

export const pessoasCategorias = pgTable(
  'pessoas_categorias',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    pessoaId: uuid('pessoa_id').notNull(),
    categoria: varchar('categoria', { length: 15 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_pessoas_categorias', columns: [t.id] }),
    foreignKey({
      name: 'fk_pessoas_categorias_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    uniqueIndex('uq_pessoas_categorias')
      .on(t.pessoaId, t.categoria)
      .where(sql`excluido_em is null`),
    index('ix_pessoas_categorias_categoria').on(t.categoria),
    check('ck_pessoas_categorias_categoria', sql`categoria in (${listaSql(CATEGORIAS_PESSOA)})`),
  ],
);

export const pessoasEnderecos = pgTable(
  'pessoas_enderecos',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    pessoaId: uuid('pessoa_id').notNull(),
    tipo: varchar('tipo', { length: 10 }).notNull().default('principal'),
    cep: varchar('cep', { length: 8 }),
    logradouro: varchar('logradouro', { length: 150 }),
    numero: varchar('numero', { length: 20 }),
    complemento: varchar('complemento', { length: 80 }),
    bairro: varchar('bairro', { length: 80 }),
    uf: char('uf', { length: 2 }),
    municipioIbge: integer('municipio_ibge'),
    exterior: boolean('exterior').notNull().default(false),
    paisCodigo: varchar('pais_codigo', { length: 4 }),
    cidadeExterior: varchar('cidade_exterior', { length: 80 }),
    referencia: varchar('referencia', { length: 150 }),
  },
  (t) => [
    primaryKey({ name: 'pk_pessoas_enderecos', columns: [t.id] }),
    foreignKey({
      name: 'fk_pessoas_enderecos_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({ name: 'fk_pessoas_enderecos_uf', columns: [t.uf], foreignColumns: [ufs.sigla] }),
    foreignKey({
      name: 'fk_pessoas_enderecos_municipio_ibge',
      columns: [t.municipioIbge],
      foreignColumns: [municipios.codigoIbge],
    }),
    foreignKey({
      name: 'fk_pessoas_enderecos_pais_codigo',
      columns: [t.paisCodigo],
      foreignColumns: [paises.codigoBacen],
    }),
    index('ix_pessoas_enderecos_pessoa_id').on(t.pessoaId),
    index('ix_pessoas_enderecos_cep').on(t.cep),
    index('ix_pessoas_enderecos_uf').on(t.uf),
    index('ix_pessoas_enderecos_municipio_ibge').on(t.municipioIbge),
    index('ix_pessoas_enderecos_pais_codigo').on(t.paisCodigo),
    uniqueIndex('uq_pessoas_enderecos_principal')
      .on(t.pessoaId)
      .where(sql`tipo = 'principal' and excluido_em is null`),
    check('ck_pessoas_enderecos_tipo', sql`tipo in ('principal','entrega','cobranca','outro')`),
    check(
      'ck_pessoas_enderecos_completo',
      sql`exterior or (cep is not null and logradouro is not null and numero is not null and bairro is not null and uf is not null and municipio_ibge is not null)`,
    ),
    check('ck_pessoas_enderecos_cep', sql`cep is null or cep ~ '^[0-9]{8}$'`),
  ],
);

export const pessoasTelefones = pgTable(
  'pessoas_telefones',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    pessoaId: uuid('pessoa_id').notNull(),
    tipo: varchar('tipo', { length: 12 }).notNull().default('celular'),
    ddd: varchar('ddd', { length: 2 }).notNull(),
    numero: varchar('numero', { length: 9 }).notNull(),
    contato: varchar('contato', { length: 80 }),
    principal: boolean('principal').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'pk_pessoas_telefones', columns: [t.id] }),
    foreignKey({
      name: 'fk_pessoas_telefones_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    index('ix_pessoas_telefones_pessoa_id').on(t.pessoaId),
    index('ix_pessoas_telefones_numero').on(t.ddd, t.numero),
    uniqueIndex('uq_pessoas_telefones_principal')
      .on(t.pessoaId)
      .where(sql`principal and excluido_em is null`),
    check('ck_pessoas_telefones_tipo', sql`tipo in ('celular','comercial','residencial','whatsapp','outro')`),
    check('ck_pessoas_telefones_numero', sql`ddd ~ '^[1-9][0-9]$' and numero ~ '^[0-9]{8,9}$'`),
  ],
);

/** Não desce ao PDV (MD 3.5.2, "—"). */
export const pessoasEmails = pgTable(
  'pessoas_emails',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    pessoaId: uuid('pessoa_id').notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    principal: boolean('principal').notNull().default(false),
    recebeDocumentos: boolean('recebe_documentos').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_pessoas_emails', columns: [t.id] }),
    foreignKey({ name: 'fk_pessoas_emails_pessoa_id', columns: [t.pessoaId], foreignColumns: [pessoas.id] }),
    uniqueIndex('uq_pessoas_emails')
      .on(t.pessoaId, sql`lower(email)`)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_pessoas_emails_principal')
      .on(t.pessoaId)
      .where(sql`principal and excluido_em is null`),
  ],
);

/** Ids de cadastro rápido do caixa mesclados num cadastro definitivo (MD 3.5.2; desce só com ids). */
export const pessoasAliases = pgTable(
  'pessoas_aliases',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    aliasId: uuid('alias_id').notNull(),
    pessoaId: uuid('pessoa_id').notNull(),
    terminalId: uuid('terminal_id'),
    motivo: varchar('motivo', { length: 20 }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_pessoas_aliases', columns: [t.id] }),
    foreignKey({ name: 'fk_pessoas_aliases_pessoa_id', columns: [t.pessoaId], foreignColumns: [pessoas.id] }),
    foreignKey({
      name: 'fk_pessoas_aliases_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    uniqueIndex('uq_pessoas_aliases_alias_id').on(t.aliasId),
    index('ix_pessoas_aliases_pessoa_id').on(t.pessoaId),
    index('ix_pessoas_aliases_terminal_id').on(t.terminalId),
    check('ck_pessoas_aliases_motivo', sql`motivo in ('mesclada_cpf','mesclada_manual')`),
  ],
);

/** P: crédito em aberto por pessoa, mantido na transação que altera as parcelas a receber (MD 3.5.3). */
export const saldosCreditoPessoas = pgTable(
  'saldos_credito_pessoas',
  {
    ...colunasPadrao(),
    pessoaId: uuid('pessoa_id').notNull(),
    limite: numeric('limite', { precision: 15, scale: 2 }).notNull().default('0'),
    saldoAberto: numeric('saldo_aberto', { precision: 15, scale: 2 }).notNull().default('0'),
    saldoVencido: numeric('saldo_vencido', { precision: 15, scale: 2 }).notNull().default('0'),
    maiorAtrasoDias: integer('maior_atraso_dias').notNull().default(0),
    parcelasAbertas: integer('parcelas_abertas').notNull().default(0),
    calculadoEm: timestamptz('calculado_em').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_saldos_credito_pessoas', columns: [t.id] }),
    foreignKey({
      name: 'fk_saldos_credito_pessoas_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    uniqueIndex('uq_saldos_credito_pessoas_pessoa_id').on(t.pessoaId),
  ],
);

export const MOTIVOS_RELEVANCIA_LOJA = ['crediario', 'funcionario', 'compra', 'delivery', 'manual'] as const;

/** P: quais pessoas descem para cada loja (minimização LGPD, MD 3.5.4). */
export const pessoasRelevanciaLoja = pgTable(
  'pessoas_relevancia_loja',
  {
    ...colunasPadrao(),
    pessoaId: uuid('pessoa_id').notNull(),
    lojaId: uuid('loja_id'),
    motivo: varchar('motivo', { length: 12 }).notNull(),
    ultimaOcorrenciaEm: timestamptz('ultima_ocorrencia_em').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_pessoas_relevancia_loja', columns: [t.id] }),
    foreignKey({
      name: 'fk_pessoas_relevancia_loja_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({
      name: 'fk_pessoas_relevancia_loja_loja_id',
      columns: [t.lojaId],
      foreignColumns: [lojas.id],
    }),
    // uq_pessoas_relevancia_loja (nulls not distinct) fica na migração customizada; começa por pessoa_id.
    index('ix_pessoas_relevancia_loja_loja_id').on(t.lojaId),
    check('ck_pessoas_relevancia_loja_motivo', sql`motivo in (${listaSql(MOTIVOS_RELEVANCIA_LOJA)})`),
  ],
);

/**
 * P: parcelas a receber abertas por pessoa (MD 3.5.5). A FK de `parcela_financeira_id` (→ `parcelas_financeiras`) entra
 * com o financeiro (Fase 4).
 */
export const parcelasCreditoPessoas = pgTable(
  'parcelas_credito_pessoas',
  {
    ...colunasPadrao(),
    pessoaId: uuid('pessoa_id').notNull(),
    parcelaFinanceiraId: uuid('parcela_financeira_id').notNull(),
    documento: varchar('documento', { length: 40 }).notNull(),
    numero: smallint('numero').notNull(),
    vencimento: date('vencimento').notNull(),
    valor: numeric('valor', { precision: 15, scale: 2 }).notNull(),
    saldo: numeric('saldo', { precision: 15, scale: 2 }).notNull(),
    diasAtraso: integer('dias_atraso').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_parcelas_credito_pessoas', columns: [t.id] }),
    foreignKey({
      name: 'fk_parcelas_credito_pessoas_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    uniqueIndex('uq_parcelas_credito_pessoas_parcela')
      .on(t.parcelaFinanceiraId)
      .where(sql`excluido_em is null`),
    index('ix_parcelas_credito_pessoas_pessoa_id').on(t.pessoaId),
  ],
);
