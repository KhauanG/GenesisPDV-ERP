/**
 * Limites de recurso do processo da API, que é compartilhado por todas as empresas: semáforo para operações caras
 * em memória/CPU (argon2 de 64 MiB, leitura de planilha) e limite de chamadas por chave em janela de 1 minuto (em
 * memória da instância, como o armazenamento do throttler), a fila do semáforo limitada em tamanho ou em espera e a
 * admissão por chave (quantos em andamento por usuário/empresa). Um usuário autenticado não pode, sozinho, esgotar a
 * memória do processo nem pôr na fila, na frente das outras empresas, um trabalho sem fim.
 */
import { defer, finalize, mergeMap, type Observable } from 'rxjs';
import { ErroApi } from './erros.js';

/**
 * Até onde a fila de um `Semaforo` pode crescer (README da API › decisão 204). Sem nenhum dos dois, a fila não tem
 * limite: é o caso dos semáforos cuja fila já é limitada por quem entra nela (os contadores de envios por usuário e
 * por empresa, a fila das tarefas).
 */
export interface OpcoesSemaforo {
  /** Quantos podem esperar ao mesmo tempo; quem chega com a fila cheia recebe `SISTEMA_OCUPADO` (503) na hora. */
  filaMaxima?: number;
  /** Espera máxima na fila (ms); passou dela, o pedido sai da fila com `SISTEMA_OCUPADO` (503). */
  esperaMaximaMs?: number;
  /** A mensagem do 503 (o padrão serve para qualquer tela). */
  mensagemOcupado?: string;
}

/** Quem espera a vaga: `acordar` entrega a vaga (que passa direto de quem soltou para ele). */
interface Espera {
  acordar: () => void;
}

/** O 503 do semáforo cheio: nada foi feito, e dá para tentar de novo em alguns segundos. */
function erroOcupado(mensagem?: string): ErroApi {
  return new ErroApi(
    'SISTEMA_OCUPADO',
    mensagem ?? 'O sistema está ocupado no momento. Nada foi feito: tente de novo em alguns segundos.',
    { cabecalhos: { 'Retry-After': '5' } },
  );
}

export class Semaforo {
  private emUso = 0;
  private readonly fila: Espera[] = [];

  constructor(
    readonly limite: number,
    private readonly opcoes: OpcoesSemaforo = {},
  ) {}

  /** Quantos estão esperando a vaga agora (para os testes). */
  get esperando(): number {
    return this.fila.length;
  }

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
   * Com `filaMaxima`/`esperaMaximaMs` (decisão 204), a fila cheia ou a espera vencida rejeita com `SISTEMA_OCUPADO`
   * sem ter pego vaga nenhuma (não há o que soltar).
   */
  async adquirir(): Promise<() => void> {
    if (this.emUso < this.limite) this.emUso++;
    else await this.esperarVaga();
    let liberada = false;
    return () => {
      if (liberada) return;
      liberada = true;
      const proximo = this.fila.shift();
      if (proximo) proximo.acordar();
      else this.emUso--;
    };
  }

  private esperarVaga(): Promise<void> {
    const { filaMaxima, esperaMaximaMs, mensagemOcupado } = this.opcoes;
    if (filaMaxima !== undefined && this.fila.length >= filaMaxima) {
      return Promise.reject(erroOcupado(mensagemOcupado));
    }
    return new Promise<void>((resolver, rejeitar) => {
      let prazo: NodeJS.Timeout | undefined;
      const espera: Espera = {
        acordar: () => {
          if (prazo) clearTimeout(prazo);
          resolver();
        },
      };
      this.fila.push(espera);
      if (esperaMaximaMs !== undefined) {
        prazo = setTimeout(() => {
          // Ainda na fila (quem foi acordado já saiu dela e teve o prazo cancelado): sai sem vaga.
          const i = this.fila.indexOf(espera);
          if (i < 0) return;
          this.fila.splice(i, 1);
          rejeitar(erroOcupado(mensagemOcupado));
        }, esperaMaximaMs);
        prazo.unref();
      }
    });
  }
}

/**
 * A resposta de `executar` com uma vaga do `semaforo`, pega antes e solta quando a resposta termina, com erro ou não (os
 * interceptors `VagaEnvioNfe` e `VagaEnvioArquivo`, decisões 189 e 202). Cancelada enquanto ainda espera na fila, a
 * vaga que chegar depois é devolvida na hora: ela nunca fica presa sem ninguém para soltar. É defesa: hoje nada cancela
 * quem espera aqui (o corpo já foi lido, então o prazo de leitura não corta, e a desconexão do cliente não cancela a
 * resposta); a fila fica limitada pelos limites de envios simultâneos por empresa e por usuário.
 */
export function comVaga<T>(semaforo: Semaforo, executar: () => Observable<T>): Observable<T> {
  let liberar: (() => void) | undefined;
  let encerrada = false;
  return defer(async () => {
    const vaga = await semaforo.adquirir();
    if (encerrada) vaga();
    else liberar = vaga;
  }).pipe(
    mergeMap(() => executar()),
    finalize(() => {
      encerrada = true;
      liberar?.();
    }),
  );
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

const emAndamento = new Map<string, number>();

/**
 * Admissão por chave (decisão 204; o mesmo desenho dos envios de NF-e e de arquivos): mais um em andamento na `chave`
 * se couber em `limite`, senão lança `erro()`; devolve quem o tira (chamar mais de uma vez não tira de novo). É conferida
 * antes do trabalho caro (ler linhas, gerar o arquivo), e o que passa do limite volta na hora, sem esperar fila.
 */
export function entrarEmAndamento(chave: string, limite: number, erro: () => ErroApi): () => void {
  const n = emAndamento.get(chave) ?? 0;
  if (n >= limite) throw erro();
  emAndamento.set(chave, n + 1);
  let tirado = false;
  return () => {
    if (tirado) return;
    tirado = true;
    const resto = (emAndamento.get(chave) ?? 1) - 1;
    if (resto > 0) emAndamento.set(chave, resto);
    else emAndamento.delete(chave);
  };
}

/** Inteiro positivo do ambiente ou o padrão. */
export const limiteDoAmbiente = (nome: string, padrao: number) =>
  Math.max(1, Math.trunc(Number(process.env[nome])) || padrao);
