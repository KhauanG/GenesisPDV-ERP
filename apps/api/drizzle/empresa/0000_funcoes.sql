-- Extensões, funções e sequências do banco da empresa (MD 1.1, 1.5, 1.6, 1.9, 3.1.9).
-- Vem antes das tabelas: defaults usam fn_uuid_v7() e nextval('seq_codigo_<tabela>').
create extension if not exists pg_trgm schema public;
--> statement-breakpoint
create extension if not exists unaccent schema public;
--> statement-breakpoint
create extension if not exists btree_gist schema public;
--> statement-breakpoint
-- Rede de segurança para seeds/SQL manual (a aplicação gera o UUID v7 normalmente).
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
-- CACHE 1 é obrigatório: com cache > 1 um backend pode gravar versao menor que outra já lida (MD 1.5).
create sequence if not exists seq_versao as bigint start 1 cache 1 no cycle;
--> statement-breakpoint
-- Tabelas lidas por qualquer fluxo do /sync/pull (↓/↕): versão + trava de ordenação.
-- A trava (pg_advisory_xact_lock) fica com quem pegou uma versão até o COMMIT, então a ordem de versao é a ordem
-- de commit e um pull "where versao > cursor" nunca pula linhas (MD 1.5, "Trava de ordenação").
create or replace function fn_versao() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    -- UPDATE sem mudança real não gera versão nova (evita tráfego inútil para os PDVs)
    if (to_jsonb(new) - 'versao' - 'atualizado_em') = (to_jsonb(old) - 'versao' - 'atualizado_em') then
      new.versao := old.versao;
      new.atualizado_em := old.atualizado_em;
      return new;
    end if;
    new.criado_em := old.criado_em;
    new.atualizado_em := now();
  end if;
  perform pg_advisory_xact_lock(7300001);
  new.versao := nextval('seq_versao');
  return new;
end $$;
--> statement-breakpoint
-- Tabelas que nenhum fluxo do pull lê (—/↑): versão sem trava (só concorrência otimista e exportação incremental).
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
--> statement-breakpoint
-- Primeira instrução das transações do ERP/jobs que gravam tabelas sincronizáveis: pega a trava de ordenação antes
-- de qualquer select … for update, na mesma ordem da aplicação de eventos do push (sem deadlock trava × linha).
-- Reentrante: o pg_advisory_xact_lock do trigger fn_versao passa direto na mesma transação.
create or replace function fn_trava_versao() returns void language sql as $$
  select pg_advisory_xact_lock(7300001);
$$;
--> statement-breakpoint
-- Argumentos: coluna de estado, estados "abertos" (editáveis livremente, separados por vírgula),
-- colunas sempre liberadas (separadas por vírgula). A API traduz DOCUMENTO_IMUTAVEL para REGRA_NEGOCIO (422).
create or replace function fn_protege_imutavel() returns trigger language plpgsql as $$
declare
  col_estado text   := tg_argv[0];
  abertos    text[] := string_to_array(tg_argv[1], ',');
  livres     text[] := string_to_array(tg_argv[2], ',');
  a jsonb := to_jsonb(old);
  b jsonb := to_jsonb(new);
  c text;
begin
  if col_estado <> '' and (a ->> col_estado) = any(abertos) then
    return new;
  end if;
  foreach c in array livres loop a := a - c; b := b - c; end loop;
  if a <> b then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  return new;
end $$;
--> statement-breakpoint
-- Wrapper imutável (unaccent() é STABLE e não pode ser usado em índice).
create or replace function fn_unaccent(text) returns text
language sql immutable parallel safe strict as
$$ select public.unaccent('public.unaccent'::regdictionary, $1) $$;
--> statement-breakpoint
create sequence if not exists seq_codigo_usuarios as integer start 1 cache 1 no cycle;
--> statement-breakpoint
create sequence if not exists seq_codigo_estoques as integer start 1 cache 1 no cycle;
