/**
 * Relatório Movimentação de Estoque, visão analítica (Fase 2, F2-B32; ERP 16.5; MD 3.7.1–3.7.3; README da API ›
 * decisão 179), pela API do ERP: um movimento por linha de um local num período, na ordem `(data_movimento, id)`,
 * paginado por cursor (inclusive com vários movimentos no mesmo instante); o saldo anterior e o posterior recalculados
 * na ordem da data, que fecham com `saldos_estoque` e diferem do gravado quando o "Definir" tem a hora da contagem no
 * passado; o saldo de antes do período; os filtros (produto, tipos, usuário, documento com o número, pessoa) sem mudar
 * o saldo da linha; as colunas do Nuvem3 (`id_nuvem3`, fornecedor, documento); o custo só com `produtos.ver_custo`; os
 * estoques permitidos; e a validação (período de até 366 dias, cursor, tipos). O razão refaz as projeções idênticas
 * no fim (`conferirRazaoDoBanco`).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  completarCnpj,
  CONTRATOS_EVENTOS,
  jcs,
  type Ativar,
  type LinhaMovimentacaoEstoque,
  type RespostaMovimentacaoEstoque,
  type TipoMovimentoEstoqueOpcao,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
let loja1: string;
let estoque1: string;
let estoque2: string;
let disponivel: string;
let un: string;
let admin: string;
let fornecedor: string;
let tokenAdmin: string;
/** Estoquista da Loja 1 (só o estoque dela), sem `produtos.ver_custo`. */
let tokenEstoquista: string;
/** Sem `relatorios.movimentacao_estoque`. */
let tokenVendedor: string;

/** Produto A da Loja 1: Definir 20 há 10 dias, Definir 15 com a contagem antes das três seguintes, +10, +5, −3. */
let produtoA: string;
let recebimentoA: { id: string; codigo: number };
let definirRetroativo: string;
/** 25 produtos num acerto só: 25 movimentos com o mesmo `data_movimento` (o desempate do cursor pelo id). */
const lote: string[] = [];

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const agora = () => new Date().toISOString();
const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
/** Hoje − `dias` no fuso de Brasília (`AAAA-MM-DD`), o da empresa de teste. */
const diaLocal = (dias = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    new Date(Date.now() - dias * 86_400_000),
  );
const periodo = (dias = 11) => ({ estoqueId: estoque1, dataInicial: diaLocal(dias), dataFinal: diaLocal() });

const pedir = (query: Record<string, string>, tk = tokenAdmin) =>
  amb.http().get('/api/relatorios/movimentacao-estoque').query(query).set(bearer(tk));

async function pagina(query: Record<string, string>, tk = tokenAdmin): Promise<RespostaMovimentacaoEstoque> {
  const r = await pedir(query, tk);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RespostaMovimentacaoEstoque;
}

/** Todas as páginas, seguindo o `proximoCursor`. */
async function todas(query: Record<string, string>, tamanho = '20', tk = tokenAdmin) {
  const itens: LinhaMovimentacaoEstoque[] = [];
  let cursor: string | null = null;
  let paginas = 0;
  do {
    const r = await pagina({ ...query, tamanho, ...(cursor ? { cursor } : {}) }, tk);
    expect(r.itens.length).toBeLessThanOrEqual(Number(tamanho));
    itens.push(...r.itens);
    cursor = r.proximoCursor;
    paginas++;
    if (cursor) expect(r.itens).toHaveLength(Number(tamanho));
  } while (cursor && paginas < 100);
  return { itens, paginas };
}

async function criarProduto(nome: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '10', precoCusto: '4' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** Cria e efetiva um acerto; devolve o id. */
async function acerto(corpo: Record<string, unknown>): Promise<string> {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({ estoqueId: estoque1, motivo: 'Teste da movimentação', dataContagem: agora(), ...corpo });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const ef = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: a.body.versao });
  expect(ef.status, JSON.stringify(ef.body)).toBe(200);
  return a.body.id as string;
}

