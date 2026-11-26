/**
 * O atendimento comum das rotas do `/sync/*` que autenticam o terminal, fora do controller para as rotas de outros
 * controllers (e o teste da idempotência, F3-B6) seguirem o mesmo caminho: o token, o contexto da empresa, o alerta do
 * token anterior, o hardware, o corpo `adiado` lido só depois (decisão 199) e o `X-Agora-Servidor`.
 */
import { CABECALHO_RESPOSTA_REPETIDA } from '@genesis/shared';
import type { Response } from 'express';
import { lerCorpoJson, limiteDaFaixa, type OpcoesCorpoJson } from '../comum/corpo-json.js';
import type { RequisicaoGenesis } from '../comum/requisicao.js';
import type { Servicos } from '../servicos.js';
import type { ClienteEmpresa, DbEmpresa } from '../tenancy/tenancy.js';
import { exigirHardware, type EndpointSync, type TerminalAutenticado } from './terminal.js';

/** Autentica o terminal e roda `fn` no contexto da empresa dele; toda resposta leva o `X-Agora-Servidor`. */
export async function noTerminal<T>(
  s: Servicos,
  req: RequisicaoGenesis,
  res: Response,
  endpoint: EndpointSync,
  fn: (t: TerminalAutenticado) => Promise<T>,
): Promise<T> {
  const t = await s.terminalAuth.autenticar(req, endpoint);
  const r = await s.tenancy.executarNaEmpresa(t.contexto, async () => {
    // O alerta vem antes do 409 de hardware: o clone em outra máquina também é registrado (SYNC 3.7).
    if (t.tokenAnteriorReutilizado) await s.token.registrarAnteriorReutilizado(t);
    exigirHardware(t, endpoint);
    return fn(t);
  });
  res.setHeader('X-Agora-Servidor', new Date().toISOString());
  return r;
}

/**
 * O corpo da rota `adiado`, já com o terminal autenticado; recusado, o resto é descartado e a conexão continua (o
 * prazo esgotado fecha). Depois de lido, o terminal é conferido de novo no controle (`conferirDeNovo`).
 */
export async function corpoDoTerminal(
  s: Servicos,
  req: RequisicaoGenesis,
  t: TerminalAutenticado,
  opcoes: OpcoesCorpoJson,
): Promise<unknown> {
  const corpo = await lerCorpoJson(req, limiteDaFaixa(s.config, opcoes.faixa), {
    comprimido: opcoes.comprimido,
    drenarAoRecusar: true,
    prazoMs: s.config.corpoJson.prazoLeituraMs,
  });
  await s.terminalAuth.conferirDeNovo(t);
  return corpo;
}

/** O que o efeito de uma chamada online recebe: o terminal, o pedido validado e a transação da idempotência. */
export interface ContextoOnline<C> {
  terminal: TerminalAutenticado;
  corpo: C;
  tx: DbEmpresa;
  cliente: ClienteEmpresa;
}

export interface RotaOnline<C> {
  /** A rota com o método, como vai para `requisicoes_terminal.endpoint` (até 80 caracteres). */
  operacao: string;
  /** Os parâmetros do caminho que mudam o efeito (entram no resumo do pedido). */
  parametros?: Record<string, unknown>;
  /** O corpo `adiado` da rota (o mesmo `@CorpoJson` do decorator); sem ele, a rota não tem corpo. */
  corpo?: OpcoesCorpoJson;
  /** Validação do corpo (e dos parâmetros) antes da transação: o 400 sai sem tocar em `requisicoes_terminal`. */
  validar?: (corpo: unknown) => C;
  /** Status do sucesso (padrão 200). */
  status?: number;
  /** O efeito grava tabela que desce: a 7300001 é a primeira instrução da transação (`PedidoOnline.travaVersao`). */
  travaVersao?: boolean;
}

/**
 * Chamada online do caixa que altera estado (SYNC 20.4; F3-B6): o terminal com o hardware registrado (`online`), o
 * corpo lido e validado, e o efeito pela `IdempotenciaOnline` (uma vez por terminal e `X-Requisicao-Id`, a repetição
 * com a resposta gravada, marcada com `X-Genesis-Resposta-Repetida: 1`). O status é o gravado.
 */
export function atenderOnline<C, T>(
  s: Servicos,
  req: RequisicaoGenesis,
  res: Response,
  rota: RotaOnline<C>,
  efeito: (ctx: ContextoOnline<C>) => Promise<T>,
): Promise<T | null> {
  return noTerminal(s, req, res, 'online', async (t) => {
    const bruto = rota.corpo ? await corpoDoTerminal(s, req, t, rota.corpo) : undefined;
    const corpo = rota.validar ? rota.validar(bruto) : (bruto as C);
    const r = await s.idempotencia.executar(
      t,
      {
        operacao: rota.operacao,
        parametros: rota.parametros,
        corpo: bruto,
        status: rota.status,
        travaVersao: rota.travaVersao,
      },
      (tx, cliente) => efeito({ terminal: t, corpo, tx, cliente }),
    );
    res.status(r.status);
    if (r.repetida) res.setHeader(CABECALHO_RESPOSTA_REPETIDA, '1');
    return r.corpo;
  });
}
