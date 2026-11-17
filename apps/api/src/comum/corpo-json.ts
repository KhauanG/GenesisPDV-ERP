/**
 * Leitura do corpo JSON das requisições (decisão 199). A API não usa o body-parser do Nest (`bodyParser: false`):
 *
 * - quem lê é o `CorpoJsonGuard`, o último guard global — depois do `AutenticacaoGuard` e do `PermissaoGuard` e antes
 *   dos guards da rota (o `LimiteTaxaGuard` lê o login do corpo). Rota sem login lê com o limite padrão, pequeno; o
 *   limite grande só vale nas rotas marcadas com `@CorpoGrande`, e então já com a sessão conferida;
 * - as rotas do PDV que autenticam o terminal no handler (`/sync/push`, heartbeat, renovação do token) marcam o corpo
 *   como `adiado` e leem depois de autenticar o terminal (`lerCorpoJson`);
 * - só JSON em UTF-8 (`application/json` ou `+json`). Multipart fica para o multer das rotas de envio de arquivo; outro
 *   formato com corpo (formulário, texto) é recusado com 415, e corpo sem `Content-Type` não é lido;
 * - o limite vale para os bytes recebidos e para os descomprimidos, e a leitura para assim que passa dele: o
 *   `Content-Length` acima do limite volta 413 sem ler nada, e o corpo em partes volta 413 no byte seguinte ao limite;
 * - compressão (`gzip`, `deflate`, `br`) só onde a rota aceita (o lote do PDV, SYNC 2.1); nas outras, 415;
 * - o corpo tem prazo para chegar inteiro (`CORPO_JSON_PRAZO_LEITURA_S`, contado do início da leitura): o envio lento
 *   não segura a requisição já autenticada; passou dele, 408 `TEMPO_ESGOTADO` e a conexão fecha;
 * - recusado, sem login a resposta leva `Connection: close` (o resto do corpo não é recebido); com a sessão ou o
 *   terminal conferidos, o resto é descartado sem guardar e a conexão continua (`drenarAoRecusar`).
 */
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Configuracao } from '../config/configuracao.js';
import type { Servicos } from '../servicos.js';
import { ErroApi } from './erros.js';
import type { RequisicaoGenesis } from './requisicao.js';
import { SERVICOS } from './tokens-nest.js';

export const META_CORPO_JSON = 'genesis:corpo_json';

/** Faixa do limite (`Configuracao.corpoJson`): `padrao` em toda rota, as outras só onde marcadas. */
export type FaixaCorpoJson = 'padrao' | 'grande' | 'loteSync';

export interface OpcoesCorpoJson {
  faixa: FaixaCorpoJson;
  /** Aceita `Content-Encoding` gzip, deflate ou br (o limite vale também para o descomprimido). */
  comprimido?: boolean;
  /** O guard não lê: o handler lê com `lerCorpoJson` depois de autenticar o terminal. */
  adiado?: boolean;
}

/** Limite e formato do corpo da rota; sem a marca, `{ faixa: 'padrao' }`. */
export const CorpoJson = (opcoes: OpcoesCorpoJson) => SetMetadata(META_CORPO_JSON, opcoes);

/** Documento com muitos itens numa rota autenticada (o limite grande, lido depois da sessão conferida). */
export const CorpoGrande = () => CorpoJson({ faixa: 'grande' });

const LIDO = Symbol('corpo-json-lido');
type RequisicaoComCorpo = IncomingMessage & { body?: unknown; [LIDO]?: true };

/** `fechar`: a conexão fecha depois da resposta, e o resto do corpo (que não vai ser lido) não é recebido. */
const fechando = (fechar: boolean) => (fechar ? { cabecalhos: { Connection: 'close' } } : {});

const recusarTipo = (mensagem: string, fechar: boolean) =>
  new ErroApi('TIPO_NAO_SUPORTADO', mensagem, fechando(fechar));

const grandeDemais = (fechar: boolean) =>
  new ErroApi('CORPO_GRANDE', 'O conteúdo enviado passa do tamanho aceito nesta operação.', fechando(fechar));

