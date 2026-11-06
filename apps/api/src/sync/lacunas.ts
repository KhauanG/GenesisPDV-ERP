/**
 * Lacunas de sequência (SYNC 8.6; bloco C15 da 1C). Uma lacuna (`sequencia > esperado`) nunca é operação normal: o
 * PDV primeiro reenvia o que ainda tem (inclusive confirmados, quando a nuvem foi restaurada de backup) e só o que não
 * existe mais em lugar nenhum vira **lacuna declarada** — `declarar_lacuna` no push, com a liberação de um supervisor
 * com `pdv.config.fiscal`. A nuvem grava um placeholder `terminal.lacuna` por sequência e a fila do terminal anda.
 *
 * Placeholder (decisão técnica T7): linha comum de `eventos_recebidos` com `status = 'descartado'`, `evento_id` próprio
 * (v7), agregado = o terminal, `payload` = a declaração (`lacuna: {de, ate}`, motivo, observação e quem liberou) e o
 * hash do JCS dele, `descartado_por_id` = o supervisor, **já entregue** (`resolucao_entregue_em` preenchido: o
 * heartbeat não o manda ao PDV como "descartado") e **sem** `entidades_evento` (nada depende dele, e trocar o
 * `evento_id` na substituição não esbarra na FK `fk_entidades_evento_evento_id`). Volta no `GET /sync/recuperar` (C17)
 * com o tipo `terminal.lacuna`.
 *
 * **Lacuna recuperada**: o evento real que chega numa sequência ocupada por placeholder **substitui** a linha (mesma
 * `sequencia_terminal`, o resto passa a ser o do evento), o placeholder original vai para a `auditoria`
 * `lacuna_substituida` e o evento é aplicado normalmente (8.3). Exige `recuperar_lacuna` no lote (liberação de
 * supervisor) — a importação 22.3 (Fase 1D) vale como a autorização; sem ela o evento recebe `lacuna_recuperavel` e o
 * lote para. Depois do lote: `LACUNA_RECUPERADA`, o `LACUNA_DECLARADA` da faixa resolvido quando não sobra
 * placeholder e o reprocessamento em ordem dos eventos em `erro`/`retido` posteriores (tarefa da fila de decisão).
 *
 * Tudo aqui roda numa **transação de evento** (SYNC 8.1): a trava `push:<terminal>` é a primeira (o chamador a pega).
 */
