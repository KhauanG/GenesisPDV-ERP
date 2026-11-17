import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { garantirLimitePorMinuto, limiteDoAmbiente, Semaforo } from '../comum/limites-processo.js';

/**
 * As duas filas do argon2 no processo (decisões 93 e 204). O argon2 custa memória (o PIN usa 64 MiB por chamada) e
 * CPU (centenas de ms), e o processo é de todas as empresas:
 *
 * - **geral** (`concorrencia`, `ARGON2_CONCORRENCIA`, padrão 4): no máximo isso de hashes/verificações ao mesmo tempo
 *   (sem ela, 50 requisições simultâneas de um usuário alocariam ~3 GB);
 * - **gestão** (os hashes fora do login: criar usuário, redefinir senha, PIN, senha do cliente e da forma de pagamento,
 *   troca de senha): passa antes por um semáforo de `concorrencia − 1` vagas, então na geral nunca há mais que isso de
 *   gestão (esperando ou calculando) e **sobra sempre uma vaga para a verificação do login**, que entra direto na
 *   geral. Com `concorrencia` 1 não há o que reservar (as duas dividem a única vaga);
 * - **limites da fila**: a espera em cada fila tem prazo (`esperaMaximaMs`) e a fila da gestão tem tamanho máximo
 *   (`filaMaximaGestao`); passou, `SISTEMA_OCUPADO` (503 com `Retry-After`) sem ter calculado nada, em vez de
 *   esperar sem fim. A verificação do login não tem tamanho de fila: o limite por IP e por conta das rotas de
 *   credenciais (`LimiteTaxaGuard`) já a segura, e o prazo corta o resto.
 */
export function criarFilasArgon2(
  concorrencia: number,
  opcoes: { esperaMaximaMs: number; filaMaximaGestao: number },
): { login: <T>(fn: () => Promise<T>) => Promise<T>; gestao: <T>(fn: () => Promise<T>) => Promise<T> } {
  const mensagemOcupado =
    'O sistema está conferindo muitas senhas agora. Nada foi feito: tente de novo em alguns segundos.';
  const geral = new Semaforo(concorrencia, { esperaMaximaMs: opcoes.esperaMaximaMs, mensagemOcupado });
  const gestao = new Semaforo(Math.max(1, concorrencia - 1), {
    filaMaxima: opcoes.filaMaximaGestao,
    esperaMaximaMs: opcoes.esperaMaximaMs,
    mensagemOcupado,
  });
  return {
    login: (fn) => geral.executar(fn),
    gestao: (fn) => gestao.executar(() => geral.executar(fn)),
  };
}

const filasArgon2 = criarFilasArgon2(limiteDoAmbiente('ARGON2_CONCORRENCIA', 4), {
  esperaMaximaMs: limiteDoAmbiente('ARGON2_ESPERA_MAXIMA_S', 20) * 1000,
  filaMaximaGestao: limiteDoAmbiente('ARGON2_FILA_MAXIMA', 16),
});

/**
 * Limite por usuário nas rotas que geram hash fora do login (criar usuário, redefinir a senha de outro, PIN do PDV,
 * senha do cliente, senha de liberação da forma de pagamento): `HASH_LIMITE_POR_MINUTO` (padrão 10) por usuário e por
 * minuto; acima → 429. Chamado depois das checagens baratas (o alvo existe, o login é único): o pedido que seria
 * recusado por elas não gasta o limite nem argon2 (decisão 204).
 */
export function garantirLimiteHash(chave: string): void {
  garantirLimitePorMinuto(`hash:${chave}`, limiteDoAmbiente('HASH_LIMITE_POR_MINUTO', 10));
}

/** Parâmetros argon2id (OWASP: m=19 MiB, t=2, p=1 é o mínimo; usamos um pouco acima). */
const OPCOES = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 3, parallelism: 1 } as const;

export function gerarHashSenha(senha: string): Promise<string> {
  return filasArgon2.gestao(() => argon2.hash(senha, OPCOES));
}

/**
 * Conferência da senha (login do ERP e do painel, troca de senha), na fila do login. Hash inválido é `false`; a fila
 * cheia (`SISTEMA_OCUPADO`) sobe como erro, igual com ou sem usuário: não conta como senha errada nem bloqueia a conta.
 */
export async function verificarSenha(hash: string | null | undefined, senha: string): Promise<boolean> {
  const conferir = (h: string) =>
    filasArgon2.login(async () => {
      try {
        return await argon2.verify(h, senha);
      } catch {
        return false;
      }
    });
  if (!hash) {
    // Mesmo custo quando não há usuário/hash: o tempo de resposta não revela se o login existe.
    await conferir(await hashFicticio());
    return false;
  }
  return conferir(hash);
}

let ficticio: Promise<string> | undefined;
function hashFicticio(): Promise<string> {
  ficticio ??= filasArgon2
    .login(() => argon2.hash('senha-ficticia-para-tempo-constante', OPCOES))
    .catch((erro: unknown) => {
      // A fila cheia na primeira vez não deixa o hash fictício quebrado para sempre: a próxima tenta de novo.
      ficticio = undefined;
      throw erro;
    });
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
  const h = await filasArgon2.gestao(() =>
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
