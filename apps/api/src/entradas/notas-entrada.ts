/**
 * NF-e de fornecedor por XML: upload, fornecedor pelo emitente, consulta e ações (Fase 2, F2-B19; ERP 13.4 "Por
 * Arquivo"; MD 3.8.2; F2-Q3 = D6; README da API › decisão 164). Sem SEFAZ (restrição do dono): a nota entra com o aviso
 * fixo de que a situação dela não foi consultada, e o CFOP do XML só é gravado.
 *
 * O upload aceita um ou vários `.xml` e `.zip` (até 20 MB no pedido, os limites de zip-bomba de `xml/zip.ts`, por
 * `.zip` e somados para o envio inteiro), e cada
 * XML passa pelo parser seguro e pelas validações do F2-B18 (`lerEValidarXmlNfe`). Depois delas, a importação confere
 * o acesso de quem importa: a loja do CNPJ do destinatário entre as lojas permitidas e ativa, e o estoque de destino
 * (o escolhido no upload ou o vinculado à loja) entre os permitidos para movimentar e ativo. O XML vai para o
 * armazenamento endereçado pelo conteúdo (`chaveXmlFiscal`: o mesmo XML de novo é o mesmo objeto) **antes** da
 * transação (MD 1.5), e a nota, os itens, as duplicatas, a linha de `arquivos` e o fornecedor entram numa transação
 * curta por XML: uma nota recusada nunca derruba as outras do lote (nem o erro inesperado ao gravar uma delas, que
 * vira a recusa `ERRO_AO_GRAVAR` só daquele arquivo), e o lote acima de `LIMITE_IMPORTACAO_SINCRONA_NFE` XMLs vai
 * para a tarefa `importar_xml_nfe`, com o mesmo resultado por arquivo. A chave já importada é "duplicada", e o link
 * para a nota existente só vai a quem a vê (a loja entre as permitidas e o estoque entre os visíveis, D45).
 *
 * O emitente vira fornecedor por `acharOuCriarFornecedorPorDocumento` (F2-B13): o CNPJ/CPF normalizado acha a pessoa
 * que já existe (com qualquer máscara gravada antes, a busca é pelo documento normalizado) e só lhe dá a categoria
 * Fornecedor; o documento novo cria a pessoa com o nome, a fantasia, a IE, o telefone e o endereço do XML (`origem =
 * 'nfe'`). No mesmo envio as notas são gravadas uma depois da outra (a segunda já acha a pessoa); a trava pelo
 * documento serializa os envios simultâneos do mesmo emitente: o fornecedor nasce uma vez só.
 */
import {
  AVISO_SEM_SEFAZ,
  LIMITE_IMPORTACAO_SINCRONA_NFE,
  LIMITES_UPLOAD_NFE,
  MENSAGEM_ENVIO_GRANDE_NFE,
  MOTIVOS_AVISO_NFE,
  TETO_UPLOAD_NFE_TEXTO,
  TAREFA_IMPORTAR_XML_NFE,
  cadastroRapidoFornecedorSchema,
  mensagemRecusaImportacaoNfe,
  resumirImportacaoNfe,
  type CadastroRapidoFornecedor,
  type EmitenteNfeLido,
  dec,
  fatorPelasQuantidadesNfe,
  itemResolvidoNfe,
  type AtualizarPrecoRecebimento,
  type ItemNotaEntradaDetalhe,
  type MotivoRecusaImportacaoNfe,
  type NfeLida,
  type NotaEntradaDetalhe,
  type OpcoesImportacaoNfe,
  type RastroNfeLido,
  type ResultadoArquivoNfe,
  type ResultadoImportacaoNfe,
  type SituacaoAssinaturaNfe,
  type StatusNotaEntrada,
  type VolumeNfeLido,
} from '@genesis/shared';
import { Logger } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { AuditoriaService, OrigemAcao } from '../auditoria/auditoria.service.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import type { PermissoesEfetivas } from '../autorizacao/permissoes-efetivas.js';
import { erroCampo } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { limiteDoAmbiente } from '../comum/limites-processo.js';
import { erroDoDriver } from '../database/erro-postgres.js';
import {
  arquivos as tabelaArquivos,
  itensNotaEntrada,
  notasEntrada,
  notasEntradaDuplicatas,
} from '../database/empresa/schema/index.js';
import { resolverTipoEstoque } from '../estoques/acertos.js';
import { estoquePermitido } from '../estoques/permitidos.js';
import { chaveArquivo, chaveXmlFiscal, type ArmazenamentoObjetos } from '../infra/armazenamento.js';
import { acharOuCriarFornecedorPorDocumento, opcoesPessoaPorId } from '../pessoas/fornecedores.js';
import { opcoesPorId } from '../produtos/consultas.js';
import { sessaoDaTarefa, type ExecucaoTarefa, type TarefasSegundoPlano } from '../tarefas/tarefas.js';
import { TRAVA_OCUPADA, type DbEmpresa, type Tenancy } from '../tenancy/tenancy.js';
import { configuracaoVinculacao, sugestoesVinculoNfe } from './vinculacao.js';
import { lerEValidarXmlNfe } from './xml/validacoes.js';
import {
  ehZip,
  extrairXmlsDoZip,
  novoOrcamentoZipNfe,
  RecusaZipNfe,
  type OrcamentoZipNfe,
} from './xml/zip.js';

const log = new Logger('NotasEntrada');

type Linha = Record<string, unknown>;

export const LOCALIZACAO_NOTAS_ENTRADA = 'Estoque › Recebimento de NFe';
/** Os arquivos do lote que vai para a tarefa ficam no armazenamento só até ela rodar (e um pouco depois). */
const RETENCAO_LOTE_DIAS = 7;

/** Acima de quantos XMLs o envio vai para a tarefa (`NFE_IMPORTACAO_SINCRONA_MAX`; padrão do shared, 20). */
const limiteSincrono = () => limiteDoAmbiente('NFE_IMPORTACAO_SINCRONA_MAX', LIMITE_IMPORTACAO_SINCRONA_NFE);

/** Um arquivo do multipart (o nome já decodificado em UTF-8). */
export interface ArquivoNfeEnviado {
  nome: string;
  conteudo: Buffer;
}

