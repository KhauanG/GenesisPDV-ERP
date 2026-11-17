/**
 * Percurso comum do `.zip` (`percorrerZip`; README da API › decisão 197): o arquivo é exatamente o que o diretório
 * central descreve — cabeçalhos locais um atrás do outro desde o byte 0, iguais às entradas centrais (nome, método,
 * flags, tamanhos ou o descritor de dados), sem bytes antes, entre ou depois e sem duas entradas no mesmo cabeçalho —,
 * e a taxa de compressão vale também para o arquivo inteiro. O arquivo pequeno com cabeçalhos ZIP64 (o extra 0x0001 no
 * cabeçalho local, o registro de fim ZIP64) é aceito, conferido igual. Zips de teste pequenos, montados no teste
 * (`test/fixtures/nfe/montar-zip.ts`).
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  comFimZip64,
  entradaSoLocal,
  fimSemEntradas,
  inserirAntesDoCentral,
  montarZip,
} from '../../test/fixtures/nfe/montar-zip.js';
import { percorrerZip, RecusaZip, type LimitesZip } from './zip.js';

const LIMITES: LimitesZip = {
  entradas: 100,
  totalBytes: 10 * 1024 * 1024,
  taxa: 100,
  taxaAPartirDeBytes: 64 * 1024,
};

/** Os nomes e os conteúdos lidos pelo percurso. */
async function ler(zip: Buffer, limites = LIMITES): Promise<Array<[string, string]>> {
  const lidas: Array<[string, string]> = [];
  await percorrerZip(zip, limites, async (e) => {
    lidas.push([e.nome, (await e.ler()).toString('utf8')]);
  });
  return lidas;
}

const recusa = (motivo: RecusaZip['motivo']) => expect.objectContaining({ name: 'RecusaZip', motivo });

/** O fim (EOCD) de um zip sem comentário: os últimos 22 bytes. */
const fimDe = (zip: Buffer) => zip.length - 22;

