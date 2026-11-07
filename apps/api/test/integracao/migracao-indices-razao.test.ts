/**
 * Migração 0026 (Fase 2, F2-B28; README da API › decisão 176) em empresa nova e em empresa existente: as duas terminam
 * com o `ix_movimentos_estoque_estoque_data` e o `ix_movimentos_estoque_linha_data` válidos e iguais. Pelo executor
 * (o provisionamento da nova e a migração da existente, esquema da 0025 com movimentos) quem cria os índices é a
 * preparação da tag, com `concurrently` e fora da transação, e o relato vai a quem migra; a `.sql` só os cria no
 * journal aplicado sem as preparações (com a mesma definição, conferida aqui), refaz o inválido de um `concurrently`
 * interrompido e, com os índices prontos, não pega trava na tabela (as vendas não esperam). A Movimentação de um local
 * por período sai na ordem do cursor direto do índice, sem ordenar; e o saldo de uma linha até o cursor sai só do
 * índice. Os tempos com 4 milhões de movimentos são da massa de carga (`pnpm --filter api carga:razao`).
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garantirBanco } from '../../src/database/migracoes/controle.js';
import { aplicarMigracoes, type RelatoPreparacao } from '../../src/database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import {
  PREPARACOES_MIGRACAO_EMPRESA,
  relatoIndicesRazao,
} from '../../src/database/migracoes/preparacoes-empresa.js';
import { garantirIndicesRazao, INDICES_RAZAO } from '../../src/estoques/indices-razao.js';
import { posMigracaoEmpresa } from '../../src/plataforma/provisionamento.js';
import { conectar, consultar, criarAmbiente, urlDoBanco, type Ambiente } from './ambiente.js';

const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
const corte = migracoes.findIndex((m) => m.tag === '0026_indices_razao');
const INDICE = 'ix_movimentos_estoque_estoque_data';
const LINHA = 'ix_movimentos_estoque_linha_data';

const sufixo = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const banco = `genesis_t_${sufixo}_m26`;
/** O journal inteiro aplicado sem as preparações: aqui os índices saem da `.sql`. */
const bancoSoJournal = `genesis_t_${sufixo}_m26j`;
/** O journal à mão por cima de um índice inválido (e a reaplicação da 0026 com uma gravação aberta). */
const bancoInvalido = `genesis_t_${sufixo}_m26i`;
let c: pg.Client;
let amb: Ambiente;
let bancoNovo: string;
let estoqueId: string;
const relatos: Array<{ tag: string; relato: RelatoPreparacao }> = [];
let aplicadas: string[] = [];

/** Os índices da 0026, lidos do catálogo: a definição e se está válido. */
async function indices(nome: string) {
  return consultar<{ nome: string; definicao: string; valido: boolean }>(
    nome,
    `select c.relname as nome, pg_get_indexdef(i.indexrelid) as definicao, i.indisvalid as valido
       from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = any($1::text[]) order by 1`,
    [INDICES_RAZAO.map((x) => x.nome)],
  );
}

