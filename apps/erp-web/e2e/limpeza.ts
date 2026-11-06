import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import type pg from 'pg';

/** Remove os bancos criados pelo e2e (controle + empresas e as roles de runtime) e o arquivo de estado. */
export default async function limpeza(): Promise<void> {
  // `pg` é dependência da API; o ERP web não a declara só para a limpeza do e2e.
  const { Client } = createRequire(new URL('../../api/package.json', import.meta.url))('pg') as typeof pg;
  const base = new URL(
    process.env.DATABASE_URL ?? 'postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control',
  );
  const banco = process.env.E2E_BANCO!;
  const conectar = async (nome: string) => {
    const u = new URL(base);
    u.pathname = `/${nome}`;
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    return c;
  };
  const postgres = await conectar('postgres');
  try {
    const existe = await postgres.query('select 1 from pg_database where datname = $1', [banco]);
    if (existe.rowCount) {
      const controle = await conectar(banco);
      const { rows } = await controle
        .query<{ nome_banco: string }>('select nome_banco from empresas')
        .finally(() => controle.end());
      for (const { nome_banco } of rows) {
        await postgres.query(`drop database if exists "${nome_banco}" with (force)`);
        await postgres.query(`drop role if exists "${nome_banco}_app"`);
      }
      await postgres.query(`drop database if exists "${banco}" with (force)`);
    }
  } finally {
    await postgres.end();
  }
  if (process.env.E2E_ESTADO) rmSync(process.env.E2E_ESTADO, { force: true });
}
