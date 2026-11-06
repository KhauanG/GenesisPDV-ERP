import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifra de segredos com AES-256-GCM e chave mestra fora do banco (MD 1.10).
 * Formato: `versao_chave (1 byte) | nonce (12) | ciphertext | tag (16)`. A versão permite rotacionar a chave:
 * cifra sempre com a atual e decifra com a que estiver indicada no primeiro byte.
 */
export class Cifra {
  constructor(
    private readonly versaoAtual: number,
    private readonly chaves: ReadonlyMap<number, Buffer>,
  ) {
    if (!chaves.has(versaoAtual)) throw new Error('Chave mestra atual não configurada');
    for (const [versao, chave] of chaves) {
      if (versao < 1 || versao > 255) throw new Error('Versão de chave deve estar entre 1 e 255');
      if (chave.length !== 32) throw new Error('Chave mestra deve ter 32 bytes');
    }
  }

  /** `contexto` (ex.: "admins_plataforma.totp_segredo_cifrado") entra como AAD: um valor não serve em outra coluna. */
  cifrar(valor: Buffer | string, contexto = ''): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.chaves.get(this.versaoAtual)!, nonce);
    cipher.setAAD(Buffer.from(contexto, 'utf8'));
    const dados = Buffer.concat([
      cipher.update(typeof valor === 'string' ? Buffer.from(valor, 'utf8') : valor),
      cipher.final(),
    ]);
    return Buffer.concat([Buffer.from([this.versaoAtual]), nonce, dados, cipher.getAuthTag()]);
  }

  decifrar(cifrado: Buffer, contexto = ''): Buffer {
    if (cifrado.length < 1 + 12 + 16) throw new Error('Valor cifrado inválido');
    const versao = cifrado[0]!;
    const chave = this.chaves.get(versao);
    if (!chave) throw new Error(`Chave mestra versão ${versao} indisponível`);
    const decipher = createDecipheriv('aes-256-gcm', chave, cifrado.subarray(1, 13));
    decipher.setAAD(Buffer.from(contexto, 'utf8'));
    decipher.setAuthTag(cifrado.subarray(cifrado.length - 16));
    return Buffer.concat([decipher.update(cifrado.subarray(13, cifrado.length - 16)), decipher.final()]);
  }

  decifrarTexto(cifrado: Buffer, contexto = ''): string {
    return this.decifrar(cifrado, contexto).toString('utf8');
  }

  /** Versão da chave usada num valor (para a rotina de recifragem após rotação). */
  static versaoDe(cifrado: Buffer): number {
    return cifrado[0]!;
  }
}
