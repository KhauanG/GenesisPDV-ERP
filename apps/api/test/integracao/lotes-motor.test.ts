/**
 * Lote no motor de estoque (Fase 2, F2-B6; MD 3.6.9, 3.7.3, 3.7.4; F2-Q7 = D48; README da API › decisão 151), pelo push
 * real e pela API do ERP: a venda do PDV de 10 com os lotes A (vence antes, 6) e B (8) baixa 6 de A e 4 de B, o
 * cancelamento devolve aos mesmos lotes e o pull do fluxo `estoque` traz o `saldos_lote` atualizado; a sobra sem saldo
 * de lote sai sem lote e `estoque.lote_baixa_sem_informar = 'nao_baixar'` não mexe no saldo por lote; a Saída do acerto
 * sem lote em FEFO, o estorno nos mesmos lotes e o "Definir" sem lote (a diferença negativa em FEFO, a positiva sem
 * lote); o lote de outro estoque ou de outro produto recusado (acerto 422, motor `ErroLoteInvalido`, banco
 * `LOTE_INVALIDO`) e, do PDV, a venda aplicada sem ele; o filtro do pull (`produtos_lotes` e `saldos_lote` só da loja e
 * do tipo vendável); o acerto com o mesmo produto com e sem lote (o lote informado sai antes da divisão); a recusa do
 * saldo do lote na Saída e no estorno sem a permissão de saldo negativo; a compensação do "Definir" com lote e o estorno
 * dela; o custo do item como soma das partes; a entrada de compra (RECEB_*) preenche a última compra; acerto de saída e
 * venda concorrentes no mesmo produto com lote, 20 vezes, sem deadlock (sob a 7300001; a ordem das travas de linha é
 * dos testes unitários de `movimentos.spec.ts`); e o `db:recalcular-saldos` acusa e refaz `saldos_lote` e a última
 * compra. A divisão FEFO é conferida pelas quantidades esperadas e pelo `conferirFefo`, e o razão refaz as duas
 * projeções idênticas (`conferirRazaoDoBanco`). Cada teste usa produtos e caixas próprios.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONTRATOS_EVENTOS,
  dec,
  jcs,
  respostaPullSchema,
  respostaPushSchema,
  type Ativar,
} from '@genesis/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErroLoteInvalido, lancarDocumento, type NovoMovimento } from '../../src/estoques/movimentos.js';
import { corrigirDivergencias, projecaoIdentica, verificarSaldos } from '../../src/estoques/recalcular.js';
import type { DbEmpresa } from '../../src/tenancy/tenancy.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';
import { conferirRazaoDoBanco } from './razao.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let estoqueLoja: string;
let tipoPadrao: string;
let tokenAdmin: string;
/** Estoquista: acerta e estorna, sem `estoque.permite_negativo_erp` nem Master (a regra do saldo negativo vale). */
let tokenEstoquista: string;
let operador: string;
let dinheiro: string;
let un: string;
/** Conexão da role dona com o banco da empresa (o motor direto e o `db:recalcular-saldos`). */
let dona: pg.Client;

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const agora = () => new Date().toISOString();
const minutosAtras = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function cabecalhos(tk?: string) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

/** Um caixa com o terminal ativado pelo `/sync/ativar` real e a sessão aberta (como em `definir-offline`). */
interface Ponto {
  caixa: string;
  numero: number;
  terminal: string;
  token: string;
  seq: number;
  venda: number;
  sessao: string;
}

let numeroCaixa = 0;

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

async function novoPonto(): Promise<Ponto> {
  const numero = ++numeroCaixa;
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: loja, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const p: Ponto = {
    caixa,
    numero,
    terminal: r.body.terminal_id,
    token: r.body.token,
    seq: 0,
    venda: 0,
    sessao: uuidv7(),
  };
  const [aberto] = await pushOk(p, [
    evento(p, 'caixa.aberto', {
      sessoes_caixa: {
        id: p.sessao,
        ...linhaDoPonto(p),
        operador_id: operador,
        status: 'aberta',
        dia_operacional: '2026-11-04',
        aberta_em: minutosAtras(300),
        fundo_troco: '0.00',
      },
      movimentos_caixa: [],
    }),
  ]);
  expect(aberto, JSON.stringify(aberto)).toMatchObject({ status: 'aplicado' });
  return p;
}

function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload) {
  const contrato = CONTRATOS_EVENTOS[tipo];
  return {
    evento_id: uuidv7(),
    sequencia: ++p.seq,
    tipo,
    versao_schema: 1,
    agregado_tipo: contrato.agregadoTipo,
    agregado_id: (contrato.agregadoId as (x: unknown) => string)(payload),
    dependencias:
      tipo === 'venda.finalizada' ? [{ agregado_tipo: 'sessao_caixa', agregado_id: p.sessao }] : [],
    ocorrido_em: agora(),
    relogio_confiavel: true,
    usuario_id: operador,
    contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

type Resultado = { status: string; erro?: { codigo: string }; resultado?: Record<string, unknown> };

async function pushOk(p: Ponto, eventos: unknown[]): Promise<Resultado[]> {
  const r = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: uuidv7(), terminal_id: p.terminal, enviado_em: agora(), eventos });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Resultado[];
}

async function aplicar(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload) {
  const [r] = await pushOk(p, [evento(p, tipo, payload)]);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
}

type Item = [produto: string, quantidade: string, loteId?: string];

