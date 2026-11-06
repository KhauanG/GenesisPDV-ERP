/**
 * Painel de saúde do monitoramento (Implantação do piloto, I1b): `GET /api/saude/detalhada` só com o token de
 * monitoramento (401 sem token, com token errado, com a sessão do ERP; o token não abre outra rota), o formato da
 * resposta (terminais online/offline/desativado, fila de decisão, tarefas atrasadas do pg-boss, último backup lido do
 * bucket, memória do container e do processo, tempo no ar), nenhum campo pessoal nem valor de venda, e o limite de
 * requisições por IP.
 */
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { jcs, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SaudeDetalhada, type SaudeDetalhadaResposta } from '../../src/saude/saude-detalhada.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;
const HARDWARE = ATIVAR.maquina.id_hardware;
const TOKEN = randomBytes(32).toString('base64url');
const RAZAO_SOCIAL = `Distribuidora Monitor ${randomBytes(2).toString('hex')} Ltda`;
const DESCRICAO_CAIXA = 'Caixa da Maria Aparecida';
const ESTADO_BACKUP = 'backups/estado.json';

let amb: Ambiente;
let s3: S3Falso;
let emp: EmpresaTeste;
let tokenAdmin: string;
let loja1: string;
let loja2: string;
let online: { id: string; token: string };
let revogado: { id: string; token: string };
let semContato: { id: string; token: string };

function cabecalhos(token?: string) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': HARDWARE,
  };
}
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

async function criarCaixa(lojaId: string, numero: number, descricao: string): Promise<string> {
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [lojaId, numero, descricao],
  );
  return c!.id;
}

async function ativar(lojaId: string, caixaId: string) {
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ lojaId, caixaId, validadeHoras: 24, descricao: DESCRICAO_CAIXA.slice(0, 40) });
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

/** Evento com o hash errado: rejeitado no push, fica `erro` (PAYLOAD_INVALIDO) na fila de decisão. */
async function eventoComErro(t: { id: string; token: string }, caixaId: string, numeroCaixa: number) {
  const payload = { registros: [], logins: [] };
  const p = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(t.token))
    .send({
      lote_id: uuidv7(),
      terminal_id: t.id,
      enviado_em: new Date().toISOString(),
      eventos: [
        {
          evento_id: uuidv7(),
          sequencia: 1,
          tipo: 'auditoria.registros',
          versao_schema: 1,
          agregado_tipo: 'auditoria',
          agregado_id: uuidv7(),
          dependencias: [],
          ocorrido_em: new Date().toISOString(),
          ocorrido_em_local: new Date().toISOString(),
          relogio_confiavel: true,
          usuario_id: null,
          contexto: {
            loja_id: loja1,
            caixa_id: caixaId,
            numero_caixa: numeroCaixa,
            versao_app: '1.0.0',
            versao_schema_local: 1,
          },
          payload,
          payload_sha256: createHash('sha256')
            .update(`${jcs(payload)}x`, 'utf8')
            .digest('hex'),
        },
      ],
    });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  expect(p.body.resultados[0].status).toBe('rejeitado');
}

