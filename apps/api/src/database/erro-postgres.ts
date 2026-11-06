/** Campos do erro do driver `pg` (`DatabaseError`) que a API lê: SQLSTATE, restrição, tabela, coluna e detalhe. */
export interface ErroDriverPg {
  code?: unknown;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
  message?: string;
}

/**
 * O erro do driver por trás do que foi lançado. O Drizzle embrulha toda falha de consulta feita por ele
 * (`tx.insert`, `tx.update`, `tx.select`…) em `DrizzleQueryError`, com a mensagem "Failed query: …" e o erro do `pg`
 * só em `.cause`; o SQL cru (`c.query`) lança o erro do `pg` direto. Desce pelos `.cause` até achar um `code` (no
 * máximo alguns níveis) ou até o último erro da cadeia (queda de conexão sem `code`, por exemplo).
 */
export function erroDoDriver(e: unknown): ErroDriverPg {
  let atual = e;
  for (let nivel = 0; nivel < 5; nivel++) {
    if (!atual || typeof atual !== 'object') return {};
    const { code, cause } = atual as { code?: unknown; cause?: unknown };
    if (code !== undefined || !cause || typeof cause !== 'object') return atual as ErroDriverPg;
    atual = cause;
  }
  return atual as ErroDriverPg;
}
