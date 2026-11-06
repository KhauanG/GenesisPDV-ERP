import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarRestricaoHorarioSchema,
  criarRestricaoHorarioSchema,
  filtroRestricoesHorarioSchema,
  limiteDeslocamento,
  type Pagina,
  type RestricaoHorarioDetalhe,
  type RestricaoHorarioResumo,
} from '@genesis/shared';
import { and, count, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, contem, erroCampo, metadados, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { categorias, lojas, restricoesHorarioVenda, usuarios } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const LOCALIZACAO = 'Produtos › Restrições de horário de venda';
const r = restricoesHorarioVenda;

const colunasOrdenacao = {
  descricao: sql`lower(fn_unaccent(${r.descricao}))`,
  hora_inicio: r.horaInicio,
  loja: sql`lower(${lojas.nome})`,
};

/** Restrição de loja fora das permitidas não aparece nem é alterada; `loja_id` nulo (todas) é de todos. */
function visivel(sessao: SessaoErp) {
  if (sessao.lojas === null) return undefined;
  return or(
    isNull(r.lojaId),
    sessao.lojas.length
      ? sql`${r.lojaId} in (${sql.join(
          sessao.lojas.map((l) => sql`${l}::uuid`),
          sql`, `,
        )})`
      : sql`false`,
  );
}

function consulta(db: DbEmpresa) {
  const autor = alias(usuarios, 'autor');
  return db
    .select({
      r,
      lojaNome: lojas.nome,
      categoriaNome: categorias.caminhoNomes,
      autorNome: autor.nome,
    })
    .from(r)
    .leftJoin(lojas, eq(lojas.id, r.lojaId))
    .leftJoin(categorias, eq(categorias.id, r.categoriaId))
    .leftJoin(autor, eq(autor.id, r.atualizadoPorId))
    .$dynamic();
}

type LinhaConsulta = Awaited<ReturnType<ReturnType<typeof consulta>['execute']>>[number];

function resumo(l: LinhaConsulta): RestricaoHorarioResumo {
  return {
    id: l.r.id,
    descricao: l.r.descricao,
    lojaId: l.r.lojaId,
    lojaNome: l.lojaNome,
    categoriaId: l.r.categoriaId,
    categoriaNome: l.categoriaNome,
    idadeMinimaProduto: l.r.idadeMinimaProduto,
    diasSemana: l.r.diasSemana,
    horaInicio: l.r.horaInicio.slice(0, 5),
    horaFim: l.r.horaFim.slice(0, 5),
    dataEspecifica: l.r.dataEspecifica,
    ativo: l.r.ativo,
    versao: l.r.versao,
  };
}

/**
 * Restrições de horário de venda (ERP 8.9; MD 3.6.12; aplicadas pelo PDV 10.11): por categoria (com as
 * subcategorias) e/ou idade mínima do produto, faixa que pode atravessar a meia-noite, dias da semana ou data
 * específica; `loja_id` nulo = todas as lojas e imutável depois de gravado.
 */
@Controller('restricoes-horario-venda')
export class RestricoesHorarioController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('restricoes_horario.ver')
  @Get()
  async listar(
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<Pagina<RestricaoHorarioResumo>> {
    const q = validar(filtroRestricoesHorarioSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const busca = contem(q.descricao);
    const onde = and(
      isNull(r.excluidoEm),
      visivel(sessao),
      busca ? sql`fn_unaccent(${r.descricao}) ilike fn_unaccent(${busca})` : undefined,
      q.lojaId ? or(eq(r.lojaId, q.lojaId), isNull(r.lojaId)) : undefined,
      q.situacao === 'ativos'
        ? eq(r.ativo, true)
        : q.situacao === 'inativos'
          ? eq(r.ativo, false)
          : undefined,
    );
    return this.s.tenancy.cx().consulta(async (db) => {
      const linhas = await consulta(db)
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'descricao:asc', r.id))
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(r).where(onde);
      return { itens: linhas.map(resumo), total: total?.n ?? 0, pagina: q.pagina, tamanho: q.tamanho };
    });
  }

  @Permissao('restricoes_horario.ver')
  @Get(':id')
  async obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<RestricaoHorarioDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db, id, sessao));
    if (!d) throw ErroApi.naoEncontrado('Restrição não encontrada.');
    return d;
  }

  @Permissao('restricoes_horario.editar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RestricaoHorarioDetalhe> {
    const dados = validar(criarRestricaoHorarioSchema, corpo);
    if (dados.lojaId && sessao.lojas !== null && !sessao.lojas.includes(dados.lojaId)) {
      throw ErroApi.semPermissao('Loja fora das suas lojas permitidas.');
    }
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        await conferirReferencias(tx, dados);
        const [n] = await tx
          .insert(r)
          .values({ ...dados, criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId })
          .returning();
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'restricoes_horario_venda',
          registroId: n!.id,
          lojaId: n!.lojaId,
          localizacao: LOCALIZACAO,
          depois: n,
        });
        return n!.id;
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id, sessao)))!;
  }

  @Permissao('restricoes_horario.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RestricaoHorarioDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarRestricaoHorarioSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, id, sessao);
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        await conferirReferencias(tx, dados);
        const [depois] = await tx
          .update(r)
          .set({ ...dados, atualizadoPorId: sessao.usuarioId })
          .where(eq(r.id, id))
          .returning();
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'restricoes_horario_venda',
          registroId: id,
          lojaId: antes.lojaId,
          localizacao: LOCALIZACAO,
          antes,
          depois,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id, sessao)))!;
  }

  @Permissao('restricoes_horario.editar')
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
        const antes = await travar(tx, id, sessao);
        await tx
          .update(r)
          .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
          .where(eq(r.id, id));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'restricoes_horario_venda',
          registroId: id,
          lojaId: antes.lojaId,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }
}

async function travar(tx: DbEmpresa, id: string, sessao: SessaoErp) {
  const [l] = await tx
    .select()
    .from(r)
    .where(and(eq(r.id, id), isNull(r.excluidoEm)))
    .for('update');
  if (!l) throw ErroApi.naoEncontrado('Restrição não encontrada.');
  if (l.lojaId && sessao.lojas !== null && !sessao.lojas.includes(l.lojaId)) {
    throw ErroApi.semPermissao('Restrição de loja fora das suas lojas permitidas.');
  }
  return l;
}

async function conferirReferencias(
  tx: DbEmpresa,
  d: { lojaId?: string | null; categoriaId: string | null },
): Promise<void> {
  if (d.lojaId) {
    const [l] = await tx
      .select({ id: lojas.id })
      .from(lojas)
      .where(and(eq(lojas.id, d.lojaId), isNull(lojas.excluidoEm)));
    if (!l) throw erroCampo('lojaId', 'Loja inexistente');
  }
  if (d.categoriaId) {
    const [c] = await tx
      .select({ id: categorias.id })
      .from(categorias)
      .where(and(eq(categorias.id, d.categoriaId), isNull(categorias.excluidoEm)));
    if (!c) throw erroCampo('categoriaId', 'Categoria inexistente');
  }
}

async function detalhe(
  db: DbEmpresa,
  id: string,
  sessao: SessaoErp,
): Promise<RestricaoHorarioDetalhe | null> {
  const [l] = await consulta(db).where(and(eq(r.id, id), isNull(r.excluidoEm), visivel(sessao)));
  if (!l) return null;
  return { ...resumo(l), ...metadados(l.r, l.autorNome) };
}
