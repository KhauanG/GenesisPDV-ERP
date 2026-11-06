/**
 * Implantação › Prontidão da loja (implantação do piloto, I5): a lista do que falta para a loja vender no dia da
 * implantação, só de leitura, para o dono conferir pelo ERP sem terminal. Cada item tem um código estável, o grupo, a
 * situação (`ok`, `aviso` = vende, mas convém olhar, `falta` = resolva antes de abrir o caixa), a mensagem e o link da
 * tela do ERP que resolve. A resposta não leva dado pessoal (nome, login, documento): só contagens, estados e os
 * números dos caixas.
 */
import { z } from 'zod';
import { somenteDigitos, validarCnpj, validarCpf } from './validadores.js';

export const GRUPOS_PRONTIDAO = [
  'empresa',
  'loja',
  'usuarios',
  'formas',
  'catalogo',
  'terminais',
  'operacao',
] as const;
export type GrupoProntidao = (typeof GRUPOS_PRONTIDAO)[number];

export const ROTULOS_GRUPO_PRONTIDAO: Record<GrupoProntidao, string> = {
  empresa: 'Empresa',
  loja: 'Loja e caixas',
  usuarios: 'Usuários e liberações',
  formas: 'Formas de pagamento',
  catalogo: 'Catálogo',
  terminais: 'PDVs / Terminais',
  operacao: 'Operação da nuvem',
};

export const SITUACOES_PRONTIDAO = ['ok', 'aviso', 'falta'] as const;
export type SituacaoProntidao = (typeof SITUACOES_PRONTIDAO)[number];

export const prontidaoQuerySchema = z.object({
  lojaId: z.uuid('Escolha a loja'),
});
export type ProntidaoQuery = z.infer<typeof prontidaoQuerySchema>;

export interface ItemProntidao {
  /** Estável (`grupo.regra`): os testes e o roteiro do piloto citam por ele. */
  codigo: string;
  grupo: GrupoProntidao;
  titulo: string;
  situacao: SituacaoProntidao;
  mensagem: string;
  /** Rota do ERP que resolve (ex.: `/cadastros/formas-pagamento`); `null` = fora do ERP (VPS, Hermes). */
  linkErp: string | null;
}

export interface Prontidao {
  lojaId: string;
  lojaCodigo: number;
  lojaNome: string;
  geradoEm: string;
  /** Sem nenhum item `falta`: a loja pode abrir o caixa (os avisos não impedem). */
  pronta: boolean;
  resumo: Record<SituacaoProntidao, number>;
  itens: ItemProntidao[];
}

// ---------------------------------------------------------------------------------------------------------------
// Chave PIX do recebedor (loja; PDV 16.7, BR Code estático)

export const TIPOS_CHAVE_PIX = ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'] as const;
export type TipoChavePix = (typeof TIPOS_CHAVE_PIX)[number];

/** Limites do BR Code (EMV, campos 59 e 60): o PDV corta o que passar (`PixEstatico.cs`). */
export const PIX_NOME_MAXIMO = 25;
export const PIX_CIDADE_MAXIMO = 15;

const EVP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Tipo da chave PIX pelo formato do DICT (Manual de Padrões para Iniciação do Pix): CPF e CNPJ só dígitos e com o
 * dígito verificador, telefone `+55` com DDD (12 ou 13 dígitos depois do `+`), e-mail até 77 caracteres e a aleatória
 * (EVP, UUID). `null` = não é chave válida. O formato não garante que a chave esteja cadastrada no banco: o teste é
 * um PIX de R$ 0,01 lido pelo app do banco (roteiro do piloto).
 */
export function tipoChavePix(chave: string | null | undefined): TipoChavePix | null {
  const c = (chave ?? '').trim();
  if (!c || c.length > 77) return null;
  if (EVP.test(c)) return 'aleatoria';
  if (c.includes('@')) return EMAIL.test(c) ? 'email' : null;
  if (/^\+55\d{10,11}$/.test(c)) return 'telefone';
  if (/^\d{11}$/.test(c)) return validarCpf(c) ? 'cpf' : null;
  if (/^\d{14}$/.test(c)) return validarCnpj(c) ? 'cnpj' : null;
  // CPF/CNPJ digitados com pontuação: a chave vai para o QR só com os dígitos (o app do banco não aceita a máscara).
  if (/^[\d.\-/]+$/.test(c)) {
    const d = somenteDigitos(c);
    if (d.length === 11 && validarCpf(d)) return 'cpf';
    if (d.length === 14 && validarCnpj(d)) return 'cnpj';
  }
  return null;
}

/** Chave como vai para o QR: CPF/CNPJ só com os dígitos, e-mail em minúsculas; as demais como digitadas. */
export function normalizarChavePix(chave: string): string {
  const c = chave.trim();
  const tipo = tipoChavePix(c);
  if (tipo === 'cpf' || tipo === 'cnpj') return somenteDigitos(c);
  if (tipo === 'email') return c.toLowerCase();
  return c;
}
