import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarEstoqueSchema,
  criarEstoqueSchema,
  filtroEstoquesSchema,
  limiteDeslocamento,
  type EstoqueDetalhe,
  type EstoqueResumo,
  type Pagina,
} from '@genesis/shared';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, contem, garantirSemConflito, metadados, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import {
  estoques,
  lojas,
  movimentosEstoque,
  saldosEstoque,
  usuarios,
  usuariosEstoques,
} from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { concederEstoqueAoCriador, estoqueVisivel } from './permitidos.js';

const LOCALIZACAO = 'Estoque › Locais de estoque';

const colunasOrdenacao = {
  codigo: estoques.codigo,
  nome: sql`lower(${estoques.nome})`,
  tipo: estoques.tipo,
  ativo: estoques.ativo,
};

/**
 * Locais de estoque (ERP 13.2; MD 3.2.4). Não têm `loja_id`: a loja aponta para o estoque. Cada usuário vê só os
 * estoques permitidos (`usuarios_estoques`, inclusive os sem loja, como o CD; decisão 149); Master e quem tem
 * `estoques.todos` veem todos.
 */
@Controller('estoques')
export class EstoquesController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('estoques.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<EstoqueResumo>> {
    const q = validar(filtroEstoquesSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const busca = contem(q.nome);
    const onde = and(
      isNull(estoques.excluidoEm),
      q.tipo ? eq(estoques.tipo, q.tipo) : undefined,
      q.situacao === 'ativos'
        ? eq(estoques.ativo, true)
        : q.situacao === 'inativos'
          ? eq(estoques.ativo, false)
          : undefined,
      busca ? sql`fn_unaccent(${estoques.nome}) ilike fn_unaccent(${busca})` : undefined,
      filtroEstoquesVisiveis(sessao),
    );
    return this.s.tenancy.cx().consulta(async (db) => {
      const itens = await db
        .select({
          id: estoques.id,
          codigo: estoques.codigo,
          nome: estoques.nome,
          tipo: estoques.tipo,
          lojaId: lojas.id,
          lojaNome: lojas.nome,
          ativo: estoques.ativo,
          versao: estoques.versao,
        })
        .from(estoques)
        .leftJoin(lojas, and(eq(lojas.estoqueId, estoques.id), isNull(lojas.excluidoEm)))
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'nome:asc', estoques.codigo))
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(estoques).where(onde);
      return { itens: itens as EstoqueResumo[], total: total?.n ?? 0, pagina: q.pagina, tamanho: q.tamanho };
    });
  }

  @Permissao('estoques.ver')
  @Get(':id')
  async obter(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<EstoqueDetalhe> {
    const estoqueId = validar(z.uuid(), id);
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db, estoqueId, sessao));
    if (!d) throw ErroApi.naoEncontrado('Local de estoque não encontrado.');
    return d;
  }

  @Permissao('estoques.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<EstoqueDetalhe> {
    const dados = validar(criarEstoqueSchema, corpo);
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        await garantirNomeUnico(tx, dados.nome);
        const [e] = await tx
          .insert(estoques)
          .values({ ...dados, criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId })
          .returning();
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'estoques',
          registroId: e!.id,
          localizacao: LOCALIZACAO,
          depois: e,
        });
        // Quem criou sem ver todos passa a ter o estoque (senão ele some da própria listagem).
        await concederEstoqueAoCriador(tx, sessao, e!.id);
        return e!.id;
      },
      { travaVersao: true },
    );
    // A sessão desta requisição ainda tem a lista antiga de estoques: a resposta não filtra por ela.
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id, null)))!;
  }

  @Permissao('estoques.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<EstoqueDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarEstoqueSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, id, sessao);
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        await garantirNomeUnico(tx, dados.nome, id);
        if (antes.ativo && !dados.ativo) {
          const [saldo] = await tx
            .select({ n: count() })
            .from(saldosEstoque)
            .where(
              and(
                eq(saldosEstoque.estoqueId, id),
                ne(saldosEstoque.quantidade, '0'),
                isNull(saldosEstoque.excluidoEm),
              ),
            );
          if ((saldo?.n ?? 0) > 0) {
            throw new ErroApi(
              'REGRA_NEGOCIO',
              'Para inativar, o estoque precisa estar com saldo zero em todos os produtos.',
              {
                campos: { ativo: ['Há produtos com saldo neste estoque'] },
              },
            );
          }
          const [loja] = await tx
            .select({ nome: lojas.nome })
            .from(lojas)
            .where(and(eq(lojas.estoqueId, id), eq(lojas.ativa, true), isNull(lojas.excluidoEm)));
          if (loja) {
            throw new ErroApi('REGRA_NEGOCIO', `O estoque está vinculado à loja ativa ${loja.nome}.`, {
              campos: { ativo: ['Vinculado a loja ativa'] },
            });
          }
        }
        const [depois] = await tx
          .update(estoques)
          .set({ ...dados, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(estoques.id, id), eq(estoques.versao, versao)))
          .returning();
        if (!depois) await conflitoVersao(tx, antes);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'estoques',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
          depois,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id, sessao)))!;
  }

  @Permissao('estoques.excluir')
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
        const [loja] = await tx
          .select({ nome: lojas.nome })
          .from(lojas)
          .where(and(eq(lojas.estoqueId, id), isNull(lojas.excluidoEm)));
        if (loja) throw new ErroApi('REGRA_NEGOCIO', `O estoque está vinculado à loja ${loja.nome}.`);
        const [mov] = await tx
          .select({ id: movimentosEstoque.id })
          .from(movimentosEstoque)
          .where(eq(movimentosEstoque.estoqueId, id))
          .limit(1);
        if (mov) throw new ErroApi('REGRA_NEGOCIO', 'O estoque tem movimentos: inative em vez de excluir.');
        const agora = new Date();
        await tx
          .update(estoques)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(eq(estoques.id, id));
        // Os vínculos dos usuários com o estoque excluído saem junto (decisão 149): senão a tela de usuários os
        // contaria como estoque que o editor não vê e travaria a edição de quem os tinha.
        await tx
          .update(usuariosEstoques)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(usuariosEstoques.estoqueId, id), isNull(usuariosEstoques.excluidoEm)));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'estoques',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }
}

