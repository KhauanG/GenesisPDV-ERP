/**
 * Painel de saúde para o monitoramento (Implantação do piloto, I1b; formato em infra/producao/README.md ›
 * Monitoramento): `GET /api/saude/detalhada` com um token SÓ DE LEITURA, que não é sessão do ERP nem do painel e não
 * abre nada além desta rota. A resposta não leva dado pessoal (nome de pessoa, documento, e-mail, descrição livre do
 * terminal), valor de venda nem segredo: só estados, contagens, datas e os nomes/códigos das lojas.
 *
 * - `terminais`: os do `terminais_pdv` ativos, em ativação ou desativando, e os revogados nos últimos 7 dias (depois
 *   disso saem da lista: um caixa trocado não fica para sempre como "desativado"). Status `online` = contato nos
 *   últimos 2 min (ERP 12.1, `statusConexao`); `offline` = ativo (ou em ativação) sem contato recente;
 *   `desativado` = desativando ou revogado. `ultima_sincronizacao` = o mais recente entre heartbeat, pull e push.
 * - `eventos_fila_decisao`: eventos em `erro`/`retido` (fila de decisão, ERP 12.5) somados nas empresas com terminal.
 * - `tarefas_atrasadas`: trabalhos do pg-boss (`created`/`retry`) que já deviam ter começado há mais de 5 min.
 * - `ultimo_backup`: do `backups/estado.json` que o genesis-backup grava no bucket (cache de 60 s).
 * - `memoria`: do cgroup do container (como o `docker stats`: sem o cache de arquivos inativo).
 * - `processo`: o tempo no ar deste processo e a memória dele (heap do V8 usado, reservado e o teto; RSS), em MiB
 *   (decisão 166): o reinício sem implantação e o heap perto do teto (`JavaScript heap out of memory`) aparecem aqui.
 *
 * Uma parte que falha não derruba as outras: a empresa sem resposta conta em `empresas_sem_resposta` e o `status`
 * geral vira `degradado`.
 */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { statusConexao } from '@genesis/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Configuracao } from '../config/configuracao.js';
