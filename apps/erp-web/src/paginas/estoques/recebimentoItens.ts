/**
 * Contas e regras da grade do recebimento manual (ERP 13.3; Fase 2, F2-B16), sem React: as linhas da tela (texto
 * digitado em pt-BR) → quantidade no estoque, total, rateio e custo final (as mesmas contas do shared que a API usa ao
 * movimentar), o markup ⇄ preço de venda sobre a base de `produtos.custo_base_margem` (D49), a validação por linha e o
 * corpo da API.
 */
import {
  baseMarkupRecebimentoTexto,
  contasEntradaRecebimentoTexto,
  dec,
  markupPrecoRecebimento,
  valoresItemRecebimentoTexto,
  type AtualizarPrecoRecebimento,
  type DadosCompraProduto,
  type DadosCompraProdutos,
  type ProdutoOpcao,
  type TipoProduto,
} from '@genesis/shared';
import { dataDaGrade, textoDecimal } from '../../componentes/grade/decimal';

/** Os tipos que o recebimento aceita (a API recusa combo, serviço, produzido e "Com variações"; D43). */
export const TIPOS_RECEBIMENTO: readonly TipoProduto[] = [
  'simples',
  'materia_prima',
  'vasilhame',
  'com_complementos',
];

export interface LinhaRecebimento {
  chave: string;
  /** Item já gravado; `null` = novo. */
  id: string | null;
  produto: ProdutoOpcao | null;
  /** Embalagem de compra escolhida (o EAN do fardo); `null` = a unidade do produto ou um fator digitado. */
  codigoBarrasId: string | null;
  fator: string;
  quantidade: string;
  precoCompra: string;
  /** Preço de venda digitado (vale quando `markup` está vazio). */
  precoVenda: string;
  /**
   * Markup digitado: o preço passa a acompanhar a base (o último digitado vale, ERP 13.3). `null` = vale o preço
   * digitado e o markup é calculado; `''` = o campo do markup apagado (ainda sem valor, vale o preço).
   */
  markup: string | null;
  /** `null` = ainda não respondido: o "Salvar" pergunta quando o preço mudou. */
  atualizarPreco: AtualizarPrecoRecebimento | null;
  lote: string;
  /** `dd/mm/aaaa`. */
  validade: string;
  fabricacao: string;
  // Colunas só de exibição (a chave da coluna é um campo da linha).
  qtdEstoque?: undefined;
  total?: undefined;
  rateio?: undefined;
  custoFinal?: undefined;
}

export interface CabecalhoContas {
  valorFrete: string;
  valorDesconto: string;
  valorOutrasDespesas: string;
  temValidade: boolean;
}

let sequencia = 0;
export const novaLinhaRecebimento = (): LinhaRecebimento => ({
  chave: `n${++sequencia}`,
  id: null,
  produto: null,
  codigoBarrasId: null,
  fator: '1',
  quantidade: '',
  precoCompra: '',
  precoVenda: '',
  markup: null,
  atualizarPreco: null,
  lote: '',
  validade: '',
  fabricacao: '',
});

export const linhaVazia = (l: LinhaRecebimento) =>
  !l.produto && !l.quantidade.trim() && !l.precoCompra.trim() && !l.lote.trim();

/** Teto do `markupPct` no contrato do item. */
const MAXIMO_MARKUP = 99_999;

/** Texto da tela em decimal com ponto; inválido ou vazio = `'0'` (só para as contas de exibição). */
const num = (t: string) => textoDecimal(t) ?? '0';

/** Contas de exibição de cada linha preenchida (na ordem das linhas): as mesmas do movimentar. */
export interface ContasLinha {
  quantidadeEstoque: string;
  valorTotal: string;
  /** Frete + outras despesas − desconto rateados no item. */
  rateio: string;
  /** Por unidade do produto, 4 casas. */
  custoFinal: string;
}

/**
 * Quantidade no estoque, total, rateio e custo final das linhas com produto (as demais ficam sem contas): o rateio é
 * pelo total de cada item entre as linhas com produto, como a API faz com os itens gravados (`contasEntradaRecebimento`).
 */
export function contasDasLinhas(
  linhas: readonly LinhaRecebimento[],
  cab: CabecalhoContas,
): Map<string, ContasLinha> {
  const comProduto = linhas.filter((l) => l.produto);
  const itens = comProduto.map((l) => ({
    quantidade: num(l.quantidade),
    fator: num(l.fator),
    precoCompra: num(l.precoCompra),
  }));
  const contas = contasEntradaRecebimentoTexto(itens, {
    valorFrete: num(cab.valorFrete),
    valorDesconto: num(cab.valorDesconto),
    valorOutrasDespesas: num(cab.valorOutrasDespesas),
  });
  return new Map(
    comProduto.map((l, i) => {
      const v = valoresItemRecebimentoTexto(itens[i]!);
      const c = contas[i]!;
      return [
        l.chave,
        {
          quantidadeEstoque: v.quantidadeEstoque,
          valorTotal: v.valorTotal,
          rateio: dec(c.rateioFrete).plus(c.rateioOutras).minus(c.rateioDesconto).toFixed(2),
          custoFinal: c.custoUnitarioFinal,
        },
      ];
    }),
  );
}

