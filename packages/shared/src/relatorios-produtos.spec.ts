import { describe, expect, it } from 'vitest';
import {
  consultaHistoricoProdutosSchema,
  consultaNcmInvalidosSchema,
  consultaProdutosGeralSchema,
  definirNcmLoteSchema,
  detalheHistoricoProdutoSchema,
  filtrosProdutosGeralSchema,
  LIMITE_DEFINIR_NCM,
  MAXIMO_DIAS_HISTORICO_PRODUTOS,
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

describe('filtros do Histórico de produtos (ERP 16.2; F2-B42)', () => {
  it('o período é obrigatório (a auditoria é particionada por mês); vazio = sem filtro', () => {
    expect(consultaHistoricoProdutosSchema.safeParse({}).success).toBe(false);
    expect(consultaHistoricoProdutosSchema.safeParse({ dataInicial: '2026-11-01' }).success).toBe(false);
    expect(
      consultaHistoricoProdutosSchema.parse({
        dataInicial: '2026-11-01',
        dataFinal: '2026-11-30',
        texto: '   ',
        usuarioId: '',
        tipo: '',
        produtoId: '',
      }),
    ).toEqual({ dataInicial: '2026-11-01', dataFinal: '2026-11-30', pagina: 1, tamanho: 50 });
  });

  it('a data final não vem antes da inicial, e o período vai até o teto (contando as pontas)', () => {
    const r = consultaHistoricoProdutosSchema.safeParse({
      dataInicial: '2026-11-02',
      dataFinal: '2026-11-01',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('A data final é anterior à inicial');
    expect(MAXIMO_DIAS_HISTORICO_PRODUTOS).toBe(366);
    expect(
      consultaHistoricoProdutosSchema.safeParse({ dataInicial: '2026-01-01', dataFinal: '2027-01-01' })
        .success,
    ).toBe(true);
    expect(
      consultaHistoricoProdutosSchema.safeParse({ dataInicial: '2026-01-01', dataFinal: '2027-01-02' })
        .success,
    ).toBe(false);
    expect(
      consultaHistoricoProdutosSchema.safeParse({ dataInicial: '2026-02-30', dataFinal: '2026-03-01' })
        .success,
    ).toBe(false);
  });

  it('o tipo da legenda (G/E/R/I), o usuário e o produto em UUID', () => {
    const base = { dataInicial: '2026-11-01', dataFinal: '2026-11-01' };
    expect(consultaHistoricoProdutosSchema.parse({ ...base, tipo: 'I' }).tipo).toBe('I');
    expect(consultaHistoricoProdutosSchema.safeParse({ ...base, tipo: 'X' }).success).toBe(false);
    expect(consultaHistoricoProdutosSchema.safeParse({ ...base, produtoId: '12' }).success).toBe(false);
    expect(consultaHistoricoProdutosSchema.parse({ ...base, usuarioId: id(1) }).usuarioId).toBe(id(1));
    expect(detalheHistoricoProdutoSchema.safeParse({ ocorridoEm: '2026-11-03T17:02:00.123Z' }).success).toBe(
      true,
    );
    expect(detalheHistoricoProdutoSchema.safeParse({ ocorridoEm: '2026-11-03' }).success).toBe(false);
  });
});
