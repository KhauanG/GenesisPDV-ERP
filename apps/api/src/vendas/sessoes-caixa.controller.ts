import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  conferirSessaoSchema,
  dec,
  decTexto,
  diferencaConferencia,
  filtroSessoesCaixaSchema,
  limiteDeslocamento,
  situacaoConferencia,
  type AvisoConferenciaCaixa,
  type ConferenciaCaixaDetalhe,
  type PaginaSessoesCaixa,
  type RespostaConferirSessao,
  type SessaoCaixaDetalhe,
  type SessaoCaixaResumo,
  type SituacaoConferencia,
} from '@genesis/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { lojaPermitida } from '../autorizacao/lojas.js';
import { conflitoVersao, ordemDaQuery } from '../comum/cadastro.js';
import { ErroApi } from '../comum/erros.js';
import { origemDaRequisicao, Req, Sessao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import type { Servicos } from '../servicos.js';
import { eventosPendentesDoTurno } from '../sync/handlers/caixa.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { condicoesLoja, intervaloDia, iso, lojaVisivel, texto } from './consultas.js';

/** A tolerância da conferência (D114): a diferença de cada forma até este valor ainda é "Conferida". */
export const CHAVE_TOLERANCIA_CONFERENCIA_CAIXA = 'pdv.tolerancia_diferenca_caixa';
export const LOCALIZACAO_FECHAMENTO_CAIXA = 'Financeiro › Fechamento de caixa';

const reais = (v: string) => `R$ ${v.replace('.', ',')}`;
const dataBr = (dia: string) => dia.split('-').reverse().join('/');
const ROTULOS_SITUACAO: Record<SituacaoConferencia, string> = {
  conferida: 'Conferida',
  divergente: 'Divergente',
};

const colunasOrdenacao: Record<string, SQL> = {
  data: sql`coalesce(s.fechada_em, s.aberta_em)`,
  loja: sql`l.codigo * 1000 + s.numero_caixa`,
  operador: sql`lower(coalesce(u.nome, ''))`,
  calculado: sql`coalesce(f.total_calculado, 0)`,
  informado: sql`coalesce(f.total_digitado, 0)`,
  diferenca: sql`coalesce(f.diferenca, 0)`,
};

// A conferência (F3-B9) é uma por fechamento (`uq_conferencias_caixa_fechamento`); a soma do conferido vem das formas.
const DE = sql`from sessoes_caixa s join lojas l on l.id = s.loja_id
  left join fechamentos_caixa f on f.sessao_caixa_id = s.id and f.excluido_em is null
  left join conferencias_caixa cc on cc.fechamento_id = f.id and cc.excluido_em is null
  left join lateral (
    select sum(cf.valor_conferido) as conferido, sum(cf.diferenca) as diferenca
      from conferencias_caixa_formas cf where cf.conferencia_id = cc.id and cf.excluido_em is null) cf on true
  left join usuarios u on u.id = s.operador_id
  left join usuarios us on us.id = f.usuario_subsequente_id`;

const COLUNAS = sql`s.id, l.id as loja_id, l.codigo as loja_codigo, l.nome as loja_nome, l.treino, s.numero_caixa,
  s.dia_operacional::text as dia, s.aberta_em, s.fechada_em, u.nome as operador_nome, us.nome as subsequente_nome,
  s.status, s.fechamento_forcado, f.id as fechamento_id, f.tipo as tipo_fechamento, f.valor_caixa::text as valor_caixa,
  f.total_calculado::text as calculado, f.total_digitado::text as informado, f.diferenca::text as diferenca,
  cc.id as conferencia_id, cc.situacao as situacao_conferencia,
  case when cc.id is not null then coalesce(cf.conferido, 0)::numeric(15, 2)::text end as conferido,
  case when cc.id is not null then coalesce(cf.diferenca, 0)::numeric(15, 2)::text end as diferenca_conferida`;

/**
 * "Somente com diferença" (ERP 14.9) **sobre o conferido** (F3-B9): conferida, conta a diferença do conferido com o
 * calculado; sem conferência, a do informado pelo operador. Em ambos, qualquer forma com diferença basta (−5 no
 * dinheiro e +5 no PIX somam zero, mas estão errados), além do total do fechamento.
 */
const COM_DIFERENCA = sql`(case when cc.id is not null
    then exists (select 1 from conferencias_caixa_formas x
                  where x.conferencia_id = cc.id and x.excluido_em is null and x.diferenca <> 0)
    else coalesce(f.diferenca, 0) <> 0
      or exists (select 1 from fechamentos_caixa_formas x
                  where x.fechamento_id = f.id and x.excluido_em is null and x.diferenca <> 0) end)`;

/**
 * Situação da 14.9: "Fechada pela nuvem" (`fechada_forcado`) só enquanto o `caixa.fechado` da sessão fechada à força
 * (substituição/revogação, MD 3.12.1) não chegou. O handler grava o fechamento tardio do terminal antigo mantendo
 * `fechamento_forcado` para a auditoria (`handlers/caixa.ts`); com o fechamento gravado, a sessão sai como `fechada`
 * e a marca fica no `fechamentoForcadoMotivo` do detalhe. Conferida pelo gerente (F3-B9), a situação é a da
 * conferência (`conferida` ou `divergente`), derivada de `conferencias_caixa` sem mudar `sessoes_caixa.status`.
 */
function situacaoSessao(r: Record<string, unknown>): string {
  if (r.status !== 'fechada') return 'aberta';
  if (!r.fechamento_id) return r.fechamento_forcado ? 'fechada_forcado' : 'fechada';
  return (r.situacao_conferencia as string | null) ?? 'fechada';
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
    totalConferido: texto(r.conferido),
    diferencaConferida: texto(r.diferenca_conferida),
  };
}

