/**
 * Transferência entre estoques: rascunho, enviar e cancelar (Fase 2, F2-B23; ERP 13.7, 13.1.4; SYNC 15.1; T20; README
 * da API › decisão 171), pela API do ERP e pelo push real do PDV. O critério de pronto: enviar 5 fardos do CD para a
 * Loja 2 tira 60 unidades do CD ao custo médio, e cancelar devolve exatamente o que saiu (saldo, custo e custo médio).
 * Também: enviar sem saldo é 422 (o Master e `estoque.permite_negativo_erp` passam); o envio repetido e o simultâneo
 * não lançam de novo; a versão; o lote informado e a divisão FEFO, com o retorno de cada parte ao seu lote; a
 * compensação contra o "Definir" com a contagem à frente e o estorno dela no cancelamento; quem vê (origem ou destino)
 * e quem grava (só a origem); as conferências do rascunho; o cancelamento do rascunho e as situações finais; a NF-e de
 * fora; o seletor de destino (todo estoque ativo, fora dos permitidos); as travas de inativar e excluir o estoque e o
 * tipo de estoque com transferência pendente; o envio disparado junto da venda do PDV na origem, 20 vezes (os dois em
 * série pela trava 7300001), com o saldo novo descendo ao PDV. No fim o razão refaz as projeções idênticas
 * (`conferirRazaoDoBanco`, o núcleo do `db:recalcular-saldos`).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRATOS_EVENTOS, jcs, respostaPullSchema, respostaPushSchema, type Ativar } from '@genesis/shared';
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
let tokenAdmin: string;
/** Estoquista do CD e da Loja 1 (sem Master, sem saldo negativo): monta, envia e cancela. */
let tokenExpedicao: string;
/** Estoquista só da Loja 2: vê a transferência que vai receber, mas não mexe no documento do CD. */
let tokenLoja2: string;
/** Estoquista sem estoque nenhum. */
let tokenSemEstoque: string;
let un: string;
let loja1: string;
let estoqueLoja1: string;
let estoqueLoja2: string;
let cd: string;
let tipoPadrao: string;
let tipoVasilhame: string;
let operador: string;
let dinheiro: string;

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const agora = () => new Date().toISOString();
const minutosAtras = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

async function produto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '8', precoCusto: '4', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** Cria e efetiva um acerto pelo admin (o saldo anterior, ou o "Definir"). */
async function acerto(estoqueId: string, corpo: Record<string, unknown>): Promise<string> {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({ estoqueId, motivo: 'Teste da transferência', dataContagem: agora(), ...corpo });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const ef = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: a.body.versao });
  expect(ef.status, JSON.stringify(ef.body)).toBe(200);
  return a.body.id as string;
}

const entrada = (
  estoqueId: string,
  itens: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => acerto(estoqueId, { tipoAjuste: 'entrada', itens, ...extra });

async function lote(produtoId: string, codigo: string, validade: string, estoque: string | null = cd) {
  const [{ id }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into produtos_lotes (produto_id, estoque_id, lote, validade) values ($1, $2, $3, $4) returning id',
    [produtoId, estoque, codigo, validade],
  )) as [{ id: string }];
  return id;
}

const criar = (corpo: Record<string, unknown>, token = tokenAdmin) =>
  amb.http().post('/api/transferencias').set(bearer(token)).send(corpo);

