import {
  Body,
  type CallHandler,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
  Param,
  Post,
  Put,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  alterarDestinoNotaEntradaSchema,
  consultaDadosCompraSchema,
  type DadosCompraProdutos,
  estornarNotaEntradaSchema,
  filtroNotasEntradaSchema,
  ignorarNotaEntradaSchema,
  limiteDeslocamento,
  LIMITES_UPLOAD_NFE,
  MENSAGEM_ENVIO_GRANDE_NFE,
  movimentarNotaEntradaSchema,
  opcoesImportacaoNfeSchema,
  reabrirNotaEntradaSchema,
  type NotaEntradaDetalhe,
  type NotaEntradaResumo,
  type Pagina,
  type ResultadoImportacaoNfe,
  type SituacaoAssinaturaNfe,
  type StatusNotaEntrada,
  TETO_UPLOAD_NFE_TEXTO,
  vincularItensNfeSchema,
  type XmlNotaEntrada,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { catchError, defer, finalize, mergeMap, throwError } from 'rxjs';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { conflitoVersao, erroCampo, escaparLike, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { garantirLimitePorMinuto, limiteDoAmbiente, Semaforo } from '../comum/limites-processo.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { lojaDoEstoque, resolverTipoEstoque } from '../estoques/acertos.js';
import { estoquePermitido, estoqueVisivel } from '../estoques/permitidos.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { textoSaldosNegativos } from './entrada.js';
import {
  auditarVinculosMovidosNfe,
  estornarNotaEntrada,
  lerNotaAMovimentar,
  movimentarNotaEntrada,
} from './movimentar-nfe.js';
import {
  conferirTamanhoEnvioNfe,
  detalheNotaEntrada,
  LOCALIZACAO_NOTAS_ENTRADA,
  sqlVersaoNotaEntrada,
} from './notas-entrada.js';
import { dadosCompraProdutos, resumoMovimentacao } from './recebimentos.js';
import { recalcularStatusNotaEntrada, vincularItensNotaEntrada } from './vinculacao.js';

/** O que o multer entrega (memória; o tamanho de cada arquivo e o do pedido são conferidos antes de ler). */
interface ArquivoEnviado {
  originalname: string;
  buffer: Buffer;
}

/** Envios por usuário por minuto (cada um lê até 20 MB e grava cada XML no armazenamento). */
const enviosPorMinuto = () => limiteDoAmbiente('NFE_IMPORTACOES_POR_MINUTO', 20);
/** Envios ao mesmo tempo de um usuário (`NFE_ENVIOS_SIMULTANEOS_USUARIO`): o segundo recebe 429 na hora. */
const enviosSimultaneosPorUsuario = () => limiteDoAmbiente('NFE_ENVIOS_SIMULTANEOS_USUARIO', 1);
/**
 * Envios ao mesmo tempo no processo (`NFE_ENVIOS_SIMULTANEOS`, padrão 3): cada um tem até 20 MB lidos e até 100 MiB
 * descompactados dos `.zip` em memória; o seguinte espera a vaga **antes** de o multer ler o corpo.
 */
const semaforoEnvios = new Semaforo(limiteDoAmbiente('NFE_ENVIOS_SIMULTANEOS', 3));
const enviosEmAndamento = new Map<string, number>();

const erroEnvio = (mensagem: string, campo: string) =>
  new ErroApi('VALIDACAO', mensagem, { campos: { arquivos: [campo] } });

/**
 * O que protege a memória do processo de todas as empresas, **antes** do multer ler as partes do pedido (o multer
 * só limita cada arquivo: 100 arquivos de 20 MB seriam 2 GB): o teto do pedido inteiro pelo `Content-Length` (sem
 * ele, envio em pedaços, que o navegador não usa para `FormData`, o pedido é recusado), o limite de envios por
 * minuto do usuário, um envio por vez de cada usuário e a vaga do semáforo do processo, liberada quando a resposta
 * termina (com erro ou não). Os erros do multer (arquivos demais, arquivo grande demais) voltam como 422 no campo
 * `arquivos`, com a mensagem da tela.
 */
@Injectable()
class LimiteEnvioNfe implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<RequisicaoGenesis>();
    const tamanho = Number(req.headers['content-length']);
    // Folga para os cabeçalhos das partes do multipart e os campos das opções.
    if (!Number.isFinite(tamanho) || tamanho > LIMITES_UPLOAD_NFE.bytes + 256 * 1024)
      throw erroEnvio(MENSAGEM_ENVIO_GRANDE_NFE, `Até ${TETO_UPLOAD_NFE_TEXTO} por envio`);
    const sessao = req.sessao;
    if (!sessao) throw ErroApi.naoAutenticado();
    const chave = `nfe:${sessao.empresa.empresaId}:${sessao.usuarioId}`;
    garantirLimitePorMinuto(chave, enviosPorMinuto());
    const emAndamento = enviosEmAndamento.get(chave) ?? 0;
    if (emAndamento >= enviosSimultaneosPorUsuario())
      throw new ErroApi(
        'LIMITE_TAXA',
        'Já há um envio de NF-e seu em andamento. Aguarde ele terminar e envie de novo.',
        { cabecalhos: { 'Retry-After': '5' } },
      );
    enviosEmAndamento.set(chave, emAndamento + 1);
    let liberar: (() => void) | undefined;
    return defer(async () => {
      liberar = await semaforoEnvios.adquirir();
    }).pipe(
      mergeMap(() => next.handle()),
      catchError((e: unknown) => throwError(() => erroDoMulter(e))),
      finalize(() => {
        liberar?.();
        const n = (enviosEmAndamento.get(chave) ?? 1) - 1;
        if (n > 0) enviosEmAndamento.set(chave, n);
        else enviosEmAndamento.delete(chave);
      }),
    );
  }
}

