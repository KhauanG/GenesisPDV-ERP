/**
 * Núcleo de entrada de mercadoria: movimentar e estornar o recebimento manual (Fase 2, F2-B15; ERP 13.3; MD 3.6.9,
 * 3.6.10, 3.7.3, 3.8.1; D49; README da API › decisão 160), pela API do ERP e pelo push real do PDV. O critério de
 * pronto: 10 fardos × 12 a R$ 60,00 com frete de R$ 12,00 entram como +120 unidades a R$ 5,10, com o custo médio
 * ponderado com o saldo anterior, a última compra do saldo e do fornecedor, o preço de custo (com a pergunta de
 * `estoque.compra_atualiza_preco_custo`) e o preço de venda escolhido no histórico com a origem `recebimento`; o
 * movimentar repetido não lança de novo e o estorno desfaz o estoque sem desfazer o preço. Também: o lote com
 * validade (criado sem estoque, reaproveitado, validade divergente recusada) e o `saldos_lote`; o preço só da loja
 * descendo no fluxo `catalogo`; o custo do combo recalculado pelo banco no histórico; a permissão de alterar preço (o
 * mesmo preço não é alteração, e o "só da loja" igual ao geral não fixa preço na loja que segue o geral); os modos
 * 'sempre' e 'nunca' e o 'perguntar' sem `produtos.ver_custo`; o "Definir" com a contagem à frente que anula a
 * entrada e o estorno das duas pernas (`ESTORNO_ACERTO` na compensação); o estorno depois da venda do PDV, 422 sem
 * Master, na linha e no lote (FEFO); o lote inativo que volta a ativo; e o vínculo com o fornecedor (a compra mais
 * antiga movimentada depois não volta o último custo; unidade e fator só no vínculo sem código). No fim o razão refaz
 * as projeções idênticas (`conferirRazaoDoBanco`, o núcleo do `db:recalcular-saldos`).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  baseMarkupRecebimentoTexto,
  completarCnpj,
  contasEntradaRecebimentoTexto,
  CONTRATOS_EVENTOS,
  corpoProdutoRapido,
  decTexto,
  jcs,
  markupPrecoRecebimento,
  respostaPullSchema,
  respostaPushSchema,
  type Ativar,
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
let tokenAdmin: string;
/** Estoquista do seed: recebe, movimenta e estorna, sem Master, sem saldo negativo e sem `produtos.alterar_preco`. */
let tokenEstoquista: string;
let un: string;
let loja: string;
let estoqueLoja: string;
let fornecedor: string;
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

