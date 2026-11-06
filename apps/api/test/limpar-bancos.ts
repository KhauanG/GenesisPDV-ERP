/**
 * `pnpm --filter api test:limpar`: remove bancos e roles que os testes de integração e o e2e do PDV deixaram para trás
 * quando a execução foi interrompida (Ctrl+C, CI cancelado, timeout no beforeAll, `kill -9` no servidor do e2e). Só
 * toca o que é dos testes: controles `genesis_t_*_ctl` e `genesis_e2epdv_*_ctl`, os bancos avulsos de migração
 * `genesis_t_*_m<nn>` (`migracao-formas-lojas.test.ts`) e empresas nas faixas de códigos dos testes (800000+) e do e2e
 * do PDV (600000–699999), e só bancos sem conexão ativa (outra execução em andamento não é afetada).
 */
import pg from 'pg';
import { FAIXA_E2E_PDV, FAIXA_TESTES, URL_BASE } from './integracao/ambiente.js';

const url = new URL(URL_BASE);
url.pathname = '/postgres';
const c = new pg.Client({ connectionString: url.toString(), application_name: 'genesis_test_limpar' });
await c.connect();
try {
  const { rows } = await c.query<{ datname: string }>(
    `select d.datname from pg_database d
     where (d.datname ~ '^genesis_t_[a-z0-9]+_(ctl|m[0-9]+)$'
            or d.datname ~ '^genesis_e2epdv_[a-z0-9]+_ctl$'
            or (d.datname ~ '^genesis_emp_[0-9]{6}$'
                and (substring(d.datname from 13)::int between $1 and $2
                     or substring(d.datname from 13)::int between $3 and $4)))
       and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)
     order by 1`,
    [FAIXA_TESTES.inicio, FAIXA_TESTES.fim, FAIXA_E2E_PDV.inicio, FAIXA_E2E_PDV.fim],
  );
  for (const { datname } of rows) {
    await c.query(`drop database if exists "${datname}" with (force)`);
    console.log(`removido: ${datname}`);
  }
  const roles = await c.query<{ rolname: string }>(
    `select r.rolname from pg_roles r
     where r.rolname ~ '^genesis_emp_[0-9]{6}_app$'
       and (substring(r.rolname from 13 for 6)::int between $1 and $2
            or substring(r.rolname from 13 for 6)::int between $3 and $4)
       and not exists (select 1 from pg_database d where d.datname = substring(r.rolname from 1 for 18))`,
    [FAIXA_TESTES.inicio, FAIXA_TESTES.fim, FAIXA_E2E_PDV.inicio, FAIXA_E2E_PDV.fim],
  );
  for (const { rolname } of roles.rows) {
    await c.query(`drop role if exists "${rolname}"`);
    console.log(`role removida: ${rolname}`);
  }
  console.log(`${rows.length} banco(s) e ${roles.rows.length} role(s) de teste removidos.`);
} finally {
  await c.end();
}
