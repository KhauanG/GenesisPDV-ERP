/**
 * Conferência do `compatibilidade.sh` (Fase 3, F3-B7; padrões da Fase 3 › matriz de compatibilidade; README da API ›
 * decisão 226): depois que o PDV de uma tag antiga rodou o roteiro do e2e contra a API desta árvore, confere no banco da
 * empresa do e2e que algum terminal daquela versão informou no heartbeat (`terminais.cursor_pull`) os cursores do
 * `catalogo`, do `pessoas` e do `operacao` além das linhas da Fase 3 que o `servidor.ts` semeou (promoção, vale e
 * orçamento): o PDV instalado puxou da API nova, descartou as tabelas que não conhece e o cursor avançou. Só imprime
 * versões e cursores (dados inventados do e2e).
 *
 * Uso (pelo `compatibilidade.sh`, com a API ainda no ar): `tsx test/e2e-pdv/conferir-compatibilidade.ts <estado.json>
 * <versão do app>`; sai com 1 quando nenhum terminal da versão passou das linhas.
 */
import { readFileSync } from 'node:fs';
import { consultar } from '../integracao/ambiente.js';

const [arquivo, versao] = process.argv.slice(2);
if (!arquivo || !versao) {
  console.error('uso: conferir-compatibilidade.ts <estado.json> <versão do app>');
  process.exit(2);
}
const { nomeBanco } = JSON.parse(readFileSync(arquivo, 'utf8')) as { nomeBanco: string };

/** Fluxo → tabelas da Fase 3 semeadas nele (`servidor.ts › semearFase3`). */
const FLUXOS = {
  catalogo: ['promocoes', 'promocoes_itens'],
  pessoas: ['vales'],
  operacao: ['orcamentos', 'itens_orcamento'],
} as const;

const minimos: Record<string, number> = {};
for (const [fluxo, tabelas] of Object.entries(FLUXOS)) {
  let maior = 0;
  for (const tabela of tabelas) {
    const [linha] = await consultar<{ v: string | null }>(
      nomeBanco,
      `select max(versao)::text as v from ${tabela}`,
    );
    if (!linha?.v) {
      console.error(`compatibilidade: ${tabela} sem linha semeada (servidor.ts › semearFase3)`);
      process.exit(1);
    }
    maior = Math.max(maior, Number(linha.v));
  }
  minimos[fluxo] = maior;
}

const terminais = await consultar<{ versao_app: string | null; cursor_pull: Record<string, number> | null }>(
  nomeBanco,
  'select versao_app, cursor_pull from terminais where cursor_pull is not null order by ativado_em',
);
const daVersao = terminais.filter((t) => t.versao_app?.split('+')[0] === versao);
const passaram = daVersao.filter((t) =>
  Object.entries(minimos).every(([fluxo, minimo]) => Number(t.cursor_pull?.[fluxo] ?? 0) >= minimo),
);
console.log(
  `compatibilidade: PDV ${versao}: ${daVersao.length} terminal(is) com heartbeat, ${passaram.length} além das linhas da Fase 3 ` +
    `(mínimos ${JSON.stringify(minimos)}; cursores ${JSON.stringify(daVersao.map((t) => t.cursor_pull))})`,
);
process.exit(passaram.length > 0 ? 0 : 1);
