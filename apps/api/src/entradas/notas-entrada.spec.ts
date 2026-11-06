/**
 * Upload da NF-e (F2-B19; README da API › decisão 164): a separação dos arquivos do envio (XML solto, XMLs de dentro
 * do `.zip`, o que não é XML, o ZIP corrompido ou sem XML, na ordem do envio) e os dados do fornecedor tirados do
 * emitente (o que não passa no cadastro rápido fica de fora sem impedir a nota). Também: o orçamento de zip-bomba
 * do envio inteiro (vários `.zip` pequenos que juntos passam dos limites) e o teto somado do pedido.
 */
import { LIMITES_UPLOAD_NFE, type EmitenteNfeLido } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { fixtureNfe } from '../../test/fixtures/nfe/fixtures.js';
import { montarZip } from '../../test/fixtures/nfe/montar-zip.js';
import {
  avisosDaNota,
  conferirTamanhoEnvioNfe,
  fornecedorDoEmitente,
  separarArquivosNfe,
} from './notas-entrada.js';
import { LIMITES_ZIP_NFE } from './xml/zip.js';

const emitente = (extra: Partial<EmitenteNfeLido> = {}): EmitenteNfeLido => ({
  documento: '11222333000181',
  nome: 'DISTRIBUIDORA TESTE LTDA',
  fantasia: 'DISTRIBUIDORA',
  ie: '110042490114',
  uf: 'SP',
  crt: '3',
  endereco: {
    logradouro: 'RUA DE TESTE',
    numero: '100',
    complemento: null,
    bairro: 'CENTRO',
    municipioIbge: '3550308',
    municipio: 'SAO PAULO',
    uf: 'SP',
    cep: '01001000',
    telefone: '1130000000',
  },
  ...extra,
});

describe('separarArquivosNfe', () => {
  it('na ordem do envio: o XML solto, os XMLs do zip, o que não é XML e o zip sem XML', async () => {
    const xml = Buffer.from(fixtureNfe('01-icms-st.xml'));
    const pecas = await separarArquivosNfe([
      { nome: 'a.xml', conteudo: xml },
      {
        nome: 'lote.ZIP',
        conteudo: montarZip([
          { nome: 'pasta/', dados: Buffer.alloc(0), guardar: true },
          { nome: 'pasta/b.XML', dados: xml },
          { nome: 'danfe.pdf', dados: Buffer.from('%PDF') },
        ]),
      },
      { nome: 'nota.pdf', conteudo: Buffer.from('%PDF') },
      { nome: 'vazio.zip', conteudo: montarZip([]) },
      { nome: 'quebrado.zip', conteudo: Buffer.from('PK\u0003\u0004 nada') },
    ]);
    expect(
      pecas.map((p) => ('xml' in p ? `xml:${p.xml.nome}` : `${p.recusa.motivo}:${p.recusa.arquivo}`)),
    ).toEqual([
      'xml:a.xml',
      'xml:lote.ZIP › pasta/b.XML',
      'NAO_E_XML:lote.ZIP › danfe.pdf',
      'NAO_E_XML:nota.pdf',
      'ZIP_SEM_XML:vazio.zip',
      'ZIP_CORROMPIDO:quebrado.zip',
    ]);
  });

  it('o zip reconhecido pelo conteúdo, mesmo sem a extensão', async () => {
    const pecas = await separarArquivosNfe([
      { nome: 'notas', conteudo: montarZip([{ nome: 'n.xml', dados: Buffer.from('<x/>') }]) },
    ]);
    expect(pecas).toEqual([{ xml: { nome: 'notas › n.xml', conteudo: Buffer.from('<x/>') } }]);
  });

  it('os limites de zip-bomba valem somados para o envio: o .zip que passaria do que resta é recusado sem abrir', async () => {
    // 64 KiB de texto repetido (a taxa só é conferida acima disso) comprimem para ~120 bytes: um .zip de 999 entradas
    // declara 62 MiB e cabe nos limites de um .zip (1.000 entradas, 100 MiB), mas o segundo igual passaria das 1.000
    // entradas do envio.
    const entrada = Buffer.alloc(64 * 1024, 'a');
    const grande = montarZip(
      Array.from({ length: 999 }, (_, i) => ({ nome: `lixo-${i}.txt`, dados: entrada })),
    );
    expect(grande.length).toBeLessThan(300 * 1024);
    const pecas = await separarArquivosNfe([
      { nome: 'a.zip', conteudo: grande },
      { nome: 'b.zip', conteudo: grande },
      { nome: 'pequeno.zip', conteudo: montarZip([{ nome: 'n.xml', dados: Buffer.from('<x/>') }]) },
    ]);
    const recusas = pecas.flatMap((p) => ('recusa' in p ? [`${p.recusa.motivo}:${p.recusa.arquivo}`] : []));
    expect(recusas.filter((r) => r.startsWith('NAO_E_XML:a.zip ›'))).toHaveLength(999);
    expect(recusas).toContain('ENVIO_GRANDE_DEMAIS:b.zip');
    expect(recusas.some((r) => r.includes('b.zip ›'))).toBe(false);
    // O que ainda cabe (o .zip de uma entrada) segue.
    expect(pecas.filter((p) => 'xml' in p).map((p) => 'xml' in p && p.xml.nome)).toEqual([
      'pequeno.zip › n.xml',
    ]);
  });

  it('os bytes descompactados também somam para o envio (100 MiB no total, como num .zip)', async () => {
    // Uma entrada de 410 KiB que declara 40 MiB (taxa 100, o máximo): dois .zip cabem, o terceiro passaria dos
    // 100 MiB e é recusado pelo diretório central, sem descompactar nada.
    const zip = montarZip([
      { nome: 'lixo.bin', dados: Buffer.alloc(410 * 1024, 'b'), guardar: true, declarado: 40 * 1024 * 1024 },
    ]);
    const pecas = await separarArquivosNfe(
      ['a.zip', 'b.zip', 'c.zip'].map((nome) => ({ nome, conteudo: zip })),
      { entradas: LIMITES_ZIP_NFE.entradas, bytes: LIMITES_ZIP_NFE.totalBytes },
    );
    expect(pecas.map((p) => 'recusa' in p && `${p.recusa.motivo}:${p.recusa.arquivo}`)).toEqual([
      'NAO_E_XML:a.zip › lixo.bin',
      'ZIP_SEM_XML:a.zip',
      'NAO_E_XML:b.zip › lixo.bin',
      'ZIP_SEM_XML:b.zip',
      'ENVIO_GRANDE_DEMAIS:c.zip',
    ]);
  });
});

