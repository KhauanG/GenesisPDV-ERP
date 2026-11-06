import { Body, Controller, Get, HttpCode, Inject, Post, Put, Query } from '@nestjs/common';
import {
  CONFIGURACOES,
  CONFIGURACOES_POR_CHAVE,
  GRUPOS_CONFIGURACAO,
  GRUPOS_CONFIGURACAO_FISCAIS,
  gravarAtalhosSchema,
  gravarConfiguracoesSchema,
  grupoDaChave,
  validarValorConfiguracao,
  type AtalhoPdv,
  type ValorConfiguracao,
} from '@genesis/shared';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { garantirLoja } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { atalhosPdv, configuracoes, lojas, terminais } from '../database/empresa/schema/index.js';
import { CHAVES_SENHA_CLIENTE_PDV, pessoaRelevante } from '../sync/fluxos.js';
import { tocar } from '../sync/toque.js';
import { ATALHOS_PDV_PADRAO } from '../database/seed/dados/tabelas-md.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { valorJson } from './valores.js';

const LOCALIZACAO = 'Cadastros › Configurações';

const consultaSchema = z.object({
  grupos: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : [...GRUPOS_CONFIGURACAO]))
    .pipe(z.array(z.enum(GRUPOS_CONFIGURACAO))),
  lojaId: z.uuid().optional(),
});

const iguais = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Configurações (ERP 9.0, 9.1, 9.3.1, 9.9) e a tabela de atalhos do PDV. Só existem linhas para valores diferentes do
 * padrão; "voltar ao padrão"/"herdar" exclui a linha logicamente (a exclusão desce ao PDV como tombstone).
 */
