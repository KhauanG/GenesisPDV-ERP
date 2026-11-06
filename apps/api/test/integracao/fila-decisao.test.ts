/**
 * Fila de decisão do ERP (bloco C8 da Fase 1C; ERP 12.5; SYNC 8.5, 11.2–11.4, 13.1), pelo push real e pelas rotas do
 * ERP. Um teste por critério do plano — reprocessar com os dependentes (na ordem da sequência, também numa cadeia);
 * descartar com os dependentes (`DEPENDENCIA_DESCARTADA`, confirmação pelo número); aplicar com novo número; o alerta
 * `EVENTO_COM_ERRO` abrir e fechar; a concorrência com o push do mesmo terminal; reprocessar de terminal revogado (D20)
 * — e também: o reprocessamento que falha de novo, o lote por código numa tarefa, a listagem paginada com o resumo do
 * agregado, a permissão, o resultado no heartbeat, a rede de segurança do `GET /sync/eventos-status` e o painel de
 * alertas críticos do Dashboard (C14), com o `EVENTO_DIVERGENTE` resolvido no "Ciente" do terminal. Cada teste usa um caixa e um terminal só seus (`novoPonto`): roda
 * sozinho (`-t`) e em qualquer ordem.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONTRATOS_EVENTOS,
  jcs,
  MAXIMO_IDS_EVENTOS_STATUS,
  respostaEventosStatusSchema,
  respostaHeartbeatSchema,
  respostaPushSchema,
  type Ativar,
  type Dashboard,
  type EventoComErro,
  type ListagemEventosComErro,
  type ResultadoReprocessamento,
  type TerminalDetalhe,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INICIO_FAIXA_RENUMERACAO } from '../../src/sync/handlers/vendas.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let tokenAdmin: string;
let operador: string;
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

/** Um caixa com o seu terminal ativado pelo `/sync/ativar` real; a sessão nasce com o `caixa.aberto` do teste. */
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

/**
 * Envelope com o agregado do contrato (C4). `hashErrado`: o `payload_sha256` não confere com o JCS (SYNC 8.1) e o
 * evento vai a `erro` `PAYLOAD_INVALIDO` sem aplicar — o "bug de serialização" que o suporte resolve reprocessando.
 */
function evento(p: Ponto, tipo: string, payload: Payload, opcoes: { hashErrado?: boolean } = {}) {
  const contrato = (
    CONTRATOS_EVENTOS as Record<string, { agregadoTipo: string; agregadoId(x: unknown): string }>
  )[tipo];
  return {
    evento_id: uuidv7(),
    sequencia: ++p.seq,
    tipo,
    versao_schema: 1,
    agregado_tipo: contrato?.agregadoTipo ?? 'auditoria',
    agregado_id: contrato ? contrato.agregadoId(payload) : uuidv7(),
    dependencias: [],
    ocorrido_em: agora(),
    relogio_confiavel: true,
    usuario_id: operador,
    contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256')
      .update(`${jcs(payload)}${opcoes.hashErrado ? 'x' : ''}`, 'utf8')
      .digest('hex'),
  };
}

const push = (p: Ponto, eventos: unknown[]) =>
  amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: uuidv7(), terminal_id: p.terminal, enviado_em: agora(), eventos });

type Resultado = { status: string; erro?: { codigo: string }; resultado?: Record<string, unknown> };

async function pushOk(p: Ponto, eventos: unknown[]): Promise<Resultado[]> {
  const r = await push(p, eventos);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Resultado[];
}

const abertura = (p: Ponto, opcoes: { hashErrado?: boolean; abertaEm?: string } = {}) =>
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
        aberta_em: opcoes.abertaEm ?? horasAtras(5),
        fundo_troco: '0.00',
      },
      movimentos_caixa: [],
    },
    opcoes,
  );

