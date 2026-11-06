import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type DbControle = NodePgDatabase;

/** Pool único do banco de controle (`genesis_control`). */
export class BancoControle {
  readonly pool: pg.Pool;
  readonly db: DbControle;

  constructor(url: string, maximo = 10) {
    this.pool = new pg.Pool({ connectionString: url, max: maximo, application_name: 'genesis_controle' });
    this.pool.on('error', () => {
      // Conexão ociosa derrubada pelo servidor: o pool descarta e reabre sob demanda.
    });
    this.db = drizzle(this.pool);
  }

  async transacao<T>(fn: (tx: DbControle, cliente: pg.PoolClient) => Promise<T>): Promise<T> {
    const cliente = await this.pool.connect();
    try {
      await cliente.query('begin');
      const r = await fn(drizzle(cliente), cliente);
      await cliente.query('commit');
      return r;
    } catch (e) {
      await cliente.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      cliente.release();
    }
  }

  fechar(): Promise<void> {
    return this.pool.end();
  }
}
