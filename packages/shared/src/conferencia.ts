/**
 * Relatório de conferência do "Definir" (Fase 2, F2-B11; F2-Q6 = D47, decidida pelo dono em 05/11/2026, ajustável; ERP 13.5):
 * contado × saldo do sistema na hora da contagem × diferença valorizada a custo, com o veredito pela tolerância.
 *
 * Critério (F2-Q6 (a)), sempre em percentual e valor, nunca em unidades (há venda a granel e por kg):
 * - **total**: a soma dos módulos das diferenças a custo (a sobra de um item não paga a falta de outro) até
 *   `estoque.tolerancia_conferencia_total_pct` (padrão 1%) do valor contado a custo;
 * - **item**: nenhum item com a diferença acima de `estoque.tolerancia_conferencia_item_pct` (padrão 5%) do próprio
 *   saldo do sistema. Item com saldo do sistema zero e diferença diferente de zero não tem percentual e fica fora.
 *
 * As contas são em decimal (ADR-05) e a função é pura: a API calcula com ela e a tela só mostra.
 */
import { z } from 'zod';
import { dec, decTexto, type Dec, type Valor } from './decimal.js';

export const CHAVE_TOLERANCIA_CONFERENCIA_TOTAL = 'estoque.tolerancia_conferencia_total_pct';
export const CHAVE_TOLERANCIA_CONFERENCIA_ITEM = 'estoque.tolerancia_conferencia_item_pct';
/** Padrões do catálogo de configurações (F2-Q6 (a)). */
export const TOLERANCIA_CONFERENCIA_TOTAL_PADRAO = '1';
export const TOLERANCIA_CONFERENCIA_ITEM_PADRAO = '5';

const percentualQuery = z
  .string()
  .trim()
  .regex(/^\d{1,3}([.,]\d{1,4})?$/, 'Percentual inválido')
  .transform((v) => v.replace(',', '.'))
  .refine((v) => Number(v) <= 100, 'No máximo 100%');

/**
 * `GET /acertos/:id/conferencia`: os limites podem ser trocados na consulta, só para ela (vazio = o configurado em
 * Configurações › Estoque).
 */
export const filtroConferenciaSchema = z.object({
  toleranciaTotalPct: z.preprocess((v) => (v === '' ? undefined : v), percentualQuery.optional()),
  toleranciaItemPct: z.preprocess((v) => (v === '' ? undefined : v), percentualQuery.optional()),
});
export type FiltroConferencia = z.output<typeof filtroConferenciaSchema>;

export type VereditoConferencia = 'conferido' | 'fora_tolerancia';
export const ROTULOS_VEREDITO_CONFERENCIA: Record<VereditoConferencia, string> = {
  conferido: 'Conferido',
  fora_tolerancia: 'Fora da tolerância',
};

/** O que a conta recebe de cada item (texto do `numeric` ou `Dec`). */
export interface EntradaConferencia {
  contado: Valor;
  saldoSistema: Valor;
  custoUnitario: Valor;
}

export interface ItemConferenciaCalculado {
  /** `contado − saldoSistema` (3 casas). */
  diferenca: string;
  /** Contado a custo (2 casas). */
  valorContado: string;
  /** Saldo do sistema a custo (2 casas). */
  valorSistema: string;
  /** Diferença a custo, com sinal (2 casas). */
  valorDiferenca: string;
  /** `|diferença| / |saldo do sistema|` em % (2 casas); `null` com saldo do sistema zero e diferença ≠ 0. */
  diferencaPct: string | null;
  foraTolerancia: boolean;
}

export interface TotaisConferencia {
  /** Σ |contado| a custo: a base do critério total (a contagem negativa do Nuvem3 entra pelo módulo). */
  valorContado: string;
  valorSistema: string;
  /** Σ diferenças a custo, com sinal (sobra − falta). */
  valorDiferenca: string;
  /** Σ |diferenças| a custo: o que o critério total compara. */
  valorDiferencaAbsoluta: string;
  /** `valorDiferencaAbsoluta / valorContado` em %; `null` com nada contado a custo e alguma diferença. */
  diferencaTotalPct: string | null;
  totalForaTolerancia: boolean;
  itensForaTolerancia: number;
  veredito: VereditoConferencia;
}

/** `parte / base` em % exato (sem arredondar); `null` com base zero e parte ≠ 0. */
const percentual = (parte: Dec, base: Dec): Dec | null =>
  base.isZero() ? (parte.isZero() ? dec(0) : null) : parte.div(base).times(100);

/**
 * Fora do limite: sem percentual, ou o percentual **exato** acima dele. O texto de 2 casas é só para mostrar: 5,004%
 * vira "5,00", mas está acima de 5% (no limite exato, dentro).
 */
