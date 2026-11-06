import { mascararSensiveis } from '../auditoria/mascarar.js';
import type { DbControle } from '../database/controle/conexao.js';
import { auditoriaPlataforma } from '../database/controle/schema.js';

export interface RegistroAuditoriaPlataforma {
  adminId?: string | null;
  empresaId?: string | null;
  acao: string;
  entidade: string;
  registroId?: string | null;
  antes?: unknown;
  depois?: unknown;
  ip?: string | null;
}

/** `auditoria_plataforma` (MD 2.11): toda ação da equipe Genesis e do provisionamento. */
export async function registrarAuditoriaPlataforma(
  db: DbControle,
  r: RegistroAuditoriaPlataforma,
): Promise<void> {
  await db.insert(auditoriaPlataforma).values({
    adminId: r.adminId ?? null,
    empresaId: r.empresaId ?? null,
    acao: r.acao,
    entidade: r.entidade,
    registroId: r.registroId ?? null,
    antes: r.antes === undefined ? null : mascararSensiveis(r.antes),
    depois: r.depois === undefined ? null : mascararSensiveis(r.depois),
    ip: r.ip ?? null,
  });
}
