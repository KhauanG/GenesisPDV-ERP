/**
 * NF-e de fornecedor por XML (ERP 13.4; MD 3.8.2; Fase 2, F2-B18; README da API › decisão 163): a situação da nota,
 * a forma da nota lida do XML (o que o parser seguro da API devolve, com os números como texto nas casas do XML), os
 * motivos de recusa e de aviso da importação, a chave da F2-Q9 (D50) e a conferência dos totais. Sem SEFAZ (restrição
 * do dono): nada aqui consulta situação, cancelamento ou manifestação, e o CFOP do XML só é gravado (sem conversão).
 * Desde o F2-B19 (README da API › decisão 164): o upload (tetos, resultado por arquivo, a tarefa do lote grande), a
 * listagem, o detalhe e as ações Ignorar/Reabrir e a troca do destino. Desde o F2-B20 (README da API › decisão 167): a
 * vinculação dos itens (origem da sugestão, fator pelas quantidades, custo de entrada, regra da nota "pronta" e o
 * contrato do `PUT /notas-entrada/:id/itens`). Desde o F2-B21 (README da API › decisão 169): os contratos de movimentar e
 * estornar a nota (`RECEB_NFE`/`ESTORNO_RECEB_NFE`), com a pergunta do preço de custo (D49) e a confirmação do saldo
 * negativo (D56) do recebimento, e o custo gravado em cada item.
 */
import { z } from 'zod';
import {
  dataCampo,
  dataOpcionalValida,
  decimal,
  textoObrigatorio,
  textoOpcional,
  type MetadadosRegistro,
} from './campos.js';
import { dec, decTexto, type Dec, type Valor } from './decimal.js';
import { paginacaoQuerySchema } from './paginacao.js';
import type { PessoaOpcao } from './pessoas.js';
import type { BaseCustoMargem } from './precos.js';
import type { ProdutoOpcao } from './produtos.js';
import {
  ATUALIZAR_PRECO_RECEBIMENTO,
  confirmarNegativoSchema,
  type AtualizarPrecoRecebimento,
} from './recebimentos.js';
import type { ModoCompraAtualizaPrecoCusto } from './estoque.js';

export const STATUS_NOTA_ENTRADA = ['pendente', 'pronta', 'movimentada', 'estornada', 'ignorada'] as const;
export type StatusNotaEntrada = (typeof STATUS_NOTA_ENTRADA)[number];
/** Filtro "Situação" da ERP 13.4 (o "Resumo SEFAZ" fica fora da Fase 2, sem DF-e). */
export const ROTULOS_STATUS_NOTA_ENTRADA: Record<StatusNotaEntrada, string> = {
  pendente: 'Pendente de vinculação',
  pronta: 'Pronta',
  movimentada: 'Movimentada',
  estornada: 'Estornada',
  ignorada: 'Ignorada',
};

/** Resultado da conferência da assinatura XMLDSig (coluna `notas_entrada.assinatura`). */
export const SITUACOES_ASSINATURA_NFE = ['valida', 'invalida', 'ausente', 'nao_conferida'] as const;
export type SituacaoAssinaturaNfe = (typeof SITUACOES_ASSINATURA_NFE)[number];
export const ROTULOS_ASSINATURA_NFE: Record<SituacaoAssinaturaNfe, string> = {
  valida: 'Válida',
  invalida: 'Não confere',
  ausente: 'Sem assinatura',
  nao_conferida: 'Não conferida',
};

/**
 * `notas_entrada.assinatura_invalida` (F2-Q9 = D50, decidida pelo dono em 05/11/2026: avisar): o que fazer quando a assinatura
 * do XML não confere (ou falta). `avisar` (padrão): a nota entra com o aviso e quem importa (com
 * `notas_entrada.importar`) confirma; `recusar`: a nota é recusada; `nao_conferir`: a assinatura não é conferida.
 * As recusas sempre valem, em qualquer modo: XML malformado, sem protocolo autorizado, modelo ≠ 55, chave com DV
 * errado, destinatário fora da empresa e chave já importada.
 */
export const CHAVE_ASSINATURA_INVALIDA = 'notas_entrada.assinatura_invalida';
export const MODOS_ASSINATURA_INVALIDA = ['avisar', 'recusar', 'nao_conferir'] as const;
export type ModoAssinaturaInvalida = (typeof MODOS_ASSINATURA_INVALIDA)[number];

/**
 * Tetos do parser (contra XML-bomba; o processo é de todas as empresas). A SEFAZ recusa a NF-e acima de 500 KB
 * (rejeição 214), então o `nfeProc` real nunca passa de 1 MiB; a profundidade real é de uns 8 níveis; o layout 4.00
 * aceita até 990 itens, 120 duplicatas, 5.000 volumes e 500 lotes (`rastro`) por item.
 */
export const LIMITES_XML_NFE = {
  bytes: 1024 * 1024,
  profundidade: 24,
  itens: 990,
  duplicatas: 120,
  volumes: 5000,
  rastroPorItem: 500,
} as const;

/** Por que a nota não entra (o resultado por arquivo da importação mostra a mensagem). */
export const MOTIVOS_RECUSA_NFE = {
  XML_GRANDE_DEMAIS: 'O arquivo é grande demais para uma NF-e.',
  XML_COM_DTD: 'O XML tem declaração DOCTYPE ou ENTITY, que uma NF-e não tem.',
  XML_MALFORMADO: 'O arquivo não é um XML válido.',
  XML_PROFUNDO_DEMAIS: 'O XML tem elementos aninhados demais para uma NF-e.',
  NAO_E_NFE: 'O XML não é de uma NF-e (falta o grupo NFe/infNFe).',
  NFE_INVALIDA: 'A NF-e tem um campo fora do layout.',
  MODELO_NAO_ACEITO: 'Só a NF-e modelo 55 é aceita: NFC-e (modelo 65) não entra como nota de entrada.',
  HOMOLOGACAO: 'A NF-e foi emitida em homologação (ambiente de testes) e não tem valor fiscal.',
  SEM_PROTOCOLO: 'O XML não tem o protocolo de autorização (protNFe): envie o XML de distribuição (nfeProc).',
  NAO_AUTORIZADA: 'O protocolo do XML não é de autorização de uso (cStat 100 ou 150).',
  CHAVE_INVALIDA: 'A chave de acesso da NF-e é inválida (dígito verificador errado).',
  CHAVE_DIFERENTE_PROTOCOLO: 'A chave da NF-e é diferente da chave do protocolo de autorização.',
  CHAVE_NAO_CONFERE:
    'A chave de acesso não confere com os dados da nota (UF, data, emitente, modelo, série ou número).',
  DESTINATARIO_FORA_DA_EMPRESA: 'O destinatário da NF-e não é o CNPJ de nenhuma loja da empresa.',
  CHAVE_JA_IMPORTADA: 'Esta NF-e já foi importada.',
  ASSINATURA_INVALIDA: 'A assinatura digital do XML não confere.',
} as const;
export type MotivoRecusaNfe = keyof typeof MOTIVOS_RECUSA_NFE;

