CREATE TABLE "historico_logins" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ocorrido_em" timestamp with time zone NOT NULL,
	"origem" varchar(5) NOT NULL,
	"usuario_id" uuid,
	"login_informado" varchar(60) NOT NULL,
	"terminal_id" uuid,
	"sucesso" boolean NOT NULL,
	"motivo_falha" varchar(30),
	"ip" "inet",
	"user_agent" varchar(255),
	CONSTRAINT "pk_historico_logins" PRIMARY KEY("id"),
	CONSTRAINT "ck_historico_logins_origem" CHECK (origem in ('erp','pdv')),
	CONSTRAINT "ck_historico_logins_motivo_falha" CHECK (motivo_falha is null or motivo_falha in ('senha_invalida','usuario_inativo','demitido','loja_nao_permitida','bloqueado','empresa_suspensa'))
);
--> statement-breakpoint
CREATE TABLE "perfis" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"nome" varchar(40) NOT NULL,
	"descricao" varchar(255),
	"chave_sistema" varchar(30),
	CONSTRAINT "pk_perfis" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "perfis_permissoes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"perfil_id" uuid NOT NULL,
	"permissao" varchar(80) NOT NULL,
	CONSTRAINT "pk_perfis_permissoes" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "permissoes" (
	"chave" varchar(80) NOT NULL,
	"modulo" varchar(5) NOT NULL,
	"grupo" varchar(60) NOT NULL,
	"descricao" varchar(255) NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"permite_liberacao" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_permissoes" PRIMARY KEY("chave"),
	CONSTRAINT "ck_permissoes_chave" CHECK (chave ~ '^[a-z_]+(\.[a-z_]+)+$'),
	CONSTRAINT "ck_permissoes_modulo" CHECK (modulo in ('erp','pdv'))
);
--> statement-breakpoint
CREATE TABLE "redefinicoes_senha" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"usado_em" timestamp with time zone,
	"ip" "inet",
	CONSTRAINT "pk_redefinicoes_senha" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "sessoes_usuario" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"refresh_token_hash" varchar(64) NOT NULL,
	"familia_id" uuid NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"ultimo_uso_em" timestamp with time zone,
	"ip" "inet",
	"user_agent" varchar(255),
	"encerrada_em" timestamp with time zone,
	"motivo_encerramento" varchar(20),
	CONSTRAINT "pk_sessoes_usuario" PRIMARY KEY("id"),
	CONSTRAINT "ck_sessoes_usuario_motivo_encerramento" CHECK (motivo_encerramento is null or motivo_encerramento in ('logout','expirada','encerrada_admin','senha_alterada','reuso_detectado','rotacionada'))
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_usuarios') NOT NULL,
	"nome" varchar(100) NOT NULL,
	"login" varchar(60) NOT NULL,
	"email" varchar(254),
	"senha_hash" varchar(255),
	"senha_provisoria" boolean DEFAULT false NOT NULL,
	"senha_alterada_em" timestamp with time zone,
	"senha_pdv_hash" varchar(255),
	"ativo" boolean DEFAULT true NOT NULL,
	"perfil_id" uuid,
	"master" boolean DEFAULT false NOT NULL,
	"limite_desconto_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"comissao_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"telefone" varchar(20),
	"salario" numeric(15, 2),
	"admissao" date,
	"demissao" date,
	"rg" varchar(20),
	"cpf" varchar(11),
	"cep" varchar(8),
	"logradouro" varchar(150),
	"numero" varchar(20),
	"complemento" varchar(80),
	"bairro" varchar(80),
	"municipio_ibge" integer,
	"uf" char(2),
	"vendedor" boolean DEFAULT false NOT NULL,
	"entregador" boolean DEFAULT false NOT NULL,
	"tecnico" boolean DEFAULT false NOT NULL,
	"pdv_utilitario" boolean DEFAULT false NOT NULL,
	"comanda_eletronica" boolean DEFAULT false NOT NULL,
	"totem" boolean DEFAULT false NOT NULL,
	"pessoa_id" uuid,
	"observacoes" text,
	"permissoes_versao" integer DEFAULT 0 NOT NULL,
	"tentativas_falhas" smallint DEFAULT 0 NOT NULL,
	"bloqueado_ate" timestamp with time zone,
	"ultimo_login_em" timestamp with time zone,
	CONSTRAINT "pk_usuarios" PRIMARY KEY("id"),
	CONSTRAINT "ck_usuarios_perfil" CHECK (master or perfil_id is not null or totem),
	CONSTRAINT "ck_usuarios_limites" CHECK (limite_desconto_pct between 0 and 100 and comissao_pct between 0 and 100),
	CONSTRAINT "ck_usuarios_demissao" CHECK (demissao is null or admissao is null or demissao >= admissao),
	CONSTRAINT "ck_usuarios_login" CHECK (login !~ '\s')
);
--> statement-breakpoint
CREATE TABLE "usuarios_estoques" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"usuario_id" uuid NOT NULL,
	"estoque_id" uuid NOT NULL,
	CONSTRAINT "pk_usuarios_estoques" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "usuarios_lojas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"usuario_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	CONSTRAINT "pk_usuarios_lojas" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "usuarios_permissoes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"usuario_id" uuid NOT NULL,
	"permissao" varchar(80) NOT NULL,
	"efeito" varchar(8) NOT NULL,
	CONSTRAINT "pk_usuarios_permissoes" PRIMARY KEY("id"),
	CONSTRAINT "ck_usuarios_permissoes_efeito" CHECK (efeito in ('conceder','negar'))
);
--> statement-breakpoint
CREATE TABLE "caixas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"loja_id" uuid NOT NULL,
	"numero" smallint NOT NULL,
	"descricao" varchar(40),
	"sistema" boolean DEFAULT false NOT NULL,
	"nfce_serie" integer,
	"tef_terminal" varchar(20),
	"pos_id_terminal" varchar(40),
	"terminal_id" uuid,
	"terminal_anterior_id" uuid,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_caixas" PRIMARY KEY("id"),
	CONSTRAINT "ck_caixas_numero" CHECK (numero between 0 and 99),
	CONSTRAINT "ck_caixas_sistema" CHECK (sistema = (numero = 0)),
	CONSTRAINT "ck_caixas_nfce_serie" CHECK (nfce_serie is null or nfce_serie between 1 and 889)
);
--> statement-breakpoint
CREATE TABLE "empresa" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"unica" boolean DEFAULT true NOT NULL,
	"codigo" integer NOT NULL,
	"razao_social" varchar(150) NOT NULL,
	"nome_fantasia" varchar(150),
	"cnpj" varchar(14) NOT NULL,
	"ie" varchar(20),
	"inscricao_municipal" varchar(20),
	"cep" varchar(8),
	"logradouro" varchar(150),
	"numero" varchar(20),
	"complemento" varchar(80),
	"bairro" varchar(80),
	"municipio_ibge" integer,
	"uf" char(2),
	"telefone" varchar(20),
	"email" varchar(254),
	"email_contador" varchar(254),
	"fuso_horario" varchar(40) DEFAULT 'America/Sao_Paulo' NOT NULL,
	CONSTRAINT "pk_empresa" PRIMARY KEY("id"),
	CONSTRAINT "ck_empresa_unica" CHECK (unica),
	CONSTRAINT "ck_empresa_cnpj" CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "estoques" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" integer DEFAULT nextval('seq_codigo_estoques') NOT NULL,
	"nome" varchar(60) NOT NULL,
	"tipo" varchar(10) DEFAULT 'loja' NOT NULL,
	"endereco" varchar(255),
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_estoques" PRIMARY KEY("id"),
	CONSTRAINT "ck_estoques_tipo" CHECK (tipo in ('loja','deposito','outro'))
);
--> statement-breakpoint
CREATE TABLE "lojas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" smallint NOT NULL,
	"nome" varchar(60) NOT NULL,
	"tipo" varchar(12) DEFAULT 'ponto_venda' NOT NULL,
	"razao_social" varchar(150) NOT NULL,
	"nome_fantasia" varchar(150) NOT NULL,
	"cnpj" varchar(14) NOT NULL,
	"ie" varchar(20),
	"inscricao_municipal" varchar(20),
	"telefone" varchar(20),
	"celular" varchar(20),
	"email" varchar(254),
	"estoque_id" uuid NOT NULL,
	"cep" varchar(8) NOT NULL,
	"logradouro" varchar(150) NOT NULL,
	"numero" varchar(20) NOT NULL,
	"complemento" varchar(80),
	"bairro" varchar(80) NOT NULL,
	"municipio_ibge" integer NOT NULL,
	"uf" char(2) NOT NULL,
	"fuso_horario" varchar(40) DEFAULT 'America/Sao_Paulo' NOT NULL,
	"frase_rodape_cupom" varchar(300),
	"ordem" integer DEFAULT 0 NOT NULL,
	"ativa" boolean DEFAULT true NOT NULL,
	"usa_pdv" boolean DEFAULT true NOT NULL,
	"usa_menu_digital" boolean DEFAULT false NOT NULL,
	"chave_publica" varchar(40),
	"logotipo_arquivo_id" uuid,
	"foto_arquivo_id" uuid,
	"regime" varchar(30),
	"nfe_serie" integer,
	"nfce_ambiente" smallint DEFAULT 2 NOT NULL,
	"tipo_emissao" varchar(12) DEFAULT 'nao_fiscal' NOT NULL,
	"certificado_tipo" varchar(2),
	"nfce_csc_id" varchar(6),
	"nfce_csc_cifrado" "bytea",
	"nfce_csc_homologacao_id" varchar(6),
	"nfce_csc_homologacao_cifrado" "bytea",
	"nfce_prazo_cancelamento_min" smallint DEFAULT 30 NOT NULL,
	"nfce_valor_exige_identificacao" numeric(15, 2) DEFAULT '10000.00' NOT NULL,
	"sat_codigo_ativacao_cifrado" "bytea",
	"tef_provedor" varchar(10),
	"tef_codigo_loja" varchar(30),
	"tef_servidor" varchar(255),
	"tef_token_cifrado" "bytea",
	"tef_cnpj_credenciadora" varchar(14),
	"chave_pix" varchar(77),
	"pix_nome_recebedor" varchar(25),
	"pix_cidade_recebedor" varchar(15),
	CONSTRAINT "pk_lojas" PRIMARY KEY("id"),
	CONSTRAINT "ck_lojas_codigo" CHECK (codigo between 1 and 99),
	CONSTRAINT "ck_lojas_tipo" CHECK (tipo in ('ponto_venda','deposito')),
	CONSTRAINT "ck_lojas_tipo_emissao" CHECK (tipo_emissao in ('nao_fiscal','sat','mfe','nfce')),
	CONSTRAINT "ck_lojas_nfce_ambiente" CHECK (nfce_ambiente in (1,2)),
	CONSTRAINT "ck_lojas_deposito_sem_pdv" CHECK (tipo = 'ponto_venda' or not usa_pdv),
	CONSTRAINT "ck_lojas_cnpj" CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
	CONSTRAINT "ck_lojas_nfce_valor_identificacao" CHECK (nfce_valor_exige_identificacao >= 0)
);
--> statement-breakpoint
CREATE TABLE "tipos_estoque" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"nome" varchar(40) NOT NULL,
	"vendavel" boolean DEFAULT true NOT NULL,
	"padrao" boolean DEFAULT false NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"chave_sistema" varchar(20),
	CONSTRAINT "pk_tipos_estoque" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "atalhos_pdv" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"loja_id" uuid,
	"acao" varchar(40) NOT NULL,
	"tecla" varchar(30) NOT NULL,
	"habilitado" boolean DEFAULT true NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_atalhos_pdv" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "contas_correntes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"tipo" varchar(16) DEFAULT 'conta_corrente' NOT NULL,
	"banco_codigo" varchar(3),
	"descricao" varchar(60) NOT NULL,
	"agencia" varchar(10),
	"agencia_digito" varchar(2),
	"conta" varchar(20),
	"conta_digito" varchar(2),
	"carteira" varchar(5),
	"convenio_boleto" varchar(30),
	"chave_pix" varchar(77),
	"saldo_inicial" numeric(15, 2) DEFAULT '0' NOT NULL,
	"data_saldo" date DEFAULT current_date NOT NULL,
	"saldo_atual" numeric(15, 2) DEFAULT '0' NOT NULL,
	"loja_id" uuid,
	"ativa" boolean DEFAULT true NOT NULL,
	"chave_sistema" varchar(60),
	CONSTRAINT "pk_contas_correntes" PRIMARY KEY("id"),
	CONSTRAINT "ck_contas_correntes_tipo" CHECK (tipo in ('caixa','conta_corrente','poupanca','aplicacao','carteira_digital','adquirente')),
	CONSTRAINT "ck_contas_correntes_banco" CHECK (tipo = 'caixa' or banco_codigo is not null)
);
--> statement-breakpoint
CREATE TABLE "formas_pagamento" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"descricao" varchar(40) NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	"tipo_forma" varchar(20) DEFAULT 'outros' NOT NULL,
	"meio_pagamento_fiscal" varchar(2) NOT NULL,
	"descricao_fiscal" varchar(60),
	"integracao" varchar(12) DEFAULT 'nenhuma' NOT NULL,
	"tipo_pinpad" varchar(7),
	"loja_id" uuid,
	"taxa_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"dias_recebimento" smallint DEFAULT 0 NOT NULL,
	"conta_corrente_id" uuid,
	"plano_contas_id" uuid,
	"senha_liberacao_hash" varchar(255),
	"sempre_zerado_pdv" boolean DEFAULT false NOT NULL,
	"lanca_quitada" boolean DEFAULT true NOT NULL,
	"permite_troco" boolean DEFAULT false NOT NULL,
	"e_boleto" boolean DEFAULT false NOT NULL,
	"exige_pessoa" boolean DEFAULT false NOT NULL,
	"ativa" boolean DEFAULT true NOT NULL,
	"abrir_gaveta" boolean DEFAULT false NOT NULL,
	"usa_pdv" boolean DEFAULT true NOT NULL,
	"usa_totem" boolean DEFAULT false NOT NULL,
	"usa_menu_digital" boolean DEFAULT false NOT NULL,
	"credito_funcionario" boolean DEFAULT false NOT NULL,
	"permite_parcelar" boolean DEFAULT false NOT NULL,
	"parcelas_maximo" smallint DEFAULT 1 NOT NULL,
	"parcela_valor_minimo" numeric(15, 2),
	"gera_qrcode_pix" boolean DEFAULT false NOT NULL,
	"a_prazo" boolean DEFAULT false NOT NULL,
	"vale_compra" boolean DEFAULT false NOT NULL,
	"exige_dados_pos" boolean DEFAULT false NOT NULL,
	"restringe_idade_minima" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pk_formas_pagamento" PRIMARY KEY("id"),
	CONSTRAINT "ck_formas_pagamento_tipo_forma" CHECK (tipo_forma in ('dinheiro','cartao_credito','cartao_debito','pix','crediario','credito_funcionario','vale','vale_alimentacao','vale_refeicao','boleto','cheque','consumo_interno','outros')),
	CONSTRAINT "ck_formas_pagamento_integracao" CHECK (integracao in ('nenhuma','tef','pos_externo','pix_dinamico','pix_estatico')),
	CONSTRAINT "ck_formas_pagamento_tipo_pinpad" CHECK (tipo_pinpad is null or integracao = 'tef'),
	CONSTRAINT "ck_formas_pagamento_parcelas" CHECK (parcelas_maximo between 1 and 48 and (permite_parcelar or parcelas_maximo = 1)),
	CONSTRAINT "ck_formas_pagamento_a_prazo" CHECK (not a_prazo or (exige_pessoa and not lanca_quitada)),
	CONSTRAINT "ck_formas_pagamento_credito_funcionario" CHECK (not credito_funcionario or (exige_pessoa and not lanca_quitada)),
	CONSTRAINT "ck_formas_pagamento_boleto" CHECK (not e_boleto or exige_pessoa),
	CONSTRAINT "ck_formas_pagamento_taxa" CHECK (taxa_pct between 0 and 100),
	CONSTRAINT "ck_formas_pagamento_consumo_interno" CHECK (tipo_forma <> 'consumo_interno' or (lanca_quitada and plano_contas_id is not null and not permite_troco and not abrir_gaveta and not exige_pessoa and meio_pagamento_fiscal = '90'))
);
--> statement-breakpoint
CREATE TABLE "planos_contas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"codigo" varchar(20) NOT NULL,
	"nome" varchar(80) NOT NULL,
	"tipo" varchar(7) NOT NULL,
	"natureza" varchar(10) DEFAULT 'analitica' NOT NULL,
	"pai_id" uuid,
	"ordem" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"chave_sistema" varchar(30),
	CONSTRAINT "pk_planos_contas" PRIMARY KEY("id"),
	CONSTRAINT "ck_planos_contas_tipo" CHECK (tipo in ('receita','despesa','passivo')),
	CONSTRAINT "ck_planos_contas_natureza" CHECK (natureza in ('sintetica','analitica')),
	CONSTRAINT "ck_planos_contas_raiz" CHECK (pai_id is not null or natureza = 'sintetica')
);
--> statement-breakpoint
CREATE TABLE "bancos" (
	"codigo" varchar(3) NOT NULL,
	"ispb" varchar(8),
	"nome" varchar(120) NOT NULL,
	"nome_curto" varchar(40),
	"destaque" smallint,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_bancos" PRIMARY KEY("codigo")
);
--> statement-breakpoint
CREATE TABLE "cfops" (
	"codigo" varchar(4) NOT NULL,
	"descricao" text NOT NULL,
	"tipo" varchar(7) NOT NULL,
	"abrangencia" varchar(14) NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_cfops" PRIMARY KEY("codigo"),
	CONSTRAINT "ck_cfops_codigo" CHECK (codigo ~ '^[1-7][0-9]{3}$'),
	CONSTRAINT "ck_cfops_tipo" CHECK (tipo in ('entrada','saida')),
	CONSTRAINT "ck_cfops_abrangencia" CHECK (abrangencia in ('estadual','interestadual','exterior'))
);
--> statement-breakpoint
CREATE TABLE "cfops_grupos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"grupo" varchar(30) NOT NULL,
	"cfop" varchar(4) NOT NULL,
	"padrao" boolean DEFAULT false NOT NULL,
	"ordem" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_cfops_grupos" PRIMARY KEY("id"),
	CONSTRAINT "ck_cfops_grupos_grupo" CHECK (grupo in ('global','venda_estado','venda_fora_estado','remessa_vendedor_estado','remessa_vendedor_fora_estado'))
);
--> statement-breakpoint
CREATE TABLE "meios_pagamento_fiscais" (
	"codigo" varchar(2) NOT NULL,
	"descricao" varchar(60) NOT NULL,
	"exige_descricao" boolean DEFAULT false NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_meios_pagamento_fiscais" PRIMARY KEY("codigo"),
	CONSTRAINT "ck_meios_pagamento_fiscais_codigo" CHECK (codigo ~ '^[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "municipios" (
	"codigo_ibge" integer NOT NULL,
	"nome" varchar(80) NOT NULL,
	"uf" char(2) NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_municipios" PRIMARY KEY("codigo_ibge")
);
--> statement-breakpoint
CREATE TABLE "tipos_movimento_estoque" (
	"codigo" varchar(30) NOT NULL,
	"nome" varchar(80) NOT NULL,
	"sinal" smallint NOT NULL,
	"documento_tipo" varchar(20) NOT NULL,
	"nome_nuvem3" varchar(80),
	"id_nuvem3" smallint,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_tipos_movimento_estoque" PRIMARY KEY("codigo"),
	CONSTRAINT "ck_tipos_movimento_estoque_sinal" CHECK (sinal in (-1,0,1))
);
--> statement-breakpoint
CREATE TABLE "ufs" (
	"sigla" char(2) NOT NULL,
	"codigo_ibge" smallint NOT NULL,
	"nome" varchar(30) NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	CONSTRAINT "pk_ufs" PRIMARY KEY("sigla")
);
--> statement-breakpoint
CREATE TABLE "unidades_medida" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"sigla" varchar(6) NOT NULL,
	"descricao" varchar(40) NOT NULL,
	"permite_fracao" boolean DEFAULT false NOT NULL,
	"sistema" boolean DEFAULT false NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_unidades_medida" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "alertas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"tipo" varchar(40) NOT NULL,
	"severidade" varchar(10) DEFAULT 'aviso' NOT NULL,
	"titulo" varchar(150) NOT NULL,
	"mensagem" text,
	"loja_id" uuid,
	"entidade" varchar(60),
	"registro_id" uuid,
	"dados" jsonb,
	"chave_deduplicacao" varchar(150),
	"resolvido_em" timestamp with time zone,
	"resolvido_por_id" uuid,
	"resolucao" varchar(255),
	CONSTRAINT "pk_alertas" PRIMARY KEY("id"),
	CONSTRAINT "ck_alertas_severidade" CHECK (severidade in ('info','aviso','critico'))
);
--> statement-breakpoint
CREATE TABLE "arquivos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"chave_armazenamento" varchar(500) NOT NULL,
	"nome_original" varchar(255) NOT NULL,
	"tipo_mime" varchar(100) NOT NULL,
	"tamanho_bytes" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"categoria" varchar(30) NOT NULL,
	"entidade" varchar(60),
	"registro_id" uuid,
	"loja_id" uuid,
	"publico" boolean DEFAULT false NOT NULL,
	"retencao_ate" date,
	CONSTRAINT "pk_arquivos" PRIMARY KEY("id"),
	CONSTRAINT "ck_arquivos_categoria" CHECK (categoria in ('logotipo','banner','foto_produto','foto_loja','imagem_categoria','xml_nfce','xml_nfe_saida','xml_nfe_entrada','xml_evento','xml_inutilizacao','danfe_pdf','planilha_importacao','planilha_exportacao','anexo_financeiro','logs_terminal','outro'))
);
--> statement-breakpoint
CREATE TABLE "configuracoes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"escopo" varchar(10) DEFAULT 'empresa' NOT NULL,
	"loja_id" uuid,
	"chave" varchar(100) NOT NULL,
	"valor" jsonb,
	"valor_cifrado" "bytea",
	"segredo_definido_em" timestamp with time zone,
	CONSTRAINT "pk_configuracoes" PRIMARY KEY("id"),
	CONSTRAINT "ck_configuracoes_escopo" CHECK ((escopo = 'empresa' and loja_id is null) or (escopo = 'loja' and loja_id is not null)),
	CONSTRAINT "ck_configuracoes_valor" CHECK ((valor is null) <> (valor_cifrado is null))
);
--> statement-breakpoint
CREATE TABLE "mensagens_enviadas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"canal" varchar(8) NOT NULL,
	"destino" varchar(254) NOT NULL,
	"template_id" uuid,
	"template_tipo" varchar(40),
	"loja_id" uuid,
	"entidade" varchar(60),
	"registro_id" uuid,
	"status" varchar(10) DEFAULT 'pendente' NOT NULL,
	"tentativas" smallint DEFAULT 0 NOT NULL,
	"erro" text,
	"enviada_em" timestamp with time zone,
	CONSTRAINT "pk_mensagens_enviadas" PRIMARY KEY("id"),
	CONSTRAINT "ck_mensagens_enviadas_canal" CHECK (canal in ('email','whatsapp')),
	CONSTRAINT "ck_mensagens_enviadas_status" CHECK (status in ('pendente','enviada','falhou','cancelada'))
);
--> statement-breakpoint
CREATE TABLE "numeracoes" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"tipo" varchar(20) NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid,
	"modelo" smallint,
	"serie" integer,
	"ambiente" smallint,
	"ultimo_numero" bigint DEFAULT 0 NOT NULL,
	"dono" varchar(10) NOT NULL,
	"ultimo_atualizado_por_terminal_id" uuid,
	CONSTRAINT "pk_numeracoes" PRIMARY KEY("id"),
	CONSTRAINT "ck_numeracoes_tipo" CHECK (tipo in ('venda','nfce','vale','nfe','comanda')),
	CONSTRAINT "ck_numeracoes_dono" CHECK (dono in ('nuvem','terminal')),
	CONSTRAINT "ck_numeracoes_escopo" CHECK ((tipo in ('venda','nfce','vale') and caixa_id is not null) or (tipo in ('nfe','comanda') and caixa_id is null))
);
--> statement-breakpoint
CREATE TABLE "tarefas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"tipo" varchar(40) NOT NULL,
	"status" varchar(12) DEFAULT 'na_fila' NOT NULL,
	"parametros" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progresso_pct" smallint DEFAULT 0 NOT NULL,
	"mensagem" varchar(255),
	"resultado" jsonb,
	"arquivo_id" uuid,
	"erro" text,
	"usuario_id" uuid NOT NULL,
	"loja_id" uuid,
	"iniciada_em" timestamp with time zone,
	"concluida_em" timestamp with time zone,
	CONSTRAINT "pk_tarefas" PRIMARY KEY("id"),
	CONSTRAINT "ck_tarefas_status" CHECK (status in ('na_fila','executando','concluida','falhou','cancelada')),
	CONSTRAINT "ck_tarefas_progresso_pct" CHECK (progresso_pct between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "templates_documentos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"tipo" varchar(40) NOT NULL,
	"nome" varchar(60) NOT NULL,
	"descricao" varchar(255),
	"assunto" varchar(150),
	"formato" varchar(10) DEFAULT 'html' NOT NULL,
	"conteudo" text NOT NULL,
	"loja_id" uuid,
	"padrao" boolean DEFAULT false NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_templates_documentos" PRIMARY KEY("id"),
	CONSTRAINT "ck_templates_documentos_tipo" CHECK (tipo in ('orcamento_logado','orcamento_nao_logado','email_cliente','recibo_remessa_boleto','recibo_receber','recibo_pagar','recibo_venda','impressao_venda','cupom_cabecalho','cupom_rodape','vale_compra','ordem_servico','whatsapp_cupom','whatsapp_orcamento','whatsapp_cobranca','whatsapp_pedido_pronto','whatsapp_pesquisa')),
	CONSTRAINT "ck_templates_documentos_formato" CHECK (formato in ('html','texto'))
);
--> statement-breakpoint
ALTER TABLE "perfis_permissoes" ADD CONSTRAINT "fk_perfis_permissoes_perfil_id" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "perfis_permissoes" ADD CONSTRAINT "fk_perfis_permissoes_permissao" FOREIGN KEY ("permissao") REFERENCES "public"."permissoes"("chave") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redefinicoes_senha" ADD CONSTRAINT "fk_redefinicoes_senha_usuario_id" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes_usuario" ADD CONSTRAINT "fk_sessoes_usuario_usuario_id" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "fk_usuarios_perfil_id" FOREIGN KEY ("perfil_id") REFERENCES "public"."perfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "fk_usuarios_municipio_ibge" FOREIGN KEY ("municipio_ibge") REFERENCES "public"."municipios"("codigo_ibge") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios" ADD CONSTRAINT "fk_usuarios_uf" FOREIGN KEY ("uf") REFERENCES "public"."ufs"("sigla") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios_estoques" ADD CONSTRAINT "fk_usuarios_estoques_usuario_id" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios_estoques" ADD CONSTRAINT "fk_usuarios_estoques_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios_lojas" ADD CONSTRAINT "fk_usuarios_lojas_usuario_id" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios_lojas" ADD CONSTRAINT "fk_usuarios_lojas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios_permissoes" ADD CONSTRAINT "fk_usuarios_permissoes_usuario_id" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usuarios_permissoes" ADD CONSTRAINT "fk_usuarios_permissoes_permissao" FOREIGN KEY ("permissao") REFERENCES "public"."permissoes"("chave") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas" ADD CONSTRAINT "fk_caixas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "empresa" ADD CONSTRAINT "fk_empresa_municipio_ibge" FOREIGN KEY ("municipio_ibge") REFERENCES "public"."municipios"("codigo_ibge") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "empresa" ADD CONSTRAINT "fk_empresa_uf" FOREIGN KEY ("uf") REFERENCES "public"."ufs"("sigla") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lojas" ADD CONSTRAINT "fk_lojas_estoque_id" FOREIGN KEY ("estoque_id") REFERENCES "public"."estoques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lojas" ADD CONSTRAINT "fk_lojas_municipio_ibge" FOREIGN KEY ("municipio_ibge") REFERENCES "public"."municipios"("codigo_ibge") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lojas" ADD CONSTRAINT "fk_lojas_uf" FOREIGN KEY ("uf") REFERENCES "public"."ufs"("sigla") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atalhos_pdv" ADD CONSTRAINT "fk_atalhos_pdv_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contas_correntes" ADD CONSTRAINT "fk_contas_correntes_banco_codigo" FOREIGN KEY ("banco_codigo") REFERENCES "public"."bancos"("codigo") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contas_correntes" ADD CONSTRAINT "fk_contas_correntes_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formas_pagamento" ADD CONSTRAINT "fk_formas_pagamento_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formas_pagamento" ADD CONSTRAINT "fk_formas_pagamento_meio_pagamento_fiscal" FOREIGN KEY ("meio_pagamento_fiscal") REFERENCES "public"."meios_pagamento_fiscais"("codigo") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formas_pagamento" ADD CONSTRAINT "fk_formas_pagamento_conta_corrente_id" FOREIGN KEY ("conta_corrente_id") REFERENCES "public"."contas_correntes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "formas_pagamento" ADD CONSTRAINT "fk_formas_pagamento_plano_contas_id" FOREIGN KEY ("plano_contas_id") REFERENCES "public"."planos_contas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planos_contas" ADD CONSTRAINT "fk_planos_contas_pai_id" FOREIGN KEY ("pai_id") REFERENCES "public"."planos_contas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cfops_grupos" ADD CONSTRAINT "fk_cfops_grupos_cfop" FOREIGN KEY ("cfop") REFERENCES "public"."cfops"("codigo") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "municipios" ADD CONSTRAINT "fk_municipios_uf" FOREIGN KEY ("uf") REFERENCES "public"."ufs"("sigla") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alertas" ADD CONSTRAINT "fk_alertas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alertas" ADD CONSTRAINT "fk_alertas_resolvido_por_id" FOREIGN KEY ("resolvido_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arquivos" ADD CONSTRAINT "fk_arquivos_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuracoes" ADD CONSTRAINT "fk_configuracoes_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensagens_enviadas" ADD CONSTRAINT "fk_mensagens_enviadas_template_id" FOREIGN KEY ("template_id") REFERENCES "public"."templates_documentos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mensagens_enviadas" ADD CONSTRAINT "fk_mensagens_enviadas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numeracoes" ADD CONSTRAINT "fk_numeracoes_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numeracoes" ADD CONSTRAINT "fk_numeracoes_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "fk_tarefas_arquivo_id" FOREIGN KEY ("arquivo_id") REFERENCES "public"."arquivos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "fk_tarefas_usuario_id" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates_documentos" ADD CONSTRAINT "fk_templates_documentos_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_historico_logins_usuario_id_ocorrido_em" ON "historico_logins" USING btree ("usuario_id","ocorrido_em");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_perfis_nome" ON "perfis" USING btree (lower(nome)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_perfis_chave_sistema" ON "perfis" USING btree ("chave_sistema") WHERE chave_sistema is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_perfis_permissoes" ON "perfis_permissoes" USING btree ("perfil_id","permissao") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_perfis_permissoes_permissao" ON "perfis_permissoes" USING btree ("permissao");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_redefinicoes_senha_token_hash" ON "redefinicoes_senha" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_redefinicoes_senha_usuario_id" ON "redefinicoes_senha" USING btree ("usuario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sessoes_usuario_refresh_token_hash" ON "sessoes_usuario" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "ix_sessoes_usuario_usuario_id_encerrada_em" ON "sessoes_usuario" USING btree ("usuario_id","encerrada_em");--> statement-breakpoint
CREATE INDEX "ix_sessoes_usuario_familia_id" ON "sessoes_usuario" USING btree ("familia_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usuarios_codigo" ON "usuarios" USING btree ("codigo") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usuarios_login" ON "usuarios" USING btree (lower(login)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usuarios_cpf" ON "usuarios" USING btree ("cpf") WHERE cpf is not null and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_usuarios_perfil_id" ON "usuarios" USING btree ("perfil_id");--> statement-breakpoint
CREATE INDEX "ix_usuarios_pessoa_id" ON "usuarios" USING btree ("pessoa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usuarios_estoques" ON "usuarios_estoques" USING btree ("usuario_id","estoque_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_usuarios_estoques_estoque_id" ON "usuarios_estoques" USING btree ("estoque_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usuarios_lojas" ON "usuarios_lojas" USING btree ("usuario_id","loja_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_usuarios_lojas_loja_id" ON "usuarios_lojas" USING btree ("loja_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usuarios_permissoes" ON "usuarios_permissoes" USING btree ("usuario_id","permissao") WHERE excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_usuarios_permissoes_permissao" ON "usuarios_permissoes" USING btree ("permissao");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_caixas_loja_id_numero" ON "caixas" USING btree ("loja_id","numero") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_caixas_loja_id_nfce_serie" ON "caixas" USING btree ("loja_id","nfce_serie") WHERE nfce_serie is not null and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_caixas_terminal_id" ON "caixas" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_caixas_terminal_anterior_id" ON "caixas" USING btree ("terminal_anterior_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_empresa_unica" ON "empresa" USING btree ("unica");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_estoques_codigo" ON "estoques" USING btree ("codigo");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_estoques_nome" ON "estoques" USING btree (lower(nome)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lojas_codigo" ON "lojas" USING btree ("codigo") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lojas_nome" ON "lojas" USING btree (lower(nome)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lojas_cnpj" ON "lojas" USING btree ("cnpj") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lojas_estoque_id" ON "lojas" USING btree ("estoque_id") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lojas_chave_publica" ON "lojas" USING btree ("chave_publica") WHERE chave_publica is not null and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_lojas_municipio_ibge" ON "lojas" USING btree ("municipio_ibge");--> statement-breakpoint
CREATE INDEX "ix_lojas_uf" ON "lojas" USING btree ("uf");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tipos_estoque_nome" ON "tipos_estoque" USING btree (lower(nome)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tipos_estoque_padrao" ON "tipos_estoque" USING btree ("padrao") WHERE padrao and excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tipos_estoque_chave_sistema" ON "tipos_estoque" USING btree ("chave_sistema") WHERE chave_sistema is not null;--> statement-breakpoint
CREATE INDEX "ix_atalhos_pdv_loja_id" ON "atalhos_pdv" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_contas_correntes_banco_codigo" ON "contas_correntes" USING btree ("banco_codigo");--> statement-breakpoint
CREATE INDEX "ix_contas_correntes_loja_id" ON "contas_correntes" USING btree ("loja_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contas_correntes_descricao" ON "contas_correntes" USING btree (lower(descricao)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contas_correntes_chave_sistema" ON "contas_correntes" USING btree ("chave_sistema") WHERE chave_sistema is not null;--> statement-breakpoint
CREATE INDEX "ix_formas_pagamento_loja_id" ON "formas_pagamento" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_formas_pagamento_meio_pagamento_fiscal" ON "formas_pagamento" USING btree ("meio_pagamento_fiscal");--> statement-breakpoint
CREATE INDEX "ix_formas_pagamento_conta_corrente_id" ON "formas_pagamento" USING btree ("conta_corrente_id");--> statement-breakpoint
CREATE INDEX "ix_formas_pagamento_plano_contas_id" ON "formas_pagamento" USING btree ("plano_contas_id");--> statement-breakpoint
CREATE INDEX "ix_planos_contas_pai_id" ON "planos_contas" USING btree ("pai_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_planos_contas_codigo" ON "planos_contas" USING btree ("codigo") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_planos_contas_chave_sistema" ON "planos_contas" USING btree ("chave_sistema") WHERE chave_sistema is not null;--> statement-breakpoint
CREATE INDEX "ix_cfops_grupos_cfop" ON "cfops_grupos" USING btree ("cfop");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cfops_grupos" ON "cfops_grupos" USING btree ("grupo","cfop") WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cfops_grupos_padrao" ON "cfops_grupos" USING btree ("grupo") WHERE padrao and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_municipios_uf_nome" ON "municipios" USING btree ("uf","nome");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ufs_codigo_ibge" ON "ufs" USING btree ("codigo_ibge");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_unidades_medida_sigla" ON "unidades_medida" USING btree (upper(sigla)) WHERE excluido_em is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alertas_chave_deduplicacao" ON "alertas" USING btree ("chave_deduplicacao") WHERE resolvido_em is null and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_alertas_loja_id_resolvido_em" ON "alertas" USING btree ("loja_id","resolvido_em");--> statement-breakpoint
CREATE INDEX "ix_alertas_resolvido_por_id" ON "alertas" USING btree ("resolvido_por_id");--> statement-breakpoint
CREATE INDEX "ix_arquivos_entidade_registro_id" ON "arquivos" USING btree ("entidade","registro_id");--> statement-breakpoint
CREATE INDEX "ix_arquivos_sha256" ON "arquivos" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "ix_arquivos_loja_id" ON "arquivos" USING btree ("loja_id") WHERE loja_id is not null;--> statement-breakpoint
CREATE INDEX "ix_configuracoes_loja_id" ON "configuracoes" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_mensagens_enviadas_status" ON "mensagens_enviadas" USING btree ("status","criado_em") WHERE status = 'pendente';--> statement-breakpoint
CREATE INDEX "ix_mensagens_enviadas_entidade" ON "mensagens_enviadas" USING btree ("entidade","registro_id");--> statement-breakpoint
CREATE INDEX "ix_numeracoes_caixa_id" ON "numeracoes" USING btree ("caixa_id");--> statement-breakpoint
CREATE INDEX "ix_numeracoes_ultimo_atualizado_por_terminal_id" ON "numeracoes" USING btree ("ultimo_atualizado_por_terminal_id");--> statement-breakpoint
CREATE INDEX "ix_tarefas_usuario_id_criado_em" ON "tarefas" USING btree ("usuario_id","criado_em");--> statement-breakpoint
CREATE INDEX "ix_tarefas_arquivo_id" ON "tarefas" USING btree ("arquivo_id");--> statement-breakpoint
CREATE INDEX "ix_tarefas_status" ON "tarefas" USING btree ("status") WHERE status in ('na_fila','executando');--> statement-breakpoint
CREATE INDEX "ix_templates_documentos_loja_id" ON "templates_documentos" USING btree ("loja_id");