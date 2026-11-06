/**
 * Lacunas de sequência (bloco C15 da Fase 1C; SYNC 7.4, 8.1, 8.6), pelo push real. Um teste por critério do plano —
 * `declarar_lacuna` com a liberação conferida (placeholders `terminal.lacuna` já entregues e sem `entidades_evento`,
 * alerta `LACUNA_DECLARADA`, repetição idempotente, faixa fora da esperada recusada); o evento real numa sequência de
 * placeholder sem a autorização (`lacuna_recuperavel`, não regressão) e com ela (substituição na mesma linha antes da
 * regressão, auditoria `lacuna_substituida`, `LACUNA_RECUPERADA`, `LACUNA_DECLARADA` resolvido e o reprocessamento em
 * ordem do que ficou com erro por causa da lacuna). Cada teste usa um caixa e um terminal só seus (`novoPonto`).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONTRATOS_EVENTOS,
  jcs,
  respostaHeartbeatSchema,
  respostaPushSchema,
  type Ativar,
  type Dashboard,
  type TerminalDetalhe,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let tokenAdmin: string;
/** O Master (admin): tem `pdv.config.fiscal`, que no perfil padrão é só do Master. */
let admin: string;
/** Perfil supervisor do PDV: libera no caixa, mas sem `pdv.config.fiscal`. */
let supervisor: string;
let dinheiro: string;
let produto: string;

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const linhasDoTerminal = (p: Ponto) =>
  consultar<{
    id: string;
    evento_id: string;
    sequencia_terminal: string;
    tipo: string;
    status: string;
    erro_codigo: string | null;
    resolucao_entregue_em: Date | null;
    descartado_por_id: string | null;
    payload: Payload;
    criado_em: Date;
  }>(
    emp.nomeBanco,
    `select id, evento_id, sequencia_terminal, tipo, status, erro_codigo, resolucao_entregue_em, descartado_por_id,
            payload, criado_em
       from eventos_recebidos where terminal_id = $1 order by sequencia_terminal`,
    [p.terminal],
  );

const alertasDoTerminal = (p: Ponto, tipo: string) =>
  consultar<{ severidade: string; resolvido_em: Date | null; dados: Payload; titulo: string }>(
    emp.nomeBanco,
    `select severidade, resolvido_em, dados, titulo from alertas
      where tipo = $1 and dados ->> 'terminal_id' = $2 order by criado_em`,
    [tipo, p.terminal],
  );

