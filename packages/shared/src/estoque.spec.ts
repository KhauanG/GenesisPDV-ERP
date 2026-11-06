import { describe, expect, it } from 'vitest';
import {
  alterarTipoEstoqueSchema,
  criarAcertoSchema,
  criarTipoEstoqueSchema,
  custoMedioAposEntrada,
  custoMedioAposEntradaTexto,
  custoMedioAposEstornoTexto,
  diferencaDefinir,
  dividirSaidaFefo,
  errosRegraTipoEstoque,
  movimentoDeCompra,
  ordenarLotesFefo,
  quantidadeMovimento,
  quantidadeMovimentoTexto,
  tipoMovimentoAcerto,
  totaisAcerto,
  totaisAcertoTexto,
  valoresItemAcerto,
  valoresItemAcertoTexto,
} from './estoque.js';
import { dashboardQuerySchema, rotuloMes } from './dashboard.js';

const E = '0190a000-0000-7000-8000-0000000000e1';
const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';

const campos = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.path.join('.')).sort();

describe('razão de estoque (ERP 13.1.4, 13.1.5)', () => {
  it('custo médio ponderado na entrada; saldo zero ou negativo assume o custo da entrada', () => {
    expect(custoMedioAposEntrada(10, 5, 10, 7)).toBe(6);
    expect(custoMedioAposEntrada(3, 4.1234, 1, 4.1234)).toBe(4.1234);
    expect(custoMedioAposEntrada(0, 5, 12, 3.5)).toBe(3.5);
    expect(custoMedioAposEntrada(-4, 5, 12, 3.5)).toBe(3.5);
  });

  it('estorno de saída (T20): saldo positivo = como se a saída não existisse; saldo ≤ 0 mantém o custo médio', () => {
    // 10 a 5,00; saída de 4 a 5,00; compra de 6 a 8,00 → cm (6×5 + 6×8) ÷ 12 = 6,5; o estorno das 4 a 5,00 dá a
    // média (10×5 + 6×8) ÷ 16 = 6,125.
    expect(custoMedioAposEntradaTexto('6', '5', '6', '8')).toBe('6.5000');
    expect(custoMedioAposEstornoTexto('12', '6.5', '4', '5')).toBe('6.1250');
    // Saldo −10 com custo médio 14 (última compra): devolver 1 a 8,00 não puxa o custo para 8.
    expect(custoMedioAposEstornoTexto('-10', '14', '1', '8')).toBe('14.0000');
    expect(custoMedioAposEstornoTexto('-2', '10', '5', '10')).toBe('10.0000');
    // Sem custo médio na linha: fica o custo da saída original.
    expect(custoMedioAposEstornoTexto('0', '0', '3', '4.1234')).toBe('4.1234');
    // A compra continua com a regra do ERP 13.1.4.
    expect(custoMedioAposEntradaTexto('-10', '14', '1', '8')).toBe('8.0000');
  });

  it('Definir desconta os movimentos posteriores à contagem (exemplo do ERP 13.1.5)', () => {
    // contagem 20 às 11:00; venda −2 às 11:30 já aplicada; saldo 18 ao efetivar → diferença 0
    expect(diferencaDefinir(20, 18, -2)).toBe(0);
    expect(diferencaDefinir(20, 18, 0)).toBe(2);
    expect(quantidadeMovimento('definir', 5, 12.5)).toBe(-7.5);
    expect(quantidadeMovimento('saida', 3, 100)).toBe(-3);
    expect(quantidadeMovimento('entrada', 0.1 + 0.2, 0)).toBe(0.3);
  });

  it('custo médio e totais em decimal (3 × 0,1 e custo 1,0005 não derivam no binário)', () => {
    expect(custoMedioAposEntradaTexto('0.1', '1.0005', '0.2', '1.0005')).toBe('1.0005');
    expect(custoMedioAposEntradaTexto('3', '1.0005', '1', '2.0005')).toBe('1.2505');
    expect(
      totaisAcertoTexto([
        { tipo: 'entrada', quantidade: '0.1', saldoAtual: '0', custoUnitario: '1.0005', precoVenda: '0.1' },
        { tipo: 'entrada', quantidade: '0.1', saldoAtual: '0', custoUnitario: '1.0005', precoVenda: '0.1' },
        { tipo: 'entrada', quantidade: '0.1', saldoAtual: '0', custoUnitario: '1.0005', precoVenda: '0.1' },
      ]),
    ).toEqual({ qtdItens: 3, totalVenda: '0.03', totalCusto: '0.30' });
    expect(quantidadeMovimentoTexto('entrada', '0.1', '0')).toBe('0.100');
    expect(
      valoresItemAcertoTexto({
        tipo: 'saida',
        quantidade: '3',
        saldoAtual: '5',
        custoUnitario: '1.0005',
        precoVenda: '2.675',
      }),
    ).toEqual({
      diferenca: '-3.000',
      totalVenda: '8.03',
      totalCusto: '3.00',
    });
  });

  it('totais do acerto: Entrada/Saída pela quantidade, Definir pela diferença com sinal', () => {
    expect(
      valoresItemAcerto({
        tipo: 'entrada',
        quantidade: 12,
        saldoAtual: 0,
        custoUnitario: 2.5,
        precoVenda: 4.99,
      }),
    ).toEqual({
      diferenca: 12,
      totalVenda: 59.88,
      totalCusto: 30,
    });
    expect(
      valoresItemAcerto({ tipo: 'definir', quantidade: 8, saldoAtual: 10, custoUnitario: 3, precoVenda: 5 }),
    ).toEqual({
      diferenca: -2,
      totalVenda: -10,
      totalCusto: -6,
    });
    expect(
      totaisAcerto([
        { tipo: 'saida', quantidade: 1, saldoAtual: 5, custoUnitario: 1.111, precoVenda: 2.225 },
        { tipo: 'saida', quantidade: 2, saldoAtual: 5, custoUnitario: 1, precoVenda: 1 },
      ]),
    ).toEqual({ qtdItens: 2, totalVenda: 4.23, totalCusto: 3.11 });
  });

  it('tipo de movimento pela origem do acerto (MD 7.3)', () => {
    expect(tipoMovimentoAcerto('manual', 'entrada')).toBe('ACERTO_ENTRADA');
    expect(tipoMovimentoAcerto('manual', 'saida')).toBe('ACERTO_SAIDA');
    expect(tipoMovimentoAcerto('manual', 'definir')).toBe('ACERTO_DEFINIR');
    expect(tipoMovimentoAcerto('importacao', 'definir')).toBe('AJUSTE_IMPORTACAO');
    expect(tipoMovimentoAcerto('cadastro_produto', 'definir')).toBe('AJUSTE_CADASTRO');
    // A mudança de tipo é o par MUDANCA_TIPO_ESTOQUE de qualquer origem (F2-B8; o modal do Estoque Atual também).
    expect(tipoMovimentoAcerto('manual', 'mudanca_tipo')).toBe('MUDANCA_TIPO_ESTOQUE');
    expect(tipoMovimentoAcerto('relatorio_estoque', 'mudanca_tipo')).toBe('MUDANCA_TIPO_ESTOQUE');
  });

  it('mudança de tipo (F2-B8): a quantidade é a da perna de saída e o total valoriza a quantidade movida', () => {
    expect(quantidadeMovimentoTexto('mudanca_tipo', '5', '20')).toBe('-5.000');
    expect(
      valoresItemAcertoTexto({
        tipo: 'mudanca_tipo',
        quantidade: '5',
        saldoAtual: '20',
        custoUnitario: '2.5',
        precoVenda: '5',
      }),
    ).toEqual({ diferenca: '-5.000', totalVenda: '25.00', totalCusto: '12.50' });
  });
});

