import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { ErroApi as EnvelopeErro } from '@genesis/shared';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ErroSync, type CodigoSync } from '../sync/erros.js';
import { TRAVA_OCUPADA } from '../tenancy/tenancy.js';
import { ErroApi } from './erros.js';

interface ErroPostgres {
  code?: string;
  message?: string;
}

/** O Drizzle embrulha o erro do driver (`DrizzleQueryError.cause`). */
function erroPostgres(excecao: unknown): ErroPostgres | undefined {
  const bruto = excecao as (ErroPostgres & { cause?: ErroPostgres }) | undefined;
  return bruto?.code ? bruto : (bruto?.cause ?? bruto);
}

const codigoPostgres = (excecao: unknown) => erroPostgres(excecao)?.code;

/** Converte qualquer exceção no envelope padrão (ERP 1.8) sem vazar detalhes internos. */
@Catch()
export class FiltroErros implements ExceptionFilter {
  constructor(private readonly logger: { error(obj: object, msg: string): void }) {}

  catch(excecao: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requisicaoId = typeof req.id === 'string' ? req.id : undefined;
    if ((req.originalUrl ?? req.url ?? '').startsWith('/sync/')) {
      this.responderSync(excecao, res, requisicaoId);
      return;
    }
    const erro = this.converter(excecao);

    if (erro.status >= 500 && erro.codigo === 'ERRO_INTERNO') {
      this.logger.error({ err: excecao, requisicao_id: requisicaoId }, 'erro não tratado');
    }
    for (const [k, v] of Object.entries(erro.extras.cabecalhos ?? {})) res.setHeader(k, v);
    const corpo: EnvelopeErro = {
      codigo: erro.codigo,
      mensagem: erro.message,
      ...(erro.extras.campos ? { campos: erro.extras.campos } : {}),
      ...(erro.extras.detalhes ? { detalhes: erro.extras.detalhes } : {}),
      ...(requisicaoId ? { requisicao_id: requisicaoId } : {}),
    };
    res.status(erro.status).json(corpo);
  }

  /** Envelope próprio do protocolo de sincronização (SYNC 2.4), com `X-Agora-Servidor` (SYNC 2.2). */
  private responderSync(excecao: unknown, res: Response, requisicaoId: string | undefined): void {
    const erro = this.converterSync(excecao);
    if (erro.status >= 500 && erro.codigo === 'ERRO_INTERNO') {
      this.logger.error({ err: excecao, requisicao_id: requisicaoId }, 'erro não tratado no sync');
    }
    for (const [k, v] of Object.entries(erro.cabecalhos)) res.setHeader(k, v);
    res.setHeader('X-Agora-Servidor', new Date().toISOString());
    res.status(erro.status).json({
      erro: {
        codigo: erro.codigo,
        mensagem: erro.message,
        detalhes: erro.detalhes,
        requisicao_id: requisicaoId ?? null,
      },
    });
  }

  private converterSync(excecao: unknown): ErroSync {
    if (excecao instanceof ErroSync) return excecao;
    // As rotas do PDV esperam a 7300001 sem limite (C13); se alguma vier a ter `lock_timeout`, a trava ocupada é
    // transitória (SYNC 2.5: MANUTENCAO com Retry-After), nunca um 500 "não tratado".
    if (codigoPostgres(excecao) === TRAVA_OCUPADA) return ErroSync.manutencao(5);
    if (excecao instanceof ThrottlerException) {
      return new ErroSync('LIMITE_TAXA', 'Muitas requisições.', {}, { 'Retry-After': '60' });
    }
    if (excecao instanceof ErroApi) {
      const mapa: Partial<Record<ErroApi['codigo'], CodigoSync>> = {
        VALIDACAO: 'REQUISICAO_INVALIDA',
        NAO_AUTENTICADO: 'TOKEN_INVALIDO',
        SEM_PERMISSAO: 'ESCOPO_INVALIDO',
        EMPRESA_SUSPENSA: 'EMPRESA_SUSPENSA',
        EMPRESA_CANCELADA: 'EMPRESA_CANCELADA',
        LIMITE_TAXA: 'LIMITE_TAXA',
        MANUTENCAO: 'MANUTENCAO',
        NAO_ENCONTRADO: 'NAO_ENCONTRADO',
      };
      const codigo = mapa[excecao.codigo] ?? 'ERRO_INTERNO';
      const detalhes = {
        ...(excecao.extras.detalhes ?? {}),
        ...(excecao.extras.campos ? { campos: excecao.extras.campos } : {}),
      };
      return new ErroSync(codigo, excecao.message, detalhes, excecao.extras.cabecalhos ?? {});
    }
    if (excecao instanceof HttpException) {
      const status = excecao.getStatus();
      if (status === HttpStatus.PAYLOAD_TOO_LARGE)
        return new ErroSync('LOTE_GRANDE_DEMAIS', 'Lote acima do limite. Divida e reenvie.');
      if (status === HttpStatus.NOT_FOUND) return new ErroSync('NAO_ENCONTRADO', 'Rota não encontrada.');
      if (status < 500) return ErroSync.invalida('Requisição inválida.');
    }
    return new ErroSync('ERRO_INTERNO', 'Erro interno. Tente novamente.');
  }

