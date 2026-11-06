import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import type { Servicos } from '../servicos.js';

/** Roda o handler dentro do ContextoEmpresa resolvido pelo guard (AsyncLocalStorage). */
@Injectable()
export class ContextoEmpresaInterceptor implements NestInterceptor {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const contexto = ctx.switchToHttp().getRequest<RequisicaoGenesis>().contextoEmpresa;
    if (!contexto) return next.handle();
    return new Observable((assinante) => {
      const assinatura = this.s.tenancy.executarNaEmpresa(contexto, () => next.handle().subscribe(assinante));
      return () => assinatura.unsubscribe();
    });
  }
}
