import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarLojaSchema,
  criarLojaSchema,
  filtroLojasSchema,
  limiteDeslocamento,
  type AlterarLoja,
  type CriarLoja,
  type LojaDetalhe,
  type LojaResumo,
  type Pagina,
} from '@genesis/shared';
import { and, count, eq, ilike, inArray, isNull, max, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { filtroLojas, garantirLoja } from '../autorizacao/lojas.js';
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
import { empresas, planos } from '../database/controle/schema.js';
import {
  caixas,
  contasCorrentes,
  estoques,
  formasPagamento,
  formasPagamentoLojas,
  lojas,
  municipios,
  numeracoes,
  terminais,
  usuarios,
  usuariosLojas,
} from '../database/empresa/schema/index.js';
import { concederEstoqueAoCriador, garantirEstoquePermitido } from '../estoques/permitidos.js';
import { ressincronizarFluxosDaLoja } from '../sync/comandos.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { fluxosAfetados } from './fluxos-afetados.js';
import { garantirMunicipio } from './municipio.js';
import { garantirNumeracoesLoja } from './numeracoes.js';

/** Vincular a loja a um estoque existente exige vê-lo (decisão 149): senão a criação o concederia a quem cria. */
const MENSAGEM_ESTOQUE_FORA = 'O estoque escolhido está fora dos seus estoques permitidos.';

const LOCALIZACAO = 'Cadastros › Lojas';

/**
 * Recebedor do PIX estático (chave, nome e cidade; PDV 16.7): decide para qual conta vai o dinheiro de todo QR feito
 * no caixa. Trocar pede `lojas.editar_pix` (só o Administrador no seed; o Gerente edita o resto da loja sem tocar
 * nele) e deixa uma auditoria própria, `pix_recebedor_alterado`, além do `editar` da loja (README › decisão 144).
 */
const CAMPOS_PIX = ['chavePix', 'pixNomeRecebedor', 'pixCidadeRecebedor'] as const;
type RecebedorPix = Record<(typeof CAMPOS_PIX)[number], string | null>;

const recebedorPix = (l: Partial<RecebedorPix>): RecebedorPix => ({
  chavePix: l.chavePix ?? null,
  pixNomeRecebedor: l.pixNomeRecebedor ?? null,
  pixCidadeRecebedor: l.pixCidadeRecebedor ?? null,
});

/** `true` se o recebedor muda; sem `lojas.editar_pix`, recusa antes de gravar. */
function conferirRecebedorPix(sessao: SessaoErp, antes: RecebedorPix, depois: RecebedorPix): boolean {
  const muda = CAMPOS_PIX.some((c) => antes[c] !== depois[c]);
  if (muda && !sessao.permissoes.has('lojas.editar_pix'))
    throw ErroApi.semPermissao(
      'Só quem tem "Lojas: Alterar o recebedor do PIX" troca a chave, o nome ou a cidade do PIX da loja.',
    );
  return muda;
}

type LinhaLoja = typeof lojas.$inferSelect;

const sqlCaixasAtivos = sql<number>`(select count(*)::int from caixas c where c.loja_id = ${ref('lojas')} and c.ativo and not c.sistema and c.excluido_em is null)`;

const colunasOrdenacao = {
  codigo: lojas.codigo,
  nome: sql`lower(${lojas.nome})`,
  cnpj: lojas.cnpj,
  tipo: lojas.tipo,
  ordem: lojas.ordem,
  ativa: lojas.ativa,
};

/** Lojas (ERP 10.3): Dados Gerais, Fiscal (colunas da loja) e Caixas; criar = assistente da primeira configuração (MD 7.13). */
@Controller('lojas')
export class LojasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('lojas.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<LojaResumo>> {
    const q = validar(filtroLojasSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const busca = contem(q.nome);
    const onde = and(
      isNull(lojas.excluidoEm),
      filtroLojas(sessao, lojas.id),
      q.situacao === 'ativos'
        ? eq(lojas.ativa, true)
        : q.situacao === 'inativos'
          ? eq(lojas.ativa, false)
          : undefined,
      busca
        ? or(
            sql`fn_unaccent(${lojas.nome}) ilike fn_unaccent(${busca})`,
            ilike(lojas.nomeFantasia, busca),
            ilike(lojas.cnpj, busca.replace(/[./-]/g, '')),
          )
        : undefined,
    );
    const ordem = ordemDaQuery(q, colunasOrdenacao, 'ordem:asc', lojas.codigo);
    return this.s.tenancy.cx().consulta(async (db) => {
      const itens = await db
        .select({
          id: lojas.id,
          codigo: lojas.codigo,
          nome: lojas.nome,
          tipo: lojas.tipo,
          cnpj: lojas.cnpj,
          estoqueId: lojas.estoqueId,
          estoqueNome: estoques.nome,
          caixasAtivos: sqlCaixasAtivos,
          ativa: lojas.ativa,
          versao: lojas.versao,
        })
        .from(lojas)
        .leftJoin(estoques, eq(estoques.id, lojas.estoqueId))
        .where(onde)
        .orderBy(...ordem)
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(lojas).where(onde);
      return {
        itens: itens as LojaResumo[],
        total: total?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }

  @Permissao('lojas.ver')
  @Get(':id')
  async obter(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<LojaDetalhe> {
    const lojaId = validar(z.uuid(), id);
    garantirLoja(sessao, lojaId);
    const d = await this.s.tenancy.cx().consulta((db) => detalheLoja(db, lojaId));
    if (!d) throw ErroApi.naoEncontrado('Loja não encontrada.');
    return d;
  }

  @Permissao('lojas.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<LojaDetalhe> {
    const { estoqueId: estoqueEscolhido, nomeEstoque, ...dados } = validar(criarLojaSchema, corpo);
    const comPix = conferirRecebedorPix(sessao, recebedorPix({}), recebedorPix(dados));
    if (dados.ativa) await this.garantirLimitePlano(sessao, null);
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        await garantirMunicipio(tx, dados.municipioIbge, dados.uf);
        await this.garantirUnicos(tx, dados);
        // Assistente (MD 7.13): estoque homônimo (ou o escolhido), caixa 0, conta "Caixa – loja", numerações.
        let estoqueId = estoqueEscolhido;
        let estoqueCriado: string | null = null;
        if (estoqueId) {
          garantirEstoquePermitido(sessao, estoqueId, 'ver', MENSAGEM_ESTOQUE_FORA);
          await this.garantirEstoqueLivre(tx, estoqueId, null);
        } else {
          const nome = nomeEstoque ?? dados.nome;
          const [dup] = await tx
            .select({ id: estoques.id })
            .from(estoques)
            .where(and(isNull(estoques.excluidoEm), sql`lower(${estoques.nome}) = lower(${nome})`));
          if (dup)
            garantirSemConflito({
              nomeEstoque: ['Já existe um local de estoque com este nome; escolha-o ou mude o nome'],
            });
          const [e] = await tx
            .insert(estoques)
            .values({
              nome,
              tipo: dados.tipo === 'deposito' ? 'deposito' : 'loja',
              criadoPorId: sessao.usuarioId,
              atualizadoPorId: sessao.usuarioId,
            })
            .returning({ id: estoques.id });
          estoqueId = e!.id;
          estoqueCriado = e!.id;
        }
        const codigo = await this.proximoCodigo(tx);
        const [loja] = await tx
          .insert(lojas)
          .values({
            ...dados,
            codigo,
            estoqueId: estoqueId!,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning();
        const [caixa0] = await tx
          .insert(caixas)
          .values({
            lojaId: loja!.id,
            numero: 0,
            sistema: true,
            descricao: 'Vendas do ERP',
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning({ id: caixas.id });
        const [conta] = await tx
          .insert(contasCorrentes)
          .values({
            tipo: 'caixa',
            descricao: await this.descricaoContaCaixa(tx, loja!.nome),
            lojaId: loja!.id,
            chaveSistema: `caixa_loja:${loja!.id}`,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning({ id: contasCorrentes.id });
        await garantirNumeracoesLoja(tx, loja!.id);
        // Quem criou sem ver todos os estoques passa a ter o estoque da loja (decisão 149), como a loja abaixo.
        await concederEstoqueAoCriador(tx, sessao, estoqueId!);
        // Quem criou sem ser Master passa a enxergar a loja (senão ela some da própria listagem).
        if (!sessao.master) {
          await tx.insert(usuariosLojas).values({
            usuarioId: sessao.usuarioId,
            lojaId: loja!.id,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          });
          await tx
            .update(usuarios)
            .set({ permissoesVersao: sql`${usuarios.permissoesVersao} + 1` })
            .where(eq(usuarios.id, sessao.usuarioId));
        }
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'lojas',
          registroId: loja!.id,
          lojaId: loja!.id,
          localizacao: LOCALIZACAO,
          descricao: 'Assistente: loja, caixa 0, conta "Caixa – loja" e numerações',
          depois: { ...loja, estoqueCriadoId: estoqueCriado, caixa0Id: caixa0!.id, contaCaixaId: conta!.id },
        });
        if (comPix)
          await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
            acao: 'pix_recebedor_alterado',
            entidade: 'lojas',
            registroId: loja!.id,
            lojaId: loja!.id,
            localizacao: LOCALIZACAO,
            descricao: 'Recebedor do PIX da loja cadastrado',
            depois: recebedorPix(loja!),
          });
        return loja!.id;
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalheLoja(db, id)))!;
  }

  @Permissao('lojas.editar')
  @Put(':id')
  async alterar(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<LojaDetalhe> {
    const lojaId = validar(z.uuid(), id);
    garantirLoja(sessao, lojaId);
    const { versao, ...dados } = validar(alterarLojaSchema, corpo);
    const [atual] = await this.s.tenancy
      .cx()
      .consulta((db) => db.select({ ativa: lojas.ativa }).from(lojas).where(eq(lojas.id, lojaId)));
    if (atual && !atual.ativa && dados.ativa) await this.garantirLimitePlano(sessao, lojaId);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, lojaId);
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        const trocaPix = conferirRecebedorPix(sessao, recebedorPix(antes), recebedorPix(dados));
        await garantirMunicipio(tx, dados.municipioIbge, dados.uf);
        await this.garantirUnicos(tx, dados, lojaId);
        if (dados.estoqueId !== antes.estoqueId) {
          garantirEstoquePermitido(sessao, dados.estoqueId, 'ver', MENSAGEM_ESTOQUE_FORA);
          await this.garantirEstoqueLivre(tx, dados.estoqueId, lojaId);
        }
        if (antes.ativa && !dados.ativa) await this.garantirSemTerminal(tx, lojaId, 'inativar');
        if (dados.tipo === 'deposito' && antes.tipo !== 'deposito') {
          const [c] = await tx
            .select({ n: count() })
            .from(caixas)
            .where(and(eq(caixas.lojaId, lojaId), eq(caixas.sistema, false), isNull(caixas.excluidoEm)));
          if ((c?.n ?? 0) > 0) {
            throw new ErroApi('REGRA_NEGOCIO', 'Depósito/CD não tem caixas de PDV: exclua os caixas antes.', {
              campos: { tipo: ['A loja tem caixas de PDV'] },
            });
          }
        }
        const [depois] = await tx
          .update(lojas)
          .set({ ...dados, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(lojas.id, lojaId), eq(lojas.versao, versao)))
          .returning();
        if (!depois) await conflitoVersao(tx, antes);
        await garantirNumeracoesLoja(tx, lojaId);
        await ressincronizarFluxosDaLoja(tx, lojaId, fluxosAfetados(antes, depois!), sessao.usuarioId);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'lojas',
          registroId: lojaId,
          lojaId,
          localizacao: LOCALIZACAO,
          antes,
          depois,
        });
        if (trocaPix)
          await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
            acao: 'pix_recebedor_alterado',
            entidade: 'lojas',
            registroId: lojaId,
            lojaId,
            localizacao: LOCALIZACAO,
            descricao: 'Recebedor do PIX da loja alterado',
            antes: recebedorPix(antes),
            depois: recebedorPix(depois!),
          });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalheLoja(db, lojaId)))!;
  }

  /**
   * Exclusão lógica (sem terminal na loja): caixas e numerações saem junto, e também os vínculos das formas de
   * pagamento com a loja (C8b). A forma que só valia nesta loja é excluída com ela: sem vínculo vivo ela não valeria em
   * loja nenhuma, mas o ERP a mostraria como "todas" (lista de lojas vazia).
   */
  @Permissao('lojas.excluir')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') id: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const lojaId = validar(z.uuid(), id);
    garantirLoja(sessao, lojaId);
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, lojaId);
        await this.garantirSemTerminal(tx, lojaId, 'excluir');
        const agora = new Date();
        await tx
          .update(lojas)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(eq(lojas.id, lojaId));
        await tx
          .update(caixas)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(caixas.lojaId, lojaId), isNull(caixas.excluidoEm)));
        await tx
          .update(numeracoes)
          .set({ excluidoEm: agora })
          .where(and(eq(numeracoes.lojaId, lojaId), isNull(numeracoes.excluidoEm)));
        const vinculos = await tx
          .update(formasPagamentoLojas)
          .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(formasPagamentoLojas.lojaId, lojaId), isNull(formasPagamentoLojas.excluidoEm)))
          .returning({ formaId: formasPagamentoLojas.formaPagamentoId });
        const formasSemLoja = vinculos.length
          ? await tx
              .update(formasPagamento)
              .set({ excluidoEm: agora, atualizadoPorId: sessao.usuarioId })
              .where(
                and(
                  inArray(
                    formasPagamento.id,
                    vinculos.map((v) => v.formaId),
                  ),
                  isNull(formasPagamento.excluidoEm),
                  // Qualificado à mão: no update o Drizzle escreve `"id"`, que na subconsulta seria o do vínculo.
                  sql`not exists (select 1 from formas_pagamento_lojas fl
                    where fl.forma_pagamento_id = ${sql.raw('formas_pagamento.id')} and fl.excluido_em is null)`,
                ),
              )
              .returning()
          : [];
        for (const f of formasSemLoja) {
          await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
            acao: 'excluir',
            entidade: 'formas_pagamento',
            registroId: f.id,
            lojaId,
            localizacao: 'Cadastros › Formas de pagamento',
            antes: { ...f, excluidoEm: null, lojaIds: [lojaId] },
            descricao: 'Excluída com a loja, a única em que valia.',
          });
        }
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'lojas',
          registroId: lojaId,
          lojaId,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }

  /** ERP 10.3: criar ou reativar loja além do limite do plano → `LIMITE_PLANO`. */
  private async garantirLimitePlano(sessao: SessaoErp, exceto: string | null): Promise<void> {
    const [e] = await this.s.controle.db
      .select({ limite: sql<number | null>`coalesce(${empresas.limiteLojas}, ${planos.limiteLojas})` })
      .from(empresas)
      .leftJoin(planos, eq(planos.id, empresas.planoId))
      .where(eq(empresas.id, sessao.empresa.empresaId));
    const limite = e?.limite ?? null;
    if (limite === null) return;
    const [n] = await this.s.tenancy.cx().consulta((db) =>
      db
        .select({ n: count() })
        .from(lojas)
        .where(
          and(isNull(lojas.excluidoEm), eq(lojas.ativa, true), exceto ? ne(lojas.id, exceto) : undefined),
        ),
    );
    if ((n?.n ?? 0) >= limite) {
      throw new ErroApi(
        'LIMITE_PLANO',
        `Seu plano permite ${limite} loja${limite === 1 ? '' : 's'} ativa${limite === 1 ? '' : 's'}. Fale com a Genesis para ampliar.`,
      );
    }
  }

  private async travar(tx: DbEmpresa, lojaId: string): Promise<LinhaLoja> {
    const [l] = await tx
      .select()
      .from(lojas)
      .where(and(eq(lojas.id, lojaId), isNull(lojas.excluidoEm)))
      .for('update');
    if (!l) throw ErroApi.naoEncontrado('Loja não encontrada.');
    return l;
  }

  /** Código 1–99 (compõe o número das vendas, ERP 10.3.1): o seguinte ao maior já usado; esgotado, o primeiro livre. */
  private async proximoCodigo(tx: DbEmpresa): Promise<number> {
    const [m] = await tx.select({ m: max(lojas.codigo) }).from(lojas);
    const proximo = (m?.m ?? 0) + 1;
    if (proximo <= 99) return proximo;
    const usados = new Set(
      (await tx.select({ c: lojas.codigo }).from(lojas).where(isNull(lojas.excluidoEm))).map((l) => l.c),
    );
    for (let c = 1; c <= 99; c++) if (!usados.has(c)) return c;
    throw new ErroApi('REGRA_NEGOCIO', 'A empresa já tem 99 lojas.');
  }

  private async descricaoContaCaixa(tx: DbEmpresa, nome: string): Promise<string> {
    const base = `Caixa – ${nome}`.slice(0, 60);
    for (let i = 1; ; i++) {
      const d = i === 1 ? base : `${base.slice(0, 55)} (${i})`;
      const [dup] = await tx
        .select({ id: contasCorrentes.id })
        .from(contasCorrentes)
        .where(
          and(isNull(contasCorrentes.excluidoEm), sql`lower(${contasCorrentes.descricao}) = lower(${d})`),
        );
      if (!dup) return d;
    }
  }

  private async garantirEstoqueLivre(tx: DbEmpresa, estoqueId: string, exceto: string | null): Promise<void> {
    const [e] = await tx
      .select({ id: estoques.id, ativo: estoques.ativo })
      .from(estoques)
      .where(and(eq(estoques.id, estoqueId), isNull(estoques.excluidoEm)));
    if (!e)
      throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
        campos: { estoqueId: ['Estoque inexistente'] },
      });
    if (!e.ativo)
      throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
        campos: { estoqueId: ['Estoque inativo'] },
      });
    const [outra] = await tx
      .select({ nome: lojas.nome })
      .from(lojas)
      .where(
        and(
          eq(lojas.estoqueId, estoqueId),
          isNull(lojas.excluidoEm),
          exceto ? ne(lojas.id, exceto) : undefined,
        ),
      );
    if (outra) garantirSemConflito({ estoqueId: [`Estoque já vinculado à loja ${outra.nome}`] });
  }

  private async garantirSemTerminal(tx: DbEmpresa, lojaId: string, acao: string): Promise<void> {
    const [t] = await tx
      .select({ n: count() })
      .from(terminais)
      .where(
        and(
          eq(terminais.lojaId, lojaId),
          inArray(terminais.status, ['ativo', 'desativando']),
          isNull(terminais.excluidoEm),
        ),
      );
    if ((t?.n ?? 0) > 0) {
      throw new ErroApi(
        'REGRA_NEGOCIO',
        `Não é possível ${acao} a loja com terminal PDV ativo. Revogue os terminais antes.`,
      );
    }
  }

  private async garantirUnicos(
    tx: DbEmpresa,
    d: Pick<CriarLoja & AlterarLoja, 'nome' | 'cnpj' | 'chavePublica'>,
    exceto?: string,
  ): Promise<void> {
    const vivas = and(isNull(lojas.excluidoEm), exceto ? ne(lojas.id, exceto) : undefined);
    const campos: Record<string, string[]> = {};
    const [nome] = await tx
      .select({ id: lojas.id })
      .from(lojas)
      .where(and(vivas, sql`lower(${lojas.nome}) = lower(${d.nome})`));
    if (nome) campos.nome = ['Já existe uma loja com este nome'];
    const [cnpj] = await tx
      .select({ id: lojas.id })
      .from(lojas)
      .where(and(vivas, eq(lojas.cnpj, d.cnpj)));
    if (cnpj) campos.cnpj = ['Já existe uma loja com este CNPJ'];
    if (d.chavePublica) {
      const [ch] = await tx
        .select({ id: lojas.id })
        .from(lojas)
        .where(and(vivas, eq(lojas.chavePublica, d.chavePublica)));
      if (ch) campos.chavePublica = ['Chave já usada por outra loja'];
    }
    garantirSemConflito(campos, 'Já existe uma loja com estes dados.');
  }
}

