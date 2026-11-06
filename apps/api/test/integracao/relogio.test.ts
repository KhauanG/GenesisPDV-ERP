/**
 * Relógio na nuvem (bloco C16 da Fase 1C; SYNC 12.4, 21.2, 21.3), pelo push e pelo heartbeat reais. Por evento:
 * `RELOGIO_SUSPEITO` no futuro, no passado (antes da ativação), na regressão sem a marca do caixa (aviso) e com ela
 * (`info`, uma por regressão), sempre com o evento aplicado; uma avaliação por evento recebido (o reenvio não conta,
 * o evento em erro também conta, uma vez); o "Ciente". Pelo heartbeat: `RELOGIO_DESVIO` aviso acima de 2 min, crítico
 * acima de 5 min (no painel do Dashboard), fechado com o desvio normal, com a revogação e com a desativação confirmada,
 * sem reabrir no heartbeat de um terminal que a empresa já revogou (e a manutenção fecha o que escapar); a coluna
 * "Relógio" da listagem. A regressão marcada somada por terminal na tela (o "Ciente" fecha todas) sem tirar das vagas
 * os outros alertas; o placeholder de lacuna fora do "anterior" e o evento real que o substitui avaliado. E a
 * auditoria `relogio_regrediu` que o caixa grava sobe pelo `auditoria.registros`.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  jcs,
  respostaPushSchema,
  type Ativar,
  type Dashboard,
  type ListagemTerminais,
  type TerminalDetalhe,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;
const MIN = 60_000;
const DIA = 86_400_000;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let tokenAdmin: string;
let admin: string;

type Payload = Record<string, unknown>;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const bearer = () => ({ Authorization: `Bearer ${tokenAdmin}` });
const daqui = (ms: number) => new Date(Date.now() + ms).toISOString();

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
  numero: number;
  caixa: string;
  terminal: string;
  token: string;
  seq: number;
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
  return { numero, caixa, terminal: r.body.terminal_id, token: r.body.token, seq: 0 };
}

/** Um lote de auditoria (tipo da 1B, sem dependências) com a hora do envelope dada. */
function evento(
  p: Ponto,
  ocorridoEm: string,
  extra: { regrediu?: boolean; acao?: string; hashErrado?: boolean } = {},
) {
  const payload: Payload = {
    registros: [
      {
        id: uuidv7(),
        ocorrido_em: ocorridoEm,
        usuario_id: admin,
        acao: extra.acao ?? 'login',
        entidade: 'pdv',
        localizacao: 'pdv.login',
        descricao: 'Login de teste',
      },
    ],
    logins: [],
  };
  return {
    evento_id: uuidv7(),
    sequencia: ++p.seq,
    tipo: 'auditoria.registros',
    versao_schema: 1,
    agregado_tipo: 'auditoria',
    agregado_id: uuidv7(),
    dependencias: [],
    ocorrido_em: ocorridoEm,
    relogio_confiavel: false,
    desvio_relogio_ms: 1500,
    ...(extra.regrediu ? { relogio_regrediu: true } : {}),
    usuario_id: admin,
    contexto: { loja_id: loja, caixa_id: p.caixa, numero_caixa: p.numero, versao_app: '1.0.0' },
    payload,
    payload_sha256: extra.hashErrado
      ? '0'.repeat(64)
      : createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

async function pushOk(p: Ponto, eventos: unknown[], extra: Payload = {}) {
  const r = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(p.token))
    .send({
      lote_id: uuidv7(),
      terminal_id: p.terminal,
      enviado_em: new Date().toISOString(),
      eventos,
      ...extra,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return respostaPushSchema
    .parse(r.body)
    .resultados.map((x) => (x.erro ? `${x.status}:${x.erro.codigo}` : x.status));
}

const alertas = (p: Ponto, tipo: string) =>
  consultar<{
    id: string;
    severidade: string;
    titulo: string;
    resolvido_em: Date | null;
    resolucao: string | null;
    chave_deduplicacao: string;
    dados: Payload;
  }>(
    emp.nomeBanco,
    `select id, severidade, titulo, resolvido_em, resolucao, chave_deduplicacao, dados from alertas
      where tipo = $1 and entidade = 'terminais' and registro_id = $2 order by criado_em`,
    [tipo, p.terminal],
  );

const heartbeat = async (p: Ponto, desvioMs: number | null, extra: Payload = {}) => {
  const r = await amb
    .http()
    .post('/sync/heartbeat')
    .set(cabecalhos(p.token))
    .send({ eventos_pendentes: 0, desvio_relogio_ms: desvioMs, relogio_confiavel: true, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { status_terminal: string };
};

/** Alertas gravados direto no banco (volume e datas que o push levaria muito para produzir). */
const inserirAlertas = (
  p: Ponto,
  tipo: string,
  severidade: string,
  quantidade: number,
  extra: { motivo?: string; criadoEm?: string; chave: string },
) =>
  consultar(
    emp.nomeBanco,
    `insert into alertas (tipo, severidade, titulo, loja_id, entidade, registro_id, dados, chave_deduplicacao,
                          criado_em, atualizado_em, versao)
     select $1, $2, 'Alerta de teste ' || i, $3, 'terminais', $4::uuid,
            jsonb_build_object('terminal_id', $4::text, 'motivo', $5::text), $6 || ':' || i,
            coalesce($7::timestamptz, now()) + make_interval(secs => i), coalesce($7::timestamptz, now()), 0
       from generate_series(1, $8::int) i`,
    [
      tipo,
      severidade,
      loja,
      p.terminal,
      extra.motivo ?? null,
      extra.chave,
      extra.criadoEm ?? null,
      quantidade,
    ],
  );

const detalhe = async (p: Ponto) =>
  (await amb.http().get(`/api/terminais/${p.terminal}`).set(bearer())).body as TerminalDetalhe;

beforeAll(async () => {
  amb = await criarAmbiente({ env: { DASHBOARD_CACHE_MS: '0' } });
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  [{ id: admin }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('RELOGIO_SUSPEITO por evento (SYNC 12.4)', () => {
  it('futuro: aplica, um alerta por terminal somando as ocorrências; o reenvio não conta; "Ciente"', async () => {
    const p = await novoPonto();
    // 4 min à frente ainda é tolerado; 3 h à frente (BIOS adiantada) é suspeito.
    const ok = evento(p, daqui(4 * MIN));
    const adiantado = evento(p, daqui(3 * 60 * MIN));
    expect(await pushOk(p, [ok, adiantado])).toEqual(['aplicado', 'aplicado']);
    const [a] = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(a).toMatchObject({
      severidade: 'aviso',
      resolvido_em: null,
      chave_deduplicacao: `relogio_suspeito:${p.terminal}:futuro`,
      titulo: 'Caixa 01: relógio adiantado (evento no futuro)',
      dados: {
        terminal_id: p.terminal,
        motivo: 'futuro',
        evento_id: adiantado.evento_id,
        sequencia: 2,
        tipo: 'auditoria.registros',
        relogio_confiavel: false,
        desvio_relogio_ms: 1500,
        ocorrencias: 1,
      },
    });
    expect(a!.dados.diferenca_ms as number).toBeGreaterThan(179 * MIN);

    // O reenvio do mesmo lote (`duplicado`) não avalia de novo; o próximo adiantado soma no mesmo alerta.
    expect(await pushOk(p, [ok, adiantado])).toEqual(['duplicado', 'duplicado']);
    const outro = evento(p, daqui(3 * 60 * MIN + MIN));
    expect(await pushOk(p, [outro])).toEqual(['aplicado']);
    const somado = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(somado).toHaveLength(1);
    expect(somado[0]!.dados).toMatchObject({
      evento_id: adiantado.evento_id,
      ocorrencias: 2,
      ultimo_evento_id: outro.evento_id,
      ultima_sequencia: 3,
    });

    // No detalhe e na listagem do terminal; aviso não entra no painel de críticos do Dashboard.
    const d = await detalhe(p);
    const noDetalhe = d.alertas.find((x) => x.tipo === 'RELOGIO_SUSPEITO')!;
    expect(noDetalhe).toMatchObject({ severidade: 'aviso', terminalId: p.terminal });
    const lista = (await amb.http().get('/api/terminais').set(bearer())).body as ListagemTerminais;
    expect(lista.alertas.map((x) => x.id)).toContain(noDetalhe.id);
    const dash = (await amb.http().get('/api/dashboard').set(bearer())).body as Dashboard;
    expect(dash.alertasCriticos?.porTipo.map((t) => t.tipo) ?? []).not.toContain('RELOGIO_SUSPEITO');

    // "Ciente" depois de acertar o relógio; o próximo adiantado abre outro.
    const ciente = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/alertas/${noDetalhe.id}/resolver`)
      .set(bearer())
      .send({ resolucao: 'Relógio do computador acertado' });
    expect(ciente.status, JSON.stringify(ciente.body)).toBe(200);
    expect((ciente.body as TerminalDetalhe).alertas.map((x) => x.tipo)).not.toContain('RELOGIO_SUSPEITO');
    expect(await pushOk(p, [evento(p, daqui(4 * 60 * MIN))])).toEqual(['aplicado']);
    const depois = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(depois.map((x) => [x.resolucao, x.dados.ocorrencias])).toEqual([
      ['Relógio do computador acertado', 2],
      [null, 1],
    ]);
  });

  it('passado: antes da ativação (− 1 dia) é suspeito; o atraso de entrega de horas não', async () => {
    const p = await novoPonto();
    expect(await pushOk(p, [evento(p, daqui(-3 * DIA)), evento(p, daqui(-6 * 60 * MIN))])).toEqual([
      'aplicado',
      'aplicado',
    ]);
    const lista = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(lista.map((x) => [x.dados.motivo, x.dados.sequencia, x.severidade])).toEqual([
      ['passado', 1, 'aviso'],
    ]);
    expect(lista[0]!.titulo).toBe('Caixa 02: relógio atrasado (evento no passado)');
  });

  it('regressão: sem a marca e acima de 1 s é aviso; com a marca do caixa é info, uma por regressão', async () => {
    const p = await novoPonto();
    const base = Date.now() - 10 * MIN;
    const em = (ms: number) => new Date(base + ms).toISOString();
    expect(
      await pushOk(p, [
        evento(p, em(0)),
        // 800 ms antes: arredondamento, sem alerta.
        evento(p, em(-800)),
        // 3 min antes do anterior, sem a marca: defeito do PDV.
        evento(p, em(-3 * MIN)),
        evento(p, em(-3 * MIN + 1)),
      ]),
    ).toEqual(['aplicado', 'aplicado', 'aplicado', 'aplicado']);
    const semMarca = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(semMarca.map((x) => [x.dados.motivo, x.dados.sequencia, x.dados.sequencia_anterior])).toEqual([
      ['regressao', 3, 2],
    ]);

    // O relógio foi corrigido para trás duas vezes, cada uma marcada pelo caixa: um `info` por regressão.
    const r1 = evento(p, em(-5 * MIN), { regrediu: true });
    const r2 = evento(p, em(-4 * MIN));
    const r3 = evento(p, em(-6 * MIN), { regrediu: true });
    expect(await pushOk(p, [r1, r2, r3])).toEqual(['aplicado', 'aplicado', 'aplicado']);
    const todos = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(todos.map((x) => [x.dados.motivo, x.severidade, x.chave_deduplicacao])).toEqual([
      ['regressao', 'aviso', `relogio_suspeito:${p.terminal}:regressao`],
      ['regressao_marcada', 'info', `relogio_regrediu:${r1.evento_id}`],
      ['regressao_marcada', 'info', `relogio_regrediu:${r3.evento_id}`],
    ]);
    // O aviso sem marca continua com uma ocorrência: as regressões marcadas não somam nele.
    expect(todos[0]!.dados.ocorrencias).toBe(1);
    // Na tela, as duas vêm somadas numa linha (com o id da mais recente).
    expect((await detalhe(p)).alertas.filter((x) => x.severidade === 'info')).toMatchObject([
      { titulo: `Caixa ${String(p.numero).padStart(2, '0')}: relógio do computador voltou 2 vezes` },
    ]);
  });

  it('regressão marcada: somada por terminal na tela, o "Ciente" fecha todas e não tira os outros alertas das vagas', async () => {
    const p = await novoPonto();
    const caixa = String(p.numero).padStart(2, '0');
    const base = Date.now() - 10 * MIN;
    const em = (ms: number) => new Date(base + ms).toISOString();
    // Três correções do relógio para trás, cada uma marcada pelo caixa: três `info` no banco.
    expect(
      await pushOk(p, [
        evento(p, em(0)),
        evento(p, em(-MIN), { regrediu: true }),
        evento(p, em(-2 * MIN), { regrediu: true }),
        evento(p, em(-3 * MIN), { regrediu: true }),
      ]),
    ).toEqual(['aplicado', 'aplicado', 'aplicado', 'aplicado']);
    const noBanco = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(noBanco.map((x) => x.dados.motivo)).toEqual([
      'regressao_marcada',
      'regressao_marcada',
      'regressao_marcada',
    ]);
    // Na tela, uma linha só, com o id da mais recente.
    const somada = (await detalhe(p)).alertas.filter((x) => x.tipo === 'RELOGIO_SUSPEITO');
    expect(somada).toMatchObject([
      {
        id: noBanco[2]!.id,
        severidade: 'info',
        titulo: `Caixa ${caixa}: relógio do computador voltou 3 vezes`,
      },
    ]);

    // Um token anterior reutilizado (crítico, D20) de ontem e, mais novas, 60 regressões marcadas de outro caixa e 60
    // avisos dele: o crítico continua na listagem e no detalhe do terminal (o filtro do terminal vem antes do limite).
    const outro = await novoPonto();
    await inserirAlertas(p, 'TOKEN_ANTERIOR_REUTILIZADO', 'critico', 1, {
      chave: `teste_token:${p.terminal}`,
      criadoEm: new Date(Date.now() - DIA).toISOString(),
    });
    await inserirAlertas(outro, 'RELOGIO_SUSPEITO', 'info', 60, {
      motivo: 'regressao_marcada',
      chave: `teste_regrediu:${outro.terminal}`,
    });
    const token = (await detalhe(p)).alertas.find((x) => x.tipo === 'TOKEN_ANTERIOR_REUTILIZADO');
    expect(token).toMatchObject({ severidade: 'critico', terminalId: p.terminal });
    const lista = (await amb.http().get('/api/terminais').set(bearer())).body as ListagemTerminais;
    expect(lista.alertas.map((x) => x.id)).toContain(token!.id);
    expect(
      lista.alertas.filter((x) => x.tipo === 'RELOGIO_SUSPEITO' && x.terminalId === outro.terminal),
    ).toMatchObject([
      {
        severidade: 'info',
        titulo: `Caixa ${String(outro.numero).padStart(2, '0')}: relógio do computador voltou 60 vezes`,
      },
    ]);
    await inserirAlertas(outro, 'RELOGIO_SUSPEITO', 'aviso', 60, { chave: `teste_aviso:${outro.terminal}` });
    expect((await detalhe(p)).alertas.map((x) => x.id)).toContain(token!.id);

    // O "Ciente" da linha somada fecha as três (as que a tela mostrava), com uma auditoria só.
    const ciente = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/alertas/${somada[0]!.id}/resolver`)
      .set(bearer())
      .send({ resolucao: 'Sincronização automática do Windows ligada' });
    expect(ciente.status, JSON.stringify(ciente.body)).toBe(200);
    expect((ciente.body as TerminalDetalhe).alertas.map((x) => x.tipo)).not.toContain('RELOGIO_SUSPEITO');
    expect((await alertas(p, 'RELOGIO_SUSPEITO')).map((x) => x.resolucao)).toEqual([
      'Sincronização automática do Windows ligada',
      'Sincronização automática do Windows ligada',
      'Sincronização automática do Windows ligada',
    ]);
    const [aud] = await consultar<{ descricao: string; depois: Payload }>(
      emp.nomeBanco,
      "select descricao, depois from auditoria where acao = 'conferir' and registro_id = $1",
      [p.terminal],
    );
    expect(aud!.descricao).toContain('(com 2 correções anteriores do relógio)');
    expect(aud!.depois.alertas_ids).toHaveLength(3);
    // As do outro terminal não foram tocadas; a próxima regressão marcada deste abre outra.
    expect(await pushOk(p, [evento(p, em(-4 * MIN), { regrediu: true })])).toEqual(['aplicado']);
    expect((await alertas(p, 'RELOGIO_SUSPEITO')).filter((x) => x.resolvido_em === null)).toHaveLength(1);
    await consultar(emp.nomeBanco, "delete from alertas where chave_deduplicacao like 'teste\\_%'");
  });

  it('lacuna (C15): o placeholder fica fora do "anterior"; o evento real que o substitui é avaliado', async () => {
    const p = await novoPonto();
    const base = Date.now() - 10 * MIN;
    const em = (ms: number) => new Date(base + ms).toISOString();
    const e1 = evento(p, em(0));
    // O 2 se perdeu no caixa; volta depois (backup) 5 min antes do 1, sem a marca: regressão.
    const e2 = evento(p, em(-5 * MIN));
    const e3 = evento(p, em(MIN));
    // O 4 volta com a ação fora do catálogo (erro de regra gravado à parte, `gravarFalha`) e 1 dia no futuro.
    const e4 = evento(p, daqui(DIA), { acao: 'acao_inventada' });
    const e5 = evento(p, em(2 * MIN));
    const declarar = (de: number) => ({
      declarar_lacuna: {
        de,
        ate: de,
        motivo: 'banco_local_perdido',
        observacao: 'Banco do caixa trocado',
        autorizado_por_id: admin,
      },
    });
    const recuperar = (de: number) => ({ recuperar_lacuna: { de, ate: de, autorizado_por_id: admin } });
    expect(await pushOk(p, [e1])).toEqual(['aplicado']);
    expect(await pushOk(p, [e3])).toEqual(['fora_de_ordem']);
    expect(await pushOk(p, [], declarar(2))).toEqual([]);
    // O placeholder tem a hora da declaração (agora, 9 min depois do 3): como "anterior", daria regressão.
    expect(await pushOk(p, [e3])).toEqual(['aplicado']);
    expect(await pushOk(p, [], declarar(4))).toEqual([]);
    expect(await pushOk(p, [e5])).toEqual(['aplicado']);
    expect(await alertas(p, 'RELOGIO_SUSPEITO')).toEqual([]);

    expect(await pushOk(p, [e2], recuperar(2))).toEqual(['aplicado']);
    expect(await pushOk(p, [e4], recuperar(4))).toEqual(['rejeitado:PAYLOAD_INVALIDO']);
    const lista = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(
      lista.map((x) => [x.dados.motivo, x.dados.evento_id, x.dados.sequencia, x.dados.sequencia_anterior]),
    ).toEqual([
      ['regressao', e2.evento_id, 2, 1],
      // O anterior do 4 é o 3 (o 2 já é o evento real).
      ['futuro', e4.evento_id, 4, 3],
    ]);
  });

  it('o evento em erro também é avaliado, uma vez (na transação que grava o erro)', async () => {
    const p = await novoPonto();
    // Hash divergente (erro na mesma transação) e ação fora do catálogo (erro de regra gravado à parte).
    const hash = evento(p, daqui(DIA), { hashErrado: true });
    const acao = evento(p, daqui(DIA + MIN), { acao: 'acao_inventada' });
    expect(await pushOk(p, [hash, acao])).toEqual([
      'rejeitado:PAYLOAD_INVALIDO',
      'rejeitado:PAYLOAD_INVALIDO',
    ]);
    expect(await pushOk(p, [hash, acao])).toEqual([
      'rejeitado:PAYLOAD_INVALIDO',
      'rejeitado:PAYLOAD_INVALIDO',
    ]);
    const [a] = await alertas(p, 'RELOGIO_SUSPEITO');
    expect(a!.dados).toMatchObject({ motivo: 'futuro', evento_id: hash.evento_id, ocorrencias: 2 });
    expect(a!.dados.ultimo_evento_id).toBe(acao.evento_id);
  });

  it('a auditoria relogio_regrediu do caixa sobe pelo auditoria.registros', async () => {
    const p = await novoPonto();
    const ev = evento(p, daqui(0), { acao: 'relogio_regrediu' });
    expect(await pushOk(p, [ev])).toEqual(['aplicado']);
    const [linha] = await consultar<{ acao: string; origem: string; terminal_id: string }>(
      emp.nomeBanco,
      "select acao, origem, terminal_id from auditoria where acao = 'relogio_regrediu' and terminal_id = $1",
      [p.terminal],
    );
    expect(linha).toMatchObject({ acao: 'relogio_regrediu', origem: 'pdv' });
  });
});

describe('RELOGIO_DESVIO pelo heartbeat (SYNC 12.4, 21.2)', () => {
  it('> 2 min aviso, > 5 min crítico no Dashboard, fecha sozinho; sem "Ciente"; coluna Relógio', async () => {
    const p = await novoPonto();
    await heartbeat(p, 90_000);
    expect(await alertas(p, 'RELOGIO_DESVIO')).toEqual([]);

    // 3 min com o computador adiantado (desvio = servidor − local negativo).
    await heartbeat(p, -3 * MIN);
    const [aviso] = await alertas(p, 'RELOGIO_DESVIO');
    expect(aviso).toMatchObject({
      severidade: 'aviso',
      chave_deduplicacao: `relogio_desvio:${p.terminal}`,
      titulo: `Caixa ${String(p.numero).padStart(2, '0')}: relógio do computador 3 min adiantado`,
      dados: { desvio_relogio_ms: -3 * MIN, maior_desvio_ms: 3 * MIN },
    });
    const item = (
      (await amb.http().get('/api/terminais').set(bearer())).body as ListagemTerminais
    ).itens.find((t) => t.id === p.terminal)!;
    expect(item).toMatchObject({ desvioRelogioMs: -3 * MIN, relogioConfiavel: true });

    // Pouca variação não regrava; 2 h atrasado vira crítico no mesmo alerta e entra no painel do Dashboard.
    await heartbeat(p, -3 * MIN - 2_000);
    expect((await alertas(p, 'RELOGIO_DESVIO'))[0]!.dados.desvio_relogio_ms).toBe(-3 * MIN);
    await heartbeat(p, 2 * 60 * MIN);
    const criticos = await alertas(p, 'RELOGIO_DESVIO');
    expect(criticos).toHaveLength(1);
    expect(criticos[0]).toMatchObject({
      severidade: 'critico',
      titulo: `Caixa ${String(p.numero).padStart(2, '0')}: relógio do computador 2 h atrasado`,
      dados: { desvio_relogio_ms: 2 * 60 * MIN, maior_desvio_ms: 2 * 60 * MIN },
    });
    const dash = (await amb.http().get('/api/dashboard').set(bearer())).body as Dashboard;
    expect(dash.alertasCriticos?.recentes.find((a) => a.tipo === 'RELOGIO_DESVIO')).toMatchObject({
      terminalId: p.terminal,
    });

    // Não tem "Ciente": fecha quando o relógio é acertado.
    const alerta = (await detalhe(p)).alertas.find((x) => x.tipo === 'RELOGIO_DESVIO')!;
    expect(alerta.severidade).toBe('critico');
    const ciente = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/alertas/${alerta.id}/resolver`)
      .set(bearer())
      .send({ resolucao: 'Relógio conferido' });
    expect(ciente.status).toBe(422);
    // Sem amostra, nada muda.
    await heartbeat(p, null);
    expect((await alertas(p, 'RELOGIO_DESVIO'))[0]!.resolvido_em).toBeNull();
    await heartbeat(p, 1_200);
    const fechado = await alertas(p, 'RELOGIO_DESVIO');
    expect(fechado[0]).toMatchObject({ resolucao: 'O desvio do relógio voltou a até 2 min' });
    expect(fechado[0]!.resolvido_em).not.toBeNull();
    // Voltou a errar: alerta novo.
    await heartbeat(p, 4 * MIN);
    expect((await alertas(p, 'RELOGIO_DESVIO')).map((x) => x.resolvido_em === null)).toEqual([false, true]);
  });

  it('a revogação fecha o desvio aberto (sem heartbeat depois, ele nunca voltaria ao normal)', async () => {
    const p = await novoPonto();
    await heartbeat(p, 10 * MIN);
    expect((await alertas(p, 'RELOGIO_DESVIO')).map((x) => x.severidade)).toEqual(['critico']);
    const r = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set(bearer())
      .send({ modo: 'imediato', confirmacaoCaixa: p.numero });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await alertas(p, 'RELOGIO_DESVIO')).toMatchObject([{ resolucao: 'Terminal revogado' }]);
  });

  it('a desativação confirmada fecha o desvio; o heartbeat de um terminal já revogado na empresa não o reabre', async () => {
    const p = await novoPonto();
    await heartbeat(p, 10 * MIN);
    const aceitar = await amb
      .http()
      .post(`/api/terminais/${p.terminal}/revogar`)
      .set(bearer())
      .send({ modo: 'aceitar_pendencias' });
    expect(aceitar.status, JSON.stringify(aceitar.body)).toBe(200);
    const confirmar = { estado_local: 'desativando_confirmado', ultima_sequencia_gerada: 0 };
    expect((await heartbeat(p, 10 * MIN, confirmar)).status_terminal).toBe('revogado');
    expect(await alertas(p, 'RELOGIO_DESVIO')).toMatchObject([
      { severidade: 'critico', resolucao: 'Terminal desativado com confirmação' },
    ]);

    // O passo do controle de um heartbeat como esse falhou (ou o controle ainda não viu a revogação que a empresa já
    // gravou): o próximo heartbeat passa na autenticação, mas a empresa já diz `revogado` e o alerta não reabre.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set status = 'desativando', motivo_revogacao = null where id = $1",
      [p.terminal],
    );
    expect((await heartbeat(p, 10 * MIN, confirmar)).status_terminal).toBe('revogado');
    expect((await alertas(p, 'RELOGIO_DESVIO')).map((x) => x.resolvido_em === null)).toEqual([false]);
    // A corrida com a revogação imediata: a autenticação leu `ativo` no controle e a revogação fez o commit na empresa
    // antes da transação do heartbeat. Sem a confirmação, nada mais fecharia o alerta que ele reabrisse.
    await consultar(amb.bancoControle, "update terminais_pdv set status = 'ativo' where id = $1", [
      p.terminal,
    ]);
    await heartbeat(p, 10 * MIN);
    expect((await alertas(p, 'RELOGIO_DESVIO')).map((x) => x.resolvido_em === null)).toEqual([false]);
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set status = 'revogado', motivo_revogacao = 'desativacao_confirmada' where id = $1",
      [p.terminal],
    );

    // Um aberto que tenha escapado (ex.: de antes dessas defesas) a manutenção fecha.
    await inserirAlertas(p, 'RELOGIO_DESVIO', 'critico', 1, { chave: `relogio_desvio:${p.terminal}` });
    const resumo = await amb.servicos.manutencaoTerminais.executar();
    expect(resumo.alertasRelogioResolvidos).toBe(1);
    expect((await alertas(p, 'RELOGIO_DESVIO')).map((x) => x.resolucao)).toEqual([
      'Terminal desativado com confirmação',
      'Terminal revogado',
    ]);
  });
});
