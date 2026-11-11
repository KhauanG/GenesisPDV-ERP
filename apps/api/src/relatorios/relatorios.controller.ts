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
  consultaEanDuplicadoSchema,
  consultaHistoricoProdutosSchema,
  consultaEstoqueAtualSchema,
  consultaMovimentacaoEstoqueSchema,
  consultaMovimentacaoSinteticaSchema,
  consultaNcmInvalidosSchema,
  consultaProdutosGeralSchema,
  definirNcmLoteSchema,
  detalheHistoricoProdutoSchema,
  type DetalheHistoricoProduto,
  type ExportacaoEmTarefa,
  type RespostaEanDuplicado,
  type RespostaHistoricoProdutos,
  type RespostaNcmInvalidos,
  type RespostaProdutosGeral,
  type ResultadoDefinirNcm,
  type RespostaEstoqueAtual,
  type RespostaMovimentacaoEstoque,
  type RespostaMovimentacaoSintetica,
  type ResultadoAjusteProduto,
} from '@genesis/shared';
import type { Response } from 'express';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { origemDaRequisicao, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { z } from 'zod';
import { ajustarEstoqueDefinir, resumoEfetivacao } from '../estoques/acertos.js';
import type { Servicos } from '../servicos.js';
import { paginaEanDuplicado } from './ean-duplicado.js';
import { LOCALIZACAO_ESTOQUE_ATUAL, paginaEstoqueAtual } from './estoque-atual.js';
import { detalheHistoricoProduto, paginaHistoricoProdutos } from './historico-produtos.js';
import { paginaMovimentacao, paginaMovimentacaoSintetica } from './movimentacao.js';
import { definirNcmEmLote, paginaNcmInvalidos } from './ncm-invalidos.js';
import { paginaProdutosGeral } from './produtos-geral.js';

/**
 * Relatórios (ERP 16): o Estoque Atual com o modal de ajuste (16.4; F2-B31, README da API › decisão 178), a
 * Movimentação de Estoque analítica (16.5; F2-B32, decisão 179) e sintética (F2-B33, decisão 180), o EAN duplicado
 * (MD 3.6.5; F2-B38, decisão 184), o Produtos geral e os NCMs inválidos com o "Definir NCM" em lote (16.1, 16.3;
 * F2-B41, decisão 187), o Histórico de produtos (16.2; F2-B42, decisão 188) e a exportação comum (ERP 3.5, 3.6; F2-B29, decisão 177): uma rota para todos os relatórios registrados em
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

  /**
   * Movimentação de Estoque, visão analítica (ERP 16.5): a página depois do `cursor`, com o `proximoCursor` (sem
   * total). O custo só sai com `produtos.ver_custo`; o local tem de estar entre os estoques permitidos.
   */
  @Permissao('relatorios.movimentacao_estoque')
  @Get('movimentacao-estoque')
  async movimentacaoEstoque(
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<RespostaMovimentacaoEstoque> {
    const q = validar(consultaMovimentacaoEstoqueSchema, query);
    return this.s.tenancy.cx().consulta((db) => paginaMovimentacao(db, sessao, q));
  }

  /**
   * Movimentação de Estoque, visão sintética por produto (ERP 16.5; F2-B33): a página com o total e os totais de
   * custo; saldo inicial e final, entradas, saídas, custos e a última compra até o fim do período. Mesmas regras de
   * acesso da analítica.
   */
  @Permissao('relatorios.movimentacao_estoque')
  @Get('movimentacao-estoque/sintetica')
  async movimentacaoEstoqueSintetica(
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<RespostaMovimentacaoSintetica> {
    const q = validar(consultaMovimentacaoSinteticaSchema, query);
    return this.s.tenancy.cx().consulta((db) => paginaMovimentacaoSintetica(db, sessao, q));
  }

  /**
   * EAN duplicado (MD 3.6.5; F2-B38, decisão 184): os códigos `gtin` em mais de um produto, com os produtos de cada
   * um, a página pelos códigos com o total e o `geral.ean_duplicado` de agora. É `produtos.ver`: o filtro "EAN
   * duplicado" da listagem já mostra os mesmos produtos a quem vê o cadastro.
   */
  @Permissao('produtos.ver')
  @Get('ean-duplicado')
  async eanDuplicado(@Query() query: unknown): Promise<RespostaEanDuplicado> {
    const q = validar(consultaEanDuplicadoSchema, query);
    return this.s.tenancy.cx().consulta((db) => paginaEanDuplicado(db, q));
  }

  /**
   * Produtos geral (ERP 16.1; F2-B41, decisão 187): a página com o total, o custo, a venda (a da loja escolhida), o
   * atacado, o lucro, o lucro %, o markup % e os departamentos, e as médias do relatório inteiro em decimal. Custo,
   * lucro e markup só com `produtos.ver_custo`; a loja tem de estar entre as permitidas.
   */
  @Permissao('relatorios.produtos_geral')
  @Get('produtos-geral')
  async produtosGeral(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<RespostaProdutosGeral> {
    const q = validar(consultaProdutosGeralSchema, query);
    return this.s.tenancy.cx().consulta((db) => paginaProdutosGeral(db, sessao, q));
  }

  /**
   * NCMs inválidos (ERP 16.3; F2-B41, decisão 187): os produtos (sem combo e serviço) com o NCM vazio, inexistente ou
   * fora de vigência e, com a tabela `cests` carregada, o CEST incompatível; a página com o total e a contagem por
   * motivo.
   */
  @Permissao('relatorios.ncm_invalidos')
  @Get('ncm-invalidos')
  async ncmInvalidos(@Query() query: unknown): Promise<RespostaNcmInvalidos> {
    const q = validar(consultaNcmInvalidosSchema, query);
    return this.s.tenancy.cx().consulta((db) => paginaNcmInvalidos(db, q));
  }

  /**
   * "Definir NCM" em lote (ERP 16.3): o NCM para os produtos marcados (até `LIMITE_DEFINIR_NCM`), cada um pelo
   * `atualizarProduto` com a versão do relatório, a auditoria própria e a descida ao PDV, tudo ou nada, com a trava de
   * ordenação (o 503 "sistema ocupado" amigável na espera). Exige ver o relatório e `produtos.editar`.
   */
  @Permissao('relatorios.ncm_invalidos', 'produtos.editar')
  @Post('ncm-invalidos/definir-ncm')
  @HttpCode(200)
  async definirNcm(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<ResultadoDefinirNcm> {
    const dados = validar(definirNcmLoteSchema, corpo);
    return this.s.tenancy
      .cx()
      .transacao((tx) => definirNcmEmLote(this.s, tx, sessao, origemDaRequisicao(req), dados), {
        travaVersao: true,
      });
  }

  /**
   * Histórico de produtos (ERP 16.2; F2-B42, decisão 188): a auditoria do produto e das filhas num período obrigatório
   * (a tabela é particionada por mês), com o texto legível montado para quem consulta (o custo só com
   * `produtos.ver_custo`, o que é de loja só das permitidas), a legenda G/E/R/I e a localização mapeada.
   */
  @Permissao('relatorios.historico_produtos')
  @Get('historico-produtos')
  async historicoProdutos(
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<RespostaHistoricoProdutos> {
    const q = validar(consultaHistoricoProdutosSchema, query);
    return this.s.tenancy.cx().consulta((db) => paginaHistoricoProdutos(db, sessao, q));
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

  /**
   * "Ver diferença completa" de uma linha do Histórico de produtos (F2-B42): todos os campos que mudaram, antes e
   * depois, no mesmo escopo. Depois do `:relatorio/exportar`, para `historico-produtos/exportar` (a exportação deste
   * relatório, pelo provedor comum) não cair aqui.
   */
  @Permissao('relatorios.historico_produtos')
  @Get('historico-produtos/:id')
  async historicoProdutoDetalhe(
    @Param('id') idBruto: string,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
  ): Promise<DetalheHistoricoProduto> {
    const id = validar(z.uuid(), idBruto);
    const { ocorridoEm } = validar(detalheHistoricoProdutoSchema, query);
    return this.s.tenancy.cx().consulta((db) => detalheHistoricoProduto(db, sessao, id, ocorridoEm));
  }
}
