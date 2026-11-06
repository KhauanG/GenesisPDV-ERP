/**
 * `GET /sync/recuperar` (bloco C17 da Fase 1C; SYNC 22.1, 22.2, 3.8; T6, T7), pelas rotas reais: as páginas em ordem
 * com o envelope original (o que o caixa mandou no push, mais o `terminal_id` da coluna), o `payload`, a situação
 * (`aplicado`, `erro`, `descartado`), os marcadores de versão e o placeholder da lacuna marcado; só os eventos do
 * próprio terminal; o payload anulado nulo e o envelope anterior à migração 0010 remontado das colunas; e os estados e
 * recusas do endpoint (hardware divergente 409, desativando 200, revogado 401, query inválida 400). Cada teste usa um
 * caixa e um terminal só seus (`novoPonto`).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONTRATOS_EVENTOS,
  jcs,
  respostaPushSchema,
  respostaRecuperarSchema,
  type Ativar,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let tokenAdmin: string;
/** O Master (admin): tem `pdv.config.fiscal`, que no perfil padrão é só do Master. */
let admin: string;
let dinheiro: string;
let produto: string;

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
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

interface Ponto {
  caixa: string;
  numero: number;
  terminal: string;
  token: string;
  seq: number;
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
  return { caixa, numero, terminal: r.body.terminal_id, token: r.body.token, seq: 0, sessao: uuidv7() };
}

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

/** Envelope com o agregado do contrato (C4); `sequencia` explícita, para montar a lacuna. */
function evento(p: Ponto, tipo: string, payload: Payload, sequencia = ++p.seq) {
  const contrato = (
    CONTRATOS_EVENTOS as Record<string, { agregadoTipo: string; agregadoId(x: unknown): string }>
  )[tipo];
  return {
    evento_id: uuidv7(),
    sequencia,
    tipo,
    versao_schema: 1,
    agregado_tipo: contrato?.agregadoTipo ?? 'auditoria',
    agregado_id: contrato ? contrato.agregadoId(payload) : uuidv7(),
    dependencias: [],
    ocorrido_em: agora(),
    relogio_confiavel: true,
    usuario_id: admin,
    contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

const abertura = (p: Ponto, sequencia?: number) =>
  evento(
    p,
    'caixa.aberto',
    {
      sessoes_caixa: {
        id: p.sessao,
        ...linhaDoPonto(p),
        operador_id: admin,
        status: 'aberta',
        dia_operacional: '2026-10-31',
        aberta_em: horasAtras(5),
        fundo_troco: '0.00',
      },
      movimentos_caixa: [],
    },
    sequencia,
  );

/** Uma venda finalizada de um item (10,00 em dinheiro), só com o que o contrato exige (C4). */
function venda(p: Ponto, numero: number) {
  const id = uuidv7();
  const finalizada = horasAtras(1);
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
      operador_id: admin,
      cliente_id: null,
      subtotal_bruto: '10.00',
      total: '10.00',
      iniciada_em: finalizada,
      finalizada_em: finalizada,
    },
    itens_venda: [
      {
        id: uuidv7(),
        venda_id: id,
        sequencia: 1,
        produto_id: produto,
        descricao: 'ITEM DE TESTE',
        unidade: 'UN',
        quantidade: '2.000',
        preco_tabela: '5.0000',
        preco_unitario: '5.0000',
        valor_bruto: '10.00',
        valor_liquido: '10.00',
        incluido_em: finalizada,
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
        valor: '10.00',
        lanca_quitada: true,
      },
    ],
    cobrancas_pix: [] as Payload[],
    vasilhames: [] as Payload[],
  };
}

const push = (p: Ponto, eventos: unknown[], extra: Payload = {}) =>
  amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: uuidv7(), terminal_id: p.terminal, enviado_em: agora(), eventos, ...extra });

type Resultado = { status: string; erro?: { codigo: string }; resultado?: Record<string, unknown> };

async function pushOk(p: Ponto, eventos: unknown[], extra: Payload = {}) {
  const r = await push(p, eventos, extra);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const corpo = respostaPushSchema.parse(r.body);
  return { resultados: corpo.resultados as Resultado[], proxima: corpo.proxima_sequencia_esperada };
}

