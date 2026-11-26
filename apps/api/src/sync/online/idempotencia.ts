/**
 * Idempotência das chamadas online do caixa que alteram estado (SYNC 20.4; F3-B6, README da API › decisão 225): as
 * reservas de vale (F3-B45) e de orçamento (F3-B60), e depois o crédito, a comanda e o PIX. A chave é o terminal e o
 * `X-Requisicao-Id` (`requisicoes_terminal`, MD 3.15.5): o PDV gera o id uma vez por operação lógica e o repete em toda
 * nova tentativa (`ChamadaOnline` do PDV), e a API devolve a **mesma resposta** sem refazer o efeito.
 *
 * Tudo numa transação só, nesta ordem:
 *
 * 0. a trava 7300001 (`PedidoOnline.travaVersao`, quando o efeito grava tabela que desce) é a **primeira instrução**
 *    (MD 1.5, "Trava no início da transação"), esperada sem limite como no push. Não dá para pegá-la depois, no efeito:
 *    a linha de `requisicoes_terminal` tem FK para `terminais`, e a checagem dela põe `FOR KEY SHARE` na linha do
 *    terminal até o commit, enquanto o push (e o heartbeat que confirma) pega a 7300001 e depois `FOR UPDATE` nessa
 *    mesma linha: as duas na ordem invertida dariam deadlock. Com a 7300001 antes, a repetição de uma original ainda em
 *    andamento espera nela (e não no `insert`) e, quando a original confirma, já encontra a resposta gravada;
 * 1. a linha do mesmo terminal e id com mais de `RETENCAO_REQUISICAO_ONLINE_HORAS` é apagada: depois da retenção o
 *    id é uma requisição nova, esteja a limpeza da tarefa por minuto em dia ou não (`manutencao-online.ts`);
 * 2. a linha do terminal com `FOR KEY SHARE` (a trava que a FK pediria no `insert`), **sem** o `lock_timeout`: a espera
 *    atrás de um `FOR UPDATE` do push, do heartbeat ou da revogação não é a requisição original e não vira 409;
 * 3. `insert … on conflict do nothing` da linha "em andamento" (`status_http` nulo) **antes** de qualquer efeito. Se
 *    outra transação já inseriu a mesma chave e ainda não terminou, o PostgreSQL faz este `insert` esperar por ela
 *    (com o `lock_timeout` de `ESPERA_REQUISICAO_ONLINE_MS_PADRAO`, ajustável por `SYNC_ESPERA_REQUISICAO_ONLINE_MS`;
 *    só esta espera conta para ele):
 *    - ela confirma: nada é inserido, e a linha dela, já com a resposta, é devolvida (`repetida`);
 *    - ela desfaz (o efeito falhou): a linha não existe mais, este `insert` passa e esta requisição faz o efeito;
 *    - a espera vence: `409 REQUISICAO_EM_ANDAMENTO` com `Retry-After: 1` (nada feito; o PDV repete com o mesmo id);
 * 4. o efeito, na mesma transação, sem pegar a 7300001 de novo (já é desta transação, quando precisa);
 * 5. a resposta (`status_http`, `resposta`, `concluida_em`) gravada na linha **no mesmo commit** do efeito: nunca há
 *    efeito sem resposta gravada, nem resposta sem efeito.
 *
 * A repetição confere a rota (`endpoint`) e o resumo do pedido (`corpo_sha256`: o JCS dos parâmetros do caminho e do
 * corpo): o mesmo id com outra rota ou outro corpo é bug do caixa e recebe `422 REQUISICAO_DIVERGENTE`, sem efeito e
 * sem a resposta da outra. O id de outro terminal é outra chave: isolado, faz o próprio efeito.
 *
 * O erro do efeito (regra de negócio, 4xx, ou falha) desfaz a transação inteira, inclusive a linha: nada foi feito, e
 * a repetição avalia de novo (pode dar outro desfecho, mas nunca dois efeitos). Só o sucesso fica gravado.
 */
