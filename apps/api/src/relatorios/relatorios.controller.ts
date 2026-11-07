import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  type StreamableFile,
} from '@nestjs/common';
import {
  ajusteEstoqueRelatorioSchema,
  consultaEstoqueAtualSchema,
  type ExportacaoEmTarefa,
  type RespostaEstoqueAtual,
  type ResultadoAjusteProduto,
} from '@genesis/shared';
import type { Response } from 'express';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { origemDaRequisicao, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { ajustarEstoqueDefinir, resumoEfetivacao } from '../estoques/acertos.js';
import type { Servicos } from '../servicos.js';
import { LOCALIZACAO_ESTOQUE_ATUAL, paginaEstoqueAtual } from './estoque-atual.js';

/**
 * Relatórios (ERP 16): o Estoque Atual com o modal de ajuste (16.4; F2-B31, README da API › decisão 178) e a
 * exportação comum (ERP 3.5, 3.6; F2-B29, decisão 177): uma rota para todos os relatórios registrados em
 * `ExportacaoRelatorios` (`chave` do provedor). Até `LIMITE_EXPORTACAO` linhas responde o arquivo (`200`); acima,
 * `202` com a tarefa (`ExportacaoEmTarefa`), que o ERP acompanha no ícone Tarefas. A permissão do relatório é
 * conferida pelo provedor; aqui fica a comum.
 */
@Controller('relatorios')
export class RelatoriosController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  /** Estoque Atual (ERP 16.4): a página, com o total e os totais do relatório inteiro. */
  @Permissao('relatorios.estoque_atual')
  @Get('estoque-atual')
  async estoqueAtual(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<RespostaEstoqueAtual> {
    const q = validar(consultaEstoqueAtualSchema, query);
    return this.s.tenancy.cx().consulta((db) => paginaEstoqueAtual(db, sessao, q));
  }

  /**
   * Modal de ajuste do Estoque Atual (ERP 16.4, 13.6): o mesmo núcleo do "Ajustar" do produto
   * (`ajustarEstoqueDefinir`, decisão 157) com a origem `relatorio_estoque` (AJUSTE_RELATORIO): um "Definir" de um
   * item, criado e efetivado na hora, na hora da contagem informada (padrão: agora), com a regra do saldo negativo, a
   * compensação das vendas tardias e o estoque permitido para movimentar. Exige ver o relatório e
   * `estoque_acertos.criar`; a auditoria fica no acerto (criar + efetivar), com a localização do relatório.
   */
  @Permissao('relatorios.estoque_atual', 'estoque_acertos.criar')
  @Post('estoque-atual/ajustar')
  @HttpCode(200)
  async ajustarEstoqueAtual(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoAjusteProduto> {
    const { produtoId, ...dados } = validar(ajusteEstoqueRelatorioSchema, corpo);
    return this.s.tenancy.cx().transacao(
      async (tx) => {
        const { resultado, lojaId } = await ajustarEstoqueDefinir(
          tx,
          sessao,
          produtoId,
          dados,
          'relatorio_estoque',
        );
        const origem = origemDaRequisicao(req);
        await this.s.auditoria.registrar(tx, origem, {
          acao: 'criar',
          entidade: 'acertos_estoque',
          registroId: resultado.acertoId,
          localizacao: LOCALIZACAO_ESTOQUE_ATUAL,
          lojaId,
          descricao: `Ajuste de estoque pelo relatório Estoque Atual (acerto Nº ${resultado.codigo})`,
          depois: { produtoId, ...dados },
        });
        await this.s.auditoria.registrar(tx, origem, {
          acao: 'efetivar',
          entidade: 'acertos_estoque',
          registroId: resultado.acertoId,
          localizacao: LOCALIZACAO_ESTOQUE_ATUAL,
          lojaId,
          descricao: `Acerto efetivado: ${resumoEfetivacao({ ...resultado, itens: 1 })}`,
        });
        return resultado;
      },
      { travaVersao: true },
    );
  }

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