@Controller()
export class ConfiguracoesController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('configuracoes.ver')
  @Get('configuracoes')
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<ValorConfiguracao[]> {
    const q = validar(consultaSchema, query);
    if (q.lojaId) garantirLoja(sessao, q.lojaId);
    const defs = CONFIGURACOES.filter(
      (c) => (q.grupos as string[]).includes(grupoDaChave(c.chave)) && (!q.lojaId || c.loja),
    );
    const chaves = defs.map((d) => d.chave);
    return this.s.tenancy.cx().consulta(async (db) => {
      const linhas = chaves.length
        ? await db
            .select({
              chave: configuracoes.chave,
              escopo: configuracoes.escopo,
              lojaId: configuracoes.lojaId,
              valor: valorJson,
            })
            .from(configuracoes)
            .leftJoin(lojas, eq(lojas.id, configuracoes.lojaId))
            .where(
              and(
                inArray(configuracoes.chave, chaves),
                isNull(configuracoes.excluidoEm),
                or(eq(configuracoes.escopo, 'empresa'), isNull(lojas.excluidoEm)),
              ),
            )
        : [];
      return defs.map((d) => {
        const empresa = linhas.find((l) => l.chave === d.chave && l.escopo === 'empresa');
        const loja = q.lojaId
          ? linhas.find((l) => l.chave === d.chave && l.escopo === 'loja' && l.lojaId === q.lojaId)
          : undefined;
        const mascarar = (v: unknown) => (d.segredo && v !== undefined ? '***' : v);
        return {
          chave: d.chave,
          valor: mascarar(loja ? loja.valor : empresa ? empresa.valor : d.padrao),
          padrao: d.padrao,
          ...(empresa ? { valorEmpresa: mascarar(empresa.valor) } : {}),
          ...(loja ? { valorLoja: mascarar(loja.valor) } : {}),
          loja: d.loja,
          pdv: d.pdv,
          segredo: !!d.segredo,
          lojasSobrepondo: linhas.filter((l) => l.chave === d.chave && l.escopo === 'loja').length,
        };
      });
    });
  }

  @Permissao('configuracoes.editar')
  @Put('configuracoes')
  async gravar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ValorConfiguracao[]> {
    const { lojaId, valores } = validar(gravarConfiguracoesSchema, corpo);
    if (lojaId) garantirLoja(sessao, lojaId);
    const campos: Record<string, string[]> = {};
    for (const [chave, valor] of Object.entries(valores)) {
      const def = CONFIGURACOES_POR_CHAVE.get(chave);
      const erro = validarValorConfiguracao(chave, valor);
      if (erro) campos[chave] = [erro];
      else if (lojaId && !def!.loja) campos[chave] = ['Esta configuração não aceita valor por loja'];
      else if (def!.segredo) campos[chave] = ['Segredos têm rota própria'];
    }
    if (Object.keys(campos).length)
      throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', { campos });
    const fiscais = Object.keys(valores).filter((c) => GRUPOS_CONFIGURACAO_FISCAIS.includes(grupoDaChave(c)));
    if (fiscais.length && !sessao.permissoes.has('configuracoes.editar_fiscal')) {
      throw new ErroApi(
        'SEM_PERMISSAO',
        'Alterar configurações fiscais exige "Configurações: Editar fiscal e tributação".',
        {
          detalhes: { permissoes: ['configuracoes.editar_fiscal'], chaves: fiscais },
        },
      );
    }
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        if (lojaId) {
          const [l] = await tx
            .select({ id: lojas.id })
            .from(lojas)
            .where(and(eq(lojas.id, lojaId), isNull(lojas.excluidoEm)));
          if (!l) throw ErroApi.naoEncontrado('Loja não encontrada.');
        }
        const antes: Record<string, unknown> = {};
        const depois: Record<string, unknown> = {};
        for (const [chave, valor] of Object.entries(valores)) {
          const def = CONFIGURACOES_POR_CHAVE.get(chave)!;
          const [linha] = await tx
            .select({ id: configuracoes.id, valor: valorJson })
            .from(configuracoes)
            .where(
              and(
                eq(configuracoes.chave, chave),
                eq(configuracoes.escopo, lojaId ? 'loja' : 'empresa'),
                lojaId ? eq(configuracoes.lojaId, lojaId) : isNull(configuracoes.lojaId),
                isNull(configuracoes.excluidoEm),
              ),
            )
            .for('update');
          // Empresa: só grava o que difere do padrão. Loja: "Personalizar" grava mesmo igual (fica fixo na loja).
          const remover = valor === null || (!lojaId && iguais(valor, def.padrao));
          const anterior = linha ? linha.valor : undefined;
          if (remover) {
            if (linha) {
              await tx
                .update(configuracoes)
                .set({ excluidoEm: new Date(), atualizadoPorId: sessao.usuarioId })
                .where(eq(configuracoes.id, linha.id));
            }
          } else if (linha) {
            if (!iguais(linha.valor, valor)) {
              await tx
                .update(configuracoes)
                .set({ valor, atualizadoPorId: sessao.usuarioId })
                .where(eq(configuracoes.id, linha.id));
            }
          } else {
            await tx.insert(configuracoes).values({
              escopo: lojaId ? 'loja' : 'empresa',
              lojaId,
              chave,
              valor,
              criadoPorId: sessao.usuarioId,
              atualizadoPorId: sessao.usuarioId,
            });
          }
          const novo = remover ? undefined : valor;
          if (!iguais(anterior, novo)) {
            antes[chave] = anterior ?? null;
            depois[chave] = novo ?? null;
          }
        }
        // `pessoas.senha_hash` desce conforme estas chaves (SYNC 4.1): a projeção muda sem que a linha mude, então as
        // pessoas com senha (relevantes para a loja, na chave da loja) ganham versão nova e descem de novo pelo pull
        // normal. Refazer o fluxo não bastaria: a linha voltaria com a mesma versão e o PDV só aplica versão maior.
        if (CHAVES_SENHA_CLIENTE_PDV.some((c) => c in depois)) {
          const [alvo] = await tx
            .select({ id: terminais.id })
            .from(terminais)
            .where(
              and(
                inArray(terminais.status, ['ativo', 'desativando']),
                isNull(terminais.excluidoEm),
                lojaId ? eq(terminais.lojaId, lojaId) : undefined,
              ),
            )
            .limit(1);
          if (alvo) {
            const { rows } = await tx.execute<{ id: string }>(
              sql`select t.id from pessoas t where t.senha_hash is not null${
                lojaId ? sql` and ${pessoaRelevante('id')({ lojaId })}` : sql``
              }`,
            );
            await tocar(
              tx,
              'pessoas',
              'id',
              rows.map((r) => r.id),
            );
          }
        }
        if (Object.keys(depois).length) {
          await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
            acao: 'editar',
            entidade: 'configuracoes',
            lojaId,
            localizacao: lojaId ? 'Cadastros › Lojas › Parâmetros' : LOCALIZACAO,
            descricao: `${Object.keys(depois).length} configuração(ões) alterada(s)`,
            antes,
            depois,
          });
        }
      },
      { travaVersao: true },
    );
    const grupos = [...new Set(Object.keys(valores).map(grupoDaChave))].join(',');
    return this.listar({ grupos, ...(lojaId ? { lojaId } : {}) }, sessao);
  }

  /** Tabela de atalhos do PDV da empresa (ERP 9.9; MD 3.10.2, 7.8). */
  @Permissao('configuracoes.ver')
  @Get('atalhos-pdv')
  async atalhos(): Promise<AtalhoPdv[]> {
    return this.s.tenancy.cx().consulta((db) => listarAtalhos(db));
  }

  @Permissao('configuracoes.editar')
  @Put('atalhos-pdv')
  async gravarAtalhos(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<AtalhoPdv[]> {
    const { itens } = validar(gravarAtalhosSchema, corpo);
    return this.s.tenancy.cx().transacao(
      async (tx) => {
        const atuais = await tx
          .select()
          .from(atalhosPdv)
          .where(and(isNull(atalhosPdv.lojaId), isNull(atalhosPdv.excluidoEm)))
          .for('update');
        const desconhecidas = itens.filter((i) => !atuais.some((a) => a.acao === i.acao)).map((i) => i.acao);
        if (desconhecidas.length) {
          throw new ErroApi('VALIDACAO', 'Ação de atalho desconhecida.', {
            campos: { itens: [`Ações desconhecidas: ${desconhecidas.join(', ')}`] },
          });
        }
        // Teclas habilitadas que ficam de fora da lista continuam valendo: conferir colisão com elas também.
        const fora = atuais.filter((a) => a.habilitado && !itens.some((i) => i.acao === a.acao));
        for (const [i, item] of itens.entries()) {
          const c = fora.find((a) => item.habilitado && a.tecla.toLowerCase() === item.tecla.toLowerCase());
          if (c)
            throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
              campos: { [`itens.${i}.tecla`]: [`Tecla já usada em ${c.acao}`] },
            });
        }
        await aplicarAtalhos(tx, sessao, atuais, itens);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'atalhos_pdv',
          localizacao: 'Cadastros › Configurações › PDV',
          antes: atuais.map(({ acao, tecla, habilitado, ordem }) => ({ acao, tecla, habilitado, ordem })),
          depois: itens,
        });
        return listarAtalhos(tx);
      },
      { travaVersao: true },
    );
  }

  /** "Restaurar padrão" (ERP 9.9): teclas, habilitado e ordem do seed (MD 7.8). */
  @Permissao('configuracoes.editar')
  @Post('atalhos-pdv/restaurar-padrao')
  @HttpCode(200)
  async restaurarAtalhos(@Sessao() sessao: SessaoErp, @Req() req: RequisicaoGenesis): Promise<AtalhoPdv[]> {
    return this.s.tenancy.cx().transacao(
      async (tx) => {
        const atuais = await tx
          .select()
          .from(atalhosPdv)
          .where(and(isNull(atalhosPdv.lojaId), isNull(atalhosPdv.excluidoEm)))
          .for('update');
        const padrao = ATALHOS_PDV_PADRAO.filter((p) => atuais.some((a) => a.acao === p.acao)).map((p) => ({
          acao: p.acao,
          tecla: p.tecla,
          habilitado: p.habilitado,
          ordem: p.ordem,
        }));
        // Ações sem padrão (acrescentadas depois) ficam desabilitadas para não colidir.
        const extras = atuais
          .filter((a) => !padrao.some((p) => p.acao === a.acao))
          .map((a) => ({ acao: a.acao, tecla: a.tecla, habilitado: false, ordem: a.ordem }));
        await aplicarAtalhos(tx, sessao, atuais, [...padrao, ...extras]);
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'editar',
          entidade: 'atalhos_pdv',
          localizacao: 'Cadastros › Configurações › PDV',
          descricao: 'Atalhos restaurados para o padrão',
          antes: atuais.map(({ acao, tecla, habilitado, ordem }) => ({ acao, tecla, habilitado, ordem })),
        });
        return listarAtalhos(tx);
      },
      { travaVersao: true },
    );
  }
}

