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
 * série pela trava 7300001), com o saldo novo descendo ao PDV.
 *
 * Receber, tratar a divergência e o modo de uma etapa (F2-B24; ERP 13.7; F2-Q10 = D51 e D61; README da API › decisão
 * 172): o critério de pronto — CD → Loja 2 com 10 enviados e 8 recebidos, tratado como retorno e como perda (saldos,
 * movimentos e custo médio nos dois estoques, o acerto da perda que não se estorna e o saldo novo no PDV da Loja 2);
 * a conferência de todos os itens e as recusas; a versão velha (409) no receber e no tratar e o tratamento parcial (o
 * item já tratado recusado); a perda da sobra sem lote da divisão FEFO com um lote novo e uma compra no CD antes do
 * tratamento (o saldo de cada lote e o custo médio do CD não mudam); a divisão FEFO repartida em ordem e o retorno
 * parcial que impede o cancelamento (um estorno por movimento); o casco vazio da loja para o CD; o lote preso à origem
 * no recebimento em duas etapas (o sem estoque do mesmo código, o inativo, o excluído ao lado do vivo e a outra
 * fabricação); o modo de uma etapa (a chave da empresa) com o lote preso à origem e os saldos nos PDVs das duas lojas. No fim o razão refaz as projeções idênticas (`conferirRazaoDoBanco`, o
 * núcleo do `db:recalcular-saldos`).
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
let loja2: string;
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
const receber = (id: string, corpo: Record<string, unknown>, token = tokenAdmin) =>
  amb.http().post(`/api/transferencias/${id}/receber`).set(bearer(token)).send(corpo);
const tratar = (
  id: string,
  itens: Array<{ itemId: string; tratamento: 'retorno_origem' | 'perda' }>,
  token = tokenAdmin,
  extra: Record<string, unknown> = {},
) =>
  amb
    .http()
    .post(`/api/transferencias/${id}/tratar-divergencia`)
    .set(bearer(token))
    .send({ itens, ...extra });
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

/** Caixas criados por loja (o número do caixa é único na loja). */
const caixasPorLoja = new Map<string, number>();

/** Um PDV ativado na loja, só para o pull (sem sessão de caixa). */
async function terminalDaLoja(loja: string): Promise<{ token: string; terminal: string }> {
  // O caixa 1 da Loja 1 é o do `novoPonto`.
  const numero = (caixasPorLoja.get(loja) ?? (loja === loja1 ? 1 : 0)) + 1;
  caixasPorLoja.set(loja, numero);
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: loja, caixaId: caixa, descricao: 'PC da loja', validadeHoras: 24 });
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
  return { token: r.body.token, terminal: r.body.terminal_id };
}