/** Preço e markup da linha sobre a base da chave `produtos.custo_base_margem` (D49). */
export function precoEMarkup(
  l: LinhaRecebimento,
  contas: ContasLinha | undefined,
  dados: Pick<DadosCompraProdutos, 'custoBaseMargem' | 'compraAtualizaPrecoCusto'> | undefined,
  produto: DadosCompraProduto | undefined,
): { base: string; precoVenda: string | null; markupPct: string | null } {
  const base = baseMarkupRecebimentoTexto({
    base: dados?.custoBaseMargem ?? 'preco_custo',
    compraAtualizaPrecoCusto: dados?.compraAtualizaPrecoCusto ?? 'perguntar',
    custoFinal: contas?.custoFinal ?? '0',
    quantidadeEstoque: contas?.quantidadeEstoque ?? '0',
    precoCusto: l.produto?.precoCusto ?? null,
    saldo: produto?.saldo ?? null,
    custoMedio: produto?.custoMedio ?? null,
  });
  const r = markupPrecoRecebimento(base, {
    precoVenda: textoDecimal(l.precoVenda),
    markup: textoDecimal(l.markup ?? ''),
  });
  return { base, ...r };
}

/**
 * Preço de venda atual do produto **na loja do recebimento**: o próprio da loja (`produtos_lojas`) ou, sem ele, o geral.
 * É a proposta do item e a referência da pergunta geral/loja/não, como o movimentar compara o "só da loja".
 */
export function precoAtualNaLoja(l: LinhaRecebimento, d: DadosCompraProduto | undefined): string | null {
  return d?.precoVendaLoja ?? l.produto?.precoVenda ?? null;
}

/** O preço proposto difere do preço de venda atual na loja (a pergunta geral/loja/não). */
export function precoAlterado(
  l: LinhaRecebimento,
  precoVenda: string | null,
  d: DadosCompraProduto | undefined,
): boolean {
  const atual = precoAtualNaLoja(l, d);
  return atual !== null && precoVenda !== null && !dec(precoVenda).eq(dec(atual));
}

/**
 * Produtos por consulta da tela a `GET /recebimentos/dados-produtos`: metade do teto do contrato
 * (`LIMITE_PRODUTOS_DADOS_COMPRA`), para a URL com os ids (37 caracteres cada) ficar abaixo de 4 KB, longe do buffer de
 * cabeçalho padrão do nginx (8 KB). O recebimento aceita até 990 itens.
 */
export const BLOCO_DADOS_COMPRA = 100;

/**
 * Dados de compra de qualquer quantidade de produtos: consulta em blocos de {@link BLOCO_DADOS_COMPRA} ids (em
 * paralelo) e junta os produtos; as chaves (base do markup) são as mesmas em todos os blocos. Falha um, falha tudo
 * (a tela avisa e não grava sem os dados).
 */
export async function dadosCompraEmBlocos(
  produtoIds: readonly string[],
  buscar: (ids: string[]) => Promise<DadosCompraProdutos>,
): Promise<DadosCompraProdutos> {
  const blocos: string[][] = [];
  for (let i = 0; i < produtoIds.length; i += BLOCO_DADOS_COMPRA)
    blocos.push(produtoIds.slice(i, i + BLOCO_DADOS_COMPRA));
  const partes = await Promise.all(blocos.map((b) => buscar(b)));
  const [primeira] = partes;
  if (!primeira) throw new Error('Nenhum produto a consultar.');
  return { ...primeira, produtos: partes.flatMap((p) => p.produtos) };
}

/** A linha com uma mudança de preço pedida ("geral" ou "só da loja"). */
export const pedeMudancaPreco = (l: LinhaRecebimento) =>
  l.atualizarPreco === 'geral' || l.atualizarPreco === 'loja';

/**
 * "Atualizar preço" depois de editar o preço ou o markup da linha: o "não" (respondido ou gravado) volta a "sem
 * resposta", para o Salvar perguntar sobre o preço novo; "geral" e "só da loja" ficam.
 */
export const semResposta = (l: LinhaRecebimento): AtualizarPrecoRecebimento | null =>
  l.atualizarPreco === 'nao' ? null : l.atualizarPreco;