/** O que deixa a nota entrar, mas fica visível para quem importa. */
export const MOTIVOS_AVISO_NFE = {
  ASSINATURA_INVALIDA:
    'A assinatura digital do XML não confere: confira a nota com o fornecedor antes de movimentar.',
  ASSINATURA_AUSENTE:
    'O XML não tem assinatura digital: confira a nota com o fornecedor antes de movimentar.',
  TOTAIS_DIVERGENTES: 'Os totais da nota não batem com a soma dos itens.',
  /**
   * Lote do `rastro` com a fabricação depois da validade (o schema da SEFAZ não impede): a nota entra, o rastro fica
   * como veio no jsonb e a sugestão do item (F2-B20) vai sem a fabricação.
   */
  RASTRO_FABRICACAO_APOS_VALIDADE:
    'Um lote da nota tem a fabricação depois da validade: a fabricação ficou de fora da sugestão do item; confira o lote.',
} as const;
export type MotivoAvisoNfe = keyof typeof MOTIVOS_AVISO_NFE;

export interface AvisoNfe {
  motivo: MotivoAvisoNfe;
  mensagem: string;
  detalhe?: string;
}

export interface EnderecoNfeLido {
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipioIbge: string | null;
  municipio: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
}

export interface EmitenteNfeLido {
  /** CNPJ (14, alfanumérico) ou CPF (11, produtor rural), sem máscara. */
  documento: string;
  nome: string;
  fantasia: string | null;
  ie: string | null;
  uf: string;
  /** CRT (1 Simples, 2 Simples excesso, 3 Normal, 4 MEI). */
  crt: string | null;
  endereco: EnderecoNfeLido;
}

export interface DestinatarioNfeLido {
  /** CNPJ, CPF ou o idEstrangeiro, sem máscara (nulo se a nota não tem destinatário identificado). */
  documento: string | null;
  tipoDocumento: 'cnpj' | 'cpf' | 'estrangeiro' | null;
  nome: string | null;
  ie: string | null;
}

/** Dinheiro sempre com 2 casas; ex.: `'1234.50'`. */
export interface TotaisNfeLidos {
  produtos: string;
  frete: string;
  seguro: string;
  desconto: string;
  outras: string;
  ipi: string;
  ipiDevolvido: string;
  ii: string;
  icmsBase: string;
  icms: string;
  icmsDesonerado: string;
  icmsStBase: string;
  icmsSt: string;
  fcpSt: string;
  fcpStRetido: string;
  pis: string;
  cofins: string;
  /** vServ do ISSQNtot (nota conjugada; quase sempre 0). */
  servicos: string;
  /** vNF. */
  total: string;
}

export interface VolumeNfeLido {
  quantidade: string | null;
  especie: string | null;
  marca: string | null;
  numeracao: string | null;
  /** 3 casas. */
  pesoLiquido: string | null;
  pesoBruto: string | null;
}

export interface TransporteNfeLido {
  /** modFrete (0–4, 9). */
  modalidadeFrete: string | null;
  transportadoraDocumento: string | null;
  transportadoraNome: string | null;
  volumes: VolumeNfeLido[];
}

/** Um `rastro` do item (nLote, qLote com 3 casas, dFab, dVal, cAgreg). */
export interface RastroNfeLido {
  lote: string;
  quantidade: string;
  fabricacao: string;
  validade: string;
  codigoAgregacao: string | null;
}

export interface IcmsItemNfeLido {
  /** CST (2 dígitos) ou CSOSN (3 dígitos). */
  situacao: string | null;
  origem: string | null;
  base: string | null;
  /** 4 casas. */
  aliquota: string | null;
  valor: string | null;
  stBase: string | null;
  stValor: string;
  fcpStValor: string;
}

export interface ItemNfeLido {
  numeroItem: number;
  /** cProd. */
  codigo: string;
  /** xProd. */
  descricao: string;
  /** cEAN/cEANTrib; "SEM GTIN" e vazio viram nulo. */
  ean: string | null;
  eanTributavel: string | null;
  ncm: string | null;
  cest: string | null;
  cfop: string;
  unidadeComercial: string;
  /** qCom com 4 casas. */
  quantidadeComercial: string;
  /** vUnCom com 10 casas. */
  valorUnitarioComercial: string;
  unidadeTributavel: string | null;
  quantidadeTributavel: string | null;
  valorUnitarioTributavel: string | null;
  valorProduto: string;
  valorFrete: string;
  valorSeguro: string;
  valorDesconto: string;
  valorOutros: string;
  /** indTot = 1: o vProd do item compõe o total da nota. */
  compoeTotal: boolean;
  icms: IcmsItemNfeLido;
  valorIpi: string;
  valorIpiDevolvido: string;
  valorII: string;
  pisValor: string | null;
  cofinsValor: string | null;
  informacoesAdicionais: string | null;
  rastro: RastroNfeLido[];
}

export interface DuplicataNfeLida {
  sequencia: number;
  numero: string | null;
  /** `AAAA-MM-DD`. */
  vencimento: string | null;
  valor: string;
}

export interface ProtocoloNfeLido {
  chave: string | null;
  /** cStat (100 autorizado, 150 autorizado fora de prazo; os demais não autorizam). */
  status: number | null;
  motivo: string | null;
  numero: string | null;
  /** dhRecbto como veio (ISO 8601 com o fuso). */
  data: string | null;
  ambiente: string | null;
  /** digVal: o DigestValue da assinatura que a SEFAZ autorizou. */
  resumo: string | null;
}

