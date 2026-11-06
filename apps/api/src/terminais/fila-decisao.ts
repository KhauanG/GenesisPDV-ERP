/**
 * Fila de decisão do ERP (ERP 12.5; SYNC 8.5, 11.2–11.4; bloco C8 da 1C): as ações sobre os eventos em `erro` ou
 * `retido` de um terminal — Reprocessar, Aplicar com novo número, Descartar e Reprocessar todos com o mesmo código
 * (tarefa em segundo plano). Toda ação é uma **transação de evento** (SYNC 8.1): pega primeiro a trava do terminal
 * (`travarTerminal`, a mesma do push), relê a linha sob ela e só então aplica (`aplicarEvento`, com a 7300001 depois)
 * ou descarta. Assim o reprocessamento se serializa com o push simultâneo do mesmo terminal, e duas pessoas que clicam
 * juntas não aplicam o mesmo evento duas vezes (a segunda vê a linha já resolvida e recebe 409).
 *
 * O terminal vem da linha de `terminais`, em qualquer status (`carregarTerminalDoEvento`): o evento de um terminal já
 * revogado ou substituído se resolve aqui (D20). O resultado volta ao PDV no heartbeat (`resolucao_entregue_em` nulo
 * até o ack, SYNC 21.1). Permissão `terminais.gerenciar` (no controller) e a loja do evento entre as do usuário.
 */
