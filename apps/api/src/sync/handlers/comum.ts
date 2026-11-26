/**
 * O que todo handler de evento usa (SYNC 8.3, 10.1): o contexto da aplicação, a interface do handler e a gravação da
 * `auditoria` de origem PDV. O handler roda dentro da transação do evento (`aplicarEvento`, `../aplicacao.ts`), já com
 * as travas `push:<terminal>` e 7300001 e o marcador `versao_nuvem` reservados, sem nenhuma E/S externa.
 */
import { jcs } from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import { mascararSensiveis } from '../../auditoria/mascarar.js';
import { auditoria } from '../../database/empresa/auditoria.js';
import { alertas, eventosRecebidos } from '../../database/empresa/schema/index.js';
import { erroDoDriver } from '../../database/erro-postgres.js';
import type { ClienteEmpresa, DbEmpresa } from '../../tenancy/tenancy.js';
import type { TerminalDoEvento } from '../aplicacao.js';
import type { EnvelopeEvento } from '../contratos.js';
import { ErroRegraEvento, ErroTransitorioEvento } from '../erros.js';

export interface ContextoHandler {
  tx: DbEmpresa;
  /** Conexão física da transação, para SQL cru (travas de linha em ordem, `greatest` em `numeracoes`…). */
  c: ClienteEmpresa;
  evento: EnvelopeEvento;
  /** Terminal dono do evento: o do token no push, o da linha de `terminais` no reprocessamento (D20). */
  terminal: TerminalDoEvento;
  /**
   * "Aplicar com novo número" da fila de decisão (SYNC 11.4, 13.1): o documento de venda é gravado com o próximo número
   * da faixa de renumeração do caixa (`renumerarVenda`, `handlers/vendas.ts`). Falso no push.
   */
  novoNumero?: boolean;
  /**
   * `versao_schema` com que o evento chegou (SYNC 17.5; F3-B4). O handler recebe o payload já convertido para a versão
   * dele (`upcast` encadeado), e é por aqui que as regras de recusa da versão de origem continuam valendo: um
   * `venda.finalizada` v1 com `emprestados > 0`, recusado na v1, não passa a ser aceito como comodato só porque o
   * upcaster o levou à versão que entende comodato.
   */
  versaoOrigem: number;
}

/**
 * Evento que ainda falta aplicar (SYNC 8.5): `retido` ou `erro`, menos o `erro` `AGREGADO_DIVERGENTE`. Esse é a
 * duplicata de um agregado que já existe aplicado na nuvem (8.4): reprocessar não resolve (ela sempre diverge) e
 * segurar os dependentes por ela retinha em cascata, por exemplo, o turno inteiro aberto depois de um segundo
 * `caixa.fechado` divergente (PDV 21.5). O `EVENTO_DIVERGENTE` não chega a gravar linha (o `evento_id` é o da linha
 * original).
 */
export function eventoPendente(): SQL {
  return sql`(${eventosRecebidos.status} = 'retido'
    or (${eventosRecebidos.status} = 'erro' and ${eventosRecebidos.erroCodigo} is distinct from 'AGREGADO_DIVERGENTE'))`;
}

/** Agregado de que um evento depende (SYNC 8.5): o mesmo formato de `dependencias` do envelope. */
export interface DependenciaEvento {
  agregado_tipo: string;
  agregado_id: string;
}

/**
 * Uma versão anterior do payload de um tipo (SYNC 17.5; F3-B4): o schema dela (o do contrato,
 * `CONTRATOS_EVENTOS[tipo].versoes[n]`) e a conversão para a versão **seguinte** (vN → vN+1). O `upcast` é **puro**:
 * não lê o banco nem o relógio, para o Reprocessar dar sempre o mesmo resultado, e o payload gravado em
 * `eventos_recebidos` continua o original (a conversão acontece a cada aplicação). Uma falha dele é erro de regra
 * (`PAYLOAD_INVALIDO`, que o suporte resolve corrigindo o upcaster e reprocessando), nunca transitória.
 */
export interface VersaoAnteriorEvento {
  schema: z.ZodType;
  upcast(payload: never): unknown;
  /** `false`: aceita, mas fora de `versoes_schema` (padrão: anunciada; a v1 de um tipo que já foi anunciado nunca sai). */
  anunciada?: boolean;
}

