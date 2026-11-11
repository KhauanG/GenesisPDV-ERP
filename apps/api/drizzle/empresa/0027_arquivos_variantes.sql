-- Variantes das imagens enviadas pelo ERP (Fase 2, F2-B43; SYNC 6.12; README da API › decisão 189): a `pdv_256`
-- (WebP de até 256 px, gerada com o sharp no envio) e, depois, as outras da SYNC 6.12. O JSON guarda a chave do objeto
-- da variante no armazenamento, o tipo, o tamanho, o sha256 e as dimensões; `{}` = só o original. Coluna nova com
-- padrão constante: no PostgreSQL 11+ não reescreve a tabela (só o catálogo), então não trava as gravações.
ALTER TABLE "arquivos" ADD COLUMN "variantes" jsonb DEFAULT '{}'::jsonb NOT NULL;
