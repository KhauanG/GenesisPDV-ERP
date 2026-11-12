/**
 * `db:recalcular-saldos` (Fase 2, F2-B3; README da API › decisão 147) contra o banco: depois de acertos e vendas do
 * PDV o razão refaz a projeção idêntica; uma corrupção proposital de saldo, de custo médio, de último movimento, de
 * linha sem razão e do `produtos.custo_medio` aparece exatamente nas linhas mexidas, o `--corrigir` as conserta (versão
 * nova, auditoria `recalcular_saldos`, o saldo certo no pull do fluxo `estoque`) e a segunda execução dá idêntico; uma
 * venda que chega entre a verificação e a correção, ou ao mesmo tempo que ela, não se perde; a correção em vários
 * blocos recria a linha de saldo que falta; o comando de verdade (`tsx src/cli/recalcular-saldos.ts`) diz "idêntico" e
 * devolve 2 com divergência; o replay de 200 mil movimentos fica abaixo de 256 MB de heap vivo (medido depois do gc,
 * crescendo menos de 64 MB); e a verificação periódica abre e resolve o alerta `RAZAO_SALDO_DIVERGENTE`. Cada teste
 * prepara o próprio cenário (`partirIdentica`) e só confere o que ele criou: rodam sozinhos ou em qualquer ordem.
 */
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ALERTA_RAZAO_SALDO_DIVERGENTE,
  CONTRATOS_EVENTOS,
  dec,
  jcs,
  respostaPullSchema,
  respostaPushSchema,
  type Ativar,
} from '@genesis/shared';
import type pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  corrigirDivergencias,
  projecaoIdentica,
  verificarSaldos,
  type RelatorioRecalculo,
} from '../../src/estoques/recalcular.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  urlDoBanco,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;
const PASTA_API = fileURLToPath(new URL('../..', import.meta.url));

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let estoqueLoja: string;
let tipoPadrao: string;
let tokenAdmin: string;
let operador: string;
let dinheiro: string;
let un: string;
/** Conexão da role dona com o banco da empresa (a do comando). */
let dona: pg.Client;

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const bearer = () => ({ Authorization: `Bearer ${tokenAdmin}` });
const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

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

/** O caixa com o terminal ativado pelo `/sync/ativar` real e a sessão aberta (como em `venda-eventos`). */
interface Ponto {
  caixa: string;
  numero: number;
  terminal: string;
  token: string;
  seq: number;
  venda: number;
  sessao: string;
}

let ponto: Ponto;

async function novoPonto(): Promise<Ponto> {
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja],
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
    numero: 1,
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
        dia_operacional: '2026-10-31',
        aberta_em: horasAtras(4),
        fundo_troco: '0.00',
      },
      movimentos_caixa: [],
    }),
  ]);
  expect(aberto, JSON.stringify(aberto)).toMatchObject({ status: 'aplicado' });
  return p;
}

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

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

async function pushOk(p: Ponto, eventos: unknown[]): Promise<Array<{ status: string }>> {
  const r = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: uuidv7(), terminal_id: p.terminal, enviado_em: agora(), eventos });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Array<{ status: string }>;
}

