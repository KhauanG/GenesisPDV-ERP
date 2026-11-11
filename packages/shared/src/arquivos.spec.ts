import { describe, expect, it } from 'vitest';
import {
  DESTINOS_ARQUIVO,
  detectarTipoArquivo,
  envioArquivoSchema,
  formatarTamanhoArquivo,
  mensagemArquivoGrande,
  mensagemTipoRecusado,
  rotuloTiposAceitos,
} from './arquivos.js';

const bytes = (...b: number[]) => Uint8Array.from(b);
const texto = (t: string) => new TextEncoder().encode(t);

describe('detectarTipoArquivo (magic bytes)', () => {
  it('reconhece PNG, JPEG, WebP e PDF pelo começo do conteúdo', () => {
    expect(detectarTipoArquivo(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe('png');
    expect(detectarTipoArquivo(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('jpeg');
    expect(detectarTipoArquivo(texto('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('webp');
    expect(detectarTipoArquivo(texto('%PDF-1.7\n'))).toBe('pdf');
  });

  it('recusa HTML, SVG, GIF, RIFF que não é WebP, texto e o começo pela metade', () => {
    expect(detectarTipoArquivo(texto('<!doctype html><html>'))).toBeNull();
    expect(detectarTipoArquivo(texto('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(detectarTipoArquivo(texto('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(detectarTipoArquivo(texto('GIF89a'))).toBeNull();
    expect(detectarTipoArquivo(texto('RIFF\u0000\u0000\u0000\u0000WAVEfmt '))).toBeNull();
    expect(detectarTipoArquivo(texto('MZ\u0090\u0000'))).toBeNull();
    expect(detectarTipoArquivo(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(detectarTipoArquivo(bytes(0xff, 0xd8))).toBeNull();
    expect(detectarTipoArquivo(bytes())).toBeNull();
    // Espaço antes do cabeçalho: não é o começo do arquivo.
    expect(detectarTipoArquivo(texto(' %PDF-1.7'))).toBeNull();
  });
});

describe('destinos', () => {
  it('nenhum destino do F2-B43 aceita PDF nem SVG; o logotipo tem 1 MB e os outros 2 MB', () => {
    for (const d of Object.values(DESTINOS_ARQUIVO)) {
      expect(d.tipos).toEqual(['png', 'jpeg', 'webp']);
      expect(d.variantes).toContain('pdv_256');
    }
    expect(DESTINOS_ARQUIVO.marca_logotipo.limiteBytes).toBe(1024 * 1024);
    expect(DESTINOS_ARQUIVO.loja_logotipo.limiteBytes).toBe(1024 * 1024);
    expect(DESTINOS_ARQUIVO.produto_foto.limiteBytes).toBe(2 * 1024 * 1024);
  });

  it('as mensagens dizem os tipos e o limite', () => {
    expect(rotuloTiposAceitos('produto_foto')).toBe('PNG, JPG ou WebP');
    expect(mensagemTipoRecusado('produto_foto')).toContain('PNG, JPG ou WebP');
    expect(mensagemArquivoGrande('produto_foto')).toContain('2 MB');
    expect(mensagemArquivoGrande('loja_logotipo')).toContain('1 MB');
    expect(formatarTamanhoArquivo(1536 * 1024)).toBe('1,5 MB');
    expect(formatarTamanhoArquivo(300)).toBe('1 KB');
  });

  it('o envio de loja exige a loja; os outros não a aceitam', () => {
    const loja = '01a18792-00de-7acc-9165-e21098543881';
    expect(envioArquivoSchema.safeParse({ destino: 'loja_foto', lojaId: loja }).success).toBe(true);
    expect(envioArquivoSchema.safeParse({ destino: 'loja_foto' }).success).toBe(false);
    expect(envioArquivoSchema.safeParse({ destino: 'produto_foto' }).success).toBe(true);
    expect(envioArquivoSchema.safeParse({ destino: 'produto_foto', lojaId: loja }).success).toBe(false);
    expect(envioArquivoSchema.safeParse({ destino: 'xml_nfce' }).success).toBe(false);
  });
});
