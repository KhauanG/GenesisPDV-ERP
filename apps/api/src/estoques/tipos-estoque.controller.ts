import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import {
  alterarTipoEstoqueSchema,
  criarTipoEstoqueSchema,
  errosRegraTipoEstoque,
  type TipoEstoqueDetalhe,
  type TipoEstoqueOpcao,
} from '@genesis/shared';
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { conflitoVersao, garantirSemConflito, metadados } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import {
  acertosEstoque,
  movimentosEstoque,
  recebimentos,
  saldosEstoque,
  tiposEstoque,
  transferenciasEstoque,
  usuarios,
} from '../database/empresa/schema/index.js';
import type { Servicos } from '../servicos.js';
import { ressincronizarFluxos } from '../sync/comandos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

const LOCALIZACAO = 'Estoque › Tipo de Estoque';

type LinhaTipo = typeof tiposEstoque.$inferSelect;

/**
 * Tipo de Estoque (ERP 13.6; MD 3.2.6, 7.4; decisão 152 do README): classifica o saldo dentro de um local (Disponível,
 * Avaria, Vencido…). Regras: nome único; exatamente um padrão, sempre vendável e ativo (marcar outro como padrão tira
 * o anterior na mesma transação); os tipos de sistema não se excluem, e o Disponível e o Vasilhame vazio têm o
 * `vendavel` travado (o Vasilhame vazio também não se inativa); inativar exige saldo zero em todos os estoques e
 * nenhum acerto, recebimento ou transferência pendente no tipo; tirar o `vendavel` também exige saldo zero. Mudar
 * `vendavel` ou o padrão manda `ressincronizar_fluxo 'estoque'` a todos os terminais ativos da empresa (MD 6.4 regra
 * 3): o saldo que entra no filtro do pull (só tipos vendáveis) não ganha versão nova e só o pull do cursor 0 o põe no
 * espelho. A linha que sai do filtro não sai do espelho: o PDV instalado não tem a sombra da SYNC 6.11 (apagar o que
 * não voltou), por isso o `vendavel` só sai com saldo zero, e a linha que fica no espelho vale 0. O `GET` da lista
 * serve aos seletores de qualquer usuário autenticado.
 */
