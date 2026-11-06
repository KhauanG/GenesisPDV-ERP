/**
 * Lado da empresa da revogação e da desativação de terminais (SYNC 3.8, 4.3 item 6; ERP 12.4). A ordem é
 * controle → empresa: o controle (`terminais_pdv`) decide a autenticação (401 ou `desativando`) e é gravado
 * primeiro; aqui o banco da empresa (`terminais`, `caixas`, auditoria, PINs no modo perdido, alerta da D20) alcança o
 * mesmo estado. Tudo é idempotente: o ERP, a manutenção periódica e a etapa da empresa da ativação (anteriores do
 * caixa) chamam a mesma função, e o que já está no estado certo não muda nem gera auditoria de novo. A exceção é a
 * desativação confirmada do heartbeat: quem decide é o banco da empresa (eventos recebidos até a última sequência),
 * então ela grava a empresa primeiro (`confirmarDesativacao` em `sync/heartbeat.ts`, com a própria auditoria) e o
 * controle depois do commit; se o controle falhar, o próximo heartbeat repete.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import type { terminaisPdv } from '../database/controle/schema.js';
import { auditoria } from '../database/empresa/auditoria.js';
import { alertas, caixas, eventosRecebidos, terminais } from '../database/empresa/schema/index.js';
import { pessoaRelevante, senhaClienteDesce } from '../sync/fluxos.js';
import { resolverAlertaDesvioRelogio } from '../sync/relogio.js';
import { fecharSessoesDoTerminal } from '../sync/sessoes-caixa.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** D20: terminal que sai do caixa (revogado, substituído, desativado) com eventos em `erro`/`retido`. */
export const ALERTA_EVENTOS_NAO_RESOLVIDOS = 'TERMINAL_DESATIVADO_COM_EVENTOS';
/** SYNC 3.1: 20 falhas de ativação em 1 h para o código da empresa. */
export const ALERTA_FORCA_BRUTA = 'ATIVACAO_FORCA_BRUTA';

/** `terminais_pdv.motivo_revogacao` gravado por cada caminho (o modo perdido também anula os PINs). */
export const MOTIVOS_REVOGACAO = {
  aceitar_pendencias: 'aceitar_pendencias',
  imediato: 'revogado_imediato',
  perdido: 'perdido_roubado',
  carencia: 'carencia_vencida',
  confirmada: 'desativacao_confirmada',
  /** Compensação da ativação que não concluiu (SYNC 3.4): o terminal nunca recebeu dados. */
  falhaAtivacao: 'falha_ativacao',
} as const;

type TerminalControle = typeof terminaisPdv.$inferSelect;

const DESCRICOES: Record<string, string> = {
  [MOTIVOS_REVOGACAO.imediato]: 'Terminal revogado imediatamente',
  [MOTIVOS_REVOGACAO.perdido]: 'Terminal revogado como perdido/roubado (PINs e senhas de cliente anulados)',
  [MOTIVOS_REVOGACAO.carencia]: 'Terminal revogado ao fim da carência sem confirmar a desativação',
  [MOTIVOS_REVOGACAO.confirmada]: 'Terminal desativado com confirmação',
  escalada_perdido: 'Terminal já revogado marcado como perdido/roubado (PINs e senhas de cliente anulados)',
};

const numeroCaixa = (n: number) => String(n).padStart(2, '0');

/**
 * D20 (decisão do dono, 30/10/2026): a série e a numeração passam ao substituto na hora, mas os eventos em `erro`
 * ou `retido` do terminal que saiu precisam de alguém: alerta crítico no ERP (um por terminal enquanto aberto).
 * A manutenção periódica resolve o alerta quando os eventos deixam de estar pendentes (fila de decisão, 1C).
 */
export async function alertarEventosNaoResolvidos(
  tx: DbEmpresa,
  t: { id: string; lojaId: string; numeroCaixa: number },
  motivo: string,
): Promise<boolean> {
  const contagem = await tx
    .select({ status: eventosRecebidos.status, n: sql<number>`count(*)::int` })
    .from(eventosRecebidos)
    .where(and(eq(eventosRecebidos.terminalId, t.id), inArray(eventosRecebidos.status, ['erro', 'retido'])))
    .groupBy(eventosRecebidos.status);
  const erro = contagem.find((c) => c.status === 'erro')?.n ?? 0;
  const retidos = contagem.find((c) => c.status === 'retido')?.n ?? 0;
  if (erro + retidos === 0) return false;
  await tx
    .insert(alertas)
    .values({
      tipo: ALERTA_EVENTOS_NAO_RESOLVIDOS,
      severidade: 'critico',
      titulo: `Terminal do caixa ${numeroCaixa(t.numeroCaixa)} saiu com ${erro + retidos} evento(s) sem resolver`,
      mensagem:
        `${motivo}. A série e a numeração já passaram ao próximo terminal do caixa; resolva os eventos ` +
        `(${erro} com erro, ${retidos} retido(s)) na aba "Eventos com erro" do terminal.`,
      lojaId: t.lojaId,
      entidade: 'terminais',
      registroId: t.id,
      dados: { erro, retidos, motivo },
      chaveDeduplicacao: `terminal_eventos:${t.id}`,
    })
    .onConflictDoNothing();
  return true;
}

