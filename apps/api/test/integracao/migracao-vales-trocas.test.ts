/**
 * Migração 0029 (Fase 3, F3-B1; MD 3.13, 3.11.3; SYNC 9.16, 9.17, 14.4, 20.4; README da API › decisão 220) em empresa
 * nova e em empresa existente: a nova nasce com trocas, vales, reservas e o registro das requisições; a existente
 * (esquema da 0028 com loja, caixa 0, caixa 01, terminal, sessão, uma venda finalizada, uma cancelada e um rascunho)
 * recebe tudo **sem mudar nenhum dado** (as linhas comparadas inteiras antes e depois), mais a numeração `vale` do
 * caixa 0 e os dois tipos de estorno. O diagnóstico da preparação conta as colunas que o PDV ainda não preenche.
 * Também os CHECKs (um caso inválido por restrição), a imutabilidade (troca, item da troca, movimento do vale e o item
 * da venda fechada), a exclusão física proibida, o saldo negativo aceito e as chaves únicas, direto no banco.
 * O `Esquema.g.cs` do PDV não muda (nenhuma tabela nova num fluxo nem em `TABELAS_MOVIMENTO_PDV`).
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABELAS_MOVIMENTO_PDV } from '../../src/database/esquema-pdv.js';
import { STATUS_VENDA_ABERTOS } from '../../src/database/empresa/schema/vendas.js';
import { garantirBanco } from '../../src/database/migracoes/controle.js';
import { aplicarMigracoes, type RelatoPreparacao } from '../../src/database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import {
  PREPARACOES_MIGRACAO_EMPRESA,
  relatoDiagnosticoFase3,
} from '../../src/database/migracoes/preparacoes-empresa.js';
import { posMigracaoEmpresa } from '../../src/plataforma/provisionamento.js';
import { traduzirErroBanco } from '../../src/sync/erros.js';
import { TABELAS_DOS_FLUXOS } from '../../src/sync/fluxos.js';
import { conectar, consultar, criarAmbiente, urlDoBanco, type Ambiente } from './ambiente.js';

const TAG = '0029_fase3_vales_trocas';
const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
const corte = migracoes.findIndex((m) => m.tag === TAG);
const TABELAS = [
  'trocas',
  'itens_troca',
  'vales',
  'movimentos_vale',
  'reservas_vale',
  'requisicoes_terminal',
];

const banco = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_m29`;
let c: pg.Client;
let amb: Ambiente;
let bancoNovo: string;
const relatos: RelatoPreparacao[] = [];
const ids: Record<string, string> = {};
/** As linhas de antes da 0029, inteiras (to_jsonb), por tabela. */
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

const IMUTAVEL = { message: 'DOCUMENTO_IMUTAVEL' };
const SEM_EXCLUSAO = { message: 'EXCLUSAO_FISICA_PROIBIDA' };

/** O que a 0029 cria, lido do catálogo. */
async function estrutura(nome: string) {
  const lista = TABELAS.map((t) => `'${t}'`).join(',');
  const triggers = await consultar<{ tabela: string; trigger: string; funcao: string }>(
    nome,
    `select c.relname as tabela, t.tgname as trigger, p.proname as funcao from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and (c.relname in (${lista}) or t.tgname = 'tg_itens_venda_imutavel')
      order by 1, 2`,
  );
  const checks = await consultar<{ conname: string }>(
    nome,
    `select conname from pg_constraint where contype = 'c' and conrelid::regclass::text in (${lista}) order by 1`,
  );
  const indices = await consultar<{ indexname: string }>(
    nome,
    `select indexname from pg_indexes where tablename in (${lista}) order by 1`,
  );
  const [seq] = await consultar<{ cache_size: number }>(
    nome,
    "select cache_size::int from pg_sequences where sequencename = 'seq_codigo_trocas'",
  );
  const tipos = await consultar<{ codigo: string; sinal: number }>(
    nome,
    "select codigo, sinal from tipos_movimento_estoque where codigo like 'ESTORNO_%' and codigo in ('ESTORNO_VASILHAME_EMPRESTADO', 'ESTORNO_BAIXA_INTERNA') order by 1",
  );
  return {
    triggers,
    checks: checks.map((x) => x.conname),
    indices: indices.map((x) => x.indexname),
    seq,
    tipos,
  };
}

