/**
 * Fila técnica de trabalhos em segundo plano (MD 3.1.8: "a fila técnica usa schema próprio"): pg-boss no banco de
 * controle, schema `pgboss`. Os trabalhos levam só ids (empresa, tarefa, mensagem); o conteúdo fica no banco da
 * empresa. Envia sempre depois do commit da transação que criou a linha (nenhuma E/S sob a trava, MD 1.5).
 * Trabalhos recorrentes (manutenção dos terminais, expiração da relevância das pessoas, alerta das transferências
 * paradas) usam o `schedule` do
 * pg-boss: o cron fica no banco, então várias instâncias com trabalhador geram um job por ocorrência, não um por
 * instância. Pelo mesmo motivo, o opcional desligado por configuração (`VERIFICACAO_RAZAO_CRON` vazia) é
 * removido com `desagendar`: sem isso, o agendamento gravado quando esteve ligado seguia criando jobs que ninguém
 * consome. Os que percorrem as empresas passam por `trabalhoPorEmpresas`: falha de empresa vai para o log e faz o
 * job falhar (retentativa do pg-boss), em vez de sumir no resumo.
 * As opções de cada fila (`OPCOES_FILAS`) valem também para a fila que já existe: `createQueue` não altera uma fila
 * criada, então o `iniciar` aplica as mesmas opções com `updateQueue` (idempotente). Os eventos `error` e `warning`
 * do pg-boss (este traz o "handler overrun": job que passou de `expireInSeconds` com o handler ainda rodando) vão
 * para o log do Nest, só com a mensagem do pg-boss, a fila e os ids dos jobs (decisão 150).
 */
import { Logger } from '@nestjs/common';
import { PgBoss, type Job } from 'pg-boss';

export const FILAS = {
  /** `tarefas` do ERP (ERP 3.6): exportações, importações… */
  tarefa: 'genesis-tarefa',
  /** `mensagens_enviadas` (e-mail transacional, ERP 18.14). */
  mensagem: 'genesis-mensagem',
  /** Manutenção periódica dos terminais (carência, provisionando, códigos vencidos, reconciliação). */
  manutencaoTerminais: 'genesis-manutencao-terminais',
  /** Expiração diária da relevância das pessoas no PDV (`compra`/`delivery`/`crediario`, MD 3.5.4). */
  expiracaoRelevancia: 'genesis-expiracao-relevancia',
  /** Verificação periódica do razão de estoque (F2-B3), só com `VERIFICACAO_RAZAO_CRON`. */
  verificacaoRazao: 'genesis-verificacao-razao',
  /** Varredura das `tarefas` interrompidas (decisão 150): no início da instância com trabalhador e a cada 2 min. */
  tarefasInterrompidas: 'genesis-tarefas-interrompidas',
  /** Alerta da transferência parada em trânsito ou com divergência a tratar (F2-B26, decisão 174), a cada hora. */
  alertaTransferencias: 'genesis-alerta-transferencias',
} as const;
export type NomeFila = (typeof FILAS)[keyof typeof FILAS];

const OPCOES_PADRAO = { retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 15 * 60 };

/**
 * Opções de cada fila no pg-boss. A das `tarefas` expira em 1 h: a importação grande passa dos 15 min, e o job
 * expirado com o handler ainda rodando só gerava o aviso de "handler overrun" e uma retentativa vazia. Quem recupera
 * a tarefa de um processo que morreu é o sinal + a varredura (decisão 150), não a expiração.
 */
export const OPCOES_FILAS: Record<NomeFila, typeof OPCOES_PADRAO> = {
  [FILAS.tarefa]: { ...OPCOES_PADRAO, expireInSeconds: 60 * 60 },
  [FILAS.mensagem]: OPCOES_PADRAO,
  [FILAS.manutencaoTerminais]: OPCOES_PADRAO,
  [FILAS.expiracaoRelevancia]: OPCOES_PADRAO,
  [FILAS.verificacaoRazao]: OPCOES_PADRAO,
  [FILAS.tarefasInterrompidas]: OPCOES_PADRAO,
  [FILAS.alertaTransferencias]: OPCOES_PADRAO,
};

