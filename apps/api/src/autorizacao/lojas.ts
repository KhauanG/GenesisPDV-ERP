import { inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';

/**
 * Filtro por lojas permitidas (ERP 2.1): condição para o `where` dos repositórios de entidades com `loja_id`.
 * `undefined` = sem restrição (Master); lista vazia = nenhuma linha.
 */
export function filtroLojas(sessao: SessaoErp, coluna: PgColumn): SQL | undefined {
  if (sessao.lojas === null) return undefined;
  if (sessao.lojas.length === 0) return sql`false`;
  return inArray(coluna, [...sessao.lojas]);
}

export function lojaPermitida(sessao: SessaoErp, lojaId: string | null | undefined): boolean {
  if (sessao.lojas === null) return true;
  return lojaId !== null && lojaId !== undefined && sessao.lojas.includes(lojaId);
}

export function garantirLoja(sessao: SessaoErp, lojaId: string | null | undefined): void {
  if (!lojaPermitida(sessao, lojaId)) throw ErroApi.semPermissao('Você não tem acesso a esta loja.');
}

/**
 * Excluir o registro da empresa que leva junto linhas de uma loja (faixas do mix, preços e faixas do produto) exige
 * acesso a todas as lojas dessas linhas (decisões 88 e 207): a linha de loja fora das permitidas → 403, a mesma regra
 * da gravação que as apagaria (o modo "por produto" do mix). Linhas sem loja (`null`) são da empresa (decisão 87).
 * As linhas lidas passam por `daEmpresaOuLojaViva`: a de loja excluída não conta.
 */
/**
 * Condição das linhas que contam em `garantirSemLojaOculta`: as da empresa (`loja_id` nulo) e as de loja não excluída.
 * A exclusão da loja não apaga os preços, o estoque mínimo nem as faixas dela, e `sessao.lojas` nunca traz loja
 * excluída: sem esta condição, a loja apagada viraria para sempre uma "loja oculta" que nenhum restrito tem.
 */
export function daEmpresaOuLojaViva(coluna: PgColumn): SQL {
  return sql`(${coluna} is null or exists (select 1 from lojas lv where lv.id = ${coluna} and lv.excluido_em is null))`;
}

export function garantirSemLojaOculta(
  sessao: SessaoErp,
  lojasDasLinhas: ReadonlyArray<string | null>,
  mensagem: string,
): void {
  if (sessao.lojas === null) return;
  const permitidas = sessao.lojas;
  if (lojasDasLinhas.some((l) => l !== null && !permitidas.includes(l))) throw ErroApi.semPermissao(mensagem);
}
