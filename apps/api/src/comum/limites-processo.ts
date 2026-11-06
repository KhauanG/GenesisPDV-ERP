/**
 * Limites de recurso do processo da API, que é compartilhado por todas as empresas: semáforo para operações caras
 * em memória/CPU (argon2 de 64 MiB, leitura de planilha) e limite de chamadas por chave em janela de 1 minuto (em
 * memória da instância, como o armazenamento do throttler). Um usuário autenticado não pode, sozinho, esgotar a
 * memória do processo.
 */
import { ErroApi } from './erros.js';

export class Semaforo {
  private emUso = 0;
  private readonly fila: (() => void)[] = [];

  constructor(private readonly limite: number) {}

  async executar<T>(fn: () => Promise<T>): Promise<T> {
    const liberar = await this.adquirir();
    try {
      return await fn();
    } finally {
      liberar();
    }
  }

  /**
   * A vaga, para quem não cabe num `executar` (o interceptor que segura a vaga até a resposta terminar): espera na
   * fila quando o semáforo está cheio e devolve a função que a libera (chamar mais de uma vez não libera de novo).
   */
  async adquirir(): Promise<() => void> {
    if (this.emUso >= this.limite) await new Promise<void>((r) => this.fila.push(r));
    else this.emUso++;
    let liberada = false;
    return () => {
      if (liberada) return;
      liberada = true;
      const proximo = this.fila.shift();
      if (proximo) proximo();
      else this.emUso--;
    };
  }
}

const usos = new Map<string, number[]>();

/** Até `limite` chamadas por `chave` por minuto; acima → 429 `LIMITE_TAXA` com `Retry-After`. */
export function garantirLimitePorMinuto(chave: string, limite: number, agora = Date.now()): void {
  const janela = (usos.get(chave) ?? []).filter((t) => agora - t < 60_000);
  if (janela.length >= limite) {
    usos.set(chave, janela);
    throw new ErroApi('LIMITE_TAXA', 'Muitas tentativas. Aguarde um minuto e tente de novo.', {
      cabecalhos: { 'Retry-After': '60' },
    });
  }
  janela.push(agora);
  usos.set(chave, janela);
  if (usos.size > 10_000) {
    for (const [k, v] of usos) if (!v.some((t) => agora - t < 60_000)) usos.delete(k);
  }
}

/** Inteiro positivo do ambiente ou o padrão. */
export const limiteDoAmbiente = (nome: string, padrao: number) =>
  Math.max(1, Math.trunc(Number(process.env[nome])) || padrao);
