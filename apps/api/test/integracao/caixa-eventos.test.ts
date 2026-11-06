/**
 * Handlers de caixa da Fase 1C (bloco C5; SYNC 9.3–9.6, 10.1; MD 3.12.1–3.12.3): o ciclo abrir, reforçar, sangrar,
 * cancelar e fechar pelo push real; o reenvio do lote sem efeito; a abertura que depende de um fechamento em erro fica
 * `retido` e não `SESSAO_DUPLICADA` (T11); a disputa entre heartbeat e `caixa.fechado` em `terminais.sessao_caixa_id`
 * (T12); o fechamento forçado na substituição, na revogação e na desativação confirmada, com os eventos tardios do
 * terminal antigo (movimento e fechamento gravados, abertura nova já fechada à força, T16) e o `desativando` por
 * aceitar pendências abrindo normalmente; a duplicata divergente que não retém a sessão; e o `/sync/estado` com a
 * sessão só do próprio terminal.
 * Cada teste usa um caixa e um terminal só seus (`novoPonto`): roda sozinho (`-t`) e em qualquer ordem.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CONTRATOS_EVENTOS,
  jcs,
  respostaEstadoSchema,
  respostaPushSchema,
  type Ativar,
} from '@genesis/shared';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventosRecebidos } from '../../src/database/empresa/schema/index.js';
import {
  aplicarEvento,
  carregarTerminalDoEvento,
  envelopeDaLinha,
  type DesfechoAplicacao,
} from '../../src/sync/aplicacao.js';
import { versoesSchemaAceitas } from '../../src/sync/eventos.js';
import type { ContextoEmpresa } from '../../src/tenancy/contexto.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let contexto: ContextoEmpresa;
let loja: string;
let tokenAdmin: string;
let operador: string;
let supervisor: string;
let dinheiro: string;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

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

const erp = () => ({
  post: (url: string, corpo: object = {}) =>
    amb.http().post(url).set('Authorization', `Bearer ${tokenAdmin}`).send(corpo),
});

type Payload = Record<string, unknown>;

/** Um caixa com o seu terminal ativado pelo `/sync/ativar` real, e a sequência de eventos dele. */
interface Ponto {
  caixa: string;
  numero: number;
  terminal: string;
  token: string;
  seq: number;
}

let numeroCaixa = 0;

async function ativar(caixa: string, extra: Record<string, unknown> = {}) {
  const g = await erp().post('/api/terminais/ativacoes', {
    lojaId: loja,
    caixaId: caixa,
    descricao: 'PC do balcão',
    validadeHoras: 24,
    ...extra,
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
  return { terminal: r.body.terminal_id as string, token: r.body.token as string };
}

async function novoPonto(): Promise<Ponto> {
  const numero = ++numeroCaixa;
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  )) as [{ id: string }];
  return { caixa, numero, ...(await ativar(caixa)), seq: 0 };
}

/** Envelope com o agregado do contrato (C4) e a dependência declarada como o PDV declara (SYNC 8.5). */
function evento(p: Ponto, tipo: keyof typeof CONTRATOS_EVENTOS, payload: Payload, extra: Payload = {}) {
  const contrato = CONTRATOS_EVENTOS[tipo];
  return {
    evento_id: uuidv7(),
    sequencia: ++p.seq,
    tipo,
    versao_schema: 1,
    agregado_tipo: contrato.agregadoTipo,
    agregado_id: (contrato.agregadoId as (x: unknown) => string)(payload),
    dependencias: [],
    ocorrido_em: new Date().toISOString(),
    relogio_confiavel: true,
    usuario_id: operador,
    contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
    ...extra,
  };
}

const push = (p: Ponto, eventos: unknown[]) =>
  amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({ lote_id: uuidv7(), terminal_id: p.terminal, enviado_em: new Date().toISOString(), eventos });

async function pushOk(p: Ponto, eventos: unknown[]) {
  const r = await push(p, eventos);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  respostaPushSchema.parse(r.body);
  return r.body.resultados as Array<{
    status: string;
    erro?: { codigo: string };
    resultado?: Record<string, unknown>;
  }>;
}

