/**
 * Definição só para consultas da tabela `auditoria`. Ela é particionada por mês e por isso é criada em SQL na
 * migração customizada (drizzle-kit não gera `partition by`); este arquivo fica fora do glob do drizzle-kit.
 */
import { inet, jsonb, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { timestamptz } from '../colunas.js';

export const auditoria = pgTable('auditoria', {
  id: uuid('id').notNull(),
  criadoEm: timestamptz('criado_em').notNull().defaultNow(),
  ocorridoEm: timestamptz('ocorrido_em').notNull(),
  origem: varchar('origem', { length: 15 }).notNull(),
  usuarioId: uuid('usuario_id'),
  usuarioNome: varchar('usuario_nome', { length: 100 }),
  autorizadoPorId: uuid('autorizado_por_id'),
  adminPlataformaId: uuid('admin_plataforma_id'),
  terminalId: uuid('terminal_id'),
  lojaId: uuid('loja_id'),
  entidade: varchar('entidade', { length: 60 }).notNull(),
  registroId: uuid('registro_id'),
  acao: varchar('acao', { length: 40 }).notNull(),
  localizacao: varchar('localizacao', { length: 60 }),
  descricao: text('descricao'),
  antes: jsonb('antes'),
  depois: jsonb('depois'),
  ip: inet('ip'),
  userAgent: varchar('user_agent', { length: 255 }),
  requisicaoId: uuid('requisicao_id'),
  eventoId: uuid('evento_id'),
});
