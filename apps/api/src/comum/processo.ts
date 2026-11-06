/**
 * Diagnóstico do processo da API (correção de operação do reinício de 04/11/2026; decisão 166 do README): a próxima
 * queda deixa a causa no log e o reinício fica visível.
 *
 * - **Saída por erro**: `uncaughtException` e `unhandledRejection` (no Node 22 a rejeição sem tratamento também
 *   derruba o processo) vão para o log em `fatal`, com a pilha e a origem, e o processo sai com código 1, como sem
 *   o ouvinte: o Docker (`restart: unless-stopped`) sobe de novo. O erro nunca é engolido.
 * - **Encerramento**: o sinal recebido (`SIGTERM` do `docker stop`/`compose up`, `SIGINT`) e o código de saída
 *   (`exit`). O ouvinte do sinal é de uma vez só e não substitui o do Nest (`enableShutdownHooks`); sem nenhum outro
 *   ouvinte (sinal antes de a aplicação subir), o sinal é repetido para o processo terminar como terminaria sem ele.
 * - **Heap perto do limite**: o estouro do heap do V8 (`JavaScript heap out of memory`, saída 134) não passa por
 *   nenhum ouvinte e não aparece no kernel; só o V8 escreve no stderr. O aviso a 85 % do limite deixa no log, antes,
 *   o quanto o heap cresceu (`vigiarHeap`).
 *
 * O logger destas linhas é **síncrono** (`pino.destination({ sync: true })`, no mesmo stdout do logger da aplicação):
 * a linha fatal está no `docker logs` antes do `process.exit`. O logger da aplicação é assíncrono (sonic-boom) e a
 * escrita em andamento se perde num `exit` imediato.
 */
import { getHeapStatistics } from 'node:v8';
import { inspect } from 'node:util';
import pino, { type Logger } from 'pino';

/** Memória do processo em MiB (1024²), com uma casa: o que o `docker stats` não separa (heap do V8 × resto). */
export interface MemoriaProcesso {
  heap_usado_mb: number;
  heap_total_mb: number;
  /** Teto do heap do V8 (`heap_size_limit`: o `--max-old-space-size` mais o espaço novo). */
  heap_limite_mb: number;
  rss_mb: number;
}

const mb = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10;

export function memoriaDoProcesso(): MemoriaProcesso {
  const m = process.memoryUsage();
  return {
    heap_usado_mb: mb(m.heapUsed),
    heap_total_mb: mb(m.heapTotal),
    heap_limite_mb: mb(getHeapStatistics().heap_size_limit),
    rss_mb: mb(m.rss),
  };
}

/** Logger síncrono das linhas do processo (`destino`: descritor ou caminho; padrão, o stdout). */
export function criarLoggerProcesso(nivel: string, destino: number | string = 1): Logger {
  return pino({ level: nivel }, pino.destination({ dest: destino, sync: true })).child({
    context: 'Processo',
  });
}

/** O que `registrarDiagnosticoProcesso` usa do `process` (o teste passa um emissor falso). */
export interface ProcessoObservado {
  pid: number;
  on(evento: string, ouvinte: (...args: never[]) => void): unknown;
  once(evento: string, ouvinte: (...args: never[]) => void): unknown;
  listenerCount(evento: string): number;
  kill(pid: number, sinal: string): unknown;
  exit(codigo: number): unknown;
}

export const SINAIS_ENCERRAMENTO = ['SIGTERM', 'SIGINT'] as const;

/** Liga os ouvintes do processo (uma vez, no `main.ts`, antes de criar a aplicação). */
export function registrarDiagnosticoProcesso(
  log: Logger,
  processo: ProcessoObservado = process as unknown as ProcessoObservado,
): void {
  let saindo = false;
  const fatal = (origem: 'uncaughtException' | 'unhandledRejection') => (motivo: unknown) => {
    // Uma segunda falha enquanto sai (ex.: no próprio log) não repete a saída.
    if (saindo) return;
    saindo = true;
    try {
      const detalhe =
        motivo instanceof Error ? { err: motivo } : { motivo: inspect(motivo, { depth: 3 }).slice(0, 4000) };
      log.fatal(
        { origem, ...detalhe, memoria: memoriaDoProcesso(), no_ar_segundos: Math.round(process.uptime()) },
        origem === 'uncaughtException'
          ? 'exceção não tratada: a API vai sair (código 1) e o Docker sobe de novo'
          : 'rejeição de promise não tratada: a API vai sair (código 1) e o Docker sobe de novo',
      );
    } finally {
      processo.exit(1);
    }
  };
  processo.on('uncaughtException', fatal('uncaughtException'));
  processo.on('unhandledRejection', fatal('unhandledRejection'));
  for (const sinal of SINAIS_ENCERRAMENTO) {
    processo.once(sinal, () => {
      log.warn(
        { sinal, no_ar_segundos: Math.round(process.uptime()) },
        `sinal ${sinal} recebido: encerrando a API`,
      );
      // Sem o ouvinte do Nest, este seria o único e o sinal não terminaria o processo.
      if (processo.listenerCount(sinal) === 0) processo.kill(processo.pid, sinal);
    });
  }
  processo.on('exit', (codigo: number) => {
    const dados = { codigo, no_ar_segundos: Math.round(process.uptime()) };
    if (codigo === 0) log.info(dados, 'processo da API saindo (código 0)');
    else log.error(dados, `processo da API saindo com código ${codigo}`);
  });
}

/** Aviso a partir desta fração do teto do heap; volta a avisar depois de cair abaixo de `REARME_HEAP`. */
export const LIMIAR_HEAP = 0.85;
export const REARME_HEAP = 0.75;
export const INTERVALO_HEAP_MS = 30_000;

/** Decide o aviso do heap: avisa uma vez ao cruzar o limiar e rearma abaixo do rearme (sem repetir a cada leitura). */
export function avaliarHeap(
  usadoBytes: number,
  limiteBytes: number,
  avisado: boolean,
): { avisar: boolean; avisado: boolean } {
  const fracao = limiteBytes > 0 ? usadoBytes / limiteBytes : 0;
  if (!avisado && fracao >= LIMIAR_HEAP) return { avisar: true, avisado: true };
  if (avisado && fracao < REARME_HEAP) return { avisar: false, avisado: false };
  return { avisar: false, avisado };
}

/** Confere o heap a cada `intervaloMs` (timer `unref`: não segura o processo) e avisa perto do teto. */
export function vigiarHeap(
  log: Logger,
  intervaloMs = INTERVALO_HEAP_MS,
  ler: () => { usado: number; limite: number } = () => ({
    usado: process.memoryUsage().heapUsed,
    limite: getHeapStatistics().heap_size_limit,
  }),
): () => void {
  let avisado = false;
  const timer = setInterval(() => {
    const { usado, limite } = ler();
    const r = avaliarHeap(usado, limite, avisado);
    avisado = r.avisado;
    if (r.avisar)
      log.warn(
        { memoria: memoriaDoProcesso(), fracao_heap: Math.round((usado / limite) * 100) / 100 },
        `heap do Node acima de ${LIMIAR_HEAP * 100} % do limite: risco de "JavaScript heap out of memory"`,
      );
  }, intervaloMs);
  timer.unref();
  return () => clearInterval(timer);
}
