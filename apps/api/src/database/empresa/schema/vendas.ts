/**
 * MD 3.11.2–3.11.6 – vendas do PDV (e, a partir da Fase 3, do ERP): cabeçalho, itens, complementos, pagamentos,
 * parcelas, transações TEF e cobranças PIX. Nascem no PDV e chegam por evento (`venda.finalizada`,
 * `venda.cancelada`, SYNC 9.7 e 9.9); o SQLite do PDV tem as mesmas colunas (o `EsquemaNuvemTests` confere contra o
 * `Esquema.g.cs`). Nada daqui desce ao PDV (`fn_versao_local`); o estado alterado fora do terminal volta pela
 * projeção `vendas_status_pdv` (MD 3.11.9, Fase 3).
 *
 * Imutabilidade de `vendas` depois de `finalizada` (`fn_protege_imutavel`) e as FKs de autoria ficam na migração
 * customizada (0012). Colunas que apontam para tabelas que ainda não existem (orçamentos, comandas, pedidos,
 * promoções, vales, complementos, contas financeiras) ficam sem FK até a tabela entrar.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { colunasAutoria, colunasPadrao, timestamptz } from '../../colunas.js';
import { usuarios } from './acesso.js';
import { sessoesCaixa } from './caixa.js';
import { caixas, lojas } from './estrutura.js';
import { formasPagamento } from './financeiro.js';
import { pessoas, pessoasEnderecos } from './pessoas.js';
import {
  gruposPrecoQuantidade,
  produtos,
  produtosCodigosBarras,
  produtosComponentes,
  produtosComponentesAlternativas,
  produtosLotes,
  produtosVariacoes,
} from './produtos.js';
import { terminais } from './sincronizacao.js';

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));
const quantidade = (nome: string) => numeric(nome, { precision: 15, scale: 3 });
const preco = (nome: string) => numeric(nome, { precision: 15, scale: 4 });
const dinheiro = (nome: string) => numeric(nome, { precision: 15, scale: 2 });
const percentual = (nome: string) => numeric(nome, { precision: 7, scale: 4 });

export const TIPOS_VENDA = ['pdv', 'venda'] as const;
export const CANAIS_VENDA = [
  'pdv',
  'erp',
  'ifood',
  '99food',
  'woocommerce',
  'nuvemshop',
  'menu_digital',
  'totem',
] as const;
export const MODOS_VENDA = ['balcao', 'comanda', 'pedido', 'delivery'] as const;
/** Na nuvem só chegam `pedido_pendente`, `finalizada` e `cancelada`; os demais são do PDV e do rascunho do ERP. */
export const STATUS_VENDA = [
  'rascunho',
  'em_andamento',
  'em_pagamento',
  'suspensa',
  'pedido_pendente',
  'finalizada',
  'cancelada',
] as const;
/** Estados em que a venda ainda é editável; fora deles vale a imutabilidade (MD 3.11.2; trigger da 0012). */
export const STATUS_VENDA_ABERTOS = [
  'rascunho',
  'em_andamento',
  'em_pagamento',
  'suspensa',
  'pedido_pendente',
] as const;
export const STATUS_FISCAL_VENDA = [
  'nao_aplicavel',
  'pendente',
  'transmitindo',
  'autorizada',
  'contingencia',
  'rejeitada',
  'denegada',
  'cancelamento_pendente',
  'cancelada',
  'inutilizada',
  'nfe_solicitada',
] as const;
export const ORIGENS_PRECO_ITEM = [
  'varejo',
  'loja',
  'promocional',
  'atacado',
  'quantidade',
  'grupo_mix',
  'parcelado',
  'manual',
  'balanca',
  'orcamento',
  'kit_rateio',
  'embalagem',
] as const;
export const ORIGENS_ENTRADA_ITEM = [
  'leitor',
  'teclado',
  'balanca',
  'etiqueta',
  'busca',
  'cardapio',
] as const;
export const STATUS_PAGAMENTO_VENDA = ['pendente', 'aprovado', 'cancelado', 'estornado'] as const;
export const DEVOLUCOES_VENDA = ['nenhuma', 'parcial', 'total'] as const;
export const TIPOS_PRECO_VENDA = ['varejo', 'atacado', 'parcelado'] as const;
export const ORIGENS_CANCELAMENTO_VENDA = ['pdv', 'erp'] as const;
export const ORIGENS_DESCONTO_TOTAL_VENDA = ['operador', 'cliente', 'orcamento'] as const;
export const OPERACOES_TRANSACAO_TEF = ['venda', 'cancelamento', 'administrativa'] as const;
export const STATUS_TRANSACAO_TEF = [
  'iniciada',
  'negada',
  'aprovada_pendente_confirmacao',
  'confirmada',
  'desfeita',
  'cancelada',
] as const;
export const TIPOS_COBRANCA_PIX = ['dinamico', 'estatico'] as const;
export const STATUS_COBRANCA_PIX = [
  'ativa',
  'paga',
  'expirada',
  'cancelada',
  'devolvida',
  'paga_sem_venda',
] as const;

