-- Índices de leitura do razão para os relatórios de estoque (Fase 2, F2-B28; README da API › decisão 176), medidos com
-- 4 milhões de movimentos (`pnpm --filter api carga:razao`; os outros candidatos foram descartados, na decisão):
-- * `ix_movimentos_estoque_estoque_data (estoque_id, data_movimento, id)`: a Movimentação de um local por período na
--   ordem do cursor (`data_movimento`, `id`, F2-B32) e a exportação dela em streaming (F2-B29/F2-B33), sem ordenar o
--   período inteiro;
-- * `ix_movimentos_estoque_linha_data (estoque_id, produto_id, variacao_id, tipo_estoque_id, data_movimento, id)
--   include (quantidade)`: o saldo de cada linha até um ponto do cursor só pelo índice (o saldo anterior da página).
--   Fora do schema Drizzle, que não declara `include`.
-- Pelo executor (provisionamento, `db:migrate:empresas`, o botão da plataforma) quem os cria é a preparação desta tag,
-- **fora da transação** e com `concurrently` (`PREPARACOES_MIGRACAO_EMPRESA`, `estoques/indices-razao.ts`, a mesma
-- definição de lá): as vendas continuam gravando enquanto são montados. Aqui eles só nascem no journal aplicado sem as
-- preparações; o inválido de um `concurrently` interrompido é refeito. Sem `create index if not exists` solto: ele
-- pega a trava SHARE da tabela (que barra as gravações) antes de ver que o índice existe, e na empresa existente a
-- migração ficaria na fila das vendas até o `lock_timeout`. Com os índices válidos este bloco não trava nada.
do $$
declare
  indice record;
begin
  for indice in
    select * from (values
      ('ix_movimentos_estoque_estoque_data', 'using btree (estoque_id, data_movimento, id)'),
      ('ix_movimentos_estoque_linha_data',
       'using btree (estoque_id, produto_id, variacao_id, tipo_estoque_id, data_movimento, id) include (quantidade)')
    ) as v (nome, definicao)
  loop
    if exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
                where c.relname = indice.nome and c.relnamespace = 'public'::regnamespace and not i.indisvalid) then
      execute format('drop index public.%I', indice.nome);
    end if;
    if not exists (select 1 from pg_class c
                    where c.relname = indice.nome and c.relnamespace = 'public'::regnamespace) then
      execute format('create index %I on public.movimentos_estoque %s', indice.nome, indice.definicao);
    end if;
  end loop;
end $$;