/** Uma venda finalizada (PDV-1: sem lote, salvo o `lote_id` pedido), paga em dinheiro. */
function venda(p: Ponto, itens: Item[], finalizadaEm = minutosAtras(1)) {
  const id = uuidv7();
  const numero = ++p.venda;
  const total = itens.reduce((s, [, q]) => s + 5 * Number(q), 0).toFixed(2);
  return {
    vendas: {
      id,
      numero,
      numero_exibicao: `L01-C${String(p.numero).padStart(2, '0')}-${String(numero).padStart(6, '0')}`,
      ...linhaDoPonto(p),
      sessao_caixa_id: p.sessao,
      tipo: 'pdv',
      status: 'finalizada',
      dia_operacional: '2026-11-04',
      operador_id: operador,
      cliente_id: null,
      subtotal_bruto: total,
      total,
      iniciada_em: finalizadaEm,
      finalizada_em: finalizadaEm,
    },
    itens_venda: itens.map(([produto, quantidade, loteId], i) => ({
      id: uuidv7(),
      venda_id: id,
      sequencia: i + 1,
      produto_id: produto,
      descricao: 'ITEM DE TESTE',
      unidade: 'UN',
      quantidade,
      preco_tabela: '5.0000',
      preco_unitario: '5.0000',
      valor_bruto: (5 * Number(quantidade)).toFixed(2),
      valor_liquido: (5 * Number(quantidade)).toFixed(2),
      incluido_em: finalizadaEm,
      componentes_estoque: [],
      ...(loteId ? { lote_id: loteId } : {}),
    })),
    pagamentos_venda: [
      {
        id: uuidv7(),
        venda_id: id,
        sequencia: 1,
        forma_pagamento_id: dinheiro,
        descricao_forma: 'Dinheiro',
        meio_pagamento_fiscal: '01',
        tipo_forma: 'dinheiro',
        valor: total,
        lanca_quitada: true,
      },
    ],
    vasilhames: [],
  };
}

/** O cancelamento da venda na sessão aberta (forma A), devolvendo o dinheiro. */
function cancelamento(p: Ponto, v: ReturnType<typeof venda>) {
  const canceladaEm = agora();
  return {
    vendas: {
      id: v.vendas.id,
      status: 'cancelada',
      cancelada_em: canceladaEm,
      cancelada_por_id: operador,
      cancelamento_autorizado_por_id: operador,
      motivo_cancelamento: 'Cliente desistiu da compra',
      cancelamento_origem: 'pdv',
    },
    sessao_caixa_cancelamento_id: p.sessao,
    pagamentos_venda: v.pagamentos_venda.map((pg) => ({
      id: pg.id,
      status: 'estornado',
      estorno: 'dinheiro_devolvido',
    })),
    movimentos_caixa: [
      {
        id: uuidv7(),
        sessao_caixa_id: p.sessao,
        ...linhaDoPonto(p),
        tipo: 'estorno_venda',
        forma_pagamento_id: dinheiro,
        valor: v.vendas.total,
        operador_id: operador,
        quem_retira_usuario_id: null,
        quem_retira_nome: null,
        observacao: `Estorno da venda ${v.vendas.numero_exibicao}`,
        inf_adicionais: null,
        ocorrido_em: canceladaEm,
        autorizado_por_id: operador,
        troca_id: null,
      },
    ],
    transacoes_tef: [],
  };
}

async function criarProduto(nome: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '5', precoCusto: '2' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** Lote do produto (a tela de lotes é do F2-B17); `estoque` nulo = lote de qualquer estoque. */
async function criarLote(
  produto: string,
  lote: string,
  validade: string | null,
  estoque: string | null = estoqueLoja,
) {
  const [{ id }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into produtos_lotes (produto_id, estoque_id, lote, validade) values ($1, $2, $3, $4) returning id',
    [produto, estoque, lote, validade],
  )) as [{ id: string }];
  return id;
}

type ItemAcerto = { produtoId: string; quantidade: string; loteId?: string; custoUnitario?: string };

async function tentarAcerto(
  tipoAjuste: 'entrada' | 'saida' | 'definir',
  itens: ItemAcerto[],
  dataContagem = agora(),
  token = tokenAdmin,
) {
  return amb
    .http()
    .post('/api/acertos')
    .set(bearer(token))
    .send({ estoqueId: estoqueLoja, tipoAjuste, dataContagem, motivo: 'Inventário', itens });
}

/** Cria e tenta efetivar um acerto (o criado tem de dar 201); devolve o id e a resposta da efetivação. */
async function tentarEfetivar(
  tipoAjuste: 'entrada' | 'saida' | 'definir',
  itens: ItemAcerto[],
  dataContagem?: string,
  token = tokenAdmin,
) {
  const a = await tentarAcerto(tipoAjuste, itens, dataContagem, token);
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const r = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer(token))
    .send({ versao: a.body.versao });
  return { id: a.body.id as string, r };
}

