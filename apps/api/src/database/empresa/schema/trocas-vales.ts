/**
 * MD 3.13 – trocas e vales (Fase 3, F3-B1; migração 0029; README da API › decisão 220), mais as reservas de saldo
 * dos caixas online (SYNC 14.4) e o registro das requisições online que alteram estado (SYNC 20.4). Este bloco cria
 * só o esquema: os eventos `troca.registrada` e `vale.*`, as reservas e a idempotência vêm nos F3-B6, B41 a B45.
 *
 * Quem desce ao PDV: só `vales` (C, ↕; `fn_versao` com a trava de ordenação). O fluxo que a lê (`pessoas`, com o filtro
 * da D90) entra no F3-B7: até lá ela fica em `TABELAS_FN_VERSAO_SEM_FLUXO` (`versionamento.ts`) e o `Esquema.g.cs` não
 * muda. `trocas`, `itens_troca` e `movimentos_vale` sobem por evento (D, ↑) e `reservas_vale` não sai da nuvem (C, —):
 * `fn_versao_local`. `requisicoes_terminal` é log técnico, sem `versao`.
 *
 * Sem FK nas colunas que o PDV envia e que apontam para documento de outro evento (`trocas.venda_origem_id`,
 * `itens_troca.item_venda_origem_id`, `movimentos_vale.venda_id`/`pagamento_venda_id`/`troca_id`,
 * `reservas_vale.venda_id`/`pagamento_venda_id`, `vales.origem_id`): a ordem entre terminais não é garantida e um
 * 23503 recusaria um fato consumado; o handler confere e abre alerta (padrões da Fase 3). As FKs que ficam apontam
 * para cadastro (loja, caixa, terminal, usuário, pessoa, produto, lote) ou para linha do mesmo evento (o vale e o
 * movimento de caixa da troca). Imutabilidade, sequência do `codigo` e exclusão física proibida: na migração (0029).
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
import { movimentosCaixa, sessoesCaixa } from './caixa.js';
import { caixas, lojas } from './estrutura.js';
import { pessoas } from './pessoas.js';
import { produtos, produtosLotes, produtosVariacoes } from './produtos.js';
import { terminais } from './sincronizacao.js';
import { vendas } from './vendas.js';

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));
const quantidade = (nome: string) => numeric(nome, { precision: 15, scale: 3 });
const preco = (nome: string) => numeric(nome, { precision: 15, scale: 4 });
const dinheiro = (nome: string) => numeric(nome, { precision: 15, scale: 2 });

/** `pdv`: troca no caixa (`troca.registrada`); `erp`: devolução registrada no ERP (caixa 0, sem terminal nem sessão). */
export const ORIGENS_TROCA = ['pdv', 'erp'] as const;
export const RESOLUCOES_TROCA = ['troca_imediata', 'vale_troca', 'dinheiro'] as const;
export const STATUS_TROCA = ['registrada', 'cancelada'] as const;
/** Para onde vai o produto devolvido (D93): volta ao estoque ou avaria. */
export const DESTINOS_ITEM_TROCA = ['estoque', 'avaria'] as const;
export const TIPOS_VALE = ['vale_troca', 'vale_compra'] as const;
export const STATUS_VALE = ['ativo', 'utilizado', 'expirado', 'cancelado'] as const;
export const ORIGENS_VALE = ['troca', 'manual', 'venda'] as const;
export const TIPOS_MOVIMENTO_VALE = [
  'emissao',
  'utilizacao',
  'estorno_utilizacao',
  'cancelamento',
  'expiracao',
  'ajuste',
] as const;
export const STATUS_RESERVA_VALE = ['ativa', 'consumida', 'liberada', 'expirada'] as const;

/** Formato do código do vale (MD 3.13.2, SYNC 13.4): `VC` + loja(2) + caixa(2) + sequencial(7) + DV Luhn(1). */
export const PADRAO_CODIGO_VALE = '^VC[0-9]{12}$';

/**
 * C (↕): vale-troca ou vale-compra (MD 3.13.2). O `id` nasce no PDV quando o vale é emitido no caixa. `saldo` é a
 * projeção de `movimentos_vale` e **pode ficar negativo** (vale usado em dois caixas sem internet, D89): sem CHECK
 * `>= 0`, com alerta. `conferencia_hash` guarda só o resumo criptográfico do código de conferência de 4 dígitos
 * impresso no vale (D96, `pdv.vale_exige_conferencia`); nulo no vale sem conferência (o formato é do F3-B41).
 */
