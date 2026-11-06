/**
 * Carga da Fase 1C (bloco C13; crítica da 1C, item 6; SYNC 8.1, 8.3, 19.3): quatro caixas que passaram o turno offline
 * reconectam ao mesmo tempo e despejam o outbox (abertura, vendas de 10 itens, sangria e fechamento, em lotes de 50
 * como o PDV) enquanto o gerente salva produto e efetiva acerto no ERP. Confere: tudo aplicado e nada duplicado, o
 * razão do estoque fechando com as vendas e os acertos, o ERP sem `409` (só `custo_medio` é isento de versão, T10) e
 * sem `SISTEMA_OCUPADO`, o p95 da 7300001 presa por evento (o mesmo medidor do push) e o reenvio do mesmo lote sem
 * efeito. Também: a trava ocupada além de `ERP_ESPERA_TRAVA_MS` devolve `SISTEMA_OCUPADO` ao ERP sem gravar nada, e as
 * rotas do caixa (push, `/sync/ativar` e a confirmação da desativação no heartbeat) esperam sem limite.
 *
 * Tamanho: `CARGA_VENDAS_POR_TERMINAL` (padrão 50 no CI; a rodada anexada ao PR usa 200, a do PDV 30.7). Com
 * `RELATORIO_CARGA` definido, o resumo (tempos, p50/p95/máximo, contagens) vai também para esse arquivo JSON.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { CONTRATOS_EVENTOS, jcs, respostaPushSchema, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MedidorTravaVersao } from '../../src/sync/aplicacao.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

const TERMINAIS = 4;
const VENDAS_POR_TERMINAL = Number(process.env.CARGA_VENDAS_POR_TERMINAL ?? 50);
const ITENS_POR_VENDA = 10;
const EVENTOS_POR_LOTE = 50;
/**
 * Meta da SYNC 8.3 (50 ms por venda de 10 itens); o CI afrouxa por `TETO_TRAVA_VERSAO_MS`, como no teste do motor, e
 * esta carga pode ter teto próprio (`TETO_TRAVA_CARGA_MS`): no runner compartilhado, com os outros arquivos de
 * integração no mesmo PostgreSQL, o p95 da carga oscila bem mais que o do motor sozinho.
 */
const TETO_TRAVA_MS = Number(process.env.TETO_TRAVA_CARGA_MS ?? process.env.TETO_TRAVA_VERSAO_MS ?? 50);
/** Espera do ERP pela trava neste arquivo: curta, para o teste do `SISTEMA_OCUPADO` não demorar. */
const ESPERA_TRAVA_MS = 2_000;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let estoqueLoja: string;
let tokenAdmin: string;
let operador: string;
let dinheiro: string;
let un: string;
const produtos: string[] = [];

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const bearer = () => ({ Authorization: `Bearer ${tokenAdmin}` });
const agora = () => new Date().toISOString();

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

/** Caixa novo e o código de ativação gerado pelo ERP (ERP 12.3). */
async function novoCodigo(): Promise<{ caixa: string; numero: number; codigo: string }> {
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
  return { caixa, numero, codigo: g.body.codigo as string };
}

const ativarComCodigo = (codigo: string) =>
  amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });

async function novoPonto(): Promise<Ponto> {
  const { caixa, numero, codigo } = await novoCodigo();
  const r = await ativarComCodigo(codigo);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return {
    caixa,
    numero,
    terminal: r.body.terminal_id,
    token: r.body.token,
    seq: 0,
    venda: 0,
    sessao: uuidv7(),
  };
}

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

