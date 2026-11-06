/**
 * MD 3.8 – compras e entradas: recebimento manual de mercadoria (`recebimentos`, `itens_recebimento`, MD 3.8.1; ERP
 * 13.3; Fase 2, F2-B14) e a NF-e de fornecedor por XML (`notas_entrada`, `itens_nota_entrada`,
 * `notas_entrada_duplicatas`, MD 3.8.2; ERP 13.4; Fase 2, F2-B18).
 *
 * O recebimento é imutável fora de `rascunho` (`fn_protege_imutavel`, com as colunas do estorno liberadas) e os itens
 * só mudam com o recebimento em rascunho (`tg_itens_recebimento_rascunho`): os dois triggers, a sequência do `codigo`,
 * as FKs de autoria e o trigger de versão (`fn_versao_local`: o recebimento não desce ao PDV) ficam na migração
 * customizada `0023_recebimentos`. A NF-e segue o mesmo desenho na `0024_notas_entrada`: o que veio do XML nunca muda,
 * a nota é imutável depois de movimentada e os itens e as duplicatas só mudam com a nota pendente ou pronta.
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
import { estoques, lojas, tiposEstoque } from './estrutura.js';
import { formasPagamento, planosContas } from './financeiro.js';
import { pessoas } from './pessoas.js';
import { produtos, produtosCodigosBarras, produtosLotes, produtosVariacoes } from './produtos.js';
import { arquivos } from './sistema.js';

const listaSql = (valores: readonly string[]) => sql.raw(valores.map((v) => `'${v}'`).join(','));
const quantidade = (nome: string) => numeric(nome, { precision: 15, scale: 3 });
const preco = (nome: string) => numeric(nome, { precision: 15, scale: 4 });
const dinheiro = (nome: string) => numeric(nome, { precision: 15, scale: 2 });

export const STATUS_RECEBIMENTO = ['rascunho', 'movimentado', 'estornado'] as const;
/** "Atualizar preço" do item (ERP 13.3): geral (`produtos`), só da loja (`produtos_lojas`) ou não atualizar. */
export const ATUALIZAR_PRECO_RECEBIMENTO = ['geral', 'loja', 'nao'] as const;

/**
 * D: recebimento manual de mercadoria (entrada sem nota ou com nota em papel; Nuvem3 6.2), rascunho → movimentado →
 * estornado. Ao movimentar (F2-B15) gera `RECEB_MANUAL` por item no estoque × tipo de destino; o estorno gera
 * `ESTORNO_RECEB_MANUAL`. A `data_recebimento` (a data do documento) fica só no cabeçalho: o movimento lança no momento
 * da movimentação (regra de data dos documentos do ERP, F2-B4). As colunas `financeiro_*` e `conta_financeira_id`
 * são gravadas e ficam sem uso até a Fase 4 ("Gerar financeiro"); `conta_financeira_id` fica sem FK até
 * `contas_financeiras` existir.
 */