export const vales = pgTable(
  'vales',
  {
    ...colunasPadrao(),
    codigo: varchar('codigo', { length: 14 }).notNull(),
    tipo: varchar('tipo', { length: 11 }).notNull(),
    pessoaId: uuid('pessoa_id'),
    lojaEmissaoId: uuid('loja_emissao_id').notNull(),
    terminalEmissaoId: uuid('terminal_emissao_id'),
    valorOriginal: dinheiro('valor_original').notNull(),
    saldo: dinheiro('saldo').notNull(),
    validade: date('validade').notNull(),
    status: varchar('status', { length: 10 }).notNull().default('ativo'),
    origemTipo: varchar('origem_tipo', { length: 8 }).notNull(),
    // Troca ou venda de origem (polimórfica): sem FK.
    origemId: uuid('origem_id'),
    conferenciaHash: varchar('conferencia_hash', { length: 100 }),
    emitidoEm: timestamptz('emitido_em').notNull(),
    emitidoPorId: uuid('emitido_por_id').notNull(),
    canceladoEm: timestamptz('cancelado_em'),
    canceladoPorId: uuid('cancelado_por_id'),
    motivoCancelamento: varchar('motivo_cancelamento', { length: 255 }),
  },
  (t) => [
    primaryKey({ name: 'pk_vales', columns: [t.id] }),
    foreignKey({ name: 'fk_vales_pessoa_id', columns: [t.pessoaId], foreignColumns: [pessoas.id] }),
    foreignKey({ name: 'fk_vales_loja_emissao_id', columns: [t.lojaEmissaoId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_vales_terminal_emissao_id',
      columns: [t.terminalEmissaoId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({ name: 'fk_vales_emitido_por_id', columns: [t.emitidoPorId], foreignColumns: [usuarios.id] }),
    foreignKey({
      name: 'fk_vales_cancelado_por_id',
      columns: [t.canceladoPorId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_vales_codigo').on(t.codigo),
    index('ix_vales_pessoa_id').on(t.pessoaId),
    index('ix_vales_loja_emissao_id').on(t.lojaEmissaoId),
    index('ix_vales_terminal_emissao_id').on(t.terminalEmissaoId),
    index('ix_vales_emitido_por_id').on(t.emitidoPorId),
    index('ix_vales_cancelado_por_id').on(t.canceladoPorId),
    check('ck_vales_codigo', sql.raw(`codigo ~ '${PADRAO_CODIGO_VALE}'`)),
    check('ck_vales_tipo', sql`tipo in (${listaSql(TIPOS_VALE)})`),
    check('ck_vales_status', sql`status in (${listaSql(STATUS_VALE)})`),
    check('ck_vales_origem_tipo', sql`origem_tipo in (${listaSql(ORIGENS_VALE)})`),
    check('ck_vales_valor_original', sql`valor_original > 0`),
    check('ck_vales_cancelado', sql`status <> 'cancelado' or cancelado_em is not null`),
  ],
);

/**
 * D: troca ou devolução (MD 3.13.1). Imutável depois de gravada, salvo `venda_nova_id` (preenchida uma vez pela nuvem
 * ao aplicar a venda que usa o vale da troca imediata, SYNC 9.16), `status` (`registrada` → `cancelada`, só) e as
 * colunas de cancelamento (`tg_trocas_imutavel` e `tg_trocas_transicao`, 0029). `documento_fiscal_id` fica nulo e sem
 * FK até a fase fiscal (NF-e de entrada de devolução).
 */
export const trocas = pgTable(
  'trocas',
  {
    ...colunasPadrao(),
    // Nulo no MD (o PDV não numera a troca); na nuvem o default sempre preenche.
    codigo: integer('codigo').default(sql`nextval('seq_codigo_trocas')`),
    origem: varchar('origem', { length: 4 }).notNull().default('pdv'),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    terminalId: uuid('terminal_id'),
    sessaoCaixaId: uuid('sessao_caixa_id'),
    numeroCaixa: smallint('numero_caixa').notNull(),
    // → `vendas`, sem FK (a venda de origem pode ser de outro terminal e chegar depois).
    vendaOrigemId: uuid('venda_origem_id'),
    semVendaOrigem: boolean('sem_venda_origem').notNull().default(false),
    clienteId: uuid('cliente_id'),
    operadorId: uuid('operador_id').notNull(),
    autorizadoPorId: uuid('autorizado_por_id'),
    motivo: varchar('motivo', { length: 255 }).notNull(),
    resolucao: varchar('resolucao', { length: 14 }).notNull(),
    valorTotal: dinheiro('valor_total').notNull(),
    valeId: uuid('vale_id'),
    vendaNovaId: uuid('venda_nova_id'),
    movimentoCaixaId: uuid('movimento_caixa_id'),
    documentoFiscalId: uuid('documento_fiscal_id'),
    ocorridaEm: timestamptz('ocorrida_em').notNull(),
    status: varchar('status', { length: 10 }).notNull().default('registrada'),
    canceladaEm: timestamptz('cancelada_em'),
    motivoCancelamento: varchar('motivo_cancelamento', { length: 255 }),
  },
  (t) => [
    primaryKey({ name: 'pk_trocas', columns: [t.id] }),
    foreignKey({ name: 'fk_trocas_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_trocas_caixa_id', columns: [t.caixaId], foreignColumns: [caixas.id] }),
    foreignKey({ name: 'fk_trocas_terminal_id', columns: [t.terminalId], foreignColumns: [terminais.id] }),
    foreignKey({
      name: 'fk_trocas_sessao_caixa_id',
      columns: [t.sessaoCaixaId],
      foreignColumns: [sessoesCaixa.id],
    }),
    foreignKey({ name: 'fk_trocas_cliente_id', columns: [t.clienteId], foreignColumns: [pessoas.id] }),
    foreignKey({ name: 'fk_trocas_operador_id', columns: [t.operadorId], foreignColumns: [usuarios.id] }),
    foreignKey({
      name: 'fk_trocas_autorizado_por_id',
      columns: [t.autorizadoPorId],
      foreignColumns: [usuarios.id],
    }),
    // O vale e o movimento de caixa sobem no mesmo `troca.registrada` (SYNC 9.16): gravados antes da troca.
    foreignKey({ name: 'fk_trocas_vale_id', columns: [t.valeId], foreignColumns: [vales.id] }),
    foreignKey({ name: 'fk_trocas_venda_nova_id', columns: [t.vendaNovaId], foreignColumns: [vendas.id] }),
    foreignKey({
      name: 'fk_trocas_movimento_caixa_id',
      columns: [t.movimentoCaixaId],
      foreignColumns: [movimentosCaixa.id],
    }),
    uniqueIndex('uq_trocas_codigo').on(t.codigo),
    index('ix_trocas_venda_origem_id').on(t.vendaOrigemId),
    index('ix_trocas_loja_ocorrida').on(t.lojaId, t.ocorridaEm),
    index('ix_trocas_caixa_id').on(t.caixaId),
    index('ix_trocas_terminal_id').on(t.terminalId),
    index('ix_trocas_sessao_caixa_id').on(t.sessaoCaixaId),
    index('ix_trocas_cliente_id').on(t.clienteId),
    index('ix_trocas_operador_id').on(t.operadorId),
    index('ix_trocas_autorizado_por_id').on(t.autorizadoPorId),
    index('ix_trocas_vale_id').on(t.valeId),
    index('ix_trocas_venda_nova_id').on(t.vendaNovaId),
    index('ix_trocas_movimento_caixa_id').on(t.movimentoCaixaId),
    check('ck_trocas_origem', sql`origem in (${listaSql(ORIGENS_TROCA)})`),
    check('ck_trocas_resolucao', sql`resolucao in (${listaSql(RESOLUCOES_TROCA)})`),
    check('ck_trocas_status', sql`status in (${listaSql(STATUS_TROCA)})`),
    check('ck_trocas_venda_origem', sql`venda_origem_id is not null or sem_venda_origem`),
    check('ck_trocas_pdv', sql`origem = 'erp' or (terminal_id is not null and sessao_caixa_id is not null)`),
    check(
      'ck_trocas_erp',
      sql`origem = 'pdv' or (venda_origem_id is not null and resolucao <> 'troca_imediata')`,
    ),
    check('ck_trocas_valor', sql`valor_total >= 0`),
    check('ck_trocas_cancelada', sql`status <> 'cancelada' or cancelada_em is not null`),
  ],
);

/** D: item devolvido (MD 3.13.1); `valor_unitario` é o líquido unitário pago. Imutável (0029). */
export const itensTroca = pgTable(
  'itens_troca',
  {
    ...colunasPadrao(),
    trocaId: uuid('troca_id').notNull(),
    sequencia: integer('sequencia').notNull(),
    // → `itens_venda`, sem FK (como `trocas.venda_origem_id`).
    itemVendaOrigemId: uuid('item_venda_origem_id'),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    loteId: uuid('lote_id'),
    quantidade: quantidade('quantidade').notNull(),
    valorUnitario: preco('valor_unitario').notNull(),
    valorTotal: dinheiro('valor_total').notNull(),
    destino: varchar('destino', { length: 8 }).notNull(),
    motivo: varchar('motivo', { length: 255 }),
  },
  (t) => [
    primaryKey({ name: 'pk_itens_troca', columns: [t.id] }),
    foreignKey({ name: 'fk_itens_troca_troca_id', columns: [t.trocaId], foreignColumns: [trocas.id] }),
    foreignKey({ name: 'fk_itens_troca_produto_id', columns: [t.produtoId], foreignColumns: [produtos.id] }),
    foreignKey({
      name: 'fk_itens_troca_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    // Como em `itens_venda.lote_id`: o handler grava nulo o lote que a nuvem não conhece, com alerta.
    foreignKey({ name: 'fk_itens_troca_lote_id', columns: [t.loteId], foreignColumns: [produtosLotes.id] }),
    uniqueIndex('uq_itens_troca_sequencia').on(t.trocaId, t.sequencia),
    index('ix_itens_troca_item_venda_origem_id').on(t.itemVendaOrigemId),
    index('ix_itens_troca_produto_id').on(t.produtoId),
    index('ix_itens_troca_variacao_id').on(t.variacaoId),
    index('ix_itens_troca_lote_id').on(t.loteId),
    check('ck_itens_troca_quantidade', sql`quantidade > 0`),
    check('ck_itens_troca_valores', sql`valor_unitario >= 0 and valor_total >= 0`),
    check('ck_itens_troca_destino', sql`destino in (${listaSql(DESTINOS_ITEM_TROCA)})`),
  ],
);

/**
 * D (↑): movimento do saldo do vale (MD 3.13.2); `vales.saldo` = Σ `valor`. Imutável (0029). A baixa pelo pagamento
 * da venda é única por pagamento e tipo (`uq_movimentos_vale_pagamento`): o mesmo `venda.finalizada` reaplicado ou
 * reprocessado não baixa duas vezes. Sinal: emissão e estorno da utilização positivos, utilização negativa; o
 * cancelamento (−saldo, que pode ser positivo com o saldo negativo), a expiração e o ajuste ficam livres.
 */
export const movimentosVale = pgTable(
  'movimentos_vale',
  {
    ...colunasPadrao(),
    valeId: uuid('vale_id').notNull(),
    tipo: varchar('tipo', { length: 20 }).notNull(),
    valor: dinheiro('valor').notNull(),
    vendaId: uuid('venda_id'),
    pagamentoVendaId: uuid('pagamento_venda_id'),
    trocaId: uuid('troca_id'),
    terminalId: uuid('terminal_id'),
    usuarioId: uuid('usuario_id'),
    ocorridoEm: timestamptz('ocorrido_em').notNull(),
    eventoId: uuid('evento_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_movimentos_vale', columns: [t.id] }),
    foreignKey({ name: 'fk_movimentos_vale_vale_id', columns: [t.valeId], foreignColumns: [vales.id] }),
    foreignKey({
      name: 'fk_movimentos_vale_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({
      name: 'fk_movimentos_vale_usuario_id',
      columns: [t.usuarioId],
      foreignColumns: [usuarios.id],
    }),
    index('ix_movimentos_vale_vale_id').on(t.valeId),
    uniqueIndex('uq_movimentos_vale_pagamento')
      .on(t.pagamentoVendaId, t.tipo)
      .where(sql`pagamento_venda_id is not null`),
    index('ix_movimentos_vale_venda_id').on(t.vendaId),
    index('ix_movimentos_vale_troca_id').on(t.trocaId),
    index('ix_movimentos_vale_terminal_id').on(t.terminalId),
    index('ix_movimentos_vale_usuario_id').on(t.usuarioId),
    check('ck_movimentos_vale_tipo', sql`tipo in (${listaSql(TIPOS_MOVIMENTO_VALE)})`),
    check('ck_movimentos_vale_valor', sql`valor <> 0`),
    check(
      'ck_movimentos_vale_sinal',
      sql`(tipo not in ('emissao','estorno_utilizacao') or valor > 0) and (tipo <> 'utilizacao' or valor < 0)`,
    ),
  ],
);

/**
 * C (—): reserva de saldo feita por um caixa online antes de lançar o pagamento com vale (MD 3.13.2; SYNC 14.4). Várias
 * ativas por vale (uso parcial em caixas diferentes); uma por pagamento. Consumida só pelo `venda.finalizada` do mesmo
 * `pagamento_venda_id`; liberada pelo cancelamento ou pelo pagamento removido; expirada pela tarefa por minuto.
 */
export const reservasVale = pgTable(
  'reservas_vale',
  {
    ...colunasPadrao(),
    valeId: uuid('vale_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    // Ids gerados no PDV antes da reserva (a venda ainda não existe na nuvem): sem FK.
    vendaId: uuid('venda_id').notNull(),
    pagamentoVendaId: uuid('pagamento_venda_id').notNull(),
    valor: dinheiro('valor').notNull(),
    status: varchar('status', { length: 10 }).notNull().default('ativa'),
    expiraEm: timestamptz('expira_em').notNull(),
    emUsoDesde: timestamptz('em_uso_desde'),
    consumidaEm: timestamptz('consumida_em'),
    liberadaEm: timestamptz('liberada_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_reservas_vale', columns: [t.id] }),
    foreignKey({ name: 'fk_reservas_vale_vale_id', columns: [t.valeId], foreignColumns: [vales.id] }),
    foreignKey({
      name: 'fk_reservas_vale_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    uniqueIndex('uq_reservas_vale_pagamento').on(t.pagamentoVendaId),
    index('ix_reservas_vale_vale_id_status').on(t.valeId, t.status),
    index('ix_reservas_vale_terminal_id').on(t.terminalId),
    check('ck_reservas_vale_status', sql`status in (${listaSql(STATUS_RESERVA_VALE)})`),
    check('ck_reservas_vale_valor', sql`valor > 0`),
  ],
);

/**
 * Registro das requisições online do caixa que alteram estado (SYNC 20.4; F3-B6 usa): a chave é o terminal e o
 * `X-Requisicao-Id`; a resposta gravada no mesmo commit do efeito volta igual na repetição. `status_http`/`resposta`
 * nulos = a requisição ainda está em andamento (a repetição espera a linha). `corpo_sha256` deixa recusar o mesmo id
 * com outro corpo. Retenção de 24 h (`ix_requisicoes_terminal_criada_em`, a limpeza do F3-B6). Log técnico: sem
 * `versao` e sem trigger de versão.
 */
export const requisicoesTerminal = pgTable(
  'requisicoes_terminal',
  {
    terminalId: uuid('terminal_id').notNull(),
    requisicaoId: uuid('requisicao_id').notNull(),
    endpoint: varchar('endpoint', { length: 80 }).notNull(),
    corpoSha256: varchar('corpo_sha256', { length: 64 }),
    statusHttp: smallint('status_http'),
    resposta: jsonb('resposta'),
    criadaEm: timestamptz('criada_em').notNull().defaultNow(),
    concluidaEm: timestamptz('concluida_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_requisicoes_terminal', columns: [t.terminalId, t.requisicaoId] }),
    foreignKey({
      name: 'fk_requisicoes_terminal_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    index('ix_requisicoes_terminal_criada_em').on(t.criadaEm),
    check('ck_requisicoes_terminal_status_http', sql`status_http is null or status_http between 100 and 599`),
    check('ck_requisicoes_terminal_concluida', sql`(concluida_em is null) = (status_http is null)`),
  ],
);
