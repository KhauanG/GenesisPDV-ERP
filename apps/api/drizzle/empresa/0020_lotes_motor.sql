-- Lote no motor de estoque (Fase 2, F2-B6; MD 3.6.9, 3.7.4; F2-Q7 = D48; README da API › decisão 151). A partir desta
-- versão o motor (`apps/api/src/estoques/movimentos.ts`) mantém `saldos_lote` na mesma transação do movimento, e a
-- saída sem lote de produto com lote é dividida em FEFO (`estoque.lote_baixa_sem_informar`, só no catálogo do shared:
-- sem linha em `configuracoes` vale o padrão 'fefo'). Nada a migrar de dados: até aqui nenhum movimento tinha lote e
-- nenhuma linha de `saldos_lote` existia; o que entrar antes desta versão se refaz com `db:recalcular-saldos --corrigir`.
--
-- O `estoque_id` do lote já era imutável (`tg_produtos_lotes_filtro_imutavel`, 0004: filtro do pull). O produto e a
-- variação do lote passam a ser também: o saldo por lote e o razão apontam para o lote, e um lote "movido" para outro
-- produto levaria junto o saldo de um produto para outro sem movimento nenhum. Trocar = excluir e criar outro lote.
create trigger tg_produtos_lotes_produto_imutavel before update on produtos_lotes
  for each row execute function fn_filtro_imutavel('produto_id', 'variacao_id');
--> statement-breakpoint
-- Segunda barreira do motor (que confere antes de gravar e recusa com `ErroLoteInvalido`): o movimento com lote é do
-- produto e da variação do lote, e o lote é do estoque do movimento ou não tem estoque (MD 3.6.9). Só roda no
-- movimento com lote (`when`): a venda comum não paga nada.
create or replace function fn_movimentos_estoque_lote() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from produtos_lotes l
                  where l.id = new.lote_id and l.produto_id = new.produto_id
                    and l.variacao_id is not distinct from new.variacao_id
                    and (l.estoque_id is null or l.estoque_id = new.estoque_id)) then
    raise exception using errcode = 'P0001', message = 'LOTE_INVALIDO', detail = new.lote_id::text;
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_movimentos_estoque_lote before insert on movimentos_estoque
  for each row when (new.lote_id is not null) execute function fn_movimentos_estoque_lote();