import { jcs, RETENCAO_REQUISICAO_ONLINE_HORAS } from '@genesis/shared';
import { limiteDoAmbiente } from '../../comum/limites-processo.js';
import { erroDoDriver } from '../../database/erro-postgres.js';
import { sha256Hex } from '../../seguranca/tokens.js';
import { TRAVA_OCUPADA, type ClienteEmpresa, type DbEmpresa, type Tenancy } from '../../tenancy/tenancy.js';
import { ErroSync } from '../erros.js';
import type { TerminalAutenticado } from '../terminal.js';

/**
 * Espera máxima da repetição pela requisição original ainda em andamento (ms). Acima do prazo do caixa ninguém mais
 * espera a resposta; abaixo, a repetição feita logo depois de um timeout pega a resposta da original.
 */
export const ESPERA_REQUISICAO_ONLINE_MS_PADRAO = 10_000;

/** `requisicoes_terminal.endpoint` é `varchar(80)`. */
export const OPERACAO_MAXIMA = 80;

export interface PedidoOnline {
  /**
   * A rota como o controller a declara, com o método (ex.: `POST /sync/consultas/vales/:id/reservar`): vai para
   * `endpoint` e separa as operações. Até `OPERACAO_MAXIMA` caracteres.
   */
  operacao: string;
  /** Os parâmetros do caminho (e da query) que mudam o efeito: entram no resumo com o corpo. */
  parametros?: Record<string, unknown>;
  /** O corpo já lido (JSON): entra no resumo. */
  corpo?: unknown;
  /** Status HTTP do sucesso (padrão 200); a repetição devolve o gravado. */
  status?: number;
  /**
   * O efeito grava tabela que desce (`vales`, `vendas_status_pdv`…): a 7300001 é a primeira instrução da transação,
   * antes da linha de `requisicoes_terminal` (passo 0 acima). Sem ela, o efeito não pode chamar `fn_trava_versao()`.
   */
  travaVersao?: boolean;
}

export interface RespostaOnline<T> {
  status: number;
  /** O corpo como foi gravado em `resposta` (`jsonb`), na primeira vez e nas repetições. */
  corpo: T | null;
  /** Devolvida de `requisicoes_terminal` (repetição), sem refazer o efeito. */
  repetida: boolean;
}

export type EfeitoOnline<T> = (tx: DbEmpresa, cliente: ClienteEmpresa) => Promise<T>;

/** Resumo do pedido: o mesmo id com outra rota, outros parâmetros ou outro corpo é recusado na repetição. */
export function resumoPedidoOnline(pedido: Pick<PedidoOnline, 'parametros' | 'corpo'>): string {
  return sha256Hex(jcs({ parametros: pedido.parametros ?? {}, corpo: pedido.corpo ?? null }));
}

interface LinhaRequisicao {
  endpoint: string;
  corpo_sha256: string | null;
  status_http: number | null;
  resposta: unknown;
}

export class IdempotenciaOnline {
  constructor(private readonly tenancy: Tenancy) {}