/** As linhas das tabelas que já existiam, inteiras, para comparar antes e depois. */
async function retrato(): Promise<Record<string, unknown[]>> {
  const r: Record<string, unknown[]> = {};
  for (const t of [
    'vendas',
    'itens_venda',
    'pagamentos_venda',
    'sessoes_caixa',
    'movimentos_caixa',
    'caixas',
    'terminais',
  ]) {
    const { rows } = await c.query(`select to_jsonb(x) as linha from ${t} x order by id`);
    r[t] = rows.map((l: { linha: unknown }) => l.linha);
  }
  const { rows } = await c.query(
    "select to_jsonb(x) as linha from numeracoes x where not (tipo = 'vale' and dono = 'nuvem') order by id",
  );
  r.numeracoes = rows.map((l: { linha: unknown }) => l.linha);
  return r;
}

let numeroVenda = 0;
function venda(extra: Linha = {}): Promise<string> {
  const n = ++numeroVenda;
  return inserir('vendas', {
    numero: n,
    numero_exibicao: `L01-C01-${String(n).padStart(6, '0')}`,
    loja_id: ids.loja,
    caixa_id: ids.caixa,
    numero_caixa: 1,
    terminal_id: ids.terminal,
    sessao_caixa_id: ids.sessao,
    tipo: 'pdv',
    operador_id: ids.usuario,
    iniciada_em: new Date(),
    ...extra,
  });
}

function item(vendaId: string, extra: Linha = {}): Promise<string> {
  return inserir('itens_venda', {
    venda_id: vendaId,
    sequencia: 1,
    produto_id: ids.produto,
    descricao: 'Cerveja lata 350ml',
    unidade: 'UN',
    quantidade: '2.000',
    preco_tabela: '5.0000',
    preco_unitario: '5.0000',
    valor_bruto: '10.00',
    valor_liquido: '10.00',
    custo_unitario: '3.0000',
    incluido_em: new Date(),
    ...extra,
  });
}

let numeroVale = 0;
/** Código de vale no formato (o DV Luhn é do F3-B5; o banco só confere o formato). */
const codigoVale = () => `VC0101${String(++numeroVale).padStart(7, '0')}0`;

function vale(extra: Linha = {}): Promise<string> {
  return inserir('vales', {
    codigo: codigoVale(),
    tipo: 'vale_troca',
    loja_emissao_id: ids.loja,
    terminal_emissao_id: ids.terminal,
    valor_original: '10.00',
    saldo: '10.00',
    validade: '2027-02-23',
    origem_tipo: 'troca',
    emitido_em: new Date(),
    emitido_por_id: ids.usuario,
    ...extra,
  });
}

function troca(extra: Linha = {}): Promise<string> {
  return inserir('trocas', {
    loja_id: ids.loja,
    caixa_id: ids.caixa,
    terminal_id: ids.terminal,
    sessao_caixa_id: ids.sessao,
    numero_caixa: 1,
    venda_origem_id: ids.vendaFinalizada,
    operador_id: ids.usuario,
    motivo: 'Embalagem danificada',
    resolucao: 'vale_troca',
    valor_total: '5.00',
    ocorrida_em: new Date(),
    ...extra,
  });
}

function itemTroca(trocaId: string, extra: Linha = {}): Promise<string> {
  return inserir('itens_troca', {
    troca_id: trocaId,
    sequencia: 1,
    item_venda_origem_id: ids.itemFinalizado,
    produto_id: ids.produto,
    quantidade: '1.000',
    valor_unitario: '5.0000',
    valor_total: '5.00',
    destino: 'estoque',
    ...extra,
  });
}

function movimentoVale(valeId: string, extra: Linha = {}): Promise<string> {
  return inserir('movimentos_vale', {
    vale_id: valeId,
    tipo: 'emissao',
    valor: '10.00',
    terminal_id: ids.terminal,
    usuario_id: ids.usuario,
    ocorrido_em: new Date(),
    ...extra,
  });
}