/** As opções do upload conferidas: o estoque escolhido (ou `null` = o da loja de cada nota) e o tipo resolvido. */
export interface DestinoImportacaoNfe {
  estoqueId: string | null;
  tipoEstoqueId: string;
}

interface Dependencias {
  tenancy: Tenancy;
  tarefas: TarefasSegundoPlano;
  armazenamento: ArmazenamentoObjetos;
  auditoria: AuditoriaService;
  permissoes: PermissoesEfetivas;
}

/** O que sai de separar os arquivos enviados: cada XML (inclusive os de dentro do `.zip`) ou a recusa do arquivo. */
type Peca = { xml: ArquivoNfeEnviado } | { recusa: ResultadoArquivoNfe };

const vazio = (arquivo: string): ResultadoArquivoNfe => ({
  arquivo,
  situacao: 'recusada',
  motivo: null,
  mensagem: null,
  chave: null,
  notaId: null,
  notaCodigo: null,
  numero: null,
  serie: null,
  emitenteNome: null,
  valorTotal: null,
  fornecedorCriado: false,
  avisos: [],
});

const recusaArquivo = (
  arquivo: string,
  motivo: MotivoRecusaImportacaoNfe,
  extra: Partial<ResultadoArquivoNfe> = {},
): ResultadoArquivoNfe => ({
  ...vazio(arquivo),
  motivo,
  mensagem: mensagemRecusaImportacaoNfe(motivo),
  ...extra,
});

/**
 * Separa os arquivos do envio, na ordem em que vieram: o `.xml` vai como está; o `.zip` (pelo nome ou pelo conteúdo)
 * é aberto com os limites de zip-bomba e cada `.xml` de dentro vira uma peça (`lote.zip › nota.xml`); o que não é
 * XML nem ZIP, o que o ZIP tem de outro tipo e o XML grande demais de dentro do ZIP são recusados um a um; o ZIP
 * corrompido ou grande demais é recusado inteiro, sem derrubar os outros arquivos do envio. Os `.zip` gastam um
 * **orçamento do envio** (os limites de um `.zip`, somados para todos): o que passaria do que resta é recusado como
 * `ENVIO_GRANDE_DEMAIS` pelo diretório central, sem descompactar, e os seguintes também, até um caber.
 */
export async function separarArquivosNfe(
  arquivos: readonly ArquivoNfeEnviado[],
  orcamento: OrcamentoZipNfe = novoOrcamentoZipNfe(),
): Promise<Peca[]> {
  const pecas: Peca[] = [];
  for (const a of arquivos) {
    if (/\.zip$/i.test(a.nome) || ehZip(a.conteudo)) {
      try {
        const z = await extrairXmlsDoZip(a.conteudo, orcamento);
        const dentro = (nome: string) => `${a.nome} › ${nome}`;
        for (const x of z.xmls) pecas.push({ xml: { nome: dentro(x.nome), conteudo: x.conteudo } });
        for (const n of z.grandesDemais)
          pecas.push({ recusa: recusaArquivo(dentro(n), 'XML_GRANDE_DEMAIS') });
        for (const n of z.pulados) pecas.push({ recusa: recusaArquivo(dentro(n), 'NAO_E_XML') });
        if (!z.xmls.length && !z.grandesDemais.length)
          pecas.push({ recusa: recusaArquivo(a.nome, 'ZIP_SEM_XML') });
      } catch (e) {
        if (!(e instanceof RecusaZipNfe)) throw e;
        pecas.push({ recusa: recusaArquivo(a.nome, e.motivo) });
      }
    } else if (/\.xml$/i.test(a.nome)) pecas.push({ xml: a });
    else pecas.push({ recusa: recusaArquivo(a.nome, 'NAO_E_XML') });
  }
  return pecas;
}

/**
 * As opções do upload: o estoque escolhido existe, está entre os permitidos para movimentar (fora deles, 403 no
 * campo, decisão 149, como o recebimento) e ativo; o tipo de estoque ativo (vazio = o padrão). Sem estoque escolhido,
 * cada nota vai para o estoque da loja do destinatário (conferido nota a nota em `destinoDaNota`).
 */
export async function conferirOpcoesImportacaoNfe(
  db: DbEmpresa,
  sessao: SessaoErp,
  opcoes: OpcoesImportacaoNfe,
): Promise<DestinoImportacaoNfe> {
  let estoqueId: string | null = null;
  if (opcoes.estoqueId) {
    estoqueId = opcoes.estoqueId.toLowerCase();
    const { rows } = await db.execute<{ ativo: boolean }>(sql`
      select ativo from estoques where id = ${estoqueId} and excluido_em is null`);
    if (!rows[0]) throw erroCampo('estoqueId', 'Estoque não encontrado');
    if (!estoquePermitido(sessao, estoqueId, 'movimentar'))
      throw new ErroApi('SEM_PERMISSAO', 'O estoque está fora dos seus estoques permitidos.', {
        campos: { estoqueId: ['Fora dos seus estoques permitidos'] },
      });
    if (!rows[0].ativo) throw erroCampo('estoqueId', 'Estoque inativo');
  }
  return { estoqueId, tipoEstoqueId: await resolverTipoEstoque(db, opcoes.tipoEstoqueId) };
}

/**
 * Destino de uma nota aceita: a loja do destinatário entre as permitidas e ativa, e o estoque (o escolhido no upload,
 * já conferido, ou o vinculado à loja) entre os permitidos para movimentar e ativo. A recusa volta com o motivo (o
 * arquivo é recusado, os outros do lote seguem).
 */
async function destinoDaNota(
  db: DbEmpresa,
  sessao: SessaoErp,
  lojaId: string,
  destino: DestinoImportacaoNfe,
): Promise<
  { lojaId: string; estoqueId: string; tipoEstoqueId: string } | { motivo: MotivoRecusaImportacaoNfe }
