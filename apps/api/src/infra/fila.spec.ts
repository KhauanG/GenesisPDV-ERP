import { describe, expect, it } from 'vitest';
import {
  FILAS,
  OPCOES_FILAS,
  registrarEventosFila,
  textoAvisoFila,
  trabalhoPorEmpresas,
  type ResumoPorEmpresas,
} from './fila.js';

/** `trabalhoPorEmpresas` (C14): falha de empresa vai para o log e faz o job falhar, para o pg-boss tentar de novo. */
describe('trabalhoPorEmpresas', () => {
  const executar = (resumo: ResumoPorEmpresas) => {
    const erros: string[] = [];
    const trabalho = trabalhoPorEmpresas(FILAS.expiracaoRelevancia, () => Promise.resolve(resumo), {
      error: (m: unknown) => void erros.push(String(m)),
    });
    return { erros, rodar: () => trabalho({}, {} as never) };
  };

  it('sem falhas: conclui sem log', async () => {
    const { erros, rodar } = executar({ falhas: [] });
    await expect(rodar()).resolves.toBeUndefined();
    expect(erros).toEqual([]);
  });

  it('com falhas: registra cada empresa no log e lança no fim', async () => {
    const { erros, rodar } = executar({
      falhas: [
        { empresaId: 'e1', erro: 'permissão negada para a tabela pessoas_relevancia_loja' },
        { empresaId: 'e2', erro: 'invalid input syntax for type integer: "doze"' },
      ],
    });
    await expect(rodar()).rejects.toThrow('genesis-expiracao-relevancia: falhou em 2 empresa(s)');
    expect(erros).toEqual([
      'genesis-expiracao-relevancia: falhou na empresa e1: permissão negada para a tabela pessoas_relevancia_loja',
      'genesis-expiracao-relevancia: falhou na empresa e2: invalid input syntax for type integer: "doze"',
    ]);
  });
});

/** Eventos do pg-boss no log (decisão 150): antes o `error` ia para um `aoErro` que ninguém passava e o `warning` sumia. */
describe('registrarEventosFila', () => {
  const ligar = (aoErro?: (e: unknown) => void) => {
    const ouvintes = new Map<string, (x: never) => void>();
    const log = { erros: [] as string[], avisos: [] as string[] };
    registrarEventosFila(
      { on: ((evento: string, fn: (x: never) => void) => ouvintes.set(evento, fn)) as never },
      { error: (m: unknown) => void log.erros.push(String(m)), warn: (m: unknown) => void log.avisos.push(String(m)) },
      aoErro,
    );
    const emitir = (evento: string, x: unknown) => ouvintes.get(evento)!(x as never);
    return { log, emitir };
  };

  it('error vai para o log e para o aoErro', () => {
    const recebidos: unknown[] = [];
    const { log, emitir } = ligar((e) => recebidos.push(e));
    const erro = new Error('Connection terminated unexpectedly');
    emitir('error', erro);
    expect(log.erros).toEqual(['pg-boss: Connection terminated unexpectedly']);
    expect(recebidos).toEqual([erro]);
  });

  it('warning (handler overrun) vai para o log com a fila e os jobs, sem o resto do data', () => {
    const { log, emitir } = ligar();
    emitir('warning', {
      message: 'a handler on queue genesis-tarefa is still running after exceeding 900s.',
      data: {
        type: 'handler_overrun',
        instance: 'i1',
        queue: 'genesis-tarefa',
        jobs: ['j1', 'j2'],
        expireInSeconds: 900,
        sql: 'select * from pessoas',
      },
    });
    expect(log.avisos).toEqual([
      'pg-boss: a handler on queue genesis-tarefa is still running after exceeding 900s. tipo=handler_overrun fila=genesis-tarefa jobs=j1,j2',
    ]);
  });

  it('textoAvisoFila sem data', () => {
    expect(textoAvisoFila({ message: 'clock skew', data: {} })).toBe('pg-boss: clock skew');
  });
});

describe('OPCOES_FILAS', () => {
  it('a fila das tarefas expira em 1 h; as outras seguem em 15 min', () => {
    expect(OPCOES_FILAS[FILAS.tarefa].expireInSeconds).toBe(3600);
    for (const fila of Object.values(FILAS).filter((f) => f !== FILAS.tarefa)) {
      expect(OPCOES_FILAS[fila]).toEqual({ retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 900 });
    }
  });
});
