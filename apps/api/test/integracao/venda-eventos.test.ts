/**
 * Handler do `venda.finalizada` (Fase 1C, bloco C6b; SYNC 9.7, 10.2, 13.1, 15.1, 15.3; MD 3.5.4, 3.11): um teste por
 * critério do roadmap — o fardo de 12 baixa 12 UN; o combo de whisky com a troca pelo Monster baixa só os componentes
 * escolhidos e o custo da venda é a soma deles; o casco faltante sai como `VASILHAME_VENDIDO` e os trazidos entram no
 * tipo `vasilhame_vazio`; o mix de 12 latas baixa cada produto; o reenvio do lote e a venda gerada de novo não mudam
 * nada; o número duplicado vai a `erro`; a venda numa loja não versiona `produtos` com custos diferentes entre as lojas;
 * o estoque negativo gera um alerta só; e a venda anterior a um "Definir" chega depois e é compensada. Também: ficha
 * técnica com o mesmo insumo somado e o legado `origem = 'kit'`, custo de referência do item sem baixa e da ficha mista
 * (T22), estoque do contexto inativo e excluído, cliente por `pessoas_aliases` com a relevância `compra` (T15), sessão
 * fechada à força pela nuvem, retida e inexistente; a fixture do C4 aplicada e reenviada; TEF, PIX, complemento e
 * parcela; as conferências de soma (`VENDA_INCONSISTENTE`) e o produto inativo (`PRODUTO_INATIVO_VENDIDO`); o estorno
 * do "Definir" que já compensou vendas tardias; e a venda de 1200 itens gravada em blocos. Cada teste usa um caixa e um terminal só seus (`novoPonto`) e produtos próprios: roda sozinho (`-t`) e em qualquer
 * ordem.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRATOS_EVENTOS, jcs, respostaPushSchema, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { itemDerivadoDocumento } from '../../src/estoques/movimentos.js';
import { versoesSchemaAceitas } from '../../src/sync/eventos.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';
import { conferirRazaoDasEmpresas } from './razao.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let estoqueLoja: string;
let tokenAdmin: string;
let operador: string;
let dinheiro: string;
let un: string;
let fd: string;
let tipoPadrao: string;
let tipoVazio: string;

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

/** Um caixa com o seu terminal ativado pelo `/sync/ativar` real, a sequência dos eventos e o número da venda. */
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
  const [aberto] = await pushOk(p, [evento(p, 'caixa.aberto', abertura(p, p.sessao))]);
  expect(aberto, JSON.stringify(aberto)).toMatchObject({ status: 'aplicado' });
  return p;
}

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

function abertura(p: Ponto, sessao: string, extra: Payload = {}) {
  return {
    sessoes_caixa: {
      id: sessao,
      ...linhaDoPonto(p),
      operador_id: operador,
      status: 'aberta',
      dia_operacional: '2026-10-31',
      aberta_em: horasAtras(4),
      fundo_troco: '0.00',
      ...extra,
    },
    movimentos_caixa: [],
  };
}

/** Envelope com o agregado do contrato (C4) e a sessão declarada como dependência, como o PDV declara (SYNC 8.5). */
function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload, extra: Payload = {}) {
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
    ...extra,
  };
}

const push = (p: Ponto, eventos: unknown[], loteId = uuidv7()) =>
  amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: loteId, terminal_id: p.terminal, enviado_em: agora(), eventos });

type Resultado = { status: string; erro?: { codigo: string }; resultado?: Record<string, unknown> };

async function pushOk(p: Ponto, eventos: unknown[], loteId?: string): Promise<Resultado[]> {
  const r = await push(p, eventos, loteId);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Resultado[];
}

interface ItemTeste {
  produto: string;
  quantidade: string;
  preco?: string;
  extra?: Payload;
}

/** Uma venda finalizada só com o que o contrato exige (C4) mais o que o teste pede; total pago em dinheiro. */
function venda(
  p: Ponto,
  itens: ItemTeste[],
  opcoes: { finalizadaEm?: string; extra?: Payload; vasilhames?: Payload[]; numero?: number } = {},
) {
  const id = uuidv7();
  const numero = opcoes.numero ?? ++p.venda;
  const finalizada = opcoes.finalizadaEm ?? agora();
  const linhas = itens.map((i, n) => {
    const preco = i.preco ?? '5.0000';
    const valor = (Number(preco) * Number(i.quantidade)).toFixed(2);
    return {
      id: uuidv7(),
      venda_id: id,
      sequencia: n + 1,
      produto_id: i.produto,
      descricao: 'ITEM DE TESTE',
      unidade: 'UN',
      quantidade: i.quantidade,
      preco_tabela: preco,
      preco_unitario: preco,
      valor_bruto: valor,
      valor_liquido: valor,
      incluido_em: finalizada,
      componentes_estoque: [],
      ...i.extra,
    };
  });
  const vivas = linhas.filter((l) => !(l as { cancelado?: boolean }).cancelado);
  const somar = (campo: 'valor_bruto' | 'valor_liquido') =>
    vivas.reduce((s, l) => s + Math.round(Number(l[campo]) * 100), 0) / 100;
  const total = somar('valor_liquido').toFixed(2);
  return {
    vendas: {
      id,
      numero,
      numero_exibicao: `L01-C${String(p.numero).padStart(2, '0')}-${String(numero).padStart(6, '0')}`,
      ...linhaDoPonto(p),
      sessao_caixa_id: p.sessao,
      tipo: 'pdv',
      status: 'finalizada',
      dia_operacional: '2026-10-31',
      operador_id: operador,
      cliente_id: null,
      subtotal_bruto: somar('valor_bruto').toFixed(2),
      total,
      iniciada_em: finalizada,
      finalizada_em: finalizada,
      ...opcoes.extra,
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
        valor: Number(total) > 0 ? total : '0.01',
        lanca_quitada: true,
      },
    ],
    vasilhames: opcoes.vasilhames ?? [],
  };
}

type Venda = ReturnType<typeof venda>;
const idItem = (v: Venda, n: number) => v.itens_venda[n]!.id;

async function criarProduto(corpo: Record<string, unknown>): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ unidadeId: un, precoVenda: '5', precoCusto: '2', ...corpo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/**
 * Saldo inicial por um acerto de Entrada efetivado. A "Data" (há 3 h) fica só no cabeçalho: a Entrada lança no
 * momento da efetivação (regra de data do F2-B4); antes de um "Definir" no passado, use `contagemInicial`.
 */
async function entrada(
  itens: Array<[produto: string, quantidade: string, custo: string]>,
  estoqueId = estoqueLoja,
) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId,
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
  await efetivar(a.body.id as string);
}

/** Saldo inicial por um "Definir" há 3 h (lança na hora da contagem): antes dos fatos e dos "Definir" dos testes. */
async function contagemInicial(produtoId: string, quantidade: string) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId: estoqueLoja,
      tipoAjuste: 'definir',
      dataContagem: horasAtras(3),
      motivo: 'Saldo inicial',
      itens: [{ produtoId, quantidade }],
    });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  await efetivar(a.body.id as string);
}

