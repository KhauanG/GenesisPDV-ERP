/**
 * Partes do MD 3.9 (plano de contas e restrição por loja, contas correntes) e 3.10 (formas de pagamento, atalhos do
 * PDV) exigidas pelo seed da Fase 0 (MD 7.5–7.8) e pelo assistente de lojas da Fase 1 (MD 7.13).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
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
import { colunasAutoria, colunasPadrao } from '../../colunas.js';
import { lojas } from './estrutura.js';
import { bancos, meiosPagamentoFiscais } from './referencias.js';

export const planosContas = pgTable(
  'planos_contas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: varchar('codigo', { length: 20 }).notNull(),
    nome: varchar('nome', { length: 80 }).notNull(),
    tipo: varchar('tipo', { length: 7 }).notNull(),
    natureza: varchar('natureza', { length: 10 }).notNull().default('analitica'),
    paiId: uuid('pai_id'),
    ordem: integer('ordem').notNull().default(0),
    ativo: boolean('ativo').notNull().default(true),
    chaveSistema: varchar('chave_sistema', { length: 30 }),
  },
  (t) => [
    primaryKey({ name: 'pk_planos_contas', columns: [t.id] }),
    foreignKey({ name: 'fk_planos_contas_pai_id', columns: [t.paiId], foreignColumns: [t.id] }),
    index('ix_planos_contas_pai_id').on(t.paiId),
    uniqueIndex('uq_planos_contas_codigo')
      .on(t.codigo)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_planos_contas_chave_sistema')
      .on(t.chaveSistema)
      .where(sql`chave_sistema is not null`),
    check('ck_planos_contas_tipo', sql`tipo in ('receita','despesa','passivo')`),
    check('ck_planos_contas_natureza', sql`natureza in ('sintetica','analitica')`),
    check('ck_planos_contas_raiz', sql`pai_id is not null or natureza = 'sintetica'`),
  ],
);

/** Restrição do plano de contas por loja (MD 3.9.1); sem linhas = vale para todas. */
export const planosContasLojas = pgTable(
  'planos_contas_lojas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    planoContasId: uuid('plano_contas_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_planos_contas_lojas', columns: [t.id] }),
    foreignKey({
      name: 'fk_planos_contas_lojas_plano_contas_id',
      columns: [t.planoContasId],
      foreignColumns: [planosContas.id],
    }),
    foreignKey({ name: 'fk_planos_contas_lojas_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    uniqueIndex('uq_planos_contas_lojas')
      .on(t.planoContasId, t.lojaId)
      .where(sql`excluido_em is null`),
    index('ix_planos_contas_lojas_loja_id').on(t.lojaId),
  ],
);

export const contasCorrentes = pgTable(
  'contas_correntes',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    tipo: varchar('tipo', { length: 16 }).notNull().default('conta_corrente'),
    bancoCodigo: varchar('banco_codigo', { length: 3 }),
    descricao: varchar('descricao', { length: 60 }).notNull(),
    agencia: varchar('agencia', { length: 10 }),
    agenciaDigito: varchar('agencia_digito', { length: 2 }),
    conta: varchar('conta', { length: 20 }),
    contaDigito: varchar('conta_digito', { length: 2 }),
    carteira: varchar('carteira', { length: 5 }),
    convenioBoleto: varchar('convenio_boleto', { length: 30 }),
    chavePix: varchar('chave_pix', { length: 77 }),
    saldoInicial: numeric('saldo_inicial', { precision: 15, scale: 2 }).notNull().default('0'),
    dataSaldo: date('data_saldo')
      .notNull()
      .default(sql`current_date`),
    saldoAtual: numeric('saldo_atual', { precision: 15, scale: 2 }).notNull().default('0'),
    lojaId: uuid('loja_id'),
    ativa: boolean('ativa').notNull().default(true),
    chaveSistema: varchar('chave_sistema', { length: 60 }),
  },
  (t) => [
    primaryKey({ name: 'pk_contas_correntes', columns: [t.id] }),
    foreignKey({
      name: 'fk_contas_correntes_banco_codigo',
      columns: [t.bancoCodigo],
      foreignColumns: [bancos.codigo],
    }),
    foreignKey({ name: 'fk_contas_correntes_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    index('ix_contas_correntes_banco_codigo').on(t.bancoCodigo),
    index('ix_contas_correntes_loja_id').on(t.lojaId),
    uniqueIndex('uq_contas_correntes_descricao')
      .on(sql`lower(descricao)`)
      .where(sql`excluido_em is null`),
    uniqueIndex('uq_contas_correntes_chave_sistema')
      .on(t.chaveSistema)
      .where(sql`chave_sistema is not null`),
    check(
      'ck_contas_correntes_tipo',
      sql`tipo in ('caixa','conta_corrente','poupanca','aplicacao','carteira_digital','adquirente')`,
    ),
    check('ck_contas_correntes_banco', sql`tipo = 'caixa' or banco_codigo is not null`),
  ],
);

export const TIPOS_FORMA_PAGAMENTO = [
  'dinheiro',
  'cartao_credito',
  'cartao_debito',
  'pix',
  'crediario',
  'credito_funcionario',
  'vale',
  'vale_alimentacao',
  'vale_refeicao',
  'boleto',
  'cheque',
  'consumo_interno',
  'outros',
] as const;

export const formasPagamento = pgTable(
  'formas_pagamento',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    descricao: varchar('descricao', { length: 40 }).notNull(),
    ordem: integer('ordem').notNull().default(0),
    tipoForma: varchar('tipo_forma', { length: 20 }).notNull().default('outros'),
    meioPagamentoFiscal: varchar('meio_pagamento_fiscal', { length: 2 }).notNull(),
    descricaoFiscal: varchar('descricao_fiscal', { length: 60 }),
    integracao: varchar('integracao', { length: 12 }).notNull().default('nenhuma'),
    tipoPinpad: varchar('tipo_pinpad', { length: 7 }),
    taxaPct: numeric('taxa_pct', { precision: 7, scale: 4 }).notNull().default('0'),
    diasRecebimento: smallint('dias_recebimento').notNull().default(0),
    contaCorrenteId: uuid('conta_corrente_id'),
    planoContasId: uuid('plano_contas_id'),
    senhaLiberacaoHash: varchar('senha_liberacao_hash', { length: 255 }),
    sempreZeradoPdv: boolean('sempre_zerado_pdv').notNull().default(false),
    lancaQuitada: boolean('lanca_quitada').notNull().default(true),
    permiteTroco: boolean('permite_troco').notNull().default(false),
    eBoleto: boolean('e_boleto').notNull().default(false),
    exigePessoa: boolean('exige_pessoa').notNull().default(false),
    ativa: boolean('ativa').notNull().default(true),
    abrirGaveta: boolean('abrir_gaveta').notNull().default(false),
    usaPdv: boolean('usa_pdv').notNull().default(true),
    usaTotem: boolean('usa_totem').notNull().default(false),
    usaMenuDigital: boolean('usa_menu_digital').notNull().default(false),
    creditoFuncionario: boolean('credito_funcionario').notNull().default(false),
    permiteParcelar: boolean('permite_parcelar').notNull().default(false),
    parcelasMaximo: smallint('parcelas_maximo').notNull().default(1),
    parcelaValorMinimo: numeric('parcela_valor_minimo', { precision: 15, scale: 2 }),
    geraQrcodePix: boolean('gera_qrcode_pix').notNull().default(false),
    aPrazo: boolean('a_prazo').notNull().default(false),
    valeCompra: boolean('vale_compra').notNull().default(false),
    exigeDadosPos: boolean('exige_dados_pos').notNull().default(false),
    restringeIdadeMinima: boolean('restringe_idade_minima').notNull().default(false),
    // Fase 1C (C8b, O9a): o PDV pede a liberação de um supervisor (PIN, PDV 31.3) para lançar a forma.
    exigeSupervisor: boolean('exige_supervisor').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'pk_formas_pagamento', columns: [t.id] }),
    foreignKey({
      name: 'fk_formas_pagamento_meio_pagamento_fiscal',
      columns: [t.meioPagamentoFiscal],
      foreignColumns: [meiosPagamentoFiscais.codigo],
    }),
    foreignKey({
      name: 'fk_formas_pagamento_conta_corrente_id',
      columns: [t.contaCorrenteId],
      foreignColumns: [contasCorrentes.id],
    }),
    foreignKey({
      name: 'fk_formas_pagamento_plano_contas_id',
      columns: [t.planoContasId],
      foreignColumns: [planosContas.id],
    }),
    index('ix_formas_pagamento_meio_pagamento_fiscal').on(t.meioPagamentoFiscal),
    index('ix_formas_pagamento_conta_corrente_id').on(t.contaCorrenteId),
    index('ix_formas_pagamento_plano_contas_id').on(t.planoContasId),
    check(
      'ck_formas_pagamento_tipo_forma',
      sql`tipo_forma in (${sql.raw(TIPOS_FORMA_PAGAMENTO.map((v) => `'${v}'`).join(','))})`,
    ),
    check(
      'ck_formas_pagamento_integracao',
      sql`integracao in ('nenhuma','tef','pos_externo','pix_dinamico','pix_estatico')`,
    ),
    check('ck_formas_pagamento_tipo_pinpad', sql`tipo_pinpad is null or integracao = 'tef'`),
    check(
      'ck_formas_pagamento_parcelas',
      sql`parcelas_maximo between 1 and 48 and (permite_parcelar or parcelas_maximo = 1)`,
    ),
    check('ck_formas_pagamento_a_prazo', sql`not a_prazo or (exige_pessoa and not lanca_quitada)`),
    check(
      'ck_formas_pagamento_credito_funcionario',
      sql`not credito_funcionario or (exige_pessoa and not lanca_quitada)`,
    ),
    check('ck_formas_pagamento_boleto', sql`not e_boleto or exige_pessoa`),
    check('ck_formas_pagamento_taxa', sql`taxa_pct between 0 and 100`),
    check(
      'ck_formas_pagamento_consumo_interno',
      sql`tipo_forma <> 'consumo_interno' or (lanca_quitada and plano_contas_id is not null and not permite_troco and not abrir_gaveta and not exige_pessoa and meio_pagamento_fiscal = '90')`,
    ),
    // O23 (dono, 1C): cartão e PIX não passam do total; troco só em forma sem integração (maquininha/TEF/PIX).
    check(
      'ck_formas_pagamento_troco',
      sql`not permite_troco or (integracao = 'nenhuma' and tipo_forma not in ('cartao_credito','cartao_debito','pix'))`,
    ),
  ],
);

