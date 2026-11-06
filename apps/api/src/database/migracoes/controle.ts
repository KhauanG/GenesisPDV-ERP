import { isNull } from 'drizzle-orm';
import pg from 'pg';
import type { BancoControle } from '../controle/conexao.js';
import { planos } from '../controle/schema.js';
import { garantirNomeBancoControle } from '../nomes-bancos.js';
import type { ServidoresBanco } from '../servidores.js';
import { aplicarMigracoes } from './executor.js';
import { lerMigracoes, PASTA_MIGRACOES_CONTROLE } from './journal.js';

/** Cria o banco (se não existir) a partir de uma URL, conectando no banco `postgres` do mesmo servidor. */
export async function garantirBanco(url: string): Promise<boolean> {
  const alvo = new URL(url);
  const nome = decodeURIComponent(alvo.pathname.slice(1));
  garantirNomeBancoControle(nome);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const cliente = new pg.Client({ connectionString: admin.toString() });
  await cliente.connect();
  try {
    const { rowCount } = await cliente.query('select 1 from pg_database where datname = $1', [nome]);
    if (rowCount) return false;
    await cliente.query(`create database "${nome.replace(/"/g, '""')}" template template0 encoding 'UTF8'`);
    return true;
  } finally {
    await cliente.end();
  }
}

/** `db:migrate:controle`: aplica as migrações do `genesis_control` (mesmo executor das empresas). */
export async function migrarControle(url: string, lockTimeout = '10s'): Promise<string[]> {
  const cliente = new pg.Client({ connectionString: url, application_name: 'genesis_migracao' });
  await cliente.connect();
  try {
    // Dois deploys simultâneos não migram o controle ao mesmo tempo.
    await cliente.query("select pg_advisory_lock(hashtext('genesis:migracao_controle'))");
    const r = await aplicarMigracoes(cliente, lerMigracoes(PASTA_MIGRACOES_CONTROLE), { lockTimeout });
    return r.aplicadas;
  } finally {
    await cliente.end();
  }
}

/** Dados mínimos do controle para o primeiro uso: um plano e o servidor padrão das empresas. */
export async function seedControle(controle: BancoControle, servidores: ServidoresBanco): Promise<void> {
  const existentes = await controle.db
    .select({ id: planos.id })
    .from(planos)
    .where(isNull(planos.excluidoEm))
    .limit(1);
  if (existentes.length === 0) {
    await controle.db
      .insert(planos)
      .values({
        codigo: 'padrao',
        nome: 'Plano padrão',
        descricao:
          'Criado no primeiro db:migrate:controle; ajuste limites e recursos no painel da plataforma.',
        limiteLojas: 10,
        limiteTerminais: 30,
        recursos: { fiscal: true },
      })
      .onConflictDoNothing();
  }
  await servidores.garantirPadrao();
}
