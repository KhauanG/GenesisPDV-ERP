import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lerMigracoes, PASTA_MIGRACOES_CONTROLE, PASTA_MIGRACOES_EMPRESA } from './journal.js';

describe('journal do drizzle-kit', () => {
  it('lê as migrações em ordem, com hash SHA-256 do arquivo e comandos separados', () => {
    for (const pasta of [PASTA_MIGRACOES_CONTROLE, PASTA_MIGRACOES_EMPRESA]) {
      const m = lerMigracoes(pasta);
      expect(m.map((x) => x.ordem)).toEqual(m.map((_, i) => i));
      expect(m[0]!.tag).toBe('0000_funcoes');
      const sql = readFileSync(join(pasta, `${m[1]!.tag}.sql`), 'utf8');
      expect(m[1]!.hash).toBe(createHash('sha256').update(sql).digest('hex'));
      expect(m[1]!.comandos.length).toBeGreaterThan(10);
      expect(m.every((x) => x.comandos.every((c) => !c.includes('--> statement-breakpoint')))).toBe(true);
    }
  });

  it('a migração de funções da empresa traz a trava de ordenação e cache 1', () => {
    const [funcoes] = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
    const sql = funcoes!.comandos.join('\n');
    expect(sql).toContain('pg_advisory_xact_lock(7300001)');
    expect(sql).toMatch(/create sequence if not exists seq_versao as bigint start 1 cache 1/);
    for (const f of ['fn_uuid_v7', 'fn_versao()', 'fn_versao_local', 'fn_protege_imutavel', 'fn_unaccent'])
      expect(sql).toContain(f);
  });
});
