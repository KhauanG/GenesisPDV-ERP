import { aceitaNovoNumero, eventoCritico } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { confirmacaoConfere, confirmacaoDescarte, resumoDoAgregado, vendaDoPayload } from './fila-decisao.js';

const vendaFinalizada = {
  vendas: { id: '01928f3a-0000-7000-8000-0000000000a1', numero_exibicao: 'L01-C02-000123', total: '1071.58' },
  itens_venda: [{}, {}, {}, {}],
};

describe('resumo do agregado (ERP 12.5)', () => {
  it('venda: número, total e itens; a forma A pega o número da venda gravada', () => {
    expect(resumoDoAgregado('venda.finalizada', vendaFinalizada)).toBe(
      'Venda L01-C02-000123 · R$ 1.071,58 · 4 itens',
    );
    expect(
      resumoDoAgregado('venda.cancelada', {
        vendas: { ...vendaFinalizada.vendas, status: 'cancelada', total: '5.00' },
        itens_venda: [{}],
      }),
    ).toBe('Venda cancelada em andamento L01-C02-000123 · R$ 5,00 · 1 item');
    expect(
      resumoDoAgregado('venda.cancelada', { vendas: { id: vendaFinalizada.vendas.id } }, 'L01-C02-000099'),
    ).toBe('Cancelamento da venda L01-C02-000099');
  });

  it('caixa e vasilhame; tipo sem resumo ou payload ilegível → null', () => {
    expect(resumoDoAgregado('caixa.aberto', { sessoes_caixa: { fundo_troco: '150.00' } })).toBe(
      'Abertura de caixa · fundo R$ 150,00',
    );
    // D19: o nome digitado de quem retira só com `incluirPessoais` (quem tem `terminais.gerenciar`).
    const sg = { movimentos_caixa: { valor: '200.00', quem_retira_nome: 'JOÃO' } };
    expect(resumoDoAgregado('caixa.sangria', sg)).toBe('Sangria · R$ 200,00');
    expect(resumoDoAgregado('caixa.sangria', sg, null, true)).toBe('Sangria · R$ 200,00 · JOÃO');
    expect(
      resumoDoAgregado('caixa.fechado', {
        fechamentos_caixa: { tipo: 'troca_turno', total_digitado: '10.00' },
      }),
    ).toBe('Troca de turno · contado R$ 10,00');
    expect(resumoDoAgregado('vasilhame.movimentado', { movimentos_vasilhame: { quantidade: '3.000' } })).toBe(
      'Devolução de cascos · 3 un.',
    );
    expect(resumoDoAgregado('auditoria.registros', { registros: [] })).toBeNull();
    expect(resumoDoAgregado('venda.finalizada', null)).toBeNull();
    expect(resumoDoAgregado('venda.finalizada', [] as never)).toBeNull();
  });
});

describe('confirmação do descarte (SYNC 11.4; T28)', () => {
  it('tipos críticos: o número da venda, senão a sequência; os outros não exigem', () => {
    expect(
      eventoCritico('venda.finalizada') && eventoCritico('caixa.fechado') && eventoCritico('nfce.emitida'),
    ).toBe(true);
    expect(eventoCritico('auditoria.registros') || eventoCritico('vasilhame.movimentado')).toBe(false);
    expect(confirmacaoDescarte('venda.finalizada', vendaFinalizada, 7)).toBe('L01-C02-000123');
    expect(confirmacaoDescarte('venda.cancelada', { vendas: { id: 'x' } }, 7, 'L01-C02-000099')).toBe(
      'L01-C02-000099',
    );
    expect(confirmacaoDescarte('venda.cancelada', { vendas: { id: 'x' } }, 7)).toBe('7');
    expect(confirmacaoDescarte('caixa.aberto', { sessoes_caixa: {} }, 12)).toBe('12');
    expect(confirmacaoDescarte('auditoria.registros', {}, 12)).toBeNull();
  });

  it('confere sem caixa e espaços, ou só pelos dígitos do fim', () => {
    expect(confirmacaoConfere('L01-C02-000123', 'l01-c02-000123')).toBe(true);
    expect(confirmacaoConfere('L01-C02-000123', ' L01 - C02 - 000123 ')).toBe(true);
    expect(confirmacaoConfere('L01-C02-000123', '123')).toBe(true);
    expect(confirmacaoConfere('L01-C02-000123', '000123')).toBe(true);
    expect(confirmacaoConfere('L01-C02-000123', '124')).toBe(false);
    expect(confirmacaoConfere('L01-C02-000123', 'C02')).toBe(false);
    expect(confirmacaoConfere('12', '12')).toBe(true);
    expect(confirmacaoConfere('12', '')).toBe(false);
    expect(confirmacaoConfere('12', null)).toBe(false);
  });

  it('a venda citada pelo payload só nos tipos de venda e fiscal', () => {
    expect(vendaDoPayload('venda.finalizada', vendaFinalizada)).toEqual({
      id: vendaFinalizada.vendas.id,
      numero: 'L01-C02-000123',
    });
    expect(vendaDoPayload('caixa.aberto', vendaFinalizada)).toEqual({ id: null, numero: null });
  });
});

describe('aplicar com novo número (SYNC 11.2)', () => {
  it('só o erro NUMERO_VENDA_DUPLICADO de um venda.*', () => {
    const base = { status: 'erro', erroCodigo: 'NUMERO_VENDA_DUPLICADO', tipo: 'venda.finalizada' };
    expect(aceitaNovoNumero(base)).toBe(true);
    expect(aceitaNovoNumero({ ...base, tipo: 'venda.cancelada' })).toBe(true);
    expect(aceitaNovoNumero({ ...base, status: 'retido' })).toBe(false);
    expect(aceitaNovoNumero({ ...base, erroCodigo: 'PAYLOAD_INVALIDO' })).toBe(false);
    expect(aceitaNovoNumero({ ...base, tipo: 'caixa.aberto' })).toBe(false);
  });
});
