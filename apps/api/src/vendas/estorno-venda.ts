/**
 * Núcleo do estorno de estoque da venda (SYNC 10.4; MD 7.3; F3-B10, README da API › decisão 228). Separado do handler
 * `venda.cancelada` (`sync/handlers/cancelamento.ts`, forma A) para o cancelamento pelo ERP (F3-B11) e o cancelamento
 * de venda com troca (F3-B44) usarem a mesma regra, sem a cópia divergir:
 * - os movimentos da venda que o cancelamento estorna (`movimentosParaEstornar`): as saídas (`VENDA_PDV`, o casco
 *   cobrado `VASILHAME_VENDIDO`, `BAIXA_INSUMO`) e, com `pdv.cancelamento_devolve_vazios` da loja (`lerDevolveVazios`;
 *   ligada por padrão, D29), a entrada dos vazios trazidos (`VASILHAME_DEVOLVIDO`), só os que ainda não têm estorno;
 * - as linhas de estorno (`linhasDeEstorno`): cada movimento volta com `estorno_de_id`, sinal oposto, ao **custo da
 *   saída original** (T20), no mesmo estoque, tipo, lote e item, na data do cancelamento; a quantidade é a do
 *   movimento, ou, quando o item já teve troca (`itens_venda.quantidade_devolvida`, lida por `quantidadesDevolvidas`),
 *   o **vendido menos o devolvido** calculado por grupo de movimentos do item (`partesDevolvidas`,
 *   `quantidadesAEstornar`: a saída dividida em FEFO soma exatamente o que sobrou, e o devolvido ocupa os lotes na
 *   ordem do id). Item devolvido por inteiro não estorna nada (a troca já deu a entrada, Padrões da Fase 3); hoje
 *   nenhuma venda tem devolução (o `troca.registrada` é do F3-B43), e a conta dá a mesma linha de antes;
 * - o lançamento (`estornarEstoqueDaVenda`): o documento no motor e a compensação do "Definir" (SYNC 15.3) do estorno
 *   anterior à contagem.
 *
 * Quem chama trava a linha da venda (`for update`) antes de ler o devolvido e de lançar: é ela que põe em fila o
 * cancelamento do caixa, o do ERP e a troca da mesma venda.
 */
import { dec, decTexto } from '@genesis/shared';
import { sql } from 'drizzle-orm';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { compensarDefinir } from '../estoques/compensacao.js';
import { lancarDocumento, type MovimentoDoDocumento, type NovoMovimento } from '../estoques/movimentos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

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
 * A nuvem lê o valor da loja da venda na aplicação do cancelamento; o caixa lê a mesma chave na tela (C11b).
 */
export const CHAVE_CANCELAMENTO_DEVOLVE_VAZIOS = 'pdv.cancelamento_devolve_vazios';

/** Os tipos de movimento da venda que o cancelamento estorna (`ESTORNO_DO_MOVIMENTO`, os vazios conforme a chave). */
export function tiposEstornados(devolveVazios: boolean): string[] {
  return Object.keys(ESTORNO_DO_MOVIMENTO).filter((t) => devolveVazios || t !== 'VASILHAME_DEVOLVIDO');
}

