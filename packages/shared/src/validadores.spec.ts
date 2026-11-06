import { describe, expect, it } from 'vitest';
import {
  calcularDvChaveAcesso,
  completarCnpj,
  validarChaveAcesso,
  validarCnpj,
  validarCpf,
} from './validadores.js';
import casos from './validadores.casos.json' with { type: 'json' };

describe('validarCpf', () => {
  it('aceita CPF válido com e sem máscara', () => {
    expect(validarCpf('529.982.247-25')).toBe(true);
    expect(validarCpf('52998224725')).toBe(true);
  });
  it('recusa DV errado e sequências repetidas', () => {
    expect(validarCpf('52998224724')).toBe(false);
    expect(validarCpf('111.111.111-11')).toBe(false);
    expect(validarCpf('123')).toBe(false);
  });
});

describe('validarCnpj', () => {
  it('aceita CNPJ numérico válido', () => {
    expect(validarCnpj('11.222.333/0001-81')).toBe(true);
  });
  it('aceita CNPJ alfanumérico (exemplo da Receita 12.ABC.345/01DE-35)', () => {
    expect(validarCnpj('12.ABC.345/01DE-35')).toBe(true);
    expect(validarCnpj('12abc34501de35')).toBe(true);
  });
  it('recusa DV errado, letras nos DVs e repetição', () => {
    expect(validarCnpj('12ABC34501DE36')).toBe(false);
    expect(validarCnpj('12ABC34501DEA5')).toBe(false);
    expect(validarCnpj('00000000000000')).toBe(false);
  });
  it('completarCnpj gera DVs que o validador aceita', () => {
    expect(validarCnpj(completarCnpj('A1B2C3D4E5F6'))).toBe(true);
  });
});

describe('validarChaveAcesso', () => {
  it('aceita chave com CNPJ alfanumérico e DV correto', () => {
    const base = `352610${'12ABC34501DE35'}65001000000123100000001`;
    expect(base).toHaveLength(43);
    const chave = base + String(calcularDvChaveAcesso(base));
    expect(validarChaveAcesso(chave)).toBe(true);
  });
  it('recusa DV errado e letras fora do CNPJ', () => {
    const base = `352610${'11222333000181'}65001000000123100000001`;
    const dv = calcularDvChaveAcesso(base);
    expect(validarChaveAcesso(base + String((dv + 1) % 10))).toBe(false);
    expect(validarChaveAcesso(`A${base.slice(1)}${dv}`)).toBe(false);
  });
});

describe('casos compartilhados com o C# (validadores.casos.json)', () => {
  it.each(casos.cpf)('validarCpf($valor) = $valido', ({ valor, valido }) => {
    expect(validarCpf(valor)).toBe(valido);
  });
  it.each(casos.cnpj)('validarCnpj($valor) = $valido', ({ valor, valido }) => {
    expect(validarCnpj(valor)).toBe(valido);
  });
  it.each(casos.completarCnpj)('completarCnpj($base) = $cnpj', ({ base, cnpj }) => {
    expect(completarCnpj(base)).toBe(cnpj);
  });
  it.each(casos.chaveAcesso)('validarChaveAcesso($valor) = $valido', ({ valor, valido }) => {
    expect(validarChaveAcesso(valor)).toBe(valido);
  });
});
