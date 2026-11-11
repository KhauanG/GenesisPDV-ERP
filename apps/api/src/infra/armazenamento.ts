/**
 * Armazenamento de objetos S3-compatível (MD 3.1.6; MinIO em desenvolvimento): o conteúdo nunca fica no banco, só os
 * metadados em `arquivos`. Download e upload pelo navegador/PDV por URL assinada de curta duração; a chave do objeto
 * segue `emp/<codigo>/<categoria>/<aaaa>/<mm>/<uuid>.<ext>` (XML fiscal: `emp/<codigo>/xml/<sha256>.xml`).
 * E/S externa: nunca dentro de transação que segure a trava de versão (MD 1.5).
 */
import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { uuidv7 } from 'uuidv7';
import type { Configuracao } from '../config/configuracao.js';

/** Validade padrão das URLs assinadas (SYNC 6.9, 6.12: 15 min). */
export const VALIDADE_URL_S = 15 * 60;

/**
 * Parte do envio em multipart (`gravarFluxo`): o S3, o MinIO e o XML API do Google Cloud Storage exigem pelo menos
 * 5 MiB em cada parte menos a última. Com 8 MiB, a memória do envio é a de uma parte, e 1 GB cabe em 128 partes (o
 * teto é 10.000).
 */
export const TAMANHO_PARTE_BYTES = 8 * 1024 * 1024;

/** Espera máxima para abrir a conexão com o armazenamento. */
const CONEXAO_ARMAZENAMENTO_MS = 10_000;

