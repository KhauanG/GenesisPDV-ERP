/**
 * Mudança de tipo de estoque (Fase 2, F2-B8; ERP 13.1.4, 13.5, 13.6; MD 3.7.3, 3.7.5; README da API › decisão 153),
 * pela API do ERP: mover 5 de Disponível para Avaria gera o par `MUDANCA_TIPO_ESTOQUE` (−origem ao custo médio dela,
 * +destino com o mesmo custo e o mesmo item) e preserva o custo total, com o custo médio do destino recalculado pela
 * média ponderada; o estorno é o par invertido, com as duas pernas ao mesmo custo: sem nada no meio, origem e destino
 * voltam ao custo médio de antes, e, com outro movimento no destino no meio, o valor do estoque a custo segue igual; o
 * fluxo `estoque` do PDV mostra o Disponível caindo e nunca a linha da Avaria (não vendável); o lote acompanha
 * (divisão FEFO na perna de saída, o mesmo lote na de entrada, e o lote informado); o saldo insuficiente na origem é
 * recusado sem a permissão de saldo negativo (o Master passa); o cabeçalho exige o destino, diferente da origem
 * (inclusive pelo padrão) e ativo, e o banco também (`ck_acertos_estoque_mudanca_tipo`, imutável depois de
 * efetivado); o tipo que é destino de um rascunho não se inativa, e a efetivação e o estorno com o destino
 * inativo são recusados no campo `tipoEstoqueDestinoId`; mudanças em sentidos opostos em paralelo efetivam sem
 * deadlock; a efetivação repetida (a segunda requisição, em paralelo) não lança de novo, e o índice de
 * idempotência recusa a perna repetida no motor. O razão refaz as projeções idênticas no fim de cada teste
 * (`conferirRazaoDoBanco`).
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { respostaPullSchema, type Ativar } from '@genesis/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lancarDocumento } from '../../src/estoques/movimentos.js';
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
let disponivel: string;
let avaria: string;
let vencido: string;
let tokenAdmin: string;
/** Estoquista: sem `estoque.permite_negativo_erp` nem Master (a regra do saldo negativo vale). */
let tokenEstoquista: string;
let un: string;
/** Conexão da role dona com o banco da empresa (o motor direto). */
let dona: pg.Client;

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

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

/** Terminal ativado pelo `/sync/ativar` real num caixa novo da loja; devolve o token. */
async function ativarTerminal(): Promise<string> {
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [loja, 'Caixa 01'],
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
  return r.body.token as string;
}

type Alteracao = { tabela: string; linha: Record<string, unknown> };

