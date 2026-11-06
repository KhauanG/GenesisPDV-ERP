-- Custo do combo (kit) calculado e mantido pelo banco (MD 3.6.3 regra "Kit", 3.6.7; ERP 8.2.17; roadmap D16):
-- preco_custo = Σ (custo do componente padrão × quantidade) e custo_medio = Σ (custo médio do padrão × quantidade),
-- recalculados na MESMA transação que muda a composição, o custo de um componente (edição, recebimento, NF-e,
-- projeção do custo médio) ou o preço do combo (markup_pct acompanha: (preco_venda ÷ preco_custo − 1) × 100).
-- O preço de venda do combo nunca é derivado do custo. Componente com variação usa o custo da variação, se houver.
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
           round(coalesce(sum(coalesce(v.preco_custo, p.preco_custo) * pc.quantidade), 0), 4) as custo,
           round(coalesce(sum(p.custo_medio * pc.quantidade), 0), 4) as medio
      from produtos k
      left join produtos_componentes pc
        on pc.produto_id = k.id and pc.tipo = 'kit' and pc.excluido_em is null
      left join produtos p on p.id = pc.componente_id
      left join produtos_variacoes v on v.id = pc.componente_variacao_id
     where k.id = any(kits) and k.tipo = 'kit' and k.excluido_em is null
     group by k.id, k.preco_venda
  ), novos as (
    select id, custo, medio,
           case when custo > 0
                then least(greatest(round((preco_venda / custo - 1) * 100, 4), -99999.9999), 99999.9999)
                else 0 end as markup
      from custos
  )
  update produtos k
     set preco_custo = n2.custo, custo_medio = n2.medio, markup_pct = n2.markup
    from novos n2
   where k.id = n2.id
     and (k.preco_custo, k.custo_medio, k.markup_pct) is distinct from (n2.custo, n2.medio, n2.markup);
  get diagnostics n = row_count;
  return n;
end $$;
--> statement-breakpoint
create or replace function fn_produtos_componentes_custo_kit() returns trigger language plpgsql as $$
-- Posição do combo criada, alterada (quantidade, produto padrão, variação) ou excluída logicamente.
begin
  if new.tipo = 'kit' or (tg_op = 'UPDATE' and old.tipo = 'kit') then
    perform fn_recalcular_custo_kits(array_remove(array[new.produto_id,
             case when tg_op = 'UPDATE' and old.produto_id <> new.produto_id then old.produto_id end], null));
  end if;
  return null;
end $$;
--> statement-breakpoint
create or replace function fn_produtos_custo_kit() returns trigger language plpgsql as $$
-- Custo de um produto mudou: recalcula os combos em que ele é o padrão de alguma posição. Preço do próprio combo
-- mudou: recalcula o markup dele. (Combo não é componente de combo, então a recursão para no primeiro nível.)
declare
  kits uuid[];
begin
  if old.preco_custo is distinct from new.preco_custo or old.custo_medio is distinct from new.custo_medio then
    select array_agg(distinct pc.produto_id) into kits
      from produtos_componentes pc
     where pc.componente_id = new.id and pc.tipo = 'kit' and pc.excluido_em is null;
  end if;
  if new.tipo = 'kit' and (old.preco_venda is distinct from new.preco_venda or old.tipo is distinct from new.tipo) then
    kits := coalesce(kits, '{}') || new.id;
  end if;
  perform fn_recalcular_custo_kits(kits);
  return null;
end $$;
--> statement-breakpoint
create or replace function fn_produtos_variacoes_custo_kit() returns trigger language plpgsql as $$
begin
  perform fn_recalcular_custo_kits((select array_agg(distinct pc.produto_id)
                                      from produtos_componentes pc
                                     where pc.componente_variacao_id = new.id and pc.tipo = 'kit'
                                       and pc.excluido_em is null));
  return null;
end $$;
--> statement-breakpoint
create trigger tg_produtos_componentes_custo_kit after insert or update on produtos_componentes
  for each row execute function fn_produtos_componentes_custo_kit();
--> statement-breakpoint
create trigger tg_produtos_custo_kit after update of preco_custo, custo_medio, preco_venda, tipo on produtos
  for each row execute function fn_produtos_custo_kit();
--> statement-breakpoint
create trigger tg_produtos_variacoes_custo_kit after update of preco_custo on produtos_variacoes
  for each row when (old.preco_custo is distinct from new.preco_custo)
  execute function fn_produtos_variacoes_custo_kit();
--> statement-breakpoint
-- Combos que já existam (migração do Nuvem3 antes desta versão) entram calculados.
select fn_recalcular_custo_kits(array(select id from produtos where tipo = 'kit' and excluido_em is null));
