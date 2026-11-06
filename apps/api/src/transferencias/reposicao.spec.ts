import { LIMITE_ITENS_TRANSFERENCIA } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { ErroApi } from '../comum/erros.js';
import {
  calcularReposicao,
  limitarSugestao,
  validarSugestaoReposicao,
  type EntradaReposicao,
} from './reposicao.js';

const base: EntradaReposicao = {
  estoqueMinimo: '24',
  estoqueMaximo: '72',
  saldoDestino: '10',
  emTransito: '0',
  saldoOrigem: '1000',
  fatorEmbalagem: null,
  inteiro: true,
};
const conta = (e: Partial<EntradaReposicao>) => calcularReposicao({ ...base, ...e });

describe('calcularReposicao (F2-B25; ERP 13.7; F2-Q11 = D52): a sugestão de reposição de um produto', () => {
  it('critério de pronto: mínimo 24, máximo 72, saldo 10 e 12 em trânsito → 50, e 60 com o fardo de 12', () => {
    expect(conta({ emTransito: '12' })).toEqual({ falta: '50.000', quantidade: '50.000' });
    expect(conta({ emTransito: '12', fatorEmbalagem: '12' })).toEqual({
      falta: '50.000',
      quantidade: '60.000',
    });
  });

  it('nunca acima do saldo da origem (o negativo conta como zero)', () => {
    expect(conta({ emTransito: '12', fatorEmbalagem: '12', saldoOrigem: '55' }).quantidade).toBe('55.000');
    expect(conta({ emTransito: '12', fatorEmbalagem: '12', saldoOrigem: '0' })).toEqual({
      falta: '50.000',
      quantidade: '0.000',
    });
    expect(conta({ saldoOrigem: '-5' }).quantidade).toBe('0.000');
  });

  it('com máximo: máximo − saldo; sem máximo: mínimo × 2 − saldo', () => {
    expect(conta({})).toEqual({ falta: '62.000', quantidade: '62.000' });
    expect(conta({ estoqueMaximo: null })).toEqual({ falta: '38.000', quantidade: '38.000' });
    expect(conta({ estoqueMaximo: null, emTransito: '6' })).toEqual({
      falta: '32.000',
      quantidade: '32.000',
    });
    // O saldo negativo do destino (a venda do PDV sem estoque) aumenta a falta.
    expect(conta({ saldoDestino: '-4' }).quantidade).toBe('76.000');
  });

  it('só abaixo do mínimo, contando o em trânsito: no mínimo ou acima, nada', () => {
    expect(conta({ saldoDestino: '24' })).toEqual({ falta: '0.000', quantidade: '0.000' });
    expect(conta({ saldoDestino: '10', emTransito: '14' })).toEqual({ falta: '0.000', quantidade: '0.000' });
    expect(conta({ saldoDestino: '30' }).quantidade).toBe('0.000');
    expect(conta({ saldoDestino: '23.999', inteiro: false })).toEqual({
      falta: '48.001',
      quantidade: '48.001',
    });
  });

  it('arredonda para cima ao múltiplo do fator; o exato não muda; fator 1 (ou ausente) não arredonda', () => {
    expect(conta({ fatorEmbalagem: '12', saldoDestino: '0' }).quantidade).toBe('72.000');
    expect(conta({ fatorEmbalagem: '12', saldoDestino: '11' }).quantidade).toBe('72.000');
    expect(conta({ fatorEmbalagem: '6', saldoDestino: '11' }).quantidade).toBe('66.000');
    expect(conta({ fatorEmbalagem: '1', saldoDestino: '11' }).quantidade).toBe('61.000');
    // O arredondado acima do saldo da origem fica no saldo (sem fardo fechado, mas sem passar do que o CD tem).
    expect(conta({ fatorEmbalagem: '12', saldoDestino: '11', saldoOrigem: '70' }).quantidade).toBe('70.000');
  });

  it('produto fracionado: 3 casas (ADR-05), sem erro de ponto flutuante; sem fração: inteiro', () => {
    expect(
      conta({ estoqueMinimo: '0.3', estoqueMaximo: '0.7', saldoDestino: '0.1', inteiro: false }),
    ).toEqual({
      falta: '0.600',
      quantidade: '0.600',
    });
    expect(
      conta({
        estoqueMinimo: '0.3',
        estoqueMaximo: '0.7',
        saldoDestino: '0.1',
        saldoOrigem: '0.25',
        inteiro: false,
      }).quantidade,
    ).toBe('0.250');
    // Sem fração: a falta 61,5 sobe a 62, e o saldo de 40,5 na origem desce a 40.
    expect(conta({ saldoDestino: '10.5' }).quantidade).toBe('62.000');
    expect(conta({ saldoOrigem: '40.5' }).quantidade).toBe('40.000');
    expect(conta({ fatorEmbalagem: '2.5', saldoDestino: '10', inteiro: false }).quantidade).toBe('62.500');
  });
});

