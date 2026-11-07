/**
 * MD 3.7 – estoque: razão append-only (`movimentos_estoque`), projeções de saldo (`saldos_estoque`, `saldos_lote`),
 * acertos (Entrada / Saída / Definir), a transferência entre estoques em duas etapas (`transferencias_estoque`,
 * `itens_transferencia`, MD 3.7.6; Fase 2, F2-B22) e, do MD 3.5.6, os cascos em comodato por pessoa (projeção que
 * depende de `produtos`). `tipos_movimento_estoque` (R) fica em `referencias.ts`.
 *
 * Imutabilidade (`fn_protege_imutavel`), coluna de filtro imutável dos saldos e índices únicos com
 * `nulls not distinct` ficam na migração customizada.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
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
    // Movimentação de um local por período, na ordem do cursor (F2-B28, README da API › decisão 176). Em empresa
    // existente nasce com `concurrently` na preparação da 0026 (`estoques/indices-razao.ts`), que também cria o
    // `ix_movimentos_estoque_linha_data (… data_movimento, id) include (quantidade)`, só na migração (sem `include`
    // no Drizzle).
    index('ix_movimentos_estoque_estoque_data').on(t.estoqueId, t.dataMovimento, t.id),
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

// ---------------------------------------------------------------------------------------------------------------
// Transferência entre estoques em duas etapas (MD 3.7.6; ERP 13.7; Fase 2, F2-B22; README da API › decisão 170).
// Não desce ao PDV (`fn_versao_local`): o que ela muda nos saldos desce pelo fluxo `estoque`. A sequência do
// `codigo`, os triggers de versão, de imutabilidade e de etapa, as FKs de autoria e o índice único do produto
// (`nulls not distinct`) ficam na migração customizada `0025_transferencias`.

/**
 * Situação da transferência (ERP 13.7): rascunho → em trânsito (1ª etapa, `TRANSF_SAIDA` na origem) → recebida ou
 * recebida com divergência (2ª etapa, `TRANSF_ENTRADA` no destino) → recebida (diferença tratada); rascunho ou em
 * trânsito → cancelada (no trânsito, `TRANSF_RETORNO` integral). Recebida e cancelada são o fim.
 */
export const STATUS_TRANSFERENCIA = [
  'rascunho',
  'em_transito',
  'recebida',
  'recebida_divergencia',
  'cancelada',
] as const;
/**
 * Tratamento da diferença recebida a menor (ERP 13.7; F2-Q10 = D51): `retorno_origem` (`TRANSF_RETORNO` da
 * diferença) ou `perda` (o retorno mais um acerto de saída na origem com a origem `perda_transferencia`).
 */
export const TRATAMENTOS_DIVERGENCIA_TRANSFERENCIA = ['retorno_origem', 'perda'] as const;

/**
 * D: transferência de mercadoria entre dois estoques da empresa (CD ⇄ loja, loja ⇄ loja), num só tipo de estoque
 * (`tipo_estoque_id`: padrão = o tipo padrão, aplicado pela API; o Vasilhame vazio leva os cascos de volta ao CD).
 * A `data` é a data do documento (o razão lança no momento de cada etapa, F2-B4). Imutável fora do rascunho, salvo
 * as colunas de cada etapa (`tg_transferencias_estoque_etapa`). `documento_fiscal_id` (a NF-e de transferência que
 * o Genesis emitirá na fase fiscal) fica nulo e sem FK até `documentos_fiscais` existir; até lá, a NF-e emitida por
 * fora (Nuvem3/contador, entre CNPJs diferentes) é só anotada em `nfe_externa_chave`/`nfe_externa_numero` (D6).
 */