export type Trabalho = (dados: Record<string, unknown>, job: Job<Record<string, unknown>>) => Promise<void>;

/** Resumo de um trabalho que percorre as empresas: cada uma que falhou, com a mensagem (sem dados pessoais). */
export interface ResumoPorEmpresas {
  falhas: Array<{ empresaId: string; erro: string }>;
}

/** Só o que o trabalho usa do logger do Nest (o teste passa um falso). */
export type LogTrabalho = Pick<Logger, 'error'>;
export type LogFila = Pick<Logger, 'error' | 'warn'>;

/**
 * Trabalho recorrente que percorre as empresas (manutenção dos terminais, expiração da relevância): uma empresa com
 * erro não impede as outras, mas cada falha vai para o log (o id da empresa e a mensagem) e, se sobrou alguma, o
 * trabalho lança no fim, para o pg-boss marcar o job como falho e tentar de novo (`retryLimit`, com backoff). Sem
 * isso o job concluía com sucesso e a empresa ficava sem a tarefa, sem nenhum sinal (a purga LGPD do PDV, por
 * exemplo). A repetição é segura: as duas tarefas são idempotentes e têm a trava consultiva de execução.
 */
export function trabalhoPorEmpresas(
  nome: NomeFila,
  executar: () => Promise<ResumoPorEmpresas>,
  log: LogTrabalho = new Logger('FilaTrabalhos'),
): Trabalho {
  return async () => {
    const { falhas } = await executar();
    for (const f of falhas) log.error(`${nome}: falhou na empresa ${f.empresaId}: ${f.erro}`);
    if (falhas.length > 0) throw new Error(`${nome}: falhou em ${falhas.length} empresa(s)`);
  };
}

const mensagem = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Linha de log de um `warning` do pg-boss: a mensagem, o tipo, a fila e os ids dos jobs (os jobs só levam ids; nada
 * do `data` além disso, que em outros tipos traz SQL e números internos).
 */
export function textoAvisoFila(aviso: { message: string; data?: object }): string {
  const d = (aviso.data ?? {}) as { type?: unknown; queue?: unknown; jobs?: unknown };
  const partes = [`pg-boss: ${aviso.message}`];
  if (typeof d.type === 'string') partes.push(`tipo=${d.type}`);
  if (typeof d.queue === 'string') partes.push(`fila=${d.queue}`);
  if (Array.isArray(d.jobs)) partes.push(`jobs=${d.jobs.filter((j) => typeof j === 'string').join(',')}`);
  return partes.join(' ');
}

/** Liga os eventos `error` e `warning` do pg-boss ao log (o `aoErro` opcional continua recebendo o erro). */
export function registrarEventosFila(
  boss: Pick<PgBoss, 'on'>,
  log: LogFila,
  aoErro?: (e: unknown) => void,
): void {
  boss.on('error', (e) => {
    log.error(`pg-boss: ${mensagem(e)}`);
    aoErro?.(e);
  });
  boss.on('warning', (aviso) => log.warn(textoAvisoFila(aviso)));
}

export class FilaTrabalhos {
  private boss: PgBoss | null = null;
  private iniciando: Promise<PgBoss> | null = null;
  private readonly trabalhadores = new Map<NomeFila, Trabalho>();
  private readonly agendamentos = new Map<NomeFila, string>();
  private readonly desagendamentos = new Set<NomeFila>();
  private readonly aoIniciar = new Set<NomeFila>();
  private readonly log = new Logger('FilaTrabalhos');
  private parando = false;

  constructor(
    private readonly urlControle: string,
    private readonly opcoes: { trabalhador: boolean; aoErro?: (e: unknown) => void } = { trabalhador: true },
  ) {}

