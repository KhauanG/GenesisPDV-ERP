import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarGrupoPrecoSchema,
  criarGrupoPrecoSchema,
  filtroGruposPrecoSchema,
  limiteDeslocamento,
  TIPOS_GRUPO_PRECO,
  type GrupoPrecoDetalhe,
  type GrupoPrecoResumo,
  type Pagina,
  type TipoProduto,
} from '@genesis/shared';
import { and, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
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
import {
  gruposPrecoQuantidade,
  gruposPrecoQuantidadeFaixas,
  produtos,
  usuarios,
} from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { opcoesPorId } from './consultas.js';

const LOCALIZACAO = 'Produtos › Grupos de preço por quantidade';

const sqlProdutos = sql<number>`(select count(*)::int from produtos p where p.grupo_preco_quantidade_id = ${ref('grupos_preco_quantidade')} and p.excluido_em is null)`;
/** `f.loja_id` visível para a sessão (sem loja = todas, decisão 87; loja fora das permitidas some, decisão 88). */
const faixaVisivelSql = (lojas: readonly string[] | null) =>
  lojas === null
    ? sql``
    : lojas.length
      ? sql` and (f.loja_id is null or f.loja_id in (${sql.join(
          lojas.map((l) => sql`${l}::uuid`),
          sql`, `,
        )}))`
      : sql` and f.loja_id is null`;

const sqlFaixas = (lojas: readonly string[] | null) => sql<string>`coalesce((select string_agg(
    replace(rtrim(rtrim(f.quantidade_inicial::text, '0'), '.'), '.', ',') || '+ R$ '
      || replace(to_char(f.preco, 'FM999999999990.00'), '.', ',')
    || case when f.loja_id is null then '' else ' (' || l.nome || ')' end, '; '
    order by f.loja_id nulls first, f.quantidade_inicial)
  from grupos_preco_quantidade_faixas f left join lojas l on l.id = f.loja_id
  where f.grupo_id = ${ref('grupos_preco_quantidade')} and f.excluido_em is null${faixaVisivelSql(lojas)}), '')`;

const colunasOrdenacao = {
  codigo: gruposPrecoQuantidade.codigo,
  nome: sql`lower(fn_unaccent(${gruposPrecoQuantidade.nome}))`,
  produtos: sqlProdutos,
};

/**
 * Grupos de preço por quantidade – mix (ERP 8.10; MD 3.6.13): faixas só no modo `grupo`, membros gravados em
 * `produtos.grupo_preco_quantidade_id` (um grupo por produto; mover de outro grupo pede confirmação), mesma unidade
 * entre os membros e sem fração. Excluir desvincula os membros na mesma transação.
 */
@Controller('grupos-preco-quantidade')
export class GruposPrecoController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('grupos_preco.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<GrupoPrecoResumo>> {
    const q = validar(filtroGruposPrecoSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const busca = contem(q.nome);
    const onde = and(
      isNull(gruposPrecoQuantidade.excluidoEm),
      busca ? sql`fn_unaccent(${gruposPrecoQuantidade.nome}) ilike fn_unaccent(${busca})` : undefined,
      q.modoPreco ? eq(gruposPrecoQuantidade.modoPreco, q.modoPreco) : undefined,
      q.situacao === 'ativos'
        ? eq(gruposPrecoQuantidade.ativo, true)
        : q.situacao === 'inativos'
          ? eq(gruposPrecoQuantidade.ativo, false)
          : undefined,
    );
    return this.s.tenancy.cx().consulta(async (db) => {
      const itens = await db
        .select({
          id: gruposPrecoQuantidade.id,
          codigo: gruposPrecoQuantidade.codigo,
          nome: gruposPrecoQuantidade.nome,
          modoPreco: gruposPrecoQuantidade.modoPreco,
          ativo: gruposPrecoQuantidade.ativo,
          produtos: sqlProdutos,
          faixasResumo: sqlFaixas(sessao.lojas),
          versao: gruposPrecoQuantidade.versao,
        })
        .from(gruposPrecoQuantidade)
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'nome:asc', gruposPrecoQuantidade.codigo))
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(gruposPrecoQuantidade).where(onde);
      return {
        itens: itens as GrupoPrecoResumo[],
        total: total?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }

  @Permissao('grupos_preco.ver')
  @Get(':id')
  async obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<GrupoPrecoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db, id, verCusto(sessao), sessao.lojas));
    if (!d) throw ErroApi.naoEncontrado('Grupo de preço não encontrado.');
    return d;
  }

  @Permissao('grupos_preco.editar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<GrupoPrecoDetalhe> {
    const dados = validar(criarGrupoPrecoSchema, corpo);
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        await garantirNomeUnico(tx, dados.nome);
        const [g] = await tx
          .insert(gruposPrecoQuantidade)
          .values({
            nome: dados.nome,
            modoPreco: dados.modoPreco,
            ativo: dados.ativo,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning();
        await gravarFaixas(tx, sessao, g!.id, dados.faixas);
        const membros = await gravarMembros(tx, sessao, g!.id, dados.produtos, dados.confirmarMover);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'grupos_preco_quantidade',
          registroId: g!.id,
          localizacao: LOCALIZACAO,
          depois: { ...g, faixas: dados.faixas, produtos: dados.produtos, membros },
        });
        return g!.id;
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id, verCusto(sessao), sessao.lojas)))!;
  }

  @Permissao('grupos_preco.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<GrupoPrecoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarGrupoPrecoSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const linha = await travar(tx, id);
        const antes = (await detalhe(tx, id, false))!;
        if (antes.versao !== versao) await conflitoVersao(tx, { ...linha, versao: antes.versao });
        await garantirNomeUnico(tx, dados.nome, id);
        const [depois] = await tx
          .update(gruposPrecoQuantidade)
          .set({
            nome: dados.nome,
            modoPreco: dados.modoPreco,
            ativo: dados.ativo,
            atualizadoPorId: sessao.usuarioId,
          })
          .where(eq(gruposPrecoQuantidade.id, id))
          .returning();
        // Modo `produto` não tem faixas (MD 3.6.13): mudar o modo exclui as faixas na mesma transação.
        await gravarFaixas(tx, sessao, id, dados.modoPreco === 'grupo' ? dados.faixas : [], {
          semFaixas: dados.modoPreco !== 'grupo',
        });
        const membros = await gravarMembros(tx, sessao, id, dados.produtos, dados.confirmarMover);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'grupos_preco_quantidade',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes: { ...antes, produtos: antes.produtos.map((p) => p.id) },
          depois: { ...depois, faixas: dados.faixas, produtos: dados.produtos, membros },
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id, verCusto(sessao), sessao.lojas)))!;
  }

  @Permissao('grupos_preco.editar')
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
        await travar(tx, id);
        const antes = (await detalhe(tx, id, false))!;
        const agora = new Date();
        const desvinculados = await tx
          .update(produtos)
          .set({ grupoPrecoQuantidadeId: null, atualizadoPorId: sessao.usuarioId })
          .where(eq(produtos.grupoPrecoQuantidadeId, id))
          .returning({ id: produtos.id });
        await tx
          .update(gruposPrecoQuantidadeFaixas)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(
            and(eq(gruposPrecoQuantidadeFaixas.grupoId, id), isNull(gruposPrecoQuantidadeFaixas.excluidoEm)),
          );
        await tx
          .update(gruposPrecoQuantidade)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(eq(gruposPrecoQuantidade.id, id));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'grupos_preco_quantidade',
          registroId: id,
          localizacao: LOCALIZACAO,
          descricao: `${desvinculados.length} produto(s) desvinculado(s)`,
          antes: { ...antes, produtos: antes.produtos.map((p) => p.id) },
        });
      },
      { travaVersao: true },
    );
  }
}

