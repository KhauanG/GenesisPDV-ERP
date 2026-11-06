/**
 * Importação de contagem (Fase 2, F2-B9; ERP 13.5): o parser do arquivo do coletor ou da planilha (separadores, BOM,
 * cabeçalho, decimal com vírgula, linha só com o código) e a consolidação com o fator do código de barras de
 * embalagem (fardo de 12 e caixa de 24), as leituras repetidas e os códigos com problema; a divisão em rascunhos e
 * as opções do multipart. Revisão: o cabeçalho só com o rótulo inteiro (`COD0001` é leitura), as aspas do CSV, o teto
 * da quantidade, o caractere de controle no código, o `1.000` ambíguo e o código da linha inválida.
 */
import { describe, expect, it } from 'vitest';
import {
  consolidarContagem,
  dividirEmRascunhos,
  lerArquivoContagem,
  lerQuantidadeContagem,
  opcoesImportarContagemSchema,
  type ProdutoContagem,
  type ResolucaoCodigoContagem,
} from './estoque.js';

const cerveja: ProdutoContagem = { id: 'p1', codigo: 1, nome: 'CERV BRAHMA LT 350ML', unidadeSigla: 'UN' };
const refri: ProdutoContagem = { id: 'p2', codigo: 2, nome: 'REFRI COCA 2L', unidadeSigla: 'UN' };
const combo: ProdutoContagem = { id: 'p3', codigo: 3, nome: 'COMBO', unidadeSigla: 'UN' };

/** EAN da unidade, o do fardo com 12, o da caixa com 24, o código interno e os problemas. */
const BASE: Record<string, ResolucaoCodigoContagem> = {
  '7891149103102': { situacao: 'encontrado', produto: cerveja, fator: 1 },
  '17891149103109': { situacao: 'encontrado', produto: cerveja, fator: 12 },
  '27891149103106': { situacao: 'encontrado', produto: cerveja, fator: '24.000' },
  REF2L: { situacao: 'encontrado', produto: refri, fator: 1 },
  '7890000000001': { situacao: 'ambiguo', produtos: [cerveja, refri] },
  '7890000000002': { situacao: 'sem_estoque', produto: combo, mensagem: 'Combo não tem estoque próprio' },
};
const resolver = (c: string): ResolucaoCodigoContagem => BASE[c] ?? { situacao: 'nao_encontrado' };

describe('lerQuantidadeContagem', () => {
  it('inteiro, vírgula e ponto decimais, milhar e os recusados', () => {
    expect(lerQuantidadeContagem('12')).toBe('12.000');
    expect(lerQuantidadeContagem(' 1,5 ')).toBe('1.500');
    expect(lerQuantidadeContagem('1.5')).toBe('1.500');
    expect(lerQuantidadeContagem('0,125')).toBe('0.125');
    expect(lerQuantidadeContagem('1.234,5')).toBe('1234.500');
    expect(lerQuantidadeContagem('1,234.5')).toBe('1234.500');
    expect(lerQuantidadeContagem('1.000.000')).toBe('1000000.000');
    expect(lerQuantidadeContagem('0')).toBe('0.000');
    for (const ruim of ['', '-2', 'abc', '1,2345', '1.2.3,4,5', '2 un'])
      expect(lerQuantidadeContagem(ruim), ruim).toBeNull();
  });
});