/** A NF-e lida do XML pelo parser seguro (a API devolve, o upload do F2-B19 grava). */
export interface NfeLida {
  /** 44 posições (do Id do infNFe, sem o prefixo "NFe"). */
  chave: string;
  /** Id do infNFe como veio (`NFe` + chave). */
  idInfNfe: string;
  versao: string | null;
  cUF: string;
  codigoNumerico: string;
  modelo: number;
  serie: number;
  numero: number;
  /** dhEmi como veio (ISO 8601 com o fuso). */
  dataEmissao: string;
  naturezaOperacao: string | null;
  /** tpNF: 0 entrada, 1 saída. */
  tipoOperacao: string | null;
  /** finNFe: 1 normal, 2 complementar, 3 ajuste, 4 devolução. */
  finalidade: string | null;
  /** tpAmb: 1 produção, 2 homologação. */
  ambiente: string | null;
  tipoEmissao: string;
  digitoVerificador: string | null;
  emitente: EmitenteNfeLido;
  destinatario: DestinatarioNfeLido;
  totais: TotaisNfeLidos;
  transporte: TransporteNfeLido;
  informacoesComplementares: string | null;
  itens: ItemNfeLido[];
  duplicatas: DuplicataNfeLida[];
  protocolo: ProtocoloNfeLido | null;
  /** O que a Signature declara (a conferência criptográfica é da API). */
  assinatura: { presente: boolean; referencia: string | null; resumo: string | null };
}

const soma = (valores: readonly (string | null)[]): Dec =>
  valores.reduce<Dec>((s, v) => s.plus(dec(v)), dec(0));

/**
 * vNF pela regra de validação da SEFAZ (NT 2011.004, regra 610): vProd − vDesc − vICMSDeson + vST + vFCPST + vFrete +
 * vSeg + vOutro + vII + vIPI + vIPIDevol + vServ. Desde a NT 2023.004 o ICMS desonerado só é deduzido com
 * `indDeduzDeson = 1`, por isso a conferência aceita as duas contas.
 */
export function totaisCalculadosNfe(t: TotaisNfeLidos): { comDesonerado: string; semDesonerado: string } {
  const base = dec(t.produtos)
    .minus(dec(t.desconto))
    .plus(soma([t.icmsSt, t.fcpSt, t.frete, t.seguro, t.outras, t.ii, t.ipi, t.ipiDevolvido, t.servicos]));
  return {
    comDesonerado: base.minus(dec(t.icmsDesonerado)).toFixed(2),
    semDesonerado: base.toFixed(2),
  };
}

/**
 * Confere os totais do ICMSTot contra a soma dos itens e o vNF contra a fórmula. Uma NF-e autorizada sempre passa (a
 * SEFAZ rejeita a que não fecha), então divergência aqui é só aviso: devolve a lista das diferenças ("campo: nota X,
 * itens Y"), vazia quando tudo bate.
 */
export function conferirTotaisNfe(nota: Pick<NfeLida, 'itens' | 'totais'>): string[] {
  const t = nota.totais;
  const doTotal = nota.itens.filter((i) => i.compoeTotal);
  const pares: Array<[string, string, Dec]> = [
    ['vProd', t.produtos, soma(doTotal.map((i) => i.valorProduto))],
    ['vFrete', t.frete, soma(nota.itens.map((i) => i.valorFrete))],
    ['vSeg', t.seguro, soma(nota.itens.map((i) => i.valorSeguro))],
    ['vDesc', t.desconto, soma(nota.itens.map((i) => i.valorDesconto))],
    ['vOutro', t.outras, soma(nota.itens.map((i) => i.valorOutros))],
    ['vIPI', t.ipi, soma(nota.itens.map((i) => i.valorIpi))],
    ['vST', t.icmsSt, soma(nota.itens.map((i) => i.icms.stValor))],
    ['vFCPST', t.fcpSt, soma(nota.itens.map((i) => i.icms.fcpStValor))],
  ];
  const divergencias = pares
    .filter(([, total, itens]) => !dec(total).equals(itens))
    .map(([campo, total, itens]) => `${campo}: nota ${dec(total).toFixed(2)}, itens ${itens.toFixed(2)}`);
  const calculado = totaisCalculadosNfe(t);
  if (
    !dec(t.total).equals(dec(calculado.comDesonerado)) &&
    !dec(t.total).equals(dec(calculado.semDesonerado))
  )
    divergencias.push(`vNF: nota ${dec(t.total).toFixed(2)}, calculado ${calculado.comDesonerado}`);
  return divergencias;
}

// ---------------------------------------------------------------- Upload (F2-B19)

/**
 * Aviso fixo da importação e da nota (sem certificado não há consulta de situação na SEFAZ, restrição do dono): a nota
 * cancelada ou denegada pelo emitente depois de autorizada entra como qualquer outra.
 */
export const AVISO_SEM_SEFAZ = 'Sem consulta à SEFAZ: confira se a nota não foi cancelada pelo emitente.';

/**
 * Tetos do upload (ERP 13.4 "Por Arquivo"): o pedido inteiro até 20 MB (um `.zip` ou vários `.xml`), até 100 arquivos
 * por envio. Cada XML continua com o teto do parser (`LIMITES_XML_NFE.bytes`) e o `.zip` com os limites de zip-bomba
 * da API (1.000 entradas, 100 MiB descompactados), que valem também **somados** para todos os `.zip` do envio.
 */
export const LIMITES_UPLOAD_NFE = {
  bytes: 20 * 1024 * 1024,
  arquivos: 100,
} as const;

/** "20 MB": o teto do envio no texto da tela e das mensagens (montado do `LIMITES_UPLOAD_NFE`). */
export const TETO_UPLOAD_NFE_TEXTO = `${LIMITES_UPLOAD_NFE.bytes / 1024 / 1024} MB`;
/** A recusa do envio acima do teto (a tela, o interceptor antes do multer e a soma conferida na API). */
export const MENSAGEM_ENVIO_GRANDE_NFE = `O envio passa de ${TETO_UPLOAD_NFE_TEXTO}: divida os arquivos.`;

