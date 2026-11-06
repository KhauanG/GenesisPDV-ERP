/**
 * Blocos de campos `zod` reutilizados pelos cadastros (ERP 1.5, 1.6): texto opcional vazio → `null`, decimais como
 * string (nunca float na API), datas `AAAA-MM-DD`, CEP/UF/município e o PIN do PDV.
 */
import { z } from 'zod';
import { normalizarCnpj, somenteDigitos, validarCnpj, validarCpf } from './validadores.js';

export const vazioParaNulo = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const textoOpcional = (max: number) =>
  z.preprocess(vazioParaNulo, z.string().trim().max(max).nullable().default(null));

export const textoObrigatorio = (max: number, mensagem = 'Campo obrigatório') =>
  z.string().trim().min(1, mensagem).max(max);

/** Decimal que trafega como string, com vírgula ou ponto, normalizado para `casas` casas. */
export function decimal(opcoes: { min?: number; max?: number; casas: number; mensagem?: string }) {
  return z.union([z.number(), z.string().trim()]).transform((v, ctx) => {
    // "1.234,56" (pt-BR) ou "1234.56"; string vazia não vira zero.
    const texto = typeof v === 'string' && v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
    const n = typeof texto === 'number' ? texto : texto === '' ? NaN : Number(texto);
    if (
      !Number.isFinite(n) ||
      (opcoes.min !== undefined && n < opcoes.min) ||
      (opcoes.max !== undefined && n > opcoes.max)
    ) {
      ctx.addIssue({ code: 'custom', message: opcoes.mensagem ?? 'Valor inválido' });
      return z.NEVER;
    }
    return n.toFixed(opcoes.casas);
  });
}

/** Percentual 0–100 com 4 casas (colunas `numeric(7,4)`). */
export const percentualCampo = decimal({
  min: 0,
  max: 100,
  casas: 4,
  mensagem: 'Informe um percentual entre 0 e 100',
});

/** Dinheiro ≥ 0 com 2 casas (colunas `numeric(15,2)`). */
export const dinheiroCampo = decimal({
  min: 0,
  max: 9_999_999_999_999,
  casas: 2,
  mensagem: 'Valor inválido',
});

export const dinheiroOpcional = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  dinheiroCampo.nullable().default(null),
);

export const dataOpcional = z.preprocess(
  vazioParaNulo,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
    .nullable()
    .default(null),
);

/** A data existe no calendário (`2026-02-30` não): o `::date` do banco recusaria com 22008 (500). */
const dataExiste = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Data `AAAA-MM-DD` que existe no calendário (recebimento, lote do produto). */
export const dataCampo = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
  .refine(dataExiste, 'Data inválida');

/** `dataCampo` opcional: vazio, `undefined` ou `null` → `null`. */
export const dataOpcionalValida = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? null : v),
  dataCampo.nullable().default(null),
);

export const emailOpcional = z.preprocess(
  vazioParaNulo,
  z.string().trim().toLowerCase().max(254).pipe(z.email('E-mail inválido')).nullable().default(null),
);

export const cpfOpcional = z.preprocess(
  (v) => (typeof v === 'string' ? somenteDigitos(v) || null : v),
  z.string().refine(validarCpf, 'CPF inválido').nullable().default(null),
);

export const cnpjCampo = z.string().transform(normalizarCnpj).refine(validarCnpj, 'CNPJ inválido');

/** CEP com ou sem máscara → 8 dígitos. */
export const cepCampo = z
  .string()
  .transform(somenteDigitos)
  .refine((v) => /^\d{8}$/.test(v), 'CEP inválido');

export const cepOpcional = z.preprocess(
  (v) => (typeof v === 'string' ? somenteDigitos(v) || null : v),
  z
    .string()
    .regex(/^\d{8}$/, 'CEP inválido')
    .nullable()
    .default(null),
);

export const ufCampo = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'UF inválida');

export const ufOpcional = z.preprocess(vazioParaNulo, ufCampo.nullable().default(null));

export const municipioCampo = z.coerce.number().int().min(1_000_000, 'Escolha a cidade').max(9_999_999);

export const municipioOpcional = z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  municipioCampo.nullable().default(null),
);

/** UUID opcional: vazio → `null`. */
export const uuidOpcional = z.preprocess(vazioParaNulo, z.uuid().nullable().default(null));

/** Endereço completo exigido em empresa e lojas (ERP 10.1, 10.3.1). */
export const enderecoObrigatorio = {
  cep: cepCampo,
  logradouro: textoObrigatorio(150, 'Informe o endereço'),
  numero: textoObrigatorio(20, 'Informe o número (ou S/N)'),
  complemento: textoOpcional(80),
  bairro: textoObrigatorio(80, 'Informe o bairro'),
  uf: ufCampo,
  municipioIbge: municipioCampo,
};

export const enderecoOpcional = {
  cep: cepOpcional,
  logradouro: textoOpcional(150),
  numero: textoOpcional(20),
  complemento: textoOpcional(80),
  bairro: textoOpcional(80),
  uf: ufOpcional,
  municipioIbge: municipioOpcional,
};

/** Campos de auditoria/versão comuns às respostas de detalhe. */
export interface MetadadosRegistro {
  id: string;
  versao: number;
  criadoEm: string;
  atualizadoEm: string;
  atualizadoPorNome: string | null;
}

/** Sequência crescente ou decrescente de dígitos (`123456`, `987654`, com volta `890123`). */
function sequencial(d: string): boolean {
  const passos = [...d].slice(1).map((c, i) => (Number(c) - Number(d[i]) + 10) % 10);
  return passos.every((p) => p === 1) || passos.every((p) => p === 9);
}

/**
 * PIN do PDV (SYNC 4.3; ERP 11.2) e senha do cliente do crediário (ERP 7.2): só dígitos, 6–8 (4–5 só com
 * `pdv.permite_pin_curto`, nunca para cliente), sem sequência nem repetição, diferente do código do usuário.
 * Devolve a mensagem de erro ou `null`.
 */
export function validarPin(
  pin: string,
  opcoes: { permitirCurto?: boolean; codigoUsuario?: number | null } = {},
): string | null {
  const minimo = opcoes.permitirCurto ? 4 : 6;
  if (!/^\d+$/.test(pin)) return 'Use somente números';
  if (pin.length < minimo || pin.length > 8) return `Use de ${minimo} a 8 dígitos`;
  if (/^(\d)\1+$/.test(pin)) return 'Não use dígitos repetidos (ex.: 111111)';
  if (sequencial(pin)) return 'Não use sequências (ex.: 123456)';
  if (opcoes.codigoUsuario !== undefined && opcoes.codigoUsuario !== null) {
    if (pin === String(opcoes.codigoUsuario) || Number(pin) === opcoes.codigoUsuario) {
      return 'O PIN não pode ser o seu código de usuário';
    }
  }
  return null;
}
