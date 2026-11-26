/**
 * Cancelar pelo ERP a venda do caixa (ERP 15.4.3; SYNC 10.4, 16.3; Fase 3, F3-B11, README da API › decisão 229),
 * inclusive a de **caixa já fechado**, que desde a 1C não se cancelava em lugar nenhum (PC-1/D23). Numa transação com
 * a 7300001 primeiro (`travaVersao`, a ordem do push: a trava de ordenação e depois as linhas) e a linha da venda
 * travada (`for update`), que põe em fila o cancelamento do caixa (`venda.cancelada`), este e a troca (F3-B43):
 * - **bloqueios** (`bloqueioCancelamento`, na ordem): já cancelada (409); não finalizada; venda que não é do caixa (a
 *   venda ERP ganha o cancelamento com ela, F3-B57); com documento fiscal (fase fiscal: nada fiscal antes dela); o
 *   cancelamento do caixa já chegou e não foi aplicado (`venda.cancelada` da venda em `eventos_recebidos` com
 *   `recebido`, `erro` ou `retido`, `cancelamentoNaFila`: o caixa devolveu o dinheiro e o evento parou na fila; resolve-se
 *   na aba "Eventos com erro" do terminal) ou o terminal de origem informou no último heartbeat a venda em
 *   `vendas_cancelamento_pendente` (o caixa já cancelou e ainda não sincronizou; o PDV ainda não envia o campo, que fica
 *   pronto na API), os dois como `CANCELAMENTO_PENDENTE_NO_CAIXA`; a sessão da venda ainda aberta (D112: "cancele no
 *   caixa", o dinheiro está na gaveta e o fechamento ficaria errado); item com troca (`quantidade_devolvida > 0`:
 *   "cancele a troca primeiro", Padrões da Fase 3);
 * - **avisos** (`avisosCancelamento`): o terminal de origem offline ou com eventos pendentes pede a confirmação
 *   (`confirmarAvisos`; um cancelamento feito lá ainda pode chegar e vira `CANCELAMENTO_DUPLO`, com o físico aplicado,
 *   `sync/handlers/cancelamento.ts`); o caixa abaixo de `VERSAO_PDV_LE_STATUS_VENDA` só informa (ele não lê a
 *   projeção e continua mostrando a venda como finalizada);
 * - **forma de devolução** (D113): a venda de caixa fechado com total acima de zero pede como o cliente foi
 *   reembolsado (dinheiro do cofre, estorno no cartão ou PIX; o vale só com os vales, F3-B50). Até a Fase 4 a forma só
 *   fica na auditoria (`pendente_fase_4`): nenhum movimento de caixa (a sessão já fechou e foi conferida pelo que o
 *   caixa mandou, F3-B9), nenhuma conta corrente;
 * - **efeitos**: o estoque pelo núcleo do cancelamento do caixa (`vendas/estorno-venda.ts`, F3-B10: cada saída volta
 *   ao custo dela, `CANC_VENDA_PDV`/`ESTORNO_BAIXA_INSUMO`, os vazios conforme `pdv.cancelamento_devolve_vazios` da
 *   loja, a compensação do "Definir"), na data do cancelamento, sem terminal nem evento; `status = 'cancelada'` com
 *   `cancelamento_origem = 'erp'` e `cancelada_por_id` = quem cancelou; os pagamentos aprovados → `estornado`; a
 *   projeção `vendas_status_pdv` (`registrarStatusPdv` com a origem `'nuvem'`), que desce ao caixa da venda; a
 *   auditoria `cancelar` (origem `erp`) com o que fica para a Fase 4.
 *
 * A prévia (`GET /vendas/:id/cancelamento`) roda as mesmas funções sem travar, para o modal mostrar o bloqueio, os
 * avisos e se pede a forma; a gravação confere tudo de novo com a venda travada.
 */
import {
  dec,
  FORMAS_DEVOLUCAO_CANCELAMENTO,
  FORMAS_DEVOLUCAO_DISPONIVEIS,
  ROTULOS_FORMA_DEVOLUCAO_CANCELAMENTO,
  statusConexao,
  VERSAO_PDV_LE_STATUS_VENDA,
  type AvisoCancelamentoVenda,
  type BloqueioCancelamentoVenda,
  type CancelarVenda,
  type FormaDevolucaoCancelamento,
  type PreviaCancelamentoVenda,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { registrarStatusPdv } from '../sync/status-pdv.js';
import { compararVersoes } from '../sync/versoes-app.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import {
  estornarEstoqueDaVenda,
  lerDevolveVazios,
  linhasDeEstorno,
  movimentosParaEstornar,
  quantidadesDevolvidas,
} from './estorno-venda.js';