describe('acerto de estoque (ERP 13.5)', () => {
  const base = {
    estoqueId: E,
    tipoAjuste: 'entrada',
    dataContagem: new Date().toISOString(),
    motivo: 'Saldo inicial',
  } as const;

  it('aceita decimais pt-BR e normaliza a quantidade e o custo', () => {
    const r = criarAcertoSchema.parse({
      ...base,
      itens: [{ produtoId: A, quantidade: '1.234,5', custoUnitario: '2,5' }],
    });
    expect(r.itens[0]).toMatchObject({ quantidade: '1234.500', custoUnitario: '2.5000', variacaoId: null });
    expect(r.tipoEstoqueId).toBeNull();
    expect(r.responsavelId).toBeNull();
  });

  it('Entrada/Saída exigem quantidade > 0; Definir aceita zero; custo só na Entrada; produto repetido', () => {
    expect(
      campos(criarAcertoSchema.safeParse({ ...base, itens: [{ produtoId: A, quantidade: '0' }] })),
    ).toEqual(['itens.0.quantidade']);
    expect(
      campos(
        criarAcertoSchema.safeParse({
          ...base,
          tipoAjuste: 'definir',
          itens: [{ produtoId: A, quantidade: '0' }],
        }),
      ),
    ).toEqual([]);
    expect(
      campos(
        criarAcertoSchema.safeParse({
          ...base,
          tipoAjuste: 'saida',
          itens: [
            { produtoId: A, quantidade: '1', custoUnitario: '3' },
            { produtoId: B, quantidade: '1' },
            { produtoId: A, quantidade: '2' },
          ],
        }),
      ),
    ).toEqual(['itens.0.custoUnitario', 'itens.2.produtoId']);
  });

  it('lote (F2-B6): o mesmo produto em lotes diferentes não repete; o Definir não aceita lote', () => {
    const L1 = '0190a000-0000-7000-8000-0000000000c1';
    const L2 = '0190a000-0000-7000-8000-0000000000c2';
    const saida = criarAcertoSchema.safeParse({
      ...base,
      tipoAjuste: 'saida',
      itens: [
        { produtoId: A, loteId: L1, quantidade: '1' },
        { produtoId: A, loteId: L2, quantidade: '1' },
        { produtoId: A, quantidade: '1' },
        { produtoId: A, loteId: L1, quantidade: '2' },
      ],
    });
    expect(campos(saida)).toEqual(['itens.3.produtoId']);
    expect(
      criarAcertoSchema.parse({ ...base, itens: [{ produtoId: A, quantidade: '1' }] }).itens[0]!.loteId,
    ).toBeNull();
    expect(
      campos(
        criarAcertoSchema.safeParse({
          ...base,
          tipoAjuste: 'definir',
          itens: [{ produtoId: A, loteId: L1, quantidade: '3' }],
        }),
      ),
    ).toEqual(['itens.0.loteId']);
  });

  it('mudança de tipo (F2-B8): destino obrigatório, diferente da origem e só nela; lote aceito, custo não', () => {
    const D = '0190a000-0000-7000-8000-0000000000d1';
    const V = '0190a000-0000-7000-8000-0000000000d2';
    const L1 = '0190a000-0000-7000-8000-0000000000c1';
    const mudanca = { ...base, tipoAjuste: 'mudanca_tipo', tipoEstoqueId: D } as const;
    const ok = criarAcertoSchema.parse({
      ...mudanca,
      tipoEstoqueDestinoId: V,
      itens: [{ produtoId: A, loteId: L1, quantidade: '5' }],
    });
    expect(ok).toMatchObject({ tipoAjuste: 'mudanca_tipo', tipoEstoqueId: D, tipoEstoqueDestinoId: V });
    expect(criarAcertoSchema.parse({ ...base, itens: [] }).tipoEstoqueDestinoId).toBeNull();
    expect(campos(criarAcertoSchema.safeParse({ ...mudanca, itens: [] }))).toEqual(['tipoEstoqueDestinoId']);
    // A caixa do uuid não muda o tipo.
    expect(
      campos(criarAcertoSchema.safeParse({ ...mudanca, tipoEstoqueDestinoId: D.toUpperCase(), itens: [] })),
    ).toEqual(['tipoEstoqueDestinoId']);
    expect(campos(criarAcertoSchema.safeParse({ ...base, tipoEstoqueDestinoId: V, itens: [] }))).toEqual([
      'tipoEstoqueDestinoId',
    ]);
    expect(
      campos(
        criarAcertoSchema.safeParse({
          ...mudanca,
          tipoEstoqueDestinoId: V,
          itens: [
            { produtoId: A, quantidade: '0' },
            { produtoId: B, quantidade: '1', custoUnitario: '2' },
          ],
        }),
      ),
    ).toEqual(['itens.0.quantidade', 'itens.1.custoUnitario']);
  });

  it('data não pode ser futura e motivo é obrigatório', () => {
    const futuro = new Date(Date.now() + 3_600_000).toISOString();
    expect(campos(criarAcertoSchema.safeParse({ ...base, dataContagem: futuro, motivo: ' ' }))).toEqual([
      'dataContagem',
      'motivo',
    ]);
  });
});