> {
  if (!lojaPermitida(sessao, lojaId)) return { motivo: 'LOJA_NAO_PERMITIDA' };
  const { rows } = await db.execute<{
    ativa: boolean;
    estoque_id: string;
    estoque_ativo: boolean | null;
  }>(sql`
    select l.ativa, l.estoque_id, e.ativo as estoque_ativo
      from lojas l left join estoques e on e.id = l.estoque_id and e.excluido_em is null
     where l.id = ${lojaId} and l.excluido_em is null`);
  const l = rows[0];
  if (!l?.ativa) return { motivo: 'LOJA_INATIVA' };
  if (destino.estoqueId)
    return { lojaId, estoqueId: destino.estoqueId, tipoEstoqueId: destino.tipoEstoqueId };
  if (!estoquePermitido(sessao, l.estoque_id, 'movimentar')) return { motivo: 'ESTOQUE_NAO_PERMITIDO' };
  if (!l.estoque_ativo) return { motivo: 'ESTOQUE_INATIVO' };
  return { lojaId, estoqueId: l.estoque_id, tipoEstoqueId: destino.tipoEstoqueId };
}

/**
 * Os dados do cadastro rápido de fornecedor a partir do emitente (F2-B13): CNPJ/CPF, nome, fantasia, IE, telefone e o
 * endereço do `enderEmit`. O que não passa no contrato do cadastro (o telefone fora do formato, o endereço
 * incompleto) fica de fora, e não impede a nota; `null` só quando nem o documento e o nome servem.
 */
export function fornecedorDoEmitente(emit: EmitenteNfeLido): CadastroRapidoFornecedor | null {
  const e = emit.endereco;
  const telefone = e.telefone && /^[1-9]\d\d{8,9}$/.test(e.telefone) ? e.telefone : null;
  const corte = (v: string | null, max: number) => (v === null ? null : v.slice(0, max));
  const base = {
    cpfCnpj: emit.documento,
    nome: emit.nome,
    apelido: emit.fantasia,
    rgIe: emit.ie,
  };
  const endereco = {
    tipo: 'principal',
    cep: e.cep,
    logradouro: corte(e.logradouro, 150),
    numero: corte(e.numero, 20),
    complemento: corte(e.complemento, 80),
    bairro: corte(e.bairro, 80),
    uf: e.uf,
    municipioIbge: e.municipioIbge,
  };
  for (const tentativa of [
    { ...base, telefone, endereco },
    { ...base, telefone, endereco: null },
    { ...base, telefone: null, endereco: null },
  ]) {
    const r = cadastroRapidoFornecedorSchema.safeParse(tentativa);
    if (r.success) return r.data;
  }
  return null;
}

/** O 23505 da chave única da nota (duas importações da mesma chave ao mesmo tempo): a segunda vira "duplicada". */
function chaveRepetida(e: unknown): boolean {
  const pg = erroDoDriver(e);
  return pg.code === '23505' && pg.constraint === 'uq_notas_entrada_chave';
}

/**
 * O complemento da recusa `ERRO_AO_GRAVAR` que o usuário pode ler: a trava ocupada (o ERP espera no máximo
 * `ERP_ESPERA_TRAVA_MS`) e as mensagens da própria API; o erro cru do banco fica só no log.
 */
function detalheErroAoGravar(e: unknown): string | null {
  if (e instanceof ErroApi) return e.message;
  if (erroDoDriver(e).code === TRAVA_OCUPADA) return 'o sistema está ocupado recebendo as vendas dos caixas';
  return null;
}

/** O rastro (lotes) e os volumes como o jsonb guarda: `null` quando o XML não tem nenhum. */
const listaOuNulo = <T>(v: readonly T[]) => (v.length ? v : null);

interface NotaAGravar {
  nota: NfeLida;
  assinatura: { situacao: SituacaoAssinaturaNfe; detalhe: string | null };
  arquivo: string;
  conteudo: Buffer;
  chaveObjeto: string;
  sha256: string;
  lojaId: string;
  estoqueId: string;
  tipoEstoqueId: string;
  fornecedor: CadastroRapidoFornecedor;
}

/**
 * Grava a nota aceita (transação de quem chama, com `travaVersao`: o fornecedor criado desce ao PDV): o fornecedor pelo
 * emitente, a linha de `arquivos` do XML (categoria `xml_nfe_entrada`), o cabeçalho (status `pendente`), os itens e as
 * duplicatas, e a auditoria `importar`. O endereço do emitente só entra com a cidade do IBGE existente na UF dele.
 */
