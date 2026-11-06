/**
 * Cálculos puros de preço e cadastro de produto usados pela API e pelo ERP (ERP 8.2.1, 8.2.3, 8.2.17, 8.10; PDV 11.3,
 * 11.3.1): dígito verificador GTIN, margem × markup, resumo do combo (custo, margem com alternativas, desconto do
 * combo), combos montáveis e a regra de preço por quantidade (o "Simular" do grupo de preço — mesma regra do
 * `MotorPreco` do `GenesisPDV.Core`).
 */

import { dec, decNumero, decTexto, type Dec, type Valor } from './decimal.js';

// ---------------------------------------------------------------- GTIN (ERP 1.6, 8.2.1, 8.2.3)

/** DV do GTIN (módulo 10 com pesos 3,1 a partir da direita) para a base sem o DV. */
export function calcularDvGtin(base: string): number {
  let soma = 0;
  for (let i = 0; i < base.length; i++) {
    const peso = (base.length - i) % 2 === 1 ? 3 : 1;
    soma += Number(base[i]) * peso;
  }
  return (10 - (soma % 10)) % 10;
}

/** GTIN-8, GTIN-12 (UPC-A), GTIN-13 (EAN-13) ou GTIN-14 (DUN-14) com o dígito verificador certo. */
export function validarGtin(codigo: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(codigo)) return false;
  if (/^0+$/.test(codigo)) return false;
  return calcularDvGtin(codigo.slice(0, -1)) === Number(codigo.at(-1));
}

/** GTIN-14 de embalagem (DUN-14): o 1º dígito é o indicador de embalagem (1–8; 9 = medida variável). */
export function ehDun14(codigo: string): boolean {
  return codigo.length === 14 && validarGtin(codigo) && codigo[0] !== '0';
}

/**
 * Código interno de balcão com prefixo `2` (ERP 8.2.1 "Gerar código interno"): `2` + número com 11 dígitos + DV,
 * no formato EAN-13 para o leitor aceitar. Prefixo 2 é de uso interno do GS1 (não colide com EAN de fabricante).
 */
export function gerarCodigoInterno(numero: number): string {
  const base = `2${String(Math.trunc(Math.abs(numero)) % 1e11).padStart(11, '0')}`;
  return `${base}${calcularDvGtin(base)}`;
}

// ---------------------------------------------------------------- Margem × markup (ERP 8.2.1)
// Contas em decimal com "meio para longe do zero" (ADR-05, `decimal.ts`): o mesmo resultado do PDV (C# `decimal`).

/** Margem % = (venda − custo) ÷ venda × 100; sem preço de venda = `null`. */
export function margemPct(custo: Valor, venda: Valor): number | null {
  const v = dec(venda);
  if (!v.gt(0)) return null;
  return decNumero(v.minus(dec(custo)).div(v).times(100), 2);
}

/** Markup % = (venda ÷ custo − 1) × 100; sem custo = `null`. */
export function markupPct(custo: Valor, venda: Valor): number | null {
  const c = dec(custo);
  if (!c.gt(0)) return null;
  return decNumero(dec(venda).div(c).minus(1).times(100), 4);
}

/** Botão "Calcular": `preco_venda = preco_custo × (1 + markup/100)`, arredondado a 2 casas (texto para o campo). */
export function precoPeloMarkupTexto(custo: Valor, markup: Valor): string {
  return decTexto(dec(custo).times(dec(markup).div(100).plus(1)), 2);
}

export function precoPeloMarkup(custo: Valor, markup: Valor): number {
  return Number(precoPeloMarkupTexto(custo, markup));
}

/**
 * `produtos.custo_base_margem` (D49, decidida pelo dono: "bem maleável"): o custo sobre o qual a margem e o preço
 * sugerido da compra são calculados — o preço de custo do produto (padrão), o custo médio do estoque ou o último custo
 * (o da própria compra). F2-B16: o markup ⇄ preço do recebimento manual (`baseMarkupRecebimentoTexto`).
 */
export const CHAVE_CUSTO_BASE_MARGEM = 'produtos.custo_base_margem';
export const BASES_CUSTO_MARGEM = ['preco_custo', 'custo_medio', 'ultimo_custo'] as const;
export type BaseCustoMargem = (typeof BASES_CUSTO_MARGEM)[number];

// ---------------------------------------------------------------- Combo (kit) – ERP 8.2.17; MD 3.6.3, 3.6.7

export interface OpcaoPosicao {
  /** Custo unitário do produto (`preco_custo`). */
  custo: Valor;
  /** Preço de varejo unitário (`preco_venda`), peso do rateio na NFC-e. */
  preco: Valor;
  acrescimo?: Valor;
  ativo?: boolean;
}

