/**
 * Validações e assinatura da NF-e (F2-B18; F2-Q3 = D6; F2-Q9 = D50; README da API › decisão 163): as recusas que
 * sempre valem (NFC-e, homologação, sem protocolo ou não autorizada, chave com DV errado, diferente do protocolo ou
 * que não confere com a nota, destinatário fora da empresa, chave já importada), a assinatura alterada que só avisa
 * (ou recusa, com `recusar`), a ausente, a de outro protocolo e a do "embrulho"; o destinatário pode ser o CD.
 */
import type { NfeLida } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { CNPJ_CD, CNPJ_LOJA_1, CNPJ_PETISCARIA_2, fixtureNfe } from '../../../test/fixtures/nfe/fixtures.js';
import { conferirAssinaturaNfe, type ResultadoAssinaturaNfe } from './assinatura.js';
import { lerXmlNfe } from './parser.js';
import { validarNfe, type ContextoValidacaoNfe, type LojaDestinataria } from './validacoes.js';

const LOJAS: LojaDestinataria[] = [
  { id: 'loja-1', nome: 'Loja 1', cnpj: CNPJ_LOJA_1, tipo: 'ponto_venda' },
  { id: 'petiscaria-2', nome: 'Petiscaria 2', cnpj: CNPJ_PETISCARIA_2, tipo: 'ponto_venda' },
  { id: 'cd', nome: 'CD', cnpj: CNPJ_CD, tipo: 'deposito' },
];
const CONTEXTO: ContextoValidacaoNfe = { lojas: LOJAS, notaExistente: null, modoAssinatura: 'avisar' };
const VALIDA: ResultadoAssinaturaNfe = { situacao: 'valida', detalhe: null };

/** Lê o XML, confere a assinatura e valida, como a importação faz. */
function validar(xml: string, contexto: Partial<ContextoValidacaoNfe> = {}) {
  const lida = lerXmlNfe(xml);
  return validarNfe(lida.nota, conferirAssinaturaNfe(lida.xml, lida.nota), { ...CONTEXTO, ...contexto });
}

const BASE = fixtureNfe('01-icms-st.xml');
const CHAVE = '35261099887766000105550010000123451102030401';

