import { Body, Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { LimiteTaxaGuard } from '../autorizacao/limite-taxa.guard.js';
import {
  esqueciSenhaSchema,
  loginSchema,
  redefinirSenhaSchema,
  trocarSenhaSchema,
  type RespostaEu,
  type RespostaLogin,
} from '@genesis/shared';
import type { Response } from 'express';
import { PermiteSenhaProvisoria, Publico } from '../autorizacao/decorators.js';
import { metaDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { ErroApi } from '../comum/erros.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';
import type { SessaoErp } from './auth.service.js';
import { COOKIE_REFRESH, gravarCookie, limparCookie } from './cookies.js';

const CAMINHO_COOKIE = '/api/auth';

@Controller('auth')
export class AuthController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Publico()
  @UseGuards(LimiteTaxaGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() corpo: unknown,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RespostaLogin> {
    const entrada = validar(loginSchema, corpo);
    const r = await this.s.auth.login(entrada, metaDaRequisicao(req));
    gravarCookie(
      res,
      COOKIE_REFRESH,
      r.refreshToken,
      r.refreshExpiraEm,
      CAMINHO_COOKIE,
      this.s.config.cookieSeguro,
    );
    return r.resposta;
  }

  @Publico()
  @UseGuards(LimiteTaxaGuard)
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RespostaLogin> {
    try {
      const r = await this.s.auth.refresh(
        req.cookies?.[COOKIE_REFRESH] as string | undefined,
        metaDaRequisicao(req),
      );
      gravarCookie(
        res,
        COOKIE_REFRESH,
        r.refreshToken,
        r.refreshExpiraEm,
        CAMINHO_COOKIE,
        this.s.config.cookieSeguro,
      );
      return r.resposta;
    } catch (e) {
      // Refresh concorrente: o cookie novo já foi (ou será) gravado pela requisição que venceu.
      if (!(e instanceof ErroApi && e.codigo === 'REFRESH_CONCORRENTE'))
        limparCookie(res, COOKIE_REFRESH, CAMINHO_COOKIE, this.s.config.cookieSeguro);
      throw e;
    }
  }

  @Publico()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequisicaoGenesis, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.s.auth.logout(req.cookies?.[COOKIE_REFRESH] as string | undefined, metaDaRequisicao(req));
    limparCookie(res, COOKIE_REFRESH, CAMINHO_COOKIE, this.s.config.cookieSeguro);
  }

  @PermiteSenhaProvisoria()
  @UseGuards(LimiteTaxaGuard)
  @Post('trocar-senha')
  @HttpCode(200)
  trocarSenha(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RespostaLogin> {
    return this.s.auth.trocarSenha(sessao, validar(trocarSenhaSchema, corpo), metaDaRequisicao(req));
  }

  /** ERP 4.3: resposta sempre igual (não revela se o usuário existe nem se tem e-mail). */
  @Publico()
  @UseGuards(LimiteTaxaGuard)
  @Post('esqueci-senha')
  @HttpCode(200)
  esqueciSenha(@Body() corpo: unknown, @Req() req: RequisicaoGenesis): Promise<{ mensagem: string }> {
    return this.s.redefinicao.solicitar(validar(esqueciSenhaSchema, corpo), metaDaRequisicao(req));
  }

  @Publico()
  @UseGuards(LimiteTaxaGuard)
  @Post('redefinir-senha')
  @HttpCode(200)
  redefinirSenha(@Body() corpo: unknown, @Req() req: RequisicaoGenesis): Promise<{ mensagem: string }> {
    return this.s.redefinicao.redefinir(validar(redefinirSenhaSchema, corpo), metaDaRequisicao(req));
  }

  @PermiteSenhaProvisoria()
  @Get('eu')
  eu(@Sessao() sessao: SessaoErp): Promise<RespostaEu> {
    return this.s.auth.eu(sessao);
  }
}
