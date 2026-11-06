import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Migracao {
  /** Posição no journal do drizzle-kit (`idx`). */
  ordem: number;
  /** Tag do drizzle-kit (`0001_fundacao`), gravada em `migracoes_empresas.migracao`. */
  tag: string;
  /** `when` do journal: é o `created_at` que o drizzle grava em `__drizzle_migrations`. */
  quando: number;
  /** SHA-256 do arquivo SQL (o mesmo hash que o migrador do drizzle usa). */
  hash: string;
  comandos: string[];
}

interface Journal {
  entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>;
}

const aqui = dirname(fileURLToPath(import.meta.url));
/** `apps/api/drizzle` tanto a partir de `src/` (tsx/vitest) quanto de `dist/` (build). */
export const PASTA_DRIZZLE = resolve(aqui, '..', '..', '..', 'drizzle');
export const PASTA_MIGRACOES_CONTROLE = join(PASTA_DRIZZLE, 'controle');
export const PASTA_MIGRACOES_EMPRESA = join(PASTA_DRIZZLE, 'empresa');

export function lerMigracoes(pasta: string): Migracao[] {
  const journal = JSON.parse(readFileSync(join(pasta, 'meta', '_journal.json'), 'utf8')) as Journal;
  return journal.entries
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((e) => {
      const sql = readFileSync(join(pasta, `${e.tag}.sql`), 'utf8');
      return {
        ordem: e.idx,
        tag: e.tag,
        quando: e.when,
        hash: createHash('sha256').update(sql).digest('hex'),
        comandos: sql
          .split('--> statement-breakpoint')
          .map((c) => c.trim())
          .filter((c) => c.length > 0),
      };
    });
}
