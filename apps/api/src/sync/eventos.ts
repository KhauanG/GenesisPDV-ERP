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
import {
  ACAO_AUDITORIA_DESCONHECIDA,
  ACAO_AUDITORIA_ORIGINAL_MAX,
  ALERTA_AUDITORIA_ACAO_DESCONHECIDA,
  ehAcaoAuditoria,
  ehAcaoAuditoriaSoServidor,
  payloadAuditoriaRegistrosSchema,
} from '@genesis/shared';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { mascararSensiveis } from '../auditoria/mascarar.js';
import { auditoria } from '../database/empresa/auditoria.js';
import { alertas, historicoLogins, terminais } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import type { TerminalDoEvento } from './aplicacao.js';
import { ErroRegraEvento } from './erros.js';
import { HANDLERS_ALERTA } from './handlers/alertas.js';
import { HANDLERS_CAIXA } from './handlers/caixa.js';
import { HANDLERS_CANCELAMENTO } from './handlers/cancelamento.js';
import {
  registrarAuditoriaPdv,
  semParticao,
  versoesAnunciadas,
  type CatalogoHandlers,
} from './handlers/comum.js';
import { HANDLERS_VASILHAME } from './handlers/vasilhame.js';
import { HANDLERS_VENDA } from './handlers/vendas.js';