import {
  ALERTA_LACUNA_DECLARADA,
  ALERTA_LACUNA_RECUPERADA,
  jcs,
  PERMISSOES,
  TIPO_TERMINAL_LACUNA,
  type DeclararLacuna,
  type RecuperarLacuna,
} from '@genesis/shared';
import { and, between, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { PermissoesEfetivas } from '../autorizacao/permissoes-efetivas.js';
import { alertas, eventosRecebidos, terminais, usuarios } from '../database/empresa/schema/index.js';
import { sha256Hex } from '../seguranca/tokens.js';
import type { ClienteEmpresa, DbEmpresa } from '../tenancy/tenancy.js';
import type { TerminalDoEvento } from './aplicacao.js';
import { envelopeSemPayload } from './aplicacao.js';
import type { EnvelopeEvento } from './contratos.js';
import { ErroSync } from './erros.js';
import { registrarAuditoriaPdv } from './handlers/comum.js';

/** Permissão de quem libera a declaração e a recuperação no caixa (SYNC 8.6; PDV 31.3). */
export const PERMISSAO_LACUNA = 'pdv.config.fiscal';

type LinhaRecebida = typeof eventosRecebidos.$inferSelect;

/** Faixa declarada gravada no placeholder (`payload.lacuna`). */
export interface FaixaLacuna {
  de: number;
  ate: number;
}

const caixa2 = (n: number) => String(n).padStart(2, '0');
const faixaTexto = (f: FaixaLacuna) => (f.de === f.ate ? `nº ${f.de}` : `nº ${f.de} a ${f.ate}`);

/** `chave_deduplicacao` do `LACUNA_DECLARADA`: um por faixa do terminal. */
export const chaveLacunaDeclarada = (terminalId: string, f: FaixaLacuna) =>
  `lacuna_declarada:${terminalId}:${f.de}-${f.ate}`;

const TEXTO_MOTIVO: Readonly<Record<DeclararLacuna['motivo'], string>> = {
  banco_local_perdido: 'eventos perdidos no banco do caixa',
  restauracao_backup: 'nuvem restaurada de backup sem os eventos no caixa',
  outro: 'outro motivo',
};

/**
 * Quem liberou no caixa existe, está ativo, tem `pdv.config.fiscal` e acesso à loja do terminal agora (a liberação foi
 * conferida pelo PIN, offline, com as permissões e as lojas da última descida: o hash do PIN só desce para o Master e
 * para quem tem a loja em `usuarios_lojas`). Senão o lote inteiro é recusado (`LIBERACAO_INVALIDA`, 422) sem processar
 * nada: declarar é admitir perda de dados, e quem perdeu a loja depois da última descida não responde mais por ela.
 * Devolve o nome, para o alerta.
 */
export async function conferirLiberacaoLacuna(
  db: DbEmpresa,
  permissoes: PermissoesEfetivas,
  empresaId: string,
  usuarioId: string,
  lojaId: string,
): Promise<{ nome: string }> {
  const [u] = await db
    .select({
      id: usuarios.id,
      nome: usuarios.nome,
      ativo: usuarios.ativo,
      master: usuarios.master,
      perfilId: usuarios.perfilId,
      permissoesVersao: usuarios.permissoesVersao,
    })
    .from(usuarios)
    .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm)));
  if (!u || !u.ativo) {
    throw new ErroSync('LIBERACAO_INVALIDA', 'Quem liberou a lacuna não é um usuário ativo da empresa.', {
      autorizado_por_id: usuarioId,
    });
  }
  const acesso = await permissoes.obter(db, empresaId, u);
  if (!acesso.permissoes.has(PERMISSAO_LACUNA)) {
    const descricao = PERMISSOES.find((p) => p.chave === PERMISSAO_LACUNA)?.descricao ?? PERMISSAO_LACUNA;
    throw new ErroSync(
      'LIBERACAO_INVALIDA',
      `${u.nome} não tem a permissão "${descricao}" (${PERMISSAO_LACUNA}) exigida para a lacuna.`,
      { autorizado_por_id: usuarioId, permissao: PERMISSAO_LACUNA },
    );
  }
  // `null` = todas as lojas (Master).
  if (acesso.lojas !== null && !acesso.lojas.includes(lojaId)) {
    throw new ErroSync('LIBERACAO_INVALIDA', `${u.nome} não tem acesso à loja deste caixa.`, {
      autorizado_por_id: usuarioId,
      loja_id: lojaId,
    });
  }
  return { nome: u.nome };
}

/**
 * Próxima sequência que a nuvem espera do terminal (`max + 1`, placeholders incluídos): a mesma conta para o push
 * (`proxima_sequencia_esperada`, ordem do 8.1) e para a faixa da declaração.
 */
export async function esperadoDoTerminal(c: ClienteEmpresa, terminalId: string): Promise<number> {
  const { rows } = await c.query<{ esperado: string }>(
    'select (coalesce(max(sequencia_terminal), 0) + 1)::text as esperado from eventos_recebidos where terminal_id = $1',
    [terminalId],
  );
  return Number(rows[0]!.esperado);
}

/** A faixa da declaração gravada no `payload` do placeholder (`null` se a linha não é placeholder). */
export function faixaDoPlaceholder(l: Pick<LinhaRecebida, 'tipo' | 'payload'>): FaixaLacuna | null {
  if (l.tipo !== TIPO_TERMINAL_LACUNA) return null;
  const lacuna = (l.payload as { lacuna?: { de?: unknown; ate?: unknown } } | null)?.lacuna;
  return typeof lacuna?.de === 'number' && typeof lacuna.ate === 'number'
    ? { de: lacuna.de, ate: lacuna.ate }
    : null;
}