/** Pede lote e validade: "Tem prazo de validade" no cabeçalho ou o produto com `solicita_lote_pdv`. */
export const exigeLote = (cab: Pick<CabecalhoContas, 'temValidade'>, d: DadosCompraProduto | undefined) =>
  cab.temValidade || !!d?.solicitaLotePdv;

/** Erros de uma linha (ERP 3.3: a linha fica vermelha e o Salvar é bloqueado). */
export function errosDaLinha(
  l: LinhaRecebimento,
  cab: CabecalhoContas,
  d: DadosCompraProduto | undefined,
): Partial<Record<keyof LinhaRecebimento | '_linha', string>> {
  const e: Partial<Record<keyof LinhaRecebimento | '_linha', string>> = {};
  if (!l.produto) e.produto = 'Escolha o produto';
  else if (!TIPOS_RECEBIMENTO.includes(l.produto.tipo)) e.produto = 'Tipo de produto sem estoque próprio';
  else if (!l.produto.controlaEstoque) e.produto = 'Produto sem controle de estoque';
  const q = textoDecimal(l.quantidade);
  if (q === null || !dec(q).gt(0)) e.quantidade = 'Quantidade maior que zero';
  const f = textoDecimal(l.fator);
  if (f === null || !dec(f).gt(0)) e.fator = 'Fator maior que zero';
  const p = textoDecimal(l.precoCompra);
  if (p === null || dec(p).lt(0)) e.precoCompra = 'Informe o preço de compra';
  if (l.precoVenda.trim() && textoDecimal(l.precoVenda) === null) e.precoVenda = 'Preço inválido';
  if (l.markup?.trim() && textoDecimal(l.markup) === null) e.markup = 'Markup inválido';
  if (l.atualizarPreco && l.atualizarPreco !== 'nao' && !l.precoVenda.trim() && !l.markup?.trim())
    e.precoVenda = 'Informe o preço de venda a atualizar';
  if (exigeLote(cab, d)) {
    if (!l.lote.trim()) e.lote = 'Informe o lote';
    if (!l.validade.trim()) e.validade = 'Informe a validade';
  } else if (!l.lote.trim() && (l.validade.trim() || l.fabricacao.trim()))
    e.lote = 'A validade e a fabricação são do lote: informe o lote';
  if (dataDaGrade(l.validade) === undefined) e.validade = 'Data inválida (dd/mm/aaaa)';
  if (dataDaGrade(l.fabricacao) === undefined) e.fabricacao = 'Data inválida (dd/mm/aaaa)';
  return e;
}

/** Campo do item no contrato (erros da API `itens.N.campo`) → coluna da grade. */
export const COLUNA_DO_CAMPO: Record<string, keyof LinhaRecebimento> = {
  produtoId: 'produto',
  codigoBarrasId: 'codigoBarrasId',
  fator: 'fator',
  quantidade: 'quantidade',
  precoCompra: 'precoCompra',
  precoVenda: 'precoVenda',
  markupPct: 'markup',
  atualizarPreco: 'atualizarPreco',
  lote: 'lote',
  validade: 'validade',
  fabricacao: 'fabricacao',
  id: 'produto',
};

/**
 * O item do contrato (`itemRecebimentoSchema`): a quantidade, o fator e os preços como digitados (o zod aceita a
 * vírgula), o preço e o markup já resolvidos (o último digitado vale) e "Atualizar preço" = "não" quando não
 * respondido (o "Salvar" pergunta antes, se o preço mudou). Sem poder mudar o preço de venda (`podeAlterarPreco`
 * falso), vai sempre "não", inclusive na linha de um rascunho gravado com "geral" ou "só da loja" por quem podia:
 * a API recusaria a mudança (403) e a tela não deixa trocar a resposta.
 */
export function itemParaApi(
  l: LinhaRecebimento,
  pm: { precoVenda: string | null; markupPct: string | null },
  podeAlterarPreco = true,
): Record<string, unknown> {
  const data = (t: string) => dataDaGrade(t) ?? (t.trim() ? t : null);
  return {
    id: l.id,
    produtoId: l.produto?.id ?? '',
    codigoBarrasId: l.codigoBarrasId,
    fator: l.fator,
    quantidade: l.quantidade,
    precoCompra: l.precoCompra,
    // O markup sobre um custo de centavos passa do teto do contrato (99.999%): vai só o preço.
    markupPct: pm.markupPct !== null && dec(pm.markupPct).abs().lte(MAXIMO_MARKUP) ? pm.markupPct : null,
    precoVenda: pm.precoVenda,
    atualizarPreco: podeAlterarPreco ? (l.atualizarPreco ?? 'nao') : 'nao',
    lote: l.lote,
    validade: data(l.validade),
    fabricacao: data(l.fabricacao),
  };
}
