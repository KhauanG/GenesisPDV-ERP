/**
 * MD 3.7 – estoque: razão append-only (`movimentos_estoque`), projeções de saldo (`saldos_estoque`, `saldos_lote`),
 * acertos (Entrada / Saída / Definir) e, do MD 3.5.6, os cascos em comodato por pessoa (projeção que depende de
 * `produtos`). `tipos_movimento_estoque` (R) fica em `referencias.ts`.
 *
 * Imutabilidade (`fn_protege_imutavel`), coluna de filtro imutável dos saldos e índices únicos com
 * `nulls not distinct` ficam na migração customizada.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { colunasAutoria, colunasPadrao, timestamptz } from '../../colunas.js';
import { usuarios } from './acesso.js';
import { estoques, lojas, tiposEstoque } from './estrutura.js';
import { pessoas } from './pessoas.js';
import { produtos, produtosLotes, produtosVariacoes } from './produtos.js';
import { tiposMovimentoEstoque } from './referencias.js';
import { terminais } from './sincronizacao.js';

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));
const quantidade = (nome: string) => numeric(nome, { precision: 15, scale: 3 });
const preco = (nome: string) => numeric(nome, { precision: 15, scale: 4 });
const dinheiro = (nome: string) => numeric(nome, { precision: 15, scale: 2 });

export const DOCUMENTOS_MOVIMENTO_ESTOQUE = [
  'venda',
  'troca',
  'acerto',
  'recebimento',
  'nota_entrada',
  'transferencia',
  'vasilhame',
] as const;

/** D: um movimento de um produto num estoque; imutável (MD 3.7.2). */
export const movimentosEstoque = pgTable(
  'movimentos_estoque',
  {
    ...colunasPadrao(),
    estoqueId: uuid('estoque_id').notNull(),
    lojaId: uuid('loja_id'),
    tipoEstoqueId: uuid('tipo_estoque_id').notNull(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    loteId: uuid('lote_id'),
    tipoMovimento: varchar('tipo_movimento', { length: 30 }).notNull(),
    quantidade: quantidade('quantidade').notNull(),
    unidadeDocumento: varchar('unidade_documento', { length: 6 }),
    fator: quantidade('fator').notNull().default('1'),
    saldoAnterior: quantidade('saldo_anterior').notNull(),
    saldoPosterior: quantidade('saldo_posterior').notNull(),
    custoUnitario: preco('custo_unitario').notNull(),
    custoTotal: dinheiro('custo_total').notNull(),
    custoMedioPosterior: preco('custo_medio_posterior').notNull(),
    precoVenda: preco('preco_venda'),
    dataMovimento: timestamptz('data_movimento').notNull(),
    usuarioId: uuid('usuario_id'),
    pessoaId: uuid('pessoa_id'),
    documentoTipo: varchar('documento_tipo', { length: 20 }).notNull(),
    documentoId: uuid('documento_id'),
    documentoItemId: uuid('documento_item_id'),
    terminalId: uuid('terminal_id'),
    eventoId: uuid('evento_id'),
    estornoDeId: uuid('estorno_de_id'),
    compensaMovimentoId: uuid('compensa_movimento_id'),
    observacao: varchar('observacao', { length: 255 }),
    seqLancamento: bigint('seq_lancamento', { mode: 'number' })
      .notNull()
      .default(sql`nextval('seq_movimentos_estoque')`),
  },
  (t) => [
    primaryKey({ name: 'pk_movimentos_estoque', columns: [t.id] }),
    foreignKey({
      name: 'fk_movimentos_estoque_estoque_id',
      columns: [t.estoqueId],
      foreignColumns: [estoques.id],
    }),
    foreignKey({ name: 'fk_movimentos_estoque_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_movimentos_estoque_tipo_estoque_id',
      columns: [t.tipoEstoqueId],
      foreignColumns: [tiposEstoque.id],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_lote_id',
      columns: [t.loteId],
      foreignColumns: [produtosLotes.id],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_tipo_movimento',
      columns: [t.tipoMovimento],
      foreignColumns: [tiposMovimentoEstoque.codigo],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_usuario_id',
      columns: [t.usuarioId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_estorno_de_id',
      columns: [t.estornoDeId],
      foreignColumns: [t.id],
    }),
    foreignKey({
      name: 'fk_movimentos_estoque_compensa_movimento_id',
      columns: [t.compensaMovimentoId],
      foreignColumns: [t.id],
    }),
    // uq_movimentos_estoque_idempotencia (nulls not distinct; com `compensa_movimento_id` e `estorno_de_id` desde a
    // 0013, T23), uq_movimentos_estoque_compensacao, uq_movimentos_estoque_estorno e o BRIN de data_movimento ficam
    // nas migrações customizadas.
    index('ix_movimentos_estoque_estoque_produto_data').on(
      t.estoqueId,
      t.produtoId,
      t.variacaoId,
      t.dataMovimento,
    ),
    index('ix_movimentos_estoque_linha_seq').on(
      t.estoqueId,
      t.produtoId,
      t.variacaoId,
      t.tipoEstoqueId,
      t.seqLancamento,
    ),
    index('ix_movimentos_estoque_documento').on(t.documentoTipo, t.documentoId),
    index('ix_movimentos_estoque_tipo_movimento').on(t.tipoMovimento),
    index('ix_movimentos_estoque_loja_id').on(t.lojaId),
    index('ix_movimentos_estoque_tipo_estoque_id').on(t.tipoEstoqueId),
    index('ix_movimentos_estoque_produto_id').on(t.produtoId),
    index('ix_movimentos_estoque_variacao_id').on(t.variacaoId),
    index('ix_movimentos_estoque_lote_id').on(t.loteId),
    index('ix_movimentos_estoque_usuario_id').on(t.usuarioId),
    index('ix_movimentos_estoque_pessoa_id').on(t.pessoaId),
    index('ix_movimentos_estoque_terminal_id').on(t.terminalId),
    index('ix_movimentos_estoque_estorno_de_id').on(t.estornoDeId),
    index('ix_movimentos_estoque_compensa_movimento_id').on(t.compensaMovimentoId),
    check('ck_movimentos_estoque_quantidade', sql`quantidade <> 0`),
    check('ck_movimentos_estoque_fator', sql`fator > 0`),
    check('ck_movimentos_estoque_custo', sql`custo_unitario >= 0`),
    check(
      'ck_movimentos_estoque_documento_tipo',
      sql`documento_tipo in (${listaSql(DOCUMENTOS_MOVIMENTO_ESTOQUE)})`,
    ),
    check('ck_movimentos_estoque_saldo', sql`saldo_posterior = saldo_anterior + quantidade`),
  ],
);

/** P: saldo por (estoque, produto, variação, tipo de estoque); sem exclusão lógica (MD 3.7.3). */
export const saldosEstoque = pgTable(
  'saldos_estoque',
  {
    ...colunasPadrao(),
    estoqueId: uuid('estoque_id').notNull(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    tipoEstoqueId: uuid('tipo_estoque_id').notNull(),
    quantidade: quantidade('quantidade').notNull().default('0'),
    custoMedio: preco('custo_medio').notNull().default('0'),
    ultimaEntradaEm: timestamptz('ultima_entrada_em'),
    ultimaSaidaEm: timestamptz('ultima_saida_em'),
    ultimaCompraEm: timestamptz('ultima_compra_em'),
    ultimoCustoCompra: preco('ultimo_custo_compra'),
    ultimoMovimentoId: uuid('ultimo_movimento_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_saldos_estoque', columns: [t.id] }),
    foreignKey({
      name: 'fk_saldos_estoque_estoque_id',
      columns: [t.estoqueId],
      foreignColumns: [estoques.id],
    }),
    foreignKey({
      name: 'fk_saldos_estoque_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_saldos_estoque_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_saldos_estoque_tipo_estoque_id',
      columns: [t.tipoEstoqueId],
      foreignColumns: [tiposEstoque.id],
    }),
    foreignKey({
      name: 'fk_saldos_estoque_ultimo_movimento_id',
      columns: [t.ultimoMovimentoId],
      foreignColumns: [movimentosEstoque.id],
    }),
    // uq_saldos_estoque_chave (nulls not distinct) fica na migração customizada; começa por estoque_id.
    index('ix_saldos_estoque_produto_id').on(t.produtoId),
    index('ix_saldos_estoque_variacao_id').on(t.variacaoId),
    index('ix_saldos_estoque_tipo_estoque_id').on(t.tipoEstoqueId),
    index('ix_saldos_estoque_ultimo_movimento_id').on(t.ultimoMovimentoId),
    check('ck_saldos_estoque_custo', sql`custo_medio >= 0`),
  ],
);

/** P: saldo por lote, só para produtos que controlam lote (MD 3.7.4). */
export const saldosLote = pgTable(
  'saldos_lote',
  {
    ...colunasPadrao(),
    estoqueId: uuid('estoque_id').notNull(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    loteId: uuid('lote_id').notNull(),
    tipoEstoqueId: uuid('tipo_estoque_id').notNull(),
    quantidade: quantidade('quantidade').notNull().default('0'),
  },
  (t) => [
    primaryKey({ name: 'pk_saldos_lote', columns: [t.id] }),
    foreignKey({ name: 'fk_saldos_lote_estoque_id', columns: [t.estoqueId], foreignColumns: [estoques.id] }),
    foreignKey({ name: 'fk_saldos_lote_produto_id', columns: [t.produtoId], foreignColumns: [produtos.id] }),
    foreignKey({
      name: 'fk_saldos_lote_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({ name: 'fk_saldos_lote_lote_id', columns: [t.loteId], foreignColumns: [produtosLotes.id] }),
    foreignKey({
      name: 'fk_saldos_lote_tipo_estoque_id',
      columns: [t.tipoEstoqueId],
      foreignColumns: [tiposEstoque.id],
    }),
    // uq_saldos_lote_chave (nulls not distinct) fica na migração customizada; começa por estoque_id.
    index('ix_saldos_lote_produto_id').on(t.produtoId),
    index('ix_saldos_lote_variacao_id').on(t.variacaoId),
    index('ix_saldos_lote_lote_id').on(t.loteId),
    index('ix_saldos_lote_tipo_estoque_id').on(t.tipoEstoqueId),
  ],
);

export const ORIGENS_ACERTO_ESTOQUE = [
  'manual',
  'cadastro_produto',
  'cadastro_massa',
  'importacao',
  'relatorio_estoque',
  'perda_transferencia',
  'api',
] as const;

/**
 * D: acerto de estoque (Entrada / Saída / Definir / Mudança de tipo); imutável fora de `rascunho` (MD 3.7.5). A
 * mudança de tipo (Fase 2, F2-B8) leva o saldo de `tipo_estoque_id` (origem) para `tipo_estoque_destino_id` no mesmo
 * estoque, com o par `MUDANCA_TIPO_ESTOQUE`.
 */
export const acertosEstoque = pgTable(
  'acertos_estoque',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_acertos_estoque')`),
    estoqueId: uuid('estoque_id').notNull(),
    tipoEstoqueId: uuid('tipo_estoque_id').notNull(),
    tipoAjuste: varchar('tipo_ajuste', { length: 12 }).notNull().default('entrada'),
    /** Só na mudança de tipo (`ck_acertos_estoque_mudanca_tipo`): o tipo que recebe o saldo. */
    tipoEstoqueDestinoId: uuid('tipo_estoque_destino_id'),
    dataContagem: timestamptz('data_contagem').notNull().defaultNow(),
    motivo: varchar('motivo', { length: 120 }).notNull(),
    responsavelId: uuid('responsavel_id').notNull(),
    observacoes: text('observacoes'),
    origem: varchar('origem', { length: 20 }).notNull().default('manual'),
    origemId: uuid('origem_id'),
    status: varchar('status', { length: 10 }).notNull().default('rascunho'),
    efetivadoEm: timestamptz('efetivado_em'),
    efetivadoPorId: uuid('efetivado_por_id'),
    estornadoEm: timestamptz('estornado_em'),
    estornadoPorId: uuid('estornado_por_id'),
    motivoEstorno: varchar('motivo_estorno', { length: 255 }),
    qtdItens: integer('qtd_itens').notNull().default(0),
    totalVenda: dinheiro('total_venda').notNull().default('0'),
    totalCusto: dinheiro('total_custo').notNull().default('0'),
  },
  (t) => [
    primaryKey({ name: 'pk_acertos_estoque', columns: [t.id] }),
    foreignKey({
      name: 'fk_acertos_estoque_estoque_id',
      columns: [t.estoqueId],
      foreignColumns: [estoques.id],
    }),
    foreignKey({
      name: 'fk_acertos_estoque_tipo_estoque_id',
      columns: [t.tipoEstoqueId],
      foreignColumns: [tiposEstoque.id],
    }),
    foreignKey({
      name: 'fk_acertos_estoque_tipo_estoque_destino_id',
      columns: [t.tipoEstoqueDestinoId],
      foreignColumns: [tiposEstoque.id],
    }),
    foreignKey({
      name: 'fk_acertos_estoque_responsavel_id',
      columns: [t.responsavelId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_acertos_estoque_efetivado_por_id',
      columns: [t.efetivadoPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_acertos_estoque_estornado_por_id',
      columns: [t.estornadoPorId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_acertos_estoque_codigo').on(t.codigo),
    index('ix_acertos_estoque_estoque_id_data_contagem').on(t.estoqueId, t.dataContagem),
    index('ix_acertos_estoque_tipo_estoque_id').on(t.tipoEstoqueId),
    index('ix_acertos_estoque_tipo_estoque_destino_id').on(t.tipoEstoqueDestinoId),
    index('ix_acertos_estoque_responsavel_id').on(t.responsavelId),
    index('ix_acertos_estoque_efetivado_por_id').on(t.efetivadoPorId),
    index('ix_acertos_estoque_estornado_por_id').on(t.estornadoPorId),
    check('ck_acertos_estoque_tipo_ajuste', sql`tipo_ajuste in ('entrada','saida','definir','mudanca_tipo')`),
    // O destino existe só na mudança de tipo e é outro tipo (a perna de entrada não cai na linha da de saída).
    check(
      'ck_acertos_estoque_mudanca_tipo',
      sql`(tipo_ajuste = 'mudanca_tipo') = (tipo_estoque_destino_id is not null) and tipo_estoque_destino_id is distinct from tipo_estoque_id`,
    ),
    check('ck_acertos_estoque_status', sql`status in ('rascunho','efetivado','estornado')`),
    check('ck_acertos_estoque_origem', sql`origem in (${listaSql(ORIGENS_ACERTO_ESTOQUE)})`),
    check(
      'ck_acertos_estoque_efetivacao',
      sql`(status = 'rascunho') = (efetivado_em is null) and (status = 'estornado') = (estornado_em is not null)`,
    ),
  ],
);

/** Itens do acerto; só editáveis com o acerto em `rascunho` (trigger na migração customizada). */
export const itensAcertoEstoque = pgTable(
  'itens_acerto_estoque',
  {
    ...colunasPadrao(),
    acertoId: uuid('acerto_id').notNull(),
    sequencia: integer('sequencia').notNull(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    loteId: uuid('lote_id'),
    quantidadeInformada: quantidade('quantidade_informada').notNull(),
    saldoAnterior: quantidade('saldo_anterior'),
    diferenca: quantidade('diferenca'),
    custoUnitario: preco('custo_unitario'),
    precoVenda: preco('preco_venda').notNull().default('0'),
    totalVenda: dinheiro('total_venda').notNull().default('0'),
    totalCusto: dinheiro('total_custo').notNull().default('0'),
  },
  (t) => [
    primaryKey({ name: 'pk_itens_acerto_estoque', columns: [t.id] }),
    foreignKey({
      name: 'fk_itens_acerto_estoque_acerto_id',
      columns: [t.acertoId],
      foreignColumns: [acertosEstoque.id],
    }),
    foreignKey({
      name: 'fk_itens_acerto_estoque_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_itens_acerto_estoque_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_itens_acerto_estoque_lote_id',
      columns: [t.loteId],
      foreignColumns: [produtosLotes.id],
    }),
    uniqueIndex('uq_itens_acerto_estoque_sequencia').on(t.acertoId, t.sequencia),
    // uq_itens_acerto_estoque_produto (nulls not distinct) fica na migração customizada.
    index('ix_itens_acerto_estoque_produto_id').on(t.produtoId),
    index('ix_itens_acerto_estoque_variacao_id').on(t.variacaoId),
    index('ix_itens_acerto_estoque_lote_id').on(t.loteId),
    // Quantidade negativa só no acerto "Definir" (saldo real negativo vindo da importação do Nuvem3): trigger
    // `tg_itens_acerto_estoque_quantidade` na migração 0007 (o check não enxerga o tipo do acerto).
    check(
      'ck_itens_acerto_estoque_valores',
      sql`preco_venda >= 0 and (custo_unitario is null or custo_unitario >= 0)`,
    ),
  ],
);

/** P (MD 3.5.6): cascos em comodato com o cliente; aqui por depender de `produtos`. */
export const saldosVasilhamePessoas = pgTable(
  'saldos_vasilhame_pessoas',
  {
    ...colunasPadrao(),
    pessoaId: uuid('pessoa_id').notNull(),
    produtoVasilhameId: uuid('produto_vasilhame_id').notNull(),
    quantidade: quantidade('quantidade').notNull().default('0'),
  },
  (t) => [
    primaryKey({ name: 'pk_saldos_vasilhame_pessoas', columns: [t.id] }),
    foreignKey({
      name: 'fk_saldos_vasilhame_pessoas_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({
      name: 'fk_saldos_vasilhame_pessoas_produto_vasilhame_id',
      columns: [t.produtoVasilhameId],
      foreignColumns: [produtos.id],
    }),
    uniqueIndex('uq_saldos_vasilhame_pessoas').on(t.pessoaId, t.produtoVasilhameId),
    index('ix_saldos_vasilhame_pessoas_produto_vasilhame_id').on(t.produtoVasilhameId),
    check('ck_saldos_vasilhame_pessoas_quantidade', sql`quantidade >= 0`),
  ],
);
