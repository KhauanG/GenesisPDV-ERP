import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CHAVE_TOLERANCIA_CONFERENCIA_ITEM,
  CHAVE_TOLERANCIA_CONFERENCIA_TOTAL,
  LIMITE_ARQUIVO_CONTAGEM,
  alterarAcertoSchema,
  criarAcertoSchema,
  efetivarAcertoSchema,
  estornarAcertoSchema,
  filtroAcertosSchema,
  filtroConferenciaSchema,
  filtroFolhaContagemSchema,
  limiteDeslocamento,
  opcoesImportarContagemSchema,
  type AcertoDetalhe,
  type AcertoResumo,
  type ConferenciaAcerto,
  type CriarAcerto,
  type FolhaContagem,
  type Pagina,
  type PreviaContagem,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { uuidv7 } from 'uuidv7';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, erroCampo, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { garantirLimitePorMinuto, limiteDoAmbiente } from '../comum/limites-processo.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { acertosEstoque } from '../database/empresa/schema/index.js';
import { decodificarTexto } from '../importacao/planilha.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import {
  conferenciaAcerto,
  conferirCabecalhoAcerto,
  detalheAcerto,
  efetivarAcerto,
  estornarAcerto,
  exigirAcertoEstornavel,
  exigirTipoEstoqueAtivo,
  gravarItensRascunho,
  lojaDoEstoque,
  resumoEfetivacao,
  resumoEstorno,
} from './acertos.js';
import { folhaContagem, gravarContagem, planejarContagem } from './contagem.js';
import { estoqueVisivel } from './permitidos.js';

const LOCALIZACAO = 'Estoque › Acerto de Estoque';

