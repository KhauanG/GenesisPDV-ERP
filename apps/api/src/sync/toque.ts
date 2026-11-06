/**
 * Toque (MD 3.5.4, 6.4 regra 1): dá `versao` nova a linhas que passaram a ser relevantes para um PDV sem que nada nelas
 * tenha mudado — a pessoa que ganhou `pessoas_relevancia_loja` (e as filhas), o usuário cujo dia de demissão chegou,
 * as pessoas com senha cuja projeção de `senha_hash` mudou com a configuração (SYNC 4.1).
 * Sem isso as linhas antigas ficam abaixo do cursor do terminal e nunca descem. O `fn_versao` ignora UPDATE sem
 * mudança real; o toque liga `genesis.forcar_versao` só durante os próprios UPDATEs (migração 0008) e desliga em
 * seguida, na mesma transação. Quem chama já pegou a trava de ordenação (`travaVersao`), como toda escrita
 * sincronizável.
 */
import { sql } from 'drizzle-orm';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Filhas de `pessoas` que descem pela relevância da pessoa (fluxo `pessoas`, MD 6.2). */
const FILHAS_PESSOA = [
  'pessoas_categorias',
  'pessoas_enderecos',
  'pessoas_telefones',
  'saldos_credito_pessoas',
  'parcelas_credito_pessoas',
  'saldos_vasilhame_pessoas',
] as const;

const lista = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/** Ids por UPDATE: um parâmetro por id, abaixo do limite de 65.535 parâmetros por consulta do PostgreSQL. */
const IDS_POR_TOQUE = 10_000;

/**
 * Versão nova para as linhas de `tabela` cuja `coluna` está em `ids`. Com `soVivas`, só as não excluídas (uma filha
 * excluída que o PDV nunca teve não precisa descer como tombstone). Devolve quantas linhas foram tocadas. Muitos ids
 * (ex.: todas as pessoas com senha, na troca da exigência de senha) vão em fatias de `IDS_POR_TOQUE`.
 */
export async function tocar(
  tx: DbEmpresa,
  tabela: string,
  coluna: string,
  ids: readonly string[],
  soVivas = false,
): Promise<number> {
  if (!ids.length) return 0;
  const unicos = [...new Set(ids)];
  let tocadas = 0;
  await tx.execute(sql`select set_config('genesis.forcar_versao', 'on', true)`);
  for (let i = 0; i < unicos.length; i += IDS_POR_TOQUE) {
    const r = await tx.execute(
      sql`update ${sql.identifier(tabela)} set atualizado_em = now()
          where ${sql.identifier(coluna)} in (${lista(unicos.slice(i, i + IDS_POR_TOQUE))})${soVivas ? sql` and excluido_em is null` : sql``}`,
    );
    tocadas += r.rowCount ?? 0;
  }
  // Sem `finally`: num erro a transação inteira é desfeita e a configuração local vai junto.
  await tx.execute(sql`select set_config('genesis.forcar_versao', 'off', true)`);
  return tocadas;
}

/** Pessoa e filhas vivas (MD 3.5.4: "ao criar a linha, a API toca a pessoa e as filhas"). */
export async function tocarPessoas(tx: DbEmpresa, pessoaIds: readonly string[]): Promise<void> {
  if (!pessoaIds.length) return;
  await tocar(tx, 'pessoas', 'id', pessoaIds);
  for (const filha of FILHAS_PESSOA) await tocar(tx, filha, 'pessoa_id', pessoaIds, true);
}
