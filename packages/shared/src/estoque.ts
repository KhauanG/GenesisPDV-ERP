/**
 * Estoque (ERP 13.1, 13.5, 8.2.11; MD 3.7): acerto de estoque Entrada / Saída / Definir / Mudança de tipo (rascunho →
 * efetivado → estornado), consulta de saldos por estoque e as contas puras do razão (custo médio ponderado, diferença do
 * "Definir" descontando os movimentos posteriores à contagem) usadas pela API e pelo ERP.
 */
import { z } from 'zod';
import { decimal, textoObrigatorio, textoOpcional, type MetadadosRegistro } from './campos.js';
import { dec, decNumero, decTexto, type Dec, type Valor } from './decimal.js';
import { paginacaoQuerySchema } from './paginacao.js';
import type { ProdutoOpcao } from './produtos.js';

// ---------------------------------------------------------------- Enums

/**
 * `mudanca_tipo` (Fase 2, F2-B8; ERP 13.1.4, 13.6): leva a quantidade do tipo de estoque do acerto (a origem) para o
 * `tipoEstoqueDestinoId` no mesmo estoque, com o par `MUDANCA_TIPO_ESTOQUE` (sai ao custo médio da origem e entra
 * com esse custo no destino). Ex.: Disponível → Avaria.
 */
export const TIPOS_AJUSTE = ['entrada', 'saida', 'definir', 'mudanca_tipo'] as const;
export type TipoAjuste = (typeof TIPOS_AJUSTE)[number];
export const ROTULOS_TIPO_AJUSTE: Record<TipoAjuste, string> = {
  entrada: 'Entrada',
  saida: 'Saída',
  definir: 'Definir',
  mudanca_tipo: 'Mudar tipo',
};

export const STATUS_ACERTO = ['rascunho', 'efetivado', 'estornado'] as const;
export type StatusAcerto = (typeof STATUS_ACERTO)[number];
export const ROTULOS_STATUS_ACERTO: Record<StatusAcerto, string> = {
  rascunho: 'Rascunho',
  efetivado: 'Efetivado',
  estornado: 'Estornado',
};

/** MD 3.7.5 `acertos_estoque.origem`. */
export const ORIGENS_ACERTO = [
  'manual',
  'cadastro_produto',
  'cadastro_massa',
  'importacao',
  'relatorio_estoque',
  'perda_transferencia',
  'api',
] as const;
export type OrigemAcerto = (typeof ORIGENS_ACERTO)[number];
export const ROTULOS_ORIGEM_ACERTO: Record<OrigemAcerto, string> = {
  manual: 'Acerto de estoque',
  cadastro_produto: 'Cadastro de produtos',
  cadastro_massa: 'Cadastro em massa',
  importacao: 'Importação de planilha',
  relatorio_estoque: 'Relatório Estoque Atual',
  perda_transferencia: 'Perda na transferência',
  api: 'API',
};

/** Sugestões do campo Motivo (ERP 13.5); o texto é livre. */
export const MOTIVOS_ACERTO = [
  'Inventário',
  'Saldo inicial',
  'Avaria',
  'Vencimento',
  'Consumo interno',
  'Furto/perda',
  'Bonificação',
  'Correção de lançamento',
] as const;

/**
 * Tipo de movimento (MD 7.3) gerado pela efetivação: o acerto manual usa `ACERTO_*`; os ajustes de outras telas geram
 * um acerto com a `origem` correspondente e o movimento próprio (ERP 13.1.2/13.1.3). A mudança de tipo é sempre o par
 * `MUDANCA_TIPO_ESTOQUE`, de qualquer origem (o modal do Estoque Atual também a gera, ERP 13.6).
 */
export function tipoMovimentoAcerto(origem: OrigemAcerto, tipo: TipoAjuste): string {
  if (tipo === 'mudanca_tipo') return TIPO_MOVIMENTO_MUDANCA_TIPO;
  switch (origem) {
    case 'cadastro_produto':
    case 'cadastro_massa':
      return 'AJUSTE_CADASTRO';
    case 'relatorio_estoque':
      return 'AJUSTE_RELATORIO';
    case 'importacao':
      return 'AJUSTE_IMPORTACAO';
    case 'api':
      return 'AJUSTE_API';
    default:
      return tipo === 'entrada' ? 'ACERTO_ENTRADA' : tipo === 'saida' ? 'ACERTO_SAIDA' : 'ACERTO_DEFINIR';
  }
}

// ---------------------------------------------------------------- Contas do razão (ERP 13.1.4, 13.1.5)

/** Arredonda para `casas` casas (meio para longe do zero, como o PDV), calculando em decimal (ADR-05). */
export function arredondar(valor: Valor, casas: number): number {
  return decNumero(valor, casas);
}

/**
 * Custo médio ponderado depois de uma entrada (ERP 13.1.4): `cm' = (s × cm + q × c) / (s + q)` com saldo `s > 0`;
 * com saldo zero ou negativo o custo médio passa a ser o custo da entrada. Saídas não mudam o custo médio. Conta em
 * decimal; devolve o texto com 4 casas (`custo_medio numeric(15,4)`).
 */
export function custoMedioAposEntradaTexto(
  saldo: Valor,
  custoMedio: Valor,
  quantidade: Valor,
  custo: Valor,
): string {
  const s = dec(saldo);
  const q = dec(quantidade);
  if (s.lte(0) || s.plus(q).lte(0)) return decTexto(custo, 4);
  return decTexto(
    s
      .times(dec(custoMedio))
      .plus(q.times(dec(custo)))
      .div(s.plus(q)),
    4,
  );
}

/**
 * Custo médio depois da **entrada de estorno** de uma saída (cancelamento de venda, estorno de baixa de insumo ou de
 * acerto de saída; SYNC 10.4, 15.4; Fase 1C, T20). A entrada vai ao custo da saída original e, com saldo positivo
 * antes, recalcula a média como qualquer entrada: é o mesmo que a saída não ter acontecido. Com saldo zero ou negativo
 * a regra da compra (`cm' = c`) **não** vale: o estorno não traz custo novo, só devolve unidades a um custo antigo, e
 * redefinir o custo médio com ele arrastava para trás o custo da última compra de um saldo que segue negativo (caixa
 * offline vendendo sem estoque). Mantém o custo médio vigente; sem custo médio (zero), usa o da saída.
 */
export function custoMedioAposEstornoTexto(
  saldo: Valor,
  custoMedio: Valor,
  quantidade: Valor,
  custoOriginal: Valor,
): string {
  const s = dec(saldo);
  if (s.gt(0)) return custoMedioAposEntradaTexto(saldo, custoMedio, quantidade, custoOriginal);
  return decTexto(dec(custoMedio).gt(0) ? custoMedio : custoOriginal, 4);
}

/**
 * Custo médio depois da **saída ao custo informado** (o estorno da perna de entrada da mudança de tipo, F2-B8; README da
 * API › decisão 153): a conta inversa da média ponderada, `cm' = (s × cm − |q| × c) / (s − |q|)`, que tira da linha o
 * valor que a entrada pôs nela. Sem nada entre a mudança e o estorno, o destino volta ao custo médio de antes; com outro
 * movimento no meio, fica o médio do que sobrou. `null` quando a conta não vale (saldo não positivo antes, nada sobra
 * depois, ou o médio ficaria ≤ 0): aí a saída é a comum, ao custo médio vigente. Texto com 4 casas.
 */
export function custoMedioAposSaidaAoCustoTexto(
  saldo: Valor,
  custoMedio: Valor,
  quantidade: Valor,
  custo: Valor,
): string | null {
  const s = dec(saldo);
  const q = dec(quantidade).abs();
  if (s.lte(0) || s.minus(q).lte(0)) return null;
  const cm = decTexto(
    s
      .times(dec(custoMedio))
      .minus(q.times(dec(custo)))
      .div(s.minus(q)),
    4,
  );
  return dec(cm).gt(0) ? cm : null;
}

/** O tipo de movimento (MD 7.3) do par da mudança de tipo de estoque e do estorno dele (F2-B8). */
export const TIPO_MOVIMENTO_MUDANCA_TIPO = 'MUDANCA_TIPO_ESTOQUE';

/**
 * O estorno da mudança de tipo (F2-B8; README da API › decisão 153): o par invertido, também `MUDANCA_TIPO_ESTOQUE`,
 * com `estorno_de_id`. A perna do destino (−) sai ao custo gravado na entrada original (`saidaAoCusto`) e a da origem
 * (+) entra ao custo que de fato saiu do destino: as duas andam com o mesmo custo unitário, e o valor do estoque a
 * custo não muda, como na efetivação. O motor online e o replay do razão decidem por esta função.
 */
export function estornoDeMudancaTipo(m: { tipoMovimento: string; estornoDeId?: string | null }): boolean {
  return m.tipoMovimento === TIPO_MOVIMENTO_MUDANCA_TIPO && Boolean(m.estornoDeId);
}

/**
 * A saída da perda da transferência (Fase 2, F2-B24; F2-Q10 = D51; README da API › decisão 172): o `ACERTO_SAIDA` do
 * acerto `perda_transferencia` com `estorno_de_id` = o `TRANSF_RETORNO` da diferença que ele baixa (o único
 * `ACERTO_SAIDA` com estorno: o estorno do acerto é `ESTORNO_ACERTO`). Ela desfaz na origem o que o retorno acabou de
 * creditar: sai na linha e no lote dele, sem a divisão FEFO (estorno não se divide), e ao custo dele (`saidaAoCusto`,
 * a conta inversa da média ponderada). O par retorno + perda não muda o saldo, o saldo do lote nem o custo médio da
 * origem, e a perda fica registrada ao custo do envio.
 */
export function saidaDaPerdaTransferencia(m: {
  tipoMovimento: string;
  estornoDeId?: string | null;
}): boolean {
  return m.tipoMovimento === 'ACERTO_SAIDA' && Boolean(m.estornoDeId);
}