/** Páginas do fluxo `estoque` desde `desde`, como o PDV. */
async function puxarEstoque(token: string, desde: number) {
  const alteracoes: Alteracao[] = [];
  let cursor = desde;
  for (let i = 0; i < 50; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=estoque&desde=${cursor}&limite=2000`)
      .set(cabecalhos(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...(r.body.alteracoes as Alteracao[]));
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { alteracoes, cursor };
  }
  throw new Error('pull não terminou');
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

async function criarLote(produto: string, lote: string, validade: string) {
  const [{ id }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into produtos_lotes (produto_id, estoque_id, lote, validade) values ($1, $2, $3, $4) returning id',
    [produto, estoqueLoja, lote, validade],
  )) as [{ id: string }];
  return id;
}

type ItemAcerto = { produtoId: string; quantidade: string; loteId?: string; custoUnitario?: string };
type Cabecalho = {
  tipoAjuste: 'entrada' | 'saida' | 'mudanca_tipo';
  tipoEstoqueId?: string | null;
  tipoEstoqueDestinoId?: string | null;
};

function tentarAcerto(cab: Cabecalho, itens: ItemAcerto[], token = tokenAdmin) {
  return amb
    .http()
    .post('/api/acertos')
    .set(bearer(token))
    .send({
      estoqueId: estoqueLoja,
      dataContagem: new Date().toISOString(),
      motivo: 'Avaria',
      ...cab,
      itens,
    });
}

/** Cria (201) e tenta efetivar; devolve o id e a resposta da efetivação. */
async function tentarEfetivar(cab: Cabecalho, itens: ItemAcerto[], token = tokenAdmin) {
  const a = await tentarAcerto(cab, itens, token);
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const r = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer(token))
    .send({ versao: a.body.versao });
  return { id: a.body.id as string, r };
}

async function acerto(cab: Cabecalho, itens: ItemAcerto[], token = tokenAdmin) {
  const { id, r } = await tentarEfetivar(cab, itens, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { id, detalhe: r.body as Record<string, unknown> & { itens: Array<Record<string, unknown>> } };
}

/** Entrada no tipo (padrão: Disponível) ao custo informado. */
const entrada = (produto: string, quantidade: string, custo: string, tipo = disponivel, loteId?: string) =>
  acerto({ tipoAjuste: 'entrada', tipoEstoqueId: tipo }, [
    { produtoId: produto, quantidade, custoUnitario: custo, ...(loteId ? { loteId } : {}) },
  ]);

/** Mudança de tipo `de` → `para` (padrão: Disponível → Avaria). */
const mudanca = (itens: ItemAcerto[], de = disponivel, para = avaria, token = tokenAdmin) =>
  tentarEfetivar({ tipoAjuste: 'mudanca_tipo', tipoEstoqueId: de, tipoEstoqueDestinoId: para }, itens, token);

async function estornar(id: string) {
  const atual = await amb.http().get(`/api/acertos/${id}`).set(bearer());
  const r = await amb
    .http()
    .post(`/api/acertos/${id}/estornar`)
    .set(bearer())
    .send({ versao: atual.body.versao, motivo: 'Avaria lançada no produto errado' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Quantidade e custo médio da linha do produto no tipo. */
async function linha(produto: string, tipo: string): Promise<{ q: string; cm: string }> {
  const [s] = await consultar<{ q: string; cm: string }>(
    emp.nomeBanco,
    `select quantidade::text as q, custo_medio::text as cm from saldos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoqueLoja, produto, tipo],
  );
  return s ?? { q: '0.000', cm: '0.0000' };
}

/** Σ quantidade × custo médio do produto em todos os tipos do estoque (o valor do estoque a custo). */
async function valorEmEstoque(produto: string): Promise<string> {
  const [s] = await consultar<{ v: string }>(
    emp.nomeBanco,
    `select coalesce(sum(quantidade * custo_medio), 0)::numeric(15,2)::text as v from saldos_estoque
      where estoque_id = $1 and produto_id = $2`,
    [estoqueLoja, produto],
  );
  return s!.v;
}

/** Saldo por lote da linha do produto no tipo (`lote_id` → quantidade). */
async function lotes(produto: string, tipo: string): Promise<Record<string, string>> {
  const r = await consultar<{ lote_id: string; quantidade: string }>(
    emp.nomeBanco,
    `select lote_id, quantidade::text from saldos_lote
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3 order by lote_id`,
    [estoqueLoja, produto, tipo],
  );
  return Object.fromEntries(r.map((l) => [l.lote_id, l.quantidade]));
}

type Mov = {
  tipo_movimento: string;
  tipo_estoque_id: string;
  lote_id: string | null;
  quantidade: string;
  custo_unitario: string;
  custo_total: string;
  documento_item_id: string;
  estorno_de_id: string | null;
};

const movimentosDoDocumento = (documentoId: string) =>
  consultar<Mov>(
    emp.nomeBanco,
    `select tipo_movimento, tipo_estoque_id, lote_id, quantidade::text, custo_unitario::text, custo_total::text,
            documento_item_id, estorno_de_id
       from movimentos_estoque where documento_id = $1 order by seq_lancamento`,
    [documentoId],
  );

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
  const tipos = await consultar<{ id: string; chave_sistema: string }>(
    emp.nomeBanco,
    'select id, chave_sistema from tipos_estoque where chave_sistema is not null',
  );
  const tipo = (chave: string) => tipos.find((t) => t.chave_sistema === chave)!.id;
  [disponivel, avaria, vencido] = [tipo('disponivel'), tipo('avaria'), tipo('vencido')];
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

