/**
 * Handlers do bloco C7 da Fase 1C (SYNC 9.9, 9.24, 9.26, 10.4; MD 3.11, 3.12.6): o `venda.cancelada` nas formas A e B,
 * o `vasilhame.movimentado` e o `alerta.cadastro`, pelo push real. Um teste por critério do plano — cancelar o combo
 * devolve os 3 componentes ao custo original (não ao custo médio da hora); cancelar duas vezes (o reenvio do lote, o
 * cancelamento gerado de novo, outro cancelamento e a corrida com o ERP, `CANCELAMENTO_DUPLO`); a devolução avulsa de
 * cascos; o reenvio do lote — e também: o casco cobrado volta e os vazios trazidos voltam ao cliente ou ficam na loja
 * conforme `pdv.cancelamento_devolve_vazios` (D29), a ficha técnica (`ESTORNO_BAIXA_INSUMO`), o estorno pela forma de
 * cada pagamento (O22: maquininha, PIX devolvido, devolvido em dinheiro, pendente, TEF com a transação de
 * cancelamento), o estorno incompatível com o pagamento e o pagamento citado duas vezes, a venda nunca recebida, a
 * retida e a cancelada em andamento, o cancelamento anterior a um "Definir", a corrida com o ERP com um segundo
 * cancelamento, as fixtures das formas A e B do C4 aplicadas e reenviadas, o `venda.finalizada` gerado de novo depois
 * da forma A com TEF, os destinos de vasilhame da Fase 3 recusados, o casco sem estoque, o estoque do contexto
 * inválido e o produto que não é casco, o alerta de cadastro da empresa deduplicado entre lojas e a venda com os cascos
 * descontados (C11c) aplicada e cancelada. Cada teste usa um
 * caixa e um terminal só seus (`novoPonto`) e produtos próprios: roda sozinho (`-t`) e em qualquer ordem.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRATOS_EVENTOS, jcs, respostaPushSchema, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { versoesSchemaAceitas } from '../../src/sync/eventos.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';
import { conferirRazaoDasEmpresas } from './razao.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const fixture = (nome: string) => JSON.parse(readFileSync(new URL(nome, FIXTURES), 'utf8')) as unknown;
const ATIVAR = fixture('ativar.requisicao.json') as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let estoqueLoja: string;
let tokenAdmin: string;
let operador: string;
let dinheiro: string;
let credito: string;
let pix: string;
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

/** Um caixa com o seu terminal ativado pelo `/sync/ativar` real, a sessão aberta e a sequência dos eventos. */
interface Ponto {
  loja: string;
  caixa: string;
  numero: number;
  terminal: string;
  token: string;
  seq: number;
  venda: number;
  sessao: string;
}

let numeroCaixa = 0;

async function novoPonto(lojaDoPonto = loja): Promise<Ponto> {
  const numero = ++numeroCaixa;
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [lojaDoPonto, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: lojaDoPonto, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
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
    loja: lojaDoPonto,
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
        dia_operacional: '2026-10-31',
        aberta_em: horasAtras(5),
        fundo_troco: '0.00',
      },
      movimentos_caixa: [],
    }),
  ]);
  expect(aberto, JSON.stringify(aberto)).toMatchObject({ status: 'aplicado' });
  return p;
}

const linhaDoPonto = (p: Ponto) => ({
  loja_id: p.loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

/** Envelope com o agregado do contrato (C4); as dependências a nuvem recalcula do payload (SYNC 8.5). */
function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload, extra: Payload = {}) {
  const contrato = CONTRATOS_EVENTOS[tipo];
  return {
    evento_id: uuidv7(),
    sequencia: ++p.seq,
    tipo,
    versao_schema: 1,
    agregado_tipo: contrato.agregadoTipo,
    agregado_id: (contrato.agregadoId as (x: unknown) => string)(payload),
    dependencias: [],
    ocorrido_em: agora(),
    relogio_confiavel: true,
    usuario_id: operador,
    contexto: { loja_id: p.loja, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
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

interface PagamentoTeste {
  forma: string;
  tipo: string;
  valor: string;
  extra?: Payload;
}

/** Uma venda finalizada só com o que o contrato exige (C4); sem `pagamentos`, o total pago em dinheiro. */
function venda(
  p: Ponto,
  itens: ItemTeste[],
  opcoes: {
    finalizadaEm?: string;
    pagamentos?: PagamentoTeste[];
    vasilhames?: Payload[];
    numero?: number;
    extra?: Payload;
  } = {},
) {
  const id = uuidv7();
  const numero = opcoes.numero ?? ++p.venda;
  const finalizada = opcoes.finalizadaEm ?? horasAtras(1);
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
  const total = (linhas.reduce((s, l) => s + Math.round(Number(l.valor_liquido) * 100), 0) / 100).toFixed(2);
  const pagamentos = opcoes.pagamentos ?? [{ forma: dinheiro, tipo: 'dinheiro', valor: total }];
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
      subtotal_bruto: total,
      total,
      iniciada_em: finalizada,
      finalizada_em: finalizada,
      ...opcoes.extra,
    },
    itens_venda: linhas,
    pagamentos_venda: pagamentos.map((pg, n) => ({
      id: uuidv7(),
      venda_id: id,
      sequencia: n + 1,
      forma_pagamento_id: pg.forma,
      descricao_forma: pg.tipo,
      meio_pagamento_fiscal: pg.tipo === 'dinheiro' ? '01' : pg.tipo === 'pix' ? '17' : '03',
      tipo_forma: pg.tipo,
      valor: pg.valor,
      lanca_quitada: pg.tipo === 'dinheiro',
      ...pg.extra,
    })),
    cobrancas_pix: [] as Payload[],
    vasilhames: opcoes.vasilhames ?? [],
  };
}

type Venda = ReturnType<typeof venda>;

/**
 * Forma A (SYNC 9.9 A) da venda `v`: por padrão cada pagamento devolvido em dinheiro e um `estorno_venda` do total na
 * forma Dinheiro, na sessão aberta do ponto. `estornos` e `movimentos` trocam isso.
 */
function cancelamento(
  p: Ponto,
  v: Venda,
  opcoes: {
    estornos?: Array<[pagamentoId: string, estorno: string]>;
    movimentos?: Array<[forma: string, valor: string]>;
    motivo?: string;
    canceladaEm?: string;
    sessao?: string;
  } = {},
) {
  const canceladaEm = opcoes.canceladaEm ?? agora();
  const sessao = opcoes.sessao ?? p.sessao;
  const estornos =
    opcoes.estornos ?? v.pagamentos_venda.map((pg) => [pg.id, 'dinheiro_devolvido'] as [string, string]);
  const movimentos = opcoes.movimentos ?? [[dinheiro, v.vendas.total] as [string, string]];
  return {
    vendas: {
      id: v.vendas.id,
      status: 'cancelada',
      cancelada_em: canceladaEm,
      cancelada_por_id: operador,
      cancelamento_autorizado_por_id: operador,
      motivo_cancelamento: opcoes.motivo ?? '  Cliente desistiu da compra depois de pagar  ',
      cancelamento_origem: 'pdv',
    },
    sessao_caixa_cancelamento_id: sessao,
    pagamentos_venda: estornos.map(([id, estorno]) => ({ id, status: 'estornado', estorno })),
    movimentos_caixa: movimentos.map(([forma, valor]) => ({
      id: uuidv7(),
      sessao_caixa_id: sessao,
      ...linhaDoPonto(p),
      tipo: 'estorno_venda',
      forma_pagamento_id: forma,
      valor,
      operador_id: operador,
      quem_retira_usuario_id: null,
      quem_retira_nome: null,
      observacao: `Estorno da venda ${v.vendas.numero_exibicao}`,
      inf_adicionais: null,
      ocorrido_em: canceladaEm,
      autorizado_por_id: operador,
      troca_id: null,
    })),
    transacoes_tef: [] as Payload[],
  };
}

/** Devolução avulsa de cascos (SYNC 9.26), destino `entrada` por padrão. */
function devolucao(p: Ponto, casco: string, quantidade: string, extra: Payload = {}) {
  return {
    movimentos_vasilhame: {
      id: uuidv7(),
      sessao_caixa_id: p.sessao,
      loja_id: p.loja,
      caixa_id: p.caixa,
      terminal_id: p.terminal,
      operador_id: operador,
      pessoa_id: null,
      produto_vasilhame_id: casco,
      quantidade,
      destino: 'entrada',
      vale_id: null,
      ocorrido_em: horasAtras(0.5),
      ...extra,
    },
    vales: [],
    movimentos_vale: [],
  };
}

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
 * Saldo por um acerto de Entrada efetivado. A "Data" (há 3 h) fica só no cabeçalho: a Entrada lança no momento da
 * efetivação (regra de data do F2-B4), depois dos fatos já enviados; antes de um "Definir" no passado, use
 * `contagemInicial`.
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
  await efetivar(a.body.id as string);
}

/** Saldo inicial por um "Definir" `horas` atrás (lança na hora da contagem, antes dos fatos do teste). */
async function contagemInicial(produtoId: string, quantidade: string, horas: number) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId: estoqueLoja,
      tipoAjuste: 'definir',
      dataContagem: horasAtras(horas),
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

async function linhaSaldo(produto: string, tipo = tipoPadrao) {
  const [s] = await consultar<{ quantidade: string; custo_medio: string }>(
    emp.nomeBanco,
    `select quantidade::text, custo_medio::text from saldos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoqueLoja, produto, tipo],
  );
  return s ?? { quantidade: '0.000', custo_medio: '0.0000' };
}
const saldo = async (produto: string, tipo = tipoPadrao) =>
  Number((await linhaSaldo(produto, tipo)).quantidade);

interface MovimentoGravado {
  id: string;
  produto_id: string;
  tipo_estoque_id: string;
  tipo_movimento: string;
  quantidade: string;
  custo_unitario: string;
  custo_total: string;
  documento_tipo: string;
  documento_id: string;
  documento_item_id: string | null;
  estorno_de_id: string | null;
  evento_id: string | null;
  terminal_id: string | null;
  data_movimento: Date;
}

const movimentosDoDocumento = (tipo: string, id: string) =>
  consultar<MovimentoGravado>(
    emp.nomeBanco,
    `select id, produto_id, tipo_estoque_id, tipo_movimento, quantidade::text, custo_unitario::text, custo_total::text,
            documento_tipo, documento_id, documento_item_id, estorno_de_id, evento_id, terminal_id, data_movimento
       from movimentos_estoque where documento_tipo = $1 and documento_id = $2
      order by produto_id, tipo_movimento`,
    [tipo, id],
  );

const vendaGravada = async (id: string) =>
  (
    await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select status, cancelada_em, cancelada_por_id, cancelamento_autorizado_por_id, motivo_cancelamento,
              cancelamento_origem, finalizada_em, custo_total::text
         from vendas where id = $1`,
      [id],
    )
  )[0];

const statusPagamentos = async (vendaId: string) =>
  (
    await consultar<{ status: string }>(
      emp.nomeBanco,
      'select status from pagamentos_venda where venda_id = $1 order by sequencia',
      [vendaId],
    )
  ).map((x) => x.status);

const alertasAbertos = (tipo: string, chave: string) =>
  consultar<{ id: string; titulo: string; loja_id: string | null; dados: Record<string, unknown> }>(
    emp.nomeBanco,
    `select id, titulo, loja_id, dados from alertas
      where tipo = $1 and chave_deduplicacao = $2 and resolvido_em is null`,
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
  const forma = async (tipo: string) =>
    (
      (await consultar<{ id: string }>(
        emp.nomeBanco,
        'select id from formas_pagamento where tipo_forma = $1 and excluido_em is null order by ordem limit 1',
        [tipo],
      )) as [{ id: string }]
    )[0].id;
  [dinheiro, credito, pix] = await Promise.all([forma('dinheiro'), forma('cartao_credito'), forma('pix')]);
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
  it('anuncia venda.cancelada, vasilhame.movimentado e alerta.cadastro v1 em versoes_schema', () => {
    expect(versoesSchemaAceitas()).toMatchObject({
      'venda.cancelada': [1],
      'vasilhame.movimentado': [1],
      'alerta.cadastro': [1],
    });
  });
});

