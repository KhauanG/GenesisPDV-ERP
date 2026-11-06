import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  confirmarImportacaoSchema,
  LIMITE_ARQUIVO_IMPORTACAO,
  opcoesImportacaoSchema,
  type PreviaImportacao,
  type TipoImportacao,
} from '@genesis/shared';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { ErroApi } from '../comum/erros.js';
import { garantirLimitePorMinuto, limiteDoAmbiente } from '../comum/limites-processo.js';
import { Sessao } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';
import { formatoPlanilha } from './planilha.js';

/** O que o multer entrega (memória; o limite de 10 MB é conferido antes de ler). */
interface ArquivoEnviado {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/** Multipart: um arquivo e poucas opções curtas (sem campos/partes ilimitados). */
const upload = FileInterceptor('arquivo', {
  limits: { fileSize: LIMITE_ARQUIVO_IMPORTACAO, files: 1, fields: 20, parts: 25, fieldSize: 64 * 1024 },
});

/** Tipo do objeto no armazenamento pelo conteúdo, nunca o `Content-Type` do cliente (que serviria HTML). */
const TIPO_MIME: Record<'xlsx' | 'csv', string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

/** Prévias por usuário por minuto (cada uma grava até 10 MB no armazenamento e lê a planilha inteira). */
const previasPorMinuto = () => limiteDoAmbiente('IMPORTACAO_PREVIAS_POR_MINUTO', 10);

function conferirArquivo(a: ArquivoEnviado | undefined): {
  nome: string;
  conteudo: Buffer;
  tipoMime: string;
} {
  if (!a) throw new ErroApi('VALIDACAO', 'Envie a planilha.', { campos: { arquivo: ['Escolha o arquivo'] } });
  if (!/\.(xlsx|csv|txt)$/i.test(a.originalname))
    throw new ErroApi('VALIDACAO', 'Envie uma planilha .xlsx ou .csv.', {
      campos: { arquivo: ['Formato inválido'] },
    });
  // O multer decodifica o nome como Latin-1; o navegador manda UTF-8.
  const nome = Buffer.from(a.originalname, 'latin1').toString('utf8');
  return { nome, conteudo: a.buffer, tipoMime: TIPO_MIME[formatoPlanilha(nome, a.buffer)] };
}

/**
 * Importação por planilha (ERP 8.6): `previa` (multipart: `arquivo` + opções) valida sem gravar; `confirmar` cria a
 * tarefa em segundo plano (acompanhada em `GET /tarefas/:id`); `modelo` baixa o layout.
 */
@Controller('importacoes')
export class ImportacoesController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('produtos.importar')
  @Get('produtos/modelo')
  modeloProdutos() {
    return this.modelo('produtos');
  }

  @Permissao('pessoas.importar')
  @Get('clientes/modelo')
  modeloClientes() {
    return this.modelo('clientes');
  }

  @Permissao('produtos.importar')
  @Post('produtos/previa')
  @HttpCode(200)
  @UseInterceptors(upload)
  previaProdutos(
    @UploadedFile() arquivo: ArquivoEnviado | undefined,
    @Body() corpo: unknown,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<PreviaImportacao> {
    return this.previa('produtos', arquivo, corpo, query, sessao);
  }

  @Permissao('pessoas.importar')
  @Post('clientes/previa')
  @HttpCode(200)
  @UseInterceptors(upload)
  previaClientes(
    @UploadedFile() arquivo: ArquivoEnviado | undefined,
    @Body() corpo: unknown,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<PreviaImportacao> {
    return this.previa('clientes', arquivo, corpo, query, sessao);
  }

  @Permissao('produtos.importar')
  @Post('produtos/confirmar')
  @HttpCode(202)
  confirmarProdutos(@Body() corpo: unknown, @Sessao() sessao: SessaoErp) {
    return this.s.importacoes.confirmar(sessao, 'produtos', validar(confirmarImportacaoSchema, corpo));
  }

  @Permissao('pessoas.importar')
  @Post('clientes/confirmar')
  @HttpCode(202)
  confirmarClientes(@Body() corpo: unknown, @Sessao() sessao: SessaoErp) {
    return this.s.importacoes.confirmar(sessao, 'clientes', validar(confirmarImportacaoSchema, corpo));
  }

  private async modelo(tipo: TipoImportacao): Promise<StreamableFile> {
    const m = await this.s.importacoes.modelo(tipo);
    return new StreamableFile(m.conteudo, {
      type: m.tipoMime,
      length: m.conteudo.length,
      disposition: `attachment; filename="${m.nome}"`,
    });
  }

  private previa(
    tipo: TipoImportacao,
    arquivo: ArquivoEnviado | undefined,
    corpo: unknown,
    query: unknown,
    sessao: SessaoErp,
  ): Promise<PreviaImportacao> {
    garantirLimitePorMinuto(`previa:${sessao.empresa.empresaId}:${sessao.usuarioId}`, previasPorMinuto());
    const opcoes = validar(opcoesImportacaoSchema, {
      ...(query as Record<string, unknown>),
      ...((corpo as Record<string, unknown> | undefined) ?? {}),
    });
    return this.s.importacoes.previa(sessao, tipo, conferirArquivo(arquivo), opcoes);
  }
}