/**
 * A saída ao custo informado (`MovimentoNoSaldo.saidaAoCusto`): a perna do destino no estorno da mudança de tipo
 * (`estornoDeMudancaTipo`) e a saída da perda da transferência (`saidaDaPerdaTransferencia`). O motor online e o
 * replay do razão decidem por esta função, pelo tipo de movimento e pelo `estorno_de_id` gravados.
 */
export function saidaAoCustoInformado(m: { tipoMovimento: string; estornoDeId?: string | null }): boolean {
  return estornoDeMudancaTipo(m) || saidaDaPerdaTransferencia(m);
}

/**
 * MD 3.1.8 e 3.7.2 (F2-B2, README da API › decisão 146): a cadeia do razão de uma linha de saldo não fecha na ordem de
 * lançamento (o `saldo_anterior` de um movimento não é o `saldo_posterior` do anterior). Aberto pelo preenchimento da
 * `seq_lancamento` dos movimentos antigos, aviso, um aberto por linha (`razao_cadeia:<hash da linha>`), no produto
 * (`entidade = 'produtos'`), com a linha, o movimento, os saldos e a `origem` em `dados`. Quem corrige o saldo é o
 * `db:recalcular-saldos` (F2-B3).
 */
export const ALERTA_RAZAO_CADEIA_QUEBRADA = 'RAZAO_CADEIA_QUEBRADA';

/**
 * MD 3.1.8 (F2-B3, README da API › decisão 147): a verificação periódica do razão (opcional, desligada por padrão:
 * `VERIFICACAO_RAZAO_CRON`) achou linha de `saldos_estoque` ou `produtos.custo_medio` diferente do replay de
 * `movimentos_estoque`. Aviso, um aberto por empresa (`razao_saldos`), com as contagens e as primeiras linhas em
 * `dados`; a próxima verificação idêntica o resolve. Quem corrige é o `db:recalcular-saldos --corrigir`.
 */
export const ALERTA_RAZAO_SALDO_DIVERGENTE = 'RAZAO_SALDO_DIVERGENTE';

/**
 * Um movimento visto pela conta do saldo (ERP 13.1.4; T20): o que o motor online (`apps/api/src/estoques/movimentos.ts`)
 * recebe do documento e o que o replay do razão relê de `movimentos_estoque` (`movimentoGravadoNoSaldo`).
 */
export interface MovimentoNoSaldo {
  /** Com sinal, na unidade base (+ entrada, − saída). Arredondada a 3 casas antes da conta; zero é recusado. */
  quantidade: Valor;
  /**
   * Entrada: custo do documento (vazio = custo médio, ou `custoReferencia` sem custo médio). Estorno de saída
   * (`estorno` com quantidade positiva): obrigatório, o custo da saída original (T20). Saída: ignorado.
   */
  custoUnitario?: Valor | null;
  /** Custo usado quando a linha de saldo ainda não tem custo médio (ex.: `produtos.preco_custo`). */
  custoReferencia: Valor;
  /** Estorno de outro movimento (`estorno_de_id`). Só muda a conta da entrada: a do estorno de uma entrada é a de saída. */
  estorno?: boolean;
  /**
   * Saída ao `custoUnitario` informado (obrigatório), com o custo médio refeito pela conta inversa da média ponderada
   * (`custoMedioAposSaidaAoCustoTexto`): a perna do destino no estorno da mudança de tipo (`estornoDeMudancaTipo`,
   * F2-B8) e a saída da perda da transferência (`saidaDaPerdaTransferencia`, F2-B24), por `saidaAoCustoInformado`. Sem
   * saldo que sobre ou com o médio que ficaria ≤ 0, é a saída comum (custo médio vigente).
   */
  saidaAoCusto?: boolean;
}

/** O movimento calculado sobre a linha de saldo: os valores que o razão grava, em texto com as casas da coluna. */
export interface SaldoAposMovimento {
  /** `numeric(15,3)` com sinal. */
  quantidade: string;
  saldoAnterior: string;
  saldoPosterior: string;
  /** `numeric(15,4)`: o custo gravado no movimento. */
  custoUnitario: string;
  /** `numeric(15,2)`: `|quantidade| × custo_unitario`. */
  custoTotal: string;
  /** `numeric(15,4)`: o custo médio da linha depois do movimento. */
  custoMedioPosterior: string;
}

/**
 * A conta de um movimento sobre a linha de saldo (Fase 2, F2-B2): a **mesma função** no motor online e no replay do
 * razão (`db:recalcular-saldos`, F2-B3), para que refazer a lista de movimentos na ordem de lançamento
 * (`seq_lancamento`) repita o saldo e o custo médio gravados. Cobre a entrada (custo do documento, custo médio
 * ponderado), a saída (custo médio vigente, ou `custoReferencia` sem custo médio, que passa a ser o custo médio), o
 * estorno de saída ao custo original (T20), a compensação do "Definir" (T23) e a diferença do próprio "Definir", que
 * são entradas ou saídas comuns pelo sinal. Arredonda em cada passo, como as colunas: quantidade e saldo a 3 casas,
 * custos a 4 e o total a 2 (ADR-05).
 */
export function aplicarMovimentoNoSaldo(
  saldo: Valor,
  custoMedio: Valor,
  mov: MovimentoNoSaldo,
): SaldoAposMovimento {
  const q = dec(decTexto(mov.quantidade, 3));
  if (q.isZero()) throw new Error('Movimento de estoque com quantidade zero');
  const custoMedioAtual = dec(custoMedio);
  const custoBase = custoMedioAtual.gt(0) ? custoMedioAtual : dec(mov.custoReferencia);
  let custoUnitario: string;
  let custoMedioPosterior: string;
  if (q.gt(0) && mov.estorno) {
    // Estorno de saída (T20): ao custo da saída original, sem redefinir o custo médio de saldo que não era positivo.
    if (mov.custoUnitario === null || mov.custoUnitario === undefined) {
      throw new Error('Estorno de saída sem o custo da saída original');
    }
    custoUnitario = decTexto(mov.custoUnitario, 4);
    custoMedioPosterior = custoMedioAposEstornoTexto(saldo, custoMedio, q, custoUnitario);
  } else if (q.gt(0)) {
    custoUnitario = decTexto(mov.custoUnitario ?? custoBase, 4);
    custoMedioPosterior = custoMedioAposEntradaTexto(saldo, custoMedio, q, custoUnitario);
  } else {
    let inverso: string | null = null;
    if (mov.saidaAoCusto) {
      // Estorno da perna de entrada da mudança de tipo (F2-B8) ou perda da transferência (F2-B24): tira o valor que a
      // entrada desfeita pôs na linha.
      if (mov.custoUnitario === null || mov.custoUnitario === undefined) {
        throw new Error('Saída ao custo informado sem o custo');
      }
      inverso = custoMedioAposSaidaAoCustoTexto(saldo, custoMedio, q, mov.custoUnitario);
    }
    // A conta inversa que não vale cai na saída comum. Gravado, o custo é o médio vigente, e o replay (que relê esse
    // custo) chega à mesma saída comum: a inversa com c = cm devolve o próprio cm.
    custoUnitario = inverso === null ? decTexto(custoBase, 4) : decTexto(mov.custoUnitario!, 4);
    custoMedioPosterior = inverso ?? decTexto(custoBase, 4);
  }
  const saldoAnterior = decTexto(saldo, 3);
  return {
    quantidade: q.toFixed(3),
    saldoAnterior,
    saldoPosterior: decTexto(dec(saldoAnterior).plus(q), 3),
    custoUnitario,
    custoTotal: decTexto(q.abs().times(custoUnitario), 2),
    custoMedioPosterior,
  };
}

/**
 * O movimento gravado, pronto para o replay (`aplicarMovimentoNoSaldo`): o `custo_unitario` gravado vale como custo do
 * documento (entrada), como custo original (estorno) e como referência da saída sem custo médio — que, gravada, é
 * exatamente o custo de referência daquele instante. A saída com custo médio positivo ignora o gravado e usa o da
 * linha refeita; se os dois divergirem, quem compara (F2-B3) acha o primeiro movimento divergente.
 */
export function movimentoGravadoNoSaldo(m: {
  quantidade: Valor;
  custoUnitario: Valor;
  estornoDeId: string | null;
  tipoMovimento: string;
}): MovimentoNoSaldo {
  return {
    quantidade: m.quantidade,
    custoUnitario: m.custoUnitario,
    custoReferencia: m.custoUnitario,
    estorno: m.estornoDeId !== null,
    saidaAoCusto: saidaAoCustoInformado(m),
  };
}

// ---------------------------------------------------------------- Lote e última compra (Fase 2, F2-B6)

/**
 * Tipos de movimento de compra (MD 7.3): a entrada que grava `saldos_estoque.ultima_compra_em` e
 * `ultimo_custo_compra` (MD 3.7.3), no motor online e no replay do razão. O estorno do recebimento
 * (`ESTORNO_RECEB_*`) não volta a última compra: ela é o registro da última compra lançada, não um saldo.
 */
export const TIPOS_MOVIMENTO_COMPRA = ['RECEB_MANUAL', 'RECEB_NFE'] as const;

/** O movimento é a entrada de uma compra (não estorno, quantidade positiva). */
export function movimentoDeCompra(m: {
  tipoMovimento: string;
  quantidade: Valor;
  estornoDeId?: string | null;
}): boolean {
  return (
    (TIPOS_MOVIMENTO_COMPRA as readonly string[]).includes(m.tipoMovimento) &&
    !m.estornoDeId &&
    dec(m.quantidade).gt(0)
  );
}

