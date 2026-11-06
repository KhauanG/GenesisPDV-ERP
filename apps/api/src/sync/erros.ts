import { erroDoDriver } from '../database/erro-postgres.js';

/** Códigos HTTP do protocolo de sincronização (SYNC 2.5). */
export const CODIGOS_SYNC = {
  REQUISICAO_INVALIDA: 400,
  TOKEN_INVALIDO: 401,
  TERMINAL_REVOGADO: 401,
  EMPRESA_SUSPENSA: 403,
  EMPRESA_CANCELADA: 403,
  PDV_DESABILITADO: 403,
  LOJA_INATIVA: 403,
  ESCOPO_INVALIDO: 403,
  NAO_ENCONTRADO: 404,
  PUSH_EM_ANDAMENTO: 409,
  REGRESSAO_DETECTADA: 409,
  LACUNA_INVALIDA: 409,
  TERMINAL_CLONADO: 409,
  HARDWARE_ALTERADO: 409,
  LOTE_GRANDE_DEMAIS: 413,
  CODIGO_INVALIDO: 422,
  CODIGO_EXPIRADO: 422,
  CODIGO_USADO: 422,
  LIMITE_PLANO: 422,
  CAIXA_OCUPADO: 422,
  LIBERACAO_INVALIDA: 422,
  PROTOCOLO_NAO_SUPORTADO: 426,
  LIMITE_TAXA: 429,
  IP_BLOQUEADO: 429,
  ATIVACAO_BLOQUEADA: 429,
  MANUTENCAO: 503,
  ERRO_INTERNO: 500,
} as const;

export type CodigoSync = keyof typeof CODIGOS_SYNC;

/** Erro do `/sync/*`: vira o envelope `{ erro: { codigo, mensagem, detalhes, requisicao_id } }` (SYNC 2.4). */
export class ErroSync extends Error {
  readonly status: number;

  constructor(
    readonly codigo: CodigoSync,
    mensagem: string,
    readonly detalhes: Record<string, unknown> = {},
    readonly cabecalhos: Record<string, string> = {},
  ) {
    super(mensagem);
    this.name = 'ErroSync';
    this.status = CODIGOS_SYNC[codigo];
  }

  static invalida(mensagem: string, detalhes: Record<string, unknown> = {}): ErroSync {
    return new ErroSync('REQUISICAO_INVALIDA', mensagem, detalhes);
  }

  static token(): ErroSync {
    return new ErroSync('TOKEN_INVALIDO', 'Terminal não autenticado. Reative o terminal.');
  }

  static escopo(mensagem = 'Operação não permitida para este terminal.'): ErroSync {
    return new ErroSync('ESCOPO_INVALIDO', mensagem);
  }

  static manutencao(segundos = 60): ErroSync {
    return new ErroSync(
      'MANUTENCAO',
      'Serviço em manutenção. Tente novamente em instantes.',
      {},
      { 'Retry-After': String(segundos) },
    );
  }
}

/** Erro permanente de regra na aplicação de um evento: o evento fica `erro` (rejeitado) e a fila segue (SYNC 8.3). */
export class ErroRegraEvento extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
    readonly detalhes: Record<string, unknown> = {},
  ) {
    super(mensagem);
    this.name = 'ErroRegraEvento';
  }
}

/** Erro transitório conhecido (ex.: `SCHEMA_DESCONHECIDO`): nada é gravado, o evento e os seguintes voltam ao PDV. */
export class ErroTransitorioEvento extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'ErroTransitorioEvento';
  }
}

/** Tabelas do próprio protocolo: violação nelas é corrida ou bug do push, não do evento (segue como falha interna). */
const TABELAS_DO_PROTOCOLO = new Set(['eventos_recebidos', 'entidades_evento']);

/** Unicidades de negócio com código próprio (SYNC 11.2); as demais são `AGREGADO_DIVERGENTE` (8.4, camada 2). */
const UNICIDADES_COM_CODIGO: Readonly<Record<string, string>> = {
  uq_vendas_numero: 'NUMERO_VENDA_DUPLICADO',
};

/** Erros de sistema do socket com que o `pg` relata a conexão perdida (sem SQLSTATE: o servidor não chegou a responder). */
const CODIGOS_CONEXAO = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']);
/**
 * Mensagens do `pg`/`pg-pool` para a conexão perdida, que chegam sem `code`: "Connection terminated unexpectedly"
 * (e "… due to connection timeout"), "Client has encountered a connection error and is not queryable" e "timeout
 * exceeded when trying to connect".
 */
const MENSAGENS_CONEXAO = /connection terminated|not queryable|timeout exceeded when trying to connect/i;

