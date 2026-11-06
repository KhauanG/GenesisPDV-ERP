/**
 * Armazenamento de objetos S3-compatível (MD 3.1.6; MinIO em desenvolvimento): o conteúdo nunca fica no banco, só os
 * metadados em `arquivos`. Download e upload pelo navegador/PDV por URL assinada de curta duração; a chave do objeto
 * segue `emp/<codigo>/<categoria>/<aaaa>/<mm>/<uuid>.<ext>` (XML fiscal: `emp/<codigo>/xml/<sha256>.xml`).
 * E/S externa: nunca dentro de transação que segure a trava de versão (MD 1.5).
 */
import { createHash } from 'node:crypto';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { uuidv7 } from 'uuidv7';
import type { Configuracao } from '../config/configuracao.js';

/** Validade padrão das URLs assinadas (SYNC 6.9, 6.12: 15 min). */
export const VALIDADE_URL_S = 15 * 60;

export function chaveArquivo(codigoEmpresa: number, categoria: string, extensao: string, agora = new Date()): string {
  const ext = extensao.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  const mes = String(agora.getUTCMonth() + 1).padStart(2, '0');
  return `emp/${codigoEmpresa}/${categoria}/${agora.getUTCFullYear()}/${mes}/${uuidv7()}.${ext}`;
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

  async gravar(chave: string, conteudo: Buffer, tipoMime: string): Promise<{ sha256: string; tamanhoBytes: number }> {
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

  async ler(chave: string): Promise<Buffer> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: chave }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  /** URL assinada de download; `nomeArquivo` vira o `Content-Disposition` da resposta. */
  urlDownload(chave: string, opcoes: { nomeArquivo?: string; validadeS?: number } = {}): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: chave,
        ...(opcoes.nomeArquivo
          ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(opcoes.nomeArquivo)}` }
          : {}),
      }),
      { expiresIn: opcoes.validadeS ?? VALIDADE_URL_S },
    );
  }

  /** URL assinada de upload direto (o navegador envia o arquivo sem passar pela API). */
  urlUpload(chave: string, tipoMime: string, validadeS = VALIDADE_URL_S): Promise<string> {
    return getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: chave, ContentType: tipoMime }), {
      expiresIn: validadeS,
    });
  }

  destruir(): void {
    this.s3.destroy();
  }
}
