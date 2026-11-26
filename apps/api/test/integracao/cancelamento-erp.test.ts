/**
 * Cancelar pelo ERP a venda do caixa (Fase 3, F3-B11; ERP 15.4.3; SYNC 10.4, 16.3; D112, D113), pelo push real das
 * vendas e pela rota do ERP: a venda de sessão fechada (o estoque volta ao custo da saída, os pagamentos ficam
 * estornados, a forma de devolução fica na auditoria e a projeção `vendas_status_pdv` desce ao caixa de origem); a
 * sessão aberta (D112) e o cancelamento pendente no caixa bloqueados; o terminal offline com eventos pendentes avisa e
 * exige a confirmação, e o `venda.cancelada` do caixa que chega depois vira `CANCELAMENTO_DUPLO` com o físico aplicado;
 * o "Definir" efetivado com a contagem logo depois do cancelamento gera a compensação; já cancelada é 409; a venda com
 * troca e a com documento fiscal bloqueadas; as permissões (403) e a loja não permitida. No fim, o razão e o
 * `recalcular-saldos` idênticos. Cada teste usa um caixa e um terminal só seus (`novoPonto`) e produtos próprios.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONTRATOS_EVENTOS,
  jcs,
  respostaPullSchema,
  respostaPushSchema,
  VERSAO_PDV_LE_STATUS_VENDA,
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
import { conferirRazaoDasEmpresas } from './razao.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const fixture = (nome: string) => JSON.parse(readFileSync(new URL(nome, FIXTURES), 'utf8')) as unknown;
const ATIVAR = fixture('ativar.requisicao.json') as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let loja2: string;
let estoqueLoja: string;
let tokenAdmin: string;
let operador: string;
let dinheiro: string;
let un: string;

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const bearer = (token = tokenAdmin) => ({ Authorization: `Bearer ${token}` });
const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const MOTIVO = 'Venda registrada com erro no caixa';

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
        dia_operacional: '2026-11-25',
        aberta_em: horasAtras(5),
        fundo_troco: '0.00',
      },
      movimentos_caixa: [],
    }),
  ]);
  expect(aberto, JSON.stringify(aberto)).toMatchObject({ status: 'aplicado' });
  await terminalEmDia(p);
  return p;
}

/** O último heartbeat do terminal: online, sem pendências e na versão que lê a projeção (salvo o que `extra` muda). */
async function terminalEmDia(
  p: Ponto,
  extra: {
    minutosSemContato?: number;
    eventosPendentes?: number;
    versao?: string;
    pendentes?: string[];
  } = {},
) {
  await consultar(
    emp.nomeBanco,
    `update terminais
        set ultimo_contato_em = now() - make_interval(mins => $2), eventos_pendentes = $3, versao_app = $4,
            vendas_cancelamento_pendente = $5::uuid[]
      where id = $1`,
    [
      p.terminal,
      extra.minutosSemContato ?? 0,
      extra.eventosPendentes ?? 0,
      extra.versao ?? VERSAO_PDV_LE_STATUS_VENDA,
      `{${(extra.pendentes ?? []).join(',')}}`,
    ],
  );
}

/** O caixa fechou a sessão (a nuvem já tem o fechamento). */
const fecharSessao = (p: Ponto) =>
  consultar(emp.nomeBanco, "update sessoes_caixa set status = 'fechada', fechada_em = now() where id = $1", [
    p.sessao,
  ]);

const linhaDoPonto = (p: Ponto) => ({
  loja_id: p.loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

/** Envelope com o agregado do contrato (C4); as dependências a nuvem recalcula do payload (SYNC 8.5). */
function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload) {
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
  };
}

type Resultado = { status: string; erro?: { codigo: string }; resultado?: Record<string, unknown> };

async function pushOk(p: Ponto, eventos: unknown[]): Promise<Resultado[]> {
  const r = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: uuidv7(), terminal_id: p.terminal, enviado_em: agora(), eventos });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Resultado[];
}

