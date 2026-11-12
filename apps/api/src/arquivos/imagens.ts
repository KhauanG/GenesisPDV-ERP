/**
 * Conferência e variantes das imagens enviadas (F2-B43; SYNC 6.12; README da API › decisão 189), com o `sharp`
 * (libvips). A imagem é **decodificada de verdade** (o começo certo não basta: um PNG truncado ou um HTML com o
 * cabeçalho de PNG não passa) e a `pdv_256` sai em WebP de até 256 px no maior lado.
 *
 * O que protege o processo, que é de todas as empresas:
 * - **semáforo de concorrência 1** (`IMAGENS_CONCORRENCIA`, como o argon2 e a planilha da decisão 93) e uma thread
 *   do libvips por imagem (`sharp.concurrency(1)`), sem cache de operações (`sharp.cache(false)`): uma imagem por vez,
 *   com a memória dela só;
 * - **limite de pixels** antes de decodificar (`IMAGENS_LIMITE_PIXELS`, 36 MP): um PNG de 2 MB pode declarar
 *   100.000 × 100.000 pixels (a bomba de descompressão); o cabeçalho é lido primeiro (`metadata`, sem decodificar) e o
 *   `limitInputPixels` do sharp é a segunda barreira;
 * - **só os leitores de PNG, JPEG e WebP em memória** (`sharp.block`/`unblock`): SVG, TIFF, PDF, HEIF, GIF e os
 *   leitores de arquivo do libvips ficam bloqueados no processo inteiro, mesmo que um dia alguém chame o sharp com
 *   outra entrada.
 */
import sharp, { type Metadata } from 'sharp';
import { LADO_VARIANTE_PDV, type TipoArquivo, type VarianteArquivo } from '@genesis/shared';
import { limiteDoAmbiente, Semaforo } from '../comum/limites-processo.js';

sharp.concurrency(1);
sharp.cache(false);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: ['VipsForeignLoadPngBuffer', 'VipsForeignLoadJpegBuffer', 'VipsForeignLoadWebpBuffer'],
});

const semaforo = new Semaforo(limiteDoAmbiente('IMAGENS_CONCORRENCIA', 1));

/** Pixels de entrada aceitos (largura × altura): 36 MP cobre a foto do celular (12 a 24 MP) com folga. */
export const limitePixelsImagem = () => limiteDoAmbiente('IMAGENS_LIMITE_PIXELS', 36_000_000);

/** O formato que o libvips reconhece em cada tipo detectado pelos magic bytes. */
const FORMATO_SHARP: Partial<Record<TipoArquivo, string>> = { png: 'png', jpeg: 'jpeg', webp: 'webp' };

const MENSAGEM_INVALIDA = 'Não foi possível ler a imagem: o arquivo está corrompido ou não é uma imagem.';

export class ImagemRecusada extends Error {
  constructor(
    readonly motivo: 'invalida' | 'pixels',
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'ImagemRecusada';
  }
}

export interface VarianteGerada {
  conteudo: Buffer;
  tipoMime: string;
  extensao: string;
  largura: number;
  altura: number;
}

export interface ImagemProcessada {
  largura: number;
  altura: number;
  variantes: Partial<Record<VarianteArquivo, VarianteGerada>>;
}

/**
 * Confere a imagem e gera as variantes pedidas (hoje só a `pdv_256`), uma imagem por vez no processo. A orientação
 * do EXIF é aplicada na variante (a foto do celular sai em pé); a variante não leva metadados (o EXIF, com o GPS, fica
 * só no original).
 */
export function processarImagem(
  conteudo: Buffer,
  tipo: TipoArquivo,
  variantes: readonly VarianteArquivo[],
): Promise<ImagemProcessada> {
  return semaforo.executar(async () => {
    const limite = limitePixelsImagem();
    const opcoes = { limitInputPixels: limite, failOn: 'error' as const };
    let meta: Metadata;
    try {
      // Só o cabeçalho (nada é decodificado): sem o limite aqui, para a mensagem dizer o tamanho da imagem recusada.
      meta = await sharp(conteudo, { ...opcoes, limitInputPixels: false }).metadata();
    } catch {
      throw new ImagemRecusada('invalida', MENSAGEM_INVALIDA);
    }
    if (meta.format !== FORMATO_SHARP[tipo] || !meta.width || !meta.height)
      throw new ImagemRecusada('invalida', MENSAGEM_INVALIDA);
    const paginas = meta.pages ?? 1;
    if (meta.width * meta.height > limite || paginas > 1)
      throw new ImagemRecusada(
        'pixels',
        `A imagem tem ${meta.width} × ${meta.height} pixels${paginas > 1 ? ' e várias páginas (animação)' : ''}: ` +
          `envie uma imagem simples de até ${Math.floor(limite / 1_000_000)} megapixels.`,
      );
    const geradas: ImagemProcessada['variantes'] = {};
    for (const v of variantes) {
      if (v !== 'pdv_256') continue;
      try {
        const { data, info } = await sharp(conteudo, opcoes)
          .autoOrient()
          .resize(LADO_VARIANTE_PDV, LADO_VARIANTE_PDV, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        geradas.pdv_256 = {
          conteudo: data,
          tipoMime: 'image/webp',
          extensao: 'webp',
          largura: info.width,
          altura: info.height,
        };
      } catch {
        throw new ImagemRecusada('invalida', MENSAGEM_INVALIDA);
      }
    }
    return { largura: meta.width, altura: meta.height, variantes: geradas };
  });
}
