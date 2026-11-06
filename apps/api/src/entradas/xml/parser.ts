/**
 * Parser seguro do XML da NF-e de fornecedor (Fase 2, F2-B18; ERP 13.4; MD 3.8.2; README da API › decisão 163): lê
 * o `nfeProc` (ou a `NFe` solta, que a validação recusa por falta de protocolo) e devolve a `NfeLida` do shared, com
 * os números como texto nas casas do XML (qCom com 4, vUnCom com 10, dinheiro com 2), sem passar por `number`.
 *
 * Segurança (o processo é de todas as empresas):
 * - teto de tamanho antes de decodificar (`LIMITES_XML_NFE.bytes`; a SEFAZ recusa NF-e acima de 500 KB);
 * - **sem DTD**: qualquer `<!DOCTYPE` ou `<!ENTITY` recusa o arquivo antes do parser (XXE, "bilhão de risadas"); o
 *   `fast-xml-parser` roda com `processEntities: false` e só as 5 entidades do XML e as referências numéricas são
 *   decodificadas aqui, sem expansão nem arquivo externo;
 * - XML malformado recusado pelo `XMLValidator` (iterativo, sem recursão) antes da leitura;
 * - teto de profundidade (`maxNestedTags`) e de itens, duplicatas, volumes e lotes por item.
 *
 * Grupo repetido onde o layout tem um só (duas `infNFe`, dois `protNFe`) é recusado: a leitura nunca escolhe um deles.
 */
import {
  LIMITES_XML_NFE,
  MOTIVOS_RECUSA_NFE,
  normalizarCnpj,
  type DestinatarioNfeLido,
  type DuplicataNfeLida,
  type EmitenteNfeLido,
  type EnderecoNfeLido,
  type IcmsItemNfeLido,
  type ItemNfeLido,
  type MotivoRecusaNfe,
  type NfeLida,
  type ProtocoloNfeLido,
  type RastroNfeLido,
  type TotaisNfeLidos,
  type TransporteNfeLido,
  type VolumeNfeLido,
} from '@genesis/shared';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

/** Recusa da importação com o motivo do shared (`MOTIVOS_RECUSA_NFE`) e, quando ajuda, o campo ou o valor. */
export class RecusaNfe extends Error {
  constructor(
    readonly motivo: MotivoRecusaNfe,
    readonly detalhe: string | null = null,
  ) {
    super(detalhe ? `${MOTIVOS_RECUSA_NFE[motivo]} (${detalhe})` : MOTIVOS_RECUSA_NFE[motivo]);
    this.name = 'RecusaNfe';
  }
}

/** Grupos que o layout repete e que a leitura percorre; os demais, repetidos, são recusados quando lidos. */
const GRUPOS_REPETIDOS = new Set(['det', 'dup', 'vol', 'rastro']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  maxNestedTags: LIMITES_XML_NFE.profundidade,
  isArray: (nome) => GRUPOS_REPETIDOS.has(nome),
  tagValueProcessor: (_nome, valor) => decodificarEntidades(valor),
  attributeValueProcessor: (_nome, valor) => decodificarEntidades(valor),
});

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** As 5 entidades predefinidas do XML e as referências numéricas; qualquer outra fica como veio (não há DTD). */
function decodificarEntidades(valor: string): string {
  if (!valor.includes('&')) return valor;
  return valor.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (inteira, nome: string) => {
    if (!nome.startsWith('#')) return ENTIDADES[nome]!;
    const codigo = nome[1] === 'x' ? parseInt(nome.slice(2), 16) : parseInt(nome.slice(1), 10);
    return codigo > 0 && codigo <= 0x10ffff && (codigo < 0xd800 || codigo > 0xdfff)
      ? String.fromCodePoint(codigo)
      : inteira;
  });
}

/**
 * Decodifica o arquivo (UTF-8, com ou sem BOM; a NF-e é sempre UTF-8) e aplica as recusas que vêm antes do parser:
 * tamanho, codificação e DTD.
 */
export function textoXmlNfe(conteudo: Buffer | string): string {
  const bytes = typeof conteudo === 'string' ? Buffer.byteLength(conteudo, 'utf8') : conteudo.length;
  if (bytes > LIMITES_XML_NFE.bytes) throw new RecusaNfe('XML_GRANDE_DEMAIS');
  let texto: string;
  if (typeof conteudo === 'string') texto = conteudo;
  else {
    try {
      texto = new TextDecoder('utf-8', { fatal: true }).decode(conteudo);
    } catch {
      throw new RecusaNfe('XML_MALFORMADO', 'codificação diferente de UTF-8');
    }
  }
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(texto)) throw new RecusaNfe('XML_COM_DTD');
  return texto;
}

