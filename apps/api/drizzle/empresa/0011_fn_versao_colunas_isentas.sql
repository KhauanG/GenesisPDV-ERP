-- Colunas isentas de versão (Fase 1C, T3/T10; MD 1.5): `produtos.custo_medio` é projeção do razão (0006), mantida
-- pelo banco a cada mudança de `saldos_estoque`. Com o CD e as lojas tendo custos diferentes, cada venda muda o peso da
-- média, e o UPDATE gerava versão nova no produto e em cada combo que o tem como componente (0005/0006): a linha
-- descia inteira no fluxo `catalogo` para todos os PDVs (sem a coluna, que o pull omite), a venda segurava a trava
-- 7300001 por mais tempo e o `versaoAgregada` do ERP dava 409 falso a quem estava editando o produto.
-- Agora o trigger pode passar, como argumentos, colunas que não contam na comparação: se só elas mudam, a linha grava o
-- valor novo e fica com a mesma `versao` e o mesmo `atualizado_em` (sem pegar a trava). Junto de qualquer outra
-- mudança, ou no toque (`genesis.forcar_versao`, 0008), a versão é nova como antes. Coluna isenta precisa estar no
-- `omitir` do fluxo (o PDV nunca a vê; teste `versionamento`). Sem argumentos o comportamento é o da 0008.
-- Em `produtos` a lista é só `custo_medio`: `preco_custo` e `markup_pct` do combo só mudam quando muda o cadastro de
-- outro produto, e aí versionar é o certo (a concorrência otimista do ERP depende disso).
create or replace function fn_versao() returns trigger language plpgsql as $$
declare
  -- tg_argv é nulo quando o trigger não tem argumentos (e `jsonb - null` daria nulo, versionando tudo)
  isentas text[] := coalesce(tg_argv, '{}'::text[]);
begin
  if tg_op = 'UPDATE' then
    -- UPDATE sem mudança real (fora as isentas) não gera versão nova (evita tráfego inútil para os PDVs), salvo no toque
    if (to_jsonb(new) - 'versao' - 'atualizado_em' - isentas) = (to_jsonb(old) - 'versao' - 'atualizado_em' - isentas)
       and coalesce(current_setting('genesis.forcar_versao', true), '') <> 'on' then
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
drop trigger tg_produtos_versao on produtos;
--> statement-breakpoint
create trigger tg_produtos_versao before insert or update on produtos
  for each row execute function fn_versao('custo_medio');
