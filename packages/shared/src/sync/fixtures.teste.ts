/// <reference types="node" />
import { readFileSync } from 'node:fs';

/**
 * Apoio das suítes de contrato (`contratos.spec.ts`, `eventos.spec.ts`): as duas leem as mesmas fixtures e usam o
 * mesmo detector de chave descartada, para uma correção dele não valer só numa delas. Fica fora do build
 * (`tsconfig.build.json` exclui `*.teste.ts`).
 */
export const pastaFixturesSync = new URL('../../testes/sync/', import.meta.url);

/** Fixture de `packages/shared/testes/sync` já com o parse do JSON. */
export const lerFixtureSync = <T = unknown>(nome: string): T =>
  JSON.parse(readFileSync(new URL(nome, pastaFixturesSync), 'utf8')) as T;

/**
 * Caminhos das chaves da entrada que não chegaram à saída do parse, em qualquer nível: o `z.object` tolerante descarta
 * a chave desconhecida calado, então uma chave com nome errado na fixture (e no lado C#, que concorda com ela) passaria
 * nos dois lados e sumiria no envio real.
 */
export function chavesDescartadas(entrada: unknown, saida: unknown, caminho = ''): string[] {
  if (Array.isArray(entrada) && Array.isArray(saida)) {
    return entrada.flatMap((v, i) => chavesDescartadas(v, saida[i], `${caminho}[${i}]`));
  }
  if (!entrada || typeof entrada !== 'object' || !saida || typeof saida !== 'object') return [];
  return Object.entries(entrada).flatMap(([chave, valor]) => {
    const sub = caminho ? `${caminho}.${chave}` : chave;
    return chave in saida ? chavesDescartadas(valor, (saida as Record<string, unknown>)[chave], sub) : [sub];
  });
}
