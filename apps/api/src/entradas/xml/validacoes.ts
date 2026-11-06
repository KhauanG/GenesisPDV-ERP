/**
 * Validações da NF-e de fornecedor na importação (Fase 2, F2-B18; ERP 13.4; MD 3.8.2; F2-Q3 = D6; F2-Q9 = D50; README
 * da API › decisão 163). Sem SEFAZ (restrição do dono): nada confere cancelamento, denegação nem o XSD; a tela mostra o
 * aviso fixo de que a situação na SEFAZ não foi consultada (F2-B19).
 *
 * **Sempre recusa**, em qualquer valor da chave da assinatura, nesta ordem:
 * - XML malformado, com DTD, grande ou profundo demais, ou fora do layout (o parser, `parser.ts`);
 * - modelo ≠ 55 (a NFC-e não é nota de entrada) e a nota de homologação (sem valor fiscal);
 * - sem `protNFe`, ou com protocolo que não é de autorização (cStat 100 ou 150);
 * - chave com DV inválido (`validarChaveAcesso`), diferente da chave do protocolo, ou que não confere com a UF, o
 *   ano/mês, o emitente, o modelo, a série, o número, o tipo de emissão e o código numérico da própria nota;
 * - destinatário que não é o CNPJ de nenhuma loja da empresa (inclusive o depósito, F2-Q3 = D6: a nota pode vir com
 *   o CNPJ do CD ou de qualquer loja; o estoque de destino é escolhido entre os permitidos no upload);
 * - chave já importada (a nota ignorada também conta: "Reabrir" é o caminho, F2-B19).
 *
 * A assinatura XMLDSig segue `notas_entrada.assinatura_invalida` (padrão `avisar`): inválida ou ausente vira aviso, ou
 * recusa com `recusar`, e com `nao_conferir` nem é conferida. Total que não fecha com os itens é só aviso (a SEFAZ já
 * recusa a nota que não fecha), e o lote do `rastro` com a fabricação depois da validade também (F2-B19: o schema
 * da SEFAZ não impede; a gravação deixa a fabricação fora da sugestão do item).
 */
import {
  CHAVE_ASSINATURA_INVALIDA,
  MOTIVOS_AVISO_NFE,
  MOTIVOS_RECUSA_NFE,
  conferirTotaisNfe,
  validarChaveAcesso,
  type AvisoNfe,
  type TIPOS_LOJA,
  type ModoAssinaturaInvalida,
  type MotivoRecusaNfe,
  type NfeLida,
  type StatusNotaEntrada,
} from '@genesis/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { lerConfiguracao } from '../../configuracoes/valores.js';
import { lojas, notasEntrada } from '../../database/empresa/schema/index.js';
import type { DbEmpresa } from '../../tenancy/tenancy.js';
import { conferirAssinaturaNfe, type ResultadoAssinaturaNfe } from './assinatura.js';
import { lerXmlNfe, RecusaNfe } from './parser.js';

/** Loja da empresa que pode ser a destinatária (inclusive o depósito, `lojas.tipo = 'deposito'`). */
export interface LojaDestinataria {
  id: string;
  nome: string;
  cnpj: string;
  tipo: (typeof TIPOS_LOJA)[number];
}

export interface NotaJaImportada {
  id: string;
  codigo: number;
  status: StatusNotaEntrada;
  /** A loja e o estoque da nota existente: o link da "duplicada" só vai a quem a vê (F2-B19, D45). */
  lojaId: string;
  estoqueId: string;
}

export interface ContextoValidacaoNfe {
  lojas: readonly LojaDestinataria[];
  /** A nota viva com a mesma chave, se já foi importada. */
  notaExistente: NotaJaImportada | null;
  modoAssinatura: ModoAssinaturaInvalida;
}

export type ResultadoValidacaoNfe =
  | {
      aceita: true;
      /** A loja do CNPJ do destinatário (o padrão da `notas_entrada.loja_id`). */
      loja: LojaDestinataria;
      assinatura: ResultadoAssinaturaNfe;
      avisos: AvisoNfe[];
    }
  | {
      aceita: false;
      motivo: MotivoRecusaNfe;
      mensagem: string;
      detalhe: string | null;
      /** Na `CHAVE_JA_IMPORTADA`: a nota existente (o "link para a nota" da ERP 13.4). */
      notaExistente?: NotaJaImportada;
    };

