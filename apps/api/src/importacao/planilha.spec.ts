/**
 * Decodificação do texto das importações (planilha CSV e contagem do coletor, F2-B9): UTF-8 com e sem BOM, Windows-1252
 * e UTF-16 (o "Texto Unicode" do Excel), com e sem BOM, sem o U+0000 entre os caracteres que o Postgres recusa. E a
 * leitura do `.xlsx` (README da API › decisão 197): o leitor só recebe as entradas conferidas e já descompactadas
 * dentro dos limites; o zip fora da estrutura (entrada só no cabeçalho local, tamanhos que divergem) é recusado antes.
 */
import { lerArquivoContagem } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import {
  entradaSoLocal,
  fimSemEntradas,
  inserirAntesDoCentral,
  montarZip,
} from '../../test/fixtures/nfe/montar-zip.js';
import { conferirZip, decodificarTexto, lerPlanilha } from './planilha.js';

const TEXTO = 'Código;Qtd\r\n7891149103102;2,5\r\nAÇÚCAR;1\r\n';

describe('decodificarTexto', () => {
  it('UTF-8 com e sem BOM e Windows-1252', () => {
    expect(decodificarTexto(Buffer.from(TEXTO, 'utf8'))).toBe(TEXTO);
    expect(decodificarTexto(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXTO)]))).toBe(
      TEXTO,
    );
    expect(decodificarTexto(Buffer.from(TEXTO, 'latin1'))).toBe(TEXTO);
  });

  it('UTF-16 LE e BE com BOM e LE sem BOM viram o mesmo texto, sem U+0000', () => {
    const le = Buffer.from(TEXTO, 'utf16le');
    const be = Buffer.from(le).swap16();
    expect(decodificarTexto(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))).toBe(TEXTO);
    expect(decodificarTexto(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(TEXTO);
    expect(decodificarTexto(le)).toBe(TEXTO);
    expect(decodificarTexto(be)).toBe(TEXTO);
  });

  it('o arquivo do coletor salvo como "Texto Unicode" é lido como as leituras de sempre', () => {
    const corpo = '7891149103102\r\n7891149103102\r\n17891149103109\r\n';
    const lido = lerArquivoContagem(
      decodificarTexto(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(corpo, 'utf16le')])),
    );
    expect(lido.invalidas).toEqual([]);
    expect(lido.leituras.map((l) => l.codigo)).toEqual(['7891149103102', '7891149103102', '17891149103109']);
  });
});

/** Uma planilha pequena como o `write-excel-file` grava (em fluxo: descritor de dados em cada entrada). */
const xlsxDeTeste = (): Promise<Buffer> =>
  writeXlsxFile([
    [{ value: 'Nome' }, { value: 'Preço' }],
    [{ value: 'CERV TESTE LT 350ML' }, { value: 3.49 }],
  ]).toBuffer();

const LIDA = {
  cabecalho: ['Nome', 'Preço'],
  linhas: [{ numero: 2, valores: ['CERV TESTE LT 350ML', 3.49] }],
};
const CORROMPIDO = 'O arquivo .xlsx está corrompido.';

/** Uma aba com uma célula de texto, para a entrada que não está no diretório central. */
const ABA_DE_FORA = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>DE FORA</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>X</t></is></c></row></sheetData></worksheet>',
);

describe('lerPlanilha (.xlsx)', () => {
  it('a planilha gravada em fluxo (descritor de dados) e a regravada sem ele são lidas igual', async () => {
    const xlsx = await xlsxDeTeste();
    expect(xlsx.readUInt16LE(6) & 0x08).toBe(0x08);
    expect(await lerPlanilha('p.xlsx', xlsx)).toEqual(LIDA);
    const regravada = montarZip((await conferirZip(xlsx)).map((e) => ({ nome: e.nome, dados: e.conteudo })));
    expect(await lerPlanilha('p.xlsx', regravada)).toEqual(LIDA);
  });

  it('entrada só no cabeçalho local, antes do diretório central, é recusada (o leitor não a vê)', async () => {
    const comExtra = inserirAntesDoCentral(
      await xlsxDeTeste(),
      entradaSoLocal('xl/worksheets/sheet1.xml', ABA_DE_FORA, true),
    );
    await expect(lerPlanilha('p.xlsx', comExtra)).rejects.toMatchObject({ message: CORROMPIDO });
  });

  it('o arquivo só com cabeçalho local e o fim sem entradas é recusado antes de descompactar', async () => {
    // 16 MiB de zeros comprimem para uns 16 KiB; nenhuma entrada do diretório central a conferir.
    const soLocal = entradaSoLocal('xl/worksheets/sheet1.xml', Buffer.alloc(16 * 1024 * 1024), true);
    const arquivo = Buffer.concat([soLocal, fimSemEntradas(soLocal.length)]);
    expect(arquivo.length).toBeLessThan(64 * 1024);
    await expect(lerPlanilha('p.xlsx', arquivo)).rejects.toMatchObject({ message: CORROMPIDO });
  });

  it('o cabeçalho local que declara outro tamanho que o diretório central é recusado', async () => {
    const regravada = montarZip(
      (await conferirZip(await xlsxDeTeste())).map((e) => ({
        nome: e.nome,
        dados: e.conteudo,
        guardar: true,
      })),
    );
    // O primeiro cabeçalho local passa a declarar 64 MiB descompactados (o central continua com o tamanho real).
    regravada.writeUInt32LE(64 * 1024 * 1024, 22);
    await expect(lerPlanilha('p.xlsx', regravada)).rejects.toMatchObject({ message: CORROMPIDO });
  });
});
