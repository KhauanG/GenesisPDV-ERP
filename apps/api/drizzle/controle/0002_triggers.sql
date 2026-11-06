-- Versão local em todas as tabelas com CP (MD 2: nada do controle desce para PDVs, então fn_versao_local).
-- Também: FKs circulares entre ativacoes_pdv e terminais_pdv (o drizzle-kit não as declara sem ciclo de tipos).
create trigger tg_planos_versao before insert or update on planos
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_servidores_banco_versao before insert or update on servidores_banco
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_empresas_versao before insert or update on empresas
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_ativacoes_pdv_versao before insert or update on ativacoes_pdv
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_terminais_pdv_versao before insert or update on terminais_pdv
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_versoes_app_pdv_versao before insert or update on versoes_app_pdv
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_admins_plataforma_versao before insert or update on admins_plataforma
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_acessos_suporte_versao before insert or update on acessos_suporte
  for each row execute function fn_versao_local();
--> statement-breakpoint
create trigger tg_migracoes_empresas_versao before insert or update on migracoes_empresas
  for each row execute function fn_versao_local();
--> statement-breakpoint
alter table ativacoes_pdv add constraint fk_ativacoes_pdv_substitui_terminal_id
  foreign key (substitui_terminal_id) references terminais_pdv (id);
--> statement-breakpoint
alter table ativacoes_pdv add constraint fk_ativacoes_pdv_terminal_id
  foreign key (terminal_id) references terminais_pdv (id);
