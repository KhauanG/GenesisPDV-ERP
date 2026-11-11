import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CABECALHO_CESTS, camposCsv, lerCests } from './carregar.js';

/**
 * Leitura do `cests.csv` (F2-B41; README da API › decisão 187). As linhas são **inventadas** (CEST 99xxxxx, que não
 * existem no Convênio ICMS 142/2018): o formato, não a tabela oficial.
 */
const pasta = mkdtempSync(join(tmpdir(), 'genesis-cests-'));
afterAll(() => rmSync(pasta, { recursive: true, force: true }));

function arquivo(nome: string, conteudo: string): string {
  const caminho = join(pasta, nome);
  writeFileSync(caminho, conteudo, 'utf8');
  return caminho;
}

describe('camposCsv', () => {
  it('separa por ";" com as aspas opcionais ("" é uma aspa)', () => {
    expect(camposCsv('a;"b;c";"d ""e""";')).toEqual(['a', 'b;c', 'd "e"', '']);
    expect(() => camposCsv('a;"b')).toThrow('aspas sem fechar');
  });
});

describe('lerCests', () => {
  it('o arquivo versionado é lido sem erro (hoje só o cabeçalho; depois, a lista oficial); o ausente é vazio', () => {
    // Não confere "vazio": quando a lista do CONFAZ entrar, este teste passa a validar o formato dela.
    expect(() => lerCests()).not.toThrow();
    expect(lerCests(join(pasta, 'nao-existe.csv'))).toEqual([]);
  });

  it('lê as linhas: NCMs sem os pontos, sem repetir, e as datas vazias nulas', () => {
    const c = arquivo(
      'ok.csv',
      `\uFEFF${CABECALHO_CESTS}\r\n9900100;INVENTADO TESTE;SEG TESTE;2203.00.00, 2203 ,2203;2018-01-01;\r\n\r\n` +
        '9900200;"INVENTADO; TESTE";;22;;2019-12-31\n',
    );
    expect(lerCests(c)).toEqual([
      {
        codigo: '9900100',
        descricao: 'INVENTADO TESTE',
        segmento: 'SEG TESTE',
        ncms: ['22030000', '2203'],
        inicio: '2018-01-01',
        fim: null,
      },
      {
        codigo: '9900200',
        descricao: 'INVENTADO; TESTE',
        segmento: null,
        ncms: ['22'],
        inicio: null,
        fim: '2019-12-31',
      },
    ]);
  });

  it('linha fora do formato derruba a carga com o número da linha', () => {
    const ruim = (linha: string) => () => lerCests(arquivo('ruim.csv', `${CABECALHO_CESTS}\n${linha}\n`));
    expect(() => lerCests(arquivo('cab.csv', 'codigo;descricao\n'))).toThrow('cabeçalho');
    expect(ruim('99001;X;;2203;;')).toThrow('linha 2: CEST com 7 dígitos');
    expect(ruim('9900100;;;2203;;')).toThrow('linha 2: descrição vazia');
    expect(ruim('9900100;X;;;;')).toThrow('linha 2: NCMs');
    expect(ruim('9900100;X;;2203,ABC;;')).toThrow('linha 2: NCMs');
    expect(ruim('9900100;X;;220300001;;')).toThrow('linha 2: NCMs');
    expect(ruim('9900100;X;;2203;01/01/2018;')).toThrow('linha 2: data');
    expect(ruim('9900100;X;;2203;;\n9900100;Y;;2203;;')).toThrow('linha 3: CEST 9900100 repetido');
    expect(ruim('9900100;X;2203;;')).toThrow('linha 2: 6 colunas');
  });
});
