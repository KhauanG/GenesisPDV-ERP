-- Triggers de versão (MD 1.5), FKs de autoria (MD 1.3 AU), índices únicos com NULLS NOT DISTINCT (MD 1.8) e a
-- tabela auditoria particionada por mês (MD 3.1.7) — objetos que o drizzle-kit não gera.
create trigger tg_empresa_versao before insert or update on empresa
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_empresa_versao on empresa (versao);
--> statement-breakpoint
create trigger tg_lojas_versao before insert or update on lojas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_lojas_versao on lojas (versao);
--> statement-breakpoint
create trigger tg_caixas_versao before insert or update on caixas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_caixas_versao on caixas (versao);
--> statement-breakpoint
create trigger tg_estoques_versao before insert or update on estoques
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_estoques_versao on estoques (versao);
--> statement-breakpoint
create trigger tg_tipos_estoque_versao before insert or update on tipos_estoque
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_tipos_estoque_versao on tipos_estoque (versao);
--> statement-breakpoint
create trigger tg_configuracoes_versao before insert or update on configuracoes
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_configuracoes_versao on configuracoes (versao);
--> statement-breakpoint
create trigger tg_templates_documentos_versao before insert or update on templates_documentos
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_templates_documentos_versao on templates_documentos (versao);
--> statement-breakpoint
create trigger tg_atalhos_pdv_versao before insert or update on atalhos_pdv
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_atalhos_pdv_versao on atalhos_pdv (versao);
--> statement-breakpoint
create trigger tg_formas_pagamento_versao before insert or update on formas_pagamento
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_formas_pagamento_versao on formas_pagamento (versao);
--> statement-breakpoint
create trigger tg_unidades_medida_versao before insert or update on unidades_medida
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_unidades_medida_versao on unidades_medida (versao);
--> statement-breakpoint
create trigger tg_usuarios_versao before insert or update on usuarios
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_usuarios_versao on usuarios (versao);
--> statement-breakpoint
create trigger tg_perfis_versao before insert or update on perfis
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_perfis_versao on perfis (versao);
--> statement-breakpoint
create trigger tg_permissoes_versao before insert or update on permissoes
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_permissoes_versao on permissoes (versao);
--> statement-breakpoint
create trigger tg_perfis_permissoes_versao before insert or update on perfis_permissoes
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_perfis_permissoes_versao on perfis_permissoes (versao);
--> statement-breakpoint
create trigger tg_usuarios_permissoes_versao before insert or update on usuarios_permissoes
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_usuarios_permissoes_versao on usuarios_permissoes (versao);
--> statement-breakpoint
create trigger tg_usuarios_lojas_versao before insert or update on usuarios_lojas
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_usuarios_lojas_versao on usuarios_lojas (versao);
--> statement-breakpoint
create trigger tg_cfops_versao before insert or update on cfops
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_cfops_versao on cfops (versao);
--> statement-breakpoint
create trigger tg_cfops_grupos_versao before insert or update on cfops_grupos
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_cfops_grupos_versao on cfops_grupos (versao);
--> statement-breakpoint
create trigger tg_meios_pagamento_fiscais_versao before insert or update on meios_pagamento_fiscais
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_meios_pagamento_fiscais_versao on meios_pagamento_fiscais (versao);
--> statement-breakpoint
create trigger tg_ufs_versao before insert or update on ufs
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_ufs_versao on ufs (versao);
--> statement-breakpoint
create trigger tg_municipios_versao before insert or update on municipios
  for each row execute function fn_versao();
--> statement-breakpoint
create index ix_municipios_versao on municipios (versao);
--> statement-breakpoint
create trigger tg_numeracoes_versao before insert or update on numeracoes
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_arquivos_versao before insert or update on arquivos
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_alertas_versao before insert or update on alertas
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_usuarios_estoques_versao before insert or update on usuarios_estoques
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_tipos_movimento_estoque_versao before insert or update on tipos_movimento_estoque
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_planos_contas_versao before insert or update on planos_contas
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_contas_correntes_versao before insert or update on contas_correntes
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_bancos_versao before insert or update on bancos
  for each row execute function fn_versao_local();
