import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  filtroReforcosSchema,
  filtroSangriasSchema,
  limiteDeslocamento,
  TIPOS_MOVIMENTO_REFORCO,
  TIPOS_MOVIMENTO_SANGRIA,
  type MovimentoCaixaDetalhe,
  type MovimentoCaixaResumo,
  type PaginaMovimentosCaixa,
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
  data: sql`m.ocorrido_em`,
  valor: sql`m.valor`,
  tipo: sql`m.tipo`,
  loja: sql`l.codigo * 1000 + m.numero_caixa`,
  operador: sql`lower(coalesce(u.nome, ''))`,
};

const lista = (valores: readonly string[]) =>
  sql.join(
    valores.map((v) => sql`${v}`),
    sql`, `,
  );

const DE = sql`from movimentos_caixa m join lojas l on l.id = m.loja_id
  join sessoes_caixa s on s.id = m.sessao_caixa_id
  left join usuarios u on u.id = m.operador_id
  left join usuarios ur on ur.id = m.quem_retira_usuario_id`;

const COLUNAS = sql`m.id, m.tipo, m.ocorrido_em, s.dia_operacional::text as dia, m.valor::text as valor,
  l.id as loja_id, l.codigo as loja_codigo, l.nome as loja_nome, l.treino, m.numero_caixa, u.nome as operador_nome,
  coalesce(ur.nome, m.quem_retira_nome) as quem_retira, m.cancelado`;

function resumo(r: Record<string, unknown>): MovimentoCaixaResumo {
  return {
    id: r.id as string,
    tipo: r.tipo as string,
    ocorridoEm: iso(r.ocorrido_em)!,
    diaOperacional: r.dia as string,
    valor: r.valor as string,
    lojaId: r.loja_id as string,
    lojaCodigo: r.loja_codigo as number,
    lojaNome: r.loja_nome as string,
    lojaTreino: r.treino as boolean,
    numeroCaixa: r.numero_caixa as number,
    operadorNome: texto(r.operador_nome),
    quemRetira: texto(r.quem_retira),
    cancelado: r.cancelado as boolean,
  };
}

/**
 * Reforço de caixa e abertura (ERP 15.2) e Sangria (15.3), só leitura (Fase 1C, bloco C12): os movimentos nascem no
 * PDV com a sessão aberta (`caixa.aberto`, `caixa.reforco`, `caixa.sangria`, `caixa.fechado` com a
 * `sangria_fechamento`) e o ERP não lança nem edita (15.2/15.3 "Regras comuns"). A data filtrada é o **dia
 * operacional da sessão** (D7), como no Fechamento de caixa (14.9); o totalizador soma só os não cancelados. Imprimir
 * o comprovante depende dos templates de impressão do ERP (3.7) e fica para depois.
 */
