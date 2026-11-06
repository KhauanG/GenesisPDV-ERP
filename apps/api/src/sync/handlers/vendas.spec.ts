/**
 * Funções puras do handler `venda.finalizada` (bloco C6b da 1C): as conferências de soma da SYNC 9.7 (P6: viram
 * `VENDA_INCONSISTENTE`, não recusa), o custo do item com a ficha mista (T22) e a ordem dos itens para o `INSERT` em
 * blocos (o casco cobrado depois do cheio). A fixture do C4 é a venda que fecha: cada teste estraga uma conta.
 */
import { readFileSync } from 'node:fs';
import { payloadVendaFinalizadaSchema, type PayloadVendaFinalizada } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import type { CadastroProdutoEstoque } from '../../estoques/movimentos.js';
import { conferirSomasVenda, custoDosItens, ordenarCheiosAntes, pessoasDaVenda } from './vendas.js';

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