/**
 * `declarar_lacuna` (SYNC 8.6), dentro da transação de evento (trava do terminal já pega): aceita só a faixa que
 * começa na sequência esperada — a anterior teria sequências já recebidas, a posterior deixaria outra lacuna antes —
 * e grava um placeholder por sequência e o alerta crítico `LACUNA_DECLARADA`. A **mesma** declaração repetida (reenvio
 * sem resposta: a faixa inteira já é placeholder dessa faixa) não faz nada e responde igual. Qualquer outro caso →
 * 409 `LACUNA_INVALIDA` com a `proxima_sequencia_esperada`, nada gravado.
 */
export async function declararLacuna(
  tx: DbEmpresa,
  c: ClienteEmpresa,
  terminal: TerminalDoEvento,
  d: DeclararLacuna,
  contexto: { loteId: string; autorizadoPorNome: string; eventosPendentesTotal?: number },
): Promise<{ repetida: boolean }> {
  const esperado = await esperadoDoTerminal(c, terminal.terminalId);
  const faixa = { de: d.de, ate: d.ate };
  if (d.de < esperado) {
    const linhas = await tx
      .select({ tipo: eventosRecebidos.tipo, payload: eventosRecebidos.payload })
      .from(eventosRecebidos)
      .where(
        and(
          eq(eventosRecebidos.terminalId, terminal.terminalId),
          between(eventosRecebidos.sequenciaTerminal, d.de, d.ate),
        ),
      );
    const repetida =
      linhas.length === d.ate - d.de + 1 &&
      linhas.every((l) => {
        const f = faixaDoPlaceholder(l);
        return f?.de === d.de && f.ate === d.ate;
      });
    if (repetida) return { repetida: true };
  }
  if (d.de !== esperado) {
    throw new ErroSync(
      'LACUNA_INVALIDA',
      d.de < esperado
        ? `A faixa ${faixaTexto(faixa)} tem sequências que a nuvem já recebeu.`
        : `A lacuna tem de começar na sequência que a nuvem espera (${esperado}).`,
      { proxima_sequencia_esperada: esperado, de: d.de, ate: d.ate },
    );
  }
  const agora = new Date();
  const payload: Record<string, unknown> = {
    lacuna: faixa,
    motivo: d.motivo,
    observacao: d.observacao ?? null,
    autorizado_por_id: d.autorizado_por_id,
  };
  const hash = sha256Hex(jcs(payload));
  const justificativa =
    `Lacuna declarada no caixa ${caixa2(terminal.numeroCaixa)} (${TEXTO_MOTIVO[d.motivo]}), ` +
    `liberada por ${contexto.autorizadoPorNome}${d.observacao ? `: ${d.observacao}` : '.'}`;
  const linhas = [];
  for (let s = d.de; s <= d.ate; s++) {
    linhas.push({
      eventoId: uuidv7(),
      terminalId: terminal.terminalId,
      lojaId: terminal.lojaId,
      sequenciaTerminal: s,
      tipo: TIPO_TERMINAL_LACUNA,
      versaoSchema: 1,
      agregadoTipo: 'terminal',
      agregadoId: terminal.terminalId,
      loteId: contexto.loteId,
      ocorridoEm: agora,
      status: 'descartado',
      tentativas: 0,
      payload,
      payloadSha256: hash,
      resultado: { descartado: true, lacuna: faixa },
      descartadoEm: agora,
      descartadoPorId: d.autorizado_por_id,
      justificativaDescarte: justificativa.slice(0, 2000),
      // Já entregue: o heartbeat não manda o placeholder ao PDV como "descartado" (SYNC 21.1).
      resolucaoEntregueEm: agora,
    });
  }
  // Em blocos: até 5000 linhas (MAXIMO_SEQUENCIAS_LACUNA) sem estourar o limite de parâmetros do PostgreSQL.
  for (let i = 0; i < linhas.length; i += 500) {
    await tx.insert(eventosRecebidos).values(linhas.slice(i, i + 500));
  }
  const [t] = await tx
    .select({ eventosPendentes: terminais.eventosPendentes })
    .from(terminais)
    .where(eq(terminais.id, terminal.terminalId));
  const quantidade = d.ate - d.de + 1;
  await tx
    .insert(alertas)
    .values({
      tipo: ALERTA_LACUNA_DECLARADA,
      severidade: 'critico',
      titulo:
        `Caixa ${caixa2(terminal.numeroCaixa)}: lacuna de ${quantidade} evento(s) declarada ` +
        `(${faixaTexto(faixa)})`.slice(0, 150),
      mensagem:
        `O caixa declarou perdidos os eventos ${faixaTexto(faixa)} (${TEXTO_MOTIVO[d.motivo]}), com a liberação ` +
        `de ${contexto.autorizadoPorNome}${d.observacao ? `: ${d.observacao}` : '.'} Vendas e movimentos desses ` +
        `eventos podem não ter chegado à nuvem; confira com o caixa (eventos pendentes informados antes: ` +
        `${t?.eventosPendentes ?? 0}). Se os eventos aparecerem depois, o caixa os reenvia e este alerta fecha.`,
      lojaId: terminal.lojaId,
      entidade: 'terminais',
      registroId: terminal.terminalId,
      dados: {
        terminal_id: terminal.terminalId,
        de: d.de,
        ate: d.ate,
        quantidade,
        motivo: d.motivo,
        observacao: d.observacao ?? null,
        autorizado_por_id: d.autorizado_por_id,
        autorizado_por_nome: contexto.autorizadoPorNome,
        eventos_pendentes_informados: t?.eventosPendentes ?? 0,
        eventos_pendentes_total: contexto.eventosPendentesTotal ?? null,
        lote_id: contexto.loteId,
      },
      chaveDeduplicacao: chaveLacunaDeclarada(terminal.terminalId, faixa),
    })
    .onConflictDoNothing();
  return { repetida: false };
}