/**
 * Lojas em que a forma vale (MD 3.10.1; Fase 1C, C8b, O9a/D25). Uma linha com `loja_id` nulo = todas as lojas (mesmo
 * desenho de `pessoas_relevancia_loja`): a troca de "todas" para lojas escolhidas exclui essa linha, e a exclusão desce
 * aos caixas das outras lojas, que deixam de oferecer a forma. Sem linha viva, a forma não vale em loja nenhuma.
 * `uq_formas_pagamento_lojas` (`nulls not distinct`) fica na migração customizada (0014).
 */
export const formasPagamentoLojas = pgTable(
  'formas_pagamento_lojas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    formaPagamentoId: uuid('forma_pagamento_id').notNull(),
    lojaId: uuid('loja_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_formas_pagamento_lojas', columns: [t.id] }),
    foreignKey({
      name: 'fk_formas_pagamento_lojas_forma_pagamento_id',
      columns: [t.formaPagamentoId],
      foreignColumns: [formasPagamento.id],
    }),
    foreignKey({
      name: 'fk_formas_pagamento_lojas_loja_id',
      columns: [t.lojaId],
      foreignColumns: [lojas.id],
    }),
    index('ix_formas_pagamento_lojas_loja_id').on(t.lojaId),
  ],
);

export const atalhosPdv = pgTable(
  'atalhos_pdv',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    lojaId: uuid('loja_id'),
    acao: varchar('acao', { length: 40 }).notNull(),
    tecla: varchar('tecla', { length: 30 }).notNull(),
    habilitado: boolean('habilitado').notNull().default(true),
    ordem: integer('ordem').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_atalhos_pdv', columns: [t.id] }),
    foreignKey({ name: 'fk_atalhos_pdv_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    index('ix_atalhos_pdv_loja_id').on(t.lojaId),
  ],
);