const acimaDe = (p: Dec | null, limite: Dec): boolean => p === null || p.gt(limite);
const pctTexto = (p: Dec | null): string | null => (p === null ? null : decTexto(p, 2));

/** Calcula cada item e o veredito (F2-Q6 (a)). Os limites são percentuais (`'1'` = 1%). */
export function avaliarConferencia(
  itens: readonly EntradaConferencia[],
  tolerancias: { totalPct: Valor; itemPct: Valor },
): { itens: ItemConferenciaCalculado[]; totais: TotaisConferencia } {
  const limiteItem = dec(tolerancias.itemPct);
  const limiteTotal = dec(tolerancias.totalPct);
  let contadoTotal = dec(0);
  let sistemaTotal = dec(0);
  let diferencaTotal = dec(0);
  let diferencaAbsoluta = dec(0);
  let foraItens = 0;
  const calculados = itens.map((i) => {
    const contado = dec(i.contado);
    const sistema = dec(i.saldoSistema);
    const custo = dec(i.custoUnitario);
    const diferenca = contado.minus(sistema);
    // Arredonda o valor de cada item antes de somar: o total é a soma das linhas que a tela mostra.
    const valorContado = dec(decTexto(contado.times(custo), 2));
    const valorSistema = dec(decTexto(sistema.times(custo), 2));
    const valorDiferenca = dec(decTexto(diferenca.times(custo), 2));
    contadoTotal = contadoTotal.plus(valorContado.abs());
    sistemaTotal = sistemaTotal.plus(valorSistema);
    diferencaTotal = diferencaTotal.plus(valorDiferenca);
    diferencaAbsoluta = diferencaAbsoluta.plus(valorDiferenca.abs());
    const p = percentual(diferenca.abs(), sistema.abs());
    const fora = acimaDe(p, limiteItem);
    if (fora) foraItens++;
    return {
      diferenca: decTexto(diferenca, 3),
      valorContado: decTexto(valorContado, 2),
      valorSistema: decTexto(valorSistema, 2),
      valorDiferenca: decTexto(valorDiferenca, 2),
      diferencaPct: pctTexto(p),
      foraTolerancia: fora,
    };
  });
  const pTotal = percentual(diferencaAbsoluta, contadoTotal);
  const totalFora = acimaDe(pTotal, limiteTotal);
  return {
    itens: calculados,
    totais: {
      valorContado: decTexto(contadoTotal, 2),
      valorSistema: decTexto(sistemaTotal, 2),
      valorDiferenca: decTexto(diferencaTotal, 2),
      valorDiferencaAbsoluta: decTexto(diferencaAbsoluta, 2),
      diferencaTotalPct: pctTexto(pTotal),
      totalForaTolerancia: totalFora,
      itensForaTolerancia: foraItens,
      veredito: totalFora || foraItens > 0 ? 'fora_tolerancia' : 'conferido',
    },
  };
}

/** Um item do relatório (os valores a custo são `null` sem `produtos.ver_custo`; os percentuais vêm sempre). */
export interface ItemConferencia {
  itemId: string;
  produtoId: string;
  produtoCodigo: number;
  produtoNome: string;
  unidadeSigla: string;
  contado: string;
  /**
   * Saldo do sistema na hora da contagem. Efetivado: o saldo usado na efetivação menos os movimentos posteriores à
   * contagem, e menos o que as compensações deste "Definir" anularam (a venda offline anterior à contagem que chegou
   * depois: o sistema "na hora" já devia tê-la). Rascunho: estimativa com o saldo atual (ERP 13.1.5).
   */
  saldoSistema: string;
  /** O que as compensações lançadas por este "Definir" somaram no item (0 no rascunho). */
  compensado: string;
  diferenca: string;
  custoUnitario: string | null;
  valorContado: string | null;
  valorSistema: string | null;
  valorDiferenca: string | null;
  diferencaPct: string | null;
  foraTolerancia: boolean;
}

export interface ConferenciaAcerto {
  acertoId: string;
  codigo: number;
  estoqueNome: string;
  tipoEstoqueNome: string;
  dataContagem: string;
  /** `true` no rascunho: o saldo do sistema é o de agora, e a efetivação pode mudar o resultado. */
  estimativa: boolean;
  /** Limites usados (os configurados, ou os da consulta). */
  toleranciaTotalPct: string;
  toleranciaItemPct: string;
  /** Totais a custo `null` sem `produtos.ver_custo` (o percentual e o veredito vêm sempre). */
  valorContado: string | null;
  valorSistema: string | null;
  valorDiferenca: string | null;
  valorDiferencaAbsoluta: string | null;
  diferencaTotalPct: string | null;
  totalForaTolerancia: boolean;
  itensForaTolerancia: number;
  veredito: VereditoConferencia;
  /** Os fora da tolerância primeiro, depois pela maior diferença em percentual (e a custo). */
  itens: ItemConferencia[];
}