/** Caixa livre de novo (o caixa revogado vira o "anterior" da SYNC 13.3), sem mexer num caixa já ocupado por outro. */
export async function liberarCaixa(tx: DbEmpresa, terminalId: string, caixaId: string): Promise<void> {
  await tx
    .update(caixas)
    .set({ terminalAnteriorId: terminalId, terminalId: null })
    .where(and(eq(caixas.id, caixaId), eq(caixas.terminalId, terminalId)));
}

export interface ResultadoEstadoEmpresa {
  /** O banco da empresa mudou (falso quando já estava no estado do controle ou o terminal nunca chegou nele). */
  alterado: boolean;
  pinsAnulados: number;
  senhasClienteAnuladas: number;
  alertaEventos: boolean;
}

/**
 * Auditorias `terminal_revogado` já gravadas para o terminal: a da revogação definitiva (`depois.status = revogado`)
 * e a do modo perdido (`depois.motivo = perdido_roubado`, a que anulou as credenciais). É por elas, e não só pelo
 * status, que a função sabe o que falta: o terminal pode chegar a `revogado` na empresa por um caminho que não anula
 * nada (ex.: o furto descoberto depois de uma revogação imediata).
 */
async function revogacoesAuditadas(tx: DbEmpresa, terminalId: string) {
  const linhas = await tx
    .select({
      status: sql<string | null>`${auditoria.depois} ->> 'status'`,
      motivo: sql<string | null>`${auditoria.depois} ->> 'motivo'`,
    })
    .from(auditoria)
    .where(
      and(
        eq(auditoria.entidade, 'terminais'),
        eq(auditoria.registroId, terminalId),
        eq(auditoria.acao, 'terminal_revogado'),
      ),
    );
  return {
    revogado: linhas.some((l) => l.status === 'revogado'),
    perdido: linhas.some((l) => l.motivo === MOTIVOS_REVOGACAO.perdido),
  };
}

/**
 * Leva `terminais` (e `caixas`) ao estado que o controle gravou: `desativando` ou `revogado`. No `perdido_roubado`,
 * na mesma transação, anula `usuarios.senha_pdv_hash` de quem tem acesso à loja e `pessoas.senha_hash` das pessoas
 * cuja senha desce para ela (SYNC 4.3 item 6), com auditoria por registro; o `fn_versao` faz o `null` descer nos
 * fluxos `acesso` e `pessoas` dos outros terminais. Todo destino `revogado` grava `caixas` (fluxo, `fn_versao`):
 * a transação precisa de `travaVersao` (MD 1.5).
 *
 * O destino `revogado` também fecha à força a sessão de caixa aberta do terminal (MD 3.12.1, `fechamento_forcado`,
 * alerta `SESSAO_FECHADA_POR_SUBSTITUICAO`); o `desativando` não, porque o caixa ainda envia o fechamento.
 *
 * Já `revogado` na empresa, só completa o que a auditoria mostra que faltou: a revogação sem auditoria (o terminal
 * saiu de `ativo` por outro caminho) e a anulação do modo perdido, que também vale por cima de uma revogação com
 * outro motivo (o furto descoberto depois).
 */
