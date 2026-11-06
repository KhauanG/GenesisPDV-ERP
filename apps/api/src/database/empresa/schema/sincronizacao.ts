/** MD 3.15 – sincronização e terminais (lado da empresa). Nada daqui desce ao PDV (MD 6.2). */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  inet,
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
import { colunasAutoria, colunasLog, colunasLogMutavel, colunasPadrao, timestamptz } from '../../colunas.js';
import { caixas, lojas } from './estrutura.js';
import { numeracoes } from './sistema.js';

export const terminais = pgTable(
  'terminais',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    descricao: varchar('descricao', { length: 40 }),
    status: varchar('status', { length: 12 }).notNull().default('ativo'),
    nomeMaquina: varchar('nome_maquina', { length: 100 }),
    sistemaOperacional: varchar('sistema_operacional', { length: 60 }),
    idHardware: varchar('id_hardware', { length: 128 }),
    versaoApp: varchar('versao_app', { length: 20 }),
    ativadoEm: timestamptz('ativado_em').notNull(),
    ativadoPorId: uuid('ativado_por_id'),
    revogadoEm: timestamptz('revogado_em'),
    revogadoPorId: uuid('revogado_por_id'),
    motivoRevogacao: varchar('motivo_revogacao', { length: 255 }),
    ultimoContatoEm: timestamptz('ultimo_contato_em'),
    ultimoIp: inet('ultimo_ip'),
    ultimoPullEm: timestamptz('ultimo_pull_em'),
    ultimoPushEm: timestamptz('ultimo_push_em'),
    cursorPull: jsonb('cursor_pull'),
    eventosPendentes: integer('eventos_pendentes').notNull().default(0),
    eventoMaisAntigoEm: timestamptz('evento_mais_antigo_em'),
    nfceContingenciaPendentes: integer('nfce_contingencia_pendentes').notNull().default(0),
    nfceContingenciaMaisAntigaEm: timestamptz('nfce_contingencia_mais_antiga_em'),
    nfceUltimoNumero: integer('nfce_ultimo_numero'),
    ultimaSequenciaGerada: bigint('ultima_sequencia_gerada', { mode: 'number' }),
    vendaUltimoNumero: bigint('venda_ultimo_numero', { mode: 'number' }),
    valeUltimoNumero: bigint('vale_ultimo_numero', { mode: 'number' }),
    eventosRejeitados: integer('eventos_rejeitados').notNull().default(0),
    inutilizacoesPendentes: integer('inutilizacoes_pendentes').notNull().default(0),
    discoLivreMb: integer('disco_livre_mb'),
    tamanhoBancoMb: integer('tamanho_banco_mb'),
    filaImpressaoPendentes: integer('fila_impressao_pendentes').notNull().default(0),
    sseConectado: boolean('sse_conectado'),
    versaoSchemaLocal: integer('versao_schema_local'),
    dinheiroEstimadoGaveta: numeric('dinheiro_estimado_gaveta', { precision: 15, scale: 2 }),
    relogioConfiavel: boolean('relogio_confiavel'),
    estadoLocal: varchar('estado_local', { length: 25 }),
    desativacaoConfirmadaEm: timestamptz('desativacao_confirmada_em'),
    desativacaoUltimaSequencia: bigint('desativacao_ultima_sequencia', { mode: 'number' }),
    desativacaoVendaUltimoNumero: bigint('desativacao_venda_ultimo_numero', { mode: 'number' }),
    desativacaoValeUltimoNumero: bigint('desativacao_vale_ultimo_numero', { mode: 'number' }),
    desativacaoNfceUltimoNumero: jsonb('desativacao_nfce_ultimo_numero'),
    vendasCancelamentoPendente: uuid('vendas_cancelamento_pendente')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    configuracaoLocal: jsonb('configuracao_local'),
    desvioRelogioMs: integer('desvio_relogio_ms'),
    certificadoValidade: timestamptz('certificado_validade'),
    sessaoCaixaId: uuid('sessao_caixa_id'),
    operadorId: uuid('operador_id'),
    ultimoErro: text('ultimo_erro'),
  },
  (t) => [
    primaryKey({ name: 'pk_terminais', columns: [t.id] }),
    foreignKey({ name: 'fk_terminais_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_terminais_caixa_id', columns: [t.caixaId], foreignColumns: [caixas.id] }),
    index('ix_terminais_loja_id').on(t.lojaId),
    index('ix_terminais_caixa_id').on(t.caixaId),
    uniqueIndex('uq_terminais_caixa_ativo')
      .on(t.caixaId)
      .where(sql`status = 'ativo' and excluido_em is null`),
    check('ck_terminais_status', sql`status in ('ativo','desativando','revogado')`),
    check(
      'ck_terminais_estado_local',
      sql`estado_local is null or estado_local in ('ativo','desativando','desativando_confirmado')`,
    ),
  ],
);

