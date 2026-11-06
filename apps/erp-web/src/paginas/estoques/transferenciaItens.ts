import {
  dec,
  quantidadeEmEmbalagens,
  type DadosProdutosTransferencia,
  type EmbalagemTransferencia,
  type ItemSugestaoReposicao,
  type ItemTransferenciaDetalhe,
  type ProdutoOpcao,
  type StatusTransferencia,
  type TipoProduto,
  type TratamentoDivergenciaTransferencia,
} from '@genesis/shared';
import { formatarDecimal, textoDecimal } from '../../componentes/grade/decimal';

/**
 * Regras puras das telas da transferência (ERP 13.7; Fase 2, F2-B27; README do ERP › decisão 64): a linha da grade
 * do rascunho, os botões por situação e permissão (as transições do diagrama, com as mesmas conferências da API), a
 * sugestão de reposição mesclada na grade, a conferência do recebimento e o tratamento da diferença, e a quantidade em
 * embalagens do romaneio. Ficam aqui para o teste unitário (`Transferencias.test.tsx`).
 */

/** Tipos com saldo próprio que a transferência aceita (sem combo, serviço, produzido e "Com variações", D43). */
export const TIPOS_TRANSFERENCIA: readonly TipoProduto[] = [
  'simples',
  'materia_prima',
  'vasilhame',
  'com_complementos',
];

const qtd = (v: string | number) => formatarDecimal(Number(v), 3);
/** Decimal da API ("60.000") para o campo ("60"). */
export const quantidadeParaTela = (v: string | null | undefined) =>
  v === null || v === undefined ? '' : formatarDecimal(Number(v), 3).replace(/\./g, '');

// ---------------------------------------------------------------- Grade do rascunho

export interface LinhaTransferencia {
  chave: string;
  /** Item gravado; `null` = linha nova. */
  id: string | null;
  produto: ProdutoOpcao | null;
  /** Lote escolhido; vazio = o envio baixa em FEFO. */
  loteId: string;
  /** Quantidade enviada como digitada (vírgula decimal). */
  quantidade: string;
  // Colunas só de exibição (a chave da coluna é um campo da linha).
  embalagem?: undefined;
  saldoOrigem?: undefined;
  recebida?: undefined;
  diferenca?: undefined;
  tratamento?: undefined;
  custo?: undefined;
}

let seq = 0;
export const novaLinhaTransferencia = (): LinhaTransferencia => ({
  chave: `nova-${++seq}`,
  id: null,
  produto: null,
  loteId: '',
  quantidade: '',
});

export const linhaVaziaTransferencia = (l: LinhaTransferencia) => !l.produto && !l.quantidade.trim();

/** A linha da grade no corpo do `POST`/`PUT` (`itemTransferenciaSchema`). */
export function itemTransferenciaParaApi(l: LinhaTransferencia) {
  return {
    id: l.id,
    produtoId: l.produto?.id ?? '',
    variacaoId: null,
    loteId: l.loteId || null,
    quantidade: textoDecimal(l.quantidade) ?? l.quantidade,
  };
}

/** Coluna da grade de cada campo de erro da API (`itens.N.campo`). */
export const COLUNA_DO_CAMPO_TRANSFERENCIA: Record<string, keyof LinhaTransferencia> = {
  id: 'produto',
  produtoId: 'produto',
  variacaoId: 'produto',
  loteId: 'loteId',
  quantidade: 'quantidade',
};

/** Erros da linha antes de gravar (a API confere de novo, com o saldo no envio). */
export function errosLinhaTransferencia(
  l: LinhaTransferencia,
): Partial<Record<keyof LinhaTransferencia, string>> {
  const e: Partial<Record<keyof LinhaTransferencia, string>> = {};
  if (!l.produto) e.produto = 'Escolha o produto';
  else if (!TIPOS_TRANSFERENCIA.includes(l.produto.tipo)) e.produto = 'Tipo de produto sem estoque próprio';
  else if (!l.produto.controlaEstoque) e.produto = 'Produto sem controle de estoque';
  const q = textoDecimal(l.quantidade);
  if (q === null || !dec(q).gt(0)) e.quantidade = 'Quantidade maior que zero';
  else if (l.produto && !l.produto.permiteFracao && !dec(q).isInteger())
    e.quantidade = 'O produto não aceita quantidade fracionada';
  return e;
}

/** Ids dos produtos em blocos (o contrato aceita 200 por consulta; a transferência, até 990 itens). */
export const BLOCO_DADOS_TRANSFERENCIA = 100;