export interface HandlerEvento {
  /** Schema da versão do handler (a chave dele no catálogo). */
  schema: z.ZodType;
  /**
   * Versões anteriores que este handler aplica pelo `upcast` encadeado (SYNC 17.5; F3-B4): o evento v1 de um handler v3
   * passa por `versoes[1]` e `versoes[2]` antes do `schema`. Cada versão abaixo da do handler precisa estar aqui (ou ter
   * handler próprio no catálogo); a que falta fica `SCHEMA_DESCONHECIDO`.
   */
  versoes?: Readonly<Record<number, VersaoAnteriorEvento>>;
  /**
   * `false`: o handler já aplica a versão, mas ela fica **fora** de `versoes_schema` até o último bloco da onda (o
   * anúncio no fim da onda, plano da Fase 3). O PDV escolhe a maior versão comum anunciada, então nenhum caixa a grava
   * antes; um evento que chegue nela (outro caminho, teste) é aplicado normalmente. Padrão: anunciada.
   */
  anunciada?: boolean;
  /** Entidades criadas pelo payload (`entidades_evento`, SYNC 8.5), lidas sem aplicar. */
  entidades?(payload: unknown): Array<{ tipo: string; id: string }>;
  /**
   * Dependências recalculadas pela nuvem a partir do payload (SYNC 8.5: vale a união com as do envelope). Roda antes
   * da trava 7300001 e só lê: o PDV que esquece de declarar a sessão não faz o evento quebrar no meio do handler, e a
   * regra que olha o banco (T11: a outra sessão aberta do terminal) entra aqui.
   */
  dependencias?(ctx: ContextoHandler, payload: never): Promise<DependenciaEvento[]>;
  /**
   * Leitura dos cadastros **antes** da trava 7300001 (Fase 1C, bloco C6a; crítica da 1C, item 6): roda depois da
   * conferência das dependências, do schema e do agregado, só lendo (sem `for update`), e o que devolve chega ao
   * `aplicar` como terceiro argumento. Assim a trava, que serializa todos os caixas e o ERP da empresa, fica presa só
   * enquanto o handler grava (venda: produtos, códigos de barras, estoques e tipos de estoque, `lerCadastrosEstoque`).
   */
  preparar?(ctx: ContextoHandler, payload: never): Promise<unknown>;
  aplicar(ctx: ContextoHandler, payload: never, preparado: never): Promise<Record<string, unknown>>;
}

/** Handlers por tipo e `versao_schema` (SYNC 9). */
export type CatalogoHandlers = Readonly<Record<string, Readonly<Record<number, HandlerEvento>>>>;

/** O handler que aplica uma versão de um tipo e a versão dele (a chave no catálogo). */
export interface HandlerResolvido {
  handler: HandlerEvento;
  versaoHandler: number;
}

/**
 * Quem aplica `tipo` na `versao` (SYNC 17.5; F3-B4): o handler da própria versão ou, sem ele, o primeiro acima cujas
 * `versoes` cobrem cada passo de `versao` até a dele. `null` = versão que esta API não aplica (acima da maior
 * conhecida: o PDV é mais novo; ou um buraco no encadeamento), que a aplicação trata como `SCHEMA_DESCONHECIDO`
 * (transitório: o evento espera a API ser atualizada).
 */
export function resolverHandler(
  catalogo: CatalogoHandlers,
  tipo: string,
  versao: number,
): HandlerResolvido | null {
  const porVersao = catalogo[tipo];
  if (!porVersao || !Number.isInteger(versao) || versao < 1) return null;
  const proprio = porVersao[versao];
  if (proprio) return { handler: proprio, versaoHandler: versao };
  const acima = Object.keys(porVersao)
    .map(Number)
    .filter((v) => v > versao)
    .sort((a, b) => a - b);
  for (const v of acima) {
    const handler = porVersao[v]!;
    let cobre = true;
    for (let n = versao; n < v && cobre; n++) cobre = handler.versoes?.[n] !== undefined;
    if (cobre) return { handler, versaoHandler: v };
  }
  return null;
}

/** O payload convertido para a versão do handler, ou onde a conversão parou (com o que o zod apontou). */
export type PayloadConvertido =
  | { success: true; data: unknown }
  | { success: false; versao: number; campos: string[]; falhaUpcast?: string };

const camposDoErro = (e: z.ZodError) => e.issues.map((x) => `${x.path.join('.')}: ${x.message}`);

/**
 * Leva o payload da `versaoOrigem` até a versão do handler (SYNC 17.5; F3-B4): cada passo valida no schema da versão
 * em que está e converte para a seguinte; no fim, o schema do handler. Puro (só o zod e os `upcast`), para valer igual
 * no push, no Reprocessar e na suíte de contrato. O erro de regra que um upcaster lance de propósito sobe como está; a
 * exceção de um upcaster com defeito vira a falha da etapa (o chamador grava `PAYLOAD_INVALIDO`).
 */
