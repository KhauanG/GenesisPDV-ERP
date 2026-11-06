/**
 * `POST /sync/push` (SYNC 7.4, 8): uma transação por evento, sempre começando pela trava consultiva do terminal
 * (`push:<terminal_id>`), `esperado` lido dentro dela (ordem estrita por terminal), idempotência por `evento_id` +
 * `payload_sha256` em `eventos_recebidos` (com o envelope, T1), e a aplicação comum (`aplicarEvento`, `aplicacao.ts`:
 * dependências retidas, trava de ordenação 7300001 e marcadores `versao_nuvem` / `versao_nuvem_fim`). Erro do banco
 * vira código da SYNC 11.2 (`traduzirErroBanco`) antes de decidir entre `erro`, `erro_temporario` e `ERRO_INTERNO`.
 *
 * Lacunas (SYNC 8.6; C15, `lacunas.ts`): `declarar_lacuna` grava os placeholders antes dos eventos do lote, numa
 * transação de evento própria; o evento novo cuja sequência (abaixo da esperada) cai num placeholder substitui-o com
 * `recuperar_lacuna` no lote, ou recebe `lacuna_recuperavel` e para o lote — não é regressão. Quem liberou uma e outra
 * é conferido antes de qualquer gravação (`pdv.config.fiscal`).
 *
 * Relógio (SYNC 12.4; C16, `relogio.ts`): na transação que dá linha ao evento (a nova, a da falha gravada à parte ou a
 * do placeholder substituído) a hora dele é conferida com a de chegada do lote, a ativação do terminal e o evento
 * anterior, e o `RELOGIO_SUSPEITO` é gravado; o evento é aplicado do mesmo jeito.
 */
import { ALERTA_EVENTO_DIVERGENTE, jcs, type RecuperarLacuna } from '@genesis/shared';
import { Logger } from '@nestjs/common';
import { DrizzleQueryError, eq, sql } from 'drizzle-orm';
import { PermissoesEfetivas } from '../autorizacao/permissoes-efetivas.js';
import { alertas, eventosRecebidos } from '../database/empresa/schema/index.js';
import { sha256Hex } from '../seguranca/tokens.js';
import type { ClienteEmpresa, DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import {
  aplicarEvento,
  envelopeSemPayload,
  marcarEvento,
  MedidorTravaVersao,
  PushEmAndamento,
  terminalDoEvento,
  travarTerminal,
  type TerminalDoEvento,
} from './aplicacao.js';
import {
  eventoSchema,
  MAXIMO_EVENTOS_LOTE,
  pushSchema,
  validarSync,
  type EnvelopeEvento,
  type RespostaPush,
  type ResultadoEvento,
} from './contratos.js';
import { ErroRegraEvento, ErroSync, ErroTransitorioEvento, traduzirErroBanco } from './erros.js';
import { HANDLERS, type CatalogoHandlers } from './eventos.js';
import {
  conferirLiberacaoLacuna,
  declararLacuna,
  esperadoDoTerminal,
  faixaDoPlaceholder,
  fecharLacunasRecuperadas,
  numeroVendaRecuperada,
  placeholderNaSequencia,
  recuperacaoCobre,
  substituirPlaceholder,
  type FaixaLacuna,
  type Substituicao,
} from './lacunas.js';
import { alertarRelogioDoEvento } from './relogio.js';
import type { TerminalAutenticado } from './terminal.js';

const log = new Logger('PushSync');

/** Exceção não classificada repetida até aqui vira `erro` `ERRO_INTERNO` (evento venenoso, SYNC 8.3). */
const TENTATIVAS_ATE_ERRO = 3;

type Desfecho = ResultadoEvento & {
  parar?: boolean;
  regressao?: { esperado: number };
  /** O evento substituiu um placeholder de lacuna (SYNC 8.6) e a transação que o gravou terminou. */
  substituiu?: FaixaLacuna;
};

/** A recuperação de lacuna do lote (SYNC 8.6), com quem liberou já conferido. */
interface RecuperacaoLote {
  faixa: RecuperarLacuna;
  autorizadoPorNome: string;
}

/**
 * Reprocessamento em ordem, depois de uma lacuna recuperada, dos eventos do terminal em `erro`/`retido` posteriores a
 * ela (SYNC 8.6): a tarefa da fila de decisão (`FilaDecisao.criarReprocessamentoAposLacuna`). `criar` roda na
 * transação do fecho da lacuna e devolve o id da tarefa (`null` = nada a reprocessar); `agendar`, depois do commit.
 */
export interface ReprocessamentoAposLacuna {
  criar(
    tx: DbEmpresa,
    dados: { terminalId: string; lojaId: string; desde: number; loteId: string; autorizadoPorId: string },
  ): Promise<string | null>;
  agendar(empresaId: string, tarefaId: string): Promise<void>;
}

type LinhaRecebida = typeof eventosRecebidos.$inferSelect;

function respostaDaLinha(l: LinhaRecebida, ev: EnvelopeEvento): Desfecho {
  const base = { evento_id: ev.evento_id, sequencia: ev.sequencia };
  const erro = { codigo: l.erroCodigo ?? 'ERRO', mensagem: l.erro ?? '' };
  switch (l.status) {
    case 'aplicado':
      return {
        ...base,
        status: 'duplicado',
        versao_nuvem: l.versaoNuvem,
        versao_nuvem_fim: l.versaoNuvemFim,
        resultado: (l.resultado as Record<string, unknown> | null) ?? {},
      };
    case 'erro':
      return { ...base, status: 'rejeitado', erro };
    case 'retido':
      return { ...base, status: 'retido', erro };
    default:
      return {
        ...base,
        status: 'descartado',
        resultado: { descartado: true, justificativa: l.justificativaDescarte },
      };
  }
}

/** Trava `push:<terminal>` ocupada no 1º passo do lote → 409 `PUSH_EM_ANDAMENTO` (SYNC 8.1), nada processado. */
async function emAndamento<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PushEmAndamento) {
      throw new ErroSync(
        'PUSH_EM_ANDAMENTO',
        'Outro envio deste terminal está em andamento.',
        {},
        { 'Retry-After': '2' },
      );
    }
    throw e;
  }
}