const heartbeat = async (p: Ponto) => {
  const r = await amb.http().post('/sync/heartbeat').set(cabecalhos(p.token)).send({ eventos_pendentes: 0 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return respostaHeartbeatSchema.parse(r.body);
};

beforeAll(async () => {
  amb = await criarAmbiente({ env: { FILA_TRABALHADOR: 'true', DASHBOARD_CACHE_MS: '0' } });
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  [{ id: admin }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  supervisor = await criarUsuario(emp.nomeBanco, {
    login: 'supervisor',
    perfil: 'supervisor_caixa',
    lojas: [loja],
  });
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

describe('Declarar lacuna (SYNC 8.6)', () => {
  it('só com pdv.config.fiscal e a partir da esperada; grava placeholders entregues, alerta e repete sem efeito', async () => {
    const p = await novoPonto();
    const ab = abertura(p);
    expect((await pushOk(p, [ab])).resultados.map((x) => x.status)).toEqual(['aplicado']);
    // O caixa perdeu as sequências 2 e 3: a 4 chega fora de ordem e a nuvem diz que espera a 2.
    const v4 = evento(p, 'venda.finalizada', venda(p, 4), 4);
    const fora = await pushOk(p, [v4]);
    expect(fora.resultados.map((x) => x.status)).toEqual(['fora_de_ordem']);
    expect(fora.proxima).toBe(2);

    // A liberação é conferida antes de qualquer gravação: o supervisor sem pdv.config.fiscal não declara.
    const semPermissao = await push(p, [], declarar(2, 3, supervisor));
    expect(semPermissao.status, JSON.stringify(semPermissao.body)).toBe(422);
    expect(semPermissao.body.erro.codigo).toBe('LIBERACAO_INVALIDA');
    // A faixa tem de começar na esperada: começar depois deixaria outra lacuna antes.
    const depois = await push(p, [], declarar(3, 3));
    expect(depois.status, JSON.stringify(depois.body)).toBe(409);
    expect(depois.body.erro).toMatchObject({
      codigo: 'LACUNA_INVALIDA',
      detalhes: { proxima_sequencia_esperada: 2 },
    });
    // Nem cobrir sequência já recebida.
    const antes = await push(p, [], declarar(1, 3));
    expect(antes.status).toBe(409);
    expect((await linhasDoTerminal(p)).map((l) => l.sequencia_terminal)).toEqual(['1']);

    const ok = await pushOk(p, [], declarar(2, 3));
    expect(ok).toEqual({ resultados: [], proxima: 4 });
    const linhas = await linhasDoTerminal(p);
    expect(linhas.map((l) => [l.sequencia_terminal, l.tipo, l.status])).toEqual([
      ['1', 'caixa.aberto', 'aplicado'],
      ['2', 'terminal.lacuna', 'descartado'],
      ['3', 'terminal.lacuna', 'descartado'],
    ]);
    const [ph2] = linhas.filter((l) => l.tipo === 'terminal.lacuna');
    expect(ph2).toMatchObject({
      descartado_por_id: admin,
      payload: { lacuna: { de: 2, ate: 3 }, motivo: 'banco_local_perdido', autorizado_por_id: admin },
    });
    // Já entregues (o heartbeat não os manda como "descartado") e sem entidades (nada depende deles).
    expect(linhas.filter((l) => l.tipo === 'terminal.lacuna').every((l) => l.resolucao_entregue_em)).toBe(
      true,
    );
    const entidades = await consultar(
      emp.nomeBanco,
      `select 1 from entidades_evento where evento_id = any($1::uuid[])`,
      [linhas.filter((l) => l.tipo === 'terminal.lacuna').map((l) => l.evento_id)],
    );
    expect(entidades).toEqual([]);
    expect((await heartbeat(p)).eventos_resolvidos).toEqual([]);

    const [alerta] = await alertasDoTerminal(p, 'LACUNA_DECLARADA');
    expect(alerta).toMatchObject({
      severidade: 'critico',
      resolvido_em: null,
      dados: { de: 2, ate: 3, quantidade: 2, motivo: 'banco_local_perdido', autorizado_por_id: admin },
    });
    // No detalhe do terminal (ERP 12.4) e no painel de alertas críticos do Dashboard (C14).
    const d = await amb.http().get(`/api/terminais/${p.terminal}`).set(bearer());
    expect((d.body as TerminalDetalhe).alertas.map((a) => a.tipo)).toContain('LACUNA_DECLARADA');
    const dash = (await amb.http().get('/api/dashboard').set(bearer())).body as Dashboard;
    expect(dash.alertasCriticos?.porTipo.map((t) => t.tipo)).toContain('LACUNA_DECLARADA');

    // Reenvio sem resposta: a mesma declaração não grava de novo.
    expect(await pushOk(p, [], declarar(2, 3))).toEqual({ resultados: [], proxima: 4 });
    expect(await linhasDoTerminal(p)).toHaveLength(3);
    expect(await alertasDoTerminal(p, 'LACUNA_DECLARADA')).toHaveLength(1);

    // A fila anda: o evento seguinte é aplicado.
    expect((await pushOk(p, [v4])).resultados.map((x) => x.status)).toEqual(['aplicado']);

    // "Ciente": a perda conferida com o caixa fecha o alerta.
    const a = (d.body as TerminalDetalhe).alertas.find((x) => x.tipo === 'LACUNA_DECLARADA')!;
    const ciente = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/alertas/${a.id}/resolver`)
      .set(bearer())
      .send({ resolucao: 'Vendas conferidas com o operador' });
    expect(ciente.status, JSON.stringify(ciente.body)).toBeLessThan(300);
    expect((await alertasDoTerminal(p, 'LACUNA_DECLARADA'))[0]!.resolvido_em).not.toBeNull();
  });

  it('quem tem pdv.config.fiscal mas perdeu a loja do caixa não libera a declaração nem a recuperação', async () => {
    const p = await novoPonto();
    // O supervisor tem a permissão (ajuste individual) e só a loja 2: o caixa da loja 1 ainda tinha o PIN dele.
    const loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
    const fiscal = await criarUsuario(emp.nomeBanco, {
      login: 'fiscal_loja2',
      perfil: 'supervisor_caixa',
      lojas: [loja2],
    });
    await consultar(
      emp.nomeBanco,
      'insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, $2, $3)',
      [fiscal, 'pdv.config.fiscal', 'conceder'],
    );
    expect((await pushOk(p, [evento(p, 'venda.finalizada', venda(p, 2), 2)])).proxima).toBe(1);

    for (const extra of [
      declarar(1, 1, fiscal),
      { recuperar_lacuna: { de: 1, ate: 1, autorizado_por_id: fiscal } },
    ]) {
      const r = await push(p, 'declarar_lacuna' in extra ? [] : [abertura(p, 1)], extra);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.erro).toMatchObject({ codigo: 'LIBERACAO_INVALIDA', detalhes: { loja_id: loja } });
      expect(r.body.erro.mensagem).toContain('acesso à loja');
    }
    expect(await linhasDoTerminal(p)).toEqual([]);

    // Com a loja de volta, a mesma liberação passa.
    await consultar(emp.nomeBanco, 'insert into usuarios_lojas (usuario_id, loja_id) values ($1, $2)', [
      fiscal,
      loja,
    ]);
    expect((await pushOk(p, [], declarar(1, 1, fiscal))).proxima).toBe(2);
  });

  it('lote sem eventos e sem declaração é recusado', async () => {
    const p = await novoPonto();
    const r = await push(p, []);
    expect(r.status).toBe(400);
    expect(r.body.erro.codigo).toBe('REQUISICAO_INVALIDA');
  });
});

describe('Lacuna recuperada (SYNC 8.6)', () => {
  it('sem a autorização é lacuna_recuperavel; com ela substitui o placeholder, aplica e reprocessa em ordem', async () => {
    const p = await novoPonto();
    // A abertura (sequência 1) se perdeu: a venda (2) chega fora de ordem, a lacuna é declarada e a venda vai a erro
    // SESSAO_INEXISTENTE (a sessão nunca chegou).
    const ab = abertura(p, 1);
    const v = venda(p, 1);
    const ev = evento(p, 'venda.finalizada', v, 2);
    expect((await pushOk(p, [ev])).resultados.map((x) => x.status)).toEqual(['fora_de_ordem']);
    expect((await pushOk(p, [], declarar(1, 1))).proxima).toBe(2);
    const r1 = await pushOk(p, [ev]);
    expect(r1.resultados).toMatchObject([{ status: 'rejeitado', erro: { codigo: 'SESSAO_INEXISTENTE' } }]);

    // Achou a abertura (backup em pendrive): sem a liberação, não é regressão, é lacuna recuperável e o lote para.
    const sem = await pushOk(p, [ab, ev]);
    expect(sem.resultados).toMatchObject([
      {
        status: 'lacuna_recuperavel',
        erro: { codigo: 'LACUNA_RECUPERAVEL' },
        resultado: { lacuna: { de: 1, ate: 1 } },
      },
      { status: 'nao_processado' },
    ]);
    expect((await linhasDoTerminal(p))[0]).toMatchObject({ tipo: 'terminal.lacuna', status: 'descartado' });
    // A declaração foi "na segunda": o placeholder fica com essa hora até a substituição.
    await consultar(
      emp.nomeBanco,
      `update eventos_recebidos set criado_em = now() - interval '3 days'
        where terminal_id = $1 and sequencia_terminal = 1`,
      [p.terminal],
    );
    // A liberação de quem não tem pdv.config.fiscal recusa o lote inteiro.
    const negada = await push(p, [ab], {
      recuperar_lacuna: { de: 1, ate: 1, autorizado_por_id: supervisor },
    });
    expect(negada.status).toBe(422);

    const chegada = Date.now();
    const com = await pushOk(p, [ab], { recuperar_lacuna: { de: 1, ate: 1, autorizado_por_id: admin } });
    expect(com.resultados.map((x) => x.status)).toEqual(['aplicado']);
    const [l1] = await linhasDoTerminal(p);
    // Mesma linha e mesma sequência, agora com o evento real; o criado_em passa a ser a chegada do lote do evento real
    // (F2-B10: a hora de chegada do detalhe do acerto), e a da declaração fica na auditoria.
    expect(l1).toMatchObject({ evento_id: ab.evento_id, tipo: 'caixa.aberto', status: 'aplicado' });
    expect(l1!.criado_em.getTime()).toBeGreaterThanOrEqual(chegada - 1000);
    const [aud] = await consultar<{
      acao: string;
      origem: string;
      autorizado_por_id: string;
      antes: Payload;
    }>(
      emp.nomeBanco,
      `select acao, origem, autorizado_por_id, antes from auditoria
        where evento_id = $1 and acao = 'lacuna_substituida'`,
      [ab.evento_id],
    );
    expect(aud).toMatchObject({
      origem: 'pdv',
      autorizado_por_id: admin,
      antes: { tipo: 'terminal.lacuna', payload: { lacuna: { de: 1, ate: 1 } } },
    });
    expect(chegada - Date.parse(aud!.antes.declarada_em as string)).toBeGreaterThan(2 * 86_400_000);
    expect((await alertasDoTerminal(p, 'LACUNA_DECLARADA'))[0]!.resolvido_em).not.toBeNull();
    expect(await alertasDoTerminal(p, 'LACUNA_RECUPERADA')).toMatchObject([
      { severidade: 'aviso', resolvido_em: null, dados: { eventos: 1, sequencias: [1] } },
    ]);

    // A venda que ficou com erro por causa da lacuna é reprocessada em ordem (tarefa) e o PDV recebe no heartbeat.
    const fim = Date.now() + 30_000;
    let status = '';
    while (Date.now() < fim) {
      status = (await linhasDoTerminal(p))[1]!.status;
      if (status === 'aplicado') break;
      await esperar(200);
    }
    expect(status).toBe('aplicado');
    const [venda1] = await consultar<{ numero_exibicao: string }>(
      emp.nomeBanco,
      'select numero_exibicao from vendas where id = $1',
      [v.vendas.id],
    );
    expect(venda1?.numero_exibicao).toBe(v.vendas.numero_exibicao);
    const [reprocessado] = await consultar<{ origem: string; depois: Payload }>(
      emp.nomeBanco,
      `select origem, depois from auditoria where evento_id = $1 and acao = 'evento_reprocessado'`,
      [ev.evento_id],
    );
    expect(reprocessado).toMatchObject({ origem: 'pdv', depois: { status: 'aplicado', modo: 'lacuna' } });
    const [erroAberto] = await consultar<{ resolvido_em: Date | null }>(
      emp.nomeBanco,
      `select resolvido_em from alertas where tipo = 'EVENTO_COM_ERRO' and dados ->> 'evento_id' = $1`,
      [ev.evento_id],
    );
    expect(erroAberto?.resolvido_em).not.toBeNull();
    expect((await heartbeat(p)).eventos_resolvidos.map((e) => [e.evento_id, e.status])).toEqual([
      [ev.evento_id, 'aplicado'],
    ]);

    // Reenvio do mesmo evento: duplicado (já não é placeholder).
    expect((await pushOk(p, [ab])).resultados.map((x) => x.status)).toEqual(['duplicado']);
  });

  it('recuperação parcial, recuperado com erro e reprocessamento em ordem só do que a lacuna explica', async () => {
    const p = await novoPonto();
    // Perdidas: a abertura (1) e uma venda de outra sessão (2). Chegam 3 e 4 (vendas da sessão perdida, que vão a
    // SESSAO_INEXISTENTE) e 5 (venda da mesma sessão com o payload_sha256 divergente: PAYLOAD_INVALIDO).
    const ab = abertura(p, 1);
    const outra = venda({ ...p, sessao: uuidv7() }, 9);
    const v2 = evento(p, 'venda.finalizada', outra, 2);
    const v3 = evento(p, 'venda.finalizada', venda(p, 1), 3);
    const v4 = evento(p, 'venda.finalizada', venda(p, 2), 4);
    const v5 = { ...evento(p, 'venda.finalizada', venda(p, 3), 5), payload_sha256: 'f'.repeat(64) };
    expect((await pushOk(p, [v3])).proxima).toBe(1);
    expect((await pushOk(p, [], declarar(1, 2))).proxima).toBe(3);
    expect((await pushOk(p, [v3, v4, v5])).resultados.map((x) => x.erro?.codigo)).toEqual([
      'SESSAO_INEXISTENTE',
      'SESSAO_INEXISTENTE',
      'PAYLOAD_INVALIDO',
    ]);

    // Lote 1: só a abertura. O LACUNA_DECLARADA fica aberto e o recuperado diz quanto falta.
    const liberacao = { recuperar_lacuna: { de: 1, ate: 2, autorizado_por_id: admin } };
    expect((await pushOk(p, [ab], liberacao)).resultados.map((x) => x.status)).toEqual(['aplicado']);
    expect((await alertasDoTerminal(p, 'LACUNA_DECLARADA'))[0]!.resolvido_em).toBeNull();
    const [parcial] = await consultar<{ mensagem: string; dados: Payload }>(
      emp.nomeBanco,
      `select mensagem, dados from alertas where tipo = 'LACUNA_RECUPERADA' and dados ->> 'terminal_id' = $1`,
      [p.terminal],
    );
    expect(parcial!.dados).toMatchObject({
      faixas: [{ de: 1, ate: 2, restantes: 1 }],
      eventos: 1,
      com_erro: 0,
    });
    expect(parcial!.mensagem).toContain('Ainda faltam 1 evento(s)');

    // A tarefa reprocessa 3 e 4, nessa ordem; a 5 (hash divergente) continua esperando a decisão no ERP.
    const fim = Date.now() + 30_000;
    let linhas = await linhasDoTerminal(p);
    while (Date.now() < fim && !(linhas[2]!.status === 'aplicado' && linhas[3]!.status === 'aplicado')) {
      await esperar(200);
      linhas = await linhasDoTerminal(p);
    }
    expect(linhas.slice(2).map((l) => [l.sequencia_terminal, l.status, l.erro_codigo])).toEqual([
      ['3', 'aplicado', null],
      ['4', 'aplicado', null],
      ['5', 'erro', 'PAYLOAD_INVALIDO'],
    ]);
    const reprocessados = await consultar<{ evento_id: string }>(
      emp.nomeBanco,
      `select evento_id from auditoria where acao = 'evento_reprocessado' and evento_id = any($1::uuid[])
        order by ocorrido_em, id`,
      [[v3.evento_id, v4.evento_id, v5.evento_id]],
    );
    expect(reprocessados.map((r) => r.evento_id)).toEqual([v3.evento_id, v4.evento_id]);

    // Lote 2: a venda 2 é de uma sessão que a nuvem nunca recebeu. O erro de regra desfaz a troca e a transação que
    // grava o erro substitui o placeholder de novo: a linha fica em erro com o evento real e a auditoria.
    const r2 = await pushOk(p, [v2], liberacao);
    expect(r2.resultados).toMatchObject([{ status: 'rejeitado', erro: { codigo: 'SESSAO_INEXISTENTE' } }]);
    const l2 = (await linhasDoTerminal(p))[1]!;
    expect(l2).toMatchObject({
      evento_id: v2.evento_id,
      tipo: 'venda.finalizada',
      status: 'erro',
      erro_codigo: 'SESSAO_INEXISTENTE',
    });
    const substituida = await consultar<{ registro_id: string; autorizado_por_id: string }>(
      emp.nomeBanco,
      `select registro_id, autorizado_por_id from auditoria where evento_id = $1 and acao = 'lacuna_substituida'`,
      [v2.evento_id],
    );
    expect(substituida).toEqual([{ registro_id: l2.id, autorizado_por_id: admin }]);
    expect((await alertasDoTerminal(p, 'LACUNA_DECLARADA'))[0]!.resolvido_em).not.toBeNull();
    const recuperados = await alertasDoTerminal(p, 'LACUNA_RECUPERADA');
    expect(recuperados.map((a) => a.dados)).toMatchObject([
      { com_erro: 0 },
      { faixas: [{ de: 1, ate: 2, restantes: 0 }], sequencias: [2], com_erro: 1 },
    ]);
    // Nada mais a reprocessar depois do lote 2 (a 5 não é da lacuna e a 2 é do próprio lote): nenhuma tarefa nova.
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from tarefas where tipo = 'reprocessar_apos_lacuna' and parametros ->> 'terminalId' = $1`,
      [p.terminal],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('sequência abaixo da esperada fora de placeholder continua sendo regressão', async () => {
    const p = await novoPonto();
    expect((await pushOk(p, [abertura(p)])).resultados.map((x) => x.status)).toEqual(['aplicado']);
    const r = await push(p, [abertura({ ...p, sessao: uuidv7() }, 1)], {
      recuperar_lacuna: { de: 1, ate: 1, autorizado_por_id: admin },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.erro.codigo).toBe('REGRESSAO_DETECTADA');
  });
});
