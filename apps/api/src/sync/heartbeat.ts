/**
 * `POST /sync/heartbeat` (SYNC 21.1) e `GET /sync/estado` (SYNC 5). O heartbeat grava a telemetria em `terminais`
 * (sem AU nem auditoria), confirma comandos e resoluções (entrega ao menos uma vez) e conclui a desativação
 * confirmada (esta, sim, com a auditoria `terminal_revogado`, como os outros caminhos da revogação); o estado é o
 * handshake de inicialização.
 *
 * Com o hardware divergente (SYNC 20.5) o heartbeat continua respondido, mas quem chama não é a máquina registrada:
 * nada da telemetria dela é gravado (IP, SO, numeração, pendências, que o ERP e a ativação do próximo terminal usam)
 * e a desativação não é confirmada; só o SO da primeira chamada com aquele hardware vai para o pendente.
 *
 * O desvio do relógio informado abre, atualiza ou fecha o `RELOGIO_DESVIO` do terminal (SYNC 12.4, 21.2; C16, T40) na
 * mesma transação da telemetria.
 */
import { MAX_COMANDOS_HEARTBEAT, STATUS_EVENTO_NUVEM } from '@genesis/shared';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { empresas, terminaisPdv, versoesAppPdv } from '../database/controle/schema.js';
import {
  comandosTerminal,
  eventosRecebidos,
  lojas,
  numeracoes,
  terminais,
} from '../database/empresa/schema/index.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';
import { alertarEventosNaoResolvidos, liberarCaixa, MOTIVOS_REVOGACAO } from '../terminais/revogacao.js';
import { INTERVALOS_PADRAO } from './ativacao.js';
import { garantirComandoRevogar } from './comandos.js';
import type {
  EventosStatusQuery,
  Heartbeat,
  RespostaEstado,
  RespostaEventosStatus,
  RespostaHeartbeat,
  StatusEventoNuvemItem,
} from './contratos.js';
import { versoesSchemaAceitas } from './eventos.js';
import { alertarDesvioRelogio, resolverAlertaDesvioRelogio } from './relogio.js';
import { fecharSessoesDoTerminal, sessaoAbertaDoTerminal } from './sessoes-caixa.js';
import { situacaoNaNuvem } from './situacao-evento.js';
import { PROTOCOLO_ATUAL, PROTOCOLO_MINIMO, type TerminalAutenticado } from './terminal.js';
import { compararVersoes } from './versoes-app.js';

const RENOVAR_TOKEN_DIAS = 30;

/**
 * Item de `eventos_resolvidos` (heartbeat) e de `eventos-status` (SYNC 21.1): a situação comum (`situacaoNaNuvem`,
 * a mesma do `recuperar`) com o `evento_id`; o heartbeat só entrega `aplicado` e `descartado`.
 */
function itemResolvido(r: typeof eventosRecebidos.$inferSelect): StatusEventoNuvemItem {
  return { evento_id: r.eventoId, ...situacaoNaNuvem(r) };
}

export class HeartbeatSync {
  constructor(
    private readonly controle: BancoControle,
    private readonly tenancy: Tenancy,
    private readonly auditoria: AuditoriaService,
  ) {}