describe('conferirTamanhoEnvioNfe', () => {
  it('o envio vazio e a soma dos arquivos acima do teto são 422 no campo arquivos', () => {
    expect(() => conferirTamanhoEnvioNfe([])).toThrow('Envie o XML');
    const metade = Buffer.alloc(LIMITES_UPLOAD_NFE.bytes / 2 + 1);
    expect(() =>
      conferirTamanhoEnvioNfe([
        { nome: 'a.zip', conteudo: metade },
        { nome: 'b.zip', conteudo: metade },
      ]),
    ).toThrow('O envio passa de 20 MB: divida os arquivos.');
    expect(() => conferirTamanhoEnvioNfe([{ nome: 'a.zip', conteudo: metade }])).not.toThrow();
  });
});

describe('fornecedorDoEmitente', () => {
  it('nome, fantasia, IE, telefone e endereço do XML', () => {
    expect(fornecedorDoEmitente(emitente())).toMatchObject({
      cpfCnpj: '11222333000181',
      nome: 'DISTRIBUIDORA TESTE LTDA',
      apelido: 'DISTRIBUIDORA',
      rgIe: '110042490114',
      telefone: '1130000000',
      endereco: { cep: '01001000', municipioIbge: 3550308, uf: 'SP', numero: '100', tipo: 'principal' },
    });
  });

  it('o telefone fora do formato e o endereço incompleto ficam de fora, sem impedir o fornecedor', () => {
    const f = fornecedorDoEmitente(
      emitente({ endereco: { ...emitente().endereco, cep: null, telefone: '123456' } }),
    );
    expect(f).toMatchObject({ cpfCnpj: '11222333000181', telefone: null, endereco: null });
  });

  it('o número do endereço maior que o do cadastro é cortado, e o CNPJ inválido não vira fornecedor', () => {
    const f = fornecedorDoEmitente(
      emitente({ endereco: { ...emitente().endereco, numero: 'KM 12 DA RODOVIA SP-330 LADO B' } }),
    );
    expect(f?.endereco?.numero).toBe('KM 12 DA RODOVIA SP-');
    expect(fornecedorDoEmitente(emitente({ documento: '11222333000100' }))).toBeNull();
  });
});

describe('avisosDaNota', () => {
  it('a assinatura que não confere ou ausente, e sempre o aviso da SEFAZ por último', () => {
    expect(avisosDaNota('valida', null)).toHaveLength(1);
    const a = avisosDaNota('invalida', 'resumo diferente');
    expect(a).toHaveLength(2);
    expect(a[0]).toContain('resumo diferente');
    expect(a[1]).toContain('Sem consulta à SEFAZ');
    expect(avisosDaNota('ausente', null)[0]).toContain('não tem assinatura');
  });
});
