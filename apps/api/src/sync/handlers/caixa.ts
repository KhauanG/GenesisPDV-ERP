/**
 * Handlers dos eventos de caixa (SYNC 9.3–9.6, 10.1; bloco C5 da 1C): abertura, reforço, sangria, cancelamento de
 * movimento e fechamento/troca de turno. Só gravam o que veio do caixa (`sessoes_caixa`, `movimentos_caixa`,
 * `fechamentos_caixa` e as formas); a parte financeira (transferência da sangria, consolidação por sessão, quebra e
 * sobra, SYNC 10.1 e 10.3 passos 2 a 4) é da Fase 4.
 *
 * Regras da 1C que corrigem a especificação (decisões técnicas, README da API):
 * - T11: a abertura depende da outra sessão aberta do mesmo terminal na nuvem (além da `sessao_anterior_id`). Se o
 *   fechamento dela está em `erro`/`retido`, a abertura fica `retido` (`DEPENDENCIA_PENDENTE`) e volta com o
 *   reprocessamento; `SESSAO_DUPLICADA` só quando nada daquela sessão está pendente (banco local perdido, SYNC 22.1);
 * - T12: `terminais.sessao_caixa_id` muda com condição: o fechamento só limpa onde ainda é a sessão fechada, e a
 *   abertura só grava sobre nulo, a própria sessão ou a anterior. O heartbeat grava o que o PDV informa e chega antes
 *   ou depois do push: sem a condição, o `caixa.fechado` tardio de A apagava a sessão B já informada;
 * - T16: abertura de terminal substituído (`desativando` com o caixa já de outro terminal) ou `revogado` (eventos
 *   tardios) entra já fechada à força, com o alerta da substituição: ninguém mais fecharia essa sessão. O
 *   `desativando` por aceitar pendências, que continua dono do caixa, abre normalmente: o fechamento do próprio caixa,
 *   a desativação confirmada (heartbeat) ou a revogação a fecham depois.
 *
 * A sessão fechada à força continua aceitando os eventos tardios do terminal antigo (MD 3.12.1): movimentos entram
 * nela e o `caixa.fechado` grava o fechamento normalmente, com `fechamento_forcado` (e o `fechada_em` da nuvem)
 * mantidos para a auditoria.
 */
import {
  MOVIMENTOS_CAIXA_CANCELAVEIS,
  payloadCaixaAbertoSchema,
  payloadCaixaFechadoSchema,
  payloadCaixaMovimentoCanceladoSchema,
  payloadCaixaReforcoSchema,
  payloadCaixaSangriaSchema,
  type MovimentoCaixa,
  type PayloadCaixaAberto,
  type PayloadCaixaFechado,
  type PayloadCaixaMovimentoCancelado,
  type PayloadCaixaReforco,
  type PayloadCaixaSangria,
} from '@genesis/shared';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  alertas,
  caixas,
  eventosRecebidos,
  fechamentosCaixa,
  fechamentosCaixaFormas,
  movimentosCaixa,
  sessoesCaixa,
  terminais,
} from '../../database/empresa/schema/index.js';
import type { DbEmpresa } from '../../tenancy/tenancy.js';
import type { TerminalDoEvento } from '../aplicacao.js';
import { ErroRegraEvento } from '../erros.js';
import { alertarSessaoFechada, type MotivoFechamentoForcado } from '../sessoes-caixa.js';
import {
  agregadoDivergente,
  colunasDivergentes,
  conferirEscopoLinha,
  eventoPendente,
  registrarAuditoriaPdv,
  type CatalogoHandlers,
  type ContextoHandler,
  type DependenciaEvento,
} from './comum.js';

/** SYNC 10.1: sangria acima do dinheiro que o próprio caixa estimava na gaveta (o PDV bloqueia, O5). */
export const ALERTA_SANGRIA_ACIMA_DO_ESTIMADO = 'SANGRIA_ACIMA_DO_ESTIMADO';
/** SYNC 10.1 e 9.6: o fechamento cita eventos do turno que a nuvem recebeu e ainda não aplicou (`erro`/`retido`). */
export const ALERTA_FECHAMENTO_EVENTOS_PENDENTES = 'FECHAMENTO_EVENTOS_PENDENTES';

/** Só sangria e reforço se cancelam pelo caixa (PDV 20.3; lista do contrato, que o PDV repete). */
const MOVIMENTOS_CANCELAVEIS: readonly string[] = MOVIMENTOS_CAIXA_CANCELAVEIS;

const dependenciaSessao = (id: string): DependenciaEvento => ({
  agregado_tipo: 'sessao_caixa',
  agregado_id: id,
});
const reais = (v: string) => `R$ ${v.replace('.', ',')}`;

