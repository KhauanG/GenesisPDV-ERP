import { describe, expect, it } from 'vitest';
import { caminhoDecodificado, caminhoSemDesvio, codigoEmpresaValido, idValido, segmento } from './caminho';

const ID = '0193bbbb-0000-7000-8000-000000000002';

describe('ids de rota e caminhos da API (README do ERP › decisão 85)', () => {
  it('id de registro é um UUID num segmento só', () => {
    expect(idValido(ID)).toBe(true);
    expect(idValido(ID.toUpperCase())).toBe(true);
    for (const invalido of [
      undefined,
      null,
      '',
      'nao-e-uuid',
      `../usuarios/${ID}`,
      `${ID}/`,
      ` ${ID}`,
      `${ID}?x=1`,
      `${ID}x`,
      '..',
      '.',
    ]) {
      expect(idValido(invalido), String(invalido)).toBe(false);
    }
  });

  it('código da empresa do painel: 6 dígitos', () => {
    expect(codigoEmpresaValido('100001')).toBe(true);
    for (const invalido of [undefined, '', '10000', '1000011', '10000a', '../planos', '１00001']) {
      expect(codigoEmpresaValido(invalido), String(invalido)).toBe(false);
    }
  });

  it('segmento codifica separadores, consulta e fragmento', () => {
    expect(segmento(ID)).toBe(ID);
    expect(segmento(100001)).toBe('100001');
    expect(segmento(`../usuarios/${ID}`)).toBe(`..%2Fusuarios%2F${ID}`);
    expect(segmento('a?b#c%d')).toBe('a%3Fb%23c%25d');
  });

  it('caminho sem segmento de ponto, barra invertida nem separador codificado', () => {
    for (const ok of [
      '/perfis',
      `/perfis/${ID}`,
      `/perfis/${ID}/duplicar`,
      '/produtos.json',
      '/a/.oculto/b',
      '/a/...',
      '/marcas?busca=..%2F..%5Cx&b=.',
      '/marcas#..',
      '/marcas?busca=a b\t',
    ]) {
      expect(caminhoSemDesvio(ok), ok).toBe(true);
    }
    for (const desvio of [
      `/perfis/../usuarios/${ID}`,
      '/perfis/./x',
      '/perfis/..',
      '/perfis/.',
      `/perfis/%2e%2E/usuarios/${ID}`,
      `/perfis/.%2e/usuarios/${ID}`,
      `/perfis/%2E./usuarios/${ID}`,
      '/perfis/%2e/x',
      `/perfis/..%2Fusuarios%2F${ID}`,
      `/perfis/x%2fy`,
      `/perfis/x%5Cy`,
      `/perfis\\..\\usuarios\\${ID}`,
      `/perfis/..?x=1`,
      // O leitor de endereço do navegador apaga TAB/LF/CR em qualquer posição e o controle/espaço nas pontas.
      `/perfis/.\t./usuarios/${ID}`,
      '/perfis/%2e\n%2e/x',
      '/perfis/.\r./x',
      '/\t/exemplo.invalido',
      '/\tsair',
      '/sair ',
      '/a\u0000b',
      '/a\u007fb',
    ]) {
      expect(caminhoSemDesvio(desvio), desvio).toBe(false);
    }
  });

  it('caminho decodificado por segmento, como o roteador lê para escolher a rota', () => {
    expect(caminhoDecodificado('/%70lataforma/empresas?x=%2F#y')).toBe('/plataforma/empresas');
    expect(caminhoDecodificado('/%73air')).toBe('/sair');
    expect(caminhoDecodificado(`/perfis/${ID}`)).toBe(`/perfis/${ID}`);
    expect(caminhoDecodificado('/%2570lataforma')).toBe('/%70lataforma');
    for (const invalido of ['/%', '/%zz', '/%E0%A4%A']) {
      expect(caminhoDecodificado(invalido), invalido).toBeNull();
    }
  });
});
