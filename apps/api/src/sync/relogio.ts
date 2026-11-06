/**
 * Relógio na nuvem (SYNC 12.4; Fase 1C, bloco C16). Duas fontes, dois alertas:
 *
 * - **Por evento** (`RELOGIO_SUSPEITO`, `alertarRelogioDoEvento`): na chegada de cada evento novo do push, o
 *   `ocorrido_em` é comparado com a hora em que a nuvem recebeu o lote, com a ativação do terminal e com o evento
 *   anterior do terminal (pela sequência, sem os placeholders de lacuna). O evento é aplicado do mesmo jeito, com a
 *   hora do caixa (é o melhor dado que existe; a ordem é a de `sequencia_terminal`); o alerta é só para alguém acertar
 *   o relógio do computador. Roda na mesma transação que grava a linha de `eventos_recebidos` (a nova do push, a da
 *   falha gravada à parte ou a do placeholder substituído): uma avaliação por evento recebido, nunca no reenvio
 *   (`duplicado`) nem no reprocessamento pelo ERP.
 * - **Pelo heartbeat** (`RELOGIO_DESVIO`, `alertarDesvioRelogio`; T40): o desvio que o caixa mede (SYNC 12.2) acima de
 *   2 min é aviso, acima de 5 min crítico; fecha sozinho quando volta a até 2 min ou quando o terminal sai do caixa.
 *
 * Nada aqui recalcula o `dia_operacional` nem as datas do movimento (fica para a 1D, com a D7 e a NFC-e).
 */
import {
  ALERTA_RELOGIO_DESVIO,
  ALERTA_RELOGIO_SUSPEITO,
  duracaoLegivel,
  nivelDesvioRelogio,
  TIPO_TERMINAL_LACUNA,
} from '@genesis/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { alertas } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import type { TerminalDoEvento } from './aplicacao.js';
import type { EnvelopeEvento } from './contratos.js';

const MINUTO = 60_000;
const DIA = 86_400_000;
/** `ocorrido_em > recebido_em + 5 min`: evento no futuro (SYNC 12.4). */
export const RELOGIO_FUTURO_MS = 5 * MINUTO;
/** `ocorrido_em` mais de 1 dia antes da ativação do terminal (SYNC 12.4). */
export const RELOGIO_ANTES_ATIVACAO_MS = DIA;
/** `ocorrido_em` mais de 400 dias no passado (SYNC 12.4). */
export const RELOGIO_PASSADO_MS = 400 * DIA;
/** Regressão sem a marca do caixa até isto é arredondamento, não defeito (SYNC 12.4). */
export const RELOGIO_REGRESSAO_TOLERANCIA_MS = 1_000;

export type MotivoRelogioSuspeito = 'futuro' | 'passado' | 'regressao' | 'regressao_marcada';

export interface SuspeitaRelogio {
  motivo: MotivoRelogioSuspeito;
  /** `info` só na regressão marcada pelo caixa (12.3: esperada). */
  severidade: 'aviso' | 'info';
  /** Diferença em ms que disparou a regra (sempre positiva). */
  diferencaMs: number;
}

/** O evento anterior do terminal (pela sequência). */
export interface EventoAnteriorRelogio {
  sequencia: number;
  ocorridoEm: Date;
}

/**
 * As regras da SYNC 12.4 sobre um evento, sem banco (unitário em `relogio.spec.ts`). Futuro e passado se excluem; a
 * regressão é avaliada à parte (um caixa com a BIOS em 2027 que é corrigido manda o evento marcado com a hora certa,
 * e um evento no futuro pode ser também anterior a outro ainda mais no futuro).
 */
