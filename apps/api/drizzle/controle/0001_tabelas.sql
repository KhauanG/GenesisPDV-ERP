CREATE TABLE "acessos_suporte" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"admin_id" uuid NOT NULL,
	"empresa_id" uuid NOT NULL,
	"motivo" varchar(255) NOT NULL,
	"somente_leitura" boolean DEFAULT true NOT NULL,
	"iniciado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"encerrado_em" timestamp with time zone,
	CONSTRAINT "pk_acessos_suporte" PRIMARY KEY("id"),
	CONSTRAINT "ck_acessos_suporte_expira_em" CHECK (expira_em <= iniciado_em + interval '4 hours')
);
--> statement-breakpoint
CREATE TABLE "admins_plataforma" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"nome" varchar(100) NOT NULL,
	"email" varchar(254) NOT NULL,
	"senha_hash" varchar(255) NOT NULL,
	"papel" varchar(20) DEFAULT 'suporte' NOT NULL,
	"totp_segredo_cifrado" "bytea",
	"totp_ativo" boolean DEFAULT false NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"tentativas_falhas" smallint DEFAULT 0 NOT NULL,
	"bloqueado_ate" timestamp with time zone,
	"ultimo_login_em" timestamp with time zone,
	CONSTRAINT "pk_admins_plataforma" PRIMARY KEY("id"),
	CONSTRAINT "ck_admins_plataforma_papel" CHECK (papel in ('superadmin','suporte','financeiro','somente_leitura'))
);
--> statement-breakpoint
CREATE TABLE "ativacoes_pdv" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"empresa_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"numero_caixa" smallint NOT NULL,
	"descricao" varchar(40),
	"codigo_hash" varchar(64) NOT NULL,
	"codigo_final" varchar(2) NOT NULL,
	"validade_horas" smallint DEFAULT 24 NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'pendente' NOT NULL,
	"substitui_terminal_id" uuid,
	"criado_por_usuario_id" uuid NOT NULL,
	"criado_por_nome" varchar(100) NOT NULL,
	"usado_em" timestamp with time zone,
	"usado_ip" "inet",
	"terminal_id" uuid,
	"cancelado_em" timestamp with time zone,
	"cancelado_por_usuario_id" uuid,
	CONSTRAINT "pk_ativacoes_pdv" PRIMARY KEY("id"),
	CONSTRAINT "ck_ativacoes_pdv_status" CHECK (status in ('pendente','usado','expirado','cancelado')),
	CONSTRAINT "ck_ativacoes_pdv_validade_horas" CHECK (validade_horas in (1,24,72))
);
--> statement-breakpoint
CREATE TABLE "auditoria_plataforma" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"admin_id" uuid,
	"empresa_id" uuid,
	"acao" varchar(60) NOT NULL,
	"entidade" varchar(60) NOT NULL,
	"registro_id" uuid,
	"antes" jsonb,
	"depois" jsonb,
	"ip" "inet",
	CONSTRAINT "pk_auditoria_plataforma" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "empresas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"codigo" integer DEFAULT nextval('seq_codigo_empresa') NOT NULL,
	"razao_social" varchar(150) NOT NULL,
	"nome_fantasia" varchar(150),
	"cnpj" varchar(14) NOT NULL,
	"nome_banco" varchar(63) NOT NULL,
	"servidor_banco_id" uuid NOT NULL,
	"geracao_banco" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'provisionando' NOT NULL,
	"motivo_status" varchar(255),
	"plano_id" uuid NOT NULL,
	"limite_lojas" integer,
	"limite_terminais" integer,
	"limite_usuarios" integer,
	"versao_schema" varchar(40),
	"canal_pdv" varchar(10) DEFAULT 'estavel' NOT NULL,
	"canario" boolean DEFAULT false NOT NULL,
	"nome_responsavel" varchar(100),
	"email_responsavel" varchar(254),
	"telefone_responsavel" varchar(20),
	"ativada_em" timestamp with time zone,
	"suspensa_em" timestamp with time zone,
	"cancelada_em" timestamp with time zone,
	"dados_retidos_ate" date,
	"observacoes" text,
	"criado_por_admin_id" uuid,
	"atualizado_por_admin_id" uuid,
	CONSTRAINT "pk_empresas" PRIMARY KEY("id"),
	CONSTRAINT "ck_empresas_status" CHECK (status in ('provisionando','ativa','migrando','suspensa','cancelada')),
	CONSTRAINT "ck_empresas_geracao_banco" CHECK (geracao_banco >= 1),
	CONSTRAINT "ck_empresas_nome_banco" CHECK (nome_banco = 'genesis_emp_' || codigo),
	CONSTRAINT "ck_empresas_canal_pdv" CHECK (canal_pdv in ('estavel','beta'))
);
--> statement-breakpoint
CREATE TABLE "migracoes_empresas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"empresa_id" uuid NOT NULL,
	"migracao" varchar(120) NOT NULL,
	"ordem" integer NOT NULL,
	"hash" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'pendente' NOT NULL,
	"iniciada_em" timestamp with time zone,
	"concluida_em" timestamp with time zone,
	"duracao_ms" integer,
	"erro" text,
	"executado_por" varchar(100) NOT NULL,
	CONSTRAINT "pk_migracoes_empresas" PRIMARY KEY("id"),
	CONSTRAINT "ck_migracoes_empresas_status" CHECK (status in ('pendente','aplicando','aplicada','falhou'))
);
--> statement-breakpoint
CREATE TABLE "planos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"codigo" varchar(30) NOT NULL,
	"nome" varchar(60) NOT NULL,
	"descricao" text,
	"limite_lojas" integer DEFAULT 1 NOT NULL,
	"limite_terminais" integer DEFAULT 1 NOT NULL,
	"limite_usuarios" integer,
	"recursos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preco_mensal" numeric(15, 2) DEFAULT '0' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_por_admin_id" uuid,
	"atualizado_por_admin_id" uuid,
	CONSTRAINT "pk_planos" PRIMARY KEY("id"),
	CONSTRAINT "ck_planos_limites" CHECK (limite_lojas >= 1 and limite_terminais >= 0 and (limite_usuarios is null or limite_usuarios >= 1))
);
--> statement-breakpoint
CREATE TABLE "servidores_banco" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"nome" varchar(60) NOT NULL,
	"host" varchar(255) NOT NULL,
	"porta" integer DEFAULT 5432 NOT NULL,
	"usuario" varchar(63) NOT NULL,
	"senha_cifrada" "bytea" NOT NULL,
	"capacidade_empresas" integer,
	"aceita_novas_empresas" boolean DEFAULT true NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"observacoes" text,
	CONSTRAINT "pk_servidores_banco" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "sessoes_admin" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"admin_id" uuid NOT NULL,
	"refresh_token_hash" varchar(64) NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"ultimo_uso_em" timestamp with time zone,
	"ip" "inet",
	"user_agent" varchar(255),
	"encerrada_em" timestamp with time zone,
	CONSTRAINT "pk_sessoes_admin" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "tentativas_ativacao" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet" NOT NULL,
	"codigo_empresa" integer,
	"sucesso" boolean NOT NULL,
	"motivo_falha" varchar(40),
	CONSTRAINT "pk_tentativas_ativacao" PRIMARY KEY("id"),
	CONSTRAINT "ck_tentativas_ativacao_motivo_falha" CHECK (motivo_falha is null or motivo_falha in ('codigo_invalido','expirado','empresa_inativa','limite_plano','ip_bloqueado'))
);
--> statement-breakpoint
CREATE TABLE "terminais_pdv" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"empresa_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"numero_caixa" smallint NOT NULL,
	"descricao" varchar(40),
	"token_hash" varchar(64) NOT NULL,
	"token_emitido_em" timestamp with time zone DEFAULT now() NOT NULL,
	"token_hash_anterior" varchar(64),
	"token_anterior_valido_ate" timestamp with time zone,
	"token_atual_usado_em" timestamp with time zone,
	"token_renovacao_requisicao_id" uuid,
	"chave_backup_cifrada" "bytea",
	"chave_publica_terminal" "bytea" NOT NULL,
	"chave_publica_algoritmo" varchar(10) NOT NULL,
	"id_hardware_pendente" varchar(128),
	"status" varchar(20) DEFAULT 'provisionando' NOT NULL,
	"carencia_ate" timestamp with time zone,
	"ativado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ativado_por_usuario_id" uuid,
	"ativacao_id" uuid NOT NULL,
	"revogado_em" timestamp with time zone,
	"revogado_por_usuario_id" uuid,
	"motivo_revogacao" varchar(255),
	"substituido_por_terminal_id" uuid,
	"nome_maquina" varchar(100),
	"sistema_operacional" varchar(60),
	"id_hardware" varchar(128),
	"versao_app" varchar(20),
	"ultimo_contato_em" timestamp with time zone,
	"ultimo_ip" "inet",
	CONSTRAINT "pk_terminais_pdv" PRIMARY KEY("id"),
	CONSTRAINT "ck_terminais_pdv_status" CHECK (status in ('provisionando','ativo','desativando','revogado')),
	CONSTRAINT "ck_terminais_pdv_chave_publica_algoritmo" CHECK (chave_publica_algoritmo in ('x25519','p256'))
);
--> statement-breakpoint
CREATE TABLE "versoes_app_pdv" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" varchar(20) NOT NULL,
	"canal" varchar(10) DEFAULT 'estavel' NOT NULL,
	"plataforma" varchar(20) NOT NULL,
	"url_pacote" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"tamanho_bytes" bigint NOT NULL,
	"versao_minima" boolean DEFAULT false NOT NULL,
	"publicada_em" timestamp with time zone,
	"notas" text,
	CONSTRAINT "pk_versoes_app_pdv" PRIMARY KEY("id"),
	CONSTRAINT "ck_versoes_app_pdv_canal" CHECK (canal in ('estavel','beta')),
	CONSTRAINT "ck_versoes_app_pdv_plataforma" CHECK (plataforma in ('windows_x64','linux_x64'))
);
--> statement-breakpoint
ALTER TABLE "acessos_suporte" ADD CONSTRAINT "fk_acessos_suporte_admin_id" FOREIGN KEY ("admin_id") REFERENCES "public"."admins_plataforma"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acessos_suporte" ADD CONSTRAINT "fk_acessos_suporte_empresa_id" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ativacoes_pdv" ADD CONSTRAINT "fk_ativacoes_pdv_empresa_id" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "empresas" ADD CONSTRAINT "fk_empresas_servidor_banco_id" FOREIGN KEY ("servidor_banco_id") REFERENCES "public"."servidores_banco"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "empresas" ADD CONSTRAINT "fk_empresas_plano_id" FOREIGN KEY ("plano_id") REFERENCES "public"."planos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migracoes_empresas" ADD CONSTRAINT "fk_migracoes_empresas_empresa_id" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes_admin" ADD CONSTRAINT "fk_sessoes_admin_admin_id" FOREIGN KEY ("admin_id") REFERENCES "public"."admins_plataforma"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminais_pdv" ADD CONSTRAINT "fk_terminais_pdv_empresa_id" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminais_pdv" ADD CONSTRAINT "fk_terminais_pdv_ativacao_id" FOREIGN KEY ("ativacao_id") REFERENCES "public"."ativacoes_pdv"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminais_pdv" ADD CONSTRAINT "fk_terminais_pdv_substituido_por_terminal_id" FOREIGN KEY ("substituido_por_terminal_id") REFERENCES "public"."terminais_pdv"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_acessos_suporte_empresa_id_iniciado_em" ON "acessos_suporte" USING btree ("empresa_id","iniciado_em");--> statement-breakpoint
CREATE INDEX "ix_acessos_suporte_admin_id" ON "acessos_suporte" USING btree ("admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_admins_plataforma_email" ON "admins_plataforma" USING btree (lower(email)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ativacoes_pdv_codigo_hash" ON "ativacoes_pdv" USING btree ("codigo_hash") WHERE status = 'pendente';--> statement-breakpoint
CREATE INDEX "ix_ativacoes_pdv_empresa_id_status" ON "ativacoes_pdv" USING btree ("empresa_id","status");--> statement-breakpoint
CREATE INDEX "ix_ativacoes_pdv_substitui_terminal_id" ON "ativacoes_pdv" USING btree ("substitui_terminal_id");--> statement-breakpoint
CREATE INDEX "ix_ativacoes_pdv_terminal_id" ON "ativacoes_pdv" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_auditoria_plataforma_empresa_id_criado_em" ON "auditoria_plataforma" USING btree ("empresa_id","criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_empresas_codigo" ON "empresas" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_empresas_nome_banco" ON "empresas" USING btree ("nome_banco");--> statement-breakpoint
CREATE INDEX "ix_empresas_cnpj" ON "empresas" USING btree ("cnpj");--> statement-breakpoint
CREATE INDEX "ix_empresas_plano_id" ON "empresas" USING btree ("plano_id");--> statement-breakpoint
CREATE INDEX "ix_empresas_servidor_banco_id" ON "empresas" USING btree ("servidor_banco_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_migracoes_empresas_empresa_id_migracao" ON "migracoes_empresas" USING btree ("empresa_id","migracao");--> statement-breakpoint
CREATE INDEX "ix_migracoes_empresas_status" ON "migracoes_empresas" USING btree ("status") WHERE status in ('pendente','aplicando','falhou');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_planos_codigo" ON "planos" USING btree ("codigo") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_servidores_banco_nome" ON "servidores_banco" USING btree ("nome") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sessoes_admin_refresh_token_hash" ON "sessoes_admin" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "ix_sessoes_admin_admin_id" ON "sessoes_admin" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "ix_tentativas_ativacao_ip_criado_em" ON "tentativas_ativacao" USING btree ("ip","criado_em");--> statement-breakpoint
CREATE INDEX "ix_terminais_pdv_ativacao_id" ON "terminais_pdv" USING btree ("ativacao_id");--> statement-breakpoint
CREATE INDEX "ix_terminais_pdv_substituido_por_terminal_id" ON "terminais_pdv" USING btree ("substituido_por_terminal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_terminais_pdv_caixa_ativo" ON "terminais_pdv" USING btree ("empresa_id","caixa_id") WHERE status in ('provisionando','ativo') and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_terminais_pdv_empresa_id_status" ON "terminais_pdv" USING btree ("empresa_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_versoes_app_pdv_versao" ON "versoes_app_pdv" USING btree ("versao","canal","plataforma");