/** Envelope com o agregado do contrato (C4) e a sessão como dependência, como o PDV declara (SYNC 8.5). */
function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload, ocorridoEm: string) {
  const contrato = CONTRATOS_EVENTOS[tipo];
  return {
    evento_id: uuidv7(),
    sequencia: ++p.seq,
    tipo,
    versao_schema: 1,
    agregado_tipo: contrato.agregadoTipo,
    agregado_id: (contrato.agregadoId as (x: unknown) => string)(payload),
    dependencias: tipo === 'caixa.aberto' ? [] : [{ agregado_tipo: 'sessao_caixa', agregado_id: p.sessao }],
    ocorrido_em: ocorridoEm,
    relogio_confiavel: true,
    usuario_id: operador,
    contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

type Evento = ReturnType<typeof evento>;

const movimento = (p: Ponto, tipo: string, valor: string, ocorridoEm: string, extra: Payload = {}) => ({
  id: uuidv7(),
  sessao_caixa_id: p.sessao,
  ...linhaDoPonto(p),
  tipo,
  forma_pagamento_id: null,
  valor,
  operador_id: operador,
  quem_retira_usuario_id: null,
  quem_retira_nome: null,
  observacao: null,
  inf_adicionais: null,
  ocorrido_em: ocorridoEm,
  autorizado_por_id: null,
  troca_id: null,
  cancelado: false,
  ...extra,
});

/** Venda de 10 itens (um de cada produto da carga, R$ 5,00), paga em dinheiro. */
function venda(p: Ponto, finalizada: string) {
  const id = uuidv7();
  const numero = ++p.venda;
  const linhas = produtos.map((produto, n) => ({
    id: uuidv7(),
    venda_id: id,
    sequencia: n + 1,
    produto_id: produto,
    descricao: `ITEM DA CARGA ${n + 1}`,
    unidade: 'UN',
    quantidade: '1.000',
    preco_tabela: '5.0000',
    preco_unitario: '5.0000',
    valor_bruto: '5.00',
    valor_liquido: '5.00',
    incluido_em: finalizada,
    componentes_estoque: [],
  }));
  const total = (5 * linhas.length).toFixed(2);
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
        valor: total,
        lanca_quitada: true,
      },
    ],
    vasilhames: [],
  };
}

/**
 * O outbox de um turno offline (como o PDV gravou: abertura, as vendas espalhadas pelas últimas 4 h, uma sangria no
 * meio e o fechamento cego), já cortado nos lotes de 50 que o envio monta (SYNC 7.4).
 */