const detalhada = (token: string | null = TOKEN) => {
  const r = amb.http().get('/api/saude/detalhada');
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

beforeAll(async () => {
  s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      MONITOR_TOKEN_SHA256: createHash('sha256').update(TOKEN).digest('hex'),
      GENESIS_VERSAO: 'abc123def456',
      ARMAZENAMENTO_ENDPOINT: s3.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-monitor-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  // Schema do pg-boss sem trabalhadores (FILA_TRABALHADOR=false): o trabalho inserido abaixo fica parado.
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa({
    razaoSocial: RAZAO_SOCIAL,
    emailResponsavel: 'responsavel@monitor.invalid',
  });
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  const c1 = await criarCaixa(loja1, 1, DESCRICAO_CAIXA);
  const c2 = await criarCaixa(loja1, 2, 'Caixa 02');
  const c3 = await criarCaixa(loja2, 1, 'Caixa 01');
  online = await ativar(loja1, c1);
  revogado = await ativar(loja1, c2);
  semContato = await ativar(loja2, c3);
  expect((await amb.http().post('/sync/heartbeat').set(cabecalhos(online.token)).send({})).status).toBe(200);
  await eventoComErro(online, c1, 1);
  // Revogado agora (desativado) e um terminal ativo sem contato há 1 h (offline).
  await consultar(
    amb.bancoControle,
    "update terminais_pdv set status = 'revogado', revogado_em = now() where id = $1",
    [revogado.id],
  );
  await consultar(
    amb.bancoControle,
    "update terminais_pdv set ultimo_contato_em = now() - interval '1 hour' where id = $1",
    [semContato.id],
  );
  await consultar(
    emp.nomeBanco,
    "update terminais set ultimo_contato_em = now() - interval '1 hour' where id = $1",
    [semContato.id],
  );
  await consultar(
    amb.bancoControle,
    "insert into pgboss.job (name, data, start_after) values ('genesis-tarefa', '{}', now() - interval '10 minutes')",
  );
  await amb.servicos.armazenamento.gravar(
    ESTADO_BACKUP,
    Buffer.from(
      JSON.stringify({
        formato: 1,
        status: 'ok',
        dia: '2026-11-04',
        inicio: '2026-11-04T07:30:00Z',
        fim: '2026-11-04T07:31:10Z',
        tamanho_bytes: 123456,
        bancos: 2,
        falhas: 0,
        erro: null,
        ultimo_sucesso: { dia: '2026-11-04', fim: '2026-11-04T07:31:10Z', tamanho_bytes: 123456 },
      }),
    ),
    'application/json',
  );
});

afterAll(async () => {
  delete process.env.MONITOR_LIMITE_POR_MINUTO;
  await amb?.fechar();
  await s3?.fechar();
});

describe('GET /api/saude/detalhada (I1b)', () => {
  it('sem token, com token errado ou com a sessão do ERP: 401', async () => {
    for (const r of [
      await detalhada(null),
      await detalhada('token-errado'),
      await detalhada(`${TOKEN}x`),
      await detalhada(tokenAdmin),
    ]) {
      expect(r.status).toBe(401);
      expect(r.body.codigo).toBe('NAO_AUTENTICADO');
      expect(JSON.stringify(r.body)).not.toContain('terminais');
    }
    expect((await amb.http().get('/api/saude/detalhada').set('Authorization', TOKEN)).status).toBe(401);
  });

  it('o token de monitoramento não abre outra rota, e a rota fica só no prefixo /api', async () => {
    for (const rota of ['/api/empresa', '/api/terminais', '/api/plataforma/empresas']) {
      expect((await amb.http().get(rota).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(401);
    }
    expect((await amb.http().get('/saude/detalhada').set('Authorization', `Bearer ${TOKEN}`)).status).toBe(
      404,
    );
  });

  it('com o token: 200 no formato documentado (terminais, fila, tarefas, backup, memória, processo)', async () => {
    const r = await detalhada();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const b = r.body as SaudeDetalhadaResposta;
    expect(b.status).toBe('ok');
    expect(b.api).toEqual({ versao: 'abc123def456', ambiente: 'teste', no_ar_desde: expect.any(String) });
    expect(b.banco.status).toBe('ok');
    expect(b.banco.latencia_ms).toBeGreaterThanOrEqual(0);
    expect(b.terminais).toEqual([
      {
        empresa: emp.codigo,
        loja: { codigo: 1, nome: 'Loja 1 - Centro' },
        caixa: 1,
        status: 'online',
        ultima_sincronizacao: expect.any(String),
      },
      {
        empresa: emp.codigo,
        loja: { codigo: 1, nome: 'Loja 1 - Centro' },
        caixa: 2,
        status: 'desativado',
        // Ativado e revogado sem nunca ter sincronizado.
        ultima_sincronizacao: null,
      },
      {
        empresa: emp.codigo,
        loja: { codigo: 2, nome: 'Loja 2 - Bairro' },
        caixa: 1,
        status: 'offline',
        ultima_sincronizacao: expect.any(String),
      },
    ]);
    expect(Date.now() - Date.parse(b.terminais[0]!.ultima_sincronizacao!)).toBeLessThan(60_000);
    expect(b.eventos_fila_decisao).toBe(1);
    expect(b.tarefas_atrasadas).toBe(1);
    expect(b.empresas_sem_resposta).toBe(0);
    expect(b.ultimo_backup).toEqual({
      status: 'ok',
      data: '2026-11-04T07:31:10Z',
      tamanho_bytes: 123456,
      ultimo_sucesso_em: '2026-11-04T07:31:10Z',
    });
    expect(b.memoria.usada_bytes).toBeGreaterThan(0);
    expect(b.memoria.limite_bytes === null || b.memoria.limite_bytes > 0).toBe(true);
    // Processo (decisão 166): tempo no ar e memória do V8 em MiB, o teto do heap acima do reservado.
    expect(Object.keys(b.processo).sort()).toEqual([
      'heap_limite_mb',
      'heap_total_mb',
      'heap_usado_mb',
      'no_ar_segundos',
      'rss_mb',
    ]);
    expect(b.processo.no_ar_segundos).toBeGreaterThanOrEqual(0);
    expect(b.processo.no_ar_segundos).toBeLessThanOrEqual(Math.ceil(process.uptime()));
    expect(b.processo.heap_usado_mb).toBeGreaterThan(0);
    expect(b.processo.heap_total_mb).toBeGreaterThanOrEqual(b.processo.heap_usado_mb);
    expect(b.processo.heap_limite_mb).toBeGreaterThan(b.processo.heap_total_mb);
    expect(b.processo.rss_mb).toBeGreaterThan(b.processo.heap_usado_mb);
  });

  it('nenhum campo pessoal, de venda ou segredo na resposta', async () => {
    const r = await detalhada();
    const permitidas = new Set([
      'status',
      'gerado_em',
      'api',
      'versao',
      'ambiente',
      'no_ar_desde',
      'banco',
      'latencia_ms',
      'terminais',
      'empresa',
      'loja',
      'codigo',
      'nome',
      'caixa',
      'ultima_sincronizacao',
      'eventos_fila_decisao',
      'tarefas_atrasadas',
      'empresas_sem_resposta',
      'ultimo_backup',
      'data',
      'tamanho_bytes',
      'ultimo_sucesso_em',
      'memoria',
      'usada_bytes',
      'limite_bytes',
      'processo',
      'no_ar_segundos',
      'heap_usado_mb',
      'heap_total_mb',
      'heap_limite_mb',
      'rss_mb',
    ]);
    const chaves = new Set<string>();
    const percorrer = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(percorrer);
      else if (v && typeof v === 'object')
        for (const [k, filho] of Object.entries(v)) {
          chaves.add(k);
          percorrer(filho);
        }
    };
    percorrer(r.body);
    expect([...chaves].filter((k) => !permitidas.has(k))).toEqual([]);
    const texto = JSON.stringify(r.body);
    const [cnpj] = await consultar<{ cnpj: string }>(
      amb.bancoControle,
      'select cnpj from empresas where id = $1',
      [emp.empresaId],
    );
    for (const proibido of [
      RAZAO_SOCIAL,
      cnpj!.cnpj,
      'responsavel@monitor.invalid',
      DESCRICAO_CAIXA,
      ATIVAR.maquina.nome_maquina,
      HARDWARE,
      online.id,
      online.token,
      emp.nomeBanco,
      TOKEN,
    ]) {
      expect(texto).not.toContain(proibido);
    }
  });

  it('último backup: ausente sem estado no bucket, falhou com o último sucesso, indisponível sem o bucket', async () => {
    const s = amb.servicos;
    const nova = (chave: string, bucket = s.armazenamento) =>
      new SaudeDetalhada(
        { ...s.config, backup: { chaveEstado: chave } },
        s.controle,
        s.resolvedor,
        s.tenancy,
        bucket,
        { cacheBackupMs: 0 },
      );
    expect((await nova('backups/nao-existe.json').gerar()).ultimo_backup).toEqual({
      status: 'ausente',
      data: null,
      tamanho_bytes: null,
      ultimo_sucesso_em: null,
    });
    await s.armazenamento.gravar(
      'backups/estado-falhou.json',
      Buffer.from(
        JSON.stringify({
          status: 'falhou',
          fim: '2026-11-05T07:30:20Z',
          tamanho_bytes: 0,
          erro: 'genesis_emp_1: pg_dump: conexão recusada',
          ultimo_sucesso: { fim: '2026-11-04T07:31:10Z', tamanho_bytes: 123456 },
        }),
      ),
      'application/json',
    );
    const falhou = await nova('backups/estado-falhou.json').gerar();
    expect(falhou.ultimo_backup).toEqual({
      status: 'falhou',
      data: '2026-11-05T07:30:20Z',
      tamanho_bytes: 0,
      ultimo_sucesso_em: '2026-11-04T07:31:10Z',
    });
    // A mensagem de erro do backup (pode citar nomes de banco) não vai para a resposta.
    expect(JSON.stringify(falhou)).not.toContain('genesis_emp_1');
    const { ArmazenamentoObjetos } = await import('../../src/infra/armazenamento.js');
    const foraDoAr = new ArmazenamentoObjetos({ ...s.config.armazenamento, endpoint: 'http://127.0.0.1:9' });
    try {
      expect((await nova(ESTADO_BACKUP, foraDoAr).gerar()).ultimo_backup.status).toBe('indisponivel');
    } finally {
      foraDoAr.destruir();
    }
  });

  it('limite de requisições por IP (MONITOR_LIMITE_POR_MINUTO): tentativas erradas também contam', async () => {
    process.env.MONITOR_LIMITE_POR_MINUTO = '3';
    // As chamadas dos testes anteriores já estão na janela de 1 minuto do mesmo IP.
    const respostas = [];
    for (let i = 0; i < 4; i++) respostas.push((await detalhada('errado')).status);
    expect(respostas).toContain(429);
    const certo = await detalhada();
    expect(certo.status).toBe(429);
    expect(certo.body.codigo).toBe('LIMITE_TAXA');
    expect(certo.headers['retry-after']).toBe('60');
  });
});
