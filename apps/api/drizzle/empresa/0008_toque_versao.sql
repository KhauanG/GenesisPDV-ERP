-- Toque (MD 3.5.4, 6.4 regra 1): uma linha que passa a ser relevante para o PDV (pessoa que ganhou
-- pessoas_relevancia_loja, usuário cujo dia de demissão chegou) precisa de versão nova para descer, mas o UPDATE sem
-- mudança real não gera versão (fn_versao ignora). Com `set local genesis.forcar_versao = 'on'` (só dentro da transação
-- de quem toca, `sync/toque.ts`) o UPDATE ganha versão nova mesmo sem mudar coluna. Fora disso, o comportamento é o
-- mesmo da 0000.
create or replace function fn_versao() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    -- UPDATE sem mudança real não gera versão nova (evita tráfego inútil para os PDVs), salvo no toque
    if (to_jsonb(new) - 'versao' - 'atualizado_em') = (to_jsonb(old) - 'versao' - 'atualizado_em')
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