/**
 * `estoque.compra_atualiza_preco_custo` (F2-Q8 = D49, decidida pelo dono; F2-B15): a compra (recebimento e NF-e)
 * sempre atualiza o custo médio, a última compra do saldo e o último custo do fornecedor, mas o **preço de custo**
 * do produto (`produtos.preco_custo`, cadastrável à mão) só passa a ser o custo da compra conforme esta chave:
 * `sempre`, `perguntar` (o padrão: quem movimenta confirma, `atualizarPrecoCusto` do movimentar) ou `nunca`.
 */
export const CHAVE_COMPRA_ATUALIZA_PRECO_CUSTO = 'estoque.compra_atualiza_preco_custo';
export const MODOS_COMPRA_ATUALIZA_PRECO_CUSTO = ['sempre', 'perguntar', 'nunca'] as const;
export type ModoCompraAtualizaPrecoCusto = (typeof MODOS_COMPRA_ATUALIZA_PRECO_CUSTO)[number];

/**
 * `estoque.lote_baixa_sem_informar` (F2-Q7 = D48, decidida pelo dono em 05/11/2026): o que a saída sem lote faz no saldo
 * por lote de um produto com lote que tem saldo naquele estoque. `fefo` (padrão) divide a saída em um movimento por
 * lote, o que vence primeiro antes, com o `lote_id` gravado (o saldo por lote é refeito pelo razão e o estorno sabe
 * para qual lote devolver); `nao_baixar` não mexe no saldo por lote, que passa a divergir do total.
 */
export const CHAVE_LOTE_BAIXA_SEM_INFORMAR = 'estoque.lote_baixa_sem_informar';
export const MODOS_LOTE_BAIXA_SEM_INFORMAR = ['fefo', 'nao_baixar'] as const;
export type ModoLoteBaixaSemInformar = (typeof MODOS_LOTE_BAIXA_SEM_INFORMAR)[number];

/** Um lote com saldo, como a divisão FEFO o vê. */
export interface LoteDisponivel {
  loteId: string;
  /** `produtos_lotes.validade` (`AAAA-MM-DD`); sem validade fica depois de todos os que têm. */
  validade: string | null;
  /** Saldo do lote na linha (`saldos_lote.quantidade`); zero ou negativo não é usado. */
  disponivel: Valor;
}

/** Ordem FEFO (MD 3.6.9): validade crescente, sem validade por último, e o id do lote no empate. */
export function ordenarLotesFefo<T extends Pick<LoteDisponivel, 'loteId' | 'validade'>>(
  lotes: readonly T[],
): T[] {
  return [...lotes].sort((a, b) => {
    if (a.validade !== b.validade) {
      if (a.validade === null) return 1;
      if (b.validade === null) return -1;
      return a.validade < b.validade ? -1 : 1;
    }
    const x = a.loteId.toLowerCase();
    const y = b.loteId.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** Uma parte da saída dividida: com o lote, ou a sobra sem lote (`loteId` nulo). Quantidade negativa, 3 casas. */
export interface ParteSaidaLote {
  loteId: string | null;
  quantidade: string;
}

/**
 * A divisão FEFO de uma saída sem lote (F2-B6; F2-Q7 (a)): consome os lotes na ordem de `ordenarLotesFefo`, cada um
 * até o saldo dele (lote zerado ou negativo fica de fora), e o que sobra sai sem lote. A soma das partes é a
 * quantidade da saída. `quantidade` é a da saída, negativa.
 */
export function dividirSaidaFefo(quantidade: Valor, lotes: readonly LoteDisponivel[]): ParteSaidaLote[] {
  const q = dec(decTexto(quantidade, 3));
  if (!q.lt(0)) throw new Error('A divisão por lote é só da saída (quantidade negativa)');
  let resta = q.abs();
  const partes: ParteSaidaLote[] = [];
  for (const l of ordenarLotesFefo(lotes)) {
    if (resta.isZero()) break;
    const disponivel = dec(decTexto(l.disponivel, 3));
    if (!disponivel.gt(0)) continue;
    const parte = disponivel.lt(resta) ? disponivel : resta;
    partes.push({ loteId: l.loteId, quantidade: decTexto(parte.neg(), 3) });
    resta = resta.minus(parte);
  }
  if (resta.gt(0)) partes.push({ loteId: null, quantidade: decTexto(resta.neg(), 3) });
  return partes;
}

export function custoMedioAposEntrada(
  saldo: Valor,
  custoMedio: Valor,
  quantidade: Valor,
  custo: Valor,
): number {
  return Number(custoMedioAposEntradaTexto(saldo, custoMedio, quantidade, custo));
}

/**
 * Diferença do "Definir" na efetivação (ERP 13.1.5 regra 2): desconta do saldo atual os movimentos já aplicados com
 * `data_movimento` depois da contagem, que a contagem não viu. Ex.: contado 20 às 11:00, venda de −2 às 11:30, saldo
 * 18 às 12:00 → `20 − (18 − (−2)) = 0`.
 */
export function diferencaDefinirTexto(contado: Valor, saldoAtual: Valor, somaPosteriores: Valor): string {
  return decTexto(dec(contado).minus(dec(saldoAtual).minus(dec(somaPosteriores))), 3);
}

export function diferencaDefinir(contado: Valor, saldoAtual: Valor, somaPosteriores: Valor): number {
  return Number(diferencaDefinirTexto(contado, saldoAtual, somaPosteriores));
}

/**
 * Quantidade com sinal do movimento de um item (Entrada +, Saída −, Definir = diferença), texto com 3 casas. Na
 * mudança de tipo é a perna de saída, da origem (−); a de entrada, no destino, é o oposto.
 */
export function quantidadeMovimentoTexto(
  tipo: TipoAjuste,
  informada: Valor,
  saldoAtual: Valor,
  somaPosteriores: Valor = 0,
): string {
  if (tipo === 'entrada') return decTexto(informada, 3);
  if (tipo === 'saida' || tipo === 'mudanca_tipo') return decTexto(dec(informada).neg(), 3);
  return diferencaDefinirTexto(informada, saldoAtual, somaPosteriores);
}

export function quantidadeMovimento(
  tipo: TipoAjuste,
  informada: Valor,
  saldoAtual: Valor,
  somaPosteriores: Valor = 0,
): number {
  return Number(quantidadeMovimentoTexto(tipo, informada, saldoAtual, somaPosteriores));
}

export interface LinhaTotalAcerto {
  tipo: TipoAjuste;
  /** Quantidade informada (Entrada/Saída) ou contada (Definir). */
  quantidade: Valor;
  saldoAtual: Valor;
  custoUnitario: Valor;
  precoVenda: Valor;
}

/**
 * Valores de um item na tela e no documento (ERP 13.5 "Total"): Entrada/Saída valorizam a quantidade informada;
 * Definir valoriza a diferença com sinal (sobra +, perda −), que é o que muda o estoque. Texto com as casas da coluna.
 */
export function valoresItemAcertoTexto(l: LinhaTotalAcerto): {
  diferenca: string;
  totalVenda: string;
  totalCusto: string;
} {
  const diferenca = quantidadeMovimentoTexto(l.tipo, l.quantidade, l.saldoAtual);
  const base = l.tipo === 'definir' ? dec(diferenca) : dec(l.quantidade);
  return {
    diferenca,
    totalVenda: decTexto(base.times(dec(l.precoVenda)), 2),
    totalCusto: decTexto(base.times(dec(l.custoUnitario)), 2),
  };
}

export function valoresItemAcerto(l: LinhaTotalAcerto): {
  diferenca: number;
  totalVenda: number;
  totalCusto: number;
} {
  const v = valoresItemAcertoTexto(l);
  return {
    diferenca: Number(v.diferenca),
    totalVenda: Number(v.totalVenda),
    totalCusto: Number(v.totalCusto),
  };
}

/** Totais do documento: soma dos totais já arredondados de cada item (como o documento grava). */
export function totaisAcertoTexto(linhas: readonly LinhaTotalAcerto[]): {
  qtdItens: number;
  totalVenda: string;
  totalCusto: string;
} {
  let totalVenda = dec(0);
  let totalCusto = dec(0);
  for (const l of linhas) {
    const v = valoresItemAcertoTexto(l);
    totalVenda = totalVenda.plus(v.totalVenda);
    totalCusto = totalCusto.plus(v.totalCusto);
  }
  return {
    qtdItens: linhas.length,
    totalVenda: decTexto(totalVenda, 2),
    totalCusto: decTexto(totalCusto, 2),
  };
}

export function totaisAcerto(linhas: readonly LinhaTotalAcerto[]): {
  qtdItens: number;
  totalVenda: number;
  totalCusto: number;
} {
  const t = totaisAcertoTexto(linhas);
  return { qtdItens: t.qtdItens, totalVenda: Number(t.totalVenda), totalCusto: Number(t.totalCusto) };
}

// ---------------------------------------------------------------- Acerto (ERP 13.5; MD 3.7.5)

/**
 * Teto da quantidade do item do acerto (o contrato e a coluna `numeric(15,3)`). A importação de contagem (F2-B9)
 * recusa a leitura e o total do produto acima dele (o EAN bipado no campo da quantidade), em vez de o banco estourar.
 */
export const MAXIMO_QUANTIDADE_ACERTO = 999_999_999_999;

const quantidadeAcerto = decimal({
  min: 0,
  max: MAXIMO_QUANTIDADE_ACERTO,
  casas: 3,
  mensagem: 'Quantidade inválida',
});
const custoOpcional = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  decimal({ min: 0, max: 99_999_999_999, casas: 4, mensagem: 'Custo inválido' }).nullable().default(null),
);
const idOpcional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.uuid().nullable().default(null),
);

export const itemAcertoSchema = z.object({
  id: idOpcional,
  produtoId: z.uuid('Escolha o produto'),
  variacaoId: idOpcional,
  /**
   * Lote (`produtos_lotes`, F2-B6): só na Entrada, na Saída e na mudança de tipo, do produto e do estoque do acerto (ou
   * sem estoque). A Saída sem lote de produto com lote baixa em FEFO (`estoque.lote_baixa_sem_informar`), e a mudança
   * de tipo também (cada lote da perna de saída entra no destino com o mesmo lote, F2-B8); o Definir conta o produto
   * inteiro, sem lote.
   */
  loteId: idOpcional,
  quantidade: quantidadeAcerto,
  /** Só na Entrada (padrão: custo médio). Saída, Definir e mudança de tipo usam o custo médio vigente. */
  custoUnitario: custoOpcional,
});
export type ItemAcertoEntrada = z.input<typeof itemAcertoSchema>;

/**
 * Itens por acerto (ERP 13.5): o contrato recusa mais que isso no POST/PUT, e a importação de contagem (F2-B9) divide
 * o arquivo maior em vários rascunhos com a mesma hora da contagem.
 */
export const LIMITE_ITENS_ACERTO = 5000;

/** Tolerância para relógio do navegador adiantado ao conferir "não futura". */
const FOLGA_FUTURO_MS = 5 * 60_000;

/**
 * Data/hora da contagem (ERP 13.1.5): data válida, normalizada para ISO e não futura (com a folga do relógio do
 * navegador). A mesma regra do cabeçalho do acerto e do "Atualizar estoque" da importação de planilha (F2-B11).
 */
export const dataContagemSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Data/hora inválida')
  .transform((v) => new Date(v).toISOString())
  .refine((v) => Date.parse(v) <= Date.now() + FOLGA_FUTURO_MS, 'A data não pode ser futura');

const camposAcerto = z.object({
  estoqueId: z.uuid('Escolha o estoque'),
  /** Vazio = tipo de estoque padrão (Disponível). Na mudança de tipo, o tipo de origem. */
  tipoEstoqueId: idOpcional,
  tipoAjuste: z.enum(TIPOS_AJUSTE).default('entrada'),
  /** Só na mudança de tipo (obrigatório nela): o tipo que recebe a quantidade, diferente do de origem. */
  tipoEstoqueDestinoId: idOpcional,
  dataContagem: dataContagemSchema,
  motivo: textoObrigatorio(120, 'Informe o motivo'),
  /** Vazio = o usuário logado. */
  responsavelId: idOpcional,
  observacoes: textoOpcional(2000),
  itens: z.array(itemAcertoSchema).max(LIMITE_ITENS_ACERTO, 'No máximo 5.000 itens por acerto').default([]),
});

function regrasAcerto(v: z.output<typeof camposAcerto>, ctx: z.RefinementCtx) {
  if (v.tipoAjuste === 'mudanca_tipo' && v.tipoEstoqueDestinoId === null) {
    ctx.addIssue({ code: 'custom', path: ['tipoEstoqueDestinoId'], message: 'Escolha o tipo de destino' });
  } else if (v.tipoAjuste !== 'mudanca_tipo' && v.tipoEstoqueDestinoId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['tipoEstoqueDestinoId'],
      message: 'O tipo de destino só vale na mudança de tipo',
    });
  } else if (
    v.tipoEstoqueDestinoId !== null &&
    v.tipoEstoqueId !== null &&
    v.tipoEstoqueDestinoId.toLowerCase() === v.tipoEstoqueId.toLowerCase()
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['tipoEstoqueDestinoId'],
      message: 'O tipo de destino tem de ser diferente do de origem',
    });
  }
  const vistos = new Map<string, number>();
  v.itens.forEach((it, i) => {
    if (v.tipoAjuste !== 'definir' && Number(it.quantidade) <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'quantidade'],
        message: 'Informe uma quantidade maior que zero',
      });
    }
    if (v.tipoAjuste !== 'entrada' && it.custoUnitario !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'custoUnitario'],
        message: 'O custo só é informado na Entrada (os demais usam o custo médio)',
      });
    }
    if (v.tipoAjuste === 'definir' && it.loteId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'loteId'],
        message: 'O Definir conta o produto inteiro: deixe o lote em branco',
      });
    }
    const chave = `${it.produtoId}:${it.variacaoId ?? ''}:${it.loteId ?? ''}`;
    const anterior = vistos.get(chave);
    if (anterior !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'produtoId'],
        message: `Produto repetido (linha ${anterior + 1})`,
      });
    } else vistos.set(chave, i);
  });
}