/** O placeholder `terminal.lacuna` da sequência (ainda não substituído), ou `null`. */
export async function placeholderNaSequencia(
  tx: DbEmpresa,
  terminalId: string,
  sequencia: number,
): Promise<LinhaRecebida | null> {
  const [l] = await tx
    .select()
    .from(eventosRecebidos)
    .where(
      and(
        eq(eventosRecebidos.terminalId, terminalId),
        eq(eventosRecebidos.sequenciaTerminal, sequencia),
        eq(eventosRecebidos.tipo, TIPO_TERMINAL_LACUNA),
        eq(eventosRecebidos.status, 'descartado'),
      ),
    );
  return l ?? null;
}

/** A recuperação autorizada no lote cobre a sequência? */
export function recuperacaoCobre(r: RecuperarLacuna | undefined, sequencia: number): boolean {
  return r !== undefined && sequencia >= r.de && sequencia <= r.ate;
}

/**
 * Substitui o placeholder pelo evento real (SYNC 8.6), na mesma linha e na mesma sequência: a linha passa a ter o
 * `evento_id`, o tipo, o agregado, o payload, o envelope e o hash do evento, `status = 'recebido'` e nada do descarte.
 * O placeholder original vai para a `auditoria` `lacuna_substituida` (origem PDV, com o evento real e quem liberou).
 * O `criado_em` passa a ser a hora em que a nuvem recebeu o lote do evento real (`recebidoEm`, a mesma do
 * `alertarRelogioDoEvento`): é a chegada que o detalhe do acerto mostra e reavalia (F2-B10, `compensacoes-acerto.ts`);
 * a hora da declaração fica na auditoria (`antes.declarada_em`).
 * O chamador aplica em seguida (`aplicarEvento`); se a aplicação falhar, o `rollback` desfaz a troca e a transação
 * nova que grava o `erro` substitui de novo.
 */
