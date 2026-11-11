import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { imagemTeste, pngBomba } from '../../test/fixtures/imagens.js';
import { chaveArquivo, chaveVariante } from '../infra/armazenamento.js';
import { nomeOriginalSeguro } from './arquivos.js';
import { ImagemRecusada, processarImagem } from './imagens.js';

describe('nomes e chaves do envio (F2-B43)', () => {
  it('o nome do cliente perde as pastas e os caracteres de controle', () => {
    expect(nomeOriginalSeguro('../../etc/passwd')).toBe('passwd');
    expect(nomeOriginalSeguro('C:\\fotos\\garrafa\u0007.jpg')).toBe('garrafa.jpg');
    expect(nomeOriginalSeguro('   ')).toBe('arquivo');
    expect(nomeOriginalSeguro('a'.repeat(400))).toHaveLength(255);
  });

  it('a chave da variante fica ao lado da do original, gerada pelo servidor', () => {
    const chave = chaveArquivo(12, 'foto_produto', 'jpg', new Date('2026-11-11T12:00:00Z'));
    expect(chave).toMatch(/^emp\/12\/foto_produto\/2026\/11\/[0-9a-f-]{36}\.jpg$/);
    expect(chaveVariante(chave, 'pdv_256', 'webp')).toBe(chave.replace(/\.jpg$/, '.pdv_256.webp'));
    expect(chaveVariante('emp/1/x/a.png', '../pdv', '../webp')).toBe('emp/1/x/a.pdv.webp');
  });
});

describe('processarImagem', () => {
  it('gera a pdv_256 em WebP sem ampliar, com a orientação do EXIF aplicada', async () => {
    const r = await processarImagem(await imagemTeste(1000, 500, 'png'), 'png', ['pdv_256']);
    expect([r.largura, r.altura]).toEqual([1000, 500]);
    expect(r.variantes.pdv_256).toMatchObject({ tipoMime: 'image/webp', largura: 256, altura: 128 });
    // JPEG de 400 × 200 marcado com a orientação 6 (girar 90°): a variante sai em pé, 128 × 256.
    const deitada = await sharp(await imagemTeste(400, 200, 'jpeg'))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const g = await processarImagem(deitada, 'jpeg', ['pdv_256']);
    expect(g.variantes.pdv_256).toMatchObject({ largura: 128, altura: 256 });
    const pequena = await processarImagem(await imagemTeste(40, 30, 'webp'), 'webp', ['pdv_256']);
    expect(pequena.variantes.pdv_256).toMatchObject({ largura: 40, altura: 30 });
  });

  it('recusa a bomba pelo cabeçalho, o formato trocado e o conteúdo que não decodifica', async () => {
    await expect(processarImagem(pngBomba(), 'png', ['pdv_256'])).rejects.toMatchObject({ motivo: 'pixels' });
    const png = await imagemTeste(20, 20, 'png');
    // O começo diz JPEG, o conteúdo é PNG: o formato que o libvips vê precisa ser o detectado.
    await expect(processarImagem(png, 'jpeg', ['pdv_256'])).rejects.toBeInstanceOf(ImagemRecusada);
    await expect(processarImagem(png.subarray(0, 60), 'png', ['pdv_256'])).rejects.toMatchObject({
      motivo: 'invalida',
    });
  });

  it('o SVG não decodifica nem chamando o sharp direto (leitores bloqueados no processo)', async () => {
    await expect(
      sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')).png().toBuffer(),
    ).rejects.toThrow();
  });
});