/**
 * Acima de quantos XMLs o envio vai para a tarefa em segundo plano `importar_xml_nfe` (ERP 3.6): até 20 notas a
 * resposta traz o resultado de cada arquivo; acima, a tarefa (acompanhada na própria tela do upload, que consulta
 * `GET /tarefas/:id`) traz o mesmo resultado quando termina. A API aceita outro teto pela variável `NFE_IMPORTACAO_SINCRONA_MAX`.
 */
export const LIMITE_IMPORTACAO_SINCRONA_NFE = 20;
export const TAREFA_IMPORTAR_XML_NFE = 'importar_xml_nfe';

/** Recusas que não vêm do XML: o arquivo, o `.zip` inteiro, o acesso do usuário e o destino da nota. */
export const MOTIVOS_RECUSA_ARQUIVO_NFE = {
  NAO_E_XML: 'O arquivo não é .xml nem .zip.',
  ZIP_CORROMPIDO: 'O arquivo .zip está corrompido.',
  ZIP_GRANDE_DEMAIS: 'O arquivo .zip é grande demais depois de descompactado. Divida o arquivo.',
  ZIP_SEM_XML: 'O arquivo .zip não tem nenhum .xml.',
  /** Os `.zip` do envio, somados, passam dos limites de zip-bomba (o orçamento é do envio, não de cada `.zip`). */
  ENVIO_GRANDE_DEMAIS:
    'Os arquivos .zip deste envio, somados, são grandes demais depois de descompactados. Envie este arquivo em outro envio.',
  LOJA_NAO_PERMITIDA: 'A nota é de uma loja fora das suas lojas permitidas.',
  LOJA_INATIVA: 'A loja destinatária da nota está inativa.',
  ESTOQUE_NAO_PERMITIDO: 'O estoque de destino está fora dos seus estoques permitidos.',
  ESTOQUE_INATIVO: 'O estoque de destino está inativo.',
  EMITENTE_INVALIDO: 'O CNPJ/CPF ou o nome do emitente não servem para cadastrar o fornecedor.',
  /** Erro inesperado ao gravar só esta nota (banco ocupado, restrição): as outras do envio seguem. */
  ERRO_AO_GRAVAR:
    'Não foi possível gravar esta nota agora. As outras do envio seguiram; envie este arquivo de novo.',
} as const;
export type MotivoRecusaArquivoNfe = keyof typeof MOTIVOS_RECUSA_ARQUIVO_NFE;
export type MotivoRecusaImportacaoNfe = MotivoRecusaNfe | MotivoRecusaArquivoNfe;

/** A mensagem de qualquer motivo de recusa da importação. */
export function mensagemRecusaImportacaoNfe(motivo: MotivoRecusaImportacaoNfe): string {
  return motivo in MOTIVOS_RECUSA_NFE
    ? MOTIVOS_RECUSA_NFE[motivo as MotivoRecusaNfe]
    : MOTIVOS_RECUSA_ARQUIVO_NFE[motivo as MotivoRecusaArquivoNfe];
}

/** O que aconteceu com cada XML: a chave já importada é "duplicada", e não "recusada" (ERP 13.4). */
export const SITUACOES_ARQUIVO_NFE = ['importada', 'duplicada', 'recusada'] as const;
export type SituacaoArquivoNfe = (typeof SITUACOES_ARQUIVO_NFE)[number];
export const ROTULOS_SITUACAO_ARQUIVO_NFE: Record<SituacaoArquivoNfe, string> = {
  importada: 'Importada',
  duplicada: 'Já importada',
  recusada: 'Recusada',
};

/**
 * Opções do upload (campos do multipart): o estoque e o tipo de estoque de destino de todas as notas do envio. Vazio =
 * o estoque vinculado à loja do CNPJ do destinatário e o tipo padrão (Disponível). A loja é sempre a do destinatário
 * (F2-Q3 = D6: qualquer loja da empresa, inclusive o CD como depósito); a troca é na aba Dados da nota.
 */
const idVazioNulo = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.uuid().nullable().default(null),
);
export const opcoesImportacaoNfeSchema = z.object({
  estoqueId: idVazioNulo,
  tipoEstoqueId: idVazioNulo,
});
export type OpcoesImportacaoNfe = z.output<typeof opcoesImportacaoNfeSchema>;

export interface ResultadoArquivoNfe {
  /** Nome do arquivo enviado; o XML de dentro do `.zip` sai como `lote.zip › 123.xml`. */
  arquivo: string;
  situacao: SituacaoArquivoNfe;
  /** Nulo na importada. */
  motivo: MotivoRecusaImportacaoNfe | null;
  mensagem: string | null;
  chave: string | null;
  /** A nota criada (importada) ou a já existente (duplicada: o "link para a nota" da ERP 13.4). */
  notaId: string | null;
  notaCodigo: number | null;
  numero: number | null;
  serie: number | null;
  emitenteNome: string | null;
  valorTotal: string | null;
  /** A pessoa do emitente foi criada agora (documento novo) como fornecedor. */
  fornecedorCriado: boolean;
  avisos: AvisoNfe[];
}

export interface ResumoImportacaoNfe {
  importadas: number;
  duplicadas: number;
  recusadas: number;
}

/**
 * Resposta do `POST /notas-entrada/importar`: os resultados por arquivo, ou a tarefa (`tarefaId`) quando o envio passa
 * de `LIMITE_IMPORTACAO_SINCRONA_NFE` XMLs (os resultados chegam no `resultado` da tarefa, com esta mesma forma).
 */
export interface ResultadoImportacaoNfe {
  tarefaId: string | null;
  resumo: ResumoImportacaoNfe;
  resultados: ResultadoArquivoNfe[];
}

export function resumirImportacaoNfe(resultados: readonly ResultadoArquivoNfe[]): ResumoImportacaoNfe {
  return {
    importadas: resultados.filter((r) => r.situacao === 'importada').length,
    duplicadas: resultados.filter((r) => r.situacao === 'duplicada').length,
    recusadas: resultados.filter((r) => r.situacao === 'recusada').length,
  };
}

// ---------------------------------------------------------------- Listagem, detalhe e ações (F2-B19)

/** Período da listagem (ERP 13.4): pela emissão (dhEmi) ou pelo recebimento (a importação). */
export const PERIODOS_NOTA_ENTRADA = ['emissao', 'recebimento'] as const;

