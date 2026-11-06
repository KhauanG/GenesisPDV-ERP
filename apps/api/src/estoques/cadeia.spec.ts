import { describe, expect, it } from 'vitest';
import { ordenarCadeia, primeiraQuebra, type EloCadeia } from './cadeia.js';

/** Ids em ordem crescente (UUIDv7 com o mesmo instante): `id(1) < id(2)`. */
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const elo = (n: number, anterior: string, posterior: string): EloCadeia => ({
  id: id(n),
  saldoAnterior: anterior,
  saldoPosterior: posterior,
});

describe('cadeia do razão por linha de saldo (F2-B2)', () => {
  it('encadeia pelo saldo, não pela ordem recebida (o criado_em é o da transação, igual para todos)', () => {
    const a = elo(1, '0.000', '10.000');
    const b = elo(2, '10.000', '7.500');
    const c = elo(3, '7.500', '-2.000');
    const d = elo(4, '-2.000', '0.000');
    const r = ordenarCadeia([c, a, d, b]);
    expect(r.quebra).toBeNull();
    expect(r.ordem.map((e) => e.id)).toEqual([a.id, b.id, c.id, d.id]);
  });

  it('a linha que volta ao mesmo saldo desempata pelo menor id (UUIDv7 gerado com a linha travada)', () => {
    // 0 → 5 → 0 → 5 → 0: dois candidatos a cada volta ao zero e ao cinco.
    const m = [elo(1, '0', '5'), elo(2, '5', '0'), elo(3, '0', '5'), elo(4, '5', '0')];
    const r = ordenarCadeia([m[3]!, m[2]!, m[1]!, m[0]!]);
    expect(r.quebra).toBeNull();
    expect(r.ordem.map((e) => e.id)).toEqual(m.map((e) => e.id));
  });

  it('desempate sem saída mas a ordem recebida contínua: fica a recebida, sem quebra', () => {
    // Pelo id, de 0 iria para 5 (id 1) e pararia em 7 com o ramo 0 → 2 → 0 sobrando.
    const recebida = [elo(2, '0', '2'), elo(3, '2', '0'), elo(1, '0', '5'), elo(4, '5', '7')];
    const r = ordenarCadeia(recebida);
    expect(r.quebra).toBeNull();
    expect(r.ordem).toEqual(recebida);
  });

  it('cadeia quebrada no banco: não aborta, fica na ordem recebida e aponta o primeiro elo fora', () => {
    const recebida = [elo(1, '0', '10'), elo(2, '10', '4'), elo(3, '6', '1')];
    const r = ordenarCadeia(recebida);
    expect(r.ordem).toEqual(recebida);
    expect(r.quebra).toEqual({
      posicao: 3,
      movimentoId: id(3),
      saldoEsperado: '4.000',
      saldoAnterior: '6.000',
    });
  });

  it('primeiraQuebra compara em decimal (3 casas) e parte do saldo inicial', () => {
    expect(primeiraQuebra([])).toBeNull();
    expect(primeiraQuebra([elo(1, '0.000', '1.5'), elo(2, '1.50', '0')])).toBeNull();
    expect(primeiraQuebra([elo(1, '2', '3')])).toMatchObject({ posicao: 1, saldoEsperado: '0.000' });
    expect(primeiraQuebra([elo(1, '2', '3')], '2')).toBeNull();
  });
});
