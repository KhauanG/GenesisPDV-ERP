/**
 * Migração 0030 (Fase 3, F3-B2; MD 3.6.11, 3.11.1, 3.11.9, 3.12.4, 3.5.6, 3.1.3; SYNC 16.3; README da API › decisão
 * 221) em empresa nova e em empresa existente: a nova nasce com promoções, orçamentos, a projeção `vendas_status_pdv` e
 * a conferência do fechamento; a existente (esquema da 0029 com loja, caixa, terminal, sessão fechada com o
 * fechamento, uma venda finalizada, um cliente com cascos em comodato e os templates padrão do seed) recebe tudo **sem
 * mudar nenhum dado** (as linhas comparadas inteiras antes e depois). Também os CHECKs (um caso inválido por
 * restrição), o saldo de comodato negativo aceito, as colunas de filtro imutáveis, a exclusão física proibida, a
 * coluna gerada `valido_ate` (isenta de versão), as chaves únicas e o índice de um template padrão por tipo e loja (que
 * já existia desde a 0002), direto no banco. O `Esquema.g.cs` só perde o CHECK do comodato (espelho sem CHECK no PDV).
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABELAS_MOVIMENTO_PDV } from '../../src/database/esquema-pdv.js';
import { garantirBanco } from '../../src/database/migracoes/controle.js';
import { aplicarMigracoes } from '../../src/database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { PREPARACOES_MIGRACAO_EMPRESA } from '../../src/database/migracoes/preparacoes-empresa.js';
import { posMigracaoEmpresa } from '../../src/plataforma/provisionamento.js';
import { traduzirErroBanco } from '../../src/sync/erros.js';
import { TABELAS_DOS_FLUXOS } from '../../src/sync/fluxos.js';
import { conectar, consultar, criarAmbiente, urlDoBanco, type Ambiente } from './ambiente.js';

const TAG = '0030_fase3_promocoes_orcamentos';
const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
const corte = migracoes.findIndex((m) => m.tag === TAG);
const TABELAS = [
  'promocoes',
  'promocoes_itens',
  'orcamentos',
  'itens_orcamento',
  'vendas_status_pdv',
  'conferencias_caixa',
  'conferencias_caixa_formas',
];

const banco = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_m30`;
let c: pg.Client;
let amb: Ambiente;
let bancoNovo: string;
const ids: Record<string, string> = {};
/** As linhas de antes da 0030, inteiras (to_jsonb), por tabela. */
let antes: Record<string, unknown[]> = {};

type Linha = Record<string, unknown>;