async function gravarNotaEntrada(
  s: Pick<Dependencias, 'auditoria'>,
  tx: DbEmpresa,
  sessao: SessaoErp,
  origem: OrigemAcao,
  g: NotaAGravar,
): Promise<{ id: string; codigo: number; fornecedorCriado: boolean }> {
  const n = g.nota;
  let fornecedor = g.fornecedor;
  const end = fornecedor.endereco;
  if (end) {
    const { rows } = await tx.execute(sql`
      select 1 from municipios where codigo_ibge = ${end.municipioIbge} and uf = ${end.uf}`);
    if (!rows.length) fornecedor = { ...fornecedor, endereco: null };
  }
  const f = await acharOuCriarFornecedorPorDocumento(s, tx, sessao, origem, fornecedor, {
    origemCadastro: 'nfe',
  });
  const id = uuidv7();
  const arquivoId = uuidv7();
  await tx.insert(tabelaArquivos).values({
    id: arquivoId,
    chaveArmazenamento: g.chaveObjeto,
    nomeOriginal: (g.arquivo.split(' › ').pop() ?? g.arquivo).slice(0, 255),
    tipoMime: 'application/xml',
    tamanhoBytes: g.conteudo.length,
    sha256: g.sha256,
    categoria: 'xml_nfe_entrada',
    entidade: 'notas_entrada',
    registroId: id,
    lojaId: g.lojaId,
    criadoPorId: sessao.usuarioId,
    atualizadoPorId: sessao.usuarioId,
  });
  const t = n.totais;
  const [cab] = await tx
    .insert(notasEntrada)
    .values({
      id,
      lojaId: g.lojaId,
      estoqueId: g.estoqueId,
      tipoEstoqueId: g.tipoEstoqueId,
      fornecedorId: f.pessoaId,
      origem: 'upload',
      chave: n.chave,
      modelo: n.modelo,
      serie: n.serie,
      numero: n.numero,
      dataEmissao: new Date(n.dataEmissao),
      naturezaOperacao: n.naturezaOperacao,
      emitenteCnpj: n.emitente.documento,
      emitenteNome: n.emitente.nome,
      emitenteFantasia: n.emitente.fantasia,
      emitenteIe: n.emitente.ie,
      emitenteUf: n.emitente.uf,
      destinatarioCnpj: n.destinatario.documento!,
      valorProdutos: t.produtos,
      valorFrete: t.frete,
      valorSeguro: t.seguro,
      valorDesconto: t.desconto,
      valorOutras: t.outras,
      valorIpi: t.ipi,
      valorIpiDevolvido: t.ipiDevolvido,
      valorIi: t.ii,
      valorIcms: t.icms,
      valorIcmsDesonerado: t.icmsDesonerado,
      valorIcmsSt: t.icmsSt,
      valorFcpSt: t.fcpSt,
      valorTotal: t.total,
      transportadoraCnpj: n.transporte.transportadoraDocumento,
      transportadoraNome: n.transporte.transportadoraNome,
      modalidadeFrete: n.transporte.modalidadeFrete,
      volumes: listaOuNulo(n.transporte.volumes),
      informacoesComplementares: n.informacoesComplementares,
      protocoloNumero: n.protocolo!.numero!,
      protocoloData: new Date(n.protocolo!.data!),
      protocoloStatus: n.protocolo!.status!,
      assinatura: g.assinatura.situacao,
      assinaturaDetalhe: g.assinatura.detalhe?.slice(0, 255) ?? null,
      status: 'pendente',
      xmlArquivoId: arquivoId,
      criadoPorId: sessao.usuarioId,
      atualizadoPorId: sessao.usuarioId,
    })
    .returning({ codigo: notasEntrada.codigo });
  await tx.insert(itensNotaEntrada).values(
    n.itens.map((i) => {
      const primeiro = i.rastro[0];
      return {
        notaEntradaId: id,
        numeroItem: i.numeroItem,
        codigoFornecedor: i.codigo,
        descricao: i.descricao,
        ean: i.ean,
        eanTributavel: i.eanTributavel,
        ncm: i.ncm,
        cest: i.cest,
        cfop: i.cfop,
        unidadeComercial: i.unidadeComercial,
        quantidadeComercial: i.quantidadeComercial,
        valorUnitarioComercial: i.valorUnitarioComercial,
        unidadeTributavel: i.unidadeTributavel,
        quantidadeTributavel: i.quantidadeTributavel,
        valorUnitarioTributavel: i.valorUnitarioTributavel,
        valorProduto: i.valorProduto,
        valorFrete: i.valorFrete,
        valorSeguro: i.valorSeguro,
        valorDesconto: i.valorDesconto,
        valorOutros: i.valorOutros,
        valorIpi: i.valorIpi,
        valorIcmsSt: i.icms.stValor,
        valorFcpSt: i.icms.fcpStValor,
        icmsSituacao: i.icms.situacao,
        icmsOrigem: i.icms.origem,
        icmsBase: i.icms.base,
        icmsAliquota: i.icms.aliquota,
        icmsValor: i.icms.valor,
        pisValor: i.pisValor,
        cofinsValor: i.cofinsValor,
        informacoesAdicionais: i.informacoesAdicionais,
        rastro: listaOuNulo(i.rastro),
        // O primeiro lote do `rastro` é a sugestão editável da vinculação (F2-B20).
        lote: primeiro?.lote ?? null,
        validade: primeiro?.validade ?? null,
        // A fabricação depois da validade (o aviso `RASTRO_FABRICACAO_APOS_VALIDADE`) fica só no rastro: o
        // `ck_itens_nota_entrada_validade` recusaria a nota inteira.
        fabricacao: primeiro && primeiro.fabricacao <= primeiro.validade ? primeiro.fabricacao : null,
      };
    }),
  );
  if (n.duplicatas.length)
    await tx.insert(notasEntradaDuplicatas).values(
      n.duplicatas.map((d) => ({
        notaEntradaId: id,
        sequencia: d.sequencia,
        numero: d.numero,
        vencimento: d.vencimento,
        valor: d.valor,
      })),
    );
  await s.auditoria.registrar(tx, origem, {
    acao: 'importar',
    entidade: 'notas_entrada',
    registroId: id,
    localizacao: LOCALIZACAO_NOTAS_ENTRADA,
    lojaId: g.lojaId,
    descricao: `NF-e Nº ${n.numero} série ${n.serie} de ${n.emitente.nome} importada do arquivo ${g.arquivo}`,
    depois: {
      chave: n.chave,
      numero: n.numero,
      serie: n.serie,
      emitenteCnpj: n.emitente.documento,
      fornecedorId: f.pessoaId,
      fornecedorCriado: f.criada,
      lojaId: g.lojaId,
      estoqueId: g.estoqueId,
      tipoEstoqueId: g.tipoEstoqueId,
      valorTotal: t.total,
      qtdItens: n.itens.length,
      assinatura: g.assinatura.situacao,
      xmlArquivoId: arquivoId,
    },
  });
  return { id, codigo: cab!.codigo, fornecedorCriado: f.criada };
}

export class NotasEntrada {
  constructor(private readonly d: Dependencias) {
    d.tarefas.registrarTipo(TAREFA_IMPORTAR_XML_NFE, (e) => this.executarTarefa(e));
  }

  /**
   * `POST /notas-entrada/importar`: confere as opções, separa os arquivos e importa cada XML, ou, acima de
   * `LIMITE_IMPORTACAO_SINCRONA_NFE` XMLs, guarda os arquivos e cria a tarefa (a resposta traz só o `tarefaId`).
   */
  async importar(
    sessao: SessaoErp,
    origem: OrigemAcao,
    arquivos: readonly ArquivoNfeEnviado[],
    opcoes: OpcoesImportacaoNfe,
  ): Promise<ResultadoImportacaoNfe> {
    const cx = this.d.tenancy.cx();
    const destino = await cx.consulta((db) => conferirOpcoesImportacaoNfe(db, sessao, opcoes));
    const pecas = await separarArquivosNfe(arquivos);
    if (pecas.filter((p) => 'xml' in p).length > limiteSincrono()) {
      const tarefaId = await this.agendarLote(sessao, arquivos, opcoes);
      return { tarefaId, resumo: resumirImportacaoNfe([]), resultados: [] };
    }
    const resultados: ResultadoArquivoNfe[] = [];
    for (const p of pecas)
      resultados.push('xml' in p ? await this.importarXml(sessao, origem, destino, p.xml) : p.recusa);
    return { tarefaId: null, resumo: resumirImportacaoNfe(resultados), resultados };
  }