const estado = async (p: Ponto) => {
  const r = await amb.http().get('/sync/estado').set(cabecalhos(p.token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return respostaEstadoSchema.parse(r.body);
};

const heartbeat = (p: Ponto, corpo: Payload) =>
  amb.http().post('/sync/heartbeat').set(cabecalhos(p.token)).send(corpo);

const agora = () => new Date().toISOString();

const linhaDoPonto = (p: Ponto) => ({
  loja_id: loja,
  caixa_id: p.caixa,
  numero_caixa: p.numero,
  terminal_id: p.terminal,
});

const movimento = (p: Ponto, sessao: string, tipo: string, valor: string, extra: Payload = {}) => ({
  id: uuidv7(),
  sessao_caixa_id: sessao,
  ...linhaDoPonto(p),
  tipo,
  forma_pagamento_id: null,
  valor,
  operador_id: operador,
  quem_retira_usuario_id: null,
  quem_retira_nome: null,
  observacao: null,
  inf_adicionais: null,
  ocorrido_em: agora(),
  autorizado_por_id: null,
  troca_id: null,
  cancelado: false,
  ...extra,
});

function abertura(p: Ponto, fundo = '150.00', extra: Payload = {}) {
  const id = uuidv7();
  return {
    sessoes_caixa: {
      id,
      ...linhaDoPonto(p),
      operador_id: operador,
      status: 'aberta',
      dia_operacional: '2026-10-31',
      aberta_em: agora(),
      abertura_automatica: false,
      fundo_troco: fundo,
      sessao_anterior_id: null,
      valor_recebido_anterior: null,
      diferenca_recebimento: null,
      fechada_em: null,
      ...extra,
    },
    movimentos_caixa: fundo === '0.00' ? [] : [movimento(p, id, 'abertura', fundo)],
    contagem_cedulas: { '100.00': 1, '50.00': 1 },
  };
}

const idSessao = (a: { sessoes_caixa: { id: string } }) => a.sessoes_caixa.id;

function fechamento(
  p: Ponto,
  sessao: string,
  opcoes: { tipo?: 'fechamento' | 'troca_turno'; forma?: string; ultimaSequencia?: number } = {},
) {
  const tipo = opcoes.tipo ?? 'fechamento';
  const id = uuidv7();
  const zera = tipo === 'fechamento';
  return {
    sessoes_caixa: { id: sessao, status: 'fechada', fechada_em: agora() },
    fechamentos_caixa: {
      id,
      sessao_caixa_id: sessao,
      ...linhaDoPonto(p),
      tipo,
      zera_caixa: zera,
      usuario_anterior_id: operador,
      usuario_subsequente_id: null,
      valor_caixa: zera ? '0.00' : '150.00',
      total_calculado: '150.00',
      total_digitado: '148.50',
      justificativa: null,
      recontagem: false,
      fechamento_cego: true,
      ocorrido_em: agora(),
      dia_operacional: '2026-10-31',
      resumo: {
        qtd_vendas: 0,
        total_vendas: '0.00',
        ultima_sequencia_evento: opcoes.ultimaSequencia ?? Math.max(1, p.seq),
      },
    },
    fechamentos_caixa_formas: [
      {
        id: uuidv7(),
        fechamento_id: id,
        forma_pagamento_id: opcoes.forma ?? dinheiro,
        descricao_forma: 'Dinheiro',
        tipo_forma: 'dinheiro',
        valor_calculado: '150.00',
        valor_digitado: '148.50',
        quantidade_pagamentos: 0,
        preenchido_automatico: false,
        valor_primeira_contagem: null,
      },
    ],
    movimentos_caixa: zera
      ? [movimento(p, sessao, 'sangria_fechamento', '148.50', { quem_retira_nome: 'MARIA' })]
      : [],
  };
}

const naEmpresa = <T>(fn: () => Promise<T>) => amb.servicos.tenancy.executarNaEmpresa(contexto, fn);

/** Reaplica a linha gravada como o reprocessamento do ERP (C8) vai fazer: terminal de `terminais`, envelope da linha. */
const reaplicar = (terminalId: string, eventoId: string) =>
  naEmpresa(() =>
    amb.servicos.tenancy.cx().transacao(async (tx, c): Promise<DesfechoAplicacao> => {
      const t = await carregarTerminalDoEvento(c, terminalId);
      const [linha] = await tx.select().from(eventosRecebidos).where(eq(eventosRecebidos.eventoId, eventoId));
      return aplicarEvento(tx, c, t!, envelopeDaLinha(linha!, t!));
    }),
  );

const sessaoNaNuvem = async (id: string) =>
  (
    await consultar<{
      status: string;
      fechamento_forcado: boolean;
      fechamento_forcado_motivo: string | null;
      fechada_em: Date | null;
    }>(
      emp.nomeBanco,
      'select status, fechamento_forcado, fechamento_forcado_motivo, fechada_em from sessoes_caixa where id = $1',
      [id],
    )
  )[0];

const sessaoDoTerminal = async (terminal: string) =>
  (
    await consultar<{ sessao_caixa_id: string | null; operador_id: string | null }>(
      emp.nomeBanco,
      'select sessao_caixa_id, operador_id from terminais where id = $1',
      [terminal],
    )
  )[0];

const linhaEvento = async (eventoId: string) =>
  (
    await consultar<{ status: string; erro_codigo: string | null; dependencias: unknown[] }>(
      emp.nomeBanco,
      'select status, erro_codigo, dependencias from eventos_recebidos where evento_id = $1',
      [eventoId],
    )
  )[0];

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  contexto = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  [{ id: operador }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  supervisor = operador;
  [{ id: dinheiro }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from formas_pagamento where tipo_forma = 'dinheiro' and excluido_em is null order by ordem limit 1",
  )) as [{ id: string }];
});

afterAll(async () => {
  await amb?.fechar();
});

describe('catálogo (T13)', () => {
  it('anuncia os cinco caixa.* em versoes_schema', () => {
    expect(versoesSchemaAceitas()).toMatchObject({
      'caixa.aberto': [1],
      'caixa.reforco': [1],
      'caixa.sangria': [1],
      'caixa.movimento_cancelado': [1],
      'caixa.fechado': [1],
    });
  });
});

