/**
 * Núcleo do estorno de estoque da venda (F3-B10; SYNC 10.4; T20, D29; Padrões da Fase 3): sem devolução, cada
 * movimento volta inteiro, com a mesma linha que o handler `venda.cancelada` já gerava; no item com troca, só o vendido
 * menos o devolvido (os insumos na mesma proporção), calculado por grupo de movimentos do item (a saída dividida em
 * FEFO soma exatamente o que sobrou, e o devolvido ocupa os lotes na ordem do id); o item devolvido por inteiro não
 * estorna nada; os vazios trazidos (bloco de vasilhames, sem item) voltam inteiros.
 */
import { describe, expect, it } from 'vitest';
import {
  ESTORNO_DO_MOVIMENTO,
  linhasDeEstorno,
  partesDevolvidas,
  quantidadesAEstornar,
  type MovimentoDaVenda,
  type OrigemEstorno,
  type QuantidadesItem,
} from './estorno-venda.js';

const ITEM = '0190a000-0000-7000-8000-0000000000aa';

const movimento = (tipo: string, extra: Partial<MovimentoDaVenda> = {}): MovimentoDaVenda => ({
  id: `0190a000-0000-7000-8000-00000000000${Object.keys(ESTORNO_DO_MOVIMENTO).indexOf(tipo)}`,
  estoque_id: 'e',
  loja_id: 'l',
  tipo_estoque_id: 't',
  produto_id: 'p',
  variacao_id: null,
  lote_id: 'lote',
  tipo_movimento: tipo,
  quantidade: '-12.000',
  custo_unitario: '2.5000',
  preco_venda: '3.2900',
  unidade_documento: 'UN',
  fator: '1.000',
  pessoa_id: 'cliente',
  documento_item_id: ITEM,
  ...extra,
});

const origem: OrigemEstorno = {
  documentoId: 'venda',
  dataMovimento: new Date('2026-11-20T15:00:00Z'),
  usuarioId: 'usuario',
  terminalId: 'terminal',
  eventoId: 'evento',
};

const devolvidos = (quantidade: string, devolvida: string) =>
  new Map<string, QuantidadesItem>([[ITEM, { quantidade, devolvida }]]);

/** O estorno de um movimento sozinho (o grupo de um movimento só). */
const quantidadeAEstornar = (m: MovimentoDaVenda, d?: Map<string, QuantidadesItem>) =>
  quantidadesAEstornar([m], d)[0];

describe('quantidadesAEstornar (vendido − devolvido)', () => {
  it('sem devolução, o movimento inteiro com o sinal oposto (a conta de antes)', () => {
    expect(quantidadeAEstornar(movimento('VENDA_PDV'))).toBe('12.000');
    expect(quantidadeAEstornar(movimento('VENDA_PDV'), devolvidos('12.000', '0.000'))).toBe('12.000');
    expect(quantidadeAEstornar(movimento('VASILHAME_DEVOLVIDO', { quantidade: '6.000' }))).toBe('-6.000');
  });

  it('item com troca parcial: o que sobrou dele; o insumo na mesma proporção, em 3 casas', () => {
    expect(quantidadeAEstornar(movimento('VENDA_PDV'), devolvidos('12.000', '5.000'))).toBe('7.000');
    // 0,050 kg de limão × 7 ÷ 12 = 0,029166… → 0,029.
    expect(
      quantidadeAEstornar(movimento('BAIXA_INSUMO', { quantidade: '-0.050' }), devolvidos('12.000', '5.000')),
    ).toBe('0.029');
    // O id do item em maiúsculas é o mesmo item.
    expect(
      quantidadeAEstornar(
        movimento('VENDA_PDV', { documento_item_id: ITEM.toUpperCase() }),
        devolvidos('12.000', '2.000'),
      ),
    ).toBe('10.000');
  });

  it('item devolvido por inteiro (ou acima, que o CHECK do banco não deixa): nada a estornar', () => {
    expect(quantidadeAEstornar(movimento('VENDA_PDV'), devolvidos('12.000', '12.000'))).toBe('0.000');
    expect(quantidadeAEstornar(movimento('VENDA_PDV'), devolvidos('12.000', '13.000'))).toBe('0.000');
  });

  it('os vazios trazidos (item derivado do bloco de vasilhames) e o item sem troca voltam inteiros', () => {
    const vazios = movimento('VASILHAME_DEVOLVIDO', { quantidade: '6.000', documento_item_id: 'derivado' });
    expect(quantidadeAEstornar(vazios, devolvidos('12.000', '5.000'))).toBe('-6.000');
    expect(
      quantidadeAEstornar(movimento('VENDA_PDV', { documento_item_id: null }), devolvidos('12.000', '5.000')),
    ).toBe('12.000');
  });
});

