/**
 * Parser seguro da NF-e (F2-B18; README da API › decisão 163) sobre a biblioteca de XMLs de teste
 * (`test/fixtures/nfe/`): os valores lidos são conferidos contra números escritos à mão (qCom com 4 casas, vUnCom e
 * vUnTrib com 10, dinheiro com 2, sem passar por `number`) e os totais contra o vNF; e as recusas de segurança
 * (DOCTYPE/entidade externa, "bilhão de risadas", malformado, grande e profundo demais, codificação). A assinatura
 * válida é exigida só das geradas (assinadas por nós); as notas reais locais (`reais/`, fora do repositório, D60) são
 * lidas inteiras, e a assinatura delas, que a anonimização quebra, pode sair inválida (na importação, com `avisar`, é
 * só aviso).
 */
import { conferirTotaisNfe, LIMITES_XML_NFE, type NfeLida } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import {
  ARQUIVOS_FIXTURES_NFE,
  ARQUIVOS_FIXTURES_NFE_REAIS,
  fixtureNfe,
} from '../../../test/fixtures/nfe/fixtures.js';
import { conferirAssinaturaNfe } from './assinatura.js';
import { lerXmlNfe, RecusaNfe } from './parser.js';

const ler = (nome: string): NfeLida => lerXmlNfe(fixtureNfe(nome)).nota;

function recusa(conteudo: string | Buffer): RecusaNfe {
  try {
    lerXmlNfe(conteudo);
  } catch (e) {
    if (e instanceof RecusaNfe) return e;
    throw e;
  }
  throw new Error('o XML deveria ser recusado');
}

const ARQUIVOS = ARQUIVOS_FIXTURES_NFE;

describe('biblioteca de XMLs (todas as fixtures)', () => {
  it('tem pelo menos 8 casos, entre eles uma NFC-e', () => {
    expect(ARQUIVOS.length).toBeGreaterThanOrEqual(8);
    expect(ARQUIVOS.map((f) => ler(f).modelo)).toContain(65);
  });

  it.each(ARQUIVOS)(
    '%s: lido inteiro, totais batendo com os itens e o vNF, e assinatura válida',
    (arquivo) => {
      const { nota, xml } = lerConferido(arquivo);
      expect(nota.protocolo).toMatchObject({ status: 100, resumo: nota.assinatura.resumo });
      expect(conferirAssinaturaNfe(xml, nota)).toEqual({ situacao: 'valida', detalhe: null });
    },
  );

  // Vazio na CI: as notas reais ficam só na máquina de quem testa (`reais/` no `.gitignore`, D60). Anonimizada (CNPJ,
  // nomes), a nota muda o `infNFe` e a assinatura deixa de conferir.
  it.each(ARQUIVOS_FIXTURES_NFE_REAIS)(
    '%s (real anonimizada): lida inteira, totais batendo, e assinatura presente (válida ou não)',
    (arquivo) => {
      const { nota, xml } = lerConferido(arquivo);
      expect(['valida', 'invalida']).toContain(conferirAssinaturaNfe(xml, nota).situacao);
    },
  );
});

/** O que vale para toda fixture, gerada ou real: lida inteira, autorizada, com os totais fechando e as casas certas. */
function lerConferido(arquivo: string) {
  const lida = lerXmlNfe(fixtureNfe(arquivo));
  const { nota } = lida;
  expect(nota.chave).toMatch(/^\d{44}$/);
  expect(nota.itens.length).toBeGreaterThan(0);
  expect(conferirTotaisNfe(nota)).toEqual([]);
  expect(nota.protocolo?.chave).toBe(nota.chave);
  expect([100, 150]).toContain(nota.protocolo?.status);
  for (const i of nota.itens) {
    expect(i.quantidadeComercial).toMatch(/^\d+\.\d{4}$/);
    expect(i.valorUnitarioComercial).toMatch(/^\d+\.\d{10}$/);
    expect(i.valorProduto).toMatch(/^\d+\.\d{2}$/);
  }
  return lida;
}

