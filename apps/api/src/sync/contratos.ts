/**
 * Contratos do `/sync/*` em `snake_case`, como as colunas (SYNC 2.3). Os schemas (requisições e respostas) ficam em
 * `@genesis/shared` (`packages/shared/src/sync/contratos.ts`), junto das fixtures que o PDV também testa; aqui só a
 * validação com o envelope do sync. Entrada inválida → 400 REQUISICAO_INVALIDA.
 */
import { z } from 'zod';
import { ErroSync } from './erros.js';

export {
  ALFABETO_ATIVACAO,
  arquivoSyncQuerySchema,
  ativarSchema,
  envelopeRecuperadoSchema,
  eventoSchema,
  eventosStatusQuerySchema,
  heartbeatSchema,
  MAXIMO_EVENTOS_LOTE,
  pullQuerySchema,
  pushSchema,
  recuperarQuerySchema,
  renovarTokenSchema,
  saldosOutrasLojasQuerySchema,
  type Ativar,
  type EnvelopeEvento,
  type EnvelopeRecuperado,
  type EventoRecuperado,
  type EventosStatusQuery,
  type Heartbeat,
  type RecuperarQuery,
  type RenovarToken,
  type RespostaAtivacao,
  type RespostaEstado,
  type RespostaEventosStatus,
  type RespostaHeartbeat,
  type RespostaPull,
  type RespostaPush,
  type RespostaRecuperar,
  type RespostaRenovarToken,
  type RespostaSaldosOutrasLojas,
  type ResultadoEvento,
  type SaldosOutrasLojasQuery,
  type StatusEventoNuvemItem,
  type StatusResultadoEvento,
} from '@genesis/shared';

/** Validação do sync: falha vira 400 REQUISICAO_INVALIDA com os campos (SYNC 2.5). */
export function validarSync<S extends z.ZodType>(schema: S, valor: unknown): z.output<S> {
  const r = schema.safeParse(valor);
  if (!r.success) {
    const campos: Record<string, string[]> = {};
    for (const i of r.error.issues) (campos[i.path.join('.') || '_'] ??= []).push(i.message);
    throw ErroSync.invalida('Requisição inválida.', { campos });
  }
  return r.data;
}