export const transferenciasEstoque = pgTable(
  'transferencias_estoque',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_transferencias_estoque')`),
    estoqueOrigemId: uuid('estoque_origem_id').notNull(),
    estoqueDestinoId: uuid('estoque_destino_id').notNull(),
    /** Tipo de estoque que sai da origem e entra no destino (o mesmo nas duas pontas). */
    tipoEstoqueId: uuid('tipo_estoque_id').notNull(),
    /** "Data" do documento (criação informada); o razão lança no envio e no recebimento. */
    data: date('data')
      .notNull()
      .default(sql`current_date`),
    motivo: varchar('motivo', { length: 120 }).notNull(),
    observacoes: text('observacoes'),
    status: varchar('status', { length: 22 }).notNull().default('rascunho'),
    /** "Data transferência" (1ª etapa). */
    enviadaEm: timestamptz('enviada_em'),
    enviadaPorId: uuid('enviada_por_id'),
    /** 2ª etapa (a conferência na chegada). */
    recebidaEm: timestamptz('recebida_em'),
    recebidaPorId: uuid('recebida_por_id'),
    canceladaEm: timestamptz('cancelada_em'),
    canceladaPorId: uuid('cancelada_por_id'),
    motivoCancelamento: varchar('motivo_cancelamento', { length: 255 }),
    /** NF-e de transferência emitida pelo Genesis (fase fiscal); sem FK, sempre nula na Fase 2. */
    documentoFiscalId: uuid('documento_fiscal_id'),
    /** Chave de acesso da NF-e de transferência emitida por fora (opcional; D6). */
    nfeExternaChave: varchar('nfe_externa_chave', { length: 44 }),
    /** Número (e série) da NF-e emitida por fora, quando não se tem a chave (opcional; D6). */
    nfeExternaNumero: varchar('nfe_externa_numero', { length: 20 }),
    qtdItens: integer('qtd_itens').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'pk_transferencias_estoque', columns: [t.id] }),
    foreignKey({
      name: 'fk_transferencias_estoque_estoque_origem_id',
      columns: [t.estoqueOrigemId],
      foreignColumns: [estoques.id],
    }),
    foreignKey({
      name: 'fk_transferencias_estoque_estoque_destino_id',
      columns: [t.estoqueDestinoId],
      foreignColumns: [estoques.id],
    }),
    foreignKey({
      name: 'fk_transferencias_estoque_tipo_estoque_id',
      columns: [t.tipoEstoqueId],
      foreignColumns: [tiposEstoque.id],
    }),
    foreignKey({
      name: 'fk_transferencias_estoque_enviada_por_id',
      columns: [t.enviadaPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_transferencias_estoque_recebida_por_id',
      columns: [t.recebidaPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_transferencias_estoque_cancelada_por_id',
      columns: [t.canceladaPorId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_transferencias_estoque_codigo').on(t.codigo),
    // A listagem por origem/destino e situação, o "em trânsito" do destino e o alerta de parada (F2-B26).
    index('ix_transferencias_estoque_origem_status').on(t.estoqueOrigemId, t.status),
    index('ix_transferencias_estoque_destino_status').on(t.estoqueDestinoId, t.status),
    index('ix_transferencias_estoque_tipo_estoque_id').on(t.tipoEstoqueId),
    index('ix_transferencias_estoque_enviada_por_id').on(t.enviadaPorId),
    index('ix_transferencias_estoque_recebida_por_id').on(t.recebidaPorId),
    index('ix_transferencias_estoque_cancelada_por_id').on(t.canceladaPorId),
    check('ck_transferencias_estoque_estoques', sql`estoque_origem_id <> estoque_destino_id`),
    check('ck_transferencias_estoque_status', sql`status in (${listaSql(STATUS_TRANSFERENCIA)})`),
    // Situação × datas de cada etapa: o rascunho não tem etapa nenhuma; o envio existe em trânsito e depois; o
    // recebimento só nas duas recebidas; o cancelamento só na cancelada, com o motivo (a cancelada do rascunho não
    // tem envio; a do trânsito, sim).
    check(
      'ck_transferencias_estoque_etapas',
      sql`(status <> 'rascunho' or (enviada_em is null and recebida_em is null and cancelada_em is null)) and (status not in ('em_transito','recebida','recebida_divergencia') or enviada_em is not null) and (status in ('recebida','recebida_divergencia')) = (recebida_em is not null) and (status = 'cancelada') = (cancelada_em is not null) and (status <> 'cancelada' or motivo_cancelamento is not null)`,
    ),
    check(
      'ck_transferencias_estoque_nfe_externa',
      sql`nfe_externa_chave is null or nfe_externa_chave ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'`,
    ),
  ],
);

/**
 * Itens da transferência; inseridos só no rascunho e, depois dele, só as colunas da etapa mudam
 * (`tg_itens_transferencia_etapa`): o custo no envio (gravado antes de o status sair do rascunho), a quantidade
 * recebida no trânsito e o tratamento da diferença na recebida com divergência. Quantidades na unidade do produto,
 * a 3 casas (ADR-05). Sem lote, o envio baixa em FEFO (F2-B6) e o lote de cada parte fica nos movimentos
 * (`documento_item_id` = o item).
 */
export const itensTransferencia = pgTable(
  'itens_transferencia',
  {
    ...colunasPadrao(),
    transferenciaId: uuid('transferencia_id').notNull(),
    sequencia: integer('sequencia').notNull(),
    produtoId: uuid('produto_id').notNull(),
    /** Sempre nula enquanto as variações estão travadas (D43); a coluna fica pronta para o F2-B49. */
    variacaoId: uuid('variacao_id'),
    /** Lote escolhido (do produto e do estoque de origem, ou sem estoque); nulo = FEFO no envio. */
    loteId: uuid('lote_id'),
    quantidadeEnviada: quantidade('quantidade_enviada').notNull(),
    /** Conferida no destino (2ª etapa); nula até o recebimento. */
    quantidadeRecebida: quantidade('quantidade_recebida'),
    /** Enviada − recebida (0 até o recebimento): o que falta tratar ou já foi tratado. */
    diferenca: quantidade('diferenca')
      .notNull()
      .generatedAlwaysAs(sql`quantidade_enviada - coalesce(quantidade_recebida, quantidade_enviada)`),
    tratamentoDivergencia: varchar('tratamento_divergencia', { length: 14 }),
    divergenciaTratadaEm: timestamptz('divergencia_tratada_em'),
    /** Custo médio da origem gravado no envio (`TRANSF_SAIDA`); a entrada no destino usa o mesmo. */
    custoUnitario: preco('custo_unitario'),
  },
  (t) => [
    primaryKey({ name: 'pk_itens_transferencia', columns: [t.id] }),
    foreignKey({
      name: 'fk_itens_transferencia_transferencia_id',
      columns: [t.transferenciaId],
      foreignColumns: [transferenciasEstoque.id],
    }),
    foreignKey({
      name: 'fk_itens_transferencia_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_itens_transferencia_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_itens_transferencia_lote_id',
      columns: [t.loteId],
      foreignColumns: [produtosLotes.id],
    }),
    uniqueIndex('uq_itens_transferencia_sequencia').on(t.transferenciaId, t.sequencia),
    // uq_itens_transferencia_produto (nulls not distinct) fica na migração customizada.
    index('ix_itens_transferencia_produto_id').on(t.produtoId),
    index('ix_itens_transferencia_variacao_id').on(t.variacaoId),
    index('ix_itens_transferencia_lote_id').on(t.loteId),
    check(
      'ck_itens_transferencia_quantidades',
      sql`quantidade_enviada > 0 and (quantidade_recebida is null or quantidade_recebida between 0 and quantidade_enviada)`,
    ),
    check('ck_itens_transferencia_custo', sql`custo_unitario is null or custo_unitario >= 0`),
    check(
      'ck_itens_transferencia_tratamento',
      sql`tratamento_divergencia is null or tratamento_divergencia in (${listaSql(TRATAMENTOS_DIVERGENCIA_TRANSFERENCIA)})`,
    ),
    // Só se trata a diferença que existe (recebida a menor), e o tratamento tem a hora.
    check(
      'ck_itens_transferencia_divergencia',
      sql`(tratamento_divergencia is null) = (divergencia_tratada_em is null) and (tratamento_divergencia is null or (quantidade_recebida is not null and quantidade_recebida < quantidade_enviada))`,
    ),
  ],
);
