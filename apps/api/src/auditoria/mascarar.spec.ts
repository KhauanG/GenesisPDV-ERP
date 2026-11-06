import { describe, expect, it } from 'vitest';
import { mascararSensiveis, semSegredos } from './mascarar.js';

describe('mascararSensiveis', () => {
  it('mascara hashes, segredos e bytea em qualquer nível; preserva o resto', () => {
    const r = mascararSensiveis({
      nome: 'Loja',
      senhaHash: 'x',
      senha_pdv_hash: null,
      nfce_csc_cifrado: Buffer.from('a'),
      itens: [{ token: 't', valor: '1.00' }],
      criado: new Date('2026-10-29T00:00:00Z'),
    });
    expect(r).toEqual({
      nome: 'Loja',
      senhaHash: '***',
      senha_pdv_hash: null,
      nfce_csc_cifrado: '***',
      itens: [{ token: '***', valor: '1.00' }],
      criado: '2026-10-29T00:00:00.000Z',
    });
  });

  it('semSegredos remove colunas de segredo, inclusive as que ainda não existem', () => {
    expect(
      semSegredos({
        nome: 'Loja',
        nfceCscId: '000001',
        nfceCscCifrado: Buffer.from('x'),
        certificadoSenhaCifrada: 1,
        ifoodToken: 't',
      }),
    ).toEqual({ nome: 'Loja', nfceCscId: '000001' });
  });
});