const verCusto = (s: SessaoErp) => s.permissoes.has('produtos.ver_custo');

async function travar(tx: DbEmpresa, id: string) {
  const [g] = await tx
    .select()
    .from(gruposPrecoQuantidade)
    .where(and(eq(gruposPrecoQuantidade.id, id), isNull(gruposPrecoQuantidade.excluidoEm)))
    .for('update');
  if (!g) throw ErroApi.naoEncontrado('Grupo de preço não encontrado.');
  return g;
}

async function garantirNomeUnico(tx: DbEmpresa, nome: string, exceto?: string): Promise<void> {
  const [dup] = await tx
    .select({ id: gruposPrecoQuantidade.id })
    .from(gruposPrecoQuantidade)
    .where(
      and(
        isNull(gruposPrecoQuantidade.excluidoEm),
        exceto ? sql`${gruposPrecoQuantidade.id} <> ${exceto}` : undefined,
        sql`lower(fn_unaccent(${gruposPrecoQuantidade.nome})) = lower(fn_unaccent(${nome}))`,
      ),
    );
  garantirSemConflito(dup ? { nome: ['Já existe um grupo com este nome'] } : {});
}

/** Faixa que mudou é excluída e recriada (o `exclude` de sobreposição não é adiável; `loja_id` é imutável). */
async function gravarFaixas(
  tx: DbEmpresa,
  sessao: SessaoErp,
  grupoId: string,
  faixas: Array<{
    id: string | null;
    lojaId: string | null;
    quantidadeInicial: string;
    quantidadeFinal: string | null;
    preco: string;
  }>,
  opcoes: { semFaixas?: boolean } = {},
): Promise<void> {
  const atuais = await tx
    .select()
    .from(gruposPrecoQuantidadeFaixas)
    .where(
      and(eq(gruposPrecoQuantidadeFaixas.grupoId, grupoId), isNull(gruposPrecoQuantidadeFaixas.excluidoEm)),
    );
  const n = (v: string | null) => (v === null ? null : Number(v));
  const manter = new Set(
    faixas
      .filter((f) =>
        atuais.some(
          (a) =>
            a.id === f.id &&
            a.lojaId === f.lojaId &&
            n(a.quantidadeInicial) === n(f.quantidadeInicial) &&
            n(a.quantidadeFinal) === n(f.quantidadeFinal) &&
            n(a.preco) === n(f.preco),
        ),
      )
      .map((f) => f.id!),
  );
  // Mix por loja (decisão 88): faixa de loja fora das permitidas não pode ser enviada (403) e, como o detalhe não a
  // mostra, é preservada. Faixa sem loja segue a decisão 87 (quem tem `grupos_preco.editar`).
  const visivel = (lojaId: string | null) =>
    lojaId === null || sessao.lojas === null || sessao.lojas.includes(lojaId);
  if (faixas.some((f) => !visivel(f.lojaId))) {
    throw ErroApi.semPermissao('Loja fora das suas lojas permitidas.');
  }
  const ocultas = atuais.filter((a) => !visivel(a.lojaId));
  if (opcoes.semFaixas && ocultas.length) {
    throw ErroApi.semPermissao(
      'O grupo tem faixas de lojas fora das suas lojas permitidas: só quem tem acesso a elas pode mudar o modo para "por produto".',
    );
  }
  const remover = atuais
    .filter((a) => !manter.has(a.id) && (opcoes.semFaixas || visivel(a.lojaId)))
    .map((a) => a.id);
  if (remover.length) {
    await tx
      .update(gruposPrecoQuantidadeFaixas)
      .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
      .where(inArray(gruposPrecoQuantidadeFaixas.id, remover));
  }
  const novas = faixas.filter((f) => !(f.id && manter.has(f.id)));
  if (novas.length) {
    await tx.insert(gruposPrecoQuantidadeFaixas).values(
      novas.map(({ id: _id, ...f }) => ({
        ...f,
        grupoId,
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      })),
    );
  }
}

