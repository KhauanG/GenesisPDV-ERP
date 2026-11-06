import { setTimeout as esperar } from 'node:timers/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLUNAS_ISENTAS_VERSAO,
  TABELAS_FN_VERSAO,
  TABELAS_FN_VERSAO_LOCAL,
} from '../../src/database/empresa/versionamento.js';
import { nomeTabela, REGISTRO_FLUXOS } from '../../src/sync/fluxos.js';
import { conectar, consultar, criarAmbiente, type Ambiente, type EmpresaTeste } from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;

beforeAll(async () => {
  amb = await criarAmbiente({ comApp: false });
  emp = await amb.criarEmpresa();
});

afterAll(async () => {
  await amb?.fechar();
});

/** Pull do PDV: tudo com versao > cursor, em ordem de versao (MD 1.5). */
async function pull(
  c: pg.Client,
  tabela: string,
  cursor: number,
): Promise<Array<{ id: string; versao: number }>> {
  const { rows } = await c.query<{ id: string; versao: string }>(
    `select id, versao from ${tabela} where versao > $1 order by versao`,
    [cursor],
  );
  return rows.map((r) => ({ id: r.id, versao: Number(r.versao) }));
}

async function esperandoTrava(c: pg.Client, pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const { rows } = await c.query<{ wait_event_type: string | null; wait_event: string | null }>(
      'select wait_event_type, wait_event from pg_stat_activity where pid = $1',
      [pid],
    );
    if (rows[0]?.wait_event_type === 'Lock' && rows[0]?.wait_event === 'advisory') return true;
    await esperar(20);
  }
  return false;
}

