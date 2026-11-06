-- 1) Projeção `produtos.custo_medio` (MD 3.6.3: média ponderada dos estoques com saldo > 0; ERP 8.2.1: somente
--    leitura, calculado pelo razão). Mantida pelo banco na MESMA transação que muda `saldos_estoque` (acerto,
--    importação, aplicação da venda, recebimento...), como o custo do combo (0005): nenhum serviço precisa lembrar.
--    Sem nenhuma linha com saldo > 0 o último custo médio fica (o produto zerado continua com o custo conhecido).
--    Variação: `produtos_variacoes` não tem custo médio próprio nesta fase; o saldo da variação entra na média do
--    produto (o combo com componente de variação usa o custo médio do produto, decisão 64).
create or replace function fn_projetar_custo_medio_produto(produto uuid) returns void language plpgsql as $$
declare
  medio numeric(15, 4);
begin
  select round(sum(s.custo_medio * s.quantidade) / sum(s.quantidade), 4) into medio
    from saldos_estoque s
   where s.produto_id = produto and s.quantidade > 0;
  if medio is not null then
    update produtos set custo_medio = medio
     where id = produto and tipo <> 'kit' and custo_medio is distinct from medio;
  end if;
end $$;
--> statement-breakpoint
create or replace function fn_saldos_estoque_custo_medio() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT'
     or old.quantidade is distinct from new.quantidade
     or old.custo_medio is distinct from new.custo_medio then
    perform fn_projetar_custo_medio_produto(new.produto_id);
  end if;
  return null;
end $$;
--> statement-breakpoint
create trigger tg_saldos_estoque_custo_medio after insert or update of quantidade, custo_medio on saldos_estoque
  for each row execute function fn_saldos_estoque_custo_medio();
--> statement-breakpoint
-- 2) Custo do combo recalculado pelo banco entra no histórico de preços (ERP 8.2: "alteração de preço ... alimenta o
--    histórico"; decisão 1 do dono: o custo do combo acompanha o dos componentes e a margem fica visível). Origem:
--    `genesis.origem_preco` da transação (a importação grava `importacao`), senão `cadastro`.
create or replace function fn_recalcular_custo_kits(kits uuid[]) returns integer language plpgsql as $$
declare
  n integer;
begin
  if kits is null or cardinality(kits) = 0 then
    return 0;
  end if;
  with custos as (
    select k.id,
           k.preco_venda,
           k.preco_custo as custo_atual,
           round(coalesce(sum(coalesce(v.preco_custo, p.preco_custo) * pc.quantidade), 0), 4) as custo,
           round(coalesce(sum(p.custo_medio * pc.quantidade), 0), 4) as medio
      from produtos k
      left join produtos_componentes pc
        on pc.produto_id = k.id and pc.tipo = 'kit' and pc.excluido_em is null
      left join produtos p on p.id = pc.componente_id
      left join produtos_variacoes v on v.id = pc.componente_variacao_id
     where k.id = any(kits) and k.tipo = 'kit' and k.excluido_em is null
     group by k.id, k.preco_venda, k.preco_custo
  ), novos as (
    select id, custo_atual, custo, medio,
           case when custo > 0
                then least(greatest(round((preco_venda / custo - 1) * 100, 4), -99999.9999), 99999.9999)
                else 0 end as markup
      from custos
  ), alterados as (
    update produtos k
       set preco_custo = n2.custo, custo_medio = n2.medio, markup_pct = n2.markup
      from novos n2
     where k.id = n2.id
       and (k.preco_custo, k.custo_medio, k.markup_pct) is distinct from (n2.custo, n2.medio, n2.markup)
    returning k.id, n2.custo_atual, n2.custo
  ), historico as (
    insert into produtos_historico_precos (id, produto_id, tipo_preco, valor_anterior, valor_novo, origem)
    select fn_uuid_v7(), a.id, 'custo', a.custo_atual, a.custo,
           coalesce(nullif(current_setting('genesis.origem_preco', true), ''), 'cadastro')
      from alterados a
     where a.custo_atual is distinct from a.custo
    returning 1
  )
  select count(*) into n from alterados;
  return n;
end $$;
--> statement-breakpoint
-- 3) Exclusão física de posição (script, correção manual): o combo também é recalculado (antes ficava com o custo
--    antigo até o `recalcularTodos`).
create or replace function fn_produtos_componentes_custo_kit_exclusao() returns trigger language plpgsql as $$
begin
  if old.tipo = 'kit' then
    perform fn_recalcular_custo_kits(array[old.produto_id]);
  end if;
  return null;
end $$;
--> statement-breakpoint
create trigger tg_produtos_componentes_custo_kit_exclusao after delete on produtos_componentes
  for each row execute function fn_produtos_componentes_custo_kit_exclusao();
--> statement-breakpoint
-- Produtos que já tenham saldo entram projetados.
select fn_projetar_custo_medio_produto(p.id)
  from produtos p
 where exists (select 1 from saldos_estoque s where s.produto_id = p.id and s.quantidade > 0);