/**
 * Membros do grupo (ERP 8.10): tipo Simples/Com variações/Produzido, sem fração, todos na mesma unidade. Produto em
 * outro grupo só é movido com `confirmarMover` (senão 409 com a lista, para a tela confirmar).
 */
async function gravarMembros(
  tx: DbEmpresa,
  sessao: SessaoErp,
  grupoId: string,
  ids: string[],
  confirmarMover: boolean,
): Promise<{ incluidos: number; removidos: number }> {
  const linhas = ids.length
    ? await tx
        .select({
          id: produtos.id,
          codigo: produtos.codigo,
          nome: produtos.nome,
          tipo: produtos.tipo,
          permiteFracao: produtos.permiteFracao,
          unidadeId: produtos.unidadeId,
          grupo: produtos.grupoPrecoQuantidadeId,
        })
        .from(produtos)
        .where(and(inArray(produtos.id, ids), isNull(produtos.excluidoEm)))
        .for('update')
    : [];
  const campos: Record<string, string[]> = {};
  if (linhas.length !== ids.length) campos.produtos = ['Produto inexistente'];
  for (const p of linhas) {
    const i = ids.indexOf(p.id);
    if (!TIPOS_GRUPO_PRECO.includes(p.tipo as TipoProduto)) {
      (campos[`produtos.${i}`] ??= []).push(`${p.nome}: só Simples, Com variações ou Produzido`);
    } else if (p.permiteFracao) {
      (campos[`produtos.${i}`] ??= []).push(`${p.nome}: produto fracionado não entra em grupo de preço`);
    }
  }
  if (new Set(linhas.map((l) => l.unidadeId)).size > 1) {
    (campos.produtos ??= []).push('Todos os membros precisam ter a mesma unidade');
  }
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os produtos do grupo.', { campos });
  const deOutro = linhas.filter((l) => l.grupo !== null && l.grupo !== grupoId);
  if (deOutro.length && !confirmarMover) {
    throw new ErroApi(
      'CONFLITO',
      `${deOutro.length} produto(s) já pertencem a outro grupo de preço. Mover para este grupo?`,
      {
        detalhes: {
          moverDeOutroGrupo: deOutro.map((p) => ({ id: p.id, codigo: p.codigo, nome: p.nome })),
        },
      },
    );
  }
  const removidos = await tx
    .update(produtos)
    .set({ grupoPrecoQuantidadeId: null, atualizadoPorId: sessao.usuarioId })
    .where(
      and(
        eq(produtos.grupoPrecoQuantidadeId, grupoId),
        ids.length
          ? sql`${produtos.id} not in (${sql.join(
              ids.map((i) => sql`${i}::uuid`),
              sql`, `,
            )})`
          : undefined,
      ),
    )
    .returning({ id: produtos.id });
  const incluir = linhas.filter((l) => l.grupo !== grupoId).map((l) => l.id);
  if (incluir.length) {
    await tx
      .update(produtos)
      .set({ grupoPrecoQuantidadeId: grupoId, atualizadoPorId: sessao.usuarioId })
      .where(inArray(produtos.id, incluir));
  }
  return { incluidos: incluir.length, removidos: removidos.length };
}