export type {
  CatalogoHandlers,
  ContextoHandler,
  DependenciaEvento,
  HandlerEvento,
  VersaoAnteriorEvento,
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

/**
 * Descrição do registro com a ação que a nuvem não conhece (F3-B4): o texto original (até 64 caracteres) na frente da
 * descrição do caixa, dentro do limite da coluna do payload (2000).
 */
export function descricaoAcaoDesconhecida(acao: string, descricao: string | null | undefined): string {
  const marca = `[Ação do caixa desconhecida nesta versão da nuvem: "${acao.slice(0, ACAO_AUDITORIA_ORIGINAL_MAX)}"]`;
  return (descricao ? `${marca} ${descricao}` : marca).slice(0, 2000);
}

/** `chave_deduplicacao` do `AUDITORIA_ACAO_DESCONHECIDA`: um aberto por terminal e ação original. */
export const chaveAcaoDesconhecida = (terminalId: string, acao: string) =>
  `acao_desconhecida:${terminalId}:${acao.slice(0, ACAO_AUDITORIA_ORIGINAL_MAX)}`;

/**
 * Teto de ações desconhecidas diferentes que abrem alerta num lote: um caixa com defeito (ou adulterado) não enche a
 * tela do terminal de alertas; as linhas de auditoria são gravadas todas, e o resultado do evento lista todas as ações.
 */
export const ALERTAS_ACAO_DESCONHECIDA_POR_LOTE = 20;

/**
 * Abre (ou soma as ocorrências do aberto) o `AUDITORIA_ACAO_DESCONHECIDA` de cada ação desconhecida que o lote gravou
 * (F3-B4): aviso, no terminal, até o "Ciente". Reaplicar o mesmo lote não soma de novo (só conta o registro inserido).
 */
async function alertarAcoesDesconhecidas(
  tx: DbEmpresa,
  evento: { evento_id: string; sequencia: number },
  terminal: TerminalDoEvento,
  porAcao: ReadonlyMap<string, number>,
): Promise<void> {
  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  for (const [acao, quantidade] of [...porAcao].slice(0, ALERTAS_ACAO_DESCONHECIDA_POR_LOTE)) {
    await tx
      .insert(alertas)
      .values({
        tipo: ALERTA_AUDITORIA_ACAO_DESCONHECIDA,
        severidade: 'aviso',
        titulo: `Caixa ${caixa}: auditoria com ação desconhecida ("${acao}")`.slice(0, 150),
        mensagem:
          `O caixa ${caixa} enviou registros de auditoria com a ação "${acao}", que esta versão da nuvem não ` +
          'conhece (o caixa é mais novo que a API). Eles foram guardados como "ação desconhecida", com o texto ' +
          'original na descrição. Atualize a API; depois, marque "Ciente".',
        lojaId: terminal.lojaId,
        entidade: 'terminais',
        registroId: terminal.terminalId,
        dados: {
          terminal_id: terminal.terminalId,
          acao,
          evento_id: evento.evento_id,
          sequencia: evento.sequencia,
          ocorrencias: quantidade,
        },
        chaveDeduplicacao: chaveAcaoDesconhecida(terminal.terminalId, acao).slice(0, 150),
      })
      .onConflictDoUpdate({
        target: alertas.chaveDeduplicacao,
        targetWhere: sql`resolvido_em is null and excluido_em is null`,
        set: {
          dados: sql`coalesce(${alertas.dados}, '{}'::jsonb) || jsonb_build_object(
            'ocorrencias', coalesce((${alertas.dados} ->> 'ocorrencias')::int, 0) + ${quantidade}::int,
            'ultimo_evento_id', ${evento.evento_id}::text,
            'ultima_sequencia', ${evento.sequencia}::bigint)`,
        },
      });
  }
}

export const HANDLERS: CatalogoHandlers = {
  'auditoria.registros': {
    1: {
      schema: payloadAuditoriaRegistrosSchema,
      async aplicar({ tx, evento, terminal }, p: z.infer<typeof payloadAuditoriaRegistrosSchema>) {
        // O estado que o servidor lê da auditoria (ex.: a revogação do terminal) só vem dele: o lote do caixa que
        // traz uma dessas ações é recusado inteiro (o PDV nunca as gera).
        const reservadas = p.registros.filter((r) => ehAcaoAuditoriaSoServidor(r.acao)).map((r) => r.acao);
        if (reservadas.length) {
          throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Ação de auditoria reservada ao servidor.', {
            acoes: [...new Set(reservadas)],
          });
        }
        // A ação fora do catálogo (F3-B4) não derruba mais o lote: um caixa mais novo diante desta API travaria o
        // evento para sempre (o `auditoria.registros` não passa pelo T13). Vira `acao_desconhecida`, com o texto
        // original na descrição e o alerta no terminal.
        const desconhecidas = new Map<string, number>();
        let gravados = 0;
        try {
          for (const r of p.registros) {
            const conhecida = ehAcaoAuditoria(r.acao);
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
                acao: conhecida ? r.acao : ACAO_AUDITORIA_DESCONHECIDA,
                localizacao: r.localizacao ?? null,
                descricao: conhecida ? (r.descricao ?? null) : descricaoAcaoDesconhecida(r.acao, r.descricao),
                antes: r.antes === undefined ? null : mascararSensiveis(r.antes),
                depois: r.depois === undefined ? null : mascararSensiveis(r.depois),
                eventoId: evento.evento_id,
              })
              .onConflictDoNothing()
              .returning({ id: auditoria.id });
            gravados += inseridos.length;
            if (!conhecida && inseridos.length)
              desconhecidas.set(r.acao, (desconhecidas.get(r.acao) ?? 0) + 1);
          }
        } catch (e) {
          if (semParticao(e))
            throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'ocorrido_em fora do período aceito.');
          throw e;
        }
        await alertarAcoesDesconhecidas(tx, evento, terminal, desconhecidas);
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
        return {
          registros: gravados,
          logins,
          ...(desconhecidas.size ? { acoes_desconhecidas: [...desconhecidas.keys()] } : {}),
        };
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

/**
 * `GET /sync/estado` › `versoes_schema` (SYNC 17.5; T13; F3-B4): as versões de payload que esta API aplica **e
 * anuncia**, por tipo (o formato `Record<tipo, versões>` não muda). A versão que o handler já aceita e ainda não foi
 * anunciada (o anúncio é no fim da onda) fica fora; a v1 de `venda.finalizada` e de `vasilhame.movimentado` nunca sai
 * (o PDV instalado grava a v1; o `contratos-eventos.spec.ts` confere).
 */
export function versoesSchemaAceitas(catalogo: CatalogoHandlers = HANDLERS): Record<string, number[]> {
  return versoesAnunciadas(catalogo);
}
