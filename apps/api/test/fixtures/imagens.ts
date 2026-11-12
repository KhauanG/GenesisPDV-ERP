/**
 * Imagens inventadas para os testes do envio de arquivos (F2-B43): geradas na hora com o sharp (cores lisas e um
 * degradê), nunca foto real (o repositório é público). Também o PNG "bomba de descompressão": só o cabeçalho de uma
 * imagem de 50.000 × 50.000 pixels com algumas linhas comprimidas, uns poucos KB que declarariam 2,5 bilhões de pixels.
 */
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';

/** Uma imagem `largura × altura` no formato pedido, com um degradê (para não comprimir a quase nada). */
export async function imagemTeste(
  largura: number,
  altura: number,
  formato: 'png' | 'jpeg' | 'webp' = 'png',
): Promise<Buffer> {
  const bruto = Buffer.alloc(largura * altura * 3);
  for (let y = 0; y < altura; y++)
    for (let x = 0; x < largura; x++) {
      const i = (y * largura + x) * 3;
      bruto[i] = (x * 255) / largura;
      bruto[i + 1] = (y * 255) / altura;
      bruto[i + 2] = 128;
    }
  return sharp(bruto, { raw: { width: largura, height: altura, channels: 3 } })
    .toFormat(formato)
    .toBuffer();
}

function pedacoPng(tipo: string, dados: Buffer): Buffer {
  const t = Buffer.from(tipo, 'ascii');
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, dados])));
  return Buffer.concat([tamanho, t, dados, crc]);
}

/** PNG válido no cabeçalho que declara `largura × altura` pixels (cinza de 8 bits), com poucas linhas de verdade. */
export function pngBomba(largura = 50_000, altura = 50_000): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // profundidade
  ihdr[9] = 0; // cinza
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pedacoPng('IHDR', ihdr),
    pedacoPng('IDAT', deflateSync(Buffer.alloc((largura + 1) * 16))),
    pedacoPng('IEND', Buffer.alloc(0)),
  ]);
}
