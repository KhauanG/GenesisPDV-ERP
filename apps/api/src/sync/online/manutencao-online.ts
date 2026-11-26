/**
 * Tarefa por minuto das chamadas online do caixa (SYNC 20.4; F3-B6, README da API › decisão 225; pg-boss `schedule`,
 * um job por ocorrência mesmo com várias instâncias): apaga de `requisicoes_terminal` as linhas com mais de
 * `RETENCAO_REQUISICAO_ONLINE_HORAS`, em lotes. A expiração das reservas de vale (TTL de 10 min, F3-B45) e de
 * orçamento (F3-B60) entra nesta mesma tarefa.
 *
 * A correção não depende dela: a `IdempotenciaOnline` já trata a linha vencida como inexistente. A limpeza só mantém a
 * tabela pequena. Por isso ela percorre só as empresas com terminal que falou com a API na janela da retenção (o
 * `ultimo_contato_em` do controle, gravado no máximo uma vez por minuto em toda chamada autenticada com o hardware
 * registrado, que é o que as chamadas online exigem), e não abre conexão a cada minuto com as que não têm caixa.
 * Uma execução por vez (trava consultiva de sessão no controle); uma empresa com erro não impede as outras
 * (`trabalhoPorEmpresas`). Sem retentativa no pg-boss: a ocorrência do minuto seguinte é a nova tentativa.
 */
import { RETENCAO_REQUISICAO_ONLINE_HORAS } from '@genesis/shared';
import { sql } from 'drizzle-orm';
import type { BancoControle } from '../../database/controle/conexao.js';
import type { DbEmpresa, Tenancy } from '../../tenancy/tenancy.js';
import type { ResolvedorEmpresas } from '../../tenancy/resolvedor.js';

/** A cada minuto (cron do pg-boss). */
export const CRON_MANUTENCAO_ONLINE = '* * * * *';

/** Linhas apagadas por transação (a do índice `ix_requisicoes_terminal_criada_em`). */
export const LOTE_LIMPEZA_REQUISICOES = 5_000;

/**
 * Folga sobre a retenção no filtro das empresas: o contato é gravado no máximo uma vez por minuto, então a última
 * requisição de um terminal pode ser até 1 min mais nova que o `ultimo_contato_em`.
 */
const FOLGA_CONTATO_HORAS = 2;

export interface ResumoManutencaoOnline {
  executada: boolean;
  empresas: number;
  requisicoesApagadas: number;
  falhas: Array<{ empresaId: string; erro: string }>;
}

/** Um lote da limpeza: as linhas vencidas mais antigas primeiro; devolve quantas saíram. */
export async function limparRequisicoesVencidas(
  db: DbEmpresa,
  lote = LOTE_LIMPEZA_REQUISICOES,
): Promise<number> {
  const r = await db.execute(sql`
    delete from requisicoes_terminal r
     using (select terminal_id, requisicao_id from requisicoes_terminal
             where criada_em < now() - make_interval(hours => ${RETENCAO_REQUISICAO_ONLINE_HORAS})
             order by criada_em
             limit ${lote}) v
     where r.terminal_id = v.terminal_id and r.requisicao_id = v.requisicao_id`);
  return r.rowCount ?? 0;
}

export class ManutencaoOnline {
  constructor(
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly tenancy: Tenancy,
    private readonly lote = LOTE_LIMPEZA_REQUISICOES,
  ) {}

  async executar(): Promise<ResumoManutencaoOnline> {
    const resumo: ResumoManutencaoOnline = {
      executada: false,
      empresas: 0,
      requisicoesApagadas: 0,
      falhas: [],
    };
    const trava = await this.controle.pool.connect();
    try {
      const { rows } = await trava.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('genesis:manutencao_online')) as ok",
      );
      if (!rows[0]?.ok) return resumo;
      try {
        resumo.executada = true;
        await this.executarEmpresas(resumo);
      } finally {
        await trava.query("select pg_advisory_unlock(hashtext('genesis:manutencao_online'))");
      }
    } finally {
      trava.release();
    }
    return resumo;
  }

  private async executarEmpresas(resumo: ResumoManutencaoOnline): Promise<void> {
    const { rows } = await this.controle.pool.query<{ empresa_id: string }>(
      `select distinct t.empresa_id
         from terminais_pdv t
         join empresas e on e.id = t.empresa_id and e.excluido_em is null
        where t.ultimo_contato_em > now() - make_interval(hours => $1)`,
      [RETENCAO_REQUISICAO_ONLINE_HORAS + FOLGA_CONTATO_HORAS],
    );
    for (const { empresa_id: id } of rows) {
      try {
        const empresa = await this.resolvedor.porId(id);
        if (!empresa || empresa.excluida || empresa.emManutencao || empresa.status === 'migrando') continue;
        await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), async () => {
          for (;;) {
            const n = await this.tenancy.cx().transacao((tx) => limparRequisicoesVencidas(tx, this.lote));
            resumo.requisicoesApagadas += n;
            if (n < this.lote) break;
          }
        });
        resumo.empresas++;
      } catch (e) {
        resumo.falhas.push({ empresaId: id, erro: (e as Error).message });
      }
    }
  }
}
