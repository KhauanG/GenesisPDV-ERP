import { Body, Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { LimiteTaxaGuard } from '../autorizacao/limite-taxa.guard.js';
import { loginPlataformaSchema } from '@genesis/shared';
import type { Response } from 'express';
import { COOKIE_REFRESH_PLATAFORMA, gravarCookie, limparCookie } from '../auth/cookies.js';
import { Publico, RotaPlataforma } from '../autorizacao/decorators.js';
import { metaDaRequisicao, Req, SessaoAdmin, type RequisicaoGenesis } from '../comum/requisicao.js';
import { ErroApi } from '../comum/erros.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';
import type { SessaoPlataforma } from './admin-auth.service.js';

const CAMINHO = '/api/plataforma/auth';

@Controller('plataforma/auth')
export class PlataformaAuthController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Publico()
  @UseGuards(LimiteTaxaGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() corpo: unknown,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.s.adminAuth.login(validar(loginPlataformaSchema, corpo), metaDaRequisicao(req));
    gravarCookie(
      res,
      COOKIE_REFRESH_PLATAFORMA,
      r.refreshToken,
      r.refreshExpiraEm,
      CAMINHO,
      this.s.config.cookieSeguro,
    );
    return { tokenAcesso: r.tokenAcesso, expiraEm: r.expiraEm, admin: r.admin };
  }

  @Publico()
  @UseGuards(LimiteTaxaGuard)
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: RequisicaoGenesis, @Res({ passthrough: true }) res: Response) {
    try {
      const r = await this.s.adminAuth.refresh(
        req.cookies?.[COOKIE_REFRESH_PLATAFORMA] as string | undefined,
        metaDaRequisicao(req),
      );
      gravarCookie(
        res,
        COOKIE_REFRESH_PLATAFORMA,
        r.refreshToken,
        r.refreshExpiraEm,
        CAMINHO,
        this.s.config.cookieSeguro,
      );
      return { tokenAcesso: r.tokenAcesso, expiraEm: r.expiraEm, admin: r.admin };
    } catch (e) {
      // Refresh concorrente: o cookie novo já foi (ou será) gravado pela requisição que venceu.
      if (!(e instanceof ErroApi && e.codigo === 'REFRESH_CONCORRENTE'))
        limparCookie(res, COOKIE_REFRESH_PLATAFORMA, CAMINHO, this.s.config.cookieSeguro);
      throw e;
    }
  }

  @Publico()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequisicaoGenesis, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.s.adminAuth.logout(
      req.cookies?.[COOKIE_REFRESH_PLATAFORMA] as string | undefined,
      req.ip ?? null,
    );
    limparCookie(res, COOKIE_REFRESH_PLATAFORMA, CAMINHO, this.s.config.cookieSeguro);
  }

  @RotaPlataforma()
  @Get('eu')
  eu(@SessaoAdmin() sessao: SessaoPlataforma) {
    return { id: sessao.adminId, nome: sessao.nome, email: sessao.email, papel: sessao.papel };
  }
}
