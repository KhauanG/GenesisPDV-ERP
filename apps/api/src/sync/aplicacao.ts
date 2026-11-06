/**
 * Aplicação de um evento do PDV (SYNC 8.3), comum ao push, ao reprocessamento pelo ERP (11.4), à lacuna recuperada
 * (8.6) e à importação 22.3. Tudo aqui roda numa **transação de evento**: a primeira trava é a do terminal
 * (`push:<terminal_id>`) e a segunda a de ordenação 7300001 (`fn_trava_versao`), nessa ordem e antes de qualquer
 * trava de linha (SYNC 8.1). Por isso nada daqui usa `transacao({ travaVersao: true })`, que pega a 7300001 primeiro.
 *
 * Quem chama abre a transação, pega a trava do terminal (o push usa a forma `try` no 1º evento do lote), confere a
 * sequência e garante a linha de `eventos_recebidos`; `aplicarEvento` reentra na trava do terminal (consultiva de
 * transação: pegar de novo na mesma transação não espera; não conserta a ordem se o chamador já tiver a 7300001
 * ou uma trava de linha, o que daria deadlock com o push do mesmo terminal), confere o escopo, as dependências (as do
 * envelope e as que o handler recalcula do payload, SYNC 8.5), o schema do tipo e o agregado do contrato, lê os
 * cadastros do handler sem trava (`preparar`, C6a), pega a 7300001, roda o handler e marca `aplicado`. Erros sobem:
 * o chamador desfaz e grava `erro` em transação nova (`traduzirErroBanco` primeiro, fora da transação).
 */
import {
  ALERTA_EVENTO_COM_ERRO as ALERTA_EVENTO_COM_ERRO_COMPARTILHADO,
  ALERTA_EVENTO_DESCARTADO as ALERTA_EVENTO_DESCARTADO_COMPARTILHADO,
  CONTRATOS_EVENTOS,
  eventoCritico,
  type ContratoEvento,
} from '@genesis/shared';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { alertas, entidadesEvento, eventosRecebidos } from '../database/empresa/schema/index.js';
import type { ClienteEmpresa, DbEmpresa } from '../tenancy/tenancy.js';
import {
  envelopeRecuperadoSchema,
  eventoSchema,
  type EnvelopeEvento,
  type EnvelopeRecuperado,
} from './contratos.js';
import { ErroRegraEvento, ErroTransitorioEvento } from './erros.js';
import { HANDLERS, type CatalogoHandlers } from './eventos.js';
import { eventoPendente, type DependenciaEvento } from './handlers/comum.js';

/**
 * O terminal dono do evento, só com o que a aplicação usa. No push vem do token (`TerminalAutenticado` é um
 * superconjunto); no reprocessamento pelo ERP, inclusive de terminal já revogado (D20), vem da linha de `terminais`
 * (`carregarTerminalDoEvento`): nenhum token, cabeçalho ou hash entra na aplicação.
 */
export interface TerminalDoEvento {
  terminalId: string;
  lojaId: string;
  caixaId: string;
  numeroCaixa: number;
  /** IP de onde o evento veio (o da requisição no push, `terminais.ultimo_ip` no reprocessamento). */
  ip: string | null;
}

export function terminalDoEvento(t: TerminalDoEvento): TerminalDoEvento {
  return {
    terminalId: t.terminalId,
    lojaId: t.lojaId,
    caixaId: t.caixaId,
    numeroCaixa: t.numeroCaixa,
    ip: t.ip,
  };
}

/** Monta o `TerminalDoEvento` a partir de `terminais` (qualquer status) e do número do caixa; `null` se não existe. */
export async function carregarTerminalDoEvento(
  c: ClienteEmpresa,
  terminalId: string,
): Promise<TerminalDoEvento | null> {
  const { rows } = await c.query<{
    terminal_id: string;
    loja_id: string;
    caixa_id: string;
    numero_caixa: number;
    ip: string | null;
  }>(
    `select t.id as terminal_id, t.loja_id, t.caixa_id, cx.numero as numero_caixa, host(t.ultimo_ip) as ip
       from terminais t join caixas cx on cx.id = t.caixa_id
      where t.id = $1`,
    [terminalId],
  );
  const l = rows[0];
  if (!l) return null;
  return {
    terminalId: l.terminal_id,
    lojaId: l.loja_id,
    caixaId: l.caixa_id,
    numeroCaixa: Number(l.numero_caixa),
    ip: l.ip,
  };
}

