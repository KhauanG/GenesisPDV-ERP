/**
 * Funções puras do handler `venda.cancelada` forma A (bloco C7 da 1C): a conferência do `estorno` de cada pagamento
 * com o pagamento gravado (SYNC 9.9; O22 do dono), os estornos do estoque, cada saída ao custo dela e na data do
 * cancelamento, e os vazios trazidos conforme `pdv.cancelamento_devolve_vazios` (SYNC 10.4; T20, D29), e a
 * comparação de dois cancelamentos do caixa na corrida com o ERP. A fixture do C4 é o cancelamento que confere.
 */
import { readFileSync } from 'node:fs';
import { payloadVendaCanceladaFinalizadaSchema, type PayloadVendaCanceladaFinalizada } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import type { TerminalDoEvento } from '../aplicacao.js';
import type { EnvelopeEvento } from '../contratos.js';
import {
  divergenciasDoCaixa,
  ESTORNO_DO_MOVIMENTO,
  estornosDaVenda,
  estornosInvalidos,
  tiposEstornados,
  type MovimentoDaVenda,
  type PagamentoConferido,
} from './cancelamento.js';

const FIXTURE = new URL(
  '../../../../../packages/shared/testes/sync/venda.cancelada.finalizada.payload.json',
  import.meta.url,
);
const fixture = (): PayloadVendaCanceladaFinalizada =>
  payloadVendaCanceladaFinalizadaSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));

/** Os três pagamentos da fixture: dinheiro, crédito POS e PIX (SYNC 9.9). */
const gravados = (
  tipos: [string, string, string] = ['dinheiro', 'cartao_credito', 'pix'],
  extra: Partial<PagamentoConferido> = {},
) => {
  const ids = fixture().pagamentos_venda.map((pg) => pg.id);
  return new Map<string, PagamentoConferido>(ids.map((id, n) => [id, { tipoForma: tipos[n]!, ...extra }]));
};
/** Os `tipo_forma` das formas dos dois `estorno_venda` da fixture: Dinheiro e o cartão. */
const FORMAS_DA_FIXTURE = new Set(['dinheiro', 'cartao_credito']);