export interface PosicaoCombo {
  quantidade: Valor;
  padrao: OpcaoPosicao;
  alternativas?: OpcaoPosicao[];
}

export interface ResumoCombo {
  /** Σ (custo do padrão × qtd) — o `preco_custo` do combo. */
  custo: number;
  /** Σ (preço do padrão × qtd). */
  somaPrecos: number;
  /** Soma dos preços − preço do combo ("desconto do combo"); negativo = combo mais caro que os itens avulsos. */
  descontoCombo: number;
  /** Desconto em % da soma dos preços (negativo = acréscimo); `null` sem preços. */
  descontoPct: number | null;
  margemPct: number | null;
  markupPct: number | null;
  /**
   * Faixa de margem entre todas as escolhas possíveis (padrão incluído), com o custo e o acréscimo de cada
   * alternativa ativa; `null` sem alternativas.
   */
  margemMinPct: number | null;
  margemMaxPct: number | null;
}

/** Acima disso as combinações não são enumeradas: cada posição fica com a pior e a melhor contribuição. */
const LIMITE_CENARIOS_COMBO = 20_000;

/**
 * Margens possíveis do combo com alternativas. A margem é (preço + Σ acréscimos − Σ custos) ÷ (preço + Σ acréscimos):
 * não é linear, então as combinações são enumeradas (poucas posições e alternativas na prática); acima do limite,
 * cada posição usa a opção de menor e a de maior contribuição (acréscimo − custo × qtd). O cenário padrão entra sempre.
 */
function margensCombo(posicoes: readonly PosicaoCombo[], precoCombo: Dec): number[] {
  const opcoesPorPosicao = posicoes.map((p) => {
    const q = dec(p.quantidade);
    return [
      { custo: dec(p.padrao.custo).times(q), acrescimo: dec(0) },
      ...(p.alternativas ?? [])
        .filter((a) => a.ativo !== false)
        .map((a) => ({ custo: dec(a.custo).times(q), acrescimo: dec(a.acrescimo ?? 0) })),
    ];
  });
  const total = opcoesPorPosicao.reduce((n, o) => n * o.length, 1);
  const margem = (custo: Dec, acrescimo: Dec) => margemPct(custo, precoCombo.plus(acrescimo));
  const margens: number[] = [];
  if (total <= LIMITE_CENARIOS_COMBO) {
    const visitar = (i: number, custo: Dec, acrescimo: Dec) => {
      if (i === opcoesPorPosicao.length) {
        const m = margem(custo, acrescimo);
        if (m !== null) margens.push(m);
        return;
      }
      for (const o of opcoesPorPosicao[i]!) visitar(i + 1, custo.plus(o.custo), acrescimo.plus(o.acrescimo));
    };
    visitar(0, dec(0), dec(0));
    return margens;
  }
  const contribuicao = (o: { custo: Dec; acrescimo: Dec }) => o.acrescimo.minus(o.custo);
  for (const escolha of ['padrao', 'pior', 'melhor'] as const) {
    let custo = dec(0);
    let acrescimo = dec(0);
    for (const opcoes of opcoesPorPosicao) {
      const o =
        escolha === 'padrao'
          ? opcoes[0]!
          : opcoes.reduce((m, x) =>
              escolha === 'pior'
                ? contribuicao(x).lt(contribuicao(m))
                  ? x
                  : m
                : contribuicao(x).gt(contribuicao(m))
                  ? x
                  : m,
            );
      custo = custo.plus(o.custo);
      acrescimo = acrescimo.plus(o.acrescimo);
    }
    const m = margem(custo, acrescimo);
    if (m !== null) margens.push(m);
  }
  return margens;
}

export function resumoCombo(posicoes: readonly PosicaoCombo[], precoComboValor: Valor): ResumoCombo {
  const precoCombo = dec(precoComboValor);
  const custo = posicoes.reduce((s, p) => s.plus(dec(p.padrao.custo).times(dec(p.quantidade))), dec(0));
  const somaPrecos = posicoes.reduce((s, p) => s.plus(dec(p.padrao.preco).times(dec(p.quantidade))), dec(0));
  const comAlternativas = posicoes.some((p) => (p.alternativas ?? []).some((a) => a.ativo !== false));
  const margens = comAlternativas ? margensCombo(posicoes, precoCombo) : [];
  const desconto = somaPrecos.minus(precoCombo);
  return {
    custo: decNumero(custo, 4),
    somaPrecos: decNumero(somaPrecos, 2),
    descontoCombo: decNumero(desconto, 2),
    descontoPct: somaPrecos.gt(0) ? decNumero(desconto.div(somaPrecos).times(100), 2) : null,
    margemPct: margemPct(custo, precoCombo),
    markupPct: markupPct(custo, precoCombo),
    margemMinPct: margens.length ? Math.min(...margens) : null,
    margemMaxPct: margens.length ? Math.max(...margens) : null,
  };
}