export const criarAcertoSchema = camposAcerto.superRefine(regrasAcerto);
export type CriarAcertoEntrada = z.input<typeof criarAcertoSchema>;
export type CriarAcerto = z.output<typeof criarAcertoSchema>;
export const alterarAcertoSchema = camposAcerto
  .extend({ versao: z.number().int() })
  .superRefine((v, ctx) => regrasAcerto(v, ctx));
export type AlterarAcertoEntrada = z.input<typeof alterarAcertoSchema>;

export const efetivarAcertoSchema = z.object({ versao: z.number().int() });
export const estornarAcertoSchema = z.object({
  versao: z.number().int(),
  motivo: textoObrigatorio(255, 'Informe o motivo do estorno'),
});

/**
 * "Ajustar" do bloco Estoque do produto (ERP 8.2.11; F2-B12): um "Definir" de um item, criado e efetivado na mesma
 * transação com a origem `cadastro_produto` (movimento `AJUSTE_CADASTRO`). `quantidade` é a **nova** quantidade
 * contada (≥ 0) no estoque × tipo; a diferença é calculada na hora da contagem (13.1.5), como no Definir da tela. Sem
 * `dataContagem`, vale o momento da requisição ("agora"). Vazio no tipo = o padrão (Disponível).
 */
export const ajusteEstoqueProdutoSchema = z.object({
  estoqueId: z.uuid('Escolha o estoque'),
  tipoEstoqueId: idOpcional,
  quantidade: quantidadeAcerto,
  motivo: textoObrigatorio(120, 'Informe o motivo'),
  dataContagem: z.preprocess((v) => (v === '' || v === null ? undefined : v), dataContagemSchema.optional()),
  observacoes: textoOpcional(2000),
});
export type AjusteEstoqueProdutoEntrada = z.input<typeof ajusteEstoqueProdutoSchema>;
export type AjusteEstoqueProduto = z.output<typeof ajusteEstoqueProdutoSchema>;

/** Resposta do "Ajustar" (F2-B12): o acerto gerado (para o link) e o que a efetivação lançou. */
export interface ResultadoAjusteProduto {
  acertoId: string;
  codigo: number;
  /** Diferença lançada (nova quantidade − saldo na hora da contagem), com sinal. */
  diferenca: string;
  movimentos: number;
  compensacoes: number;
}

export const filtroAcertosSchema = paginacaoQuerySchema.extend({
  responsavelId: z.uuid().optional(),
  estoqueId: z.uuid().optional(),
  tipoAjuste: z.enum(TIPOS_AJUSTE).optional(),
  status: z.enum(STATUS_ACERTO).optional(),
  dataInicial: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
    .optional(),
  dataFinal: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
    .optional(),
});
export type FiltroAcertos = z.infer<typeof filtroAcertosSchema>;

export interface AcertoResumo {
  id: string;
  codigo: number;
  dataContagem: string;
  responsavelId: string;
  responsavelNome: string;
  motivo: string;
  estoqueId: string;
  estoqueNome: string;
  tipoAjuste: TipoAjuste;
  origem: OrigemAcerto;
  qtdItens: number;
  /** `null` sem `produtos.ver_custo`. */
  totalCusto: string | null;
  totalVenda: string;
  status: StatusAcerto;
  versao: number;
}

export interface ItemAcertoDetalhe {
  id: string;
  sequencia: number;
  produtoId: string;
  variacaoId: string | null;
  /** Lote do item (F2-B6) e o código dele; nulos sem lote. */
  loteId: string | null;
  lote: string | null;
  produto: ProdutoOpcao;
  quantidade: string;
  /** Rascunho: saldo atual no estoque × tipo; efetivado: o saldo usado na efetivação. */
  saldoAtual: string;
  /** Definir: contada − saldo (no rascunho, estimativa; efetivado, a diferença gravada). */
  diferenca: string;
  /** `null` sem `produtos.ver_custo`. */
  custoUnitario: string | null;
  /** O custo digitado na Entrada (vazio = custo médio). `null` sem `produtos.ver_custo`. */
  custoInformado: string | null;
  precoVenda: string;
  totalVenda: string;
  totalCusto: string | null;
}

export interface AcertoDetalhe extends MetadadosRegistro {
  codigo: number;
  estoqueId: string;
  estoqueNome: string;
  /** Loja do estoque (se for o estoque vinculado de uma loja). */
  lojaId: string | null;
  tipoEstoqueId: string;
  tipoEstoqueNome: string;
  tipoAjuste: TipoAjuste;
  /** Mudança de tipo (F2-B8): o tipo que recebe a quantidade; nulos nos demais. */
  tipoEstoqueDestinoId: string | null;
  tipoEstoqueDestinoNome: string | null;
  dataContagem: string;
  motivo: string;
  responsavelId: string;
  responsavelNome: string;
  observacoes: string | null;
  origem: OrigemAcerto;
  status: StatusAcerto;
  efetivadoEm: string | null;
  efetivadoPorNome: string | null;
  estornadoEm: string | null;
  estornadoPorNome: string | null;
  motivoEstorno: string | null;
  qtdItens: number;
  totalVenda: string;
  totalCusto: string | null;
  itens: ItemAcertoDetalhe[];
  /** Avisos que não impedem a efetivação (PDVs da loja offline/com pendências, ERP 13.1.5 regra 5). */
  avisos: string[];
  /**
   * As compensações ligadas ao acerto (F2-B10; ERP 13.1.5 regra 4), na ordem da hora do fato, até
   * `LIMITE_COMPENSACOES_DETALHE`; vazio no rascunho.
   */
  compensacoes: CompensacaoAcerto[];
  /** Quantas compensações existem ao todo (maior que `compensacoes.length` quando passou do limite). */
  totalCompensacoes: number;
}