  async receber(terminal: TerminalAutenticado, hb: Heartbeat): Promise<RespostaHeartbeat> {
    const agora = new Date();
    // A confirmação libera o caixa (`caixas` tem `fn_versao`): a trava é a primeira instrução (MD 1.5). Rota do PDV:
    // espera a 7300001 sem limite, como o push (o `lock_timeout` é só do ERP, C13).
    const podeConfirmar =
      terminal.hardwareConfere &&
      terminal.status === 'desativando' &&
      hb.estado_local === 'desativando_confirmado';
    const { comandos, resolvidos, revogado } = await this.tenancy.cx().transacao(
      async (tx) => {
        if (terminal.hardwareConfere) await this.gravarTelemetria(tx, terminal, hb, agora);
        if (hb.eventos_resolvidos_ack.length) {
          await tx
            .update(eventosRecebidos)
            .set({ resolucaoEntregueEm: agora })
            .where(
              and(
                eq(eventosRecebidos.terminalId, terminal.terminalId),
                inArray(eventosRecebidos.eventoId, hb.eventos_resolvidos_ack),
                isNull(eventosRecebidos.resolucaoEntregueEm),
              ),
            );
        }
        for (const r of hb.comandos_resultado) {
          const fim = r.status !== 'recebido';
          await tx
            .update(comandosTerminal)
            .set({
              status: fim ? (r.status === 'executado' ? 'executado' : 'falhou') : 'entregue',
              entregueEm: sql`coalesce(${comandosTerminal.entregueEm}, now())`,
              ...(fim ? { executadoEm: agora, resultado: r.resultado ?? {} } : {}),
            })
            .where(
              and(
                eq(comandosTerminal.id, r.comando_id),
                eq(comandosTerminal.terminalId, terminal.terminalId),
                inArray(comandosTerminal.status, fim ? ['pendente', 'entregue'] : ['pendente']),
              ),
            );
        }

        let revogado = false;
        // `status` já é o efetivo: o `desativando` de uma substituição em andamento chega aqui como `ativo`.
        if (terminal.status === 'desativando') {
          if (podeConfirmar) revogado = await this.confirmarDesativacao(tx, terminal, hb);
          // `desativando` recebe o comando `revogar` até confirmar (SYNC 3.8).
          if (!revogado) await garantirComandoRevogar(tx, terminal.terminalId);
        }
        const comandos = await tx
          .select({
            id: comandosTerminal.id,
            tipo: comandosTerminal.tipo,
            parametros: comandosTerminal.parametros,
          })
          .from(comandosTerminal)
          .where(
            and(
              eq(comandosTerminal.terminalId, terminal.terminalId),
              inArray(comandosTerminal.status, ['pendente', 'entregue']),
              isNull(comandosTerminal.excluidoEm),
              // Defesa: um `revogar` gravado na janela da substituição não desce (a compensação o cancela).
              terminal.substituicaoEmAndamento ? ne(comandosTerminal.tipo, 'revogar') : undefined,
            ),
          )
          .orderBy(comandosTerminal.criadoEm, comandosTerminal.id)
          // O PDV devolve um resultado por comando e a requisição aceita no máximo este tanto: o resto sai nos
          // próximos heartbeats, conforme os acks chegam.
          .limit(MAX_COMANDOS_HEARTBEAT);
        const resolvidos = await tx
          .select()
          .from(eventosRecebidos)
          .where(
            and(
              eq(eventosRecebidos.terminalId, terminal.terminalId),
              inArray(eventosRecebidos.status, ['aplicado', 'descartado']),
              isNull(eventosRecebidos.resolucaoEntregueEm),
            ),
          )
          .orderBy(eventosRecebidos.sequenciaTerminal)
          .limit(200);
        return { comandos, resolvidos, revogado };
      },
      { travaVersao: podeConfirmar, esperaSemLimite: true },
    );

    if (revogado) {
      await this.controle.db
        .update(terminaisPdv)
        .set({ status: 'revogado', revogadoEm: agora, motivoRevogacao: MOTIVOS_REVOGACAO.confirmada })
        .where(and(eq(terminaisPdv.id, terminal.terminalId), eq(terminaisPdv.status, 'desativando')));
    }
    if (!terminal.hardwareConfere) {
      // SO da primeira chamada com o hardware pendente (a mesma que gravou `hardware_pendente_desde`).
      if (hb.so) {
        await this.controle.db
          .update(terminaisPdv)
          .set({ hardwarePendenteSo: hb.so })
          .where(
            and(
              eq(terminaisPdv.id, terminal.terminalId),
              eq(terminaisPdv.idHardwarePendente, terminal.cabecalhos.idHardware),
              isNull(terminaisPdv.hardwarePendenteSo),
            ),
          );
      }
    } else if (hb.so || hb.versao_app) {
      await this.controle.db
        .update(terminaisPdv)
        .set({
          versaoApp: hb.versao_app ?? terminal.cabecalhos.versaoApp,
          ...(hb.so ? { sistemaOperacional: hb.so } : {}),
        })
        .where(eq(terminaisPdv.id, terminal.terminalId));
    }
    const sse = hb.sse_conectado === true;
    return {
      agora_servidor: new Date().toISOString(),
      status_terminal: revogado
        ? 'revogado'
        : !terminal.hardwareConfere
          ? 'hardware_alterado'
          : terminal.status,
      comandos: comandos.map((c) => ({ id: c.id, tipo: c.tipo, parametros: c.parametros })),
      eventos_resolvidos: resolvidos.map(
        (r) => itemResolvido(r) as RespostaHeartbeat['eventos_resolvidos'][number],
      ),
      renovar_token: Date.now() - terminal.tokenEmitidoEm.getTime() > RENOVAR_TOKEN_DIAS * 86_400_000,
      app: await this.app(terminal),
      intervalos: { ...INTERVALOS_PADRAO, heartbeat_s: sse ? 60 : 30 },
    };
  }