/** Filtros da listagem (ERP 13.4): fornecedor/emitente, loja, período, situação e número/chave. */
export const filtroNotasEntradaSchema = paginacaoQuerySchema.extend({
  fornecedorId: z.uuid().optional(),
  /** Emitente (razão social ou fantasia), contém, sem diferenciar maiúsculas. */
  nome: z.string().trim().min(1).max(60).optional(),
  lojaId: z.uuid().optional(),
  estoqueId: z.uuid().optional(),
  periodo: z.enum(PERIODOS_NOTA_ENTRADA).default('emissao'),
  /** No fuso da loja destinatária (ERP 1.5; o dia da emissão e o da importação), como os demais períodos do ERP. */
  dataInicial: dataCampo.optional(),
  dataFinal: dataCampo.optional(),
  status: z.enum(STATUS_NOTA_ENTRADA).optional(),
  /** Número da nota (só dígitos, exato) ou a chave (44 posições, ou o começo dela). */
  numeroChave: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s/g, '').toUpperCase())
    .pipe(z.string().min(1).max(44))
    .optional(),
});
export type FiltroNotasEntrada = z.infer<typeof filtroNotasEntradaSchema>;

export interface NotaEntradaResumo {
  id: string;
  codigo: number;
  chave: string;
  numero: number;
  serie: number;
  emitenteNome: string;
  emitenteFantasia: string | null;
  fornecedorId: string;
  lojaId: string;
  lojaNome: string;
  estoqueId: string;
  estoqueNome: string;
  /** ISO 8601. */
  dataEmissao: string;
  dataRecebimento: string;
  dataMovimentacao: string | null;
  valorTotal: string;
  status: StatusNotaEntrada;
  assinatura: SituacaoAssinaturaNfe;
  qtdItens: number;
  versao: number;
}

export interface ItemNotaEntradaDetalhe {
  id: string;
  numeroItem: number;
  codigoFornecedor: string;
  descricao: string;
  ean: string | null;
  eanTributavel: string | null;
  ncm: string | null;
  cest: string | null;
  /** CFOP do XML, só gravado (sem conversão na Fase 2). */
  cfop: string;
  unidadeComercial: string;
  quantidadeComercial: string;
  valorUnitarioComercial: string;
  unidadeTributavel: string | null;
  quantidadeTributavel: string | null;
  valorProduto: string;
  valorFrete: string;
  valorSeguro: string;
  valorDesconto: string;
  valorOutros: string;
  valorIpi: string;
  valorIcmsSt: string;
  valorFcpSt: string;
  rastro: RastroNfeLido[];
  lote: string | null;
  validade: string | null;
  fabricacao: string | null;
  /** A vinculação (F2-B20). */
  produtoId: string | null;
  /** O produto vinculado (inclusive o excluído depois, para o item continuar legível). */
  produto: ProdutoOpcao | null;
  codigoBarrasId: string | null;
  /** O código da embalagem vinculada. */
  codigoBarras: string | null;
  fator: string;
  /** qCom × fator: gravada só com o fator confirmado (`null` = ainda não confirmado). */
  quantidadeEstoque: string | null;
  /** O fator foi confirmado pelo usuário (o item conta para a nota ficar pronta). */
  fatorConfirmado: boolean;
  /** Sem `produtos.ver_custo`, `null` (com o preço de venda, revelaria a base do markup; decisão 161). */
  markupPct: string | null;
  precoVenda: string | null;
  atualizarPreco: AtualizarPrecoRecebimento;
  ignorado: boolean;
  motivoIgnorado: string | null;
  /** qTrib / qCom (o fator que as quantidades do XML sugerem), `null` quando não dá para calcular. */
  fatorTributavel: string | null;
  /** A sugestão de agora (vínculo anterior ou EAN); `null` = sem sugestão (manual). */
  sugestao: SugestaoVinculoNfe | null;
  /** O vínculo aprendido com o fornecedor para este cProd (o destaque do fator divergente). */
  vinculoAnterior: VinculoAnteriorNfe | null;
  /** De onde veio o vínculo gravado (a sugestão que ele segue, ou "manual"); `null` sem produto. */
  origemVinculo: OrigemVinculoNfe | null;
  /**
   * O custo de entrada por unidade do produto gravado ao movimentar (F2-B21: o mesmo `custoEntradaItemNfeTexto` com as
   * chaves de quando a nota entrou); `null` antes de movimentar e no item ignorado.
   */
  custoUnitario: string | null;
  /** O lote em que o item entrou (achado ou criado ao movimentar); `null` sem lote. */
  loteId: string | null;
}

export interface DuplicataNotaEntrada {
  sequencia: number;
  numero: string | null;
  vencimento: string | null;
  valor: string;
}

export interface NotaEntradaDetalhe extends MetadadosRegistro {
  codigo: number;
  chave: string;
  modelo: number;
  serie: number;
  numero: number;
  dataEmissao: string;
  dataRecebimento: string;
  dataMovimentacao: string | null;
  naturezaOperacao: string | null;
  emitenteCnpj: string;
  emitenteNome: string;
  emitenteFantasia: string | null;
  emitenteIe: string | null;
  emitenteUf: string;
  destinatarioCnpj: string;
  fornecedorId: string;
  fornecedor: PessoaOpcao;
  lojaId: string;
  lojaNome: string;
  estoqueId: string;
  estoqueNome: string;
  tipoEstoqueId: string;
  tipoEstoqueNome: string;
  totais: {
    produtos: string;
    frete: string;
    seguro: string;
    desconto: string;
    outras: string;
    ipi: string;
    ipiDevolvido: string;
    ii: string;
    icms: string;
    icmsDesonerado: string;
    icmsSt: string;
    fcpSt: string;
    total: string;
  };
  transportadoraCnpj: string | null;
  transportadoraNome: string | null;
  modalidadeFrete: string | null;
  volumes: VolumeNfeLido[];
  informacoesComplementares: string | null;
  protocoloNumero: string;
  protocoloData: string;
  protocoloStatus: number;
  assinatura: SituacaoAssinaturaNfe;
  assinaturaDetalhe: string | null;
  status: StatusNotaEntrada;
  motivoIgnorada: string | null;
  criadoPorNome: string | null;
  /** Quem movimentou (a data é `dataMovimentacao`; F2-B21). */
  movimentadaPorNome: string | null;
  /** O estorno (F2-B21): quando, quem e o motivo. */
  estornadaEm: string | null;
  estornadaPorNome: string | null;
  motivoEstorno: string | null;
  /** Os avisos da nota (assinatura que não confere ou ausente, e o fixo da SEFAZ, sempre por último). */
  avisos: string[];
  /** O que a aba "Itens e vinculação" precisa para o custo e o markup ⇄ preço (F2-B20). */
  vinculacao: {
    parcelasCusto: ParcelasCustoNfe;
    custoBaseMargem: BaseCustoMargem;
    compraAtualizaPrecoCusto: ModoCompraAtualizaPrecoCusto;
    /** Quem consulta pode mudar o preço de venda na entrada (a mesma regra do recebimento; decisão 165). */
    podeAlterarPreco: boolean;
    /** Itens resolvidos (vinculados com o fator confirmado ou ignorados) e o total. */
    resolvidos: number;
    total: number;
  };
  itens: ItemNotaEntradaDetalhe[];
  duplicatas: DuplicataNotaEntrada[];
}