/** Só os estoques permitidos (decisão 149): `usuarios_estoques`, inclusive os sem loja; Master e `estoques.todos`, todos. */
function filtroEstoquesVisiveis(sessao: SessaoErp) {
  return estoqueVisivel(sessao, sql`${estoques.id}`);
}

async function travar(tx: DbEmpresa, id: string, sessao: SessaoErp) {
  const [e] = await tx
    .select()
    .from(estoques)
    .where(and(eq(estoques.id, id), isNull(estoques.excluidoEm), filtroEstoquesVisiveis(sessao)))
    .for('update');
  if (!e) throw ErroApi.naoEncontrado('Local de estoque não encontrado.');
  return e;
}

async function garantirNomeUnico(tx: DbEmpresa, nome: string, exceto?: string): Promise<void> {
  const [dup] = await tx
    .select({ id: estoques.id })
    .from(estoques)
    .where(
      and(
        isNull(estoques.excluidoEm),
        sql`lower(${estoques.nome}) = lower(${nome})`,
        exceto ? ne(estoques.id, exceto) : undefined,
      ),
    );
  if (dup) garantirSemConflito({ nome: ['Já existe um local de estoque com este nome'] });
}

/** `sessao` nulo = sem o filtro dos estoques permitidos (resposta da criação). */
async function detalhe(db: DbEmpresa, id: string, sessao: SessaoErp | null): Promise<EstoqueDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [r] = await db
    .select({ e: estoques, lojaId: lojas.id, lojaNome: lojas.nome, autorNome: autor.nome })
    .from(estoques)
    .leftJoin(lojas, and(eq(lojas.estoqueId, estoques.id), isNull(lojas.excluidoEm)))
    .leftJoin(autor, eq(autor.id, estoques.atualizadoPorId))
    .where(
      and(
        eq(estoques.id, id),
        isNull(estoques.excluidoEm),
        sessao ? filtroEstoquesVisiveis(sessao) : undefined,
      ),
    );
  if (!r) return null;
  return {
    ...metadados(r.e, r.autorNome),
    codigo: r.e.codigo,
    nome: r.e.nome,
    tipo: r.e.tipo as EstoqueDetalhe['tipo'],
    endereco: r.e.endereco,
    ativo: r.e.ativo,
    lojaId: r.lojaId,
    lojaNome: r.lojaNome,
  };
}
