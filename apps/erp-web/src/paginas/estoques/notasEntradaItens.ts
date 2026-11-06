/**
 * Contas e regras da aba "Itens e vinculação" da NF-e (ERP 13.4.1; Fase 2, F2-B20; README do ERP › decisão 61), sem
 * React: a linha da tela a partir do item da API (o vínculo gravado ou, sem ele, a sugestão de agora já preenchida e
 * com o fator **por confirmar**), a origem do vínculo, o destaque do fator que diverge do vínculo aprendido, a
 * quantidade no estoque e o custo de entrada (as mesmas contas do shared), o markup ⇄ preço como no recebimento e o
 * corpo do `PUT /notas-entrada/:id/itens`.
 */
import {
  baseMarkupRecebimentoTexto,
  custoEntradaItemNfeTexto,
  dec,
  markupPrecoRecebimento,
  quantidadeEstoqueNfeTexto,
  type AtualizarPrecoRecebimento,
  type DadosCompraProduto,
  type ItemNotaEntradaDetalhe,
  type NotaEntradaDetalhe,
  type OrigemVinculoNfe,
  type ProdutoOpcao,
} from '@genesis/shared';
import { dataDaGrade, dataParaGrade, formatarDecimal, textoDecimal } from '../../componentes/grade/decimal';

export interface LinhaVinculo {
  id: string;
  produto: ProdutoOpcao | null;
  /** Embalagem de compra (o EAN do fardo); `null` = a unidade do produto ou um fator digitado. */
  codigoBarrasId: string | null;
  /** Como digitado (pt-BR). */
  fator: string;
  fatorConfirmado: boolean;
  lote: string;
  /** `dd/mm/aaaa`. */
  validade: string;
  fabricacao: string;
  precoVenda: string;
  /** Markup digitado: o preço acompanha a base; `null` = vale o preço digitado (o último digitado vale). */
  markup: string | null;
  atualizarPreco: AtualizarPrecoRecebimento;
  ignorado: boolean;
  motivoIgnorado: string;
}

/** Decimal da API ("12.000") para o campo ("12"). */
export const paraCampo = (v: string | null | undefined, casas = 4) =>
  v === null || v === undefined ? '' : formatarDecimal(Number(v), casas).replace(/\./g, '');

/** O fator que o item sugere quando o usuário escolhe o produto à mão: qTrib/qCom (a caixa de 12), senão 1. */
const fatorManual = (item: ItemNotaEntradaDetalhe) => item.fatorTributavel ?? '1';

/**
 * A linha da tela: o vínculo gravado (com o fator confirmado ou não) ou, sem produto gravado, a sugestão de agora (o
 * vínculo anterior ou o EAN) já preenchida, com o fator por confirmar; sem sugestão, o fator pelas quantidades do XML.
 */
export function linhaDoItem(item: ItemNotaEntradaDetalhe): LinhaVinculo {
  const base = {
    id: item.id,
    lote: item.lote ?? '',
    validade: dataParaGrade(item.validade),
    fabricacao: dataParaGrade(item.fabricacao),
    // O preço gravado vale (o markup é recalculado sobre a base de agora), como no rascunho do recebimento.
    precoVenda: paraCampo(item.precoVenda),
    markup: null,
    atualizarPreco: item.atualizarPreco,
    ignorado: item.ignorado,
    motivoIgnorado: item.motivoIgnorado ?? '',
  };
  if (item.produtoId || item.ignorado)
    return {
      ...base,
      produto: item.produto,
      codigoBarrasId: item.codigoBarrasId,
      fator: paraCampo(item.fator, 3),
      fatorConfirmado: item.fatorConfirmado,
    };
  const s = item.sugestao;
  return {
    ...base,
    produto: s?.produto ?? null,
    codigoBarrasId: s?.codigoBarrasId ?? null,
    fator: paraCampo(s?.fator ?? fatorManual(item), 3),
    fatorConfirmado: false,
  };
}