async function inserir(tabela: string, dados: Linha): Promise<string> {
  const colunas = Object.keys(dados);
  const { rows } = await c.query<{ id: string }>(
    `insert into ${tabela} (${colunas.join(', ')}) values (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(dados),
  );
  return rows[0]!.id;
}

async function erroDe(p: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await p;
  } catch (e) {
    return e as pg.DatabaseError;
  }
  throw new Error('esperava erro do banco');
}

/** Cada caso viola exatamente a restrição esperada, e o push o traduziria para PAYLOAD_INVALIDO (SYNC 11.2). */
async function recusados(casos: Array<[() => Promise<unknown>, string]>): Promise<void> {
  for (const [caso, restricao] of casos) {
    const e = await erroDe(caso());
    expect(e, restricao).toMatchObject({ code: '23514', constraint: restricao });
    expect(traduzirErroBanco(e), restricao).toMatchObject({ codigo: 'PAYLOAD_INVALIDO' });
  }
}

const FILTRO = { message: 'FILTRO_IMUTAVEL' };
const SEM_EXCLUSAO = { message: 'EXCLUSAO_FISICA_PROIBIDA' };

/** O que a 0030 cria, lido do catálogo. */
async function estrutura(nome: string) {
  const lista = TABELAS.map((t) => `'${t}'`).join(',');
  const triggers = await consultar<{ tabela: string; trigger: string; funcao: string }>(
    nome,
    `select c.relname as tabela, t.tgname as trigger, p.proname as funcao from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and c.relname in (${lista})
      order by 1, 2`,
  );
  const checks = await consultar<{ conname: string }>(
    nome,
    `select conname from pg_constraint where contype = 'c'
        and conrelid::regclass::text in (${lista}, 'saldos_vasilhame_pessoas') order by 1`,
  );
  const indices = await consultar<{ indexname: string; indexdef: string }>(
    nome,
    `select indexname, indexdef from pg_indexes
      where tablename in (${lista}) or indexname = 'uq_templates_documentos_padrao' order by 1`,
  );
  const fks = await consultar<{ conname: string }>(
    nome,
    `select conname from pg_constraint where contype = 'f' and conrelid::regclass::text in (${lista}) order by 1`,
  );
  const [seq] = await consultar<{ cache_size: number }>(
    nome,
    "select cache_size::int from pg_sequences where sequencename = 'seq_codigo_orcamentos'",
  );
  const [gerada] = await consultar<{ expressao: string }>(
    nome,
    `select generation_expression as expressao from information_schema.columns
      where table_name = 'orcamentos' and column_name = 'valido_ate' and is_generated = 'ALWAYS'`,
  );
  return {
    triggers,
    checks: checks.map((x) => x.conname),
    indices,
    fks: fks.map((x) => x.conname),
    seq,
    gerada,
  };
}

/** As linhas das tabelas que já existiam, inteiras, para comparar antes e depois. */
async function retrato(): Promise<Record<string, unknown[]>> {
  const r: Record<string, unknown[]> = {};
  for (const t of [
    'vendas',
    'itens_venda',
    'sessoes_caixa',
    'fechamentos_caixa',
    'fechamentos_caixa_formas',
    'saldos_vasilhame_pessoas',
    'templates_documentos',
    'produtos',
    'categorias',
    'pessoas',
  ]) {
    const { rows } = await c.query(`select to_jsonb(x) as linha from ${t} x order by id`);
    r[t] = rows.map((l: { linha: unknown }) => l.linha);
  }
  return r;
}

function promocao(extra: Linha = {}): Promise<string> {
  return inserir('promocoes', { nome: 'Leve 3 pague 2', tipo: 'leve_pague', ...extra });
}

function itemPromocao(promocaoId: string, extra: Linha = {}): Promise<string> {
  return inserir('promocoes_itens', {
    promocao_id: promocaoId,
    produto_id: ids.produto,
    papel: 'gatilho',
    ...extra,
  });
}

function orcamento(extra: Linha = {}): Promise<string> {
  return inserir('orcamentos', { loja_id: ids.loja, nome: 'Bar do Teste', ...extra });
}

function itemOrcamento(orcamentoId: string, extra: Linha = {}): Promise<string> {
  return inserir('itens_orcamento', {
    orcamento_id: orcamentoId,
    sequencia: 1,
    produto_id: ids.produto,
    descricao: 'Cerveja lata 350ml',
    unidade: 'UN',
    quantidade: '12.000',
    preco_unitario: '5.0000',
    valor_total: '60.00',
    ...extra,
  });
}

function statusPdv(extra: Linha = {}): Promise<string> {
  return inserir('vendas_status_pdv', {
    id: ids.venda,
    caixa_id: ids.caixa,
    terminal_id: ids.terminal,
    status: 'cancelada',
    status_fiscal: 'nao_aplicavel',
    devolucao: 'nenhuma',
    cancelada_em: new Date(),
    cancelamento_origem: 'erp',
    ...extra,
  });
}

function conferencia(extra: Linha = {}): Promise<string> {
  return inserir('conferencias_caixa', {
    fechamento_id: ids.fechamento,
    conferido_por_id: ids.usuario,
    conferido_em: new Date(),
    situacao: 'conferida',
    ...extra,
  });
}

beforeAll(async () => {
  expect(corte).toBeGreaterThan(0);
  await garantirBanco(urlDoBanco(banco));
  c = await conectar(banco);
  await aplicarMigracoes(c, migracoes.slice(0, corte));
  await posMigracaoEmpresa(c, {
    codigo: 999_030,
    razaoSocial: 'Empresa Antiga Ltda',
    nomeFantasia: null,
    cnpj: '11222333000181',
    email: null,
    regime: 'simples_nacional',
  });
  // A empresa das Fases 1 e 2 (e da 0029) antes da 0030: loja com caixa 01, terminal, sessão fechada com o fechamento
  // por forma, uma venda finalizada, uma categoria, um cliente com cascos em comodato e os templates do seed.
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
  ids.estoque2 = await um("insert into estoques (nome) values ('Estoque Loja 2') returning id");
  ids.loja2 = await um(
    `insert into lojas (codigo, nome, razao_social, nome_fantasia, cnpj, estoque_id, cep, logradouro, numero, bairro,
       municipio_ibge, uf)
     values (2, 'Loja 2', 'Loja 2', 'Loja 2', '11222333000343', $1, '01001000', 'Praça da Sé', '2', 'Sé', 3550308, 'SP')
     returning id`,
    [ids.estoque2],
  );
  ids.caixa = await um(
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [ids.loja],
  );
  ids.caixa2 = await um(
    "insert into caixas (loja_id, numero, descricao) values ($1, 2, 'Caixa 02') returning id",
    [ids.loja],
  );
  ids.terminal = await um(
    'insert into terminais (loja_id, caixa_id, ativado_em) values ($1, $2, now()) returning id',
    [ids.loja, ids.caixa],
  );
  ids.terminal2 = await um(
    'insert into terminais (loja_id, caixa_id, ativado_em) values ($1, $2, now()) returning id',
    [ids.loja, ids.caixa2],
  );
  ids.usuario = await um(
    "insert into usuarios (nome, login, senha_hash, master) values ('Dono', 'dono', 'x', true) returning id",
  );
  ids.produto = await um(
    "insert into produtos (nome, unidade_id) values ('Cerveja lata 350ml', (select id from unidades_medida where sigla = 'UN')) returning id",
  );
  ids.casco = await um(
    "insert into produtos (nome, unidade_id) values ('Casco 600ml', (select id from unidades_medida where sigla = 'UN')) returning id",
  );
  ids.categoria = await um(
    "insert into categorias (nome, caminho, caminho_nomes) values ('Cervejas', 'x', 'Cervejas') returning id",
  );
  ids.pessoa = await um("insert into pessoas (nome, tipo) values ('Cliente Teste', 'PF') returning id");
  ids.forma = await um(
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null limit 1",
  );
  ids.saldoCasco = await inserir('saldos_vasilhame_pessoas', {
    pessoa_id: ids.pessoa,
    produto_vasilhame_id: ids.casco,
    quantidade: '6.000',
  });
  ids.sessao = await inserir('sessoes_caixa', {
    loja_id: ids.loja,
    caixa_id: ids.caixa,
    numero_caixa: 1,
    terminal_id: ids.terminal,
    operador_id: ids.usuario,
    dia_operacional: '2026-11-20',
    aberta_em: new Date(),
    fundo_troco: '100.00',
  });
  ids.venda = await inserir('vendas', {
    numero: 1,
    numero_exibicao: 'L01-C01-000001',
    loja_id: ids.loja,
    caixa_id: ids.caixa,
    numero_caixa: 1,
    terminal_id: ids.terminal,
    sessao_caixa_id: ids.sessao,
    tipo: 'pdv',
    operador_id: ids.usuario,
    iniciada_em: new Date(),
    status: 'finalizada',
    finalizada_em: new Date(),
    total: '10.00',
  });
  ids.fechamento = await inserir('fechamentos_caixa', {
    sessao_caixa_id: ids.sessao,
    loja_id: ids.loja,
    caixa_id: ids.caixa,
    terminal_id: ids.terminal,
    numero_caixa: 1,
    tipo: 'fechamento',
    zera_caixa: true,
    usuario_anterior_id: ids.usuario,
    total_calculado: '110.00',
    total_digitado: '110.00',
    fechamento_cego: true,
    ocorrido_em: new Date(),
    dia_operacional: '2026-11-20',
  });
  await inserir('fechamentos_caixa_formas', {
    fechamento_id: ids.fechamento,
    forma_pagamento_id: ids.forma,
    descricao_forma: 'Dinheiro',
    tipo_forma: 'dinheiro',
    valor_calculado: '110.00',
    valor_digitado: '110.00',
  });
  antes = await retrato();
  // Os templates padrão do seed (loja nula) existem; um por tipo.
  expect(antes.templates_documentos!.length).toBeGreaterThan(0);

  await aplicarMigracoes(c, migracoes, { preparacoes: PREPARACOES_MIGRACAO_EMPRESA });

  amb = await criarAmbiente({ comApp: false });
  bancoNovo = (await amb.criarEmpresa()).nomeBanco;
}, 180_000);

afterAll(async () => {
  await c?.end();
  await consultar('postgres', `drop database if exists "${banco}" with (force)`);
  await amb?.fechar();
});

describe('migração 0030_fase3_promocoes_orcamentos (F3-B2)', () => {
  it('empresa nova e empresa existente terminam com a mesma estrutura; nada desce ao PDV ainda', async () => {
    const nova = await estrutura(bancoNovo);
    const existente = await estrutura(banco);
    expect(existente).toEqual(nova);
    expect(nova.seq).toEqual({ cache_size: 1 });
    expect(nova.gerada?.expressao).toBe('(data + (dias_validade)::integer)');
    const porTabela = (t: string) =>
      nova.triggers.filter((x) => x.tabela === t).map((x) => [x.trigger, x.funcao]);
    for (const t of ['promocoes', 'promocoes_itens', 'itens_orcamento'])
      expect(porTabela(t)).toEqual([
        [`tg_${t}_sem_delete`, 'fn_exclusao_fisica_proibida'],
        [`tg_${t}_sem_truncate`, 'fn_exclusao_fisica_proibida'],
        [`tg_${t}_versao`, 'fn_versao'],
      ]);
    expect(porTabela('orcamentos')).toEqual([
      ['tg_orcamentos_filtro_imutavel', 'fn_filtro_imutavel'],
      ['tg_orcamentos_sem_delete', 'fn_exclusao_fisica_proibida'],
      ['tg_orcamentos_sem_truncate', 'fn_exclusao_fisica_proibida'],
      ['tg_orcamentos_versao', 'fn_versao'],
    ]);
    expect(porTabela('vendas_status_pdv')).toEqual([
      ['tg_vendas_status_pdv_filtro_imutavel', 'fn_filtro_imutavel'],
      ['tg_vendas_status_pdv_versao', 'fn_versao'],
    ]);
    for (const t of ['conferencias_caixa', 'conferencias_caixa_formas'])
      expect(porTabela(t)).toEqual([[`tg_${t}_versao`, 'fn_versao_local']]);
    // O comodato perdeu o CHECK >= 0; nenhum outro CHECK dele existia.
    expect(nova.checks.filter((k) => k.startsWith('ck_saldos_vasilhame_pessoas'))).toEqual([]);
    const nomes = nova.indices.map((i) => i.indexname);
    expect(nomes).toEqual(
      expect.arrayContaining([
        'ix_promocoes_versao',
        'ix_promocoes_vigencia',
        'ix_promocoes_itens_versao',
        'ix_promocoes_itens_promocao_id',
        'ix_orcamentos_versao',
        'uq_orcamentos_codigo',
        'ix_orcamentos_loja_id_status',
        'ix_orcamentos_pessoa_id',
        'ix_itens_orcamento_versao',
        'uq_itens_orcamento_sequencia',
        'ix_vendas_status_pdv_versao',
        'ix_vendas_status_pdv_caixa_id_versao',
        'uq_conferencias_caixa_fechamento',
        'uq_conferencias_caixa_formas',
      ]),
    );
    // MD 3.1.3: o índice de um padrão por (tipo, loja) já existia desde a 0002, com a definição da MD.
    const padrao = nova.indices.find((i) => i.indexname === 'uq_templates_documentos_padrao');
    expect(padrao?.indexdef).toMatch(/UNIQUE INDEX .* \(tipo, loja_id\) NULLS NOT DISTINCT WHERE/);
    expect(padrao?.indexdef).toMatch(/padrao AND \(excluido_em IS NULL\)/);
    // Sem FK nas colunas que o PDV envia; `vendas_status_pdv.id` aponta para a venda.
    expect(nova.fks).toContain('fk_vendas_status_pdv_id');
    expect(nova.fks).toContain('fk_orcamentos_venda_id');
    // Pela coluna, não pelo nome da constraint: uma FK com outro nome (o padrão do `.references()` do Drizzle, ou um
    // `add constraint` fora da convenção) também recusaria o push. `vendas_status_pdv.id` entra como controle, para a
    // consulta não passar vazia por engano (ela tem de achar essa FK e só ela).
    const fksColunas = await consultar<{ tabela: string; coluna: string }>(
      bancoNovo,
      `select k.conrelid::regclass::text as tabela, a.attname as coluna
         from pg_constraint k
         join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
        where k.contype = 'f'
          and (k.conrelid::regclass::text, a.attname::text) in (
            ('vendas', 'orcamento_id'), ('itens_venda', 'promocao_id'), ('itens_venda', 'item_orcamento_id'),
            ('pagamentos_venda', 'vale_id'), ('vendas_status_pdv', 'id'))
        order by 1, 2`,
    );
    expect(fksColunas).toEqual([{ tabela: 'vendas_status_pdv', coluna: 'id' }]);
    // Nenhuma é movimento do PDV; as que descem nasceram com fn_versao e entraram nos fluxos no F3-B7 (a conferência
    // cruzada fica no sync-triggers.test.ts); a conferência do fechamento não sai da nuvem.
    for (const t of TABELAS) expect(TABELAS_MOVIMENTO_PDV as readonly string[]).not.toContain(t);
    for (const t of ['promocoes', 'promocoes_itens', 'orcamentos', 'itens_orcamento', 'vendas_status_pdv'])
      expect(TABELAS_DOS_FLUXOS).toContain(t);
    for (const t of ['conferencias_caixa', 'conferencias_caixa_formas'])
      expect(TABELAS_DOS_FLUXOS).not.toContain(t);
  });

  it('na existente, nenhum dado muda (inclusive o comodato e os templates padrão)', async () => {
    expect(await retrato()).toEqual(antes);
  });

  it('CHECKs da MD: um caso inválido por restrição', async () => {
    await recusados([
      [() => promocao({ tipo: 'brinde' }), 'ck_promocoes_tipo'],
      [() => promocao({ parametros: JSON.stringify([1]) }), 'ck_promocoes_parametros'],
      [
        () => promocao({ inicio: new Date('2026-12-02'), fim: new Date('2026-12-01') }),
        'ck_promocoes_vigencia',
      ],
      [() => promocao({ hora_inicio: '18:00' }), 'ck_promocoes_horario'],
      [() => promocao({ dias_semana: [7] }), 'ck_promocoes_dias_semana'],
      [() => promocao({ lojas: [] }), 'ck_promocoes_lojas'],
    ]);
    const p = await promocao({ tipo: 'desconto_pct_item', parametros: { pct: '10.0000' } });
    await recusados([
      [() => itemPromocao(p, { categoria_id: ids.categoria }), 'ck_promocoes_itens_alvo'],
      [() => itemPromocao(p, { produto_id: null }), 'ck_promocoes_itens_alvo'],
      [() => itemPromocao(p, { papel: 'premio' }), 'ck_promocoes_itens_papel'],
      [() => itemPromocao(p, { quantidade: '0.000' }), 'ck_promocoes_itens_quantidade'],
      [() => orcamento({ status: 'expirado' }), 'ck_orcamentos_status'],
      [() => orcamento({ respondido: 'sim' }), 'ck_orcamentos_respondido'],
      [() => orcamento({ respondido: 'aprovado' }), 'ck_orcamentos_respondido_em'],
      [() => orcamento({ respondido_em: new Date() }), 'ck_orcamentos_respondido_em'],
      [() => orcamento({ desconto_tipo: 'brinde' }), 'ck_orcamentos_desconto_tipo'],
      [() => orcamento({ dias_validade: 366 }), 'ck_orcamentos_dias_validade'],
      [() => orcamento({ total: '-1.00' }), 'ck_orcamentos_valores'],
      [() => orcamento({ desconto_pct: '100.0001' }), 'ck_orcamentos_valores'],
      [() => orcamento({ origem: 'site' }), 'ck_orcamentos_origem'],
      [() => orcamento({ origem: 'pdv' }), 'ck_orcamentos_origem_terminal'],
      [() => orcamento({ status: 'convertido' }), 'ck_orcamentos_convertido'],
      [() => orcamento({ reservado_terminal_id: ids.terminal }), 'ck_orcamentos_reserva'],
      [() => orcamento({ reservado_ate: new Date() }), 'ck_orcamentos_reserva'],
    ]);
    const o = await orcamento();
    await recusados([
      [() => itemOrcamento(o, { quantidade: '0.000' }), 'ck_itens_orcamento_quantidade'],
      [() => itemOrcamento(o, { desconto_item: '-0.01' }), 'ck_itens_orcamento_valores'],
      [() => statusPdv({ status: 'devolvida' }), 'ck_vendas_status_pdv_status'],
      [() => statusPdv({ status_fiscal: 'emitida' }), 'ck_vendas_status_pdv_status_fiscal'],
      [() => statusPdv({ devolucao: 'metade' }), 'ck_vendas_status_pdv_devolucao'],
      [() => statusPdv({ cancelamento_origem: 'api' }), 'ck_vendas_status_pdv_cancelamento_origem'],
      [() => conferencia({ situacao: 'aberta' }), 'ck_conferencias_caixa_situacao'],
    ]);
    const conf = await conferencia();
    await recusados([
      [
        () =>
          inserir('conferencias_caixa_formas', {
            conferencia_id: conf,
            forma_pagamento_id: ids.forma,
            valor_conferido: '-1.00',
            diferenca: '-111.00',
          }),
        'ck_conferencias_caixa_formas_valor',
      ],
    ]);
    // Uma conferência por fechamento (refazer altera a mesma linha, D114) e um valor por forma.
    expect(await erroDe(conferencia())).toMatchObject({
      code: '23505',
      constraint: 'uq_conferencias_caixa_fechamento',
    });
    const forma = {
      conferencia_id: conf,
      forma_pagamento_id: ids.forma,
      valor_conferido: '109.95',
      diferenca: '-0.05',
    };
    await inserir('conferencias_caixa_formas', forma);
    expect(await erroDe(inserir('conferencias_caixa_formas', forma))).toMatchObject({
      code: '23505',
      constraint: 'uq_conferencias_caixa_formas',
    });
    await c.query("update conferencias_caixa set situacao = 'divergente' where id = $1", [conf]);
  });

  it('comodato: o saldo pode ficar negativo (projeção comutativa) e versiona a cada mudança', async () => {
    const { rows: a } = await c.query<{ versao: string }>(
      'select versao from saldos_vasilhame_pessoas where id = $1',
      [ids.saldoCasco],
    );
    const { rows: b } = await c.query<{ versao: string; quantidade: string }>(
      "update saldos_vasilhame_pessoas set quantidade = '-2.000' where id = $1 returning versao, quantidade",
      [ids.saldoCasco],
    );
    expect(b[0]!.quantidade).toBe('-2.000');
    expect(Number(b[0]!.versao)).toBeGreaterThan(Number(a[0]!.versao));
    await c.query("update saldos_vasilhame_pessoas set quantidade = '6.000' where id = $1", [ids.saldoCasco]);
  });

  it('orçamento: código da sequência, valido_ate gerada e isenta de versão, filtro imutável e sem exclusão física', async () => {
    const o = await orcamento({ data: '2026-11-25', dias_validade: 10, pessoa_id: ids.pessoa });
    const { rows: r1 } = await c.query<{ codigo: number; valido_ate: string; versao: string }>(
      "select codigo, to_char(valido_ate, 'YYYY-MM-DD') as valido_ate, versao from orcamentos where id = $1",
      [o],
    );
    expect(r1[0]!.codigo).toBeGreaterThan(0);
    expect(r1[0]!.valido_ate).toBe('2026-12-05');
    // UPDATE sem mudança real não gera versão (a coluna gerada chega nula no NEW do BEFORE e é isenta).
    const { rows: r2 } = await c.query<{ versao: string }>(
      'update orcamentos set nome = nome where id = $1 returning versao',
      [o],
    );
    expect(r2[0]!.versao).toBe(r1[0]!.versao);
    const { rows: r3 } = await c.query<{ versao: string; valido_ate: string }>(
      "update orcamentos set dias_validade = 30 where id = $1 returning versao, to_char(valido_ate, 'YYYY-MM-DD') as valido_ate",
      [o],
    );
    expect(r3[0]!.valido_ate).toBe('2026-12-25');
    expect(Number(r3[0]!.versao)).toBeGreaterThan(Number(r1[0]!.versao));
    const e = await erroDe(orcamento({ codigo: r1[0]!.codigo }));
    expect(e).toMatchObject({ code: '23505', constraint: 'uq_orcamentos_codigo' });
    // Reserva online (as duas colunas juntas), resposta do cliente e conversão.
    await c.query(
      "update orcamentos set reservado_terminal_id = $2, reservado_ate = now() + interval '2 hours' where id = $1",
      [o, ids.terminal],
    );
    await c.query(
      "update orcamentos set status = 'convertido', convertido_em = now(), venda_id = $2 where id = $1",
      [o, ids.venda],
    );
    await expect(
      c.query('update orcamentos set loja_id = $2 where id = $1', [o, ids.loja2]),
    ).rejects.toMatchObject(FILTRO);
    const i = await itemOrcamento(o);
    expect(await erroDe(itemOrcamento(o))).toMatchObject({
      code: '23505',
      constraint: 'uq_itens_orcamento_sequencia',
    });
    // Orçamento criado no caixa (D118): com o terminal de origem.
    await orcamento({ origem: 'pdv', origem_terminal_id: ids.terminal });
    for (const [tabela, id] of [
      ['itens_orcamento', i],
      ['orcamentos', o],
    ] as const) {
      await expect(c.query(`delete from ${tabela} where id = $1`, [id])).rejects.toMatchObject(SEM_EXCLUSAO);
      await expect(c.query(`truncate ${tabela} cascade`)).rejects.toMatchObject(SEM_EXCLUSAO);
    }
    // A exclusão é lógica (desce como tombstone no F3-B7).
    await c.query('update orcamentos set excluido_em = now() where id = $1', [o]);
  });

  it('promoção: versão nova a cada mudança, só inativação (sem exclusão física)', async () => {
    const p = await promocao({
      tipo: 'preco_fixo',
      parametros: { preco: '29.90' },
      dias_semana: [5, 6],
      hora_inicio: '18:00',
      hora_fim: '20:00',
      lojas: [ids.loja],
      inicio: new Date('2026-12-01'),
      fim: new Date('2026-12-31'),
    });
    const it1 = await itemPromocao(p, { produto_id: null, categoria_id: ids.categoria, papel: 'gatilho' });
    await itemPromocao(p, { papel: 'brinde', quantidade: '1.000' });
    const { rows: a } = await c.query<{ versao: string }>('select versao from promocoes where id = $1', [p]);
    const { rows: b } = await c.query<{ versao: string }>(
      'update promocoes set ativo = false where id = $1 returning versao',
      [p],
    );
    expect(Number(b[0]!.versao)).toBeGreaterThan(Number(a[0]!.versao));
    for (const [tabela, id] of [
      ['promocoes_itens', it1],
      ['promocoes', p],
    ] as const) {
      await expect(c.query(`delete from ${tabela} where id = $1`, [id])).rejects.toMatchObject(SEM_EXCLUSAO);
      await expect(c.query(`truncate ${tabela} cascade`)).rejects.toMatchObject(SEM_EXCLUSAO);
    }
  });

  it('vendas_status_pdv: o id é o da venda, caixa e terminal imutáveis, status livres', async () => {
    // Venda que não existe: a projeção é sempre gravada pela nuvem junto da mudança na venda (F3-B10).
    expect(await erroDe(statusPdv({ id: uuidv7() }))).toMatchObject({
      code: '23503',
      constraint: 'fk_vendas_status_pdv_id',
    });
    await statusPdv();
    expect(await erroDe(statusPdv())).toMatchObject({ code: '23505', constraint: 'pk_vendas_status_pdv' });
    const { rows: a } = await c.query<{ versao: string }>(
      'select versao from vendas_status_pdv where id = $1',
      [ids.venda],
    );
    const { rows: b } = await c.query<{ versao: string }>(
      "update vendas_status_pdv set devolucao = 'parcial' where id = $1 returning versao",
      [ids.venda],
    );
    expect(Number(b[0]!.versao)).toBeGreaterThan(Number(a[0]!.versao));
    for (const [coluna, valor] of [
      ['caixa_id', ids.caixa2],
      ['terminal_id', ids.terminal2],
    ] as const)
      await expect(
        c.query(`update vendas_status_pdv set ${coluna} = $2 where id = $1`, [ids.venda, valor]),
      ).rejects.toMatchObject(FILTRO);
  });

  it('template: um padrão por (tipo, loja), com a loja nula contando como "todas" e o excluído fora', async () => {
    const { rows } = await c.query<{ id: string; tipo: string }>(
      "select id, tipo from templates_documentos where padrao and loja_id is null and tipo = 'cupom_rodape'",
    );
    expect(rows).toHaveLength(1);
    const novo = (extra: Linha = {}) =>
      inserir('templates_documentos', {
        tipo: 'cupom_rodape',
        nome: 'Rodapé alternativo',
        formato: 'texto',
        conteudo: 'Obrigado!',
        padrao: true,
        ...extra,
      });
    expect(await erroDe(novo())).toMatchObject({
      code: '23505',
      constraint: 'uq_templates_documentos_padrao',
    });
    // Padrão da loja 1 convive com o de todas; o segundo da loja 1, não.
    await novo({ loja_id: ids.loja });
    expect(await erroDe(novo({ loja_id: ids.loja }))).toMatchObject({
      code: '23505',
      constraint: 'uq_templates_documentos_padrao',
    });
    // Excluído logicamente deixa de contar.
    await c.query('update templates_documentos set excluido_em = now() where id = $1', [rows[0]!.id]);
    await novo();
  });
});
