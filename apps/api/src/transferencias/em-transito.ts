/**
 * "Em trânsito" (ERP 13.7 e 8.2.11; Fase 2, F2-B25; README da API › decisão 173): o que já saiu da origem
 * (`TRANSF_SAIDA`) e ainda não entrou no destino — a soma das quantidades **enviadas** dos itens das transferências
 * `em_transito`, por estoque de **destino**, tipo de estoque, produto e variação. Enquanto a transferência está em
 * trânsito nada foi recebido (a recebida só é gravada na saída do trânsito), então a enviada inteira está a caminho.
 * A diferença recebida a menor (`recebida_divergencia`) **não** conta: é a "divergência a tratar", uma pendência
 * separada (F2-B26). O rascunho também não (não saiu nada) e a cancelada voltou à origem.
 *
 * A sugestão de reposição (F2-B25) desconta o que está a caminho da loja; a coluna "Em trânsito" do produto e dos
 * saldos (F2-B26; README da API › decisão 174) usa a mesma subconsulta, com os filtros que precisar, junto com a
 * "Divergência a tratar" (`sqlDivergenciaATratar`) em `sqlPendenciasTransferencia`.
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

export interface FiltroDivergencia {
  /** Estoques de origem (vazio ou ausente = todos). */
  estoqueOrigemIds?: readonly string[];
  /** Produtos (vazio ou ausente = todos). */
  produtoIds?: readonly string[];
  /** Tipo de estoque (ausente = todos). */
  tipoEstoqueId?: string;
}

/**
 * "Divergência a tratar" (F2-B26; README da API › decisão 174; padrão "divergência separada" do plano da Fase 2): a
 * soma das diferenças (`itens_transferencia.diferenca`, enviada − recebida) dos itens **ainda não tratados** das
 * transferências `recebida_divergencia`, por estoque de **origem**, tipo de estoque, produto e variação. Fica na
 * origem porque o tratamento (decisão 172) lança tudo nela: "Retornar à origem" devolve a diferença ao saldo dela, e
 * "Baixar como perda" devolve e baixa no mesmo instante; ao destino a diferença não chega mais (o em trânsito dele já
 * zerou no recebimento, e a sugestão de reposição volta a pedir o que faltou). A diferença por item basta aqui: a
 * repartição pelas partes da saída (o lote de cada uma) só importa para o tratamento, que a refaz das saídas e da
 * recebida gravada. Mesmas colunas de `sqlEmTransito`.
 */
export function sqlDivergenciaATratar(f: FiltroDivergencia = {}): SQL {
  const condicoes: SQL[] = [
    sql`t.status = 'recebida_divergencia'`,
    sql`t.excluido_em is null`,
    sql`i.excluido_em is null`,
    sql`i.tratamento_divergencia is null`,
    sql`i.diferenca > 0`,
  ];
  if (f.estoqueOrigemIds?.length)
    condicoes.push(sql`t.estoque_origem_id = any(${lista(f.estoqueOrigemIds)}::uuid[])`);
  if (f.produtoIds?.length) condicoes.push(sql`i.produto_id = any(${lista(f.produtoIds)}::uuid[])`);
  if (f.tipoEstoqueId) condicoes.push(sql`t.tipo_estoque_id = ${f.tipoEstoqueId}::uuid`);
  return sql`
    select t.estoque_origem_id as estoque_id, t.tipo_estoque_id, i.produto_id, i.variacao_id,
           sum(i.diferenca) as quantidade
      from itens_transferencia i
      join transferencias_estoque t on t.id = i.transferencia_id
     where ${sql.join(condicoes, sql` and `)}
     group by t.estoque_origem_id, t.tipo_estoque_id, i.produto_id, i.variacao_id`;
}

export interface FiltroPendencias {
  /** Produtos (vazio ou ausente = todos). */
  produtoIds?: readonly string[];
}

/**
 * As duas pendências da transferência por chave de saldo (F2-B26): `em_transito` (no destino, `sqlEmTransito`) e
 * `divergencia` (na origem, `sqlDivergenciaATratar`), `numeric(15,3)` com zero na que não houver, uma linha por
 * `estoque_id`, `tipo_estoque_id`, `produto_id` e `variacao_id`. Use-a como a CTE `pd` de
 * `sqlSaldosComPendencias`.
 */
export function sqlPendenciasTransferencia(f: FiltroPendencias = {}): SQL {
  return sql`
    select u.estoque_id, u.tipo_estoque_id, u.produto_id, u.variacao_id,
           sum(u.em_transito)::numeric(15,3) as em_transito, sum(u.divergencia)::numeric(15,3) as divergencia
      from (select tr.estoque_id, tr.tipo_estoque_id, tr.produto_id, tr.variacao_id,
                   tr.quantidade as em_transito, 0::numeric as divergencia
              from (${sqlEmTransito({ produtoIds: f.produtoIds })}) tr
            union all
            select dv.estoque_id, dv.tipo_estoque_id, dv.produto_id, dv.variacao_id,
                   0::numeric, dv.quantidade
              from (${sqlDivergenciaATratar({ produtoIds: f.produtoIds })}) dv) u
     group by u.estoque_id, u.tipo_estoque_id, u.produto_id, u.variacao_id`;
}

/**
 * As linhas de `saldos_estoque` (com as colunas que as consultas de saldo usam: `estoque_id`, `produto_id`,
 * `variacao_id`, `tipo_estoque_id`, `quantidade`, `custo_medio`, `ultima_entrada_em`, `ultima_saida_em`) **mais** uma
 * linha zerada para cada chave com pendência de transferência e ainda sem saldo lançado (as 60 unidades a caminho da
 * loja que nunca recebeu o produto aparecem no destino com saldo zero). Exige a CTE `pd`
 * (`sqlPendenciasTransferencia`) na mesma consulta; use-a no lugar de `saldos_estoque s`.
 */
export function sqlSaldosComPendencias(f: FiltroPendencias = {}): SQL {
  const doProduto = (col: SQL) =>
    f.produtoIds?.length ? sql`and ${col} = any(${lista(f.produtoIds)}::uuid[])` : sql``;
  return sql`
    select s0.estoque_id, s0.produto_id, s0.variacao_id, s0.tipo_estoque_id, s0.quantidade, s0.custo_medio,
           s0.ultima_entrada_em, s0.ultima_saida_em
      from saldos_estoque s0
     where true ${doProduto(sql`s0.produto_id`)}
    union all
    select pd.estoque_id, pd.produto_id, pd.variacao_id, pd.tipo_estoque_id, 0::numeric(15,3), 0::numeric(15,4),
           null::timestamptz, null::timestamptz
      from pd
     where not exists (select 1 from saldos_estoque s1
                        where s1.estoque_id = pd.estoque_id and s1.produto_id = pd.produto_id
                          and s1.tipo_estoque_id = pd.tipo_estoque_id
                          and s1.variacao_id is not distinct from pd.variacao_id)
       ${doProduto(sql`pd.produto_id`)}`;
}
