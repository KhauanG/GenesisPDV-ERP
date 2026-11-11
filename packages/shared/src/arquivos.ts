/**
 * Envio de arquivos e imagens pelo ERP (Fase 2, F2-B43; MD 3.1.6; SYNC 6.12; README da API › decisão 189).
 *
 * O **destino** diz para que serve o arquivo (a foto do produto, o logotipo da marca…) e decide, antes de a API ler o
 * corpo do pedido, a categoria gravada em `arquivos`, os tipos aceitos, o limite de tamanho e as variantes geradas.
 * O tipo é sempre o do **conteúdo** (os primeiros bytes, `detectarTipoArquivo`), nunca a extensão nem o
 * `Content-Type` que o navegador manda; SVG nunca entra (é um documento que roda script, não uma imagem).
 */
import { z } from 'zod';

/** Tipos aceitos pelo conteúdo, com o `Content-Type` fixo com que o arquivo é gravado e servido. */
export const TIPOS_ARQUIVO = {
  png: { tipoMime: 'image/png', extensao: 'png', rotulo: 'PNG' },
  jpeg: { tipoMime: 'image/jpeg', extensao: 'jpg', rotulo: 'JPG' },
  webp: { tipoMime: 'image/webp', extensao: 'webp', rotulo: 'WebP' },
  pdf: { tipoMime: 'application/pdf', extensao: 'pdf', rotulo: 'PDF' },
} as const;
export type TipoArquivo = keyof typeof TIPOS_ARQUIVO;

export const TIPOS_IMAGEM = ['png', 'jpeg', 'webp'] as const satisfies readonly TipoArquivo[];

const comeca = (b: Uint8Array, assinatura: readonly number[], deslocamento = 0) =>
  b.length >= deslocamento + assinatura.length && assinatura.every((x, i) => b[deslocamento + i] === x);

const ascii = (texto: string) => [...texto].map((c) => c.charCodeAt(0));

/**
 * O tipo pelo conteúdo (magic bytes): PNG pela assinatura de 8 bytes, JPEG por `FF D8 FF`, WebP pelo `RIFF….WEBP` e
 * PDF por `%PDF-` no início. Qualquer outra coisa (HTML, SVG, GIF, executável, texto) é `null`. Só o começo do
 * arquivo: a imagem é conferida por inteiro depois, ao gerar a variante (decodificada de verdade).
 */