/** `GET /notas-entrada/:id/xml`: o XML como foi enviado (a aba XML formata e baixa). */
export interface XmlNotaEntrada {
  nomeArquivo: string;
  xml: string;
}

/** "Ignorar nota" (ERP 13.4): só a pendente ou a pronta, com motivo. */
export const ignorarNotaEntradaSchema = z.object({
  versao: z.number().int().optional(),
  motivo: textoObrigatorio(255, 'Informe o motivo'),
});
export type IgnorarNotaEntrada = z.output<typeof ignorarNotaEntradaSchema>;

/** "Reabrir" (ERP 13.4): a ignorada volta a pendente. */
export const reabrirNotaEntradaSchema = z.object({ versao: z.number().int().optional() });

/**
 * Troca do destino na aba Dados (F2-Q3 = D6): a loja entre as permitidas e o estoque e o tipo entre os permitidos,
 * com a nota pendente ou pronta. Vazio = o estoque vinculado à loja e o tipo padrão.
 */
export const alterarDestinoNotaEntradaSchema = z.object({
  versao: z.number().int(),
  lojaId: z.uuid('Escolha a loja'),
  estoqueId: idVazioNulo,
  tipoEstoqueId: idVazioNulo,
});
export type AlterarDestinoNotaEntrada = z.output<typeof alterarDestinoNotaEntradaSchema>;

/**
 * `POST /notas-entrada/:id/movimentar` (F2-B21; ERP 13.4): a nota "pronta" entra no estoque de destino (`RECEB_NFE`),
 * como o recebimento manual. `versao` (a do documento) é conferida na nota aberta; na já movimentada a chamada é
 * idempotente e devolve o detalhe. `atualizarPrecoCusto` responde à pergunta de `estoque.compra_atualiza_preco_custo`
 * = 'perguntar' (D49), com a mesma regra do recebimento (`movimentarRecebimentoSchema`).
 */
export const movimentarNotaEntradaSchema = z.object({
  versao: z.number().int().optional(),
  atualizarPrecoCusto: z.boolean().nullable().default(null),
});
export type MovimentarNotaEntrada = z.output<typeof movimentarNotaEntradaSchema>;

/**
 * `POST /notas-entrada/:id/estornar` (F2-B21): o motivo é obrigatório e `confirmarNegativo` é a confirmação do saldo
 * negativo da D56 (a mesma do recebimento: a lista que o 422 mostrou).
 */
export const estornarNotaEntradaSchema = z.object({
  versao: z.number().int().optional(),
  motivo: textoObrigatorio(255, 'Informe o motivo do estorno'),
  confirmarNegativo: confirmarNegativoSchema,
});
export type EstornarNotaEntrada = z.output<typeof estornarNotaEntradaSchema>;

/** Rótulos da modalidade do frete (modFrete) na aba Dados. */
export const ROTULOS_MODALIDADE_FRETE: Record<string, string> = {
  '0': 'Por conta do emitente (CIF)',
  '1': 'Por conta do destinatário (FOB)',
  '2': 'Por conta de terceiros',
  '3': 'Transporte próprio do emitente',
  '4': 'Transporte próprio do destinatário',
  '9': 'Sem frete',
};

// ---------------------------------------------------------------- Vinculação dos itens (F2-B20)

/**
 * De onde veio o vínculo do item (ERP 13.4.1), na ordem em que a sugestão é procurada: o vínculo aprendido com o
 * fornecedor (`produtos_fornecedores`: fornecedor + cProd), o EAN do XML (cEAN ou cEANTrib) num código de barras do
 * produto (com o fator da embalagem) ou a escolha à mão. A origem não é gravada: sai da comparação do vínculo gravado
 * com a sugestão de agora (README da API › decisão 167).
 */
export const ORIGENS_VINCULO_NFE = ['vinculo_anterior', 'ean', 'manual'] as const;
export type OrigemVinculoNfe = (typeof ORIGENS_VINCULO_NFE)[number];
export const ROTULOS_ORIGEM_VINCULO_NFE: Record<OrigemVinculoNfe, string> = {
  vinculo_anterior: 'Vínculo anterior',
  ean: 'EAN da embalagem',
  manual: 'Manual',
};

/** A sugestão de vínculo de um item (nunca gravada sozinha: o usuário confirma o fator). */
export interface SugestaoVinculoNfe {
  origem: Exclude<OrigemVinculoNfe, 'manual'>;
  produtoId: string;
  produto: ProdutoOpcao;
  /**
   * A embalagem de compra do cEAN (`produtos_codigos_barras` com "Usa na compra"): na origem "ean", a do código achado
   * quando o fator sugerido é o dela; no vínculo anterior, a do cEAN quando é do mesmo produto, de compra e com o mesmo
   * fator do vínculo; senão `null` (a unidade do produto ou o fator pelas quantidades do XML).
   */
  codigoBarrasId: string | null;
  /** uCom → unidade do produto, 3 casas. */
  fator: string;
}

