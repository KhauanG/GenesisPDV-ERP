/**
 * Recebimento manual de mercadoria (ERP 13.3; MD 3.8.1; Fase 2, F2-B14): o documento de entrada sem nota (ou com a nota
 * em papel), rascunho → movimentado → estornado. Este arquivo tem o contrato do rascunho (cabeçalho, itens, filtros,
 * respostas), as contas puras do rascunho (quantidade no estoque, total do item e totais do cabeçalho), desde o
 * F2-B15, o rateio de frete/desconto/outras despesas, o custo final e os contratos de movimentar e estornar e, desde o
 * F2-B16, os dados de compra dos produtos da grade e o markup ⇄ preço de venda da tela.
 */
import { z } from 'zod';
import {
  dataCampo,
  dataOpcionalValida,
  decimal,
  textoObrigatorio,
  textoOpcional,
  type MetadadosRegistro,
} from './campos.js';
import { dec, decTexto, type Dec, type Valor } from './decimal.js';
import { custoMedioAposEntradaTexto, type ModoCompraAtualizaPrecoCusto } from './estoque.js';
import { paginacaoQuerySchema } from './paginacao.js';
import type { PessoaOpcao } from './pessoas.js';
import { markupPct, precoPeloMarkupTexto, type BaseCustoMargem } from './precos.js';
import type { ProdutoOpcao } from './produtos.js';
import { diaOperacionalEm } from './vendas.js';

export const STATUS_RECEBIMENTO = ['rascunho', 'movimentado', 'estornado'] as const;
export type StatusRecebimento = (typeof STATUS_RECEBIMENTO)[number];
/** ERP 13.3 "Movimentado?": Não (rascunho), Sim (movimentado) e Estornado. */
export const ROTULOS_STATUS_RECEBIMENTO: Record<StatusRecebimento, string> = {
  rascunho: 'Não (rascunho)',
  movimentado: 'Sim',
  estornado: 'Estornado',
};

/** "Atualizar preço" do item ao movimentar (ERP 13.3): geral, só da loja (`produtos_lojas`) ou não atualizar. */
export const ATUALIZAR_PRECO_RECEBIMENTO = ['geral', 'loja', 'nao'] as const;
export type AtualizarPrecoRecebimento = (typeof ATUALIZAR_PRECO_RECEBIMENTO)[number];
export const ROTULOS_ATUALIZAR_PRECO: Record<AtualizarPrecoRecebimento, string> = {
  geral: 'Atualizar preço geral',
  loja: 'Atualizar só o preço da loja',
  nao: 'Não atualizar',
};

/**
 * Itens por recebimento: o mesmo teto da NF-e (990 itens por nota, MOC), para o núcleo de entrada comum (F2-B15)
 * tratar os dois documentos com o mesmo limite.
 */
export const LIMITE_ITENS_RECEBIMENTO = 990;

/**
 * Teto da quantidade digitada. Os tetos de cada campo não garantem as contas: `quantidade × fator` vai para
 * `quantidade_estoque` (`numeric(15,3)`) e `quantidade × preço` para `valor_total` (`numeric(15,2)`), e o produto dos
 * tetos passa das duas colunas. Os produtos e as somas do cabeçalho são conferidos em `regrasRecebimento`, com o erro
 * no item, em vez do 22003 genérico do banco.
 */
const MAXIMO_QUANTIDADE = 999_999_999;
/** Maior valor de `numeric(15,3)` (`quantidade_estoque`). */
const MAXIMO_QUANTIDADE_ESTOQUE = '999999999999.999';
/** Maior valor de `numeric(15,2)` (`valor_total` do item, `valor_produtos` e `valor_total` do cabeçalho). */
const MAXIMO_VALOR = '9999999999999.99';

