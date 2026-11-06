/**
 * Blocos de colunas do modelo de dados (MD 1.3): CP (colunas padrão), AU (autoria) e L (log técnico).
 * Os nomes de constraints seguem MD 1.8 (`pk_`, `fk_`, `uq_`, `ix_`, `ck_`), por isso PK e FK são declaradas no
 * terceiro argumento das tabelas, com nome explícito.
 */
import { sql } from 'drizzle-orm';
import { bigint, customType, timestamp, uuid } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const timestamptz = (nome: string) => timestamp(nome, { withTimezone: true, mode: 'date' });

/** CP: `versao` não tem default no banco; o trigger `tg_<tabela>_versao` sempre a sobrescreve. */
export const colunasPadrao = () => ({
  id: uuid('id')
    .notNull()
    .default(sql`fn_uuid_v7()`),
  criadoEm: timestamptz('criado_em').notNull().defaultNow(),
  atualizadoEm: timestamptz('atualizado_em').notNull().defaultNow(),
  excluidoEm: timestamptz('excluido_em'),
  versao: bigint('versao', { mode: 'number' })
    .notNull()
    .$default(() => 0),
});

/** AU no banco da empresa (→ `usuarios`; a FK é declarada em cada tabela). */
export const colunasAutoria = () => ({
  criadoPorId: uuid('criado_por_id'),
  atualizadoPorId: uuid('atualizado_por_id'),
});

/** AU no banco de controle (→ `admins_plataforma`). */
export const colunasAutoriaAdmin = () => ({
  criadoPorAdminId: uuid('criado_por_admin_id'),
  atualizadoPorAdminId: uuid('atualizado_por_admin_id'),
});

/** R: chave natural + datas + `versao`. */
export const colunasReferencia = () => ({
  criadoEm: timestamptz('criado_em').notNull().defaultNow(),
  atualizadoEm: timestamptz('atualizado_em').notNull().defaultNow(),
  excluidoEm: timestamptz('excluido_em'),
  versao: bigint('versao', { mode: 'number' })
    .notNull()
    .$default(() => 0),
});

/** L: `id` + `criado_em` (+ `atualizado_em` quando mutável). */
export const colunasLog = () => ({
  id: uuid('id')
    .notNull()
    .default(sql`fn_uuid_v7()`),
  criadoEm: timestamptz('criado_em').notNull().defaultNow(),
});

export const colunasLogMutavel = () => ({
  ...colunasLog(),
  atualizadoEm: timestamptz('atualizado_em').notNull().defaultNow(),
});

export const naoExcluido = sql`excluido_em is null`;
