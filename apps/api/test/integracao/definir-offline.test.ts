/**
 * Definição de pronto da Fase 2, "Inventário (Definir) feito enquanto o PDV da loja vendia offline" (F2-B4; ERP
 * 13.1.5; SYNC 15.3; README da API › decisão 148): o caixa 1 vende 3 antes da hora da contagem e o caixa 2 vende 2
 * depois dela, e as vendas chegam em três ordens — todas antes de efetivar, as anteriores depois de efetivar, as
 * posteriores depois de efetivar. Nas três o saldo final é a contagem menos as vendas posteriores, o estorno do
 * "Definir" desfaz as compensações (as vendas passam a valer) e o razão refaz a projeção idêntica
 * (`db:recalcular-saldos`, `conferirRazaoDoBanco`) depois de cada caso. Também: o "Definir" de contagem anterior a
 * outro já efetivado é anulado pelo mais novo (compensação no motor) e o estorno de qualquer um dos dois deixa valer o
 * que sobra, inclusive com uma venda tardia anterior às duas contagens (compensada de novo contra a anterior); o
 * estorno confere o saldo negativo pelo líquido de cada linha (o usuário sem o negativo estorna o "Definir" anulado);
 * a Entrada lançada antes de um "Definir" com a contagem um pouco à frente é anulada por ele; a Entrada com a "Data"
 * no passado lança no momento da efetivação (regra de data dos documentos do ERP). O detalhe do acerto mostra as
 * compensações (F2-B10; README da API › decisão 155): cada venda tardia com o terminal, a hora do fato, o documento e o
 * relógio do caixa (destacada com o relógio suspeito), o estorno que a desfez e, no "Definir" anulado, a recebida; o
 * relógio reavaliado no evento (a regressão contra o evento anterior do mesmo caixa, a marcada, antes da ativação, no
 * futuro, e o desvio de 10 min com a hora confiável sem destaque), a chegada da venda de uma lacuna recuperada (a do
 * lote, não a da declaração) e a compensação que substitui a estornada quando outro "Definir" também contou o fato.
 * Cada teste usa produtos e caixas próprios: roda sozinho (`-t`) e em qualquer ordem.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONTRATOS_EVENTOS,
  jcs,
  respostaPushSchema,
  type AcertoDetalhe,
  type Ativar,
  type ConferenciaAcerto,
  type ResultadoImportacao,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessaoErp } from '../../src/auth/auth.service.js';
import type { LinhaProduto } from '../../src/importacao/produtos.js';
import type { ContextoEmpresa } from '../../src/tenancy/contexto.js';
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
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
/** A importação de planilha (F2-B11) grava o arquivo no armazenamento e roda em tarefa (S3 em memória e a fila). */
let s3: S3Falso | null = null;
let loja: string;
let estoqueLoja: string;
let tokenAdmin: string;
/** Sem Master e sem `estoque.permite_negativo_erp`: o estorno confere o saldo negativo. */
let tokenEstoquista: string;
let operador: string;
let dinheiro: string;
let un: string;
let contexto: ContextoEmpresa;

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const minutosAFrente = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

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

/** Um caixa com o terminal ativado pelo `/sync/ativar` real e a sessão aberta (como em `venda-eventos`). */
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

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

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

/** Envelope com o agregado do contrato (C4) e a sessão declarada como dependência, como o PDV declara (SYNC 8.5). */
function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload) {
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
  };
}

type Resultado = { status: string; erro?: { codigo: string }; resultado?: Record<string, unknown> };

async function pushOk(p: Ponto, eventos: unknown[], extra: Payload = {}): Promise<Resultado[]> {
  const r = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: uuidv7(), terminal_id: p.terminal, enviado_em: agora(), eventos, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Resultado[];
}

