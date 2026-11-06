/**
 * Handler do `venda.cancelada` (SYNC 9.9, 10.4; bloco C7 da 1C). As duas formas são o mesmo tipo e a mesma versão (a
 * forma vem da chave, `formaVendaCancelada`):
 * - **forma B** (venda em andamento cancelada, PDV 13.2): o documento completo com `status = 'cancelada'`, conferido e
 *   gravado pelas mesmas funções do `venda.finalizada` (`handlers/vendas.ts`), **sem** estoque, custo nem financeiro;
 *   `numeracoes` avança (é por ela que os números reservados e não finalizados aparecem no ERP). Reenvio igual →
 *   `ja_existia`; a mesma venda já gravada com outro conteúdo (finalizada, por exemplo) → `AGREGADO_DIVERGENTE`;
 * - **forma A** (venda finalizada cancelada na sessão aberta, PDV 13.3): as colunas de cancelamento da venda,
 *   `pagamentos_venda.status = 'estornado'`, os `estorno_venda` da sessão do cancelamento, as transações TEF de
 *   cancelamento e o estorno do estoque. Cada saída da venda (`VENDA_PDV` e o `VASILHAME_VENDIDO` do casco cobrado →
 *   `CANC_VENDA_PDV`; `BAIXA_INSUMO` → `ESTORNO_BAIXA_INSUMO`) volta com `estorno_de_id`, a mesma quantidade com sinal
 *   oposto, ao **custo da saída original** (motor do C6a, T20) e `data_movimento = cancelada_em`, no mesmo estoque,
 *   tipo, lote e item. Os vazios trazidos (`VASILHAME_DEVOLVIDO` do bloco `vasilhames`) voltam ao cliente com a
 *   venda (`ESTORNO_VASILHAME_DEVOLVIDO`, saída do `vasilhame_vazio` ao custo médio da linha) quando a loja tem
 *   `pdv.cancelamento_devolve_vazios` (ligada por padrão, decisão do dono D29; desligada, os vazios ficam na
 *   loja, a T24 original). O estorno anterior à contagem de um "Definir" ganha a compensação (15.3), como a venda.
 *
 * Regras da forma A (SYNC 9.9, 10.4; dono, O6 e O22):
 * - a venda tem de existir na nuvem e ser deste terminal (nunca recebida → `TRANSICAO_INVALIDA`; o `venda.finalizada`
 *   em `erro`/`retido` já reteve o evento pela dependência do agregado `venda`; de outro terminal → `ESCOPO_INVALIDO`);
 *   cada pagamento citado é da venda, uma vez só, e o `estorno` combina com o pagamento gravado (`estornosInvalidos`:
 *   `dinheiro_devolvido` só na forma dinheiro, `devolvido_em_dinheiro` fora dela e com um `estorno_venda` na forma
 *   Dinheiro, `tef_*` com a transação TEF, `pos_*` em cartão e `pix_*` em PIX), senão `PAYLOAD_INVALIDO`; a transação
 *   TEF do payload é a de cancelamento (`operacao = 'cancelamento'`);
 * - `tef_cancelado` marca a transação original `cancelada`; `pix_devolvido_api`/`pix_devolucao_manual` marcam a
 *   cobrança `devolvida`; `devolvido_em_dinheiro` não mexe na transação nem na cobrança (a credenciadora/PSP ainda
 *   paga, O22); `tef_estorno_pendente`/`pix_devolucao_pendente` geram o alerta `ESTORNO_PENDENTE`. O financeiro
 *   (parcelas, baixas, consolidação, vale, crédito) é da Fase 4;
 * - venda já cancelada pelo caixa (outro evento do mesmo cancelamento): as mesmas colunas e os mesmos movimentos →
 *   `ja_existia`, sem estornar de novo (a segunda barreira é `uq_movimentos_estoque_estorno`); outro cancelamento →
 *   `AGREGADO_DIVERGENTE`;
 * - venda já cancelada pelo ERP (Fase 3, corrida da 10.4): não repete o estorno lógico (estoque, pagamentos), aplica
 *   o que é físico (o `estorno_venda`, que saiu da gaveta, e as transações TEF de cancelamento) e cria
 *   `CANCELAMENTO_DUPLO` com os dois registros; o cancelamento do caixa fica na auditoria, e é por ela que o segundo
 *   cancelamento do caixa para a mesma venda é conferido como no caminho do caixa (o mesmo → `ja_existia`; outro →
 *   `AGREGADO_DIVERGENTE`, senão a gaveta sairia em dobro).
 */
