/**
 * MD 3.11.1 – orçamentos (Fase 3, F3-B2; migração 0030; README da API › decisão 221; D116, D118). Cadastro do ERP
 * (ERP 15.1, F3-B60 em diante) que desce ao caixa da loja no fluxo `operacao` (filtro `loja_id`, os itens pelo pai)
 * para a importação no F9 ou por `ORC` + código (PDV 24.1); o caixa também cria orçamento, só online (D118), e a
 * conversão em venda chega no `venda.finalizada` (`vendas.orcamento_id`, sem FK: padrões da Fase 3).
 *
 * As duas nasceram com `fn_versao` e o índice de versão e entraram no fluxo `operacao` no F3-B7 (decisão 226).
 * `valido_ate` é gerada, por isso é isenta de versão (`COLUNAS_ISENTAS_VERSAO`), e desce como coluna gerada (o PDV a
 * calcula, `Esquema.g.cs` com `Gerada: true`). A sequência do `codigo`, os triggers de versão e de filtro imutável
 * (`loja_id`, MD 6.4 regra 2) e a autoria ficam na migração.
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
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { colunasAutoria, colunasPadrao, timestamptz } from '../../colunas.js';
import { usuarios } from './acesso.js';
import { lojas } from './estrutura.js';
import { pessoas } from './pessoas.js';
import { produtos, produtosVariacoes } from './produtos.js';
import { terminais } from './sincronizacao.js';
import { vendas } from './vendas.js';

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));
const quantidade = (nome: string) => numeric(nome, { precision: 15, scale: 3 });
const preco = (nome: string) => numeric(nome, { precision: 15, scale: 4 });
const dinheiro = (nome: string) => numeric(nome, { precision: 15, scale: 2 });
const percentual = (nome: string) => numeric(nome, { precision: 7, scale: 4 });

/** "Expirado" não é status: é `aberto` com `valido_ate` antes de hoje no fuso da loja (MD 3.11.1). */
export const STATUS_ORCAMENTO = ['aberto', 'convertido', 'cancelado'] as const;
/** Resposta do cliente pelo link público (ERP 15.1; o link fica para depois, D116). */
export const RESPOSTAS_ORCAMENTO = ['nao', 'aprovado', 'recusado'] as const;
export const TIPOS_DESCONTO_ORCAMENTO = ['valor', 'percentual'] as const;
export const ORIGENS_ORCAMENTO = ['erp', 'pdv'] as const;

/**
 * C (↓ loja). `reservado_terminal_id`/`reservado_ate` são a reserva online para a importação no caixa (2 h, SYNC
 * 14.4, F3-B6/B64), sempre juntas. `venda_id` aponta para a venda da conversão, gravada pela própria nuvem ao aplicar
 * a venda (por isso com FK, ao contrário de `vendas.orcamento_id`).
 */
