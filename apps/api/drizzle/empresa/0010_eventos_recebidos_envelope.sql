-- Envelope do evento (Fase 1C, T1; MD 3.15.2; SYNC 12.4, 22.2): o push guardava só o `payload` e os metadados, e
-- perdia `usuario_id`, `contexto` e o relógio (`desvio_relogio_ms`, `relogio_confiavel`, `relogio_regrediu`), que
-- reprocessar, recuperar e as regras de relógio precisam. As linhas anteriores ficam com `{}`.
ALTER TABLE "eventos_recebidos" ADD COLUMN "envelope" jsonb DEFAULT '{}'::jsonb NOT NULL;
