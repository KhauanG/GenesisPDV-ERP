/**
 * Índices de leitura do razão para os relatórios de estoque (Fase 2, F2-B28; README da API › decisão 176). Só entra o
 * que a medição com a massa de carga (`test/carga/massa-razao.ts`, 4 milhões de movimentos) justificou; os
 * números, os planos e os candidatos descartados estão na decisão. Pelo executor (provisionamento da empresa nova,
 * `db:migrate:empresas`, o botão da plataforma) cada índice nasce **fora da transação da migração**, com `create index
 * concurrently` (a preparação da `0026_indices_razao`, `PREPARACOES_MIGRACAO_EMPRESA`): as vendas do PDV continuam
 * gravando enquanto ele é montado. A `.sql` só o cria no journal aplicado sem as preparações, e só quando o nome não
 * existe (consulta ao `pg_class`, sem pegar trava na tabela), como a 0017.
 */
import type { ConexaoSql } from './cadeia.js';

export interface IndiceRazao {
  nome: string;
  /** O que vem depois de `on movimentos_estoque` (método, colunas e o `where` de um parcial). */
  definicao: string;
  /** Para que serve (relato da migração e da massa de carga). */
  uso: string;
}

/**
 * Os dois índices da `0026_indices_razao.sql` (a mesma definição lá; o teste `migracao-indices-razao` compara o
 * `pg_get_indexdef` do journal aplicado sem as preparações com o da empresa provisionada):
 * - `(estoque_id, data_movimento, id)`: a Movimentação analítica (F2-B32) de um local num período, na ordem do cursor
 *   (`data_movimento`, `id`), e a exportação dela em streaming (F2-B29/F2-B33) sem ordenar o período inteiro. Também
 *   no schema Drizzle (`estoque.ts`).
 * - `(estoque_id, produto_id, variacao_id, tipo_estoque_id, data_movimento, id) include (quantidade)`: o saldo de cada
 *   linha de saldo até um ponto do cursor só pelo índice (`Index Only Scan`, sem ler a tabela): o saldo anterior da
 *   página da Movimentação (F2-B32, "recalculado por janela") e o saldo numa data de uma linha. Fora do schema Drizzle,
 *   que não declara `include` (como o BRIN e os únicos parciais da tabela, nas migrações customizadas).
 */
export const INDICES_RAZAO: readonly IndiceRazao[] = [
  {
    nome: 'ix_movimentos_estoque_estoque_data',
    definicao: 'using btree (estoque_id, data_movimento, id)',
    uso: 'Movimentação de um local por período, paginada por (data_movimento, id)',
  },
  {
    nome: 'ix_movimentos_estoque_linha_data',
    definicao:
      'using btree (estoque_id, produto_id, variacao_id, tipo_estoque_id, data_movimento, id) include (quantidade)',
    uso: 'Saldo de cada linha até um ponto do cursor (saldo anterior da página), só pelo índice',
  },
];

export type SituacaoIndice = 'existente' | 'criado' | 'recriado';

export interface IndiceGarantido {
  nome: string;
  situacao: SituacaoIndice;
  duracaoMs: number;
}

/**
 * Cria os `INDICES_RAZAO` que faltam sem bloquear as gravações (`concurrently`, por isso fora de transação e com a role
 * dona). Um `concurrently` interrompido deixa o índice inválido com o mesmo nome (o `if not exists` o aceitaria): é
 * apagado e refeito. Idempotente: a segunda passada só confere.
 */
export async function garantirIndicesRazao(cliente: ConexaoSql): Promise<IndiceGarantido[]> {
  const resultado: IndiceGarantido[] = [];
  for (const indice of INDICES_RAZAO) {
    const inicio = Date.now();
    const { rows } = await cliente.query<{ valido: boolean }>(
      `select i.indisvalid as valido from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = $1 and c.relnamespace = 'public'::regnamespace`,
      [indice.nome],
    );
    if (rows[0]?.valido) {
      resultado.push({ nome: indice.nome, situacao: 'existente', duracaoMs: 0 });
      continue;
    }
    if (rows[0]) await cliente.query(`drop index concurrently if exists ${indice.nome}`);
    await cliente.query(
      `create index concurrently if not exists ${indice.nome} on movimentos_estoque ${indice.definicao}`,
    );
    resultado.push({
      nome: indice.nome,
      situacao: rows[0] ? 'recriado' : 'criado',
      duracaoMs: Date.now() - inicio,
    });
  }
  return resultado;
}