/**
 * Fechamento de caixa / troca de turno (ERP 14.9; Fase 1C, bloco C12): as sessões vindas dos PDVs (`caixa.aberto` …
 * `caixa.fechado`, SYNC 9.3–9.6) com o calculado, o informado e a diferença por forma. Com o fechamento cego mais
 * rígido do dono (O3), é **aqui** que o gerente (`fechamentos_caixa.ver`) vê o esperado e a diferença; o operador e o
 * supervisor não veem no PDV. A conferência do gerente (Fase 3, F3-B9; D114; MD 3.12.4) é a única gravação desta tela:
 * `POST /sessoes-caixa/:id/conferir` (`fechamentos_caixa.conferir`) grava `conferencias_caixa` e nada do que veio do
 * caixa muda. A quebra/sobra no financeiro (`conta_financeira_id`) é da Fase 4.
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
    if (q.situacao === 'fechada') c.push(sql`s.status = 'fechada' and cc.id is null`);
    if (q.situacao === 'conferida' || q.situacao === 'divergente')
      c.push(sql`s.status = 'fechada' and cc.situacao = ${q.situacao}`);
    if (q.somenteComDiferenca) c.push(COM_DIFERENCA);
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
    return this.s.tenancy.cx().consulta((db) => detalheSessao(db, sessaoId, sessao));
  }

  /**
   * Conferência do fechamento (ERP 14.9; MD 3.12.4; F3-B9; D114 = F3-Q44 (A)): o gerente informa o valor conferido de
   * cada forma do fechamento e a sessão vira "Conferida" (todas as formas dentro de `pdv.tolerancia_diferenca_caixa`
   * da loja) ou "Divergente". Só sessão com `fechamentos_caixa` (a aberta e a fechada pela nuvem sem o fechamento do
   * caixa são 422). O fechamento fica travado (`for update`) durante a gravação: duas conferências ao mesmo tempo
   * gravam uma depois da outra, e a segunda, que leu a versão antiga, é 409. Refazer (mesma permissão) altera a mesma
   * linha, com o antes e o depois na auditoria. Nada do que veio do caixa muda; `conta_financeira_id` fica nulo até a
   * Fase 4.
   */
  @Permissao('fechamentos_caixa.conferir')
  @Post(':id/conferir')
  @HttpCode(200)
  async conferir(
    @Param('id') id: string,
    @Body() corpo: unknown,
    @Sessao() sessao: SessaoErp,
    @Req() req: RequisicaoGenesis,
  ): Promise<RespostaConferirSessao> {
    const sessaoId = validar(z.uuid(), id);
    const dados = validar(conferirSessaoSchema, corpo ?? {});
    await this.s.tenancy.cx().transacao(async (tx) => {
      const { rows } = await tx.execute<Record<string, unknown>>(sql`
        select s.id, s.loja_id, s.status, s.numero_caixa, s.dia_operacional::text as dia, f.id as fechamento_id
          from sessoes_caixa s
          left join fechamentos_caixa f on f.sessao_caixa_id = s.id and f.excluido_em is null
         where s.id = ${sessaoId} and s.excluido_em is null`);
      const r = rows[0];
      if (!r) throw ErroApi.naoEncontrado('Sessão de caixa não encontrada.');
      const lojaId = r.loja_id as string;
      if (!lojaPermitida(sessao, lojaId))
        throw ErroApi.semPermissao('A loja está fora das suas lojas permitidas.');
      const motivo = motivoSemConferencia(r.status as string, texto(r.fechamento_id));
      if (motivo) throw new ErroApi('REGRA_NEGOCIO', motivo);
      const fechamentoId = r.fechamento_id as string;
      // A trava é a do fechamento (uma conferência por fechamento): a segunda gravação espera a primeira terminar.
      await tx.execute(sql`select id from fechamentos_caixa where id = ${fechamentoId} for update`);
      const { rows: atuais } = await tx.execute<Record<string, unknown>>(sql`
        select cc.id, cc.versao, cc.situacao, cc.observacao, cc.atualizado_por_id, cc.atualizado_em
          from conferencias_caixa cc where cc.fechamento_id = ${fechamentoId} and cc.excluido_em is null`);
      const atual = atuais[0];
      if (atual && Number(atual.versao) !== dados.versao)
        await conflitoVersao(tx, {
          versao: Number(atual.versao),
          atualizadoPorId: texto(atual.atualizado_por_id),
          atualizadoEm: new Date(atual.atualizado_em as string),
        });
      if (!atual && dados.versao !== null)
        throw new ErroApi('CONFLITO_VERSAO', 'A conferência não existe mais. Recarregue e tente de novo.');

      const { rows: formasFechamento } = await tx.execute<Record<string, string>>(sql`
        select ff.forma_pagamento_id, ff.descricao_forma, ff.valor_calculado::text as calculado
          from fechamentos_caixa_formas ff
         where ff.fechamento_id = ${fechamentoId} and ff.excluido_em is null
         order by ff.tipo_forma <> 'dinheiro', ff.descricao_forma`);
      const informadas = new Map(
        dados.formas.map((f) => [f.formaPagamentoId.toLowerCase(), f.valorConferido]),
      );
      const faltam = formasFechamento.filter((f) => !informadas.has(f.forma_pagamento_id!));
      const sobram = dados.formas.filter(
        (f) => !formasFechamento.some((ff) => ff.forma_pagamento_id === f.formaPagamentoId.toLowerCase()),
      );
      if (faltam.length || sobram.length)
        throw new ErroApi('VALIDACAO', 'Informe o valor conferido de cada forma do fechamento, e só delas.', {
          campos: {
            formas: [
              ...(faltam.length ? [`Falta: ${faltam.map((f) => f.descricao_forma).join(', ')}`] : []),
              ...(sobram.length ? ['Forma que não está no fechamento deste caixa'] : []),
            ],
          },
        });

      const tolerancia = decTexto(
        (await lerConfiguracao<string | null>(tx, CHAVE_TOLERANCIA_CONFERENCIA_CAIXA, lojaId)) ?? '0',
        2,
      );
      const formas = formasFechamento.map((f) => {
        const conferido = informadas.get(f.forma_pagamento_id!)!;
        return {
          formaPagamentoId: f.forma_pagamento_id!,
          descricao: f.descricao_forma!,
          calculado: f.calculado!,
          conferido,
          diferenca: diferencaConferencia(conferido, f.calculado!),
        };
      });
      const situacao = situacaoConferencia(
        formas.map((f) => ({ valorCalculado: f.calculado, valorConferido: f.conferido })),
        tolerancia,
      );

      // Antes de sobrescrever: o conferido anterior por forma, para a auditoria do refazer.
      const anteriores = new Map<string, string>();
      if (atual) {
        const { rows: fa } = await tx.execute<{ forma_pagamento_id: string; valor: string }>(sql`
          select forma_pagamento_id, valor_conferido::text as valor from conferencias_caixa_formas
           where conferencia_id = ${atual.id as string} and excluido_em is null`);
        for (const f of fa) anteriores.set(f.forma_pagamento_id, f.valor);
      }
      let conferenciaId: string;
      if (atual) {
        conferenciaId = atual.id as string;
        await tx.execute(sql`
          update conferencias_caixa
             set situacao = ${situacao}, observacao = ${dados.observacao}, conferido_por_id = ${sessao.usuarioId},
                 conferido_em = now(), atualizado_por_id = ${sessao.usuarioId}
           where id = ${conferenciaId}`);
      } else {
        const { rows: novo } = await tx.execute<{ id: string }>(sql`
          insert into conferencias_caixa (fechamento_id, conferido_por_id, conferido_em, situacao, observacao,
                                          criado_por_id, atualizado_por_id)
          values (${fechamentoId}, ${sessao.usuarioId}, now(), ${situacao}, ${dados.observacao},
                  ${sessao.usuarioId}, ${sessao.usuarioId})
          returning id`);
        conferenciaId = novo[0]!.id;
      }
      for (const f of formas)
        await tx.execute(sql`
          insert into conferencias_caixa_formas (conferencia_id, forma_pagamento_id, valor_conferido, diferenca)
          values (${conferenciaId}, ${f.formaPagamentoId}, ${f.conferido}, ${f.diferenca})
          on conflict (conferencia_id, forma_pagamento_id)
          do update set valor_conferido = excluded.valor_conferido, diferenca = excluded.diferenca, excluido_em = null`);

      const caixa = `Caixa ${String(r.numero_caixa).padStart(2, '0')} do dia ${dataBr(r.dia as string)}`;
      const linhas = formas.map((f) => {
        const antes = anteriores.get(f.formaPagamentoId);
        const conferido =
          atual && antes !== undefined && antes !== f.conferido
            ? `conferido ${reais(antes)} → ${reais(f.conferido)}`
            : `conferido ${reais(f.conferido)}`;
        return `${f.descricao}: calculado ${reais(f.calculado)}, ${conferido}, diferença ${reais(f.diferenca)}`;
      });
      const situacaoTexto = atual
        ? `${ROTULOS_SITUACAO[atual.situacao as SituacaoConferencia] ?? String(atual.situacao)} → ${ROTULOS_SITUACAO[situacao]}`
        : ROTULOS_SITUACAO[situacao];
      const instantaneo = (conferidos: (id: string) => string | undefined, sit: unknown, obs: unknown) => ({
        situacao: sit,
        observacao: obs,
        formas: formas.map((f) => ({
          forma: f.descricao,
          formaPagamentoId: f.formaPagamentoId,
          calculado: f.calculado,
          conferido: conferidos(f.formaPagamentoId) ?? null,
        })),
      });
      await this.s.auditoria.registrar(tx, origemDaRequisicao(req), {
        acao: 'conferir',
        entidade: 'sessoes_caixa',
        registroId: sessaoId,
        localizacao: LOCALIZACAO_FECHAMENTO_CAIXA,
        lojaId,
        descricao:
          `${caixa} ${atual ? 'teve a conferência refeita' : 'conferido'}: ${situacaoTexto} ` +
          `(tolerância ${reais(tolerancia)} por forma). ${linhas.join('; ')}.` +
          (dados.observacao ? ` Observação: ${dados.observacao}` : ''),
        antes: atual
          ? instantaneo((id) => anteriores.get(id), atual.situacao, texto(atual.observacao))
          : null,
        depois: {
          ...instantaneo(
            (id) => formas.find((f) => f.formaPagamentoId === id)?.conferido,
            situacao,
            dados.observacao,
          ),
          tolerancia,
        },
      });
    });
    return this.s.tenancy.cx().consulta((db) => detalheSessao(db, sessaoId, sessao));
  }
}

