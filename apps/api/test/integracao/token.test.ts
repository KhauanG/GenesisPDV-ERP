/**
 * Rotação do token do terminal (SYNC 3.7): `POST /sync/token/renovar` com o segredo gerado pelo PDV (só o hash sobe),
 * idempotência pelo `requisicao_id` (repetição autenticada pelo anterior ou pelo novo), recusa do anterior com
 * `requisicao_id` novo, janela de 7 dias do anterior, 409 com hardware divergente, a flag `renovar_token` do heartbeat
 * e o alerta `token_anterior_reutilizado` (anterior usado depois que o novo já funcionou).
 */
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  envelopeErroSyncSchema,
  respostaHeartbeatSchema,
  respostaRenovarTokenSchema,
  type Ativar,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALERTA_TOKEN_ANTERIOR } from '../../src/sync/token.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;
const HARDWARE = ATIVAR.maquina.id_hardware;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let tokenAdmin: string;
let numeroCaixa = 0;

function cabecalhos(token?: string, hardware = HARDWARE) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': hardware,
  };
}

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** Segredo novo como o PDV gera (32 bytes de CSPRNG em base64url): devolve o token e o hash que sobe. */
function segredoNovo(terminalId: string) {
  const segredo = randomBytes(32).toString('base64url');
  return { token: `${terminalId}.${segredo}`, hash: sha256(segredo) };
}

/** Caixa novo na loja, código gerado no ERP e ativação pelo `/sync/ativar`. */
async function ativar(): Promise<{ id: string; token: string }> {
  numeroCaixa += 1;
  const [cx] = await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja, numeroCaixa, `Caixa ${String(numeroCaixa).padStart(2, '0')}`],
  );
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ lojaId: loja, caixaId: cx!.id, validadeHoras: 24 });
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
  return { id: r.body.terminal_id as string, token: r.body.token as string };
}

const renovar = (token: string, corpo: Record<string, unknown>, hardware = HARDWARE) =>
  amb.http().post('/sync/token/renovar').set(cabecalhos(token, hardware)).send(corpo);

const estado = (token: string) => amb.http().get('/sync/estado').set(cabecalhos(token));

async function linhaControle(id: string) {
  const [t] = await consultar<{
    token_hash: string;
    token_hash_anterior: string | null;
    token_anterior_valido_ate: Date | null;
    token_emitido_em: Date;
    token_atual_usado_em: Date | null;
    token_renovacao_requisicao_id: string | null;
  }>(
    amb.bancoControle,
    `select token_hash, token_hash_anterior, token_anterior_valido_ate, token_emitido_em, token_atual_usado_em,
            token_renovacao_requisicao_id
       from terminais_pdv where id = $1`,
    [id],
  );
  return t!;
}

