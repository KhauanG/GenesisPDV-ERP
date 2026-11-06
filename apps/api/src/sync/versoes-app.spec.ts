import { describe, expect, it } from 'vitest';
import { compararVersoes } from './versoes-app.js';

describe('compararVersoes', () => {
  it('ordena SemVer numericamente, com pré-lançamento antes da final', () => {
    const lista = ['1.10.0', '1.2.0', '1.4.2', '1.4.2-beta.1', '0.9.9', '1.4.10'];
    expect([...lista].sort(compararVersoes)).toEqual([
      '0.9.9',
      '1.2.0',
      '1.4.2-beta.1',
      '1.4.2',
      '1.4.10',
      '1.10.0',
    ]);
    expect(compararVersoes('1.4.2', '1.4.2')).toBe(0);
  });
});