export const STATUS_EVENTO_RECEBIDO = ['recebido', 'aplicado', 'erro', 'retido', 'descartado'] as const;

export const eventosRecebidos = pgTable(
  'eventos_recebidos',
  {
    ...colunasLogMutavel(),
    eventoId: uuid('evento_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    lojaId: uuid('loja_id').notNull(),
    sequenciaTerminal: bigint('sequencia_terminal', { mode: 'number' }).notNull(),
    tipo: varchar('tipo', { length: 40 }).notNull(),
    versaoSchema: smallint('versao_schema').notNull(),
    agregadoTipo: varchar('agregado_tipo', { length: 30 }).notNull(),
    agregadoId: uuid('agregado_id').notNull(),
    dependencias: jsonb('dependencias'),
    loteId: uuid('lote_id'),
    ocorridoEm: timestamptz('ocorrido_em').notNull(),
    ocorridoEmLocal: timestamptz('ocorrido_em_local'),
    status: varchar('status', { length: 12 }).notNull().default('recebido'),
    tentativas: smallint('tentativas').notNull().default(0),
    erroCodigo: varchar('erro_codigo', { length: 40 }),
    erro: text('erro'),
    payload: jsonb('payload'),
    /**
     * Envelope recebido sem o `payload` (que tem coluna própria): `usuario_id`, `contexto`, relógio (`desvio_relogio_ms`,
     * `relogio_confiavel`, `relogio_regrediu`). Reprocessar, recuperar (SYNC 22.2) e as regras de relógio (12.4) leem
     * daqui; `{}` nas linhas anteriores à migração 0010.
     */
    envelope: jsonb('envelope')
      .notNull()
      .default(sql`'{}'::jsonb`),
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    resultado: jsonb('resultado'),
    versaoNuvem: bigint('versao_nuvem', { mode: 'number' }),
    versaoNuvemFim: bigint('versao_nuvem_fim', { mode: 'number' }),
    aplicadoEm: timestamptz('aplicado_em'),
    resolucaoEntregueEm: timestamptz('resolucao_entregue_em'),
    descartadoEm: timestamptz('descartado_em'),
    descartadoPorId: uuid('descartado_por_id'),
    justificativaDescarte: text('justificativa_descarte'),
  },
  (t) => [
    primaryKey({ name: 'pk_eventos_recebidos', columns: [t.id] }),
    foreignKey({
      name: 'fk_eventos_recebidos_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    uniqueIndex('uq_eventos_recebidos_evento_id').on(t.eventoId),
    uniqueIndex('uq_eventos_recebidos_terminal_sequencia').on(t.terminalId, t.sequenciaTerminal),
    index('ix_eventos_recebidos_status')
      .on(t.terminalId, t.status)
      .where(sql`status in ('erro','retido')`),
    index('ix_eventos_recebidos_agregado').on(t.terminalId, t.agregadoTipo, t.agregadoId),
    index('ix_eventos_recebidos_lote_id').on(t.loteId),
    index('ix_eventos_recebidos_versao_nuvem_fim')
      .on(t.versaoNuvemFim)
      .where(sql`versao_nuvem_fim is not null`),
    check('ck_eventos_recebidos_status', sql`status in ('recebido','aplicado','erro','retido','descartado')`),
  ],
);

export const TIPOS_COMANDO_TERMINAL = [
  'revogar',
  'ressincronizar',
  'ressincronizar_fluxo',
  'enviar_logs',
  'atualizar_app',
  'mensagem',
  'reservar_faixa',
] as const;

export const comandosTerminal = pgTable(
  'comandos_terminal',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    terminalId: uuid('terminal_id').notNull(),
    tipo: varchar('tipo', { length: 20 }).notNull(),
    parametros: jsonb('parametros')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: varchar('status', { length: 10 }).notNull().default('pendente'),
    entregueEm: timestamptz('entregue_em'),
    executadoEm: timestamptz('executado_em'),
    resultado: jsonb('resultado'),
  },
  (t) => [
    primaryKey({ name: 'pk_comandos_terminal', columns: [t.id] }),
    foreignKey({
      name: 'fk_comandos_terminal_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    index('ix_comandos_terminal_pendentes')
      .on(t.terminalId)
      .where(sql`status in ('pendente','entregue')`),
    check(
      'ck_comandos_terminal_tipo',
      sql`tipo in ('revogar','ressincronizar','ressincronizar_fluxo','enviar_logs','atualizar_app','mensagem','reservar_faixa')`,
    ),
    check(
      'ck_comandos_terminal_status',
      sql`status in ('pendente','entregue','executado','falhou','cancelado')`,
    ),
  ],
);

export const entidadesEvento = pgTable(
  'entidades_evento',
  {
    ...colunasLog(),
    entidadeTipo: varchar('entidade_tipo', { length: 30 }).notNull(),
    entidadeId: uuid('entidade_id').notNull(),
    eventoId: uuid('evento_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_entidades_evento', columns: [t.id] }),
    foreignKey({
      name: 'fk_entidades_evento_evento_id',
      columns: [t.eventoId],
      foreignColumns: [eventosRecebidos.eventoId],
    }),
    foreignKey({
      name: 'fk_entidades_evento_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    uniqueIndex('uq_entidades_evento').on(t.entidadeTipo, t.entidadeId, t.eventoId),
    index('ix_entidades_evento_evento_id').on(t.eventoId),
    index('ix_entidades_evento_terminal_id').on(t.terminalId),
  ],
);

/**
 * MD 3.1.5 – faixas de números reservadas para um terminal usar offline (comandas com numeração automática). Fica aqui
 * por referenciar `terminais`.
 */
export const numeracoesFaixas = pgTable(
  'numeracoes_faixas',
  {
    ...colunasPadrao(),
    numeracaoId: uuid('numeracao_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    inicio: bigint('inicio', { mode: 'number' }).notNull(),
    fim: bigint('fim', { mode: 'number' }).notNull(),
    status: varchar('status', { length: 12 }).notNull().default('ativa'),
    ultimoUsado: bigint('ultimo_usado', { mode: 'number' }),
  },
  (t) => [
    primaryKey({ name: 'pk_numeracoes_faixas', columns: [t.id] }),
    foreignKey({
      name: 'fk_numeracoes_faixas_numeracao_id',
      columns: [t.numeracaoId],
      foreignColumns: [numeracoes.id],
    }),
    foreignKey({
      name: 'fk_numeracoes_faixas_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    index('ix_numeracoes_faixas_numeracao_id').on(t.numeracaoId),
    index('ix_numeracoes_faixas_terminal_id_status').on(t.terminalId, t.status),
    check('ck_numeracoes_faixas_fim', sql`fim >= inicio`),
    check('ck_numeracoes_faixas_status', sql`status in ('ativa','esgotada','devolvida')`),
    check(
      'ck_numeracoes_faixas_ultimo_usado',
      sql`ultimo_usado is null or ultimo_usado between inicio and fim`,
    ),
  ],
);
