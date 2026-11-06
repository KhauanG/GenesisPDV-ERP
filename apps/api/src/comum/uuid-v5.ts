/**
 * UUID versão 5 (RFC 9562 §5.5: SHA-1 do namespace + nome): o mesmo nome dá sempre o mesmo id. Usado onde a nuvem
 * precisa de um id determinístico para uma linha que o PDV não identifica (Fase 1C, T4: o `documento_item_id` dos
 * movimentos do bloco `vasilhames` da venda, que entram no `uq_movimentos_estoque_idempotencia`).
 */
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidv5(nome: string, namespace: string): string {
  if (!UUID.test(namespace)) throw new Error(`Namespace UUID inválido: ${namespace}`);
  const h = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(nome, 'utf8')
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