export async function detalheLoja(db: DbEmpresa, lojaId: string): Promise<LojaDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [r] = await db
    .select({ l: lojas, estoqueNome: estoques.nome, municipioNome: municipios.nome, autorNome: autor.nome })
    .from(lojas)
    .leftJoin(estoques, eq(estoques.id, lojas.estoqueId))
    .leftJoin(municipios, eq(municipios.codigoIbge, lojas.municipioIbge))
    .leftJoin(autor, eq(autor.id, lojas.atualizadoPorId))
    .where(and(eq(lojas.id, lojaId), isNull(lojas.excluidoEm)));
  if (!r) return null;
  const l = r.l;
  const [conta] = await db
    .select({ id: contasCorrentes.id })
    .from(contasCorrentes)
    .where(and(eq(contasCorrentes.chaveSistema, `caixa_loja:${lojaId}`), isNull(contasCorrentes.excluidoEm)));
  const [nfe] =
    l.nfeSerie !== null
      ? await db
          .select({ n: numeracoes.ultimoNumero })
          .from(numeracoes)
          .where(
            and(
              eq(numeracoes.lojaId, lojaId),
              eq(numeracoes.tipo, 'nfe'),
              eq(numeracoes.serie, l.nfeSerie),
              eq(numeracoes.ambiente, l.nfceAmbiente),
              isNull(numeracoes.excluidoEm),
            ),
          )
      : [];
  return {
    ...metadados(l, r.autorNome),
    codigo: l.codigo,
    nome: l.nome,
    tipo: l.tipo as LojaDetalhe['tipo'],
    razaoSocial: l.razaoSocial,
    nomeFantasia: l.nomeFantasia,
    cnpj: l.cnpj,
    ie: l.ie,
    inscricaoMunicipal: l.inscricaoMunicipal,
    telefone: l.telefone,
    celular: l.celular,
    email: l.email,
    estoqueId: l.estoqueId,
    estoqueNome: r.estoqueNome,
    cep: l.cep,
    logradouro: l.logradouro,
    numero: l.numero,
    complemento: l.complemento,
    bairro: l.bairro,
    uf: l.uf,
    municipioIbge: l.municipioIbge,
    municipioNome: r.municipioNome,
    fusoHorario: l.fusoHorario,
    fraseRodapeCupom: l.fraseRodapeCupom,
    ordem: l.ordem,
    ativa: l.ativa,
    usaPdv: l.usaPdv,
    usaMenuDigital: l.usaMenuDigital,
    treino: l.treino,
    chavePublica: l.chavePublica,
    chavePix: l.chavePix,
    pixNomeRecebedor: l.pixNomeRecebedor,
    pixCidadeRecebedor: l.pixCidadeRecebedor,
    regime: l.regime as LojaDetalhe['regime'],
    tipoEmissao: l.tipoEmissao as LojaDetalhe['tipoEmissao'],
    nfceAmbiente: l.nfceAmbiente as 1 | 2,
    nfeSerie: l.nfeSerie,
    nfcePrazoCancelamentoMin: l.nfcePrazoCancelamentoMin,
    nfceValorExigeIdentificacao: l.nfceValorExigeIdentificacao,
    logotipoArquivoId: l.logotipoArquivoId,
    fotoArquivoId: l.fotoArquivoId,
    contaCaixaId: conta?.id ?? null,
    nfeProximoNumero: nfe ? nfe.n + 1 : null,
  };
}