describe('partesDevolvidas e quantidadesAEstornar por grupo (a saída dividida em FEFO; um arredondamento só)', () => {
  /** A saída de 3 un sem lote que o motor dividiu em 3 lotes de 1,000 (`dividirFefo`): o mesmo item nos três. */
  const lote = (n: number, extra: Partial<MovimentoDaVenda> = {}) =>
    movimento('VENDA_PDV', {
      id: `0190a000-0000-7000-8000-00000000010${n}`,
      lote_id: `lote-${n}`,
      quantidade: '-1.000',
      ...extra,
    });
  const soma = (qs: string[]) => qs.reduce((s, q) => s + Number(q), 0).toFixed(3);

  it('3 lotes de 1 com 1 un devolvida: 2,000 no total (e não 3 × 0,667), o devolvido no primeiro lote pelo id', () => {
    // Fora da ordem do id: a parte devolvida segue o id, não a posição; a saída sai alinhada com a entrada.
    const movimentos = [lote(2), lote(1), lote(3)];
    expect(partesDevolvidas(movimentos, devolvidos('3.000', '1.000'))).toEqual(['0.000', '1.000', '0.000']);
    const qs = quantidadesAEstornar(movimentos, devolvidos('3.000', '1.000'));
    expect(qs).toEqual(['1.000', '0.000', '1.000']);
    expect(soma(qs)).toBe('2.000');
    // O movimento devolvido inteiro fica de fora das linhas; os outros voltam no lote deles.
    const linhas = linhasDeEstorno(movimentos, origem, devolvidos('3.000', '1.000'));
    expect(linhas.map((l) => [l.loteId, l.quantidade])).toEqual([
      ['lote-2', '1.000'],
      ['lote-3', '1.000'],
    ]);
  });

  it('a sobra sem lote e o devolvido que passa de um lote: soma exata, cada movimento até a quantidade dele', () => {
    const movimentos = [
      lote(1, { quantidade: '-1.500' }),
      lote(2, { quantidade: '-0.700' }),
      lote(3, { quantidade: '-0.800', lote_id: null }),
    ];
    // Vendido 3,000, devolvido 2,000: 1,500 do primeiro e 0,500 do segundo.
    expect(partesDevolvidas(movimentos, devolvidos('3.000', '2.000'))).toEqual(['1.500', '0.500', '0.000']);
    const qs = quantidadesAEstornar(movimentos, devolvidos('3.000', '2.000'));
    expect(qs).toEqual(['0.000', '0.200', '0.800']);
    expect(soma(qs)).toBe('1.000');
  });

  it('o insumo dividido em lotes: um arredondamento para o grupo (0,050 × 7 ÷ 12 = 0,029), não um por lote', () => {
    // Por lote, 0,025 × 7 ÷ 12 = 0,01458… → 0,015, duas vezes: 0,030.
    const movimentos = [
      lote(1, { tipo_movimento: 'BAIXA_INSUMO', produto_id: 'limao', quantidade: '-0.025' }),
      lote(2, { tipo_movimento: 'BAIXA_INSUMO', produto_id: 'limao', quantidade: '-0.025' }),
    ];
    const qs = quantidadesAEstornar(movimentos, devolvidos('12.000', '5.000'));
    expect(qs).toEqual(['0.004', '0.025']);
    expect(soma(qs)).toBe('0.029');
  });

  it('grupos separados: o produto do item, cada insumo e os vazios trazidos não se misturam', () => {
    const movimentos = [
      lote(1, { quantidade: '-2.000' }),
      lote(2, { tipo_movimento: 'BAIXA_INSUMO', produto_id: 'limao', quantidade: '-0.100' }),
      lote(3, { tipo_movimento: 'BAIXA_INSUMO', produto_id: 'acucar', quantidade: '-0.040' }),
      movimento('VASILHAME_DEVOLVIDO', { quantidade: '6.000', documento_item_id: 'derivado' }),
    ];
    expect(quantidadesAEstornar(movimentos, devolvidos('2.000', '1.000'))).toEqual([
      '1.000',
      '0.050',
      '0.020',
      '-6.000',
    ]);
  });

  it('sem troca, cada movimento do grupo volta inteiro (a conta de antes)', () => {
    expect(quantidadesAEstornar([lote(1), lote(2), lote(3)])).toEqual(['1.000', '1.000', '1.000']);
    expect(partesDevolvidas([lote(1), lote(2)])).toEqual(['0.000', '0.000']);
  });
});

