/**
 * Funções puras do handler `venda.finalizada` (bloco C6b da 1C): as conferências de soma da SYNC 9.7 (P6: viram
 * `VENDA_INCONSISTENTE`, não recusa), o custo do item com a ficha mista (T22) e a ordem dos itens para o `INSERT` em
 * blocos (o casco cobrado depois do cheio). A fixture do C4 é a venda que fecha: cada teste estraga uma conta. Desde o
 * F3-B14, o que cada complemento faz no estoque (`baixaDoComplemento`) e o custo dele somado ao item.
 */
import { readFileSync } from 'node:fs';
import { payloadVendaFinalizadaSchema, type PayloadVendaFinalizada } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import type { CadastroProdutoEstoque } from '../../estoques/movimentos.js';
import {
  baixaDoComplemento,
  conferirSomasVenda,
  custoDosComplementos,
  custoDosItens,
  ordenarCheiosAntes,
  pessoasDaVenda,
  type ComplementoDaVenda,
} from './vendas.js';

const FIXTURE = new URL(
  '../../../../../packages/shared/testes/sync/venda.finalizada.payload.json',
  import.meta.url,
);
const fixture = (): PayloadVendaFinalizada =>
  payloadVendaFinalizadaSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));

const FIXTURE_FORMAS = new URL(
  '../../../../../packages/shared/testes/sync/venda.finalizada.formas.payload.json',
  import.meta.url,
);

describe('conferirSomasVenda (SYNC 9.7)', () => {
  it('a venda da fixture fecha todas as contas', () => {
    expect(conferirSomasVenda(fixture())).toEqual([]);
  });

  it('a venda do PDV com maquininha, PIX e ficha técnica (C11a) também fecha', () => {
    const p = payloadVendaFinalizadaSchema.parse(JSON.parse(readFileSync(FIXTURE_FORMAS, 'utf8')));
    expect(conferirSomasVenda(p)).toEqual([]);
    expect(p.itens_venda[0]!.componentes_estoque.map((c) => [c.quantidade, c.origem])).toEqual([
      ['0.550', 'ficha_tecnica'],
      ['0.100', 'ficha_tecnica'],
    ]);
    expect(p.cobrancas_pix[0]!.pagamento_venda_id).toBe(p.pagamentos_venda[1]!.id);
  });

  it('total diferente dos pagamentos aprovados; o pagamento cancelado não conta', () => {
    const p = fixture();
    p.vendas.total = '999.99';
    p.pagamentos_venda.push({ ...p.pagamentos_venda[0]!, id: 'x', sequencia: 2, status: 'cancelado' });
    expect(conferirSomasVenda(p)).toEqual([
      { regra: 'pagamentos', calculado: '181.30', informado: '999.99' },
    ]);
  });

  it('troco, subtotal bruto e valor líquido do item', () => {
    const p = fixture();
    p.vendas.troco = '20.00';
    p.vendas.subtotal_bruto = undefined; // ausente = o padrão do banco (zero)
    p.itens_venda[0]!.valor_liquido = '38.28'; // sem o desconto de 1,28
    expect(conferirSomasVenda(p)).toEqual([
      { regra: 'troco', calculado: '18.70', informado: '20.00' },
      { regra: 'subtotal_bruto', calculado: '182.58', informado: '0.00' },
      { regra: 'valor_liquido', calculado: '37.00', informado: '38.28', item_venda_id: p.itens_venda[0]!.id },
    ]);
  });

  it('combo cujos itens não somam o preço do combo; o item cancelado fica fora', () => {
    const p = fixture();
    const grupo = p.itens_venda[2]!.kit_grupo_id!;
    for (const i of p.itens_venda) if (i.kit_grupo_id) i.kit_preco_unitario = '120.0000';
    // O cancelado (água) não entra no subtotal nem no valor líquido, mesmo com valores que não fecham.
    p.itens_venda[1]!.valor_liquido = '0.01';
    expect(conferirSomasVenda(p)).toEqual([
      { regra: 'kit', calculado: '120.00', informado: '131.90', kit_grupo_id: grupo },
    ]);
  });
});

const produto = (id: string, precoCusto: string, controlaEstoque: boolean): CadastroProdutoEstoque => ({
  id,
  nome: id,
  tipo: 'materia_prima',
  controlaEstoque,
  precoCusto,
  sigla: 'UN',
  excluido: false,
  inativoDesde: null,
});