/** `pdv.cancelamento_devolve_vazios` da loja (vai na auditoria do cancelamento). */
export async function lerDevolveVazios(tx: DbEmpresa, lojaId: string): Promise<boolean> {
  return (await lerConfiguracao<boolean>(tx, CHAVE_CANCELAMENTO_DEVOLVE_VAZIOS, lojaId)) === true;
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

/**
 * Os movimentos da venda que ainda não têm estorno, dos tipos que o cancelamento estorna. O movimento de estoque é
 * imutável: pode ser lido antes da trava 7300001 (no `preparar` do handler); o estado da venda é conferido de novo
 * com a linha travada.
 */
export async function movimentosParaEstornar(
  tx: DbEmpresa,
  vendaId: string,
  devolveVazios: boolean,
): Promise<MovimentoDaVenda[]> {
  const { rows } = await tx.execute<MovimentoDaVenda>(sql`
    select m.id, m.estoque_id, m.loja_id, m.tipo_estoque_id, m.produto_id, m.variacao_id, m.lote_id, m.tipo_movimento,
           m.quantidade::text, m.custo_unitario::text, m.preco_venda::text, m.unidade_documento, m.fator::text,
           m.pessoa_id, m.documento_item_id
      from movimentos_estoque m
     where m.documento_tipo = 'venda' and m.documento_id = ${vendaId}
       and m.tipo_movimento = any(${`{${tiposEstornados(devolveVazios).join(',')}}`}::text[])
       and m.estorno_de_id is null
       and not exists (select 1 from movimentos_estoque e where e.estorno_de_id = m.id)
     order by m.id`);
  return rows;
}

/** O vendido e o devolvido de um item da venda, na unidade base (`itens_venda.quantidade`, `quantidade_devolvida`). */
export interface QuantidadesItem {
  quantidade: string;
  devolvida: string;
}

/**
 * Os itens da venda que já tiveram troca (`quantidade_devolvida > 0`), pelo id em minúsculas. Os demais estornam o
 * movimento inteiro. Leia com a linha da venda travada: a troca (F3-B43) muda o devolvido com a mesma trava.
 */
export async function quantidadesDevolvidas(
  tx: DbEmpresa,
  vendaId: string,
): Promise<Map<string, QuantidadesItem>> {
  const { rows } = await tx.execute<{ id: string; quantidade: string; devolvida: string }>(sql`
    select i.id, i.quantidade::text as quantidade, i.quantidade_devolvida::text as devolvida
      from itens_venda i
     where i.venda_id = ${vendaId} and i.quantidade_devolvida > 0`);
  return new Map(rows.map((r) => [r.id.toLowerCase(), { quantidade: r.quantidade, devolvida: r.devolvida }]));
}

/** O item da venda com troca do movimento (o devolvido maior que zero), ou `undefined`: o movimento volta inteiro. */
function itemComTroca(
  m: Pick<MovimentoDaVenda, 'documento_item_id'>,
  devolvidos: ReadonlyMap<string, QuantidadesItem>,
): QuantidadesItem | undefined {
  const item = m.documento_item_id ? devolvidos.get(m.documento_item_id.toLowerCase()) : undefined;
  return item && dec(item.devolvida).gt(0) ? item : undefined;
}

/**
 * A parte **devolvida** de cada movimento da venda (sem sinal, 3 casas, na ordem de `movimentos`), a base do estorno do
 * cancelamento (`quantidadesAEstornar`). Um mesmo item pode ter vários movimentos do mesmo tipo e produto: a saída sem
 * lote que o motor divide em FEFO (um movimento por lote e a sobra sem lote, todos com o mesmo `documento_item_id`,
 * `dividirFefo` em `estoques/movimentos.ts`). Por isso a conta é **por grupo** (item, tipo, produto, variação e sinal),
 * não por movimento: o que fica (o estorno) é `soma do grupo × (vendido − devolvido) ÷ vendido`, arredondado **uma**
 * vez a 3 casas, e o devolvido do grupo é o resto (a soma menos o que fica), sem o arredondamento de cada lote somar
 * estoque que não existe (3 lotes de 1 com 1 devolvida dão 2,000, e não 3 × 0,667). O devolvido do grupo ocupa os
 * movimentos **na ordem do id** (cada um até a quantidade dele), o mesmo critério que a troca (F3-B43) usa para o lote
 * da entrada ("o lote dos movimentos da venda de origem", Padrões da Fase 3): com o devolvido acumulado do item, a
 * troca põe a entrada no lote que esta função dá a mais, e o cancelamento estorna os lotes que a troca não devolveu.
 * Item devolvido por inteiro (ou acima) devolve o grupo inteiro; o item sem troca e o bloco de vasilhames (o
 * `documento_item_id` derivado, T4, que não é item) não devolvem nada. Função pura (`estorno-venda.spec.ts`).
 */
export function partesDevolvidas(
  movimentos: readonly Pick<
    MovimentoDaVenda,
    'id' | 'quantidade' | 'documento_item_id' | 'tipo_movimento' | 'produto_id' | 'variacao_id'
  >[],
  devolvidos: ReadonlyMap<string, QuantidadesItem> = new Map(),
): string[] {
  const partes = movimentos.map(() => dec(0));
  const grupos = new Map<string, { item: QuantidadesItem; indices: number[] }>();
  movimentos.forEach((m, i) => {
    const item = itemComTroca(m, devolvidos);
    if (!item) return;
    const chave = [
      m.documento_item_id!.toLowerCase(),
      m.tipo_movimento,
      m.produto_id.toLowerCase(),
      m.variacao_id?.toLowerCase() ?? '',
      dec(m.quantidade).isNeg() ? '-' : '+',
    ].join('|');
    const grupo = grupos.get(chave) ?? { item, indices: [] };
    grupo.indices.push(i);
    grupos.set(chave, grupo);
  });
  for (const { item, indices } of grupos.values()) {
    const total = indices.reduce((s, i) => s.plus(dec(movimentos[i]!.quantidade).abs()), dec(0));
    const vendido = dec(item.quantidade);
    const restante = vendido.minus(item.devolvida);
    const fica =
      vendido.lte(0) || restante.lte(0) ? dec(0) : dec(decTexto(total.times(restante).div(vendido), 3));
    let aDevolver = total.minus(fica);
    const emOrdem = [...indices].sort((a, b) => {
      const ia = movimentos[a]!.id.toLowerCase();
      const ib = movimentos[b]!.id.toLowerCase();
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
    for (const i of emOrdem) {
      const quantidade = dec(movimentos[i]!.quantidade).abs();
      const parte = quantidade.lt(aDevolver) ? quantidade : aDevolver;
      partes[i] = parte;
      aDevolver = aDevolver.minus(parte);
    }
  }
  return partes.map((p) => decTexto(p, 3));
}

/**
 * A quantidade do estorno de cada movimento (sinal oposto ao do movimento, 3 casas, na ordem de `movimentos`): o
 * movimento menos a parte devolvida dele (`partesDevolvidas`). Sem troca, o movimento inteiro; no item com troca, o
 * grupo dá exatamente o que sobrou dele — o `VENDA_PDV` do item o vendido menos o devolvido, o `BAIXA_INSUMO` a parte
 * dos insumos do que não voltou, porque o produzido devolvido não devolve os insumos (Padrões da Fase 3), um
 * arredondamento só para o grupo. `'0.000'` = nada a estornar (o movimento que a troca devolveu inteiro). Função pura
 * (`estorno-venda.spec.ts`).
 */
export function quantidadesAEstornar(
  movimentos: readonly Pick<
    MovimentoDaVenda,
    'id' | 'quantidade' | 'documento_item_id' | 'tipo_movimento' | 'produto_id' | 'variacao_id'
  >[],
  devolvidos: ReadonlyMap<string, QuantidadesItem> = new Map(),
): string[] {
  const partes = partesDevolvidas(movimentos, devolvidos);
  return movimentos.map((m, i) => {
    const q = dec(m.quantidade);
    const fica = q.abs().minus(partes[i]!);
    return decTexto(q.isNeg() ? fica : fica.neg(), 3);
  });
}

/** Quem estorna e quando: a data do cancelamento, o usuário e, no caixa, o terminal e o evento. */
export interface OrigemEstorno {
  documentoId: string;
  dataMovimento: Date;
  usuarioId: string | null;
  terminalId: string | null;
  eventoId: string | null;
}

/**
 * Os estornos do estoque (SYNC 10.4): cada saída volta ao custo dela, na data do cancelamento; a entrada dos vazios
 * trazidos sai ao custo médio da linha (o motor ignora o custo informado na saída). O movimento sem nada a estornar
 * (item devolvido por inteiro) fica de fora. Função pura (`estorno-venda.spec.ts`).
 */
export function linhasDeEstorno(
  movimentos: readonly MovimentoDaVenda[],
  origem: OrigemEstorno,
  devolvidos: ReadonlyMap<string, QuantidadesItem> = new Map(),
): NovoMovimento[] {
  const quantidades = quantidadesAEstornar(movimentos, devolvidos);
  return movimentos.flatMap((m, i) => {
    const quantidade = quantidades[i]!;
    if (dec(quantidade).isZero()) return [];
    return [
      {
        estoqueId: m.estoque_id,
        produtoId: m.produto_id,
        variacaoId: m.variacao_id,
        tipoEstoqueId: m.tipo_estoque_id,
        tipoMovimento: ESTORNO_DO_MOVIMENTO[m.tipo_movimento]!,
        quantidade,
        // T20: ao custo da saída original (com saldo positivo recalcula a média; com zero ou negativo a mantém).
        custoUnitario: m.custo_unitario,
        custoReferencia: m.custo_unitario,
        precoVenda: m.preco_venda,
        dataMovimento: origem.dataMovimento,
        lojaId: m.loja_id,
        usuarioId: origem.usuarioId,
        documentoTipo: 'venda',
        documentoId: origem.documentoId,
        documentoItemId: m.documento_item_id,
        unidadeDocumento: m.unidade_documento,
        fator: m.fator,
        loteId: m.lote_id,
        pessoaId: m.pessoa_id,
        terminalId: origem.terminalId,
        eventoId: origem.eventoId,
        estornoDeId: m.id,
      },
    ];
  });
}

/** O estorno lançado: os movimentos e as compensações do "Definir" (SYNC 15.3). */
export interface EstornoLancado {
  movimentos: MovimentoDoDocumento[];
  compensacoes: MovimentoDoDocumento[];
}

/**
 * Lança o estorno no motor (as linhas de saldo travadas em ordem estável) e compensa o "Definir" efetivado depois da
 * data do cancelamento (15.3), na mesma transação. `documento` vai na observação da compensação.
 */
export async function estornarEstoqueDaVenda(
  tx: DbEmpresa,
  linhas: readonly NovoMovimento[],
  documento = 'cancelamento de venda',
): Promise<EstornoLancado> {
  const doc = await lancarDocumento(tx, linhas);
  const compensacoes = await compensarDefinir(tx, doc.movimentos, documento);
  return { movimentos: doc.movimentos, compensacoes };
}