/** O erro do multer (o `FilesInterceptor` o devolve como 400/413 com a mensagem em inglês) na mensagem da tela. */
function erroDoMulter(e: unknown): unknown {
  if (!(e instanceof HttpException)) return e;
  if (e.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE)
    return erroEnvio(MENSAGEM_ENVIO_GRANDE_NFE, `Até ${TETO_UPLOAD_NFE_TEXTO} por envio`);
  if (e.getStatus() === HttpStatus.BAD_REQUEST && /too many (files|parts)|unexpected field/i.test(e.message))
    return erroEnvio(
      `No máximo ${LIMITES_UPLOAD_NFE.arquivos} arquivos por envio: junte as notas num .zip.`,
      `Até ${LIMITES_UPLOAD_NFE.arquivos} arquivos por envio`,
    );
  return e;
}

const upload = FilesInterceptor('arquivos', LIMITES_UPLOAD_NFE.arquivos, {
  limits: {
    fileSize: LIMITES_UPLOAD_NFE.bytes,
    files: LIMITES_UPLOAD_NFE.arquivos,
    fields: 10,
    parts: LIMITES_UPLOAD_NFE.arquivos + 10,
    fieldSize: 1024,
  },
});

const colunasOrdenacao = {
  codigo: sql`n.codigo`,
  emissao: sql`n.data_emissao`,
  recebimento: sql`n.data_recebimento`,
  movimentacao: sql`n.data_movimentacao`,
  emitente: sql`lower(n.emitente_nome)`,
  numero: sql`n.numero`,
  loja: sql`lower(l.nome)`,
  total: sql`n.valor_total`,
  status: sql`n.status`,
};

interface LinhaNota {
  id: string;
  versao: number;
  codigo: number;
  numero: number;
  status: StatusNotaEntrada;
  lojaId: string;
  estoqueId: string;
  tipoEstoqueId: string;
  motivoIgnorada: string | null;
  atualizadoPorId: string | null;
  atualizadoEm: Date;
}