--> statement-breakpoint
alter table empresa add constraint fk_empresa_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_empresa_criado_por_id on empresa (criado_por_id);
--> statement-breakpoint
alter table empresa add constraint fk_empresa_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_empresa_atualizado_por_id on empresa (atualizado_por_id);
--> statement-breakpoint
alter table lojas add constraint fk_lojas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_lojas_criado_por_id on lojas (criado_por_id);
--> statement-breakpoint
alter table lojas add constraint fk_lojas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_lojas_atualizado_por_id on lojas (atualizado_por_id);
--> statement-breakpoint
alter table estoques add constraint fk_estoques_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_estoques_criado_por_id on estoques (criado_por_id);
--> statement-breakpoint
alter table estoques add constraint fk_estoques_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_estoques_atualizado_por_id on estoques (atualizado_por_id);
--> statement-breakpoint
alter table tipos_estoque add constraint fk_tipos_estoque_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_tipos_estoque_criado_por_id on tipos_estoque (criado_por_id);
--> statement-breakpoint
alter table tipos_estoque add constraint fk_tipos_estoque_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_tipos_estoque_atualizado_por_id on tipos_estoque (atualizado_por_id);
--> statement-breakpoint
alter table caixas add constraint fk_caixas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_caixas_criado_por_id on caixas (criado_por_id);
--> statement-breakpoint
alter table caixas add constraint fk_caixas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_caixas_atualizado_por_id on caixas (atualizado_por_id);
--> statement-breakpoint
alter table perfis add constraint fk_perfis_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_perfis_criado_por_id on perfis (criado_por_id);
--> statement-breakpoint
alter table perfis add constraint fk_perfis_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_perfis_atualizado_por_id on perfis (atualizado_por_id);
--> statement-breakpoint
alter table usuarios add constraint fk_usuarios_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_usuarios_criado_por_id on usuarios (criado_por_id);
--> statement-breakpoint
alter table usuarios add constraint fk_usuarios_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_usuarios_atualizado_por_id on usuarios (atualizado_por_id);
--> statement-breakpoint
alter table perfis_permissoes add constraint fk_perfis_permissoes_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_perfis_permissoes_criado_por_id on perfis_permissoes (criado_por_id);
--> statement-breakpoint
alter table perfis_permissoes add constraint fk_perfis_permissoes_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_perfis_permissoes_atualizado_por_id on perfis_permissoes (atualizado_por_id);
--> statement-breakpoint
alter table usuarios_permissoes add constraint fk_usuarios_permissoes_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_usuarios_permissoes_criado_por_id on usuarios_permissoes (criado_por_id);
--> statement-breakpoint
alter table usuarios_permissoes add constraint fk_usuarios_permissoes_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_usuarios_permissoes_atualizado_por_id on usuarios_permissoes (atualizado_por_id);
--> statement-breakpoint
alter table usuarios_lojas add constraint fk_usuarios_lojas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_usuarios_lojas_criado_por_id on usuarios_lojas (criado_por_id);
--> statement-breakpoint
alter table usuarios_lojas add constraint fk_usuarios_lojas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_usuarios_lojas_atualizado_por_id on usuarios_lojas (atualizado_por_id);
--> statement-breakpoint
alter table usuarios_estoques add constraint fk_usuarios_estoques_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_usuarios_estoques_criado_por_id on usuarios_estoques (criado_por_id);
--> statement-breakpoint
alter table usuarios_estoques add constraint fk_usuarios_estoques_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_usuarios_estoques_atualizado_por_id on usuarios_estoques (atualizado_por_id);
--> statement-breakpoint
alter table configuracoes add constraint fk_configuracoes_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_configuracoes_criado_por_id on configuracoes (criado_por_id);
--> statement-breakpoint
alter table configuracoes add constraint fk_configuracoes_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_configuracoes_atualizado_por_id on configuracoes (atualizado_por_id);
--> statement-breakpoint
alter table templates_documentos add constraint fk_templates_documentos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_templates_documentos_criado_por_id on templates_documentos (criado_por_id);
--> statement-breakpoint
alter table templates_documentos add constraint fk_templates_documentos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_templates_documentos_atualizado_por_id on templates_documentos (atualizado_por_id);
--> statement-breakpoint
alter table arquivos add constraint fk_arquivos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_arquivos_criado_por_id on arquivos (criado_por_id);
--> statement-breakpoint
alter table arquivos add constraint fk_arquivos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_arquivos_atualizado_por_id on arquivos (atualizado_por_id);
--> statement-breakpoint
alter table unidades_medida add constraint fk_unidades_medida_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_unidades_medida_criado_por_id on unidades_medida (criado_por_id);
--> statement-breakpoint
alter table unidades_medida add constraint fk_unidades_medida_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_unidades_medida_atualizado_por_id on unidades_medida (atualizado_por_id);
--> statement-breakpoint
alter table cfops_grupos add constraint fk_cfops_grupos_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_cfops_grupos_criado_por_id on cfops_grupos (criado_por_id);
--> statement-breakpoint
alter table cfops_grupos add constraint fk_cfops_grupos_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_cfops_grupos_atualizado_por_id on cfops_grupos (atualizado_por_id);
--> statement-breakpoint
alter table planos_contas add constraint fk_planos_contas_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_planos_contas_criado_por_id on planos_contas (criado_por_id);
--> statement-breakpoint
alter table planos_contas add constraint fk_planos_contas_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_planos_contas_atualizado_por_id on planos_contas (atualizado_por_id);
--> statement-breakpoint
alter table contas_correntes add constraint fk_contas_correntes_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_contas_correntes_criado_por_id on contas_correntes (criado_por_id);
--> statement-breakpoint
alter table contas_correntes add constraint fk_contas_correntes_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_contas_correntes_atualizado_por_id on contas_correntes (atualizado_por_id);
--> statement-breakpoint
alter table formas_pagamento add constraint fk_formas_pagamento_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_formas_pagamento_criado_por_id on formas_pagamento (criado_por_id);
--> statement-breakpoint
alter table formas_pagamento add constraint fk_formas_pagamento_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_formas_pagamento_atualizado_por_id on formas_pagamento (atualizado_por_id);
--> statement-breakpoint
alter table atalhos_pdv add constraint fk_atalhos_pdv_criado_por_id foreign key (criado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_atalhos_pdv_criado_por_id on atalhos_pdv (criado_por_id);
--> statement-breakpoint
alter table atalhos_pdv add constraint fk_atalhos_pdv_atualizado_por_id foreign key (atualizado_por_id) references usuarios (id);
--> statement-breakpoint
create index ix_atalhos_pdv_atualizado_por_id on atalhos_pdv (atualizado_por_id);
--> statement-breakpoint
alter table lojas add constraint fk_lojas_logotipo_arquivo_id foreign key (logotipo_arquivo_id) references arquivos (id);
--> statement-breakpoint
create index ix_lojas_logotipo_arquivo_id on lojas (logotipo_arquivo_id);
--> statement-breakpoint
alter table lojas add constraint fk_lojas_foto_arquivo_id foreign key (foto_arquivo_id) references arquivos (id);
--> statement-breakpoint
create index ix_lojas_foto_arquivo_id on lojas (foto_arquivo_id);
--> statement-breakpoint
create unique index uq_configuracoes_escopo_loja_id_chave on configuracoes (escopo, loja_id, chave) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_templates_documentos_padrao on templates_documentos (tipo, loja_id) nulls not distinct
  where padrao and excluido_em is null;
--> statement-breakpoint
create unique index uq_numeracoes_escopo on numeracoes (tipo, loja_id, caixa_id, modelo, serie, ambiente) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_formas_pagamento_descricao on formas_pagamento (loja_id, lower(descricao)) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create unique index uq_atalhos_pdv_acao on atalhos_pdv (loja_id, acao) nulls not distinct where excluido_em is null;
--> statement-breakpoint
create unique index uq_atalhos_pdv_tecla on atalhos_pdv (loja_id, lower(tecla)) nulls not distinct
  where habilitado and excluido_em is null;
--> statement-breakpoint
create unique index uq_planos_contas_nome_irmaos on planos_contas (pai_id, lower(nome)) nulls not distinct
  where excluido_em is null;
--> statement-breakpoint
create table auditoria (
  id uuid not null,
  criado_em timestamptz not null default now(),
  ocorrido_em timestamptz not null,
  origem varchar(15) not null,
  usuario_id uuid,
  usuario_nome varchar(100),
  autorizado_por_id uuid,
  admin_plataforma_id uuid,
  terminal_id uuid,
  loja_id uuid,
  entidade varchar(60) not null,
  registro_id uuid,
  acao varchar(40) not null,
  localizacao varchar(60),
  descricao text,
  antes jsonb,
  depois jsonb,
  ip inet,
  user_agent varchar(255),
  requisicao_id uuid,
  evento_id uuid,
  constraint pk_auditoria primary key (id, ocorrido_em),
  constraint ck_auditoria_origem check (origem in ('erp','pdv','api','sistema','importacao','integracao','suporte')),
  constraint ck_auditoria_acao check (acao in ('criar','editar','excluir','restaurar','cancelar','estornar','importar','exportar','login','login_negado','logout','liberacao','permissoes_alteradas','terminal_ativado','gaveta_aberta','efetivar','movimentar','converter','conferir','senha_alterada','senha_redefinida','bloqueio','download_xml','terminal_revogado','evento_descartado','acesso_suporte','segredo_entregue','token_anterior_reutilizado'))
) partition by range (ocorrido_em);
--> statement-breakpoint
create index ix_auditoria_entidade_registro_id on auditoria (entidade, registro_id, ocorrido_em desc);
--> statement-breakpoint
create index ix_auditoria_usuario_id_ocorrido_em on auditoria (usuario_id, ocorrido_em);
--> statement-breakpoint
create index ix_auditoria_ocorrido_em on auditoria using brin (ocorrido_em);
--> statement-breakpoint
-- Append-only (ERP 17.2): retenção remove partições inteiras (drop table), nunca linhas.
create or replace function fn_auditoria_append_only() returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'AUDITORIA_IMUTAVEL';
end $$;
--> statement-breakpoint
create trigger tg_auditoria_append_only before update or delete on auditoria
  for each row execute function fn_auditoria_append_only();
--> statement-breakpoint
-- Cria as partições mensais auditoria_aaaa_mm de (mês atual - meses_antes) até (mês atual + meses_depois).
-- Chamada no provisionamento, nas migrações e pela tarefa mensal (pnpm --filter api db:particoes).
create or replace function fn_auditoria_garantir_particoes(meses_antes integer, meses_depois integer)
returns integer language plpgsql as $$
declare
  inicio date := (date_trunc('month', now() at time zone 'UTC') - make_interval(months => meses_antes))::date;
  mes date;
  nome text;
  criadas integer := 0;
begin
  for i in 0 .. (meses_antes + meses_depois) loop
    mes := (inicio + make_interval(months => i))::date;
    nome := 'auditoria_' || to_char(mes, 'YYYY_MM');
    if to_regclass(nome) is null then
      execute format(
        'create table %I partition of auditoria for values from (%L) to (%L)',
        nome, (mes::timestamp at time zone 'UTC'), ((mes + interval '1 month')::timestamp at time zone 'UTC'));
      criadas := criadas + 1;
    end if;
  end loop;
  return criadas;
end $$;
--> statement-breakpoint
select fn_auditoria_garantir_particoes(3, 12);
