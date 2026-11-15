import { Controller, Get, Inject, Query } from '@nestjs/common';
import { limiteDeslocamento, ORIGENS_AUDITORIA, paginacaoQuerySchema, type Pagina } from '@genesis/shared';
import { and, count, desc, eq, gte, ilike, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { filtroLojas, garantirLoja } from '../autorizacao/lojas.js';
import { Sessao } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { auditoria } from '../database/empresa/auditoria.js';
import type { Servicos } from '../servicos.js';
import { usuarioVisivel } from '../usuarios/usuarios.controller.js';
import { redigirParaVisao } from './mascarar.js';

/** Fuso usado para "hoje" e para datas sem hora nos filtros (o da maioria das lojas; ERP 1.5). */
const FUSO_PADRAO = 'America/Sao_Paulo';

const instante = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

const filtroSchema = paginacaoQuerySchema.extend({
  de: instante.optional(),
  ate: instante.optional(),
  usuario_id: z.uuid().optional(),
  entidade: z.string().trim().max(60).optional(),
  registro_id: z.uuid().optional(),
  acao: z.string().trim().max(40).optional(),
  origem: z.enum(ORIGENS_AUDITORIA).optional(),
  loja_id: z.uuid().optional(),
  texto: z.string().trim().min(1).max(100).optional(),
});

/** Data sem hora = meia-noite no fuso padrão; `fimDoDia` = meia-noite do dia seguinte (limite exclusivo). */
function limite(valor: string, fimDoDia: boolean): SQL {
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    const dia = fimDoDia ? sql`${valor}::date + 1` : sql`${valor}::date`;
    return sql`(${dia}::timestamp at time zone ${FUSO_PADRAO})`;
  }
  return sql`${valor}::timestamptz`;
}

/**
 * Entidades cujas linhas descrevem um usuário (o cadastro, o login e as sessões do ERP): para quem tem lojas
 * restritas, valem as regras da decisão 92 — a linha só aparece se o usuário dela é visível (`usuarioVisivel`), com
 * ou sem loja na linha. O usuário da linha é o `registro_id` (o id do usuário em `usuarios` e `login`) ou, na falta
 * dele, quem fez a ação; em `sessoes_usuario` o `registro_id` é a sessão, e o usuário é o dono dela (`usuario_id`).
 */
export const ENTIDADES_AUDITORIA_DE_USUARIO = ['usuarios', 'login', 'sessoes_usuario'] as const;

/** Condição da decisão 92 nas linhas de usuário (`undefined` = sem restrição). */
export function usuarioDaLinhaVisivel(sessao: SessaoErp): SQL | undefined {
  if (sessao.lojas === null) return undefined;
  const usuarioDaLinha = sql`(case when ${auditoria.entidade} = 'sessoes_usuario' then ${auditoria.usuarioId}
    else coalesce(${auditoria.registroId}, ${auditoria.usuarioId}) end)`;
  return or(
    notInArray(auditoria.entidade, [...ENTIDADES_AUDITORIA_DE_USUARIO]),
    usuarioVisivel(sessao, usuarioDaLinha),
  );
}

/** Histórico de um registro / tela de auditoria (ERP 1.8, 17.3). */
@Controller('auditoria')
export class AuditoriaController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('auditoria.ver')
  @Get()
  async listar(
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<Pagina<typeof auditoria.$inferSelect>> {
    const q = validar(filtroSchema, query);
    const { limite: lim, deslocamento } = limiteDeslocamento(q);
    if (q.loja_id) garantirLoja(sessao, q.loja_id);
    // ERP 2.1: linhas de loja só das lojas permitidas; linhas sem loja (cadastros globais) são de todos, menos as de
    // usuário, login e sessão, que seguem a visibilidade do usuário (decisão 92; `usuarioDaLinhaVisivel`).
    const lojas = filtroLojas(sessao, auditoria.lojaId);
    // Sem período nem registro, a tela abre em "hoje" (ERP 17.3) e a consulta só toca a partição do mês.
    const de = q.de
      ? limite(q.de, false)
      : q.registro_id
        ? undefined
        : sql`(date_trunc('day', now() at time zone ${FUSO_PADRAO}) at time zone ${FUSO_PADRAO})`;
    const texto = q.texto?.replace(/[\\%_]/g, (c) => `\\${c}`);
    const onde = and(
      lojas ? or(isNull(auditoria.lojaId), lojas) : undefined,
      usuarioDaLinhaVisivel(sessao),
      de ? gte(auditoria.ocorridoEm, de) : undefined,
      q.ate ? lt(auditoria.ocorridoEm, limite(q.ate, true)) : undefined,
      q.usuario_id ? eq(auditoria.usuarioId, q.usuario_id) : undefined,
      q.entidade ? eq(auditoria.entidade, q.entidade) : undefined,
      q.registro_id ? eq(auditoria.registroId, q.registro_id) : undefined,
      q.acao ? eq(auditoria.acao, q.acao) : undefined,
      q.origem ? eq(auditoria.origem, q.origem) : undefined,
      q.loja_id ? eq(auditoria.lojaId, q.loja_id) : undefined,
      texto ? ilike(auditoria.descricao, `%${texto}%`) : undefined,
    );
    return this.s.tenancy.cx().consulta(async (db) => {
      const itens = await db
        .select()
        .from(auditoria)
        .where(onde)
        .orderBy(desc(auditoria.ocorridoEm))
        .limit(lim)
        .offset(deslocamento);
      const [total] = await db.select({ n: count() }).from(auditoria).where(onde);
      const visao = {
        verRh: sessao.permissoes.has('usuarios.ver_dados_rh'),
        verCusto: sessao.permissoes.has('produtos.ver_custo'),
        lojas: sessao.lojas,
      };
      return {
        itens: itens.map((i) => ({
          ...i,
          antes: redigirParaVisao(i.antes, visao) as typeof i.antes,
          depois: redigirParaVisao(i.depois, visao) as typeof i.depois,
        })),
        total: total?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }
}