/**
 * D: venda (MD 3.11.2). Imutável depois de `finalizada`/`cancelada`, salvo `status`, `status_fiscal`, `devolucao`,
 * `custo_total` e as colunas de cancelamento (trigger `tg_vendas_imutavel`, 0012).
 */
export const vendas = pgTable(
  'vendas',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    numero: bigint('numero', { mode: 'number' }).notNull(),
    numeroExibicao: varchar('numero_exibicao', { length: 20 }).notNull(),
    lojaId: uuid('loja_id').notNull(),
    caixaId: uuid('caixa_id').notNull(),
    numeroCaixa: smallint('numero_caixa').notNull(),
    terminalId: uuid('terminal_id'),
    sessaoCaixaId: uuid('sessao_caixa_id'),
    tipo: varchar('tipo', { length: 5 }).notNull(),
    canal: varchar('canal', { length: 15 }).notNull().default('pdv'),
    modo: varchar('modo', { length: 10 }).notNull().default('balcao'),
    idExterno: varchar('id_externo', { length: 60 }),
    status: varchar('status', { length: 16 }).notNull().default('em_andamento'),
    statusFiscal: varchar('status_fiscal', { length: 22 }).notNull().default('nao_aplicavel'),
    devolucao: varchar('devolucao', { length: 8 }).notNull().default('nenhuma'),
    diaOperacional: date('dia_operacional'),
    operadorId: uuid('operador_id').notNull(),
    vendedorId: uuid('vendedor_id'),
    clienteId: uuid('cliente_id'),
    cpfCnpjNota: varchar('cpf_cnpj_nota', { length: 14 }),
    nomeNota: varchar('nome_nota', { length: 60 }),
    tipoPreco: varchar('tipo_preco', { length: 10 }).notNull().default('varejo'),
    orcamentoId: uuid('orcamento_id'),
    comandaId: uuid('comanda_id'),
    pedidoId: uuid('pedido_id'),
    qtdItens: integer('qtd_itens').notNull().default(0),
    subtotalBruto: dinheiro('subtotal_bruto').notNull().default('0'),
    descontoItens: dinheiro('desconto_itens').notNull().default('0'),
    descontoTotal: dinheiro('desconto_total').notNull().default('0'),
    descontoTotalPct: percentual('desconto_total_pct'),
    descontoTotalOrigem: varchar('desconto_total_origem', { length: 9 }),
    acrescimoTotal: dinheiro('acrescimo_total').notNull().default('0'),
    taxaServico: dinheiro('taxa_servico').notNull().default('0'),
    taxaEntrega: dinheiro('taxa_entrega').notNull().default('0'),
    valorFrete: dinheiro('valor_frete').notNull().default('0'),
    total: dinheiro('total').notNull().default('0'),
    troco: dinheiro('troco').notNull().default('0'),
    custoTotal: dinheiro('custo_total'),
    enderecoEntregaId: uuid('endereco_entrega_id'),
    enderecoEntrega: jsonb('endereco_entrega'),
    enderecoFaturamentoId: uuid('endereco_faturamento_id'),
    dataEntrega: date('data_entrega'),
    observacaoNfe: text('observacao_nfe'),
    observacao: varchar('observacao', { length: 500 }),
    freteModalidade: char('frete_modalidade', { length: 1 }),
    freteTipo: varchar('frete_tipo', { length: 30 }),
    transportadoraId: uuid('transportadora_id'),
    volumes: jsonb('volumes'),
    qtdParcelas: smallint('qtd_parcelas'),
    iniciadaEm: timestamptz('iniciada_em').notNull(),
    finalizadaEm: timestamptz('finalizada_em'),
    canceladaEm: timestamptz('cancelada_em'),
    canceladaPorId: uuid('cancelada_por_id'),
    cancelamentoAutorizadoPorId: uuid('cancelamento_autorizado_por_id'),
    motivoCancelamento: varchar('motivo_cancelamento', { length: 255 }),
    cancelamentoOrigem: varchar('cancelamento_origem', { length: 4 }),
    idadeConfirmadaPorId: uuid('idade_confirmada_por_id'),
    idadeConfirmadaEm: timestamptz('idade_confirmada_em'),
    eventoFinalizacaoId: uuid('evento_finalizacao_id'),
    /**
     * `false` quando o PDV finalizou a venda sem hora confiável (`relogio_confiavel` do envelope, SYNC 12.3–12.4;
     * decisão técnica T5 da 1C): o ERP mostra o ícone "hora não confirmada". Venda do ERP: hora do servidor.
     */
    relogioConfiavel: boolean('relogio_confiavel').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'pk_vendas', columns: [t.id] }),
    foreignKey({ name: 'fk_vendas_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_vendas_caixa_id', columns: [t.caixaId], foreignColumns: [caixas.id] }),
    foreignKey({ name: 'fk_vendas_terminal_id', columns: [t.terminalId], foreignColumns: [terminais.id] }),
    foreignKey({
      name: 'fk_vendas_sessao_caixa_id',
      columns: [t.sessaoCaixaId],
      foreignColumns: [sessoesCaixa.id],
    }),
    foreignKey({ name: 'fk_vendas_operador_id', columns: [t.operadorId], foreignColumns: [usuarios.id] }),
    foreignKey({ name: 'fk_vendas_vendedor_id', columns: [t.vendedorId], foreignColumns: [usuarios.id] }),
    foreignKey({ name: 'fk_vendas_cliente_id', columns: [t.clienteId], foreignColumns: [pessoas.id] }),
    foreignKey({
      name: 'fk_vendas_endereco_entrega_id',
      columns: [t.enderecoEntregaId],
      foreignColumns: [pessoasEnderecos.id],
    }),
    foreignKey({
      name: 'fk_vendas_endereco_faturamento_id',
      columns: [t.enderecoFaturamentoId],
      foreignColumns: [pessoasEnderecos.id],
    }),
    foreignKey({
      name: 'fk_vendas_transportadora_id',
      columns: [t.transportadoraId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({
      name: 'fk_vendas_cancelada_por_id',
      columns: [t.canceladaPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_vendas_cancelamento_autorizado_por_id',
      columns: [t.cancelamentoAutorizadoPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_vendas_idade_confirmada_por_id',
      columns: [t.idadeConfirmadaPorId],
      foreignColumns: [usuarios.id],
    }),
    // Número por caixa (SYNC 13.1): o 23505 desta restrição vira NUMERO_VENDA_DUPLICADO (sync/erros.ts).
    uniqueIndex('uq_vendas_numero').on(t.lojaId, t.numeroCaixa, t.numero),
    uniqueIndex('uq_vendas_canal_id_externo')
      .on(t.canal, t.idExterno)
      .where(sql`id_externo is not null`),
    index('ix_vendas_loja_finalizada').on(t.lojaId, t.finalizadaEm),
    index('ix_vendas_dia_operacional').on(t.lojaId, t.diaOperacional),
    index('ix_vendas_caixa_id').on(t.caixaId),
    index('ix_vendas_terminal_id').on(t.terminalId),
    index('ix_vendas_sessao_caixa_id').on(t.sessaoCaixaId),
    index('ix_vendas_operador_id').on(t.operadorId),
    index('ix_vendas_vendedor_id').on(t.vendedorId),
    index('ix_vendas_cliente_id').on(t.clienteId),
    index('ix_vendas_endereco_entrega_id').on(t.enderecoEntregaId),
    index('ix_vendas_endereco_faturamento_id').on(t.enderecoFaturamentoId),
    index('ix_vendas_transportadora_id').on(t.transportadoraId),
    index('ix_vendas_cancelada_por_id').on(t.canceladaPorId),
    index('ix_vendas_cancelamento_autorizado_por_id').on(t.cancelamentoAutorizadoPorId),
    index('ix_vendas_idade_confirmada_por_id').on(t.idadeConfirmadaPorId),
    check('ck_vendas_tipo', sql`tipo in (${listaSql(TIPOS_VENDA)})`),
    check('ck_vendas_canal', sql`canal in (${listaSql(CANAIS_VENDA)})`),
    check('ck_vendas_modo', sql`modo in (${listaSql(MODOS_VENDA)})`),
    check('ck_vendas_status', sql`status in (${listaSql(STATUS_VENDA)})`),
    check('ck_vendas_status_fiscal', sql`status_fiscal in (${listaSql(STATUS_FISCAL_VENDA)})`),
    check('ck_vendas_devolucao', sql`devolucao in (${listaSql(DEVOLUCOES_VENDA)})`),
    check('ck_vendas_tipo_preco', sql`tipo_preco in (${listaSql(TIPOS_PRECO_VENDA)})`),
    check(
      'ck_vendas_cancelamento_origem',
      sql`cancelamento_origem is null or cancelamento_origem in (${listaSql(ORIGENS_CANCELAMENTO_VENDA)})`,
    ),
    check(
      'ck_vendas_desconto_total_origem',
      sql`desconto_total_origem is null or desconto_total_origem in (${listaSql(ORIGENS_DESCONTO_TOTAL_VENDA)})`,
    ),
    check(
      'ck_vendas_valores',
      sql`subtotal_bruto >= 0 and desconto_itens >= 0 and desconto_total >= 0 and acrescimo_total >= 0 and taxa_servico >= 0 and taxa_entrega >= 0 and valor_frete >= 0 and total >= 0 and troco >= 0`,
    ),
    check('ck_vendas_finalizada', sql`status <> 'finalizada' or finalizada_em is not null`),
    check(
      'ck_vendas_cpf_cnpj_nota',
      sql`cpf_cnpj_nota is null or cpf_cnpj_nota ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'`,
    ),
    check(
      'ck_vendas_cancelada',
      sql`status <> 'cancelada' or (cancelada_em is not null and motivo_cancelamento is not null)`,
    ),
    check(
      'ck_vendas_idade_confirmada',
      sql`(idade_confirmada_por_id is null) = (idade_confirmada_em is null)`,
    ),
  ],
);

/** D: item da venda (MD 3.11.3); componentes de combo são linhas próprias ligadas por `kit_grupo_id`. */
export const itensVenda = pgTable(
  'itens_venda',
  {
    ...colunasPadrao(),
    vendaId: uuid('venda_id').notNull(),
    sequencia: integer('sequencia').notNull(),
    produtoId: uuid('produto_id').notNull(),
    variacaoId: uuid('variacao_id'),
    codigoLido: varchar('codigo_lido', { length: 30 }),
    codigoBarrasId: uuid('codigo_barras_id'),
    origemEntrada: varchar('origem_entrada', { length: 8 }),
    pesoDigitado: boolean('peso_digitado').notNull().default(false),
    descricao: varchar('descricao', { length: 120 }).notNull(),
    unidade: varchar('unidade', { length: 6 }).notNull(),
    quantidade: quantidade('quantidade').notNull(),
    precoTabela: preco('preco_tabela').notNull(),
    precoUnitario: preco('preco_unitario').notNull(),
    origemPreco: varchar('origem_preco', { length: 12 }).notNull().default('varejo'),
    grupoPrecoQuantidadeId: uuid('grupo_preco_quantidade_id'),
    quantidadeReferenciaPreco: quantidade('quantidade_referencia_preco'),
    valorBruto: dinheiro('valor_bruto').notNull(),
    descontoItem: dinheiro('desconto_item').notNull().default('0'),
    descontoPromocao: dinheiro('desconto_promocao').notNull().default('0'),
    promocaoId: uuid('promocao_id'),
    descontoRateado: dinheiro('desconto_rateado').notNull().default('0'),
    acrescimoRateado: dinheiro('acrescimo_rateado').notNull().default('0'),
    freteRateado: dinheiro('frete_rateado').notNull().default('0'),
    valorLiquido: dinheiro('valor_liquido').notNull(),
    loteId: uuid('lote_id'),
    lote: varchar('lote', { length: 30 }),
    validadeLote: date('validade_lote'),
    kitGrupoId: uuid('kit_grupo_id'),
    kitProdutoId: uuid('kit_produto_id'),
    kitDescricao: varchar('kit_descricao', { length: 120 }),
    kitQuantidade: quantidade('kit_quantidade'),
    kitPrecoUnitario: preco('kit_preco_unitario'),
    kitComponenteId: uuid('kit_componente_id'),
    kitAlternativaId: uuid('kit_alternativa_id'),
    kitAcrescimo: preco('kit_acrescimo').notNull().default('0'),
    vasilhameItemOrigemId: uuid('vasilhame_item_origem_id'),
    itemComandaId: uuid('item_comanda_id'),
    itemOrcamentoId: uuid('item_orcamento_id'),
    vendedorId: uuid('vendedor_id'),
    comissaoPct: percentual('comissao_pct'),
    valorComissao: dinheiro('valor_comissao'),
    custoUnitario: preco('custo_unitario'),
    cfop: varchar('cfop', { length: 4 }),
    ncm: varchar('ncm', { length: 8 }),
    fiscalSnapshot: jsonb('fiscal_snapshot'),
    vIbs: dinheiro('v_ibs'),
    vCbs: dinheiro('v_cbs'),
    vIs: dinheiro('v_is'),
    vFcp: dinheiro('v_fcp'),
    vIcmsStRet: dinheiro('v_icms_st_ret'),
    vFcpStRet: dinheiro('v_fcp_st_ret'),
    quantidadeDevolvida: quantidade('quantidade_devolvida').notNull().default('0'),
    cancelado: boolean('cancelado').notNull().default(false),
    canceladoEm: timestamptz('cancelado_em'),
    canceladoPorId: uuid('cancelado_por_id'),
    autorizadoPorId: uuid('autorizado_por_id'),
    motivoCancelamento: varchar('motivo_cancelamento', { length: 255 }),
    incluidoEm: timestamptz('incluido_em').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_itens_venda', columns: [t.id] }),
    foreignKey({ name: 'fk_itens_venda_venda_id', columns: [t.vendaId], foreignColumns: [vendas.id] }),
    foreignKey({ name: 'fk_itens_venda_produto_id', columns: [t.produtoId], foreignColumns: [produtos.id] }),
    foreignKey({
      name: 'fk_itens_venda_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_itens_venda_codigo_barras_id',
      columns: [t.codigoBarrasId],
      foreignColumns: [produtosCodigosBarras.id],
    }),
    foreignKey({
      name: 'fk_itens_venda_grupo_preco_quantidade_id',
      columns: [t.grupoPrecoQuantidadeId],
      foreignColumns: [gruposPrecoQuantidade.id],
    }),
    foreignKey({ name: 'fk_itens_venda_lote_id', columns: [t.loteId], foreignColumns: [produtosLotes.id] }),
    foreignKey({
      name: 'fk_itens_venda_kit_produto_id',
      columns: [t.kitProdutoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_itens_venda_kit_componente_id',
      columns: [t.kitComponenteId],
      foreignColumns: [produtosComponentes.id],
    }),
    foreignKey({
      name: 'fk_itens_venda_kit_alternativa_id',
      columns: [t.kitAlternativaId],
      foreignColumns: [produtosComponentesAlternativas.id],
    }),
    foreignKey({
      name: 'fk_itens_venda_vasilhame_item_origem_id',
      columns: [t.vasilhameItemOrigemId],
      foreignColumns: [t.id],
    }),
    foreignKey({
      name: 'fk_itens_venda_vendedor_id',
      columns: [t.vendedorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_itens_venda_cancelado_por_id',
      columns: [t.canceladoPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_itens_venda_autorizado_por_id',
      columns: [t.autorizadoPorId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_itens_venda_sequencia').on(t.vendaId, t.sequencia),
    index('ix_itens_venda_produto_id').on(t.produtoId),
    index('ix_itens_venda_kit_grupo_id').on(t.kitGrupoId),
    index('ix_itens_venda_variacao_id').on(t.variacaoId),
    index('ix_itens_venda_codigo_barras_id').on(t.codigoBarrasId),
    index('ix_itens_venda_grupo_preco_quantidade_id').on(t.grupoPrecoQuantidadeId),
    index('ix_itens_venda_lote_id').on(t.loteId),
    index('ix_itens_venda_kit_produto_id').on(t.kitProdutoId),
    index('ix_itens_venda_kit_componente_id').on(t.kitComponenteId),
    index('ix_itens_venda_kit_alternativa_id').on(t.kitAlternativaId),
    index('ix_itens_venda_vasilhame_item_origem_id').on(t.vasilhameItemOrigemId),
    index('ix_itens_venda_vendedor_id').on(t.vendedorId),
    index('ix_itens_venda_cancelado_por_id').on(t.canceladoPorId),
    index('ix_itens_venda_autorizado_por_id').on(t.autorizadoPorId),
    check('ck_itens_venda_quantidade', sql`quantidade > 0`),
    check(
      'ck_itens_venda_valores',
      sql`valor_bruto >= 0 and desconto_item >= 0 and desconto_promocao >= 0 and desconto_rateado >= 0 and valor_liquido >= 0`,
    ),
    check('ck_itens_venda_promocao', sql`desconto_promocao = 0 or promocao_id is not null`),
    check('ck_itens_venda_devolvida', sql`quantidade_devolvida between 0 and quantidade`),
    check('ck_itens_venda_origem_preco', sql`origem_preco in (${listaSql(ORIGENS_PRECO_ITEM)})`),
    check(
      'ck_itens_venda_origem_entrada',
      sql`origem_entrada is null or origem_entrada in (${listaSql(ORIGENS_ENTRADA_ITEM)})`,
    ),
    check(
      'ck_itens_venda_kit',
      sql`(kit_grupo_id is null) = (kit_produto_id is null) and (kit_grupo_id is null) = (kit_componente_id is null) and (kit_grupo_id is null or (kit_quantidade > 0 and kit_preco_unitario >= 0 and kit_descricao is not null)) and (kit_alternativa_id is null or kit_grupo_id is not null) and kit_acrescimo >= 0`,
    ),
  ],
);

/** Complementos/adicionais escolhidos no item (MD 3.11.3); `complemento_id` → `produtos_complementos` (futuro). */
export const itensVendaComplementos = pgTable(
  'itens_venda_complementos',
  {
    ...colunasPadrao(),
    itemVendaId: uuid('item_venda_id').notNull(),
    complementoId: uuid('complemento_id'),
    grupoNome: varchar('grupo_nome', { length: 40 }).notNull(),
    descricao: varchar('descricao', { length: 60 }).notNull(),
    quantidade: quantidade('quantidade').notNull().default('1'),
    precoAdicional: preco('preco_adicional').notNull().default('0'),
  },
  (t) => [
    primaryKey({ name: 'pk_itens_venda_complementos', columns: [t.id] }),
    foreignKey({
      name: 'fk_itens_venda_complementos_item_venda_id',
      columns: [t.itemVendaId],
      foreignColumns: [itensVenda.id],
    }),
    index('ix_itens_venda_complementos_item_venda_id').on(t.itemVendaId),
  ],
);

/**
 * D: transação TEF (MD 3.11.5). `venda_id` e `pagamento_venda_id` ficam sem FK: a transação é registrada (e pode
 * chegar por `tef.resolvida`, SYNC 9.8) antes da venda existir na nuvem; quem aponta com FK é o pagamento
 * (`pagamentos_venda.tef_transacao_id`).
 */
export const transacoesTef = pgTable(
  'transacoes_tef',
  {
    ...colunasPadrao(),
    lojaId: uuid('loja_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    vendaId: uuid('venda_id'),
    pagamentoVendaId: uuid('pagamento_venda_id'),
    provedor: varchar('provedor', { length: 10 }).notNull(),
    operacao: varchar('operacao', { length: 14 }).notNull().default('venda'),
    status: varchar('status', { length: 32 }).notNull().default('iniciada'),
    valor: dinheiro('valor').notNull(),
    parcelas: smallint('parcelas').notNull().default(1),
    tipoCartao: varchar('tipo_cartao', { length: 8 }),
    bandeira: varchar('bandeira', { length: 2 }),
    bandeiraNome: varchar('bandeira_nome', { length: 30 }),
    adquirente: varchar('adquirente', { length: 40 }),
    cnpjCredenciadora: varchar('cnpj_credenciadora', { length: 14 }),
    nsu: varchar('nsu', { length: 20 }),
    nsuHost: varchar('nsu_host', { length: 20 }),
    autorizacao: varchar('autorizacao', { length: 20 }),
    codigoResposta: varchar('codigo_resposta', { length: 10 }),
    mensagem: varchar('mensagem', { length: 255 }),
    cartaoMascarado: varchar('cartao_mascarado', { length: 20 }),
    dataHoraTransacao: timestamptz('data_hora_transacao'),
    comprovanteCliente: text('comprovante_cliente'),
    comprovanteLoja: text('comprovante_loja'),
    transacaoOriginalId: uuid('transacao_original_id'),
    iniciadaEm: timestamptz('iniciada_em').notNull(),
    confirmadaEm: timestamptz('confirmada_em'),
    desfeitaEm: timestamptz('desfeita_em'),
    canceladaEm: timestamptz('cancelada_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_transacoes_tef', columns: [t.id] }),
    foreignKey({ name: 'fk_transacoes_tef_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_transacoes_tef_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    foreignKey({
      name: 'fk_transacoes_tef_transacao_original_id',
      columns: [t.transacaoOriginalId],
      foreignColumns: [t.id],
    }),
    index('ix_transacoes_tef_venda_id').on(t.vendaId),
    index('ix_transacoes_tef_nsu').on(t.nsu),
    index('ix_transacoes_tef_loja_id').on(t.lojaId),
    index('ix_transacoes_tef_terminal_id').on(t.terminalId),
    index('ix_transacoes_tef_transacao_original_id').on(t.transacaoOriginalId),
    check('ck_transacoes_tef_status', sql`status in (${listaSql(STATUS_TRANSACAO_TEF)})`),
    check('ck_transacoes_tef_operacao', sql`operacao in (${listaSql(OPERACOES_TRANSACAO_TEF)})`),
  ],
);

/**
 * D: cobrança PIX (MD 3.11.6). A dinâmica nasce na nuvem antes da venda chegar (Fase 6), a estática no PDV: como na
 * TEF, `venda_id` e `pagamento_venda_id` ficam sem FK e quem aponta é o pagamento (`pix_cobranca_id`).
 */
export const cobrancasPix = pgTable(
  'cobrancas_pix',
  {
    ...colunasPadrao(),
    txid: varchar('txid', { length: 35 }).notNull(),
    tipo: varchar('tipo', { length: 9 }).notNull(),
    lojaId: uuid('loja_id').notNull(),
    terminalId: uuid('terminal_id').notNull(),
    vendaId: uuid('venda_id'),
    pagamentoVendaId: uuid('pagamento_venda_id'),
    psp: varchar('psp', { length: 30 }),
    valor: dinheiro('valor').notNull(),
    status: varchar('status', { length: 16 }).notNull().default('ativa'),
    qrcodePayload: text('qrcode_payload').notNull(),
    expiraEm: timestamptz('expira_em'),
    pagaEm: timestamptz('paga_em'),
    e2eId: varchar('e2e_id', { length: 32 }),
    pagadorNome: varchar('pagador_nome', { length: 60 }),
    pagadorDocumento: varchar('pagador_documento', { length: 14 }),
    valorDevolvido: dinheiro('valor_devolvido').notNull().default('0'),
    devolvidaEm: timestamptz('devolvida_em'),
  },
  (t) => [
    primaryKey({ name: 'pk_cobrancas_pix', columns: [t.id] }),
    foreignKey({ name: 'fk_cobrancas_pix_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_cobrancas_pix_terminal_id',
      columns: [t.terminalId],
      foreignColumns: [terminais.id],
    }),
    // Único só no dinâmico, cujo `txid` vem do PSP (Fase 6). No estático o `txid` é o número da venda (PDV 16.7), e
    // a venda dividida em dois PIX gera duas cobranças com o mesmo `txid`: a unicidade global recusaria o
    // `venda.finalizada` inteiro (23505 → AGREGADO_DIVERGENTE). O índice comum atende à conciliação pelo `txid`.
    uniqueIndex('uq_cobrancas_pix_txid')
      .on(t.txid)
      .where(sql`tipo = 'dinamico'`),
    index('ix_cobrancas_pix_txid').on(t.txid),
    index('ix_cobrancas_pix_venda_id').on(t.vendaId),
    index('ix_cobrancas_pix_loja_id').on(t.lojaId),
    index('ix_cobrancas_pix_terminal_id').on(t.terminalId),
    check('ck_cobrancas_pix_tipo', sql`tipo in (${listaSql(TIPOS_COBRANCA_PIX)})`),
    check('ck_cobrancas_pix_status', sql`status in (${listaSql(STATUS_COBRANCA_PIX)})`),
  ],
);

/** D: pagamento da venda (MD 3.11.4), com os snapshots da forma e os dados do grupo `detPag`/`card` da NFC-e. */
export const pagamentosVenda = pgTable(
  'pagamentos_venda',
  {
    ...colunasPadrao(),
    vendaId: uuid('venda_id').notNull(),
    sequencia: smallint('sequencia').notNull(),
    formaPagamentoId: uuid('forma_pagamento_id').notNull(),
    descricaoForma: varchar('descricao_forma', { length: 40 }).notNull(),
    meioPagamentoFiscal: varchar('meio_pagamento_fiscal', { length: 2 }).notNull(),
    tipoForma: varchar('tipo_forma', { length: 20 }).notNull(),
    valor: dinheiro('valor').notNull(),
    valorRecebido: dinheiro('valor_recebido'),
    troco: dinheiro('troco').notNull().default('0'),
    valorTaxaServico: dinheiro('valor_taxa_servico').notNull().default('0'),
    parcelas: smallint('parcelas').notNull().default(1),
    status: varchar('status', { length: 10 }).notNull().default('aprovado'),
    lancaQuitada: boolean('lanca_quitada').notNull(),
    taxaPct: percentual('taxa_pct').notNull().default('0'),
    pessoaId: uuid('pessoa_id'),
    indicadorPagamento: smallint('indicador_pagamento').notNull().default(0),
    dataPagamento: date('data_pagamento'),
    cnpjPagamento: varchar('cnpj_pagamento', { length: 14 }),
    ufPagamento: char('uf_pagamento', { length: 2 }),
    tipoIntegracao: smallint('tipo_integracao'),
    bandeira: varchar('bandeira', { length: 2 }),
    bandeiraNome: varchar('bandeira_nome', { length: 30 }),
    adquirente: varchar('adquirente', { length: 40 }),
    cnpjCredenciadora: varchar('cnpj_credenciadora', { length: 14 }),
    nsu: varchar('nsu', { length: 20 }),
    autorizacao: varchar('autorizacao', { length: 20 }),
    cartaoMascarado: varchar('cartao_mascarado', { length: 20 }),
    cnpjBeneficiario: varchar('cnpj_beneficiario', { length: 14 }),
    idTerminalPagamento: varchar('id_terminal_pagamento', { length: 40 }),
    tefTransacaoId: uuid('tef_transacao_id'),
    pixCobrancaId: uuid('pix_cobranca_id'),
    // → `vales` (Fase 3) e `contas_financeiras` (Fase 4): FK quando as tabelas existirem.
    valeId: uuid('vale_id'),
    transferidoDeId: uuid('transferido_de_id'),
    autorizadoPorId: uuid('autorizado_por_id'),
    contaFinanceiraId: uuid('conta_financeira_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_pagamentos_venda', columns: [t.id] }),
    foreignKey({ name: 'fk_pagamentos_venda_venda_id', columns: [t.vendaId], foreignColumns: [vendas.id] }),
    foreignKey({
      name: 'fk_pagamentos_venda_forma_pagamento_id',
      columns: [t.formaPagamentoId],
      foreignColumns: [formasPagamento.id],
    }),
    foreignKey({
      name: 'fk_pagamentos_venda_pessoa_id',
      columns: [t.pessoaId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({
      name: 'fk_pagamentos_venda_tef_transacao_id',
      columns: [t.tefTransacaoId],
      foreignColumns: [transacoesTef.id],
    }),
    foreignKey({
      name: 'fk_pagamentos_venda_pix_cobranca_id',
      columns: [t.pixCobrancaId],
      foreignColumns: [cobrancasPix.id],
    }),
    foreignKey({
      name: 'fk_pagamentos_venda_transferido_de_id',
      columns: [t.transferidoDeId],
      foreignColumns: [t.id],
    }),
    foreignKey({
      name: 'fk_pagamentos_venda_autorizado_por_id',
      columns: [t.autorizadoPorId],
      foreignColumns: [usuarios.id],
    }),
    uniqueIndex('uq_pagamentos_venda_sequencia').on(t.vendaId, t.sequencia),
    index('ix_pagamentos_venda_forma_pagamento_id').on(t.formaPagamentoId),
    index('ix_pagamentos_venda_nsu').on(t.nsu),
    index('ix_pagamentos_venda_pessoa_id').on(t.pessoaId),
    index('ix_pagamentos_venda_tef_transacao_id').on(t.tefTransacaoId),
    index('ix_pagamentos_venda_pix_cobranca_id').on(t.pixCobrancaId),
    index('ix_pagamentos_venda_transferido_de_id').on(t.transferidoDeId),
    index('ix_pagamentos_venda_autorizado_por_id').on(t.autorizadoPorId),
    check(
      'ck_pagamentos_venda_valor',
      sql`valor > 0 and troco >= 0 and valor_taxa_servico between 0 and valor`,
    ),
    check('ck_pagamentos_venda_status', sql`status in (${listaSql(STATUS_PAGAMENTO_VENDA)})`),
    check('ck_pagamentos_venda_parcelas', sql`parcelas >= 1`),
    check('ck_pagamentos_venda_tipo_integracao', sql`tipo_integracao is null or tipo_integracao in (1,2)`),
    check('ck_pagamentos_venda_indicador', sql`indicador_pagamento in (0,1)`),
    check('ck_pagamentos_venda_uf_pagamento', sql`(cnpj_pagamento is null) = (uf_pagamento is null)`),
  ],
);

/** Vencimentos definidos no caixa para crediário/boleto/crédito (MD 3.11.4). */
export const parcelasVenda = pgTable(
  'parcelas_venda',
  {
    ...colunasPadrao(),
    pagamentoVendaId: uuid('pagamento_venda_id').notNull(),
    numero: smallint('numero').notNull(),
    vencimento: date('vencimento').notNull(),
    valor: dinheiro('valor').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_parcelas_venda', columns: [t.id] }),
    foreignKey({
      name: 'fk_parcelas_venda_pagamento_venda_id',
      columns: [t.pagamentoVendaId],
      foreignColumns: [pagamentosVenda.id],
    }),
    uniqueIndex('uq_parcelas_venda').on(t.pagamentoVendaId, t.numero),
    check('ck_parcelas_venda_valor', sql`valor > 0`),
  ],
);
