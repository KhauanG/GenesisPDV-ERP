/**
 * Migração 0025 (Fase 2, F2-B22; MD 3.7.6; ERP 13.7; README da API › decisão 170) em empresa nova e em empresa
 * existente: a nova nasce com as tabelas da transferência, a sequência do `codigo`, os triggers de versão
 * (`fn_versao_local`, com a `diferenca` gerada isenta no item), de imutabilidade e de etapa; a existente (esquema da
 * 0024 com cadastro, um acerto efetivado e um recebimento) recebe tudo sem mexer no que já estava, e a primeira
 * transferência dela é o Nº 1. Também os CHECKs (origem = destino, recebida > enviada, situação × datas, chave da NF-e
 * de fora) e os triggers de etapa, direto no banco: a API dos F2-B23/F2-B24 confere antes, e o banco é a última
 * barreira. O `Esquema.g.cs` do PDV não muda (nenhuma das tabelas está num fluxo).
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garantirBanco } from '../../src/database/migracoes/controle.js';
import { aplicarMigracoes } from '../../src/database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { PREPARACOES_MIGRACAO_EMPRESA } from '../../src/database/migracoes/preparacoes-empresa.js';
import { posMigracaoEmpresa } from '../../src/plataforma/provisionamento.js';
import { TABELAS_DOS_FLUXOS } from '../../src/sync/fluxos.js';
import { conectar, consultar, criarAmbiente, urlDoBanco, type Ambiente } from './ambiente.js';

const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
const corte = migracoes.findIndex((m) => m.tag === '0025_transferencias');

const banco = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_m25`;
let c: pg.Client;
let amb: Ambiente;
let bancoNovo: string;

const ids: Record<string, string> = {};
/** Chave de acesso inventada com o DV certo (UF 35, CNPJ de teste, modelo 55). */
const CHAVE_TESTE = '35261111222333000181550010000000011000000014';

/** O que a 0025 cria, lido do catálogo (as duas tabelas, a sequência, os triggers que não são de FK e os CHECKs). */
async function estrutura(nome: string) {
  const triggers = await consultar<{ tabela: string; trigger: string; funcao: string }>(
    nome,
    `select c.relname as tabela, t.tgname as trigger, p.proname as funcao from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and c.relname in ('transferencias_estoque', 'itens_transferencia')
      order by 1, 2`,
  );
  const [seq] = await consultar<{ cache_size: number }>(
    nome,
    "select cache_size::int from pg_sequences where sequencename = 'seq_codigo_transferencias_estoque'",
  );
  const checks = await consultar<{ conname: string }>(
    nome,
    `select conname from pg_constraint
      where contype = 'c' and conrelid in ('transferencias_estoque'::regclass, 'itens_transferencia'::regclass)
      order by 1`,
  );
  const indices = await consultar<{ indexname: string }>(
    nome,
    `select indexname from pg_indexes
      where tablename in ('transferencias_estoque', 'itens_transferencia') order by 1`,
  );
  return {
    triggers,
    seq,
    checks: checks.map((x) => x.conname),
    indices: indices.map((x) => x.indexname),
  };
}

/** Uma transferência em rascunho da origem para o destino, com um item de 10 unidades. */
async function rascunho(motivo = 'Reposição semanal'): Promise<{ id: string; item: string }> {
  const { rows } = await c.query<{ id: string }>(
    `insert into transferencias_estoque (estoque_origem_id, estoque_destino_id, tipo_estoque_id, motivo)
     values ($1, $2, $3, $4) returning id`,
    [ids.cd, ids.estoque, ids.tipo, motivo],
  );
  const id = rows[0]!.id;
  const { rows: it } = await c.query<{ id: string }>(
    `insert into itens_transferencia (transferencia_id, sequencia, produto_id, quantidade_enviada)
     values ($1, 1, $2, 10) returning id`,
    [id, ids.produto],
  );
  return { id, item: it[0]!.id };
}

