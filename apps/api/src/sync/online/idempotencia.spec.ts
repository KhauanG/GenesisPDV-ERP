import { describe, expect, it } from 'vitest';
import { IdempotenciaOnline, OPERACAO_MAXIMA, resumoPedidoOnline } from './idempotencia.js';
import type { TerminalAutenticado } from '../terminal.js';
import type { Tenancy } from '../../tenancy/tenancy.js';

describe('resumoPedidoOnline (SYNC 20.4; F3-B6)', () => {
  it('não depende da ordem das chaves e separa parâmetros e corpo', () => {
    const base = resumoPedidoOnline({ parametros: { id: 'a' }, corpo: { valor: '3.00', pagamento: 'p' } });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(resumoPedidoOnline({ parametros: { id: 'a' }, corpo: { pagamento: 'p', valor: '3.00' } })).toBe(
      base,
    );
    expect(
      resumoPedidoOnline({ parametros: { id: 'b' }, corpo: { valor: '3.00', pagamento: 'p' } }),
    ).not.toBe(base);
    expect(
      resumoPedidoOnline({ parametros: { id: 'a' }, corpo: { valor: '3.01', pagamento: 'p' } }),
    ).not.toBe(base);
    // Sem parâmetros e sem corpo é o mesmo que os vazios; o corpo `{}` é outro pedido.
    expect(resumoPedidoOnline({})).toBe(resumoPedidoOnline({ parametros: {}, corpo: null }));
    expect(resumoPedidoOnline({ corpo: {} })).not.toBe(resumoPedidoOnline({}));
  });
});

describe('IdempotenciaOnline.executar', () => {
  it('recusa a operação vazia ou acima de varchar(80) antes de abrir transação', async () => {
    const tenancy = {
      cx: () => {
        throw new Error('não devia abrir transação');
      },
    } as unknown as Tenancy;
    const idem = new IdempotenciaOnline(tenancy);
    const t = { terminalId: 't', cabecalhos: { requisicaoId: 'r' } } as unknown as TerminalAutenticado;
    await expect(idem.executar(t, { operacao: '' }, () => Promise.resolve(1))).rejects.toThrow(RangeError);
    await expect(
      idem.executar(t, { operacao: 'x'.repeat(OPERACAO_MAXIMA + 1) }, () => Promise.resolve(1)),
    ).rejects.toThrow(RangeError);
  });
});
