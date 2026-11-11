import { ehAcaoAuditoria, type AcaoAuditoria, type OrigemAuditoria } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { auditoria } from '../database/empresa/auditoria.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { mascararSensiveis } from './mascarar.js';

/** Quem/de onde: preenchido a partir da requisição (ver `origemDaRequisicao`). */
export interface OrigemAcao {
  origem: OrigemAuditoria;
  usuarioId?: string | null;
  usuarioNome?: string | null;
  adminPlataformaId?: string | null;
  autorizadoPorId?: string | null;
  terminalId?: string | null;
  lojaId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requisicaoId?: string | null;
}

export interface RegistroAuditoria {
  acao: AcaoAuditoria;
  entidade: string;
  registroId?: string | null;
  localizacao?: string | null;
  descricao?: string | null;
  antes?: unknown;
  depois?: unknown;
  ocorridoEm?: Date;
  eventoId?: string | null;
  lojaId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trilha de auditoria (ERP 17; MD 3.1.7). Recebe a transação de quem altera: a linha de auditoria só existe se a
 * alteração for confirmada, e nunca existe alteração sem auditoria.
 */
/** Linhas por comando no `registrarVarios` (SYNC 6.13: blocos de até 500 linhas). */
const LINHAS_POR_BLOCO_AUDITORIA = 500;

export class AuditoriaService {
  async registrar(
    tx: DbEmpresa,
    origem: OrigemAcao,
    r: RegistroAuditoria & { id?: string },
  ): Promise<string> {
    const linha = this.linha(origem, r);
    await tx.insert(auditoria).values(linha);
    return linha.id;
  }

  /**
   * Várias linhas da mesma origem num comando por bloco de até 500 (a efetivação da entrada grava uma por produto com
   * o preço alterado, F2-B42): o mesmo que `registrar` uma a uma, sem uma ida ao banco por linha.
   */
  async registrarVarios(tx: DbEmpresa, origem: OrigemAcao, rs: readonly RegistroAuditoria[]): Promise<void> {
    const linhas = rs.map((r) => this.linha(origem, r));
    for (let i = 0; i < linhas.length; i += LINHAS_POR_BLOCO_AUDITORIA)
      await tx.insert(auditoria).values(linhas.slice(i, i + LINHAS_POR_BLOCO_AUDITORIA));
  }

  private linha(origem: OrigemAcao, r: RegistroAuditoria & { id?: string }) {
    // O banco não tem CHECK em `acao` (ERP 17.1): o catálogo de @genesis/shared é conferido aqui.
    if (!ehAcaoAuditoria(r.acao)) throw new Error(`Ação de auditoria fora do catálogo: ${String(r.acao)}`);
    return {
      id: r.id ?? uuidv7(),
      ocorridoEm: r.ocorridoEm ?? new Date(),
      origem: origem.origem,
      usuarioId: origem.usuarioId ?? null,
      usuarioNome: origem.usuarioNome?.slice(0, 100) ?? null,
      autorizadoPorId: origem.autorizadoPorId ?? null,
      adminPlataformaId: origem.adminPlataformaId ?? null,
      terminalId: origem.terminalId ?? null,
      lojaId: r.lojaId ?? origem.lojaId ?? null,
      entidade: r.entidade,
      registroId: r.registroId ?? null,
      acao: r.acao,
      localizacao: r.localizacao ?? null,
      descricao: r.descricao ?? null,
      antes: r.antes === undefined ? null : mascararSensiveis(r.antes),
      depois: r.depois === undefined ? null : mascararSensiveis(r.depois),
      ip: origem.ip ?? null,
      userAgent: origem.userAgent?.slice(0, 255) ?? null,
      requisicaoId: origem.requisicaoId && UUID.test(origem.requisicaoId) ? origem.requisicaoId : null,
      eventoId: r.eventoId ?? null,
    } satisfies typeof auditoria.$inferInsert;
  }
}
