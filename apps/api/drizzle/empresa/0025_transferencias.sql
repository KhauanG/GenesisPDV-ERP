-- Transferência de estoque em duas etapas (Fase 2, F2-B22; ERP 13.7; MD 3.7.6; README da API › decisão 170): o
-- documento que leva mercadoria de um estoque a outro (CD ⇄ loja), rascunho → em trânsito → recebida (ou recebida com
-- divergência → recebida), ou cancelada. Este bloco cria só o schema e os contratos; rascunho, enviar e cancelar
-- (TRANSF_SAIDA/TRANSF_RETORNO, F2-B23), receber e tratar a divergência (TRANSF_ENTRADA, F2-B24) usam estas tabelas
-- sem migração nova (o razão já aceita `documento_tipo = 'transferencia'`, o seed já tem os três tipos de movimento e
-- o acerto já tem a origem `perda_transferencia`).
--
-- Sem parte fiscal (restrição do dono): `documento_fiscal_id` fica nulo e sem FK até a NF-e de transferência existir;
-- a NF-e emitida por fora é só anotada (`nfe_externa_chave`/`nfe_externa_numero`, D6). Nenhuma das duas tabelas desce
-- ao PDV (MD 3.7.6, "—"; os saldos descem pelo fluxo `estoque`): o `Esquema.g.cs` não muda e os triggers de versão
-- são `fn_versao_local`. A sequência do `codigo` vem antes das tabelas (o default usa nextval).
create sequence if not exists seq_codigo_transferencias_estoque as integer start 1 cache 1 no cycle;
--> statement-breakpoint
CREATE TABLE "itens_transferencia" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"transferencia_id" uuid NOT NULL,
	"sequencia" integer NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"lote_id" uuid,
	"quantidade_enviada" numeric(15, 3) NOT NULL,
	"quantidade_recebida" numeric(15, 3),
	"diferenca" numeric(15, 3) GENERATED ALWAYS AS (quantidade_enviada - coalesce(quantidade_recebida, quantidade_enviada)) STORED NOT NULL,
	"tratamento_divergencia" varchar(14),
	"divergencia_tratada_em" timestamp with time zone,
	"custo_unitario" numeric(15, 4),
	CONSTRAINT "pk_itens_transferencia" PRIMARY KEY("id"),
	CONSTRAINT "ck_itens_transferencia_quantidades" CHECK (quantidade_enviada > 0 and (quantidade_recebida is null or quantidade_recebida between 0 and quantidade_enviada)),
	CONSTRAINT "ck_itens_transferencia_custo" CHECK (custo_unitario is null or custo_unitario >= 0),
	CONSTRAINT "ck_itens_transferencia_tratamento" CHECK (tratamento_divergencia is null or tratamento_divergencia in ('retorno_origem','perda')),
	CONSTRAINT "ck_itens_transferencia_divergencia" CHECK ((tratamento_divergencia is null) = (divergencia_tratada_em is null) and (tratamento_divergencia is null or (quantidade_recebida is not null and quantidade_recebida < quantidade_enviada)))
);
--> statement-breakpoint
CREATE TABLE "transferencias_estoque" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_transferencias_estoque') NOT NULL,
	"estoque_origem_id" uuid NOT NULL,
	"estoque_destino_id" uuid NOT NULL,
	"tipo_estoque_id" uuid NOT NULL,
	"data" date DEFAULT current_date NOT NULL,
	"motivo" varchar(120) NOT NULL,
	"observacoes" text,
	"status" varchar(22) DEFAULT 'rascunho' NOT NULL,
	"enviada_em" timestamp with time zone,
	"enviada_por_id" uuid,
	"recebida_em" timestamp with time zone,
	"recebida_por_id" uuid,
	"cancelada_em" timestamp with time zone,
	"cancelada_por_id" uuid,
	"motivo_cancelamento" varchar(255),
	"documento_fiscal_id" uuid,
	"nfe_externa_chave" varchar(44),
	"nfe_externa_numero" varchar(20),
	"qtd_itens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_transferencias_estoque" PRIMARY KEY("id"),
	CONSTRAINT "ck_transferencias_estoque_estoques" CHECK (estoque_origem_id <> estoque_destino_id),
	CONSTRAINT "ck_transferencias_estoque_status" CHECK (status in ('rascunho','em_transito','recebida','recebida_divergencia','cancelada')),
	CONSTRAINT "ck_transferencias_estoque_etapas" CHECK ((status <> 'rascunho' or (enviada_em is null and recebida_em is null and cancelada_em is null)) and (status not in ('em_transito','recebida','recebida_divergencia') or enviada_em is not null) and (status in ('recebida','recebida_divergencia')) = (recebida_em is not null) and (status = 'cancelada') = (cancelada_em is not null) and (status <> 'cancelada' or motivo_cancelamento is not null)),
	CONSTRAINT "ck_transferencias_estoque_nfe_externa" CHECK (nfe_externa_chave is null or nfe_externa_chave ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$')
);
--> statement-breakpoint
ALTER TABLE "itens_transferencia" ADD CONSTRAINT "fk_itens_transferencia_transferencia_id" FOREIGN KEY ("transferencia_id") REFERENCES "public"."transferencias_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_transferencia" ADD CONSTRAINT "fk_itens_transferencia_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_transferencia" ADD CONSTRAINT "fk_itens_transferencia_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_transferencia" ADD CONSTRAINT "fk_itens_transferencia_lote_id" FOREIGN KEY ("lote_id") REFERENCES "public"."produtos_lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencias_estoque" ADD CONSTRAINT "fk_transferencias_estoque_estoque_origem_id" FOREIGN KEY ("estoque_origem_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencias_estoque" ADD CONSTRAINT "fk_transferencias_estoque_estoque_destino_id" FOREIGN KEY ("estoque_destino_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencias_estoque" ADD CONSTRAINT "fk_transferencias_estoque_tipo_estoque_id" FOREIGN KEY ("tipo_estoque_id") REFERENCES "public"."tipos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencias_estoque" ADD CONSTRAINT "fk_transferencias_estoque_enviada_por_id" FOREIGN KEY ("enviada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencias_estoque" ADD CONSTRAINT "fk_transferencias_estoque_recebida_por_id" FOREIGN KEY ("recebida_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencias_estoque" ADD CONSTRAINT "fk_transferencias_estoque_cancelada_por_id" FOREIGN KEY ("cancelada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_itens_transferencia_sequencia" ON "itens_transferencia" USING btree ("transferencia_id","sequencia");--> statement-breakpoint
CREATE INDEX "ix_itens_transferencia_produto_id" ON "itens_transferencia" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_itens_transferencia_variacao_id" ON "itens_transferencia" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_itens_transferencia_lote_id" ON "itens_transferencia" USING btree ("lote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_transferencias_estoque_codigo" ON "transferencias_estoque" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "ix_transferencias_estoque_origem_status" ON "transferencias_estoque" USING btree ("estoque_origem_id","status");--> statement-breakpoint
CREATE INDEX "ix_transferencias_estoque_destino_status" ON "transferencias_estoque" USING btree ("estoque_destino_id","status");--> statement-breakpoint
CREATE INDEX "ix_transferencias_estoque_tipo_estoque_id" ON "transferencias_estoque" USING btree ("tipo_estoque_id");--> statement-breakpoint
CREATE INDEX "ix_transferencias_estoque_enviada_por_id" ON "transferencias_estoque" USING btree ("enviada_por_id");--> statement-breakpoint
CREATE INDEX "ix_transferencias_estoque_recebida_por_id" ON "transferencias_estoque" USING btree ("recebida_por_id");--> statement-breakpoint
CREATE INDEX "ix_transferencias_estoque_cancelada_por_id" ON "transferencias_estoque" USING btree ("cancelada_por_id");
--> statement-breakpoint
create trigger tg_transferencias_estoque_versao before insert or update on transferencias_estoque
  for each row execute function fn_versao_local();
--> statement-breakpoint
-- `diferenca` é gerada: chega nula no NEW do trigger BEFORE e não conta na comparação do UPDATE sem mudança (0012).
create trigger tg_itens_transferencia_versao before insert or update on itens_transferencia
  for each row execute function fn_versao_local('diferenca');
--> statement-breakpoint
alter table transferencias_estoque add constraint fk_transferencias_estoque_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_transferencias_estoque_criado_por_id on transferencias_estoque (criado_por_id);
--> statement-breakpoint
alter table transferencias_estoque add constraint fk_transferencias_estoque_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_transferencias_estoque_atualizado_por_id on transferencias_estoque (atualizado_por_id);
--> statement-breakpoint
-- O mesmo produto (e lote) uma vez só por transferência, como no acerto (0004); sem lote é uma linha, e cada lote outra.
create unique index uq_itens_transferencia_produto on itens_transferencia (transferencia_id, produto_id, variacao_id, lote_id) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
-- Imutável fora do rascunho (o padrão do acerto e do recebimento): o envio muda a situação a partir do rascunho (o OLD
-- ainda está aberto); depois dele, só as colunas do recebimento, do cancelamento e da NF-e emitida por fora mudam, e
-- o tg_transferencias_estoque_etapa diz em que etapa cada uma.
create trigger tg_transferencias_estoque_imutavel before update on transferencias_estoque
  for each row execute function fn_protege_imutavel('status', 'rascunho',
    'status,recebida_em,recebida_por_id,cancelada_em,cancelada_por_id,motivo_cancelamento,nfe_externa_chave,nfe_externa_numero,versao,atualizado_em,atualizado_por_id');
--> statement-breakpoint
create or replace function fn_transferencias_estoque_etapa() returns trigger language plpgsql as $$
-- ERP 13.7 (diagrama de situações): as transições permitidas e o que cada etapa grava. Recebida e cancelada são o fim
-- (sem isto, um update "descancelaria" a transferência sem lançar de novo o TRANSF_SAIDA: o documento diria que a
-- mercadoria está em trânsito e o razão, que voltou à origem). O modo de uma etapa
-- (`estoque.transferencia_recebimento_automatico`, F2-B24) passa pelo trânsito na mesma transação.
declare
  de   text := old.status;
  para text := new.status;
begin
  if para is distinct from de and not (
       (de = 'rascunho' and para in ('em_transito', 'cancelada'))
    or (de = 'em_transito' and para in ('recebida', 'recebida_divergencia', 'cancelada'))
    or (de = 'recebida_divergencia' and para = 'recebida')) then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  -- O envio só na 1ª etapa; o recebimento só na 2ª; o cancelamento só ao cancelar; a NF-e de fora em qualquer
  -- situação, menos na cancelada.
  if ((new.enviada_em, new.enviada_por_id) is distinct from (old.enviada_em, old.enviada_por_id)
        and not (de = 'rascunho' and para = 'em_transito'))
     or ((new.recebida_em, new.recebida_por_id) is distinct from (old.recebida_em, old.recebida_por_id)
        and not (de = 'em_transito' and para in ('recebida', 'recebida_divergencia')))
     or ((new.cancelada_em, new.cancelada_por_id, new.motivo_cancelamento)
           is distinct from (old.cancelada_em, old.cancelada_por_id, old.motivo_cancelamento)
        and not (de in ('rascunho', 'em_transito') and para = 'cancelada'))
     or ((new.nfe_externa_chave, new.nfe_externa_numero) is distinct from (old.nfe_externa_chave, old.nfe_externa_numero)
        and de = 'cancelada') then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_transferencias_estoque_etapa before update on transferencias_estoque
  for each row execute function fn_transferencias_estoque_etapa();
--> statement-breakpoint
create or replace function fn_itens_transferencia_etapa() returns trigger language plpgsql as $$
-- MD 3.7.6: o item entra (e sai, com `excluido_em`) só no rascunho, onde tudo muda (o envio, F2-B23, grava o custo
-- antes de mudar a situação, na mesma transação). Depois, cada etapa só grava a sua coluna: a quantidade recebida no
-- trânsito (a conferência do F2-B24, antes de a situação mudar) e o tratamento da diferença, uma vez, na recebida com
-- divergência. A recebida e a cancelada não mudam mais. `diferenca` (gerada) chega nula no NEW e fica fora da conta.
declare
  st     text;
  livres text[] := '{}';
  a      jsonb;
  b      jsonb;
  c      text;
begin
  if tg_op = 'UPDATE' and new.transferencia_id is distinct from old.transferencia_id then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  select t.status into st from transferencias_estoque t where t.id = new.transferencia_id;
  -- Sem cabeçalho, quem recusa é a FK.
  if st is null or st = 'rascunho' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  if st = 'em_transito' then
    livres := array['quantidade_recebida'];
  elsif st = 'recebida_divergencia' and old.tratamento_divergencia is null then
    livres := array['tratamento_divergencia', 'divergencia_tratada_em'];
  end if;
  a := to_jsonb(old) - 'diferenca' - 'versao' - 'atualizado_em';
  b := to_jsonb(new) - 'diferenca' - 'versao' - 'atualizado_em';
  foreach c in array livres loop a := a - c; b := b - c; end loop;
  if a <> b then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_itens_transferencia_etapa before insert or update on itens_transferencia
  for each row execute function fn_itens_transferencia_etapa();
