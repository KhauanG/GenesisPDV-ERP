-- Ordem de lançamento do razão, etapa A (Fase 2, F2-B2; README da API › decisão 146; MD 3.7.2). O custo médio depende
-- da ordem em que os movimentos foram **lançados** na linha de saldo, não da `data_movimento`, e até aqui essa ordem não
-- ficava gravada: o `id` é um UUIDv7 gerado no Node e o `criado_em` é a hora de início da transação. A coluna nova
-- recebe o `nextval` no INSERT, que o motor faz depois do `select … for update` da linha de saldo: cresce, por linha,
-- na ordem em que o custo médio foi calculado. Esta etapa é só metadado (sem reescrever a tabela): a coluna entra
-- vazia e sem default, e o default vale só para as linhas novas. Os movimentos antigos recebem a ordem pelo
-- preenchimento (`estoques/seq-lancamento.ts`), fora da transação, antes da etapa B (`0017_movimentos_seq_b`).
-- A sequência começa em 10¹²: o preenchimento numera os antigos de 1 a N por linha, sempre abaixo.
create sequence if not exists seq_movimentos_estoque as bigint start 1000000000000 cache 1 no cycle;
--> statement-breakpoint
-- O default abaixo roda o `nextval` com a role que insere: a de runtime (`<banco>_app`, MD 1.4) precisa do privilégio
-- já no commit desta migração, porque a API (inclusive a do deploy anterior) continua lançando movimentos durante o
-- preenchimento e a etapa B, e o `garantirRoleAplicacao` só roda depois de todas as migrações da empresa (e não roda
-- se uma delas falha). Banco ainda sem a role (provisionamento): ela recebe o grant ao ser criada.
do $$
declare
  role_app text := current_database() || '_app';
begin
  if exists (select 1 from pg_roles where rolname = role_app) then
    execute format('grant usage, select on sequence seq_movimentos_estoque to %I', role_app);
  end if;
end $$;
--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD COLUMN "seq_lancamento" bigint;
--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ALTER COLUMN "seq_lancamento" SET DEFAULT nextval('seq_movimentos_estoque');
--> statement-breakpoint
-- Já nesta etapa, sem conferir as linhas antigas (`not valid`): vale para as novas e para o preenchimento. A etapa B
-- só valida (sem trava de escrita), troca pelo NOT NULL e o descarta.
alter table movimentos_estoque add constraint ck_movimentos_estoque_seq_lancamento
  check (seq_lancamento is not null) not valid;
--> statement-breakpoint
-- `fn_versao_local` passa a aceitar colunas isentas, como o `fn_versao` desde a 0011: se só elas mudam, a linha grava
-- o valor novo e fica com a mesma `versao` e o mesmo `atualizado_em`. Sem argumentos o comportamento é o de antes.
create or replace function fn_versao_local() returns trigger language plpgsql as $$
declare
  -- tg_argv é nulo quando o trigger não tem argumentos (e `jsonb - null` daria nulo, versionando tudo)
  isentas text[] := coalesce(tg_argv, '{}'::text[]);
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'versao' - 'atualizado_em' - isentas) = (to_jsonb(old) - 'versao' - 'atualizado_em' - isentas) then
      new.versao := old.versao; new.atualizado_em := old.atualizado_em; return new;
    end if;
    new.criado_em := old.criado_em;
    new.atualizado_em := now();
  end if;
  new.versao := nextval('seq_versao');
  return new;
end $$;
--> statement-breakpoint
-- O preenchimento não muda a versão nem o `atualizado_em` do movimento (o razão continua sendo o registro do fato).
drop trigger tg_movimentos_estoque_versao on movimentos_estoque;
--> statement-breakpoint
create trigger tg_movimentos_estoque_versao before insert or update on movimentos_estoque
  for each row execute function fn_versao_local('seq_lancamento');
--> statement-breakpoint
-- O movimento continua imutável; a única mudança aceita é a ordem passar de vazia a preenchida, uma vez.
drop trigger tg_movimentos_estoque_imutavel on movimentos_estoque;
--> statement-breakpoint
create trigger tg_movimentos_estoque_imutavel before update on movimentos_estoque
  for each row execute function fn_protege_imutavel('', '', 'versao,atualizado_em,seq_lancamento');
--> statement-breakpoint
create or replace function fn_movimentos_estoque_seq_lancamento() returns trigger language plpgsql as $$
begin
  if old.seq_lancamento is not null and new.seq_lancamento is distinct from old.seq_lancamento then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_movimentos_estoque_seq_lancamento before update on movimentos_estoque
  for each row execute function fn_movimentos_estoque_seq_lancamento();