@Controller('tipos-estoque')
export class TiposEstoqueController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Get()
  async listar(): Promise<TipoEstoqueOpcao[]> {
    return this.s.tenancy.cx().consulta((db) =>
      db
        .select({
          id: tiposEstoque.id,
          nome: tiposEstoque.nome,
          vendavel: tiposEstoque.vendavel,
          padrao: tiposEstoque.padrao,
          ativo: tiposEstoque.ativo,
          chaveSistema: tiposEstoque.chaveSistema,
          versao: tiposEstoque.versao,
        })
        .from(tiposEstoque)
        .where(isNull(tiposEstoque.excluidoEm))
        .orderBy(desc(tiposEstoque.padrao), asc(tiposEstoque.nome)),
    );
  }

  @Permissao('tipos_estoque.ver')
  @Get(':id')
  async obter(@Param('id') idBruto: string): Promise<TipoEstoqueDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const d = await this.s.tenancy.cx().consulta((db) => detalhe(db, id));
    if (!d) throw ErroApi.naoEncontrado('Tipo de estoque não encontrado.');
    return d;
  }

  @Permissao('tipos_estoque.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TipoEstoqueDetalhe> {
    const dados = validar(criarTipoEstoqueSchema, corpo);
    const { id, terminais } = await this.s.tenancy.cx().transacao(
      async (tx) => {
        await garantirNomeUnico(tx, dados.nome);
        const anterior = dados.padrao ? await tirarPadraoAtual(tx, sessao.usuarioId) : null;
        const [t] = await tx
          .insert(tiposEstoque)
          .values({ ...dados, criadoPorId: sessao.usuarioId, atualizadoPorId: sessao.usuarioId })
          .returning();
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'criar',
          entidade: 'tipos_estoque',
          registroId: t!.id,
          localizacao: LOCALIZACAO,
          depois: t,
        });
        if (anterior) await this.auditarPadraoRetirado(tx, req, anterior);
        // Um tipo novo não tem saldo: só a troca do padrão (para onde vão as vendas futuras) ressincroniza.
        const terminais = anterior
          ? await ressincronizarFluxos(tx, 'todas', ['estoque'], sessao.usuarioId)
          : 0;
        return { id: t!.id, terminais };
      },
      { travaVersao: true },
    );
    return {
      ...(await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!,
      terminaisRessincronizados: terminais,
    };
  }

  @Permissao('tipos_estoque.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TipoEstoqueDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarTipoEstoqueSchema, corpo);
    const terminais = await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await travar(tx, id);
        if (antes.versao !== versao) await conflitoVersao(tx, antes);
        const erros = errosRegraTipoEstoque(antes, dados);
        if (Object.keys(erros).length) {
          throw new ErroApi('REGRA_NEGOCIO', Object.values(erros)[0]!, {
            campos: Object.fromEntries(Object.entries(erros).map(([c, m]) => [c, [m]])),
          });
        }
        await garantirNomeUnico(tx, dados.nome, id);
        if (antes.ativo && !dados.ativo) {
          await garantirSaldoZero(tx, id, 'ativo');
          await garantirSemRascunho(tx, id);
        }
        if (antes.vendavel && !dados.vendavel) await garantirSaldoZero(tx, id, 'vendavel');
        const anterior = dados.padrao && !antes.padrao ? await tirarPadraoAtual(tx, sessao.usuarioId) : null;
        const [depois] = await tx
          .update(tiposEstoque)
          .set({ ...dados, atualizadoPorId: sessao.usuarioId })
          .where(and(eq(tiposEstoque.id, id), eq(tiposEstoque.versao, versao)))
          .returning();
        if (!depois) await conflitoVersao(tx, antes);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'tipos_estoque',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
          depois,
        });
        if (anterior) await this.auditarPadraoRetirado(tx, req, anterior);
        return antes.vendavel !== dados.vendavel || anterior
          ? ressincronizarFluxos(tx, 'todas', ['estoque'], sessao.usuarioId)
          : 0;
      },
      { travaVersao: true },
    );
    return {
      ...(await this.s.tenancy.cx().consulta((db) => detalhe(db, id)))!,
      terminaisRessincronizados: terminais,
    };
  }

  @Permissao('tipos_estoque.excluir')
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
        if (antes.chaveSistema)
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'Tipo de estoque do sistema: não se exclui (inative, se puder).',
          );
        if (antes.padrao)
          throw new ErroApi('REGRA_NEGOCIO', 'O tipo padrão não se exclui: marque outro como padrão antes.');
        // Excluir só o que nunca foi usado; usado, o histórico (razão, acertos, recebimentos) continua apontando para
        // ele. O recebimento em qualquer situação conta: o rascunho ainda vai lançar no tipo (F2-B15).
        const [mov] = await tx
          .select({ id: movimentosEstoque.id })
          .from(movimentosEstoque)
          .where(eq(movimentosEstoque.tipoEstoqueId, id))
          .limit(1);
        const [acerto] = await tx
          .select({ id: acertosEstoque.id })
          .from(acertosEstoque)
          .where(and(usaTipo(id), isNull(acertosEstoque.excluidoEm)))
          .limit(1);
        const [recebimento] = await tx
          .select({ id: recebimentos.id })
          .from(recebimentos)
          .where(and(eq(recebimentos.tipoEstoqueId, id), isNull(recebimentos.excluidoEm)))
          .limit(1);
        if (mov || acerto)
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'O tipo de estoque já foi usado em movimentos ou acertos: inative em vez de excluir.',
          );
        if (recebimento)
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'O tipo de estoque já foi usado em recebimentos: inative em vez de excluir (o rascunho tem de ser ' +
              'movimentado ou excluído antes de inativar).',
          );
        // A transferência também, em qualquer situação (F2-B23): o rascunho ainda vai lançar no tipo, e a em trânsito
        // ainda entra no destino ou volta à origem nele.
        const [transferencia] = await tx
          .select({ id: transferenciasEstoque.id })
          .from(transferenciasEstoque)
          .where(and(eq(transferenciasEstoque.tipoEstoqueId, id), isNull(transferenciasEstoque.excluidoEm)))
          .limit(1);
        if (transferencia)
          throw new ErroApi(
            'REGRA_NEGOCIO',
            'O tipo de estoque já foi usado em transferências: inative em vez de excluir (o rascunho e a em ' +
              'trânsito têm de ser enviados, recebidos, cancelados ou excluídos antes de inativar).',
          );
        await tx
          .update(tiposEstoque)
          .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
          .where(eq(tiposEstoque.id, id));
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'excluir',
          entidade: 'tipos_estoque',
          registroId: id,
          localizacao: LOCALIZACAO,
          antes,
        });
      },
      { travaVersao: true },
    );
  }

  /** O padrão anterior perde a marca na mesma gravação (a troca fica no histórico dos dois tipos). */
  private async auditarPadraoRetirado(
    tx: DbEmpresa,
    req: RequisicaoGenesis,
    { antes, depois }: { antes: LinhaTipo; depois: LinhaTipo },
  ): Promise<void> {
    await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
      acao: 'editar',
      entidade: 'tipos_estoque',
      registroId: antes.id,
      localizacao: LOCALIZACAO,
      antes,
      depois,
    });
  }
}