/** Trava `push:<terminal>` ocupada no 1º evento do lote: 409 `PUSH_EM_ANDAMENTO`, nada processado (SYNC 8.1). */
export class PushEmAndamento extends Error {}

/**
 * Trava do terminal: a primeira de toda transação de evento (SYNC 8.1, ordem das travas). Só as transações de evento
 * a pegam (push, gravação do `erro`, reprocessamento e descarte pelo ERP, lacunas, importação 22.3).
 */
export async function travarTerminal(c: ClienteEmpresa, terminalId: string, tentar = false): Promise<void> {
  if (tentar) {
    const { rows } = await c.query<{ ok: boolean }>(
      'select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as ok',
      [`push:${terminalId}`],
    );
    if (!rows[0]?.ok) throw new PushEmAndamento();
  } else {
    await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`push:${terminalId}`]);
  }
}

/** Loja e caixa do envelope têm de ser os do terminal dono (SYNC 8.3 `validarEscopo`; 11.2 `ESCOPO_INVALIDO`). */
export function conferirEscopo(ev: EnvelopeEvento, terminal: TerminalDoEvento): void {
  if (
    ev.contexto.loja_id !== terminal.lojaId ||
    ev.contexto.caixa_id !== terminal.caixaId ||
    (ev.terminal_id !== undefined && ev.terminal_id !== terminal.terminalId)
  ) {
    throw new ErroRegraEvento('ESCOPO_INVALIDO', 'Loja ou caixa do evento diferente do terminal.');
  }
}

/** O envelope que vai para `eventos_recebidos.envelope`: tudo menos o `payload`, que tem coluna própria (T1). */
export function envelopeSemPayload(ev: EnvelopeEvento): Record<string, unknown> {
  const { payload: _payload, ...resto } = ev;
  return resto;
}

type LinhaRecebida = typeof eventosRecebidos.$inferSelect;

/**
 * O envelope gravado de uma linha, sem validar: as colunas, por cima o `envelope` (T1) e o `payload` da coluna. As
 * linhas anteriores à migração 0010 (e os placeholders `terminal.lacuna`, 8.6) têm `envelope = {}`: valem as colunas,
 * com o contexto do terminal dono e sem `usuario_id`. O `dependencias` da coluna (os bloqueadores do `retido`) só vale
 * quando o envelope gravado não traz o seu.
 */
function envelopeGravado(
  l: LinhaRecebida,
  terminal: Pick<TerminalDoEvento, 'caixaId' | 'numeroCaixa'>,
): Record<string, unknown> {
  const gravado = (l.envelope ?? {}) as Record<string, unknown>;
  const dependenciasColuna = Array.isArray(l.dependencias)
    ? (l.dependencias as Array<Record<string, unknown>>).filter((d) => 'agregado_id' in d)
    : [];
  return {
    evento_id: l.eventoId,
    terminal_id: l.terminalId,
    sequencia: l.sequenciaTerminal,
    tipo: l.tipo,
    versao_schema: l.versaoSchema,
    agregado_tipo: l.agregadoTipo,
    agregado_id: l.agregadoId,
    dependencias: dependenciasColuna,
    ocorrido_em: l.ocorridoEm.toISOString(),
    ...(l.ocorridoEmLocal ? { ocorrido_em_local: l.ocorridoEmLocal.toISOString() } : {}),
    usuario_id: null,
    contexto: { loja_id: l.lojaId, caixa_id: terminal.caixaId, numero_caixa: terminal.numeroCaixa },
    ...gravado,
    payload: l.payload ?? null,
    payload_sha256: l.payloadSha256,
  };
}

/**
 * Remonta o envelope de uma linha gravada para reaplicar (reprocessar, lacuna recuperada). Sem `payload` (anulado
 * após 13 meses) não há o que aplicar.
 */
export function envelopeDaLinha(l: LinhaRecebida, terminal: TerminalDoEvento): EnvelopeEvento {
  if (l.payload === null || l.payload === undefined) {
    throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Evento sem payload gravado.');
  }
  return eventoSchema.parse(envelopeGravado(l, terminal));
}

