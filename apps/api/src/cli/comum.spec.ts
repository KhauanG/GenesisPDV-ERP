/** A leitura do `--empresas` dos comandos (F2-B46: o filtro inválido não vira "todas as empresas"). */
import { describe, expect, it } from 'vitest';
import { codigosEmpresas } from './comum.js';

describe('codigosEmpresas', () => {
  it('sem o argumento: undefined (todas as empresas)', () => {
    expect(codigosEmpresas(undefined)).toBeUndefined();
  });

  it('os códigos separados por vírgula, com espaços e repetidos', () => {
    expect(codigosEmpresas('100001')).toEqual([100001]);
    expect(codigosEmpresas(' 100001 , 100002,100001')).toEqual([100001, 100002]);
  });

  it.each([
    ['vazio', ''],
    ['letra', 'emp100001'],
    ['letra O no lugar do zero', '1O'],
    ['pontuação colada', '100001;'],
    ['vírgula sobrando', '100001,'],
    ['separado por espaço', '100001 100002'],
    ['decimal', '1.2'],
    ['zero', '0'],
    ['negativo', '-3'],
    ['com sinal', '+3'],
    ['notação científica', '1e5'],
    ['um válido e um não', '3,x'],
    ['grande demais', '1234567890123456'],
  ])('recusa o argumento inteiro (%s)', (_nome, valor) => {
    expect(() => codigosEmpresas(valor)).toThrow(/--empresas recusado.*nada foi feito/);
  });

  it('a mensagem diz quais itens foram recusados', () => {
    expect(() => codigosEmpresas('3,x,')).toThrow(/"x", \(vazio\) não é código/);
  });
});
