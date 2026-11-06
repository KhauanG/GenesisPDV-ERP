import { describe, expect, it } from 'vitest';
import { dec } from './decimal.js';
import { gerador } from './gerador.teste.js';
import {
  alterarRecebimentoSchema,
  baseMarkupRecebimentoTexto,
  consultaDadosCompraSchema,
  contasEntradaRecebimentoTexto,
  criarRecebimentoSchema,
  estornarRecebimentoSchema,
  filtroRecebimentosSchema,
  hojeNoFuso,
  LIMITE_ITENS_RECEBIMENTO,
  LIMITE_PRODUTOS_DADOS_COMPRA,
  markupPrecoRecebimento,
  movimentarRecebimentoSchema,
  ratearProporcionalTexto,
  totaisRecebimentoTexto,
  valoresItemRecebimentoTexto,
} from './recebimentos.js';

const ID = '01890000-0000-7000-8000-000000000001';
const PRODUTO = '01890000-0000-7000-8000-000000000002';

const base = { lojaId: ID, fornecedorId: ID, dataRecebimento: '2026-11-01' };
const item = (extra: Record<string, unknown> = {}) => ({
  produtoId: PRODUTO,
  quantidade: '10',
  precoCompra: '60',
  ...extra,
});

/** Os caminhos com erro (`itens.0.lote`, `valorDesconto`…). */
function erros(corpo: unknown): string[] {
  const r = criarRecebimentoSchema.safeParse(corpo);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
}

