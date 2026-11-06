/**
 * Peças comuns das consultas só de leitura das vendas e do caixa do PDV (Fase 1C, bloco C12; ERP 14.9, 15.2–15.4) e
 * do dashboard: lojas visíveis ao usuário, o filtro da loja de treino (dono, O10), o intervalo de dia operacional
 * (D7) e a conversão das linhas cruas para a resposta.
 */
import { CONFIGURACOES_POR_CHAVE, type FiltroTreino } from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';

/**
 * Condições da loja (alias `l` = `lojas`): só as permitidas ao usuário; a loja escolhida no filtro vale mesmo sendo
 * de treino (quem escolhe a loja Treino quer ver a loja Treino); sem loja escolhida, `treino` decide (O10: fora por
 * padrão). Loja escolhida fora das permitidas = 403, como no dashboard.
 */
export function condicoesLoja(
  sessao: SessaoErp,
  filtro: { lojaId?: string | undefined; treino: FiltroTreino },
): SQL[] {
  const c: SQL[] = [];
  if (filtro.lojaId) {
    if (sessao.lojas !== null && !sessao.lojas.includes(filtro.lojaId))
      throw ErroApi.semPermissao('A loja está fora das suas lojas permitidas.');
    c.push(sql`l.id = ${filtro.lojaId}`);
  } else if (filtro.treino === 'excluir') c.push(sql`not l.treino`);
  else if (filtro.treino === 'somente') c.push(sql`l.treino`);
  const visivel = lojaVisivel(sessao);
  if (visivel) c.push(visivel);
  return c;
}

/** `l.id` entre as lojas permitidas; `undefined` para quem vê todas. */
export function lojaVisivel(sessao: SessaoErp, coluna: SQL = sql`l.id`): SQL | undefined {
  if (sessao.lojas === null) return undefined;
  return sql`${coluna} = any(${`{${sessao.lojas.join(',')}}`}::uuid[])`;
}

/** Intervalo fechado de dia operacional (`AAAA-MM-DD`, D7) sobre a coluna `date` dada. */
export function intervaloDia(coluna: SQL, inicial?: string, final?: string): SQL[] {
  const c: SQL[] = [];
  if (inicial) c.push(sql`${coluna} >= ${inicial}::date`);
  if (final) c.push(sql`${coluna} <= ${final}::date`);
  return c;
}

/**
 * Dia operacional corrente de cada loja (alias `l`): a hora local no fuso da loja menos a hora de corte efetiva
 * (`geral.dia_operacional_hora_corte`, D7: 05:00 na empresa, ajustável por loja; MD 1.2), a mesma conta do PDV
 * (`DiaOperacional.Calcular`).
 */
const HORA_CORTE = 'geral.dia_operacional_hora_corte';
export const diaOperacionalAtual = sql`((now() at time zone l.fuso_horario) - coalesce(
    (select (c.valor #>> '{}')::interval from configuracoes c
      where c.chave = ${HORA_CORTE} and c.excluido_em is null and c.escopo = 'loja' and c.loja_id = l.id),
    (select (c.valor #>> '{}')::interval from configuracoes c
      where c.chave = ${HORA_CORTE} and c.excluido_em is null and c.escopo = 'empresa'),
    ${String(CONFIGURACOES_POR_CHAVE.get(HORA_CORTE)?.padrao ?? '00:00')}::interval))::date`;

export const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
export const texto = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