const idOpcional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.uuid().nullable().default(null),
);
const quantidadeCampo = decimal({
  min: 0,
  max: MAXIMO_QUANTIDADE,
  casas: 3,
  mensagem: 'Quantidade inválida',
});
const fatorCampo = decimal({ min: 0, max: 999_999, casas: 3, mensagem: 'Fator inválido' });
const precoCampo = decimal({ min: 0, max: 99_999_999_999, casas: 4, mensagem: 'Preço inválido' });
const precoOpcional = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  precoCampo.nullable().default(null),
);
/** Markup do preço de venda sobre o custo final, em % (pode ser negativo: venda abaixo do custo). */
const markupOpcional = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  decimal({ min: -100, max: 99_999, casas: 4, mensagem: 'Markup inválido' }).nullable().default(null),
);
const valorCabecalho = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? '0' : v),
  decimal({ min: 0, max: 9_999_999_999_999, casas: 2, mensagem: 'Valor inválido' }),
);

/**
 * Hoje no fuso dado (`AAAA-MM-DD`; padrão Brasília). A "Data" do recebimento e a fabricação não podem ser futuras
 * (ERP 13.3: o documento do fornecedor nunca chega antes de existir), no fuso da **loja destinatária** (ERP 1.5,
 * `lojas.fuso_horario`): quem confere é a API, que conhece a loja (`conferirCabecalhoRecebimento`); a tela usa esta
 * função com o fuso da loja escolhida só para sugerir o dia.
 */
export function hojeNoFuso(agora = new Date(), fuso = 'America/Sao_Paulo'): string {
  return diaOperacionalEm(agora, '00:00', fuso);
}

export const itemRecebimentoSchema = z.object({
  /** Item já gravado (mantido na edição); vazio = item novo. */
  id: idOpcional,
  produtoId: z.uuid('Escolha o produto'),
  /**
   * Embalagem usada (`produtos_codigos_barras` do produto, com "Usa na compra"): leva a unidade e o fator dela, e o
   * fator informado tem de ser o da embalagem. Vazio = a unidade do produto (ou um fator digitado, ex.: caixa sem EAN).
   */
  codigoBarrasId: idOpcional,
  /** Unidades do produto por unidade de compra (ex.: o fardo com 12). */
  fator: z.preprocess((v) => (v === '' || v === undefined || v === null ? '1' : v), fatorCampo),
  /** Na unidade de compra (a embalagem). */
  quantidade: quantidadeCampo,
  /** Preço de compra por unidade da embalagem. */
  precoCompra: precoCampo,
  markupPct: markupOpcional,
  /** Preço de venda proposto; obrigatório quando o item atualiza o preço. */
  precoVenda: precoOpcional,
  atualizarPreco: z.enum(ATUALIZAR_PRECO_RECEBIMENTO).default('nao'),
  lote: textoOpcional(30),
  validade: dataOpcionalValida,
  fabricacao: dataOpcionalValida,
});
export type ItemRecebimentoEntrada = z.input<typeof itemRecebimentoSchema>;
export type ItemRecebimento = z.output<typeof itemRecebimentoSchema>;

const camposRecebimento = z.object({
  /** Loja destinatária (as lojas permitidas). */
  lojaId: z.uuid('Escolha a loja'),
  /** Estoque de destino (os estoques permitidos). Vazio = o estoque vinculado à loja. */
  estoqueId: idOpcional,
  /** Tipo de estoque que recebe as mercadorias. Vazio = o tipo padrão (Disponível). */
  tipoEstoqueId: idOpcional,
  fornecedorId: z.uuid('Escolha o fornecedor'),
  /**
   * Data do documento. Vazio = hoje, e a data não pode ser futura, as duas coisas no fuso da loja destinatária,
   * aplicadas pela API (o contrato não sabe o fuso da loja; ERP 1.5).
   */
  dataRecebimento: dataOpcionalValida,
  /** Nº do documento do fornecedor ("Cód. remessa"). Repetido para o mesmo fornecedor só avisa. */
  codigoRemessa: textoOpcional(30),
  /** "Tem prazo de validade": exige Lote e Validade em todos os itens. */
  temValidade: z.boolean().default(false),
  valorFrete: valorCabecalho,
  valorDesconto: valorCabecalho,
  valorOutrasDespesas: valorCabecalho,
  observacoes: textoOpcional(2000),
  itens: z
    .array(itemRecebimentoSchema)
    .max(LIMITE_ITENS_RECEBIMENTO, `No máximo ${LIMITE_ITENS_RECEBIMENTO} itens por recebimento`)
    .default([]),
});

