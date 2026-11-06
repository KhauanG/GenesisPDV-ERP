import { describe, expect, it } from 'vitest';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojas } from '../database/empresa/schema/index.js';
import { filtroLojas, garantirLoja, lojaPermitida } from './lojas.js';

const sessao = (l: string[] | null) => ({ lojas: l }) as unknown as SessaoErp;

describe('filtro por lojas permitidas', () => {
  it('master não tem filtro; lista vazia não vê nada; demais filtram por loja', () => {
    expect(filtroLojas(sessao(null), lojas.id)).toBeUndefined();
    expect(filtroLojas(sessao([]), lojas.id)).toBeDefined();
    expect(lojaPermitida(sessao(['a']), 'a')).toBe(true);
    expect(lojaPermitida(sessao(['a']), 'b')).toBe(false);
    expect(lojaPermitida(sessao(['a']), null)).toBe(false);
    expect(lojaPermitida(sessao(null), 'qualquer')).toBe(true);
    expect(() => garantirLoja(sessao(['a']), 'b')).toThrow('Você não tem acesso a esta loja.');
  });
});