const chaveLinha = (l: LinhaMovimentacaoEstoque) => `${l.produtoId}|${l.variacaoId ?? ''}|${l.tipoEstoqueId}`;

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  const loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  const estoqueDa = async (loja: string) =>
    (
      (await consultar<{ estoque_id: string }>(emp.nomeBanco, 'select estoque_id from lojas where id = $1', [
        loja,
      ])) as [{ estoque_id: string }]
    )[0].estoque_id;
  estoque1 = await estoqueDa(loja1);
  estoque2 = await estoqueDa(loja2);
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [estoque1],
  });
  tokenEstoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja1] });
  tokenVendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  [{ id: disponivel }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from tipos_estoque where chave_sistema = 'disponivel'",
  )) as [{ id: string }];
  [{ id: admin }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  const f = await amb
    .http()
    .post('/api/pessoas/fornecedor-rapido')
    .set(bearer())
    .send({ cpfCnpj: completarCnpj('112223330001'), nome: 'Distribuidora Movimentação Ltda' });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  fornecedor = f.body.pessoa.id as string;

  // Produto A na Loja 1. A contagem do segundo "Definir" é anterior às três entradas/saídas de agora, mas ele é
  // lançado depois delas: na ordem da data ele vem antes, e o saldo gravado (na ordem de lançamento) difere.
  produtoA = await criarProduto('CERVEJA MOVIMENTACAO A');
  await acerto({
    tipoAjuste: 'definir',
    dataContagem: diasAtras(10),
    itens: [{ produtoId: produtoA, quantidade: '20' }],
  });
  const contagem = agora();
  await new Promise((r) => setTimeout(r, 20));
  await acerto({
    tipoAjuste: 'entrada',
    itens: [{ produtoId: produtoA, quantidade: '10', custoUnitario: '4' }],
  });
  const rec = await amb
    .http()
    .post('/api/recebimentos')
    .set(bearer())
    .send({
      lojaId: loja1,
      fornecedorId: fornecedor,
      dataRecebimento: diaLocal(),
      itens: [{ produtoId: produtoA, fator: '1', quantidade: '5', precoCompra: '6' }],
    });
  expect(rec.status, JSON.stringify(rec.body)).toBe(201);
  recebimentoA = { id: rec.body.id as string, codigo: rec.body.codigo as number };
  const mov = await amb
    .http()
    .post(`/api/recebimentos/${recebimentoA.id}/movimentar`)
    .set(bearer())
    .send({ atualizarPrecoCusto: false });
  expect(mov.status, JSON.stringify(mov.body)).toBe(200);
  await acerto({ tipoAjuste: 'saida', itens: [{ produtoId: produtoA, quantidade: '3' }] });
  definirRetroativo = await acerto({
    tipoAjuste: 'definir',
    dataContagem: contagem,
    itens: [{ produtoId: produtoA, quantidade: '15' }],
  });

  // 25 produtos num acerto de entrada só (o mesmo instante) e o produto A na Loja 2 (fora do estoquista).
  for (let i = 0; i < 25; i++)
    lote.push(await criarProduto(`REFRIGERANTE LOTE ${String(i).padStart(2, '0')}`));
  await acerto({
    tipoAjuste: 'entrada',
    itens: lote.map((p, i) => ({ produtoId: p, quantidade: String(i + 1), custoUnitario: '2' })),
  });
  await acerto({
    estoqueId: estoque2,
    tipoAjuste: 'entrada',
    itens: [{ produtoId: produtoA, quantidade: '7', custoUnitario: '4' }],
  });
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

// ---------------------------------------------------------------- Testes

describe('Movimentação analítica: ordem, cursor e saldo recalculado (ERP 16.5)', () => {
  it('pagina pelo cursor na ordem (data_movimento, id), sem repetir nem pular, com o mesmo instante no meio', async () => {
    const { itens, paginas } = await todas(periodo(), '20');
    // 2 Definir + 1 entrada + 1 recebimento + 1 saída do A e as 25 do lote.
    expect(itens).toHaveLength(30);
    expect(paginas).toBe(2);
    expect(new Set(itens.map((l) => l.id)).size).toBe(30);
    const chaves = itens.map((l) => `${l.dataMovimento}|${l.id}`);
    expect([...chaves].sort()).toEqual(chaves);
    // As 25 do lote têm o mesmo instante e atravessam a página: o id desempata.
    const doLote = itens.filter((l) => lote.includes(l.produtoId));
    expect(new Set(doLote.map((l) => l.dataMovimento)).size).toBe(1);
    // Com o banco: os mesmos movimentos do local no período.
    const [{ n }] = (await consultar<{ n: string }>(
      emp.nomeBanco,
      'select count(*)::text as n from movimentos_estoque where estoque_id = $1',
      [estoque1],
    )) as [{ n: string }];
    expect(Number(n)).toBe(30);
    // A última página: sem próximo cursor; tamanho 50 cabe numa página só.
    const uma = await pagina({ ...periodo(), tamanho: '50' });
    expect(uma.itens.map((l) => l.id)).toEqual(itens.map((l) => l.id));
    expect(uma.proximoCursor).toBeNull();
    expect(uma.referencias.estoque).toEqual({ id: estoque1, nome: 'Estoque Loja 1 - Centro' });
  });

  it('o saldo da janela fecha com saldos_estoque e encadeia na ordem da data (o gravado segue o lançamento)', async () => {
    const { itens } = await todas(periodo(), '20');
    const ultimo = new Map<string, LinhaMovimentacaoEstoque>();
    for (const l of itens) {
      expect(Number(l.saldoPosterior)).toBeCloseTo(Number(l.saldoAnterior) + Number(l.quantidade), 3);
      const antes = ultimo.get(chaveLinha(l));
      // O primeiro movimento de cada linha começa do zero (o período pega a história inteira).
      expect(l.saldoAnterior).toBe(antes ? antes.saldoPosterior : '0.000');
      ultimo.set(chaveLinha(l), l);
    }
    const saldos = await consultar<{
      produto_id: string;
      variacao_id: string | null;
      tipo_estoque_id: string;
      quantidade: string;
    }>(
      emp.nomeBanco,
      'select produto_id, variacao_id, tipo_estoque_id, quantidade::text from saldos_estoque where estoque_id = $1',
      [estoque1],
    );
    expect(saldos).toHaveLength(26);
    for (const s of saldos)
      expect(ultimo.get(`${s.produto_id}|${s.variacao_id ?? ''}|${s.tipo_estoque_id}`)?.saldoPosterior).toBe(
        s.quantidade,
      );

    // Produto A na ordem da data: Definir 20 (há 10 dias), Definir na contagem (antes das três), +10, +5, −3.
    const a = itens.filter((l) => l.produtoId === produtoA);
    expect(a.map((l) => l.tipoMovimento)).toEqual([
      'ACERTO_DEFINIR',
      'ACERTO_DEFINIR',
      'ACERTO_ENTRADA',
      'RECEB_MANUAL',
      'ACERTO_SAIDA',
    ]);
    expect(a.map((l) => [l.saldoAnterior, l.saldoPosterior])).toEqual([
      ['0.000', '20.000'],
      ['20.000', '15.000'],
      ['15.000', '25.000'],
      ['25.000', '30.000'],
      ['30.000', '27.000'],
    ]);
    expect(a.at(-1)!.saldoPosterior).toBe(
      saldos.find((s) => s.produto_id === produtoA && s.tipo_estoque_id === disponivel)!.quantidade,
    );
    // O "Definir" foi lançado por último (sobre os 32 de então): o gravado difere do recalculado.
    const retro = a[1]!;
    expect(retro.documento).toMatchObject({ tipo: 'acerto', id: definirRetroativo });
    expect([retro.saldoAnteriorGravado, retro.saldoPosteriorGravado]).toEqual(['32.000', '27.000']);
    expect(a[2]!.saldoAnteriorGravado).toBe('20.000');
  });

  it('o período começa do saldo de antes dele; o lote na segunda página parte do zero', async () => {
    // Sem o primeiro Definir (há 10 dias): o primeiro movimento do A no período parte dos 20 de antes.
    const r = await todas({ ...periodo(1), produtoId: produtoA }, '20');
    expect(r.itens.map((l) => [l.saldoAnterior, l.saldoPosterior])).toEqual([
      ['20.000', '15.000'],
      ['15.000', '25.000'],
      ['25.000', '30.000'],
      ['30.000', '27.000'],
    ]);
    expect(r.itens.every((l) => l.produtoId === produtoA)).toBe(true);
    // Com tamanho 20, cada linha do lote tem um movimento só: o saldo anterior dele é 0 em qualquer página. A linha
    // de saldo que atravessa a página está no teste da Loja 3 (venda offline, compensação e recebimento).
    const p1 = await pagina({ ...periodo(), tamanho: '20' });
    const p2 = await pagina({ ...periodo(), tamanho: '20', cursor: p1.proximoCursor! });
    expect(p2.itens).toHaveLength(10);
    expect(p2.itens.filter((l) => lote.includes(l.produtoId)).every((l) => l.saldoAnterior === '0.000')).toBe(
      true,
    );
  });
});

describe('Movimentação analítica: filtros e colunas', () => {
  it('tipos de movimento e documento com número: o saldo continua o da linha de saldo (não o do filtro)', async () => {
    const receb = await pagina({ ...periodo(), tiposMovimento: 'RECEB_MANUAL' });
    expect(receb.itens).toHaveLength(1);
    const l = receb.itens[0]!;
    expect(l).toMatchObject({
      produtoId: produtoA,
      tipoMovimento: 'RECEB_MANUAL',
      saldoAnterior: '25.000',
      quantidade: '5.000',
      saldoPosterior: '30.000',
      fornecedor: 'Distribuidora Movimentação Ltda',
      pessoaVenda: null,
      documento: { tipo: 'recebimento', id: recebimentoA.id, numero: String(recebimentoA.codigo) },
      custoUnitario: '6.0000',
      custoTotal: '30.00',
      lojaNome: 'Loja 1 - Centro',
      estoqueNome: 'Estoque Loja 1 - Centro',
      tipoEstoqueNome: expect.any(String),
      usuarioNome: expect.any(String),
      sigla: 'UN',
      unidadeBase: 'UN',
      fator: '1.000',
      idNuvem3: null,
    });
    // A multisseleção, em vírgulas ou repetida na query.
    const dois = await pagina({ ...periodo(), tiposMovimento: 'RECEB_MANUAL,ACERTO_SAIDA' });
    expect(dois.itens.map((x) => x.tipoMovimento)).toEqual(['RECEB_MANUAL', 'ACERTO_SAIDA']);
    const repetida = await amb
      .http()
      .get(
        `/api/relatorios/movimentacao-estoque?estoqueId=${estoque1}&dataInicial=${diaLocal(11)}&dataFinal=${diaLocal()}&tiposMovimento=RECEB_MANUAL&tiposMovimento=ACERTO_SAIDA`,
      )
      .set(bearer());
    expect(repetida.status, JSON.stringify(repetida.body)).toBe(200);
    expect((repetida.body as RespostaMovimentacaoEstoque).itens).toHaveLength(2);
    expect(dois.itens[1]!.saldoAnterior).toBe('30.000');

    const doc = await pagina({
      ...periodo(),
      documentoTipo: 'recebimento',
      documentoNumero: String(recebimentoA.codigo),
    });
    expect(doc.itens.map((x) => x.id)).toEqual([l.id]);
    expect(
      (await pagina({ ...periodo(), documentoTipo: 'recebimento', documentoNumero: '999999' })).itens,
    ).toEqual([]);
    // O número que não é inteiro não acha documento de código numérico (sem erro do banco).
    expect((await pagina({ ...periodo(), documentoTipo: 'acerto', documentoNumero: 'ABC' })).itens).toEqual(
      [],
    );
    const acertos = await pagina({ ...periodo(), documentoTipo: 'acerto', tamanho: '50' });
    expect(acertos.itens).toHaveLength(29);
    // O filtro esconde o recebimento (+5) entre a entrada e a saída do A: a saída parte dos 30 da linha de saldo (a
    // parte do razão entre dois movimentos da página inclui o escondido), não dos 25 do filtro.
    expect(
      acertos.itens.filter((x) => x.produtoId === produtoA).map((x) => [x.saldoAnterior, x.saldoPosterior]),
    ).toEqual([
      ['0.000', '20.000'],
      ['20.000', '15.000'],
      ['15.000', '25.000'],
      ['30.000', '27.000'],
    ]);
    const [{ codigo }] = (await consultar<{ codigo: number }>(
      emp.nomeBanco,
      'select codigo from acertos_estoque where id = $1',
      [definirRetroativo],
    )) as [{ codigo: number }];
    const umAcerto = await pagina({ ...periodo(), documentoTipo: 'acerto', documentoNumero: String(codigo) });
    expect(umAcerto.itens.map((x) => [x.documento.numero, x.saldoAnterior])).toEqual([
      [String(codigo), '20.000'],
    ]);
  });

  it('pessoa, usuário e produto; os nomes escolhidos voltam nas referências', async () => {
    const pessoa = await pagina({ ...periodo(), pessoaId: fornecedor });
    expect(pessoa.itens.map((x) => x.tipoMovimento)).toEqual(['RECEB_MANUAL']);
    expect(pessoa.referencias.pessoa).toMatchObject({
      id: fornecedor,
      nome: 'Distribuidora Movimentação Ltda',
    });
    expect((await pagina({ ...periodo(), usuarioId: admin, tamanho: '50' })).itens).toHaveLength(30);
    const [{ id: outro }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'estoquista'",
    )) as [{ id: string }];
    expect((await pagina({ ...periodo(), usuarioId: outro })).itens).toEqual([]);
    const prod = await pagina({ ...periodo(), produtoId: lote[3]! });
    expect(prod.itens).toHaveLength(1);
    expect(prod.itens[0]).toMatchObject({
      quantidade: '4.000',
      saldoAnterior: '0.000',
      saldoPosterior: '4.000',
    });
    expect(prod.referencias.produto).toMatchObject({ id: lote[3], nome: 'REFRIGERANTE LOTE 03' });
  });

  it('id_nuvem3 dos tipos de movimento (o 28 da transferência) na referência da multisseleção', async () => {
    const r = await amb.http().get('/api/referencias/tipos-movimento-estoque').set(bearer(tokenEstoquista));
    expect(r.status).toBe(200);
    const tipos = r.body as TipoMovimentoEstoqueOpcao[];
    expect(tipos.find((t) => t.codigo === 'TRANSF_SAIDA')).toMatchObject({ idNuvem3: 28, sinal: -1 });
    expect(tipos.find((t) => t.codigo === 'RECEB_NFE')).toMatchObject({ idNuvem3: null, sinal: 1 });
  });
});