async function detalhe(
  db: DbEmpresa,
  id: string,
  custo: boolean,
  lojas: readonly string[] | null = null,
): Promise<GrupoPrecoDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [r] = await db
    .select({ g: gruposPrecoQuantidade, autorNome: autor.nome })
    .from(gruposPrecoQuantidade)
    .leftJoin(autor, eq(autor.id, gruposPrecoQuantidade.atualizadoPorId))
    .where(and(eq(gruposPrecoQuantidade.id, id), isNull(gruposPrecoQuantidade.excluidoEm)));
  if (!r) return null;
  const faixas = await db
    .select()
    .from(gruposPrecoQuantidadeFaixas)
    .where(
      and(
        eq(gruposPrecoQuantidadeFaixas.grupoId, id),
        isNull(gruposPrecoQuantidadeFaixas.excluidoEm),
        lojas === null
          ? undefined
          : lojas.length
            ? or(
                isNull(gruposPrecoQuantidadeFaixas.lojaId),
                inArray(gruposPrecoQuantidadeFaixas.lojaId, [...lojas]),
              )
            : isNull(gruposPrecoQuantidadeFaixas.lojaId),
      ),
    )
    .orderBy(
      sql`${gruposPrecoQuantidadeFaixas.lojaId} nulls first`,
      gruposPrecoQuantidadeFaixas.quantidadeInicial,
    );
  const membros = await db
    .select({ id: produtos.id })
    .from(produtos)
    .where(and(eq(produtos.grupoPrecoQuantidadeId, id), isNull(produtos.excluidoEm)));
  const opcoes = await opcoesPorId(
    db,
    membros.map((m) => m.id),
    custo,
  );
  const idsMembros = membros.map((m) => m.id);
  const precosMembros: GrupoPrecoDetalhe['precosMembros'] = [];
  if (idsMembros.length) {
    const lista = sql.join(
      idsMembros.map((i) => sql`${i}::uuid`),
      sql`, `,
    );
    const filtroLoja = (coluna: string) =>
      lojas === null
        ? sql``
        : lojas.length
          ? sql` and (${sql.raw(coluna)} is null or ${sql.raw(coluna)} in (${sql.join(
              lojas.map((l) => sql`${l}::uuid`),
              sql`, `,
            )}))`
          : sql` and ${sql.raw(coluna)} is null`;
    const { rows: promo } = await db.execute<{
      id: string;
      preco_promocional: string | null;
      promocao_inicio: string | null;
      promocao_fim: string | null;
    }>(sql`select id, preco_promocional::text, promocao_inicio::text, promocao_fim::text
             from produtos where id in (${lista})`);
    const { rows: pl } = await db.execute<{
      produto_id: string;
      loja_id: string;
      preco_venda: string | null;
    }>(
      sql`select produto_id, loja_id, preco_venda::text from produtos_lojas
           where produto_id in (${lista}) and excluido_em is null${filtroLoja('loja_id')}`,
    );
    const { rows: pf } = await db.execute<{
      produto_id: string;
      loja_id: string | null;
      qi: string;
      qf: string | null;
      preco: string;
    }>(sql`select produto_id, loja_id, quantidade_inicial::text as qi, quantidade_final::text as qf, preco::text
             from produtos_precos_quantidade
            where produto_id in (${lista}) and variacao_id is null and excluido_em is null${filtroLoja('loja_id')}`);
    for (const p of promo) {
      precosMembros.push({
        produtoId: p.id,
        precoPromocional: p.preco_promocional,
        promocaoInicio: p.promocao_inicio ? new Date(p.promocao_inicio).toISOString() : null,
        promocaoFim: p.promocao_fim ? new Date(p.promocao_fim).toISOString() : null,
        lojas: pl
          .filter((l) => l.produto_id === p.id)
          .map((l) => ({ lojaId: l.loja_id, precoVenda: l.preco_venda })),
        faixas: pf
          .filter((f) => f.produto_id === p.id)
          .map((f) => ({
            lojaId: f.loja_id,
            quantidadeInicial: f.qi,
            quantidadeFinal: f.qf,
            preco: f.preco,
          })),
      });
    }
  }
  // Versão do cadastro inteiro: grupo + faixas (decisão 47); os membros têm a versão própria.
  const { rows } = await db.execute<{ v: string }>(sql`select greatest(
    (select versao from grupos_preco_quantidade where id = ${id}),
    (select max(versao) from grupos_preco_quantidade_faixas where grupo_id = ${id}))::text as v`);
  return {
    ...metadados(r.g, r.autorNome),
    versao: Number(rows[0]!.v),
    codigo: r.g.codigo,
    nome: r.g.nome,
    modoPreco: r.g.modoPreco as 'produto' | 'grupo',
    ativo: r.g.ativo,
    faixas: faixas.map((f) => ({
      id: f.id,
      lojaId: f.lojaId,
      quantidadeInicial: f.quantidadeInicial,
      quantidadeFinal: f.quantidadeFinal,
      preco: f.preco,
    })),
    produtos: [...opcoes.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    precosMembros,
  };
}