/** Até quantas compensações o detalhe do acerto traz (o mesmo teto dos itens, `LIMITE_ITENS_ACERTO`). */
export const LIMITE_COMPENSACOES_DETALHE = LIMITE_ITENS_ACERTO;

/**
 * Por que a hora do fato compensado é duvidosa (F2-B10; SYNC 12.3–12.4). A compensação depende só da hora do fato
 * contra a hora da contagem: com o relógio do caixa errado, a venda pode ter sido compensada sem ter sido contada (ou
 * o contrário). Avaliado no evento do PDV que lançou o movimento compensado:
 * - `nao_confiavel`: o caixa mandou o evento com `relogio_confiavel = false` (SYNC 12.3);
 * - `futuro`, `passado`, `regressao`: as regras da SYNC 12.4 reavaliadas sobre o evento, com a mesma função que grava
 *   o alerta `RELOGIO_SUSPEITO` (`suspeitasDoRelogio`);
 * - `desvio`: o desvio medido pelo caixa no evento (`desvio_relogio_ms`) acima do crítico (5 min, SYNC 21.2), **só**
 *   quando o evento não veio com `relogio_confiavel = true`. Com a hora confiável o `ocorrido_em` já foi corrigido por
 *   esse desvio (SYNC 12.2, "desvio usado na correção"): o desvio grande só diz que o relógio do Windows está fora, e
 *   a hora do fato está certa (vai na dica, sem destacar);
 * - `regressao_marcada`: o caixa marcou a correção do relógio para trás (12.3). É esperada: aparece, mas não destaca.
 */
export const MOTIVOS_RELOGIO_COMPENSACAO = [
  'nao_confiavel',
  'futuro',
  'passado',
  'regressao',
  'desvio',
  'regressao_marcada',
] as const;
export type MotivoRelogioCompensacao = (typeof MOTIVOS_RELOGIO_COMPENSACAO)[number];

export const ROTULOS_MOTIVO_RELOGIO_COMPENSACAO: Record<MotivoRelogioCompensacao, string> = {
  nao_confiavel: 'o caixa estava sem hora confiável',
  futuro: 'hora no futuro (mais de 5 min à frente da nuvem)',
  passado: 'hora muito no passado (antes da ativação do terminal)',
  regressao: 'hora anterior à do evento anterior do caixa',
  desvio: 'relógio do computador mais de 5 min errado, sem amostra confiável para corrigir a hora',
  regressao_marcada: 'relógio corrigido para trás (marcado pelo caixa)',
};

/** Destaca a compensação (o "RELOGIO_SUSPEITO" da aba): qualquer motivo, menos a regressão marcada pelo caixa. */
export const relogioSuspeitoCompensacao = (motivos: readonly MotivoRelogioCompensacao[]): boolean =>
  motivos.some((m) => m !== 'regressao_marcada');

/**
 * Uma compensação (`ACERTO_COMPENSACAO`, SYNC 15.3) ligada ao acerto, com o movimento que ela anulou e o estorno que a
 * desfez (`ESTORNO_ACERTO` com `estorno_de_id` = ela), para a aba "Compensações" (F2-B10; ERP 13.1.5 regra 4).
 */
export interface CompensacaoAcerto {
  /** O movimento `ACERTO_COMPENSACAO`. */
  id: string;
  /**
   * `lancada`: este "Definir" já tinha contado o fato e o anulou (a venda offline anterior à contagem que chegou
   * depois da efetivação, ou o acerto lançado antes da contagem); `recebida`: um movimento deste acerto era anterior à
   * contagem de outro "Definir" já efetivado e foi anulado por ele.
   */
  sentido: 'lancada' | 'recebida';
  /** O "Definir" que lançou a compensação (este, em `lancada`). */
  acertoId: string;
  acertoCodigo: number;
  produtoId: string;
  produtoCodigo: number;
  produtoNome: string;
  variacaoId: string | null;
  loteId: string | null;
  lote: string | null;
  /** Quantidade da compensação, com o sinal (o oposto da do movimento compensado). */
  quantidade: string;
  /** `null` sem `produtos.ver_custo`. */
  custoUnitario: string | null;
  /** A hora do fato: a compensação repete a data do movimento compensado. */
  dataFato: string;
  /** Quando a compensação foi lançada (a chegada do evento tardio, ou a efetivação do acerto). */
  lancadaEm: string;
  /** O movimento compensado. */
  compensado: {
    id: string;
    tipoMovimento: string;
    tipoMovimentoNome: string;
    quantidade: string;
    documentoTipo: string;
    documentoId: string | null;
    /** O documento de origem para a tela: "Venda L01-C01-000012", "Acerto Nº 7", "Devolução de cascos". */
    documento: string;
    /** O terminal que lançou o fato (`null` em documento do ERP). */
    terminalId: string | null;
    /** "Caixa 01 · PC do balcão". */
    terminal: string | null;
    eventoId: string | null;
    /** A sequência do evento no terminal (SYNC 8.2). */
    sequencia: number | null;
    /**
     * Quando a nuvem recebeu o evento (`eventos_recebidos.criado_em`; na lacuna recuperada, a chegada do lote do
     * evento real, que `substituirPlaceholder` grava na linha do placeholder).
     */
    recebidoEm: string | null;
  };
  /** O relógio do caixa no evento (SYNC 12.3–12.4); `null` quando o fato não veio do PDV. */
  relogio: {
    confiavel: boolean | null;
    desvioMs: number | null;
    motivos: MotivoRelogioCompensacao[];
  } | null;
  /** `relogioSuspeitoCompensacao(relogio.motivos)`: a aba destaca a linha. */
  relogioSuspeito: boolean;
  /** O estorno que desfez a compensação (o estorno de um dos dois acertos); `null` enquanto ela vale. */
  estorno: {
    id: string;
    em: string;
    acertoId: string | null;
    acertoCodigo: number | null;
    motivo: string | null;
    /**
     * A compensação viva do mesmo movimento que entrou no lugar desta: no estorno de um "Definir", o fato que outro
     * "Definir" efetivado também contou é compensado de novo contra ele (`estornarAcerto`, SYNC 15.3), e continua
     * anulado. `null` quando o movimento voltou a valer.
     */
    substituidaPor: { id: string; acertoId: string; acertoCodigo: number } | null;
  } | null;
}

/** Saldo atual de um produto no estoque × tipo (coluna "Saldo atual" da grade). */
export const consultaSaldoItemSchema = z.object({
  estoqueId: z.uuid(),
  tipoEstoqueId: z.uuid().optional(),
  produtoIds: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.uuid()).min(1).max(200),
  ),
});

export interface SaldoItem {
  produtoId: string;
  variacaoId: string | null;
  quantidade: string;
  /** `null` sem `produtos.ver_custo`. */
  custoMedio: string | null;
}

// ---------------------------------------------------------------- Importar contagem e folha de contagem (F2-B9)

/** Arquivo do coletor ou da planilha (`.csv`/`.txt`) da importação de contagem: até 5 MB e 200.000 linhas. */
export const LIMITE_ARQUIVO_CONTAGEM = 5 * 1024 * 1024;
export const LIMITE_LINHAS_CONTAGEM = 200_000;

/** Separadores aceitos, na ordem de preferência da detecção (a vírgula por último: ela também é a casa decimal). */
export const SEPARADORES_CONTAGEM = [';', '\t', '|', ','] as const;
export type SeparadorContagem = (typeof SEPARADORES_CONTAGEM)[number];

/** Uma leitura do arquivo: o código como veio (sem espaços) e a quantidade lida, texto com 3 casas. */
export interface LeituraContagem {
  linha: number;
  codigo: string;
  quantidade: string;
}

export interface LinhaInvalidaContagem {
  linha: number;
  /** O texto da linha (até 80 caracteres), para o usuário achar no arquivo. */
  conteudo: string;
  mensagem: string;
  /**
   * O código da linha, quando ele é aproveitável (até 30 caracteres, sem caractere de controle) e o problema é a
   * quantidade ou o separador: o produto foi contado, então "Zerar os não contados" não o zera.
   */
  codigo: string | null;
}

export interface ArquivoContagemLido {
  /** `null`: nenhuma linha com separador (coletor que grava só o código, uma linha por leitura). */
  separador: SeparadorContagem | null;
  /**
   * O texto da primeira linha, quando ela era o cabeçalho (`EAN;Quantidade`, `Código;Qtd`…) e foi ignorada; a prévia o
   * mostra. Só é cabeçalho o rótulo conhecido inteiro (sem número): `COD0001` ou `ITEM10` é leitura.
   */
  cabecalho: string | null;
  /** Linhas com conteúdo (sem as vazias e sem o cabeçalho). */
  linhas: number;
  leituras: LeituraContagem[];
  invalidas: LinhaInvalidaContagem[];
  /**
   * Linhas cuja quantidade tem um único ponto ou vírgula seguido de exatamente 3 dígitos (`1.000`, `2,500`): lidas
   * como casa decimal (1 e 2,5), mas podem ser o milhar do Excel em pt-BR (`#.##0`). A prévia avisa com as linhas.
   */
  milharAmbiguo: number[];
}

/**
 * Quantidade lida do coletor ou da planilha (F2-B9): inteiro ou decimal com vírgula ou ponto. Um único ponto ou uma
 * única vírgula é a casa decimal (`1,5` e `1.5` = 1,5; o coletor grava com ponto e o Excel em pt-BR com vírgula);
 * com os dois, o último é a casa decimal e o outro o milhar (`1.234,5`); o mesmo sinal repetido é milhar
 * (`1.000.000`). Negativa, com mais de 3 casas ou não numérica: `null`. O teto (`MAXIMO_QUANTIDADE_ACERTO`) é
 * conferido por `lerArquivoContagem`, com mensagem própria; o `1.000` ambíguo é marcado lá (`milharAmbiguo`).
 */