import {
  dec,
  decTexto,
  formaVendaCancelada,
  payloadVendaCanceladaSchema,
  type EstornoPagamento,
  type PayloadVendaCancelada,
  type PayloadVendaCanceladaEmAndamento,
  type PayloadVendaCanceladaFinalizada,
} from '@genesis/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { lerConfiguracao } from '../../configuracoes/valores.js';
import { compensarDefinir } from '../../estoques/compensacao.js';
import { lancarDocumento, type NovoMovimento } from '../../estoques/movimentos.js';
import {
  cobrancasPix,
  movimentosCaixa,
  pagamentosVenda,
  transacoesTef,
  vendas,
} from '../../database/empresa/schema/index.js';
import type { DbEmpresa } from '../../tenancy/tenancy.js';
import { ErroRegraEvento } from '../erros.js';
import { COLUNAS_CANCELAMENTO, gravarMovimentos, valoresMovimento } from './caixa.js';
import {
  agregadoDivergente,
  colunasDivergentes,
  conferirEscopoLinha,
  registrarAuditoriaPdv,
  type CatalogoHandlers,
  type ContextoHandler,
  type DependenciaEvento,
} from './comum.js';
import {
  avancarNumeracao,
  conferirDocumentoVenda,
  conferirSessaoDoDocumento,
  conferirVendaGravada,
  gravarAlerta,
  gravarLinhasVenda,
  montarLinhas,
  paraColunas,
  pessoasDaVenda,
  renumerarVenda,
  resultadoRenumeracao,
  type DocumentoConferido,
} from './vendas.js';

/** SYNC 10.4: venda cancelada no ERP e, também, no caixa (o que o caixa devolveu fisicamente pode estar em dobro). */
export const ALERTA_CANCELAMENTO_DUPLO = 'CANCELAMENTO_DUPLO';
/** SYNC 10.4: o caixa cancelou a venda, mas o estorno no TEF ou a devolução do PIX ficou pendente. Um por venda. */
export const ALERTA_ESTORNO_PENDENTE = 'ESTORNO_PENDENTE';

/**
 * Movimentos da venda que o cancelamento estorna e o tipo do estorno (SYNC 10.4; MD 7.3). O casco cobrado é item
 * vendido (`VASILHAME_VENDIDO` no lugar do `VENDA_PDV`, 10.2): volta como cancelamento de venda. O
 * `VASILHAME_DEVOLVIDO` dos vazios trazidos é a única entrada: só volta com `pdv.cancelamento_devolve_vazios`
 * (`tiposEstornados`).
 */
export const ESTORNO_DO_MOVIMENTO: Readonly<Record<string, string>> = {
  VENDA_PDV: 'CANC_VENDA_PDV',
  VASILHAME_VENDIDO: 'CANC_VENDA_PDV',
  BAIXA_INSUMO: 'ESTORNO_BAIXA_INSUMO',
  VASILHAME_DEVOLVIDO: 'ESTORNO_VASILHAME_DEVOLVIDO',
};

/**
 * Chave da loja que decide o destino dos vazios trazidos na venda cancelada: ligada (padrão, decisão do dono,
 * D29), o caixa devolve os cascos ao cliente e a entrada dos vazios é estornada; desligada, os vazios ficam na loja.
 * A nuvem lê o valor da loja do terminal na aplicação do evento; o caixa lê a mesma chave na tela (C11b).
 */
export const CHAVE_CANCELAMENTO_DEVOLVE_VAZIOS = 'pdv.cancelamento_devolve_vazios';

/** Os tipos de movimento da venda que o cancelamento estorna (`ESTORNO_DO_MOVIMENTO`, os vazios conforme a chave). */
export function tiposEstornados(devolveVazios: boolean): string[] {
  return Object.keys(ESTORNO_DO_MOVIMENTO).filter((t) => devolveVazios || t !== 'VASILHAME_DEVOLVIDO');
}

/** Estornos que só valem para a forma dinheiro, e o que nunca vale nela (SYNC 9.9; O22 do dono). */
const SO_DINHEIRO: readonly EstornoPagamento[] = ['dinheiro_devolvido'];
const NUNCA_DINHEIRO: readonly EstornoPagamento[] = ['devolvido_em_dinheiro'];
/** Famílias de estorno no meio original: TEF integrado, maquininha (POS) e PIX (SYNC 9.9). */
const ESTORNOS_TEF: readonly EstornoPagamento[] = ['tef_cancelado', 'tef_estorno_pendente'];
const ESTORNOS_POS: readonly EstornoPagamento[] = ['pos_cancelado_na_maquininha'];
const ESTORNOS_PIX: readonly EstornoPagamento[] = [
  'pix_devolvido_api',
  'pix_devolucao_manual',
  'pix_devolucao_pendente',
];
/** Formas passadas na maquininha: os cartões e os vales de alimentação e refeição. */
const FORMAS_CARTAO: readonly string[] = [
  'cartao_credito',
  'cartao_debito',
  'vale_alimentacao',
  'vale_refeicao',
];
const ESTORNOS_PENDENTES: readonly EstornoPagamento[] = ['tef_estorno_pendente', 'pix_devolucao_pendente'];
const PIX_DEVOLVIDO: readonly EstornoPagamento[] = ['pix_devolvido_api', 'pix_devolucao_manual'];

const minusculo = (v: string) => v.toLowerCase();
const minusculoNulo = (v: string | null | undefined) => (v ? v.toLowerCase() : null);
const reais = (v: string) => `R$ ${v.replace('.', ',')}`;

/** O pagamento gravado que o `estorno` precisa conhecer: a forma e, no meio original, a transação TEF. */
export interface PagamentoConferido {
  tipoForma: string;
  tefTransacaoId?: string | null;
}