/**
 * O produto escolhido (ou cadastrado) para a linha: o fator volta ao da sugestão (quando é o produto dela), ao do
 * vínculo aprendido ou ao das quantidades do XML, e precisa de nova confirmação.
 */
export function trocarProduto(
  l: LinhaVinculo,
  item: ItemNotaEntradaDetalhe,
  produto: ProdutoOpcao | null,
): LinhaVinculo {
  const s = item.sugestao;
  const daSugestao = produto && s && s.produtoId === produto.id;
  const doVinculo =
    produto && item.vinculoAnterior?.produtoId === produto.id ? item.vinculoAnterior.fator : null;
  return {
    ...l,
    produto,
    codigoBarrasId: daSugestao ? s.codigoBarrasId : null,
    fator: paraCampo(daSugestao ? s.fator : (doVinculo ?? fatorManual(item)), 3),
    fatorConfirmado: false,
  };
}

/** O fator digitado em decimal com ponto (`null` = inválido ou ≤ 0). */
export function fatorDaLinha(l: LinhaVinculo): string | null {
  const f = textoDecimal(l.fator);
  return f !== null && dec(f).gt(0) ? f : null;
}

/** A origem do vínculo da linha: a sugestão que ela segue (mesmo produto e fator) ou "manual"; `null` sem produto. */
export function origemDaLinha(l: LinhaVinculo, item: ItemNotaEntradaDetalhe): OrigemVinculoNfe | null {
  if (l.ignorado || !l.produto) return null;
  const s = item.sugestao;
  const f = fatorDaLinha(l);
  return s && s.produtoId === l.produto.id && f !== null && dec(f).eq(s.fator) ? s.origem : 'manual';
}

/**
 * O destaque do fator (ERP 13.4.1): o vínculo aprendido com o fornecedor para este cProd é deste produto, mas com
 * outro fator. Devolve o fator aprendido, ou `null` sem divergência.
 */
export function fatorDivergente(l: LinhaVinculo, item: ItemNotaEntradaDetalhe): string | null {
  const v = item.vinculoAnterior;
  const f = fatorDaLinha(l);
  if (l.ignorado || !l.produto || !v || v.produtoId !== l.produto.id || f === null) return null;
  return dec(f).eq(v.fator) ? null : v.fator;
}

/**
 * O fator da linha diverge do que as quantidades do próprio XML dizem (qTrib/qCom, `fatorTributavel`): a caixa de 12
 * latas vinculada com fator 1 entraria 10 em vez de 120. Devolve o fator da nota, ou `null` sem divergência (ou sem
 * qTrib, ou com qTrib = qCom, em que o fator da embalagem vale sozinho).
 */
export function fatorDivergeDaNota(l: LinhaVinculo, item: ItemNotaEntradaDetalhe): string | null {
  const t = item.fatorTributavel;
  const f = fatorDaLinha(l);
  if (l.ignorado || !l.produto || t === null || f === null || dec(t).eq(1)) return null;
  return dec(f).eq(t) ? null : t;
}

/** A linha que "Fator confirmado" e "Confirmar todos os fatores" aceitam: com produto e um fator válido. */
export const linhaConfirmavel = (l: LinhaVinculo) => !l.ignorado && !!l.produto && fatorDaLinha(l) !== null;

/**
 * "Desfazer" o ignorar: a linha volta como estava antes de ignorar (ignorar não apaga o produto, o fator nem a
 * confirmação dela). Só o item que já veio ignorado do servidor (sem produto na linha) volta pela sugestão de agora,
 * com o lote do rastro que estava na linha.
 */
export function desfazerIgnorar(l: LinhaVinculo, item: ItemNotaEntradaDetalhe): LinhaVinculo {
  if (l.produto || !item.ignorado) return { ...l, ignorado: false, motivoIgnorado: '' };
  return {
    ...linhaDoItem({ ...item, ignorado: false, produtoId: null }),
    motivoIgnorado: '',
    lote: l.lote,
    validade: l.validade,
    fabricacao: l.fabricacao,
  };
}