describe('recusas que sempre valem', () => {
  it('a NF-e válida entra, na loja do CNPJ do destinatário, sem aviso', () => {
    expect(validar(BASE)).toEqual({ aceita: true, loja: LOJAS[0], assinatura: VALIDA, avisos: [] });
  });

  it('o destinatário pode ser o CD (loja do tipo depósito) e qualquer loja da empresa (F2-Q3)', () => {
    expect(validar(fixtureNfe('07-rastro-cd.xml'))).toMatchObject({ aceita: true, loja: { id: 'cd' } });
    expect(validar(fixtureNfe('05-qtrib-diferente.xml'))).toMatchObject({
      aceita: true,
      loja: { id: 'petiscaria-2' },
    });
  });

  it('NFC-e (modelo 65) é recusada com o motivo', () => {
    expect(validar(fixtureNfe('08-nfce.xml'))).toMatchObject({
      aceita: false,
      motivo: 'MODELO_NAO_ACEITO',
      mensagem: expect.stringContaining('NFC-e'),
    });
  });

  it('a NF-e sem protocolo (só a NFe, sem o nfeProc) é recusada', () => {
    const soNfe = /<NFe[\s\S]*<\/NFe>/.exec(BASE)![0];
    expect(validar(soNfe)).toMatchObject({
      aceita: false,
      motivo: 'SEM_PROTOCOLO',
      mensagem: expect.stringContaining('protNFe'),
    });
    expect(validar(BASE.replace(/<protNFe[\s\S]*<\/protNFe>/, ''))).toMatchObject({
      motivo: 'SEM_PROTOCOLO',
    });
  });

  it('protocolo que não é de autorização (denegada, 302) é recusado; o 150 entra', () => {
    expect(validar(BASE.replace('<cStat>100</cStat>', '<cStat>302</cStat>'))).toMatchObject({
      aceita: false,
      motivo: 'NAO_AUTORIZADA',
      detalhe: 'cStat 302 – Autorizado o uso da NF-e',
    });
    expect(validar(BASE.replace('<cStat>100</cStat>', '<cStat>150</cStat>'))).toMatchObject({ aceita: true });
  });

  it('nota de homologação é recusada', () => {
    expect(validar(BASE.replace('<tpAmb>1</tpAmb><finNFe>', '<tpAmb>2</tpAmb><finNFe>'))).toMatchObject({
      motivo: 'HOMOLOGACAO',
    });
  });

  it('chave com DV inválido é recusada com o motivo', () => {
    const errada = `${CHAVE.slice(0, 43)}9`;
    expect(validar(BASE.replaceAll(CHAVE, errada))).toMatchObject({
      aceita: false,
      motivo: 'CHAVE_INVALIDA',
      mensagem: expect.stringContaining('dígito verificador'),
    });
  });

  it('chave diferente da do protocolo é recusada', () => {
    const outra = fixtureNfe('03-ipi-industria.xml');
    const chaveOutra = /<chNFe>(\d{44})<\/chNFe>/.exec(outra)![1]!;
    expect(validar(BASE.replace(`<chNFe>${CHAVE}`, `<chNFe>${chaveOutra}`))).toMatchObject({
      motivo: 'CHAVE_DIFERENTE_PROTOCOLO',
    });
  });

  it('chave que não confere com a nota (número trocado no ide) é recusada', () => {
    expect(validar(BASE.replace('<nNF>12345</nNF>', '<nNF>12346</nNF>'))).toMatchObject({
      motivo: 'CHAVE_NAO_CONFERE',
    });
    expect(validar(BASE.replace('<cDV>1</cDV>', '<cDV>2</cDV>'))).toMatchObject({
      motivo: 'CHAVE_NAO_CONFERE',
    });
  });

  it('destinatário que não é loja da empresa é recusado (com o documento no detalhe)', () => {
    expect(validar(BASE, { lojas: LOJAS.slice(1) })).toMatchObject({
      aceita: false,
      motivo: 'DESTINATARIO_FORA_DA_EMPRESA',
      detalhe: `CNPJ ${LOJAS[0]!.cnpj}`,
    });
  });

  it('chave já importada é recusada, com a nota existente (a ignorada também conta)', () => {
    const notaExistente = {
      id: 'nota-1',
      codigo: 7,
      status: 'ignorada' as const,
      lojaId: 'loja-1',
      estoqueId: 'estoque-1',
    };
    expect(validar(BASE, { notaExistente })).toEqual({
      aceita: false,
      motivo: 'CHAVE_JA_IMPORTADA',
      mensagem: 'Esta NF-e já foi importada. (nota Nº 7)',
      detalhe: 'nota Nº 7',
      notaExistente,
    });
  });
});

describe('avisos que deixam a nota entrar', () => {
  it('o lote do rastro com a fabricação depois da validade (o schema da SEFAZ não impede) é só aviso', () => {
    const lida = lerXmlNfe(fixtureNfe('07-rastro-cd.xml'));
    const item = lida.nota.itens[0]!;
    const [r1, r2] = item.rastro;
    const nota: NfeLida = {
      ...lida.nota,
      itens: [
        { ...item, rastro: [{ ...r1!, fabricacao: r1!.validade, validade: r1!.fabricacao }, r2!] },
        ...lida.nota.itens.slice(1),
      ],
    };
    const r = validarNfe(nota, VALIDA, CONTEXTO);
    expect(r).toMatchObject({
      aceita: true,
      avisos: [
        {
          motivo: 'RASTRO_FABRICACAO_APOS_VALIDADE',
          detalhe: `item ${item.numeroItem}, lote ${r1!.lote}`,
        },
      ],
    });
  });
});

