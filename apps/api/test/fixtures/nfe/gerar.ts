/**
 * Gera a biblioteca de XMLs de NF-e de teste (Fase 2, F2-B18; README da API › decisão 163): `nfeProc` no layout 4.00,
 * com os casos que a importação precisa ler com exatidão (ICMS-ST, FCP-ST, IPI, embalagens CX/FD/PCT, qTrib ≠ qCom,
 * "SEM GTIN", `rastro`) e uma NFC-e para recusar. Empresas, CNPJs e produtos são fictícios (CNPJs com DV calculado
 * sobre bases de teste, GTINs com DV calculado sobre o prefixo 789 de exemplo): nenhum dado real de fornecedor ou da
 * Ice Beer. Os XMLs são assinados (XMLDSig, rsa-sha1 + c14n, como a NF-e real) com um certificado autoassinado de
 * teste gerado na hora, e o `digVal` do protocolo é o DigestValue da assinatura.
 *
 * Os totais (ICMSTot e vNF) são somados aqui com decimal, pela regra da SEFAZ; o `parser.spec.ts` confere os valores
 * lidos contra números escritos à mão, não contra este gerador. Para trocar ou acrescentar um caso:
 * `pnpm --filter api exec tsx test/fixtures/nfe/gerar.ts` (precisa do `openssl` no PATH) e ajuste o spec. Uma nota
 * real do dono fica em `reais/`, só local (no `.gitignore`: o repositório é público, D60), não aqui: a anonimização
 * muda o `infNFe` e a assinatura dela deixa de conferir (na importação, com `avisar`, isso só vira aviso), e o
 * `parser.spec.ts` exige assinatura válida só das geradas.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcularDvChaveAcesso, completarCnpj, dec, type Dec } from '@genesis/shared';
import { SignedXml } from 'xml-crypto';
import { CNPJ_CD, CNPJ_LOJA_1, CNPJ_PETISCARIA_2 } from './fixtures.js';

const PASTA = dirname(fileURLToPath(import.meta.url));
const NS = 'http://www.portalfiscal.inf.br/nfe';

type Campos = Array<[string, string | null | undefined]>;

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const el = (nome: string, conteudo: string) => `<${nome}>${conteudo}</${nome}>`;
const campos = (lista: Campos) =>
  lista
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([n, v]) => el(n, esc(v!)))
    .join('');

/** GTIN com o dígito verificador (módulo 10, pesos 3 e 1 da direita para a esquerda). */
function gtin(base: string): string {
  let soma = 0;
  for (let i = 0; i < base.length; i++) soma += Number(base[base.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return `${base}${(10 - (soma % 10)) % 10}`;
}

interface Icms {
  grupo: string;
  campos: Campos;
}

export interface ItemSpec {
  cProd: string;
  cEAN: string;
  xProd: string;
  NCM: string;
  CEST?: string;
  CFOP: string;
  uCom: string;
  qCom: string;
  vUnCom: string;
  cEANTrib: string;
  uTrib: string;
  qTrib: string;
  vFrete?: string;
  vSeg?: string;
  vDesc?: string;
  vOutro?: string;
  rastro?: Array<{ nLote: string; qLote: string; dFab: string; dVal: string }>;
  icms: Icms;
  ipi?: { vBC: string; pIPI: string };
  pis?: [grupo: string, Campos];
  cofins?: [grupo: string, Campos];
  infAdProd?: string;
}

interface NotaSpec {
  arquivo: string;
  cUF: string;
  mod: '55' | '65';
  serie: string;
  nNF: string;
  cNF: string;
  dhEmi: string;
  natOp: string;
  tpNF?: string;
  emit: {
    CNPJ?: string;
    CPF?: string;
    xNome: string;
    xFant?: string;
    IE: string;
    CRT: string;
    UF: string;
    cMun: string;
    xMun: string;
  };
  dest?: { CNPJ?: string; CPF?: string; xNome: string; IE?: string; UF: string; cMun: string; xMun: string };
  itens: ItemSpec[];
  transp?: { modFrete: string; transporta?: { CNPJ: string; xNome: string; UF: string }; vol?: Campos[] };
  dup?: Array<[nDup: string, dVenc: string, vDup: string]>;
  tPag: string;
  infCpl?: string;
  nProt: string;
  dhRecbto: string;
}

const d2 = (v: Dec) => v.toDecimalPlaces(2).toFixed(2);
const somaCampo = (itens: Campos[], nome: string) =>
  itens.reduce((s, c) => s.plus(dec(c.find(([n]) => n === nome)?.[1] ?? '0')), dec(0));

function montarNfe(n: NotaSpec): { chave: string; xml: string } {
  const doc = n.emit.CNPJ ?? n.emit.CPF!.padStart(14, '0');
  const aamm = `${n.dhEmi.slice(2, 4)}${n.dhEmi.slice(5, 7)}`;
  const base = `${n.cUF}${aamm}${doc}${n.mod}${n.serie.padStart(3, '0')}${n.nNF.padStart(9, '0')}1${n.cNF}`;
  const cDV = String(calcularDvChaveAcesso(base));
  const chave = `${base}${cDV}`;

  const icmsCampos: Campos[] = [];
  const det = n.itens
    .map((i, k) => {
      const vProd = d2(dec(i.qCom).times(dec(i.vUnCom)));
      const vUnTrib = dec(vProd).div(dec(i.qTrib)).toDecimalPlaces(10).toFixed(10);
      icmsCampos.push(i.icms.campos);
      const rastro = (i.rastro ?? [])
        .map((r) =>
          el(
            'rastro',
            campos([
              ['nLote', r.nLote],
              ['qLote', r.qLote],
              ['dFab', r.dFab],
              ['dVal', r.dVal],
            ]),
          ),
        )
        .join('');
      const prod = campos([
        ['cProd', i.cProd],
        ['cEAN', i.cEAN],
        ['xProd', i.xProd],
        ['NCM', i.NCM],
        ['CEST', i.CEST],
        ['CFOP', i.CFOP],
        ['uCom', i.uCom],
        ['qCom', i.qCom],
        ['vUnCom', i.vUnCom],
        ['vProd', vProd],
        ['cEANTrib', i.cEANTrib],
        ['uTrib', i.uTrib],
        ['qTrib', i.qTrib],
        ['vUnTrib', vUnTrib],
        ['vFrete', i.vFrete],
        ['vSeg', i.vSeg],
        ['vDesc', i.vDesc],
        ['vOutro', i.vOutro],
        ['indTot', '1'],
      ]);
      const ipi = i.ipi
        ? el(
            'IPI',
            campos([['cEnq', '999']]) +
              el(
                'IPITrib',
                campos([
                  ['CST', '50'],
                  ['vBC', i.ipi.vBC],
                  ['pIPI', i.ipi.pIPI],
                  ['vIPI', d2(dec(i.ipi.vBC).times(dec(i.ipi.pIPI)).div(100))],
                ]),
              ),
          )
        : '';
      const pis = i.pis ?? ['PISNT', [['CST', '04']]];
      const cofins = i.cofins ?? ['COFINSNT', [['CST', '04']]];
      const imposto =
        el('ICMS', el(i.icms.grupo, campos(i.icms.campos))) +
        ipi +
        el('PIS', el(pis[0], campos(pis[1]))) +
        el('COFINS', el(cofins[0], campos(cofins[1])));
      return `<det nItem="${k + 1}">${el('prod', prod + rastro)}${el('imposto', imposto)}${
        i.infAdProd ? el('infAdProd', esc(i.infAdProd)) : ''
      }</det>`;
    })
    .join('');

  const soma = (f: (i: ItemSpec) => string | undefined) =>
    n.itens.reduce((s, i) => s.plus(dec(f(i) ?? '0')), dec(0));
  const vProd = soma((i) => d2(dec(i.qCom).times(dec(i.vUnCom))));
  const vFrete = soma((i) => i.vFrete);
  const vSeg = soma((i) => i.vSeg);
  const vDesc = soma((i) => i.vDesc);
  const vOutro = soma((i) => i.vOutro);
  const vIPI = soma((i) => (i.ipi ? d2(dec(i.ipi.vBC).times(dec(i.ipi.pIPI)).div(100)) : '0'));
  const vPIS = soma((i) => i.pis?.[1].find(([c]) => c === 'vPIS')?.[1] ?? '0');
  const vCOFINS = soma((i) => i.cofins?.[1].find(([c]) => c === 'vCOFINS')?.[1] ?? '0');
  const vST = somaCampo(icmsCampos, 'vICMSST');
  const vFCPST = somaCampo(icmsCampos, 'vFCPST');
  const vNF = vProd.minus(vDesc).plus(vST).plus(vFCPST).plus(vFrete).plus(vSeg).plus(vOutro).plus(vIPI);

  const ide = campos([
    ['cUF', n.cUF],
    ['cNF', n.cNF],
    ['natOp', n.natOp],
    ['mod', n.mod],
    ['serie', n.serie],
    ['nNF', n.nNF],
    ['dhEmi', n.dhEmi],
    ['tpNF', n.tpNF ?? '1'],
    ['idDest', n.dest && n.dest.UF !== n.emit.UF ? '2' : '1'],
    ['cMunFG', n.emit.cMun],
    ['tpImp', n.mod === '65' ? '4' : '1'],
    ['tpEmis', '1'],
    ['cDV', cDV],
    ['tpAmb', '1'],
    ['finNFe', '1'],
    ['indFinal', n.mod === '65' ? '1' : '0'],
    ['indPres', n.mod === '65' ? '1' : '9'],
    ['procEmi', '0'],
    ['verProc', 'GERADOR-TESTE 1.0'],
  ]);
  const emit =
    campos([
      ['CNPJ', n.emit.CNPJ],
      ['CPF', n.emit.CPF],
      ['xNome', n.emit.xNome],
      ['xFant', n.emit.xFant],
    ]) +
    el(
      'enderEmit',
      campos([
        ['xLgr', 'RUA DE TESTE'],
        ['nro', '100'],
        ['xBairro', 'CENTRO'],
        ['cMun', n.emit.cMun],
        ['xMun', n.emit.xMun],
        ['UF', n.emit.UF],
        ['CEP', '01001000'],
        ['cPais', '1058'],
        ['xPais', 'BRASIL'],
        ['fone', '1130000000'],
      ]),
    ) +
    campos([
      ['IE', n.emit.IE],
      ['CRT', n.emit.CRT],
    ]);
  const dest = n.dest
    ? el(
        'dest',
        campos([
          ['CNPJ', n.dest.CNPJ],
          ['CPF', n.dest.CPF],
          ['xNome', n.dest.xNome],
        ]) +
          el(
            'enderDest',
            campos([
              ['xLgr', 'AVENIDA DO CLIENTE'],
              ['nro', '200'],
              ['xBairro', 'CENTRO'],
              ['cMun', n.dest.cMun],
              ['xMun', n.dest.xMun],
              ['UF', n.dest.UF],
              ['CEP', '01002000'],
            ]),
          ) +
          campos([
            ['indIEDest', n.dest.IE ? '1' : '9'],
            ['IE', n.dest.IE],
          ]),
      )
    : '';
  const total = el(
    'total',
    el(
      'ICMSTot',
      campos([
        ['vBC', d2(somaCampo(icmsCampos, 'vBC'))],
        ['vICMS', d2(somaCampo(icmsCampos, 'vICMS'))],
        ['vICMSDeson', '0.00'],
        ['vFCP', '0.00'],
        ['vBCST', d2(somaCampo(icmsCampos, 'vBCST'))],
        ['vST', d2(vST)],
        ['vFCPST', d2(vFCPST)],
        ['vFCPSTRet', '0.00'],
        ['vProd', d2(vProd)],
        ['vFrete', d2(vFrete)],
        ['vSeg', d2(vSeg)],
        ['vDesc', d2(vDesc)],
        ['vII', '0.00'],
        ['vIPI', d2(vIPI)],
        ['vIPIDevol', '0.00'],
        ['vPIS', d2(vPIS)],
        ['vCOFINS', d2(vCOFINS)],
        ['vOutro', d2(vOutro)],
        ['vNF', d2(vNF)],
      ]),
    ),
  );
  const transp = el(
    'transp',
    campos([['modFrete', n.transp?.modFrete ?? '9']]) +
      (n.transp?.transporta
        ? el(
            'transporta',
            campos([
              ['CNPJ', n.transp.transporta.CNPJ],
              ['xNome', n.transp.transporta.xNome],
              ['UF', n.transp.transporta.UF],
            ]),
          )
        : '') +
      (n.transp?.vol ?? []).map((v) => el('vol', campos(v))).join(''),
  );
  const cobr = n.dup?.length
    ? el(
        'cobr',
        el(
          'fat',
          campos([
            ['nFat', n.nNF],
            ['vOrig', d2(vNF)],
            ['vDesc', '0.00'],
            ['vLiq', d2(vNF)],
          ]),
        ) +
          n.dup
            .map(([nDup, dVenc, vDup]) =>
              el(
                'dup',
                campos([
                  ['nDup', nDup],
                  ['dVenc', dVenc],
                  ['vDup', vDup],
                ]),
              ),
            )
            .join(''),
      )
    : '';
  const pag = el(
    'pag',
    el(
      'detPag',
      campos([
        ['tPag', n.tPag],
        ['vPag', d2(vNF)],
      ]),
    ),
  );
  const infAdic = n.infCpl ? el('infAdic', el('infCpl', esc(n.infCpl))) : '';
  const inf = `<infNFe versao="4.00" Id="NFe${chave}">${el('ide', ide)}${el('emit', emit)}${dest}${det}${total}${transp}${cobr}${pag}${infAdic}</infNFe>`;
  return { chave, xml: `<NFe xmlns="${NS}">${inf}</NFe>` };
}

function assinar(xml: string, chave: string, chavePrivada: string, certificado: string): string {
  const sig = new SignedXml({
    privateKey: chavePrivada,
    publicCert: certificado,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  });
  sig.addReference({
    xpath: `//*[@Id='NFe${chave}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    ],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  });
  sig.computeSignature(xml, { location: { reference: `//*[@Id='NFe${chave}']`, action: 'after' } });
  return sig.getSignedXml();
}

function procNfe(n: NotaSpec, chavePrivada: string, certificado: string): string {
  const { chave, xml } = montarNfe(n);
  const assinado = assinar(xml, chave, chavePrivada, certificado);
  const digVal = /<DigestValue>([^<]+)<\/DigestValue>/.exec(assinado)![1]!;
  const prot =
    `<protNFe versao="4.00"><infProt Id="ID${n.nProt}">` +
    campos([
      ['tpAmb', '1'],
      ['verAplic', 'SP_NFE_PL009_V4'],
      ['chNFe', chave],
      ['dhRecbto', n.dhRecbto],
      ['nProt', n.nProt],
      ['digVal', digVal],
      ['cStat', '100'],
      ['xMotivo', 'Autorizado o uso da NF-e'],
    ]) +
    `</infProt></protNFe>`;
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NS}" versao="4.00">${assinado}${prot}</nfeProc>\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Os casos

const EMIT_DISTRIBUIDORA = {
  CNPJ: completarCnpj('998877660001'),
  xNome: 'DISTRIBUIDORA DE BEBIDAS EXEMPLO LTDA',
  xFant: 'DISTRIBUIDORA EXEMPLO',
  IE: '110042490114',
  CRT: '3',
  UF: 'SP',
  cMun: '3550308',
  xMun: 'SAO PAULO',
};
const DEST_LOJA_1 = {
  CNPJ: CNPJ_LOJA_1,
  xNome: 'LOJA 1 BEBIDAS LTDA',
  IE: '110042490115',
  UF: 'SP',
  cMun: '3550308',
  xMun: 'SAO PAULO',
};
const DEST_PETISCARIA = {
  CNPJ: CNPJ_PETISCARIA_2,
  xNome: 'PETISCARIA 2 LTDA',
  IE: '110042490116',
  UF: 'SP',
  cMun: '3550308',
  xMun: 'SAO PAULO',
};
const DEST_CD = {
  CNPJ: CNPJ_CD,
  xNome: 'CD ESTOQUE LTDA',
  IE: '110042490117',
  UF: 'SP',
  cMun: '3550308',
  xMun: 'SAO PAULO',
};
const PIS_ALIQ = (vBC: string): [string, Campos] => [
  'PISAliq',
  [
    ['CST', '01'],
    ['vBC', vBC],
    ['pPIS', '1.6500'],
    ['vPIS', d2(dec(vBC).times('0.0165'))],
  ],
];
const COFINS_ALIQ = (vBC: string): [string, Campos] => [
  'COFINSAliq',
  [
    ['CST', '01'],
    ['vBC', vBC],
    ['pCOFINS', '7.6000'],
    ['vCOFINS', d2(dec(vBC).times('0.076'))],
  ],
];

/** ICMS 10 (ST na operação), com base e valor do próprio ICMS e da ST. */
const icms10 = (vBC: string, vBCST: string, fcp?: { vBCFCPST: string; pFCPST: string }): Icms => {
  const vICMS = d2(dec(vBC).times('0.18'));
  const vICMSST = d2(dec(vBCST).times('0.18').minus(dec(vICMS)));
  return {
    grupo: 'ICMS10',
    campos: [
      ['orig', '0'],
      ['CST', '10'],
      ['modBC', '3'],
      ['vBC', vBC],
      ['pICMS', '18.0000'],
      ['vICMS', vICMS],
      ['modBCST', '4'],
      ['pMVAST', '70.0000'],
      ['vBCST', vBCST],
      ['pICMSST', '18.0000'],
      ['vICMSST', vICMSST],
      ...(fcp
        ? ([
            ['vBCFCPST', fcp.vBCFCPST],
            ['pFCPST', fcp.pFCPST],
            ['vFCPST', d2(dec(fcp.vBCFCPST).times(dec(fcp.pFCPST)).div(100))],
          ] as Campos)
        : []),
    ],
  };
};
const icms00 = (vBC: string): Icms => ({
  grupo: 'ICMS00',
  campos: [
    ['orig', '0'],
    ['CST', '00'],
    ['modBC', '3'],
    ['vBC', vBC],
    ['pICMS', '18.0000'],
    ['vICMS', d2(dec(vBC).times('0.18'))],
  ],
});
const csosn = (codigo: string): Icms => ({
  grupo: codigo === '500' ? 'ICMSSN500' : 'ICMSSN102',
  campos: [
    ['orig', '0'],
    ['CSOSN', codigo],
  ],
});

const NOTAS: NotaSpec[] = [
  {
    arquivo: '01-icms-st.xml',
    cUF: '35',
    mod: '55',
    serie: '1',
    nNF: '12345',
    cNF: '10203040',
    dhEmi: '2026-10-20T08:15:00-03:00',
    natOp: 'VENDA DE MERCADORIA',
    emit: EMIT_DISTRIBUIDORA,
    dest: DEST_LOJA_1,
    itens: [
      {
        cProd: 'CERV-LT350-CX12',
        cEAN: gtin('1789100000001'),
        xProd: 'CERVEJA PILSEN LATA 350ML CX C/12',
        NCM: '22030000',
        CEST: '0302100',
        CFOP: '5401',
        uCom: 'CX',
        qCom: '10.0000',
        vUnCom: '39.9000000000',
        cEANTrib: gtin('789100000001'),
        uTrib: 'UN',
        qTrib: '120.0000',
        vFrete: '15.00',
        icms: icms10('414.00', '703.80'),
        pis: PIS_ALIQ('399.00'),
        cofins: COFINS_ALIQ('399.00'),
      },
      {
        cProd: 'REFRI-2L-FD6',
        cEAN: gtin('1789100000002'),
        xProd: 'REFRIGERANTE COLA PET 2L FD C/6',
        NCM: '22021000',
        CEST: '0300700',
        CFOP: '5401',
        uCom: 'FD',
        qCom: '5.0000',
        vUnCom: '45.6000000000',
        cEANTrib: gtin('789100000002'),
        uTrib: 'UN',
        qTrib: '30.0000',
        vFrete: '7.00',
        icms: icms10('235.00', '399.50'),
        pis: PIS_ALIQ('228.00'),
        cofins: COFINS_ALIQ('228.00'),
      },
      {
        cProd: 'AGUA-500',
        cEAN: gtin('789100000003'),
        xProd: 'AGUA MINERAL SEM GAS 500ML',
        NCM: '22011000',
        CFOP: '5102',
        uCom: 'UN',
        qCom: '24.0000',
        vUnCom: '1.2500000000',
        cEANTrib: gtin('789100000003'),
        uTrib: 'UN',
        qTrib: '24.0000',
        vFrete: '3.00',
        icms: icms00('33.00'),
      },
    ],
    transp: { modFrete: '0' },
    dup: [
      ['001', '2026-11-19', '700.00'],
      ['002', '2026-12-19', '0'],
    ],
    tPag: '15',
    infCpl: 'PEDIDO 4521. ICMS ST RECOLHIDO CONFORME PROTOCOLO.',
    nProt: '135260000000101',
    dhRecbto: '2026-10-20T08:16:02-03:00',
  },
  {
    arquivo: '02-fcp-st.xml',
    cUF: '33',
    mod: '55',
    serie: '2',
    nNF: '881',
    cNF: '55667788',
    dhEmi: '2026-10-21T14:00:00-03:00',
    natOp: 'VENDA MERC.ADQ.TERC. SUJ. ST',
    emit: {
      ...EMIT_DISTRIBUIDORA,
      CNPJ: completarCnpj('554433220001'),
      xNome: 'ATACADO RIO BEBIDAS LTDA',
      xFant: 'ATACADO RIO',
      IE: '12345678',
      UF: 'RJ',
      cMun: '3304557',
      xMun: 'RIO DE JANEIRO',
    },
    dest: DEST_LOJA_1,
    itens: [
      {
        cProd: '7001',
        cEAN: gtin('789100000011'),
        xProd: 'ENERGETICO LATA 473ML',
        NCM: '22029900',
        CEST: '0301500',
        CFOP: '6401',
        uCom: 'UN',
        qCom: '48.0000',
        vUnCom: '6.4900000000',
        cEANTrib: gtin('789100000011'),
        uTrib: 'UN',
        qTrib: '48.0000',
        icms: icms10('311.52', '529.58', { vBCFCPST: '529.58', pFCPST: '2.0000' }),
      },
      {
        cProd: '7002',
        cEAN: gtin('789100000012'),
        xProd: 'ISOTONICO PET 500ML',
        NCM: '22029900',
        CEST: '0301500',
        CFOP: '6401',
        uCom: 'UN',
        qCom: '12.0000',
        vUnCom: '4.3333333333',
        cEANTrib: gtin('789100000012'),
        uTrib: 'UN',
        qTrib: '12.0000',
        icms: icms10('52.00', '88.40', { vBCFCPST: '88.40', pFCPST: '2.0000' }),
      },
    ],
    tPag: '15',
    nProt: '333260000000202',
    dhRecbto: '2026-10-21T14:01:10-03:00',
  },
  {
    arquivo: '03-ipi-industria.xml',
    cUF: '35',
    mod: '55',
    serie: '1',
    nNF: '450021',
    cNF: '99887766',
    dhEmi: '2026-10-22T09:30:00-03:00',
    natOp: 'VENDA DE PRODUCAO DO ESTABELECIMENTO',
    emit: {
      ...EMIT_DISTRIBUIDORA,
      CNPJ: completarCnpj('776655440001'),
      xNome: 'CERVEJARIA ARTESANAL TESTE LTDA',
      xFant: 'CERVEJARIA TESTE',
      IE: '110042490200',
    },
    dest: DEST_LOJA_1,
    itens: [
      {
        cProd: 'IPA-600',
        cEAN: gtin('789100000021'),
        xProd: 'CERVEJA IPA GARRAFA 600ML',
        NCM: '22030000',
        CEST: '0302300',
        CFOP: '5101',
        uCom: 'CX',
        qCom: '4.0000',
        vUnCom: '132.0000000000',
        cEANTrib: gtin('789100000021'),
        uTrib: 'UN',
        qTrib: '48.0000',
        vSeg: '6.60',
        vDesc: '26.40',
        vOutro: '10.00',
        icms: icms00('518.20'),
        ipi: { vBC: '528.00', pIPI: '3.9000' },
      },
      {
        cProd: 'STOUT-355',
        cEAN: gtin('789100000022'),
        xProd: 'CERVEJA STOUT LONG NECK 355ML',
        NCM: '22030000',
        CEST: '0302300',
        CFOP: '5101',
        uCom: 'CX',
        qCom: '2.0000',
        vUnCom: '95.5000000000',
        cEANTrib: gtin('789100000022'),
        uTrib: 'UN',
        qTrib: '48.0000',
        vSeg: '2.40',
        vDesc: '9.55',
        vOutro: '5.00',
        icms: icms00('188.85'),
        ipi: { vBC: '191.00', pIPI: '3.9000' },
      },
    ],
    transp: {
      modFrete: '1',
      transporta: { CNPJ: completarCnpj('332211000001'), xNome: 'TRANSPORTADORA TESTE LTDA', UF: 'SP' },
      vol: [
        [
          ['qVol', '6'],
          ['esp', 'CAIXA'],
          ['marca', 'CERVEJARIA TESTE'],
          ['nVol', '1-6'],
          ['pesoL', '62.400'],
          ['pesoB', '68.100'],
        ],
      ],
    },
    dup: [
      ['001', '2026-11-21', '0'],
      ['002', '2026-12-21', '0'],
      ['003', '2027-01-20', '0'],
    ],
    tPag: '15',
    nProt: '135260000000303',
    dhRecbto: '2026-10-22T09:31:44-03:00',
  },
  {
    arquivo: '04-embalagens-cx-fd-pct.xml',
    cUF: '35',
    mod: '55',
    serie: '3',
    nNF: '7788',
    cNF: '31415926',
    dhEmi: '2026-10-23T10:00:00-03:00',
    natOp: 'VENDA',
    emit: {
      ...EMIT_DISTRIBUIDORA,
      CNPJ: completarCnpj('667788990001'),
      xNome: 'COMERCIAL SIMPLES BEBIDAS ME',
      xFant: 'SIMPLES BEBIDAS',
      IE: '110042490300',
      CRT: '1',
    },
    dest: DEST_LOJA_1,
    itens: [
      {
        cProd: 'CX24-LT269',
        cEAN: gtin('1789100000031'),
        xProd: 'CERVEJA LATA 269ML CX C/24',
        NCM: '22030000',
        CEST: '0302100',
        CFOP: '5405',
        uCom: 'CX',
        qCom: '3.0000',
        vUnCom: '62.4000000000',
        cEANTrib: gtin('789100000031'),
        uTrib: 'UN',
        qTrib: '72.0000',
        icms: csosn('500'),
      },
      {
        cProd: 'FD6-SUCO1L',
        cEAN: gtin('1789100000032'),
        xProd: 'SUCO UVA INTEGRAL 1L FD C/6',
        NCM: '20096100',
        CFOP: '5102',
        uCom: 'FD',
        qCom: '2.0000',
        vUnCom: '71.8800000000',
        cEANTrib: gtin('789100000032'),
        uTrib: 'UN',
        qTrib: '12.0000',
        icms: csosn('102'),
      },
      {
        cProd: 'PCT10-COPO',
        cEAN: gtin('1789100000033'),
        xProd: 'COPO DESCARTAVEL 300ML PCT C/10',
        NCM: '39241000',
        CFOP: '5102',
        uCom: 'PCT',
        qCom: '15.0000',
        vUnCom: '3.9900000000',
        cEANTrib: gtin('789100000033'),
        uTrib: 'UN',
        qTrib: '150.0000',
        icms: csosn('102'),
      },
    ],
    tPag: '01',
    nProt: '135260000000404',
    dhRecbto: '2026-10-23T10:00:31-03:00',
  },
  {
    arquivo: '05-qtrib-diferente.xml',
    cUF: '35',
    mod: '55',
    serie: '1',
    nNF: '90001',
    cNF: '27182818',
    dhEmi: '2026-10-24T07:45:00-03:00',
    natOp: 'VENDA',
    emit: {
      ...EMIT_DISTRIBUIDORA,
      CNPJ: completarCnpj('445566770001'),
      xNome: 'FRIGORIFICO E LATICINIOS TESTE LTDA',
      xFant: 'LATICINIOS TESTE',
      IE: '110042490400',
    },
    dest: DEST_PETISCARIA,
    itens: [
      {
        cProd: 'QJ-MUS-FD',
        cEAN: 'SEM GTIN',
        xProd: 'QUEIJO MUSSARELA PECA FD',
        NCM: '04069010',
        CFOP: '5102',
        uCom: 'FD',
        qCom: '3.5000',
        vUnCom: '187.4567891234',
        cEANTrib: 'SEM GTIN',
        uTrib: 'KG',
        qTrib: '42.3750',
        icms: icms00('656.10'),
      },
      {
        cProd: 'CALAB-KG',
        cEAN: 'SEM GTIN',
        xProd: 'LINGUICA CALABRESA DEFUMADA',
        NCM: '16010000',
        CEST: '1700900',
        CFOP: '5102',
        uCom: 'PCT',
        qCom: '8.0000',
        vUnCom: '52.1234567890',
        cEANTrib: 'SEM GTIN',
        uTrib: 'KG',
        qTrib: '20.0000',
        icms: icms00('416.99'),
      },
    ],
    tPag: '15',
    dup: [['1', '2026-11-08', '0']],
    nProt: '135260000000505',
    dhRecbto: '2026-10-24T07:46:12-03:00',
  },
  {
    arquivo: '06-sem-gtin-produtor-rural.xml',
    cUF: '31',
    mod: '55',
    serie: '890',
    nNF: '17',
    cNF: '16180339',
    dhEmi: '2026-10-25T11:20:00-03:00',
    natOp: 'VENDA DE PRODUCAO RURAL',
    emit: {
      CPF: '12345678909',
      xNome: 'JOSE DA SILVA TESTE',
      IE: '0012345670099',
      CRT: '3',
      UF: 'MG',
      cMun: '3106200',
      xMun: 'BELO HORIZONTE',
    },
    dest: DEST_PETISCARIA,
    itens: [
      {
        cProd: '1',
        cEAN: 'SEM GTIN',
        xProd: 'LIMAO TAHITI & LARANJA PERA (CX 20KG) – SAFRA "2026"',
        NCM: '08055000',
        CFOP: '6101',
        uCom: 'CX',
        qCom: '6.0000',
        vUnCom: '58.0000000000',
        cEANTrib: 'SEM GTIN',
        uTrib: 'KG',
        qTrib: '120.0000',
        icms: {
          grupo: 'ICMS40',
          campos: [
            ['orig', '0'],
            ['CST', '41'],
          ],
        },
        infAdProd: 'PRODUTO HORTIFRUTI <IN NATURA>',
      },
    ],
    tPag: '90',
    infCpl: 'NOTA DE PRODUTOR RURAL – ISENTO DE ICMS; FUNRURAL RETIDO PELO ADQUIRENTE.',
    nProt: '131260000000606',
    dhRecbto: '2026-10-25T11:21:00-03:00',
  },
  {
    arquivo: '07-rastro-cd.xml',
    cUF: '35',
    mod: '55',
    serie: '1',
    nNF: '334455',
    cNF: '14142135',
    dhEmi: '2026-10-26T16:10:00-03:00',
    natOp: 'VENDA',
    emit: {
      ...EMIT_DISTRIBUIDORA,
      CNPJ: completarCnpj('223344550001'),
      xNome: 'DISTRIBUIDORA DE LATICINIOS TESTE SA',
      xFant: 'LATICINIOS SA',
      IE: '110042490500',
    },
    dest: DEST_CD,
    itens: [
      {
        cProd: 'IOG-170-FD',
        cEAN: gtin('1789100000041'),
        xProd: 'IOGURTE MORANGO 170G FD C/6',
        NCM: '04032000',
        CFOP: '5102',
        uCom: 'FD',
        qCom: '20.0000',
        vUnCom: '14.9400000000',
        cEANTrib: gtin('789100000041'),
        uTrib: 'UN',
        qTrib: '120.0000',
        rastro: [
          { nLote: 'L2610A', qLote: '72.000', dFab: '2026-10-10', dVal: '2026-11-25' },
          { nLote: 'L2612B', qLote: '48.000', dFab: '2026-10-12', dVal: '2026-11-27' },
        ],
        icms: icms00('298.80'),
      },
      {
        cProd: 'LEITE-1L-CX12',
        cEAN: gtin('1789100000042'),
        xProd: 'LEITE UHT INTEGRAL 1L CX C/12',
        NCM: '04012010',
        CFOP: '5102',
        uCom: 'CX',
        qCom: '10.0000',
        vUnCom: '58.8000000000',
        cEANTrib: gtin('789100000042'),
        uTrib: 'UN',
        qTrib: '120.0000',
        rastro: [{ nLote: '0925X', qLote: '120.000', dFab: '2026-09-25', dVal: '2027-01-23' }],
        icms: icms00('588.00'),
      },
    ],
    tPag: '15',
    nProt: '135260000000707',
    dhRecbto: '2026-10-26T16:11:05-03:00',
  },
  {
    arquivo: '08-nfce.xml',
    cUF: '35',
    mod: '65',
    serie: '1',
    nNF: '2001',
    cNF: '11235813',
    dhEmi: '2026-10-27T19:05:00-03:00',
    natOp: 'VENDA AO CONSUMIDOR',
    emit: {
      ...EMIT_DISTRIBUIDORA,
      CNPJ: completarCnpj('889900110001'),
      xNome: 'ADEGA DO BAIRRO TESTE LTDA',
      xFant: 'ADEGA TESTE',
      IE: '110042490600',
      CRT: '1',
    },
    dest: { CNPJ: CNPJ_LOJA_1, xNome: 'LOJA 1 BEBIDAS LTDA', UF: 'SP', cMun: '3550308', xMun: 'SAO PAULO' },
    itens: [
      {
        cProd: '55',
        cEAN: gtin('789100000051'),
        xProd: 'GELO EM CUBOS 5KG',
        NCM: '22019000',
        CFOP: '5102',
        uCom: 'UN',
        qCom: '4.0000',
        vUnCom: '12.0000000000',
        cEANTrib: gtin('789100000051'),
        uTrib: 'UN',
        qTrib: '4.0000',
        icms: csosn('102'),
      },
    ],
    tPag: '01',
    nProt: '135260000000808',
    dhRecbto: '2026-10-27T19:05:03-03:00',
  },
];

/**
 * As duplicatas com valor '0' dividem o que sobra do vNF (depois das de valor fixo) em partes iguais, com o resíduo
 * na última, como o emitente faria.
 */
function preencherDuplicatas(n: NotaSpec): NotaSpec {
  if (!n.dup?.some(([, , v]) => v === '0')) return n;
  const { xml } = montarNfe({ ...n, dup: undefined });
  const vNF = dec(/<vNF>([^<]+)<\/vNF>/.exec(xml)![1]!);
  const fixas = n.dup.filter(([, , v]) => v !== '0').reduce((s, [, , v]) => s.plus(dec(v)), dec(0));
  const abertas = n.dup.filter(([, , v]) => v === '0').length;
  const parte = vNF.minus(fixas).div(abertas).toDecimalPlaces(2, 1);
  let resto = vNF.minus(fixas).minus(parte.times(abertas));
  let vistas = 0;
  return {
    ...n,
    dup: n.dup.map(([nDup, dVenc, v]) => {
      if (v !== '0') return [nDup, dVenc, v];
      vistas++;
      const valor = vistas === abertas ? parte.plus(resto) : parte;
      if (vistas === abertas) resto = dec(0);
      return [nDup, dVenc, d2(valor)];
    }),
  };
}

/** Gera um certificado autoassinado de teste (chave e certificado em PEM) com o `openssl`. */
function certificadoDeTeste(): { chavePrivada: string; certificado: string } {
  const pasta = mkdtempSync(join(tmpdir(), 'nfe-teste-'));
  try {
    const chave = join(pasta, 'chave.pem');
    const cert = join(pasta, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '3650',
        '-subj',
        '/C=BR/O=GenesisPDV Teste/CN=CERTIFICADO DE TESTE (NF-e ficticia)',
        '-keyout',
        chave,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    );
    return { chavePrivada: readFileSync(chave, 'utf8'), certificado: readFileSync(cert, 'utf8') };
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}

let certificadoDaExecucao: { chavePrivada: string; certificado: string } | null = null;

/**
 * Outra nota a partir de uma fixture (F2-B19: duas notas do mesmo emitente num ZIP, a nota de outra loja já
 * importada, os envios simultâneos): o mesmo caso com outro número (`nNF`), outro código numérico (`cNF`, 8
 * dígitos), outro protocolo e, com `rastroTrocado`, a fabricação e a validade de cada lote do `rastro` trocadas (o
 * fornecedor que inverte as datas: o schema da SEFAZ não impede), com `dhEmi` outra emissão (a nota mais antiga
 * movimentada depois, F2-B21) e com `itens` os itens trocados (outro valor, outro cProd, itens a mais: os totais e as
 * duplicatas saem dos itens), assinada com um certificado de teste gerado na primeira chamada (precisa do `openssl`).
 * Devolve o XML e a chave.
 */
export function variarFixtureNfe(
  arquivo: string,
  alteracoes: {
    nNF: string;
    cNF: string;
    nProt: string;
    rastroTrocado?: boolean;
    dhEmi?: string;
    itens?: (itens: readonly ItemSpec[]) => ItemSpec[];
  },
): { xml: string; chave: string } {
  const base = NOTAS.find((n) => n.arquivo === arquivo);
  if (!base) throw new Error(`fixture desconhecida: ${arquivo}`);
  const nota: NotaSpec = {
    ...base,
    nNF: alteracoes.nNF,
    cNF: alteracoes.cNF,
    nProt: alteracoes.nProt,
    ...(alteracoes.dhEmi ? { dhEmi: alteracoes.dhEmi } : {}),
    ...(alteracoes.itens ? { itens: alteracoes.itens(base.itens) } : {}),
    ...(alteracoes.rastroTrocado
      ? {
          itens: base.itens.map((i) => ({
            ...i,
            rastro: i.rastro?.map((r) => ({ ...r, dFab: r.dVal, dVal: r.dFab })),
          })),
        }
      : {}),
  };
  certificadoDaExecucao ??= certificadoDeTeste();
  const completa = preencherDuplicatas(nota);
  return {
    xml: procNfe(completa, certificadoDaExecucao.chavePrivada, certificadoDaExecucao.certificado),
    chave: montarNfe(completa).chave,
  };
}

function main() {
  const { chavePrivada, certificado } = certificadoDeTeste();
  for (const n of NOTAS) {
    writeFileSync(join(PASTA, n.arquivo), procNfe(preencherDuplicatas(n), chavePrivada, certificado));
    console.log(`gerado ${n.arquivo}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
