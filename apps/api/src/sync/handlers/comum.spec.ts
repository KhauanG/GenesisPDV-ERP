/**
 * Auxiliares comuns dos handlers (bloco C5 da 1C): a comparação de conteúdo da camada 2 da idempotência (SYNC 8.4),
 * que recebe a linha como o Drizzle devolve (Date, decimal em texto, `jsonb` sem ordem de chaves), e o escopo das
 * linhas do payload (SYNC 11.2 `ESCOPO_INVALIDO`).
 */
import { describe, expect, it } from 'vitest';
import { colunasDivergentes, conferirEscopoLinha } from './comum.js';

const terminal = { terminalId: 't', lojaId: 'l', caixaId: 'c', numeroCaixa: 2, ip: null };

describe('colunasDivergentes', () => {
  it('compara datas pelo instante, decimais pelo valor, nulo com ausente e jsonb na forma canônica', () => {
    const gravada = {
      abertaEm: new Date('2026-10-31T10:00:00.000Z'),
      fundoTroco: '150.00',
      sessaoAnteriorId: null,
      resumo: { b: 1, a: { y: 2, x: 1 } },
      status: 'fechada',
    };
    expect(
      colunasDivergentes(
        gravada,
        {
          abertaEm: new Date('2026-10-31T07:00:00-03:00'),
          fundoTroco: '150.0',
          sessaoAnteriorId: undefined,
          resumo: { a: { x: 1, y: 2 }, b: 1 },
          status: 'aberta',
        },
        ['status'],
      ),
    ).toEqual([]);
    expect(
      colunasDivergentes(gravada, {
        abertaEm: new Date('2026-10-31T10:00:01.000Z'),
        fundoTroco: '150.01',
        resumo: { a: { x: 1, y: 3 }, b: 1 },
      }),
    ).toEqual(['abertaEm', 'fundoTroco', 'resumo']);
  });

  it('texto só de dígitos não vira número: só o decimal com escala compara pelo valor', () => {
    expect(colunasDivergentes({ infAdicionais: '04471' }, { infAdicionais: '4471' })).toEqual([
      'infAdicionais',
    ]);
    expect(colunasDivergentes({ valor: '-1.50' }, { valor: '-1.5' })).toEqual([]);
  });
});

describe('conferirEscopoLinha', () => {
  it('aceita a linha do terminal dono e aponta as colunas de outro', () => {
    expect(() =>
      conferirEscopoLinha(
        { loja_id: 'l', caixa_id: 'c', numero_caixa: 2, terminal_id: 't' },
        terminal,
        'sessoes_caixa',
      ),
    ).not.toThrow();
    expect(() =>
      conferirEscopoLinha({ loja_id: 'l', caixa_id: 'x', numero_caixa: 3 }, terminal, 'movimentos_caixa'),
    ).toThrow(
      expect.objectContaining({
        codigo: 'ESCOPO_INVALIDO',
        detalhes: { tabela: 'movimentos_caixa', colunas: ['caixa_id', 'numero_caixa'] },
      }),
    );
  });
});
