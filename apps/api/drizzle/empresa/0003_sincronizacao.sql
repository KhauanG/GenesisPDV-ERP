CREATE TABLE "comandos_terminal" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"terminal_id" uuid NOT NULL,
	"tipo" varchar(20) NOT NULL,
	"parametros" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(10) DEFAULT 'pendente' NOT NULL,
	"entregue_em" timestamp with time zone,
	"executado_em" timestamp with time zone,
	"resultado" jsonb,
	CONSTRAINT "pk_comandos_terminal" PRIMARY KEY("id"),
	CONSTRAINT "ck_comandos_terminal_tipo" CHECK (tipo in ('revogar','ressincronizar','ressincronizar_fluxo','enviar_logs','atualizar_app','mensagem','reservar_faixa')),
	CONSTRAINT "ck_comandos_terminal_status" CHECK (status in ('pendente','entregue','executado','falhou','cancelado'))
);
--> statement-breakpoint
CREATE TABLE "entidades_evento" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"entidade_tipo" varchar(30) NOT NULL,
	"entidade_id" uuid NOT NULL,
	"evento_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	CONSTRAINT "pk_entidades_evento" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "eventos_recebidos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"evento_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	"sequencia_terminal" bigint NOT NULL,
	"tipo" varchar(40) NOT NULL,
	"versao_schema" smallint NOT NULL,
	"agregado_tipo" varchar(30) NOT NULL,
	"agregado_id" uuid NOT NULL,
	"dependencias" jsonb,
	"lote_id" uuid,
	"ocorrido_em" timestamp with time zone NOT NULL,
	"ocorrido_em_local" timestamp with time zone,
	"status" varchar(12) DEFAULT 'recebido' NOT NULL,
	"tentativas" smallint DEFAULT 0 NOT NULL,
	"erro_codigo" varchar(40),
	"erro" text,
	"payload" jsonb,
	"payload_sha256" varchar(64) NOT NULL,
	"resultado" jsonb,
	"versao_nuvem" bigint,
	"versao_nuvem_fim" bigint,
	"aplicado_em" timestamp with time zone,
	"resolucao_entregue_em" timestamp with time zone,
	"descartado_em" timestamp with time zone,
	"descartado_por_id" uuid,
	"justificativa_descarte" text,
	CONSTRAINT "pk_eventos_recebidos" PRIMARY KEY("id"),
	CONSTRAINT "ck_eventos_recebidos_status" CHECK (status in ('recebido','aplicado','erro','retido','descartado'))
);
--> statement-breakpoint
CREATE TABLE "terminais" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"descricao" varchar(40),
	"status" varchar(12) DEFAULT 'ativo' NOT NULL,
	"nome_maquina" varchar(100),
	"sistema_operacional" varchar(60),
	"id_hardware" varchar(128),
	"versao_app" varchar(20),
	"ativado_em" timestamp with time zone NOT NULL,
	"ativado_por_id" uuid,
	"revogado_em" timestamp with time zone,
	"revogado_por_id" uuid,
	"motivo_revogacao" varchar(255),
	"ultimo_contato_em" timestamp with time zone,
	"ultimo_ip" "inet",
	"ultimo_pull_em" timestamp with time zone,
	"ultimo_push_em" timestamp with time zone,
	"cursor_pull" jsonb,
	"eventos_pendentes" integer DEFAULT 0 NOT NULL,
	"evento_mais_antigo_em" timestamp with time zone,
	"nfce_contingencia_pendentes" integer DEFAULT 0 NOT NULL,
	"nfce_contingencia_mais_antiga_em" timestamp with time zone,
	"nfce_ultimo_numero" integer,
	"ultima_sequencia_gerada" bigint,
	"venda_ultimo_numero" bigint,
	"vale_ultimo_numero" bigint,
	"eventos_rejeitados" integer DEFAULT 0 NOT NULL,
	"inutilizacoes_pendentes" integer DEFAULT 0 NOT NULL,
	"disco_livre_mb" integer,
	"tamanho_banco_mb" integer,
	"fila_impressao_pendentes" integer DEFAULT 0 NOT NULL,
	"sse_conectado" boolean,
	"versao_schema_local" integer,
	"dinheiro_estimado_gaveta" numeric(15, 2),
	"relogio_confiavel" boolean,
	"estado_local" varchar(25),
	"desativacao_confirmada_em" timestamp with time zone,
	"desativacao_ultima_sequencia" bigint,
	"desativacao_venda_ultimo_numero" bigint,
	"desativacao_vale_ultimo_numero" bigint,
	"desativacao_nfce_ultimo_numero" jsonb,
	"vendas_cancelamento_pendente" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"configuracao_local" jsonb,
	"desvio_relogio_ms" integer,
	"certificado_validade" timestamp with time zone,
	"sessao_caixa_id" uuid,
	"operador_id" uuid,
	"ultimo_erro" text,
	CONSTRAINT "pk_terminais" PRIMARY KEY("id"),
	CONSTRAINT "ck_terminais_status" CHECK (status in ('ativo','desativando','revogado')),
	CONSTRAINT "ck_terminais_estado_local" CHECK (estado_local is null or estado_local in ('ativo','desativando','desativando_confirmado'))
);
--> statement-breakpoint
ALTER TABLE "comandos_terminal" ADD CONSTRAINT "fk_comandos_terminal_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entidades_evento" ADD CONSTRAINT "fk_entidades_evento_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos_recebidos" ADD CONSTRAINT "fk_eventos_recebidos_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminais" ADD CONSTRAINT "fk_terminais_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminais" ADD CONSTRAINT "fk_terminais_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_comandos_terminal_pendentes" ON "comandos_terminal" USING btree ("terminal_id") WHERE status in ('pendente','entregue');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_entidades_evento" ON "entidades_evento" USING btree ("entidade_tipo","entidade_id","evento_id");--> statement-breakpoint
CREATE INDEX "ix_entidades_evento_evento_id" ON "entidades_evento" USING btree ("evento_id");--> statement-breakpoint
CREATE INDEX "ix_entidades_evento_terminal_id" ON "entidades_evento" USING btree ("terminal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_eventos_recebidos_evento_id" ON "eventos_recebidos" USING btree ("evento_id");--> statement-breakpoint
ALTER TABLE "entidades_evento" ADD CONSTRAINT "fk_entidades_evento_evento_id" FOREIGN KEY ("evento_id") REFERENCES "public"."eventos_recebidos"("evento_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_eventos_recebidos_terminal_sequencia" ON "eventos_recebidos" USING btree ("terminal_id","sequencia_terminal");--> statement-breakpoint
CREATE INDEX "ix_eventos_recebidos_status" ON "eventos_recebidos" USING btree ("terminal_id","status") WHERE status in ('erro','retido');--> statement-breakpoint
CREATE INDEX "ix_eventos_recebidos_agregado" ON "eventos_recebidos" USING btree ("terminal_id","agregado_tipo","agregado_id");--> statement-breakpoint
CREATE INDEX "ix_eventos_recebidos_lote_id" ON "eventos_recebidos" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "ix_eventos_recebidos_versao_nuvem_fim" ON "eventos_recebidos" USING btree ("versao_nuvem_fim") WHERE versao_nuvem_fim is not null;--> statement-breakpoint
CREATE INDEX "ix_terminais_loja_id" ON "terminais" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_terminais_caixa_id" ON "terminais" USING btree ("caixa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_terminais_caixa_ativo" ON "terminais" USING btree ("caixa_id") WHERE status = 'ativo' and excluido_em is null;--> statement-breakpoint
-- MD 3.15: `terminais` e `comandos_terminal` não são lidas por nenhum fluxo do pull (—) → fn_versao_local.
create trigger tg_terminais_versao before insert or update on terminais
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_comandos_terminal_versao before insert or update on comandos_terminal
  for each row execute function fn_versao_local();
--> statement-breakpoint
alter table terminais add constraint fk_terminais_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_terminais_criado_por_id on terminais (criado_por_id);
--> statement-breakpoint
alter table terminais add constraint fk_terminais_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_terminais_atualizado_por_id on terminais (atualizado_por_id);
--> statement-breakpoint
alter table comandos_terminal add constraint fk_comandos_terminal_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_comandos_terminal_criado_por_id on comandos_terminal (criado_por_id);
--> statement-breakpoint
alter table comandos_terminal add constraint fk_comandos_terminal_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_comandos_terminal_atualizado_por_id on comandos_terminal (atualizado_por_id);
--> statement-breakpoint
-- FKs adiadas na 0001 (README › Decisões 7): caixas e numerações → terminais (ciclo de tipos com `caixas`).
alter table caixas add constraint fk_caixas_terminal_id foreign key (terminal_id) references terminais (id);
--> statement-breakpoint
alter table caixas add constraint fk_caixas_terminal_anterior_id foreign key (terminal_anterior_id) references terminais (id);
--> statement-breakpoint
alter table numeracoes add constraint fk_numeracoes_ultimo_atualizado_por_terminal_id
  foreign key (ultimo_atualizado_por_terminal_id) references terminais (id);
--> statement-breakpoint
-- ERP 17.1: a lista de ações é aberta (catálogo em @genesis/shared, validado pela API); sem CHECK de banco.
alter table auditoria drop constraint if exists ck_auditoria_acao;