/** O vínculo aprendido com o fornecedor (fornecedor + cProd), para o destaque do fator divergente. */
export interface VinculoAnteriorNfe {
  produtoId: string;
  fator: string;
}

/**
 * Fator pelas quantidades do XML (qTrib / qCom, a 3 casas): a caixa de 12 latas vem com qCom 10 CX e qTrib 120 UN.
 * `null` sem qTrib, com qCom zero ou com a conta que arredonda a zero.
 */
export function fatorPelasQuantidadesNfe(
  quantidadeComercial: Valor,
  quantidadeTributavel: Valor | null,
): string | null {
  if (quantidadeTributavel === null || quantidadeTributavel === '') return null;
  const qCom = dec(quantidadeComercial);
  const qTrib = dec(quantidadeTributavel);
  if (!qCom.gt(0) || !qTrib.gt(0)) return null;
  const f = decTexto(qTrib.div(qCom), 3);
  return dec(f).gt(0) ? f : null;
}

/** Quantidade no estoque do item (qCom × fator, 3 casas, na unidade do produto). */
export function quantidadeEstoqueNfeTexto(quantidadeComercial: Valor, fator: Valor): string {
  return decTexto(dec(quantidadeComercial).times(fator), 3);
}

/**
 * As parcelas do custo de entrada que as chaves ligam (`estoque.custo_inclui_st`, `_ipi` e `_frete`; F2-Q8 = D49,
 * decidida pelo dono: entram todas, e `estoque.custo_abate_creditos` é ignorada na Fase 2).
 */
export interface ParcelasCustoNfe {
  /** O ICMS-ST e o FCP-ST (vICMSST + vFCPST). */
  incluiSt: boolean;
  incluiIpi: boolean;
  /** O frete **e as despesas** (vFrete + vSeg + vOutro), como diz o rótulo "inclui frete e despesas" (ERP 9.1). */
  incluiFrete: boolean;
}

/**
 * Custo de entrada do item por unidade do produto, a 4 casas (MD 3.8.2; o F2-B21 grava o mesmo número ao movimentar):
 * (vProd + vFrete + vSeg + vOutro − vDesc + vIPI + vICMSST + vFCPST) / (qCom × fator), com o ST e o FCP-ST, o IPI e o
 * frete com as despesas (seguro e outras) só quando a chave liga: `estoque.custo_inclui_frete` é "Custo da NF-e inclui
 * frete e despesas" na tela, e desligada tira as três parcelas juntas. O resultado nunca é negativo. Na vinculação
 * (F2-B20) é a base do markup ⇄ preço da aba.
 */
export function custoEntradaItemNfeTexto(
  item: Pick<
    ItemNotaEntradaDetalhe,
    | 'valorProduto'
    | 'valorFrete'
    | 'valorSeguro'
    | 'valorOutros'
    | 'valorDesconto'
    | 'valorIpi'
    | 'valorIcmsSt'
    | 'valorFcpSt'
  >,
  quantidadeEstoque: Valor,
  parcelas: ParcelasCustoNfe,
): string {
  let total = dec(item.valorProduto).minus(item.valorDesconto);
  if (parcelas.incluiFrete) total = total.plus(item.valorFrete).plus(item.valorSeguro).plus(item.valorOutros);
  if (parcelas.incluiIpi) total = total.plus(item.valorIpi);
  if (parcelas.incluiSt) total = total.plus(item.valorIcmsSt).plus(item.valorFcpSt);
  const q = dec(quantidadeEstoque);
  return decTexto(q.gt(0) && total.gt(0) ? total.div(q) : dec(0), 4);
}

/** Uma parte do item da NF-e que entra num lote do `rastro` (F2-B21): o lote, a quantidade no estoque e as datas. */
export interface ParteLoteNfe {
  lote: string;
  /** Na unidade do produto, 3 casas (a soma das partes é a quantidade no estoque do item). */
  quantidade: string;
  validade: string | null;
  fabricacao: string | null;
}

/**
 * A divisão do item pelos lotes do grupo `rastro` (F2-B21; MD 3.6.9, 3.8.2; F2-Q7 = D48): a nota que traz o item em
 * mais de um lote (o iogurte de 120 unidades em 72 do lote A e 48 do lote B) entra em cada lote com a sua parte, e o
 * saldo por lote do FEFO fica certo. A quantidade no estoque (qCom × fator) é repartida na **proporção** do qLote de
 * cada lote (a proporção não depende da unidade em que o emitente escreveu o qLote), a 3 casas, com o resíduo no lote
 * de maior parte (a soma fecha com o item). O mesmo lote repetido no `rastro` soma numa parte só.
 *
 * Só divide quando o usuário **manteve** o lote sugerido (o do primeiro `rastro`, F2-B19/F2-B20): o lote trocado na
 * vinculação é a decisão dele e o item entra inteiro nesse lote. A primeira parte leva a validade e a fabricação da
 * vinculação (editáveis); as outras, as do `rastro` (a fabricação depois da validade fica nula, como na importação).
 * `null` = não divide (sem lote, um lote só, lote trocado, qLote que soma zero ou parte que daria zero).
 */
export function partesLoteRastroNfe(
  item: {
    lote: string | null;
    validade: string | null;
    fabricacao: string | null;
    rastro: readonly RastroNfeLido[];
  },
  quantidadeEstoque: Valor,
): ParteLoteNfe[] | null {
  const primeiro = item.rastro[0];
  if (item.lote === null || !primeiro || item.lote !== primeiro.lote) return null;
  const porLote = new Map<string, { q: Dec; validade: string | null; fabricacao: string | null }>();
  for (const r of item.rastro) {
    const atual = porLote.get(r.lote);
    if (atual) atual.q = atual.q.plus(r.quantidade);
    else
      porLote.set(r.lote, {
        q: dec(r.quantidade),
        validade: r.validade,
        fabricacao: r.fabricacao <= r.validade ? r.fabricacao : null,
      });
  }
  if (porLote.size < 2) return null;
  const soma = [...porLote.values()].reduce((s, l) => s.plus(l.q), dec(0));
  const total = dec(quantidadeEstoque);
  if (!soma.gt(0) || !total.gt(0) || [...porLote.values()].some((l) => !l.q.gt(0))) return null;
  const partes = [...porLote].map(([lote, l], i) => ({
    lote,
    q: total.times(l.q).div(soma).toDecimalPlaces(3),
    // A primeira parte é o lote da vinculação: as datas que o usuário viu (e pode ter corrigido).
    validade: i === 0 ? item.validade : l.validade,
    fabricacao: i === 0 ? item.fabricacao : l.fabricacao,
  }));
  const maior = partes.reduce((m, p, i) => (p.q.gt(partes[m]!.q) ? i : m), 0);
  const resto = total.minus(partes.reduce((s, p) => s.plus(p.q), dec(0)));
  partes[maior]!.q = partes[maior]!.q.plus(resto);
  if (partes.some((p) => !p.q.gt(0))) return null;
  return partes.map((p) => ({
    lote: p.lote,
    quantidade: decTexto(p.q, 3),
    validade: p.validade,
    fabricacao: p.fabricacao,
  }));
}