beforeAll(async () => {
  expect(corte).toBeGreaterThan(0);
  await garantirBanco(urlDoBanco(banco));
  c = await conectar(banco);
  await aplicarMigracoes(c, migracoes.slice(0, corte));
  await posMigracaoEmpresa(c, {
    codigo: 999_029,
    razaoSocial: 'Empresa Antiga Ltda',
    nomeFantasia: null,
    cnpj: '11222333000181',
    email: null,
    regime: 'simples_nacional',
  });
  // O carregamento das referências acima já usa a lista nova (`TIPOS_MOVIMENTO_ESTOQUE`); sem os dois estornos, a
  // empresa fica como as que existiam antes da 0029, e é a própria migração que os grava.
  await c.query(
    "delete from tipos_movimento_estoque where codigo in ('ESTORNO_VASILHAME_EMPRESTADO', 'ESTORNO_BAIXA_INTERNA')",
  );
  // A empresa das Fases 1 e 2 antes da 0029: loja com caixa 0 (só a numeração `venda`, como o assistente fazia) e
  // caixa 01 com terminal e sessão, uma venda finalizada com item e pagamento, uma cancelada e um rascunho do ERP.
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
  ids.caixa0 = await um(
    "insert into caixas (loja_id, numero, descricao, sistema) values ($1, 0, 'Caixa 00', true) returning id",
    [ids.loja],
  );
  ids.caixa = await um(
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [ids.loja],
  );
  for (const [caixa, dono, tipos] of [
    [ids.caixa0, 'nuvem', ['venda']],
    [ids.caixa, 'terminal', ['venda', 'vale']],
  ] as const)
    for (const tipo of tipos)
      await c.query(
        'insert into numeracoes (tipo, loja_id, caixa_id, dono, ultimo_numero) values ($1, $2, $3, $4, 3)',
        [tipo, ids.loja, caixa, dono],
      );
  ids.terminal = await um(
    'insert into terminais (loja_id, caixa_id, ativado_em) values ($1, $2, now()) returning id',
    [ids.loja, ids.caixa],
  );
  ids.usuario = await um(
    "insert into usuarios (nome, login, senha_hash, master) values ('Dono', 'dono', 'x', true) returning id",
  );
  ids.produto = await um(
    "insert into produtos (nome, unidade_id) values ('Cerveja lata 350ml', (select id from unidades_medida where sigla = 'UN')) returning id",
  );
  ids.forma = await um(
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null limit 1",
  );
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
  ids.vendaFinalizada = await venda({ status: 'finalizada', finalizada_em: new Date(), total: '10.00' });
  ids.itemFinalizado = await item(ids.vendaFinalizada);
  const pagamento = {
    venda_id: ids.vendaFinalizada,
    sequencia: 1,
    forma_pagamento_id: ids.forma,
    descricao_forma: 'Dinheiro',
    meio_pagamento_fiscal: '01',
    tipo_forma: 'dinheiro',
    valor: '10.00',
    lanca_quitada: true,
  };
  await inserir('pagamentos_venda', pagamento);
  // As colunas que nenhum PDV publicado preenche, com uma contagem diferente em cada uma (uuids inventados, sem FK),
  // para o diagnóstico não passar com duas subconsultas trocadas: 1 de 2 pagamentos com `vale_id`, 2 de 3 vendas
  // com `orcamento_id` e 3 de 4 itens com `promocao_id`.
  await inserir('pagamentos_venda', { ...pagamento, sequencia: 2, valor: '1.00', vale_id: uuidv7() });
  await item(ids.vendaFinalizada, { sequencia: 2, promocao_id: uuidv7() });
  ids.vendaCancelada = await venda({
    status: 'cancelada',
    finalizada_em: new Date(),
    cancelada_em: new Date(),
    motivo_cancelamento: 'Cliente desistiu',
    orcamento_id: uuidv7(),
  });
  ids.itemCancelado = await item(ids.vendaCancelada, { promocao_id: uuidv7() });
  ids.rascunho = await venda({
    status: 'rascunho',
    canal: 'erp',
    caixa_id: ids.caixa0,
    numero_caixa: 0,
    orcamento_id: uuidv7(),
  });
  ids.itemRascunho = await item(ids.rascunho, { promocao_id: uuidv7() });
  await inserir('movimentos_caixa', {
    sessao_caixa_id: ids.sessao,
    loja_id: ids.loja,
    caixa_id: ids.caixa,
    numero_caixa: 1,
    terminal_id: ids.terminal,
    tipo: 'sangria',
    valor: '20.00',
    quem_retira_nome: 'Gerente',
    operador_id: ids.usuario,
    ocorrido_em: new Date(),
  });
  antes = await retrato();

  await aplicarMigracoes(c, migracoes, {
    preparacoes: PREPARACOES_MIGRACAO_EMPRESA,
    ganchos: { aoPreparar: async (m, relato) => void (m.tag === TAG && relatos.push(relato)) },
  });

  amb = await criarAmbiente({ comApp: false });
  bancoNovo = (await amb.criarEmpresa()).nomeBanco;
}, 180_000);