/** O `estorno` combina com o pagamento gravado (SYNC 9.9; O22 do dono). */
function estornoCombina(estorno: EstornoPagamento, g: PagamentoConferido): boolean {
  if (SO_DINHEIRO.includes(estorno)) return g.tipoForma === 'dinheiro';
  if (NUNCA_DINHEIRO.includes(estorno)) return g.tipoForma !== 'dinheiro';
  if (ESTORNOS_TEF.includes(estorno)) return Boolean(g.tefTransacaoId);
  if (ESTORNOS_POS.includes(estorno)) return FORMAS_CARTAO.includes(g.tipoForma);
  if (ESTORNOS_PIX.includes(estorno)) return g.tipoForma === 'pix';
  return true;
}

/**
 * Pagamentos citados pelo cancelamento que não são da venda, que aparecem duas vezes, ou cujo `estorno` não combina
 * com o pagamento gravado (SYNC 9.9). `formasDosEstornos` são os `tipo_forma` das formas dos `estorno_venda` do
 * payload: a devolução em dinheiro de um cartão ou PIX sai da gaveta, na forma Dinheiro (D24). Função pura (testada
 * em `cancelamento.spec.ts`).
 */
export function estornosInvalidos(
  citados: PayloadVendaCanceladaFinalizada['pagamentos_venda'],
  gravados: ReadonlyMap<string, PagamentoConferido>,
  formasDosEstornos: ReadonlySet<string>,
): Array<{ pagamento_venda_id: string; estorno: string; motivo: string; tipo_forma?: string }> {
  const invalidos: Array<{
    pagamento_venda_id: string;
    estorno: string;
    motivo: string;
    tipo_forma?: string;
  }> = [];
  const vistos = new Set<string>();
  for (const pg of citados) {
    const id = minusculo(pg.id);
    if (vistos.has(id)) {
      // Dois estornos para o mesmo pagamento (a devolução contada duas vezes): nenhum dos dois vale.
      invalidos.push({
        pagamento_venda_id: pg.id,
        estorno: pg.estorno,
        motivo: 'pagamento citado duas vezes',
      });
      continue;
    }
    vistos.add(id);
    const gravado = gravados.get(id);
    if (!gravado) {
      invalidos.push({ pagamento_venda_id: pg.id, estorno: pg.estorno, motivo: 'pagamento de outra venda' });
      continue;
    }
    if (!estornoCombina(pg.estorno, gravado)) {
      invalidos.push({
        pagamento_venda_id: pg.id,
        estorno: pg.estorno,
        motivo: 'estorno incompatível com a forma',
        tipo_forma: gravado.tipoForma,
      });
      continue;
    }
    if (NUNCA_DINHEIRO.includes(pg.estorno) && !formasDosEstornos.has('dinheiro')) {
      invalidos.push({
        pagamento_venda_id: pg.id,
        estorno: pg.estorno,
        motivo: 'devolvido em dinheiro sem estorno_venda na forma Dinheiro',
        tipo_forma: gravado.tipoForma,
      });
    }
  }
  return invalidos;
}

// ---------------------------------------------------------------- forma A: preparar (antes da trava 7300001)

interface PagamentoGravado {
  id: string;
  tipoForma: string;
  tefTransacaoId: string | null;
  pixCobrancaId: string | null;
}

/** Movimento da venda que o cancelamento estorna (ainda sem estorno): as saídas e, conforme a chave, os vazios. */
export type MovimentoDaVenda = {
  id: string;
  estoque_id: string;
  loja_id: string | null;
  tipo_estoque_id: string;
  produto_id: string;
  variacao_id: string | null;
  lote_id: string | null;
  tipo_movimento: string;
  quantidade: string;
  custo_unitario: string;
  preco_venda: string | null;
  unidade_documento: string | null;
  fator: string;
  pessoa_id: string | null;
  documento_item_id: string | null;
};

interface CancelamentoPreparado {
  forma: 'finalizada';
  pagamentos: Map<string, PagamentoGravado>;
  movimentos: MovimentoDaVenda[];
  /** `pdv.cancelamento_devolve_vazios` da loja do terminal (vai na auditoria). */
  devolveVazios: boolean;
}

interface EmAndamentoPreparado extends DocumentoConferido {
  forma: 'em_andamento';
}

type Preparado = CancelamentoPreparado | EmAndamentoPreparado;

/**
 * Forma A, só lendo: escopo das linhas, a venda (existe, é deste terminal), a sessão do cancelamento, os pagamentos
 * citados contra os gravados e os movimentos da venda que ainda não têm estorno (o movimento de estoque é imutável; o
 * estado da venda é conferido de novo com a linha travada no `aplicar`).
 */