/**
 * O item conta para a nota ficar "pronta" (ERP 13.4.1): ignorado (com motivo), ou vinculado a um produto com o fator
 * **confirmado** (a quantidade no estoque gravada). O CFOP não entra na regra (sem conversão de CFOP na Fase 2). É a
 * contagem de resolvidos do detalhe; a situação gravada da nota sai do SQL de `recalcularStatusNotaEntrada` (API), a
 * fonte da regra, com a mesma condição.
 */
export const itemResolvidoNfe = (i: {
  ignorado: boolean;
  produtoId: string | null;
  fatorConfirmado: boolean;
}): boolean => i.ignorado || (i.produtoId !== null && i.fatorConfirmado);

const idVinculoOpcional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.uuid().nullable().default(null),
);
const precoVinculoOpcional = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  decimal({ min: 0, max: 99_999_999_999, casas: 4, mensagem: 'Preço inválido' }).nullable().default(null),
);

/**
 * A vinculação de um item (`PUT /notas-entrada/:id/itens`): o produto (vazio = desvincular), a embalagem de compra (o
 * fator tem de ser o dela), o fator e a confirmação dele, o lote do rastro (editável), o preço de venda proposto com o
 * markup e "Atualizar preço" (aplicados ao movimentar, F2-B21), ou "Ignorar item" com motivo. Só o que é da
 * vinculação: o que veio do XML nunca muda.
 */
export const itemVinculacaoNfeSchema = z.object({
  id: z.uuid('Item inválido'),
  produtoId: idVinculoOpcional,
  codigoBarrasId: idVinculoOpcional,
  /**
   * Vazio = `null` aqui; o `vincularItensNfeSchema` recusa o vazio no item com o fator confirmado ("Informe o fator") e
   * só no item por confirmar (ou ignorado) o troca por 1. Sem isso, o fator apagado na tela virava 1 confirmado e a
   * quantidade no estoque saía qCom × 1 (10 CX em vez de 120 UN).
   */
  fator: z.preprocess(
    (v) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? null : v),
    decimal({ min: 0, max: 999_999, casas: 3, mensagem: 'Fator inválido' }).nullable(),
  ),
  /** O usuário conferiu o fator: só assim o item conta para a nota ficar pronta (a quantidade no estoque é gravada). */
  fatorConfirmado: z.boolean().default(false),
  lote: textoOpcional(30),
  validade: dataOpcionalValida,
  fabricacao: dataOpcionalValida,
  markupPct: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    decimal({ min: -100, max: 99_999, casas: 4, mensagem: 'Markup inválido' }).nullable().default(null),
  ),
  precoVenda: precoVinculoOpcional,
  atualizarPreco: z.enum(ATUALIZAR_PRECO_RECEBIMENTO).default('nao'),
  ignorado: z.boolean().default(false),
  motivoIgnorado: textoOpcional(255),
});
export type ItemVinculacaoNfeEntrada = z.input<typeof itemVinculacaoNfeSchema>;

/** `PUT /notas-entrada/:id/itens`: só os itens enviados mudam (os outros ficam como estão), com a versão da nota. */
export const vincularItensNfeSchema = z
  .object({
    versao: z.number().int(),
    itens: z
      .array(itemVinculacaoNfeSchema)
      .min(1, 'Envie ao menos um item')
      .max(LIMITES_XML_NFE.itens, `No máximo ${LIMITES_XML_NFE.itens} itens`),
  })
  .superRefine((v, ctx) => {
    const vistos = new Map<string, number>();
    v.itens.forEach((it, i) => {
      const erro = (campo: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: ['itens', i, campo], message });
      const chave = it.id.toLowerCase();
      const anterior = vistos.get(chave);
      if (anterior !== undefined) erro('id', `Item repetido (linha ${anterior + 1})`);
      else vistos.set(chave, i);
      if (it.ignorado) {
        if (it.motivoIgnorado === null) erro('motivoIgnorado', 'Informe o motivo para ignorar o item');
        return;
      }
      if (it.fator === null) {
        if (it.fatorConfirmado) erro('fator', 'Informe o fator');
      } else if (!dec(it.fator).gt(0)) erro('fator', 'O fator tem de ser maior que zero');
      if (it.fatorConfirmado && it.produtoId === null)
        erro('produtoId', 'Escolha o produto antes de confirmar');
      if (it.codigoBarrasId !== null && it.produtoId === null) erro('produtoId', 'Escolha o produto');
      if (it.atualizarPreco !== 'nao' && it.precoVenda === null)
        erro('precoVenda', 'Informe o preço de venda a atualizar');
      if (it.lote === null && (it.validade !== null || it.fabricacao !== null))
        erro('lote', 'A validade e a fabricação são do lote: informe o lote');
      if (it.fabricacao !== null && it.validade !== null && it.fabricacao > it.validade)
        erro('fabricacao', 'A fabricação não pode ser depois da validade');
    });
  })
  // O fator vazio só passa no item por confirmar ou ignorado (a conferência acima): ali ele vale 1.
  .transform((v) => ({ ...v, itens: v.itens.map((it) => ({ ...it, fator: it.fator ?? '1.000' })) }));
export type VincularItensNfeEntrada = z.input<typeof vincularItensNfeSchema>;
export type VincularItensNfe = z.output<typeof vincularItensNfeSchema>;
export type ItemVinculacaoNfe = VincularItensNfe['itens'][number];
