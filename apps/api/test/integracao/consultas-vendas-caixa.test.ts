/**
 * Consultas do ERP sobre as vendas e o caixa do PDV (Fase 1C, bloco C12; ERP 6, 14.9, 15.2–15.4): as fixtures do C4
 * (`caixa.aberto`, `caixa.reforco`, `caixa.sangria`, `caixa.movimento_cancelado`, `venda.cancelada` forma A e
 * `caixa.fechado`) aplicadas pelo push real, com os ids deste ambiente, e as vendas do turno; depois, a listagem e o
 * detalhe de Vendas (filtros, totalizadores, lucro só com `vendas.ver_lucro`), Reforço/abertura e Sangria (só os não
 * cancelados no total), Fechamento de caixa (calculado × informado × diferença por forma e o cálculo do dinheiro
 * refeito na nuvem), o dashboard pelo dia operacional (D7) e a loja de treino fora por padrão (O10). No fim, a sessão
 * fechada pela nuvem cujo `caixa.fechado` chega depois (MD 3.12.1), o turno do vetor compartilhado com o PDV
 * (`caixa.apuracao.vetores.json`, o mesmo do `ApuracaoVetoresTests`) e o dashboard com a loja inativa, o estoque e os
 * PDVs da loja de treino.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRATOS_EVENTOS, diaOperacionalEm, jcs, respostaPushSchema, type Ativar } from '@genesis/shared';
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

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const fixture = (nome: string) => readFileSync(new URL(nome, FIXTURES), 'utf8');
const ATIVAR = JSON.parse(fixture('ativar.requisicao.json')) as Ativar;
const DIA = '2026-10-29';

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let lojaTreino: string;
let tokenAdmin: string;
let tokenVendedor: string;
let operador: string;
let dinheiro: string;
let credito: string;
let pix: string;
let un: string;

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** Dia operacional de agora com o corte padrão da empresa (05:00, D7) no fuso das lojas de teste. */
const diaOperacionalHoje = () => diaOperacionalEm(new Date(), '05:00');

/**
 * A consulta com o dia (pela `regra`) em que ela rodou; repete se o dia virar no meio dela: a suíte pode atravessar o
 * corte (05:00, ou a meia-noite no corte 00:00) entre gravar a venda de "hoje" e consultar o dashboard.
 */
async function noMesmoDia<T>(
  consulta: () => Promise<T>,
  regra: () => string = diaOperacionalHoje,
): Promise<{ dia: string; r: T }> {
  for (;;) {
    const dia = regra();
    const r = await consulta();
    if (regra() === dia) return { dia, r };
  }
}

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

const get = (url: string, query: Payload = {}, token = tokenAdmin) =>
  amb.http().get(url).set('Authorization', `Bearer ${token}`).query(query);