describe('limitarSugestao (F2-B25): os avisos e o corte no limite de itens', () => {
  it('sem produto sem saldo e dentro do limite: tudo, sem aviso', () => {
    expect(limitarSugestao(['a', 'b'], [])).toEqual({ itens: ['a', 'b'], avisos: [] });
  });

  it('o aviso no singular, no plural e com "e mais N" acima de 5 nomes', () => {
    expect(limitarSugestao([], ['Vinho']).avisos).toEqual([
      '1 produto abaixo do mínimo ficou de fora por não ter saldo na origem: Vinho.',
    ]);
    expect(limitarSugestao([], ['A', 'B', 'C', 'D', 'E']).avisos).toEqual([
      '5 produtos abaixo do mínimo ficaram de fora por não ter saldo na origem: A, B, C, D, E.',
    ]);
    expect(limitarSugestao([], ['A', 'B', 'C', 'D', 'E', 'F', 'G']).avisos).toEqual([
      '7 produtos abaixo do mínimo ficaram de fora por não ter saldo na origem: A, B, C, D, E e mais 2.',
    ]);
  });

  it(`acima de ${LIMITE_ITENS_TRANSFERENCIA} itens: ficam os primeiros, com aviso (e sem mexer na lista recebida)`, () => {
    const no = Array.from({ length: LIMITE_ITENS_TRANSFERENCIA }, (_, i) => i);
    expect(limitarSugestao(no, [])).toEqual({ itens: no, avisos: [] });
    const acima = Array.from({ length: LIMITE_ITENS_TRANSFERENCIA + 3 }, (_, i) => i);
    const r = limitarSugestao(acima, ['Vinho']);
    expect(r.itens).toEqual(no);
    expect(acima).toHaveLength(LIMITE_ITENS_TRANSFERENCIA + 3);
    expect(r.avisos).toEqual([
      '1 produto abaixo do mínimo ficou de fora por não ter saldo na origem: Vinho.',
      `A sugestão passou de ${LIMITE_ITENS_TRANSFERENCIA} itens, o limite por transferência: ficaram os ${LIMITE_ITENS_TRANSFERENCIA} primeiros por nome (3 ficaram de fora; faça outra transferência depois desta).`,
    ]);
  });
});

describe('validarSugestaoReposicao (F2-B25): os erros da query nos campos do rascunho', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const campos = (query: unknown): Record<string, string[]> => {
    try {
      validarSugestaoReposicao(query);
    } catch (e) {
      expect(e).toBeInstanceOf(ErroApi);
      expect((e as ErroApi).codigo).toBe('VALIDACAO');
      return (e as ErroApi).extras.campos ?? {};
    }
    throw new Error('era para recusar');
  };

  it('a query válida passa (o tipo vazio = o padrão)', () => {
    expect(validarSugestaoReposicao({ origem: A, destino: B, tipoEstoqueId: '' })).toEqual({
      origem: A,
      destino: B,
    });
  });

  it('origem e destino faltando ou malformados, e origem = destino, saem em estoqueOrigemId e estoqueDestinoId', () => {
    expect(Object.keys(campos({}))).toEqual(['estoqueOrigemId', 'estoqueDestinoId']);
    expect(campos({ origem: 'x', destino: B })).toEqual({ estoqueOrigemId: ['Escolha o estoque de origem'] });
    expect(campos({ origem: A, destino: 'x' })).toEqual({
      estoqueDestinoId: ['Escolha o estoque de destino'],
    });
    expect(campos({ origem: A, destino: A.toUpperCase() })).toEqual({
      estoqueDestinoId: ['O destino tem de ser diferente da origem'],
    });
    expect(Object.keys(campos({ origem: A, destino: B, tipoEstoqueId: 'x' }))).toEqual(['tipoEstoqueId']);
  });
});