/** O vínculo aprendido é de **outro** produto (o usuário escolheu um diferente do que o fornecedor costuma mandar). */
export const produtoDiverge = (l: LinhaVinculo, item: ItemNotaEntradaDetalhe) =>
  !l.ignorado && !!l.produto && !!item.vinculoAnterior && item.vinculoAnterior.produtoId !== l.produto.id;

export interface ContasVinculo {
  /** qCom × fator. */
  quantidadeEstoque: string;
  /** Custo de entrada por unidade do produto (4 casas). */
  custo: string;
  /** Base do markup (`produtos.custo_base_margem`, D49). */
  base: string;
  precoVenda: string | null;
  markupPct: string | null;
}

/** Quantidade no estoque, custo de entrada e preço ⇄ markup da linha com produto e fator válido. */
export function contasDaLinha(
  l: LinhaVinculo,
  item: ItemNotaEntradaDetalhe,
  config: NotaEntradaDetalhe['vinculacao'],
  dados: DadosCompraProduto | undefined,
): ContasVinculo | null {
  const f = fatorDaLinha(l);
  if (l.ignorado || !l.produto || f === null) return null;
  const quantidadeEstoque = quantidadeEstoqueNfeTexto(item.quantidadeComercial, f);
  // Na nota movimentada, o custo gravado (o das chaves de quando a nota entrou); antes, a prévia com as de agora.
  const custo = item.custoUnitario ?? custoEntradaItemNfeTexto(item, quantidadeEstoque, config.parcelasCusto);
  const base = baseMarkupRecebimentoTexto({
    base: config.custoBaseMargem,
    compraAtualizaPrecoCusto: config.compraAtualizaPrecoCusto,
    custoFinal: custo,
    quantidadeEstoque,
    precoCusto: l.produto.precoCusto,
    saldo: dados?.saldo ?? null,
    custoMedio: dados?.custoMedio ?? null,
  });
  const pm = markupPrecoRecebimento(base, {
    precoVenda: textoDecimal(l.precoVenda),
    markup: textoDecimal(l.markup ?? ''),
  });
  return { quantidadeEstoque, custo, base, ...pm };
}

/** Teto do `markupPct` no contrato do item. */
const MAXIMO_MARKUP = 99_999;

/**
 * O item do `PUT` (`itemVinculacaoNfeSchema`): o fator como digitado (o zod aceita a vírgula), o preço e o markup já
 * resolvidos, as datas em `AAAA-MM-DD` e "Atualizar preço" = "não" sem a permissão (a mudança seria recusada ao
 * movimentar). A linha ignorada leva só o motivo.
 */
export function linhaParaApi(
  l: LinhaVinculo,
  contas: ContasVinculo | null,
  podeAlterarPreco: boolean,
): Record<string, unknown> {
  const data = (t: string) => dataDaGrade(t) ?? (t.trim() ? t : null);
  if (l.ignorado) return { id: l.id, ignorado: true, motivoIgnorado: l.motivoIgnorado };
  const markup = contas?.markupPct ?? null;
  return {
    id: l.id,
    produtoId: l.produto?.id ?? null,
    codigoBarrasId: l.produto ? l.codigoBarrasId : null,
    fator: l.fator,
    fatorConfirmado: l.fatorConfirmado && !!l.produto,
    lote: l.lote,
    validade: data(l.validade),
    fabricacao: data(l.fabricacao),
    markupPct: markup !== null && dec(markup).abs().lte(MAXIMO_MARKUP) ? markup : null,
    precoVenda: contas?.precoVenda ?? null,
    atualizarPreco: podeAlterarPreco ? l.atualizarPreco : 'nao',
  };
}

/** Itens resolvidos da tela (o mesmo critério da nota "pronta"): ignorados, ou com produto e o fator confirmado. */
export const linhaResolvida = (l: LinhaVinculo) => l.ignorado || (!!l.produto && l.fatorConfirmado);
