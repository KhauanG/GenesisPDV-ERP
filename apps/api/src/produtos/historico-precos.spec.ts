import { ORIGENS_HISTORICO_PRECO, TIPOS_PRECO_HISTORICO } from '@genesis/shared';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  produtosHistoricoPrecos,
  TIPOS_PRECO_HISTORICO as TIPOS_DO_SCHEMA,
} from '../database/empresa/schema/index.js';
import { linhasHistoricoFilhos, type PrecosFilhos } from './gravacao.js';

/**
 * A origem do histórico de preços (MD 3.6.10): `ORIGENS_HISTORICO_PRECO` do shared × o CHECK da tabela no schema
 * Drizzle (o que o drizzle-kit leva à migração). `ck_produtos_historico_precos_origem` foi escrito à mão antes de
 * existir a constante (F2-B15): uma origem nova só no shared passaria no typecheck e daria 23514 no INSERT (o schema
 * sem mudança não gera migração). Origem nova: nos dois lados, com a migração do CHECK. O tipo de preço também
 * (F2-B37: o contrato da consulta usa `TIPOS_PRECO_HISTORICO` do shared; o CHECK sai da lista do schema).
 */
const dialeto = new PgDialect();

function valoresDoCheck(nome: string): string[] {
  const check = getTableConfig(produtosHistoricoPrecos).checks.find((c) => c.name === nome);
  expect(check, nome).toBeDefined();
  const { sql } = dialeto.sqlToQuery(check!.value);
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

describe('CHECK da origem do histórico de preços × shared', () => {
  it('ck_produtos_historico_precos_origem aceita exatamente ORIGENS_HISTORICO_PRECO', () => {
    expect(valoresDoCheck('ck_produtos_historico_precos_origem')).toEqual(
      [...ORIGENS_HISTORICO_PRECO].sort(),
    );
  });

  it('ck_produtos_historico_precos_tipo_preco aceita exatamente TIPOS_PRECO_HISTORICO do shared', () => {
    expect([...TIPOS_DO_SCHEMA]).toEqual([...TIPOS_PRECO_HISTORICO]);
    expect(valoresDoCheck('ck_produtos_historico_precos_tipo_preco')).toEqual(
      [...TIPOS_PRECO_HISTORICO].sort(),
    );
  });
});

describe('histórico das filhas (F2-B37): faixas e variações', () => {
  const P = '0190a000-0000-7000-8000-0000000000c1';
  const U = '0190a000-0000-7000-8000-0000000000a1';
  const V = '0190a000-0000-7000-8000-0000000000d1';
  const L = '0190a000-0000-7000-8000-0000000000f1';
  type Faixa = { id: string; qi: string; qf: string | null; preco: string; variacao?: string; loja?: string };
  /** As faixas com a chave de `precosFilhosGravados` (`variacao|loja|qi|qf`), da variação e da loja quando há. */
  const filhos = (
    faixas: Faixa[],
    variacoes: Array<[string, string | null, string | null]> = [],
  ): PrecosFilhos => ({
    faixas: new Map(
      faixas.map((f) => [
        `${f.variacao ?? ''}|${f.loja ?? ''}|${f.qi}|${f.qf ?? ''}`,
        { id: f.id, variacaoId: f.variacao ?? null, lojaId: f.loja ?? null, preco: f.preco },
      ]),
    ),
    variacoes: new Map(variacoes.map(([id, venda, custo]) => [id, { venda, custo }])),
  });

  it('a faixa criada, a removida e a de preço trocado (com a faixa em origem_id); a igual não gera linha', () => {
    const antes = filhos([
      { id: 'f1', qi: '6.000', qf: '11.000', preco: '9.4000' },
      { id: 'f2', qi: '12.000', qf: null, preco: '9.2000' },
      { id: 'f3', qi: '24.000', qf: null, preco: '9.0000' },
    ]);
    const depois = filhos([
      { id: 'f4', qi: '6.000', qf: '11.000', preco: '9.3000' },
      { id: 'f3', qi: '24.000', qf: null, preco: '9.00' },
      { id: 'f5', qi: '48.000', qf: null, preco: '8.9000' },
    ]);
    expect(
      linhasHistoricoFilhos(U, P, antes, depois, 'cadastro').map((l) => [
        l.tipoPreco,
        l.valorAnterior,
        l.valorNovo,
        l.origemId,
      ]),
    ).toEqual([
      ['quantidade', '9.4000', '9.3000', 'f4'],
      ['quantidade', '9.2000', null, 'f2'],
      ['quantidade', null, '8.9000', 'f5'],
    ]);
  });

  it('a faixa da variação e da loja leva a variacao_id e a loja_id dela; a do produto no mesmo intervalo é outra', () => {
    const linhas = linhasHistoricoFilhos(
      U,
      P,
      filhos([
        { id: 'f1', qi: '6.000', qf: null, preco: '9.4000', variacao: V, loja: L },
        { id: 'f2', qi: '6.000', qf: null, preco: '9.4000' },
      ]),
      filhos([
        { id: 'f3', qi: '6.000', qf: null, preco: '9.1000', variacao: V, loja: L },
        { id: 'f2', qi: '6.000', qf: null, preco: '9.4000' },
        { id: 'f4', qi: '12.000', qf: null, preco: '9.0000', variacao: V },
      ]),
      'cadastro',
    );
    expect(linhas).toEqual([
      {
        produtoId: P,
        variacaoId: V,
        lojaId: L,
        tipoPreco: 'quantidade',
        valorAnterior: '9.4000',
        valorNovo: '9.1000',
        origem: 'cadastro',
        origemId: 'f3',
        usuarioId: U,
      },
      {
        produtoId: P,
        variacaoId: V,
        lojaId: null,
        tipoPreco: 'quantidade',
        valorAnterior: null,
        valorNovo: '9.0000',
        origem: 'cadastro',
        origemId: 'f4',
        usuarioId: U,
      },
    ]);
  });

  it('o preço da variação que mudou, com a variacao_id; a variação nova sem preço não gera linha', () => {
    const W = '0190a000-0000-7000-8000-0000000000d2';
    const linhas = linhasHistoricoFilhos(
      U,
      P,
      filhos([], [[V, '10.0000', '5.0000']]),
      filhos(
        [],
        [
          [V, '10.5000', '5.0000'],
          [W, null, null],
        ],
      ),
      'importacao',
    );
    expect(linhas).toEqual([
      {
        produtoId: P,
        variacaoId: V,
        tipoPreco: 'venda',
        valorAnterior: '10.0000',
        valorNovo: '10.5000',
        origem: 'importacao',
        origemId: null,
        usuarioId: U,
      },
    ]);
  });
});