const contarAlertas = async (terminalId: string) =>
  (
    await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from alertas where tipo = $1 and registro_id = $2`,
      [ALERTA_TOKEN_ANTERIOR, terminalId],
    )
  )[0]!.n;

const contarAuditorias = async (terminalId: string) =>
  (
    await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from auditoria where acao = 'token_anterior_reutilizado' and registro_id = $1`,
      [terminalId],
    )
  )[0]!.n;

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('POST /sync/token/renovar (SYNC 3.7)', () => {
  it('troca o hash, guarda o atual como anterior por 7 dias e é idempotente pelo requisicao_id', async () => {
    const t = await ativar();
    const antes = await linhaControle(t.id);
    const novo = segredoNovo(t.id);
    const requisicaoId = uuidv7();

    const r = await renovar(t.token, { novo_token_hash: novo.hash, requisicao_id: requisicaoId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaRenovarTokenSchema.parse(r.body);
    expect(r.headers['x-agora-servidor']).toBeDefined();
    const depois = await linhaControle(t.id);
    expect(depois.token_hash).toBe(novo.hash);
    expect(depois.token_hash_anterior).toBe(antes.token_hash);
    expect(depois.token_renovacao_requisicao_id).toBe(requisicaoId);
    expect(depois.token_atual_usado_em).toBeNull();
    expect(new Date(r.body.token_emitido_em).getTime()).toBe(depois.token_emitido_em.getTime());
    const janela = depois.token_anterior_valido_ate!.getTime() - depois.token_emitido_em.getTime();
    expect(janela).toBe(7 * 86_400_000);
    const [aud] = await consultar<{ depois: Record<string, unknown> }>(
      amb.bancoControle,
      `select depois from auditoria_plataforma where acao = 'terminal_token_renovado' and registro_id = $1`,
      [t.id],
    );
    expect(aud!.depois).toMatchObject({ requisicao_id: requisicaoId });
    expect(JSON.stringify(aud)).not.toContain(novo.hash);

    // Resposta perdida: a repetição com o mesmo requisicao_id, pelo anterior, não muda nada; e o anterior ainda não é
    // "reutilizado" enquanto o novo não foi usado.
    const repAnterior = await renovar(t.token, { novo_token_hash: novo.hash, requisicao_id: requisicaoId });
    expect(repAnterior.status, JSON.stringify(repAnterior.body)).toBe(200);
    expect(repAnterior.body.token_emitido_em).toBe(r.body.token_emitido_em);
    expect((await estado(t.token)).status).toBe(200);
    expect(await contarAlertas(t.id)).toBe(0);
    // Pelo novo, também sem efeito (e o novo passa a "usado").
    const repNovo = await renovar(novo.token, { novo_token_hash: novo.hash, requisicao_id: requisicaoId });
    expect(repNovo.status, JSON.stringify(repNovo.body)).toBe(200);
    expect(repNovo.body.token_emitido_em).toBe(r.body.token_emitido_em);
    const final = await linhaControle(t.id);
    expect(final).toMatchObject({ token_hash: novo.hash, token_hash_anterior: antes.token_hash });
    expect(final.token_atual_usado_em).not.toBeNull();
    // Mesmo requisicao_id com outro segredo é erro do cliente.
    const outro = await renovar(novo.token, {
      novo_token_hash: segredoNovo(t.id).hash,
      requisicao_id: requisicaoId,
    });
    expect(outro.status).toBe(400);
    envelopeErroSyncSchema.parse(outro.body);
    expect((await estado(novo.token)).status).toBe(200);
  });

  it('anterior com requisicao_id novo → 401; hash igual a um conhecido ou malformado → 400', async () => {
    const t = await ativar();
    const novo = segredoNovo(t.id);
    expect((await renovar(t.token, { novo_token_hash: novo.hash, requisicao_id: uuidv7() })).status).toBe(
      200,
    );
    // O token antigo copiado não "rouba" a rotação.
    const roubo = await renovar(t.token, {
      novo_token_hash: segredoNovo(t.id).hash,
      requisicao_id: uuidv7(),
    });
    expect(roubo.status).toBe(401);
    expect(roubo.body.erro.codigo).toBe('TOKEN_INVALIDO');
    expect((await linhaControle(t.id)).token_hash).toBe(novo.hash);

    const anteriorHash = (await linhaControle(t.id)).token_hash_anterior!;
    for (const hash of [novo.hash, anteriorHash, 'ABC', 'f'.repeat(63)]) {
      const r = await renovar(novo.token, { novo_token_hash: hash, requisicao_id: uuidv7() });
      expect(r.status, hash).toBe(400);
      expect(r.body.erro.codigo).toBe('REQUISICAO_INVALIDA');
    }
    expect((await renovar(novo.token, { requisicao_id: uuidv7() })).status).toBe(400);

    // Rotação seguinte, a partir do novo: o anterior passa a ser o novo de antes.
    const terceiro = segredoNovo(t.id);
    expect(
      (await renovar(novo.token, { novo_token_hash: terceiro.hash, requisicao_id: uuidv7() })).status,
    ).toBe(200);
    expect(await linhaControle(t.id)).toMatchObject({
      token_hash: terceiro.hash,
      token_hash_anterior: novo.hash,
    });
    // O primeiro token saiu da janela (só existe um anterior).
    expect((await estado(t.token)).status).toBe(401);
    expect((await estado(novo.token)).status).toBe(200);
    expect((await estado(terceiro.token)).status).toBe(200);
  });

  it('hardware divergente → 409 HARDWARE_ALTERADO sem trocar o token', async () => {
    const t = await ativar();
    const antes = await linhaControle(t.id);
    const r = await renovar(
      t.token,
      { novo_token_hash: segredoNovo(t.id).hash, requisicao_id: uuidv7() },
      'f'.repeat(64),
    );
    expect(r.status).toBe(409);
    expect(r.body.erro.codigo).toBe('HARDWARE_ALTERADO');
    expect((await linhaControle(t.id)).token_hash).toBe(antes.token_hash);
  });

  it('anterior fora da janela de 7 dias → 401', async () => {
    const t = await ativar();
    const novo = segredoNovo(t.id);
    await renovar(t.token, { novo_token_hash: novo.hash, requisicao_id: uuidv7() });
    await consultar(
      amb.bancoControle,
      `update terminais_pdv set token_anterior_valido_ate = now() - interval '1 second' where id = $1`,
      [t.id],
    );
    expect((await estado(t.token)).status).toBe(401);
    expect((await estado(novo.token)).status).toBe(200);
  });

  it('heartbeat pede a renovação depois de 30 dias e para de pedir depois dela', async () => {
    const t = await ativar();
    const hb = (tk: string) => amb.http().post('/sync/heartbeat').set(cabecalhos(tk)).send({});
    const recente = await hb(t.token);
    expect(recente.status).toBe(200);
    expect(respostaHeartbeatSchema.parse(recente.body).renovar_token).toBe(false);
    await consultar(
      amb.bancoControle,
      `update terminais_pdv set token_emitido_em = now() - interval '31 days' where id = $1`,
      [t.id],
    );
    expect((await hb(t.token)).body.renovar_token).toBe(true);
    const novo = segredoNovo(t.id);
    await renovar(t.token, { novo_token_hash: novo.hash, requisicao_id: uuidv7() });
    expect((await hb(novo.token)).body.renovar_token).toBe(false);
  });
});

/** O atual funcionou há mais que a margem da corrida do próprio PDV (`MARGEM_TOKEN_ANTERIOR_MS`). */
const envelhecerUsoDoAtual = (id: string) =>
  consultar(
    amb.bancoControle,
    `update terminais_pdv set token_atual_usado_em = now() - interval '1 minute' where id = $1`,
    [id],
  );

describe('token anterior reutilizado (SYNC 3.7)', () => {
  it('anterior usado depois que o novo funcionou: chamada aceita, um alerta e uma auditoria', async () => {
    const t = await ativar();
    const novo = segredoNovo(t.id);
    await renovar(t.token, { novo_token_hash: novo.hash, requisicao_id: uuidv7() });
    expect((await estado(novo.token)).status).toBe(200);
    await envelhecerUsoDoAtual(t.id);

    expect((await estado(t.token)).status).toBe(200);
    expect((await estado(t.token)).status).toBe(200);
    expect(await contarAlertas(t.id)).toBe(1);
    expect(await contarAuditorias(t.id)).toBe(1);
    const [alerta] = await consultar<{ severidade: string; loja_id: string; titulo: string }>(
      emp.nomeBanco,
      `select severidade, loja_id, titulo from alertas where tipo = $1 and registro_id = $2`,
      [ALERTA_TOKEN_ANTERIOR, t.id],
    );
    expect(alerta).toMatchObject({ severidade: 'critico', loja_id: loja });
    // O alerta não leva nenhum dos tokens.
    expect(JSON.stringify(alerta)).not.toContain(t.token.split('.')[1]);

    // Resolvido o alerta, um novo uso gera outro.
    await consultar(emp.nomeBanco, `update alertas set resolvido_em = now() where tipo = $1`, [
      ALERTA_TOKEN_ANTERIOR,
    ]);
    expect((await estado(t.token)).status).toBe(200);
    expect(await contarAlertas(t.id)).toBe(2);
    expect(await contarAuditorias(t.id)).toBe(2);
  });

  it('anterior logo depois do primeiro uso do novo (corrida do próprio PDV) não gera alerta', async () => {
    const t = await ativar();
    const novo = segredoNovo(t.id);
    await renovar(t.token, { novo_token_hash: novo.hash, requisicao_id: uuidv7() });
    expect((await estado(novo.token)).status).toBe(200);
    expect((await estado(t.token)).status).toBe(200);
    expect(await contarAlertas(t.id)).toBe(0);
    expect(await contarAuditorias(t.id)).toBe(0);
  });

  it('clone com o anterior em outra máquina: push e renovação dão 409, mas o alerta e a auditoria saem', async () => {
    const t = await ativar();
    const novo = segredoNovo(t.id);
    await renovar(t.token, { novo_token_hash: novo.hash, requisicao_id: uuidv7() });
    expect((await estado(novo.token)).status).toBe(200);
    await envelhecerUsoDoAtual(t.id);

    const outraMaquina = 'e'.repeat(64);
    const r = await renovar(
      t.token,
      { novo_token_hash: segredoNovo(t.id).hash, requisicao_id: uuidv7() },
      outraMaquina,
    );
    expect(r.status).toBe(409);
    expect(r.body.erro.codigo).toBe('HARDWARE_ALTERADO');
    expect(await contarAlertas(t.id)).toBe(1);
    expect(await contarAuditorias(t.id)).toBe(1);
    const [alerta] = await consultar<{ dados: { id_hardware_confere: boolean } }>(
      emp.nomeBanco,
      `select dados from alertas where tipo = $1 and registro_id = $2`,
      [ALERTA_TOKEN_ANTERIOR, t.id],
    );
    expect(alerta!.dados.id_hardware_confere).toBe(false);

    // Push do clone: também 409, sem segundo alerta enquanto o primeiro está aberto.
    const push = await amb
      .http()
      .post('/sync/push')
      .set(cabecalhos(t.token, outraMaquina))
      .send({ lote_id: uuidv7(), terminal_id: t.id, enviado_em: new Date().toISOString(), eventos: [] });
    expect(push.status).toBe(409);
    expect(await contarAlertas(t.id)).toBe(1);
    expect((await linhaControle(t.id)).token_hash).toBe(novo.hash);
  });
});