export function lerQuantidadeContagem(bruto: string): string | null {
  let t = bruto.trim().replace(/\s/g, '');
  if (!t) return null;
  const ponto = t.lastIndexOf('.');
  const virgula = t.lastIndexOf(',');
  if (ponto >= 0 && virgula >= 0) {
    const decimal = ponto > virgula ? '.' : ',';
    const milhar = decimal === '.' ? ',' : '.';
    t = t.split(milhar).join('');
    if (t.split(decimal).length > 2) return null;
    t = t.replace(decimal, '.');
  } else if (virgula >= 0 || ponto >= 0) {
    const sinal = virgula >= 0 ? ',' : '.';
    const partes = t.split(sinal);
    t = partes.length > 2 ? partes.join('') : partes.join('.');
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  if ((t.split('.')[1]?.length ?? 0) > 3) return null;
  return decTexto(t, 3);
}

/**
 * Rótulo da coluna do código no cabeçalho, já sem acento, minúsculo e com a pontuação virando espaço (`Cód. Barras`
 * → `cod barras`, `EAN/GTIN`, `codigo_interno`). Tem de ser o rótulo inteiro: um código interno que só começa assim
 * (`COD0001`, `ITEM10`, `REF2L`) é leitura, não cabeçalho.
 */
const ROTULO_CABECALHO_CONTAGEM =
  /^(?:(?:ean|gtin)(?: ?13)?(?: (?:ean|gtin)(?: ?13)?)?|cod(?:igo)?(?: (?:de |do )?(?:barras|interno|produto|item))?|barras|produto|item|referencia|ref|sku)$/;
const normalizarRotulo = (v: string) =>
  v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/** Um único ponto ou vírgula com exatamente 3 dígitos depois (`1.000`, `12,500`): decimal ou milhar? */
const MILHAR_AMBIGUO = /^[1-9]\d{0,2}[.,]\d{3}$/;
const temControle = (v: string) =>
  [...v].some((c) => {
    const n = c.charCodeAt(0);
    return n < 32 || n === 127;
  });

/**
 * Divide a linha nos campos respeitando as aspas (RFC 4180): o separador dentro de aspas não divide (`7891…,"1,5"`,
 * como o Google Sheets e o LibreOffice em pt-BR exportam a quantidade decimal) e `""` dentro delas é uma aspa. A aspa
 * só abre no começo do campo; no meio dele é texto.
 */
function dividirCamposContagem(linha: string, separador: string | null): string[] {
  const campos: string[] = [];
  let atual = '';
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]!;
    if (aspas) {
      if (c !== '"') atual += c;
      else if (linha[i + 1] === '"') {
        atual += '"';
        i++;
      } else aspas = false;
    } else if (c === '"' && !atual.trim()) {
      atual = '';
      aspas = true;
    } else if (separador !== null && c === separador) {
      campos.push(atual.trim());
      atual = '';
    } else atual += c;
  }
  campos.push(atual.trim());
  return campos;
}

/**
 * Lê o arquivo do coletor ou da planilha da importação de contagem (F2-B9; ERP 13.5): uma leitura por linha,
 * `código;quantidade` (EAN, código de barras de embalagem ou código interno). Tira o BOM, aceita `\r\n`, `\n` e `\r`,
 * ignora as linhas vazias e o cabeçalho (só o rótulo conhecido inteiro, devolvido em `cabecalho` para a prévia
 * mostrar), e detecta o separador nas primeiras linhas (`;`, tabulação, `|` ou `,`, nessa ordem). Os campos respeitam
 * as aspas (`7891…,"1,5"` é 1,5). Linha só com o código vale 1 (o coletor que grava uma linha por leitura). Com o
 * separador `,`, a quantidade sem aspas não pode ter vírgula decimal (a linha com mais de dois campos é recusada, em
 * vez de ler "1,5" como 1); com os outros, as colunas além da segunda são ignoradas (data, operador do coletor).
 * Quantidade zero é contagem (o produto contado e não achado); acima de `MAXIMO_QUANTIDADE_ACERTO` é recusada (o EAN
 * bipado no campo da quantidade); a quantidade é a da unidade do código lido, e o fator da embalagem é aplicado
 * depois (`consolidarContagem`). O código com caractere de controle (o arquivo UTF-16 lido como texto simples) é
 * recusado. As linhas recusadas voltam em `invalidas`, sem parar a leitura, com o código quando ele é aproveitável.
 */
export function lerArquivoContagem(texto: string): ArquivoContagemLido {
  const linhas = texto.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const amostra = linhas.filter((l) => l.trim()).slice(0, 20);
  const separador = SEPARADORES_CONTAGEM.find((s) => amostra.some((l) => l.includes(s))) ?? null;
  const leituras: LeituraContagem[] = [];
  const invalidas: LinhaInvalidaContagem[] = [];
  const milharAmbiguo: number[] = [];
  let cabecalho: string | null = null;
  let comConteudo = 0;
  let primeira = true;
  linhas.forEach((bruta, i) => {
    if (!bruta.trim()) return;
    const linha = i + 1;
    const campos = dividirCamposContagem(bruta, separador);
    const [codigoBruto = '', quantidadeBruta] = campos;
    const quantidade = quantidadeBruta === undefined ? '1.000' : lerQuantidadeContagem(quantidadeBruta);
    if (primeira) {
      primeira = false;
      if (
        ROTULO_CABECALHO_CONTAGEM.test(normalizarRotulo(codigoBruto)) &&
        (campos.length === 1 || quantidade === null)
      ) {
        cabecalho = bruta.trim().slice(0, 80);
        return;
      }
    }
    comConteudo += 1;
    const codigo = codigoBruto.replace(/\s/g, '');
    const aproveitavel = !!codigo && codigo.length <= 30 && !temControle(codigo);
    const invalida = (mensagem: string) =>
      invalidas.push({
        linha,
        conteudo: bruta.trim().slice(0, 80),
        mensagem,
        codigo: aproveitavel ? codigo : null,
      });
    if (!codigo) return invalida('Linha sem código');
    if (codigo.length > 30) return invalida('Código com mais de 30 caracteres');
    if (temControle(codigo))
      return invalida(
        'Código com caractere de controle: o arquivo não é texto simples (salve como CSV UTF-8 ou texto)',
      );
    if (separador === ',' && campos.length > 2)
      return invalida(
        'Quantidade com vírgula num arquivo separado por vírgula: use ponto-e-vírgula como separador',
      );
    if (quantidade === null) return invalida('Quantidade inválida (número ≥ 0 com até 3 casas decimais)');
    if (dec(quantidade).gt(MAXIMO_QUANTIDADE_ACERTO))
      return invalida(
        `Quantidade acima de ${MAXIMO_QUANTIDADE_ACERTO.toLocaleString('pt-BR')}: o código foi lido no campo da quantidade?`,
      );
    if (quantidadeBruta !== undefined && MILHAR_AMBIGUO.test(quantidadeBruta.replace(/\s/g, '')))
      milharAmbiguo.push(linha);
    leituras.push({ linha, codigo, quantidade });
  });
  return { separador, cabecalho, linhas: comConteudo, leituras, invalidas, milharAmbiguo };
}

/** O produto como a prévia da contagem e a folha de contagem o mostram. */
export interface ProdutoContagem {
  id: string;
  codigo: number;
  nome: string;
  unidadeSigla: string;
}

/**
 * O que o código lido é na base da empresa (a API resolve; `consolidarContagem` agrega). `encontrado` traz o fator do
 * código de barras de embalagem (`produtos_codigos_barras.fator`; 1 no EAN da unidade e no código interno).
 */
export type ResolucaoCodigoContagem =
  | { situacao: 'encontrado'; produto: ProdutoContagem; fator: Valor }
  | { situacao: 'nao_encontrado' }
  | { situacao: 'ambiguo'; produtos: ProdutoContagem[] }
  | { situacao: 'sem_estoque' | 'com_variacoes'; produto: ProdutoContagem; mensagem: string };

export const PROBLEMAS_CONTAGEM = [
  'linha_invalida',
  'nao_encontrado',
  'ambiguo',
  'sem_estoque',
  'com_variacoes',
  'acima_do_maximo',
] as const;
export type TipoProblemaContagem = (typeof PROBLEMAS_CONTAGEM)[number];
export const ROTULOS_PROBLEMA_CONTAGEM: Record<TipoProblemaContagem, string> = {
  linha_invalida: 'Linha inválida',
  nao_encontrado: 'Não encontrado',
  ambiguo: 'Código ambíguo',
  sem_estoque: 'Sem estoque próprio',
  com_variacoes: 'Produto com variações',
  acima_do_maximo: 'Quantidade acima do máximo',
};

/**
 * Um código (ou uma linha inválida) que não entra no rascunho, com as linhas do arquivo em que apareceu. Em
 * `acima_do_maximo` é o produto cujo total (`Σ quantidade × fator`, ou a soma com o já gravado) passa de
 * `MAXIMO_QUANTIDADE_ACERTO`, com os códigos lidos dele.
 */
export interface ProblemaContagem {
  tipo: TipoProblemaContagem;
  /** `null` na linha inválida sem código aproveitável. */
  codigo: string | null;
  linhas: number[];
  leituras: number;
  /** Soma das quantidades lidas (na unidade do código, sem fator); `null` na linha inválida. */
  quantidadeLida: string | null;
  mensagem: string;
  /** O produto recusado, ou os produtos que têm o código ambíguo. */
  produtos: ProdutoContagem[];
}

/** Um código lido de um produto encontrado, com o fator aplicado. */
export interface CodigoLidoContagem {
  codigo: string;
  fator: string;
  leituras: number;
  /** Soma das quantidades lidas com este código (sem fator). */
  quantidadeLida: string;
}

