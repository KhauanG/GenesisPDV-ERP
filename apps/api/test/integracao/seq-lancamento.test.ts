/**
 * Ordem de lançamento do razão (Fase 2, F2-B2; README da API › decisão 146) sobre um banco já populado com o esquema
 * da 0015: o motor de hoje lança no esquema antigo (não cita a coluna nova); a 0016 cria `seq_lancamento` vazia, só com
 * o default para as linhas novas; sem o preenchimento, a 0017 falha com a instrução e não grava nada; o preenchimento
 * encadeia os antigos pelo saldo (não pelo `criado_em`, igual para o documento todo), numera 1…N abaixo da sequência,
 * não muda `versao` nem `atualizado_em`, cria o índice com `concurrently`, aponta a cadeia corrompida de propósito
 * (sem abortar, com alerta) e é idempotente; o movimento continua imutável, inclusive a ordem já gravada; e o executor
 * com as preparações faz tudo numa passada, como o `db:migrate:empresas`.
 */
import { randomBytes } from 'node:crypto';
import { ALERTA_RAZAO_CADEIA_QUEBRADA } from '@genesis/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garantirBanco } from '../../src/database/migracoes/controle.js';
import { aplicarMigracoes, type RelatoPreparacao } from '../../src/database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { PREPARACOES_MIGRACAO_EMPRESA } from '../../src/database/migracoes/preparacoes-empresa.js';
import { linhasComCadeiaQuebrada, verificarCadeia } from '../../src/estoques/cadeia.js';
import { lancarDocumento, type ChaveSaldo, type NovoMovimento } from '../../src/estoques/movimentos.js';
import { INICIO_SEQ_LANCAMENTO, preencherSeqLancamento } from '../../src/estoques/seq-lancamento.js';
import { posMigracaoEmpresa } from '../../src/plataforma/provisionamento.js';
import type { DbEmpresa } from '../../src/tenancy/tenancy.js';
import { conectar, consultar, urlDoBanco } from './ambiente.js';
import { conferirRazaoDoBanco } from './razao.js';

const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
const corte = migracoes.findIndex((m) => m.tag === '0016_movimentos_seq_a');
/** As migrações depois da 0017 (a 0018 em diante): o executor as aplica na mesma passada. */
const posteriores = migracoes.slice(corte + 2).map((m) => m.tag);

interface Banco {
  nome: string;
  c: pg.Client;
  estoqueId: string;
  tipoId: string;
  produto(nome: string): Promise<string>;
  /** Um documento numa transação: os ids dos movimentos do produto, na ordem em que o motor os lançou. */
  lancar(linhas: NovoMovimento[], produtoId?: string): Promise<string[]>;
  linha(produtoId: string): ChaveSaldo;
}