type LinhaSessao = typeof sessoesCaixa.$inferSelect;

/** Linha de `movimentos_caixa` como o handler grava (os padrões da coluna aplicados, MD 3.12.2). */
export function valoresMovimento(m: MovimentoCaixa) {
  return {
    id: m.id,
    sessaoCaixaId: m.sessao_caixa_id,
    lojaId: m.loja_id,
    caixaId: m.caixa_id,
    numeroCaixa: m.numero_caixa,
    terminalId: m.terminal_id,
    tipo: m.tipo,
    formaPagamentoId: m.forma_pagamento_id ?? null,
    valor: m.valor,
    operadorId: m.operador_id,
    quemRetiraUsuarioId: m.quem_retira_usuario_id ?? null,
    quemRetiraNome: m.quem_retira_nome ?? null,
    observacao: m.observacao ?? null,
    infAdicionais: m.inf_adicionais ?? null,
    ocorridoEm: new Date(m.ocorrido_em),
    autorizadoPorId: m.autorizado_por_id ?? null,
    trocaId: m.troca_id ?? null,
    cancelado: false,
  };
}

/** Colunas que só o `caixa.movimento_cancelado` muda: fora da comparação do movimento que já existia. */
export const COLUNAS_CANCELAMENTO = [
  'cancelado',
  'canceladoEm',
  'canceladoPorId',
  'autorizadoCancelamentoPorId',
  'motivoCancelamento',
];

/**
 * Grava os movimentos que ainda não existem; o que já existe com o mesmo conteúdo fica como está (camada 2 da
 * idempotência, SYNC 8.4), com outro conteúdo → `AGREGADO_DIVERGENTE`. Devolve quantos foram gravados. Também os
 * `estorno_venda` da forma A do `venda.cancelada` (`handlers/cancelamento.ts`).
 */
export async function gravarMovimentos(
  tx: DbEmpresa,
  movimentos: readonly MovimentoCaixa[],
): Promise<number> {
  let gravados = 0;
  for (const m of movimentos) {
    const valores = valoresMovimento(m);
    const [gravado] = await tx.select().from(movimentosCaixa).where(eq(movimentosCaixa.id, m.id));
    if (gravado) {
      const divergentes = colunasDivergentes(gravado, valores, COLUNAS_CANCELAMENTO);
      if (divergentes.length) throw agregadoDivergente('movimentos_caixa', m.id, divergentes);
      continue;
    }
    await tx.insert(movimentosCaixa).values(valores);
    gravados++;
  }
  return gravados;
}

/**
 * A sessão do movimento/fechamento, travada para a atualização: tem de existir na nuvem e ser deste terminal. A
 * sessão com `caixa.aberto` em `erro`/`retido` já reteve o evento antes (dependência recalculada); aqui sobra a
 * sessão nunca recebida (SYNC 11.2 `SESSAO_INEXISTENTE`, ver lacuna 8.6).
 */
async function sessaoDoTerminal(
  tx: DbEmpresa,
  sessaoId: string,
  terminal: TerminalDoEvento,
): Promise<LinhaSessao> {
  const [sessao] = await tx.select().from(sessoesCaixa).where(eq(sessoesCaixa.id, sessaoId)).for('update');
  if (!sessao || sessao.excluidoEm) {
    throw new ErroRegraEvento('SESSAO_INEXISTENTE', 'Sessão de caixa nunca recebida pela nuvem.', {
      sessao_caixa_id: sessaoId,
    });
  }
  if (sessao.terminalId !== terminal.terminalId) {
    throw new ErroRegraEvento('ESCOPO_INVALIDO', 'Sessão de caixa de outro terminal.');
  }
  return sessao;
}

/** Outras sessões abertas do terminal na nuvem (no máximo uma, `uq_sessoes_caixa_aberta`). */
async function outrasSessoesAbertas(tx: DbEmpresa, terminalId: string, sessaoId: string) {
  return tx
    .select({ id: sessoesCaixa.id })
    .from(sessoesCaixa)
    .where(
      and(
        eq(sessoesCaixa.terminalId, terminalId),
        ne(sessoesCaixa.status, 'fechada'),
        isNull(sessoesCaixa.excluidoEm),
        ne(sessoesCaixa.id, sessaoId),
      ),
    );
}

