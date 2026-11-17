import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agruparEm, cederLaco, coletarCedendo } from './colecoes.js';

const RAIZ = fileURLToPath(new URL('../../../../', import.meta.url));

/** Arquivos `.ts`/`.tsx` de produção (sem testes) das pastas dadas, relativos à raiz do repositório. */
function fontes(...pastas: string[]): Array<{ caminho: string; texto: string }> {
  const lista: Array<{ caminho: string; texto: string }> = [];
  const visitar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const c = join(dir, nome);
      if (statSync(c).isDirectory()) visitar(c);
      else if (/\.tsx?$/.test(nome) && !/\.(spec|test)\.tsx?$/.test(nome))
        lista.push({ caminho: relative(RAIZ, c), texto: readFileSync(c, 'utf8') });
    }
  };
  for (const p of pastas) visitar(join(RAIZ, p));
  return lista;
}

/**
 * `lista.filter((x, i, todos) => todos.findIndex(...) === i)` percorre a lista a cada item: use um `Set`. O `.*` aceita
 * o callback com parênteses (`(x) => …`), a forma real do padrão.
 */
const DEDUPLICACAO = /\.findIndex\(.*\)\s*===\s*i\b/;

describe('agruparEm', () => {
  it('acrescenta na lista da chave, na ordem, mantendo a mesma lista', () => {
    const m = new Map<string, number[]>();
    agruparEm(m, 'a', 1);
    const lista = m.get('a');
    agruparEm(m, 'b', 2);
    agruparEm(m, 'a', 3);
    expect([...m]).toEqual([
      ['a', [1, 3]],
      ['b', [2]],
    ]);
    expect(m.get('a')).toBe(lista);
  });

  it('nenhum agrupamento do código copia a lista acumulada a cada item (custo quadrático na mesma chave)', () => {
    // `mapa.set(k, [...(mapa.get(k) ?? []), v])` copia a lista inteira a cada item: use `agruparEm` (ou `push`).
    const copia = /\.set\([^;]*\[\s*\.\.\.\(\s*[\w.]+\.get\(/;
    const achados = fontes('apps/api/src', 'packages/shared/src', 'apps/erp-web/src').flatMap(
      ({ caminho, texto }) =>
        texto
          .split('\n')
          .map((linha, i) => ({ linha, n: i + 1 }))
          .filter(({ linha }) => copia.test(linha) || DEDUPLICACAO.test(linha))
          .map(({ n }) => `${caminho}:${n}`),
    );
    expect(achados).toEqual([]);
  });

  it('a varredura reconhece as formas reais do padrão (callback com e sem parênteses)', () => {
    // O trecho que a decisão 209 tirou da importação e o que saiu do formulário de produto (valores.ts).
    expect(DEDUPLICACAO.test('.filter((g, i, todos) => todos.findIndex((x) => x.id === g.id) === i)')).toBe(
      true,
    );
    expect(DEDUPLICACAO.test('todos.findIndex((x) => x.fornecedorId === f.fornecedorId) === i)')).toBe(true);
    expect(DEDUPLICACAO.test('lista.findIndex(x => x.id === y.id) === i')).toBe(true);
    // Sem o `=== i` no fim (achar a posição de um item) não é deduplicação.
    expect(DEDUPLICACAO.test('const p = lista.findIndex((x) => x.id === id);')).toBe(false);
    expect(DEDUPLICACAO.test('if (lista.findIndex((x) => x.id === id) === indice) return;')).toBe(false);
  });
});

describe('coletarCedendo', () => {
  it('dá o mesmo resultado e cede o laço a cada fatia (quem esperava roda no meio)', async () => {
    const ordem: string[] = [];
    function* itens() {
      for (let i = 0; i < 10; i++) {
        ordem.push(`item ${i}`);
        yield i;
      }
    }
    setImmediate(() => ordem.push('outra'));
    expect(await coletarCedendo(itens(), 4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // A outra tarefa roda depois da 1ª fatia, não só no fim.
    expect(ordem.indexOf('outra')).toBe(4);
  });

  it('cederLaco deixa rodar o que já estava esperando', async () => {
    let rodou = false;
    setImmediate(() => (rodou = true));
    await cederLaco();
    expect(rodou).toBe(true);
  });
});