describe('ciclo da sessão pelo push (SYNC 9.3–9.6)', () => {
  it('abre, reforça, sangra, cancela e fecha; o reenvio do lote não muda nada', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const s = idSessao(a);
    const reforco = movimento(p, s, 'reforco', '50.00', { quem_retira_nome: 'GERENTE' });
    const sangria = movimento(p, s, 'sangria', '80.00', {
      quem_retira_usuario_id: supervisor,
      quem_retira_nome: 'CARLOS',
      observacao: 'Depósito banco',
    });
    const eventos = [
      evento(p, 'caixa.aberto', a),
      evento(p, 'caixa.reforco', {
        movimentos_caixa: reforco,
        dinheiro_estimado_antes: '150.00',
        contagem_cedulas: null,
      }),
      // Sangria acima do que o caixa estimava → alerta (SYNC 10.1).
      evento(p, 'caixa.sangria', {
        movimentos_caixa: sangria,
        dinheiro_estimado_antes: '60.00',
        contagem_cedulas: null,
      }),
      evento(p, 'caixa.movimento_cancelado', {
        movimentos_caixa: {
          id: sangria.id,
          cancelado: true,
          cancelado_em: agora(),
          cancelado_por_id: operador,
          autorizado_cancelamento_por_id: supervisor,
          motivo_cancelamento: 'Valor digitado errado',
        },
      }),
    ];
    const r1 = await pushOk(p, eventos);
    expect(
      r1.map((x) => x.status),
      JSON.stringify(r1),
    ).toEqual(['aplicado', 'aplicado', 'aplicado', 'aplicado']);
    expect(r1[2]!.resultado).toMatchObject({ alerta: 'SANGRIA_ACIMA_DO_ESTIMADO' });
    expect(await sessaoDoTerminal(p.terminal)).toEqual({ sessao_caixa_id: s, operador_id: operador });
    expect((await estado(p)).sessao_caixa_aberta).toMatchObject({ id: s, operador_id: operador });

    const movs = await consultar(
      emp.nomeBanco,
      'select tipo, valor, cancelado, motivo_cancelamento from movimentos_caixa where sessao_caixa_id = $1 order by ocorrido_em, tipo',
      [s],
    );
    expect(movs).toEqual([
      { tipo: 'abertura', valor: '150.00', cancelado: false, motivo_cancelamento: null },
      { tipo: 'reforco', valor: '50.00', cancelado: false, motivo_cancelamento: null },
      { tipo: 'sangria', valor: '80.00', cancelado: true, motivo_cancelamento: 'Valor digitado errado' },
    ]);
    // Rodapé da SYNC 10.1: auditoria `origem = 'pdv'` com o evento; a contagem de cédulas fica na da abertura.
    const [aud] = await consultar<{ origem: string; evento_id: string; depois: Record<string, unknown> }>(
      emp.nomeBanco,
      "select origem, evento_id, depois from auditoria where entidade = 'sessoes_caixa' and registro_id = $1",
      [s],
    );
    expect(aud).toMatchObject({
      origem: 'pdv',
      evento_id: eventos[0]!.evento_id,
      depois: { contagem_cedulas: { '100.00': 1, '50.00': 1 } },
    });
    const alertasSangria = await consultar(
      emp.nomeBanco,
      "select tipo from alertas where tipo = 'SANGRIA_ACIMA_DO_ESTIMADO' and registro_id = $1",
      [sangria.id],
    );
    expect(alertasSangria).toHaveLength(1);

    const f = fechamento(p, s);
    const evFechado = evento(p, 'caixa.fechado', f);
    const r2 = await pushOk(p, [evFechado]);
    expect(r2[0]).toMatchObject({ status: 'aplicado' });
    expect(await sessaoNaNuvem(s)).toMatchObject({ status: 'fechada', fechamento_forcado: false });
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: null });
    expect((await estado(p)).sessao_caixa_aberta).toBeNull();
    const [fech] = await consultar(
      emp.nomeBanco,
      'select tipo, total_calculado, total_digitado, diferenca from fechamentos_caixa where sessao_caixa_id = $1',
      [s],
    );
    expect(fech).toEqual({
      tipo: 'fechamento',
      total_calculado: '150.00',
      total_digitado: '148.50',
      diferenca: '-1.50',
    });
    const [{ formas }] = (await consultar<{ formas: number }>(
      emp.nomeBanco,
      'select count(*)::int as formas from fechamentos_caixa_formas where fechamento_id = $1',
      [f.fechamentos_caixa.id],
    )) as [{ formas: number }];
    expect(formas).toBe(1);

    // Reenvio de tudo (o PDV não recebeu as respostas): `duplicado` com o desfecho gravado, nenhuma linha nova,
    // versão intocada.
    const contar = async () =>
      consultar(
        emp.nomeBanco,
        `select (select count(*)::int from movimentos_caixa where sessao_caixa_id = $1) as movimentos,
                (select count(*)::int from auditoria where evento_id in (select evento_id from eventos_recebidos where terminal_id = $2)) as auditoria,
                (select versao from sessoes_caixa where id = $1)::text as versao`,
        [s, p.terminal],
      );
    const antes = await contar();
    const r3 = await pushOk(p, [...eventos, evFechado]);
    expect(
      r3.map((x) => x.status),
      JSON.stringify(r3),
    ).toEqual(['duplicado', 'duplicado', 'duplicado', 'duplicado', 'duplicado']);
    expect(await contar()).toEqual(antes);
  });

  it('o mesmo agregado num evento novo é `ja_existia`; conteúdo diferente é AGREGADO_DIVERGENTE', async () => {
    const p = await novoPonto();
    const a = abertura(p, '0.00');
    const s = idSessao(a);
    const sangria = movimento(p, s, 'sangria', '10.00', { quem_retira_nome: 'CARLOS' });
    const corpo = { movimentos_caixa: sangria, dinheiro_estimado_antes: null, contagem_cedulas: null };
    const r = await pushOk(p, [
      evento(p, 'caixa.aberto', a),
      evento(p, 'caixa.sangria', corpo),
      // O PDV gerou o mesmo movimento de novo, com outro evento_id: nada a fazer.
      evento(p, 'caixa.sangria', corpo),
      evento(p, 'caixa.sangria', { ...corpo, movimentos_caixa: { ...sangria, valor: '11.00' } }),
    ]);
    expect(r.map((x) => [x.status, x.erro?.codigo ?? null])).toEqual([
      ['aplicado', null],
      ['aplicado', null],
      ['aplicado', null],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
    ]);
    expect(r[2]!.resultado).toMatchObject({ ja_existia: true });
    // Fundo 0,00: a sessão sozinha registra a abertura (SYNC 9.3).
    const movs = await consultar(
      emp.nomeBanco,
      'select tipo from movimentos_caixa where sessao_caixa_id = $1',
      [s],
    );
    expect(movs).toEqual([{ tipo: 'sangria' }]);

    // Segundo fechamento da mesma sessão (PDV 21.5).
    const f1 = fechamento(p, s);
    const f2 = fechamento(p, s);
    const r2 = await pushOk(p, [evento(p, 'caixa.fechado', f1), evento(p, 'caixa.fechado', f2)]);
    expect(r2.map((x) => [x.status, x.erro?.codigo ?? null])).toEqual([
      ['aplicado', null],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
    ]);

    // O mesmo fechamento (mesmo id) gerado de novo: as formas e a `sangria_fechamento` também são comparadas. O
    // `f2` em erro acima é só uma duplicata (AGREGADO_DIVERGENTE): não retém estes, que dependem da mesma sessão.
    const outraContagem = structuredClone(f1);
    outraContagem.fechamentos_caixa_formas[0]!.valor_digitado = '140.00';
    const outraSangria = structuredClone(f1);
    outraSangria.movimentos_caixa[0]!.valor = '140.00';
    const sangriaNova = structuredClone(f1);
    sangriaNova.movimentos_caixa[0]!.id = uuidv7();
    const formaNova = structuredClone(f1);
    formaNova.fechamentos_caixa_formas[0]!.id = uuidv7();
    const r3 = await pushOk(p, [
      evento(p, 'caixa.fechado', structuredClone(f1)),
      evento(p, 'caixa.fechado', outraContagem),
      evento(p, 'caixa.fechado', outraSangria),
      evento(p, 'caixa.fechado', sangriaNova),
      evento(p, 'caixa.fechado', formaNova),
    ]);
    expect(r3.map((x) => [x.status, x.erro?.codigo ?? null])).toEqual([
      ['aplicado', null],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
    ]);
    expect(r3[0]!.resultado).toMatchObject({ ja_existia: true });
    const fechamentoGravado = await consultar(
      emp.nomeBanco,
      `select (select count(*)::int from movimentos_caixa where sessao_caixa_id = $1 and tipo = 'sangria_fechamento') as sangrias,
              (select string_agg(valor_digitado::text, ',') from fechamentos_caixa_formas where fechamento_id = $2) as formas`,
      [s, f1.fechamentos_caixa.id],
    );
    expect(fechamentoGravado).toEqual([{ sangrias: 1, formas: '148.50' }]);
  });

  it('duplicata divergente em erro não retém a sessão: a troca de turno seguinte é aplicada', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const sA = idSessao(a);
    // Abertura gerada de novo com outro movimento de fundo: seria um segundo fundo de troco na mesma sessão.
    const aberturaNova = structuredClone(a);
    aberturaNova.movimentos_caixa[0]!.id = uuidv7();
    const f1 = fechamento(p, sA, { tipo: 'troca_turno' });
    const f2 = fechamento(p, sA, { tipo: 'troca_turno' });
    const b = abertura(p, '150.00', {
      sessao_anterior_id: sA,
      valor_recebido_anterior: '150.00',
      diferenca_recebimento: '0.00',
    });
    const sB = idSessao(b);
    const r = await pushOk(p, [
      evento(p, 'caixa.aberto', a),
      evento(p, 'caixa.aberto', aberturaNova),
      evento(p, 'caixa.fechado', f1),
      evento(p, 'caixa.fechado', f2),
      evento(p, 'caixa.aberto', b),
      evento(p, 'caixa.sangria', {
        movimentos_caixa: movimento(p, sB, 'sangria', '20.00', { quem_retira_nome: 'CARLOS' }),
        contagem_cedulas: null,
      }),
    ]);
    expect(r.map((x) => [x.status, x.erro?.codigo ?? null])).toEqual([
      ['aplicado', null],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
      ['aplicado', null],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
      ['aplicado', null],
      ['aplicado', null],
    ]);
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from movimentos_caixa where sessao_caixa_id = $1 and tipo = 'abertura'",
      [sA],
    )) as [{ n: number }];
    expect(n).toBe(1);
    expect(await sessaoNaNuvem(sB)).toMatchObject({ status: 'aberta' });
  });

  it('erros de regra: agregado do envelope, sessão nunca recebida, movimento inexistente, escopo da linha', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const fantasma = uuidv7();
    const r = await pushOk(p, [
      evento(p, 'caixa.aberto', a, { agregado_id: uuidv7() }),
      evento(p, 'caixa.reforco', {
        movimentos_caixa: movimento(p, fantasma, 'reforco', '5.00'),
        contagem_cedulas: null,
      }),
      evento(p, 'caixa.movimento_cancelado', {
        movimentos_caixa: {
          id: uuidv7(),
          cancelado: true,
          cancelado_em: agora(),
          cancelado_por_id: operador,
          motivo_cancelamento: 'Lançado por engano',
        },
      }),
      evento(p, 'caixa.aberto', abertura(p, '10.00', { terminal_id: uuidv7() })),
    ]);
    expect(r.map((x) => x.erro?.codigo)).toEqual([
      'PAYLOAD_INVALIDO',
      'SESSAO_INEXISTENTE',
      'TRANSICAO_INVALIDA',
      'ESCOPO_INVALIDO',
    ]);
  });
});

