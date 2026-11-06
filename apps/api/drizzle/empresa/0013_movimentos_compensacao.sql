-- Compensação de movimento tardio (Fase 1C, bloco C6b, T23; SYNC 15.3; ERP 13.1.5 regra 3). O `ACERTO_COMPENSACAO`
-- grava `documento_tipo = 'acerto'`, `documento_id` = o "Definir" e `documento_item_id` = o item dele, e o
-- `compensa_movimento_id` = o movimento tardio. Sem essa coluna no índice de idempotência, a segunda venda tardia do
-- mesmo produto contra o mesmo "Definir" (ou dois itens do mesmo produto numa venda só) batia na compensação da
-- primeira (23505 → `AGREGADO_DIVERGENTE`) e a venda ficava presa. Pelo mesmo motivo entra `estorno_de_id`: o
-- estorno do "Definir" lança um `ESTORNO_ACERTO` para o movimento do próprio acerto e um para cada compensação, todos
-- com o mesmo item do acerto, e sem a coluna o segundo dava 23505 e o acerto nunca mais podia ser estornado. Para os
-- demais movimentos as duas colunas são nulas e o índice vale como antes.
drop index uq_movimentos_estoque_idempotencia;
--> statement-breakpoint
create unique index uq_movimentos_estoque_idempotencia on movimentos_estoque (documento_tipo, documento_item_id, produto_id, variacao_id, lote_id, tipo_estoque_id, tipo_movimento, compensa_movimento_id, estorno_de_id) nulls not distinct
  where documento_item_id is not null;
--> statement-breakpoint
-- Cada movimento é compensado no máximo uma vez (ERP 13.1.5: um único `ACERTO_COMPENSACAO`, contra o último "Definir").
create unique index uq_movimentos_estoque_compensacao on movimentos_estoque (compensa_movimento_id)
  where compensa_movimento_id is not null;
--> statement-breakpoint
-- Cada movimento é estornado no máximo uma vez (ERP 13.5). Era o índice de idempotência que barrava o segundo estorno
-- do mesmo movimento (mesma chave); com `estorno_de_id` nele, a barreira passa a ser esta.
create unique index uq_movimentos_estoque_estorno on movimentos_estoque (estorno_de_id)
  where estorno_de_id is not null;