const invalido = () => new ErroApi('VALIDACAO', 'Requisição inválida.');

/** Sempre com `Connection: close`: descartar o resto de um envio lento só prolongaria a conexão. */
const tempoEsgotado = () =>
  new ErroApi('TEMPO_ESGOTADO', 'O envio do conteúdo demorou além do prazo. Tente de novo.', fechando(true));

/** O mesmo critério do body-parser (`type-is`): há corpo quando há `Transfer-Encoding` ou `Content-Length`. */
function temCorpo(req: IncomingMessage): boolean {
  return req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined;
}

function ehJson(tipo: string): boolean {
  return tipo === 'application/json' || /^application\/[a-z0-9.!#$&^_-]+\+json$/.test(tipo);
}

/** O descompressor da codificação, `null` sem compressão; codificação desconhecida ou não aceita na rota → 415. */
function descompressor(
  req: IncomingMessage,
  comprimido: boolean,
  fechar: boolean,
): NodeJS.ReadWriteStream | null {
  const codificacao = String(req.headers['content-encoding'] ?? 'identity')
    .trim()
    .toLowerCase();
  if (codificacao === 'identity' || codificacao === '') return null;
  if (!comprimido) throw recusarTipo('Esta operação não aceita conteúdo comprimido.', fechar);
  if (codificacao === 'gzip' || codificacao === 'x-gzip') return createGunzip();
  if (codificacao === 'deflate') return createInflate();
  if (codificacao === 'br') return createBrotliDecompress();
  throw recusarTipo('Compressão do conteúdo não suportada.', fechar);
}

/**
 * Lê o corpo JSON da requisição com o limite em bytes. Devolve `undefined` quando não há corpo JSON a ler (sem corpo,
 * sem `Content-Type`, ou multipart, que é do multer); corpo vazio vira `{}`, como no body-parser. Lido uma vez: a
 * segunda chamada devolve o mesmo `req.body`.
 */
export async function lerCorpoJson(
  requisicao: IncomingMessage,
  limite: number,
  opcoes: { comprimido?: boolean; drenarAoRecusar?: boolean; prazoMs?: number } = {},
): Promise<unknown> {
  const req = requisicao as RequisicaoComCorpo;
  if (req[LIDO]) return req.body;
  if (!temCorpo(req)) return undefined;
  const bruto = req.headers['content-type'];
  if (bruto === undefined) return undefined;
  const [tipoBruto = '', ...parametros] = bruto.split(';');
  const tipo = tipoBruto.trim().toLowerCase();
  if (tipo === 'multipart/form-data') return undefined;
  const fechar = !opcoes.drenarAoRecusar;
  if (!ehJson(tipo)) {
    // `Content-Length: 0` (POST sem corpo de algum cliente) não é corpo a recusar.
    if (req.headers['transfer-encoding'] === undefined && Number(req.headers['content-length']) === 0)
      return undefined;
    throw recusarTipo('Envie o conteúdo em JSON (application/json).', fechar);
  }
  for (const p of parametros) {
    const [nome = '', valor = ''] = p.split('=');
    if (nome.trim().toLowerCase() !== 'charset') continue;
    const charset = valor.trim().replace(/^"|"$/g, '').toLowerCase();
    if (charset !== 'utf-8' && charset !== 'utf8') throw recusarTipo('Envie o conteúdo em UTF-8.', fechar);
  }
  const declarado = req.headers['content-length'];
  if (declarado !== undefined && !(Number(declarado) <= limite)) throw grandeDemais(fechar);
  const zlib = descompressor(req, opcoes.comprimido === true, fechar);
  const texto = await lerAteLimite(req, zlib, limite, fechar, opcoes.prazoMs);
  req[LIDO] = true;
  // Sem BOM (o body-parser também o tira) e, como no `strict` dele, só objeto ou lista no topo.
  const semBom = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  const inicio = semBom.trimStart();
  if (inicio === '') return (req.body = {});
  if (inicio[0] !== '{' && inicio[0] !== '[') throw invalido();
  try {
    return (req.body = JSON.parse(semBom) as unknown);
  } catch {
    throw invalido();
  }
}

/**
 * Junta o corpo contando os bytes recebidos e os descomprimidos; passou do limite em qualquer um, para de ler na hora
 * (sem descomprimir o resto) e recusa. Sem chegar inteiro em `prazoMs`, recusa e fecha a conexão. UTF-8 como o
 * body-parser decodificava (byte inválido vira U+FFFD).
 */
function lerAteLimite(
  req: IncomingMessage,
  zlib: NodeJS.ReadWriteStream | null,
  limite: number,
  fechar: boolean,
  prazoMs: number | undefined,
): Promise<string> {
  const saida = zlib as unknown as (Readable & NodeJS.WritableStream) | null;
  return new Promise<string>((resolver, rejeitar) => {
    const partes: Buffer[] = [];
    let recebidos = 0;
    let lidos = 0;
    let terminou = false;
    let prazo: NodeJS.Timeout | undefined;
    const fim = (erro: ErroApi | null) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(prazo);
      req.off('data', aoReceber);
      req.off('error', aoErro);
      req.off('close', aoFechar);
      if (saida) {
        req.unpipe(saida);
        saida.destroy();
      }
      if (!erro) return resolver(Buffer.concat(partes).toString('utf8'));
      partes.length = 0;
      // Com `Connection: close` a conexão fecha depois da resposta e o resto não é recebido; sem (a sessão ou o
      // terminal já conferidos), o resto é descartado sem guardar e a conexão continua utilizável.
      if (fechar || erro.codigo === 'TEMPO_ESGOTADO') req.pause();
      else req.resume();
      rejeitar(erro);
    };
    const aoErro = () => fim(invalido());
    const aoFechar = () => {
      if (!req.complete) fim(invalido());
    };
    const juntar = (parte: Buffer) => {
      if (terminou) return;
      lidos += parte.length;
      if (lidos > limite) return fim(grandeDemais(fechar));
      partes.push(parte);
    };
    const aoReceber = (parte: Buffer) => {
      recebidos += parte.length;
      if (recebidos > limite) return fim(grandeDemais(fechar));
      if (!saida) juntar(parte);
    };
    if (prazoMs !== undefined) {
      prazo = setTimeout(() => fim(tempoEsgotado()), prazoMs);
      prazo.unref();
    }
    req.on('data', aoReceber);
    req.on('error', aoErro);
    req.on('close', aoFechar);
    if (saida) {
      saida.on('data', juntar);
      saida.on('end', () => fim(null));
      // Conteúdo que não é da compressão declarada: requisição inválida.
      saida.on('error', () => fim(invalido()));
      req.pipe(saida);
    } else {
      req.on('end', () => fim(null));
    }
  });
}