export function converterPayload(
  r: HandlerResolvido,
  versaoOrigem: number,
  payload: unknown,
): PayloadConvertido {
  let atual = payload;
  for (let n = versaoOrigem; n < r.versaoHandler; n++) {
    const anterior = r.handler.versoes?.[n];
    if (!anterior) return { success: false, versao: n, campos: [], falhaUpcast: `sem a conversão da v${n}` };
    const lido = anterior.schema.safeParse(atual);
    if (!lido.success) return { success: false, versao: n, campos: camposDoErro(lido.error) };
    try {
      atual = anterior.upcast(lido.data as never);
    } catch (e) {
      if (e instanceof ErroRegraEvento || e instanceof ErroTransitorioEvento) throw e;
      return {
        success: false,
        versao: n,
        campos: [],
        falhaUpcast: (e instanceof Error ? e.message : String(e)).slice(0, 500),
      };
    }
  }
  const final = r.handler.schema.safeParse(atual);
  return final.success
    ? { success: true, data: final.data }
    : { success: false, versao: r.versaoHandler, campos: camposDoErro(final.error) };
}

/** `ErroRegraEvento` da conversão que parou (`PAYLOAD_INVALIDO`), com a versão de origem e a etapa nos detalhes. */
export function erroDaConversao(
  c: Extract<PayloadConvertido, { success: false }>,
  versaoOrigem: number,
): ErroRegraEvento {
  const mensagem = c.falhaUpcast
    ? `Falha na conversão do payload da v${c.versao} para a v${c.versao + 1}.`
    : c.versao === versaoOrigem
      ? 'Payload fora do schema do tipo.'
      : `Payload convertido da v${versaoOrigem} fora do schema da v${c.versao}.`;
  return new ErroRegraEvento('PAYLOAD_INVALIDO', mensagem, {
    campos: c.campos,
    ...(c.versao === versaoOrigem && !c.falhaUpcast ? {} : { versao_origem: versaoOrigem, versao: c.versao }),
    ...(c.falhaUpcast ? { falha: c.falhaUpcast } : {}),
  });
}

/**
 * `versoes_schema` do `GET /sync/estado` (SYNC 17.5; T13; F3-B4): por tipo, as versões que esta API aplica **e
 * anuncia** — a do handler e as anteriores que ele converte, menos as marcadas `anunciada: false`. A versão aceita e
 * ainda não anunciada fica fora (o PDV escolhe a maior comum anunciada); tipo sem versão anunciada não aparece.
 */
export function versoesAnunciadas(catalogo: CatalogoHandlers): Record<string, number[]> {
  const saida: Record<string, number[]> = {};
  for (const [tipo, porVersao] of Object.entries(catalogo)) {
    const versoes = new Set<number>();
    for (const [chave, handler] of Object.entries(porVersao)) {
      if (handler.anunciada !== false) versoes.add(Number(chave));
      for (const [n, anterior] of Object.entries(handler.versoes ?? {})) {
        if (anterior.anunciada !== false) versoes.add(Number(n));
      }
    }
    if (versoes.size) saida[tipo] = [...versoes].sort((a, b) => a - b);
  }
  return saida;
}

/**
 * Partição de `auditoria` inexistente para a data (relógio muito errado): erro de regra, não falha transitória. Lê o
 * erro do driver: o `tx.insert` do Drizzle chega embrulhado em `DrizzleQueryError` ("Failed query…", `.cause`).
 */
export function semParticao(e: unknown): boolean {
  const { code, message } = erroDoDriver(e);
  return code === '23514' && /partition/i.test(message ?? '');
}

export interface RegistroAuditoriaPdv {
  entidade: string;
  registroId?: string | null;
  acao: string;
  localizacao?: string | null;
  descricao?: string | null;
  antes?: unknown;
  depois?: unknown;
  /** Padrão: o `usuario_id` do envelope (o operador do caixa). */
  usuarioId?: string | null;
  autorizadoPorId?: string | null;
  /** Padrão: `ocorrido_em` do envelope. */
  ocorridoEm?: Date;
}

/**
 * Rodapé da SYNC 10.1: toda aplicação grava `auditoria` com `origem = 'pdv'`, o terminal, a loja e o `evento_id`.
 * Um só lugar para isso, em vez de cada handler montar a linha: `antes`/`depois` passam por `mascararSensiveis` e a
 * descrição é cortada no limite da coluna. Data fora das partições → `PAYLOAD_INVALIDO`.
 */
