/**
 * Tarefas em segundo plano visíveis ao usuário (ERP 3.6; MD 3.1.8): a linha em `tarefas` nasce na transação de quem
 * pede, o trabalho entra na fila técnica depois do commit e o executor do `tipo` roda fora de transação longa,
 * atualizando progresso, resultado e o arquivo para download (armazenamento de objetos).
 *
 * Tarefa interrompida (decisão 150): enquanto o executor roda, o processo renova o "último sinal" da tarefa
 * (`atualizado_em`, com o relógio do banco) a cada `SINAL_TAREFA_MS`. A tarefa `executando` sem sinal há mais de
 * `LIMITE_SINAL_TAREFA_MS` ficou órfã (o processo morreu no meio): a retentativa da fila e a varredura
 * (`interrompidas.ts`) a marcam `falhou` com `mensagemInterrompida`. A que roda neste processo nunca é marcada.
 */
import { Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import type { PermissoesEfetivas } from '../autorizacao/permissoes-efetivas.js';
import { arquivos, tarefas, usuarios } from '../database/empresa/schema/index.js';
import type { ArmazenamentoObjetos } from '../infra/armazenamento.js';
import { FILAS, type FilaTrabalhos } from '../infra/fila.js';
import type { ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { AcessoEmpresa, DbEmpresa, Tenancy } from '../tenancy/tenancy.js';

export interface ExecucaoTarefa {
  tarefa: typeof tarefas.$inferSelect;
  /** Atualiza `progresso_pct`/`mensagem` (linha L: sem trava de versão). */
  progresso(pct: number, mensagem?: string): Promise<void>;
}

export type ExecutorTarefa = (
  e: ExecucaoTarefa,
) => Promise<{ resultado?: Record<string, unknown>; arquivoId?: string | null } | void>;

/**
 * A sessão de quem pediu a tarefa, com o acesso **do momento** (permissões, lojas e estoques recalculados): o
 * executor confere de novo o que a requisição conferiu (a importação de planilha e a de XML de NF-e, F2-B19), e quem
 * perdeu o acesso entre o pedido e a execução não grava nada com o acesso antigo. Usuário inativo ou excluído → erro
 * (a tarefa falha com a mensagem).
 */
export async function sessaoDaTarefa(
  db: DbEmpresa,
  tenancy: Tenancy,
  permissoes: PermissoesEfetivas,
  usuarioId: string,
  tarefaId: string,
): Promise<SessaoErp> {
  const [u] = await db
    .select()
    .from(usuarios)
    .where(and(eq(usuarios.id, usuarioId), isNull(usuarios.excluidoEm)));
  if (!u || !u.ativo) throw new Error('Usuário inativo ou excluído.');
  const contexto = tenancy.atual();
  const acesso = await permissoes.obter(db, contexto.empresaId, u);
  return {
    usuarioId: u.id,
    usuarioNome: u.nome,
    login: u.login,
    codigo: u.codigo,
    master: u.master,
    senhaProvisoria: false,
    sessaoId: tarefaId,
    permissoes: acesso.permissoes,
    lojas: acesso.lojas,
    estoques: acesso.estoques,
    limiteDescontoPct: String(u.limiteDescontoPct),
    empresa: contexto,
  };
}

/** Validade máxima de uma URL assinada (a assinatura do S3, SigV4, aceita até 7 dias). */
export const VALIDADE_MAXIMA_DOWNLOAD_S = 7 * 86_400;

/**
 * Validade do link do arquivo de uma tarefa (ERP 3.6, "link expira em 7 dias"): 7 dias, sem passar do fim do dia
 * `retencao_ate` (em UTC, como ele é gravado). `null` = a retenção já venceu: o arquivo não se baixa mais, mesmo que o
 * objeto ainda esteja no bucket (apagá-lo é a pendência do `infra/producao/README.md`). Sem retenção, 7 dias.
 * Assim cada `GET /tarefas` assina um link novo, mas nenhum vale além da retenção.
 */
export function validadeDownloadS(retencaoAte: string | null, agora = Date.now()): number | null {
  if (!retencaoAte) return VALIDADE_MAXIMA_DOWNLOAD_S;
  const restante = Math.floor((Date.parse(`${retencaoAte}T00:00:00Z`) + 86_400_000 - agora) / 1000);
  return restante > 0 ? Math.min(VALIDADE_MAXIMA_DOWNLOAD_S, restante) : null;
}

export interface OpcoesTarefas {
  /** Intervalo do último sinal (padrão `SINAL_TAREFA_MS`; o teste usa um curto). */
  sinalMs?: number;
}

export interface OpcoesTipoTarefa {
  /**
   * Complemento da mensagem de tarefa interrompida para este tipo (o que ficou gravado, como recuperar). Só o tipo
   * sabe se é seguro repetir; sem ele, vale `COMPLEMENTO_INTERROMPIDA_PADRAO`.
   */
  seInterrompida?: string;
}

/** Intervalo do "último sinal" (`atualizado_em`) da tarefa em execução. */
export const SINAL_TAREFA_MS = 30_000;
/**
 * Sem sinal há mais que isto, a tarefa `executando` é órfã: 6 sinais perdidos. Folga para um banco lento ou um pool
 * ocupado atrasar alguns sinais sem que a tarefa viva pareça morta.
 */
export const LIMITE_SINAL_TAREFA_MS = 3 * 60_000;

/**
 * Só o processo parado (sem sinal) leva a isto: a expiração do job no pg-boss não marca a tarefa (o worker segura a
 * retentativa até o handler voltar e a tarefa local é protegida), então a mensagem não fala em tempo limite.
 */
export const MENSAGEM_TAREFA_INTERROMPIDA =
  'A tarefa foi interrompida (o servidor reiniciou durante a execução) e não terminou.';
export const COMPLEMENTO_INTERROMPIDA_PADRAO = 'Confira o que já foi feito antes de pedir de novo.';

export class TarefasSegundoPlano {
  private readonly executores = new Map<string, ExecutorTarefa>();
  private readonly complementos = new Map<string, string>();
  /** Tarefas que este processo está executando agora: a retentativa e a varredura nunca as marcam. */
  private readonly locais = new Set<string>();
  private readonly log = new Logger('TarefasSegundoPlano');

  constructor(
    private readonly tenancy: Tenancy,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly fila: FilaTrabalhos,
    private readonly armazenamento: ArmazenamentoObjetos,
    private readonly opcoes: OpcoesTarefas = {},
  ) {}

  registrarTipo(tipo: string, executor: ExecutorTarefa, opcoes: OpcoesTipoTarefa = {}): void {
    this.executores.set(tipo, executor);
    if (opcoes.seInterrompida) this.complementos.set(tipo, opcoes.seInterrompida);
    else this.complementos.delete(tipo);
  }

  /** Mensagem ao usuário da tarefa interrompida: a genérica mais o complemento do tipo. */
  mensagemInterrompida(tipo: string): string {
    return `${MENSAGEM_TAREFA_INTERROMPIDA} ${this.complementos.get(tipo) ?? COMPLEMENTO_INTERROMPIDA_PADRAO}`;
  }

  /** Ids das tarefas em execução neste processo (a varredura as deixa de fora). */
  emExecucaoLocal(): string[] {
    return [...this.locais];
  }

  /** Cria a tarefa na transação de quem pede; chame `agendar` depois do commit. */
  async criar(
    tx: DbEmpresa,
    dados: { tipo: string; parametros?: Record<string, unknown>; usuarioId: string; lojaId?: string | null },
  ): Promise<string> {
    if (!this.executores.has(dados.tipo)) throw new Error(`Tipo de tarefa sem executor: ${dados.tipo}`);
    const [t] = await tx
      .insert(tarefas)
      .values({
        tipo: dados.tipo,
        parametros: dados.parametros ?? {},
        usuarioId: dados.usuarioId,
        lojaId: dados.lojaId ?? null,
      })
      .returning({ id: tarefas.id });
    return t!.id;
  }

  agendar(empresaId: string, tarefaId: string): Promise<void> {
    return this.fila.enviar(FILAS.tarefa, { empresaId, tarefaId }, { singletonKey: tarefaId });
  }

  /**
   * Trabalhador da fila. Erro do executor → `falhou` com a mensagem (a fila não repete: o usuário pede de novo).
   * A tarefa já `executando` é a retentativa de um job que expirou ou cujo processo morreu (`tentativa` =
   * `job.retryCount`, só para o log): o pg-boss segura a retentativa enquanto o handler deste processo não volta
   * (o worker não busca nada durante o "handler overrun"), então aqui ela vem de um processo que morreu, ou de outra
   * instância ainda viva. Só o sinal decide: parado há mais de `LIMITE_SINAL_TAREFA_MS` → `falhou` (interrompida);
   * recente → não mexe (quem executa termina; se morrer, a varredura recupera).
   */
  async executar(empresaId: string, tarefaId: string, tentativa = 0): Promise<void> {
    const empresa = await this.resolvedor.porId(empresaId);
    if (!empresa || empresa.excluida) return;
    await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), async () => {
      const cx = this.tenancy.cx();
      const [t] = await cx.consulta((db) =>
        db
          .update(tarefas)
          .set({ status: 'executando', iniciadaEm: new Date(), atualizadoEm: sql`now()` })
          .where(and(eq(tarefas.id, tarefaId), eq(tarefas.status, 'na_fila')))
          .returning(),
      );
      if (!t) {
        await this.retentativa(cx, empresaId, tarefaId, tentativa);
        return;
      }
      const executor = this.executores.get(t.tipo);
      this.locais.add(t.id);
      const sinal = setInterval(() => {
        cx.consulta((db) =>
          db
            .update(tarefas)
            .set({ atualizadoEm: sql`now()` })
            .where(and(eq(tarefas.id, t.id), eq(tarefas.status, 'executando'))),
        ).catch((e: unknown) =>
          this.log.warn(`tarefa ${t.id} (${t.tipo}): sinal não gravado: ${(e as Error).message}`),
        );
      }, this.opcoes.sinalMs ?? SINAL_TAREFA_MS);
      try {
        if (!executor) throw new Error(`Tipo de tarefa sem executor: ${t.tipo}`);
        const r =
          (await executor({
            tarefa: t,
            progresso: async (pct, mensagem) => {
              await cx.consulta((db) =>
                db
                  .update(tarefas)
                  .set({
                    progressoPct: Math.max(0, Math.min(100, Math.round(pct))),
                    mensagem: mensagem ?? null,
                    atualizadoEm: sql`now()`,
                  })
                  .where(eq(tarefas.id, t.id)),
              );
            },
          })) ?? {};
        // Sem trava de status: se a varredura a deu por interrompida (sinal atrasado), o resultado real prevalece.
        await cx.consulta((db) =>
          db
            .update(tarefas)
            .set({
              status: 'concluida',
              progressoPct: 100,
              resultado: r.resultado ?? null,
              arquivoId: r.arquivoId ?? null,
              erro: null,
              concluidaEm: new Date(),
              atualizadoEm: sql`now()`,
            })
            .where(eq(tarefas.id, t.id)),
        );
      } catch (e) {
        await cx.consulta((db) =>
          db
            .update(tarefas)
            .set({
              status: 'falhou',
              erro: (e as Error).message.slice(0, 2000),
              concluidaEm: new Date(),
              atualizadoEm: sql`now()`,
            })
            .where(eq(tarefas.id, t.id)),
        );
      } finally {
        clearInterval(sinal);
        this.locais.delete(t.id);
      }
    });
  }

  /** O job chegou e a tarefa não estava `na_fila`: concluída/falhou (nada a fazer) ou `executando` (veja `executar`). */
  private async retentativa(
    cx: AcessoEmpresa,
    empresaId: string,
    tarefaId: string,
    tentativa: number,
  ): Promise<void> {
    const [t] = await cx.consulta((db) =>
      db.select({ tipo: tarefas.tipo, status: tarefas.status }).from(tarefas).where(eq(tarefas.id, tarefaId)),
    );
    if (t?.status !== 'executando') return;
    const onde = `tarefa ${tarefaId} (${t.tipo}) da empresa ${empresaId}, tentativa ${tentativa}`;
    if (this.locais.has(tarefaId)) {
      this.log.warn(`${onde}: ainda executando neste processo; a retentativa não faz nada`);
      return;
    }
    const marcadas = await this.marcarInterrompidas(cx, [tarefaId]);
    if (marcadas.length) this.log.warn(`${onde}: estava executando sem sinal; marcada como interrompida`);
    else this.log.warn(`${onde}: executando com sinal recente (outro processo); a retentativa não faz nada`);
  }

  /**
   * Marca `falhou` (interrompida) as tarefas `executando` sem sinal há mais de `LIMITE_SINAL_TAREFA_MS` — todas da
   * empresa do contexto, ou só `ids` —, fora as que este processo executa. A condição vai no próprio `update`
   * (relógio do banco), então um sinal que chega no meio vence. Devolve as marcadas.
   */
  async marcarInterrompidas(cx: AcessoEmpresa, ids?: string[]): Promise<Array<{ id: string; tipo: string }>> {
    const locais = this.emExecucaoLocal();
    const candidatas = await cx.consulta((db) =>
      db
        .select({ id: tarefas.id, tipo: tarefas.tipo })
        .from(tarefas)
        .where(
          and(
            eq(tarefas.status, 'executando'),
            ids ? inArray(tarefas.id, ids) : undefined,
            locais.length ? notInArray(tarefas.id, locais) : undefined,
          ),
        ),
    );
    const marcadas: Array<{ id: string; tipo: string }> = [];
    for (const c of candidatas) {
      const r = await cx.consulta((db) =>
        db
          .update(tarefas)
          .set({
            status: 'falhou',
            erro: this.mensagemInterrompida(c.tipo),
            concluidaEm: new Date(),
            atualizadoEm: sql`now()`,
          })
          .where(
            and(
              eq(tarefas.id, c.id),
              eq(tarefas.status, 'executando'),
              lt(tarefas.atualizadoEm, sql`now() - make_interval(secs => ${LIMITE_SINAL_TAREFA_MS / 1000})`),
            ),
          )
          .returning({ id: tarefas.id }),
      );
      if (r.length) marcadas.push(c);
    }
    return marcadas;
  }

  /**
   * Tarefas do usuário (ícone "Tarefas" do cabeçalho, ERP 3.6), com link de download assinado: 7 dias, sem passar da
   * retenção do arquivo (`validadeDownloadS`). Retenção vencida → `download: null` e `downloadExpirado: true`.
   */
  async doUsuario(usuarioId: string, tarefaId?: string) {
    const linhas = await this.tenancy.cx().consulta((db) =>
      db
        .select({
          t: tarefas,
          chave: arquivos.chaveArmazenamento,
          nome: arquivos.nomeOriginal,
          retencaoAte: arquivos.retencaoAte,
        })
        .from(tarefas)
        .leftJoin(arquivos, eq(arquivos.id, tarefas.arquivoId))
        .where(and(eq(tarefas.usuarioId, usuarioId), tarefaId ? eq(tarefas.id, tarefaId) : undefined))
        .orderBy(desc(tarefas.criadoEm))
        .limit(50),
    );
    const pendentes = linhas.filter((l) => ['na_fila', 'executando'].includes(l.t.status)).length;
    return {
      pendentes,
      itens: await Promise.all(
        linhas.map(async ({ t, chave, nome, retencaoAte }) => {
          const validadeS = chave ? validadeDownloadS(retencaoAte) : null;
          return {
            id: t.id,
            tipo: t.tipo,
            status: t.status,
            progressoPct: t.progressoPct,
            mensagem: t.mensagem,
            resultado: t.resultado,
            erro: t.erro,
            criadoEm: t.criadoEm.toISOString(),
            concluidaEm: t.concluidaEm?.toISOString() ?? null,
            download:
              chave && validadeS
                ? await this.armazenamento.urlDownload(chave, { nomeArquivo: nome ?? undefined, validadeS })
                : null,
            downloadExpirado: !!chave && validadeS === null,
          };
        }),
      ),
    };
  }
}
