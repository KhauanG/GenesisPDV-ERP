-- Importação do Nuvem3 (ERP 8.6): o saldo real exportado pode ser negativo e o acerto "Definir" da importação leva o
-- saldo a esse valor. A quantidade informada negativa só vale no "Definir" (Entrada/Saída continuam > 0 pela API e
-- ≥ 0 aqui); o check antigo não enxerga o tipo do acerto, então vira trigger.
ALTER TABLE "itens_acerto_estoque" DROP CONSTRAINT "ck_itens_acerto_estoque_quantidade";
--> statement-breakpoint
create or replace function fn_itens_acerto_estoque_quantidade() returns trigger language plpgsql as $$
begin
  if new.quantidade_informada < 0
     and not exists (select 1 from acertos_estoque a where a.id = new.acerto_id and a.tipo_ajuste = 'definir') then
    raise exception using errcode = '23514', message = 'ck_itens_acerto_estoque_quantidade',
      detail = 'Quantidade negativa só no acerto "Definir".';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_itens_acerto_estoque_quantidade before insert or update of quantidade_informada on itens_acerto_estoque
  for each row execute function fn_itens_acerto_estoque_quantidade();
