import { describe, expect, it } from 'vitest';
import { avaliarConferencia, filtroConferenciaSchema } from './conferencia.js';

const padrao = { totalPct: '1', itemPct: '5' };

describe('conferência do "Definir" (F2-B11; F2-Q6 (a))', () => {
  it('diferença a custo por item e no total, e o veredito pelos dois limites', () => {
    const r = avaliarConferencia(
      [
        { contado: '95', saldoSistema: '100', custoUnitario: '2' },
        { contado: '50', saldoSistema: '50', custoUnitario: '2' },
        { contado: '24', saldoSistema: '30', custoUnitario: '2' },
      ],
      padrao,
    );
    expect(r.itens.map((i) => [i.diferenca, i.valorDiferenca, i.diferencaPct, i.foraTolerancia])).toEqual([
      ['-5.000', '-10.00', '5.00', false],
      ['0.000', '0.00', '0.00', false],
      ['-6.000', '-12.00', '20.00', true],
    ]);
    expect(r.totais).toEqual({
      valorContado: '338.00',
      valorSistema: '360.00',
      valorDiferenca: '-22.00',
      valorDiferencaAbsoluta: '22.00',
      diferencaTotalPct: '6.51',
      totalForaTolerancia: true,
      itensForaTolerancia: 1,
      veredito: 'fora_tolerancia',
    });
  });

  it('o total soma os módulos: a sobra de um item não paga a falta de outro', () => {
    const r = avaliarConferencia(
      [
        { contado: '102', saldoSistema: '100', custoUnitario: '10' },
        { contado: '98', saldoSistema: '100', custoUnitario: '10' },
      ],
      { totalPct: '1', itemPct: '5' },
    );
    expect(r.totais).toMatchObject({
      valorDiferenca: '0.00',
      valorDiferencaAbsoluta: '40.00',
      diferencaTotalPct: '2.00',
      veredito: 'fora_tolerancia',
    });
    expect(
      avaliarConferencia([{ contado: '102', saldoSistema: '100', custoUnitario: '10' }], {
        totalPct: '2',
        itemPct: '2',
      }).totais,
    ).toMatchObject({ diferencaTotalPct: '1.96', veredito: 'conferido' });
  });

  it('no limite exato fica dentro; saldo do sistema zero com diferença fica fora (sem percentual)', () => {
    const limite = avaliarConferencia([{ contado: '95', saldoSistema: '100', custoUnitario: '1' }], {
      totalPct: '100',
      itemPct: '5',
    });
    expect(limite.itens[0]).toMatchObject({ diferencaPct: '5.00', foraTolerancia: false });
    // Logo acima do limite: 5,004% aparece como 5,00, mas o veredito compara o exato (fora).
    for (const [contado, sistema] of [
      ['105.004', '100'],
      ['949.96', '1000'],
    ] as const)
      expect(
        avaliarConferencia([{ contado, saldoSistema: sistema, custoUnitario: '1' }], {
          totalPct: '100',
          itemPct: '5',
        }).itens[0],
      ).toMatchObject({ diferencaPct: '5.00', foraTolerancia: true });
    // O total também: 3,38 de diferença a custo sobre 337,00 contados = 1,003% (mostra 1,00; fora de 1%).
    expect(
      avaliarConferencia([{ contado: '337', saldoSistema: '333.62', custoUnitario: '1' }], {
        totalPct: '1',
        itemPct: '100',
      }).totais,
    ).toMatchObject({ diferencaTotalPct: '1.00', totalForaTolerancia: true, veredito: 'fora_tolerancia' });
    const zero = avaliarConferencia(
      [
        { contado: '3', saldoSistema: '0', custoUnitario: '2' },
        { contado: '0', saldoSistema: '0', custoUnitario: '2' },
      ],
      padrao,
    );
    expect(zero.itens.map((i) => [i.diferencaPct, i.foraTolerancia])).toEqual([
      [null, true],
      ['0.00', false],
    ]);
    expect(zero.totais).toMatchObject({ itensForaTolerancia: 1, veredito: 'fora_tolerancia' });
  });

  it('granel e negativos: fração de kg em decimal, saldo negativo pelo módulo e nada contado a custo', () => {
    // 12,345 kg contados contra 12,5 no sistema: 1,24% (nada de "unidades").
    const granel = avaliarConferencia(
      [{ contado: '12.345', saldoSistema: '12.5', custoUnitario: '39.9' }],
      padrao,
    );
    expect(granel.itens[0]).toMatchObject({
      diferenca: '-0.155',
      valorDiferenca: '-6.18',
      diferencaPct: '1.24',
    });
    // Contagem negativa do Nuvem3: a base do total é o módulo do contado; o % do item, o módulo do saldo.
    const negativo = avaliarConferencia([{ contado: '-4', saldoSistema: '-4', custoUnitario: '3' }], padrao);
    expect(negativo.totais).toMatchObject({
      valorContado: '12.00',
      diferencaTotalPct: '0.00',
      veredito: 'conferido',
    });
    // Custo zero: a diferença a custo também é zero, e o total fica em 0% (dentro).
    const semCusto = avaliarConferencia([{ contado: '1', saldoSistema: '2', custoUnitario: '0' }], {
      totalPct: '1',
      itemPct: '100',
    });
    expect(semCusto.totais).toMatchObject({ diferencaTotalPct: '0.00', totalForaTolerancia: false });
    // Nada contado a custo e alguma diferença (o setor contado vazio): o total não tem percentual e fica fora. O item
    // de 100% fica dentro do limite de 100%, e o veredito vem só do total.
    const vazio = avaliarConferencia([{ contado: '0', saldoSistema: '10', custoUnitario: '2' }], {
      totalPct: '1',
      itemPct: '100',
    });
    expect(vazio.itens[0]).toMatchObject({ diferencaPct: '100.00', foraTolerancia: false });
    expect(vazio.totais).toMatchObject({
      valorContado: '0.00',
      valorDiferencaAbsoluta: '20.00',
      diferencaTotalPct: null,
      totalForaTolerancia: true,
      itensForaTolerancia: 0,
      veredito: 'fora_tolerancia',
    });
    expect(avaliarConferencia([], padrao).totais).toMatchObject({
      diferencaTotalPct: '0.00',
      veredito: 'conferido',
    });
  });

  it('limites da consulta: vírgula decimal, vazio = o configurado, acima de 100 recusado', () => {
    expect(filtroConferenciaSchema.parse({ toleranciaTotalPct: '1,5', toleranciaItemPct: '' })).toEqual({
      toleranciaTotalPct: '1.5',
    });
    expect(filtroConferenciaSchema.safeParse({ toleranciaItemPct: '101' }).success).toBe(false);
    expect(filtroConferenciaSchema.safeParse({ toleranciaItemPct: '-1' }).success).toBe(false);
  });
});