/**
 * T16: motivo do fechamento forçado da sessão aberta por um terminal que já não está `ativo`, ou `null` quando ela
 * abre normalmente. Revogado → revogação; `desativando` cujo caixa passou a outro terminal → substituição. O `desativando`
 * por aceitar pendências continua dono do caixa e ainda envia o fechamento (MD 3.12.1): fechar aqui gerava o alerta
 * falso e a sessão marcada como forçada na conferência (ERP 14.9), com o `caixa.fechado` do operador logo atrás.
 */
async function fechamentoForcadoNaAbertura(
  tx: DbEmpresa,
  terminal: TerminalDoEvento,
  status: string,
): Promise<MotivoFechamentoForcado | null> {
  if (status === 'ativo') return null;
  if (status !== 'desativando') return 'revogacao_terminal';
  const [caixa] = await tx
    .select({ terminalId: caixas.terminalId })
    .from(caixas)
    .where(eq(caixas.id, terminal.caixaId));
  return caixa?.terminalId && caixa.terminalId !== terminal.terminalId ? 'substituicao_terminal' : null;
}

async function aplicarAbertura(ctx: ContextoHandler, p: PayloadCaixaAberto) {
  const { tx, terminal } = ctx;
  const s = p.sessoes_caixa;
  conferirEscopoLinha(s, terminal, 'sessoes_caixa');
  for (const m of p.movimentos_caixa) conferirEscopoLinha(m, terminal, 'movimentos_caixa');
  // A linha do terminal travada antes de ler o status: a revogação, a substituição e a desativação confirmada a gravam
  // antes de fechar as sessões abertas (`fecharSessoesDoTerminal`), então ou esta abertura vê o status novo (T16) ou
  // quem fecha espera o commit e fecha a sessão gravada aqui.
  const [t] = await tx
    .select({ status: terminais.status })
    .from(terminais)
    .where(eq(terminais.id, terminal.terminalId))
    .for('update');
  const valores = {
    id: s.id,
    lojaId: s.loja_id,
    caixaId: s.caixa_id,
    numeroCaixa: s.numero_caixa,
    terminalId: s.terminal_id,
    operadorId: s.operador_id,
    diaOperacional: s.dia_operacional,
    abertaEm: new Date(s.aberta_em),
    aberturaAutomatica: s.abertura_automatica ?? false,
    fundoTroco: s.fundo_troco ?? '0.00',
    sessaoAnteriorId: s.sessao_anterior_id ?? null,
    valorRecebidoAnterior: s.valor_recebido_anterior ?? null,
    diferencaRecebimento: s.diferenca_recebimento ?? null,
  };
  const [gravada] = await tx.select().from(sessoesCaixa).where(eq(sessoesCaixa.id, s.id));
  if (gravada) {
    // Status, `fechada_em` e o fechamento forçado mudam depois da abertura: ficam fora da comparação.
    const divergentes = colunasDivergentes(gravada, valores);
    if (divergentes.length) throw agregadoDivergente('sessoes_caixa', s.id, divergentes);
    await conferirMovimentosGravados(tx, s.id, 'abertura', p.movimentos_caixa);
    return { sessao_caixa_id: s.id, ja_existia: true };
  }
  const [outra] = await outrasSessoesAbertas(tx, terminal.terminalId, s.id);
  if (outra) {
    // A dependência recalculada (T11) já reteria o evento se o fechamento da outra estivesse pendente.
    throw new ErroRegraEvento('SESSAO_DUPLICADA', 'Já existe outra sessão aberta deste terminal na nuvem.', {
      sessao_aberta_id: outra.id,
    });
  }
  if (s.sessao_anterior_id) {
    // A anterior é a sessão que fechou com `troca_turno` neste mesmo terminal (SYNC 9.3; a de outro terminal do
    // mesmo caixa nunca volta ao terminal novo, MD 3.12.1): de outro terminal → `ESCOPO_INVALIDO`, como nos
    // movimentos. Aberta não chega aqui: seria a "outra sessão aberta" de cima (`SESSAO_DUPLICADA` ou retido).
    const [anterior] = await tx
      .select({ terminalId: sessoesCaixa.terminalId, excluidoEm: sessoesCaixa.excluidoEm })
      .from(sessoesCaixa)
      .where(eq(sessoesCaixa.id, s.sessao_anterior_id));
    if (!anterior || anterior.excluidoEm) {
      throw new ErroRegraEvento('SESSAO_INEXISTENTE', 'Sessão anterior da troca de turno nunca recebida.', {
        sessao_anterior_id: s.sessao_anterior_id,
      });
    }
    if (anterior.terminalId !== terminal.terminalId) {
      throw new ErroRegraEvento('ESCOPO_INVALIDO', 'Sessão anterior da troca de turno de outro terminal.', {
        sessao_anterior_id: s.sessao_anterior_id,
      });
    }
  }
  const forcado = t ? await fechamentoForcadoNaAbertura(tx, terminal, t.status) : null;
  await tx.insert(sessoesCaixa).values({
    ...valores,
    ...(forcado
      ? {
          status: 'fechada',
          fechadaEm: new Date(),
          fechamentoForcado: true,
          fechamentoForcadoMotivo: forcado,
        }
      : { status: 'aberta' }),
  });
  await gravarMovimentos(tx, p.movimentos_caixa);
  if (s.sessao_anterior_id) {
    // SYNC 9.3: o "Usuário Subsequente" do turno anterior é quem abriu este. Só uma vez: depois de uma perda do banco
    // local (SYNC 22.1) outra abertura pode citar a mesma anterior, e a primeira, que continuou o turno, prevalece.
    await tx
      .update(fechamentosCaixa)
      .set({ usuarioSubsequenteId: s.operador_id })
      .where(
        and(
          eq(fechamentosCaixa.sessaoCaixaId, s.sessao_anterior_id),
          eq(fechamentosCaixa.terminalId, terminal.terminalId),
          isNull(fechamentosCaixa.usuarioSubsequenteId),
        ),
      );
  }
  if (forcado) {
    await alertarSessaoFechada(
      tx,
      { id: s.id, lojaId: terminal.lojaId, numeroCaixa: terminal.numeroCaixa },
      forcado,
      { aberta_depois_da_saida: true, terminal_status: t!.status },
    );
  } else {
    // T12: só sobre nulo, a própria sessão (o heartbeat já a informou) ou a anterior (troca de turno).
    await tx
      .update(terminais)
      .set({ sessaoCaixaId: s.id, operadorId: s.operador_id })
      .where(
        and(
          eq(terminais.id, terminal.terminalId),
          sql`(${terminais.sessaoCaixaId} is null or ${terminais.sessaoCaixaId} = ${s.id}
               or ${terminais.sessaoCaixaId} = ${s.sessao_anterior_id ?? s.id})`,
        ),
      );
  }
  await registrarAuditoriaPdv(ctx, {
    entidade: 'sessoes_caixa',
    registroId: s.id,
    acao: 'criar',
    localizacao: 'PDV › Abertura de caixa',
    descricao:
      `Caixa ${String(terminal.numeroCaixa).padStart(2, '0')} aberto com fundo de troco ${reais(valores.fundoTroco)}` +
      (s.sessao_anterior_id ? ' (troca de turno)' : '') +
      (forcado ? '; sessão fechada pela nuvem: terminal fora de uso' : ''),
    usuarioId: s.operador_id,
    ocorridoEm: valores.abertaEm,
    // A contagem do "F2 Contar cédulas" fica aqui (o registro `caixa_contagem_cedulas` da PDV 8.2), não no movimento.
    depois: {
      fundo_troco: valores.fundoTroco,
      abertura_automatica: valores.aberturaAutomatica,
      sessao_anterior_id: valores.sessaoAnteriorId,
      diferenca_recebimento: valores.diferencaRecebimento,
      contagem_cedulas: p.contagem_cedulas ?? null,
    },
  });
  return { sessao_caixa_id: s.id, ...(forcado ? { fechamento_forcado: forcado } : {}) };
}