/** Combo de whisky (o do critério do C6b) com as posições e a alternativa do Monster; `sufixo` no nome. */
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

/** O combo de whisky com a troca pelo Monster vendido uma vez (o critério do C6b), com saldo dos componentes. */
async function vendaDoCombo(p: Ponto, sufixo: string) {
  const k = await comboDeWhisky(sufixo);
  const { whisky, redBull, monster, gelo, combo, posicao, alternativa } = k;
  await entrada([
    [whisky, '10', '80'],
    [redBull, '10', '10'],
    [monster, '10', '12'],
    [gelo, '20', '1.10'],
  ]);
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
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { custo_total: '94.20' } });
  return { ...k, v };
}

describe('venda.cancelada forma A (SYNC 9.9 A, 10.4)', () => {
  it('cancelar o combo devolve os 3 componentes ao custo original; venda, pagamento, gaveta e auditoria', async () => {
    const p = await novoPonto();
    const k = await vendaDoCombo(p, 'C7');
    // Depois da venda o custo médio muda (nova entrada mais cara): o estorno volta ao custo da saída, não ao de agora.
    await entrada([
      [k.whisky, '9', '100'],
      [k.monster, '9', '15'],
    ]);
    expect(await linhaSaldo(k.whisky)).toEqual({ quantidade: '18.000', custo_medio: '90.0000' });
    const c = cancelamento(p, k.v);
    const ev = evento(p, 'venda.cancelada', c);
    const [r] = await pushOk(p, [ev]);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { venda_id: k.v.vendas.id, movimentos: 3, movimentos_caixa: 1 },
    });
    const movs = await movimentosDoDocumento('venda', k.v.vendas.id);
    const vendas = movs.filter((m) => m.tipo_movimento === 'VENDA_PDV');
    const estornos = movs.filter((m) => m.tipo_movimento === 'CANC_VENDA_PDV');
    expect(estornos.map((m) => [m.produto_id, m.quantidade, m.custo_unitario, m.custo_total]).sort()).toEqual(
      [
        [k.whisky, '1.000', '80.0000', '80.00'],
        [k.monster, '1.000', '12.0000', '12.00'],
        [k.gelo, '2.000', '1.1000', '2.20'],
      ].sort(),
    );
    for (const e of estornos) {
      const original = vendas.find((m) => m.id === e.estorno_de_id)!;
      expect(original, 'estorna uma saída da venda').toBeDefined();
      expect(e).toMatchObject({
        produto_id: original.produto_id,
        documento_item_id: original.documento_item_id,
        evento_id: ev.evento_id,
        terminal_id: p.terminal,
      });
      expect(e.data_movimento.toISOString()).toBe(c.vendas.cancelada_em);
    }
    // T20: com saldo positivo a média recalcula como entrada ao custo da saída: (18 × 90 + 80) ÷ 19.
    expect(await linhaSaldo(k.whisky)).toEqual({ quantidade: '19.000', custo_medio: '89.4737' });
    expect([await saldo(k.monster), await saldo(k.gelo), await saldo(k.redBull)]).toEqual([19, 20, 10]);
    expect(await saldo(k.combo)).toBe(0);
    expect(await vendaGravada(k.v.vendas.id)).toMatchObject({
      status: 'cancelada',
      cancelada_por_id: operador,
      cancelamento_autorizado_por_id: operador,
      motivo_cancelamento: 'Cliente desistiu da compra depois de pagar',
      cancelamento_origem: 'pdv',
      custo_total: '94.20',
    });
    expect(await statusPagamentos(k.v.vendas.id)).toEqual(['estornado']);
    const [gaveta] = await consultar<{ tipo: string; valor: string; sessao_caixa_id: string }>(
      emp.nomeBanco,
      'select tipo, valor::text, sessao_caixa_id from movimentos_caixa where id = $1',
      [c.movimentos_caixa[0]!.id],
    );
    expect(gaveta).toEqual({ tipo: 'estorno_venda', valor: k.v.vendas.total, sessao_caixa_id: p.sessao });
    const [aud] = await consultar<{ acao: string; origem: string; evento_id: string; depois: Payload }>(
      emp.nomeBanco,
      "select acao, origem, evento_id, depois from auditoria where entidade = 'vendas' and registro_id = $1 and acao = 'cancelar'",
      [k.v.vendas.id],
    );
    expect(aud).toMatchObject({ acao: 'cancelar', origem: 'pdv', evento_id: ev.evento_id });
    expect(aud!.depois).toMatchObject({
      estornos: [{ pagamento_venda_id: k.v.pagamentos_venda[0]!.id, estorno: 'dinheiro_devolvido' }],
      movimentos_estoque: 3,
    });
  });

  it('cancelar duas vezes: reenvio do lote, o mesmo cancelamento gerado de novo e outro cancelamento divergente', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV CANCELA DUAS C7' });
    await entrada([[prod, '50', '2']]);
    const v = venda(p, [{ produto: prod, quantidade: '5.000' }]);
    await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(await saldo(prod)).toBe(45);
    const c = cancelamento(p, v);
    const ev = evento(p, 'venda.cancelada', c);
    const lote = uuidv7();
    expect((await pushOk(p, [ev], lote))[0]).toMatchObject({ status: 'aplicado' });
    // O mesmo lote de novo: `duplicado`, nada aplicado outra vez.
    expect((await pushOk(p, [ev], lote))[0]).toMatchObject({ status: 'duplicado' });
    // O caixa gerou o cancelamento de novo (outro `evento_id`, o mesmo conteúdo): `ja_existia`, sem estornar de novo.
    const [de] = await pushOk(p, [evento(p, 'venda.cancelada', c)]);
    expect(de, JSON.stringify(de)).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
    expect(await saldo(prod)).toBe(50);
    expect(
      (await movimentosDoDocumento('venda', v.vendas.id)).filter(
        (m) => m.tipo_movimento === 'CANC_VENDA_PDV',
      ),
    ).toHaveLength(1);
    // Outro cancelamento da mesma venda (outro motivo, outro movimento de gaveta): divergente, nada muda.
    const outro = cancelamento(p, v, { motivo: 'Outro motivo qualquer para cancelar' });
    const [div] = await pushOk(p, [evento(p, 'venda.cancelada', outro)]);
    expect(div).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
    // O mesmo cancelamento com um movimento de gaveta que a nuvem não tem também diverge (seria uma saída em dobro).
    const novaGaveta = structuredClone(c);
    novaGaveta.movimentos_caixa[0]!.id = uuidv7();
    const [div2] = await pushOk(p, [evento(p, 'venda.cancelada', novaGaveta)]);
    expect(div2).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
    expect(await saldo(prod)).toBe(50);
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from movimentos_caixa where tipo = 'estorno_venda' and terminal_id = $1",
      [p.terminal],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('venda já cancelada no ERP: aplica só o físico do caixa (gaveta) e cria CANCELAMENTO_DUPLO, sem estoque', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV CANCELAMENTO DUPLO C7' });
    await entrada([[prod, '20', '2']]);
    const v = venda(p, [{ produto: prod, quantidade: '2.000' }]);
    await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    // O cancelamento pelo ERP é da Fase 3: aqui ele é simulado direto no banco (estoque já estornado lá).
    await consultar(
      emp.nomeBanco,
      `update vendas set status = 'cancelada', cancelada_em = now(), cancelada_por_id = $2,
              motivo_cancelamento = 'Cancelada no ERP pelo gerente da loja', cancelamento_origem = 'erp'
        where id = $1`,
      [v.vendas.id, operador],
    );
    const c = cancelamento(p, v);
    const [r] = await pushOk(p, [evento(p, 'venda.cancelada', c)]);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { cancelamento_duplo: true, movimentos_caixa: 1, alertas: ['CANCELAMENTO_DUPLO'] },
    });
    expect(await saldo(prod)).toBe(18);
    expect(await vendaGravada(v.vendas.id)).toMatchObject({
      cancelamento_origem: 'erp',
      motivo_cancelamento: 'Cancelada no ERP pelo gerente da loja',
    });
    expect(await statusPagamentos(v.vendas.id)).toEqual(['aprovado']);
    const [alerta] = await alertasAbertos('CANCELAMENTO_DUPLO', `cancelamento_duplo:${v.vendas.id}`);
    expect(alerta!.dados).toMatchObject({
      erp: { motivo_cancelamento: 'Cancelada no ERP pelo gerente da loja' },
      pdv: {
        motivo_cancelamento: 'Cliente desistiu da compra depois de pagar',
        movimentos_caixa: [{ forma_pagamento_id: dinheiro, valor: v.vendas.total }],
      },
    });
    // O mesmo cancelamento de novo: a gaveta não sai em dobro e o alerta não repete.
    const [de] = await pushOk(p, [evento(p, 'venda.cancelada', c)]);
    expect(de, JSON.stringify(de)).toMatchObject({
      status: 'aplicado',
      resultado: { cancelamento_duplo: true, ja_existia: true },
    });
    expect(await alertasAbertos('CANCELAMENTO_DUPLO', `cancelamento_duplo:${v.vendas.id}`)).toHaveLength(1);
    // Um segundo cancelamento do caixa com outro movimento de gaveta (ou outro motivo): divergente, nada sai de novo.
    const outraGaveta = structuredClone(c);
    outraGaveta.movimentos_caixa[0]!.id = uuidv7();
    const outroMotivo = cancelamento(p, v, { motivo: 'Outro motivo qualquer para cancelar' });
    const [d1, d2] = await pushOk(p, [
      evento(p, 'venda.cancelada', outraGaveta),
      evento(p, 'venda.cancelada', outroMotivo),
    ]);
    expect(d1).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
    expect(d2).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from movimentos_caixa where tipo = 'estorno_venda' and terminal_id = $1",
      [p.terminal],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('casco cobrado volta como CANC_VENDA_PDV; os vazios trazidos voltam ao cliente ou ficam conforme a chave (D29)', async () => {
    const p = await novoPonto();
    const casco = await criarProduto({
      nome: 'CASCO 600ML C7',
      tipo: 'vasilhame',
      precoVenda: '1,50',
      precoCusto: '1',
    });
    const cheio = await criarProduto({
      nome: 'CERV ORIGINAL 600ML RET C7',
      precoVenda: '9,90',
      vasilhameProdutoId: casco,
      vasilhameQuantidade: 1,
    });
    await entrada([
      [cheio, '24', '4'],
      [casco, '10', '1'],
    ]);
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
    v.itens_venda[1] = { ...v.itens_venda[1]!, vasilhame_item_origem_id: v.itens_venda[0]!.id } as never;
    // Uma segunda venda igual, para o cancelamento com a chave desligada.
    const w = structuredClone(v);
    const novoId = (x: Venda) => {
      x.vendas.id = uuidv7();
      x.vendas.numero = ++p.venda;
      x.vendas.numero_exibicao = `L01-C${String(p.numero).padStart(2, '0')}-${String(x.vendas.numero).padStart(6, '0')}`;
      const cheioId = uuidv7();
      x.itens_venda = x.itens_venda.map((i, n) => ({
        ...i,
        id: n === 0 ? cheioId : uuidv7(),
        venda_id: x.vendas.id,
        ...(n === 1 ? { vasilhame_item_origem_id: cheioId } : {}),
      }));
      x.pagamentos_venda = x.pagamentos_venda.map((pg) => ({ ...pg, id: uuidv7(), venda_id: x.vendas.id }));
    };
    novoId(w);
    await pushOk(p, [evento(p, 'venda.finalizada', v), evento(p, 'venda.finalizada', w)]);
    expect([await saldo(cheio), await saldo(casco), await saldo(casco, tipoVazio)]).toEqual([18, 8, 4]);
    // Padrão (decisão do dono, D29): o caixa devolve os cascos ao cliente e a entrada dos vazios é estornada.
    const [r] = await pushOk(p, [evento(p, 'venda.cancelada', cancelamento(p, v))]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { movimentos: 3 } });
    expect([await saldo(cheio), await saldo(casco), await saldo(casco, tipoVazio)]).toEqual([21, 9, 2]);
    const movs = await movimentosDoDocumento('venda', v.vendas.id);
    const vazios = movs.find((m) => m.tipo_movimento === 'VASILHAME_DEVOLVIDO')!;
    expect(movs.find((m) => m.tipo_movimento === 'ESTORNO_VASILHAME_DEVOLVIDO')).toMatchObject({
      produto_id: casco,
      tipo_estoque_id: tipoVazio,
      quantidade: '-2.000',
      estorno_de_id: vazios.id,
      documento_item_id: vazios.documento_item_id,
    });
    // Com a chave desligada na loja, os vazios ficam: só o cheio e o casco cobrado voltam.
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, loja_id, chave, valor)
       values ('loja', $1, 'pdv.cancelamento_devolve_vazios', 'false'::jsonb)`,
      [loja],
    );
    try {
      const [r2] = await pushOk(p, [evento(p, 'venda.cancelada', cancelamento(p, w))]);
      expect(r2, JSON.stringify(r2)).toMatchObject({ status: 'aplicado', resultado: { movimentos: 2 } });
      expect([await saldo(cheio), await saldo(casco), await saldo(casco, tipoVazio)]).toEqual([24, 10, 2]);
      const [aud] = await consultar<{ depois: Payload }>(
        emp.nomeBanco,
        "select depois from auditoria where entidade = 'vendas' and registro_id = $1 and acao = 'cancelar'",
        [w.vendas.id],
      );
      expect(aud!.depois).toMatchObject({ devolve_vazios: false, movimentos_estoque: 2 });
    } finally {
      await consultar(
        emp.nomeBanco,
        `update configuracoes set excluido_em = now()
          where chave = 'pdv.cancelamento_devolve_vazios' and loja_id = $1 and excluido_em is null`,
        [loja],
      );
    }
  });

  it('cascos descontados na venda (C11c, fixture do PDV): desconto de origem cliente, 5 vazios; o cancelamento devolve os 5', async () => {
    const p = await novoPonto();
    const casco = await criarProduto({
      nome: 'GARRAFA 600ML C11C',
      tipo: 'vasilhame',
      precoVenda: '2,50',
      precoCusto: '1',
    });
    const cheio = await criarProduto({
      nome: 'CERV BRAHMA 600ML C11C',
      precoVenda: '9,90',
      vasilhameProdutoId: casco,
      vasilhameQuantidade: 1,
    });
    const lata = await criarProduto({ nome: 'CERV BRAHMA LT C11C', precoVenda: '3,49' });
    await entrada([
      [cheio, '10', '4'],
      [lata, '12', '2'],
    ]);
    const vendaId = uuidv7();
    const ids: Record<string, string> = {
      '01a187b0-1d2e-7f30-8a41-5b6c7d8e9f02': vendaId,
      '01a18752-3782-7bda-ad3c-2d6d1a3d1fa7': loja,
      '01a18752-c8a9-7970-9641-9f828b9d2434': p.caixa,
      '01a18751-a521-7238-b924-56de3eb13b90': p.terminal,
      '01a18755-98a1-7472-96da-1dac72ff5d2a': p.sessao,
      '01a18754-76cb-7b74-b2e7-06298fadc1a6': operador,
      '01a1875e-a2ca-7299-9d65-a441d58842de': dinheiro,
      '01a1875d-7f81-7ddc-bb98-2ef8daf61a26': cheio,
      '01a1875b-4061-7e2a-9e57-4f7aa0ee89ae': lata,
      '01a1875d-11aa-7b2c-9d3e-4f5a6b7c8d04': casco,
    };
    const desvio = Date.now() - Date.parse('2026-10-29T17:33:02.114Z');
    const v = JSON.parse(
      JSON.stringify(fixture('venda.finalizada.cascos.payload.json'))
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => ids[id] ?? id)
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (t) =>
          new Date(Date.parse(t) + desvio).toISOString(),
        ),
    ) as Venda;
    v.vendas.numero_caixa = p.numero;
    // O crédito dos cascos é um desconto no total comum: o contrato e o handler do C6b não mudaram.
    const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { venda_id: vendaId, movimentos: 3 },
    });
    expect(r!.resultado).not.toHaveProperty('alertas');
    const [cab] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select desconto_total::text, desconto_total_pct, desconto_total_origem, total::text from vendas where id = $1`,
      [vendaId],
    );
    expect(cab).toEqual({
      desconto_total: '7.50',
      desconto_total_pct: null,
      desconto_total_origem: 'cliente',
      total: '33.24',
    });
    // 2 trazidos com as cervejas + 3 descontados: um VASILHAME_DEVOLVIDO de 5 no tipo vasilhame_vazio.
    expect([
      await saldo(cheio),
      await saldo(lata),
      await saldo(casco),
      await saldo(casco, tipoVazio),
    ]).toEqual([8, 6, 0, 5]);

    // D29 (padrão): o cancelamento devolve ao cliente os 5 vazios e o que ele pagou (33,24, já com o crédito).
    const [c] = await pushOk(p, [evento(p, 'venda.cancelada', cancelamento(p, v))]);
    expect(c, JSON.stringify(c)).toMatchObject({
      status: 'aplicado',
      resultado: { movimentos: 3, movimentos_caixa: 1 },
    });
    expect([await saldo(cheio), await saldo(lata), await saldo(casco, tipoVazio)]).toEqual([10, 12, 0]);
    expect(
      (await movimentosDoDocumento('venda', vendaId)).find(
        (m) => m.tipo_movimento === 'ESTORNO_VASILHAME_DEVOLVIDO',
      ),
    ).toMatchObject({ produto_id: casco, quantidade: '-5.000' });
    const [estorno] = await consultar<{ valor: string }>(
      emp.nomeBanco,
      `select valor::text from movimentos_caixa where tipo = 'estorno_venda' and terminal_id = $1`,
      [p.terminal],
    );
    expect(estorno).toEqual({ valor: '33.24' });
  });

  it('estorno pela forma (O22): maquininha, PIX devolvido, devolvido em dinheiro e pendente com ESTORNO_PENDENTE', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV ESTORNO FORMAS C7' });
    await entrada([[prod, '50', '2']]);
    // R$ 105,00: 25 em dinheiro, 40 no crédito POS, 40 em PIX.
    const cobranca = uuidv7();
    const v = venda(p, [{ produto: prod, quantidade: '21.000' }], {
      pagamentos: [
        { forma: dinheiro, tipo: 'dinheiro', valor: '25.00' },
        { forma: credito, tipo: 'cartao_credito', valor: '40.00' },
        { forma: pix, tipo: 'pix', valor: '40.00', extra: { pix_cobranca_id: cobranca } },
      ],
    });
    v.cobrancas_pix = [
      {
        id: cobranca,
        txid: `L01C${String(p.numero).padStart(2, '0')}000001`,
        tipo: 'estatico',
        loja_id: loja,
        terminal_id: p.terminal,
        venda_id: v.vendas.id,
        pagamento_venda_id: v.pagamentos_venda[2]!.id,
        valor: '40.00',
        status: 'paga',
        qrcode_payload: '00020126360014BR.GOV.BCB.PIX',
        paga_em: v.vendas.finalizada_em,
      },
    ];
    const [fin] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(fin, JSON.stringify(fin)).toMatchObject({ status: 'aplicado' });
    const [pgDinheiro, pgCredito, pgPix] = v.pagamentos_venda.map((pg) => pg.id) as [string, string, string];
    // O dinheiro volta em dinheiro, o crédito é cancelado na maquininha e o PIX devolvido pelo app do banco: uma
    // linha `estorno_venda` por forma (só a do dinheiro sai da gaveta) e a cobrança PIX marcada devolvida.
    const c = cancelamento(p, v, {
      estornos: [
        [pgDinheiro, 'dinheiro_devolvido'],
        [pgCredito, 'pos_cancelado_na_maquininha'],
        [pgPix, 'pix_devolucao_manual'],
      ],
      movimentos: [
        [dinheiro, '25.00'],
        [credito, '40.00'],
        [pix, '40.00'],
      ],
    });
    const [r] = await pushOk(p, [evento(p, 'venda.cancelada', c)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { movimentos_caixa: 3 } });
    expect(await saldo(prod)).toBe(50);
    expect(await statusPagamentos(v.vendas.id)).toEqual(['estornado', 'estornado', 'estornado']);
    const [cob] = await consultar<{ status: string; valor_devolvido: string }>(
      emp.nomeBanco,
      'select status, valor_devolvido::text from cobrancas_pix where id = $1',
      [cobranca],
    );
    expect(cob).toEqual({ status: 'devolvida', valor_devolvido: '40.00' });

    // Outra venda: o crédito devolvido em dinheiro (a transação continua valendo, O22) e o PIX com a devolução pendente
    // (a cobrança fica paga).
    const cobranca2 = uuidv7();
    const w = venda(p, [{ produto: prod, quantidade: '16.000' }], {
      pagamentos: [
        { forma: credito, tipo: 'cartao_credito', valor: '40.00' },
        { forma: pix, tipo: 'pix', valor: '40.00', extra: { pix_cobranca_id: cobranca2 } },
      ],
    });
    w.cobrancas_pix = [
      {
        ...v.cobrancas_pix[0]!,
        id: cobranca2,
        txid: `L01C${p.numero}000002`,
        venda_id: w.vendas.id,
        pagamento_venda_id: w.pagamentos_venda[1]!.id,
      },
    ];
    await pushOk(p, [evento(p, 'venda.finalizada', w)]);
    const [r2] = await pushOk(p, [
      evento(
        p,
        'venda.cancelada',
        cancelamento(p, w, {
          estornos: [
            [w.pagamentos_venda[0]!.id, 'devolvido_em_dinheiro'],
            [w.pagamentos_venda[1]!.id, 'pix_devolucao_pendente'],
          ],
          movimentos: [[dinheiro, '40.00']],
        }),
      ),
    ]);
    expect(r2, JSON.stringify(r2)).toMatchObject({
      status: 'aplicado',
      resultado: { alertas: ['ESTORNO_PENDENTE'] },
    });
    const [cob2] = await consultar<{ status: string }>(
      emp.nomeBanco,
      'select status from cobrancas_pix where id = $1',
      [cobranca2],
    );
    expect(cob2).toEqual({ status: 'paga' });
    expect(await alertasAbertos('ESTORNO_PENDENTE', `estorno_pendente:${w.vendas.id}`)).toHaveLength(1);
    // Incompatível com a forma gravada: `devolvido_em_dinheiro` num pagamento em dinheiro e `dinheiro_devolvido` no
    // crédito → PAYLOAD_INVALIDO, nada muda. O cancelamento rejeitado segura a venda (dependência do agregado, SYNC
    // 8.5): o corrigido fica retido até a fila de decisão resolver o primeiro (C8).
    const z = venda(p, [{ produto: prod, quantidade: '1.000' }]);
    const y = venda(p, [{ produto: prod, quantidade: '2.000' }], {
      pagamentos: [{ forma: credito, tipo: 'cartao_credito', valor: '10.00' }],
    });
    await pushOk(p, [evento(p, 'venda.finalizada', z), evento(p, 'venda.finalizada', y)]);
    const [ez, ey, ey2] = await pushOk(p, [
      evento(
        p,
        'venda.cancelada',
        cancelamento(p, z, { estornos: [[z.pagamentos_venda[0]!.id, 'devolvido_em_dinheiro']] }),
      ),
      evento(p, 'venda.cancelada', cancelamento(p, y, { movimentos: [[credito, '10.00']] })),
      evento(
        p,
        'venda.cancelada',
        cancelamento(p, y, {
          estornos: [[y.pagamentos_venda[0]!.id, 'pos_cancelado_na_maquininha']],
          movimentos: [[credito, '10.00']],
        }),
      ),
    ]);
    expect(ez).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    expect(ey).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    expect(ey2).toMatchObject({ status: 'retido', erro: { codigo: 'DEPENDENCIA_PENDENTE' } });
    expect(await saldo(prod)).toBe(47);
  });

  it('venda nunca recebida → TRANSICAO_INVALIDA; venda em erro → cancelamento retido; venda em andamento → B', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV CANCELA SEM VENDA C7' });
    await entrada([[prod, '20', '2']]);
    const nunca = venda(p, [{ produto: prod, quantidade: '1.000' }]);
    const [r1] = await pushOk(p, [evento(p, 'venda.cancelada', cancelamento(p, nunca))]);
    expect(r1).toMatchObject({ status: 'rejeitado', erro: { codigo: 'TRANSICAO_INVALIDA' } });
    // Venda com número repetido vai a `erro`: o cancelamento dela fica retido atrás (dependência do agregado `venda`).
    const a = venda(p, [{ produto: prod, quantidade: '1.000' }]);
    const b = venda(p, [{ produto: prod, quantidade: '2.000' }], { numero: a.vendas.numero });
    await pushOk(p, [evento(p, 'venda.finalizada', a)]);
    const [rb, rc] = await pushOk(p, [
      evento(p, 'venda.finalizada', b),
      evento(p, 'venda.cancelada', cancelamento(p, b)),
    ]);
    expect(rb).toMatchObject({ status: 'rejeitado', erro: { codigo: 'NUMERO_VENDA_DUPLICADO' } });
    expect(rc).toMatchObject({ status: 'retido', erro: { codigo: 'DEPENDENCIA_PENDENTE' } });
    // Sessão do cancelamento nunca recebida.
    const [rs] = await pushOk(p, [evento(p, 'venda.cancelada', cancelamento(p, a, { sessao: uuidv7() }))]);
    expect(rs).toMatchObject({ status: 'rejeitado', erro: { codigo: 'SESSAO_INEXISTENTE' } });
    expect(await saldo(prod)).toBe(19);
    expect((await vendaGravada(a.vendas.id))!.status).toBe('finalizada');
  });

  it('cancelamento anterior a um "Definir" chegando depois: o estorno é compensado e o saldo fica na contagem', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV CANCELA DEFINIR C7' });
    await contagemInicial(prod, '50', 4);
    const v = venda(p, [{ produto: prod, quantidade: '5.000' }], { finalizadaEm: horasAtras(3) });
    await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    // A contagem de há 1 h já viu a venda e o cancelamento (de há 2 h), que só chega agora.
    const def = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoqueLoja,
        tipoAjuste: 'definir',
        dataContagem: horasAtras(1),
        motivo: 'Inventário',
        itens: [{ produtoId: prod, quantidade: '50' }],
      });
    expect(def.status, JSON.stringify(def.body)).toBe(201);
    await efetivar(def.body.id as string);
    expect(await saldo(prod)).toBe(50);
    const [r] = await pushOk(p, [
      evento(p, 'venda.cancelada', cancelamento(p, v, { canceladaEm: horasAtras(2) })),
    ]);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { movimentos: 1, compensacoes: 1 },
    });
    expect(await saldo(prod)).toBe(50);
  });
  it('a fixture da forma A do C4 com os ids do ambiente: colunas, status_fiscal, 2 estorno_venda; reenvio ja_existia', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV FIXTURE A C7' });
    await entrada([[prod, '50', '2']]);
    // R$ 80,00: 15 em dinheiro, 40 no crédito POS e 25 em PIX. A fixture devolve o dinheiro e o PIX em dinheiro (uma
    // linha de R$ 40,00 na forma Dinheiro) e cancela o crédito na maquininha (R$ 40,00 na forma do cartão).
    const v = venda(p, [{ produto: prod, quantidade: '16.000' }], {
      pagamentos: [
        { forma: dinheiro, tipo: 'dinheiro', valor: '15.00' },
        { forma: credito, tipo: 'cartao_credito', valor: '40.00' },
        { forma: pix, tipo: 'pix', valor: '25.00' },
      ],
      extra: { status_fiscal: 'pendente' },
    });
    expect((await pushOk(p, [evento(p, 'venda.finalizada', v)]))[0]).toMatchObject({ status: 'aplicado' });
    const [pg1, pg2, pg3] = v.pagamentos_venda.map((pg) => pg.id) as [string, string, string];
    const ids: Record<string, string> = {
      '01a18787-4a31-7ced-b171-0434134c6c92': v.vendas.id,
      '01a18788-67c3-78a7-bfd0-f9d5a6f2f7b8': pg1,
      '01a18788-f3a1-7c5e-8d24-6b7a8c9d0e12': pg2,
      '01a18789-2b4c-7d6e-9f80-a1b2c3d4e5f6': pg3,
      '01a18793-b480-79e8-8a2c-827e98326856': uuidv7(),
      '01a18793-c5d6-7e8f-9a0b-1c2d3e4f5a60': uuidv7(),
      '01a18752-3782-7bda-ad3c-2d6d1a3d1fa7': loja,
      '01a18752-c8a9-7970-9641-9f828b9d2434': p.caixa,
      '01a18751-a521-7238-b924-56de3eb13b90': p.terminal,
      '01a18755-98a1-7472-96da-1dac72ff5d2a': p.sessao,
      '01a18754-76cb-7b74-b2e7-06298fadc1a6': operador,
      '01a18755-09d1-76b6-8b81-48f6b38a088c': operador,
      '01a1875e-a2ca-7299-9d65-a441d58842de': dinheiro,
      '01a1875f-c261-7aef-afc8-9849b3aa7efe': credito,
    };
    const canceladaEm = agora();
    const payload = JSON.parse(
      JSON.stringify(fixture('venda.cancelada.finalizada.payload.json'))
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => ids[id] ?? id)
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, () => canceladaEm),
    ) as { vendas: Payload; movimentos_caixa: Payload[] };
    for (const m of payload.movimentos_caixa) m.numero_caixa = p.numero;
    // Nenhum id da fixture sobrou sem o equivalente deste ambiente.
    expect(JSON.stringify(payload)).not.toMatch(/01a187/);
    const [r] = await pushOk(p, [evento(p, 'venda.cancelada', payload)]);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { venda_id: v.vendas.id, movimentos: 1, movimentos_caixa: 2 },
    });
    expect(await saldo(prod)).toBe(50);
    expect(await vendaGravada(v.vendas.id)).toMatchObject({
      status: 'cancelada',
      cancelada_por_id: operador,
      cancelamento_autorizado_por_id: operador,
      motivo_cancelamento: 'Cliente desistiu da compra apos o pagamento',
      cancelamento_origem: 'pdv',
    });
    const [{ status_fiscal }] = (await consultar<{ status_fiscal: string }>(
      emp.nomeBanco,
      'select status_fiscal from vendas where id = $1',
      [v.vendas.id],
    )) as [{ status_fiscal: string }];
    expect(status_fiscal).toBe('nao_aplicavel');
    expect(await statusPagamentos(v.vendas.id)).toEqual(['estornado', 'estornado', 'estornado']);
    const gaveta = await consultar<{ forma_pagamento_id: string; valor: string; cancelado: boolean }>(
      emp.nomeBanco,
      `select forma_pagamento_id, valor::text, cancelado from movimentos_caixa
        where tipo = 'estorno_venda' and terminal_id = $1 order by forma_pagamento_id = $2 desc`,
      [p.terminal, dinheiro],
    );
    expect(gaveta).toEqual([
      { forma_pagamento_id: dinheiro, valor: '40.00', cancelado: false },
      { forma_pagamento_id: credito, valor: '40.00', cancelado: false },
    ]);
    // Gerado de novo (outro evento_id, o mesmo payload): nada estornado de novo.
    const [de] = await pushOk(p, [evento(p, 'venda.cancelada', payload)]);
    expect(de, JSON.stringify(de)).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
    expect(await saldo(prod)).toBe(50);
  });

  it('TEF cancelado: a transação de cancelamento fica na venda e o venda.finalizada gerado de novo continua ja_existia', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV TEF CANCELADO C7' });
    await entrada([[prod, '20', '2']]);
    const tef = uuidv7();
    const v = venda(p, [{ produto: prod, quantidade: '8.000' }], {
      pagamentos: [
        { forma: credito, tipo: 'cartao_credito', valor: '40.00', extra: { tef_transacao_id: tef } },
      ],
    });
    const pg = v.pagamentos_venda[0]!.id;
    const transacao = (extra: Payload & { id: string }) => ({
      loja_id: loja,
      terminal_id: p.terminal,
      venda_id: null,
      pagamento_venda_id: pg,
      provedor: 'TEF',
      valor: '40.00',
      iniciada_em: v.vendas.finalizada_em,
      ...extra,
    });
    const finalizada = {
      ...v,
      transacoes_tef: [transacao({ id: tef, operacao: 'venda', status: 'confirmada' })],
    };
    const [fin] = await pushOk(p, [evento(p, 'venda.finalizada', finalizada)]);
    expect(fin, JSON.stringify(fin)).toMatchObject({ status: 'aplicado' });
    const comTef = (operacao: string) => ({
      ...cancelamento(p, v, { estornos: [[pg, 'tef_cancelado']], movimentos: [[credito, '40.00']] }),
      transacoes_tef: [
        transacao({
          id: uuidv7(),
          operacao,
          status: 'confirmada',
          transacao_original_id: tef,
          iniciada_em: agora(),
        }),
      ],
    });
    // A transação do payload da forma A é a de cancelamento (outra venda: a recusada reteria os seguintes desta).
    const outra = venda(p, [{ produto: prod, quantidade: '1.000' }], {
      pagamentos: [{ forma: credito, tipo: 'cartao_credito', valor: '5.00' }],
    });
    await pushOk(p, [evento(p, 'venda.finalizada', outra)]);
    const [ruim] = await pushOk(p, [
      evento(p, 'venda.cancelada', {
        ...cancelamento(p, outra, {
          estornos: [[outra.pagamentos_venda[0]!.id, 'pos_cancelado_na_maquininha']],
          movimentos: [[credito, '5.00']],
        }),
        transacoes_tef: [
          {
            ...transacao({ id: uuidv7(), operacao: 'venda', status: 'confirmada', iniciada_em: agora() }),
            pagamento_venda_id: outra.pagamentos_venda[0]!.id,
          },
        ],
      }),
    ]);
    expect(ruim, JSON.stringify(ruim)).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'PAYLOAD_INVALIDO' },
    });
    const c = comTef('cancelamento');
    const [r] = await pushOk(p, [evento(p, 'venda.cancelada', c)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { movimentos: 1 } });
    const transacoes = await consultar<{ id: string; operacao: string; status: string; venda_id: string }>(
      emp.nomeBanco,
      'select id, operacao, status, venda_id from transacoes_tef where venda_id = $1 order by operacao desc',
      [v.vendas.id],
    );
    expect(transacoes).toEqual([
      { id: tef, operacao: 'venda', status: 'cancelada', venda_id: v.vendas.id },
      { id: c.transacoes_tef[0]!.id, operacao: 'cancelamento', status: 'confirmada', venda_id: v.vendas.id },
    ]);
    // SYNC 8.4 camada 2: o venda.finalizada gerado de novo (outro evento_id) não diverge pela TEF de cancelamento.
    const [de] = await pushOk(p, [evento(p, 'venda.finalizada', finalizada)]);
    expect(de, JSON.stringify(de)).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
    // Uma TEF de venda que o documento não trouxe continua divergente.
    const semTef = { ...finalizada, transacoes_tef: [] };
    const [div] = await pushOk(p, [evento(p, 'venda.finalizada', semTef)]);
    expect(div).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
  });

  it('pagamento citado duas vezes e devolução em dinheiro sem a linha na forma Dinheiro → PAYLOAD_INVALIDO', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV PAGAMENTO DUPLICADO C7' });
    await entrada([[prod, '20', '2']]);
    const cartao = () =>
      venda(p, [{ produto: prod, quantidade: '2.000' }], {
        pagamentos: [{ forma: credito, tipo: 'cartao_credito', valor: '10.00' }],
      });
    const [a, b] = [cartao(), cartao()];
    await pushOk(p, [evento(p, 'venda.finalizada', a), evento(p, 'venda.finalizada', b)]);
    // O mesmo cartão cancelado na maquininha e também devolvido em dinheiro: a devolução contada duas vezes.
    const pa = a.pagamentos_venda[0]!.id;
    const [ra, rb] = await pushOk(p, [
      evento(
        p,
        'venda.cancelada',
        cancelamento(p, a, {
          estornos: [
            [pa, 'pos_cancelado_na_maquininha'],
            [pa, 'devolvido_em_dinheiro'],
          ],
          movimentos: [
            [credito, '10.00'],
            [dinheiro, '10.00'],
          ],
        }),
      ),
      // Devolvido em dinheiro, mas a linha de estorno_venda está na forma do cartão (não saiu da gaveta).
      evento(
        p,
        'venda.cancelada',
        cancelamento(p, b, {
          estornos: [[b.pagamentos_venda[0]!.id, 'devolvido_em_dinheiro']],
          movimentos: [[credito, '10.00']],
        }),
      ),
    ]);
    expect(ra, JSON.stringify(ra)).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'PAYLOAD_INVALIDO' },
    });
    expect(rb, JSON.stringify(rb)).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'PAYLOAD_INVALIDO' },
    });
    expect(await saldo(prod)).toBe(16);
    expect(await statusPagamentos(a.vendas.id)).toEqual(['aprovado']);
  });

  it('ficha técnica: cada BAIXA_INSUMO volta como ESTORNO_BAIXA_INSUMO ao custo da baixa; o produzido segue sem saldo', async () => {
    const p = await novoPonto();
    const limao = await criarProduto({
      nome: 'LIMAO C7',
      tipo: 'materia_prima',
      precoVenda: '0',
      precoCusto: '0,40',
    });
    const cachaca = await criarProduto({
      nome: 'CACHACA C7',
      tipo: 'materia_prima',
      precoVenda: '0',
      precoCusto: '10',
    });
    const caipirinha = await criarProduto({
      nome: 'CAIPIRINHA C7',
      tipo: 'produzido',
      usaFichaTecnica: true,
      precoVenda: '15',
      componentes: [
        { tipo: 'ficha_tecnica', componenteId: limao, quantidade: '1' },
        { tipo: 'ficha_tecnica', componenteId: cachaca, quantidade: '0,05' },
      ],
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
            { produto_id: limao, variacao_id: null, quantidade: '2.000', origem: 'ficha_tecnica' },
            { produto_id: cachaca, variacao_id: null, quantidade: '0.100', origem: 'ficha_tecnica' },
          ],
        },
      },
    ]);
    await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    // Depois da venda o custo do limão muda: o estorno volta ao custo da baixa, não ao de agora.
    await entrada([[limao, '98', '0.60']]);
    expect([await saldo(limao), await saldo(cachaca)]).toEqual([196, 9.9]);
    const [r] = await pushOk(p, [evento(p, 'venda.cancelada', cancelamento(p, v))]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { movimentos: 2 } });
    const movs = await movimentosDoDocumento('venda', v.vendas.id);
    const baixas = movs.filter((m) => m.tipo_movimento === 'BAIXA_INSUMO');
    const estornos = movs.filter((m) => m.tipo_movimento === 'ESTORNO_BAIXA_INSUMO');
    expect(estornos.map((m) => [m.produto_id, m.quantidade, m.custo_unitario]).sort()).toEqual(
      [
        [limao, '2.000', '0.4000'],
        [cachaca, '0.100', '10.0000'],
      ].sort(),
    );
    for (const e of estornos) {
      const baixa = baixas.find((m) => m.id === e.estorno_de_id)!;
      expect(baixa, 'estorna uma baixa da venda').toBeDefined();
      expect(e).toMatchObject({ produto_id: baixa.produto_id, documento_item_id: baixa.documento_item_id });
    }
    expect([await saldo(limao), await saldo(cachaca), await saldo(caipirinha)]).toEqual([198, 10, 0]);
  });

  it('forma A sobre a venda cancelada em andamento (forma B) → TRANSICAO_INVALIDA, nada muda', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV B DEPOIS A C7' });
    await entrada([[prod, '10', '2']]);
    const v = venda(p, [{ produto: prod, quantidade: '1.000' }]);
    const b = {
      ...v,
      vendas: {
        ...v.vendas,
        status: 'cancelada',
        finalizada_em: null,
        cancelada_em: agora(),
        cancelada_por_id: operador,
        motivo_cancelamento: 'Cliente desistiu antes de pagar',
        cancelamento_origem: 'pdv',
      },
      pagamentos_venda: [],
    };
    const [rb] = await pushOk(p, [evento(p, 'venda.cancelada', b)]);
    expect(rb, JSON.stringify(rb)).toMatchObject({ status: 'aplicado', resultado: { em_andamento: true } });
    const [ra] = await pushOk(p, [
      evento(p, 'venda.cancelada', cancelamento(p, v, { estornos: [], movimentos: [] })),
    ]);
    expect(ra, JSON.stringify(ra)).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'TRANSICAO_INVALIDA' },
    });
    expect(await vendaGravada(v.vendas.id)).toMatchObject({
      status: 'cancelada',
      finalizada_em: null,
      motivo_cancelamento: 'Cliente desistiu antes de pagar',
    });
    expect(await saldo(prod)).toBe(10);
  });
});

