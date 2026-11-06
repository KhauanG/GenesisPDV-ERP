/**
 * `GET /sync/recuperar?desde_sequencia=&limite=` (SYNC 22.1, 22.2; Fase 1C, C17): a "re-hidratação". A nuvem devolve
 * ao PDV o que ele mesmo enviou, com sequência maior que `desde_sequencia`, em ordem: o envelope original (colunas +
 * `envelope`, T1), o `payload` (nulo se já anulado), a situação (`aplicado`, `descartado`, `erro`, `retido`, no formato
 * do `eventos-status`) e os marcadores de versão. Os placeholders de lacuna declarada (`terminal.lacuna`, 8.6) voltam
 * marcados com `lacuna = true` (T7): o caixa sabe que a sequência foi perdida e não tem o que recriar.
 *
 * Só leitura e só do próprio terminal (o filtro é pelo `terminal_id` do token). Estados (tabela 3.8, T6): `ativo` e
 * `desativando`; `provisionando` é 503 e `revogado` 401 na autenticação. Exige o hardware registrado (409
 * `HARDWARE_ALTERADO`, `exigirHardware`): os payloads têm dados de clientes. Com a empresa suspensa responde, como o
 * push (MD 2.3).
 */
import { STATUS_EVENTO_NUVEM, TIPO_TERMINAL_LACUNA } from '@genesis/shared';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { eventosRecebidos } from '../database/empresa/schema/index.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import { envelopeRecuperado } from './aplicacao.js';
import type { EventoRecuperado, RecuperarQuery, RespostaRecuperar } from './contratos.js';
import { situacaoNaNuvem } from './situacao-evento.js';
import type { TerminalAutenticado } from './terminal.js';

type LinhaRecebida = typeof eventosRecebidos.$inferSelect;

/**
 * Um evento da página: o envelope e a situação comum com o `eventos-status` e o heartbeat (`situacaoNaNuvem`, C14), com
 * os marcadores de versão em todo status.
 */
export function itemRecuperado(
  l: LinhaRecebida,
  terminal: Pick<TerminalAutenticado, 'caixaId' | 'numeroCaixa'>,
): EventoRecuperado {
  return {
    envelope: envelopeRecuperado(l, terminal),
    ...situacaoNaNuvem(l),
    versao_nuvem: l.versaoNuvem,
    versao_nuvem_fim: l.versaoNuvemFim,
    lacuna: l.tipo === TIPO_TERMINAL_LACUNA,
  };
}

export class RecuperarSync {
  constructor(private readonly tenancy: Tenancy) {}

  async recuperar(terminal: TerminalAutenticado, q: RecuperarQuery): Promise<RespostaRecuperar> {
    const { linhas, ultima } = await this.tenancy.cx().consulta(async (db) => {
      // Uma linha além do limite diz se há página seguinte sem um `count`.
      const linhas = await db
        .select()
        .from(eventosRecebidos)
        .where(
          and(
            eq(eventosRecebidos.terminalId, terminal.terminalId),
            gt(eventosRecebidos.sequenciaTerminal, q.desde_sequencia),
            // `recebido` nunca fica gravado fora da transação do evento (MD 3.15.2).
            inArray(eventosRecebidos.status, [...STATUS_EVENTO_NUVEM]),
          ),
        )
        .orderBy(eventosRecebidos.sequenciaTerminal)
        .limit(q.limite + 1);
      const [u] = await db
        .select({ max: sql<string | null>`max(${eventosRecebidos.sequenciaTerminal})` })
        .from(eventosRecebidos)
        .where(eq(eventosRecebidos.terminalId, terminal.terminalId));
      return { linhas, ultima: Number(u?.max ?? 0) };
    });
    const pagina = linhas.slice(0, q.limite);
    return {
      agora_servidor: new Date().toISOString(),
      desde_sequencia: q.desde_sequencia,
      ultima_recebida: ultima,
      tem_mais: linhas.length > q.limite,
      eventos: pagina.map((l) => itemRecuperado(l, terminal)),
    };
  }
}
