/**
 * Dinheiro e quantidade em decimal (ADR-05): `decimal.js` com arredondamento "meio para longe do zero"
 * (`ROUND_HALF_UP`), o mesmo `MidpointRounding.AwayFromZero` do `Arredondamento` do PDV (C# `decimal`). Ninguém faz
 * conta de dinheiro com `number`: as funções de `precos.ts` e `estoque.ts` convertem a entrada para `Dec`, calculam e
 * só no fim arredondam para as casas da coluna (2 dinheiro, 3 quantidade, 4 custo/preço unitário).
 */
import DecimalModulo from 'decimal.js';

// Com `NodeNext` o TypeScript lê a tipagem CJS do pacote (o padrão seria o módulo), mas em tempo de execução (Node
// ESM e Vite carregam `decimal.mjs`; o CJS faz `module.exports = Decimal`) o padrão é a própria classe.
const Decimal = DecimalModulo as unknown as typeof DecimalModulo.default;

export const Dec = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Dec = InstanceType<typeof Dec>;

/** Valor aceito pelas funções de cálculo: texto do `numeric` do banco/formulário ou número da tela. */
export type Valor = number | string | Dec;

/** Converte para `Dec`; vazio, `null` e texto inválido viram zero. */
export function dec(v: Valor | null | undefined): Dec {
  if (v === null || v === undefined || v === '') return new Dec(0);
  if (v instanceof Dec) return v;
  try {
    const d = new Dec(typeof v === 'string' ? v.trim().replace(',', '.') : v);
    return d.isFinite() ? d : new Dec(0);
  } catch {
    return new Dec(0);
  }
}

/** Arredonda para `casas` casas (meio para longe do zero) e devolve o texto fixo (`'3.50'`), pronto para o banco. */
export function decTexto(v: Valor, casas: number): string {
  return dec(v).toDecimalPlaces(casas).toFixed(casas);
}

/** Arredonda para `casas` casas e devolve `number` (só para exibir/comparar: o valor já está nas casas certas). */
export function decNumero(v: Valor, casas: number): number {
  return dec(v).toDecimalPlaces(casas).toNumber();
}
