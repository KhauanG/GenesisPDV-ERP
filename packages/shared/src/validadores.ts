/**
 * Validadores únicos (MD 1.2; ERP 1.6). O lado C# (`CpfValidador`, `CnpjValidador`, `ChaveAcessoValidador` em
 * GenesisPDV.Fiscal/Validadores) roda a mesma tabela de casos: `validadores.casos.json`.
 */

/** Valor de cada caractere no módulo 11 do CNPJ alfanumérico: código ASCII − 48 (dígitos continuam 0–9). */
function valorCaractere(c: string): number {
  return c.charCodeAt(0) - 48;
}

export function somenteDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}

/** Remove máscara e coloca em maiúsculas (CNPJ alfanumérico aceita letras). */
export function normalizarCnpj(valor: string): string {
  return valor.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

export function validarCpf(valor: string): boolean {
  const cpf = somenteDigitos(valor);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (base: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = dv(cpf.slice(0, 9), 10);
  const d2 = dv(cpf.slice(0, 10), 11);
  return d1 === Number(cpf[9]) && d2 === Number(cpf[10]);
}

function dvCnpj(base: string): number {
  const pesos =
    base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  for (let i = 0; i < base.length; i++) soma += valorCaractere(base[i]!) * pesos[i]!;
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** CNPJ numérico ou alfanumérico (12 posições `0-9A-Z` + 2 DVs numéricos). */
export function validarCnpj(valor: string): boolean {
  const cnpj = normalizarCnpj(valor);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj) || /^(.)\1{13}$/.test(cnpj)) return false;
  const d1 = dvCnpj(cnpj.slice(0, 12));
  const d2 = dvCnpj(cnpj.slice(0, 12) + String(d1));
  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
}

/** Calcula os DVs para uma base de 12 posições (útil em testes e geradores). */
export function completarCnpj(base12: string): string {
  const base = normalizarCnpj(base12);
  const d1 = dvCnpj(base);
  const d2 = dvCnpj(base + String(d1));
  return `${base}${d1}${d2}`;
}

/**
 * Chave de acesso NF-e/NFC-e (44 posições): cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) cDV(1).
 * Só as 14 posições do CNPJ podem ter letras; DV por módulo 11 com pesos 2..9 sobre (ASCII − 48).
 */
export function validarChaveAcesso(valor: string): boolean {
  const chave = valor.replace(/\s/g, '').toUpperCase();
  if (!/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(chave)) return false;
  return calcularDvChaveAcesso(chave.slice(0, 43)) === Number(chave[43]);
}

export function calcularDvChaveAcesso(base43: string): number {
  let soma = 0;
  let peso = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    soma += valorCaractere(base43[i]!) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}
