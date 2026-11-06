/**
 * Manutenção periódica dos terminais (pg-boss `schedule`, a cada 5 min; README › decisão 113):
 *
 * 1. códigos `pendente` vencidos passam a `expirado` (ERP 12.1);
 * 2. `desativando` com `carencia_ate` vencida vira `revogado` sem confirmação (SYNC 3.8): o próximo terminal do caixa
 *    recebe o salto de segurança (13.3);
 * 3. `provisionando` esquecido (a API caiu entre os commits da ativação e o PDV não repetiu na janela de 15 min,
 *    SYNC 3.4; a manutenção espera 20 min): com a etapa da empresa feita, conclui (`ativo`); sem ela, compensa como a
 *    falha da ativação;
 * 4. reconcilia o banco da empresa com o controle (a revogação grava o controle primeiro; se a etapa da empresa
 *    falhou, é repetida aqui, inclusive a anulação de PINs do modo perdido) para os terminais alterados na janela de
 *    7 dias;
 * 5. fecha os alertas que se resolveram sozinhos, sem janela: o da D20 quando o terminal não tem mais eventos em
 *    `erro`/`retido` (resolvidos dias depois, na fila de decisão da 1C ou pelo suporte), em toda empresa com terminal
 *    `desativando`/`revogado`; o `ATIVACAO_FORCA_BRUTA` quando o bloqueio de 1 h caiu sem "Liberar ativações", nas
 *    empresas com falhas de ativação nos últimos 7 dias; o `RELOGIO_DESVIO` (C16) ainda aberto de terminal `revogado`,
 *    nas mesmas empresas do alerta da D20;
 * 6. toca os usuários cujo dia de demissão chegou (D19; dia no fuso da empresa, `comum/fuso.ts`), nas empresas com
 *    terminal `ativo`/`desativando`: o fluxo `acesso` não leva a data ao caixa, só `ativo` já calculado
 *    (`sync/fluxos.ts`), e a linha precisa de versão nova para o `false` descer. Um toque por usuário: depois dele `atualizado_em` já é do dia da demissão.
 *
 * Uma execução por vez (trava consultiva de sessão no controle); uma empresa com erro não impede as outras.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AuditoriaService } from '../auditoria/auditoria.service.js';
import { hojeNaEmpresa, inicioDoDiaNaEmpresa } from '../comum/fuso.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { terminaisPdv } from '../database/controle/schema.js';
import { terminais } from '../database/empresa/schema/index.js';
import { REPETICAO_MIN, type AtivacaoTerminais } from '../sync/ativacao.js';
import { resolverDesviosDeRevogados } from '../sync/relogio.js';
import { tocar } from '../sync/toque.js';
import type { ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import {
  aplicarEstadoNaEmpresa,
  MOTIVOS_REVOGACAO,
  resolverAlertaForcaBruta,
  resolverAlertasSemEventos,
} from './revogacao.js';

/** Intervalo do agendamento (cron do pg-boss). */
export const CRON_MANUTENCAO_TERMINAIS = '*/5 * * * *';
/**
 * Janela de repetição da ativação (SYNC 3.4) mais a margem da etapa da empresa: uma repetição aceita no último minuto
 * da janela ainda está rodando a etapa (sem commit, invisível aqui) e não pode ser compensada por baixo dela. Os dois
 * prazos são medidos pelo relógio do banco do controle.
 */
export const PROVISIONANDO_ESQUECIDO_MIN = REPETICAO_MIN + 5;
/**
 * Revogações/desativações mais antigas que isto já foram reconciliadas por execuções anteriores; também a janela
 * das falhas de ativação que podem ter deixado o alerta de força bruta aberto.
 */
const JANELA_RECONCILIACAO_DIAS = 7;

export interface ResumoManutencao {
  executada: boolean;
  codigosExpirados: number;
  carenciasVencidas: number;
  provisionandoConcluidos: number;
  provisionandoCompensados: number;
  empresasReconciliadas: number;
  terminaisAlcancados: number;
  alertasResolvidos: number;
  alertasForcaBrutaResolvidos: number;
  alertasRelogioResolvidos: number;
  usuariosDemitidosTocados: number;
  falhas: Array<{ empresaId: string; erro: string }>;
}