/** O envio do F2-B23: o custo no item ainda no rascunho e, depois, a situação com quem e quando enviou. */
async function enviar(t: { id: string; item: string }) {
  await c.query("update itens_transferencia set custo_unitario = '4.5000' where id = $1", [t.item]);
  await c.query(
    `update transferencias_estoque set status = 'em_transito', enviada_em = now(), enviada_por_id = $2
      where id = $1`,
    [t.id, ids.usuario],
  );
}

const IMUTAVEL = { message: 'DOCUMENTO_IMUTAVEL' };
const CHECK = { code: '23514' };

beforeAll(async () => {
  expect(corte).toBeGreaterThan(0);
  await garantirBanco(urlDoBanco(banco));
  c = await conectar(banco);
  await aplicarMigracoes(c, migracoes.slice(0, corte));
  await posMigracaoEmpresa(c, {
    codigo: 999_025,
    razaoSocial: 'Empresa Antiga Ltda',
    nomeFantasia: null,
    cnpj: '11222333000181',
    email: null,
    regime: 'simples_nacional',
  });
  // Cadastro da empresa antes da 0025: CD e loja com estoque, fornecedor, produto, um acerto efetivado e um
  // recebimento em rascunho.
  const um = async (sql: string, params: unknown[] = []) =>
    (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
  ids.cd = await um("insert into estoques (nome, tipo) values ('CD - Estoque', 'deposito') returning id");
  ids.estoque = await um("insert into estoques (nome) values ('Estoque Loja 1') returning id");
  ids.loja = await um(
    `insert into lojas (codigo, nome, razao_social, nome_fantasia, cnpj, estoque_id, cep, logradouro, numero, bairro,
       municipio_ibge, uf)
     values (1, 'Loja 1', 'Loja 1', 'Loja 1', '11222333000262', $1, '01001000', 'Praça da Sé', '1', 'Sé', 3550308, 'SP')
     returning id`,
    [ids.estoque],
  );
  ids.fornecedor = await um("insert into pessoas (nome, tipo) values ('Distribuidora X', 'PJ') returning id");
  ids.produto = await um(
    "insert into produtos (nome, unidade_id) values ('Cerveja lata', (select id from unidades_medida where sigla = 'UN')) returning id",
  );
  ids.tipo = await um('select id from tipos_estoque where padrao');
  ids.usuario = await um(
    "insert into usuarios (nome, login, senha_hash, master) values ('Dono', 'dono', 'x', true) returning id",
  );
  ids.acerto = await um(
    `insert into acertos_estoque (estoque_id, tipo_estoque_id, motivo, responsavel_id, status, efetivado_em)
     values ($1, $2, 'Inventário', $3, 'efetivado', now()) returning id`,
    [ids.cd, ids.tipo, ids.usuario],
  );
  ids.recebimento = await um(
    `insert into recebimentos (loja_id, estoque_id, tipo_estoque_id, fornecedor_id)
     values ($1, $2, $3, $4) returning id`,
    [ids.loja, ids.cd, ids.tipo, ids.fornecedor],
  );

  await aplicarMigracoes(c, migracoes, { preparacoes: PREPARACOES_MIGRACAO_EMPRESA });

  amb = await criarAmbiente({ comApp: false });
  bancoNovo = (await amb.criarEmpresa()).nomeBanco;
}, 180_000);

afterAll(async () => {
  await c?.end();
  await consultar('postgres', `drop database if exists "${banco}" with (force)`);
  await amb?.fechar();
});

describe('migração 0025_transferencias (F2-B22)', () => {
  it('empresa nova e empresa existente terminam com a mesma estrutura', async () => {
    const nova = await estrutura(bancoNovo);
    const existente = await estrutura(banco);
    expect(existente).toEqual(nova);
    expect(nova.seq).toEqual({ cache_size: 1 });
    expect(nova.triggers).toEqual([
      {
        tabela: 'itens_transferencia',
        trigger: 'tg_itens_transferencia_etapa',
        funcao: 'fn_itens_transferencia_etapa',
      },
      { tabela: 'itens_transferencia', trigger: 'tg_itens_transferencia_versao', funcao: 'fn_versao_local' },
      {
        tabela: 'transferencias_estoque',
        trigger: 'tg_transferencias_estoque_etapa',
        funcao: 'fn_transferencias_estoque_etapa',
      },
      {
        tabela: 'transferencias_estoque',
        trigger: 'tg_transferencias_estoque_imutavel',
        funcao: 'fn_protege_imutavel',
      },
      {
        tabela: 'transferencias_estoque',
        trigger: 'tg_transferencias_estoque_versao',
        funcao: 'fn_versao_local',
      },
    ]);
    expect(nova.checks).toEqual([
      'ck_itens_transferencia_custo',
      'ck_itens_transferencia_divergencia',
      'ck_itens_transferencia_quantidades',
      'ck_itens_transferencia_tratamento',
      'ck_transferencias_estoque_estoques',
      'ck_transferencias_estoque_etapas',
      'ck_transferencias_estoque_nfe_externa',
      'ck_transferencias_estoque_status',
    ]);
    // Os índices da listagem por origem/destino × situação (MD 3.7.6) e o do produto (nulls not distinct).
    expect(nova.indices).toEqual(
      expect.arrayContaining([
        'ix_transferencias_estoque_origem_status',
        'ix_transferencias_estoque_destino_status',
        'uq_transferencias_estoque_codigo',
        'uq_itens_transferencia_sequencia',
        'uq_itens_transferencia_produto',
      ]),
    );
    // Nenhuma das tabelas desce ao PDV.
    expect(TABELAS_DOS_FLUXOS).not.toContain('transferencias_estoque');
    expect(TABELAS_DOS_FLUXOS).not.toContain('itens_transferencia');
  });

  it('na existente, o que já estava fica igual e a primeira transferência é o Nº 1, com versão, data e diferença', async () => {
    const { rows: antes } = await c.query(
      `select (select status from acertos_estoque where id = $1) as acerto,
              (select status from recebimentos where id = $2) as recebimento`,
      [ids.acerto, ids.recebimento],
    );
    expect(antes).toEqual([{ acerto: 'efetivado', recebimento: 'rascunho' }]);
    const t = await rascunho();
    const { rows } = await c.query<{ codigo: number; versao: string; hoje: boolean; status: string }>(
      `select codigo, versao, data = current_date as hoje, status from transferencias_estoque where id = $1`,
      [t.id],
    );
    expect(rows[0]).toMatchObject({ codigo: 1, hoje: true, status: 'rascunho' });
    expect(Number(rows[0]!.versao)).toBeGreaterThan(0);
    const { rows: item } = await c.query<{ diferenca: string; versao: string }>(
      'select diferenca, versao from itens_transferencia where id = $1',
      [t.item],
    );
    // Sem recebimento, a diferença é zero (não conta como divergência).
    expect(item[0]!.diferenca).toBe('0.000');
    // A coluna gerada não gera versão nova no UPDATE sem mudança real (isenta no trigger de versão).
    const { rows: igual } = await c.query<{ versao: string }>(
      'update itens_transferencia set quantidade_enviada = quantidade_enviada where id = $1 returning versao',
      [t.item],
    );
    expect(igual[0]!.versao).toBe(item[0]!.versao);
  });

  it('CHECKs: origem = destino, recebida > enviada, enviada ≤ 0, tratamento sem diferença e chave inválida são recusados', async () => {
    await expect(
      c.query(
        `insert into transferencias_estoque (estoque_origem_id, estoque_destino_id, tipo_estoque_id, motivo)
         values ($1, $1, $2, 'Mesmo estoque')`,
        [ids.cd, ids.tipo],
      ),
    ).rejects.toMatchObject({ ...CHECK, constraint: 'ck_transferencias_estoque_estoques' });
    const t = await rascunho('CHECKs');
    const item = (sql: string) => c.query(`update itens_transferencia set ${sql} where id = $1`, [t.item]);
    await expect(item('quantidade_recebida = 10.001')).rejects.toMatchObject({
      ...CHECK,
      constraint: 'ck_itens_transferencia_quantidades',
    });
    await expect(item('quantidade_recebida = -1')).rejects.toMatchObject(CHECK);
    await expect(item('quantidade_enviada = 0')).rejects.toMatchObject(CHECK);
    await expect(item("custo_unitario = '-0.0001'")).rejects.toMatchObject(CHECK);
    // Recebida igual à enviada: sem diferença, nada a tratar.
    await expect(
      item("quantidade_recebida = 10, tratamento_divergencia = 'perda', divergencia_tratada_em = now()"),
    ).rejects.toMatchObject({ ...CHECK, constraint: 'ck_itens_transferencia_divergencia' });
    await expect(item("quantidade_recebida = 8, tratamento_divergencia = 'perda'")).rejects.toMatchObject(
      CHECK,
    );
    await expect(
      item("quantidade_recebida = 8, tratamento_divergencia = 'sumiu', divergencia_tratada_em = now()"),
    ).rejects.toMatchObject(CHECK);
    // Sem recebimento não há diferença a tratar (o `null < x` do CHECK passaria sem o `is not null`).
    await expect(
      item("tratamento_divergencia = 'perda', divergencia_tratada_em = now()"),
    ).rejects.toMatchObject({ ...CHECK, constraint: 'ck_itens_transferencia_divergencia' });
    // O mesmo produto sem lote duas vezes.
    await expect(
      c.query(
        `insert into itens_transferencia (transferencia_id, sequencia, produto_id, quantidade_enviada)
         values ($1, 2, $2, 1)`,
        [t.id, ids.produto],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_itens_transferencia_produto' });
    const cab = (sql: string) => c.query(`update transferencias_estoque set ${sql} where id = $1`, [t.id]);
    await expect(cab("nfe_externa_chave = '123'")).rejects.toMatchObject({
      ...CHECK,
      constraint: 'ck_transferencias_estoque_nfe_externa',
    });
    await cab(`nfe_externa_chave = '${CHAVE_TESTE}', nfe_externa_numero = '1/1'`);
    // Situação × datas: em trânsito sem envio, cancelada sem motivo e cancelada sem a hora do cancelamento (o
    // rascunho com envio já para no trigger de etapa, antes do CHECK; o insert não passa por ele). A cancelada sem
    // hora passa no trigger (rascunho → cancelada, mudando só o motivo): só o CHECK a recusa.
    await expect(cab("status = 'em_transito'")).rejects.toMatchObject({
      ...CHECK,
      constraint: 'ck_transferencias_estoque_etapas',
    });
    await expect(cab('enviada_em = now()')).rejects.toMatchObject(IMUTAVEL);
    await expect(cab("status = 'cancelada', cancelada_em = now()")).rejects.toMatchObject({
      ...CHECK,
      constraint: 'ck_transferencias_estoque_etapas',
    });
    await expect(cab("status = 'cancelada', motivo_cancelamento = 'x'")).rejects.toMatchObject({
      ...CHECK,
      constraint: 'ck_transferencias_estoque_etapas',
    });
    const inserir = (colunas: string, valores: string) =>
      c.query(
        `insert into transferencias_estoque (estoque_origem_id, estoque_destino_id, tipo_estoque_id, motivo${colunas})
         values ($1, $2, $3, 'Direto no banco'${valores})`,
        [ids.cd, ids.estoque, ids.tipo],
      );
    await expect(inserir(', enviada_em', ', now()')).rejects.toMatchObject({
      ...CHECK,
      constraint: 'ck_transferencias_estoque_etapas',
    });
    await expect(inserir(', status', ", 'outra'")).rejects.toMatchObject({
      ...CHECK,
      constraint: 'ck_transferencias_estoque_status',
    });
    // Recebimento fora da recebida: com o envio preenchido, só a cláusula do recebimento recusa.
    await expect(
      inserir(', status, enviada_em, recebida_em', ", 'em_transito', now(), now()"),
    ).rejects.toMatchObject({ ...CHECK, constraint: 'ck_transferencias_estoque_etapas' });
  });

  it('etapas: rascunho editável; em trânsito só a quantidade recebida; divergência tratada uma vez; recebida é o fim', async () => {
    const t = await rascunho('Etapas');
    const cab = (sql: string, params: unknown[] = []) =>
      c.query(`update transferencias_estoque set ${sql} where id = $1`, [t.id, ...params]);
    const item = (sql: string) => c.query(`update itens_transferencia set ${sql} where id = $1`, [t.item]);
    // Rascunho: tudo muda, e não se pula etapa.
    await cab("motivo = 'Etapas (editado)', observacoes = 'Conferir lacre'");
    await expect(cab("status = 'recebida', enviada_em = now(), recebida_em = now()")).rejects.toMatchObject(
      IMUTAVEL,
    );
    await enviar(t);

    // Em trânsito: o cabeçalho e o item enviados ficam como estão.
    // O item não muda de transferência: o trigger lê a situação pela transferência nova, e um rascunho deixaria
    // tirar o item de um documento já enviado (com o TRANSF_SAIDA dele no razão).
    const { rows: vazio } = await c.query<{ id: string }>(
      `insert into transferencias_estoque (estoque_origem_id, estoque_destino_id, tipo_estoque_id, motivo)
       values ($1, $2, $3, 'Rascunho vazio') returning id`,
      [ids.cd, ids.estoque, ids.tipo],
    );
    await expect(
      c.query('update itens_transferencia set transferencia_id = $2 where id = $1', [t.item, vazio[0]!.id]),
    ).rejects.toMatchObject(IMUTAVEL);
    // Recebida sem a hora do recebimento: a transição vale e o trigger aceita mudar só quem recebeu; só o CHECK
    // recusa.
    await expect(cab("status = 'recebida', recebida_por_id = $2", [ids.usuario])).rejects.toMatchObject({
      ...CHECK,
      constraint: 'ck_transferencias_estoque_etapas',
    });
    await expect(cab("motivo = 'Outro'")).rejects.toMatchObject(IMUTAVEL);
    await expect(cab("enviada_em = now() - interval '1 day'")).rejects.toMatchObject(IMUTAVEL);
    await expect(item('quantidade_enviada = 9')).rejects.toMatchObject(IMUTAVEL);
    await expect(item("custo_unitario = '5'")).rejects.toMatchObject(IMUTAVEL);
    await expect(item('excluido_em = now()')).rejects.toMatchObject(IMUTAVEL);
    await expect(
      c.query(
        `insert into itens_transferencia (transferencia_id, sequencia, produto_id, quantidade_enviada)
         values ($1, 9, $2, 1)`,
        [t.id, ids.produto],
      ),
    ).rejects.toMatchObject(IMUTAVEL);
    // O recebimento sem a 2ª etapa e o tratamento antes de receber.
    await expect(cab('recebida_em = now()')).rejects.toMatchObject(IMUTAVEL);
    await expect(
      item("tratamento_divergencia = 'perda', divergencia_tratada_em = now()"),
    ).rejects.toMatchObject(IMUTAVEL);
    // A NF-e emitida por fora pode ser anotada depois do envio.
    await cab(`nfe_externa_chave = '${CHAVE_TESTE}'`);

    // 2ª etapa: a conferência no item e, depois, a situação.
    await item('quantidade_recebida = 8');
    const { rows: dif } = await c.query<{ diferenca: string }>(
      'select diferenca from itens_transferencia where id = $1',
      [t.item],
    );
    expect(dif[0]!.diferenca).toBe('2.000');
    await cab("status = 'recebida_divergencia', recebida_em = now(), recebida_por_id = $2", [ids.usuario]);

    // Recebida com divergência: a quantidade recebida não muda mais; o tratamento, uma vez só.
    await expect(item('quantidade_recebida = 10')).rejects.toMatchObject(IMUTAVEL);
    await expect(cab('recebida_em = now()')).rejects.toMatchObject(IMUTAVEL);
    await expect(
      cab("status = 'cancelada', cancelada_em = now(), motivo_cancelamento = 'x'"),
    ).rejects.toMatchObject(IMUTAVEL);
    await item("tratamento_divergencia = 'retorno_origem', divergencia_tratada_em = now()");
    await expect(item("tratamento_divergencia = 'perda'")).rejects.toMatchObject(IMUTAVEL);
    await cab("status = 'recebida'");

    // Recebida é o fim: não volta ao trânsito, não se cancela, e só a NF-e de fora ainda se anota.
    await expect(cab("status = 'em_transito', recebida_em = null")).rejects.toMatchObject(IMUTAVEL);
    await expect(cab("status = 'recebida_divergencia'")).rejects.toMatchObject(IMUTAVEL);
    await expect(item('excluido_em = now()')).rejects.toMatchObject(IMUTAVEL);
    await cab("nfe_externa_numero = '123/1'");
    const { rows } = await c.query(
      `select t.status, t.motivo, i.quantidade_enviada, i.quantidade_recebida, i.diferenca, i.tratamento_divergencia,
              i.custo_unitario
         from transferencias_estoque t join itens_transferencia i on i.transferencia_id = t.id where t.id = $1`,
      [t.id],
    );
    expect(rows).toEqual([
      {
        status: 'recebida',
        motivo: 'Etapas (editado)',
        quantidade_enviada: '10.000',
        quantidade_recebida: '8.000',
        diferenca: '2.000',
        tratamento_divergencia: 'retorno_origem',
        custo_unitario: '4.5000',
      },
    ]);
  });

  it('cancelamento: do rascunho e do trânsito, com motivo; a cancelada não muda mais', async () => {
    const r = await rascunho('Cancelar rascunho');
    await c.query(
      `update transferencias_estoque set status = 'cancelada', cancelada_em = now(), cancelada_por_id = $2,
              motivo_cancelamento = 'Desistiu' where id = $1`,
      [r.id, ids.usuario],
    );
    const t = await rascunho('Cancelar em trânsito');
    await enviar(t);
    await c.query(
      `update transferencias_estoque set status = 'cancelada', cancelada_em = now(), cancelada_por_id = $2,
              motivo_cancelamento = 'Caminhão quebrou' where id = $1`,
      [t.id, ids.usuario],
    );
    for (const id of [r.id, t.id]) {
      const cab = (sql: string) => c.query(`update transferencias_estoque set ${sql} where id = $1`, [id]);
      await expect(
        cab("status = 'rascunho', cancelada_em = null, motivo_cancelamento = null"),
      ).rejects.toMatchObject(IMUTAVEL);
      await expect(cab("motivo_cancelamento = 'Outro motivo'")).rejects.toMatchObject(IMUTAVEL);
      await expect(cab("nfe_externa_numero = '9'")).rejects.toMatchObject(IMUTAVEL);
    }
    // O envio do rascunho cancelado nunca existiu, e o do trânsito ficou registrado.
    const { rows } = await c.query<{ id: string; enviada: boolean }>(
      'select id, enviada_em is not null as enviada from transferencias_estoque where id = any($1) order by codigo',
      [[r.id, t.id]],
    );
    expect(rows.map((x) => x.enviada)).toEqual([false, true]);
  });
});
