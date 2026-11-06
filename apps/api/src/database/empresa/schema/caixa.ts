/**
 * MD 3.12 – caixa: sessões (turnos), movimentos de dinheiro (abertura, reforço, sangria, estorno), fechamentos por
 * forma e a devolução avulsa de cascos (3.12.6). Tudo nasce no PDV e chega por evento (`caixa.*`,
 * `vasilhame.movimentado`, SYNC 9.3–9.6 e 9.26); o ERP só lê e confere (3.12.4, Fase 4). Nada daqui desce ao PDV
 * (`fn_versao_local`); as tabelas são de movimento do `Esquema.g.cs` (`TABELAS_MOVIMENTO_PDV`).
 *
 * Imutabilidade (`fn_protege_imutavel`) de `movimentos_caixa` e `movimentos_vasilhame` fica na migração customizada
 * (0012). `terminais.sessao_caixa_id` continua **sem** FK para `sessoes_caixa` (decisão técnica T8 da 1C): o heartbeat
 * grava a sessão que o PDV informa antes de o `caixa.aberto` chegar.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
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
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { colunasPadrao, timestamptz } from '../../colunas.js';
import { usuarios } from './acesso.js';
import { caixas, lojas } from './estrutura.js';
import { formasPagamento } from './financeiro.js';
import { pessoas } from './pessoas.js';
import { produtos } from './produtos.js';
import { terminais } from './sincronizacao.js';

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));
const quantidade = (nome: string) => numeric(nome, { precision: 15, scale: 3 });
const dinheiro = (nome: string) => numeric(nome, { precision: 15, scale: 2 });

/**
 * `bloqueada_sangria` e `em_fechamento` são estados conceituais da sessão no PDV (PDV 34.2): na Fase 1C o caixa os
 * calcula (o limite de gaveta a cada venda nova, o diálogo do fechamento) e só grava `aberta` e `fechada`, que são os
 * únicos que chegam à nuvem.
 */
export const STATUS_SESSAO_CAIXA = ['aberta', 'bloqueada_sangria', 'em_fechamento', 'fechada'] as const;
export const MOTIVOS_FECHAMENTO_FORCADO = ['substituicao_terminal', 'revogacao_terminal'] as const;

