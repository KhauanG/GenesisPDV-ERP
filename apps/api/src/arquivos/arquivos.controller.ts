import {
  type CallHandler,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  conteudoArquivoSchema,
  DESTINOS_ARQUIVO,
  envioArquivoSchema,
  mensagemArquivoGrande,
  type ArquivoInfo,
  type DestinoArquivo,
} from '@genesis/shared';
import type { Response } from 'express';
import { catchError, defer, finalize, mergeMap, throwError } from 'rxjs';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { garantirLimitePorMinuto, limiteDoAmbiente, Semaforo } from '../comum/limites-processo.js';
import { Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';
import { podeEnviar } from './arquivos.js';

/** O que o multer entrega (memória; o limite do destino corta o stream antes de juntar mais que isso). */
interface ArquivoRecebido {
  originalname: string;
  buffer: Buffer;
}

/** Envios por usuário por minuto (`ARQUIVOS_ENVIOS_POR_MINUTO`): cada um decodifica uma imagem de até 2 MB. */
const enviosPorMinuto = () => limiteDoAmbiente('ARQUIVOS_ENVIOS_POR_MINUTO', 30);
/**
 * Envios sendo processados ao mesmo tempo no processo (`ARQUIVOS_ENVIOS_SIMULTANEOS`, 4): o buffer juntado, a
 * variante e a gravação no armazenamento. A vaga é pega **depois** de o multer ler o corpo (`VagaEnvioArquivo`): o
 * tempo que o corpo leva para chegar não entra nela, então o envio lento não segura a vaga de ninguém. A
 * decodificação é uma por vez (`imagens.ts`).
 */
const semaforoEnvios = new Semaforo(limiteDoAmbiente('ARQUIVOS_ENVIOS_SIMULTANEOS', 4));
/**
 * Envios ao mesmo tempo de um usuário (`ARQUIVOS_ENVIOS_SIMULTANEOS_USUARIO`, 2: o logotipo e a foto da loja juntos),
 * contados desde antes da leitura: o seguinte recebe 429 na hora. É o que limita a memória da leitura (2 × o limite
 * do destino por usuário), já que a vaga do processo só vem depois dela.
 */
const enviosSimultaneosPorUsuario = () => limiteDoAmbiente('ARQUIVOS_ENVIOS_SIMULTANEOS_USUARIO', 2);
const enviosEmAndamento = new Map<string, number>();

/** Folga do `Content-Length` sobre o limite do arquivo: o cabeçalho da parte e o boundary do multipart. */
const FOLGA_MULTIPART = 16 * 1024;

const erroGrande = (destino: DestinoArquivo) =>
  new ErroApi('ARQUIVO_GRANDE', mensagemArquivoGrande(destino), {
    campos: { arquivo: [mensagemArquivoGrande(destino)] },
  });

/** O destino já validado pelo `LimiteEnvioArquivo` (o multer lê o limite dele). */
const destinoDaRequisicao = (req: RequisicaoGenesis) =>
  (req as RequisicaoGenesis & { destinoArquivo?: DestinoArquivo }).destinoArquivo;

/**
 * O que roda **antes** de o multer ler o corpo (README da API › decisão 189): a query (`destino`, `lojaId`), a
 * permissão do destino e a loja permitida (sem elas, nada é lido), o `Content-Length` contra o limite do destino (sem
 * ele, envio em pedaços, o pedido é recusado: o navegador sempre o manda no `FormData`), o limite por minuto e o de
 * envios simultâneos do usuário, liberado quando a resposta termina. O multer corta o stream no limite do destino
 * (`fileSize`): o `Content-Length` que mente não passa de lá. A vaga do processo vem depois (`VagaEnvioArquivo`).
 */
@Injectable()
class LimiteEnvioArquivo implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<RequisicaoGenesis>();
    const sessao = req.sessao;
    if (!sessao) throw ErroApi.naoAutenticado();
    const envio = validar(envioArquivoSchema, req.query);
    if (!podeEnviar(sessao, envio.destino)) throw ErroApi.semPermissao();
    if (envio.lojaId && !lojaPermitida(sessao, envio.lojaId))
      throw ErroApi.naoEncontrado('Loja não encontrada.');
    const limite = DESTINOS_ARQUIVO[envio.destino].limiteBytes;
    const tamanho = Number(req.headers['content-length']);
    if (!req.headers['content-length'] || !Number.isFinite(tamanho))
      throw new ErroApi('VALIDACAO', 'Envie o arquivo pelo formulário (o tamanho do envio não veio).');
    if (tamanho > limite + FOLGA_MULTIPART) throw erroGrande(envio.destino);
    const chave = `arquivos:${sessao.empresa.empresaId}:${sessao.usuarioId}`;
    garantirLimitePorMinuto(chave, enviosPorMinuto());
    const emAndamento = enviosEmAndamento.get(chave) ?? 0;
    if (emAndamento >= enviosSimultaneosPorUsuario())
      throw new ErroApi('LIMITE_TAXA', 'Aguarde o envio em andamento terminar e envie de novo.', {
        cabecalhos: { 'Retry-After': '5' },
      });
    enviosEmAndamento.set(chave, emAndamento + 1);
    (req as RequisicaoGenesis & { destinoArquivo?: DestinoArquivo }).destinoArquivo = envio.destino;
    return next.handle().pipe(
      catchError((e: unknown) => throwError(() => erroDoMulter(e, envio.destino))),
      finalize(() => {
        const n = (enviosEmAndamento.get(chave) ?? 1) - 1;
        if (n > 0) enviosEmAndamento.set(chave, n);
        else enviosEmAndamento.delete(chave);
      }),
    );
  }
}

