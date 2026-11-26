-- Esquema da nuvem 1 da Fase 3 (F3-B1; MD 3.13, 3.11.3; SYNC 9.16, 9.17, 14.4, 20.4; README da API › decisão 220):
-- as tabelas do dinheiro que muda de mão (trocas e vales, com as reservas de saldo dos caixas online) e o registro das
-- requisições online que alteram estado. Só o esquema: os eventos `troca.registrada` e `vale.*`, as reservas, as
-- consultas e a idempotência vêm nos F3-B6 e B41 a B45, e o fluxo que leva `vales` ao caixa, no F3-B7.
--
-- Compatibilidade: nenhuma tabela nova está num fluxo do pull nem em `TABELAS_MOVIMENTO_PDV`, então o `Esquema.g.cs`
-- não muda e o PDV instalado (0.10.0 a 0.13.0) não vê diferença. Nenhuma coluna nova nas tabelas de movimento do PDV
-- e nenhuma FK nova nas colunas que ele envia (`pagamentos_venda.vale_id`, `movimentos_caixa.troca_id`,
-- `movimentos_vasilhame.vale_id` continuam sem FK): a ordem entre terminais não é garantida e um 23503 recusaria um
-- fato consumado. Nenhum dado existente muda; o diagnóstico das colunas já preenchidas (vale, orçamento, promoção),
-- que deveria dar zero, é a preparação desta migração (`preparacoes-empresa.ts`), só de leitura e fora da transação.
--
-- A sequência do `codigo` da troca vem antes das tabelas (o default usa nextval).
create sequence if not exists seq_codigo_trocas as integer start 1 cache 1 no cycle;
--> statement-breakpoint
CREATE TABLE "itens_troca" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"troca_id" uuid NOT NULL,
	"sequencia" integer NOT NULL,
	"item_venda_origem_id" uuid,
	"produto_id" uuid NOT NULL,
	"variacao_id" uuid,
	"lote_id" uuid,
	"quantidade" numeric(15, 3) NOT NULL,
	"valor_unitario" numeric(15, 4) NOT NULL,
	"valor_total" numeric(15, 2) NOT NULL,
	"destino" varchar(8) NOT NULL,
	"motivo" varchar(255),
	CONSTRAINT "pk_itens_troca" PRIMARY KEY("id"),
	CONSTRAINT "ck_itens_troca_quantidade" CHECK (quantidade > 0),
	CONSTRAINT "ck_itens_troca_valores" CHECK (valor_unitario >= 0 and valor_total >= 0),
	CONSTRAINT "ck_itens_troca_destino" CHECK (destino in ('estoque','avaria'))
);
--> statement-breakpoint
CREATE TABLE "movimentos_vale" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"vale_id" uuid NOT NULL,
	"tipo" varchar(20) NOT NULL,
	"valor" numeric(15, 2) NOT NULL,
	"venda_id" uuid,
	"pagamento_venda_id" uuid,
	"troca_id" uuid,
	"terminal_id" uuid,
	"usuario_id" uuid,
	"ocorrido_em" timestamp with time zone NOT NULL,
	"evento_id" uuid,
	CONSTRAINT "pk_movimentos_vale" PRIMARY KEY("id"),
	CONSTRAINT "ck_movimentos_vale_tipo" CHECK (tipo in ('emissao','utilizacao','estorno_utilizacao','cancelamento','expiracao','ajuste')),
	CONSTRAINT "ck_movimentos_vale_valor" CHECK (valor <> 0),
	CONSTRAINT "ck_movimentos_vale_sinal" CHECK ((tipo not in ('emissao','estorno_utilizacao') or valor > 0) and (tipo <> 'utilizacao' or valor < 0))
);
--> statement-breakpoint
CREATE TABLE "requisicoes_terminal" (
	"terminal_id" uuid NOT NULL,
	"requisicao_id" uuid NOT NULL,
	"endpoint" varchar(80) NOT NULL,
	"corpo_sha256" varchar(64),
	"status_http" smallint,
	"resposta" jsonb,
	"criada_em" timestamp with time zone DEFAULT now() NOT NULL,
	"concluida_em" timestamp with time zone,
	CONSTRAINT "pk_requisicoes_terminal" PRIMARY KEY("terminal_id","requisicao_id"),
	CONSTRAINT "ck_requisicoes_terminal_status_http" CHECK (status_http is null or status_http between 100 and 599),
	CONSTRAINT "ck_requisicoes_terminal_concluida" CHECK ((concluida_em is null) = (status_http is null))
);
--> statement-breakpoint
CREATE TABLE "reservas_vale" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"vale_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"venda_id" uuid NOT NULL,
	"pagamento_venda_id" uuid NOT NULL,
	"valor" numeric(15, 2) NOT NULL,
	"status" varchar(10) DEFAULT 'ativa' NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"em_uso_desde" timestamp with time zone,
	"consumida_em" timestamp with time zone,
	"liberada_em" timestamp with time zone,
	CONSTRAINT "pk_reservas_vale" PRIMARY KEY("id"),
	CONSTRAINT "ck_reservas_vale_status" CHECK (status in ('ativa','consumida','liberada','expirada')),
	CONSTRAINT "ck_reservas_vale_valor" CHECK (valor > 0)
);
--> statement-breakpoint
CREATE TABLE "trocas" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"codigo" integer DEFAULT nextval('seq_codigo_trocas'),
	"origem" varchar(4) DEFAULT 'pdv' NOT NULL,
	"loja_id" uuid NOT NULL,
	"caixa_id" uuid NOT NULL,
	"terminal_id" uuid,
	"sessao_caixa_id" uuid,
	"numero_caixa" smallint NOT NULL,
	"venda_origem_id" uuid,
	"sem_venda_origem" boolean DEFAULT false NOT NULL,
	"cliente_id" uuid,
	"operador_id" uuid NOT NULL,
	"autorizado_por_id" uuid,
	"motivo" varchar(255) NOT NULL,
	"resolucao" varchar(14) NOT NULL,
	"valor_total" numeric(15, 2) NOT NULL,
	"vale_id" uuid,
	"venda_nova_id" uuid,
	"movimento_caixa_id" uuid,
	"documento_fiscal_id" uuid,
	"ocorrida_em" timestamp with time zone NOT NULL,
	"status" varchar(10) DEFAULT 'registrada' NOT NULL,
	"cancelada_em" timestamp with time zone,
	"motivo_cancelamento" varchar(255),
	CONSTRAINT "pk_trocas" PRIMARY KEY("id"),
	CONSTRAINT "ck_trocas_origem" CHECK (origem in ('pdv','erp')),
	CONSTRAINT "ck_trocas_resolucao" CHECK (resolucao in ('troca_imediata','vale_troca','dinheiro')),
	CONSTRAINT "ck_trocas_status" CHECK (status in ('registrada','cancelada')),
	CONSTRAINT "ck_trocas_venda_origem" CHECK (venda_origem_id is not null or sem_venda_origem),
	CONSTRAINT "ck_trocas_pdv" CHECK (origem = 'erp' or (terminal_id is not null and sessao_caixa_id is not null)),
	CONSTRAINT "ck_trocas_erp" CHECK (origem = 'pdv' or (venda_origem_id is not null and resolucao <> 'troca_imediata')),
	CONSTRAINT "ck_trocas_valor" CHECK (valor_total >= 0),
	CONSTRAINT "ck_trocas_cancelada" CHECK (status <> 'cancelada' or cancelada_em is not null)
);
--> statement-breakpoint
CREATE TABLE "vales" (
	"id" uuid DEFAULT fn_uuid_v7() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	"versao" bigint NOT NULL,
	"codigo" varchar(14) NOT NULL,
	"tipo" varchar(11) NOT NULL,
	"pessoa_id" uuid,
	"loja_emissao_id" uuid NOT NULL,
	"terminal_emissao_id" uuid,
	"valor_original" numeric(15, 2) NOT NULL,
	"saldo" numeric(15, 2) NOT NULL,
	"validade" date NOT NULL,
	"status" varchar(10) DEFAULT 'ativo' NOT NULL,
	"origem_tipo" varchar(8) NOT NULL,
	"origem_id" uuid,
	"conferencia_hash" varchar(100),
	"emitido_em" timestamp with time zone NOT NULL,
	"emitido_por_id" uuid NOT NULL,
	"cancelado_em" timestamp with time zone,
	"cancelado_por_id" uuid,
	"motivo_cancelamento" varchar(255),
	CONSTRAINT "pk_vales" PRIMARY KEY("id"),
	CONSTRAINT "ck_vales_codigo" CHECK (codigo ~ '^VC[0-9]{12}$'),
	CONSTRAINT "ck_vales_tipo" CHECK (tipo in ('vale_troca','vale_compra')),
	CONSTRAINT "ck_vales_status" CHECK (status in ('ativo','utilizado','expirado','cancelado')),
	CONSTRAINT "ck_vales_origem_tipo" CHECK (origem_tipo in ('troca','manual','venda')),
	CONSTRAINT "ck_vales_valor_original" CHECK (valor_original > 0),
	CONSTRAINT "ck_vales_cancelado" CHECK (status <> 'cancelado' or cancelado_em is not null)
);
--> statement-breakpoint
ALTER TABLE "itens_troca" ADD CONSTRAINT "fk_itens_troca_troca_id" FOREIGN KEY ("troca_id") REFERENCES "public"."trocas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_troca" ADD CONSTRAINT "fk_itens_troca_produto_id" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_troca" ADD CONSTRAINT "fk_itens_troca_variacao_id" FOREIGN KEY ("variacao_id") REFERENCES "public"."produtos_variacoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_troca" ADD CONSTRAINT "fk_itens_troca_lote_id" FOREIGN KEY ("lote_id") REFERENCES "public"."produtos_lotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vale" ADD CONSTRAINT "fk_movimentos_vale_vale_id" FOREIGN KEY ("vale_id") REFERENCES "public"."vales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vale" ADD CONSTRAINT "fk_movimentos_vale_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimentos_vale" ADD CONSTRAINT "fk_movimentos_vale_usuario_id" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisicoes_terminal" ADD CONSTRAINT "fk_requisicoes_terminal_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservas_vale" ADD CONSTRAINT "fk_reservas_vale_vale_id" FOREIGN KEY ("vale_id") REFERENCES "public"."vales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservas_vale" ADD CONSTRAINT "fk_reservas_vale_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_loja_id" FOREIGN KEY ("loja_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_caixa_id" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_terminal_id" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_sessao_caixa_id" FOREIGN KEY ("sessao_caixa_id") REFERENCES "public"."sessoes_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_cliente_id" FOREIGN KEY ("cliente_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_operador_id" FOREIGN KEY ("operador_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_autorizado_por_id" FOREIGN KEY ("autorizado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_vale_id" FOREIGN KEY ("vale_id") REFERENCES "public"."vales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_venda_nova_id" FOREIGN KEY ("venda_nova_id") REFERENCES "public"."vendas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trocas" ADD CONSTRAINT "fk_trocas_movimento_caixa_id" FOREIGN KEY ("movimento_caixa_id") REFERENCES "public"."movimentos_caixa"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vales" ADD CONSTRAINT "fk_vales_pessoa_id" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vales" ADD CONSTRAINT "fk_vales_loja_emissao_id" FOREIGN KEY ("loja_emissao_id") REFERENCES "public"."lojas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vales" ADD CONSTRAINT "fk_vales_terminal_emissao_id" FOREIGN KEY ("terminal_emissao_id") REFERENCES "public"."terminais"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vales" ADD CONSTRAINT "fk_vales_emitido_por_id" FOREIGN KEY ("emitido_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vales" ADD CONSTRAINT "fk_vales_cancelado_por_id" FOREIGN KEY ("cancelado_por_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_itens_troca_sequencia" ON "itens_troca" USING btree ("troca_id","sequencia");--> statement-breakpoint
CREATE INDEX "ix_itens_troca_item_venda_origem_id" ON "itens_troca" USING btree ("item_venda_origem_id");--> statement-breakpoint
CREATE INDEX "ix_itens_troca_produto_id" ON "itens_troca" USING btree ("produto_id");--> statement-breakpoint
CREATE INDEX "ix_itens_troca_variacao_id" ON "itens_troca" USING btree ("variacao_id");--> statement-breakpoint
CREATE INDEX "ix_itens_troca_lote_id" ON "itens_troca" USING btree ("lote_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vale_vale_id" ON "movimentos_vale" USING btree ("vale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_movimentos_vale_pagamento" ON "movimentos_vale" USING btree ("pagamento_venda_id","tipo") WHERE pagamento_venda_id is not null;--> statement-breakpoint
CREATE INDEX "ix_movimentos_vale_venda_id" ON "movimentos_vale" USING btree ("venda_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vale_troca_id" ON "movimentos_vale" USING btree ("troca_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vale_terminal_id" ON "movimentos_vale" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_movimentos_vale_usuario_id" ON "movimentos_vale" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "ix_requisicoes_terminal_criada_em" ON "requisicoes_terminal" USING btree ("criada_em");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_reservas_vale_pagamento" ON "reservas_vale" USING btree ("pagamento_venda_id");--> statement-breakpoint
CREATE INDEX "ix_reservas_vale_vale_id_status" ON "reservas_vale" USING btree ("vale_id","status");--> statement-breakpoint
CREATE INDEX "ix_reservas_vale_terminal_id" ON "reservas_vale" USING btree ("terminal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_trocas_codigo" ON "trocas" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "ix_trocas_venda_origem_id" ON "trocas" USING btree ("venda_origem_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_loja_ocorrida" ON "trocas" USING btree ("loja_id","ocorrida_em");--> statement-breakpoint
CREATE INDEX "ix_trocas_caixa_id" ON "trocas" USING btree ("caixa_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_terminal_id" ON "trocas" USING btree ("terminal_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_sessao_caixa_id" ON "trocas" USING btree ("sessao_caixa_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_cliente_id" ON "trocas" USING btree ("cliente_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_operador_id" ON "trocas" USING btree ("operador_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_autorizado_por_id" ON "trocas" USING btree ("autorizado_por_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_vale_id" ON "trocas" USING btree ("vale_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_venda_nova_id" ON "trocas" USING btree ("venda_nova_id");--> statement-breakpoint
CREATE INDEX "ix_trocas_movimento_caixa_id" ON "trocas" USING btree ("movimento_caixa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_vales_codigo" ON "vales" USING btree ("codigo");--> statement-breakpoint
CREATE INDEX "ix_vales_pessoa_id" ON "vales" USING btree ("pessoa_id");--> statement-breakpoint
CREATE INDEX "ix_vales_loja_emissao_id" ON "vales" USING btree ("loja_emissao_id");--> statement-breakpoint
CREATE INDEX "ix_vales_terminal_emissao_id" ON "vales" USING btree ("terminal_emissao_id");--> statement-breakpoint
CREATE INDEX "ix_vales_emitido_por_id" ON "vales" USING btree ("emitido_por_id");--> statement-breakpoint
CREATE INDEX "ix_vales_cancelado_por_id" ON "vales" USING btree ("cancelado_por_id");--> statement-breakpoint
-- Objetos que o drizzle-kit não gera (MD 1.5, 1.6). Versão: `vales` desce ao caixa (C, ↕; o fluxo `pessoas` com o
-- filtro da D90 entra no F3-B7), então já nasce com fn_versao (a trava de ordenação) e o índice de versão; as demais
-- sobem por evento ou não saem da nuvem: fn_versao_local. `requisicoes_terminal` é log técnico, sem versão.
create trigger tg_vales_versao before insert or update on vales
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_vales_versao on vales (versao);
--> statement-breakpoint
create trigger tg_movimentos_vale_versao before insert or update on movimentos_vale
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_reservas_vale_versao before insert or update on reservas_vale
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_trocas_versao before insert or update on trocas
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_itens_troca_versao before insert or update on itens_troca
  for each row execute function fn_versao_local();
--> statement-breakpoint
-- MD 3.13.1: a troca é fato consumado. Depois de gravada só mudam `venda_nova_id` (a nuvem a preenche ao aplicar a venda
-- que usa o vale da troca imediata, SYNC 9.16), `status` e as colunas de cancelamento (o cancelamento é só pelo ERP,
-- com `ESTORNO_TROCA_PDV`); o item e o movimento do vale não mudam nunca (o saldo do vale é a soma dos movimentos).
create trigger tg_trocas_imutavel before update on trocas
  for each row execute function fn_protege_imutavel('', '',
    'venda_nova_id,status,cancelada_em,motivo_cancelamento,versao,atualizado_em');
--> statement-breakpoint
create trigger tg_itens_troca_imutavel before update on itens_troca
  for each row execute function fn_protege_imutavel('', '', 'versao,atualizado_em');
--> statement-breakpoint
create trigger tg_movimentos_vale_imutavel before update on movimentos_vale
  for each row execute function fn_protege_imutavel('', '', 'versao,atualizado_em');
--> statement-breakpoint
-- O tg_trocas_imutavel deixa livres as colunas acima; aqui a máquina de estados delas: `registrada` só fica
-- `registrada` (sem tocar no cancelamento) ou vai a `cancelada`; `cancelada` é terminal e o cancelamento não muda
-- mais; `venda_nova_id` é preenchida uma vez (de nulo para a venda) e não troca de venda.
create or replace function fn_trocas_transicao() returns trigger language plpgsql as $$
begin
  if old.venda_nova_id is not null and new.venda_nova_id is distinct from old.venda_nova_id then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL',
      detail = 'trocas.venda_nova_id já preenchida';
  end if;
  if old.status = 'registrada' and new.status = 'cancelada' then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.cancelada_em is distinct from old.cancelada_em
     or new.motivo_cancelamento is distinct from old.motivo_cancelamento then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL',
      detail = format('trocas.status: %s → %s', old.status, new.status);
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_trocas_transicao before update on trocas
  for each row execute function fn_trocas_transicao();
--> statement-breakpoint
-- Exclusão física proibida (a função da 0028): a troca, o item e o movimento do vale são o registro do dinheiro que
-- saiu ou do crédito dado; o cancelamento é por estado (troca) ou por movimento novo (vale).
create trigger tg_trocas_sem_delete before delete on trocas
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_trocas_sem_truncate before truncate on trocas
  for each statement execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_itens_troca_sem_delete before delete on itens_troca
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_itens_troca_sem_truncate before truncate on itens_troca
  for each statement execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_movimentos_vale_sem_delete before delete on movimentos_vale
  for each row execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
create trigger tg_movimentos_vale_sem_truncate before truncate on movimentos_vale
  for each statement execute function fn_exclusao_fisica_proibida();
--> statement-breakpoint
-- MD 3.11.3: o item de venda finalizada ou cancelada só muda em `quantidade_devolvida` (a projeção das trocas) e na
-- versão. Com a venda num estado aberto (o rascunho do ERP, F3-B56) incluir, alterar e excluir continuam livres.
-- Argumentos: os estados abertos (STATUS_VENDA_ABERTOS, conferido pelo teste) e as colunas livres. Vale para a venda
-- do item antes e depois do UPDATE (mover o item para outra venda conta nas duas). O INSERT fica de fora: o handler
-- do `venda.finalizada` grava o cabeçalho já finalizado e depois as linhas (a ordem das FKs), e a conferência do
-- documento (`conferirConjunto`) é quem garante as linhas. As colunas de custo (`custo_unitario`) não ficam livres:
-- nenhum código as atualiza (o custo é gravado no INSERT; o `recalcular-saldos` e a compensação do Definir não
-- tocam no item). A trava da venda é de quem escreve (o rascunho do F3-B56 pega a venda com `for update`).
create or replace function fn_itens_venda_imutavel() returns trigger language plpgsql as $$
declare
  abertos text[] := string_to_array(tg_argv[0], ',');
  livres  text[] := string_to_array(tg_argv[1], ',');
  fechada boolean;
  a jsonb;
  b jsonb;
  c text;
begin
  select exists (
    select 1 from vendas v
     where v.id in (old.venda_id, case when tg_op = 'UPDATE' then new.venda_id end)
       and not (v.status = any(abertos))
  ) into fechada;
  if not fechada then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL',
      detail = 'itens_venda: exclusão com a venda finalizada ou cancelada';
  end if;
  a := to_jsonb(old);
  b := to_jsonb(new);
  foreach c in array livres loop a := a - c; b := b - c; end loop;
  if a <> b then
    raise exception using errcode = 'P0001', message = 'DOCUMENTO_IMUTAVEL',
      detail = 'itens_venda: só quantidade_devolvida muda com a venda finalizada ou cancelada';
  end if;
  return new;
end $$;
--> statement-breakpoint
create trigger tg_itens_venda_imutavel before update or delete on itens_venda
  for each row execute function fn_itens_venda_imutavel('rascunho,em_andamento,em_pagamento,suspensa,pedido_pendente',
    'quantidade_devolvida,versao,atualizado_em');
--> statement-breakpoint
-- Seed das empresas existentes (o `db:migrate:empresas` também recarrega as referências depois, com a mesma lista de
-- `TIPOS_MOVIMENTO_ESTOQUE`; aqui fica a garantia da própria migração). Os estornos que faltavam no MD 7.3: o do
-- comodato (cancelar a venda com cascos emprestados devolve o empréstimo, D85) e o da baixa interna (D102).
insert into tipos_movimento_estoque (codigo, nome, sinal, documento_tipo)
values ('ESTORNO_VASILHAME_EMPRESTADO', 'Estorno de empréstimo de vasilhame (comodato)', 1, 'venda'),
       ('ESTORNO_BAIXA_INTERNA', 'Estorno de baixa interna', 1, 'venda')
on conflict (codigo) do nothing;
--> statement-breakpoint
-- A numeração `vale` do caixa 0 (dono `nuvem`): os vales emitidos no ERP usam o caixa `00` (MD 3.13.2). As lojas novas
-- a recebem em `garantirNumeracoesLoja`; aqui, as que já existem.
insert into numeracoes (tipo, loja_id, caixa_id, dono, ultimo_numero)
select 'vale', c.loja_id, c.id, 'nuvem', 0
  from caixas c
 where c.sistema and c.excluido_em is null
   and not exists (
     select 1 from numeracoes n
      where n.tipo = 'vale' and n.caixa_id = c.id and n.modelo is null and n.serie is null and n.ambiente is null
        and n.excluido_em is null
   );
