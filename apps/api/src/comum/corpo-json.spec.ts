/**
 * Leitura do corpo JSON (`lerCorpoJson`; README da API › decisão 199), num servidor HTTP local de verdade: o limite
 * vale para os bytes recebidos e para os descomprimidos, e a leitura para no limite (o `Content-Length` acima dele
 * volta sem ler nada; o corpo em partes, no byte seguinte); compressão só onde a rota aceita; só JSON em UTF-8 (o
 * formulário e o texto voltam 415). Corpos pequenos, montados no teste, com um limite pequeno.
 */
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lerCorpoJson } from './corpo-json.js';
import { ErroApi } from './erros.js';

const LIMITE = 4096;

interface Opcoes {
  comprimido?: boolean;
  drenarAoRecusar?: boolean;
  prazoMs?: number;
}

interface Resultado {
  status: number;
  corpo: { valor?: unknown; codigo?: string };
  conexao: string | undefined;
  /** Bytes que o servidor tinha recebido no socket quando respondeu. */
  recebidosNoServidor: number;
}

let servidor: Server;
let porta: number;
let opcoesDaVez: Opcoes = {};

beforeAll(async () => {
  servidor = createServer((req: IncomingMessage, res) => {
    const responder = (status: number, corpo: object, cabecalhos: Record<string, string> = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-Recebidos': String(req.socket.bytesRead),
        ...cabecalhos,
      });
      res.end(JSON.stringify(corpo));
    };
    lerCorpoJson(req, LIMITE, opcoesDaVez).then(
      (valor) => responder(200, { valor: valor === undefined ? '(nada)' : valor }),
      (e: unknown) => {
        const erro = e as ErroApi;
        responder(erro.status, { codigo: erro.codigo }, erro.extras.cabecalhos);
      },
    );
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  porta = (servidor.address() as AddressInfo).port;
});

afterAll(async () => {
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
});

/**
 * Envia `partes` (um a um, sem esperar o fim) e devolve a resposta assim que ela chega — o servidor pode responder antes
 * do corpo terminar. `infinito` continua mandando a última parte até a resposta chegar (no máximo `maximoBytes`);
 * `semFim` manda as partes e não termina o corpo (o envio que para no meio).
 */
function enviar(
  cabecalhos: Record<string, string>,
  partes: Buffer[],
  opcoes: Opcoes = {},
  extra: { infinito?: boolean; maximoBytes?: number; semFim?: boolean } = {},
): Promise<Resultado> {
  opcoesDaVez = opcoes;
  return new Promise((resolver, rejeitar) => {
    let respondeu = false;
    const req = request(
      { host: '127.0.0.1', port: porta, method: 'POST', path: '/', headers: cabecalhos, agent: false },
      (res) => {
        respondeu = true;
        const pedacos: Buffer[] = [];
        res.on('data', (p: Buffer) => pedacos.push(p));
        res.on('end', () => {
          resolver({
            status: res.statusCode ?? 0,
            corpo: JSON.parse(Buffer.concat(pedacos).toString('utf8')) as Resultado['corpo'],
            conexao: res.headers.connection,
            recebidosNoServidor: Number(res.headers['x-recebidos']),
          });
          req.destroy();
        });
      },
    );
    // A conexão fechada pelo servidor no meio do envio não é falha do teste: a resposta já veio.
    req.on('error', (e) => {
      if (!respondeu) rejeitar(e);
    });
    let enviados = 0;
    const escrever = (i: number) => {
      if (respondeu || req.destroyed) return;
      const parte = partes[Math.min(i, partes.length - 1)]!;
      if (i >= partes.length && (!extra.infinito || enviados >= (extra.maximoBytes ?? Infinity))) {
        if (!extra.semFim) req.end();
        return;
      }
      enviados += parte.length;
      req.write(parte, () => setImmediate(() => escrever(i + 1)));
    };
    escrever(0);
  });
}

const json = (valor: unknown) => Buffer.from(JSON.stringify(valor));
const CABECALHO_JSON = { 'Content-Type': 'application/json' };

/**
 * Deflate (zlib) que nunca descomprime nada: o cabeçalho zlib uma vez e depois só blocos "guardados" vazios (5 bytes
 * cada), repetidos à vontade sem o fluxo deixar de ser válido.
 */
const CABECALHO_ZLIB = Buffer.from([0x78, 0x01]);
const blocosVazios = (quantos: number) => Buffer.alloc(quantos * 5, Buffer.from([0, 0, 0, 0xff, 0xff]));