/**
 * A vaga do semáforo do processo, pega com o corpo **já lido** (este interceptor roda depois do multer) e liberada
 * quando a resposta termina. Quem espera aqui espera só o processamento dos outros (a variante e a gravação), nunca
 * a rede de um envio lento.
 */
@Injectable()
class VagaEnvioArquivo implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    let liberar: (() => void) | undefined;
    return defer(async () => {
      liberar = await semaforoEnvios.adquirir();
    }).pipe(
      mergeMap(() => next.handle()),
      finalize(() => liberar?.()),
    );
  }
}

/** O erro do multer (400/413 com a mensagem em inglês) na mensagem da tela. */
function erroDoMulter(e: unknown, destino: DestinoArquivo): unknown {
  if (!(e instanceof HttpException)) return e;
  if (e.getStatus() === HttpStatus.PAYLOAD_TOO_LARGE) return erroGrande(destino);
  if (e.getStatus() === HttpStatus.BAD_REQUEST)
    return new ErroApi('VALIDACAO', 'Envie um arquivo só, no campo "arquivo".', {
      campos: { arquivo: ['Envio inválido'] },
    });
  return e;
}

/** Um arquivo só, no campo `arquivo`, com o limite do destino; nenhum campo de texto (as opções vão na query). */
const upload = FileInterceptor('arquivo', {
  limits: (req: RequisicaoGenesis) => ({
    fileSize: DESTINOS_ARQUIVO[destinoDaRequisicao(req) ?? 'marca_logotipo'].limiteBytes,
    files: 1,
    fields: 0,
    parts: 1,
    fieldSize: 1024,
    headerPairs: 20,
  }),
});

/**
 * Arquivos e imagens (Fase 2, F2-B43; MD 3.1.6; SYNC 6.12; README da API › decisão 189): o envio pelo ERP, os
 * metadados e o conteúdo (o original ou a variante `pdv_256`). A permissão é a do cadastro dono, conferida pelo
 * destino no envio e pela categoria na leitura (`Arquivos`). O PDV baixa pelo `/sync/arquivos` (F2-B45).
 */
@Controller('arquivos')
export class ArquivosController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  /**
   * `POST /api/arquivos?destino=produto_foto` (ou `loja_logotipo&lojaId=…`), multipart com o campo `arquivo`. Devolve
   * o arquivo gravado (id, sha256, variantes): o cadastro dono guarda o id ao gravar.
   */
  @Post()
  @HttpCode(201)
  @UseInterceptors(LimiteEnvioArquivo, upload, VagaEnvioArquivo)
  enviar(
    @UploadedFile() arquivo: ArquivoRecebido | undefined,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<ArquivoInfo> {
    const envio = validar(envioArquivoSchema, query);
    if (!arquivo)
      throw new ErroApi('VALIDACAO', 'Escolha o arquivo.', { campos: { arquivo: ['Escolha o arquivo'] } });
    // O multer decodifica o nome como Latin-1; o navegador manda UTF-8.
    const nome = Buffer.from(arquivo.originalname, 'latin1').toString('utf8');
    return this.s.arquivos.enviar(sessao, envio, nome, arquivo.buffer);
  }

  @Get(':id')
  obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<ArquivoInfo> {
    return this.s.arquivos.obter(sessao, validarId(idBruto));
  }

  /**
   * O conteúdo, com o `Content-Type` gravado (o detectado no envio: só imagem PNG/JPEG/WebP ou PDF, nunca HTML nem
   * SVG), `nosniff` (o navegador não "adivinha" outro tipo), uma CSP que não roda nada se alguém abrir o endereço
   * direto, o nome `<id>.<ext>` (nunca o do cliente) e o `ETag` com o sha256. A imagem vai `inline` (a tela mostra);
   * o PDF, como download.
   */
  @Get(':id/conteudo')
  async conteudo(
    @Param('id') idBruto: string,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { variante } = validar(conteudoArquivoSchema, query);
    const id = validarId(idBruto);
    const c = await this.s.arquivos.conteudo(sessao, id, variante);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', `"${c.sha256}"`);
    const nome = `${id}${variante ? `.${variante}` : ''}.${c.extensao}`;
    return new StreamableFile(c.conteudo, {
      type: c.tipoMime,
      length: c.conteudo.length,
      disposition: `${c.tipoMime.startsWith('image/') ? 'inline' : 'attachment'}; filename="${nome}"`,
    });
  }
}

function validarId(bruto: string): string {
  const r = z.uuid().safeParse(bruto);
  if (!r.success) throw ErroApi.naoEncontrado('Arquivo não encontrado.');
  return r.data;
}