describe('valores exatos por fixture', () => {
  it('01: ICMS-ST com caixa e fardo (qTrib ≠ qCom), frete por item e duas duplicatas', () => {
    const n = ler('01-icms-st.xml');
    expect(n).toMatchObject({
      chave: '35261099887766000105550010000123451102030401',
      modelo: 55,
      serie: 1,
      numero: 12345,
      dataEmissao: '2026-10-20T08:15:00-03:00',
      naturezaOperacao: 'VENDA DE MERCADORIA',
      emitente: {
        documento: '99887766000105',
        nome: 'DISTRIBUIDORA DE BEBIDAS EXEMPLO LTDA',
        fantasia: 'DISTRIBUIDORA EXEMPLO',
        ie: '110042490114',
        uf: 'SP',
        endereco: { municipioIbge: '3550308', cep: '01001000' },
      },
      destinatario: { documento: '11222333000181', tipoDocumento: 'cnpj' },
      informacoesComplementares: 'PEDIDO 4521. ICMS ST RECOLHIDO CONFORME PROTOCOLO.',
      protocolo: { numero: '135260000000101', data: '2026-10-20T08:16:02-03:00', status: 100 },
    });
    expect(n.totais).toMatchObject({
      produtos: '657.00',
      frete: '25.00',
      icmsBase: '682.00',
      icms: '122.76',
      icmsStBase: '1103.30',
      icmsSt: '81.77',
      pis: '10.34',
      cofins: '47.65',
      total: '763.77',
    });
    expect(n.itens[0]).toMatchObject({
      numeroItem: 1,
      codigo: 'CERV-LT350-CX12',
      ean: '17891000000011',
      eanTributavel: '7891000000014',
      ncm: '22030000',
      cest: '0302100',
      cfop: '5401',
      unidadeComercial: 'CX',
      quantidadeComercial: '10.0000',
      valorUnitarioComercial: '39.9000000000',
      unidadeTributavel: 'UN',
      quantidadeTributavel: '120.0000',
      valorUnitarioTributavel: '3.3250000000',
      valorProduto: '399.00',
      valorFrete: '15.00',
      compoeTotal: true,
      icms: {
        situacao: '10',
        origem: '0',
        base: '414.00',
        aliquota: '18.0000',
        valor: '74.52',
        stBase: '703.80',
        stValor: '52.16',
      },
      pisValor: '6.58',
      cofinsValor: '30.32',
    });
    expect(n.itens[2]).toMatchObject({
      cfop: '5102',
      icms: { situacao: '00', stValor: '0.00' },
      pisValor: null,
    });
    expect(n.duplicatas).toEqual([
      { sequencia: 1, numero: '001', vencimento: '2026-11-19', valor: '700.00' },
      { sequencia: 2, numero: '002', vencimento: '2026-12-19', valor: '63.77' },
    ]);
    expect(n.transporte).toEqual({
      modalidadeFrete: '0',
      transportadoraDocumento: null,
      transportadoraNome: null,
      volumes: [],
    });
  });

  it('02: FCP-ST somado ao vNF, com vUnCom de 10 casas (4,3333333333)', () => {
    const n = ler('02-fcp-st.xml');
    expect(n.emitente).toMatchObject({ documento: '55443322000105', uf: 'RJ', ie: '12345678' });
    expect(n.totais).toMatchObject({ produtos: '363.52', icmsSt: '45.80', fcpSt: '12.36', total: '421.68' });
    expect(n.itens.map((i) => [i.icms.stValor, i.icms.fcpStValor])).toEqual([
      ['39.25', '10.59'],
      ['6.55', '1.77'],
    ]);
    expect(n.itens[1]).toMatchObject({
      valorUnitarioComercial: '4.3333333333',
      valorProduto: '52.00',
      cfop: '6401',
    });
  });

  it('03: IPI, seguro, desconto e outras despesas; transportadora, volumes e três duplicatas', () => {
    const n = ler('03-ipi-industria.xml');
    expect(n.totais).toMatchObject({
      produtos: '719.00',
      seguro: '9.00',
      desconto: '35.95',
      outras: '15.00',
      ipi: '28.04',
      total: '735.09',
    });
    expect(n.itens.map((i) => [i.valorIpi, i.valorSeguro, i.valorDesconto, i.valorOutros])).toEqual([
      ['20.59', '6.60', '26.40', '10.00'],
      ['7.45', '2.40', '9.55', '5.00'],
    ]);
    expect(n.itens[1]).toMatchObject({
      quantidadeTributavel: '48.0000',
      valorUnitarioTributavel: '3.9791666667',
    });
    expect(n.transporte).toEqual({
      modalidadeFrete: '1',
      transportadoraDocumento: '33221100000105',
      transportadoraNome: 'TRANSPORTADORA TESTE LTDA',
      volumes: [
        {
          quantidade: '6',
          especie: 'CAIXA',
          marca: 'CERVEJARIA TESTE',
          numeracao: '1-6',
          pesoLiquido: '62.400',
          pesoBruto: '68.100',
        },
      ],
    });
    expect(n.duplicatas.map((d) => d.valor)).toEqual(['245.03', '245.03', '245.03']);
  });

  it('04: embalagens CX/FD/PCT (Simples, CSOSN), EAN da caixa e da unidade', () => {
    const n = ler('04-embalagens-cx-fd-pct.xml');
    expect(
      n.itens.map((i) => [
        i.unidadeComercial,
        i.quantidadeComercial,
        i.ean,
        i.unidadeTributavel,
        i.quantidadeTributavel,
        i.eanTributavel,
        i.valorUnitarioTributavel,
        i.icms.situacao,
      ]),
    ).toEqual([
      ['CX', '3.0000', '17891000000318', 'UN', '72.0000', '7891000000311', '2.6000000000', '500'],
      ['FD', '2.0000', '17891000000325', 'UN', '12.0000', '7891000000328', '11.9800000000', '102'],
      ['PCT', '15.0000', '17891000000332', 'UN', '150.0000', '7891000000335', '0.3990000000', '102'],
    ]);
    expect(n.totais.total).toBe('390.81');
  });

  it('05: qTrib ≠ qCom em KG, com vUnCom e vUnTrib de 10 casas e "SEM GTIN"', () => {
    const n = ler('05-qtrib-diferente.xml');
    expect(n.itens[0]).toMatchObject({
      ean: null,
      eanTributavel: null,
      unidadeComercial: 'FD',
      quantidadeComercial: '3.5000',
      valorUnitarioComercial: '187.4567891234',
      unidadeTributavel: 'KG',
      quantidadeTributavel: '42.3750',
      valorUnitarioTributavel: '15.4831858407',
      valorProduto: '656.10',
    });
    expect(n.itens[1]).toMatchObject({
      valorUnitarioComercial: '52.1234567890',
      valorUnitarioTributavel: '20.8495000000',
      valorProduto: '416.99',
    });
    expect(n.destinatario.documento).toBe('11222333000262');
    expect(n.totais.total).toBe('1073.09');
  });

  it('06: produtor rural (CPF), "SEM GTIN" e entidades do XML decodificadas', () => {
    const n = ler('06-sem-gtin-produtor-rural.xml');
    expect(n.emitente).toMatchObject({ documento: '12345678909', uf: 'MG', ie: '0012345670099' });
    expect(n.chave.slice(6, 20)).toBe('00012345678909');
    expect(n.serie).toBe(890);
    expect(n.itens[0]).toMatchObject({
      ean: null,
      eanTributavel: null,
      descricao: 'LIMAO TAHITI & LARANJA PERA (CX 20KG) – SAFRA "2026"',
      informacoesAdicionais: 'PRODUTO HORTIFRUTI <IN NATURA>',
      icms: { situacao: '41', base: null, valor: null },
    });
    expect(fixtureNfe('06-sem-gtin-produtor-rural.xml')).toContain('LIMAO TAHITI &amp; LARANJA');
  });

  it('07: grupo rastro com dois lotes num item e um no outro; destinatário é o CD', () => {
    const n = ler('07-rastro-cd.xml');
    expect(n.destinatario.documento).toBe('11222333000343');
    expect(n.itens[0]!.rastro).toEqual([
      {
        lote: 'L2610A',
        quantidade: '72.000',
        fabricacao: '2026-10-10',
        validade: '2026-11-25',
        codigoAgregacao: null,
      },
      {
        lote: 'L2612B',
        quantidade: '48.000',
        fabricacao: '2026-10-12',
        validade: '2026-11-27',
        codigoAgregacao: null,
      },
    ]);
    expect(n.itens[1]!.rastro).toEqual([
      {
        lote: '0925X',
        quantidade: '120.000',
        fabricacao: '2026-09-25',
        validade: '2027-01-23',
        codigoAgregacao: null,
      },
    ]);
  });

  it('08: a NFC-e é lida (a recusa pelo modelo é da validação)', () => {
    const n = ler('08-nfce.xml');
    expect(n.modelo).toBe(65);
    expect(n.chave.slice(20, 22)).toBe('65');
  });
});

