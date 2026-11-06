import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarFormaPagamentoSchema,
  criarFormaPagamentoSchema,
  filtroFormasPagamentoSchema,
  limiteDeslocamento,
  type FormaPagamentoDetalhe,
  type FormaPagamentoResumo,
  type OpcoesFormaPagamento,
  type Pagina,
} from '@genesis/shared';
import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { garantirLoja, lojaPermitida } from '../autorizacao/lojas.js';
import { conflitoVersao, contem, garantirSemConflito, metadados, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import {
  contasCorrentes,
  formasPagamento,
  formasPagamentoLojas,
  lojas,
  meiosPagamentoFiscais,
  planosContas,
  usuarios,
} from '../database/empresa/schema/index.js';
import { garantirLimiteHash, gerarHashSenha } from '../seguranca/senhas.js';
import type { Servicos } from '../servicos.js';
import { tocar } from '../sync/toque.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const LOCALIZACAO = 'Cadastros › Formas de pagamento';

type LinhaForma = typeof formasPagamento.$inferSelect;
type DadosForma = z.output<typeof criarFormaPagamentoSchema>;
type CamposGravados = Omit<DadosForma, 'senhaLiberacao' | 'removerSenhaLiberacao' | 'lojaIds'>;

const colunasOrdenacao = {
  descricao: sql`lower(${formasPagamento.descricao})`,
  ordem: formasPagamento.ordem,
  tipo_forma: formasPagamento.tipoForma,
  ativa: formasPagamento.ativa,
};

/**
 * `formas_pagamento.id` qualificado à mão: numa consulta de uma tabela só o Drizzle escreve a coluna sem a tabela
 * (`"id"`), e dentro das subconsultas abaixo ela seria a do vínculo ou a da loja.
 */
const idDaForma = sql.raw('formas_pagamento.id');

const listaUuid = (ids: readonly string[]) =>
  sql.join(
    ids.map((l) => sql`${l}::uuid`),
    sql`, `,
  );

/**
 * A forma vale em "todas" (vínculo de loja nula) ou numa das `lojaIds` (C8b, MD 3.10.1): `exists` sobre os vínculos
 * vivos de `formas_pagamento_lojas`.
 */
function valeEmAlguma(lojaIds: readonly string[] | null) {
  const lojaCond = lojaIds?.length ? sql` or fl.loja_id in (${listaUuid(lojaIds)})` : sql``;
  return sql`exists (select 1 from formas_pagamento_lojas fl where fl.forma_pagamento_id = ${idDaForma}
    and fl.excluido_em is null and (fl.loja_id is null${lojaCond}))`;
}

/** Formas que valem numa loja permitida ou em todas as lojas, ERP 2.1/10.2. */
function filtroLojaForma(sessao: SessaoErp) {
  if (sessao.lojas === null) return undefined;
  return valeEmAlguma(sessao.lojas);
}

/** Lojas dos vínculos vivos da forma (vazio = todas), na ordem do código da loja. */
const lojasDaForma = sql<FormaPagamentoResumo['lojas']>`coalesce((
  select json_agg(json_build_object('id', l.id, 'codigo', l.codigo, 'nome', l.nome) order by l.codigo)
    from formas_pagamento_lojas fl join lojas l on l.id = fl.loja_id
   where fl.forma_pagamento_id = ${idDaForma} and fl.excluido_em is null), '[]'::json)`;

/** Formas de pagamento (ERP 10.2; MD 3.10.1), com todas as flags do MVP e a senha de liberação (argon2id). */
@Controller('formas-pagamento')
export class FormasPagamentoController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('formas_pagamento.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<FormaPagamentoResumo>> {
    const q = validar(filtroFormasPagamentoSchema, query);
    if (q.lojaId) garantirLoja(sessao, q.lojaId);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const busca = contem(q.descricao);
    const onde = and(
      isNull(formasPagamento.excluidoEm),
      filtroLojaForma(sessao),
      q.lojaId ? valeEmAlguma([q.lojaId]) : undefined,
      q.situacao === 'ativos'
        ? eq(formasPagamento.ativa, true)
        : q.situacao === 'inativos'
          ? eq(formasPagamento.ativa, false)
          : undefined,
      q.uso === 'pdv' ? eq(formasPagamento.usaPdv, true) : undefined,
      q.uso === 'totem' ? eq(formasPagamento.usaTotem, true) : undefined,
      q.uso === 'menu_digital' ? eq(formasPagamento.usaMenuDigital, true) : undefined,
      busca ? sql`fn_unaccent(${formasPagamento.descricao}) ilike fn_unaccent(${busca})` : undefined,
    );
    return this.s.tenancy.cx().consulta(async (db) => {
      const itens = await db
        .select({
          id: formasPagamento.id,
          descricao: formasPagamento.descricao,
          ordem: formasPagamento.ordem,
          tipoForma: formasPagamento.tipoForma,
          usaPdv: formasPagamento.usaPdv,
          usaTotem: formasPagamento.usaTotem,
          usaMenuDigital: formasPagamento.usaMenuDigital,
          lojas: lojasDaForma,
          ativa: formasPagamento.ativa,
          versao: formasPagamento.versao,
        })
        .from(formasPagamento)
        .where(onde)
        .orderBy(...ordemDaQuery(q, colunasOrdenacao, 'ordem:asc', formasPagamento.descricao))
        .limit(limite)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(formasPagamento).where(onde);
      return {
        itens: itens as FormaPagamentoResumo[],
        total: total?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }

  /** Opções dos seletores (meios fiscais, contas correntes e planos de contas analíticos). */
  @Permissao('formas_pagamento.ver')
  @Get('opcoes')
  async opcoes(@Sessao() sessao: SessaoErp): Promise<OpcoesFormaPagamento> {
    return this.s.tenancy.cx().consulta(async (db) => {
      const meiosFiscais = await db
        .select({
          codigo: meiosPagamentoFiscais.codigo,
          descricao: meiosPagamentoFiscais.descricao,
          ativo: meiosPagamentoFiscais.ativo,
        })
        .from(meiosPagamentoFiscais)
        .where(isNull(meiosPagamentoFiscais.excluidoEm))
        .orderBy(asc(meiosPagamentoFiscais.codigo));
      const contas = await db
        .select({
          id: contasCorrentes.id,
          descricao: contasCorrentes.descricao,
          lojaId: contasCorrentes.lojaId,
        })
        .from(contasCorrentes)
        .where(and(isNull(contasCorrentes.excluidoEm), eq(contasCorrentes.ativa, true)))
        .orderBy(asc(contasCorrentes.descricao));
      const planos = await db
        .select({
          id: planosContas.id,
          codigo: planosContas.codigo,
          nome: planosContas.nome,
          tipo: planosContas.tipo,
        })
        .from(planosContas)
        .where(
          and(
            isNull(planosContas.excluidoEm),
            eq(planosContas.ativo, true),
            eq(planosContas.natureza, 'analitica'),
          ),
        )
        .orderBy(asc(planosContas.codigo));
      return {
        meiosFiscais,
        contasCorrentes: contas.filter((c) => lojaPermitida(sessao, c.lojaId) || c.lojaId === null),
        planosContas: planos,
      };
    });
  }

  @Permissao('formas_pagamento.ver')
  @Get(':id')
  async obter(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<FormaPagamentoDetalhe> {
    const formaId = validar(z.uuid(), id);
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db, formaId, sessao));
    if (!d) throw ErroApi.naoEncontrado('Forma de pagamento não encontrada.');
    return d;
  }

  @Permissao('formas_pagamento.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<FormaPagamentoDetalhe> {
    const {
      senhaLiberacao,
      removerSenhaLiberacao: _r,
      lojaIds,
      ...dados
    } = validar(criarFormaPagamentoSchema, corpo);
    for (const l of lojaIds) garantirLoja(sessao, l);
    if (senhaLiberacao) garantirLimiteHash(`${sessao.empresa.empresaId}:${sessao.usuarioId}`);
    const senhaLiberacaoHash = senhaLiberacao ? await gerarHashSenha(senhaLiberacao) : null;
    const id = await this.s.tenancy.cx().transacao(
      async (tx) => {
        await validarReferencias(tx, dados, lojaIds, null);
        const [f] = await tx
          .insert(formasPagamento)
          .values({
            ...dados,
            senhaLiberacaoHash,
            criadoPorId: sessao.usuarioId,
            atualizadoPorId: sessao.usuarioId,
          })
          .returning();
        await gravarLojas(tx, sessao, f!.id, null, lojaIds);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'formas_pagamento',
          registroId: f!.id,
          lojaId: lojaIds.length === 1 ? lojaIds[0]! : null,
          localizacao: LOCALIZACAO,
          depois: { ...f, lojaIds },
        });
        return f!.id;
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id, sessao)))!;
  }

  @Permissao('formas_pagamento.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<FormaPagamentoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, senhaLiberacao, removerSenhaLiberacao, lojaIds, ...dados } = validar(
      alterarFormaPagamentoSchema,
      corpo,
    );
    for (const l of lojaIds) garantirLoja(sessao, l);
    if (senhaLiberacao) garantirLimiteHash(`${sessao.empresa.empresaId}:${sessao.usuarioId}`);
    const novoHash = senhaLiberacao ? await gerarHashSenha(senhaLiberacao) : undefined;
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const { forma: antes, lojaIds: lojasAntes } = await travar(tx, id, sessao);
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        await validarReferencias(tx, dados, lojaIds, antes);
        const [depois] = await tx
          .update(formasPagamento)
          .set({
            ...dados,
            ...(novoHash
              ? { senhaLiberacaoHash: novoHash }
              : removerSenhaLiberacao
                ? { senhaLiberacaoHash: null }
                : {}),
            atualizadoPorId: sessao.usuarioId,
          })
          .where(and(eq(formasPagamento.id, id), eq(formasPagamento.versao, versao)))
          .returning();
        if (!depois) await conflitoVersao(tx, antes);
        await gravarLojas(tx, sessao, id, lojasAntes, lojaIds);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'formas_pagamento',
          registroId: id,
          lojaId: lojaIds.length === 1 ? lojaIds[0]! : null,
          localizacao: LOCALIZACAO,
          antes: { ...antes, lojaIds: lojasAntes },
          depois: { ...depois, lojaIds },
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => detalhe(db, id, sessao)))!;
  }

  /**
   * Exclusão lógica e livre (ERP 10.2): os vínculos de loja ficam, para a exclusão descer pelo filtro do pull aos caixas
   * que tinham a forma. A venda já gravada guarda o snapshot da forma (descrição e tipo); "com vendas, só inativar" fica
   * para as consultas de venda (C12).
   */
  @Permissao('formas_pagamento.excluir')
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
        const { forma: antes, lojaIds } = await travar(tx, id, sessao);
        await tx
          .update(formasPagamento)
          .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
          .where(eq(formasPagamento.id, id));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'formas_pagamento',
          registroId: id,
          lojaId: lojaIds.length === 1 ? lojaIds[0]! : null,
          localizacao: LOCALIZACAO,
          antes: { ...antes, lojaIds },
        });
      },
      { travaVersao: true },
    );
  }
}