export function suspeitasDoRelogio(
  ev: { ocorridoEm: Date; relogioRegrediu: boolean },
  ctx: { recebidoEm: Date; ativadoEm: Date | null; anterior: EventoAnteriorRelogio | null },
): SuspeitaRelogio[] {
  const suspeitas: SuspeitaRelogio[] = [];
  const ocorrido = ev.ocorridoEm.getTime();
  const recebido = ctx.recebidoEm.getTime();
  if (ocorrido > recebido + RELOGIO_FUTURO_MS) {
    suspeitas.push({ motivo: 'futuro', severidade: 'aviso', diferencaMs: ocorrido - recebido });
  } else {
    const antesDaAtivacao = ctx.ativadoEm
      ? ctx.ativadoEm.getTime() - RELOGIO_ANTES_ATIVACAO_MS - ocorrido
      : 0;
    const passado = recebido - RELOGIO_PASSADO_MS - ocorrido;
    if (antesDaAtivacao > 0 || passado > 0) {
      suspeitas.push({ motivo: 'passado', severidade: 'aviso', diferencaMs: recebido - ocorrido });
    }
  }
  if (ctx.anterior) {
    const recuo = ctx.anterior.ocorridoEm.getTime() - ocorrido;
    if (recuo > 0 && ev.relogioRegrediu) {
      suspeitas.push({ motivo: 'regressao_marcada', severidade: 'info', diferencaMs: recuo });
    } else if (recuo > RELOGIO_REGRESSAO_TOLERANCIA_MS) {
      suspeitas.push({ motivo: 'regressao', severidade: 'aviso', diferencaMs: recuo });
    }
  }
  return suspeitas;
}

const numeroCaixa = (n: number) => String(n).padStart(2, '0');

/** Uma aberta por terminal e motivo; a regressão marcada, uma por regressão (o evento que a marcou). */
export function chaveRelogioSuspeito(terminalId: string, motivo: MotivoRelogioSuspeito, eventoId: string) {
  return motivo === 'regressao_marcada'
    ? `relogio_regrediu:${eventoId}`
    : `relogio_suspeito:${terminalId}:${motivo}`;
}

export const chaveDesvioRelogio = (terminalId: string) => `relogio_desvio:${terminalId}`;

function textos(
  s: SuspeitaRelogio,
  caixa: string,
  ev: EnvelopeEvento,
  ctx: { ativadoEm: Date | null; anterior: EventoAnteriorRelogio | null; recebidoEm: Date },
): { titulo: string; mensagem: string } {
  const evento = `O evento nº ${ev.sequencia} (${ev.tipo})`;
  const acerte =
    ' Os dados foram aplicados com a hora do caixa; acerte a data, a hora e o fuso do computador (ou ligue a ' +
    'sincronização automática do Windows).';
  switch (s.motivo) {
    case 'futuro':
      return {
        titulo: `Caixa ${caixa}: relógio adiantado (evento no futuro)`,
        mensagem: `${evento} chegou com a hora ${duracaoLegivel(s.diferencaMs)} à frente da nuvem.${acerte}`,
      };
    case 'passado': {
      const antes =
        ctx.ativadoEm && Date.parse(ev.ocorrido_em) < ctx.ativadoEm.getTime() - RELOGIO_ANTES_ATIVACAO_MS
          ? `${duracaoLegivel(ctx.ativadoEm.getTime() - Date.parse(ev.ocorrido_em))} antes da ativação do terminal`
          : `${duracaoLegivel(s.diferencaMs)} no passado`;
      return {
        titulo: `Caixa ${caixa}: relógio atrasado (evento no passado)`,
        mensagem: `${evento} chegou com a hora ${antes}.${acerte}`,
      };
    }
    case 'regressao':
      return {
        titulo: `Caixa ${caixa}: hora de evento anterior à do evento anterior`,
        mensagem:
          `${evento} tem a hora ${duracaoLegivel(s.diferencaMs)} antes da do nº ${ctx.anterior!.sequencia}, sem a ` +
          'marca de relógio corrigido do caixa: possível defeito do PDV, avise o suporte. A ordem dos dados é a da ' +
          'sequência, não a da hora.',
      };
    case 'regressao_marcada':
      return {
        titulo: `Caixa ${caixa}: relógio do computador voltou ${duracaoLegivel(s.diferencaMs)}`,
        mensagem:
          `${evento} é ${duracaoLegivel(s.diferencaMs)} anterior ao nº ${ctx.anterior!.sequencia}: o relógio do ` +
          'computador foi corrigido para trás e o caixa marcou a correção. Os eventos seguem a ordem da sequência; as ' +
          'horas de antes da correção podem estar adiantadas.',
      };
  }
}

/**
 * SYNC 12.4 por evento: grava os `RELOGIO_SUSPEITO` do evento que acabou de ganhar linha em `eventos_recebidos`. Com o
 * alerta do mesmo terminal e motivo ainda aberto, só soma a ocorrência e guarda o último evento em `dados`
 * (`ocorrencias`, `ultimo_evento_id`, `ultima_sequencia`, `ultimo_ocorrido_em`); a regressão marcada abre um por
 * regressão. A hora de chegada é a do lote (`recebido_em` da resposta do push).
 */