  /** Telemetria da máquina registrada em `terminais` (SYNC 21.1): só com o hardware que confere. */
  private async gravarTelemetria(
    tx: DbEmpresa,
    terminal: TerminalAutenticado,
    hb: Heartbeat,
    agora: Date,
  ): Promise<void> {
    const [linha] = await tx
      .update(terminais)
      .set({
        ultimoContatoEm: agora,
        ultimoIp: terminal.ip,
        versaoApp: hb.versao_app ?? terminal.cabecalhos.versaoApp,
        ...(hb.so ? { sistemaOperacional: hb.so } : {}),
        ...(hb.cursor_pull ? { cursorPull: hb.cursor_pull } : {}),
        ...(hb.ultimo_pull_sucesso_em ? { ultimoPullEm: new Date(hb.ultimo_pull_sucesso_em) } : {}),
        eventosPendentes: hb.eventos_pendentes,
        eventoMaisAntigoEm: hb.evento_mais_antigo_em ? new Date(hb.evento_mais_antigo_em) : null,
        eventosRejeitados: hb.eventos_rejeitados,
        nfceContingenciaPendentes: hb.nfce_contingencia_pendentes,
        nfceContingenciaMaisAntigaEm: hb.nfce_contingencia_mais_antiga_em
          ? new Date(hb.nfce_contingencia_mais_antiga_em)
          : null,
        nfceUltimoNumero: hb.nfce_ultimo_numero?.length
          ? Math.max(...hb.nfce_ultimo_numero.map((n) => n.numero))
          : undefined,
        ultimaSequenciaGerada: hb.ultima_sequencia_gerada ?? undefined,
        vendaUltimoNumero: hb.venda_ultimo_numero ?? undefined,
        valeUltimoNumero: hb.vale_ultimo_numero ?? undefined,
        inutilizacoesPendentes: hb.inutilizacoes_pendentes,
        discoLivreMb: hb.disco_livre_mb ?? undefined,
        tamanhoBancoMb: hb.tamanho_banco_mb ?? undefined,
        filaImpressaoPendentes: hb.fila_impressao_pendentes,
        sseConectado: hb.sse_conectado ?? undefined,
        versaoSchemaLocal: hb.versao_schema_local ?? undefined,
        dinheiroEstimadoGaveta: hb.dinheiro_estimado_gaveta ?? null,
        relogioConfiavel: hb.relogio_confiavel ?? undefined,
        desvioRelogioMs: hb.desvio_relogio_ms ?? undefined,
        certificadoValidade: hb.certificado_validade ? new Date(hb.certificado_validade) : null,
        sessaoCaixaId: hb.sessao_caixa_id ?? null,
        operadorId: hb.operador_id ?? null,
        ultimoErro: hb.ultimo_erro ?? null,
        vendasCancelamentoPendente: hb.vendas_cancelamento_pendente,
        estadoLocal: hb.estado_local,
      })
      .where(eq(terminais.id, terminal.terminalId))
      .returning({ status: terminais.status });
    // Sem amostra (`null`), o alerta fica como está: o desvio gravado também. O status é o do banco da empresa, lido
    // com a trava da linha que o `update` acabou de pegar: a autenticação leu o controle antes da transação, e uma
    // revogação (ou a confirmação de um heartbeat anterior) que fez o commit nesse meio já fechou o alerta. Reabri-lo
    // aqui deixaria um crítico que nada mais fecha (o revogado não manda heartbeat e o alerta não tem "Ciente").
    if (
      linha &&
      linha.status !== 'revogado' &&
      hb.desvio_relogio_ms !== null &&
      hb.desvio_relogio_ms !== undefined
    ) {
      await alertarDesvioRelogio(tx, terminal, hb.desvio_relogio_ms);
    }
  }