/** Uma venda finalizada só com o que o contrato exige (C4), paga em dinheiro. */
function venda(p: Ponto, itens: Array<{ produto: string; quantidade: string; preco?: string }>) {
  const id = uuidv7();
  const numero = ++p.venda;
  const finalizada = horasAtras(1);
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
    };
  });
  const total = (linhas.reduce((s, l) => s + Math.round(Number(l.valor_liquido) * 100), 0) / 100).toFixed(2);
  return {
    vendas: {
      id,
      numero,
      numero_exibicao: `L01-C${String(p.numero).padStart(2, '0')}-${String(numero).padStart(6, '0')}`,
      ...linhaDoPonto(p),
      sessao_caixa_id: p.sessao,
      tipo: 'pdv',
      status: 'finalizada',
      dia_operacional: '2026-11-25',
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
        descricao_forma: 'dinheiro',
        meio_pagamento_fiscal: '01',
        tipo_forma: 'dinheiro',
        valor: total,
        lanca_quitada: true,
      },
    ],
    cobrancas_pix: [] as Payload[],
    vasilhames: [] as Payload[],
  };
}

type Venda = ReturnType<typeof venda>;

/** Forma A (SYNC 9.9 A) da venda `v` no caixa: devolvida em dinheiro, com o `estorno_venda` do total na gaveta. */
function cancelamentoDoCaixa(p: Ponto, v: Venda) {
  const canceladaEm = agora();
  return {
    vendas: {
      id: v.vendas.id,
      status: 'cancelada',
      cancelada_em: canceladaEm,
      cancelada_por_id: operador,
      cancelamento_autorizado_por_id: operador,
      motivo_cancelamento: 'Cliente desistiu da compra depois de pagar',
      cancelamento_origem: 'pdv',
    },
    sessao_caixa_cancelamento_id: p.sessao,
    pagamentos_venda: v.pagamentos_venda.map((pg) => ({
      id: pg.id,
      status: 'estornado',
      estorno: 'dinheiro_devolvido',
    })),
    movimentos_caixa: [
      {
        id: uuidv7(),
        sessao_caixa_id: p.sessao,
        ...linhaDoPonto(p),
        tipo: 'estorno_venda',
        forma_pagamento_id: dinheiro,
        valor: v.vendas.total,
        operador_id: operador,
        quem_retira_usuario_id: null,
        quem_retira_nome: null,
        observacao: `Estorno da venda ${v.vendas.numero_exibicao}`,
        inf_adicionais: null,
        ocorrido_em: canceladaEm,
        autorizado_por_id: operador,
        troca_id: null,
      },
    ],
    transacoes_tef: [] as Payload[],
  };
}

async function criarProduto(nome: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ unidadeId: un, precoVenda: '5', precoCusto: '2', nome });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
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

/** Saldo por um acerto de Entrada efetivado (lança no momento da efetivação, regra de data do F2-B4). */
async function entrada(produto: string, quantidade: string, custo: string) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId: estoqueLoja,
      tipoAjuste: 'entrada',
      dataContagem: horasAtras(3),
      motivo: 'Saldo inicial',
      itens: [{ produtoId: produto, quantidade, custoUnitario: custo }],
    });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  await efetivar(a.body.id as string);
}

async function linhaSaldo(produto: string) {
  const [s] = await consultar<{ quantidade: string; custo_medio: string }>(
    emp.nomeBanco,
    `select s.quantidade::text, s.custo_medio::text from saldos_estoque s
       join tipos_estoque t on t.id = s.tipo_estoque_id and t.padrao
      where s.estoque_id = $1 and s.produto_id = $2`,
    [estoqueLoja, produto],
  );
  return s ?? { quantidade: '0.000', custo_medio: '0.0000' };
}
const saldo = async (produto: string) => Number((await linhaSaldo(produto)).quantidade);

const movimentosDaVenda = (vendaId: string) =>
  consultar<{
    id: string;
    tipo_movimento: string;
    quantidade: string;
    custo_unitario: string;
    estorno_de_id: string | null;
    terminal_id: string | null;
    evento_id: string | null;
    usuario_id: string | null;
  }>(
    emp.nomeBanco,
    `select id, tipo_movimento, quantidade::text, custo_unitario::text, estorno_de_id, terminal_id, evento_id,
            usuario_id
       from movimentos_estoque where documento_tipo = 'venda' and documento_id = $1 order by seq_lancamento`,
    [vendaId],
  );