beforeAll(async () => {
  expect(corte).toBeGreaterThan(0);
  await garantirBanco(urlDoBanco(banco));
  c = await conectar(banco);
  await aplicarMigracoes(c, migracoes.slice(0, corte));
  await posMigracaoEmpresa(c, {
    codigo: 999_026,
    razaoSocial: 'Empresa Antiga Ltda',
    nomeFantasia: null,
    cnpj: '11222333000181',
    email: null,
    regime: 'simples_nacional',
  });
  // Antes da 0026: um estoque com 3 meses de movimentos de 5 produtos (a cadeia não importa aqui).
  const um = async (sql: string, params: unknown[] = []) =>
    (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
  estoqueId = await um("insert into estoques (nome) values ('Estoque Loja 1') returning id");
  const tipo = await um('select id from tipos_estoque where padrao');
  await c.query(
    `insert into produtos (nome, unidade_id)
     select 'PRODUTO ' || g, (select id from unidades_medida where sigla = 'UN') from generate_series(1, 5) g`,
  );
  await c.query(
    `insert into movimentos_estoque (estoque_id, tipo_estoque_id, produto_id, tipo_movimento, quantidade,
       saldo_anterior, saldo_posterior, custo_unitario, custo_total, custo_medio_posterior, data_movimento,
       documento_tipo)
     select $1, $2, p.id, 'ACERTO_ENTRADA', 1, g - 1, g, 2, 2, 2,
            timestamptz '2026-08-01 03:00:00+00' + g * interval '1 hour', 'acerto'
       from generate_series(1, 2000) g cross join produtos p`,
    [estoqueId, tipo],
  );
  expect(await indices(banco)).toEqual([]);

  const r = await aplicarMigracoes(c, migracoes, {
    preparacoes: PREPARACOES_MIGRACAO_EMPRESA,
    // Só o da 0026: uma preparação de migração posterior que relate nesta empresa com movimentos não quebra o teste.
    ganchos: {
      aoPreparar: async (m, relato) =>
        void (m.tag === '0026_indices_razao' && relatos.push({ tag: m.tag, relato })),
    },
  });
  aplicadas = r.aplicadas;

  amb = await criarAmbiente({ comApp: false });
  bancoNovo = (await amb.criarEmpresa()).nomeBanco;
}, 180_000);

afterAll(async () => {
  await c?.end();
  for (const nome of [banco, bancoSoJournal, bancoInvalido])
    await consultar('postgres', `drop database if exists "${nome}" with (force)`);
  await amb?.fechar();
});

describe('migração 0026_indices_razao (F2-B28)', () => {
  it('empresa nova e empresa existente terminam com os mesmos índices, válidos', async () => {
    const nova = await indices(bancoNovo);
    expect(nova).toEqual([
      {
        nome: INDICE,
        definicao: `CREATE INDEX ${INDICE} ON public.movimentos_estoque USING btree (estoque_id, data_movimento, id)`,
        valido: true,
      },
      {
        nome: LINHA,
        definicao:
          `CREATE INDEX ${LINHA} ON public.movimentos_estoque USING btree (estoque_id, produto_id, variacao_id, ` +
          'tipo_estoque_id, data_movimento, id) INCLUDE (quantidade)',
        valido: true,
      },
    ]);
    expect(await indices(banco)).toEqual(nova);
  });

  it('na existente os índices vieram da preparação (concurrently, fora da transação), com o relato', () => {
    expect(aplicadas[0]).toBe('0026_indices_razao');
    expect(relatos).toEqual([
      {
        tag: '0026_indices_razao',
        relato: {
          avisos: [],
          dados: {
            indices: [
              { nome: INDICE, situacao: 'criado', duracao_ms: expect.any(Number) },
              { nome: LINHA, situacao: 'criado', duracao_ms: expect.any(Number) },
            ],
          },
        },
      },
    ]);
    // Na empresa nova (tabela vazia) e com o índice já existente não há o que relatar.
    expect(relatoIndicesRazao([{ nome: INDICE, situacao: 'criado', duracaoMs: 3 }], false)).toBeUndefined();
    expect(relatoIndicesRazao([{ nome: INDICE, situacao: 'existente', duracaoMs: 0 }], true)).toBeUndefined();
  });

  it('sem as preparações a .sql cria os mesmos índices que a preparação (mesma definição)', async () => {
    await garantirBanco(urlDoBanco(bancoSoJournal));
    const c2 = await conectar(bancoSoJournal);
    try {
      await aplicarMigracoes(c2, migracoes);
    } finally {
      await c2.end();
    }
    expect(await indices(bancoSoJournal)).toEqual(await indices(bancoNovo));
  });

  it('sem as preparações a .sql refaz o índice inválido e, com os índices prontos, não espera a trava da tabela', async () => {
    await garantirBanco(urlDoBanco(bancoInvalido));
    const c3 = await conectar(bancoInvalido);
    const gravando = await conectar(bancoInvalido);
    try {
      await aplicarMigracoes(c3, migracoes.slice(0, corte));
      // O que sobra de um `concurrently` interrompido: o nome já existe, inválido (aqui com outra definição, para
      // ver que foi refeito e não só revalidado).
      await c3.query(`create index ${LINHA} on movimentos_estoque (estoque_id)`);
      await c3.query('update pg_index set indisvalid = false where indexrelid = $1::regclass', [LINHA]);
      expect(await aplicarMigracoes(c3, migracoes.slice(0, corte + 1))).toMatchObject({
        aplicadas: ['0026_indices_razao'],
      });
      expect(await indices(bancoInvalido)).toEqual(await indices(bancoNovo));

      // A 0026 de novo (a empresa existente, com os índices da preparação) com uma gravação aberta na tabela: uma
      // venda com o `insert` sem commit segura a trava ROW EXCLUSIVE até o fim.
      await c3.query('delete from drizzle.__drizzle_migrations where created_at = $1', [
        migracoes[corte]!.quando,
      ]);
      await gravando.query('begin');
      await gravando.query('lock table movimentos_estoque in row exclusive mode');
      // O `create index if not exists` solto (a forma antiga) esperaria a trava SHARE mesmo com o índice existindo.
      await c3.query('begin');
      await c3.query("set local lock_timeout = '500ms'");
      await expect(
        c3.query(
          `create index if not exists ${INDICE} on movimentos_estoque (estoque_id, data_movimento, id)`,
        ),
      ).rejects.toThrow(/lock timeout/);
      await c3.query('rollback');
      // A `.sql` da 0026 passa na hora: a preparação só confere e o bloco não pega trava na tabela.
      expect(
        await aplicarMigracoes(c3, migracoes.slice(0, corte + 1), {
          preparacoes: PREPARACOES_MIGRACAO_EMPRESA,
          lockTimeout: '500ms',
        }),
      ).toMatchObject({ aplicadas: ['0026_indices_razao'] });
      await gravando.query('rollback');
    } finally {
      await gravando.end();
      await c3.end();
    }
  });

  it('o índice inválido de um concurrently interrompido é refeito; a segunda passada só confere', async () => {
    await c.query('update pg_index set indisvalid = false where indexrelid = $1::regclass', [INDICE]);
    expect((await indices(banco))[0]).toMatchObject({ valido: false });
    expect(await garantirIndicesRazao(c)).toEqual([
      { nome: INDICE, situacao: 'recriado', duracaoMs: expect.any(Number) },
      { nome: LINHA, situacao: 'existente', duracaoMs: 0 },
    ]);
    expect((await indices(banco)).map((i) => i.valido)).toEqual([true, true]);
    expect(await garantirIndicesRazao(c)).toEqual([
      { nome: INDICE, situacao: 'existente', duracaoMs: 0 },
      { nome: LINHA, situacao: 'existente', duracaoMs: 0 },
    ]);
  });

  it('a Movimentação de um local por período sai na ordem do cursor direto do índice, sem ordenar', async () => {
    await c.query('analyze movimentos_estoque');
    await c.query('begin');
    try {
      // Com 10 mil movimentos a tabela inteira cabe em poucas páginas: sem isto o planejador lê tudo e ordena.
      await c.query('set local enable_seqscan = off');
      await c.query('set local enable_bitmapscan = off');
      const { rows } = await c.query<{ 'QUERY PLAN': string }>(
        `explain select id, data_movimento, produto_id, quantidade from movimentos_estoque
          where estoque_id = $1 and data_movimento >= '2026-08-10' and data_movimento < '2026-09-10'
            and (data_movimento, id) > ('2026-08-20 00:00:00+00', '00000000-0000-0000-0000-000000000000')
          order by data_movimento, id limit 101`,
        [estoqueId],
      );
      const plano = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plano).toContain(`Index Scan using ${INDICE}`);
      expect(plano).not.toContain('Sort');
    } finally {
      await c.query('rollback');
    }
  });

  it('o saldo de uma linha até um ponto do cursor sai só do índice, sem ler a tabela', async () => {
    await c.query('vacuum (analyze) movimentos_estoque');
    await c.query('begin');
    try {
      await c.query('set local enable_seqscan = off');
      await c.query('set local enable_bitmapscan = off');
      const { rows } = await c.query<{ 'QUERY PLAN': string }>(
        `explain select coalesce(sum(quantidade), 0) from movimentos_estoque
          where estoque_id = $1 and produto_id = (select id from produtos order by id limit 1)
            and variacao_id is null and tipo_estoque_id = (select id from tipos_estoque where padrao)
            and (data_movimento, id) <= ('2026-08-20 00:00:00+00', 'ffffffff-ffff-ffff-ffff-ffffffffffff')`,
        [estoqueId],
      );
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(`Index Only Scan using ${LINHA}`);
    } finally {
      await c.query('rollback');
    }
  });
});