describe('lerArquivoContagem', () => {
  it('ponto-e-vírgula com BOM, cabeçalho, \\r\\n e linhas vazias', () => {
    const r = lerArquivoContagem('\uFEFFEAN;Quantidade\r\n7891149103102;10\r\n\r\n17891149103109;2,5\r\n');
    expect(r.separador).toBe(';');
    expect(r.cabecalho).toBe('EAN;Quantidade');
    expect(r.linhas).toBe(2);
    expect(r.leituras).toEqual([
      { linha: 2, codigo: '7891149103102', quantidade: '10.000' },
      { linha: 4, codigo: '17891149103109', quantidade: '2.500' },
    ]);
    expect(r.invalidas).toEqual([]);
  });

  it('tabulação, barra vertical e vírgula (com ponto decimal); colunas extras ignoradas', () => {
    expect(lerArquivoContagem('7891149103102\t3\tOPERADOR 1\n').leituras).toEqual([
      { linha: 1, codigo: '7891149103102', quantidade: '3.000' },
    ]);
    expect(lerArquivoContagem('REF2L|4\r').separador).toBe('|');
    const virgula = lerArquivoContagem('7891149103102,1.5\n7891149103102,1,5\n');
    expect(virgula.separador).toBe(',');
    expect(virgula.leituras).toEqual([{ linha: 1, codigo: '7891149103102', quantidade: '1.500' }]);
    // Com o separador vírgula, "1,5" viraria 1 calado: a linha é recusada.
    expect(virgula.invalidas.map((i) => i.linha)).toEqual([2]);
    expect(virgula.invalidas[0]!.mensagem).toMatch(/ponto-e-vírgula/);
  });

  it('linha só com o código vale 1 (coletor que grava uma linha por leitura); aspas e \\r sozinho', () => {
    const r = lerArquivoContagem('7891149103102\r7891149103102\r"REF2L"\r');
    expect(r.separador).toBeNull();
    expect(r.cabecalho).toBeNull();
    expect(r.leituras.map((l) => [l.codigo, l.quantidade])).toEqual([
      ['7891149103102', '1.000'],
      ['7891149103102', '1.000'],
      ['REF2L', '1.000'],
    ]);
  });

  it('linhas inválidas não param a leitura', () => {
    const r = lerArquivoContagem(`;5\n7891149103102;-1\n${'9'.repeat(31)};1\nREF2L;abc\nREF2L;2\n`);
    expect(r.leituras).toEqual([{ linha: 5, codigo: 'REF2L', quantidade: '2.000' }]);
    expect(r.invalidas.map((i) => [i.linha, i.mensagem])).toEqual([
      [1, 'Linha sem código'],
      [2, 'Quantidade inválida (número ≥ 0 com até 3 casas decimais)'],
      [3, 'Código com mais de 30 caracteres'],
      [4, 'Quantidade inválida (número ≥ 0 com até 3 casas decimais)'],
    ]);
    // O código da linha recusada pela quantidade volta (o produto foi contado: "Zerar" não o zera).
    expect(r.invalidas.map((i) => i.codigo)).toEqual([null, '7891149103102', null, 'REF2L']);
    // A primeira linha só é cabeçalho com cara de cabeçalho: um código com quantidade inválida é erro.
    expect(lerArquivoContagem('7891149103102;x\n').invalidas).toHaveLength(1);
  });
});

describe('lerArquivoContagem (revisão)', () => {
  it('cabeçalho só com o rótulo conhecido inteiro: código interno com prefixo parecido é leitura', () => {
    const codigos = lerArquivoContagem('COD0001\nCOD0002\n');
    expect(codigos.cabecalho).toBeNull();
    expect(codigos.leituras.map((l) => l.codigo)).toEqual(['COD0001', 'COD0002']);
    expect(lerArquivoContagem('ITEM10\n').leituras).toHaveLength(1);
    // Com a quantidade vazia ou inválida, é linha inválida (com o código), e não cabeçalho calado.
    const vazia = lerArquivoContagem('COD123;\n7891149103102;2\n');
    expect(vazia.cabecalho).toBeNull();
    expect(vazia.invalidas.map((i) => [i.linha, i.codigo])).toEqual([[1, 'COD123']]);
    expect(lerArquivoContagem('ITEM01;abc\n').invalidas).toHaveLength(1);
    for (const rotulo of [
      'Código de barras;Quantidade',
      'Cód. Barras',
      'EAN/GTIN;Qtd',
      'codigo_interno;qtd',
      'SKU',
    ])
      expect(lerArquivoContagem(`${rotulo}\n7891149103102;1\n`).cabecalho, rotulo).toBe(rotulo);
  });

  it('aspas do CSV: o separador dentro delas não divide ("1,5" do Google Sheets)', () => {
    const r = lerArquivoContagem('7891149103102,"1,5"\n7891149103102,1,5\n"REF""2",2\n');
    expect(r.separador).toBe(',');
    expect(r.leituras).toEqual([
      { linha: 1, codigo: '7891149103102', quantidade: '1.500' },
      { linha: 3, codigo: 'REF"2', quantidade: '2.000' },
    ]);
    expect(r.invalidas.map((i) => i.linha)).toEqual([2]);
  });

  it('quantidade acima do máximo (o EAN bipado no campo da quantidade) é linha inválida com o código', () => {
    const r = lerArquivoContagem('7891234567890;7891234567890\n7891149103102;999999999999\n');
    expect(r.leituras).toEqual([{ linha: 2, codigo: '7891149103102', quantidade: '999999999999.000' }]);
    expect(r.invalidas).toHaveLength(1);
    expect(r.invalidas[0]).toMatchObject({ linha: 1, codigo: '7891234567890' });
    expect(r.invalidas[0]!.mensagem).toMatch(/acima de 999\.999\.999\.999/);
  });

  it('código com caractere de controle (UTF-16 lido como texto simples) é recusado, sem código', () => {
    const r = lerArquivoContagem('7\u00008\u00009\u0000;1\n\u0000\n');
    expect(r.leituras).toEqual([]);
    expect(r.invalidas.map((i) => [i.linha, i.codigo])).toEqual([
      [1, null],
      [2, null],
    ]);
    expect(r.invalidas[0]!.mensagem).toMatch(/caractere de controle/);
  });

  it('um só ponto ou vírgula com 3 dígitos depois é decimal, marcado como ambíguo (milhar do Excel?)', () => {
    const r = lerArquivoContagem('A;1.000\nA;2,500\nA;0,500\nA;1.5\nA;1.234,5\nA;12\nA;1234.000\n');
    expect(r.leituras.map((l) => l.quantidade)).toEqual([
      '1.000',
      '2.500',
      '0.500',
      '1.500',
      '1234.500',
      '12.000',
      '1234.000',
    ]);
    expect(r.milharAmbiguo).toEqual([1, 2]);
  });
});

