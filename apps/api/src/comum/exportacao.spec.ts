/**
 * Planilha em streaming (F2-B29, README da API › decisão 177): as abas do `.xlsx` acima do teto, texto que parece
 * fórmula continua texto, a data na hora de Brasília, o `.csv` com as regras do síncrono e a pressão de volta (o lote
 * seguinte espera o destino esvaziar e, no `.xlsx`, a entrada do zip). Também o corte das colunas de custo.
 */
import { PassThrough, Writable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abrirEscritorPlanilha, colunasVisiveis, entradaDoZip, type ColunaExportacao } from './exportacao.js';

interface Linha {
  n: number;
  texto: string;
  quando: Date | null;
  ativo: boolean;
}

const COLUNAS: ColunaExportacao<Linha>[] = [
  { rotulo: 'N', valor: (l) => l.n },
  { rotulo: 'Texto', valor: (l) => l.texto },
  { rotulo: 'Quando', valor: (l) => l.quando },
  { rotulo: 'Ativo', valor: (l) => l.ativo },
  { rotulo: 'Custo', valor: (l) => l.n / 4, custo: true },
];

const linhas = (n: number): Linha[] =>
  Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    texto: i === 0 ? '=1+1' : `Produto; "${i + 1}"`,
    quando: i === 0 ? new Date('2026-11-07T15:30:00Z') : null,
    ativo: i % 2 === 0,
  }));

async function gerar(formato: 'xlsx' | 'csv', lotes: Linha[][], linhasPorAba?: number) {
  const saida = new PassThrough();
  const conteudo = buffer(saida);
  const escritor = abrirEscritorPlanilha(formato, COLUNAS, saida, { linhasPorAba });
  for (const lote of lotes) await escritor.escrever(lote);
  const fim = await escritor.fechar();
  return { ...fim, conteudo: await conteudo };
}

describe('abrirEscritorPlanilha (xlsx)', () => {
  it('abre uma aba nova com o cabeçalho ao passar do teto; texto com "=" não vira fórmula; data em Brasília', async () => {
    const todas = linhas(5);
    const r = await gerar('xlsx', [todas.slice(0, 3), todas.slice(3)], 2);
    expect(r).toMatchObject({ linhas: 5, abas: 3 });
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(r.conteudo as unknown as ArrayBuffer);
    expect(livro.worksheets.map((a) => [a.name, a.rowCount])).toEqual([
      ['Relatório', 3],
      ['Relatório (2)', 3],
      ['Relatório (3)', 2],
    ]);
    const aba = livro.worksheets[0]!;
    expect((aba.getRow(1).values as unknown[]).slice(1)).toEqual(['N', 'Texto', 'Quando', 'Ativo', 'Custo']);
    expect(aba.getRow(1).font?.bold).toBe(true);
    const formula = aba.getCell('B2');
    expect(formula.type).toBe(ExcelJS.ValueType.String);
    expect(formula.value).toBe('=1+1');
    // 15:30 UTC = 12:30 em Brasília: a célula guarda a hora de parede.
    expect(aba.getCell('C2').value).toEqual(new Date('2026-11-07T12:30:00Z'));
    expect(aba.getCell('C2').numFmt).toBe('dd/mm/yyyy hh:mm');
    expect(aba.getCell('D2').value).toBe('Sim');
    expect(aba.getCell('D3').value).toBe('Não');
    expect(aba.getCell('C3').value).toBeNull();
    expect(aba.getCell('E3').value).toBe(0.5);
    expect(livro.worksheets[2]!.getCell('A2').value).toBe(5);
  });

  it('sem linhas: uma aba só com o cabeçalho', async () => {
    const r = await gerar('xlsx', []);
    expect(r).toMatchObject({ linhas: 0, abas: 1 });
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(r.conteudo as unknown as ArrayBuffer);
    expect(livro.worksheets[0]!.rowCount).toBe(1);
  });
});

describe('abrirEscritorPlanilha (csv)', () => {
  it('BOM, `;`, vírgula decimal, aspas e a proteção contra fórmula do síncrono', async () => {
    const r = await gerar('csv', [linhas(2)]);
    expect(r).toMatchObject({ linhas: 2, abas: 1 });
    expect(r.conteudo.toString('utf8')).toBe(
      '﻿N;Texto;Quando;Ativo;Custo\r\n' +
        "1;'=1+1;07/11/2026 12:30;Sim;0,25\r\n" +
        '2;"Produto; ""2""";;Não;0,5\r\n',
    );
  });
});