export const orcamentos = pgTable(
  'orcamentos',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_orcamentos')`),
    lojaId: uuid('loja_id').notNull(),
    pessoaId: uuid('pessoa_id'),
    nome: varchar('nome', { length: 150 }).notNull(),
    email: varchar('email', { length: 254 }),
    telefone: varchar('telefone', { length: 20 }),
    data: date('data')
      .notNull()
      .default(sql`current_date`),
    diasValidade: smallint('dias_validade').notNull().default(15),
    validoAte: date('valido_ate')
      .notNull()
      .generatedAlwaysAs(sql`data + dias_validade`),
    ativo: boolean('ativo').notNull().default(true),
    status: varchar('status', { length: 10 }).notNull().default('aberto'),
    respondido: varchar('respondido', { length: 10 }).notNull().default('nao'),
    respondidoEm: timestamptz('respondido_em'),
    respostaObservacao: varchar('resposta_observacao', { length: 500 }),
    vendedorId: uuid('vendedor_id'),
    descontoTipo: varchar('desconto_tipo', { length: 10 }),
    descontoValor: dinheiro('desconto_valor').notNull().default('0'),
    descontoPct: percentual('desconto_pct'),
    subtotalBruto: dinheiro('subtotal_bruto').notNull().default('0'),
    total: dinheiro('total').notNull().default('0'),
    condicoesPagamento: text('condicoes_pagamento'),
    observacoes: text('observacoes'),
    origem: varchar('origem', { length: 4 }).notNull().default('erp'),
    origemTerminalId: uuid('origem_terminal_id'),
    vendaId: uuid('venda_id'),
    convertidoEm: timestamptz('convertido_em'),
    reservadoTerminalId: uuid('reservado_terminal_id'),
    reservadoAte: timestamptz('reservado_ate'),
  },
  (t) => [
    primaryKey({ name: 'pk_orcamentos', columns: [t.id] }),
    foreignKey({ name: 'fk_orcamentos_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_orcamentos_pessoa_id', columns: [t.pessoaId], foreignColumns: [pessoas.id] }),
    foreignKey({ name: 'fk_orcamentos_vendedor_id', columns: [t.vendedorId], foreignColumns: [usuarios.id] }),
    foreignKey({
      name: 'fk_orcamentos_origem_terminal_id',
      columns: [t.origemTerminalId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({ name: 'fk_orcamentos_venda_id', columns: [t.vendaId], foreignColumns: [vendas.id] }),
    foreignKey({
      name: 'fk_orcamentos_reservado_terminal_id',
      columns: [t.reservadoTerminalId],
      foreignColumns: [terminais.id],
    }),
    uniqueIndex('uq_orcamentos_codigo').on(t.codigo),
    index('ix_orcamentos_loja_id_status').on(t.lojaId, t.status),
    index('ix_orcamentos_pessoa_id').on(t.pessoaId),
    index('ix_orcamentos_vendedor_id').on(t.vendedorId),
    index('ix_orcamentos_origem_terminal_id').on(t.origemTerminalId),
    index('ix_orcamentos_venda_id').on(t.vendaId),
    index('ix_orcamentos_reservado_terminal_id').on(t.reservadoTerminalId),
    check('ck_orcamentos_status', sql`status in (${listaSql(STATUS_ORCAMENTO)})`),
    check('ck_orcamentos_respondido', sql`respondido in (${listaSql(RESPOSTAS_ORCAMENTO)})`),
    check('ck_orcamentos_respondido_em', sql`(respondido = 'nao') = (respondido_em is null)`),
    check(
      'ck_orcamentos_desconto_tipo',
      sql`desconto_tipo is null or desconto_tipo in (${listaSql(TIPOS_DESCONTO_ORCAMENTO)})`,
    ),
    check('ck_orcamentos_dias_validade', sql`dias_validade between 0 and 365`),
    check(
      'ck_orcamentos_valores',
      sql`desconto_valor >= 0 and subtotal_bruto >= 0 and total >= 0 and (desconto_pct is null or desconto_pct between 0 and 100)`,
    ),
    check('ck_orcamentos_origem', sql`origem in (${listaSql(ORIGENS_ORCAMENTO)})`),
    check('ck_orcamentos_origem_terminal', sql`origem = 'erp' or origem_terminal_id is not null`),
    check('ck_orcamentos_convertido', sql`status <> 'convertido' or convertido_em is not null`),
    check('ck_orcamentos_reserva', sql`(reservado_terminal_id is null) = (reservado_ate is null)`),
  ],
);

/** C (↓ com o orçamento): os itens, na ordem de `sequencia`. */
export const itensOrcamento = pgTable(
  'itens_orcamento',
  {
    ...colunasPadrao(),
    orcamentoId: uuid('orcamento_id').notNull(),
    sequencia: integer('sequencia').notNull(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    descricao: varchar('descricao', { length: 120 }).notNull(),
    unidade: varchar('unidade', { length: 6 }).notNull(),
    quantidade: quantidade('quantidade').notNull(),
    precoUnitario: preco('preco_unitario').notNull(),
    descontoItem: dinheiro('desconto_item').notNull().default('0'),
    valorTotal: dinheiro('valor_total').notNull(),
    observacao: varchar('observacao', { length: 255 }),
  },
  (t) => [
    primaryKey({ name: 'pk_itens_orcamento', columns: [t.id] }),
    foreignKey({
      name: 'fk_itens_orcamento_orcamento_id',
      columns: [t.orcamentoId],
      foreignColumns: [orcamentos.id],
    }),
    foreignKey({
      name: 'fk_itens_orcamento_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_itens_orcamento_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    uniqueIndex('uq_itens_orcamento_sequencia').on(t.orcamentoId, t.sequencia),
    index('ix_itens_orcamento_produto_id').on(t.produtoId),
    index('ix_itens_orcamento_variacao_id').on(t.variacaoId),
    check('ck_itens_orcamento_quantidade', sql`quantidade > 0`),
    check('ck_itens_orcamento_valores', sql`preco_unitario >= 0 and desconto_item >= 0 and valor_total >= 0`),
  ],
);
