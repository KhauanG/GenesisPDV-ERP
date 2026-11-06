-- Virada dos estoques permitidos (Fase 2, F2-B5; ERP 2.1; MD 3.3.5; F2-Q4 (a) = D45; README da API › decisões 89 e
-- 149). Até a 0018 o usuário não Master via os estoques das lojas permitidas e todo estoque sem loja (o CD), e
-- `usuarios_estoques` não era lido. A partir desta versão só vale `usuarios_estoques` (salvo Master e `estoques.todos`):
-- para ninguém perder acesso no deploy, cada usuário não Master (ativo ou não; o excluído não volta) recebe aqui os
-- estoques que via pela regra antiga. O gerente restringe depois pela tela de usuários. Usuário criado depois desta
-- migração começa sem estoque nenhum (a tela do ERP sugere o estoque das lojas escolhidas).
-- Antes = depois também no outro sentido (ninguém ganha acesso no deploy): na Fase 1 o ERP já gravava "Estoques
-- adicionais permitidos", que não davam acesso a nada porque `usuarios_estoques` não era lido. A linha de um estoque de
-- loja fora das lojas do usuário (ex.: o estoque da Petiscaria 2 para quem só tem a Loja 1) passaria a valer agora, sem
-- ninguém ter decidido isso; por isso ela é encerrada (`excluido_em`, o histórico fica), como também a que aponta para
-- estoque já excluído. A que cabe na regra antiga fica como está. O gerente concede de novo pela tela, se quiser.
-- Idempotente: só encerra o que está fora da regra antiga e só cria o que falta (`uq_usuarios_estoques` também
-- recusaria a repetição). As mudanças sobem a `versao` de `usuarios_estoques`, que entra na geração das permissões: o
-- cache de acesso das instâncias da API se renova sozinho.
update usuarios_estoques ue
   set excluido_em = now()
  from usuarios u, estoques e
 where u.id = ue.usuario_id
   and e.id = ue.estoque_id
   and ue.excluido_em is null
   and (e.excluido_em is not null
        -- Fora da regra antiga (só o não Master): uma loja viva fora das permitidas do usuário aponta para o estoque.
        or (not u.master
            and exists (select 1 from lojas lx
                         where lx.estoque_id = e.id and lx.excluido_em is null
                           and not exists (select 1 from usuarios_lojas ul
                                            where ul.usuario_id = u.id and ul.loja_id = lx.id
                                              and ul.excluido_em is null))));
--> statement-breakpoint
insert into usuarios_estoques (usuario_id, estoque_id)
select u.id, e.id
  from usuarios u
  cross join estoques e
 where not u.master
   and u.excluido_em is null
   and e.excluido_em is null
   -- Regra antiga (`estoqueVisivel` até a 0018): nenhuma loja viva fora das permitidas aponta para o estoque.
   and not exists (select 1 from lojas lx
                    where lx.estoque_id = e.id and lx.excluido_em is null
                      and not exists (select 1 from usuarios_lojas ul
                                       where ul.usuario_id = u.id and ul.loja_id = lx.id and ul.excluido_em is null))
   and not exists (select 1 from usuarios_estoques ue
                    where ue.usuario_id = u.id and ue.estoque_id = e.id and ue.excluido_em is null)
 order by u.id, e.id;