  /**
   * Desativação confirmada (SYNC 3.8, 13.3): só vale com 0 pendências e se a nuvem recebeu todos os eventos até a
   * última sequência gerada; grava os números finais e libera a revogação. Ao contrário dos outros caminhos, a empresa
   * vem antes do controle (é ela quem sabe o que foi recebido); a auditoria `terminal_revogado` gravada aqui é o que
   * impede a manutenção de refazer a revogação (`aplicarEstadoNaEmpresa`).
   */
  private async confirmarDesativacao(
    tx: DbEmpresa,
    terminal: TerminalAutenticado,
    hb: Heartbeat,
  ): Promise<boolean> {
    if (hb.eventos_pendentes > 0 || hb.nfce_contingencia_pendentes > 0 || hb.inutilizacoes_pendentes > 0)
      return false;
    const [{ ultima }] = (await tx
      .select({ ultima: sql<string>`coalesce(max(${eventosRecebidos.sequenciaTerminal}), 0)::text` })
      .from(eventosRecebidos)
      .where(eq(eventosRecebidos.terminalId, terminal.terminalId))) as [{ ultima: string }];
    const gerada = hb.ultima_sequencia_gerada ?? 0;
    if (Number(ultima) < gerada) return false;
    const [antes] = await tx
      .select({ status: terminais.status, motivo: terminais.motivoRevogacao })
      .from(terminais)
      .where(eq(terminais.id, terminal.terminalId))
      .for('update');
    if (!antes) return false;
    // Já confirmada num heartbeat anterior cujo passo do controle falhou: só falta o controle. O desvio do relógio
    // fecha de novo por defesa (a telemetria acima já não o abre para o revogado).
    if (antes.status === 'revogado') {
      await resolverAlertaDesvioRelogio(tx, terminal.terminalId, 'Terminal desativado com confirmação');
      return antes.motivo === MOTIVOS_REVOGACAO.confirmada;
    }
    // A empresa ainda não alcançou o `desativando` do controle (a etapa da revogação ou da substituição não rodou):
    // confirmar aqui revogaria um terminal que, para o banco da empresa, continua sendo o do caixa.
    if (antes.status !== 'desativando') return false;
    await tx
      .update(terminais)
      .set({
        status: 'revogado',
        revogadoEm: new Date(),
        motivoRevogacao: MOTIVOS_REVOGACAO.confirmada,
        desativacaoConfirmadaEm: new Date(),
        desativacaoUltimaSequencia: gerada,
        desativacaoVendaUltimoNumero: hb.venda_ultimo_numero ?? null,
        desativacaoValeUltimoNumero: hb.vale_ultimo_numero ?? null,
        desativacaoNfceUltimoNumero: hb.nfce_ultimo_numero ?? null,
      })
      .where(eq(terminais.id, terminal.terminalId));
    // O caixa fica livre (o confirmado vira o "anterior" da SYNC 13.3) e, pela D20, eventos em erro/retido não
    // seguram a série: viram alerta no ERP.
    await liberarCaixa(tx, terminal.terminalId, terminal.caixaId);
    // MD 3.12.1: um turno que o caixa deixou aberto (todos os eventos já recebidos) fecha à força, como na revogação.
    await fecharSessoesDoTerminal(tx, terminal.terminalId, 'revogacao_terminal');
    await resolverAlertaDesvioRelogio(tx, terminal.terminalId, 'Terminal desativado com confirmação');
    await this.auditoria.registrar(
      tx,
      { origem: 'pdv', terminalId: terminal.terminalId, lojaId: terminal.lojaId, ip: terminal.ip },
      {
        acao: 'terminal_revogado',
        entidade: 'terminais',
        registroId: terminal.terminalId,
        localizacao: 'PDV › Desativação',
        descricao:
          `Terminal desativado com confirmação (caixa ${String(terminal.numeroCaixa).padStart(2, '0')}): ` +
          `todos os eventos até a sequência ${gerada} recebidos`,
        antes: { status: antes.status },
        depois: {
          status: 'revogado',
          motivo: MOTIVOS_REVOGACAO.confirmada,
          ultima_sequencia: gerada,
          venda_ultimo_numero: hb.venda_ultimo_numero ?? null,
          vale_ultimo_numero: hb.vale_ultimo_numero ?? null,
        },
      },
    );
    await alertarEventosNaoResolvidos(
      tx,
      { id: terminal.terminalId, lojaId: terminal.lojaId, numeroCaixa: terminal.numeroCaixa },
      'Terminal desativado com confirmação',
    );
    return true;
  }

