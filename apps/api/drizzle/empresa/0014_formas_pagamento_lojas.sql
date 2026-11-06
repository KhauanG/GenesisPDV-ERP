-- Formas de pagamento personalizadas por loja (Fase 1C, bloco C8b; pedido do dono O9a/D25; MD 3.10.1). A forma deixa
-- de ter uma loja só (`loja_id`, nulo = todas) e passa a valer nas lojas de `formas_pagamento_lojas`: uma linha com
-- `loja_id` nulo = todas as lojas, como `pessoas_relevancia_loja` (MD 3.5.4). Com "todas" numa linha, a troca para
-- lojas escolhidas exclui essa linha e a exclusão desce aos caixas das demais lojas (filtro `loja_id is null or = X`),
-- que deixam de oferecer a forma; com "sem linha = todas" (desenho de `planos_contas_lojas`) o caixa da outra loja
-- nunca saberia da troca. Entram também `exige_supervisor` e o CHECK do troco (O23).
CREATE TABLE "formas_pagamento_lojas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"forma_pagamento_id" uuid NOT NULL,
	"loja_id" uuid,
	CONSTRAINT "pk_formas_pagamento_lojas" PRIMARY KEY("id")
);
--> statement-breakpoint
ALTER TABLE "formas_pagamento_lojas" ADD CONSTRAINT "fk_formas_pagamento_lojas_forma_pagamento_id" FOREIGN KEY ("forma_pagamento_id") REFERENCES "public"."formas_pagamento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formas_pagamento_lojas" ADD CONSTRAINT "fk_formas_pagamento_lojas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_formas_pagamento_lojas_loja_id" ON "formas_pagamento_lojas" USING btree ("loja_id");--> statement-breakpoint
ALTER TABLE "formas_pagamento" ADD COLUMN "exige_supervisor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A tabela desce no fluxo `configuracao` (MD 6.2): fn_versao (trava de ordenação), índice de versão e autoria (MD 1.5).
create trigger tg_formas_pagamento_lojas_versao before insert or update on formas_pagamento_lojas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_formas_pagamento_lojas_versao on formas_pagamento_lojas (versao);
--> statement-breakpoint
alter table formas_pagamento_lojas add constraint fk_formas_pagamento_lojas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_formas_pagamento_lojas_criado_por_id on formas_pagamento_lojas (criado_por_id);
--> statement-breakpoint
alter table formas_pagamento_lojas add constraint fk_formas_pagamento_lojas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_formas_pagamento_lojas_atualizado_por_id on formas_pagamento_lojas (atualizado_por_id);
--> statement-breakpoint
-- Uma linha viva por forma e loja (a nula = todas, uma só); começa por `forma_pagamento_id`, que serve às consultas por
-- forma. Trocar a forma ou a loja de uma linha faria ela sumir do filtro de um caixa sem a exclusão descer: imutáveis.
create unique index uq_formas_pagamento_lojas on formas_pagamento_lojas (forma_pagamento_id, loja_id) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create trigger tg_formas_pagamento_lojas_filtro_imutavel before update on formas_pagamento_lojas
  for each row execute function fn_filtro_imutavel('forma_pagamento_id', 'loja_id');
--> statement-breakpoint
-- Dados: cada forma (também as excluídas, para a exclusão continuar descendo pelo filtro) ganha a linha da loja que
-- tinha, ou a de "todas". A da loja já excluída nasce excluída (a exclusão da loja passa a excluir os vínculos dela) e a
-- forma viva que só valia nessa loja é excluída também: sem vínculo vivo ela não valeria em loja nenhuma, e o ERP a
-- mostraria como "todas". A loja excluída não tem terminal (`garantirSemTerminal`): nada disso precisa descer.
insert into formas_pagamento_lojas (forma_pagamento_id, loja_id, criado_por_id, atualizado_por_id, excluido_em)
  select f.id, f.loja_id, f.criado_por_id, f.atualizado_por_id, l.excluido_em
    from formas_pagamento f left join lojas l on l.id = f.loja_id;
--> statement-breakpoint
update formas_pagamento f set excluido_em = l.excluido_em
  from lojas l
 where l.id = f.loja_id and l.excluido_em is not null and f.excluido_em is null;
--> statement-breakpoint
-- A descrição passa a ser única na empresa (era por loja): a forma vale em várias lojas e o fechamento por forma e as
-- consultas agrupam pelo nome. Repetidas em lojas diferentes ganham o código da loja no fim; a de "todas" fica igual.
-- O nome gerado nunca colide: já em uso (outra forma "Ticket (loja 2)", ou duas descrições longas que ficam iguais
-- depois do corte), o sufixo ganha um contador ("(loja 2-2)", "(loja 2-3)"...). Uma linha por vez, conferindo as formas
-- vivas da empresa inteira, o UPDATE não viola o índice antigo (por loja) nem o novo (na empresa).
do $$
declare
  r record;
  sufixo text;
  nome text;
  k int;
begin
  for r in
    select f.id, f.descricao, coalesce(l.codigo::text, '?') as loja
      from (select id, descricao, loja_id,
              row_number() over (partition by lower(descricao) order by loja_id is not null, ordem, criado_em, id) as n
              from formas_pagamento where excluido_em is null) f
      left join lojas l on l.id = f.loja_id
     where f.n > 1
     order by lower(f.descricao), f.n
  loop
    k := 1;
    loop
      sufixo := ' (loja ' || r.loja || case when k > 1 then '-' || k else '' end || ')';
      nome := left(r.descricao, 40 - length(sufixo)) || sufixo;
      exit when not exists (select 1 from formas_pagamento
                             where excluido_em is null and id <> r.id and lower(descricao) = lower(nome));
      k := k + 1;
    end loop;
    update formas_pagamento set descricao = nome where id = r.id;
  end loop;
end
$$;
--> statement-breakpoint
drop index uq_formas_pagamento_descricao;
--> statement-breakpoint
ALTER TABLE "formas_pagamento" DROP CONSTRAINT "fk_formas_pagamento_loja_id";
--> statement-breakpoint
DROP INDEX "ix_formas_pagamento_loja_id";--> statement-breakpoint
ALTER TABLE "formas_pagamento" DROP COLUMN "loja_id";
--> statement-breakpoint
create unique index uq_formas_pagamento_descricao on formas_pagamento (lower(descricao)) where excluido_em is null;
--> statement-breakpoint
-- O23 (dono, 1C): troco só no dinheiro; cartão e PIX (e qualquer forma pela maquininha, TEF ou PIX) não passam do
-- total. Forma que já estivesse assim perde o troco antes do CHECK.
update formas_pagamento set permite_troco = false
 where permite_troco and (integracao <> 'nenhuma' or tipo_forma in ('cartao_credito','cartao_debito','pix'));
--> statement-breakpoint
ALTER TABLE "formas_pagamento" ADD CONSTRAINT "ck_formas_pagamento_troco" CHECK (not permite_troco or (integracao = 'nenhuma' and tipo_forma not in ('cartao_credito','cartao_debito','pix')));
