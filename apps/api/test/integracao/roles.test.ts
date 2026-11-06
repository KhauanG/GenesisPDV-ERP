/**
 * Roles separadas (MD 1.4): a API conecta no banco da empresa com a role de runtime dela — sem superusuário, sem DELETE
 * nas tabelas sincronizáveis, auditoria append-only e sem CONNECT no banco de outra empresa.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garantirRoleAplicacao } from '../../src/database/roles-empresa.js';
import { AAD_SENHA_EMPRESA } from '../../src/database/servidores.js';
import {
  consultar,
  criarAmbiente,
  URL_BASE,
  urlDoBanco,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let a: EmpresaTeste;
let b: EmpresaTeste;
let credA: { usuario: string; senha: string };

async function comoRole(banco: string, fn: (c: pg.Client) => Promise<void>) {
  const u = new URL(URL_BASE);
  const c = new pg.Client({
    host: u.hostname,
    port: Number(u.port || 5432),
    database: banco,
    user: credA.usuario,
    password: credA.senha,
  });
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.end();
  }
}

const negado = { code: '42501' };

beforeAll(async () => {
  amb = await criarAmbiente({ comApp: false });
  a = await amb.criarEmpresa();
  b = await amb.criarEmpresa();
  const [e] = await consultar<{ usuario: string; senha: Buffer }>(
    amb.bancoControle,
    'select usuario_banco as usuario, senha_banco_cifrada as senha from empresas where codigo = $1',
    [a.codigo],
  );
  credA = { usuario: e!.usuario, senha: amb.servicos.cifra.decifrarTexto(e!.senha, AAD_SENHA_EMPRESA) };
});

afterAll(async () => {
  await amb?.fechar();
});

describe('role de runtime por empresa (MD 1.4)', () => {
  it('é a role usada pelos pools da API e não é superusuário nem dona do banco', async () => {
    expect(credA.usuario).toBe(`${a.nomeBanco}_app`);
    const [r] = await consultar(
      'postgres',
      'select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname = $1',
      [credA.usuario],
    );
    expect(r).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
    const ctx = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(a.codigo))!);
    const usuario = await amb.servicos.tenancy.executarNaEmpresa(ctx, () =>
      amb.servicos.tenancy
        .cx()
        .consulta(async (_db, c) => (await c.query('select current_user as u')).rows[0].u),
    );
    expect(usuario).toBe(credA.usuario);
  });

  it('sem DELETE/TRUNCATE nas tabelas C/D/P/R; auditoria append-only; L aceita DELETE', async () => {
    await comoRole(a.nomeBanco, async (c) => {
      expect((await c.query('select count(*)::int as n from lojas')).rows[0].n).toBeGreaterThanOrEqual(0);
      await expect(c.query('delete from perfis')).rejects.toMatchObject(negado);
      await expect(c.query('truncate usuarios')).rejects.toMatchObject(negado);
      await expect(c.query("update auditoria set descricao = 'adulterada'")).rejects.toMatchObject(negado);
      await expect(c.query('delete from auditoria')).rejects.toMatchObject(negado);
      await expect(c.query('truncate auditoria')).rejects.toMatchObject(negado);
      await c.query('delete from historico_logins where false');
      // Fase 1A: cadastros, documentos e projeções também sem DELETE (exclusão lógica, MD 1.4); L aceita.
      for (const t of [
        'produtos',
        'pessoas',
        'produtos_codigos_barras',
        'movimentos_estoque',
        'saldos_estoque',
        'ncms',
      ]) {
        await expect(c.query(`delete from ${t}`), t).rejects.toMatchObject(negado);
      }
      await c.query('delete from produtos_historico_precos where false');
      await expect(c.query('create table invasora (id int)')).rejects.toMatchObject(negado);
      await expect(c.query('alter table usuarios disable trigger tg_usuarios_versao')).rejects.toBeDefined();
    });
  });

  it('não conecta no banco de outra empresa (CONNECT só para a própria role)', async () => {
    await expect(comoRole(b.nomeBanco, async () => undefined)).rejects.toMatchObject(negado);
  });
});

describe('dona do banco sem SUPERUSER, como o usuário genesis no Cloud SQL (Implantação do piloto, I1)', () => {
  it('cria e depois atualiza a role de runtime só com CREATEDB e CREATEROLE', async () => {
    const dono = `genesis_t_dono_${randomBytes(4).toString('hex')}`;
    const senhaDono = randomBytes(12).toString('hex');
    const nomeBanco = `genesis_emp_${amb.proximoCodigo()}`;
    await consultar('postgres', `create role "${dono}" login createdb createrole password '${senhaDono}'`);
    const comoDono = async (banco: string, fn: (c: pg.Client) => Promise<void>) => {
      const u = new URL(urlDoBanco(banco));
      u.username = dono;
      u.password = senhaDono;
      const c = new pg.Client({ connectionString: u.toString() });
      await c.connect();
      try {
        await fn(c);
      } finally {
        await c.end();
      }
    };
    try {
      await comoDono('postgres', async (c) => {
        await c.query(`create database "${nomeBanco}" template template0 encoding 'UTF8'`);
      });
      await comoDono(nomeBanco, async (c) => {
        await c.query('create sequence seq_codigo_produtos');
        await garantirRoleAplicacao(c, nomeBanco, randomBytes(12).toString('hex'));
        // Segunda vez = `alter role` (toda migração reaplica): no PostgreSQL 16+ não pode citar SUPERUSER etc.
        await garantirRoleAplicacao(c, nomeBanco, randomBytes(12).toString('hex'));
      });
      const [r] = await consultar(
        'postgres',
        `select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
           from pg_roles where rolname = $1`,
        [`${nomeBanco}_app`],
      );
      expect(r).toEqual({
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      });
    } finally {
      await consultar('postgres', `drop database if exists "${nomeBanco}" with (force)`);
      await consultar('postgres', `drop role if exists "${nomeBanco}_app"`);
      await consultar('postgres', `drop role if exists "${dono}"`);
    }
  });
});
