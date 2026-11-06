import { Controller, Get, Inject, Param } from '@nestjs/common';
import { z } from 'zod';
import { ErroApi } from '../comum/erros.js';
import { validar } from '../comum/zod.js';
import type { SessaoErp } from '../auth/auth.service.js';
import { Sessao } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import type { Servicos } from '../servicos.js';

/** Tarefas em segundo plano do próprio usuário (ERP 3.6): sem permissão própria, cada um vê só as suas. */
@Controller('tarefas')
export class TarefasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Get()
  listar(@Sessao() sessao: SessaoErp) {
    return this.s.tarefas.doUsuario(sessao.usuarioId);
  }

  /** Uma tarefa do próprio usuário (acompanhamento da importação, ERP 8.6). */
  @Get(':id')
  async obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp) {
    const id = validar(z.uuid(), idBruto);
    const t = await this.s.tarefas.doUsuario(sessao.usuarioId, id);
    if (!t.itens[0]) throw ErroApi.naoEncontrado('Tarefa não encontrada.');
    return t.itens[0];
  }
}