describe('assinatura (F2-Q9 = D50)', () => {
  const alterado = BASE.replace('<qCom>10.0000', '<qCom>100.0000').replace(
    '<vUnCom>39.9000000000',
    '<vUnCom>3.9900000000',
  );

  it('assinatura alterada gera aviso com "avisar" (padrão) e a nota entra', () => {
    const r = validar(alterado);
    expect(r).toMatchObject({
      aceita: true,
      assinatura: { situacao: 'invalida', detalhe: 'o conteúdo do XML foi alterado depois de assinado' },
      avisos: [
        {
          motivo: 'ASSINATURA_INVALIDA',
          mensagem: expect.stringContaining('não confere'),
          detalhe: 'o conteúdo do XML foi alterado depois de assinado',
        },
      ],
    });
  });

  it('com "recusar" a assinatura alterada recusa a nota', () => {
    expect(validar(alterado, { modoAssinatura: 'recusar' })).toMatchObject({
      aceita: false,
      motivo: 'ASSINATURA_INVALIDA',
    });
  });

  it('com "nao_conferir" não há aviso (a importação nem confere)', () => {
    const { nota } = lerXmlNfe(alterado);
    expect(
      validarNfe(
        nota,
        { situacao: 'nao_conferida', detalhe: null },
        { ...CONTEXTO, modoAssinatura: 'nao_conferir' },
      ),
    ).toMatchObject({ aceita: true, avisos: [] });
  });

  it('sem assinatura: aviso de assinatura ausente', () => {
    const r = validar(BASE.replace(/<Signature[\s\S]*<\/Signature>/, ''));
    expect(r).toMatchObject({
      aceita: true,
      assinatura: { situacao: 'ausente' },
      avisos: [{ motivo: 'ASSINATURA_AUSENTE' }],
    });
  });

  it('o resumo do protocolo (digVal) diferente do da assinatura: inválida', () => {
    const r = validar(
      BASE.replace(/<digVal>[^<]+<\/digVal>/, '<digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal>'),
    );
    expect(r).toMatchObject({
      assinatura: { situacao: 'invalida', detalhe: expect.stringContaining('protocolo') },
    });
  });

  it('a assinatura que não cobre o infNFe, a duplicada e o Id repetido ("embrulho") são inválidas', () => {
    const lida = lerXmlNfe(BASE);
    const semReferencia: NfeLida = {
      ...lida.nota,
      assinatura: { ...lida.nota.assinatura, referencia: '#outro' },
    };
    expect(conferirAssinaturaNfe(lida.xml, semReferencia).situacao).toBe('invalida');
    const assinatura = /<Signature[\s\S]*<\/Signature>/.exec(BASE)![0];
    expect(conferirAssinaturaNfe(lida.xml.replace(assinatura, assinatura + assinatura), lida.nota)).toEqual({
      situacao: 'invalida',
      detalhe: 'o XML tem mais de uma assinatura',
    });
    const embrulho = lida.xml.replace(
      '<infAdic>',
      `<infAdic><obsCont xCampo="x" Id="NFe${CHAVE}"><xTexto>1</xTexto></obsCont>`,
    );
    expect(conferirAssinaturaNfe(embrulho, lida.nota).detalhe).toBe(
      'o Id da nota aparece mais de uma vez no XML',
    );
  });

  it('o protocolo assinado pela autorizadora (ds:Signature no protNFe, layout 4.00) não conta: a nota é válida', () => {
    // A assinatura do protocolo tem a mesma forma, com a Reference no `infProt` e outro resumo e valor (os da 03).
    const outra = fixtureNfe('03-ipi-industria.xml');
    const doProtocolo = /<Signature[\s\S]*<\/Signature>/
      .exec(BASE)![0]
      .replace(`URI="#NFe${CHAVE}"`, 'URI="#ID135260000000101"')
      .replace(/<DigestValue>[^<]+<\/DigestValue>/, /<DigestValue>[^<]+<\/DigestValue>/.exec(outra)![0])
      .replace(
        /<SignatureValue>[^<]+<\/SignatureValue>/,
        /<SignatureValue>[^<]+<\/SignatureValue>/.exec(outra)![0],
      );
    const protocoloAssinado = BASE.replace('</infProt>', `</infProt>${doProtocolo}`);
    expect(validar(protocoloAssinado)).toEqual({
      aceita: true,
      loja: LOJAS[0],
      assinatura: VALIDA,
      avisos: [],
    });
    expect(validar(protocoloAssinado, { modoAssinatura: 'recusar' })).toMatchObject({ aceita: true });
  });

  it('a assinatura fora do namespace XMLDSig não é "mais de uma": a mensagem diz o que é', () => {
    const semNamespace = BASE.replace(
      '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">',
      '<Signature>',
    );
    const lida = lerXmlNfe(semNamespace);
    expect(lida.nota.assinatura.presente).toBe(true);
    expect(conferirAssinaturaNfe(lida.xml, lida.nota)).toEqual({
      situacao: 'invalida',
      detalhe: 'a assinatura da nota não segue o padrão XMLDSig',
    });
  });

  it('"embrulho" com o Id forjado com espaço e o infNFe assinado escondido no protNFe: inválida, e recusa com "recusar"', () => {
    const original = /<infNFe[\s\S]*<\/infNFe>/.exec(BASE)![0];
    // A cópia forjada (lida pelo parser, que apara o Id) com outro custo e outro total, coerentes entre si.
    const forjada = original
      .replace(`Id="NFe${CHAVE}"`, `Id="NFe${CHAVE} "`)
      .replace('<vNF>763.77</vNF>', '<vNF>963.77</vNF>')
      .replace('<vUnCom>39.9000000000', '<vUnCom>59.9000000000');
    const embrulho = BASE.replace(original, forjada).replace('</infProt>', `</infProt>${original}`);
    const lida = lerXmlNfe(embrulho);
    expect(lida.nota.idInfNfe).toBe(`NFe${CHAVE}`);
    expect(lida.nota.totais.total).toBe('963.77');
    expect(conferirAssinaturaNfe(lida.xml, lida.nota)).toEqual({
      situacao: 'invalida',
      detalhe: 'o Id da nota aparece mais de uma vez no XML',
    });
    expect(validar(embrulho, { modoAssinatura: 'recusar' })).toMatchObject({
      aceita: false,
      motivo: 'ASSINATURA_INVALIDA',
    });
    // Só o espaço no Id (sem o original em outro lugar): o elemento lido não é o assinado.
    const soEspaco = lerXmlNfe(BASE.replace(`Id="NFe${CHAVE}"`, `Id="NFe${CHAVE} "`));
    expect(conferirAssinaturaNfe(soEspaco.xml, soEspaco.nota)).toEqual({
      situacao: 'invalida',
      detalhe: 'a assinatura não cobre os dados da nota (infNFe)',
    });
    // O Id com prefixo de namespace (o parser tira o prefixo e o leria como o Id) também não é o assinado.
    const comPrefixo = BASE.replace(
      `<infNFe versao="4.00" Id="NFe${CHAVE}">`,
      `<infNFe xmlns:x="urn:x" versao="4.00" x:Id="NFe${CHAVE}">`,
    );
    const lidaPrefixo = lerXmlNfe(comPrefixo);
    expect(lidaPrefixo.nota.idInfNfe).toBe(`NFe${CHAVE}`);
    expect(conferirAssinaturaNfe(lidaPrefixo.xml, lidaPrefixo.nota).situacao).toBe('invalida');
  });

  it('assinatura trocada por outra de certificado diferente não confere', () => {
    const outra = fixtureNfe('03-ipi-industria.xml');
    const sigOutra = /<SignatureValue>[^<]+<\/SignatureValue>/.exec(outra)![0];
    const r = validar(BASE.replace(/<SignatureValue>[^<]+<\/SignatureValue>/, sigOutra));
    expect(r).toMatchObject({ aceita: true, assinatura: { situacao: 'invalida' } });
  });
});

describe('totais', () => {
  it('total que não fecha com os itens só avisa (a SEFAZ já recusa a que não fecha)', () => {
    const { nota } = lerXmlNfe(BASE);
    const r = validarNfe({ ...nota, totais: { ...nota.totais, total: '763.78' } }, VALIDA, CONTEXTO);
    expect(r).toMatchObject({
      aceita: true,
      avisos: [{ motivo: 'TOTAIS_DIVERGENTES', detalhe: 'vNF: nota 763.78, calculado 763.77' }],
    });
  });
});