import { memoriaDoProcesso, type MemoriaProcesso } from '../comum/processo.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { empresas, terminaisPdv } from '../database/controle/schema.js';
import { eventosRecebidos, lojas, terminais } from '../database/empresa/schema/index.js';
import type { ArmazenamentoObjetos } from '../infra/armazenamento.js';
import type { ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { Tenancy } from '../tenancy/tenancy.js';

/** Revogados há menos que isto ainda aparecem como `desativado`. */
const JANELA_REVOGADOS_DIAS = 7;
/** Um trabalho do pg-boss que devia ter começado há mais que isto está atrasado. */
const ATRASO_TAREFA_MIN = 5;
const CACHE_BACKUP_MS = 60_000;

export type StatusTerminalMonitor = 'online' | 'offline' | 'desativado';
export type StatusBackupMonitor = 'ok' | 'falhou' | 'ausente' | 'indisponivel';

export interface TerminalMonitor {
  empresa: number;
  loja: { codigo: number; nome: string } | null;
  caixa: number;
  status: StatusTerminalMonitor;
  ultima_sincronizacao: string | null;
}

export interface UltimoBackupMonitor {
  status: StatusBackupMonitor;
  /** Fim do último backup (com sucesso ou não), ISO 8601 UTC. */
  data: string | null;
  tamanho_bytes: number | null;
  /** Fim do último backup sem falha (igual a `data` quando `status = ok`). */
  ultimo_sucesso_em: string | null;
}

export interface SaudeDetalhadaResposta {
  status: 'ok' | 'degradado';
  gerado_em: string;
  api: { versao: string; ambiente: string; no_ar_desde: string };
  banco: { status: 'ok' | 'erro'; latencia_ms: number | null };
  terminais: TerminalMonitor[];
  eventos_fila_decisao: number | null;
  tarefas_atrasadas: number | null;
  empresas_sem_resposta: number;
  ultimo_backup: UltimoBackupMonitor;
  memoria: { usada_bytes: number; limite_bytes: number | null };
  processo: { no_ar_segundos: number } & MemoriaProcesso;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const maisRecente = (...datas: Array<Date | null | undefined>): Date | null =>
  datas.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

export function statusTerminalMonitor(
  status: string,
  ultimoContatoEm: Date | null,
  agora: number,
): StatusTerminalMonitor {
  if (status === 'desativando' || status === 'revogado') return 'desativado';
  return status === 'ativo' && statusConexao(ultimoContatoEm, agora) === 'online' ? 'online' : 'offline';
}

/** Memória do container (cgroup v2, depois v1); fora de container, o RSS do processo e sem limite. */
export async function memoriaDoContainer(
  raiz = '/sys/fs/cgroup',
): Promise<SaudeDetalhadaResposta['memoria']> {
  const ler = (arquivo: string) => readFile(`${raiz}/${arquivo}`, 'utf8').then((t) => t.trim());
  const doStat = (texto: string, chave: string) => {
    const m = texto.match(new RegExp(`^${chave} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  try {
    const [atual, max, stat] = await Promise.all([
      ler('memory.current'),
      ler('memory.max'),
      ler('memory.stat'),
    ]);
    return {
      usada_bytes: Math.max(0, Number(atual) - doStat(stat, 'inactive_file')),
      limite_bytes: max === 'max' ? null : Number(max),
    };
  } catch {
    // cgroup v1 (ou nenhum)
  }
  try {
    const [uso, limite, stat] = await Promise.all([
      ler('memory/memory.usage_in_bytes'),
      ler('memory/memory.limit_in_bytes'),
      ler('memory/memory.stat'),
    ]);
    const lim = Number(limite);
    return {
      usada_bytes: Math.max(0, Number(uso) - doStat(stat, 'total_inactive_file')),
      // Sem limite, o v1 informa um número perto de 2^63.
      limite_bytes: lim > 2 ** 60 ? null : lim,
    };
  } catch {
    return { usada_bytes: process.memoryUsage().rss, limite_bytes: null };
  }
}

export class SaudeDetalhada {
  private readonly noArDesde = new Date();
  private cacheBackup: { valor: UltimoBackupMonitor; expira: number } | null = null;

  constructor(
    private readonly config: Configuracao,
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly tenancy: Tenancy,
    private readonly armazenamento: ArmazenamentoObjetos,
    private readonly opcoes: { raizCgroup?: string; cacheBackupMs?: number } = {},
  ) {}

  async gerar(): Promise<SaudeDetalhadaResposta> {
    const banco = await this.banco();
    const [terminaisEFila, tarefasAtrasadas, ultimoBackup, memoria] = await Promise.all([
      banco.status === 'ok'
        ? this.terminais()
        : Promise.resolve({ terminais: [], eventos: null, semResposta: 0, falhou: true }),
      banco.status === 'ok' ? this.tarefasAtrasadas() : Promise.resolve(null),
      this.ultimoBackup(),
      memoriaDoContainer(this.opcoes.raizCgroup),
    ]);
    const degradado =
      banco.status !== 'ok' ||
      terminaisEFila.falhou ||
      terminaisEFila.semResposta > 0 ||
      tarefasAtrasadas === null;
    return {
      status: degradado ? 'degradado' : 'ok',
      gerado_em: new Date().toISOString(),
      api: {
        versao: this.config.versao,
        ambiente: this.config.ambiente,
        no_ar_desde: this.noArDesde.toISOString(),
      },
      banco,
      terminais: terminaisEFila.terminais,
      eventos_fila_decisao: terminaisEFila.eventos,
      tarefas_atrasadas: tarefasAtrasadas,
      empresas_sem_resposta: terminaisEFila.semResposta,
      ultimo_backup: ultimoBackup,
      memoria,
      processo: { no_ar_segundos: Math.round(process.uptime()), ...memoriaDoProcesso() },
    };
  }

  private async banco(): Promise<SaudeDetalhadaResposta['banco']> {
    const inicio = performance.now();
    try {
      await this.controle.pool.query('select 1');
      return { status: 'ok', latencia_ms: Math.round((performance.now() - inicio) * 10) / 10 };
    } catch {
      return { status: 'erro', latencia_ms: null };
    }
  }

  private async terminais(): Promise<{
    terminais: TerminalMonitor[];
    eventos: number | null;
    semResposta: number;
    falhou: boolean;
  }> {
    try {
      const doControle = await this.controle.db
        .select({
          id: terminaisPdv.id,
          empresaId: terminaisPdv.empresaId,
          empresaCodigo: empresas.codigo,
          lojaId: terminaisPdv.lojaId,
          caixa: terminaisPdv.numeroCaixa,
          status: terminaisPdv.status,
          ultimoContatoEm: terminaisPdv.ultimoContatoEm,
        })
        .from(terminaisPdv)
        .innerJoin(empresas, eq(empresas.id, terminaisPdv.empresaId))
        .where(
          and(
            isNull(terminaisPdv.excluidoEm),
            isNull(empresas.excluidoEm),
            or(
              inArray(terminaisPdv.status, ['ativo', 'provisionando', 'desativando']),
              and(
                eq(terminaisPdv.status, 'revogado'),
                sql`${terminaisPdv.revogadoEm} > now() - make_interval(days => ${JANELA_REVOGADOS_DIAS})`,
              ),
            ),
          ),
        );
      const porEmpresa = new Map<string, typeof doControle>();
      for (const t of doControle) porEmpresa.set(t.empresaId, [...(porEmpresa.get(t.empresaId) ?? []), t]);
      // Empresas com terminal revogado há mais tempo também podem ter eventos parados na fila de decisão.
      const comFila = await this.controle.db
        .selectDistinct({ empresaId: terminaisPdv.empresaId })
        .from(terminaisPdv)
        .innerJoin(empresas, eq(empresas.id, terminaisPdv.empresaId))
        .where(and(isNull(terminaisPdv.excluidoEm), isNull(empresas.excluidoEm)));
      for (const { empresaId } of comFila) if (!porEmpresa.has(empresaId)) porEmpresa.set(empresaId, []);

      const agora = Date.now();
      const saida: TerminalMonitor[] = [];
      let eventos = 0;
      let semResposta = 0;
      for (const [empresaId, lista] of porEmpresa) {
        const daEmpresa = await this.naEmpresa(empresaId, async () =>
          this.tenancy.cx().consulta(async (db) => {
            const lojaIds = [...new Set(lista.map((t) => t.lojaId))];
            const ids = lista.map((t) => t.id);
            const ls = lojaIds.length
              ? await db
                  .select({ id: lojas.id, codigo: lojas.codigo, nome: lojas.nome })
                  .from(lojas)
                  .where(inArray(lojas.id, lojaIds))
              : [];
            const ts = ids.length
              ? await db
                  .select({
                    id: terminais.id,
                    contato: terminais.ultimoContatoEm,
                    pull: terminais.ultimoPullEm,
                    push: terminais.ultimoPushEm,
                  })
                  .from(terminais)
                  .where(inArray(terminais.id, ids))
              : [];
            const [fila] = await db
              .select({ n: sql<number>`count(*)::int` })
              .from(eventosRecebidos)
              .where(inArray(eventosRecebidos.status, ['erro', 'retido']));
            return { ls, ts, fila: fila?.n ?? 0 };
          }),
        ).catch(() => null);
        if (!daEmpresa) semResposta++;
        else eventos += daEmpresa.fila;
        const lojaPorId = new Map((daEmpresa?.ls ?? []).map((l) => [l.id, l]));
        const termPorId = new Map((daEmpresa?.ts ?? []).map((t) => [t.id, t]));
        for (const t of lista) {
          const e = termPorId.get(t.id);
          const loja = lojaPorId.get(t.lojaId);
          const contato = maisRecente(t.ultimoContatoEm, e?.contato);
          saida.push({
            empresa: t.empresaCodigo,
            loja: loja ? { codigo: loja.codigo, nome: loja.nome } : null,
            caixa: t.caixa,
            status: statusTerminalMonitor(t.status, contato, agora),
            ultima_sincronizacao: iso(maisRecente(contato, e?.pull, e?.push)),
          });
        }
      }
      saida.sort(
        (a, b) => a.empresa - b.empresa || (a.loja?.codigo ?? 0) - (b.loja?.codigo ?? 0) || a.caixa - b.caixa,
      );
      const nenhumaRespondeu = semResposta > 0 && semResposta === porEmpresa.size;
      return { terminais: saida, eventos: nenhumaRespondeu ? null : eventos, semResposta, falhou: false };
    } catch {
      return { terminais: [], eventos: null, semResposta: 0, falhou: true };
    }
  }

  private async naEmpresa<T>(empresaId: string, fn: () => Promise<T>): Promise<T | null> {
    const empresa = await this.resolvedor.porId(empresaId);
    if (!empresa || empresa.excluida || empresa.emManutencao || empresa.status === 'migrando') return null;
    return this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), fn);
  }

  /** Trabalhos do pg-boss que já deviam ter começado; `null` = não deu para consultar. */
  private async tarefasAtrasadas(): Promise<number | null> {
    try {
      const { rows } = await this.controle.pool.query<{ existe: boolean }>(
        "select to_regclass('pgboss.job') is not null as existe",
      );
      if (!rows[0]?.existe) return 0;
      const r = await this.controle.pool.query<{ n: number }>(
        `select count(*)::int as n from pgboss.job
          where state in ('created', 'retry') and start_after < now() - make_interval(mins => $1)`,
        [ATRASO_TAREFA_MIN],
      );
      return r.rows[0]?.n ?? 0;
    } catch {
      return null;
    }
  }

  private async ultimoBackup(): Promise<UltimoBackupMonitor> {
    if (this.cacheBackup && this.cacheBackup.expira > Date.now()) return this.cacheBackup.valor;
    const valor = await this.lerEstadoBackup();
    this.cacheBackup = { valor, expira: Date.now() + (this.opcoes.cacheBackupMs ?? CACHE_BACKUP_MS) };
    return valor;
  }

  private async lerEstadoBackup(): Promise<UltimoBackupMonitor> {
    const vazio = { data: null, tamanho_bytes: null, ultimo_sucesso_em: null };
    let texto: string;
    try {
      texto = (await this.armazenamento.ler(this.config.backup.chaveEstado)).toString('utf8');
    } catch (e) {
      const erro = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      const ausente = erro.name === 'NoSuchKey' || erro.$metadata?.httpStatusCode === 404;
      return { status: ausente ? 'ausente' : 'indisponivel', ...vazio };
    }
    try {
      const e = JSON.parse(texto) as {
        status?: unknown;
        fim?: unknown;
        tamanho_bytes?: unknown;
        ultimo_sucesso?: { fim?: unknown } | null;
      };
      const data = typeof e.fim === 'string' && !Number.isNaN(Date.parse(e.fim)) ? e.fim : null;
      const sucesso =
        typeof e.ultimo_sucesso?.fim === 'string' && !Number.isNaN(Date.parse(e.ultimo_sucesso.fim))
          ? e.ultimo_sucesso.fim
          : null;
      return {
        status: e.status === 'ok' ? 'ok' : 'falhou',
        data,
        tamanho_bytes: typeof e.tamanho_bytes === 'number' ? e.tamanho_bytes : null,
        ultimo_sucesso_em: sucesso,
      };
    } catch {
      return { status: 'indisponivel', ...vazio };
    }
  }
}
