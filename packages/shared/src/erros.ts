import { z } from 'zod';

/** Códigos de erro do contrato padrão da API (ERP 1.8), mais os de infraestrutura usados pelo ERP. */
export const CODIGOS_ERRO = {
  VALIDACAO: 422,
  NAO_AUTENTICADO: 401,
  SEM_PERMISSAO: 403,
  EMPRESA_SUSPENSA: 403,
  EMPRESA_CANCELADA: 403,
  TROCA_SENHA_OBRIGATORIA: 403,
  NAO_ENCONTRADO: 404,
  CONFLITO_VERSAO: 409,
  CONFLITO: 409,
  /** O mesmo refresh token chegou em requisições simultâneas; a outra já renovou a sessão. */
  REFRESH_CONCORRENTE: 409,
  REGRA_NEGOCIO: 422,
  LIMITE_PLANO: 422,
  LIMITE_TAXA: 429,
  MANUTENCAO: 503,
  /**
   * A gravação esperou a trava de ordenação além do limite (caixas reconectando com muitas vendas; Fase 1C, C13):
   * nada foi gravado, tente de novo em alguns segundos.
   */
  SISTEMA_OCUPADO: 503,
  ERRO_INTERNO: 500,
} as const;

export type CodigoErro = keyof typeof CODIGOS_ERRO;

export const codigoErroSchema = z.enum(Object.keys(CODIGOS_ERRO) as [CodigoErro, ...CodigoErro[]]);

/**
 * Envelope de erro do ERP (ERP 1.8): `{ codigo, mensagem, campos }`.
 * `requisicao_id` permite ao suporte achar a requisição nos logs.
 */
export const erroApiSchema = z.object({
  codigo: codigoErroSchema,
  mensagem: z.string(),
  campos: z.record(z.string(), z.array(z.string())).optional(),
  detalhes: z.record(z.string(), z.unknown()).optional(),
  requisicao_id: z.string().optional(),
});

export type ErroApi = z.infer<typeof erroApiSchema>;

export function statusHttpDoCodigo(codigo: CodigoErro): number {
  return CODIGOS_ERRO[codigo];
}

/** Mensagem única de login inválido: nunca revela qual dos três campos está errado (ERP 4.1). */
export const MENSAGEM_CREDENCIAIS_INVALIDAS = 'Código da empresa, usuário ou senha inválidos.';