async function prepararFinalizada(
  ctx: ContextoHandler,
  p: PayloadVendaCanceladaFinalizada,
): Promise<CancelamentoPreparado> {
  const { tx, terminal } = ctx;
  const vendaId = minusculo(p.vendas.id);
  for (const m of p.movimentos_caixa) conferirEscopoLinha(m, terminal, 'movimentos_caixa');
  for (const t of p.transacoes_tef) {
    conferirEscopoLinha({ loja_id: t.loja_id, terminal_id: t.terminal_id }, terminal, 'transacoes_tef');
    if (t.venda_id && minusculo(t.venda_id) !== vendaId) {
      throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Linha de transacoes_tef de outra venda.', {
        tabela: 'transacoes_tef',
      });
    }
    // Só a transação do cancelamento: é por `operacao` que a camada 2 do `venda.finalizada` a deixa de fora.
    if (t.operacao !== 'cancelamento') {
      throw new ErroRegraEvento(
        'PAYLOAD_INVALIDO',
        'Transação TEF do cancelamento sem operacao = cancelamento.',
        {
          tabela: 'transacoes_tef',
          id: t.id,
        },
      );
    }
  }
  const [venda] = await tx
    .select({ terminalId: vendas.terminalId })
    .from(vendas)
    .where(eq(vendas.id, vendaId));
  if (!venda) {
    throw new ErroRegraEvento('TRANSICAO_INVALIDA', 'Cancelamento de venda que a nuvem não recebeu.', {
      venda_id: vendaId,
    });
  }
  if (venda.terminalId !== terminal.terminalId) {
    throw new ErroRegraEvento('ESCOPO_INVALIDO', 'Cancelamento de venda de outro terminal.', {
      venda_id: vendaId,
    });
  }
  await conferirSessaoDoDocumento(ctx, p.sessao_caixa_cancelamento_id, 'do cancelamento');
  const gravados = await tx
    .select({
      id: pagamentosVenda.id,
      tipoForma: pagamentosVenda.tipoForma,
      tefTransacaoId: pagamentosVenda.tefTransacaoId,
      pixCobrancaId: pagamentosVenda.pixCobrancaId,
    })
    .from(pagamentosVenda)
    .where(eq(pagamentosVenda.vendaId, vendaId));
  const pagamentos = new Map(gravados.map((g) => [g.id, g]));
  const formas = [
    ...new Set(p.movimentos_caixa.flatMap((m) => (m.forma_pagamento_id ? [m.forma_pagamento_id] : []))),
  ];
  const { rows: tiposDasFormas } = formas.length
    ? await tx.execute<{ tipo_forma: string }>(sql`
        select tipo_forma from formas_pagamento where id = any(${`{${formas.join(',')}}`}::uuid[])`)
    : { rows: [] };
  const invalidos = estornosInvalidos(
    p.pagamentos_venda,
    pagamentos,
    new Set(tiposDasFormas.map((f) => f.tipo_forma)),
  );
  if (invalidos.length) {
    throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Estorno de pagamento incompatível com a venda.', {
      pagamentos: invalidos,
    });
  }
  const devolveVazios =
    (await lerConfiguracao<boolean>(tx, CHAVE_CANCELAMENTO_DEVOLVE_VAZIOS, terminal.lojaId)) === true;
  const { rows: movimentos } = await tx.execute<MovimentoDaVenda>(sql`
    select m.id, m.estoque_id, m.loja_id, m.tipo_estoque_id, m.produto_id, m.variacao_id, m.lote_id, m.tipo_movimento,
           m.quantidade::text, m.custo_unitario::text, m.preco_venda::text, m.unidade_documento, m.fator::text,
           m.pessoa_id, m.documento_item_id
      from movimentos_estoque m
     where m.documento_tipo = 'venda' and m.documento_id = ${vendaId}
       and m.tipo_movimento = any(${`{${tiposEstornados(devolveVazios).join(',')}}`}::text[])
       and m.estorno_de_id is null
       and not exists (select 1 from movimentos_estoque e where e.estorno_de_id = m.id)
     order by m.id`);
  return { forma: 'finalizada', pagamentos, movimentos, devolveVazios };
}

// ---------------------------------------------------------------- forma A: aplicar

/**
 * Os estornos do estoque (SYNC 10.4): cada saída volta ao custo dela, na data do cancelamento; a entrada dos vazios
 * trazidos sai ao custo médio da linha (o motor ignora o custo informado na saída).
 */
export function estornosDaVenda(
  ctx: Pick<ContextoHandler, 'terminal' | 'evento'>,
  p: PayloadVendaCanceladaFinalizada,
  movimentos: readonly MovimentoDaVenda[],
): NovoMovimento[] {
  const c = p.vendas;
  return movimentos.map((m) => ({
    estoqueId: m.estoque_id,
    produtoId: m.produto_id,
    variacaoId: m.variacao_id,
    tipoEstoqueId: m.tipo_estoque_id,
    tipoMovimento: ESTORNO_DO_MOVIMENTO[m.tipo_movimento]!,
    quantidade: decTexto(dec(m.quantidade).neg(), 3),
    // T20: ao custo da saída original (com saldo positivo recalcula a média; com zero ou negativo a mantém).
    custoUnitario: m.custo_unitario,
    custoReferencia: m.custo_unitario,
    precoVenda: m.preco_venda,
    dataMovimento: new Date(c.cancelada_em),
    lojaId: m.loja_id,
    usuarioId: c.cancelada_por_id,
    documentoTipo: 'venda',
    documentoId: c.id,
    documentoItemId: m.documento_item_id,
    unidadeDocumento: m.unidade_documento,
    fator: m.fator,
    loteId: m.lote_id,
    pessoaId: m.pessoa_id,
    terminalId: ctx.terminal.terminalId,
    eventoId: ctx.evento.evento_id,
    estornoDeId: m.id,
  }));
}