describe('consolidarContagem', () => {
  it('fardo de 12 e caixa de 24 viram unidades, e as leituras repetidas somam', () => {
    const { leituras } = lerArquivoContagem(
      [
        '7891149103102;5', // 5 unidades
        '17891149103109;2', // 2 fardos de 12 = 24
        'REF2L;3',
        '27891149103106;1', // 1 caixa de 24
        '7891149103102;1,5', // + 1,5
        '17891149103109;1', // + 12
      ].join('\n'),
    );
    const r = consolidarContagem(leituras, resolver);
    expect(r.problemas).toEqual([]);
    expect(r.itens.map((i) => [i.produto.id, i.quantidade, i.leituras])).toEqual([
      ['p1', '66.500', 5],
      ['p2', '3.000', 1],
    ]);
    expect(r.itens[0]!.codigos).toEqual([
      { codigo: '7891149103102', fator: '1.000', leituras: 2, quantidadeLida: '6.500' },
      { codigo: '17891149103109', fator: '12.000', leituras: 2, quantidadeLida: '3.000' },
      { codigo: '27891149103106', fator: '24.000', leituras: 1, quantidadeLida: '1.000' },
    ]);
  });

  it('não encontrado, ambíguo e sem estoque ficam de fora, um problema por código com as linhas', () => {
    const { leituras } = lerArquivoContagem(
      'X1;2\n7890000000001;4\nREF2L;1\n7890000000001;1\n7890000000002;3\nX1;1\n',
    );
    const r = consolidarContagem(leituras, resolver);
    expect(r.itens.map((i) => [i.produto.id, i.quantidade])).toEqual([['p2', '1.000']]);
    expect(r.problemas.map((p) => [p.tipo, p.codigo, p.linhas, p.leituras, p.quantidadeLida])).toEqual([
      ['nao_encontrado', 'X1', [1, 6], 2, '3.000'],
      ['ambiguo', '7890000000001', [2, 4], 2, '5.000'],
      ['sem_estoque', '7890000000002', [5], 1, '3.000'],
    ]);
    expect(r.problemas[1]!.produtos.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(r.problemas[2]!.mensagem).toBe('Combo não tem estoque próprio');
  });

  it('o total do produto acima do máximo (quantidade enorme × fardo de 12) vira problema e não item', () => {
    const { leituras } = lerArquivoContagem('REF2L;1\n17891149103109;100000000000\n7891149103102;1\n');
    const r = consolidarContagem(leituras, resolver);
    expect(r.itens.map((i) => i.produto.id)).toEqual(['p2']);
    expect(r.problemas).toHaveLength(1);
    expect(r.problemas[0]).toMatchObject({
      tipo: 'acima_do_maximo',
      codigo: '17891149103109, 7891149103102',
      linhas: [2, 3],
      leituras: 2,
      quantidadeLida: '100000000001.000',
      produtos: [cerveja],
    });
  });
});

describe('dividirEmRascunhos', () => {
  it('enche o atual até 5.000 e abre os próximos', () => {
    const d = dividirEmRascunhos(0, 6000);
    expect(d.filter((x) => x === 0)).toHaveLength(5000);
    expect(d.filter((x) => x === 1)).toHaveLength(1000);
    expect(dividirEmRascunhos(4998, 3)).toEqual([0, 0, 1]);
    expect(dividirEmRascunhos(5000, 2, 5000)).toEqual([1, 1]);
    expect(dividirEmRascunhos(0, 5, 2)).toEqual([0, 0, 1, 1, 2]);
  });
});

describe('opcoesImportarContagemSchema', () => {
  it('padrões, campos do formulário e a versão exigida na gravação', () => {
    expect(opcoesImportarContagemSchema.parse({})).toEqual({
      modo: 'previa',
      zerarNaoContados: false,
      itensExistentes: 'somar',
      versao: undefined,
    });
    expect(
      opcoesImportarContagemSchema.parse({
        modo: 'gravar',
        zerarNaoContados: 'true',
        itensExistentes: 'substituir',
        versao: '3',
      }),
    ).toEqual({ modo: 'gravar', zerarNaoContados: true, itensExistentes: 'substituir', versao: 3 });
    const r = opcoesImportarContagemSchema.safeParse({ modo: 'gravar' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['versao']);
  });
});