function regrasRecebimento(v: z.output<typeof camposRecebimento>, ctx: z.RefinementCtx) {
  /** Linha de cada `id` já visto: o mesmo item duas vezes viraria dois UPDATEs na mesma linha. */
  const vistos = new Map<string, number>();
  v.itens.forEach((it, i) => {
    if (it.id !== null) {
      const chave = it.id.toLowerCase();
      const anterior = vistos.get(chave);
      if (anterior !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['itens', i, 'id'],
          message: `Item repetido (linha ${anterior + 1})`,
        });
      else vistos.set(chave, i);
    }
    if (Number(it.quantidade) <= 0)
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'quantidade'],
        message: 'Informe uma quantidade maior que zero',
      });
    if (Number(it.fator) <= 0)
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'fator'],
        message: 'O fator tem de ser maior que zero',
      });
    if (it.atualizarPreco !== 'nao' && it.precoVenda === null)
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'precoVenda'],
        message: 'Informe o preço de venda a atualizar',
      });
    if (v.temValidade && it.lote === null)
      ctx.addIssue({ code: 'custom', path: ['itens', i, 'lote'], message: 'Informe o lote' });
    if (v.temValidade && it.validade === null)
      ctx.addIssue({ code: 'custom', path: ['itens', i, 'validade'], message: 'Informe a validade' });
    if (it.lote === null && (it.validade !== null || it.fabricacao !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'lote'],
        message: 'A validade e a fabricação são do lote: informe o lote',
      });
    if (it.fabricacao !== null && it.validade !== null && it.fabricacao > it.validade)
      ctx.addIssue({
        code: 'custom',
        path: ['itens', i, 'fabricacao'],
        message: 'A fabricação não pode ser depois da validade',
      });
    if (Number(it.quantidade) > 0 && Number(it.fator) > 0) {
      const contas = valoresItemRecebimentoTexto(it);
      if (dec(contas.quantidadeEstoque).gt(MAXIMO_QUANTIDADE_ESTOQUE))
        ctx.addIssue({
          code: 'custom',
          path: ['itens', i, 'quantidade'],
          message: 'Quantidade × fator passa do limite do sistema (999.999.999.999,999)',
        });
      if (dec(contas.valorTotal).gt(MAXIMO_VALOR))
        ctx.addIssue({
          code: 'custom',
          path: ['itens', i, 'quantidade'],
          message: 'O total do item passa do limite do sistema (R$ 9.999.999.999.999,99)',
        });
    }
  });
  if (v.itens.every((it) => Number(it.quantidade) > 0)) {
    const t = totaisRecebimentoTexto(v.itens, v);
    if (dec(t.valorProdutos).gt(MAXIMO_VALOR) || dec(t.valorTotal).gt(MAXIMO_VALOR))
      ctx.addIssue({
        code: 'custom',
        path: ['itens'],
        message: 'O total do recebimento passa do limite do sistema (R$ 9.999.999.999.999,99)',
      });
    if (dec(t.valorTotal).lt(0))
      ctx.addIssue({
        code: 'custom',
        path: ['valorDesconto'],
        message: 'O desconto não pode passar do total dos produtos com frete e outras despesas',
      });
  }
}

export const criarRecebimentoSchema = camposRecebimento.superRefine(regrasRecebimento);
export type CriarRecebimentoEntrada = z.input<typeof criarRecebimentoSchema>;
export type CriarRecebimento = z.output<typeof criarRecebimentoSchema>;
export const alterarRecebimentoSchema = camposRecebimento
  .extend({ versao: z.number().int() })
  .superRefine((v, ctx) => regrasRecebimento(v, ctx));
export type AlterarRecebimentoEntrada = z.input<typeof alterarRecebimentoSchema>;
export type AlterarRecebimento = z.output<typeof alterarRecebimentoSchema>;

/** `?versao=` da exclusão do rascunho (opcional: sem ela, exclui o que estiver gravado, como o acerto). */
export const excluirRecebimentoSchema = z.object({ versao: z.coerce.number().int().optional() });