const declarar = (de: number, ate: number, autorizadoPorId = admin) => ({
  declarar_lacuna: {
    de,
    ate,
    motivo: 'banco_local_perdido',
    observacao: 'Banco do caixa trocado',
    autorizado_por_id: autorizadoPorId,
  },
});

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  [{ id: admin }] = (await consultar<{ id: string }>(
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
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({
      nome: 'REFRIGERANTE DE TESTE',
      unidadeId: unidades.find((u) => u.sigla === 'UN')!.id,
      precoVenda: '5',
      precoCusto: '2',
      controlaEstoque: false,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  produto = r.body.id as string;
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

const recuperar = (p: Ponto, query: string, extra: Record<string, string> = {}) =>
  amb
    .http()
    .get(`/sync/recuperar?${query}`)
    .set({ ...cabecalhos(p.token), ...extra });

async function recuperarOk(p: Ponto, desde: number, limite?: number) {
  const r = await recuperar(p, `desde_sequencia=${desde}${limite ? `&limite=${limite}` : ''}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return respostaRecuperarSchema.parse(r.body);
}

/** Todas as páginas a partir de `desde`, como a reidratação do caixa pede (a próxima começa na última sequência). */
async function todas(p: Ponto, desde: number, limite: number) {
  const eventos = [];
  for (let i = 0; i < 100; i++) {
    const pagina = await recuperarOk(p, desde, limite);
    eventos.push(...pagina.eventos);
    if (!pagina.tem_mais) return eventos;
    desde = pagina.eventos.at(-1)!.envelope.sequencia;
  }
  throw new Error('páginas demais');
}

describe('GET /sync/recuperar (SYNC 22.2)', () => {
  it('devolve em páginas, na ordem, o envelope original e a situação de cada evento, com o placeholder marcado', async () => {
    const p = await novoPonto();
    const outro = await novoPonto();
    const ab = abertura(p);
    const v2 = evento(p, 'venda.finalizada', venda(p, 2));
    v2.dependencias = [{ agregado_tipo: 'sessao_caixa', agregado_id: p.sessao }] as never;
    // Produto que a nuvem não tem: a venda fica em erro (REFERENCIA_INEXISTENTE) e volta com o código.
    const ruim = venda(p, 3);
    ruim.itens_venda[0]!.produto_id = uuidv7();
    const v3 = evento(p, 'venda.finalizada', ruim);
    expect((await pushOk(p, [ab, v2, v3])).resultados.map((x) => x.status)).toEqual([
      'aplicado',
      'aplicado',
      'rejeitado',
    ]);
    // A sequência 4 se perdeu: a 5 chega fora de ordem e o supervisor declara a 4.
    const v5 = evento(p, 'venda.finalizada', venda(p, 5), 5);
    expect((await pushOk(p, [v5])).resultados.map((x) => x.status)).toEqual(['fora_de_ordem']);
    expect((await pushOk(p, [], declarar(4, 4))).proxima).toBe(5);
    expect((await pushOk(p, [v5])).resultados.map((x) => x.status)).toEqual(['aplicado']);
    await pushOk(outro, [abertura(outro)]);

    const eventos = await todas(p, 0, 2);
    expect(eventos.map((e) => [e.envelope.sequencia, e.envelope.tipo, e.status, e.lacuna])).toEqual([
      [1, 'caixa.aberto', 'aplicado', false],
      [2, 'venda.finalizada', 'aplicado', false],
      [3, 'venda.finalizada', 'erro', false],
      [4, 'terminal.lacuna', 'descartado', true],
      [5, 'venda.finalizada', 'aplicado', false],
    ]);
    // O envelope é o que o caixa mandou (mais o terminal da coluna), payload e hash iguais.
    for (const [enviado, recuperado] of [
      [ab, eventos[0]!],
      [v2, eventos[1]!],
      [v3, eventos[2]!],
      [v5, eventos[4]!],
    ] as const) {
      expect(recuperado.envelope).toEqual({ ...enviado, terminal_id: p.terminal });
    }
    expect(eventos[1]!.versao_nuvem_fim).toBeGreaterThanOrEqual(eventos[1]!.versao_nuvem!);
    expect(eventos[1]!.resultado).toEqual(expect.any(Object));
    expect(eventos[2]).toMatchObject({ resultado: null, erro: { codigo: 'REFERENCIA_INEXISTENTE' } });
    expect(eventos[3]).toMatchObject({
      versao_nuvem: null,
      resultado: { descartado: true, lacuna: { de: 4, ate: 4 } },
      envelope: { agregado_tipo: 'terminal', agregado_id: p.terminal, usuario_id: null },
    });
    expect(eventos[3]!.envelope.payload).toMatchObject({ lacuna: { de: 4, ate: 4 } });

    // A situação é a mesma do `eventos-status` (uma função só, `situacaoNaNuvem`): o evento recusado e descartado no ERP
    // guarda o `resultado` do erro, e os dois devolvem `{ descartado, justificativa }`.
    await consultar(
      emp.nomeBanco,
      `update eventos_recebidos set status = 'descartado', descartado_em = now(), justificativa_descarte = 'venda duplicada'
        where evento_id = $1`,
      [v3.evento_id],
    );
    const [descartado] = (await recuperarOk(p, 2, 1)).eventos;
    const st = await amb.http().get(`/sync/eventos-status?ids=${v3.evento_id}`).set(cabecalhos(p.token));
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    const { evento_id, ...situacao } = st.body.eventos[0];
    expect(evento_id).toBe(v3.evento_id);
    expect(descartado).toMatchObject(situacao);
    expect(descartado!.resultado).toEqual({ descartado: true, justificativa: 'venda duplicada' });

    // A página: `ultima_recebida` é a maior sequência (placeholder incluído); a última página não tem mais.
    const primeira = await recuperarOk(p, 0, 2);
    expect(primeira).toMatchObject({ desde_sequencia: 0, ultima_recebida: 5, tem_mais: true });
    expect(await recuperarOk(p, 3, 2)).toMatchObject({ ultima_recebida: 5, tem_mais: false });
    const fim = await recuperarOk(p, 5);
    expect(fim).toMatchObject({ desde_sequencia: 5, ultima_recebida: 5, tem_mais: false, eventos: [] });
    // Padrão de 50 por página e nada do outro terminal.
    expect((await recuperarOk(p, 0)).eventos).toHaveLength(5);
    expect((await recuperarOk(outro, 0)).eventos.map((e) => e.envelope.evento_id)).not.toContain(
      ab.evento_id,
    );
    expect((await recuperarOk(outro, 0)).ultima_recebida).toBe(1);
  });

  it('payload anulado volta nulo; linha anterior à 0010 é remontada das colunas', async () => {
    const p = await novoPonto();
    const ab = abertura(p);
    const v2 = evento(p, 'venda.finalizada', venda(p, 2));
    await pushOk(p, [ab, v2]);
    // MD 3.15.2: o payload é anulado aos 13 meses; a 0010 trouxe o envelope (as linhas antigas ficaram com `{}`).
    await consultar(emp.nomeBanco, 'update eventos_recebidos set payload = null where evento_id = $1', [
      ab.evento_id,
    ]);
    await consultar(emp.nomeBanco, `update eventos_recebidos set envelope = '{}' where evento_id = $1`, [
      v2.evento_id,
    ]);
    const [e1, e2] = (await recuperarOk(p, 0)).eventos;
    expect(e1!.envelope.payload).toBeNull();
    expect(e1!.envelope.payload_sha256).toBe(ab.payload_sha256);
    expect(e2!.envelope).toEqual({
      evento_id: v2.evento_id,
      terminal_id: p.terminal,
      sequencia: 2,
      tipo: 'venda.finalizada',
      versao_schema: 1,
      agregado_tipo: v2.agregado_tipo,
      agregado_id: v2.agregado_id,
      dependencias: [],
      ocorrido_em: new Date(v2.ocorrido_em).toISOString(),
      usuario_id: null,
      contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: p.numero },
      payload: v2.payload,
      payload_sha256: v2.payload_sha256,
    });
  });

  it('valida a query e aceita os estados da 3.8: hardware divergente 409, suspensa 200, desativando 200, revogado 401', async () => {
    const p = await novoPonto();
    await pushOk(p, [abertura(p)]);
    for (const ruim of [
      '',
      'desde_sequencia=-1',
      'desde_sequencia=1&limite=0',
      'desde_sequencia=1&limite=201',
    ]) {
      const r = await recuperar(p, ruim);
      expect(r.status, `${ruim}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.erro.codigo).toBe('REQUISICAO_INVALIDA');
    }
    expect((await recuperarOk(p, 0, 200)).eventos).toHaveLength(1);

    // SYNC 20.5: os payloads têm dados de clientes; outra máquina com o token não os lê.
    const outroHw = await recuperar(p, 'desde_sequencia=0', { 'X-Genesis-Id-Hardware': 'f'.repeat(64) });
    expect(outroHw.status, JSON.stringify(outroHw.body)).toBe(409);
    expect(outroHw.body.erro.codigo).toBe('HARDWARE_ALTERADO');

    // T41: com a empresa suspensa o recuperar responde, como o push (o banco restaurado reidrata e o push volta); o
    // estado continua recusado.
    await amb.servicos.provisionamento.alterarStatus(emp.codigo, 'suspender', 'inadimplência');
    try {
      expect((await recuperarOk(p, 0)).eventos).toHaveLength(1);
      const estado = await amb.http().get('/sync/estado').set(cabecalhos(p.token));
      expect(estado.status).toBe(403);
      expect(estado.body.erro.codigo).toBe('EMPRESA_SUSPENSA');
    } finally {
      await amb.servicos.provisionamento.alterarStatus(emp.codigo, 'reativar', null);
    }

    const des = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set(bearer())
      .send({ modo: 'aceitar_pendencias' });
    expect(des.status, JSON.stringify(des.body)).toBe(200);
    expect((await recuperarOk(p, 0)).eventos).toHaveLength(1);

    const rev = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set(bearer())
      .send({ modo: 'imediato', confirmacaoCaixa: p.numero });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const r = await recuperar(p, 'desde_sequencia=0');
    expect(r.status).toBe(401);
    expect(r.body.erro.codigo).toBe('TERMINAL_REVOGADO');
  });
});
