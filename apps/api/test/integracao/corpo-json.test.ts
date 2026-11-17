/**
 * Corpo JSON das requisições (README da API › decisão 199): toda rota lê com o limite padrão (100 KiB), sem
 * compressão e só JSON; o limite grande vale nas rotas autenticadas marcadas, lido depois da sessão conferida; o
 * `POST /sync/push` lê o lote (com ou sem gzip) só depois de autenticar o terminal. O `JSON.parse` é observado para
 * confirmar que o corpo recusado não foi interpretado. Dados inventados; o limite do lote é reduzido aqui (4 MiB)
 * para o teste do lote acima dele ficar pequeno.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as requisicaoHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { jcs, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;
const HARDWARE = ATIVAR.maquina.id_hardware;
const KIB = 1024;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let caixa: string;
let tokenAdmin: string;
let terminalId: string;
let tokenTerminal: string;

/** Os `JSON.parse` de textos maiores que `tamanho` desde o último `limparParse`. */
let parse: MockInstance<typeof JSON.parse>;
const parsesMaioresQue = (tamanho: number) =>
  parse.mock.calls.filter(([texto]) => typeof texto === 'string' && texto.length > tamanho).length;

function cabecalhosSync(token?: string): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '0.12.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': HARDWARE,
  };
}

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

/** Um `auditoria.registros` com `n` registros de descrição longa (o lote fica com centenas de KiB). */
function eventoAuditoria(seq: number, n: number) {
  const payload = {
    registros: Array.from({ length: n }, (_, i) => ({
      id: uuidv7(),
      ocorrido_em: new Date().toISOString(),
      acao: 'gaveta_aberta',
      entidade: 'pdv',
      localizacao: 'PDV › Gaveta',
      descricao: `Registro de teste ${seq}.${i} `.padEnd(1900, 'x'),
    })),
    logins: [],
  };
  return {
    evento_id: uuidv7(),
    sequencia: seq,
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
      loja_id: loja,
      caixa_id: caixa,
      numero_caixa: 1,
      versao_app: '0.12.0',
      versao_schema_local: 1,
    },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
  };
}

const lote = (eventos: unknown[]) =>
  Buffer.from(
    JSON.stringify({
      lote_id: uuidv7(),
      terminal_id: terminalId,
      enviado_em: new Date().toISOString(),
      eventos,
    }),
  );

interface Resposta {
  status: number;
  corpo: Record<string, unknown>;
}

/**
 * POST com o corpo em bytes, como está (o supertest serializaria o `Buffer` como JSON). `emPartes`: como o PDV manda
 * (`JsonContent` do .NET), sem `Content-Length`. A resposta pode chegar antes do corpo terminar de ser enviado.
 * `pausa`: depois da primeira parte, espera `antes()` terminar para mandar o resto (o envio lento de um lote).
 */
function postar(
  caminho: string,
  cabecalhos: Record<string, string>,
  corpo: Buffer,
  emPartes = true,
  pausa?: () => Promise<void>,
): Promise<Resposta> {
  const { port } = amb.app!.getHttpServer().address() as AddressInfo;
  return new Promise((resolver, rejeitar) => {
    let respondeu = false;
    const req = requisicaoHttp(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: caminho,
        agent: false,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(emPartes ? {} : { 'Content-Length': String(corpo.length) }),
          ...cabecalhos,
        },
      },
      (res) => {
        respondeu = true;
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => {
          resolver({
            status: res.statusCode ?? 0,
            corpo: JSON.parse(Buffer.concat(partes).toString('utf8')) as Record<string, unknown>,
          });
          req.destroy();
        });
      },
    );
    req.on('error', (e) => {
      if (!respondeu) rejeitar(e);
    });
    const PARTE = 64 * KIB;
    const escrever = (i: number) => {
      if (respondeu || req.destroyed) return;
      if (i >= corpo.length) return void req.end();
      const seguir = () => setImmediate(() => escrever(i + PARTE));
      req.write(corpo.subarray(i, i + PARTE), () =>
        i === 0 && pausa ? void pausa().then(seguir, rejeitar) : seguir(),
      );
    };
    escrever(0);
  });
}