export class ManutencaoTerminais {
  constructor(
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly tenancy: Tenancy,
    private readonly auditoria: AuditoriaService,
    private readonly ativacao: AtivacaoTerminais,
  ) {}

  async executar(): Promise<ResumoManutencao> {
    const resumo: ResumoManutencao = {
      executada: false,
      codigosExpirados: 0,
      carenciasVencidas: 0,
      provisionandoConcluidos: 0,
      provisionandoCompensados: 0,
      empresasReconciliadas: 0,
      terminaisAlcancados: 0,
      alertasResolvidos: 0,
      alertasForcaBrutaResolvidos: 0,
      alertasRelogioResolvidos: 0,
      usuariosDemitidosTocados: 0,
      falhas: [],
    };
    const trava = await this.controle.pool.connect();
    try {
      const { rows } = await trava.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('genesis:manutencao_terminais')) as ok",
      );
      if (!rows[0]?.ok) return resumo;
      try {
        resumo.executada = true;
        await this.executarPassos(resumo);
      } finally {
        await trava.query("select pg_advisory_unlock(hashtext('genesis:manutencao_terminais'))");
      }
    } finally {
      trava.release();
    }
    return resumo;
  }

  private async executarPassos(resumo: ResumoManutencao): Promise<void> {
    resumo.codigosExpirados = await this.ativacao.expirarCodigos();

    const vencidos = await this.controle.db
      .update(terminaisPdv)
      .set({ status: 'revogado', revogadoEm: new Date(), motivoRevogacao: MOTIVOS_REVOGACAO.carencia })
      .where(and(eq(terminaisPdv.status, 'desativando'), sql`${terminaisPdv.carenciaAte} <= now()`))
      .returning({ id: terminaisPdv.id });
    resumo.carenciasVencidas = vencidos.length;

    const esquecidos = await this.controle.db
      .select({ id: terminaisPdv.id, empresaId: terminaisPdv.empresaId })
      .from(terminaisPdv)
      .where(
        and(
          eq(terminaisPdv.status, 'provisionando'),
          lt(terminaisPdv.ativadoEm, sql`now() - make_interval(mins => ${PROVISIONANDO_ESQUECIDO_MIN})`),
        ),
      );
    for (const p of esquecidos) {
      try {
        const concluida = await this.naEmpresa(p.empresaId, async () => {
          const [e] = await this.tenancy
            .cx()
            .consulta((db) => db.select({ id: terminais.id }).from(terminais).where(eq(terminais.id, p.id)));
          return !!e;
        });
        if (concluida === null) continue;
        if (concluida) {
          const r = await this.controle.db
            .update(terminaisPdv)
            .set({ status: 'ativo' })
            .where(and(eq(terminaisPdv.id, p.id), eq(terminaisPdv.status, 'provisionando')))
            .returning({ id: terminaisPdv.id });
          resumo.provisionandoConcluidos += r.length;
        } else if (await this.ativacao.compensar(p.id)) {
          resumo.provisionandoCompensados++;
        }
      } catch (e) {
        resumo.falhas.push({ empresaId: p.empresaId, erro: (e as Error).message });
      }
    }

    const aReconciliar = await this.controle.db
      .select()
      .from(terminaisPdv)
      .where(
        and(
          inArray(terminaisPdv.status, ['desativando', 'revogado']),
          sql`${terminaisPdv.atualizadoEm} > now() - make_interval(days => ${JANELA_RECONCILIACAO_DIAS})`,
        ),
      );
    const porEmpresa = new Map<string, (typeof aReconciliar)[number][]>();
    for (const t of aReconciliar) porEmpresa.set(t.empresaId, [...(porEmpresa.get(t.empresaId) ?? []), t]);
    // Alerta da D20 pode estar aberto em qualquer empresa que já tirou terminal do caixa, por mais antigo que seja.
    const comTerminalFora = await this.controle.db
      .selectDistinct({ empresaId: terminaisPdv.empresaId })
      .from(terminaisPdv)
      .where(
        and(
          inArray(terminaisPdv.status, ['desativando', 'revogado']),
          sql`coalesce(${terminaisPdv.motivoRevogacao}, '') <> ${MOTIVOS_REVOGACAO.falhaAtivacao}`,
        ),
      );
    const comFalhas = await this.ativacao.empresasComFalhasDeAtivacao(JANELA_RECONCILIACAO_DIAS);
    const empresasIds = new Set([
      ...porEmpresa.keys(),
      ...comTerminalFora.map((e) => e.empresaId),
      ...comFalhas.keys(),
    ]);
    for (const empresaId of empresasIds) {
      try {
        const codigo = comFalhas.get(empresaId);
        const bloqueioCaiu = codigo !== undefined && !(await this.ativacao.estadoBloqueio(codigo)).bloqueado;
        const feito = await this.naEmpresa(empresaId, async () => {
          for (const t of porEmpresa.get(empresaId) ?? []) {
            const r = await this.tenancy.cx().transacao(
              (tx) =>
                aplicarEstadoNaEmpresa(
                  tx,
                  this.auditoria,
                  t,
                  { origem: 'sistema', terminalId: t.id },
                  {
                    localizacao: 'PDVs/Terminais › Manutenção',
                  },
                ),
              // Destino `revogado` libera o caixa (`caixas` tem `fn_versao`): trava primeiro (MD 1.5).
              { travaVersao: t.status === 'revogado', esperaSemLimite: true },
            );
            if (r.alterado) resumo.terminaisAlcancados++;
          }
          const [d20, forcaBruta, relogio] = await this.tenancy
            .cx()
            .transacao(async (tx) => [
              await resolverAlertasSemEventos(tx),
              bloqueioCaiu
                ? await resolverAlertaForcaBruta(tx, 'O bloqueio de 1 h expirou sem novas falhas')
                : 0,
              await resolverDesviosDeRevogados(tx),
            ]);
          resumo.alertasResolvidos += d20;
          resumo.alertasForcaBrutaResolvidos += forcaBruta;
          resumo.alertasRelogioResolvidos += relogio;
          return true;
        });
        if (feito && porEmpresa.has(empresaId)) resumo.empresasReconciliadas++;
      } catch (e) {
        resumo.falhas.push({ empresaId, erro: (e as Error).message });
      }
    }

    const comTerminalAtivo = await this.controle.db
      .selectDistinct({ empresaId: terminaisPdv.empresaId })
      .from(terminaisPdv)
      .where(inArray(terminaisPdv.status, ['ativo', 'desativando']));
    for (const { empresaId } of comTerminalAtivo) {
      try {
        const tocados = await this.naEmpresa(empresaId, () =>
          this.tenancy.cx().transacao(
            async (tx) => {
              const { rows } = await tx.execute<{ id: string }>(sql`
              select id from usuarios
              where ativo and excluido_em is null and demissao is not null and demissao <= ${hojeNaEmpresa}
                and atualizado_em < ${inicioDoDiaNaEmpresa(sql`demissao`)}`);
              return tocar(
                tx,
                'usuarios',
                'id',
                rows.map((r) => r.id),
              );
            },
            { travaVersao: true, esperaSemLimite: true },
          ),
        );
        resumo.usuariosDemitidosTocados += tocados ?? 0;
      } catch (e) {
        resumo.falhas.push({ empresaId, erro: (e as Error).message });
      }
    }
  }

  /** Roda no banco da empresa; `null` quando ela não está acessível agora (excluída, em manutenção, migrando). */
  private async naEmpresa<T>(empresaId: string, fn: () => Promise<T>): Promise<T | null> {
    const empresa = await this.resolvedor.porId(empresaId);
    if (!empresa || empresa.excluida || empresa.emManutencao || empresa.status === 'migrando') return null;
    return this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), fn);
  }
}
