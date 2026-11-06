/**
 * Decodificação do texto das importações (planilha CSV e contagem do coletor, F2-B9): UTF-8 com e sem BOM, Windows-1252
 * e UTF-16 (o "Texto Unicode" do Excel), com e sem BOM, sem o U+0000 entre os caracteres que o Postgres recusa.
 */
import { lerArquivoContagem } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { decodificarTexto } from './planilha.js';

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