/** As colunas de cancelamento como o handler grava (motivo já aparado pelo contrato, ids em minúsculas). */
function colunasCancelamento(p: PayloadVendaCanceladaFinalizada) {
  const c = p.vendas;
  return {
    canceladaEm: new Date(c.cancelada_em),
    canceladaPorId: minusculo(c.cancelada_por_id),
    cancelamentoAutorizadoPorId: minusculoNulo(c.cancelamento_autorizado_por_id),
    motivoCancelamento: c.motivo_cancelamento,
    cancelamentoOrigem: 'pdv',
  };
}

/** Transações TEF do cancelamento (`operacao = 'cancelamento'`, Fase 6): ligadas à venda, idempotentes pelo `id`. */
async function gravarTransacoesTef(tx: DbEmpresa, p: PayloadVendaCanceladaFinalizada): Promise<number> {
  let gravadas = 0;
  for (const t of p.transacoes_tef) {
    const linha = { ...paraColunas(transacoesTef, t), vendaId: minusculo(p.vendas.id) };
    const [gravada] = await tx
      .select()
      .from(transacoesTef)
      .where(eq(transacoesTef.id, minusculo(t.id)));
    if (gravada) {
      const divergentes = colunasDivergentes(gravada, linha, [
        'status',
        'confirmadaEm',
        'desfeitaEm',
        'canceladaEm',
      ]);
      if (divergentes.length) throw agregadoDivergente('transacoes_tef', gravada.id, divergentes);
      continue;
    }
    await tx.insert(transacoesTef).values(linha as typeof transacoesTef.$inferInsert);
    gravadas++;
  }
  return gravadas;
}

/** Os movimentos do caixa do cancelamento que já existe: os mesmos, com o mesmo conteúdo (SYNC 8.4). */
async function conferirEstornosGravados(tx: DbEmpresa, p: PayloadVendaCanceladaFinalizada): Promise<void> {
  for (const m of p.movimentos_caixa) {
    const [gravado] = await tx
      .select()
      .from(movimentosCaixa)
      .where(eq(movimentosCaixa.id, minusculo(m.id)));
    const divergentes = gravado
      ? colunasDivergentes(gravado, valoresMovimento(m), COLUNAS_CANCELAMENTO)
      : ['id'];
    if (divergentes.length) throw agregadoDivergente('movimentos_caixa', m.id, divergentes);
  }
}

/** O que o caixa fez, para a auditoria e o `CANCELAMENTO_DUPLO`: quem, quando, o motivo e o que saiu fisicamente. */
function registroDoCaixa(p: PayloadVendaCanceladaFinalizada) {
  const c = p.vendas;
  return {
    cancelada_em: c.cancelada_em,
    cancelada_por_id: c.cancelada_por_id,
    cancelamento_autorizado_por_id: c.cancelamento_autorizado_por_id ?? null,
    motivo_cancelamento: c.motivo_cancelamento,
    sessao_caixa_cancelamento_id: p.sessao_caixa_cancelamento_id,
    estornos: p.pagamentos_venda.map((pg) => ({ pagamento_venda_id: pg.id, estorno: pg.estorno })),
    movimentos_caixa: p.movimentos_caixa.map((m) => ({
      id: m.id,
      forma_pagamento_id: m.forma_pagamento_id,
      valor: m.valor,
    })),
  };
}

type RegistroDoCaixa = ReturnType<typeof registroDoCaixa>;

/**
 * O cancelamento do caixa já gravado numa corrida com o ERP (a auditoria `cancelar` do caixa com
 * `cancelamento_duplo`), ou nulo. É o único registro dele: as colunas de cancelamento da venda continuam as do ERP.
 */
async function cancelamentoDuploGravado(tx: DbEmpresa, vendaId: string): Promise<RegistroDoCaixa | null> {
  const { rows } = await tx.execute<{ depois: RegistroDoCaixa }>(sql`
    select depois from auditoria
     where entidade = 'vendas' and registro_id = ${vendaId} and acao = 'cancelar' and origem = 'pdv'
       and depois @> '{"cancelamento_duplo": true}'::jsonb
     order by ocorrido_em, id
     limit 1`);
  return rows[0]?.depois ?? null;
}

/**
 * Campos em que dois cancelamentos do caixa diferem (ids em minúsculas, hora pelo instante, estornos e movimentos
 * pelo conjunto): vazio = o mesmo cancelamento gerado de novo. Função pura (testada em `cancelamento.spec.ts`).
 */