async function puxar(p: { token: string }, fluxo: 'catalogo' | 'estoque', desde: number) {
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
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
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

    // A recebida não se cancela.
    const s = await rascunho([{ produtoId: p, quantidade: '3' }]);
    expect((await enviar(s.id)).status).toBe(200);
    expect((await receber(s.id, { receberTudo: true })).status).toBe(200);
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

describe('receber, tratar a divergência e o modo de uma etapa (F2-B24; ERP 13.7; F2-Q10)', () => {
  type Alteracao = { tabela: string; linha: Record<string, unknown> };
  const ultimoSaldoNoPdv = (alteracoes: Alteracao[], produtoId: string) =>
    Number(
      alteracoes.filter((a) => a.tabela === 'saldos_estoque' && a.linha.produto_id === produtoId).at(-1)
        ?.linha.quantidade,
    );

  it('CD → Loja 2 com 10 enviados e 8 recebidos, tratado como retorno e como perda; o PDV da Loja 2 recebe o saldo (critério de pronto)', async () => {
    const p = await produto('Cerveja puro malte lata 473ml');
    await entrada(cd, [{ produtoId: p, quantidade: '30', custoUnitario: '5' }]);
    await entrada(estoqueLoja2, [{ produtoId: p, quantidade: '4', custoUnitario: '6' }]);
    const pdvLoja2 = await terminalDaLoja(loja2);
    const inicio = await puxar(pdvLoja2, 'estoque', 0);

    // Retornar à origem.
    const a = await rascunho([{ produtoId: p, quantidade: '10' }], {}, tokenExpedicao);
    const ea = await enviar(a.id, {}, tokenExpedicao);
    expect(ea.status, JSON.stringify(ea.body)).toBe(200);
    // Quem só tem a origem não recebe pela loja; quem não vê nenhum dos dois não acha a transferência.
    expect((await receber(a.id, { receberTudo: true }, tokenExpedicao)).status).toBe(403);
    expect((await receber(a.id, { receberTudo: true }, tokenSemEstoque)).status).toBe(404);
    const ra = await receber(
      a.id,
      { versao: ea.body.versao, itens: [{ itemId: a.itens[0]!.id, quantidadeRecebida: '8' }] },
      tokenLoja2,
    );
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    expect(ra.body).toMatchObject({
      status: 'recebida_divergencia',
      recebidaPorNome: 'LOJA2',
      recebidaEm: expect.any(String),
    });
    expect(ra.body.itens[0]).toMatchObject({
      quantidadeEnviada: '10.000',
      quantidadeRecebida: '8.000',
      diferenca: '2.000',
      tratamentoDivergencia: null,
    });
    // O CD fica com 20 a R$ 5,00; a Loja 2 recebe ao custo da saída: (4 × 6 + 8 × 5) / 12 = R$ 5,3333.
    expect(await saldo(cd, p)).toEqual({ quantidade: '20.000', custo_medio: '5.0000' });
    expect(await saldo(estoqueLoja2, p)).toEqual({ quantidade: '12.000', custo_medio: '5.3333' });
    const [saidaA, entradaA] = await movimentos(a.id);
    expect(entradaA).toMatchObject({
      tipo_movimento: 'TRANSF_ENTRADA',
      estoque_id: estoqueLoja2,
      quantidade: '8.000',
      custo_unitario: '5.0000',
      custo_total: '40.00',
      lote_id: null,
      estorno_de_id: null,
      documento_item_id: a.itens[0]!.id,
      loja_id: loja2,
    });
    // Recebida (com divergência) não se cancela; receber de novo não lança outra entrada.
    expect((await cancelar(a.id, 'Tarde demais', tokenExpedicao)).status).toBe(422);
    const outra = await receber(a.id, { receberTudo: true }, tokenLoja2);
    expect(outra.status).toBe(200);
    expect(outra.body.itens[0].quantidadeRecebida).toBe('8.000');
    expect(await movimentos(a.id)).toHaveLength(2);

    const ta = await tratar(a.id, [{ itemId: a.itens[0]!.id, tratamento: 'retorno_origem' }], tokenLoja2, {
      versao: ra.body.versao,
    });
    expect(ta.status, JSON.stringify(ta.body)).toBe(200);
    expect(ta.body.status).toBe('recebida');
    expect(ta.body.itens[0]).toMatchObject({
      tratamentoDivergencia: 'retorno_origem',
      divergenciaTratadaEm: expect.any(String),
    });
    // A diferença volta ao CD ao custo da saída (T20), como estorno da saída; a Loja 2 fica com o que recebeu.
    expect(await saldo(cd, p)).toEqual({ quantidade: '22.000', custo_medio: '5.0000' });
    expect((await saldo(estoqueLoja2, p)).quantidade).toBe('12.000');
    expect((await movimentos(a.id)).at(-1)).toMatchObject({
      tipo_movimento: 'TRANSF_RETORNO',
      estoque_id: cd,
      quantidade: '2.000',
      custo_unitario: '5.0000',
      estorno_de_id: saidaA!.id,
      loja_id: null,
    });
    // Já `recebida`: não há o que tratar (a recusa do item já tratado, com outra diferença pendente, é conferida no
    // teste do tratamento parcial).
    const deNovo = await tratar(a.id, [{ itemId: a.itens[0]!.id, tratamento: 'perda' }], tokenLoja2);
    expect(deNovo.status).toBe(422);
    expect(deNovo.body.mensagem).toContain('não tem diferença a tratar');

    // Baixar como perda (F2-Q10 = D51): o retorno da diferença mais o acerto de Saída no CD.
    const b = await rascunho([{ produtoId: p, quantidade: '10' }], {}, tokenExpedicao);
    expect((await enviar(b.id, {}, tokenExpedicao)).status).toBe(200);
    const rb = await receber(
      b.id,
      { itens: [{ itemId: b.itens[0]!.id, quantidadeRecebida: '8' }] },
      tokenLoja2,
    );
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect((await saldo(cd, p)).quantidade).toBe('12.000');
    // Quem tem a origem também trata a diferença (o expedidor do CD).
    const tb = await tratar(b.id, [{ itemId: b.itens[0]!.id, tratamento: 'perda' }], tokenExpedicao);
    expect(tb.status, JSON.stringify(tb.body)).toBe(200);
    expect(tb.body.status).toBe('recebida');
    expect(tb.body.itens[0].tratamentoDivergencia).toBe('perda');
    // O saldo do CD não muda (o retorno e a perda se anulam) e a perda fica registrada a custo.
    expect(await saldo(cd, p)).toEqual({ quantidade: '12.000', custo_medio: '5.0000' });
    expect(await saldo(estoqueLoja2, p)).toEqual({ quantidade: '20.000', custo_medio: '5.2000' });
    expect((await movimentos(b.id)).map((m) => [m.tipo_movimento, m.estoque_id, m.quantidade])).toEqual([
      ['TRANSF_SAIDA', cd, '-10.000'],
      ['TRANSF_ENTRADA', estoqueLoja2, '8.000'],
      ['TRANSF_RETORNO', cd, '2.000'],
    ]);
    const [perda] = await consultar<{
      id: string;
      codigo: number;
      tipo_ajuste: string;
      status: string;
      motivo: string;
      estoque_id: string;
      total_custo: string;
    }>(
      emp.nomeBanco,
      `select id, codigo, tipo_ajuste, status, motivo, estoque_id, total_custo::text from acertos_estoque
        where origem = 'perda_transferencia' and origem_id = $1`,
      [b.id],
    );
    expect(perda).toMatchObject({
      tipo_ajuste: 'saida',
      status: 'efetivado',
      motivo: 'Perda em transferência',
      estoque_id: cd,
      total_custo: '10.00',
    });
    expect(
      await consultar(
        emp.nomeBanco,
        `select tipo_movimento, quantidade::text, custo_unitario::text, custo_total::text from movimentos_estoque
          where documento_tipo = 'acerto' and documento_id = $1`,
        [perda!.id],
      ),
    ).toEqual([
      {
        tipo_movimento: 'ACERTO_SAIDA',
        quantidade: '-2.000',
        custo_unitario: '5.0000',
        custo_total: '10.00',
      },
    ]);
    // O acerto da perda faz parte da transferência: não se estorna pela tela de acertos.
    const ac = (await amb.http().get(`/api/acertos/${perda!.id}`).set(bearer())).body;
    expect(ac.origem).toBe('perda_transferencia');
    const est = await amb
      .http()
      .post(`/api/acertos/${perda!.id}/estornar`)
      .set(bearer())
      .send({ versao: ac.versao, motivo: 'Teste' });
    expect(est.status, JSON.stringify(est.body)).toBe(422);
    expect(est.body.mensagem).toContain('perda de uma transferência');
    const auditoria = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'transferencias_estoque' and registro_id = $1 and acao = 'movimentar'
        order by criado_em`,
      [b.id],
    );
    expect(auditoria.map((x) => x.descricao)).toEqual([
      `Transferência Nº ${b.codigo} enviada: 1 item(ns), 1 movimento(s)`,
      `Transferência Nº ${b.codigo} recebida com divergência: 1 item(ns), 1 movimento(s), 1 item(ns) recebido(s) a menor`,
      `Diferença da transferência Nº ${b.codigo} tratada: 1 item(ns) baixado(s) como perda (acerto Nº ${perda!.codigo}), 1 retorno(s); diferenças tratadas`,
    ]);

    // O fluxo `estoque` desce o saldo novo ao PDV da Loja 2 (o CD não tem PDV).
    const desceu = await puxar(pdvLoja2, 'estoque', inicio.cursor);
    expect(ultimoSaldoNoPdv(desceu.alteracoes, p)).toBe(20);
  });

  it('recebe todos os itens conferidos, recusa a recebida acima da enviada, o item de fora e o rascunho', async () => {
    const p = await produto('Refrigerante cola 2L');
    const q = await produto('Refrigerante guaraná 2L');
    await entrada(cd, [
      { produtoId: p, quantidade: '20', custoUnitario: '6' },
      { produtoId: q, quantidade: '20', custoUnitario: '5' },
    ]);
    const r = await rascunho([
      { produtoId: p, quantidade: '5' },
      { produtoId: q, quantidade: '3' },
    ]);
    const cedo = await receber(r.id, { receberTudo: true }, tokenLoja2);
    expect(cedo.status).toBe(422);
    expect(cedo.body.mensagem).toContain('ainda não foi enviada');
    expect((await enviar(r.id)).status).toBe(200);
    const [ip, iq] = [r.itens[0]!, r.itens[1]!];
    const falta = await receber(r.id, { itens: [{ itemId: ip.id, quantidadeRecebida: '5' }] }, tokenLoja2);
    expect(falta.status).toBe(422);
    expect(falta.body.mensagem).toContain('Falta(m): Refrigerante guaraná 2L');
    const acima = await receber(
      r.id,
      {
        itens: [
          { itemId: ip.id, quantidadeRecebida: '5.001' },
          { itemId: iq.id, quantidadeRecebida: '3' },
        ],
      },
      tokenLoja2,
    );
    expect(acima.status).toBe(422);
    expect(acima.body.campos['itens.0.quantidadeRecebida'][0]).toContain('Acima da enviada (5 UN)');
    const deFora = await receber(
      r.id,
      { itens: [{ itemId: uuidv7(), quantidadeRecebida: '1' }] },
      tokenLoja2,
    );
    expect(deFora.status).toBe(422);
    expect(deFora.body.campos['itens.0.itemId'][0]).toBe('O item não é desta transferência');
    expect(await movimentos(r.id)).toHaveLength(2);
    expect((await obter(r.id)).body.status).toBe('em_transito');

    // Nada chegou de um item e o outro veio inteiro: só o que chegou entra, e só o item a menor tem o que tratar.
    const ok = await receber(
      r.id,
      {
        itens: [
          { itemId: iq.id, quantidadeRecebida: '3' },
          { itemId: ip.id, quantidadeRecebida: '0' },
        ],
      },
      tokenLoja2,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('recebida_divergencia');
    expect((await movimentos(r.id)).filter((m) => m.tipo_movimento === 'TRANSF_ENTRADA')).toEqual([
      expect.objectContaining({ documento_item_id: iq.id, quantidade: '3.000', custo_unitario: '5.0000' }),
    ]);
    const semDiferenca = await tratar(r.id, [{ itemId: iq.id, tratamento: 'retorno_origem' }], tokenLoja2);
    expect(semDiferenca.status).toBe(422);
    expect(semDiferenca.body.campos['itens.0.itemId'][0]).toContain('recebido como enviado');
    // Quem não tem nem a origem nem o destino não trata (aqui o 404: nem vê a transferência).
    expect(
      (await tratar(r.id, [{ itemId: ip.id, tratamento: 'retorno_origem' }], tokenSemEstoque)).status,
    ).toBe(404);
    expect((await tratar(r.id, [{ itemId: ip.id, tratamento: 'retorno_origem' }], tokenLoja2)).status).toBe(
      200,
    );
    expect(await saldo(cd, p)).toEqual({ quantidade: '20.000', custo_medio: '6.0000' });
    expect((await saldo(estoqueLoja2, p)).quantidade).toBe('0.000');

    // "Receber tudo como enviado".
    const s = await rascunho([{ produtoId: q, quantidade: '2' }]);
    expect((await enviar(s.id)).status).toBe(200);
    const tudo = await receber(s.id, { receberTudo: true }, tokenLoja2);
    expect(tudo.status, JSON.stringify(tudo.body)).toBe(200);
    expect(tudo.body).toMatchObject({ status: 'recebida' });
    expect(tudo.body.itens[0]).toMatchObject({ quantidadeRecebida: '2.000', diferenca: '0.000' });
    expect((await saldo(estoqueLoja2, q)).quantidade).toBe('5.000');
    const semNada = await tratar(s.id, [{ itemId: tudo.body.itens[0].id, tratamento: 'perda' }], tokenLoja2);
    expect(semNada.status).toBe(422);
  });

  it('FEFO: a recebida enche as partes da saída em ordem; o retorno parcial impede o cancelamento (um estorno por movimento)', async () => {
    const p = await produto('Iogurte natural 170g');
    const a = await lote(p, 'IN-A', '2026-12-10', null);
    const b = await lote(p, 'IN-B', '2027-02-10', null);
    await entrada(cd, [
      { produtoId: p, loteId: a, quantidade: '6', custoUnitario: '2' },
      { produtoId: p, loteId: b, quantidade: '6', custoUnitario: '2' },
    ]);
    const r = await rascunho([{ produtoId: p, quantidade: '10' }]);
    expect((await enviar(r.id)).status).toBe(200);
    const saidas = await movimentos(r.id);
    expect(saidas.map((m) => [m.lote_id, m.quantidade])).toEqual([
      [a, '-6.000'],
      [b, '-4.000'],
    ]);
    // 7 chegaram: o lote que vence primeiro chega inteiro e o que faltou fica no último.
    expect(
      (await receber(r.id, { itens: [{ itemId: r.itens[0]!.id, quantidadeRecebida: '7' }] }, tokenLoja2))
        .status,
    ).toBe(200);
    expect(await saldosLote(estoqueLoja2, p)).toEqual({ [a]: '6.000', [b]: '1.000' });
    expect((await tratar(r.id, [{ itemId: r.itens[0]!.id, tratamento: 'retorno_origem' }])).status).toBe(200);
    expect(await saldosLote(cd, p)).toEqual({ [a]: '0.000', [b]: '5.000' });
    const retorno = (await movimentos(r.id)).filter((m) => m.tipo_movimento === 'TRANSF_RETORNO');
    expect(retorno).toEqual([
      expect.objectContaining({ lote_id: b, quantidade: '3.000', estorno_de_id: saidas[1]!.id }),
    ]);
    // A parte devolvida em parte já tem o seu estorno: o cancelamento é recusado, e o banco recusa um segundo
    // estorno da mesma saída (`uq_movimentos_estoque_estorno`).
    const c = await cancelar(r.id, 'Quero desfazer');
    expect(c.status).toBe(422);
    expect(c.body.mensagem).toContain('transferência no sentido inverso');
    await expect(
      consultar(
        emp.nomeBanco,
        `insert into movimentos_estoque
         select * from jsonb_populate_record(null::movimentos_estoque,
           (select to_jsonb(m) || jsonb_build_object('id', fn_uuid_v7(), 'seq_lancamento', nextval('seq_movimentos_estoque'),
                                                     'documento_item_id', null)
              from movimentos_estoque m where m.id = $1))`,
        [retorno[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_movimentos_estoque_estorno' });
  });

  it('a versão velha é 409 no receber e no tratar; o tratamento parcial deixa a divergência, e o item já tratado é recusado', async () => {
    const p = await produto('Suco de uva integral 1L');
    const q = await produto('Suco de laranja integral 1L');
    await entrada(cd, [
      { produtoId: p, quantidade: '10', custoUnitario: '7' },
      { produtoId: q, quantidade: '10', custoUnitario: '6' },
    ]);
    const r = await rascunho([
      { produtoId: p, quantidade: '5' },
      { produtoId: q, quantidade: '5' },
    ]);
    const e = await enviar(r.id, { versao: r.versao });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    const [ip, iq] = [r.itens[0]!, r.itens[1]!];
    const conferencia = {
      itens: [
        { itemId: ip.id, quantidadeRecebida: '4' },
        { itemId: iq.id, quantidadeRecebida: '3' },
      ],
    };
    // A versão de antes do envio: 409, nada recebido.
    const velhaReceber = await receber(r.id, { versao: r.versao, ...conferencia }, tokenLoja2);
    expect(velhaReceber.status, JSON.stringify(velhaReceber.body)).toBe(409);
    expect(await movimentos(r.id)).toHaveLength(2);
    expect((await obter(r.id)).body).toMatchObject({
      status: 'em_transito',
      itens: [{ quantidadeRecebida: null }, { quantidadeRecebida: null }],
    });
    const rec = await receber(r.id, { versao: e.body.versao, ...conferencia }, tokenLoja2);
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body.status).toBe('recebida_divergencia');
    // A versão de antes do recebimento: 409, nada tratado.
    const velhaTratar = await tratar(r.id, [{ itemId: ip.id, tratamento: 'retorno_origem' }], tokenLoja2, {
      versao: e.body.versao,
    });
    expect(velhaTratar.status, JSON.stringify(velhaTratar.body)).toBe(409);
    expect(await movimentos(r.id)).toHaveLength(4);
    expect(
      (await obter(r.id)).body.itens.map(
        (i: { tratamentoDivergencia: string | null }) => i.tratamentoDivergencia,
      ),
    ).toEqual([null, null]);

    // Um item tratado: a outra diferença continua pendente, e a transferência fica em `recebida_divergencia`.
    const um = await tratar(r.id, [{ itemId: ip.id, tratamento: 'retorno_origem' }], tokenLoja2, {
      versao: rec.body.versao,
    });
    expect(um.status, JSON.stringify(um.body)).toBe(200);
    expect(um.body.status).toBe('recebida_divergencia');
    expect(
      um.body.itens.map((i: { tratamentoDivergencia: string | null }) => i.tratamentoDivergencia),
    ).toEqual(['retorno_origem', null]);
    expect(await saldo(cd, p)).toEqual({ quantidade: '6.000', custo_medio: '7.0000' });
    // O mesmo item de novo: "já foi tratada", sem lançar nada.
    const repetido = await tratar(r.id, [{ itemId: ip.id, tratamento: 'perda' }], tokenLoja2);
    expect(repetido.status, JSON.stringify(repetido.body)).toBe(422);
    expect(repetido.body.campos['itens.0.itemId'][0]).toBe(
      'A diferença de Suco de uva integral 1L já foi tratada (retornada à origem)',
    );
    expect(await movimentos(r.id)).toHaveLength(5);
    // O outro item conclui.
    const outro = await tratar(r.id, [{ itemId: iq.id, tratamento: 'perda' }], tokenLoja2);
    expect(outro.status, JSON.stringify(outro.body)).toBe(200);
    expect(outro.body.status).toBe('recebida');
    expect(await saldo(cd, q)).toEqual({ quantidade: '5.000', custo_medio: '6.0000' });
    const auditoria = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'transferencias_estoque' and registro_id = $1 and acao = 'movimentar'
        and descricao like 'Diferença%' order by criado_em`,
      [r.id],
    );
    expect(auditoria.map((x) => x.descricao)).toEqual([
      `Diferença da transferência Nº ${r.codigo} tratada: 1 item(ns) retornado(s) à origem, 1 retorno(s); ainda há diferença a tratar`,
      expect.stringMatching(
        /1 item\(ns\) baixado\(s\) como perda \(acerto Nº \d+\), 1 retorno\(s\); diferenças tratadas$/,
      ),
    ]);
  });

  it('perda da sobra sem lote da divisão FEFO, com um lote novo e uma compra a outro custo no CD antes do tratamento: o saldo de cada lote e o custo médio do CD não mudam', async () => {
    const p = await produto('Leite fermentado 80g');
    const a = await lote(p, 'LF-A', '2026-12-05', null);
    await entrada(cd, [
      { produtoId: p, loteId: a, quantidade: '6', custoUnitario: '5' },
      { produtoId: p, quantidade: '10', custoUnitario: '5' },
    ]);
    const r = await rascunho([{ produtoId: p, quantidade: '10' }]);
    expect((await enviar(r.id)).status).toBe(200);
    const saidas = await movimentos(r.id);
    // A FEFO: o lote A inteiro e a sobra sem lote.
    expect(saidas.map((m) => [m.lote_id, m.quantidade])).toEqual([
      [a, '-6.000'],
      [null, '-4.000'],
    ]);
    // 8 chegaram: a diferença de 2 fica na parte sem lote (a última).
    expect(
      (await receber(r.id, { itens: [{ itemId: r.itens[0]!.id, quantidadeRecebida: '8' }] }, tokenLoja2))
        .status,
    ).toBe(200);
    // Antes do tratamento entra no CD o lote B, a R$ 6,00: (6 × 5 + 24 × 6) / 30 = R$ 5,80.
    const b = await lote(p, 'LF-B', '2027-01-05', null);
    await entrada(cd, [{ produtoId: p, loteId: b, quantidade: '24', custoUnitario: '6' }]);
    expect(await saldo(cd, p)).toEqual({ quantidade: '30.000', custo_medio: '5.8000' });
    const lotesAntes = await saldosLote(cd, p);
    expect(lotesAntes).toEqual({ [a]: '0.000', [b]: '24.000' });

    const t = await tratar(r.id, [{ itemId: r.itens[0]!.id, tratamento: 'perda' }]);
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    // O retorno entra na parte sem lote, a perda sai dela (não do lote B), e o custo médio volta ao de antes: o retorno
    // a R$ 5,00 leva o CD a 32 a R$ 5,75, e a perda, ao custo do retorno, a 30 a R$ 5,80.
    expect(await saldo(cd, p)).toEqual({ quantidade: '30.000', custo_medio: '5.8000' });
    expect(await saldosLote(cd, p)).toEqual(lotesAntes);
    const retorno = (await movimentos(r.id)).filter((m) => m.tipo_movimento === 'TRANSF_RETORNO');
    expect(retorno).toEqual([
      expect.objectContaining({ lote_id: null, quantidade: '2.000', estorno_de_id: saidas[1]!.id }),
    ]);
    const [perda] = await consultar<{ id: string; total_custo: string }>(
      emp.nomeBanco,
      `select id, total_custo::text from acertos_estoque where origem = 'perda_transferencia' and origem_id = $1`,
      [r.id],
    );
    // A perda fica ao custo do envio (o valor que saiu em trânsito), estornando o retorno.
    expect(perda!.total_custo).toBe('10.00');
    expect(
      await consultar(
        emp.nomeBanco,
        `select tipo_movimento, lote_id, quantidade::text, custo_unitario::text, custo_total::text, estorno_de_id,
                custo_medio_posterior::text
           from movimentos_estoque where documento_tipo = 'acerto' and documento_id = $1`,
        [perda!.id],
      ),
    ).toEqual([
      {
        tipo_movimento: 'ACERTO_SAIDA',
        lote_id: null,
        quantidade: '-2.000',
        custo_unitario: '5.0000',
        custo_total: '10.00',
        estorno_de_id: retorno[0]!.id,
        custo_medio_posterior: '5.8000',
      },
    ]);
    const [item] = await consultar<{ custo_unitario: string; total_custo: string; diferenca: string }>(
      emp.nomeBanco,
      `select custo_unitario::text, total_custo::text, diferenca::text from itens_acerto_estoque where acerto_id = $1`,
      [perda!.id],
    );
    expect(item).toEqual({ custo_unitario: '5.0000', total_custo: '10.00', diferenca: '-2.000' });
  });

  it('lote preso à origem no recebimento em duas etapas: o sem estoque do mesmo código, o inativo completado, o vivo ao lado do excluído; outra fabricação recusa e a transferência continua em trânsito', async () => {
    const p = await produto('Queijo minas frescal 500g');
    const novoLote = async (
      codigo: string,
      estoque: string | null,
      extra: {
        validade?: string | null;
        fabricacao?: string | null;
        ativo?: boolean;
        excluido?: boolean;
      } = {},
    ) => {
      const [{ id }] = (await consultar<{ id: string }>(
        emp.nomeBanco,
        `insert into produtos_lotes (produto_id, estoque_id, lote, validade, fabricacao, ativo, excluido_em)
         values ($1, $2, $3, $4, $5, $6, case when $7 then now() end) returning id`,
        [
          p,
          estoque,
          codigo,
          extra.validade ?? null,
          extra.fabricacao ?? null,
          extra.ativo ?? true,
          extra.excluido ?? false,
        ],
      )) as [{ id: string }];
      return id;
    };
    // QM-01: o do destino é o sem estoque do mesmo código.
    const presoA = await novoLote('QM-01', estoqueLoja1, { validade: '2026-12-01' });
    const soltoA = await novoLote('QM-01', null, { validade: '2026-12-01' });
    // QM-02: o do destino está inativo e sem validade nem fabricação.
    const presoB = await novoLote('QM-02', estoqueLoja1, {
      validade: '2027-01-01',
      fabricacao: '2026-10-01',
    });
    const inativoB = await novoLote('QM-02', estoqueLoja2, { ativo: false });
    // QM-03: no destino, um excluído (com outra validade) e o vivo recadastrado com o mesmo código.
    const presoC = await novoLote('QM-03', estoqueLoja1, { validade: '2027-02-01' });
    const excluidoC = await novoLote('QM-03', estoqueLoja2, { validade: '2027-03-01', excluido: true });
    const vivoC = await novoLote('QM-03', estoqueLoja2, { validade: '2027-02-01' });
    // QM-04: no destino, com outra fabricação.
    const presoD = await novoLote('QM-04', estoqueLoja1, {
      validade: '2027-04-01',
      fabricacao: '2026-10-01',
    });
    await novoLote('QM-04', estoqueLoja2, { validade: '2027-04-01', fabricacao: '2026-10-02' });
    await entrada(
      estoqueLoja1,
      [presoA, presoB, presoC, presoD].map((loteId) => ({
        produtoId: p,
        loteId,
        quantidade: '2',
        custoUnitario: '9',
      })),
    );
    const lotesNoDestino = () =>
      consultar<{
        id: string;
        ativo: boolean;
        excluido: boolean;
        validade: string | null;
        fabricacao: string | null;
      }>(
        emp.nomeBanco,
        `select id, ativo, excluido_em is not null as excluido, validade::text, fabricacao::text from produtos_lotes
          where produto_id = $1 and estoque_id = $2 order by id`,
        [p, estoqueLoja2],
      );
    const antes = await lotesNoDestino();

    const r = await rascunho(
      [presoA, presoB, presoC].map((loteId) => ({ produtoId: p, loteId, quantidade: '2' })),
      { estoqueOrigemId: estoqueLoja1 },
      tokenExpedicao,
    );
    expect((await enviar(r.id, {}, tokenExpedicao)).status).toBe(200);
    const rec = await receber(r.id, { receberTudo: true }, tokenLoja2);
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body.status).toBe('recebida');
    // Nenhum lote criado; cada um entrou no do mesmo código do destino.
    expect(await saldosLote(estoqueLoja2, p)).toEqual({
      [soltoA]: '2.000',
      [inativoB]: '2.000',
      [vivoC]: '2.000',
    });
    const depois = await lotesNoDestino();
    expect(depois.map((l) => l.id)).toEqual(antes.map((l) => l.id));
    // O inativo foi reativado com a validade e a fabricação da origem; o excluído continua excluído.
    expect(depois.find((l) => l.id === inativoB)).toMatchObject({
      ativo: true,
      excluido: false,
      validade: '2027-01-01',
      fabricacao: '2026-10-01',
    });
    expect(depois.find((l) => l.id === excluidoC)).toMatchObject({ excluido: true, validade: '2027-03-01' });

    // Outra fabricação no destino: o recebimento é recusado no item, e a transferência continua em trânsito.
    const r2 = await rascunho(
      [{ produtoId: p, loteId: presoD, quantidade: '2' }],
      { estoqueOrigemId: estoqueLoja1 },
      tokenExpedicao,
    );
    expect((await enviar(r2.id, {}, tokenExpedicao)).status).toBe(200);
    const recusado = await receber(r2.id, { receberTudo: true }, tokenLoja2);
    expect(recusado.status, JSON.stringify(recusado.body)).toBe(422);
    expect(recusado.body.campos['itens.0.loteId'][0]).toContain(
      'já está cadastrado no destino com a fabricação 02/10/2026 (na origem, 01/10/2026)',
    );
    expect((await obter(r2.id)).body).toMatchObject({
      status: 'em_transito',
      itens: [{ quantidadeRecebida: null }],
    });
    expect(await movimentos(r2.id)).toHaveLength(1);
    expect((await cancelar(r2.id, 'Cadastro do lote a corrigir', tokenExpedicao)).status).toBe(200);
  });

  it('casco vazio (Vasilhame vazio) volta da loja para o CD', async () => {
    const casco = await produto('Casco 600ml retornável', {
      tipo: 'vasilhame',
      precoVenda: '1.5',
      precoCusto: '1',
    });
    await entrada(estoqueLoja1, [{ produtoId: casco, quantidade: '48', custoUnitario: '1' }], {
      tipoEstoqueId: tipoVasilhame,
    });
    const r = await rascunho(
      [{ produtoId: casco, quantidade: '48' }],
      {
        estoqueOrigemId: estoqueLoja1,
        estoqueDestinoId: cd,
        tipoEstoqueId: tipoVasilhame,
        motivo: 'Cascos vazios para o CD',
      },
      tokenExpedicao,
    );
    expect(r).toMatchObject({ tipoEstoqueId: tipoVasilhame });
    expect((await enviar(r.id, {}, tokenExpedicao)).status).toBe(200);
    // O expedidor tem o CD entre os permitidos: recebe os cascos.
    const rec = await receber(r.id, { receberTudo: true }, tokenExpedicao);
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body.status).toBe('recebida');
    expect((await saldo(estoqueLoja1, casco, tipoVasilhame)).quantidade).toBe('0.000');
    expect(await saldo(cd, casco, tipoVasilhame)).toEqual({ quantidade: '48.000', custo_medio: '1.0000' });
    // Nada no Disponível: o tipo é o mesmo nas duas pontas.
    expect((await saldo(cd, casco)).quantidade).toBe('0.000');
    expect(
      (await movimentos(r.id)).map((m) => [m.tipo_movimento, m.estoque_id, m.quantidade, m.loja_id]),
    ).toEqual([
      ['TRANSF_SAIDA', estoqueLoja1, '-48.000', loja1],
      ['TRANSF_ENTRADA', cd, '48.000', null],
    ]);
  });

  it('modo de uma etapa: o envio já recebe tudo; o lote preso à origem entra no lote do mesmo código do destino; o saldo desce ao PDV das duas lojas', async () => {
    const p = await produto('Requeijão cremoso 200g');
    const preso = await lote(p, 'RQ-01', '2026-12-20', estoqueLoja1);
    const solto = await lote(p, 'RQ-02', '2027-01-20', null);
    await entrada(estoqueLoja1, [
      { produtoId: p, loteId: preso, quantidade: '6', custoUnitario: '3' },
      { produtoId: p, loteId: solto, quantidade: '10', custoUnitario: '3' },
    ]);
    const pdvLoja1 = await terminalDaLoja(loja1);
    const pdvLoja2 = await terminalDaLoja(loja2);
    const c1 = await puxar(pdvLoja1, 'estoque', 0);
    const c2 = await puxar(pdvLoja2, 'estoque', 0);
    // A chave é da empresa (Configurações › Geral): por loja é recusada.
    const porLoja = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer())
      .send({ lojaId: loja1, valores: { 'estoque.transferencia_recebimento_automatico': true } });
    expect(porLoja.status).toBe(422);
    expect(porLoja.body.campos['estoque.transferencia_recebimento_automatico'][0]).toBe(
      'Esta configuração não aceita valor por loja',
    );
    const ligada = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer())
      .send({ valores: { 'estoque.transferencia_recebimento_automatico': true } });
    expect(ligada.status, JSON.stringify(ligada.body)).toBe(200);
    try {
      const r = await rascunho(
        [{ produtoId: p, quantidade: '8' }],
        { estoqueOrigemId: estoqueLoja1 },
        tokenExpedicao,
      );
      // O expedidor não tem a Loja 2: no modo de uma etapa não precisa (a chave é a autorização).
      const e = await enviar(r.id, { versao: r.versao }, tokenExpedicao);
      expect(e.status, JSON.stringify(e.body)).toBe(200);
      expect(e.body).toMatchObject({
        status: 'recebida',
        enviadaPorNome: 'EXPEDICAO',
        recebidaPorNome: 'EXPEDICAO',
      });
      expect(e.body.itens[0]).toMatchObject({ quantidadeRecebida: '8.000', diferenca: '0.000' });
      expect((await saldo(estoqueLoja1, p)).quantidade).toBe('8.000');
      expect(await saldo(estoqueLoja2, p)).toEqual({ quantidade: '8.000', custo_medio: '3.0000' });
      // A FEFO tirou 6 do RQ-01 (preso à Loja 1) e 2 do RQ-02 (sem estoque): o RQ-01 entra num lote novo preso à Loja 2,
      // com o mesmo código e a mesma validade; o RQ-02 entra como está.
      const novos = await consultar<{ id: string; lote: string; validade: string }>(
        emp.nomeBanco,
        `select id, lote, validade::text from produtos_lotes where produto_id = $1 and estoque_id = $2`,
        [p, estoqueLoja2],
      );
      expect(novos).toEqual([{ id: expect.any(String), lote: 'RQ-01', validade: '2026-12-20' }]);
      const novo = novos[0]!.id;
      expect(await saldosLote(estoqueLoja2, p)).toEqual({ [novo]: '6.000', [solto]: '2.000' });
      expect((await movimentos(r.id)).map((m) => [m.tipo_movimento, m.lote_id, m.quantidade])).toEqual([
        ['TRANSF_SAIDA', preso, '-6.000'],
        ['TRANSF_SAIDA', solto, '-2.000'],
        ['TRANSF_ENTRADA', novo, '6.000'],
        ['TRANSF_ENTRADA', solto, '2.000'],
      ]);
      const aud = await consultar<{ descricao: string }>(
        emp.nomeBanco,
        `select descricao from auditoria where entidade = 'transferencias_estoque' and registro_id = $1 and acao = 'movimentar'
          order by criado_em`,
        [r.id],
      );
      // As duas na mesma transação (o mesmo `criado_em`): sem depender da ordem.
      expect(aud.map((x) => x.descricao).sort()).toEqual([
        `Transferência Nº ${r.codigo} enviada: 1 item(ns), 2 movimento(s)`,
        `Transferência Nº ${r.codigo} recebida no envio (recebimento automático): 1 item(ns), 2 movimento(s), 1 lote(s) criado(s) no destino`,
      ]);

      // O lote do mesmo código já está no destino: é reaproveitado.
      await entrada(estoqueLoja1, [{ produtoId: p, loteId: preso, quantidade: '3', custoUnitario: '3' }]);
      const r2 = await rascunho(
        [{ produtoId: p, loteId: preso, quantidade: '3' }],
        { estoqueOrigemId: estoqueLoja1 },
        tokenExpedicao,
      );
      expect((await enviar(r2.id, {}, tokenExpedicao)).status).toBe(200);
      expect(await saldosLote(estoqueLoja2, p)).toEqual({ [novo]: '9.000', [solto]: '2.000' });

      // O mesmo código com outra validade no destino: o recebimento (aqui, o envio inteiro) é recusado no item.
      const conflito = await lote(p, 'RQ-03', '2027-03-01', estoqueLoja1);
      await lote(p, 'RQ-03', '2027-04-01', estoqueLoja2);
      await entrada(estoqueLoja1, [{ produtoId: p, loteId: conflito, quantidade: '2', custoUnitario: '3' }]);
      const r3 = await rascunho(
        [{ produtoId: p, loteId: conflito, quantidade: '2' }],
        { estoqueOrigemId: estoqueLoja1 },
        tokenExpedicao,
      );
      const e3 = await enviar(r3.id, {}, tokenExpedicao);
      expect(e3.status, JSON.stringify(e3.body)).toBe(422);
      expect(e3.body.campos['itens.0.loteId'][0]).toContain(
        'já está cadastrado no destino com a validade 01/04/2027',
      );
      expect(await movimentos(r3.id)).toEqual([]);
      expect((await obter(r3.id)).body.status).toBe('rascunho');
      expect(
        (await amb.http().delete(`/api/transferencias/${r3.id}`).set(bearer(tokenExpedicao))).status,
      ).toBe(204);
    } finally {
      await consultar(
        emp.nomeBanco,
        `delete from configuracoes where chave = 'estoque.transferencia_recebimento_automatico'`,
      );
    }
    // O fluxo `estoque` desce os saldos novos aos PDVs das duas lojas: 6 + 10 + 3 + 2 − 8 − 3 = 10 na Loja 1 e 11 na 2.
    expect(ultimoSaldoNoPdv((await puxar(pdvLoja1, 'estoque', c1.cursor)).alteracoes, p)).toBe(10);
    expect(ultimoSaldoNoPdv((await puxar(pdvLoja2, 'estoque', c2.cursor)).alteracoes, p)).toBe(11);
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
