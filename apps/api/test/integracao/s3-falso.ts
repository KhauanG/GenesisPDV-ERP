/**
 * S3 mínimo em memória para os testes (PUT/GET/HEAD de objeto e de bucket, estilo caminho, e o envio em multipart:
 * iniciar, parte, concluir e abortar). Não confere a assinatura nem o tamanho mínimo das partes: serve para provar o
 * encanamento (chaves, URL assinada, conteúdo). Com `ARMAZENAMENTO_TESTE_URL` os testes usam um S3 de verdade (MinIO
 * do docker-compose) em vez dele.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface S3Falso {
  url: string;
  objetos: Map<string, { corpo: Buffer; tipo: string }>;
  /** Envios em multipart abertos (iniciados e ainda não concluídos nem abortados). */
  multipart: Map<string, { id: string; tipo: string; partes: Map<number, Buffer> }>;
  pedidos: Array<{ metodo: string; caminho: string; consulta: URLSearchParams }>;
  /** Com um número, o envio dessa parte do multipart responde 500 (o teste da falha no meio do envio). */
  falharNaParte: number | null;
  /**
   * Com um número, o envio dessa parte é recebido e nunca respondido (a conexão meio aberta): o teste do limite de
   * inatividade do cliente S3.
   */
  pendurarNaParte: number | null;
  fechar(): Promise<void>;
}

export async function iniciarS3Falso(): Promise<S3Falso> {
  const objetos = new Map<string, { corpo: Buffer; tipo: string }>();
  const buckets = new Set<string>();
  const pedidos: S3Falso['pedidos'] = [];
  const multipart: S3Falso['multipart'] = new Map();
  let proximoEnvio = 0;
  const xml = (res: import('node:http').ServerResponse, corpo: string) => {
    res.setHeader('Content-Type', 'application/xml');
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${corpo}`);
  };
  const falso: S3Falso = {
    url: '',
    objetos,
    multipart,
    pedidos,
    falharNaParte: null,
    pendurarNaParte: null,
    fechar: () =>
      new Promise((ok) => {
        servidor.close(() => ok());
        servidor.closeAllConnections();
      }),
  };
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
      const envio = u.searchParams.get('uploadId');
      if (req.method === 'POST' && u.searchParams.has('uploads')) {
        const uploadId = `envio-${++proximoEnvio}`;
        multipart.set(uploadId, { id, tipo: String(req.headers['content-type'] ?? ''), partes: new Map() });
        xml(
          res,
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${chave}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }
      if (envio !== null) {
        const aberto = multipart.get(envio);
        if (!aberto || aberto.id !== id) {
          res.statusCode = 404;
          xml(res, '<Error><Code>NoSuchUpload</Code></Error>');
          return;
        }
        if (req.method === 'PUT' && Number(u.searchParams.get('partNumber')) === falso.pendurarNaParte)
          return;
        if (req.method === 'PUT' && Number(u.searchParams.get('partNumber')) === falso.falharNaParte) {
          res.statusCode = 500;
          xml(res, '<Error><Code>InternalError</Code></Error>');
          return;
        }
        if (req.method === 'PUT') {
          aberto.partes.set(Number(u.searchParams.get('partNumber')), Buffer.concat(partes));
          res.setHeader('ETag', `"parte-${u.searchParams.get('partNumber')}"`);
          res.end();
          return;
        }
        if (req.method === 'DELETE') {
          multipart.delete(envio);
          res.statusCode = 204;
          res.end();
          return;
        }
        // POST ?uploadId: concluir, com as partes na ordem pedida no corpo.
        const numeros = [
          ...Buffer.concat(partes)
            .toString('utf8')
            .matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
        ].map((m) => Number(m[1]));
        objetos.set(id, {
          corpo: Buffer.concat(numeros.map((n) => aberto.partes.get(n)!)),
          tipo: aberto.tipo,
        });
        multipart.delete(envio);
        xml(
          res,
          `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${chave}</Key><ETag>"falso"</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }
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
  falso.url = `http://127.0.0.1:${port}`;
  return falso;
}