async function efetivar(id: string) {
  const atual = await amb.http().get(`/api/acertos/${id}`).set(bearer());
  const r = await amb
    .http()
    .post(`/api/acertos/${id}/efetivar`)
    .set(bearer())
    .send({ versao: atual.body.versao });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function saldo(produto: string, tipo = tipoPadrao, estoqueId = estoqueLoja) {
  const [s] = await consultar<{ quantidade: string; custo_medio: string }>(
    emp.nomeBanco,
    `select quantidade::text, custo_medio::text from saldos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoqueId, produto, tipo],
  );
  return s ? Number(s.quantidade) : 0;
}

interface MovimentoGravado {
  id: string;
  produto_id: string;
  tipo_estoque_id: string;
  estoque_id: string;
  tipo_movimento: string;
  quantidade: string;
  custo_unitario: string;
  custo_total: string;
  unidade_documento: string | null;
  fator: string;
  documento_tipo: string;
  documento_id: string | null;
  documento_item_id: string | null;
  terminal_id: string | null;
  evento_id: string | null;
  pessoa_id: string | null;
  compensa_movimento_id: string | null;
  data_movimento: Date;
}

const movimentosDaVenda = (vendaId: string) =>
  consultar<MovimentoGravado>(
    emp.nomeBanco,
    `select id, produto_id, tipo_estoque_id, estoque_id, tipo_movimento, quantidade::text, custo_unitario::text,
            custo_total::text, unidade_documento, fator::text, documento_tipo, documento_id, documento_item_id,
            terminal_id, evento_id, pessoa_id, compensa_movimento_id, data_movimento
       from movimentos_estoque where documento_tipo = 'venda' and documento_id = $1 order by produto_id, tipo_movimento`,
    [vendaId],
  );

const itensGravados = (vendaId: string) =>
  consultar<{ id: string; custo_unitario: string | null }>(
    emp.nomeBanco,
    'select id, custo_unitario::text from itens_venda where venda_id = $1 order by sequencia',
    [vendaId],
  );

const vendaGravada = async (vendaId: string) =>
  (
    await consultar<{
      custo_total: string;
      relogio_confiavel: boolean;
      cliente_id: string | null;
      status: string;
    }>(
      emp.nomeBanco,
      'select custo_total::text, relogio_confiavel, cliente_id, status from vendas where id = $1',
      [vendaId],
    )
  )[0];

const alertasAbertos = (tipo: string, chave: string) =>
  consultar<{ id: string; dados: Record<string, unknown> }>(
    emp.nomeBanco,
    'select id, dados from alertas where tipo = $1 and chave_deduplicacao = $2 and resolvido_em is null',
    [tipo, chave],
  );

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
  const tipos = await consultar<{ id: string; padrao: boolean; chave_sistema: string | null }>(
    emp.nomeBanco,
    'select id, padrao, chave_sistema from tipos_estoque',
  );
  tipoPadrao = tipos.find((t) => t.padrao)!.id;
  tipoVazio = tipos.find((t) => t.chave_sistema === 'vasilhame_vazio')!.id;
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  fd = unidades.find((u) => u.sigla === 'FD')!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('catálogo (T13)', () => {
  it('anuncia venda.finalizada v1 em versoes_schema', () => {
    expect(versoesSchemaAceitas()).toMatchObject({ 'venda.finalizada': [1] });
  });
});

describe('venda.finalizada pelo push (SYNC 9.7, 10.2)', () => {
  it('fardo de 12: baixa 12 UN com a embalagem lida; venda, custo, numeração, auditoria e relógio', async () => {
    const p = await novoPonto();
    const brahma = await criarProduto({
      nome: 'CERV BRAHMA LT 350ML C6B',
      codigosBarras: [
        { codigo: '7891149105113', principal: true },
        { codigo: '7891149103119', unidadeId: fd, fator: '12' },
      ],
    });
    const [{ id: codigoFardo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from produtos_codigos_barras where produto_id = $1 and fator = 12',
      [brahma],
    )) as [{ id: string }];
    await entrada([[brahma, '100', '2.50']]);
    const v = venda(p, [
      { produto: brahma, quantidade: '12.000', preco: '3.2900', extra: { codigo_barras_id: codigoFardo } },
    ]);
    const ev = evento(p, 'venda.finalizada', v, { relogio_confiavel: false });
    const [r] = await pushOk(p, [ev]);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { venda_id: v.vendas.id, custo_total: '30.00', movimentos: 1 },
    });
    expect(await saldo(brahma)).toBe(88);
    const [m] = await movimentosDaVenda(v.vendas.id);
    expect(m).toMatchObject({
      tipo_movimento: 'VENDA_PDV',
      quantidade: '-12.000',
      unidade_documento: 'FD',
      fator: '12.000',
      custo_unitario: '2.5000',
      custo_total: '30.00',
      tipo_estoque_id: tipoPadrao,
      estoque_id: estoqueLoja,
      documento_item_id: idItem(v, 0),
      terminal_id: p.terminal,
      evento_id: ev.evento_id,
    });
    expect(m!.data_movimento.toISOString()).toBe(v.vendas.finalizada_em);
    expect(await itensGravados(v.vendas.id)).toEqual([{ id: idItem(v, 0), custo_unitario: '2.5000' }]);
    expect(await vendaGravada(v.vendas.id)).toMatchObject({
      custo_total: '30.00',
      relogio_confiavel: false,
      status: 'finalizada',
    });
    const [num] = await consultar<{ ultimo_numero: string; ultimo_atualizado_por_terminal_id: string }>(
      emp.nomeBanco,
      "select ultimo_numero::text, ultimo_atualizado_por_terminal_id from numeracoes where tipo = 'venda' and caixa_id = $1",
      [p.caixa],
    );
    expect(num).toEqual({ ultimo_numero: '1', ultimo_atualizado_por_terminal_id: p.terminal });
    // Venda com número menor depois (outra ordem de finalização no caixa): `greatest`, a numeração não volta.
    await pushOk(p, [
      evento(p, 'venda.finalizada', venda(p, [{ produto: brahma, quantidade: '1.000' }], { numero: 5 })),
    ]);
    await pushOk(p, [
      evento(p, 'venda.finalizada', venda(p, [{ produto: brahma, quantidade: '1.000' }], { numero: 3 })),
    ]);
    const [depois] = await consultar<{ ultimo_numero: string }>(
      emp.nomeBanco,
      "select ultimo_numero::text from numeracoes where tipo = 'venda' and caixa_id = $1",
      [p.caixa],
    );
    expect(depois!.ultimo_numero).toBe('5');
    const [aud] = await consultar<{ origem: string; acao: string; evento_id: string; terminal_id: string }>(
      emp.nomeBanco,
      "select origem, acao, evento_id, terminal_id from auditoria where entidade = 'vendas' and registro_id = $1",
      [v.vendas.id],
    );
    expect(aud).toEqual({ origem: 'pdv', acao: 'criar', evento_id: ev.evento_id, terminal_id: p.terminal });
  });

  it('combo de whisky com a troca pelo Monster: baixa Whisky, Monster e Gelo, nunca o combo nem o Red Bull', async () => {
    const p = await novoPonto();
    const whisky = await criarProduto({ nome: 'WHISKY 1L C6B', precoCusto: '80', precoVenda: '99,90' });
    const redBull = await criarProduto({ nome: 'RED BULL 2L C6B', precoCusto: '10', precoVenda: '24,90' });
    const monster = await criarProduto({ nome: 'MONSTER 2L C6B', precoCusto: '12', precoVenda: '24,90' });
    const gelo = await criarProduto({ nome: 'GELO DE COCO C6B', precoCusto: '1', precoVenda: '4,50' });
    const combo = await criarProduto({
      nome: 'COMBO DE WHISKY 1L C6B',
      tipo: 'kit',
      precoVenda: '129,90',
      componentes: [
        { tipo: 'kit', componenteId: whisky, quantidade: '1' },
        {
          tipo: 'kit',
          componenteId: redBull,
          quantidade: '1',
          rotuloPosicao: 'Energético 2L',
          permiteSubstituicao: true,
          alternativas: [{ produtoId: monster, acrescimo: '2,00' }],
        },
        { tipo: 'kit', componenteId: gelo, quantidade: '2' },
      ],
    });
    await entrada([
      [whisky, '10', '80'],
      [redBull, '10', '10'],
      [monster, '10', '12'],
      [gelo, '20', '1.10'],
    ]);
    const posicoes = await consultar<{ id: string; componente_id: string }>(
      emp.nomeBanco,
      "select id, componente_id from produtos_componentes where produto_id = $1 and tipo = 'kit'",
      [combo],
    );
    const posicao = (produto: string) => posicoes.find((x) => x.componente_id === produto)!.id;
    const [{ id: alternativa }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from produtos_componentes_alternativas where componente_id = $1 and produto_id = $2',
      [posicao(redBull), monster],
    )) as [{ id: string }];
    const grupo = uuidv7();
    const doCombo = (componente: string, alt: string | null = null, acrescimo = '0.0000') => ({
      origem_preco: 'kit_rateio',
      kit_grupo_id: grupo,
      kit_produto_id: combo,
      kit_descricao: 'COMBO DE WHISKY 1L',
      kit_quantidade: '1.000',
      kit_preco_unitario: '131.9000',
      kit_componente_id: componente,
      kit_alternativa_id: alt,
      kit_acrescimo: acrescimo,
    });
    const v = venda(p, [
      { produto: whisky, quantidade: '1.000', preco: '98.4800', extra: doCombo(posicao(whisky)) },
      {
        produto: monster,
        quantidade: '1.000',
        preco: '24.5500',
        extra: doCombo(posicao(redBull), alternativa, '2.0000'),
      },
      { produto: gelo, quantidade: '2.000', preco: '4.4350', extra: doCombo(posicao(gelo)) },
    ]);
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    // Custo = 80 + 12 + 2 × 1,10 = 94,20: a soma dos componentes escolhidos.
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { custo_total: '94.20' } });
    const movs = await movimentosDaVenda(v.vendas.id);
    expect(movs.map((m) => [m.produto_id, m.tipo_movimento, m.quantidade]).sort()).toEqual(
      [
        [whisky, 'VENDA_PDV', '-1.000'],
        [monster, 'VENDA_PDV', '-1.000'],
        [gelo, 'VENDA_PDV', '-2.000'],
      ].sort(),
    );
    expect([await saldo(whisky), await saldo(monster), await saldo(gelo), await saldo(redBull)]).toEqual([
      9, 9, 18, 10,
    ]);
    expect(await saldo(combo)).toBe(0);
    expect((await itensGravados(v.vendas.id)).map((i) => i.custo_unitario)).toEqual([
      '80.0000',
      '12.0000',
      '1.1000',
    ]);
  });

  it('casco faltante: VASILHAME_VENDIDO no lugar do VENDA_PDV; trazidos entram como vazios; comodato recusado', async () => {
    const p = await novoPonto();
    const casco = await criarProduto({
      nome: 'CASCO 600ML C6B',
      tipo: 'vasilhame',
      precoVenda: '1,50',
      precoCusto: '1',
    });
    const cheio = await criarProduto({
      nome: 'CERV ORIGINAL 600ML RET C6B',
      precoVenda: '9,90',
      vasilhameProdutoId: casco,
      vasilhameQuantidade: 1,
    });
    await entrada([
      [cheio, '24', '4'],
      [casco, '10', '1'],
    ]);
    // 3 cervejas com 2 cascos trazidos: 1 casco cobrado (item ligado ao cheio) e 2 vazios de volta.
    const v = venda(
      p,
      [
        { produto: cheio, quantidade: '3.000', preco: '9.9000' },
        { produto: casco, quantidade: '1.000', preco: '1.5000' },
      ],
      {
        vasilhames: [
          { produto_vasilhame_id: casco, devolvidos: 2, vendidos: 1, emprestados: 0, pessoa_id: null },
        ],
      },
    );
    v.itens_venda[1] = { ...v.itens_venda[1]!, vasilhame_item_origem_id: idItem(v, 0) } as never;
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { movimentos: 3 } });
    const movs = await movimentosDaVenda(v.vendas.id);
    expect(
      movs
        .map((m) => [m.produto_id, m.tipo_movimento, m.quantidade, m.tipo_estoque_id, m.documento_item_id])
        .sort(),
    ).toEqual(
      [
        [cheio, 'VENDA_PDV', '-3.000', tipoPadrao, idItem(v, 0)],
        [casco, 'VASILHAME_VENDIDO', '-1.000', tipoPadrao, idItem(v, 1)],
        [casco, 'VASILHAME_DEVOLVIDO', '2.000', tipoVazio, itemDerivadoDocumento(v.vendas.id, 'vasilhames')],
      ].sort(),
    );
    expect([await saldo(cheio), await saldo(casco), await saldo(casco, tipoVazio)]).toEqual([21, 9, 2]);

    const comodato = venda(p, [{ produto: cheio, quantidade: '1.000' }], {
      vasilhames: [
        { produto_vasilhame_id: casco, devolvidos: 0, vendidos: 0, emprestados: 1, pessoa_id: uuidv7() },
      ],
    });
    const [c] = await pushOk(p, [evento(p, 'venda.finalizada', comodato)]);
    expect(c).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    expect(await saldo(cheio)).toBe(21);
  });

  it('mix de 12 latas (6 Brahma + 6 Skol no preço do grupo): cada produto baixa 6', async () => {
    const p = await novoPonto();
    const brahma = await criarProduto({ nome: 'MIX BRAHMA LT C6B', precoVenda: '3,49' });
    const skol = await criarProduto({ nome: 'MIX SKOL LT C6B', precoVenda: '3,39' });
    const g = await amb
      .http()
      .post('/api/grupos-preco-quantidade')
      .set(bearer())
      .send({
        nome: 'Mix latas C6B',
        modoPreco: 'grupo',
        faixas: [{ quantidadeInicial: '12', preco: '2,99' }],
        produtos: [brahma, skol],
      });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    await entrada([
      [brahma, '48', '2'],
      [skol, '48', '1.90'],
    ]);
    const mix = {
      origem_preco: 'grupo_mix',
      grupo_preco_quantidade_id: g.body.id,
      quantidade_referencia_preco: '12.000',
    };
    const v = venda(p, [
      { produto: brahma, quantidade: '6.000', preco: '2.9900', extra: mix },
      { produto: skol, quantidade: '6.000', preco: '2.9900', extra: mix },
    ]);
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { custo_total: '23.40' } });
    expect([await saldo(brahma), await saldo(skol)]).toEqual([42, 42]);
  });

  it('ficha técnica: o mesmo insumo somado num BAIXA_INSUMO, legado origem=kit aceito; item sem baixa com custo de referência (T22)', async () => {
    const p = await novoPonto();
    const limao = await criarProduto({
      nome: 'LIMAO C6B',
      tipo: 'materia_prima',
      precoVenda: '0',
      precoCusto: '0,40',
    });
    const cachaca = await criarProduto({
      nome: 'CACHACA C6B',
      tipo: 'materia_prima',
      precoVenda: '0',
      precoCusto: '10',
    });
    const caipirinha = await criarProduto({
      nome: 'CAIPIRINHA C6B',
      tipo: 'produzido',
      usaFichaTecnica: true,
      precoVenda: '15',
      componentes: [{ tipo: 'ficha_tecnica', componenteId: limao, quantidade: '1' }],
    });
    const taxa = await criarProduto({
      nome: 'TAXA DE ENTREGA C6B',
      tipo: 'servico',
      controlaEstoque: false,
      precoCusto: '3,25',
    });
    await entrada([
      [limao, '100', '0.40'],
      [cachaca, '10', '10'],
    ]);
    const v = venda(p, [
      {
        produto: caipirinha,
        quantidade: '2.000',
        preco: '15.0000',
        extra: {
          componentes_estoque: [
            { produto_id: limao, variacao_id: null, quantidade: '1.000', origem: 'ficha_tecnica' },
            { produto_id: limao, variacao_id: null, quantidade: '1.000', origem: 'ficha_tecnica' },
            { produto_id: cachaca, variacao_id: null, quantidade: '0.100', origem: 'kit' },
          ],
        },
      },
      { produto: taxa, quantidade: '1.000', preco: '5.0000' },
      { produto: limao, quantidade: '1.000', extra: { cancelado: true, cancelado_em: agora() } },
    ]);
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { movimentos: 2 } });
    const movs = await movimentosDaVenda(v.vendas.id);
    expect(
      movs.map((m) => [m.produto_id, m.tipo_movimento, m.quantidade, m.documento_item_id]).sort(),
    ).toEqual(
      [
        [limao, 'BAIXA_INSUMO', '-2.000', idItem(v, 0)],
        [cachaca, 'BAIXA_INSUMO', '-0.100', idItem(v, 0)],
      ].sort(),
    );
    expect(await saldo(caipirinha)).toBe(0);
    // Caipirinha: (2 × 0,40 + 0,1 × 10) ÷ 2 = 0,90; taxa sem baixa ao custo do cadastro; item cancelado sem custo.
    expect((await itensGravados(v.vendas.id)).map((i) => i.custo_unitario)).toEqual([
      '0.9000',
      '3.2500',
      null,
    ]);
    expect((await vendaGravada(v.vendas.id))!.custo_total).toBe('5.05');
  });
});

describe('idempotência e numeração (SYNC 8.4, 13.1)', () => {
  it('reenvio do lote e a mesma venda gerada de novo não mudam nada; outro conteúdo → AGREGADO_DIVERGENTE', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV REENVIO C6B' });
    await entrada([[prod, '50', '2']]);
    const v = venda(p, [{ produto: prod, quantidade: '5.000' }]);
    const ev = evento(p, 'venda.finalizada', v);
    const lote = uuidv7();
    expect((await pushOk(p, [ev], lote))[0]).toMatchObject({ status: 'aplicado' });
    // O mesmo lote de novo: `duplicado`, nada aplicado outra vez.
    expect((await pushOk(p, [ev], lote))[0]).toMatchObject({ status: 'duplicado' });
    // O PDV gerou o evento de novo (outro `evento_id`): mesmo conteúdo → `ja_existia`.
    const [de] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(de, JSON.stringify(de)).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
    expect(await saldo(prod)).toBe(45);
    expect(await movimentosDaVenda(v.vendas.id)).toHaveLength(1);
    // Outro conteúdo com o mesmo id: divergente, e o próximo evento do lote segue.
    const outro = structuredClone(v);
    outro.itens_venda[0]!.quantidade = '6.000';
    const seguinte = venda(p, [{ produto: prod, quantidade: '1.000' }]);
    const [div, ok] = await pushOk(p, [
      evento(p, 'venda.finalizada', outro),
      evento(p, 'venda.finalizada', seguinte),
    ]);
    expect(div).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
    expect(ok).toMatchObject({ status: 'aplicado' });
    expect(await saldo(prod)).toBe(44);
  });

  it('número já usado por outra venda do caixa → erro NUMERO_VENDA_DUPLICADO, sem estoque', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV NUMERO C6B' });
    await entrada([[prod, '50', '2']]);
    const a = venda(p, [{ produto: prod, quantidade: '1.000' }]);
    const b = venda(p, [{ produto: prod, quantidade: '2.000' }], { numero: a.vendas.numero });
    const [ra, rb] = await pushOk(p, [evento(p, 'venda.finalizada', a), evento(p, 'venda.finalizada', b)]);
    expect(ra).toMatchObject({ status: 'aplicado' });
    expect(rb).toMatchObject({ status: 'rejeitado', erro: { codigo: 'NUMERO_VENDA_DUPLICADO' } });
    expect(await saldo(prod)).toBe(49);
    expect(await movimentosDaVenda(b.vendas.id)).toHaveLength(0);
    const [linha] = await consultar<{ status: string; erro_codigo: string }>(
      emp.nomeBanco,
      'select status, erro_codigo from eventos_recebidos where agregado_id = $1',
      [b.vendas.id],
    );
    expect(linha).toEqual({ status: 'erro', erro_codigo: 'NUMERO_VENDA_DUPLICADO' });
  });
});

describe('estoque da venda (SYNC 10.2, 15.1, 15.3, 15.5)', () => {
  it('duas lojas com custos diferentes: a venda muda o saldo, não a versão de produtos', async () => {
    const p = await novoPonto();
    const loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
    const [{ estoque_id: estoque2 }] = (await consultar<{ estoque_id: string }>(
      emp.nomeBanco,
      'select estoque_id from lojas where id = $1',
      [loja2],
    )) as [{ estoque_id: string }];
    const prod = await criarProduto({ nome: 'CERV DUAS LOJAS C6B' });
    await entrada([[prod, '40', '2']]);
    await entrada([[prod, '40', '3']], estoque2);
    const versao = async () =>
      (
        await consultar<{ versao: string; custo_medio: string }>(
          emp.nomeBanco,
          'select versao::text, custo_medio::text from produtos where id = $1',
          [prod],
        )
      )[0]!;
    const antes = await versao();
    const [r] = await pushOk(p, [
      evento(p, 'venda.finalizada', venda(p, [{ produto: prod, quantidade: '10.000' }])),
    ]);
    expect(r).toMatchObject({ status: 'aplicado' });
    const depois = await versao();
    // A projeção muda (o peso da loja 1 caiu), a versão não (T10): o fluxo `catalogo` não desce nada.
    expect(depois.custo_medio).not.toBe(antes.custo_medio);
    expect(depois.versao).toBe(antes.versao);
    expect(await saldo(prod, tipoPadrao, estoque2)).toBe(40);
  });

  it('estoque negativo: duas vendas sem saldo geram um alerta ESTOQUE_NEGATIVO só', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV SEM SALDO C6B' });
    const chave = `estoque_negativo:${estoqueLoja}:${prod}:`;
    const [r1, r2] = await pushOk(p, [
      evento(p, 'venda.finalizada', venda(p, [{ produto: prod, quantidade: '2.000' }])),
      evento(p, 'venda.finalizada', venda(p, [{ produto: prod, quantidade: '1.000' }])),
    ]);
    expect(r1).toMatchObject({ status: 'aplicado', resultado: { alertas: ['ESTOQUE_NEGATIVO'] } });
    expect(r2).toMatchObject({ status: 'aplicado' });
    expect(r2!.resultado).not.toHaveProperty('alertas');
    expect(await saldo(prod)).toBe(-3);
    expect(await alertasAbertos('ESTOQUE_NEGATIVO', chave)).toHaveLength(1);
  });

  it('acerto "Definir" efetivado e venda anterior à contagem chegando depois: ACERTO_COMPENSACAO, saldo = contagem', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV DEFINIR C6B' });
    await contagemInicial(prod, '50');
    // Contagem de 20 há 1 h, efetivada enquanto o caixa estava offline com vendas de 2 h atrás.
    const def = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoqueLoja,
        tipoAjuste: 'definir',
        dataContagem: horasAtras(1),
        motivo: 'Inventário',
        itens: [{ produtoId: prod, quantidade: '20' }],
      });
    expect(def.status, JSON.stringify(def.body)).toBe(201);
    await efetivar(def.body.id as string);
    expect(await saldo(prod)).toBe(20);
    // Dois itens do mesmo produto na mesma venda e uma segunda venda tardia: uma compensação por movimento (T23).
    const tardia = venda(
      p,
      [
        { produto: prod, quantidade: '2.000' },
        { produto: prod, quantidade: '1.000' },
      ],
      { finalizadaEm: horasAtras(2) },
    );
    const outraTardia = venda(p, [{ produto: prod, quantidade: '4.000' }], { finalizadaEm: horasAtras(1.5) });
    const depoisDaContagem = venda(p, [{ produto: prod, quantidade: '5.000' }]);
    const [r1, r2, r3] = await pushOk(p, [
      evento(p, 'venda.finalizada', tardia),
      evento(p, 'venda.finalizada', outraTardia),
      evento(p, 'venda.finalizada', depoisDaContagem),
    ]);
    expect(r1, JSON.stringify(r1)).toMatchObject({ status: 'aplicado', resultado: { compensacoes: 2 } });
    expect(r2).toMatchObject({ status: 'aplicado', resultado: { compensacoes: 1 } });
    expect(r3).toMatchObject({ status: 'aplicado' });
    expect(r3!.resultado).not.toHaveProperty('compensacoes');
    // A contagem já tinha "visto" as tardias: só a venda posterior à contagem baixa.
    expect(await saldo(prod)).toBe(15);
    const vendaMovs = [
      ...(await movimentosDaVenda(tardia.vendas.id)),
      ...(await movimentosDaVenda(outraTardia.vendas.id)),
    ];
    const comp = await consultar<MovimentoGravado>(
      emp.nomeBanco,
      `select id, quantidade::text, documento_tipo, documento_id, compensa_movimento_id, data_movimento,
              custo_unitario::text, tipo_movimento
         from movimentos_estoque where tipo_movimento = 'ACERTO_COMPENSACAO' and produto_id = $1`,
      [prod],
    );
    expect(comp).toHaveLength(3);
    for (const c of comp) {
      const original = vendaMovs.find((m) => m.id === c.compensa_movimento_id)!;
      expect(original, 'compensa um movimento da venda tardia').toBeDefined();
      expect(c).toMatchObject({
        documento_tipo: 'acerto',
        documento_id: def.body.id,
        custo_unitario: original.custo_unitario,
      });
      expect(Number(c.quantidade)).toBe(-Number(original.quantidade));
      expect(c.data_movimento.getTime()).toBe(original.data_movimento.getTime());
    }
    // A mesma venda gerada de novo não compensa outra vez.
    const [de] = await pushOk(p, [evento(p, 'venda.finalizada', tardia)]);
    expect(de).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
    expect(await saldo(prod)).toBe(15);
  });

  it('estoque do contexto: válido baixa nele; inativo ou excluído baixa no da loja com ESTOQUE_CONTEXTO_INVALIDO', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV CONTEXTO C6B' });
    const [{ id: outro }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome) values ('Estoque balcão C6B') returning id",
    )) as [{ id: string }];
    const [{ id: velho }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, ativo) values ('Estoque antigo C6B', false) returning id",
    )) as [{ id: string }];
    const [{ id: excluido }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, excluido_em) values ('Estoque excluído C6B', now()) returning id",
    )) as [{ id: string }];
    await entrada([[prod, '10', '2']]);
    await entrada([[prod, '10', '2']], outro);
    const contexto = (estoque: string) => ({
      contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: p.numero, estoque_id: estoque },
    });
    const [ok, fallback, semEstoque] = await pushOk(p, [
      evento(p, 'venda.finalizada', venda(p, [{ produto: prod, quantidade: '1.000' }]), contexto(outro)),
      evento(p, 'venda.finalizada', venda(p, [{ produto: prod, quantidade: '2.000' }]), contexto(velho)),
      evento(p, 'venda.finalizada', venda(p, [{ produto: prod, quantidade: '3.000' }]), contexto(excluido)),
    ]);
    expect(ok).toMatchObject({ status: 'aplicado' });
    expect(ok!.resultado).not.toHaveProperty('alertas');
    expect(fallback).toMatchObject({
      status: 'aplicado',
      resultado: { alertas: ['ESTOQUE_CONTEXTO_INVALIDO'] },
    });
    expect(semEstoque).toMatchObject({
      status: 'aplicado',
      resultado: { alertas: ['ESTOQUE_CONTEXTO_INVALIDO'] },
    });
    expect(await saldo(prod, tipoPadrao, outro)).toBe(9);
    expect(await saldo(prod)).toBe(5);
    for (const estoque of [velho, excluido]) {
      expect(
        await alertasAbertos(
          'ESTOQUE_CONTEXTO_INVALIDO',
          `estoque_contexto_invalido:${p.terminal}:${estoque}`,
        ),
      ).toHaveLength(1);
    }
  });
});

describe('cliente, sessão e dependências (SYNC 8.5, 9.7; MD 3.5.4)', () => {
  it('cliente por pessoas_aliases; relevância compra criada com toque e atualizada no máximo 1×/dia (T15)', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV CLIENTE C6B' });
    const r = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer())
      .send({ nome: 'Cliente Fiel C6B', categorias: ['cliente'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pessoa = r.body.id as string;
    const alias = uuidv7();
    await consultar(
      emp.nomeBanco,
      "insert into pessoas_aliases (alias_id, pessoa_id, motivo) values ($1, $2, 'mesclada_cpf')",
      [alias, pessoa],
    );
    const versaoPessoa = async () =>
      Number(
        (
          await consultar<{ versao: string }>(
            emp.nomeBanco,
            'select versao::text from pessoas where id = $1',
            [pessoa],
          )
        )[0]!.versao,
      );
    const relevancia = async () =>
      consultar<{ ultima_ocorrencia_em: Date; loja_id: string }>(
        emp.nomeBanco,
        "select ultima_ocorrencia_em, loja_id from pessoas_relevancia_loja where pessoa_id = $1 and motivo = 'compra' and excluido_em is null",
        [pessoa],
      );
    const antes = await versaoPessoa();
    const comCliente = (finalizadaEm: string) =>
      venda(p, [{ produto: prod, quantidade: '1.000' }], { finalizadaEm, extra: { cliente_id: alias } });
    const primeira = comCliente(horasAtras(72));
    const [r1] = await pushOk(p, [evento(p, 'venda.finalizada', primeira)]);
    expect(r1, JSON.stringify(r1)).toMatchObject({
      status: 'aplicado',
      resultado: { relevancia_compra: 'criada' },
    });
    expect((await vendaGravada(primeira.vendas.id))!.cliente_id).toBe(pessoa);
    const [mov] = await movimentosDaVenda(primeira.vendas.id);
    expect(mov!.pessoa_id).toBe(pessoa);
    expect(await versaoPessoa()).toBeGreaterThan(antes);
    const [rel] = await relevancia();
    expect(rel!.loja_id).toBe(loja);
    expect(rel!.ultima_ocorrencia_em.toISOString()).toBe(primeira.vendas.finalizada_em);
    // Menos de um dia depois: a linha fica como está (sem versão nova descendo a todos os PDVs).
    const [r2] = await pushOk(p, [evento(p, 'venda.finalizada', comCliente(horasAtras(60)))]);
    expect(r2!.resultado).not.toHaveProperty('relevancia_compra');
    expect((await relevancia())[0]!.ultima_ocorrencia_em.toISOString()).toBe(primeira.vendas.finalizada_em);
    // Mais de um dia depois: avança, sem tocar a pessoa de novo.
    const versaoAntes = await versaoPessoa();
    const terceira = comCliente(agora());
    const [r3] = await pushOk(p, [evento(p, 'venda.finalizada', terceira)]);
    expect(r3).toMatchObject({ resultado: { relevancia_compra: 'atualizada' } });
    expect((await relevancia())[0]!.ultima_ocorrencia_em.toISOString()).toBe(terceira.vendas.finalizada_em);
    expect(await versaoPessoa()).toBe(versaoAntes);
    expect(await relevancia()).toHaveLength(1);
    // Relógio do caixa adiantado (SYNC 12.3): a linha que ficou em 2028 volta, e a data nova nunca passa do agora da
    // nuvem (é o prazo de retenção da LGPD, MD 3.5.4).
    await consultar(
      emp.nomeBanco,
      `update pessoas_relevancia_loja set ultima_ocorrencia_em = '2028-06-01T12:00:00Z'
        where pessoa_id = $1 and motivo = 'compra' and excluido_em is null`,
      [pessoa],
    );
    const antesDoPush = Date.now();
    const [r4] = await pushOk(p, [evento(p, 'venda.finalizada', comCliente(horasAtras(-48)))]);
    expect(r4).toMatchObject({ resultado: { relevancia_compra: 'atualizada' } });
    const [teto] = await relevancia();
    expect(teto!.ultima_ocorrencia_em.getTime()).toBeLessThanOrEqual(Date.now());
    expect(teto!.ultima_ocorrencia_em.getTime()).toBeGreaterThanOrEqual(antesDoPush - 5_000);
  });

  it('sessão fechada à força pela nuvem (substituição): a venda tardia do terminal antigo entra (MD 3.12.1)', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV SESSAO FORCADA C6B' });
    await consultar(
      emp.nomeBanco,
      `update sessoes_caixa set status = 'fechada', fechada_em = now(), fechamento_forcado = true,
              fechamento_forcado_motivo = 'substituicao_terminal' where id = $1`,
      [p.sessao],
    );
    const v = venda(p, [{ produto: prod, quantidade: '1.000' }], { finalizadaEm: horasAtras(1) });
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    expect(await saldo(prod)).toBe(-1);
  });

  it('sessão com a abertura em erro → venda retida; sessão nunca recebida → SESSAO_INEXISTENTE; produto inexistente', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV SESSAO C6B' });
    // Abre outra sessão com a loja errada na linha (a do `novoPonto` continua aberta): `ESCOPO_INVALIDO`, a abertura
    // fica em erro e a venda dessa sessão, retida.
    const sessao = uuidv7();
    const [aberta] = await pushOk(p, [
      evento(p, 'caixa.aberto', abertura(p, sessao, { loja_id: uuidv7() }), { agregado_id: sessao }),
    ]);
    expect(aberta).toMatchObject({ status: 'rejeitado', erro: { codigo: 'ESCOPO_INVALIDO' } });
    const naSessao = venda(p, [{ produto: prod, quantidade: '1.000' }], {
      extra: { sessao_caixa_id: sessao },
    });
    const [retida] = await pushOk(p, [
      evento(p, 'venda.finalizada', naSessao, { dependencias: [] }), // a nuvem recalcula a da sessão (8.5)
    ]);
    expect(retida).toMatchObject({ status: 'retido', erro: { codigo: 'DEPENDENCIA_PENDENTE' } });
    const semSessao = venda(p, [{ produto: prod, quantidade: '1.000' }], {
      extra: { sessao_caixa_id: uuidv7() },
    });
    const [r2] = await pushOk(p, [evento(p, 'venda.finalizada', semSessao, { dependencias: [] })]);
    expect(r2).toMatchObject({ status: 'rejeitado', erro: { codigo: 'SESSAO_INEXISTENTE' } });
    const [r3] = await pushOk(p, [
      evento(p, 'venda.finalizada', venda(p, [{ produto: uuidv7(), quantidade: '1.000' }])),
    ]);
    expect(r3).toMatchObject({ status: 'rejeitado', erro: { codigo: 'REFERENCIA_INEXISTENTE' } });
    expect(await saldo(prod)).toBe(0);
  });
});

/** Combo de whisky (como o do teste do critério) com as posições e a alternativa do Monster; `sufixo` no nome. */
async function comboDeWhisky(sufixo: string) {
  const whisky = await criarProduto({ nome: `WHISKY 1L ${sufixo}`, precoCusto: '80', precoVenda: '99,90' });
  const redBull = await criarProduto({
    nome: `RED BULL 2L ${sufixo}`,
    precoCusto: '10',
    precoVenda: '24,90',
  });
  const monster = await criarProduto({ nome: `MONSTER 2L ${sufixo}`, precoCusto: '12', precoVenda: '24,90' });
  const gelo = await criarProduto({ nome: `GELO DE COCO ${sufixo}`, precoCusto: '1', precoVenda: '4,50' });
  const combo = await criarProduto({
    nome: `COMBO DE WHISKY 1L ${sufixo}`,
    tipo: 'kit',
    precoVenda: '129,90',
    componentes: [
      { tipo: 'kit', componenteId: whisky, quantidade: '1' },
      {
        tipo: 'kit',
        componenteId: redBull,
        quantidade: '1',
        rotuloPosicao: 'Energético 2L',
        permiteSubstituicao: true,
        alternativas: [{ produtoId: monster, acrescimo: '2,00' }],
      },
      { tipo: 'kit', componenteId: gelo, quantidade: '2' },
    ],
  });
  const posicoes = await consultar<{ id: string; componente_id: string }>(
    emp.nomeBanco,
    "select id, componente_id from produtos_componentes where produto_id = $1 and tipo = 'kit'",
    [combo],
  );
  const posicao = (produto: string) => posicoes.find((x) => x.componente_id === produto)!.id;
  const [{ id: alternativa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'select id from produtos_componentes_alternativas where componente_id = $1 and produto_id = $2',
    [posicao(redBull), monster],
  )) as [{ id: string }];
  return { whisky, redBull, monster, gelo, combo, posicao, alternativa };
}

const FIXTURE_VENDA = JSON.parse(
  readFileSync(new URL('venda.finalizada.payload.json', FIXTURES), 'utf8'),
) as Record<string, unknown> & { itens_venda: Payload[] };

describe('conferências sem recusa (SYNC 9.7, 16.2; P6)', () => {
  it('total diferente dos pagamentos e combo que não soma o preço: aplica com VENDA_INCONSISTENTE', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV TOTAL ERRADO C6B' });
    await entrada([[prod, '20', '2']]);
    const errada = venda(p, [{ produto: prod, quantidade: '10.000' }]);
    errada.vendas.total = '999.99'; // o pagamento é de R$ 50,00
    const k = await comboDeWhisky('INCONSISTENTE C6B');
    await entrada([
      [k.whisky, '5', '80'],
      [k.monster, '5', '12'],
      [k.gelo, '10', '1'],
    ]);
    const grupo = uuidv7();
    const doCombo = (componente: string, alt: string | null = null) => ({
      origem_preco: 'kit_rateio',
      kit_grupo_id: grupo,
      kit_produto_id: k.combo,
      kit_descricao: 'COMBO DE WHISKY 1L',
      kit_quantidade: '1.000',
      kit_preco_unitario: '131.9000',
      kit_componente_id: componente,
      kit_alternativa_id: alt,
    });
    // Os itens somam 120,00 e o combo diz 131,90; total e pagamento fecham com os itens.
    const combo = venda(p, [
      { produto: k.whisky, quantidade: '1.000', preco: '90.0000', extra: doCombo(k.posicao(k.whisky)) },
      {
        produto: k.monster,
        quantidade: '1.000',
        preco: '22.0000',
        extra: doCombo(k.posicao(k.redBull), k.alternativa),
      },
      { produto: k.gelo, quantidade: '2.000', preco: '4.0000', extra: doCombo(k.posicao(k.gelo)) },
    ]);
    const certa = venda(p, [{ produto: prod, quantidade: '1.000' }]);
    const [r1, r2, r3] = await pushOk(p, [
      evento(p, 'venda.finalizada', errada),
      evento(p, 'venda.finalizada', combo),
      evento(p, 'venda.finalizada', certa),
    ]);
    expect(r1, JSON.stringify(r1)).toMatchObject({
      status: 'aplicado',
      resultado: { alertas: ['VENDA_INCONSISTENTE'] },
    });
    expect(r2, JSON.stringify(r2)).toMatchObject({
      status: 'aplicado',
      resultado: { alertas: ['VENDA_INCONSISTENTE'] },
    });
    expect(r3!.resultado).not.toHaveProperty('alertas');
    // A venda grava como veio e baixa o estoque.
    expect(await saldo(prod)).toBe(9);
    const [a1] = await alertasAbertos('VENDA_INCONSISTENTE', `venda_inconsistente:${errada.vendas.id}`);
    expect(a1!.dados).toMatchObject({
      venda_id: errada.vendas.id,
      diferencas: [{ regra: 'pagamentos', calculado: '50.00', informado: '999.99' }],
    });
    const [a2] = await alertasAbertos('VENDA_INCONSISTENTE', `venda_inconsistente:${combo.vendas.id}`);
    expect(a2!.dados).toMatchObject({
      diferencas: [{ regra: 'kit', calculado: '131.90', informado: '120.00', kit_grupo_id: grupo }],
    });
    expect(await alertasAbertos('VENDA_INCONSISTENTE', `venda_inconsistente:${certa.vendas.id}`)).toEqual([]);
  });

  it('produto excluído ou inativo antes da venda: aplica com PRODUTO_INATIVO_VENDIDO, um por loja e produto', async () => {
    const p = await novoPonto();
    const excluido = await criarProduto({ nome: 'CERV EXCLUIDA ANTES C6B' });
    const inativo = await criarProduto({ nome: 'CERV INATIVA C6B' });
    const depois = await criarProduto({ nome: 'CERV EXCLUIDA DEPOIS C6B' });
    await entrada([
      [excluido, '10', '2'],
      [inativo, '10', '2'],
      [depois, '10', '2'],
    ]);
    await consultar(
      emp.nomeBanco,
      "update produtos set excluido_em = now() - interval '2 hours' where id = $1",
      [excluido],
    );
    await consultar(emp.nomeBanco, 'update produtos set ativo = false where id = $1', [inativo]);
    await consultar(emp.nomeBanco, 'update produtos set excluido_em = now() where id = $1', [depois]);
    // Há 1 h: o excluído há 2 h já estava fora; o inativado agora e o excluído agora ainda valiam.
    const offline = venda(
      p,
      [
        { produto: excluido, quantidade: '1.000' },
        { produto: inativo, quantidade: '1.000' },
        { produto: depois, quantidade: '1.000' },
      ],
      { finalizadaEm: horasAtras(1) },
    );
    // Depois da inativação: o inativo passa a avisar; o excluído já tem o alerta aberto.
    const seguinte = venda(p, [
      { produto: inativo, quantidade: '1.000' },
      { produto: excluido, quantidade: '1.000' },
    ]);
    const [r1, r2] = await pushOk(p, [
      evento(p, 'venda.finalizada', offline),
      evento(p, 'venda.finalizada', seguinte),
    ]);
    expect(r1, JSON.stringify(r1)).toMatchObject({
      status: 'aplicado',
      resultado: { alertas: ['PRODUTO_INATIVO_VENDIDO'] },
    });
    expect(r2, JSON.stringify(r2)).toMatchObject({
      status: 'aplicado',
      resultado: { alertas: ['PRODUTO_INATIVO_VENDIDO'] },
    });
    // Aceitas e baixadas (exclusão lógica).
    expect([await saldo(excluido), await saldo(inativo), await saldo(depois)]).toEqual([8, 8, 9]);
    const alerta = (produto: string) =>
      alertasAbertos('PRODUTO_INATIVO_VENDIDO', `produto_inativo_vendido:${loja}:${produto}`);
    const [ex] = await alerta(excluido);
    expect(ex!.dados).toMatchObject({ produto_id: excluido, excluido: true, venda_id: offline.vendas.id });
    const [ina] = await alerta(inativo);
    expect(ina!.dados).toMatchObject({ produto_id: inativo, excluido: false, venda_id: seguinte.vendas.id });
    expect(await alerta(depois)).toEqual([]);
  });

  it('produto com variações vendido sem a variação: aceita, baixa no pai e abre o CADASTRO_PRODUTO (F2-B34; D44)', async () => {
    // O PDV 0.10.0 das lojas não tem a guarda (e o da R1 com pdv.recusa_produto_com_variacoes desligada vende o pai).
    const p = await novoPonto();
    const outro = await novoPonto();
    const camiseta = await criarProduto({ nome: 'CAMISETA COM GRADE B34' });
    const legado = await criarProduto({ nome: 'CAMISA LEGADO SEM GRADE B34' });
    const bone = await criarProduto({ nome: 'BONE SIMPLES COM CODIGO DE VARIACAO B34' });
    // Com variação ativa, mas só cancelado na venda: não abre alerta.
    const regata = await criarProduto({ nome: 'REGATA COM GRADE SO CANCELADA B34' });
    // O saldo do pai antes da grade (o acerto do ERP já exige a variação do produto com variações).
    await entrada([
      [camiseta, '10', '2'],
      [legado, '10', '2'],
      [bone, '10', '2'],
      [regata, '10', '2'],
    ]);
    await consultar(emp.nomeBanco, "update produtos set tipo = 'com_variacoes' where id = any($1::uuid[])", [
      [camiseta, legado, regata],
    ]);
    await consultar(
      emp.nomeBanco,
      "insert into produtos_variacoes (produto_id, nome) values ($1, 'P'), ($2, 'P')",
      [camiseta, regata],
    );
    // O legado só tem variação inativa e excluída: vende como Simples, sem alerta (o pai sem variação ativa).
    await consultar(
      emp.nomeBanco,
      "insert into produtos_variacoes (produto_id, nome, ativo, excluido_em) values ($1, 'P', false, null), ($1, 'M', true, now())",
      [legado],
    );
    const [{ id: variacaoBone }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into produtos_variacoes (produto_id, nome) values ($1, 'AZUL') returning id",
      [bone],
    )) as [{ id: string }];
    const [{ id: codigoBone }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into produtos_codigos_barras (produto_id, variacao_id, codigo, tipo)
       values ($1, $2, '7890000034001', 'gtin') returning id`,
      [bone, variacaoBone],
    )) as [{ id: string }];
    const primeira = venda(p, [
      { produto: camiseta, quantidade: '2.000' },
      { produto: legado, quantidade: '1.000' },
      {
        produto: bone,
        quantidade: '1.000',
        extra: { codigo_barras_id: codigoBone, codigo_lido: '7890000034001' },
      },
      // O item cancelado não conta: a regata só aparece cancelada.
      { produto: regata, quantidade: '1.000', extra: { cancelado: true, cancelado_em: agora() } },
    ]);
    const [r1] = await pushOk(p, [evento(p, 'venda.finalizada', primeira)]);
    expect(r1, JSON.stringify(r1)).toMatchObject({
      status: 'aplicado',
      resultado: { alertas: ['CADASTRO_PRODUTO'] },
    });
    // A baixa é no pai (sem variação), como vendeu.
    expect([await saldo(camiseta), await saldo(legado), await saldo(bone), await saldo(regata)]).toEqual([
      8, 9, 9, 10,
    ]);
    const alerta = (produto: string) =>
      consultar<{ loja_id: string | null; titulo: string; dados: Record<string, unknown> }>(
        emp.nomeBanco,
        `select loja_id, titulo, dados from alertas
          where tipo = 'CADASTRO_PRODUTO' and chave_deduplicacao = $1 and resolvido_em is null`,
        [`cadastro:venda_sem_variacao:${produto}`],
      );
    const [cam] = await alerta(camiseta);
    expect(cam).toMatchObject({
      loja_id: null,
      titulo: 'Produto com variações vendido sem a variação: CAMISETA COM GRADE B34',
      dados: {
        tipo_alerta: 'venda_sem_variacao',
        produto_id: camiseta,
        variacao_id: null,
        lojas: [loja],
        terminal_id: p.terminal,
        detalhes: { venda_id: primeira.vendas.id, item_venda_id: idItem(primeira, 0), versao_app: '1.0.0' },
      },
    });
    const [bo] = await alerta(bone);
    expect(bo!.dados).toMatchObject({
      variacao_id: variacaoBone,
      detalhes: { item_venda_id: idItem(primeira, 2), codigo_lido: '7890000034001' },
    });
    expect(await alerta(legado)).toEqual([]);
    expect(await alerta(regata)).toEqual([]);

    // Outra venda do mesmo produto, de outro caixa da mesma loja: o alerta aberto não repete nem duplica a loja.
    const [r2] = await pushOk(outro, [
      evento(outro, 'venda.finalizada', venda(outro, [{ produto: camiseta, quantidade: '1.000' }])),
    ]);
    expect(r2, JSON.stringify(r2)).toMatchObject({ status: 'aplicado' });
    expect(r2!.resultado?.alertas).toBeUndefined();
    const abertos = await alerta(camiseta);
    expect(abertos).toHaveLength(1);
    expect(abertos[0]!.dados.lojas).toEqual([loja]);

    // Com a variação informada (o PDV da Fase 3), sem alerta novo depois de resolver o aberto.
    await consultar(emp.nomeBanco, 'update alertas set resolvido_em = now() where chave_deduplicacao = $1', [
      `cadastro:venda_sem_variacao:${camiseta}`,
    ]);
    const [{ id: variacaoP }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from produtos_variacoes where produto_id = $1',
      [camiseta],
    )) as [{ id: string }];
    const [r3] = await pushOk(p, [
      evento(
        p,
        'venda.finalizada',
        venda(p, [{ produto: camiseta, quantidade: '1.000', extra: { variacao_id: variacaoP } }]),
      ),
    ]);
    expect(r3, JSON.stringify(r3)).toMatchObject({ status: 'aplicado' });
    expect(await alerta(camiseta)).toEqual([]);
  });
});

