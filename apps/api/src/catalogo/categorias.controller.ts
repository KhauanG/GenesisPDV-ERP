import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarCategoriaSchema,
  criarCategoriaSchema,
  excluirCategoriaQuerySchema,
  moverCategoriaSchema,
  PROFUNDIDADE_MAXIMA_CATEGORIAS,
  type CategoriaNo,
} from '@genesis/shared';
import { and, asc, count, eq, isNull, like, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, escaparLike, garantirSemConflito, ref } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { categorias, produtosCategorias } from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const LOCALIZACAO = 'Produtos › Categorias';
const SEPARADOR_NOMES = ' > ';

type LinhaCategoria = typeof categorias.$inferSelect;

const sqlProdutos = sql<number>`(select count(*)::int from produtos_categorias pc where pc.categoria_id = ${ref('categorias')} and pc.excluido_em is null)`;

/**
 * Categorias em árvore (ERP 8.4; MD 3.6.2): `caminho` materializado com ids (`raiz/filho/…`), `caminho_nomes`
 * ("CERVEJA > LATA") e `nivel` mantidos pela API; até 5 níveis, nome único entre irmãs, sem ciclos.
 */
@Controller('categorias')
export class CategoriasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('categorias.ver')
  @Get('arvore')
  async arvore(): Promise<CategoriaNo[]> {
    return this.s.tenancy.cx().consulta((db) =>
      db
        .select({
          id: categorias.id,
          nome: categorias.nome,
          categoriaPaiId: categorias.categoriaPaiId,
          caminhoNomes: categorias.caminhoNomes,
          nivel: categorias.nivel,
          ordem: categorias.ordem,
          ativa: categorias.ativa,
          exibePdv: categorias.exibePdv,
          exibeMenuDigital: categorias.exibeMenuDigital,
          exibeTotem: categorias.exibeTotem,
          exibeSite: categorias.exibeSite,
          cor: categorias.cor,
          produtos: sqlProdutos,
          versao: categorias.versao,
        })
        .from(categorias)
        .where(isNull(categorias.excluidoEm))
        .orderBy(asc(categorias.caminhoNomes)),
    );
  }

  @Permissao('categorias.editar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<CategoriaNo> {
    const dados = validar(criarCategoriaSchema, corpo);
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        const pai = dados.categoriaPaiId ? await travar(tx, dados.categoriaPaiId, 'categoriaPaiId') : null;
        if (pai && pai.nivel >= PROFUNDIDADE_MAXIMA_CATEGORIAS) {
          throw erroProfundidade();
        }
        await garantirNomeIrmas(tx, dados.categoriaPaiId, dados.nome);
        const id = uuidv7();
        const [c] = await tx
          .insert(categorias)
          .values({
            ...dados,
            id,
            caminho: pai ? `${pai.caminho}/${id}` : id,
            caminhoNomes: pai ? `${pai.caminhoNomes}${SEPARADOR_NOMES}${dados.nome}` : dados.nome,
            nivel: pai ? pai.nivel + 1 : 1,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning();
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'categorias',
          registroId: id,
          localizacao: LOCALIZACAO,
          depois: c,
        });
        return id;
      },
      { travaVersao: true },
    );
    return this.no(id);
  }

  @Permissao('categorias.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<CategoriaNo> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarCategoriaSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, id);
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        if (dados.nome !== antes.nome) await garantirNomeIrmas(tx, antes.categoriaPaiId, dados.nome, id);
        const prefixo = antes.caminhoNomes.slice(0, antes.caminhoNomes.length - antes.nome.length);
        const [depois] = await tx
          .update(categorias)
          .set({ ...dados, caminhoNomes: `${prefixo}${dados.nome}`, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(categorias.id, id), eq(categorias.versao, versao)))
          .returning();
        if (!depois) await conflitoVersao(tx, antes);
        if (dados.nome !== antes.nome) await recalcularDescendentes(tx, depois!, sessao);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'categorias',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
          depois,
        });
      },
      { travaVersao: true },
    );
    return this.no(id);
  }

  /** Arrastar e soltar (ERP 8.4): novo pai (vazio = raiz) e ordem; sem ciclo e até 5 níveis com a subárvore. */
  @Permissao('categorias.editar')
  @Post(':id/mover')
  @HttpCode(200)
  async mover(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<CategoriaNo> {
    const id = validar(z.uuid(), idBruto);
    const { versao, categoriaPaiId, ordem } = validar(moverCategoriaSchema, corpo);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, id);
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        const pai = categoriaPaiId ? await travar(tx, categoriaPaiId, 'categoriaPaiId') : null;
        if (pai && (pai.id === id || pai.caminho.startsWith(`${antes.caminho}/`))) {
          throw new ErroApi('REGRA_NEGOCIO', 'Não é possível mover a categoria para dentro dela mesma.', {
            campos: { categoriaPaiId: ['Escolha uma categoria fora desta subárvore'] },
          });
        }
        const [prof] = await tx
          .select({ max: sql<number>`coalesce(max(${categorias.nivel}), 0)` })
          .from(categorias)
          .where(
            and(like(categorias.caminho, `${escaparLike(antes.caminho)}/%`), isNull(categorias.excluidoEm)),
          );
        const alturaSubarvore = Math.max(prof?.max ?? 0, antes.nivel) - antes.nivel;
        if ((pai ? pai.nivel + 1 : 1) + alturaSubarvore > PROFUNDIDADE_MAXIMA_CATEGORIAS)
          throw erroProfundidade();
        if ((pai?.id ?? null) !== antes.categoriaPaiId)
          await garantirNomeIrmas(tx, pai?.id ?? null, antes.nome, id);
        const [depois] = await tx
          .update(categorias)
          .set({
            categoriaPaiId: pai?.id ?? null,
            caminho: pai ? `${pai.caminho}/${id}` : id,
            caminhoNomes: pai ? `${pai.caminhoNomes}${SEPARADOR_NOMES}${antes.nome}` : antes.nome,
            nivel: pai ? pai.nivel + 1 : 1,
            ...(ordem !== undefined ? { ordem } : {}),
            atualizadoPorId: sessao.usuarioId,
          })
          .where(eq(categorias.id, id))
          .returning();
        await recalcularDescendentes(tx, depois!, sessao, antes.caminho);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'categorias',
          registroId: id,
          localizacao: LOCALIZACAO,
          descricao: 'Categoria movida',
          antes: {
            categoriaPaiId: antes.categoriaPaiId,
            caminhoNomes: antes.caminhoNomes,
            ordem: antes.ordem,
          },
          depois: {
            categoriaPaiId: depois!.categoriaPaiId,
            caminhoNomes: depois!.caminhoNomes,
            ordem: depois!.ordem,
          },
        });
      },
      { travaVersao: true },
    );
    return this.no(id);
  }

  /**
   * ERP 8.4: com subcategorias, exclua/mova as filhas antes; com produtos, pede confirmação (`?confirmar=true`) e
   * remove só os vínculos (os produtos ficam).
   */
  @Permissao('categorias.editar')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') idBruto: string,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const id = validar(z.uuid(), idBruto);
    const { confirmar } = validar(excluirCategoriaQuerySchema, query);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, id);
        const [filhas] = await tx
          .select({ n: count() })
          .from(categorias)
          .where(and(eq(categorias.categoriaPaiId, id), isNull(categorias.excluidoEm)));
        if ((filhas?.n ?? 0) > 0) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'A categoria tem subcategorias: exclua ou mova as filhas antes.',
          );
        }
        const [vinculos] = await tx
          .select({ n: count() })
          .from(produtosCategorias)
          .where(and(eq(produtosCategorias.categoriaId, id), isNull(produtosCategorias.excluidoEm)));
        const n = vinculos?.n ?? 0;
        if (n > 0 && !confirmar) {
          throw new ErroApi(
            'REGRA_NEGOCIO',
            `A categoria tem ${n} produto(s). Confirme para remover os vínculos (os produtos ficam).`,
            {
              detalhes: { produtos: n, exigeConfirmacao: true },
            },
          );
        }
        const agora = new Date();
        if (n > 0) {
          await tx
            .update(produtosCategorias)
            .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
            .where(and(eq(produtosCategorias.categoriaId, id), isNull(produtosCategorias.excluidoEm)));
        }
        await tx
          .update(categorias)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(eq(categorias.id, id));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'categorias',
          registroId: id,
          localizacao: LOCALIZACAO,
          descricao: n ? `${n} vínculo(s) com produtos removido(s)` : null,
          antes,
        });
      },
      { travaVersao: true },
    );
  }

  private async no(id: string): Promise<CategoriaNo> {
    const nos = await this.arvore();
    return nos.find((n) => n.id === id)!;
  }
}