async function aplicarMovimento(ctx: ContextoHandler, p: PayloadCaixaReforco | PayloadCaixaSangria) {
  const { tx, terminal } = ctx;
  const m = p.movimentos_caixa;
  conferirEscopoLinha(m, terminal, 'movimentos_caixa');
  const sessao = await sessaoDoTerminal(tx, m.sessao_caixa_id, terminal);
  const gravados = await gravarMovimentos(tx, [m]);
  if (!gravados) return { movimento_caixa_id: m.id, ja_existia: true };
  const estimado = p.dinheiro_estimado_antes ?? null;
  const acimaDoEstimado = m.tipo === 'sangria' && estimado !== null && Number(m.valor) > Number(estimado);
  if (acimaDoEstimado) {
    await tx
      .insert(alertas)
      .values({
        tipo: ALERTA_SANGRIA_ACIMA_DO_ESTIMADO,
        severidade: 'aviso',
        titulo: `Sangria de ${reais(m.valor)} acima do estimado na gaveta do caixa ${String(terminal.numeroCaixa).padStart(2, '0')}`,
        mensagem: `O caixa estimava ${reais(estimado)} em dinheiro na gaveta antes da sangria. Confira o movimento.`,
        lojaId: terminal.lojaId,
        entidade: 'movimentos_caixa',
        registroId: m.id,
        dados: { valor: m.valor, dinheiro_estimado_antes: estimado, sessao_caixa_id: m.sessao_caixa_id },
        chaveDeduplicacao: `sangria_estimado:${m.id}`,
      })
      .onConflictDoNothing();
  }
  const nome = m.tipo === 'sangria' ? 'Sangria' : 'Reforço';
  await registrarAuditoriaPdv(ctx, {
    entidade: 'movimentos_caixa',
    registroId: m.id,
    acao: 'movimentar',
    localizacao: `PDV › ${nome}`,
    descricao: `${nome} de ${reais(m.valor)} no caixa ${String(terminal.numeroCaixa).padStart(2, '0')}`,
    usuarioId: m.operador_id,
    autorizadoPorId: m.autorizado_por_id ?? null,
    ocorridoEm: new Date(m.ocorrido_em),
    depois: {
      tipo: m.tipo,
      valor: m.valor,
      quem_retira_usuario_id: m.quem_retira_usuario_id ?? null,
      quem_retira_nome: m.quem_retira_nome ?? null,
      dinheiro_estimado_antes: estimado,
      contagem_cedulas: p.contagem_cedulas ?? null,
    },
  });
  return {
    movimento_caixa_id: m.id,
    ...(sessao.status === 'fechada' ? { sessao_fechada: true } : {}),
    ...(acimaDoEstimado ? { alerta: ALERTA_SANGRIA_ACIMA_DO_ESTIMADO } : {}),
  };
}