export async function substituirPlaceholder(
  tx: DbEmpresa,
  terminal: TerminalDoEvento,
  placeholder: LinhaRecebida,
  ev: EnvelopeEvento,
  r: { loteId: string; autorizadoPorId: string; tentativas: number; recebidoEm: Date },
): Promise<FaixaLacuna> {
  const faixa = faixaDoPlaceholder(placeholder) ?? { de: ev.sequencia, ate: ev.sequencia };
  await tx
    .update(eventosRecebidos)
    .set({
      eventoId: ev.evento_id,
      tipo: ev.tipo,
      versaoSchema: ev.versao_schema,
      agregadoTipo: ev.agregado_tipo,
      agregadoId: ev.agregado_id,
      dependencias: ev.dependencias,
      loteId: r.loteId,
      ocorridoEm: new Date(ev.ocorrido_em),
      ocorridoEmLocal: ev.ocorrido_em_local ? new Date(ev.ocorrido_em_local) : null,
      status: 'recebido',
      tentativas: r.tentativas,
      erroCodigo: null,
      erro: null,
      payload: ev.payload,
      envelope: envelopeSemPayload(ev),
      payloadSha256: ev.payload_sha256,
      resultado: null,
      versaoNuvem: null,
      versaoNuvemFim: null,
      aplicadoEm: null,
      resolucaoEntregueEm: null,
      descartadoEm: null,
      descartadoPorId: null,
      justificativaDescarte: null,
      criadoEm: r.recebidoEm,
      atualizadoEm: new Date(),
    })
    .where(eq(eventosRecebidos.id, placeholder.id));
  await registrarAuditoriaPdv(
    { tx, evento: ev, terminal },
    {
      entidade: 'eventos_recebidos',
      registroId: placeholder.id,
      acao: 'lacuna_substituida',
      localizacao: 'Sincronização › Lacuna recuperada',
      descricao:
        `Placeholder da sequência ${ev.sequencia} (lacuna ${faixaTexto(faixa)} do caixa ` +
        `${caixa2(terminal.numeroCaixa)}) substituído pelo evento ${ev.tipo} ${ev.evento_id}`,
      antes: {
        evento_id: placeholder.eventoId,
        tipo: placeholder.tipo,
        payload: placeholder.payload,
        justificativa_descarte: placeholder.justificativaDescarte,
        descartado_em: placeholder.descartadoEm?.toISOString() ?? null,
        descartado_por_id: placeholder.descartadoPorId,
        declarada_em: placeholder.criadoEm.toISOString(),
      },
      depois: {
        evento_id: ev.evento_id,
        tipo: ev.tipo,
        agregado_tipo: ev.agregado_tipo,
        agregado_id: ev.agregado_id,
      },
      usuarioId: r.autorizadoPorId,
      autorizadoPorId: r.autorizadoPorId,
      // Agora, e não o `ocorrido_em` do evento (pode ser de um mês sem partição da auditoria).
      ocorridoEm: new Date(),
    },
  );
  return faixa;
}

/** Evento real que substituiu um placeholder neste lote (para o `LACUNA_RECUPERADA`). */
export interface Substituicao {
  sequencia: number;
  /** Status devolvido ao PDV (`aplicado`, ou `rejeitado` quando o evento recuperado foi para a fila de decisão). */
  status: string;
  faixa: FaixaLacuna;
  /** `numero_exibicao` da venda recuperada (`venda.finalizada`). */
  numeroVenda: string | null;
}

/** Número da venda do payload de um `venda.finalizada` recuperado (o alerta lista as vendas recuperadas). */
export function numeroVendaRecuperada(ev: EnvelopeEvento): string | null {
  if (ev.tipo !== 'venda.finalizada') return null;
  const v = (ev.payload as { vendas?: { numero_exibicao?: unknown } }).vendas;
  return typeof v?.numero_exibicao === 'string' ? v.numero_exibicao : null;
}