async function travar(tx: DbEmpresa, id: string): Promise<LinhaTipo> {
  const [t] = await tx
    .select()
    .from(tiposEstoque)
    .where(and(eq(tiposEstoque.id, id), isNull(tiposEstoque.excluidoEm)))
    .for('update');
  if (!t) throw ErroApi.naoEncontrado('Tipo de estoque não encontrado.');
  return t;
}

/**
 * Tira a marca do padrão atual antes de marcar o novo (o índice `uq_tipos_estoque_padrao` admite um só). A linha é
 * travada: com a `fn_trava_versao` da transação, duas trocas de padrão nunca correm juntas.
 */
async function tirarPadraoAtual(
  tx: DbEmpresa,
  usuarioId: string,
): Promise<{ antes: LinhaTipo; depois: LinhaTipo } | null> {
  const [antes] = await tx
    .select()
    .from(tiposEstoque)
    .where(and(eq(tiposEstoque.padrao, true), isNull(tiposEstoque.excluidoEm)))
    .for('update');
  if (!antes) return null;
  const [depois] = await tx
    .update(tiposEstoque)
    .set({ padrao: false, atualizadoPorId: usuarioId })
    .where(eq(tiposEstoque.id, antes.id))
    .returning();
  return { antes, depois: depois! };
}

async function garantirNomeUnico(tx: DbEmpresa, nome: string, exceto?: string): Promise<void> {
  const [dup] = await tx
    .select({ id: tiposEstoque.id })
    .from(tiposEstoque)
    .where(
      and(
        isNull(tiposEstoque.excluidoEm),
        sql`lower(${tiposEstoque.nome}) = lower(${nome})`,
        exceto ? ne(tiposEstoque.id, exceto) : undefined,
      ),
    );
  if (dup) garantirSemConflito({ nome: ['Já existe um tipo de estoque com este nome'] });
}

/**
 * Inativar ou tirar o `vendavel` só sem saldo em nenhum estoque (ERP 13.6). Inativo, o saldo esquecido some dos
 * seletores; não vendável, a linha do saldo sai do filtro do pull mas fica no espelho do PDV com a última quantidade
 * baixada (sem a sombra da SYNC 6.11) e o saldo estimado do caixa continuaria a contá-la. Com saldo zero, o que fica
 * no espelho vale 0.
 */
async function garantirSaldoZero(tx: DbEmpresa, id: string, campo: 'ativo' | 'vendavel'): Promise<void> {
  const [saldo] = await tx
    .select({ n: count() })
    .from(saldosEstoque)
    .where(
      and(
        eq(saldosEstoque.tipoEstoqueId, id),
        ne(saldosEstoque.quantidade, '0'),
        isNull(saldosEstoque.excluidoEm),
      ),
    );
  if ((saldo?.n ?? 0) > 0) {
    throw new ErroApi(
      'REGRA_NEGOCIO',
      campo === 'ativo'
        ? 'Para inativar, o tipo de estoque precisa estar com saldo zero em todos os estoques.'
        : 'Para deixar de ser vendável, o tipo de estoque precisa estar com saldo zero em todos os estoques.',
      { campos: { [campo]: [`Há ${saldo!.n} saldo(s) diferente(s) de zero neste tipo`] } },
    );
  }
}