/** Uma venda finalizada de um item (10,00 em dinheiro), só com o que o contrato exige (C4). */
function venda(p: Ponto, opcoes: { numero?: number; produto?: string } = {}) {
  const id = uuidv7();
  const numero = opcoes.numero ?? ++p.venda;
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
      operador_id: operador,
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
        produto_id: opcoes.produto ?? produto,
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

type Venda = ReturnType<typeof venda>;

/** Forma A (SYNC 9.9 A) da venda `v`: devolvido em dinheiro, com o `estorno_venda` na sessão do ponto. */
function cancelamento(p: Ponto, v: Venda) {
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

const sangria = (p: Ponto, valor: string) => ({
  movimentos_caixa: {
    id: uuidv7(),
    sessao_caixa_id: p.sessao,
    ...linhaDoPonto(p),
    tipo: 'sangria',
    forma_pagamento_id: null,
    valor,
    operador_id: operador,
    quem_retira_usuario_id: null,
    quem_retira_nome: 'GERENTE',
    observacao: null,
    inf_adicionais: null,
    ocorrido_em: horasAtras(0.5),
    autorizado_por_id: null,
    troca_id: null,
  },
  dinheiro_estimado_antes: null,
  contagem_cedulas: null,
});

const fila = async (p: Ponto, query = '', tk = tokenAdmin): Promise<ListagemEventosComErro> => {
  const r = await amb.http().get(`/api/terminais/${p.terminal}/eventos-erro${query}`).set(bearer(tk));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ListagemEventosComErro;
};

const linhaDaFila = async (p: Ponto, eventoId: string): Promise<EventoComErro> => {
  const item = (await fila(p)).itens.find((e) => e.eventoId === eventoId);
  expect(item, `evento ${eventoId} fora da fila`).toBeDefined();
  return item!;
};

const acao = (id: string, nome: string, corpo: Payload = {}, tk = tokenAdmin) =>
  amb.http().post(`/api/eventos-recebidos/${id}/${nome}`).set(bearer(tk)).send(corpo);

const linhaRecebida = async (eventoId: string) =>
  (
    await consultar<{
      id: string;
      status: string;
      erro_codigo: string | null;
      tentativas: number;
      resolucao_entregue_em: Date | null;
      descartado_por_id: string | null;
      justificativa_descarte: string | null;
    }>(
      emp.nomeBanco,
      `select id, status, erro_codigo, tentativas, resolucao_entregue_em, descartado_por_id, justificativa_descarte
         from eventos_recebidos where evento_id = $1`,
      [eventoId],
    )
  )[0]!;

const alertasDoEvento = (eventoId: string) =>
  consultar<{ tipo: string; severidade: string; resolvido_em: Date | null; resolucao: string | null }>(
    emp.nomeBanco,
    `select tipo, severidade, resolvido_em, resolucao from alertas
      where dados ->> 'evento_id' = $1 order by criado_em`,
    [eventoId],
  );

const auditorias = (eventoId: string) =>
  consultar<{ acao: string; usuario_id: string | null; descricao: string; depois: Payload }>(
    emp.nomeBanco,
    'select acao, usuario_id, descricao, depois from auditoria where evento_id = $1 and origem = $2 order by id',
    [eventoId, 'erp'],
  );

/** Alertas abertos do terminal no detalhe (ERP 12.4) e na listagem (12.2), que mostram também os da fila (11.3–11.4). */
const alertasDoTerminal = async (p: Ponto) => {
  const d = await amb.http().get(`/api/terminais/${p.terminal}`).set(bearer());
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  const l = await amb.http().get('/api/terminais?conexao=todos').set(bearer());
  expect(l.status, JSON.stringify(l.body)).toBe(200);
  const naListagem = (l.body.alertas as TerminalDetalhe['alertas']).filter(
    (a) => a.terminalId === p.terminal,
  );
  expect(naListagem).toEqual((d.body as TerminalDetalhe).alertas);
  return (d.body as TerminalDetalhe).alertas;
};

const heartbeat = async (p: Ponto) => {
  const r = await amb
    .http()
    .post('/sync/heartbeat')
    .set(cabecalhos(p.token))
    .send({ eventos_pendentes: 0, operador_id: operador });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return respostaHeartbeatSchema.parse(r.body);
};

/** `GET /sync/eventos-status` (SYNC 7.2, 21.1; C14). */
const eventosStatus = (p: Ponto, ids: string[], extra: Record<string, string> = {}) =>
  amb
    .http()
    .get(`/sync/eventos-status?ids=${ids.join(',')}`)
    .set({ ...cabecalhos(p.token), ...extra });

async function eventosStatusOk(p: Ponto, ids: string[]) {
  const r = await eventosStatus(p, ids);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return respostaEventosStatusSchema.parse(r.body).eventos;
}

beforeAll(async () => {
  amb = await criarAmbiente({ env: { FILA_TRABALHADOR: 'true', DASHBOARD_CACHE_MS: '0' } });
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
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

describe('Reprocessar (SYNC 8.5, 11.4)', () => {
  it('a abertura rejeitada segura a sessão; reprocessada, aplica os retidos em ordem e o PDV recebe no heartbeat', async () => {
    const p = await novoPonto();
    const ab = abertura(p, { hashErrado: true });
    const v1 = venda(p);
    const ev1 = evento(p, 'venda.finalizada', v1);
    // A forma A depende da venda (retida) e da sessão: é a cadeia da 8.5.
    const canc = evento(p, 'venda.cancelada', cancelamento(p, v1));
    const sg = evento(p, 'caixa.sangria', sangria(p, '5.00'));
    const r = await pushOk(p, [ab, ev1, canc, sg]);
    expect(r.map((x) => x.status)).toEqual(['rejeitado', 'retido', 'retido', 'retido']);

    // SYNC 11.3: o erro de caixa é crítico; os retidos não abrem alerta (quem decide é o bloqueador).
    expect(await alertasDoEvento(ab.evento_id)).toMatchObject([
      { tipo: 'EVENTO_COM_ERRO', severidade: 'critico', resolvido_em: null },
    ]);
    expect(await alertasDoEvento(ev1.evento_id)).toEqual([]);

    // ERP 12.5: listagem paginada, resumo do agregado e o que digitar para descartar.
    const lista = await fila(p);
    expect(lista).toMatchObject({
      total: 4,
      pagina: 1,
      codigos: [{ codigo: 'PAYLOAD_INVALIDO', quantidade: 1 }],
    });
    expect(lista.itens.map((e) => e.sequencia)).toEqual([1, 2, 3, 4]);
    expect(lista.itens[0]).toMatchObject({
      resumo: 'Abertura de caixa · fundo R$ 0,00',
      confirmacaoDescarte: '1',
    });
    expect(lista.itens[1]).toMatchObject({
      resumo: `Venda ${v1.vendas.numero_exibicao} · R$ 10,00 · 1 item`,
      confirmacaoDescarte: v1.vendas.numero_exibicao,
    });
    expect(lista.itens[3]).toMatchObject({ resumo: 'Sangria · R$ 5,00 · GERENTE' });
    const pagina2 = await fila(p, '?tamanho=3&pagina=2');
    expect(pagina2.itens.map((e) => e.sequencia)).toEqual([4]);
    expect((await fila(p, '?status=erro')).itens.map((e) => e.sequencia)).toEqual([1]);

    const linhaAb = await linhaDaFila(p, ab.evento_id);
    const rep = await acao(linhaAb.id, 'reprocessar');
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const res = rep.body as ResultadoReprocessamento;
    expect(res).toMatchObject({ status: 'aplicado', sequencia: 1, numero: null });
    expect(res.dependentes.map((d) => [d.sequencia, d.status])).toEqual([
      [2, 'aplicado'],
      [3, 'aplicado'],
      [4, 'aplicado'],
    ]);
    const vendaNuvem = await consultar<{ status: string }>(
      emp.nomeBanco,
      'select status from vendas where id = $1',
      [v1.vendas.id],
    );
    expect(vendaNuvem).toEqual([{ status: 'cancelada' }]);
    expect((await fila(p)).total).toBe(0);
    expect(await linhaRecebida(ab.evento_id)).toMatchObject({
      status: 'aplicado',
      tentativas: 2,
      resolucao_entregue_em: null,
    });
    expect(await alertasDoEvento(ab.evento_id)).toMatchObject([
      { tipo: 'EVENTO_COM_ERRO', resolucao: 'Reprocessado: aplicado' },
    ]);
    expect((await alertasDoEvento(ab.evento_id))[0]!.resolvido_em).not.toBeNull();
    // Todas auditadas (ERP 12.5): uma por evento reaplicado, com o modo.
    expect(await auditorias(ab.evento_id)).toMatchObject([
      { acao: 'evento_reprocessado', usuario_id: operador, depois: { status: 'aplicado', modo: 'manual' } },
    ]);
    expect(await auditorias(canc.evento_id)).toMatchObject([
      { acao: 'evento_reprocessado', depois: { status: 'aplicado', modo: 'dependente' } },
    ]);

    // SYNC 21.1: o resultado volta ao PDV no heartbeat, com os marcadores, até o ack.
    const hb = await heartbeat(p);
    expect(hb.eventos_resolvidos.map((e) => [e.evento_id, e.status])).toEqual([
      [ab.evento_id, 'aplicado'],
      [ev1.evento_id, 'aplicado'],
      [canc.evento_id, 'aplicado'],
      [sg.evento_id, 'aplicado'],
    ]);
    expect(hb.eventos_resolvidos[0]!.versao_nuvem_fim).toBeGreaterThan(0);

    // Resolvido: reprocessar de novo é 409 e não muda nada.
    expect((await acao(linhaAb.id, 'reprocessar')).status).toBe(409);
    expect((await linhaRecebida(ab.evento_id)).tentativas).toBe(2);
  });

  it('o que falha de novo continua na fila com tentativas somadas e um alerta aberto só', async () => {
    const p = await novoPonto();
    expect((await pushOk(p, [abertura(p)]))[0]!.status).toBe('aplicado');
    const ev = evento(p, 'venda.finalizada', venda(p, { produto: uuidv7() }));
    expect((await pushOk(p, [ev]))[0]).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'REFERENCIA_INEXISTENTE' },
    });
    const linha = await linhaDaFila(p, ev.evento_id);
    const r = await acao(linha.id, 'reprocessar');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'erro', erroCodigo: 'REFERENCIA_INEXISTENTE', dependentes: [] });
    expect(await linhaRecebida(ev.evento_id)).toMatchObject({ status: 'erro', tentativas: 2 });
    const abertos = (await alertasDoEvento(ev.evento_id)).filter((a) => a.resolvido_em === null);
    expect(abertos).toMatchObject([{ tipo: 'EVENTO_COM_ERRO', severidade: 'critico' }]);
    expect(await auditorias(ev.evento_id)).toMatchObject([
      { acao: 'evento_reprocessado', depois: { status: 'erro', erro_codigo: 'REFERENCIA_INEXISTENTE' } },
    ]);
  });

  it('sem terminais.gerenciar, as ações são 403; o resumo aparece mesmo sem o payload, sem dado pessoal', async () => {
    const p = await novoPonto();
    const ab = abertura(p, { hashErrado: true });
    const sg = evento(p, 'caixa.sangria', sangria(p, '200.00'));
    await pushOk(p, [ab, sg]);
    const sem = await criarUsuario(emp.nomeBanco, {
      login: `sem_gerenciar_${p.numero}`,
      perfil: 'gerente',
      lojas: [loja],
    });
    await consultar(
      emp.nomeBanco,
      `insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'terminais.gerenciar', 'negar')`,
      [sem],
    );
    const tk = await amb.entrar(emp.codigo, `sem_gerenciar_${p.numero}`, SENHA_TESTE);
    const [linha, linhaSg] = (await fila(p, '', tk)).itens as [EventoComErro, EventoComErro];
    expect(linha).toMatchObject({ payload: null, resumo: 'Abertura de caixa · fundo R$ 0,00' });
    // D19: o nome digitado de quem retira a sangria só vai a quem vê o payload.
    expect(linhaSg).toMatchObject({ eventoId: sg.evento_id, payload: null, resumo: 'Sangria · R$ 200,00' });
    expect((await linhaDaFila(p, sg.evento_id)).resumo).toBe('Sangria · R$ 200,00 · GERENTE');
    expect((await acao(linha.id, 'reprocessar', {}, tk)).status).toBe(403);
    expect(
      (await acao(linha.id, 'descartar', { justificativa: 'x'.repeat(20), confirmacao: '1' }, tk)).status,
    ).toBe(403);
    expect((await linhaRecebida(ab.evento_id)).status).toBe('erro');
  });
});