  /**
   * `GET /sync/eventos-status?ids=` (SYNC 7.2, 21.1): a rede de segurança do PDV para os seus `rejeitado`, consultada a
   * cada 1 h. Mesmo formato dos itens de `eventos_resolvidos`, com `erro`/`retido` também (o PDV não muda nada para
   * eles). Só os ids **deste** terminal (o filtro é pelo `terminal_id` do token): id de outro terminal ou desconhecido
   * fica fora da resposta, sem distinguir os dois. Só leitura: a entrega continua confirmada pelo ack do heartbeat
   * (`resolucao_entregue_em`), e o heartbeat repete o resolvido até lá. Aceita os mesmos estados do terminal que o
   * `recuperar` (tabela 3.8, T6): `ativo` e `desativando` (o PDV em desativação ainda precisa saber do que o ERP
   * decidiu para confirmar o outbox vazio); `provisionando` é 503 e `revogado` 401, na autenticação. Com o hardware
   * divergente responde normalmente, como o heartbeat: a situação de um evento não é segredo.
   */
  async eventosStatus(terminal: TerminalAutenticado, q: EventosStatusQuery): Promise<RespostaEventosStatus> {
    const linhas = await this.tenancy.cx().consulta((db) =>
      db
        .select()
        .from(eventosRecebidos)
        .where(
          and(
            eq(eventosRecebidos.terminalId, terminal.terminalId),
            inArray(eventosRecebidos.eventoId, q.ids),
            inArray(eventosRecebidos.status, [...STATUS_EVENTO_NUVEM]),
          ),
        )
        .orderBy(eventosRecebidos.sequenciaTerminal),
    );
    return { agora_servidor: new Date().toISOString(), eventos: linhas.map(itemResolvido) };
  }

