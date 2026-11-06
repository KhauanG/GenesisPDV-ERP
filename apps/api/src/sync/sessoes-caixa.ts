/**
 * Sessão de caixa vista pela nuvem (MD 3.12.1): a aberta de um terminal (handshake `GET /sync/estado`, SYNC 5) e o
 * fechamento forçado na substituição ou na revogação do terminal. Fica fora dos handlers porque a ativação, a revogação
 * pelo ERP, a manutenção e a desativação confirmada do heartbeat também fecham, cada uma na própria transação.
 */
import { sql } from 'drizzle-orm';
import type { MOTIVOS_FECHAMENTO_FORCADO } from '../database/empresa/schema/caixa.js';
import { alertas } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

export type MotivoFechamentoForcado = (typeof MOTIVOS_FECHAMENTO_FORCADO)[number];

/** MD 3.12.1: alerta de cada sessão fechada pela nuvem, para a conferência no ERP (14.9). */
export const ALERTA_SESSAO_FECHADA = 'SESSAO_FECHADA_POR_SUBSTITUICAO';

const DESCRICAO_MOTIVO: Record<MotivoFechamentoForcado, string> = {
  substituicao_terminal: 'substituição do terminal',
  revogacao_terminal: 'revogação do terminal',
};

export interface SessaoAberta {
  id: string;
  operador_id: string;
  aberta_em: string;
}

/**
 * A sessão aberta **deste** terminal (`uq_sessoes_caixa_aberta` garante no máximo uma). Nunca a de outro terminal do
 * mesmo caixa (MD 3.12.1): a do terminal substituído não é "sessão na nuvem que não existe localmente" (SYNC 22.1).
 */
export async function sessaoAbertaDoTerminal(
  db: DbEmpresa,
  terminalId: string,
): Promise<SessaoAberta | null> {
  const r = await db.execute<{ id: string; operador_id: string; aberta_em: Date | string }>(sql`
    select id, operador_id, aberta_em from sessoes_caixa
     where terminal_id = ${terminalId} and status <> 'fechada' and excluido_em is null
     limit 1`);
  const l = r.rows[0];
  if (!l) return null;
  return {
    id: l.id,
    operador_id: l.operador_id,
    aberta_em: (l.aberta_em instanceof Date ? l.aberta_em : new Date(l.aberta_em)).toISOString(),
  };
}

export interface SessaoForcada {
  id: string;
  lojaId: string;
  numeroCaixa: number;
}

/** Alerta `SESSAO_FECHADA_POR_SUBSTITUICAO` de uma sessão (um por sessão enquanto aberto). */
export async function alertarSessaoFechada(
  tx: DbEmpresa,
  s: SessaoForcada,
  motivo: MotivoFechamentoForcado,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const caixa = String(s.numeroCaixa).padStart(2, '0');
  await tx
    .insert(alertas)
    .values({
      tipo: ALERTA_SESSAO_FECHADA,
      severidade: 'aviso',
      titulo: `Sessão do caixa ${caixa} fechada pela nuvem (${DESCRICAO_MOTIVO[motivo]})`,
      mensagem:
        'O terminal saiu do caixa com o turno aberto: a sessão foi fechada sem o fechamento do operador. ' +
        'Confira o caixa em Fechamentos de caixa; se o fechamento do terminal antigo ainda chegar, ele é gravado.',
      lojaId: s.lojaId,
      entidade: 'sessoes_caixa',
      registroId: s.id,
      dados: { motivo, ...extra },
      chaveDeduplicacao: `sessao_forcada:${s.id}`,
    })
    .onConflictDoNothing();
}

/**
 * MD 3.12.1: na ativação de um substituto ou na revogação, a sessão aberta do terminal que sai fecha na mesma
 * transação (`fechamento_forcado`, sem `fechamentos_caixa`), com o alerta para a conferência. `terminais.sessao_caixa_id`
 * só é limpo onde ainda for a sessão fechada (T12). Idempotente: sem sessão aberta, nada muda. Devolve as sessões
 * fechadas.
 */
export async function fecharSessoesDoTerminal(
  tx: DbEmpresa,
  terminalId: string,
  motivo: MotivoFechamentoForcado,
): Promise<string[]> {
  const fechadas = await tx.execute<{ id: string; loja_id: string; numero_caixa: number }>(sql`
    update sessoes_caixa
       set status = 'fechada', fechada_em = now(), fechamento_forcado = true, fechamento_forcado_motivo = ${motivo}
     where terminal_id = ${terminalId} and status <> 'fechada' and excluido_em is null
    returning id, loja_id, numero_caixa`);
  for (const s of fechadas.rows) {
    await tx.execute(sql`
      update terminais set sessao_caixa_id = null where id = ${terminalId} and sessao_caixa_id = ${s.id}`);
    await alertarSessaoFechada(
      tx,
      { id: s.id, lojaId: s.loja_id, numeroCaixa: Number(s.numero_caixa) },
      motivo,
    );
  }
  return fechadas.rows.map((s) => s.id);
}