export const LOCALIZACAO_VENDAS = 'Vendas › Venda';
/** O código do bloqueio pelo terminal (SYNC 10.4), também em `detalhes.codigo` do erro. */
export const CANCELAMENTO_PENDENTE_NO_CAIXA = 'CANCELAMENTO_PENDENTE_NO_CAIXA';
/** O 409 do cancelamento com aviso a confirmar (`detalhes.codigo`); a tela mostra `detalhes.avisos`. */
export const CONFIRMAR_AVISOS_CANCELAMENTO = 'CONFIRMAR_AVISOS';

const reais = (v: string) => `R$ ${v.replace('.', ',')}`;
const caixaTexto = (n: number) => `caixa ${String(n).padStart(2, '0')}`;

/** A venda como o cancelamento a confere (com a sessão dela). */
export interface VendaParaCancelar {
  id: string;
  numeroExibicao: string;
  lojaId: string;
  caixaId: string;
  numeroCaixa: number;
  terminalId: string | null;
  sessaoCaixaId: string | null;
  /** `null` sem sessão (só a venda do ERP e a de integração não têm). */
  sessaoStatus: string | null;
  status: string;
  statusFiscal: string;
  cancelamentoOrigem: string | null;
  total: string;
}

/** Um terminal que importa ao cancelamento: o de origem (se não revogado) e o ativo do caixa da venda. */
export interface TerminalDaVenda {
  id: string;
  numeroCaixa: number;
  descricao: string | null;
  status: string;
  versaoApp: string | null;
  ultimoContatoEm: Date | null;
  eventosPendentes: number;
  vendasCancelamentoPendente: string[];
  /** É o terminal que fez a venda. */
  origem: boolean;
}

