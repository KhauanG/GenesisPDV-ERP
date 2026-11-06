/**
 * Fim do ruído de `custo_medio` (Fase 1C, bloco C2; T3/T10; migração 0011): a projeção `produtos.custo_medio` muda a
 * cada saída quando o CD e as lojas têm custos diferentes, mas não gera versão nova no produto nem no combo — o
 * catálogo não desce de novo para os PDVs e o ERP não dá 409 falso a quem edita o produto. `preco_custo` e o preço
 * continuam versionando (a concorrência otimista do ERP 1.4 depende disso); o fluxo `estoque` muda, como esperado
 * (SYNC 15.5).
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dec, decTexto, respostaPullSchema, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let token: string;
let estoqueCd: string;
let estoqueLoja1: string;
let estoqueLoja2: string;
let cerveja: string;
let combo: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function cabecalhosPdv(tk?: string) {
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

/** Páginas do pull até `tem_mais = false`, a partir de `desde`. */
async function puxar(fluxo: string, desde: number) {
  const alteracoes: Array<{ tabela: string; linha: Record<string, unknown> }> = [];
  let cursor = desde;
  for (let i = 0; i < 100; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=${fluxo}&desde=${cursor}&limite=500`)
      .set(cabecalhosPdv(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...r.body.alteracoes);
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { alteracoes, cursor };
  }
  throw new Error('pull não terminou');
}

/** Acerto efetivado de um item (entrada com custo ou saída pelo custo médio). */
async function acerto(estoqueId: string, item: Record<string, unknown>, tipoAjuste: 'entrada' | 'saida') {
  const r = await amb
    .http()
    .post('/api/acertos')
    .set(bearer(admin))
    .send({
      estoqueId,
      tipoAjuste,
      dataContagem: horasAtras(3),
      motivo: tipoAjuste === 'entrada' ? 'Saldo inicial' : 'Avaria',
      itens: [item],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const atual = await amb.http().get(`/api/acertos/${r.body.id}`).set(bearer(admin));
  const e = await amb
    .http()
    .post(`/api/acertos/${r.body.id}/efetivar`)
    .set(bearer(admin))
    .send({ versao: atual.body.versao });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
}

const saida = (estoqueId: string, quantidade = '1') =>
  acerto(estoqueId, { produtoId: cerveja, quantidade }, 'saida');

async function produto(id: string) {
  const [p] = await consultar<{
    versao: string;
    atualizado_em: Date;
    custo_medio: string;
    preco_custo: string;
  }>(
    emp.nomeBanco,
    'select versao, atualizado_em, custo_medio::text, preco_custo::text from produtos where id = $1',
    [id],
  );
  return p!;
}

/** Saldos da cerveja por estoque (quantidade e custo médio), lidos no momento da chamada. */
async function saldos() {
  const linhas = await consultar<{ estoque_id: string; quantidade: string; custo_medio: string }>(
    emp.nomeBanco,
    'select estoque_id, quantidade::text, custo_medio::text from saldos_estoque where produto_id = $1',
    [cerveja],
  );
  return new Map(linhas.map((l) => [l.estoque_id, l]));
}

/**
 * Média ponderada dos saldos positivos com 4 casas (a conta de `fn_projetar_custo_medio_produto`, migração 0006),
 * com `ajuste` somado à quantidade de cada estoque: a saída pelo custo médio não muda o custo do saldo, só o peso.
 */
function mediaPonderada(s: Awaited<ReturnType<typeof saldos>>, ajuste: Record<string, number> = {}) {
  let soma = dec(0);
  let peso = dec(0);
  for (const [estoque, l] of s) {
    const q = dec(l.quantidade).plus(ajuste[estoque] ?? 0);
    if (q.lte(0)) continue;
    soma = soma.plus(q.times(l.custo_medio));
    peso = peso.plus(q);
  }
  return decTexto(soma.div(peso), 4);
}

const obter = async (id: string) =>
  (await amb.http().get(`/api/produtos/${id}`).set(bearer(admin))).body as Record<string, unknown>;

const salvar = (id: string, corpo: Record<string, unknown>) =>
  amb.http().put(`/api/produtos/${id}`).set(bearer(admin)).send(corpo);

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  const loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  const estoqueDa = async (loja: string) =>
    (
      await consultar<{ estoque_id: string }>(emp.nomeBanco, 'select estoque_id from lojas where id = $1', [
        loja,
      ])
    )[0]!.estoque_id;
  estoqueLoja1 = await estoqueDa(loja1);
  estoqueLoja2 = await estoqueDa(loja2);
  [{ id: estoqueCd }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD Central', 'deposito') returning id",
  )) as [{ id: string }];
  const [{ id: caixa1 }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja1],
  )) as [{ id: string }];

  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer(admin));
  const un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;
  const criar = async (corpo: Record<string, unknown>) => {
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({ unidadeId: un, precoVenda: '10', ...corpo });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };
  cerveja = await criar({ nome: 'CERV BRAHMA LT 350ML', precoCusto: '2', precoVenda: '3,49' });
  combo = await criar({
    nome: 'COMBO 6 BRAHMA',
    tipo: 'kit',
    precoVenda: '19,90',
    componentes: [{ tipo: 'kit', componenteId: cerveja, quantidade: '6', ordem: 0 }],
  });
  // Três estoques com custos diferentes: cada saída muda o peso da média ponderada do produto.
  await acerto(estoqueCd, { produtoId: cerveja, quantidade: '100', custoUnitario: '2,00' }, 'entrada');
  await acerto(estoqueLoja1, { produtoId: cerveja, quantidade: '50', custoUnitario: '2,30' }, 'entrada');
  await acerto(estoqueLoja2, { produtoId: cerveja, quantidade: '30', custoUnitario: '2,50' }, 'entrada');

  const tokenAdmin = admin;
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer(tokenAdmin))
    .send({ lojaId: loja1, caixaId: caixa1, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhosPdv())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  token = r.body.token;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

// Cada caso calcula o esperado a partir do estado que encontra (saldos lidos no começo do próprio caso): rodam
// sozinhos (`-t`, `.only`) e em qualquer ordem, embora as saídas de um caso mudem os saldos que o seguinte lê.
describe('custo_medio isento de versão (C2; T3/T10; MD 1.5)', () => {
  it('uma saída muda o custo_medio do produto e do combo sem mudar a versão de nenhum dos dois', async () => {
    const s = await saldos();
    const antes = await produto(cerveja);
    const comboAntes = await produto(combo);
    // Na ordem do arquivo: (100 × 2,00 + 50 × 2,30 + 30 × 2,50) ÷ 180 = 2,1667; o combo leva 6 × 2,1667 = 13,0002.
    expect(antes.custo_medio).toBe(mediaPonderada(s));
    expect(comboAntes.custo_medio).toBe(decTexto(dec(antes.custo_medio).times(6), 4));
    await saida(estoqueLoja1);
    const depois = await produto(cerveja);
    const comboDepois = await produto(combo);
    // Na ordem do arquivo: (100 × 2,00 + 49 × 2,30 + 30 × 2,50) ÷ 179 = 2,1659; o combo, 12,9954.
    const esperado = mediaPonderada(s, { [estoqueLoja1]: -1 });
    expect(esperado).not.toBe(antes.custo_medio);
    expect(depois).toEqual({ ...antes, custo_medio: esperado });
    expect(comboDepois).toEqual({ ...comboAntes, custo_medio: decTexto(dec(esperado).times(6), 4) });
  });

  it('o pull catalogo depois de 10 saídas (duas lojas) volta vazio; o fluxo estoque muda', async () => {
    const catalogo = await puxar('catalogo', 0);
    expect(catalogo.alteracoes.some((a) => a.tabela === 'produtos')).toBe(true);
    const estoque = await puxar('estoque', 0);
    const custo = (await produto(cerveja)).custo_medio;
    const loja1Antes = (await saldos()).get(estoqueLoja1)!.quantidade;
    for (let i = 0; i < 10; i++) await saida(i % 2 ? estoqueLoja2 : estoqueLoja1);
    expect((await produto(cerveja)).custo_medio).not.toBe(custo);
    expect((await puxar('catalogo', catalogo.cursor)).alteracoes).toEqual([]);
    const novas = await puxar('estoque', estoque.cursor);
    expect(novas.alteracoes.map((a) => [a.tabela, a.linha.produto_id, a.linha.quantidade])).toEqual([
      // Só o saldo da loja do terminal desce, com as 5 saídas dela (na ordem do arquivo, 50 − 1 − 5 = 44).
      ['saldos_estoque', cerveja, decTexto(dec(loja1Antes).minus(5), 3)],
    ]);
  });

  it('a saída não dá 409 falso no ERP; preço e preco_custo versionam, e editar com versão velha dá 409', async () => {
    const lido = await obter(cerveja);
    await saida(estoqueCd, '10');
    // O formulário aberto antes da venda salva normalmente.
    const ok = await salvar(cerveja, { ...lido, localizacao: 'G1' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    // Mudar o preço versiona o produto.
    const v0 = await produto(cerveja);
    const preco = await salvar(cerveja, { ...(await obter(cerveja)), precoVenda: '3.59' });
    expect(preco.status, JSON.stringify(preco.body)).toBe(200);
    const v1 = await produto(cerveja);
    expect(Number(v1.versao)).toBeGreaterThan(Number(v0.versao));

    // `preco_custo` versiona o produto e o combo (o custo do combo acompanha) e a versão velha dá 409.
    const comboV1 = await produto(combo);
    const atual = await obter(cerveja);
    const custo = await salvar(cerveja, { ...atual, precoCusto: '2.2' });
    expect(custo.status, JSON.stringify(custo.body)).toBe(200);
    const v2 = await produto(cerveja);
    expect(v2.preco_custo).toBe('2.2000');
    expect(Number(v2.versao)).toBeGreaterThan(Number(v1.versao));
    const comboV2 = await produto(combo);
    expect(comboV2.preco_custo).toBe('13.2000');
    expect(Number(comboV2.versao)).toBeGreaterThan(Number(comboV1.versao));
    const velho = await salvar(cerveja, { ...atual, precoCusto: '2.4' });
    expect(velho.status).toBe(409);
    expect((await produto(cerveja)).preco_custo).toBe('2.2000');
  });

  it('custo_medio junto com outra coluna versiona (a isenção vale só quando ela muda sozinha)', async () => {
    const antes = await produto(cerveja);
    await consultar(
      emp.nomeBanco,
      "update produtos set custo_medio = custo_medio + 1, localizacao = 'G7' where id = $1",
      [cerveja],
    );
    expect(Number((await produto(cerveja)).versao)).toBeGreaterThan(Number(antes.versao));
  });
});