function turnoOffline(p: Ponto): Evento[][] {
  const fundo = '100.00';
  const inicio = Date.now() - 4 * 3_600_000;
  const hora = (fracao: number) => new Date(inicio + fracao * 4 * 3_600_000 - 60_000).toISOString();
  const eventos: Evento[] = [
    evento(
      p,
      'caixa.aberto',
      {
        sessoes_caixa: {
          id: p.sessao,
          ...linhaDoPonto(p),
          operador_id: operador,
          status: 'aberta',
          dia_operacional: '2026-10-31',
          aberta_em: hora(0),
          abertura_automatica: false,
          fundo_troco: fundo,
          sessao_anterior_id: null,
          valor_recebido_anterior: null,
          diferenca_recebimento: null,
          fechada_em: null,
        },
        movimentos_caixa: [movimento(p, 'abertura', fundo, hora(0))],
        contagem_cedulas: null,
      },
      hora(0),
    ),
  ];
  const sangria = '200.00';
  for (let i = 0; i < VENDAS_POR_TERMINAL; i++) {
    const quando = hora((i + 1) / (VENDAS_POR_TERMINAL + 2));
    eventos.push(evento(p, 'venda.finalizada', venda(p, quando), quando));
    if (i === Math.floor(VENDAS_POR_TERMINAL / 2)) {
      eventos.push(
        evento(
          p,
          'caixa.sangria',
          {
            movimentos_caixa: movimento(p, 'sangria', sangria, quando, { quem_retira_nome: 'GERENTE' }),
            dinheiro_estimado_antes: (100 + 50 * (i + 1)).toFixed(2),
            contagem_cedulas: null,
          },
          quando,
        ),
      );
    }
  }
  const fim = hora(1);
  const esperado = (100 + 50 * VENDAS_POR_TERMINAL - 200).toFixed(2);
  const fechamentoId = uuidv7();
  eventos.push(
    evento(
      p,
      'caixa.fechado',
      {
        sessoes_caixa: { id: p.sessao, status: 'fechada', fechada_em: fim },
        fechamentos_caixa: {
          id: fechamentoId,
          sessao_caixa_id: p.sessao,
          ...linhaDoPonto(p),
          tipo: 'fechamento',
          zera_caixa: true,
          usuario_anterior_id: operador,
          usuario_subsequente_id: null,
          valor_caixa: '0.00',
          total_calculado: esperado,
          total_digitado: esperado,
          justificativa: null,
          recontagem: false,
          fechamento_cego: true,
          ocorrido_em: fim,
          dia_operacional: '2026-10-31',
          resumo: {
            qtd_vendas: VENDAS_POR_TERMINAL,
            total_vendas: (50 * VENDAS_POR_TERMINAL).toFixed(2),
            ultima_sequencia_evento: p.seq + 1,
          },
        },
        fechamentos_caixa_formas: [
          {
            id: uuidv7(),
            fechamento_id: fechamentoId,
            forma_pagamento_id: dinheiro,
            descricao_forma: 'Dinheiro',
            tipo_forma: 'dinheiro',
            valor_calculado: esperado,
            valor_digitado: esperado,
            quantidade_pagamentos: VENDAS_POR_TERMINAL,
            preenchido_automatico: false,
            valor_primeira_contagem: null,
          },
        ],
        movimentos_caixa: [movimento(p, 'sangria_fechamento', esperado, fim, { quem_retira_nome: 'MARIA' })],
      },
      fim,
    ),
  );
  const lotes: Evento[][] = [];
  for (let i = 0; i < eventos.length; i += EVENTOS_POR_LOTE)
    lotes.push(eventos.slice(i, i + EVENTOS_POR_LOTE));
  return lotes;
}

type Resultado = { evento_id: string; status: string; erro?: { codigo: string } };

async function enviar(p: Ponto, eventos: Evento[], loteId: string): Promise<Resultado[]> {
  const r = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: loteId, terminal_id: p.terminal, enviado_em: agora(), eventos });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Resultado[];
}

/** Percentil pelo posto mais próximo (o mesmo do `MedidorTravaVersao`). */
function resumoTempos(ms: number[]) {
  const m = new MedidorTravaVersao(Math.max(1, ms.length));
  for (const v of ms) m.registrar(v);
  return arredondar(m.resumo());
}

const arred = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
const arredondar = (r: ReturnType<MedidorTravaVersao['resumo']>) => ({
  amostras: r.amostras,
  p50: arred(r.p50),
  p95: arred(r.p95),
  maximo: arred(r.maximo),
});

async function saldo(produto: string): Promise<number> {
  const [s] = await consultar<{ q: string }>(
    emp.nomeBanco,
    `select coalesce(sum(quantidade), 0)::text as q from saldos_estoque
      where estoque_id = $1 and produto_id = $2
        and tipo_estoque_id = (select id from tipos_estoque where padrao)`,
    [estoqueLoja, produto],
  );
  return Number(s!.q);
}

/** Acerto de Entrada efetivado pela rota do ERP (a contagem logo antes, como na tela). */
async function entrada(itens: Array<[produto: string, quantidade: string]>) {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId: estoqueLoja,
      tipoAjuste: 'entrada',
      dataContagem: agora(),
      motivo: 'Reposição durante a carga',
      itens: itens.map(([produtoId, quantidade]) => ({ produtoId, quantidade, custoUnitario: '2' })),
    });
  if (a.status !== 201) return a;
  const atual = await amb.http().get(`/api/acertos/${a.body.id}`).set(bearer());
  return amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: atual.body.versao });
}

