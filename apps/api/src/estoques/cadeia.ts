/**
 * Cadeia do razão por linha de saldo (Fase 2, F2-B2; MD 3.7.2): na ordem de lançamento (`seq_lancamento`), o
 * `saldo_anterior` de cada movimento é o `saldo_posterior` do anterior, e o primeiro parte de zero (a linha de saldo
 * nasce zerada, `travarSaldo`). Uma quebra quer dizer que o razão, refeito nessa ordem, não chega ao mesmo saldo: o
 * preenchimento da ordem dos movimentos antigos (`seq-lancamento.ts`) a relata, e o `db:recalcular-saldos` (F2-B3)
 * reaproveita a mesma conferência.
 *
 * As funções puras (`primeiraQuebra`, `ordenarCadeia`) recebem os saldos como texto do `numeric`; a comparação é em
 * decimal com 3 casas, como a coluna.
 */
import { dec, decTexto, type Valor } from '@genesis/shared';
import type { ChaveSaldo } from './movimentos.js';

/**
 * O mínimo de uma conexão do `pg` que estas funções usam: o cliente do executor de migrações ou de um comando (role
 * dona) e o `ClienteEmpresa` do tenancy servem. O módulo não abre conexão (só o tenancy, a plataforma e os comandos).
 */
export interface ConexaoSql {
  query<R extends object = Record<string, unknown>>(
    texto: string,
    valores?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/** O mínimo de um movimento para conferir ou montar a cadeia. */
export interface EloCadeia {
  id: string;
  /** `numeric(15,3)` como texto. */
  saldoAnterior: string;
  saldoPosterior: string;
}

export interface QuebraCadeia {
  /** Posição (a partir de 1) do primeiro movimento fora da cadeia, na ordem conferida. */
  posicao: number;
  movimentoId: string;
  /** O `saldo_posterior` do movimento anterior (zero no primeiro). */
  saldoEsperado: string;
  /** O `saldo_anterior` gravado no movimento. */
  saldoAnterior: string;
}

const texto3 = (v: Valor) => decTexto(v, 3);

/** O primeiro elo cujo `saldo_anterior` não é o `saldo_posterior` do anterior (o primeiro parte de `saldoInicial`). */
export function primeiraQuebra(elos: readonly EloCadeia[], saldoInicial: Valor = 0): QuebraCadeia | null {
  let esperado = dec(saldoInicial);
  for (let i = 0; i < elos.length; i++) {
    const e = elos[i]!;
    if (!dec(e.saldoAnterior).eq(esperado)) {
      return {
        posicao: i + 1,
        movimentoId: e.id,
        saldoEsperado: texto3(esperado),
        saldoAnterior: texto3(e.saldoAnterior),
      };
    }
    esperado = dec(e.saldoPosterior);
  }
  return null;
}

/**
 * A ordem de lançamento dos movimentos de uma linha que ainda não têm `seq_lancamento` (F2-B2): encadeia pelo saldo, a
 * partir de zero, cada passo tomando o movimento cujo `saldo_anterior` é o saldo corrente; entre vários (a linha voltou
 * ao mesmo saldo), o de menor `id` (UUIDv7, gerado no Node já com a linha travada, então cresce com o lançamento). O
 * `criado_em` **não** entra no encadeamento: é a hora de início da transação, igual para todos os movimentos dela.
 *
 * Se o encadeamento para antes do fim (cadeia quebrada no banco), a linha fica na ordem recebida, que quem chama traz
 * por (`criado_em`, `id`), e a quebra volta para o relatório — salvo quando essa ordem é ela mesma contínua (o
 * desempate por `id` escolheu um ramo sem saída), e aí não há quebra.
 */
export function ordenarCadeia(elos: readonly EloCadeia[]): {
  ordem: EloCadeia[];
  quebra: QuebraCadeia | null;
} {
  const porSaldo = new Map<string, EloCadeia[]>();
  for (const e of elos) {
    const k = texto3(e.saldoAnterior);
    const fila = porSaldo.get(k);
    if (fila) fila.push(e);
    else porSaldo.set(k, [e]);
  }
  // Cada fila em ordem decrescente de id: o `pop` tira o menor.
  for (const fila of porSaldo.values()) fila.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const ordem: EloCadeia[] = [];
  let saldo = texto3(0);
  for (;;) {
    const proximo = porSaldo.get(saldo)?.pop();
    if (!proximo) break;
    ordem.push(proximo);
    saldo = texto3(proximo.saldoPosterior);
  }
  if (ordem.length === elos.length) return { ordem, quebra: null };
  return { ordem: [...elos], quebra: primeiraQuebra(elos) };
}

/** Resultado da conferência de uma linha de saldo pela ordem gravada (`seq_lancamento`). */
export interface CadeiaLinha {
  movimentos: number;
  /** Movimentos fora da cadeia (cada um com `saldo_anterior` ≠ o `saldo_posterior` do anterior). */
  quebras: number;
  /** `saldo_posterior` do último movimento (nulo sem movimento). */
  saldoFinal: string | null;
  primeiraQuebra: (QuebraCadeia & { seqLancamento: number | null }) | null;
}

/**
 * `verificarCadeia(linha)` em SQL (F2-B2; reaproveitado pelo F2-B3): confere a cadeia de uma linha de saldo na ordem
 * de lançamento, com o `lag` do `saldo_posterior`, sem trazer os movimentos para a memória. Lê pelo
 * `ix_movimentos_estoque_linha_seq`. Movimento ainda sem ordem (antes do preenchimento) fica no fim, por `id`.
 */
export async function verificarCadeia(cliente: ConexaoSql, linha: ChaveSaldo): Promise<CadeiaLinha> {
  const { rows } = await cliente.query<{
    movimentos: number;
    quebras: number;
    saldo_final: string | null;
    posicao: string | null;
    id: string | null;
    seq_lancamento: string | null;
    esperado: string | null;
    saldo_anterior: string | null;
  }>(
    `with c as (
       select id, seq_lancamento, saldo_anterior, saldo_posterior,
              coalesce(lag(saldo_posterior) over w, 0) as esperado,
              row_number() over w as posicao
         from movimentos_estoque
        where estoque_id = $1 and produto_id = $2 and variacao_id is not distinct from $3 and tipo_estoque_id = $4
       window w as (order by seq_lancamento nulls last, id)
     )
     select (select count(*) from c)::int as movimentos,
            (select count(*) from c where saldo_anterior <> esperado)::int as quebras,
            (select saldo_posterior::text from c order by posicao desc limit 1) as saldo_final,
            q.posicao::text, q.id, q.seq_lancamento::text, q.esperado::text, q.saldo_anterior::text
       from (select 1) as um
       left join lateral (
         select * from c where saldo_anterior <> esperado order by posicao limit 1
       ) as q on true`,
    [linha.estoqueId, linha.produtoId, linha.variacaoId, linha.tipoEstoqueId],
  );
  const r = rows[0]!;
  return {
    movimentos: r.movimentos,
    quebras: r.quebras,
    saldoFinal: r.saldo_final,
    primeiraQuebra:
      r.id === null
        ? null
        : {
            posicao: Number(r.posicao),
            movimentoId: r.id,
            seqLancamento: r.seq_lancamento === null ? null : Number(r.seq_lancamento),
            saldoEsperado: r.esperado!,
            saldoAnterior: r.saldo_anterior!,
          },
  };
}

/**
 * Todas as linhas com a cadeia quebrada na ordem gravada (a primeira quebra de cada uma, com o total de movimentos da
 * linha), numa varredura só do razão, particionada por linha de saldo. Para conferência do banco inteiro: testes, o
 * relatório do `db:preencher-seq-lancamento` (que vale também depois da migração, sem nada a preencher) e o do F2-B3.
 */
export async function linhasComCadeiaQuebrada(
  cliente: ConexaoSql,
): Promise<Array<ChaveSaldo & QuebraCadeia & { movimentos: number }>> {
  const { rows } = await cliente.query<{
    estoque_id: string;
    produto_id: string;
    variacao_id: string | null;
    tipo_estoque_id: string;
    id: string;
    posicao_texto: string;
    movimentos: number;
    esperado: string;
    saldo_anterior: string;
  }>(
    `select distinct on (estoque_id, produto_id, variacao_id, tipo_estoque_id)
            estoque_id, produto_id, variacao_id, tipo_estoque_id, id, c.posicao::text as posicao_texto,
            c.movimentos::int as movimentos, esperado::text, saldo_anterior::text
       from (
         select estoque_id, produto_id, variacao_id, tipo_estoque_id, id, saldo_anterior,
                coalesce(lag(saldo_posterior) over w, 0) as esperado,
                row_number() over w as posicao,
                count(*) over (partition by estoque_id, produto_id, variacao_id, tipo_estoque_id) as movimentos
           from movimentos_estoque
         window w as (partition by estoque_id, produto_id, variacao_id, tipo_estoque_id
                      order by seq_lancamento nulls last, id)
       ) as c
      where saldo_anterior <> esperado
      order by estoque_id, produto_id, variacao_id, tipo_estoque_id, c.posicao`,
  );
  return rows.map((r) => ({
    estoqueId: r.estoque_id,
    produtoId: r.produto_id,
    variacaoId: r.variacao_id,
    tipoEstoqueId: r.tipo_estoque_id,
    posicao: Number(r.posicao_texto),
    movimentos: r.movimentos,
    movimentoId: r.id,
    saldoEsperado: r.esperado,
    saldoAnterior: r.saldo_anterior,
  }));
}