/** Banco de empresa com o esquema da 0015, as referências e o seed (o mesmo pós-migração do provisionamento). */
async function bancoAntigo(sufixo: string): Promise<Banco> {
  const nome = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_${sufixo}`;
  await garantirBanco(urlDoBanco(nome));
  const c = await conectar(nome);
  expect(corte).toBeGreaterThan(0);
  await aplicarMigracoes(c, migracoes.slice(0, corte));
  await posMigracaoEmpresa(c, {
    codigo: 999_001,
    razaoSocial: 'Empresa da Ordem Ltda',
    nomeFantasia: null,
    cnpj: '11222333000181',
    email: null,
    regime: 'simples_nacional',
  });
  const [{ id: estoqueId }] = (
    await c.query<{ id: string }>("insert into estoques (nome) values ('Loja 1') returning id")
  ).rows as [{ id: string }];
  const [{ id: tipoId }] = (await c.query<{ id: string }>('select id from tipos_estoque where padrao'))
    .rows as [{ id: string }];
  const [{ id: unidadeId }] = (
    await c.query<{ id: string }>("select id from unidades_medida where sigla = 'UN'")
  ).rows as [{ id: string }];
  return {
    nome,
    c,
    estoqueId,
    tipoId,
    async produto(n) {
      const { rows } = await c.query<{ id: string }>(
        'insert into produtos (nome, unidade_id) values ($1, $2) returning id',
        [n, unidadeId],
      );
      return rows[0]!.id;
    },
    lancar: (linhas, produtoId) => lancarCom(c, linhas, produtoId),
    linha: (produtoId) => ({ estoqueId, produtoId, variacaoId: null, tipoEstoqueId: tipoId }),
  };
}

/** Um documento numa transação, pela conexão dada (a dona do banco ou a role de runtime). */
async function lancarCom(c: pg.Client, linhas: NovoMovimento[], produtoId?: string): Promise<string[]> {
  await c.query('begin');
  try {
    await c.query('select fn_trava_versao()');
    const r = await lancarDocumento(drizzle(c) as unknown as DbEmpresa, linhas);
    await c.query('commit');
    return r.movimentos
      .filter((m) => produtoId === undefined || m.linha.produtoId === produtoId)
      .map((m) => m.id);
  } catch (e) {
    await c.query('rollback');
    throw e;
  }
}

/**
 * A role de runtime do banco (`<banco>_app`, MD 1.4) com os privilégios que o `garantirRoleAplicacao` dá no esquema de
 * agora (o nome do banco descartável não passa na validação dele), e uma conexão por ela.
 */
async function roleDeRuntime(b: Banco): Promise<pg.Client> {
  const role = `${b.nome}_app`;
  const senha = randomBytes(12).toString('hex');
  await b.c.query(`create role "${role}" login noinherit password '${senha}'`);
  roles.push(role);
  await b.c.query(`grant usage on schema public to "${role}"`);
  await b.c.query(`grant select, insert, update on all tables in schema public to "${role}"`);
  await b.c.query(`grant usage, select on all sequences in schema public to "${role}"`);
  const u = new URL(urlDoBanco(b.nome));
  u.username = role;
  u.password = senha;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
}

function movimento(b: Banco, produtoId: string, quantidade: string, custo?: string): NovoMovimento {
  return {
    estoqueId: b.estoqueId,
    produtoId,
    variacaoId: null,
    tipoEstoqueId: b.tipoId,
    tipoMovimento: Number(quantidade) > 0 ? 'ACERTO_ENTRADA' : 'ACERTO_SAIDA',
    quantidade,
    custoUnitario: custo ?? null,
    custoReferencia: '1',
    precoVenda: null,
    dataMovimento: new Date(),
    lojaId: null,
    usuarioId: null,
    documentoTipo: 'acerto',
    documentoId: null,
    documentoItemId: null,
  };
}

async function ordemGravada(c: pg.Client, produtoId: string) {
  const { rows } = await c.query<{ id: string; seq: string | null }>(
    `select id, seq_lancamento::text as seq from movimentos_estoque where produto_id = $1
      order by seq_lancamento nulls last, id`,
    [produtoId],
  );
  return rows;
}

const bancos: Banco[] = [];
const roles: string[] = [];
const conexoesApp: pg.Client[] = [];
afterAll(async () => {
  for (const c of conexoesApp) await c.end().catch(() => undefined);
  for (const b of bancos) {
    await b.c.end().catch(() => undefined);
    await consultar('postgres', `drop database if exists "${b.nome}" with (force)`);
  }
  for (const r of roles) await consultar('postgres', `drop role if exists "${r}"`);
});

describe('etapas A e B com o preenchimento entre elas (F2-B2)', () => {
  let b: Banco;
  /** A API: grava pela role de runtime, que já existia antes da 0016. */
  let app: pg.Client;
  let vaiVolta: string;
  let simples: string;
  let corrompido: string;
  /** A ordem real do lançamento de `vaiVolta`, como o motor lançou. */
  const real: string[] = [];

  beforeAll(async () => {
    b = await bancoAntigo('seqa');
    bancos.push(b);
    vaiVolta = await b.produto('CERV VAI E VOLTA');
    simples = await b.produto('AGUA SIMPLES');
    corrompido = await b.produto('REFRI CORROMPIDO');
    // Um documento só (o mesmo criado_em) que vai e volta ao zero duas vezes; depois mais dois documentos.
    real.push(
      ...(await b.lancar([
        movimento(b, vaiVolta, '10', '5'),
        movimento(b, vaiVolta, '-10'),
        movimento(b, vaiVolta, '4', '6'),
        movimento(b, vaiVolta, '-4'),
        movimento(b, vaiVolta, '3', '7'),
      ])),
    );
    real.push(...(await b.lancar([movimento(b, vaiVolta, '-5')])));
    real.push(
      ...(await b.lancar([movimento(b, vaiVolta, '8', '6.5'), movimento(b, simples, '2', '1')], vaiVolta)),
    );
    await b.lancar([movimento(b, simples, '-1')]);
    await b.lancar([movimento(b, corrompido, '5', '2')]);
    // Um movimento gravado à mão fora da cadeia (o saldo anterior não é o posterior do anterior).
    await b.c.query(
      `insert into movimentos_estoque (estoque_id, tipo_estoque_id, produto_id, tipo_movimento, quantidade,
         saldo_anterior, saldo_posterior, custo_unitario, custo_total, custo_medio_posterior, data_movimento,
         documento_tipo)
       values ($1, $2, $3, 'ACERTO_SAIDA', -1, 50, 49, 2, 2, 2, now(), 'acerto')`,
      [b.estoqueId, b.tipoId, corrompido],
    );
    app = await roleDeRuntime(b);
    conexoesApp.push(app);
  }, 180_000);

  it('a 0016 entra; sem o preenchimento a 0017 falha com a instrução e não grava nada', async () => {
    await expect(aplicarMigracoes(b.c, migracoes)).rejects.toThrow(/db:preencher-seq-lancamento/);
    const { rows } = await b.c.query<{ nulo: string; padrao: string | null }>(
      `select is_nullable as nulo, column_default as padrao from information_schema.columns
        where table_name = 'movimentos_estoque' and column_name = 'seq_lancamento'`,
    );
    expect(rows[0]).toEqual({ nulo: 'YES', padrao: "nextval('seq_movimentos_estoque'::regclass)" });
    const { rows: aplicadas } = await b.c.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(aplicadas[0]!.n).toBe(corte + 1);
    expect((await ordemGravada(b.c, vaiVolta)).every((m) => m.seq === null)).toBe(true);
  });

  it('a API lança pela role de runtime logo depois da 0016, já com a ordem, acima do início da sequência', async () => {
    // Antes do preenchimento e da 0017 (e do `garantirRoleAplicacao` do fim): o grant da sequência vem na própria 0016.
    const [novo] = await lancarCom(app, [movimento(b, vaiVolta, '-2')]);
    real.push(novo!);
    const ordem = await ordemGravada(b.c, vaiVolta);
    expect(Number(ordem.find((m) => m.id === novo)!.seq)).toBeGreaterThanOrEqual(INICIO_SEQ_LANCAMENTO);
  });

  it('preenche pela cadeia de saldo, aponta a corrompida com alerta e não muda versão nem atualizado_em', async () => {
    const versaoAntes = await b.c.query<{ id: string; versao: string; atualizado_em: Date }>(
      'select id, versao::text, atualizado_em from movimentos_estoque order by id',
    );
    const r = await preencherSeqLancamento(b.c);
    expect(r).toMatchObject({ linhas: 3, preenchidos: 11, indice: 'criado' });
    expect(r.quebras).toEqual([
      expect.objectContaining({
        produtoId: corrompido,
        posicao: 2,
        movimentos: 2,
        saldoEsperado: '5.000',
        saldoAnterior: '50.000',
        origem: 'antigos',
      }),
    ]);

    // A ordem real, com os antigos de 1 a 7 e o novo acima da sequência.
    const ordem = await ordemGravada(b.c, vaiVolta);
    expect(ordem.map((m) => m.id)).toEqual(real);
    expect(ordem.slice(0, 7).map((m) => Number(m.seq))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await verificarCadeia(b.c, b.linha(vaiVolta))).quebras).toBe(0);
    expect((await verificarCadeia(b.c, b.linha(simples))).quebras).toBe(0);
    expect(await verificarCadeia(b.c, b.linha(corrompido))).toMatchObject({
      movimentos: 2,
      quebras: 1,
      primeiraQuebra: { posicao: 2, saldoEsperado: '5.000', saldoAnterior: '50.000' },
    });

    const { rows: alertas } = await b.c.query<{
      tipo: string;
      registro_id: string;
      mensagem: string;
      dados: { posicao: number };
    }>('select tipo, registro_id, mensagem, dados from alertas where tipo = $1', [
      ALERTA_RAZAO_CADEIA_QUEBRADA,
    ]);
    expect(alertas).toEqual([
      expect.objectContaining({
        registro_id: corrompido,
        mensagem: expect.stringContaining('ficaram na ordem de gravação'),
        dados: expect.objectContaining({ posicao: 2, origem: 'antigos' }),
      }),
    ]);

    const versaoDepois = await b.c.query<{ id: string; versao: string; atualizado_em: Date }>(
      'select id, versao::text, atualizado_em from movimentos_estoque order by id',
    );
    expect(versaoDepois.rows).toEqual(versaoAntes.rows);

    // Idempotente: nada a preencher, nenhum alerta novo, índice já válido.
    expect(await preencherSeqLancamento(b.c)).toEqual({
      linhas: 0,
      preenchidos: 0,
      quebras: [],
      indice: 'existente',
    });
    const { rows: n } = await b.c.query<{ n: number }>(
      'select count(*)::int as n from alertas where tipo = $1',
      [ALERTA_RAZAO_CADEIA_QUEBRADA],
    );
    expect(n[0]!.n).toBe(1);
  });

  it('o movimento continua imutável: a ordem gravada não muda, nem as outras colunas', async () => {
    const [m] = await ordemGravada(b.c, simples);
    await expect(
      b.c.query('update movimentos_estoque set seq_lancamento = seq_lancamento + 100 where id = $1', [m!.id]),
    ).rejects.toThrow('DOCUMENTO_IMUTAVEL');
    await expect(
      b.c.query('update movimentos_estoque set seq_lancamento = null where id = $1', [m!.id]),
    ).rejects.toThrow('DOCUMENTO_IMUTAVEL');
    await expect(
      b.c.query("update movimentos_estoque set observacao = 'x' where id = $1", [m!.id]),
    ).rejects.toThrow('DOCUMENTO_IMUTAVEL');
  });

  it('a 0017 entra depois do preenchimento: NOT NULL, índice válido e o check provisório descartado', async () => {
    const r = await aplicarMigracoes(b.c, migracoes, { preparacoes: PREPARACOES_MIGRACAO_EMPRESA });
    expect(r.aplicadas).toEqual(['0017_movimentos_seq_b', ...posteriores]);
    const { rows } = await b.c.query<{ nulo: string; valido: boolean; check: number }>(
      `select (select is_nullable from information_schema.columns
                where table_name = 'movimentos_estoque' and column_name = 'seq_lancamento') as nulo,
              (select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid
                where c.relname = 'ix_movimentos_estoque_linha_seq') as valido,
              (select count(*)::int from pg_constraint where conname = 'ck_movimentos_estoque_seq_lancamento') as check`,
    );
    expect(rows[0]).toEqual({ nulo: 'NO', valido: true, check: 0 });
    // A linha corrompida continua apontada (quem corrige o saldo é o recálculo, F2-B3); as outras fecham.
    expect((await linhasComCadeiaQuebrada(b.c)).map((l) => l.produtoId)).toEqual([corrompido]);
  });
});

describe('quebra só na emenda com os lançados depois da 0016 (F2-B2)', () => {
  it('os antigos ficam na ordem da cadeia; o alerta e o relato da migração apontam a emenda', async () => {
    const b = await bancoAntigo('seqc');
    bancos.push(b);
    const p = await b.produto('CERV EMENDA');
    const antigos = [
      ...(await b.lancar([movimento(b, p, '10', '4'), movimento(b, p, '-3')])),
      ...(await b.lancar([movimento(b, p, '5', '5')])),
    ];
    // A projeção já não batia com o razão antes da migração (o caso do F2-B3): o lançado depois parte dela.
    await b.c.query('update saldos_estoque set quantidade = quantidade + 1 where produto_id = $1', [p]);
    await aplicarMigracoes(b.c, migracoes.slice(0, corte + 1));
    const [novo] = await b.lancar([movimento(b, p, '-2')]);

    const relatos: RelatoPreparacao[] = [];
    const r = await aplicarMigracoes(b.c, migracoes, {
      preparacoes: PREPARACOES_MIGRACAO_EMPRESA,
      ganchos: { aoPreparar: async (_m, relato) => void relatos.push(relato) },
    });
    expect(r.aplicadas).toEqual(['0017_movimentos_seq_b', ...posteriores]);
    // O relatório do preenchimento chega a quem migra (o `MigradorEmpresas` o põe no resultado e na auditoria).
    expect(relatos).toEqual([
      {
        avisos: [expect.stringContaining('1 linha(s) de saldo com a cadeia do razão quebrada')],
        dados: expect.objectContaining({
          linhas: 1,
          preenchidos: 3,
          total_quebras: 1,
          quebras: [
            expect.objectContaining({
              produto_id: p,
              movimentos: 4,
              posicao: 4,
              movimento_id: novo,
              saldo_esperado: '12.000',
              saldo_anterior: '13.000',
              origem: 'emenda',
            }),
          ],
        }),
      },
    ]);
    expect((await ordemGravada(b.c, p)).map((m) => m.id)).toEqual([...antigos, novo]);

    const { rows: alertas } = await b.c.query<{ mensagem: string; dados: { origem: string } }>(
      'select mensagem, dados from alertas where tipo = $1',
      [ALERTA_RAZAO_CADEIA_QUEBRADA],
    );
    expect(alertas).toEqual([
      {
        mensagem: expect.stringMatching(
          /movimento 4 de 4 .*lançado depois da migração da ordem.*se encadearam/,
        ),
        dados: expect.objectContaining({ origem: 'emenda', posicao: 4 }),
      },
    ]);
    expect(alertas[0]!.mensagem).not.toContain('ordem de gravação');
    // Depois da migração, sem nada a preencher, o razão ainda mostra a linha (o relatório do comando vem daqui).
    expect(await preencherSeqLancamento(b.c)).toMatchObject({ linhas: 0, quebras: [] });
    expect(await linhasComCadeiaQuebrada(b.c)).toEqual([
      expect.objectContaining({ produtoId: p, movimentoId: novo, posicao: 4, movimentos: 4 }),
    ]);
  }, 180_000);
});

describe('executor com as preparações: uma passada, como o db:migrate:empresas (F2-B2)', () => {
  it('banco populado na 0015 vai à 0017 de uma vez, com a ordem real e o replay batendo com os saldos', async () => {
    const b = await bancoAntigo('seqb');
    bancos.push(b);
    const p1 = await b.produto('CERV LATA');
    const p2 = await b.produto('CERV LONG NECK');
    for (let i = 0; i < 6; i++) {
      await b.lancar([
        movimento(b, p1, `${i + 3}`, `${2 + i / 4}`),
        movimento(b, p2, '-1'),
        movimento(b, p1, `-${i + 3}`),
        movimento(b, p2, '2', '3'),
      ]);
    }
    const r = await aplicarMigracoes(b.c, migracoes, { preparacoes: PREPARACOES_MIGRACAO_EMPRESA });
    expect(r.aplicadas).toEqual(['0016_movimentos_seq_a', '0017_movimentos_seq_b', ...posteriores]);
    expect(await conferirRazaoDoBanco(b.nome)).toEqual({ linhas: 2, movimentos: 24 });
  }, 180_000);
});
