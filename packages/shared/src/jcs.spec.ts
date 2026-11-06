/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jcs } from './jcs.js';

interface Vetor {
  descricao: string;
  entrada: unknown;
  saida: string;
  sha256: string;
}

const { vetores } = JSON.parse(
  readFileSync(new URL('../testes/jcs/vetores.json', import.meta.url), 'utf8'),
) as { vetores: Vetor[] };

describe('jcs (RFC 8785, SYNC 7.1)', () => {
  it.each(vetores.map((v) => [v.descricao, v] as const))('%s', (_, v) => {
    const saida = jcs(v.entrada);
    expect(saida).toBe(v.saida);
    expect(createHash('sha256').update(saida, 'utf8').digest('hex')).toBe(v.sha256);
  });

  it('recusa valores sem representação JSON', () => {
    expect(() => jcs(Number.NaN)).toThrow();
    expect(() => jcs({ a: () => 1 })).toThrow();
  });
});
