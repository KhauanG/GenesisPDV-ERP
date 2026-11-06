import { dec, decTexto } from './decimal.js';

/**
 * Gerador de casos das suítes de propriedade (`estoque.propriedade.spec.ts`, `recebimentos.spec.ts`): mulberry32,
 * pequeno, determinístico e bom o bastante para gerar casos com semente fixa, sem dependência nova. Fica fora do
 * build (`tsconfig.build.json` exclui `*.teste.ts`).
 */
export function gerador(semente: number) {
  let a = semente >>> 0;
  const proximo = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const inteiro = (min: number, max: number) => min + Math.floor(proximo() * (max - min + 1));
  return {
    inteiro,
    /** Decimal com `casas` casas, até `max`: positivo, ou a partir de zero com `comZero`. */
    decimal: (max: number, casas: number, comZero = false) =>
      decTexto(dec(inteiro(comZero ? 0 : 1, max * 10 ** casas)).div(10 ** casas), casas),
    escolher: <T>(lista: readonly T[]) => lista[inteiro(0, lista.length - 1)]!,
  };
}