type No = Record<string, unknown>;

/** Lê o XML da NF-e; recusa com `RecusaNfe`. Devolve também o texto decodificado (a assinatura é conferida sobre ele). */
export function lerXmlNfe(conteudo: Buffer | string): { nota: NfeLida; xml: string } {
  const xml = textoXmlNfe(conteudo);
  const validacao = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validacao !== true) throw new RecusaNfe('XML_MALFORMADO', `linha ${validacao.err.line}`);
  let raiz: No;
  try {
    raiz = parser.parse(xml) as No;
  } catch (e) {
    if (/nested/i.test((e as Error).message)) throw new RecusaNfe('XML_PROFUNDO_DEMAIS');
    throw new RecusaNfe('XML_MALFORMADO');
  }
  return { nota: lerNfe(raiz), xml };
}

// ---------------------------------------------------------------------------------------------------------------
// Navegação e campos

function grupo(pai: unknown, nome: string, caminho: string): No | undefined {
  if (pai === undefined || pai === null || typeof pai !== 'object') return undefined;
  const v = (pai as No)[nome];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome} repetido`);
  if (typeof v !== 'object' || v === null) {
    // Grupo vazio (`<transp/>`) chega como texto vazio.
    if (v === '') return {};
    throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome}`);
  }
  return v as No;
}

function lista(pai: No | undefined, nome: string, caminho: string, teto: number): No[] {
  const v = pai?.[nome];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome}`);
  const itens: unknown[] = v;
  if (itens.length > teto) throw new RecusaNfe('NFE_INVALIDA', `mais de ${teto} ${caminho}/${nome}`);
  return itens.map((x) => {
    if (x === '') return {};
    if (typeof x !== 'object' || x === null) throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome}`);
    return x as No;
  });
}

/** Texto de um elemento folha (nulo se ausente ou vazio); teto de caracteres do layout. */
function texto(pai: No | undefined, nome: string, caminho: string, max: number): string | null {
  const v = pai?.[nome];
  if (v === undefined || v === null) return null;
  const valor = typeof v === 'object' && !Array.isArray(v) ? (v as No)['#text'] : v;
  if (Array.isArray(v) || (valor !== undefined && typeof valor !== 'string'))
    throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome}`);
  const t = (valor ?? '').trim();
  if (t === '') return null;
  if ([...t].length > max)
    throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome} com mais de ${max} caracteres`);
  return t;
}

function obrigatorio(pai: No | undefined, nome: string, caminho: string, max: number): string {
  const t = texto(pai, nome, caminho, max);
  if (t === null) throw new RecusaNfe('NFE_INVALIDA', `falta ${caminho}/${nome}`);
  return t;
}

function formato(
  pai: No | undefined,
  nome: string,
  caminho: string,
  regex: RegExp,
  exigido = false,
): string | null {
  const t = exigido ? obrigatorio(pai, nome, caminho, 100) : texto(pai, nome, caminho, 100);
  if (t !== null && !regex.test(t))
    throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome} = ${t.slice(0, 20)}`);
  return t;
}

/**
 * Decimal do XML (ponto, sem sinal) com até `inteiros` dígitos e até `casas` casas, devolvido com exatamente `casas`
 * casas, completando com zeros (nunca arredonda: o que passa das casas é recusado).
 */
function decimal(
  pai: No | undefined,
  nome: string,
  caminho: string,
  inteiros: number,
  casas: number,
): string | null {
  const t = texto(pai, nome, caminho, 40);
  if (t === null) return null;
  const m = new RegExp(`^(\\d{1,${inteiros}})(?:\\.(\\d{1,${casas}}))?$`).exec(t);
  if (!m) throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome} = ${t.slice(0, 20)}`);
  const inteira = m[1]!.replace(/^0+(?=\d)/, '');
  return casas === 0 ? inteira : `${inteira}.${(m[2] ?? '').padEnd(casas, '0')}`;
}

function decimalObrigatorio(
  pai: No | undefined,
  nome: string,
  caminho: string,
  inteiros: number,
  casas: number,
): string {
  const v = decimal(pai, nome, caminho, inteiros, casas);
  if (v === null) throw new RecusaNfe('NFE_INVALIDA', `falta ${caminho}/${nome}`);
  return v;
}