// ---------------------------------------------------------------- Contas do rascunho

/** Quantidade no estoque (unidade do produto) e total do item: `quantidade × fator` e `quantidade × preço de compra`. */
export function valoresItemRecebimentoTexto(it: { quantidade: Valor; fator: Valor; precoCompra: Valor }): {
  quantidadeEstoque: string;
  valorTotal: string;
} {
  return {
    quantidadeEstoque: decTexto(dec(it.quantidade).times(it.fator), 3),
    valorTotal: decTexto(dec(it.quantidade).times(it.precoCompra), 2),
  };
}

/**
 * Totais do cabeçalho (ERP 13.3, rodapé): produtos = Σ total dos itens (cada um a 2 casas), e o "Total geral" =
 * produtos + frete + outras despesas − desconto. Pode dar negativo (desconto maior que o resto): o contrato recusa.
 */
export function totaisRecebimentoTexto(
  itens: ReadonlyArray<{ quantidade: Valor; fator: Valor; precoCompra: Valor }>,
  cab: { valorFrete: Valor; valorDesconto: Valor; valorOutrasDespesas: Valor },
): { qtdItens: number; valorProdutos: string; valorTotal: string } {
  const produtos = itens.reduce((s, it) => s.plus(valoresItemRecebimentoTexto(it).valorTotal), dec(0));
  const total = produtos.plus(cab.valorFrete).plus(cab.valorOutrasDespesas).minus(cab.valorDesconto);
  return { qtdItens: itens.length, valorProdutos: decTexto(produtos, 2), valorTotal: decTexto(total, 2) };
}

// ---------------------------------------------------------------- Rateio e custo final (F2-B15)

const CENTAVO = dec('0.01');

/**
 * Rateia `total` (2 casas, ≥ 0) entre os itens proporcionalmente a `pesos` (ERP 13.3: "proporcionalmente ao valor"),
 * em decimal, e **fecha com o total**: cada parte é arredondada a 2 casas (meio para longe do zero) e o resíduo dos
 * arredondamentos vai para o item de **maior peso** (o primeiro, no empate). Quando o resíduo negativo deixaria esse
 * item abaixo de zero (total de poucos centavos para muitos itens: 10 × 0,005 arredondados viram 0,10 para um total
 * de 0,05), os demais itens são truncados no centavo em vez de arredondados, e o resíduo, então sempre ≥ 0, fica com o
 * maior: nenhuma parte é negativa. Sem peso nenhum (todos os itens a R$ 0,00), o rateio é por partes iguais.
 */
export function ratearProporcionalTexto(total: Valor, pesos: readonly Valor[]): string[] {
  if (!pesos.length) return [];
  const t = dec(decTexto(total, 2));
  if (t.isZero()) return pesos.map(() => '0.00');
  let p = pesos.map((x) => dec(x));
  let base = p.reduce((s, x) => s.plus(x), dec(0));
  if (!base.gt(0)) {
    p = p.map(() => dec(1));
    base = dec(p.length);
  }
  let maior = 0;
  p.forEach((x, i) => {
    if (x.gt(p[maior]!)) maior = i;
  });
  const fechar = (partes: Dec[]) => {
    const outros = partes.reduce((s, x, i) => (i === maior ? s : s.plus(x)), dec(0));
    partes[maior] = t.minus(outros);
    return partes;
  };
  let partes = fechar(p.map((x) => t.times(x).div(base).toDecimalPlaces(2)));
  if (partes[maior]!.lt(0))
    partes = fechar(p.map((x) => t.times(x).div(base).div(CENTAVO).floor().times(CENTAVO)));
  return partes.map((x) => x.toFixed(2));
}

/** O que a movimentação grava em cada item: os rateios e o custo final (MD 3.8.1). */
export interface ContasItemEntrada {
  rateioFrete: string;
  rateioDesconto: string;
  rateioOutras: string;
  /** Por unidade do produto, 4 casas: `(total + frete + outras − desconto) / quantidade_estoque` (≥ 0). */
  custoUnitarioFinal: string;
}