  /**
   * Um XML: lê e valida (F2-B18), confere o acesso e o destino, grava o XML no armazenamento (fora da transação, MD
   * 1.5) e a nota numa transação curta. A chave já importada (antes, ou por outra importação ao mesmo tempo, pelo
   * 23505 da chave única) é "duplicada", com a nota existente quando quem importa a vê. Nunca lança: o erro
   * inesperado (o banco, a trava ocupada além da espera do ERP, o armazenamento) vira a recusa `ERRO_AO_GRAVAR` só
   * deste arquivo, com o erro no log, e os outros do envio seguem. `naTarefa`: na tarefa do lote grande a transação
   * espera a trava de versão sem limite (`esperaSemLimite`, como as outras tarefas), em vez do limite do ERP.
   */
  async importarXml(
    sessao: SessaoErp,
    origem: OrigemAcao,
    destino: DestinoImportacaoNfe,
    arquivo: ArquivoNfeEnviado,
    opcoes: { naTarefa?: boolean } = {},
  ): Promise<ResultadoArquivoNfe> {
    try {
      return await this.importarUmXml(sessao, origem, destino, arquivo, opcoes.naTarefa ?? false);
    } catch (e) {
      log.error(
        `Falha ao importar o XML de NF-e ${arquivo.nome} (empresa ${this.d.tenancy.atual().codigo}): ${(e as Error).message}`,
        (e as Error).stack,
      );
      const detalhe = detalheErroAoGravar(e);
      return recusaArquivo(arquivo.nome, 'ERRO_AO_GRAVAR', {
        mensagem: `${mensagemRecusaImportacaoNfe('ERRO_AO_GRAVAR')}${detalhe ? ` (${detalhe})` : ''}`,
      });
    }
  }

  /**
   * A chave já importada: "duplicada", com o link para a nota existente só quando quem importa a vê (a loja dela entre
   * as permitidas e o estoque entre os visíveis, D45: fora deles o detalhe é 404). Sem acesso, a resposta não diz o
   * código da nota, como a recusa por loja ou estoque não diria nada da nota nova.
   */
  private duplicada(
    sessao: SessaoErp,
    base: ResultadoArquivoNfe,
    existente: { id: string; codigo: number; lojaId: string; estoqueId: string } | undefined,
  ): ResultadoArquivoNfe {
    const visivel =
      existente &&
      lojaPermitida(sessao, existente.lojaId) &&
      estoquePermitido(sessao, existente.estoqueId, 'ver');
    return {
      ...base,
      situacao: 'duplicada',
      motivo: 'CHAVE_JA_IMPORTADA',
      mensagem: visivel
        ? `${mensagemRecusaImportacaoNfe('CHAVE_JA_IMPORTADA')} (nota Nº ${existente.codigo})`
        : mensagemRecusaImportacaoNfe('CHAVE_JA_IMPORTADA'),
      notaId: visivel ? existente.id : null,
      notaCodigo: visivel ? existente.codigo : null,
    };
  }

  private async importarUmXml(
    sessao: SessaoErp,
    origem: OrigemAcao,
    destino: DestinoImportacaoNfe,
    arquivo: ArquivoNfeEnviado,
    naTarefa: boolean,
  ): Promise<ResultadoArquivoNfe> {
    const cx = this.d.tenancy.cx();
    const lida = await cx.consulta((db) => lerEValidarXmlNfe(db, arquivo.conteudo));
    if (!lida.aceita) {
      const base = {
        ...vazio(arquivo.nome),
        motivo: lida.motivo,
        mensagem: lida.mensagem,
        chave: lida.chave,
      };
      return lida.motivo === 'CHAVE_JA_IMPORTADA' && lida.notaExistente
        ? this.duplicada(sessao, base, lida.notaExistente)
        : base;
    }
    const n = lida.nota;
    const dadosNota: Partial<ResultadoArquivoNfe> = {
      chave: n.chave,
      numero: n.numero,
      serie: n.serie,
      emitenteNome: n.emitente.nome,
      valorTotal: n.totais.total,
      avisos: lida.avisos,
    };
    const alvo = await cx.consulta((db) => destinoDaNota(db, sessao, lida.loja.id, destino));
    if ('motivo' in alvo) return recusaArquivo(arquivo.nome, alvo.motivo, dadosNota);
    const fornecedor = fornecedorDoEmitente(n.emitente);
    if (!fornecedor) return recusaArquivo(arquivo.nome, 'EMITENTE_INVALIDO', dadosNota);
    const chaveObjeto = chaveXmlFiscal(cx.contexto.codigo, arquivo.conteudo);
    const { sha256 } = await this.d.armazenamento.gravar(chaveObjeto, arquivo.conteudo, 'application/xml');
    try {
      const r = await cx.transacao(
        (tx) =>
          gravarNotaEntrada(this.d, tx, sessao, origem, {
            nota: n,
            assinatura: lida.assinatura,
            arquivo: arquivo.nome,
            conteudo: arquivo.conteudo,
            chaveObjeto,
            sha256,
            ...alvo,
            fornecedor,
          }),
        { travaVersao: true, esperaSemLimite: naTarefa },
      );
      return {
        ...vazio(arquivo.nome),
        ...dadosNota,
        situacao: 'importada',
        notaId: r.id,
        notaCodigo: r.codigo,
        fornecedorCriado: r.fornecedorCriado,
      };
    } catch (e) {
      if (chaveRepetida(e)) {
        const { rows } = await cx.consulta((db) =>
          db.execute<{ id: string; codigo: number; loja_id: string; estoque_id: string }>(sql`
            select id, codigo, loja_id, estoque_id from notas_entrada
             where chave = ${n.chave} and excluido_em is null`),
        );
        const r = rows[0];
        return this.duplicada(
          sessao,
          { ...vazio(arquivo.nome), ...dadosNota },
          r && { id: r.id, codigo: r.codigo, lojaId: r.loja_id, estoqueId: r.estoque_id },
        );
      }
      // O cadastro do fornecedor recusado pela API (ex.: o documento de uma pessoa excluída de outro jeito): só este
      // arquivo é recusado.
      if (e instanceof ErroApi && e.codigo === 'VALIDACAO')
        return recusaArquivo(arquivo.nome, 'EMITENTE_INVALIDO', dadosNota);
      throw e;
    }
  }

