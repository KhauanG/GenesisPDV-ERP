import { inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';

/**
 * Filtro por lojas permitidas (ERP 2.1): condição para o `where` dos repositórios de entidades com `loja_id`.
 * `undefined` = sem restrição (Master); lista vazia = nenhuma linha.
 */
export function filtroLojas(sessao: SessaoErp, coluna: PgColumn): SQL | undefined {
  if (sessao.lojas === null) return undefined;
  if (sessao.lojas.length === 0) return sql`false`;
  return inArray(coluna, [...sessao.lojas]);
}

export function lojaPermitida(sessao: SessaoErp, lojaId: string | null | undefined): boolean {
  if (sessao.lojas === null) return true;
  return lojaId !== null && lojaId !== undefined && sessao.lojas.includes(lojaId);
}

export function garantirLoja(sessao: SessaoErp, lojaId: string | null | undefined): void {
  if (!lojaPermitida(sessao, lojaId)) throw ErroApi.semPermissao('Você não tem acesso a esta loja.');
}