// ---------------------------------------------------------------- Loja 3: venda pelo PDV, compensação e página

/**
 * A Loja 3 (estoque próprio, sem mexer nas contas das outras): o "Definir" 10 do produto V com a contagem há 2 h; a
 * venda offline de 2 V ao cliente, de há 3 h (antes da contagem), que chega depois de efetivar — o motor lança o
 * `ACERTO_COMPENSACAO` com a pessoa da venda —; as 25 entradas do lote (o mesmo instante) e, por último, o recebimento
 * de 2 V com fator 12 (+24). Na ordem `(data_movimento, id)` são 29: com tamanho 20, o V tem 3 movimentos na 1ª página
 * e o recebimento na 2ª.
 */
describe('Movimentação analítica: venda do PDV, compensação e a linha de saldo que atravessa a página', () => {
  let estoque3: string;
  let produtoV: string;
  let cliente: string;
  let vendaId: string;
  let caixa: string;
  const numeroVenda = 'L03-C01-000001';
  const periodo3 = () => ({ ...periodo(1), estoqueId: estoque3 });

  const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
  const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const cabecalhos = (tk?: string) => ({
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': agora(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  });

  beforeAll(async () => {
    const loja3 = await criarLoja(emp.nomeBanco, 3, 'Loja 3 - Praia');
    [{ estoque_id: estoque3 }] = (await consultar<{ estoque_id: string }>(
      emp.nomeBanco,
      'select estoque_id from lojas where id = $1',
      [loja3],
    )) as [{ estoque_id: string }];
    [{ id: caixa }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
      [loja3],
    )) as [{ id: string }];
    const [{ id: dinheiro }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null order by ordem limit 1",
    )) as [{ id: string }];
    const c = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer())
      .send({
        tipo: 'PJ',
        nome: 'Bar do Zé Movimentação',
        cpfCnpj: completarCnpj('445556660001'),
        categorias: ['cliente'],
      });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    cliente = c.body.id as string;
    produtoV = await criarProduto('CERVEJA MOVIMENTACAO V');

    // "Definir" 10 na contagem de há 2 h, efetivado agora (antes da venda chegar).
    await acerto({
      estoqueId: estoque3,
      tipoAjuste: 'definir',
      dataContagem: horasAtras(2),
      itens: [{ produtoId: produtoV, quantidade: '10' }],
    });

    // O caixa da Loja 3 pelo `/sync/ativar` real, com a sessão aberta, e a venda offline de há 3 h.
    const g = await amb
      .http()
      .post('/api/terminais/ativacoes')
      .set(bearer())
      .send({ lojaId: loja3, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const at = await amb
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
    expect(at.status, JSON.stringify(at.body)).toBe(201);
    const terminal = at.body.terminal_id as string;
    const token = at.body.token as string;
    const sessao = uuidv7();
    const ponto = { loja_id: loja3, caixa_id: caixa, numero_caixa: 1, terminal_id: terminal };
    let seq = 0;
    const evento = (tipo: keyof typeof CONTRATOS_EVENTOS, payload: Record<string, unknown>) => {
      const contrato = CONTRATOS_EVENTOS[tipo];
      return {
        evento_id: uuidv7(),
        sequencia: ++seq,
        tipo,
        versao_schema: 1,
        agregado_tipo: contrato.agregadoTipo,
        agregado_id: (contrato.agregadoId as (x: unknown) => string)(payload),
        dependencias:
          tipo === 'venda.finalizada' ? [{ agregado_tipo: 'sessao_caixa', agregado_id: sessao }] : [],
        ocorrido_em: agora(),
        relogio_confiavel: true,
        usuario_id: admin,
        contexto: { loja_id: loja3, caixa_id: caixa, numero_caixa: 1, versao_app: '1.0.0' },
        payload,
        payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
      };
    };
    const push = async (ev: unknown) => {
      const r = await amb
        .http()
        .post('/sync/push')
        .set(cabecalhos(token))
        .send({ lote_id: uuidv7(), terminal_id: terminal, enviado_em: agora(), eventos: [ev] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.resultados[0], JSON.stringify(r.body)).toMatchObject({ status: 'aplicado' });
    };
    await push(
      evento('caixa.aberto', {
        sessoes_caixa: {
          id: sessao,
          ...ponto,
          operador_id: admin,
          status: 'aberta',
          dia_operacional: diaLocal(),
          aberta_em: horasAtras(5),
          fundo_troco: '0.00',
        },
        movimentos_caixa: [],
      }),
    );
    vendaId = uuidv7();
    const quando = horasAtras(3);
    await push(
      evento('venda.finalizada', {
        vendas: {
          id: vendaId,
          numero: 1,
          numero_exibicao: numeroVenda,
          ...ponto,
          sessao_caixa_id: sessao,
          tipo: 'pdv',
          status: 'finalizada',
          dia_operacional: diaLocal(),
          operador_id: admin,
          cliente_id: cliente,
          subtotal_bruto: '20.00',
          total: '20.00',
          iniciada_em: quando,
          finalizada_em: quando,
        },
        itens_venda: [
          {
            id: uuidv7(),
            venda_id: vendaId,
            sequencia: 1,
            produto_id: produtoV,
            descricao: 'CERVEJA MOVIMENTACAO V',
            unidade: 'UN',
            quantidade: '2.000',
            preco_tabela: '10.0000',
            preco_unitario: '10.0000',
            valor_bruto: '20.00',
            valor_liquido: '20.00',
            incluido_em: quando,
            componentes_estoque: [],
          },
        ],
        pagamentos_venda: [
          {
            id: uuidv7(),
            venda_id: vendaId,
            sequencia: 1,
            forma_pagamento_id: dinheiro,
            descricao_forma: 'Dinheiro',
            meio_pagamento_fiscal: '01',
            tipo_forma: 'dinheiro',
            valor: '20.00',
            lanca_quitada: true,
          },
        ],
        vasilhames: [],
      }),
    );

    // As 25 entradas do lote no estoque da Loja 3 e, por último, o recebimento de 2 V com fator 12.
    await acerto({
      estoqueId: estoque3,
      tipoAjuste: 'entrada',
      itens: lote.map((p) => ({ produtoId: p, quantidade: '1', custoUnitario: '2' })),
    });
    const rec = await amb
      .http()
      .post('/api/recebimentos')
      .set(bearer())
      .send({
        lojaId: loja3,
        fornecedorId: fornecedor,
        dataRecebimento: diaLocal(),
        itens: [{ produtoId: produtoV, fator: '12', quantidade: '2', precoCompra: '48' }],
      });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const mov = await amb
      .http()
      .post(`/api/recebimentos/${rec.body.id}/movimentar`)
      .set(bearer())
      .send({ atualizarPrecoCusto: false });
    expect(mov.status, JSON.stringify(mov.body)).toBe(200);
  }, 120_000);

  it('a venda offline tardia: o cliente, o número de exibição e o recalculado diferente do gravado', async () => {
    const v = (await todas({ ...periodo3(), produtoId: produtoV }, '20')).itens;
    expect(v.map((l) => [l.tipoMovimento, l.saldoAnterior, l.saldoPosterior])).toEqual([
      ['VENDA_PDV', '0.000', '-2.000'],
      ['ACERTO_COMPENSACAO', '-2.000', '0.000'],
      ['ACERTO_DEFINIR', '0.000', '10.000'],
      ['RECEB_MANUAL', '10.000', '34.000'],
    ]);
    const [venda, compensacao, , receb] = v as [
      LinhaMovimentacaoEstoque,
      LinhaMovimentacaoEstoque,
      LinhaMovimentacaoEstoque,
      LinhaMovimentacaoEstoque,
    ];
    // Chegou depois do "Definir" (gravada sobre os 10 de então); na ordem da data ela vem antes dele.
    expect(venda).toMatchObject({
      pessoaVenda: 'Bar do Zé Movimentação',
      fornecedor: null,
      documento: { tipo: 'venda', id: vendaId, numero: numeroVenda },
      saldoAnteriorGravado: '10.000',
      saldoPosteriorGravado: '8.000',
    });
    // A compensação é um documento "acerto", mas herda o cliente da venda: a coluna mostra quem o filtro achou.
    expect(compensacao).toMatchObject({
      pessoaVenda: 'Bar do Zé Movimentação',
      documento: { tipo: 'acerto' },
    });
    // A quantidade na unidade do produto; o fator do documento ao lado (2 × 12 = 24).
    expect(receb).toMatchObject({
      quantidade: '24.000',
      unidadeBase: 'UN',
      fator: '12.000',
      fornecedor: 'Distribuidora Movimentação Ltda',
      pessoaVenda: null,
    });
  });

  it('o filtro pelo número da venda (texto) e pela pessoa traz a venda e a compensação, com o nome', async () => {
    const doc = await pagina({ ...periodo3(), documentoTipo: 'venda', documentoNumero: numeroVenda });
    expect(doc.itens.map((l) => [l.tipoMovimento, l.documento.numero, l.saldoAnterior])).toEqual([
      ['VENDA_PDV', numeroVenda, '0.000'],
    ]);
    expect(
      (await pagina({ ...periodo3(), documentoTipo: 'venda', documentoNumero: 'L03-C01-000002' })).itens,
    ).toEqual([]);
    const pessoa = await pagina({ ...periodo3(), pessoaId: cliente });
    expect(pessoa.itens.map((l) => [l.tipoMovimento, l.pessoaVenda])).toEqual([
      ['VENDA_PDV', 'Bar do Zé Movimentação'],
      ['ACERTO_COMPENSACAO', 'Bar do Zé Movimentação'],
    ]);
  });

  it('a linha de saldo que atravessa a página: o primeiro movimento dela na 2ª página soma desde o começo', async () => {
    const p1 = await pagina({ ...periodo3(), tamanho: '20' });
    const p2 = await pagina({ ...periodo3(), tamanho: '20', cursor: p1.proximoCursor! });
    expect(p1.itens.filter((l) => l.produtoId === produtoV)).toHaveLength(3);
    expect(p2.itens).toHaveLength(9);
    expect(p2.proximoCursor).toBeNull();
    const receb = p2.itens.at(-1)!;
    expect(receb).toMatchObject({ produtoId: produtoV, tipoMovimento: 'RECEB_MANUAL' });
    // O anterior é o posterior do último do V na 1ª página (o Definir), não o zero do cursor.
    expect(receb.saldoAnterior).toBe(p1.itens.filter((l) => l.produtoId === produtoV).at(-1)!.saldoPosterior);
    expect([receb.saldoAnterior, receb.saldoPosterior]).toEqual(['10.000', '34.000']);
    // E o mesmo com um filtro que deixa o V sozinho na 2ª página (os do lote e o recebimento).
    const filtradas = await todas({ ...periodo3(), tiposMovimento: 'ACERTO_ENTRADA,RECEB_MANUAL' }, '20');
    expect(filtradas.paginas).toBe(2);
    expect(filtradas.itens.at(-1)).toMatchObject({ tipoMovimento: 'RECEB_MANUAL', saldoAnterior: '10.000' });
  });
});

describe('Movimentação analítica: permissões e validação', () => {
  it('o custo só com "Ver custo"; o estoque fora dos permitidos e sem a permissão do relatório são 403', async () => {
    const e = await pagina({ ...periodo(), tiposMovimento: 'RECEB_MANUAL' }, tokenEstoquista);
    expect(e.itens[0]).toMatchObject({ custoUnitario: null, custoTotal: null, saldoAnterior: '25.000' });
    const fora = await pedir({ ...periodo(), estoqueId: estoque2 }, tokenEstoquista);
    expect(fora.status, JSON.stringify(fora.body)).toBe(403);
    expect((await pedir(periodo(), tokenVendedor)).status).toBe(403);
    // O admin vê a Loja 2.
    const l2 = await pagina({ ...periodo(), estoqueId: estoque2 });
    expect(l2.itens.map((x) => [x.produtoId, x.saldoPosterior])).toEqual([[produtoA, '7.000']]);
  });

  it('local e período obrigatórios, até 366 dias; cursor, tipo e documento inválidos', async () => {
    const campos = async (q: Record<string, string>) => {
      const r = await pedir(q);
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(422);
      return Object.keys(r.body.campos ?? {});
    };
    expect(await campos({ dataInicial: diaLocal(), dataFinal: diaLocal() })).toEqual(['estoqueId']);
    expect(await campos({ estoqueId: estoque1 })).toEqual(
      expect.arrayContaining(['dataInicial', 'dataFinal']),
    );
    // 367 dias contando as pontas é recusado; 366 passa (de 07/11 a 07/11 do ano seguinte, e o ano bissexto).
    expect(await campos({ estoqueId: estoque1, dataInicial: '2025-11-06', dataFinal: '2026-11-07' })).toEqual(
      ['dataFinal'],
    );
    for (const [dataInicial, dataFinal] of [
      ['2025-11-07', '2026-11-07'],
      ['2027-11-08', '2028-11-07'],
    ])
      expect(
        (
          await pedir({
            estoqueId: estoque1,
            dataInicial: dataInicial!,
            dataFinal: dataFinal!,
            tamanho: '20',
          })
        ).status,
      ).toBe(200);
    expect(await campos({ estoqueId: estoque1, dataInicial: '2027-11-07', dataFinal: '2028-11-07' })).toEqual(
      ['dataFinal'],
    );
    expect(await campos({ estoqueId: estoque1, dataInicial: diaLocal(), dataFinal: diaLocal(1) })).toEqual([
      'dataFinal',
    ]);
    expect(await campos({ ...periodo(), cursor: 'nao-e-um-cursor' })).toEqual(['cursor']);
    expect(await campos({ ...periodo(), tiposMovimento: 'NAO_EXISTE' })).toEqual(['tiposMovimento']);
    expect(await campos({ ...periodo(), documentoNumero: '12' })).toEqual(['documentoTipo']);
    expect(await campos({ ...periodo(), documentoTipo: 'vasilhame', documentoNumero: '12' })).toEqual([
      'documentoNumero',
    ]);
    expect(await campos({ ...periodo(), tamanho: '1000' })).toEqual(['tamanho']);
    const inexistente = await pedir({ ...periodo(), estoqueId: '0190a000-0000-7000-8000-000000000999' });
    expect(inexistente.status).toBe(422);
  });

  it('o razão refaz as projeções idênticas', async () => {
    await conferirRazaoDoBanco(emp.nomeBanco);
  });
});