export async function alertarRelogioDoEvento(
  tx: DbEmpresa,
  terminal: TerminalDoEvento,
  ev: EnvelopeEvento,
  recebidoEm: Date,
): Promise<void> {
  const { rows } = await tx.execute<{
    ativado_em: Date | null;
    seq: string | null;
    ocorrido_em: Date | null;
  }>(sql`
    select t.ativado_em, a.sequencia_terminal::text as seq, a.ocorrido_em
      from terminais t
      left join lateral (
        select e.sequencia_terminal, e.ocorrido_em from eventos_recebidos e
         where e.terminal_id = t.id and e.sequencia_terminal < ${ev.sequencia} and e.tipo <> ${TIPO_TERMINAL_LACUNA}
         order by e.sequencia_terminal desc limit 1) a on true
     where t.id = ${terminal.terminalId}`);
  const l = rows[0];
  const ctx = {
    recebidoEm,
    ativadoEm: l?.ativado_em ? new Date(l.ativado_em) : null,
    anterior:
      l?.seq && l.ocorrido_em ? { sequencia: Number(l.seq), ocorridoEm: new Date(l.ocorrido_em) } : null,
  };
  const suspeitas = suspeitasDoRelogio(
    { ocorridoEm: new Date(ev.ocorrido_em), relogioRegrediu: ev.relogio_regrediu === true },
    ctx,
  );
  const caixa = numeroCaixa(terminal.numeroCaixa);
  for (const s of suspeitas) {
    const { titulo, mensagem } = textos(s, caixa, ev, ctx);
    await tx
      .insert(alertas)
      .values({
        tipo: ALERTA_RELOGIO_SUSPEITO,
        severidade: s.severidade,
        titulo: titulo.slice(0, 150),
        mensagem: mensagem.slice(0, 1000),
        lojaId: terminal.lojaId,
        entidade: 'terminais',
        registroId: terminal.terminalId,
        dados: {
          terminal_id: terminal.terminalId,
          motivo: s.motivo,
          evento_id: ev.evento_id,
          sequencia: ev.sequencia,
          tipo: ev.tipo,
          ocorrido_em: ev.ocorrido_em,
          recebido_em: recebidoEm.toISOString(),
          diferenca_ms: s.diferencaMs,
          relogio_confiavel: ev.relogio_confiavel ?? null,
          desvio_relogio_ms: ev.desvio_relogio_ms ?? null,
          ...(ctx.anterior
            ? {
                sequencia_anterior: ctx.anterior.sequencia,
                ocorrido_em_anterior: ctx.anterior.ocorridoEm.toISOString(),
              }
            : {}),
          ocorrencias: 1,
        },
        chaveDeduplicacao: chaveRelogioSuspeito(terminal.terminalId, s.motivo, ev.evento_id).slice(0, 150),
      })
      .onConflictDoUpdate({
        target: alertas.chaveDeduplicacao,
        targetWhere: sql`resolvido_em is null and excluido_em is null`,
        set: {
          dados: sql`coalesce(${alertas.dados}, '{}'::jsonb) || jsonb_build_object(
            'ocorrencias', coalesce((${alertas.dados} ->> 'ocorrencias')::int, 1) + 1,
            'ultimo_evento_id', ${ev.evento_id}::text,
            'ultima_sequencia', ${ev.sequencia}::bigint,
            'ultimo_ocorrido_em', ${ev.ocorrido_em}::text,
            'ultima_diferenca_ms', ${s.diferencaMs}::bigint)`,
        },
      });
  }
}

/**
 * SYNC 12.4 e 21.2 pelo heartbeat (T40): desvio acima de 2 min abre (ou atualiza) o `RELOGIO_DESVIO` do terminal com
 * a severidade da faixa (aviso até 5 min, crítico acima); até 2 min, fecha o aberto. Só regrava o alerta aberto quando
 * a severidade muda ou o desvio anda 10 s ou mais: o heartbeat chega a cada 30 s e o desvio é a mediana das amostras.
 */
