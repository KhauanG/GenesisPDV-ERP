import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  descartarEventoSchema,
  reprocessarLoteSchema,
  type ReprocessamentoAgendado,
  type ResultadoDescarte,
  type ResultadoReprocessamento,
} from '@genesis/shared';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';

/**
 * Ações da fila de decisão (ERP 12.5, 12.6; SYNC 11.4), sobre a linha de `eventos_recebidos` (`:id` é o `id` da linha,
 * o mesmo da aba "Eventos com erro"). Todas com `terminais.gerenciar` e auditadas; a listagem continua em
 * `GET /terminais/:id/eventos-erro`.
 */
@Controller('eventos-recebidos')
export class EventosRecebidosController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  /** Os `erro` do terminal com o código, numa tarefa em segundo plano (`202` com o id da tarefa). */
  @Permissao('terminais.gerenciar')
  @Post('reprocessar-lote')
  @HttpCode(202)
  reprocessarLote(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ReprocessamentoAgendado> {
    return this.s.filaDecisao.agendarLote(
      sessao,
      validar(reprocessarLoteSchema, corpo),
      origemDaRequisicao(req),
    );
  }

  @Permissao('terminais.gerenciar')
  @Post(':id/reprocessar')
  @HttpCode(200)
  reprocessar(
    @Param('id') id: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoReprocessamento> {
    return this.s.filaDecisao.reprocessar(sessao, validar(z.uuid(), id), origemDaRequisicao(req));
  }

  @Permissao('terminais.gerenciar')
  @Post(':id/aplicar-novo-numero')
  @HttpCode(200)
  aplicarNovoNumero(
    @Param('id') id: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoReprocessamento> {
    return this.s.filaDecisao.aplicarNovoNumero(sessao, validar(z.uuid(), id), origemDaRequisicao(req));
  }

  @Permissao('terminais.gerenciar')
  @Post(':id/descartar')
  @HttpCode(200)
  descartar(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoDescarte> {
    return this.s.filaDecisao.descartar(
      sessao,
      validar(z.uuid(), id),
      validar(descartarEventoSchema, corpo),
      origemDaRequisicao(req),
    );
  }
}