export const recebimentos = pgTable(
  'recebimentos',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_recebimentos')`),
    /** Loja destinatária (filtros e, na Fase 4, as contas a pagar); não precisa ser a dona do estoque. */
    lojaId: uuid('loja_id').notNull(),
    /** Estoque de destino das mercadorias (padrão: o vinculado à loja; o CD também serve). */
    estoqueId: uuid('estoque_id').notNull(),
    /** Tipo de estoque que recebe as mercadorias (padrão: o tipo padrão, Disponível). */
    tipoEstoqueId: uuid('tipo_estoque_id').notNull(),
    fornecedorId: uuid('fornecedor_id').notNull(),
    /** Data do documento (não futura); o razão lança no momento da movimentação. */
    dataRecebimento: date('data_recebimento')
      .notNull()
      .default(sql`current_date`),
    /** Nº do documento do fornecedor ("Cód. remessa"); repetido para o mesmo fornecedor só avisa. */
    codigoRemessa: varchar('codigo_remessa', { length: 30 }),
    temValidade: boolean('tem_validade').notNull().default(false),
    qtdItens: integer('qtd_itens').notNull().default(0),
    valorProdutos: dinheiro('valor_produtos').notNull().default('0'),
    valorFrete: dinheiro('valor_frete').notNull().default('0'),
    valorDesconto: dinheiro('valor_desconto').notNull().default('0'),
    valorOutrasDespesas: dinheiro('valor_outras_despesas').notNull().default('0'),
    /** "Total geral": produtos + frete + outras despesas − desconto. */
    valorTotal: dinheiro('valor_total').notNull().default('0'),
    observacoes: text('observacoes'),
    status: varchar('status', { length: 12 }).notNull().default('rascunho'),
    movimentadoEm: timestamptz('movimentado_em'),
    movimentadoPorId: uuid('movimentado_por_id'),
    estornadoEm: timestamptz('estornado_em'),
    estornadoPorId: uuid('estornado_por_id'),
    motivoEstorno: varchar('motivo_estorno', { length: 255 }),
    gerarFinanceiro: boolean('gerar_financeiro').notNull().default(false),
    financeiroPlanoContasId: uuid('financeiro_plano_contas_id'),
    financeiroFormaPagamentoId: uuid('financeiro_forma_pagamento_id'),
    financeiroParcelas: jsonb('financeiro_parcelas'),
    contaFinanceiraId: uuid('conta_financeira_id'),
  },
  (t) => [
    primaryKey({ name: 'pk_recebimentos', columns: [t.id] }),
    foreignKey({ name: 'fk_recebimentos_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({ name: 'fk_recebimentos_estoque_id', columns: [t.estoqueId], foreignColumns: [estoques.id] }),
    foreignKey({
      name: 'fk_recebimentos_tipo_estoque_id',
      columns: [t.tipoEstoqueId],
      foreignColumns: [tiposEstoque.id],
    }),
    foreignKey({
      name: 'fk_recebimentos_fornecedor_id',
      columns: [t.fornecedorId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({
      name: 'fk_recebimentos_movimentado_por_id',
      columns: [t.movimentadoPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_recebimentos_estornado_por_id',
      columns: [t.estornadoPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_recebimentos_financeiro_plano_contas_id',
      columns: [t.financeiroPlanoContasId],
      foreignColumns: [planosContas.id],
    }),
    foreignKey({
      name: 'fk_recebimentos_financeiro_forma_pagamento_id',
      columns: [t.financeiroFormaPagamentoId],
      foreignColumns: [formasPagamento.id],
    }),
    uniqueIndex('uq_recebimentos_codigo').on(t.codigo),
    index('ix_recebimentos_fornecedor_id_data_recebimento').on(t.fornecedorId, t.dataRecebimento),
    // Aviso de remessa repetida (mesmo fornecedor) e o filtro "Cód. remessa" da listagem.
    index('ix_recebimentos_codigo_remessa').on(t.codigoRemessa),
    index('ix_recebimentos_estoque_id_data_recebimento').on(t.estoqueId, t.dataRecebimento),
    index('ix_recebimentos_loja_id').on(t.lojaId),
    index('ix_recebimentos_tipo_estoque_id').on(t.tipoEstoqueId),
    index('ix_recebimentos_movimentado_por_id').on(t.movimentadoPorId),
    index('ix_recebimentos_estornado_por_id').on(t.estornadoPorId),
    index('ix_recebimentos_financeiro_plano_contas_id').on(t.financeiroPlanoContasId),
    index('ix_recebimentos_financeiro_forma_pagamento_id').on(t.financeiroFormaPagamentoId),
    check('ck_recebimentos_status', sql`status in (${listaSql(STATUS_RECEBIMENTO)})`),
    check(
      'ck_recebimentos_movimentacao',
      sql`(status = 'rascunho') = (movimentado_em is null) and (status = 'estornado') = (estornado_em is not null)`,
    ),
    check(
      'ck_recebimentos_valores',
      sql`valor_produtos >= 0 and valor_frete >= 0 and valor_desconto >= 0 and valor_outras_despesas >= 0 and valor_total >= 0`,
    ),
    check('ck_recebimentos_financeiro', sql`not gerar_financeiro or financeiro_plano_contas_id is not null`),
  ],
);

/**
 * Itens do recebimento; só editáveis com o recebimento em `rascunho` (trigger na migração customizada). A quantidade
 * vem na unidade de compra (a embalagem, ex.: FD × 12) e `quantidade_estoque` = quantidade × fator, na unidade do
 * produto. Os rateios, o custo final e o `lote_id` (o lote criado em `produtos_lotes`) são gravados ao movimentar
 * (F2-B15); no rascunho ficam em 0/nulo.
 */
export const itensRecebimento = pgTable(
  'itens_recebimento',
  {
    ...colunasPadrao(),
    recebimentoId: uuid('recebimento_id').notNull(),
    sequencia: integer('sequencia').notNull(),
    produtoId: uuid('produto_id').notNull(),
    /** Sempre nula na Fase 2 (variações travadas, D43); a coluna fica pronta para o F2-B49. */
    variacaoId: uuid('variacao_id'),
    /** Embalagem usada (`produtos_codigos_barras`, o EAN de compra); preenche a unidade e o fator. */
    codigoBarrasId: uuid('codigo_barras_id'),
    unidadeCompra: varchar('unidade_compra', { length: 6 }),
    fator: quantidade('fator').notNull().default('1'),
    quantidade: quantidade('quantidade').notNull(),
    quantidadeEstoque: quantidade('quantidade_estoque').notNull(),
    /** Preço de compra por unidade da embalagem. */
    precoCompra: preco('preco_compra').notNull(),
    markupPct: numeric('markup_pct', { precision: 9, scale: 4 }),
    /** Preço de venda proposto (aplicado ao movimentar conforme `atualizar_preco`, F2-B15). */
    precoVenda: preco('preco_venda'),
    atualizarPreco: varchar('atualizar_preco', { length: 6 }).notNull().default('nao'),
    lote: varchar('lote', { length: 30 }),
    validade: date('validade'),
    fabricacao: date('fabricacao'),
    loteId: uuid('lote_id'),
    rateioFrete: dinheiro('rateio_frete').notNull().default('0'),
    rateioDesconto: dinheiro('rateio_desconto').notNull().default('0'),
    rateioOutras: dinheiro('rateio_outras').notNull().default('0'),
    /** `(preco_compra × quantidade + frete + outras − desconto) / quantidade_estoque`, a 4 casas (F2-B15). */
    custoUnitarioFinal: preco('custo_unitario_final').notNull().default('0'),
    /** quantidade × preço de compra. */
    valorTotal: dinheiro('valor_total').notNull().default('0'),
  },
  (t) => [
    primaryKey({ name: 'pk_itens_recebimento', columns: [t.id] }),
    foreignKey({
      name: 'fk_itens_recebimento_recebimento_id',
      columns: [t.recebimentoId],
      foreignColumns: [recebimentos.id],
    }),
    foreignKey({
      name: 'fk_itens_recebimento_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_itens_recebimento_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_itens_recebimento_codigo_barras_id',
      columns: [t.codigoBarrasId],
      foreignColumns: [produtosCodigosBarras.id],
    }),
    foreignKey({
      name: 'fk_itens_recebimento_lote_id',
      columns: [t.loteId],
      foreignColumns: [produtosLotes.id],
    }),
    uniqueIndex('uq_itens_recebimento_sequencia').on(t.recebimentoId, t.sequencia),
    index('ix_itens_recebimento_produto_id').on(t.produtoId),
    index('ix_itens_recebimento_variacao_id').on(t.variacaoId),
    index('ix_itens_recebimento_codigo_barras_id').on(t.codigoBarrasId),
    index('ix_itens_recebimento_lote_id').on(t.loteId),
    check(
      'ck_itens_recebimento_valores',
      sql`quantidade > 0 and fator > 0 and quantidade_estoque > 0 and preco_compra >= 0 and (preco_venda is null or preco_venda >= 0)`,
    ),
    check(
      'ck_itens_recebimento_rateios',
      sql`rateio_frete >= 0 and rateio_desconto >= 0 and rateio_outras >= 0 and custo_unitario_final >= 0 and valor_total >= 0`,
    ),
    check(
      'ck_itens_recebimento_atualizar_preco',
      sql`atualizar_preco in (${listaSql(ATUALIZAR_PRECO_RECEBIMENTO)})`,
    ),
    check(
      'ck_itens_recebimento_validade',
      sql`fabricacao is null or validade is null or fabricacao <= validade`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// NF-e de fornecedor por XML (MD 3.8.2; ERP 13.4; Fase 2, F2-B18). Sem SEFAZ (restrição do dono): a origem é só o
// upload, `dfe_documento_id` fica nulo e sem FK até a Distribuição DF-e existir, e o CFOP de entrada (`cfop_entrada`)
// fica nulo e reservado para a conversão de CFOP da 3F/4.

/**
 * Situação da nota (ERP 13.4): pendente de vinculação → pronta (todos os itens vinculados ou ignorados, F2-B20) →
 * movimentada (F2-B21) → estornada; pendente → ignorada (com motivo) → pendente ("Reabrir", F2-B19).
 */
export const STATUS_NOTA_ENTRADA = ['pendente', 'pronta', 'movimentada', 'estornada', 'ignorada'] as const;
/** Só `upload` na Fase 2; `sefaz` entra com a Distribuição DF-e (fora da Fase 2). */
export const ORIGENS_NOTA_ENTRADA = ['upload'] as const;
/**
 * Resultado da conferência da assinatura XMLDSig na importação (F2-Q9 = D50): válida, inválida (o XML mudou depois de
 * assinado, ou o resumo não confere com o do protocolo), ausente ou não conferida (`notas_entrada.assinatura_invalida
 * = 'nao_conferir'`). Com `'avisar'` (padrão), a nota inválida ou sem assinatura entra com o aviso e quem importou
 * (com `notas_entrada.importar`) fica em `criado_por_id`.
 */
export const SITUACOES_ASSINATURA_NOTA_ENTRADA = ['valida', 'invalida', 'ausente', 'nao_conferida'] as const;

/**
 * D: NF-e de compra importada do XML do fornecedor (`nfeProc` autorizado, modelo 55). O cabeçalho guarda a cópia do
 * XML (emitente, totais, transporte, protocolo) e o destino escolhido (loja, estoque e tipo de estoque, entre os
 * permitidos: a nota pode vir com o CNPJ do CD ou de qualquer loja, F2-Q3 = D6). O XML original fica em `arquivos`
 * (`xml_arquivo_id`, categoria `xml_nfe_entrada`). As colunas `financeiro_*` e `conta_financeira_id` ficam gravadas e
 * sem uso até a Fase 4; as duplicatas do XML ficam em `notas_entrada_duplicatas`.
 */
export const notasEntrada = pgTable(
  'notas_entrada',
  {
    ...colunasPadrao(),
    ...colunasAutoria(),
    codigo: integer('codigo')
      .notNull()
      .default(sql`nextval('seq_codigo_notas_entrada')`),
    /** Loja destinatária (padrão: a do CNPJ do destinatário; pode ser trocada entre as permitidas, F2-B19). */
    lojaId: uuid('loja_id').notNull(),
    /** Estoque de destino (padrão: o vinculado à loja; o CD também serve). */
    estoqueId: uuid('estoque_id').notNull(),
    /** Tipo de estoque que recebe as mercadorias (padrão: o tipo padrão, Disponível). */
    tipoEstoqueId: uuid('tipo_estoque_id').notNull(),
    /** Fornecedor achado ou criado pelo CNPJ/CPF do emitente (F2-B13, F2-B19). */
    fornecedorId: uuid('fornecedor_id').notNull(),
    origem: varchar('origem', { length: 10 }).notNull().default('upload'),
    /** → `dfe_documentos` quando a Distribuição DF-e existir (fora da Fase 2): nulo e sem FK. */
    dfeDocumentoId: uuid('dfe_documento_id'),
    chave: varchar('chave', { length: 44 }).notNull(),
    modelo: smallint('modelo').notNull().default(55),
    serie: integer('serie').notNull(),
    numero: integer('numero').notNull(),
    /** dhEmi. */
    dataEmissao: timestamptz('data_emissao').notNull(),
    /** Importação ("Data Recebimento"). */
    dataRecebimento: timestamptz('data_recebimento').notNull().defaultNow(),
    /** "Data Movimentação" (F2-B21). */
    dataMovimentacao: timestamptz('data_movimentacao'),
    naturezaOperacao: varchar('natureza_operacao', { length: 60 }),
    /** CNPJ (14, alfanumérico) ou CPF (11, produtor rural) do emitente. */
    emitenteCnpj: varchar('emitente_cnpj', { length: 14 }).notNull(),
    emitenteNome: varchar('emitente_nome', { length: 60 }).notNull(),
    emitenteFantasia: varchar('emitente_fantasia', { length: 60 }),
    emitenteIe: varchar('emitente_ie', { length: 14 }),
    emitenteUf: char('emitente_uf', { length: 2 }).notNull(),
    /** CNPJ do destinatário no XML (o de uma loja da empresa, inclusive depósito; a `loja_id` pode mudar depois). */
    destinatarioCnpj: varchar('destinatario_cnpj', { length: 14 }).notNull(),
    // Totais do XML (ICMSTot), só gravados: nenhum uso fiscal na Fase 2 (livros, SPED, créditos).
    valorProdutos: dinheiro('valor_produtos').notNull().default('0'),
    valorFrete: dinheiro('valor_frete').notNull().default('0'),
    valorSeguro: dinheiro('valor_seguro').notNull().default('0'),
    valorDesconto: dinheiro('valor_desconto').notNull().default('0'),
    valorOutras: dinheiro('valor_outras').notNull().default('0'),
    valorIpi: dinheiro('valor_ipi').notNull().default('0'),
    valorIpiDevolvido: dinheiro('valor_ipi_devolvido').notNull().default('0'),
    valorIi: dinheiro('valor_ii').notNull().default('0'),
    valorIcms: dinheiro('valor_icms').notNull().default('0'),
    valorIcmsDesonerado: dinheiro('valor_icms_desonerado').notNull().default('0'),
    valorIcmsSt: dinheiro('valor_icms_st').notNull().default('0'),
    valorFcpSt: dinheiro('valor_fcp_st').notNull().default('0'),
    /** vNF. */
    valorTotal: dinheiro('valor_total').notNull().default('0'),
    transportadoraCnpj: varchar('transportadora_cnpj', { length: 14 }),
    transportadoraNome: varchar('transportadora_nome', { length: 60 }),
    /** modFrete (0–4, 9). */
    modalidadeFrete: char('modalidade_frete', { length: 1 }),
    /** `[{ quantidade, especie, marca, numeracao, pesoLiquido, pesoBruto }]` (vol). */
    volumes: jsonb('volumes'),
    /** infCpl. */
    informacoesComplementares: text('informacoes_complementares'),
    /** nProt do protocolo de autorização (protNFe). */
    protocoloNumero: varchar('protocolo_numero', { length: 17 }).notNull(),
    /** dhRecbto do protocolo. */
    protocoloData: timestamptz('protocolo_data').notNull(),
    /** cStat do protocolo: 100 (autorizado) ou 150 (autorizado fora de prazo). */
    protocoloStatus: smallint('protocolo_status').notNull(),
    assinatura: varchar('assinatura', { length: 13 }).notNull(),
    /** O motivo, quando a assinatura não é válida (exibido como aviso na nota). */
    assinaturaDetalhe: varchar('assinatura_detalhe', { length: 255 }),
    status: varchar('status', { length: 14 }).notNull().default('pendente'),
    motivoIgnorada: varchar('motivo_ignorada', { length: 255 }),
    movimentadaPorId: uuid('movimentada_por_id'),
    estornadaEm: timestamptz('estornada_em'),
    estornadaPorId: uuid('estornada_por_id'),
    motivoEstorno: varchar('motivo_estorno', { length: 255 }),
    gerarFinanceiro: boolean('gerar_financeiro').notNull().default(false),
    financeiroPlanoContasId: uuid('financeiro_plano_contas_id'),
    contaFinanceiraId: uuid('conta_financeira_id'),
    xmlArquivoId: uuid('xml_arquivo_id').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_notas_entrada', columns: [t.id] }),
    foreignKey({ name: 'fk_notas_entrada_loja_id', columns: [t.lojaId], foreignColumns: [lojas.id] }),
    foreignKey({
      name: 'fk_notas_entrada_estoque_id',
      columns: [t.estoqueId],
      foreignColumns: [estoques.id],
    }),
    foreignKey({
      name: 'fk_notas_entrada_tipo_estoque_id',
      columns: [t.tipoEstoqueId],
      foreignColumns: [tiposEstoque.id],
    }),
    foreignKey({
      name: 'fk_notas_entrada_fornecedor_id',
      columns: [t.fornecedorId],
      foreignColumns: [pessoas.id],
    }),
    foreignKey({
      name: 'fk_notas_entrada_movimentada_por_id',
      columns: [t.movimentadaPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_notas_entrada_estornada_por_id',
      columns: [t.estornadaPorId],
      foreignColumns: [usuarios.id],
    }),
    foreignKey({
      name: 'fk_notas_entrada_financeiro_plano_contas_id',
      columns: [t.financeiroPlanoContasId],
      foreignColumns: [planosContas.id],
    }),
    foreignKey({
      name: 'fk_notas_entrada_xml_arquivo_id',
      columns: [t.xmlArquivoId],
      foreignColumns: [arquivos.id],
    }),
    uniqueIndex('uq_notas_entrada_codigo').on(t.codigo),
    // A mesma chave só uma vez, inclusive a ignorada (para importá-la de novo, "Reabrir"; MD 3.8.2).
    uniqueIndex('uq_notas_entrada_chave')
      .on(t.chave)
      .where(sql`excluido_em is null`),
    index('ix_notas_entrada_loja_id_data_emissao').on(t.lojaId, t.dataEmissao),
    index('ix_notas_entrada_fornecedor_id_data_emissao').on(t.fornecedorId, t.dataEmissao),
    index('ix_notas_entrada_status_data_recebimento').on(t.status, t.dataRecebimento),
    index('ix_notas_entrada_estoque_id').on(t.estoqueId),
    index('ix_notas_entrada_tipo_estoque_id').on(t.tipoEstoqueId),
    index('ix_notas_entrada_movimentada_por_id').on(t.movimentadaPorId),
    index('ix_notas_entrada_estornada_por_id').on(t.estornadaPorId),
    index('ix_notas_entrada_financeiro_plano_contas_id').on(t.financeiroPlanoContasId),
    index('ix_notas_entrada_xml_arquivo_id').on(t.xmlArquivoId),
    // CNPJ alfanumérico do emitente nas posições 7–18 (MD 1.2); o DV é conferido na importação.
    check('ck_notas_entrada_chave', sql`chave ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'`),
    // Produtor rural emite com CPF.
    check('ck_notas_entrada_emitente_cnpj', sql`emitente_cnpj ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'`),
    check('ck_notas_entrada_destinatario_cnpj', sql`destinatario_cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'`),
    check('ck_notas_entrada_modelo', sql`modelo = 55`),
    check('ck_notas_entrada_origem', sql`origem in (${listaSql(ORIGENS_NOTA_ENTRADA)})`),
    check('ck_notas_entrada_status', sql`status in (${listaSql(STATUS_NOTA_ENTRADA)})`),
    check('ck_notas_entrada_assinatura', sql`assinatura in (${listaSql(SITUACOES_ASSINATURA_NOTA_ENTRADA)})`),
    check('ck_notas_entrada_protocolo_status', sql`protocolo_status in (100, 150)`),
    check('ck_notas_entrada_ignorada', sql`status <> 'ignorada' or motivo_ignorada is not null`),
    check(
      'ck_notas_entrada_movimentacao',
      sql`(status in ('movimentada','estornada')) = (data_movimentacao is not null) and (status = 'estornada') = (estornada_em is not null)`,
    ),
    check(
      'ck_notas_entrada_valores',
      sql`valor_produtos >= 0 and valor_frete >= 0 and valor_seguro >= 0 and valor_desconto >= 0 and valor_outras >= 0 and valor_ipi >= 0 and valor_ipi_devolvido >= 0 and valor_ii >= 0 and valor_icms >= 0 and valor_icms_desonerado >= 0 and valor_icms_st >= 0 and valor_fcp_st >= 0 and valor_total >= 0`,
    ),
    check('ck_notas_entrada_financeiro', sql`not gerar_financeiro or financeiro_plano_contas_id is not null`),
  ],
);

/**
 * Itens da NF-e (um por `det`): o que veio do XML (código e descrição do fornecedor, EANs, NCM, CEST, **CFOP do
 * XML**, quantidades e valores com as casas do XML, impostos só gravados, o grupo `rastro`) nunca muda; a vinculação
 * (produto, variação, embalagem, fator, quantidade no estoque, custo calculado, lote, preço proposto, "Ignorar item")
 * é preenchida no F2-B20 e só muda com a nota pendente ou pronta.
 */
export const itensNotaEntrada = pgTable(
  'itens_nota_entrada',
  {
    ...colunasPadrao(),
    notaEntradaId: uuid('nota_entrada_id').notNull(),
    /** nItem (1–990). */
    numeroItem: smallint('numero_item').notNull(),
    /** cProd. */
    codigoFornecedor: varchar('codigo_fornecedor', { length: 60 }).notNull(),
    /** xProd. */
    descricao: varchar('descricao', { length: 120 }).notNull(),
    /** cEAN e cEANTrib; "SEM GTIN" vira nulo. */
    ean: varchar('ean', { length: 14 }),
    eanTributavel: varchar('ean_tributavel', { length: 14 }),
    ncm: varchar('ncm', { length: 8 }),
    cest: varchar('cest', { length: 7 }),
    /** CFOP do XML (do emitente), só gravado. */
    cfop: varchar('cfop', { length: 4 }).notNull(),
    /** CFOP de entrada: nulo e reservado para a conversão de CFOP (3F/4); a nota não depende dele para ficar pronta. */
    cfopEntrada: varchar('cfop_entrada', { length: 4 }),
    /** uCom, qCom (4 casas) e vUnCom (10 casas). */
    unidadeComercial: varchar('unidade_comercial', { length: 6 }).notNull(),
    quantidadeComercial: numeric('quantidade_comercial', { precision: 15, scale: 4 }).notNull(),
    valorUnitarioComercial: numeric('valor_unitario_comercial', { precision: 21, scale: 10 }).notNull(),
    /** uTrib, qTrib e vUnTrib (sugerem o fator por qTrib/qCom, F2-B20). */
    unidadeTributavel: varchar('unidade_tributavel', { length: 6 }),
    quantidadeTributavel: numeric('quantidade_tributavel', { precision: 15, scale: 4 }),
    valorUnitarioTributavel: numeric('valor_unitario_tributavel', { precision: 21, scale: 10 }),
    valorProduto: dinheiro('valor_produto').notNull().default('0'),
    valorFrete: dinheiro('valor_frete').notNull().default('0'),
    valorSeguro: dinheiro('valor_seguro').notNull().default('0'),
    valorDesconto: dinheiro('valor_desconto').notNull().default('0'),
    valorOutros: dinheiro('valor_outros').notNull().default('0'),
    valorIpi: dinheiro('valor_ipi').notNull().default('0'),
    valorIcmsSt: dinheiro('valor_icms_st').notNull().default('0'),
    valorFcpSt: dinheiro('valor_fcp_st').notNull().default('0'),
    // Impostos só gravados (sem uso fiscal na Fase 2; `estoque.custo_abate_creditos` continua desligada).
    icmsSituacao: varchar('icms_situacao', { length: 3 }),
    icmsOrigem: char('icms_origem', { length: 1 }),
    icmsBase: dinheiro('icms_base'),
    icmsAliquota: numeric('icms_aliquota', { precision: 7, scale: 4 }),
    icmsValor: dinheiro('icms_valor'),
    pisValor: dinheiro('pis_valor'),
    cofinsValor: dinheiro('cofins_valor'),
    /** infAdProd. */
    informacoesAdicionais: varchar('informacoes_adicionais', { length: 500 }),
    /**
     * Grupo `rastro` inteiro (`[{ lote, quantidade, fabricacao, validade, codigoAgregacao }]`, até 500 no layout). As
     * colunas `lote`/`validade`/`fabricacao` abaixo vêm do primeiro e são editáveis.
     */
    rastro: jsonb('rastro'),
    produtoId: uuid('produto_id'),
    /** Sempre nula na Fase 2 (variações travadas, D43). */
    variacaoId: uuid('variacao_id'),
    /** Embalagem vinculada (`produtos_codigos_barras`), que sugere o fator. */
    codigoBarrasId: uuid('codigo_barras_id'),
    /** uCom → unidade do produto (ex.: CX → 24). */
    fator: quantidade('fator').notNull().default('1'),
    /** qCom × fator. */
    quantidadeEstoque: quantidade('quantidade_estoque'),
    /** Composição de custo da NF-e (F2-B21). */
    custoUnitario: preco('custo_unitario'),
    lote: varchar('lote', { length: 30 }),
    validade: date('validade'),
    fabricacao: date('fabricacao'),
    loteId: uuid('lote_id'),
    markupPct: numeric('markup_pct', { precision: 9, scale: 4 }),
    precoVenda: preco('preco_venda'),
    atualizarPreco: varchar('atualizar_preco', { length: 6 }).notNull().default('nao'),
    ignorado: boolean('ignorado').notNull().default(false),
    motivoIgnorado: varchar('motivo_ignorado', { length: 255 }),
  },
  (t) => [
    primaryKey({ name: 'pk_itens_nota_entrada', columns: [t.id] }),
    foreignKey({
      name: 'fk_itens_nota_entrada_nota_entrada_id',
      columns: [t.notaEntradaId],
      foreignColumns: [notasEntrada.id],
    }),
    foreignKey({
      name: 'fk_itens_nota_entrada_produto_id',
      columns: [t.produtoId],
      foreignColumns: [produtos.id],
    }),
    foreignKey({
      name: 'fk_itens_nota_entrada_variacao_id',
      columns: [t.variacaoId],
      foreignColumns: [produtosVariacoes.id],
    }),
    foreignKey({
      name: 'fk_itens_nota_entrada_codigo_barras_id',
      columns: [t.codigoBarrasId],
      foreignColumns: [produtosCodigosBarras.id],
    }),
    foreignKey({
      name: 'fk_itens_nota_entrada_lote_id',
      columns: [t.loteId],
      foreignColumns: [produtosLotes.id],
    }),
    uniqueIndex('uq_itens_nota_entrada_numero_item').on(t.notaEntradaId, t.numeroItem),
    index('ix_itens_nota_entrada_produto_id').on(t.produtoId),
    index('ix_itens_nota_entrada_variacao_id').on(t.variacaoId),
    index('ix_itens_nota_entrada_codigo_barras_id').on(t.codigoBarrasId),
    index('ix_itens_nota_entrada_lote_id').on(t.loteId),
    check('ck_itens_nota_entrada_numero_item', sql`numero_item between 1 and 990`),
    check('ck_itens_nota_entrada_fator', sql`fator > 0`),
    check('ck_itens_nota_entrada_ignorado', sql`not ignorado or motivo_ignorado is not null`),
    check(
      'ck_itens_nota_entrada_valores',
      sql`quantidade_comercial >= 0 and valor_unitario_comercial >= 0 and (quantidade_tributavel is null or quantidade_tributavel >= 0) and (valor_unitario_tributavel is null or valor_unitario_tributavel >= 0) and valor_produto >= 0 and valor_frete >= 0 and valor_seguro >= 0 and valor_desconto >= 0 and valor_outros >= 0 and valor_ipi >= 0 and valor_icms_st >= 0 and valor_fcp_st >= 0`,
    ),
    check(
      'ck_itens_nota_entrada_vinculo',
      sql`(quantidade_estoque is null or quantidade_estoque > 0) and (custo_unitario is null or custo_unitario >= 0) and (preco_venda is null or preco_venda >= 0)`,
    ),
    check(
      'ck_itens_nota_entrada_atualizar_preco',
      sql`atualizar_preco in (${listaSql(ATUALIZAR_PRECO_RECEBIMENTO)})`,
    ),
    check(
      'ck_itens_nota_entrada_validade',
      sql`fabricacao is null or validade is null or fabricacao <= validade`,
    ),
  ],
);

/**
 * Duplicatas da NF-e (`cobr/dup`), na ordem do XML, guardadas para as contas a pagar da Fase 4. No layout 4.00 só o
 * valor é obrigatório (nDup e dVenc são opcionais), por isso a chave é a `sequencia`.
 */
export const notasEntradaDuplicatas = pgTable(
  'notas_entrada_duplicatas',
  {
    ...colunasPadrao(),
    notaEntradaId: uuid('nota_entrada_id').notNull(),
    sequencia: smallint('sequencia').notNull(),
    /** nDup. */
    numero: varchar('numero', { length: 60 }),
    /** dVenc. */
    vencimento: date('vencimento'),
    /** vDup. */
    valor: dinheiro('valor').notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_notas_entrada_duplicatas', columns: [t.id] }),
    foreignKey({
      name: 'fk_notas_entrada_duplicatas_nota_entrada_id',
      columns: [t.notaEntradaId],
      foreignColumns: [notasEntrada.id],
    }),
    uniqueIndex('uq_notas_entrada_duplicatas_sequencia').on(t.notaEntradaId, t.sequencia),
    check('ck_notas_entrada_duplicatas_valor', sql`valor >= 0`),
  ],
);