function erroProfundidade(): ErroApi {
  return new ErroApi('REGRA_NEGOCIO', `A árvore aceita até ${PROFUNDIDADE_MAXIMA_CATEGORIAS} níveis.`, {
    campos: { categoriaPaiId: [`Máximo de ${PROFUNDIDADE_MAXIMA_CATEGORIAS} níveis`] },
  });
}

async function travar(tx: DbEmpresa, id: string, campo?: string): Promise<LinhaCategoria> {
  const [c] = await tx
    .select()
    .from(categorias)
    .where(and(eq(categorias.id, id), isNull(categorias.excluidoEm)))
    .for('update');
  if (!c) {
    if (campo)
      throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
        campos: { [campo]: ['Categoria inexistente'] },
      });
    throw ErroApi.naoEncontrado('Categoria não encontrada.');
  }
  return c;
}

async function garantirNomeIrmas(
  tx: DbEmpresa,
  paiId: string | null,
  nome: string,
  exceto?: string,
): Promise<void> {
  const [dup] = await tx
    .select({ id: categorias.id })
    .from(categorias)
    .where(
      and(
        isNull(categorias.excluidoEm),
        paiId ? eq(categorias.categoriaPaiId, paiId) : isNull(categorias.categoriaPaiId),
        sql`lower(${categorias.nome}) = lower(${nome})`,
        exceto ? ne(categorias.id, exceto) : undefined,
      ),
    );
  if (dup) garantirSemConflito({ nome: ['Já existe uma categoria com este nome neste nível'] });
}

