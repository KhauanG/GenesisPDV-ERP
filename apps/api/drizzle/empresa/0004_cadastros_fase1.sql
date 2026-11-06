-- Fase 1A (cadastros base, MD 3.2, 3.4, 3.5, 3.6, 3.7): sequências de `codigo` antes das tabelas (os defaults
-- usam nextval).
create sequence if not exists seq_codigo_pessoas as integer start 1 cache 1 no cycle;
--> statement-breakpoint
create sequence if not exists seq_codigo_produtos as integer start 1 cache 1 no cycle;
--> statement-breakpoint
create sequence if not exists seq_codigo_marcas as integer start 1 cache 1 no cycle;
--> statement-breakpoint
create sequence if not exists seq_codigo_grupos_preco_quantidade as integer start 1 cache 1 no cycle;
--> statement-breakpoint
create sequence if not exists seq_codigo_acertos_estoque as integer start 1 cache 1 no cycle;
--> statement-breakpoint
CREATE TABLE "acertos_estoque" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_acertos_estoque') NOT NULL,
	"estoque_id" uuid NOT NULL,
	"tipo_estoque_id" uuid NOT NULL,
	"tipo_ajuste" varchar(8) DEFAULT 'entrada' NOT NULL,
	"data_contagem" timestamp with time zone DEFAULT now() NOT NULL,
	"motivo" varchar(120) NOT NULL,
	"responsavel_id" uuid NOT NULL,
	"observacoes" text,
	"origem" varchar(20) DEFAULT 'manual' NOT NULL,
	"origem_id" uuid,
	"status" varchar(10) DEFAULT 'rascunho' NOT NULL,
	"efetivado_em" timestamp with time zone,
	"efetivado_por_id" uuid,
	"estornado_em" timestamp with time zone,
	"estornado_por_id" uuid,
	"motivo_estorno" varchar(255),
	"qtd_itens" integer DEFAULT 0 NOT NULL,
	"total_venda" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_custo" numeric(15, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "pk_acertos_estoque" PRIMARY KEY("id"),
	CONSTRAINT "ck_acertos_estoque_tipo_ajuste" CHECK (tipo_ajuste in ('entrada','saida','definir')),
	CONSTRAINT "ck_acertos_estoque_status" CHECK (status in ('rascunho','efetivado','estornado')),
	CONSTRAINT "ck_acertos_estoque_origem" CHECK (origem in ('manual','cadastro_produto','cadastro_massa','importacao','relatorio_estoque','perda_transferencia','api')),
	CONSTRAINT "ck_acertos_estoque_efetivacao" CHECK ((status = 'rascunho') = (efetivado_em is null) and (status = 'estornado') = (estornado_em is not null))
);
--> statement-breakpoint
CREATE TABLE "itens_acerto_estoque" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"acerto_id" uuid NOT NULL,
	"sequencia" integer NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"lote_id" uuid,
	"quantidade_informada" numeric(15, 3) NOT NULL,
	"saldo_anterior" numeric(15, 3),
	"diferenca" numeric(15, 3),
	"custo_unitario" numeric(15, 4),
	"preco_venda" numeric(15, 4) DEFAULT '0' NOT NULL,
	"total_venda" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_custo" numeric(15, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "pk_itens_acerto_estoque" PRIMARY KEY("id"),
	CONSTRAINT "ck_itens_acerto_estoque_quantidade" CHECK (quantidade_informada >= 0),
	CONSTRAINT "ck_itens_acerto_estoque_valores" CHECK (preco_venda >= 0 and (custo_unitario is null or custo_unitario >= 0))
);
--> statement-breakpoint
CREATE TABLE "movimentos_estoque" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"estoque_id" uuid NOT NULL,
	"loja_id" uuid,
	"tipo_estoque_id" uuid NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"lote_id" uuid,
	"tipo_movimento" varchar(30) NOT NULL,
	"quantidade" numeric(15, 3) NOT NULL,
	"unidade_documento" varchar(6),
	"fator" numeric(15, 3) DEFAULT '1' NOT NULL,
	"saldo_anterior" numeric(15, 3) NOT NULL,
	"saldo_posterior" numeric(15, 3) NOT NULL,
	"custo_unitario" numeric(15, 4) NOT NULL,
	"custo_total" numeric(15, 2) NOT NULL,
	"custo_medio_posterior" numeric(15, 4) NOT NULL,
	"preco_venda" numeric(15, 4),
	"data_movimento" timestamp with time zone NOT NULL,
	"usuario_id" uuid,
	"pessoa_id" uuid,
	"documento_tipo" varchar(20) NOT NULL,
	"documento_id" uuid,
	"documento_item_id" uuid,
	"terminal_id" uuid,
	"evento_id" uuid,
	"estorno_de_id" uuid,
	"compensa_movimento_id" uuid,
	"observacao" varchar(255),
	CONSTRAINT "pk_movimentos_estoque" PRIMARY KEY("id"),
	CONSTRAINT "ck_movimentos_estoque_quantidade" CHECK (quantidade <> 0),
	CONSTRAINT "ck_movimentos_estoque_fator" CHECK (fator > 0),
	CONSTRAINT "ck_movimentos_estoque_custo" CHECK (custo_unitario >= 0),
	CONSTRAINT "ck_movimentos_estoque_documento_tipo" CHECK (documento_tipo in ('venda','troca','acerto','recebimento','nota_entrada','transferencia','vasilhame')),
	CONSTRAINT "ck_movimentos_estoque_saldo" CHECK (saldo_posterior = saldo_anterior + quantidade)
);
--> statement-breakpoint
CREATE TABLE "saldos_estoque" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"estoque_id" uuid NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"tipo_estoque_id" uuid NOT NULL,
	"quantidade" numeric(15, 3) DEFAULT '0' NOT NULL,
	"custo_medio" numeric(15, 4) DEFAULT '0' NOT NULL,
	"ultima_entrada_em" timestamp with time zone,
	"ultima_saida_em" timestamp with time zone,
	"ultima_compra_em" timestamp with time zone,
	"ultimo_custo_compra" numeric(15, 4),
	"ultimo_movimento_id" uuid,
	CONSTRAINT "pk_saldos_estoque" PRIMARY KEY("id"),
	CONSTRAINT "ck_saldos_estoque_custo" CHECK (custo_medio >= 0)
);
--> statement-breakpoint
CREATE TABLE "saldos_lote" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"estoque_id" uuid NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"lote_id" uuid NOT NULL,
	"tipo_estoque_id" uuid NOT NULL,
	"quantidade" numeric(15, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "pk_saldos_lote" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "saldos_vasilhame_pessoas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"produto_vasilhame_id" uuid NOT NULL,
	"quantidade" numeric(15, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "pk_saldos_vasilhame_pessoas" PRIMARY KEY("id"),
	CONSTRAINT "ck_saldos_vasilhame_pessoas_quantidade" CHECK (quantidade >= 0)
);
--> statement-breakpoint
CREATE TABLE "certificados_digitais" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"loja_id" uuid NOT NULL,
	"tipo" varchar(2) DEFAULT 'A1' NOT NULL,
	"arquivo_cifrado" "bytea",
	"senha_cifrada" "bytea",
	"titular" varchar(150) NOT NULL,
	"cnpj" varchar(14) NOT NULL,
	"numero_serie" varchar(64) NOT NULL,
	"emissor" varchar(150),
	"valido_de" timestamp with time zone NOT NULL,
	"valido_ate" timestamp with time zone NOT NULL,
	"impressao_digital" varchar(64) NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_certificados_digitais" PRIMARY KEY("id"),
	CONSTRAINT "ck_certificados_digitais_tipo" CHECK (tipo in ('A1','A3') and (tipo = 'A3' or arquivo_cifrado is not null)),
	CONSTRAINT "ck_certificados_digitais_cnpj" CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
	CONSTRAINT "ck_certificados_digitais_validade" CHECK (valido_ate > valido_de)
);
--> statement-breakpoint
CREATE TABLE "impressoras_destino" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"nome" varchar(30) NOT NULL,
	"descricao" varchar(100),
	"loja_id" uuid,
	"ordem" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_impressoras_destino" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "taxas_entrega" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"loja_id" uuid NOT NULL,
	"bairro" varchar(80) NOT NULL,
	"municipio_ibge" integer NOT NULL,
	"valor" numeric(15, 2) NOT NULL,
	"tempo_estimado_min" smallint,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_taxas_entrega" PRIMARY KEY("id"),
	CONSTRAINT "ck_taxas_entrega_valor" CHECK (valor >= 0)
);
--> statement-breakpoint
CREATE TABLE "planos_contas_lojas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"plano_contas_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	CONSTRAINT "pk_planos_contas_lojas" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "parcelas_credito_pessoas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"parcela_financeira_id" uuid NOT NULL,
	"documento" varchar(40) NOT NULL,
	"numero" smallint NOT NULL,
	"vencimento" date NOT NULL,
	"valor" numeric(15, 2) NOT NULL,
	"saldo" numeric(15, 2) NOT NULL,
	"dias_atraso" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_parcelas_credito_pessoas" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "pessoas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_pessoas') NOT NULL,
	"tipo" char(2) DEFAULT 'PF' NOT NULL,
	"nome" varchar(150) NOT NULL,
	"apelido" varchar(150),
	"ativa" boolean DEFAULT true NOT NULL,
	"cpf_cnpj" varchar(14),
	"rg_ie" varchar(20),
	"indicador_ie" varchar(16) DEFAULT 'nao_contribuinte' NOT NULL,
	"inscricao_municipal" varchar(20),
	"nascimento" date,
	"sexo" char(1) DEFAULT 'N' NOT NULL,
	"senha_hash" varchar(255),
	"limite_compras" numeric(15, 2),
	"desconto_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"bloqueada_credito" boolean DEFAULT false NOT NULL,
	"observacoes" text,
	"observacao_pdv" varchar(200),
	"origem" varchar(12) DEFAULT 'erp' NOT NULL,
	"origem_terminal_id" uuid,
	"anonimizada_em" timestamp with time zone,
	"busca" text DEFAULT '' NOT NULL,
	CONSTRAINT "pk_pessoas" PRIMARY KEY("id"),
	CONSTRAINT "ck_pessoas_tipo" CHECK (tipo in ('PF','PJ')),
	CONSTRAINT "ck_pessoas_sexo" CHECK (sexo in ('M','F','O','N')),
	CONSTRAINT "ck_pessoas_indicador_ie" CHECK (indicador_ie in ('contribuinte','isento','nao_contribuinte')),
	CONSTRAINT "ck_pessoas_origem" CHECK (origem in ('erp','pdv','importacao','nfe','integracao')),
	CONSTRAINT "ck_pessoas_cpf_cnpj" CHECK (cpf_cnpj is null or (tipo = 'PF' and cpf_cnpj ~ '^[0-9]{11}$') or (tipo = 'PJ' and cpf_cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$')),
	CONSTRAINT "ck_pessoas_desconto" CHECK (desconto_pct between 0 and 100),
	CONSTRAINT "ck_pessoas_limite" CHECK (limite_compras is null or limite_compras >= 0)
);
--> statement-breakpoint
CREATE TABLE "pessoas_aliases" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"alias_id" uuid NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"terminal_id" uuid,
	"motivo" varchar(20) NOT NULL,
	CONSTRAINT "pk_pessoas_aliases" PRIMARY KEY("id"),
	CONSTRAINT "ck_pessoas_aliases_motivo" CHECK (motivo in ('mesclada_cpf','mesclada_manual'))
);
--> statement-breakpoint
CREATE TABLE "pessoas_categorias" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"pessoa_id" uuid NOT NULL,
	"categoria" varchar(15) NOT NULL,
	CONSTRAINT "pk_pessoas_categorias" PRIMARY KEY("id"),
	CONSTRAINT "ck_pessoas_categorias_categoria" CHECK (categoria in ('cliente','fornecedor','funcionario','transportadora','representante','consumidor'))
);
--> statement-breakpoint
CREATE TABLE "pessoas_emails" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"pessoa_id" uuid NOT NULL,
	"email" varchar(254) NOT NULL,
	"principal" boolean DEFAULT false NOT NULL,
	"recebe_documentos" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_pessoas_emails" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "pessoas_enderecos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"pessoa_id" uuid NOT NULL,
	"tipo" varchar(10) DEFAULT 'principal' NOT NULL,
	"cep" varchar(8),
	"logradouro" varchar(150),
	"numero" varchar(20),
	"complemento" varchar(80),
	"bairro" varchar(80),
	"uf" char(2),
	"municipio_ibge" integer,
	"exterior" boolean DEFAULT false NOT NULL,
	"pais_codigo" varchar(4),
	"cidade_exterior" varchar(80),
	"referencia" varchar(150),
	CONSTRAINT "pk_pessoas_enderecos" PRIMARY KEY("id"),
	CONSTRAINT "ck_pessoas_enderecos_tipo" CHECK (tipo in ('principal','entrega','cobranca','outro')),
	CONSTRAINT "ck_pessoas_enderecos_completo" CHECK (exterior or (cep is not null and logradouro is not null and numero is not null and bairro is not null and uf is not null and municipio_ibge is not null)),
	CONSTRAINT "ck_pessoas_enderecos_cep" CHECK (cep is null or cep ~ '^[0-9]{8}$')
);
--> statement-breakpoint
CREATE TABLE "pessoas_relevancia_loja" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"loja_id" uuid,
	"motivo" varchar(12) NOT NULL,
	"ultima_ocorrencia_em" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_pessoas_relevancia_loja" PRIMARY KEY("id"),
	CONSTRAINT "ck_pessoas_relevancia_loja_motivo" CHECK (motivo in ('crediario','funcionario','compra','delivery','manual'))
);
--> statement-breakpoint
CREATE TABLE "pessoas_telefones" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"pessoa_id" uuid NOT NULL,
	"tipo" varchar(12) DEFAULT 'celular' NOT NULL,
	"ddd" varchar(2) NOT NULL,
	"numero" varchar(9) NOT NULL,
	"contato" varchar(80),
	"principal" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pk_pessoas_telefones" PRIMARY KEY("id"),
	CONSTRAINT "ck_pessoas_telefones_tipo" CHECK (tipo in ('celular','comercial','residencial','whatsapp','outro')),
	CONSTRAINT "ck_pessoas_telefones_numero" CHECK (ddd ~ '^[1-9][0-9]$' and numero ~ '^[0-9]{8,9}$')
);
--> statement-breakpoint
CREATE TABLE "saldos_credito_pessoas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"pessoa_id" uuid NOT NULL,
	"limite" numeric(15, 2) DEFAULT '0' NOT NULL,
	"saldo_aberto" numeric(15, 2) DEFAULT '0' NOT NULL,
	"saldo_vencido" numeric(15, 2) DEFAULT '0' NOT NULL,
	"maior_atraso_dias" integer DEFAULT 0 NOT NULL,
	"parcelas_abertas" integer DEFAULT 0 NOT NULL,
	"calculado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_saldos_credito_pessoas" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "atributos_variacao" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"nome" varchar(30) NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_atributos_variacao" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "atributos_variacao_valores" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"atributo_id" uuid NOT NULL,
	"valor" varchar(40) NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_atributos_variacao_valores" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "categorias" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"nome" varchar(60) NOT NULL,
	"categoria_pai_id" uuid,
	"caminho" text NOT NULL,
	"caminho_nomes" text NOT NULL,
	"nivel" smallint DEFAULT 1 NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"ativa" boolean DEFAULT true NOT NULL,
	"exibe_pdv" boolean DEFAULT true NOT NULL,
	"exibe_menu_digital" boolean DEFAULT false NOT NULL,
	"exibe_totem" boolean DEFAULT false NOT NULL,
	"exibe_site" boolean DEFAULT false NOT NULL,
	"imagem_arquivo_id" uuid,
	"cor" varchar(7),
	CONSTRAINT "pk_categorias" PRIMARY KEY("id"),
	CONSTRAINT "ck_categorias_nivel" CHECK (nivel between 1 and 5),
	CONSTRAINT "ck_categorias_pai" CHECK (categoria_pai_id is distinct from id),
	CONSTRAINT "ck_categorias_cor" CHECK (cor is null or cor ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "grupos_preco_quantidade" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_grupos_preco_quantidade') NOT NULL,
	"nome" varchar(60) NOT NULL,
	"modo_preco" varchar(8) DEFAULT 'produto' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_grupos_preco_quantidade" PRIMARY KEY("id"),
	CONSTRAINT "ck_grupos_preco_quantidade_modo_preco" CHECK (modo_preco in ('produto','grupo'))
);
--> statement-breakpoint
CREATE TABLE "grupos_preco_quantidade_faixas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"grupo_id" uuid NOT NULL,
	"loja_id" uuid,
	"quantidade_inicial" numeric(15, 3) NOT NULL,
	"quantidade_final" numeric(15, 3),
	"preco" numeric(15, 4) NOT NULL,
	CONSTRAINT "pk_grupos_preco_quantidade_faixas" PRIMARY KEY("id"),
	CONSTRAINT "ck_grupos_preco_quantidade_faixas_valores" CHECK (quantidade_inicial > 0 and (quantidade_final is null or quantidade_final > quantidade_inicial) and preco >= 0)
);
--> statement-breakpoint
CREATE TABLE "marcas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_marcas') NOT NULL,
	"descricao" varchar(60) NOT NULL,
	"sem_marca" boolean DEFAULT false NOT NULL,
	"exibe_site" boolean DEFAULT false NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"logotipo_arquivo_id" uuid,
	CONSTRAINT "pk_marcas" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "produtos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_produtos') NOT NULL,
	"nome" varchar(120) NOT NULL,
	"tipo" varchar(18) DEFAULT 'simples' NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"codigo_interno" varchar(30),
	"unidade_id" uuid NOT NULL,
	"unidade_tributavel_id" uuid,
	"fator_tributavel" numeric(15, 3),
	"permite_fracao" boolean DEFAULT false NOT NULL,
	"ncm" varchar(8),
	"cest" varchar(7),
	"preco_custo" numeric(15, 4) DEFAULT '0' NOT NULL,
	"custo_medio" numeric(15, 4) DEFAULT '0' NOT NULL,
	"markup_pct" numeric(9, 4) DEFAULT '0' NOT NULL,
	"preco_venda" numeric(15, 4) DEFAULT '0' NOT NULL,
	"preco_atacado" numeric(15, 4),
	"qtd_minima_atacado" numeric(15, 3),
	"preco_promocional" numeric(15, 4),
	"promocao_inicio" timestamp with time zone,
	"promocao_fim" timestamp with time zone,
	"preco_menu_digital" numeric(15, 4),
	"preco_ifood" numeric(15, 4),
	"preco_parcelado" numeric(15, 4),
	"grupo_preco_quantidade_id" uuid,
	"usa_ficha_tecnica" boolean DEFAULT false NOT NULL,
	"largura_cm" numeric(10, 2),
	"altura_cm" numeric(10, 2),
	"profundidade_cm" numeric(10, 2),
	"peso_g" numeric(12, 3),
	"peso_abatimento_g" numeric(12, 3),
	"peso_pacote_kg" numeric(12, 3),
	"localizacao" varchar(40),
	"impressora_destino_id" uuid,
	"qtd_minima_venda" numeric(15, 3),
	"material" varchar(60),
	"comissao_pct" numeric(7, 4),
	"marca_id" uuid,
	"categoria_principal_id" uuid,
	"solicita_preco_pdv" boolean DEFAULT false NOT NULL,
	"solicita_lote_pdv" boolean DEFAULT false NOT NULL,
	"generico" boolean DEFAULT false NOT NULL,
	"usa_menu_digital" boolean DEFAULT false NOT NULL,
	"insumo" boolean DEFAULT false NOT NULL,
	"reposicao_rodizio" boolean DEFAULT false NOT NULL,
	"usa_totem" boolean DEFAULT false NOT NULL,
	"mais_vendido" boolean DEFAULT false NOT NULL,
	"descricao_curta" varchar(250),
	"descricao_longa" text,
	"foto_principal_arquivo_id" uuid,
	"controla_estoque" boolean DEFAULT true NOT NULL,
	"idade_minima" smallint,
	"vasilhame_produto_id" uuid,
	"vasilhame_quantidade" smallint,
	"balanca_tipo" varchar(8) DEFAULT 'nao_usa' NOT NULL,
	"balanca_plu" integer,
	"balanca_validade_dias" smallint,
	"cfop_venda_estado" varchar(4),
	"cfop_venda_fora_estado" varchar(4),
	"icms_situacao" varchar(3),
	"icms_origem" char(1),
	"icms_modalidade_bc" char(1),
	"icms_modalidade_bcst" char(1),
	"icms_aliquota" numeric(7, 4),
	"icms_reducao_bc_pct" numeric(7, 4),
	"icms_mva_pct" numeric(7, 4),
	"icms_aliquota_st" numeric(7, 4),
	"fcp_aliquota" numeric(7, 4),
	"fcp_st_aliquota" numeric(7, 4),
	"beneficio_fiscal_codigo" varchar(10),
	"pis_situacao" varchar(2),
	"cofins_situacao" varchar(2),
	"ipi_situacao" varchar(2),
	"pis_aliquota" numeric(7, 4),
	"cofins_aliquota" numeric(7, 4),
	"ipi_aliquota" numeric(7, 4),
	"ipi_enquadramento" varchar(3),
	"ibs_cbs_cst" varchar(3),
	"ibs_cbs_classificacao" varchar(6),
	"is_cst" varchar(3),
	"is_classificacao" varchar(6),
	"is_aliquota_pct" numeric(7, 4),
	"is_aliquota_especifica" numeric(15, 4),
	"is_unidade" varchar(6),
	"servico_codigo_lc116" varchar(5),
	"busca" text DEFAULT '' NOT NULL,
	CONSTRAINT "pk_produtos" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_tipo" CHECK (tipo in ('simples','com_variacoes','kit','com_complementos','materia_prima','servico','produzido','vasilhame')),
	CONSTRAINT "ck_produtos_balanca_tipo" CHECK (balanca_tipo in ('nao_usa','peso','unidade')),
	CONSTRAINT "ck_produtos_balanca_plu" CHECK (balanca_plu is null or balanca_plu between 1 and 999999),
	CONSTRAINT "ck_produtos_precos" CHECK (preco_custo >= 0 and custo_medio >= 0 and preco_venda >= 0 and coalesce(preco_atacado, 0) >= 0 and coalesce(preco_promocional, 0) >= 0 and coalesce(preco_menu_digital, 0) >= 0 and coalesce(preco_ifood, 0) >= 0 and coalesce(preco_parcelado, 0) >= 0),
	CONSTRAINT "ck_produtos_ncm" CHECK (ncm is null or ncm ~ '^[0-9]{8}$'),
	CONSTRAINT "ck_produtos_cest" CHECK (cest is null or cest ~ '^[0-9]{7}$'),
	CONSTRAINT "ck_produtos_icms_origem" CHECK (icms_origem is null or icms_origem ~ '^[0-8]$'),
	CONSTRAINT "ck_produtos_icms_modalidades" CHECK ((icms_modalidade_bc is null or icms_modalidade_bc ~ '^[0-3]$') and (icms_modalidade_bcst is null or icms_modalidade_bcst ~ '^[0-6]$')),
	CONSTRAINT "ck_produtos_promocao" CHECK (promocao_fim is null or promocao_inicio is null or promocao_fim > promocao_inicio),
	CONSTRAINT "ck_produtos_servico_sem_estoque" CHECK (tipo <> 'servico' or not controla_estoque),
	CONSTRAINT "ck_produtos_ficha_tecnica" CHECK (tipo <> 'produzido' or usa_ficha_tecnica),
	CONSTRAINT "ck_produtos_grupo_preco_tipo" CHECK (grupo_preco_quantidade_id is null or tipo in ('simples','com_variacoes','produzido')),
	CONSTRAINT "ck_produtos_vasilhame" CHECK ((vasilhame_produto_id is null) = (vasilhame_quantidade is null) and (vasilhame_quantidade is null or vasilhame_quantidade > 0) and (vasilhame_produto_id is null or tipo <> 'vasilhame')),
	CONSTRAINT "ck_produtos_is" CHECK (is_aliquota_especifica is null or is_unidade is not null),
	CONSTRAINT "ck_produtos_fcp" CHECK ((fcp_aliquota is null or fcp_aliquota between 0 and 100) and (fcp_st_aliquota is null or fcp_st_aliquota between 0 and 100)),
	CONSTRAINT "ck_produtos_idade_minima" CHECK (idade_minima is null or idade_minima between 1 and 99),
	CONSTRAINT "ck_produtos_quantidades" CHECK ((qtd_minima_atacado is null or qtd_minima_atacado > 0) and (qtd_minima_venda is null or qtd_minima_venda > 0) and (fator_tributavel is null or fator_tributavel > 0))
);
--> statement-breakpoint
CREATE TABLE "produtos_categorias" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"categoria_id" uuid NOT NULL,
	"principal" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pk_produtos_categorias" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "produtos_codigos_barras" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"codigo" varchar(30) NOT NULL,
	"tipo" varchar(10) DEFAULT 'gtin' NOT NULL,
	"principal" boolean DEFAULT false NOT NULL,
	"descricao" varchar(40),
	"unidade_id" uuid,
	"fator" numeric(15, 3) DEFAULT '1' NOT NULL,
	"preco" numeric(15, 4),
	"usa_venda" boolean DEFAULT true NOT NULL,
	"usa_compra" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_produtos_codigos_barras" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_codigos_barras_tipo" CHECK (tipo in ('gtin','interno')),
	CONSTRAINT "ck_produtos_codigos_barras_fator" CHECK (fator > 0),
	CONSTRAINT "ck_produtos_codigos_barras_gtin" CHECK (tipo <> 'gtin' or codigo ~ '^([0-9]{8}|[0-9]{12,14})$'),
	CONSTRAINT "ck_produtos_codigos_barras_preco" CHECK (preco is null or preco >= 0)
);
--> statement-breakpoint
CREATE TABLE "produtos_componentes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"tipo" varchar(14) NOT NULL,
	"componente_id" uuid NOT NULL,
	"componente_variacao_id" uuid,
	"quantidade" numeric(15, 3) NOT NULL,
	"perda_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"rotulo_posicao" varchar(40),
	"permite_substituicao" boolean DEFAULT false NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_produtos_componentes" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_componentes_tipo" CHECK (tipo in ('kit','ficha_tecnica')),
	CONSTRAINT "ck_produtos_componentes_quantidade" CHECK (quantidade > 0),
	CONSTRAINT "ck_produtos_componentes_perda" CHECK (perda_pct between 0 and 100 and (tipo = 'ficha_tecnica' or perda_pct = 0)),
	CONSTRAINT "ck_produtos_componentes_kit" CHECK (tipo = 'kit' or (not permite_substituicao and rotulo_posicao is null)),
	CONSTRAINT "ck_produtos_componentes_ciclo_direto" CHECK (componente_id <> produto_id)
);
--> statement-breakpoint
CREATE TABLE "produtos_componentes_alternativas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"componente_id" uuid NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"acrescimo" numeric(15, 4) DEFAULT '0' NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_produtos_componentes_alternativas" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_componentes_alternativas_acrescimo" CHECK (acrescimo >= 0)
);
--> statement-breakpoint
CREATE TABLE "produtos_fornecedores" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"fornecedor_id" uuid NOT NULL,
	"codigo_fornecedor" varchar(60),
	"ean_fornecedor" varchar(14),
	"unidade_compra" varchar(6),
	"fator" numeric(15, 3) DEFAULT '1' NOT NULL,
	"ultimo_custo" numeric(15, 4),
	"ultima_compra_em" date,
	"principal" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pk_produtos_fornecedores" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_fornecedores_fator" CHECK (fator > 0)
);
--> statement-breakpoint
CREATE TABLE "produtos_historico_precos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"loja_id" uuid,
	"tipo_preco" varchar(15) NOT NULL,
	"valor_anterior" numeric(15, 4),
	"valor_novo" numeric(15, 4),
	"origem" varchar(15) NOT NULL,
	"origem_id" uuid,
	"usuario_id" uuid,
	CONSTRAINT "pk_produtos_historico_precos" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_historico_precos_tipo_preco" CHECK (tipo_preco in ('venda','custo','atacado','promocional','menu_digital','ifood','parcelado','loja','quantidade')),
	CONSTRAINT "ck_produtos_historico_precos_origem" CHECK (origem in ('cadastro','recebimento','nota_entrada','importacao','cadastro_massa','api'))
);
--> statement-breakpoint
CREATE TABLE "produtos_imagens" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"arquivo_id" uuid NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_produtos_imagens" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "produtos_lojas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	"estoque_minimo" numeric(15, 3),
	"estoque_maximo" numeric(15, 3),
	"preco_venda" numeric(15, 4),
	"acrescimo_gelada" numeric(15, 4),
	"ativo_na_loja" boolean DEFAULT true NOT NULL,
	"st_bc_retido_unitario" numeric(15, 4),
	"st_aliquota_pct" numeric(7, 4),
	"st_icms_substituto_unitario" numeric(15, 4),
	"st_icms_retido_unitario" numeric(15, 4),
	"fcp_st_bc_retido_unitario" numeric(15, 4),
	"fcp_st_aliquota_pct" numeric(7, 4),
	"fcp_st_retido_unitario" numeric(15, 4),
	"st_atualizado_em" timestamp with time zone,
	"st_nota_entrada_id" uuid,
	CONSTRAINT "pk_produtos_lojas" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_lojas_estoque" CHECK (estoque_maximo is null or estoque_minimo is null or estoque_maximo >= estoque_minimo),
	CONSTRAINT "ck_produtos_lojas_preco" CHECK (preco_venda is null or preco_venda >= 0),
	CONSTRAINT "ck_produtos_lojas_st" CHECK (coalesce(st_bc_retido_unitario, 0) >= 0 and coalesce(st_aliquota_pct, 0) between 0 and 100 and coalesce(st_icms_substituto_unitario, 0) >= 0 and coalesce(st_icms_retido_unitario, 0) >= 0 and coalesce(fcp_st_bc_retido_unitario, 0) >= 0 and coalesce(fcp_st_aliquota_pct, 0) between 0 and 100 and coalesce(fcp_st_retido_unitario, 0) >= 0),
	CONSTRAINT "ck_produtos_lojas_acrescimo_gelada" CHECK (acrescimo_gelada is null or acrescimo_gelada >= 0)
);
--> statement-breakpoint
CREATE TABLE "produtos_lotes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"estoque_id" uuid,
	"lote" varchar(30) NOT NULL,
	"validade" date,
	"fabricacao" date,
	"fornecedor_id" uuid,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_produtos_lotes" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_lotes_datas" CHECK (validade is null or fabricacao is null or validade >= fabricacao)
);
--> statement-breakpoint
CREATE TABLE "produtos_precos_quantidade" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"loja_id" uuid,
	"quantidade_inicial" numeric(15, 3) NOT NULL,
	"quantidade_final" numeric(15, 3),
	"preco" numeric(15, 4) NOT NULL,
	CONSTRAINT "pk_produtos_precos_quantidade" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_precos_quantidade_valores" CHECK (quantidade_inicial > 0 and (quantidade_final is null or quantidade_final > quantidade_inicial) and preco >= 0)
);
--> statement-breakpoint
CREATE TABLE "produtos_relacionados" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"relacionado_id" uuid NOT NULL,
	"tipo" varchar(10) DEFAULT 'sugestao' NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_produtos_relacionados" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_relacionados_tipo" CHECK (tipo in ('sugestao','substituto','acessorio')),
	CONSTRAINT "ck_produtos_relacionados_proprio" CHECK (produto_id <> relacionado_id)
);
--> statement-breakpoint
CREATE TABLE "produtos_tributacao_uf" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"uf" char(2) NOT NULL,
	"cfop_venda_estado" varchar(4),
	"icms_situacao" varchar(3),
	"icms_modalidade_bc" char(1),
	"icms_aliquota" numeric(7, 4),
	"icms_reducao_bc_pct" numeric(7, 4),
	"icms_modalidade_bcst" char(1),
	"icms_mva_pct" numeric(7, 4),
	"icms_aliquota_st" numeric(7, 4),
	"fcp_aliquota" numeric(7, 4),
	"fcp_st_aliquota" numeric(7, 4),
	"beneficio_fiscal_codigo" varchar(10),
	CONSTRAINT "pk_produtos_tributacao_uf" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_tributacao_uf_icms" CHECK ((icms_modalidade_bc is null or icms_modalidade_bc ~ '^[0-3]$') and (icms_modalidade_bcst is null or icms_modalidade_bcst ~ '^[0-6]$')),
	CONSTRAINT "ck_produtos_tributacao_uf_fcp" CHECK ((fcp_aliquota is null or fcp_aliquota between 0 and 100) and (fcp_st_aliquota is null or fcp_st_aliquota between 0 and 100))
);
--> statement-breakpoint
CREATE TABLE "produtos_variacoes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"produto_id" uuid NOT NULL,
	"nome" varchar(120) NOT NULL,
	"codigo_interno" varchar(30),
	"preco_venda" numeric(15, 4),
	"preco_custo" numeric(15, 4),
	"ativo" boolean DEFAULT true NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_produtos_variacoes" PRIMARY KEY("id"),
	CONSTRAINT "ck_produtos_variacoes_precos" CHECK (coalesce(preco_venda, 0) >= 0 and coalesce(preco_custo, 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "produtos_variacoes_valores" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"variacao_id" uuid NOT NULL,
	"atributo_valor_id" uuid NOT NULL,
	CONSTRAINT "pk_produtos_variacoes_valores" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "restricoes_horario_venda" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"loja_id" uuid,
	"categoria_id" uuid,
	"idade_minima_produto" smallint,
	"dias_semana" smallint[],
	"hora_inicio" time NOT NULL,
	"hora_fim" time NOT NULL,
	"data_especifica" date,
	"descricao" varchar(100) NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_restricoes_horario_venda" PRIMARY KEY("id"),
	CONSTRAINT "ck_restricoes_horario_venda_alvo" CHECK (categoria_id is not null or idade_minima_produto is not null),
	CONSTRAINT "ck_restricoes_horario_venda_dias_semana" CHECK (dias_semana is null or (cardinality(dias_semana) between 1 and 7 and dias_semana <@ '{0,1,2,3,4,5,6}'::smallint[])),
	CONSTRAINT "ck_restricoes_horario_venda_horario" CHECK (hora_inicio <> hora_fim)
);
--> statement-breakpoint
CREATE TABLE "cests" (
	"codigo" varchar(7) NOT NULL,
	"descricao" text NOT NULL,
	"segmento" varchar(80),
	"ncms" text[] NOT NULL,
	"vigencia_inicio" date,
	"vigencia_fim" date,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_cests" PRIMARY KEY("codigo"),
	CONSTRAINT "ck_cests_codigo" CHECK (codigo ~ '^[0-9]{7}$')
);
--> statement-breakpoint
CREATE TABLE "ncms" (
	"codigo" varchar(8) NOT NULL,
	"descricao" text NOT NULL,
	"vigencia_inicio" date,
	"vigencia_fim" date,
	"unidade_tributavel" varchar(6),
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_ncms" PRIMARY KEY("codigo"),
	CONSTRAINT "ck_ncms_codigo" CHECK (codigo ~ '^[0-9]{8}$')
);
--> statement-breakpoint
CREATE TABLE "paises" (
	"codigo_bacen" varchar(4) NOT NULL,
	"nome" varchar(80) NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_paises" PRIMARY KEY("codigo_bacen"),
	CONSTRAINT "ck_paises_codigo_bacen" CHECK (codigo_bacen ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "parametros_fiscais_uf" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"uf" char(2) NOT NULL,
	"vigencia_inicio" date NOT NULL,
	"vigencia_fim" date,
	"tipos_emissao_permitidos" text[] DEFAULT '{nfce}' NOT NULL,
	"regimes_dispensados_nfce" text[] DEFAULT '{}' NOT NULL,
	"autorizador" varchar(10) NOT NULL,
	"versao_leiaute" varchar(5) DEFAULT '4.00' NOT NULL,
	"webservices" jsonb,
	"url_qrcode_producao" text NOT NULL,
	"url_qrcode_homologacao" text NOT NULL,
	"url_consulta_producao" text NOT NULL,
	"url_consulta_homologacao" text NOT NULL,
	"qrcode_versoes_aceitas" smallint[] DEFAULT '{2}' NOT NULL,
	"qrcode_versao_padrao" smallint DEFAULT 2 NOT NULL,
	"csc_max_ativos_por_ambiente" smallint,
	"csc_por_cnpj_base" boolean DEFAULT false NOT NULL,
	"prazo_cancelamento_min" smallint NOT NULL,
	"prazo_cancelamento_substituicao_h" smallint NOT NULL,
	"aceita_cancelamento_extemporaneo" boolean,
	"prazo_transmissao_contingencia_h" smallint NOT NULL,
	"modalidades_contingencia_nfce" smallint[] DEFAULT '{9}' NOT NULL,
	"contingencia_vias_danfe" smallint DEFAULT 1 NOT NULL,
	"inutilizacao_prazo_dia" smallint NOT NULL,
	"identificacao_obrigatoria_valor" numeric(15, 2) NOT NULL,
	"identificacao_obrigatoria_nao_presencial" boolean DEFAULT true NOT NULL,
	"nfce_valor_maximo" numeric(15, 2),
	"danfe_modos_permitidos" text[] DEFAULT '{completo}' NOT NULL,
	"danfe_resumido_exige_concordancia" boolean DEFAULT true NOT NULL,
	"programa_cidadania" varchar(40),
	"programa_cidadania_substitui_danfe" boolean,
	"intervalo_minimo_status_s" integer,
	"atraso_max_emissao_min" smallint DEFAULT 5 NOT NULL,
	"fcp_nome" varchar(40),
	"exige_st_retido_nfce" boolean DEFAULT false NOT NULL,
	"exige_vinculacao_pagamento" boolean DEFAULT false NOT NULL,
	"exige_cbenef" boolean DEFAULT false NOT NULL,
	"exige_cest_bem_listado" boolean DEFAULT true NOT NULL,
	"exige_resp_tec" boolean DEFAULT true NOT NULL,
	"exige_csrt_nfce" boolean DEFAULT false NOT NULL,
	"fundamento" text,
	"pendencias" text,
	"conferido_em" date,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_parametros_fiscais_uf" PRIMARY KEY("id"),
	CONSTRAINT "ck_parametros_fiscais_uf_prazos" CHECK (prazo_cancelamento_min > 0 and prazo_cancelamento_substituicao_h > 0 and prazo_transmissao_contingencia_h > 0),
	CONSTRAINT "ck_parametros_fiscais_uf_inutilizacao" CHECK (inutilizacao_prazo_dia between 1 and 28),
	CONSTRAINT "ck_parametros_fiscais_uf_qrcode" CHECK (qrcode_versao_padrao = any(qrcode_versoes_aceitas)),
	CONSTRAINT "ck_parametros_fiscais_uf_danfe" CHECK (danfe_modos_permitidos <@ '{completo,resumido,eletronico_se_solicitado}'::text[] and 'completo' = any(danfe_modos_permitidos)),
	CONSTRAINT "ck_parametros_fiscais_uf_tipos_emissao" CHECK (tipos_emissao_permitidos <@ '{nfce,sat,mfe}'::text[]),
	CONSTRAINT "ck_parametros_fiscais_uf_vigencia" CHECK (vigencia_fim is null or vigencia_fim >= vigencia_inicio),
	CONSTRAINT "ck_parametros_fiscais_uf_valores" CHECK (identificacao_obrigatoria_valor >= 0 and (nfce_valor_maximo is null or nfce_valor_maximo > 0))
);
--> statement-breakpoint
CREATE TABLE "lojas_banners" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"loja_id" uuid NOT NULL,
	"arquivo_id" uuid NOT NULL,
	"titulo" varchar(60),
	"ordem" integer DEFAULT 0 NOT NULL,
	"exibir_em" varchar(15) DEFAULT 'pdv_espera' NOT NULL,
	"inicio" timestamp with time zone,
	"fim" timestamp with time zone,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_lojas_banners" PRIMARY KEY("id"),
	CONSTRAINT "ck_lojas_banners_exibir_em" CHECK (exibir_em in ('pdv_espera','menu_digital','totem')),
	CONSTRAINT "ck_lojas_banners_vigencia" CHECK (fim is null or inicio is null or fim > inicio)
);
--> statement-breakpoint
CREATE TABLE "numeracoes_faixas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"numeracao_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"inicio" bigint NOT NULL,
	"fim" bigint NOT NULL,
	"status" varchar(12) DEFAULT 'ativa' NOT NULL,
	"ultimo_usado" bigint,
	CONSTRAINT "pk_numeracoes_faixas" PRIMARY KEY("id"),
	CONSTRAINT "ck_numeracoes_faixas_fim" CHECK (fim >= inicio),
	CONSTRAINT "ck_numeracoes_faixas_status" CHECK (status in ('ativa','esgotada','devolvida')),
	CONSTRAINT "ck_numeracoes_faixas_ultimo_usado" CHECK (ultimo_usado is null or ultimo_usado between inicio and fim)
);
--> statement-breakpoint
ALTER TABLE "lojas" ADD COLUMN "nfce_qrcode_versao" smallint;--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD CONSTRAINT "fk_acertos_estoque_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD CONSTRAINT "fk_acertos_estoque_tipo_estoque_id" FOREIGN KEY ("tipo_estoque_id") REFERENCES "public"."tipos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD CONSTRAINT "fk_acertos_estoque_responsavel_id" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD CONSTRAINT "fk_acertos_estoque_efetivado_por_id" FOREIGN KEY ("efetivado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD CONSTRAINT "fk_acertos_estoque_estornado_por_id" FOREIGN KEY ("estornado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_acerto_estoque" ADD CONSTRAINT "fk_itens_acerto_estoque_acerto_id" FOREIGN KEY ("acerto_id") REFERENCES "public"."acertos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_acerto_estoque" ADD CONSTRAINT "fk_itens_acerto_estoque_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_acerto_estoque" ADD CONSTRAINT "fk_itens_acerto_estoque_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_acerto_estoque" ADD CONSTRAINT "fk_itens_acerto_estoque_lote_id" FOREIGN KEY ("lote_id") REFERENCES "public"."produtos_lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_tipo_estoque_id" FOREIGN KEY ("tipo_estoque_id") REFERENCES "public"."tipos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_lote_id" FOREIGN KEY ("lote_id") REFERENCES "public"."produtos_lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_tipo_movimento" FOREIGN KEY ("tipo_movimento") REFERENCES "public"."tipos_movimento_estoque"("codigo") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_usuario_id" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_estorno_de_id" FOREIGN KEY ("estorno_de_id") REFERENCES "public"."movimentos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_estoque" ADD CONSTRAINT "fk_movimentos_estoque_compensa_movimento_id" FOREIGN KEY ("compensa_movimento_id") REFERENCES "public"."movimentos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_estoque" ADD CONSTRAINT "fk_saldos_estoque_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_estoque" ADD CONSTRAINT "fk_saldos_estoque_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_estoque" ADD CONSTRAINT "fk_saldos_estoque_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_estoque" ADD CONSTRAINT "fk_saldos_estoque_tipo_estoque_id" FOREIGN KEY ("tipo_estoque_id") REFERENCES "public"."tipos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_estoque" ADD CONSTRAINT "fk_saldos_estoque_ultimo_movimento_id" FOREIGN KEY ("ultimo_movimento_id") REFERENCES "public"."movimentos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_lote" ADD CONSTRAINT "fk_saldos_lote_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_lote" ADD CONSTRAINT "fk_saldos_lote_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_lote" ADD CONSTRAINT "fk_saldos_lote_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_lote" ADD CONSTRAINT "fk_saldos_lote_lote_id" FOREIGN KEY ("lote_id") REFERENCES "public"."produtos_lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_lote" ADD CONSTRAINT "fk_saldos_lote_tipo_estoque_id" FOREIGN KEY ("tipo_estoque_id") REFERENCES "public"."tipos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_vasilhame_pessoas" ADD CONSTRAINT "fk_saldos_vasilhame_pessoas_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_vasilhame_pessoas" ADD CONSTRAINT "fk_saldos_vasilhame_pessoas_produto_vasilhame_id" FOREIGN KEY ("produto_vasilhame_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificados_digitais" ADD CONSTRAINT "fk_certificados_digitais_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impressoras_destino" ADD CONSTRAINT "fk_impressoras_destino_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxas_entrega" ADD CONSTRAINT "fk_taxas_entrega_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taxas_entrega" ADD CONSTRAINT "fk_taxas_entrega_municipio_ibge" FOREIGN KEY ("municipio_ibge") REFERENCES "public"."municipios"("codigo_ibge") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planos_contas_lojas" ADD CONSTRAINT "fk_planos_contas_lojas_plano_contas_id" FOREIGN KEY ("plano_contas_id") REFERENCES "public"."planos_contas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planos_contas_lojas" ADD CONSTRAINT "fk_planos_contas_lojas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcelas_credito_pessoas" ADD CONSTRAINT "fk_parcelas_credito_pessoas_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas" ADD CONSTRAINT "fk_pessoas_origem_terminal_id" FOREIGN KEY ("origem_terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_aliases" ADD CONSTRAINT "fk_pessoas_aliases_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_aliases" ADD CONSTRAINT "fk_pessoas_aliases_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_categorias" ADD CONSTRAINT "fk_pessoas_categorias_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_emails" ADD CONSTRAINT "fk_pessoas_emails_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_enderecos" ADD CONSTRAINT "fk_pessoas_enderecos_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_enderecos" ADD CONSTRAINT "fk_pessoas_enderecos_uf" FOREIGN KEY ("uf") REFERENCES "public"."ufs"("sigla") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_enderecos" ADD CONSTRAINT "fk_pessoas_enderecos_municipio_ibge" FOREIGN KEY ("municipio_ibge") REFERENCES "public"."municipios"("codigo_ibge") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_enderecos" ADD CONSTRAINT "fk_pessoas_enderecos_pais_codigo" FOREIGN KEY ("pais_codigo") REFERENCES "public"."paises"("codigo_bacen") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_relevancia_loja" ADD CONSTRAINT "fk_pessoas_relevancia_loja_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_relevancia_loja" ADD CONSTRAINT "fk_pessoas_relevancia_loja_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pessoas_telefones" ADD CONSTRAINT "fk_pessoas_telefones_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saldos_credito_pessoas" ADD CONSTRAINT "fk_saldos_credito_pessoas_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atributos_variacao_valores" ADD CONSTRAINT "fk_atributos_variacao_valores_atributo_id" FOREIGN KEY ("atributo_id") REFERENCES "public"."atributos_variacao"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorias" ADD CONSTRAINT "fk_categorias_categoria_pai_id" FOREIGN KEY ("categoria_pai_id") REFERENCES "public"."categorias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categorias" ADD CONSTRAINT "fk_categorias_imagem_arquivo_id" FOREIGN KEY ("imagem_arquivo_id") REFERENCES "public"."arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grupos_preco_quantidade_faixas" ADD CONSTRAINT "fk_grupos_preco_quantidade_faixas_grupo_id" FOREIGN KEY ("grupo_id") REFERENCES "public"."grupos_preco_quantidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grupos_preco_quantidade_faixas" ADD CONSTRAINT "fk_grupos_preco_quantidade_faixas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marcas" ADD CONSTRAINT "fk_marcas_logotipo_arquivo_id" FOREIGN KEY ("logotipo_arquivo_id") REFERENCES "public"."arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_unidade_id" FOREIGN KEY ("unidade_id") REFERENCES "public"."unidades_medida"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_unidade_tributavel_id" FOREIGN KEY ("unidade_tributavel_id") REFERENCES "public"."unidades_medida"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_impressora_destino_id" FOREIGN KEY ("impressora_destino_id") REFERENCES "public"."impressoras_destino"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_marca_id" FOREIGN KEY ("marca_id") REFERENCES "public"."marcas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_categoria_principal_id" FOREIGN KEY ("categoria_principal_id") REFERENCES "public"."categorias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_cfop_venda_estado" FOREIGN KEY ("cfop_venda_estado") REFERENCES "public"."cfops"("codigo") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_cfop_venda_fora_estado" FOREIGN KEY ("cfop_venda_fora_estado") REFERENCES "public"."cfops"("codigo") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_foto_principal_arquivo_id" FOREIGN KEY ("foto_principal_arquivo_id") REFERENCES "public"."arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_grupo_preco_quantidade_id" FOREIGN KEY ("grupo_preco_quantidade_id") REFERENCES "public"."grupos_preco_quantidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos" ADD CONSTRAINT "fk_produtos_vasilhame_produto_id" FOREIGN KEY ("vasilhame_produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_categorias" ADD CONSTRAINT "fk_produtos_categorias_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_categorias" ADD CONSTRAINT "fk_produtos_categorias_categoria_id" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_codigos_barras" ADD CONSTRAINT "fk_produtos_codigos_barras_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_codigos_barras" ADD CONSTRAINT "fk_produtos_codigos_barras_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_codigos_barras" ADD CONSTRAINT "fk_produtos_codigos_barras_unidade_id" FOREIGN KEY ("unidade_id") REFERENCES "public"."unidades_medida"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_componentes" ADD CONSTRAINT "fk_produtos_componentes_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_componentes" ADD CONSTRAINT "fk_produtos_componentes_componente_id" FOREIGN KEY ("componente_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_componentes" ADD CONSTRAINT "fk_produtos_componentes_componente_variacao_id" FOREIGN KEY ("componente_variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_componentes_alternativas" ADD CONSTRAINT "fk_produtos_componentes_alternativas_componente_id" FOREIGN KEY ("componente_id") REFERENCES "public"."produtos_componentes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_componentes_alternativas" ADD CONSTRAINT "fk_produtos_componentes_alternativas_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_componentes_alternativas" ADD CONSTRAINT "fk_produtos_componentes_alternativas_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_fornecedores" ADD CONSTRAINT "fk_produtos_fornecedores_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_fornecedores" ADD CONSTRAINT "fk_produtos_fornecedores_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_fornecedores" ADD CONSTRAINT "fk_produtos_fornecedores_fornecedor_id" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_historico_precos" ADD CONSTRAINT "fk_produtos_historico_precos_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_imagens" ADD CONSTRAINT "fk_produtos_imagens_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_imagens" ADD CONSTRAINT "fk_produtos_imagens_arquivo_id" FOREIGN KEY ("arquivo_id") REFERENCES "public"."arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_lojas" ADD CONSTRAINT "fk_produtos_lojas_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_lojas" ADD CONSTRAINT "fk_produtos_lojas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_lotes" ADD CONSTRAINT "fk_produtos_lotes_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_lotes" ADD CONSTRAINT "fk_produtos_lotes_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_lotes" ADD CONSTRAINT "fk_produtos_lotes_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_lotes" ADD CONSTRAINT "fk_produtos_lotes_fornecedor_id" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_precos_quantidade" ADD CONSTRAINT "fk_produtos_precos_quantidade_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_precos_quantidade" ADD CONSTRAINT "fk_produtos_precos_quantidade_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_precos_quantidade" ADD CONSTRAINT "fk_produtos_precos_quantidade_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_relacionados" ADD CONSTRAINT "fk_produtos_relacionados_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_relacionados" ADD CONSTRAINT "fk_produtos_relacionados_relacionado_id" FOREIGN KEY ("relacionado_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_tributacao_uf" ADD CONSTRAINT "fk_produtos_tributacao_uf_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_tributacao_uf" ADD CONSTRAINT "fk_produtos_tributacao_uf_uf" FOREIGN KEY ("uf") REFERENCES "public"."ufs"("sigla") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_tributacao_uf" ADD CONSTRAINT "fk_produtos_tributacao_uf_cfop_venda_estado" FOREIGN KEY ("cfop_venda_estado") REFERENCES "public"."cfops"("codigo") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_variacoes" ADD CONSTRAINT "fk_produtos_variacoes_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_variacoes_valores" ADD CONSTRAINT "fk_produtos_variacoes_valores_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "produtos_variacoes_valores" ADD CONSTRAINT "fk_produtos_variacoes_valores_atributo_valor_id" FOREIGN KEY ("atributo_valor_id") REFERENCES "public"."atributos_variacao_valores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricoes_horario_venda" ADD CONSTRAINT "fk_restricoes_horario_venda_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricoes_horario_venda" ADD CONSTRAINT "fk_restricoes_horario_venda_categoria_id" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parametros_fiscais_uf" ADD CONSTRAINT "fk_parametros_fiscais_uf_uf" FOREIGN KEY ("uf") REFERENCES "public"."ufs"("sigla") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lojas_banners" ADD CONSTRAINT "fk_lojas_banners_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lojas_banners" ADD CONSTRAINT "fk_lojas_banners_arquivo_id" FOREIGN KEY ("arquivo_id") REFERENCES "public"."arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numeracoes_faixas" ADD CONSTRAINT "fk_numeracoes_faixas_numeracao_id" FOREIGN KEY ("numeracao_id") REFERENCES "public"."numeracoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numeracoes_faixas" ADD CONSTRAINT "fk_numeracoes_faixas_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_acertos_estoque_codigo" ON "acertos_estoque" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "ix_acertos_estoque_estoque_id_data_contagem" ON "acertos_estoque" USING btree ("estoque_id","data_contagem");--> statement-breakpoint
CREATE INDEX "ix_acertos_estoque_tipo_estoque_id" ON "acertos_estoque" USING btree ("tipo_estoque_id");--> statement-breakpoint
CREATE INDEX "ix_acertos_estoque_responsavel_id" ON "acertos_estoque" USING btree ("responsavel_id");--> statement-breakpoint
CREATE INDEX "ix_acertos_estoque_efetivado_por_id" ON "acertos_estoque" USING btree ("efetivado_por_id");--> statement-breakpoint
CREATE INDEX "ix_acertos_estoque_estornado_por_id" ON "acertos_estoque" USING btree ("estornado_por_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_itens_acerto_estoque_sequencia" ON "itens_acerto_estoque" USING btree ("acerto_id","sequencia");--> statement-breakpoint
CREATE INDEX "ix_itens_acerto_estoque_produto_id" ON "itens_acerto_estoque" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_itens_acerto_estoque_variacao_id" ON "itens_acerto_estoque" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_itens_acerto_estoque_lote_id" ON "itens_acerto_estoque" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_estoque_produto_data" ON "movimentos_estoque" USING btree ("estoque_id","produto_id","variacao_id","data_movimento");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_documento" ON "movimentos_estoque" USING btree ("documento_tipo","documento_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_tipo_movimento" ON "movimentos_estoque" USING btree ("tipo_movimento");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_loja_id" ON "movimentos_estoque" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_tipo_estoque_id" ON "movimentos_estoque" USING btree ("tipo_estoque_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_produto_id" ON "movimentos_estoque" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_variacao_id" ON "movimentos_estoque" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_lote_id" ON "movimentos_estoque" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_usuario_id" ON "movimentos_estoque" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_pessoa_id" ON "movimentos_estoque" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_terminal_id" ON "movimentos_estoque" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_estorno_de_id" ON "movimentos_estoque" USING btree ("estorno_de_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_estoque_compensa_movimento_id" ON "movimentos_estoque" USING btree ("compensa_movimento_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_estoque_produto_id" ON "saldos_estoque" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_estoque_variacao_id" ON "saldos_estoque" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_estoque_tipo_estoque_id" ON "saldos_estoque" USING btree ("tipo_estoque_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_estoque_ultimo_movimento_id" ON "saldos_estoque" USING btree ("ultimo_movimento_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_lote_produto_id" ON "saldos_lote" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_lote_variacao_id" ON "saldos_lote" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_lote_lote_id" ON "saldos_lote" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_lote_tipo_estoque_id" ON "saldos_lote" USING btree ("tipo_estoque_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_saldos_vasilhame_pessoas" ON "saldos_vasilhame_pessoas" USING btree ("pessoa_id","produto_vasilhame_id");--> statement-breakpoint
CREATE INDEX "ix_saldos_vasilhame_pessoas_produto_vasilhame_id" ON "saldos_vasilhame_pessoas" USING btree ("produto_vasilhame_id");--> statement-breakpoint
CREATE INDEX "ix_certificados_digitais_loja_id" ON "certificados_digitais" USING btree ("loja_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_certificados_digitais_loja_ativo" ON "certificados_digitais" USING btree ("loja_id") WHERE ativo and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_impressoras_destino_loja_id" ON "impressoras_destino" USING btree ("loja_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_taxas_entrega_loja_bairro" ON "taxas_entrega" USING btree ("loja_id","municipio_ibge",lower(fn_unaccent(bairro))) WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_taxas_entrega_municipio_ibge" ON "taxas_entrega" USING btree ("municipio_ibge");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_planos_contas_lojas" ON "planos_contas_lojas" USING btree ("plano_contas_id","loja_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_planos_contas_lojas_loja_id" ON "planos_contas_lojas" USING btree ("loja_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_parcelas_credito_pessoas_parcela" ON "parcelas_credito_pessoas" USING btree ("parcela_financeira_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_parcelas_credito_pessoas_pessoa_id" ON "parcelas_credito_pessoas" USING btree ("pessoa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pessoas_codigo" ON "pessoas" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pessoas_cpf_cnpj" ON "pessoas" USING btree ("cpf_cnpj") WHERE cpf_cnpj is not null and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_pessoas_busca" ON "pessoas" USING gin (busca gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ix_pessoas_origem_terminal_id" ON "pessoas" USING btree ("origem_terminal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pessoas_aliases_alias_id" ON "pessoas_aliases" USING btree ("alias_id");--> statement-breakpoint
CREATE INDEX "ix_pessoas_aliases_pessoa_id" ON "pessoas_aliases" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "ix_pessoas_aliases_terminal_id" ON "pessoas_aliases" USING btree ("terminal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pessoas_categorias" ON "pessoas_categorias" USING btree ("pessoa_id","categoria") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_pessoas_categorias_categoria" ON "pessoas_categorias" USING btree ("categoria");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pessoas_emails" ON "pessoas_emails" USING btree ("pessoa_id",lower(email)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pessoas_emails_principal" ON "pessoas_emails" USING btree ("pessoa_id") WHERE principal and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_pessoas_enderecos_pessoa_id" ON "pessoas_enderecos" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "ix_pessoas_enderecos_cep" ON "pessoas_enderecos" USING btree ("cep");--> statement-breakpoint
CREATE INDEX "ix_pessoas_enderecos_uf" ON "pessoas_enderecos" USING btree ("uf");--> statement-breakpoint
CREATE INDEX "ix_pessoas_enderecos_municipio_ibge" ON "pessoas_enderecos" USING btree ("municipio_ibge");--> statement-breakpoint
CREATE INDEX "ix_pessoas_enderecos_pais_codigo" ON "pessoas_enderecos" USING btree ("pais_codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pessoas_enderecos_principal" ON "pessoas_enderecos" USING btree ("pessoa_id") WHERE tipo = 'principal' and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_pessoas_relevancia_loja_loja_id" ON "pessoas_relevancia_loja" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_pessoas_telefones_pessoa_id" ON "pessoas_telefones" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "ix_pessoas_telefones_numero" ON "pessoas_telefones" USING btree ("ddd","numero");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pessoas_telefones_principal" ON "pessoas_telefones" USING btree ("pessoa_id") WHERE principal and excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_saldos_credito_pessoas_pessoa_id" ON "saldos_credito_pessoas" USING btree ("pessoa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_atributos_variacao_nome" ON "atributos_variacao" USING btree (lower(nome)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_atributos_variacao_valores" ON "atributos_variacao_valores" USING btree ("atributo_id",lower(valor)) WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_atributos_variacao_valores_atributo_id" ON "atributos_variacao_valores" USING btree ("atributo_id");--> statement-breakpoint
CREATE INDEX "ix_categorias_categoria_pai_id" ON "categorias" USING btree ("categoria_pai_id");--> statement-breakpoint
CREATE INDEX "ix_categorias_caminho" ON "categorias" USING btree (caminho text_pattern_ops);--> statement-breakpoint
CREATE INDEX "ix_categorias_imagem_arquivo_id" ON "categorias" USING btree ("imagem_arquivo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_grupos_preco_quantidade_codigo" ON "grupos_preco_quantidade" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_grupos_preco_quantidade_nome" ON "grupos_preco_quantidade" USING btree (lower(fn_unaccent(nome))) WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_grupos_preco_quantidade_faixas_grupo_id" ON "grupos_preco_quantidade_faixas" USING btree ("grupo_id");--> statement-breakpoint
CREATE INDEX "ix_grupos_preco_quantidade_faixas_loja_id" ON "grupos_preco_quantidade_faixas" USING btree ("loja_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_marcas_codigo" ON "marcas" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_marcas_descricao" ON "marcas" USING btree (lower(fn_unaccent(descricao))) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_marcas_sem_marca" ON "marcas" USING btree ("sem_marca") WHERE sem_marca and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_marcas_logotipo_arquivo_id" ON "marcas" USING btree ("logotipo_arquivo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_codigo" ON "produtos" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_codigo_interno" ON "produtos" USING btree (lower(codigo_interno)) WHERE codigo_interno is not null and excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_balanca_plu" ON "produtos" USING btree ("balanca_plu") WHERE balanca_plu is not null and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_busca" ON "produtos" USING gin (busca gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ix_produtos_ncm" ON "produtos" USING btree ("ncm");--> statement-breakpoint
CREATE INDEX "ix_produtos_unidade_id" ON "produtos" USING btree ("unidade_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_unidade_tributavel_id" ON "produtos" USING btree ("unidade_tributavel_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_impressora_destino_id" ON "produtos" USING btree ("impressora_destino_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_marca_id" ON "produtos" USING btree ("marca_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_categoria_principal_id" ON "produtos" USING btree ("categoria_principal_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_cfop_venda_estado" ON "produtos" USING btree ("cfop_venda_estado");--> statement-breakpoint
CREATE INDEX "ix_produtos_cfop_venda_fora_estado" ON "produtos" USING btree ("cfop_venda_fora_estado");--> statement-breakpoint
CREATE INDEX "ix_produtos_foto_principal_arquivo_id" ON "produtos" USING btree ("foto_principal_arquivo_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_grupo_preco_quantidade_id" ON "produtos" USING btree ("grupo_preco_quantidade_id") WHERE grupo_preco_quantidade_id is not null;--> statement-breakpoint
CREATE INDEX "ix_produtos_vasilhame_produto_id" ON "produtos" USING btree ("vasilhame_produto_id") WHERE vasilhame_produto_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_categorias" ON "produtos_categorias" USING btree ("produto_id","categoria_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_categorias_principal" ON "produtos_categorias" USING btree ("produto_id") WHERE principal and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_categorias_produto_id" ON "produtos_categorias" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_categorias_categoria_id" ON "produtos_categorias" USING btree ("categoria_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_codigos_barras_codigo" ON "produtos_codigos_barras" USING btree ("codigo") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_codigos_barras_variacao_id" ON "produtos_codigos_barras" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_codigos_barras_unidade_id" ON "produtos_codigos_barras" USING btree ("unidade_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_componentes_produto_id" ON "produtos_componentes" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_componentes_componente_id" ON "produtos_componentes" USING btree ("componente_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_componentes_componente_variacao_id" ON "produtos_componentes" USING btree ("componente_variacao_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_componentes_alternativas_componente_id" ON "produtos_componentes_alternativas" USING btree ("componente_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_componentes_alternativas_produto_id" ON "produtos_componentes_alternativas" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_componentes_alternativas_variacao_id" ON "produtos_componentes_alternativas" USING btree ("variacao_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_fornecedores_codigo" ON "produtos_fornecedores" USING btree ("fornecedor_id","codigo_fornecedor") WHERE codigo_fornecedor is not null and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_fornecedores_produto_id" ON "produtos_fornecedores" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_fornecedores_variacao_id" ON "produtos_fornecedores" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_fornecedores_fornecedor_id" ON "produtos_fornecedores" USING btree ("fornecedor_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_historico_precos_produto_id_criado_em" ON "produtos_historico_precos" USING btree ("produto_id","criado_em");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_imagens" ON "produtos_imagens" USING btree ("produto_id","arquivo_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_imagens_produto_id" ON "produtos_imagens" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_imagens_arquivo_id" ON "produtos_imagens" USING btree ("arquivo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_lojas" ON "produtos_lojas" USING btree ("produto_id","loja_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_lojas_produto_id" ON "produtos_lojas" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_lojas_loja_id" ON "produtos_lojas" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_lojas_st_nota_entrada_id" ON "produtos_lojas" USING btree ("st_nota_entrada_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_lotes_validade" ON "produtos_lotes" USING btree ("validade");--> statement-breakpoint
CREATE INDEX "ix_produtos_lotes_estoque_id" ON "produtos_lotes" USING btree ("estoque_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_lotes_variacao_id" ON "produtos_lotes" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_lotes_fornecedor_id" ON "produtos_lotes" USING btree ("fornecedor_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_precos_quantidade_produto_id" ON "produtos_precos_quantidade" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_precos_quantidade_variacao_id" ON "produtos_precos_quantidade" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_precos_quantidade_loja_id" ON "produtos_precos_quantidade" USING btree ("loja_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_relacionados" ON "produtos_relacionados" USING btree ("produto_id","relacionado_id","tipo") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_relacionados_produto_id" ON "produtos_relacionados" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_relacionados_relacionado_id" ON "produtos_relacionados" USING btree ("relacionado_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_tributacao_uf" ON "produtos_tributacao_uf" USING btree ("produto_id","uf") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_tributacao_uf_produto_id" ON "produtos_tributacao_uf" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_tributacao_uf_uf" ON "produtos_tributacao_uf" USING btree ("uf");--> statement-breakpoint
CREATE INDEX "ix_produtos_tributacao_uf_cfop_venda_estado" ON "produtos_tributacao_uf" USING btree ("cfop_venda_estado");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_variacoes_codigo_interno" ON "produtos_variacoes" USING btree (lower(codigo_interno)) WHERE codigo_interno is not null and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_variacoes_produto_id" ON "produtos_variacoes" USING btree ("produto_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_produtos_variacoes_valores" ON "produtos_variacoes_valores" USING btree ("variacao_id","atributo_valor_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_produtos_variacoes_valores_variacao_id" ON "produtos_variacoes_valores" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_produtos_variacoes_valores_atributo_valor_id" ON "produtos_variacoes_valores" USING btree ("atributo_valor_id");--> statement-breakpoint
CREATE INDEX "ix_restricoes_horario_venda_loja_id" ON "restricoes_horario_venda" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_restricoes_horario_venda_categoria_id" ON "restricoes_horario_venda" USING btree ("categoria_id");--> statement-breakpoint
CREATE INDEX "ix_cests_ncms" ON "cests" USING gin ("ncms");--> statement-breakpoint
CREATE INDEX "ix_ncms_busca" ON "ncms" USING gin (descricao gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_parametros_fiscais_uf_uf_vigencia_inicio" ON "parametros_fiscais_uf" USING btree ("uf","vigencia_inicio");--> statement-breakpoint
CREATE INDEX "ix_lojas_banners_loja_id" ON "lojas_banners" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_lojas_banners_arquivo_id" ON "lojas_banners" USING btree ("arquivo_id");--> statement-breakpoint
CREATE INDEX "ix_numeracoes_faixas_numeracao_id" ON "numeracoes_faixas" USING btree ("numeracao_id");--> statement-breakpoint
CREATE INDEX "ix_numeracoes_faixas_terminal_id_status" ON "numeracoes_faixas" USING btree ("terminal_id","status");--> statement-breakpoint
ALTER TABLE "lojas" ADD CONSTRAINT "ck_lojas_nfce_qrcode_versao" CHECK (nfce_qrcode_versao is null or nfce_qrcode_versao in (2,3));
--> statement-breakpoint
-- Objetos que o drizzle-kit não gera (MD 1.5, 1.6, 1.8, 6.4): triggers de versão, FKs de autoria, índices únicos
-- com NULLS NOT DISTINCT, exclusões de sobreposição (btree_gist), imutabilidade de documentos e de colunas de filtro,
-- EAN único entre produtos e composição (kit/ficha técnica) sem ciclo.
create or replace function fn_filtro_imutavel() returns trigger language plpgsql as $$
-- Colunas de filtro do pull nunca mudam (MD 6.4 regra 2): mudar = excluir logicamente e criar outra linha, para a
-- exclusão descer a quem tinha a linha. Argumentos: as colunas protegidas.
declare
  c text;
  a jsonb := to_jsonb(old);
  b jsonb := to_jsonb(new);
begin
  foreach c in array tg_argv loop
    if (a -> c) is distinct from (b -> c) then
      raise exception using errcode = 'P0001', message = 'FILTRO_IMUTAVEL', detail = tg_table_name || '.' || c;
    end if;
  end loop;
  return new;
end $$;
--> statement-breakpoint
create or replace function fn_produtos_codigos_barras_ean_unico() returns trigger language plpgsql as $$
-- MD 3.6.5: com geral.ean_duplicado = 'bloquear' (padrão; sem linha em configuracoes) um código gtin não pode existir
-- em outro produto. 'avisar' (período de migração) deixa gravar: o ERP pede confirmação. A importação/migração do
-- Nuvem3 aceita duplicados com `set local genesis.ean_duplicado_importacao = 'on'` e gera o relatório depois.
-- A checagem roda sob a trava de ordenação (a tabela desce ao PDV e o trigger de versão a pega de qualquer forma),
-- então duas transações não gravam o mesmo EAN ao mesmo tempo.
declare
  modo text;
begin
  if new.tipo <> 'gtin' or new.excluido_em is not null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.tipo = 'gtin' and old.excluido_em is null
     and old.codigo = new.codigo and old.produto_id = new.produto_id then
    return new;
  end if;
  if coalesce(current_setting('genesis.ean_duplicado_importacao', true), '') = 'on' then
    return new;
  end if;
  select valor #>> '{}' into modo from configuracoes
   where escopo = 'empresa' and loja_id is null and chave = 'geral.ean_duplicado' and excluido_em is null;
  if coalesce(modo, 'bloquear') <> 'bloquear' then
    return new;
  end if;
  perform fn_trava_versao();
  if exists (select 1 from produtos_codigos_barras x
              where x.codigo = new.codigo and x.tipo = 'gtin' and x.excluido_em is null
                and x.produto_id <> new.produto_id and x.id <> new.id) then
    raise exception using errcode = 'P0001', message = 'EAN_DUPLICADO', detail = new.codigo;
  end if;
  return new;
end $$;
--> statement-breakpoint
create or replace function fn_produtos_composicao_sem_ciclo() returns trigger language plpgsql as $$
-- MD 3.6.7: nenhum produto pode, direta ou indiretamente, conter a si mesmo (kit → componente/alternativa, ficha
-- técnica → insumo). Arestas: produtos_componentes (produto_id → componente_id) e alternativas (produto da posição →
-- produto alternativo), só linhas não excluídas. Sob a trava de ordenação: duas transações não fecham um ciclo juntas.
declare
  origem uuid;
  inicio uuid[];
  aresta_excluida uuid := new.id;
begin
  if new.excluido_em is not null then
    return new;
  end if;
  perform fn_trava_versao();
  if tg_table_name = 'produtos_componentes' then
    origem := new.produto_id;
    inicio := array[new.componente_id] || coalesce((select array_agg(a.produto_id) from produtos_componentes_alternativas a
                                                     where a.componente_id = new.id and a.excluido_em is null), '{}');
  else
    select pc.produto_id into origem from produtos_componentes pc where pc.id = new.componente_id;
    inicio := array[new.produto_id];
  end if;
  if origem = any(inicio) or exists (
    with recursive arestas(de, para) as (
      select pc.produto_id, pc.componente_id from produtos_componentes pc
       where pc.excluido_em is null and pc.id <> aresta_excluida
      union all
      select pc.produto_id, a.produto_id from produtos_componentes_alternativas a
        join produtos_componentes pc on pc.id = a.componente_id
       where a.excluido_em is null and pc.excluido_em is null and a.id <> aresta_excluida
    ), alcance(id) as (
      select unnest(inicio)
      union
      select e.para from arestas e join alcance r on e.de = r.id
    )
    select 1 from alcance where id = origem
  ) then
    raise exception using errcode = 'P0001', message = 'COMPOSICAO_CICLICA', detail = origem::text;
  end if;
  return new;
end $$;
--> statement-breakpoint
create or replace function fn_itens_acerto_estoque_rascunho() returns trigger language plpgsql as $$
-- MD 3.7.5: itens só mudam enquanto o acerto está em rascunho (a efetivação grava saldo_anterior/diferença/custo
-- nos itens antes de mudar o status do acerto, na mesma transação).
begin
  if exists (select 1 from acertos_estoque a
              where a.id in (new.acerto_id, case when tg_op = 'UPDATE' then old.acerto_id end)
                and a.status <> 'rascunho') then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_lojas_banners_versao before insert or update on lojas_banners
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_lojas_banners_versao on lojas_banners (versao);
--> statement-breakpoint
create trigger tg_numeracoes_faixas_versao before insert or update on numeracoes_faixas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_numeracoes_faixas_versao on numeracoes_faixas (versao);
--> statement-breakpoint
create trigger tg_certificados_digitais_versao before insert or update on certificados_digitais
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_certificados_digitais_versao on certificados_digitais (versao);
--> statement-breakpoint
create trigger tg_impressoras_destino_versao before insert or update on impressoras_destino
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_impressoras_destino_versao on impressoras_destino (versao);
--> statement-breakpoint
create trigger tg_taxas_entrega_versao before insert or update on taxas_entrega
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_taxas_entrega_versao on taxas_entrega (versao);
--> statement-breakpoint
create trigger tg_ncms_versao before insert or update on ncms
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_ncms_versao on ncms (versao);
--> statement-breakpoint
create trigger tg_paises_versao before insert or update on paises
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_paises_versao on paises (versao);
--> statement-breakpoint
create trigger tg_parametros_fiscais_uf_versao before insert or update on parametros_fiscais_uf
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_parametros_fiscais_uf_versao on parametros_fiscais_uf (versao);
--> statement-breakpoint
create trigger tg_marcas_versao before insert or update on marcas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_marcas_versao on marcas (versao);
--> statement-breakpoint
create trigger tg_categorias_versao before insert or update on categorias
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_categorias_versao on categorias (versao);
--> statement-breakpoint
create trigger tg_produtos_versao before insert or update on produtos
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_versao on produtos (versao);
--> statement-breakpoint
create trigger tg_produtos_categorias_versao before insert or update on produtos_categorias
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_categorias_versao on produtos_categorias (versao);
--> statement-breakpoint
create trigger tg_produtos_codigos_barras_versao before insert or update on produtos_codigos_barras
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_codigos_barras_versao on produtos_codigos_barras (versao);
--> statement-breakpoint
create trigger tg_atributos_variacao_versao before insert or update on atributos_variacao
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_atributos_variacao_versao on atributos_variacao (versao);
--> statement-breakpoint
create trigger tg_atributos_variacao_valores_versao before insert or update on atributos_variacao_valores
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_atributos_variacao_valores_versao on atributos_variacao_valores (versao);
--> statement-breakpoint
create trigger tg_produtos_variacoes_versao before insert or update on produtos_variacoes
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_variacoes_versao on produtos_variacoes (versao);
--> statement-breakpoint
create trigger tg_produtos_variacoes_valores_versao before insert or update on produtos_variacoes_valores
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_variacoes_valores_versao on produtos_variacoes_valores (versao);
--> statement-breakpoint
create trigger tg_produtos_componentes_versao before insert or update on produtos_componentes
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_componentes_versao on produtos_componentes (versao);
--> statement-breakpoint
create trigger tg_produtos_componentes_alternativas_versao before insert or update on produtos_componentes_alternativas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_componentes_alternativas_versao on produtos_componentes_alternativas (versao);
--> statement-breakpoint
create trigger tg_produtos_relacionados_versao before insert or update on produtos_relacionados
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_relacionados_versao on produtos_relacionados (versao);
--> statement-breakpoint
create trigger tg_produtos_lojas_versao before insert or update on produtos_lojas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_lojas_versao on produtos_lojas (versao);
--> statement-breakpoint
create trigger tg_produtos_tributacao_uf_versao before insert or update on produtos_tributacao_uf
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_tributacao_uf_versao on produtos_tributacao_uf (versao);
--> statement-breakpoint
create trigger tg_produtos_precos_quantidade_versao before insert or update on produtos_precos_quantidade
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_precos_quantidade_versao on produtos_precos_quantidade (versao);
--> statement-breakpoint
create trigger tg_produtos_lotes_versao before insert or update on produtos_lotes
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_produtos_lotes_versao on produtos_lotes (versao);
--> statement-breakpoint
create trigger tg_restricoes_horario_venda_versao before insert or update on restricoes_horario_venda
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_restricoes_horario_venda_versao on restricoes_horario_venda (versao);
--> statement-breakpoint
create trigger tg_grupos_preco_quantidade_versao before insert or update on grupos_preco_quantidade
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_grupos_preco_quantidade_versao on grupos_preco_quantidade (versao);
--> statement-breakpoint
create trigger tg_grupos_preco_quantidade_faixas_versao before insert or update on grupos_preco_quantidade_faixas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_grupos_preco_quantidade_faixas_versao on grupos_preco_quantidade_faixas (versao);
--> statement-breakpoint
create trigger tg_saldos_estoque_versao before insert or update on saldos_estoque
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_saldos_estoque_versao on saldos_estoque (versao);
--> statement-breakpoint
create trigger tg_saldos_lote_versao before insert or update on saldos_lote
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_saldos_lote_versao on saldos_lote (versao);
--> statement-breakpoint
create trigger tg_pessoas_relevancia_loja_versao before insert or update on pessoas_relevancia_loja
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_pessoas_relevancia_loja_versao on pessoas_relevancia_loja (versao);
--> statement-breakpoint
create trigger tg_pessoas_versao before insert or update on pessoas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_pessoas_versao on pessoas (versao);
--> statement-breakpoint
create trigger tg_pessoas_categorias_versao before insert or update on pessoas_categorias
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_pessoas_categorias_versao on pessoas_categorias (versao);
--> statement-breakpoint
create trigger tg_pessoas_enderecos_versao before insert or update on pessoas_enderecos
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_pessoas_enderecos_versao on pessoas_enderecos (versao);
--> statement-breakpoint
create trigger tg_pessoas_telefones_versao before insert or update on pessoas_telefones
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_pessoas_telefones_versao on pessoas_telefones (versao);
--> statement-breakpoint
create trigger tg_pessoas_aliases_versao before insert or update on pessoas_aliases
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_pessoas_aliases_versao on pessoas_aliases (versao);
--> statement-breakpoint
create trigger tg_saldos_credito_pessoas_versao before insert or update on saldos_credito_pessoas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_saldos_credito_pessoas_versao on saldos_credito_pessoas (versao);
--> statement-breakpoint
create trigger tg_parcelas_credito_pessoas_versao before insert or update on parcelas_credito_pessoas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_parcelas_credito_pessoas_versao on parcelas_credito_pessoas (versao);
--> statement-breakpoint
create trigger tg_saldos_vasilhame_pessoas_versao before insert or update on saldos_vasilhame_pessoas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_saldos_vasilhame_pessoas_versao on saldos_vasilhame_pessoas (versao);
--> statement-breakpoint
create trigger tg_planos_contas_lojas_versao before insert or update on planos_contas_lojas
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_cests_versao before insert or update on cests
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_pessoas_emails_versao before insert or update on pessoas_emails
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_produtos_fornecedores_versao before insert or update on produtos_fornecedores
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_produtos_imagens_versao before insert or update on produtos_imagens
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_movimentos_estoque_versao before insert or update on movimentos_estoque
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_acertos_estoque_versao before insert or update on acertos_estoque
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_itens_acerto_estoque_versao before insert or update on itens_acerto_estoque
  for each row execute function fn_versao_local();
--> statement-breakpoint
alter table lojas_banners add constraint fk_lojas_banners_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_lojas_banners_criado_por_id on lojas_banners (criado_por_id);
--> statement-breakpoint
alter table lojas_banners add constraint fk_lojas_banners_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_lojas_banners_atualizado_por_id on lojas_banners (atualizado_por_id);
--> statement-breakpoint
alter table certificados_digitais add constraint fk_certificados_digitais_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_certificados_digitais_criado_por_id on certificados_digitais (criado_por_id);
--> statement-breakpoint
alter table certificados_digitais add constraint fk_certificados_digitais_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_certificados_digitais_atualizado_por_id on certificados_digitais (atualizado_por_id);
--> statement-breakpoint
alter table impressoras_destino add constraint fk_impressoras_destino_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_impressoras_destino_criado_por_id on impressoras_destino (criado_por_id);
--> statement-breakpoint
alter table impressoras_destino add constraint fk_impressoras_destino_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_impressoras_destino_atualizado_por_id on impressoras_destino (atualizado_por_id);
--> statement-breakpoint
alter table taxas_entrega add constraint fk_taxas_entrega_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_taxas_entrega_criado_por_id on taxas_entrega (criado_por_id);
--> statement-breakpoint
alter table taxas_entrega add constraint fk_taxas_entrega_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_taxas_entrega_atualizado_por_id on taxas_entrega (atualizado_por_id);
--> statement-breakpoint
alter table planos_contas_lojas add constraint fk_planos_contas_lojas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_planos_contas_lojas_criado_por_id on planos_contas_lojas (criado_por_id);
--> statement-breakpoint
alter table planos_contas_lojas add constraint fk_planos_contas_lojas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_planos_contas_lojas_atualizado_por_id on planos_contas_lojas (atualizado_por_id);
--> statement-breakpoint
alter table pessoas add constraint fk_pessoas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_criado_por_id on pessoas (criado_por_id);
--> statement-breakpoint
alter table pessoas add constraint fk_pessoas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_atualizado_por_id on pessoas (atualizado_por_id);
--> statement-breakpoint
alter table pessoas_categorias add constraint fk_pessoas_categorias_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_categorias_criado_por_id on pessoas_categorias (criado_por_id);
--> statement-breakpoint
alter table pessoas_categorias add constraint fk_pessoas_categorias_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_categorias_atualizado_por_id on pessoas_categorias (atualizado_por_id);
--> statement-breakpoint
alter table pessoas_enderecos add constraint fk_pessoas_enderecos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_enderecos_criado_por_id on pessoas_enderecos (criado_por_id);
--> statement-breakpoint
alter table pessoas_enderecos add constraint fk_pessoas_enderecos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_enderecos_atualizado_por_id on pessoas_enderecos (atualizado_por_id);
--> statement-breakpoint
alter table pessoas_telefones add constraint fk_pessoas_telefones_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_telefones_criado_por_id on pessoas_telefones (criado_por_id);
--> statement-breakpoint
alter table pessoas_telefones add constraint fk_pessoas_telefones_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_telefones_atualizado_por_id on pessoas_telefones (atualizado_por_id);
--> statement-breakpoint
alter table pessoas_emails add constraint fk_pessoas_emails_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_emails_criado_por_id on pessoas_emails (criado_por_id);
--> statement-breakpoint
alter table pessoas_emails add constraint fk_pessoas_emails_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_emails_atualizado_por_id on pessoas_emails (atualizado_por_id);
--> statement-breakpoint
alter table pessoas_aliases add constraint fk_pessoas_aliases_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_aliases_criado_por_id on pessoas_aliases (criado_por_id);
--> statement-breakpoint
alter table pessoas_aliases add constraint fk_pessoas_aliases_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_pessoas_aliases_atualizado_por_id on pessoas_aliases (atualizado_por_id);
--> statement-breakpoint
alter table marcas add constraint fk_marcas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_marcas_criado_por_id on marcas (criado_por_id);
--> statement-breakpoint
alter table marcas add constraint fk_marcas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_marcas_atualizado_por_id on marcas (atualizado_por_id);
--> statement-breakpoint
alter table categorias add constraint fk_categorias_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_categorias_criado_por_id on categorias (criado_por_id);
--> statement-breakpoint
alter table categorias add constraint fk_categorias_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_categorias_atualizado_por_id on categorias (atualizado_por_id);
--> statement-breakpoint
alter table grupos_preco_quantidade add constraint fk_grupos_preco_quantidade_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_grupos_preco_quantidade_criado_por_id on grupos_preco_quantidade (criado_por_id);
--> statement-breakpoint
alter table grupos_preco_quantidade add constraint fk_grupos_preco_quantidade_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_grupos_preco_quantidade_atualizado_por_id on grupos_preco_quantidade (atualizado_por_id);
--> statement-breakpoint
alter table grupos_preco_quantidade_faixas add constraint fk_grupos_preco_quantidade_faixas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_grupos_preco_quantidade_faixas_criado_por_id on grupos_preco_quantidade_faixas (criado_por_id);
--> statement-breakpoint
alter table grupos_preco_quantidade_faixas add constraint fk_grupos_preco_quantidade_faixas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_grupos_preco_quantidade_faixas_atualizado_por_id on grupos_preco_quantidade_faixas (atualizado_por_id);
--> statement-breakpoint
alter table produtos add constraint fk_produtos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_criado_por_id on produtos (criado_por_id);
--> statement-breakpoint
alter table produtos add constraint fk_produtos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_atualizado_por_id on produtos (atualizado_por_id);
--> statement-breakpoint
alter table produtos_categorias add constraint fk_produtos_categorias_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_categorias_criado_por_id on produtos_categorias (criado_por_id);
--> statement-breakpoint
alter table produtos_categorias add constraint fk_produtos_categorias_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_categorias_atualizado_por_id on produtos_categorias (atualizado_por_id);
--> statement-breakpoint
alter table atributos_variacao add constraint fk_atributos_variacao_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_atributos_variacao_criado_por_id on atributos_variacao (criado_por_id);
--> statement-breakpoint
alter table atributos_variacao add constraint fk_atributos_variacao_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_atributos_variacao_atualizado_por_id on atributos_variacao (atualizado_por_id);
--> statement-breakpoint
alter table atributos_variacao_valores add constraint fk_atributos_variacao_valores_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_atributos_variacao_valores_criado_por_id on atributos_variacao_valores (criado_por_id);
--> statement-breakpoint
alter table atributos_variacao_valores add constraint fk_atributos_variacao_valores_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_atributos_variacao_valores_atualizado_por_id on atributos_variacao_valores (atualizado_por_id);
--> statement-breakpoint
alter table produtos_variacoes add constraint fk_produtos_variacoes_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_variacoes_criado_por_id on produtos_variacoes (criado_por_id);
--> statement-breakpoint
alter table produtos_variacoes add constraint fk_produtos_variacoes_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_variacoes_atualizado_por_id on produtos_variacoes (atualizado_por_id);
--> statement-breakpoint
alter table produtos_variacoes_valores add constraint fk_produtos_variacoes_valores_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_variacoes_valores_criado_por_id on produtos_variacoes_valores (criado_por_id);
--> statement-breakpoint
alter table produtos_variacoes_valores add constraint fk_produtos_variacoes_valores_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_variacoes_valores_atualizado_por_id on produtos_variacoes_valores (atualizado_por_id);
--> statement-breakpoint
alter table produtos_codigos_barras add constraint fk_produtos_codigos_barras_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_codigos_barras_criado_por_id on produtos_codigos_barras (criado_por_id);
--> statement-breakpoint
alter table produtos_codigos_barras add constraint fk_produtos_codigos_barras_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_codigos_barras_atualizado_por_id on produtos_codigos_barras (atualizado_por_id);
--> statement-breakpoint
alter table produtos_componentes add constraint fk_produtos_componentes_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_componentes_criado_por_id on produtos_componentes (criado_por_id);
--> statement-breakpoint
alter table produtos_componentes add constraint fk_produtos_componentes_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_componentes_atualizado_por_id on produtos_componentes (atualizado_por_id);
--> statement-breakpoint
alter table produtos_componentes_alternativas add constraint fk_produtos_componentes_alternativas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_componentes_alternativas_criado_por_id on produtos_componentes_alternativas (criado_por_id);
--> statement-breakpoint
alter table produtos_componentes_alternativas add constraint fk_produtos_componentes_alternativas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_componentes_alternativas_atualizado_por_id on produtos_componentes_alternativas (atualizado_por_id);
--> statement-breakpoint
alter table produtos_relacionados add constraint fk_produtos_relacionados_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_relacionados_criado_por_id on produtos_relacionados (criado_por_id);
--> statement-breakpoint
alter table produtos_relacionados add constraint fk_produtos_relacionados_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_relacionados_atualizado_por_id on produtos_relacionados (atualizado_por_id);
--> statement-breakpoint
alter table produtos_precos_quantidade add constraint fk_produtos_precos_quantidade_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_precos_quantidade_criado_por_id on produtos_precos_quantidade (criado_por_id);
--> statement-breakpoint
alter table produtos_precos_quantidade add constraint fk_produtos_precos_quantidade_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_precos_quantidade_atualizado_por_id on produtos_precos_quantidade (atualizado_por_id);
--> statement-breakpoint
alter table produtos_lojas add constraint fk_produtos_lojas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_lojas_criado_por_id on produtos_lojas (criado_por_id);
--> statement-breakpoint
alter table produtos_lojas add constraint fk_produtos_lojas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_lojas_atualizado_por_id on produtos_lojas (atualizado_por_id);
--> statement-breakpoint
alter table produtos_tributacao_uf add constraint fk_produtos_tributacao_uf_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_tributacao_uf_criado_por_id on produtos_tributacao_uf (criado_por_id);
--> statement-breakpoint
alter table produtos_tributacao_uf add constraint fk_produtos_tributacao_uf_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_tributacao_uf_atualizado_por_id on produtos_tributacao_uf (atualizado_por_id);
--> statement-breakpoint
alter table produtos_lotes add constraint fk_produtos_lotes_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_lotes_criado_por_id on produtos_lotes (criado_por_id);
--> statement-breakpoint
alter table produtos_lotes add constraint fk_produtos_lotes_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_lotes_atualizado_por_id on produtos_lotes (atualizado_por_id);
--> statement-breakpoint
alter table produtos_fornecedores add constraint fk_produtos_fornecedores_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_fornecedores_criado_por_id on produtos_fornecedores (criado_por_id);
--> statement-breakpoint
alter table produtos_fornecedores add constraint fk_produtos_fornecedores_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_fornecedores_atualizado_por_id on produtos_fornecedores (atualizado_por_id);
--> statement-breakpoint
alter table produtos_imagens add constraint fk_produtos_imagens_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_imagens_criado_por_id on produtos_imagens (criado_por_id);
--> statement-breakpoint
alter table produtos_imagens add constraint fk_produtos_imagens_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_produtos_imagens_atualizado_por_id on produtos_imagens (atualizado_por_id);
--> statement-breakpoint
alter table restricoes_horario_venda add constraint fk_restricoes_horario_venda_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_restricoes_horario_venda_criado_por_id on restricoes_horario_venda (criado_por_id);
--> statement-breakpoint
alter table restricoes_horario_venda add constraint fk_restricoes_horario_venda_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_restricoes_horario_venda_atualizado_por_id on restricoes_horario_venda (atualizado_por_id);
--> statement-breakpoint
alter table acertos_estoque add constraint fk_acertos_estoque_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_acertos_estoque_criado_por_id on acertos_estoque (criado_por_id);
--> statement-breakpoint
alter table acertos_estoque add constraint fk_acertos_estoque_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_acertos_estoque_atualizado_por_id on acertos_estoque (atualizado_por_id);
--> statement-breakpoint
-- FK adiada na Fase 0 (README › Decisões 7): usuarios.pessoa_id → pessoas.
alter table usuarios add constraint fk_usuarios_pessoa_id foreign key (pessoa_id) references pessoas (id);
--> statement-breakpoint
create unique index uq_impressoras_destino_nome on impressoras_destino (loja_id, lower(nome)) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_pessoas_relevancia_loja on pessoas_relevancia_loja (pessoa_id, loja_id, motivo) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_categorias_nome_irmaos on categorias (categoria_pai_id, lower(nome)) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_produtos_codigos_barras_produto_codigo on produtos_codigos_barras (produto_id, variacao_id, codigo) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_produtos_codigos_barras_principal on produtos_codigos_barras (produto_id, variacao_id) nulls not distinct
  where principal and excluido_em is null;
--> statement-breakpoint
create unique index uq_produtos_componentes_ficha_tecnica on produtos_componentes (produto_id, componente_id, componente_variacao_id) nulls not distinct
  where tipo = 'ficha_tecnica' and excluido_em is null;
--> statement-breakpoint
create unique index uq_produtos_componentes_alternativas on produtos_componentes_alternativas (componente_id, produto_id, variacao_id) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_produtos_lotes on produtos_lotes (produto_id, variacao_id, estoque_id, lote) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_movimentos_estoque_idempotencia on movimentos_estoque (documento_tipo, documento_item_id, produto_id, variacao_id, lote_id, tipo_estoque_id, tipo_movimento) nulls not distinct
  where documento_item_id is not null;
--> statement-breakpoint
create unique index uq_saldos_estoque_chave on saldos_estoque (estoque_id, produto_id, variacao_id, tipo_estoque_id) nulls not distinct;
--> statement-breakpoint
create unique index uq_saldos_lote_chave on saldos_lote (estoque_id, produto_id, variacao_id, lote_id, tipo_estoque_id) nulls not distinct;
--> statement-breakpoint
create unique index uq_itens_acerto_estoque_produto on itens_acerto_estoque (acerto_id, produto_id, variacao_id, lote_id) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create index ix_movimentos_estoque_data_movimento on movimentos_estoque using brin (data_movimento);
--> statement-breakpoint
alter table produtos_precos_quantidade add constraint ex_produtos_precos_quantidade_sobreposicao
  exclude using gist (produto_id with =, coalesce(variacao_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    coalesce(loja_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    numrange(quantidade_inicial, quantidade_final, '[)') with &&)
  where (excluido_em is null);
--> statement-breakpoint
alter table grupos_preco_quantidade_faixas add constraint ex_grupos_preco_quantidade_faixas_sobreposicao
  exclude using gist (grupo_id with =, coalesce(loja_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    numrange(quantidade_inicial, quantidade_final, '[)') with &&)
  where (excluido_em is null);
--> statement-breakpoint
alter table parametros_fiscais_uf add constraint ex_parametros_fiscais_uf_vigencia
  exclude using gist (uf with =, daterange(vigencia_inicio, vigencia_fim, '[]') with &&)
  where (excluido_em is null);
--> statement-breakpoint
create trigger tg_produtos_lojas_filtro_imutavel before update on produtos_lojas
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_produtos_precos_quantidade_filtro_imutavel before update on produtos_precos_quantidade
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_saldos_estoque_filtro_imutavel before update on saldos_estoque
  for each row execute function fn_filtro_imutavel('estoque_id');
--> statement-breakpoint
create trigger tg_saldos_lote_filtro_imutavel before update on saldos_lote
  for each row execute function fn_filtro_imutavel('estoque_id');
--> statement-breakpoint
create trigger tg_produtos_lotes_filtro_imutavel before update on produtos_lotes
  for each row execute function fn_filtro_imutavel('estoque_id');
--> statement-breakpoint
create trigger tg_impressoras_destino_filtro_imutavel before update on impressoras_destino
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_lojas_banners_filtro_imutavel before update on lojas_banners
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_taxas_entrega_filtro_imutavel before update on taxas_entrega
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_certificados_digitais_filtro_imutavel before update on certificados_digitais
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_numeracoes_faixas_filtro_imutavel before update on numeracoes_faixas
  for each row execute function fn_filtro_imutavel('terminal_id');
--> statement-breakpoint
create trigger tg_restricoes_horario_venda_filtro_imutavel before update on restricoes_horario_venda
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_grupos_preco_quantidade_faixas_filtro_imutavel before update on grupos_preco_quantidade_faixas
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_pessoas_relevancia_loja_filtro_imutavel before update on pessoas_relevancia_loja
  for each row execute function fn_filtro_imutavel('pessoa_id', 'loja_id', 'motivo');
--> statement-breakpoint
create trigger tg_usuarios_lojas_filtro_imutavel before update on usuarios_lojas
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_configuracoes_filtro_imutavel before update on configuracoes
  for each row execute function fn_filtro_imutavel('escopo', 'loja_id');
--> statement-breakpoint
create trigger tg_templates_documentos_filtro_imutavel before update on templates_documentos
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_atalhos_pdv_filtro_imutavel before update on atalhos_pdv
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_caixas_filtro_imutavel before update on caixas
  for each row execute function fn_filtro_imutavel('loja_id');
--> statement-breakpoint
create trigger tg_movimentos_estoque_imutavel before update on movimentos_estoque
  for each row execute function fn_protege_imutavel('', '', 'versao,atualizado_em');
--> statement-breakpoint
create trigger tg_acertos_estoque_imutavel before update on acertos_estoque
  for each row execute function fn_protege_imutavel('status', 'rascunho',
    'status,estornado_em,estornado_por_id,motivo_estorno,versao,atualizado_em,atualizado_por_id');
--> statement-breakpoint
create trigger tg_itens_acerto_estoque_rascunho before insert or update on itens_acerto_estoque
  for each row execute function fn_itens_acerto_estoque_rascunho();
--> statement-breakpoint
create trigger tg_produtos_codigos_barras_ean_unico before insert or update on produtos_codigos_barras
  for each row execute function fn_produtos_codigos_barras_ean_unico();
--> statement-breakpoint
create trigger tg_produtos_componentes_sem_ciclo before insert or update on produtos_componentes
  for each row execute function fn_produtos_composicao_sem_ciclo();
--> statement-breakpoint
create trigger tg_produtos_componentes_alternativas_sem_ciclo before insert or update on produtos_componentes_alternativas
  for each row execute function fn_produtos_composicao_sem_ciclo();