/** Uma venda finalizada de um item, paga em dinheiro, na hora do fato pedida. */
function venda(p: Ponto, produto: string, quantidade: string, finalizadaEm: string) {
  const id = uuidv7();
  const numero = ++p.venda;
  const total = (5 * Number(quantidade)).toFixed(2);
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
      iniciada_em: finalizadaEm,
      finalizada_em: finalizadaEm,
    },
    itens_venda: [
      {
        id: uuidv7(),
        venda_id: id,
        sequencia: 1,
        produto_id: produto,
        descricao: 'ITEM DE TESTE',
        unidade: 'UN',
        quantidade,
        preco_tabela: '5.0000',
        preco_unitario: '5.0000',
        valor_bruto: total,
        valor_liquido: total,
        incluido_em: finalizadaEm,
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

async function criarProduto(nome: string, codigoInterno?: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({
      nome,
      unidadeId: un,
      precoVenda: '5',
      precoCusto: '2',
      ...(codigoInterno ? { codigoInterno } : {}),
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** Rascunho de acerto de um item (contagem "Definir" por padrão), no estoque da loja ou no pedido. */
async function rascunho(
  produtoId: string,
  quantidade: string,
  dataContagem: string,
  tipoAjuste: 'definir' | 'entrada' | 'saida' = 'definir',
  estoqueId = estoqueLoja,
): Promise<string> {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId,
      tipoAjuste,
      dataContagem,
      motivo: 'Inventário',
      itens: [{ produtoId, quantidade, ...(tipoAjuste === 'entrada' ? { custoUnitario: '2' } : {}) }],
    });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  return a.body.id as string;
}

async function detalhe(id: string, tk = tokenAdmin): Promise<AcertoDetalhe> {
  const r = await amb.http().get(`/api/acertos/${id}`).set(bearer(tk));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as AcertoDetalhe;
}

async function efetivar(id: string) {
  const atual = await amb.http().get(`/api/acertos/${id}`).set(bearer());
  const r = await amb
    .http()
    .post(`/api/acertos/${id}/efetivar`)
    .set(bearer())
    .send({ versao: atual.body.versao });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { itens: Array<{ diferenca: string }> };
}

async function tentarEstornar(id: string, tk = tokenAdmin) {
  const atual = await amb.http().get(`/api/acertos/${id}`).set(bearer(tk));
  return amb
    .http()
    .post(`/api/acertos/${id}/estornar`)
    .set(bearer(tk))
    .send({ versao: atual.body.versao, motivo: 'Contagem refeita' });
}

async function estornar(id: string, tk = tokenAdmin) {
  const r = await tentarEstornar(id, tk);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** A descrição que a ação gravou na auditoria do acerto. */
async function auditoria(id: string, acao: 'efetivar' | 'estornar'): Promise<string> {
  const [a] = await consultar<{ descricao: string }>(
    emp.nomeBanco,
    `select descricao from auditoria where entidade = 'acertos_estoque' and registro_id = $1 and acao = $2`,
    [id, acao],
  );
  return a!.descricao;
}

/** Saldo inicial por um "Definir" há 3 h (a virada pela exportação do Nuvem3, F2-Q5): antes de todos os fatos. */
async function saldoInicial(produto: string, quantidade: string) {
  await efetivar(await rascunho(produto, quantidade, horasAtras(3)));
}

async function saldo(produto: string, estoqueId = estoqueLoja): Promise<number> {
  const [s] = await consultar<{ quantidade: string }>(
    emp.nomeBanco,
    `select s.quantidade::text from saldos_estoque s join tipos_estoque t on t.id = s.tipo_estoque_id and t.padrao
      where s.estoque_id = $1 and s.produto_id = $2`,
    [estoqueId, produto],
  );
  return s ? Number(s.quantidade) : 0;
}

const compensacoes = (produto: string) =>
  consultar<{ quantidade: string; documento_id: string; compensado: string; estornada: boolean }>(
    emp.nomeBanco,
    `select c.quantidade::text, c.documento_id, o.documento_tipo as compensado,
            exists (select 1 from movimentos_estoque e where e.estorno_de_id = c.id) as estornada
       from movimentos_estoque c join movimentos_estoque o on o.id = c.compensa_movimento_id
      where c.tipo_movimento = 'ACERTO_COMPENSACAO' and c.produto_id = $1
      order by c.quantidade`,
    [produto],
  );

/** O `db:recalcular-saldos` (e a conferência do razão do F2-B2) dá idêntico no banco inteiro. */
const recalcularIdentico = () => conferirRazaoDoBanco(emp.nomeBanco);

const naEmpresa = <T>(fn: () => Promise<T>) => amb.servicos.tenancy.executarNaEmpresa(contexto, fn);

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-definir-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  await amb.servicos.fila.iniciar();
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
  contexto = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

/**
 * Em que momento cada grupo de vendas chega à nuvem, em relação à efetivação do "Definir". O caixa 1 (offline) tem as
 * vendas anteriores à contagem; o caixa 2, as posteriores: cada caixa manda as próprias em ordem de sequência.
 */
const ORDENS = [
  { nome: 'todas antes de efetivar', anteriores: 'antes', posteriores: 'antes', compensadas: 0 },
  { nome: 'as anteriores depois de efetivar', anteriores: 'depois', posteriores: 'antes', compensadas: 2 },
  { nome: 'as posteriores depois de efetivar', anteriores: 'antes', posteriores: 'depois', compensadas: 0 },
] as const;

describe('Definição de pronto: "Definir" com o PDV vendendo offline (ERP 13.1.5; SYNC 15.3)', () => {
  for (const ordem of ORDENS) {
    it(`${ordem.nome}: saldo = contagem − vendas posteriores; o estorno desfaz as compensações; recalcular idêntico`, async () => {
      const prod = await criarProduto(`CERV DEFINIR OFFLINE ${ordem.nome.toUpperCase()}`);
      await saldoInicial(prod, '50');
      const caixa1 = await novoPonto();
      const caixa2 = await novoPonto();
      // 3 vendidas antes da contagem (há 1 h), em duas vendas; 2 depois dela.
      const anteriores = [
        evento(caixa1, 'venda.finalizada', venda(caixa1, prod, '2.000', horasAtras(2))),
        evento(caixa1, 'venda.finalizada', venda(caixa1, prod, '1.000', horasAtras(1.5))),
      ];
      const posteriores = [evento(caixa2, 'venda.finalizada', venda(caixa2, prod, '2.000', horasAtras(0.5)))];
      const enviar = async (quando: 'antes' | 'depois') => {
        if (ordem.anteriores === quando) {
          for (const r of await pushOk(caixa1, anteriores))
            expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
        }
        if (ordem.posteriores === quando) {
          for (const r of await pushOk(caixa2, posteriores))
            expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
        }
      };
      // A contagem física, há 1 h, achou 20 (a loja tinha 47 e a diferença é perda).
      const contagem = await rascunho(prod, '20', horasAtras(1));
      await enviar('antes');
      await efetivar(contagem);
      await enviar('depois');

      expect(await saldo(prod)).toBe(18);
      const geradas = await compensacoes(prod);
      expect(geradas).toHaveLength(ordem.compensadas);
      for (const c of geradas) expect(c).toMatchObject({ documento_id: contagem, compensado: 'venda' });
      await recalcularIdentico();

      // Sem a contagem: 50 da virada − 5 vendidas, que passam a valer.
      await estornar(contagem);
      expect(await saldo(prod)).toBe(45);
      expect((await compensacoes(prod)).every((c) => c.estornada)).toBe(true);
      await recalcularIdentico();
    });
  }
});

describe('compensação no motor e regra de data dos documentos do ERP (F2-B4)', () => {
  it('"Definir" de contagem anterior a outro já efetivado é anulado pelo mais novo; o estorno dele não mexe no saldo', async () => {
    const prod = await criarProduto('CERV DEFINIR ANTIGO ESTORNADO');
    await saldoInicial(prod, '50');
    await efetivar(await rascunho(prod, '20', horasAtras(1)));
    // A contagem de há 2 h, lançada só agora: diferença 30 − (20 − (−30)) = −20, anulada na data dela.
    const antiga = await rascunho(prod, '30', horasAtras(2));
    expect((await efetivar(antiga)).itens[0]).toMatchObject({ diferenca: '-20.000' });
    expect(await saldo(prod)).toBe(20);
    expect(await compensacoes(prod)).toEqual([
      expect.objectContaining({ quantidade: '20.000', compensado: 'acerto', estornada: false }),
    ]);
    await recalcularIdentico();
    // Estornar a antiga estorna o movimento dela e a compensação que o anulava: o saldo fica.
    await estornar(antiga);
    expect(await saldo(prod)).toBe(20);
    expect((await compensacoes(prod))[0]).toMatchObject({ estornada: true });
    await recalcularIdentico();
  });

  it('estornar o "Definir" mais novo deixa valer a contagem anterior; estornar os dois volta à virada', async () => {
    const prod = await criarProduto('CERV DEFINIR NOVO ESTORNADO');
    await saldoInicial(prod, '50');
    const nova = await rascunho(prod, '20', horasAtras(1));
    await efetivar(nova);
    const antiga = await rascunho(prod, '30', horasAtras(2));
    await efetivar(antiga);
    expect(await saldo(prod)).toBe(20);
    // Sem a contagem mais nova, a de há 2 h é a última: 30.
    await estornar(nova);
    expect(await saldo(prod)).toBe(30);
    await recalcularIdentico();
    // A compensação já foi estornada com a nova: a antiga só desfaz o próprio movimento.
    await estornar(antiga);
    expect(await saldo(prod)).toBe(50);
    await recalcularIdentico();
  });

  it('estorno do "Definir" antigo com diferença positiva, por quem não tem o negativo: confere o líquido da linha', async () => {
    const prod = await criarProduto('CERV DEFINIR ANTIGO POSITIVO');
    await saldoInicial(prod, '10');
    await efetivar(await rascunho(prod, '5', horasAtras(1)));
    // A contagem de há 2 h, lançada só agora: diferença 30 − (5 − (−5)) = +20, anulada (−20) pela mais nova.
    const antiga = await rascunho(prod, '30', horasAtras(2));
    expect((await efetivar(antiga)).itens[0]).toMatchObject({ diferenca: '20.000' });
    expect(await saldo(prod)).toBe(5);
    expect(await auditoria(antiga, 'efetivar')).toBe(
      'Acerto efetivado: 1 item(ns), 1 movimento(s), 1 anulado(s) por "Definir" já efetivado de contagem posterior',
    );
    // O estorno do movimento (−20) sozinho deixaria −15; com o da compensação (+20) o líquido é zero.
    await estornar(antiga, tokenEstoquista);
    expect(await saldo(prod)).toBe(5);
    expect((await compensacoes(prod)).every((c) => c.estornada)).toBe(true);
    await recalcularIdentico();
  });

  it('o estorno que deixa a linha negativa de verdade continua recusado para quem não tem o negativo', async () => {
    const prod = await criarProduto('CERV ESTORNO NEGATIVO DE VERDADE');
    const virada = await rascunho(prod, '10', horasAtras(3));
    await efetivar(virada);
    await efetivar(await rascunho(prod, '2', horasAtras(1)));
    // O estorno da virada (−10) sobre o saldo 2: −8.
    const r = await tentarEstornar(virada, tokenEstoquista);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.mensagem).toBe('O estorno deixaria saldo negativo em: CERV ESTORNO NEGATIVO DE VERDADE.');
    expect(await saldo(prod)).toBe(2);
  });

  for (const ordem of ['a nova efetivada antes', 'a antiga efetivada antes'] as const) {
    it(`venda tardia anterior às duas contagens (${ordem}): estornar a nova deixa valer a antiga por inteiro`, async () => {
      const prod = await criarProduto(`CERV VENDA ANTES DAS DUAS ${ordem.toUpperCase()}`);
      await saldoInicial(prod, '50');
      const caixa = await novoPonto();
      // A venda de há 2,5 h só chega depois das duas contagens (há 2 h achou 30; há 1 h, 20).
      const nova = await rascunho(prod, '20', horasAtras(1));
      const antiga = await rascunho(prod, '30', horasAtras(2));
      if (ordem === 'a nova efetivada antes') {
        await efetivar(nova);
        await efetivar(antiga);
      } else {
        await efetivar(antiga);
        await efetivar(nova);
      }
      const [r] = await pushOk(caixa, [
        evento(caixa, 'venda.finalizada', venda(caixa, prod, '5.000', horasAtras(2.5))),
      ]);
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
      expect(await saldo(prod)).toBe(20);
      await recalcularIdentico();

      // A contagem de há 2 h já tinha visto a venda: ela volta a ser compensada, agora contra a antiga.
      await estornar(nova, tokenEstoquista);
      expect(await saldo(prod)).toBe(30);
      const daVenda = (await compensacoes(prod)).filter((c) => c.compensado === 'venda');
      expect(daVenda).toHaveLength(2);
      expect(daVenda.filter((c) => !c.estornada)).toEqual([
        expect.objectContaining({ quantidade: '5.000', documento_id: antiga }),
      ]);
      expect(await auditoria(nova, 'estornar')).toMatch(
        /^Acerto estornado \(\d+ movimento\(s\), 1 compensado\(s\) de novo contra o "Definir" anterior\): /,
      );
      await recalcularIdentico();

      // Sem as duas contagens: 50 da virada − 5 vendidas.
      await estornar(antiga);
      expect(await saldo(prod)).toBe(45);
      expect((await compensacoes(prod)).every((c) => c.estornada)).toBe(true);
      await recalcularIdentico();
    });
  }

  it('Entrada lançada antes de um "Definir" com a contagem um pouco à frente é anulada por ele; o estorno líquido', async () => {
    const prod = await criarProduto('CERV ENTRADA ANTES DA CONTAGEM FUTURA');
    await saldoInicial(prod, '10');
    // A contagem informada para daqui a 4 min (dentro da folga de 5 min do criarAcertoSchema): diferença 0.
    const futura = await rascunho(prod, '10', minutosAFrente(4));
    expect((await efetivar(futura)).itens[0]).toMatchObject({ diferenca: '0.000' });
    const entrada = await rascunho(prod, '15', agora(), 'entrada');
    await efetivar(entrada);
    // A Entrada (agora) é anterior à contagem: a contagem vale, e a Entrada é anulada contra ela.
    expect(await saldo(prod)).toBe(10);
    expect(await compensacoes(prod)).toEqual([
      expect.objectContaining({
        quantidade: '-15.000',
        documento_id: futura,
        compensado: 'acerto',
        estornada: false,
      }),
    ]);
    await recalcularIdentico();
    // O estorno da Entrada (−15) sozinho deixaria −5; com o da compensação (+15), nada muda.
    await estornar(entrada, tokenEstoquista);
    expect(await saldo(prod)).toBe(10);
    expect((await compensacoes(prod))[0]).toMatchObject({ estornada: true });
    await recalcularIdentico();
    await estornar(futura);
    expect(await saldo(prod)).toBe(10);
    await recalcularIdentico();
  });

  it('Entrada com a "Data" no passado lança no momento da efetivação e conta como posterior à contagem', async () => {
    const prod = await criarProduto('CERV ENTRADA DATA DO CABECALHO');
    await saldoInicial(prod, '10');
    const contagem = await rascunho(prod, '10', horasAtras(1));
    // A nota chegou há 2 h, mas a Entrada só é lançada agora (depois da contagem, que não a viu).
    const entrada = await rascunho(prod, '6', horasAtras(2), 'entrada');
    const antes = Date.now();
    await efetivar(entrada);
    const [m] = await consultar<{ data_movimento: Date; data_contagem: Date }>(
      emp.nomeBanco,
      `select m.data_movimento, a.data_contagem from movimentos_estoque m join acertos_estoque a on a.id = m.documento_id
        where m.documento_id = $1`,
      [entrada],
    );
    expect(m!.data_movimento.getTime()).toBeGreaterThanOrEqual(antes - 1000);
    expect(Date.now() - m!.data_contagem.getTime()).toBeGreaterThan(3_600_000);
    // diferença = 10 − (16 − 6) = 0: a Entrada posterior à contagem não é desfeita.
    expect((await efetivar(contagem)).itens[0]).toMatchObject({ diferenca: '0.000' });
    expect(await saldo(prod)).toBe(16);
    await recalcularIdentico();
  });
});

describe('compensações visíveis no acerto (F2-B10; ERP 13.1.5 regra 4)', () => {
  it('o "Definir" com vendas tardias mostra cada compensação, com o terminal, a hora e o relógio; o estorno a fecha', async () => {
    const prod = await criarProduto('CERV COMPENSACOES VISIVEIS');
    await saldoInicial(prod, '50');
    const caixa1 = await novoPonto();
    const caixa2 = await novoPonto();
    // O cenário do F2-B4 ("as anteriores depois de efetivar"): o caixa 1 vendeu 2 + 1 antes da contagem (há 1 h) e
    // só mandou depois da efetivação; a segunda venda saiu com o relógio sem hora confiável e 10 min de desvio.
    const fatos = [horasAtras(2), horasAtras(1.5)];
    const anteriores = [
      evento(caixa1, 'venda.finalizada', venda(caixa1, prod, '2.000', fatos[0]!)),
      {
        ...evento(caixa1, 'venda.finalizada', venda(caixa1, prod, '1.000', fatos[1]!)),
        relogio_confiavel: false,
        desvio_relogio_ms: 600_000,
      },
    ];
    const posterior = evento(caixa2, 'venda.finalizada', venda(caixa2, prod, '2.000', horasAtras(0.5)));
    for (const r of await pushOk(caixa2, [posterior]))
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    const contagem = await rascunho(prod, '20', horasAtras(1));
    expect(await detalhe(contagem)).toMatchObject({ compensacoes: [], totalCompensacoes: 0 });
    await efetivar(contagem);
    expect(await detalhe(contagem)).toMatchObject({ compensacoes: [], totalCompensacoes: 0 });
    const chegada = Date.now();
    for (const r of await pushOk(caixa1, anteriores))
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    expect(await saldo(prod)).toBe(18);

    const [{ codigo }] = (await consultar<{ codigo: number }>(
      emp.nomeBanco,
      'select codigo from acertos_estoque where id = $1',
      [contagem],
    )) as [{ codigo: number }];
    const d = await detalhe(contagem);
    expect(d.totalCompensacoes).toBe(2);
    // Na ordem da hora do fato: a venda de 2 (relógio certo) e a de 1 (destacada).
    expect(d.compensacoes).toEqual([
      expect.objectContaining({
        sentido: 'lancada',
        acertoId: contagem,
        acertoCodigo: codigo,
        produtoId: prod,
        produtoNome: 'CERV COMPENSACOES VISIVEIS',
        quantidade: '2.000',
        custoUnitario: '2.0000',
        dataFato: fatos[0],
        compensado: expect.objectContaining({
          tipoMovimento: 'VENDA_PDV',
          tipoMovimentoNome: 'Venda pelo PDV',
          quantidade: '-2.000',
          documentoTipo: 'venda',
          documento: `Venda L01-C${String(caixa1.numero).padStart(2, '0')}-000001`,
          terminalId: caixa1.terminal,
          terminal: `Caixa ${String(caixa1.numero).padStart(2, '0')} · PC do balcão`,
          eventoId: anteriores[0]!.evento_id,
          sequencia: anteriores[0]!.sequencia,
        }),
        relogio: { confiavel: true, desvioMs: null, motivos: [] },
        relogioSuspeito: false,
        estorno: null,
      }),
      expect.objectContaining({
        sentido: 'lancada',
        quantidade: '1.000',
        dataFato: fatos[1],
        compensado: expect.objectContaining({
          documento: `Venda L01-C${String(caixa1.numero).padStart(2, '0')}-000002`,
          eventoId: anteriores[1]!.evento_id,
        }),
        relogio: { confiavel: false, desvioMs: 600_000, motivos: ['nao_confiavel', 'desvio'] },
        relogioSuspeito: true,
        estorno: null,
      }),
    ]);
    for (const c of d.compensacoes) {
      // Lançada na chegada do evento tardio, recebido na mesma hora.
      expect(Date.parse(c.lancadaEm)).toBeGreaterThanOrEqual(chegada - 1000);
      expect(Date.parse(c.compensado.recebidoEm!)).toBeGreaterThanOrEqual(chegada - 1000);
    }

    // O estorno do "Definir" desfaz as compensações: cada uma mostra o ESTORNO_ACERTO, o acerto e o motivo.
    await estornar(contagem);
    const estornado = await detalhe(contagem);
    expect(estornado.compensacoes).toHaveLength(2);
    for (const c of estornado.compensacoes)
      expect(c.estorno).toMatchObject({
        acertoId: contagem,
        acertoCodigo: codigo,
        motivo: 'Contagem refeita',
        substituidaPor: null,
      });
    await recalcularIdentico();
  });

  it('o "Definir" anulado por outro mostra a recebida; o que anulou, a lançada contra o acerto', async () => {
    const prod = await criarProduto('CERV COMPENSACAO RECEBIDA');
    await saldoInicial(prod, '50');
    const nova = await rascunho(prod, '20', horasAtras(1));
    await efetivar(nova);
    const antiga = await rascunho(prod, '30', horasAtras(2));
    await efetivar(antiga);
    const codigos = new Map(
      (
        await consultar<{ id: string; codigo: number }>(
          emp.nomeBanco,
          'select id, codigo from acertos_estoque where id = any($1::uuid[])',
          [[nova, antiga]],
        )
      ).map((r) => [r.id, r.codigo]),
    );
    const daNova = (await detalhe(nova)).compensacoes;
    const daAntiga = (await detalhe(antiga)).compensacoes;
    expect(daNova).toEqual([
      expect.objectContaining({
        sentido: 'lancada',
        acertoId: nova,
        quantidade: '20.000',
        compensado: expect.objectContaining({
          tipoMovimento: 'ACERTO_DEFINIR',
          quantidade: '-20.000',
          documentoTipo: 'acerto',
          documentoId: antiga,
          documento: `Acerto Nº ${codigos.get(antiga)}`,
          terminalId: null,
          terminal: null,
          eventoId: null,
        }),
        relogio: null,
        relogioSuspeito: false,
      }),
    ]);
    // A mesma compensação, vista do "Definir" anulado.
    expect(daAntiga).toEqual([
      expect.objectContaining({ id: daNova[0]!.id, sentido: 'recebida', acertoCodigo: codigos.get(nova) }),
    ]);
    // O estorno da antiga estorna a compensação que a anulava: aparece nos dois detalhes.
    await estornar(antiga);
    expect((await detalhe(nova)).compensacoes[0]!.estorno).toMatchObject({
      acertoId: antiga,
      acertoCodigo: codigos.get(antiga),
    });
    expect((await detalhe(antiga)).compensacoes[0]!.estorno).toMatchObject({ acertoId: antiga });
    await recalcularIdentico();
  });

  it('o relógio é reavaliado no evento: regressão, regressão marcada, desvio corrigido, antes da ativação e futuro', async () => {
    const prod = await criarProduto('CERV COMPENSACAO RELOGIO');
    await saldoInicial(prod, '50');
    const caixa = await novoPonto();
    // Outro terminal com o relógio adiantado, recebido antes: o evento anterior é o do mesmo caixa, não o dele.
    const outro = await novoPonto();
    for (const r of await pushOk(outro, [
      {
        ...evento(outro, 'venda.finalizada', venda(outro, prod, '1.000', horasAtras(0.5))),
        ocorrido_em: minutosAFrente(4),
      },
    ]))
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    const contagem = await rascunho(prod, '20', horasAtras(1));
    await efetivar(contagem);
    const minutosAtras = (m: number) => minutosAFrente(-m);
    // As vendas anteriores à contagem (o payload) chegam depois da efetivação, cada uma com o envelope do caso.
    const vendas = [
      // 10 min antes da abertura do caixa (o evento anterior, nº 1), sem a marca: regressão, destacada.
      { ocorrido_em: minutosAtras(10) },
      // 10 min antes da anterior, com a marca do caixa: esperada (12.3), sem destaque.
      { ocorrido_em: minutosAtras(20), relogio_regrediu: true },
      // O Windows 10 min atrasado e a hora corrigida pela amostra confiável: nada a duvidar.
      { ocorrido_em: agora(), relogio_confiavel: true, desvio_relogio_ms: 600_000 },
      // 3 dias atrás, com o terminal ativado agora (− 1 dia): no passado, e anterior à venda anterior.
      { ocorrido_em: horasAtras(72) },
      // 10 min à frente da nuvem.
      { ocorrido_em: minutosAFrente(10) },
    ].map((envelope, i) => ({
      ...evento(caixa, 'venda.finalizada', venda(caixa, prod, '1.000', horasAtras(2.5 - i / 10))),
      ...envelope,
    }));
    for (const r of await pushOk(caixa, vendas))
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    const d = await detalhe(contagem);
    expect(
      d.compensacoes.map((c) => [c.compensado.sequencia, c.relogio?.motivos, c.relogioSuspeito]),
    ).toEqual([
      [2, ['regressao'], true],
      [3, ['regressao_marcada'], false],
      [4, [], false],
      [5, ['passado', 'regressao'], true],
      [6, ['futuro'], true],
    ]);
    expect(d.compensacoes.map((c) => c.compensado.terminalId)).toEqual(Array(5).fill(caixa.terminal));
    expect(d.compensacoes[2]!.relogio).toEqual({ confiavel: true, desvioMs: 600_000, motivos: [] });
  });

  it('a venda de uma lacuna recuperada (SYNC 8.6) chega na hora do lote, não na da declaração', async () => {
    const prod = await criarProduto('CERV COMPENSACAO LACUNA');
    await saldoInicial(prod, '50');
    const caixa = await novoPonto();
    const lacuna = { de: 2, ate: 2, autorizado_por_id: operador };
    await pushOk(caixa, [], {
      declarar_lacuna: { ...lacuna, motivo: 'banco_local_perdido', observacao: 'Banco do caixa trocado' },
    });
    // A declaração foi "na segunda": o placeholder fica com essa hora.
    await consultar(
      emp.nomeBanco,
      `update eventos_recebidos set criado_em = now() - interval '3 days'
        where terminal_id = $1 and sequencia_terminal = 2`,
      [caixa.terminal],
    );
    const contagem = await rascunho(prod, '20', horasAtras(1));
    await efetivar(contagem);
    // "Na quinta" o backup devolve a venda nº 2, anterior à contagem: substitui o placeholder e é compensada.
    const recuperada = evento(caixa, 'venda.finalizada', venda(caixa, prod, '2.000', horasAtras(2)));
    const chegada = Date.now();
    for (const r of await pushOk(caixa, [recuperada], { recuperar_lacuna: lacuna }))
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    const [c] = (await detalhe(contagem)).compensacoes;
    expect(c).toMatchObject({
      compensado: expect.objectContaining({ eventoId: recuperada.evento_id, sequencia: 2 }),
      relogio: { motivos: [] },
    });
    expect(Date.parse(c!.compensado.recebidoEm!)).toBeGreaterThanOrEqual(chegada - 1000);
    expect(Date.parse(c!.compensado.recebidoEm!)).toBeGreaterThanOrEqual(Date.parse(c!.lancadaEm) - 1000);
  });

  it('o estorno do "Definir" mais novo mostra a compensação que entrou no lugar, contra o anterior', async () => {
    const prod = await criarProduto('CERV COMPENSACAO SUBSTITUIDA');
    await saldoInicial(prod, '50');
    const caixa = await novoPonto();
    const antiga = await rascunho(prod, '30', horasAtras(1.5));
    await efetivar(antiga);
    const nova = await rascunho(prod, '20', horasAtras(1));
    await efetivar(nova);
    // A venda de antes das duas contagens chega depois: a mais nova a compensa.
    const tardia = evento(caixa, 'venda.finalizada', venda(caixa, prod, '2.000', horasAtras(2)));
    for (const r of await pushOk(caixa, [tardia]))
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    expect(await saldo(prod)).toBe(20);
    const [daNova] = (await detalhe(nova)).compensacoes;
    expect(daNova).toMatchObject({ sentido: 'lancada', acertoId: nova, estorno: null });
    expect((await detalhe(antiga)).compensacoes).toEqual([]);
    const [{ codigo }] = (await consultar<{ codigo: number }>(
      emp.nomeBanco,
      'select codigo from acertos_estoque where id = $1',
      [antiga],
    )) as [{ codigo: number }];

    // O estorno da mais nova: a venda continua anulada, agora pela antiga, e a linha estornada aponta para ela.
    await estornar(nova);
    expect(await saldo(prod)).toBe(30);
    const [estornada] = (await detalhe(nova)).compensacoes;
    const [substituta] = (await detalhe(antiga)).compensacoes;
    expect(substituta).toMatchObject({
      sentido: 'lancada',
      acertoId: antiga,
      compensado: expect.objectContaining({ id: daNova!.compensado.id, eventoId: tardia.evento_id }),
      estorno: null,
    });
    expect(estornada!.estorno).toMatchObject({
      acertoId: nova,
      substituidaPor: { id: substituta!.id, acertoId: antiga, acertoCodigo: codigo },
    });
    // Estornada também a antiga, a venda volta a valer: a linha não aponta para mais nada.
    await estornar(antiga);
    expect(await saldo(prod)).toBe(48);
    expect((await detalhe(nova)).compensacoes[0]!.estorno).toMatchObject({ substituidaPor: null });
    expect((await detalhe(antiga)).compensacoes[0]!.estorno).toMatchObject({ substituidaPor: null });
    await recalcularIdentico();
  });

  it('sem produtos.ver_custo (o estoquista) a compensação vem sem o custo', async () => {
    const prod = await criarProduto('CERV COMPENSACAO SEM CUSTO');
    await saldoInicial(prod, '10');
    const nova = await rascunho(prod, '5', horasAtras(1));
    await efetivar(nova);
    await efetivar(await rascunho(prod, '8', horasAtras(2)));
    const [c] = (await detalhe(nova, tokenEstoquista)).compensacoes;
    expect(c).toMatchObject({ sentido: 'lancada', custoUnitario: null });
    expect((await detalhe(nova)).compensacoes[0]!.custoUnitario).toBe('2.0000');
  });
});

/** Prévia + confirmação da planilha de produtos com "Atualizar estoque" (F2-B11), esperando a tarefa terminar. */
async function importarContagem(
  csv: string,
  destino: { lojaId?: string; estoqueId?: string },
  dataContagem: string,
): Promise<{ previa: { linhas: Array<Record<string, unknown>> }; resultado: ResultadoImportacao }> {
  const campos: Record<string, string> = { ...destino, atualizarEstoque: 'true', dataContagem };
  let req = amb.http().post('/api/importacoes/produtos/previa').set(bearer());
  for (const [k, v] of Object.entries(campos)) req = req.field(k, v);
  const p = await req.attach('arquivo', Buffer.from(csv, 'utf8'), 'contagem.csv');
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const c = await amb
    .http()
    .post('/api/importacoes/produtos/confirmar')
    .set(bearer())
    .send({ arquivoId: p.body.arquivoId, ...destino, atualizarEstoque: true, dataContagem });
  expect(c.status, JSON.stringify(c.body)).toBe(202);
  const fim = Date.now() + 30_000;
  for (;;) {
    const t = await amb.http().get(`/api/tarefas/${c.body.tarefaId}`).set(bearer());
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    if (t.body.status === 'concluida') return { previa: p.body, resultado: t.body.resultado };
    if (t.body.status === 'falhou') throw new Error(`tarefa falhou: ${t.body.erro}`);
    if (Date.now() > fim) throw new Error(`tarefa não terminou: ${JSON.stringify(t.body)}`);
    await new Promise((ok) => setTimeout(ok, 200));
  }
}

async function conferencia(id: string, query: Record<string, string> = {}, tk = tokenAdmin) {
  const r = await amb.http().get(`/api/acertos/${id}/conferencia`).set(bearer(tk)).query(query);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ConferenciaAcerto;
}

const linhaDaPrevia = (previa: { linhas: Array<Record<string, unknown>> }, descricao: string) =>
  previa.linhas.find((l) => l.descricao === descricao);

describe('inventário pela planilha e conferência com tolerância (F2-B11; F2-Q5, F2-Q6)', () => {
  it('Definir do CD pela planilha com a hora de ontem: desconta o posterior, conta o igual e confere pela tolerância', async () => {
    const [{ id: cd }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo) values ('CD - Estoque Ice Beer', 'deposito') returning id",
    )) as [{ id: string }];
    const a = await criarProduto('CERV CD A', 'CDA');
    const b = await criarProduto('CERV CD B', 'CDB');
    const c = await criarProduto('CERV CD C', 'CDC');
    // A carga do Nuvem3 há dois dias (F2-Q5 (c)) e duas saídas hoje, depois da contagem de ontem.
    for (const [p, q] of [
      [a, '100'],
      [b, '50'],
      [c, '30'],
    ] as const)
      await efetivar(await rascunho(p, q, horasAtras(48), 'definir', cd));
    await efetivar(await rascunho(a, '10', agora(), 'saida', cd));
    await efetivar(await rascunho(c, '6', agora(), 'saida', cd));
    expect([await saldo(a, cd), await saldo(b, cd), await saldo(c, cd)]).toEqual([90, 50, 24]);

    // Contagem de ontem: A tinha 95 (o sistema, 100), B confere, C tinha 24 (o sistema, 30: hoje o saldo coincide).
    const ontem = horasAtras(24);
    const { previa, resultado } = await importarContagem(
      [
        'Ref. Interna;Produto;Venda;Estoque atual',
        'CDA;CERV CD A;5;95',
        'CDB;CERV CD B;5;50',
        'CDC;CERV CD C;5;24',
      ].join('\n'),
      { estoqueId: cd },
      ontem,
    );
    // O saldo comparado é o do CD na hora da contagem: o C não fica "sem alteração" por coincidir com o de agora.
    expect(linhaDaPrevia(previa, 'CERV CD C')).toMatchObject({
      acao: 'atualizar',
      alteracoes: [expect.objectContaining({ campo: 'estoque_atual', de: '30', para: '24' })],
    });
    expect(linhaDaPrevia(previa, 'CERV CD B')).toMatchObject({ acao: 'sem_alteracao' });
    expect(resultado).toMatchObject({ atualizados: 2, semAlteracao: 1, acertoCodigo: expect.any(Number) });
    expect(resultado.acertos).toHaveLength(1);
    const id = resultado.acertoId!;

    // AJUSTE_IMPORTACAO na hora da contagem (retroativoPermitido), só nos que mudaram; o B entra com diferença zero.
    const [cab] = await consultar<{ data: string; estoque: string; origem: string }>(
      emp.nomeBanco,
      'select data_contagem as data, estoque_id as estoque, origem from acertos_estoque where id = $1',
      [id],
    );
    expect(cab).toMatchObject({ estoque: cd, origem: 'importacao' });
    expect(new Date(cab!.data).toISOString()).toBe(ontem);
    const movimentos = await consultar<{ produto_id: string; quantidade: string; data: string }>(
      emp.nomeBanco,
      `select produto_id, quantidade::text, data_movimento as data from movimentos_estoque
        where documento_id = $1 and tipo_movimento = 'AJUSTE_IMPORTACAO' order by quantidade::numeric`,
      [id],
    );
    expect(movimentos.map((m) => [m.produto_id, Number(m.quantidade)])).toEqual([
      [c, -6],
      [a, -5],
    ]);
    expect(movimentos.every((m) => new Date(m.data).toISOString() === ontem)).toBe(true);
    const d = await detalhe(id);
    expect(d.itens.map((i) => [i.produtoId, Number(i.diferenca)])).toEqual([
      [a, -5],
      [b, 0],
      [c, -6],
    ]);
    // Saldo = contagem − o que saiu depois dela.
    expect([await saldo(a, cd), await saldo(b, cd), await saldo(c, cd)]).toEqual([85, 50, 18]);

    // Conferência com os padrões (1% no total, 5% por item): o C (20%) e o total (6,51%) ficam fora.
    const r = await conferencia(id);
    expect(r).toMatchObject({
      estimativa: false,
      toleranciaTotalPct: '1',
      toleranciaItemPct: '5',
      valorContado: '338.00',
      valorSistema: '360.00',
      valorDiferenca: '-22.00',
      valorDiferencaAbsoluta: '22.00',
      diferencaTotalPct: '6.51',
      totalForaTolerancia: true,
      itensForaTolerancia: 1,
      veredito: 'fora_tolerancia',
    });
    expect(
      r.itens.map((i) => [i.produtoId, i.saldoSistema, i.diferenca, i.diferencaPct, i.foraTolerancia]),
    ).toEqual([
      [c, '30.000', '-6.000', '20.00', true],
      [a, '100.000', '-5.000', '5.00', false],
      [b, '50.000', '0.000', '0.00', false],
    ]);
    expect(r.itens[0]).toMatchObject({
      custoUnitario: '2.0000',
      valorDiferenca: '-12.00',
      compensado: '0.000',
    });
    // Os limites da consulta valem só para ela: no limite exato fica dentro; um centésimo abaixo, fora.
    expect(await conferencia(id, { toleranciaTotalPct: '7', toleranciaItemPct: '20' })).toMatchObject({
      veredito: 'conferido',
      itensForaTolerancia: 0,
      totalForaTolerancia: false,
    });
    expect(await conferencia(id, { toleranciaTotalPct: '7', toleranciaItemPct: '4,99' })).toMatchObject({
      veredito: 'fora_tolerancia',
      itensForaTolerancia: 2,
    });
    await recalcularIdentico();
  });

  it('planilha da loja: a venda posterior é descontada, a anterior que chega depois é compensada e a conferência a vê', async () => {
    const prod = await criarProduto('CERV PLANILHA LOJA', 'PLANLOJA');
    await saldoInicial(prod, '50');
    const caixa1 = await novoPonto();
    const caixa2 = await novoPonto();
    // A venda depois da contagem (há 1,5 h) chega antes da importação; a anterior a ela, do caixa offline, depois.
    for (const r of await pushOk(caixa2, [
      evento(caixa2, 'venda.finalizada', venda(caixa2, prod, '3.000', horasAtras(0.5))),
    ]))
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    const { resultado } = await importarContagem(
      'Ref. Interna;Produto;Venda;Estoque atual\nPLANLOJA;CERV PLANILHA LOJA;5;45\n',
      { lojaId: loja },
      horasAtras(1.5),
    );
    const id = resultado.acertoId!;
    expect(await saldo(prod)).toBe(42);
    const antes = await conferencia(id);
    expect(antes.itens[0]).toMatchObject({
      saldoSistema: '50.000',
      diferenca: '-5.000',
      diferencaPct: '10.00',
    });

    for (const r of await pushOk(caixa1, [
      evento(caixa1, 'venda.finalizada', venda(caixa1, prod, '2.000', horasAtras(2))),
    ]))
      expect(r, JSON.stringify(r)).toMatchObject({ status: 'aplicado' });
    // A contagem já tinha visto a venda tardia: ela é anulada e o saldo continua o da contagem menos a posterior.
    expect(await saldo(prod)).toBe(42);
    const depois = await conferencia(id);
    // O sistema "na hora" tinha 48 (50 − a venda tardia): a diferença real é 3 (6,25%), não 5.
    expect(depois.itens[0]).toMatchObject({
      contado: '45.000',
      compensado: '2.000',
      saldoSistema: '48.000',
      diferenca: '-3.000',
      diferencaPct: '6.25',
      foraTolerancia: true,
    });
    expect(depois).toMatchObject({ valorDiferencaAbsoluta: '6.00', diferencaTotalPct: '6.67' });
    await recalcularIdentico();
  });

  it('acima de 5.000 produtos: um acerto por parte, cada um na sua transação; a parte que falha não desfaz a anterior', async () => {
    // 5.002 produtos por SQL e o caminho de estoque da tarefa (`Importacoes.acertoEstoque`, privado; chamado como a
    // tarefa chama depois de gravar os cadastros): a planilha de 5 mil linhas pela importação inteira fica lenta.
    const [seq] = await consultar<{ n: string }>(
      emp.nomeBanco,
      'select last_value::text as n from seq_codigo_produtos',
    );
    const inicio = Number(seq!.n) + 1;
    const ids = (
      await consultar<{ id: string; codigo: number }>(
        emp.nomeBanco,
        `insert into produtos (nome, unidade_id, codigo, codigo_interno)
         select 'PARTES ' || g, $2, g, 'PT-' || g from generate_series($1::int, $1::int + 5001) g
         returning id, codigo`,
        [inicio, un],
      )
    )
      .sort((x, y) => Number(x.codigo) - Number(y.codigo))
      .map((r) => r.id);
    // O último é um legado "Com variações" (D43) contado com 0 e igual ao saldo: fica fora do acerto (sem ele, o
    // "Escolha a variação" derrubaria a parte inteira).
    const variacoes = ids[5001]!;
    await consultar(emp.nomeBanco, "update produtos set tipo = 'com_variacoes' where id = $1", [variacoes]);
    const sessao = {
      usuarioId: operador,
      usuarioNome: 'Administrador',
      master: false,
    } as unknown as SessaoErp;
    // O 1º muda (7); os do meio vêm iguais ao saldo, contados com 0 e sem linha de saldo; o 5.001º, `ultimo`.
    const definir = (dataContagem: string, ultimo: string) =>
      naEmpresa(() =>
        amb.servicos.importacoes['acertoEstoque'](
          sessao,
          { origem: 'importacao', usuarioId: operador, usuarioNome: 'Administrador' },
          { estoqueId: estoqueLoja, lojaId: loja },
          new Date(dataContagem),
          ids.map((id, i) => ({
            id,
            linha: (i === 0
              ? { estoqueAtual: '7', estoqueContado: '7' }
              : i === 5000
                ? { estoqueAtual: ultimo, estoqueContado: ultimo }
                : { estoqueAtual: null, estoqueContado: '0' }) as LinhaProduto,
          })),
        ),
      );
    const daCarga = () =>
      consultar<{
        id: string;
        codigo: number;
        status: string;
        data: string;
        obs: string | null;
        itens: number;
      }>(
        emp.nomeBanco,
        `select a.id, a.codigo, a.status, a.data_contagem as data, a.observacoes as obs,
                (select count(*)::int from itens_acerto_estoque i where i.acerto_id = a.id) as itens
           from acertos_estoque a
          where a.origem = 'importacao'
            and exists (select 1 from itens_acerto_estoque i where i.acerto_id = a.id and i.produto_id = any($1::uuid[]))
          order by a.codigo`,
        [ids],
      );
    const linhasDeSaldo = async () =>
      (
        await consultar<{ n: number }>(
          emp.nomeBanco,
          'select count(*)::int as n from saldos_estoque where produto_id = any($1::uuid[])',
          [ids],
        )
      )[0]!.n;

    // Saldo negativo sem permissão no 5.001º: a parte 2 falha e a 1 continua efetivada; a mensagem diz qual.
    await expect(definir(horasAtras(2), '-1')).rejects.toThrow(
      /^Estoque definido só em parte: acerto\(s\) Nº \d+ efetivado\(s\); a parte 2 de 2 falhou \(O acerto deixaria saldo negativo/,
    );
    const [parcial, ...nada] = await daCarga();
    expect(nada).toEqual([]);
    expect(parcial).toMatchObject({ status: 'efetivado', itens: 5000, obs: null });
    expect(await saldo(ids[0]!)).toBe(7);
    // O "Definir" de 0 sem linha de saldo não cria a linha zerada: só a do produto que mudou.
    expect(await linhasDeSaldo()).toBe(1);

    const contagem = horasAtras(1);
    const gerados = await definir(contagem, '3');
    expect(gerados).toHaveLength(2);
    const [, p1, p2] = await daCarga();
    expect(gerados).toEqual([
      { id: p1!.id, codigo: p1!.codigo },
      { id: p2!.id, codigo: p2!.codigo },
    ]);
    expect([p1, p2].map((a) => [a!.status, a!.itens, new Date(a!.data).toISOString()])).toEqual([
      ['efetivado', 5000, contagem],
      ['efetivado', 1, contagem],
    ]);
    expect(p1!.obs).toBeNull();
    expect(p2!.obs).toBe(
      `Continuação do acerto Nº ${p1!.codigo} (importação de planilha acima de 5.000 produtos, parte 2 de 2).`,
    );
    const porAcerto = await consultar<{ registro_id: string; n: number; xmin: string }>(
      emp.nomeBanco,
      `select a.id as registro_id, a.xmin::text as xmin,
              (select count(*)::int from auditoria x where x.registro_id = a.id and x.acao = 'efetivar') as n
         from acertos_estoque a where a.id = any($1::uuid[]) order by a.codigo`,
      [[p1!.id, p2!.id]],
    );
    expect(porAcerto.map((a) => a.n)).toEqual([1, 1]);
    // Cada parte na sua transação (a 7300001 é solta entre elas): o `xmin` da efetivação de cada uma é outro.
    expect(porAcerto[0]!.xmin).not.toBe(porAcerto[1]!.xmin);
    expect([await saldo(ids[0]!), await saldo(ids[5000]!)]).toEqual([7, 3]);
    expect(await linhasDeSaldo()).toBe(2);
    const [semVariacao] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from itens_acerto_estoque where produto_id = $1',
      [variacoes],
    );
    expect(semVariacao!.n).toBe(0);
    await recalcularIdentico();
  }, 300_000);

  it('conferência: rascunho é estimativa, item sem saldo fica fora, limite da loja, sem custo e os recusados', async () => {
    const com = await criarProduto('CERV CONFERENCIA COM SALDO');
    const sem = await criarProduto('CERV CONFERENCIA SEM SALDO');
    await saldoInicial(com, '100');
    const r = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoqueLoja,
        tipoAjuste: 'definir',
        dataContagem: horasAtras(1),
        motivo: 'Inventário',
        itens: [
          { produtoId: com, quantidade: '98' },
          { produtoId: sem, quantidade: '3' },
        ],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    // Rascunho: o saldo de agora menos o posterior à contagem (aqui nada); o item sem saldo não tem % e fica fora.
    const est = await conferencia(id);
    expect(est).toMatchObject({ estimativa: true, itensForaTolerancia: 1, veredito: 'fora_tolerancia' });
    expect(est.itens.map((i) => [i.produtoId, i.saldoSistema, i.diferencaPct, i.foraTolerancia])).toEqual([
      [sem, '0.000', null, true],
      [com, '100.000', '2.00', false],
    ]);
    // O limite configurado na loja vale como padrão do relatório.
    const config = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer())
      .send({
        lojaId: loja,
        valores: {
          'estoque.tolerancia_conferencia_item_pct': '1.5',
          'estoque.tolerancia_conferencia_total_pct': '3',
        },
      });
    expect(config.status, JSON.stringify(config.body)).toBe(200);
    const daLoja = await conferencia(id);
    expect(daLoja).toMatchObject({
      toleranciaItemPct: '1.5',
      toleranciaTotalPct: '3',
      itensForaTolerancia: 2,
    });
    // Sem produtos.ver_custo: sem os valores, com o percentual e o veredito.
    const semCusto = await conferencia(id, {}, tokenEstoquista);
    expect(semCusto).toMatchObject({ valorContado: null, valorDiferenca: null, veredito: 'fora_tolerancia' });
    expect(semCusto.itens[1]).toMatchObject({
      custoUnitario: null,
      valorDiferenca: null,
      diferencaPct: '2.00',
    });
    const invalida = await amb
      .http()
      .get(`/api/acertos/${id}/conferencia`)
      .set(bearer())
      .query({ toleranciaItemPct: 'x' });
    expect(invalida.status).toBe(422);
    // Efetivado e depois estornado: a contagem não vale mais. A Entrada não é contagem.
    await efetivar(id);
    expect((await conferencia(id)).estimativa).toBe(false);
    await estornar(id);
    const estornado = await amb.http().get(`/api/acertos/${id}/conferencia`).set(bearer());
    expect(estornado.status).toBe(422);
    const entrada = await rascunho(com, '5', agora(), 'entrada');
    expect((await amb.http().get(`/api/acertos/${entrada}/conferencia`).set(bearer())).status).toBe(422);
    expect(
      (await amb.http().get('/api/acertos/0190f1a0-0000-7000-8000-000000000000/conferencia').set(bearer()))
        .status,
    ).toBe(404);
    await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer())
      .send({
        lojaId: loja,
        valores: {
          'estoque.tolerancia_conferencia_item_pct': null,
          'estoque.tolerancia_conferencia_total_pct': null,
        },
      });
  });
});
