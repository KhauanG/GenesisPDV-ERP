import { generate, generateSecret, generateURI, verify } from 'otplib';

export const PERIODO_TOTP_S = 30;

export function gerarSegredoTotp(): string {
  return generateSecret();
}

export function uriTotp(email: string, segredo: string): string {
  return generateURI({ issuer: 'Genesis Plataforma', label: email, secret: segredo });
}

/**
 * Confere o código no passo atual e num vizinho (relógio do celular adiantado/atrasado até 30 s) e devolve o passo
 * (contador de 30 s) que casou, ou `null`. Com `aposPasso`, recusa qualquer passo ≤ ele: um código aceito não pode
 * ser usado de novo, nem um mais antigo (proteção contra repetição).
 */
export async function verificarTotp(
  segredo: string,
  codigo: string,
  aposPasso?: number | null,
): Promise<number | null> {
  try {
    const r = await verify({
      secret: segredo,
      token: codigo,
      epochTolerance: PERIODO_TOTP_S,
      ...(aposPasso !== null && aposPasso !== undefined ? { afterTimeStep: aposPasso } : {}),
    });
    return r.valid ? ((r as { timeStep?: number }).timeStep ?? null) : null;
  } catch {
    return null;
  }
}

/** Código do passo atual, ou de `passosAFrente` passos adiante (testes que entram várias vezes na mesma janela). */
export function gerarCodigoTotp(segredo: string, passosAFrente = 0): Promise<string> {
  return generate({
    secret: segredo,
    epoch: Math.floor(Date.now() / 1000) + passosAFrente * PERIODO_TOTP_S,
  });
}