/** Refaz `caminho`, `caminho_nomes` e `nivel` da subárvore a partir do nó já gravado (ordem por profundidade). */
async function recalcularDescendentes(
  tx: DbEmpresa,
  raiz: LinhaCategoria,
  sessao: SessaoErp,
  caminhoAntigo = raiz.caminho,
): Promise<void> {
  const descendentes = await tx
    .select()
    .from(categorias)
    .where(and(like(categorias.caminho, `${escaparLike(caminhoAntigo)}/%`), isNull(categorias.excluidoEm)))
    .orderBy(asc(categorias.nivel));
  const porId = new Map<string, { caminho: string; caminhoNomes: string; nivel: number }>([
    [raiz.id, { caminho: raiz.caminho, caminhoNomes: raiz.caminhoNomes, nivel: raiz.nivel }],
  ]);
  for (const d of descendentes) {
    const pai = porId.get(d.categoriaPaiId!)!;
    const novo = {
      caminho: `${pai.caminho}/${d.id}`,
      caminhoNomes: `${pai.caminhoNomes}${SEPARADOR_NOMES}${d.nome}`,
      nivel: pai.nivel + 1,
    };
    porId.set(d.id, novo);
    await tx
      .update(categorias)
      .set({ ...novo, atualizadoPorId: sessao.usuarioId })
      .where(eq(categorias.id, d.id));
  }
}