export interface PosicaoSaldo {
  nome: string;
  /**
   * Identidade do componente (produto + variação). Posições com o mesmo componente somam a quantidade (duas
   * posições "Gelo de sabor" com o mesmo padrão consomem 2 por combo). Sem `chave`, vale o `nome`.
   */
  chave?: string;
  quantidade: Valor;
  controlaEstoque: boolean;
  saldo: Valor;
}

/**
 * Combos montáveis num estoque (ERP 8.2.17): mínimo de ⌊saldo do padrão ÷ Σ qtd do mesmo componente⌋ entre os
 * componentes que controlam estoque; nenhum com controle = sem limite (`null`). Saldo negativo conta como zero.
 */
export function combosMontaveis(posicoes: readonly PosicaoSaldo[]): {
  quantidade: number | null;
  limitadoPor: string | null;
} {
  const porComponente = new Map<string, { nome: string; quantidade: Dec; saldo: Dec }>();
  for (const p of posicoes) {
    const q = dec(p.quantidade);
    if (!p.controlaEstoque || !q.gt(0)) continue;
    const chave = p.chave ?? p.nome;
    const atual = porComponente.get(chave);
    if (atual) atual.quantidade = atual.quantidade.plus(q);
    else porComponente.set(chave, { nome: p.nome, quantidade: q, saldo: dec(p.saldo) });
  }
  let melhor: { quantidade: number; limitadoPor: string } | null = null;
  for (const c of porComponente.values()) {
    const n = c.saldo.lte(0) ? 0 : c.saldo.div(c.quantidade).floor().toNumber();
    if (!melhor || n < melhor.quantidade) melhor = { quantidade: n, limitadoPor: c.nome };
  }
  return melhor ?? { quantidade: null, limitadoPor: null };
}

// ---------------------------------------------------------------- Preço por quantidade (PDV 11.3, 11.3.1)

export type OrigemPreco =
  'embalagem' | 'promocional' | 'grupo_mix' | 'quantidade' | 'atacado' | 'loja' | 'varejo';

/** Desempate do PDV 11.3 (passo 6): embalagem > promocional > grupo_mix > quantidade > atacado > loja > varejo. */
const ORDEM_DESEMPATE: readonly OrigemPreco[] = [
  'embalagem',
  'promocional',
  'grupo_mix',
  'quantidade',
  'atacado',
  'loja',
  'varejo',
];

export interface FaixaPrecoCalculo {
  lojaId: string | null;
  quantidadeInicial: number;
  quantidadeFinal: number | null;
  preco: number;
}

export interface ProdutoPrecoCalculo {
  precoVenda: number;
  /** Preço da loja (`produtos_lojas.preco_venda`); vence o varejo como base. */
  precoLoja?: number | null;
  precoPromocional?: number | null;
  promocaoVigente?: boolean;
  precoAtacado?: number | null;
  qtdMinimaAtacado?: number | null;
  faixas?: readonly FaixaPrecoCalculo[];
  /** Grupo ativo do produto (mix). */
  grupo?: { modo: 'produto' | 'grupo'; faixas: readonly FaixaPrecoCalculo[] } | null;
}

export interface ParametrosPrecoCalculo {
  usaPrecoVolume: boolean;
  lojaId: string | null;
  tipoPreco?: 'varejo' | 'atacado';
}

export interface CandidatoPreco {
  origem: OrigemPreco;
  preco: number;
  limiar?: number;
}

/** Faixa que vale para a quantidade: a da loja prevalece sobre a geral; entre faixas que se tocam, a de maior início. */
export function faixaAplicavel(
  faixas: readonly FaixaPrecoCalculo[] | undefined,
  quantidade: number,
  lojaId: string | null,
): FaixaPrecoCalculo | null {
  if (!faixas?.length || !(quantidade > 0)) return null;
  // Limites inclusivos (PDV 11.3: `qtd_inicial ≤ Q ≤ qtd_final`, `FaixaPreco.Contem`); entre faixas que se tocam
  // (6–12 e 12+) vence a de maior início.
  const contem = (f: FaixaPrecoCalculo) =>
    quantidade >= f.quantidadeInicial && (f.quantidadeFinal === null || quantidade <= f.quantidadeFinal);
  const maior = (l: FaixaPrecoCalculo[]) =>
    l.reduce<FaixaPrecoCalculo | null>(
      (m, f) => (!m || f.quantidadeInicial > m.quantidadeInicial ? f : m),
      null,
    );
  return (
    (lojaId ? maior(faixas.filter((f) => f.lojaId === lojaId && contem(f))) : null) ??
    maior(faixas.filter((f) => f.lojaId === null && contem(f)))
  );
}