export async function alertarDesvioRelogio(
  tx: DbEmpresa,
  terminal: Pick<TerminalDoEvento, 'terminalId' | 'lojaId' | 'numeroCaixa'>,
  desvioMs: number,
): Promise<void> {
  const nivel = nivelDesvioRelogio(desvioMs);
  if (nivel === null) return;
  if (nivel === 'normal') {
    await resolverAlertaDesvioRelogio(tx, terminal.terminalId, 'O desvio do relógio voltou a até 2 min');
    return;
  }
  const caixa = numeroCaixa(terminal.numeroCaixa);
  // desvio = servidor − local (SYNC 12.2): positivo é o computador atrasado.
  const sentido = desvioMs > 0 ? 'atrasado' : 'adiantado';
  await tx
    .insert(alertas)
    .values({
      tipo: ALERTA_RELOGIO_DESVIO,
      severidade: nivel,
      titulo: `Caixa ${caixa}: relógio do computador ${duracaoLegivel(desvioMs)} ${sentido}`.slice(0, 150),
      mensagem:
        `O relógio do computador do caixa ${caixa} está ${duracaoLegivel(desvioMs)} ${sentido} em relação à nuvem. ` +
        'O caixa corrige a hora dos fatos pelo desvio medido, mas o relógio errado atrapalha a NFC-e (a SEFAZ recusa ' +
        'hora muito distante) e os relatórios: acerte a data, a hora e o fuso do computador. O alerta fecha sozinho ' +
        'quando o desvio voltar a até 2 min.',
      lojaId: terminal.lojaId,
      entidade: 'terminais',
      registroId: terminal.terminalId,
      dados: {
        terminal_id: terminal.terminalId,
        desvio_relogio_ms: desvioMs,
        maior_desvio_ms: Math.abs(desvioMs),
      },
      chaveDeduplicacao: chaveDesvioRelogio(terminal.terminalId),
    })
    .onConflictDoUpdate({
      target: alertas.chaveDeduplicacao,
      targetWhere: sql`resolvido_em is null and excluido_em is null`,
      set: {
        severidade: sql`excluded.severidade`,
        titulo: sql`excluded.titulo`,
        mensagem: sql`excluded.mensagem`,
        dados: sql`excluded.dados || jsonb_build_object('maior_desvio_ms', greatest(
          coalesce((${alertas.dados} ->> 'maior_desvio_ms')::bigint, 0), abs(${desvioMs}::bigint)))`,
      },
      setWhere: sql`${alertas.severidade} <> excluded.severidade
        or abs(coalesce((${alertas.dados} ->> 'desvio_relogio_ms')::bigint, 0) - ${desvioMs}::bigint) >= 10000`,
    });
}

/** Fecha o `RELOGIO_DESVIO` aberto do terminal (desvio normal de novo, ou o terminal saiu do caixa). */
export async function resolverAlertaDesvioRelogio(
  tx: DbEmpresa,
  terminalId: string,
  resolucao: string,
): Promise<void> {
  await tx
    .update(alertas)
    .set({ resolvidoEm: new Date(), resolucao: resolucao.slice(0, 255) })
    .where(
      and(
        eq(alertas.chaveDeduplicacao, chaveDesvioRelogio(terminalId)),
        isNull(alertas.resolvidoEm),
        isNull(alertas.excluidoEm),
      ),
    );
}

/**
 * Manutenção: fecha o `RELOGIO_DESVIO` que ainda esteja aberto num terminal já `revogado` no banco da empresa. A
 * revogação e a desativação confirmada fecham o alerta na própria transação e a telemetria não o abre para o
 * revogado; isto recolhe o que tiver escapado (ex.: alerta aberto antes dessas defesas). Sem heartbeat depois da
 * revogação e sem "Ciente", nada mais o fecharia.
 */
export async function resolverDesviosDeRevogados(tx: DbEmpresa): Promise<number> {
  const r = await tx
    .update(alertas)
    .set({ resolvidoEm: new Date(), resolucao: 'Terminal revogado' })
    .where(
      and(
        eq(alertas.tipo, ALERTA_RELOGIO_DESVIO),
        eq(alertas.entidade, 'terminais'),
        isNull(alertas.resolvidoEm),
        isNull(alertas.excluidoEm),
        sql`exists (select 1 from terminais t where t.id = ${alertas.registroId} and t.status = 'revogado')`,
      ),
    )
    .returning({ id: alertas.id });
  return r.length;
}