/**
 * NF-e de fornecedor por XML (ERP 13.4; MD 3.8.2; Fase 2, F2-B19; README da API › decisão 164): o upload (`.xml` e
 * `.zip`, resultado por arquivo, o lote grande em tarefa), a listagem com os filtros da ERP 13.4, o detalhe, o XML
 * enviado e as ações "Ignorar nota", "Reabrir" e a troca do destino (loja, estoque e tipo). Como o recebimento, só se
 * vê a nota de estoque permitido (fora dele é 404) e as ações exigem também a loja gravada entre as permitidas.
 * Importar e as ações usam `notas_entrada.importar` (o catálogo não tem "editar" para a nota). Desde o F2-B20, a
 * vinculação dos itens (`PUT :id/itens`) e os dados de compra dos produtos da aba de itens. Desde o F2-B21 (README
 * da API › decisão 169), movimentar (`notas_entrada.movimentar`) e estornar (`notas_entrada.estornar`), com
 * `travaVersao`: o movimento, o saldo, o lote e os preços descem ao PDV.
 */
@Controller('notas-entrada')
export class NotasEntradaController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('notas_entrada.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<NotaEntradaResumo>> {
    const q = validar(filtroNotasEntradaSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const condicoes: SQL[] = [sql`n.excluido_em is null`];
    const visivel = estoqueVisivel(sessao, sql`n.estoque_id`);
    if (visivel) condicoes.push(visivel);
    if (q.fornecedorId) condicoes.push(sql`n.fornecedor_id = ${q.fornecedorId}`);
    if (q.nome) {
      const termo = `%${escaparLike(q.nome)}%`;
      condicoes.push(sql`(n.emitente_nome ilike ${termo} or n.emitente_fantasia ilike ${termo})`);
    }
    if (q.lojaId) condicoes.push(sql`n.loja_id = ${q.lojaId}`);
    if (q.estoqueId) condicoes.push(sql`n.estoque_id = ${q.estoqueId}`);
    // O dia da emissão e o da importação no fuso da loja destinatária (ERP 1.5).
    const dia =
      q.periodo === 'recebimento'
        ? sql`(n.data_recebimento at time zone l.fuso_horario)::date`
        : sql`(n.data_emissao at time zone l.fuso_horario)::date`;
    if (q.dataInicial) condicoes.push(sql`${dia} >= ${q.dataInicial}::date`);
    if (q.dataFinal) condicoes.push(sql`${dia} <= ${q.dataFinal}::date`);
    if (q.status) condicoes.push(sql`n.status = ${q.status}`);
    if (q.numeroChave) {
      const prefixo = `${escaparLike(q.numeroChave)}%`;
      condicoes.push(
        /^\d{1,9}$/.test(q.numeroChave)
          ? sql`(n.numero = ${Number(q.numeroChave)} or n.chave like ${prefixo})`
          : sql`n.chave like ${prefixo}`,
      );
    }
    const onde = sql.join(condicoes, sql` and `);
    const ordem = ordemDaQuery(q, colunasOrdenacao, 'recebimento:desc', sql`n.codigo`);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select n.id, n.codigo, n.chave, n.numero, n.serie, n.emitente_nome, n.emitente_fantasia, n.fornecedor_id,
               n.loja_id, l.nome as loja_nome, n.estoque_id, e.nome as estoque_nome, n.data_emissao,
               n.data_recebimento, n.data_movimentacao, n.valor_total::text, n.status, n.assinatura,
               (select count(*)::int from itens_nota_entrada i
                 where i.nota_entrada_id = n.id and i.excluido_em is null) as qtd_itens,
               ${sqlVersaoNotaEntrada} as versao
          from notas_entrada n
          join lojas l on l.id = n.loja_id
          join estoques e on e.id = n.estoque_id
         where ${onde}
         order by ${sql.join(ordem, sql`, `)}
         limit ${limite} offset ${deslocamento}`);
      const { rows: total } = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from notas_entrada n join lojas l on l.id = n.loja_id where ${onde}`);
      const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
      return {
        itens: rows.map((r) => ({
          id: r.id as string,
          codigo: r.codigo as number,
          chave: r.chave as string,
          numero: r.numero as number,
          serie: r.serie as number,
          emitenteNome: r.emitente_nome as string,
          emitenteFantasia: (r.emitente_fantasia as string | null) ?? null,
          fornecedorId: r.fornecedor_id as string,
          lojaId: r.loja_id as string,
          lojaNome: r.loja_nome as string,
          estoqueId: r.estoque_id as string,
          estoqueNome: r.estoque_nome as string,
          dataEmissao: iso(r.data_emissao)!,
          dataRecebimento: iso(r.data_recebimento)!,
          dataMovimentacao: iso(r.data_movimentacao),
          valorTotal: r.valor_total as string,
          status: r.status as StatusNotaEntrada,
          assinatura: r.assinatura as SituacaoAssinaturaNfe,
          qtdItens: r.qtd_itens as number,
          versao: Number(r.versao),
        })),
        total: total[0]?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }

  /**
   * Upload por arquivo (ERP 13.4 "Por Arquivo"): multipart com `arquivos` (um ou vários `.xml`/`.zip`, até 20 MB no
   * pedido) e as opções `estoqueId`/`tipoEstoqueId`. Sempre 200: com o resultado de cada arquivo (importada,
   * duplicada ou recusada, com o motivo) ou, quando o lote vai para a tarefa, só com o `tarefaId`.
   */
  @Permissao('notas_entrada.importar')
  @Post('importar')
  @HttpCode(200)
  @UseInterceptors(LimiteEnvioNfe, upload)
  async importar(
    @UploadedFiles() arquivos: ArquivoEnviado[] | undefined,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoImportacaoNfe> {
    const opcoes = validar(opcoesImportacaoNfeSchema, corpo ?? {});
    // O multer decodifica o nome como Latin-1; o navegador manda UTF-8.
    const enviados = (arquivos ?? []).map((a) => ({
      nome: Buffer.from(a.originalname, 'latin1').toString('utf8'),
      conteudo: a.buffer,
    }));
    conferirTamanhoEnvioNfe(enviados);
    return this.s.notasEntrada.importar(sessao, origemDaRequisicao(req), enviados, opcoes);
  }

  /**
   * Os dados de compra dos produtos da aba "Itens e vinculação" (F2-B20): as embalagens, o lote, o saldo e o custo
   * médio no destino da nota e o preço da loja (a base do markup ⇄ preço), os mesmos do recebimento manual
   * (`dadosCompraProdutos`), com a permissão de ver a nota.
   */
  @Permissao('notas_entrada.ver')
  @Get('dados-produtos')
  async dadosProdutos(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<DadosCompraProdutos> {
    const q = validar(consultaDadosCompraSchema, query);
    return this.s.tenancy.cx().consulta((db) => dadosCompraProdutos(db, q, sessao));
  }

  @Permissao('notas_entrada.ver')
  @Get(':id')
  async obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<NotaEntradaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const d = await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao));
    if (!d) throw ErroApi.naoEncontrado('Nota não encontrada.');
    return d;
  }

  /** O XML como foi enviado (a aba XML formata e baixa); o objeto é o do armazenamento, endereçado pelo conteúdo. */
  @Permissao('notas_entrada.ver')
  @Get(':id/xml')
  async xml(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<XmlNotaEntrada> {
    const id = validar(z.uuid(), idBruto);
    const visivel = estoqueVisivel(sessao, sql`n.estoque_id`);
    const { rows } = await this.s.tenancy.cx().consulta((db) =>
      db.execute<{ chave: string; chave_armazenamento: string }>(sql`
        select n.chave, a.chave_armazenamento
          from notas_entrada n join arquivos a on a.id = n.xml_arquivo_id
         where n.id = ${id} and n.excluido_em is null ${visivel ? sql`and ${visivel}` : sql``}`),
    );
    if (!rows[0]) throw ErroApi.naoEncontrado('Nota não encontrada.');
    const conteudo = await this.s.armazenamento.ler(rows[0].chave_armazenamento);
    return { nomeArquivo: `${rows[0].chave}-nfe.xml`, xml: conteudo.toString('utf8') };
  }

  /** "Ignorar nota" (ERP 13.4): a pendente ou a pronta, com motivo; a chave continua ocupada ("Reabrir" a devolve). */
  @Permissao('notas_entrada.importar')
  @Post(':id/ignorar')
  @HttpCode(200)
  async ignorar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<NotaEntradaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, motivo } = validar(ignorarNotaEntradaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, versao);
      exigirLojaGravada(sessao, antes);
      if (antes.status !== 'pendente' && antes.status !== 'pronta')
        throw new ErroApi(
          'REGRA_NEGOCIO',
          antes.status === 'ignorada'
            ? 'A nota já está ignorada.'
            : 'Nota movimentada ou estornada não é ignorada.',
        );
      await tx.execute(sql`
        update notas_entrada set status = 'ignorada', motivo_ignorada = ${motivo}, atualizado_por_id = ${sessao.usuarioId}
         where id = ${id}`);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'editar',
        entidade: 'notas_entrada',
        registroId: id,
        localizacao: LOCALIZACAO_NOTAS_ENTRADA,
        lojaId: antes.lojaId,
        descricao: `NF-e Nº ${antes.numero} ignorada: ${motivo}`,
        antes: { status: antes.status },
        depois: { status: 'ignorada', motivoIgnorada: motivo },
      });
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /** "Reabrir" (ERP 13.4): a ignorada volta a pendente, ou a pronta se todos os itens já estão resolvidos (F2-B20). */
  @Permissao('notas_entrada.importar')
  @Post(':id/reabrir')
  @HttpCode(200)
  async reabrir(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<NotaEntradaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao } = validar(reabrirNotaEntradaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, versao);
      exigirLojaGravada(sessao, antes);
      if (antes.status !== 'ignorada') throw new ErroApi('REGRA_NEGOCIO', 'Só a nota ignorada é reaberta.');
      await tx.execute(sql`
        update notas_entrada set status = 'pendente', motivo_ignorada = null, atualizado_por_id = ${sessao.usuarioId}
         where id = ${id}`);
      // Com todos os itens já resolvidos, a reaberta volta direto a "pronta" (F2-B20).
      const status = await recalcularStatusNotaEntrada(tx, id, sessao.usuarioId);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'editar',
        entidade: 'notas_entrada',
        registroId: id,
        localizacao: LOCALIZACAO_NOTAS_ENTRADA,
        lojaId: antes.lojaId,
        descricao: `NF-e Nº ${antes.numero} reaberta`,
        antes: { status: 'ignorada', motivoIgnorada: antes.motivoIgnorada },
        depois: { status },
      });
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Troca do destino na aba Dados (F2-Q3 = D6): a loja entre as permitidas e ativa (403/422 no campo, como o
   * recebimento), o estoque (vazio = o da loja) entre os permitidos para movimentar e ativo, e o tipo ativo (vazio = o
   * padrão), com a nota pendente ou pronta. A loja não precisa ser a do CNPJ do destinatário (a nota do CD que vai
   * direto para uma loja, ou o contrário), e o CNPJ do destinatário gravado não muda.
   */
  @Permissao('notas_entrada.importar')
  @Put(':id/destino')
  async alterarDestino(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<NotaEntradaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const dados = validar(alterarDestinoNotaEntradaSchema, corpo);
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, dados.versao);
      exigirLojaGravada(sessao, antes);
      if (antes.status !== 'pendente' && antes.status !== 'pronta')
        throw new ErroApi(
          'REGRA_NEGOCIO',
          'Só a nota pendente ou pronta muda de destino (a ignorada é reaberta antes).',
        );
      const { rows: lj } = await tx.execute<{ id: string; ativa: boolean; estoque_id: string }>(sql`
        select id, ativa, estoque_id from lojas where id = ${dados.lojaId} and excluido_em is null`);
      if (!lj[0]) throw erroCampo('lojaId', 'Loja não encontrada');
      if (!lojaPermitida(sessao, lj[0].id))
        throw new ErroApi('SEM_PERMISSAO', 'Você não tem acesso a esta loja.', {
          campos: { lojaId: ['Fora das suas lojas permitidas'] },
        });
      if (!lj[0].ativa) throw erroCampo('lojaId', 'Loja inativa');
      const estoqueId = (dados.estoqueId ?? lj[0].estoque_id).toLowerCase();
      const { rows: est } = await tx.execute<{ ativo: boolean }>(sql`
        select ativo from estoques where id = ${estoqueId} and excluido_em is null`);
      if (!est[0]) throw erroCampo('estoqueId', 'Estoque não encontrado');
      if (!estoquePermitido(sessao, estoqueId, 'movimentar'))
        throw new ErroApi('SEM_PERMISSAO', 'O estoque está fora dos seus estoques permitidos.', {
          campos: { estoqueId: ['Fora dos seus estoques permitidos'] },
        });
      if (!est[0].ativo) throw erroCampo('estoqueId', 'Estoque inativo');
      const tipoEstoqueId = await resolverTipoEstoque(tx, dados.tipoEstoqueId);
      await tx.execute(sql`
        update notas_entrada
           set loja_id = ${lj[0].id}, estoque_id = ${estoqueId}, tipo_estoque_id = ${tipoEstoqueId},
               atualizado_por_id = ${sessao.usuarioId}
         where id = ${id}`);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'editar',
        entidade: 'notas_entrada',
        registroId: id,
        localizacao: LOCALIZACAO_NOTAS_ENTRADA,
        lojaId: lj[0].id,
        descricao: `Destino da NF-e Nº ${antes.numero} alterado`,
        antes: { lojaId: antes.lojaId, estoqueId: antes.estoqueId, tipoEstoqueId: antes.tipoEstoqueId },
        depois: { lojaId: lj[0].id, estoqueId, tipoEstoqueId },
      });
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Vinculação dos itens (ERP 13.4.1; F2-B20; README da API › decisão 167): o produto, a embalagem e o fator (com a
   * confirmação), o lote do rastro, o preço proposto e "Ignorar item" com motivo, dos itens enviados, com a nota
   * pendente ou pronta e a loja gravada entre as permitidas. A nota fica "pronta" quando todos os itens estão
   * vinculados com o fator confirmado ou ignorados, e volta a "pendente" quando algum deixa de estar.
   */
  @Permissao('notas_entrada.importar')
  @Put(':id/itens')
  async vincularItens(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<NotaEntradaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const dados = validar(vincularItensNfeSchema, corpo);
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, dados.versao);
      exigirLojaGravada(sessao, antes);
      if (antes.status !== 'pendente' && antes.status !== 'pronta')
        throw new ErroApi(
          'REGRA_NEGOCIO',
          antes.status === 'ignorada'
            ? 'A nota está ignorada: reabra a nota antes de vincular os itens.'
            : 'Nota movimentada ou estornada não muda a vinculação dos itens.',
        );
      const r = await vincularItensNotaEntrada(tx, antes, sessao.usuarioId, dados);
      if (!r.alterados) return;
      await tx.execute(sql`
        update notas_entrada set atualizado_por_id = ${sessao.usuarioId} where id = ${id}`);
      const situacao =
        r.status !== r.statusAntes
          ? `; a nota ficou ${r.status === 'pronta' ? '"pronta"' : '"pendente"'}`
          : '';
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'editar',
        entidade: 'notas_entrada',
        registroId: id,
        localizacao: LOCALIZACAO_NOTAS_ENTRADA,
        lojaId: antes.lojaId,
        descricao: `Vinculação dos itens da NF-e Nº ${antes.numero}: ${r.alterados} item(ns) alterado(s)${situacao}`,
        antes: { status: r.statusAntes, itens: r.antes },
        depois: { status: r.status, itens: r.depois },
      });
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Movimentar (ERP 13.4; F2-B21): a nota "pronta" entra no estoque de destino (`RECEB_NFE` de cada item vinculado,
   * pelo núcleo de entrada) e o vínculo fornecedor + cProd é aprendido. **Idempotente** como o recebimento: a nota já
   * movimentada devolve o detalhe sem lançar nada nem conferir a versão. A pendente, a ignorada e a estornada são 422.
   * A pergunta do preço de custo (D49) volta como 422 em `atualizarPrecoCusto`.
   */
  @Permissao('notas_entrada.movimentar')
  @Post(':id/movimentar')
  @HttpCode(200)
  async movimentar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<NotaEntradaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, atualizarPrecoCusto } = validar(movimentarNotaEntradaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, id, sessao);
        exigirLojaGravada(sessao, antes);
        if (antes.status === 'movimentada') return;
        if (antes.status !== 'pronta')
          throw new ErroApi(
            'REGRA_NEGOCIO',
            antes.status === 'estornada'
              ? 'NF-e estornada não pode ser movimentada de novo.'
              : antes.status === 'ignorada'
                ? 'A nota está ignorada: reabra a nota antes de movimentar.'
                : 'A nota ainda não está pronta: vincule (com o fator confirmado) ou ignore todos os itens antes de movimentar.',
          );
        if (versao !== undefined && antes.versao !== versao) await conflitoVersao(tx, antes);
        const n = await lerNotaAMovimentar(tx, id);
        const resultado = await movimentarNotaEntrada(tx, n, sessao, { atualizarPrecoCusto });
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'movimentar',
          entidade: 'notas_entrada',
          registroId: id,
          localizacao: LOCALIZACAO_NOTAS_ENTRADA,
          lojaId: n.lojaId,
          descricao: `NF-e Nº ${n.numero} movimentada: ${resumoMovimentacao(resultado)}`,
        });
        // O produto de onde a nota tirou um vínculo fornecedor + código (F2-B21, como o "mover vínculo" do cadastro).
        await auditarVinculosMovidosNfe(
          this.s.auditoria,
          tx,
          origemDaRequisicao(req),
          n,
          LOCALIZACAO_NOTAS_ENTRADA,
          resultado.vinculosMovidos,
        );
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Estorno com motivo (ERP 13.4; F2-B21): `ESTORNO_RECEB_NFE` de cada item, com a regra do recebimento para o saldo
   * negativo (D56 com aviso: bloqueado salvo Master ou `estoque.permite_negativo_erp` da loja do estoque; com a
   * permissão, 422 em `confirmarNegativo` com a lista e o confirmado na auditoria). Não desfaz preço, preço de custo
   * nem o vínculo aprendido.
   */
  @Permissao('notas_entrada.estornar')
  @Post(':id/estornar')
  @HttpCode(200)
  async estornar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<NotaEntradaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, motivo, confirmarNegativo } = validar(estornarNotaEntradaSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, id, sessao, versao);
        exigirLojaGravada(sessao, antes);
        if (antes.status !== 'movimentada')
          throw new ErroApi(
            'REGRA_NEGOCIO',
            antes.status === 'estornada'
              ? 'A NF-e já foi estornada.'
              : 'Só a nota movimentada pode ser estornada (a pendente ou pronta se ignora).',
          );
        const n = await lerNotaAMovimentar(tx, id);
        const lojaEstoque = await lojaDoEstoque(tx, n.estoqueId);
        const permiteNegativo =
          sessao.master || (await lerConfiguracao<boolean>(tx, 'estoque.permite_negativo_erp', lojaEstoque));
        const resultado = await estornarNotaEntrada(tx, n, {
          usuarioId: sessao.usuarioId,
          permiteNegativo,
          confirmarNegativo,
          motivo,
        });
        // O negativo confirmado fica registrado (D56 com aviso): quem, os saldos e que foi confirmado.
        const negativo = resultado.saldosNegativos.length
          ? `; saldo negativo confirmado em: ${textoSaldosNegativos(resultado.saldosNegativos)}`
          : '';
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'estornar',
          entidade: 'notas_entrada',
          registroId: id,
          localizacao: LOCALIZACAO_NOTAS_ENTRADA,
          lojaId: n.lojaId,
          descricao: `NF-e Nº ${n.numero} estornada (${resultado.estornos} movimento(s)): ${motivo}${negativo}`,
          ...(resultado.saldosNegativos.length
            ? { depois: { saldoNegativoConfirmado: true, saldosNegativos: resultado.saldosNegativos } }
            : {}),
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  private detalhe(db: DbEmpresa, id: string, sessao: SessaoErp): Promise<NotaEntradaDetalhe | null> {
    return detalheNotaEntrada(db, id, sessao, estoqueVisivel(sessao, sql`n.estoque_id`));
  }

  /**
   * Lê com `for update` (estoque permitido para movimentar: fora dele a nota é 404) e confere a versão do documento,
   * lida numa segunda instrução depois da trava (o mesmo cuidado do recebimento com o READ COMMITTED).
   */
  private async travar(tx: DbEmpresa, id: string, sessao: SessaoErp, versao?: number): Promise<LinhaNota> {
    const visivel = estoqueVisivel(sessao, sql`n.estoque_id`, 'movimentar');
    const { rows } = await tx.execute<Record<string, unknown>>(sql`
      select n.id, n.codigo, n.numero, n.status, n.loja_id, n.estoque_id, n.tipo_estoque_id, n.motivo_ignorada,
             n.atualizado_por_id, n.atualizado_em
        from notas_entrada n
       where n.id = ${id} and n.excluido_em is null ${visivel ? sql`and ${visivel}` : sql``}
         for update of n`);
    const r = rows[0];
    if (!r) throw ErroApi.naoEncontrado('Nota não encontrada.');
    const { rows: v } = await tx.execute<{ versao: string }>(sql`
      select ${sqlVersaoNotaEntrada}::text as versao from notas_entrada n where n.id = ${id}`);
    const linha: LinhaNota = {
      id: r.id as string,
      versao: Number(v[0]!.versao),
      codigo: r.codigo as number,
      numero: r.numero as number,
      status: r.status as StatusNotaEntrada,
      lojaId: r.loja_id as string,
      estoqueId: r.estoque_id as string,
      tipoEstoqueId: r.tipo_estoque_id as string,
      motivoIgnorada: (r.motivo_ignorada as string | null) ?? null,
      atualizadoPorId: (r.atualizado_por_id as string | null) ?? null,
      atualizadoEm: new Date(r.atualizado_em as string),
    };
    if (versao !== undefined && linha.versao !== versao) await conflitoVersao(tx, linha);
    return linha;
  }
}

/** A loja **gravada** entre as permitidas (como o recebimento): ver é pelo estoque (D45), mexer na nota é da loja. */
function exigirLojaGravada(sessao: SessaoErp, n: { lojaId: string }): void {
  if (!lojaPermitida(sessao, n.lojaId))
    throw new ErroApi(
      'SEM_PERMISSAO',
      'A nota é de uma loja fora das suas lojas permitidas: só quem tem a loja altera a nota.',
    );
}
