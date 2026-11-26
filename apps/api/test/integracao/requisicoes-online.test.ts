/**
 * Idempotência das chamadas online do caixa que alteram estado (SYNC 20.4; F3-B6, README da API › decisão 225), por uma
 * rota de teste montada só aqui (`controllersExtras`) com o mesmo caminho das rotas de verdade (`atenderOnline`): o
 * token do terminal, o hardware, o corpo adiado e a `IdempotenciaOnline`. O efeito grava uma linha numa tabela de teste
 * (e pode esperar no banco, para as chamadas se cruzarem). Cobre a mesma requisição em sequência e ao mesmo tempo (um
 * efeito, a mesma resposta), o outro terminal (isolado), a expiração (requisição nova), o mesmo id com outro corpo ou
 * outra rota (422), o efeito que falha (nada gravado, a repetição avalia de novo, inclusive a que esperava a original),
 * a espera vencida (409 com `Retry-After`), a espera atrás do `FOR UPDATE` do terminal (não é 409), a ordem das travas
 * com `travaVersao` (a 7300001 antes da linha, como o push), a validação e o hardware divergente antes de tudo, e a
 * limpeza da tarefa por minuto (retenção de 24 h, em lotes, só nas empresas com terminal em contato).
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { CABECALHO_RESPOSTA_REPETIDA, type Ativar } from '@genesis/shared';
import type { Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Publico } from '../../src/autorizacao/decorators.js';
import { CorpoJson, type OpcoesCorpoJson } from '../../src/comum/corpo-json.js';
import type { RequisicaoGenesis } from '../../src/comum/requisicao.js';
import { SERVICOS } from '../../src/comum/tokens-nest.js';
import type { Servicos } from '../../src/servicos.js';
import { atenderOnline } from '../../src/sync/atendimento.js';
import { validarSync } from '../../src/sync/contratos.js';
import { ErroSync } from '../../src/sync/erros.js';
import { ManutencaoOnline } from '../../src/sync/online/manutencao-online.js';
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

const CORPO: OpcoesCorpoJson = { faixa: 'padrao', adiado: true };
const corpoTesteSchema = z.object({
  valor: z.string().min(1),
  espera_ms: z.number().int().min(0).optional(),
});

/** Quantas próximas execuções do efeito falham (depois de gravar e esperar): o teste liga antes da chamada. */
let falhasPendentes = 0;

/** A rota de teste: o efeito numera a linha da tabela de teste e devolve o que gravou. */
@Publico()
@Controller('sync/teste-idempotencia')
class RotaTesteIdempotencia {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Post('efeitos/:chave')
  @CorpoJson(CORPO)
  efeito(
    @Param('chave') chave: string,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.atender('POST /sync/teste-idempotencia/efeitos/:chave', chave, req, res);
  }

  @Post('outro/:chave')
  @CorpoJson(CORPO)
  outro(
    @Param('chave') chave: string,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.atender('POST /sync/teste-idempotencia/outro/:chave', chave, req, res);
  }

  /** O efeito que gravaria tabela que desce: `travaVersao`, a 7300001 antes da linha de `requisicoes_terminal`. */
  @Post('travada/:chave')
  @CorpoJson(CORPO)
  travada(
    @Param('chave') chave: string,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.atender('POST /sync/teste-idempotencia/travada/:chave', chave, req, res, true);
  }