const recusa = (
  motivo: MotivoRecusaNfe,
  detalhe: string | null = null,
  extra: { notaExistente?: NotaJaImportada } = {},
): ResultadoValidacaoNfe => ({
  aceita: false,
  motivo,
  mensagem: detalhe ? `${MOTIVOS_RECUSA_NFE[motivo]} (${detalhe})` : MOTIVOS_RECUSA_NFE[motivo],
  detalhe,
  ...extra,
});

/** AAMM da chave a partir do dhEmi (a data local do emitente, como veio no XML). */
const anoMesDaEmissao = (dhEmi: string) => `${dhEmi.slice(2, 4)}${dhEmi.slice(5, 7)}`;

/**
 * Monta a chave esperada a partir dos dados da nota: cUF(2) AAMM(4) CNPJ/CPF(14) mod(2) série(3) nNF(9) tpEmis(1)
 * cNF(8); o DV (1) é o da própria chave, conferido à parte. O CPF do produtor rural ocupa as 14 posições com zeros à
 * esquerda.
 */
export function chaveEsperadaSemDv(nota: NfeLida): string {
  return [
    nota.cUF,
    anoMesDaEmissao(nota.dataEmissao),
    nota.emitente.documento.padStart(14, '0'),
    String(nota.modelo).padStart(2, '0'),
    String(nota.serie).padStart(3, '0'),
    String(nota.numero).padStart(9, '0'),
    nota.tipoEmissao,
    nota.codigoNumerico,
  ].join('');
}

/** As validações sobre a nota já lida (puras: o contexto vem do banco em `contextoValidacaoNfe`). */
export function validarNfe(
  nota: NfeLida,
  assinatura: ResultadoAssinaturaNfe,
  contexto: ContextoValidacaoNfe,
): ResultadoValidacaoNfe {
  if (nota.modelo !== 55) return recusa('MODELO_NAO_ACEITO', `modelo ${nota.modelo}`);
  if (nota.ambiente === '2' || nota.protocolo?.ambiente === '2') return recusa('HOMOLOGACAO');
  const protocolo = nota.protocolo;
  if (!protocolo) return recusa('SEM_PROTOCOLO');
  if (protocolo.status !== 100 && protocolo.status !== 150)
    return recusa(
      'NAO_AUTORIZADA',
      protocolo.status === null
        ? 'sem cStat'
        : `cStat ${protocolo.status}${protocolo.motivo ? ` – ${protocolo.motivo}` : ''}`,
    );
  if (!protocolo.numero || !protocolo.data) return recusa('SEM_PROTOCOLO', 'protocolo sem número ou data');
  if (!validarChaveAcesso(nota.chave)) return recusa('CHAVE_INVALIDA', nota.chave);
  if (protocolo.chave !== nota.chave) return recusa('CHAVE_DIFERENTE_PROTOCOLO');
  if (nota.digitoVerificador !== null && nota.digitoVerificador !== nota.chave[43])
    return recusa('CHAVE_NAO_CONFERE', 'dígito verificador (cDV)');
  if (chaveEsperadaSemDv(nota) !== nota.chave.slice(0, 43)) return recusa('CHAVE_NAO_CONFERE');

  const destinatario = nota.destinatario;
  const loja =
    destinatario.tipoDocumento === 'cnpj'
      ? contexto.lojas.find((l) => l.cnpj === destinatario.documento)
      : undefined;
  if (!loja)
    return recusa(
      'DESTINATARIO_FORA_DA_EMPRESA',
      destinatario.documento
        ? `${destinatario.tipoDocumento?.toUpperCase()} ${destinatario.documento}`
        : 'sem destinatário',
    );

  if (contexto.notaExistente)
    return recusa('CHAVE_JA_IMPORTADA', `nota Nº ${contexto.notaExistente.codigo}`, {
      notaExistente: contexto.notaExistente,
    });

  const avisos: AvisoNfe[] = [];
  if (assinatura.situacao === 'invalida' || assinatura.situacao === 'ausente') {
    if (contexto.modoAssinatura === 'recusar') return recusa('ASSINATURA_INVALIDA', assinatura.detalhe);
    const motivo = assinatura.situacao === 'invalida' ? 'ASSINATURA_INVALIDA' : 'ASSINATURA_AUSENTE';
    avisos.push({
      motivo,
      mensagem: MOTIVOS_AVISO_NFE[motivo],
      ...(assinatura.detalhe ? { detalhe: assinatura.detalhe } : {}),
    });
  }
  const divergencias = conferirTotaisNfe(nota);
  if (divergencias.length)
    avisos.push({
      motivo: 'TOTAIS_DIVERGENTES',
      mensagem: MOTIVOS_AVISO_NFE.TOTAIS_DIVERGENTES,
      detalhe: divergencias.join('; '),
    });
  const lotesTrocados = nota.itens.flatMap((i) =>
    i.rastro.filter((r) => r.fabricacao > r.validade).map((r) => `item ${i.numeroItem}, lote ${r.lote}`),
  );
  if (lotesTrocados.length)
    avisos.push({
      motivo: 'RASTRO_FABRICACAO_APOS_VALIDADE',
      mensagem: MOTIVOS_AVISO_NFE.RASTRO_FABRICACAO_APOS_VALIDADE,
      detalhe: lotesTrocados.join('; '),
    });
  return { aceita: true, loja, assinatura, avisos };
}

