-- NF-e de fornecedor por XML (Fase 2, F2-B18; ERP 13.4; MD 3.8.2; README da API › decisão 163): a nota importada do
-- `nfeProc` autorizado, com os itens e as duplicatas. Este bloco cria só o schema, o parser seguro e as validações; o
-- upload (F2-B19), a vinculação (F2-B20) e movimentar/estornar (RECEB_NFE/ESTORNO_RECEB_NFE, F2-B21) usam estas
-- tabelas sem migração nova (o razão já aceita `documento_tipo = 'nota_entrada'` e o seed já tem os dois tipos).
--
-- Sem SEFAZ (restrição do dono): `origem` só 'upload', `dfe_documento_id` nulo e sem FK, `cfop_entrada` nulo e
-- reservado (sem conversão de CFOP). Nenhuma das três tabelas desce ao PDV (MD 3.8.2, "—"): o `Esquema.g.cs` não muda
-- e os triggers de versão são `fn_versao_local`. A sequência do `codigo` vem antes das tabelas (o default usa nextval).
create sequence if not exists seq_codigo_notas_entrada as integer start 1 cache 1 no cycle;
--> statement-breakpoint
CREATE TABLE "itens_nota_entrada" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"nota_entrada_id" uuid NOT NULL,
	"numero_item" smallint NOT NULL,
	"codigo_fornecedor" varchar(60) NOT NULL,
	"descricao" varchar(120) NOT NULL,
	"ean" varchar(14),
	"ean_tributavel" varchar(14),
	"ncm" varchar(8),
	"cest" varchar(7),
	"cfop" varchar(4) NOT NULL,
	"cfop_entrada" varchar(4),
	"unidade_comercial" varchar(6) NOT NULL,
	"quantidade_comercial" numeric(15, 4) NOT NULL,
	"valor_unitario_comercial" numeric(21, 10) NOT NULL,
	"unidade_tributavel" varchar(6),
	"quantidade_tributavel" numeric(15, 4),
	"valor_unitario_tributavel" numeric(21, 10),
	"valor_produto" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_frete" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_seguro" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_desconto" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_outros" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_ipi" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_icms_st" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_fcp_st" numeric(15, 2) DEFAULT '0' NOT NULL,
	"icms_situacao" varchar(3),
	"icms_origem" char(1),
	"icms_base" numeric(15, 2),
	"icms_aliquota" numeric(7, 4),
	"icms_valor" numeric(15, 2),
	"pis_valor" numeric(15, 2),
	"cofins_valor" numeric(15, 2),
	"informacoes_adicionais" varchar(500),
	"rastro" jsonb,
	"produto_id" uuid,
	"variacao_id" uuid,
	"codigo_barras_id" uuid,
	"fator" numeric(15, 3) DEFAULT '1' NOT NULL,
	"quantidade_estoque" numeric(15, 3),
	"custo_unitario" numeric(15, 4),
	"lote" varchar(30),
	"validade" date,
	"fabricacao" date,
	"lote_id" uuid,
	"markup_pct" numeric(9, 4),
	"preco_venda" numeric(15, 4),
	"atualizar_preco" varchar(6) DEFAULT 'nao' NOT NULL,
	"ignorado" boolean DEFAULT false NOT NULL,
	"motivo_ignorado" varchar(255),
	CONSTRAINT "pk_itens_nota_entrada" PRIMARY KEY("id"),
	CONSTRAINT "ck_itens_nota_entrada_numero_item" CHECK (numero_item between 1 and 990),
	CONSTRAINT "ck_itens_nota_entrada_fator" CHECK (fator > 0),
	CONSTRAINT "ck_itens_nota_entrada_ignorado" CHECK (not ignorado or motivo_ignorado is not null),
	CONSTRAINT "ck_itens_nota_entrada_valores" CHECK (quantidade_comercial >= 0 and valor_unitario_comercial >= 0 and (quantidade_tributavel is null or quantidade_tributavel >= 0) and (valor_unitario_tributavel is null or valor_unitario_tributavel >= 0) and valor_produto >= 0 and valor_frete >= 0 and valor_seguro >= 0 and valor_desconto >= 0 and valor_outros >= 0 and valor_ipi >= 0 and valor_icms_st >= 0 and valor_fcp_st >= 0),
	CONSTRAINT "ck_itens_nota_entrada_vinculo" CHECK ((quantidade_estoque is null or quantidade_estoque > 0) and (custo_unitario is null or custo_unitario >= 0) and (preco_venda is null or preco_venda >= 0)),
	CONSTRAINT "ck_itens_nota_entrada_atualizar_preco" CHECK (atualizar_preco in ('geral','loja','nao')),
	CONSTRAINT "ck_itens_nota_entrada_validade" CHECK (fabricacao is null or validade is null or fabricacao <= validade)
);
--> statement-breakpoint
CREATE TABLE "notas_entrada" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_notas_entrada') NOT NULL,
	"loja_id" uuid NOT NULL,
	"estoque_id" uuid NOT NULL,
	"tipo_estoque_id" uuid NOT NULL,
	"fornecedor_id" uuid NOT NULL,
	"origem" varchar(10) DEFAULT 'upload' NOT NULL,
	"dfe_documento_id" uuid,
	"chave" varchar(44) NOT NULL,
	"modelo" smallint DEFAULT 55 NOT NULL,
	"serie" integer NOT NULL,
	"numero" integer NOT NULL,
	"data_emissao" timestamp with time zone NOT NULL,
	"data_recebimento" timestamp with time zone DEFAULT now() NOT NULL,
	"data_movimentacao" timestamp with time zone,
	"natureza_operacao" varchar(60),
	"emitente_cnpj" varchar(14) NOT NULL,
	"emitente_nome" varchar(60) NOT NULL,
	"emitente_fantasia" varchar(60),
	"emitente_ie" varchar(14),
	"emitente_uf" char(2) NOT NULL,
	"destinatario_cnpj" varchar(14) NOT NULL,
	"valor_produtos" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_frete" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_seguro" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_desconto" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_outras" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_ipi" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_ipi_devolvido" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_ii" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_icms" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_icms_desonerado" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_icms_st" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_fcp_st" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"transportadora_cnpj" varchar(14),
	"transportadora_nome" varchar(60),
	"modalidade_frete" char(1),
	"volumes" jsonb,
	"informacoes_complementares" text,
	"protocolo_numero" varchar(17) NOT NULL,
	"protocolo_data" timestamp with time zone NOT NULL,
	"protocolo_status" smallint NOT NULL,
	"assinatura" varchar(13) NOT NULL,
	"assinatura_detalhe" varchar(255),
	"status" varchar(14) DEFAULT 'pendente' NOT NULL,
	"motivo_ignorada" varchar(255),
	"movimentada_por_id" uuid,
	"estornada_em" timestamp with time zone,
	"estornada_por_id" uuid,
	"motivo_estorno" varchar(255),
	"gerar_financeiro" boolean DEFAULT false NOT NULL,
	"financeiro_plano_contas_id" uuid,
	"conta_financeira_id" uuid,
	"xml_arquivo_id" uuid NOT NULL,
	CONSTRAINT "pk_notas_entrada" PRIMARY KEY("id"),
	CONSTRAINT "ck_notas_entrada_chave" CHECK (chave ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'),
	CONSTRAINT "ck_notas_entrada_emitente_cnpj" CHECK (emitente_cnpj ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
	CONSTRAINT "ck_notas_entrada_destinatario_cnpj" CHECK (destinatario_cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
	CONSTRAINT "ck_notas_entrada_modelo" CHECK (modelo = 55),
	CONSTRAINT "ck_notas_entrada_origem" CHECK (origem in ('upload')),
	CONSTRAINT "ck_notas_entrada_status" CHECK (status in ('pendente','pronta','movimentada','estornada','ignorada')),
	CONSTRAINT "ck_notas_entrada_assinatura" CHECK (assinatura in ('valida','invalida','ausente','nao_conferida')),
	CONSTRAINT "ck_notas_entrada_protocolo_status" CHECK (protocolo_status in (100, 150)),
	CONSTRAINT "ck_notas_entrada_ignorada" CHECK (status <> 'ignorada' or motivo_ignorada is not null),
	CONSTRAINT "ck_notas_entrada_movimentacao" CHECK ((status in ('movimentada','estornada')) = (data_movimentacao is not null) and (status = 'estornada') = (estornada_em is not null)),
	CONSTRAINT "ck_notas_entrada_valores" CHECK (valor_produtos >= 0 and valor_frete >= 0 and valor_seguro >= 0 and valor_desconto >= 0 and valor_outras >= 0 and valor_ipi >= 0 and valor_ipi_devolvido >= 0 and valor_ii >= 0 and valor_icms >= 0 and valor_icms_desonerado >= 0 and valor_icms_st >= 0 and valor_fcp_st >= 0 and valor_total >= 0),
	CONSTRAINT "ck_notas_entrada_financeiro" CHECK (not gerar_financeiro or financeiro_plano_contas_id is not null)
);
--> statement-breakpoint
CREATE TABLE "notas_entrada_duplicatas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"nota_entrada_id" uuid NOT NULL,
	"sequencia" smallint NOT NULL,
	"numero" varchar(60),
	"vencimento" date,
	"valor" numeric(15, 2) NOT NULL,
	CONSTRAINT "pk_notas_entrada_duplicatas" PRIMARY KEY("id"),
	CONSTRAINT "ck_notas_entrada_duplicatas_valor" CHECK (valor >= 0)
);
--> statement-breakpoint
ALTER TABLE "itens_nota_entrada" ADD CONSTRAINT "fk_itens_nota_entrada_nota_entrada_id" FOREIGN KEY ("nota_entrada_id") REFERENCES "public"."notas_entrada"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_nota_entrada" ADD CONSTRAINT "fk_itens_nota_entrada_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_nota_entrada" ADD CONSTRAINT "fk_itens_nota_entrada_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_nota_entrada" ADD CONSTRAINT "fk_itens_nota_entrada_codigo_barras_id" FOREIGN KEY ("codigo_barras_id") REFERENCES "public"."produtos_codigos_barras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_nota_entrada" ADD CONSTRAINT "fk_itens_nota_entrada_lote_id" FOREIGN KEY ("lote_id") REFERENCES "public"."produtos_lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada" ADD CONSTRAINT "fk_notas_entrada_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada" ADD CONSTRAINT "fk_notas_entrada_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada" ADD CONSTRAINT "fk_notas_entrada_tipo_estoque_id" FOREIGN KEY ("tipo_estoque_id") REFERENCES "public"."tipos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada" ADD CONSTRAINT "fk_notas_entrada_fornecedor_id" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada" ADD CONSTRAINT "fk_notas_entrada_movimentada_por_id" FOREIGN KEY ("movimentada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada" ADD CONSTRAINT "fk_notas_entrada_estornada_por_id" FOREIGN KEY ("estornada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada" ADD CONSTRAINT "fk_notas_entrada_financeiro_plano_contas_id" FOREIGN KEY ("financeiro_plano_contas_id") REFERENCES "public"."planos_contas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada" ADD CONSTRAINT "fk_notas_entrada_xml_arquivo_id" FOREIGN KEY ("xml_arquivo_id") REFERENCES "public"."arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_entrada_duplicatas" ADD CONSTRAINT "fk_notas_entrada_duplicatas_nota_entrada_id" FOREIGN KEY ("nota_entrada_id") REFERENCES "public"."notas_entrada"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_itens_nota_entrada_numero_item" ON "itens_nota_entrada" USING btree ("nota_entrada_id","numero_item");--> statement-breakpoint
CREATE INDEX "ix_itens_nota_entrada_produto_id" ON "itens_nota_entrada" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_itens_nota_entrada_variacao_id" ON "itens_nota_entrada" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_itens_nota_entrada_codigo_barras_id" ON "itens_nota_entrada" USING btree ("codigo_barras_id");--> statement-breakpoint
CREATE INDEX "ix_itens_nota_entrada_lote_id" ON "itens_nota_entrada" USING btree ("lote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notas_entrada_codigo" ON "notas_entrada" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notas_entrada_chave" ON "notas_entrada" USING btree ("chave") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_loja_id_data_emissao" ON "notas_entrada" USING btree ("loja_id","data_emissao");--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_fornecedor_id_data_emissao" ON "notas_entrada" USING btree ("fornecedor_id","data_emissao");--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_status_data_recebimento" ON "notas_entrada" USING btree ("status","data_recebimento");--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_estoque_id" ON "notas_entrada" USING btree ("estoque_id");--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_tipo_estoque_id" ON "notas_entrada" USING btree ("tipo_estoque_id");--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_movimentada_por_id" ON "notas_entrada" USING btree ("movimentada_por_id");--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_estornada_por_id" ON "notas_entrada" USING btree ("estornada_por_id");--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_financeiro_plano_contas_id" ON "notas_entrada" USING btree ("financeiro_plano_contas_id");--> statement-breakpoint
CREATE INDEX "ix_notas_entrada_xml_arquivo_id" ON "notas_entrada" USING btree ("xml_arquivo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notas_entrada_duplicatas_sequencia" ON "notas_entrada_duplicatas" USING btree ("nota_entrada_id","sequencia");
--> statement-breakpoint
create trigger tg_notas_entrada_versao before insert or update on notas_entrada
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_itens_nota_entrada_versao before insert or update on itens_nota_entrada
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_notas_entrada_duplicatas_versao before insert or update on notas_entrada_duplicatas
  for each row execute function fn_versao_local();
--> statement-breakpoint
alter table notas_entrada add constraint fk_notas_entrada_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_notas_entrada_criado_por_id on notas_entrada (criado_por_id);
--> statement-breakpoint
alter table notas_entrada add constraint fk_notas_entrada_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_notas_entrada_atualizado_por_id on notas_entrada (atualizado_por_id);
--> statement-breakpoint
-- O que veio do XML nunca muda, em situação nenhuma: só as colunas do destino, da situação, da movimentação, do
-- estorno e do financeiro (Fase 4) são livres (`fn_protege_imutavel` sem coluna de estado confere sempre).
create trigger tg_notas_entrada_xml_imutavel before update on notas_entrada
  for each row execute function fn_protege_imutavel('', '',
    'loja_id,estoque_id,tipo_estoque_id,fornecedor_id,status,motivo_ignorada,data_movimentacao,movimentada_por_id,estornada_em,estornada_por_id,motivo_estorno,gerar_financeiro,financeiro_plano_contas_id,conta_financeira_id,excluido_em,versao,atualizado_em,atualizado_por_id');
--> statement-breakpoint
-- Imutável depois de movimentada (o padrão do recebimento, 0023): a movimentação muda a situação a partir de
-- `pronta` (o OLD ainda está aberto) e o estorno só mexe nas colunas do estorno. `pendente`, `pronta` e `ignorada`
-- continuam abertas (vínculos, destino, "Ignorar nota" e "Reabrir", F2-B19/F2-B20).
create trigger tg_notas_entrada_imutavel before update on notas_entrada
  for each row execute function fn_protege_imutavel('status', 'pendente,pronta,ignorada',
    'status,estornada_em,estornada_por_id,motivo_estorno,versao,atualizado_em,atualizado_por_id');
--> statement-breakpoint
-- Estornada é o fim: nada muda depois do estorno, nem a situação nem as colunas do estorno (o trigger acima as libera
-- para o estorno sair de `movimentada`, e o ck_notas_entrada_movimentacao aceita `movimentada` sem `estornada_em`).
-- Sem isto, um update "desestornaria" a nota sem lançar de novo o RECEB_NFE: o documento diria que a mercadoria
-- entrou e o razão, que saiu. Entrar de novo é importar outra vez (F2-B19).
create trigger tg_notas_entrada_estornada_final before update on notas_entrada
  for each row execute function fn_protege_imutavel('status', 'pendente,pronta,ignorada,movimentada',
    'versao,atualizado_em,atualizado_por_id');
--> statement-breakpoint
-- A mesma regra no recebimento (0023, F2-B14/F2-B15), que tinha a mesma brecha (`estornado` → `movimentado` com
-- `estornado_em` nulo passava no tg_recebimentos_imutavel e no ck_recebimentos_movimentacao).
create trigger tg_recebimentos_estornado_final before update on recebimentos
  for each row execute function fn_protege_imutavel('status', 'rascunho,movimentado',
    'versao,atualizado_em,atualizado_por_id');
--> statement-breakpoint
create or replace function fn_filhos_nota_entrada_aberta() returns trigger language plpgsql as $$
-- MD 3.8.2: itens e duplicatas só mudam com a nota `pendente` ou `pronta` (a movimentação, F2-B21, grava o custo e o
-- `lote_id` nos itens antes de mudar a situação da nota, na mesma transação; a nota ignorada é reaberta antes).
begin
  if exists (select 1 from notas_entrada n
              where n.id in (new.nota_entrada_id, case when tg_op = 'UPDATE' then old.nota_entrada_id end)
                and n.status not in ('pendente', 'pronta')) then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_itens_nota_entrada_aberta before insert or update on itens_nota_entrada
  for each row execute function fn_filhos_nota_entrada_aberta();
--> statement-breakpoint
create trigger tg_notas_entrada_duplicatas_aberta before insert or update on notas_entrada_duplicatas
  for each row execute function fn_filhos_nota_entrada_aberta();
--> statement-breakpoint
-- Do item, só a vinculação muda (F2-B20/F2-B21); o que veio do `det` do XML fica como veio.
create trigger tg_itens_nota_entrada_xml_imutavel before update on itens_nota_entrada
  for each row execute function fn_protege_imutavel('', '',
    'produto_id,variacao_id,codigo_barras_id,fator,quantidade_estoque,custo_unitario,cfop_entrada,lote,validade,fabricacao,lote_id,markup_pct,preco_venda,atualizar_preco,ignorado,motivo_ignorado,excluido_em,versao,atualizado_em');
--> statement-breakpoint
-- As duplicatas são só a cópia do `cobr/dup` (a Fase 4 edita as parcelas na conta a pagar, não aqui).
create trigger tg_notas_entrada_duplicatas_imutavel before update on notas_entrada_duplicatas
  for each row execute function fn_protege_imutavel('', '', 'versao,atualizado_em');
--> statement-breakpoint
-- A FK que `produtos_lojas.st_nota_entrada_id` esperava (MD 3.6.9): a coluna continua nula até o ST retido por loja
-- ser preenchido (manual no F2-B52; o automático pela nota é fiscal, fora da Fase 2). Sem efeito no PDV: a coluna é
-- omitida na descida.
alter table produtos_lojas add constraint fk_produtos_lojas_st_nota_entrada_id foreign key (st_nota_entrada_id) references notas_entrada (id);
