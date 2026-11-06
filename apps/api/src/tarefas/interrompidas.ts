/**
 * Varredura das tarefas interrompidas (decisão 150): em cada empresa acessível (ativa ou suspensa; a em manutenção ou
 * migrando fica para a próxima), marca `falhou` com a mensagem de interrompida as tarefas `executando` sem "último
 * sinal" há mais de `LIMITE_SINAL_TAREFA_MS` (`TarefasSegundoPlano.marcarInterrompidas`), fora as que este processo
 * executa. Roda quando a instância com trabalhador inicia (o processo anterior pode ter morrido no meio de uma
 * importação) e a cada `CRON_TAREFAS_INTERROMPIDAS`: a tarefa que tinha sinal recente no início (reinício em segundos,
 * como o de 04/11/2026) passa do limite logo depois, sem esperar a expiração do job no pg-boss. Uma empresa com erro
 * não impede as outras (`trabalhoPorEmpresas`, `infra/fila.ts`). Repetir é seguro: o `update` só pega a tarefa ainda
 * `executando` e sem sinal.
 */
import { Logger } from '@nestjs/common';
import { and, inArray, isNull } from 'drizzle-orm';
import type { BancoControle } from '../database/controle/conexao.js';
import { empresas } from '../database/controle/schema.js';
import type { ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { TarefasSegundoPlano } from './tarefas.js';

/** A cada 2 min: com o limite de 3 min sem sinal, a tarefa órfã vira `falhou` em até ~5 min depois do reinício. */
export const CRON_TAREFAS_INTERROMPIDAS = '*/2 * * * *';

export interface ResumoTarefasInterrompidas {
  empresas: number;
  /** Tarefas marcadas como interrompidas, somadas as empresas. */
  marcadas: number;
  falhas: Array<{ empresaId: string; erro: string }>;
}

export class VarreduraTarefasInterrompidas {
  private readonly log = new Logger('TarefasSegundoPlano');

  constructor(
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly tenancy: Tenancy,
    private readonly tarefas: TarefasSegundoPlano,
  ) {}

  async executar(): Promise<ResumoTarefasInterrompidas> {
    const resumo: ResumoTarefasInterrompidas = { empresas: 0, marcadas: 0, falhas: [] };
    const lista = await this.controle.db
      .select({ id: empresas.id })
      .from(empresas)
      .where(and(inArray(empresas.status, ['ativa', 'suspensa']), isNull(empresas.excluidoEm)));
    for (const { id } of lista) {
      try {
        const empresa = await this.resolvedor.porId(id);
        if (!empresa || empresa.excluida || empresa.emManutencao || empresa.status === 'migrando') continue;
        const marcadas = await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), () =>
          this.tarefas.marcarInterrompidas(this.tenancy.cx()),
        );
        for (const t of marcadas) {
          this.log.warn(
            `tarefa ${t.id} (${t.tipo}) da empresa ${id}: estava executando sem sinal; marcada como interrompida`,
          );
        }
        resumo.marcadas += marcadas.length;
        resumo.empresas++;
      } catch (e) {
        resumo.falhas.push({ empresaId: id, erro: (e as Error).message });
      }
    }
    return resumo;
  }
}
