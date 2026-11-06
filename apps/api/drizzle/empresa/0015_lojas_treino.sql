-- Loja de treino (Fase 1C, bloco C12; dono, O10): a loja "Treino" fica dentro da empresa real (Ice Beer), com estoque
-- próprio e configurada como não fiscal. As vendas dela são gravadas como as das outras lojas; as consultas do ERP
-- (Vendas, Reforço, Sangria, Fechamento de caixa) e o dashboard a deixam de fora por padrão, com o filtro "loja de
-- treino". A coluna é do ERP: fica no `omitir` do fluxo `configuracao` e não desce ao PDV (`Esquema.g.cs` igual).
ALTER TABLE "lojas" ADD COLUMN "treino" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A loja de treino é não fiscal (O10): uma loja que emite NFC-e/SAT marcada como treino tiraria o faturamento fiscal
-- dos totais do ERP sem aviso. Nenhuma loja é de treino antes desta migração, então o check entra sem conferir dados.
ALTER TABLE "lojas" ADD CONSTRAINT "ck_lojas_treino_nao_fiscal" CHECK (not treino or tipo_emissao = 'nao_fiscal');
