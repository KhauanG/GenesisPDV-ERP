import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { posMigracaoSemAdmin } from '../../src/plataforma/provisionamento.js';
import { consultar, criarAmbiente, SENHA_TESTE, type Ambiente, type EmpresaTeste } from './ambiente.js';

let amb: Ambiente;
let empresas: EmpresaTeste[];
let pasta: string;

/** Acrescenta uma migração ao journal de uma cópia da pasta `drizzle/empresa`. */
function acrescentarMigracao(tag: string, sql: string): void {
  const caminho = join(pasta, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(caminho, 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  const ultima = journal.entries.at(-1)!;
  journal.entries.push({ ...ultima, idx: ultima.idx + 1, when: ultima.when + 1000, tag });
  writeFileSync(caminho, JSON.stringify(journal, null, 2));
  writeFileSync(join(pasta, `${tag}.sql`), sql);
}

const login = (codigo: number) =>
  amb.http().post('/api/auth/login').send({ codigoEmpresa: codigo, login: 'admin', senha: SENHA_TESTE });

beforeAll(async () => {
  amb = await criarAmbiente();
  empresas = [];
  for (let i = 0; i < 3; i++) {
    const e = await amb.criarEmpresa({ canario: i === 0 });
    await amb.entrar(e.codigo, 'admin', e.senha);
    empresas.push(e);
  }
  pasta = mkdtempSync(join(tmpdir(), 'genesis-migracoes-'));
  cpSync(PASTA_MIGRACOES_EMPRESA, pasta, { recursive: true });
});

afterAll(async () => {
  if (pasta) rmSync(pasta, { recursive: true, force: true });
  await amb?.fechar();
});

async function statusMigracao(tag: string) {
  return consultar<{ codigo: number; status: string; erro: string | null }>(
    amb.bancoControle,
    'select e.codigo, m.status, m.erro from migracoes_empresas m join empresas e on e.id = m.empresa_id where m.migracao = $1 order by e.codigo',
    [tag],
  );
}

describe('db:migrate:empresas (ADR-02; MD 2.12; ERP 19.7)', () => {
  it('aplica uma migração nova nas 3 empresas, canário primeiro, com hash registrado', async () => {
    acrescentarMigracao('0003_teste_coluna', 'alter table empresa add column teste_fase0 varchar(10);');
    const r = await amb.servicos.migrador.migrarTodas({
      pasta,
      posMigracao: posMigracaoSemAdmin(amb.servicos.controle),
    });
    expect(r.falhas).toBe(0);
    expect(r.canarios.map((c) => c.codigo)).toEqual([empresas[0]!.codigo]);
    expect(r.demais.map((c) => c.codigo)).toEqual([empresas[1]!.codigo, empresas[2]!.codigo]);
    for (const x of [...r.canarios, ...r.demais]) {
      expect(x).toMatchObject({
        status: 'ok',
        aplicadas: ['0003_teste_coluna'],
        versaoSchema: '0003_teste_coluna',
      });
    }
    const st = await statusMigracao('0003_teste_coluna');
    expect(st.map((s) => s.status)).toEqual(['aplicada', 'aplicada', 'aplicada']);
    for (const e of empresas) {
      const col = await consultar(
        e.nomeBanco,
        "select 1 from information_schema.columns where table_name = 'empresa' and column_name = 'teste_fase0'",
      );
      expect(col).toHaveLength(1);
      const drizzle = await consultar<{ n: number }>(
        e.nomeBanco,
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      expect(drizzle[0]!.n).toBe(lerMigracoes(PASTA_MIGRACOES_EMPRESA).length + 1);
    }
    const [aud] = await consultar(
      amb.bancoControle,
      "select depois->>'falhas' as falhas from auditoria_plataforma where acao = 'migracao_executada' order by criado_em desc limit 1",
    );
    expect(aud).toEqual({ falhas: '0' });
    // Rodar de novo não reaplica nada.
    const de_novo = await amb.servicos.migrador.migrarTodas({ pasta });
    expect(
      [...de_novo.canarios, ...de_novo.demais].every((x) => x.status === 'ok' && x.aplicadas.length === 0),
    ).toBe(true);
  });

  it('falha forçada numa empresa: só ela fica em manutenção (503); as outras seguem', async () => {
    const [, segunda, terceira] = empresas;
    // Objeto conflitante só na 3ª empresa faz a migração falhar lá.
    await consultar(terceira!.nomeBanco, 'create table teste_conflito (id int)');
    acrescentarMigracao(
      '0004_teste_tabela',
      'create table teste_conflito (id uuid primary key, nome varchar(10));',
    );
    // Situação (ERP 19.7) antes de aplicar: todas atrasadas pela versao_schema × journal.
    const antes = await amb.servicos.migrador.situacao({ pasta });
    expect(antes.versaoAtual).toBe('0004_teste_tabela');
    expect(antes.resumo).toMatchObject({ empresas: 3, atrasadas: 3, comErro: 0 });
    expect(antes.empresas.map((e) => [e.situacao, e.pendentes])).toEqual([
      ['atrasada', ['0004_teste_tabela']],
      ['atrasada', ['0004_teste_tabela']],
      ['atrasada', ['0004_teste_tabela']],
    ]);
    // Simular lê o registro do próprio banco da empresa e traz o SQL, sem aplicar.
    const sim = await amb.servicos.migrador.simular({ pasta, codigo: terceira!.codigo });
    expect(sim).toMatchObject({
      fonte: 'banco',
      empresas: [{ codigo: terceira!.codigo, pendentes: ['0004_teste_tabela'], alteradas: [] }],
    });
    expect(sim!.migracoes).toEqual([
      expect.objectContaining({ tag: '0004_teste_tabela', sql: expect.stringContaining('teste_conflito') }),
    ]);
    const simTodas = await amb.servicos.migrador.simular({ pasta });
    expect(simTodas!.fonte).toBe('versao_schema');
    expect(simTodas!.empresas).toHaveLength(3);
    expect(await consultar(terceira!.nomeBanco, "select to_regclass('teste_conflito') as t")).toEqual([
      { t: 'teste_conflito' },
    ]);
    expect(await amb.servicos.migrador.simular({ pasta, codigo: 999_999 })).toBeNull();

    const r = await amb.servicos.migrador.migrarTodas({ pasta });
    expect(r.falhas).toBe(1);
    expect(r.interrompida).toBe(false);
    const porCodigo = new Map([...r.canarios, ...r.demais].map((x) => [x.codigo, x]));
    expect(porCodigo.get(empresas[0]!.codigo)?.status).toBe('ok');
    expect(porCodigo.get(segunda!.codigo)?.status).toBe('ok');
    expect(porCodigo.get(terceira!.codigo)).toMatchObject({ status: 'falhou' });
    expect(porCodigo.get(terceira!.codigo)?.erro).toMatch(/already exists|já existe/);

    const st = await statusMigracao('0004_teste_tabela');
    expect(st.map((s) => s.status)).toEqual(['aplicada', 'aplicada', 'falhou']);

    const depois = await amb.servicos.migrador.situacao({ pasta });
    expect(depois.resumo).toMatchObject({ empresas: 3, emDia: 2, atrasadas: 1, comErro: 1 });
    const comErro = await amb.servicos.migrador.situacao({ pasta, filtro: 'com_erro' });
    expect(comErro.empresas).toEqual([
      expect.objectContaining({
        codigo: terceira!.codigo,
        situacao: 'com_erro',
        pendentes: ['0004_teste_tabela'],
        migracaoComErro: '0004_teste_tabela',
        erro: expect.stringMatching(/already exists|já existe/),
      }),
    ]);
    expect(depois.execucoes[0]).toMatchObject({ falhas: 1, interrompida: false });
    expect(depois.execucoes[0]!.empresas.find((x) => x.codigo === terceira!.codigo)?.status).toBe('falhou');

    const r3 = await login(terceira!.codigo);
    expect(r3.status).toBe(503);
    expect(r3.body.codigo).toBe('MANUTENCAO');
    expect(r3.headers['retry-after']).toBe('60');
    expect((await login(empresas[0]!.codigo)).status).toBe(200);
    expect((await login(segunda!.codigo)).status).toBe(200);
    const [versao] = await consultar(
      amb.bancoControle,
      'select versao_schema from empresas where codigo = $1',
      [terceira!.codigo],
    );
    expect(versao).toEqual({ versao_schema: '0003_teste_coluna' });

    // Corrigido o problema, a próxima execução tira a empresa da manutenção.
    await consultar(terceira!.nomeBanco, 'drop table teste_conflito');
    const r2 = await amb.servicos.migrador.migrarTodas({ pasta, codigos: [terceira!.codigo] });
    expect(r2.falhas).toBe(0);
    expect((await login(terceira!.codigo)).status).toBe(200);
    const corrigida = await amb.servicos.migrador.situacao({ pasta, filtro: 'atrasadas' });
    expect(corrigida.empresas).toEqual([]);
  });

  it('falha no canário interrompe a execução: as demais nem começam', async () => {
    await consultar(empresas[0]!.nomeBanco, 'create table teste_canario (id int)');
    acrescentarMigracao('0005_teste_canario', 'create table teste_canario (id int);');
    const r = await amb.servicos.migrador.migrarTodas({ pasta });
    expect(r.interrompida).toBe(true);
    expect(r.canarios[0]).toMatchObject({ status: 'falhou' });
    expect(r.demais.map((x) => x.status)).toEqual(['nao_executada', 'nao_executada']);
    const st = await statusMigracao('0005_teste_canario');
    expect(st).toHaveLength(1);
    await consultar(empresas[0]!.nomeBanco, 'drop table teste_canario');
    const ok = await amb.servicos.migrador.migrarTodas({ pasta });
    expect(ok.falhas).toBe(0);
  });

  it('avisos de uma preparação de dados chegam ao resultado, ao log do "Aplicar" e à auditoria (F2-B2)', async () => {
    const [, segunda] = empresas;
    acrescentarMigracao('0006_teste_preparacao', 'select 1;');
    // Como a do 0017 (relatório do preenchimento da seq_lancamento): só a 2ª empresa tem o que relatar.
    const r = await amb.servicos.migrador.migrarTodas({
      pasta,
      preparacoes: {
        '0006_teste_preparacao': async (c) => {
          const { rows } = await c.query<{ banco: string }>('select current_database() as banco');
          return rows[0]!.banco === segunda!.nomeBanco
            ? { avisos: ['2 linha(s) com a cadeia quebrada'], dados: { total_quebras: 2 } }
            : { avisos: [], dados: { total_quebras: 0 } };
        },
      },
    });
    expect(r.falhas).toBe(0);
    const porCodigo = new Map([...r.canarios, ...r.demais].map((x) => [x.codigo, x]));
    expect(porCodigo.get(segunda!.codigo)).toMatchObject({
      status: 'ok',
      avisos: ['0006_teste_preparacao: 2 linha(s) com a cadeia quebrada'],
    });
    expect(porCodigo.get(empresas[0]!.codigo)?.avisos).toBeUndefined();
    const s = await amb.servicos.migrador.situacao({ pasta });
    expect(s.execucoes[0]!.empresas.find((x) => x.codigo === segunda!.codigo)?.avisos).toEqual([
      '0006_teste_preparacao: 2 linha(s) com a cadeia quebrada',
    ]);
    // O relato fica registrado por empresa: a segunda passada da preparação já não teria o que contar.
    const aud = await consultar<{ codigo: number; depois: Record<string, unknown> }>(
      amb.bancoControle,
      `select e.codigo, a.depois from auditoria_plataforma a join empresas e on e.id = a.empresa_id
        where a.acao = 'migracao_preparada' and a.depois->>'migracao' = '0006_teste_preparacao' order by e.codigo`,
    );
    expect(aud.map((a) => a.codigo)).toEqual(empresas.map((e) => e.codigo));
    expect(aud.find((a) => a.codigo === segunda!.codigo)!.depois).toMatchObject({
      avisos: ['2 linha(s) com a cadeia quebrada'],
      total_quebras: 2,
    });
  });

  it('migração em andamento não tira a empresa do ar; schema abaixo do mínimo do código, sim', async () => {
    const alvo = empresas[0]!;
    const [m] = await consultar<{ migracao: string }>(
      amb.bancoControle,
      "select m.migracao from migracoes_empresas m join empresas e on e.id = m.empresa_id where e.codigo = $1 and m.status = 'aplicada' order by m.ordem desc limit 1",
      [alvo.codigo],
    );
    await consultar(
      amb.bancoControle,
      "update migracoes_empresas set status = 'aplicando' where migracao = $1 and empresa_id = (select id from empresas where codigo = $2)",
      [m!.migracao, alvo.codigo],
    );
    expect((await login(alvo.codigo)).status).toBe(200);
    await consultar(
      amb.bancoControle,
      "update migracoes_empresas set status = 'aplicada' where migracao = $1 and empresa_id = (select id from empresas where codigo = $2)",
      [m!.migracao, alvo.codigo],
    );
    const [antes] = await consultar<{ versao_schema: string }>(
      amb.bancoControle,
      'select versao_schema from empresas where codigo = $1',
      [alvo.codigo],
    );
    await consultar(
      amb.bancoControle,
      "update empresas set versao_schema = '0001_fundacao' where codigo = $1",
      [alvo.codigo],
    );
    const abaixo = await login(alvo.codigo);
    expect(abaixo.status).toBe(503);
    expect(abaixo.body.codigo).toBe('MANUTENCAO');
    await consultar(amb.bancoControle, 'update empresas set versao_schema = $1 where codigo = $2', [
      antes!.versao_schema,
      alvo.codigo,
    ]);
    expect((await login(alvo.codigo)).status).toBe(200);
  });

  it('migração alterada depois de aplicada é detectada pelo hash e põe a empresa em manutenção', async () => {
    writeFileSync(
      join(pasta, '0003_teste_coluna.sql'),
      'alter table empresa add column teste_fase0 varchar(20);',
    );
    const r = await amb.servicos.migrador.migrarTodas({ pasta, codigos: [empresas[1]!.codigo] });
    expect(r.canarios[0]).toMatchObject({ status: 'falhou' });
    expect(r.canarios[0]!.erro).toMatch(/alterada depois de aplicada/);
    const sim = await amb.servicos.migrador.simular({ pasta, codigo: empresas[1]!.codigo });
    expect(sim!.empresas[0]!.alteradas).toEqual(['0003_teste_coluna']);
    expect((await login(empresas[1]!.codigo)).status).toBe(503);
  });
});