async function aplicarCancelamentoMovimento(ctx: ContextoHandler, p: PayloadCaixaMovimentoCancelado) {
  const { tx, terminal } = ctx;
  const c = p.movimentos_caixa;
  const [mov] = await tx.select().from(movimentosCaixa).where(eq(movimentosCaixa.id, c.id)).for('update');
  if (!mov) {
    throw new ErroRegraEvento(
      'TRANSICAO_INVALIDA',
      'Cancelamento de movimento de caixa que a nuvem não recebeu.',
      {
        movimento_caixa_id: c.id,
      },
    );
  }
  if (mov.terminalId !== terminal.terminalId) {
    throw new ErroRegraEvento('ESCOPO_INVALIDO', 'Movimento de caixa de outro terminal.');
  }
  if (!MOVIMENTOS_CANCELAVEIS.includes(mov.tipo)) {
    throw new ErroRegraEvento('TRANSICAO_INVALIDA', `Movimento ${mov.tipo} não se cancela pelo caixa.`, {
      tipo: mov.tipo,
    });
  }
  const valores = {
    cancelado: true,
    canceladoEm: new Date(c.cancelado_em),
    canceladoPorId: c.cancelado_por_id,
    autorizadoCancelamentoPorId: c.autorizado_cancelamento_por_id ?? null,
    motivoCancelamento: c.motivo_cancelamento,
  };
  if (mov.cancelado) {
    // SYNC 9.5: o mesmo cancelamento de novo não tem efeito; outro cancelamento do mesmo movimento é divergência.
    const divergentes = colunasDivergentes(mov, valores);
    if (divergentes.length) throw agregadoDivergente('movimentos_caixa', c.id, divergentes);
    return { movimento_caixa_id: c.id, ja_existia: true };
  }
  await tx.update(movimentosCaixa).set(valores).where(eq(movimentosCaixa.id, c.id));
  const nome = mov.tipo === 'sangria' ? 'Sangria' : 'Reforço';
  await registrarAuditoriaPdv(ctx, {
    entidade: 'movimentos_caixa',
    registroId: c.id,
    acao: 'cancelar',
    localizacao: 'PDV › Movimentos de caixa',
    descricao: `${nome} de ${reais(mov.valor)} cancelado(a): ${c.motivo_cancelamento}`,
    usuarioId: c.cancelado_por_id,
    autorizadoPorId: c.autorizado_cancelamento_por_id ?? null,
    ocorridoEm: valores.canceladoEm,
    antes: { cancelado: false },
    depois: { cancelado: true, motivo_cancelamento: c.motivo_cancelamento },
  });
  return { movimento_caixa_id: c.id };
}

/** Linha de `fechamentos_caixa_formas` como o handler grava (os padrões da coluna aplicados, MD 3.12.3). */
function valoresForma(x: PayloadCaixaFechado['fechamentos_caixa_formas'][number]) {
  return {
    id: x.id,
    fechamentoId: x.fechamento_id,
    formaPagamentoId: x.forma_pagamento_id,
    descricaoForma: x.descricao_forma,
    tipoForma: x.tipo_forma,
    valorCalculado: x.valor_calculado,
    valorDigitado: x.valor_digitado,
    quantidadePagamentos: x.quantidade_pagamentos ?? 0,
    preenchidoAutomatico: x.preenchido_automatico ?? false,
    valorPrimeiraContagem: x.valor_primeira_contagem ?? null,
  };
}

