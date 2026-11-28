import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolverPreco, type FaixaPrecoCalculo, type OrigemPreco } from './precos.js';

interface FaixaVetor {
  loja: 'loja' | 'outra' | null;
  quantidade_inicial: string;
  quantidade_final: string | null;
  preco: string;
}

interface CasoVetor {
  nome: string;
  produto: {
    preco_venda: string;
    preco_loja?: string;
    preco_promocional?: string;
    preco_atacado?: string;
    qtd_minima_atacado?: string;
    faixas?: FaixaVetor[];
    grupo?: { modo: 'produto' | 'grupo'; faixas: FaixaVetor[] };
    preco_parcelado?: string;
  };
  qtd_total: string;
  qtd_grupo: string | null;
  usa_preco_volume: boolean;
  tipo_preco: 'varejo' | 'atacado';
  /** O pagamento parcelado (F3-B18): ausente = não. */
  parcelado?: boolean;
  promocao_vigente: boolean;
  esperado: { preco: string; origem: OrigemPreco };
}

/** O mesmo arquivo do `PrecosVetoresTests` do PDV (GenesisPDV.Core.Tests; F3-B17, F3-B18). */
const V = JSON.parse(
  readFileSync(new URL('../testes/precos/regra-preco.vetores.json', import.meta.url), 'utf8'),
) as { casos: CasoVetor[] };

const LOJA = '01a18752-0000-7000-8000-000000000001';
const OUTRA = '01a18752-0000-7000-8000-000000000002';
const num = (t: string | null | undefined) => (t == null ? null : Number(t));
const faixas = (l: FaixaVetor[] | undefined): FaixaPrecoCalculo[] =>
  (l ?? []).map((f) => ({
    lojaId: f.loja === 'loja' ? LOJA : f.loja === 'outra' ? OUTRA : null,
    quantidadeInicial: Number(f.quantidade_inicial),
    quantidadeFinal: num(f.quantidade_final),
    preco: Number(f.preco),
  }));

describe('regra-preco.vetores.json: resolverPreco = MotorPreco do caixa (PDV 11.2, 11.3)', () => {
  it('os casos têm nomes únicos e cobrem o F8 e o parcelado', () => {
    expect(new Set(V.casos.map((c) => c.nome)).size).toBe(V.casos.length);
    expect(V.casos.filter((c) => c.tipo_preco === 'atacado').length).toBeGreaterThan(5);
    expect(V.casos.filter((c) => c.parcelado).length).toBeGreaterThan(3);
  });

  it.each(V.casos)('$nome', (c) => {
    const p = c.produto;
    const r = resolverPreco(
      {
        precoVenda: Number(p.preco_venda),
        precoLoja: num(p.preco_loja),
        precoPromocional: num(p.preco_promocional),
        promocaoVigente: c.promocao_vigente,
        precoAtacado: num(p.preco_atacado),
        qtdMinimaAtacado: num(p.qtd_minima_atacado),
        faixas: faixas(p.faixas),
        grupo: p.grupo ? { modo: p.grupo.modo, faixas: faixas(p.grupo.faixas) } : null,
        precoParcelado: num(p.preco_parcelado),
      },
      Number(c.qtd_total),
      num(c.qtd_grupo),
      {
        usaPrecoVolume: c.usa_preco_volume,
        lojaId: LOJA,
        tipoPreco: c.tipo_preco,
        parcelado: c.parcelado ?? false,
      },
    );
    expect({ preco: r.preco, origem: r.origem }).toEqual({
      preco: Number(c.esperado.preco),
      origem: c.esperado.origem,
    });
  });
});