/** O acerto usa o tipo como origem ou, na mudança de tipo (F2-B8), como destino. */
const usaTipo = (id: string) =>
  or(eq(acertosEstoque.tipoEstoqueId, id), eq(acertosEstoque.tipoEstoqueDestinoId, id));

/**
 * Inativar só sem acerto em rascunho no tipo (origem ou destino da mudança de tipo), sem recebimento em rascunho com o
 * tipo de destino (F2-B14) e sem transferência pendente no tipo (F2-B23): o rascunho confere o tipo ao ser gravado, e
 * efetivá-lo ou movimentá-lo depois lançaria saldo no tipo inativo (a efetivação do acerto também recusa o tipo
 * inativo, `exigirTipoEstoqueAtivo`; o envio da transferência também).
 */
async function garantirSemRascunho(tx: DbEmpresa, id: string): Promise<void> {
  const [rascunhos] = await tx
    .select({ n: count() })
    .from(acertosEstoque)
    .where(and(usaTipo(id), eq(acertosEstoque.status, 'rascunho'), isNull(acertosEstoque.excluidoEm)));
  if ((rascunhos?.n ?? 0) > 0) {
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Para inativar, o tipo de estoque não pode ter acerto em rascunho: efetive ou exclua o rascunho antes.',
      { campos: { ativo: [`Há ${rascunhos!.n} acerto(s) em rascunho neste tipo`] } },
    );
  }
  const [receb] = await tx
    .select({ n: count() })
    .from(recebimentos)
    .where(
      and(
        eq(recebimentos.tipoEstoqueId, id),
        eq(recebimentos.status, 'rascunho'),
        isNull(recebimentos.excluidoEm),
      ),
    );
  if ((receb?.n ?? 0) > 0) {
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Para inativar, o tipo de estoque não pode ter recebimento em rascunho: movimente, troque o tipo ou exclua o ' +
        'rascunho antes.',
      { campos: { ativo: [`Há ${receb!.n} recebimento(s) em rascunho neste tipo`] } },
    );
  }
  // A transferência no tipo (F2-B23): o rascunho ainda vai lançar nele; a em trânsito ainda entra no destino (F2-B24)
  // ou volta à origem no cancelamento, e a recebida com divergência ainda devolve a diferença — a mercadoria em trânsito
  // não está em `saldos_estoque`, e o "saldo zero" não a vê.
  const [transf] = await tx
    .select({ n: count() })
    .from(transferenciasEstoque)
    .where(
      and(
        eq(transferenciasEstoque.tipoEstoqueId, id),
        inArray(transferenciasEstoque.status, ['rascunho', 'em_transito', 'recebida_divergencia']),
        isNull(transferenciasEstoque.excluidoEm),
      ),
    );
  if ((transf?.n ?? 0) > 0) {
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Para inativar, o tipo de estoque não pode ter transferência em rascunho, em trânsito ou com divergência a ' +
        'tratar: envie, receba, cancele ou exclua antes.',
      { campos: { ativo: [`Há ${transf!.n} transferência(s) pendente(s) neste tipo`] } },
    );
  }
}

async function detalhe(db: DbEmpresa, id: string): Promise<TipoEstoqueDetalhe | null> {
  const autor = alias(usuarios, 'autor');
  const [r] = await db
    .select({ t: tiposEstoque, autorNome: autor.nome })
    .from(tiposEstoque)
    .leftJoin(autor, eq(autor.id, tiposEstoque.atualizadoPorId))
    .where(and(eq(tiposEstoque.id, id), isNull(tiposEstoque.excluidoEm)));
  if (!r) return null;
  return {
    ...metadados(r.t, r.autorNome),
    nome: r.t.nome,
    vendavel: r.t.vendavel,
    padrao: r.t.padrao,
    ativo: r.t.ativo,
    chaveSistema: r.t.chaveSistema,
  };
}
