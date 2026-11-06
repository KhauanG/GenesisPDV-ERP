import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import {
  alterarTerminalSchema,
  caixasLivresQuerySchema,
  confirmarHardwareSchema,
  filtroEventosComErroSchema,
  filtroTerminaisSchema,
  gerarCodigoAtivacaoSchema,
  mensagemTerminalSchema,
  resolverAlertaTerminalSchema,
  ressincronizarTerminalSchema,
  revogarTerminalSchema,
  type AtivacoesPendentes,
  type CaixaParaAtivacao,
  type CodigoAtivacaoGerado,
  type ListagemEventosComErro,
  type ListagemTerminais,
  type TerminalDetalhe,
} from '@genesis/shared';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { garantirLoja } from '../autorizacao/lojas.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';

/**
 * PDVs/Terminais (ERP 12): listagem e detalhe (12.2, 12.4), códigos de ativação (12.3), revogação nos três modos,
 * ressincronizar, mensagem, troca de hardware, resolver o alerta de token anterior e a listagem da aba "Eventos com erro"
 * (12.5; as ações ficam em `EventosRecebidosController`). As rotas fixas (`ativacoes…`, `caixas-livres`) vêm antes das de `:id`.
 */
@Controller('terminais')
export class TerminaisController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('terminais.ver')
  @Get()
  listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<ListagemTerminais> {
    return this.s.terminais.listar(sessao, validar(filtroTerminaisSchema, query));
  }

  @Permissao('terminais.ver')
  @Get('ativacoes')
  ativacoes(@Sessao() sessao: SessaoErp): Promise<AtivacoesPendentes> {
    return this.s.terminais.ativacoesPendentes(sessao);
  }

  /** Para o modal de gerar código: só `terminais.ativar`, sem depender de `lojas.ver` (`/lojas/:id/caixas`). */
  @Permissao('terminais.ativar')
  @Get('caixas-livres')
  caixasLivres(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<CaixaParaAtivacao[]> {
    return this.s.terminais.caixasParaAtivacao(sessao, validar(caixasLivresQuerySchema, query).lojaId);
  }

  @Permissao('terminais.ativar')
  @Post('ativacoes')
  @HttpCode(201)
  async gerarCodigo(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<CodigoAtivacaoGerado> {
    const entrada = validar(gerarCodigoAtivacaoSchema, corpo);
    garantirLoja(sessao, entrada.lojaId);
    // Substituir tira o terminal atual do caixa (vai para `desativando` na ativação do novo): é uma revogação.
    if (entrada.substituiTerminalId && !sessao.permissoes.has('terminais.revogar')) {
      throw ErroApi.semPermissao('Substituir terminal exige também a permissão "PDVs/Terminais: Revogar".');
    }
    const empresa = await this.s.resolvedor.porId(sessao.empresa.empresaId);
    if (!empresa) throw ErroApi.naoAutenticado();
    const r = await this.s.ativacao.gerarCodigo(empresa, entrada, {
      id: sessao.usuarioId,
      nome: sessao.usuarioNome,
    });
    await this.s.tenancy.cx().transacao((tx) =>
      this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'criar',
        entidade: 'ativacoes_pdv',
        registroId: r.ativacaoId,
        lojaId: entrada.lojaId,
        localizacao: 'PDVs/Terminais › Gerar código',
        descricao: `Código de ativação ••••-••${r.codigo.slice(-2)} gerado (validade ${entrada.validadeHoras} h)`,
        depois: { ...entrada, expiraEm: r.expiraEm },
      }),
    );
    return { codigo: r.codigoExibicao, expiraEm: r.expiraEm, ativacaoId: r.ativacaoId };
  }

  @Permissao('terminais.ativar')
  @Post('ativacoes/liberar')
  @HttpCode(200)
  liberarAtivacoes(@Sessao() sessao: SessaoErp, @Req() req: RequisicaoGenesis) {
    return this.s.terminais.liberarAtivacoes(sessao, origemDaRequisicao(req));
  }

  @Permissao('terminais.ativar')
  @Delete('ativacoes/:id')
  @HttpCode(204)
  async cancelarAtivacao(
    @Param('id') id: string,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    await this.s.terminais.cancelarAtivacao(sessao, validar(z.uuid(), id), origemDaRequisicao(req));
  }

  @Permissao('terminais.ver')
  @Get(':id')
  detalhar(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<TerminalDetalhe> {
    return this.s.terminais.detalhar(sessao, validar(z.uuid(), id));
  }

  @Permissao('terminais.ver')
  @Get(':id/eventos-erro')
  eventosComErro(
    @Param('id') id: string,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<ListagemEventosComErro> {
    return this.s.terminais.eventosComErro(
      sessao,
      validar(z.uuid(), id),
      validar(filtroEventosComErroSchema, query),
    );
  }

  @Permissao('terminais.gerenciar')
  @Patch(':id')
  renomear(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TerminalDetalhe> {
    return this.s.terminais.renomear(
      sessao,
      validar(z.uuid(), id),
      validar(alterarTerminalSchema, corpo),
      origemDaRequisicao(req),
    );
  }

  @Permissao('terminais.revogar')
  @Post(':id/revogar')
  @HttpCode(200)
  revogar(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ) {
    return this.s.terminais.revogar(
      sessao,
      validar(z.uuid(), id),
      validar(revogarTerminalSchema, corpo),
      origemDaRequisicao(req),
    );
  }

  @Permissao('terminais.gerenciar')
  @Post(':id/ressincronizar')
  @HttpCode(201)
  ressincronizar(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ) {
    return this.s.terminais.ressincronizar(
      sessao,
      validar(z.uuid(), id),
      validar(ressincronizarTerminalSchema, corpo ?? {}),
      origemDaRequisicao(req),
    );
  }

  @Permissao('terminais.gerenciar')
  @Post(':id/mensagem')
  @HttpCode(201)
  mensagem(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ) {
    return this.s.terminais.mensagem(
      sessao,
      validar(z.uuid(), id),
      validar(mensagemTerminalSchema, corpo),
      origemDaRequisicao(req),
    );
  }

  /** O alerta de token anterior reutilizado (SYNC 3.7) e o "Ciente" do `EVENTO_DESCARTADO` (11.4); os outros fecham sozinhos. */
  @Permissao('terminais.gerenciar')
  @Post(':id/alertas/:alertaId/resolver')
  @HttpCode(200)
  resolverAlerta(
    @Param('id') id: string,
    @Param('alertaId') alertaId: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TerminalDetalhe> {
    return this.s.terminais.resolverAlerta(
      sessao,
      validar(z.uuid(), id),
      validar(z.uuid(), alertaId),
      validar(resolverAlertaTerminalSchema, corpo),
      origemDaRequisicao(req),
    );
  }

  /** Corpo `{ idHardwarePendente }`: o id que a tela mostrou (409 se outra máquina chamou depois). */
  @Permissao('terminais.gerenciar')
  @Post(':id/hardware/confirmar')
  @HttpCode(200)
  confirmarHardware(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<TerminalDetalhe> {
    return this.s.terminais.confirmarHardware(
      sessao,
      validar(z.uuid(), id),
      validar(confirmarHardwareSchema, corpo ?? {}),
      origemDaRequisicao(req),
    );
  }
}
