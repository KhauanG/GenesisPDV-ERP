import type { ArgumentsHost } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ErroApi } from './erros.js';
import { FiltroErros } from './filtro-erros.js';

function executar(excecao: unknown, url = '/api/produtos') {
  const res = { statusCode: 0, corpo: undefined as unknown, cabecalhos: {} as Record<string, string> };
  const resposta = {
    status(s: number) {
      res.statusCode = s;
      return this;
    },
    json(c: unknown) {
      res.corpo = c;
    },
    setHeader(k: string, v: string) {
      res.cabecalhos[k] = v;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => resposta,
      getRequest: () => ({ id: 'req-1', originalUrl: url }),
    }),
  } as unknown as ArgumentsHost;
  const logger = { error: vi.fn() };
  new FiltroErros(logger).catch(excecao, host);
  return { ...res, logger };
}

describe('FiltroErros (envelope ERP 1.8)', () => {
  it('ErroApi vira { codigo, mensagem, campos, requisicao_id } com o status do código', () => {
    const r = executar(
      ErroApi.validacao(z.object({ cpf: z.string().min(11) }).safeParse({ cpf: '1' }).error!),
    );
    expect(r.statusCode).toBe(422);
    expect(r.corpo).toMatchObject({
      codigo: 'VALIDACAO',
      campos: { cpf: [expect.any(String)] },
      requisicao_id: 'req-1',
    });
  });

  it('manutenção traz Retry-After; limite de taxa vira 429 LIMITE_TAXA', () => {
    expect(executar(ErroApi.manutencao(30)).cabecalhos['Retry-After']).toBe('30');
    const r = executar(new ThrottlerException());
    expect(r.statusCode).toBe(429);
    expect((r.corpo as { codigo: string }).codigo).toBe('LIMITE_TAXA');
  });

  it('erro desconhecido vira 500 ERRO_INTERNO sem detalhes internos (e é logado)', () => {
    const r = executar(new Error('senha do banco: xyz'));
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.corpo)).not.toContain('xyz');
    expect(r.logger.error).toHaveBeenCalled();
  });

  it('erros do PostgreSQL conhecidos e rota inexistente', () => {
    expect(executar({ code: 'P0001', message: 'DOCUMENTO_IMUTAVEL' }).corpo).toMatchObject({
      codigo: 'REGRA_NEGOCIO',
    });
    expect(executar({ code: '23505' }).statusCode).toBe(409);
    // Conta derivada além da coluna numeric (o total do item do acerto, F2-B9): 422, não erro interno.
    expect(executar({ code: '22003', message: 'numeric field overflow' }).corpo).toMatchObject({
      codigo: 'VALIDACAO',
    });
    expect(executar(new NotFoundException()).corpo).toMatchObject({ codigo: 'NAO_ENCONTRADO' });
  });

  it('trava 7300001 ocupada além do limite (55P03) vira 503 SISTEMA_OCUPADO com Retry-After (C13)', () => {
    const r = executar({ cause: { code: '55P03', message: 'canceling statement due to lock timeout' } });
    expect(r.statusCode).toBe(503);
    expect(r.cabecalhos['Retry-After']).toBe('5');
    expect(r.corpo).toMatchObject({
      codigo: 'SISTEMA_OCUPADO',
      mensagem: expect.stringContaining('Nada foi gravado'),
    });
    expect(r.logger.error).not.toHaveBeenCalled();
  });

  it('no sync a trava ocupada (55P03) é transitória: 503 MANUTENCAO com Retry-After, sem log de erro (SYNC 2.5)', () => {
    const r = executar(
      { cause: { code: '55P03', message: 'canceling statement due to lock timeout' } },
      '/sync/heartbeat',
    );
    expect(r.statusCode).toBe(503);
    expect(r.cabecalhos['Retry-After']).toBe('5');
    expect(r.cabecalhos['X-Agora-Servidor']).toBeDefined();
    expect(r.corpo).toMatchObject({ erro: { codigo: 'MANUTENCAO', requisicao_id: 'req-1' } });
    expect(r.logger.error).not.toHaveBeenCalled();
  });
});
