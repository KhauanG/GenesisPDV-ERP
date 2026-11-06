/**
 * MD 3.2 – empresa, lojas, estoques, tipos de estoque, caixas e (Fase 1) certificados, destinos de impressão e taxas
 * de entrega. `lojas_banners` fica em `sistema.ts`, junto de `arquivos` (evita import circular).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { bytea, colunasAutoria, colunasPadrao, timestamptz } from '../../colunas.js';
import { municipios, ufs } from './referencias.js';

export const empresa = pgTable(
  'empresa',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    unica: boolean('unica').notNull().default(true),
    codigo: integer('codigo').notNull(),
    razaoSocial: varchar('razao_social', { length: 150 }).notNull(),
    nomeFantasia: varchar('nome_fantasia', { length: 150 }),
    cnpj: varchar('cnpj', { length: 14 }).notNull(),
    ie: varchar('ie', { length: 20 }),
    inscricaoMunicipal: varchar('inscricao_municipal', { length: 20 }),
    cep: varchar('cep', { length: 8 }),
    logradouro: varchar('logradouro', { length: 150 }),
    numero: varchar('numero', { length: 20 }),
    complemento: varchar('complemento', { length: 80 }),
    bairro: varchar('bairro', { length: 80 }),
    municipioIbge: integer('municipio_ibge'),
    uf: char('uf', { length: 2 }),
    telefone: varchar('telefone', { length: 20 }),
    email: varchar('email', { length: 254 }),
    emailContador: varchar('email_contador', { length: 254 }),
    fusoHorario: varchar('fuso_horario', { length: 40 }).notNull().default('America/Sao_Paulo'),
  },
  (t) => [
    primaryKey({ name: 'pk_empresa', columns: [t.id] }),
    uniqueIndex('uq_empresa_unica').on(t.unica),
    check('ck_empresa_unica', sql`unica`),
    check('ck_empresa_cnpj', sql`cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'`),
    foreignKey({
      name: 'fk_empresa_municipio_ibge',
      columns: [t.municipioIbge],
      foreignColumns: [municipios.codigoIbge],
    }),
    foreignKey({ name: 'fk_empresa_uf', columns: [t.uf], foreignColumns: [ufs.sigla] }),
  ],
);

export const estoques = pgTable(
  'estoques',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_estoques')`),
    nome: varchar('nome', { length: 60 }).notNull(),
    tipo: varchar('tipo', { length: 10 }).notNull().default('loja'),
    endereco: varchar('endereco', { length: 255 }),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_estoques', columns: [t.id] }),
    uniqueIndex('uq_estoques_codigo').on(t.codigo),
    uniqueIndex('uq_estoques_nome')
      .on(sql`lower(nome)`)
      .where(sql`excluido_em is null`),
    check('ck_estoques_tipo', sql`tipo in ('loja','deposito','outro')`),
  ],
);

export const tiposEstoque = pgTable(
  'tipos_estoque',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    nome: varchar('nome', { length: 40 }).notNull(),
    vendavel: boolean('vendavel').notNull().default(true),
    padrao: boolean('padrao').notNull().default(false),
    ativo: boolean('ativo').notNull().default(true),
    chaveSistema: varchar('chave_sistema', { length: 20 }),
  },
  (t) => [
    primaryKey({ name: 'pk_tipos_estoque', columns: [t.id] }),
    uniqueIndex('uq_tipos_estoque_nome')
      .on(sql`lower(nome)`)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_tipos_estoque_padrao')
      .on(t.padrao)
      .where(sql`padrao and excluido_em is null`),
    uniqueIndex('uq_tipos_estoque_chave_sistema')
      .on(t.chaveSistema)
      .where(sql`chave_sistema is not null`),
  ],
);

export const lojas = pgTable(
  'lojas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: smallint('codigo').notNull(),
    nome: varchar('nome', { length: 60 }).notNull(),
    tipo: varchar('tipo', { length: 12 }).notNull().default('ponto_venda'),
    razaoSocial: varchar('razao_social', { length: 150 }).notNull(),
    nomeFantasia: varchar('nome_fantasia', { length: 150 }).notNull(),
    cnpj: varchar('cnpj', { length: 14 }).notNull(),
    ie: varchar('ie', { length: 20 }),
    inscricaoMunicipal: varchar('inscricao_municipal', { length: 20 }),
    telefone: varchar('telefone', { length: 20 }),
    celular: varchar('celular', { length: 20 }),
    email: varchar('email', { length: 254 }),
    estoqueId: uuid('estoque_id').notNull(),
    cep: varchar('cep', { length: 8 }).notNull(),
    logradouro: varchar('logradouro', { length: 150 }).notNull(),
    numero: varchar('numero', { length: 20 }).notNull(),
    complemento: varchar('complemento', { length: 80 }),
    bairro: varchar('bairro', { length: 80 }).notNull(),
    municipioIbge: integer('municipio_ibge').notNull(),
    uf: char('uf', { length: 2 }).notNull(),
    fusoHorario: varchar('fuso_horario', { length: 40 }).notNull().default('America/Sao_Paulo'),
    fraseRodapeCupom: varchar('frase_rodape_cupom', { length: 300 }),
    ordem: integer('ordem').notNull().default(0),
    ativa: boolean('ativa').notNull().default(true),
    usaPdv: boolean('usa_pdv').notNull().default(true),
    usaMenuDigital: boolean('usa_menu_digital').notNull().default(false),
    // Loja de treino (dono, O10; Fase 1C, C12): fora das consultas e do dashboard do ERP por padrão; não desce ao PDV.
    treino: boolean('treino').notNull().default(false),
    chavePublica: varchar('chave_publica', { length: 40 }),
    logotipoArquivoId: uuid('logotipo_arquivo_id'),
    fotoArquivoId: uuid('foto_arquivo_id'),
    regime: varchar('regime', { length: 30 }),
    nfeSerie: integer('nfe_serie'),
    nfceAmbiente: smallint('nfce_ambiente').notNull().default(2),
    tipoEmissao: varchar('tipo_emissao', { length: 12 }).notNull().default('nao_fiscal'),
    certificadoTipo: varchar('certificado_tipo', { length: 2 }),
    nfceCscId: varchar('nfce_csc_id', { length: 6 }),
    nfceCscCifrado: bytea('nfce_csc_cifrado'),
    nfceCscHomologacaoId: varchar('nfce_csc_homologacao_id', { length: 6 }),
    nfceCscHomologacaoCifrado: bytea('nfce_csc_homologacao_cifrado'),
    nfceQrcodeVersao: smallint('nfce_qrcode_versao'),
    nfcePrazoCancelamentoMin: smallint('nfce_prazo_cancelamento_min').notNull().default(30),
    nfceValorExigeIdentificacao: numeric('nfce_valor_exige_identificacao', { precision: 15, scale: 2 })
      .notNull()
      .default('10000.00'),
    satCodigoAtivacaoCifrado: bytea('sat_codigo_ativacao_cifrado'),
    tefProvedor: varchar('tef_provedor', { length: 10 }),
    tefCodigoLoja: varchar('tef_codigo_loja', { length: 30 }),
    tefServidor: varchar('tef_servidor', { length: 255 }),
    tefTokenCifrado: bytea('tef_token_cifrado'),
    tefCnpjCredenciadora: varchar('tef_cnpj_credenciadora', { length: 14 }),
    chavePix: varchar('chave_pix', { length: 77 }),
    pixNomeRecebedor: varchar('pix_nome_recebedor', { length: 25 }),
    pixCidadeRecebedor: varchar('pix_cidade_recebedor', { length: 15 }),
  },
  (t) => [
    primaryKey({ name: 'pk_lojas', columns: [t.id] }),
    uniqueIndex('uq_lojas_codigo')
      .on(t.codigo)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_lojas_nome')
      .on(sql`lower(nome)`)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_lojas_cnpj')
      .on(t.cnpj)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_lojas_estoque_id')
      .on(t.estoqueId)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_lojas_chave_publica')
      .on(t.chavePublica)
      .where(sql`chave_publica is not null and excluido_em is null`),
    foreignKey({ name: 'fk_lojas_estoque_id', columns: [t.estoqueId], foreignColumns: [estoques.id] }),
    foreignKey({
      name: 'fk_lojas_municipio_ibge',
      columns: [t.municipioIbge],
      foreignColumns: [municipios.codigoIbge],
    }),
    foreignKey({ name: 'fk_lojas_uf', columns: [t.uf], foreignColumns: [ufs.sigla] }),
    index('ix_lojas_municipio_ibge').on(t.municipioIbge),
    index('ix_lojas_uf').on(t.uf),
    check('ck_lojas_codigo', sql`codigo between 1 and 99`),
    check('ck_lojas_tipo', sql`tipo in ('ponto_venda','deposito')`),
    check('ck_lojas_tipo_emissao', sql`tipo_emissao in ('nao_fiscal','sat','mfe','nfce')`),
    check('ck_lojas_nfce_ambiente', sql`nfce_ambiente in (1,2)`),
    check('ck_lojas_deposito_sem_pdv', sql`tipo = 'ponto_venda' or not usa_pdv`),
    // Loja de treino só não fiscal (O10; C12): a regra não depende só da tela (`regrasLoja` no shared).
    check('ck_lojas_treino_nao_fiscal', sql`not treino or tipo_emissao = 'nao_fiscal'`),
    check('ck_lojas_cnpj', sql`cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'`),
    check('ck_lojas_nfce_valor_identificacao', sql`nfce_valor_exige_identificacao >= 0`),
    check('ck_lojas_nfce_qrcode_versao', sql`nfce_qrcode_versao is null or nfce_qrcode_versao in (2,3)`),
  ],
);

export const caixas = pgTable(
  'caixas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    lojaId: uuid('loja_id').notNull(),
    numero: smallint('numero').notNull(),
    descricao: varchar('descricao', { length: 40 }),
    sistema: boolean('sistema').notNull().default(false),
    nfceSerie: integer('nfce_serie'),
    tefTerminal: varchar('tef_terminal', { length: 20 }),
    posIdTerminal: varchar('pos_id_terminal', { length: 40 }),
    // FKs para `terminais` (MD 3.15) entram com o esqueleto de sincronização.
    terminalId: uuid('terminal_id'),
    terminalAnteriorId: uuid('terminal_anterior_id'),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_caixas', columns: [t.id] }),
    foreignKey({ name: 'fk_caixas_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    uniqueIndex('uq_caixas_loja_id_numero')
      .on(t.lojaId, t.numero)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_caixas_loja_id_nfce_serie')
      .on(t.lojaId, t.nfceSerie)
      .where(sql`nfce_serie is not null and excluido_em is null`),
    index('ix_caixas_terminal_id').on(t.terminalId),
    index('ix_caixas_terminal_anterior_id').on(t.terminalAnteriorId),
    check('ck_caixas_numero', sql`numero between 0 and 99`),
    check('ck_caixas_sistema', sql`sistema = (numero = 0)`),
    check('ck_caixas_nfce_serie', sql`nfce_serie is null or nfce_serie between 1 and 889`),
  ],
);

export const certificadosDigitais = pgTable(
  'certificados_digitais',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    lojaId: uuid('loja_id').notNull(),
    tipo: varchar('tipo', { length: 2 }).notNull().default('A1'),
    arquivoCifrado: bytea('arquivo_cifrado'),
    senhaCifrada: bytea('senha_cifrada'),
    titular: varchar('titular', { length: 150 }).notNull(),
    cnpj: varchar('cnpj', { length: 14 }).notNull(),
    numeroSerie: varchar('numero_serie', { length: 64 }).notNull(),
    emissor: varchar('emissor', { length: 150 }),
    validoDe: timestamptz('valido_de').notNull(),
    validoAte: timestamptz('valido_ate').notNull(),
    impressaoDigital: varchar('impressao_digital', { length: 64 }).notNull(),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_certificados_digitais', columns: [t.id] }),
    foreignKey({
      name: 'fk_certificados_digitais_loja_id',
      columns: [t.lojaId],
      foreignColumns: [lojas.id],
    }),
    index('ix_certificados_digitais_loja_id').on(t.lojaId),
    uniqueIndex('uq_certificados_digitais_loja_ativo')
      .on(t.lojaId)
      .where(sql`ativo and excluido_em is null`),
    check(
      'ck_certificados_digitais_tipo',
      sql`tipo in ('A1','A3') and (tipo = 'A3' or arquivo_cifrado is not null)`,
    ),
    check('ck_certificados_digitais_cnpj', sql`cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'`),
    check('ck_certificados_digitais_validade', sql`valido_ate > valido_de`),
  ],
);

/** Módulo FUT/opcional (comandas/pedidos, roadmap D4): existe desde a Fase 1 para não mudar o protocolo. */
export const impressorasDestino = pgTable(
  'impressoras_destino',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    nome: varchar('nome', { length: 30 }).notNull(),
    descricao: varchar('descricao', { length: 100 }),
    lojaId: uuid('loja_id'),
    ordem: integer('ordem').notNull().default(0),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_impressoras_destino', columns: [t.id] }),
    foreignKey({ name: 'fk_impressoras_destino_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    index('ix_impressoras_destino_loja_id').on(t.lojaId),
    // uq_impressoras_destino_nome (nulls not distinct) fica na migração customizada.
  ],
);

/** Delivery (PDV 26.1), módulo FUT/opcional: existe desde a Fase 1, normalmente vazia. */
export const taxasEntrega = pgTable(
  'taxas_entrega',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    lojaId: uuid('loja_id').notNull(),
    bairro: varchar('bairro', { length: 80 }).notNull(),
    municipioIbge: integer('municipio_ibge').notNull(),
    valor: numeric('valor', { precision: 15, scale: 2 }).notNull(),
    tempoEstimadoMin: smallint('tempo_estimado_min'),
    ativo: boolean('ativo').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_taxas_entrega', columns: [t.id] }),
    foreignKey({ name: 'fk_taxas_entrega_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_taxas_entrega_municipio_ibge',
      columns: [t.municipioIbge],
      foreignColumns: [municipios.codigoIbge],
    }),
    uniqueIndex('uq_taxas_entrega_loja_bairro')
      .on(t.lojaId, t.municipioIbge, sql`lower(fn_unaccent(bairro))`)
      .where(sql`excluido_em is null`),
    index('ix_taxas_entrega_municipio_ibge').on(t.municipioIbge),
    check('ck_taxas_entrega_valor', sql`valor >= 0`),
  ],
);
