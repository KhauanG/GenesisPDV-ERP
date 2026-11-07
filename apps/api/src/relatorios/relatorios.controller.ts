import { Controller, Get, Inject, Param, Query, Req, Res, type StreamableFile } from '@nestjs/common';
import type { ExportacaoEmTarefa } from '@genesis/shared';
import type { Response } from 'express';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { origemDaRequisicao, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import type { Servicos } from '../servicos.js';

/**
 * Exportação de relatório (ERP 3.5, 3.6; F2-B29, README da API › decisão 177): uma rota para todos os relatórios
 * registrados em `ExportacaoRelatorios` (`chave` do provedor). Até `LIMITE_EXPORTACAO` linhas responde o arquivo
 * (`200`); acima, `202` com a tarefa (`ExportacaoEmTarefa`), que o ERP acompanha no ícone Tarefas. A permissão do
 * relatório é conferida pelo provedor; aqui fica a comum.
 */
@Controller('relatorios')
export class RelatoriosController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('relatorios.exportar')
  @Get(':relatorio/exportar')
  async exportar(
    @Param('relatorio') relatorio: string,
    @Query() query: Record<string, unknown>,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | ExportacaoEmTarefa> {
    const r = await this.s.exportacoes.exportar(sessao, origemDaRequisicao(req), relatorio, query ?? {});
    if (r.tipo === 'arquivo') return r.arquivo;
    res.status(202);
    return r.tarefa;
  }
}