describe('contrato do recebimento (F2-B14; ERP 13.3; MD 3.8.1)', () => {
  it('normaliza decimais com vírgula, aplica os padrões e aceita estoque e tipo vazios', () => {
    const r = criarRecebimentoSchema.parse({
      ...base,
      estoqueId: '',
      valorFrete: '12,5',
      codigoRemessa: '  NF 1234 ',
      itens: [item({ fator: '12', precoCompra: '1.234,5678' })],
    });
    expect(r).toMatchObject({
      estoqueId: null,
      tipoEstoqueId: null,
      codigoRemessa: 'NF 1234',
      temValidade: false,
      valorFrete: '12.50',
      valorDesconto: '0.00',
      valorOutrasDespesas: '0.00',
      observacoes: null,
    });
    expect(r.itens[0]).toMatchObject({
      id: null,
      codigoBarrasId: null,
      fator: '12.000',
      quantidade: '10.000',
      precoCompra: '1234.5678',
      atualizarPreco: 'nao',
      markupPct: null,
      precoVenda: null,
      lote: null,
      validade: null,
      fabricacao: null,
    });
    // Sem fator, 1; sem data, nula: o "hoje" é o da loja destinatária, que a API aplica (ERP 1.5).
    const s = criarRecebimentoSchema.parse({ lojaId: ID, fornecedorId: ID, itens: [item()] });
    expect(s.itens[0]!.fator).toBe('1.000');
    expect(s.dataRecebimento).toBeNull();
    expect(criarRecebimentoSchema.parse({ ...base, dataRecebimento: '' }).dataRecebimento).toBeNull();
  });

  it('hoje no fuso: o mesmo instante é um dia em Rio Branco e o seguinte em Brasília', () => {
    // 06/11 00:30 em Brasília (UTC-3) = 05/11 22:30 em Rio Branco (UTC-5).
    const agora = new Date('2026-11-06T03:30:00Z');
    expect(hojeNoFuso(agora)).toBe('2026-11-06');
    expect(hojeNoFuso(agora, 'America/Rio_Branco')).toBe('2026-11-05');
    // A data futura não é do contrato (o fuso é o da loja): passa aqui e a API recusa.
    expect(erros({ ...base, dataRecebimento: '2999-01-01' })).toEqual([]);
    expect(erros({ ...base, itens: [item({ lote: 'L1', fabricacao: '2999-01-01' })] })).toEqual([]);
  });

  it('recusa data inválida, quantidade e fator zero e o desconto maior que o total', () => {
    expect(erros({ ...base, dataRecebimento: '2026-02-30' })).toEqual(['dataRecebimento']);
    expect(erros({ ...base, itens: [item({ quantidade: '0' }), item({ fator: '0' })] })).toEqual([
      'itens.0.quantidade',
      'itens.1.fator',
    ]);
    expect(erros({ ...base, itens: [item({ quantidade: '-1' })] })).toEqual(['itens.0.quantidade']);
    // 10 × 60 = 600 + 5 de frete: desconto de 605 zera, de 605,01 passa.
    expect(erros({ ...base, valorFrete: '5', valorDesconto: '605', itens: [item()] })).toEqual([]);
    expect(erros({ ...base, valorFrete: '5', valorDesconto: '605.01', itens: [item()] })).toEqual([
      'valorDesconto',
    ]);
    expect(
      erros({ ...base, itens: Array.from({ length: LIMITE_ITENS_RECEBIMENTO + 1 }, () => item()) }),
    ).toEqual(['itens']);
  });

  it('lote e validade: obrigatórios com "Tem prazo de validade"; validade e fabricação exigem lote', () => {
    expect(erros({ ...base, temValidade: true, itens: [item()] })).toEqual([
      'itens.0.lote',
      'itens.0.validade',
    ]);
    expect(
      erros({ ...base, temValidade: true, itens: [item({ lote: 'L1', validade: '2027-01-31' })] }),
    ).toEqual([]);
    expect(erros({ ...base, itens: [item({ validade: '2027-01-31' })] })).toEqual(['itens.0.lote']);
    expect(
      erros({ ...base, itens: [item({ lote: 'L1', validade: '2026-01-01', fabricacao: '2026-02-01' })] }),
    ).toEqual(['itens.0.fabricacao']);
  });

  it('o mesmo item (id) duas vezes é recusado na segunda linha; itens novos e produtos repetidos passam', () => {
    const ITEM = '01890000-0000-7000-8000-000000000009';
    expect(
      erros({ ...base, itens: [item({ id: ITEM }), item({ id: ITEM.toUpperCase(), quantidade: '5' })] }),
    ).toEqual(['itens.1.id']);
    const r = criarRecebimentoSchema.safeParse({ ...base, itens: [item({ id: ITEM }), item({ id: ITEM })] });
    expect(r.success ? '' : r.error.issues[0]!.message).toBe('Item repetido (linha 1)');
    // O mesmo produto em duas linhas é permitido no recebimento (preços ou lotes diferentes).
    expect(erros({ ...base, itens: [item({ id: ITEM }), item(), item()] })).toEqual([]);
  });

  it('quantidade × fator, total do item e total do cabeçalho têm de caber nas colunas', () => {
    // Cada campo dentro do teto, o produto fora: 10.000.000 × 999.999 ≈ 1e13 > numeric(15,3).
    expect(
      erros({ ...base, itens: [item({ quantidade: '10000000', fator: '999999', precoCompra: '0' })] }),
    ).toEqual(['itens.0.quantidade']);
    // 1.000.000 × R$ 99.999.999,00 ≈ 1e14 > numeric(15,2).
    expect(erros({ ...base, itens: [item({ quantidade: '1000000', precoCompra: '99999999' })] })).toEqual([
      'itens.0.quantidade',
      'itens',
    ]);
    // Perto do limite cabe: 999.999.999 × 1.000 = 999.999.999.000 ≤ 999.999.999.999,999.
    expect(
      erros({ ...base, itens: [item({ quantidade: '999999999', fator: '1000', precoCompra: '0' })] }),
    ).toEqual([]);
    // Dois itens que cabem sozinhos e somam mais que o cabeçalho aceita.
    const grande = item({ quantidade: '100000', precoCompra: '60000000' });
    expect(erros({ ...base, itens: [grande] })).toEqual([]);
    expect(erros({ ...base, itens: [grande, grande] })).toEqual(['itens']);
  });

  it('atualizar o preço exige o preço de venda; o markup aceita negativo', () => {
    expect(erros({ ...base, itens: [item({ atualizarPreco: 'loja' })] })).toEqual(['itens.0.precoVenda']);
    expect(
      erros({ ...base, itens: [item({ atualizarPreco: 'geral', precoVenda: '8,90', markupPct: '-10' })] }),
    ).toEqual([]);
    expect(erros({ ...base, itens: [item({ atualizarPreco: 'tudo' })] })).toEqual(['itens.0.atualizarPreco']);
  });

  it('alterar exige a versão', () => {
    expect(alterarRecebimentoSchema.safeParse({ ...base, itens: [] }).success).toBe(false);
    expect(alterarRecebimentoSchema.parse({ ...base, versao: 7, itens: [] }).versao).toBe(7);
  });

  it('contas do rascunho: quantidade × fator, total do item e "Total geral"', () => {
    expect(valoresItemRecebimentoTexto({ quantidade: '10', fator: '12', precoCompra: '60' })).toEqual({
      quantidadeEstoque: '120.000',
      valorTotal: '600.00',
    });
    // Cada item arredonda a 2 casas antes de somar.
    expect(
      valoresItemRecebimentoTexto({ quantidade: '3', fator: '1', precoCompra: '0.3333' }).valorTotal,
    ).toBe('1.00');
    expect(
      totaisRecebimentoTexto(
        [
          { quantidade: '10', fator: '12', precoCompra: '60' },
          { quantidade: '3', fator: '1', precoCompra: '0.3333' },
        ],
        { valorFrete: '12', valorDesconto: '2.5', valorOutrasDespesas: '1' },
      ),
    ).toEqual({ qtdItens: 2, valorProdutos: '601.00', valorTotal: '611.50' });
  });

  it('filtros da listagem', () => {
    expect(
      filtroRecebimentosSchema.parse({ codigo: '12', status: 'movimentado', dataInicial: '2026-11-01' }),
    ).toMatchObject({ codigo: 12, status: 'movimentado', dataInicial: '2026-11-01', pagina: 1, tamanho: 20 });
    expect(filtroRecebimentosSchema.safeParse({ status: 'aberto' }).success).toBe(false);
    // A data impossível é 422 no contrato (e não o 22008 do `::date`, que sairia 500).
    expect(filtroRecebimentosSchema.safeParse({ dataInicial: '2026-02-30' }).success).toBe(false);
    expect(filtroRecebimentosSchema.safeParse({ dataFinal: '2026-13-01' }).success).toBe(false);
  });
});