beforeAll(async () => {
  amb = await criarAmbiente({ env: { CORPO_JSON_LIMITE_LOTE_KB: '4096' } });
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [loja, 'Caixa 01'],
  )) as [{ id: string }];
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const codigo = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ lojaId: loja, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(codigo.status).toBe(201);
  const ativacao = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhosSync())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: codigo.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(ativacao.status, JSON.stringify(ativacao.body)).toBe(201);
  terminalId = ativacao.body.terminal_id;
  tokenTerminal = ativacao.body.token;
  parse = vi.spyOn(JSON, 'parse');
});

afterEach(() => parse?.mockClear());

afterAll(async () => {
  parse?.mockRestore();
  await amb?.fechar();
});

/** ~1 MiB de JSON que o gzip reduz a poucos KiB. */
const repetitivo = Buffer.from(`[${'{},'.repeat(350_000)}{}]`);

describe('rotas sem login: limite padrão, sem compressão, só JSON', () => {
  it('corpo gzip que descomprime ~1 MiB: 415 sem descomprimir nem interpretar (login, painel, senha, ativação)', async () => {
    const comprimido = gzipSync(repetitivo);
    expect(comprimido.length).toBeLessThan(16 * KIB);
    for (const rota of [
      '/api/auth/login',
      '/api/plataforma/auth/login',
      '/api/auth/esqueci-senha',
      '/sync/ativar',
    ]) {
      const r = await postar(rota, { 'Content-Encoding': 'gzip' }, comprimido, false);
      const corpo = r.corpo as { codigo?: string; erro?: { codigo: string } };
      expect(r.status, rota).toBe(rota.startsWith('/sync') ? 400 : 415);
      expect(corpo.codigo ?? corpo.erro?.codigo).toBe(
        rota.startsWith('/sync') ? 'REQUISICAO_INVALIDA' : 'TIPO_NAO_SUPORTADO',
      );
    }
    expect(parsesMaioresQue(100 * KIB)).toBe(0);
  });

  it('JSON acima de 100 KiB: 413 sem interpretar, pelo Content-Length e em partes', async () => {
    const r = await postar('/api/auth/login', {}, repetitivo, false);
    expect(r.status).toBe(413);
    expect(r.corpo.codigo).toBe('CORPO_GRANDE');
    const emPartes = await postar('/api/auth/login', {}, repetitivo);
    expect(emPartes.status).toBe(413);
    // Sem login, a recusa fecha a conexão (o resto do corpo não é recebido).
    const supertest = await amb
      .http()
      .post('/api/auth/login')
      .set({ 'Content-Type': 'application/json', Connection: 'keep-alive' })
      .send(repetitivo.toString('utf8'));
    expect(supertest.status).toBe(413);
    expect(supertest.headers.connection).toBe('close');
    expect(parsesMaioresQue(100 * KIB)).toBe(0);
    // O login de sempre continua funcionando.
    const ok = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    expect(ok.status).toBe(200);
  });

  it('formulário e texto no login: 415, sem chegar ao login (nem cookie de sessão)', async () => {
    const formulario = await amb
      .http()
      .post('/api/auth/login')
      .type('form')
      .send(`codigoEmpresa=${emp.codigo}&login=admin&senha=${SENHA_TESTE}`);
    expect(formulario.status).toBe(415);
    expect(formulario.body.codigo).toBe('TIPO_NAO_SUPORTADO');
    expect(formulario.headers['set-cookie']).toBeUndefined();
    const texto = await amb
      .http()
      .post('/api/auth/login')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE }));
    expect(texto.status).toBe(415);
    expect(texto.headers['set-cookie']).toBeUndefined();
  });

  it('rota autenticada sem token: 401 sem ler o corpo grande', async () => {
    const r = await postar('/api/acertos', {}, repetitivo);
    expect(r.status).toBe(401);
    expect(parsesMaioresQue(100 * KIB)).toBe(0);
  });
});