const dinheiroOpcional = (pai: No | undefined, nome: string, caminho: string) =>
  decimal(pai, nome, caminho, 13, 2);
const dinheiro = (pai: No | undefined, nome: string, caminho: string) =>
  dinheiroOpcional(pai, nome, caminho) ?? '0.00';

function inteiro(pai: No | undefined, nome: string, caminho: string, max: number): number {
  const t = formato(pai, nome, caminho, /^\d{1,9}$/, true)!;
  const n = Number(t);
  if (n > max) throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome} = ${t}`);
  return n;
}

const DATA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:[+-]\d{2}:\d{2}|Z)?$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

function dataHora(pai: No | undefined, nome: string, caminho: string, exigida: boolean): string | null {
  const t = formato(pai, nome, caminho, DATA_HORA, exigida);
  if (t !== null && Number.isNaN(Date.parse(t)))
    throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome} = ${t}`);
  return t;
}

function data(pai: No | undefined, nome: string, caminho: string, exigida: boolean): string | null {
  const t = formato(pai, nome, caminho, DATA, exigida);
  if (t === null) return null;
  const d = new Date(`${t}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t)
    throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome} = ${t}`);
  return t;
}

const CNPJ = /^[0-9A-Za-z]{12}[0-9]{2}$/;
const CPF = /^[0-9]{11}$/;

/** CNPJ (alfanumérico, em maiúsculas) ou CPF do grupo; nulo se o grupo não tem nenhum. */
function documento(pai: No | undefined, caminho: string): { documento: string; tipo: 'cnpj' | 'cpf' } | null {
  const cnpj = formato(pai, 'CNPJ', caminho, CNPJ);
  if (cnpj) return { documento: normalizarCnpj(cnpj), tipo: 'cnpj' };
  const cpf = formato(pai, 'CPF', caminho, CPF);
  return cpf ? { documento: cpf, tipo: 'cpf' } : null;
}