export async function registrarAuditoriaPdv(
  { tx, evento, terminal }: Pick<ContextoHandler, 'tx' | 'evento' | 'terminal'>,
  r: RegistroAuditoriaPdv,
): Promise<string> {
  const id = uuidv7();
  try {
    await tx.insert(auditoria).values({
      id,
      ocorridoEm: r.ocorridoEm ?? new Date(evento.ocorrido_em),
      origem: 'pdv',
      usuarioId: r.usuarioId === undefined ? (evento.usuario_id ?? null) : r.usuarioId,
      autorizadoPorId: r.autorizadoPorId ?? null,
      terminalId: terminal.terminalId,
      lojaId: terminal.lojaId,
      entidade: r.entidade,
      registroId: r.registroId ?? null,
      acao: r.acao,
      localizacao: r.localizacao ?? null,
      descricao: r.descricao?.slice(0, 2000) ?? null,
      antes: r.antes === undefined ? null : mascararSensiveis(r.antes),
      depois: r.depois === undefined ? null : mascararSensiveis(r.depois),
      ip: terminal.ip,
      eventoId: evento.evento_id,
    });
  } catch (e) {
    if (semParticao(e)) throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'ocorrido_em fora do período aceito.');
    throw e;
  }
  return id;
}

/**
 * Loja, caixa, número do caixa e terminal de uma linha do payload têm de ser os do terminal dono (SYNC 9.3, 11.2
 * `ESCOPO_INVALIDO`): o envelope já foi conferido (`conferirEscopo`), mas as linhas carregam as colunas de novo.
 */
export function conferirEscopoLinha(
  linha: { loja_id?: string; caixa_id?: string; numero_caixa?: number; terminal_id?: string },
  terminal: TerminalDoEvento,
  tabela: string,
): void {
  const divergentes = [
    linha.loja_id !== undefined && linha.loja_id !== terminal.lojaId ? 'loja_id' : null,
    linha.caixa_id !== undefined && linha.caixa_id !== terminal.caixaId ? 'caixa_id' : null,
    linha.numero_caixa !== undefined && linha.numero_caixa !== terminal.numeroCaixa ? 'numero_caixa' : null,
    linha.terminal_id !== undefined && linha.terminal_id !== terminal.terminalId ? 'terminal_id' : null,
  ].filter((c): c is string => c !== null);
  if (divergentes.length) {
    throw new ErroRegraEvento('ESCOPO_INVALIDO', `Linha de ${tabela} de outro terminal.`, {
      tabela,
      colunas: divergentes,
    });
  }
}

/** `numeric` com escala (o Drizzle devolve `"150.00"`, o payload manda a escala da coluna); texto só de dígitos não. */
const DECIMAL = /^-?\d+\.\d+$/;

/** Um valor de coluna como o Drizzle devolve (Date, decimal em texto, nulo) e como o handler monta. */
function mesmoValor(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x instanceof Date || y instanceof Date) {
    const t = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN);
    return t(x) === t(y);
  }
  if (typeof x === 'string' && typeof y === 'string' && DECIMAL.test(x) && DECIMAL.test(y)) {
    return Number(x) === Number(y);
  }
  if (typeof x === 'object' && x !== null && typeof y === 'object' && y !== null) {
    // `jsonb` não guarda a ordem das chaves: compara na forma canônica.
    return jcs(x) === jcs(y);
  }
  return x === y;
}

/**
 * Camada 2 da idempotência (SYNC 8.4) para o agregado que já existe com o mesmo id: o evento é outro (o PDV gerou de
 * novo), mas a linha gravada tem o mesmo conteúdo nas colunas que o handler grava → `ja_existia`, sem efeito; senão
 * `AGREGADO_DIVERGENTE`. `ignorar` são as colunas que a nuvem muda depois (status, fechamento forçado…). Devolve as
 * colunas divergentes (vazio = mesmo conteúdo).
 */
export function colunasDivergentes(
  gravada: Record<string, unknown>,
  valores: Record<string, unknown>,
  ignorar: readonly string[] = [],
): string[] {
  return Object.keys(valores).filter((k) => !ignorar.includes(k) && !mesmoValor(gravada[k], valores[k]));
}

export function agregadoDivergente(tabela: string, id: string, colunas: string[]): ErroRegraEvento {
  return new ErroRegraEvento('AGREGADO_DIVERGENTE', `${tabela} ${id} já existe com outro conteúdo.`, {
    tabela,
    colunas,
  });
}

/** Grava o alerta deduplicado (`chave_deduplicacao`); devolve se ele é novo (o aberto com a mesma chave fica). */
export async function gravarAlerta(tx: DbEmpresa, alerta: typeof alertas.$inferInsert): Promise<boolean> {
  const r = await tx.insert(alertas).values(alerta).onConflictDoNothing().returning({ id: alertas.id });
  return r.length > 0;
}