describe('linhasDeEstorno (SYNC 10.4; T20)', () => {
  it('sem devolução: estorno_de_id, sinal oposto, o custo da saída, a data, o lote, o item e a origem', () => {
    const linhas = linhasDeEstorno(
      [
        movimento('VENDA_PDV'),
        movimento('VASILHAME_VENDIDO', { quantidade: '-2.000', custo_unitario: '1.0000' }),
        movimento('BAIXA_INSUMO', { quantidade: '-0.050', custo_unitario: '30.0000' }),
        movimento('VASILHAME_DEVOLVIDO', {
          quantidade: '6.000',
          custo_unitario: '1.2000',
          preco_venda: null,
        }),
      ],
      origem,
    );
    expect(linhas.map((l) => [l.tipoMovimento, l.quantidade, l.custoUnitario, l.estornoDeId])).toEqual([
      ['CANC_VENDA_PDV', '12.000', '2.5000', movimento('VENDA_PDV').id],
      ['CANC_VENDA_PDV', '2.000', '1.0000', movimento('VASILHAME_VENDIDO').id],
      ['ESTORNO_BAIXA_INSUMO', '0.050', '30.0000', movimento('BAIXA_INSUMO').id],
      ['ESTORNO_VASILHAME_DEVOLVIDO', '-6.000', '1.2000', movimento('VASILHAME_DEVOLVIDO').id],
    ]);
    expect(linhas[0]).toEqual({
      estoqueId: 'e',
      produtoId: 'p',
      variacaoId: null,
      tipoEstoqueId: 't',
      tipoMovimento: 'CANC_VENDA_PDV',
      quantidade: '12.000',
      custoUnitario: '2.5000',
      custoReferencia: '2.5000',
      precoVenda: '3.2900',
      dataMovimento: origem.dataMovimento,
      lojaId: 'l',
      usuarioId: 'usuario',
      documentoTipo: 'venda',
      documentoId: 'venda',
      documentoItemId: ITEM,
      unidadeDocumento: 'UN',
      fator: '1.000',
      loteId: 'lote',
      pessoaId: 'cliente',
      terminalId: 'terminal',
      eventoId: 'evento',
      estornoDeId: movimento('VENDA_PDV').id,
    });
  });

  it('no item devolvido por inteiro, o movimento fica de fora; os outros continuam', () => {
    const linhas = linhasDeEstorno(
      [
        movimento('VENDA_PDV'),
        movimento('VASILHAME_DEVOLVIDO', { quantidade: '6.000', documento_item_id: 'derivado' }),
      ],
      origem,
      devolvidos('12.000', '12.000'),
    );
    expect(linhas.map((l) => l.tipoMovimento)).toEqual(['ESTORNO_VASILHAME_DEVOLVIDO']);
  });

  it('a origem do ERP vai sem terminal nem evento', () => {
    const [linha] = linhasDeEstorno([movimento('VENDA_PDV')], {
      ...origem,
      terminalId: null,
      eventoId: null,
    });
    expect([linha!.terminalId, linha!.eventoId]).toEqual([null, null]);
  });
});