describe('abertura com a sessão anterior pendente (T11)', () => {
  it('fechamento em erro → a abertura seguinte fica retida, e não SESSAO_DUPLICADA; reprocessar libera', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const sA = idSessao(a);
    // Forma que ainda não existe na nuvem: o fechamento vai a `erro` (23503 → REFERENCIA_INEXISTENTE, T14).
    const formaNova = uuidv7();
    const evA = evento(p, 'caixa.aberto', a);
    const fA = fechamento(p, sA, { forma: formaNova });
    const b = abertura(p, '100.00');
    const sB = idSessao(b);
    const evFA = evento(p, 'caixa.fechado', fA);
    const evB = evento(p, 'caixa.aberto', b);
    const evSangriaB = evento(p, 'caixa.sangria', {
      movimentos_caixa: movimento(p, sB, 'sangria', '20.00', { quem_retira_nome: 'CARLOS' }),
      contagem_cedulas: null,
    });
    const r = await pushOk(p, [evA, evFA, evB, evSangriaB]);
    expect(r.map((x) => [x.status, x.erro?.codigo ?? null])).toEqual([
      ['aplicado', null],
      ['rejeitado', 'REFERENCIA_INEXISTENTE'],
      ['retido', 'DEPENDENCIA_PENDENTE'],
      // A sessão B nasceu num evento retido (`entidades_evento`): a sangria dela também espera.
      ['retido', 'DEPENDENCIA_PENDENTE'],
    ]);
    const linhaB = await linhaEvento(evB.evento_id);
    expect(linhaB!.dependencias).toEqual(
      expect.arrayContaining([
        { agregado_tipo: 'sessao_caixa', agregado_id: sA },
        { evento_id_bloqueador: evFA.evento_id },
      ]),
    );
    // A sessão A segue aberta na nuvem e B não existe.
    expect(await sessaoNaNuvem(sA)).toMatchObject({ status: 'aberta' });
    expect(await sessaoNaNuvem(sB)).toBeUndefined();

    // A forma é cadastrada e o suporte reprocessa (C8 fará isso pela fila de decisão, em ordem de sequência).
    await consultar(
      emp.nomeBanco,
      `insert into formas_pagamento (id, ordem, descricao, tipo_forma, meio_pagamento_fiscal)
       values ($1, 99, 'Dinheiro 2', 'dinheiro', '01')`,
      [formaNova],
    );
    expect(await reaplicar(p.terminal, evFA.evento_id)).toMatchObject({ status: 'aplicado' });
    expect(await reaplicar(p.terminal, evB.evento_id)).toMatchObject({ status: 'aplicado' });
    expect(await reaplicar(p.terminal, evSangriaB.evento_id)).toMatchObject({ status: 'aplicado' });
    expect(await sessaoNaNuvem(sA)).toMatchObject({ status: 'fechada' });
    expect(await sessaoNaNuvem(sB)).toMatchObject({ status: 'aberta' });
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: sB });
  });

  it('outra sessão aberta sem nada pendente → SESSAO_DUPLICADA (banco local perdido, SYNC 22.1)', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const b = abertura(p);
    const r = await pushOk(p, [evento(p, 'caixa.aberto', a), evento(p, 'caixa.aberto', b)]);
    expect(r.map((x) => [x.status, x.erro?.codigo ?? null])).toEqual([
      ['aplicado', null],
      ['rejeitado', 'SESSAO_DUPLICADA'],
    ]);
  });

  it('troca de turno: a abertura seguinte preenche o usuário subsequente do fechamento anterior', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const sA = idSessao(a);
    const f = fechamento(p, sA, { tipo: 'troca_turno' });
    const b = abertura(p, '150.00', {
      sessao_anterior_id: sA,
      valor_recebido_anterior: '150.00',
      diferenca_recebimento: '0.00',
    });
    const r = await pushOk(p, [
      evento(p, 'caixa.aberto', a),
      evento(p, 'caixa.fechado', f),
      evento(p, 'caixa.aberto', b),
    ]);
    expect(
      r.map((x) => x.status),
      JSON.stringify(r),
    ).toEqual(['aplicado', 'aplicado', 'aplicado']);
    const [fech] = await consultar(
      emp.nomeBanco,
      'select usuario_subsequente_id, zera_caixa from fechamentos_caixa where sessao_caixa_id = $1',
      [sA],
    );
    expect(fech).toEqual({ usuario_subsequente_id: operador, zera_caixa: false });
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: idSessao(b) });
  });

  it('troca de turno pedida pelo próximo operador: a auditoria do fechamento fica com quem contou', async () => {
    // PDV 8.1 (C10a): B fecha a sessão de A; o envelope leva B (quem executou, SYNC 7.3) e o fechamento continua de A.
    const [{ id: proximo }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into usuarios (nome, login, master) values ('OPERADOR B', $1, true) returning id",
      [`operador_${uuidv7().slice(-8)}`],
    )) as [{ id: string }];
    const p = await novoPonto();
    const a = abertura(p);
    const sA = idSessao(a);
    const f = fechamento(p, sA, { tipo: 'troca_turno' });
    const r = await pushOk(p, [
      evento(p, 'caixa.aberto', a),
      evento(p, 'caixa.fechado', f, { usuario_id: proximo }),
    ]);
    expect(r.map((x) => x.status)).toEqual(['aplicado', 'aplicado']);
    const linhas = await consultar<{ usuario_id: string; depois: { usuario_anterior_id: string } }>(
      emp.nomeBanco,
      "select usuario_id, depois from auditoria where entidade = 'fechamentos_caixa' and registro_id = $1",
      [f.fechamentos_caixa.id],
    );
    expect(linhas.map((l) => [l.usuario_id, l.depois.usuario_anterior_id])).toEqual([[proximo, operador]]);
    const [fech] = await consultar(
      emp.nomeBanco,
      'select usuario_anterior_id from fechamentos_caixa where id = $1',
      [f.fechamentos_caixa.id],
    );
    expect(fech).toEqual({ usuario_anterior_id: operador });
  });

  it('troca de turno: anterior de outro terminal → ESCOPO_INVALIDO; o subsequente é gravado uma vez só', async () => {
    const [{ id: outroOperador }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into usuarios (nome, login, master) values ('OPERADOR 2', $1, true) returning id",
      [`operador_${uuidv7().slice(-8)}`],
    )) as [{ id: string }];
    const subsequente = async (sessao: string) =>
      (
        await consultar<{ usuario_subsequente_id: string | null }>(
          emp.nomeBanco,
          'select usuario_subsequente_id from fechamentos_caixa where sessao_caixa_id = $1',
          [sessao],
        )
      )[0]?.usuario_subsequente_id;

    // O caixa 1 fechou o turno com troca de turno; o caixa 2 (bug ou banco de outro caixa) cita essa sessão.
    const q = await novoPonto();
    const aQ = abertura(q);
    const sQ = idSessao(aQ);
    await pushOk(q, [
      evento(q, 'caixa.aberto', aQ),
      evento(q, 'caixa.fechado', fechamento(q, sQ, { tipo: 'troca_turno' })),
    ]);
    const p = await novoPonto();
    const alheia = abertura(p, '150.00', { sessao_anterior_id: sQ, valor_recebido_anterior: '150.00' });
    const r1 = await pushOk(p, [evento(p, 'caixa.aberto', alheia)]);
    expect(r1.map((x) => x.erro?.codigo)).toEqual(['ESCOPO_INVALIDO']);
    expect(await subsequente(sQ)).toBeNull();
    expect(await sessaoNaNuvem(idSessao(alheia))).toBeUndefined();

    // Banco local perdido (SYNC 22.1): duas aberturas citam a mesma anterior; a primeira, que continuou o turno, fica.
    const a = abertura(p);
    const sA = idSessao(a);
    const b = abertura(p, '150.00', { sessao_anterior_id: sA, operador_id: outroOperador });
    const sB = idSessao(b);
    const bDeNovo = abertura(p, '150.00', { sessao_anterior_id: sA });
    const r2 = await pushOk(p, [
      evento(p, 'caixa.aberto', a),
      evento(p, 'caixa.fechado', fechamento(p, sA, { tipo: 'troca_turno' })),
      evento(p, 'caixa.aberto', b),
      evento(p, 'caixa.fechado', fechamento(p, sB)),
      evento(p, 'caixa.aberto', bDeNovo),
    ]);
    expect(
      r2.map((x) => x.status),
      JSON.stringify(r2),
    ).toEqual(['aplicado', 'aplicado', 'aplicado', 'aplicado', 'aplicado']);
    expect(await subsequente(sA)).toBe(outroOperador);
  });
});