describe('lote e última compra no razão (F2-B6; F2-Q7)', () => {
  const lote = (n: number) => `0190a000-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;

  it('FEFO: validade crescente, sem validade por último, id no empate', () => {
    const lotes = [
      { loteId: lote(3), validade: null },
      { loteId: lote(2), validade: '2026-12-01' },
      { loteId: lote(9), validade: '2026-11-15' },
      { loteId: lote(1), validade: '2026-12-01' },
      { loteId: lote(4), validade: null },
    ];
    expect(ordenarLotesFefo(lotes).map((l) => l.loteId)).toEqual([
      lote(9),
      lote(1),
      lote(2),
      lote(3),
      lote(4),
    ]);
  });

  it('divide a saída pelo saldo de cada lote na ordem FEFO (o critério: 10 de A=6 e B=8 → 6 de A e 4 de B)', () => {
    expect(
      dividirSaidaFefo('-10', [
        { loteId: lote(2), validade: '2027-01-10', disponivel: '8' },
        { loteId: lote(1), validade: '2026-12-01', disponivel: '6' },
      ]),
    ).toEqual([
      { loteId: lote(1), quantidade: '-6.000' },
      { loteId: lote(2), quantidade: '-4.000' },
    ]);
  });

  it('lote zerado ou negativo fica de fora; a sobra sem saldo de lote sai sem lote', () => {
    expect(
      dividirSaidaFefo('-7.5', [
        { loteId: lote(1), validade: '2026-11-01', disponivel: '0' },
        { loteId: lote(2), validade: '2026-11-02', disponivel: '-3' },
        { loteId: lote(3), validade: '2026-11-03', disponivel: '2.25' },
      ]),
    ).toEqual([
      { loteId: lote(3), quantidade: '-2.250' },
      { loteId: null, quantidade: '-5.250' },
    ]);
    expect(dividirSaidaFefo('-1', [])).toEqual([{ loteId: null, quantidade: '-1.000' }]);
    expect(dividirSaidaFefo('-2', [{ loteId: lote(1), validade: null, disponivel: '5' }])).toEqual([
      { loteId: lote(1), quantidade: '-2.000' },
    ]);
    expect(() => dividirSaidaFefo('3', [])).toThrow();
  });

  it('a soma das partes é sempre a saída (decimal, sem perder milésimo)', () => {
    const disponiveis = ['0.333', '0.333', '0.334', '1.001'];
    const partes = dividirSaidaFefo(
      '-1.5',
      disponiveis.map((d, i) => ({ loteId: lote(i + 1), validade: `2026-11-0${i + 1}`, disponivel: d })),
    );
    expect(partes.reduce((s, p) => s + Math.round(Number(p.quantidade) * 1000), 0)).toBe(-1500);
    expect(partes.at(-1)).toEqual({ loteId: lote(4), quantidade: '-0.500' });
  });

  it('última compra: só a entrada de RECEB_MANUAL/RECEB_NFE que não é estorno', () => {
    expect(movimentoDeCompra({ tipoMovimento: 'RECEB_MANUAL', quantidade: '12' })).toBe(true);
    expect(movimentoDeCompra({ tipoMovimento: 'RECEB_NFE', quantidade: '1', estornoDeId: null })).toBe(true);
    expect(movimentoDeCompra({ tipoMovimento: 'RECEB_NFE', quantidade: '-1' })).toBe(false);
    expect(movimentoDeCompra({ tipoMovimento: 'RECEB_MANUAL', quantidade: '1', estornoDeId: lote(1) })).toBe(
      false,
    );
    expect(movimentoDeCompra({ tipoMovimento: 'ESTORNO_RECEB_NFE', quantidade: '-1' })).toBe(false);
    expect(movimentoDeCompra({ tipoMovimento: 'ACERTO_ENTRADA', quantidade: '5' })).toBe(false);
  });
});

describe('dashboard (ERP 6)', () => {
  it('mês AAAA-MM e rótulo "Outubro/2026"', () => {
    expect(dashboardQuerySchema.safeParse({ mes: '2026-13' }).success).toBe(false);
    expect(dashboardQuerySchema.parse({ mes: '2026-10', lojaId: '' })).toEqual({
      mes: '2026-10',
      treino: 'excluir',
    });
    // Loja de treino (O10, C12): fora por padrão; `incluir` e `somente` vêm do filtro.
    expect(dashboardQuerySchema.parse({ treino: 'incluir' }).treino).toBe('incluir');
    expect(dashboardQuerySchema.safeParse({ treino: 'sim' }).success).toBe(false);
    expect(rotuloMes('2026-10')).toBe('Outubro/2026');
  });
});

describe('tipo de estoque (ERP 13.6)', () => {
  it('o padrão é sempre vendável e ativo; um tipo novo nasce não vendável', () => {
    expect(criarTipoEstoqueSchema.parse({ nome: ' Quebra ' })).toEqual({
      nome: 'Quebra',
      vendavel: false,
      padrao: false,
      ativo: true,
    });
    expect(campos(criarTipoEstoqueSchema.safeParse({ nome: 'X', padrao: true }))).toEqual(['vendavel']);
    expect(
      campos(
        alterarTipoEstoqueSchema.safeParse({
          nome: 'X',
          padrao: true,
          vendavel: true,
          ativo: false,
          versao: 1,
        }),
      ),
    ).toEqual(['ativo']);
    expect(campos(criarTipoEstoqueSchema.safeParse({ nome: 'x'.repeat(41) }))).toEqual(['nome']);
  });

  it('travas dos tipos de sistema e do padrão', () => {
    const disp = { chaveSistema: 'disponivel', padrao: true };
    expect(errosRegraTipoEstoque(disp, { vendavel: true, padrao: true, ativo: true })).toEqual({});
    expect(Object.keys(errosRegraTipoEstoque(disp, { vendavel: false, padrao: false, ativo: true }))).toEqual(
      ['vendavel', 'padrao'],
    );
    const cascos = { chaveSistema: 'vasilhame_vazio', padrao: false };
    expect(
      Object.keys(errosRegraTipoEstoque(cascos, { vendavel: true, padrao: false, ativo: false })),
    ).toEqual(['vendavel', 'ativo']);
    // Avaria e os tipos da empresa: livres (a regra do saldo zero para inativar é da API).
    const avaria = { chaveSistema: 'avaria', padrao: false };
    expect(errosRegraTipoEstoque(avaria, { vendavel: true, padrao: false, ativo: false })).toEqual({});
    expect(errosRegraTipoEstoque(null, { vendavel: true, padrao: true, ativo: true })).toEqual({});
  });
});