/** As formas do fechamento que já existe: as mesmas linhas (pelo `id`), com o mesmo conteúdo. */
async function conferirFormasGravadas(
  tx: DbEmpresa,
  fechamentoId: string,
  formas: ReadonlyArray<ReturnType<typeof valoresForma>>,
): Promise<void> {
  const gravadas = await tx
    .select()
    .from(fechamentosCaixaFormas)
    .where(eq(fechamentosCaixaFormas.fechamentoId, fechamentoId));
  const porId = new Map(gravadas.map((g) => [g.id, g]));
  for (const forma of formas) {
    const gravada = porId.get(forma.id);
    const divergentes = gravada ? colunasDivergentes(gravada, forma) : ['id'];
    if (divergentes.length) throw agregadoDivergente('fechamentos_caixa_formas', forma.id, divergentes);
  }
  // Forma gravada que o evento novo não traz: a contagem é outra.
  const sobra = gravadas.find((g) => !formas.some((x) => x.id === g.id));
  if (sobra) throw agregadoDivergente('fechamentos_caixa_formas', sobra.id, ['id']);
}

/**
 * Os movimentos de um tipo que vieram junto com a sessão ou o fechamento que já existe (o de `abertura` do
 * `caixa.aberto`, a `sangria_fechamento` do `caixa.fechado`): as mesmas linhas, com o mesmo conteúdo. Não grava nada:
 * um `gravarMovimentos` aqui inseriria o movimento de id novo como um segundo fundo ou uma segunda sangria.
 */
async function conferirMovimentosGravados(
  tx: DbEmpresa,
  sessaoId: string,
  tipo: 'abertura' | 'sangria_fechamento',
  movimentos: readonly MovimentoCaixa[],
): Promise<void> {
  const gravados = await tx
    .select()
    .from(movimentosCaixa)
    .where(and(eq(movimentosCaixa.sessaoCaixaId, sessaoId), eq(movimentosCaixa.tipo, tipo)));
  const porId = new Map(gravados.map((g) => [g.id, g]));
  for (const m of movimentos) {
    const gravado = porId.get(m.id);
    const divergentes = gravado
      ? colunasDivergentes(gravado, valoresMovimento(m), COLUNAS_CANCELAMENTO)
      : ['id'];
    if (divergentes.length) throw agregadoDivergente('movimentos_caixa', m.id, divergentes);
  }
  const sobra = gravados.find((g) => !movimentos.some((m) => m.id === g.id));
  if (sobra) throw agregadoDivergente('movimentos_caixa', sobra.id, ['id']);
}

/**
 * SYNC 9.6: sequências dos eventos do turno que o fechamento cita e que a nuvem ainda não aplicou. A ordem estrita
 * por terminal (8.2) garante que tudo até a sequência citada já chegou; o que pode faltar é aplicar: evento em `erro`
 * ou `retido` (`eventoPendente`) entre a abertura da sessão e a sequência citada. O próprio fechamento não conta
 * (reprocessado, ele está em `erro`).
 */
async function eventosPendentesDoTurno(
  tx: DbEmpresa,
  terminalId: string,
  sessaoId: string,
  citada: number,
  eventoId: string,
): Promise<number[]> {
  const [abertura] = await tx
    .select({ sequencia: sql<number>`min(${eventosRecebidos.sequenciaTerminal})::int` })
    .from(eventosRecebidos)
    .where(
      and(
        eq(eventosRecebidos.terminalId, terminalId),
        eq(eventosRecebidos.tipo, 'caixa.aberto'),
        eq(eventosRecebidos.agregadoId, sessaoId),
      ),
    );
  const desde = abertura?.sequencia ?? 1;
  const linhas = await tx
    .select({ sequencia: eventosRecebidos.sequenciaTerminal })
    .from(eventosRecebidos)
    .where(
      and(
        eq(eventosRecebidos.terminalId, terminalId),
        ne(eventosRecebidos.eventoId, eventoId),
        sql`${eventosRecebidos.sequenciaTerminal} between ${desde} and ${citada}`,
        eventoPendente(),
      ),
    )
    .orderBy(eventosRecebidos.sequenciaTerminal);
  return linhas.map((l) => Number(l.sequencia));
}