/**
 * Preço unitário da linha pela regra do PDV 11.3 (passos 3–6, sem preço manual, orçamento nem parcelado): o menor
 * candidato vale. `qtdTotal` é a soma do produto na venda; `qtdGrupo`, a soma de todos os membros do grupo (mix).
 */
export function resolverPreco(
  p: ProdutoPrecoCalculo,
  qtdTotal: number,
  qtdGrupo: number | null,
  parametros: ParametrosPrecoCalculo,
): { preco: number; origem: OrigemPreco; candidatos: CandidatoPreco[] } {
  const grupo = p.grupo ?? null;
  const somaDoGrupo = grupo !== null && qtdGrupo !== null;
  const q = somaDoGrupo && grupo.modo === 'produto' ? qtdGrupo : qtdTotal;
  const candidatos: CandidatoPreco[] = [
    p.precoLoja != null ? { origem: 'loja', preco: p.precoLoja } : { origem: 'varejo', preco: p.precoVenda },
  ];
  if (p.promocaoVigente && (p.precoPromocional ?? 0) > 0) {
    candidatos.push({ origem: 'promocional', preco: p.precoPromocional! });
  }
  if (parametros.usaPrecoVolume) {
    const f = faixaAplicavel(p.faixas, q, parametros.lojaId);
    if (f) candidatos.push({ origem: 'quantidade', preco: f.preco, limiar: f.quantidadeInicial });
  }
  if (parametros.usaPrecoVolume && somaDoGrupo && grupo.modo === 'grupo') {
    const f = faixaAplicavel(grupo.faixas, qtdGrupo, parametros.lojaId);
    if (f) candidatos.push({ origem: 'grupo_mix', preco: f.preco, limiar: f.quantidadeInicial });
  }
  if ((p.precoAtacado ?? 0) > 0) {
    if (parametros.tipoPreco === 'atacado') candidatos.push({ origem: 'atacado', preco: p.precoAtacado! });
    else if (p.qtdMinimaAtacado != null && q >= p.qtdMinimaAtacado) {
      candidatos.push({ origem: 'atacado', preco: p.precoAtacado!, limiar: p.qtdMinimaAtacado });
    }
  }
  const vencedor = [...candidatos].sort(
    (a, b) => a.preco - b.preco || ORDEM_DESEMPATE.indexOf(a.origem) - ORDEM_DESEMPATE.indexOf(b.origem),
  )[0]!;
  return { preco: vencedor.preco, origem: vencedor.origem, candidatos };
}

export interface LinhaSimulacaoGrupo {
  produtoId: string;
  nome: string;
  quantidade: number;
  produto: Omit<ProdutoPrecoCalculo, 'grupo'>;
}

/**
 * "Simular" do grupo de preço por quantidade (ERP 8.10): soma as quantidades de todos os membros e resolve o preço
 * de cada linha pela mesma regra do PDV. Grupo inativo = cada produto conta só a própria quantidade.
 */
export function simularGrupoPreco(
  grupo: { ativo: boolean; modo: 'produto' | 'grupo'; faixas: readonly FaixaPrecoCalculo[] },
  linhas: readonly LinhaSimulacaoGrupo[],
  parametros: ParametrosPrecoCalculo,
): Array<{
  produtoId: string;
  nome: string;
  quantidade: number;
  preco: number;
  origem: OrigemPreco;
  total: number;
}> {
  const qtdGrupo = decNumero(
    linhas.reduce((s, l) => s.plus(dec(l.quantidade)), dec(0)),
    3,
  );
  // Como no PDV, a quantidade do produto é a soma das linhas do mesmo produto na venda.
  const porProduto = new Map<string, Dec>();
  for (const l of linhas)
    porProduto.set(l.produtoId, (porProduto.get(l.produtoId) ?? dec(0)).plus(dec(l.quantidade)));
  return linhas.map((l) => {
    const r = resolverPreco(
      { ...l.produto, grupo: grupo.ativo ? { modo: grupo.modo, faixas: grupo.faixas } : null },
      decNumero(porProduto.get(l.produtoId)!, 3),
      grupo.ativo ? qtdGrupo : null,
      parametros,
    );
    return {
      ...l,
      preco: r.preco,
      origem: r.origem,
      total: decNumero(dec(r.preco).times(dec(l.quantidade)), 2),
    };
  });
}

export const ROTULOS_ORIGEM_PRECO: Record<OrigemPreco, string> = {
  embalagem: 'Embalagem',
  promocional: 'Promocional',
  grupo_mix: 'Mix (grupo)',
  quantidade: 'Faixa por quantidade',
  atacado: 'Atacado',
  loja: 'Preço da loja',
  varejo: 'Varejo',
};