describe('terminais.sessao_caixa_id com condição (T12)', () => {
  it('heartbeat com a sessão B antes do caixa.fechado de A: o fechamento tardio não apaga B', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const sA = idSessao(a);
    await pushOk(p, [evento(p, 'caixa.aberto', a)]);
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: sA });
    // Offline: o caixa fechou A e abriu B; ao voltar, o heartbeat chega antes do push.
    const b = abertura(p, '100.00');
    const sB = idSessao(b);
    const evFA = evento(p, 'caixa.fechado', fechamento(p, sA));
    const evB = evento(p, 'caixa.aberto', b);
    const hb = await heartbeat(p, { eventos_pendentes: 2, sessao_caixa_id: sB, operador_id: operador });
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: sB });
    expect((await pushOk(p, [evFA]))[0]).toMatchObject({ status: 'aplicado' });
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: sB });
    expect((await pushOk(p, [evB]))[0]).toMatchObject({ status: 'aplicado' });
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: sB });
  });

  it('a abertura não sobrescreve uma sessão mais nova que o heartbeat já informou', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const sA = idSessao(a);
    const sC = uuidv7();
    await heartbeat(p, { eventos_pendentes: 3, sessao_caixa_id: sC, operador_id: operador });
    await pushOk(p, [evento(p, 'caixa.aberto', a)]);
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: sC });
    expect(await sessaoNaNuvem(sA)).toMatchObject({ status: 'aberta' });
  });

  it('fechamento com evento do turno em erro → alerta FECHAMENTO_EVENTOS_PENDENTES; o turno seguinte não herda', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const sA = idSessao(a);
    const evA = evento(p, 'caixa.aberto', a);
    // Quem retira que a nuvem não tem: a sangria vai a `erro` (REFERENCIA_INEXISTENTE) e não retém o fechamento.
    const evSangria = evento(p, 'caixa.sangria', {
      movimentos_caixa: movimento(p, sA, 'sangria', '20.00', { quem_retira_usuario_id: uuidv7() }),
      contagem_cedulas: null,
    });
    // O PDV cita a sequência do último evento antes do próprio `caixa.fechado` (aqui, a sangria).
    const fA = fechamento(p, sA);
    expect(fA.fechamentos_caixa.resumo.ultima_sequencia_evento).toBe(evSangria.sequencia);
    const r = await pushOk(p, [evA, evSangria, evento(p, 'caixa.fechado', fA)]);
    expect(r.map((x) => [x.status, x.erro?.codigo ?? null])).toEqual([
      ['aplicado', null],
      ['rejeitado', 'REFERENCIA_INEXISTENTE'],
      ['aplicado', null],
    ]);
    expect(r[2]!.resultado).toMatchObject({ eventos_pendentes: 1 });
    const alertas = await consultar<{ dados: Record<string, unknown> }>(
      emp.nomeBanco,
      "select dados from alertas where tipo = 'FECHAMENTO_EVENTOS_PENDENTES' and registro_id = $1",
      [fA.fechamentos_caixa.id],
    );
    expect(alertas).toEqual([
      {
        dados: expect.objectContaining({
          ultima_sequencia_evento: evSangria.sequencia,
          sequencias_pendentes: [evSangria.sequencia],
        }),
      },
    ]);

    // A sangria em erro é do turno anterior: o fechamento do turno seguinte não a conta.
    const b = abertura(p);
    const evB = evento(p, 'caixa.aberto', b);
    const fB = fechamento(p, idSessao(b));
    const r2 = await pushOk(p, [evB, evento(p, 'caixa.fechado', fB)]);
    expect(r2.map((x) => x.status)).toEqual(['aplicado', 'aplicado']);
    expect(r2[1]!.resultado).not.toHaveProperty('eventos_pendentes');
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from alertas where tipo = 'FECHAMENTO_EVENTOS_PENDENTES' and registro_id = $1",
      [fB.fechamentos_caixa.id],
    )) as [{ n: number }];
    expect(n).toBe(0);
  });
});

