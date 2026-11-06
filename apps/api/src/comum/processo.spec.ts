import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  avaliarHeap,
  criarLoggerProcesso,
  memoriaDoProcesso,
  registrarDiagnosticoProcesso,
  vigiarHeap,
  type ProcessoObservado,
} from './processo.js';

/**
 * Diagnóstico do processo (decisão 166): o registro no log sem matar o processo de teste — um emissor no lugar do
 * `process`, com `exit` e `kill` falsos, e o logger síncrono num arquivo temporário (lido logo depois da emissão,
 * sem esperar nada: é o que garante a linha no `docker logs` antes do `exit`).
 */
const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
  vi.useRealTimers();
});

function arquivoDeLog(): string {
  const pasta = mkdtempSync(join(tmpdir(), 'processo-'));
  pastas.push(pasta);
  return join(pasta, 'log.ndjson');
}

function ambiente(nivel = 'info') {
  const arquivo = arquivoDeLog();
  const log = criarLoggerProcesso(nivel, arquivo);
  const processo = Object.assign(new EventEmitter(), {
    pid: 4242,
    exit: vi.fn(),
    kill: vi.fn(),
  });
  registrarDiagnosticoProcesso(log, processo as unknown as ProcessoObservado);
  const linhas = () =>
    readFileSync(arquivo, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { processo, linhas };
}

describe('registrarDiagnosticoProcesso', () => {
  it('uncaughtException: fatal com a pilha, já escrito no destino, e sai com código 1', () => {
    const { processo, linhas } = ambiente();
    const erro = new TypeError("Cannot read properties of undefined (reading 'id')");
    processo.emit('uncaughtException', erro);
    // Síncrono: a linha já está no arquivo, sem flush nem espera.
    const [l] = linhas();
    expect(l).toMatchObject({ level: 60, context: 'Processo', origem: 'uncaughtException' });
    expect(l!.msg).toMatch(/exceção não tratada/);
    const err = l!.err as { type: string; message: string; stack: string };
    expect(err.type).toBe('TypeError');
    expect(err.message).toBe(erro.message);
    expect(err.stack).toContain('processo.spec.ts');
    expect(l!.memoria).toMatchObject({
      heap_usado_mb: expect.any(Number),
      heap_limite_mb: expect.any(Number),
    });
    expect(processo.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('unhandledRejection: com Error e com motivo que não é Error (o erro não é engolido)', () => {
    const { processo, linhas } = ambiente();
    processo.emit('unhandledRejection', new Error('Connection terminated unexpectedly'), Promise.resolve());
    expect(linhas()[0]).toMatchObject({
      level: 60,
      origem: 'unhandledRejection',
      err: { message: 'Connection terminated unexpectedly' },
    });
    expect(processo.exit).toHaveBeenCalledExactlyOnceWith(1);

    const outro = ambiente();
    outro.processo.emit('unhandledRejection', { codigo: 'X', detalhe: 'sem stack' }, Promise.resolve());
    const [l] = outro.linhas();
    expect(l).toMatchObject({ level: 60, origem: 'unhandledRejection' });
    expect(l!.motivo).toContain("codigo: 'X'");
    expect(outro.processo.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('uma segunda falha durante a saída não repete o log nem a saída', () => {
    const { processo, linhas } = ambiente();
    processo.emit('uncaughtException', new Error('primeira'));
    processo.emit('unhandledRejection', new Error('segunda'), Promise.resolve());
    expect(linhas().filter((l) => l.level === 60)).toHaveLength(1);
    expect(processo.exit).toHaveBeenCalledTimes(1);
  });

  it('SIGTERM com o ouvinte do Nest: registra o sinal uma vez e não repete o sinal', () => {
    const { processo, linhas } = ambiente();
    const nest = vi.fn();
    processo.on('SIGTERM', nest);
    processo.emit('SIGTERM', 'SIGTERM');
    processo.emit('SIGTERM', 'SIGTERM');
    expect(nest).toHaveBeenCalledTimes(2);
    const sinais = linhas().filter((l) => l.sinal);
    expect(sinais).toHaveLength(1);
    expect(sinais[0]).toMatchObject({
      level: 40,
      sinal: 'SIGTERM',
      msg: 'sinal SIGTERM recebido: encerrando a API',
    });
    expect(processo.kill).not.toHaveBeenCalled();
    expect(processo.exit).not.toHaveBeenCalled();
  });

  it('SIGINT sem outro ouvinte (antes de a aplicação subir): repete o sinal para o processo terminar', () => {
    const { processo, linhas } = ambiente();
    processo.emit('SIGINT', 'SIGINT');
    expect(linhas()[0]).toMatchObject({ level: 40, sinal: 'SIGINT' });
    expect(processo.kill).toHaveBeenCalledExactlyOnceWith(4242, 'SIGINT');
  });

  it('exit: o código de saída no log (erro quando diferente de 0)', () => {
    const { processo, linhas } = ambiente();
    processo.emit('exit', 0);
    processo.emit('exit', 1);
    expect(linhas()).toMatchObject([
      { level: 30, codigo: 0 },
      { level: 50, codigo: 1, msg: 'processo da API saindo com código 1' },
    ]);
  });

  it('LOG_NIVEL silent: nada no log, e a saída continua', () => {
    const { processo, linhas } = ambiente('silent');
    processo.emit('uncaughtException', new Error('x'));
    expect(linhas()).toEqual([]);
    expect(processo.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('memoriaDoProcesso', () => {
  it('MiB com uma casa, e o teto do heap acima do reservado', () => {
    const m = memoriaDoProcesso();
    expect(m.heap_usado_mb).toBeGreaterThan(0);
    expect(m.heap_total_mb).toBeGreaterThanOrEqual(m.heap_usado_mb);
    expect(m.heap_limite_mb).toBeGreaterThan(m.heap_total_mb);
    expect(m.rss_mb).toBeGreaterThan(0);
    for (const v of Object.values(m)) expect(Math.round(v * 10) / 10).toBe(v);
  });
});

describe('vigiar o heap', () => {
  it('avaliarHeap: avisa uma vez ao cruzar 85 % e rearma abaixo de 75 %', () => {
    expect(avaliarHeap(84, 100, false)).toEqual({ avisar: false, avisado: false });
    expect(avaliarHeap(85, 100, false)).toEqual({ avisar: true, avisado: true });
    expect(avaliarHeap(99, 100, true)).toEqual({ avisar: false, avisado: true });
    expect(avaliarHeap(80, 100, true)).toEqual({ avisar: false, avisado: true });
    expect(avaliarHeap(74, 100, true)).toEqual({ avisar: false, avisado: false });
    expect(avaliarHeap(1, 0, false)).toEqual({ avisar: false, avisado: false });
  });

  it('vigiarHeap: um aviso por cruzamento, a cada intervalo', () => {
    vi.useFakeTimers();
    const arquivo = arquivoDeLog();
    const leituras = [50, 90, 95, 60, 88];
    const parar = vigiarHeap(criarLoggerProcesso('info', arquivo), 1000, () => ({
      usado: leituras.shift() ?? 0,
      limite: 100,
    }));
    vi.advanceTimersByTime(5000);
    parar();
    const avisos = readFileSync(arquivo, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { level: number; fracao_heap: number });
    expect(avisos.map((a) => [a.level, a.fracao_heap])).toEqual([
      [40, 0.9],
      [40, 0.88],
    ]);
  });
});