describe('estornosInvalidos (SYNC 9.9)', () => {
  it('a fixture confere: dinheiro devolvido, cartão cancelado na maquininha e PIX devolvido em dinheiro', () => {
    expect(estornosInvalidos(fixture().pagamentos_venda, gravados(), FORMAS_DA_FIXTURE)).toEqual([]);
  });

  it('dinheiro_devolvido fora da forma dinheiro e devolvido_em_dinheiro na forma dinheiro', () => {
    const p = fixture();
    p.pagamentos_venda[0]!.estorno = 'devolvido_em_dinheiro';
    p.pagamentos_venda[1]!.estorno = 'dinheiro_devolvido';
    expect(estornosInvalidos(p.pagamentos_venda, gravados(), FORMAS_DA_FIXTURE)).toEqual([
      {
        pagamento_venda_id: p.pagamentos_venda[0]!.id,
        estorno: 'devolvido_em_dinheiro',
        motivo: 'estorno incompatível com a forma',
        tipo_forma: 'dinheiro',
      },
      {
        pagamento_venda_id: p.pagamentos_venda[1]!.id,
        estorno: 'dinheiro_devolvido',
        motivo: 'estorno incompatível com a forma',
        tipo_forma: 'cartao_credito',
      },
    ]);
  });

  it('pagamento que não é da venda; id em maiúsculas é o mesmo pagamento', () => {
    const p = fixture();
    p.pagamentos_venda[0]!.id = p.pagamentos_venda[0]!.id.toUpperCase();
    p.pagamentos_venda.push({
      id: '01a18799-0000-7000-8000-000000000001',
      status: 'estornado',
      estorno: 'transferido',
    });
    expect(estornosInvalidos(p.pagamentos_venda, gravados(), FORMAS_DA_FIXTURE)).toEqual([
      {
        pagamento_venda_id: '01a18799-0000-7000-8000-000000000001',
        estorno: 'transferido',
        motivo: 'pagamento de outra venda',
      },
    ]);
  });

  it('o mesmo pagamento citado duas vezes com estornos diferentes: o segundo é recusado', () => {
    const p = fixture();
    p.pagamentos_venda.push({ ...p.pagamentos_venda[1]!, estorno: 'devolvido_em_dinheiro' });
    expect(estornosInvalidos(p.pagamentos_venda, gravados(), FORMAS_DA_FIXTURE)).toEqual([
      {
        pagamento_venda_id: p.pagamentos_venda[1]!.id,
        estorno: 'devolvido_em_dinheiro',
        motivo: 'pagamento citado duas vezes',
      },
    ]);
  });

  it('a família do estorno combina com o pagamento: TEF com a transação, maquininha em cartão, PIX em PIX', () => {
    const p = fixture();
    const [, cartao, pix] = p.pagamentos_venda;
    const caso = (estorno: string, n: 1 | 2, extra: Partial<PagamentoConferido> = {}) => {
      const q = fixture();
      q.pagamentos_venda[n]!.estorno = estorno as never;
      return estornosInvalidos(q.pagamentos_venda, gravados(undefined, extra), FORMAS_DA_FIXTURE).map((i) => [
        i.pagamento_venda_id,
        i.motivo,
      ]);
    };
    const incompativel = (id: string) => [[id, 'estorno incompatível com a forma']];
    // PIX num cartão, maquininha num PIX, TEF sem a transação TEF.
    expect(caso('pix_devolvido_api', 1)).toEqual(incompativel(cartao!.id));
    expect(caso('pos_cancelado_na_maquininha', 2)).toEqual(incompativel(pix!.id));
    expect(caso('tef_cancelado', 1)).toEqual(incompativel(cartao!.id));
    expect(caso('tef_estorno_pendente', 1)).toEqual(incompativel(cartao!.id));
    // Os que combinam: TEF com a transação, PIX devolvido ou pendente no PIX.
    expect(caso('tef_cancelado', 1, { tefTransacaoId: '01a18799-0000-7000-8000-0000000000aa' })).toEqual([]);
    expect(caso('pix_devolucao_pendente', 2)).toEqual([]);
    expect(caso('pix_devolucao_manual', 2)).toEqual([]);
    // Débito e os vales passam na maquininha.
    for (const tipo of ['cartao_debito', 'vale_alimentacao', 'vale_refeicao']) {
      const q = fixture();
      expect(
        estornosInvalidos(q.pagamentos_venda, gravados(['dinheiro', tipo, 'pix']), FORMAS_DA_FIXTURE),
        tipo,
      ).toEqual([]);
    }
  });

  it('devolvido_em_dinheiro exige um estorno_venda na forma Dinheiro (D24)', () => {
    const p = fixture();
    expect(estornosInvalidos(p.pagamentos_venda, gravados(), new Set(['cartao_credito']))).toEqual([
      {
        pagamento_venda_id: p.pagamentos_venda[2]!.id,
        estorno: 'devolvido_em_dinheiro',
        motivo: 'devolvido em dinheiro sem estorno_venda na forma Dinheiro',
        tipo_forma: 'pix',
      },
    ]);
  });
});