describe('rotas autenticadas: o limite grande só nas marcadas', () => {
  /** Um acerto com 5.000 itens (o máximo do contrato): ~1 MiB de JSON. */
  const acerto = () => ({
    estoqueId: uuidv7(),
    tipoAjuste: 'entrada',
    dataContagem: new Date().toISOString(),
    motivo: 'Contagem de teste',
    itens: Array.from({ length: 5000 }, () => ({
      id: null,
      produtoId: uuidv7(),
      variacaoId: null,
      loteId: uuidv7(),
      quantidade: '123456.789',
      custoUnitario: '12345.6789',
    })),
  });

  it('acerto com 5.000 itens passa do limite padrão e é lido (a validação de negócio responde, não o 413)', async () => {
    const corpo = acerto();
    expect(JSON.stringify(corpo).length).toBeGreaterThan(600 * KIB);
    const r = await amb.http().post('/api/acertos').set('Authorization', `Bearer ${tokenAdmin}`).send(corpo);
    // O estoque inventado só é recusado depois de o corpo inteiro chegar e passar no contrato: sem o corpo, o erro
    // seria o 422 do contrato (campo `_`), não este.
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(422);
    expect(r.body.campos?.estoqueId).toEqual(['Estoque não encontrado']);
  });

  it('o mesmo tamanho numa rota sem a marca: 413', async () => {
    const r = await amb
      .http()
      .put('/api/configuracoes')
      .set({ Authorization: `Bearer ${tokenAdmin}`, Connection: 'keep-alive' })
      .send({ valores: { 'vendas.titulo_recibo': 'x'.repeat(200 * KIB) } });
    expect(r.status).toBe(413);
    expect(r.body.codigo).toBe('CORPO_GRANDE');
    // Com a sessão conferida, a conexão continua de pé (o navegador recebe o 413, não uma conexão cortada).
    expect(r.headers.connection).not.toBe('close');
  });

  it('compressão numa rota autenticada do ERP: 415', async () => {
    const r = await postar(
      '/api/acertos',
      { Authorization: `Bearer ${tokenAdmin}`, 'Content-Encoding': 'gzip' },
      gzipSync(Buffer.from(JSON.stringify(acerto()))),
    );
    expect(r.status).toBe(415);
  });
});

