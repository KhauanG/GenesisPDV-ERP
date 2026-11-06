-- Funções e sequências do banco de controle (MD 1.1, 1.5, 2.13). Vem antes das tabelas porque os defaults usam
-- fn_uuid_v7() e nextval('seq_codigo_empresa').
create or replace function fn_uuid_v7() returns uuid
language sql volatile as $$
  select encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
              placing substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3)
              from 1 for 6),
      52, 1), 53, 1), 'hex')::uuid;
$$;
--> statement-breakpoint
-- CACHE 1 é obrigatório (MD 1.5, "Regras da sequência").
create sequence if not exists seq_versao as bigint start 1 cache 1 no cycle;
--> statement-breakpoint
create sequence if not exists seq_codigo_empresa as integer start 100001 minvalue 100001 cache 1 no cycle;
--> statement-breakpoint
-- Nada do controle desce para PDVs: só versão local (concorrência otimista), sem trava de ordenação.
create or replace function fn_versao_local() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'versao' - 'atualizado_em') = (to_jsonb(old) - 'versao' - 'atualizado_em') then
      new.versao := old.versao; new.atualizado_em := old.atualizado_em; return new;
    end if;
    new.criado_em := old.criado_em;
    new.atualizado_em := now();
  end if;
  new.versao := nextval('seq_versao');
  return new;
end $$;