describe('versao, seq_versao e trava de ordenação (MD 1.5)', () => {
  it('cada tabela tem o trigger certo; seq_versao tem cache 1', async () => {
    const triggers = await consultar<{ tabela: string; funcao: string }>(
      emp.nomeBanco,
      `select c.relname as tabela, p.proname as funcao from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
       where not t.tgisinternal and t.tgname = 'tg_' || c.relname || '_versao'`,
    );
    const mapa = new Map(triggers.map((t) => [t.tabela, t.funcao]));
    for (const t of TABELAS_FN_VERSAO) expect(mapa.get(t), t).toBe('fn_versao');
    for (const t of TABELAS_FN_VERSAO_LOCAL) expect(mapa.get(t), t).toBe('fn_versao_local');
    const comVersao = await consultar<{ table_name: string }>(
      emp.nomeBanco,
      "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'versao'",
    );
    for (const { table_name } of comVersao)
      expect(mapa.has(table_name), `${table_name} sem trigger de versão`).toBe(true);
    const [seq] = await consultar(
      emp.nomeBanco,
      "select cache_size::int from pg_sequences where sequencename = 'seq_versao'",
    );
    expect(seq).toEqual({ cache_size: 1 });
    const [seqControle] = await consultar(
      amb.bancoControle,
      "select cache_size::int from pg_sequences where sequencename = 'seq_versao'",
    );
    expect(seqControle).toEqual({ cache_size: 1 });
  });

  it('INSERT/UPDATE geram versão nova; UPDATE sem mudança real não; criado_em é imutável', async () => {
    const c = await conectar(emp.nomeBanco);
    try {
      const {
        rows: [p],
      } = await c.query("insert into perfis (nome) values ('Perfil versão') returning id, versao, criado_em");
      const {
        rows: [igual],
      } = await c.query("update perfis set nome = 'Perfil versão' where id = $1 returning versao", [p.id]);
      expect(igual.versao).toBe(p.versao);
      const {
        rows: [mudou],
      } = await c.query(
        "update perfis set nome = 'Perfil versão 2', criado_em = now() - interval '1 day' where id = $1 returning versao, criado_em, atualizado_em",
        [p.id],
      );
      expect(Number(mudou.versao)).toBeGreaterThan(Number(p.versao));
      expect(mudou.criado_em).toEqual(p.criado_em);
    } finally {
      await c.end();
    }
  });

  it('colunas isentas (0011): argumentos dos triggers = COLUNAS_ISENTAS_VERSAO, colunas existem e não descem', async () => {
    const triggers = await consultar<{ tabela: string; definicao: string }>(
      emp.nomeBanco,
      `select c.relname as tabela, pg_get_triggerdef(t.oid) as definicao from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
       where not t.tgisinternal and n.nspname = 'public' and t.tgname = 'tg_' || c.relname || '_versao'`,
    );
    const argumentos = new Map(
      triggers.map((t): [string, string[]] => {
        const lista = /EXECUTE FUNCTION \w+\((.*)\)$/.exec(t.definicao)![1]!;
        return [t.tabela, lista ? lista.split(', ').map((a) => a.replace(/^'|'$/g, '')) : []];
      }),
    );
    for (const [tabela, args] of argumentos)
      expect(args, `${tabela}: argumentos do trigger de versão`).toEqual(
        COLUNAS_ISENTAS_VERSAO[tabela] ?? [],
      );
    // Coluna gerada chega nula no NEW do trigger BEFORE: fora da lista, todo UPDATE da tabela geraria versão nova.
    const geradas = await consultar<{ tabela: string; coluna: string }>(
      emp.nomeBanco,
      `select table_name as tabela, column_name as coluna from information_schema.columns
       where table_schema = 'public' and is_generated = 'ALWAYS'`,
    );
    const ehGerada = new Set(geradas.map((g) => `${g.tabela}.${g.coluna}`));
    for (const { tabela, coluna } of geradas)
      if (argumentos.has(tabela))
        expect(COLUNAS_ISENTAS_VERSAO[tabela] ?? [], `${tabela}.${coluna} gerada e isenta`).toContain(coluna);
    for (const [tabela, colunas] of Object.entries(COLUNAS_ISENTAS_VERSAO)) {
      expect(argumentos.has(tabela), tabela).toBe(true);
      const existentes = await consultar<{ column_name: string }>(
        emp.nomeBanco,
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
        [tabela],
      );
      const nomes = new Set(existentes.map((c) => c.column_name));
      // Isenta e lida pelo PDV seria coluna que muda sem descer: o caixa ficaria com o valor velho para sempre. A
      // gerada pode descer: só muda junto das colunas de que deriva, que versionam.
      const doFluxo = Object.values(REGISTRO_FLUXOS)
        .flat()
        .find((t) => nomeTabela(t.tabela) === tabela);
      for (const coluna of colunas) {
        expect(nomes.has(coluna), `${tabela}.${coluna} existe`).toBe(true);
        if (doFluxo && !ehGerada.has(`${tabela}.${coluna}`))
          expect(doFluxo.omitir ?? [], `${tabela}.${coluna} no omitir`).toContain(coluna);
      }
    }
  });

  it('coluna isenta: sozinha não gera versão nem pega a trava; com outra coluna ou no toque, gera', async () => {
    const c = await conectar(emp.nomeBanco);
    const outra = await conectar(emp.nomeBanco);
    try {
      // Trigger fora do padrão tg_<tabela>_versao (tabela temporária, só desta conexão).
      await c.query(`create temp table teste_isentas (id int primary key, nome text, projecao numeric,
          criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(),
          versao bigint not null default 0);
        create trigger tg_teste_isentas before insert or update on teste_isentas
          for each row execute function fn_versao('projecao');
        insert into teste_isentas (id, nome, projecao) values (1, 'a', 1);`);
      const linha = async () =>
        (
          await c.query<{ nome: string; projecao: string; versao: string; atualizado_em: Date }>(
            'select nome, projecao::text, versao, atualizado_em from teste_isentas where id = 1',
          )
        ).rows[0]!;
      const v0 = await linha();
      // Só a isenta: grava o valor, mesma versão, sem a trava 7300001 (outra conexão a pega sem esperar).
      await c.query('begin');
      await c.query('update teste_isentas set projecao = 2 where id = 1');
      await outra.query('begin');
      const { rows: livre } = await outra.query<{ ok: boolean }>(
        'select pg_try_advisory_xact_lock(7300001) as ok',
      );
      await outra.query('rollback');
      await c.query('commit');
      expect(livre[0]!.ok).toBe(true);
      const v1 = await linha();
      expect(v1).toEqual({ ...v0, projecao: '2' });
      // Isenta junto de outra coluna: versão nova.
      await c.query("update teste_isentas set projecao = 3, nome = 'b' where id = 1");
      const v2 = await linha();
      expect(Number(v2.versao)).toBeGreaterThan(Number(v1.versao));
      // Toque (0008) continua valendo mesmo quando só a isenta muda.
      await c.query('begin');
      await c.query("select set_config('genesis.forcar_versao', 'on', true)");
      await c.query('update teste_isentas set projecao = 4 where id = 1');
      await c.query('commit');
      expect(Number((await linha()).versao)).toBeGreaterThan(Number(v2.versao));
    } finally {
      await Promise.all([c.end(), outra.end()]);
    }
  });

  it('transações concorrentes: a 2ª espera a trava e o pull por versao nunca pula a linha da 1ª', async () => {
    const t1 = await conectar(emp.nomeBanco);
    const t2 = await conectar(emp.nomeBanco);
    const pdv = await conectar(emp.nomeBanco);
    try {
      const inicial = await pdv.query<{ v: string }>('select coalesce(max(versao), 0) as v from perfis');
      let cursor = Number(inicial.rows[0]!.v);
      const pid2 = (await t2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;

      await t1.query('begin');
      const {
        rows: [linha1],
      } = await t1.query<{ id: string; versao: string }>(
        "insert into perfis (nome) values ('Concorrente 1') returning id, versao",
      );

      await t2.query('begin');
      const insercao2 = t2.query<{ id: string; versao: string }>(
        "insert into perfis (nome) values ('Concorrente 2') returning id, versao",
      );
      let t2Terminou = false;
      void insercao2.then(() => (t2Terminou = true));
      // A 2ª transação fica parada na trava de ordenação enquanto a 1ª não confirma.
      expect(await esperandoTrava(pdv, pid2)).toBe(true);
      expect(t2Terminou).toBe(false);
      expect(await pull(pdv, 'perfis', cursor)).toEqual([]);

      await t1.query('commit');
      const {
        rows: [linha2],
      } = await insercao2;
      expect(Number(linha2!.versao)).toBeGreaterThan(Number(linha1!.versao));

      // Pull entre o commit de T1 e o de T2: vê só T1 e o cursor para nela.
      const parcial = await pull(pdv, 'perfis', cursor);
      expect(parcial).toEqual([{ id: linha1!.id, versao: Number(linha1!.versao) }]);
      cursor = parcial.at(-1)!.versao;

      await t2.query('commit');
      const resto = await pull(pdv, 'perfis', cursor);
      expect(resto).toEqual([{ id: linha2!.id, versao: Number(linha2!.versao) }]);
    } finally {
      await Promise.all([t1.end(), t2.end(), pdv.end()]);
    }
  });

  it('controle negativo: sem a trava (fn_versao_local) o mesmo cenário pula uma linha', async () => {
    const c = await conectar(emp.nomeBanco);
    await c.query(`create table teste_sem_trava (id uuid primary key default fn_uuid_v7(), criado_em timestamptz not null default now(),
      atualizado_em timestamptz not null default now(), versao bigint not null);
      create trigger tg_teste_sem_trava_versao before insert or update on teste_sem_trava for each row execute function fn_versao_local();`);
    await c.end();
    const t1 = await conectar(emp.nomeBanco);
    const t2 = await conectar(emp.nomeBanco);
    const pdv = await conectar(emp.nomeBanco);
    try {
      await t1.query('begin');
      const {
        rows: [l1],
      } = await t1.query<{ id: string }>('insert into teste_sem_trava default values returning id');
      await t2.query('begin');
      await t2.query('insert into teste_sem_trava default values');
      await t2.query('commit');
      const vistos = await pull(pdv, 'teste_sem_trava', 0);
      const cursor = vistos.at(-1)!.versao;
      await t1.query('commit');
      const depois = await pull(pdv, 'teste_sem_trava', cursor);
      // A linha de T1 tem versao menor que o cursor: nunca desceria ao PDV.
      expect(depois.find((x) => x.id === l1!.id)).toBeUndefined();
    } finally {
      await Promise.all([t1.end(), t2.end(), pdv.end()]);
    }
  });

  it('carga concorrente: nenhum pull incremental perde linhas (8 escritores × 20 transações)', async () => {
    const escritores = await Promise.all(Array.from({ length: 8 }, () => conectar(emp.nomeBanco)));
    const pdv = await conectar(emp.nomeBanco);
    const inseridos = new Set<string>();
    const vistos = new Set<string>();
    let cursor = Number(
      (await pdv.query<{ v: string }>('select coalesce(max(versao), 0) as v from unidades_medida')).rows[0]!
        .v,
    );
    let ativo = true;
    try {
      const leitor = (async () => {
        while (ativo) {
          const novos = await pull(pdv, 'unidades_medida', cursor);
          for (const n of novos) vistos.add(n.id);
          if (novos.length) cursor = novos.at(-1)!.versao;
          await esperar(2);
        }
      })();
      await Promise.all(
        escritores.map(async (c, w) => {
          for (let i = 0; i < 20; i++) {
            await c.query('begin');
            const { rows } = await c.query<{ id: string }>(
              'insert into unidades_medida (sigla, descricao) values ($1, $2) returning id',
              [`W${w}${i.toString(36).padStart(2, '0')}`, `Carga ${w}/${i}`],
            );
            // Transação "longa" com tempo variável entre pegar a versão e confirmar.
            await esperar(Math.floor(Math.random() * 6));
            if (i % 7 === 3) {
              await c.query('rollback');
              continue;
            }
            await c.query('commit');
            inseridos.add(rows[0]!.id);
          }
        }),
      );
      ativo = false;
      await leitor;
      for (const n of await pull(pdv, 'unidades_medida', cursor)) vistos.add(n.id);
      expect(inseridos.size).toBeGreaterThan(100);
      const perdidos = [...inseridos].filter((id) => !vistos.has(id));
      expect(perdidos).toEqual([]);
    } finally {
      ativo = false;
      await Promise.all([...escritores.map((c) => c.end()), pdv.end()]);
    }
  });

  it('fn_protege_imutavel bloqueia alteração de documento efetivado (MD 1.6)', async () => {
    const c = await conectar(emp.nomeBanco);
    try {
      await c.query(`create table teste_documento (id int primary key, status varchar(10), valor int, versao bigint, atualizado_em timestamptz);
        create trigger tg_teste_documento_imutavel before update on teste_documento
          for each row execute function fn_protege_imutavel('status', 'rascunho', 'status,versao,atualizado_em');
        insert into teste_documento values (1, 'rascunho', 10, 0, now());`);
      await c.query('update teste_documento set valor = 20 where id = 1');
      await c.query("update teste_documento set status = 'efetivado' where id = 1");
      await expect(c.query('update teste_documento set valor = 30 where id = 1')).rejects.toThrow(
        'DOCUMENTO_IMUTAVEL',
      );
      await c.query('update teste_documento set versao = 5 where id = 1');
    } finally {
      await c.end();
    }
  });

  it('fn_trava_versao: primeira instrução da transação, reentrante com o trigger (MD 1.5)', async () => {
    const t1 = await conectar(emp.nomeBanco);
    const t2 = await conectar(emp.nomeBanco);
    try {
      await t1.query('begin');
      await t1.query('select fn_trava_versao()');
      await t1.query("insert into perfis (nome) values ('Com trava explícita')");
      const pid2 = (await t2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await t2.query('begin');
      const espera = t2.query('select fn_trava_versao()');
      expect(await esperandoTrava(t1, pid2)).toBe(true);
      await t1.query('commit');
      await espera;
      await t2.query('rollback');
    } finally {
      await Promise.all([t1.end(), t2.end()]);
    }
  });

  it('fn_unaccent e extensões disponíveis', async () => {
    const [r] = await consultar(
      emp.nomeBanco,
      "select fn_unaccent('Ação Pão Açaí') as s, (select string_agg(extname, ',' order by extname) from pg_extension where extname in ('pg_trgm','unaccent','btree_gist')) as ext, fn_uuid_v7()::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7' as v7",
    );
    expect(r).toEqual({ s: 'Acao Pao Acai', ext: 'btree_gist,pg_trgm,unaccent', v7: true });
  });
});
