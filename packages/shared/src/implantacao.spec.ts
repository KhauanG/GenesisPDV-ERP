import { describe, expect, it } from 'vitest';
import { alterarLojaSchema } from './estrutura.js';
import { normalizarChavePix, tipoChavePix } from './implantacao.js';

describe('chave PIX do recebedor (PDV 16.7; implantação I5)', () => {
  it('reconhece os cinco tipos do DICT pelo formato e recusa o resto', () => {
    expect(tipoChavePix('52998224725')).toBe('cpf');
    expect(tipoChavePix('529.982.247-25')).toBe('cpf');
    expect(tipoChavePix('52998224724')).toBeNull(); // dígito errado
    expect(tipoChavePix('11.222.333/0001-81')).toBe('cnpj');
    expect(tipoChavePix('11222333000182')).toBeNull();
    expect(tipoChavePix('pix@icebeer.com.br')).toBe('email');
    expect(tipoChavePix('pix@icebeer')).toBeNull();
    expect(tipoChavePix('+5541999998888')).toBe('telefone');
    expect(tipoChavePix('41999998888')).toBeNull(); // sem +55 vira CPF inválido, nunca telefone
    expect(tipoChavePix('123e4567-e89b-12d3-a456-426614174000')).toBe('aleatoria');
    expect(tipoChavePix('')).toBeNull();
    expect(tipoChavePix(null)).toBeNull();
  });

  it('grava como vai para o QR: CPF/CNPJ só dígitos, e-mail em minúsculas', () => {
    expect(normalizarChavePix(' 529.982.247-25 ')).toBe('52998224725');
    expect(normalizarChavePix('Pix@IceBeer.com.br')).toBe('pix@icebeer.com.br');
    expect(normalizarChavePix('+5541999998888')).toBe('+5541999998888');
  });

  it('o cadastro da loja recusa chave inválida e chave sem o nome do recebedor', () => {
    const base = {
      versao: 1,
      estoqueId: '01928f3a-0000-7000-8000-0000000000e1',
      nome: 'Loja 1',
      razaoSocial: 'Ice Beer Ltda',
      nomeFantasia: 'Ice Beer',
      cnpj: '11222333000181',
      cep: '80010000',
      logradouro: 'Rua XV',
      numero: '1',
      bairro: 'Centro',
      municipioIbge: 4106902,
      uf: 'PR',
    };
    expect(alterarLojaSchema.safeParse({ ...base, chavePix: 'x' }).success).toBe(false);
    const semNome = alterarLojaSchema.safeParse({ ...base, chavePix: 'pix@icebeer.com.br' });
    expect(semNome.error?.issues.map((i) => i.path.join('.'))).toContain('pixNomeRecebedor');
    const ok = alterarLojaSchema.parse({ ...base, chavePix: '529.982.247-25', pixNomeRecebedor: 'ICE BEER' });
    expect(ok).toMatchObject({
      chavePix: '52998224725',
      pixNomeRecebedor: 'ICE BEER',
      pixCidadeRecebedor: null,
    });
    expect(alterarLojaSchema.parse(base)).toMatchObject({ chavePix: null });
  });
});