export function detectarTipoArquivo(bytes: Uint8Array): TipoArquivo | null {
  if (comeca(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (comeca(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (comeca(bytes, ascii('RIFF')) && comeca(bytes, ascii('WEBP'), 8)) return 'webp';
  if (comeca(bytes, ascii('%PDF-'))) return 'pdf';
  return null;
}

/** Bytes que bastam para `detectarTipoArquivo` (a tela lê só o começo do arquivo para avisar antes de enviar). */
export const BYTES_DETECCAO_TIPO = 16;

export const VARIANTES_ARQUIVO = ['pdv_256'] as const;
export type VarianteArquivo = (typeof VARIANTES_ARQUIVO)[number];

/** Lado máximo da `pdv_256` (SYNC 6.12: WebP 256 px, ~10–20 KB). */
export const LADO_VARIANTE_PDV = 256;

const MB = 1024 * 1024;

interface DefinicaoDestino {
  /** `arquivos.categoria` (MD 3.1.6). */
  categoria: 'foto_produto' | 'imagem_categoria' | 'logotipo' | 'foto_loja';
  /** `arquivos.entidade`: a tabela dona. */
  entidade: 'produtos' | 'categorias' | 'marcas' | 'lojas';
  tipos: readonly TipoArquivo[];
  limiteBytes: number;
  /** O destino é de uma loja: o envio leva `lojaId` (gravado em `arquivos.loja_id`, o escopo da SYNC 6.12). */
  daLoja: boolean;
  variantes: readonly VarianteArquivo[];
  rotulo: string;
}

/**
 * Os destinos liberados no F2-B43. O PDF é aceito pela detecção, mas nenhum destino daqui o aceita: os anexos com PDF
 * (o boleto e o comprovante do financeiro, ERP 15) entram com a tela deles. O logotipo tem 1 MB (o da loja vai ao
 * cupom e ao DANFE); os outros, 2 MB (ERP 8.2.6).
 */
export const DESTINOS_ARQUIVO = {
  produto_foto: {
    categoria: 'foto_produto',
    entidade: 'produtos',
    tipos: TIPOS_IMAGEM,
    limiteBytes: 2 * MB,
    daLoja: false,
    variantes: ['pdv_256'],
    rotulo: 'Foto do produto',
  },
  categoria_imagem: {
    categoria: 'imagem_categoria',
    entidade: 'categorias',
    tipos: TIPOS_IMAGEM,
    limiteBytes: 2 * MB,
    daLoja: false,
    variantes: ['pdv_256'],
    rotulo: 'Imagem da categoria',
  },
  marca_logotipo: {
    categoria: 'logotipo',
    entidade: 'marcas',
    tipos: TIPOS_IMAGEM,
    limiteBytes: 1 * MB,
    daLoja: false,
    variantes: ['pdv_256'],
    rotulo: 'Logotipo da marca',
  },
  loja_logotipo: {
    categoria: 'logotipo',
    entidade: 'lojas',
    tipos: TIPOS_IMAGEM,
    limiteBytes: 1 * MB,
    daLoja: true,
    variantes: ['pdv_256'],
    rotulo: 'Logotipo da loja',
  },
  loja_foto: {
    categoria: 'foto_loja',
    entidade: 'lojas',
    tipos: TIPOS_IMAGEM,
    limiteBytes: 2 * MB,
    daLoja: true,
    variantes: ['pdv_256'],
    rotulo: 'Foto da loja',
  },
} as const satisfies Record<string, DefinicaoDestino>;
export type DestinoArquivo = keyof typeof DESTINOS_ARQUIVO;
export const NOMES_DESTINO_ARQUIVO = Object.keys(DESTINOS_ARQUIVO) as [DestinoArquivo, ...DestinoArquivo[]];

/** "PNG, JPG ou WebP" (a mensagem de tipo recusado e a dica do campo). */
export function rotuloTiposAceitos(destino: DestinoArquivo): string {
  const r = DESTINOS_ARQUIVO[destino].tipos.map((t) => TIPOS_ARQUIVO[t].rotulo);
  return r.length > 1 ? `${r.slice(0, -1).join(', ')} ou ${r[r.length - 1]}` : (r[0] ?? '');
}

/** "2 MB", "1 MB", "512 KB". */
export function formatarTamanhoArquivo(bytes: number): string {
  if (bytes >= MB) return `${Number((bytes / MB).toFixed(1)).toLocaleString('pt-BR')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const mensagemTipoRecusado = (destino: DestinoArquivo) =>
  `Envie uma imagem ${rotuloTiposAceitos(destino)}. O tipo é conferido pelo conteúdo do arquivo, não pela extensão.`;

export const mensagemArquivoGrande = (destino: DestinoArquivo) =>
  `Arquivo acima de ${formatarTamanhoArquivo(DESTINOS_ARQUIVO[destino].limiteBytes)}. Reduza a imagem e envie de novo.`;

/** A query do `POST /api/arquivos` (o corpo é o multipart com o campo `arquivo`). */
export const envioArquivoSchema = z
  .object({
    destino: z.enum(NOMES_DESTINO_ARQUIVO, 'Destino do arquivo inválido'),
    lojaId: z.uuid('Loja inválida').optional(),
  })
  .superRefine((v, ctx) => {
    const daLoja = DESTINOS_ARQUIVO[v.destino].daLoja;
    if (daLoja && !v.lojaId) ctx.addIssue({ code: 'custom', path: ['lojaId'], message: 'Informe a loja' });
    if (!daLoja && v.lojaId)
      ctx.addIssue({ code: 'custom', path: ['lojaId'], message: 'Este arquivo não é de uma loja' });
  });
export type EnvioArquivo = z.output<typeof envioArquivoSchema>;

export const conteudoArquivoSchema = z.object({
  variante: z.enum(VARIANTES_ARQUIVO).optional(),
});

export interface VarianteArquivoInfo {
  tipoMime: string;
  tamanhoBytes: number;
  sha256: string;
  largura: number;
  altura: number;
}

/** O que o envio devolve e o `GET /api/arquivos/:id` mostra (nunca a chave do armazenamento). */
export interface ArquivoInfo {
  id: string;
  categoria: string;
  entidade: string | null;
  lojaId: string | null;
  nomeOriginal: string;
  tipoMime: string;
  tamanhoBytes: number;
  sha256: string;
  variantes: Partial<Record<VarianteArquivo, VarianteArquivoInfo>>;
  criadoEm: string;
}