/** O que o multer entrega (memória; o limite de 5 MB é conferido antes de ler). */
interface ArquivoEnviado {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/** Multipart da importação de contagem: um arquivo e as poucas opções curtas (F2-B9). */
const uploadContagem = FileInterceptor('arquivo', {
  limits: { fileSize: LIMITE_ARQUIVO_CONTAGEM, files: 1, fields: 10, parts: 12, fieldSize: 1024 },
});

/** Importações de contagem por usuário por minuto (cada uma lê o arquivo inteiro e resolve todos os códigos). */
const contagensPorMinuto = () => limiteDoAmbiente('CONTAGEM_IMPORTACOES_POR_MINUTO', 20);
const verCusto = (s: SessaoErp) => s.permissoes.has('produtos.ver_custo');

/** Versão do documento inteiro (cabeçalho + itens, inclusive excluídos; decisão 47). */
const sqlVersao = sql`greatest(a.versao, coalesce((select max(i.versao) from itens_acerto_estoque i where i.acerto_id = a.id), 0))`;

const colunasOrdenacao = {
  codigo: sql`a.codigo`,
  data: sql`a.data_contagem`,
  responsavel: sql`lower(r.nome)`,
  motivo: sql`lower(a.motivo)`,
  estoque: sql`lower(e.nome)`,
  tipo: sql`a.tipo_ajuste`,
  qtd_itens: sql`a.qtd_itens`,
  total_custo: sql`a.total_custo`,
  status: sql`a.status`,
};

interface LinhaAcerto {
  id: string;
  versao: number;
  status: string;
  estoqueId: string;
  tipoEstoqueId: string;
  tipoAjuste: CriarAcerto['tipoAjuste'];
  tipoEstoqueDestinoId: string | null;
  origem: string;
  dataContagem: Date;
  atualizadoPorId: string | null;
  atualizadoEm: Date;
  qtdItens: number;
}

/**
 * Acerto de estoque (ERP 13.5; MD 3.7.5): Entrada / Saída / Definir / Mudança de tipo (F2-B8), rascunho → efetivado →
 * estornado. A efetivação gera um movimento por item (o par `MUDANCA_TIPO_ESTOQUE` na mudança de tipo) com o custo
 * gravado e atualiza `saldos_estoque` na mesma transação.
 */
@Controller('acertos')
export class AcertosController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('estoque_acertos.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<AcertoResumo>> {
    const q = validar(filtroAcertosSchema, query);
    if (q.ordenar?.startsWith('total_custo:') && !verCusto(sessao))
      throw ErroApi.semPermissao('Ordenar por custo exige "Ver custo".');
    const { limite, deslocamento } = limiteDeslocamento(q);
    const condicoes: SQL[] = [sql`a.excluido_em is null`];
    const visivel = estoqueVisivel(sessao, sql`a.estoque_id`);
    if (visivel) condicoes.push(visivel);
    if (q.responsavelId) condicoes.push(sql`a.responsavel_id = ${q.responsavelId}`);
    if (q.estoqueId) condicoes.push(sql`a.estoque_id = ${q.estoqueId}`);
    if (q.tipoAjuste) condicoes.push(sql`a.tipo_ajuste = ${q.tipoAjuste}`);
    if (q.status) condicoes.push(sql`a.status = ${q.status}`);
    // Período pelo dia no fuso da empresa (ERP 1.5).
    if (q.dataInicial)
      condicoes.push(sql`(a.data_contagem at time zone 'America/Sao_Paulo')::date >= ${q.dataInicial}::date`);
    if (q.dataFinal)
      condicoes.push(sql`(a.data_contagem at time zone 'America/Sao_Paulo')::date <= ${q.dataFinal}::date`);
    const onde = sql.join(condicoes, sql` and `);
    const ordem = ordemDaQuery(q, colunasOrdenacao, 'data:desc', sql`a.codigo`);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select a.id, a.codigo, a.data_contagem, a.responsavel_id, r.nome as responsavel_nome, a.motivo, a.estoque_id,
               e.nome as estoque_nome, a.tipo_ajuste, a.origem, a.qtd_itens, a.total_custo::text, a.total_venda::text,
               a.status, ${sqlVersao} as versao
          from acertos_estoque a
          join estoques e on e.id = a.estoque_id
          join usuarios r on r.id = a.responsavel_id
         where ${onde}
         order by ${sql.join(ordem, sql`, `)}
         limit ${limite} offset ${deslocamento}`);
      const { rows: total } = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from acertos_estoque a where ${onde}`);
      return {
        itens: rows.map((r) => ({
          id: r.id as string,
          codigo: r.codigo as number,
          dataContagem: new Date(r.data_contagem as string).toISOString(),
          responsavelId: r.responsavel_id as string,
          responsavelNome: r.responsavel_nome as string,
          motivo: r.motivo as string,
          estoqueId: r.estoque_id as string,
          estoqueNome: r.estoque_nome as string,
          tipoAjuste: r.tipo_ajuste as AcertoResumo['tipoAjuste'],
          origem: r.origem as AcertoResumo['origem'],
          qtdItens: r.qtd_itens as number,
          totalCusto: verCusto(sessao) ? (r.total_custo as string) : null,
          totalVenda: r.total_venda as string,
          status: r.status as AcertoResumo['status'],
          versao: Number(r.versao),
        })),
        total: total[0]?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }

