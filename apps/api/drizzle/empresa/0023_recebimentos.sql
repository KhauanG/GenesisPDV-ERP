-- Recebimento manual de mercadoria (Fase 2, F2-B14; ERP 13.3; MD 3.8.1; README da API › decisão 159): o documento de
-- entrada sem nota (ou com nota em papel), em rascunho → movimentado → estornado. Este bloco cria só o schema e o
-- rascunho; movimentar (RECEB_MANUAL) e estornar (ESTORNO_RECEB_MANUAL) entram no F2-B15, sem migração nova (o razão
-- já aceita `documento_tipo = 'recebimento'` e o seed já tem os dois tipos de movimento).
--
-- Nenhuma das duas tabelas desce ao PDV (MD 3.8.1, "—"): o `Esquema.g.cs` não muda e os triggers de versão são
-- `fn_versao_local`. A sequência do `codigo` vem antes das tabelas (o default usa nextval).
create sequence if not exists seq_codigo_recebimentos as integer start 1 cache 1 no cycle;
--> statement-breakpoint
CREATE TABLE "itens_recebimento" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"recebimento_id" uuid NOT NULL,
	"sequencia" integer NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"codigo_barras_id" uuid,
	"unidade_compra" varchar(6),
	"fator" numeric(15, 3) DEFAULT '1' NOT NULL,
	"quantidade" numeric(15, 3) NOT NULL,
	"quantidade_estoque" numeric(15, 3) NOT NULL,
	"preco_compra" numeric(15, 4) NOT NULL,
	"markup_pct" numeric(9, 4),
	"preco_venda" numeric(15, 4),
	"atualizar_preco" varchar(6) DEFAULT 'nao' NOT NULL,
	"lote" varchar(30),
	"validade" date,
	"fabricacao" date,
	"lote_id" uuid,
	"rateio_frete" numeric(15, 2) DEFAULT '0' NOT NULL,
	"rateio_desconto" numeric(15, 2) DEFAULT '0' NOT NULL,
	"rateio_outras" numeric(15, 2) DEFAULT '0' NOT NULL,
	"custo_unitario_final" numeric(15, 4) DEFAULT '0' NOT NULL,
	"valor_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "pk_itens_recebimento" PRIMARY KEY("id"),
	CONSTRAINT "ck_itens_recebimento_valores" CHECK (quantidade > 0 and fator > 0 and quantidade_estoque > 0 and preco_compra >= 0 and (preco_venda is null or preco_venda >= 0)),
	CONSTRAINT "ck_itens_recebimento_rateios" CHECK (rateio_frete >= 0 and rateio_desconto >= 0 and rateio_outras >= 0 and custo_unitario_final >= 0 and valor_total >= 0),
	CONSTRAINT "ck_itens_recebimento_atualizar_preco" CHECK (atualizar_preco in ('geral','loja','nao')),
	CONSTRAINT "ck_itens_recebimento_validade" CHECK (fabricacao is null or validade is null or fabricacao <= validade)
);
--> statement-breakpoint
CREATE TABLE "recebimentos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_recebimentos') NOT NULL,
	"loja_id" uuid NOT NULL,
	"estoque_id" uuid NOT NULL,
	"tipo_estoque_id" uuid NOT NULL,
	"fornecedor_id" uuid NOT NULL,
	"data_recebimento" date DEFAULT current_date NOT NULL,
	"codigo_remessa" varchar(30),
	"tem_validade" boolean DEFAULT false NOT NULL,
	"qtd_itens" integer DEFAULT 0 NOT NULL,
	"valor_produtos" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_frete" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_desconto" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_outras_despesas" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"observacoes" text,
	"status" varchar(12) DEFAULT 'rascunho' NOT NULL,
	"movimentado_em" timestamp with time zone,
	"movimentado_por_id" uuid,
	"estornado_em" timestamp with time zone,
	"estornado_por_id" uuid,
	"motivo_estorno" varchar(255),
	"gerar_financeiro" boolean DEFAULT false NOT NULL,
	"financeiro_plano_contas_id" uuid,
	"financeiro_forma_pagamento_id" uuid,
	"financeiro_parcelas" jsonb,
	"conta_financeira_id" uuid,
	CONSTRAINT "pk_recebimentos" PRIMARY KEY("id"),
	CONSTRAINT "ck_recebimentos_status" CHECK (status in ('rascunho','movimentado','estornado')),
	CONSTRAINT "ck_recebimentos_movimentacao" CHECK ((status = 'rascunho') = (movimentado_em is null) and (status = 'estornado') = (estornado_em is not null)),
	CONSTRAINT "ck_recebimentos_valores" CHECK (valor_produtos >= 0 and valor_frete >= 0 and valor_desconto >= 0 and valor_outras_despesas >= 0 and valor_total >= 0),
	CONSTRAINT "ck_recebimentos_financeiro" CHECK (not gerar_financeiro or financeiro_plano_contas_id is not null)
);
--> statement-breakpoint
ALTER TABLE "itens_recebimento" ADD CONSTRAINT "fk_itens_recebimento_recebimento_id" FOREIGN KEY ("recebimento_id") REFERENCES "public"."recebimentos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_recebimento" ADD CONSTRAINT "fk_itens_recebimento_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_recebimento" ADD CONSTRAINT "fk_itens_recebimento_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_recebimento" ADD CONSTRAINT "fk_itens_recebimento_codigo_barras_id" FOREIGN KEY ("codigo_barras_id") REFERENCES "public"."produtos_codigos_barras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_recebimento" ADD CONSTRAINT "fk_itens_recebimento_lote_id" FOREIGN KEY ("lote_id") REFERENCES "public"."produtos_lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recebimentos" ADD CONSTRAINT "fk_recebimentos_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recebimentos" ADD CONSTRAINT "fk_recebimentos_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recebimentos" ADD CONSTRAINT "fk_recebimentos_tipo_estoque_id" FOREIGN KEY ("tipo_estoque_id") REFERENCES "public"."tipos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recebimentos" ADD CONSTRAINT "fk_recebimentos_fornecedor_id" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recebimentos" ADD CONSTRAINT "fk_recebimentos_movimentado_por_id" FOREIGN KEY ("movimentado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recebimentos" ADD CONSTRAINT "fk_recebimentos_estornado_por_id" FOREIGN KEY ("estornado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recebimentos" ADD CONSTRAINT "fk_recebimentos_financeiro_plano_contas_id" FOREIGN KEY ("financeiro_plano_contas_id") REFERENCES "public"."planos_contas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recebimentos" ADD CONSTRAINT "fk_recebimentos_financeiro_forma_pagamento_id" FOREIGN KEY ("financeiro_forma_pagamento_id") REFERENCES "public"."formas_pagamento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_itens_recebimento_sequencia" ON "itens_recebimento" USING btree ("recebimento_id","sequencia");--> statement-breakpoint
CREATE INDEX "ix_itens_recebimento_produto_id" ON "itens_recebimento" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_itens_recebimento_variacao_id" ON "itens_recebimento" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_itens_recebimento_codigo_barras_id" ON "itens_recebimento" USING btree ("codigo_barras_id");--> statement-breakpoint
CREATE INDEX "ix_itens_recebimento_lote_id" ON "itens_recebimento" USING btree ("lote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_recebimentos_codigo" ON "recebimentos" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_fornecedor_id_data_recebimento" ON "recebimentos" USING btree ("fornecedor_id","data_recebimento");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_codigo_remessa" ON "recebimentos" USING btree ("codigo_remessa");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_estoque_id_data_recebimento" ON "recebimentos" USING btree ("estoque_id","data_recebimento");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_loja_id" ON "recebimentos" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_tipo_estoque_id" ON "recebimentos" USING btree ("tipo_estoque_id");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_movimentado_por_id" ON "recebimentos" USING btree ("movimentado_por_id");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_estornado_por_id" ON "recebimentos" USING btree ("estornado_por_id");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_financeiro_plano_contas_id" ON "recebimentos" USING btree ("financeiro_plano_contas_id");--> statement-breakpoint
CREATE INDEX "ix_recebimentos_financeiro_forma_pagamento_id" ON "recebimentos" USING btree ("financeiro_forma_pagamento_id");
--> statement-breakpoint
create trigger tg_recebimentos_versao before insert or update on recebimentos
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_itens_recebimento_versao before insert or update on itens_recebimento
  for each row execute function fn_versao_local();
--> statement-breakpoint
alter table recebimentos add constraint fk_recebimentos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_recebimentos_criado_por_id on recebimentos (criado_por_id);
--> statement-breakpoint
alter table recebimentos add constraint fk_recebimentos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_recebimentos_atualizado_por_id on recebimentos (atualizado_por_id);
--> statement-breakpoint
-- Imutável fora de `rascunho` (o padrão do acerto, 0004): a movimentação muda o status a partir do rascunho (o OLD
-- ainda está aberto) e o estorno só mexe nas colunas do estorno. `conta_financeira_id` (Fase 4) é gravada na mesma
-- transação da movimentação, antes de o status mudar.
create trigger tg_recebimentos_imutavel before update on recebimentos
  for each row execute function fn_protege_imutavel('status', 'rascunho',
    'status,estornado_em,estornado_por_id,motivo_estorno,versao,atualizado_em,atualizado_por_id');
--> statement-breakpoint
create or replace function fn_itens_recebimento_rascunho() returns trigger language plpgsql as $$
-- MD 3.8.1: itens só mudam enquanto o recebimento está em rascunho (a movimentação, F2-B15, grava rateios, custo final
-- e `lote_id` nos itens antes de mudar o status do recebimento, na mesma transação).
begin
  if exists (select 1 from recebimentos r
              where r.id in (new.recebimento_id, case when tg_op = 'UPDATE' then old.recebimento_id end)
                and r.status <> 'rascunho') then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_itens_recebimento_rascunho before insert or update on itens_recebimento
  for each row execute function fn_itens_recebimento_rascunho();
