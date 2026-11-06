import { ORIGENS_HISTORICO_PRECO } from '@genesis/shared';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { produtosHistoricoPrecos } from '../database/empresa/schema/index.js';

/**
 * A origem do histórico de preços (MD 3.6.10): `ORIGENS_HISTORICO_PRECO` do shared × o CHECK da tabela no schema
 * Drizzle (o que o drizzle-kit leva à migração). `ck_produtos_historico_precos_origem` foi escrito à mão antes de
 * existir a constante (F2-B15): uma origem nova só no shared passaria no typecheck e daria 23514 no INSERT (o schema
 * sem mudança não gera migração). Origem nova: nos dois lados, com a migração do CHECK.
 */
const dialeto = new PgDialect();

function valoresDoCheck(nome: string): string[] {
  const check = getTableConfig(produtosHistoricoPrecos).checks.find((c) => c.name === nome);
  expect(check, nome).toBeDefined();
  const { sql } = dialeto.sqlToQuery(check!.value);
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

describe('CHECK da origem do histórico de preços × shared', () => {
  it('ck_produtos_historico_precos_origem aceita exatamente ORIGENS_HISTORICO_PRECO', () => {
    expect(valoresDoCheck('ck_produtos_historico_precos_origem')).toEqual(
      [...ORIGENS_HISTORICO_PRECO].sort(),
    );
  });
});