describe('custo e estorno (SYNC 10.2, 15.3; ERP 13.5; T22, T23)', () => {
  it('ficha mista: o insumo que não controla estoque entra no custo pelo de referência (T22)', async () => {
    const p = await novoPonto();
    const cachaca = await criarProduto({
      nome: 'CACHACA MISTA C6B',
      tipo: 'materia_prima',
      precoVenda: '0',
      precoCusto: '20',
    });
    const limao = await criarProduto({
      nome: 'LIMAO SEM CONTROLE C6B',
      tipo: 'materia_prima',
      controlaEstoque: false,
      precoVenda: '0',
      precoCusto: '1,50',
    });
    const caipirinha = await criarProduto({
      nome: 'CAIPIRINHA MISTA C6B',
      tipo: 'produzido',
      usaFichaTecnica: true,
      precoVenda: '15',
      componentes: [
        { tipo: 'ficha_tecnica', componenteId: cachaca, quantidade: '0,05' },
        { tipo: 'ficha_tecnica', componenteId: limao, quantidade: '1' },
      ],
    });
    await entrada([[cachaca, '10', '20']]);
    const v = venda(p, [
      {
        produto: caipirinha,
        quantidade: '1.000',
        preco: '15.0000',
        extra: {
          componentes_estoque: [
            { produto_id: cachaca, variacao_id: null, quantidade: '0.050', origem: 'ficha_tecnica' },
            { produto_id: limao, variacao_id: null, quantidade: '1.000', origem: 'ficha_tecnica' },
          ],
        },
      },
    ]);
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    // Cachaça 0,05 × 20 = 1,00 pelo movimento + limão 1,50 pela referência = 2,50 (não 1,00).
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { custo_total: '2.50', movimentos: 1 },
    });
    expect((await itensGravados(v.vendas.id)).map((i) => i.custo_unitario)).toEqual(['2.5000']);
  });

  it('estornar o "Definir" que já compensou vendas tardias: estorna as compensações e as vendas passam a valer', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV ESTORNO DEFINIR C6B' });
    await contagemInicial(prod, '50');
    const def = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoqueLoja,
        tipoAjuste: 'definir',
        dataContagem: horasAtras(1),
        motivo: 'Inventário',
        itens: [{ produtoId: prod, quantidade: '20' }],
      });
    expect(def.status, JSON.stringify(def.body)).toBe(201);
    await efetivar(def.body.id as string);
    // Dois itens do mesmo produto: duas compensações contra o mesmo item do acerto.
    const tardia = venda(
      p,
      [
        { produto: prod, quantidade: '2.000' },
        { produto: prod, quantidade: '1.000' },
      ],
      { finalizadaEm: horasAtras(2) },
    );
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', tardia)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { compensacoes: 2 } });
    expect(await saldo(prod)).toBe(20);

    const atual = await amb.http().get(`/api/acertos/${def.body.id}`).set(bearer());
    const e = await amb
      .http()
      .post(`/api/acertos/${def.body.id}/estornar`)
      .set(bearer())
      .send({ versao: atual.body.versao, motivo: 'Contagem errada' });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    // Sem a contagem: 50 − 3 das vendas tardias, que passam a valer.
    expect(await saldo(prod)).toBe(47);
    const estornos = await consultar<{ quantidade: string; estornado: string }>(
      emp.nomeBanco,
      `select e.quantidade::text, o.tipo_movimento as estornado from movimentos_estoque e
         join movimentos_estoque o on o.id = e.estorno_de_id
        where e.tipo_movimento = 'ESTORNO_ACERTO' and e.documento_id = $1 order by e.quantidade`,
      [def.body.id],
    );
    expect(estornos).toEqual([
      { quantidade: '-2.000', estornado: 'ACERTO_COMPENSACAO' },
      { quantidade: '-1.000', estornado: 'ACERTO_COMPENSACAO' },
      { quantidade: '30.000', estornado: 'ACERTO_DEFINIR' },
    ]);
    // O "Definir" estornado não compensa mais a venda tardia que chega depois.
    const [r2] = await pushOk(p, [
      evento(
        p,
        'venda.finalizada',
        venda(p, [{ produto: prod, quantidade: '1.000' }], { finalizadaEm: horasAtras(2) }),
      ),
    ]);
    expect(r2!.resultado).not.toHaveProperty('compensacoes');
    expect(await saldo(prod)).toBe(46);
  });
});