  /**
   * O lote grande: cada arquivo enviado vai para o armazenamento (categoria `outro`, retenção de 7 dias) e a tarefa
   * `importar_xml_nfe` nasce na transação, agendada depois do commit (ERP 3.6).
   */
  private async agendarLote(
    sessao: SessaoErp,
    arquivos: readonly ArquivoNfeEnviado[],
    opcoes: OpcoesImportacaoNfe,
  ): Promise<string> {
    const cx = this.d.tenancy.cx();
    const retencao = new Date(Date.now() + RETENCAO_LOTE_DIAS * 86_400_000).toISOString().slice(0, 10);
    const guardados: Array<{ chave: string; nome: string; sha256: string; tamanho: number; zip: boolean }> =
      [];
    for (const a of arquivos) {
      const zip = /\.zip$/i.test(a.nome) || ehZip(a.conteudo);
      const chave = chaveArquivo(cx.contexto.codigo, 'nfe_importacao', zip ? 'zip' : 'xml');
      const tipo = zip ? 'application/zip' : 'application/xml';
      const { sha256, tamanhoBytes } = await this.d.armazenamento.gravar(chave, a.conteudo, tipo);
      guardados.push({ chave, nome: a.nome, sha256, tamanho: tamanhoBytes, zip });
    }
    const tarefaId = await cx.transacao(async (tx) => {
      const ids: Array<{ arquivoId: string; nome: string }> = [];
      for (const g of guardados) {
        const [a] = await tx
          .insert(tabelaArquivos)
          .values({
            chaveArmazenamento: g.chave,
            nomeOriginal: g.nome.slice(0, 255),
            tipoMime: g.zip ? 'application/zip' : 'application/xml',
            tamanhoBytes: g.tamanho,
            sha256: g.sha256,
            categoria: 'outro',
            entidade: 'notas_entrada',
            retencaoAte: retencao,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning({ id: tabelaArquivos.id });
        ids.push({ arquivoId: a!.id, nome: g.nome });
      }
      return this.d.tarefas.criar(tx, {
        tipo: TAREFA_IMPORTAR_XML_NFE,
        parametros: { arquivos: ids, opcoes },
        usuarioId: sessao.usuarioId,
      });
    });
    await this.d.tarefas.agendar(cx.contexto.empresaId, tarefaId);
    return tarefaId;
  }

  /**
   * A tarefa do lote grande: a sessão de quem pediu com o acesso **do momento** (sem `notas_entrada.importar`, ou sem o
   * estoque escolhido, a tarefa falha com a mensagem), os arquivos relidos do armazenamento e cada XML importado como
   * no envio direto, com o progresso. O resultado é o `ResultadoImportacaoNfe` com o `tarefaId`.
   */
  private async executarTarefa(e: ExecucaoTarefa) {
    const cx = this.d.tenancy.cx();
    const parametros = e.tarefa.parametros as {
      arquivos: Array<{ arquivoId: string; nome: string }>;
      opcoes: OpcoesImportacaoNfe;
    };
    const sessao = await cx.consulta((db) =>
      sessaoDaTarefa(db, this.d.tenancy, this.d.permissoes, e.tarefa.usuarioId, e.tarefa.id),
    );
    if (!sessao.permissoes.has('notas_entrada.importar'))
      throw new Error('O usuário não tem mais a permissão de importar NF-e.');
    let destino: DestinoImportacaoNfe;
    try {
      destino = await cx.consulta((db) => conferirOpcoesImportacaoNfe(db, sessao, parametros.opcoes));
    } catch (erro) {
      throw new Error((erro as Error).message, { cause: erro });
    }
    await e.progresso(1, 'Lendo os arquivos');
    const arquivos: ArquivoNfeEnviado[] = [];
    for (const a of parametros.arquivos) {
      const [linha] = await cx.consulta((db) =>
        db
          .select({ chave: tabelaArquivos.chaveArmazenamento })
          .from(tabelaArquivos)
          .where(eq(tabelaArquivos.id, a.arquivoId)),
      );
      if (!linha) throw new Error(`Arquivo não encontrado: ${a.nome}`);
      arquivos.push({ nome: a.nome, conteudo: await this.d.armazenamento.ler(linha.chave) });
    }
    const pecas = await separarArquivosNfe(arquivos);
    const origem: OrigemAcao = {
      origem: 'importacao',
      usuarioId: sessao.usuarioId,
      usuarioNome: sessao.usuarioNome,
    };
    const resultados: ResultadoArquivoNfe[] = [];
    for (const [i, p] of pecas.entries()) {
      if (i % 5 === 0) await e.progresso(2 + (i / pecas.length) * 96, `Arquivo ${i + 1} de ${pecas.length}`);
      resultados.push(
        'xml' in p ? await this.importarXml(sessao, origem, destino, p.xml, { naTarefa: true }) : p.recusa,
      );
    }
    const r: ResultadoImportacaoNfe = {
      tarefaId: e.tarefa.id,
      resumo: resumirImportacaoNfe(resultados),
      resultados,
    };
    return { resultado: r as unknown as Record<string, unknown> };
  }
}

/** O teto do pedido inteiro (o multer confere por arquivo; a soma é conferida aqui). */
export function conferirTamanhoEnvioNfe(arquivos: readonly ArquivoNfeEnviado[]): void {
  if (!arquivos.length)
    throw new ErroApi('VALIDACAO', 'Envie o XML ou o .zip das notas.', {
      campos: { arquivos: ['Escolha os arquivos'] },
    });
  const total = arquivos.reduce((s, a) => s + a.conteudo.length, 0);
  if (total > LIMITES_UPLOAD_NFE.bytes)
    throw new ErroApi('VALIDACAO', MENSAGEM_ENVIO_GRANDE_NFE, {
      campos: { arquivos: [`Até ${TETO_UPLOAD_NFE_TEXTO} por envio`] },
    });
}

// ---------------------------------------------------------------- Consulta

/** Versão do documento inteiro (cabeçalho + itens, decisão 47, como o recebimento). */
export const sqlVersaoNotaEntrada = sql`greatest(n.versao, coalesce((select max(i.versao) from itens_nota_entrada i where i.nota_entrada_id = n.id), 0))`;

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const texto = (v: unknown) => (v as string | null) ?? null;

/** Os avisos da nota no detalhe: a assinatura que não confere ou ausente (D50) e o aviso fixo da SEFAZ, por último. */
export function avisosDaNota(assinatura: SituacaoAssinaturaNfe, detalhe: string | null): string[] {
  const avisos: string[] = [];
  if (assinatura === 'invalida')
    avisos.push(`${MOTIVOS_AVISO_NFE.ASSINATURA_INVALIDA}${detalhe ? ` (${detalhe})` : ''}`);
  if (assinatura === 'ausente') avisos.push(MOTIVOS_AVISO_NFE.ASSINATURA_AUSENTE);
  avisos.push(AVISO_SEM_SEFAZ);
  return avisos;
}

/**
 * Detalhe da nota; `null` = inexistente, excluída ou fora dos estoques visíveis (D45: como o recebimento). O CPF/CNPJ
 * do fornecedor só sai com `pessoas.ver` (LGPD); o do emitente é parte da nota. Desde o F2-B20, cada item traz o
 * vínculo gravado, a sugestão de agora e a origem do vínculo (`vinculacao.ts`), e a nota, as chaves da aba de itens.
 * Desde o F2-B21, quem movimentou e o estorno (quando, quem e o motivo) e, em cada item, o custo e o lote gravados ao
 * movimentar.
 */
export async function detalheNotaEntrada(
  db: DbEmpresa,
  id: string,
  sessao: SessaoErp,
  filtroEstoque: SQL | undefined,
): Promise<NotaEntradaDetalhe | null> {
  const { rows } = await db.execute<Linha>(sql`
    select n.*, l.nome as loja_nome, e.nome as estoque_nome, t.nome as tipo_estoque_nome,
           au.nome as autor_nome, cr.nome as criado_por_nome, mv.nome as movimentada_por_nome,
           es.nome as estornada_por_nome, ${sqlVersaoNotaEntrada} as versao_documento,
           n.valor_produtos::text as v_produtos, n.valor_frete::text as v_frete, n.valor_seguro::text as v_seguro,
           n.valor_desconto::text as v_desconto, n.valor_outras::text as v_outras, n.valor_ipi::text as v_ipi,
           n.valor_ipi_devolvido::text as v_ipi_devolvido, n.valor_ii::text as v_ii, n.valor_icms::text as v_icms,
           n.valor_icms_desonerado::text as v_icms_desonerado, n.valor_icms_st::text as v_icms_st,
           n.valor_fcp_st::text as v_fcp_st, n.valor_total::text as v_total
      from notas_entrada n
      join lojas l on l.id = n.loja_id
      join estoques e on e.id = n.estoque_id
      join tipos_estoque t on t.id = n.tipo_estoque_id
      left join usuarios au on au.id = n.atualizado_por_id
      left join usuarios cr on cr.id = n.criado_por_id
      left join usuarios mv on mv.id = n.movimentada_por_id
      left join usuarios es on es.id = n.estornada_por_id
     where n.id = ${id} and n.excluido_em is null ${filtroEstoque ? sql`and ${filtroEstoque}` : sql``}`);
  const n = rows[0];
  if (!n) return null;
  const { rows: itens } = await db.execute<Linha>(sql`
    select i.id, i.numero_item, i.codigo_fornecedor, i.descricao, i.ean, i.ean_tributavel, i.ncm, i.cest, i.cfop,
           i.unidade_comercial, i.quantidade_comercial::text, i.valor_unitario_comercial::text, i.unidade_tributavel,
           i.quantidade_tributavel::text, i.valor_produto::text, i.valor_frete::text, i.valor_seguro::text,
           i.valor_desconto::text, i.valor_outros::text, i.valor_ipi::text, i.valor_icms_st::text,
           i.valor_fcp_st::text, i.rastro, i.lote, i.validade::text, i.fabricacao::text, i.produto_id,
           i.codigo_barras_id, c.codigo as codigo_barras, i.fator::text, i.quantidade_estoque::text,
           i.markup_pct::text, i.preco_venda::text, i.atualizar_preco, i.ignorado, i.motivo_ignorado,
           i.custo_unitario::text, i.lote_id
      from itens_nota_entrada i
      left join produtos_codigos_barras c on c.id = i.codigo_barras_id
     where i.nota_entrada_id = ${id} and i.excluido_em is null order by i.numero_item`);
  const { rows: duplicatas } = await db.execute<Linha>(sql`
    select sequencia, numero, vencimento::text, valor::text from notas_entrada_duplicatas
     where nota_entrada_id = ${id} and excluido_em is null order by sequencia`);
  const fornecedores = await opcoesPessoaPorId(db, [n.fornecedor_id as string], {
    semDocumento: !sessao.permissoes.has('pessoas.ver'),
  });
  const assinatura = n.assinatura as SituacaoAssinaturaNfe;
  // A vinculação (F2-B20): os produtos vinculados (inclusive o excluído depois), a sugestão de agora e o vínculo
  // aprendido de cada cProd, e as chaves do custo e do markup da loja destinatária.
  const verCusto = sessao.permissoes.has('produtos.ver_custo');
  const produtos = await opcoesPorId(
    db,
    itens.flatMap((i) => (i.produto_id ? [i.produto_id as string] : [])),
    verCusto,
  );
  const sugestoes = await sugestoesVinculoNfe(
    db,
    n.fornecedor_id as string,
    itens.map((i) => ({
      id: i.id as string,
      codigoFornecedor: i.codigo_fornecedor as string,
      ean: texto(i.ean),
      eanTributavel: texto(i.ean_tributavel),
      quantidadeComercial: i.quantidade_comercial as string,
      quantidadeTributavel: texto(i.quantidade_tributavel),
    })),
    verCusto,
  );
  const config = await configuracaoVinculacao(db, n.loja_id as string, sessao);
  const itensDetalhe = itens.map((i): ItemNotaEntradaDetalhe => {
    const produtoId = texto(i.produto_id);
    const quantidadeEstoque = texto(i.quantidade_estoque);
    const fator = i.fator as string;
    const s = sugestoes.get(i.id as string);
    const sugestao = s?.sugestao ?? null;
    return {
      id: i.id as string,
      numeroItem: i.numero_item as number,
      codigoFornecedor: i.codigo_fornecedor as string,
      descricao: i.descricao as string,
      ean: texto(i.ean),
      eanTributavel: texto(i.ean_tributavel),
      ncm: texto(i.ncm),
      cest: texto(i.cest),
      cfop: i.cfop as string,
      unidadeComercial: i.unidade_comercial as string,
      quantidadeComercial: i.quantidade_comercial as string,
      valorUnitarioComercial: i.valor_unitario_comercial as string,
      unidadeTributavel: texto(i.unidade_tributavel),
      quantidadeTributavel: texto(i.quantidade_tributavel),
      valorProduto: i.valor_produto as string,
      valorFrete: i.valor_frete as string,
      valorSeguro: i.valor_seguro as string,
      valorDesconto: i.valor_desconto as string,
      valorOutros: i.valor_outros as string,
      valorIpi: i.valor_ipi as string,
      valorIcmsSt: i.valor_icms_st as string,
      valorFcpSt: i.valor_fcp_st as string,
      rastro: (i.rastro as RastroNfeLido[] | null) ?? [],
      lote: texto(i.lote),
      validade: texto(i.validade),
      fabricacao: texto(i.fabricacao),
      produtoId,
      produto: produtoId ? (produtos.get(produtoId) ?? null) : null,
      codigoBarrasId: texto(i.codigo_barras_id),
      codigoBarras: texto(i.codigo_barras),
      fator,
      quantidadeEstoque,
      fatorConfirmado: produtoId !== null && quantidadeEstoque !== null,
      // Com o preço de venda, o markup gravado revela a base (decisão 161, como no recebimento).
      markupPct: verCusto ? texto(i.markup_pct) : null,
      precoVenda: texto(i.preco_venda),
      atualizarPreco: i.atualizar_preco as AtualizarPrecoRecebimento,
      ignorado: i.ignorado as boolean,
      motivoIgnorado: texto(i.motivo_ignorado),
      fatorTributavel: fatorPelasQuantidadesNfe(
        i.quantidade_comercial as string,
        texto(i.quantidade_tributavel),
      ),
      sugestao,
      vinculoAnterior: s?.vinculoAnterior ?? null,
      // A origem do vínculo gravado: a sugestão de agora quando ele a segue (mesmo produto e fator), senão "manual".
      origemVinculo: !produtoId
        ? null
        : sugestao && sugestao.produtoId === produtoId && dec(sugestao.fator).eq(fator)
          ? sugestao.origem
          : 'manual',
      custoUnitario: texto(i.custo_unitario),
      loteId: texto(i.lote_id),
    };
  });
  return {
    id: n.id as string,
    versao: Number(n.versao_documento),
    criadoEm: iso(n.criado_em)!,
    atualizadoEm: iso(n.atualizado_em)!,
    atualizadoPorNome: texto(n.autor_nome),
    codigo: n.codigo as number,
    chave: n.chave as string,
    modelo: n.modelo as number,
    serie: n.serie as number,
    numero: n.numero as number,
    dataEmissao: iso(n.data_emissao)!,
    dataRecebimento: iso(n.data_recebimento)!,
    dataMovimentacao: iso(n.data_movimentacao),
    naturezaOperacao: texto(n.natureza_operacao),
    emitenteCnpj: n.emitente_cnpj as string,
    emitenteNome: n.emitente_nome as string,
    emitenteFantasia: texto(n.emitente_fantasia),
    emitenteIe: texto(n.emitente_ie),
    emitenteUf: n.emitente_uf as string,
    destinatarioCnpj: n.destinatario_cnpj as string,
    fornecedorId: n.fornecedor_id as string,
    fornecedor: fornecedores.get(n.fornecedor_id as string)!,
    lojaId: n.loja_id as string,
    lojaNome: n.loja_nome as string,
    estoqueId: n.estoque_id as string,
    estoqueNome: n.estoque_nome as string,
    tipoEstoqueId: n.tipo_estoque_id as string,
    tipoEstoqueNome: n.tipo_estoque_nome as string,
    totais: {
      produtos: n.v_produtos as string,
      frete: n.v_frete as string,
      seguro: n.v_seguro as string,
      desconto: n.v_desconto as string,
      outras: n.v_outras as string,
      ipi: n.v_ipi as string,
      ipiDevolvido: n.v_ipi_devolvido as string,
      ii: n.v_ii as string,
      icms: n.v_icms as string,
      icmsDesonerado: n.v_icms_desonerado as string,
      icmsSt: n.v_icms_st as string,
      fcpSt: n.v_fcp_st as string,
      total: n.v_total as string,
    },
    transportadoraCnpj: texto(n.transportadora_cnpj),
    transportadoraNome: texto(n.transportadora_nome),
    modalidadeFrete: texto(n.modalidade_frete),
    volumes: (n.volumes as VolumeNfeLido[] | null) ?? [],
    informacoesComplementares: texto(n.informacoes_complementares),
    protocoloNumero: n.protocolo_numero as string,
    protocoloData: iso(n.protocolo_data)!,
    protocoloStatus: n.protocolo_status as number,
    assinatura,
    assinaturaDetalhe: texto(n.assinatura_detalhe),
    status: n.status as StatusNotaEntrada,
    motivoIgnorada: texto(n.motivo_ignorada),
    criadoPorNome: texto(n.criado_por_nome),
    movimentadaPorNome: texto(n.movimentada_por_nome),
    estornadaEm: iso(n.estornada_em),
    estornadaPorNome: texto(n.estornada_por_nome),
    motivoEstorno: texto(n.motivo_estorno),
    avisos: avisosDaNota(assinatura, texto(n.assinatura_detalhe)),
    vinculacao: {
      ...config,
      resolvidos: itensDetalhe.filter(itemResolvidoNfe).length,
      total: itensDetalhe.length,
    },
    itens: itensDetalhe,
    duplicatas: duplicatas.map((d) => ({
      sequencia: d.sequencia as number,
      numero: texto(d.numero),
      vencimento: texto(d.vencimento),
      valor: d.valor as string,
    })),
  };
}