/** Um produto contado: a soma, em unidades, de todas as leituras de todos os códigos dele. */
export interface ItemConsolidadoContagem {
  produto: ProdutoContagem;
  /** `Σ quantidade × fator`, texto com 3 casas. */
  quantidade: string;
  leituras: number;
  codigos: CodigoLidoContagem[];
}

/**
 * Agrega as leituras da contagem (F2-B9): cada leitura de produto encontrado vira unidades (`quantidade × fator` do
 * código; o fardo de 12 lido 2 vezes conta 24) e as leituras repetidas do mesmo produto, por qualquer código, somam.
 * Os itens saem na ordem da primeira leitura de cada produto; os códigos não encontrados, ambíguos ou recusados vão
 * para `problemas` (um por código, com as linhas e a quantidade lida), na ordem da primeira linha, e nunca entram na
 * soma. O produto cujo total passa de `MAXIMO_QUANTIDADE_ACERTO` (o fardo × 24 de uma quantidade enorme) também vai
 * para `problemas` (`acima_do_maximo`), em vez de estourar a coluna na gravação. A conta é em decimal e só a soma é
 * arredondada (3 casas).
 */
export function consolidarContagem(
  leituras: readonly LeituraContagem[],
  resolver: (codigo: string) => ResolucaoCodigoContagem,
): { itens: ItemConsolidadoContagem[]; problemas: ProblemaContagem[] } {
  const itens = new Map<
    string,
    {
      produto: ProdutoContagem;
      total: Dec;
      leituras: number;
      linhas: number[];
      codigos: Map<string, { fator: string; leituras: number; lida: Dec }>;
    }
  >();
  const problemas = new Map<string, ProblemaContagem & { lida: Dec }>();
  for (const l of leituras) {
    const r = resolver(l.codigo);
    if (r.situacao === 'encontrado') {
      const it = itens.get(r.produto.id) ?? {
        produto: r.produto,
        total: dec(0),
        leituras: 0,
        linhas: [] as number[],
        codigos: new Map(),
      };
      itens.set(r.produto.id, it);
      it.total = it.total.plus(dec(l.quantidade).times(dec(r.fator)));
      it.leituras += 1;
      it.linhas.push(l.linha);
      const c = it.codigos.get(l.codigo) ?? { fator: decTexto(r.fator, 3), leituras: 0, lida: dec(0) };
      it.codigos.set(l.codigo, c);
      c.leituras += 1;
      c.lida = c.lida.plus(l.quantidade);
      continue;
    }
    const p =
      problemas.get(l.codigo) ??
      (() => {
        const novo = {
          tipo: r.situacao,
          codigo: l.codigo,
          linhas: [] as number[],
          leituras: 0,
          quantidadeLida: null,
          lida: dec(0),
          mensagem:
            r.situacao === 'nao_encontrado'
              ? 'Código não encontrado nos produtos (EAN, código de barras ou código interno)'
              : r.situacao === 'ambiguo'
                ? 'O mesmo código está em mais de um produto: conte pelo código interno ou acerte o cadastro'
                : r.mensagem,
          produtos:
            r.situacao === 'ambiguo' ? r.produtos : r.situacao === 'nao_encontrado' ? [] : [r.produto],
        };
        problemas.set(l.codigo, novo);
        return novo;
      })();
    p.linhas.push(l.linha);
    p.leituras += 1;
    p.lida = p.lida.plus(l.quantidade);
  }
  const aceitos = [...itens.values()].filter((it) => {
    if (!it.total.gt(MAXIMO_QUANTIDADE_ACERTO)) return true;
    problemas.set(`\u0000${it.produto.id}`, {
      tipo: 'acima_do_maximo',
      codigo: [...it.codigos.keys()].join(', ').slice(0, 80),
      linhas: it.linhas,
      leituras: it.leituras,
      quantidadeLida: null,
      lida: [...it.codigos.values()].reduce((s, c) => s.plus(c.lida), dec(0)),
      mensagem: `O total do produto (${decTexto(it.total, 3)}) passa de ${MAXIMO_QUANTIDADE_ACERTO.toLocaleString('pt-BR')}: confira as quantidades lidas`,
      produtos: [it.produto],
    });
    return false;
  });
  return {
    itens: aceitos.map((it) => ({
      produto: it.produto,
      quantidade: decTexto(it.total, 3),
      leituras: it.leituras,
      codigos: [...it.codigos.entries()].map(([codigo, c]) => ({
        codigo,
        fator: c.fator,
        leituras: c.leituras,
        quantidadeLida: decTexto(c.lida, 3),
      })),
    })),
    problemas: [...problemas.values()]
      .map(({ lida, ...p }) => ({ ...p, quantidadeLida: decTexto(lida, 3) }))
      .sort((a, b) => a.linhas[0]! - b.linhas[0]!),
  };
}

/**
 * Divide os itens em rascunhos de até `LIMITE_ITENS_ACERTO` (F2-B9): o primeiro já tem `ocupados` itens gravados e
 * recebe só o que cabe; os demais viram rascunhos novos. Devolve, para cada item, o índice do rascunho (0 = o atual).
 */
export function dividirEmRascunhos(ocupados: number, novos: number, limite = LIMITE_ITENS_ACERTO): number[] {
  const livres = Math.max(0, limite - ocupados);
  return Array.from({ length: novos }, (_, i) => (i < livres ? 0 : 1 + Math.floor((i - livres) / limite)));
}

const booleanoFormulario = z.preprocess(
  (v) =>
    v === 'true' || v === 'on' || v === '1' ? true : v === 'false' || v === '0' || v === '' ? false : v,
  z.boolean().default(false),
);

/**
 * `itensExistentes`: o que fazer com o produto do arquivo que já é item do rascunho, ou de outro rascunho da mesma
 * contagem (a divisão acima de 5.000 itens: a quantidade é gravada no rascunho em que ele está). `somar` (padrão) soma
 * a quantidade do arquivo à gravada (a contagem por setor, com mais de um coletor); `substituir` grava a do arquivo (a
 * recontagem de um setor). O produto do rascunho que não está no arquivo fica como está.
 */
export const MODOS_ITENS_EXISTENTES_CONTAGEM = ['somar', 'substituir'] as const;
export type ModoItensExistentesContagem = (typeof MODOS_ITENS_EXISTENTES_CONTAGEM)[number];

/**
 * Opções do `POST /acertos/:id/importar-contagem` (multipart, ao lado do `arquivo`). `previa` (padrão) não grava;
 * `gravar` exige a `versao` do acerto (a mesma do PUT) e devolve a mesma prévia com os rascunhos gravados.
 * `zerarNaoContados` (desligada por padrão) grava 0 para os produtos com saldo no estoque × tipo que não estão no
 * arquivo nem já no rascunho (nem nos outros rascunhos da mesma contagem).
 */
export const opcoesImportarContagemSchema = z
  .object({
    modo: z.enum(['previa', 'gravar']).default('previa'),
    zerarNaoContados: booleanoFormulario,
    itensExistentes: z.enum(MODOS_ITENS_EXISTENTES_CONTAGEM).default('somar'),
    versao: z.preprocess(
      (v) => (v === '' || v === undefined || v === null ? undefined : Number(v)),
      z.number().int().optional(),
    ),
  })
  .superRefine((v, ctx) => {
    if (v.modo === 'gravar' && v.versao === undefined)
      ctx.addIssue({ code: 'custom', path: ['versao'], message: 'Informe a versão do acerto' });
  });
export type OpcoesImportarContagem = z.output<typeof opcoesImportarContagemSchema>;

/** Um produto da prévia: o que o arquivo leu, o que o rascunho já tinha e o que fica gravado como contado. */
export interface ItemPreviaContagem {
  produto: ProdutoContagem;
  /** Unidades lidas (`Σ quantidade × fator`); `'0.000'` no produto zerado. */
  quantidadeArquivo: string;
  /** O contado já gravado no rascunho; `null` no item novo. */
  quantidadeAnterior: string | null;
  quantidadeFinal: string;
  leituras: number;
  codigos: CodigoLidoContagem[];
  /** Gerado por "Zerar os não contados" (produto com saldo fora do arquivo). */
  zerado: boolean;
  /** Rascunho em que o item fica: 0 = este acerto; 1, 2… = os novos da divisão acima de 5.000 itens. */
  rascunho: number;
  /**
   * Nº do outro rascunho da mesma contagem (o mesmo estoque, tipo e hora) em que o produto já estava: a soma ou a
   * troca é gravada nele, e não neste (`rascunho` fica 0). `null` no item deste rascunho e no novo.
   */
  outroAcerto: number | null;
}

/** Resposta do `POST /acertos/:id/importar-contagem` (prévia e gravação). */
export interface PreviaContagem {
  arquivo: string;
  separador: SeparadorContagem | null;
  /** A primeira linha, quando foi ignorada como cabeçalho (a prévia avisa); `null` sem cabeçalho. */
  cabecalho: string | null;
  /** Linhas com conteúdo (sem as vazias e sem o cabeçalho). */
  linhas: number;
  leituras: number;
  /** Os produtos aceitos do arquivo, na ordem da primeira leitura, e depois os zerados (por nome). */
  itens: ItemPreviaContagem[];
  problemas: ProblemaContagem[];
  totais: {
    /** Produtos do arquivo encontrados e aceitos. */
    produtos: number;
    novos: number;
    /** Já eram item deste rascunho ou de outro da mesma contagem (`outroAcerto`). */
    alterados: number;
    zerados: number;
    /** Leituras que não entram (linhas inválidas e códigos com problema). */
    leiturasRecusadas: number;
    /** Unidades lidas dos produtos aceitos. */
    unidades: string;
  };
  /** Rascunhos que a contagem ocupa: 1 = só este; mais = a divisão acima de 5.000 itens. */
  rascunhos: number;
  avisos: string[];
  gravado: boolean;
  /** Depois de gravar: este acerto e os rascunhos novos da divisão, com a quantidade de itens de cada um. */
  acertos: { id: string; codigo: number; qtdItens: number }[];
  /**
   * Os outros rascunhos da mesma contagem em que um produto do arquivo já estava e que a gravação altera (na prévia,
   * os que vai alterar).
   */
  outrosAcertos: { id: string; codigo: number; qtdItens: number }[];
}