export async function aplicarEstadoNaEmpresa(
  tx: DbEmpresa,
  servicoAuditoria: AuditoriaService,
  t: TerminalControle,
  origem: OrigemAcao,
  opcoes: { observacao?: string | null; localizacao?: string } = {},
): Promise<ResultadoEstadoEmpresa> {
  const resultado: ResultadoEstadoEmpresa = {
    alterado: false,
    pinsAnulados: 0,
    senhasClienteAnuladas: 0,
    alertaEventos: false,
  };
  if (t.status !== 'desativando' && t.status !== 'revogado') return resultado;
  // `desativando` por uma substituição (o novo ainda `provisionando`) é da etapa da empresa da ativação e da
  // compensação: aqui ele não tem alerta da D20 e a compensação devolveria o antigo a `ativo` só no controle.
  if (t.status === 'desativando' && t.substituidoPorTerminalId) return resultado;
  const [atual] = await tx.select().from(terminais).where(eq(terminais.id, t.id)).for('update');
  // Nunca chegou ao banco da empresa (falha da ativação compensada): nada a alcançar.
  if (!atual) return resultado;
  // `desativando` só sai de `ativo`; do `revogado` não se volta.
  if (t.status === 'desativando' && atual.status !== 'ativo') return resultado;
  const localizacao = opcoes.localizacao ?? 'PDVs/Terminais › Revogar';
  const origemLoja = { ...origem, lojaId: t.lojaId };
  const nota = opcoes.observacao ? ` — ${opcoes.observacao}` : '';
  if (t.status === 'desativando') {
    await tx.update(terminais).set({ status: 'desativando' }).where(eq(terminais.id, t.id));
    await servicoAuditoria.registrar(tx, origemLoja, {
      acao: 'terminal_revogado',
      entidade: 'terminais',
      registroId: t.id,
      localizacao,
      descricao:
        `Revogação com pendências aceitas: o caixa ${numeroCaixa(t.numeroCaixa)} envia o que falta e se desativa` +
        `${t.carenciaAte ? ` (carência até ${t.carenciaAte.toISOString()})` : ''}${nota}`,
      antes: { status: atual.status },
      depois: { status: 'desativando', carencia_ate: t.carenciaAte?.toISOString() ?? null },
    });
    resultado.alterado = true;
    return resultado;
  }
  const perdido = t.motivoRevogacao === MOTIVOS_REVOGACAO.perdido;
  const feitas =
    atual.status === 'revogado' ? await revogacoesAuditadas(tx, t.id) : { revogado: false, perdido: false };
  if (feitas.revogado && (!perdido || feitas.perdido)) return resultado;
  // Já revogado e auditado por outro motivo: o modo perdido só acrescenta a anulação das credenciais.
  const escalada = feitas.revogado;
  // Revogado na empresa sem auditoria (ex.: a desativação confirmada, que já gravou o próprio motivo): o motivo
  // de lá prevalece, a não ser o perdido, que precisa ficar registrado.
  const motivo =
    atual.status === 'revogado' && !perdido
      ? (atual.motivoRevogacao ?? t.motivoRevogacao)
      : t.motivoRevogacao;
  if (atual.status !== 'revogado') {
    await tx
      .update(terminais)
      .set({
        status: 'revogado',
        revogadoEm: t.revogadoEm ?? new Date(),
        revogadoPorId: t.revogadoPorUsuarioId,
        motivoRevogacao: motivo,
      })
      .where(eq(terminais.id, t.id));
  } else if (atual.motivoRevogacao !== motivo) {
    await tx.update(terminais).set({ motivoRevogacao: motivo }).where(eq(terminais.id, t.id));
  }
  await liberarCaixa(tx, t.id, t.caixaId);
  // MD 3.12.1: o turno aberto do terminal revogado fecha na mesma transação (o `terminais` acima já foi gravado: a
  // abertura que o push aplica ao mesmo tempo espera a linha e entra fechada, T16).
  await fecharSessoesDoTerminal(tx, t.id, 'revogacao_terminal');
  // Sem heartbeat depois disto, o desvio do relógio (C16) nunca voltaria ao normal: fecha com a revogação.
  await resolverAlertaDesvioRelogio(tx, t.id, 'Terminal revogado');
  if (perdido) Object.assign(resultado, await anularCredenciaisDaLoja(tx, servicoAuditoria, t, origemLoja));
  const descricao = escalada
    ? DESCRICOES.escalada_perdido!
    : (DESCRICOES[motivo ?? ''] ?? 'Terminal revogado');
  await servicoAuditoria.registrar(tx, origemLoja, {
    acao: 'terminal_revogado',
    entidade: 'terminais',
    registroId: t.id,
    localizacao,
    descricao: `${descricao} (caixa ${numeroCaixa(t.numeroCaixa)})${nota}`,
    antes: { status: atual.status, ...(escalada ? { motivo: atual.motivoRevogacao } : {}) },
    depois: {
      status: 'revogado',
      motivo,
      ...(perdido
        ? { pins_anulados: resultado.pinsAnulados, senhas_cliente_anuladas: resultado.senhasClienteAnuladas }
        : {}),
    },
  });
  resultado.alertaEventos = await alertarEventosNaoResolvidos(
    tx,
    t,
    DESCRICOES[motivo ?? ''] ?? 'Terminal revogado',
  );
  resultado.alterado = true;
  return resultado;
}