export function divergenciasDoCaixa(gravado: RegistroDoCaixa, novo: RegistroDoCaixa): string[] {
  const id = (v: string | null | undefined) => (v ? v.toLowerCase() : null);
  const conjunto = (itens: readonly string[]) => [...itens].sort().join('|');
  const estornos = (r: RegistroDoCaixa) =>
    conjunto(r.estornos.map((e) => `${id(e.pagamento_venda_id)}:${e.estorno}`));
  const movimentos = (r: RegistroDoCaixa) => conjunto(r.movimentos_caixa.map((m) => id(m.id) ?? ''));
  return [
    Date.parse(gravado.cancelada_em) !== Date.parse(novo.cancelada_em) ? 'cancelada_em' : null,
    id(gravado.cancelada_por_id) !== id(novo.cancelada_por_id) ? 'cancelada_por_id' : null,
    id(gravado.cancelamento_autorizado_por_id) !== id(novo.cancelamento_autorizado_por_id)
      ? 'cancelamento_autorizado_por_id'
      : null,
    gravado.motivo_cancelamento !== novo.motivo_cancelamento ? 'motivo_cancelamento' : null,
    id(gravado.sessao_caixa_cancelamento_id) !== id(novo.sessao_caixa_cancelamento_id)
      ? 'sessao_caixa_cancelamento_id'
      : null,
    estornos(gravado) !== estornos(novo) ? 'pagamentos_venda' : null,
    movimentos(gravado) !== movimentos(novo) ? 'movimentos_caixa' : null,
  ].filter((c): c is string => c !== null);
}

async function aplicarFinalizada(
  ctx: ContextoHandler,
  p: PayloadVendaCanceladaFinalizada,
  prep: CancelamentoPreparado,
) {
  const { tx, terminal } = ctx;
  const vendaId = minusculo(p.vendas.id);
  // A linha da venda travada: um cancelamento pelo ERP (Fase 3) espera este, ou este vê o dele.
  const [v] = await tx.select().from(vendas).where(eq(vendas.id, vendaId)).for('update');
  if (!v) throw new Error('Venda conferida no preparar sumiu');
  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  const valores = colunasCancelamento(p);
  if (v.status === 'cancelada' && v.finalizadaEm && v.cancelamentoOrigem === 'pdv') {
    // O mesmo cancelamento de novo (evento gerado outra vez): nada a estornar; outro cancelamento → divergência.
    const divergentes = colunasDivergentes(v, valores);
    if (divergentes.length) throw agregadoDivergente('vendas', vendaId, divergentes);
    await conferirEstornosGravados(tx, p);
    return { venda_id: vendaId, ja_existia: true };
  }
  if (v.status === 'cancelada' && v.finalizadaEm && v.cancelamentoOrigem === 'erp') {
    return aplicarCancelamentoDuplo(ctx, p, v);
  }
  if (v.status !== 'finalizada') {
    throw new ErroRegraEvento('TRANSICAO_INVALIDA', `Venda ${v.numeroExibicao} não está finalizada.`, {
      status: v.status,
      finalizada: v.finalizadaEm !== null,
    });
  }

  const doc = await lancarDocumento(tx, estornosDaVenda(ctx, p, prep.movimentos));
  const compensacoes = await compensarDefinir(tx, doc.movimentos, 'cancelamento de venda');
  await tx
    .update(vendas)
    .set({
      status: 'cancelada',
      ...valores,
      ...(p.vendas.status_fiscal ? { statusFiscal: p.vendas.status_fiscal } : {}),
    })
    .where(eq(vendas.id, vendaId));
  const estornados = p.pagamentos_venda.map((pg) => minusculo(pg.id));
  if (estornados.length) {
    await tx
      .update(pagamentosVenda)
      .set({ status: 'estornado' })
      .where(and(eq(pagamentosVenda.vendaId, vendaId), inArray(pagamentosVenda.id, estornados)));
  }
  const movimentosCaixaGravados = await gravarMovimentos(tx, p.movimentos_caixa);
  await gravarTransacoesTef(tx, p);
  // A transação e a cobrança de origem passam a estornadas só quando o caixa desfez no meio original.
  const porEstorno = (estornos: readonly EstornoPagamento[]) =>
    p.pagamentos_venda
      .filter((pg) => estornos.includes(pg.estorno))
      .map((pg) => prep.pagamentos.get(minusculo(pg.id))!);
  const tefOriginais = porEstorno(['tef_cancelado']).flatMap((g) =>
    g.tefTransacaoId ? [g.tefTransacaoId] : [],
  );
  if (tefOriginais.length) {
    await tx
      .update(transacoesTef)
      .set({ status: 'cancelada', canceladaEm: valores.canceladaEm })
      .where(and(inArray(transacoesTef.id, tefOriginais), ne(transacoesTef.status, 'cancelada')));
  }
  const pixOriginais = porEstorno(PIX_DEVOLVIDO).flatMap((g) => (g.pixCobrancaId ? [g.pixCobrancaId] : []));
  if (pixOriginais.length) {
    await tx
      .update(cobrancasPix)
      .set({
        status: 'devolvida',
        valorDevolvido: sql`${cobrancasPix.valor}`,
        devolvidaEm: valores.canceladaEm,
      })
      .where(and(inArray(cobrancasPix.id, pixOriginais), ne(cobrancasPix.status, 'devolvida')));
  }
  const alertasGerados: string[] = [];
  const pendentes = p.pagamentos_venda.filter((pg) => ESTORNOS_PENDENTES.includes(pg.estorno));
  if (pendentes.length) {
    const novo = await gravarAlerta(tx, {
      tipo: ALERTA_ESTORNO_PENDENTE,
      severidade: 'aviso',
      titulo: `Venda ${v.numeroExibicao} cancelada com estorno pendente`,
      mensagem:
        `O caixa ${caixa} cancelou a venda, mas o estorno no cartão (TEF) ou a devolução do PIX ficou pendente. ` +
        'Confira com a credenciadora ou o banco e conclua a devolução ao cliente.',
      lojaId: terminal.lojaId,
      entidade: 'vendas',
      registroId: vendaId,
      dados: {
        venda_id: vendaId,
        numero_exibicao: v.numeroExibicao,
        pagamentos: pendentes.map((pg) => ({ pagamento_venda_id: pg.id, estorno: pg.estorno })),
      },
      chaveDeduplicacao: `estorno_pendente:${vendaId}`,
    });
    if (novo) alertasGerados.push(ALERTA_ESTORNO_PENDENTE);
  }
  await registrarAuditoriaPdv(ctx, {
    entidade: 'vendas',
    registroId: vendaId,
    acao: 'cancelar',
    localizacao: 'PDV › Gestão de vendas',
    descricao: `Venda ${v.numeroExibicao} de ${reais(v.total)} cancelada no caixa ${caixa}: ${p.vendas.motivo_cancelamento}`,
    usuarioId: p.vendas.cancelada_por_id,
    autorizadoPorId: p.vendas.cancelamento_autorizado_por_id ?? null,
    ocorridoEm: valores.canceladaEm,
    antes: { status: v.status },
    // `estorno` de cada pagamento é só do payload (SYNC 9.9): fica aqui.
    depois: {
      status: 'cancelada',
      ...registroDoCaixa(p),
      devolve_vazios: prep.devolveVazios,
      movimentos_estoque: doc.movimentos.length,
      compensacoes: compensacoes.length,
    },
  });
  return {
    venda_id: vendaId,
    movimentos: doc.movimentos.length,
    movimentos_caixa: movimentosCaixaGravados,
    ...(compensacoes.length ? { compensacoes: compensacoes.length } : {}),
    ...(alertasGerados.length ? { alertas: alertasGerados } : {}),
  };
}

