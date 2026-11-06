CREATE TABLE "backups_empresas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"empresa_id" uuid NOT NULL,
	"tipo" varchar(12) DEFAULT 'diario' NOT NULL,
	"chave_armazenamento" varchar(500),
	"tamanho_bytes" bigint,
	"sha256" varchar(64),
	"status" varchar(12) DEFAULT 'executando' NOT NULL,
	"iniciado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluido_em" timestamp with time zone,
	"retencao_ate" date,
	"erro" text,
	CONSTRAINT "pk_backups_empresas" PRIMARY KEY("id"),
	CONSTRAINT "ck_backups_empresas_tipo" CHECK (tipo in ('diario','manual','cancelamento')),
	CONSTRAINT "ck_backups_empresas_status" CHECK (status in ('executando','concluido','falhou','expirado')),
	CONSTRAINT "ck_backups_empresas_concluido" CHECK (status <> 'concluido' or (chave_armazenamento is not null and sha256 is not null and concluido_em is not null))
);
--> statement-breakpoint
DROP INDEX "uq_versoes_app_pdv_versao";--> statement-breakpoint
ALTER TABLE "empresas" ALTER COLUMN "canal_pdv" SET DATA TYPE varchar(7);--> statement-breakpoint
ALTER TABLE "empresas" ALTER COLUMN "canal_pdv" SET DEFAULT 'estavel';--> statement-breakpoint
-- MD 2.7 `versao` (SemVer) colidia com a `versao` das CP: a coluna do app passa a `versao_app` e a CP volta a existir.
ALTER TABLE "versoes_app_pdv" RENAME COLUMN "versao" TO "versao_app";--> statement-breakpoint
ALTER TABLE "versoes_app_pdv" ADD COLUMN "versao" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "versoes_app_pdv" ALTER COLUMN "versao" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "admins_plataforma" ADD COLUMN "totp_ultimo_passo" bigint;--> statement-breakpoint
ALTER TABLE "empresas" ADD COLUMN "usuario_banco" varchar(63);--> statement-breakpoint
ALTER TABLE "empresas" ADD COLUMN "senha_banco_cifrada" "bytea";--> statement-breakpoint
ALTER TABLE "sessoes_admin" ADD COLUMN "motivo_encerramento" varchar(20);--> statement-breakpoint
ALTER TABLE "sessoes_admin" ADD COLUMN "familia_id" uuid;--> statement-breakpoint
UPDATE "sessoes_admin" SET "familia_id" = "id", "motivo_encerramento" = CASE WHEN "encerrada_em" IS NULL THEN NULL ELSE 'logout' END;--> statement-breakpoint
ALTER TABLE "sessoes_admin" ALTER COLUMN "familia_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "backups_empresas" ADD CONSTRAINT "fk_backups_empresas_empresa_id" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_backups_empresas_empresa_id_iniciado" ON "backups_empresas" USING btree ("empresa_id","iniciado_em" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_sessoes_admin_familia_id" ON "sessoes_admin" USING btree ("familia_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_versoes_app_pdv_versao" ON "versoes_app_pdv" USING btree ("versao_app","canal","plataforma");--> statement-breakpoint
ALTER TABLE "sessoes_admin" ADD CONSTRAINT "ck_sessoes_admin_motivo_encerramento" CHECK (motivo_encerramento is null or motivo_encerramento in ('logout','expirada','encerrada_admin','reuso_detectado','rotacionada'));--> statement-breakpoint
create trigger tg_backups_empresas_versao before insert or update on backups_empresas
  for each row execute function fn_versao_local();