describe('fechamento forçado e eventos tardios (MD 3.12.1; T16)', () => {
  it('substituição: a sessão do antigo fecha à força; tardios entram nela; abertura nova já fechada', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const s = idSessao(a);
    await pushOk(p, [evento(p, 'caixa.aberto', a)]);
    const novo = await ativar(p.caixa, { substituiTerminalId: p.terminal });
    const forcada = await sessaoNaNuvem(s);
    expect(forcada).toMatchObject({
      status: 'fechada',
      fechamento_forcado: true,
      fechamento_forcado_motivo: 'substituicao_terminal',
    });
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: null });
    const alerta = await consultar(
      emp.nomeBanco,
      "select tipo from alertas where tipo = 'SESSAO_FECHADA_POR_SUBSTITUICAO' and registro_id = $1",
      [s],
    );
    expect(alerta).toHaveLength(1);

    // O antigo (`desativando`) ainda envia o que tinha: sangria e fechamento entram na sessão já fechada.
    const sangria = movimento(p, s, 'sangria', '30.00', { quem_retira_nome: 'CARLOS' });
    const f = fechamento(p, s);
    const b = abertura(p, '20.00');
    const r = await pushOk(p, [
      evento(p, 'caixa.sangria', { movimentos_caixa: sangria, contagem_cedulas: null }),
      evento(p, 'caixa.fechado', f),
      evento(p, 'caixa.aberto', b),
    ]);
    expect(
      r.map((x) => x.status),
      JSON.stringify(r),
    ).toEqual(['aplicado', 'aplicado', 'aplicado']);
    expect(r[0]!.resultado).toMatchObject({ sessao_fechada: true });
    expect(r[1]!.resultado).toMatchObject({ sessao_fechada_a_forca: true });
    expect(r[2]!.resultado).toMatchObject({ fechamento_forcado: 'substituicao_terminal' });
    // `fechamento_forcado` e o `fechada_em` da nuvem continuam (auditoria); o fechamento do PDV foi gravado.
    expect(await sessaoNaNuvem(s)).toEqual(forcada);
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from fechamentos_caixa where sessao_caixa_id = $1',
      [s],
    )) as [{ n: number }];
    expect(n).toBe(1);
    expect(await sessaoNaNuvem(idSessao(b))).toMatchObject({
      status: 'fechada',
      fechamento_forcado: true,
      fechamento_forcado_motivo: 'substituicao_terminal',
    });
    // Nem a abertura tardia do antigo nem a sessão dele aparecem como sessão do terminal novo (MD 3.12.1).
    const pNovo: Ponto = { caixa: p.caixa, numero: p.numero, ...novo, seq: 0 };
    expect((await estado(pNovo)).sessao_caixa_aberta).toBeNull();
    // Mesmo com uma sessão do antigo ainda aberta (ex.: gravada antes desta regra), o novo não a vê.
    await consultar(
      emp.nomeBanco,
      `insert into sessoes_caixa (loja_id, caixa_id, numero_caixa, terminal_id, operador_id, dia_operacional, aberta_em)
       values ($1, $2, $3, $4, $5, '2026-10-31', now())`,
      [loja, p.caixa, p.numero, p.terminal, operador],
    );
    expect((await estado(pNovo)).sessao_caixa_aberta).toBeNull();
    const aNovo = abertura(pNovo);
    expect((await pushOk(pNovo, [evento(pNovo, 'caixa.aberto', aNovo)]))[0]).toMatchObject({
      status: 'aplicado',
    });
    expect((await estado(pNovo)).sessao_caixa_aberta).toMatchObject({ id: idSessao(aNovo) });
  });

  it('aceitar pendências: o desativando ainda dono do caixa abre normalmente; a desativação confirmada fecha', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const sA = idSessao(a);
    await pushOk(p, [evento(p, 'caixa.aberto', a)]);
    const rev = await erp().post(`/api/terminais/${p.terminal}/revogar`, { modo: 'aceitar_pendencias' });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);

    // O outbox de quando o caixa estava offline: fecha A, abre, sangra e fecha B. O terminal está `desativando`, mas
    // o caixa ainda é dele: nada disso é evento tardio de substituído ou revogado (T16).
    const evFA = evento(p, 'caixa.fechado', fechamento(p, sA));
    const b = abertura(p);
    const sB = idSessao(b);
    const evB = evento(p, 'caixa.aberto', b);
    const evSangria = evento(p, 'caixa.sangria', {
      movimentos_caixa: movimento(p, sB, 'sangria', '30.00', { quem_retira_nome: 'CARLOS' }),
      contagem_cedulas: null,
    });
    const evFB = evento(p, 'caixa.fechado', fechamento(p, sB));
    // Abertura com um operador que a nuvem não tem: fica em `erro` e é reprocessada depois da revogação.
    const d = abertura(p, '0.00', { operador_id: uuidv7() });
    const evD = evento(p, 'caixa.aberto', d);
    // E um turno que o caixa deixou aberto ao se desativar.
    const c = abertura(p);
    const sC = idSessao(c);
    const evC = evento(p, 'caixa.aberto', c);
    const r = await pushOk(p, [evFA, evB, evSangria, evFB, evD, evC]);
    expect(r.map((x) => [x.status, x.erro?.codigo ?? null])).toEqual([
      ['aplicado', null],
      ['aplicado', null],
      ['aplicado', null],
      ['aplicado', null],
      ['rejeitado', 'REFERENCIA_INEXISTENTE'],
      ['aplicado', null],
    ]);
    expect(r[1]!.resultado).not.toHaveProperty('fechamento_forcado');
    for (const sessao of [sA, sB]) {
      expect(await sessaoNaNuvem(sessao)).toMatchObject({
        status: 'fechada',
        fechamento_forcado: false,
        fechamento_forcado_motivo: null,
      });
    }
    expect(await sessaoNaNuvem(sC)).toMatchObject({ status: 'aberta', fechamento_forcado: false });
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: sC });
    const alertasSessao = (sessoes: string[]) =>
      consultar<{ registro_id: string; dados: Record<string, unknown> }>(
        emp.nomeBanco,
        "select registro_id, dados from alertas where tipo = 'SESSAO_FECHADA_POR_SUBSTITUICAO' and registro_id = any($1::uuid[])",
        [sessoes],
      );
    expect(await alertasSessao([sA, sB, sC])).toEqual([]);

    // Desativação confirmada (tudo recebido): o turno C, deixado aberto, fecha à força como na revogação.
    const hb = await heartbeat(p, {
      estado_local: 'desativando_confirmado',
      eventos_pendentes: 0,
      ultima_sequencia_gerada: p.seq,
    });
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    expect(hb.body.status_terminal).toBe('revogado');
    expect(await sessaoNaNuvem(sC)).toMatchObject({
      status: 'fechada',
      fechamento_forcado: true,
      fechamento_forcado_motivo: 'revogacao_terminal',
    });
    expect(await sessaoDoTerminal(p.terminal)).toMatchObject({ sessao_caixa_id: null });
    expect(await alertasSessao([sC])).toEqual([
      { registro_id: sC, dados: expect.objectContaining({ motivo: 'revogacao_terminal' }) },
    ]);

    // A abertura em erro, corrigida e reprocessada com o terminal já `revogado`: entra fechada à força (T16).
    await consultar(
      emp.nomeBanco,
      `update eventos_recebidos set payload = jsonb_set(payload, '{sessoes_caixa,operador_id}', to_jsonb($2::text))
        where evento_id = $1`,
      [evD.evento_id, operador],
    );
    expect(await reaplicar(p.terminal, evD.evento_id)).toMatchObject({
      status: 'aplicado',
      resultado: { fechamento_forcado: 'revogacao_terminal' },
    });
    expect(await sessaoNaNuvem(idSessao(d))).toMatchObject({
      status: 'fechada',
      fechamento_forcado: true,
      fechamento_forcado_motivo: 'revogacao_terminal',
    });
    expect(await alertasSessao([idSessao(d)])).toEqual([
      {
        registro_id: idSessao(d),
        dados: expect.objectContaining({ motivo: 'revogacao_terminal', terminal_status: 'revogado' }),
      },
    ]);
  });

  it('revogação imediata: a sessão aberta fecha à força; o fechamento tardio (reprocessado) é gravado', async () => {
    const p = await novoPonto();
    const a = abertura(p);
    const s = idSessao(a);
    await pushOk(p, [evento(p, 'caixa.aberto', a)]);
    // Um evento do turno ficou em erro: depois da revogação ele é reprocessado pela fila de decisão (D20).
    const evF = evento(p, 'caixa.fechado', fechamento(p, s, { forma: uuidv7() }));
    expect((await pushOk(p, [evF]))[0]).toMatchObject({ erro: { codigo: 'REFERENCIA_INEXISTENTE' } });
    const rev = await erp().post(`/api/terminais/${p.terminal}/revogar`, {
      modo: 'imediato',
      confirmacaoCaixa: p.numero,
    });
    expect(rev.status, JSON.stringify(rev.body)).toBeLessThan(300);
    expect(await sessaoNaNuvem(s)).toMatchObject({
      status: 'fechada',
      fechamento_forcado: true,
      fechamento_forcado_motivo: 'revogacao_terminal',
    });
    // Corrige a referência do fechamento (outra forma) e reaplica o evento corrigido como o suporte faria.
    await consultar(
      emp.nomeBanco,
      `update eventos_recebidos set payload = jsonb_set(payload, '{fechamentos_caixa_formas,0,forma_pagamento_id}', to_jsonb($2::text))
        where evento_id = $1`,
      [evF.evento_id, dinheiro],
    );
    expect(await reaplicar(p.terminal, evF.evento_id)).toMatchObject({
      status: 'aplicado',
      resultado: { sessao_fechada_a_forca: true },
    });
    expect(await sessaoNaNuvem(s)).toMatchObject({ fechamento_forcado: true });
  });
});
