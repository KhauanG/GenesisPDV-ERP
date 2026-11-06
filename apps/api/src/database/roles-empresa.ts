/**
 * Role de runtime por empresa (MD 1.4; README › Decisões de implementação): NOSUPERUSER, sem ser dona de nada,
 * única com CONNECT no banco da empresa (o PUBLIC perde o CONNECT), `select/insert/update` nas tabelas, sem
 * `delete`/`truncate` nas C/D/P/R e sem `update`/`delete` na `auditoria` (append-only). Só as tabelas L (sem
 * `versao`) aceitam `delete` (purga por retenção). A role dona do banco (a do `servidores_banco`) só é usada pelo
 * provisionamento, pelas migrações e pelas cargas de referência/seed.
 */
import type pg from 'pg';
import { PADRAO_BANCO_EMPRESA } from './nomes-bancos.js';

export const sufixoRoleAplicacao = '_app';

export function nomeRoleAplicacao(nomeBanco: string): string {
  if (!PADRAO_BANCO_EMPRESA.test(nomeBanco)) throw new Error(`Banco de empresa inválido: ${nomeBanco}`);
  return `${nomeBanco}${sufixoRoleAplicacao}`;
}

const id = (nome: string) => `"${nome.replace(/"/g, '""')}"`;

/** Atributos na criação da role (o PostgreSQL aceita NOSUPERUSER/NOREPLICATION/NOBYPASSRLS de quem tem CREATEROLE). */
const ATRIBUTOS_CRIACAO = 'login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls';
/**
 * Na atualização, só o que uma role com CREATEROLE e sem SUPERUSER pode mudar: no PostgreSQL 16+ um `alter role` que
 * cite SUPERUSER, REPLICATION ou BYPASSRLS (mesmo com o valor atual) exige ter esses atributos. É o caso do usuário
 * `genesis` no Cloud SQL (cloudsqlsuperuser: CREATEDB e CREATEROLE; Implantação do piloto, I1).
 */
const ATRIBUTOS_ATUALIZACAO = 'login nocreatedb nocreaterole noinherit';
const literal = (valor: string) => `'${valor.replace(/'/g, "''")}'`;

/**
 * Cria (ou atualiza a senha da) role e reaplica os privilégios no banco — idempotente, roda depois de toda migração
 * (tabelas novas entram nos grants). `cliente` = conexão da role dona no banco da empresa (precisa de CREATEROLE).
 */
export async function garantirRoleAplicacao(
  cliente: pg.ClientBase,
  nomeBanco: string,
  senha: string,
): Promise<string> {
  const role = nomeRoleAplicacao(nomeBanco);
  const { rowCount } = await cliente.query('select 1 from pg_roles where rolname = $1', [role]);
  if (!rowCount) {
    await cliente.query(`create role ${id(role)} with ${ATRIBUTOS_CRIACAO} password ${literal(senha)}`);
  } else {
    await cliente.query(`alter role ${id(role)} with ${ATRIBUTOS_ATUALIZACAO} password ${literal(senha)}`);
    // SUPERUSER, REPLICATION e BYPASSRLS só um superusuário liga; se alguém ligou, a role não serve para o runtime.
    const { rows } = await cliente.query<{ perigosa: boolean }>(
      'select rolsuper or rolreplication or rolbypassrls as perigosa from pg_roles where rolname = $1',
      [role],
    );
    if (rows[0]?.perigosa) {
      throw new Error(
        `A role ${role} tem SUPERUSER, REPLICATION ou BYPASSRLS; um superusuário precisa tirar esses atributos.`,
      );
    }
  }
  await cliente.query('begin');
  try {
    await cliente.query(`revoke all on database ${id(nomeBanco)} from public`);
    await cliente.query(`grant connect on database ${id(nomeBanco)} to ${id(role)}`);
    await cliente.query('revoke all on schema public from public');
    await cliente.query(`grant usage on schema public to ${id(role)}`);
    await cliente.query(`revoke all on all tables in schema public from ${id(role)}`);
    const { rows } = await cliente.query<{ tabela: string; com_versao: boolean; particao: boolean }>(
      `select c.relname as tabela, c.relispartition as particao,
              exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'versao' and not a.attisdropped) as com_versao
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')`,
    );
    for (const t of rows) {
      // Partições da `auditoria` ficam sem privilégio: o acesso pela tabela-mãe basta.
      if (t.particao) continue;
      const privilegios =
        t.tabela === 'auditoria'
          ? 'select, insert'
          : t.com_versao
            ? 'select, insert, update'
            : 'select, insert, update, delete';
      await cliente.query(`grant ${privilegios} on table ${id(t.tabela)} to ${id(role)}`);
    }
    await cliente.query(`grant usage, select on all sequences in schema public to ${id(role)}`);
    // Só a dos produtos aceita `setval`: o próximo código salta de uma vez a faixa ocupada pelos códigos explícitos da
    // importação (IdProduto do Nuvem3, decisão 102; `proximoCodigoProduto`).
    await cliente.query(`grant update on sequence seq_codigo_produtos to ${id(role)}`);
    await cliente.query('commit');
  } catch (e) {
    await cliente.query('rollback').catch(() => undefined);
    throw e;
  }
  return role;
}

/** Remove a role junto com o banco descartado (provisionamento descartado). */
export async function removerRoleAplicacao(cliente: pg.ClientBase, nomeBanco: string): Promise<void> {
  await cliente.query(`drop role if exists ${id(nomeRoleAplicacao(nomeBanco))}`);
}