afterAll(async () => {
  await c?.end();
  await consultar('postgres', `drop database if exists "${banco}" with (force)`);
  await amb?.fechar();
});

describe('migração 0029_fase3_vales_trocas (F3-B1)', () => {
  it('empresa nova e empresa existente terminam com a mesma estrutura; nada desce ao PDV ainda', async () => {
    const nova = await estrutura(bancoNovo);
    const existente = await estrutura(banco);
    expect(existente).toEqual(nova);
    expect(nova.seq).toEqual({ cache_size: 1 });
    expect(nova.tipos).toEqual([
      { codigo: 'ESTORNO_BAIXA_INTERNA', sinal: 1 },
      { codigo: 'ESTORNO_VASILHAME_EMPRESTADO', sinal: 1 },
    ]);
    const porTabela = (t: string) =>
      nova.triggers.filter((x) => x.tabela === t).map((x) => [x.trigger, x.funcao]);
    expect(porTabela('vales')).toEqual([['tg_vales_versao', 'fn_versao']]);
    expect(porTabela('reservas_vale')).toEqual([['tg_reservas_vale_versao', 'fn_versao_local']]);
    expect(porTabela('requisicoes_terminal')).toEqual([]);
    expect(porTabela('trocas')).toEqual([
      ['tg_trocas_imutavel', 'fn_protege_imutavel'],
      ['tg_trocas_sem_delete', 'fn_exclusao_fisica_proibida'],
      ['tg_trocas_sem_truncate', 'fn_exclusao_fisica_proibida'],
      ['tg_trocas_transicao', 'fn_trocas_transicao'],
      ['tg_trocas_versao', 'fn_versao_local'],
    ]);
    for (const t of ['itens_troca', 'movimentos_vale'])
      expect(porTabela(t)).toEqual([
        [`tg_${t}_imutavel`, 'fn_protege_imutavel'],
        [`tg_${t}_sem_delete`, 'fn_exclusao_fisica_proibida'],
        [`tg_${t}_sem_truncate`, 'fn_exclusao_fisica_proibida'],
        [`tg_${t}_versao`, 'fn_versao_local'],
      ]);
    expect(porTabela('itens_venda')).toEqual([['tg_itens_venda_imutavel', 'fn_itens_venda_imutavel']]);
    expect(nova.indices).toEqual(
      expect.arrayContaining([
        'ix_vales_versao',
        'uq_vales_codigo',
        'ix_vales_pessoa_id',
        'uq_movimentos_vale_pagamento',
        'ix_movimentos_vale_vale_id',
        'uq_reservas_vale_pagamento',
        'ix_reservas_vale_vale_id_status',
        'pk_requisicoes_terminal',
        'ix_requisicoes_terminal_criada_em',
        'ix_trocas_venda_origem_id',
        'ix_trocas_loja_ocorrida',
        'uq_itens_troca_sequencia',
      ]),
    );
    // Nenhuma tabela nova está num fluxo nem é espelho de movimento do PDV: o Esquema.g.cs não muda (F3-B7).
    for (const t of TABELAS) {
      expect(TABELAS_DOS_FLUXOS).not.toContain(t);
      expect(TABELAS_MOVIMENTO_PDV as readonly string[]).not.toContain(t);
    }
  });

  it('na existente, nenhum dado muda; o caixa 0 ganha a numeração `vale` e o diagnóstico conta o que o PDV não manda', async () => {
    expect(await retrato()).toEqual(antes);
    const nums = await consultar<{ caixa_id: string; dono: string; ultimo_numero: string }>(
      banco,
      "select caixa_id, dono, ultimo_numero from numeracoes where tipo = 'vale' order by dono",
    );
    expect(nums).toEqual([
      { caixa_id: ids.caixa0, dono: 'nuvem', ultimo_numero: '0' },
      { caixa_id: ids.caixa, dono: 'terminal', ultimo_numero: '3' },
    ]);
    // A segunda aplicação (o journal já aplicado): a 0029 é vista como aplicada e nem começa, então a preparação
    // não roda de novo (nenhum relato novo) e o SQL dela, com a carga, também não.
    const repetidos: RelatoPreparacao[] = [];
    const iniciadas: string[] = [];
    const jaAplicadas: string[] = [];
    await aplicarMigracoes(c, migracoes, {
      preparacoes: PREPARACOES_MIGRACAO_EMPRESA,
      ganchos: {
        aoIniciar: async (m) => void iniciadas.push(m.tag),
        aoEncontrarAplicada: async (m) => void jaAplicadas.push(m.tag),
        aoPreparar: async (_m, relato) => void repetidos.push(relato),
      },
    });
    expect(iniciadas).toEqual([]);
    expect(jaAplicadas).toContain(TAG);
    expect(repetidos).toEqual([]);
    // A carga em si também é idempotente: o INSERT da numeração `vale`, rodado de novo isolado, não duplica (o
    // `not exists`), e o caixa 01, que já tinha a sua (dono `terminal`), não ganha outra.
    const cargaVale = migracoes[corte]!.comandos.filter((x) => x.includes('insert into numeracoes'));
    expect(cargaVale).toHaveLength(1);
    const repetida = await c.query(cargaVale[0]!);
    expect(repetida.rowCount).toBe(0);
    expect(
      await consultar<{ caixa_id: string; dono: string }>(
        banco,
        "select caixa_id, dono from numeracoes where tipo = 'vale' order by dono",
      ),
    ).toEqual([
      { caixa_id: ids.caixa0, dono: 'nuvem' },
      { caixa_id: ids.caixa, dono: 'terminal' },
    ]);
    // Cada contagem do diagnóstico sai da sua coluna (1, 2 e 3: uma subconsulta trocada não passa) e vira uma parte
    // do aviso.
    expect(relatos).toHaveLength(1);
    expect(relatos[0]!.dados).toEqual({
      pagamentos_com_vale: 1,
      vendas_com_orcamento: 2,
      itens_com_promocao: 3,
    });
    expect(relatos[0]!.avisos).toHaveLength(1);
    for (const parte of [
      '1 pagamento(s) de venda com vale_id',
      '2 venda(s) com orcamento_id',
      '3 item(ns) de venda com promocao_id',
    ])
      expect(relatos[0]!.avisos[0]).toContain(parte);
    // Banco novo (sem venda) não relata; com vendas e tudo zero, só a contagem para a auditoria, sem aviso.
    const zero = { pagamentosComVale: 0, vendasComOrcamento: 0, itensComPromocao: 0 };
    expect(relatoDiagnosticoFase3(zero, false)).toBeUndefined();
    expect(relatoDiagnosticoFase3(zero, true)).toEqual({
      avisos: [],
      dados: { pagamentos_com_vale: 0, vendas_com_orcamento: 0, itens_com_promocao: 0 },
    });
  });

  it('CHECKs da MD 3.13: um caso inválido por restrição', async () => {
    await recusados([
      [() => vale({ codigo: 'VC01010000001' }), 'ck_vales_codigo'],
      [() => vale({ codigo: 'VX010100000010' }), 'ck_vales_codigo'],
      [() => vale({ tipo: 'presente' }), 'ck_vales_tipo'],
      [() => vale({ status: 'zerado' }), 'ck_vales_status'],
      [() => vale({ origem_tipo: 'erp' }), 'ck_vales_origem_tipo'],
      [() => vale({ valor_original: '0.00' }), 'ck_vales_valor_original'],
      [() => vale({ status: 'cancelado' }), 'ck_vales_cancelado'],
      [() => troca({ origem: 'api' }), 'ck_trocas_origem'],
      [() => troca({ resolucao: 'credito' }), 'ck_trocas_resolucao'],
      [() => troca({ status: 'estornada' }), 'ck_trocas_status'],
      [() => troca({ venda_origem_id: null }), 'ck_trocas_venda_origem'],
      [() => troca({ sessao_caixa_id: null }), 'ck_trocas_pdv'],
      [
        () => troca({ origem: 'erp', caixa_id: ids.caixa0, numero_caixa: 0, resolucao: 'troca_imediata' }),
        'ck_trocas_erp',
      ],
      [() => troca({ valor_total: '-0.01' }), 'ck_trocas_valor'],
      [() => troca({ status: 'cancelada' }), 'ck_trocas_cancelada'],
    ]);
    const t = await troca();
    const v = await vale();
    await recusados([
      [() => itemTroca(t, { quantidade: '0.000' }), 'ck_itens_troca_quantidade'],
      [() => itemTroca(t, { valor_total: '-1.00' }), 'ck_itens_troca_valores'],
      [() => itemTroca(t, { destino: 'lixo' }), 'ck_itens_troca_destino'],
      [() => movimentoVale(v, { tipo: 'resgate' }), 'ck_movimentos_vale_tipo'],
      [() => movimentoVale(v, { tipo: 'ajuste', valor: '0.00' }), 'ck_movimentos_vale_valor'],
      [() => movimentoVale(v, { tipo: 'emissao', valor: '-10.00' }), 'ck_movimentos_vale_sinal'],
      [() => movimentoVale(v, { tipo: 'utilizacao', valor: '5.00' }), 'ck_movimentos_vale_sinal'],
    ]);
    const reserva = (extra: Linha = {}) =>
      inserir('reservas_vale', {
        vale_id: v,
        terminal_id: ids.terminal,
        venda_id: uuidv7(),
        pagamento_venda_id: uuidv7(),
        valor: '5.00',
        expira_em: new Date(Date.now() + 600_000),
        ...extra,
      });
    await recusados([
      [() => reserva({ status: 'usada' }), 'ck_reservas_vale_status'],
      [() => reserva({ valor: '0.00' }), 'ck_reservas_vale_valor'],
    ]);
    const requisicao = (extra: Linha = {}) =>
      c.query(
        `insert into requisicoes_terminal (terminal_id, requisicao_id, endpoint, status_http, concluida_em)
         values ($1, $2, $3, $4, $5)`,
        [
          ids.terminal,
          uuidv7(),
          '/sync/consultas/vales/reservar',
          extra.status_http ?? null,
          extra.concluida_em ?? null,
        ],
      );
    await recusados([
      [
        () => requisicao({ status_http: 700, concluida_em: new Date() }),
        'ck_requisicoes_terminal_status_http',
      ],
      [() => requisicao({ status_http: 200 }), 'ck_requisicoes_terminal_concluida'],
    ]);
  });

  it('vale: saldo negativo aceito (corrida offline, D89), código único e versão nova a cada mudança de saldo (desce no F3-B7)', async () => {
    const v = await vale();
    const { rows: inicial } = await c.query<{ versao: string }>('select versao from vales where id = $1', [
      v,
    ]);
    const { rows } = await c.query<{ versao: string; codigo: string }>(
      "update vales set saldo = '-3.50' where id = $1 returning versao, codigo",
      [v],
    );
    // O saldo não é coluna isenta do `fn_versao`: o UPDATE dele gera versão nova (o PDV do F3-B7 recebe o saldo novo).
    // A trava de ordenação da versão fica no versionamento.test.ts (TABELAS_FN_VERSAO_SEM_FLUXO).
    expect(Number(rows[0]!.versao)).toBeGreaterThan(Number(inicial[0]!.versao));
    const e = await erroDe(vale({ codigo: rows[0]!.codigo }));
    expect(e).toMatchObject({ code: '23505', constraint: 'uq_vales_codigo' });
    // Uma baixa por pagamento e tipo (o mesmo `venda.finalizada` reaplicado não baixa duas vezes).
    const pagamentoId = uuidv7();
    await movimentoVale(v, { tipo: 'utilizacao', valor: '-1.00', pagamento_venda_id: pagamentoId });
    const dup = await erroDe(
      movimentoVale(v, { tipo: 'utilizacao', valor: '-1.00', pagamento_venda_id: pagamentoId }),
    );
    expect(dup).toMatchObject({ code: '23505', constraint: 'uq_movimentos_vale_pagamento' });
    await movimentoVale(v, { tipo: 'estorno_utilizacao', valor: '1.00', pagamento_venda_id: pagamentoId });
    // O cancelamento leva −saldo, que com o saldo negativo é positivo.
    await movimentoVale(v, { tipo: 'cancelamento', valor: '3.50' });
    // Uma reserva por pagamento.
    const reserva = {
      vale_id: v,
      terminal_id: ids.terminal,
      venda_id: uuidv7(),
      pagamento_venda_id: pagamentoId,
      valor: '1.00',
      expira_em: new Date(Date.now() + 600_000),
    };
    await inserir('reservas_vale', reserva);
    const r2 = await erroDe(inserir('reservas_vale', { ...reserva, venda_id: uuidv7() }));
    expect(r2).toMatchObject({ code: '23505', constraint: 'uq_reservas_vale_pagamento' });
    // Requisição: chave (terminal, requisição).
    const req = uuidv7();
    const sql = `insert into requisicoes_terminal (terminal_id, requisicao_id, endpoint) values ($1, $2, 'teste')`;
    await c.query(sql, [ids.terminal, req]);
    expect(await erroDe(c.query(sql, [ids.terminal, req]))).toMatchObject({
      code: '23505',
      constraint: 'pk_requisicoes_terminal',
    });
  });

  it('troca: só venda_nova_id (uma vez), status registrada → cancelada e o cancelamento mudam; sem exclusão física', async () => {
    const v = await vale();
    const t = await troca({ vale_id: v, resolucao: 'troca_imediata' });
    const it = await itemTroca(t);
    const m = await movimentoVale(v, { troca_id: t });
    const { rows: c1 } = await c.query<{ codigo: number }>('select codigo from trocas where id = $1', [t]);
    expect(c1[0]!.codigo).toBeGreaterThan(0);
    await expect(c.query("update trocas set motivo = 'Outro' where id = $1", [t])).rejects.toMatchObject(
      IMUTAVEL,
    );
    await expect(c.query("update trocas set valor_total = '1.00' where id = $1", [t])).rejects.toMatchObject(
      IMUTAVEL,
    );
    // O cancelamento sem a troca passar a cancelada também é recusado.
    await expect(
      c.query("update trocas set motivo_cancelamento = 'x' where id = $1", [t]),
    ).rejects.toMatchObject(IMUTAVEL);
    await c.query('update trocas set venda_nova_id = $2 where id = $1', [t, ids.vendaFinalizada]);
    await expect(
      c.query('update trocas set venda_nova_id = $2 where id = $1', [t, ids.vendaCancelada]),
    ).rejects.toMatchObject(IMUTAVEL);
    await expect(c.query('update trocas set venda_nova_id = null where id = $1', [t])).rejects.toMatchObject(
      IMUTAVEL,
    );
    await c.query(
      "update trocas set status = 'cancelada', cancelada_em = now(), motivo_cancelamento = 'Lançada errada' where id = $1",
      [t],
    );
    await expect(c.query("update trocas set status = 'registrada' where id = $1", [t])).rejects.toMatchObject(
      IMUTAVEL,
    );
    await expect(
      c.query("update trocas set motivo_cancelamento = 'Outro' where id = $1", [t]),
    ).rejects.toMatchObject(IMUTAVEL);
    // Item da troca e movimento do vale: nada muda (o UPDATE sem mudança real passa).
    await c.query('update itens_troca set quantidade = quantidade where id = $1', [it]);
    await expect(
      c.query("update itens_troca set destino = 'avaria' where id = $1", [it]),
    ).rejects.toMatchObject(IMUTAVEL);
    await expect(
      c.query("update movimentos_vale set valor = '5.00' where id = $1", [m]),
    ).rejects.toMatchObject(IMUTAVEL);
    for (const [tabela, id] of [
      ['itens_troca', it],
      ['movimentos_vale', m],
      ['trocas', t],
    ] as const) {
      await expect(c.query(`delete from ${tabela} where id = $1`, [id])).rejects.toMatchObject(SEM_EXCLUSAO);
      await expect(c.query(`truncate ${tabela} cascade`)).rejects.toMatchObject(SEM_EXCLUSAO);
    }
  });

  it('item da venda fechada: só quantidade_devolvida muda e não se exclui; no rascunho, tudo livre', async () => {
    const argumentos = await consultar<{ definicao: string }>(
      banco,
      "select pg_get_triggerdef(oid) as definicao from pg_trigger where tgname = 'tg_itens_venda_imutavel'",
    );
    // Os estados abertos do trigger são os de STATUS_VENDA_ABERTOS (como o tg_vendas_imutavel).
    expect(argumentos[0]!.definicao).toContain(`'${STATUS_VENDA_ABERTOS.join(',')}'`);
    for (const itemId of [ids.itemFinalizado, ids.itemCancelado]) {
      const { rows: a } = await c.query<{ versao: string }>('select versao from itens_venda where id = $1', [
        itemId,
      ]);
      const { rows: b } = await c.query<{ versao: string; quantidade_devolvida: string }>(
        "update itens_venda set quantidade_devolvida = '1.000' where id = $1 returning versao, quantidade_devolvida",
        [itemId],
      );
      expect(b[0]!.quantidade_devolvida).toBe('1.000');
      expect(Number(b[0]!.versao)).toBeGreaterThan(Number(a[0]!.versao));
      for (const set of [
        "valor_liquido = '9.00'",
        "custo_unitario = '2.0000'",
        "descricao = 'Outra'",
        'cancelado = true',
      ])
        await expect(c.query(`update itens_venda set ${set} where id = $1`, [itemId])).rejects.toMatchObject(
          IMUTAVEL,
        );
      await expect(c.query('delete from itens_venda where id = $1', [itemId])).rejects.toMatchObject(
        IMUTAVEL,
      );
      // O CHECK de sempre continua valendo para a coluna livre.
      await expect(
        c.query("update itens_venda set quantidade_devolvida = '3.000' where id = $1", [itemId]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'ck_itens_venda_devolvida' });
    }
    // Mover um item do rascunho para a venda finalizada conta a venda de destino.
    await expect(
      c.query('update itens_venda set venda_id = $2, sequencia = 9 where id = $1', [
        ids.itemRascunho,
        ids.vendaFinalizada,
      ]),
    ).rejects.toMatchObject(IMUTAVEL);
    // No rascunho do ERP (F3-B56): alterar, incluir e excluir.
    await c.query("update itens_venda set valor_liquido = '9.00', desconto_item = '1.00' where id = $1", [
      ids.itemRascunho,
    ]);
    const novo = await item(ids.rascunho!, { sequencia: 2 });
    await c.query('delete from itens_venda where id = $1', [novo]);
    // O INSERT fica livre (o handler grava o cabeçalho finalizado antes das linhas).
    await item(ids.vendaFinalizada!, { sequencia: 5 });
  });
});