  /**
   * Folha de contagem (F2-B9; ERP 13.5 "Imprimir"), impressa pelo navegador: cega (padrão) ou com o saldo do estoque
   * × tipo. Declarada antes de `:id`, que a capturaria.
   */
  @Permissao('estoque_acertos.ver')
  @Get('folha-contagem')
  folhaContagem(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<FolhaContagem> {
    const filtro = validar(filtroFolhaContagemSchema, query);
    return this.s.tenancy.cx().consulta((db) => folhaContagem(db, filtro, estoqueVisivel(sessao, sql`e.id`)));
  }

  @Permissao('estoque_acertos.ver')
  @Get(':id')
  async obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<AcertoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const d = await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao));
    if (!d) throw ErroApi.naoEncontrado('Acerto não encontrado.');
    return d;
  }

  /**
   * Relatório de conferência do "Definir" (F2-B11; F2-Q6 = D47): contado × saldo do sistema na hora da contagem ×
   * diferença a custo, com o veredito pela tolerância. Os limites vêm de Configurações › Estoque (os da loja do
   * estoque; o CD usa os da empresa), e a consulta pode trocá-los só para ela (`toleranciaTotalPct`,
   * `toleranciaItemPct`). Os valores a custo exigem `produtos.ver_custo`; o percentual e o veredito vêm sempre.
   */
  @Permissao('estoque_acertos.ver')
  @Get(':id/conferencia')
  async conferencia(
    @Param('id') idBruto: string,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<ConferenciaAcerto> {
    const id = validar(z.uuid(), idBruto);
    const filtro = validar(filtroConferenciaSchema, query);
    const r = await this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<{ estoque_id: string }>(
        sql`select estoque_id from acertos_estoque where id = ${id} and excluido_em is null`,
      );
      const lojaId = rows[0] ? await lojaDoEstoque(db, rows[0].estoque_id) : null;
      const totalPct =
        filtro.toleranciaTotalPct ??
        (await lerConfiguracao<string>(db, CHAVE_TOLERANCIA_CONFERENCIA_TOTAL, lojaId));
      const itemPct =
        filtro.toleranciaItemPct ??
        (await lerConfiguracao<string>(db, CHAVE_TOLERANCIA_CONFERENCIA_ITEM, lojaId));
      return conferenciaAcerto(db, id, verCusto(sessao), estoqueVisivel(sessao, sql`a.estoque_id`), {
        totalPct: String(totalPct),
        itemPct: String(itemPct),
      });
    });
    if (!r) throw ErroApi.naoEncontrado('Acerto não encontrado.');
    return r;
  }

  @Permissao('estoque_acertos.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<AcertoDetalhe> {
    const dados = validar(criarAcertoSchema, corpo);
    const id = await this.s.tenancy.cx().transacao(async (tx) => {
      const cab = await conferirCabecalhoAcerto(tx, dados, sessao);
      const id = uuidv7();
      await tx.insert(acertosEstoque).values({
        id,
        estoqueId: dados.estoqueId,
        tipoEstoqueId: cab.tipoEstoqueId,
        tipoAjuste: dados.tipoAjuste,
        tipoEstoqueDestinoId: cab.tipoEstoqueDestinoId,
        dataContagem: new Date(dados.dataContagem),
        motivo: dados.motivo,
        responsavelId: cab.responsavelId,
        observacoes: dados.observacoes,
        origem: 'manual',
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      });
      await gravarItensRascunho(
        tx,
        { id, estoqueId: dados.estoqueId, tipoEstoqueId: cab.tipoEstoqueId, tipoAjuste: dados.tipoAjuste },
        dados.itens,
        { preservarCusto: !verCusto(sessao) },
      );
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'criar',
        entidade: 'acertos_estoque',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: cab.lojaId,
        depois: dados,
      });
      return id;
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  @Permissao('estoque_acertos.criar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<AcertoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarAcertoSchema, corpo);
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, versao);
      exigirRascunho(antes);
      if (antes.tipoAjuste !== dados.tipoAjuste && antes.qtdItens > 0)
        throw erroCampo(
          'tipoAjuste',
          'O tipo de ajuste não muda depois de haver itens gravados',
          'REGRA_NEGOCIO',
        );
      const cab = await conferirCabecalhoAcerto(tx, dados, sessao);
      await tx.execute(sql`
        update acertos_estoque
           set estoque_id = ${dados.estoqueId}, tipo_estoque_id = ${cab.tipoEstoqueId},
               tipo_ajuste = ${dados.tipoAjuste}, tipo_estoque_destino_id = ${cab.tipoEstoqueDestinoId},
               data_contagem = ${dados.dataContagem}::timestamptz,
               motivo = ${dados.motivo}, responsavel_id = ${cab.responsavelId}, observacoes = ${dados.observacoes},
               atualizado_por_id = ${sessao.usuarioId}
         where id = ${id}`);
      await gravarItensRascunho(
        tx,
        { id, estoqueId: dados.estoqueId, tipoEstoqueId: cab.tipoEstoqueId, tipoAjuste: dados.tipoAjuste },
        dados.itens,
        { preservarCusto: !verCusto(sessao) },
      );
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'editar',
        entidade: 'acertos_estoque',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: cab.lojaId,
        antes,
        depois: dados,
      });
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /** Só o rascunho é excluído (logicamente); efetivado só é estornado. */
  @Permissao('estoque_acertos.criar')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') idBruto: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const id = validar(z.uuid(), idBruto);
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao);
      exigirRascunho(antes);
      await tx.execute(
        sql`update itens_acerto_estoque set excluido_em = now() where acerto_id = ${id} and excluido_em is null`,
      );
      await tx.execute(sql`
        update acertos_estoque set excluido_em = now(), atualizado_por_id = ${sessao.usuarioId} where id = ${id}`);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'excluir',
        entidade: 'acertos_estoque',
        registroId: id,
        localizacao: LOCALIZACAO,
        antes,
      });
    });
  }

  /**
   * Importar contagem (F2-B9; ERP 13.5; README da API › decisão 154): multipart com o `arquivo` (`.csv`/`.txt`,
   * `código;quantidade`) e as opções de `opcoesImportarContagemSchema`. Só no "Definir" em rascunho (fora dele, 409).
   * `previa` não grava; `gravar` confere a versão, grava os itens (e os rascunhos da divisão acima de 5.000, e os
   * outros rascunhos da mesma contagem em que um produto do arquivo já estava) e devolve a mesma prévia com os acertos
   * gravados. Sem nada a gravar, 422.
   */
  @Permissao('estoque_acertos.criar')
  @Post(':id/importar-contagem')
  @HttpCode(200)
  @UseInterceptors(uploadContagem)
  async importarContagem(
    @Param('id') idBruto: string,
    @UploadedFile() arquivo: ArquivoEnviado | undefined,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<PreviaContagem> {
    const id = validar(z.uuid(), idBruto);
    garantirLimitePorMinuto(`contagem:${sessao.empresa.empresaId}:${sessao.usuarioId}`, contagensPorMinuto());
    const opcoes = validar(opcoesImportarContagemSchema, corpo ?? {});
    if (!arquivo)
      throw new ErroApi('VALIDACAO', 'Envie o arquivo da contagem.', {
        campos: { arquivo: ['Escolha o arquivo'] },
      });
    // O multer decodifica o nome como Latin-1; o navegador manda UTF-8.
    const nome = Buffer.from(arquivo.originalname, 'latin1').toString('utf8');
    if (!/\.(csv|txt)$/i.test(nome))
      throw new ErroApi('VALIDACAO', 'Envie um arquivo .csv ou .txt (código;quantidade).', {
        campos: { arquivo: ['Formato inválido'] },
      });
    const texto = decodificarTexto(arquivo.buffer);
    return this.s.tenancy.cx().transacao(async (tx) => {
      const a = await this.travar(tx, id, sessao, opcoes.modo === 'gravar' ? opcoes.versao : undefined);
      if (a.status !== 'rascunho')
        throw new ErroApi(
          'CONFLITO',
          'O acerto já foi efetivado ou estornado: a contagem só entra em rascunho.',
        );
      if (a.tipoAjuste !== 'definir')
        throw erroCampo('tipoAjuste', 'A contagem importada é só do "Definir"', 'REGRA_NEGOCIO');
      const alvo = { id, estoqueId: a.estoqueId, tipoEstoqueId: a.tipoEstoqueId };
      const plano = await planejarContagem(tx, alvo, { nome, texto }, opcoes);
      if (opcoes.modo === 'previa') return plano.previa;
      const { acertos, outrosAcertos } = await gravarContagem(tx, alvo, plano, sessao.usuarioId);
      await tx.execute(
        sql`update acertos_estoque set atualizado_por_id = ${sessao.usuarioId} where id = ${id}`,
      );
      const lojaId = await lojaDoEstoque(tx, a.estoqueId);
      const t = plano.previa.totais;
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'importar',
        entidade: 'acertos_estoque',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId,
        descricao:
          `Contagem importada de "${nome}": ${t.produtos} produto(s) (${t.novos} novo(s), ${t.alterados} alterado(s)), ` +
          `${t.zerados} zerado(s), ${t.leiturasRecusadas} leitura(s) recusada(s)` +
          (acertos.length > 1 ? `; dividida nos acertos ${acertos.map((x) => x.codigo).join(', ')}` : '') +
          (outrosAcertos.length
            ? `; alterou os rascunhos da mesma contagem ${outrosAcertos.map((x) => x.codigo).join(', ')}`
            : ''),
      });
      for (const novo of acertos.slice(1))
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'acertos_estoque',
          registroId: novo.id,
          localizacao: LOCALIZACAO,
          lojaId,
          descricao: `Rascunho da divisão da contagem do acerto Nº ${acertos[0]!.codigo} (${novo.qtdItens} itens)`,
        });
      for (const outro of outrosAcertos)
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'acertos_estoque',
          registroId: outro.id,
          localizacao: LOCALIZACAO,
          lojaId,
          descricao: `Contagem importada no acerto Nº ${acertos[0]!.codigo} ("${nome}"): produto(s) que já estavam neste rascunho da mesma contagem (${opcoes.itensExistentes === 'somar' ? 'somados' : 'substituídos'})`,
        });
      return { ...plano.previa, gravado: true, acertos, outrosAcertos };
    });
  }

  @Permissao('estoque_acertos.criar')
  @Post(':id/efetivar')
  @HttpCode(200)
  async efetivar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<AcertoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao } = validar(efetivarAcertoSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const a = await this.travar(tx, id, sessao, versao);
        exigirRascunho(a);
        await exigirTipoEstoqueAtivo(tx, a.tipoEstoqueId, 'efetivar');
        if (a.tipoEstoqueDestinoId)
          await exigirTipoEstoqueAtivo(tx, a.tipoEstoqueDestinoId, 'efetivar', 'tipoEstoqueDestinoId');
        const lojaId = await lojaDoEstoque(tx, a.estoqueId);
        const permiteNegativo =
          sessao.master || (await lerConfiguracao<boolean>(tx, 'estoque.permite_negativo_erp', lojaId));
        const r = await efetivarAcerto(
          tx,
          {
            id,
            estoqueId: a.estoqueId,
            tipoEstoqueId: a.tipoEstoqueId,
            tipoAjuste: a.tipoAjuste,
            tipoEstoqueDestinoId: a.tipoEstoqueDestinoId,
            origem: a.origem as 'manual',
            dataContagem: a.dataContagem,
          },
          { usuarioId: sessao.usuarioId, permiteNegativo },
        );
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'efetivar',
          entidade: 'acertos_estoque',
          registroId: id,
          localizacao: LOCALIZACAO,
          lojaId,
          descricao: `Acerto efetivado: ${resumoEfetivacao(r)}`,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  @Permissao('estoque_acertos.estornar')
  @Post(':id/estornar')
  @HttpCode(200)
  async estornar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<AcertoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, motivo } = validar(estornarAcertoSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const a = await this.travar(tx, id, sessao, versao);
        if (a.status !== 'efetivado')
          throw new ErroApi('REGRA_NEGOCIO', 'Só um acerto efetivado pode ser estornado.');
        exigirAcertoEstornavel(a);
        await exigirTipoEstoqueAtivo(tx, a.tipoEstoqueId, 'estornar');
        if (a.tipoEstoqueDestinoId)
          await exigirTipoEstoqueAtivo(tx, a.tipoEstoqueDestinoId, 'estornar', 'tipoEstoqueDestinoId');
        const lojaId = await lojaDoEstoque(tx, a.estoqueId);
        const permiteNegativo =
          sessao.master || (await lerConfiguracao<boolean>(tx, 'estoque.permite_negativo_erp', lojaId));
        const r = await estornarAcerto(tx, { id }, { usuarioId: sessao.usuarioId, permiteNegativo, motivo });
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'estornar',
          entidade: 'acertos_estoque',
          registroId: id,
          localizacao: LOCALIZACAO,
          lojaId,
          descricao: `Acerto estornado (${resumoEstorno(r)}): ${motivo}`,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  private detalhe(db: DbEmpresa, id: string, sessao: SessaoErp): Promise<AcertoDetalhe | null> {
    return detalheAcerto(db, id, verCusto(sessao), estoqueVisivel(sessao, sql`a.estoque_id`)).then(
      async (d) => {
        if (!d) return d;
        const { rows } = await db.execute<{ v: string }>(sql`
        select ${sqlVersao}::text as v from acertos_estoque a where a.id = ${id}`);
        return { ...d, versao: Number(rows[0]!.v) };
      },
    );
  }

  /**
   * Lê com `for update` (estoque permitido para movimentar: fora dele o acerto é 404, como inexistente) e confere a
   * versão agregada, quando informada. A versão sai de uma segunda instrução, depois da trava: na mesma instrução, a
   * subconsulta dos itens ficaria no instantâneo de antes da espera (READ COMMITTED relê só a linha travada) e a
   * versão velha passaria sem o 409 quando a outra transação só mexeu nos itens (como o recebimento, F2-B14).
   */
  private async travar(tx: DbEmpresa, id: string, sessao: SessaoErp, versao?: number): Promise<LinhaAcerto> {
    const visivel = estoqueVisivel(sessao, sql`a.estoque_id`, 'movimentar');
    const { rows } = await tx.execute<Record<string, unknown>>(sql`
      select a.id, a.status, a.estoque_id, a.tipo_estoque_id, a.tipo_ajuste, a.tipo_estoque_destino_id, a.origem,
             a.data_contagem,
             a.atualizado_por_id, a.atualizado_em, a.qtd_itens
        from acertos_estoque a
       where a.id = ${id} and a.excluido_em is null ${visivel ? sql`and ${visivel}` : sql``}
         for update of a`);
    const r = rows[0];
    if (!r) throw ErroApi.naoEncontrado('Acerto não encontrado.');
    const { rows: v } = await tx.execute<{ versao: string }>(sql`
      select ${sqlVersao}::text as versao from acertos_estoque a where a.id = ${id}`);
    const linha: LinhaAcerto = {
      id: r.id as string,
      versao: Number(v[0]!.versao),
      status: r.status as string,
      estoqueId: r.estoque_id as string,
      tipoEstoqueId: r.tipo_estoque_id as string,
      tipoAjuste: r.tipo_ajuste as LinhaAcerto['tipoAjuste'],
      tipoEstoqueDestinoId: (r.tipo_estoque_destino_id as string | null) ?? null,
      origem: r.origem as string,
      dataContagem: new Date(r.data_contagem as string),
      atualizadoPorId: (r.atualizado_por_id as string | null) ?? null,
      atualizadoEm: new Date(r.atualizado_em as string),
      qtdItens: r.qtd_itens as number,
    };
    if (versao !== undefined && linha.versao !== versao) await conflitoVersao(tx, linha);
    return linha;
  }
}

function exigirRascunho(a: { status: string }): void {
  if (a.status !== 'rascunho')
    throw new ErroApi('REGRA_NEGOCIO', 'Acerto efetivado ou estornado não pode ser alterado (use Estornar).');
}