  /**
   * Executa `efeito` uma única vez para (terminal, `X-Requisicao-Id`) e devolve a resposta gravada nas repetições.
   * Precisa do contexto da empresa do terminal (`executarNaEmpresa`, como toda rota do `/sync/*`).
   */
  async executar<T>(
    t: TerminalAutenticado,
    pedido: PedidoOnline,
    efeito: EfeitoOnline<T>,
  ): Promise<RespostaOnline<T>> {
    if (pedido.operacao.length === 0 || pedido.operacao.length > OPERACAO_MAXIMA) {
      throw new RangeError(
        `Operação online com ${pedido.operacao.length} caracteres (1 a ${OPERACAO_MAXIMA}).`,
      );
    }
    const status = pedido.status ?? 200;
    const chave = [t.terminalId, t.cabecalhos.requisicaoId] as const;
    const resumo = resumoPedidoOnline(pedido);
    const espera = limiteDoAmbiente('SYNC_ESPERA_REQUISICAO_ONLINE_MS', ESPERA_REQUISICAO_ONLINE_MS_PADRAO);
    let esperando = false;
    try {
      // Rota do PDV: a 7300001 (quando pedida) sem limite, como o push (o `lock_timeout` dela é só do ERP, C13).
      return await this.tenancy.cx().transacao(
        async (tx, c) => {
          esperando = false;
          await c.query(
            `delete from requisicoes_terminal
            where terminal_id = $1 and requisicao_id = $2 and criada_em < now() - make_interval(hours => $3)`,
            [...chave, RETENCAO_REQUISICAO_ONLINE_HORAS],
          );
          // A trava da FK pega já aqui, fora do `lock_timeout`: no `insert`, a linha do terminal já é desta
          // transação, e o 55P03 dele só pode vir da linha concorrente da mesma chave (passo 2 acima).
          await c.query('select 1 from terminais where id = $1 for key share', [t.terminalId]);
          esperando = true;
          await c.query(`set local lock_timeout = ${Math.max(1, Math.trunc(espera))}`);
          const inserida = await c.query(
            `insert into requisicoes_terminal (terminal_id, requisicao_id, endpoint, corpo_sha256)
           values ($1, $2, $3, $4)
           on conflict (terminal_id, requisicao_id) do nothing`,
            [...chave, pedido.operacao, resumo],
          );
          await c.query('set local lock_timeout to default');
          esperando = false;
          if (inserida.rowCount === 0) return repeticao<T>(c, chave, pedido.operacao, resumo);

          const corpo = await efeito(tx, c);
          // A primeira resposta também sai do `jsonb` gravado (o que o Express mandaria: sem `undefined`, `Date` em
          // ISO; as chaves na ordem do `jsonb`): a primeira e as repetições são o mesmo JSON, byte a byte.
          const { rows } = await c.query<{ resposta: T | null }>(
            `update requisicoes_terminal
              set status_http = $3, resposta = $4::jsonb, concluida_em = now()
            where terminal_id = $1 and requisicao_id = $2
           returning resposta`,
            [...chave, status, corpo === undefined ? null : JSON.stringify(corpo)],
          );
          return { status, corpo: rows[0]?.resposta ?? null, repetida: false };
        },
        { travaVersao: pedido.travaVersao === true, esperaSemLimite: true },
      );
    } catch (e) {
      if (esperando && erroDoDriver(e).code === TRAVA_OCUPADA) throw emAndamento();
      throw e;
    }
  }
}

/** A linha que a outra transação confirmou: a mesma resposta, se for o mesmo pedido. */
async function repeticao<T>(
  c: ClienteEmpresa,
  chave: readonly [string, string],
  operacao: string,
  resumo: string,
): Promise<RespostaOnline<T>> {
  const { rows } = await c.query<LinhaRequisicao>(
    `select endpoint, corpo_sha256, status_http, resposta
       from requisicoes_terminal where terminal_id = $1 and requisicao_id = $2`,
    [...chave],
  );
  const linha = rows[0];
  // Sem linha (a limpeza a levou no instante da retenção) ou sem resposta: o PDV repete e cai no caso certo.
  if (!linha || linha.status_http === null) throw emAndamento();
  if (linha.endpoint !== operacao || linha.corpo_sha256 !== resumo) {
    throw new ErroSync(
      'REQUISICAO_DIVERGENTE',
      'O mesmo X-Requisicao-Id já foi usado por outra operação deste caixa.',
      { motivo: linha.endpoint !== operacao ? 'operacao' : 'pedido' },
    );
  }
  return { status: linha.status_http, corpo: linha.resposta as T | null, repetida: true };
}

function emAndamento(): ErroSync {
  return new ErroSync(
    'REQUISICAO_EM_ANDAMENTO',
    'A mesma requisição ainda está sendo atendida. Repita em instantes.',
    {},
    { 'Retry-After': '1' },
  );
}