/** Uma venda finalizada em dinheiro com o que o contrato exige (C4). */
function venda(p: Ponto, itens: Array<[produto: string, quantidade: string]>) {
  const id = uuidv7();
  const numero = ++p.venda;
  const finalizada = agora();
  const linhas = itens.map(([produto, quantidade], n) => {
    const valor = (5 * Number(quantidade)).toFixed(2);
    return {
      id: uuidv7(),
      venda_id: id,
      sequencia: n + 1,
      produto_id: produto,
      descricao: 'ITEM DE TESTE',
      unidade: 'UN',
      quantidade: Number(quantidade).toFixed(3),
      preco_tabela: '5.0000',
      preco_unitario: '5.0000',
      valor_bruto: valor,
      valor_liquido: valor,
      incluido_em: finalizada,
      componentes_estoque: [],
    };
  });
  const total = (linhas.reduce((s, l) => s + Math.round(Number(l.valor_liquido) * 100), 0) / 100).toFixed(2);
  return {
    vendas: {
      id,
      numero,
      numero_exibicao: `L01-C01-${String(numero).padStart(6, '0')}`,
      ...linhaDoPonto(p),
      sessao_caixa_id: p.sessao,
      tipo: 'pdv',
      status: 'finalizada',
      dia_operacional: '2026-10-31',
      operador_id: operador,
      cliente_id: null,
      subtotal_bruto: total,
      total,
      iniciada_em: finalizada,
      finalizada_em: finalizada,
    },
    itens_venda: linhas,
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

async function vender(itens: Array<[produto: string, quantidade: string]>) {
  const [r] = await pushOk(ponto, [evento(ponto, 'venda.finalizada', venda(ponto, itens))]);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
}

async function criarProduto(nome: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ unidadeId: un, nome, precoVenda: '5', precoCusto: '2' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/**
 * Acerto de Entrada efetivado, com o custo de cada item. A "Data" (há 3 h) fica só no cabeçalho: a Entrada lança no
 * momento da efetivação (regra de data do F2-B4).
 */
async function entrada(itens: Array<[produto: string, quantidade: string, custo: string]>) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId: estoqueLoja,
      tipoAjuste: 'entrada',
      dataContagem: horasAtras(3),
      motivo: 'Saldo inicial',
      itens: itens.map(([produtoId, quantidade, custoUnitario]) => ({
        produtoId,
        quantidade,
        custoUnitario,
      })),
    });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const atual = await amb.http().get(`/api/acertos/${a.body.id}`).set(bearer());
  const e = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: atual.body.versao });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
}

/** Páginas do pull do terminal até `tem_mais = false`, a partir de `desde`. */
async function puxarEstoque(desde: number) {
  const alteracoes: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
  let cursor = desde;
  for (let i = 0; i < 100; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=estoque&desde=${cursor}&limite=500`)
      .set(cabecalhos(ponto.token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...r.body.alteracoes);
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { alteracoes, cursor };
  }
  throw new Error('pull não terminou');
}

interface Saldo {
  id: string;
  versao: string;
  quantidade: string;
  custo_medio: string;
  ultimo_movimento_id: string | null;
}

async function saldo(produto: string): Promise<Saldo | undefined> {
  const [s] = await consultar<Saldo>(
    emp.nomeBanco,
    `select id, versao::text, quantidade::text, custo_medio::text, ultimo_movimento_id from saldos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoqueLoja, produto, tipoPadrao],
  );
  return s;
}