  /** `GET /sync/estado` (SYNC 5). */
  async estado(terminal: TerminalAutenticado): Promise<RespostaEstado> {
    const dados = await this.tenancy.cx().consulta(async (db) => {
      const [t] = await db.select().from(terminais).where(eq(terminais.id, terminal.terminalId));
      const [loja] = await db.select().from(lojas).where(eq(lojas.id, terminal.lojaId));
      const [ultimo] = await db
        .select({
          sequencia: eventosRecebidos.sequenciaTerminal,
          eventoId: eventosRecebidos.eventoId,
          criadoEm: eventosRecebidos.criadoEm,
        })
        .from(eventosRecebidos)
        .where(eq(eventosRecebidos.terminalId, terminal.terminalId))
        .orderBy(desc(eventosRecebidos.sequenciaTerminal))
        .limit(1);
      const contagem = await db
        .select({ status: eventosRecebidos.status, n: sql<number>`count(*)::int` })
        .from(eventosRecebidos)
        .where(
          and(
            eq(eventosRecebidos.terminalId, terminal.terminalId),
            inArray(eventosRecebidos.status, ['erro', 'retido']),
          ),
        )
        .groupBy(eventosRecebidos.status);
      const nums = await db
        .select()
        .from(numeracoes)
        .where(and(eq(numeracoes.caixaId, terminal.caixaId), isNull(numeracoes.excluidoEm)));
      const sessao = await sessaoAbertaDoTerminal(db, terminal.terminalId);
      return { t, loja, ultimo, contagem, nums, sessao };
    });
    const { t, loja, ultimo, contagem, nums, sessao } = dados;
    const n = (tipo: string) => nums.find((x) => x.tipo === tipo)?.ultimoNumero ?? 0;
    const ultimaRecebida = ultimo?.sequencia ?? 0;
    return {
      terminal: {
        id: terminal.terminalId,
        status: terminal.status,
        loja_id: terminal.lojaId,
        caixa_id: terminal.caixaId,
        numero_caixa: terminal.numeroCaixa,
        carencia_ate: terminal.carenciaAte?.toISOString() ?? null,
        id_hardware_confere: terminal.hardwareConfere,
      },
      empresa_status: terminal.empresa.status as RespostaEstado['empresa_status'],
      loja: {
        ativa: loja?.ativa ?? false,
        usa_pdv: loja?.usaPdv ?? false,
        estoque_id: loja?.estoqueId ?? null,
        tipo_emissao: loja?.tipoEmissao ?? null,
      },
      sequencia_terminal: {
        ultima_recebida: ultimaRecebida,
        ultimo_evento_id: ultimo?.eventoId ?? null,
        ultima_recebida_em: ultimo?.criadoEm.toISOString() ?? null,
      },
      // O maior entre o que a nuvem recebeu e o que o terminal informou no último heartbeat (SYNC 5).
      numeracoes: {
        venda: { ultimo_numero: Math.max(n('venda'), t?.vendaUltimoNumero ?? 0) },
        nfce: nums
          .filter((x) => x.tipo === 'nfce' && x.serie !== null && x.ambiente !== null)
          .map((x) => ({ serie: x.serie!, ambiente: x.ambiente!, ultimo_numero: x.ultimoNumero })),
        vale: { ultimo_numero: Math.max(n('vale'), t?.valeUltimoNumero ?? 0) },
      },
      informado_pelo_terminal: {
        ultimo_heartbeat_em: t?.ultimoContatoEm?.toISOString() ?? null,
        ultima_sequencia_gerada: Math.max(t?.ultimaSequenciaGerada ?? 0, ultimaRecebida),
        eventos_pendentes: t?.eventosPendentes ?? 0,
        nfce_contingencia_pendentes: t?.nfceContingenciaPendentes ?? 0,
      },
      // Só a deste terminal (MD 3.12.1): a do terminal substituído no mesmo caixa nunca aparece aqui.
      sessao_caixa_aberta: sessao,
      eventos: {
        com_erro: contagem.find((c) => c.status === 'erro')?.n ?? 0,
        retidos: contagem.find((c) => c.status === 'retido')?.n ?? 0,
      },
      protocolo: { atual: PROTOCOLO_ATUAL, minimo: PROTOCOLO_MINIMO },
      versoes_schema: versoesSchemaAceitas(),
      app: await this.app(terminal),
      agora_servidor: new Date().toISOString(),
    };
  }

  /** Versão mínima e disponível do app para a plataforma e o canal da empresa (SYNC 17.3). */
  private async app(terminal: TerminalAutenticado) {
    const [e] = await this.controle.db
      .select({ canal: empresas.canalPdv })
      .from(empresas)
      .where(eq(empresas.id, terminal.empresa.id));
    const versoes = await this.controle.db
      .select()
      .from(versoesAppPdv)
      .where(
        and(
          eq(versoesAppPdv.plataforma, terminal.cabecalhos.plataforma),
          eq(versoesAppPdv.canal, e?.canal ?? 'estavel'),
          isNull(versoesAppPdv.excluidoEm),
          sql`${versoesAppPdv.publicadaEm} is not null`,
        ),
      );
    const ordenadas = versoes.sort((a, b) => compararVersoes(a.versaoApp, b.versaoApp));
    const disponivel = ordenadas.at(-1);
    const minima = ordenadas.filter((v) => v.versaoMinima).at(-1);
    return {
      versao_minima: minima?.versaoApp ?? null,
      versao_disponivel: disponivel?.versaoApp ?? null,
      url_pacote: disponivel?.urlPacote ?? null,
      sha256: disponivel?.sha256 ?? null,
      atualizar_ate: null,
    };
  }
}