async function aplicarFechamento(ctx: ContextoHandler, p: PayloadCaixaFechado) {
  const { tx, terminal } = ctx;
  const f = p.fechamentos_caixa;
  conferirEscopoLinha(f, terminal, 'fechamentos_caixa');
  for (const m of p.movimentos_caixa) conferirEscopoLinha(m, terminal, 'movimentos_caixa');
  const sessao = await sessaoDoTerminal(tx, p.sessoes_caixa.id, terminal);
  const valores = {
    id: f.id,
    sessaoCaixaId: f.sessao_caixa_id,
    lojaId: f.loja_id,
    caixaId: f.caixa_id,
    terminalId: f.terminal_id,
    numeroCaixa: f.numero_caixa,
    tipo: f.tipo,
    zeraCaixa: f.zera_caixa,
    usuarioAnteriorId: f.usuario_anterior_id,
    usuarioSubsequenteId: f.usuario_subsequente_id ?? null,
    valorCaixa: f.valor_caixa ?? '0.00',
    totalCalculado: f.total_calculado,
    totalDigitado: f.total_digitado,
    justificativa: f.justificativa ?? null,
    recontagem: f.recontagem ?? false,
    fechamentoCego: f.fechamento_cego,
    ocorridoEm: new Date(f.ocorrido_em),
    diaOperacional: f.dia_operacional,
    resumo: f.resumo as Record<string, unknown>,
  };
  const formas = p.fechamentos_caixa_formas.map(valoresForma);
  const [gravado] = await tx
    .select()
    .from(fechamentosCaixa)
    .where(eq(fechamentosCaixa.sessaoCaixaId, sessao.id));
  if (gravado) {
    // SYNC 9.6: outro fechamento para a mesma sessão → `AGREGADO_DIVERGENTE` (PDV 21.5). O subsequente é da nuvem.
    const divergentes =
      gravado.id === f.id ? colunasDivergentes(gravado, valores, ['usuarioSubsequenteId']) : ['id'];
    if (divergentes.length) throw agregadoDivergente('fechamentos_caixa', f.id, divergentes);
    // O mesmo fechamento também traz as mesmas formas e a mesma `sangria_fechamento` (camada 2, SYNC 8.4): a
    // contagem repartida de outro jeito com o mesmo total não passa como `ja_existia`.
    await conferirFormasGravadas(tx, f.id, formas);
    await conferirMovimentosGravados(tx, sessao.id, 'sangria_fechamento', p.movimentos_caixa);
    return { sessao_caixa_id: sessao.id, fechamento_caixa_id: f.id, ja_existia: true };
  }
  // `diferenca` é gerada: fica fora do insert (o PostgreSQL recusa com 428C9, MD 3.12.3).
  await tx.insert(fechamentosCaixa).values(valores);
  if (formas.length) await tx.insert(fechamentosCaixaFormas).values(formas);
  await gravarMovimentos(tx, p.movimentos_caixa);
  // A sessão fechada à força (substituição/revogação) mantém o `fechada_em` e o `fechamento_forcado` da nuvem.
  if (sessao.status !== 'fechada') {
    await tx
      .update(sessoesCaixa)
      .set({ status: 'fechada', fechadaEm: new Date(p.sessoes_caixa.fechada_em) })
      .where(eq(sessoesCaixa.id, sessao.id));
  }
  // T12: só onde o campo ainda é esta sessão (o heartbeat pode já ter informado a seguinte).
  await tx
    .update(terminais)
    .set({ sessaoCaixaId: null })
    .where(and(eq(terminais.id, terminal.terminalId), eq(terminais.sessaoCaixaId, sessao.id)));
  const caixa = String(terminal.numeroCaixa).padStart(2, '0');
  const citada = f.resumo.ultima_sequencia_evento;
  const pendentes = await eventosPendentesDoTurno(
    tx,
    terminal.terminalId,
    sessao.id,
    citada,
    ctx.evento.evento_id,
  );
  if (pendentes.length) {
    const lista = pendentes.join(', ');
    await tx
      .insert(alertas)
      .values({
        tipo: ALERTA_FECHAMENTO_EVENTOS_PENDENTES,
        severidade: 'aviso',
        titulo: `Fechamento do caixa ${caixa} recebido com ${pendentes.length} evento(s) do turno ainda pendente(s)`,
        mensagem:
          `O fechamento cita os eventos até a sequência ${citada}, e os de sequência ${lista} estão em erro ou ` +
          'retidos na nuvem. Resolva-os nos eventos com erro do terminal antes de conferir o caixa.',
        lojaId: terminal.lojaId,
        entidade: 'fechamentos_caixa',
        registroId: f.id,
        dados: {
          ultima_sequencia_evento: citada,
          sequencias_pendentes: pendentes,
          sessao_caixa_id: sessao.id,
        },
        chaveDeduplicacao: `fechamento_pendentes:${f.id}`,
      })
      .onConflictDoNothing();
  }
  await registrarAuditoriaPdv(ctx, {
    entidade: 'fechamentos_caixa',
    registroId: f.id,
    acao: 'criar',
    localizacao: f.tipo === 'troca_turno' ? 'PDV › Troca de turno' : 'PDV › Fechamento de caixa',
    descricao:
      `${f.tipo === 'troca_turno' ? 'Troca de turno' : 'Fechamento'} do caixa ${caixa}` +
      (sessao.fechamentoForcado ? ' (sessão já fechada pela nuvem)' : ''),
    // Quem contou e confirmou (o `usuario_id` do envelope): na troca de turno pedida pelo próximo operador (PDV 8.1) é
    // ele, não o dono da sessão, que fica em `usuario_anterior_id`.
    usuarioId: ctx.evento.usuario_id ?? f.usuario_anterior_id,
    ocorridoEm: valores.ocorridoEm,
    depois: {
      sessao_caixa_id: sessao.id,
      tipo: f.tipo,
      usuario_anterior_id: f.usuario_anterior_id,
      total_calculado: f.total_calculado,
      total_digitado: f.total_digitado,
      valor_caixa: valores.valorCaixa,
      formas: p.fechamentos_caixa_formas.length,
    },
  });
  return {
    sessao_caixa_id: sessao.id,
    fechamento_caixa_id: f.id,
    ...(sessao.fechamentoForcado ? { sessao_fechada_a_forca: true } : {}),
    ...(pendentes.length ? { eventos_pendentes: pendentes.length } : {}),
  };
}