/**
 * SYNC 10.4 "Corrida com o ERP": a venda já foi cancelada no ERP. O estoque e os pagamentos ficam como o ERP deixou;
 * entra o que aconteceu no mundo real (dinheiro que saiu da gaveta, TEF de cancelamento) e o alerta com os dois
 * registros. As colunas de cancelamento da venda continuam as do ERP. O caixa só cancela a venda uma vez: com o
 * cancelamento dele já gravado aqui (auditoria), o mesmo de novo → `ja_existia` e outro → `AGREGADO_DIVERGENTE`, como
 * no caminho do caixa (outro `estorno_venda` seria uma saída de gaveta em dobro, e o alerta deduplicado não acusaria).
 */
async function aplicarCancelamentoDuplo(
  ctx: ContextoHandler,
  p: PayloadVendaCanceladaFinalizada,
  v: typeof vendas.$inferSelect,
) {
  const { tx, terminal } = ctx;
  const vendaId = v.id;
  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  const pdv = registroDoCaixa(p);
  const anterior = await cancelamentoDuploGravado(tx, vendaId);
  if (anterior) {
    const divergentes = divergenciasDoCaixa(anterior, pdv);
    if (divergentes.length) throw agregadoDivergente('vendas', vendaId, divergentes);
    await conferirEstornosGravados(tx, p);
    return { venda_id: vendaId, cancelamento_duplo: true, ja_existia: true };
  }
  const movimentosCaixaGravados = await gravarMovimentos(tx, p.movimentos_caixa);
  await gravarTransacoesTef(tx, p);
  const novo = await gravarAlerta(tx, {
    tipo: ALERTA_CANCELAMENTO_DUPLO,
    severidade: 'aviso',
    titulo: `Venda ${v.numeroExibicao} cancelada no ERP e também no caixa ${caixa}`,
    mensagem:
      'A venda já estava cancelada no ERP quando o cancelamento do caixa chegou. O estoque não foi estornado de novo; ' +
      'o que o caixa devolveu ao cliente foi registrado. Confira se houve devolução em dobro.',
    lojaId: terminal.lojaId,
    entidade: 'vendas',
    registroId: vendaId,
    dados: {
      venda_id: vendaId,
      numero_exibicao: v.numeroExibicao,
      erp: {
        cancelada_em: v.canceladaEm?.toISOString() ?? null,
        cancelada_por_id: v.canceladaPorId,
        motivo_cancelamento: v.motivoCancelamento,
      },
      pdv,
    },
    chaveDeduplicacao: `cancelamento_duplo:${vendaId}`,
  });
  await registrarAuditoriaPdv(ctx, {
    entidade: 'vendas',
    registroId: vendaId,
    acao: 'cancelar',
    localizacao: 'PDV › Gestão de vendas',
    descricao: `Cancelamento do caixa ${caixa} para a venda ${v.numeroExibicao}, já cancelada no ERP: ${p.vendas.motivo_cancelamento}`,
    usuarioId: p.vendas.cancelada_por_id,
    autorizadoPorId: p.vendas.cancelamento_autorizado_por_id ?? null,
    ocorridoEm: new Date(p.vendas.cancelada_em),
    depois: { ...pdv, cancelamento_duplo: true },
  });
  return {
    venda_id: vendaId,
    cancelamento_duplo: true,
    movimentos_caixa: movimentosCaixaGravados,
    ...(novo ? { alertas: [ALERTA_CANCELAMENTO_DUPLO] } : {}),
  };
}

