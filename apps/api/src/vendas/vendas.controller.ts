import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  CANAIS_POR_TIPO_VENDA,
  dec,
  decTexto,
  filtroVendasSchema,
  limiteDeslocamento,
  tipoExibidoVenda,
  type PaginaVendas,
  type VendaDetalhe,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { contem, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { Sessao } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';
import { condicoesLoja, intervaloDia, iso, lojaVisivel, texto } from './consultas.js';

const colunasOrdenacao: Record<string, SQL> = {
  cliente: sql`lower(fn_unaccent(coalesce(p.nome, v.nome_nota, v.cpf_cnpj_nota, '')))`,
  codigo: sql`v.numero_exibicao`,
  data: sql`coalesce(v.finalizada_em, v.iniciada_em)`,
  tipo: sql`v.canal`,
  situacao: sql`v.status`,
  total_bruto: sql`v.subtotal_bruto`,
  total: sql`v.total`,
  loja: sql`l.codigo * 1000 + v.numero_caixa`,
};

const verLucro = (s: SessaoErp) => s.permissoes.has('vendas.ver_lucro');
const lista = (valores: readonly string[]) =>
  sql.join(
    valores.map((v) => sql`${v}`),
    sql`, `,
  );

/**
 * Vendas (ERP 15.4), só leitura das vendas do PDV (Fase 1C, bloco C12): listagem com os filtros pelo dia operacional
 * (D7), loja (sem a loja de treino por padrão, O10), caixa, tipo, situação, devolução, operador, forma de pagamento e
 * sessão de caixa, e os totalizadores; detalhe com Dados gerais, itens, pagamentos e o lucro (`vendas.ver_lucro`). A
 * venda ERP, cancelar pela nuvem e a devolução são da Fase 3; o documento fiscal, da 1D.
 */
@Controller('vendas')
export class VendasController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('vendas.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<PaginaVendas> {
    const q = validar(filtroVendasSchema, query);
    const ordem = ordemDaQuery(q, colunasOrdenacao, 'data:desc', sql`v.id`);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const c: SQL[] = [sql`v.status <> 'rascunho'`, ...condicoesLoja(sessao, q)];
    c.push(...intervaloDia(sql`v.dia_operacional`, q.dataInicial, q.dataFinal));
    const codigo = q.codigo?.trim();
    if (codigo) {
      c.push(
        /^\d{1,12}$/.test(codigo)
          ? sql`v.numero = ${Number(codigo)}`
          : sql`upper(v.numero_exibicao) = ${codigo.toUpperCase()}`,
      );
    }
    if (q.clienteId) c.push(sql`v.cliente_id = ${q.clienteId}`);
    const termo = contem(q.cliente);
    if (termo) {
      const digitos = q.cliente!.replace(/\D/g, '');
      c.push(sql`(p.busca like lower(fn_unaccent(${termo})) or lower(fn_unaccent(coalesce(v.nome_nota, ''))) like lower(fn_unaccent(${termo}))
        ${digitos.length >= 11 ? sql`or v.cpf_cnpj_nota = ${digitos}` : sql``})`);
    }
    if (q.numeroCaixa !== undefined) c.push(sql`v.numero_caixa = ${q.numeroCaixa}`);
    if (q.tipo) c.push(sql`v.canal in (${lista(CANAIS_POR_TIPO_VENDA[q.tipo])})`);
    if (q.situacao !== 'todas') c.push(sql`v.status = ${q.situacao}`);
    if (q.devolucao !== 'todas') c.push(sql`v.devolucao = ${q.devolucao}`);
    if (q.operadorId) c.push(sql`v.operador_id = ${q.operadorId}`);
    if (q.sessaoCaixaId) c.push(sql`v.sessao_caixa_id = ${q.sessaoCaixaId}`);
    if (q.formaPagamentoId)
      c.push(
        sql`exists (select 1 from pagamentos_venda pg where pg.venda_id = v.id and pg.forma_pagamento_id = ${q.formaPagamentoId})`,
      );
    const onde = sql.join(c, sql` and `);
    const de = sql`from vendas v join lojas l on l.id = v.loja_id left join pessoas p on p.id = v.cliente_id`;
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select v.id, v.numero, v.numero_exibicao, v.cliente_id,
               coalesce(p.nome, v.nome_nota, v.cpf_cnpj_nota) as cliente_nome, v.dia_operacional::text as dia,
               v.finalizada_em, v.canal, v.status, v.devolucao, v.status_fiscal, v.subtotal_bruto::text as bruto,
               (v.desconto_itens + v.desconto_total)::text as descontos, v.total::text as total,
               l.id as loja_id, l.codigo as loja_codigo, l.nome as loja_nome, l.treino, v.numero_caixa,
               u.nome as operador_nome
          ${de} left join usuarios u on u.id = v.operador_id
         where ${onde}
         order by ${sql.join(ordem, sql`, `)}
         limit ${limite} offset ${deslocamento}`);
      // Os valores somam só as não canceladas (o total líquido do Dashboard e da ERP 15.4.1 abate o cancelamento).
      const { rows: tot } = await db.execute<Record<string, unknown>>(sql`
        select count(*)::int as n, count(*) filter (where v.status = 'cancelada')::int as canceladas,
               coalesce(sum(v.subtotal_bruto) filter (where v.status <> 'cancelada'), 0)::numeric(15, 2)::text as bruto,
               coalesce(sum(v.desconto_itens + v.desconto_total) filter (where v.status <> 'cancelada'), 0)::numeric(15, 2)::text as descontos,
               coalesce(sum(v.total) filter (where v.status <> 'cancelada'), 0)::numeric(15, 2)::text as liquido
          ${de} where ${onde}`);
      const t = tot[0]!;
      return {
        itens: rows.map((r) => ({
          id: r.id as string,
          numero: Number(r.numero),
          numeroExibicao: r.numero_exibicao as string,
          clienteId: texto(r.cliente_id),
          clienteNome: texto(r.cliente_nome),
          diaOperacional: texto(r.dia),
          finalizadaEm: iso(r.finalizada_em),
          tipo: tipoExibidoVenda(r.canal as string),
          canal: r.canal as string,
          status: r.status as string,
          devolucao: r.devolucao as string,
          statusFiscal: r.status_fiscal as string,
          subtotalBruto: r.bruto as string,
          descontos: r.descontos as string,
          total: r.total as string,
          lojaId: r.loja_id as string,
          lojaCodigo: r.loja_codigo as number,
          lojaNome: r.loja_nome as string,
          lojaTreino: r.treino as boolean,
          numeroCaixa: r.numero_caixa as number,
          operadorNome: texto(r.operador_nome),
        })),
        total: t.n as number,
        pagina: q.pagina,
        tamanho: q.tamanho,
        totais: {
          quantidade: t.n as number,
          canceladas: t.canceladas as number,
          totalBruto: t.bruto as string,
          descontos: t.descontos as string,
          totalLiquido: t.liquido as string,
        },
      };
    });
  }

  @Permissao('vendas.ver')
  @Get(':id')
  async detalhar(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<VendaDetalhe> {
    const vendaId = validar(z.uuid(), id);
    const visivel = lojaVisivel(sessao);
    const lucro = verLucro(sessao);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select v.*, v.dia_operacional::text as dia, l.codigo as loja_codigo, l.nome as loja_nome, l.treino,
               t.descricao as terminal_descricao, u.nome as operador_nome, coalesce(p.nome, v.nome_nota) as cliente_nome,
               uc.nome as cancelada_por_nome, ua.nome as cancelamento_autorizado_por_nome,
               v.subtotal_bruto::text as subtotal_bruto, v.desconto_itens::text as desconto_itens,
               v.desconto_total::text as desconto_total, v.acrescimo_total::text as acrescimo_total,
               v.total::text as total, v.troco::text as troco, v.custo_total::text as custo_total
          from vendas v join lojas l on l.id = v.loja_id
          left join terminais t on t.id = v.terminal_id
          left join usuarios u on u.id = v.operador_id
          left join pessoas p on p.id = v.cliente_id
          left join usuarios uc on uc.id = v.cancelada_por_id
          left join usuarios ua on ua.id = v.cancelamento_autorizado_por_id
         where v.id = ${vendaId} and v.status <> 'rascunho' ${visivel ? sql`and ${visivel}` : sql``}`);
      const v = rows[0];
      if (!v) throw ErroApi.naoEncontrado('Venda não encontrada.');
      const [{ rows: itens }, { rows: pagamentos }] = await Promise.all([
        db.execute<Record<string, unknown>>(sql`
          select i.id, i.sequencia, i.produto_id, pr.codigo as produto_codigo, i.descricao, i.codigo_lido, i.unidade,
                 i.quantidade::text as quantidade, i.preco_tabela::text as preco_tabela,
                 i.preco_unitario::text as preco_unitario, i.origem_preco, i.valor_bruto::text as valor_bruto,
                 (i.desconto_item + i.desconto_promocao)::text as desconto_item,
                 i.desconto_rateado::text as desconto_rateado, i.valor_liquido::text as valor_liquido, i.kit_descricao,
                 i.vasilhame_item_origem_id, i.lote, i.cancelado, i.cancelado_em, uc.nome as cancelado_por_nome,
                 i.motivo_cancelamento, i.custo_unitario::text as custo_unitario
            from itens_venda i left join produtos pr on pr.id = i.produto_id
            left join usuarios uc on uc.id = i.cancelado_por_id
           where i.venda_id = ${vendaId} order by i.sequencia`),
        db.execute<Record<string, unknown>>(sql`
          select pg.id, pg.sequencia, pg.forma_pagamento_id, pg.descricao_forma, pg.tipo_forma, pg.valor::text as valor,
                 pg.valor_recebido::text as valor_recebido, pg.troco::text as troco, pg.parcelas, pg.status,
                 pg.bandeira_nome, pg.nsu, pg.autorizacao, ua.nome as autorizado_por_nome
            from pagamentos_venda pg left join usuarios ua on ua.id = pg.autorizado_por_id
           where pg.venda_id = ${vendaId} order by pg.sequencia`),
      ]);
      const total = dec(v.total as string);
      return {
        id: v.id as string,
        numero: Number(v.numero),
        numeroExibicao: v.numero_exibicao as string,
        tipo: tipoExibidoVenda(v.canal as string),
        canal: v.canal as string,
        modo: v.modo as string,
        status: v.status as string,
        statusFiscal: v.status_fiscal as string,
        devolucao: v.devolucao as string,
        diaOperacional: texto(v.dia),
        iniciadaEm: iso(v.iniciada_em)!,
        finalizadaEm: iso(v.finalizada_em),
        lojaId: v.loja_id as string,
        lojaCodigo: v.loja_codigo as number,
        lojaNome: v.loja_nome as string,
        lojaTreino: v.treino as boolean,
        numeroCaixa: v.numero_caixa as number,
        terminalId: texto(v.terminal_id),
        terminalDescricao: texto(v.terminal_descricao),
        sessaoCaixaId: texto(v.sessao_caixa_id),
        operadorId: v.operador_id as string,
        operadorNome: texto(v.operador_nome),
        clienteId: texto(v.cliente_id),
        clienteNome: texto(v.cliente_nome),
        cpfCnpjNota: texto(v.cpf_cnpj_nota),
        nomeNota: texto(v.nome_nota),
        tipoPreco: v.tipo_preco as string,
        qtdItens: v.qtd_itens as number,
        subtotalBruto: v.subtotal_bruto as string,
        descontoItens: v.desconto_itens as string,
        descontoTotal: v.desconto_total as string,
        descontoTotalOrigem: texto(v.desconto_total_origem),
        acrescimoTotal: v.acrescimo_total as string,
        total: v.total as string,
        troco: v.troco as string,
        observacao: texto(v.observacao),
        relogioConfiavel: v.relogio_confiavel as boolean,
        canceladaEm: iso(v.cancelada_em),
        canceladaPorNome: texto(v.cancelada_por_nome),
        cancelamentoAutorizadoPorNome: texto(v.cancelamento_autorizado_por_nome),
        motivoCancelamento: texto(v.motivo_cancelamento),
        cancelamentoOrigem: texto(v.cancelamento_origem),
        itens: itens.map((i) => ({
          id: i.id as string,
          sequencia: i.sequencia as number,
          produtoId: i.produto_id as string,
          produtoCodigo: (i.produto_codigo as number | null) ?? null,
          descricao: i.descricao as string,
          codigoLido: texto(i.codigo_lido),
          unidade: i.unidade as string,
          quantidade: i.quantidade as string,
          precoTabela: i.preco_tabela as string,
          precoUnitario: i.preco_unitario as string,
          origemPreco: i.origem_preco as string,
          valorBruto: i.valor_bruto as string,
          descontoItem: i.desconto_item as string,
          descontoRateado: i.desconto_rateado as string,
          valorLiquido: i.valor_liquido as string,
          kitDescricao: texto(i.kit_descricao),
          vasilhameItemOrigemId: texto(i.vasilhame_item_origem_id),
          lote: texto(i.lote),
          cancelado: i.cancelado as boolean,
          canceladoEm: iso(i.cancelado_em),
          canceladoPorNome: texto(i.cancelado_por_nome),
          motivoCancelamento: texto(i.motivo_cancelamento),
          custoUnitario: lucro ? texto(i.custo_unitario) : null,
        })),
        pagamentos: pagamentos.map((pg) => ({
          id: pg.id as string,
          sequencia: pg.sequencia as number,
          formaPagamentoId: pg.forma_pagamento_id as string,
          descricaoForma: pg.descricao_forma as string,
          tipoForma: pg.tipo_forma as string,
          valor: pg.valor as string,
          valorRecebido: texto(pg.valor_recebido),
          troco: pg.troco as string,
          parcelas: pg.parcelas as number,
          status: pg.status as string,
          bandeiraNome: texto(pg.bandeira_nome),
          nsu: texto(pg.nsu),
          autorizacao: texto(pg.autorizacao),
          autorizadoPorNome: texto(pg.autorizado_por_nome),
        })),
        // Custo gravado pela nuvem na aplicação (`custo_total`, C6b); sem ele (venda sem custo), sem lucro.
        lucro:
          lucro && v.custo_total !== null
            ? {
                custo: v.custo_total as string,
                lucro: decTexto(total.minus(dec(v.custo_total as string)), 2),
                margemPct: total.gt(0)
                  ? decTexto(
                      total
                        .minus(dec(v.custo_total as string))
                        .div(total)
                        .times(100),
                      2,
                    )
                  : null,
              }
            : null,
      };
    });
  }
}