/**
 * SYNC 4.3 item 6 e ERP 12.4: PIN de quem acessa a loja e a senha de cliente das pessoas cuja senha desce para ela,
 * pela mesma condição da projeção do fluxo `pessoas` (relevante para a loja, exigência de senha ligada na loja,
 * crediário com limite e não bloqueado). Quem não atende à condição hoje não tem hash no `pdv.db` da loja.
 */
async function anularCredenciaisDaLoja(
  tx: DbEmpresa,
  servicoAuditoria: AuditoriaService,
  t: TerminalControle,
  origem: OrigemAcao,
): Promise<{ pinsAnulados: number; senhasClienteAnuladas: number }> {
  const usuarios = await tx.execute<{ id: string; nome: string }>(sql`
    update usuarios u set senha_pdv_hash = null
     where u.senha_pdv_hash is not null and u.excluido_em is null
       and (u.master or exists (select 1 from usuarios_lojas ul
                                 where ul.usuario_id = u.id and ul.loja_id = ${t.lojaId} and ul.excluido_em is null))
    returning u.id, u.nome`);
  for (const u of usuarios.rows) {
    await servicoAuditoria.registrar(tx, origem, {
      acao: 'senha_redefinida',
      entidade: 'usuarios',
      registroId: u.id,
      localizacao: 'PDVs/Terminais › Terminal perdido/roubado',
      descricao: `PIN do PDV de ${u.nome} anulado (terminal do caixa ${numeroCaixa(t.numeroCaixa)} perdido/roubado)`,
      antes: { senha_pdv_hash: '***' },
      depois: { senha_pdv_hash: null },
    });
  }
  const escopo = { lojaId: t.lojaId };
  // Alias `t` (o mesmo das condições do registro de fluxos).
  const pessoas = await tx.execute<{ id: string; nome: string }>(sql`
    update pessoas t set senha_hash = null
     where t.senha_hash is not null and t.excluido_em is null
       and ${pessoaRelevante('id')(escopo)}
       and ${senhaClienteDesce(escopo)}
    returning t.id, t.nome`);
  for (const p of pessoas.rows) {
    await servicoAuditoria.registrar(tx, origem, {
      acao: 'senha_redefinida',
      entidade: 'pessoas',
      registroId: p.id,
      localizacao: 'PDVs/Terminais › Terminal perdido/roubado',
      descricao: `Senha de cliente de ${p.nome} anulada: redefinir no próximo atendimento (terminal perdido/roubado)`,
      antes: { senha_hash: '***' },
      depois: { senha_hash: null },
    });
  }
  return { pinsAnulados: usuarios.rows.length, senhasClienteAnuladas: pessoas.rows.length };
}

/** Manutenção: alertas da D20 cujos eventos já foram resolvidos (reprocessados ou descartados) fecham sozinhos. */
export async function resolverAlertasSemEventos(tx: DbEmpresa): Promise<number> {
  const r = await tx
    .update(alertas)
    .set({ resolvidoEm: new Date(), resolucao: 'Eventos do terminal resolvidos' })
    .where(
      and(
        eq(alertas.tipo, ALERTA_EVENTOS_NAO_RESOLVIDOS),
        isNull(alertas.resolvidoEm),
        isNull(alertas.excluidoEm),
        sql`not exists (select 1 from eventos_recebidos e
                         where e.terminal_id = ${alertas.registroId} and e.status in ('erro','retido'))`,
      ),
    )
    .returning({ id: alertas.id });
  return r.length;
}

/**
 * Fecha o `ATIVACAO_FORCA_BRUTA` aberto: pelo "Liberar ativações" (com quem liberou) ou pela manutenção, quando o
 * bloqueio de 1 h caiu sozinho. Um bloqueio novo depois disso abre outro alerta (a deduplicação vale só enquanto
 * aberto).
 */
export async function resolverAlertaForcaBruta(
  tx: DbEmpresa,
  resolucao: string,
  usuarioId: string | null = null,
): Promise<number> {
  const r = await tx
    .update(alertas)
    .set({ resolvidoEm: new Date(), resolvidoPorId: usuarioId, resolucao })
    .where(and(eq(alertas.tipo, ALERTA_FORCA_BRUTA), isNull(alertas.resolvidoEm), isNull(alertas.excluidoEm)))
    .returning({ id: alertas.id });
  return r.length;
}