// ---------------------------------------------------------------- forma B

/** Colunas da forma B que a nuvem muda depois: só o relógio do envelope (a venda cancelada em andamento não muda). */
const IGNORAR_VENDA_EM_ANDAMENTO = ['relogioConfiavel'];

async function aplicarEmAndamento(
  ctx: ContextoHandler,
  original: PayloadVendaCanceladaEmAndamento,
  prep: EmAndamentoPreparado,
) {
  const { tx, terminal } = ctx;
  // "Aplicar com novo número" (SYNC 11.4): a venda em andamento também ocupa o número do caixa.
  const renumeracao = ctx.novoNumero ? await renumerarVenda(ctx, original) : null;
  const p = renumeracao?.payload ?? original;
  const v = p.vendas;
  const linhas = montarLinhas(ctx, p, prep);
  const [gravada] = await tx
    .select()
    .from(vendas)
    .where(eq(vendas.id, minusculo(v.id)));
  if (gravada) {
    await conferirVendaGravada(tx, gravada, linhas, {
      venda: IGNORAR_VENDA_EM_ANDAMENTO,
      pagamento: ['contaFinanceiraId'],
    });
    return { venda_id: gravada.id, ja_existia: true };
  }
  // Sem estoque, custo nem financeiro (SYNC 9.9 B, 10.1): o documento como veio, para o relatório de canceladas.
  await gravarLinhasVenda(tx, linhas);
  await avancarNumeracao(ctx, original.vendas.numero);
  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  await registrarAuditoriaPdv(ctx, {
    entidade: 'vendas',
    registroId: v.id,
    acao: 'cancelar',
    localizacao: 'PDV › Venda',
    descricao: `Venda ${v.numero_exibicao} cancelada em andamento no caixa ${caixa}: ${v.motivo_cancelamento}`,
    usuarioId: v.cancelada_por_id ?? v.operador_id,
    autorizadoPorId: v.cancelamento_autorizado_por_id ?? null,
    ocorridoEm: new Date(v.cancelada_em!),
    depois: {
      numero: v.numero,
      total: v.total ?? null,
      itens: p.itens_venda.length,
      motivo_cancelamento: v.motivo_cancelamento,
      liberacoes: p.liberacoes,
      ...resultadoRenumeracao(renumeracao),
    },
  });
  return { venda_id: minusculo(v.id), em_andamento: true, ...resultadoRenumeracao(renumeracao) };
}

// ---------------------------------------------------------------- catálogo

const dependencia = (agregado_tipo: string, agregado_id: string): DependenciaEvento => ({
  agregado_tipo,
  agregado_id,
});

export const HANDLERS_CANCELAMENTO: CatalogoHandlers = {
  'venda.cancelada': {
    1: {
      schema: payloadVendaCanceladaSchema,
      entidades: (p) =>
        formaVendaCancelada(p) === 'finalizada'
          ? (p as PayloadVendaCanceladaFinalizada).movimentos_caixa.map((m) => ({
              tipo: 'movimentos_caixa',
              id: m.id,
            }))
          : [],
      // SYNC 8.5: a forma A depende da venda (o `venda.finalizada` em erro retém o cancelamento) e da sessão do
      // cancelamento; a B, como a venda finalizada, da sessão e das pessoas citadas.
      async dependencias(_ctx, p: PayloadVendaCancelada) {
        if (formaVendaCancelada(p) === 'finalizada') {
          const a = p as PayloadVendaCanceladaFinalizada;
          return [
            dependencia('venda', a.vendas.id),
            dependencia('sessao_caixa', a.sessao_caixa_cancelamento_id),
          ];
        }
        const b = p as PayloadVendaCanceladaEmAndamento;
        return [
          ...(b.vendas.sessao_caixa_id ? [dependencia('sessao_caixa', b.vendas.sessao_caixa_id)] : []),
          ...[...new Set(pessoasDaVenda(b).map(minusculo))].map((id) => dependencia('pessoa', id)),
        ];
      },
      async preparar(ctx, p: PayloadVendaCancelada): Promise<Preparado> {
        if (formaVendaCancelada(p) === 'finalizada') {
          return prepararFinalizada(ctx, p as PayloadVendaCanceladaFinalizada);
        }
        const conferido = await conferirDocumentoVenda(ctx, p as PayloadVendaCanceladaEmAndamento);
        return { forma: 'em_andamento', ...conferido };
      },
      async aplicar(ctx, p: PayloadVendaCancelada, prep: Preparado) {
        return prep.forma === 'finalizada'
          ? aplicarFinalizada(ctx, p as PayloadVendaCanceladaFinalizada, prep)
          : aplicarEmAndamento(ctx, p as PayloadVendaCanceladaEmAndamento, prep);
      },
    },
  },
};
