-- Fornecedores no produto (Fase 2, F2-B13; ERP 8.2.14; MD 3.6.9; D49; README da API › decisão 158): o vínculo
-- produto × fornecedor ganha o **custo do fornecedor**, digitado no cadastro (o dono quer o custo por fornecedor
-- editável, além do último custo que vem da compra). Fica na unidade do produto, a mesma de `produtos.preco_custo` e de
-- `ultimo_custo`, para o ERP levá-lo ao preço de custo sem conta; o recebimento e a NF-e não o mudam (eles gravam
-- `ultimo_custo` e `ultima_compra_em`, F2-B15/F2-B21). O check novo vale também para o último custo: nenhuma linha
-- existente tem custo (a tabela não tinha API até aqui). `produtos_fornecedores` não desce ao PDV (MD 3.6.9, "—"):
-- o `Esquema.g.cs` não muda.
ALTER TABLE "produtos_fornecedores" ADD COLUMN "custo_fornecedor" numeric(15, 4);--> statement-breakpoint
ALTER TABLE "produtos_fornecedores" ADD CONSTRAINT "ck_produtos_fornecedores_custos" CHECK ((custo_fornecedor is null or custo_fornecedor >= 0) and (ultimo_custo is null or ultimo_custo >= 0));
