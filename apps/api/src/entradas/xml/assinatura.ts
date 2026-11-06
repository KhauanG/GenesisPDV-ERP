/**
 * Conferência da assinatura XMLDSig da NF-e (Fase 2, F2-B18; F2-Q9 = D50; README da API › decisão 163), com o
 * `xml-crypto` sobre o texto que o parser seguro já aceitou (sem DTD, bem formado, profundidade conferida).
 *
 * Confere a **integridade**: a assinatura que vale é a filha da `NFe` que o parser leu (a `ds:Signature` opcional do
 * `protNFe`, a do protocolo pela autorizadora, fica de fora), ela cobre o `infNFe` da nota (Reference `#NFe<chave>`,
 * uma só assinatura na `NFe` e um só elemento com esse Id), o resumo (DigestValue) do `infNFe` canonizado bate e o
 * SignatureValue confere com o certificado do próprio `KeyInfo`; e o resumo é o mesmo que a SEFAZ autorizou (`digVal`
 * do protocolo). Não confere a cadeia ICP-Brasil, a validade do certificado nem se ele é do CNPJ do emitente (sem
 * SEFAZ e sem certificado na Fase 2): o que se pega é o XML alterado depois de assinado, que é o que o aviso precisa
 * dizer.
 *
 * Contra o "embrulho" da assinatura (o `xml-crypto` confere um `infNFe` e o parser lê outro), o `infNFe` é achado no
 * DOM pelo mesmo caminho do parser (`nfeProc/NFe/infNFe`, pelo nome local, como o parser, que tira os prefixos) e o
 * `Id` dele tem de ser, sem aparar, o que o parser leu (o parser apara os valores: `Id="NFe<chave> "` seria lido como a
 * nota e não seria o elemento assinado); e nenhum outro elemento do XML pode ter um Id que, aparado, seja o da nota.
 */
import type { NfeLida, SituacaoAssinaturaNfe } from '@genesis/shared';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';

const DSIG = 'http://www.w3.org/2000/09/xmldsig#';
/** Os nomes de atributo que o `xml-crypto` aceita como Id na Reference (com ou sem prefixo). */
const ATRIBUTOS_ID = ['Id', 'ID', 'id'];

export interface ResultadoAssinaturaNfe {
  situacao: SituacaoAssinaturaNfe;
  /** Por que não é válida (vai para `notas_entrada.assinatura_detalhe` e para o aviso). */
  detalhe: string | null;
}

const invalida = (detalhe: string): ResultadoAssinaturaNfe => ({ situacao: 'invalida', detalhe });
const NAO_COBRE = 'a assinatura não cobre os dados da nota (infNFe)';

/** Filhos elemento de `pai` com o nome local (o namespace não importa, como no parser). */
function filhos(pai: Node, nome: string): Element[] {
  const encontrados: Element[] = [];
  for (let n = pai.firstChild; n; n = n.nextSibling)
    if (n.nodeType === 1 && (n as Element).localName === nome) encontrados.push(n as Element);
  return encontrados;
}

/** A `NFe` e o `infNFe` que o parser leu (`nfeProc/NFe/infNFe` ou a `NFe` solta); nulo se o caminho não é único. */
function localizarNfe(doc: Document): { nfe: Element; inf: Element } | null {
  const raiz = doc.documentElement;
  if (!raiz) return null;
  const nfes = raiz.localName === 'nfeProc' ? filhos(raiz, 'NFe') : raiz.localName === 'NFe' ? [raiz] : [];
  if (nfes.length !== 1) return null;
  const infs = filhos(nfes[0]!, 'infNFe');
  return infs.length === 1 ? { nfe: nfes[0]!, inf: infs[0]! } : null;
}

/** Atributos de Id (os nomes do `xml-crypto`) do elemento. */
function atributosId(e: Element): Attr[] {
  const encontrados: Attr[] = [];
  for (let i = 0; i < e.attributes.length; i++) {
    const a = e.attributes.item(i)!;
    if (ATRIBUTOS_ID.includes(a.localName || a.name)) encontrados.push(a);
  }
  return encontrados;
}