/** D: sessão (turno) de um operador num terminal, da abertura ao fechamento ou à troca de turno (MD 3.12.1). */
export const sessoesCaixa = pgTable(
  'sessoes_caixa',
  {
    ...colunasPadrao(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    numeroCaixa: smallint('numero_caixa').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    operadorId: uuid('operador_id').notNull(),
    status: varchar('status', { length: 18 }).notNull().default('aberta'),
    diaOperacional: date('dia_operacional').notNull(),
    abertaEm: timestamptz('aberta_em').notNull(),
    aberturaAutomatica: boolean('abertura_automatica').notNull().default(false),
    fundoTroco: dinheiro('fundo_troco').notNull().default('0'),
    sessaoAnteriorId: uuid('sessao_anterior_id'),
    valorRecebidoAnterior: dinheiro('valor_recebido_anterior'),
    diferencaRecebimento: dinheiro('diferenca_recebimento'),
    fechadaEm: timestamptz('fechada_em'),
    fechamentoForcado: boolean('fechamento_forcado').notNull().default(false),
    fechamentoForcadoMotivo: varchar('fechamento_forcado_motivo', { length: 30 }),
  },
  (t) => [
    primaryKey({ name: 'pk_sessoes_caixa', columns: [t.id] }),
    foreignKey({ name: 'fk_sessoes_caixa_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_sessoes_caixa_caixa_id', columns: [t.caixaId], foreignColumns: [caixas.id] }),
    foreignKey({
      name: 'fk_sessoes_caixa_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({
      name: 'fk_sessoes_caixa_operador_id',
      columns: [t.operadorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_sessoes_caixa_sessao_anterior_id',
      columns: [t.sessaoAnteriorId],
      foreignColumns: [t.id],
    }),
    // Uma sessão aberta por terminal (não por caixa): o substituto de um PC queimado abre a sua (MD 3.12.1).
    uniqueIndex('uq_sessoes_caixa_aberta')
      .on(t.terminalId)
      .where(sql`status <> 'fechada' and excluido_em is null`),
    index('ix_sessoes_caixa_terminal_id').on(t.terminalId),
    index('ix_sessoes_caixa_caixa_id_status').on(t.caixaId, t.status),
    index('ix_sessoes_caixa_loja_dia').on(t.lojaId, t.diaOperacional),
    index('ix_sessoes_caixa_operador_id').on(t.operadorId),
    index('ix_sessoes_caixa_sessao_anterior_id').on(t.sessaoAnteriorId),
    check('ck_sessoes_caixa_status', sql`status in (${listaSql(STATUS_SESSAO_CAIXA)})`),
    check(
      'ck_sessoes_caixa_forcado',
      sql`not fechamento_forcado or (status = 'fechada' and fechamento_forcado_motivo is not null)`,
    ),
    check(
      'ck_sessoes_caixa_forcado_motivo',
      sql`fechamento_forcado_motivo is null or fechamento_forcado_motivo in (${listaSql(MOTIVOS_FECHAMENTO_FORCADO)})`,
    ),
  ],
);

export const TIPOS_FECHAMENTO_CAIXA = ['fechamento', 'troca_turno'] as const;

export const TIPOS_MOVIMENTO_CAIXA = [
  'abertura',
  'reforco',
  'sangria',
  'sangria_fechamento',
  'devolucao_troca',
  'estorno_venda',
] as const;

/** D: dinheiro que entra ou sai da gaveta numa sessão; imutável fora das colunas de cancelamento (MD 3.12.2). */
export const movimentosCaixa = pgTable(
  'movimentos_caixa',
  {
    ...colunasPadrao(),
    sessaoCaixaId: uuid('sessao_caixa_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    numeroCaixa: smallint('numero_caixa').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    tipo: varchar('tipo', { length: 18 }).notNull(),
    formaPagamentoId: uuid('forma_pagamento_id'),
    valor: dinheiro('valor').notNull(),
    operadorId: uuid('operador_id').notNull(),
    quemRetiraUsuarioId: uuid('quem_retira_usuario_id'),
    quemRetiraNome: varchar('quem_retira_nome', { length: 60 }),
    observacao: varchar('observacao', { length: 255 }),
    infAdicionais: varchar('inf_adicionais', { length: 255 }),
    ocorridoEm: timestamptz('ocorrido_em').notNull(),
    autorizadoPorId: uuid('autorizado_por_id'),
    // → `trocas` (Fase 3) e `movimentos_conta_corrente` (Fase 4): FK quando as tabelas existirem.
    trocaId: uuid('troca_id'),
    cancelado: boolean('cancelado').notNull().default(false),
    canceladoEm: timestamptz('cancelado_em'),
    canceladoPorId: uuid('cancelado_por_id'),
    autorizadoCancelamentoPorId: uuid('autorizado_cancelamento_por_id'),
    motivoCancelamento: varchar('motivo_cancelamento', { length: 255 }),
    movimentoContaCorrenteId: uuid('movimento_conta_corrente_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_movimentos_caixa', columns: [t.id] }),
    foreignKey({
      name: 'fk_movimentos_caixa_sessao_caixa_id',
      columns: [t.sessaoCaixaId],
      foreignColumns: [sessoesCaixa.id],
    }),
    foreignKey({ name: 'fk_movimentos_caixa_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_movimentos_caixa_caixa_id', columns: [t.caixaId], foreignColumns: [caixas.id] }),
    foreignKey({
      name: 'fk_movimentos_caixa_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({
      name: 'fk_movimentos_caixa_forma_pagamento_id',
      columns: [t.formaPagamentoId],
      foreignColumns: [formasPagamento.id],
    }),
    foreignKey({
      name: 'fk_movimentos_caixa_operador_id',
      columns: [t.operadorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_movimentos_caixa_quem_retira_usuario_id',
      columns: [t.quemRetiraUsuarioId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_movimentos_caixa_autorizado_por_id',
      columns: [t.autorizadoPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_movimentos_caixa_cancelado_por_id',
      columns: [t.canceladoPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_movimentos_caixa_autorizado_cancelamento_por_id',
      columns: [t.autorizadoCancelamentoPorId],
      foreignColumns: [usuarios.id],
    }),
    index('ix_movimentos_caixa_sessao_caixa_id').on(t.sessaoCaixaId),
    index('ix_movimentos_caixa_loja_ocorrido').on(t.lojaId, t.ocorridoEm),
    index('ix_movimentos_caixa_caixa_id').on(t.caixaId),
    index('ix_movimentos_caixa_terminal_id').on(t.terminalId),
    index('ix_movimentos_caixa_forma_pagamento_id').on(t.formaPagamentoId),
    index('ix_movimentos_caixa_operador_id').on(t.operadorId),
    index('ix_movimentos_caixa_quem_retira_usuario_id').on(t.quemRetiraUsuarioId),
    index('ix_movimentos_caixa_autorizado_por_id').on(t.autorizadoPorId),
    index('ix_movimentos_caixa_cancelado_por_id').on(t.canceladoPorId),
    index('ix_movimentos_caixa_autorizado_cancelamento_por_id').on(t.autorizadoCancelamentoPorId),
    check('ck_movimentos_caixa_tipo', sql`tipo in (${listaSql(TIPOS_MOVIMENTO_CAIXA)})`),
    check('ck_movimentos_caixa_valor', sql`valor > 0`),
    check(
      'ck_movimentos_caixa_sangria',
      sql`tipo <> 'sangria' or quem_retira_usuario_id is not null or quem_retira_nome is not null`,
    ),
    check(
      'ck_movimentos_caixa_estorno_forma',
      sql`tipo <> 'estorno_venda' or forma_pagamento_id is not null`,
    ),
    check(
      'ck_movimentos_caixa_cancelado',
      sql`not cancelado or (cancelado_em is not null and motivo_cancelamento is not null)`,
    ),
  ],
);

/** D: fechamento ou troca de turno, um por sessão (MD 3.12.3); `diferenca` é coluna gerada. */
export const fechamentosCaixa = pgTable(
  'fechamentos_caixa',
  {
    ...colunasPadrao(),
    sessaoCaixaId: uuid('sessao_caixa_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    numeroCaixa: smallint('numero_caixa').notNull(),
    tipo: varchar('tipo', { length: 12 }).notNull(),
    zeraCaixa: boolean('zera_caixa').notNull(),
    usuarioAnteriorId: uuid('usuario_anterior_id').notNull(),
    usuarioSubsequenteId: uuid('usuario_subsequente_id'),
    valorCaixa: dinheiro('valor_caixa').notNull().default('0'),
    totalCalculado: dinheiro('total_calculado').notNull(),
    totalDigitado: dinheiro('total_digitado').notNull(),
    diferenca: dinheiro('diferenca')
      .notNull()
      .generatedAlwaysAs(sql`total_digitado - total_calculado`),
    justificativa: varchar('justificativa', { length: 255 }),
    recontagem: boolean('recontagem').notNull().default(false),
    fechamentoCego: boolean('fechamento_cego').notNull(),
    ocorridoEm: timestamptz('ocorrido_em').notNull(),
    diaOperacional: date('dia_operacional').notNull(),
    resumo: jsonb('resumo')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    primaryKey({ name: 'pk_fechamentos_caixa', columns: [t.id] }),
    foreignKey({
      name: 'fk_fechamentos_caixa_sessao_caixa_id',
      columns: [t.sessaoCaixaId],
      foreignColumns: [sessoesCaixa.id],
    }),
    foreignKey({ name: 'fk_fechamentos_caixa_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_fechamentos_caixa_caixa_id', columns: [t.caixaId], foreignColumns: [caixas.id] }),
    foreignKey({
      name: 'fk_fechamentos_caixa_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({
      name: 'fk_fechamentos_caixa_usuario_anterior_id',
      columns: [t.usuarioAnteriorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_fechamentos_caixa_usuario_subsequente_id',
      columns: [t.usuarioSubsequenteId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_fechamentos_caixa_sessao_caixa_id').on(t.sessaoCaixaId),
    index('ix_fechamentos_caixa_loja_dia').on(t.lojaId, t.diaOperacional),
    index('ix_fechamentos_caixa_caixa_id').on(t.caixaId),
    index('ix_fechamentos_caixa_terminal_id').on(t.terminalId),
    index('ix_fechamentos_caixa_usuario_anterior_id').on(t.usuarioAnteriorId),
    index('ix_fechamentos_caixa_usuario_subsequente_id').on(t.usuarioSubsequenteId),
    check('ck_fechamentos_caixa_tipo', sql`tipo in (${listaSql(TIPOS_FECHAMENTO_CAIXA)})`),
    check('ck_fechamentos_caixa_zera', sql`zera_caixa = (tipo = 'fechamento')`),
  ],
);

/** Valores por forma de pagamento de um fechamento (MD 3.12.3). */
export const fechamentosCaixaFormas = pgTable(
  'fechamentos_caixa_formas',
  {
    ...colunasPadrao(),
    fechamentoId: uuid('fechamento_id').notNull(),
    formaPagamentoId: uuid('forma_pagamento_id').notNull(),
    descricaoForma: varchar('descricao_forma', { length: 40 }).notNull(),
    tipoForma: varchar('tipo_forma', { length: 20 }).notNull(),
    valorCalculado: dinheiro('valor_calculado').notNull(),
    valorDigitado: dinheiro('valor_digitado').notNull(),
    diferenca: dinheiro('diferenca')
      .notNull()
      .generatedAlwaysAs(sql`valor_digitado - valor_calculado`),
    quantidadePagamentos: integer('quantidade_pagamentos').notNull().default(0),
    preenchidoAutomatico: boolean('preenchido_automatico').notNull().default(false),
    valorPrimeiraContagem: dinheiro('valor_primeira_contagem'),
  },
  (t) => [
    primaryKey({ name: 'pk_fechamentos_caixa_formas', columns: [t.id] }),
    foreignKey({
      name: 'fk_fechamentos_caixa_formas_fechamento_id',
      columns: [t.fechamentoId],
      foreignColumns: [fechamentosCaixa.id],
    }),
    foreignKey({
      name: 'fk_fechamentos_caixa_formas_forma_pagamento_id',
      columns: [t.formaPagamentoId],
      foreignColumns: [formasPagamento.id],
    }),
    uniqueIndex('uq_fechamentos_caixa_formas').on(t.fechamentoId, t.formaPagamentoId),
    index('ix_fechamentos_caixa_formas_forma_pagamento_id').on(t.formaPagamentoId),
    check('ck_fechamentos_caixa_formas_quantidade', sql`quantidade_pagamentos >= 0`),
  ],
);

/**
 * Destino da devolução avulsa de cascos (MD 3.12.6, SYNC 9.26). `entrada` (decisão técnica T2 da 1C; dono, O14) é
 * a da Fase 1: só a entrada dos vazios no estoque, sem comodato nem vale; `baixa_comodato` e `vale` são da Fase 3.
 */
export const DESTINOS_MOVIMENTO_VASILHAME = ['entrada', 'baixa_comodato', 'vale'] as const;

/** D: devolução avulsa de cascos vazios, sem compra (MD 3.12.6); imutável fora das colunas de cancelamento. */
export const movimentosVasilhame = pgTable(
  'movimentos_vasilhame',
  {
    ...colunasPadrao(),
    sessaoCaixaId: uuid('sessao_caixa_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    operadorId: uuid('operador_id').notNull(),
    pessoaId: uuid('pessoa_id'),
    produtoVasilhameId: uuid('produto_vasilhame_id').notNull(),
    quantidade: quantidade('quantidade').notNull(),
    destino: varchar('destino', { length: 14 }).notNull(),
    // → `vales` (Fase 3): FK quando a tabela existir.
    valeId: uuid('vale_id'),
    ocorridoEm: timestamptz('ocorrido_em').notNull(),
    cancelado: boolean('cancelado').notNull().default(false),
    canceladoEm: timestamptz('cancelado_em'),
    canceladoPorId: uuid('cancelado_por_id'),
    motivoCancelamento: varchar('motivo_cancelamento', { length: 255 }),
  },
  (t) => [
    primaryKey({ name: 'pk_movimentos_vasilhame', columns: [t.id] }),
    foreignKey({
      name: 'fk_movimentos_vasilhame_sessao_caixa_id',
      columns: [t.sessaoCaixaId],
      foreignColumns: [sessoesCaixa.id],
    }),
    foreignKey({ name: 'fk_movimentos_vasilhame_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_movimentos_vasilhame_caixa_id',
      columns: [t.caixaId],
      foreignColumns: [caixas.id],
    }),
    foreignKey({
      name: 'fk_movimentos_vasilhame_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({
      name: 'fk_movimentos_vasilhame_operador_id',
      columns: [t.operadorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_movimentos_vasilhame_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({
      name: 'fk_movimentos_vasilhame_produto_vasilhame_id',
      columns: [t.produtoVasilhameId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_movimentos_vasilhame_cancelado_por_id',
      columns: [t.canceladoPorId],
      foreignColumns: [usuarios.id],
    }),
    index('ix_movimentos_vasilhame_sessao_caixa_id').on(t.sessaoCaixaId),
    index('ix_movimentos_vasilhame_pessoa_id').on(t.pessoaId),
    index('ix_movimentos_vasilhame_loja_ocorrido').on(t.lojaId, t.ocorridoEm),
    index('ix_movimentos_vasilhame_caixa_id').on(t.caixaId),
    index('ix_movimentos_vasilhame_terminal_id').on(t.terminalId),
    index('ix_movimentos_vasilhame_operador_id').on(t.operadorId),
    index('ix_movimentos_vasilhame_produto_vasilhame_id').on(t.produtoVasilhameId),
    index('ix_movimentos_vasilhame_cancelado_por_id').on(t.canceladoPorId),
    check('ck_movimentos_vasilhame_quantidade', sql`quantidade > 0`),
    check('ck_movimentos_vasilhame_destino', sql`destino in (${listaSql(DESTINOS_MOVIMENTO_VASILHAME)})`),
    check('ck_movimentos_vasilhame_comodato', sql`destino <> 'baixa_comodato' or pessoa_id is not null`),
    check('ck_movimentos_vasilhame_vale', sql`(destino = 'vale') = (vale_id is not null)`),
    check(
      'ck_movimentos_vasilhame_cancelado',
      sql`not cancelado or (cancelado_em is not null and motivo_cancelamento is not null)`,
    ),
  ],
);