  private atender(
    operacao: string,
    chave: string,
    req: RequisicaoGenesis,
    res: Response,
    travaVersao = false,
  ) {
    return atenderOnline(
      this.s,
      req,
      res,
      {
        operacao,
        parametros: { chave },
        corpo: CORPO,
        status: 201,
        validar: (c) => validarSync(corpoTesteSchema, c),
        travaVersao,
      },
      async ({ terminal, corpo, cliente }) => {
        const { rows } = await cliente.query<{ id: string }>(
          'insert into teste_efeitos (terminal_id, chave, valor) values ($1, $2, $3) returning id::text',
          [terminal.terminalId, chave, corpo.valor],
        );
        if (corpo.espera_ms) await cliente.query('select pg_sleep($1)', [corpo.espera_ms / 1000]);
        if (falhasPendentes > 0) {
          falhasPendentes--;
          throw new ErroSync('NAO_ENCONTRADO', 'Falha de teste do efeito.', { teste: true });
        }
        // Se esta transação já tem a 7300001 (a `travaVersao` da rota, pega no começo dela).
        const { rows: trava } = await cliente.query<{ tem: boolean }>(
          `select exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
             and classid = 0 and objid = 7300001 and granted) as tem`,
        );
        return {
          efeito_id: rows[0]!.id,
          chave,
          valor: corpo.valor,
          gravado_em: new Date(),
          trava_versao: trava[0]!.tem,
        };
      },
    );
  }
}

let amb: Ambiente;
let emp: EmpresaTeste;
let tokenAdmin: string;
let loja: string;
let numeroCaixa = 0;

interface Ponto {
  terminal: string;
  token: string;
}
let a: Ponto;
let b: Ponto;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function cabecalhos(
  tk: string | undefined,
  requisicaoId: string = uuidv7(),
  hardware = ATIVAR.maquina.id_hardware,
) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '0.14.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': requisicaoId,
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': hardware,
  };
}

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
    .set({ Authorization: `Bearer ${tokenAdmin}` })
    .send({ lojaId: loja, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos(undefined))
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

const chamar = (
  p: Ponto,
  requisicaoId: string,
  chave: string,
  corpo: Record<string, unknown>,
  opcoes: { rota?: 'efeitos' | 'outro' | 'travada'; hardware?: string } = {},
) =>
  amb
    .http()
    .post(`/sync/teste-idempotencia/${opcoes.rota ?? 'efeitos'}/${chave}`)
    .set(cabecalhos(p.token, requisicaoId, opcoes.hardware))
    .send(corpo);

const efeitos = async (chave: string) =>
  (
    await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from teste_efeitos where chave = $1',
      [chave],
    )
  )[0]!.n;

const requisicoes = (requisicaoId: string) =>
  consultar<{
    terminal_id: string;
    endpoint: string;
    corpo_sha256: string;
    status_http: number | null;
    concluida: boolean;
    criada_em: Date;
  }>(
    emp.nomeBanco,
    `select terminal_id, endpoint, corpo_sha256, status_http, concluida_em is not null as concluida, criada_em
       from requisicoes_terminal where requisicao_id = $1 order by terminal_id`,
    [requisicaoId],
  );

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Espera alguma sessão do banco da empresa (fora `excluir`) chegar ao estado de `condicao` (SQL sobre
 * `pg_stat_activity`), com teto: a ordem das chamadas que se cruzam fica pelo banco, não pelo relógio.
 */
async function esperarSessao(condicao: string, descricao: string, excluir: number[] = []): Promise<void> {
  for (let i = 0; ; i++) {
    const r = await consultar(
      emp.nomeBanco,
      `select 1 from pg_stat_activity
        where datname = $1 and pid <> pg_backend_pid() and not (pid = any($2::int[])) and ${condicao}`,
      [emp.nomeBanco, excluir],
    );
    if (r.length) return;
    if (i > 500) throw new Error(`nenhuma sessão chegou a ${descricao}`);
    await esperar(20);
  }
}

/** O efeito da primeira chamada já está dormindo: a linha dela em `requisicoes_terminal` já foi inserida. */
const esperarEfeitoDormindo = () =>
  esperarSessao("state = 'active' and query like 'select pg_sleep%'", 'dormir no efeito');

beforeAll(async () => {
  amb = await criarAmbiente({ controllersExtras: [RotaTesteIdempotencia] });
  emp = await amb.criarEmpresa();
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  // A tabela do efeito de teste, com os privilégios da role de runtime (a dona do banco cria; a API grava como `_app`).
  await consultar(
    emp.nomeBanco,
    `create table teste_efeitos (id bigserial primary key, terminal_id uuid not null, chave text not null,
       valor text not null)`,
  );
  await consultar(emp.nomeBanco, `grant select, insert on teste_efeitos to "${emp.nomeBanco}_app"`);
  await consultar(
    emp.nomeBanco,
    `grant usage, select on sequence teste_efeitos_id_seq to "${emp.nomeBanco}_app"`,
  );
  a = await novoPonto();
  b = await novoPonto();
});