describe('POST /sync/push: o lote é lido depois de autenticar o terminal', () => {
  it('lote legítimo de centenas de KiB, como o PDV 0.12.0 manda (em partes, sem compressão): 200 aplicado', async () => {
    const corpo = lote([eventoAuditoria(1, 300)]);
    expect(corpo.length).toBeGreaterThan(500 * KIB);
    const r = await postar('/sync/push', cabecalhosSync(tokenTerminal), corpo);
    expect(r.status, JSON.stringify(r.corpo).slice(0, 300)).toBe(200);
    expect(r.corpo.resultados).toEqual([expect.objectContaining({ sequencia: 1, status: 'aplicado' })]);
  });

  it('o lote com gzip (SYNC 2.1) também: 200 aplicado', async () => {
    const r = await postar(
      '/sync/push',
      { ...cabecalhosSync(tokenTerminal), 'Content-Encoding': 'gzip' },
      gzipSync(lote([eventoAuditoria(2, 300)])),
      false,
    );
    expect(r.status, JSON.stringify(r.corpo).slice(0, 300)).toBe(200);
    expect(r.corpo.resultados).toEqual([expect.objectContaining({ sequencia: 2, status: 'aplicado' })]);
  });

  it('sem token válido: 401 TOKEN_INVALIDO sem descomprimir nem interpretar o lote', async () => {
    const outro = `${terminalId}.${'A'.repeat(43)}`;
    for (const token of [undefined, outro]) {
      const r = await postar(
        '/sync/push',
        { ...cabecalhosSync(token), 'Content-Encoding': 'gzip' },
        gzipSync(Buffer.from(`[${'{},'.repeat(1_200_000)}{}]`)),
      );
      expect(r.status).toBe(401);
      expect((r.corpo.erro as { codigo: string }).codigo).toBe('TOKEN_INVALIDO');
    }
    expect(parsesMaioresQue(100 * KIB)).toBe(0);
  });

  it('lote acima do limite do lote: 413 LOTE_GRANDE_DEMAIS (o PDV divide ao meio), sem interpretar', async () => {
    const r = await postar(
      '/sync/push',
      { ...cabecalhosSync(tokenTerminal), 'Content-Encoding': 'gzip' },
      gzipSync(Buffer.from(`[${'{},'.repeat(1_500_000)}{}]`)),
    );
    expect(r.status).toBe(413);
    expect((r.corpo.erro as { codigo: string }).codigo).toBe('LOTE_GRANDE_DEMAIS');
    expect(parsesMaioresQue(100 * KIB)).toBe(0);
    // O terminal segue: o próximo lote do tamanho certo é aceito.
    const ok = await postar('/sync/push', cabecalhosSync(tokenTerminal), lote([eventoAuditoria(3, 10)]));
    expect(ok.status).toBe(200);
  });

  it('heartbeat e renovação do token sem token válido: 401 TOKEN_INVALIDO sem interpretar o corpo', async () => {
    const outro = `${terminalId}.${'A'.repeat(43)}`;
    const corpo = Buffer.from(`[${'{},'.repeat(1_000_000)}{}]`); // ~3 MiB, abaixo do limite grande do heartbeat
    for (const rota of ['/sync/heartbeat', '/sync/token/renovar']) {
      for (const token of [undefined, outro]) {
        // `keep-alive`: o servidor responde o 401 e descarta o resto, sem fechar a conexão no meio do envio do teste.
        const r = await postar(rota, { ...cabecalhosSync(token), Connection: 'keep-alive' }, corpo);
        expect(r.status, rota).toBe(401);
        expect((r.corpo.erro as { codigo: string }).codigo, rota).toBe('TOKEN_INVALIDO');
      }
    }
    expect(parsesMaioresQue(100 * KIB)).toBe(0);
  });

  it('heartbeat do terminal continua 200', async () => {
    const r = await postar(
      '/sync/heartbeat',
      cabecalhosSync(tokenTerminal),
      Buffer.from(JSON.stringify({ eventos_pendentes: 0, eventos_resolvidos_ack: [uuidv7()] })),
    );
    expect(r.status, JSON.stringify(r.corpo)).toBe(200);
  });
});

describe('terminal revogado enquanto o lote ainda chega (decisão 199)', () => {
  it('o corpo termina depois da revogação: 401 TERMINAL_REVOGADO e nada gravado', async () => {
    const autenticar = vi.spyOn(amb.servicos.terminalAuth, 'autenticar');
    try {
      const evento = eventoAuditoria(4, 100);
      const corpo = lote([evento]);
      expect(corpo.length).toBeGreaterThan(64 * KIB); // mais de uma parte: a revogação cai no meio do envio
      const r = await postar('/sync/push', cabecalhosSync(tokenTerminal), corpo, true, async () => {
        // O terminal já foi autenticado (com o token válido) e o servidor espera o resto do corpo.
        await vi.waitFor(() => expect(autenticar).toHaveBeenCalledTimes(1));
        await autenticar.mock.results[0]!.value;
        const revogar = await amb
          .http()
          .post(`/api/terminais/${terminalId}/revogar`)
          .set('Authorization', `Bearer ${tokenAdmin}`)
          .send({ modo: 'imediato', confirmacaoCaixa: 1 });
        expect(revogar.status, JSON.stringify(revogar.body)).toBe(200);
      });
      expect(r.status, JSON.stringify(r.corpo).slice(0, 300)).toBe(401);
      expect((r.corpo.erro as { codigo: string }).codigo).toBe('TERMINAL_REVOGADO');
      expect(
        await consultar(emp.nomeBanco, 'select 1 from eventos_recebidos where evento_id = $1', [
          evento.evento_id,
        ]),
      ).toHaveLength(0);
    } finally {
      autenticar.mockRestore();
    }
  });
});
