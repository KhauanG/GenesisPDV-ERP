import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  dec,
  decTexto,
  filtroSessoesCaixaSchema,
  limiteDeslocamento,
  type PaginaSessoesCaixa,
  type SessaoCaixaDetalhe,
  type SessaoCaixaResumo,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { Sessao } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import type { Servicos } from '../servicos.js';
import { condicoesLoja, intervaloDia, iso, lojaVisivel, texto } from './consultas.js';

const colunasOrdenacao: Record<string, SQL> = {
  data: sql`coalesce(s.fechada_em, s.aberta_em)`,
  loja: sql`l.codigo * 1000 + s.numero_caixa`,
  operador: sql`lower(coalesce(u.nome, ''))`,
  calculado: sql`coalesce(f.total_calculado, 0)`,
  informado: sql`coalesce(f.total_digitado, 0)`,
  diferenca: sql`coalesce(f.diferenca, 0)`,
};

const DE = sql`from sessoes_caixa s join lojas l on l.id = s.loja_id
  left join fechamentos_caixa f on f.sessao_caixa_id = s.id and f.excluido_em is null
  left join usuarios u on u.id = s.operador_id
  left join usuarios us on us.id = f.usuario_subsequente_id`;

const COLUNAS = sql`s.id, l.id as loja_id, l.codigo as loja_codigo, l.nome as loja_nome, l.treino, s.numero_caixa,
  s.dia_operacional::text as dia, s.aberta_em, s.fechada_em, u.nome as operador_nome, us.nome as subsequente_nome,
  s.status, s.fechamento_forcado, f.id as fechamento_id, f.tipo as tipo_fechamento, f.valor_caixa::text as valor_caixa,
  f.total_calculado::text as calculado, f.total_digitado::text as informado, f.diferenca::text as diferenca`;

/**
 * Situação da 14.9: "Fechada pela nuvem" (`fechada_forcado`) só enquanto o `caixa.fechado` da sessão fechada à força
 * (substituição/revogação, MD 3.12.1) não chegou. O handler grava o fechamento tardio do terminal antigo mantendo
 * `fechamento_forcado` para a auditoria (`handlers/caixa.ts`); com o fechamento gravado, a sessão sai como `fechada`
 * e a marca fica no `fechamentoForcadoMotivo` do detalhe.
 */
function situacaoSessao(r: Record<string, unknown>): string {
  if (r.status !== 'fechada') return 'aberta';
  return r.fechamento_forcado && !r.fechamento_id ? 'fechada_forcado' : 'fechada';
}

function resumo(r: Record<string, unknown>): SessaoCaixaResumo {
  return {
    id: r.id as string,
    lojaId: r.loja_id as string,
    lojaCodigo: r.loja_codigo as number,
    lojaNome: r.loja_nome as string,
    lojaTreino: r.treino as boolean,
    numeroCaixa: r.numero_caixa as number,
    diaOperacional: r.dia as string,
    abertaEm: iso(r.aberta_em)!,
    fechadaEm: iso(r.fechada_em),
    operadorNome: texto(r.operador_nome),
    usuarioSubsequenteNome: texto(r.subsequente_nome),
    situacao: situacaoSessao(r),
    tipoFechamento: texto(r.tipo_fechamento),
    valorCaixa: texto(r.valor_caixa),
    totalCalculado: texto(r.calculado),
    totalInformado: texto(r.informado),
    diferenca: texto(r.diferenca),
  };
}

/**
 * Fechamento de caixa / troca de turno (ERP 14.9), só leitura (Fase 1C, bloco C12): as sessões vindas dos PDVs
 * (`caixa.aberto` … `caixa.fechado`, SYNC 9.3–9.6) com o calculado, o informado e a diferença por forma. Com o
 * fechamento cego mais rígido do dono (O3), é **aqui** que o gerente (`fechamentos_caixa.ver`) vê o esperado e a
 * diferença; o operador e o supervisor não veem no PDV. A conferência (situações Conferida/Divergente,
 * `POST /sessoes-caixa/:id/conferir` e `fechamentos_caixa.conferir`) é da Fase 3 e a quebra/sobra no financeiro, da
 * Fase 4.
 */