describe('percorrerZip: um zip só, sem bytes de fora', () => {
  it('zip normal, com e sem descritor de dados, é lido como sempre', async () => {
    const entradas = [
      { nome: 'a.xml', dados: Buffer.from('<a/>') },
      { nome: 'b.xml', dados: Buffer.from('<b/>'), guardar: true },
    ];
    expect(await ler(montarZip(entradas))).toEqual([
      ['a.xml', '<a/>'],
      ['b.xml', '<b/>'],
    ]);
    expect(await ler(montarZip(entradas.map((e) => ({ ...e, descritor: true }))))).toEqual([
      ['a.xml', '<a/>'],
      ['b.xml', '<b/>'],
    ]);
  });

  it('cabeçalho local sem entrada no diretório central (o fim sem entradas) é recusado sem descompactar', async () => {
    for (const descritor of [false, true]) {
      const soLocal = entradaSoLocal('xl/worksheets/sheet1.xml', Buffer.alloc(1024 * 1024), descritor);
      const chamadas: string[] = [];
      await expect(
        percorrerZip(Buffer.concat([soLocal, fimSemEntradas(soLocal.length)]), LIMITES, (e) => {
          chamadas.push(e.nome);
        }),
      ).rejects.toEqual(recusa('corrompido'));
      expect(chamadas).toEqual([]);
      // O fim que aponta o diretório para o byte 0 também.
      await expect(ler(Buffer.concat([soLocal, fimSemEntradas(0)]))).rejects.toEqual(recusa('corrompido'));
    }
    // Só o fim, sem entradas e sem mais nada, é um zip vazio.
    expect(await ler(fimSemEntradas(0))).toEqual([]);
  });

  it('entrada a mais entre as entradas e o diretório central é recusada', async () => {
    const zip = montarZip([{ nome: 'xl/worksheets/sheet1.xml', dados: Buffer.from('<ok/>') }]);
    expect(await ler(zip)).toEqual([['xl/worksheets/sheet1.xml', '<ok/>']]);
    const comExtra = inserirAntesDoCentral(
      zip,
      entradaSoLocal('xl/worksheets/sheet1.xml', Buffer.from('<x/>')),
    );
    await expect(ler(comExtra)).rejects.toEqual(recusa('corrompido'));
  });

  it('bytes antes do primeiro cabeçalho ou depois do fim são recusados', async () => {
    const zip = montarZip([{ nome: 'a.xml', dados: Buffer.from('<a/>') }]);
    await expect(ler(Buffer.concat([zip, Buffer.from('lixo')]))).rejects.toEqual(recusa('corrompido'));
    // Prefixo com os deslocamentos corrigidos (o zip continua coerente por dentro): também recusado.
    const prefixo = Buffer.from('MZ-prefixo');
    const comPrefixo = Buffer.concat([prefixo, zip]);
    const fim = fimDe(comPrefixo);
    const inicioCentral = comPrefixo.readUInt32LE(fim + 16) + prefixo.length;
    comPrefixo.writeUInt32LE(inicioCentral, fim + 16);
    comPrefixo.writeUInt32LE(prefixo.length, inicioCentral + 42);
    await expect(ler(comPrefixo)).rejects.toEqual(recusa('corrompido'));
    // O comentário do fim, declarado no próprio fim, continua aceito.
    const comComentario = Buffer.concat([zip, Buffer.from('comentario')]);
    comComentario.writeUInt16LE(10, fimDe(zip) + 20);
    expect(await ler(comComentario)).toEqual([['a.xml', '<a/>']]);
  });

  it('cabeçalho local diferente da entrada central (nome, tamanho, método, flag) é recusado', async () => {
    const base = () => montarZip([{ nome: 'a.xml', dados: Buffer.from('<a>conteudo</a>') }]);
    const nome = base();
    nome.write('b', 30);
    await expect(ler(nome)).rejects.toEqual(recusa('corrompido'));
    const tamanho = base();
    tamanho.writeUInt32LE(64 * 1024 * 1024, 22);
    await expect(ler(tamanho)).rejects.toEqual(recusa('corrompido'));
    const compactado = base();
    compactado.writeUInt32LE(compactado.readUInt32LE(18) + 1, 18);
    await expect(ler(compactado)).rejects.toEqual(recusa('corrompido'));
    const metodo = base();
    metodo.writeUInt16LE(0, 8);
    await expect(ler(metodo)).rejects.toEqual(recusa('corrompido'));
    const flag = base();
    flag.writeUInt16LE(flag.readUInt16LE(6) | 0x08, 6);
    await expect(ler(flag)).rejects.toEqual(recusa('corrompido'));
  });

  it('descritor de dados diferente do diretório central é recusado', async () => {
    const dados = Buffer.from('<a>conteudo</a>');
    const zip = montarZip([{ nome: 'a.xml', dados, descritor: true }]);
    const descritor = 30 + 'a.xml'.length + deflateRawSync(dados).length;
    expect(zip.readUInt32LE(descritor)).toBe(0x08074b50);
    zip.writeUInt32LE(dados.length + 1, descritor + 12);
    await expect(ler(zip)).rejects.toEqual(recusa('corrompido'));
  });

  it('duas entradas centrais no mesmo cabeçalho local são recusadas', async () => {
    const zip = montarZip([
      { nome: 'a.xml', dados: Buffer.from('<a/>'), guardar: true },
      { nome: 'a.xml', dados: Buffer.from('<a/>'), guardar: true },
    ]);
    expect(await ler(zip)).toHaveLength(2);
    // A segunda entrada central aponta para o primeiro cabeçalho local.
    const inicioCentral = zip.readUInt32LE(fimDe(zip) + 16);
    zip.writeUInt32LE(0, inicioCentral + 46 + 'a.xml'.length + 42);
    await expect(ler(zip)).rejects.toEqual(recusa('corrompido'));
  });

  it('a taxa de compressão vale para o arquivo inteiro: muitas entradas pequenas não somam o que uma grande não pode', async () => {
    // Cada entrada (60 KiB) fica abaixo do limite da taxa por entrada (64 KiB); juntas passam dele a mais de 100:1.
    const pequenas = Array.from({ length: 20 }, (_, i) => ({
      nome: `p${i}.xml`,
      dados: Buffer.alloc(60 * 1024),
    }));
    await expect(ler(montarZip(pequenas))).rejects.toEqual(recusa('grande_demais'));
    // Com o total abaixo do limite, as mesmas entradas passam.
    expect(await ler(montarZip(pequenas.slice(0, 1)))).toHaveLength(1);
  });

  describe('arquivo pequeno com cabeçalhos ZIP64 (quem grava com o ZIP64 sempre ligado)', () => {
    const entradas = [
      { nome: 'nota.xml', dados: Buffer.from('<nota>1</nota>'), zip64: true },
      { nome: 'nota2.xml', dados: Buffer.from('<nota>2</nota>'), zip64: true, guardar: true },
    ];
    const lidas = [
      ['nota.xml', '<nota>1</nota>'],
      ['nota2.xml', '<nota>2</nota>'],
    ];
    /** Início dos dados do extra ZIP64 do primeiro cabeçalho local. */
    const extra = 30 + 'nota.xml'.length + 4;

    it('cabeçalho local com os tamanhos no extra ZIP64, com e sem descritor de dados, é lido', async () => {
      const zip = montarZip(entradas);
      expect(zip.readUInt32LE(18)).toBe(0xffffffff);
      expect(zip.readUInt16LE(extra - 4)).toBe(0x0001);
      expect(await ler(zip)).toEqual(lidas);
      // Gravado em fluxo: o extra zerado e o descritor com os tamanhos de 8 bytes.
      expect(await ler(montarZip(entradas.map((e) => ({ ...e, descritor: true }))))).toEqual(lidas);
    });

    it('registro de fim ZIP64 e localizador entre o diretório central e o fim são aceitos', async () => {
      expect(await ler(comFimZip64(montarZip(entradas)))).toEqual(lidas);
      expect(await ler(comFimZip64(montarZip([{ nome: 'a.xml', dados: Buffer.from('<a/>') }])))).toEqual([
        ['a.xml', '<a/>'],
      ]);
    });

    it('extra ZIP64 do cabeçalho local diferente do diretório central é recusado', async () => {
      const descompactado = montarZip(entradas);
      descompactado.writeUInt32LE(descompactado.readUInt32LE(extra) + 1, extra);
      await expect(ler(descompactado)).rejects.toEqual(recusa('corrompido'));
      const compactado = montarZip(entradas);
      compactado.writeUInt32LE(compactado.readUInt32LE(extra + 8) + 1, extra + 8);
      await expect(ler(compactado)).rejects.toEqual(recusa('corrompido'));
      // Acima de 32 bits.
      const alto = montarZip(entradas);
      alto.writeUInt32LE(1, extra + 4);
      await expect(ler(alto)).rejects.toEqual(recusa('corrompido'));
      // Sem o extra (o id trocado) ou com os tamanhos em 0xFFFFFFFF só num dos campos.
      const semExtra = montarZip(entradas);
      semExtra.writeUInt16LE(0x5455, extra - 4);
      await expect(ler(semExtra)).rejects.toEqual(recusa('corrompido'));
      const umCampo = montarZip(entradas);
      umCampo.writeUInt32LE(umCampo.readUInt32LE(extra + 8), 18);
      await expect(ler(umCampo)).rejects.toEqual(recusa('corrompido'));
      // O descritor de 8 bytes que não repete o diretório central.
      const fluxo = montarZip([
        { nome: 'nota.xml', dados: Buffer.from('<nota>1</nota>'), zip64: true, descritor: true },
      ]);
      const d = extra + 16 + deflateRawSync(Buffer.from('<nota>1</nota>')).length;
      expect(fluxo.readUInt32LE(d)).toBe(0x08074b50);
      fluxo.writeUInt32LE(1, d + 12);
      await expect(ler(fluxo)).rejects.toEqual(recusa('corrompido'));
    });

    it('registro de fim ZIP64 incoerente com o fim, ou outros bytes no lugar dele, é recusado', async () => {
      const base = () => comFimZip64(montarZip(entradas));
      /** Início do registro de fim ZIP64 (o localizador vem 56 bytes depois). */
      const registroDe = (zip: Buffer) => zip.length - 22 - 20 - 56;
      for (const [deslocamento, valor] of [
        [24, 3], // entradas neste disco
        [32, 3], // entradas no total
        [40, 1], // tamanho do diretório central
        [48, 1], // início do diretório central
        [16, 1], // número do disco
        [56 + 8, 1], // o localizador aponta para outro lugar
        [56 + 16, 2], // mais de um disco
      ] as const) {
        const zip = base();
        const r = registroDe(zip);
        zip.writeUInt32LE(zip.readUInt32LE(r + deslocamento) + valor, r + deslocamento);
        await expect(ler(zip), `deslocamento ${deslocamento}`).rejects.toEqual(recusa('corrompido'));
      }
      // Só o localizador, sem o registro: o diretório central não chega até ele.
      const zip = montarZip(entradas);
      const soLocalizador = comFimZip64(zip);
      const r = registroDe(soLocalizador);
      const semRegistro = Buffer.concat([soLocalizador.subarray(0, r), soLocalizador.subarray(r + 56)]);
      await expect(ler(semRegistro)).rejects.toEqual(recusa('corrompido'));
      // Outros bytes do mesmo tamanho no lugar do par: recusados como antes.
      const lixo = base();
      lixo.fill(0x41, registroDe(lixo), lixo.length - 22);
      await expect(ler(lixo)).rejects.toEqual(recusa('corrompido'));
    });
  });
});
