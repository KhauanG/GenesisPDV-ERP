import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  consultaSaldoItemSchema,
  filtroSaldosSchema,
  limiteDeslocamento,
  ordenacao,
  type LoteSaldoItem,
  type PaginaSaldos,
  type SaldoItem,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { escaparLike } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { Sessao } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';
import { estoqueVisivel } from './permitidos.js';

const verCusto = (s: SessaoErp) => s.permissoes.has('produtos.ver_custo');

const colunasOrdenacao: Record<string, SQL> = {
  produto: sql`lower(fn_unaccent(x.produto_nome))`,
  codigo_interno: sql`lower(x.codigo_interno)`,
  estoque: sql`lower(x.estoque_nome)`,
  quantidade: sql`x.quantidade`,
  custo_medio: sql`x.custo_medio`,
  custo_total: sql`x.quantidade * x.custo_medio`,
  venda_total: sql`x.quantidade * x.preco_venda`,
};

/**
 * Consulta simples de saldos por estoque (ERP 8.2.11; 16.4 sem o ajuste no clique, o "Em trânsito" e a data-base,
 * que chegam com as transferências e o relatório completo da Fase 2) e o saldo dos itens da grade do acerto.
 */
@Controller('saldos-estoque')
export class SaldosEstoqueController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('estoque_saldos.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<PaginaSaldos> {
    const q = validar(filtroSaldosSchema, query);
    const ord = ordenacao(q) ?? { campo: 'produto', direcao: 'asc' as const };
    const coluna = colunasOrdenacao[ord.campo];
    if (!coluna)
      throw new ErroApi('VALIDACAO', 'Ordenação inválida.', {
        campos: { ordenar: [`Use um de: ${Object.keys(colunasOrdenacao).join(', ')}`] },
      });
    if (['custo_medio', 'custo_total'].includes(ord.campo) && !verCusto(sessao))
      throw ErroApi.semPermissao('Ordenar por custo exige "Ver custo".');
    const { limite, deslocamento } = limiteDeslocamento(q);
    const condicoes: SQL[] = [
      sql`e.excluido_em is null`,
      sql`p.excluido_em is null`,
      sql`p.tipo not in ('kit','servico')`,
    ];
    const visivel = estoqueVisivel(sessao, sql`e.id`);
    if (visivel) condicoes.push(visivel);
    if (q.estoqueId) condicoes.push(sql`e.id = ${q.estoqueId}`);
    if (q.situacao === 'ativos') condicoes.push(sql`p.ativo`);
    if (q.situacao === 'inativos') condicoes.push(sql`not p.ativo`);
    const nome = q.nome?.trim();
    if (nome)
      condicoes.push(sql`(p.busca like lower(fn_unaccent(${`%${escaparLike(nome)}%`})) or lower(p.codigo_interno) = lower(${nome})
        or exists (select 1 from produtos_codigos_barras cb where cb.produto_id = p.id and cb.excluido_em is null and cb.codigo = ${nome}))`);
    // Com "sem movimento", cada produto que controla estoque aparece em cada estoque escolhido mesmo sem linha de saldo.
    const origem = q.incluirSemMovimento
      ? sql`estoques e cross join produtos p
            left join saldos_estoque s on s.estoque_id = e.id and s.produto_id = p.id and s.variacao_id is null
                                       ${q.tipoEstoqueId ? sql`and s.tipo_estoque_id = ${q.tipoEstoqueId}` : sql``}`
      : sql`saldos_estoque s join estoques e on e.id = s.estoque_id join produtos p on p.id = s.produto_id`;
    if (q.incluirSemMovimento) condicoes.push(sql`p.controla_estoque`);
    else if (q.tipoEstoqueId) condicoes.push(sql`s.tipo_estoque_id = ${q.tipoEstoqueId}`);
    const onde = sql.join(condicoes, sql` and `);
    const situacaoSaldo =
      q.situacaoSaldo === 'positivo'
        ? sql`x.quantidade > 0`
        : q.situacaoSaldo === 'zerado'
          ? sql`x.quantidade = 0`
          : q.situacaoSaldo === 'negativo'
            ? sql`x.quantidade < 0`
            : q.situacaoSaldo === 'abaixo_minimo'
              ? sql`x.estoque_minimo is not null and x.quantidade < x.estoque_minimo`
              : sql`true`;
    const base = sql`
      with x as (
        select e.id as estoque_id, e.nome as estoque_nome, s.tipo_estoque_id, t.nome as tipo_estoque_nome,
               p.id as produto_id, p.codigo as produto_codigo, p.nome as produto_nome, p.codigo_interno, u.sigla,
               coalesce(s.quantidade, 0) as quantidade, coalesce(s.custo_medio, 0) as custo_medio,
               coalesce(pl.preco_venda, p.preco_venda) as preco_venda, pl.estoque_minimo,
               s.ultima_entrada_em, s.ultima_saida_em
          from ${origem}
          join unidades_medida u on u.id = p.unidade_id
          left join tipos_estoque t on t.id = s.tipo_estoque_id
          left join lateral (select l.id from lojas l where l.estoque_id = e.id and l.excluido_em is null
                              order by l.codigo limit 1) lj on true
          left join produtos_lojas pl on pl.produto_id = p.id and pl.loja_id = lj.id and pl.excluido_em is null
         where ${onde})`;
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        ${base}
        select x.*, x.quantidade::text as qtd, x.custo_medio::text as cm, x.preco_venda::text as pv,
               x.estoque_minimo::text as minimo,
               round(x.quantidade * x.custo_medio, 2)::text as custo_total,
               round(x.quantidade * x.preco_venda, 2)::text as venda_total
          from x where ${situacaoSaldo}
         order by ${coluna} ${sql.raw(ord.direcao)}, x.produto_codigo, x.estoque_nome, x.tipo_estoque_nome
         limit ${limite} offset ${deslocamento}`);
      const { rows: tot } = await db.execute<{ n: number; custo: string | null; venda: string | null }>(sql`
        ${base}
        select count(*)::int as n, round(sum(x.quantidade * x.custo_medio), 2)::text as custo,
               round(sum(x.quantidade * x.preco_venda), 2)::text as venda
          from x where ${situacaoSaldo}`);
      const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
      const custo = verCusto(sessao);
      return {
        itens: rows.map((r) => ({
          chave: `${r.estoque_id}:${r.produto_id}:${r.tipo_estoque_id ?? ''}`,
          estoqueId: r.estoque_id as string,
          estoqueNome: r.estoque_nome as string,
          tipoEstoqueId: (r.tipo_estoque_id as string | null) ?? null,
          tipoEstoqueNome: (r.tipo_estoque_nome as string | null) ?? null,
          produtoId: r.produto_id as string,
          produtoCodigo: r.produto_codigo as number,
          produtoNome: r.produto_nome as string,
          codigoInterno: (r.codigo_interno as string | null) ?? null,
          unidadeSigla: r.sigla as string,
          quantidade: r.qtd as string,
          estoqueMinimo: (r.minimo as string | null) ?? null,
          custoMedio: custo ? (r.cm as string) : null,
          custoTotal: custo ? (r.custo_total as string) : null,
          precoVenda: r.pv as string,
          vendaTotal: r.venda_total as string,
          ultimaEntradaEm: iso(r.ultima_entrada_em),
          ultimaSaidaEm: iso(r.ultima_saida_em),
        })),
        total: tot[0]?.n ?? 0,
        pagina: q.pagina,
        tamanho: q.tamanho,
        totais: {
          quantidadeItens: tot[0]?.n ?? 0,
          custoTotal: custo ? (tot[0]?.custo ?? '0.00') : null,
          vendaTotal: tot[0]?.venda ?? '0.00',
        },
      };
    });
  }

  /** "Saldo atual" da grade do acerto (ERP 13.5): saldo e custo médio no estoque × tipo (padrão: Disponível). */
  @Permissao('estoque_acertos.ver')
  @Get('itens')
  async itens(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<SaldoItem[]> {
    const q = validar(consultaSaldoItemSchema, query);
    const visivel = estoqueVisivel(sessao, sql`e.id`);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows: est } = await db.execute<{ id: string }>(sql`
        select e.id from estoques e where e.id = ${q.estoqueId} and e.excluido_em is null
          ${visivel ? sql`and ${visivel}` : sql``}`);
      if (!est[0]) throw ErroApi.naoEncontrado('Estoque não encontrado.');
      const tipo = q.tipoEstoqueId
        ? sql`${q.tipoEstoqueId}::uuid`
        : sql`(select id from tipos_estoque where padrao and excluido_em is null limit 1)`;
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select p.id as produto_id, s.variacao_id, coalesce(s.quantidade, 0)::text as q,
               (case when coalesce(s.custo_medio, 0) > 0 then s.custo_medio else p.preco_custo end)::text as cm
          from produtos p
          left join saldos_estoque s on s.produto_id = p.id and s.estoque_id = ${q.estoqueId} and s.tipo_estoque_id = ${tipo}
         where p.id = any(${`{${q.produtoIds.join(',')}}`}::uuid[])`);
      return rows.map((r) => ({
        produtoId: r.produto_id as string,
        variacaoId: (r.variacao_id as string | null) ?? null,
        quantidade: r.q as string,
        custoMedio: verCusto(sessao) ? (r.cm as string) : null,
      }));
    });
  }

  /**
   * Lotes dos produtos da grade do acerto (F2-B6, F2-B9; MD 3.6.9): os ativos do produto que são do estoque ou sem
   * estoque, com o saldo do lote no estoque × tipo (zero sem linha), em ordem FEFO (validade, sem validade por último).
   */
  @Permissao('estoque_acertos.ver')
  @Get('lotes')
  async lotes(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<LoteSaldoItem[]> {
    const q = validar(consultaSaldoItemSchema, query);
    const visivel = estoqueVisivel(sessao, sql`e.id`);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows: est } = await db.execute<{ id: string }>(sql`
        select e.id from estoques e where e.id = ${q.estoqueId} and e.excluido_em is null
          ${visivel ? sql`and ${visivel}` : sql``}`);
      if (!est[0]) throw ErroApi.naoEncontrado('Estoque não encontrado.');
      const tipo = q.tipoEstoqueId
        ? sql`${q.tipoEstoqueId}::uuid`
        : sql`(select id from tipos_estoque where padrao and excluido_em is null limit 1)`;
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select pl.id, pl.produto_id, pl.variacao_id, pl.lote, to_char(pl.validade, 'YYYY-MM-DD') as validade,
               coalesce(sl.quantidade, 0)::text as q
          from produtos_lotes pl
          left join saldos_lote sl on sl.lote_id = pl.id and sl.estoque_id = ${q.estoqueId} and sl.tipo_estoque_id = ${tipo}
         where pl.excluido_em is null and (pl.ativo or coalesce(sl.quantidade, 0) <> 0)
           and (pl.estoque_id is null or pl.estoque_id = ${q.estoqueId})
           and pl.produto_id = any(${`{${q.produtoIds.join(',')}}`}::uuid[])
         order by pl.produto_id, pl.validade nulls last, pl.id`);
      return rows.map((r) => ({
        loteId: r.id as string,
        produtoId: r.produto_id as string,
        variacaoId: (r.variacao_id as string | null) ?? null,
        lote: r.lote as string,
        validade: (r.validade as string | null) ?? null,
        quantidade: r.q as string,
      }));
    });
  }
}
