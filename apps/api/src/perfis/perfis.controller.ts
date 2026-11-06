import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarPerfilSchema,
  criarPerfilSchema,
  filtroPerfisSchema,
  limiteDeslocamento,
  type Pagina,
  type PerfilDetalhe,
  type PerfilResumo,
} from '@genesis/shared';
import { and, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, contem, garantirSemConflito, ordemDaQuery, ref } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { perfis, perfisPermissoes, usuarios } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const LOCALIZACAO = 'Cadastros › Perfis de acesso';

const sqlUsuarios = sql<number>`(select count(*)::int from usuarios u where u.perfil_id = ${ref('perfis')} and u.excluido_em is null)`;

/** Perfis de acesso (ERP 11.3): nome, descrição e permissões (Menus do sistema + Permissões Gerais), Duplicar. */
@Controller('perfis')
export class PerfisController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('perfis.ver')
  @Get()
  async listar(@Query() query: unknown): Promise<Pagina<PerfilResumo>> {
    const q = validar(filtroPerfisSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const busca = contem(q.nome);
    const onde = and(
      isNull(perfis.excluidoEm),
      busca ? sql`fn_unaccent(${perfis.nome}) ilike fn_unaccent(${busca})` : undefined,
    );
    return this.s.tenancy.cx().consulta(async (db) => {
      const itens = await db
        .select({
          id: perfis.id,
          nome: perfis.nome,
          descricao: perfis.descricao,
          chaveSistema: perfis.chaveSistema,
          usuarios: sqlUsuarios,
        })
        .from(perfis)
        .where(onde)
        .orderBy(
          ...ordemDaQuery(
            q,
            { nome: sql`lower(${perfis.nome})`, usuarios: sqlUsuarios },
            'nome:asc',
            perfis.id,
          ),
        )
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(perfis).where(onde);
      return { itens, total: total?.n ?? 0, pagina: q.pagina, tamanho: q.tamanho };
    });
  }

  @Permissao('perfis.ver')
  @Get(':id')
  async obter(@Param('id') id: string): Promise<PerfilDetalhe> {
    const perfilId = validar(z.uuid(), id);
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db, perfilId));
    if (!d) throw ErroApi.naoEncontrado('Perfil não encontrado.');
    return d;
  }

  @Permissao('perfis.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<PerfilDetalhe> {
    const dados = validar(criarPerfilSchema, corpo);
    garantirSemEscalada(sessao, dados.permissoes, []);
    const id = await this.s.tenancy
      .cx()
      .transacao((tx) => this.inserir(tx, sessao, req, dados), { travaVersao: true });
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!;
  }

  /** Duplicar (ERP 11.3): cópia com "(cópia)" no nome e as mesmas permissões. */
  @Permissao('perfis.criar')
  @Post(':id/duplicar')
  @HttpCode(201)
  async duplicar(
    @Param('id') idBruto: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<PerfilDetalhe> {
    const origemId = validar(z.uuid(), idBruto);
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        const origem = await detalhe(tx, origemId);
        if (!origem) throw ErroApi.naoEncontrado('Perfil não encontrado.');
        garantirSemEscalada(sessao, origem.permissoes, []);
        let nome = `${origem.nome} (cópia)`.slice(0, 40);
        for (let i = 2; await nomeEmUso(tx, nome); i++) nome = `${origem.nome.slice(0, 30)} (cópia ${i})`;
        return this.inserir(tx, sessao, req, {
          nome,
          descricao: origem.descricao,
          permissoes: origem.permissoes,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!;
  }

  @Permissao('perfis.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<PerfilDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, permissoes, ...dados } = validar(alterarPerfilSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const [antes] = await tx
          .select()
          .from(perfis)
          .where(and(eq(perfis.id, id), isNull(perfis.excluidoEm)))
          .for('update');
        if (!antes) throw ErroApi.naoEncontrado('Perfil não encontrado.');
        const versaoAtual = await versaoAgregada(tx, id);
        if (versaoAtual !== versao) await conflitoVersao(tx, { ...antes, versao: versaoAtual });
        if (await nomeEmUso(tx, dados.nome, id))
          garantirSemConflito({ nome: ['Já existe um perfil com este nome'] });
        const atuais = await permissoesDoPerfil(tx, id);
        garantirSemEscalada(sessao, permissoes, atuais);
        const incluir = permissoes.filter((p) => !atuais.includes(p));
        const remover = atuais.filter((p) => !permissoes.includes(p));
        const mudouPermissoes = incluir.length + remover.length > 0;
        const [depois] = await tx
          .update(perfis)
          .set({ ...dados, atualizadoPorId: sessao.usuarioId })
          .where(eq(perfis.id, id))
          .returning();
        if (remover.length) {
          await tx
            .update(perfisPermissoes)
            .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
            .where(
              and(
                eq(perfisPermissoes.perfilId, id),
                inArray(perfisPermissoes.permissao, remover),
                isNull(perfisPermissoes.excluidoEm),
              ),
            );
        }
        if (incluir.length) {
          await tx.insert(perfisPermissoes).values(
            incluir.map((permissao) => ({
              perfilId: id,
              permissao,
              criadoPorId: sessao.usuarioId,
              atualizadoPorId: sessao.usuarioId,
            })),
          );
        }
        const origem = origemDaRequisicao(req);
        await this.s.auditoria.registrar(tx, origem, {
          acao: 'editar',
          entidade: 'perfis',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
          depois,
        });
        if (mudouPermissoes) {
          // ERP 11.3: alterar o perfil incrementa `permissoes_versao` de todos os usuários dele.
          await tx
            .update(usuarios)
            .set({ permissoesVersao: sql`${usuarios.permissoesVersao} + 1` })
            .where(and(eq(usuarios.perfilId, id), isNull(usuarios.excluidoEm)));
          await this.s.auditoria.registrar(tx, origem, {
            acao: 'permissoes_alteradas',
            entidade: 'perfis',
            registroId: id,
            localizacao: LOCALIZACAO,
            antes: { permissoes: atuais },
            depois: { permissoes, incluidas: incluir, removidas: remover },
          });
        }
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!;
  }

  @Permissao('perfis.excluir')
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
        const [antes] = await tx
          .select()
          .from(perfis)
          .where(and(eq(perfis.id, id), isNull(perfis.excluidoEm)))
          .for('update');
        if (!antes) throw ErroApi.naoEncontrado('Perfil não encontrado.');
        const [n] = await tx
          .select({ n: count() })
          .from(usuarios)
          .where(and(eq(usuarios.perfilId, id), isNull(usuarios.excluidoEm)));
        if ((n?.n ?? 0) > 0) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            `O perfil tem ${n!.n} usuário(s). Mude o perfil deles antes de excluir.`,
          );
        }
        const agora = new Date();
        await tx
          .update(perfis)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(eq(perfis.id, id));
        await tx
          .update(perfisPermissoes)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(perfisPermissoes.perfilId, id), isNull(perfisPermissoes.excluidoEm)));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'perfis',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes: { ...antes, permissoes: await permissoesDoPerfil(tx, id) },
        });
      },
      { travaVersao: true },
    );
  }

  private async inserir(
    tx: DbEmpresa,
    sessao: SessaoErp,
    req: RequisicaoGenesis,
    dados: { nome: string; descricao: string | null; permissoes: string[] },
  ): Promise<string> {
    if (await nomeEmUso(tx, dados.nome)) garantirSemConflito({ nome: ['Já existe um perfil com este nome'] });
    const [p] = await tx
      .insert(perfis)
      .values({
        nome: dados.nome,
        descricao: dados.descricao,
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      })
      .returning();
    if (dados.permissoes.length) {
      await tx.insert(perfisPermissoes).values(
        dados.permissoes.map((permissao) => ({
          perfilId: p!.id,
          permissao,
          criadoPorId: sessao.usuarioId,
          atualizadoPorId: sessao.usuarioId,
        })),
      );
    }
    await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
      acao: 'criar',
      entidade: 'perfis',
      registroId: p!.id,
      localizacao: LOCALIZACAO,
      depois: { ...p, permissoes: dados.permissoes },
    });
    return p!.id;
  }
}

