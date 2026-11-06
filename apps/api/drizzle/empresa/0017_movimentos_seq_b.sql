-- Ordem de lançamento do razão, etapa B (Fase 2, F2-B2; README da API › decisão 146). Antes dela o executor de
-- migrações roda o preenchimento dos movimentos antigos fora da transação (`PREPARACOES_MIGRACAO_EMPRESA`), que também
-- cria o `ix_movimentos_estoque_linha_seq` com `concurrently`. Aqui: o VALIDATE do check da 0016 varre a tabela só com
-- SHARE UPDATE EXCLUSIVE (as vendas continuam gravando); o NOT NULL usa o check validado e não varre de novo (PG ≥ 12)
-- e só ele segura a trava exclusiva, até o commit. Sobrou movimento sem ordem (banco migrado sem o preenchimento): a
-- migração falha com a instrução, sem gravar nada.
do $$
begin
  alter table movimentos_estoque validate constraint ck_movimentos_estoque_seq_lancamento;
exception when check_violation then
  raise exception using errcode = 'P0001',
    message = 'Há movimentos de estoque sem seq_lancamento: rode "pnpm --filter api db:preencher-seq-lancamento" e repita a migração';
end $$;
--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ALTER COLUMN "seq_lancamento" SET NOT NULL;
--> statement-breakpoint
alter table movimentos_estoque drop constraint ck_movimentos_estoque_seq_lancamento;
--> statement-breakpoint
-- Num banco novo (ou sem o preenchimento) o índice nasce aqui; o inválido de um `concurrently` interrompido é refeito.
do $$
begin
  if exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
              where c.relname = 'ix_movimentos_estoque_linha_seq' and not i.indisvalid) then
    drop index ix_movimentos_estoque_linha_seq;
  end if;
end $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_movimentos_estoque_linha_seq" ON "movimentos_estoque" USING btree ("estoque_id","produto_id","variacao_id","tipo_estoque_id","seq_lancamento");
