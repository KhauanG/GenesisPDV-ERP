-- Mudança de tipo de estoque (Fase 2, F2-B8; ERP 13.1.4, 13.5, 13.6; MD 3.7.5; README da API › decisão 153): o acerto
-- ganha o tipo de ajuste `mudanca_tipo` ('mudanca_tipo' tem 12 letras: `tipo_ajuste` passa de varchar(8) para
-- varchar(12), só metadado no PostgreSQL) e o tipo de destino no cabeçalho. A efetivação gera o par
-- `MUDANCA_TIPO_ESTOQUE` (−origem ao custo médio dela, +destino com o mesmo custo, mesmo `documento_item_id`; as duas
-- pernas não colidem em `uq_movimentos_estoque_idempotencia`, que tem o `tipo_estoque_id`).
--
-- Imutabilidade: nenhum trigger muda. O `tg_acertos_estoque_imutavel` (0004) compara a linha inteira fora do
-- rascunho, menos as colunas livres do estorno, então já protege `tipo_estoque_destino_id`; os itens seguem o
-- `tg_itens_acerto_estoque_rascunho` (pelo status) e o `tg_itens_acerto_estoque_quantidade` (0007: quantidade
-- negativa só no "Definir"; a mudança de tipo, como a Saída, só aceita > 0). Acertos existentes não mudam: nenhum tem
-- destino, e o check novo vale para eles.
ALTER TABLE "acertos_estoque" DROP CONSTRAINT "ck_acertos_estoque_tipo_ajuste";--> statement-breakpoint
ALTER TABLE "acertos_estoque" ALTER COLUMN "tipo_ajuste" SET DATA TYPE varchar(12);--> statement-breakpoint
ALTER TABLE "acertos_estoque" ALTER COLUMN "tipo_ajuste" SET DEFAULT 'entrada';--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD COLUMN "tipo_estoque_destino_id" uuid;--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD CONSTRAINT "fk_acertos_estoque_tipo_estoque_destino_id" FOREIGN KEY ("tipo_estoque_destino_id") REFERENCES "public"."tipos_estoque"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_acertos_estoque_tipo_estoque_destino_id" ON "acertos_estoque" USING btree ("tipo_estoque_destino_id");--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD CONSTRAINT "ck_acertos_estoque_mudanca_tipo" CHECK ((tipo_ajuste = 'mudanca_tipo') = (tipo_estoque_destino_id is not null) and tipo_estoque_destino_id is distinct from tipo_estoque_id);--> statement-breakpoint
ALTER TABLE "acertos_estoque" ADD CONSTRAINT "ck_acertos_estoque_tipo_ajuste" CHECK (tipo_ajuste in ('entrada','saida','definir','mudanca_tipo'));