  private converter(excecao: unknown): ErroApi {
    if (excecao instanceof ErroApi) return excecao;
    if (excecao instanceof ThrottlerException) {
      return new ErroApi('LIMITE_TAXA', 'Muitas tentativas. Aguarde um minuto e tente novamente.', {
        cabecalhos: { 'Retry-After': '60' },
      });
    }
    if (excecao instanceof HttpException) {
      const status = excecao.getStatus();
      if (status === HttpStatus.NOT_FOUND) return ErroApi.naoEncontrado('Rota não encontrada.');
      if (status === HttpStatus.UNAUTHORIZED) return ErroApi.naoAutenticado();
      if (status === HttpStatus.FORBIDDEN) return ErroApi.semPermissao();
      if (status === HttpStatus.PAYLOAD_TOO_LARGE || status === HttpStatus.BAD_REQUEST) {
        return new ErroApi('VALIDACAO', 'Requisição inválida.');
      }
    }
    const pg = erroPostgres(excecao);
    if (pg?.code === 'P0001' && pg.message === 'DOCUMENTO_IMUTAVEL') {
      return new ErroApi('REGRA_NEGOCIO', 'Documento efetivado não pode ser alterado.');
    }
    if (pg?.code === 'P0001' && pg.message === 'FILTRO_IMUTAVEL') {
      return new ErroApi(
        'REGRA_NEGOCIO',
        'Este vínculo não pode ser alterado; exclua e crie outro registro.',
      );
    }
    if (pg?.code === 'P0001' && pg.message === 'LOTE_INVALIDO') {
      return new ErroApi('VALIDACAO', 'O lote não é deste produto ou é de outro estoque.');
    }
    if (pg?.code === 'P0001' && pg.message === 'COMPOSICAO_CICLICA') {
      return new ErroApi(
        'REGRA_NEGOCIO',
        'A composição forma um ciclo: um produto não pode conter a si mesmo.',
        {
          campos: { componentes: ['A composição forma um ciclo (o produto acabaria contendo a si mesmo)'] },
        },
      );
    }
    if (pg?.code === 'P0001' && pg.message === 'EAN_DUPLICADO') {
      return new ErroApi('CONFLITO', 'EAN já cadastrado em outro produto.', {
        campos: { codigosBarras: ['EAN já cadastrado em outro produto'] },
      });
    }
    if (pg?.code === TRAVA_OCUPADA) {
      // Só a espera pela 7300001 tem `lock_timeout` (Tenancy.transacao, C13): a transação inteira voltou.
      return new ErroApi(
        'SISTEMA_OCUPADO',
        'O sistema está ocupado recebendo as vendas dos caixas. Nada foi gravado: tente salvar de novo em alguns segundos.',
        { cabecalhos: { 'Retry-After': '5' } },
      );
    }
    if (pg?.code === '23505' || pg?.code === '23P01') {
      return new ErroApi('CONFLITO', 'Já existe um registro com estes dados.');
    }
    if (pg?.code === '23503') return new ErroApi('VALIDACAO', 'Registro relacionado inexistente.');
    if (pg?.code === '23514') return new ErroApi('VALIDACAO', 'Dados inconsistentes para este cadastro.');
    // Valor numérico além da precisão da coluna (`numeric(15,3)`/`numeric(15,2)`): o contrato recusa antes, e o que
    // chega aqui é uma conta derivada (o total do item do acerto); 422 em vez de erro interno.
    if (pg?.code === '22003')
      return new ErroApi(
        'VALIDACAO',
        'Valor acima do limite do sistema: confira as quantidades e os preços informados.',
      );
    return new ErroApi(
      'ERRO_INTERNO',
      'Erro interno. Se persistir, informe o código da requisição ao suporte.',
    );
  }
}