describe('recusas de segurança e de formato', () => {
  const base = fixtureNfe('01-icms-st.xml');
  const corpo = base.replace(/^<\?xml[^>]*\?>/, '');

  it('DOCTYPE com entidade externa (XXE) é recusado antes do parser', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE nfeProc [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${corpo.replace(
      'PEDIDO 4521',
      '&xxe;',
    )}`;
    const r = recusa(xxe);
    expect(r.motivo).toBe('XML_COM_DTD');
    expect(r.message).toContain('DOCTYPE');
  });

  it('"bilhão de risadas" (entidades aninhadas) é recusado', () => {
    const entidades = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? '<!ENTITY lol0 "lol">' : `<!ENTITY lol${i} "${`&lol${i - 1};`.repeat(10)}">`,
    ).join('');
    expect(recusa(`<?xml version="1.0"?><!DOCTYPE a [${entidades}]><a>&lol9;</a>`).motivo).toBe(
      'XML_COM_DTD',
    );
  });

  it('entidade solta sem DTD fica como veio (nada é expandido nem buscado)', () => {
    const { nota } = lerXmlNfe(base.replace('PEDIDO 4521', 'PEDIDO &ext; &#233;&#x41;'));
    expect(nota.informacoesComplementares).toBe('PEDIDO &ext; éA. ICMS ST RECOLHIDO CONFORME PROTOCOLO.');
  });

  it('XML malformado, grande demais, profundo demais ou fora de UTF-8', () => {
    expect(recusa(base.replace('</infNFe>', '')).motivo).toBe('XML_MALFORMADO');
    expect(recusa('isto não é XML').motivo).toBe('XML_MALFORMADO');
    expect(recusa(Buffer.alloc(LIMITES_XML_NFE.bytes + 1, 0x20)).motivo).toBe('XML_GRANDE_DEMAIS');
    const fundo = `${'<x>'.repeat(40)}1${'</x>'.repeat(40)}`;
    expect(recusa(base.replace('<infCpl>', `<obsCont>${fundo}</obsCont><infCpl>`)).motivo).toBe(
      'XML_PROFUNDO_DEMAIS',
    );
    expect(recusa(Buffer.from([0x3c, 0x61, 0x3e, 0xe9, 0x3c, 0x2f, 0x61, 0x3e])).motivo).toBe(
      'XML_MALFORMADO',
    );
  });

  it('o BOM do UTF-8 é aceito', () => {
    const { nota } = lerXmlNfe(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(base)]));
    expect(nota.numero).toBe(12345);
  });

  it('o que não é NF-e, grupo repetido e campo fora do layout', () => {
    expect(recusa('<cteProc><CTe/></cteProc>').motivo).toBe('NAO_E_NFE');
    const inf = /<infNFe[\s\S]*<\/infNFe>/.exec(base)![0];
    expect(recusa(base.replace(inf, inf + inf)).message).toContain('infNFe repetido');
    expect(recusa(base.replace('<vUnCom>39.9000000000', '<vUnCom>39.90000000001')).motivo).toBe(
      'NFE_INVALIDA',
    );
    expect(recusa(base.replace('<qCom>10.0000', '<qCom>-10.0000')).motivo).toBe('NFE_INVALIDA');
    expect(recusa(base.replace('<dVenc>2026-11-19', '<dVenc>2026-02-30')).message).toContain('dVenc');
    expect(recusa(base.replace(/<det nItem="2">/, '<det nItem="1">')).message).toContain('nItem repetido');
  });
});
