/**
 * "Em trânsito" (ERP 13.7 e 8.2.11; Fase 2, F2-B25; README da API › decisão 173): o que já saiu da origem
 * (`TRANSF_SAIDA`) e ainda não entrou no destino — a soma das quantidades **enviadas** dos itens das transferências
 * `em_transito`, por estoque de **destino**, tipo de estoque, produto e variação. Enquanto a transferência está em
 * trânsito nada foi recebido (a recebida só é gravada na saída do trânsito), então a enviada inteira está a caminho.
 * A diferença recebida a menor (`recebida_divergencia`) **não** conta: é a "divergência a tratar", uma pendência
 * separada (F2-B26). O rascunho também não (não saiu nada) e a cancelada voltou à origem.
 *
 * A sugestão de reposição (F2-B25) desconta o que está a caminho da loja; a coluna "Em trânsito" do produto e dos
 * saldos (F2-B26) usa a mesma subconsulta, com os filtros que precisar.
 */
import { sql, type SQL } from 'drizzle-orm';

const lista = (ids: Iterable<string>) => `{${[...new Set([...ids].map((i) => i.toLowerCase()))].join(',')}}`;

export interface FiltroEmTransito {
  /** Estoques de destino (vazio ou ausente = todos). */
  estoqueDestinoIds?: readonly string[];
  /** Produtos (vazio ou ausente = todos). */
  produtoIds?: readonly string[];
  /** Tipo de estoque (ausente = todos). */
  tipoEstoqueId?: string;
}

/**
 * Subconsulta com as colunas `estoque_id` (o destino), `tipo_estoque_id`, `produto_id`, `variacao_id` e `quantidade`
 * (`numeric(15,3)`, sempre > 0), uma linha por chave de saldo; use-a como `left join (${sqlEmTransito(...)}) tr on …`.
 * A `variacao_id` é nula enquanto as variações estão travadas (D43), e o join a compara com `is not distinct from`.
 */
export function sqlEmTransito(f: FiltroEmTransito = {}): SQL {
  const condicoes: SQL[] = [
    sql`t.status = 'em_transito'`,
    sql`t.excluido_em is null`,
    sql`i.excluido_em is null`,
  ];
  if (f.estoqueDestinoIds?.length)
    condicoes.push(sql`t.estoque_destino_id = any(${lista(f.estoqueDestinoIds)}::uuid[])`);
  if (f.produtoIds?.length) condicoes.push(sql`i.produto_id = any(${lista(f.produtoIds)}::uuid[])`);
  if (f.tipoEstoqueId) condicoes.push(sql`t.tipo_estoque_id = ${f.tipoEstoqueId}::uuid`);
  return sql`
    select t.estoque_destino_id as estoque_id, t.tipo_estoque_id, i.produto_id, i.variacao_id,
           sum(i.quantidade_enviada) as quantidade
      from itens_transferencia i
      join transferencias_estoque t on t.id = i.transferencia_id
     where ${sql.join(condicoes, sql` and `)}
     group by t.estoque_destino_id, t.tipo_estoque_id, i.produto_id, i.variacao_id`;
}