/**
 * Rateio do frete, do desconto e das outras despesas do cabeçalho pelo **total de cada item** (quantidade × preço de
 * compra, 2 casas: o `valor_total` gravado), cada valor com o seu `ratearProporcionalTexto`, e o custo final do item na
 * unidade do produto (`quantidade_estoque` = quantidade × fator), a 4 casas. Exemplo do critério do F2-B15: 10 fardos ×
 * 12 a R$ 60,00 com frete de R$ 12,00 = (600,00 + 12,00) / 120 = R$ 5,1000. O custo nunca é negativo (o contrato
 * recusa o desconto maior que produtos + frete + outras; o resíduo de centavos não vira custo negativo).
 */
export function contasEntradaRecebimentoTexto(
  itens: ReadonlyArray<{ quantidade: Valor; fator: Valor; precoCompra: Valor }>,
  cab: { valorFrete: Valor; valorDesconto: Valor; valorOutrasDespesas: Valor },
): ContasItemEntrada[] {
  const valores = itens.map((it) => valoresItemRecebimentoTexto(it));
  const pesos = valores.map((v) => v.valorTotal);
  const frete = ratearProporcionalTexto(cab.valorFrete, pesos);
  const desconto = ratearProporcionalTexto(cab.valorDesconto, pesos);
  const outras = ratearProporcionalTexto(cab.valorOutrasDespesas, pesos);
  return valores.map((v, i) => {
    const liquido = dec(v.valorTotal).plus(frete[i]!).plus(outras[i]!).minus(desconto[i]!);
    const q = dec(v.quantidadeEstoque);
    const custo = q.gt(0) && liquido.gt(0) ? liquido.div(q) : dec(0);
    return {
      rateioFrete: frete[i]!,
      rateioDesconto: desconto[i]!,
      rateioOutras: outras[i]!,
      custoUnitarioFinal: decTexto(custo, 4),
    };
  });
}

// ---------------------------------------------------------------- Movimentar e estornar (F2-B15)

/**
 * `POST /recebimentos/:id/movimentar`. `versao` (a do documento) é conferida no rascunho; no recebimento já
 * movimentado a chamada é idempotente e devolve o detalhe sem conferir. `atualizarPrecoCusto` responde à pergunta de
 * `estoque.compra_atualiza_preco_custo` = 'perguntar' (D49): `true` leva o custo final ao preço de custo dos produtos,
 * `false` mantém o preço de custo; vazio, com algum preço de custo diferente, a API devolve 422 com a pergunta. Sem
 * `produtos.ver_custo` a resposta não vale e o preço de custo fica (quem não vê o custo não o decide).
 */
export const movimentarRecebimentoSchema = z.object({
  versao: z.number().int().optional(),
  atualizarPrecoCusto: z.boolean().nullable().default(null),
});
export type MovimentarRecebimento = z.output<typeof movimentarRecebimentoSchema>;

/**
 * Um saldo negativo confirmado por quem estorna: o produto, o lote (nulo = a linha de saldo do produto) e o saldo final
 * que a lista do 422 mostrava (`SaldoNegativoEstorno`; os outros campos, se vierem, são ignorados).
 */
export const saldoNegativoConfirmadoSchema = z.object({
  produtoId: z.uuid(),
  lote: z.string().max(60).nullable(),
  saldoFinal: decimal({ max: 0, casas: 3, mensagem: 'Saldo final inválido' }),
});
export type SaldoNegativoConfirmado = z.output<typeof saldoNegativoConfirmadoSchema>;

/**
 * A confirmação do estorno que deixa saldo negativo (D56, decidida pelo dono em 05/11/2026: bloqueado, salvo Master
 * ou `estoque.permite_negativo_erp`, **com aviso**). Quem pode deixar negativo e não confirmou recebe 422 em
 * `campos.confirmarNegativo` com os produtos/lotes em `detalhes.saldosNegativos` (`SaldoNegativoEstorno`). A
 * confirmação é **a lista que foi mostrada** (não um "sim" geral): o estorno só passa se cada saldo negativo de agora
 * estiver nela e não ficar mais negativo que o mostrado; se uma venda mudou a conta enquanto a pergunta estava aberta,
 * volta o 422 com a lista nova. Com a confirmação, a auditoria registra o negativo confirmado. Sem a permissão a
 * confirmação não vale: continua bloqueado. O estorno da NF-e (F2-B21) usa o mesmo campo.
 */
