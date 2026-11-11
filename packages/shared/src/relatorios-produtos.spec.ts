import { describe, expect, it } from 'vitest';
import {
  consultaNcmInvalidosSchema,
  consultaProdutosGeralSchema,
  definirNcmLoteSchema,
  filtrosProdutosGeralSchema,
  LIMITE_DEFINIR_NCM,
} from './relatorios-produtos.js';

const id = (n: number) => `0190a000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;

describe('filtros do Produtos geral (ERP 16.1; F2-B41)', () => {
  it('os padrões da tela: ativos, com preço ou sem, sem loja; vazio = sem filtro', () => {
    expect(filtrosProdutosGeralSchema.parse({ marcaId: '', lojaId: '', semPreco: '' })).toEqual({
      semPreco: false,
      situacao: 'ativos',
    });
    expect(filtrosProdutosGeralSchema.parse({ semPreco: 'true', situacao: 'todos' })).toMatchObject({
      semPreco: true,
      situacao: 'todos',
    });
    expect(filtrosProdutosGeralSchema.safeParse({ semPreco: 'talvez' }).success).toBe(false);
  });

  it('a ordenação só pelos campos conhecidos; a página com os tamanhos da tela', () => {
    expect(filtrosProdutosGeralSchema.parse({ ordenar: 'markup_pct:desc' }).ordenar).toBe('markup_pct:desc');
    expect(filtrosProdutosGeralSchema.safeParse({ ordenar: 'busca:asc' }).success).toBe(false);
    expect(consultaProdutosGeralSchema.parse({})).toMatchObject({ pagina: 1, tamanho: 50 });
    expect(consultaProdutosGeralSchema.safeParse({ tamanho: '1000' }).success).toBe(false);
    expect(consultaNcmInvalidosSchema.parse({ pagina: '2', tamanho: '20' })).toEqual({
      pagina: 2,
      tamanho: 20,
    });
  });
});

describe('"Definir NCM" em lote (ERP 16.3; F2-B41)', () => {
  it('o NCM com 8 dígitos e os produtos com a versão, sem repetir, até o teto', () => {
    expect(
      definirNcmLoteSchema.parse({ ncm: '22030000', produtos: [{ id: id(1), versao: '7' }] }).produtos,
    ).toEqual([{ id: id(1), versao: 7 }]);
    expect(
      definirNcmLoteSchema.safeParse({ ncm: '2203.00.00', produtos: [{ id: id(1), versao: 1 }] }).success,
    ).toBe(false);
    expect(definirNcmLoteSchema.safeParse({ ncm: '22030000', produtos: [] }).success).toBe(false);
    expect(
      definirNcmLoteSchema.safeParse({
        ncm: '22030000',
        produtos: [
          { id: id(1), versao: 1 },
          { id: id(1).toUpperCase(), versao: 1 },
        ],
      }).success,
    ).toBe(false);
    const muitos = Array.from({ length: LIMITE_DEFINIR_NCM + 1 }, (_, i) => ({ id: id(i), versao: 1 }));
    expect(definirNcmLoteSchema.safeParse({ ncm: '22030000', produtos: muitos }).success).toBe(false);
    expect(
      definirNcmLoteSchema.safeParse({ ncm: '22030000', produtos: muitos.slice(0, LIMITE_DEFINIR_NCM) })
        .success,
    ).toBe(true);
  });
});
