/**
 * Peças comuns dos controllers de cadastro (ERP 1.4, 1.8, 3.1): busca "contém", ordenação da URL, conflito de versão
 * com o autor da última alteração, autor da linha e conversão de datas para a resposta.
 */
import { ordenacao, type PaginacaoQuery } from '@genesis/shared';
import { asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { usuarios } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { ErroApi } from './erros.js';

export const escaparLike = (v: string) => v.replace(/[%_\\]/g, (c) => `\\${c}`);

/** `%termo%` escapado, ou `undefined` sem termo. */
export function contem(termo: string | undefined): string | undefined {
  const t = termo?.trim();
  return t ? `%${escaparLike(t)}%` : undefined;
}

/** `ordenar=campo:dir` validado contra as colunas permitidas (desempate pela coluna `estavel`). */
export function ordemDaQuery(
  q: PaginacaoQuery,
  colunas: Record<string, SQL | PgColumn>,
  padrao: string,
  /** Desempate (coluna do Drizzle, ou `sql\`a.codigo\`` em consultas cruas com alias). */
  estavel: PgColumn | SQL,
): SQL[] {
  const ord = ordenacao(q) ?? {
    campo: padrao.split(':')[0]!,
    direcao: (padrao.split(':')[1] ?? 'asc') as 'asc' | 'desc',
  };
  const coluna = colunas[ord.campo];
  if (!coluna) {
    throw new ErroApi('VALIDACAO', 'Ordenação inválida.', {
      campos: { ordenar: [`Use um de: ${Object.keys(colunas).join(', ')}`] },
    });
  }
  return [ord.direcao === 'asc' ? asc(coluna) : desc(coluna), asc(estavel)];
}

export async function nomeUsuario(db: DbEmpresa, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [u] = await db.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, id));
  return u?.nome ?? null;
}

/** 409 `CONFLITO_VERSAO` com quem alterou por último (ERP 1.4: "alterado por X em …"). */
export async function conflitoVersao(
  db: DbEmpresa,
  atual: { versao: number; atualizadoPorId: string | null; atualizadoEm: Date },
): Promise<never> {
  throw new ErroApi('CONFLITO_VERSAO', 'Registro alterado por outro usuário. Recarregue e tente de novo.', {
    detalhes: {
      versaoAtual: atual.versao,
      alteradoPorId: atual.atualizadoPorId,
      alteradoPorNome: await nomeUsuario(db, atual.atualizadoPorId),
      alteradoEm: atual.atualizadoEm,
    },
  });
}

/** Confere a versão enviada antes de alterar (a linha já foi lida com `for update`). */
export async function garantirVersao(
  db: DbEmpresa,
  atual: { versao: number; atualizadoPorId: string | null; atualizadoEm: Date },
  versao: number,
): Promise<void> {
  if (atual.versao !== versao) await conflitoVersao(db, atual);
}

/** 409 `CONFLITO` com os campos repetidos, se houver. */
export function garantirSemConflito(
  campos: Record<string, string[]>,
  mensagem = 'Já existe um registro com estes dados.',
): void {
  if (Object.keys(campos).length) throw new ErroApi('CONFLITO', mensagem, { campos });
}

export function erroCampo(
  campo: string,
  mensagem: string,
  codigo: 'VALIDACAO' | 'REGRA_NEGOCIO' = 'VALIDACAO',
): ErroApi {
  return new ErroApi(codigo, codigo === 'VALIDACAO' ? 'Verifique os campos destacados.' : mensagem, {
    campos: { [campo]: [mensagem] },
  });
}

/** Metadados comuns do detalhe (datas ISO e autor). */
export function metadados(
  l: { id: string; versao: number; criadoEm: Date; atualizadoEm: Date },
  autorNome: string | null,
) {
  return {
    id: l.id,
    versao: l.versao,
    criadoEm: l.criadoEm.toISOString(),
    atualizadoEm: l.atualizadoEm.toISOString(),
    atualizadoPorNome: autorNome,
  };
}

/** Booleano do filtro "Situação" (ativos/inativos/todos). */
export function situacao<T>(
  valor: string,
  coluna: PgColumn,
  ativos = 'ativos',
  inativos = 'inativos',
): SQL | undefined {
  if (valor === ativos) return eq(coluna, true as T);
  if (valor === inativos) return eq(coluna, false as T);
  return undefined;
}

/**
 * Referência qualificada `"tabela"."coluna"` para subconsultas correlacionadas na lista do `select`: ali o Drizzle
 * escreve a coluna sem a tabela (`"id"`), que dentro da subconsulta apontaria para a tabela interna.
 */
export const ref = (tabela: string, coluna = 'id') => sql.raw(`"${tabela}"."${coluna}"`);
