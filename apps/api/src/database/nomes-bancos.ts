/** Nome do banco de uma empresa (MD 2.3, `ck_empresas_nome_banco`): `genesis_emp_<codigo de 6 dígitos>`. */
export const PADRAO_BANCO_EMPRESA = /^genesis_emp_\d{6}$/;

export function nomeBancoEmpresa(codigo: number): string {
  return `genesis_emp_${codigo}`;
}

/**
 * Trava antes de CREATE/DROP/migração de banco de empresa: o nome vem de uma linha do controle e um valor adulterado
 * ou migrado errado (o próprio `genesis_control`, o banco de outra empresa) nunca pode ser criado, migrado ou
 * descartado por engano.
 */
export function garantirNomeBancoEmpresa(nomeBanco: string, codigo: number): void {
  if (!PADRAO_BANCO_EMPRESA.test(nomeBanco) || nomeBanco !== nomeBancoEmpresa(codigo)) {
    throw new Error(
      `Nome de banco "${nomeBanco}" recusado para a empresa ${codigo} (esperado ${nomeBancoEmpresa(codigo)})`,
    );
  }
}

/** O banco de controle nunca pode ter nome de banco de empresa (nem o contrário). */
export function garantirNomeBancoControle(nome: string): void {
  if (nome.startsWith('genesis_emp_') || nome === 'postgres' || nome.startsWith('template')) {
    throw new Error(`Nome "${nome}" não pode ser usado como banco de controle`);
  }
}