export interface OpcoesPush {
  /** Tempo com a trava 7300001 presa por evento aplicado (crítica da 1C, item 6). */
  medidorTrava?: MedidorTravaVersao;
  /** Catálogo de handlers (os testes injetam tipos próprios). */
  handlers?: CatalogoHandlers;
  /** Permissões de quem libera a lacuna (o cache comum da API; sem ele, um próprio). */
  permissoes?: PermissoesEfetivas;
  /** Reprocessamento depois da lacuna recuperada (sem ele, os eventos em erro ficam para a fila do ERP). */
  reprocessamentoAposLacuna?: ReprocessamentoAposLacuna;
}

export class PushSync {
  readonly medidorTrava: MedidorTravaVersao;
  private readonly handlers: CatalogoHandlers;
  private readonly permissoes: PermissoesEfetivas;
  private readonly reprocessamento: ReprocessamentoAposLacuna | undefined;

  constructor(
    private readonly tenancy: Tenancy,
    opcoes: OpcoesPush = {},
  ) {
    this.medidorTrava = opcoes.medidorTrava ?? new MedidorTravaVersao();
    this.handlers = opcoes.handlers ?? HANDLERS;
    this.permissoes = opcoes.permissoes ?? new PermissoesEfetivas();
    this.reprocessamento = opcoes.reprocessamentoAposLacuna;
  }

