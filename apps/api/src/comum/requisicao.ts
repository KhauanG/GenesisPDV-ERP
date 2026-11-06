import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { OrigemAcao } from '../auditoria/auditoria.service.js';
import type { MetaRequisicao, SessaoErp } from '../auth/auth.service.js';
import type { SessaoPlataforma } from '../plataforma/admin-auth.service.js';
import type { ContextoEmpresa } from '../tenancy/contexto.js';
import { ErroApi } from './erros.js';

export interface RequisicaoGenesis extends Request {
  sessao?: SessaoErp;
  sessaoPlataforma?: SessaoPlataforma;
  contextoEmpresa?: ContextoEmpresa;
}

export function metaDaRequisicao(req: RequisicaoGenesis): MetaRequisicao {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua : null,
    requisicaoId: typeof req.id === 'string' ? req.id : null,
  };
}

/** Quem fez a ação, para a auditoria (ERP 17.2). */
export function origemDaRequisicao(req: RequisicaoGenesis): OrigemAcao {
  const meta = metaDaRequisicao(req);
  return {
    origem: 'erp',
    usuarioId: req.sessao?.usuarioId ?? null,
    usuarioNome: req.sessao?.usuarioNome ?? null,
    ip: meta.ip,
    userAgent: meta.userAgent,
    requisicaoId: meta.requisicaoId,
  };
}

export const Sessao = createParamDecorator((_: unknown, ctx: ExecutionContext): SessaoErp => {
  const req = ctx.switchToHttp().getRequest<RequisicaoGenesis>();
  if (!req.sessao) throw ErroApi.naoAutenticado();
  return req.sessao;
});

export const SessaoAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext): SessaoPlataforma => {
  const req = ctx.switchToHttp().getRequest<RequisicaoGenesis>();
  if (!req.sessaoPlataforma) throw ErroApi.naoAutenticado();
  return req.sessaoPlataforma;
});

export const Req = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest<RequisicaoGenesis>(),
);