/** Lojas não excluídas (o CNPJ de qualquer uma serve de destinatário), a nota com a mesma chave e o modo da chave. */
export async function contextoValidacaoNfe(db: DbEmpresa, chave: string): Promise<ContextoValidacaoNfe> {
  // Uma consulta de cada vez: `db` é uma conexão só (o upload do F2-B19 chama dentro de `consulta`), e consultas
  // simultâneas no mesmo cliente do `pg` são enfileiradas com aviso de descontinuação.
  const destinos = await db
    .select({ id: lojas.id, nome: lojas.nome, cnpj: lojas.cnpj, tipo: lojas.tipo })
    .from(lojas)
    .where(isNull(lojas.excluidoEm));
  const existentes = await db
    .select({
      id: notasEntrada.id,
      codigo: notasEntrada.codigo,
      status: notasEntrada.status,
      lojaId: notasEntrada.lojaId,
      estoqueId: notasEntrada.estoqueId,
    })
    .from(notasEntrada)
    .where(and(eq(notasEntrada.chave, chave), isNull(notasEntrada.excluidoEm)))
    .limit(1);
  const modoAssinatura = await lerConfiguracao<ModoAssinaturaInvalida>(db, CHAVE_ASSINATURA_INVALIDA);
  const existente = existentes[0];
  return {
    // `lojas.tipo` segue o `ck_lojas_tipo` (TIPOS_LOJA).
    lojas: destinos.map((l) => ({ ...l, tipo: l.tipo as LojaDestinataria['tipo'] })),
    notaExistente: existente ? { ...existente, status: existente.status as StatusNotaEntrada } : null,
    modoAssinatura,
  };
}

export type ResultadoLeituraNfe =
  | (Extract<ResultadoValidacaoNfe, { aceita: true }> & { nota: NfeLida; xml: string })
  | (Extract<ResultadoValidacaoNfe, { aceita: false }> & { chave: string | null });

/**
 * Lê, confere a assinatura e valida um XML de NF-e (o que o upload do F2-B19 faz com cada arquivo). Nunca lança por
 * causa do conteúdo: a recusa volta com o motivo; só erro de banco sobe.
 */
export async function lerEValidarXmlNfe(
  db: DbEmpresa,
  conteudo: Buffer | string,
): Promise<ResultadoLeituraNfe> {
  let lida: { nota: NfeLida; xml: string };
  try {
    lida = lerXmlNfe(conteudo);
  } catch (e) {
    if (!(e instanceof RecusaNfe)) throw e;
    return {
      ...(recusa(e.motivo, e.detalhe) as Extract<ResultadoValidacaoNfe, { aceita: false }>),
      chave: null,
    };
  }
  const contexto = await contextoValidacaoNfe(db, lida.nota.chave);
  const assinatura: ResultadoAssinaturaNfe =
    contexto.modoAssinatura === 'nao_conferir'
      ? { situacao: 'nao_conferida', detalhe: null }
      : conferirAssinaturaNfe(lida.xml, lida.nota);
  const resultado = validarNfe(lida.nota, assinatura, contexto);
  return resultado.aceita ? { ...resultado, ...lida } : { ...resultado, chave: lida.nota.chave };
}