async function getOk(url: string, query: Payload = {}, token = tokenAdmin) {
  const r = await get(url, query, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

/** Um caixa com o seu terminal ativado pelo `/sync/ativar` real e os ids das fixtures já trocados por ele. */
interface Ponto {
  loja: string;
  codigoLoja: number;
  caixa: string;
  numero: number;
  terminal: string;
  token: string;
  seq: number;
  venda: number;
  sessao: string;
  ids: Record<string, string>;
}

let numeroCaixa = 0;

async function novoPonto(lojaDoPonto: string, codigoLoja: number): Promise<Ponto> {
  const numero = ++numeroCaixa;
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [lojaDoPonto, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
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
  const sessao = uuidv7();
  return {
    loja: lojaDoPonto,
    codigoLoja,
    caixa,
    numero,
    terminal: r.body.terminal_id,
    token: r.body.token,
    seq: 0,
    venda: 0,
    sessao,
    // Ids das fixtures do C4 → os deste ambiente; os demais ids das fixtures ganham um novo na primeira vez.
    ids: {
      '01a18752-3782-7bda-ad3c-2d6d1a3d1fa7': lojaDoPonto,
      '01a18752-c8a9-7970-9641-9f828b9d2434': caixa,
      '01a18751-a521-7238-b924-56de3eb13b90': r.body.terminal_id,
      '01a18755-98a1-7472-96da-1dac72ff5d2a': sessao,
      '01a18754-76cb-7b74-b2e7-06298fadc1a6': operador,
      '01a18755-09d1-76b6-8b81-48f6b38a088c': operador,
      '01a1875e-a2ca-7299-9d65-a441d58842de': dinheiro,
      '01a1875f-3243-7ab8-b5a2-40ae5af30553': pix,
      '01a1875f-c261-7aef-afc8-9849b3aa7efe': credito,
    },
  };
}

// As horas das fixtures de caixa andam juntas até um minuto atrás (a partição da auditoria é a do mês corrente).
const DESVIO = Date.now() - 60_000 - Date.parse('2026-10-29T23:05:40.118Z');

/** A fixture do C4 com os ids do ponto, as horas deslocadas e o número do caixa do ponto. */
function daFixture<T = Payload>(p: Ponto, nome: string, horaFixa?: string): T {
  const texto = fixture(nome)
    .replace(
      /01a18[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      (id) => (p.ids[id] ??= uuidv7()),
    )
    .replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
      (t) => horaFixa ?? new Date(Date.parse(t) + DESVIO).toISOString(),
    )
    .replace(/"numero_caixa": 2/g, `"numero_caixa": ${p.numero}`);
  expect(texto).not.toMatch(/01a18/);
  return JSON.parse(texto) as T;
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
    dependencias: tipo.startsWith('venda.') ? [{ agregado_tipo: 'sessao_caixa', agregado_id: p.sessao }] : [],
    ocorrido_em: agora(),
    relogio_confiavel: true,
    usuario_id: operador,
    contexto: { loja_id: p.loja, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

async function aplicar(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload) {
  const r = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({
      lote_id: uuidv7(),
      terminal_id: p.terminal,
      enviado_em: agora(),
      eventos: [evento(p, tipo, payload)],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  expect(r.body.resultados[0], `${tipo}: ${JSON.stringify(r.body.resultados[0])}`).toMatchObject({
    status: 'aplicado',
  });
}

interface PagamentoTeste {
  forma: string;
  tipo: string;
  valor: string;
  valorRecebido?: string;
  troco?: string;
}

/** Venda finalizada de um item (`quantidade` × R$ 5,00) com os pagamentos dados (padrão: tudo em dinheiro). */
function venda(
  p: Ponto,
  produto: string,
  quantidade: number,
  opcoes: { pagamentos?: PagamentoTeste[]; dia?: string; extra?: Payload } = {},
) {
  const id = uuidv7();
  const numero = ++p.venda;
  const finalizada = horasAtras(2);
  const total = (quantidade * 5).toFixed(2);
  const pagamentos = opcoes.pagamentos ?? [{ forma: dinheiro, tipo: 'dinheiro', valor: total }];
  return {
    vendas: {
      id,
      numero,
      numero_exibicao: `L${String(p.codigoLoja).padStart(2, '0')}-C${String(p.numero).padStart(2, '0')}-${String(numero).padStart(6, '0')}`,
      loja_id: p.loja,
      caixa_id: p.caixa,
      numero_caixa: p.numero,
      terminal_id: p.terminal,
      sessao_caixa_id: p.sessao,
      tipo: 'pdv',
      status: 'finalizada',
      dia_operacional: opcoes.dia ?? DIA,
      operador_id: operador,
      cliente_id: null,
      subtotal_bruto: total,
      total,
      iniciada_em: finalizada,
      finalizada_em: finalizada,
      ...(pagamentos.some((pg) => pg.troco)
        ? { troco: pagamentos.reduce((t, pg) => t + Number(pg.troco ?? 0), 0).toFixed(2) }
        : {}),
      ...opcoes.extra,
    },
    itens_venda: [
      {
        id: uuidv7(),
        venda_id: id,
        sequencia: 1,
        produto_id: produto,
        descricao: 'CERV CONSULTA C12',
        unidade: 'UN',
        quantidade: `${quantidade}.000`,
        preco_tabela: '5.0000',
        preco_unitario: '5.0000',
        valor_bruto: total,
        valor_liquido: total,
        incluido_em: finalizada,
        componentes_estoque: [],
      },
    ],
    pagamentos_venda: pagamentos.map((pg, n) => ({
      id: uuidv7(),
      venda_id: id,
      sequencia: n + 1,
      forma_pagamento_id: pg.forma,
      descricao_forma: pg.tipo,
      meio_pagamento_fiscal: pg.tipo === 'dinheiro' ? '01' : pg.tipo === 'pix' ? '17' : '03',
      tipo_forma: pg.tipo,
      valor: pg.valor,
      ...(pg.troco ? { valor_recebido: pg.valorRecebido, troco: pg.troco } : {}),
      lanca_quitada: pg.tipo === 'dinheiro',
    })),
    vasilhames: [],
  };
}

/** Abre a sessão do ponto pela fixture `caixa.aberto` (fundo R$ 150,00). */
const abrir = (p: Ponto) => aplicar(p, 'caixa.aberto', daFixture(p, 'caixa.aberto.payload.json'));

// Turno completo da Loja 1 (montado no beforeAll do describe): abertura 150, reforço 50, sangria 1000 cancelada,
// venda 1 de R$ 50,00 em dinheiro, venda 2 de R$ 80,00 (15 dinheiro, 40 crédito, 25 PIX) cancelada pela fixture da
// forma A (40 devolvidos em dinheiro e 40 estornados no crédito), venda 3 de R$ 10,00 em PIX no dia operacional de
// hoje e o fechamento cego: Dinheiro calculado 225,00 e contado 223,50, PIX 35,00 e 35,00, Crédito 0,00.
let p1: Ponto;
let pTreino: Ponto;
let produto: string;
let v1: ReturnType<typeof venda>;
let v2: ReturnType<typeof venda>;
let v3: ReturnType<typeof venda>;
let vTreino: ReturnType<typeof venda>;
const hoje = diaOperacionalHoje();

beforeAll(async () => {
  amb = await criarAmbiente({ env: { DASHBOARD_CACHE_MS: '0' } });
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  lojaTreino = await criarLoja(emp.nomeBanco, 9, 'Loja Treino');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
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
  const unidades = (await get('/api/referencias/unidades')).body as Array<{ id: string; sigla: string }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  await criarUsuario(emp.nomeBanco, { login: 'vendedor1', perfil: 'vendedor', lojas: [loja] });
  tokenVendedor = await amb.entrar(emp.codigo, 'vendedor1', SENHA_TESTE);
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('loja de treino (O10)', () => {
  it('o ERP marca a loja como treino pelo cadastro e o /auth/eu informa a marca', async () => {
    const atual = await getOk(`/api/lojas/${lojaTreino}`);
    expect(atual.treino).toBe(false);
    const r = await amb
      .http()
      .put(`/api/lojas/${lojaTreino}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ ...atual, treino: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await getOk(`/api/lojas/${lojaTreino}`)).treino).toBe(true);
    // A loja de treino é não fiscal (O10): o ERP recusa mudar a emissão e o banco também (`ck_lojas_treino_nao_fiscal`).
    const fiscal = await amb
      .http()
      .put(`/api/lojas/${lojaTreino}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ ...(await getOk(`/api/lojas/${lojaTreino}`)), tipoEmissao: 'nfce', ie: '9012345678' });
    expect(fiscal.status, JSON.stringify(fiscal.body)).toBe(422);
    expect(JSON.stringify(fiscal.body)).toContain('treino');
    await expect(
      consultar(emp.nomeBanco, "update lojas set tipo_emissao = 'nfce' where id = $1", [lojaTreino]),
    ).rejects.toThrow(/ck_lojas_treino_nao_fiscal/);
    const real = await getOk(`/api/lojas/${loja}`);
    const marcar = await amb
      .http()
      .put(`/api/lojas/${loja}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ ...real, tipoEmissao: 'nfce', ie: '9012345678', treino: true });
    expect(marcar.status, JSON.stringify(marcar.body)).toBe(422);
    expect(JSON.stringify(marcar.body)).toContain('treino');
    const eu = await getOk('/api/auth/eu');
    expect(eu.lojas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: lojaTreino, treino: true }),
        expect.objectContaining({ id: loja, treino: false }),
      ]),
    );
  });
});

describe('turno aplicado pelas fixtures do C4', () => {
  beforeAll(async () => {
    const criado = await amb
      .http()
      .post('/api/produtos')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ nome: 'CERV CONSULTA C12', unidadeId: un, precoVenda: '5', precoCusto: '2' });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    produto = criado.body.id as string;

    p1 = await novoPonto(loja, 1);
    await abrir(p1);
    await aplicar(p1, 'caixa.reforco', daFixture(p1, 'caixa.reforco.payload.json'));
    await aplicar(p1, 'caixa.sangria', daFixture(p1, 'caixa.sangria.payload.json'));
    await aplicar(p1, 'caixa.movimento_cancelado', daFixture(p1, 'caixa.movimento_cancelado.payload.json'));
    v1 = venda(p1, produto, 10);
    await aplicar(p1, 'venda.finalizada', v1);
    v2 = venda(p1, produto, 16, {
      pagamentos: [
        { forma: dinheiro, tipo: 'dinheiro', valor: '15.00' },
        { forma: credito, tipo: 'cartao_credito', valor: '40.00' },
        { forma: pix, tipo: 'pix', valor: '25.00' },
      ],
    });
    await aplicar(p1, 'venda.finalizada', v2);
    // Forma A da fixture: a venda e os 3 pagamentos são os da venda 2.
    p1.ids['01a18787-4a31-7ced-b171-0434134c6c92'] = v2.vendas.id;
    p1.ids['01a18788-67c3-78a7-bfd0-f9d5a6f2f7b8'] = v2.pagamentos_venda[0]!.id;
    p1.ids['01a18788-f3a1-7c5e-8d24-6b7a8c9d0e12'] = v2.pagamentos_venda[1]!.id;
    p1.ids['01a18789-2b4c-7d6e-9f80-a1b2c3d4e5f6'] = v2.pagamentos_venda[2]!.id;
    await aplicar(p1, 'venda.cancelada', daFixture(p1, 'venda.cancelada.finalizada.payload.json', agora()));
    v3 = venda(p1, produto, 2, { pagamentos: [{ forma: pix, tipo: 'pix', valor: '10.00' }], dia: hoje });
    await aplicar(p1, 'venda.finalizada', v3);

    const fechado = daFixture<{
      fechamentos_caixa: Payload & { resumo: Payload };
      fechamentos_caixa_formas: Payload[];
      movimentos_caixa: Payload[];
    }>(p1, 'caixa.fechado.payload.json');
    Object.assign(fechado.fechamentos_caixa, { total_calculado: '260.00', total_digitado: '258.50' });
    fechado.fechamentos_caixa.resumo.ultima_sequencia_evento = p1.seq;
    const [fDinheiro, fPix, fCredito] = fechado.fechamentos_caixa_formas;
    Object.assign(fDinheiro!, {
      valor_calculado: '225.00',
      valor_digitado: '223.50',
      quantidade_pagamentos: 2,
    });
    Object.assign(fPix!, { valor_calculado: '35.00', valor_digitado: '35.00', quantidade_pagamentos: 2 });
    Object.assign(fCredito!, { valor_calculado: '0.00', valor_digitado: '0.00', quantidade_pagamentos: 1 });
    fechado.movimentos_caixa[0]!.valor = '223.50';
    await aplicar(p1, 'caixa.fechado', fechado);

    // A loja de treino vende no mesmo dia operacional, num caixa dela.
    pTreino = await novoPonto(lojaTreino, 9);
    await abrir(pTreino);
    vTreino = venda(pTreino, produto, 4);
    await aplicar(pTreino, 'venda.finalizada', vTreino);
  }, 180_000);

  describe('Vendas (ERP 15.4)', () => {
    it('lista pelo dia operacional sem a loja de treino; os totais abatem a cancelada', async () => {
      const r = await getOk('/api/vendas', { dataInicial: DIA, dataFinal: DIA, ordenar: 'codigo:asc' });
      expect(r.itens.map((v: { id: string }) => v.id)).toEqual([v1.vendas.id, v2.vendas.id]);
      expect(r.itens[0]).toMatchObject({
        numeroExibicao: 'L01-C01-000001',
        diaOperacional: DIA,
        tipo: 'pdv',
        status: 'finalizada',
        subtotalBruto: '50.00',
        descontos: '0.00',
        total: '50.00',
        lojaId: loja,
        lojaCodigo: 1,
        lojaTreino: false,
        numeroCaixa: p1.numero,
        operadorNome: expect.any(String),
        clienteNome: null,
      });
      expect(r.itens[1]).toMatchObject({ status: 'cancelada', total: '80.00' });
      expect(r.totais).toEqual({
        quantidade: 2,
        canceladas: 1,
        totalBruto: '50.00',
        descontos: '0.00',
        totalLiquido: '50.00',
      });
    });

    it('filtros: situação, código, forma, sessão, caixa, tipo e ordenação', async () => {
      const ids = async (q: Payload) =>
        (await getOk('/api/vendas', q)).itens.map((v: { id: string }) => v.id) as string[];
      expect(await ids({ situacao: 'cancelada' })).toEqual([v2.vendas.id]);
      expect(await ids({ codigo: 'l01-c01-000003' })).toEqual([v3.vendas.id]);
      expect(await ids({ codigo: '3', lojaId: loja })).toEqual([v3.vendas.id]);
      expect(await ids({ formaPagamentoId: credito })).toEqual([v2.vendas.id]);
      expect((await ids({ sessaoCaixaId: p1.sessao, ordenar: 'total:asc' })).length).toBe(3);
      expect(await ids({ sessaoCaixaId: p1.sessao, ordenar: 'total:asc' })).toEqual([
        v3.vendas.id,
        v1.vendas.id,
        v2.vendas.id,
      ]);
      expect(await ids({ numeroCaixa: p1.numero, dataInicial: hoje })).toEqual([v3.vendas.id]);
      expect(await ids({ tipo: 'venda' })).toEqual([]);
      expect((await ids({ tipo: 'pdv', operadorId: operador })).length).toBe(3);
      expect(await ids({ devolucao: 'parcial' })).toEqual([]);
      const ordem = await get('/api/vendas', { ordenar: 'lucro:asc' });
      expect(ordem.status).toBe(422);
    });

    it('loja de treino: fora por padrão, junto com "incluir", só ela com "somente" ou escolhida no filtro', async () => {
      const ids = async (q: Payload) =>
        (await getOk('/api/vendas', { dataInicial: DIA, dataFinal: DIA, ...q })).itens.map(
          (v: { id: string }) => v.id,
        ) as string[];
      expect(await ids({})).not.toContain(vTreino.vendas.id);
      expect(await ids({ treino: 'incluir' })).toContain(vTreino.vendas.id);
      expect(await ids({ treino: 'somente' })).toEqual([vTreino.vendas.id]);
      expect(await ids({ lojaId: lojaTreino })).toEqual([vTreino.vendas.id]);
      const t = await getOk('/api/vendas', { lojaId: lojaTreino });
      expect(t.itens[0]).toMatchObject({ lojaTreino: true, numeroExibicao: 'L09-C02-000001' });
    });

    it('detalhe da venda cancelada: cancelamento, itens, pagamentos estornados e o lucro', async () => {
      const d = await getOk(`/api/vendas/${v2.vendas.id}`);
      expect(d).toMatchObject({
        id: v2.vendas.id,
        status: 'cancelada',
        tipo: 'pdv',
        cancelamentoOrigem: 'pdv',
        motivoCancelamento: 'Cliente desistiu da compra apos o pagamento',
        canceladaPorNome: expect.any(String),
        cancelamentoAutorizadoPorNome: expect.any(String),
        sessaoCaixaId: p1.sessao,
        terminalId: p1.terminal,
        total: '80.00',
        relogioConfiavel: true,
      });
      expect(d.itens).toEqual([
        expect.objectContaining({
          sequencia: 1,
          quantidade: '16.000',
          valorLiquido: '80.00',
          cancelado: false,
        }),
      ]);
      expect(
        d.pagamentos.map((pg: { tipoForma: string; status: string }) => [pg.tipoForma, pg.status]),
      ).toEqual([
        ['dinheiro', 'estornado'],
        ['cartao_credito', 'estornado'],
        ['pix', 'estornado'],
      ]);
      const [{ custo_total }] = (await consultar<{ custo_total: string | null }>(
        emp.nomeBanco,
        'select custo_total::text from vendas where id = $1',
        [v1.vendas.id],
      )) as [{ custo_total: string | null }];
      const d1 = await getOk(`/api/vendas/${v1.vendas.id}`);
      if (custo_total === null) expect(d1.lucro).toBeNull();
      else
        expect(d1.lucro).toEqual({
          custo: custo_total,
          lucro: (50 - Number(custo_total)).toFixed(2),
          margemPct: (((50 - Number(custo_total)) / 50) * 100).toFixed(2),
        });
      expect((await get(`/api/vendas/${uuidv7()}`)).status).toBe(404);
      expect((await get('/api/vendas/nao-e-uuid')).status).toBe(422);
    });

    it('sem vendas.ver_lucro não vê custo nem lucro; loja fora das permitidas é 403 na lista e 404 no detalhe', async () => {
      const d = await getOk(`/api/vendas/${v1.vendas.id}`, {}, tokenVendedor);
      expect(d.lucro).toBeNull();
      expect(d.itens[0].custoUnitario).toBeNull();
      expect((await get('/api/vendas', { lojaId: lojaTreino }, tokenVendedor)).status).toBe(403);
      expect((await get(`/api/vendas/${vTreino.vendas.id}`, {}, tokenVendedor)).status).toBe(404);
      const todas = await getOk('/api/vendas', { treino: 'incluir' }, tokenVendedor);
      expect(todas.itens.every((v: { lojaId: string }) => v.lojaId === loja)).toBe(true);
    });
  });

  describe('Reforço/abertura (15.2) e Sangria (15.3)', () => {
    it('reforços: a abertura e o reforço da sessão, com o totalizador', async () => {
      const r = await getOk('/api/movimentos-caixa/reforcos', {
        sessaoCaixaId: p1.sessao,
        ordenar: 'data:asc',
      });
      expect(r.itens.map((m: { tipo: string; valor: string }) => [m.tipo, m.valor])).toEqual([
        ['abertura', '150.00'],
        ['reforco', '50.00'],
      ]);
      expect(r.itens[0]).toMatchObject({ diaOperacional: DIA, lojaId: loja, numeroCaixa: p1.numero });
      expect(r.totais).toEqual({ quantidade: 2, valor: '200.00' });
      const s = await getOk('/api/movimentos-caixa/reforcos', {
        dataInicial: DIA,
        dataFinal: DIA,
        tipo: 'reforco',
      });
      expect(s.itens.map((m: { tipo: string }) => m.tipo)).toEqual(['reforco']);
      // Abertura da loja de treino fica de fora sem o filtro.
      const comTreino = await getOk('/api/movimentos-caixa/reforcos', {
        dataInicial: DIA,
        treino: 'incluir',
      });
      expect(comTreino.itens.some((m: { lojaTreino: boolean }) => m.lojaTreino)).toBe(true);
      const semTreino = await getOk('/api/movimentos-caixa/reforcos', { dataInicial: DIA });
      expect(semTreino.itens.some((m: { lojaTreino: boolean }) => m.lojaTreino)).toBe(false);
    });

    it('sangrias: a cancelada aparece e não soma; a do fechamento entra; detalhe do cancelamento', async () => {
      const r = await getOk('/api/movimentos-caixa/sangrias', {
        sessaoCaixaId: p1.sessao,
        ordenar: 'data:asc',
      });
      expect(
        r.itens.map((m: { tipo: string; valor: string; cancelado: boolean }) => [
          m.tipo,
          m.valor,
          m.cancelado,
        ]),
      ).toEqual([
        ['sangria', '1000.00', true],
        ['sangria_fechamento', '223.50', false],
      ]);
      expect(r.totais).toEqual({ quantidade: 1, valor: '223.50' });
      expect(r.itens[0].quemRetira).toEqual(expect.any(String));
      const canceladas = await getOk('/api/movimentos-caixa/sangrias', {
        sessaoCaixaId: p1.sessao,
        situacao: 'cancelados',
      });
      expect(canceladas.itens).toHaveLength(1);
      const d = await getOk(`/api/movimentos-caixa/${r.itens[0].id}`);
      expect(d).toMatchObject({
        tipo: 'sangria',
        sessaoCaixaId: p1.sessao,
        terminalId: p1.terminal,
        observacao: 'Depósito banco',
        infAdicionais: 'Malote 4471',
        quemRetiraNome: 'CARLOS',
        cancelado: true,
        motivoCancelamento: 'Valor digitado errado (era 100,00)',
        canceladoPorNome: expect.any(String),
        autorizadoCancelamentoPorNome: expect.any(String),
      });
      expect((await get(`/api/movimentos-caixa/${uuidv7()}`)).status).toBe(404);
    });

    it('sem movimentos_caixa.ver é 403', async () => {
      expect((await get('/api/movimentos-caixa/sangrias', {}, tokenVendedor)).status).toBe(403);
    });
  });

  describe('Fechamento de caixa (14.9)', () => {
    it('lista a sessão fechada com calculado × informado × diferença; filtros de diferença, situação e treino', async () => {
      const r = await getOk('/api/sessoes-caixa', { dataInicial: DIA, dataFinal: DIA });
      expect(r.itens).toHaveLength(1);
      expect(r.itens[0]).toMatchObject({
        id: p1.sessao,
        lojaId: loja,
        numeroCaixa: p1.numero,
        diaOperacional: DIA,
        situacao: 'fechada',
        tipoFechamento: 'fechamento',
        valorCaixa: '0.00',
        totalCalculado: '260.00',
        totalInformado: '258.50',
        diferenca: '-1.50',
        usuarioSubsequenteNome: null,
      });
      expect(r.totais).toEqual({ calculado: '260.00', informado: '258.50', diferenca: '-1.50' });
      expect((await getOk('/api/sessoes-caixa', { somenteComDiferenca: 'true' })).itens).toHaveLength(1);
      const abertas = await getOk('/api/sessoes-caixa', { situacao: 'aberta', treino: 'incluir' });
      expect(abertas.itens.map((s: { id: string; situacao: string }) => [s.id, s.situacao])).toEqual([
        [pTreino.sessao, 'aberta'],
      ]);
      expect((await getOk('/api/sessoes-caixa', { situacao: 'aberta' })).itens).toEqual([]);
    });

    it('detalhe: formas com o Dinheiro primeiro, o cálculo do dinheiro igual ao do PDV, movimentos e vendas', async () => {
      const d = await getOk(`/api/sessoes-caixa/${p1.sessao}`);
      expect(d).toMatchObject({
        id: p1.sessao,
        terminalId: p1.terminal,
        fundoTroco: '150.00',
        situacao: 'fechada',
        fechamento: {
          tipo: 'fechamento',
          zeraCaixa: true,
          fechamentoCego: true,
          recontagem: false,
          usuarioAnteriorNome: expect.any(String),
          resumo: expect.objectContaining({ ultima_sequencia_evento: p1.seq - 1 }),
        },
      });
      expect(
        d.formas.map(
          (f: { tipoForma: string; valorCalculado: string; valorInformado: string; diferenca: string }) => [
            f.tipoForma,
            f.valorCalculado,
            f.valorInformado,
            f.diferenca,
          ],
        ),
      ).toEqual([
        ['dinheiro', '225.00', '223.50', '-1.50'],
        ['cartao_credito', '0.00', '0.00', '0.00'],
        ['pix', '35.00', '35.00', '0.00'],
      ]);
      // 150 + (50 + 15) − 0 + 50 − 0 (a sangria cancelada não conta) − 40 (estorno em dinheiro) − 0 = 225,00.
      expect(d.calculoDinheiro).toEqual({
        fundoTroco: '150.00',
        vendasDinheiro: '65.00',
        trocoOutrasFormas: '0.00',
        reforcos: '50.00',
        sangrias: '0.00',
        estornosDinheiro: '40.00',
        devolucoes: '0.00',
        esperado: '225.00',
        sangriaFechamento: '223.50',
      });
      expect(d.calculoDinheiro.esperado).toBe(d.formas[0].valorCalculado);
      expect(d.movimentos.map((m: { tipo: string }) => m.tipo)).toEqual(
        expect.arrayContaining(['abertura', 'reforco', 'sangria', 'estorno_venda', 'sangria_fechamento']),
      );
      expect(d.movimentos).toHaveLength(6);
      expect(d.vendas).toEqual({ quantidade: 2, total: '60.00', canceladas: 1, totalCanceladas: '80.00' });
    });

    it('a sessão ainda aberta sai sem fechamento e com o esperado até agora; sem fechamentos_caixa.ver é 403', async () => {
      const d = await getOk(`/api/sessoes-caixa/${pTreino.sessao}`);
      expect(d).toMatchObject({ situacao: 'aberta', fechamento: null, formas: [], lojaTreino: true });
      expect(d.calculoDinheiro).toMatchObject({
        fundoTroco: '150.00',
        vendasDinheiro: '20.00',
        esperado: '170.00',
      });
      expect((await get('/api/sessoes-caixa', {}, tokenVendedor)).status).toBe(403);
      expect((await get(`/api/sessoes-caixa/${p1.sessao}`, {}, tokenVendedor)).status).toBe(403);
    });
  });

  describe('Dashboard (ERP 6) pelo dia operacional', () => {
    it('mês: só as finalizadas, a cancelada abate e a loja de treino fica de fora; série por dia', async () => {
      const d = await getOk('/api/dashboard', { mes: '2026-10' });
      const totalOutubro = hoje.startsWith('2026-10') ? '60.00' : '50.00';
      expect(d.vendas).toMatchObject({ total: totalOutubro });
      expect(d.vendas.porLoja.map((l: { lojaId: string }) => l.lojaId)).toEqual([loja]);
      expect(d.vendas.porLoja[0]).toMatchObject({ lojaTreino: false, totalMes: totalOutubro });
      expect(d.vendasPorDia[28]).toEqual({ dia: 29, total: '50.00', mesAnterior: '0.00' });
      if (!hoje.startsWith('2026-10'))
        expect(d.vendas).toMatchObject({ quantidade: 1, ticketMedio: '50.00' });
      const comTreino = await getOk('/api/dashboard', { mes: '2026-10', treino: 'incluir' });
      expect(comTreino.vendasPorDia[28]).toEqual({ dia: 29, total: '70.00', mesAnterior: '0.00' });
      expect(comTreino.vendas.porLoja).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ lojaId: lojaTreino, lojaTreino: true, totalMes: '20.00' }),
        ]),
      );
      const soTreino = await getOk('/api/dashboard', { mes: '2026-10', lojaId: lojaTreino });
      expect(soTreino.vendas).toMatchObject({ total: '20.00', quantidade: 1 });
      const novembro = await getOk('/api/dashboard', { mes: '2026-11' });
      expect(novembro.vendasPorDia[28].mesAnterior).toBe('50.00');
    });

    it('dia: o dia operacional de hoje de cada loja (fuso e corte); a venda de hoje entra no dia e no mês atual', async () => {
      // Sem `mes`, o mês é o do dia operacional da empresa (D7), o mesmo do "hoje" das lojas no corte padrão.
      const { dia, r: d } = await noMesmoDia(() => getOk('/api/dashboard'));
      expect(d.mes).toBe(dia.slice(0, 7));
      // A venda 3 foi gravada no "hoje" de quando o arquivo carregou; se o corte passou desde então, ela é de ontem.
      const deHoje = dia === hoje;
      expect(d.vendas.porLoja[0]).toMatchObject({
        lojaId: loja,
        quantidadeDia: deHoje ? 1 : 0,
        totalDia: deHoje ? '10.00' : '0.00',
      });
      const doMes = await getOk('/api/dashboard', { mes: hoje.slice(0, 7) });
      expect(doMes.vendasPorDia[Number(hoje.slice(8)) - 1].total).toBe(hoje === DIA ? '60.00' : '10.00');
      // Corte na meia-noite só na Loja 1: o "hoje" dela passa a ser a data do relógio.
      await consultar(
        emp.nomeBanco,
        `insert into configuracoes (chave, escopo, loja_id, valor) values ('geral.dia_operacional_hora_corte', 'loja', $1, '"00:00"')`,
        [loja],
      );
      const { dia: relogio, r: meiaNoite } = await noMesmoDia(
        () => getOk('/api/dashboard'),
        () => diaOperacionalEm(new Date(), '00:00'),
      );
      expect(meiaNoite.vendas.porLoja[0]).toMatchObject({
        quantidadeDia: relogio === hoje ? 1 : 0,
      });
      await consultar(
        emp.nomeBanco,
        `delete from configuracoes where chave = 'geral.dia_operacional_hora_corte' and loja_id = $1`,
        [loja],
      );
    });
  });
});

/** Ativa um terminal novo no caixa do ponto substituindo o dele (MD 3.12.1): a nuvem fecha a sessão aberta à força. */
async function substituir(p: Ponto): Promise<void> {
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({
      lojaId: p.loja,
      caixaId: p.caixa,
      descricao: 'PC novo do balcão',
      validadeHoras: 24,
      substituiTerminalId: p.terminal,
    });
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
}

type PayloadFechado = {
  fechamentos_caixa: Payload & { resumo: Payload };
  fechamentos_caixa_formas: Payload[];
  movimentos_caixa: Payload[];
};

describe('sessão fechada pela nuvem e o caixa.fechado tardio (MD 3.12.1; 14.9)', () => {
  it('"Fechada pela nuvem" só até o fechamento do terminal antigo chegar; depois, "Fechada" com a marca no detalhe', async () => {
    const p = await novoPonto(loja, 1);
    await abrir(p);
    await substituir(p);
    const lista = async () =>
      (await getOk('/api/sessoes-caixa', { lojaId: loja, numeroCaixa: p.numero })).itens as Array<{
        id: string;
        situacao: string;
        tipoFechamento: string | null;
      }>;
    expect(await lista()).toEqual([
      expect.objectContaining({ id: p.sessao, situacao: 'fechada_forcado', tipoFechamento: null }),
    ]);
    const forcada = await getOk(`/api/sessoes-caixa/${p.sessao}`);
    expect(forcada).toMatchObject({
      situacao: 'fechada_forcado',
      fechamento: null,
      formas: [],
      fechamentoForcadoMotivo: 'substituicao_terminal',
    });

    // O PC antigo reconecta e sobe o fechamento: o handler grava fechamento e formas mantendo `fechamento_forcado`.
    const fechado = daFixture<PayloadFechado>(p, 'caixa.fechado.payload.json');
    fechado.fechamentos_caixa.resumo.ultima_sequencia_evento = p.seq;
    await aplicar(p, 'caixa.fechado', fechado);
    const [{ fechamento_forcado }] = (await consultar<{ fechamento_forcado: boolean }>(
      emp.nomeBanco,
      'select fechamento_forcado from sessoes_caixa where id = $1',
      [p.sessao],
    )) as [{ fechamento_forcado: boolean }];
    expect(fechamento_forcado).toBe(true);
    expect(await lista()).toEqual([
      expect.objectContaining({ id: p.sessao, situacao: 'fechada', tipoFechamento: 'fechamento' }),
    ]);
    const d = await getOk(`/api/sessoes-caixa/${p.sessao}`);
    expect(d).toMatchObject({
      situacao: 'fechada',
      fechamento: expect.objectContaining({ tipo: 'fechamento' }),
      fechamentoForcadoMotivo: 'substituicao_terminal',
    });
    expect(d.formas).toHaveLength(3);
  });
});

/** Vetor da apuração do caixa compartilhado com o PDV (`ApuracaoVetoresTests`, GenesisPDV.Core.Tests). */
interface PagamentoVetor {
  forma: string;
  valor: string;
  valor_recebido?: string;
  troco?: string;
  estorno?: string;
}
interface CasoApuracao {
  nome: string;
  fundo_troco: string;
  vendas: Array<{ cancelada?: boolean; pagamentos: PagamentoVetor[] }>;
  movimentos: Array<{ tipo: string; valor: string; cancelado?: boolean; forma?: string; venda?: number }>;
  sangria_fechamento: string;
  esperado: Record<string, string> & {
    formas: Record<string, { calculado: string; quantidade_pagamentos: number }>;
  };
}
const VETOR_APURACAO = JSON.parse(fixture('caixa.apuracao.vetores.json')) as {
  formas: Record<string, { descricao: string; tipo_forma: string; permite_troco?: boolean }>;
  casos: CasoApuracao[];
};

describe('cálculo do dinheiro da nuvem = ApuracaoCaixa do PDV (vetor compartilhado, PDV 20.4)', () => {
  // Fora de outubro (e de setembro, do teste da loja inativa) para não mexer nos totais dos outros testes.
  const DIA_VETOR = '2026-08-20';

  it.each(VETOR_APURACAO.casos.map((c) => [c.nome, c] as const))('%s', async (_, caso) => {
    const formas: Record<string, { id: string; tipo: string; descricao: string }> = {
      dinheiro: { id: dinheiro, tipo: 'dinheiro', descricao: 'Dinheiro' },
      credito: { id: credito, tipo: 'cartao_credito', descricao: 'Cartão de Crédito' },
      pix: { id: pix, tipo: 'pix', descricao: 'PIX' },
    };
    for (const [chave, f] of Object.entries(VETOR_APURACAO.formas)) {
      if (formas[chave]) {
        expect(formas[chave].tipo).toBe(f.tipo_forma);
        continue;
      }
      const [{ id }] = (await consultar<{ id: string }>(
        emp.nomeBanco,
        `insert into formas_pagamento (descricao, tipo_forma, meio_pagamento_fiscal, permite_troco)
         values ($1, $2, '10', $3) returning id`,
        [f.descricao, f.tipo_forma, f.permite_troco ?? false],
      )) as [{ id: string }];
      formas[chave] = { id, tipo: f.tipo_forma, descricao: f.descricao };
    }
    const p = await novoPonto(loja, 1);
    const aberto = daFixture<{ sessoes_caixa: { fundo_troco: string } }>(p, 'caixa.aberto.payload.json');
    expect(aberto.sessoes_caixa.fundo_troco).toBe(caso.fundo_troco);
    await aplicar(p, 'caixa.aberto', aberto);

    // Vendas (todas de R$ 5,00 a unidade) e, na cancelada, a forma A com os estornos do vetor.
    const vendas: Array<ReturnType<typeof venda>> = [];
    for (const v of caso.vendas) {
      const total = v.pagamentos.reduce((t, pg) => t + Number(pg.valor), 0);
      const feita = venda(p, produto, total / 5, {
        dia: DIA_VETOR,
        pagamentos: v.pagamentos.map((pg) => ({
          forma: formas[pg.forma]!.id,
          tipo: formas[pg.forma]!.tipo,
          valor: pg.valor,
          ...(pg.troco ? { valorRecebido: pg.valor_recebido, troco: pg.troco } : {}),
        })),
      });
      await aplicar(p, 'venda.finalizada', feita);
      vendas.push(feita);
    }
    const molde = daFixture<{ movimentos_caixa: Payload[] }>(
      p,
      'venda.cancelada.finalizada.payload.json',
      agora(),
    ).movimentos_caixa[0]!;
    for (const [n, v] of caso.vendas.entries()) {
      if (!v.cancelada) continue;
      const cancelamento = daFixture<Payload & { vendas: Payload }>(
        p,
        'venda.cancelada.finalizada.payload.json',
        agora(),
      );
      cancelamento.vendas.id = vendas[n]!.vendas.id;
      cancelamento.pagamentos_venda = v.pagamentos.map((pg, i) => ({
        id: vendas[n]!.pagamentos_venda[i]!.id,
        status: 'estornado',
        estorno: pg.estorno,
      }));
      cancelamento.movimentos_caixa = caso.movimentos
        .filter((m) => m.tipo === 'estorno_venda' && m.venda === n)
        .map((m) => ({ ...molde, id: uuidv7(), forma_pagamento_id: formas[m.forma!]!.id, valor: m.valor }));
      await aplicar(p, 'venda.cancelada', cancelamento);
    }

    // Reforço, sangrias (a cancelada pelo `caixa.movimento_cancelado`) e a devolução de troca.
    for (const m of caso.movimentos) {
      if (m.tipo === 'reforco') {
        const r = daFixture<{ movimentos_caixa: Payload }>(p, 'caixa.reforco.payload.json');
        Object.assign(r.movimentos_caixa, { id: uuidv7(), valor: m.valor });
        await aplicar(p, 'caixa.reforco', r);
      } else if (m.tipo === 'sangria') {
        const sg = daFixture<{ movimentos_caixa: Payload }>(p, 'caixa.sangria.payload.json');
        // A sangria cancelada fica com o id da fixture, o que o `caixa.movimento_cancelado` cita.
        Object.assign(sg.movimentos_caixa, { valor: m.valor, ...(m.cancelado ? {} : { id: uuidv7() }) });
        await aplicar(p, 'caixa.sangria', sg);
        if (m.cancelado)
          await aplicar(
            p,
            'caixa.movimento_cancelado',
            daFixture(p, 'caixa.movimento_cancelado.payload.json'),
          );
      } else if (m.tipo === 'devolucao_troca') {
        // Nenhum evento da 1C traz a devolução de troca (a troca é da Fase 3): a linha vai direto, como chegaria.
        await consultar(
          emp.nomeBanco,
          `insert into movimentos_caixa (sessao_caixa_id, loja_id, caixa_id, numero_caixa, terminal_id, tipo, valor,
                                         operador_id, ocorrido_em)
           select sessao_caixa_id, loja_id, caixa_id, numero_caixa, terminal_id, 'devolucao_troca', $2, operador_id, now()
             from movimentos_caixa where sessao_caixa_id = $1 and tipo = 'abertura'`,
          [p.sessao, m.valor],
        );
      } else expect(m.tipo).toBe('estorno_venda');
    }

    // O fechamento leva o calculado por forma do vetor, o mesmo que o ApuracaoCaixa do PDV dá para este turno.
    const fechado = daFixture<PayloadFechado>(p, 'caixa.fechado.payload.json');
    const [moldeForma] = fechado.fechamentos_caixa_formas;
    const e = caso.esperado;
    fechado.fechamentos_caixa_formas = Object.entries(e.formas).map(([chave, f]) => ({
      ...moldeForma,
      id: uuidv7(),
      forma_pagamento_id: formas[chave]!.id,
      descricao_forma: formas[chave]!.descricao,
      tipo_forma: formas[chave]!.tipo,
      valor_calculado: f.calculado,
      valor_digitado: f.calculado,
      quantidade_pagamentos: f.quantidade_pagamentos,
    }));
    const totalCalculado = Object.values(e.formas)
      .reduce((t, f) => t + Number(f.calculado), 0)
      .toFixed(2);
    Object.assign(fechado.fechamentos_caixa, {
      total_calculado: totalCalculado,
      total_digitado: totalCalculado,
    });
    fechado.fechamentos_caixa.resumo.ultima_sequencia_evento = p.seq;
    fechado.movimentos_caixa[0]!.valor = caso.sangria_fechamento;
    await aplicar(p, 'caixa.fechado', fechado);

    const d = await getOk(`/api/sessoes-caixa/${p.sessao}`);
    expect(d.calculoDinheiro).toEqual({
      fundoTroco: caso.fundo_troco,
      vendasDinheiro: e.vendas_dinheiro,
      trocoOutrasFormas: e.troco_outras_formas,
      reforcos: e.reforcos,
      sangrias: e.sangrias,
      estornosDinheiro: e.estornos_dinheiro,
      devolucoes: e.devolucoes,
      esperado: e.dinheiro,
      sangriaFechamento: caso.sangria_fechamento,
    });
    // Sem evento faltando, o refeito na nuvem bate com o calculado que o PDV mandou: nada de aviso na tela.
    expect(d.formas[0]).toMatchObject({ tipoForma: 'dinheiro', valorCalculado: d.calculoDinheiro.esperado });
  });
});

describe('Dashboard: loja inativa, estoque abaixo do mínimo e PDVs da loja de treino', () => {
  it('a loja inativada continua nas vendas do mês em que vendeu, igual à listagem de Vendas', async () => {
    const lojaFechada = await criarLoja(emp.nomeBanco, 3, 'Loja 3 - Desativada');
    const p = await novoPonto(lojaFechada, 3);
    await abrir(p);
    await aplicar(p, 'venda.finalizada', venda(p, produto, 6, { dia: '2026-09-10' }));
    await consultar(emp.nomeBanco, 'update lojas set ativa = false where id = $1', [lojaFechada]);

    const d = await getOk('/api/dashboard', { mes: '2026-09' });
    expect(d.vendas).toMatchObject({ total: '30.00', quantidade: 1 });
    // As lojas ativas aparecem mesmo zeradas; a inativa, por ter vendido no mês.
    expect(d.vendas.porLoja).toEqual([
      expect.objectContaining({ lojaId: loja, totalMes: '0.00' }),
      expect.objectContaining({ lojaId: lojaFechada, totalMes: '30.00' }),
    ]);
    expect(d.vendasPorDia[9]).toMatchObject({ dia: 10, total: '30.00' });
    const lista = await getOk('/api/vendas', {
      dataInicial: '2026-09-01',
      dataFinal: '2026-09-30',
      situacao: 'finalizada',
    });
    expect(lista.totais.totalLiquido).toBe(d.vendas.total);
    // Sem venda no mês, a loja inativa não aparece na tabela por loja.
    const outubro = await getOk('/api/dashboard', { mes: '2026-10' });
    expect(outubro.vendas.porLoja.map((l: { lojaId: string }) => l.lojaId)).not.toContain(lojaFechada);
  });

  it('estoque abaixo do mínimo sem a loja de treino por padrão; os PDVs contam o terminal dela', async () => {
    // A loja de treino vendeu 4 unidades sem saldo: abaixo do mínimo de 5.
    const atualizados = await consultar(
      emp.nomeBanco,
      'update produtos_lojas set estoque_minimo = 5 where produto_id = $1 and loja_id = $2 returning id',
      [produto, lojaTreino],
    );
    if (atualizados.length === 0)
      await consultar(
        emp.nomeBanco,
        'insert into produtos_lojas (produto_id, loja_id, estoque_minimo) values ($1, $2, 5)',
        [produto, lojaTreino],
      );
    const lojasDoBaixo = (d: { estoqueBaixo: Array<{ lojaNome: string }> }) =>
      d.estoqueBaixo.map((e) => e.lojaNome);
    expect(lojasDoBaixo(await getOk('/api/dashboard', { mes: '2026-10' }))).not.toContain('Loja Treino');
    expect(lojasDoBaixo(await getOk('/api/dashboard', { mes: '2026-10', treino: 'incluir' }))).toContain(
      'Loja Treino',
    );
    expect(lojasDoBaixo(await getOk('/api/dashboard', { mes: '2026-10', lojaId: lojaTreino }))).toEqual([
      'Loja Treino',
    ]);

    const [{ todos, treino }] = (await consultar<{ todos: number; treino: number }>(
      emp.nomeBanco,
      `select count(*)::int as todos, count(*) filter (where t.loja_id = $1)::int as treino
         from terminais t join lojas l on l.id = t.loja_id
        where t.status = 'ativo' and t.excluido_em is null and l.ativa and l.excluido_em is null`,
      [lojaTreino],
    )) as [{ todos: number; treino: number }];
    expect(treino).toBe(1);
    expect((await getOk('/api/dashboard', { mes: '2026-10' })).pdvs.total).toBe(todos);
    expect((await getOk('/api/dashboard', { mes: '2026-10', lojaId: lojaTreino })).pdvs.total).toBe(1);
  });
});
