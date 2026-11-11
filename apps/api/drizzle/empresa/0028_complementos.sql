-- Complementos do produto (Fase 2, F2-B45; F2-Q1 = roadmap D43: complementos sim; MD 3.6.8; README da API › decisão
-- 191): os grupos ("Gelo", "Adicionais") e as opções de cada um, que descem ao caixa no fluxo `catalogo` (todas as
-- colunas, sem filtro de loja). O cadastro no ERP é o F2-B51 e o uso na venda, a Fase 3; até lá as tabelas ficam vazias
-- e `produtos.complementos_habilitados` continua desligada. O PDV 0.12.0 traz os espelhos; o anterior descarta as
-- tabelas que não conhece sem travar o cursor.
CREATE TABLE "produtos_complementos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"grupo_id" uuid NOT NULL,
	"produto_id" uuid,
	"descricao" varchar(60),
	"preco_adicional" numeric(15, 4) DEFAULT '0' NOT NULL,
	"baixa_estoque" boolean DEFAULT false NOT NULL,
	"quantidade_baixa" numeric(15, 3) DEFAULT '1' NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_produtos_complementos" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_complementos_origem" CHECK (produto_id is not null or descricao is not null),
	CONSTRAINT "ck_produtos_complementos_baixa" CHECK (not baixa_estoque or produto_id is not null),
	CONSTRAINT "ck_produtos_complementos_valores" CHECK (preco_adicional >= 0 and quantidade_baixa > 0)
);
--> statement-breakpoint
CREATE TABLE "produtos_grupos_complementos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"nome" varchar(40) NOT NULL,
	"minimo" smallint DEFAULT 0 NOT NULL,
	"maximo" smallint DEFAULT 1 NOT NULL,
	"obrigatorio" boolean DEFAULT false NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_produtos_grupos_complementos" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_grupos_complementos_quantidades" CHECK (minimo >= 0 and maximo >= minimo and (not obrigatorio or minimo >= 1))
);
--> statement-breakpoint
ALTER TABLE "produtos_complementos" ADD CONSTRAINT "fk_produtos_complementos_grupo_id" FOREIGN KEY ("grupo_id") REFERENCES "public"."produtos_grupos_complementos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_complementos" ADD CONSTRAINT "fk_produtos_complementos_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_grupos_complementos" ADD CONSTRAINT "fk_produtos_grupos_complementos_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_produtos_complementos_grupo_id" ON "produtos_complementos" USING btree ("grupo_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_complementos_produto_id" ON "produtos_complementos" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_grupos_complementos_produto_id" ON "produtos_grupos_complementos" USING btree ("produto_id");--> statement-breakpoint
-- O `complemento_id` da venda passa a apontar para a opção (on delete set null). Até aqui não havia opção nenhuma:
-- um id que algum caixa tenha mandado não existe, e a FK não seria criada. Nenhum PDV publicado manda complementos (a
-- lista vai vazia), então em produção isto não muda linha; fica pela garantia.
update itens_venda_complementos set complemento_id = null where complemento_id is not null;
--> statement-breakpoint
ALTER TABLE "itens_venda_complementos" ADD CONSTRAINT "fk_itens_venda_complementos_complemento_id" FOREIGN KEY ("complemento_id") REFERENCES "public"."produtos_complementos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_itens_venda_complementos_complemento_id" ON "itens_venda_complementos" USING btree ("complemento_id");--> statement-breakpoint
-- As duas tabelas descem no fluxo `catalogo` (MD 6.2): fn_versao (trava de ordenação), índice de versão e autoria
-- (MD 1.5, 1.3 AU), como as demais filhas do produto.
create trigger tg_produtos_grupos_complementos_versao before insert or update on produtos_grupos_complementos
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_grupos_complementos_versao on produtos_grupos_complementos (versao);
--> statement-breakpoint
create trigger tg_produtos_complementos_versao before insert or update on produtos_complementos
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_complementos_versao on produtos_complementos (versao);
--> statement-breakpoint
alter table produtos_grupos_complementos add constraint fk_produtos_grupos_complementos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_grupos_complementos_criado_por_id on produtos_grupos_complementos (criado_por_id);
--> statement-breakpoint
alter table produtos_grupos_complementos add constraint fk_produtos_grupos_complementos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_grupos_complementos_atualizado_por_id on produtos_grupos_complementos (atualizado_por_id);
--> statement-breakpoint
alter table produtos_complementos add constraint fk_produtos_complementos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_complementos_criado_por_id on produtos_complementos (criado_por_id);
--> statement-breakpoint
alter table produtos_complementos add constraint fk_produtos_complementos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_complementos_atualizado_por_id on produtos_complementos (atualizado_por_id);
--> statement-breakpoint
-- Só inativação (`excluido_em`, `ativo`): o caixa offline pode ter na venda o id de um grupo ou de uma opção, e a nuvem
-- precisa continuar conhecendo esse id quando o evento chegar. A exclusão física (DELETE ou TRUNCATE) é recusada aqui,
-- com o código `EXCLUSAO_FISICA_PROIBIDA`; a exclusão lógica desce ao caixa como tombstone (SYNC 6.8).
create or replace function fn_exclusao_fisica_proibida() returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'EXCLUSAO_FISICA_PROIBIDA', detail = tg_table_name;
end $$;
--> statement-breakpoint
create trigger tg_produtos_grupos_complementos_sem_delete before delete on produtos_grupos_complementos
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_produtos_grupos_complementos_sem_truncate before truncate on produtos_grupos_complementos
  for each statement execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_produtos_complementos_sem_delete before delete on produtos_complementos
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_produtos_complementos_sem_truncate before truncate on produtos_complementos
  for each statement execute function fn_exclusao_fisica_proibida();