/** Escalada (ERP 11.2/11.3): quem não é Master só concede (ou mantém concedidas) permissões que ele mesmo tem. */
function garantirSemEscalada(sessao: SessaoErp, novas: readonly string[], atuais: readonly string[]): void {
  if (sessao.master) return;
  const faltando = novas.filter((p) => !atuais.includes(p) && !sessao.permissoes.has(p));
  if (faltando.length) {
    throw new ErroApi('SEM_PERMISSAO', 'Você não pode conceder permissões que você não tem.', {
      detalhes: { permissoes: faltando },
    });
  }
}

async function nomeEmUso(tx: DbEmpresa, nome: string, exceto?: string): Promise<boolean> {
  const [dup] = await tx
    .select({ id: perfis.id })
    .from(perfis)
    .where(
      and(
        isNull(perfis.excluidoEm),
        sql`lower(${perfis.nome}) = lower(${nome})`,
        exceto ? ne(perfis.id, exceto) : undefined,
      ),
    );
  return !!dup;
}

async function permissoesDoPerfil(db: DbEmpresa, id: string): Promise<string[]> {
  const linhas = await db
    .select({ p: perfisPermissoes.permissao })
    .from(perfisPermissoes)
    .where(and(eq(perfisPermissoes.perfilId, id), isNull(perfisPermissoes.excluidoEm)));
  return linhas.map((l) => l.p).sort();
}

/** Versão do perfil com as permissões (o trigger não muda a linha do perfil quando só os itens mudam). */
async function versaoAgregada(db: DbEmpresa, id: string): Promise<number> {
  const { rows } = await db.execute<{ v: string }>(
    sql`select greatest((select versao from perfis where id = ${id}), (select max(versao) from perfis_permissoes where perfil_id = ${id}))::text as v`,
  );
  return Number(rows[0]!.v);
}

async function detalhe(db: DbEmpresa, id: string): Promise<PerfilDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [r] = await db
    .select({ p: perfis, usuarios: sqlUsuarios, autorNome: autor.nome })
    .from(perfis)
    .leftJoin(autor, eq(autor.id, perfis.atualizadoPorId))
    .where(and(eq(perfis.id, id), isNull(perfis.excluidoEm)));
  if (!r) return null;
  return {
    id: r.p.id,
    nome: r.p.nome,
    descricao: r.p.descricao,
    chaveSistema: r.p.chaveSistema,
    usuarios: r.usuarios,
    permissoes: await permissoesDoPerfil(db, id),
    versao: await versaoAgregada(db, id),
    criadoEm: r.p.criadoEm.toISOString(),
    atualizadoEm: r.p.atualizadoEm.toISOString(),
    atualizadoPorNome: r.autorNome,
  };
}
