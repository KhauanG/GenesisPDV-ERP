import { Controller, Get, Header, Inject, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Publico } from '../autorizacao/decorators.js';
import type { RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import type { Servicos } from '../servicos.js';
import { autorizarMonitor } from './monitor-token.js';

const INICIO = Date.now();

@Controller('saude')
export class SaudeController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  /** Monitor externo de disponibilidade (VG 13), fora do prefixo `/api`. Não expõe nada além do estado. */
  @Publico()
  @Get()
  async saude(@Res({ passthrough: true }) res: Response) {
    let banco: 'ok' | 'erro' = 'ok';
    try {
      await this.s.controle.pool.query('select 1');
    } catch {
      banco = 'erro';
    }
    if (banco !== 'ok') res.status(503);
    return {
      status: banco === 'ok' ? 'ok' : 'degradado',
      banco_controle: banco,
      ambiente: this.s.config.ambiente,
      pools_empresas: this.s.pools.tamanho,
      no_ar_desde: new Date(INICIO).toISOString(),
      agora: new Date().toISOString(),
    };
  }

  /**
   * `GET /api/saude/detalhada` (Implantação do piloto, I1b): painel do monitoramento, com o token de monitoramento
   * (`Authorization: Bearer <token>`; nunca a sessão do ERP). Formato em infra/producao/README.md › Monitoramento.
   * Autorizado, responde sempre 200: o `status` do corpo diz se algo está degradado.
   */
  @Publico()
  @Get('detalhada')
  @Header('Cache-Control', 'no-store')
  async detalhada(@Req() req: RequisicaoGenesis) {
    autorizarMonitor(req, this.s.config.monitor.tokenSha256);
    return this.s.saudeDetalhada.gerar();
  }
}
