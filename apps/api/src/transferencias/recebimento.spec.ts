import { describe, expect, it } from 'vitest';
import { repartirRecebida } from './recebimento.js';

describe('repartirRecebida (F2-B24): a recebida enche as partes da saída na ordem do lançamento', () => {
  it('uma parte só: a diferença é a da parte', () => {
    expect(repartirRecebida(['10'], '8')).toEqual([{ recebida: '8.000', diferenca: '2.000' }]);
    expect(repartirRecebida(['10.000'], '10')).toEqual([{ recebida: '10.000', diferenca: '0.000' }]);
    expect(repartirRecebida(['10'], '0')).toEqual([{ recebida: '0.000', diferenca: '10.000' }]);
  });

  it('divisão FEFO: o lote que vence primeiro chega primeiro, e o que faltou fica nas últimas partes', () => {
    expect(repartirRecebida(['2', '10', '3'], '11')).toEqual([
      { recebida: '2.000', diferenca: '0.000' },
      { recebida: '9.000', diferenca: '1.000' },
      { recebida: '0.000', diferenca: '3.000' },
    ]);
    expect(repartirRecebida(['2', '10', '3'], '15')).toEqual([
      { recebida: '2.000', diferenca: '0.000' },
      { recebida: '10.000', diferenca: '0.000' },
      { recebida: '3.000', diferenca: '0.000' },
    ]);
  });

  it('frações de 3 casas (ADR-05), sem erro de ponto flutuante', () => {
    expect(repartirRecebida(['0.1', '0.2'], '0.25')).toEqual([
      { recebida: '0.100', diferenca: '0.000' },
      { recebida: '0.150', diferenca: '0.050' },
    ]);
  });
});
