import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { garantirLimitePorMinuto, limiteDoAmbiente, Semaforo } from '../comum/limites-processo.js';

/**
 * Semáforo do processo para o argon2 (o PIN usa 64 MiB por chamada): no máximo `ARGON2_CONCORRENCIA` (padrão 4)
 * hashes/verificações ao mesmo tempo, os demais esperam na fila. Sem ele, 50 requisições simultâneas de um único
 * usuário autenticado alocariam ~3 GB no processo compartilhado por todas as empresas.
 */
const semaforoArgon2 = new Semaforo(limiteDoAmbiente('ARGON2_CONCORRENCIA', 4));
const comLimiteArgon2 = <T>(fn: () => Promise<T>): Promise<T> => semaforoArgon2.executar(fn);

/**
 * Limite por usuário nas rotas que geram hash fora do login (PIN do PDV, senha do cliente, senha de liberação da
 * forma de pagamento): `HASH_LIMITE_POR_MINUTO` (padrão 10) por usuário e por minuto; acima → 429.
 */
export function garantirLimiteHash(chave: string): void {
  garantirLimitePorMinuto(`hash:${chave}`, limiteDoAmbiente('HASH_LIMITE_POR_MINUTO', 10));
}

/** Parâmetros argon2id (OWASP: m=19 MiB, t=2, p=1 é o mínimo; usamos um pouco acima). */
const OPCOES = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 3, parallelism: 1 } as const;

export function gerarHashSenha(senha: string): Promise<string> {
  return comLimiteArgon2(() => argon2.hash(senha, OPCOES));
}

export async function verificarSenha(hash: string | null | undefined, senha: string): Promise<boolean> {
  if (!hash) {
    // Mesmo custo quando não há usuário/hash: o tempo de resposta não revela se o login existe.
    const h = await hashFicticio();
    await comLimiteArgon2(() => argon2.verify(h, senha)).catch(() => false);
    return false;
  }
  try {
    return await comLimiteArgon2(() => argon2.verify(hash, senha));
  } catch {
    return false;
  }
}

let ficticio: Promise<string> | undefined;
function hashFicticio(): Promise<string> {
  ficticio ??= comLimiteArgon2(() => argon2.hash('senha-ficticia-para-tempo-constante', OPCOES));
  return ficticio;
}

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** Senha provisória legível (sem 0/O/1/l/I), sempre com letra e número para passar na política do ERP 4.2. */
export function gerarSenhaProvisoria(tamanho = 12): string {
  for (;;) {
    let s = '';
    for (let i = 0; i < tamanho; i++) s += ALFABETO[randomInt(ALFABETO.length)];
    if (/[A-Za-z]/.test(s) && /\d/.test(s)) return s;
  }
}

/**
 * PIN do PDV (SYNC 4.2): argon2id m = 64 MiB, t = 3, p = 1, sal de 16 bytes e hash de 32 — os parâmetros que o PDV
 * aceita e verifica offline com libsodium.
 */
export async function gerarHashPin(pin: string): Promise<string> {
  const h = await comLimiteArgon2(() =>
    argon2.hash(pin, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
    }),
  );
  // O node-argon2 escreve `m=,p=,t=`; o libsodium do PDV só lê a ordem canônica do PHC (`m=,t=,p=`, SYNC 4.2).
  return h.replace(/\$m=(\d+),p=(\d+),t=(\d+)\$/, (_, m, p, t) => `$m=${m},t=${t},p=${p}$`);
}
