-- Fase 1C (bloco C3; MD 3.11.2–3.11.6, 3.12.1–3.12.3, 3.12.6): tabelas de venda e caixa que nascem no PDV e chegam
-- por evento. Guarda: nenhum evento de venda, caixa ou vasilhame pode estar em `eventos_recebidos` antes destas
-- tabelas existirem (crítica da 1C, item 18). Até aqui nenhum handler os aplicava (D18: o PDV real não finalizava
-- venda, e um tipo sem handler volta SCHEMA_DESCONHECIDO sem gravar nada); se houver algum, ele foi gravado sem
-- efeito e se perderia em silêncio: a migração falha e a empresa fica em manutenção até alguém olhar.
do $$
declare
  qtd bigint;
begin
  select count(*) into qtd from eventos_recebidos
   where tipo like 'venda.%' or tipo like 'caixa.%' or tipo like 'vasilhame.%';
  if qtd > 0 then
    raise exception using errcode = 'P0001',
      message = format('EVENTOS_DE_VENDA_ANTES_DAS_TABELAS: %s evento(s) venda.*/caixa.*/vasilhame.* em eventos_recebidos', qtd);
  end if;
end $$;
--> statement-breakpoint
CREATE TABLE "fechamentos_caixa" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"sessao_caixa_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"numero_caixa" smallint NOT NULL,
	"tipo" varchar(12) NOT NULL,
	"zera_caixa" boolean NOT NULL,
	"usuario_anterior_id" uuid NOT NULL,
	"usuario_subsequente_id" uuid,
	"valor_caixa" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_calculado" numeric(15, 2) NOT NULL,
	"total_digitado" numeric(15, 2) NOT NULL,
	"diferenca" numeric(15, 2) GENERATED ALWAYS AS (total_digitado - total_calculado) STORED NOT NULL,
	"justificativa" varchar(255),
	"recontagem" boolean DEFAULT false NOT NULL,
	"fechamento_cego" boolean NOT NULL,
	"ocorrido_em" timestamp with time zone NOT NULL,
	"dia_operacional" date NOT NULL,
	"resumo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "pk_fechamentos_caixa" PRIMARY KEY("id"),
	CONSTRAINT "ck_fechamentos_caixa_tipo" CHECK (tipo in ('fechamento','troca_turno')),
	CONSTRAINT "ck_fechamentos_caixa_zera" CHECK (zera_caixa = (tipo = 'fechamento'))
);
--> statement-breakpoint
CREATE TABLE "fechamentos_caixa_formas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"fechamento_id" uuid NOT NULL,
	"forma_pagamento_id" uuid NOT NULL,
	"descricao_forma" varchar(40) NOT NULL,
	"tipo_forma" varchar(20) NOT NULL,
	"valor_calculado" numeric(15, 2) NOT NULL,
	"valor_digitado" numeric(15, 2) NOT NULL,
	"diferenca" numeric(15, 2) GENERATED ALWAYS AS (valor_digitado - valor_calculado) STORED NOT NULL,
	"quantidade_pagamentos" integer DEFAULT 0 NOT NULL,
	"preenchido_automatico" boolean DEFAULT false NOT NULL,
	"valor_primeira_contagem" numeric(15, 2),
	CONSTRAINT "pk_fechamentos_caixa_formas" PRIMARY KEY("id"),
	CONSTRAINT "ck_fechamentos_caixa_formas_quantidade" CHECK (quantidade_pagamentos >= 0)
);
--> statement-breakpoint
CREATE TABLE "movimentos_caixa" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"sessao_caixa_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"numero_caixa" smallint NOT NULL,
	"terminal_id" uuid NOT NULL,
	"tipo" varchar(18) NOT NULL,
	"forma_pagamento_id" uuid,
	"valor" numeric(15, 2) NOT NULL,
	"operador_id" uuid NOT NULL,
	"quem_retira_usuario_id" uuid,
	"quem_retira_nome" varchar(60),
	"observacao" varchar(255),
	"inf_adicionais" varchar(255),
	"ocorrido_em" timestamp with time zone NOT NULL,
	"autorizado_por_id" uuid,
	"troca_id" uuid,
	"cancelado" boolean DEFAULT false NOT NULL,
	"cancelado_em" timestamp with time zone,
	"cancelado_por_id" uuid,
	"autorizado_cancelamento_por_id" uuid,
	"motivo_cancelamento" varchar(255),
	"movimento_conta_corrente_id" uuid,
	CONSTRAINT "pk_movimentos_caixa" PRIMARY KEY("id"),
	CONSTRAINT "ck_movimentos_caixa_tipo" CHECK (tipo in ('abertura','reforco','sangria','sangria_fechamento','devolucao_troca','estorno_venda')),
	CONSTRAINT "ck_movimentos_caixa_valor" CHECK (valor > 0),
	CONSTRAINT "ck_movimentos_caixa_sangria" CHECK (tipo <> 'sangria' or quem_retira_usuario_id is not null or quem_retira_nome is not null),
	CONSTRAINT "ck_movimentos_caixa_estorno_forma" CHECK (tipo <> 'estorno_venda' or forma_pagamento_id is not null),
	CONSTRAINT "ck_movimentos_caixa_cancelado" CHECK (not cancelado or (cancelado_em is not null and motivo_cancelamento is not null))
);
--> statement-breakpoint
CREATE TABLE "movimentos_vasilhame" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"sessao_caixa_id" uuid NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"operador_id" uuid NOT NULL,
	"pessoa_id" uuid,
	"produto_vasilhame_id" uuid NOT NULL,
	"quantidade" numeric(15, 3) NOT NULL,
	"destino" varchar(14) NOT NULL,
	"vale_id" uuid,
	"ocorrido_em" timestamp with time zone NOT NULL,
	"cancelado" boolean DEFAULT false NOT NULL,
	"cancelado_em" timestamp with time zone,
	"cancelado_por_id" uuid,
	"motivo_cancelamento" varchar(255),
	CONSTRAINT "pk_movimentos_vasilhame" PRIMARY KEY("id"),
	CONSTRAINT "ck_movimentos_vasilhame_quantidade" CHECK (quantidade > 0),
	CONSTRAINT "ck_movimentos_vasilhame_destino" CHECK (destino in ('entrada','baixa_comodato','vale')),
	CONSTRAINT "ck_movimentos_vasilhame_comodato" CHECK (destino <> 'baixa_comodato' or pessoa_id is not null),
	CONSTRAINT "ck_movimentos_vasilhame_vale" CHECK ((destino = 'vale') = (vale_id is not null)),
	CONSTRAINT "ck_movimentos_vasilhame_cancelado" CHECK (not cancelado or (cancelado_em is not null and motivo_cancelamento is not null))
);
--> statement-breakpoint
CREATE TABLE "sessoes_caixa" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"numero_caixa" smallint NOT NULL,
	"terminal_id" uuid NOT NULL,
	"operador_id" uuid NOT NULL,
	"status" varchar(18) DEFAULT 'aberta' NOT NULL,
	"dia_operacional" date NOT NULL,
	"aberta_em" timestamp with time zone NOT NULL,
	"abertura_automatica" boolean DEFAULT false NOT NULL,
	"fundo_troco" numeric(15, 2) DEFAULT '0' NOT NULL,
	"sessao_anterior_id" uuid,
	"valor_recebido_anterior" numeric(15, 2),
	"diferenca_recebimento" numeric(15, 2),
	"fechada_em" timestamp with time zone,
	"fechamento_forcado" boolean DEFAULT false NOT NULL,
	"fechamento_forcado_motivo" varchar(30),
	CONSTRAINT "pk_sessoes_caixa" PRIMARY KEY("id"),
	CONSTRAINT "ck_sessoes_caixa_status" CHECK (status in ('aberta','bloqueada_sangria','em_fechamento','fechada')),
	CONSTRAINT "ck_sessoes_caixa_forcado" CHECK (not fechamento_forcado or (status = 'fechada' and fechamento_forcado_motivo is not null)),
	CONSTRAINT "ck_sessoes_caixa_forcado_motivo" CHECK (fechamento_forcado_motivo is null or fechamento_forcado_motivo in ('substituicao_terminal','revogacao_terminal'))
);
--> statement-breakpoint
CREATE TABLE "cobrancas_pix" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"txid" varchar(35) NOT NULL,
	"tipo" varchar(9) NOT NULL,
	"loja_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"venda_id" uuid,
	"pagamento_venda_id" uuid,
	"psp" varchar(30),
	"valor" numeric(15, 2) NOT NULL,
	"status" varchar(16) DEFAULT 'ativa' NOT NULL,
	"qrcode_payload" text NOT NULL,
	"expira_em" timestamp with time zone,
	"paga_em" timestamp with time zone,
	"e2e_id" varchar(32),
	"pagador_nome" varchar(60),
	"pagador_documento" varchar(14),
	"valor_devolvido" numeric(15, 2) DEFAULT '0' NOT NULL,
	"devolvida_em" timestamp with time zone,
	CONSTRAINT "pk_cobrancas_pix" PRIMARY KEY("id"),
	CONSTRAINT "ck_cobrancas_pix_tipo" CHECK (tipo in ('dinamico','estatico')),
	CONSTRAINT "ck_cobrancas_pix_status" CHECK (status in ('ativa','paga','expirada','cancelada','devolvida','paga_sem_venda'))
);
--> statement-breakpoint
CREATE TABLE "itens_venda" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"venda_id" uuid NOT NULL,
	"sequencia" integer NOT NULL,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"codigo_lido" varchar(30),
	"codigo_barras_id" uuid,
	"origem_entrada" varchar(8),
	"peso_digitado" boolean DEFAULT false NOT NULL,
	"descricao" varchar(120) NOT NULL,
	"unidade" varchar(6) NOT NULL,
	"quantidade" numeric(15, 3) NOT NULL,
	"preco_tabela" numeric(15, 4) NOT NULL,
	"preco_unitario" numeric(15, 4) NOT NULL,
	"origem_preco" varchar(12) DEFAULT 'varejo' NOT NULL,
	"grupo_preco_quantidade_id" uuid,
	"quantidade_referencia_preco" numeric(15, 3),
	"valor_bruto" numeric(15, 2) NOT NULL,
	"desconto_item" numeric(15, 2) DEFAULT '0' NOT NULL,
	"desconto_promocao" numeric(15, 2) DEFAULT '0' NOT NULL,
	"promocao_id" uuid,
	"desconto_rateado" numeric(15, 2) DEFAULT '0' NOT NULL,
	"acrescimo_rateado" numeric(15, 2) DEFAULT '0' NOT NULL,
	"frete_rateado" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_liquido" numeric(15, 2) NOT NULL,
	"lote_id" uuid,
	"lote" varchar(30),
	"validade_lote" date,
	"kit_grupo_id" uuid,
	"kit_produto_id" uuid,
	"kit_descricao" varchar(120),
	"kit_quantidade" numeric(15, 3),
	"kit_preco_unitario" numeric(15, 4),
	"kit_componente_id" uuid,
	"kit_alternativa_id" uuid,
	"kit_acrescimo" numeric(15, 4) DEFAULT '0' NOT NULL,
	"vasilhame_item_origem_id" uuid,
	"item_comanda_id" uuid,
	"item_orcamento_id" uuid,
	"vendedor_id" uuid,
	"comissao_pct" numeric(7, 4),
	"valor_comissao" numeric(15, 2),
	"custo_unitario" numeric(15, 4),
	"cfop" varchar(4),
	"ncm" varchar(8),
	"fiscal_snapshot" jsonb,
	"v_ibs" numeric(15, 2),
	"v_cbs" numeric(15, 2),
	"v_is" numeric(15, 2),
	"v_fcp" numeric(15, 2),
	"v_icms_st_ret" numeric(15, 2),
	"v_fcp_st_ret" numeric(15, 2),
	"quantidade_devolvida" numeric(15, 3) DEFAULT '0' NOT NULL,
	"cancelado" boolean DEFAULT false NOT NULL,
	"cancelado_em" timestamp with time zone,
	"cancelado_por_id" uuid,
	"autorizado_por_id" uuid,
	"motivo_cancelamento" varchar(255),
	"incluido_em" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_itens_venda" PRIMARY KEY("id"),
	CONSTRAINT "ck_itens_venda_quantidade" CHECK (quantidade > 0),
	CONSTRAINT "ck_itens_venda_valores" CHECK (valor_bruto >= 0 and desconto_item >= 0 and desconto_promocao >= 0 and desconto_rateado >= 0 and valor_liquido >= 0),
	CONSTRAINT "ck_itens_venda_promocao" CHECK (desconto_promocao = 0 or promocao_id is not null),
	CONSTRAINT "ck_itens_venda_devolvida" CHECK (quantidade_devolvida between 0 and quantidade),
	CONSTRAINT "ck_itens_venda_origem_preco" CHECK (origem_preco in ('varejo','loja','promocional','atacado','quantidade','grupo_mix','parcelado','manual','balanca','orcamento','kit_rateio','embalagem')),
	CONSTRAINT "ck_itens_venda_origem_entrada" CHECK (origem_entrada is null or origem_entrada in ('leitor','teclado','balanca','etiqueta','busca','cardapio')),
	CONSTRAINT "ck_itens_venda_kit" CHECK ((kit_grupo_id is null) = (kit_produto_id is null) and (kit_grupo_id is null) = (kit_componente_id is null) and (kit_grupo_id is null or (kit_quantidade > 0 and kit_preco_unitario >= 0 and kit_descricao is not null)) and (kit_alternativa_id is null or kit_grupo_id is not null) and kit_acrescimo >= 0)
);
--> statement-breakpoint
CREATE TABLE "itens_venda_complementos" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"item_venda_id" uuid NOT NULL,
	"complemento_id" uuid,
	"grupo_nome" varchar(40) NOT NULL,
	"descricao" varchar(60) NOT NULL,
	"quantidade" numeric(15, 3) DEFAULT '1' NOT NULL,
	"preco_adicional" numeric(15, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "pk_itens_venda_complementos" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "pagamentos_venda" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"venda_id" uuid NOT NULL,
	"sequencia" smallint NOT NULL,
	"forma_pagamento_id" uuid NOT NULL,
	"descricao_forma" varchar(40) NOT NULL,
	"meio_pagamento_fiscal" varchar(2) NOT NULL,
	"tipo_forma" varchar(20) NOT NULL,
	"valor" numeric(15, 2) NOT NULL,
	"valor_recebido" numeric(15, 2),
	"troco" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_taxa_servico" numeric(15, 2) DEFAULT '0' NOT NULL,
	"parcelas" smallint DEFAULT 1 NOT NULL,
	"status" varchar(10) DEFAULT 'aprovado' NOT NULL,
	"lanca_quitada" boolean NOT NULL,
	"taxa_pct" numeric(7, 4) DEFAULT '0' NOT NULL,
	"pessoa_id" uuid,
	"indicador_pagamento" smallint DEFAULT 0 NOT NULL,
	"data_pagamento" date,
	"cnpj_pagamento" varchar(14),
	"uf_pagamento" char(2),
	"tipo_integracao" smallint,
	"bandeira" varchar(2),
	"bandeira_nome" varchar(30),
	"adquirente" varchar(40),
	"cnpj_credenciadora" varchar(14),
	"nsu" varchar(20),
	"autorizacao" varchar(20),
	"cartao_mascarado" varchar(20),
	"cnpj_beneficiario" varchar(14),
	"id_terminal_pagamento" varchar(40),
	"tef_transacao_id" uuid,
	"pix_cobranca_id" uuid,
	"vale_id" uuid,
	"transferido_de_id" uuid,
	"autorizado_por_id" uuid,
	"conta_financeira_id" uuid,
	CONSTRAINT "pk_pagamentos_venda" PRIMARY KEY("id"),
	CONSTRAINT "ck_pagamentos_venda_valor" CHECK (valor > 0 and troco >= 0 and valor_taxa_servico between 0 and valor),
	CONSTRAINT "ck_pagamentos_venda_status" CHECK (status in ('pendente','aprovado','cancelado','estornado')),
	CONSTRAINT "ck_pagamentos_venda_parcelas" CHECK (parcelas >= 1),
	CONSTRAINT "ck_pagamentos_venda_tipo_integracao" CHECK (tipo_integracao is null or tipo_integracao in (1,2)),
	CONSTRAINT "ck_pagamentos_venda_indicador" CHECK (indicador_pagamento in (0,1)),
	CONSTRAINT "ck_pagamentos_venda_uf_pagamento" CHECK ((cnpj_pagamento is null) = (uf_pagamento is null))
);
--> statement-breakpoint
CREATE TABLE "parcelas_venda" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"pagamento_venda_id" uuid NOT NULL,
	"numero" smallint NOT NULL,
	"vencimento" date NOT NULL,
	"valor" numeric(15, 2) NOT NULL,
	CONSTRAINT "pk_parcelas_venda" PRIMARY KEY("id"),
	CONSTRAINT "ck_parcelas_venda_valor" CHECK (valor > 0)
);
--> statement-breakpoint
CREATE TABLE "transacoes_tef" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"loja_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"venda_id" uuid,
	"pagamento_venda_id" uuid,
	"provedor" varchar(10) NOT NULL,
	"operacao" varchar(14) DEFAULT 'venda' NOT NULL,
	"status" varchar(32) DEFAULT 'iniciada' NOT NULL,
	"valor" numeric(15, 2) NOT NULL,
	"parcelas" smallint DEFAULT 1 NOT NULL,
	"tipo_cartao" varchar(8),
	"bandeira" varchar(2),
	"bandeira_nome" varchar(30),
	"adquirente" varchar(40),
	"cnpj_credenciadora" varchar(14),
	"nsu" varchar(20),
	"nsu_host" varchar(20),
	"autorizacao" varchar(20),
	"codigo_resposta" varchar(10),
	"mensagem" varchar(255),
	"cartao_mascarado" varchar(20),
	"data_hora_transacao" timestamp with time zone,
	"comprovante_cliente" text,
	"comprovante_loja" text,
	"transacao_original_id" uuid,
	"iniciada_em" timestamp with time zone NOT NULL,
	"confirmada_em" timestamp with time zone,
	"desfeita_em" timestamp with time zone,
	"cancelada_em" timestamp with time zone,
	CONSTRAINT "pk_transacoes_tef" PRIMARY KEY("id"),
	CONSTRAINT "ck_transacoes_tef_status" CHECK (status in ('iniciada','negada','aprovada_pendente_confirmacao','confirmada','desfeita','cancelada')),
	CONSTRAINT "ck_transacoes_tef_operacao" CHECK (operacao in ('venda','cancelamento','administrativa'))
);
--> statement-breakpoint
CREATE TABLE "vendas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"criado_por_id" uuid,
	"atualizado_por_id" uuid,
	"numero" bigint NOT NULL,
	"numero_exibicao" varchar(20) NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"numero_caixa" smallint NOT NULL,
	"terminal_id" uuid,
	"sessao_caixa_id" uuid,
	"tipo" varchar(5) NOT NULL,
	"canal" varchar(15) DEFAULT 'pdv' NOT NULL,
	"modo" varchar(10) DEFAULT 'balcao' NOT NULL,
	"id_externo" varchar(60),
	"status" varchar(16) DEFAULT 'em_andamento' NOT NULL,
	"status_fiscal" varchar(22) DEFAULT 'nao_aplicavel' NOT NULL,
	"devolucao" varchar(8) DEFAULT 'nenhuma' NOT NULL,
	"dia_operacional" date,
	"operador_id" uuid NOT NULL,
	"vendedor_id" uuid,
	"cliente_id" uuid,
	"cpf_cnpj_nota" varchar(14),
	"nome_nota" varchar(60),
	"tipo_preco" varchar(10) DEFAULT 'varejo' NOT NULL,
	"orcamento_id" uuid,
	"comanda_id" uuid,
	"pedido_id" uuid,
	"qtd_itens" integer DEFAULT 0 NOT NULL,
	"subtotal_bruto" numeric(15, 2) DEFAULT '0' NOT NULL,
	"desconto_itens" numeric(15, 2) DEFAULT '0' NOT NULL,
	"desconto_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"desconto_total_pct" numeric(7, 4),
	"desconto_total_origem" varchar(9),
	"acrescimo_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxa_servico" numeric(15, 2) DEFAULT '0' NOT NULL,
	"taxa_entrega" numeric(15, 2) DEFAULT '0' NOT NULL,
	"valor_frete" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"troco" numeric(15, 2) DEFAULT '0' NOT NULL,
	"custo_total" numeric(15, 2),
	"endereco_entrega_id" uuid,
	"endereco_entrega" jsonb,
	"endereco_faturamento_id" uuid,
	"data_entrega" date,
	"observacao_nfe" text,
	"observacao" varchar(500),
	"frete_modalidade" char(1),
	"frete_tipo" varchar(30),
	"transportadora_id" uuid,
	"volumes" jsonb,
	"qtd_parcelas" smallint,
	"iniciada_em" timestamp with time zone NOT NULL,
	"finalizada_em" timestamp with time zone,
	"cancelada_em" timestamp with time zone,
	"cancelada_por_id" uuid,
	"cancelamento_autorizado_por_id" uuid,
	"motivo_cancelamento" varchar(255),
	"cancelamento_origem" varchar(4),
	"idade_confirmada_por_id" uuid,
	"idade_confirmada_em" timestamp with time zone,
	"evento_finalizacao_id" uuid,
	"relogio_confiavel" boolean DEFAULT true NOT NULL,
	CONSTRAINT "pk_vendas" PRIMARY KEY("id"),
	CONSTRAINT "ck_vendas_tipo" CHECK (tipo in ('pdv','venda')),
	CONSTRAINT "ck_vendas_canal" CHECK (canal in ('pdv','erp','ifood','99food','woocommerce','nuvemshop','menu_digital','totem')),
	CONSTRAINT "ck_vendas_modo" CHECK (modo in ('balcao','comanda','pedido','delivery')),
	CONSTRAINT "ck_vendas_status" CHECK (status in ('rascunho','em_andamento','em_pagamento','suspensa','pedido_pendente','finalizada','cancelada')),
	CONSTRAINT "ck_vendas_status_fiscal" CHECK (status_fiscal in ('nao_aplicavel','pendente','transmitindo','autorizada','contingencia','rejeitada','denegada','cancelamento_pendente','cancelada','inutilizada','nfe_solicitada')),
	CONSTRAINT "ck_vendas_devolucao" CHECK (devolucao in ('nenhuma','parcial','total')),
	CONSTRAINT "ck_vendas_tipo_preco" CHECK (tipo_preco in ('varejo','atacado','parcelado')),
	CONSTRAINT "ck_vendas_cancelamento_origem" CHECK (cancelamento_origem is null or cancelamento_origem in ('pdv','erp')),
	CONSTRAINT "ck_vendas_desconto_total_origem" CHECK (desconto_total_origem is null or desconto_total_origem in ('operador','cliente','orcamento')),
	CONSTRAINT "ck_vendas_valores" CHECK (subtotal_bruto >= 0 and desconto_itens >= 0 and desconto_total >= 0 and acrescimo_total >= 0 and taxa_servico >= 0 and taxa_entrega >= 0 and valor_frete >= 0 and total >= 0 and troco >= 0),
	CONSTRAINT "ck_vendas_finalizada" CHECK (status <> 'finalizada' or finalizada_em is not null),
	CONSTRAINT "ck_vendas_cpf_cnpj_nota" CHECK (cpf_cnpj_nota is null or cpf_cnpj_nota ~ '^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$'),
	CONSTRAINT "ck_vendas_cancelada" CHECK (status <> 'cancelada' or (cancelada_em is not null and motivo_cancelamento is not null)),
	CONSTRAINT "ck_vendas_idade_confirmada" CHECK ((idade_confirmada_por_id is null) = (idade_confirmada_em is null))
);
--> statement-breakpoint
ALTER TABLE "fechamentos_caixa" ADD CONSTRAINT "fk_fechamentos_caixa_sessao_caixa_id" FOREIGN KEY ("sessao_caixa_id") REFERENCES "public"."sessoes_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fechamentos_caixa" ADD CONSTRAINT "fk_fechamentos_caixa_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fechamentos_caixa" ADD CONSTRAINT "fk_fechamentos_caixa_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fechamentos_caixa" ADD CONSTRAINT "fk_fechamentos_caixa_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fechamentos_caixa" ADD CONSTRAINT "fk_fechamentos_caixa_usuario_anterior_id" FOREIGN KEY ("usuario_anterior_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fechamentos_caixa" ADD CONSTRAINT "fk_fechamentos_caixa_usuario_subsequente_id" FOREIGN KEY ("usuario_subsequente_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fechamentos_caixa_formas" ADD CONSTRAINT "fk_fechamentos_caixa_formas_fechamento_id" FOREIGN KEY ("fechamento_id") REFERENCES "public"."fechamentos_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fechamentos_caixa_formas" ADD CONSTRAINT "fk_fechamentos_caixa_formas_forma_pagamento_id" FOREIGN KEY ("forma_pagamento_id") REFERENCES "public"."formas_pagamento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_sessao_caixa_id" FOREIGN KEY ("sessao_caixa_id") REFERENCES "public"."sessoes_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_forma_pagamento_id" FOREIGN KEY ("forma_pagamento_id") REFERENCES "public"."formas_pagamento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_operador_id" FOREIGN KEY ("operador_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_quem_retira_usuario_id" FOREIGN KEY ("quem_retira_usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_autorizado_por_id" FOREIGN KEY ("autorizado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_cancelado_por_id" FOREIGN KEY ("cancelado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_caixa" ADD CONSTRAINT "fk_movimentos_caixa_autorizado_cancelamento_por_id" FOREIGN KEY ("autorizado_cancelamento_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vasilhame" ADD CONSTRAINT "fk_movimentos_vasilhame_sessao_caixa_id" FOREIGN KEY ("sessao_caixa_id") REFERENCES "public"."sessoes_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vasilhame" ADD CONSTRAINT "fk_movimentos_vasilhame_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vasilhame" ADD CONSTRAINT "fk_movimentos_vasilhame_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vasilhame" ADD CONSTRAINT "fk_movimentos_vasilhame_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vasilhame" ADD CONSTRAINT "fk_movimentos_vasilhame_operador_id" FOREIGN KEY ("operador_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vasilhame" ADD CONSTRAINT "fk_movimentos_vasilhame_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vasilhame" ADD CONSTRAINT "fk_movimentos_vasilhame_produto_vasilhame_id" FOREIGN KEY ("produto_vasilhame_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vasilhame" ADD CONSTRAINT "fk_movimentos_vasilhame_cancelado_por_id" FOREIGN KEY ("cancelado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes_caixa" ADD CONSTRAINT "fk_sessoes_caixa_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes_caixa" ADD CONSTRAINT "fk_sessoes_caixa_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes_caixa" ADD CONSTRAINT "fk_sessoes_caixa_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes_caixa" ADD CONSTRAINT "fk_sessoes_caixa_operador_id" FOREIGN KEY ("operador_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes_caixa" ADD CONSTRAINT "fk_sessoes_caixa_sessao_anterior_id" FOREIGN KEY ("sessao_anterior_id") REFERENCES "public"."sessoes_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobrancas_pix" ADD CONSTRAINT "fk_cobrancas_pix_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cobrancas_pix" ADD CONSTRAINT "fk_cobrancas_pix_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_venda_id" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_codigo_barras_id" FOREIGN KEY ("codigo_barras_id") REFERENCES "public"."produtos_codigos_barras"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_grupo_preco_quantidade_id" FOREIGN KEY ("grupo_preco_quantidade_id") REFERENCES "public"."grupos_preco_quantidade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_lote_id" FOREIGN KEY ("lote_id") REFERENCES "public"."produtos_lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_kit_produto_id" FOREIGN KEY ("kit_produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_kit_componente_id" FOREIGN KEY ("kit_componente_id") REFERENCES "public"."produtos_componentes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_kit_alternativa_id" FOREIGN KEY ("kit_alternativa_id") REFERENCES "public"."produtos_componentes_alternativas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_vasilhame_item_origem_id" FOREIGN KEY ("vasilhame_item_origem_id") REFERENCES "public"."itens_venda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_vendedor_id" FOREIGN KEY ("vendedor_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_cancelado_por_id" FOREIGN KEY ("cancelado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda" ADD CONSTRAINT "fk_itens_venda_autorizado_por_id" FOREIGN KEY ("autorizado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_venda_complementos" ADD CONSTRAINT "fk_itens_venda_complementos_item_venda_id" FOREIGN KEY ("item_venda_id") REFERENCES "public"."itens_venda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_venda" ADD CONSTRAINT "fk_pagamentos_venda_venda_id" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_venda" ADD CONSTRAINT "fk_pagamentos_venda_forma_pagamento_id" FOREIGN KEY ("forma_pagamento_id") REFERENCES "public"."formas_pagamento"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_venda" ADD CONSTRAINT "fk_pagamentos_venda_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_venda" ADD CONSTRAINT "fk_pagamentos_venda_tef_transacao_id" FOREIGN KEY ("tef_transacao_id") REFERENCES "public"."transacoes_tef"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_venda" ADD CONSTRAINT "fk_pagamentos_venda_pix_cobranca_id" FOREIGN KEY ("pix_cobranca_id") REFERENCES "public"."cobrancas_pix"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_venda" ADD CONSTRAINT "fk_pagamentos_venda_transferido_de_id" FOREIGN KEY ("transferido_de_id") REFERENCES "public"."pagamentos_venda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_venda" ADD CONSTRAINT "fk_pagamentos_venda_autorizado_por_id" FOREIGN KEY ("autorizado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcelas_venda" ADD CONSTRAINT "fk_parcelas_venda_pagamento_venda_id" FOREIGN KEY ("pagamento_venda_id") REFERENCES "public"."pagamentos_venda"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacoes_tef" ADD CONSTRAINT "fk_transacoes_tef_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacoes_tef" ADD CONSTRAINT "fk_transacoes_tef_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transacoes_tef" ADD CONSTRAINT "fk_transacoes_tef_transacao_original_id" FOREIGN KEY ("transacao_original_id") REFERENCES "public"."transacoes_tef"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_sessao_caixa_id" FOREIGN KEY ("sessao_caixa_id") REFERENCES "public"."sessoes_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_operador_id" FOREIGN KEY ("operador_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_vendedor_id" FOREIGN KEY ("vendedor_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_cliente_id" FOREIGN KEY ("cliente_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_endereco_entrega_id" FOREIGN KEY ("endereco_entrega_id") REFERENCES "public"."pessoas_enderecos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_endereco_faturamento_id" FOREIGN KEY ("endereco_faturamento_id") REFERENCES "public"."pessoas_enderecos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_transportadora_id" FOREIGN KEY ("transportadora_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_cancelada_por_id" FOREIGN KEY ("cancelada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_cancelamento_autorizado_por_id" FOREIGN KEY ("cancelamento_autorizado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "fk_vendas_idade_confirmada_por_id" FOREIGN KEY ("idade_confirmada_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fechamentos_caixa_sessao_caixa_id" ON "fechamentos_caixa" USING btree ("sessao_caixa_id");--> statement-breakpoint
CREATE INDEX "ix_fechamentos_caixa_loja_dia" ON "fechamentos_caixa" USING btree ("loja_id","dia_operacional");--> statement-breakpoint
CREATE INDEX "ix_fechamentos_caixa_caixa_id" ON "fechamentos_caixa" USING btree ("caixa_id");--> statement-breakpoint
CREATE INDEX "ix_fechamentos_caixa_terminal_id" ON "fechamentos_caixa" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_fechamentos_caixa_usuario_anterior_id" ON "fechamentos_caixa" USING btree ("usuario_anterior_id");--> statement-breakpoint
CREATE INDEX "ix_fechamentos_caixa_usuario_subsequente_id" ON "fechamentos_caixa" USING btree ("usuario_subsequente_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fechamentos_caixa_formas" ON "fechamentos_caixa_formas" USING btree ("fechamento_id","forma_pagamento_id");--> statement-breakpoint
CREATE INDEX "ix_fechamentos_caixa_formas_forma_pagamento_id" ON "fechamentos_caixa_formas" USING btree ("forma_pagamento_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_sessao_caixa_id" ON "movimentos_caixa" USING btree ("sessao_caixa_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_loja_ocorrido" ON "movimentos_caixa" USING btree ("loja_id","ocorrido_em");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_caixa_id" ON "movimentos_caixa" USING btree ("caixa_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_terminal_id" ON "movimentos_caixa" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_forma_pagamento_id" ON "movimentos_caixa" USING btree ("forma_pagamento_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_operador_id" ON "movimentos_caixa" USING btree ("operador_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_quem_retira_usuario_id" ON "movimentos_caixa" USING btree ("quem_retira_usuario_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_autorizado_por_id" ON "movimentos_caixa" USING btree ("autorizado_por_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_cancelado_por_id" ON "movimentos_caixa" USING btree ("cancelado_por_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_caixa_autorizado_cancelamento_por_id" ON "movimentos_caixa" USING btree ("autorizado_cancelamento_por_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vasilhame_sessao_caixa_id" ON "movimentos_vasilhame" USING btree ("sessao_caixa_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vasilhame_pessoa_id" ON "movimentos_vasilhame" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vasilhame_loja_ocorrido" ON "movimentos_vasilhame" USING btree ("loja_id","ocorrido_em");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vasilhame_caixa_id" ON "movimentos_vasilhame" USING btree ("caixa_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vasilhame_terminal_id" ON "movimentos_vasilhame" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vasilhame_operador_id" ON "movimentos_vasilhame" USING btree ("operador_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vasilhame_produto_vasilhame_id" ON "movimentos_vasilhame" USING btree ("produto_vasilhame_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vasilhame_cancelado_por_id" ON "movimentos_vasilhame" USING btree ("cancelado_por_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sessoes_caixa_aberta" ON "sessoes_caixa" USING btree ("terminal_id") WHERE status <> 'fechada' and excluido_em is null;--> statement-breakpoint
CREATE INDEX "ix_sessoes_caixa_terminal_id" ON "sessoes_caixa" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_sessoes_caixa_caixa_id_status" ON "sessoes_caixa" USING btree ("caixa_id","status");--> statement-breakpoint
CREATE INDEX "ix_sessoes_caixa_loja_dia" ON "sessoes_caixa" USING btree ("loja_id","dia_operacional");--> statement-breakpoint
CREATE INDEX "ix_sessoes_caixa_operador_id" ON "sessoes_caixa" USING btree ("operador_id");--> statement-breakpoint
CREATE INDEX "ix_sessoes_caixa_sessao_anterior_id" ON "sessoes_caixa" USING btree ("sessao_anterior_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cobrancas_pix_txid" ON "cobrancas_pix" USING btree ("txid") WHERE tipo = 'dinamico';--> statement-breakpoint
CREATE INDEX "ix_cobrancas_pix_txid" ON "cobrancas_pix" USING btree ("txid");--> statement-breakpoint
CREATE INDEX "ix_cobrancas_pix_venda_id" ON "cobrancas_pix" USING btree ("venda_id");--> statement-breakpoint
CREATE INDEX "ix_cobrancas_pix_loja_id" ON "cobrancas_pix" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_cobrancas_pix_terminal_id" ON "cobrancas_pix" USING btree ("terminal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_itens_venda_sequencia" ON "itens_venda" USING btree ("venda_id","sequencia");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_produto_id" ON "itens_venda" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_kit_grupo_id" ON "itens_venda" USING btree ("kit_grupo_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_variacao_id" ON "itens_venda" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_codigo_barras_id" ON "itens_venda" USING btree ("codigo_barras_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_grupo_preco_quantidade_id" ON "itens_venda" USING btree ("grupo_preco_quantidade_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_lote_id" ON "itens_venda" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_kit_produto_id" ON "itens_venda" USING btree ("kit_produto_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_kit_componente_id" ON "itens_venda" USING btree ("kit_componente_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_kit_alternativa_id" ON "itens_venda" USING btree ("kit_alternativa_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_vasilhame_item_origem_id" ON "itens_venda" USING btree ("vasilhame_item_origem_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_vendedor_id" ON "itens_venda" USING btree ("vendedor_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_cancelado_por_id" ON "itens_venda" USING btree ("cancelado_por_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_autorizado_por_id" ON "itens_venda" USING btree ("autorizado_por_id");--> statement-breakpoint
CREATE INDEX "ix_itens_venda_complementos_item_venda_id" ON "itens_venda_complementos" USING btree ("item_venda_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pagamentos_venda_sequencia" ON "pagamentos_venda" USING btree ("venda_id","sequencia");--> statement-breakpoint
CREATE INDEX "ix_pagamentos_venda_forma_pagamento_id" ON "pagamentos_venda" USING btree ("forma_pagamento_id");--> statement-breakpoint
CREATE INDEX "ix_pagamentos_venda_nsu" ON "pagamentos_venda" USING btree ("nsu");--> statement-breakpoint
CREATE INDEX "ix_pagamentos_venda_pessoa_id" ON "pagamentos_venda" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "ix_pagamentos_venda_tef_transacao_id" ON "pagamentos_venda" USING btree ("tef_transacao_id");--> statement-breakpoint
CREATE INDEX "ix_pagamentos_venda_pix_cobranca_id" ON "pagamentos_venda" USING btree ("pix_cobranca_id");--> statement-breakpoint
CREATE INDEX "ix_pagamentos_venda_transferido_de_id" ON "pagamentos_venda" USING btree ("transferido_de_id");--> statement-breakpoint
CREATE INDEX "ix_pagamentos_venda_autorizado_por_id" ON "pagamentos_venda" USING btree ("autorizado_por_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_parcelas_venda" ON "parcelas_venda" USING btree ("pagamento_venda_id","numero");--> statement-breakpoint
CREATE INDEX "ix_transacoes_tef_venda_id" ON "transacoes_tef" USING btree ("venda_id");--> statement-breakpoint
CREATE INDEX "ix_transacoes_tef_nsu" ON "transacoes_tef" USING btree ("nsu");--> statement-breakpoint
CREATE INDEX "ix_transacoes_tef_loja_id" ON "transacoes_tef" USING btree ("loja_id");--> statement-breakpoint
CREATE INDEX "ix_transacoes_tef_terminal_id" ON "transacoes_tef" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_transacoes_tef_transacao_original_id" ON "transacoes_tef" USING btree ("transacao_original_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_vendas_numero" ON "vendas" USING btree ("loja_id","numero_caixa","numero");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_vendas_canal_id_externo" ON "vendas" USING btree ("canal","id_externo") WHERE id_externo is not null;--> statement-breakpoint
CREATE INDEX "ix_vendas_loja_finalizada" ON "vendas" USING btree ("loja_id","finalizada_em");--> statement-breakpoint
CREATE INDEX "ix_vendas_dia_operacional" ON "vendas" USING btree ("loja_id","dia_operacional");--> statement-breakpoint
CREATE INDEX "ix_vendas_caixa_id" ON "vendas" USING btree ("caixa_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_terminal_id" ON "vendas" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_sessao_caixa_id" ON "vendas" USING btree ("sessao_caixa_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_operador_id" ON "vendas" USING btree ("operador_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_vendedor_id" ON "vendas" USING btree ("vendedor_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_cliente_id" ON "vendas" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_endereco_entrega_id" ON "vendas" USING btree ("endereco_entrega_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_endereco_faturamento_id" ON "vendas" USING btree ("endereco_faturamento_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_transportadora_id" ON "vendas" USING btree ("transportadora_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_cancelada_por_id" ON "vendas" USING btree ("cancelada_por_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_cancelamento_autorizado_por_id" ON "vendas" USING btree ("cancelamento_autorizado_por_id");--> statement-breakpoint
CREATE INDEX "ix_vendas_idade_confirmada_por_id" ON "vendas" USING btree ("idade_confirmada_por_id");--> statement-breakpoint
-- Objetos que o drizzle-kit não gera (MD 1.3, 1.5, 1.6): triggers de versão (nenhum fluxo do pull lê estas tabelas
-- nesta fase: fn_versao_local; `cobrancas_pix` é ↕ e troca para fn_versao no bloco que criar o fluxo `operacao` do PIX
-- dinâmico, Fase 6), FKs de autoria de `vendas`, filtro imutável de `cobrancas_pix` e imutabilidade dos documentos.
-- fn_versao_local passa a aceitar, como a fn_versao da 0011, colunas que não contam na comparação do UPDATE sem
-- mudança real. Aqui são as colunas geradas (`diferenca` dos fechamentos): no trigger BEFORE o NEW de uma coluna
-- `generated ... stored` chega nulo e o OLD traz o valor, então sem a isenção todo UPDATE (inclusive a reaplicação do
-- `caixa.fechado` e o `usuario_subsequente_id` repetido, SYNC 9.3) gerava versão nova. A coluna gerada só muda junto
-- das colunas de que deriva, que continuam na comparação. Sem argumentos o comportamento é o da 0000.
create or replace function fn_versao_local() returns trigger language plpgsql as $$
declare
  -- tg_argv é nulo quando o trigger não tem argumentos (e `jsonb - null` daria nulo, versionando tudo)
  isentas text[] := coalesce(tg_argv, '{}'::text[]);
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'versao' - 'atualizado_em' - isentas) = (to_jsonb(old) - 'versao' - 'atualizado_em' - isentas) then
      new.versao := old.versao; new.atualizado_em := old.atualizado_em; return new;
    end if;
    new.criado_em := old.criado_em;
    new.atualizado_em := now();
  end if;
  new.versao := nextval('seq_versao');
  return new;
end $$;
--> statement-breakpoint
create trigger tg_vendas_versao before insert or update on vendas
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_itens_venda_versao before insert or update on itens_venda
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_itens_venda_complementos_versao before insert or update on itens_venda_complementos
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_pagamentos_venda_versao before insert or update on pagamentos_venda
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_parcelas_venda_versao before insert or update on parcelas_venda
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_transacoes_tef_versao before insert or update on transacoes_tef
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_cobrancas_pix_versao before insert or update on cobrancas_pix
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_sessoes_caixa_versao before insert or update on sessoes_caixa
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_movimentos_caixa_versao before insert or update on movimentos_caixa
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_fechamentos_caixa_versao before insert or update on fechamentos_caixa
  for each row execute function fn_versao_local('diferenca');
--> statement-breakpoint
create trigger tg_fechamentos_caixa_formas_versao before insert or update on fechamentos_caixa_formas
  for each row execute function fn_versao_local('diferenca');
--> statement-breakpoint
create trigger tg_movimentos_vasilhame_versao before insert or update on movimentos_vasilhame
  for each row execute function fn_versao_local();
--> statement-breakpoint
-- MD 6.4 regra 2 (SYNC M7): `cobrancas_pix.terminal_id` é coluna de filtro do fluxo `operacao` (MD 6.3).
create trigger tg_cobrancas_pix_filtro_imutavel before update on cobrancas_pix
  for each row execute function fn_filtro_imutavel('terminal_id');
--> statement-breakpoint
alter table vendas add constraint fk_vendas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_vendas_criado_por_id on vendas (criado_por_id);
--> statement-breakpoint
alter table vendas add constraint fk_vendas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_vendas_atualizado_por_id on vendas (atualizado_por_id);
--> statement-breakpoint
-- MD 3.11.2: depois de `finalizada` (ou `cancelada`) só mudam o estado, o fiscal, a devolução, o custo (nuvem) e as
-- colunas de cancelamento (forma A, SYNC 9.9). Os estados abertos são os de STATUS_VENDA_ABERTOS (schema/vendas.ts;
-- o teste `vendas-schema` confere o argumento do trigger contra a constante).
create trigger tg_vendas_imutavel before update on vendas
  for each row execute function fn_protege_imutavel('status', 'rascunho,em_andamento,em_pagamento,suspensa,pedido_pendente',
    'status,status_fiscal,devolucao,custo_total,cancelada_em,cancelada_por_id,cancelamento_autorizado_por_id,motivo_cancelamento,cancelamento_origem,versao,atualizado_em,atualizado_por_id');
--> statement-breakpoint
-- O tg_vendas_imutavel olha só o estado do OLD e deixa `status` e as colunas de cancelamento livres: sozinho, ele
-- deixaria a venda voltar a um estado aberto (e ser editada à vontade no UPDATE seguinte) ou ser "descancelada". Aqui
-- vale a máquina de estados do documento fechado: `finalizada` só fica `finalizada` (sem tocar no cancelamento) ou vai
-- a `cancelada`; `cancelada` é terminal e as colunas do cancelamento não mudam mais. Os estados abertos seguem livres.
create or replace function fn_vendas_transicao() returns trigger language plpgsql as $$
begin
  if old.status = 'finalizada' and new.status = 'cancelada' then
    return new;
  end if;
  if old.status in ('finalizada', 'cancelada')
     and (new.status is distinct from old.status
          or new.cancelada_em is distinct from old.cancelada_em
          or new.cancelada_por_id is distinct from old.cancelada_por_id
          or new.cancelamento_autorizado_por_id is distinct from old.cancelamento_autorizado_por_id
          or new.motivo_cancelamento is distinct from old.motivo_cancelamento
          or new.cancelamento_origem is distinct from old.cancelamento_origem) then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL',
      detail = format('vendas.status: %s → %s', old.status, new.status);
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_vendas_transicao before update on vendas
  for each row execute function fn_vendas_transicao();
--> statement-breakpoint
-- MD 1.6 e 3.12.2: movimento de caixa só muda pelo cancelamento (`caixa.movimento_cancelado`, SYNC 9.5).
create trigger tg_movimentos_caixa_imutavel before update on movimentos_caixa
  for each row execute function fn_protege_imutavel('', '',
    'cancelado,cancelado_em,cancelado_por_id,autorizado_cancelamento_por_id,motivo_cancelamento,versao,atualizado_em');
--> statement-breakpoint
-- MD 3.12.6: idem para a devolução avulsa de cascos (sem evento de cancelamento nesta versão; colunas por uniformidade).
create trigger tg_movimentos_vasilhame_imutavel before update on movimentos_vasilhame
  for each row execute function fn_protege_imutavel('', '',
    'cancelado,cancelado_em,cancelado_por_id,motivo_cancelamento,versao,atualizado_em');