@Controller('sessoes-caixa')
export class SessoesCaixaController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('fechamentos_caixa.ver')
  @Get()
  async listar(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<PaginaSessoesCaixa> {
    const q = validar(filtroSessoesCaixaSchema, query);
    const ordem = ordemDaQuery(q, colunasOrdenacao, 'data:desc', sql`s.id`);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const c: SQL[] = [sql`s.excluido_em is null`, ...condicoesLoja(sessao, q)];
    c.push(...intervaloDia(sql`s.dia_operacional`, q.dataInicial, q.dataFinal));
    if (q.numeroCaixa !== undefined) c.push(sql`s.numero_caixa = ${q.numeroCaixa}`);
    if (q.operadorId) c.push(sql`s.operador_id = ${q.operadorId}`);
    if (q.situacao === 'aberta') c.push(sql`s.status <> 'fechada'`);
    if (q.situacao === 'fechada') c.push(sql`s.status = 'fechada'`);
    if (q.somenteComDiferenca) c.push(sql`f.diferenca <> 0`);
    const onde = sql.join(c, sql` and `);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select ${COLUNAS} ${DE} where ${onde}
         order by ${sql.join(ordem, sql`, `)} limit ${limite} offset ${deslocamento}`);
      const { rows: tot } = await db.execute<{
        n: number;
        calculado: string;
        informado: string;
        diferenca: string;
      }>(
        sql`select count(*)::int as n, coalesce(sum(f.total_calculado), 0)::numeric(15, 2)::text as calculado,
                   coalesce(sum(f.total_digitado), 0)::numeric(15, 2)::text as informado,
                   coalesce(sum(f.diferenca), 0)::numeric(15, 2)::text as diferenca
              ${DE} where ${onde}`,
      );
      const t = tot[0]!;
      return {
        itens: rows.map(resumo),
        total: t.n,
        pagina: q.pagina,
        tamanho: q.tamanho,
        totais: { calculado: t.calculado, informado: t.informado, diferenca: t.diferenca },
      };
    });
  }

  @Permissao('fechamentos_caixa.ver')
  @Get(':id')
  async detalhar(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<SessaoCaixaDetalhe> {
    const sessaoId = validar(z.uuid(), id);
    const visivel = lojaVisivel(sessao);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select ${COLUNAS}, s.caixa_id, s.terminal_id, t.descricao as terminal_descricao, s.operador_id,
               s.fundo_troco::text as fundo_troco, s.abertura_automatica, s.sessao_anterior_id,
               s.valor_recebido_anterior::text as valor_recebido_anterior,
               s.diferenca_recebimento::text as diferenca_recebimento, s.fechamento_forcado_motivo,
               f.zera_caixa, f.ocorrido_em as fechamento_em, f.fechamento_cego, f.recontagem,
               f.justificativa, ua.nome as anterior_nome, f.resumo
          ${DE}
          left join terminais t on t.id = s.terminal_id
          left join usuarios ua on ua.id = f.usuario_anterior_id
         where s.id = ${sessaoId} and s.excluido_em is null ${visivel ? sql`and ${visivel}` : sql``}`);
      const r = rows[0];
      if (!r) throw ErroApi.naoEncontrado('Sessão de caixa não encontrada.');
      const [{ rows: formas }, { rows: movimentos }, { rows: dinheiro }, { rows: vendas }] =
        await Promise.all([
          r.fechamento_id
            ? db.execute<Record<string, unknown>>(sql`
              select ff.forma_pagamento_id, ff.descricao_forma, ff.tipo_forma, ff.valor_calculado::text as calculado,
                     ff.valor_digitado::text as informado, ff.diferenca::text as diferenca, ff.quantidade_pagamentos
                from fechamentos_caixa_formas ff
               where ff.fechamento_id = ${r.fechamento_id as string} and ff.excluido_em is null
               order by ff.tipo_forma <> 'dinheiro', ff.descricao_forma`)
            : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
          db.execute<Record<string, unknown>>(sql`
          select m.id, m.tipo, m.ocorrido_em, m.valor::text as valor, fp.descricao as forma_descricao,
                 coalesce(ur.nome, m.quem_retira_nome) as quem_retira, m.observacao, m.cancelado
            from movimentos_caixa m
            left join formas_pagamento fp on fp.id = m.forma_pagamento_id
            left join usuarios ur on ur.id = m.quem_retira_usuario_id
           where m.sessao_caixa_id = ${sessaoId} order by m.ocorrido_em, m.id`),
          // PDV 20.4 (`ApuracaoCaixa`): pagamentos aprovados de vendas finalizadas na sessão, mesmo canceladas depois
          // (o estorno subtrai pelo movimento, na sessão em que o dinheiro saiu), e os movimentos não cancelados.
          db.execute<Record<string, string>>(sql`
          select
            coalesce((select sum(pg.valor) from pagamentos_venda pg join vendas v on v.id = pg.venda_id
                       where v.sessao_caixa_id = ${sessaoId} and v.finalizada_em is not null
                         and pg.status in ('aprovado', 'estornado') and pg.tipo_forma = 'dinheiro'), 0)::numeric(15, 2)::text as vendas,
            coalesce((select sum(pg.troco) from pagamentos_venda pg join vendas v on v.id = pg.venda_id
                       where v.sessao_caixa_id = ${sessaoId} and v.finalizada_em is not null
                         and pg.status in ('aprovado', 'estornado') and pg.tipo_forma <> 'dinheiro'), 0)::numeric(15, 2)::text as troco,
            coalesce(sum(m.valor) filter (where m.tipo = 'reforco'), 0)::numeric(15, 2)::text as reforcos,
            coalesce(sum(m.valor) filter (where m.tipo = 'sangria'), 0)::numeric(15, 2)::text as sangrias,
            coalesce(sum(m.valor) filter (where m.tipo = 'estorno_venda'
                                            and (fp.id is null or fp.tipo_forma = 'dinheiro')), 0)::numeric(15, 2)::text as estornos,
            coalesce(sum(m.valor) filter (where m.tipo = 'devolucao_troca'), 0)::numeric(15, 2)::text as devolucoes,
            coalesce(sum(m.valor) filter (where m.tipo = 'sangria_fechamento'), 0)::numeric(15, 2)::text as sangria_fechamento
            from movimentos_caixa m left join formas_pagamento fp on fp.id = m.forma_pagamento_id
           where m.sessao_caixa_id = ${sessaoId} and not m.cancelado`),
          db.execute<Record<string, unknown>>(sql`
          select count(*) filter (where status = 'finalizada')::int as quantidade,
                 coalesce(sum(total) filter (where status = 'finalizada'), 0)::numeric(15, 2)::text as total,
                 count(*) filter (where status = 'cancelada')::int as canceladas,
                 coalesce(sum(total) filter (where status = 'cancelada'), 0)::numeric(15, 2)::text as total_canceladas
            from vendas where sessao_caixa_id = ${sessaoId}`),
        ]);
      const d = dinheiro[0]!;
      const esperado = dec(r.fundo_troco as string)
        .plus(dec(d.vendas))
        .minus(dec(d.troco))
        .plus(dec(d.reforcos))
        .minus(dec(d.sangrias))
        .minus(dec(d.estornos))
        .minus(dec(d.devolucoes));
      const v = vendas[0]!;
      return {
        ...resumo(r),
        caixaId: r.caixa_id as string,
        terminalId: r.terminal_id as string,
        terminalDescricao: texto(r.terminal_descricao),
        operadorId: r.operador_id as string,
        fundoTroco: r.fundo_troco as string,
        aberturaAutomatica: r.abertura_automatica as boolean,
        sessaoAnteriorId: texto(r.sessao_anterior_id),
        valorRecebidoAnterior: texto(r.valor_recebido_anterior),
        diferencaRecebimento: texto(r.diferenca_recebimento),
        fechamentoForcadoMotivo: texto(r.fechamento_forcado_motivo),
        fechamento: r.fechamento_id
          ? {
              id: r.fechamento_id as string,
              tipo: r.tipo_fechamento as string,
              zeraCaixa: r.zera_caixa as boolean,
              ocorridoEm: iso(r.fechamento_em)!,
              fechamentoCego: r.fechamento_cego as boolean,
              recontagem: r.recontagem as boolean,
              justificativa: texto(r.justificativa),
              usuarioAnteriorNome: texto(r.anterior_nome),
              usuarioSubsequenteNome: texto(r.subsequente_nome),
              resumo: (r.resumo as Record<string, unknown> | null) ?? {},
            }
          : null,
        formas: formas.map((f) => ({
          formaPagamentoId: f.forma_pagamento_id as string,
          descricaoForma: f.descricao_forma as string,
          tipoForma: f.tipo_forma as string,
          valorCalculado: f.calculado as string,
          valorInformado: f.informado as string,
          diferenca: f.diferenca as string,
          quantidadePagamentos: f.quantidade_pagamentos as number,
        })),
        calculoDinheiro: {
          fundoTroco: r.fundo_troco as string,
          vendasDinheiro: d.vendas!,
          trocoOutrasFormas: d.troco!,
          reforcos: d.reforcos!,
          sangrias: d.sangrias!,
          estornosDinheiro: d.estornos!,
          devolucoes: d.devolucoes!,
          esperado: decTexto(esperado, 2),
          sangriaFechamento: d.sangria_fechamento!,
        },
        movimentos: movimentos.map((m) => ({
          id: m.id as string,
          tipo: m.tipo as string,
          ocorridoEm: iso(m.ocorrido_em)!,
          valor: m.valor as string,
          formaPagamentoDescricao: texto(m.forma_descricao),
          quemRetira: texto(m.quem_retira),
          observacao: texto(m.observacao),
          cancelado: m.cancelado as boolean,
        })),
        vendas: {
          quantidade: v.quantidade as number,
          total: v.total as string,
          canceladas: v.canceladas as number,
          totalCanceladas: v.total_canceladas as string,
        },
      };
    });
  }
}
