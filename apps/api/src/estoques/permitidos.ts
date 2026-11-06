/**
 * Estoques permitidos (ERP 2.1; MD 3.3.5; Fase 2, F2-B5; README da API › decisões 89 e 149). Regra única:
 *
 * - o Master vê e movimenta todos os estoques;
 * - quem tem `estoques.todos` também (só o Master tem no seed; a empresa pode concedê-la a um perfil ou usuário);
 * - os demais, só os estoques que estão em `usuarios_estoques`, **inclusive os sem loja** (o CD). As lojas permitidas
 *   não entram mais na conta: liberar a loja não libera o estoque dela, e o estoque sem loja deixou de ser de todos.
 *
 * A lista vem pronta na sessão (`SessaoErp.estoques`, calculada com as permissões em `PermissoesEfetivas`, com o
 * mesmo cache e a mesma geração, que agora inclui `usuarios_estoques`). A virada (migração 0019) copiou para
 * `usuarios_estoques` o que cada usuário via antes (F2-Q4 (a), D45): ninguém perdeu acesso no deploy.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { ErroApi } from '../comum/erros.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Permissão que dispensa a lista de `usuarios_estoques` (vê e movimenta todos os estoques). */
export const PERMISSAO_TODOS_ESTOQUES = 'estoques.todos';

/**
 * `ver` (listagens, saldos, detalhe) ou `movimentar` (acerto, importação com "Atualizar estoque" e, na Fase 2, os
 * documentos que lançam no razão). Hoje os dois dão a mesma lista, porque `usuarios_estoques` não separa as ações
 * (MD 3.3.5); quem chama declara o que confere, e uma regra futura (ex.: estoque só para consulta) muda aqui.
 */
export type ModoEstoque = 'ver' | 'movimentar';

type SessaoEstoques = Pick<SessaoErp, 'estoques'>;

/** Ids dos estoques permitidos; `null` = todos (Master ou `estoques.todos`). */
export function estoquesPermitidos(sessao: SessaoEstoques, _modo: ModoEstoque): readonly string[] | null {
  return sessao.estoques;
}

/**
 * Filtro dos estoques permitidos sobre qualquer coluna de estoque (`a.estoque_id`, `s.estoque_id`, `e.id`…);
 * `undefined` = vê todos. Sem nenhum estoque permitido, o filtro é `false` (`= any('{}')` não casa com nada).
 */
export function estoqueVisivel(
  sessao: SessaoEstoques,
  coluna: SQL,
  modo: ModoEstoque = 'ver',
): SQL | undefined {
  const ids = estoquesPermitidos(sessao, modo);
  if (ids === null) return undefined;
  return sql`${coluna} = any(${`{${ids.join(',')}}`}::uuid[])`;
}

/** O estoque está entre os permitidos (conferência em memória, sem ida ao banco). */
export function estoquePermitido(sessao: SessaoEstoques, estoqueId: string, modo: ModoEstoque): boolean {
  const ids = estoquesPermitidos(sessao, modo);
  return ids === null || ids.includes(estoqueId);
}

/** 403 quando o estoque não está entre os permitidos (usar onde o estoque já foi mostrado ao usuário, ex.: a loja). */
export function garantirEstoquePermitido(
  sessao: SessaoEstoques,
  estoqueId: string,
  modo: ModoEstoque,
  mensagem = 'O estoque está fora dos seus estoques permitidos.',
): void {
  if (!estoquePermitido(sessao, estoqueId, modo)) throw ErroApi.semPermissao(mensagem);
}

/**
 * Quem cria um estoque (ou a loja que cria o estoque dela) sem ver todos passa a tê-lo em `usuarios_estoques`; senão
 * ele some da própria listagem, como a loja recém-criada (lojas.controller). Idempotente (`uq_usuarios_estoques`).
 * A sessão da requisição continua com a lista antiga: a resposta da criação não deve filtrar por ela.
 */
export async function concederEstoqueAoCriador(
  tx: DbEmpresa,
  sessao: Pick<SessaoErp, 'estoques' | 'usuarioId'>,
  estoqueId: string,
): Promise<void> {
  if (sessao.estoques === null) return;
  await tx.execute(sql`
    insert into usuarios_estoques (usuario_id, estoque_id, criado_por_id, atualizado_por_id)
    select ${sessao.usuarioId}, ${estoqueId}, ${sessao.usuarioId}, ${sessao.usuarioId}
     where not exists (select 1 from usuarios_estoques
                        where usuario_id = ${sessao.usuarioId} and estoque_id = ${estoqueId} and excluido_em is null)`);
}