describe('venda.cancelada forma B (SYNC 9.9 B)', () => {
  it('a fixture do C4 com os ids do ambiente: grava a venda cancelada sem estoque; numeração; reenvio ja_existia', async () => {
    const p = await novoPonto();
    const casco = await criarProduto({
      nome: 'GARRAFA 600ML FIXTURE B C7',
      tipo: 'vasilhame',
      precoVenda: '2,50',
    });
    const brahma600 = await criarProduto({
      nome: 'CERV BRAHMA 600ML FIXTURE B C7',
      precoVenda: '9,90',
      vasilhameProdutoId: casco,
      vasilhameQuantidade: 1,
    });
    const brahmaLata = await criarProduto({
      nome: 'CERV BRAHMA LT FIXTURE B C7',
      precoVenda: '3,49',
      codigosBarras: [
        { codigo: '7891149103133', principal: true },
        { codigo: '7891149103140', unidadeId: fd, fator: '12' },
      ],
    });
    const [{ id: fardo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from produtos_codigos_barras where produto_id = $1 and fator = 12',
      [brahmaLata],
    )) as [{ id: string }];
    const agua = await criarProduto({ nome: 'AGUA CRYSTAL FIXTURE B C7', precoVenda: '2,50' });
    const k = await comboDeWhisky('FIXTURE B C7');
    // Ids da fixture (C4, os mesmos da venda finalizada) → os deste ambiente; o resto fica como está.
    const ids: Record<string, string> = {
      '01a18756-bc09-76c2-b2b9-437a28df6ec4': uuidv7(),
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
    const desvio = Date.now() - Date.parse('2026-10-29T17:35:02.114Z');
    const texto = JSON.stringify(fixture('venda.cancelada.em_andamento.payload.json'))
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => ids[id] ?? id)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (t) =>
        new Date(Date.parse(t) + desvio).toISOString(),
      );
    const payload = JSON.parse(texto) as { vendas: Payload; itens_venda: Payload[] };
    payload.vendas.numero_caixa = p.numero;
    const vendaId = payload.vendas.id as string;
    const [r] = await pushOk(p, [evento(p, 'venda.cancelada', payload)]);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { venda_id: vendaId, em_andamento: true },
    });
    expect(await vendaGravada(vendaId)).toMatchObject({
      status: 'cancelada',
      finalizada_em: null,
      motivo_cancelamento: 'Cliente desistiu antes de pagar',
      cancelamento_origem: 'pdv',
      custo_total: null,
    });
    const [{ itens }] = (await consultar<{ itens: number }>(
      emp.nomeBanco,
      'select count(*)::int as itens from itens_venda where venda_id = $1',
      [vendaId],
    )) as [{ itens: number }];
    expect(itens).toBe(payload.itens_venda.length);
    expect(await movimentosDoDocumento('venda', vendaId)).toHaveLength(0);
    const [num] = await consultar<{ ultimo_numero: string }>(
      emp.nomeBanco,
      "select ultimo_numero::text from numeracoes where tipo = 'venda' and caixa_id = $1",
      [p.caixa],
    );
    expect(num!.ultimo_numero).toBe(String(payload.vendas.numero));
    // Gerada de novo: `ja_existia`; outro conteúdo: divergente.
    const [de] = await pushOk(p, [evento(p, 'venda.cancelada', payload)]);
    expect(de, JSON.stringify(de)).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
    const outro = structuredClone(payload);
    outro.vendas.motivo_cancelamento = 'Cliente desistiu antes de pagar a conta';
    const [div] = await pushOk(p, [evento(p, 'venda.cancelada', outro)]);
    expect(div).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
  });

  it('a mesma venda já finalizada não vira cancelada em andamento; o número de outra venda → NUMERO_VENDA_DUPLICADO', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV FORMA B C7' });
    const v = venda(p, [{ produto: prod, quantidade: '1.000' }]);
    await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    const emAndamento = (x: Venda) => ({
      ...x,
      vendas: {
        ...x.vendas,
        status: 'cancelada',
        finalizada_em: null,
        cancelada_em: agora(),
        cancelada_por_id: operador,
        motivo_cancelamento: 'Cliente desistiu antes de pagar',
        cancelamento_origem: 'pdv',
      },
      pagamentos_venda: [],
    });
    const [r1] = await pushOk(p, [evento(p, 'venda.cancelada', emAndamento(v))]);
    expect(r1).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
    const outra = venda(p, [{ produto: prod, quantidade: '1.000' }], { numero: v.vendas.numero });
    const [r2] = await pushOk(p, [evento(p, 'venda.cancelada', emAndamento(outra))]);
    expect(r2).toMatchObject({ status: 'rejeitado', erro: { codigo: 'NUMERO_VENDA_DUPLICADO' } });
    // Uma cancelada em andamento com número novo grava, sem estoque.
    const nova = venda(p, [{ produto: prod, quantidade: '3.000' }]);
    const [r3] = await pushOk(p, [evento(p, 'venda.cancelada', emAndamento(nova))]);
    expect(r3, JSON.stringify(r3)).toMatchObject({ status: 'aplicado', resultado: { em_andamento: true } });
    expect(await saldo(prod)).toBe(-1);
  });
});

