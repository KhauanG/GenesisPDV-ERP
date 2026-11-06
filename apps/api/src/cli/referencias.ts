import { posMigracaoSemAdmin } from '../plataforma/provisionamento.js';
import { argumentos, executarCli } from './comum.js';

const args = argumentos({ empresas: { type: 'string' } });

/** `db:referencias`: recarrega referências nacionais, catálogo de permissões e seed idempotente em todas as empresas. */
await executarCli(async (s) => {
  const codigos = args.empresas?.split(',').map((c) => Number(c.trim()));
  const r = await s.migrador.migrarTodas({ codigos, posMigracao: posMigracaoSemAdmin(s.controle) });
  for (const e of [...r.canarios, ...r.demais])
    console.log(`${e.codigo}: ${e.status}${e.erro ? ` – ${e.erro}` : ''}`);
  return r.falhas > 0 ? 1 : 0;
});