/** Σ das quantidades do razão da linha (o saldo que o razão diz). */
async function somaRazao(produto: string): Promise<string> {
  const [r] = await consultar<{ s: string }>(
    emp.nomeBanco,
    `select coalesce(sum(quantidade), 0)::text as s from movimentos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoqueLoja, produto, tipoPadrao],
  );
  return r!.s;
}

const corrigir = (r: RelatorioRecalculo) => corrigirDivergencias(dona, r, { executadoPor: 'vitest' });

/**
 * Cada teste prepara o próprio cenário: o que outro deixou divergente é corrigido antes, para que ele rode sozinho
 * (`vitest -t`, `it.only`) ou em qualquer ordem e veja só as divergências que ele mesmo criou.
 */
async function partirIdentica(): Promise<void> {
  const r = await verificarSaldos(dona);
  if (!projecaoIdentica(r)) await corrigir(r);
}

/**
 * Uma linha com o razão inconsistente em si (histórico): a venda é lançada sobre a projeção errada e a correção depois
 * refaz o saldo pelo razão; a cadeia daquela linha fica quebrada no 2º movimento (o razão nunca é alterado).
 */
async function quebrarCadeia(produto: string): Promise<void> {
  await entrada([[produto, '10', '2.00']]);
  const linha = (await saldo(produto))!;
  await dona.query('update saldos_estoque set quantidade = quantidade - 3 where id = $1', [linha.id]);
  await vender([[produto, '1']]);
  await corrigir(await verificarSaldos(dona, { produtoId: produto }));
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  [{ estoque_id: estoqueLoja }] = (await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [loja],
  )) as [{ estoque_id: string }];
  [{ id: operador }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  [{ id: dinheiro }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null order by ordem limit 1",
  )) as [{ id: string }];
  [{ id: tipoPadrao }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'select id from tipos_estoque where padrao',
  )) as [{ id: string }];
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  ponto = await novoPonto();
  dona = await conectar(emp.nomeBanco);
}, 180_000);

afterAll(async () => {
  await dona?.end();
  await amb?.fechar();
});

describe('db:recalcular-saldos (F2-B3; MD 3.7; ERP 13.1.1)', () => {
  it('depois de acertos e vendas, a projeção refeita pelo razão é idêntica', async () => {
    await partirIdentica();
    const a = await criarProduto('CERV IDENTICA');
    const b = await criarProduto('REFRI IDENTICO');
    await entrada([
      [a, '30', '2.10'],
      [b, '12', '3.40'],
    ]);
    await vender([
      [a, '4'],
      [b, '2'],
    ]);
    await entrada([[a, '10', '2.90']]);
    await vender([[a, '41']]);
    const r = await verificarSaldos(dona);
    expect(r).toMatchObject({ divergencias: [], custoProdutos: [] });
    // O histórico que outro teste deixou de propósito (cadeia quebrada) não é deste.
    expect(r.razaoInconsistente.filter((i) => i.produtoId === a || i.produtoId === b)).toEqual([]);
    expect(projecaoIdentica(r)).toBe(true);
    expect(r.movimentos).toBeGreaterThanOrEqual(6);
    expect((await saldo(a))!.quantidade).toBe('-5.000');
  });

  it('a corrupção proposital é apontada linha a linha; o --corrigir conserta, a versão sobe e desce no pull', async () => {
    const [p1, p2, p3, p4, p5] = await Promise.all(
      ['CERV SALDO', 'CERV CUSTO', 'CERV ULTIMO', 'CERV PRODUTO', 'CERV ORFA'].map(criarProduto),
    );
    await entrada([
      [p1!, '20', '2.00'],
      [p2!, '20', '2.00'],
      [p3!, '20', '2.00'],
      [p4!, '20', '2.00'],
    ]);
    await vender([
      [p1!, '3'],
      [p2!, '3'],
      [p3!, '3'],
    ]);
    await entrada([[p2!, '10', '3.50']]);
    await partirIdentica();
    const antes = await verificarSaldos(dona);
    expect(projecaoIdentica(antes)).toBe(true);
    const pull = await puxarEstoque(0);

    const certos = { p1: (await saldo(p1!))!, p2: (await saldo(p2!))!, p3: (await saldo(p3!))! };
    const [primeiro] = await consultar<{ id: string }>(
      emp.nomeBanco,
      `select id from movimentos_estoque where produto_id = $1 order by seq_lancamento limit 1`,
      [p3],
    );
    await dona.query('update saldos_estoque set quantidade = quantidade + 7 where id = $1', [certos.p1.id]);
    await dona.query('update saldos_estoque set custo_medio = 9.9 where id = $1', [certos.p2.id]);
    await dona.query('update saldos_estoque set ultimo_movimento_id = $2 where id = $1', [
      certos.p3.id,
      primeiro!.id,
    ]);
    await dona.query('update produtos set custo_medio = 7.7 where id = $1', [p4]);
    const orfa = uuidv7();
    await dona.query(
      `insert into saldos_estoque (id, estoque_id, produto_id, tipo_estoque_id, quantidade)
       values ($1, $2, $3, $4, 7)`,
      [orfa, estoqueLoja, p5, tipoPadrao],
    );
    const depoisDaCorrupcao = await puxarEstoque(pull.cursor);

    const r = await verificarSaldos(dona);
    // Só o que este teste mexeu (a empresa partiu idêntica).
    expect(
      r.divergencias.map((d) => [
        d.produtoId,
        d.situacao,
        d.campos.map((c) => [c.campo, c.gravado, c.recalculado]),
      ]),
    ).toEqual(
      expect.arrayContaining([
        [
          p1,
          'divergente',
          [['quantidade', dec(certos.p1.quantidade).plus(7).toFixed(3), certos.p1.quantidade]],
        ],
        [p2, 'divergente', [['custo_medio', '9.9000', certos.p2.custo_medio]]],
        [p3, 'divergente', [['ultimo_movimento_id', primeiro!.id, certos.p3.ultimo_movimento_id]]],
        [p5, 'orfa', [['quantidade', '7.000', '0.000']]],
      ]),
    );
    expect(r.divergencias).toHaveLength(4);
    expect(r.divergencias.find((d) => d.produtoId === p1)!.campos[0]!.diferenca).toBe('-7.000');
    // A corrupção do saldo de p2 levou o custo do produto junto (trigger da 0006); a de p4 é só no produto.
    expect(r.custoProdutos).toEqual([
      { produtoId: p4, gravado: '7.7000', recalculado: '2.0000', diferenca: '-5.7000' },
    ]);
    expect(r.razaoInconsistente.filter((i) => [p1, p2, p3, p4, p5].includes(i.produtoId))).toEqual([]);

    const c = await corrigir(r);
    expect(c).toMatchObject({ corrigidas: 4, jaCertas: 0, custoProdutos: 1 });
    for (const [p, certo] of [
      [p1!, certos.p1],
      [p2!, certos.p2],
      [p3!, certos.p3],
    ] as const) {
      const s = (await saldo(p))!;
      expect([s.quantidade, s.custo_medio, s.ultimo_movimento_id]).toEqual([
        certo.quantidade,
        certo.custo_medio,
        certo.ultimo_movimento_id,
      ]);
      expect(BigInt(s.versao)).toBeGreaterThan(BigInt(certo.versao));
    }
    expect((await saldo(p5!))!.quantidade).toBe('0.000');
    const [produto2] = await consultar<{ custo_medio: string }>(
      emp.nomeBanco,
      'select custo_medio::text from produtos where id = $1',
      [p2],
    );
    expect(produto2!.custo_medio).toBe(certos.p2.custo_medio);

    // O saldo certo desce ao PDV pelo fluxo `estoque` (a versão nova das linhas corrigidas).
    const novas = await puxarEstoque(depoisDaCorrupcao.cursor);
    const quantidades = new Map(
      novas.alteracoes
        .filter((a) => a.tabela === 'saldos_estoque')
        .map((a) => [a.linha.produto_id as string, a.linha.quantidade]),
    );
    expect(quantidades.get(p1!)).toBe(certos.p1.quantidade);
    expect(quantidades.get(p5!)).toBe('0.000');

    const auditadas = await consultar<{
      entidade: string;
      registro_id: string;
      antes: Payload;
      depois: Payload;
    }>(
      emp.nomeBanco,
      `select entidade, registro_id, antes, depois from auditoria
        where acao = 'recalcular_saldos' and registro_id::text = any($1::text[])`,
      [[certos.p1.id, certos.p2.id, certos.p3.id, orfa, p4!]],
    );
    // Uma auditoria por linha regravada (as 3 divergentes e a órfã) e uma pelo custo do produto p4.
    expect(auditadas).toHaveLength(5);
    const doP1 = auditadas.find((a) => a.registro_id === certos.p1.id)!;
    expect([doP1.entidade, doP1.antes.quantidade, doP1.depois.quantidade]).toEqual([
      'saldos_estoque',
      dec(certos.p1.quantidade).plus(7).toFixed(3),
      certos.p1.quantidade,
    ]);
    expect(auditadas.find((a) => a.registro_id === p4)).toMatchObject({
      entidade: 'produtos',
      antes: { custo_medio: '7.7000' },
      depois: { custo_medio: '2.0000' },
    });

    // Segunda execução: idêntico; e o --corrigir de novo não regrava nada.
    const segunda = await verificarSaldos(dona);
    expect(projecaoIdentica(segunda)).toBe(true);
    expect(await corrigir(r)).toMatchObject({ corrigidas: 0, jaCertas: 4, custoProdutos: 0 });
  });

  it('a venda que chega entre a verificação e a correção, ou ao mesmo tempo, não se perde', async () => {
    const p = await criarProduto('CERV CONCORRENTE');
    await entrada([[p, '50', '2.00']]);
    const linha = (await saldo(p))!;

    // Entre as duas: a venda é lançada sobre a projeção errada; a correção continua o replay com ela, sob a trava.
    await dona.query('update saldos_estoque set quantidade = quantidade - 20 where id = $1', [linha.id]);
    const r1 = await verificarSaldos(dona, { produtoId: p });
    expect(r1.divergencias).toHaveLength(1);
    await vender([[p, '5']]);
    expect((await saldo(p))!.quantidade).toBe('25.000');
    expect(await corrigir(r1)).toMatchObject({ corrigidas: 1 });
    expect((await saldo(p))!.quantidade).toBe('45.000');
    expect(await somaRazao(p)).toBe('45.000');
    const depois1 = await verificarSaldos(dona, { produtoId: p });
    expect(depois1.divergencias).toEqual([]);
    // O movimento da venda partiu do saldo errado: fica no razão como histórico (o razão nunca é alterado).
    expect(depois1.razaoInconsistente).toEqual([
      expect.objectContaining({
        produtoId: p,
        quebras: 1,
        primeiraQuebra: expect.objectContaining({ posicao: 2 }),
      }),
    ]);

    // Ao mesmo tempo: a correção e a venda disputam a 7300001; em qualquer ordem, o saldo final é o do razão.
    await dona.query('update saldos_estoque set quantidade = quantidade + 3 where id = $1', [linha.id]);
    const r2 = await verificarSaldos(dona, { produtoId: p });
    expect(r2.divergencias).toHaveLength(1);
    await Promise.all([corrigir(r2), vender([[p, '2']])]);
    expect(await somaRazao(p)).toBe('43.000');
    const final = await verificarSaldos(dona, { produtoId: p });
    expect(final.divergencias).toEqual([]);
    expect((await saldo(p))!.quantidade).toBe('43.000');
  });

  it('o filtro por estoque e por produto limita o que é conferido', async () => {
    const p = await criarProduto('CERV FILTRO');
    await entrada([[p, '8', '1.50']]);
    const linha = (await saldo(p))!;
    await dona.query('update saldos_estoque set quantidade = 1 where id = $1', [linha.id]);
    const outro = await criarProduto('CERV FORA DO FILTRO');
    const doProduto = await verificarSaldos(dona, { produtoId: outro });
    expect([doProduto.linhas, doProduto.divergencias]).toEqual([0, []]);
    const doEstoque = await verificarSaldos(dona, { estoqueId: estoqueLoja, produtoId: p });
    expect(doEstoque.divergencias.map((d) => d.produtoId)).toEqual([p]);
    await corrigir(doEstoque);
    expect(projecaoIdentica(await verificarSaldos(dona, { produtoId: p }))).toBe(true);
    await expect(verificarSaldos(dona, { produtoId: "x' or true --" })).rejects.toThrow('não é um UUID');
  });

  it('o --corrigir em blocos recria a linha de saldo que falta e continua o replay de cada bloco', async () => {
    const produtos = await Promise.all(
      ['CERV BLOCO A', 'CERV BLOCO B', 'CERV BLOCO C', 'CERV BLOCO D', 'CERV SEM LINHA'].map(criarProduto),
    );
    const semLinha = produtos[4]!;
    await entrada(produtos.map((p, i) => [p, String(10 + i), '2.00'] as [string, string, string]));
    await partirIdentica();
    const pull = await puxarEstoque(0);
    const certos = new Map<string, Saldo>();
    for (const p of produtos) certos.set(p, (await saldo(p))!);
    // Quatro saldos errados (cada um com um desvio diferente) e a linha de saldo de um produto com razão apagada.
    for (const [i, p] of produtos.slice(0, 4).entries()) {
      await dona.query('update saldos_estoque set quantidade = quantidade + $2 where id = $1', [
        certos.get(p)!.id,
        i + 1,
      ]);
    }
    await dona.query('delete from saldos_estoque where id = $1', [certos.get(semLinha)!.id]);

    const r = await verificarSaldos(dona);
    expect(r.divergencias.map((d) => [d.produtoId, d.situacao, d.saldoId === null])).toEqual(
      expect.arrayContaining([
        ...produtos.slice(0, 4).map((p) => [p, 'divergente', false]),
        [semLinha, 'sem_linha', true],
      ]),
    );
    expect(r.divergencias).toHaveLength(5);
    // Entre a verificação e a correção, uma venda em cada um de dois produtos (caem em blocos diferentes).
    await vender([
      [produtos[0]!, '1'],
      [produtos[3]!, '2'],
    ]);

    const c = await corrigirDivergencias(dona, r, { executadoPor: 'vitest' }, { porTransacao: 2 });
    expect(c).toMatchObject({ corrigidas: 5, jaCertas: 0, transacoes: 3 });
    for (const p of produtos) {
      const s = (await saldo(p))!;
      expect(s.quantidade, p).toBe(dec(await somaRazao(p)).toFixed(3));
    }
    expect((await saldo(produtos[0]!))!.quantidade).toBe('9.000');
    expect((await saldo(produtos[3]!))!.quantidade).toBe('11.000');
    // A linha que faltava foi recriada pelo replay, com id novo, e é ela que desce no pull e vai na auditoria.
    const recriada = (await saldo(semLinha))!;
    expect(recriada.id).not.toBe(certos.get(semLinha)!.id);
    expect([recriada.quantidade, recriada.custo_medio, recriada.ultimo_movimento_id]).toEqual([
      '14.000',
      certos.get(semLinha)!.custo_medio,
      certos.get(semLinha)!.ultimo_movimento_id,
    ]);
    const novas = await puxarEstoque(pull.cursor);
    const descidas = novas.alteracoes.filter(
      (a) => a.tabela === 'saldos_estoque' && a.linha.produto_id === semLinha,
    );
    expect(descidas.at(-1)?.linha).toMatchObject({ id: recriada.id, quantidade: '14.000' });
    const [auditoria] = await consultar<{ antes: Payload; depois: Payload }>(
      emp.nomeBanco,
      "select antes, depois from auditoria where acao = 'recalcular_saldos' and registro_id = $1",
      [recriada.id],
    );
    expect(auditoria).toMatchObject({ antes: { quantidade: '0.000' }, depois: { quantidade: '14.000' } });
    expect(projecaoIdentica(await verificarSaldos(dona))).toBe(true);
  });

  it('o comando de verdade: "idêntico" com código 0, a divergência com código 2 e o relatório CSV', async () => {
    const executar = promisify(execFile);
    const env = {
      ...process.env,
      AMBIENTE: 'teste',
      DATABASE_URL: urlDoBanco(amb.bancoControle),
      LOG_NIVEL: 'silent',
      FILA_TRABALHADOR: 'false',
    };
    const comando = (args: string[]) =>
      executar('pnpm', ['exec', 'tsx', 'src/cli/recalcular-saldos.ts', ...args], {
        cwd: PASTA_API,
        env,
        timeout: 120_000,
      });
    await partirIdentica();
    const ok = await comando([`--empresa=${emp.codigo}`]);
    expect(ok.stdout).toContain(`${emp.codigo}: idêntico (`);

    const historico = await criarProduto('CERV CLI HISTORICO');
    await quebrarCadeia(historico);
    const p = await criarProduto('CERV CLI');
    await entrada([[p, '6', '2.00']]);
    const linha = (await saldo(p))!;
    await dona.query('update saldos_estoque set quantidade = 2 where id = $1', [linha.id]);
    // O alerta da verificação periódica (talvez já desligada) aberto antes: só a conferência idêntica da empresa
    // inteira o resolve, não a do `--produto`.
    await dona.query(
      `insert into alertas (tipo, severidade, titulo, entidade, dados, chave_deduplicacao)
       values ($1, 'aviso', 'Saldo de estoque diferente do razão', 'saldos_estoque', '{}', 'razao_saldos')
       on conflict (chave_deduplicacao) where resolvido_em is null and excluido_em is null do nothing`,
      [ALERTA_RAZAO_SALDO_DIVERGENTE],
    );
    const saldoDivergenteAberto = async () =>
      (
        await consultar(emp.nomeBanco, 'select 1 from alertas where tipo = $1 and resolvido_em is null', [
          ALERTA_RAZAO_SALDO_DIVERGENTE,
        ])
      ).length;
    const saida = join(tmpdir(), `recalcular-${uuidv7()}.csv`);
    try {
      const falha = await comando(['--todas', `--saida=${saida}`]).then(
        () => null,
        (e: { code: number; stdout: string }) => e,
      );
      expect(falha?.code).toBe(2);
      expect(falha?.stdout).toContain(
        `[divergente] estoque ${estoqueLoja} produto ${p}: quantidade 2.000 → 6.000 (4.000)`,
      );
      const csv = readFileSync(saida, 'utf8').trim().split('\n');
      expect(csv[0]).toMatch(/^empresa;situacao;estoque_id;produto_id;/);
      // Uma linha por campo divergente; a cadeia quebrada de propósito vem como histórico (razão inconsistente).
      const doTeste = csv.slice(1).filter((l) => l.includes(`;${p};`) || l.includes(`;${historico};`));
      expect(doTeste).toEqual([
        `${emp.codigo};divergente;${estoqueLoja};${p};;${tipoPadrao};quantidade;2.000;6.000;4.000;1;;;0;;;`,
        expect.stringMatching(
          new RegExp(`^${emp.codigo};razao_inconsistente;${estoqueLoja};${historico};;${tipoPadrao};;;;;2;`),
        ),
      ]);
      // Dois alertas de cadeia quebrada (F2-B2): o `--corrigir` resolve só o das linhas do filtro.
      const outro = await criarProduto('CERV OUTRA CADEIA');
      for (const [produtoId, chave] of [
        [p, 'razao_cadeia:teste-p'],
        [outro, 'razao_cadeia:teste-outro'],
      ] as const) {
        await dona.query(
          `insert into alertas (tipo, severidade, titulo, entidade, registro_id, dados, chave_deduplicacao)
           values ('RAZAO_CADEIA_QUEBRADA', 'aviso', 'Razão de estoque com a cadeia quebrada', 'produtos', $1, $2, $3)`,
          [produtoId, JSON.stringify({ estoque_id: estoqueLoja, produto_id: produtoId }), chave],
        );
      }
      const corrigido = await comando([`--empresa=${emp.codigo}`, `--produto=${p}`, '--corrigir']);
      expect(corrigido.stdout).toContain(`${emp.codigo}: corrigidas 1 linha(s) de saldo`);
      expect(corrigido.stdout).toContain(`${emp.codigo}: 1 alerta(s) de cadeia quebrada resolvido(s)`);
      const cadeias = await consultar<{ chave_deduplicacao: string; resolvido: boolean }>(
        emp.nomeBanco,
        `select chave_deduplicacao, resolvido_em is not null as resolvido from alertas
          where tipo = 'RAZAO_CADEIA_QUEBRADA' order by chave_deduplicacao`,
      );
      expect(cadeias).toEqual([
        { chave_deduplicacao: 'razao_cadeia:teste-outro', resolvido: false },
        { chave_deduplicacao: 'razao_cadeia:teste-p', resolvido: true },
      ]);
      expect((await saldo(p))!.quantidade).toBe('6.000');
      expect(await saldoDivergenteAberto()).toBe(1);
      const conferido = await comando([`--empresa=${emp.codigo}`]);
      expect(conferido.stdout).toContain(`${emp.codigo}: idêntico (`);
      expect(conferido.stdout).toContain(`${emp.codigo}: alerta de saldo divergente do razão resolvido`);
      expect(await saldoDivergenteAberto()).toBe(0);
    } finally {
      rmSync(saida, { force: true });
    }
    const semEmpresa = await comando([]).then(
      () => null,
      (e: { code: number; stderr: string }) => e,
    );
    expect(semEmpresa?.code).toBe(1);
    expect(semEmpresa?.stderr).toContain('--empresa');
  }, 300_000);

  it('a verificação periódica (desligada por padrão) abre o alerta com divergência e o resolve quando bate', async () => {
    const abertos = () =>
      consultar<{ dados: Payload }>(
        emp.nomeBanco,
        'select dados from alertas where tipo = $1 and resolvido_em is null',
        [ALERTA_RAZAO_SALDO_DIVERGENTE],
      );
    expect(amb.config.fila.verificacaoRazaoCron).toBeNull();
    // A outra empresa (a do teste de memória, se já rodou) nasce idêntica: a única divergente é a deste teste.
    await partirIdentica();
    const p = await criarProduto('CERV ALERTA');
    await entrada([[p, '4', '2.00']]);
    const linha = (await saldo(p))!;
    await dona.query('update saldos_estoque set quantidade = 0 where id = $1', [linha.id]);
    const r1 = await amb.servicos.verificacaoRazao.executar();
    expect(r1).toMatchObject({ executada: true, divergentes: 1, falhas: [] });
    const [alerta] = await abertos();
    expect(alerta!.dados).toMatchObject({
      linhas_divergentes: 1,
      primeiras: [expect.objectContaining({ produto_id: p, campos: ['quantidade'] })],
    });
    // Só verifica: nada foi corrigido.
    expect((await saldo(p))!.quantidade).toBe('0.000');
    await corrigir(await verificarSaldos(dona));
    expect(await amb.servicos.verificacaoRazao.executar()).toMatchObject({ divergentes: 0, falhas: [] });
    expect(await abertos()).toEqual([]);
  });

  it('o replay de 200 mil movimentos sintéticos fica abaixo de 256 MB de heap', async () => {
    const outra = await amb.criarEmpresa();
    const c = await conectar(outra.nomeBanco);
    try {
      const [{ estoque, tipo, unidade }] = (
        await c.query<{ estoque: string; tipo: string; unidade: string }>(
          `select (select id from estoques where excluido_em is null order by criado_em limit 1) as estoque,
                  (select id from tipos_estoque where padrao) as tipo,
                  (select id from unidades_medida where sigla = 'UN') as unidade`,
        )
      ).rows as [{ estoque: string | null; tipo: string; unidade: string }];
      const estoqueId =
        estoque ??
        (await c.query<{ id: string }>("insert into estoques (nome) values ('Sintético') returning id"))
          .rows[0]!.id;
      // 4 linhas × 50 mil movimentos de +1 a 2,0000: a cadeia fecha e o custo médio fica em 2.
      for (let l = 0; l < 4; l++) {
        const { rows } = await c.query<{ id: string }>(
          'insert into produtos (nome, unidade_id) values ($1, $2) returning id',
          [`SINTETICO ${l}`, unidade],
        );
        const produto = rows[0]!.id;
        await c.query(
          `insert into movimentos_estoque (id, estoque_id, tipo_estoque_id, produto_id, tipo_movimento, quantidade,
             saldo_anterior, saldo_posterior, custo_unitario, custo_total, custo_medio_posterior, data_movimento,
             documento_tipo, seq_lancamento)
           select fn_uuid_v7(), $1, $2, $3, 'ACERTO_ENTRADA', 1, g - 1, g, 2, 2, 2,
                  timestamptz '2026-11-01 00:00:00+00' + g * interval '1 millisecond', 'acerto',
                  2000000000000 + $4::bigint * 1000000 + g
             from generate_series(1, 50000) as g`,
          [estoqueId, tipo, produto, l],
        );
        await c.query(
          `insert into saldos_estoque (id, estoque_id, produto_id, tipo_estoque_id, quantidade, custo_medio,
             ultima_entrada_em, ultimo_movimento_id)
           select fn_uuid_v7(), $1, $2, $3, 50000, 2, max(data_movimento),
                  (select id from movimentos_estoque where produto_id = $2 order by seq_lancamento desc limit 1)
             from movimentos_estoque where produto_id = $2`,
          [estoqueId, produto, tipo],
        );
      }
      // Mede o heap VIVO (depois do `gc()`, ligado pelo `--expose-gc` do vitest.integracao.config.ts) a cada página.
      // Sem o gc, a conta pegava o lixo que o V8 ainda não recolheu (dependia da carga da máquina: 274 MB na CI da
      // `main` em 12/11/2026, com ~120 MB vivos). O teto de 256 MB continua, e o crescimento sobre a base fica abaixo
      // de 64 MB: guardar os 200 mil movimentos em memória passaria disso.
      const gc = globalThis.gc;
      if (!gc) throw new Error('rode com --expose-gc (vitest.integracao.config.ts)');
      gc();
      const base = process.memoryUsage().heapUsed;
      let pico = base;
      const medir = () => {
        gc();
        pico = Math.max(pico, process.memoryUsage().heapUsed);
      };
      const r = await verificarSaldos(c, {}, { aoPaginar: medir });
      medir();
      expect(r).toMatchObject({ linhas: 4, movimentos: 200_000, divergencias: [], razaoInconsistente: [] });
      expect(pico).toBeLessThan(256 * 1024 * 1024);
      expect(pico - base).toBeLessThan(64 * 1024 * 1024);
    } finally {
      await c.end();
    }
  }, 300_000);

  it('no fim da suíte, a projeção de todas as empresas é idêntica ao razão', async () => {
    // A conferência inteira do F2-B2 (`conferirRazaoDasEmpresas`) não serve aqui: a venda lançada de propósito sobre a
    // projeção errada deixou a cadeia daquela linha quebrada, como histórico.
    const bancos = await consultar<{ nome_banco: string }>(
      amb.bancoControle,
      'select nome_banco from empresas',
    );
    for (const { nome_banco } of bancos) {
      const c = await conectar(nome_banco);
      try {
        expect(projecaoIdentica(await verificarSaldos(c)), nome_banco).toBe(true);
      } finally {
        await c.end();
      }
    }
  });
});
