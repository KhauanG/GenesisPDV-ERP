-- Esquema da nuvem 2 da Fase 3 (F3-B2; MD 3.6.11, 3.11.1, 3.11.9, 3.12.4, 3.5.6; SYNC 16.3; README da API › decisão
-- 221): promoções e os itens delas, orçamentos e os itens, a projeção `vendas_status_pdv` e a conferência do
-- fechamento pelo gerente; e o saldo de comodato passa a aceitar valor negativo. Só o esquema: o cadastro de promoções
-- é do F3-B34, os orçamentos do F3-B60 em diante, o `registrarStatusPdv` do F3-B10, a conferência do F3-B9 e o
-- comodato do F3-B39; os fluxos que levam promoções, orçamentos e a projeção ao caixa são do F3-B7.
--
-- Compatibilidade: nenhuma tabela nova está num fluxo do pull nem em `TABELAS_MOVIMENTO_PDV`, e nenhuma coluna nova
-- nas tabelas de movimento do PDV; nenhuma FK nova nas colunas que ele envia (`vendas.orcamento_id`,
-- `itens_venda.promocao_id` e `item_orcamento_id` continuam sem FK). A única mudança que o `Esquema.g.cs` vê é o CHECK
-- que sai de `saldos_vasilhame_pessoas` (espelho do fluxo `pessoas`): o PDV não tem esse CHECK no SQLite (os espelhos
-- só levam os CHECKs próprios), então o caixa instalado (0.10.0 a 0.13.0) não muda. Nenhum dado existente muda.
--
-- O `uq_templates_documentos_padrao` do MD 3.1.3 (um "padrão" por tipo e loja) já existe desde a 0002, com a mesma
-- definição (`nulls not distinct (tipo, loja_id) where padrao and excluido_em is null`): nenhum banco tem dois padrões
-- do mesmo tipo e loja para desmarcar, e esta migração não toca nele (o teste da 0030 confere o índice).
--
-- A sequência do `codigo` do orçamento vem antes das tabelas (o default usa nextval).
create sequence if not exists seq_codigo_orcamentos as integer start 1 cache 1 no cycle;
--> statement-breakpoint
CREATE TABLE "conferencias_caixa" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"fechamento_id" uuid NOT NULL,
	"conferido_por_id" uuid NOT NULL,
	"conferido_em" timestamp with time zone NOT NULL,
	"situacao" varchar(10) NOT NULL,
	"observacao" text,
	"conta_financeira_id" uuid,
	CONSTRAINT "pk_conferencias_caixa" PRIMARY KEY("id"),
	CONSTRAINT "ck_conferencias_caixa_situacao" CHECK (situacao in ('conferida','divergente'))
);
--> statement-breakpoint
CREATE TABLE "conferencias_caixa_formas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"conferencia_id" uuid NOT NULL,
	"forma_pagamento_id" uuid NOT NULL,
	"valor_conferido" numeric(15, 2) NOT NULL,
	"diferenca" numeric(15, 2) NOT NULL,
	CONSTRAINT "pk_conferencias_caixa_formas" PRIMARY KEY("id"),
	CONSTRAINT "ck_conferencias_caixa_formas_valor" CHECK (valor_conferido >= 0)
);
--> statement-breakpoint
CREATE TABLE "itens_orcamento" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"orcamento_id" uuid NOT NULL,
	"sequencia" integer NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"descricao" varchar(120) NOT NULL,
	"unidade" varchar(6) NOT NULL,
	"quantidade" numeric(15, 3) NOT NULL,
	"preco_unitario" numeric(15, 4) NOT NULL,
	"desconto_item" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_total" numeric(15, 2) NOT NULL,
	"observacao" varchar(255),
	CONSTRAINT "pk_itens_orcamento" PRIMARY KEY("id"),
	CONSTRAINT "ck_itens_orcamento_quantidade" CHECK (quantidade > 0),
	CONSTRAINT "ck_itens_orcamento_valores" CHECK (preco_unitario >= 0 and desconto_item >= 0 and valor_total >= 0)
);
--> statement-breakpoint
CREATE TABLE "orcamentos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_orcamentos') NOT NULL,
	"loja_id" uuid NOT NULL,
	"pessoa_id" uuid,
	"nome" varchar(150) NOT NULL,
	"email" varchar(254),
	"telefone" varchar(20),
	"data" date DEFAULT current_date NOT NULL,
	"dias_validade" smallint DEFAULT 15 NOT NULL,
	"valido_ate" date GENERATED ALWAYS AS (data + dias_validade) STORED NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"status" varchar(10) DEFAULT 'aberto' NOT NULL,
	"respondido" varchar(10) DEFAULT 'nao' NOT NULL,
	"respondido_em" timestamp with time zone,
	"resposta_observacao" varchar(500),
	"vendedor_id" uuid,
	"desconto_tipo" varchar(10),
	"desconto_valor" numeric(15, 2) DEFAULT '0' NOT NULL,
	"desconto_pct" numeric(7, 4),
	"subtotal_bruto" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"condicoes_pagamento" text,
	"observacoes" text,
	"origem" varchar(4) DEFAULT 'erp' NOT NULL,
	"origem_terminal_id" uuid,
	"venda_id" uuid,
	"convertido_em" timestamp with time zone,
	"reservado_terminal_id" uuid,
	"reservado_ate" timestamp with time zone,
	CONSTRAINT "pk_orcamentos" PRIMARY KEY("id"),
	CONSTRAINT "ck_orcamentos_status" CHECK (status in ('aberto','convertido','cancelado')),
	CONSTRAINT "ck_orcamentos_respondido" CHECK (respondido in ('nao','aprovado','recusado')),
	CONSTRAINT "ck_orcamentos_respondido_em" CHECK ((respondido = 'nao') = (respondido_em is null)),
	CONSTRAINT "ck_orcamentos_desconto_tipo" CHECK (desconto_tipo is null or desconto_tipo in ('valor','percentual')),
	CONSTRAINT "ck_orcamentos_dias_validade" CHECK (dias_validade between 0 and 365),
	CONSTRAINT "ck_orcamentos_valores" CHECK (desconto_valor >= 0 and subtotal_bruto >= 0 and total >= 0 and (desconto_pct is null or desconto_pct between 0 and 100)),
	CONSTRAINT "ck_orcamentos_origem" CHECK (origem in ('erp','pdv')),
	CONSTRAINT "ck_orcamentos_origem_terminal" CHECK (origem = 'erp' or origem_terminal_id is not null),
	CONSTRAINT "ck_orcamentos_convertido" CHECK (status <> 'convertido' or convertido_em is not null),
	CONSTRAINT "ck_orcamentos_reserva" CHECK ((reservado_terminal_id is null) = (reservado_ate is null))
);
--> statement-breakpoint
CREATE TABLE "promocoes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"nome" varchar(60) NOT NULL,
	"tipo" varchar(18) NOT NULL,
	"parametros" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inicio" timestamp with time zone,
	"fim" timestamp with time zone,
	"dias_semana" smallint[],
	"hora_inicio" time,
	"hora_fim" time,
	"lojas" uuid[],
	"prioridade" smallint DEFAULT 0 NOT NULL,
	"acumulativa" boolean DEFAULT false NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_promocoes" PRIMARY KEY("id"),
	CONSTRAINT "ck_promocoes_tipo" CHECK (tipo in ('leve_pague','combo','desconto_pct_item','preco_fixo','forma_pagamento')),
	CONSTRAINT "ck_promocoes_parametros" CHECK (jsonb_typeof(parametros) = 'object'),
	CONSTRAINT "ck_promocoes_vigencia" CHECK (fim is null or inicio is null or fim > inicio),
	CONSTRAINT "ck_promocoes_horario" CHECK ((hora_inicio is null) = (hora_fim is null)),
	CONSTRAINT "ck_promocoes_dias_semana" CHECK (dias_semana is null or (cardinality(dias_semana) between 1 and 7 and dias_semana <@ '{0,1,2,3,4,5,6}'::smallint[])),
	CONSTRAINT "ck_promocoes_lojas" CHECK (lojas is null or cardinality(lojas) >= 1)
);
--> statement-breakpoint
CREATE TABLE "promocoes_itens" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"promocao_id" uuid NOT NULL,
	"produto_id" uuid,
	"categoria_id" uuid,
	"quantidade" numeric(15, 3) DEFAULT '1' NOT NULL,
	"papel" varchar(8) NOT NULL,
	CONSTRAINT "pk_promocoes_itens" PRIMARY KEY("id"),
	CONSTRAINT "ck_promocoes_itens_alvo" CHECK ((produto_id is null) <> (categoria_id is null)),
	CONSTRAINT "ck_promocoes_itens_papel" CHECK (papel in ('gatilho','brinde')),
	CONSTRAINT "ck_promocoes_itens_quantidade" CHECK (quantidade > 0)
);
--> statement-breakpoint
CREATE TABLE "vendas_status_pdv" (
	"id" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"caixa_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"status_fiscal" varchar(22) NOT NULL,
	"devolucao" varchar(8) NOT NULL,
	"cancelada_em" timestamp with time zone,
	"cancelamento_origem" varchar(4),
	CONSTRAINT "pk_vendas_status_pdv" PRIMARY KEY("id"),
	CONSTRAINT "ck_vendas_status_pdv_status" CHECK (status in ('rascunho','em_andamento','em_pagamento','suspensa','pedido_pendente','finalizada','cancelada')),
	CONSTRAINT "ck_vendas_status_pdv_status_fiscal" CHECK (status_fiscal in ('nao_aplicavel','pendente','transmitindo','autorizada','contingencia','rejeitada','denegada','cancelamento_pendente','cancelada','inutilizada','nfe_solicitada')),
	CONSTRAINT "ck_vendas_status_pdv_devolucao" CHECK (devolucao in ('nenhuma','parcial','total')),
	CONSTRAINT "ck_vendas_status_pdv_cancelamento_origem" CHECK (cancelamento_origem is null or cancelamento_origem in ('pdv','erp'))
);
--> statement-breakpoint
-- Comodato comutativo (padrões da Fase 3): o saldo é a soma dos movimentos na ordem em que chegam e pode ficar negativo
-- por um tempo (a baixa de um caixa antes do empréstimo de outro), com o alerta `VASILHAME_COMODATO_NEGATIVO` (F3-B39).
-- Limitar a 0 na chegada daria um saldo final errado. Nenhuma linha muda (todas são >= 0 hoje).
ALTER TABLE "saldos_vasilhame_pessoas" DROP CONSTRAINT "ck_saldos_vasilhame_pessoas_quantidade";--> statement-breakpoint
ALTER TABLE "conferencias_caixa" ADD CONSTRAINT "fk_conferencias_caixa_fechamento_id" FOREIGN KEY ("fechamento_id") REFERENCES "public"."fechamentos_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conferencias_caixa" ADD CONSTRAINT "fk_conferencias_caixa_conferido_por_id" FOREIGN KEY ("conferido_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conferencias_caixa_formas" ADD CONSTRAINT "fk_conferencias_caixa_formas_conferencia_id" FOREIGN KEY ("conferencia_id") REFERENCES "public"."conferencias_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conferencias_caixa_formas" ADD CONSTRAINT "fk_conferencias_caixa_formas_forma_pagamento_id" FOREIGN KEY ("forma_pagamento_id") REFERENCES "public"."formas_pagamento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_orcamento" ADD CONSTRAINT "fk_itens_orcamento_orcamento_id" FOREIGN KEY ("orcamento_id") REFERENCES "public"."orcamentos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_orcamento" ADD CONSTRAINT "fk_itens_orcamento_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_orcamento" ADD CONSTRAINT "fk_itens_orcamento_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamentos" ADD CONSTRAINT "fk_orcamentos_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamentos" ADD CONSTRAINT "fk_orcamentos_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamentos" ADD CONSTRAINT "fk_orcamentos_vendedor_id" FOREIGN KEY ("vendedor_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamentos" ADD CONSTRAINT "fk_orcamentos_origem_terminal_id" FOREIGN KEY ("origem_terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamentos" ADD CONSTRAINT "fk_orcamentos_venda_id" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamentos" ADD CONSTRAINT "fk_orcamentos_reservado_terminal_id" FOREIGN KEY ("reservado_terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promocoes_itens" ADD CONSTRAINT "fk_promocoes_itens_promocao_id" FOREIGN KEY ("promocao_id") REFERENCES "public"."promocoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promocoes_itens" ADD CONSTRAINT "fk_promocoes_itens_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promocoes_itens" ADD CONSTRAINT "fk_promocoes_itens_categoria_id" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas_status_pdv" ADD CONSTRAINT "fk_vendas_status_pdv_id" FOREIGN KEY ("id") REFERENCES "public"."vendas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas_status_pdv" ADD CONSTRAINT "fk_vendas_status_pdv_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas_status_pdv" ADD CONSTRAINT "fk_vendas_status_pdv_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conferencias_caixa_fechamento" ON "conferencias_caixa" USING btree ("fechamento_id");--> statement-breakpoint
CREATE INDEX "ix_conferencias_caixa_conferido_por_id" ON "conferencias_caixa" USING btree ("conferido_por_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conferencias_caixa_formas" ON "conferencias_caixa_formas" USING btree ("conferencia_id","forma_pagamento_id");--> statement-breakpoint
CREATE INDEX "ix_conferencias_caixa_formas_forma_pagamento_id" ON "conferencias_caixa_formas" USING btree ("forma_pagamento_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_itens_orcamento_sequencia" ON "itens_orcamento" USING btree ("orcamento_id","sequencia");--> statement-breakpoint
CREATE INDEX "ix_itens_orcamento_produto_id" ON "itens_orcamento" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_itens_orcamento_variacao_id" ON "itens_orcamento" USING btree ("variacao_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orcamentos_codigo" ON "orcamentos" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "ix_orcamentos_loja_id_status" ON "orcamentos" USING btree ("loja_id","status");--> statement-breakpoint
CREATE INDEX "ix_orcamentos_pessoa_id" ON "orcamentos" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "ix_orcamentos_vendedor_id" ON "orcamentos" USING btree ("vendedor_id");--> statement-breakpoint
CREATE INDEX "ix_orcamentos_origem_terminal_id" ON "orcamentos" USING btree ("origem_terminal_id");--> statement-breakpoint
CREATE INDEX "ix_orcamentos_venda_id" ON "orcamentos" USING btree ("venda_id");--> statement-breakpoint
CREATE INDEX "ix_orcamentos_reservado_terminal_id" ON "orcamentos" USING btree ("reservado_terminal_id");--> statement-breakpoint
CREATE INDEX "ix_promocoes_vigencia" ON "promocoes" USING btree ("inicio","fim") WHERE ativo and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_promocoes_itens_promocao_id" ON "promocoes_itens" USING btree ("promocao_id");--> statement-breakpoint
CREATE INDEX "ix_promocoes_itens_produto_id" ON "promocoes_itens" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_promocoes_itens_categoria_id" ON "promocoes_itens" USING btree ("categoria_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_status_pdv_caixa_id_versao" ON "vendas_status_pdv" USING btree ("caixa_id","versao");--> statement-breakpoint
CREATE INDEX "ix_vendas_status_pdv_terminal_id" ON "vendas_status_pdv" USING btree ("terminal_id");
--> statement-breakpoint
-- Objetos que o drizzle-kit não gera (MD 1.5, 1.3 AU, 6.4). Versão: as que vão descer ao caixa (promoções e itens no
-- fluxo `catalogo`; orçamentos, itens e a projeção no `operacao`, F3-B7) já nascem com fn_versao (a trava de
-- ordenação) e o índice de versão; `valido_ate` é gerada e entra como isenta (COLUNAS_ISENTAS_VERSAO). A conferência
-- não sai da nuvem: fn_versao_local.
create trigger tg_promocoes_versao before insert or update on promocoes
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_promocoes_versao on promocoes (versao);
--> statement-breakpoint
create trigger tg_promocoes_itens_versao before insert or update on promocoes_itens
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_promocoes_itens_versao on promocoes_itens (versao);
--> statement-breakpoint
create trigger tg_orcamentos_versao before insert or update on orcamentos
  for each row execute function fn_versao('valido_ate');
--> statement-breakpoint
create index ix_orcamentos_versao on orcamentos (versao);
--> statement-breakpoint
create trigger tg_itens_orcamento_versao before insert or update on itens_orcamento
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_itens_orcamento_versao on itens_orcamento (versao);
--> statement-breakpoint
create trigger tg_vendas_status_pdv_versao before insert or update on vendas_status_pdv
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_vendas_status_pdv_versao on vendas_status_pdv (versao);
--> statement-breakpoint
create trigger tg_conferencias_caixa_versao before insert or update on conferencias_caixa
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_conferencias_caixa_formas_versao before insert or update on conferencias_caixa_formas
  for each row execute function fn_versao_local();
--> statement-breakpoint
alter table promocoes add constraint fk_promocoes_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_promocoes_criado_por_id on promocoes (criado_por_id);
--> statement-breakpoint
alter table promocoes add constraint fk_promocoes_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_promocoes_atualizado_por_id on promocoes (atualizado_por_id);
--> statement-breakpoint
alter table orcamentos add constraint fk_orcamentos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_orcamentos_criado_por_id on orcamentos (criado_por_id);
--> statement-breakpoint
alter table orcamentos add constraint fk_orcamentos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_orcamentos_atualizado_por_id on orcamentos (atualizado_por_id);
--> statement-breakpoint
alter table conferencias_caixa add constraint fk_conferencias_caixa_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_conferencias_caixa_criado_por_id on conferencias_caixa (criado_por_id);
--> statement-breakpoint
alter table conferencias_caixa add constraint fk_conferencias_caixa_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_conferencias_caixa_atualizado_por_id on conferencias_caixa (atualizado_por_id);
--> statement-breakpoint
-- Colunas de filtro do pull são imutáveis (MD 6.4 regra 2): o orçamento desce pela loja e a projeção pelo caixa da
-- venda; `terminal_id` (o terminal que criou a venda) também não muda (MD 3.11.9).
create trigger tg_orcamentos_filtro_imutavel before update on orcamentos
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_vendas_status_pdv_filtro_imutavel before update on vendas_status_pdv
  for each row execute function fn_filtro_imutavel('caixa_id', 'terminal_id');
--> statement-breakpoint
-- Exclusão física proibida (a função da 0028): o caixa offline pode ter na venda o `promocao_id`, o `orcamento_id` e o
-- `item_orcamento_id` (sem FK, padrões da Fase 3) de uma linha que a nuvem precisa continuar conhecendo, e a linha que
-- desce só sai do caixa como tombstone (`excluido_em`, MD 6.4 regra 4). Vale para o pai e para os itens.
create trigger tg_promocoes_sem_delete before delete on promocoes
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_promocoes_sem_truncate before truncate on promocoes
  for each statement execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_promocoes_itens_sem_delete before delete on promocoes_itens
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_promocoes_itens_sem_truncate before truncate on promocoes_itens
  for each statement execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_orcamentos_sem_delete before delete on orcamentos
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_orcamentos_sem_truncate before truncate on orcamentos
  for each statement execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_itens_orcamento_sem_delete before delete on itens_orcamento
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_itens_orcamento_sem_truncate before truncate on itens_orcamento
  for each statement execute function fn_exclusao_fisica_proibida();