export async function dadosTransferenciaEmBlocos(
  produtoIds: readonly string[],
  buscar: (ids: string[]) => Promise<DadosProdutosTransferencia>,
): Promise<DadosProdutosTransferencia> {
  const blocos: string[][] = [];
  for (let i = 0; i < produtoIds.length; i += BLOCO_DADOS_TRANSFERENCIA)
    blocos.push(produtoIds.slice(i, i + BLOCO_DADOS_TRANSFERENCIA));
  const partes = await Promise.all(blocos.map((b) => buscar(b)));
  return { produtos: partes.flatMap((p) => p.produtos) };
}

/**
 * "Sugerir reposição" (ERP 13.7) na grade: o produto já na grade sem lote recebe a quantidade sugerida; o que não
 * está entra numa linha nova; as outras linhas (inclusive as com lote) ficam. Termina com uma linha vazia.
 */
export function mesclarSugestao(
  linhas: readonly LinhaTransferencia[],
  sugeridos: readonly ItemSugestaoReposicao[],
): { linhas: LinhaTransferencia[]; atualizados: number; novos: number } {
  const resultado = linhas.filter((l) => !linhaVaziaTransferencia(l)).map((l) => ({ ...l }));
  let atualizados = 0;
  let novos = 0;
  for (const s of sugeridos) {
    const quantidade = quantidadeParaTela(s.quantidade);
    const existente = resultado.find((l) => l.produto?.id === s.produtoId && !l.loteId);
    if (existente) {
      existente.quantidade = quantidade;
      atualizados++;
    } else {
      resultado.push({ ...novaLinhaTransferencia(), produto: s.produto, quantidade });
      novos++;
    }
  }
  return { linhas: [...resultado, novaLinhaTransferencia()], atualizados, novos };
}

// ---------------------------------------------------------------- Botões por situação e permissão

export type AcaoTransferencia =
  'salvar' | 'excluir' | 'sugerir' | 'enviar' | 'cancelar' | 'receber' | 'tratar' | 'nfe' | 'romaneio';

export interface ContextoAcoesTransferencia {
  novo: boolean;
  /** Há alteração não salva no rascunho (o "Salvar e enviar" precisa gravar antes). */
  sujo: boolean;
  pode: (permissao: string) => boolean;
  /** A origem entre os estoques permitidos de quem está na tela (no rascunho novo, o seletor só mostra os dela). */
  origemPermitida: boolean;
  destinoPermitido: boolean;
}

/**
 * Os botões da tela (ERP 13.7), as transições do diagrama com as conferências da API (README da API › decisões 171 e
 * 172): **rascunho** — Salvar, Excluir, Sugerir reposição e Enviar com `transferencias.criar`/`enviar` e a origem
 * permitida (enviar o rascunho novo ou alterado grava antes, então pede também `criar`), Cancelar com
 * `transferencias.cancelar`; **em trânsito** — Receber (`transferencias.receber` e o destino permitido) e Cancelar o
 * envio (a origem); **recebida com divergência** — Tratar a diferença (`transferencias.receber` e a origem ou o
 * destino); a NF-e de fora depois do envio (menos na cancelada) com `transferencias.enviar` e a origem; o romaneio em
 * qualquer situação do documento gravado. Recebida e cancelada não têm transição.
 */
export function acoesTransferencia(
  status: StatusTransferencia,
  ctx: ContextoAcoesTransferencia,
): Set<AcaoTransferencia> {
  const a = new Set<AcaoTransferencia>();
  const origem = ctx.novo || ctx.origemPermitida;
  if (status === 'rascunho') {
    if (ctx.pode('transferencias.criar') && origem) {
      a.add('salvar');
      a.add('sugerir');
      if (!ctx.novo) a.add('excluir');
    }
    if (
      ctx.pode('transferencias.enviar') &&
      origem &&
      (ctx.pode('transferencias.criar') || (!ctx.novo && !ctx.sujo))
    )
      a.add('enviar');
    if (!ctx.novo && ctx.pode('transferencias.cancelar') && ctx.origemPermitida) a.add('cancelar');
  }
  if (status === 'em_transito') {
    if (ctx.pode('transferencias.receber') && ctx.destinoPermitido) a.add('receber');
    if (ctx.pode('transferencias.cancelar') && ctx.origemPermitida) a.add('cancelar');
  }
  if (
    status === 'recebida_divergencia' &&
    ctx.pode('transferencias.receber') &&
    (ctx.origemPermitida || ctx.destinoPermitido)
  )
    a.add('tratar');
  if (
    !ctx.novo &&
    status !== 'rascunho' &&
    status !== 'cancelada' &&
    ctx.pode('transferencias.enviar') &&
    ctx.origemPermitida
  )
    a.add('nfe');
  if (!ctx.novo) a.add('romaneio');
  return a;
}