/** Cria e efetiva um acerto; devolve o id. */
async function acerto(
  tipoAjuste: 'entrada' | 'saida' | 'definir',
  itens: ItemAcerto[],
  dataContagem?: string,
  token = tokenAdmin,
) {
  const { id, r } = await tentarEfetivar(tipoAjuste, itens, dataContagem, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return id;
}

async function tentarEstorno(id: string, token = tokenAdmin) {
  const atual = await amb.http().get(`/api/acertos/${id}`).set(bearer(token));
  return amb
    .http()
    .post(`/api/acertos/${id}/estornar`)
    .set(bearer(token))
    .send({ versao: atual.body.versao, motivo: 'Lançado errado' });
}

async function estornarAcerto(id: string, token = tokenAdmin) {
  const r = await tentarEstorno(id, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Entrada dos lotes informados (custo 2). */
const entradaLotes = (produto: string, lotes: Array<[loteId: string, quantidade: string]>) =>
  acerto(
    'entrada',
    lotes.map(([loteId, quantidade]) => ({ produtoId: produto, loteId, quantidade, custoUnitario: '2' })),
  );

async function saldo(produto: string): Promise<string> {
  const [s] = await consultar<{ quantidade: string }>(
    emp.nomeBanco,
    `select quantidade::text from saldos_estoque where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoqueLoja, produto, tipoPadrao],
  );
  return s?.quantidade ?? '0.000';
}

/** Saldo por lote da linha do produto (`lote_id` → quantidade). */
async function lotes(produto: string): Promise<Record<string, string>> {
  const linhas = await consultar<{ lote_id: string; quantidade: string }>(
    emp.nomeBanco,
    `select lote_id, quantidade::text from saldos_lote
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3 order by lote_id`,
    [estoqueLoja, produto, tipoPadrao],
  );
  return Object.fromEntries(linhas.map((l) => [l.lote_id, l.quantidade]));
}

/** Os movimentos do documento (`lote_id`, tipo, quantidade), na ordem de lançamento. */
const movimentosDoDocumento = (documentoId: string, produto: string) =>
  consultar<{
    tipo_movimento: string;
    lote_id: string | null;
    quantidade: string;
    estorno_de_id: string | null;
  }>(
    emp.nomeBanco,
    `select tipo_movimento, lote_id, quantidade::text, estorno_de_id from movimentos_estoque
      where documento_id = $1 and produto_id = $2 order by seq_lancamento`,
    [documentoId, produto],
  );

/**
 * A divisão FEFO de fato aconteceu na linha do produto (o critério de pronto do F2-B6 com `fefo`, o padrão): refazendo
 * o saldo de cada lote pelo razão, nenhuma saída sem lote (fora estorno e compensação, que herdam o lote do fato) foi
 * lançada com lote de saldo positivo, contando as linhas com lote do mesmo documento (o lote informado é reservado
 * antes da divisão). A identidade Σ `saldos_lote` + a parte sem lote = `saldos_estoque` não serve para isso: ela vale
 * em qualquer modo, inclusive `nao_baixar` e sem divisão nenhuma, sempre que as projeções batem com o razão
 * (`recalcularIdentico`).
 */
async function conferirFefo(produto: string) {
  const movs = await consultar<{
    documento_id: string | null;
    lote_id: string | null;
    quantidade: string;
    manual: boolean;
  }>(
    emp.nomeBanco,
    `select documento_id, lote_id, quantidade::text,
            (estorno_de_id is not null or compensa_movimento_id is not null) as manual
       from movimentos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3 order by seq_lancamento`,
    [estoqueLoja, produto, tipoPadrao],
  );
  const saldoLote = new Map<string, ReturnType<typeof dec>>();
  movs.forEach((m, i) => {
    if (!m.lote_id && !m.manual && dec(m.quantidade).lt(0)) {
      // O lote como estaria com as linhas com lote do mesmo documento já aplicadas (as anteriores já estão).
      const vista = new Map(saldoLote);
      for (const o of movs.slice(i + 1))
        if (o.documento_id === m.documento_id && o.lote_id)
          vista.set(o.lote_id, (vista.get(o.lote_id) ?? dec(0)).plus(o.quantidade));
      const comSaldo = [...vista].filter(([, q]) => q.gt(0)).map(([l]) => l);
      expect(comSaldo, `saída sem lote ${m.quantidade} com lote de saldo positivo`).toEqual([]);
    }
    if (m.lote_id) saldoLote.set(m.lote_id, (saldoLote.get(m.lote_id) ?? dec(0)).plus(m.quantidade));
  });
}

/** Páginas do fluxo do terminal desde `desde`. */
async function puxar(p: Ponto, fluxo: 'estoque' | 'catalogo', desde: number) {
  const alteracoes: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
  let cursor = desde;
  for (let i = 0; i < 50; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=${fluxo}&desde=${cursor}&limite=2000`)
      .set(cabecalhos(p.token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...(r.body.alteracoes as typeof alteracoes));
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { alteracoes, cursor };
  }
  throw new Error('pull não terminou');
}

const puxarEstoque = (p: Ponto, desde: number) => puxar(p, 'estoque', desde);

/** O motor direto, numa transação da role dona com a 7300001 (como `seq-lancamento`). */
async function lancarDireto(linhas: NovoMovimento[]) {
  await dona.query('begin');
  try {
    await dona.query('select fn_trava_versao()');
    const r = await lancarDocumento(drizzle(dona) as unknown as DbEmpresa, linhas);
    await dona.query('commit');
    return r;
  } catch (e) {
    await dona.query('rollback');
    throw e;
  }
}

const movimento = (produto: string, extra: Partial<NovoMovimento>): NovoMovimento => ({
  estoqueId: estoqueLoja,
  produtoId: produto,
  variacaoId: null,
  tipoEstoqueId: tipoPadrao,
  tipoMovimento: 'ACERTO_ENTRADA',
  quantidade: '1',
  custoUnitario: '2',
  custoReferencia: '2',
  precoVenda: null,
  dataMovimento: new Date(),
  lojaId: loja,
  usuarioId: operador,
  documentoTipo: 'acerto',
  documentoId: uuidv7(),
  documentoItemId: uuidv7(),
  ...extra,
});

const recalcularIdentico = () => conferirRazaoDoBanco(emp.nomeBanco);

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista', lojas: [loja] });
  tokenEstoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  [{ estoque_id: estoqueLoja }] = (await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [loja],
  )) as [{ estoque_id: string }];
  [{ id: tipoPadrao }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'select id from tipos_estoque where padrao',
  )) as [{ id: string }];
  [{ id: operador }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  [{ id: dinheiro }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null order by ordem limit 1",
  )) as [{ id: string }];
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  dona = await conectar(emp.nomeBanco);
}, 120_000);