/** A venda (não rascunho) com a sessão, ou `null`; `travar` = `for update` da linha da venda. */
export async function lerVendaParaCancelar(
  db: DbEmpresa,
  vendaId: string,
  travar: boolean,
): Promise<VendaParaCancelar | null> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    select v.id, v.numero_exibicao, v.loja_id, v.caixa_id, v.numero_caixa, v.terminal_id, v.sessao_caixa_id,
           s.status as sessao_status, v.status, v.status_fiscal, v.cancelamento_origem, v.total::text as total
      from vendas v left join sessoes_caixa s on s.id = v.sessao_caixa_id
     where v.id = ${vendaId} and v.status <> 'rascunho'
     ${travar ? sql`for update of v` : sql``}`);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    numeroExibicao: r.numero_exibicao as string,
    lojaId: r.loja_id as string,
    caixaId: r.caixa_id as string,
    numeroCaixa: Number(r.numero_caixa),
    terminalId: (r.terminal_id as string | null) ?? null,
    sessaoCaixaId: (r.sessao_caixa_id as string | null) ?? null,
    sessaoStatus: (r.sessao_status as string | null) ?? null,
    status: r.status as string,
    statusFiscal: r.status_fiscal as string,
    cancelamentoOrigem: (r.cancelamento_origem as string | null) ?? null,
    total: r.total as string,
  };
}

/**
 * Os terminais que o cancelamento consulta: o de origem enquanto não revogado (o revogado não envia mais nada) e o
 * ativo do caixa da venda (o que substituiu o de origem e recebe a projeção pelo caixa, SYNC 16.3).
 */
export async function terminaisDaVenda(db: DbEmpresa, v: VendaParaCancelar): Promise<TerminalDaVenda[]> {
  const { rows } = await db.execute<Record<string, unknown>>(sql`
    select t.id, c.numero as numero_caixa, t.descricao, t.status, t.versao_app, t.ultimo_contato_em,
           t.eventos_pendentes, t.vendas_cancelamento_pendente::text[] as pendentes
      from terminais t join caixas c on c.id = t.caixa_id
     where t.excluido_em is null
       and ((t.id = ${v.terminalId} and t.status <> 'revogado')
            or (t.caixa_id = ${v.caixaId} and t.status in ('ativo', 'desativando')))
     order by t.id = ${v.terminalId} desc, t.ativado_em`);
  return rows.map((r) => ({
    id: r.id as string,
    numeroCaixa: Number(r.numero_caixa),
    descricao: (r.descricao as string | null) ?? null,
    status: r.status as string,
    versaoApp: (r.versao_app as string | null) ?? null,
    ultimoContatoEm: r.ultimo_contato_em ? new Date(r.ultimo_contato_em as string) : null,
    eventosPendentes: Number(r.eventos_pendentes ?? 0),
    vendasCancelamentoPendente: ((r.pendentes as string[] | null) ?? []).map((id) => id.toLowerCase()),
    origem: v.terminalId !== null && (r.id as string) === v.terminalId,
  }));
}

/** A situação do `venda.cancelada` do caixa que chegou à nuvem e ainda não foi aplicado (`cancelamentoNaFila`). */
export type SituacaoCancelamentoNaFila = 'recebido' | 'erro' | 'retido';

/**
 * O `venda.cancelada` do terminal de origem para a venda que está em `eventos_recebidos` sem ter sido aplicado
 * (`recebido`, `erro` — qualquer código: um cancelamento do caixa divergente também precisa da decisão do suporte antes
 * de a venda ganhar outro — ou `retido`), ou `null`. É a nuvem que já sabe do cancelamento do caixa: o heartbeat zera
 * `eventos_pendentes` quando a resposta do push é `rejeitado`/`retido` (o evento sai dos não confirmados do caixa) e o
 * `caixa.fechado` é aplicado com o evento do turno em erro (só o alerta `FECHAMENTO_EVENTOS_PENDENTES`), então sem esta
 * consulta o cancelamento pelo ERP passaria sem bloqueio nem aviso e o cliente receberia a devolução duas vezes. Só o
 * terminal de origem: o `venda.cancelada` de outro terminal não cancela a venda (`ESCOPO_INVALIDO`). Usa o
 * `ix_eventos_recebidos_agregado`.
 */
export async function cancelamentoNaFila(
  db: DbEmpresa,
  v: Pick<VendaParaCancelar, 'id' | 'terminalId'>,
): Promise<SituacaoCancelamentoNaFila | null> {
  if (!v.terminalId) return null;
  const { rows } = await db.execute<{ status: SituacaoCancelamentoNaFila }>(sql`
    select e.status from eventos_recebidos e
     where e.terminal_id = ${v.terminalId} and e.agregado_tipo = 'venda' and e.agregado_id = ${v.id}
       and e.tipo = 'venda.cancelada' and e.status in ('recebido', 'erro', 'retido')
     order by e.sequencia_terminal
     limit 1`);
  return rows[0]?.status ?? null;
}

/** O bloqueio, com a mensagem para a tela; `null` = pode cancelar. Função pura (`cancelamento-erp.spec.ts`). */
export function bloqueioCancelamento(
  v: VendaParaCancelar,
  terminais: readonly TerminalDaVenda[],
  comTroca: boolean,
  naFila: SituacaoCancelamentoNaFila | null = null,
): { codigo: BloqueioCancelamentoVenda; mensagem: string } | null {
  if (v.status === 'cancelada')
    return {
      codigo: 'ja_cancelada',
      mensagem: `A venda ${v.numeroExibicao} já está cancelada (${v.cancelamentoOrigem === 'erp' ? 'no ERP' : 'no caixa'}).`,
    };
  if (v.status !== 'finalizada')
    return { codigo: 'nao_finalizada', mensagem: 'Só a venda finalizada pode ser cancelada.' };
  if (!v.terminalId)
    return {
      codigo: 'nao_pdv',
      mensagem:
        'Por aqui, nesta fase, só se cancela a venda feita no caixa (PDV): a venda feita no ERP ganha o ' +
        'cancelamento junto com ela.',
    };
  if (v.statusFiscal !== 'nao_aplicavel')
    return {
      codigo: 'documento_fiscal',
      mensagem:
        'A venda tem documento fiscal: o cancelamento dela fica para a fase fiscal, que cancela também a nota.',
    };
  if (naFila === 'erro' || naFila === 'retido')
    return {
      codigo: 'cancelamento_pendente_no_caixa',
      mensagem:
        `O ${caixaTexto(v.numeroCaixa)} já cancelou esta venda, mas o cancelamento dele parou na sincronização ` +
        `(${naFila === 'erro' ? 'com erro' : 'retido'}): resolva-o na aba "Eventos com erro" do terminal em vez de ` +
        'cancelar aqui, senão o cliente recebe a devolução duas vezes.',
    };
  if (naFila === 'recebido')
    return {
      codigo: 'cancelamento_pendente_no_caixa',
      mensagem: `O ${caixaTexto(v.numeroCaixa)} já cancelou esta venda e o cancelamento está chegando; aguarde a sincronização.`,
    };
  const pendente = terminais.find((t) => t.origem && t.vendasCancelamentoPendente.includes(v.id));
  if (pendente)
    return {
      codigo: 'cancelamento_pendente_no_caixa',
      mensagem: `O ${caixaTexto(pendente.numeroCaixa)} já cancelou esta venda; aguarde a sincronização.`,
    };
  if (v.sessaoStatus !== null && v.sessaoStatus !== 'fechada')
    return {
      codigo: 'sessao_aberta',
      mensagem:
        `A sessão do ${caixaTexto(v.numeroCaixa)} desta venda ainda está aberta: cancele no caixa (o dinheiro ` +
        'está na gaveta e o fechamento ficaria errado). Se o caixa já fechou, aguarde o fechamento chegar.',
    };
  if (comTroca)
    return {
      codigo: 'com_troca',
      mensagem: 'A venda tem itens trocados ou devolvidos: cancele a troca primeiro.',
    };
  return null;
}

/** A venda de caixa fechado com valor pede a forma de devolução ao cliente (D113). */
export function exigeFormaDevolucao(v: Pick<VendaParaCancelar, 'sessaoStatus' | 'total'>): boolean {
  return v.sessaoStatus === 'fechada' && dec(v.total).gt(0);
}

const nomeTerminal = (t: TerminalDaVenda) =>
  `${caixaTexto(t.numeroCaixa)}${t.descricao ? ` (${t.descricao})` : ''}`;

/**
 * Os avisos do cancelamento (SYNC 10.4): o terminal de origem offline (último contato há 2 min ou mais, ERP 12.1, ou
 * nenhum) ou com eventos pendentes no último heartbeat → confirmação; qualquer terminal da venda abaixo da versão que
 * lê a projeção (ou sem versão conhecida) → só aviso. Função pura (`cancelamento-erp.spec.ts`).
 */
export function avisosCancelamento(
  terminais: readonly TerminalDaVenda[],
  agora: Date = new Date(),
): AvisoCancelamentoVenda[] {
  const avisos: AvisoCancelamentoVenda[] = [];
  const origem = terminais.find((t) => t.origem);
  if (origem) {
    const conexao = statusConexao(origem.ultimoContatoEm, agora);
    const pendentes =
      origem.eventosPendentes > 0 ? ` com ${origem.eventosPendentes} evento(s) pendente(s)` : '';
    if (conexao !== 'online')
      avisos.push({
        codigo: 'terminal_offline',
        mensagem:
          `O ${nomeTerminal(origem)} está offline${pendentes}: um cancelamento feito lá ainda pode chegar ` +
          '(aí o ERP registra o que o caixa devolveu e avisa da devolução em dobro).',
        exigeConfirmacao: true,
      });
    else if (origem.eventosPendentes > 0)
      avisos.push({
        codigo: 'eventos_pendentes',
        mensagem:
          `O ${nomeTerminal(origem)} está${pendentes} para enviar: um cancelamento feito lá ainda pode chegar ` +
          '(aí o ERP registra o que o caixa devolveu e avisa da devolução em dobro).',
        exigeConfirmacao: true,
      });
  }
  const antigos = terminais.filter(
    (t) => !t.versaoApp || compararVersoes(t.versaoApp, VERSAO_PDV_LE_STATUS_VENDA) < 0,
  );
  if (antigos.length)
    avisos.push({
      codigo: 'versao_sem_status',
      mensagem:
        `${antigos.map((t) => `O ${nomeTerminal(t)} está no PDV ${t.versaoApp ?? 'de versão desconhecida'}`).join('; ')}: ` +
        `o caixa só fica sabendo do cancelamento feito no ERP a partir do PDV ${VERSAO_PDV_LE_STATUS_VENDA}; até lá, ` +
        'a Gestão de vendas dele continua mostrando a venda como finalizada.',
      exigeConfirmacao: false,
    });
  return avisos;
}

/** A prévia do modal (`GET /vendas/:id/cancelamento`), sem travar: o que a gravação conferirá de novo. */
export async function previaCancelamento(
  db: DbEmpresa,
  sessao: SessaoErp,
  vendaId: string,
): Promise<PreviaCancelamentoVenda> {
  const v = await lerVendaParaCancelar(db, vendaId, false);
  if (!v) throw ErroApi.naoEncontrado('Venda não encontrada.');
  if (!lojaPermitida(sessao, v.lojaId))
    throw ErroApi.semPermissao('A loja está fora das suas lojas permitidas.');
  const terminais = await terminaisDaVenda(db, v);
  const devolvidos = await quantidadesDevolvidas(db, v.id);
  const naFila = await cancelamentoNaFila(db, v);
  const devolveVazios = await lerDevolveVazios(db, v.lojaId);
  const bloqueio = bloqueioCancelamento(v, terminais, devolvidos.size > 0, naFila);
  return {
    podeCancelar: bloqueio === null,
    bloqueio,
    exigeFormaDevolucao: bloqueio === null && exigeFormaDevolucao(v),
    formasDevolucao: [...FORMAS_DEVOLUCAO_DISPONIVEIS],
    devolveVazios,
    avisos: bloqueio === null ? avisosCancelamento(terminais) : [],
  };
}

/** O erro do bloqueio: a já cancelada é conflito (409); as demais, regra de negócio (422). */
function erroDoBloqueio(b: { codigo: BloqueioCancelamentoVenda; mensagem: string }): ErroApi {
  const codigo = b.codigo === 'cancelamento_pendente_no_caixa' ? CANCELAMENTO_PENDENTE_NO_CAIXA : b.codigo;
  return new ErroApi(b.codigo === 'ja_cancelada' ? 'CONFLITO' : 'REGRA_NEGOCIO', b.mensagem, {
    detalhes: { codigo },
  });
}

/** A forma de devolução que vale: obrigatória quando a venda pede, só das disponíveis; sem valor a devolver, nula. */
function formaDaDevolucao(v: VendaParaCancelar, forma: FormaDevolucaoCancelamento | null) {
  if (!exigeFormaDevolucao(v)) return null;
  if (!forma)
    throw new ErroApi('VALIDACAO', 'Informe como a devolução ao cliente foi feita.', {
      campos: { formaDevolucao: ['Escolha a forma de devolução ao cliente'] },
    });
  if (!FORMAS_DEVOLUCAO_DISPONIVEIS.includes(forma))
    throw new ErroApi('VALIDACAO', 'O vale compra entra com os vales: escolha outra forma de devolução.', {
      campos: { formaDevolucao: ['O vale compra ainda não está disponível'] },
    });
  return forma;
}

/** O que o cancelamento gravou (o controlador devolve o detalhe da venda). */
export interface CancelamentoErpGravado {
  vendaId: string;
  movimentos: number;
  compensacoes: number;
}

/**
 * Cancela a venda (a transação já com a 7300001, `travaVersao`). Confere tudo com a linha da venda travada; os avisos
 * que pedem confirmação, sem `confirmarAvisos`, dão 409 com a lista (`detalhes.avisos`) e nada é gravado.
 */
export async function cancelarVendaPeloErp(
  tx: DbEmpresa,
  deps: { auditoria: AuditoriaService; origem: OrigemAcao },
  sessao: SessaoErp,
  vendaId: string,
  dados: CancelarVenda,
): Promise<CancelamentoErpGravado> {
  const v = await lerVendaParaCancelar(tx, vendaId, true);
  if (!v) throw ErroApi.naoEncontrado('Venda não encontrada.');
  if (!lojaPermitida(sessao, v.lojaId))
    throw ErroApi.semPermissao('A loja está fora das suas lojas permitidas.');
  // O devolvido lido com a venda travada (a troca, F3-B43, muda com a mesma trava). Uma consulta por vez: a
  // transação é um cliente só.
  const terminais = await terminaisDaVenda(tx, v);
  const devolvidos = await quantidadesDevolvidas(tx, v.id);
  const naFila = await cancelamentoNaFila(tx, v);
  const bloqueio = bloqueioCancelamento(v, terminais, devolvidos.size > 0, naFila);
  if (bloqueio) throw erroDoBloqueio(bloqueio);
  const forma = formaDaDevolucao(v, dados.formaDevolucao);
  const avisos = avisosCancelamento(terminais);
  const aConfirmar = avisos.filter((a) => a.exigeConfirmacao);
  if (aConfirmar.length && !dados.confirmarAvisos)
    throw new ErroApi('CONFLITO', aConfirmar.map((a) => a.mensagem).join(' '), {
      detalhes: { codigo: CONFIRMAR_AVISOS_CANCELAMENTO, avisos },
    });

  const canceladaEm = new Date();
  const devolveVazios = await lerDevolveVazios(tx, v.lojaId);
  const movimentos = await movimentosParaEstornar(tx, v.id, devolveVazios);
  const doc = await estornarEstoqueDaVenda(
    tx,
    linhasDeEstorno(
      movimentos,
      {
        documentoId: v.id,
        dataMovimento: canceladaEm,
        usuarioId: sessao.usuarioId,
        terminalId: null,
        eventoId: null,
      },
      devolvidos,
    ),
    'cancelamento de venda pelo ERP',
  );
  await tx.execute(sql`
    update vendas
       set status = 'cancelada', cancelada_em = ${canceladaEm}, cancelada_por_id = ${sessao.usuarioId},
           cancelamento_autorizado_por_id = null, motivo_cancelamento = ${dados.motivo},
           cancelamento_origem = 'erp', atualizado_por_id = ${sessao.usuarioId}
     where id = ${v.id}`);
  const { rows: estornados } = await tx.execute<{
    id: string;
    descricao_forma: string;
    tipo_forma: string;
    valor: string;
  }>(sql`
    update pagamentos_venda set status = 'estornado'
     where venda_id = ${v.id} and status = 'aprovado'
    returning id, descricao_forma, tipo_forma, valor::text as valor`);
  // A projeção desce ao caixa da venda (SYNC 16.3): a 7300001 já está presa desde o início da transação.
  await registrarStatusPdv(tx, v.id, 'nuvem');
  const devolucao = forma ? ROTULOS_FORMA_DEVOLUCAO_CANCELAMENTO[forma] : null;
  await deps.auditoria.registrar(tx, deps.origem, {
    acao: 'cancelar',
    entidade: 'vendas',
    registroId: v.id,
    localizacao: LOCALIZACAO_VENDAS,
    lojaId: v.lojaId,
    descricao:
      `Venda ${v.numeroExibicao} de ${reais(v.total)} do ${caixaTexto(v.numeroCaixa)} cancelada no ERP` +
      `${devolucao ? `, devolução ao cliente: ${devolucao}` : ''}: ${dados.motivo}`,
    antes: { status: v.status },
    depois: {
      status: 'cancelada',
      cancelamento_origem: 'erp',
      motivo_cancelamento: dados.motivo,
      forma_devolucao: forma,
      devolve_vazios: devolveVazios,
      movimentos_estoque: doc.movimentos.length,
      compensacoes: doc.compensacoes.length,
      avisos_confirmados: avisos.filter((a) => a.exigeConfirmacao).map((a) => a.codigo),
      // O financeiro (a saída do cofre na conta corrente, a conta a receber, a consolidação) é da Fase 4: o que o
      // cancelamento deixou registrado para ela.
      pendente_fase_4: {
        forma_devolucao: forma,
        valor: forma ? v.total : null,
        pagamentos_estornados: estornados.map((p) => ({
          pagamento_venda_id: p.id,
          forma: p.descricao_forma,
          tipo_forma: p.tipo_forma,
          valor: p.valor,
        })),
      },
    },
  });
  return { vendaId: v.id, movimentos: doc.movimentos.length, compensacoes: doc.compensacoes.length };
}

/** A forma de devolução gravada na auditoria do cancelamento pelo ERP (para o detalhe da venda), ou `null`. */
export async function formaDevolucaoGravada(
  db: DbEmpresa,
  vendaId: string,
): Promise<FormaDevolucaoCancelamento | null> {
  const { rows } = await db.execute<{ forma: string | null }>(sql`
    select a.depois ->> 'forma_devolucao' as forma from auditoria a
     where a.entidade = 'vendas' and a.registro_id = ${vendaId} and a.acao = 'cancelar' and a.origem = 'erp'
     order by a.ocorrido_em desc, a.id desc
     limit 1`);
  const forma = rows[0]?.forma ?? null;
  return forma && (FORMAS_DEVOLUCAO_CANCELAMENTO as readonly string[]).includes(forma)
    ? (forma as FormaDevolucaoCancelamento)
    : null;
}