/**
 * Trava a forma para editar ou excluir. Quem tem só algumas lojas edita a forma de "todas" (como antes da 1C) e a das
 * suas lojas; a que também vale numa loja que ele não enxerga é só leitura para ele (403), para não tirar dela, sem ver,
 * uma loja alheia.
 */
async function travar(
  tx: DbEmpresa,
  id: string,
  sessao: SessaoErp,
): Promise<{ forma: LinhaForma; lojaIds: string[] }> {
  const [f] = await tx
    .select()
    .from(formasPagamento)
    .where(and(eq(formasPagamento.id, id), isNull(formasPagamento.excluidoEm)))
    .for('update');
  if (!f) throw ErroApi.naoEncontrado('Forma de pagamento não encontrada.');
  const lojaIds = await lojasVivas(tx, id);
  for (const l of lojaIds) garantirLoja(sessao, l);
  return { forma: f, lojaIds };
}

/** Lojas dos vínculos vivos (vazio = só o vínculo de "todas", ou nenhum). */
async function lojasVivas(db: DbEmpresa, formaId: string): Promise<string[]> {
  const linhas = await db
    .select({ lojaId: formasPagamentoLojas.lojaId })
    .from(formasPagamentoLojas)
    .where(and(eq(formasPagamentoLojas.formaPagamentoId, formaId), isNull(formasPagamentoLojas.excluidoEm)));
  return linhas.flatMap((l) => (l.lojaId ? [l.lojaId] : []));
}