export const confirmarNegativoSchema = z
  .array(saldoNegativoConfirmadoSchema)
  .max(2 * LIMITE_ITENS_RECEBIMENTO)
  .default([]);

/** `POST /recebimentos/:id/estornar`: o motivo é obrigatório (ERP 13.3); `confirmarNegativo` é a confirmação da D56. */
export const estornarRecebimentoSchema = z.object({
  versao: z.number().int().optional(),
  motivo: textoObrigatorio(255, 'Informe o motivo do estorno'),
  confirmarNegativo: confirmarNegativoSchema,
});
export type EstornarRecebimento = z.output<typeof estornarRecebimentoSchema>;

/**
 * Um saldo que o estorno de uma entrada (recebimento ou NF-e) deixará negativo: a linha de saldo do produto (`lote`
 * nulo) ou um lote dele. `saldoAtual` e `saldoFinal` em texto decimal, na unidade do produto. Vem em
 * `detalhes.saldosNegativos` do 422 do estorno (com ou sem a permissão de deixar negativo).
 */
export interface SaldoNegativoEstorno {
  produtoId: string;
  nome: string;
  lote: string | null;
  saldoAtual: string;
  saldoFinal: string;
}

/**
 * `detalhes` do 422 da pergunta do preço de custo (`campos.atualizarPrecoCusto`): os produtos cujo preço de custo
 * mudaria, com o atual e o novo. A pergunta só vai a quem tem `produtos.ver_custo` (sem ela, quem movimenta não decide
 * o preço de custo: ele fica como está, como no formulário do produto).
 */
export interface PrecoCustoAAtualizar {
  produtoId: string;
  nome: string;
  atual: string;
  novo: string;
}

// ---------------------------------------------------------------- Listagem e detalhe

/** Com o `dataCampo`: a data impossível (30/02) é 422 aqui, e não o 22008 do `::date` (500). */
const dataFiltro = dataCampo.optional();

/** Filtros da listagem (ERP 13.3): fornecedor, Id, Cód. remessa, estoque/loja, período e "Movimentado?". */
export const filtroRecebimentosSchema = paginacaoQuerySchema.extend({
  fornecedorId: z.uuid().optional(),
  codigo: z.coerce.number().int().min(1).optional(),
  /** Contém, sem diferenciar maiúsculas. */
  codigoRemessa: z.string().trim().min(1).max(30).optional(),
  estoqueId: z.uuid().optional(),
  lojaId: z.uuid().optional(),
  /** Período pela data do recebimento. */
  dataInicial: dataFiltro,
  dataFinal: dataFiltro,
  status: z.enum(STATUS_RECEBIMENTO).optional(),
});
export type FiltroRecebimentos = z.infer<typeof filtroRecebimentosSchema>;

export interface RecebimentoResumo {
  id: string;
  codigo: number;
  fornecedorId: string;
  fornecedorNome: string;
  dataRecebimento: string;
  codigoRemessa: string | null;
  lojaId: string;
  lojaNome: string;
  estoqueId: string;
  estoqueNome: string;
  qtdItens: number;
  valorTotal: string;
  status: StatusRecebimento;
  versao: number;
}

export interface ItemRecebimentoDetalhe {
  id: string;
  sequencia: number;
  produtoId: string;
  produto: ProdutoOpcao;
  codigoBarrasId: string | null;
  /** Código da embalagem usada (o EAN de compra), quando houver. */
  codigoBarras: string | null;
  unidadeCompra: string | null;
  fator: string;
  quantidade: string;
  quantidadeEstoque: string;
  precoCompra: string;
  /**
   * O markup gravado (sobre a base de `produtos.custo_base_margem` de quem gravou); `null` sem `produtos.ver_custo`:
   * com o preço de venda, revelaria a base (o custo médio ou o preço de custo do cadastro; README da API › decisão 161).
   */
  markupPct: string | null;
  precoVenda: string | null;
  atualizarPreco: AtualizarPrecoRecebimento;
  lote: string | null;
  validade: string | null;
  fabricacao: string | null;
  /** Lote criado ao movimentar (F2-B15); nulo no rascunho. */
  loteId: string | null;
  rateioFrete: string;
  rateioDesconto: string;
  rateioOutras: string;
  /** Custo final por unidade do produto, gravado ao movimentar (F2-B15); `0` no rascunho. */
  custoUnitarioFinal: string;
  valorTotal: string;
}