@Controller('movimentos-caixa')
export class MovimentosCaixaController {
  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('movimentos_caixa.ver')
  @Get('reforcos')
  reforcos(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<PaginaMovimentosCaixa> {
    const q = validar(filtroReforcosSchema, query);
    return this.listar(q, q.tipo ? [q.tipo] : TIPOS_MOVIMENTO_REFORCO, sessao);
  }

  @Permissao('movimentos_caixa.ver')
  @Get('sangrias')
  sangrias(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<PaginaMovimentosCaixa> {
    const q = validar(filtroSangriasSchema, query);
    return this.listar(q, q.tipo ? [q.tipo] : TIPOS_MOVIMENTO_SANGRIA, sessao);
  }

  @Permissao('movimentos_caixa.ver')
  @Get(':id')
  async detalhar(@Param('id') id: string, @Sessao() sessao: SessaoErp): Promise<MovimentoCaixaDetalhe> {
    const movimentoId = validar(z.uuid(), id);
    const visivel = lojaVisivel(sessao);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select ${COLUNAS}, m.sessao_caixa_id, m.terminal_id, t.descricao as terminal_descricao, m.operador_id,
               ur.nome as quem_retira_usuario_nome, m.quem_retira_nome, m.observacao, m.inf_adicionais,
               f.descricao as forma_descricao, ua.nome as autorizado_por_nome, m.cancelado_em,
               uc.nome as cancelado_por_nome, uac.nome as autorizado_cancelamento_por_nome, m.motivo_cancelamento
          ${DE}
          left join terminais t on t.id = m.terminal_id
          left join formas_pagamento f on f.id = m.forma_pagamento_id
          left join usuarios ua on ua.id = m.autorizado_por_id
          left join usuarios uc on uc.id = m.cancelado_por_id
          left join usuarios uac on uac.id = m.autorizado_cancelamento_por_id
         where m.id = ${movimentoId} ${visivel ? sql`and ${visivel}` : sql``}`);
      const r = rows[0];
      if (!r) throw ErroApi.naoEncontrado('Movimento de caixa não encontrado.');
      return {
        ...resumo(r),
        sessaoCaixaId: r.sessao_caixa_id as string,
        terminalId: r.terminal_id as string,
        terminalDescricao: texto(r.terminal_descricao),
        operadorId: r.operador_id as string,
        quemRetiraUsuarioNome: texto(r.quem_retira_usuario_nome),
        quemRetiraNome: texto(r.quem_retira_nome),
        observacao: texto(r.observacao),
        infAdicionais: texto(r.inf_adicionais),
        formaPagamentoDescricao: texto(r.forma_descricao),
        autorizadoPorNome: texto(r.autorizado_por_nome),
        canceladoEm: iso(r.cancelado_em),
        canceladoPorNome: texto(r.cancelado_por_nome),
        autorizadoCancelamentoPorNome: texto(r.autorizado_cancelamento_por_nome),
        motivoCancelamento: texto(r.motivo_cancelamento),
      };
    });
  }

  private listar(
    q: z.infer<typeof filtroReforcosSchema> | z.infer<typeof filtroSangriasSchema>,
    tipos: readonly string[],
    sessao: SessaoErp,
  ): Promise<PaginaMovimentosCaixa> {
    const ordem = ordemDaQuery(q, colunasOrdenacao, 'data:desc', sql`m.id`);
    const { limite, deslocamento } = limiteDeslocamento(q);
    const c: SQL[] = [sql`m.tipo in (${lista(tipos)})`, ...condicoesLoja(sessao, q)];
    c.push(...intervaloDia(sql`s.dia_operacional`, q.dataInicial, q.dataFinal));
    if (q.numeroCaixa !== undefined) c.push(sql`m.numero_caixa = ${q.numeroCaixa}`);
    if (q.operadorId) c.push(sql`m.operador_id = ${q.operadorId}`);
    if (q.sessaoCaixaId) c.push(sql`m.sessao_caixa_id = ${q.sessaoCaixaId}`);
    if (q.situacao === 'ativos') c.push(sql`not m.cancelado`);
    if (q.situacao === 'cancelados') c.push(sql`m.cancelado`);
    const onde = sql.join(c, sql` and `);
    return this.s.tenancy.cx().consulta(async (db) => {
      const { rows } = await db.execute<Record<string, unknown>>(sql`
        select ${COLUNAS} ${DE} where ${onde}
         order by ${sql.join(ordem, sql`, `)} limit ${limite} offset ${deslocamento}`);
      const { rows: tot } = await db.execute<{ n: number; ativos: number; valor: string }>(sql`
        select count(*)::int as n, count(*) filter (where not m.cancelado)::int as ativos,
               coalesce(sum(m.valor) filter (where not m.cancelado), 0)::numeric(15, 2)::text as valor
          ${DE} where ${onde}`);
      return {
        itens: rows.map(resumo),
        total: tot[0]!.n,
        pagina: q.pagina,
        tamanho: q.tamanho,
        totais: { quantidade: tot[0]!.ativos, valor: tot[0]!.valor },
      };
    });
  }
}