/** GTIN do item: "SEM GTIN" (e vazio) vira nulo; o resto tem de ser um GTIN-8/12/13/14. */
function gtin(pai: No | undefined, nome: string, caminho: string): string | null {
  const t = texto(pai, nome, caminho, 20);
  if (t === null || t.toUpperCase() === 'SEM GTIN') return null;
  if (!/^(\d{8}|\d{12,14})$/.test(t)) throw new RecusaNfe('NFE_INVALIDA', `${caminho}/${nome} = ${t}`);
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// Leitura

function lerNfe(raiz: No): NfeLida {
  const proc = grupo(raiz, 'nfeProc', '');
  const nfe = proc ? grupo(proc, 'NFe', '/nfeProc') : grupo(raiz, 'NFe', '');
  const inf = grupo(nfe, 'infNFe', '/NFe');
  if (!nfe || !inf) throw new RecusaNfe('NAO_E_NFE');
  const idInfNfe = texto(inf, '@Id', '/NFe/infNFe', 47);
  if (!idInfNfe || !/^NFe[0-9A-Za-z]{44}$/.test(idInfNfe))
    throw new RecusaNfe('CHAVE_INVALIDA', 'Id do infNFe');
  const c = '/NFe/infNFe';

  const ide = grupo(inf, 'ide', c);
  if (!ide) throw new RecusaNfe('NFE_INVALIDA', `falta ${c}/ide`);
  const ci = `${c}/ide`;
  const emit = grupo(inf, 'emit', c);
  if (!emit) throw new RecusaNfe('NFE_INVALIDA', `falta ${c}/emit`);

  const det = lista(inf, 'det', c, LIMITES_XML_NFE.itens);
  if (det.length === 0) throw new RecusaNfe('NFE_INVALIDA', `falta ${c}/det`);
  const itens = det.map((d, i) => lerItem(d, `${c}/det[${i + 1}]`));
  const numeros = new Set(itens.map((i) => i.numeroItem));
  if (numeros.size !== itens.length) throw new RecusaNfe('NFE_INVALIDA', `${c}/det/@nItem repetido`);

  const total = grupo(inf, 'total', c);
  const icmsTot = grupo(total, 'ICMSTot', `${c}/total`);
  if (!icmsTot) throw new RecusaNfe('NFE_INVALIDA', `falta ${c}/total/ICMSTot`);

  const cobr = grupo(inf, 'cobr', c);
  const duplicatas: DuplicataNfeLida[] = lista(cobr, 'dup', `${c}/cobr`, LIMITES_XML_NFE.duplicatas).map(
    (d, i) => {
      const cd = `${c}/cobr/dup[${i + 1}]`;
      return {
        sequencia: i + 1,
        numero: texto(d, 'nDup', cd, 60),
        vencimento: data(d, 'dVenc', cd, false),
        valor: decimalObrigatorio(d, 'vDup', cd, 13, 2),
      };
    },
  );

  const assinatura = grupo(nfe, 'Signature', '/NFe');
  const signedInfo = grupo(assinatura, 'SignedInfo', '/NFe/Signature');
  const referencia = grupo(signedInfo, 'Reference', '/NFe/Signature/SignedInfo');

  return {
    chave: idInfNfe.slice(3).toUpperCase(),
    idInfNfe,
    versao: texto(inf, '@versao', c, 10),
    cUF: formato(ide, 'cUF', ci, /^\d{2}$/, true)!,
    codigoNumerico: formato(ide, 'cNF', ci, /^\d{8}$/, true)!,
    modelo: inteiro(ide, 'mod', ci, 99),
    serie: inteiro(ide, 'serie', ci, 999),
    numero: inteiro(ide, 'nNF', ci, 999_999_999),
    dataEmissao: dataHora(ide, 'dhEmi', ci, true)!,
    naturezaOperacao: texto(ide, 'natOp', ci, 60),
    tipoOperacao: formato(ide, 'tpNF', ci, /^[01]$/),
    finalidade: formato(ide, 'finNFe', ci, /^[1-4]$/),
    ambiente: formato(ide, 'tpAmb', ci, /^[12]$/),
    tipoEmissao: formato(ide, 'tpEmis', ci, /^\d$/, true)!,
    digitoVerificador: formato(ide, 'cDV', ci, /^\d$/),
    emitente: lerEmitente(emit, `${c}/emit`),
    destinatario: lerDestinatario(grupo(inf, 'dest', c), `${c}/dest`),
    totais: lerTotais(icmsTot, grupo(total, 'ISSQNtot', `${c}/total`), `${c}/total`),
    transporte: lerTransporte(grupo(inf, 'transp', c), `${c}/transp`),
    informacoesComplementares: texto(grupo(inf, 'infAdic', c), 'infCpl', `${c}/infAdic`, 5000),
    itens,
    duplicatas,
    protocolo: proc ? lerProtocolo(grupo(proc, 'protNFe', '/nfeProc')) : null,
    assinatura: {
      presente: assinatura !== undefined,
      referencia: texto(referencia, '@URI', '/NFe/Signature/SignedInfo/Reference', 60),
      resumo: texto(referencia, 'DigestValue', '/NFe/Signature/SignedInfo/Reference', 100),
    },
  };
}

function lerEndereco(e: No | undefined, c: string): EnderecoNfeLido {
  return {
    logradouro: texto(e, 'xLgr', c, 60),
    numero: texto(e, 'nro', c, 60),
    complemento: texto(e, 'xCpl', c, 60),
    bairro: texto(e, 'xBairro', c, 60),
    municipioIbge: formato(e, 'cMun', c, /^\d{7}$/),
    municipio: texto(e, 'xMun', c, 60),
    uf: formato(e, 'UF', c, /^[A-Z]{2}$/),
    cep: formato(e, 'CEP', c, /^\d{8}$/),
    telefone: formato(e, 'fone', c, /^\d{6,14}$/),
  };
}

function lerEmitente(emit: No, c: string): EmitenteNfeLido {
  const doc = documento(emit, c);
  if (!doc) throw new RecusaNfe('NFE_INVALIDA', `falta ${c}/CNPJ`);
  const endereco = lerEndereco(grupo(emit, 'enderEmit', c), `${c}/enderEmit`);
  if (!endereco.uf) throw new RecusaNfe('NFE_INVALIDA', `falta ${c}/enderEmit/UF`);
  const ie = formato(emit, 'IE', c, /^(ISENTO|\d{2,14})$/);
  return {
    documento: doc.documento,
    nome: obrigatorio(emit, 'xNome', c, 60),
    fantasia: texto(emit, 'xFant', c, 60),
    ie,
    uf: endereco.uf,
    crt: formato(emit, 'CRT', c, /^[1-4]$/),
    endereco,
  };
}

function lerDestinatario(dest: No | undefined, c: string): DestinatarioNfeLido {
  const doc = documento(dest, c);
  const estrangeiro = doc ? null : texto(dest, 'idEstrangeiro', c, 20);
  return {
    documento: doc?.documento ?? estrangeiro,
    tipoDocumento: doc?.tipo ?? (estrangeiro ? 'estrangeiro' : null),
    nome: texto(dest, 'xNome', c, 60),
    ie: texto(dest, 'IE', c, 14),
  };
}

function lerTotais(t: No, issqn: No | undefined, c: string): TotaisNfeLidos {
  const ct = `${c}/ICMSTot`;
  const v = (nome: string) => dinheiro(t, nome, ct);
  return {
    produtos: v('vProd'),
    frete: v('vFrete'),
    seguro: v('vSeg'),
    desconto: v('vDesc'),
    outras: v('vOutro'),
    ipi: v('vIPI'),
    ipiDevolvido: v('vIPIDevol'),
    ii: v('vII'),
    icmsBase: v('vBC'),
    icms: v('vICMS'),
    icmsDesonerado: v('vICMSDeson'),
    icmsStBase: v('vBCST'),
    icmsSt: v('vST'),
    fcpSt: v('vFCPST'),
    fcpStRetido: v('vFCPSTRet'),
    pis: v('vPIS'),
    cofins: v('vCOFINS'),
    servicos: dinheiro(issqn, 'vServ', `${c}/ISSQNtot`),
    total: decimalObrigatorio(t, 'vNF', ct, 13, 2),
  };
}

function lerTransporte(transp: No | undefined, c: string): TransporteNfeLido {
  const transporta = grupo(transp, 'transporta', c);
  const doc = documento(transporta, `${c}/transporta`);
  const volumes: VolumeNfeLido[] = lista(transp, 'vol', c, LIMITES_XML_NFE.volumes).map((v, i) => {
    const cv = `${c}/vol[${i + 1}]`;
    return {
      quantidade: formato(v, 'qVol', cv, /^\d{1,15}$/),
      especie: texto(v, 'esp', cv, 60),
      marca: texto(v, 'marca', cv, 60),
      numeracao: texto(v, 'nVol', cv, 60),
      pesoLiquido: decimal(v, 'pesoL', cv, 12, 3),
      pesoBruto: decimal(v, 'pesoB', cv, 12, 3),
    };
  });
  return {
    modalidadeFrete: formato(transp, 'modFrete', c, /^[0-49]$/),
    transportadoraDocumento: doc?.documento ?? null,
    transportadoraNome: texto(transporta, 'xNome', `${c}/transporta`, 60),
    volumes,
  };
}

/** O grupo de ICMS do item é um só filho de `imposto/ICMS` (ICMS00…ICMS90, ICMSPart, ICMSST, ICMSSN101…ICMSSN900). */
function lerIcms(imposto: No | undefined, c: string): IcmsItemNfeLido {
  const icms = grupo(imposto, 'ICMS', c);
  const nomes = icms ? Object.keys(icms).filter((k) => !k.startsWith('@') && k !== '#text') : [];
  if (nomes.length > 1) throw new RecusaNfe('NFE_INVALIDA', `${c}/ICMS com mais de um grupo`);
  const g = nomes[0] ? grupo(icms, nomes[0], `${c}/ICMS`) : undefined;
  const cg = `${c}/ICMS/${nomes[0] ?? ''}`;
  return {
    situacao: formato(g, 'CST', cg, /^\d{2}$/) ?? formato(g, 'CSOSN', cg, /^\d{3}$/),
    origem: formato(g, 'orig', cg, /^\d$/),
    base: dinheiroOpcional(g, 'vBC', cg),
    aliquota: decimal(g, 'pICMS', cg, 3, 4),
    valor: dinheiroOpcional(g, 'vICMS', cg),
    stBase: dinheiroOpcional(g, 'vBCST', cg),
    stValor: dinheiro(g, 'vICMSST', cg),
    fcpStValor: dinheiro(g, 'vFCPST', cg),
  };
}

/** vPIS/vCOFINS do único filho do grupo (PISAliq, PISQtde, PISNT, PISOutr…). */
function valorDoGrupoUnico(imposto: No | undefined, nome: string, campo: string, c: string): string | null {
  const g = grupo(imposto, nome, c);
  if (!g) return null;
  const filhos = Object.keys(g).filter((k) => !k.startsWith('@') && k !== '#text');
  if (filhos.length > 1) throw new RecusaNfe('NFE_INVALIDA', `${c}/${nome} com mais de um grupo`);
  return filhos[0]
    ? dinheiroOpcional(grupo(g, filhos[0], `${c}/${nome}`), campo, `${c}/${nome}/${filhos[0]}`)
    : null;
}

function lerItem(det: No, c: string): ItemNfeLido {
  const numeroItem = Number(formato(det, '@nItem', c, /^[1-9]\d{0,2}$/, true));
  if (numeroItem > LIMITES_XML_NFE.itens) throw new RecusaNfe('NFE_INVALIDA', `${c}/@nItem = ${numeroItem}`);
  const prod = grupo(det, 'prod', c);
  if (!prod) throw new RecusaNfe('NFE_INVALIDA', `falta ${c}/prod`);
  const cp = `${c}/prod`;
  const imposto = grupo(det, 'imposto', c);
  const ci = `${c}/imposto`;
  const rastro: RastroNfeLido[] = lista(prod, 'rastro', cp, LIMITES_XML_NFE.rastroPorItem).map((r, i) => {
    const cr = `${cp}/rastro[${i + 1}]`;
    return {
      lote: obrigatorio(r, 'nLote', cr, 20),
      quantidade: decimal(r, 'qLote', cr, 8, 3) ?? '0.000',
      fabricacao: data(r, 'dFab', cr, true)!,
      validade: data(r, 'dVal', cr, true)!,
      codigoAgregacao: texto(r, 'cAgreg', cr, 20),
    };
  });
  const devolucao = grupo(grupo(det, 'impostoDevol', c), 'IPI', `${c}/impostoDevol`);
  return {
    numeroItem,
    codigo: obrigatorio(prod, 'cProd', cp, 60),
    descricao: obrigatorio(prod, 'xProd', cp, 120),
    ean: gtin(prod, 'cEAN', cp),
    eanTributavel: gtin(prod, 'cEANTrib', cp),
    ncm: formato(prod, 'NCM', cp, /^(\d{8}|\d{2})$/),
    cest: formato(prod, 'CEST', cp, /^\d{7}$/),
    cfop: formato(prod, 'CFOP', cp, /^\d{4}$/, true)!,
    unidadeComercial: obrigatorio(prod, 'uCom', cp, 6),
    quantidadeComercial: decimalObrigatorio(prod, 'qCom', cp, 11, 4),
    valorUnitarioComercial: decimalObrigatorio(prod, 'vUnCom', cp, 11, 10),
    unidadeTributavel: texto(prod, 'uTrib', cp, 6),
    quantidadeTributavel: decimal(prod, 'qTrib', cp, 11, 4),
    valorUnitarioTributavel: decimal(prod, 'vUnTrib', cp, 11, 10),
    valorProduto: decimalObrigatorio(prod, 'vProd', cp, 13, 2),
    valorFrete: dinheiro(prod, 'vFrete', cp),
    valorSeguro: dinheiro(prod, 'vSeg', cp),
    valorDesconto: dinheiro(prod, 'vDesc', cp),
    valorOutros: dinheiro(prod, 'vOutro', cp),
    compoeTotal: formato(prod, 'indTot', cp, /^[01]$/) !== '0',
    icms: lerIcms(imposto, ci),
    valorIpi: dinheiro(grupo(grupo(imposto, 'IPI', ci), 'IPITrib', `${ci}/IPI`), 'vIPI', `${ci}/IPI/IPITrib`),
    valorIpiDevolvido: dinheiro(devolucao, 'vIPIDevol', `${c}/impostoDevol/IPI`),
    valorII: dinheiro(grupo(imposto, 'II', ci), 'vII', `${ci}/II`),
    pisValor: valorDoGrupoUnico(imposto, 'PIS', 'vPIS', ci),
    cofinsValor: valorDoGrupoUnico(imposto, 'COFINS', 'vCOFINS', ci),
    informacoesAdicionais: texto(det, 'infAdProd', c, 500),
    rastro,
  };
}

function lerProtocolo(prot: No | undefined): ProtocoloNfeLido | null {
  const inf = grupo(prot, 'infProt', '/nfeProc/protNFe');
  if (!inf) return null;
  const c = '/nfeProc/protNFe/infProt';
  const status = formato(inf, 'cStat', c, /^\d{3}$/);
  return {
    chave: formato(inf, 'chNFe', c, /^[0-9A-Za-z]{44}$/)?.toUpperCase() ?? null,
    status: status === null ? null : Number(status),
    motivo: texto(inf, 'xMotivo', c, 255),
    numero: formato(inf, 'nProt', c, /^\d{15,17}$/),
    data: dataHora(inf, 'dhRecbto', c, false),
    ambiente: formato(inf, 'tpAmb', c, /^[12]$/),
    resumo: texto(inf, 'digVal', c, 100),
  };
}