describe('vasilhame.movimentado (SYNC 9.26)', () => {
  it('devolução avulsa de cascos: VASILHAME_DEVOLVIDO no vasilhame_vazio; reenvio do lote; gerada de novo; divergente', async () => {
    const p = await novoPonto();
    const casco = await criarProduto({
      nome: 'GARRAFA 600ML AVULSA C7',
      tipo: 'vasilhame',
      precoVenda: '1,50',
      precoCusto: '1,20',
    });
    const d = devolucao(p, casco, '3.000');
    const id = d.movimentos_vasilhame.id;
    const ev = evento(p, 'vasilhame.movimentado', d);
    const lote = uuidv7();
    const [r] = await pushOk(p, [ev], lote);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { movimento_vasilhame_id: id, movimentos: 1 },
    });
    expect([await saldo(casco, tipoVazio), await saldo(casco)]).toEqual([3, 0]);
    const [m] = await movimentosDoDocumento('vasilhame', id);
    expect(m).toMatchObject({
      tipo_movimento: 'VASILHAME_DEVOLVIDO',
      quantidade: '3.000',
      tipo_estoque_id: tipoVazio,
      documento_item_id: id,
      evento_id: ev.evento_id,
      terminal_id: p.terminal,
      // Sem saldo nem custo médio na linha: entra ao custo de referência do casco.
      custo_unitario: '1.2000',
    });
    const [gravado] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      'select destino, quantidade::text, sessao_caixa_id, cancelado from movimentos_vasilhame where id = $1',
      [id],
    );
    expect(gravado).toEqual({
      destino: 'entrada',
      quantidade: '3.000',
      sessao_caixa_id: p.sessao,
      cancelado: false,
    });
    expect((await pushOk(p, [ev], lote))[0]).toMatchObject({ status: 'duplicado' });
    const [de] = await pushOk(p, [evento(p, 'vasilhame.movimentado', d)]);
    expect(de).toMatchObject({ status: 'aplicado', resultado: { ja_existia: true } });
    const outro = structuredClone(d);
    outro.movimentos_vasilhame.quantidade = '4.000';
    const [div] = await pushOk(p, [evento(p, 'vasilhame.movimentado', outro)]);
    expect(div).toMatchObject({ status: 'rejeitado', erro: { codigo: 'AGREGADO_DIVERGENTE' } });
    expect(await saldo(casco, tipoVazio)).toBe(3);
  });

  it('comodato e vale são da Fase 3; sessão nunca recebida; casco inexistente; a fixture do C4 aplicada', async () => {
    const p = await novoPonto();
    const casco = await criarProduto({ nome: 'GARRAFAO 20L AVULSO C7', tipo: 'vasilhame', precoVenda: '15' });
    const [c1, c2, c3, c4] = await pushOk(p, [
      evento(
        p,
        'vasilhame.movimentado',
        devolucao(p, casco, '1.000', { destino: 'baixa_comodato', pessoa_id: uuidv7() }),
      ),
      evento(
        p,
        'vasilhame.movimentado',
        devolucao(p, casco, '1.000', { destino: 'vale', vale_id: uuidv7() }),
      ),
      evento(p, 'vasilhame.movimentado', devolucao(p, casco, '1.000', { sessao_caixa_id: uuidv7() })),
      evento(p, 'vasilhame.movimentado', devolucao(p, uuidv7(), '1.000')),
    ]);
    expect([c1, c2, c3, c4].map((x) => x!.erro?.codigo)).toEqual([
      'PAYLOAD_INVALIDO',
      'PAYLOAD_INVALIDO',
      'SESSAO_INEXISTENTE',
      'REFERENCIA_INEXISTENTE',
    ]);
    expect(await saldo(casco, tipoVazio)).toBe(0);
    const ids: Record<string, string> = {
      '01a187a2-3d4e-7f60-9a1b-2c3d4e5f6a03': uuidv7(),
      '01a18755-98a1-7472-96da-1dac72ff5d2a': p.sessao,
      '01a18752-3782-7bda-ad3c-2d6d1a3d1fa7': loja,
      '01a18752-c8a9-7970-9641-9f828b9d2434': p.caixa,
      '01a18751-a521-7238-b924-56de3eb13b90': p.terminal,
      '01a18754-76cb-7b74-b2e7-06298fadc1a6': operador,
      '01a1875d-11aa-7b2c-9d3e-4f5a6b7c8d04': casco,
    };
    const payload = JSON.parse(
      JSON.stringify(fixture('vasilhame.movimentado.payload.json'))
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => ids[id] ?? id)
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, () => horasAtras(0.2)),
    ) as Payload;
    const [f] = await pushOk(p, [evento(p, 'vasilhame.movimentado', payload)]);
    expect(f, JSON.stringify(f)).toMatchObject({ status: 'aplicado', resultado: { movimentos: 1 } });
    expect(await saldo(casco, tipoVazio)).toBe(6);
  });

  it('casco que não controla estoque grava só o movimento; estoque do contexto inválido → o da loja com alerta', async () => {
    const p = await novoPonto();
    const semEstoque = await criarProduto({
      nome: 'GARRAFA SEM ESTOQUE C7',
      tipo: 'vasilhame',
      precoVenda: '1,00',
      controlaEstoque: false,
    });
    const d = devolucao(p, semEstoque, '2.000');
    const [r] = await pushOk(p, [evento(p, 'vasilhame.movimentado', d)]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado', resultado: { movimentos: 0 } });
    expect(await movimentosDoDocumento('vasilhame', d.movimentos_vasilhame.id)).toHaveLength(0);
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from movimentos_vasilhame where id = $1',
      [d.movimentos_vasilhame.id],
    )) as [{ n: number }];
    expect(n).toBe(1);
    // O caixa mandou um estoque que não existe mais: a entrada vai para o estoque atual da loja, com o alerta.
    const casco = await criarProduto({ nome: 'GARRAFA CONTEXTO C7', tipo: 'vasilhame', precoVenda: '1,00' });
    const sumido = uuidv7();
    const e = devolucao(p, casco, '3.000');
    const ev = evento(p, 'vasilhame.movimentado', e, {
      contexto: {
        loja_id: p.loja,
        caixa_id: p.caixa,
        numero_caixa: p.numero,
        versao_app: '1.0.0',
        estoque_id: sumido,
      },
    });
    const [rc] = await pushOk(p, [ev]);
    expect(rc, JSON.stringify(rc)).toMatchObject({
      status: 'aplicado',
      resultado: { movimentos: 1, alertas: ['ESTOQUE_CONTEXTO_INVALIDO'] },
    });
    expect(await saldo(casco, tipoVazio)).toBe(3);
    const [alerta] = await alertasAbertos(
      'ESTOQUE_CONTEXTO_INVALIDO',
      `estoque_contexto_invalido:${p.terminal}:${sumido}`,
    );
    expect(alerta!.dados).toEqual({ estoque_contexto_id: sumido, estoque_usado_id: estoqueLoja });
  });

  it('produto que não é casco (tipo diferente de vasilhame) → PAYLOAD_INVALIDO, na devolução e no bloco vasilhames da venda', async () => {
    const p = await novoPonto();
    const cerveja = await criarProduto({ nome: 'CERV NAO E CASCO C7' });
    const [r] = await pushOk(p, [evento(p, 'vasilhame.movimentado', devolucao(p, cerveja, '2.000'))]);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    const v = venda(p, [{ produto: cerveja, quantidade: '1.000' }], {
      vasilhames: [
        { produto_vasilhame_id: cerveja, devolvidos: 1, vendidos: 0, emprestados: 0, pessoa_id: null },
      ],
    });
    const [rv] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
    expect(rv, JSON.stringify(rv)).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'PAYLOAD_INVALIDO' },
    });
    expect([await saldo(cerveja), await saldo(cerveja, tipoVazio)]).toEqual([0, 0]);
  });
});

