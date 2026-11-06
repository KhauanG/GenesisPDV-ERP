import { and, inArray, isNull } from 'drizzle-orm';
import { empresas } from '../database/controle/schema.js';
import { executarCli } from './comum.js';

/** Tarefa mensal: garante as partições de `auditoria` dos próximos 12 meses em todas as empresas (MD 3.1.7). */
await executarCli(async (s) => {
  const lista = await s.controle.db
    .select()
    .from(empresas)
    .where(and(inArray(empresas.status, ['ativa', 'suspensa']), isNull(empresas.excluidoEm)));
  let falhas = 0;
  for (const e of lista) {
    try {
      // DDL: com a role dona do banco (a de runtime não cria tabelas, MD 1.4).
      const c = await s.servidores.conectar(e.servidorBancoId, e.nomeBanco, 'genesis_particoes');
      let n = 0;
      try {
        const { rows } = await c.query<{ n: number }>('select fn_auditoria_garantir_particoes(1, 12) as n');
        n = rows[0]?.n ?? 0;
      } finally {
        await c.end();
      }
      console.log(`${e.codigo}: ${n} partição(ões) criada(s)`);
    } catch (erro) {
      falhas++;
      console.error(`${e.codigo}: ${erro instanceof Error ? erro.message : String(erro)}`);
    }
  }
  return falhas ? 1 : 0;
});
