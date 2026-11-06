import { CODIGOS_ERRO, type CodigoErro } from '@genesis/shared';
import type { ZodError } from 'zod';

/** Erro de negócio/infra que vira o envelope padrão `{ codigo, mensagem, campos }` (ERP 1.8). */
export class ErroApi extends Error {
  readonly status: number;

  constructor(
    readonly codigo: CodigoErro,
    mensagem: string,
    readonly extras: {
      campos?: Record<string, string[]>;
      detalhes?: Record<string, unknown>;
      cabecalhos?: Record<string, string>;
    } = {},
  ) {
    super(mensagem);
    this.name = 'ErroApi';
    this.status = CODIGOS_ERRO[codigo];
  }

  static validacao(erro: ZodError, mensagem = 'Verifique os campos destacados.'): ErroApi {
    const campos: Record<string, string[]> = {};
    for (const issue of erro.issues) {
      const chave = issue.path.length ? issue.path.join('.') : '_';
      (campos[chave] ??= []).push(issue.message);
    }
    return new ErroApi('VALIDACAO', mensagem, { campos });
  }

  static naoAutenticado(mensagem = 'Sessão expirada ou inválida. Entre novamente.'): ErroApi {
    return new ErroApi('NAO_AUTENTICADO', mensagem);
  }

  static semPermissao(mensagem = 'Você não tem permissão para esta ação.'): ErroApi {
    return new ErroApi('SEM_PERMISSAO', mensagem);
  }

  static naoEncontrado(mensagem = 'Registro não encontrado.'): ErroApi {
    return new ErroApi('NAO_ENCONTRADO', mensagem);
  }

  /** Mesmo refresh usado em paralelo (aba dupla, repetição após timeout): não é roubo, mas também não renova. */
  static refreshConcorrente(): ErroApi {
    return new ErroApi(
      'REFRESH_CONCORRENTE',
      'A sessão acabou de ser renovada por outra requisição. Tente novamente.',
    );
  }

  static manutencao(segundos = 60): ErroApi {
    return new ErroApi('MANUTENCAO', 'Empresa em manutenção. Tente novamente em alguns minutos.', {
      cabecalhos: { 'Retry-After': String(segundos) },
    });
  }
}
