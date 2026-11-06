import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(valor: string | Buffer): string {
  return createHash('sha256').update(valor).digest('hex');
}

/** Segredo de alta entropia (refresh token, token de terminal): 32 bytes em base64url. */
export function gerarSegredo(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function iguaisTempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