/** O limite em bytes da faixa. */
export const limiteDaFaixa = (config: Configuracao, faixa: FaixaCorpoJson): number => config.corpoJson[faixa];

/**
 * Lê o corpo JSON da rota (o último guard global; ver o topo do arquivo). Rota `adiado` não é lida aqui: o handler lê
 * depois de autenticar o terminal.
 */
@Injectable()
export class CorpoJsonGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SERVICOS) private readonly s: Servicos,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const opcoes = this.reflector.getAllAndOverride<OpcoesCorpoJson | undefined>(META_CORPO_JSON, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) ?? { faixa: 'padrao' };
    if (opcoes.adiado) return true;
    const req = ctx.switchToHttp().getRequest<RequisicaoGenesis>();
    await lerCorpoJson(req, limiteDaFaixa(this.s.config, opcoes.faixa), {
      comprimido: opcoes.comprimido,
      prazoMs: this.s.config.corpoJson.prazoLeituraMs,
      // Com a sessão conferida, a recusa descarta o resto e deixa a conexão de pé (o navegador recebe o 413 em vez de
      // uma conexão cortada no meio do envio); sem login, a conexão fecha.
      drenarAoRecusar: req.sessao !== undefined || req.sessaoPlataforma !== undefined,
    });
    return true;
  }
}