describe('lerCorpoJson: formato', () => {
  it('JSON dentro do limite é lido; vazio vira {}; sem Content-Type ou multipart fica sem ler', async () => {
    const corpo = json({ a: 1, texto: 'ação' });
    expect(
      (await enviar({ ...CABECALHO_JSON, 'Content-Length': String(corpo.length) }, [corpo])).corpo,
    ).toEqual({ valor: { a: 1, texto: 'ação' } });
    expect(
      (await enviar({ 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': '0' }, [])).corpo,
    ).toEqual({ valor: {} });
    expect((await enviar({ 'Content-Type': 'application/vnd.genesis+json' }, [json([1])])).corpo).toEqual({
      valor: [1],
    });
    expect((await enviar({}, [json({ a: 1 })])).corpo).toEqual({ valor: '(nada)' });
    expect((await enviar({ 'Content-Type': 'multipart/form-data; boundary=x' }, [json({})])).corpo).toEqual({
      valor: '(nada)',
    });
  });

  it('formulário, texto e outro conjunto de caracteres: 415, com a conexão fechada', async () => {
    for (const tipo of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'application/json; charset=utf-16le',
    ]) {
      const r = await enviar({ 'Content-Type': tipo }, [Buffer.from('login=a&senha=b')]);
      expect(r.status, tipo).toBe(415);
      expect(r.corpo.codigo).toBe('TIPO_NAO_SUPORTADO');
      expect(r.conexao).toBe('close');
    }
    // POST sem corpo (Content-Length: 0) de outro tipo não é recusado: não há o que ler.
    expect(
      (await enviar({ 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '0' }, []))
        .corpo,
    ).toEqual({ valor: '(nada)' });
  });

  it('JSON malformado, valor solto no topo ou compressão corrompida: 422 VALIDACAO', async () => {
    for (const corpo of ['{"a":', '123', '"texto"']) {
      const r = await enviar(CABECALHO_JSON, [Buffer.from(corpo)]);
      expect(r.status, corpo).toBe(422);
      expect(r.corpo.codigo).toBe('VALIDACAO');
    }
    const r = await enviar({ ...CABECALHO_JSON, 'Content-Encoding': 'gzip' }, [Buffer.from('não é gzip')], {
      comprimido: true,
    });
    expect(r.status).toBe(422);
  });
});

describe('lerCorpoJson: limite', () => {
  it('Content-Length acima do limite: 413 sem ler o corpo', async () => {
    const r = await enviar({ ...CABECALHO_JSON, 'Content-Length': String(10 * LIMITE) }, [
      Buffer.from('{"a":'),
    ]);
    expect(r.status).toBe(413);
    expect(r.corpo.codigo).toBe('CORPO_GRANDE');
    expect(r.conexao).toBe('close');
  });

  it('corpo em partes, sem Content-Length: 413 logo depois do limite, sem esperar o resto', async () => {
    const parte = Buffer.from(`[${'1,'.repeat(511)}1,`); // 1.024 bytes
    const parseOriginal = JSON.parse;
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const r = await enviar(CABECALHO_JSON, [parte], {}, { infinito: true, maximoBytes: 1024 * 1024 });
      expect(r.status).toBe(413);
      expect(r.corpo.codigo).toBe('CORPO_GRANDE');
      // O servidor parou perto do limite (o socket lê em blocos de até 64 KiB), longe do 1 MiB que o cliente mandaria.
      expect(r.recebidosNoServidor).toBeLessThan(LIMITE + 80 * 1024);
      // Nada do tamanho do corpo foi interpretado (o `JSON.parse` que roda é o da resposta, no cliente do teste).
      expect(parse.mock.calls.every(([texto]) => String(texto).length < LIMITE)).toBe(true);
    } finally {
      parse.mockRestore();
      expect(JSON.parse).toBe(parseOriginal);
    }
  });

  it('exatamente no limite é lido; um byte acima, 413', async () => {
    const noLimite = Buffer.from(`[${'1,'.repeat((LIMITE - 3) / 2)}1]`.padEnd(LIMITE, ' '));
    expect(noLimite.length).toBe(LIMITE);
    expect((await enviar(CABECALHO_JSON, [noLimite])).status).toBe(200);
    expect((await enviar(CABECALHO_JSON, [Buffer.concat([noLimite, Buffer.from(' ')])])).status).toBe(413);
  });
});

describe('lerCorpoJson: compressão', () => {
  const grande = json({ lista: Array.from({ length: 4000 }, () => 0) }); // ~8 KiB, comprime para poucos bytes

  it('rota sem compressão: gzip, deflate, br e codificação desconhecida voltam 415 sem descomprimir', async () => {
    for (const [codificacao, corpo] of [
      ['gzip', gzipSync(grande)],
      ['deflate', deflateSync(grande)],
      ['br', brotliCompressSync(grande)],
      ['zzz', grande],
    ] as const) {
      const r = await enviar({ ...CABECALHO_JSON, 'Content-Encoding': codificacao }, [corpo]);
      expect(r.status, codificacao).toBe(415);
      expect(r.corpo.codigo).toBe('TIPO_NAO_SUPORTADO');
    }
  });

  it('rota com compressão: o descomprimido dentro do limite é lido; acima dele, 413 (o limite vale para os dois)', async () => {
    const pequeno = json({ lista: [1, 2, 3] });
    for (const [codificacao, comprimir] of [
      ['gzip', gzipSync],
      ['deflate', deflateSync],
      ['br', brotliCompressSync],
    ] as const) {
      const ok = await enviar({ ...CABECALHO_JSON, 'Content-Encoding': codificacao }, [comprimir(pequeno)], {
        comprimido: true,
      });
      expect(ok.corpo, codificacao).toEqual({ valor: { lista: [1, 2, 3] } });
      const comprimido = comprimir(grande);
      expect(comprimido.length).toBeLessThan(LIMITE);
      const r = await enviar({ ...CABECALHO_JSON, 'Content-Encoding': codificacao }, [comprimido], {
        comprimido: true,
      });
      expect(r.status, codificacao).toBe(413);
      expect(r.corpo.codigo).toBe('CORPO_GRANDE');
    }
    const r = await enviar({ ...CABECALHO_JSON, 'Content-Encoding': 'compress' }, [grande], {
      comprimido: true,
    });
    expect(r.status).toBe(415);
  });

  it('comprimido que não descomprime nada: 413 pelos bytes recebidos', async () => {
    // O fluxo continua válido do começo ao fim: o 413 só pode vir da contagem dos bytes recebidos (nunca do 422 do
    // conteúdo corrompido, qualquer que seja a ordem entre o zlib e a chegada das partes).
    const r = await enviar(
      { ...CABECALHO_JSON, 'Content-Encoding': 'deflate' },
      [CABECALHO_ZLIB, blocosVazios(400)],
      { comprimido: true },
      { infinito: true, maximoBytes: 1024 * 1024 },
    );
    expect(r.status).toBe(413);
    expect(r.corpo.codigo).toBe('CORPO_GRANDE');
    expect(r.recebidosNoServidor).toBeLessThan(LIMITE + 80 * 1024);
  });

  it('o mesmo fluxo vazio dentro do limite continua válido até o fim (vira {})', async () => {
    const r = await enviar(
      { ...CABECALHO_JSON, 'Content-Encoding': 'deflate' },
      [
        CABECALHO_ZLIB,
        blocosVazios(400),
        blocosVazios(300),
        Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
      ],
      { comprimido: true },
    );
    expect(r.corpo).toEqual({ valor: {} });
  });

  it('o terminal autenticado (drenar) recebe o 413 sem fechar a conexão', async () => {
    const r = await enviar(
      { ...CABECALHO_JSON, Connection: 'keep-alive' },
      [Buffer.alloc(LIMITE + 1, 0x20)],
      {
        drenarAoRecusar: true,
      },
    );
    expect(r.status).toBe(413);
    expect(r.conexao).not.toBe('close');
  });
});

describe('lerCorpoJson: prazo de leitura', () => {
  it('corpo que para no meio: 408 TEMPO_ESGOTADO no prazo, com a conexão fechada mesmo para o terminal', async () => {
    const inicio = Date.now();
    const r = await enviar(
      { ...CABECALHO_JSON, Connection: 'keep-alive' },
      [Buffer.from('{"a":')],
      { drenarAoRecusar: true, prazoMs: 200 },
      { semFim: true },
    );
    expect(r.status).toBe(408);
    expect(r.corpo.codigo).toBe('TEMPO_ESGOTADO');
    expect(r.conexao).toBe('close');
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(150);
  });

  it('corpo que chega inteiro dentro do prazo é lido', async () => {
    const r = await enviar(CABECALHO_JSON, [Buffer.from('{"a":'), Buffer.from('1}')], { prazoMs: 5000 });
    expect(r.corpo).toEqual({ valor: { a: 1 } });
  });
});
