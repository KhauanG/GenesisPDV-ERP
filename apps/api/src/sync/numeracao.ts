/**
 * Numeração de venda e vale do caixa conferida pela nuvem (SYNC 13.1, 13.3; README da API › decisão 212). O número
 * que o terminal usa e o contador que ele informa no heartbeat só movem a numeração do caixa (`numeracoes`, a base da
 * ativação seguinte) dentro de uma margem acima do que a nuvem já conhece: o último número gravado em `numeracoes`
 * (a venda e a venda cancelada em andamento aplicadas, e o salto de cada ativação). A margem cobre o que o caixa vende
 * sem conseguir enviar (offline, lacuna, os saltos de +1000 de cada restauração do backup) com folga de anos.
 */
import { sql } from 'drizzle-orm';
import { limiteDoAmbiente } from '../comum/limites-processo.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Padrão de `NUMERACAO_MARGEM_CAIXA`: o quanto acima do último número conhecido o caixa ainda pode estar. */
export const MARGEM_NUMERACAO_CAIXA_PADRAO = 100_000;

/** `NUMERACAO_MARGEM_CAIXA` do ambiente (inteiro positivo) ou o padrão. */
export const margemNumeracaoCaixa = () =>
  limiteDoAmbiente('NUMERACAO_MARGEM_CAIXA', MARGEM_NUMERACAO_CAIXA_PADRAO);

/** O último número da numeração viva do caixa (`venda` ou `vale`) que a nuvem conhece; 0 sem a linha. */
export async function ultimoNumeroConhecido(
  tx: DbEmpresa,
  caixaId: string,
  tipo: 'venda' | 'vale',
): Promise<number> {
  const { rows } = await tx.execute<{ n: string | null }>(sql`
    select max(ultimo_numero)::text as n from numeracoes
     where tipo = ${tipo} and caixa_id = ${caixaId} and excluido_em is null`);
  return Number(rows[0]?.n ?? 0);
}

/** O número cabe na margem acima do conhecido (`conhecido + margem`, contado em `bigint`). */
export const dentroDaMargem = (numero: number, conhecido: number, margem = margemNumeracaoCaixa()) =>
  BigInt(numero) <= BigInt(conhecido) + BigInt(margem);