describe('estornosDaVenda (SYNC 10.4; T20, D29)', () => {
  const saida = (tipo: string, extra: Partial<MovimentoDaVenda> = {}): MovimentoDaVenda => ({
    id: `0190a000-0000-7000-8000-00000000000${Object.keys(ESTORNO_DO_MOVIMENTO).indexOf(tipo)}`,
    estoque_id: 'e',
    loja_id: 'l',
    tipo_estoque_id: 't',
    produto_id: 'p',
    variacao_id: null,
    lote_id: null,
    tipo_movimento: tipo,
    quantidade: '-12.000',
    custo_unitario: '2.5000',
    preco_venda: '3.2900',
    unidade_documento: 'FD',
    fator: '12.000',
    pessoa_id: null,
    documento_item_id: 'item',
    ...extra,
  });
  const ctx = {
    terminal: { terminalId: 'terminal' } as TerminalDoEvento,
    evento: { evento_id: 'evento' } as EnvelopeEvento,
  };

  it('cada saída volta com estorno_de_id, sinal oposto, o custo dela e a data do cancelamento', () => {
    const p = fixture();
    const linhas = estornosDaVenda(ctx, p, [
      saida('VENDA_PDV'),
      saida('VASILHAME_VENDIDO', { quantidade: '-2.000', custo_unitario: '1.0000' }),
      saida('BAIXA_INSUMO', { quantidade: '-0.050', custo_unitario: '30.0000' }),
    ]);
    expect(linhas.map((l) => [l.tipoMovimento, l.quantidade, l.custoUnitario, l.estornoDeId])).toEqual([
      ['CANC_VENDA_PDV', '12.000', '2.5000', saida('VENDA_PDV').id],
      ['CANC_VENDA_PDV', '2.000', '1.0000', saida('VASILHAME_VENDIDO').id],
      ['ESTORNO_BAIXA_INSUMO', '0.050', '30.0000', saida('BAIXA_INSUMO').id],
    ]);
    expect(linhas[0]).toMatchObject({
      dataMovimento: new Date(p.vendas.cancelada_em),
      usuarioId: p.vendas.cancelada_por_id,
      documentoTipo: 'venda',
      documentoId: p.vendas.id,
      documentoItemId: 'item',
      unidadeDocumento: 'FD',
      fator: '12.000',
      terminalId: 'terminal',
      eventoId: 'evento',
    });
  });

  it('os vazios trazidos (VASILHAME_DEVOLVIDO) voltam com a chave ligada (padrão, D29) e ficam com ela desligada', () => {
    expect(tiposEstornados(true)).toContain('VASILHAME_DEVOLVIDO');
    expect(tiposEstornados(false)).toEqual(['VENDA_PDV', 'VASILHAME_VENDIDO', 'BAIXA_INSUMO']);
    const [vazios] = estornosDaVenda(ctx, fixture(), [
      saida('VASILHAME_DEVOLVIDO', { quantidade: '12.000', custo_unitario: '1.2000', preco_venda: null }),
    ]);
    // A entrada dos vazios volta como saída (o motor a lança ao custo médio da linha).
    expect([vazios!.tipoMovimento, vazios!.quantidade, vazios!.estornoDeId]).toEqual([
      'ESTORNO_VASILHAME_DEVOLVIDO',
      '-12.000',
      saida('VASILHAME_DEVOLVIDO').id,
    ]);
  });
});

describe('divergenciasDoCaixa (SYNC 10.4, corrida com o ERP)', () => {
  const registro = () => ({
    cancelada_em: '2026-10-29T17:52:11.090Z',
    cancelada_por_id: '01a18754-76cb-7b74-b2e7-06298fadc1a6',
    cancelamento_autorizado_por_id: null,
    motivo_cancelamento: 'Cliente desistiu da compra apos o pagamento',
    sessao_caixa_cancelamento_id: '01a18755-98a1-7472-96da-1dac72ff5d2a',
    estornos: [
      { pagamento_venda_id: 'A1', estorno: 'dinheiro_devolvido' as const },
      { pagamento_venda_id: 'b2', estorno: 'pos_cancelado_na_maquininha' as const },
    ],
    movimentos_caixa: [
      { id: 'm1', forma_pagamento_id: 'f1', valor: '10.00' },
      { id: 'm2', forma_pagamento_id: 'f2', valor: '5.00' },
    ],
  });

  it('o mesmo cancelamento gerado de novo (ordem, maiúsculas e a hora com outro fuso) não diverge', () => {
    const novo = registro();
    novo.cancelada_em = '2026-10-29T14:52:11.090-03:00';
    novo.cancelada_por_id = novo.cancelada_por_id.toUpperCase();
    novo.estornos.reverse();
    novo.estornos[1]!.pagamento_venda_id = 'a1';
    novo.movimentos_caixa.reverse();
    expect(divergenciasDoCaixa(registro(), novo)).toEqual([]);
  });

  it('outro motivo, outro estorno e outro movimento de gaveta divergem', () => {
    const novo = registro();
    novo.motivo_cancelamento = 'Outro motivo qualquer para cancelar';
    novo.estornos[1]!.estorno = 'devolvido_em_dinheiro' as never;
    novo.movimentos_caixa[0]!.id = 'm3';
    expect(divergenciasDoCaixa(registro(), novo)).toEqual([
      'motivo_cancelamento',
      'pagamentos_venda',
      'movimentos_caixa',
    ]);
  });
});