/** Salva o produto como a tela: o detalhe atual com o preço novo, no `PUT` com a versão lida. */
async function salvarProduto(id: string, preco: string) {
  const atual = (await amb.http().get(`/api/produtos/${id}`).set(bearer())).body as Payload;
  return amb
    .http()
    .put(`/api/produtos/${id}`)
    .set(bearer())
    .send({ ...atual, precoVenda: preco });
}

beforeAll(async () => {
  amb = await criarAmbiente({ env: { ERP_ESPERA_TRAVA_MS: String(ESPERA_TRAVA_MS) } });
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
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  for (let i = 0; i < ITENS_POR_VENDA; i++) {
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer())
      .send({ nome: `PRODUTO DA CARGA ${i + 1}`, unidadeId: un, precoVenda: '5', precoCusto: '2' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    produtos.push(r.body.id as string);
  }
  const r = await entrada(produtos.map((p) => [p, String(TERMINAIS * VENDAS_POR_TERMINAL)]));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('trava 7300001 ocupada (crítica da 1C, item 6)', () => {
  it('o ERP recebe SISTEMA_OCUPADO sem gravar depois da espera; o push do caixa espera sem limite', async () => {
    const p = await novoPonto();
    const [lote] = turnoOffline({ ...p, seq: 0, venda: 0 });
    const preco = (await amb.http().get(`/api/produtos/${produtos[0]}`).set(bearer())).body.precoVenda;
    const trava = await conectar(emp.nomeBanco);
    try {
      await trava.query('begin');
      await trava.query('select fn_trava_versao()');
      const t0 = performance.now();
      const r = await salvarProduto(produtos[0]!, '9.99');
      const esperou = performance.now() - t0;
      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(r.body).toMatchObject({
        codigo: 'SISTEMA_OCUPADO',
        mensagem: expect.stringContaining('tente salvar de novo'),
      });
      expect(r.headers['retry-after']).toBe('5');
      expect(esperou).toBeGreaterThanOrEqual(ESPERA_TRAVA_MS - 50);
      // O push do mesmo instante fica esperando a trava (sem lock_timeout) e aplica quando ela sai.
      const push = enviar(p, lote!.slice(0, 2), uuidv7());
      let respondeu = false;
      void push.then(() => (respondeu = true));
      await new Promise((ok) => setTimeout(ok, ESPERA_TRAVA_MS + 500));
      expect(respondeu).toBe(false);
      await trava.query('commit');
      expect((await push).map((x) => x.status)).toEqual(['aplicado', 'aplicado']);
    } finally {
      await trava.query('rollback').catch(() => undefined);
      await trava.end();
    }
    // Nada do produto foi gravado na tentativa recusada; a seguinte passa.
    expect((await amb.http().get(`/api/produtos/${produtos[0]}`).set(bearer())).body.precoVenda).toBe(preco);
    expect((await salvarProduto(produtos[0]!, '5')).status).toBe(200);
  });
});

describe('trava 7300001 ocupada nas rotas do PDV (C13)', () => {
  /** Dispara a requisição e confere que ela segue esperando a trava além do limite do ERP, sem erro. */
  async function esperaATrava<T>(requisicao: PromiseLike<T>): Promise<() => Promise<T>> {
    const pendente = Promise.resolve(requisicao);
    let respondeu = false;
    void pendente.then(
      () => (respondeu = true),
      () => (respondeu = true),
    );
    await new Promise((ok) => setTimeout(ok, ESPERA_TRAVA_MS + 500));
    expect(respondeu).toBe(false);
    return () => pendente;
  }

  it('/sync/ativar e a confirmação da desativação no heartbeat esperam sem limite, nunca 500', async () => {
    const { codigo } = await novoCodigo();
    const desativando = await novoPonto();
    const revogar = await amb
      .http()
      .post(`/api/terminais/${desativando.terminal}/revogar`)
      .set(bearer())
      .send({ modo: 'aceitar_pendencias' });
    expect(revogar.status, JSON.stringify(revogar.body)).toBe(200);
    const trava = await conectar(emp.nomeBanco);
    try {
      await trava.query('begin');
      await trava.query('select fn_trava_versao()');
      const ativar = await esperaATrava(ativarComCodigo(codigo));
      const heartbeat = await esperaATrava(
        amb.http().post('/sync/heartbeat').set(cabecalhos(desativando.token)).send({
          estado_local: 'desativando_confirmado',
          eventos_pendentes: 0,
          ultima_sequencia_gerada: 0,
          venda_ultimo_numero: 0,
        }),
      );
      await trava.query('commit');
      const a = await ativar();
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      const hb = await heartbeat();
      expect(hb.status, JSON.stringify(hb.body)).toBe(200);
      expect(hb.body.status_terminal).toBe('revogado');
    } finally {
      await trava.query('rollback').catch(() => undefined);
      await trava.end();
    }
  });
});

describe(`carga: ${TERMINAIS} terminais reconectando juntos e o ERP gravando (C13)`, () => {
  it('tudo aplicado sem duplicar, o razão fecha, o ERP não trava e o reenvio do mesmo lote não muda nada', async () => {
    const pontos: Ponto[] = [];
    for (let i = 0; i < TERMINAIS; i++) pontos.push(await novoPonto());
    const turnos = pontos.map((p) => turnoOffline(p).map((eventos) => ({ eventos, loteId: uuidv7() })));
    const totalEventos = turnos.reduce((s, t) => s + t.reduce((n, l) => n + l.eventos.length, 0), 0);
    const saldosAntes = await Promise.all(produtos.map(saldo));
    const [{ n: vendasAntes }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from vendas',
    )) as [{ n: number }];

    const medidor = amb.servicos.push.medidorTrava;
    medidor.limpar();
    const tempoLote: number[] = [];
    const tempoErp: { produto: number[]; acerto: number[] } = { produto: [], acerto: [] };
    const recusasErp: string[] = [];
    const entradasErp = new Map<string, number>();
    let terminou = false;
    const t0 = performance.now();

    // Cada caixa manda os seus lotes em ordem (um por vez, como o EnvioPush); os quatro ao mesmo tempo.
    const caixas = pontos.map(async (p, i) => {
      const resultados: Resultado[] = [];
      for (const lote of turnos[i]!) {
        const t = performance.now();
        resultados.push(...(await enviar(p, lote.eventos, lote.loteId)));
        tempoLote.push(performance.now() - t);
      }
      return resultados;
    });
    // O gerente no ERP enquanto os caixas sobem: salva um produto vendido e efetiva um acerto, alternando.
    const erp = (async () => {
      for (let n = 0; !terminou; n++) {
        const t = performance.now();
        if (n % 2 === 0) {
          const r = await salvarProduto(produtos[n % produtos.length]!, n % 4 === 0 ? '5.49' : '5');
          tempoErp.produto.push(performance.now() - t);
          if (r.status !== 200) recusasErp.push(`produto ${r.status} ${JSON.stringify(r.body)}`);
        } else {
          const produto = produtos[n % produtos.length]!;
          const r = await entrada([[produto, '3']]);
          tempoErp.acerto.push(performance.now() - t);
          if (r.status !== 200) recusasErp.push(`acerto ${r.status} ${JSON.stringify(r.body)}`);
          else entradasErp.set(produto, (entradasErp.get(produto) ?? 0) + 3);
        }
      }
    })();
    const resultados = (await Promise.all(caixas)).flat();
    const duracaoMs = performance.now() - t0;
    terminou = true;
    await erp;
    const trava = medidor.resumo();

    // 1. Tudo aplicado, nada fora de ordem, nenhuma recusa no ERP.
    const outros = resultados.filter((r) => r.status !== 'aplicado');
    expect(outros, JSON.stringify(outros.slice(0, 5))).toEqual([]);
    expect(resultados).toHaveLength(totalEventos);
    expect(recusasErp).toEqual([]);

    // 2. Nada duplicado: uma venda por evento, os eventos recebidos uma vez, as sessões fechadas.
    const [contagem] = await consultar<{
      vendas: number;
      itens: number;
      eventos: number;
      fechadas: number;
      sangrias: number;
    }>(
      emp.nomeBanco,
      `select (select count(*)::int from vendas) - $2::int as vendas,
              (select count(*)::int from itens_venda iv join vendas v on v.id = iv.venda_id
                where v.terminal_id = any($1::uuid[])) as itens,
              (select count(*)::int from eventos_recebidos where terminal_id = any($1::uuid[])) as eventos,
              (select count(*)::int from sessoes_caixa where terminal_id = any($1::uuid[]) and status = 'fechada') as fechadas,
              (select count(*)::int from movimentos_caixa where terminal_id = any($1::uuid[]) and tipo = 'sangria') as sangrias`,
      [pontos.map((p) => p.terminal), vendasAntes],
    );
    expect(contagem).toEqual({
      vendas: TERMINAIS * VENDAS_POR_TERMINAL,
      itens: TERMINAIS * VENDAS_POR_TERMINAL * ITENS_POR_VENDA,
      eventos: totalEventos,
      fechadas: TERMINAIS,
      sangrias: TERMINAIS,
    });

    // 3. O razão: saldo final = inicial − vendas + entradas do ERP, produto a produto.
    expect(tempoErp.acerto.length).toBeGreaterThan(0);
    const saldosDepois = await Promise.all(produtos.map(saldo));
    produtos.forEach((p, i) =>
      expect(saldosDepois[i], p).toBe(
        saldosAntes[i]! - TERMINAIS * VENDAS_POR_TERMINAL + (entradasErp.get(p) ?? 0),
      ),
    );

    // 4. Reenvio do mesmo lote (mesmo lote_id, mesmos eventos: a resposta perdida na reconexão): tudo `duplicado`.
    const reenvio = await Promise.all(
      pontos.map((p, i) => enviar(p, turnos[i]![0]!.eventos, turnos[i]![0]!.loteId)),
    );
    expect(new Set(reenvio.flat().map((r) => r.status))).toEqual(new Set(['duplicado']));
    const [{ n: vendasFim }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from vendas',
    )) as [{ n: number }];
    expect(vendasFim - vendasAntes).toBe(TERMINAIS * VENDAS_POR_TERMINAL);
    expect(await Promise.all(produtos.map(saldo))).toEqual(saldosDepois);

    const relatorio = {
      teste: 'carga C13: terminais reconectando juntos com o ERP gravando',
      quando: agora(),
      terminais: TERMINAIS,
      vendasPorTerminal: VENDAS_POR_TERMINAL,
      itensPorVenda: ITENS_POR_VENDA,
      eventos: totalEventos,
      duracaoMs: Math.round(duracaoMs),
      eventosPorSegundo: Math.round((totalEventos / duracaoMs) * 1000 * 10) / 10,
      travaVersaoMs: { ...arredondar(trava), meta: 50, teto: TETO_TRAVA_MS },
      loteMs: resumoTempos(tempoLote),
      erpProdutoMs: resumoTempos(tempoErp.produto),
      erpAcertoMs: resumoTempos(tempoErp.acerto),
      erpEsperaMaximaMs: ESPERA_TRAVA_MS,
      recusasErp: recusasErp.length,
      reenvio: 'duplicado',
    };
    console.info(`carga C13: ${JSON.stringify(relatorio)}`);
    if (process.env.RELATORIO_CARGA)
      writeFileSync(process.env.RELATORIO_CARGA, JSON.stringify(relatorio, null, 2));

    // 5. Tempos: a 7300001 continua curta por evento sob carga e o ERP fica bem abaixo da espera máxima.
    expect(trava.p95!).toBeLessThan(TETO_TRAVA_MS);
    expect(Math.max(...tempoErp.produto, ...tempoErp.acerto)).toBeLessThan(ESPERA_TRAVA_MS);
  }, 600_000);
});