describe('rateio e custo final da movimentação (F2-B15; ERP 13.3)', () => {
  it('o rateio fecha com o total em 1.000 casos aleatórios, sem parte negativa e com o resíduo no maior item', () => {
    const g = gerador(15);
    for (let caso = 0; caso < 1000; caso++) {
      const n = g.inteiro(1, caso % 10 === 0 ? 990 : 40);
      // Pesos de vários tamanhos, com zeros e empates; totais de 1 centavo a 1 milhão (os pequenos forçam o resíduo).
      const pesos = Array.from({ length: n }, () =>
        g.inteiro(0, 9) === 0 ? '0.00' : g.decimal(10 ** g.inteiro(0, 5), 2, true),
      );
      const total = caso % 4 === 0 ? g.decimal(1, 2, true) : g.decimal(10 ** g.inteiro(0, 6), 2, true);
      const partes = ratearProporcionalTexto(total, pesos);
      expect(partes).toHaveLength(n);
      const soma = partes.reduce((s, p) => s.plus(p), dec(0));
      expect(soma.toFixed(2), `caso ${caso}`).toBe(dec(total).toFixed(2));
      for (const p of partes) {
        expect(dec(p).gte(0), `caso ${caso}: ${p}`).toBe(true);
        expect(p).toMatch(/^\d+\.\d{2}$/);
      }
      // Fora do maior peso, cada parte fica a menos de 1 centavo da conta exata.
      const base = pesos.reduce((s, p) => s.plus(p), dec(0));
      if (base.gt(0)) {
        const maior = pesos.reduce((m, p, i) => (dec(p).gt(pesos[m]!) ? i : m), 0);
        partes.forEach((p, i) => {
          if (i === maior) return;
          const exata = dec(total).times(pesos[i]!).div(base);
          expect(dec(p).minus(exata).abs().lt('0.01'), `caso ${caso} item ${i}`).toBe(true);
        });
      }
    }
  });

  it('rateio: proporcional, resíduo no maior, sem pesos por partes iguais e o total pequeno sem parte negativa', () => {
    expect(ratearProporcionalTexto('10.00', ['1', '1', '1'])).toEqual(['3.34', '3.33', '3.33']);
    expect(ratearProporcionalTexto('10.00', ['100', '300', '100'])).toEqual(['2.00', '6.00', '2.00']);
    // 3 × 0,17 + 0,50 = 1,01: o resíduo de −0,01 vai para o maior (o último), não para o primeiro.
    expect(ratearProporcionalTexto('1.00', ['1', '1', '1', '3'])).toEqual(['0.17', '0.17', '0.17', '0.49']);
    expect(ratearProporcionalTexto('1.00', ['1', '2', '0'])).toEqual(['0.33', '0.67', '0.00']);
    expect(ratearProporcionalTexto('0.00', ['5', '5'])).toEqual(['0.00', '0.00']);
    expect(ratearProporcionalTexto('9.00', ['0', '0', '0'])).toEqual(['3.00', '3.00', '3.00']);
    // 10 × 0,005 arredondados dariam 0,10 para um total de 0,05: os outros truncam e o maior fica com o resto.
    const pequeno = ratearProporcionalTexto(
      '0.05',
      Array.from({ length: 10 }, () => '1'),
    );
    expect(pequeno).toEqual(['0.05', ...Array.from({ length: 9 }, () => '0.00')]);
    expect(ratearProporcionalTexto('5.00', [])).toEqual([]);
  });

  it('custo final: 10 fardos × 12 a R$ 60,00 com frete de R$ 12,00 = R$ 5,10 (critério de pronto)', () => {
    expect(
      contasEntradaRecebimentoTexto([{ quantidade: '10', fator: '12', precoCompra: '60' }], {
        valorFrete: '12.00',
        valorDesconto: '0',
        valorOutrasDespesas: '0',
      }),
    ).toEqual([
      { rateioFrete: '12.00', rateioDesconto: '0.00', rateioOutras: '0.00', custoUnitarioFinal: '5.1000' },
    ]);
    // Dois itens: frete, desconto e outras pelo total de cada um; o custo a 4 casas na unidade do produto.
    const [a, b] = contasEntradaRecebimentoTexto(
      [
        { quantidade: '10', fator: '12', precoCompra: '60' },
        { quantidade: '3', fator: '1', precoCompra: '10' },
      ],
      { valorFrete: '12.60', valorDesconto: '6.30', valorOutrasDespesas: '0.63' },
    );
    expect(a).toEqual({
      rateioFrete: '12.00',
      rateioDesconto: '6.00',
      rateioOutras: '0.60',
      custoUnitarioFinal: '5.0550',
    });
    expect(b).toEqual({
      rateioFrete: '0.60',
      rateioDesconto: '0.30',
      rateioOutras: '0.03',
      custoUnitarioFinal: '10.1100',
    });
    // Item de R$ 0,00 (bonificação) sem frete: custo 0.
    expect(
      contasEntradaRecebimentoTexto([{ quantidade: '2', fator: '1', precoCompra: '0' }], {
        valorFrete: '0',
        valorDesconto: '0',
        valorOutrasDespesas: '0',
      })[0]!.custoUnitarioFinal,
    ).toBe('0.0000');
  });

  it('contratos de movimentar e estornar', () => {
    expect(movimentarRecebimentoSchema.parse({})).toEqual({ atualizarPrecoCusto: null });
    expect(movimentarRecebimentoSchema.parse({ versao: 3, atualizarPrecoCusto: true })).toEqual({
      versao: 3,
      atualizarPrecoCusto: true,
    });
    expect(movimentarRecebimentoSchema.safeParse({ atualizarPrecoCusto: 'sim' }).success).toBe(false);
    expect(estornarRecebimentoSchema.safeParse({ versao: 1 }).success).toBe(false);
    expect(estornarRecebimentoSchema.safeParse({ versao: 1, motivo: '  ' }).success).toBe(false);
    expect(estornarRecebimentoSchema.parse({ motivo: 'Entrada em duplicidade' }).motivo).toBe(
      'Entrada em duplicidade',
    );
    // D56 com aviso: a confirmação do saldo negativo é a lista mostrada (vazia por padrão), não um "sim" geral; os
    // campos de exibição da lista (nome, saldo atual) vêm junto e são ignorados.
    expect(estornarRecebimentoSchema.parse({ motivo: 'x' }).confirmarNegativo).toEqual([]);
    const pid = '0190a000-0000-7000-8000-000000000011';
    expect(
      estornarRecebimentoSchema.parse({
        motivo: 'x',
        confirmarNegativo: [
          { produtoId: pid, nome: 'Cerveja', lote: null, saldoAtual: '2.000', saldoFinal: '-8.000' },
          { produtoId: pid, lote: 'L-1', saldoFinal: '-0.5' },
        ],
      }).confirmarNegativo,
    ).toEqual([
      { produtoId: pid, lote: null, saldoFinal: '-8.000' },
      { produtoId: pid, lote: 'L-1', saldoFinal: '-0.500' },
    ]);
    for (const confirmarNegativo of [
      true,
      'sim',
      [{ produtoId: 'x', lote: null, saldoFinal: '-1' }],
      [{ produtoId: pid, lote: null, saldoFinal: '1' }],
      [{ produtoId: pid, saldoFinal: '-1' }],
    ])
      expect(estornarRecebimentoSchema.safeParse({ motivo: 'x', confirmarNegativo }).success).toBe(false);
  });
});