/** Conexão com o banco perdida: SQLSTATE da classe 08 e 57P01–57P03, ou falha de transporte do driver. */
function conexaoPerdida(code: unknown, mensagem: string | undefined): boolean {
  if (typeof code === 'string') {
    if (CODIGOS_CONEXAO.has(code)) return true;
    if (/^[0-9A-Z]{5}$/.test(code)) {
      return code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03';
    }
  }
  return code === undefined && typeof mensagem === 'string' && MENSAGENS_CONEXAO.test(mensagem);
}

/**
 * Só os nomes das colunas da chave no `detail` do 23505/23503 ("Key (cpf_cnpj)=(…) already exists."): o valor (CPF,
 * nome, telefone…) nunca vai para `resultado`, que fica além do `payload` anulado aos 13 meses (MD 3.15.2) e aparece
 * na fila de decisão do ERP (D19). O `detail` do 23514 ("Failing row contains (…)") é a linha inteira e é descartado.
 */
function colunasDaChave(detail: string | undefined): string[] | null {
  const m = /^Key \((.+?)\)=\(/.exec(detail ?? '');
  return m ? m[1]!.split(',').map((c) => c.trim()) : null;
}

/**
 * Tradução dos erros do PostgreSQL que escapam do handler para os códigos da SYNC 11.2 (decisão técnica T14). Roda
 * **fora** da transação do evento, depois do `rollback` (e das repetições de `transacao()` em 40P01/40001), para
 * nunca mascarar o código que a repetição usa. Lê o erro do driver por trás do `DrizzleQueryError` (`erroDoDriver`):
 *
 * - 23505 em `uq_vendas_numero` → `NUMERO_VENDA_DUPLICADO` (ação "Aplicar com novo número"); qualquer outra unicidade
 *   (chave primária ou chave de negócio) → `AGREGADO_DIVERGENTE`. O mesmo conteúdo já gravado nunca chega aqui: o
 *   handler confere antes e responde sem efeito (`ja_existia`);
 * - 23503 (FK) → `REFERENCIA_INEXISTENTE`;
 * - 23514 (CHECK, inclusive partição inexistente) → `PAYLOAD_INVALIDO`;
 * - 40P01/40001 (deadlock e serialização esgotados) → transitório `CONCORRENCIA_BANCO`, e classe 08, 57P01–57P03 e
 *   a conexão perdida no driver (ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, "Connection terminated"…) → transitório
 *   `BANCO_INDISPONIVEL`: o lote para, nada é gravado e não conta para o `ERRO_INTERNO` (o evento não tem culpa).
 *
 * `detalhes` leva o SQLSTATE, a restrição, a tabela e só os nomes das colunas da chave, nunca o `detail` cru.
 * Qualquer outro erro (ou violação nas tabelas do protocolo) → `null`: segue como exceção não classificada (8.3).
 */
export function traduzirErroBanco(e: unknown): ErroRegraEvento | ErroTransitorioEvento | null {
  if (e instanceof ErroRegraEvento || e instanceof ErroTransitorioEvento) return e;
  const { code, constraint, table, detail, message } = erroDoDriver(e);
  if (code === '40P01' || code === '40001') {
    return new ErroTransitorioEvento('CONCORRENCIA_BANCO', 'Conflito de concorrência no banco; reenvie.');
  }
  if (conexaoPerdida(code, message)) {
    return new ErroTransitorioEvento('BANCO_INDISPONIVEL', 'Banco indisponível no momento; reenvie.');
  }
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return null;
  if (table && TABELAS_DO_PROTOCOLO.has(table)) return null;
  const detalhes = {
    sqlstate: code,
    restricao: constraint ?? null,
    tabela: table ?? null,
    colunas: colunasDaChave(detail),
  };
  switch (code) {
    case '23505': {
      const codigo = (constraint && UNICIDADES_COM_CODIGO[constraint]) || 'AGREGADO_DIVERGENTE';
      const mensagem =
        codigo === 'AGREGADO_DIVERGENTE'
          ? `Registro já existe com outro conteúdo (${constraint ?? 'unicidade'}).`
          : 'Número de venda já usado por outra venda deste caixa.';
      return new ErroRegraEvento(codigo, mensagem, detalhes);
    }
    case '23503':
      return new ErroRegraEvento(
        'REFERENCIA_INEXISTENTE',
        `Referência que não existe na empresa (${constraint ?? 'chave estrangeira'}).`,
        detalhes,
      );
    case '23514':
      return new ErroRegraEvento(
        'PAYLOAD_INVALIDO',
        `Valor recusado pelo banco (${constraint ?? 'restrição'}).`,
        detalhes,
      );
    default:
      return null;
  }
}
