/**
 * Migração 0023 (Fase 2, F2-B14; MD 3.8.1; README da API › decisão 159) em empresa nova e em empresa existente: a nova
 * nasce com as tabelas, a sequência do `codigo`, os triggers de versão (`fn_versao_local`), de imutabilidade e do
 * rascunho dos itens; a existente (esquema da 0022 com cadastro e um acerto efetivado) recebe tudo sem mexer no que já
 * estava, e o primeiro recebimento dela é o Nº 1. O `Esquema.g.cs` do PDV não muda (o `verificar:esquema-pdv` e o
 * `esquema-pdv.spec.ts` conferem; nenhuma das tabelas está num fluxo).
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
const corte = migracoes.findIndex((m) => m.tag === '0023_recebimentos');

const banco = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_m23`;
let c: pg.Client;
let amb: Ambiente;
let bancoNovo: string;

const ids: Record<string, string> = {};

/** O que a 0023 cria, lido do catálogo (as duas tabelas, a sequência e os triggers que não são de FK). */
async function estrutura(nome: string) {
  const triggers = await consultar<{ tabela: string; trigger: string; funcao: string }>(
    nome,
    `select c.relname as tabela, t.tgname as trigger, p.proname as funcao from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and c.relname in ('recebimentos', 'itens_recebimento')
      order by 1, 2`,
  );
  const [seq] = await consultar<{ cache_size: number }>(
    nome,
    "select cache_size::int from pg_sequences where sequencename = 'seq_codigo_recebimentos'",
  );
  const checks = await consultar<{ conname: string }>(
    nome,
    `select conname from pg_constraint
      where contype = 'c' and conrelid in ('recebimentos'::regclass, 'itens_recebimento'::regclass) order by 1`,
  );
  return { triggers, seq, checks: checks.map((x) => x.conname) };
}

beforeAll(async () => {
  expect(corte).toBeGreaterThan(0);
  await garantirBanco(urlDoBanco(banco));
  c = await conectar(banco);
  await aplicarMigracoes(c, migracoes.slice(0, corte));
  await posMigracaoEmpresa(c, {
    codigo: 999_023,
    razaoSocial: 'Empresa Antiga Ltda',
    nomeFantasia: null,
    cnpj: '11222333000181',
    email: null,
    regime: 'simples_nacional',
  });
  // Cadastro da empresa antes da 0023: loja com estoque, fornecedor, produto e um acerto efetivado.
  const um = async (sql: string, params: unknown[] = []) =>
    (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
  ids.estoque = await um("insert into estoques (nome) values ('Estoque Loja 1') returning id");
  ids.loja = await um(
    `insert into lojas (codigo, nome, razao_social, nome_fantasia, cnpj, estoque_id, cep, logradouro, numero, bairro,
       municipio_ibge, uf)
     values (1, 'Loja 1', 'Loja 1', 'Loja 1', '11222333000262', $1, '01001000', 'Praça da Sé', '1', 'Sé', 3550308, 'SP')
     returning id`,
    [ids.estoque],
  );
  ids.fornecedor = await um("insert into pessoas (nome, tipo) values ('Distribuidora X', 'PJ') returning id");
  await c.query("insert into pessoas_categorias (pessoa_id, categoria) values ($1, 'fornecedor')", [
    ids.fornecedor,
  ]);
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
    [ids.estoque, ids.tipo, ids.usuario],
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

describe('migração 0023_recebimentos (F2-B14)', () => {
  it('empresa nova e empresa existente terminam com a mesma estrutura', async () => {
    const nova = await estrutura(bancoNovo);
    const existente = await estrutura(banco);
    expect(existente).toEqual(nova);
    expect(nova.seq).toEqual({ cache_size: 1 });
    expect(nova.triggers).toEqual([
      {
        tabela: 'itens_recebimento',
        trigger: 'tg_itens_recebimento_rascunho',
        funcao: 'fn_itens_recebimento_rascunho',
      },
      { tabela: 'itens_recebimento', trigger: 'tg_itens_recebimento_versao', funcao: 'fn_versao_local' },
      // O estornado é o fim desde a 0024 (a empresa nova e a existente têm todas as migrações).
      {
        tabela: 'recebimentos',
        trigger: 'tg_recebimentos_estornado_final',
        funcao: 'fn_protege_imutavel',
      },
      { tabela: 'recebimentos', trigger: 'tg_recebimentos_imutavel', funcao: 'fn_protege_imutavel' },
      { tabela: 'recebimentos', trigger: 'tg_recebimentos_versao', funcao: 'fn_versao_local' },
    ]);
    expect(nova.checks).toEqual([
      'ck_itens_recebimento_atualizar_preco',
      'ck_itens_recebimento_rateios',
      'ck_itens_recebimento_validade',
      'ck_itens_recebimento_valores',
      'ck_recebimentos_financeiro',
      'ck_recebimentos_movimentacao',
      'ck_recebimentos_status',
      'ck_recebimentos_valores',
    ]);
    // Nenhuma das tabelas desce ao PDV.
    expect(TABELAS_DOS_FLUXOS).not.toContain('recebimentos');
    expect(TABELAS_DOS_FLUXOS).not.toContain('itens_recebimento');
  });

  it('na existente, o que já estava fica igual e o primeiro recebimento é o Nº 1, com versão e item no rascunho', async () => {
    const { rows: acerto } = await c.query('select status, motivo from acertos_estoque where id = $1', [
      ids.acerto,
    ]);
    expect(acerto).toEqual([{ status: 'efetivado', motivo: 'Inventário' }]);
    const { rows: r } = await c.query<{
      id: string;
      codigo: number;
      versao: string;
      data_recebimento: string;
    }>(
      `insert into recebimentos (loja_id, estoque_id, tipo_estoque_id, fornecedor_id)
       values ($1, $2, $3, $4) returning id, codigo, versao, data_recebimento::text`,
      [ids.loja, ids.estoque, ids.tipo, ids.fornecedor],
    );
    expect(r[0]!.codigo).toBe(1);
    expect(Number(r[0]!.versao)).toBeGreaterThan(0);
    await c.query(
      `insert into itens_recebimento (recebimento_id, sequencia, produto_id, fator, quantidade, quantidade_estoque,
                                      preco_compra, valor_total)
       values ($1, 1, $2, 12, 10, 120, 60, 600)`,
      [r[0]!.id, ids.produto],
    );
    // Fora do rascunho, o item não muda.
    await c.query("update recebimentos set status = 'movimentado', movimentado_em = now() where id = $1", [
      r[0]!.id,
    ]);
    await expect(
      c.query('update itens_recebimento set quantidade = 1 where recebimento_id = $1', [r[0]!.id]),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
    // O financeiro marcado exige o plano de contas (MD 3.8.1).
    await expect(
      c.query(
        `insert into recebimentos (loja_id, estoque_id, tipo_estoque_id, fornecedor_id, gerar_financeiro)
         values ($1, $2, $3, $4, true)`,
        [ids.loja, ids.estoque, ids.tipo, ids.fornecedor],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
