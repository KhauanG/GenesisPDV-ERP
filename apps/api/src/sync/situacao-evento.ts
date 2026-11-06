/**
 * A situação na nuvem de um evento recebido (SYNC 21.1, 22.2; T6), num lugar só: o `eventos_resolvidos` do heartbeat,
 * o `GET /sync/eventos-status` (C14) e o `GET /sync/recuperar` (C17) a descrevem igual, e o PDV a lê com o mesmo modelo.
 *
 * - `aplicado`: os marcadores de versão e o `resultado` gravado.
 * - `descartado`: sempre `{ descartado: true, justificativa }`, nunca o `resultado` gravado (o evento recusado e
 *   descartado no ERP guarda o `{ detalhes }` do erro). O placeholder de lacuna (`terminal.lacuna`, 8.6) leva também a
 *   faixa (`lacuna: { de, ate }`), que ele grava.
 * - `erro`/`retido`: o código e a mensagem gravados (`resultado` nulo).
 */
import { TIPO_TERMINAL_LACUNA } from '@genesis/shared';
import type { eventosRecebidos } from '../database/empresa/schema/index.js';
import type { StatusEventoNuvemItem } from './contratos.js';

type LinhaRecebida = typeof eventosRecebidos.$inferSelect;

/** O item sem o `evento_id` (o `recuperar` o leva no envelope). */
export type SituacaoEvento = Omit<StatusEventoNuvemItem, 'evento_id'>;

export function situacaoNaNuvem(l: LinhaRecebida): SituacaoEvento {
  switch (l.status) {
    case 'aplicado':
      return {
        status: 'aplicado',
        versao_nuvem: l.versaoNuvem,
        versao_nuvem_fim: l.versaoNuvemFim,
        resultado: (l.resultado as Record<string, unknown> | null) ?? {},
      };
    case 'descartado': {
      const lacuna =
        l.tipo === TIPO_TERMINAL_LACUNA ? (l.resultado as { lacuna?: unknown } | null)?.lacuna : undefined;
      return {
        status: 'descartado',
        resultado: {
          descartado: true,
          justificativa: l.justificativaDescarte,
          ...(lacuna === undefined ? {} : { lacuna }),
        },
      };
    }
    default:
      return {
        status: l.status as 'erro' | 'retido',
        resultado: null,
        erro: { codigo: l.erroCodigo ?? 'ERRO_INTERNO', mensagem: l.erro ?? '' },
      };
  }
}
