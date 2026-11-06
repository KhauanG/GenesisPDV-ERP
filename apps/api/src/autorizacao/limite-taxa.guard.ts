import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { RequisicaoGenesis } from '../comum/requisicao.js';

/**
 * Conta alvo da tentativa, para o limite por conta (ERP 4.1: "IP e código+login"): empresa + login no ERP, e-mail no
 * painel e, em rotas autenticadas (troca de senha), o próprio usuário. `null` = a rota não tem conta (só o limite
 * por IP vale).
 */
export function contaDaRequisicao(req: RequisicaoGenesis): string | null {
  if (req.sessao) return `usuario:${req.sessao.empresa.empresaId}:${req.sessao.usuarioId}`;
  const corpo = (req.body ?? {}) as Record<string, unknown>;
  const texto = (v: unknown) =>
    typeof v === 'string' || typeof v === 'number' ? String(v).trim().toLowerCase() : '';
  const login = texto(corpo.login);
  const codigo = texto(corpo.codigoEmpresa);
  if (codigo && login) return `erp:${codigo}:${login.slice(0, 60)}`;
  const email = texto(corpo.email);
  if (email) return `plataforma:${email.slice(0, 254)}`;
  return null;
}

/** Dois limites nas rotas de credenciais: por IP e por conta (o segundo resiste a IPs distribuídos). */
export function limitesDeTaxa(porIpMinuto: number, porContaMinuto: number): ThrottlerOptions[] {
  return [
    { name: 'ip', ttl: 60_000, limit: porIpMinuto },
    {
      name: 'conta',
      ttl: 60_000,
      limit: porContaMinuto,
      skipIf: (ctx: ExecutionContext) =>
        contaDaRequisicao(ctx.switchToHttp().getRequest<RequisicaoGenesis>()) === null,
      getTracker: (req) => contaDaRequisicao(req as RequisicaoGenesis) ?? 'sem-conta',
    },
  ];
}

/**
 * Limite de taxa nas rotas de login/refresh/troca de senha (ERP 4.1). Subclasse só para injetar as dependências
 * explicitamente: a API não emite metadados de decorators (ver README › Decisões de implementação).
 */
@Injectable()
export class LimiteTaxaGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() opcoes: ThrottlerModuleOptions,
    @InjectThrottlerStorage() armazenamento: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
  ) {
    super(opcoes, armazenamento, reflector);
  }
}