describe('mudança de tipo de estoque (F2-B8; ERP 13.1.4, 13.6)', () => {
  it('mover 5 de Disponível para Avaria: o par ao custo médio da origem, o custo total preservado e o médio do destino recalculado; o estorno volta tudo', async () => {
    const prod = await criarProduto('CERV MUDANCA CUSTO');
    // Disponível: 10 a 2,00 + 10 a 3,00 = 20 a 2,50. Avaria: 5 a 4,00.
    await entrada(prod, '10', '2');
    await entrada(prod, '10', '3');
    await entrada(prod, '5', '4', avaria);
    expect(await valorEmEstoque(prod)).toBe('70.00');

    const { id, r } = await mudanca([{ produtoId: prod, quantidade: '5' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      tipoAjuste: 'mudanca_tipo',
      tipoEstoqueId: disponivel,
      tipoEstoqueNome: 'Disponível',
      tipoEstoqueDestinoId: avaria,
      tipoEstoqueDestinoNome: 'Avaria',
      status: 'efetivado',
      totalCusto: '12.50',
      totalVenda: '25.00',
    });
    expect(r.body.itens[0]).toMatchObject({
      saldoAtual: '20.000',
      diferenca: '-5.000',
      custoUnitario: '2.5000',
      totalCusto: '12.50',
    });
    const movs = await movimentosDoDocumento(id);
    expect(
      movs.map((m) => [m.tipo_movimento, m.tipo_estoque_id, m.quantidade, m.custo_unitario, m.custo_total]),
    ).toEqual([
      ['MUDANCA_TIPO_ESTOQUE', disponivel, '-5.000', '2.5000', '12.50'],
      ['MUDANCA_TIPO_ESTOQUE', avaria, '5.000', '2.5000', '12.50'],
    ]);
    // As duas pernas são do mesmo item do acerto.
    expect(new Set(movs.map((m) => m.documento_item_id)).size).toBe(1);
    expect(await linha(prod, disponivel)).toEqual({ q: '15.000', cm: '2.5000' });
    // (5 × 4,00 + 5 × 2,50) / 10.
    expect(await linha(prod, avaria)).toEqual({ q: '10.000', cm: '3.2500' });
    expect(await valorEmEstoque(prod)).toBe('70.00');
    await recalcularIdentico();

    await estornar(id);
    // O par invertido, na ordem do lançamento: o destino sai primeiro, ao custo da entrada, e a origem recebe esse custo.
    const estornos = (await movimentosDoDocumento(id)).filter((m) => m.estorno_de_id);
    expect(
      estornos.map((m) => [
        m.tipo_movimento,
        m.tipo_estoque_id,
        m.quantidade,
        m.custo_unitario,
        m.custo_total,
      ]),
    ).toEqual([
      ['MUDANCA_TIPO_ESTOQUE', avaria, '-5.000', '2.5000', '12.50'],
      ['MUDANCA_TIPO_ESTOQUE', disponivel, '5.000', '2.5000', '12.50'],
    ]);
    // Os dois voltam ao de antes: a Avaria tira o que a entrada pôs, (10 × 3,25 − 5 × 2,50) / 5 = 4,00.
    expect(await linha(prod, disponivel)).toEqual({ q: '20.000', cm: '2.5000' });
    expect(await linha(prod, avaria)).toEqual({ q: '5.000', cm: '4.0000' });
    expect(await valorEmEstoque(prod)).toBe('70.00');
    await recalcularIdentico();
  });

  it('o estorno com outro movimento no destino no meio: as duas pernas ao mesmo custo, e o valor do estoque a custo segue igual', async () => {
    // Entrada no destino no meio: a conta inversa tira só o que a mudança pôs, e a Avaria fica com o médio da entrada.
    const comEntrada = await criarProduto('CERV MUDANCA ENTRADA NO MEIO');
    await entrada(comEntrada, '20', '2.5');
    const m1 = await mudanca([{ produtoId: comEntrada, quantidade: '5' }]);
    expect(m1.r.status, JSON.stringify(m1.r.body)).toBe(200);
    await entrada(comEntrada, '5', '4', avaria);
    expect(await linha(comEntrada, avaria)).toEqual({ q: '10.000', cm: '3.2500' });
    expect(await valorEmEstoque(comEntrada)).toBe('70.00');
    await estornar(m1.id);
    expect(await linha(comEntrada, disponivel)).toEqual({ q: '20.000', cm: '2.5000' });
    expect(await linha(comEntrada, avaria)).toEqual({ q: '5.000', cm: '4.0000' });
    expect(await valorEmEstoque(comEntrada)).toBe('70.00');

    // O destino zerado no meio (a Avaria baixada): nada sobra para a conta inversa, a perna do destino sai ao médio
    // vigente e a origem recebe esse mesmo custo. A Avaria fica negativa (Master), e o valor não muda.
    const zerado = await criarProduto('CERV MUDANCA DESTINO ZERADO');
    await entrada(zerado, '10', '2');
    await entrada(zerado, '10', '3');
    await entrada(zerado, '5', '4', avaria);
    const m2 = await mudanca([{ produtoId: zerado, quantidade: '5' }]);
    expect(m2.r.status, JSON.stringify(m2.r.body)).toBe(200);
    await acerto({ tipoAjuste: 'saida', tipoEstoqueId: avaria }, [{ produtoId: zerado, quantidade: '10' }]);
    expect(await linha(zerado, avaria)).toEqual({ q: '0.000', cm: '3.2500' });
    const antes = await valorEmEstoque(zerado);
    expect(antes).toBe('37.50');
    await estornar(m2.id);
    const estornos = (await movimentosDoDocumento(m2.id)).filter((m) => m.estorno_de_id);
    expect(estornos.map((m) => [m.tipo_estoque_id, m.quantidade, m.custo_unitario])).toEqual([
      [avaria, '-5.000', '3.2500'],
      [disponivel, '5.000', '3.2500'],
    ]);
    // (15 × 2,50 + 5 × 3,25) / 20 = 2,6875.
    expect(await linha(zerado, disponivel)).toEqual({ q: '20.000', cm: '2.6875' });
    expect(await linha(zerado, avaria)).toEqual({ q: '-5.000', cm: '3.2500' });
    expect(await valorEmEstoque(zerado)).toBe(antes);
    await recalcularIdentico();
  });

  it('o fluxo estoque do PDV vê o Disponível cair na hora e nunca traz a linha da Avaria (não vendável)', async () => {
    const prod = await criarProduto('CERV MUDANCA PDV');
    await entrada(prod, '20', '2');
    const token = await ativarTerminal();
    const doProduto = (alt: Alteracao[]) =>
      alt
        .filter((a) => a.tabela === 'saldos_estoque' && a.linha.produto_id === prod)
        .map((a) => [a.linha.tipo_estoque_id, Number(a.linha.quantidade)]);
    const carga = await puxarEstoque(token, 0);
    expect(doProduto(carga.alteracoes)).toEqual([[disponivel, 20]]);

    const { r } = await mudanca([{ produtoId: prod, quantidade: '5' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(doProduto((await puxarEstoque(token, carga.cursor)).alteracoes)).toEqual([[disponivel, 15]]);
    // Nem a carga inicial de um PDV novo traz a Avaria.
    expect(doProduto((await puxarEstoque(token, 0)).alteracoes)).toEqual([[disponivel, 15]]);
    await recalcularIdentico();
  });

  it('o lote acompanha: a perna de saída sem lote em FEFO, a de entrada com o mesmo lote, e o lote informado; o estorno volta aos lotes', async () => {
    const prod = await criarProduto('CERV MUDANCA LOTE');
    const a = await criarLote(prod, 'MA-2612', '2026-12-01');
    const b = await criarLote(prod, 'MB-2701', '2027-01-10');
    await entrada(prod, '3', '2', disponivel, a);
    await entrada(prod, '4', '2', disponivel, b);

    const semLote = await mudanca([{ produtoId: prod, quantidade: '5' }]);
    expect(semLote.r.status, JSON.stringify(semLote.r.body)).toBe(200);
    const movs = await movimentosDoDocumento(semLote.id);
    expect(movs.map((m) => [m.tipo_estoque_id, m.lote_id, m.quantidade])).toEqual([
      [disponivel, a, '-3.000'],
      [disponivel, b, '-2.000'],
      [avaria, a, '3.000'],
      [avaria, b, '2.000'],
    ]);
    expect(await lotes(prod, disponivel)).toEqual({ [a]: '0.000', [b]: '2.000' });
    expect(await lotes(prod, avaria)).toEqual({ [a]: '3.000', [b]: '2.000' });

    // O lote informado: sai dele e entra nele, mesmo com outro lote vencendo antes.
    const comLote = await mudanca([{ produtoId: prod, quantidade: '1', loteId: b }], avaria, vencido);
    expect(comLote.r.status, JSON.stringify(comLote.r.body)).toBe(200);
    expect(await lotes(prod, avaria)).toEqual({ [a]: '3.000', [b]: '1.000' });
    expect(await lotes(prod, vencido)).toEqual({ [b]: '1.000' });

    await estornar(semLote.id);
    expect(await lotes(prod, disponivel)).toEqual({ [a]: '3.000', [b]: '4.000' });
    expect(await lotes(prod, avaria)).toEqual({ [a]: '0.000', [b]: '-1.000' });
    await recalcularIdentico();
  });

  it('saldo insuficiente na origem: recusado sem a permissão de saldo negativo (também no lote); o Master passa', async () => {
    const prod = await criarProduto('CERV MUDANCA NEGATIVO');
    const l = await criarLote(prod, 'MN-01', '2026-12-01');
    await entrada(prod, '2', '2', disponivel, l);
    await entrada(prod, '1', '2');
    const negado = await mudanca([{ produtoId: prod, quantidade: '4' }], disponivel, avaria, tokenEstoquista);
    expect(negado.r.status, JSON.stringify(negado.r.body)).toBe(422);
    expect(negado.r.body.campos).toEqual({
      'itens.0.quantidade': ['Saldo insuficiente de CERV MUDANCA NEGATIVO: 3 UN'],
    });
    const doLote = await mudanca(
      [{ produtoId: prod, quantidade: '3', loteId: l }],
      disponivel,
      avaria,
      tokenEstoquista,
    );
    expect(doLote.r.status, JSON.stringify(doLote.r.body)).toBe(422);
    expect(doLote.r.body.campos).toEqual({
      'itens.0.quantidade': ['Saldo insuficiente do lote de CERV MUDANCA NEGATIVO: 2 UN'],
    });
    expect([await linha(prod, disponivel), await linha(prod, avaria)]).toEqual([
      { q: '3.000', cm: '2.0000' },
      { q: '0.000', cm: '0.0000' },
    ]);
    expect(await movimentosDoDocumento(negado.id)).toEqual([]);

    const master = await mudanca([{ produtoId: prod, quantidade: '4' }]);
    expect(master.r.status, JSON.stringify(master.r.body)).toBe(200);
    expect([(await linha(prod, disponivel)).q, (await linha(prod, avaria)).q]).toEqual(['-1.000', '4.000']);
    await recalcularIdentico();
  });

  it('cabeçalho: destino obrigatório, diferente da origem (inclusive pelo padrão), ativo e só na mudança de tipo; o banco confere o mesmo', async () => {
    const prod = await criarProduto('CERV MUDANCA CABECALHO');
    const item = [{ produtoId: prod, quantidade: '1' }];
    const semDestino = await tentarAcerto({ tipoAjuste: 'mudanca_tipo', tipoEstoqueId: disponivel }, item);
    expect(semDestino.status).toBe(422);
    expect(semDestino.body.campos).toEqual({ tipoEstoqueDestinoId: ['Escolha o tipo de destino'] });
    const igual = await tentarAcerto(
      { tipoAjuste: 'mudanca_tipo', tipoEstoqueId: avaria, tipoEstoqueDestinoId: avaria },
      item,
    );
    expect(igual.status).toBe(422);
    expect(igual.body.campos).toEqual({
      tipoEstoqueDestinoId: ['O tipo de destino tem de ser diferente do de origem'],
    });
    // Origem vazia = o padrão (Disponível): só a API, depois de resolver, vê que é o mesmo tipo.
    const pelaPadrao = await tentarAcerto(
      { tipoAjuste: 'mudanca_tipo', tipoEstoqueId: null, tipoEstoqueDestinoId: disponivel },
      item,
    );
    expect(pelaPadrao.status).toBe(422);
    expect(pelaPadrao.body.campos).toEqual({
      tipoEstoqueDestinoId: ['O tipo de destino tem de ser diferente do de origem'],
    });
    const naEntrada = await tentarAcerto({ tipoAjuste: 'entrada', tipoEstoqueDestinoId: avaria }, item);
    expect(naEntrada.status).toBe(422);
    expect(naEntrada.body.campos).toEqual({
      tipoEstoqueDestinoId: ['O tipo de destino só vale na mudança de tipo'],
    });

    // Um tipo da empresa, destino de um rascunho: não se inativa enquanto o rascunho existir.
    const quebra = await amb.http().post('/api/tipos-estoque').set(bearer()).send({ nome: 'Quebra' });
    expect(quebra.status, JSON.stringify(quebra.body)).toBe(201);
    const rascunho = await tentarAcerto(
      { tipoAjuste: 'mudanca_tipo', tipoEstoqueId: disponivel, tipoEstoqueDestinoId: quebra.body.id },
      item,
    );
    expect(rascunho.status, JSON.stringify(rascunho.body)).toBe(201);
    const inativar = await amb
      .http()
      .put(`/api/tipos-estoque/${quebra.body.id}`)
      .set(bearer())
      .send({ nome: 'Quebra', vendavel: false, padrao: false, ativo: false, versao: quebra.body.versao });
    expect(inativar.status, JSON.stringify(inativar.body)).toBe(422);
    expect(inativar.body.campos).toEqual({ ativo: ['Há 1 acerto(s) em rascunho neste tipo'] });
    // Nem se exclui: o acerto aponta para ele.
    const excluir = await amb.http().delete(`/api/tipos-estoque/${quebra.body.id}`).set(bearer());
    expect(excluir.status, JSON.stringify(excluir.body)).toBe(422);
    // Inativo antes do rascunho: o destino inativo é recusado.
    const [{ id: inativo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into tipos_estoque (nome, vendavel, padrao, ativo) values ('Doação', false, false, false) returning id",
    )) as [{ id: string }];
    const destinoInativo = await tentarAcerto(
      { tipoAjuste: 'mudanca_tipo', tipoEstoqueId: disponivel, tipoEstoqueDestinoId: inativo },
      item,
    );
    expect(destinoInativo.status).toBe(422);
    expect(destinoInativo.body.campos).toEqual({
      tipoEstoqueDestinoId: ['Tipo de estoque inexistente ou inativo'],
    });

    // O banco: a mudança sem destino, o destino fora dela e o destino igual à origem violam o check.
    for (const [tipoAjuste, destino] of [
      ['mudanca_tipo', null],
      ['entrada', avaria],
      ['mudanca_tipo', disponivel],
    ] as const) {
      await expect(
        consultar(
          emp.nomeBanco,
          `update acertos_estoque set tipo_ajuste = $1, tipo_estoque_destino_id = $2 where id = $3`,
          [tipoAjuste, destino, rascunho.body.id],
        ),
      ).rejects.toThrow(/ck_acertos_estoque_mudanca_tipo/);
    }
    await recalcularIdentico();
  });

  it('destino inativo na efetivação e no estorno: recusado no campo tipoEstoqueDestinoId; reativado, passa', async () => {
    const prod = await criarProduto('CERV MUDANCA DESTINO INATIVO');
    await entrada(prod, '10', '2');
    const criado = await amb.http().post('/api/tipos-estoque').set(bearer()).send({ nome: 'Descarte' });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const descarte = criado.body.id as string;
    const tipoAtivo = (ativo: boolean) =>
      consultar(emp.nomeBanco, 'update tipos_estoque set ativo = $1 where id = $2', [ativo, descarte]);

    // Efetivação: pela API o tipo de um rascunho não se inativa (teste acima); por fora, a efetivação ainda confere.
    const rascunho = await tentarAcerto(
      { tipoAjuste: 'mudanca_tipo', tipoEstoqueId: disponivel, tipoEstoqueDestinoId: descarte },
      [{ produtoId: prod, quantidade: '4' }],
    );
    expect(rascunho.status, JSON.stringify(rascunho.body)).toBe(201);
    await tipoAtivo(false);
    const efetivar = () =>
      amb
        .http()
        .post(`/api/acertos/${rascunho.body.id}/efetivar`)
        .set(bearer())
        .send({ versao: rascunho.body.versao });
    const recusada = await efetivar();
    expect(recusada.status, JSON.stringify(recusada.body)).toBe(422);
    expect(recusada.body.campos).toEqual({
      tipoEstoqueDestinoId: [
        'O tipo de estoque "Descarte" está inativo: troque o tipo do rascunho ou reative o tipo antes de efetivar',
      ],
    });
    expect(await movimentosDoDocumento(rascunho.body.id)).toEqual([]);
    await tipoAtivo(true);
    const efetivada = await efetivar();
    expect(efetivada.status, JSON.stringify(efetivada.body)).toBe(200);

    // Estorno: outra mudança devolve os 4 e zera o Descarte, que então se inativa pela API (saldo zero, sem rascunho).
    const devolve = await mudanca([{ produtoId: prod, quantidade: '4' }], descarte, disponivel);
    expect(devolve.r.status, JSON.stringify(devolve.r.body)).toBe(200);
    const atual = await amb.http().get(`/api/tipos-estoque/${descarte}`).set(bearer());
    expect(atual.status, JSON.stringify(atual.body)).toBe(200);
    const inativar = await amb
      .http()
      .put(`/api/tipos-estoque/${descarte}`)
      .set(bearer())
      .send({ nome: 'Descarte', vendavel: false, padrao: false, ativo: false, versao: atual.body.versao });
    expect(inativar.status, JSON.stringify(inativar.body)).toBe(200);
    const versao = (await amb.http().get(`/api/acertos/${rascunho.body.id}`).set(bearer())).body.versao;
    const estorno = await amb
      .http()
      .post(`/api/acertos/${rascunho.body.id}/estornar`)
      .set(bearer())
      .send({ versao, motivo: 'Descarte lançado no produto errado' });
    expect(estorno.status, JSON.stringify(estorno.body)).toBe(422);
    expect(estorno.body.campos).toEqual({
      tipoEstoqueDestinoId: ['O tipo de estoque "Descarte" está inativo: reative o tipo antes de estornar'],
    });
    expect((await movimentosDoDocumento(rascunho.body.id)).filter((m) => m.estorno_de_id)).toEqual([]);
    await tipoAtivo(true);
    await estornar(rascunho.body.id);
    expect([(await linha(prod, disponivel)).q, (await linha(prod, descarte)).q]).toEqual([
      '14.000',
      '-4.000',
    ]);
    await recalcularIdentico();
  });

  it('mudanças em sentidos opostos no mesmo produto, em paralelo, 20 vezes: as duas efetivam, sem deadlock (sob a 7300001)', async () => {
    const prod = await criarProduto('CERV MUDANCA CONCORRENTE');
    await entrada(prod, '100', '2');
    await entrada(prod, '100', '2', avaria);
    for (let i = 0; i < 20; i++) {
      const rs = await Promise.all([
        mudanca([{ produtoId: prod, quantidade: '1' }], disponivel, avaria),
        mudanca([{ produtoId: prod, quantidade: '2' }], avaria, disponivel),
      ]);
      expect(
        rs.map((x) => x.r.status),
        JSON.stringify(rs.map((x) => x.r.body)),
      ).toEqual([200, 200]);
    }
    expect([(await linha(prod, disponivel)).q, (await linha(prod, avaria)).q]).toEqual(['120.000', '80.000']);
    await recalcularIdentico();
  }, 120_000);

  it('efetivado, o destino não muda mais (DOCUMENTO_IMUTAVEL); a efetivação repetida não lança de novo e o índice recusa a perna repetida', async () => {
    const prod = await criarProduto('CERV MUDANCA IDEMPOTENTE');
    await entrada(prod, '10', '2');
    const a = await tentarAcerto(
      { tipoAjuste: 'mudanca_tipo', tipoEstoqueId: disponivel, tipoEstoqueDestinoId: avaria },
      [{ produtoId: prod, quantidade: '3' }],
    );
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    // As duas requisições com a mesma versão (o duplo clique, o reenvio do navegador): uma efetiva, a outra não.
    const [r1, r2] = await Promise.all(
      [1, 2].map(() =>
        amb.http().post(`/api/acertos/${a.body.id}/efetivar`).set(bearer()).send({ versao: a.body.versao }),
      ),
    );
    expect([r1!.status, r2!.status].sort()).toEqual([200, 409]);
    const repetido = await amb
      .http()
      .post(`/api/acertos/${a.body.id}/efetivar`)
      .set(bearer())
      .send({ versao: (r1!.status === 200 ? r1 : r2)!.body.versao });
    expect(repetido.status, JSON.stringify(repetido.body)).toBe(422);
    const movs = await movimentosDoDocumento(a.body.id);
    expect(movs).toHaveLength(2);
    expect([(await linha(prod, disponivel)).q, (await linha(prod, avaria)).q]).toEqual(['7.000', '3.000']);

    await expect(
      consultar(emp.nomeBanco, 'update acertos_estoque set tipo_estoque_destino_id = $1 where id = $2', [
        vencido,
        a.body.id,
      ]),
    ).rejects.toThrow(/DOCUMENTO_IMUTAVEL/);

    // A segunda barreira: a mesma perna de entrada (mesmo item, tipo, lote e tipo de movimento) no motor.
    const entradaRepetida = movs.find((m) => m.tipo_estoque_id === avaria)!;
    await dona.query('begin');
    try {
      await dona.query('select fn_trava_versao()');
      await expect(
        lancarDocumento(drizzle(dona) as unknown as DbEmpresa, [
          {
            estoqueId: estoqueLoja,
            produtoId: prod,
            variacaoId: null,
            tipoEstoqueId: avaria,
            tipoMovimento: 'MUDANCA_TIPO_ESTOQUE',
            quantidade: '3',
            custoUnitario: '2',
            custoReferencia: '2',
            precoVenda: null,
            dataMovimento: new Date(),
            lojaId: loja,
            usuarioId: null,
            documentoTipo: 'acerto',
            documentoId: a.body.id,
            documentoItemId: entradaRepetida.documento_item_id,
          },
        ]),
      ).rejects.toMatchObject({ cause: { constraint: 'uq_movimentos_estoque_idempotencia' } });
    } finally {
      await dona.query('rollback');
    }
    expect(await movimentosDoDocumento(a.body.id)).toHaveLength(2);
    await recalcularIdentico();
  });
});