export const ORDENS_FOLHA_CONTAGEM = ['localizacao', 'nome'] as const;
export type OrdemFolhaContagem = (typeof ORDENS_FOLHA_CONTAGEM)[number];
export const ROTULOS_ORDEM_FOLHA_CONTAGEM: Record<OrdemFolhaContagem, string> = {
  localizacao: 'Localização',
  nome: 'Nome',
};

/** Folha de contagem impressa (F2-B9; ERP 13.5 "Imprimir"): `cega` (padrão) não traz o saldo. */
export const filtroFolhaContagemSchema = z.object({
  estoqueId: z.uuid('Escolha o estoque'),
  /** Vazio = o tipo padrão. */
  tipoEstoqueId: z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional()),
  ordem: z.enum(ORDENS_FOLHA_CONTAGEM).default('localizacao'),
  cega: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  marcaId: z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional()),
  /** Inclui as subcategorias. */
  categoriaId: z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional()),
});
export type FiltroFolhaContagem = z.output<typeof filtroFolhaContagemSchema>;

/** Teto de linhas da folha (a empresa inteira cabe; o filtro por marca ou categoria divide a impressão). */
export const LIMITE_LINHAS_FOLHA_CONTAGEM = 20_000;

export interface LinhaFolhaContagem {
  produtoId: string;
  codigo: number;
  codigoInterno: string | null;
  /** EAN principal (ou o primeiro código de barras da unidade). */
  codigoBarras: string | null;
  nome: string;
  unidadeSigla: string;
  localizacao: string | null;
  marca: string | null;
  /** `null` na folha cega. */
  saldo: string | null;
}

export interface FolhaContagem {
  estoqueNome: string;
  tipoEstoqueNome: string;
  cega: boolean;
  ordem: OrdemFolhaContagem;
  marca: string | null;
  categoria: string | null;
  geradaEm: string;
  linhas: LinhaFolhaContagem[];
}

/** Lote de um produto no estoque × tipo, para a coluna "Lote" da grade do acerto (F2-B6, F2-B9). */
export interface LoteSaldoItem {
  loteId: string;
  produtoId: string;
  variacaoId: string | null;
  lote: string;
  /** `AAAA-MM-DD`. */
  validade: string | null;
  /** `saldos_lote.quantidade` no estoque × tipo (zero sem linha). */
  quantidade: string;
}

// ---------------------------------------------------------------- Tipo de Estoque (ERP 13.6; MD 3.2.6, 7.4)

export interface TipoEstoqueOpcao {
  id: string;
  nome: string;
  vendavel: boolean;
  padrao: boolean;
  ativo: boolean;
  /** `disponivel`, `avaria`, `vencido`, `uso_consumo`, `vasilhame_vazio` (seed) ou `null` (criado pela empresa). */
  chaveSistema: string | null;
  versao: number;
}

export interface TipoEstoqueDetalhe extends TipoEstoqueOpcao, MetadadosRegistro {
  /** Terminais que receberam `ressincronizar_fluxo 'estoque'` nesta gravação (só na resposta do POST/PUT). */
  terminaisRessincronizados?: number;
}

/**
 * `vendavel` exigido em dois tipos de sistema. O Disponível continua vendável por escolha conservadora: as vendas e os
 * documentos sem tipo baixam do tipo **padrão**, qualquer que seja, mas o Disponível é o padrão de fábrica e pode
 * voltar a sê-lo a qualquer momento (o padrão é sempre vendável). O Vasilhame vazio guarda os cascos devolvidos (PDV
 * 10.12), que não se vendem como produto à venda; por isso ele nunca pode ser o padrão.
 */
export const VENDAVEL_TRAVADO_POR_CHAVE: Readonly<Record<string, boolean>> = {
  disponivel: true,
  vasilhame_vazio: false,
};

/** Tipos de sistema que a sincronização usa sempre (a devolução de cascos do PDV): não se inativam. */
export const CHAVES_TIPO_ESTOQUE_SEMPRE_ATIVAS: readonly string[] = ['vasilhame_vazio'];

const camposTipoEstoque = z.object({
  nome: textoObrigatorio(40, 'Informe o nome'),
  vendavel: z.boolean().default(false),
  padrao: z.boolean().default(false),
  ativo: z.boolean().default(true),
});

/** O padrão é o tipo das vendas e dos documentos sem tipo: sempre vendável e ativo (ERP 13.6). */
const regraDoPadrao = <T extends { padrao: boolean; vendavel: boolean; ativo: boolean }>(
  v: T,
  ctx: z.RefinementCtx,
) => {
  if (!v.padrao) return;
  if (!v.vendavel)
    ctx.addIssue({ code: 'custom', path: ['vendavel'], message: 'O tipo padrão tem de ser vendável' });
  if (!v.ativo)
    ctx.addIssue({ code: 'custom', path: ['ativo'], message: 'O tipo padrão não pode ser inativo' });
};

export const criarTipoEstoqueSchema = camposTipoEstoque.superRefine(regraDoPadrao);
export type CriarTipoEstoqueEntrada = z.input<typeof criarTipoEstoqueSchema>;
export const alterarTipoEstoqueSchema = camposTipoEstoque
  .extend({ versao: z.number().int() })
  .superRefine(regraDoPadrao);
export type AlterarTipoEstoqueEntrada = z.input<typeof alterarTipoEstoqueSchema>;

/**
 * Regras de um tipo que dependem do que já está gravado (ERP 13.6), por campo: o tipo de sistema com `vendavel`
 * travado, o tipo sempre ativo e o padrão que só deixa de sê-lo quando outro é marcado. A API recusa com elas; a tela
 * as mostra antes do PUT (as travas como chaves desabilitadas e estes erros nos campos).
 */
export function errosRegraTipoEstoque(
  antes: Pick<TipoEstoqueOpcao, 'chaveSistema' | 'padrao'> | null,
  depois: { vendavel: boolean; padrao: boolean; ativo: boolean },
): Record<string, string> {
  const erros: Record<string, string> = {};
  const chave = antes?.chaveSistema ?? null;
  const travado = chave ? VENDAVEL_TRAVADO_POR_CHAVE[chave] : undefined;
  if (travado !== undefined && depois.vendavel !== travado)
    erros.vendavel = travado
      ? 'Tipo do sistema: continua vendável (é o padrão de fábrica e pode voltar a ser o padrão das vendas)'
      : 'Tipo do sistema: os cascos vazios não são vendáveis';
  if (chave && CHAVES_TIPO_ESTOQUE_SEMPRE_ATIVAS.includes(chave) && !depois.ativo)
    erros.ativo = 'Tipo do sistema usado pela devolução de cascos do caixa: não se inativa';
  if (antes?.padrao && !depois.padrao)
    erros.padrao = 'Sempre há um tipo padrão: marque "Padrão" em outro tipo para trocar';
  return erros;
}

// ---------------------------------------------------------------- Consulta de saldos (ERP 8.2.11, 16.4 simplificado)

export const SITUACOES_SALDO = ['todos', 'positivo', 'zerado', 'negativo', 'abaixo_minimo'] as const;
export const ROTULOS_SITUACAO_SALDO: Record<(typeof SITUACOES_SALDO)[number], string> = {
  todos: 'Todos',
  positivo: 'Positivo',
  zerado: 'Zerado',
  negativo: 'Negativo',
  abaixo_minimo: 'Abaixo do mínimo',
};

export const ORDENACOES_SALDOS = [
  'produto',
  'codigo_interno',
  'estoque',
  'quantidade',
  'custo_medio',
  'custo_total',
  'venda_total',
] as const;

export const filtroSaldosSchema = paginacaoQuerySchema.extend({
  /** Vazio = todos os estoques visíveis. */
  estoqueId: z.uuid().optional(),
  tipoEstoqueId: z.uuid().optional(),
  nome: z.string().trim().max(120).optional(),
  situacaoSaldo: z.enum(SITUACOES_SALDO).default('todos'),
  situacao: z.enum(['ativos', 'inativos', 'todos']).default('ativos'),
  /** Inclui produtos do estoque sem linha de saldo (saldo zero nunca movimentado). */
  incluirSemMovimento: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type FiltroSaldos = z.infer<typeof filtroSaldosSchema>;

export interface SaldoEstoqueLinha {
  /** Chave da linha: `estoqueId:produtoId:tipoEstoqueId`. */
  chave: string;
  estoqueId: string;
  estoqueNome: string;
  tipoEstoqueId: string | null;
  tipoEstoqueNome: string | null;
  produtoId: string;
  produtoCodigo: number;
  produtoNome: string;
  codigoInterno: string | null;
  unidadeSigla: string;
  quantidade: string;
  /** "Em trânsito" (F2-B26): enviado para o estoque × tipo e ainda não recebido; `'0'` sem nada a caminho. */
  emTransito: string;
  /**
   * "Divergência a tratar" (F2-B26): a diferença recebida a menor, ainda não tratada, das transferências que saíram do
   * estoque × tipo; pendência separada, fora do saldo e do em trânsito. `'0'` sem pendência.
   */
  divergenciaATratar: string;
  estoqueMinimo: string | null;
  /** `null` sem `produtos.ver_custo`. */
  custoMedio: string | null;
  custoTotal: string | null;
  precoVenda: string;
  vendaTotal: string;
  ultimaEntradaEm: string | null;
  ultimaSaidaEm: string | null;
}

export interface PaginaSaldos {
  itens: SaldoEstoqueLinha[];
  total: number;
  pagina: number;
  tamanho: number | 'todos';
  totais: { quantidadeItens: number; custoTotal: string | null; vendaTotal: string };
}