describe('markup ⇄ preço da tela do recebimento (F2-B16; D49)', () => {
  const comum = {
    compraAtualizaPrecoCusto: 'perguntar' as const,
    custoFinal: '5.1000',
    quantidadeEstoque: '120',
    precoCusto: '4.0000',
    saldo: '60.000',
    custoMedio: '4.5000',
  };

  it('a base segue produtos.custo_base_margem', () => {
    // Preço de custo (padrão): o custo final, que a movimentação leva ao preço de custo.
    expect(baseMarkupRecebimentoTexto({ ...comum, base: 'preco_custo' })).toBe('5.1000');
    // Com "nunca", o preço de custo não muda: fica o atual.
    expect(
      baseMarkupRecebimentoTexto({ ...comum, base: 'preco_custo', compraAtualizaPrecoCusto: 'nunca' }),
    ).toBe('4.0000');
    expect(baseMarkupRecebimentoTexto({ ...comum, base: 'ultimo_custo' })).toBe('5.1000');
    // Custo médio depois da entrada: (60 × 4,50 + 120 × 5,10) / 180 = 4,90.
    expect(baseMarkupRecebimentoTexto({ ...comum, base: 'custo_medio' })).toBe('4.9000');
  });

  it('sem o custo do produto (sem produtos.ver_custo), a base é o custo da compra', () => {
    const semCusto = { ...comum, precoCusto: null, custoMedio: null };
    expect(
      baseMarkupRecebimentoTexto({ ...semCusto, base: 'preco_custo', compraAtualizaPrecoCusto: 'nunca' }),
    ).toBe('5.1000');
    expect(baseMarkupRecebimentoTexto({ ...semCusto, base: 'custo_medio' })).toBe('5.1000');
  });

  it('vale o último digitado: markup recalcula o preço, preço recalcula o markup', () => {
    // Markup digitado: o preço acompanha a base, a 2 casas.
    expect(markupPrecoRecebimento('5.1000', { precoVenda: '8.00', markup: '50' })).toEqual({
      precoVenda: '7.65',
      markupPct: '50.0000',
    });
    expect(markupPrecoRecebimento('5.5000', { precoVenda: '8.00', markup: '50' }).precoVenda).toBe('8.25');
    // Preço digitado: o markup é o do preço sobre a base, a 4 casas.
    expect(markupPrecoRecebimento('5.1000', { precoVenda: '7.99', markup: null })).toEqual({
      precoVenda: '7.9900',
      markupPct: '56.6667',
    });
    // Base zero (bonificação): sem markup.
    expect(markupPrecoRecebimento('0', { precoVenda: '7.99', markup: null }).markupPct).toBeNull();
    expect(markupPrecoRecebimento('5', { precoVenda: null, markup: null })).toEqual({
      precoVenda: null,
      markupPct: null,
    });
  });

  it('consulta dos dados de compra: lista de ids separada por vírgula', () => {
    expect(consultaDadosCompraSchema.parse({ produtoIds: `${ID},${PRODUTO}` }).produtoIds).toEqual([
      ID,
      PRODUTO,
    ]);
    expect(consultaDadosCompraSchema.safeParse({ produtoIds: '' }).success).toBe(false);
    expect(consultaDadosCompraSchema.safeParse({ produtoIds: 'x' }).success).toBe(false);
    // A loja destinatária (o preço próprio dela) é opcional; o teto de ids por consulta, o do contrato.
    expect(consultaDadosCompraSchema.parse({ produtoIds: ID, lojaId: PRODUTO }).lojaId).toBe(PRODUTO);
    expect(consultaDadosCompraSchema.safeParse({ produtoIds: ID, lojaId: 'x' }).success).toBe(false);
    const ids = (n: number) => Array.from({ length: n }, () => ID).join(',');
    expect(
      consultaDadosCompraSchema.safeParse({ produtoIds: ids(LIMITE_PRODUTOS_DADOS_COMPRA) }).success,
    ).toBe(true);
    expect(
      consultaDadosCompraSchema.safeParse({ produtoIds: ids(LIMITE_PRODUTOS_DADOS_COMPRA + 1) }).success,
    ).toBe(false);
  });
});