afterAll(async () => {
  await amb?.fechar();
});

describe('idempotência das chamadas online (SYNC 20.4)', () => {
  it('em sequência: um efeito, a mesma resposta e o status gravado, a repetição marcada', async () => {
    const id = uuidv7();
    const r1 = await chamar(a, id, 'seq', { valor: 'R$ 3,00' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBeUndefined();
    expect(r1.headers['x-agora-servidor']).toBeTruthy();
    expect(r1.body).toMatchObject({ chave: 'seq', valor: 'R$ 3,00' });
    expect(typeof r1.body.gravado_em).toBe('string');

    const r2 = await chamar(a, id, 'seq', { valor: 'R$ 3,00' });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBe('1');
    expect(r2.headers['x-agora-servidor']).toBeTruthy();
    // O mesmo JSON, byte a byte (as duas saem do `jsonb` gravado).
    expect(r2.text).toBe(r1.text);
    expect(await efeitos('seq')).toBe(1);

    const [linha] = await requisicoes(id);
    expect(linha).toMatchObject({
      terminal_id: a.terminal,
      endpoint: 'POST /sync/teste-idempotencia/efeitos/:chave',
      status_http: 201,
      concluida: true,
    });
    expect(linha!.corpo_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ao mesmo tempo: a segunda espera a linha da primeira e devolve a mesma resposta, sem segundo efeito', async () => {
    const id = uuidv7();
    const [r1, r2] = await Promise.all([
      chamar(a, id, 'paralelo', { valor: 'x', espera_ms: 600 }),
      esperar(100).then(() => chamar(a, id, 'paralelo', { valor: 'x', espera_ms: 600 })),
    ]);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.text).toBe(r1.text);
    expect([r1, r2].filter((r) => r.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()] === '1')).toHaveLength(
      1,
    );
    expect(await efeitos('paralelo')).toBe(1);

    // Disparadas juntas (sem a folga): continua um efeito só.
    const id2 = uuidv7();
    const juntas = await Promise.all(
      [0, 1, 2, 3].map(() => chamar(a, id2, 'paralelo-4', { valor: 'y', espera_ms: 200 })),
    );
    for (const r of juntas) expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(new Set(juntas.map((r) => r.text)).size).toBe(1);
    expect(await efeitos('paralelo-4')).toBe(1);
  });

  it('o mesmo id de outro terminal é outra requisição: o próprio efeito', async () => {
    const id = uuidv7();
    const ra = await chamar(a, id, 'isolado', { valor: 'z' });
    const rb = await chamar(b, id, 'isolado', { valor: 'z' });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(rb.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBeUndefined();
    expect(rb.body.efeito_id).not.toBe(ra.body.efeito_id);
    expect(await efeitos('isolado')).toBe(2);
    expect((await requisicoes(id)).map((l) => l.terminal_id).sort()).toEqual([a.terminal, b.terminal].sort());
  });

  it('depois da retenção de 24 h o mesmo id é uma requisição nova', async () => {
    const id = uuidv7();
    const r1 = await chamar(a, id, 'expira', { valor: 'w' });
    expect(r1.status).toBe(201);
    await consultar(
      emp.nomeBanco,
      "update requisicoes_terminal set criada_em = now() - interval '24 hours 1 minute' where requisicao_id = $1",
      [id],
    );
    const r2 = await chamar(a, id, 'expira', { valor: 'w' });
    expect(r2.status).toBe(201);
    expect(r2.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBeUndefined();
    expect(r2.body.efeito_id).not.toBe(r1.body.efeito_id);
    expect(await efeitos('expira')).toBe(2);
    const [linha] = await requisicoes(id);
    expect(Date.now() - linha!.criada_em.getTime()).toBeLessThan(60_000);

    // Ainda dentro das 24 h, a repetição é a mesma resposta.
    await consultar(
      emp.nomeBanco,
      "update requisicoes_terminal set criada_em = now() - interval '23 hours 59 minutes' where requisicao_id = $1",
      [id],
    );
    const r3 = await chamar(a, id, 'expira', { valor: 'w' });
    expect(r3.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBe('1');
    expect(r3.body).toEqual(r2.body);
  });

  it('o mesmo id com outro corpo, outro parâmetro ou outra rota: 422 REQUISICAO_DIVERGENTE, sem efeito', async () => {
    const id = uuidv7();
    expect((await chamar(a, id, 'divergente', { valor: 'original' })).status).toBe(201);

    const corpo = await chamar(a, id, 'divergente', { valor: 'outro' });
    expect(corpo.status).toBe(422);
    expect(corpo.body.erro).toMatchObject({
      codigo: 'REQUISICAO_DIVERGENTE',
      detalhes: { motivo: 'pedido' },
      requisicao_id: id,
    });
    expect(corpo.body.erro.mensagem).not.toContain('original');

    const parametro = await chamar(a, id, 'divergente-2', { valor: 'original' });
    expect(parametro.status).toBe(422);
    expect(parametro.body.erro.detalhes).toEqual({ motivo: 'pedido' });

    const rota = await chamar(a, id, 'divergente', { valor: 'original' }, { rota: 'outro' });
    expect(rota.status).toBe(422);
    expect(rota.body.erro.detalhes).toEqual({ motivo: 'operacao' });

    expect(await efeitos('divergente')).toBe(1);
    expect(await efeitos('divergente-2')).toBe(0);
    // A ordem das chaves do corpo não muda o resumo: a mesma requisição.
    const mesma = await amb
      .http()
      .post('/sync/teste-idempotencia/efeitos/divergente')
      .set({ ...cabecalhos(a.token, id), 'Content-Type': 'application/json' })
      .send('{ "valor" : "original" }');
    expect(mesma.status).toBe(201);
    expect(mesma.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBe('1');
  });

  it('o efeito que falha não grava nada; a repetição avalia de novo', async () => {
    const id = uuidv7();
    falhasPendentes = 1;
    const r1 = await chamar(a, id, 'falha', { valor: 'f' });
    expect(r1.status).toBe(404);
    expect(r1.body.erro.detalhes).toEqual({ teste: true });
    expect(await efeitos('falha')).toBe(0);
    expect(await requisicoes(id)).toEqual([]);

    const r2 = await chamar(a, id, 'falha', { valor: 'f' });
    expect(r2.status).toBe(201);
    expect(r2.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBeUndefined();
    expect(await efeitos('falha')).toBe(1);
  });

  it('a original que falha enquanto a repetição espera: a repetição faz o efeito', async () => {
    const id = uuidv7();
    falhasPendentes = 1;
    // A segunda sai só com a primeira já dentro do efeito (a linha dela inserida): quem falha é a primeira.
    const primeira = chamar(a, id, 'falha-espera', { valor: 'g', espera_ms: 500 }).then((r) => r);
    await esperarEfeitoDormindo();
    const [r1, r2] = await Promise.all([
      primeira,
      chamar(a, id, 'falha-espera', { valor: 'g', espera_ms: 500 }),
    ]);
    expect(r1.status).toBe(404);
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBeUndefined();
    expect(await efeitos('falha-espera')).toBe(1);
    expect((await requisicoes(id))[0]).toMatchObject({ status_http: 201, concluida: true });
  });

  it('a espera vencida pela original: 409 REQUISICAO_EM_ANDAMENTO com Retry-After, e depois a resposta gravada', async () => {
    const id = uuidv7();
    process.env.SYNC_ESPERA_REQUISICAO_ONLINE_MS = '200';
    try {
      const pendente = chamar(a, id, 'andamento', { valor: 'h', espera_ms: 1500 }).then((r) => r);
      await esperarEfeitoDormindo();
      const repetida = await chamar(a, id, 'andamento', { valor: 'h', espera_ms: 1500 });
      expect(repetida.status, JSON.stringify(repetida.body)).toBe(409);
      expect(repetida.body.erro.codigo).toBe('REQUISICAO_EM_ANDAMENTO');
      expect(repetida.headers['retry-after']).toBe('1');
      const r1 = await pendente;
      expect(r1.status).toBe(201);
      const depois = await chamar(a, id, 'andamento', { valor: 'h', espera_ms: 1500 });
      expect(depois.status).toBe(201);
      expect(depois.body).toEqual(r1.body);
    } finally {
      delete process.env.SYNC_ESPERA_REQUISICAO_ONLINE_MS;
    }
    expect(await efeitos('andamento')).toBe(1);
  });

  it('a espera atrás do FOR UPDATE do terminal (push, heartbeat, revogação) não é 409: a chamada espera e faz o efeito', async () => {
    const id = uuidv7();
    process.env.SYNC_ESPERA_REQUISICAO_ONLINE_MS = '200';
    const outra = await conectar(emp.nomeBanco);
    try {
      const { rows } = await outra.query<{ pid: number }>('select pg_backend_pid() as pid');
      await outra.query('begin');
      await outra.query('select 1 from terminais where id = $1 for update', [a.terminal]);
      const pendente = chamar(a, id, 'terminal-travado', { valor: 't' }).then((r) => r);
      await esperarSessao("wait_event_type = 'Lock'", 'esperar a linha do terminal', [rows[0]!.pid]);
      // Bem mais que o `lock_timeout` da espera pela requisição original: esta espera não conta para ele.
      await esperar(500);
      await outra.query('commit');
      const r = await pendente;
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBeUndefined();
    } finally {
      await outra.query('rollback').catch(() => undefined);
      await outra.end();
      delete process.env.SYNC_ESPERA_REQUISICAO_ONLINE_MS;
    }
    expect(await efeitos('terminal-travado')).toBe(1);
  });

  it('com travaVersao a 7300001 vem antes da linha: o push na ordem dele (7300001 e FOR UPDATE do terminal) não espera a chamada', async () => {
    const id = uuidv7();
    const push = await conectar(emp.nomeBanco);
    try {
      const { rows } = await push.query<{ pid: number }>('select pg_backend_pid() as pid');
      await push.query('begin');
      await push.query('select fn_trava_versao()');
      const pendente = chamar(a, id, 'travada', { valor: 'v' }, { rota: 'travada' }).then((r) => r);
      await esperarSessao("wait_event = 'advisory'", 'esperar a 7300001', [rows[0]!.pid]);
      // Com a linha de `requisicoes_terminal` inserida antes da 7300001, a FK seguraria o KEY SHARE do terminal e este
      // FOR UPDATE esperaria a chamada, que espera o push: deadlock. Aqui ele passa na hora.
      await push.query(`set local lock_timeout = '2s'`);
      await push.query('select 1 from terminais where id = $1 for update', [a.terminal]);
      expect(await requisicoes(id)).toEqual([]);
      await push.query('commit');
      const r = await pendente;
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.trava_versao).toBe(true);
    } finally {
      await push.query('rollback').catch(() => undefined);
      await push.end();
    }
    expect(await efeitos('travada')).toBe(1);

    // Sem `travaVersao`, o efeito não tem a 7300001.
    const sem = await chamar(a, uuidv7(), 'sem-trava', { valor: 's' });
    expect(sem.status).toBe(201);
    expect(sem.body.trava_versao).toBe(false);
  });

  it('com travaVersao a repetição espera a original na 7300001 (sem o 409) e devolve a resposta gravada', async () => {
    const id = uuidv7();
    process.env.SYNC_ESPERA_REQUISICAO_ONLINE_MS = '200';
    try {
      const pendente = chamar(
        a,
        id,
        'travada-repete',
        { valor: 'r', espera_ms: 800 },
        { rota: 'travada' },
      ).then((r) => r);
      await esperarEfeitoDormindo();
      const repetida = await chamar(
        a,
        id,
        'travada-repete',
        { valor: 'r', espera_ms: 800 },
        { rota: 'travada' },
      );
      const r1 = await pendente;
      expect(r1.status, JSON.stringify(r1.body)).toBe(201);
      expect(repetida.status, JSON.stringify(repetida.body)).toBe(201);
      expect(repetida.headers[CABECALHO_RESPOSTA_REPETIDA.toLowerCase()]).toBe('1');
      expect(repetida.text).toBe(r1.text);
    } finally {
      delete process.env.SYNC_ESPERA_REQUISICAO_ONLINE_MS;
    }
    expect(await efeitos('travada-repete')).toBe(1);
  });

  it('corpo inválido (400) e hardware divergente (409) saem antes de tocar em requisicoes_terminal', async () => {
    const id = uuidv7();
    const invalido = await chamar(a, id, 'antes', { valor: '' });
    expect(invalido.status).toBe(400);
    expect(invalido.body.erro.codigo).toBe('REQUISICAO_INVALIDA');
    const hardware = await chamar(a, id, 'antes', { valor: 'ok' }, { hardware: 'OUTRAMAQUINA0000000001' });
    expect(hardware.status).toBe(409);
    expect(hardware.body.erro.codigo).toBe('HARDWARE_ALTERADO');
    const semToken = await amb
      .http()
      .post('/sync/teste-idempotencia/efeitos/antes')
      .set(cabecalhos(undefined, id))
      .send({ valor: 'ok' });
    expect(semToken.status).toBe(401);
    expect(await requisicoes(id)).toEqual([]);
    expect(await efeitos('antes')).toBe(0);
  });
});

describe('tarefa por minuto: retenção de requisicoes_terminal', () => {
  it('apaga só as linhas com mais de 24 h, em lotes, nas empresas com terminal em contato', async () => {
    const antigas = Array.from({ length: 5 }, () => uuidv7());
    const recente = uuidv7();
    for (const id of antigas) {
      await consultar(
        emp.nomeBanco,
        `insert into requisicoes_terminal (terminal_id, requisicao_id, endpoint, criada_em)
         values ($1, $2, 'POST /teste', now() - interval '25 hours')`,
        [a.terminal, id],
      );
    }
    await consultar(
      emp.nomeBanco,
      `insert into requisicoes_terminal (terminal_id, requisicao_id, endpoint, criada_em, status_http, resposta, concluida_em)
       values ($1, $2, 'POST /teste', now() - interval '23 hours', 200, '{}', now() - interval '23 hours')`,
      [a.terminal, recente],
    );
    const s = amb.servicos;
    // Lote de 2 para a volta do laço: 5 antigas (mais as que outro teste deixou vencidas) em 3 ou mais transações.
    const r = await new ManutencaoOnline(s.controle, s.resolvedor, s.tenancy, 2).executar();
    expect(r).toMatchObject({ executada: true, falhas: [] });
    expect(r.empresas).toBeGreaterThanOrEqual(1);
    expect(r.requisicoesApagadas).toBeGreaterThanOrEqual(5);
    const sobram = await consultar<{ requisicao_id: string }>(
      emp.nomeBanco,
      "select requisicao_id from requisicoes_terminal where criada_em < now() - interval '24 hours'",
    );
    expect(sobram).toEqual([]);
    expect(await requisicoes(recente)).toHaveLength(1);

    // Sem terminal em contato na janela, a empresa nem é aberta.
    await consultar(
      emp.nomeBanco,
      `insert into requisicoes_terminal (terminal_id, requisicao_id, endpoint, criada_em)
       values ($1, $2, 'POST /teste', now() - interval '25 hours')`,
      [a.terminal, uuidv7()],
    );
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set ultimo_contato_em = now() - interval '27 hours' where empresa_id = $1",
      [emp.empresaId],
    );
    const semContato = await s.manutencaoOnline.executar();
    expect(semContato).toMatchObject({ executada: true, empresas: 0, requisicoesApagadas: 0 });
  });
});