/**
 * O envelope original para o `GET /sync/recuperar` (SYNC 22.2): o mesmo de `envelopeDaLinha`, só com as chaves do
 * contrato (`envelopeRecuperadoSchema` é estrito) e com o `payload` nulo quando já anulado.
 */
export function envelopeRecuperado(
  l: LinhaRecebida,
  terminal: Pick<TerminalDoEvento, 'caixaId' | 'numeroCaixa'>,
): EnvelopeRecuperado {
  const base = envelopeGravado(l, terminal);
  const envelope: Record<string, unknown> = {};
  for (const chave of Object.keys(envelopeRecuperadoSchema.shape)) {
    if (base[chave] !== undefined) envelope[chave] = base[chave];
  }
  return envelopeRecuperadoSchema.parse(envelope);
}

export type DesfechoAplicacao =
  | {
      status: 'aplicado';
      versaoNuvem: number;
      versaoNuvemFim: number;
      resultado: Record<string, unknown>;
      /** `performance.now()` logo depois de pegar a 7300001: o chamador mede até o `commit` (`MedidorTravaVersao`). */
      travaVersaoEm: number;
    }
  | { status: 'retido'; codigo: 'DEPENDENCIA_PENDENTE'; mensagem: string };

export interface OpcoesAplicacao {
  /**
   * `true` no push: o desfecho vai na própria resposta e não volta em `eventos_resolvidos` do heartbeat. No
   * reprocessamento fica `false` (`resolucao_entregue_em` nulo até o ack do PDV, SYNC 21.1).
   */
  entregueNaResposta?: boolean;
  /** Catálogo de handlers (os testes injetam tipos próprios). */
  handlers?: CatalogoHandlers;
  /**
   * "Aplicar com novo número" (SYNC 11.4, 13.1; fila de decisão, C8): o handler do documento de venda grava a venda
   * com o próximo número da faixa de renumeração do caixa no lugar do número do PDV (`ContextoHandler.novoNumero`).
   */
  novoNumero?: boolean;
}

/**
 * Aplica um evento cuja linha em `eventos_recebidos` já existe (status `recebido`, `erro` ou `retido`): retém se uma
 * dependência deste terminal está em `erro`/`retido` (8.5), senão roda o handler entre os marcadores `versao_nuvem` e
 * `versao_nuvem_fim` e marca `aplicado`. Tipo sem handler → `ErroTransitorioEvento('SCHEMA_DESCONHECIDO')`; payload
 * fora do schema ou escopo errado → `ErroRegraEvento`.
 */
