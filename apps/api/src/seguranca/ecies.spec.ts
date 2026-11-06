import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cifrarParaTerminal, decifrarDoTerminal, lerChavePublica } from './ecies.js';

describe('envelope ECIES para o terminal (MD 1.10)', () => {
  it.each(['x25519', 'p256'] as const)('%s: só a privada do terminal abre', (algoritmo) => {
    const par =
      algoritmo === 'x25519'
        ? generateKeyPairSync('x25519')
        : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = par.publicKey.export({ type: 'spki', format: 'der' });
    const segredo = Buffer.from('chave de backup de 32 bytes!!!!!');
    const envelope = cifrarParaTerminal(spki, algoritmo, segredo);
    expect(envelope.includes(segredo)).toBe(false);
    expect(decifrarDoTerminal(envelope, par.privateKey)).toEqual(segredo);
    const outro =
      algoritmo === 'x25519'
        ? generateKeyPairSync('x25519')
        : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(() => decifrarDoTerminal(envelope, outro.privateKey)).toThrow();
  });

  it('recusa chave pública de outro algoritmo', () => {
    const x = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' });
    expect(() => lerChavePublica(x, 'p256')).toThrow(/p256/);
  });

  it('vetores de packages/shared/testes/ecies (os que o PDV decifra) abrem com a privada do vetor', () => {
    // Os mesmos envelopes passam pelo `Ecies.Decifrar` do PDV (GenesisPDV.Sync.Tests/CriptografiaTests).
    const vetores = JSON.parse(
      readFileSync(new URL('../../../../packages/shared/testes/ecies/vetores.json', import.meta.url), 'utf8'),
    ) as { casos: Array<{ privada_pkcs8: string; envelope: string; claro: string }> };
    expect(vetores.casos.length).toBeGreaterThan(0);
    for (const c of vetores.casos) {
      const privada = createPrivateKey({
        key: Buffer.from(c.privada_pkcs8, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
      expect(decifrarDoTerminal(Buffer.from(c.envelope, 'base64'), privada)).toEqual(
        Buffer.from(c.claro, 'base64'),
      );
    }
  });
});
