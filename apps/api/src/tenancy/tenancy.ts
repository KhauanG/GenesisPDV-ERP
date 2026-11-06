import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { erroDoDriver } from '../database/erro-postgres.js';
import type { ContextoEmpresa } from './contexto.js';
import type { PoolsEmpresas } from './pools-empresas.js';

export type DbEmpresa = NodePgDatabase;
/** Conexão física de uma transação/consulta de empresa (para SQL cru dentro de `cx()`). */
export type ClienteEmpresa = pg.PoolClient;

export class SemContextoEmpresaErro extends Error {
  constructor() {
    super('Acesso ao banco de empresa sem ContextoEmpresa ativo');
    this.name = 'SemContextoEmpresaErro';
  }
}

/** Erros que a API repete (MD 1.5): deadlock entre a trava de versão e locks de linha, serialização. */
const REPETIVEIS = new Set(['40P01', '40001']);
/** MD 1.5: "repete a transação até 3 vezes" = a tentativa original + 3 repetições. */
export const REPETICOES_TRANSACAO = 3;

/** Espera curta e aleatória antes de repetir: as transações que colidiram não voltam a colidir em fila. */
const esperarAntesDeRepetir = () =>
  new Promise<void>((ok) => setTimeout(ok, 10 + Math.floor(Math.random() * 41)));

/** SQLSTATE `lock_not_available`: o `lock_timeout` venceu esperando a trava (Fase 1C, C13). */
export const TRAVA_OCUPADA = '55P03';

/**
 * Espera máxima pela trava de ordenação 7300001 numa transação do ERP (Fase 1C, C13; crítica da 1C, item 6): com os
 * caixas reconectando e despejando vendas, quem salva um produto ou um acerto espera no máximo isto e recebe
 * `SISTEMA_OCUPADO` (503, mensagem amigável, nada gravado) em vez de ficar com a tela presa. Só a espera pela trava
 * tem limite: depois dela o `lock_timeout` volta ao padrão da sessão. `null` = sem limite.
 */
export interface OpcoesTenancy {
  esperaTravaVersaoMs?: number | null;
}

export interface AcessoEmpresa {
  readonly contexto: ContextoEmpresa;
  /**
   * Transação curta (MD 1.5), repetida até 3 vezes em deadlock/serialização. `travaVersao` = a transação grava
   * tabela sincronizável: `fn_trava_versao()` é a primeira instrução (MD 1.5, "Trava no início da transação").
   * Nada de E/S externa (rede, SEFAZ, e-mail…) nem trabalho pesado de CPU dentro dela. A espera pela trava tem o
   * limite de `OpcoesTenancy.esperaTravaVersaoMs` (ERP); `esperaSemLimite` é para as tarefas em segundo plano
   * (importação, manutenção), que não têm ninguém olhando a tela e preferem esperar a falhar no meio, e para as rotas
   * do PDV (`/sync/ativar`, `/sync/heartbeat`), que esperam como o push: um caixa nunca recebe erro por causa do ERP.
   */
  transacao<T>(
    fn: (tx: DbEmpresa, cliente: pg.PoolClient) => Promise<T>,
    opcoes?: { travaVersao?: boolean; esperaSemLimite?: boolean },
  ): Promise<T>;
  /** Consulta fora de transação explícita. */
  consulta<T>(fn: (db: DbEmpresa, cliente: pg.PoolClient) => Promise<T>): Promise<T>;
}

/** Única porta para os bancos das empresas (visao-geral.md 4.3.1). */
export class Tenancy {
  private readonly als = new AsyncLocalStorage<ContextoEmpresa>();

  constructor(
    private readonly pools: PoolsEmpresas,
    private readonly opcoes: OpcoesTenancy = {},
  ) {}

  /** Roda `fn` num contexto de empresa novo (requisição, tarefa ou CLI); nunca herda o de quem chamou. */
  executarNaEmpresa<T>(contexto: ContextoEmpresa, fn: () => T): T {
    return this.als.run(Object.isFrozen(contexto) ? contexto : Object.freeze({ ...contexto }), fn);
  }

  atual(): ContextoEmpresa {
    const c = this.als.getStore();
    if (!c) throw new SemContextoEmpresaErro();
    return c;
  }

  temContexto(): boolean {
    return this.als.getStore() !== undefined;
  }

  cx(): AcessoEmpresa {
    const contexto = this.atual();
    const pools = this.pools;
    const espera = this.opcoes.esperaTravaVersaoMs ?? null;
    return {
      contexto,
      async transacao(fn, opcoes) {
        for (let tentativa = 1; ; tentativa++) {
          const cliente = await pools.conectar(contexto);
          try {
            await cliente.query('begin');
            if (opcoes?.travaVersao) {
              if (espera !== null && !opcoes.esperaSemLimite) {
                await cliente.query(`set local lock_timeout = ${Math.max(1, Math.trunc(espera))}`);
                await cliente.query('select fn_trava_versao()');
                await cliente.query('set local lock_timeout to default');
              } else {
                await cliente.query('select fn_trava_versao()');
              }
            }
            const r = await fn(drizzle(cliente), cliente);
            await cliente.query('commit');
            return r;
          } catch (e) {
            await cliente.query('rollback').catch(() => undefined);
            // Pelo erro do driver: a consulta do Drizzle chega embrulhada (`DrizzleQueryError.cause`).
            const codigo = erroDoDriver(e).code;
            if (typeof codigo !== 'string' || !REPETIVEIS.has(codigo) || tentativa > REPETICOES_TRANSACAO)
              throw e;
          } finally {
            cliente.release();
          }
          await esperarAntesDeRepetir();
        }
      },
      async consulta(fn) {
        const cliente = await pools.conectar(contexto);
        try {
          return await fn(drizzle(cliente), cliente);
        } finally {
          cliente.release();
        }
      },
    };
  }
}