describe('Descartar (SYNC 8.5, 11.4)', () => {
  it('exige justificativa e o número; os retidos vão a DEPENDENCIA_DESCARTADA e o PDV recebe o descarte', async () => {
    const p = await novoPonto();
    const ab = abertura(p, { hashErrado: true });
    const v1 = venda(p);
    const ev1 = evento(p, 'venda.finalizada', v1);
    await pushOk(p, [ab, ev1]);
    const linhaAb = await linhaDaFila(p, ab.evento_id);

    const curta = await acao(linhaAb.id, 'descartar', { justificativa: 'curta demais', confirmacao: '1' });
    expect(curta.status).toBe(422);
    const semNumero = await acao(linhaAb.id, 'descartar', {
      justificativa: 'Caixa aberto em duplicidade pelo suporte',
    });
    expect(semNumero.status).toBe(422);
    expect(semNumero.body.campos.confirmacao).toEqual(['Digite 1 para confirmar']);
    expect(
      (
        await acao(linhaAb.id, 'descartar', {
          justificativa: 'Caixa aberto em duplicidade',
          confirmacao: '2',
        })
      ).status,
    ).toBe(422);

    const ok = await acao(linhaAb.id, 'descartar', {
      justificativa: '  Caixa aberto em duplicidade pelo suporte  ',
      confirmacao: ' 1 ',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      eventoId: ab.evento_id,
      dependentes: [{ eventoId: ev1.evento_id, sequencia: 2, tipo: 'venda.finalizada' }],
    });
    expect(await linhaRecebida(ab.evento_id)).toMatchObject({
      status: 'descartado',
      descartado_por_id: operador,
      justificativa_descarte: 'Caixa aberto em duplicidade pelo suporte',
      resolucao_entregue_em: null,
    });
    expect(await linhaRecebida(ev1.evento_id)).toMatchObject({
      status: 'erro',
      erro_codigo: 'DEPENDENCIA_DESCARTADA',
    });
    // O alerta do descartado fecha; o EVENTO_DESCARTADO abre (crítico); o dependente ganha o EVENTO_COM_ERRO dele.
    const doAb = await alertasDoEvento(ab.evento_id);
    expect(doAb.map((a) => [a.tipo, a.severidade, a.resolvido_em === null])).toEqual([
      ['EVENTO_COM_ERRO', 'critico', false],
      ['EVENTO_DESCARTADO', 'critico', true],
    ]);
    expect(await alertasDoEvento(ev1.evento_id)).toMatchObject([
      { tipo: 'EVENTO_COM_ERRO', severidade: 'critico', resolvido_em: null },
    ]);
    expect(await auditorias(ab.evento_id)).toMatchObject([
      {
        acao: 'evento_descartado',
        depois: { status: 'descartado', dependentes: [{ evento_id: ev1.evento_id }] },
      },
    ]);
    // ERP 12.5 ("venda nunca é descartada sem gerar alerta"): o descarte e o erro do dependente aparecem no detalhe e
    // na listagem do terminal, com o terminal tirado de `dados.terminal_id` (os dois na mesma transação: mesma hora).
    const caixa = String(p.numero).padStart(2, '0');
    expect((await alertasDoTerminal(p)).sort((x, y) => x.tipo.localeCompare(y.tipo))).toMatchObject([
      {
        tipo: 'EVENTO_COM_ERRO',
        severidade: 'critico',
        titulo: `Caixa ${caixa}: evento venda.finalizada com erro (DEPENDENCIA_DESCARTADA)`,
        terminalId: p.terminal,
      },
      {
        tipo: 'EVENTO_DESCARTADO',
        severidade: 'critico',
        titulo: `Caixa ${caixa}: evento caixa.aberto descartado`,
        terminalId: p.terminal,
      },
    ]);
    const hb = await heartbeat(p);
    expect(hb.eventos_resolvidos).toEqual([
      {
        evento_id: ab.evento_id,
        status: 'descartado',
        resultado: { descartado: true, justificativa: 'Caixa aberto em duplicidade pelo suporte' },
      },
    ]);

    // A venda: a confirmação é o número exibido (também só os dígitos do fim).
    const linhaVenda = await linhaDaFila(p, ev1.evento_id);
    expect(linhaVenda.confirmacaoDescarte).toBe(v1.vendas.numero_exibicao);
    expect(
      (
        await acao(linhaVenda.id, 'descartar', {
          justificativa: 'Venda de teste do treinamento',
          confirmacao: '1',
        })
      ).status,
    ).toBe(200);
    expect((await fila(p)).total).toBe(0);
    // O EVENTO_COM_ERRO fechou com o descarte; os dois EVENTO_DESCARTADO ficam até o "Ciente".
    const descartados = await alertasDoTerminal(p);
    expect(descartados.map((a) => a.tipo)).toEqual(['EVENTO_DESCARTADO', 'EVENTO_DESCARTADO']);
    const ciente = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/alertas/${descartados[0]!.id}/resolver`)
      .set(bearer())
      .send({ resolucao: 'Venda de treino conferida com o operador' });
    expect(ciente.status, JSON.stringify(ciente.body)).toBe(200);
    expect((ciente.body as TerminalDetalhe).alertas.map((a) => a.id)).toEqual([descartados[1]!.id]);
    // O "Ciente" de outro terminal não acha o alerta.
    const outro = await novoPonto();
    expect(
      (
        await amb
          .http()
          .post(`/api/terminais/${outro.terminal}/alertas/${descartados[1]!.id}/resolver`)
          .set(bearer())
          .send({ resolucao: 'Terminal errado' })
      ).status,
    ).toBe(404);
    // Descartar de novo: 409.
    expect(
      (
        await acao(linhaVenda.id, 'descartar', {
          justificativa: 'Venda de teste do treinamento',
          confirmacao: '1',
        })
      ).status,
    ).toBe(409);
  });

  it('payload com id de venda fora do formato UUID não trava a fila nem o descarte', async () => {
    const p = await novoPonto();
    await pushOk(p, [abertura(p)]);
    // Bug do PDV: a forma A (sem `numero_exibicao`) com `vendas.id` malformado; o envelope é válido.
    const v = venda(p);
    const ruim = cancelamento(p, v);
    ruim.vendas.id = 'abc';
    const ev = { ...evento(p, 'venda.cancelada', ruim), agregado_id: v.vendas.id };
    expect((await pushOk(p, [ev]))[0]).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'PAYLOAD_INVALIDO' },
    });
    const linha = await linhaDaFila(p, ev.evento_id);
    // Sem número (o id não chega à consulta): a confirmação é a sequência do evento.
    expect(linha).toMatchObject({
      resumo: 'Cancelamento da venda',
      confirmacaoDescarte: String(ev.sequencia),
    });
    const r = await acao(linha.id, 'descartar', {
      justificativa: 'Payload corrompido pelo serializador do caixa',
      confirmacao: String(ev.sequencia),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await linhaRecebida(ev.evento_id)).status).toBe('descartado');
  });

  it('evento que não é crítico: aviso e descarte sem número', async () => {
    const p = await novoPonto();
    const payload = { registros: [], logins: [] };
    const ev = { ...evento(p, 'auditoria.registros', payload, { hashErrado: true }) };
    expect((await pushOk(p, [ev]))[0]!.status).toBe('rejeitado');
    expect(await alertasDoEvento(ev.evento_id)).toMatchObject([
      { tipo: 'EVENTO_COM_ERRO', severidade: 'aviso' },
    ]);
    const linha = await linhaDaFila(p, ev.evento_id);
    expect(linha.confirmacaoDescarte).toBeNull();
    const r = await acao(linha.id, 'descartar', { justificativa: 'Registros repetidos do teste' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await alertasDoEvento(ev.evento_id)).map((a) => [a.tipo, a.resolvido_em === null])).toEqual([
      ['EVENTO_COM_ERRO', false],
      ['EVENTO_DESCARTADO', true],
    ]);
  });
});

describe('Aplicar com novo número (SYNC 11.2, 13.1)', () => {
  it('grava a venda na faixa da renumeração, guarda o número do caixa e não mexe em numeracoes', async () => {
    const p = await novoPonto();
    await pushOk(p, [abertura(p)]);
    const v1 = venda(p, { numero: 7 });
    expect((await pushOk(p, [evento(p, 'venda.finalizada', v1)]))[0]!.status).toBe('aplicado');
    const v2 = venda(p, { numero: 7 });
    const ev2 = evento(p, 'venda.finalizada', v2);
    const v3 = venda(p, { numero: 7 });
    const ev3 = evento(p, 'venda.finalizada', v3);
    const r = await pushOk(p, [ev2, ev3]);
    expect(r.map((x) => x.erro?.codigo)).toEqual(['NUMERO_VENDA_DUPLICADO', 'NUMERO_VENDA_DUPLICADO']);
    const l2 = await linhaDaFila(p, ev2.evento_id);

    // Reprocessar não resolve a colisão.
    expect((await acao(l2.id, 'reprocessar')).body).toMatchObject({
      status: 'erro',
      erroCodigo: 'NUMERO_VENDA_DUPLICADO',
    });
    const caixa = String(p.numero).padStart(2, '0');
    const novo = await acao(l2.id, 'aplicar-novo-numero');
    expect(novo.status, JSON.stringify(novo.body)).toBe(200);
    expect(novo.body).toMatchObject({
      status: 'aplicado',
      numero: { original: `L01-C${caixa}-000007`, novo: `L01-C${caixa}-${INICIO_FAIXA_RENUMERACAO + 1}` },
    });
    const [gravada] = await consultar<{ numero: string; numero_exibicao: string; observacao: string }>(
      emp.nomeBanco,
      'select numero::text, numero_exibicao, observacao from vendas where id = $1',
      [v2.vendas.id],
    );
    expect(gravada).toMatchObject({
      numero: String(INICIO_FAIXA_RENUMERACAO + 1),
      numero_exibicao: `L01-C${caixa}-${INICIO_FAIXA_RENUMERACAO + 1}`,
    });
    expect(gravada!.observacao).toContain(`Número original do caixa: L01-C${caixa}-000007`);
    expect(await auditorias(ev2.evento_id)).toMatchObject([
      { depois: { status: 'erro', modo: 'manual' } },
      {
        depois: {
          status: 'aplicado',
          modo: 'novo_numero',
          numero_original: `L01-C${caixa}-000007`,
          numero_novo: `L01-C${caixa}-${INICIO_FAIXA_RENUMERACAO + 1}`,
        },
      },
    ]);
    // A faixa da renumeração fica fora de `numeracoes` (base da próxima ativação, SYNC 13.3).
    const [num] = await consultar<{ ultimo_numero: string }>(
      emp.nomeBanco,
      "select ultimo_numero::text from numeracoes where caixa_id = $1 and tipo = 'venda'",
      [p.caixa],
    );
    expect(num!.ultimo_numero).toBe('7');

    // A segunda colisão do caixa pega o número seguinte da faixa; o PDV recebe o número no resultado.
    const l3 = await linhaDaFila(p, ev3.evento_id);
    expect((await acao(l3.id, 'aplicar-novo-numero')).body).toMatchObject({
      numero: { novo: `L01-C${caixa}-${INICIO_FAIXA_RENUMERACAO + 2}` },
    });
    const hb = await heartbeat(p);
    expect(hb.eventos_resolvidos.find((e) => e.evento_id === ev3.evento_id)?.resultado).toMatchObject({
      numero_original: 7,
      numero: INICIO_FAIXA_RENUMERACAO + 2,
    });
  });

  it('a venda cancelada em andamento (forma B) também ocupa o número e é renumerada', async () => {
    const p = await novoPonto();
    await pushOk(p, [abertura(p)]);
    await pushOk(p, [evento(p, 'venda.finalizada', venda(p, { numero: 3 }))]);
    const b = venda(p, { numero: 3 });
    const emAndamento = {
      ...b,
      vendas: {
        ...b.vendas,
        status: 'cancelada',
        finalizada_em: null,
        cancelada_em: agora(),
        cancelada_por_id: operador,
        motivo_cancelamento: 'Cliente desistiu antes de pagar',
        cancelamento_origem: 'pdv',
      },
    };
    const ev = evento(p, 'venda.cancelada', emAndamento);
    expect((await pushOk(p, [ev]))[0]).toMatchObject({ erro: { codigo: 'NUMERO_VENDA_DUPLICADO' } });
    const r = await acao((await linhaDaFila(p, ev.evento_id)).id, 'aplicar-novo-numero');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'aplicado', numero: { original: b.vendas.numero_exibicao } });
    const [gravada] = await consultar<{ status: string; numero: string }>(
      emp.nomeBanco,
      'select status, numero::text from vendas where id = $1',
      [b.vendas.id],
    );
    expect(gravada).toEqual({ status: 'cancelada', numero: String(INICIO_FAIXA_RENUMERACAO + 1) });
  });

  it('confere de novo, sob a trava do terminal, que a venda ainda é NUMERO_VENDA_DUPLICADO', async () => {
    const p = await novoPonto();
    await pushOk(p, [abertura(p)]);
    await pushOk(p, [evento(p, 'venda.finalizada', venda(p, { numero: 5 }))]);
    const ev = evento(p, 'venda.finalizada', venda(p, { numero: 5 }));
    expect((await pushOk(p, [ev]))[0]).toMatchObject({ erro: { codigo: 'NUMERO_VENDA_DUPLICADO' } });
    const linha = await linhaDaFila(p, ev.evento_id);
    const c = await conectar(emp.nomeBanco);
    try {
      // O pedido passa pela leitura (ainda duplicado) e espera a trava; antes dela, o evento muda de código.
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`push:${p.terminal}`]);
      const pendente = acao(linha.id, 'aplicar-novo-numero').then((r) => r);
      await esperar(300);
      await c.query("update eventos_recebidos set erro_codigo = 'REFERENCIA_INEXISTENTE' where id = $1", [
        linha.id,
      ]);
      await c.query('commit');
      const r = await pendente;
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.mensagem).toContain('mudou de situação');
    } finally {
      await c.end();
    }
    expect(await linhaRecebida(ev.evento_id)).toMatchObject({
      status: 'erro',
      erro_codigo: 'REFERENCIA_INEXISTENTE',
      tentativas: 1,
    });
  });

  it('só para NUMERO_VENDA_DUPLICADO', async () => {
    const p = await novoPonto();
    const ab = abertura(p, { hashErrado: true });
    await pushOk(p, [ab]);
    const linha = await linhaDaFila(p, ab.evento_id);
    const r = await acao(linha.id, 'aplicar-novo-numero');
    expect(r.status).toBe(422);
    expect((await linhaRecebida(ab.evento_id)).tentativas).toBe(1);
  });
});

describe('concorrência e terminal revogado (SYNC 8.1; D20)', () => {
  it('o reprocessamento espera a trava do terminal; o push dele recebe PUSH_EM_ANDAMENTO; dois cliques, um 409', async () => {
    const p = await novoPonto();
    const ab = abertura(p, { hashErrado: true });
    await pushOk(p, [ab]);
    const linha = await linhaDaFila(p, ab.evento_id);

    // Um push do mesmo terminal em andamento: a transação dele segura `push:<terminal>`.
    const c = await conectar(emp.nomeBanco);
    try {
      await c.query('begin');
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`push:${p.terminal}`]);
      let terminou = false;
      const pendente = acao(linha.id, 'reprocessar').then((r) => {
        terminou = true;
        return r;
      });
      await esperar(500);
      expect(terminou).toBe(false);
      expect((await linhaRecebida(ab.evento_id)).status).toBe('erro');
      await c.query('commit');
      const r = await pendente;
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.status).toBe('aplicado');
    } finally {
      await c.end();
    }

    // Um reprocessamento parado com a trava do terminal (pegou a `push:` e espera a 7300001, que o teste segura):
    // o push do terminal é 409 `PUSH_EM_ANDAMENTO` (o PDV repete em 2 s), e o segundo clique espera a mesma trava.
    const p2 = await novoPonto();
    const ab2 = abertura(p2, { hashErrado: true });
    await pushOk(p2, [ab2]);
    const linha2 = await linhaDaFila(p2, ab2.evento_id);
    const c2 = await conectar(emp.nomeBanco);
    try {
      await c2.query('begin');
      await c2.query('select fn_trava_versao()');
      let primeiroTerminou = false;
      const primeiro = acao(linha2.id, 'reprocessar').then((r) => {
        primeiroTerminou = true;
        return r;
      });
      // O reprocessamento já tem a `push:` do terminal quando espera a 7300001.
      const fimEspera = Date.now() + 10_000;
      for (;;) {
        const [{ n }] = (await consultar<{ n: number }>(
          emp.nomeBanco,
          `select count(*)::int as n from pg_locks
            where locktype = 'advisory' and granted
              and objid = (hashtextextended($1, 0) & x'ffffffff'::bigint)::oid`,
          [`push:${p2.terminal}`],
        )) as [{ n: number }];
        if (n > 0) break;
        if (Date.now() > fimEspera) throw new Error('o reprocessamento não pegou a trava do terminal');
        await esperar(50);
      }
      expect(primeiroTerminou).toBe(false);
      const ocupado = await push(p2, [evento(p2, 'caixa.sangria', sangria(p2, '1.00'))]);
      expect(ocupado.status, JSON.stringify(ocupado.body)).toBe(409);
      expect(ocupado.body.erro.codigo).toBe('PUSH_EM_ANDAMENTO');
      p2.seq--;
      // Dois cliques ao mesmo tempo esperam a mesma trava: um aplica, o outro vê a linha resolvida.
      const segundo = acao(linha2.id, 'reprocessar').then((r) => r);
      await esperar(200);
      expect(primeiroTerminou).toBe(false);
      await c2.query('commit');
      const [r1, r2] = await Promise.all([primeiro, segundo]);
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      expect(r1.body.status).toBe('aplicado');
      expect(r2.status).toBe(409);
    } finally {
      await c2.end();
    }
    expect(await linhaRecebida(ab2.evento_id)).toMatchObject({ status: 'aplicado', tentativas: 2 });
  });

  it('reprocessa o evento de terminal revogado (D20) e fecha o alerta do terminal', async () => {
    const p = await novoPonto();
    const ab = abertura(p, { hashErrado: true });
    const v1 = venda(p);
    const ev1 = evento(p, 'venda.finalizada', v1);
    await pushOk(p, [ab, ev1]);
    const rev = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set(bearer())
      .send({ modo: 'imediato', confirmacaoCaixa: p.numero });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect(rev.body.alertaEventos).toBe(true);
    const linha = await linhaDaFila(p, ab.evento_id);
    const r = await acao(linha.id, 'reprocessar');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      status: 'aplicado',
      dependentes: [{ eventoId: ev1.evento_id, status: 'aplicado' }],
    });
    // T16: a abertura de terminal que não está ativo entra fechada à força; a venda é aceita nela (MD 3.12.1).
    const [sessao] = await consultar<{ status: string; fechamento_forcado: boolean }>(
      emp.nomeBanco,
      'select status, fechamento_forcado from sessoes_caixa where id = $1',
      [p.sessao],
    );
    expect(sessao).toMatchObject({ status: 'fechada', fechamento_forcado: true });
    expect(await consultar(emp.nomeBanco, 'select 1 from vendas where id = $1', [v1.vendas.id])).toHaveLength(
      1,
    );
    const d20 = await consultar<{ resolvido_em: Date | null }>(
      emp.nomeBanco,
      "select resolvido_em from alertas where tipo = 'TERMINAL_DESATIVADO_COM_EVENTOS' and registro_id = $1",
      [p.terminal],
    );
    expect(d20).toHaveLength(1);
    expect(d20[0]!.resolvido_em).not.toBeNull();
  });
});

describe('Reprocessar todos com este código (SYNC 11.4)', () => {
  it('numa tarefa: reaplica os erros do código em ordem e informa o resultado', async () => {
    const p = await novoPonto();
    const vazio = { registros: [], logins: [] };
    const e1 = evento(p, 'auditoria.registros', vazio, { hashErrado: true });
    const e2 = evento(p, 'auditoria.registros', vazio, { hashErrado: true });
    const ab = abertura(p);
    const e3 = evento(p, 'venda.finalizada', venda(p, { produto: uuidv7() }));
    const r = await pushOk(p, [e1, e2, ab, e3]);
    expect(r.map((x) => x.status)).toEqual(['rejeitado', 'rejeitado', 'aplicado', 'rejeitado']);
    expect((await fila(p)).codigos).toEqual([
      { codigo: 'PAYLOAD_INVALIDO', quantidade: 2 },
      { codigo: 'REFERENCIA_INEXISTENTE', quantidade: 1 },
    ]);
    // Os EVENTO_COM_ERRO do terminal aparecem somados (crítico porque um é de venda).
    expect(await alertasDoTerminal(p)).toMatchObject([
      {
        tipo: 'EVENTO_COM_ERRO',
        severidade: 'critico',
        titulo: `Caixa ${String(p.numero).padStart(2, '0')}: 3 eventos com erro`,
        terminalId: p.terminal,
      },
    ]);
    const nenhum = await amb
      .http()
      .post('/api/eventos-recebidos/reprocessar-lote')
      .set(bearer())
      .send({ terminalId: p.terminal, codigo: 'SESSAO_INEXISTENTE' });
    expect(nenhum.status).toBe(422);
    const ag = await amb
      .http()
      .post('/api/eventos-recebidos/reprocessar-lote')
      .set(bearer())
      .send({ terminalId: p.terminal, codigo: 'PAYLOAD_INVALIDO' });
    expect(ag.status, JSON.stringify(ag.body)).toBe(202);
    expect(ag.body.quantidade).toBe(2);
    const fim = Date.now() + 60_000;
    let tarefa: { status: string; resultado: Payload; erro?: string };
    for (;;) {
      tarefa = (await amb.http().get(`/api/tarefas/${ag.body.tarefaId}`).set(bearer())).body;
      if (tarefa.status === 'concluida' || tarefa.status === 'falhou') break;
      if (Date.now() > fim) throw new Error(`tarefa não terminou: ${JSON.stringify(tarefa)}`);
      await esperar(200);
    }
    expect(tarefa.status, tarefa.erro).toBe('concluida');
    expect(tarefa.resultado).toMatchObject({ total: 2, aplicados: 2, erros: 0, ignorados: 0, adiados: 0 });
    expect((await fila(p)).itens.map((e) => e.eventoId)).toEqual([e3.evento_id]);
    // A auditoria do lote guarda quem pediu (nome e requisição), como o Reprocessar da tela.
    const [doEvento] = await consultar<{ usuario_id: string; usuario_nome: string | null; depois: Payload }>(
      emp.nomeBanco,
      'select usuario_id, usuario_nome, depois from auditoria where evento_id = $1',
      [e1.evento_id],
    );
    expect(doEvento).toMatchObject({ usuario_id: operador, depois: { modo: 'lote' } });
    expect(doEvento!.usuario_nome).toBeTruthy();
    // O pedido em si também é auditado, no histórico do terminal (mesmo que nenhum evento seja reaplicado).
    const [pedido] = await consultar<{ usuario_nome: string | null; depois: Payload }>(
      emp.nomeBanco,
      `select usuario_nome, depois from auditoria
        where acao = 'evento_reprocessado' and entidade = 'terminais' and registro_id = $1`,
      [p.terminal],
    );
    expect(pedido).toMatchObject({
      usuario_nome: doEvento!.usuario_nome,
      depois: {
        modo: 'lote_agendado',
        codigo: 'PAYLOAD_INVALIDO',
        quantidade: 2,
        tarefa_id: ag.body.tarefaId,
      },
    });
    const detalhe = (await amb.http().get(`/api/terminais/${p.terminal}`).set(bearer()))
      .body as TerminalDetalhe;
    expect(detalhe.historico.map((h) => h.titulo)).toContain('Reprocessamento de eventos');
  });
});

describe('GET /sync/eventos-status (SYNC 7.2, 21.1; T6)', () => {
  it('devolve erro e retido com o código, depois o aplicado e o descartado; só do próprio terminal e sem ack', async () => {
    const p = await novoPonto();
    const outro = await novoPonto();
    const ab = abertura(p, { hashErrado: true });
    const v1 = venda(p);
    const ev1 = evento(p, 'venda.finalizada', v1);
    const aud = evento(p, 'auditoria.registros', { registros: [], logins: [] }, { hashErrado: true });
    await pushOk(p, [ab, ev1, aud]);
    const doOutro = abertura(outro, { hashErrado: true });
    await pushOk(outro, [doOutro]);

    // Fora de ordem, com repetição, um id que a nuvem não tem e um de outro terminal: a resposta segue a sequência e
    // não distingue o desconhecido do alheio (nenhum dos dois aparece).
    const ids = [aud.evento_id, ev1.evento_id, uuidv7(), doOutro.evento_id, ab.evento_id, ev1.evento_id];
    expect(await eventosStatusOk(p, ids)).toMatchObject([
      { evento_id: ab.evento_id, status: 'erro', resultado: null, erro: { codigo: 'PAYLOAD_INVALIDO' } },
      {
        evento_id: ev1.evento_id,
        status: 'retido',
        resultado: null,
        erro: { codigo: 'DEPENDENCIA_PENDENTE' },
      },
      { evento_id: aud.evento_id, status: 'erro', erro: { codigo: 'PAYLOAD_INVALIDO' } },
    ]);
    expect(await eventosStatusOk(outro, [ab.evento_id])).toEqual([]);

    const rep = await acao((await linhaDaFila(p, ab.evento_id)).id, 'reprocessar');
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    const desc = await acao((await linhaDaFila(p, aud.evento_id)).id, 'descartar', {
      justificativa: 'Registros repetidos do teste',
    });
    expect(desc.status, JSON.stringify(desc.body)).toBe(200);
    const depois = await eventosStatusOk(p, [ab.evento_id, ev1.evento_id, aud.evento_id]);
    expect(depois).toMatchObject([
      { evento_id: ab.evento_id, status: 'aplicado' },
      { evento_id: ev1.evento_id, status: 'aplicado' },
      {
        evento_id: aud.evento_id,
        status: 'descartado',
        resultado: { descartado: true, justificativa: 'Registros repetidos do teste' },
      },
    ]);
    expect(depois[1]!.versao_nuvem_fim).toBeGreaterThan(0);
    expect(depois[0]).not.toHaveProperty('erro');

    // Só leitura: a entrega continua sendo a do heartbeat, com o mesmo conteúdo, até o ack.
    expect((await linhaRecebida(ab.evento_id)).resolucao_entregue_em).toBeNull();
    const hb = await heartbeat(p);
    expect(hb.eventos_resolvidos).toEqual(depois.map(({ erro: _erro, ...r }) => r));
  });

  it('valida os ids e aceita os mesmos estados do recuperar: desativando 200, revogado 401; hardware não importa', async () => {
    const p = await novoPonto();
    const ab = abertura(p, { hashErrado: true });
    await pushOk(p, [ab]);

    for (const ruim of [[], ['nao-e-uuid']]) {
      const r = await eventosStatus(p, ruim);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.erro.codigo).toBe('REQUISICAO_INVALIDA');
    }
    const muitos = Array.from({ length: MAXIMO_IDS_EVENTOS_STATUS + 1 }, () => uuidv7());
    expect((await eventosStatus(p, muitos)).status).toBe(400);
    expect((await eventosStatusOk(p, [...muitos.slice(2), ab.evento_id])).length).toBe(1);

    // Hardware divergente (SYNC 20.5): como o heartbeat, responde (a situação de um evento não é segredo).
    const outroHw = await eventosStatus(p, [ab.evento_id], { 'X-Genesis-Id-Hardware': 'f'.repeat(64) });
    expect(outroHw.status, JSON.stringify(outroHw.body)).toBe(200);

    const des = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set(bearer())
      .send({ modo: 'aceitar_pendencias' });
    expect(des.status, JSON.stringify(des.body)).toBe(200);
    expect((await eventosStatusOk(p, [ab.evento_id])).map((e) => e.status)).toEqual(['erro']);

    const rev = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set(bearer())
      .send({ modo: 'imediato', confirmacaoCaixa: p.numero });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const r = await eventosStatus(p, [ab.evento_id]);
    expect(r.status).toBe(401);
    expect(r.body.erro.codigo).toBe('TERMINAL_REVOGADO');
  });
});

describe('Dashboard: alertas críticos e caixas abertos há muito tempo (C14; O11, ERP 14.9)', () => {
  const dashboard = async (tk = tokenAdmin, query = ''): Promise<Dashboard> => {
    const r = await amb.http().get(`/api/dashboard${query}`).set(bearer(tk));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Dashboard;
  };
  const doTipo = (d: Dashboard, tipo: string) =>
    d.alertasCriticos!.porTipo.find((t) => t.tipo === tipo)?.quantidade ?? 0;

  it('mostra o erro crítico com o terminal e a sessão esquecida; some com a permissão, a loja e o prazo da loja', async () => {
    const antes = await dashboard();
    const p = await novoPonto();
    expect((await pushOk(p, [abertura(p, { abertaEm: horasAtras(30) })]))[0]!.status).toBe('aplicado');
    const ruim = evento(p, 'venda.finalizada', venda(p), { hashErrado: true });
    // O aviso do mesmo tipo (a auditoria não é evento crítico) e um crítico de tipo sem tela na 1C ficam de fora.
    const aviso = evento(p, 'auditoria.registros', { registros: [], logins: [] }, { hashErrado: true });
    expect((await pushOk(p, [ruim, aviso])).map((r) => r.status)).toEqual(['rejeitado', 'rejeitado']);
    expect((await alertasDoEvento(aviso.evento_id)).map((a) => a.severidade)).toEqual(['aviso']);
    await consultar(
      emp.nomeBanco,
      `insert into alertas (tipo, severidade, titulo, loja_id)
       values ('TIPO_SEM_TELA', 'critico', 'Crítico sem onde decidir', $1)`,
      [loja],
    );

    const d = await dashboard();
    expect(d.alertasCriticos!.total).toBe(antes.alertasCriticos!.total + 1);
    expect(doTipo(d, 'EVENTO_COM_ERRO')).toBe(doTipo(antes, 'EVENTO_COM_ERRO') + 1);
    expect(doTipo(d, 'TIPO_SEM_TELA')).toBe(0);
    expect(d.alertasCriticos!.recentes[0]).toMatchObject({
      tipo: 'EVENTO_COM_ERRO',
      lojaNome: 'Loja 1 - Centro',
      terminalId: p.terminal,
    });
    const sessao = d.sessoesAntigas!.recentes.find((s) => s.sessaoId === p.sessao);
    expect(sessao).toMatchObject({
      lojaNome: 'Loja 1 - Centro',
      numeroCaixa: p.numero,
      operadorNome: 'ADMINISTRADOR',
    });
    expect(sessao!.horas).toBeGreaterThanOrEqual(29);
    expect(d.sessoesAntigas!.total).toBeGreaterThanOrEqual(1);

    // `pdv.horas_alerta_sessao` da loja (48 h) vale sobre o padrão de 24 h.
    const [cfg] = await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into configuracoes (escopo, loja_id, chave, valor)
       values ('loja', $1, 'pdv.horas_alerta_sessao', '48'::jsonb) returning id`,
      [loja],
    );
    try {
      expect((await dashboard()).sessoesAntigas!.recentes.some((s) => s.sessaoId === p.sessao)).toBe(false);
    } finally {
      await consultar(emp.nomeBanco, 'update configuracoes set excluido_em = now() where id = $1', [cfg!.id]);
    }

    // Outra loja no filtro: o alerta e a sessão da Loja 1 ficam de fora.
    const outra = await criarLoja(emp.nomeBanco, 90, 'Loja 90 - Sem caixa');
    const filtrado = await dashboard(tokenAdmin, `?lojaId=${outra}`);
    expect(filtrado.alertasCriticos!.recentes.some((a) => a.terminalId === p.terminal)).toBe(false);
    expect(filtrado.sessoesAntigas).toEqual({ total: 0, recentes: [] });

    // Gerente só da Loja 90 (com `terminais.ver` e `fechamentos_caixa.ver`), sem filtro: as lojas permitidas valem
    // também para os alertas e as sessões.
    const loginRestrito = `so_loja_90_${p.numero}`;
    await criarUsuario(emp.nomeBanco, { login: loginRestrito, perfil: 'gerente', lojas: [outra] });
    const restrito = await dashboard(await amb.entrar(emp.codigo, loginRestrito, SENHA_TESTE));
    expect(restrito.alertasCriticos).not.toBeNull();
    expect(restrito.alertasCriticos!.recentes.some((a) => a.terminalId === p.terminal)).toBe(false);
    expect(restrito.alertasCriticos!.total).toBeLessThan(d.alertasCriticos!.total);
    expect(restrito.sessoesAntigas).toEqual({ total: 0, recentes: [] });

    // Resolvido (reprocessar aplica a venda), o crítico sai do painel: o total volta ao de antes.
    const rep = await acao((await linhaDaFila(p, ruim.evento_id)).id, 'reprocessar');
    expect(rep.status, JSON.stringify(rep.body)).toBe(200);
    expect((await linhaRecebida(ruim.evento_id)).status).toBe('aplicado');
    const resolvido = await dashboard();
    expect(resolvido.alertasCriticos!.total).toBe(antes.alertasCriticos!.total);
    expect(resolvido.alertasCriticos!.recentes.some((a) => a.terminalId === p.terminal)).toBe(false);

    // Sem terminais.ver e sem fechamentos_caixa.ver, os dois painéis não vêm.
    const login = `sem_paineis_${p.numero}`;
    const sem = await criarUsuario(emp.nomeBanco, { login, perfil: 'gerente', lojas: [loja] });
    await consultar(
      emp.nomeBanco,
      `insert into usuarios_permissoes (usuario_id, permissao, efeito)
       values ($1, 'terminais.ver', 'negar'), ($1, 'fechamentos_caixa.ver', 'negar')`,
      [sem],
    );
    const semPaineis = await dashboard(await amb.entrar(emp.codigo, login, SENHA_TESTE));
    expect(semPaineis).toMatchObject({ alertasCriticos: null, sessoesAntigas: null });
  });

  it('evento divergente (SYNC 8.4 camada 3): no painel com o link, no detalhe do terminal e fecha no "Ciente"', async () => {
    const antes = await dashboard();
    const p = await novoPonto();
    const original = evento(p, 'auditoria.registros', { registros: [], logins: [] });
    expect((await pushOk(p, [original]))[0]!.status).toBe('aplicado');
    // O banco local regerou o hash do mesmo evento (bug de serialização): a nuvem guarda o original e alerta.
    const outroConteudo = { ...original, payload_sha256: 'f'.repeat(64) };
    expect((await pushOk(p, [outroConteudo]))[0]).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'EVENTO_DIVERGENTE' },
    });

    const d = await dashboard();
    expect(d.alertasCriticos!.total).toBe(antes.alertasCriticos!.total + 1);
    expect(doTipo(d, 'EVENTO_DIVERGENTE')).toBe(doTipo(antes, 'EVENTO_DIVERGENTE') + 1);
    const noPainel = d.alertasCriticos!.recentes.find((a) => a.tipo === 'EVENTO_DIVERGENTE');
    expect(noPainel).toMatchObject({ lojaNome: 'Loja 1 - Centro', terminalId: p.terminal });
    const [noTerminal] = (await alertasDoTerminal(p)).filter((a) => a.tipo === 'EVENTO_DIVERGENTE');
    expect(noTerminal).toMatchObject({ id: noPainel!.id, severidade: 'critico', terminalId: p.terminal });

    // O alerta gravado antes de levar o terminal em `dados` acha o terminal pela linha recebida.
    await consultar(emp.nomeBanco, "update alertas set dados = dados - 'terminal_id' where id = $1", [
      noPainel!.id,
    ]);
    expect((await dashboard()).alertasCriticos!.recentes.find((a) => a.id === noPainel!.id)).toMatchObject({
      terminalId: p.terminal,
    });

    const r = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/alertas/${noPainel!.id}/resolver`)
      .set(bearer())
      .send({ resolucao: 'Caixa conferido com o suporte' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as TerminalDetalhe).alertas.some((a) => a.id === noPainel!.id)).toBe(false);
    const [alerta] = await consultar<{ resolvido_em: Date | null; resolucao: string | null }>(
      emp.nomeBanco,
      'select resolvido_em, resolucao from alertas where id = $1',
      [noPainel!.id],
    );
    expect(alerta).toMatchObject({ resolucao: 'Caixa conferido com o suporte' });
    expect(alerta!.resolvido_em).not.toBeNull();
    expect((await dashboard()).alertasCriticos!.total).toBe(antes.alertasCriticos!.total);

    // De outro terminal o alerta não é encontrado.
    const outro = await novoPonto();
    const deOutro = await amb
      .http()
      .post(`/api/terminais/${outro.terminal}/alertas/${noPainel!.id}/resolver`)
      .set(bearer())
      .send({ resolucao: 'Tentativa pelo terminal errado' });
    expect(deOutro.status).toBe(404);
  });
});