export function chaveArquivo(
  codigoEmpresa: number,
  categoria: string,
  extensao: string,
  agora = new Date(),
): string {
  const ext =
    extensao
      .replace(/^\./, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'bin';
  const mes = String(agora.getUTCMonth() + 1).padStart(2, '0');
  return `emp/${codigoEmpresa}/${categoria}/${agora.getUTCFullYear()}/${mes}/${uuidv7()}.${ext}`;
}

/**
 * A chave de uma variante (a `pdv_256` da foto, F2-B43): a do original com o nome da variante antes da extensão
 * (`…/<uuid>.jpg` → `…/<uuid>.pdv_256.webp`). Tudo gerado pelo servidor: nada do nome do arquivo do cliente entra no
 * caminho.
 */
export function chaveVariante(chaveOriginal: string, variante: string, extensao: string): string {
  const base = chaveOriginal.replace(/\.[a-z0-9]+$/, '');
  const ext = extensao.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  return `${base}.${variante.replace(/[^a-z0-9_]/g, '')}.${ext}`;
}

/** XML fiscal é endereçado por conteúdo: reenviar o mesmo XML é idempotente (SYNC 9.10). */
export function chaveXmlFiscal(codigoEmpresa: number, xml: Buffer): string {
  return `emp/${codigoEmpresa}/xml/${createHash('sha256').update(xml).digest('hex')}.xml`;
}

export class ArmazenamentoObjetos {
  private readonly s3: S3Client;
  readonly bucket: string;

  constructor(config: Configuracao['armazenamento']) {
    // Sem chaves explícitas vale a cadeia padrão de credenciais do SDK (variáveis AWS_*, perfil, papel da instância).
    this.bucket = config.bucket;
    this.s3 = new S3Client({
      region: config.regiao,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.estiloCaminho,
      // O SDK não tem limite de tempo nenhum por padrão: uma parte do envio pendurada (conexão meio aberta) esperaria
      // para sempre, com a exportação em tarefa parada segurando a transação do cursor, a vaga do semáforo e a fila
      // (decisão 177). Limite de **inatividade** (nenhum byte indo ou vindo), não de duração: o envio lento que anda
      // continua; o parado falha, o SDK repete (3 tentativas) e depois o envio é abortado.
      requestHandler: { connectionTimeout: CONEXAO_ARMAZENAMENTO_MS, socketTimeout: config.inatividadeMs },
      // Checksums "flexíveis" só quando o serviço exige: compatível com MinIO e outros S3 não AWS.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...(config.chaveAcesso && config.chaveSecreta
        ? { credentials: { accessKeyId: config.chaveAcesso, secretAccessKey: config.chaveSecreta } }
        : {}),
    });
  }

  /** Cria o bucket se não existir (desenvolvimento e testes; em produção ele é provisionado fora da API). */
  async garantirBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async gravar(
    chave: string,
    conteudo: Buffer,
    tipoMime: string,
  ): Promise<{ sha256: string; tamanhoBytes: number }> {
    const sha256 = createHash('sha256').update(conteudo).digest('hex');
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: chave,
        Body: conteudo,
        ContentType: tipoMime,
        Metadata: { sha256 },
      }),
    );
    return { sha256, tamanhoBytes: conteudo.length };
  }

  /**
   * Grava o conteúdo que chega em pedaços (a exportação em streaming, F2-B29) sem juntar o arquivo inteiro na memória:
   * junta até `tamanhoParte` e envia cada parte em multipart (uma por vez: ler a fonte espera o envio, e quem escreve
   * na fonte sente a pressão). Arquivo menor que uma parte vai num `PutObject` só. Falhou no meio → o multipart é
   * abortado (as partes não ficam cobrando no bucket). O sha256 é calculado no caminho; no multipart ele não vai nos
   * metadados do objeto (só se sabe no fim), só em `arquivos`.
   */
  async gravarFluxo(
    chave: string,
    fonte: AsyncIterable<Buffer | string>,
    tipoMime: string,
    opcoes: { tamanhoParte?: number } = {},
  ): Promise<{ sha256: string; tamanhoBytes: number; partes: number }> {
    const tamanhoParte = opcoes.tamanhoParte ?? TAMANHO_PARTE_BYTES;
    const hash = createHash('sha256');
    let tamanhoBytes = 0;
    let pendentes: Buffer[] = [];
    let tamanhoPendente = 0;
    let uploadId: string | undefined;
    const partes: Array<{ PartNumber: number; ETag: string }> = [];
    const enviarParte = async () => {
      const corpo = Buffer.concat(pendentes, tamanhoPendente);
      pendentes = [];
      tamanhoPendente = 0;
      if (!uploadId) {
        const r = await this.s3.send(
          new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: chave, ContentType: tipoMime }),
        );
        if (!r.UploadId) throw new Error('O armazenamento não abriu o envio em partes.');
        uploadId = r.UploadId;
      }
      const numero = partes.length + 1;
      const r = await this.s3.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: chave,
          UploadId: uploadId,
          PartNumber: numero,
          Body: corpo,
        }),
      );
      partes.push({ PartNumber: numero, ETag: r.ETag ?? '' });
    };
    try {
      for await (const bruto of fonte) {
        const pedaco = typeof bruto === 'string' ? Buffer.from(bruto, 'utf8') : bruto;
        if (!pedaco.length) continue;
        hash.update(pedaco);
        tamanhoBytes += pedaco.length;
        pendentes.push(pedaco);
        tamanhoPendente += pedaco.length;
        if (tamanhoPendente >= tamanhoParte) await enviarParte();
      }
      const sha256 = hash.digest('hex');
      if (!uploadId) {
        await this.gravar(chave, Buffer.concat(pendentes, tamanhoPendente), tipoMime);
        return { sha256, tamanhoBytes, partes: 1 };
      }
      if (tamanhoPendente) await enviarParte();
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: chave,
          UploadId: uploadId,
          MultipartUpload: { Parts: partes },
        }),
      );
      return { sha256, tamanhoBytes, partes: partes.length };
    } catch (e) {
      if (uploadId) {
        await this.s3
          .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: chave, UploadId: uploadId }))
          .catch(() => undefined);
      }
      throw e;
    }
  }

  async ler(chave: string): Promise<Buffer> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: chave }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  /** Apaga o objeto (o envio que não chegou a ser gravado em `arquivos`); objeto inexistente não é erro no S3. */
  async excluir(chave: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: chave }));
  }

  /** URL assinada de download; `nomeArquivo` vira o `Content-Disposition` da resposta. */
  urlDownload(chave: string, opcoes: { nomeArquivo?: string; validadeS?: number } = {}): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: chave,
        ...(opcoes.nomeArquivo
          ? {
              ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(opcoes.nomeArquivo)}`,
            }
          : {}),
      }),
      { expiresIn: opcoes.validadeS ?? VALIDADE_URL_S },
    );
  }

  /** URL assinada de upload direto (o navegador envia o arquivo sem passar pela API). */
  urlUpload(chave: string, tipoMime: string, validadeS = VALIDADE_URL_S): Promise<string> {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: chave, ContentType: tipoMime }),
      {
        expiresIn: validadeS,
      },
    );
  }

  destruir(): void {
    this.s3.destroy();
  }
}
