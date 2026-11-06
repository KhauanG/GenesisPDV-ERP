/**
 * Catálogo dos tipos de evento aceitos pelo push (SYNC 9) e seus handlers. Um handler roda dentro da transação do
 * evento (`aplicarEvento`, `aplicacao.ts`), já com a trava de ordenação 7300001 e o marcador `versao_nuvem`
 * reservados, sem nenhuma E/S externa (SYNC 8.3). Erro de regra → `ErroRegraEvento` (o evento fica `erro`, a fila
 * segue). O contexto, a interface e a auditoria comum ficam em `handlers/comum.ts`.
 *
 * Fase 0: `auditoria.registros` e `terminal.configuracao_alterada` (só tocam tabelas que já existem). Fase 1C: os cinco
 * `caixa.*` (`handlers/caixa.ts`, bloco C5), o `venda.finalizada` (`handlers/vendas.ts`, bloco C6b), o
 * `venda.cancelada` nas formas A e B (`handlers/cancelamento.ts`), o `vasilhame.movimentado` (`handlers/vasilhame.ts`)
 * e o `alerta.cadastro` (`handlers/alertas.ts`), bloco C7. Os demais tipos do catálogo chegam como
 * `SCHEMA_DESCONHECIDO` (transitório): o PDV os mantém no outbox até a fase que os aplica, e só gera o tipo que
 * `versoes_schema` anuncia (T13).
 */
import { ehAcaoAuditoria, payloadAuditoriaRegistrosSchema } from '@genesis/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { mascararSensiveis } from '../auditoria/mascarar.js';
import { auditoria } from '../database/empresa/auditoria.js';
import { historicoLogins, terminais } from '../database/empresa/schema/index.js';
import { ErroRegraEvento } from './erros.js';
import { HANDLERS_ALERTA } from './handlers/alertas.js';
import { HANDLERS_CAIXA } from './handlers/caixa.js';
import { HANDLERS_CANCELAMENTO } from './handlers/cancelamento.js';
import { registrarAuditoriaPdv, semParticao, type CatalogoHandlers } from './handlers/comum.js';
import { HANDLERS_VASILHAME } from './handlers/vasilhame.js';
import { HANDLERS_VENDA } from './handlers/vendas.js';

export type {
  CatalogoHandlers,
  ContextoHandler,
  DependenciaEvento,
  HandlerEvento,
} from './handlers/comum.js';

const uuid = z.uuid();
const instante = z.iso.datetime({ offset: true });

const configuracaoAlteradaSchema = z.object({
  alteracoes: z
    .array(
      z.object({
        chave: z.string().min(1).max(100),
        valor_anterior: z.unknown().optional(),
        valor_novo: z.unknown().optional(),
        atualizado_em: instante.optional(),
        atualizado_por_id: uuid.nullable().optional(),
      }),
    )
    .max(500),
  configuracao_completa: z.record(z.string(), z.unknown()),
});

export const HANDLERS: CatalogoHandlers = {
  'auditoria.registros': {
    1: {
      schema: payloadAuditoriaRegistrosSchema,
      async aplicar({ tx, evento, terminal }, p: z.infer<typeof payloadAuditoriaRegistrosSchema>) {
        const invalidas = p.registros.filter((r) => !ehAcaoAuditoria(r.acao)).map((r) => r.acao);
        if (invalidas.length) {
          throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Ação de auditoria fora do catálogo.', {
            acoes: invalidas,
          });
        }
        let gravados = 0;
        try {
          for (const r of p.registros) {
            // Idempotente pelo id do registro local (SYNC 9.22).
            const inseridos = await tx
              .insert(auditoria)
              .values({
                id: r.id,
                ocorridoEm: new Date(r.ocorrido_em),
                origem: 'pdv',
                usuarioId: r.usuario_id ?? null,
                autorizadoPorId: r.autorizado_por_id ?? null,
                terminalId: terminal.terminalId,
                lojaId: terminal.lojaId,
                entidade: r.entidade,
                registroId: r.registro_id ?? null,
                acao: r.acao,
                localizacao: r.localizacao ?? null,
                descricao: r.descricao ?? null,
                antes: r.antes === undefined ? null : mascararSensiveis(r.antes),
                depois: r.depois === undefined ? null : mascararSensiveis(r.depois),
                eventoId: evento.evento_id,
              })
              .onConflictDoNothing()
              .returning({ id: auditoria.id });
            gravados += inseridos.length;
          }
        } catch (e) {
          if (semParticao(e))
            throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'ocorrido_em fora do período aceito.');
          throw e;
        }
        let logins = 0;
        for (const l of p.logins) {
          const inseridos = await tx
            .insert(historicoLogins)
            .values({
              id: l.id,
              ocorridoEm: new Date(l.ocorrido_em),
              origem: 'pdv',
              usuarioId: l.usuario_id ?? null,
              loginInformado: l.login_informado,
              terminalId: terminal.terminalId,
              sucesso: l.sucesso,
              motivoFalha: l.motivo_falha ?? null,
            })
            .onConflictDoNothing()
            .returning({ id: historicoLogins.id });
          logins += inseridos.length;
        }
        return { registros: gravados, logins };
      },
    },
  },
  'terminal.configuracao_alterada': {
    1: {
      schema: configuracaoAlteradaSchema,
      async aplicar(ctx, p: z.infer<typeof configuracaoAlteradaSchema>) {
        const { tx, terminal } = ctx;
        await tx
          .update(terminais)
          .set({ configuracaoLocal: mascararSensiveis(p.configuracao_completa) as Record<string, unknown> })
          .where(eq(terminais.id, terminal.terminalId));
        await registrarAuditoriaPdv(ctx, {
          entidade: 'terminais',
          registroId: terminal.terminalId,
          acao: 'editar',
          localizacao: 'PDV › Configuração',
          descricao: `Configuração do terminal alterada: ${p.alteracoes.map((a) => a.chave).join(', ')}`,
          antes: Object.fromEntries(p.alteracoes.map((a) => [a.chave, a.valor_anterior ?? null])),
          depois: Object.fromEntries(p.alteracoes.map((a) => [a.chave, a.valor_novo ?? null])),
        });
        return {};
      },
    },
  },
  ...HANDLERS_CAIXA,
  ...HANDLERS_VENDA,
  ...HANDLERS_CANCELAMENTO,
  ...HANDLERS_VASILHAME,
  ...HANDLERS_ALERTA,
};

/** `GET /sync/estado` › `versoes_schema`: versões de payload que esta API aplica, por tipo. */
export function versoesSchemaAceitas(): Record<string, number[]> {
  return Object.fromEntries(Object.entries(HANDLERS).map(([tipo, v]) => [tipo, Object.keys(v).map(Number)]));
}