/** Cria o rascunho CD → Loja 2 (padrão) e devolve o detalhe. */
async function rascunho(
  itens: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
  token = tokenAdmin,
) {
  const r = await criar(
    { estoqueOrigemId: cd, estoqueDestinoId: estoqueLoja2, motivo: 'Reposição semanal', itens, ...extra },
    token,
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as {
    id: string;
    versao: number;
    codigo: number;
    data: string;
    status: string;
    itens: Array<{ id: string; produtoId: string; quantidadeEnviada: string; custoUnitario: string | null }>;
  };
}

const enviar = (id: string, corpo: Record<string, unknown> = {}, token = tokenAdmin) =>
  amb.http().post(`/api/transferencias/${id}/enviar`).set(bearer(token)).send(corpo);
const cancelar = (id: string, motivo: string, token = tokenAdmin, extra: Record<string, unknown> = {}) =>
  amb
    .http()
    .post(`/api/transferencias/${id}/cancelar`)
    .set(bearer(token))
    .send({ motivo, ...extra });
const obter = (id: string, token = tokenAdmin) =>
  amb.http().get(`/api/transferencias/${id}`).set(bearer(token));

async function saldo(estoqueId: string, produtoId: string, tipoEstoqueId = tipoPadrao) {
  const [s] = await consultar<{ quantidade: string; custo_medio: string }>(
    emp.nomeBanco,
    `select quantidade::text, custo_medio::text from saldos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoqueId, produtoId, tipoEstoqueId],
  );
  return s ?? { quantidade: '0.000', custo_medio: '0.0000' };
}

async function saldosLote(estoqueId: string, produtoId: string) {
  const rows = await consultar<{ lote_id: string; quantidade: string }>(
    emp.nomeBanco,
    'select lote_id, quantidade::text from saldos_lote where estoque_id = $1 and produto_id = $2 order by lote_id',
    [estoqueId, produtoId],
  );
  return Object.fromEntries(rows.map((r) => [r.lote_id, r.quantidade]));
}

const movimentos = (transferenciaId: string) =>
  consultar<{
    id: string;
    tipo_movimento: string;
    estoque_id: string;
    quantidade: string;
    custo_unitario: string;
    custo_total: string;
    lote_id: string | null;
    estorno_de_id: string | null;
    documento_item_id: string | null;
    loja_id: string | null;
  }>(
    emp.nomeBanco,
    `select id, tipo_movimento, estoque_id, quantidade::text, custo_unitario::text, custo_total::text, lote_id,
            estorno_de_id, documento_item_id, loja_id
       from movimentos_estoque where documento_tipo = 'transferencia' and documento_id = $1 order by seq_lancamento`,
    [transferenciaId],
  );

// ---------------------------------------------------------------- PDV (a venda na origem e o pull do saldo)

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

interface Ponto {
  caixa: string;
  terminal: string;
  token: string;
  seq: number;
  venda: number;
  sessao: string;
}

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja1,
  caixa_id: p.caixa,
  numero_caixa: 1,
  terminal_id: p.terminal,
});

function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Record<string, unknown>) {
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
    contexto: { loja_id: loja1, caixa_id: p.caixa, numero_caixa: 1, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

async function aplicar(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Record<string, unknown>) {
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
  expect(r.body.resultados[0], JSON.stringify(r.body)).toMatchObject({ status: 'aplicado' });
}

async function novoPonto(): Promise<Ponto> {
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja1],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: loja1, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
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
    terminal: r.body.terminal_id,
    token: r.body.token,
    seq: 0,
    venda: 0,
    sessao: uuidv7(),
  };
  await aplicar(p, 'caixa.aberto', {
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
  });
  return p;
}

/** Venda finalizada do PDV-1 (sem lote), com um item por produto, paga em dinheiro. */
function venda(p: Ponto, itens: Array<[string, string]>) {
  const id = uuidv7();
  const numero = ++p.venda;
  const quando = minutosAtras(1);
  const total = itens.reduce((s, [, q]) => s + 5 * Number(q), 0).toFixed(2);
  return {
    vendas: {
      id,
      numero,
      numero_exibicao: `L01-C01-${String(numero).padStart(6, '0')}`,
      ...linhaDoPonto(p),
      sessao_caixa_id: p.sessao,
      tipo: 'pdv',
      status: 'finalizada',
      dia_operacional: '2026-11-04',
      operador_id: operador,
      cliente_id: null,
      subtotal_bruto: total,
      total,
      iniciada_em: quando,
      finalizada_em: quando,
    },
    itens_venda: itens.map(([produtoId, quantidade], i) => ({
      id: uuidv7(),
      venda_id: id,
      sequencia: i + 1,
      produto_id: produtoId,
      descricao: 'ITEM DE TESTE',
      unidade: 'UN',
      quantidade,
      preco_tabela: '5.0000',
      preco_unitario: '5.0000',
      valor_bruto: (5 * Number(quantidade)).toFixed(2),
      valor_liquido: (5 * Number(quantidade)).toFixed(2),
      incluido_em: quando,
      componentes_estoque: [],
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

async function puxar(p: Ponto, fluxo: 'catalogo' | 'estoque', desde: number) {
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

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  const loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  const estoqueDa = async (loja: string) =>
    (
      await consultar<{ estoque_id: string }>(emp.nomeBanco, 'select estoque_id from lojas where id = $1', [
        loja,
      ])
    )[0]!.estoque_id;
  estoqueLoja1 = await estoqueDa(loja1);
  estoqueLoja2 = await estoqueDa(loja2);
  [{ id: cd }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD - Estoque Ice Beer', 'deposito') returning id",
  )) as [{ id: string }];
  [{ id: tipoPadrao }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'select id from tipos_estoque where padrao and excluido_em is null',
  )) as [{ id: string }];
  [{ id: tipoVasilhame }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from tipos_estoque where chave_sistema = 'vasilhame_vazio'",
  )) as [{ id: string }];
  [{ id: operador }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  [{ id: dinheiro }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null order by ordem limit 1",
  )) as [{ id: string }];
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, {
    login: 'expedicao',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [cd, estoqueLoja1],
  });
  await criarUsuario(emp.nomeBanco, {
    login: 'loja2',
    perfil: 'estoquista',
    lojas: [loja2],
    estoques: [estoqueLoja2],
  });
  await criarUsuario(emp.nomeBanco, { login: 'semestoque', perfil: 'estoquista', lojas: [], estoques: [] });
  tokenExpedicao = await amb.entrar(emp.codigo, 'expedicao', SENHA_TESTE);
  tokenLoja2 = await amb.entrar(emp.codigo, 'loja2', SENHA_TESTE);
  tokenSemEstoque = await amb.entrar(emp.codigo, 'semestoque', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('enviar e cancelar a transferência (F2-B23; ERP 13.7)', () => {
  it('5 fardos (60 un) do CD para a Loja 2: saem ao custo médio; cancelar devolve exatamente o que saiu (critério de pronto)', async () => {
    const p = await produto('Cerveja Pilsen lata 350ml');
    // Saldo no CD: 30 a R$ 4,00 + 70 a R$ 5,00 = 100 ao custo médio de R$ 4,70.
    await entrada(cd, [{ produtoId: p, quantidade: '30', custoUnitario: '4' }]);
    await entrada(cd, [{ produtoId: p, quantidade: '70', custoUnitario: '5' }]);
    expect(await saldo(cd, p)).toEqual({ quantidade: '100.000', custo_medio: '4.7000' });

    const r = await rascunho([{ produtoId: p, quantidade: '60' }], {}, tokenExpedicao);
    expect(r).toMatchObject({ status: 'rascunho', tipoEstoqueId: tipoPadrao, qtdItens: 1 });
    expect(r.itens[0]).toMatchObject({
      quantidadeEnviada: '60.000',
      custoUnitario: null,
      saldoOrigem: '100.000',
    });
    // Nada sai no rascunho.
    expect(await movimentos(r.id)).toEqual([]);

    const e = await enviar(r.id, { versao: r.versao }, tokenExpedicao);
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body).toMatchObject({
      status: 'em_transito',
      enviadaPorNome: 'EXPEDICAO',
      enviadaEm: expect.any(String),
    });
    // O Estoquista não vê o custo (`produtos.ver_custo`); o admin vê o custo médio gravado no item.
    expect(e.body.itens[0]).toMatchObject({
      quantidadeEnviada: '60.000',
      quantidadeRecebida: null,
      diferenca: '0.000',
      custoUnitario: null,
      saldoOrigem: '40.000',
    });
    expect((await obter(r.id)).body.itens[0].custoUnitario).toBe('4.7000');
    expect(await saldo(cd, p)).toEqual({ quantidade: '40.000', custo_medio: '4.7000' });
    // O destino não recebe nada até o recebimento (F2-B24).
    expect((await saldo(estoqueLoja2, p)).quantidade).toBe('0.000');
    const [saida] = await movimentos(r.id);
    expect(await movimentos(r.id)).toHaveLength(1);
    expect(saida).toMatchObject({
      tipo_movimento: 'TRANSF_SAIDA',
      estoque_id: cd,
      quantidade: '-60.000',
      custo_unitario: '4.7000',
      custo_total: '282.00',
      lote_id: null,
      documento_item_id: r.itens[0]!.id,
      // O CD não tem loja.
      loja_id: null,
    });
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'transferencias_estoque' and registro_id = $1 and acao = 'movimentar'`,
      [r.id],
    );
    expect(aud!.descricao).toBe(`Transferência Nº ${r.codigo} enviada: 1 item(ns), 1 movimento(s)`);
    // A listagem pelo dia do envio (fuso da empresa) e pela situação.
    const lista = await amb
      .http()
      .get(
        `/api/transferencias?periodo=envio&dataInicial=${r.data}&dataFinal=${r.data}&status=em_transito&ordenar=enviada_em:desc`,
      )
      .set(bearer(tokenExpedicao));
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    expect(lista.body.itens.map((t: { id: string }) => t.id)).toContain(r.id);
    expect(lista.body.itens.find((t: { id: string }) => t.id === r.id)).toMatchObject({
      codigo: r.codigo,
      estoqueOrigemNome: 'CD - Estoque Ice Beer',
      estoqueDestinoNome: 'Estoque Loja 2 - Bairro',
      enviadaEm: expect.any(String),
      qtdItens: 1,
    });
    const antes = await amb
      .http()
      .get(`/api/transferencias?periodo=envio&dataFinal=2026-01-01`)
      .set(bearer(tokenExpedicao));
    expect(antes.body.itens.map((t: { id: string }) => t.id)).not.toContain(r.id);
    // Em trânsito, o documento não se altera nem se exclui.
    const put = await amb
      .http()
      .put(`/api/transferencias/${r.id}`)
      .set(bearer(tokenExpedicao))
      .send({
        estoqueOrigemId: cd,
        estoqueDestinoId: estoqueLoja2,
        motivo: 'Outra',
        versao: e.body.versao,
        itens: [{ produtoId: p, quantidade: '1' }],
      });
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    expect((await amb.http().delete(`/api/transferencias/${r.id}`).set(bearer(tokenExpedicao))).status).toBe(
      422,
    );

    // Cancelar devolve exatamente o que saiu (60 a R$ 4,70), e o saldo e o custo médio do CD voltam aos de antes (a
    // entrada no meio, com o custo médio mudado, fica no teste seguinte; T20).
    const c = await cancelar(r.id, 'Caminhão quebrou', tokenExpedicao, { versao: e.body.versao });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({
      status: 'cancelada',
      canceladaPorNome: 'EXPEDICAO',
      motivoCancelamento: 'Caminhão quebrou',
    });
    expect(await saldo(cd, p)).toEqual({ quantidade: '100.000', custo_medio: '4.7000' });
    const ms = await movimentos(r.id);
    expect(ms).toHaveLength(2);
    expect(ms[1]).toMatchObject({
      tipo_movimento: 'TRANSF_RETORNO',
      estoque_id: cd,
      quantidade: '60.000',
      custo_unitario: '4.7000',
      custo_total: '282.00',
      estorno_de_id: saida!.id,
      documento_item_id: r.itens[0]!.id,
    });
    // Cancelada é o fim.
    expect((await cancelar(r.id, 'De novo', tokenExpedicao)).status).toBe(422);
    const reenvio = await enviar(r.id, {}, tokenExpedicao);
    expect(reenvio.status).toBe(422);
    expect(reenvio.body.mensagem).toContain('cancelada');
  });

  it('o retorno do cancelamento entra ao custo da saída mesmo com o custo médio mudado no meio (T20)', async () => {
    const p = await produto('Refrigerante cola 2L');
    await entrada(cd, [{ produtoId: p, quantidade: '20', custoUnitario: '6' }]);
    const r = await rascunho([{ produtoId: p, quantidade: '10' }]);
    expect((await enviar(r.id)).status).toBe(200);
    // 10 a R$ 6,00 ficam; entram 10 a R$ 8,00: custo médio R$ 7,00 com 20.
    await entrada(cd, [{ produtoId: p, quantidade: '10', custoUnitario: '8' }]);
    expect(await saldo(cd, p)).toEqual({ quantidade: '20.000', custo_medio: '7.0000' });
    expect((await cancelar(r.id, 'Pedido desfeito')).status).toBe(200);
    // (20 × 7 + 10 × 6) / 30 = 6,6667: o valor que saiu volta igual.
    expect(await saldo(cd, p)).toEqual({ quantidade: '30.000', custo_medio: '6.6667' });
    expect((await movimentos(r.id)).map((m) => [m.tipo_movimento, m.custo_total])).toEqual([
      ['TRANSF_SAIDA', '60.00'],
      ['TRANSF_RETORNO', '60.00'],
    ]);
  });

  it('enviar sem saldo é 422 no item, sem lançar nada; o Master e "Permite saldo negativo no ERP" enviam', async () => {
    const p = await produto('Cerveja IPA long neck');
    const q = await produto('Cerveja Weiss long neck');
    await entrada(cd, [
      { produtoId: p, quantidade: '5', custoUnitario: '7' },
      { produtoId: q, quantidade: '50', custoUnitario: '6' },
    ]);
    const r = await rascunho(
      [
        { produtoId: q, quantidade: '10' },
        { produtoId: p, quantidade: '6' },
      ],
      {},
      tokenExpedicao,
    );
    const e = await enviar(r.id, {}, tokenExpedicao);
    expect(e.status, JSON.stringify(e.body)).toBe(422);
    expect(e.body.campos['itens.1.quantidade'][0]).toBe(
      'Saldo insuficiente de Cerveja IPA long neck na origem: 5 UN',
    );
    expect(e.body.campos['itens.0.quantidade']).toBeUndefined();
    expect(await movimentos(r.id)).toEqual([]);
    expect((await obter(r.id)).body.status).toBe('rascunho');

    // Com a chave da empresa ligada (o CD não tem loja), o estoquista envia e a origem fica negativa.
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (chave, valor) values ('estoque.permite_negativo_erp', 'true'::jsonb)`,
    );
    try {
      const ok = await enviar(r.id, {}, tokenExpedicao);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    } finally {
      await consultar(
        emp.nomeBanco,
        `delete from configuracoes where chave = 'estoque.permite_negativo_erp'`,
      );
    }
    expect((await saldo(cd, p)).quantidade).toBe('-1.000');
    expect((await cancelar(r.id, 'Saiu por engano')).status).toBe(200);
    expect((await saldo(cd, p)).quantidade).toBe('5.000');

    // O Master envia sem a chave.
    const m = await rascunho([{ produtoId: p, quantidade: '8' }]);
    expect((await enviar(m.id)).status).toBe(200);
    expect((await saldo(cd, p)).quantidade).toBe('-3.000');
    expect((await cancelar(m.id, 'Teste do Master')).status).toBe(200);
    expect((await saldo(cd, p)).quantidade).toBe('5.000');
  });

  it('enviar de novo e em paralelo não lança outra saída; a versão velha é 409', async () => {
    const p = await produto('Água mineral 500ml');
    await entrada(cd, [{ produtoId: p, quantidade: '48', custoUnitario: '1.2' }]);
    const r = await rascunho([{ produtoId: p, quantidade: '24' }]);
    const conflito = await enviar(r.id, { versao: r.versao - 1 });
    expect(conflito.status, JSON.stringify(conflito.body)).toBe(409);
    const [a, b] = await Promise.all([
      enviar(r.id, { versao: r.versao }),
      enviar(r.id, { versao: r.versao }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Já enviada: devolve o detalhe sem conferir a versão nem lançar nada.
    const c = await enviar(r.id, { versao: 1 });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('em_transito');
    expect(await movimentos(r.id)).toHaveLength(1);
    expect((await saldo(cd, p)).quantidade).toBe('24.000');
    expect((await cancelar(r.id, 'Teste', tokenAdmin, { versao: r.versao - 1 })).status).toBe(409);
  });

  it('com lote informado sai do lote; sem lote, em FEFO (um movimento por lote); o cancelamento volta cada parte ao lote', async () => {
    const p = await produto('Iogurte de morango 170g');
    const a = await lote(p, 'IO-A', '2026-12-01');
    const b = await lote(p, 'IO-B', '2027-01-15', null);
    const c = await lote(p, 'IO-C', '2027-03-01');
    await entrada(cd, [
      { produtoId: p, loteId: a, quantidade: '10', custoUnitario: '2' },
      { produtoId: p, loteId: b, quantidade: '10', custoUnitario: '2' },
      { produtoId: p, loteId: c, quantidade: '10', custoUnitario: '2' },
    ]);
    // O lote de outro estoque é recusado no rascunho.
    const outro = await lote(p, 'IO-L1', '2027-05-01', estoqueLoja1);
    const recusa = await criar({
      estoqueOrigemId: cd,
      estoqueDestinoId: estoqueLoja2,
      motivo: 'Lote errado',
      itens: [{ produtoId: p, loteId: outro, quantidade: '1' }],
    });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(422);
    expect(recusa.body.campos['itens.0.loteId'][0]).toBe('O lote é de outro estoque');

    // O item com o lote A (o que vence primeiro) reserva o lote antes de o item sem lote, que vem antes no documento,
    // ser dividido: a FEFO pega as 2 que sobram do A, o B inteiro e 3 do C. Sem a reserva, a FEFO esvaziaria o A
    // (10, depois 5 do B) e o item com lote ficaria sem saldo nele.
    const r = await rascunho([
      { produtoId: p, quantidade: '15' },
      { produtoId: p, loteId: a, quantidade: '8' },
    ]);
    // Sem saldo no lote: 422 no item.
    const semLote = await rascunho([{ produtoId: p, loteId: c, quantidade: '11' }], {}, tokenExpedicao);
    const e1 = await enviar(semLote.id, {}, tokenExpedicao);
    expect(e1.status, JSON.stringify(e1.body)).toBe(422);
    expect(e1.body.campos['itens.0.quantidade'][0]).toBe(
      'Saldo insuficiente do lote de Iogurte de morango 170g na origem: 10 UN',
    );
    expect(
      (await amb.http().delete(`/api/transferencias/${semLote.id}`).set(bearer(tokenExpedicao))).status,
    ).toBe(204);

    const e = await enviar(r.id);
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body.itens.map((i: { lote: string | null }) => i.lote)).toEqual([null, 'IO-A']);
    expect(await saldosLote(cd, p)).toEqual({ [a]: '0.000', [b]: '0.000', [c]: '7.000' });
    const saidas = await movimentos(r.id);
    expect(saidas.map((m) => [m.documento_item_id, m.lote_id, m.quantidade])).toEqual(
      expect.arrayContaining([
        [r.itens[0]!.id, a, '-2.000'],
        [r.itens[0]!.id, b, '-10.000'],
        [r.itens[0]!.id, c, '-3.000'],
        [r.itens[1]!.id, a, '-8.000'],
      ]),
    );
    expect(saidas).toHaveLength(4);
    expect((await cancelar(r.id, 'Lote errado')).status).toBe(200);
    expect(await saldosLote(cd, p)).toEqual({ [a]: '10.000', [b]: '10.000', [c]: '10.000' });
    const retornos = (await movimentos(r.id)).filter((m) => m.tipo_movimento === 'TRANSF_RETORNO');
    expect(retornos.map((m) => [m.estorno_de_id, m.lote_id, m.quantidade])).toEqual(
      expect.arrayContaining(saidas.map((s) => [s.id, s.lote_id, s.quantidade.replace('-', '')])),
    );
    expect(retornos).toHaveLength(4);
  });

  it('"Definir" com a contagem um pouco à frente anula a saída; o cancelamento estorna o retorno e a compensação', async () => {
    const p = await produto('Gelo em cubos 5kg');
    await entrada(cd, [{ produtoId: p, quantidade: '40', custoUnitario: '3' }]);
    // A contagem informada para daqui a 4 min (dentro da folga do criarAcertoSchema): diferença 0.
    const definir = await acerto(cd, {
      tipoAjuste: 'definir',
      dataContagem: new Date(Date.now() + 4 * 60_000).toISOString(),
      itens: [{ produtoId: p, quantidade: '40' }],
    });
    const r = await rascunho([{ produtoId: p, quantidade: '12' }]);
    expect((await enviar(r.id)).status).toBe(200);
    // A saída é anterior à contagem: a contagem vale (o saldo do CD fica 40), e a saída é anulada contra o "Definir".
    expect((await saldo(cd, p)).quantidade).toBe('40.000');
    const compensacoes = await consultar<{ id: string; quantidade: string; documento_id: string }>(
      emp.nomeBanco,
      `select c.id, c.quantidade::text, c.documento_id from movimentos_estoque c
         join movimentos_estoque o on o.id = c.compensa_movimento_id
        where o.documento_tipo = 'transferencia' and o.documento_id = $1`,
      [r.id],
    );
    expect(compensacoes).toEqual([{ id: expect.any(String), quantidade: '12.000', documento_id: definir }]);
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'transferencias_estoque' and registro_id = $1 and acao = 'movimentar'`,
      [r.id],
    );
    expect(aud!.descricao).toMatch(/1 anulado\(s\) por "Definir"/);
    expect((await cancelar(r.id, 'Contagem já tinha tirado')).status).toBe(200);
    expect((await saldo(cd, p)).quantidade).toBe('40.000');
    expect((await movimentos(r.id)).map((m) => [m.tipo_movimento, m.quantidade, m.estorno_de_id])).toEqual([
      ['TRANSF_SAIDA', '-12.000', null],
      ['TRANSF_RETORNO', '12.000', expect.any(String)],
      ['ESTORNO_ACERTO', '-12.000', compensacoes[0]!.id],
    ]);
    // Nenhum movimento contraria o sinal do catálogo (MD 7.3).
    const contra = await consultar(
      emp.nomeBanco,
      `select m.tipo_movimento from movimentos_estoque m join tipos_movimento_estoque t on t.codigo = m.tipo_movimento
        where m.produto_id = $1 and t.sinal <> 0 and sign(m.quantidade) <> t.sinal`,
      [p],
    );
    expect(contra).toEqual([]);
  });

  it('cancelar o rascunho não mexe no estoque; a recebida não se cancela', async () => {
    const p = await produto('Carvão vegetal 3kg');
    await entrada(cd, [{ produtoId: p, quantidade: '10', custoUnitario: '9' }]);
    const r = await rascunho([{ produtoId: p, quantidade: '2' }]);
    const c = await cancelar(r.id, 'Desisti', tokenExpedicao);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelada', enviadaEm: null });
    expect(await movimentos(r.id)).toEqual([]);
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'transferencias_estoque' and registro_id = $1 and acao = 'cancelar'`,
      [r.id],
    );
    expect(aud!.descricao).toBe(
      `Transferência Nº ${r.codigo} cancelada (rascunho, sem efeito no estoque): Desisti`,
    );
    // A cancelada não se exclui (só o rascunho).
    expect((await amb.http().delete(`/api/transferencias/${r.id}`).set(bearer())).status).toBe(422);

    // A recebida (o recebimento é do F2-B24; aqui direto no banco, pelas etapas do trigger) não se cancela.
    const s = await rascunho([{ produtoId: p, quantidade: '3' }]);
    expect((await enviar(s.id)).status).toBe(200);
    await consultar(
      emp.nomeBanco,
      'update itens_transferencia set quantidade_recebida = 3 where transferencia_id = $1',
      [s.id],
    );
    await consultar(
      emp.nomeBanco,
      "update transferencias_estoque set status = 'recebida', recebida_em = now() where id = $1",
      [s.id],
    );
    const nao = await cancelar(s.id, 'Tarde demais');
    expect(nao.status).toBe(422);
    expect(nao.body.mensagem).toContain('transferência no sentido inverso');
  });
});

describe('rascunho, acesso e conferências (F2-B23)', () => {
  it('cria, altera e exclui o rascunho; o tipo e a data vazios viram o padrão e hoje', async () => {
    const p = await produto('Amendoim torrado 500g');
    const q = await produto('Batata palha 500g');
    const r = await rascunho([{ produtoId: p, quantidade: '1.5' }], { observacoes: 'Separar no corredor 3' });
    expect(r).toMatchObject({
      estoqueOrigemId: cd,
      estoqueOrigemNome: 'CD - Estoque Ice Beer',
      estoqueDestinoNome: 'Estoque Loja 2 - Bairro',
      tipoEstoqueId: tipoPadrao,
      tipoEstoqueNome: 'Disponível',
      motivo: 'Reposição semanal',
      observacoes: 'Separar no corredor 3',
      data: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    // Sem linha de saldo na origem: o saldo é zero.
    expect(r.itens[0]).toMatchObject({ quantidadeEnviada: '1.500', saldoOrigem: '0.000' });
    const alterado = await amb
      .http()
      .put(`/api/transferencias/${r.id}`)
      .set(bearer())
      .send({
        versao: r.versao,
        estoqueOrigemId: cd,
        estoqueDestinoId: estoqueLoja1,
        tipoEstoqueId: tipoVasilhame,
        data: '2026-11-01',
        motivo: 'Cascos de volta',
        itens: [
          { id: r.itens[0]!.id, produtoId: p, quantidade: '2' },
          { produtoId: q, quantidade: '3' },
        ],
      });
    expect(alterado.status, JSON.stringify(alterado.body)).toBe(200);
    expect(alterado.body).toMatchObject({
      estoqueDestinoId: estoqueLoja1,
      tipoEstoqueId: tipoVasilhame,
      data: '2026-11-01',
      qtdItens: 2,
    });
    // O item mantido continua com o mesmo id e a mesma sequência.
    expect(alterado.body.itens.map((i: { id: string; sequencia: number }) => [i.id, i.sequencia])).toEqual([
      [r.itens[0]!.id, 1],
      [expect.any(String), 2],
    ]);
    // A versão velha é 409; tirar um item o exclui logicamente.
    const velho = await amb.http().put(`/api/transferencias/${r.id}`).set(bearer()).send({
      versao: r.versao,
      estoqueOrigemId: cd,
      estoqueDestinoId: estoqueLoja1,
      motivo: 'x',
      itens: [],
    });
    expect(velho.status).toBe(409);
    const menos = await amb
      .http()
      .put(`/api/transferencias/${r.id}`)
      .set(bearer())
      .send({
        versao: alterado.body.versao,
        estoqueOrigemId: cd,
        estoqueDestinoId: estoqueLoja1,
        motivo: 'Cascos de volta',
        itens: [{ produtoId: q, quantidade: '3' }],
      });
    expect(menos.status, JSON.stringify(menos.body)).toBe(200);
    expect(menos.body.qtdItens).toBe(1);
    expect(menos.body.tipoEstoqueId).toBe(tipoPadrao);
    const lista = await amb.http().get(`/api/transferencias?codigo=${r.codigo}`).set(bearer());
    expect(lista.status).toBe(200);
    expect(lista.body.itens).toEqual([
      expect.objectContaining({ id: r.id, qtdItens: 1, status: 'rascunho', estoqueDestinoId: estoqueLoja1 }),
    ]);
    const exc = await amb
      .http()
      .delete(`/api/transferencias/${r.id}?versao=${menos.body.versao}`)
      .set(bearer());
    expect(exc.status).toBe(204);
    expect((await obter(r.id)).status).toBe(404);
    // Sem itens, não se envia.
    const vazio = await rascunho([]);
    const e = await enviar(vazio.id);
    expect(e.status).toBe(422);
    expect(e.body.mensagem).toContain('ao menos um item');
  });

  it('confere a origem, o destino, a data, os produtos e a variação', async () => {
    const p = await produto('Linguiça toscana kg');
    const combo = await produto('Combo churrasco', {
      tipo: 'kit',
      componentes: [{ tipo: 'kit', componenteId: p, quantidade: '2' }],
    });
    const base = { estoqueOrigemId: cd, estoqueDestinoId: estoqueLoja2, motivo: 'Teste' };
    const futura = await criar({ ...base, data: '2099-01-01', itens: [] });
    expect(futura.status).toBe(422);
    expect(futura.body.campos.data[0]).toBe('A data não pode ser futura');
    const itens = await criar({
      ...base,
      itens: [
        { produtoId: combo, quantidade: '1' },
        { produtoId: p, variacaoId: uuidv7(), quantidade: '1' },
      ],
    });
    expect(itens.status, JSON.stringify(itens.body)).toBe(422);
    expect(itens.body.campos['itens.0.produtoId'][0]).toContain('Combo');
    expect(itens.body.campos['itens.1.variacaoId'][0]).toContain('Variações');
    const igual = await criar({ ...base, estoqueDestinoId: cd, itens: [] });
    expect(igual.status).toBe(422);
    expect(igual.body.campos.estoqueDestinoId).toBeDefined();
    const [{ id: inativo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo, ativo) values ('Depósito antigo', 'deposito', false) returning id",
    )) as [{ id: string }];
    const destinoInativo = await criar({ ...base, estoqueDestinoId: inativo, itens: [] });
    expect(destinoInativo.status).toBe(422);
    expect(destinoInativo.body.campos.estoqueDestinoId[0]).toBe('Estoque inativo');
    const origemInativa = await criar({ ...base, estoqueOrigemId: inativo, itens: [] });
    expect(origemInativa.status).toBe(422);
    expect(origemInativa.body.campos.estoqueOrigemId[0]).toBe('Estoque inativo');
  });

  it('vê quem tem a origem ou o destino; grava, envia e cancela só quem tem a origem (o destino não precisa)', async () => {
    const p = await produto('Pão de alho 400g');
    await entrada(cd, [{ produtoId: p, quantidade: '10', custoUnitario: '5' }]);
    // A expedição não tem a Loja 2 e cria para ela.
    const r = await rascunho([{ produtoId: p, quantidade: '2' }], {}, tokenExpedicao);
    // A Loja 2 vê (vai receber), sem o saldo da origem, que ela não enxerga, e sem o custo (Estoquista).
    const vista = await obter(r.id, tokenLoja2);
    expect(vista.status, JSON.stringify(vista.body)).toBe(200);
    expect(vista.body.itens[0]).toMatchObject({ saldoOrigem: null, custoUnitario: null });
    const listaLoja2 = await amb.http().get(`/api/transferencias?codigo=${r.codigo}`).set(bearer(tokenLoja2));
    expect(listaLoja2.body.total).toBe(1);
    // Mas não mexe no documento do CD.
    expect((await enviar(r.id, {}, tokenLoja2)).status).toBe(403);
    expect((await cancelar(r.id, 'Não quero', tokenLoja2)).status).toBe(403);
    expect((await amb.http().delete(`/api/transferencias/${r.id}`).set(bearer(tokenLoja2))).status).toBe(403);
    // Quem não tem nenhum dos dois não vê.
    expect((await obter(r.id, tokenSemEstoque)).status).toBe(404);
    expect(
      (await amb.http().get(`/api/transferencias?codigo=${r.codigo}`).set(bearer(tokenSemEstoque))).body
        .total,
    ).toBe(0);
    expect((await enviar(r.id, {}, tokenSemEstoque)).status).toBe(404);
    // Criar com a origem fora dos permitidos: 403 no campo.
    const fora = await criar(
      { estoqueOrigemId: estoqueLoja2, estoqueDestinoId: cd, motivo: 'Devolução', itens: [] },
      tokenExpedicao,
    );
    expect(fora.status).toBe(403);
    expect(fora.body.campos.estoqueOrigemId).toBeDefined();
    // A expedição envia (o destino continua fora dos permitidos dela).
    expect((await enviar(r.id, {}, tokenExpedicao)).status).toBe(200);
    expect((await cancelar(r.id, 'Fim do teste', tokenExpedicao)).status).toBe(200);
  });

  it('o seletor de destino lista todo estoque ativo, também fora dos permitidos de quem cria, sem saldo nem custo', async () => {
    const [{ id: inativo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo, ativo) values ('Depósito desativado', 'deposito', false) returning id",
    )) as [{ id: string }];
    // O `GET /estoques` da expedição só traz os permitidos dela (CD e Loja 1): a Loja 2 não estaria no seletor.
    const visiveis = await amb.http().get('/api/estoques?tamanho=50').set(bearer(tokenExpedicao));
    expect(visiveis.status).toBe(200);
    expect(visiveis.body.itens.map((e: { id: string }) => e.id)).not.toContain(estoqueLoja2);
    const d = await amb.http().get('/api/transferencias/destinos').set(bearer(tokenExpedicao));
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const porId = new Map((d.body as Array<{ id: string }>).map((e) => [e.id, e]));
    expect(porId.get(estoqueLoja2)).toEqual({
      id: estoqueLoja2,
      codigo: expect.any(Number),
      nome: expect.any(String),
      tipo: 'loja',
      lojaId: expect.any(String),
      lojaNome: 'Loja 2 - Bairro',
    });
    // O CD (sem loja), para a loja devolver os cascos; o inativo fica de fora.
    expect(porId.get(cd)).toMatchObject({ nome: 'CD - Estoque Ice Beer', tipo: 'deposito', lojaId: null });
    expect(porId.has(inativo)).toBe(false);
    // A Loja 2, que só tem o próprio estoque, também vê o CD como destino.
    const daLoja2 = await amb.http().get('/api/transferencias/destinos').set(bearer(tokenLoja2));
    expect((daLoja2.body as Array<{ id: string }>).map((e) => e.id)).toContain(cd);
    // Sem `transferencias.criar` (o Vendedor), 403.
    await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja1] });
    const tokenVendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
    expect((await amb.http().get('/api/transferencias/destinos').set(bearer(tokenVendedor))).status).toBe(
      403,
    );
  });

  it('anota a NF-e emitida por fora depois do envio; a cancelada não muda mais', async () => {
    const p = await produto('Vinho tinto seco 750ml');
    await entrada(cd, [{ produtoId: p, quantidade: '6', custoUnitario: '25' }]);
    const r = await rascunho([{ produtoId: p, quantidade: '6' }]);
    const e = await enviar(r.id);
    expect(e.status).toBe(200);
    const invalida = await amb
      .http()
      .put(`/api/transferencias/${r.id}/nfe-externa`)
      .set(bearer())
      .send({ nfeExternaChave: '1234' });
    expect(invalida.status).toBe(422);
    const ok = await amb
      .http()
      .put(`/api/transferencias/${r.id}/nfe-externa`)
      .set(bearer(tokenExpedicao))
      .send({ versao: e.body.versao, nfeExternaNumero: '1234/1' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      status: 'em_transito',
      nfeExternaNumero: '1234/1',
      nfeExternaChave: null,
    });
    expect(
      (await amb.http().put(`/api/transferencias/${r.id}/nfe-externa`).set(bearer(tokenLoja2)).send({}))
        .status,
    ).toBe(403);
    expect((await cancelar(r.id, 'Nota errada')).status).toBe(200);
    const depois = await amb
      .http()
      .put(`/api/transferencias/${r.id}/nfe-externa`)
      .set(bearer())
      .send({ nfeExternaNumero: '999/1' });
    expect(depois.status).toBe(422);
  });

  it('o estoque e o tipo de estoque com transferência pendente não se inativam nem se excluem', async () => {
    const p = await produto('Cerveja de trigo 600ml');
    const novoDeposito = async (nome: string) =>
      (
        await consultar<{ id: string }>(
          emp.nomeBanco,
          "insert into estoques (nome, tipo) values ($1, 'deposito') returning id",
          [nome],
        )
      )[0]!.id;
    const destino = await novoDeposito('Depósito do evento');
    const origem = await novoDeposito('Depósito de apoio');
    const [{ id: tipo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into tipos_estoque (nome, vendavel) values ('Reserva do evento', false) returning id",
    )) as [{ id: string }];
    const inativarEstoque = async (id: string, ativo = false) => {
      const e = (await amb.http().get(`/api/estoques/${id}`).set(bearer())).body;
      return amb
        .http()
        .put(`/api/estoques/${id}`)
        .set(bearer())
        .send({ nome: e.nome, tipo: e.tipo, endereco: e.endereco, ativo, versao: e.versao });
    };
    const inativarTipo = async () => {
      const t = (await amb.http().get(`/api/tipos-estoque/${tipo}`).set(bearer())).body;
      return amb
        .http()
        .put(`/api/tipos-estoque/${tipo}`)
        .set(bearer())
        .send({ nome: t.nome, vendavel: t.vendavel, padrao: t.padrao, ativo: false, versao: t.versao });
    };
    // Rascunho de origem → destino no tipo novo, ainda sem saldo em lugar nenhum: o tipo não se inativa (o envio ainda
    // vai lançar nele); o destino sim (o rascunho não trava o estoque), e o envio o recusa.
    const r = await rascunho([{ produtoId: p, quantidade: '10' }], {
      estoqueOrigemId: origem,
      estoqueDestinoId: destino,
      tipoEstoqueId: tipo,
    });
    const t1 = await inativarTipo();
    expect(t1.status, JSON.stringify(t1.body)).toBe(422);
    expect(t1.body.campos.ativo[0]).toBe('Há 1 transferência(s) pendente(s) neste tipo');
    // Nem se exclui: o tipo ainda não tem movimento, acerto nem recebimento, só o rascunho (a trava da transferência,
    // e não a dos movimentos, é que recusa).
    const excRascunho = await amb.http().delete(`/api/tipos-estoque/${tipo}`).set(bearer());
    expect(excRascunho.status, JSON.stringify(excRascunho.body)).toBe(422);
    expect(excRascunho.body.mensagem).toContain('usado em transferências');
    expect((await inativarEstoque(destino)).status).toBe(200);
    const recusa = await enviar(r.id);
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(422);
    expect(recusa.body.campos.estoqueDestinoId[0]).toContain('inativo');
    expect((await inativarEstoque(destino, true)).status).toBe(200);
    // Enviada: a origem fica com saldo zero no tipo e o destino nunca teve movimento — o "saldo zero" não vê a
    // mercadoria na estrada, e a trava nova a vê.
    await entrada(origem, [{ produtoId: p, quantidade: '10', custoUnitario: '5' }], { tipoEstoqueId: tipo });
    expect((await enviar(r.id)).status).toBe(200);
    expect((await saldo(origem, p, tipo)).quantidade).toBe('0.000');
    for (const id of [origem, destino]) {
      const i = await inativarEstoque(id);
      expect(i.status, JSON.stringify(i.body)).toBe(422);
      expect(i.body.campos.ativo[0]).toBe('Há 1 transferência(s) pendente(s) com este estoque');
    }
    expect((await inativarTipo()).status).toBe(422);
    // Excluir: o destino sem movimento nenhum, mas usado na transferência (o tipo, agora com movimentos, cai na trava
    // antiga, dos movimentos; a da transferência ficou conferida no rascunho acima).
    const exc = await amb.http().delete(`/api/estoques/${destino}`).set(bearer());
    expect(exc.status).toBe(422);
    expect(exc.body.mensagem).toContain('transferências');
    const excTipo = await amb.http().delete(`/api/tipos-estoque/${tipo}`).set(bearer());
    expect(excTipo.status).toBe(422);
    expect(excTipo.body.mensagem).toContain('movimentos ou acertos');
    // Cancelada, o destino volta a se inativar (a origem tem o saldo de volta, e o tipo também).
    expect((await cancelar(r.id, 'Evento adiado')).status).toBe(200);
    expect((await inativarEstoque(destino)).status).toBe(200);
    expect((await saldo(origem, p, tipo)).quantidade).toBe('10.000');
  });
});

describe('concorrência com o PDV e o razão (F2-B23)', () => {
  // O envio e o push do PDV pegam a trava 7300001 (`travaVersao`) como primeira instrução da transação e por isso rodam
  // **em série**: as linhas de saldo nunca são disputadas pelos dois ao mesmo tempo, e a ordem das travas de linha
  // (`ordenarChaves`) não é o que este teste confere (o deadlock eventual ainda seria repetido pela `transacao`). Ele
  // confere que os dois, disparados juntos, terminam com 200, o saldo certo na origem e o saldo novo no pull do PDV. Os
  // itens do rascunho vão fora da ordem crescente (y antes de x, uuidv7) e a venda na ordem inversa, para o caso de a
  // 7300001 deixar de serializar os dois.
  it('envio da Loja 1 junto da venda do PDV na Loja 1, 20 vezes: os dois terminam, e o saldo novo desce ao PDV', async () => {
    const x = await produto('Cerveja lata X');
    const y = await produto('Cerveja lata Y');
    await entrada(estoqueLoja1, [
      { produtoId: x, quantidade: '60', custoUnitario: '3' },
      { produtoId: y, quantidade: '60', custoUnitario: '3' },
    ]);
    const p = await novoPonto();
    const inicio = await puxar(p, 'estoque', 0);
    for (let i = 0; i < 20; i++) {
      const r = await rascunho(
        [
          { produtoId: y, quantidade: '1' },
          { produtoId: x, quantidade: '1' },
        ],
        { estoqueOrigemId: estoqueLoja1, estoqueDestinoId: cd },
        tokenExpedicao,
      );
      const [enviada] = await Promise.all([
        enviar(r.id, { versao: r.versao }, tokenExpedicao),
        aplicar(
          p,
          'venda.finalizada',
          venda(p, [
            [x, '1.000'],
            [y, '1.000'],
          ]),
        ),
      ]);
      expect(enviada.status, JSON.stringify(enviada.body)).toBe(200);
    }
    expect([(await saldo(estoqueLoja1, x)).quantidade, (await saldo(estoqueLoja1, y)).quantidade]).toEqual([
      '20.000',
      '20.000',
    ]);
    // A saída da Loja 1 leva a loja no movimento.
    const [m] = await consultar<{ loja_id: string | null }>(
      emp.nomeBanco,
      `select loja_id from movimentos_estoque where tipo_movimento = 'TRANSF_SAIDA' and estoque_id = $1 limit 1`,
      [estoqueLoja1],
    );
    expect(m!.loja_id).toBe(loja1);
    const estoque = await puxar(p, 'estoque', inicio.cursor);
    const noPdv = (produtoId: string) =>
      estoque.alteracoes
        .filter((a) => a.tabela === 'saldos_estoque' && a.linha.produto_id === produtoId)
        .at(-1);
    expect(Number(noPdv(x)!.linha.quantidade)).toBe(20);
    expect(Number(noPdv(y)!.linha.quantidade)).toBe(20);
  }, 180_000);

  it('o razão refaz as projeções idênticas (db:recalcular-saldos)', async () => {
    const { movimentos: n } = await conferirRazaoDoBanco(emp.nomeBanco);
    expect(n).toBeGreaterThan(0);
  });
});
