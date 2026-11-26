-- Fase 3, F3-B3 (README da API › decisão 222; ERP 8.8, 11.3, 11.4): só dados. As promoções ganham permissões próprias
-- (`promocoes.ver/criar/editar/excluir`) e o menu deixa de usar `produtos.ver`. Para ninguém perder o menu que já via e
-- ninguém ganhar o que não tinha, a permissão efetiva de promoções de cada usuário passa a ser a de produtos de hoje:
--   - perfil (personalizado ou de sistema) com `produtos.editar` ganha `promocoes.ver/criar/editar`;
--   - usuário com `produtos.editar` concedida ou negada à parte ganha o mesmo ajuste nas três, e o que tem
--     `produtos.excluir` negada ganha `promocoes.excluir` negada (os perfis de sistema recebem `excluir` pelo seed);
--   - o perfil de sistema que a empresa tirou de `produtos.editar` (ou de `produtos.excluir`) fica com as linhas de
--     promoções já excluídas, que o seed do pós-migração (`aplicarSeedEmpresa`) respeita como "a empresa removeu".
-- Uma linha de auditoria `permissoes_alteradas` por perfil e por usuário alterado, e `permissoes_versao` + 1 de quem
-- muda (o ERP e o PDV recarregam as permissões). O resto das permissões novas da fase (`pdv.vasilhame.comodato`, a
-- devolução em dinheiro do Encarregado, a baixa interna do Supervisor) chega aos perfis de sistema pelo seed.
--
-- A trava de ordenação das versões primeiro (como as transações do ERP que gravam tabelas que descem ao PDV:
-- `permissoes`, `perfis_permissoes`, `usuarios` e `usuarios_permissoes`), antes de qualquer linha.
select fn_trava_versao();
--> statement-breakpoint
-- As chaves entram no catálogo antes (o pós-migração recarrega o catálogo depois das migrações, e o vínculo
-- `fk_perfis_permissoes_permissao` exige a chave): o mesmo texto e a mesma ordem de `PERMISSOES` do shared.
insert into permissoes (chave, modulo, grupo, descricao, ordem, permite_liberacao) values
  ('promocoes.ver', 'erp', 'Produtos', 'Promoções: Ver', 3015, true),
  ('promocoes.criar', 'erp', 'Produtos', 'Promoções: Criar', 3016, true),
  ('promocoes.editar', 'erp', 'Produtos', 'Promoções: Editar', 3017, true),
  ('promocoes.excluir', 'erp', 'Produtos', 'Promoções: Excluir', 3018, true)
on conflict (chave) do nothing;
--> statement-breakpoint
select fn_auditoria_garantir_particoes(0, 1);
--> statement-breakpoint
-- Perfis com `produtos.editar` (ativos): ver, criar e editar promoções. Linha que já existe (ativa ou excluída) fica.
with alvo as (
  select p.id as perfil_id, x.permissao
    from perfis p
    cross join unnest(array['promocoes.ver', 'promocoes.criar', 'promocoes.editar']::varchar[]) as x(permissao)
   where p.excluido_em is null
     and exists (select 1 from perfis_permissoes pp
                  where pp.perfil_id = p.id and pp.permissao = 'produtos.editar' and pp.excluido_em is null)
     and not exists (select 1 from perfis_permissoes pp where pp.perfil_id = p.id and pp.permissao = x.permissao)
), inseridas as (
  insert into perfis_permissoes (perfil_id, permissao)
  select perfil_id, permissao from alvo
  returning perfil_id, permissao
), por_perfil as (
  select perfil_id, array_agg(permissao::text order by permissao) as incluidas from inseridas group by perfil_id
), antes as (
  select pp.perfil_id, array_agg(pp.permissao::text order by pp.permissao) as permissoes
    from perfis_permissoes pp
   where pp.excluido_em is null and pp.perfil_id in (select perfil_id from por_perfil)
   group by pp.perfil_id
), versao as (
  update usuarios u set permissoes_versao = u.permissoes_versao + 1
    from por_perfil pp
   where u.perfil_id = pp.perfil_id and u.excluido_em is null
  returning u.id
)
insert into auditoria (id, ocorrido_em, origem, entidade, registro_id, acao, localizacao, descricao, antes, depois)
select fn_uuid_v7(), now(), 'sistema', 'perfis', pp.perfil_id, 'permissoes_alteradas', 'Cadastros › Perfis de acesso',
       'Fase 3 (migração 0031): as promoções ganharam permissões próprias; quem editava produtos continua com elas',
       jsonb_build_object('permissoes', to_jsonb(coalesce(a.permissoes, array[]::text[]))),
       jsonb_build_object(
         'permissoes', to_jsonb(array(select unnest(coalesce(a.permissoes, array[]::text[]) || pp.incluidas) order by 1)),
         'incluidas', to_jsonb(pp.incluidas),
         'removidas', '[]'::jsonb)
  from por_perfil pp
  left join antes a on a.perfil_id = pp.perfil_id;
