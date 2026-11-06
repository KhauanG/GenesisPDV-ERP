-- Login offline do PDV (PDV 7.2; SYNC 4.2): as recusas próprias do caixa (sem `pdv.acesso.entrar`, usuário de totem,
-- hash do PIN fora dos limites) sobem no `auditoria.registros` com o motivo real; o check passa a aceitá-las
-- (MOTIVOS_FALHA_LOGIN, `@genesis/shared`).
ALTER TABLE "historico_logins" DROP CONSTRAINT "ck_historico_logins_motivo_falha";--> statement-breakpoint
ALTER TABLE "historico_logins" ADD CONSTRAINT "ck_historico_logins_motivo_falha" CHECK (motivo_falha is null or motivo_falha in ('senha_invalida','usuario_inativo','demitido','loja_nao_permitida','bloqueado','empresa_suspensa','sem_acesso_pdv','totem','hash_fora_dos_limites'));
--> statement-breakpoint
-- Relevância inicial (MD 3.5.4; D19): `pessoas/relevancia.ts` mantém `funcionario` e `crediario` na transação do fato,
-- mas as pessoas gravadas antes dele (cadastro da Fase 1A, importação do Nuvem3) não têm linha e nunca desceriam.
-- Mesmas regras do `recalcularRelevancia`, `loja_id` nulo. Sem toque: nenhum PDV tinha espelho de pessoas antes da
-- Fase 1B, e a linha nova já leva a pessoa na carga inicial. Idempotente (só cria o que falta).
insert into pessoas_relevancia_loja (pessoa_id, loja_id, motivo, ultima_ocorrencia_em)
select p.id, null, m.motivo, now()
from pessoas p
cross join lateral (
  select 'funcionario'::varchar(12) as motivo
  where exists (select 1 from pessoas_categorias c
                 where c.pessoa_id = p.id and c.categoria = 'funcionario' and c.excluido_em is null)
     or exists (select 1 from usuarios u where u.pessoa_id = p.id and u.excluido_em is null)
  union all
  select 'crediario'
  where coalesce(p.limite_compras, 0) > 0
     or exists (select 1 from saldos_credito_pessoas s
                 where s.pessoa_id = p.id and s.saldo_aberto > 0 and s.excluido_em is null)
) m
where p.excluido_em is null
  and not exists (select 1 from pessoas_relevancia_loja r
                   where r.pessoa_id = p.id and r.loja_id is null and r.motivo = m.motivo and r.excluido_em is null)
order by p.id, m.motivo;
