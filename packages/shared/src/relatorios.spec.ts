import { describe, expect, it } from 'vitest';
import {
  ajusteEstoqueRelatorioSchema,
  consultaEanDuplicadoSchema,
  consultaEstoqueAtualSchema,
  consultaMovimentacaoEstoqueSchema,
  consultaMovimentacaoSinteticaSchema,
  exportacaoMovimentacaoEstoqueSchema,
  filtrosEanDuplicadoSchema,
  filtrosEstoqueAtualSchema,
  filtrosMovimentacaoEstoqueSchema,
} from './relatorios.js';

const ID = '0190a000-0000-7000-8000-000000000401';

describe('filtros do Estoque Atual (ERP 16.4; F2-B31)', () => {
  it('vazio ou "todas" no estoque é o "Todas"; os padrões da tela', () => {
    expect(filtrosEstoqueAtualSchema.parse({ estoqueId: 'todas' })).toEqual({
      situacaoSaldo: 'todos',
      situacao: 'ativos',
      treino: 'excluir',
    });
    expect(
      filtrosEstoqueAtualSchema.parse({ estoqueId: '', marcaId: '', dataBase: '' }).estoqueId,
    ).toBeUndefined();
    expect(filtrosEstoqueAtualSchema.parse({ estoqueId: ID }).estoqueId).toBe(ID);
  });

  it('o "Vencendo" é um inteiro de 0 a 3650 dias e não combina com a data-base', () => {
    expect(filtrosEstoqueAtualSchema.parse({ vencendoEmDias: '30' }).vencendoEmDias).toBe(30);
    expect(filtrosEstoqueAtualSchema.safeParse({ vencendoEmDias: '-1' }).success).toBe(false);
    expect(filtrosEstoqueAtualSchema.safeParse({ vencendoEmDias: '2,5' }).success).toBe(false);
    const junto = filtrosEstoqueAtualSchema.safeParse({ vencendoEmDias: '7', dataBase: '2026-11-06' });
    expect(junto.success).toBe(false);
    expect(junto.error!.issues.map((i) => i.path.join('.'))).toEqual(['vencendoEmDias']);
  });

  it('a data-base é uma data de calendário; a página segue o padrão das listagens', () => {
    expect(filtrosEstoqueAtualSchema.safeParse({ dataBase: '2026-02-31' }).success).toBe(false);
    expect(consultaEstoqueAtualSchema.parse({ dataBase: '2026-11-06', tamanho: '20' })).toMatchObject({
      dataBase: '2026-11-06',
      pagina: 1,
      tamanho: 20,
    });
    expect(consultaEstoqueAtualSchema.safeParse({ ordenar: 'produto;drop' }).success).toBe(false);
  });

  it('o ajuste é o do produto com o produto da linha', () => {
    const ok = ajusteEstoqueRelatorioSchema.parse({
      produtoId: ID,
      estoqueId: ID,
      quantidade: '12,5',
      motivo: 'Inventário',
    });
    expect(ok).toMatchObject({ produtoId: ID, quantidade: '12.500', tipoEstoqueId: null });
    expect(
      ajusteEstoqueRelatorioSchema.safeParse({ estoqueId: ID, quantidade: '1', motivo: 'x' }).success,
    ).toBe(false);
  });
});

