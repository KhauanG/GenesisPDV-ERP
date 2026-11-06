import { describe, expect, it } from 'vitest';
import { fluxosAfetados } from './fluxos-afetados.js';

const base = {
  estoqueId: '01a18753-5750-717c-87a0-ca6e0822e8f3',
  uf: 'SP',
  municipioIbge: 3550308,
  tipoEmissao: 'nao_fiscal',
};

describe('fluxosAfetados (MD 6.4 regra 3)', () => {
  it('nenhuma coluna estrutural mudou: nenhum fluxo', () => {
    expect(fluxosAfetados(base, { ...base })).toEqual([]);
  });

  it('estoque_id: estoque, catalogo e configuracao (a linha de estoques da loja)', () => {
    expect(fluxosAfetados(base, { ...base, estoqueId: '01a18753-0000-7000-8000-000000000001' })).toEqual([
      'estoque',
      'catalogo',
      'configuracao',
    ]);
  });

  it('UF ou município: referencia e catalogo', () => {
    expect(fluxosAfetados(base, { ...base, uf: 'PR', municipioIbge: 4106902 })).toEqual([
      'referencia',
      'catalogo',
    ]);
    expect(fluxosAfetados(base, { ...base, municipioIbge: 3509502 })).toEqual(['referencia', 'catalogo']);
  });

  it('tipo_emissao: configuracao (o certificado entra ou sai do filtro)', () => {
    expect(fluxosAfetados(base, { ...base, tipoEmissao: 'nfce' })).toEqual(['configuracao']);
  });

  it('várias mudanças juntas: cada fluxo uma vez', () => {
    expect(
      fluxosAfetados(base, {
        estoqueId: '01a18753-0000-7000-8000-000000000001',
        uf: 'PR',
        municipioIbge: 4106902,
        tipoEmissao: 'nfce',
      }),
    ).toEqual(['estoque', 'catalogo', 'configuracao', 'referencia']);
  });
});
