import { describe, expect, it } from 'vitest';
import {
  ajusteEstoqueRelatorioSchema,
  consultaEstoqueAtualSchema,
  filtrosEstoqueAtualSchema,
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