/** Fardo de compra com o fator dado, direto no banco. */
async function fardo(produtoId: string, codigo: string, fator = '12'): Promise<string> {
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into produtos_codigos_barras (produto_id, codigo, tipo, fator, descricao, usa_venda, usa_compra, unidade_id)
     values ($1, $2, 'interno', $3, 'Fardo', false, true, (select id from unidades_medida where sigla = 'FD'))
     returning id`,
    [produtoId, codigo, fator],
  );
  return c!.id;
}

/** Cria o rascunho e devolve o detalhe. */
async function rascunho(itens: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  const r = await amb
    .http()
    .post('/api/recebimentos')
    .set(bearer())
    .send({ lojaId: loja, fornecedorId: fornecedor, dataRecebimento: '2026-11-01', itens, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; versao: number; codigo: number };
}

/** Cria e efetiva um acerto (o saldo anterior, o "Definir"), pelo admin. */
async function efetivarAcerto(corpo: Record<string, unknown>): Promise<string> {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({ estoqueId: estoqueLoja, motivo: 'Teste do recebimento', ...corpo });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const ef = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: a.body.versao });
  expect(ef.status, JSON.stringify(ef.body)).toBe(200);
  return a.body.id as string;
}

const vinculos = (produtoId: string) =>
  consultar<Record<string, unknown>>(
    emp.nomeBanco,
    `select fornecedor_id, codigo_fornecedor, unidade_compra, fator::text, ultimo_custo::text,
            ultima_compra_em::text, principal
       from produtos_fornecedores where produto_id = $1 and excluido_em is null order by criado_em`,
    [produtoId],
  );

const precoDaLoja = (produtoId: string) =>
  consultar<{ preco_venda: string | null }>(
    emp.nomeBanco,
    'select preco_venda::text from produtos_lojas where produto_id = $1 and loja_id = $2 and excluido_em is null',
    [produtoId, loja],
  );

const movimentar = (id: string, corpo: Record<string, unknown> = {}, token = tokenAdmin) =>
  amb.http().post(`/api/recebimentos/${id}/movimentar`).set(bearer(token)).send(corpo);
const estornar = (id: string, motivo: string, token = tokenAdmin, extra: Record<string, unknown> = {}) =>
  amb
    .http()
    .post(`/api/recebimentos/${id}/estornar`)
    .set(bearer(token))
    .send({ motivo, ...extra });

async function saldo(produtoId: string) {
  const [s] = await consultar<{
    quantidade: string;
    custo_medio: string;
    ultima_compra_em: Date | null;
    ultimo_custo_compra: string | null;
  }>(
    emp.nomeBanco,
    `select s.quantidade::text, s.custo_medio::text, s.ultima_compra_em, s.ultimo_custo_compra::text
       from saldos_estoque s join tipos_estoque t on t.id = s.tipo_estoque_id
      where s.estoque_id = $1 and s.produto_id = $2 and t.padrao`,
    [estoqueLoja, produtoId],
  );
  return s;
}

async function cadastro(produtoId: string) {
  const [p] = await consultar<{ preco_custo: string; preco_venda: string; markup_pct: string }>(
    emp.nomeBanco,
    'select preco_custo::text, preco_venda::text, markup_pct::text from produtos where id = $1',
    [produtoId],
  );
  return p!;
}

const historico = (produtoId: string) =>
  consultar<{
    tipo_preco: string;
    loja_id: string | null;
    valor_anterior: string | null;
    valor_novo: string | null;
    origem: string;
    origem_id: string | null;
  }>(
    emp.nomeBanco,
    `select tipo_preco, loja_id, valor_anterior::text, valor_novo::text, origem, origem_id
       from produtos_historico_precos where produto_id = $1 and origem <> 'cadastro' order by tipo_preco, criado_em`,
    [produtoId],
  );

const movimentos = (documentoId: string) =>
  consultar<{
    tipo_movimento: string;
    quantidade: string;
    custo_unitario: string;
    fator: string;
    unidade_documento: string | null;
    pessoa_id: string | null;
    lote_id: string | null;
    estorno_de_id: string | null;
  }>(
    emp.nomeBanco,
    `select tipo_movimento, quantidade::text, custo_unitario::text, fator::text, unidade_documento, pessoa_id, lote_id,
            estorno_de_id
       from movimentos_estoque where documento_tipo = 'recebimento' and documento_id = $1 order by seq_lancamento`,
    [documentoId],
  );

// ---------------------------------------------------------------- PDV (o pull do catálogo e a venda)

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

/** O caixa com o terminal ativado pelo `/sync/ativar` real e a sessão aberta. */
interface Ponto {
  caixa: string;
  terminal: string;
  token: string;
  seq: number;
  venda: number;
  sessao: string;
}

let ponto: Ponto;

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
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
    contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: 1, versao_app: '1.0.0' },
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

/** Venda finalizada do PDV-1 (sem lote), paga em dinheiro. */
function venda(p: Ponto, produtoId: string, quantidade: string) {
  const id = uuidv7();
  const numero = ++p.venda;
  const quando = minutosAtras(1);
  const total = (5 * Number(quantidade)).toFixed(2);
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
    itens_venda: [
      {
        id: uuidv7(),
        venda_id: id,
        sequencia: 1,
        produto_id: produtoId,
        descricao: 'ITEM DE TESTE',
        unidade: 'UN',
        quantidade,
        preco_tabela: '5.0000',
        preco_unitario: '5.0000',
        valor_bruto: total,
        valor_liquido: total,
        incluido_em: quando,
        componentes_estoque: [],
      },
    ],
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

/** As alterações do fluxo desde `desde`, e o cursor novo. */
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
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
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
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [loja],
    estoques: [estoqueLoja],
  });
  tokenEstoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  const f = await amb
    .http()
    .post('/api/pessoas/fornecedor-rapido')
    .set(bearer())
    .send({ cpfCnpj: completarCnpj('112223330001'), nome: 'Distribuidora X Ltda' });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  fornecedor = f.body.pessoa.id as string;
  ponto = await novoPonto();
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('movimentar o recebimento (F2-B15; ERP 13.3)', () => {
  it('10 fardos × 12 a R$ 60,00 com frete de R$ 12,00: +120 a R$ 5,10, custo médio, última compra e preço (critério de pronto)', async () => {
    const p = await produto('Cerveja Pilsen lata 350ml');
    const fd = await fardo(p, 'FD12-PILSEN');
    // Saldo anterior: 30 unidades a R$ 4,00 (acerto de Entrada).
    await efetivarAcerto({
      tipoAjuste: 'entrada',
      dataContagem: agora(),
      itens: [{ produtoId: p, quantidade: '30', custoUnitario: '4' }],
    });

    const r = await rascunho(
      [
        {
          produtoId: p,
          codigoBarrasId: fd,
          fator: '12',
          quantidade: '10',
          precoCompra: '60',
          precoVenda: '8.90',
          atualizarPreco: 'geral',
        },
      ],
      { valorFrete: '12.00', codigoRemessa: 'NF 777' },
    );
    // "perguntar" (o padrão, D49): sem resposta e com o preço de custo diferente, 422 com a pergunta e os produtos.
    const pergunta = await movimentar(r.id, { versao: r.versao });
    expect(pergunta.status, JSON.stringify(pergunta.body)).toBe(422);
    expect(pergunta.body.campos.atualizarPrecoCusto).toBeDefined();
    expect(pergunta.body.detalhes.precosCusto).toEqual([
      { produtoId: p, nome: 'Cerveja Pilsen lata 350ml', atual: '4.0000', novo: '5.1000' },
    ]);
    expect(await movimentos(r.id)).toEqual([]);

    const m = await movimentar(r.id, { versao: r.versao, atualizarPrecoCusto: true });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body).toMatchObject({ status: 'movimentado', movimentadoPorNome: expect.any(String) });
    expect(m.body.movimentadoEm).not.toBeNull();
    expect(m.body.itens[0]).toMatchObject({
      quantidadeEstoque: '120.000',
      rateioFrete: '12.00',
      rateioDesconto: '0.00',
      rateioOutras: '0.00',
      custoUnitarioFinal: '5.1000',
      loteId: null,
    });
    expect(await movimentos(r.id)).toEqual([
      {
        tipo_movimento: 'RECEB_MANUAL',
        quantidade: '120.000',
        custo_unitario: '5.1000',
        fator: '12.000',
        unidade_documento: 'FD',
        pessoa_id: fornecedor,
        lote_id: null,
        estorno_de_id: null,
      },
    ]);
    // Custo médio ponderado com o saldo anterior: (30 × 4,00 + 120 × 5,10) ÷ 150 = 4,88; a última compra no saldo.
    const s = await saldo(p);
    expect(s).toMatchObject({ quantidade: '150.000', custo_medio: '4.8800', ultimo_custo_compra: '5.1000' });
    expect(s!.ultima_compra_em).not.toBeNull();
    // Preço de custo = o último custo; o preço de venda escolhido ("geral") e o markup refeito.
    expect(await cadastro(p)).toEqual({
      preco_custo: '5.1000',
      preco_venda: '8.9000',
      markup_pct: '74.5098',
    });
    expect(await historico(p)).toEqual([
      {
        tipo_preco: 'custo',
        loja_id: null,
        valor_anterior: '4.0000',
        valor_novo: '5.1000',
        origem: 'recebimento',
        origem_id: r.id,
      },
      {
        tipo_preco: 'venda',
        loja_id: null,
        valor_anterior: '8.0000',
        valor_novo: '8.9000',
        origem: 'recebimento',
        origem_id: r.id,
      },
    ]);
    // O vínculo com o fornecedor nasce com a embalagem da compra, o último custo e a data do documento.
    expect(await vinculos(p)).toEqual([
      {
        fornecedor_id: fornecedor,
        codigo_fornecedor: null,
        unidade_compra: 'FD',
        fator: '12.000',
        ultimo_custo: '5.1000',
        ultima_compra_em: '2026-11-01',
        principal: true,
      },
    ]);

    // Idempotente: o segundo movimentar (com a versão velha) devolve o mesmo detalhe e não lança de novo.
    const deNovo = await movimentar(r.id, { versao: r.versao, atualizarPrecoCusto: true });
    expect(deNovo.status, JSON.stringify(deNovo.body)).toBe(200);
    expect(deNovo.body.status).toBe('movimentado');
    expect(await movimentos(r.id)).toHaveLength(1);
    expect((await saldo(p))!.quantidade).toBe('150.000');
    const aud = await consultar<{ acao: string }>(
      emp.nomeBanco,
      `select acao from auditoria where entidade = 'recebimentos' and registro_id = $1 order by criado_em`,
      [r.id],
    );
    expect(aud.map((x) => x.acao)).toEqual(['criar', 'movimentar']);
    // Movimentado é somente leitura.
    const edita = await amb
      .http()
      .put(`/api/recebimentos/${r.id}`)
      .set(bearer())
      .send({ lojaId: loja, fornecedorId: fornecedor, versao: deNovo.body.versao, itens: [] });
    expect(edita.status).toBe(422);

    // O estorno desfaz o estoque (sai ao custo médio vigente) e não desfaz o preço nem o preço de custo.
    const sem = await amb
      .http()
      .post(`/api/recebimentos/${r.id}/estornar`)
      .set(bearer())
      .send({ motivo: ' ' });
    expect(sem.status).toBe(422);
    const e = await estornar(r.id, 'Entrada lançada no estoque errado');
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body).toMatchObject({ status: 'estornado', motivoEstorno: 'Entrada lançada no estoque errado' });
    const ms = await movimentos(r.id);
    expect(ms.map((x) => [x.tipo_movimento, x.quantidade])).toEqual([
      ['RECEB_MANUAL', '120.000'],
      ['ESTORNO_RECEB_MANUAL', '-120.000'],
    ]);
    expect(ms[1]!.estorno_de_id).not.toBeNull();
    expect((await saldo(p))!.quantidade).toBe('30.000');
    expect(await cadastro(p)).toMatchObject({ preco_custo: '5.1000', preco_venda: '8.9000' });
    // Estornado não volta: nem movimentar nem estornar de novo.
    expect((await movimentar(r.id, { atualizarPrecoCusto: true })).status).toBe(422);
    expect((await estornar(r.id, 'de novo')).status).toBe(422);
  });

  it('lote com validade: criado sem estoque, gera saldos_lote, é reaproveitado e a validade divergente é recusada', async () => {
    const p = await produto('Iogurte de morango 170g');
    const fd = await fardo(p, 'FD12-IOGURTE');
    const item = (validade: string) => ({
      produtoId: p,
      codigoBarrasId: fd,
      fator: '12',
      quantidade: '2',
      precoCompra: '24',
      lote: 'L2611',
      validade,
      fabricacao: '2026-10-30',
    });
    const r = await rascunho([item('2027-01-31')], { temValidade: true });
    const m = await movimentar(r.id, { atualizarPrecoCusto: false });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const loteId = m.body.itens[0].loteId as string;
    expect(loteId).toBeTruthy();
    const [lote] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      'select produto_id, estoque_id, lote, validade::text, fabricacao::text, fornecedor_id from produtos_lotes where id = $1',
      [loteId],
    );
    expect(lote).toEqual({
      produto_id: p,
      estoque_id: null,
      lote: 'L2611',
      validade: '2027-01-31',
      fabricacao: '2026-10-30',
      fornecedor_id: fornecedor,
    });
    const saldoLote = async () =>
      (
        await consultar<{ quantidade: string }>(
          emp.nomeBanco,
          'select quantidade::text from saldos_lote where lote_id = $1 and estoque_id = $2',
          [loteId, estoqueLoja],
        )
      )[0]?.quantidade;
    expect(await saldoLote()).toBe('24.000');
    expect((await movimentos(r.id))[0]!.lote_id).toBe(loteId);
    // "Atualizar preço de custo" = não: o preço de custo manual fica, a última compra do saldo muda.
    expect((await cadastro(p)).preco_custo).toBe('4.0000');
    expect((await saldo(p))!.ultimo_custo_compra).toBe('2.0000');

    // O mesmo lote com outra validade: 422 no item, nada lançado.
    const outro = await rascunho([item('2027-02-28')], { temValidade: true });
    const recusa = await movimentar(outro.id, { atualizarPrecoCusto: false });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(422);
    expect(recusa.body.campos['itens.0.validade'][0]).toMatch(/31\/01\/2027/);
    expect(await movimentos(outro.id)).toEqual([]);
    // Com a mesma validade, o lote é reaproveitado.
    const mesmo = await rascunho([item('2027-01-31')], { temValidade: true });
    const m2 = await movimentar(mesmo.id, { atualizarPrecoCusto: false });
    expect(m2.status, JSON.stringify(m2.body)).toBe(200);
    expect(m2.body.itens[0].loteId).toBe(loteId);
    expect(await saldoLote()).toBe('48.000');
    expect((await saldo(p))!.quantidade).toBe('48.000');
    // O estorno volta ao mesmo lote.
    expect((await estornar(mesmo.id, 'Lançado em duplicidade')).status).toBe(200);
    expect(await saldoLote()).toBe('24.000');
  });

  it('o preço só da loja desce no fluxo catalogo e entra no histórico com a origem recebimento', async () => {
    const p = await produto('Refrigerante cola 2L');
    const inicio = await puxar(ponto, 'catalogo', 0);
    const r = await rascunho([
      { produtoId: p, quantidade: '6', precoCompra: '7.50', precoVenda: '9.50', atualizarPreco: 'loja' },
    ]);
    const m = await movimentar(r.id, { atualizarPrecoCusto: false });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    // O preço geral não muda; a linha de `produtos_lojas` da loja destinatária nasce com o preço.
    expect((await cadastro(p)).preco_venda).toBe('8.0000');
    const [pl] = await consultar<{ preco_venda: string }>(
      emp.nomeBanco,
      'select preco_venda::text from produtos_lojas where produto_id = $1 and loja_id = $2 and excluido_em is null',
      [p, loja],
    );
    expect(pl!.preco_venda).toBe('9.5000');
    expect(await historico(p)).toEqual([
      {
        tipo_preco: 'loja',
        loja_id: loja,
        valor_anterior: null,
        valor_novo: '9.5000',
        origem: 'recebimento',
        origem_id: r.id,
      },
    ]);
    const depois = await puxar(ponto, 'catalogo', inicio.cursor);
    const linha = depois.alteracoes.find((a) => a.tabela === 'produtos_lojas' && a.linha.produto_id === p);
    expect(linha, JSON.stringify(depois.alteracoes.map((a) => a.tabela))).toBeDefined();
    expect(Number(linha!.linha.preco_venda)).toBe(9.5);
    // Um segundo recebimento troca o preço da linha que já existe.
    const r2 = await rascunho([
      { produtoId: p, quantidade: '6', precoCompra: '7.50', precoVenda: '9.90', atualizarPreco: 'loja' },
    ]);
    expect((await movimentar(r2.id, { atualizarPrecoCusto: false })).status).toBe(200);
    const linhas = await consultar<{ preco_venda: string }>(
      emp.nomeBanco,
      'select preco_venda::text from produtos_lojas where produto_id = $1 and loja_id = $2 and excluido_em is null',
      [p, loja],
    );
    expect(linhas).toEqual([{ preco_venda: '9.9000' }]);
  });

  it('o custo do combo recalculado pelo banco (0005) entra no histórico com a origem recebimento', async () => {
    const agua = await produto('Água mineral 500ml', { precoCusto: '1', precoVenda: '3' });
    const combo = await produto('Combo 2 águas', {
      tipo: 'kit',
      precoVenda: '5',
      precoCusto: undefined,
      componentes: [{ tipo: 'kit', componenteId: agua, quantidade: '2', ordem: 0 }],
    });
    expect((await cadastro(combo)).preco_custo).toBe('2.0000');
    const r = await rascunho([{ produtoId: agua, quantidade: '24', precoCompra: '1.25' }]);
    expect((await movimentar(r.id, { atualizarPrecoCusto: true })).status).toBe(200);
    expect((await cadastro(agua)).preco_custo).toBe('1.2500');
    expect((await cadastro(combo)).preco_custo).toBe('2.5000');
    expect(await historico(combo)).toEqual([
      {
        tipo_preco: 'custo',
        loja_id: null,
        valor_anterior: '2.0000',
        valor_novo: '2.5000',
        origem: 'recebimento',
        origem_id: null,
      },
    ]);
  });

  it('chave estoque.compra_atualiza_preco_custo: "sempre" atualiza sem perguntar e "nunca" mantém o preço de custo', async () => {
    const p = await produto('Suco de uva 1L');
    const config = (valor: string) =>
      consultar(
        emp.nomeBanco,
        `insert into configuracoes (escopo, chave, valor) values ('empresa', 'estoque.compra_atualiza_preco_custo', $1::jsonb)
         on conflict do nothing`,
        [JSON.stringify(valor)],
      );
    const limpar = () =>
      consultar(
        emp.nomeBanco,
        "delete from configuracoes where chave = 'estoque.compra_atualiza_preco_custo'",
      );
    try {
      await config('nunca');
      const r = await rascunho([{ produtoId: p, quantidade: '1', precoCompra: '6' }]);
      // A resposta do corpo não vale contra a chave.
      expect((await movimentar(r.id, { atualizarPrecoCusto: true })).status).toBe(200);
      expect((await cadastro(p)).preco_custo).toBe('4.0000');
      await limpar();
      await config('sempre');
      const r2 = await rascunho([{ produtoId: p, quantidade: '1', precoCompra: '6.50' }]);
      expect((await movimentar(r2.id)).status).toBe(200);
      expect((await cadastro(p)).preco_custo).toBe('6.5000');
    } finally {
      await limpar();
    }
  });

  it('"Altera Preço do Produto no ERP" desligada: sem "Produtos: Alterar preço" o item que muda o preço é 403', async () => {
    const p = await produto('Energético 250ml');
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.altera_preco_produto_erp', 'false'::jsonb)`,
    );
    try {
      const r = await rascunho([
        { produtoId: p, quantidade: '4', precoCompra: '5', precoVenda: '9.99', atualizarPreco: 'geral' },
      ]);
      // A tela sabe pelos dados de compra que o estoquista não muda o preço (não pergunta "geral / só desta loja");
      // o admin (Master) muda (README da API › decisão 165).
      const dadosDe = (token: string) =>
        amb.http().get(`/api/recebimentos/dados-produtos?produtoIds=${p}`).set(bearer(token));
      expect((await dadosDe(tokenEstoquista)).body.podeAlterarPreco).toBe(false);
      expect((await dadosDe(tokenAdmin)).body.podeAlterarPreco).toBe(true);
      const m = await movimentar(r.id, { atualizarPrecoCusto: false }, tokenEstoquista);
      expect(m.status, JSON.stringify(m.body)).toBe(403);
      expect(m.body.campos['itens.0.precoVenda']).toBeDefined();
      expect(await movimentos(r.id)).toEqual([]);
      // O preço só da loja diferente do geral (a loja sem preço próprio segue o geral) também muda o preço: 403.
      const daLoja = await rascunho([
        { produtoId: p, quantidade: '4', precoCompra: '5', precoVenda: '8.50', atualizarPreco: 'loja' },
      ]);
      const mLoja = await movimentar(daLoja.id, { atualizarPrecoCusto: false }, tokenEstoquista);
      expect(mLoja.status, JSON.stringify(mLoja.body)).toBe(403);
      expect(mLoja.body.campos['itens.0.precoVenda']).toBeDefined();

      // O mesmo preço de agora não é alteração, nem no geral nem no "só da loja" sem preço próprio (o geral, R$ 8,00):
      // o estoquista movimenta, e a loja continua seguindo o geral (sem linha em `produtos_lojas` nem histórico).
      const mesmo = await rascunho([
        { produtoId: p, quantidade: '1', precoCompra: '5', precoVenda: '8', atualizarPreco: 'geral' },
        { produtoId: p, quantidade: '1', precoCompra: '5', precoVenda: '8.00', atualizarPreco: 'loja' },
      ]);
      const mMesmo = await movimentar(mesmo.id, { atualizarPrecoCusto: false }, tokenEstoquista);
      expect(mMesmo.status, JSON.stringify(mMesmo.body)).toBe(200);
      expect((await cadastro(p)).preco_venda).toBe('8.0000');
      expect(await precoDaLoja(p)).toEqual([]);
      expect(await historico(p)).toEqual([]);
      // A linha da loja com o preço nulo (segue o geral) também não é preenchida.
      await consultar(
        emp.nomeBanco,
        'insert into produtos_lojas (produto_id, loja_id, preco_venda) values ($1, $2, null)',
        [p, loja],
      );
      const nula = await rascunho([
        { produtoId: p, quantidade: '1', precoCompra: '5', precoVenda: '8', atualizarPreco: 'loja' },
      ]);
      expect((await movimentar(nula.id, { atualizarPrecoCusto: false }, tokenEstoquista)).status).toBe(200);
      expect(await precoDaLoja(p)).toEqual([{ preco_venda: null }]);
      expect(await historico(p)).toEqual([]);

      // O admin (Master) altera o preço geral; e, com a permissão, o "só da loja" igual ao preço geral antigo fixa o
      // preço próprio (diferente do geral novo, que é o que a loja seguiria).
      expect((await movimentar(r.id, { atualizarPrecoCusto: false })).status).toBe(200);
      expect((await cadastro(p)).preco_venda).toBe('9.9900');
      const fixa = await rascunho([
        { produtoId: p, quantidade: '1', precoCompra: '5', precoVenda: '10.50', atualizarPreco: 'geral' },
        { produtoId: p, quantidade: '1', precoCompra: '5', precoVenda: '9.99', atualizarPreco: 'loja' },
      ]);
      expect((await movimentar(fixa.id, { atualizarPrecoCusto: false })).status).toBe(200);
      expect((await cadastro(p)).preco_venda).toBe('10.5000');
      expect(await precoDaLoja(p)).toEqual([{ preco_venda: '9.9900' }]);
    } finally {
      await consultar(
        emp.nomeBanco,
        "delete from configuracoes where chave = 'geral.altera_preco_produto_erp'",
      );
    }
  });

  it('estorno depois da venda do PDV: 422 sem Master (saldo negativo), o Master estorna só confirmando (D56 com aviso)', async () => {
    const p = await produto('Cerveja puro malte long neck');
    const r = await rascunho([{ produtoId: p, quantidade: '10', precoCompra: '4' }]);
    expect((await movimentar(r.id, { atualizarPrecoCusto: false })).status).toBe(200);
    await aplicar(ponto, 'venda.finalizada', venda(ponto, p, '8.000'));
    expect((await saldo(p))!.quantidade).toBe('2.000');
    const negativo = [
      {
        produtoId: p,
        nome: 'Cerveja puro malte long neck',
        lote: null,
        saldoAtual: '2.000',
        saldoFinal: '-8.000',
      },
    ];
    // Sem a permissão (estoquista, chave desligada): bloqueado, e a confirmação não vale.
    for (const extra of [{}, { confirmarNegativo: negativo }]) {
      const recusa = await estornar(r.id, 'Nota devolvida ao fornecedor', tokenEstoquista, extra);
      expect(recusa.status, JSON.stringify(recusa.body)).toBe(422);
      expect(recusa.body.mensagem).toMatch(/saldo negativo em: Cerveja puro malte long neck \(saldo 2\)/);
      expect(recusa.body.campos?.confirmarNegativo).toBeUndefined();
      expect(recusa.body.detalhes.saldosNegativos).toEqual(negativo);
    }
    expect((await saldo(p))!.quantidade).toBe('2.000');
    expect((await amb.http().get(`/api/recebimentos/${r.id}`).set(bearer())).body.status).toBe('movimentado');
    // O Master sem a confirmação: 422 com a lista e o campo da confirmação; nada é lançado.
    const pergunta = await estornar(r.id, 'Nota devolvida ao fornecedor');
    expect(pergunta.status, JSON.stringify(pergunta.body)).toBe(422);
    expect(pergunta.body.campos.confirmarNegativo).toHaveLength(1);
    expect(pergunta.body.mensagem).toMatch(
      /O saldo ficará negativo em: Cerveja puro malte long neck \(saldo 2 → -8\)/,
    );
    expect(pergunta.body.detalhes.saldosNegativos).toEqual(negativo);
    expect((await saldo(p))!.quantidade).toBe('2.000');
    expect(await movimentos(r.id)).toHaveLength(1);
    // A confirmação é a lista mostrada, não um "sim" geral: o booleano não é aceito.
    const sim = await estornar(r.id, 'Nota devolvida ao fornecedor', tokenAdmin, { confirmarNegativo: true });
    expect(sim.status, JSON.stringify(sim.body)).toBe(422);
    expect(sim.body.codigo).toBe('VALIDACAO');
    // Uma venda do PDV sincroniza enquanto a pergunta está aberta: a lista confirmada não cobre o saldo mais fundo,
    // e volta o 422 com a lista de agora; nada é lançado.
    await aplicar(ponto, 'venda.finalizada', venda(ponto, p, '1.000'));
    const mudou = await estornar(r.id, 'Nota devolvida ao fornecedor', tokenAdmin, {
      confirmarNegativo: pergunta.body.detalhes.saldosNegativos,
    });
    expect(mudou.status, JSON.stringify(mudou.body)).toBe(422);
    expect(mudou.body.mensagem).toMatch(/^O saldo mudou desde a confirmação\. .*\(saldo 1 → -9\)/);
    expect(mudou.body.campos.confirmarNegativo[0]).toMatch(/confirme de novo/);
    const negativoAgora = [{ ...negativo[0]!, saldoAtual: '1.000', saldoFinal: '-9.000' }];
    expect(mudou.body.detalhes.saldosNegativos).toEqual(negativoAgora);
    expect((await saldo(p))!.quantidade).toBe('1.000');
    expect(await movimentos(r.id)).toHaveLength(1);
    // Com a confirmação da lista de agora, estorna e a auditoria registra o negativo confirmado.
    const ok = await estornar(r.id, 'Nota devolvida ao fornecedor', tokenAdmin, {
      confirmarNegativo: mudou.body.detalhes.saldosNegativos,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('estornado');
    expect((await saldo(p))!.quantidade).toBe('-9.000');
    const [aud] = await consultar<{ descricao: string; depois: Record<string, unknown> }>(
      emp.nomeBanco,
      `select descricao, depois from auditoria where entidade = 'recebimentos' and registro_id = $1 and acao = 'estornar'`,
      [r.id],
    );
    expect(aud!.descricao).toMatch(
      /saldo negativo confirmado em: Cerveja puro malte long neck \(saldo 1 → -9\)/,
    );
    expect(aud!.depois).toEqual({ saldoNegativoConfirmado: true, saldosNegativos: negativoAgora });
  });

  it('"Permite saldo negativo no ERP" ligada: quem não é Master estorna com a confirmação; sem negativo, nada é perguntado', async () => {
    const p = await produto('Refrigerante cola 2L retornável');
    const r = await rascunho([{ produtoId: p, quantidade: '6', precoCompra: '7' }]);
    expect((await movimentar(r.id, { atualizarPrecoCusto: false })).status).toBe(200);
    await aplicar(ponto, 'venda.finalizada', venda(ponto, p, '4.000'));
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (chave, valor) values ('estoque.permite_negativo_erp', 'true'::jsonb)`,
    );
    try {
      const pergunta = await estornar(r.id, 'Remessa trocada', tokenEstoquista);
      expect(pergunta.status, JSON.stringify(pergunta.body)).toBe(422);
      expect(pergunta.body.campos.confirmarNegativo).toHaveLength(1);
      expect(pergunta.body.detalhes.saldosNegativos).toEqual([
        {
          produtoId: p,
          nome: 'Refrigerante cola 2L retornável',
          lote: null,
          saldoAtual: '2.000',
          saldoFinal: '-4.000',
        },
      ]);
      // A confirmação de outro produto não cobre este: a pergunta volta.
      const outro = await estornar(r.id, 'Remessa trocada', tokenEstoquista, {
        confirmarNegativo: [{ produtoId: uuidv7(), lote: null, saldoFinal: '-4.000' }],
      });
      expect(outro.status, JSON.stringify(outro.body)).toBe(422);
      expect(outro.body.campos.confirmarNegativo).toHaveLength(1);
      const ok = await estornar(r.id, 'Remessa trocada', tokenEstoquista, {
        confirmarNegativo: pergunta.body.detalhes.saldosNegativos,
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await saldo(p))!.quantidade).toBe('-4.000');
    } finally {
      await consultar(
        emp.nomeBanco,
        "delete from configuracoes where chave = 'estoque.permite_negativo_erp'",
      );
    }
    // O estorno que não deixa negativo não pergunta nada, nem ao Master, e a auditoria não fala de negativo.
    const p2 = await produto('Refrigerante guaraná 2L');
    const r2 = await rascunho([{ produtoId: p2, quantidade: '6', precoCompra: '7' }]);
    expect((await movimentar(r2.id, { atualizarPrecoCusto: false })).status).toBe(200);
    const e2 = await estornar(r2.id, 'Lançado em duplicidade');
    expect(e2.status, JSON.stringify(e2.body)).toBe(200);
    const [aud] = await consultar<{ descricao: string; depois: unknown }>(
      emp.nomeBanco,
      `select descricao, depois from auditoria where entidade = 'recebimentos' and registro_id = $1 and acao = 'estornar'`,
      [r2.id],
    );
    expect(aud!.descricao).not.toMatch(/negativo/);
    expect(aud!.depois).toBeNull();
  });

  it('"perguntar" sem "Produtos: Ver custo": a pergunta não vem e a resposta não vale, o preço de custo fica', async () => {
    const p = await produto('Chá gelado limão 1,5L');
    // O estoquista do seed não tem `produtos.ver_custo`: não vê o preço de custo nem o custo, então não o decide.
    const r = await rascunho([{ produtoId: p, quantidade: '6', precoCompra: '5' }]);
    const m = await movimentar(r.id, {}, tokenEstoquista);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect((await cadastro(p)).preco_custo).toBe('4.0000');
    const r2 = await rascunho([{ produtoId: p, quantidade: '6', precoCompra: '5.50' }]);
    expect((await movimentar(r2.id, { atualizarPrecoCusto: true }, tokenEstoquista)).status).toBe(200);
    expect((await cadastro(p)).preco_custo).toBe('4.0000');
    // O custo médio e a última compra do saldo seguem a compra (não são o preço de custo do cadastro).
    expect(await saldo(p)).toMatchObject({ quantidade: '12.000', ultimo_custo_compra: '5.5000' });
    expect((await historico(p)).filter((h) => h.tipo_preco === 'custo')).toEqual([]);
  });

  it('"Definir" com a contagem um pouco à frente: a entrada é anulada; o estorno desfaz as duas pernas (ESTORNO_ACERTO na compensação)', async () => {
    const p = await produto('Água tônica lata 350ml');
    await efetivarAcerto({
      tipoAjuste: 'entrada',
      dataContagem: agora(),
      itens: [{ produtoId: p, quantidade: '10', custoUnitario: '4' }],
    });
    // A contagem informada para daqui a 4 min (dentro da folga de 5 min do criarAcertoSchema): diferença 0.
    const definir = await efetivarAcerto({
      tipoAjuste: 'definir',
      dataContagem: new Date(Date.now() + 4 * 60_000).toISOString(),
      itens: [{ produtoId: p, quantidade: '10' }],
    });
    const r = await rascunho([{ produtoId: p, quantidade: '24', precoCompra: '48' }]);
    const m = await movimentar(r.id, { atualizarPrecoCusto: false });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    // A entrada é anterior à contagem: a contagem vale, e a entrada é anulada contra o "Definir".
    expect((await saldo(p))!.quantidade).toBe('10.000');
    const compensacoes = () =>
      consultar<{ tipo_movimento: string; quantidade: string; documento_tipo: string; documento_id: string }>(
        emp.nomeBanco,
        `select c.tipo_movimento, c.quantidade::text, c.documento_tipo, c.documento_id
           from movimentos_estoque c join movimentos_estoque o on o.id = c.compensa_movimento_id
          where o.documento_tipo = 'recebimento' and o.documento_id = $1`,
        [r.id],
      );
    expect(await compensacoes()).toEqual([
      {
        tipo_movimento: 'ACERTO_COMPENSACAO',
        quantidade: '-24.000',
        documento_tipo: 'acerto',
        documento_id: definir,
      },
    ]);
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'recebimentos' and registro_id = $1 and acao = 'movimentar'`,
      [r.id],
    );
    expect(aud!.descricao).toMatch(/1 anulado\(s\) por "Definir"/);

    // O estorno da entrada (−24) sozinho deixaria −14: o efeito líquido com o da compensação (+24) é zero, e o
    // estoquista (sem saldo negativo) estorna. O estorno da compensação é uma entrada: `ESTORNO_ACERTO` (sinal 0 no
    // catálogo), não `ESTORNO_RECEB_MANUAL` (sinal −1, só saída).
    const e = await estornar(r.id, 'Contagem já incluía a mercadoria', tokenEstoquista);
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect((await saldo(p))!.quantidade).toBe('10.000');
    expect((await movimentos(r.id)).map((x) => [x.tipo_movimento, x.quantidade])).toEqual(
      expect.arrayContaining([
        ['RECEB_MANUAL', '24.000'],
        ['ESTORNO_RECEB_MANUAL', '-24.000'],
        ['ESTORNO_ACERTO', '24.000'],
      ]),
    );
    expect(await movimentos(r.id)).toHaveLength(3);
    // Nenhum movimento contraria o sinal do catálogo (MD 7.3).
    const contra = await consultar<{ tipo_movimento: string; quantidade: string }>(
      emp.nomeBanco,
      `select m.tipo_movimento, m.quantidade::text from movimentos_estoque m
         join tipos_movimento_estoque t on t.codigo = m.tipo_movimento
        where m.produto_id = $1 and t.sinal <> 0 and sign(m.quantidade) <> t.sinal`,
      [p],
    );
    expect(contra).toEqual([]);
  });

  it('estorno com o lote já vendido (FEFO): 422 no lote sem a permissão de saldo negativo, mesmo com saldo na linha', async () => {
    const p = await produto('Requeijão cremoso 200g');
    // 30 sem lote antes; o recebimento põe 12 no lote; a venda do PDV (sem lote) sai do lote primeiro (FEFO, D48).
    await efetivarAcerto({
      tipoAjuste: 'entrada',
      dataContagem: agora(),
      itens: [{ produtoId: p, quantidade: '30', custoUnitario: '4' }],
    });
    const r = await rascunho(
      [{ produtoId: p, quantidade: '12', precoCompra: '48', lote: 'RQ-01', validade: '2027-03-31' }],
      { temValidade: true },
    );
    const m = await movimentar(r.id, { atualizarPrecoCusto: false });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const loteId = m.body.itens[0].loteId as string;
    await aplicar(ponto, 'venda.finalizada', venda(ponto, p, '5.000'));
    const saldoLote = async () =>
      (
        await consultar<{ quantidade: string }>(
          emp.nomeBanco,
          'select quantidade::text from saldos_lote where lote_id = $1 and estoque_id = $2',
          [loteId, estoqueLoja],
        )
      )[0]?.quantidade;
    expect(await saldoLote()).toBe('7.000');
    expect((await saldo(p))!.quantidade).toBe('37.000');
    // A linha fica com 25, mas o lote ficaria com −5.
    const recusa = await estornar(r.id, 'Lote errado', tokenEstoquista);
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(422);
    expect(recusa.body.mensagem).toMatch(/saldo negativo no lote: .*lote RQ-01: 7/);
    expect(await saldoLote()).toBe('7.000');
    expect(await movimentos(r.id)).toHaveLength(1);
    expect(recusa.body.detalhes.saldosNegativos).toEqual([
      {
        produtoId: p,
        nome: 'Requeijão cremoso 200g',
        lote: 'RQ-01',
        saldoAtual: '7.000',
        saldoFinal: '-5.000',
      },
    ]);
    // O Master: a linha não fica negativa, mas o lote sim, e o lote também pede a confirmação.
    const pergunta = await estornar(r.id, 'Lote errado');
    expect(pergunta.status, JSON.stringify(pergunta.body)).toBe(422);
    expect(pergunta.body.campos.confirmarNegativo).toHaveLength(1);
    expect(pergunta.body.mensagem).toMatch(/lote RQ-01: 7 → -5/);
    expect(await movimentos(r.id)).toHaveLength(1);
    // A confirmação da linha do produto (sem lote) não cobre o lote.
    const semLote = await estornar(r.id, 'Lote errado', tokenAdmin, {
      confirmarNegativo: [{ produtoId: p, lote: null, saldoFinal: '-5.000' }],
    });
    expect(semLote.status, JSON.stringify(semLote.body)).toBe(422);
    // Confirmado, estorna: o lote fica negativo.
    const ok = await estornar(r.id, 'Lote errado', tokenAdmin, {
      confirmarNegativo: pergunta.body.detalhes.saldosNegativos,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await saldoLote()).toBe('-5.000');
    expect((await saldo(p))!.quantidade).toBe('25.000');
  });

  it('lote inativo volta a ativo ao receber mercadoria', async () => {
    const p = await produto('Queijo minas frescal 500g');
    const item = { produtoId: p, quantidade: '3', precoCompra: '30', lote: 'QM-7', validade: '2026-12-15' };
    const r = await rascunho([item], { temValidade: true });
    const m = await movimentar(r.id, { atualizarPrecoCusto: false });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const loteId = m.body.itens[0].loteId as string;
    await consultar(emp.nomeBanco, 'update produtos_lotes set ativo = false where id = $1', [loteId]);
    const r2 = await rascunho([item], { temValidade: true });
    const m2 = await movimentar(r2.id, { atualizarPrecoCusto: false });
    expect(m2.status, JSON.stringify(m2.body)).toBe(200);
    expect(m2.body.itens[0].loteId).toBe(loteId);
    const [lote] = await consultar<{ ativo: boolean }>(
      emp.nomeBanco,
      'select ativo from produtos_lotes where id = $1',
      [loteId],
    );
    expect(lote!.ativo).toBe(true);
  });

  it('vínculo com o fornecedor: a compra de data mais antiga movimentada depois não volta o último custo', async () => {
    const p = await produto('Vinho tinto suave 750ml');
    const cx = await fardo(p, 'CX6-VINHO', '6');
    const r1 = await rascunho([{ produtoId: p, quantidade: '12', precoCompra: '15' }], {
      dataRecebimento: '2026-11-02',
    });
    expect((await movimentar(r1.id, { atualizarPrecoCusto: false })).status).toBe(200);
    const depoisDaPrimeira = [
      {
        fornecedor_id: fornecedor,
        codigo_fornecedor: null,
        unidade_compra: 'UN',
        fator: '1.000',
        ultimo_custo: '15.0000',
        ultima_compra_em: '2026-11-02',
        principal: true,
      },
    ];
    expect(await vinculos(p)).toEqual(depoisDaPrimeira);
    // A nota de outubro lançada só agora: o vínculo fica com o custo, a embalagem e a data da compra de novembro.
    const r2 = await rascunho(
      [{ produtoId: p, codigoBarrasId: cx, fator: '6', quantidade: '2', precoCompra: '72' }],
      { dataRecebimento: '2026-10-01' },
    );
    expect((await movimentar(r2.id, { atualizarPrecoCusto: false })).status).toBe(200);
    expect(await vinculos(p)).toEqual(depoisDaPrimeira);
    // A compra de data igual ou mais nova troca o último custo e a embalagem do vínculo sem código.
    const r3 = await rascunho(
      [{ produtoId: p, codigoBarrasId: cx, fator: '6', quantidade: '2', precoCompra: '84' }],
      { dataRecebimento: '2026-11-02' },
    );
    expect((await movimentar(r3.id, { atualizarPrecoCusto: false })).status).toBe(200);
    expect(await vinculos(p)).toEqual([
      { ...depoisDaPrimeira[0], unidade_compra: 'FD', fator: '6.000', ultimo_custo: '14.0000' },
    ]);
  });

  it('vínculo com código do fornecedor: último custo e última compra mudam, unidade e fator não', async () => {
    const p = await produto('Azeite extra virgem 500ml');
    const fd = await fardo(p, 'FD12-AZEITE');
    // O vínculo que a NF-e aprendeu do `cProd`, com a embalagem dela (caixa com 6).
    await consultar(
      emp.nomeBanco,
      `insert into produtos_fornecedores (produto_id, fornecedor_id, codigo_fornecedor, unidade_compra, fator, principal)
       values ($1, $2, 'AZ-500', 'CX', 6, true)`,
      [p, fornecedor],
    );
    const r = await rascunho([
      { produtoId: p, codigoBarrasId: fd, fator: '12', quantidade: '1', precoCompra: '300' },
    ]);
    const m = await movimentar(r.id, { atualizarPrecoCusto: false });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(await vinculos(p)).toEqual([
      {
        fornecedor_id: fornecedor,
        codigo_fornecedor: 'AZ-500',
        unidade_compra: 'CX',
        fator: '6.000',
        ultimo_custo: '25.0000',
        ultima_compra_em: '2026-11-01',
        principal: true,
      },
    ]);
    // Já havia vínculo: nenhum criado.
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'recebimentos' and registro_id = $1 and acao = 'movimentar'`,
      [r.id],
    );
    expect(aud!.descricao).not.toMatch(/vínculo/);
  });

  it('dois movimentar ao mesmo tempo: a trava do cabeçalho serializa e só um lança', async () => {
    const p = await produto('Amendoim torrado 150g');
    const r = await rascunho([{ produtoId: p, quantidade: '5', precoCompra: '3' }]);
    const respostas = await Promise.all([
      movimentar(r.id, { atualizarPrecoCusto: false }),
      movimentar(r.id, { atualizarPrecoCusto: false }),
    ]);
    expect(respostas.map((x) => x.status)).toEqual([200, 200]);
    expect(await movimentos(r.id)).toHaveLength(1);
    expect((await saldo(p))!.quantidade).toBe('5.000');
  });

  it('permissões: sem recebimentos.movimentar/estornar é 403; o rascunho vazio não movimenta', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja] });
    const vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
    const p = await produto('Gelo 5kg');
    const r = await rascunho([{ produtoId: p, quantidade: '1', precoCompra: '3' }]);
    expect((await movimentar(r.id, {}, vendedor)).status).toBe(403);
    expect((await estornar(r.id, 'x', vendedor)).status).toBe(403);
    const vazio = await rascunho([]);
    const m = await movimentar(vazio.id);
    expect(m.status).toBe(422);
    expect(m.body.mensagem).toMatch(/ao menos um item/);
  });

  it('o razão refaz as projeções idênticas (db:recalcular-saldos)', async () => {
    const { movimentos: n } = await conferirRazaoDoBanco(emp.nomeBanco);
    expect(n).toBeGreaterThan(0);
  });
});

describe('tela do recebimento (F2-B16; ERP 13.3; README da API › decisão 161)', () => {
  const dados = (query: string, token = tokenAdmin) =>
    amb.http().get(`/api/recebimentos/dados-produtos?${query}`).set(bearer(token));

  it('dados de compra: as embalagens de compra, o lote, o saldo e o custo médio no destino e a base do markup', async () => {
    const p = await produto('Cerveja puro malte long neck');
    const fd = await fardo(p, 'FD24-PURO', '24');
    // Embalagem só de venda: fora (não preenche o fator na compra).
    await consultar(
      emp.nomeBanco,
      `insert into produtos_codigos_barras (produto_id, codigo, tipo, fator, usa_venda, usa_compra)
       values ($1, 'CX6-PURO', 'interno', 6, true, false)`,
      [p],
    );
    await efetivarAcerto({
      tipoAjuste: 'entrada',
      dataContagem: agora(),
      itens: [{ produtoId: p, quantidade: '10', custoUnitario: '4' }],
    });
    const r = await dados(`produtoIds=${p}&estoqueId=${estoqueLoja}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      custoBaseMargem: 'preco_custo',
      compraAtualizaPrecoCusto: 'perguntar',
      podeAlterarPreco: true,
      produtos: [
        {
          produtoId: p,
          solicitaLotePdv: false,
          temLotes: false,
          embalagens: [
            {
              id: fd,
              codigo: 'FD24-PURO',
              descricao: 'Fardo',
              unidadeSigla: 'FD',
              fator: expect.any(String),
            },
          ],
          saldo: '10.000',
          custoMedio: '4.0000',
          precoVendaLoja: null,
        },
      ],
    });
    expect(Number(r.body.produtos[0].embalagens[0].fator)).toBe(24);
    // Sem `produtos.ver_custo` (o estoquista do seed), sem o custo médio; sem o estoque, sem o saldo.
    const semCusto = await dados(`produtoIds=${p}&estoqueId=${estoqueLoja}`, tokenEstoquista);
    expect(semCusto.status, JSON.stringify(semCusto.body)).toBe(200);
    expect(semCusto.body.produtos[0]).toMatchObject({ saldo: '10.000', custoMedio: null });
    expect((await dados(`produtoIds=${p}`)).body.produtos[0]).toMatchObject({
      saldo: null,
      custoMedio: null,
    });
    // Estoque fora dos visíveis do estoquista: sem o saldo (não revela o saldo de outro estoque).
    const [{ id: outro }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo) values ('CD de teste', 'deposito') returning id",
    )) as [{ id: string }];
    expect(
      (await dados(`produtoIds=${p}&estoqueId=${outro}`, tokenEstoquista)).body.produtos[0],
    ).toMatchObject({ saldo: null });
    // O lote ativo cadastrado sem estoque mostra as colunas de lote; a chave da base do markup é lida.
    await consultar(emp.nomeBanco, `insert into produtos_lotes (produto_id, lote) values ($1, 'L-PURO')`, [
      p,
    ]);
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'produtos.custo_base_margem', '"custo_medio"')`,
    );
    const comLote = await dados(`produtoIds=${p}&estoqueId=${estoqueLoja}`);
    expect(comLote.body.custoBaseMargem).toBe('custo_medio');
    expect(comLote.body.produtos[0].temLotes).toBe(true);
    await consultar(emp.nomeBanco, `delete from configuracoes where chave = 'produtos.custo_base_margem'`);
    // O preço próprio da loja destinatária (o "preço atual" da proposta e da pergunta); a loja que segue o geral, nulo.
    expect((await dados(`produtoIds=${p}&lojaId=${loja}`)).body.produtos[0].precoVendaLoja).toBeNull();
    await consultar(
      emp.nomeBanco,
      `insert into produtos_lojas (produto_id, loja_id, preco_venda) values ($1, $2, '8.5000')`,
      [p, loja],
    );
    expect((await dados(`produtoIds=${p}&lojaId=${loja}`)).body.produtos[0].precoVendaLoja).toBe('8.5000');
    expect((await dados(`produtoIds=${p}`)).body.produtos[0].precoVendaLoja).toBeNull();
    // Lista vazia ou id inválido: 422.
    expect((await dados('produtoIds=')).status).toBe(422);
    expect((await dados('produtoIds=abc')).status).toBe(422);
  });

  it('o markup gravado no item só com "Produtos: Ver custo": com o preço, revelaria a base (o custo médio)', async () => {
    const p = await produto('Água mineral 500ml');
    const r = await rascunho([
      { produtoId: p, quantidade: '12', precoCompra: '1,00', precoVenda: '1,30', markupPct: '30' },
    ]);
    const ver = (token: string) => amb.http().get(`/api/recebimentos/${r.id}`).set(bearer(token));
    expect((await ver(tokenAdmin)).body.itens[0]).toMatchObject({
      markupPct: '30.0000',
      precoVenda: '1.3000',
    });
    const semCusto = await ver(tokenEstoquista);
    expect(semCusto.status, JSON.stringify(semCusto.body)).toBe(200);
    expect(semCusto.body.itens[0]).toMatchObject({ markupPct: null, precoVenda: '1.3000' });
  });

  it('critério de pronto: produto novo pelo cadastro rápido, o fardo pelo EAN, movimentar e o saldo e o preço no PDV', async () => {
    const inicioCatalogo = await puxar(ponto, 'catalogo', 0);
    const inicioEstoque = await puxar(ponto, 'estoque', 0);
    // O fardo de um produto que já existe: a tela acha a embalagem pelo código lido.
    const antigo = await produto('Cerveja lager lata 350ml');
    await fardo(antigo, '17891000001230', '12');
    // O corpo do cadastro rápido de produto pela mesma função do modal (`corpoProdutoRapido` do shared, que o
    // `CadastroRapidoProduto` usa): Simples, sem tributação (nada fiscal na Fase 2).
    const novo = await amb
      .http()
      .post('/api/produtos')
      .set(bearer())
      .send(
        corpoProdutoRapido({
          nome: 'CERV NOVA LATA 350ML',
          ean: '7891000001233',
          unidadeId: un,
          unidadePermiteFracao: false,
          ncm: '22030000',
          marcaId: null,
          categoriaId: null,
          precoVenda: '4,99',
        }),
      );
    expect(novo.status, JSON.stringify(novo.body)).toBe(201);
    expect(novo.body).toMatchObject({ tipo: 'simples', controlaEstoque: true, cfopVendaEstado: null });
    const d = await dados(`produtoIds=${antigo},${novo.body.id}&estoqueId=${estoqueLoja}`);
    const embalagem = (
      d.body.produtos as Array<{
        produtoId: string;
        embalagens: Array<{ id: string; codigo: string; fator: string }>;
      }>
    )
      .find((x) => x.produtoId === antigo)!
      .embalagens.find((e) => e.codigo === '17891000001230')!;
    expect(Number(embalagem.fator)).toBe(12);
    // O markup de 50% digitado no fardo: o preço sai das mesmas contas do shared que a grade usa (o rateio do frete
    // pelo valor dos dois itens, o custo final, a base de `produtos.custo_base_margem` e o markup ⇄ preço).
    const contas = contasEntradaRecebimentoTexto(
      [
        { quantidade: '10', fator: embalagem.fator, precoCompra: '60' },
        { quantidade: '24', fator: '1', precoCompra: '3' },
      ],
      { valorFrete: '12', valorDesconto: '0', valorOutrasDespesas: '0' },
    );
    const base = baseMarkupRecebimentoTexto({
      base: d.body.custoBaseMargem,
      compraAtualizaPrecoCusto: d.body.compraAtualizaPrecoCusto,
      custoFinal: contas[0]!.custoUnitarioFinal,
      quantidadeEstoque: '120',
      precoCusto: '4.0000',
      saldo: null,
      custoMedio: null,
    });
    const pm = markupPrecoRecebimento(base, { precoVenda: null, markup: '50' });
    expect(pm).toEqual({ precoVenda: '7.63', markupPct: '50.0000' });
    const r = await rascunho(
      [
        {
          produtoId: antigo,
          codigoBarrasId: embalagem.id,
          fator: embalagem.fator,
          quantidade: '10',
          precoCompra: '60,00',
          precoVenda: pm.precoVenda,
          markupPct: pm.markupPct,
          atualizarPreco: 'geral',
        },
        {
          produtoId: novo.body.id,
          quantidade: '24',
          precoCompra: '3,00',
          precoVenda: '4,99',
          atualizarPreco: 'nao',
        },
      ],
      { valorFrete: '12,00', codigoRemessa: 'SEM NOTA 1' },
    );
    const m = await movimentar(r.id, { versao: r.versao, atualizarPrecoCusto: true });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect((await saldo(antigo))!.quantidade).toBe('120.000');
    expect((await saldo(novo.body.id))!.quantidade).toBe('24.000');
    expect(await cadastro(antigo)).toMatchObject({ preco_venda: decTexto(pm.precoVenda!, 4) });
    // O saldo e o preço chegam ao PDV de teste (fluxos `estoque` e `catalogo`).
    const estoque = await puxar(ponto, 'estoque', inicioEstoque.cursor);
    const saldoNoPdv = (produtoId: string) =>
      estoque.alteracoes
        .filter((a) => a.tabela === 'saldos_estoque' && a.linha.produto_id === produtoId)
        .at(-1);
    expect(Number(saldoNoPdv(antigo)!.linha.quantidade)).toBe(120);
    expect(Number(saldoNoPdv(novo.body.id)!.linha.quantidade)).toBe(24);
    const catalogo = await puxar(ponto, 'catalogo', inicioCatalogo.cursor);
    const noPdv = (produtoId: string) =>
      catalogo.alteracoes.filter((a) => a.tabela === 'produtos' && a.linha.id === produtoId).at(-1);
    expect(Number(noPdv(antigo)!.linha.preco_venda)).toBe(7.63);
    expect(noPdv(novo.body.id)!.linha.nome).toBe('CERV NOVA LATA 350ML');
    const { movimentos: n } = await conferirRazaoDoBanco(emp.nomeBanco);
    expect(n).toBeGreaterThan(0);
  });
});