describe('alerta.cadastro (SYNC 9.24)', () => {
  it('a fixture do C4 vira um alerta CADASTRO_PRODUTO da empresa, deduplicado entre lojas; produto inexistente → REFERENCIA_INEXISTENTE', async () => {
    const p = await novoPonto();
    const prod = await criarProduto({ nome: 'CERV BRAHMA LT 350ML ALERTA C7' });
    const payload = {
      ...(fixture('alerta.cadastro.payload.json') as Payload),
      produto_id: prod,
    };
    const [r] = await pushOk(p, [evento(p, 'alerta.cadastro', payload)]);
    expect(r, JSON.stringify(r)).toMatchObject({
      status: 'aplicado',
      resultado: { alerta: 'criado', tipo_alerta: 'ean_duplicado_no_caixa' },
    });
    const chave = `cadastro:ean_duplicado_no_caixa:${prod}`;
    const [alerta] = await alertasAbertos('CADASTRO_PRODUTO', chave);
    // O cadastro é da empresa: o alerta não fica preso à loja do primeiro caixa que avisou.
    expect(alerta).toMatchObject({
      titulo: 'Código de barras em dois produtos: CERV BRAHMA LT 350ML ALERTA C7',
      loja_id: null,
      dados: {
        tipo_alerta: 'ean_duplicado_no_caixa',
        produto_id: prod,
        loja_id: loja,
        lojas: [loja],
        detalhes: { codigo_lido: '7891149103102' },
      },
    });
    // O caixa avisa de novo (outro evento): o alerta aberto não repete.
    const [de] = await pushOk(p, [evento(p, 'alerta.cadastro', payload)]);
    expect(de).toMatchObject({ status: 'aplicado', resultado: { alerta: 'ja_aberto' } });
    // Um caixa de outra loja avisa o mesmo: o alerta continua um só, com as duas lojas.
    const outraLoja = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Treino');
    const q = await novoPonto(outraLoja);
    const [r2] = await pushOk(q, [evento(q, 'alerta.cadastro', payload)]);
    expect(r2, JSON.stringify(r2)).toMatchObject({ status: 'aplicado', resultado: { alerta: 'ja_aberto' } });
    await pushOk(q, [evento(q, 'alerta.cadastro', payload)]);
    const abertos = await alertasAbertos('CADASTRO_PRODUTO', chave);
    expect(abertos).toHaveLength(1);
    expect(abertos[0]!).toMatchObject({ loja_id: null, dados: { loja_id: loja, lojas: [loja, outraLoja] } });
    const [x] = await pushOk(p, [evento(p, 'alerta.cadastro', { ...payload, produto_id: uuidv7() })]);
    expect(x).toMatchObject({ status: 'rejeitado', erro: { codigo: 'REFERENCIA_INEXISTENTE' } });
  });
});

describe('ordem de lançamento do razão (F2-B2)', () => {
  it('no fim da suíte, a cadeia de cada linha fecha por seq_lancamento e o replay repete o razão', async () => {
    expect(await conferirRazaoDasEmpresas(amb.bancoControle)).toBeGreaterThan(0);
  });
});
