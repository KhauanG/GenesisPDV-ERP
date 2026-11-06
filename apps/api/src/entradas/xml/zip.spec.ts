/**
 * XMLs de NF-e num `.zip` (F2-B18; README da API › decisão 163): os `.xml` saem na ordem, o que não é XML é pulado, o
 * XML acima do teto do parser é recusado sozinho, e a zip-bomba (taxa de compressão, total descompactado, cabeçalho
 * que mente o tamanho, entradas demais) recusa o arquivo inteiro antes de ocupar a memória. O percurso é o mesmo da
 * planilha (`percorrerZip`), com limites próprios.
 */
import { LIMITES_XML_NFE } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { fixtureNfe } from '../../../test/fixtures/nfe/fixtures.js';
import { montarZip } from '../../../test/fixtures/nfe/montar-zip.js';
import { conferirZip, LIMITES_ZIP } from '../../importacao/planilha.js';
import { lerXmlNfe } from './parser.js';
import { ehZip, extrairXmlsDoZip, LIMITES_ZIP_NFE } from './zip.js';

describe('XMLs dentro do zip', () => {
  it('extrai os .xml na ordem, pula pastas e o que não é XML, e o XML lido é o mesmo', async () => {
    const xml1 = Buffer.from(fixtureNfe('01-icms-st.xml'));
    const xml2 = Buffer.from(fixtureNfe('07-rastro-cd.xml'));
    const zip = montarZip([
      { nome: 'notas/', dados: Buffer.alloc(0), guardar: true },
      { nome: 'notas/01.xml', dados: xml1 },
      { nome: 'leia-me.txt', dados: Buffer.from('oi') },
      { nome: 'notas/07.XML', dados: xml2, guardar: true },
    ]);
    expect(ehZip(zip)).toBe(true);
    const r = await extrairXmlsDoZip(zip);
    expect(r.xmls.map((x) => x.nome)).toEqual(['notas/01.xml', 'notas/07.XML']);
    expect(r.pulados).toEqual(['leia-me.txt']);
    expect(r.grandesDemais).toEqual([]);
    expect(lerXmlNfe(r.xmls[0]!.conteudo).nota.numero).toBe(12345);
    expect(r.xmls[1]!.conteudo.equals(xml2)).toBe(true);
  });

  it('XML acima do teto do parser é recusado sozinho, sem derrubar o lote', async () => {
    const grande = Buffer.alloc(LIMITES_XML_NFE.bytes + 10, 0x41);
    const r = await extrairXmlsDoZip(
      montarZip([
        { nome: 'grande.xml', dados: grande, guardar: true },
        { nome: 'ok.xml', dados: Buffer.from(fixtureNfe('02-fcp-st.xml')) },
      ]),
    );
    expect(r.grandesDemais).toEqual(['grande.xml']);
    expect(r.xmls.map((x) => x.nome)).toEqual(['ok.xml']);
  });

  it('zip-bomba (taxa de compressão acima do teto) é recusada inteira', async () => {
    const zeros = Buffer.alloc(20 * 1024 * 1024);
    await expect(extrairXmlsDoZip(montarZip([{ nome: 'bomba.xml', dados: zeros }]))).rejects.toMatchObject({
      motivo: 'ZIP_GRANDE_DEMAIS',
    });
  });

  it('o cabeçalho que mente o tamanho para na descompactação, com o teto declarado', async () => {
    const texto = Buffer.from('<a>'.padEnd(200_000, 'x') + '</a>');
    await expect(
      extrairXmlsDoZip(montarZip([{ nome: 'mente.xml', dados: texto, declarado: 1000 }])),
    ).rejects.toMatchObject({ motivo: 'ZIP_GRANDE_DEMAIS' });
  });

  it('total descompactado acima do teto e entradas demais são recusados', async () => {
    const pedaco = Buffer.alloc(LIMITES_XML_NFE.bytes - 1, 0x41);
    const muitas = Array.from(
      { length: Math.ceil(LIMITES_ZIP_NFE.totalBytes / pedaco.length) + 1 },
      (_, i) => ({
        nome: `n${i}.xml`,
        dados: pedaco,
        guardar: true,
      }),
    );
    await expect(extrairXmlsDoZip(montarZip(muitas))).rejects.toMatchObject({ motivo: 'ZIP_GRANDE_DEMAIS' });
    const demais = Array.from({ length: LIMITES_ZIP_NFE.entradas + 1 }, (_, i) => ({
      nome: `v${i}.txt`,
      dados: Buffer.alloc(0),
      guardar: true,
    }));
    await expect(extrairXmlsDoZip(montarZip(demais))).rejects.toMatchObject({ motivo: 'ZIP_GRANDE_DEMAIS' });
  });

  it('zip corrompido é recusado', async () => {
    await expect(extrairXmlsDoZip(Buffer.from('PK\u0003\u0004 qualquer coisa'))).rejects.toMatchObject({
      motivo: 'ZIP_CORROMPIDO',
    });
    const zip = montarZip([{ nome: 'a.xml', dados: Buffer.from('<a/>') }]);
    await expect(extrairXmlsDoZip(zip.subarray(0, zip.length - 30))).rejects.toMatchObject({
      motivo: 'ZIP_CORROMPIDO',
    });
  });

  it('o percurso é o da planilha, com limites próprios: o que a planilha recusa o zip de NF-e aceita, e vice-versa', async () => {
    const vazias = (n: number, ext: string) =>
      Array.from({ length: n }, (_, i) => ({ nome: `v${i}.${ext}`, dados: Buffer.alloc(0), guardar: true }));
    const muitas = montarZip(vazias(LIMITES_ZIP.entradas + 1, 'xml'));
    await expect(conferirZip(muitas)).rejects.toMatchObject({
      message: expect.stringContaining('grande demais'),
    });
    expect((await extrairXmlsDoZip(muitas)).xmls).toHaveLength(LIMITES_ZIP.entradas + 1);
    // 200 KiB de um caractere só: taxa acima de 100, conferida acima de 64 KiB no zip de NF-e e de 1 MiB na planilha.
    const comprimivel = montarZip([{ nome: 'a.xml', dados: Buffer.alloc(200 * 1024, 0x41) }]);
    await expect(conferirZip(comprimivel)).resolves.toBeUndefined();
    await expect(extrairXmlsDoZip(comprimivel)).rejects.toMatchObject({ motivo: 'ZIP_GRANDE_DEMAIS' });
    // O corrompido é o mesmo para os dois.
    await expect(conferirZip(muitas.subarray(0, muitas.length - 30))).rejects.toMatchObject({
      message: expect.stringContaining('corrompido'),
    });
  });
});