export async function aplicarEvento(
  tx: DbEmpresa,
  c: ClienteEmpresa,
  terminal: TerminalDoEvento,
  ev: EnvelopeEvento,
  opcoes: OpcoesAplicacao = {},
): Promise<DesfechoAplicacao> {
  const handlers = opcoes.handlers ?? HANDLERS;
  await travarTerminal(c, terminal.terminalId);
  conferirEscopo(ev, terminal);
  const handler = handlers[ev.tipo]?.[ev.versao_schema];
  const payload = handler?.schema.safeParse(ev.payload);
  // SYNC 8.5: as dependências do envelope mais as que a nuvem recalcula do payload (só com o payload válido; o
  // inválido cai em `PAYLOAD_INVALIDO` logo abaixo se nada o retiver).
  const ctx = { tx, c, evento: ev, terminal, novoNumero: opcoes.novoNumero === true };
  const dependencias = unirDependencias(
    ev.dependencias,
    handler?.dependencias && payload?.success ? await handler.dependencias(ctx, payload.data as never) : [],
  );
  const bloqueadores = await bloqueadoresDoEvento(tx, terminal.terminalId, ev.evento_id, dependencias);
  if (bloqueadores.length) {
    const mensagem = 'Aguardando dependência com erro';
    await marcarEvento(
      tx,
      ev,
      terminal,
      {
        status: 'retido',
        codigo: 'DEPENDENCIA_PENDENTE',
        mensagem,
        resultado: null,
        dependencias: [...dependencias, ...bloqueadores.map((id) => ({ evento_id_bloqueador: id }))],
      },
      handlers,
    );
    return { status: 'retido', codigo: 'DEPENDENCIA_PENDENTE', mensagem };
  }
  if (!handler || !payload) {
    throw new ErroTransitorioEvento(
      'SCHEMA_DESCONHECIDO',
      `Tipo ${ev.tipo} v${ev.versao_schema} ainda não suportado`,
    );
  }
  if (!payload.success) {
    throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Payload fora do schema do tipo.', {
      campos: payload.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`),
    });
  }
  conferirAgregado(ev, payload.data);
  // Cadastros lidos fora da 7300001 (C6a): só o que grava fica sob a trava que serializa a empresa inteira.
  const preparado = handler.preparar ? await handler.preparar(ctx, payload.data as never) : undefined;
  // Trava de ordenação logo depois da do terminal e antes de qualquer `for update` (SYNC 8.3).
  await c.query('select fn_trava_versao()');
  const travaVersaoEm = performance.now();
  const inicio = await proximaVersao(c);
  const resultado = await handler.aplicar(ctx, payload.data as never, preparado as never);
  await registrarEntidades(tx, ev, terminal, handler.entidades?.(payload.data) ?? []);
  const fim = await proximaVersao(c);
  await tx
    .update(eventosRecebidos)
    .set({
      status: 'aplicado',
      aplicadoEm: new Date(),
      versaoNuvem: inicio,
      versaoNuvemFim: fim,
      resultado,
      erroCodigo: null,
      erro: null,
      resolucaoEntregueEm: opcoes.entregueNaResposta ? new Date() : null,
    })
    .where(eq(eventosRecebidos.eventoId, ev.evento_id));
  return { status: 'aplicado', versaoNuvem: inicio, versaoNuvemFim: fim, resultado, travaVersaoEm };
}

export interface Marcacao {
  status: 'erro' | 'retido';
  codigo: string;
  mensagem: string;
  resultado: Record<string, unknown> | null;
  dependencias?: unknown[];
}

/**
 * Grava `erro`/`retido` e as entidades do payload (lidas sem aplicar), para resolver dependências (SYNC 8.5). O
 * `erro` abre o `EVENTO_COM_ERRO` do evento (SYNC 11.3); o `retido` não abre nada (quem decide é o bloqueador).
 */
export async function marcarEvento(
  tx: DbEmpresa,
  ev: EnvelopeEvento,
  terminal: TerminalDoEvento,
  m: Marcacao,
  handlers: CatalogoHandlers = HANDLERS,
): Promise<void> {
  const [linha] = await tx
    .update(eventosRecebidos)
    .set({
      status: m.status,
      erroCodigo: m.codigo,
      erro: m.mensagem,
      resultado: m.resultado,
      ...(m.dependencias ? { dependencias: m.dependencias } : {}),
    })
    .where(eq(eventosRecebidos.eventoId, ev.evento_id))
    .returning({ id: eventosRecebidos.id });
  if (m.status === 'erro' && linha) {
    await alertarEventoComErro(tx, {
      id: linha.id,
      eventoId: ev.evento_id,
      sequencia: ev.sequencia,
      tipo: ev.tipo,
      erroCodigo: m.codigo,
      erro: m.mensagem,
      terminal,
    });
  }
  const handler = handlers[ev.tipo]?.[ev.versao_schema];
  const lido = handler?.schema.safeParse(ev.payload);
  if (handler?.entidades && lido?.success) {
    await registrarEntidades(tx, ev, terminal, handler.entidades(lido.data));
  }
}

/** SYNC 11.3: o alerta de cada evento em `erro`, aberto até Reprocessar ou Descartar (fila de decisão, ERP 12.5). */
export const ALERTA_EVENTO_COM_ERRO = ALERTA_EVENTO_COM_ERRO_COMPARTILHADO;
/** SYNC 11.4 (ERP 12.5: "venda nunca é descartada sem gerar alerta"): crítico, um por evento descartado. */
export const ALERTA_EVENTO_DESCARTADO = ALERTA_EVENTO_DESCARTADO_COMPARTILHADO;

/** `chave_deduplicacao` do `EVENTO_COM_ERRO` (SYNC 11.3): `evento_erro:<evento_id>`. */
export const chaveEventoComErro = (eventoId: string) => `evento_erro:${eventoId}`;

/**
 * `EVENTO_COM_ERRO` (SYNC 11.3): `critico` para `venda.*`, `caixa.*` e `nfce.*`, `aviso` para os demais, um aberto
 * por evento. O evento que volta a `erro` depois de reprocessado (o alerta anterior já resolvido) abre outro, com a
 * mensagem nova; enquanto aberto, o mesmo erro não repete.
 */
export async function alertarEventoComErro(
  tx: DbEmpresa,
  e: {
    id: string;
    eventoId: string;
    sequencia: number;
    tipo: string;
    erroCodigo: string;
    erro: string;
    terminal: Pick<TerminalDoEvento, 'terminalId' | 'lojaId' | 'numeroCaixa'>;
  },
): Promise<void> {
  const caixa = String(e.terminal.numeroCaixa).padStart(2, '0');
  await tx
    .insert(alertas)
    .values({
      tipo: ALERTA_EVENTO_COM_ERRO,
      severidade: eventoCritico(e.tipo) ? 'critico' : 'aviso',
      titulo: `Caixa ${caixa}: evento ${e.tipo} com erro (${e.erroCodigo})`.slice(0, 150),
      mensagem:
        `O evento nº ${e.sequencia} do caixa ${caixa} não foi aplicado: ${e.erro}`.slice(0, 1000) +
        ' Resolva na aba "Eventos com erro" do terminal (reprocessar ou descartar).',
      lojaId: e.terminal.lojaId,
      entidade: 'eventos_recebidos',
      registroId: e.id,
      dados: {
        evento_id: e.eventoId,
        terminal_id: e.terminal.terminalId,
        sequencia: e.sequencia,
        tipo: e.tipo,
        erro_codigo: e.erroCodigo,
      },
      chaveDeduplicacao: chaveEventoComErro(e.eventoId),
    })
    .onConflictDoNothing();
}

/** Fecha o `EVENTO_COM_ERRO` aberto do evento (reprocessado com sucesso, retido ou descartado). */
export async function resolverAlertaEventoComErro(
  tx: DbEmpresa,
  eventoId: string,
  resolucao: string,
  usuarioId: string | null,
): Promise<void> {
  await tx
    .update(alertas)
    .set({ resolvidoEm: new Date(), resolvidoPorId: usuarioId, resolucao: resolucao.slice(0, 255) })
    .where(
      and(
        eq(alertas.chaveDeduplicacao, chaveEventoComErro(eventoId)),
        isNull(alertas.resolvidoEm),
        isNull(alertas.excluidoEm),
      ),
    );
}

async function registrarEntidades(
  tx: DbEmpresa,
  ev: EnvelopeEvento,
  terminal: TerminalDoEvento,
  entidades: Array<{ tipo: string; id: string }>,
): Promise<void> {
  if (!entidades.length) return;
  await tx
    .insert(entidadesEvento)
    .values(
      entidades.map((e) => ({
        entidadeTipo: e.tipo,
        entidadeId: e.id,
        eventoId: ev.evento_id,
        terminalId: terminal.terminalId,
      })),
    )
    .onConflictDoNothing();
}

/** União sem repetição (mesmo tipo e id), na ordem: as do envelope primeiro. */
function unirDependencias(
  envelope: readonly DependenciaEvento[],
  recalculadas: readonly DependenciaEvento[],
): DependenciaEvento[] {
  const vistas = new Set<string>();
  return [...envelope, ...recalculadas].filter((d) => {
    const chave = `${d.agregado_tipo}:${d.agregado_id}`;
    if (vistas.has(chave)) return false;
    vistas.add(chave);
    return true;
  });
}

/**
 * Tipo com contrato fixado (`CONTRATOS_EVENTOS`, C4): `agregado_tipo`/`agregado_id` do envelope são os do payload.
 * As dependências (8.5) e a fila de decisão procuram o evento pelo agregado: um envelope com o agregado errado
 * deixaria a sessão "sem evento pendente" e a abertura seguinte viraria `SESSAO_DUPLICADA` em vez de `retido`.
 */
function conferirAgregado(ev: EnvelopeEvento, payload: unknown): void {
  const contrato = (CONTRATOS_EVENTOS as Record<string, ContratoEvento>)[ev.tipo];
  if (!contrato) return;
  const esperado = contrato.agregadoId(payload as never);
  if (ev.agregado_tipo !== contrato.agregadoTipo || ev.agregado_id !== esperado) {
    throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Agregado do envelope diferente do payload.', {
      agregado_tipo: contrato.agregadoTipo,
    });
  }
}

/**
 * Dependências deste terminal em `erro`/`retido`, por agregado ou pela entidade que outro evento criou. O próprio
 * evento não conta: no reprocessamento ele está em `erro`/`retido` e pode ter o próprio agregado como dependência
 * (o `caixa.fechado` depende da sessão, que é o agregado dele). O `erro` `AGREGADO_DIVERGENTE` também não
 * (`eventoPendente`): é uma duplicata, e o agregado dela já está aplicado.
 */
async function bloqueadoresDoEvento(
  tx: DbEmpresa,
  terminalId: string,
  eventoId: string,
  dependencias: readonly DependenciaEvento[],
): Promise<string[]> {
  if (!dependencias.length) return [];
  const ids = dependencias.map((d) => d.agregado_id);
  const porAgregado = await tx
    .select({
      id: eventosRecebidos.eventoId,
      tipo: eventosRecebidos.agregadoTipo,
      agregado: eventosRecebidos.agregadoId,
    })
    .from(eventosRecebidos)
    .where(
      and(
        eq(eventosRecebidos.terminalId, terminalId),
        ne(eventosRecebidos.eventoId, eventoId),
        eventoPendente(),
        inArray(eventosRecebidos.agregadoId, ids),
      ),
    );
  const porEntidade = await tx
    .select({ id: eventosRecebidos.eventoId })
    .from(entidadesEvento)
    .innerJoin(eventosRecebidos, eq(eventosRecebidos.eventoId, entidadesEvento.eventoId))
    .where(
      and(
        eq(eventosRecebidos.terminalId, terminalId),
        ne(eventosRecebidos.eventoId, eventoId),
        eventoPendente(),
        inArray(entidadesEvento.entidadeId, ids),
      ),
    );
  const deps = new Set(dependencias.map((d) => `${d.agregado_tipo}:${d.agregado_id}`));
  return [
    ...new Set([
      ...porAgregado.filter((l) => deps.has(`${l.tipo}:${l.agregado}`)).map((l) => l.id),
      ...porEntidade.map((l) => l.id),
    ]),
  ];
}

async function proximaVersao(c: ClienteEmpresa): Promise<number> {
  const { rows } = await c.query<{ v: string }>("select nextval('seq_versao')::text as v");
  return Number(rows[0]!.v);
}

/**
 * Quanto tempo cada transação de evento segura a trava 7300001, de `fn_trava_versao()` ao `commit` (crítica da 1C,
 * item 6): a trava serializa toda gravação sincronizável da empresa (todos os caixas e o ERP), e a meta da SYNC 8.3 é
 * < 50 ms por venda de 10 itens. Janela das últimas `capacidade` amostras, por processo; o teste de carga (C13) lê o
 * p95 daqui.
 */
export class MedidorTravaVersao {
  private readonly amostras: number[] = [];
  private proxima = 0;
  private total = 0;

  constructor(private readonly capacidade = 2000) {}

  registrar(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.amostras.length < this.capacidade) this.amostras.push(ms);
    else this.amostras[this.proxima] = ms;
    this.proxima = (this.proxima + 1) % this.capacidade;
    this.total++;
  }

  /** Percentil (0–100) da janela, pelo método do posto mais próximo; `null` sem amostras. */
  percentil(p: number): number | null {
    if (!this.amostras.length) return null;
    const ordenadas = [...this.amostras].sort((a, b) => a - b);
    const posto = Math.min(ordenadas.length, Math.max(1, Math.ceil((p / 100) * ordenadas.length)));
    return ordenadas[posto - 1]!;
  }

  resumo(): {
    amostras: number;
    total: number;
    p50: number | null;
    p95: number | null;
    maximo: number | null;
  } {
    return {
      amostras: this.amostras.length,
      total: this.total,
      p50: this.percentil(50),
      p95: this.percentil(95),
      maximo: this.amostras.length ? Math.max(...this.amostras) : null,
    };
  }

  limpar(): void {
    this.amostras.length = 0;
    this.proxima = 0;
    this.total = 0;
  }
}
