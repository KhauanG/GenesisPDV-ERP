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
  /** Arquivo acima do limite do destino (F2-B43; README da API › decisão 189): o envio é cortado no stream. */
  ARQUIVO_GRANDE: 413,
  /**
   * Corpo JSON da requisição acima do limite da rota (README da API › decisão 199): o limite vale para os bytes
   * recebidos e para os descomprimidos, e a leitura para assim que passa dele.
   */
  CORPO_GRANDE: 413,
  /**
   * O corpo JSON não chegou inteiro dentro do prazo de leitura (README da API › decisão 199,
   * `CORPO_JSON_PRAZO_LEITURA_S`), ou o arquivo de um envio em multipart (decisão 202,
   * `ENVIO_ARQUIVO_PRAZO_LEITURA_S`): a conexão fecha e nada é gravado.
   */
  TEMPO_ESGOTADO: 408,
  /**
   * O conteúdo do arquivo não é de um tipo aceito pelo destino (conferido pelos magic bytes, F2-B43); também o corpo
   * da requisição em formato, conjunto de caracteres ou compressão que a rota não aceita (decisão 199).
   */
  TIPO_NAO_SUPORTADO: 415,
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
