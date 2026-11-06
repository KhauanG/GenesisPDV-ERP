/**
 * Leitura das fixtures de NF-e pelos testes unitários e de integração (F2-B18): as geradas pelo `gerar.ts` (na pasta,
 * assinadas por nós, com a assinatura válida) e as notas reais de fornecedores (em `reais/`, só na máquina de quem
 * testa: a pasta está no `.gitignore` e nunca vai para o repositório, que é público, D60; anonimizadas ou não, a
 * assinatura delas pode não conferir). Sem dependência do `gerar.ts`, que puxa o `xml-crypto` e o `openssl`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completarCnpj } from '@genesis/shared';

export const PASTA_FIXTURES_NFE = dirname(fileURLToPath(import.meta.url));

/** Lojas da empresa de teste: os destinatários das fixtures geradas (o `gerar.ts` e os testes usam as mesmas). */
export const CNPJ_LOJA_1 = completarCnpj('112223330001');
export const CNPJ_PETISCARIA_2 = completarCnpj('112223330002');
export const CNPJ_CD = completarCnpj('112223330003');

const xmlsDa = (pasta: string): string[] =>
  existsSync(pasta)
    ? readdirSync(pasta)
        .filter((f) => f.endsWith('.xml'))
        .sort()
    : [];

/** As geradas pelo `gerar.ts` (nome do arquivo). */
export const ARQUIVOS_FIXTURES_NFE: readonly string[] = xmlsDa(PASTA_FIXTURES_NFE);

/** As notas reais locais (`reais/<arquivo>`, o caminho que o `fixtureNfe` lê); na CI e num clone novo, nenhuma. */
export const ARQUIVOS_FIXTURES_NFE_REAIS: readonly string[] = xmlsDa(join(PASTA_FIXTURES_NFE, 'reais')).map(
  (f) => `reais/${f}`,
);

export const fixtureNfe = (nome: string): string => readFileSync(join(PASTA_FIXTURES_NFE, nome), 'utf8');
