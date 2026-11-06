import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
import {
  alterarRecebimentoSchema,
  consultaDadosCompraSchema,
  criarRecebimentoSchema,
  type DadosCompraProdutos,
  estornarRecebimentoSchema,
  excluirRecebimentoSchema,
  filtroRecebimentosSchema,
  limiteDeslocamento,
  movimentarRecebimentoSchema,
  type Pagina,
  type RecebimentoDetalhe,
  type RecebimentoResumo,
  type StatusRecebimento,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { conflitoVersao, escaparLike, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { recebimentos } from '../database/empresa/schema/index.js';
import { lojaDoEstoque } from '../estoques/acertos.js';
import { estoqueVisivel } from '../estoques/permitidos.js';
import { textoSaldosNegativos } from './entrada.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import {
  conferirCabecalhoRecebimento,
  dadosCompraProdutos,
  detalheRecebimento,
  estornarRecebimento,
  gravarItensRecebimento,
  lerRecebimentoAMovimentar,
  movimentarRecebimento,
  resumoMovimentacao,
  sqlVersaoRecebimento,
} from './recebimentos.js';

const LOCALIZACAO = 'Estoque › Recebimentos';

const colunasOrdenacao = {
  codigo: sql`r.codigo`,
  data: sql`r.data_recebimento`,
  fornecedor: sql`lower(f.nome)`,
  remessa: sql`lower(r.codigo_remessa)`,
  estoque: sql`lower(e.nome)`,
  loja: sql`lower(l.nome)`,
  total: sql`r.valor_total`,
  status: sql`r.status`,
};

interface LinhaRecebimento {
  id: string;
  versao: number;
  status: StatusRecebimento;
  lojaId: string;
  fornecedorId: string;
  atualizadoPorId: string | null;
  atualizadoEm: Date;
}

/**
 * Recebimento manual de mercadoria (ERP 13.3; MD 3.8.1; Fase 2, F2-B14; README da API › decisão 159): listagem,
 * detalhe e o rascunho (criar, alterar, excluir). Só se vê o recebimento de estoque permitido (fora dele é 404, como
 * inexistente); gravar exige a loja e o estoque permitidos (403 no campo), e alterar ou excluir exige também a loja
 * **já gravada** entre as permitidas (403): o rascunho de outra loja num estoque compartilhado (o CD) se vê, mas não
 * se descarta nem se toma trocando a loja. Movimentar e estornar (F2-B15; README da API › decisão 160) seguem a
 * mesma regra de acesso e rodam com `travaVersao`: o movimento, o saldo, o lote e os preços descem ao PDV. A tela
 * (F2-B16) lê os dados de compra dos produtos da grade em `GET /recebimentos/dados-produtos` (decisão 161).
 */
@Controller('recebimentos')
export class RecebimentosController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('recebimentos.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Pagina<RecebimentoResumo>> {
    const q = validar(filtroRecebimentosSchema, query);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const condicoes: SQL[] = [sql`r.excluido_em is null`];
    const visivel = estoqueVisivel(sessao, sql`r.estoque_id`);
    if (visivel) condicoes.push(visivel);
    if (q.fornecedorId) condicoes.push(sql`r.fornecedor_id = ${q.fornecedorId}`);
    if (q.codigo) condicoes.push(sql`r.codigo = ${q.codigo}`);
    if (q.codigoRemessa) condicoes.push(sql`r.codigo_remessa ilike ${`%${escaparLike(q.codigoRemessa)}%`}`);
    if (q.estoqueId) condicoes.push(sql`r.estoque_id = ${q.estoqueId}`);
    if (q.lojaId) condicoes.push(sql`r.loja_id = ${q.lojaId}`);
    if (q.dataInicial) condicoes.push(sql`r.data_recebimento >= ${q.dataInicial}::date`);
    if (q.dataFinal) condicoes.push(sql`r.data_recebimento <= ${q.dataFinal}::date`);
    if (q.status) condicoes.push(sql`r.status = ${q.status}`);
    const onde = sql.join(condicoes, sql` and `);
    const ordem = ordemDaQuery(q, colunasOrdenacao, 'data:desc', sql`r.codigo`);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select r.id, r.codigo, r.fornecedor_id, f.nome as fornecedor_nome, r.data_recebimento::text as data,
               r.codigo_remessa, r.loja_id, l.nome as loja_nome, r.estoque_id, e.nome as estoque_nome,
               r.qtd_itens, r.valor_total::text, r.status, ${sqlVersaoRecebimento} as versao
          from recebimentos r
          join pessoas f on f.id = r.fornecedor_id
          join lojas l on l.id = r.loja_id
          join estoques e on e.id = r.estoque_id
         where ${onde}
         order by ${sql.join(ordem, sql`, `)}
         limit ${limite} offset ${deslocamento}`);
      const { rows: total } = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from recebimentos r where ${onde}`);
      return {
        itens: rows.map((r) => ({
          id: r.id as string,
          codigo: r.codigo as number,
          fornecedorId: r.fornecedor_id as string,
          fornecedorNome: r.fornecedor_nome as string,
          dataRecebimento: r.data as string,
          codigoRemessa: (r.codigo_remessa as string | null) ?? null,
          lojaId: r.loja_id as string,
          lojaNome: r.loja_nome as string,
          estoqueId: r.estoque_id as string,
          estoqueNome: r.estoque_nome as string,
          qtdItens: r.qtd_itens as number,
          valorTotal: r.valor_total as string,
          status: r.status as StatusRecebimento,
          versao: Number(r.versao),
        })),
        total: total[0]?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
      };
    });
  }

  /**
   * Dados de compra dos produtos da grade (F2-B16; README da API › decisão 161): embalagens de compra, lote, saldo e
   * custo médio no estoque de destino e a base do markup (D49). Antes de `:id` (o Nest casa as rotas em ordem).
   */
  @Permissao('recebimentos.ver')
  @Get('dados-produtos')
  async dadosProdutos(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<DadosCompraProdutos> {
    const q = validar(consultaDadosCompraSchema, query);
    return this.s.tenancy.cx().consulta((db) => dadosCompraProdutos(db, q, sessao));
  }

  @Permissao('recebimentos.ver')
  @Get(':id')
  async obter(@Param('id') idBruto: string, @Sessao() sessao: SessaoErp): Promise<RecebimentoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const d = await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao));
    if (!d) throw ErroApi.naoEncontrado('Recebimento não encontrado.');
    return d;
  }

  /** Cria o rascunho; a resposta traz o aviso de remessa repetida, se houver (não impede salvar). */
  @Permissao('recebimentos.criar')
  @Post()
  @HttpCode(201)
  async criar(
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RecebimentoDetalhe> {
    const dados = validar(criarRecebimentoSchema, corpo);
    const id = await this.s.tenancy.cx().transacao(async (tx) => {
      const cab = await conferirCabecalhoRecebimento(tx, dados, sessao);
      const id = uuidv7();
      await tx.insert(recebimentos).values({
        id,
        lojaId: cab.lojaId,
        estoqueId: cab.estoqueId,
        tipoEstoqueId: cab.tipoEstoqueId,
        fornecedorId: cab.fornecedorId,
        dataRecebimento: cab.dataRecebimento,
        codigoRemessa: dados.codigoRemessa,
        temValidade: dados.temValidade,
        valorFrete: dados.valorFrete,
        valorDesconto: dados.valorDesconto,
        valorOutrasDespesas: dados.valorOutrasDespesas,
        observacoes: dados.observacoes,
        criadoPorId: sessao.usuarioId,
        atualizadoPorId: sessao.usuarioId,
      });
      await gravarItensRecebimento(tx, { id }, dados);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'criar',
        entidade: 'recebimentos',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: cab.lojaId,
        depois: { ...dados, ...cab },
      });
      return id;
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /** Altera o rascunho inteiro (cabeçalho e itens) conferindo a versão do documento (409 se outro mexeu). */
  @Permissao('recebimentos.editar')
  @Put(':id')
  async alterar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RecebimentoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, ...dados } = validar(alterarRecebimentoSchema, corpo);
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, versao);
      exigirLojaGravada(sessao, antes);
      exigirRascunho(antes);
      const cab = await conferirCabecalhoRecebimento(tx, dados, sessao, antes.fornecedorId);
      await tx.execute(sql`
        update recebimentos
           set loja_id = ${cab.lojaId}, estoque_id = ${cab.estoqueId}, tipo_estoque_id = ${cab.tipoEstoqueId},
               fornecedor_id = ${cab.fornecedorId}, data_recebimento = ${cab.dataRecebimento}::date,
               codigo_remessa = ${dados.codigoRemessa}, tem_validade = ${dados.temValidade},
               valor_frete = ${dados.valorFrete}::numeric, valor_desconto = ${dados.valorDesconto}::numeric,
               valor_outras_despesas = ${dados.valorOutrasDespesas}::numeric, observacoes = ${dados.observacoes},
               atualizado_por_id = ${sessao.usuarioId}
         where id = ${id}`);
      await gravarItensRecebimento(tx, { id }, dados);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'editar',
        entidade: 'recebimentos',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: cab.lojaId,
        antes,
        depois: { ...dados, ...cab },
      });
    });
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Só o rascunho é excluído (logicamente, com os itens); o movimentado só é estornado (F2-B15). `?versao=` confere a
   * versão do documento, quando informada.
   */
  @Permissao('recebimentos.editar')
  @Delete(':id')
  @HttpCode(204)
  async excluir(
    @Param('id') idBruto: string,
    @Query() query: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<void> {
    const id = validar(z.uuid(), idBruto);
    const { versao } = validar(excluirRecebimentoSchema, query ?? {});
    await this.s.tenancy.cx().transacao(async (tx) => {
      const antes = await this.travar(tx, id, sessao, versao);
      exigirLojaGravada(sessao, antes);
      exigirRascunho(antes);
      await tx.execute(sql`
        update itens_recebimento set excluido_em = now() where recebimento_id = ${id} and excluido_em is null`);
      await tx.execute(sql`
        update recebimentos set excluido_em = now(), atualizado_por_id = ${sessao.usuarioId} where id = ${id}`);
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'excluir',
        entidade: 'recebimentos',
        registroId: id,
        localizacao: LOCALIZACAO,
        lojaId: antes.lojaId,
        antes,
      });
    });
  }

  /**
   * "Salvar e movimentar" (ERP 13.3): lança o `RECEB_MANUAL` de cada item pelo núcleo de entrada. **Idempotente**: o
   * recebimento já movimentado devolve o detalhe sem lançar nada nem conferir a versão (o clique repetido, ou a
   * resposta perdida, não vira 409 nem entrada dobrada; a trava do cabeçalho serializa duas chamadas juntas). O
   * estornado é 422. A pergunta do preço de custo (D49) volta como 422 em `atualizarPrecoCusto`.
   */
  @Permissao('recebimentos.movimentar')
  @Post(':id/movimentar')
  @HttpCode(200)
  async movimentar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RecebimentoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, atualizarPrecoCusto } = validar(movimentarRecebimentoSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, id, sessao);
        exigirLojaGravada(sessao, antes);
        if (antes.status === 'movimentado') return;
        if (antes.status === 'estornado')
          throw new ErroApi('REGRA_NEGOCIO', 'Recebimento estornado não pode ser movimentado de novo.');
        if (versao !== undefined && antes.versao !== versao) await conflitoVersao(tx, antes);
        const r = await lerRecebimentoAMovimentar(tx, id);
        const resultado = await movimentarRecebimento(tx, r, sessao, { atualizarPrecoCusto });
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'movimentar',
          entidade: 'recebimentos',
          registroId: id,
          localizacao: LOCALIZACAO,
          lojaId: r.lojaId,
          descricao: `Recebimento Nº ${r.codigo} movimentado: ${resumoMovimentacao(resultado)}`,
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  /**
   * Estorno com motivo (ERP 13.3): `ESTORNO_RECEB_MANUAL` de cada item, bloqueado se deixar saldo negativo (a
   * mercadoria já vendida), salvo Master ou `estoque.permite_negativo_erp` da loja do estoque, como no acerto; com a
   * permissão, o negativo pede `confirmarNegativo` (422 com a lista em `detalhes.saldosNegativos`) e o confirmado vai
   * para a auditoria (D56 com aviso; README da API › decisão 165). Não desfaz preço nem preço de custo.
   */
  @Permissao('recebimentos.estornar')
  @Post(':id/estornar')
  @HttpCode(200)
  async estornar(
    @Param('id') idBruto: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RecebimentoDetalhe> {
    const id = validar(z.uuid(), idBruto);
    const { versao, motivo, confirmarNegativo } = validar(estornarRecebimentoSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(
      async (tx) => {
        const antes = await this.travar(tx, id, sessao, versao);
        exigirLojaGravada(sessao, antes);
        if (antes.status !== 'movimentado')
          throw new ErroApi(
            'REGRA_NEGOCIO',
            antes.status === 'estornado'
              ? 'O recebimento já foi estornado.'
              : 'Só um recebimento movimentado pode ser estornado (o rascunho se exclui).',
          );
        const r = await lerRecebimentoAMovimentar(tx, id);
        const lojaEstoque = await lojaDoEstoque(tx, r.estoqueId);
        const permiteNegativo =
          sessao.master || (await lerConfiguracao<boolean>(tx, 'estoque.permite_negativo_erp', lojaEstoque));
        const resultado = await estornarRecebimento(tx, r, {
          usuarioId: sessao.usuarioId,
          permiteNegativo,
          confirmarNegativo,
          motivo,
        });
        // O negativo confirmado fica registrado (D56 com aviso): quem, os saldos e que foi confirmado.
        const negativo = resultado.saldosNegativos.length
          ? `; saldo negativo confirmado em: ${textoSaldosNegativos(resultado.saldosNegativos)}`
          : '';
        await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
          acao: 'estornar',
          entidade: 'recebimentos',
          registroId: id,
          localizacao: LOCALIZACAO,
          lojaId: r.lojaId,
          descricao: `Recebimento Nº ${r.codigo} estornado (${resultado.estornos} movimento(s)): ${motivo}${negativo}`,
          ...(resultado.saldosNegativos.length
            ? { depois: { saldoNegativoConfirmado: true, saldosNegativos: resultado.saldosNegativos } }
            : {}),
        });
      },
      { travaVersao: true },
    );
    return (await this.s.tenancy.cx().consulta((db) => this.detalhe(db, id, sessao)))!;
  }

  private detalhe(db: DbEmpresa, id: string, sessao: SessaoErp): Promise<RecebimentoDetalhe | null> {
    return detalheRecebimento(db, id, sessao, estoqueVisivel(sessao, sql`r.estoque_id`));
  }

  /**
   * Lê com `for update` (estoque permitido para movimentar: fora dele o recebimento é 404, como inexistente) e confere
   * a versão agregada do documento, quando informada. A versão sai de uma **segunda instrução**, depois da trava: em
   * READ COMMITTED, quem esperou a trava de outra transação relê só a linha travada (EPQ), e a subconsulta dos itens
   * dentro da mesma instrução ficaria no instantâneo de antes da espera — sem ver os itens que a outra gravou, a versão
   * velha passaria sem o 409 (o cabeçalho nem sempre ganha versão: `fn_versao_local` a mantém quando só os itens
   * mudam). A instrução nova tira instantâneo novo e enxerga o commit de quem tinha a trava.
   */
  private async travar(
    tx: DbEmpresa,
    id: string,
    sessao: SessaoErp,
    versao?: number,
  ): Promise<LinhaRecebimento> {
    const visivel = estoqueVisivel(sessao, sql`r.estoque_id`, 'movimentar');
    const { rows } = await tx.execute<Record<string, unknown>>(sql`
      select r.id, r.status, r.loja_id, r.fornecedor_id, r.atualizado_por_id, r.atualizado_em
        from recebimentos r
       where r.id = ${id} and r.excluido_em is null ${visivel ? sql`and ${visivel}` : sql``}
         for update of r`);
    const r = rows[0];
    if (!r) throw ErroApi.naoEncontrado('Recebimento não encontrado.');
    const { rows: v } = await tx.execute<{ versao: string }>(sql`
      select ${sqlVersaoRecebimento}::text as versao from recebimentos r where r.id = ${id}`);
    const linha: LinhaRecebimento = {
      id: r.id as string,
      versao: Number(v[0]!.versao),
      status: r.status as StatusRecebimento,
      lojaId: r.loja_id as string,
      fornecedorId: r.fornecedor_id as string,
      atualizadoPorId: (r.atualizado_por_id as string | null) ?? null,
      atualizadoEm: new Date(r.atualizado_em as string),
    };
    if (versao !== undefined && linha.versao !== versao) await conflitoVersao(tx, linha);
    return linha;
  }
}

/**
 * A loja destinatária **gravada** entre as lojas permitidas (ERP 13.3/2.1): ver é pelo estoque (D45), mas descartar o
 * rascunho ou trocar a loja dele é gravar o documento daquela loja. Sem isto, quem tem o CD e só a Loja 1 excluiria o
 * rascunho da Petiscaria 2 no CD, ou o passaria para a Loja 1, embora o `POST` com a Petiscaria 2 lhe desse 403.
 */
function exigirLojaGravada(sessao: SessaoErp, r: { lojaId: string }): void {
  if (!lojaPermitida(sessao, r.lojaId))
    throw new ErroApi(
      'SEM_PERMISSAO',
      'O recebimento é de uma loja fora das suas lojas permitidas: só quem tem a loja altera ou exclui o rascunho.',
    );
}

function exigirRascunho(r: { status: string }): void {
  if (r.status !== 'rascunho')
    throw new ErroApi(
      'REGRA_NEGOCIO',
      'Recebimento movimentado ou estornado não pode ser alterado (use Estornar).',
    );
}