  async receber(terminal: TerminalAutenticado, corpo: unknown): Promise<RespostaPush> {
    const lote = validarSync(pushSchema, corpo);
    if (lote.terminal_id !== terminal.terminalId) throw ErroSync.escopo('Lote de outro terminal.');
    if (lote.eventos.length > MAXIMO_EVENTOS_LOTE) {
      throw new ErroSync('LOTE_GRANDE_DEMAIS', `Até ${MAXIMO_EVENTOS_LOTE} eventos por lote.`);
    }
    const eventos = lote.eventos.map((e, i) => {
      const r = eventoSchema.safeParse(e);
      if (!r.success) {
        throw ErroSync.invalida(`Evento ${i} inválido.`, {
          indice: i,
          campos: r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`),
        });
      }
      if (r.data.terminal_id && r.data.terminal_id !== terminal.terminalId) {
        throw ErroSync.escopo('Evento de outro terminal.');
      }
      return r.data;
    });
    const recebidoEm = new Date();
    const doEvento = terminalDoEvento(terminal);
    // SYNC 8.6: quem liberou a lacuna é conferido antes de qualquer gravação (o lote inteiro é recusado senão).
    const liberacao = lote.declarar_lacuna ?? lote.recuperar_lacuna;
    const autorizadoPorNome = liberacao
      ? (
          await this.tenancy
            .cx()
            .consulta((db) =>
              conferirLiberacaoLacuna(
                db,
                this.permissoes,
                this.tenancy.atual().empresaId,
                liberacao.autorizado_por_id,
                doEvento.lojaId,
              ),
            )
        ).nome
      : null;
    if (lote.declarar_lacuna) {
      const declaracao = lote.declarar_lacuna;
      await emAndamento(() =>
        this.tenancy.cx().transacao(async (tx, c) => {
          await travarTerminal(c, terminal.terminalId, true);
          await declararLacuna(tx, c, doEvento, declaracao, {
            loteId: lote.lote_id,
            autorizadoPorNome: autorizadoPorNome!,
            eventosPendentesTotal: lote.eventos_pendentes_total,
          });
        }),
      );
    }
    const recuperacao: RecuperacaoLote | null = lote.recuperar_lacuna
      ? { faixa: lote.recuperar_lacuna, autorizadoPorNome: autorizadoPorNome! }
      : null;
    const substituicoes: Substituicao[] = [];
    const resultados: ResultadoEvento[] = [];
    for (let i = 0; i < eventos.length; i++) {
      const ev = eventos[i]!;
      // Fora de transação (SYNC 8.1): recálculo do JCS do payload.
      const hashRecalculado = sha256Hex(jcs(ev.payload));
      const d = await emAndamento(() =>
        this.processar(
          doEvento,
          ev,
          i === 0 && !lote.declarar_lacuna,
          hashRecalculado,
          lote.lote_id,
          recuperacao,
          recebidoEm,
        ),
      );
      if (d.substituiu) {
        substituicoes.push({
          sequencia: ev.sequencia,
          status: d.status,
          faixa: d.substituiu,
          numeroVenda: numeroVendaRecuperada(ev),
        });
      }
      if (d.regressao) {
        if (substituicoes.length && recuperacao) {
          await this.fecharLacunas(doEvento, lote.lote_id, substituicoes, recuperacao);
        }
        throw new ErroSync(
          'REGRESSAO_DETECTADA',
          'Sequência já usada por outro evento: banco local restaurado ou copiado.',
          {
            sequencia: ev.sequencia,
            proxima_sequencia_esperada: d.regressao.esperado,
            resultados,
          },
        );
      }
      const { parar, substituiu: _substituiu, ...resultado } = d;
      resultados.push(resultado);
      if (parar) {
        for (const resto of eventos.slice(i + 1))
          resultados.push({
            evento_id: resto.evento_id,
            sequencia: resto.sequencia,
            status: 'nao_processado',
          });
        break;
      }
    }
    if (substituicoes.length && recuperacao) {
      await this.fecharLacunas(doEvento, lote.lote_id, substituicoes, recuperacao);
    }
    const proxima = await this.tenancy.cx().consulta(async (_db, c) => {
      await c.query('update terminais set ultimo_push_em = now() where id = $1', [terminal.terminalId]);
      return esperadoDoTerminal(c, terminal.terminalId);
    });
    return {
      lote_id: lote.lote_id,
      recebido_em: recebidoEm.toISOString(),
      agora_servidor: new Date().toISOString(),
      proxima_sequencia_esperada: proxima,
      resultados,
      comandos: [],
    };
  }

  /**
   * Fecho da lacuna recuperada (SYNC 8.6): alertas numa transação de evento e, depois do commit, a tarefa que
   * reprocessa em ordem os eventos em `erro`/`retido` posteriores. Os eventos já foram gravados: uma falha aqui fica no
   * log e não muda a resposta do lote (a fila do ERP continua resolvendo o que sobrar).
   */
  private async fecharLacunas(
    terminal: TerminalDoEvento,
    loteId: string,
    substituicoes: readonly Substituicao[],
    recuperacao: RecuperacaoLote,
  ): Promise<void> {
    try {
      const tarefaId = await this.tenancy.cx().transacao(async (tx, c) => {
        await travarTerminal(c, terminal.terminalId);
        const { desde } = await fecharLacunasRecuperadas(tx, terminal, substituicoes, {
          loteId,
          autorizadoPorId: recuperacao.faixa.autorizado_por_id,
          autorizadoPorNome: recuperacao.autorizadoPorNome,
        });
        return (
          (await this.reprocessamento?.criar(tx, {
            terminalId: terminal.terminalId,
            lojaId: terminal.lojaId,
            desde,
            loteId,
            autorizadoPorId: recuperacao.faixa.autorizado_por_id,
          })) ?? null
        );
      });
      if (tarefaId) await this.reprocessamento!.agendar(this.tenancy.atual().empresaId, tarefaId);
    } catch (e) {
      log.error(`Fecho da lacuna recuperada do terminal ${terminal.terminalId}: ${(e as Error).message}`);
    }
  }

  private async processar(
    terminal: TerminalDoEvento,
    ev: EnvelopeEvento,
    primeiro: boolean,
    hashRecalculado: string,
    loteId: string,
    recuperacao: RecuperacaoLote | null,
    recebidoEm: Date,
  ): Promise<Desfecho> {
    const base = { evento_id: ev.evento_id, sequencia: ev.sequencia };
    let travaVersaoEm: number | undefined;
    let substituiu: FaixaLacuna | undefined;
    try {
      const desfecho = await this.tenancy.cx().transacao(async (tx, c): Promise<Desfecho> => {
        travaVersaoEm = undefined;
        substituiu = undefined;
        await travarTerminal(c, terminal.terminalId, primeiro);
        const pre = await this.conferirSequencia(tx, c, terminal, ev, recuperacao);
        if ('desfecho' in pre) return pre.desfecho;
        if (pre.placeholder) {
          substituiu = await substituirPlaceholder(tx, terminal, pre.placeholder, ev, {
            loteId,
            autorizadoPorId: recuperacao!.faixa.autorizado_por_id,
            tentativas: 1,
            recebidoEm,
          });
          await alertarRelogioDoEvento(tx, terminal, ev, recebidoEm);
        } else if (pre.existente) {
          await tx
            .update(eventosRecebidos)
            // O envelope também: a linha `recebido` pode ser anterior à migração 0010 (`{}`).
            .set({
              tentativas: sql`${eventosRecebidos.tentativas} + 1`,
              loteId,
              envelope: envelopeSemPayload(ev),
            })
            .where(eq(eventosRecebidos.eventoId, ev.evento_id));
        } else {
          await tx.insert(eventosRecebidos).values(this.linhaNova(terminal, ev, loteId, 'recebido'));
          await alertarRelogioDoEvento(tx, terminal, ev, recebidoEm);
        }
        if (hashRecalculado !== ev.payload_sha256) {
          await marcarEvento(
            tx,
            ev,
            terminal,
            {
              status: 'erro',
              codigo: 'PAYLOAD_INVALIDO',
              mensagem: 'payload_sha256 não confere com o JCS do payload',
              resultado: {
                detalhes: { hash_recebido: ev.payload_sha256, hash_recalculado: hashRecalculado },
              },
            },
            this.handlers,
          );
          return {
            ...base,
            status: 'rejeitado',
            erro: { codigo: 'PAYLOAD_INVALIDO', mensagem: 'payload_sha256 divergente' },
          };
        }
        const a = await aplicarEvento(tx, c, terminal, ev, {
          entregueNaResposta: true,
          handlers: this.handlers,
        });
        if (a.status === 'retido') {
          return { ...base, status: 'retido', erro: { codigo: a.codigo, mensagem: a.mensagem } };
        }
        travaVersaoEm = a.travaVersaoEm;
        return {
          ...base,
          status: 'aplicado',
          versao_nuvem: a.versaoNuvem,
          versao_nuvem_fim: a.versaoNuvemFim,
          resultado: a.resultado,
        };
      });
      // Depois do `commit`: é quando a 7300001 solta.
      if (travaVersaoEm !== undefined) this.medidorTrava.registrar(performance.now() - travaVersaoEm);
      return substituiu ? { ...desfecho, substituiu } : desfecho;
    } catch (e) {
      if (e instanceof PushEmAndamento) throw e;
      const erro = traduzirErroBanco(e) ?? (e as Error);
      if (erro instanceof ErroTransitorioEvento) {
        return {
          ...base,
          status: 'erro_temporario',
          erro: { codigo: erro.codigo, mensagem: erro.message },
          parar: true,
        };
      }
      if (erro instanceof ErroRegraEvento)
        return this.gravarFalha(terminal, ev, loteId, 'regra', erro, recuperacao, recebidoEm);
      return this.gravarFalha(terminal, ev, loteId, 'interna', erro, recuperacao, recebidoEm);
    }
  }

  /**
   * Idempotência e ordem (SYNC 8.1): responde pela linha existente, ou detecta lacuna/regressão. Sequência abaixo da
   * esperada num placeholder de lacuna (8.6) não é regressão: com a recuperação autorizada no lote, devolve o
   * placeholder para o chamador substituir; sem ela, `lacuna_recuperavel` com a faixa declarada, e o lote para.
   */
  private async conferirSequencia(
    tx: DbEmpresa,
    c: ClienteEmpresa,
    terminal: TerminalDoEvento,
    ev: EnvelopeEvento,
    recuperacao: RecuperacaoLote | null,
  ): Promise<{ desfecho: Desfecho } | { existente: boolean; placeholder?: LinhaRecebida }> {
    const base = { evento_id: ev.evento_id, sequencia: ev.sequencia };
    const [existente] = await tx
      .select()
      .from(eventosRecebidos)
      .where(eq(eventosRecebidos.eventoId, ev.evento_id));
    if (existente) {
      const divergente =
        existente.payloadSha256 !== ev.payload_sha256 ||
        existente.terminalId !== terminal.terminalId ||
        existente.sequenciaTerminal !== ev.sequencia;
      if (divergente) {
        await this.alertaDivergente(tx, terminal, ev, existente);
        return {
          desfecho: {
            ...base,
            status: 'rejeitado',
            erro: { codigo: 'EVENTO_DIVERGENTE', mensagem: 'Mesmo evento_id com conteúdo diferente.' },
          },
        };
      }
      // `recebido` = tentativa anterior falhou de forma transitória: aplica de novo sobre a mesma linha.
      if (existente.status !== 'recebido') return { desfecho: respostaDaLinha(existente, ev) };
      return { existente: true };
    }
    const esperado = await esperadoDoTerminal(c, terminal.terminalId);
    if (ev.sequencia < esperado) {
      const placeholder = await placeholderNaSequencia(tx, terminal.terminalId, ev.sequencia);
      if (placeholder) {
        if (recuperacaoCobre(recuperacao?.faixa, ev.sequencia)) return { existente: false, placeholder };
        const faixa = faixaDoPlaceholder(placeholder) ?? { de: ev.sequencia, ate: ev.sequencia };
        return {
          desfecho: {
            ...base,
            status: 'lacuna_recuperavel',
            resultado: { lacuna: faixa },
            erro: {
              codigo: 'LACUNA_RECUPERAVEL',
              mensagem:
                `A sequência ${ev.sequencia} está numa lacuna declarada (${faixa.de}–${faixa.ate}): reenvie com ` +
                'a liberação do supervisor (recuperar_lacuna).',
            },
            parar: true,
          },
        };
      }
      return { desfecho: { ...base, status: 'rejeitado', regressao: { esperado } } };
    }
    if (ev.sequencia > esperado) return { desfecho: { ...base, status: 'fora_de_ordem', parar: true } };
    return { existente: false };
  }

  /** Erro de regra ou falha não classificada: transação nova (com a trava do terminal) grava a linha (SYNC 8.3). */
  private async gravarFalha(
    terminal: TerminalDoEvento,
    ev: EnvelopeEvento,
    loteId: string,
    tipo: 'regra' | 'interna',
    erro: Error,
    recuperacao: RecuperacaoLote | null,
    recebidoEm: Date,
  ): Promise<Desfecho> {
    const base = { evento_id: ev.evento_id, sequencia: ev.sequencia };
    return this.tenancy.cx().transacao(async (tx, c): Promise<Desfecho> => {
      let substituiu: FaixaLacuna | undefined;
      const com = (x: Desfecho): Desfecho => (substituiu ? { ...x, substituiu } : x);
      await travarTerminal(c, terminal.terminalId);
      const pre = await this.conferirSequencia(tx, c, terminal, ev, recuperacao);
      if ('desfecho' in pre) return pre.desfecho;
      // O `rollback` desfez a troca do placeholder: a linha do `erro` o substitui de novo (com a auditoria).
      if (pre.placeholder) {
        substituiu = await substituirPlaceholder(tx, terminal, pre.placeholder, ev, {
          loteId,
          autorizadoPorId: recuperacao!.faixa.autorizado_por_id,
          tentativas: 0,
          recebidoEm,
        });
        await alertarRelogioDoEvento(tx, terminal, ev, recebidoEm);
      } else if (!pre.existente) {
        await tx
          .insert(eventosRecebidos)
          .values({ ...this.linhaNova(terminal, ev, loteId, 'recebido'), tentativas: 0 });
        await alertarRelogioDoEvento(tx, terminal, ev, recebidoEm);
      }
      const [linha] = await tx
        .update(eventosRecebidos)
        .set({ tentativas: sql`${eventosRecebidos.tentativas} + 1`, loteId })
        .where(eq(eventosRecebidos.eventoId, ev.evento_id))
        .returning({ tentativas: eventosRecebidos.tentativas });
      if (tipo === 'regra') {
        const e = erro as ErroRegraEvento;
        await marcarEvento(
          tx,
          ev,
          terminal,
          { status: 'erro', codigo: e.codigo, mensagem: e.message, resultado: { detalhes: e.detalhes } },
          this.handlers,
        );
        return com({ ...base, status: 'rejeitado', erro: { codigo: e.codigo, mensagem: e.message } });
      }
      if ((linha?.tentativas ?? 0) >= TENTATIVAS_ATE_ERRO) {
        // A mensagem do `DrizzleQueryError` traz o SQL e os parâmetros (CPF, nome…): grava só a do PostgreSQL.
        const mensagem =
          erro instanceof DrizzleQueryError ? (erro.cause?.message ?? 'Falha na consulta.') : erro.message;
        await marcarEvento(
          tx,
          ev,
          terminal,
          { status: 'erro', codigo: 'ERRO_INTERNO', mensagem: mensagem.slice(0, 2000), resultado: null },
          this.handlers,
        );
        return com({
          ...base,
          status: 'rejeitado',
          erro: { codigo: 'ERRO_INTERNO', mensagem: 'Falha ao aplicar o evento.' },
        });
      }
      return com({
        ...base,
        status: 'erro_temporario',
        erro: { codigo: 'ERRO_INTERNO', mensagem: 'Falha transitória ao aplicar o evento.' },
        parar: true,
      });
    });
  }

  private linhaNova(terminal: TerminalDoEvento, ev: EnvelopeEvento, loteId: string, status: 'recebido') {
    return {
      eventoId: ev.evento_id,
      terminalId: terminal.terminalId,
      lojaId: terminal.lojaId,
      sequenciaTerminal: ev.sequencia,
      tipo: ev.tipo,
      versaoSchema: ev.versao_schema,
      agregadoTipo: ev.agregado_tipo,
      agregadoId: ev.agregado_id,
      dependencias: ev.dependencias,
      loteId,
      ocorridoEm: new Date(ev.ocorrido_em),
      ocorridoEmLocal: ev.ocorrido_em_local ? new Date(ev.ocorrido_em_local) : null,
      status,
      tentativas: 1,
      payload: ev.payload,
      envelope: envelopeSemPayload(ev),
      payloadSha256: ev.payload_sha256,
    };
  }

  /**
   * SYNC 8.4 camada 3: mesmo `evento_id` com outro conteúdo → alerta crítico com o payload divergente. O terminal que
   * mandou vai em `dados.terminal_id` (a linha de `registro_id` é a do envio original, que pode ser de outro terminal),
   * para o alerta aparecer no detalhe dele, com o "Ciente", e no painel do Dashboard com o link (C14).
   */
  private async alertaDivergente(
    tx: DbEmpresa,
    terminal: TerminalDoEvento,
    ev: EnvelopeEvento,
    existente: LinhaRecebida,
  ): Promise<void> {
    await tx
      .insert(alertas)
      .values({
        tipo: ALERTA_EVENTO_DIVERGENTE,
        severidade: 'critico',
        titulo: `Evento ${ev.tipo} recebido de novo com conteúdo diferente`,
        mensagem: `Terminal ${terminal.numeroCaixa}: o evento ${ev.evento_id} chegou com outro conteúdo.`,
        lojaId: terminal.lojaId,
        entidade: 'eventos_recebidos',
        registroId: existente.id,
        dados: {
          terminal_id: terminal.terminalId,
          evento_id: ev.evento_id,
          sequencia: ev.sequencia,
          hash_gravado: existente.payloadSha256,
          hash_recebido: ev.payload_sha256,
          payload_recebido: ev.payload,
        },
        chaveDeduplicacao: `evento_divergente:${ev.evento_id}`.slice(0, 150),
      })
      .onConflictDoNothing();
  }
}