  /** Registra o executor de uma fila; só roda nesta instância se `FILA_TRABALHADOR` estiver ligado. */
  registrar(fila: NomeFila, trabalho: Trabalho): void {
    this.trabalhadores.set(fila, trabalho);
  }

  /**
   * Recorrência (`cron` em UTC) de uma fila registrada: gravada no `schedule` do pg-boss quando a instância com
   * trabalhador inicia. Só a instância com trabalhador agenda, e o pg-boss não duplica o job da mesma ocorrência.
   */
  agendar(fila: NomeFila, cron: string): void {
    this.agendamentos.set(fila, cron);
    this.desagendamentos.delete(fila);
  }

  /**
   * Remove do `schedule` do pg-boss a recorrência de uma fila desligada por configuração, quando a instância com
   * trabalhador inicia (idempotente: sem agendamento gravado, não faz nada).
   */
  desagendar(fila: NomeFila): void {
    this.agendamentos.delete(fila);
    this.desagendamentos.add(fila);
  }

  /**
   * Um job da fila (sem dados) cada vez que a instância com trabalhador inicia, depois dos trabalhadores (a varredura
   * das tarefas interrompidas, por exemplo). Falha no envio vai para o log e não rejeita o `iniciar()`.
   */
  executarAoIniciar(fila: NomeFila): void {
    this.aoIniciar.add(fila);
  }

  /** Inicia o pg-boss (cria o schema na primeira vez) e os trabalhadores registrados. */
  iniciar(): Promise<PgBoss> {
    this.iniciando ??= (async () => {
      const boss = new PgBoss({
        connectionString: this.urlControle,
        schema: 'pgboss',
        max: 4,
        application_name: 'genesis_fila',
      });
      registrarEventosFila(boss, this.log, this.opcoes.aoErro);
      await boss.start();
      for (const fila of Object.values(FILAS)) {
        await boss.createQueue(fila, OPCOES_FILAS[fila]);
        await boss.updateQueue(fila, OPCOES_FILAS[fila]);
      }
      if (this.opcoes.trabalhador) {
        for (const [fila, trabalho] of this.trabalhadores) {
          await boss.work<Record<string, unknown>>(
            fila,
            { pollingIntervalSeconds: 1, batchSize: 1 },
            async (jobs) => {
              for (const job of jobs) await trabalho(job.data, job);
            },
          );
        }
        // Cada agendamento isolado: um que falha (cron recusado pelo pg-boss, por exemplo) vai para o log e não
        // rejeita o `iniciar()`, que fica guardado e faria falhar todo `enviar()` (e-mails, tarefas) até reiniciar.
        for (const [fila, cron] of this.agendamentos) {
          await boss
            .schedule(fila, cron, {}, { tz: 'UTC' })
            .catch((e: unknown) => this.log.error(`${fila}: agendamento "${cron}" recusado: ${mensagem(e)}`));
        }
        for (const fila of this.desagendamentos) {
          await boss
            .unschedule(fila)
            .catch((e: unknown) => this.log.error(`${fila}: não foi possível remover o agendamento: ${mensagem(e)}`));
        }
        for (const fila of this.aoIniciar) {
          if (!this.trabalhadores.has(fila)) continue;
          await boss
            .send(fila, {})
            .catch((e: unknown) => this.log.error(`${fila}: job do início não enviado: ${mensagem(e)}`));
        }
      }
      this.boss = boss;
      return boss;
    })();
    return this.iniciando;
  }

  async enviar(
    fila: NomeFila,
    dados: Record<string, unknown>,
    opcoes: { singletonKey?: string } = {},
  ): Promise<void> {
    if (this.parando) throw new Error('Fila encerrada');
    const boss = await this.iniciar();
    await boss.send(fila, dados, opcoes.singletonKey ? { singletonKey: opcoes.singletonKey } : {});
  }

  async parar(): Promise<void> {
    this.parando = true;
    if (!this.iniciando) return;
    const boss = await this.iniciando.catch(() => null);
    await boss?.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
  }
}