import {
  aceitaNovoNumero,
  eventoCritico,
  type DescartarEvento,
  type DesfechoReprocessamento,
  type ReprocessamentoAgendado,
  type ReprocessarLoteEntrada,
  type ResultadoDescarte,
  type ResultadoReprocessamento,
} from '@genesis/shared';
import {
  and,
  asc,
  DrizzleQueryError,
  eq,
  inArray,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import { garantirLoja } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { alertas, eventosRecebidos, terminais, vendas } from '../database/empresa/schema/index.js';
import {
  alertarEventoComErro,
  ALERTA_EVENTO_DESCARTADO,
  aplicarEvento,
  carregarTerminalDoEvento,
  envelopeDaLinha,
  marcarEvento,
  resolverAlertaEventoComErro,
  travarTerminal,
  type TerminalDoEvento,
} from '../sync/aplicacao.js';
import { ErroRegraEvento, ErroTransitorioEvento, traduzirErroBanco } from '../sync/erros.js';
import type { ExecucaoTarefa, TarefasSegundoPlano } from '../tarefas/tarefas.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import { resolverAlertasSemEventos } from './revogacao.js';

/** Tipo da tarefa de "Reprocessar todos com este código" (ERP 3.6; SYNC 11.4). */
export const TAREFA_REPROCESSAR_EVENTOS = 'reprocessar_eventos';

/**
 * Tipo da tarefa que reprocessa em ordem os eventos em `erro`/`retido` posteriores a uma lacuna recuperada (SYNC 8.6;
 * C15): criada pelo push na transação do fecho da lacuna, em nome do supervisor que liberou a recuperação.
 */
export const TAREFA_REPROCESSAR_APOS_LACUNA = 'reprocessar_apos_lacuna';

const LOCALIZACAO = 'PDVs/Terminais › Eventos com erro';

type LinhaEvento = typeof eventosRecebidos.$inferSelect;
type Payload = Record<string, unknown> | null | undefined;

const PENDENTES = ['erro', 'retido'] as const;
const caixa2 = (n: number) => String(n).padStart(2, '0');

/** "R$ 1.234,56" (o payload manda o decimal em texto, `"71.58"`). */
function reais(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const objeto = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * Terminal de um alerta (texto, ou nulo): o próprio registro quando `entidade = 'terminais'`; senão o de
 * `dados.terminal_id` (os da fila de decisão e o `EVENTO_DIVERGENTE`) e, na falta dele, o da linha de
 * `eventos_recebidos` citada em `registro_id` (o `EVENTO_DIVERGENTE` gravado antes de levar o terminal em `dados`).
 * Recebe as colunas do alerta, para servir à consulta do detalhe do terminal e à do Dashboard (alias `a`).
 */
export function terminalDoAlerta(a: {
  entidade: SQLWrapper;
  registroId: SQLWrapper;
  dados: SQLWrapper;
}): SQL<string | null> {
  return sql<string | null>`case when ${a.entidade} = 'terminais' then ${a.registroId}::text
    else coalesce(${a.dados} ->> 'terminal_id',
                  (select er.terminal_id::text from eventos_recebidos er
                    where ${a.entidade} = 'eventos_recebidos' and er.id = ${a.registroId})) end`;
}

/** Venda citada pelo payload de um `venda.*` (a do cabeçalho `vendas`). */
export function vendaDoPayload(tipo: string, payload: Payload): { id: string | null; numero: string | null } {
  if (!tipo.startsWith('venda.') && !tipo.startsWith('nfce.')) return { id: null, numero: null };
  const v = objeto(objeto(payload)?.vendas) ?? objeto(objeto(payload)?.documentos_fiscais);
  return { id: texto(v?.id) ?? texto(v?.venda_id), numero: texto(v?.numero_exibicao) };
}

/**
 * Resumo do agregado (ERP 12.5, "Venda L01-C02-000123 · R$ 71,58 · 4 itens"), lido do payload: a venda nunca
 * aplicada não existe na nuvem. A forma A do `venda.cancelada` não traz o número: vem de `numeroVenda` (a venda
 * gravada). Tipo sem resumo ou payload ilegível → `null`. O nome digitado de quem retira a sangria (pode ser alguém
 * de fora do sistema) só entra com `incluirPessoais` — quem tem `terminais.gerenciar`, que também vê o payload (D19);
 * o alerta e a auditoria do descarte, lidos por outros perfis, ficam sem ele.
 */
export function resumoDoAgregado(
  tipo: string,
  payload: Payload,
  numeroVenda: string | null = null,
  incluirPessoais = false,
): string | null {
  const p = objeto(payload);
  if (!p) return null;
  const partes = (...xs: Array<string | null>) => xs.filter((x): x is string => !!x).join(' · ') || null;
  const itens = (n: unknown) =>
    Array.isArray(n) ? `${n.length} ${n.length === 1 ? 'item' : 'itens'}` : null;
  const movimento = objeto(p.movimentos_caixa);
  switch (tipo) {
    case 'venda.finalizada':
    case 'venda.cancelada': {
      const v = objeto(p.vendas);
      const numero = texto(v?.numero_exibicao) ?? numeroVenda;
      if (Array.isArray(p.itens_venda)) {
        const rotulo = v?.status === 'cancelada' ? 'Venda cancelada em andamento' : 'Venda';
        return partes(`${rotulo} ${numero ?? ''}`.trim(), reais(v?.total), itens(p.itens_venda));
      }
      return partes(`Cancelamento da venda ${numero ?? ''}`.trim());
    }
    case 'caixa.aberto': {
      const s = objeto(p.sessoes_caixa);
      return partes('Abertura de caixa', s?.fundo_troco ? `fundo ${reais(s.fundo_troco)}` : null);
    }
    case 'caixa.reforco':
      return partes('Reforço', reais(movimento?.valor));
    case 'caixa.sangria':
      return partes(
        'Sangria',
        reais(movimento?.valor),
        incluirPessoais ? texto(movimento?.quem_retira_nome) : null,
      );
    case 'caixa.movimento_cancelado':
      return 'Cancelamento de movimento de caixa';
    case 'caixa.fechado': {
      const f = objeto(p.fechamentos_caixa);
      return partes(
        f?.tipo === 'troca_turno' ? 'Troca de turno' : 'Fechamento de caixa',
        f?.total_digitado ? `contado ${reais(f.total_digitado)}` : null,
      );
    }
    case 'vasilhame.movimentado': {
      const m = objeto(p.movimentos_vasilhame);
      return partes('Devolução de cascos', texto(m?.quantidade) ? `${Number(m!.quantidade)} un.` : null);
    }
    default:
      return null;
  }
}

/**
 * O que o gerente digita para descartar (SYNC 11.4): nos tipos críticos (`venda.*`, `caixa.*`, `nfce.*`), o número
 * exibido da venda (do payload, ou da venda gravada na forma A do cancelamento); sem número (eventos de caixa,
 * payload ilegível), a sequência do evento, que a fila mostra em toda linha (T28 da 1C). Os outros tipos não exigem.
 */
export function confirmacaoDescarte(
  tipo: string,
  payload: Payload,
  sequencia: number,
  numeroVenda: string | null = null,
): string | null {
  if (!eventoCritico(tipo)) return null;
  return vendaDoPayload(tipo, payload).numero ?? numeroVenda ?? String(sequencia);
}

/** A confirmação digitada confere: sem diferença de caixa e espaços; número também só pelos dígitos do fim. */
export function confirmacaoConfere(esperada: string, digitada: string | null | undefined): boolean {
  if (!digitada) return false;
  const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();
  if (norm(esperada) === norm(digitada)) return true;
  const fim = /(\d+)$/.exec(esperada)?.[1];
  return !!fim && /^\d+$/.test(norm(digitada)) && Number(norm(digitada)) === Number(fim);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Número exibido das vendas gravadas citadas pelas linhas (forma A do cancelamento, que não o traz no payload). O
 * payload é o que chegou (um `PAYLOAD_INVALIDO` pode trazer `vendas.id` malformado): só o id em formato UUID vai à
 * consulta — o outro faria o PostgreSQL recusar a comparação com a coluna `uuid` (22P02) e travaria a fila e o
 * descarte; fica sem número, e a confirmação cai na sequência do evento.
 */
export async function numerosDasVendas(
  db: DbEmpresa,
  linhas: readonly LinhaEvento[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      linhas
        .map((l) => vendaDoPayload(l.tipo, l.payload as Payload))
        .filter((v) => !v.numero && !!v.id && UUID.test(v.id))
        .map((v) => v.id!.toLowerCase()),
    ),
  ];
  if (!ids.length) return new Map();
  const r = await db
    .select({ id: vendas.id, numero: vendas.numeroExibicao })
    .from(vendas)
    .where(inArray(vendas.id, ids));
  return new Map(r.map((v) => [v.id.toLowerCase(), v.numero]));
}

/** O evento já não está em `erro`/`retido` (outra pessoa resolveu, o push aplicou): nada muda. */
const jaResolvido = (status: string | undefined) =>
  new ErroApi(
    'CONFLITO',
    status
      ? `O evento já foi resolvido (situação atual: ${status}). Atualize a lista.`
      : 'Evento não encontrado.',
  );

/**
 * O evento continua pendente, mas não na situação em que a ação foi decidida (outra pessoa agiu entre a leitura e a
 * trava): nada muda, 409. Ex.: o retido da cadeia que foi a `erro` `DEPENDENCIA_DESCARTADA` (8.5 pede decisão
 * humana) ou a venda que deixou de ser `NUMERO_VENDA_DUPLICADO` antes do "Aplicar com novo número".
 */
const situacaoMudou = (l: LinhaEvento) =>
  new ErroApi(
    'CONFLITO',
    `O evento mudou de situação (atual: ${l.status}${l.erroCodigo ? ` ${l.erroCodigo}` : ''}). Atualize a lista.`,
  );

/** Precondição da ação, conferida de novo sob a trava do terminal (`relerPendente`). */
type Precondicao = (l: LinhaEvento) => boolean;

const retido: Precondicao = (l) => l.status === 'retido';
const duplicado: Precondicao = (l) =>
  aceitaNovoNumero({ status: l.status, erroCodigo: l.erroCodigo, tipo: l.tipo });
const comCodigo =
  (codigo: string): Precondicao =>
  (l) =>
    l.status === 'erro' && l.erroCodigo === codigo;

/**
 * Erros que a lacuna explica (SYNC 8.6): o que faltava (a sessão, a referência, a dependência) pode ter chegado com os
 * eventos recuperados. Os demais (`PAYLOAD_INVALIDO` do hash divergente, `NUMERO_VENDA_DUPLICADO`,
 * `AGREGADO_DIVERGENTE`, `ESCOPO_INVALIDO`, `ERRO_INTERNO`…) não têm a ver com ela e continuam esperando a decisão
 * de alguém na fila do ERP: o supervisor liberou a recuperação da lacuna, não esses eventos.
 */
export const CODIGOS_CAUSADOS_POR_LACUNA = [
  'SESSAO_INEXISTENTE',
  'REFERENCIA_INEXISTENTE',
  'DEPENDENCIA_DESCARTADA',
] as const;

/** `retido` (esperando um bloqueador) ou `erro` com um código que a lacuna explica. */
const causadoPorLacuna: Precondicao = (l) =>
  l.status === 'retido' ||
  (l.status === 'erro' && (CODIGOS_CAUSADOS_POR_LACUNA as readonly (string | null)[]).includes(l.erroCodigo));

/** Transitório do reaplicar (409 com `detalhes.codigo`: `SCHEMA_DESCONHECIDO`, `CONCORRENCIA_BANCO`…), não "resolvido". */
const transitorio = (e: ErroApi) => typeof e.extras.detalhes?.codigo === 'string';

/** Tentativas do lote para o mesmo evento quando o banco devolve um transitório (deadlock, conexão perdida). */
const TENTATIVAS_TRANSITORIO_LOTE = 3;

/** O que a tarefa do lote guarda da requisição para a auditoria dos eventos que reaplica (`OrigemAcao`). */
interface OrigemLote {
  usuarioNome: string | null;
  ip: string | null;
  userAgent: string | null;
  requisicaoId: string | null;
}

interface OpcoesReaplicar {
  novoNumero?: boolean;
  /** Além de `erro`/`retido`, o que precisa valer sob a trava (a situação em que a ação foi decidida). */
  precondicao?: Precondicao;
  /** Retido reaplicado em seguida ao bloqueador (SYNC 8.5): a auditoria diz de quem. */
  porSequencia?: number;
  /** Lote por código (tarefa): a auditoria diz. */
  lote?: string;
  /** Depois da lacuna recuperada (SYNC 8.6): a menor sequência da faixa, para a auditoria. */
  lacuna?: number;
}

type DesfechoInterno = DesfechoReprocessamento & {
  numero: ResultadoReprocessamento['numero'];
  terminalId: string;
};

const publico = ({ numero: _n, terminalId: _t, ...d }: DesfechoInterno): DesfechoReprocessamento => d;

/** O retido que o push segurou por este bloqueador (`dependencias` ganha `{evento_id_bloqueador}`, SYNC 8.5). */
const bloqueadoPor = (eventoId: string): SQL =>
  sql`${eventosRecebidos.dependencias} @> ${JSON.stringify([{ evento_id_bloqueador: eventoId }])}::jsonb`;

export class FilaDecisao {
  constructor(
    private readonly tenancy: Tenancy,
    private readonly auditoria: AuditoriaService,
    private readonly tarefas: TarefasSegundoPlano,
  ) {
    tarefas.registrarTipo(TAREFA_REPROCESSAR_EVENTOS, (e) => this.executarLote(e));
    tarefas.registrarTipo(TAREFA_REPROCESSAR_APOS_LACUNA, (e) => this.executarAposLacuna(e));
  }

  /**
   * SYNC 8.6: os eventos recuperados de uma lacuna foram aplicados fora da ordem original (os seguintes já tinham
   * chegado), então os posteriores que ficaram em `erro`/`retido` por causa dela — os `retido` e os `erro` de
   * `CODIGOS_CAUSADOS_POR_LACUNA` — são reprocessados em ordem, numa tarefa (ERP 3.6) criada na transação do fecho da
   * lacuna em nome de quem liberou a recuperação. Os outros códigos ficam para a fila do ERP. Nada pendente depois da
   * faixa → nenhuma tarefa (`null`). O push agenda a tarefa depois do commit (`agendarTarefa`).
   */
  async criarReprocessamentoAposLacuna(
    tx: DbEmpresa,
    d: { terminalId: string; lojaId: string; desde: number; loteId: string; autorizadoPorId: string },
  ): Promise<string | null> {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(eventosRecebidos)
      .where(this.posterioresALacuna(d.terminalId, d.desde, d.loteId));
    if (!n) return null;
    return this.tarefas.criar(tx, {
      tipo: TAREFA_REPROCESSAR_APOS_LACUNA,
      parametros: { terminalId: d.terminalId, desde: d.desde, loteId: d.loteId },
      usuarioId: d.autorizadoPorId,
      lojaId: d.lojaId,
    });
  }

  agendarTarefa(empresaId: string, tarefaId: string): Promise<void> {
    return this.tarefas.agendar(empresaId, tarefaId);
  }

  /**
   * Executor da tarefa da lacuna recuperada: cada `retido` e cada `erro` causado pela lacuna do terminal com
   * sequência acima do início da faixa (menos os do próprio lote da recuperação, que acabaram de ser aplicados ou
   * recusados), em ordem de sequência, um por transação de evento (`reaplicar`, com a auditoria
   * `evento_reprocessado`, origem PDV e modo `lacuna`). A seleção vale de novo sob a trava (`causadoPorLacuna`): o que
   * mudou de código ou foi resolvido no meio do caminho é pulado. O retido cujo bloqueador ainda está pendente volta a
   * ficar retido.
   */
  async executarAposLacuna(e: ExecucaoTarefa): Promise<{ resultado: Record<string, unknown> }> {
    const { terminalId, desde, loteId } = e.tarefa.parametros as {
      terminalId: string;
      desde: number;
      loteId: string;
    };
    const ids = await this.tenancy.cx().consulta(async (db) =>
      (
        await db
          .select({ eventoId: eventosRecebidos.eventoId })
          .from(eventosRecebidos)
          .where(this.posterioresALacuna(terminalId, desde, loteId))
          .orderBy(asc(eventosRecebidos.sequenciaTerminal))
      ).map((l) => l.eventoId),
    );
    const origem: OrigemAcao = {
      origem: 'pdv',
      usuarioId: e.tarefa.usuarioId,
      autorizadoPorId: e.tarefa.usuarioId,
      terminalId,
    };
    const contagem = { total: ids.length, aplicados: 0, retidos: 0, erros: 0, ignorados: 0, adiados: 0 };
    for (let i = 0; i < ids.length; i++) {
      for (let tentativa = 1; ; tentativa++) {
        try {
          const r = await this.reaplicar(ids[i]!, origem, { lacuna: desde, precondicao: causadoPorLacuna });
          contagem[r.status === 'aplicado' ? 'aplicados' : r.status === 'retido' ? 'retidos' : 'erros']++;
        } catch (erro) {
          if (!(erro instanceof ErroApi)) throw erro;
          if (transitorio(erro) && tentativa < TENTATIVAS_TRANSITORIO_LOTE) continue;
          contagem[transitorio(erro) ? 'adiados' : 'ignorados']++;
        }
        break;
      }
      await e.progresso(((i + 1) / ids.length) * 100, `${i + 1} de ${ids.length} eventos`);
    }
    return { resultado: { terminal_id: terminalId, desde, ...contagem } };
  }

  private posterioresALacuna(terminalId: string, desde: number, loteId: string): SQL {
    return and(
      eq(eventosRecebidos.terminalId, terminalId),
      or(
        eq(eventosRecebidos.status, 'retido'),
        and(
          eq(eventosRecebidos.status, 'erro'),
          inArray(eventosRecebidos.erroCodigo, [...CODIGOS_CAUSADOS_POR_LACUNA]),
        ),
      ),
      sql`${eventosRecebidos.sequenciaTerminal} > ${desde}`,
      sql`${eventosRecebidos.loteId} is distinct from ${loteId}::uuid`,
    )!;
  }

  /** Reprocessar (SYNC 11.4) e, com sucesso, os retidos que dependiam dele, em ordem de sequência (8.5). */
  async reprocessar(sessao: SessaoErp, id: string, origem: OrigemAcao): Promise<ResultadoReprocessamento> {
    const l = await this.carregar(sessao, id);
    return this.reprocessarComDependentes(l.eventoId, origem, {});
  }

  /** Aplicar com novo número (SYNC 11.2, 13.1): só o `erro` `NUMERO_VENDA_DUPLICADO` de um documento de venda. */
  async aplicarNovoNumero(
    sessao: SessaoErp,
    id: string,
    origem: OrigemAcao,
  ): Promise<ResultadoReprocessamento> {
    const l = await this.carregar(sessao, id);
    if (!aceitaNovoNumero({ status: l.status, erroCodigo: l.erroCodigo, tipo: l.tipo })) {
      throw new ErroApi(
        'REGRA_NEGOCIO',
        '"Aplicar com novo número" só vale para a venda com erro NUMERO_VENDA_DUPLICADO.',
      );
    }
    return this.reprocessarComDependentes(l.eventoId, origem, { novoNumero: true, precondicao: duplicado });
  }

  /**
   * Descartar (SYNC 11.4): justificativa e, nos tipos críticos, o número digitado; grava `descartado_*`, fecha o
   * `EVENTO_COM_ERRO`, abre o `EVENTO_DESCARTADO` (crítico) e leva os retidos que dependiam dele a `erro`
   * `DEPENDENCIA_DESCARTADA` (8.5: decisão humana para cada um). O PDV recebe `descartado` no heartbeat.
   */
  async descartar(
    sessao: SessaoErp,
    id: string,
    entrada: DescartarEvento,
    origem: OrigemAcao,
  ): Promise<ResultadoDescarte> {
    const l0 = await this.carregar(sessao, id);
    return this.tenancy.cx().transacao(async (tx, c) => {
      await travarTerminal(c, l0.terminalId);
      const [l] = await tx.select().from(eventosRecebidos).where(eq(eventosRecebidos.id, id));
      if (!l || !PENDENTES.includes(l.status as never)) throw jaResolvido(l?.status);
      const numeros = await numerosDasVendas(tx, [l]);
      const venda = vendaDoPayload(l.tipo, l.payload as Payload);
      const numeroVenda = venda.id ? (numeros.get(venda.id.toLowerCase()) ?? null) : null;
      const exigida = confirmacaoDescarte(l.tipo, l.payload as Payload, l.sequenciaTerminal, numeroVenda);
      if (exigida && !confirmacaoConfere(exigida, entrada.confirmacao)) {
        throw new ErroApi('VALIDACAO', 'Confirme o descarte digitando o número indicado.', {
          campos: { confirmacao: [`Digite ${exigida} para confirmar`] },
        });
      }
      const terminal = await this.terminal(c, l.terminalId);
      const agora = new Date();
      await tx
        .update(eventosRecebidos)
        .set({
          status: 'descartado',
          descartadoEm: agora,
          descartadoPorId: sessao.usuarioId,
          justificativaDescarte: entrada.justificativa,
          // O heartbeat entrega o `descartado` ao PDV até o ack (SYNC 21.1).
          resolucaoEntregueEm: null,
        })
        .where(eq(eventosRecebidos.id, l.id));
      await resolverAlertaEventoComErro(
        tx,
        l.eventoId,
        `Descartado: ${entrada.justificativa}`,
        sessao.usuarioId,
      );
      const dependentes = await tx
        .select()
        .from(eventosRecebidos)
        .where(
          and(
            eq(eventosRecebidos.terminalId, l.terminalId),
            eq(eventosRecebidos.status, 'retido'),
            bloqueadoPor(l.eventoId),
          ),
        )
        .orderBy(asc(eventosRecebidos.sequenciaTerminal));
      for (const d of dependentes) {
        const mensagem = `O evento nº ${l.sequenciaTerminal} (${l.tipo}) de que este dependia foi descartado.`;
        await tx
          .update(eventosRecebidos)
          .set({ status: 'erro', erroCodigo: 'DEPENDENCIA_DESCARTADA', erro: mensagem })
          .where(eq(eventosRecebidos.id, d.id));
        await alertarEventoComErro(tx, {
          id: d.id,
          eventoId: d.eventoId,
          sequencia: d.sequenciaTerminal,
          tipo: d.tipo,
          erroCodigo: 'DEPENDENCIA_DESCARTADA',
          erro: mensagem,
          terminal,
        });
      }
      const resumo = resumoDoAgregado(l.tipo, l.payload as Payload, numeroVenda);
      await tx
        .insert(alertas)
        .values({
          tipo: ALERTA_EVENTO_DESCARTADO,
          severidade: 'critico',
          titulo: `Caixa ${caixa2(terminal.numeroCaixa)}: evento ${l.tipo} descartado`.slice(0, 150),
          mensagem:
            `${resumo ? `${resumo}. ` : ''}O evento nº ${l.sequenciaTerminal} foi descartado por ` +
            `${sessao.usuarioNome}: ${entrada.justificativa}` +
            (dependentes.length
              ? ` ${dependentes.length} evento(s) que dependiam dele foram para a fila com DEPENDENCIA_DESCARTADA.`
              : ''),
          lojaId: l.lojaId,
          entidade: 'eventos_recebidos',
          registroId: l.id,
          dados: {
            evento_id: l.eventoId,
            terminal_id: l.terminalId,
            sequencia: l.sequenciaTerminal,
            tipo: l.tipo,
            erro_codigo: l.erroCodigo,
            justificativa: entrada.justificativa,
            dependentes: dependentes.map((d) => d.eventoId),
          },
          chaveDeduplicacao: `evento_descartado:${l.eventoId}`,
        })
        .onConflictDoNothing();
      await this.auditoria.registrar(tx, origem, {
        acao: 'evento_descartado',
        entidade: 'eventos_recebidos',
        registroId: l.id,
        lojaId: l.lojaId,
        eventoId: l.eventoId,
        localizacao: LOCALIZACAO,
        descricao:
          `Evento nº ${l.sequenciaTerminal} (${l.tipo}) do caixa ${caixa2(terminal.numeroCaixa)} descartado` +
          `${resumo ? ` — ${resumo}` : ''}: ${entrada.justificativa}`,
        antes: { status: l.status, erro_codigo: l.erroCodigo, erro: l.erro },
        depois: {
          status: 'descartado',
          justificativa: entrada.justificativa,
          dependentes: dependentes.map((d) => ({ evento_id: d.eventoId, sequencia: d.sequenciaTerminal })),
        },
      });
      await resolverAlertasSemEventos(tx);
      return {
        eventoId: l.eventoId,
        dependentes: dependentes.map((d) => ({
          eventoId: d.eventoId,
          sequencia: d.sequenciaTerminal,
          tipo: d.tipo,
        })),
      };
    });
  }

  /**
   * "Reprocessar todos com este código" (SYNC 11.4): os `erro` do terminal com o código, numa tarefa (ERP 3.6). O
   * pedido é auditado aqui (`evento_reprocessado`, `modo: 'lote_agendado'`, no histórico do terminal), e a tarefa
   * guarda o nome, o IP, o user agent e a requisição de quem pediu para a auditoria de cada evento reaplicado.
   */
  async agendarLote(
    sessao: SessaoErp,
    entrada: ReprocessarLoteEntrada,
    origem: OrigemAcao,
  ): Promise<ReprocessamentoAgendado> {
    const r = await this.tenancy.cx().transacao(async (tx, c) => {
      const [t] = await tx
        .select({ lojaId: terminais.lojaId })
        .from(terminais)
        .where(eq(terminais.id, entrada.terminalId));
      if (!t) throw ErroApi.naoEncontrado('Terminal não encontrado.');
      garantirLoja(sessao, t.lojaId);
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(eventosRecebidos)
        .where(
          and(
            eq(eventosRecebidos.terminalId, entrada.terminalId),
            eq(eventosRecebidos.status, 'erro'),
            eq(eventosRecebidos.erroCodigo, entrada.codigo),
          ),
        );
      if (!n) throw new ErroApi('REGRA_NEGOCIO', `Nenhum evento com erro ${entrada.codigo} neste terminal.`);
      const doLote: OrigemLote = {
        usuarioNome: origem.usuarioNome ?? sessao.usuarioNome,
        ip: origem.ip ?? null,
        userAgent: origem.userAgent ?? null,
        requisicaoId: origem.requisicaoId ?? null,
      };
      const tarefaId = await this.tarefas.criar(tx, {
        tipo: TAREFA_REPROCESSAR_EVENTOS,
        parametros: { terminalId: entrada.terminalId, codigo: entrada.codigo, origem: doLote },
        usuarioId: sessao.usuarioId,
        lojaId: t.lojaId,
      });
      const terminal = await this.terminal(c, entrada.terminalId);
      await this.auditoria.registrar(tx, origem, {
        acao: 'evento_reprocessado',
        entidade: 'terminais',
        registroId: entrada.terminalId,
        lojaId: t.lojaId,
        localizacao: `${LOCALIZACAO} › Reprocessar todos`,
        descricao:
          `Reprocessamento em lote pedido: ${n} evento(s) com erro ${entrada.codigo} do caixa ` +
          `${caixa2(terminal.numeroCaixa)}`,
        depois: { modo: 'lote_agendado', codigo: entrada.codigo, quantidade: n, tarefa_id: tarefaId },
      });
      return { tarefaId, quantidade: n };
    });
    await this.tarefas.agendar(sessao.empresa.empresaId, r.tarefaId);
    return r;
  }

  /**
   * Executor da tarefa: cada `erro` do código, em ordem de sequência, como o Reprocessar da tela (com os dependentes).
   * O que outra pessoa ou um reprocessamento anterior da mesma tarefa já resolveu (ou tirou do código) é pulado e
   * contado em `ignorados`; o transitório do banco é tentado de novo e, se persistir, contado em `adiados` (o evento
   * continua em `erro`, sem tentativa registrada).
   */
  async executarLote(e: ExecucaoTarefa): Promise<{ resultado: Record<string, unknown> }> {
    const {
      terminalId,
      codigo,
      origem: doLote,
    } = e.tarefa.parametros as {
      terminalId: string;
      codigo: string;
      origem?: Partial<OrigemLote>;
    };
    const ids = await this.tenancy.cx().consulta(async (db) =>
      (
        await db
          .select({ eventoId: eventosRecebidos.eventoId })
          .from(eventosRecebidos)
          .where(
            and(
              eq(eventosRecebidos.terminalId, terminalId),
              eq(eventosRecebidos.status, 'erro'),
              eq(eventosRecebidos.erroCodigo, codigo),
            ),
          )
          .orderBy(asc(eventosRecebidos.sequenciaTerminal))
      ).map((l) => l.eventoId),
    );
    const origem: OrigemAcao = {
      origem: 'erp',
      usuarioId: e.tarefa.usuarioId,
      usuarioNome: doLote?.usuarioNome ?? null,
      ip: doLote?.ip ?? null,
      userAgent: doLote?.userAgent ?? null,
      requisicaoId: doLote?.requisicaoId ?? null,
    };
    const contagem = {
      total: ids.length,
      aplicados: 0,
      retidos: 0,
      erros: 0,
      ignorados: 0,
      adiados: 0,
      dependentes: 0,
    };
    const opcoes: OpcoesReaplicar = { lote: codigo, precondicao: comCodigo(codigo) };
    for (let i = 0; i < ids.length; i++) {
      for (let tentativa = 1; ; tentativa++) {
        try {
          const r = await this.reprocessarComDependentes(ids[i]!, origem, opcoes);
          contagem[r.status === 'aplicado' ? 'aplicados' : r.status === 'retido' ? 'retidos' : 'erros']++;
          contagem.dependentes += r.dependentes.filter((d) => d.status === 'aplicado').length;
        } catch (erro) {
          if (!(erro instanceof ErroApi)) throw erro;
          if (transitorio(erro) && tentativa < TENTATIVAS_TRANSITORIO_LOTE) continue;
          contagem[transitorio(erro) ? 'adiados' : 'ignorados']++;
        }
        break;
      }
      await e.progresso(((i + 1) / ids.length) * 100, `${i + 1} de ${ids.length} eventos`);
    }
    return { resultado: { codigo, terminal_id: terminalId, ...contagem } };
  }

  // -------------------------------------------------------------------------------------------------------------

  private async carregar(sessao: SessaoErp, id: string): Promise<LinhaEvento> {
    const [l] = await this.tenancy
      .cx()
      .consulta((db) => db.select().from(eventosRecebidos).where(eq(eventosRecebidos.id, id)));
    if (!l) throw ErroApi.naoEncontrado('Evento não encontrado.');
    garantirLoja(sessao, l.lojaId);
    if (!PENDENTES.includes(l.status as never)) throw jaResolvido(l.status);
    return l;
  }

  private async terminal(
    c: Parameters<typeof carregarTerminalDoEvento>[0],
    id: string,
  ): Promise<TerminalDoEvento> {
    const t = await carregarTerminalDoEvento(c, id);
    if (!t) throw ErroApi.naoEncontrado('Terminal do evento não encontrado.');
    return t;
  }

  /**
   * O evento e, se aplicado, os retidos que dependiam dele (SYNC 8.5): a cada passo, o retido de **menor sequência**
   * cujo bloqueador já foi aplicado aqui, para a ordem do terminal valer também numa cadeia (a venda retida pela sessão
   * que estava retida pelo fechamento anterior). Cada um na sua transação de evento.
   */
  private async reprocessarComDependentes(
    eventoId: string,
    origem: OrigemAcao,
    opcoes: OpcoesReaplicar,
  ): Promise<ResultadoReprocessamento> {
    const principal = await this.reaplicar(eventoId, origem, opcoes);
    const dependentes: DesfechoReprocessamento[] = [];
    const resposta = () => ({ ...publico(principal), numero: principal.numero, dependentes });
    if (principal.status !== 'aplicado') return resposta();
    const aplicados = [principal.eventoId];
    const vistos = [eventoId];
    for (;;) {
      const [proximo] = await this.tenancy.cx().consulta((db) =>
        db
          .select({ eventoId: eventosRecebidos.eventoId })
          .from(eventosRecebidos)
          .where(
            and(
              eq(eventosRecebidos.terminalId, principal.terminalId),
              eq(eventosRecebidos.status, 'retido'),
              notInArray(eventosRecebidos.eventoId, vistos),
              or(...aplicados.map(bloqueadoPor)),
            ),
          )
          .orderBy(asc(eventosRecebidos.sequenciaTerminal))
          .limit(1),
      );
      if (!proximo) break;
      vistos.push(proximo.eventoId);
      try {
        const d = await this.reaplicar(proximo.eventoId, origem, {
          porSequencia: principal.sequencia,
          precondicao: retido,
        });
        dependentes.push(publico(d));
        if (d.status === 'aplicado') aplicados.push(d.eventoId);
      } catch (erro) {
        // Resolvido no meio do caminho (o push ou outra pessoa) ou já não `retido` (foi a `erro` e pede decisão):
        // segue com os outros.
        if (!(erro instanceof ErroApi)) throw erro;
      }
    }
    return resposta();
  }

  /**
   * Uma transação de evento (SYNC 8.1): trava do terminal, a linha relida sob ela, `tentativas + 1` e a aplicação
   * comum (`aplicarEvento`), que retém de novo se ainda há dependência pendente. O `payload_sha256` não é conferido
   * outra vez: o `PAYLOAD_INVALIDO` de hash divergente é diagnóstico do serializador (8.1), e o payload gravado é o que
   * chegou. Erro de regra (ou exceção, que aqui já é `ERRO_INTERNO`: quem clicou vê na hora) → `rollback` e nova
   * transação grava o `erro`, como no push; transitório (`SCHEMA_DESCONHECIDO`, banco) → nada muda, 409.
   */
  private async reaplicar(
    eventoId: string,
    origem: OrigemAcao,
    opcoes: OpcoesReaplicar,
  ): Promise<DesfechoInterno> {
    const cx = this.tenancy.cx();
    const [l0] = await cx.consulta((db) =>
      db
        .select({ terminalId: eventosRecebidos.terminalId })
        .from(eventosRecebidos)
        .where(eq(eventosRecebidos.eventoId, eventoId)),
    );
    if (!l0) throw jaResolvido(undefined);
    try {
      return await cx.transacao(async (tx, c): Promise<DesfechoInterno> => {
        await travarTerminal(c, l0.terminalId);
        const l = await this.relerPendente(tx, eventoId, opcoes.precondicao);
        const terminal = await this.terminal(c, l.terminalId);
        await tx
          .update(eventosRecebidos)
          .set({ tentativas: sql`${eventosRecebidos.tentativas} + 1` })
          .where(eq(eventosRecebidos.id, l.id));
        const ev = envelopeDaLinha(l, terminal);
        const a = await aplicarEvento(tx, c, terminal, ev, { novoNumero: opcoes.novoNumero });
        const resultado = a.status === 'aplicado' ? a.resultado : null;
        const numero =
          resultado && typeof resultado.numero_exibicao_original === 'string'
            ? { original: resultado.numero_exibicao_original, novo: String(resultado.numero_exibicao) }
            : null;
        await resolverAlertaEventoComErro(
          tx,
          l.eventoId,
          a.status === 'aplicado' ? 'Reprocessado: aplicado' : 'Reprocessado: aguardando outro evento',
          origem.usuarioId ?? null,
        );
        const desfecho: DesfechoInterno = {
          eventoId: l.eventoId,
          sequencia: l.sequenciaTerminal,
          tipo: l.tipo,
          status: a.status,
          erroCodigo: a.status === 'retido' ? a.codigo : null,
          erro: a.status === 'retido' ? a.mensagem : null,
          numero,
          terminalId: l.terminalId,
        };
        await this.auditarReprocessamento(tx, origem, l, terminal, desfecho, opcoes);
        await resolverAlertasSemEventos(tx);
        return desfecho;
      });
    } catch (e) {
      if (e instanceof ErroApi) throw e;
      const erro = traduzirErroBanco(e) ?? (e as Error);
      if (erro instanceof ErroTransitorioEvento) {
        throw new ErroApi(
          'CONFLITO',
          `Não foi possível aplicar agora (${erro.codigo}): ${erro.message} Nada mudou; tente de novo.`,
          { detalhes: { codigo: erro.codigo } },
        );
      }
      return this.gravarErro(eventoId, l0.terminalId, origem, opcoes, erro);
    }
  }

  /** Falha do reprocessamento: transação nova (com a trava do terminal) grava o `erro` e a auditoria. */
  private async gravarErro(
    eventoId: string,
    terminalId: string,
    origem: OrigemAcao,
    opcoes: OpcoesReaplicar,
    erro: Error,
  ): Promise<DesfechoInterno> {
    const regra = erro instanceof ErroRegraEvento ? erro : null;
    const codigo = regra?.codigo ?? 'ERRO_INTERNO';
    // A mensagem do `DrizzleQueryError` traz o SQL e os parâmetros (CPF, nome…): só a do PostgreSQL.
    const mensagem = (
      regra
        ? regra.message
        : erro instanceof DrizzleQueryError
          ? (erro.cause?.message ?? 'Falha na consulta.')
          : erro.message
    ).slice(0, 2000);
    return this.tenancy.cx().transacao(async (tx, c) => {
      await travarTerminal(c, terminalId);
      const l = await this.relerPendente(tx, eventoId, opcoes.precondicao);
      const terminal = await this.terminal(c, l.terminalId);
      await tx
        .update(eventosRecebidos)
        .set({ tentativas: sql`${eventosRecebidos.tentativas} + 1` })
        .where(eq(eventosRecebidos.id, l.id));
      // Outro código: o alerta aberto (com o erro anterior) fecha e `marcarEvento` abre o do erro novo.
      if (l.status !== 'erro' || l.erroCodigo !== codigo) {
        await resolverAlertaEventoComErro(
          tx,
          l.eventoId,
          `Reprocessado: ${codigo}`,
          origem.usuarioId ?? null,
        );
      }
      const m = {
        status: 'erro' as const,
        codigo,
        mensagem,
        resultado: { detalhes: regra?.detalhes ?? {} },
      };
      let ev;
      try {
        ev = envelopeDaLinha(l, terminal);
      } catch {
        ev = null;
      }
      if (ev) {
        await marcarEvento(tx, ev, terminal, m);
      } else {
        await tx
          .update(eventosRecebidos)
          .set({ status: 'erro', erroCodigo: codigo, erro: mensagem, resultado: m.resultado })
          .where(eq(eventosRecebidos.id, l.id));
        await alertarEventoComErro(tx, {
          id: l.id,
          eventoId: l.eventoId,
          sequencia: l.sequenciaTerminal,
          tipo: l.tipo,
          erroCodigo: codigo,
          erro: mensagem,
          terminal,
        });
      }
      const desfecho: DesfechoInterno = {
        eventoId: l.eventoId,
        sequencia: l.sequenciaTerminal,
        tipo: l.tipo,
        status: 'erro',
        erroCodigo: codigo,
        erro: mensagem,
        numero: null,
        terminalId: l.terminalId,
      };
      await this.auditarReprocessamento(tx, origem, l, terminal, desfecho, opcoes);
      return desfecho;
    });
  }

  /** A linha relida sob a trava: ainda `erro`/`retido` e, se a ação pede, na situação em que foi decidida. */
  private async relerPendente(
    tx: DbEmpresa,
    eventoId: string,
    precondicao?: Precondicao,
  ): Promise<LinhaEvento> {
    const [l] = await tx.select().from(eventosRecebidos).where(eq(eventosRecebidos.eventoId, eventoId));
    if (!l || !PENDENTES.includes(l.status as never)) throw jaResolvido(l?.status);
    if (precondicao && !precondicao(l)) throw situacaoMudou(l);
    return l;
  }

  /** Ação `evento_reprocessado` (T9): uma por evento reaplicado, inclusive os dependentes e os do lote. */
  private async auditarReprocessamento(
    tx: DbEmpresa,
    origem: OrigemAcao,
    l: LinhaEvento,
    terminal: TerminalDoEvento,
    d: DesfechoInterno,
    opcoes: OpcoesReaplicar,
  ): Promise<void> {
    const modo = opcoes.novoNumero
      ? 'novo_numero'
      : opcoes.porSequencia !== undefined
        ? 'dependente'
        : opcoes.lote
          ? 'lote'
          : opcoes.lacuna !== undefined
            ? 'lacuna'
            : 'manual';
    const como = {
      novo_numero: 'aplicado com novo número',
      dependente: `reprocessado em seguida ao evento nº ${opcoes.porSequencia}`,
      lote: `reprocessado no lote do código ${opcoes.lote}`,
      lacuna: `reprocessado depois da lacuna recuperada a partir do evento nº ${opcoes.lacuna}`,
      manual: 'reprocessado',
    }[modo];
    const situacao =
      d.status === 'aplicado'
        ? d.numero
          ? `aplicado como ${d.numero.novo} (número do caixa ${d.numero.original})`
          : 'aplicado'
        : d.status === 'retido'
          ? 'continua retido'
          : `erro ${d.erroCodigo}`;
    await this.auditoria.registrar(tx, origem, {
      acao: 'evento_reprocessado',
      entidade: 'eventos_recebidos',
      registroId: l.id,
      lojaId: l.lojaId,
      eventoId: l.eventoId,
      localizacao: LOCALIZACAO,
      descricao: `Evento nº ${l.sequenciaTerminal} (${l.tipo}) do caixa ${caixa2(terminal.numeroCaixa)} ${como}: ${situacao}`,
      antes: { status: l.status, erro_codigo: l.erroCodigo, erro: l.erro, tentativas: l.tentativas },
      depois: {
        status: d.status,
        erro_codigo: d.erroCodigo,
        modo,
        ...(d.numero ? { numero_original: d.numero.original, numero_novo: d.numero.novo } : {}),
      },
    });
  }
}
