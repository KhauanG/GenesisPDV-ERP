-- Compensação por "Definir" (Fase 2, F2-B4; ERP 13.1.5 regra 7; SYNC 15.3; README da API › decisão 148). A 0013
-- deixava cada movimento ser compensado uma vez só na vida. O fato anterior a duas contagens efetivadas é compensado
-- contra a mais nova; estornar a mais nova estorna essa compensação e o fato tem de voltar a ser compensado, agora
-- contra a anterior, que também já o tinha visto na contagem física. Com o índice antigo o segundo `ACERTO_COMPENSACAO`
-- dava 23505, e a venda tardia voltava a pesar sobre a contagem anterior. Passa a valer um por "Definir"
-- (`documento_id`): o mesmo "Definir" não compensa o mesmo fato duas vezes, e o estornado não volta a ser efetivado.
-- Que só uma compensação do fato esteja viva (não estornada) é garantia do motor (`estornarAcerto` só compensa de
-- novo o fato cuja compensação acabou de estornar). O `create` varre a tabela uma vez com as gravações em espera (trava
-- SHARE); no volume do piloto são segundos, e o índice parcial fica pequeno.
drop index uq_movimentos_estoque_compensacao;
--> statement-breakpoint
create unique index uq_movimentos_estoque_compensacao on movimentos_estoque (compensa_movimento_id, documento_id)
  where compensa_movimento_id is not null;
