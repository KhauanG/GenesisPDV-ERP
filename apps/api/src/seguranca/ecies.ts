import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export type AlgoritmoChaveTerminal = 'x25519' | 'p256';

const VERSAO = 1;
const INFO = Buffer.from('genesis-ecies-v1', 'utf8');

/**
 * Envelope ECIES para segredos que descem ao PDV (MD 1.10; SYNC 3.2, 20.2): chave efêmera da mesma curva da chave do
 * terminal, ECDH, HKDF-SHA256 (sal = chave pública efêmera em SPKI DER, info `genesis-ecies-v1`) e AES-256-GCM.
 * Formato: `versao(1) | tamanho da SPKI efêmera (2, big-endian) | SPKI DER efêmera | nonce(12) | cifra | tag(16)`.
 * O PDV decifra com a privada não exportável que gerou na ativação.
 */
export function cifrarParaTerminal(
  chavePublicaSpkiDer: Buffer,
  algoritmo: AlgoritmoChaveTerminal,
  dados: Buffer,
): Buffer {
  const destino = lerChavePublica(chavePublicaSpkiDer, algoritmo);
  const efemera =
    algoritmo === 'x25519'
      ? generateKeyPairSync('x25519')
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = efemera.publicKey.export({ type: 'spki', format: 'der' });
  const segredo = diffieHellman({ privateKey: efemera.privateKey, publicKey: destino });
  const chave = Buffer.from(hkdfSync('sha256', segredo, spki, INFO, 32));
  const nonce = randomBytes(12);
  const cifra = createCipheriv('aes-256-gcm', chave, nonce);
  const corpo = Buffer.concat([cifra.update(dados), cifra.final()]);
  const tamanho = Buffer.alloc(2);
  tamanho.writeUInt16BE(spki.length);
  return Buffer.concat([Buffer.from([VERSAO]), tamanho, spki, nonce, corpo, cifra.getAuthTag()]);
}

/** Lado do PDV (aqui só para testes e para a documentação do formato). */
export function decifrarDoTerminal(envelope: Buffer, privada: KeyObject): Buffer {
  if (envelope[0] !== VERSAO) throw new Error('Versão de envelope ECIES desconhecida');
  const tamanho = envelope.readUInt16BE(1);
  const spki = envelope.subarray(3, 3 + tamanho);
  const nonce = envelope.subarray(3 + tamanho, 15 + tamanho);
  const corpo = envelope.subarray(15 + tamanho, envelope.length - 16);
  const efemera = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const segredo = diffieHellman({ privateKey: privada, publicKey: efemera });
  const chave = Buffer.from(hkdfSync('sha256', segredo, spki, INFO, 32));
  const decifra = createDecipheriv('aes-256-gcm', chave, nonce);
  decifra.setAuthTag(envelope.subarray(envelope.length - 16));
  return Buffer.concat([decifra.update(corpo), decifra.final()]);
}

/** Confere que a SPKI é uma chave pública válida do algoritmo declarado. */
export function lerChavePublica(spkiDer: Buffer, algoritmo: AlgoritmoChaveTerminal): KeyObject {
  const chave = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const ok =
    algoritmo === 'x25519'
      ? chave.asymmetricKeyType === 'x25519'
      : chave.asymmetricKeyType === 'ec' && chave.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  if (!ok) throw new Error(`Chave pública não é ${algoritmo}`);
  return chave;
}
