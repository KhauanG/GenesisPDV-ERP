import { describe, expect, it } from 'vitest';
import { Cifra } from './cifra.js';

const chave = (n: number) => Buffer.alloc(32, n);

describe('Cifra (AES-256-GCM, MD 1.10)', () => {
  it('cifra e decifra no formato versão|nonce|ciphertext|tag', () => {
    const c = new Cifra(1, new Map([[1, chave(1)]]));
    const cifrado = c.cifrar('segredo do CSC', 'lojas.nfce_csc_cifrado');
    expect(cifrado[0]).toBe(1);
    expect(cifrado.length).toBe(1 + 12 + Buffer.byteLength('segredo do CSC') + 16);
    expect(c.decifrarTexto(cifrado, 'lojas.nfce_csc_cifrado')).toBe('segredo do CSC');
  });

  it('nonce aleatório: o mesmo valor gera cifras diferentes', () => {
    const c = new Cifra(1, new Map([[1, chave(1)]]));
    expect(c.cifrar('x').equals(c.cifrar('x'))).toBe(false);
  });

  it('recusa valor adulterado e contexto (AAD) diferente', () => {
    const c = new Cifra(1, new Map([[1, chave(1)]]));
    const cifrado = c.cifrar('abc', 'a');
    const adulterado = Buffer.from(cifrado);
    adulterado[14] = adulterado[14]! ^ 0xff;
    expect(() => c.decifrar(adulterado, 'a')).toThrow();
    expect(() => c.decifrar(cifrado, 'b')).toThrow();
  });

  it('rotação: decifra com a chave antiga indicada no 1º byte e cifra com a atual', () => {
    const antiga = new Cifra(1, new Map([[1, chave(1)]]));
    const cifradoAntigo = antiga.cifrar('valor');
    const nova = new Cifra(
      2,
      new Map([
        [1, chave(1)],
        [2, chave(2)],
      ]),
    );
    expect(nova.decifrarTexto(cifradoAntigo)).toBe('valor');
    expect(Cifra.versaoDe(nova.cifrar('valor'))).toBe(2);
    expect(() => new Cifra(2, new Map([[2, chave(2)]])).decifrar(cifradoAntigo)).toThrow(/versão 1/);
  });

  it('valida a chave', () => {
    expect(() => new Cifra(1, new Map([[1, Buffer.alloc(16)]]))).toThrow();
    expect(() => new Cifra(3, new Map([[1, chave(1)]]))).toThrow();
  });
});