/**
 * Grava as lojas da forma (`antes` nulo = forma nova): vazio = um vínculo de loja nula ("todas"). Exclui os vínculos
 * que saíram (a exclusão desce aos caixas dessas lojas), cria os que entraram e toca a forma (`sync/toque.ts`): sem
 * isso a forma, com versão antiga, não desceria ao caixa da loja que acabou de ganhar.
 */
async function gravarLojas(
  tx: DbEmpresa,
  sessao: SessaoErp,
  formaId: string,
  antes: readonly string[] | null,
  depois: readonly string[],
): Promise<void> {
  const chave = (l: string | null) => l ?? 'todas';
  const de = antes === null ? [] : antes.length ? antes : [null];
  const para: (string | null)[] = depois.length ? [...depois] : [null];
  const sair = de.filter((l) => !para.map(chave).includes(chave(l)));
  const entrar = para.filter((l) => !de.map(chave).includes(chave(l)));
  if (!sair.length && !entrar.length) return;
  if (sair.length) {
    const lojasSair = sair.filter((l): l is string => l !== null);
    await tx
      .update(formasPagamentoLojas)
      .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
      .where(
        and(
          eq(formasPagamentoLojas.formaPagamentoId, formaId),
          isNull(formasPagamentoLojas.excluidoEm),
          sair.includes(null)
            ? lojasSair.length
              ? sql`(${formasPagamentoLojas.lojaId} is null or ${inArray(formasPagamentoLojas.lojaId, lojasSair)})`
              : isNull(formasPagamentoLojas.lojaId)
            : inArray(formasPagamentoLojas.lojaId, lojasSair),
        ),
      );
  }
  if (entrar.length) {
    await tx.insert(formasPagamentoLojas).values(
      entrar.map((lojaId) => ({
        formaPagamentoId: formaId,
        lojaId,
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      })),
    );
  }
  if (antes !== null) await tocar(tx, 'formas_pagamento', 'id', [formaId]);
}