const entidadesMovimentos = (movimentos: ReadonlyArray<{ id: string }>) =>
  movimentos.map((m) => ({ tipo: 'movimentos_caixa', id: m.id }));

export const HANDLERS_CAIXA: CatalogoHandlers = {
  'caixa.aberto': {
    1: {
      schema: payloadCaixaAbertoSchema,
      entidades: (p) => {
        const a = p as PayloadCaixaAberto;
        return [
          { tipo: 'sessoes_caixa', id: a.sessoes_caixa.id },
          ...entidadesMovimentos(a.movimentos_caixa),
        ];
      },
      // SYNC 8.5 (sessão anterior da troca de turno) e T11 (a outra sessão aberta do terminal na nuvem).
      async dependencias({ tx, terminal }, p: PayloadCaixaAberto) {
        const s = p.sessoes_caixa;
        const outras = await outrasSessoesAbertas(tx, terminal.terminalId, s.id);
        return [
          ...(s.sessao_anterior_id ? [dependenciaSessao(s.sessao_anterior_id)] : []),
          ...outras.map((o) => dependenciaSessao(o.id)),
        ];
      },
      aplicar: aplicarAbertura,
    },
  },
  'caixa.reforco': {
    1: {
      schema: payloadCaixaReforcoSchema,
      entidades: (p) => entidadesMovimentos([(p as PayloadCaixaReforco).movimentos_caixa]),
      dependencias: async (_ctx, p: PayloadCaixaReforco) => [
        dependenciaSessao(p.movimentos_caixa.sessao_caixa_id),
      ],
      aplicar: aplicarMovimento,
    },
  },
  'caixa.sangria': {
    1: {
      schema: payloadCaixaSangriaSchema,
      entidades: (p) => entidadesMovimentos([(p as PayloadCaixaSangria).movimentos_caixa]),
      dependencias: async (_ctx, p: PayloadCaixaSangria) => [
        dependenciaSessao(p.movimentos_caixa.sessao_caixa_id),
      ],
      aplicar: aplicarMovimento,
    },
  },
  'caixa.movimento_cancelado': {
    1: {
      schema: payloadCaixaMovimentoCanceladoSchema,
      dependencias: async (_ctx, p: PayloadCaixaMovimentoCancelado) => [
        { agregado_tipo: 'movimento_caixa', agregado_id: p.movimentos_caixa.id },
      ],
      aplicar: aplicarCancelamentoMovimento,
    },
  },
  'caixa.fechado': {
    1: {
      schema: payloadCaixaFechadoSchema,
      entidades: (p) => entidadesMovimentos((p as PayloadCaixaFechado).movimentos_caixa),
      dependencias: async (_ctx, p: PayloadCaixaFechado) => [dependenciaSessao(p.sessoes_caixa.id)],
      aplicar: aplicarFechamento,
    },
  },
};