// ---------------------------------------------------------------- Receber (conferência)

export interface LinhaConferencia {
  /** O id do item. */
  chave: string;
  item: ItemTransferenciaDetalhe;
  /** A recebida como digitada; começa com a enviada (o conferente corrige o que faltou). */
  recebida: string;
  // Colunas só de exibição.
  produto?: undefined;
  enviada?: undefined;
  diferenca?: undefined;
}

export const linhasConferencia = (itens: readonly ItemTransferenciaDetalhe[]): LinhaConferencia[] =>
  itens.map((i) => ({ chave: i.id, item: i, recebida: quantidadeParaTela(i.quantidadeEnviada) }));

export function errosConferencia(l: LinhaConferencia): Partial<Record<'recebida', string>> {
  const q = textoDecimal(l.recebida);
  if (q === null) return { recebida: 'Informe a quantidade recebida (0 se não chegou)' };
  if (dec(q).lt(0)) return { recebida: 'Quantidade inválida' };
  if (dec(q).gt(l.item.quantidadeEnviada))
    return {
      recebida: `Acima da enviada (${qtd(l.item.quantidadeEnviada)}): para mandar mais, faça outra transferência`,
    };
  if (!l.item.produto.permiteFracao && !dec(q).isInteger())
    return { recebida: 'O produto não aceita quantidade fracionada' };
  return {};
}

/** Diferença da linha (enviada − recebida), `null` com a recebida inválida. */
export function diferencaConferencia(l: LinhaConferencia): string | null {
  const q = textoDecimal(l.recebida);
  return q === null ? null : dec(l.item.quantidadeEnviada).minus(q).toFixed(3);
}

/** O corpo do `POST /transferencias/:id/receber` com a quantidade conferida de **cada** item. */
export const corpoConferencia = (linhas: readonly LinhaConferencia[], versao: number) => ({
  versao,
  receberTudo: false,
  itens: linhas.map((l) => ({
    itemId: l.item.id,
    quantidadeRecebida: textoDecimal(l.recebida) ?? l.recebida,
  })),
});

// ---------------------------------------------------------------- Tratar a diferença

export interface LinhaTratamento {
  chave: string;
  item: ItemTransferenciaDetalhe;
  tratamento: TratamentoDivergenciaTransferencia | '';
  // Colunas só de exibição.
  produto?: undefined;
  enviada?: undefined;
  recebida?: undefined;
  diferenca?: undefined;
}

/** Os itens com diferença ainda sem tratamento (cada um se trata uma vez). */
export const itensATratar = (itens: readonly ItemTransferenciaDetalhe[]) =>
  itens.filter((i) => dec(i.diferenca).gt(0) && !i.tratamentoDivergencia);

export const linhasTratamento = (itens: readonly ItemTransferenciaDetalhe[]): LinhaTratamento[] =>
  itensATratar(itens).map((i) => ({ chave: i.id, item: i, tratamento: '' }));

/** O corpo do `POST /transferencias/:id/tratar-divergencia`: só as linhas com o tratamento escolhido (parcial vale). */
export const corpoTratamento = (linhas: readonly LinhaTratamento[], versao: number) => ({
  versao,
  itens: linhas
    .filter((l) => l.tratamento)
    .map((l) => ({ itemId: l.item.id, tratamento: l.tratamento as TratamentoDivergenciaTransferencia })),
});

// ---------------------------------------------------------------- Embalagem (grade e romaneio)

/** "FD × 12" (a embalagem de compra) ou a sigla da unidade. */
export const rotuloEmbalagem = (emb: EmbalagemTransferencia | null, unidade: string) =>
  emb ? `${emb.unidadeSigla ?? 'Emb.'} × ${qtd(emb.fator)}` : unidade;

/** "5 FD + 3 UN" (fardos fechados e avulsas); sem embalagem, "63 UN". */
export function quantidadeNaEmbalagem(
  quantidade: string | number,
  emb: EmbalagemTransferencia | null,
  unidade: string,
): string {
  const { embalagens, avulsas } = quantidadeEmEmbalagens(String(quantidade), emb?.fator);
  const partes: string[] = [];
  if (embalagens > 0) partes.push(`${formatarDecimal(embalagens, 0)} ${emb?.unidadeSigla ?? 'emb.'}`);
  if (dec(avulsas).gt(0) || !partes.length) partes.push(`${qtd(avulsas)} ${unidade}`);
  return partes.join(' + ');
}