describe('filtros da Movimentação de Estoque (ERP 16.5; F2-B32)', () => {
  const base = { estoqueId: ID, dataInicial: '2026-11-01', dataFinal: '2026-11-07' };
  const erros = (v: Record<string, unknown>) => {
    const r = consultaMovimentacaoEstoqueSchema.safeParse(v);
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };

  it('local e período obrigatórios; a página padrão é de 50, sem cursor', () => {
    expect(consultaMovimentacaoEstoqueSchema.parse(base)).toEqual({ ...base, tamanho: 50 });
    expect(erros({ dataInicial: '2026-11-01', dataFinal: '2026-11-07' })).toEqual(['estoqueId']);
    expect(erros({ estoqueId: ID, dataInicial: '', dataFinal: '2026-11-07' })).toEqual(['dataInicial']);
    expect(erros({ ...base, tamanho: '1000' })).toEqual(['tamanho']);
    expect(consultaMovimentacaoEstoqueSchema.parse({ ...base, tamanho: '20', cursor: 'abc' })).toMatchObject({
      tamanho: 20,
      cursor: 'abc',
    });
  });

  it('o período vai até 366 dias contando as pontas, e o final não vem antes do inicial', () => {
    expect(erros({ ...base, dataInicial: '2025-11-07', dataFinal: '2026-11-07' })).toEqual([]);
    expect(erros({ ...base, dataInicial: '2025-11-06', dataFinal: '2026-11-07' })).toEqual(['dataFinal']);
    // 2028 é bissexto: de 01/01 a 31/12 são 366 dias.
    expect(erros({ ...base, dataInicial: '2028-01-01', dataFinal: '2028-12-31' })).toEqual([]);
    expect(erros({ ...base, dataInicial: '2026-11-08' })).toEqual(['dataFinal']);
    expect(erros({ ...base, dataFinal: '2026-02-30' })).toEqual(['dataFinal']);
  });

  it('tipos de movimento em vírgulas ou repetidos, sem vazios nem repetição', () => {
    expect(
      filtrosMovimentacaoEstoqueSchema.parse({ ...base, tiposMovimento: 'RECEB_NFE, VENDA_PDV,,RECEB_NFE' }),
    ).toMatchObject({ tiposMovimento: ['RECEB_NFE', 'VENDA_PDV'] });
    expect(
      filtrosMovimentacaoEstoqueSchema.parse({ ...base, tiposMovimento: ['RECEB_NFE', 'ACERTO_SAIDA'] })
        .tiposMovimento,
    ).toEqual(['RECEB_NFE', 'ACERTO_SAIDA']);
    expect(
      filtrosMovimentacaoEstoqueSchema.parse({ ...base, tiposMovimento: '' }).tiposMovimento,
    ).toBeUndefined();
    expect(erros({ ...base, tiposMovimento: "VENDA'; drop" })).toEqual(['tiposMovimento.0']);
  });

  it('o número do documento pede o tipo, e só os tipos com número', () => {
    expect(erros({ ...base, documentoTipo: 'venda', documentoNumero: '1-0042' })).toEqual([]);
    expect(erros({ ...base, documentoNumero: '42' })).toEqual(['documentoTipo']);
    expect(erros({ ...base, documentoTipo: 'vasilhame', documentoNumero: '42' })).toEqual([
      'documentoNumero',
    ]);
    expect(erros({ ...base, documentoTipo: 'vasilhame' })).toEqual([]);
    expect(erros({ ...base, documentoTipo: 'outro' })).toEqual(['documentoTipo']);
  });
});

describe('Movimentação sintética e exportação (ERP 16.5; F2-B33)', () => {
  const base = { estoqueId: ID, dataInicial: '2026-11-01', dataFinal: '2026-11-07' };

  it('a sintética pagina por página (padrão 1 e 50), com as mesmas regras de período', () => {
    expect(consultaMovimentacaoSinteticaSchema.parse(base)).toEqual({ ...base, pagina: 1, tamanho: 50 });
    expect(consultaMovimentacaoSinteticaSchema.parse({ ...base, pagina: '3', tamanho: '20' })).toMatchObject({
      pagina: 3,
      tamanho: 20,
    });
    expect(consultaMovimentacaoSinteticaSchema.safeParse({ ...base, pagina: '0' }).success).toBe(false);
    expect(consultaMovimentacaoSinteticaSchema.safeParse({ ...base, tamanho: 'todos' }).success).toBe(false);
    expect(
      consultaMovimentacaoSinteticaSchema.safeParse({ ...base, dataInicial: '2025-11-06' }).success,
    ).toBe(false);
  });

  it('a exportação leva a visão (padrão: a analítica) e aceita a própria entrada crua da tarefa', () => {
    expect(exportacaoMovimentacaoEstoqueSchema.parse(base).visao).toBe('analitica');
    expect(exportacaoMovimentacaoEstoqueSchema.parse({ ...base, visao: '' }).visao).toBe('analitica');
    const entrada = { ...base, visao: 'sintetica', tiposMovimento: 'RECEB_NFE,RECEB_MANUAL' };
    const f = exportacaoMovimentacaoEstoqueSchema.parse(entrada);
    expect(f).toMatchObject({ visao: 'sintetica', tiposMovimento: ['RECEB_NFE', 'RECEB_MANUAL'] });
    expect(exportacaoMovimentacaoEstoqueSchema.parse(JSON.parse(JSON.stringify(entrada)))).toEqual(f);
    expect(exportacaoMovimentacaoEstoqueSchema.safeParse({ ...base, visao: 'diaria' }).success).toBe(false);
  });
});

describe('filtros do EAN duplicado (MD 3.6.5; F2-B38)', () => {
  it('vazio é sem filtro; o começo do EAN só com dígitos (até 14); a página padrão 50', () => {
    expect(filtrosEanDuplicadoSchema.parse({ ean: '', nome: '' })).toEqual({});
    expect(filtrosEanDuplicadoSchema.parse({ ean: ' 7891 ', nome: ' heineken ' })).toEqual({
      ean: '7891',
      nome: 'heineken',
    });
    expect(filtrosEanDuplicadoSchema.safeParse({ ean: '789-1' }).success).toBe(false);
    expect(filtrosEanDuplicadoSchema.safeParse({ ean: '1'.repeat(15) }).success).toBe(false);
    expect(consultaEanDuplicadoSchema.parse({})).toEqual({ pagina: 1, tamanho: 50 });
    expect(consultaEanDuplicadoSchema.parse({ pagina: '2', tamanho: '20' })).toMatchObject({
      pagina: 2,
      tamanho: 20,
    });
    expect(consultaEanDuplicadoSchema.safeParse({ tamanho: 'todos' }).success).toBe(false);
  });
});
