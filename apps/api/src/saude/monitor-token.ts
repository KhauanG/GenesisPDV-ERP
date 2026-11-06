/**
 * Token de monitoramento do `GET /api/saude/detalhada` (Implantação do piloto, I1b): só leitura, só esta rota. O
 * ambiente guarda apenas o SHA-256 do token (`MONITOR_TOKEN_SHA256`); a comparação é em tempo constante sobre os
 * hashes (mesmo tamanho sempre). O limite por IP vem antes da conferência: tentativas com token errado também gastam
 * a cota (força bruta lenta e barulhenta no log).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { ErroApi } from '../comum/erros.js';
import { garantirLimitePorMinuto, limiteDoAmbiente } from '../comum/limites-processo.js';
import type { RequisicaoGenesis } from '../comum/requisicao.js';

/** Padrão do `MONITOR_LIMITE_POR_MINUTO`: um monitor consulta a cada minuto ou menos; folga para repetições. */
export const MONITOR_LIMITE_PADRAO = 30;

export function hashTokenMonitor(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function tokenMonitorConfere(recebido: string | null, esperado: Buffer | null): boolean {
  if (!esperado || esperado.length !== 32 || !recebido) return false;
  return timingSafeEqual(hashTokenMonitor(recebido), esperado);
}

function tokenDaRequisicao(req: RequisicaoGenesis): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(\S{1,512})$/i);
  return m ? m[1]! : null;
}

/** 429 acima do limite por IP; 401 sem token, com token errado ou sem `MONITOR_TOKEN_SHA256` configurado. */
export function autorizarMonitor(req: RequisicaoGenesis, esperado: Buffer | null): void {
  garantirLimitePorMinuto(
    `monitor:${req.ip ?? 'desconhecido'}`,
    limiteDoAmbiente('MONITOR_LIMITE_POR_MINUTO', MONITOR_LIMITE_PADRAO),
  );
  if (!tokenMonitorConfere(tokenDaRequisicao(req), esperado)) {
    throw ErroApi.naoAutenticado('Token de monitoramento ausente ou inválido.');
  }
}