afterAll(async () => {
  await dona?.end();
  await amb?.fechar();
});

describe('saldos_lote mantido pelo motor (F2-B6; MD 3.7.4; F2-Q7)', () => {
  it('venda do PDV de 10 com A (vence antes, 6) e B (8) baixa 6 de A e 4 de B; cancelar devolve aos mesmos lotes; o pull traz o saldo por lote', async () => {
    const prod = await criarProduto('CERV LOTE FEFO');
    // B sem estoque (vale em qualquer estoque) e com validade depois da de A.
    const a = await criarLote(prod, 'A-2612', '2026-12-01');
    const b = await criarLote(prod, 'B-2701', '2027-01-10', null);
    await entradaLotes(prod, [
      [b, '8'],
      [a, '6'],
    ]);
    expect(await lotes(prod)).toEqual({ [a]: '6.000', [b]: '8.000' });
    const p = await novoPonto();
    const carga = await puxarEstoque(p, 0);
    const doProduto = (alt: typeof carga.alteracoes) =>
      Object.fromEntries(
        alt
          .filter((x) => x.tabela === 'saldos_lote' && x.linha.produto_id === prod)
          .map((x) => [x.linha.lote_id as string, Number(x.linha.quantidade)]),
      );
    expect(doProduto(carga.alteracoes)).toEqual({ [a]: 6, [b]: 8 });

    const v = venda(p, [[prod, '10.000']]);
    await aplicar(p, 'venda.finalizada', v);
    expect(await movimentosDoDocumento(v.vendas.id, prod)).toEqual([
      { tipo_movimento: 'VENDA_PDV', lote_id: a, quantidade: '-6.000', estorno_de_id: null },
      { tipo_movimento: 'VENDA_PDV', lote_id: b, quantidade: '-4.000', estorno_de_id: null },
    ]);
    expect(await saldo(prod)).toBe('4.000');
    expect(await lotes(prod)).toEqual({ [a]: '0.000', [b]: '4.000' });
    // O custo do item é o custo médio da linha nas duas partes (10 × 2,00).
    const [item] = await consultar<{ custo_unitario: string }>(
      emp.nomeBanco,
      'select custo_unitario::text from itens_venda where venda_id = $1',
      [v.vendas.id],
    );
    expect(item!.custo_unitario).toBe('2.0000');
    const depoisDaVenda = await puxarEstoque(p, carga.cursor);
    expect(doProduto(depoisDaVenda.alteracoes)).toEqual({ [a]: 0, [b]: 4 });
    await conferirFefo(prod);

    await aplicar(p, 'venda.cancelada', cancelamento(p, v));
    const movs = await movimentosDoDocumento(v.vendas.id, prod);
    expect(
      movs.filter((m) => m.tipo_movimento === 'CANC_VENDA_PDV').map((m) => [m.lote_id, m.quantidade]),
    ).toEqual([
      [a, '6.000'],
      [b, '4.000'],
    ]);
    expect(await lotes(prod)).toEqual({ [a]: '6.000', [b]: '8.000' });
    expect(doProduto((await puxarEstoque(p, depoisDaVenda.cursor)).alteracoes)).toEqual({ [a]: 6, [b]: 8 });
    await conferirFefo(prod);
    await recalcularIdentico();
  });

  it('a sobra sem saldo de lote sai sem lote; com "nao_baixar" a saída sem lote não mexe no saldo por lote', async () => {
    const prod = await criarProduto('CERV LOTE SOBRA');
    const a = await criarLote(prod, 'S-01', '2026-12-20');
    await entradaLotes(prod, [[a, '3']]);
    const p = await novoPonto();
    const v = venda(p, [[prod, '5.000']]);
    await aplicar(p, 'venda.finalizada', v);
    expect((await movimentosDoDocumento(v.vendas.id, prod)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [a, '-3.000'],
      [null, '-2.000'],
    ]);
    expect([await saldo(prod), await lotes(prod)]).toEqual(['-2.000', { [a]: '0.000' }]);
    await conferirFefo(prod);

    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'estoque.lote_baixa_sem_informar', '"nao_baixar"')`,
    );
    try {
      await entradaLotes(prod, [[a, '4']]);
      const w = venda(p, [[prod, '1.000']]);
      await aplicar(p, 'venda.finalizada', w);
      expect((await movimentosDoDocumento(w.vendas.id, prod)).map((m) => [m.lote_id, m.quantidade])).toEqual([
        [null, '-1.000'],
      ]);
      expect([await saldo(prod), await lotes(prod)]).toEqual(['1.000', { [a]: '4.000' }]);
      // A conferência da divisão separa os modos: com `nao_baixar` a venda saiu sem lote com o lote em 4.
      await expect(conferirFefo(prod)).rejects.toThrow(/saída sem lote -1.000 com lote de saldo positivo/);
    } finally {
      await consultar(
        emp.nomeBanco,
        "update configuracoes set excluido_em = now() where chave = 'estoque.lote_baixa_sem_informar'",
      );
    }
    await recalcularIdentico();
  });

  it('Saída do acerto sem lote em FEFO e o estorno nos mesmos lotes; "Definir" sem lote: a diferença negativa em FEFO, a positiva sem lote', async () => {
    const prod = await criarProduto('CERV LOTE ACERTO');
    const a = await criarLote(prod, 'AC-1', '2026-11-30');
    const b = await criarLote(prod, 'AC-2', null);
    await entradaLotes(prod, [
      [a, '5'],
      [b, '5'],
    ]);
    const saida = await acerto('saida', [{ produtoId: prod, quantidade: '7' }]);
    expect((await movimentosDoDocumento(saida, prod)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [a, '-5.000'],
      [b, '-2.000'],
    ]);
    const detalhe = await amb.http().get(`/api/acertos/${saida}`).set(bearer());
    expect(detalhe.body.itens[0]).toMatchObject({
      diferenca: '-7.000',
      loteId: null,
      custoUnitario: '2.0000',
    });
    await estornarAcerto(saida);
    expect(await lotes(prod)).toEqual({ [a]: '5.000', [b]: '5.000' });

    // Saída com o lote informado: só dele, e o saldo do lote é conferido (o Master pode deixar negativo).
    const doLote = await acerto('saida', [{ produtoId: prod, loteId: b, quantidade: '1' }]);
    expect((await movimentosDoDocumento(doLote, prod)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [b, '-1.000'],
    ]);
    expect((await amb.http().get(`/api/acertos/${doLote}`).set(bearer())).body.itens[0]).toMatchObject({
      loteId: b,
      lote: 'AC-2',
    });

    // Contados 6 (o saldo é 9): −3 em FEFO, de A.
    const menos = await acerto('definir', [{ produtoId: prod, quantidade: '6' }], agora());
    expect((await movimentosDoDocumento(menos, prod)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [a, '-3.000'],
    ]);
    // Contados 10: +4 sem lote.
    const mais = await acerto('definir', [{ produtoId: prod, quantidade: '10' }], agora());
    expect((await movimentosDoDocumento(mais, prod)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [null, '4.000'],
    ]);
    expect([await saldo(prod), await lotes(prod)]).toEqual(['10.000', { [a]: '2.000', [b]: '4.000' }]);
    await conferirFefo(prod);
    await recalcularIdentico();
  });

  it('lote de outro estoque ou de outro produto é recusado (acerto 422, motor e banco); do PDV, a venda vale sem ele; o pull leva só os lotes e os saldos de lote da loja', async () => {
    const prod = await criarProduto('CERV LOTE ERRADO');
    const outro = await criarProduto('CERV LOTE OUTRO PRODUTO');
    const [{ id: cd }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo) values ('CD - Lotes', 'deposito') returning id",
    )) as [{ id: string }];
    const doCd = await criarLote(prod, 'CD-1', '2026-12-01', cd);
    const doOutro = await criarLote(outro, 'OP-1', '2026-12-01');
    for (const [loteId, mensagem] of [
      [doCd, 'O lote é de outro estoque'],
      [doOutro, 'O lote não é deste produto'],
    ] as const) {
      const r = await tentarAcerto('entrada', [
        { produtoId: prod, loteId, quantidade: '1', custoUnitario: '2' },
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.campos).toEqual({ 'itens.0.loteId': [mensagem] });
    }
    // O Definir conta o produto inteiro: o contrato recusa o lote.
    const definir = await tentarAcerto('definir', [{ produtoId: prod, loteId: doCd, quantidade: '1' }]);
    expect(definir.status).toBe(422);
    expect(definir.body.campos).toHaveProperty(['itens.0.loteId']);

    await expect(lancarDireto([movimento(prod, { loteId: doCd })])).rejects.toBeInstanceOf(ErroLoteInvalido);
    // A segunda barreira: o INSERT direto com o lote de outro estoque.
    await expect(
      consultar(
        emp.nomeBanco,
        `insert into movimentos_estoque (estoque_id, tipo_estoque_id, produto_id, lote_id, tipo_movimento, quantidade,
           saldo_anterior, saldo_posterior, custo_unitario, custo_total, custo_medio_posterior, data_movimento,
           documento_tipo)
         values ($1, $2, $3, $4, 'ACERTO_ENTRADA', 1, 0, 1, 2, 2, 2, now(), 'acerto')`,
        [estoqueLoja, tipoPadrao, prod, doOutro],
      ),
    ).rejects.toMatchObject({ message: 'LOTE_INVALIDO' });
    // O produto e a variação do lote não mudam (só o estoque já era imutável, filtro do pull).
    await expect(
      consultar(emp.nomeBanco, 'update produtos_lotes set produto_id = $2 where id = $1', [doOutro, prod]),
    ).rejects.toMatchObject({ message: 'FILTRO_IMUTAVEL' });

    // Do caixa a nuvem não recusa a venda: o lote errado fica de fora, e a saída segue sem ele.
    const p = await novoPonto();
    const v = venda(p, [[prod, '1.000', doCd]]);
    await aplicar(p, 'venda.finalizada', v);
    expect((await movimentosDoDocumento(v.vendas.id, prod)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [null, '-1.000'],
    ]);

    // O filtro do pull (MD 6.2): `produtos_lotes` do estoque da loja ou sem estoque, nunca o do CD; `saldos_lote` só
    // do estoque da loja e de tipo vendável (o saldo do CD e o da avaria ficam na nuvem).
    const daLoja = await criarLote(prod, 'LJ-1', '2026-12-10');
    const geral = await criarLote(prod, 'G-1', '2027-03-01', null);
    const [{ id: avaria }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from tipos_estoque where chave_sistema = 'avaria'",
    )) as [{ id: string }];
    await lancarDireto([
      movimento(prod, { loteId: daLoja, quantidade: '3' }),
      movimento(prod, { loteId: geral, quantidade: '2', tipoEstoqueId: avaria }),
      movimento(prod, { loteId: doCd, quantidade: '4', estoqueId: cd, lojaId: null }),
    ]);
    const lotesDoCatalogo = (await puxar(p, 'catalogo', 0)).alteracoes
      .filter((x) => x.tabela === 'produtos_lotes' && x.linha.produto_id === prod)
      .map((x) => x.linha.id as string);
    expect(lotesDoCatalogo.sort()).toEqual([daLoja, geral].sort());
    const saldosDoPull = (await puxarEstoque(p, 0)).alteracoes
      .filter((x) => x.tabela === 'saldos_lote' && x.linha.produto_id === prod)
      .map((x) => [x.linha.lote_id, x.linha.estoque_id, x.linha.tipo_estoque_id, Number(x.linha.quantidade)]);
    expect(saldosDoPull).toEqual([[daLoja, estoqueLoja, tipoPadrao, 3]]);
    await recalcularIdentico();
  });

  it('acerto com o mesmo produto com e sem lote: o lote informado sai antes da divisão FEFO da Saída sem lote', async () => {
    const prod = await criarProduto('CERV LOTE MISTO');
    const a = await criarLote(prod, 'M-A', '2026-12-01');
    const b = await criarLote(prod, 'M-B', '2027-01-10');
    await entradaLotes(prod, [
      [a, '6'],
      [b, '8'],
    ]);
    // X (sem lote, 8) vem antes de Y (lote A, 6) na sequência. Em FEFO, X tirava 6 de A e 2 de B, e Y era recusado
    // ("Saldo insuficiente do lote") com B ainda com 6; o Master deixava A em −6 e B em 6. O estoquista não tem a
    // permissão de saldo negativo, e o acerto passa.
    const misto = await acerto(
      'saida',
      [
        { produtoId: prod, quantidade: '8' },
        { produtoId: prod, loteId: a, quantidade: '6' },
      ],
      undefined,
      tokenEstoquista,
    );
    expect((await movimentosDoDocumento(misto, prod)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [a, '-6.000'],
      [b, '-8.000'],
    ]);
    expect([await saldo(prod), await lotes(prod)]).toEqual(['0.000', { [a]: '0.000', [b]: '0.000' }]);
    await conferirFefo(prod);
    await recalcularIdentico();
  });

  it('sem a permissão de saldo negativo, a Saída do lote confere o saldo dele; lote inexistente é recusado', async () => {
    const prod = await criarProduto('CERV LOTE SEM PERMISSAO');
    const a = await criarLote(prod, 'P-A', '2026-12-01');
    const b = await criarLote(prod, 'P-B', '2027-01-10');
    await entradaLotes(prod, [
      [a, '1'],
      [b, '5'],
    ]);
    // O total (6) cobre a Saída de 2: quem recusa é a conferência do lote A, que tem 1.
    const { r } = await tentarEfetivar(
      'saida',
      [{ produtoId: prod, loteId: a, quantidade: '2' }],
      undefined,
      tokenEstoquista,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.campos).toEqual({
      'itens.0.quantidade': ['Saldo insuficiente do lote de CERV LOTE SEM PERMISSAO: 1 UN'],
    });
    expect(await lotes(prod)).toEqual({ [a]: '1.000', [b]: '5.000' });
    // O Master pode deixar o lote negativo (a mesma regra do saldo negativo).
    await acerto('saida', [{ produtoId: prod, loteId: a, quantidade: '2' }]);
    expect(await lotes(prod)).toEqual({ [a]: '-1.000', [b]: '5.000' });

    const inexistente = await tentarAcerto('saida', [{ produtoId: prod, loteId: uuidv7(), quantidade: '1' }]);
    expect(inexistente.status, JSON.stringify(inexistente.body)).toBe(422);
    expect(inexistente.body.campos).toEqual({ 'itens.0.loteId': ['Lote não encontrado'] });
    await recalcularIdentico();
  });

  it('o estorno confere o saldo do lote: sem a permissão, não deixa o lote negativo com o total da linha intacto', async () => {
    const prod = await criarProduto('CERV LOTE ESTORNO');
    const a = await criarLote(prod, 'E-A', '2026-12-01');
    const comLote = await entradaLotes(prod, [[a, '5']]);
    await acerto('entrada', [{ produtoId: prod, quantidade: '5', custoUnitario: '2' }]);
    const p = await novoPonto();
    await aplicar(p, 'venda.finalizada', venda(p, [[prod, '5.000']]));
    expect([await saldo(prod), await lotes(prod)]).toEqual(['5.000', { [a]: '0.000' }]);
    // O total da linha fica em 0 (10 − 5 − 5); o lote A ficaria em −5 e a parte sem lote em +5.
    const negado = await tentarEstorno(comLote, tokenEstoquista);
    expect(negado.status, JSON.stringify(negado.body)).toBe(422);
    expect(negado.body.mensagem).toBe(
      'O estorno deixaria saldo negativo no lote: CERV LOTE ESTORNO (lote E-A: 0 UN). Só com a permissão de saldo negativo (Master ou "Permite saldo negativo no ERP").',
    );
    expect([await saldo(prod), await lotes(prod)]).toEqual(['5.000', { [a]: '0.000' }]);
    await estornarAcerto(comLote);
    expect([await saldo(prod), await lotes(prod)]).toEqual(['0.000', { [a]: '-5.000' }]);
    await recalcularIdentico();
  });

  it('a compensação do "Definir" herda o lote do fato, e o estorno devolve aos mesmos lotes', async () => {
    const prod = await criarProduto('CERV LOTE COMPENSACAO');
    const a = await criarLote(prod, 'C-A', '2026-12-01');
    const b = await criarLote(prod, 'C-B', '2027-01-10');
    await entradaLotes(prod, [
      [a, '5'],
      [b, '5'],
    ]);
    const p = await novoPonto();
    // Contados 10 daqui a 1 min (a folga do contrato; diferença 0); a venda de 7 de há 10 min chega depois: sai em FEFO
    // (5 de A, 2 de B) e é compensada contra o "Definir" nos mesmos lotes.
    const daqui = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
    const definir = await acerto('definir', [{ produtoId: prod, quantidade: '10' }], daqui(1));
    await aplicar(p, 'venda.finalizada', venda(p, [[prod, '7.000']], minutosAtras(10)));
    const porLote = (movs: Awaited<ReturnType<typeof movimentosDoDocumento>>) =>
      Object.fromEntries(movs.map((m) => [m.lote_id, [m.tipo_movimento, m.quantidade]]));
    const doDefinir = await movimentosDoDocumento(definir, prod);
    expect(porLote(doDefinir)).toEqual({
      [a]: ['ACERTO_COMPENSACAO', '5.000'],
      [b]: ['ACERTO_COMPENSACAO', '2.000'],
    });
    expect([await saldo(prod), await lotes(prod)]).toEqual(['10.000', { [a]: '5.000', [b]: '5.000' }]);
    // Estornado o "Definir", a venda passa a valer: as compensações saem dos mesmos lotes.
    await estornarAcerto(definir);
    expect(porLote((await movimentosDoDocumento(definir, prod)).filter((m) => m.estorno_de_id))).toEqual({
      [a]: ['ESTORNO_ACERTO', '-5.000'],
      [b]: ['ESTORNO_ACERTO', '-2.000'],
    });
    expect([await saldo(prod), await lotes(prod)]).toEqual(['3.000', { [a]: '0.000', [b]: '3.000' }]);

    // As compensações que outro "Definir" lançou contra este (`compensacoesDoDocumento`): D2 conta 10 daqui a 3 min,
    // D1 conta 7 daqui a 2 min (−3 em FEFO, de A) e é anulado por D2 (+3 em A). Estornar D1 estorna as duas no lote A.
    const outro = await criarProduto('CERV LOTE COMPENSACAO D1');
    const c = await criarLote(outro, 'D-A', '2026-12-01');
    const d = await criarLote(outro, 'D-B', '2027-01-10');
    await entradaLotes(outro, [
      [c, '5'],
      [d, '5'],
    ]);
    const d2 = await acerto('definir', [{ produtoId: outro, quantidade: '10' }], daqui(3));
    const d1 = await acerto('definir', [{ produtoId: outro, quantidade: '7' }], daqui(2));
    expect((await movimentosDoDocumento(d1, outro)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [c, '-3.000'],
    ]);
    expect((await movimentosDoDocumento(d2, outro)).map((m) => [m.lote_id, m.quantidade])).toEqual([
      [c, '3.000'],
    ]);
    await estornarAcerto(d1);
    const estornos = await consultar<{ lote_id: string | null; quantidade: string }>(
      emp.nomeBanco,
      `select lote_id, quantidade::text from movimentos_estoque
        where documento_id = $1 and estorno_de_id is not null order by quantidade`,
      [d1],
    );
    expect(estornos).toEqual([
      { lote_id: c, quantidade: '-3.000' },
      { lote_id: c, quantidade: '3.000' },
    ]);
    expect([await saldo(outro), await lotes(outro)]).toEqual(['10.000', { [c]: '5.000', [d]: '5.000' }]);
    await recalcularIdentico();
  });

  it('o custo do item do acerto é a soma do custo das partes da divisão FEFO (o mesmo do razão)', async () => {
    const prod = await criarProduto('CERV LOTE CUSTO');
    const ls = [
      await criarLote(prod, 'K-1', '2026-12-01'),
      await criarLote(prod, 'K-2', '2026-12-02'),
      await criarLote(prod, 'K-3', '2026-12-03'),
    ];
    await acerto(
      'entrada',
      ls.map((loteId) => ({ produtoId: prod, loteId, quantidade: '1', custoUnitario: '0.3333' })),
    );
    const saida = await acerto('saida', [{ produtoId: prod, quantidade: '3' }]);
    const movs = await consultar<{ lote_id: string; custo_total: string }>(
      emp.nomeBanco,
      'select lote_id, custo_total::text from movimentos_estoque where documento_id = $1 order by seq_lancamento',
      [saida],
    );
    // Cada parte: 1 × 0,3333 = 0,33. Pela quantidade inteira o item dava 1,00 e o CMV do razão, 0,99.
    expect(movs).toEqual(ls.map((lote_id) => ({ lote_id, custo_total: '0.33' })));
    const detalhe = (await amb.http().get(`/api/acertos/${saida}`).set(bearer())).body;
    expect([detalhe.itens[0].totalCusto, detalhe.totalCusto]).toEqual(['0.99', '0.99']);
    await recalcularIdentico();
  });

  it('a entrada de compra (RECEB_*) preenche a última compra; o acerto e o estorno não a mudam', async () => {
    const prod = await criarProduto('CERV ULTIMA COMPRA');
    const ultima = async () =>
      (
        await consultar<{ em: Date | null; custo: string | null }>(
          emp.nomeBanco,
          `select ultima_compra_em as em, ultimo_custo_compra::text as custo from saldos_estoque
            where estoque_id = $1 and produto_id = $2`,
          [estoqueLoja, prod],
        )
      )[0];
    await acerto('entrada', [{ produtoId: prod, quantidade: '5', custoUnitario: '1.5' }]);
    expect(await ultima()).toEqual({ em: null, custo: null });
    const manual = await lancarDireto([
      movimento(prod, {
        tipoMovimento: 'RECEB_MANUAL',
        documentoTipo: 'recebimento',
        quantidade: '12',
        custoUnitario: '3.5',
      }),
    ]);
    const nfe = movimento(prod, {
      tipoMovimento: 'RECEB_NFE',
      documentoTipo: 'nota_entrada',
      quantidade: '6',
      custoUnitario: '4.25',
    });
    await lancarDireto([nfe]);
    expect(await ultima()).toEqual({ em: nfe.dataMovimento, custo: '4.2500' });
    // O estorno do recebimento e a entrada de acerto não são compra: a última compra fica.
    await lancarDireto([
      movimento(prod, {
        tipoMovimento: 'ESTORNO_RECEB_MANUAL',
        documentoTipo: 'recebimento',
        quantidade: '-12',
        custoUnitario: null,
        estornoDeId: manual.movimentos[0]!.id,
      }),
    ]);
    await acerto('entrada', [{ produtoId: prod, quantidade: '1', custoUnitario: '9' }]);
    expect(await ultima()).toEqual({ em: nfe.dataMovimento, custo: '4.2500' });
    await recalcularIdentico();
  });

  it('acerto de saída e venda do PDV concorrentes no mesmo produto com lote: 20 vezes, sem deadlock', async () => {
    const x = await criarProduto('CERV LOTE CONCORRENTE X');
    const y = await criarProduto('CERV LOTE CONCORRENTE Y');
    const xa = await criarLote(x, 'X-A', '2026-12-01');
    const xb = await criarLote(x, 'X-B', '2027-02-01');
    const ya = await criarLote(y, 'Y-A', '2026-12-15');
    await entradaLotes(x, [
      [xa, '30'],
      [xb, '30'],
    ]);
    await entradaLotes(y, [[ya, '60']]);
    const p = await novoPonto();
    for (let i = 0; i < 20; i++) {
      // O acerto em X (lote informado) e Y (FEFO); a venda em Y e X (os dois em FEFO), na ordem oposta.
      const a = await tentarAcerto('saida', [
        { produtoId: x, loteId: xa, quantidade: '1' },
        { produtoId: y, quantidade: '1' },
      ]);
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      const [efetivado, vendido] = await Promise.all([
        amb.http().post(`/api/acertos/${a.body.id}/efetivar`).set(bearer()).send({ versao: a.body.versao }),
        pushOk(p, [
          evento(
            p,
            'venda.finalizada',
            venda(p, [
              [y, '1.000'],
              [x, '1.000'],
            ]),
          ),
        ]),
      ]);
      expect(efetivado.status, JSON.stringify(efetivado.body)).toBe(200);
      expect(vendido[0], JSON.stringify(vendido[0])).toMatchObject({ status: 'aplicado' });
    }
    expect([await saldo(x), await saldo(y)]).toEqual(['20.000', '20.000']);
    // Tudo saiu de algum lote (X tinha 60 em lotes; Y, 60 em Y-A): quanto de X-A e de X-B depende da ordem em que a
    // trava 7300001 serializou os dois documentos, mas a soma não. A 7300001 roda antes de qualquer trava de linha, então
    // este teste só confirma que nada quebra sob ela; a ordem das travas de linha é conferida em `movimentos.spec.ts`.
    const somaX = Object.values(await lotes(x)).reduce((s, q) => s.plus(q), dec(0));
    expect(somaX.toFixed(3)).toBe('20.000');
    expect(await lotes(y)).toEqual({ [ya]: '20.000' });
    await conferirFefo(x);
    await conferirFefo(y);
    await recalcularIdentico();
  }, 180_000);

  it('o db:recalcular-saldos acusa e refaz saldos_lote (inclusive o lote sem linha de saldo) e a última compra', async () => {
    const prod = await criarProduto('CERV LOTE RECALCULAR');
    const sem = await criarProduto('CERV LOTE SEM LINHA');
    const a = await criarLote(prod, 'R-1', '2026-12-01');
    const b = await criarLote(prod, 'R-2', '2027-01-01');
    const c = await criarLote(sem, 'R-3', null);
    await entradaLotes(prod, [[a, '10']]);
    await lancarDireto([
      movimento(prod, {
        tipoMovimento: 'RECEB_MANUAL',
        documentoTipo: 'recebimento',
        quantidade: '4',
        custoUnitario: '3',
      }),
    ]);
    await dona.query(
      `update saldos_lote set quantidade = quantidade - 1 where produto_id = $1 and lote_id = $2`,
      [prod, a],
    );
    await dona.query(
      `insert into saldos_lote (estoque_id, produto_id, lote_id, tipo_estoque_id, quantidade) values ($1, $2, $3, $4, 2)`,
      [estoqueLoja, prod, b, tipoPadrao],
    );
    await dona.query(`update saldos_estoque set ultimo_custo_compra = 9 where produto_id = $1`, [prod]);
    await dona.query(
      `insert into saldos_lote (estoque_id, produto_id, lote_id, tipo_estoque_id, quantidade) values ($1, $2, $3, $4, 5)`,
      [estoqueLoja, sem, c, tipoPadrao],
    );
    const r = await verificarSaldos(dona);
    const campos = (produto: string) =>
      r.divergencias
        .filter((d) => d.produtoId === produto)
        .flatMap((d) =>
          d.campos.map((x) => [d.situacao, x.campo, x.loteId ?? null, x.gravado, x.recalculado]),
        );
    expect(campos(prod)).toEqual([
      ['divergente', 'ultimo_custo_compra', null, '9.0000', '3.0000'],
      ['divergente', 'saldo_lote', a, '9.000', '10.000'],
      ['divergente', 'saldo_lote', b, '2.000', '0.000'],
    ]);
    expect(campos(sem)).toEqual([['orfa', 'saldo_lote', c, '5.000', '0.000']]);
    const correcao = await corrigirDivergencias(dona, r, { executadoPor: 'vitest' });
    expect(correcao.corrigidas).toBe(2);
    expect(projecaoIdentica(await verificarSaldos(dona))).toBe(true);
    expect(await lotes(prod)).toEqual({ [a]: '10.000', [b]: '0.000' });
    expect(await lotes(sem)).toEqual({ [c]: '0.000' });
    await recalcularIdentico();
  });
});
