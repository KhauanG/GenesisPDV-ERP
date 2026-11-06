import { Controller, Get, Inject, Query } from '@nestjs/common';
import { prontidaoQuerySchema, type Prontidao } from '@genesis/shared';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { Sessao } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';
import { ProntidaoLojas } from './prontidao.js';

/**
 * Implantação › Prontidão da loja (implantação do piloto, I5): só leitura, com `configuracoes.ver` (a permissão de
 * administração que o gerente e o administrador já têm; README › decisões) e a loja entre as permitidas do usuário.
 * A resposta não leva dado pessoal (`prontidao.ts`).
 */
@Controller('implantacao')
export class ImplantacaoController {
  private readonly prontidaoLojas: ProntidaoLojas;

  constructor(@Inject(SERVICOS) s: Servicos) {
    this.prontidaoLojas = new ProntidaoLojas(s.controle, s.tenancy, s.terminais);
  }

  @Permissao('configuracoes.ver')
  @Get('prontidao')
  async prontidao(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Prontidao> {
    const { lojaId } = validar(prontidaoQuerySchema, query);
    return this.prontidaoLojas.avaliar(sessao, lojaId);
  }
}
