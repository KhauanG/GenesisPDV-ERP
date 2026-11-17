/**
 * Prazo de leitura dos envios em multipart (README da API › decisão 202): o envio que não chega inteiro no prazo
 * termina com 408 `TEMPO_ESGOTADO` e `Connection: close`, solta o que a rota segura (os contadores do envio) e para de
 * receber; com o corpo já lido, o prazo não corta o processamento. E toda rota de envio em multipart tem o prazo como
 * o primeiro interceptor.
 */
import { EventEmitter } from 'node:events';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArquivosController } from '../arquivos/arquivos.controller.js';
import { NotasEntradaController } from '../entradas/notas-entrada.controller.js';
import { AcertosController } from '../estoques/acertos.controller.js';
import { ImportacoesController } from '../importacao/importacao.controller.js';
import type { Servicos } from '../servicos.js';
import { ErroApi } from './erros.js';
import { PrazoLeituraEnvio } from './prazo-envio.js';

const PRAZO_MS = 5_000;

function montar() {
  const req = Object.assign(new EventEmitter(), { complete: false, pause: vi.fn() });
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  let encerrada = false;
  let concluir: (() => void) | undefined;
  // A rota que ainda lê o corpo: só termina quando o teste manda.
  const next: CallHandler = {
    handle: () =>
      new Observable((a) => {
        concluir = () => {
          a.next('ok');
          a.complete();
        };
        return () => {
          encerrada = true;
        };
      }),
  };
  const s = { config: { envioArquivo: { prazoLeituraMs: PRAZO_MS } } } as unknown as Servicos;
  const resultado: { erro?: unknown; valores: unknown[] } = { valores: [] };
  new PrazoLeituraEnvio(s).intercept(ctx, next).subscribe({
    next: (v) => resultado.valores.push(v),
    error: (e: unknown) => (resultado.erro = e),
  });
  return { req, resultado, encerrada: () => encerrada, concluir: () => concluir?.() };
}

describe('PrazoLeituraEnvio', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('o corpo que não chega no prazo: 408 TEMPO_ESGOTADO com Connection: close, a rota solta e a leitura para', () => {
    const { req, resultado, encerrada } = montar();
    vi.advanceTimersByTime(PRAZO_MS - 1);
    expect(resultado.erro).toBeUndefined();
    expect(encerrada()).toBe(false);
    vi.advanceTimersByTime(1);
    const erro = resultado.erro as ErroApi;
    expect(erro).toBeInstanceOf(ErroApi);
    expect(erro.codigo).toBe('TEMPO_ESGOTADO');
    expect(erro.extras.cabecalhos).toEqual({ Connection: 'close' });
    // O interceptor seguinte (o `LimiteEnvioNfe`, com os contadores no `finalize`) foi encerrado.
    expect(encerrada()).toBe(true);
    expect(req.pause).toHaveBeenCalled();
  });

  it('com o corpo já lido, o prazo não corta o processamento', () => {
    const { req, resultado, encerrada, concluir } = montar();
    req.complete = true;
    vi.advanceTimersByTime(PRAZO_MS * 3);
    expect(resultado.erro).toBeUndefined();
    expect(encerrada()).toBe(false);
    concluir();
    expect(resultado.valores).toEqual(['ok']);
    expect(req.pause).not.toHaveBeenCalled();
  });

  it('terminada a resposta, o prazo é desarmado', () => {
    const { resultado, concluir } = montar();
    concluir();
    expect(vi.getTimerCount()).toBe(0);
    expect(resultado.valores).toEqual(['ok']);
  });
});

describe('rotas de envio em multipart', () => {
  it.each([
    ['POST /notas-entrada/importar', NotasEntradaController.prototype.importar],
    ['POST /arquivos', ArquivosController.prototype.enviar],
    ['POST /importacoes/produtos/previa', ImportacoesController.prototype.previaProdutos],
    ['POST /importacoes/clientes/previa', ImportacoesController.prototype.previaClientes],
    ['POST /acertos/:id/importar-contagem', AcertosController.prototype.importarContagem],
  ])('%s tem o prazo de leitura como o primeiro interceptor', (_rota, metodo) => {
    const interceptores = Reflect.getMetadata(INTERCEPTORS_METADATA, metodo) as unknown[];
    expect(interceptores[0]).toBe(PrazoLeituraEnvio);
  });

  it('na importação de NF-e, a vaga do processo vem depois do multer (o corpo já lido)', () => {
    const interceptores = Reflect.getMetadata(
      INTERCEPTORS_METADATA,
      NotasEntradaController.prototype.importar,
    ) as Array<{ name: string }>;
    expect(interceptores.map((i) => i.name)).toEqual([
      'PrazoLeituraEnvio',
      'LimiteEnvioNfe',
      // O `FilesInterceptor` do multer (uma classe com nome gerado).
      expect.any(String),
      'VagaEnvioNfe',
    ]);
  });
});