describe('custoDosItens (SYNC 10.2, T22)', () => {
  const item = (id: string, produtoId: string, quantidade: string, extra = {}) =>
    ({ id, produto_id: produtoId, quantidade, componentes_estoque: [], ...extra }) as never;
  const produtos = new Map([
    ['caipirinha', produto('caipirinha', '2.5000', false)],
    ['cachaca', produto('cachaca', '20.0000', true)],
    ['limao', produto('limao', '1.0000', false)],
    ['acucar', produto('acucar', '5.0000', false)],
    ['taxa', produto('taxa', '3.2500', false)],
    ['cerveja', produto('cerveja', '2.0000', true)],
  ]);

  it('ficha mista: o insumo que não baixa entra pelo custo de referência', () => {
    const caipirinha = item('i1', 'caipirinha', '1.000', {
      componentes_estoque: [
        { produto_id: 'cachaca', variacao_id: null, quantidade: '0.050', origem: 'ficha_tecnica' },
        { produto_id: 'limao', variacao_id: null, quantidade: '1.000', origem: 'ficha_tecnica' },
        { produto_id: 'acucar', variacao_id: null, quantidade: '0.100', origem: 'ficha_tecnica' },
      ],
    });
    // Cachaça: 0,05 × 20 = 1,00 (do movimento); limão 1,00 e açúcar 0,50 pela referência: 2,50, não 1,00.
    const r = custoDosItens([caipirinha], { produtos }, new Map([['i1', '1.00']]));
    expect(r).toEqual({ unitarios: ['2.5000'], total: '2.50' });
  });

  it('sem ficha: movimentos, custo de referência do item sem baixa e cancelado sem custo', () => {
    const r = custoDosItens(
      [
        item('i1', 'cerveja', '3.000'),
        item('i2', 'taxa', '2.000'),
        item('i3', 'cerveja', '1.000', { cancelado: true }),
      ],
      { produtos },
      new Map([['i1', '6.30']]),
    );
    expect(r).toEqual({ unitarios: ['2.1000', '3.2500', null], total: '12.80' });
  });
});