/** Outro recebimento do mesmo fornecedor com o mesmo "Cód. remessa" (o aviso, ERP 13.3). */
export interface RecebimentoRemessaRepetida {
  id: string;
  codigo: number;
  dataRecebimento: string;
  status: StatusRecebimento;
}

export interface RecebimentoDetalhe extends MetadadosRegistro {
  codigo: number;
  lojaId: string;
  lojaNome: string;
  estoqueId: string;
  estoqueNome: string;
  tipoEstoqueId: string;
  tipoEstoqueNome: string;
  fornecedorId: string;
  /** Sem `pessoas.ver`, sem o CPF/CNPJ (`cpfCnpj: null`). */
  fornecedor: PessoaOpcao;
  dataRecebimento: string;
  codigoRemessa: string | null;
  temValidade: boolean;
  observacoes: string | null;
  status: StatusRecebimento;
  movimentadoEm: string | null;
  movimentadoPorNome: string | null;
  estornadoEm: string | null;
  estornadoPorNome: string | null;
  motivoEstorno: string | null;
  qtdItens: number;
  valorProdutos: string;
  valorFrete: string;
  valorDesconto: string;
  valorOutrasDespesas: string;
  valorTotal: string;
  itens: ItemRecebimentoDetalhe[];
  /** Os outros recebimentos (não estornados) do fornecedor com o mesmo "Cód. remessa". */
  remessaRepetida: RecebimentoRemessaRepetida[];
  /** Avisos que não impedem salvar (a remessa repetida). */
  avisos: string[];
}

// ---------------------------------------------------------------- Dados de compra e markup da tela (F2-B16)

/**
 * Produtos por consulta de `GET /recebimentos/dados-produtos` (como o `/saldos-estoque/itens`). O recebimento aceita
 * até {@link LIMITE_ITENS_RECEBIMENTO} itens: a tela consulta em blocos menores (`BLOCO_DADOS_COMPRA` do ERP) e junta.
 */
export const LIMITE_PRODUTOS_DADOS_COMPRA = 200;

/**
 * `GET /recebimentos/dados-produtos`: os produtos da grade, no estoque × tipo de destino e com o preço da loja
 * destinatária (opcionais).
 */
export const consultaDadosCompraSchema = z.object({
  produtoIds: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.uuid()).min(1).max(LIMITE_PRODUTOS_DADOS_COMPRA),
  ),
  estoqueId: z.uuid().optional(),
  tipoEstoqueId: z.uuid().optional(),
  lojaId: z.uuid().optional(),
});

/** Embalagem de compra do produto (`produtos_codigos_barras` com "Usa na compra", sem variação; ERP 8.2.3). */
export interface EmbalagemCompra {
  id: string;
  codigo: string;
  descricao: string | null;
  /** Unidade da embalagem (ex.: FD); `null` = a do produto. */
  unidadeSigla: string | null;
  fator: string;
}

export interface DadosCompraProduto {
  produtoId: string;
  /** O produto pede lote no PDV: Lote e Validade obrigatórios no item (a API confere). */
  solicitaLotePdv: boolean;
  /** Tem lote ativo cadastrado (sem estoque ou do estoque de destino): a grade mostra Lote e Validade. */
  temLotes: boolean;
  embalagens: EmbalagemCompra[];
  /** Saldo no estoque × tipo de destino (`null` sem estoque informado ou fora dos estoques visíveis). */
  saldo: string | null;
  /** Custo médio desse saldo; `null` sem `produtos.ver_custo` (ou sem saldo informado). */
  custoMedio: string | null;
  /**
   * Preço de venda próprio da loja destinatária (`produtos_lojas`); `null` = a loja segue o preço geral (ou sem a loja
   * informada). É o "preço atual" da proposta e da pergunta geral/loja/não da tela: o movimentar compara o "só da
   * loja" com ele (README da API › decisão 161).
   */
  precoVendaLoja: string | null;
}

