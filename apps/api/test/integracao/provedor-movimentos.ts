/**
 * Provedor de exemplo da exportação de relatório (F2-B29): os movimentos do razão, como a Movimentação analítica do
 * F2-B32 vai ler (por local, na ordem `(estoque_id, data_movimento, id)` do `ix_movimentos_estoque_estoque_data`), com
 * o filtro dos estoques permitidos e as colunas de custo marcadas. Só os testes o registram: os relatórios de verdade
 * chegam com os blocos F2-B31 a F2-B33.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { estoqueVisivel } from '../../src/estoques/permitidos.js';
import type { ProvedorRelatorio } from '../../src/tarefas/exportar-relatorio.js';

export const CHAVE_MOVIMENTOS_TESTE = 'movimentos-teste';

export interface LinhaMovimentoTeste {
  id: string;
  data_movimento: Date;
  estoque: string;
  codigo: number;
  produto: string;
  tipo_movimento: string;
  quantidade: string;
  saldo_posterior: string;
  custo_unitario: string;
  custo_total: string;
}

const filtros = z.object({ estoqueId: z.uuid().optional() });

export function provedorMovimentosTeste(
  observar: { linha?: (l: LinhaMovimentoTeste) => void } = {},
): ProvedorRelatorio<z.infer<typeof filtros>, LinhaMovimentoTeste> {
  return {
    chave: CHAVE_MOVIMENTOS_TESTE,
    nomeArquivo: 'Relatorio_Movimentos_Teste',
    permissao: 'relatorios.movimentacao_estoque',
    entidade: 'movimentos_estoque',
    localizacao: 'Relatórios › Movimentos (teste)',
    filtros,
    colunas: () => [
      {
        rotulo: 'Data',
        valor: (l) => {
          observar.linha?.(l);
          return l.data_movimento;
        },
      },
      { rotulo: 'Estoque', valor: (l) => l.estoque },
      { rotulo: 'Código', valor: (l) => l.codigo },
      { rotulo: 'Produto', valor: (l) => l.produto, largura: 30 },
      { rotulo: 'Movimento', valor: (l) => l.tipo_movimento },
      { rotulo: 'Quantidade', valor: (l) => Number(l.quantidade) },
      { rotulo: 'Saldo', valor: (l) => Number(l.saldo_posterior) },
      { rotulo: 'Custo unitário', valor: (l) => Number(l.custo_unitario), custo: true },
      { rotulo: 'Custo total', valor: (l) => Number(l.custo_total), custo: true },
    ],
    consulta: (sessao, f) => sql`
      select m.id, m.data_movimento, e.nome as estoque, p.codigo, p.nome as produto, m.tipo_movimento,
             m.quantidade::text, m.saldo_posterior::text, m.custo_unitario::text, m.custo_total::text
        from movimentos_estoque m
        join estoques e on e.id = m.estoque_id
        join produtos p on p.id = m.produto_id
       where true
         ${f.estoqueId ? sql`and m.estoque_id = ${f.estoqueId}` : sql``}
         ${estoqueVisivel(sessao, sql`m.estoque_id`) ? sql`and ${estoqueVisivel(sessao, sql`m.estoque_id`)}` : sql``}
       order by m.estoque_id, m.data_movimento, m.id`,
  };
}
