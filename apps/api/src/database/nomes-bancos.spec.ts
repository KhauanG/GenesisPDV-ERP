import { describe, expect, it } from 'vitest';
import { garantirNomeBancoControle, garantirNomeBancoEmpresa } from './nomes-bancos.js';

describe('nomes de banco', () => {
  it('banco de empresa: só genesis_emp_<codigo> da própria empresa', () => {
    expect(() => garantirNomeBancoEmpresa('genesis_emp_100001', 100001)).not.toThrow();
    for (const [nome, codigo] of [
      ['genesis_control', 100001],
      ['genesis_emp_100002', 100001],
      ['genesis_emp_100001"; drop database x; --', 100001],
      ['postgres', 100001],
    ] as const) {
      expect(() => garantirNomeBancoEmpresa(nome, codigo), nome).toThrow(/recusado/);
    }
  });

  it('banco de controle nunca usa nome de banco de empresa', () => {
    expect(() => garantirNomeBancoControle('genesis_control')).not.toThrow();
    expect(() => garantirNomeBancoControle('genesis_emp_100001')).toThrow();
    expect(() => garantirNomeBancoControle('postgres')).toThrow();
  });
});