async function listarAtalhos(db: DbEmpresa): Promise<AtalhoPdv[]> {
  return db
    .select({
      id: atalhosPdv.id,
      acao: atalhosPdv.acao,
      tecla: atalhosPdv.tecla,
      habilitado: atalhosPdv.habilitado,
      ordem: atalhosPdv.ordem,
    })
    .from(atalhosPdv)
    .where(and(isNull(atalhosPdv.lojaId), isNull(atalhosPdv.excluidoEm)))
    .orderBy(asc(atalhosPdv.ordem), asc(atalhosPdv.acao));
}

/**
 * Em duas fases para nunca violar `uq_atalhos_pdv_tecla` (tecla única entre habilitados) no meio da troca: primeiro
 * desabilita as linhas que mudam, depois grava os valores finais (já conferidos sem colisão).
 */
async function aplicarAtalhos(
  tx: DbEmpresa,
  sessao: SessaoErp,
  atuais: Array<typeof atalhosPdv.$inferSelect>,
  itens: Array<{ acao: string; tecla: string; habilitado: boolean; ordem: number }>,
): Promise<void> {
  const mudam = itens
    .map((i) => ({ i, a: atuais.find((x) => x.acao === i.acao)! }))
    .filter(({ i, a }) => a.tecla !== i.tecla || a.habilitado !== i.habilitado || a.ordem !== i.ordem);
  const ids = mudam.filter(({ a }) => a.habilitado).map(({ a }) => a.id);
  if (ids.length) await tx.update(atalhosPdv).set({ habilitado: false }).where(inArray(atalhosPdv.id, ids));
  for (const { i, a } of mudam) {
    await tx
      .update(atalhosPdv)
      .set({ tecla: i.tecla, habilitado: i.habilitado, ordem: i.ordem, atualizadoPorId: sessao.usuarioId })
      .where(eq(atalhosPdv.id, a.id));
  }
}