/**
 * Por que a sessão ainda não se confere (padrão da Fase 3: a conferência só existe para sessão com
 * `fechamentos_caixa`); `null` = pode conferir.
 */
function motivoSemConferencia(status: string, fechamentoId: string | null): string | null {
  if (status !== 'fechada')
    return 'A sessão ainda está aberta no caixa: a conferência é feita depois do fechamento.';
  if (!fechamentoId)
    return (
      'A sessão foi fechada pela nuvem e o fechamento do caixa ainda não chegou: sem a contagem do caixa não há o ' +
      'que conferir. Ela aparece aqui quando o caixa antigo voltar a sincronizar.'
    );
  return null;
}

/** O detalhe da sessão (14.9), com a conferência (F3-B9), a tolerância de agora e os avisos. */
async function detalheSessao(
  db: DbEmpresa,
  sessaoId: string,
  sessao: SessaoErp,
): Promise<SessaoCaixaDetalhe> {
  const visivel = lojaVisivel(sessao);
  const { rows } = await db.execute<Record<string, unknown>>(sql`
        select ${COLUNAS}, s.caixa_id, s.terminal_id, t.descricao as terminal_descricao, s.operador_id,
               s.fundo_troco::text as fundo_troco, s.abertura_automatica, s.sessao_anterior_id,
               s.valor_recebido_anterior::text as valor_recebido_anterior,
               s.diferenca_recebimento::text as diferenca_recebimento, s.fechamento_forcado_motivo,
               f.zera_caixa, f.ocorrido_em as fechamento_em, f.fechamento_cego, f.recontagem,
               f.justificativa, ua.nome as anterior_nome, f.resumo,
               (f.resumo ->> 'ultima_sequencia_evento')::bigint as ultima_sequencia_evento,
               cc.versao as conferencia_versao, cc.conferido_em, uc.nome as conferido_por_nome,
               cc.observacao as conferencia_observacao
          ${DE}
          left join terminais t on t.id = s.terminal_id
          left join usuarios ua on ua.id = f.usuario_anterior_id
          left join usuarios uc on uc.id = cc.conferido_por_id
         where s.id = ${sessaoId} and s.excluido_em is null ${visivel ? sql`and ${visivel}` : sql``}`);
  const r = rows[0];
  if (!r) throw ErroApi.naoEncontrado('Sessão de caixa não encontrada.');
  const [{ rows: formas }, { rows: movimentos }, { rows: dinheiro }, { rows: vendas }] = await Promise.all([
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
  const lojaId = r.loja_id as string;
  const [conferidas, tolerancia, pendentes] = await Promise.all([
    r.conferencia_id
      ? db.execute<Record<string, string>>(sql`
              select cf.forma_pagamento_id, cf.valor_conferido::text as conferido, cf.diferenca::text as diferenca
                from conferencias_caixa_formas cf
               where cf.conferencia_id = ${r.conferencia_id as string} and cf.excluido_em is null`)
      : Promise.resolve({ rows: [] as Record<string, string>[] }),
    lerConfiguracao<string | null>(db, CHAVE_TOLERANCIA_CONFERENCIA_CAIXA, lojaId),
    r.fechamento_id
      ? eventosPendentesDoTurno(
          db,
          r.terminal_id as string,
          sessaoId,
          r.ultima_sequencia_evento === null || r.ultima_sequencia_evento === undefined
            ? Number.MAX_SAFE_INTEGER
            : Number(r.ultima_sequencia_evento),
        )
      : Promise.resolve([] as number[]),
  ]);
  const avisos: AvisoConferenciaCaixa[] = [];
  if (pendentes.length)
    avisos.push({
      codigo: 'eventos_pendentes',
      mensagem:
        `${pendentes.length} evento(s) do turno ainda em erro ou retido(s) na nuvem (sequência ` +
        `${pendentes.join(', ')}): o que o caixa calculou ainda não está todo aqui. Resolva-os nos eventos com ` +
        'erro do terminal antes de conferir.',
    });
  const dinheiroCaixa = formas.find((f) => f.tipo_forma === 'dinheiro');
  if (dinheiroCaixa && !dec(dinheiroCaixa.calculado as string).equals(esperado))
    avisos.push({
      codigo: 'calculo_divergente',
      mensagem:
        `O caixa calculou ${reais(dinheiroCaixa.calculado as string)} em dinheiro e o cálculo da nuvem dá ` +
        `${reais(decTexto(esperado, 2))}: ainda falta chegar (ou está retido) algum evento desta sessão.`,
    });
  const conferencia: ConferenciaCaixaDetalhe | null = r.conferencia_id
    ? {
        id: r.conferencia_id as string,
        versao: Number(r.conferencia_versao),
        situacao: r.situacao_conferencia as SituacaoConferencia,
        conferidoEm: iso(r.conferido_em)!,
        conferidoPorNome: texto(r.conferido_por_nome),
        observacao: texto(r.conferencia_observacao),
        totalConferido: r.conferido as string,
        diferenca: r.diferenca_conferida as string,
        formas: conferidas.rows.map((c) => ({
          formaPagamentoId: c.forma_pagamento_id!,
          valorConferido: c.conferido!,
          diferenca: c.diferenca!,
        })),
      }
    : null;
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
    conferencia,
    toleranciaConferencia: decTexto(tolerancia ?? '0', 2),
    motivoSemConferencia: motivoSemConferencia(r.status as string, texto(r.fechamento_id)),
    avisosConferencia: avisos,
  };
}