export interface DadosCompraProdutos {
  /** `produtos.custo_base_margem` (D49): a base do markup da tela. */
  custoBaseMargem: BaseCustoMargem;
  /** `estoque.compra_atualiza_preco_custo` (D49): com `nunca`, o preço de custo não muda com a compra. */
  compraAtualizaPrecoCusto: ModoCompraAtualizaPrecoCusto;
  /**
   * Quem consulta pode mudar o preço de venda na compra: "Altera Preço do Produto no ERP" ligada ou
   * `produtos.alterar_preco` (a mesma regra da movimentação). Sem isso, a tela não pergunta "geral / só desta loja" e
   * o item vai com "Não" (README da API › decisão 165; README do ERP › decisão 60).
   */
  podeAlterarPreco: boolean;
  produtos: DadosCompraProduto[];
}

/**
 * Custo sobre o qual a tela do recebimento calcula o markup ⇄ preço de venda do item (`produtos.custo_base_margem`,
 * D49), por unidade do produto, a 4 casas:
 * - `ultimo_custo`: o custo final do item nesta compra;
 * - `preco_custo` (padrão): o preço de custo que o produto terá depois da compra — o custo final, que a movimentação
 *   leva ao preço de custo (`sempre`, ou `perguntar` com o "Sim"), salvo `estoque.compra_atualiza_preco_custo` =
 *   `nunca`, em que fica o preço de custo atual;
 * - `custo_medio`: o custo médio do estoque de destino depois da entrada (ponderado com o saldo, ERP 13.1.4).
 *
 * Sem o custo do produto (quem não tem `produtos.ver_custo` recebe `null`), a base é o custo final da compra: o
 * documento é visível com `recebimentos.ver` (decisão 159 da API), o custo do cadastro não, e o markup da tela não pode
 * revelá-lo.
 */
export function baseMarkupRecebimentoTexto(p: {
  base: BaseCustoMargem;
  compraAtualizaPrecoCusto: ModoCompraAtualizaPrecoCusto;
  custoFinal: Valor;
  quantidadeEstoque: Valor;
  precoCusto: string | null;
  saldo: string | null;
  custoMedio: string | null;
}): string {
  if (p.base === 'preco_custo' && p.compraAtualizaPrecoCusto === 'nunca' && p.precoCusto !== null)
    return decTexto(p.precoCusto, 4);
  if (p.base === 'custo_medio' && p.saldo !== null && p.custoMedio !== null)
    return custoMedioAposEntradaTexto(p.saldo, p.custoMedio, p.quantidadeEstoque, p.custoFinal);
  return decTexto(p.custoFinal, 4);
}

/**
 * Markup ⇄ preço de venda do item (ERP 13.3: "alterar o markup recalcula o preço; alterar o preço recalcula o
 * markup"): vale o último que o usuário digitou. Com o markup digitado (`markup` preenchido), o preço acompanha a base
 * (o custo final muda com a quantidade, o frete e o desconto) a 2 casas; com o preço digitado (`markup` vazio), o
 * markup é o do preço sobre a base, a 4 casas (`null` com a base zero: não há markup sobre custo zero).
 */
export function markupPrecoRecebimento(
  base: Valor,
  linha: { precoVenda: Valor | null; markup: Valor | null },
): { precoVenda: string | null; markupPct: string | null } {
  if (linha.markup !== null && linha.markup !== '') {
    return { precoVenda: precoPeloMarkupTexto(base, linha.markup), markupPct: decTexto(linha.markup, 4) };
  }
  if (linha.precoVenda === null || linha.precoVenda === '') return { precoVenda: null, markupPct: null };
  const m = markupPct(base, linha.precoVenda);
  return { precoVenda: decTexto(linha.precoVenda, 4), markupPct: m === null ? null : decTexto(m, 4) };
}