--> statement-breakpoint
-- Perfis de sistema que o seed vai completar com promoções (Administrador, Gerente e Estoquista em `PERFIS_PADRAO`; o
-- teste confere a lista) e de que a empresa tirou a permissão de produtos correspondente: a linha nasce excluída, como
-- se a empresa a tivesse removido, e o seed não a acrescenta. Nada muda para os usuários (não é concessão).
with marcas as (
  select p.id as perfil_id, x.permissao
    from perfis p
    cross join (values ('promocoes.ver', 'produtos.editar'), ('promocoes.criar', 'produtos.editar'),
                       ('promocoes.editar', 'produtos.editar'), ('promocoes.excluir', 'produtos.excluir'))
         as x(permissao, base)
   where p.excluido_em is null
     and (p.chave_sistema in ('administrador', 'gerente')
          or (p.chave_sistema = 'estoquista' and x.permissao <> 'promocoes.excluir'))
     and not exists (select 1 from perfis_permissoes pp
                      where pp.perfil_id = p.id and pp.permissao = x.base and pp.excluido_em is null)
     and not exists (select 1 from perfis_permissoes pp where pp.perfil_id = p.id and pp.permissao = x.permissao)
)
insert into perfis_permissoes (perfil_id, permissao, excluido_em)
select perfil_id, permissao, now() from marcas;
--> statement-breakpoint
-- Ajustes por usuário (MD 3.3.4: efetiva = perfil ∪ concedidas − negadas): o mesmo efeito da permissão de produtos.
with alvo as (
  select up.usuario_id, x.permissao, up.efeito
    from usuarios_permissoes up
    join usuarios u on u.id = up.usuario_id and u.excluido_em is null
    join (values ('produtos.editar', 'promocoes.ver', true), ('produtos.editar', 'promocoes.criar', true),
                 ('produtos.editar', 'promocoes.editar', true), ('produtos.excluir', 'promocoes.excluir', false))
         as x(base, permissao, concede) on x.base = up.permissao
   where up.excluido_em is null
     and (up.efeito = 'negar' or x.concede)
     and not exists (select 1 from usuarios_permissoes o
                      where o.usuario_id = up.usuario_id and o.permissao = x.permissao and o.excluido_em is null)
), antes as (
  select up.usuario_id,
         jsonb_agg(jsonb_build_object('permissao', up.permissao, 'efeito', up.efeito) order by up.permissao) as ajustes
    from usuarios_permissoes up
   where up.excluido_em is null and up.usuario_id in (select usuario_id from alvo)
   group by up.usuario_id
), inseridas as (
  insert into usuarios_permissoes (usuario_id, permissao, efeito)
  select usuario_id, permissao, efeito from alvo
  returning usuario_id, permissao, efeito
), por_usuario as (
  select usuario_id,
         jsonb_agg(jsonb_build_object('permissao', permissao, 'efeito', efeito) order by permissao) as incluidos
    from inseridas group by usuario_id
), versao as (
  update usuarios u set permissoes_versao = u.permissoes_versao + 1
    from por_usuario pu where u.id = pu.usuario_id
  returning u.id
)
insert into auditoria (id, ocorrido_em, origem, entidade, registro_id, acao, localizacao, descricao, antes, depois)
select fn_uuid_v7(), now(), 'sistema', 'usuarios', pu.usuario_id, 'permissoes_alteradas', 'Cadastros › Usuários',
       'Fase 3 (migração 0031): as promoções ganharam permissões próprias; o ajuste de produtos do usuário vale para elas',
       jsonb_build_object('ajustes', coalesce(a.ajustes, '[]'::jsonb)),
       jsonb_build_object('ajustes', coalesce(a.ajustes, '[]'::jsonb) || pu.incluidos, 'incluidos', pu.incluidos)
  from por_usuario pu
  left join antes a on a.usuario_id = pu.usuario_id;
