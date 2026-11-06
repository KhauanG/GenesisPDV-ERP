import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarMarcaSchema,
  criarMarcaSchema,
  filtroMarcasSchema,
  limiteDeslocamento,
  mesclarMarcasSchema,
  type MarcaDetalhe,
  type MarcaResumo,
  type Pagina,
} from '@genesis/shared';
import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import {
  conflitoVersao,
  contem,
  garantirSemConflito,
  metadados,
  ordemDaQuery,
  ref,
} from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { marcas, produtos, usuarios } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const LOCALIZACAO = 'Produtos › Marcas';

const sqlProdutos = sql<number>`(select count(*)::int from produtos p where p.marca_id = ${ref('marcas')} and p.excluido_em is null)`;

const colunasOrdenacao = {
  codigo: marcas.codigo,
  descricao: sql`lower(fn_unaccent(${marcas.descricao}))`,
  ordem: marcas.ordem,
  produtos: sqlProdutos,
};

/** Marcas (ERP 8.7): descrição única sem diferenciar maiúsculas/acentos, "SEM MARCA" única, Mesclar. */
@Controller('marcas')
export class MarcasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('marcas.ver')
  @Get()
  async listar(@Query() query: unknown): Promise<Pagina<MarcaResumo>> {
    const q = validar(filtroMarcasSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const busca = contem(q.descricao);
    const onde = and(
      isNull(marcas.excluidoEm),
      busca ? sql`fn_unaccent(${marcas.descricao}) ilike fn_unaccent(${busca})` : undefined,
    );
    return this.s.tenancy.cx().consulta(async (db) => {
      const itens = await db
        .select({
          id: marcas.id,
          codigo: marcas.codigo,
          descricao: marcas.descricao,
          semMarca: marcas.semMarca,
          exibeSite: marcas.exibeSite,
          ordem: marcas.ordem,
          produtos: sqlProdutos,
          versao: marcas.versao,
        })
        .from(marcas)
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'descricao:asc', marcas.codigo))
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(marcas).where(onde);
      return { itens, total: total?.n ?? 0, pagina: q.pagina, tamanho: q.tamanho };
    });
  }

  @Permissao('marcas.ver')
  @Get(':id')
  async obter(@Param('id') id: string): Promise<MarcaDetalhe> {
    const marcaId = validar(z.uuid(), id);
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db, marcaId));
    if (!d) throw ErroApi.naoEncontrado('Marca não encontrada.');
    return d;
  }

  @Permissao('marcas.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<MarcaDetalhe> {
    const dados = validar(criarMarcaSchema, corpo);
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        await garantirUnicos(tx, dados);
        const [m] = await tx
          .insert(marcas)
          .values({ ...dados, criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId })
          .returning();
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'marcas',
          registroId: m!.id,
          localizacao: LOCALIZACAO,
          depois: m,
        });
        return m!.id;
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!;
  }

  @Permissao('marcas.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<MarcaDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarMarcaSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, id);
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        await garantirUnicos(tx, dados, id);
        const [depois] = await tx
          .update(marcas)
          .set({ ...dados, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(marcas.id, id), eq(marcas.versao, versao)))
          .returning();
        if (!depois) await conflitoVersao(tx, antes);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'marcas',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
          depois,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!;
  }

  /** ERP 8.7: bloqueada se houver produtos ativos da marca (use Mesclar). */
  @Permissao('marcas.excluir')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') idBruto: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const id = validar(z.uuid(), idBruto);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, id);
        const [n] = await tx
          .select({ n: count() })
          .from(produtos)
          .where(and(eq(produtos.marcaId, id), eq(produtos.ativo, true), isNull(produtos.excluidoEm)));
        if ((n?.n ?? 0) > 0) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            `A marca tem ${n!.n} produto(s) ativo(s). Use "Mesclar marcas" ou troque a marca deles.`,
          );
        }
        await tx
          .update(marcas)
          .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
          .where(eq(marcas.id, id));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'marcas',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }

  /** Mesclar marcas (ERP 8.7): move os produtos das origens para o destino e exclui as origens. */
  @Permissao('marcas.editar', 'marcas.excluir')
  @Post('mesclar')
  @HttpCode(200)
  async mesclar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<MarcaDetalhe> {
    const { destinoId, origens } = validar(mesclarMarcasSchema, corpo);
    const unicas = [...new Set(origens)];
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        await travar(tx, destinoId);
        const linhas = await tx
          .select()
          .from(marcas)
          .where(and(inArray(marcas.id, unicas), isNull(marcas.excluidoEm)))
          .for('update');
        if (linhas.length !== unicas.length) throw ErroApi.naoEncontrado('Marca de origem não encontrada.');
        const movidos = await tx
          .update(produtos)
          .set({ marcaId: destinoId, atualizadoPorId: sessao.usuarioId })
          .where(and(inArray(produtos.marcaId, unicas), isNull(produtos.excluidoEm)))
          .returning({ id: produtos.id });
        await tx
          .update(marcas)
          .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
          .where(inArray(marcas.id, unicas));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'marcas',
          registroId: destinoId,
          localizacao: LOCALIZACAO,
          descricao: `Mescladas ${linhas.length} marca(s); ${movidos.length} produto(s) movido(s)`,
          antes: { origens: linhas.map((l) => ({ id: l.id, descricao: l.descricao })) },
          depois: { destinoId, produtos: movidos.length },
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, destinoId)))!;
  }
}

async function travar(tx: DbEmpresa, id: string) {
  const [m] = await tx
    .select()
    .from(marcas)
    .where(and(eq(marcas.id, id), isNull(marcas.excluidoEm)))
    .for('update');
  if (!m) throw ErroApi.naoEncontrado('Marca não encontrada.');
  return m;
}

async function garantirUnicos(
  tx: DbEmpresa,
  d: { descricao: string; semMarca: boolean },
  exceto?: string,
): Promise<void> {
  const vivas = and(isNull(marcas.excluidoEm), exceto ? ne(marcas.id, exceto) : undefined);
  const campos: Record<string, string[]> = {};
  const [dup] = await tx
    .select({ id: marcas.id })
    .from(marcas)
    .where(and(vivas, sql`lower(fn_unaccent(${marcas.descricao})) = lower(fn_unaccent(${d.descricao}))`));
  if (dup) campos.descricao = ['Já existe uma marca com esta descrição'];
  if (d.semMarca) {
    const [sem] = await tx
      .select({ descricao: marcas.descricao })
      .from(marcas)
      .where(and(vivas, eq(marcas.semMarca, true)));
    if (sem) campos.semMarca = [`A marca genérica já é ${sem.descricao}`];
  }
  garantirSemConflito(campos, 'Já existe uma marca com estes dados.');
}

async function detalhe(db: DbEmpresa, id: string): Promise<MarcaDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [r] = await db
    .select({ m: marcas, produtos: sqlProdutos, autorNome: autor.nome })
    .from(marcas)
    .leftJoin(autor, eq(autor.id, marcas.atualizadoPorId))
    .where(and(eq(marcas.id, id), isNull(marcas.excluidoEm)));
  if (!r) return null;
  return {
    ...metadados(r.m, r.autorNome),
    codigo: r.m.codigo,
    descricao: r.m.descricao,
    semMarca: r.m.semMarca,
    exibeSite: r.m.exibeSite,
    ordem: r.m.ordem,
    produtos: r.produtos,
    logotipoArquivoId: r.m.logotipoArquivoId,
  };
}
