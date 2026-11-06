import { CONFIGURACOES_POR_CHAVE } from '@genesis/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { configuracoes } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/**
 * `valor jsonb` lido como texto e convertido aqui: o decodificador do Drizzle faz `JSON.parse` de novo sobre o que o
 * `pg` já converteu, e a string `"1500.00"` viraria o número 1500.
 */
export const valorJson = sql<unknown>`${configuracoes.valor}::text`.mapWith((v: string | null) =>
  v === null ? null : JSON.parse(v),
);

/**
 * Valor efetivo de chaves do catálogo (MD 3.1.2; ERP 9.0): loja ?? empresa ?? padrão. As chaves com `padraoUf`
 * caem no padrão do catálogo aqui (o valor da UF entra quando a tela fiscal existir).
 */
export async function lerConfiguracoes(
  db: DbEmpresa,
  chaves: readonly string[],
  lojaId: string | null = null,
): Promise<Map<string, unknown>> {
  const linhas = chaves.length
    ? await db
        .select({ chave: configuracoes.chave, escopo: configuracoes.escopo, valor: valorJson })
        .from(configuracoes)
        .where(
          and(
            inArray(configuracoes.chave, [...chaves]),
            isNull(configuracoes.excluidoEm),
            or(
              eq(configuracoes.escopo, 'empresa'),
              lojaId ? and(eq(configuracoes.escopo, 'loja'), eq(configuracoes.lojaId, lojaId)) : undefined,
            ),
          ),
        )
    : [];
  const r = new Map<string, unknown>();
  for (const chave of chaves) {
    const loja = linhas.find((l) => l.chave === chave && l.escopo === 'loja');
    const empresa = linhas.find((l) => l.chave === chave && l.escopo === 'empresa');
    r.set(
      chave,
      loja ? loja.valor : empresa ? empresa.valor : (CONFIGURACOES_POR_CHAVE.get(chave)?.padrao ?? null),
    );
  }
  return r;
}

export async function lerConfiguracao<T>(
  db: DbEmpresa,
  chave: string,
  lojaId: string | null = null,
): Promise<T> {
  return (await lerConfiguracoes(db, [chave], lojaId)).get(chave) as T;
}