/**
 * Fecho do lote com lacuna recuperada (SYNC 8.6), numa transação de evento: o aviso `LACUNA_RECUPERADA` (as faixas, o
 * número de eventos, as vendas recuperadas e quantos placeholders ainda restam) e, em cada faixa sem placeholder
 * restante, o `LACUNA_DECLARADA` resolvido. Devolve a menor sequência das faixas, de onde parte o reprocessamento.
 */
export async function fecharLacunasRecuperadas(
  tx: DbEmpresa,
  terminal: TerminalDoEvento,
  substituicoes: readonly Substituicao[],
  contexto: { loteId: string; autorizadoPorId: string; autorizadoPorNome: string },
): Promise<{ desde: number }> {
  const faixas = [
    ...new Map(substituicoes.map((s) => [`${s.faixa.de}-${s.faixa.ate}`, s.faixa])).values(),
  ].sort((a, b) => a.de - b.de);
  const restantes: Array<FaixaLacuna & { restantes: number }> = [];
  for (const f of faixas) {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(eventosRecebidos)
      .where(
        and(
          eq(eventosRecebidos.terminalId, terminal.terminalId),
          between(eventosRecebidos.sequenciaTerminal, f.de, f.ate),
          eq(eventosRecebidos.tipo, TIPO_TERMINAL_LACUNA),
          eq(eventosRecebidos.status, 'descartado'),
        ),
      );
    restantes.push({ ...f, restantes: n });
    if (n === 0) {
      await tx
        .update(alertas)
        .set({
          resolvidoEm: new Date(),
          resolvidoPorId: contexto.autorizadoPorId,
          resolucao: 'Todos os eventos da lacuna foram recuperados pelo caixa.',
        })
        .where(
          and(
            eq(alertas.chaveDeduplicacao, chaveLacunaDeclarada(terminal.terminalId, f)),
            isNull(alertas.resolvidoEm),
            isNull(alertas.excluidoEm),
          ),
        );
    }
  }
  const vendas = substituicoes.map((s) => s.numeroVenda).filter((n): n is string => n !== null);
  const sobra = restantes.reduce((t, f) => t + f.restantes, 0);
  // Recuperados que caíram em erro de regra: a substituição ficou (com a auditoria) e o evento está na fila de decisão.
  const comErro = substituicoes.filter((s) => s.status !== 'aplicado').length;
  await tx
    .insert(alertas)
    .values({
      tipo: ALERTA_LACUNA_RECUPERADA,
      severidade: 'aviso',
      titulo:
        `Caixa ${caixa2(terminal.numeroCaixa)}: ${substituicoes.length} evento(s) de lacuna recuperado(s)`.slice(
          0,
          150,
        ),
      mensagem: (
        `O caixa reenviou ${substituicoes.length} evento(s) da lacuna ` +
        `${faixas.map(faixaTexto).join(', ')}, com a liberação de ${contexto.autorizadoPorNome}` +
        (vendas.length ? `; vendas recuperadas: ${vendas.join(', ')}` : '') +
        (sobra ? `. Ainda faltam ${sobra} evento(s) da lacuna.` : '. A lacuna foi toda recuperada.') +
        (comErro
          ? ` ${comErro} evento(s) recuperado(s) com erro estão nos eventos com erro do terminal.`
          : '') +
        ' Os eventos com erro posteriores à lacuna são reprocessados em ordem.'
      ).slice(0, 1000),
      lojaId: terminal.lojaId,
      entidade: 'terminais',
      registroId: terminal.terminalId,
      dados: {
        terminal_id: terminal.terminalId,
        lote_id: contexto.loteId,
        faixas: restantes,
        eventos: substituicoes.length,
        com_erro: comErro,
        sequencias: substituicoes.map((s) => s.sequencia),
        vendas,
        autorizado_por_id: contexto.autorizadoPorId,
      },
      chaveDeduplicacao: `lacuna_recuperada:${contexto.loteId}`,
    })
    .onConflictDoNothing();
  return { desde: faixas[0]!.de };
}
