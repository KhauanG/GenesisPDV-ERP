/**
 * S3 mínimo em memória para os testes (PUT/GET/HEAD de objeto e de bucket, estilo caminho). Não confere a
 * assinatura: serve para provar o encanamento (chaves, URL assinada, conteúdo). Com `ARMAZENAMENTO_TESTE_URL`
 * os testes usam um S3 de verdade (MinIO do docker-compose) em vez dele.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface S3Falso {
  url: string;
  objetos: Map<string, { corpo: Buffer; tipo: string }>;
  pedidos: Array<{ metodo: string; caminho: string; consulta: URLSearchParams }>;
  fechar(): Promise<void>;
}

export async function iniciarS3Falso(): Promise<S3Falso> {
  const objetos = new Map<string, { corpo: Buffer; tipo: string }>();
  const buckets = new Set<string>();
  const pedidos: S3Falso['pedidos'] = [];
  const servidor: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const [, bucket = '', ...resto] = decodeURIComponent(u.pathname).split('/');
    const chave = resto.join('/');
    pedidos.push({ metodo: req.method ?? '', caminho: u.pathname, consulta: u.searchParams });
    const partes: Buffer[] = [];
    req.on('data', (p: Buffer) => partes.push(p));
    req.on('end', () => {
      if (!chave) {
        if (req.method === 'PUT') buckets.add(bucket);
        res.statusCode = req.method === 'PUT' || buckets.has(bucket) ? 200 : 404;
        res.end();
        return;
      }
      const id = `${bucket}/${chave}`;
      if (req.method === 'PUT') {
        objetos.set(id, { corpo: Buffer.concat(partes), tipo: String(req.headers['content-type'] ?? '') });
        res.setHeader('ETag', '"falso"');
        res.end();
        return;
      }
      const obj = objetos.get(id);
      if (!obj) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/xml');
        res.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      res.setHeader('Content-Type', obj.tipo);
      res.setHeader('Content-Length', obj.corpo.length);
      res.end(req.method === 'HEAD' ? undefined : obj.corpo);
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  const { port } = servidor.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    objetos,
    pedidos,
    fechar: () => new Promise((ok) => servidor.close(() => ok())),
  };
}