/**
 * Meio fiscal ativo (forma nova ou com o código trocado), lojas da forma existentes e não excluídas, conta, plano e
 * descrição única na empresa (0014; era por loja).
 */
async function validarReferencias(
  tx: DbEmpresa,
  d: CamposGravados,
  lojaIds: readonly string[],
  antes: LinhaForma | null,
): Promise<void> {
  const campos: Record<string, string[]> = {};
  const [meio] = await tx
    .select()
    .from(meiosPagamentoFiscais)
    .where(eq(meiosPagamentoFiscais.codigo, d.meioPagamentoFiscal));
  if (!meio) campos.meioPagamentoFiscal = ['Meio de pagamento fiscal inexistente'];
  else if (!meio.ativo && antes?.meioPagamentoFiscal !== d.meioPagamentoFiscal) {
    campos.meioPagamentoFiscal = ['Código não vale mais para a NFC-e; escolha outro'];
  }
  if (lojaIds.length) {
    const existentes = await tx
      .select({ id: lojas.id })
      .from(lojas)
      .where(and(inArray(lojas.id, [...lojaIds]), isNull(lojas.excluidoEm)));
    if (existentes.length !== lojaIds.length) campos.lojaIds = ['Loja inexistente ou excluída'];
  }
  if (d.contaCorrenteId) {
    const [c] = await tx
      .select({ id: contasCorrentes.id })
      .from(contasCorrentes)
      .where(and(eq(contasCorrentes.id, d.contaCorrenteId), isNull(contasCorrentes.excluidoEm)));
    if (!c) campos.contaCorrenteId = ['Conta corrente inexistente'];
  }
  if (d.planoContasId) {
    const [p] = await tx
      .select({ tipo: planosContas.tipo, natureza: planosContas.natureza })
      .from(planosContas)
      .where(and(eq(planosContas.id, d.planoContasId), isNull(planosContas.excluidoEm)));
    if (!p) campos.planoContasId = ['Plano de contas inexistente'];
    else if (p.natureza !== 'analitica') campos.planoContasId = ['Escolha uma conta analítica'];
    else if (d.tipoForma === 'consumo_interno' && p.tipo !== 'despesa')
      campos.planoContasId = ['Consumo interno lança em conta de despesa'];
    else if (d.tipoForma !== 'consumo_interno' && p.tipo !== 'receita')
      campos.planoContasId = ['Escolha uma conta de receita'];
  }
  if (Object.keys(campos).length)
    throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', { campos });
  const [dup] = await tx
    .select({ id: formasPagamento.id })
    .from(formasPagamento)
    .where(
      and(
        isNull(formasPagamento.excluidoEm),
        sql`lower(${formasPagamento.descricao}) = lower(${d.descricao})`,
        antes ? ne(formasPagamento.id, antes.id) : undefined,
      ),
    );
  // Única na empresa (0014): a forma vale em várias lojas e o fechamento por forma agrupa pelo nome.
  if (dup) garantirSemConflito({ descricao: ['Já existe uma forma com esta descrição'] });
}

async function detalhe(db: DbEmpresa, id: string, sessao: SessaoErp): Promise<FormaPagamentoDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [r] = await db
    .select({ f: formasPagamento, autorNome: autor.nome })
    .from(formasPagamento)
    .leftJoin(autor, eq(autor.id, formasPagamento.atualizadoPorId))
    .where(and(eq(formasPagamento.id, id), isNull(formasPagamento.excluidoEm)));
  if (!r) return null;
  const lojaIds = await lojasVivas(db, id);
  if (lojaIds.length && !lojaIds.some((l) => lojaPermitida(sessao, l)))
    throw ErroApi.semPermissao('Você não tem acesso a esta loja.');
  const {
    senhaLiberacaoHash,
    id: _id,
    versao: _v,
    criadoEm: _c,
    atualizadoEm: _a,
    excluidoEm: _e,
    criadoPorId: _cp,
    atualizadoPorId: _ap,
    ...f
  } = r.f;
  return {
    ...metadados(r.f, r.autorNome),
    ...(f as unknown as Omit<
      FormaPagamentoDetalhe,
      | 'senhaLiberacaoDefinida'
      | 'lojaIds'
      | 'id'
      | 'versao'
      | 'criadoEm'
      | 'atualizadoEm'
      | 'atualizadoPorNome'
    >),
    lojaIds,
    senhaLiberacaoDefinida: senhaLiberacaoHash !== null,
  };
}