describe('payload completo do caixa (C4; SYNC 9.7, 8.4)', () => {
  it('a fixture venda.finalizada.payload.json do C4, com os ids do ambiente: grava tudo e o reenvio é ja_existia', async () => {
    const p = await novoPonto();
    const casco = await criarProduto({
      nome: 'GARRAFA 600ML FIXTURE C6B',
      tipo: 'vasilhame',
      precoVenda: '2,50',
    });
    const brahma600 = await criarProduto({
      nome: 'CERV BRAHMA 600ML FIXTURE C6B',
      precoVenda: '9,90',
      vasilhameProdutoId: casco,
      vasilhameQuantidade: 1,
    });
    const brahmaLata = await criarProduto({
      nome: 'CERV BRAHMA LT FIXTURE C6B',
      precoVenda: '3,49',
      codigosBarras: [
        { codigo: '7891149103102', principal: true },
        { codigo: '7891149103126', unidadeId: fd, fator: '12' },
      ],
    });
    const [{ id: fardo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from produtos_codigos_barras where produto_id = $1 and fator = 12',
      [brahmaLata],
    )) as [{ id: string }];
    const agua = await criarProduto({ nome: 'AGUA CRYSTAL FIXTURE C6B', precoVenda: '2,50' });
    const k = await comboDeWhisky('FIXTURE C6B');
    await entrada([
      [brahmaLata, '24', '2.50'],
      [k.whisky, '5', '80'],
      [k.monster, '5', '12'],
      [k.gelo, '10', '1'],
      [brahma600, '5', '4'],
      [casco, '5', '1'],
    ]);
    const vendaId = uuidv7();
    // Ids da fixture (C4) → os deste ambiente; o resto (itens, pagamento, grupo do combo) fica como está.
    const ids: Record<string, string> = {
      '01a18756-bc09-76c2-b2b9-437a28df6ec4': vendaId,
      '01a18752-3782-7bda-ad3c-2d6d1a3d1fa7': loja,
      '01a18752-c8a9-7970-9641-9f828b9d2434': p.caixa,
      '01a18751-a521-7238-b924-56de3eb13b90': p.terminal,
      '01a18755-98a1-7472-96da-1dac72ff5d2a': p.sessao,
      '01a18754-76cb-7b74-b2e7-06298fadc1a6': operador,
      '01a18755-09d1-76b6-8b81-48f6b38a088c': operador,
      '01a1875e-a2ca-7299-9d65-a441d58842de': dinheiro,
      '01a1875e-101f-7741-8729-4739614ff3d7': fardo,
      '01a1875b-4061-7e2a-9e57-4f7aa0ee89ae': brahmaLata,
      '01a1875b-d10a-7312-93cd-59bf5c941cf0': agua,
      '01a18771-0b3c-7d42-8a6e-2f9c1d7e5a01': k.whisky,
      '01a18774-7d20-7b6a-9c8e-0e1f4a2b5c32': k.monster,
      '01a18777-8b0c-7a4f-9d13-3e2f1a6b9c65': k.gelo,
      '01a1875d-7f81-7ddc-bb98-2ef8daf61a26': brahma600,
      '01a1875d-11aa-7b2c-9d3e-4f5a6b7c8d04': casco,
      '01a18770-9a2e-7c11-9f3d-5b7e0c4d2a10': k.combo,
      '01a18773-1c5f-7e08-a2b4-6d9e3f0c7a21': k.posicao(k.whisky),
      '01a18775-3f8a-7c2d-8e61-1a0b9d4c6e43': k.posicao(k.redBull),
      '01a18778-2d1e-7b5a-a4c3-4f3a2b7c0d76': k.posicao(k.gelo),
      '01a18776-5a9b-7f3e-b7d2-2c1e0f5a8d54': k.alternativa,
    };
    // As horas da fixture andam juntas até agora (a partição da auditoria é a do mês corrente).
    const desvio = Date.now() - Date.parse('2026-10-29T17:36:05.123Z');
    const texto = JSON.stringify(FIXTURE_VENDA)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => ids[id] ?? id)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (t) =>
        new Date(Date.parse(t) + desvio).toISOString(),
      );
    const payload = JSON.parse(texto) as { vendas: Payload; itens_venda: Payload[] };
    payload.vendas.numero_caixa = p.numero;
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', payload)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { venda_id: vendaId } });
    expect(r!.resultado).not.toHaveProperty('alertas');
    const [cab] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select status_fiscal, qtd_itens, subtotal_bruto::text, total::text, troco::text, cpf_cnpj_nota, terminal_id,
              evento_finalizacao_id from vendas where id = $1`,
      [vendaId],
    );
    expect(cab).toEqual({
      status_fiscal: 'nao_aplicavel',
      qtd_itens: 6,
      subtotal_bruto: '182.58',
      total: '181.30',
      troco: '18.70',
      cpf_cnpj_nota: '12345678909',
      terminal_id: p.terminal,
      evento_finalizacao_id: '01a18778-08ab-7f25-b9ac-1b1ea8e56e0c',
    });
    const itens = await consultar<{ sequencia: number; cancelado: boolean; cancelado_por_id: string | null }>(
      emp.nomeBanco,
      'select sequencia, cancelado, cancelado_por_id from itens_venda where venda_id = $1 order by sequencia',
      [vendaId],
    );
    expect(itens).toHaveLength(7);
    expect(itens[1]).toEqual({ sequencia: 2, cancelado: true, cancelado_por_id: operador });
    const [pg] = await consultar<{ valor: string; troco: string; status: string }>(
      emp.nomeBanco,
      'select valor::text, troco::text, status from pagamentos_venda where venda_id = $1',
      [vendaId],
    );
    expect(pg).toEqual({ valor: '181.30', troco: '18.70', status: 'aprovado' });
    // Fardo de 12, o combo pelos componentes, o cheio e o casco cobrado; a água cancelada não baixa.
    expect([
      await saldo(brahmaLata),
      await saldo(k.whisky),
      await saldo(k.monster),
      await saldo(k.gelo),
      await saldo(brahma600),
      await saldo(casco),
      await saldo(agua),
    ]).toEqual([12, 4, 4, 8, 4, 4, 0]);
    // O caixa gera o evento de novo (mesma venda): conteúdo igual, inclusive o `fiscal_snapshot` e as colunas nulas.
    const [de] = await pushOk(p, [evento(p, 'venda.finalizada', payload)]);
    expect(de, JSON.stringify(de)).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
  });

  it('complemento_id que a nuvem não conhece é gravado nulo (FK da 0028, F2-B45); o conhecido fica; reenvio igual', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({
      nome: 'CAIPIRINHA COMPLEMENTOS F2B45',
      tipo: 'servico',
      controlaEstoque: false,
    });
    const [{ id: grupo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into produtos_grupos_complementos (produto_id, nome) values ($1, 'Fruta') returning id",
      [prod],
    )) as [{ id: string }];
    const [{ id: conhecido }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into produtos_complementos (grupo_id, descricao, preco_adicional) values ($1, 'Limão', '1.0000') returning id",
      [grupo],
    )) as [{ id: string }];
    const desconhecido = uuidv7();
    const v = venda(p, [{ produto: prod, quantidade: '1.000', preco: '12.0000' }]);
    const complemento = (complementoId: string, descricao: string) => ({
      id: uuidv7(),
      item_venda_id: idItem(v, 0),
      complemento_id: complementoId,
      grupo_nome: 'Fruta',
      descricao,
      quantidade: '1.000',
      preco_adicional: '0.0000',
    });
    const payload = {
      ...v,
      itens_venda_complementos: [
        complemento(conhecido.toUpperCase(), 'Limão'),
        complemento(desconhecido, 'Morango (opção apagada)'),
      ],
    };
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', payload)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    const gravados = await consultar<{ descricao: string; complemento_id: string | null }>(
      emp.nomeBanco,
      'select descricao, complemento_id from itens_venda_complementos where item_venda_id = $1 order by descricao',
      [idItem(v, 0)],
    );
    expect(gravados).toEqual([
      { descricao: 'Limão', complemento_id: conhecido },
      { descricao: 'Morango (opção apagada)', complemento_id: null },
    ]);
    // O reenvio do mesmo evento confere as linhas com a mesma regra: igual, sem divergência.
    const [de] = await pushOk(p, [evento(p, 'venda.finalizada', payload)]);
    expect(de, JSON.stringify(de)).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
  });

  it('TEF, PIX, complemento e parcelas: gravados e ligados à venda; reenvio ja_existia mesmo com o status mudado', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV TEF PIX C6B' });
    await entrada([[prod, '20', '2']]);
    const v = venda(p, [{ produto: prod, quantidade: '10.000', preco: '6.0000' }]); // total 60,00
    const formaDe = async (tipo: string) =>
      (
        await consultar<{ id: string }>(
          emp.nomeBanco,
          'select id from formas_pagamento where tipo_forma = $1 and excluido_em is null order by ordem limit 1',
          [tipo],
        )
      )[0]?.id ?? dinheiro;
    const [cartao, pix] = await Promise.all([formaDe('cartao_credito'), formaDe('pix')]);
    const pagCartao = uuidv7();
    const pagPix = uuidv7();
    const tef = uuidv7();
    const cobranca = uuidv7();
    const pagamento = (id: string, sequencia: number, extra: Payload) => ({
      id,
      venda_id: v.vendas.id,
      sequencia,
      descricao_forma: 'Forma',
      lanca_quitada: false,
      ...extra,
    });
    const payload = {
      ...v,
      itens_venda_complementos: [
        {
          id: uuidv7(),
          item_venda_id: idItem(v, 0),
          complemento_id: null,
          grupo_nome: 'Temperatura',
          descricao: 'Bem gelada',
          quantidade: '1.000',
          preco_adicional: '0.0000',
        },
      ],
      pagamentos_venda: [
        pagamento(pagCartao, 1, {
          forma_pagamento_id: cartao,
          meio_pagamento_fiscal: '03',
          tipo_forma: 'cartao_credito',
          valor: '40.00',
          parcelas: 2,
          tef_transacao_id: tef,
          nsu: '123456',
        }),
        pagamento(pagPix, 2, {
          forma_pagamento_id: pix,
          meio_pagamento_fiscal: '17',
          tipo_forma: 'pix',
          valor: '20.00',
          pix_cobranca_id: cobranca,
        }),
      ],
      parcelas_venda: [
        { id: uuidv7(), pagamento_venda_id: pagCartao, numero: 1, vencimento: '2026-11-30', valor: '20.00' },
        { id: uuidv7(), pagamento_venda_id: pagCartao, numero: 2, vencimento: '2026-12-30', valor: '20.00' },
      ],
      transacoes_tef: [
        {
          id: tef,
          loja_id: loja,
          terminal_id: p.terminal,
          venda_id: null,
          pagamento_venda_id: pagCartao,
          provedor: 'POS',
          operacao: 'venda',
          status: 'aprovada_pendente_confirmacao',
          valor: '40.00',
          parcelas: 2,
          nsu: '123456',
          iniciada_em: v.vendas.finalizada_em,
        },
      ],
      cobrancas_pix: [
        {
          id: cobranca,
          txid: `L01C${String(p.numero).padStart(2, '0')}000001`,
          tipo: 'estatico',
          loja_id: loja,
          terminal_id: p.terminal,
          venda_id: v.vendas.id,
          pagamento_venda_id: pagPix,
          valor: '20.00',
          status: 'paga',
          qrcode_payload: '00020126360014BR.GOV.BCB.PIX',
          paga_em: v.vendas.finalizada_em,
        },
      ],
    };
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', payload)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    expect(r!.resultado).not.toHaveProperty('alertas');
    const ligados = await consultar<{ tabela: string; venda_id: string; pagamento_venda_id: string }>(
      emp.nomeBanco,
      `select 'tef' as tabela, venda_id, pagamento_venda_id from transacoes_tef where id = $1
       union all select 'pix', venda_id, pagamento_venda_id from cobrancas_pix where id = $2`,
      [tef, cobranca],
    );
    expect(ligados).toEqual([
      { tabela: 'tef', venda_id: v.vendas.id, pagamento_venda_id: pagCartao },
      { tabela: 'pix', venda_id: v.vendas.id, pagamento_venda_id: pagPix },
    ]);
    const pagamentos = await consultar<{
      id: string;
      tef_transacao_id: string | null;
      pix_cobranca_id: string | null;
    }>(
      emp.nomeBanco,
      'select id, tef_transacao_id, pix_cobranca_id from pagamentos_venda where venda_id = $1 order by sequencia',
      [v.vendas.id],
    );
    expect(pagamentos).toEqual([
      { id: pagCartao, tef_transacao_id: tef, pix_cobranca_id: null },
      { id: pagPix, tef_transacao_id: null, pix_cobranca_id: cobranca },
    ]);
    const [contagem] = await consultar<{ parcelas: number; complementos: number }>(
      emp.nomeBanco,
      `select (select count(*)::int from parcelas_venda where pagamento_venda_id = $1) as parcelas,
              (select count(*)::int from itens_venda_complementos where item_venda_id = $2) as complementos`,
      [pagCartao, idItem(v, 0)],
    );
    expect(contagem).toEqual({ parcelas: 2, complementos: 1 });
    // A confirmação do TEF muda o status depois: o reenvio continua igual (colunas fora da comparação).
    await consultar(
      emp.nomeBanco,
      "update transacoes_tef set status = 'confirmada', confirmada_em = now() where id = $1",
      [tef],
    );
    const [de] = await pushOk(p, [evento(p, 'venda.finalizada', payload)]);
    expect(de, JSON.stringify(de)).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
    // Outro valor no PIX com o mesmo id: divergente.
    const outro = structuredClone(payload);
    outro.cobrancas_pix[0]!.qrcode_payload = '00020126360014BR.GOV.BCB.PIX.OUTRO';
    const [div] = await pushOk(p, [evento(p, 'venda.finalizada', outro)]);
    expect(div).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
    expect(await saldo(prod)).toBe(10);
  });

  it('venda de 1200 itens completos (mais de 65535 parâmetros num INSERT só) grava em blocos, casco no fim', async () => {
    const p = await novoPonto();
    const taxa = await criarProduto({ nome: 'SERVICO EM LOTE C6B', tipo: 'servico', controlaEstoque: false });
    const casco = await criarProduto({
      nome: 'CASCO LOTE C6B',
      tipo: 'vasilhame',
      controlaEstoque: false,
      precoVenda: '1,50',
    });
    // O item como o PDV manda (todas as colunas da fixture): uns 57 parâmetros cada no INSERT.
    const {
      id: _id,
      venda_id: _venda,
      sequencia: _seq,
      produto_id: _produto,
      codigo_barras_id: _codigo,
      ...completo
    } = FIXTURE_VENDA.itens_venda[5]!;
    const itens: ItemTeste[] = Array.from({ length: 1199 }, () => ({
      produto: taxa,
      quantidade: '1.000',
      preco: '9.9000',
      extra: completo,
    }));
    // O casco cobrado vem primeiro e aponta para o último item (que fica em outro bloco).
    itens.unshift({
      produto: casco,
      quantidade: '1.000',
      preco: '9.9000',
      extra: { ...completo, descricao: 'CASCO' },
    });
    const v = venda(p, itens);
    v.itens_venda[0] = { ...v.itens_venda[0]!, vasilhame_item_origem_id: idItem(v, 1199) } as never;
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(r, JSON.stringify(r).slice(0, 500)).toMatchObject({ status: 'aplicado' });
    expect(r!.resultado).not.toHaveProperty('alertas');
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from itens_venda where venda_id = $1',
      [v.vendas.id],
    )) as [{ n: number }];
    expect(n).toBe(1200);
    const [de] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(de).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
  }, 60_000);
});

describe('ordem de lançamento do razão (F2-B2)', () => {
  it('no fim da suíte, a cadeia de cada linha fecha por seq_lancamento e o replay repete o razão', async () => {
    expect(await conferirRazaoDasEmpresas(amb.bancoControle)).toBeGreaterThan(0);
  });
});
