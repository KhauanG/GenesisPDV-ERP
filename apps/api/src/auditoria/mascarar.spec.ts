import { describe, expect, it } from 'vitest';
import { mascararSensiveis, redigirParaVisao, semSegredos } from './mascarar.js';

describe('mascararSensiveis', () => {
  it('mascara hashes, segredos e bytea em qualquer nível; preserva o resto', () => {
    const r = mascararSensiveis({
      nome: 'Loja',
      senhaHash: 'x',
      senha_pdv_hash: null,
      nfce_csc_cifrado: Buffer.from('a'),
      itens: [{ token: 't', valor: '1.00' }],
      criado: new Date('2026-10-29T00:00:00Z'),
    });
    expect(r).toEqual({
      nome: 'Loja',
      senhaHash: '***',
      senha_pdv_hash: null,
      nfce_csc_cifrado: '***',
      itens: [{ token: '***', valor: '1.00' }],
      criado: '2026-10-29T00:00:00.000Z',
    });
  });

  it('semSegredos remove colunas de segredo, inclusive as que ainda não existem', () => {
    expect(
      semSegredos({
        nome: 'Loja',
        nfceCscId: '000001',
        nfceCscCifrado: Buffer.from('x'),
        certificadoSenhaCifrada: 1,
        ifoodToken: 't',
      }),
    ).toEqual({ nome: 'Loja', nfceCscId: '000001' });
  });
});

describe('redigirParaVisao', () => {
  it('sem produtos.ver_custo tira o custo e os valores em R$ do ST retido da loja (D68); os percentuais ficam', () => {
    const linha = {
      precoCusto: '10.0000',
      precoVenda: '15.0000',
      lojas: [
        {
          lojaId: null,
          stBcRetidoUnitario: '17.0000',
          stAliquotaPct: '18.0000',
          stIcmsSubstitutoUnitario: '1.8000',
          stIcmsRetidoUnitario: '1.2600',
          fcpStBcRetidoUnitario: '17.0000',
          fcpStAliquotaPct: '2.0000',
          fcpStRetidoUnitario: '0.3400',
          st_icms_substituto_unitario: '1.8000',
          fcp_st_retido_unitario: '0.3400',
          st_aliquota_pct: '18.0000',
        },
      ],
    };
    expect(redigirParaVisao(linha, { verRh: true, verCusto: false, lojas: null })).toEqual({
      precoVenda: '15.0000',
      lojas: [
        { lojaId: null, stAliquotaPct: '18.0000', fcpStAliquotaPct: '2.0000', st_aliquota_pct: '18.0000' },
      ],
    });
    expect(redigirParaVisao(linha, { verRh: true, verCusto: true, lojas: null })).toEqual(linha);
  });
});
