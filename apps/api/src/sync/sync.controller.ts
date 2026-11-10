import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Publico } from '../autorizacao/decorators.js';
import { LimiteTaxaGuard } from '../autorizacao/limite-taxa.guard.js';
import { Req, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import type { Servicos } from '../servicos.js';
import {
  ativarSchema,
  eventosStatusQuerySchema,
  heartbeatSchema,
  pullQuerySchema,
  recuperarQuerySchema,
  renovarTokenSchema,
  saldosOutrasLojasQuerySchema,
  validarSync,
} from './contratos.js';
import { exigirHardware, lerCabecalhos, type EndpointSync, type TerminalAutenticado } from './terminal.js';

/**
 * Protocolo de sincronização PDV ↔ nuvem (SYNC; fora do prefixo `/api`). Autenticação pelo token do terminal,
 * nunca pelo JWT do ERP: as rotas são públicas para o guard global e cada uma autentica o terminal.
 */
@Publico()
@Controller('sync')
export class SyncController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  private async noTerminal<T>(
    req: RequisicaoGenesis,
    res: Response,
    endpoint: EndpointSync,
    fn: (t: TerminalAutenticado) => Promise<T>,
  ): Promise<T> {
    const t = await this.s.terminalAuth.autenticar(req, endpoint);
    const r = await this.s.tenancy.executarNaEmpresa(t.contexto, async () => {
      // O alerta vem antes do 409 de hardware: o clone em outra máquina também é registrado (SYNC 3.7).
      if (t.tokenAnteriorReutilizado) await this.s.token.registrarAnteriorReutilizado(t);
      exigirHardware(t, endpoint);
      return fn(t);
    });
    res.setHeader('X-Agora-Servidor', new Date().toISOString());
    return r;
  }

  @UseGuards(LimiteTaxaGuard)
  @Post('ativar')
  @HttpCode(201)
  async ativar(
    @Body() corpo: unknown,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cabecalhos = lerCabecalhos(req.headers);
    const r = await this.s.ativacao.ativar(validarSync(ativarSchema, corpo), {
      ip: req.ip ?? '0.0.0.0',
      requisicaoId: cabecalhos.requisicaoId,
    });
    res.setHeader('X-Agora-Servidor', new Date().toISOString());
    return r;
  }

  @Get('estado')
  estado(@Req() req: RequisicaoGenesis, @Res({ passthrough: true }) res: Response) {
    return this.noTerminal(req, res, 'estado', (t) => this.s.heartbeat.estado(t));
  }

  @Get('pull')
  pull(@Query() query: unknown, @Req() req: RequisicaoGenesis, @Res({ passthrough: true }) res: Response) {
    return this.noTerminal(req, res, 'pull', (t) =>
      this.s.pull.puxar(t, validarSync(pullQuerySchema, query)),
    );
  }

  @Post('push')
  @HttpCode(200)
  push(@Body() corpo: unknown, @Req() req: RequisicaoGenesis, @Res({ passthrough: true }) res: Response) {
    return this.noTerminal(req, res, 'push', (t) => this.s.push.receber(t, corpo));
  }

  /** Rotação do token (SYNC 3.7): autenticada pelo token atual, ou pelo anterior só na repetição do mesmo `requisicao_id`. */
  @Post('token/renovar')
  @HttpCode(200)
  renovarToken(
    @Body() corpo: unknown,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.noTerminal(req, res, 'token', (t) =>
      this.s.token.renovar(t, validarSync(renovarTokenSchema, corpo)),
    );
  }

  @Post('heartbeat')
  @HttpCode(200)
  heartbeat(
    @Body() corpo: unknown,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.noTerminal(req, res, 'heartbeat', (t) =>
      this.s.heartbeat.receber(t, validarSync(heartbeatSchema, corpo ?? {})),
    );
  }

  /** Rede de segurança dos `rejeitado` do PDV (SYNC 7.2, 21.1): situação atual dos eventos deste terminal. */
  @Get('eventos-status')
  eventosStatus(
    @Query() query: unknown,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.noTerminal(req, res, 'eventos-status', (t) =>
      this.s.heartbeat.eventosStatus(t, validarSync(eventosStatusQuerySchema, query)),
    );
  }

  /**
   * Re-hidratação do banco local restaurado ou antigo (SYNC 22.1, 22.2; C17): os eventos deste terminal depois da
   * sequência pedida, com o envelope original e a situação na nuvem.
   */
  @Get('recuperar')
  recuperar(
    @Query() query: unknown,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.noTerminal(req, res, 'recuperar', (t) =>
      this.s.recuperar.recuperar(t, validarSync(recuperarQuerySchema, query)),
    );
  }

  /**
   * F4 "Outras lojas" da pesquisa F2 (Fase 2, F2-B35; PDV 10.3; F2-Q12 = D53): o saldo vendável do produto nas lojas
   * reais e no CD, só quantidades (`consultas.ts`). Consulta online fora do T13; a API antiga responde 404.
   */
  @Get('consultas/saldos-outras-lojas')
  saldosOutrasLojas(
    @Query() query: unknown,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.noTerminal(req, res, 'consulta-saldos', (t) =>
      this.s.consultas.saldosOutrasLojas(t, validarSync(saldosOutrasLojasQuerySchema, query)),
    );
  }
}