describe('complementos: baixa e custo (F3-B14; MD 3.6.8; SYNC 10.2)', () => {
  const produtos = new Map<string, CadastroProdutoEstoque>([
    ['porcao', produto('porcao', '8.0000', true)],
    ['molho', produto('molho', '0.7500', true)],
    ['sache', { ...produto('sache', '0.3000', false) }],
    // O Produzido, o kit e o serviço controlam estoque (o padrão do cadastro): o `referencia` deles vem do tipo.
    ['molho_casa', { ...produto('molho_casa', '9.0000', true), tipo: 'produzido' }],
    ['combo', { ...produto('combo', '5.0000', true), tipo: 'kit' }],
    ['montagem', { ...produto('montagem', '1.5000', true), tipo: 'servico' }],
    ['maionese', produto('maionese', '12.0000', true)],
    ['alho', produto('alho', '20.0000', false)],
  ]);
  const cad = { produtos };
  const vinculado = (produtoId: string | null, baixaEstoque = true, quantidadeBaixa = '1.000') => ({
    produtoId,
    baixaEstoque,
    quantidadeBaixa,
  });
  const linha = (quantidade?: string, componentes: unknown[] = []) =>
    ({ quantidade, componentes_estoque: componentes }) as never;
  const item = (quantidade: string, cancelado = false) => ({ quantidade, cancelado });

  it('vinculado com saldo próprio: VENDA_PDV de item × complemento × quantidade_baixa (3 casas)', () => {
    expect(
      baixaDoComplemento(2, item('2.000'), linha('2.000'), vinculado('molho', true, '0.030'), cad),
    ).toEqual({
      tipo: 'propria',
      produtoId: 'molho',
      quantidade: '0.120',
    });
    // Sem a quantidade na linha, o padrão do banco (1).
    expect(baixaDoComplemento(2, item('3.000'), linha(), vinculado('molho'), cad)).toMatchObject({
      quantidade: '3.000',
    });
  });

  it('não baixam: a v1, o livre, o sem baixa_estoque, o desconhecido, o do item cancelado e a conta que dá zero', () => {
    const nada = { tipo: 'nenhuma' };
    expect(baixaDoComplemento(1, item('1.000'), linha('1.000'), vinculado('molho'), cad)).toEqual(nada);
    expect(baixaDoComplemento(2, item('1.000'), linha('1.000'), vinculado(null, false), cad)).toEqual(nada);
    expect(baixaDoComplemento(2, item('1.000'), linha('1.000'), vinculado('molho', false), cad)).toEqual(
      nada,
    );
    expect(baixaDoComplemento(2, item('1.000'), linha('1.000'), undefined, cad)).toEqual(nada);
    expect(baixaDoComplemento(2, item('1.000', true), linha('1.000'), vinculado('molho'), cad)).toEqual(nada);
    expect(
      baixaDoComplemento(2, item('0.001'), linha('0.001'), vinculado('molho', true, '0.001'), cad),
    ).toEqual(nada);
  });

  it('vinculado sem controle de estoque ou kit, Produzido e serviço sem a ficha: só o custo de referência; com a ficha, a ficha', () => {
    expect(baixaDoComplemento(2, item('1.000'), linha('2.000'), vinculado('sache'), cad)).toEqual({
      tipo: 'referencia',
      produtoId: 'sache',
      quantidade: '2.000',
    });
    // Controla estoque, mas o tipo não tem saldo próprio (kit, Produzido, serviço): referência, nunca VENDA_PDV.
    for (const id of ['molho_casa', 'combo', 'montagem']) {
      expect(baixaDoComplemento(2, item('2.000'), linha('1.000'), vinculado(id), cad)).toEqual({
        tipo: 'referencia',
        produtoId: id,
        quantidade: '2.000',
      });
    }
    const ficha = [
      { produto_id: 'maionese', variacao_id: null, quantidade: '0.050', origem: 'ficha_tecnica' },
    ];
    expect(baixaDoComplemento(2, item('1.000'), linha('1.000', ficha), vinculado('molho_casa'), cad)).toEqual(
      {
        tipo: 'ficha',
      },
    );
  });

  it('o custo dos complementos soma ao do item antes da divisão (com movimento, referência e ficha mista)', () => {
    const complemento = (id: string, itemId: string, baixa: ComplementoDaVenda['baixa'], componentes = []) =>
      ({ linha: { id, componentes_estoque: componentes }, itemId, baixa }) as unknown as ComplementoDaVenda;
    const ficha = [
      { produto_id: 'maionese', variacao_id: null, quantidade: '0.100', origem: 'ficha_tecnica' },
      { produto_id: 'alho', variacao_id: null, quantidade: '0.010', origem: 'ficha_tecnica' },
    ] as never;
    const complementos = [
      complemento('c1', 'i1', { tipo: 'propria', produtoId: 'molho', quantidade: '2.000' }),
      complemento('c2', 'i1', { tipo: 'referencia', produtoId: 'sache', quantidade: '2.000' }),
      complemento('c3', 'i1', { tipo: 'ficha' }, ficha),
      complemento('c4', 'i1', { tipo: 'nenhuma' }),
      complemento('c5', 'i2', { tipo: 'referencia', produtoId: 'sache', quantidade: '1.000' }),
    ];
    const movimentos = new Map([
      ['i1', '16.00'],
      ['c1', '1.50'],
      ['c3', '1.20'],
    ]);
    const porItem = custoDosComplementos(complementos, cad, movimentos);
    // c1 1,50 (movimento) + c2 0,60 (2 × 0,30) + c3 1,20 (maionese) + 0,20 (alho 0,01 × 20) = 3,50; c5 0,30.
    expect([...porItem].map(([k, v]) => [k, v.toFixed(2)])).toEqual([
      ['i1', '3.50'],
      ['i2', '0.30'],
    ]);
    const itens = [
      { id: 'i1', produto_id: 'porcao', quantidade: '2.000', componentes_estoque: [] },
      { id: 'i2', produto_id: 'sache', quantidade: '3.000', componentes_estoque: [] },
      { id: 'i3', produto_id: 'sache', quantidade: '1.000', componentes_estoque: [] },
    ] as never;
    // i1: (16,00 + 3,50) ÷ 2; i2 sem baixa: (3 × 0,30 + 0,30) ÷ 3; i3 sem complemento, como antes.
    expect(custoDosItens(itens, cad, movimentos, porItem)).toEqual({
      unitarios: ['9.7500', '0.4000', '0.3000'],
      total: '21.00',
    });
    // Sem complementos, a conta de antes.
    expect(custoDosItens(itens, cad, movimentos)).toEqual({
      unitarios: ['8.0000', '0.3000', '0.3000'],
      total: '17.20',
    });
  });
});

describe('ordem e pessoas da venda', () => {
  it('ordenarCheiosAntes põe o casco cobrado depois do item cheio', () => {
    const casco = { id: 'c', vasilhameItemOrigemId: 'b' };
    const r = ordenarCheiosAntes([casco, { id: 'a' }, { id: 'b' }]);
    expect(r.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('pessoasDaVenda junta cliente, pagamentos e cascos', () => {
    const p = fixture();
    p.vendas.cliente_id = 'cli';
    p.pagamentos_venda[0]!.pessoa_id = 'pag';
    p.vasilhames[0]!.pessoa_id = 'casco';
    expect(pessoasDaVenda(p)).toEqual(['cli', 'pag', 'casco']);
  });
});