describe('pressão de volta', () => {
  it('o lote só termina quando o destino cheio esvazia', async () => {
    const liberar: Array<() => void> = [];
    const destino = new Writable({
      highWaterMark: 16,
      write(_pedaco, _cod, cb) {
        liberar.push(cb);
      },
    });
    const escritor = abrirEscritorPlanilha('csv', COLUNAS, destino);
    let terminou = false;
    const escrita = escritor.escrever(linhas(50)).then(() => (terminou = true));
    await new Promise((ok) => setImmediate(ok));
    expect(terminou).toBe(false);
    while (!terminou) {
      liberar.shift()?.();
      await new Promise((ok) => setImmediate(ok));
    }
    await escrita;
    expect(terminou).toBe(true);
  });

  it('xlsx: o destino destruído sem erro (o envio parou de ler) faz o fechar rejeitar em vez de esperar para sempre', async () => {
    const destino = new PassThrough({ highWaterMark: 16 });
    const escritor = abrirEscritorPlanilha('xlsx', COLUNAS, destino);
    destino.resume();
    await escritor.escrever(linhas(10));
    destino.destroy();
    await expect(escritor.fechar()).rejects.toThrow('O envio do arquivo foi interrompido.');
    // E com o fechar já esperando o fim do zip quando o destino cai.
    const outro = new PassThrough();
    const segundo = abrirEscritorPlanilha('xlsx', COLUNAS, outro);
    await segundo.escrever(linhas(10));
    const fechando = segundo.fechar();
    outro.destroy();
    await expect(fechando).rejects.toThrow('O envio do arquivo foi interrompido.');
  });

  it('o destino destruído com erro rejeita o lote seguinte', async () => {
    const destino = new PassThrough({ highWaterMark: 16 });
    const escritor = abrirEscritorPlanilha('csv', COLUNAS, destino);
    const escrita = escritor.escrever(linhas(50));
    destino.destroy(new Error('envio caiu'));
    await expect(escrita).rejects.toThrow('envio caiu');
    await expect(escritor.escrever(linhas(1))).rejects.toThrow('envio caiu');
  });
});

describe('entrada do zip do exceljs (decisão 177)', () => {
  it('a aba escreve num PassThrough com o estado de pressão que a exportação espera esvaziar', async () => {
    const saida = new PassThrough();
    const conteudo = buffer(saida);
    const livro = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: saida, useSharedStrings: false });
    const aba = livro.addWorksheet('x');
    expect(entradaDoZip(null)).toBeUndefined();
    for (let i = 0; i < 2000; i++) aba.addRow([i, 'PRODUTO CARGA', new Date()]).commit();
    const entrada = entradaDoZip(aba);
    // Se uma versão nova do exceljs (ou do archiver) mudar o encanamento, a pressão de volta da aba se perde: aqui quebra.
    expect(entrada).toBeDefined();
    expect(
      typeof (entrada as unknown as { _writableState?: { needDrain?: boolean } })._writableState?.needDrain,
    ).toBe('boolean');
    aba.commit();
    await livro.commit();
    expect((await conteudo).subarray(0, 2).toString()).toBe('PK');
  });

  afterEach(() => vi.restoreAllMocks());

  it('o lote do xlsx só termina com a entrada do zip esvaziada, mesmo com o destino lendo na hora', async () => {
    // Sem esperar a entrada do zip (`folga(destino)` sem o segundo argumento), 10 mil linhas ficam paradas nela sem
    // comprimir — fora do heap, onde a carga de 1 milhão de linhas não mede — e este teste quebra.
    const addWorksheet = vi.spyOn(ExcelJS.stream.xlsx.WorkbookWriter.prototype, 'addWorksheet');
    const destino = new PassThrough();
    const conteudo = buffer(destino);
    const escritor = abrirEscritorPlanilha('xlsx', COLUNAS, destino);
    const lote = linhas(10_000);
    for (let i = 0; i < 3; i++) {
      await escritor.escrever(lote);
      const entrada = entradaDoZip(addWorksheet.mock.results[0]!.value as ExcelJS.Worksheet);
      const estado = (
        entrada as unknown as {
          _writableState: { needDrain: boolean; length: number; highWaterMark: number };
        }
      )._writableState;
      expect(estado.needDrain).toBe(false);
      expect(estado.length).toBeLessThan(estado.highWaterMark);
    }
    expect(await escritor.fechar()).toEqual({ linhas: 30_000, abas: 1 });
    expect((await conteudo).subarray(0, 2).toString()).toBe('PK');
  });
});

describe('colunasVisiveis', () => {
  it('tira as colunas de custo sem produtos.ver_custo', () => {
    expect(colunasVisiveis(COLUNAS, { permissoes: new Set() }).map((c) => c.rotulo)).toEqual([
      'N',
      'Texto',
      'Quando',
      'Ativo',
    ]);
    expect(colunasVisiveis(COLUNAS, { permissoes: new Set(['produtos.ver_custo']) })).toHaveLength(5);
  });
});
