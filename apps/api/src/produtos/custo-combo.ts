/**
 * Custo do combo (kit) — MD 3.6.3 regra "Kit", 3.6.7; ERP 8.2.17; roadmap D16.
 *
 * O recálculo é do banco (`fn_recalcular_custo_kits`, migração 0005): os triggers `tg_produtos_componentes_custo_kit`,
 * `tg_produtos_custo_kit` e `tg_produtos_variacoes_custo_kit` o chamam na mesma transação que muda a composição, o
 * custo de um componente (qualquer caminho: cadastro, recebimento, NF-e, projeção do custo médio, importação) ou o
 * preço do combo. Este serviço é a porta da API para o mesmo cálculo: garante o valor antes de responder ao
 * cadastro do combo e permite a rotina de conferência (`recalcularTodos`) depois de cargas em massa.
 */
import { sql } from 'drizzle-orm';
import type { DbEmpresa } from '../tenancy/tenancy.js';

export class CustoCombos {
  /** Recalcula `preco_custo`, `custo_medio` e `markup_pct` dos combos indicados; devolve quantos mudaram. */
  async recalcular(tx: DbEmpresa, kits: readonly string[]): Promise<number> {
    if (!kits.length) return 0;
    const lista = sql.join(
      kits.map((k) => sql`${k}::uuid`),
      sql`, `,
    );
    const { rows } = await tx.execute<{ n: number }>(
      sql`select fn_recalcular_custo_kits(array[${lista}]::uuid[]) as n`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /** Combos em que o produto é o padrão de alguma posição (os que o recálculo automático alcança). */
  async combosDoComponente(db: DbEmpresa, produtoId: string): Promise<string[]> {
    const { rows } = await db.execute<{ id: string }>(
      sql`select distinct produto_id as id from produtos_componentes
           where componente_id = ${produtoId} and tipo = 'kit' and excluido_em is null`,
    );
    return rows.map((r) => r.id);
  }

  /** Conferência/reparo: recalcula todos os combos da empresa (ex.: depois da importação do Nuvem3). */
  async recalcularTodos(tx: DbEmpresa): Promise<number> {
    const { rows } = await tx.execute<{ n: number }>(
      sql`select fn_recalcular_custo_kits(array(select id from produtos where tipo = 'kit' and excluido_em is null)) as n`,
    );
    return Number(rows[0]?.n ?? 0);
  }
}