/** Elementos do documento com um atributo de Id que, aparado, é `id` (o assinado e qualquer imitação dele). */
function elementosComId(doc: Document, id: string): Element[] {
  const todos = doc.getElementsByTagName('*');
  const encontrados: Element[] = [];
  for (let i = 0; i < todos.length; i++) {
    const e = todos.item(i)!;
    if (atributosId(e).some((a) => a.value.trim() === id)) encontrados.push(e);
  }
  return encontrados;
}

export function conferirAssinaturaNfe(xml: string, nota: NfeLida): ResultadoAssinaturaNfe {
  if (!nota.assinatura.presente) return { situacao: 'ausente', detalhe: 'o XML não tem assinatura digital' };
  if (nota.assinatura.referencia !== `#${nota.idInfNfe}`) return invalida(NAO_COBRE);
  let doc: Document;
  try {
    doc = new DOMParser({
      errorHandler: {
        warning: () => undefined,
        error: (m: string) => {
          throw new Error(m);
        },
        fatalError: (m: string) => {
          throw new Error(m);
        },
      },
    }).parseFromString(xml, 'text/xml');
  } catch {
    return invalida('a assinatura não pôde ser lida');
  }
  const local = localizarNfe(doc);
  if (!local) return invalida(NAO_COBRE);
  // Um só elemento com o Id assinado, com ou sem espaços: outro `infNFe` com o mesmo Id em outro lugar (no `protNFe`,
  // que o parser não lê, por exemplo) seria o ataque de "embrulho" da assinatura (a conferência passaria sobre um e a
  // leitura usaria o outro).
  const comId = elementosComId(doc, nota.idInfNfe);
  if (comId.length !== 1) return invalida('o Id da nota aparece mais de uma vez no XML');
  // E esse elemento é o `infNFe` lido, com o Id exatamente como o parser o leu (um só, sem prefixo nem espaços).
  const idLido = atributosId(local.inf).filter((a) => (a.localName || a.name) === 'Id');
  if (
    comId[0] !== local.inf ||
    idLido.length !== 1 ||
    idLido[0]!.name !== 'Id' ||
    idLido[0]!.value !== nota.idInfNfe
  )
    return invalida(NAO_COBRE);

  // A assinatura da nota é a filha da `NFe` (a do `protNFe`, do protocolo, não entra na conta).
  const assinaturas = filhos(local.nfe, 'Signature');
  if (assinaturas.length > 1) return invalida('o XML tem mais de uma assinatura');
  const assinatura = assinaturas.find((a) => a.namespaceURI === DSIG);
  if (!assinatura) return invalida('a assinatura da nota não segue o padrão XMLDSig');

  const conferidor = new SignedXml({ getCertFromKeyInfo: SignedXml.getCertFromKeyInfo });
  try {
    conferidor.loadSignature(assinatura);
    if (!conferidor.checkSignature(xml)) return invalida('o conteúdo do XML foi alterado depois de assinado');
    // Uma só Reference conferida (a do `infNFe`): o parser já recusa a Reference repetida.
    if (conferidor.getSignedReferences().length !== 1) return invalida(NAO_COBRE);
  } catch (e) {
    const mensagem = (e as Error).message ?? '';
    return invalida(
      /digest|reference/i.test(mensagem)
        ? 'o conteúdo do XML foi alterado depois de assinado'
        : /signature|key|cert/i.test(mensagem)
          ? 'a assinatura não confere com o certificado do XML'
          : 'a assinatura não pôde ser conferida',
    );
  }
  const resumoProtocolo = nota.protocolo?.resumo ?? null;
  if (resumoProtocolo !== null && resumoProtocolo !== nota.assinatura.resumo)
    return invalida('a assinatura não é a que a SEFAZ autorizou (o resumo difere do protocolo)');
  return { situacao: 'valida', detalhe: null };
}