const vendaGravada = async (id: string) =>
  (
    await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select status, cancelada_por_id, cancelamento_autorizado_por_id, motivo_cancelamento, cancelamento_origem,
              cancelada_em
         from vendas where id = $1`,
      [id],
    )
  )[0]!;

/** Vende `quantidade` de um produto novo com 20 de saldo a R$ 2 no ponto `p` (a venda aplicada pelo push real). */
async function vendaAplicada(p: Ponto, nome: string, quantidade = '3.000') {
  const produto = await criarProduto(nome);
  await entrada(produto, '20', '2');
  const v = venda(p, [{ produto, quantidade }]);
  const [r] = await pushOk(p, [evento(p, 'venda.finalizada', v)]);
  expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
  return { produto, v };
}

const previa = (vendaId: string, token = tokenAdmin) =>
  amb.http().get(`/api/vendas/${vendaId}/cancelamento`).set(bearer(token));
const cancelar = (vendaId: string, corpo: Payload, token = tokenAdmin) =>
  amb
    .http()
    .post(`/api/vendas/${vendaId}/cancelar`)
    .set(bearer(token))
    .send({ motivo: MOTIVO, ...corpo });

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
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
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('cancelar venda pelo ERP (F3-B11)', () => {
  it('sessão fechada: estoque ao custo original, pagamento estornado, forma na auditoria e a projeção desce ao caixa', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV CANCELA ERP B11');
    // Depois da venda o custo médio muda (entrada mais cara): o estorno volta ao custo da saída, não ao de agora.
    await entrada(produto, '10', '5');
    expect(await linhaSaldo(produto)).toEqual({ quantidade: '27.000', custo_medio: '3.1111' });
    await fecharSessao(p);

    const pr = await previa(v.vendas.id);
    expect(pr.status, JSON.stringify(pr.body)).toBe(200);
    expect(pr.body).toEqual({
      podeCancelar: true,
      bloqueio: null,
      exigeFormaDevolucao: true,
      formasDevolucao: ['dinheiro_cofre', 'estorno_cartao', 'estorno_pix'],
      devolveVazios: true,
      avisos: [],
    });
    // A venda de caixa fechado pede a forma de devolução (D113); o vale só com os vales (F3-B50); o motivo de 15 a 255.
    const semForma = await cancelar(v.vendas.id, {});
    expect(semForma.status).toBe(422);
    expect(semForma.body.campos).toHaveProperty('formaDevolucao');
    expect((await cancelar(v.vendas.id, { formaDevolucao: 'vale' })).status).toBe(422);
    expect((await cancelar(v.vendas.id, { motivo: 'curto', formaDevolucao: 'dinheiro_cofre' })).status).toBe(
      422,
    );
    expect((await vendaGravada(v.vendas.id)).status).toBe('finalizada');

    const r = await cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      status: 'cancelada',
      cancelamentoOrigem: 'erp',
      motivoCancelamento: MOTIVO,
      canceladaPorNome: expect.any(String),
      formaDevolucaoCancelamento: 'dinheiro_cofre',
      pagamentos: [{ status: 'estornado' }],
    });
    expect(await vendaGravada(v.vendas.id)).toMatchObject({
      status: 'cancelada',
      cancelada_por_id: operador,
      cancelamento_autorizado_por_id: null,
      motivo_cancelamento: MOTIVO,
      cancelamento_origem: 'erp',
    });
    const movs = await movimentosDaVenda(v.vendas.id);
    const saida = movs.find((m) => m.tipo_movimento === 'VENDA_PDV')!;
    expect(movs.filter((m) => m.tipo_movimento === 'CANC_VENDA_PDV')).toEqual([
      {
        id: expect.any(String),
        tipo_movimento: 'CANC_VENDA_PDV',
        quantidade: '3.000',
        custo_unitario: '2.0000',
        estorno_de_id: saida.id,
        terminal_id: null,
        evento_id: null,
        usuario_id: operador,
      },
    ]);
    // T20: com saldo positivo a média recalcula como entrada ao custo da saída: (27 × 3,1111 + 3 × 2) ÷ 30.
    expect(await linhaSaldo(produto)).toEqual({ quantidade: '30.000', custo_medio: '3.0000' });
    // Nada da gaveta: a sessão já fechou (o dinheiro sai do cofre, só registrado até a Fase 4).
    expect(
      await consultar(
        emp.nomeBanco,
        "select 1 from movimentos_caixa where tipo = 'estorno_venda' and terminal_id = $1",
        [p.terminal],
      ),
    ).toEqual([]);
    const [aud] = await consultar<{ origem: string; loja_id: string; depois: Payload; descricao: string }>(
      emp.nomeBanco,
      `select origem, loja_id, depois, descricao from auditoria
        where entidade = 'vendas' and registro_id = $1 and acao = 'cancelar'`,
      [v.vendas.id],
    );
    expect(aud).toMatchObject({ origem: 'erp', loja_id: loja });
    expect(aud!.descricao).toContain('devolução ao cliente: Dinheiro do cofre');
    expect(aud!.depois).toMatchObject({
      forma_devolucao: 'dinheiro_cofre',
      devolve_vazios: true,
      movimentos_estoque: 1,
      compensacoes: 0,
      avisos_confirmados: [],
      pendente_fase_4: {
        forma_devolucao: 'dinheiro_cofre',
        valor: v.vendas.total,
        pagamentos_estornados: [
          { pagamento_venda_id: v.pagamentos_venda[0]!.id, tipo_forma: 'dinheiro', valor: v.vendas.total },
        ],
      },
    });
    // A projeção (SYNC 16.3): gravada pela nuvem e entregue no fluxo `operacao` do caixa de origem.
    const [linha] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      'select caixa_id, terminal_id, status, cancelamento_origem from vendas_status_pdv where id = $1',
      [v.vendas.id],
    );
    expect(linha).toEqual({
      caixa_id: p.caixa,
      terminal_id: p.terminal,
      status: 'cancelada',
      cancelamento_origem: 'erp',
    });
    const pull = await amb
      .http()
      .get('/sync/pull?fluxo=operacao&desde=0&limite=500')
      .set(cabecalhos(p.token));
    expect(pull.status, JSON.stringify(pull.body)).toBe(200);
    respostaPullSchema.parse(pull.body);
    const desceu = (pull.body.alteracoes as Array<{ tabela: string; linha: Payload }>).find(
      (a) => a.tabela === 'vendas_status_pdv' && a.linha.id === v.vendas.id,
    );
    expect(desceu?.linha).toMatchObject({ status: 'cancelada', cancelamento_origem: 'erp' });

    // Já cancelada: 409, nada muda.
    const de = await cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre' });
    expect(de.status).toBe(409);
    expect(de.body).toMatchObject({ codigo: 'CONFLITO', detalhes: { codigo: 'ja_cancelada' } });
    expect((await previa(v.vendas.id)).body).toMatchObject({
      podeCancelar: false,
      bloqueio: { codigo: 'ja_cancelada' },
    });
    expect(await saldo(produto)).toBe(30);
  });

  it('sessão ainda aberta: bloqueada com "cancele no caixa" (D112), nada muda', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV SESSAO ABERTA B11');
    const pr = await previa(v.vendas.id);
    expect(pr.body).toMatchObject({
      podeCancelar: false,
      bloqueio: { codigo: 'sessao_aberta', mensagem: expect.stringContaining('cancele no caixa') },
      exigeFormaDevolucao: false,
      avisos: [],
    });
    const r = await cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ codigo: 'REGRA_NEGOCIO', detalhes: { codigo: 'sessao_aberta' } });
    expect((await vendaGravada(v.vendas.id)).status).toBe('finalizada');
    expect(await saldo(produto)).toBe(17);
  });

  it('o caixa já cancelou e ainda não sincronizou (vendas_cancelamento_pendente): CANCELAMENTO_PENDENTE_NO_CAIXA', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV PENDENTE CAIXA B11');
    await fecharSessao(p);
    await terminalEmDia(p, { pendentes: [v.vendas.id] });
    expect((await previa(v.vendas.id)).body).toMatchObject({
      podeCancelar: false,
      bloqueio: { codigo: 'cancelamento_pendente_no_caixa', mensagem: expect.stringContaining('aguarde') },
    });
    const r = await cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre', confirmarAvisos: true });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ detalhes: { codigo: 'CANCELAMENTO_PENDENTE_NO_CAIXA' } });
    expect((await vendaGravada(v.vendas.id)).status).toBe('finalizada');
    expect(await saldo(produto)).toBe(17);
  });

  it('o venda.cancelada do caixa parado na nuvem (erro): CANCELAMENTO_PENDENTE_NO_CAIXA, com o terminal em dia', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV CANCELAMENTO NA FILA B11');
    // O caixa cancelou na sessão aberta (o dinheiro saiu da gaveta), mas o evento não aplicou: o estorno PIX num
    // pagamento em dinheiro é PAYLOAD_INVALIDO. O caixa tira o evento dos não confirmados (rejeitado) e o fechamento
    // aplica com o turno em erro (só o alerta): o terminal fica online e sem eventos pendentes.
    const cancelamento = cancelamentoDoCaixa(p, v);
    cancelamento.pagamentos_venda = cancelamento.pagamentos_venda.map((pg) => ({
      ...pg,
      estorno: 'pix_devolvido_api',
    }));
    const [c] = await pushOk(p, [evento(p, 'venda.cancelada', cancelamento)]);
    expect(c, JSON.stringify(c)).toMatchObject({ status: 'rejeitado', erro: { codigo: 'PAYLOAD_INVALIDO' } });
    await fecharSessao(p);
    await terminalEmDia(p);
    expect((await previa(v.vendas.id)).body).toMatchObject({
      podeCancelar: false,
      bloqueio: {
        codigo: 'cancelamento_pendente_no_caixa',
        mensagem: expect.stringContaining('parou na sincronização (com erro)'),
      },
      avisos: [],
    });
    const r = await cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre', confirmarAvisos: true });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ detalhes: { codigo: 'CANCELAMENTO_PENDENTE_NO_CAIXA' } });
    expect((await vendaGravada(v.vendas.id)).status).toBe('finalizada');
    expect(await saldo(produto)).toBe(17);
    // Descartado pelo suporte (a fila de decisão), o cancelamento do caixa deixa de contar: o ERP pode cancelar.
    await consultar(
      emp.nomeBanco,
      "update eventos_recebidos set status = 'descartado' where terminal_id = $1 and tipo = 'venda.cancelada'",
      [p.terminal],
    );
    expect((await previa(v.vendas.id)).body).toMatchObject({ podeCancelar: true, bloqueio: null });
  });

  it('terminal offline com eventos pendentes: confirma; o venda.cancelada do caixa depois é CANCELAMENTO_DUPLO', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV OFFLINE B11');
    await fecharSessao(p);
    await terminalEmDia(p, { minutosSemContato: 60, eventosPendentes: 2, versao: '0.13.0' });
    const pr = await previa(v.vendas.id);
    expect(pr.body).toMatchObject({
      podeCancelar: true,
      avisos: [
        {
          codigo: 'terminal_offline',
          mensagem: expect.stringContaining('está offline com 2 evento(s) pendente(s)'),
          exigeConfirmacao: true,
        },
        {
          codigo: 'versao_sem_status',
          mensagem: expect.stringContaining('PDV 0.13.0'),
          exigeConfirmacao: false,
        },
      ],
    });
    // Sem a confirmação: 409 com os avisos, nada gravado.
    const sem = await cancelar(v.vendas.id, { formaDevolucao: 'estorno_cartao' });
    expect(sem.status).toBe(409);
    expect(sem.body.detalhes).toMatchObject({ codigo: 'CONFIRMAR_AVISOS', avisos: expect.any(Array) });
    expect((await vendaGravada(v.vendas.id)).status).toBe('finalizada');
    const r = await cancelar(v.vendas.id, { formaDevolucao: 'estorno_cartao', confirmarAvisos: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await saldo(produto)).toBe(20);
    const [aud] = await consultar<{ depois: Payload }>(
      emp.nomeBanco,
      "select depois from auditoria where entidade = 'vendas' and registro_id = $1 and acao = 'cancelar'",
      [v.vendas.id],
    );
    expect(aud!.depois).toMatchObject({ avisos_confirmados: ['terminal_offline'] });

    // O caixa tinha cancelado antes de fechar e só agora sincroniza: o físico entra (a gaveta), o estoque não volta
    // de novo, e o alerta mostra os dois cancelamentos (SYNC 10.4).
    const [c] = await pushOk(p, [evento(p, 'venda.cancelada', cancelamentoDoCaixa(p, v))]);
    expect(c, JSON.stringify(c)).toMatchObject({
      status: 'aplicado',
      resultado: { cancelamento_duplo: true, movimentos_caixa: 1, alertas: ['CANCELAMENTO_DUPLO'] },
    });
    expect(await saldo(produto)).toBe(20);
    expect(
      (await movimentosDaVenda(v.vendas.id)).filter((m) => m.tipo_movimento === 'CANC_VENDA_PDV'),
    ).toHaveLength(1);
    const [alerta] = await consultar<{ dados: Payload }>(
      emp.nomeBanco,
      "select dados from alertas where tipo = 'CANCELAMENTO_DUPLO' and chave_deduplicacao = $1",
      [`cancelamento_duplo:${v.vendas.id}`],
    );
    expect(alerta!.dados).toMatchObject({
      erp: { motivo_cancelamento: MOTIVO },
      pdv: { movimentos_caixa: [{ forma_pagamento_id: dinheiro, valor: v.vendas.total }] },
    });
    expect(await vendaGravada(v.vendas.id)).toMatchObject({
      cancelamento_origem: 'erp',
      motivo_cancelamento: MOTIVO,
    });
  });

  it('"Definir" já efetivado com a contagem logo depois do cancelamento: o estorno ganha a compensação', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV DEFINIR B11');
    await fecharSessao(p);
    // A contagem informada um pouco no futuro (a folga do relógio, `dataContagemSchema`) já viu a prateleira com os 3
    // que o cancelamento devolve: o estorno anterior a ela é compensado e o saldo fica na contagem (SYNC 15.3).
    const def = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoqueLoja,
        tipoAjuste: 'definir',
        dataContagem: new Date(Date.now() + 3 * 60_000).toISOString(),
        motivo: 'Inventário',
        itens: [{ produtoId: produto, quantidade: '25' }],
      });
    expect(def.status, JSON.stringify(def.body)).toBe(201);
    await efetivar(def.body.id as string);
    expect(await saldo(produto)).toBe(25);
    const r = await cancelar(v.vendas.id, { formaDevolucao: 'estorno_pix' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await saldo(produto)).toBe(25);
    const [aud] = await consultar<{ depois: Payload }>(
      emp.nomeBanco,
      "select depois from auditoria where entidade = 'vendas' and registro_id = $1 and acao = 'cancelar'",
      [v.vendas.id],
    );
    expect(aud!.depois).toMatchObject({ movimentos_estoque: 1, compensacoes: 1 });
  });

  it('venda com troca: "cancele a troca primeiro"; com documento fiscal: fica para a fase fiscal', async () => {
    const p = await novoPonto();
    const trocada = await vendaAplicada(p, 'CERV TROCADA B11');
    const fiscal = await vendaAplicada(p, 'CERV FISCAL B11');
    await fecharSessao(p);
    // A troca (F3-B43) ainda não existe: o devolvido é posto à mão, a única coluna que muda no item finalizado.
    await consultar(emp.nomeBanco, "update itens_venda set quantidade_devolvida = '1.000' where id = $1", [
      trocada.v.itens_venda[0]!.id,
    ]);
    const r = await cancelar(trocada.v.vendas.id, { formaDevolucao: 'dinheiro_cofre' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      detalhes: { codigo: 'com_troca' },
      mensagem: expect.stringContaining('cancele a troca primeiro'),
    });
    await consultar(emp.nomeBanco, "update vendas set status_fiscal = 'autorizada' where id = $1", [
      fiscal.v.vendas.id,
    ]);
    const f = await cancelar(fiscal.v.vendas.id, { formaDevolucao: 'dinheiro_cofre' });
    expect(f.status).toBe(422);
    expect(f.body).toMatchObject({ detalhes: { codigo: 'documento_fiscal' } });
    expect([await saldo(trocada.produto), await saldo(fiscal.produto)]).toEqual([17, 17]);
    expect(
      await consultar(emp.nomeBanco, 'select 1 from vendas_status_pdv where id = any($1::uuid[])', [
        [trocada.v.vendas.id, fiscal.v.vendas.id],
      ]),
    ).toEqual([]);
  });

  it('dois cancelamentos ao mesmo tempo: um grava, o outro é 409; o estoque volta uma vez só', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV CORRIDA B11');
    await fecharSessao(p);
    const respostas = await Promise.all([
      cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre' }),
      cancelar(v.vendas.id, { formaDevolucao: 'estorno_pix' }),
    ]);
    expect(respostas.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await saldo(produto)).toBe(20);
    expect(
      (await movimentosDaVenda(v.vendas.id)).filter((m) => m.tipo_movimento === 'CANC_VENDA_PDV'),
    ).toHaveLength(1);
  });

  it('com vendas.cancelar e sem vendas.ver: a prévia responde, a gravação (que devolve o detalhe) é 403', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV SO CANCELA B11');
    await fecharSessao(p);
    const [perfil] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome, descricao, chave_sistema) values ('Só cancela venda', 'teste', 'teste_so_cancela') returning id",
    );
    await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
      perfil!.id,
      'vendas.cancelar',
    ]);
    await criarUsuario(emp.nomeBanco, { login: 'socancelab11', perfil: 'teste_so_cancela', lojas: [loja] });
    const token = await amb.entrar(emp.codigo, 'socancelab11', SENHA_TESTE);
    expect((await previa(v.vendas.id, token)).body).toMatchObject({ podeCancelar: true });
    const r = await cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre' }, token);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body).not.toHaveProperty('itens');
    expect((await vendaGravada(v.vendas.id)).status).toBe('finalizada');
    expect(await saldo(produto)).toBe(17);
  });

  it('sem vendas.cancelar é 403; loja fora das permitidas é 403; venda inexistente é 404', async () => {
    const p = await novoPonto();
    const { produto, v } = await vendaAplicada(p, 'CERV PERMISSAO B11');
    await fecharSessao(p);
    await criarUsuario(emp.nomeBanco, { login: 'vendedorb11', perfil: 'vendedor', lojas: [loja] });
    await criarUsuario(emp.nomeBanco, { login: 'gerenteb11', perfil: 'gerente', lojas: [loja2] });
    const tokenVendedor = await amb.entrar(emp.codigo, 'vendedorb11', SENHA_TESTE);
    const tokenGerente2 = await amb.entrar(emp.codigo, 'gerenteb11', SENHA_TESTE);
    expect((await previa(v.vendas.id, tokenVendedor)).status).toBe(403);
    expect((await cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre' }, tokenVendedor)).status).toBe(
      403,
    );
    expect((await previa(v.vendas.id, tokenGerente2)).status).toBe(403);
    const fora = await cancelar(v.vendas.id, { formaDevolucao: 'dinheiro_cofre' }, tokenGerente2);
    expect(fora.status, JSON.stringify(fora.body)).toBe(403);
    expect((await previa(uuidv7())).status).toBe(404);
    expect((await cancelar(uuidv7(), { formaDevolucao: 'dinheiro_cofre' })).status).toBe(404);
    expect((await vendaGravada(v.vendas.id)).status).toBe('finalizada');
    expect(await saldo(produto)).toBe(17);
  });
});

describe('ordem de lançamento do razão (F2-B2)', () => {
  it('no fim da suíte, a cadeia de cada linha fecha por seq_lancamento e o replay repete o razão', async () => {
    expect(await conferirRazaoDasEmpresas(amb.bancoControle)).toBeGreaterThan(0);
  });
});
