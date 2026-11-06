/**
 * Compensações visíveis no acerto (F2-B10; ERP 13.1.5 regra 4; SYNC 15.3; README da API › decisão 155). O detalhe do
 * acerto traz cada `ACERTO_COMPENSACAO` ligada a ele, nos dois sentidos:
 *
 * - **lançada** por este "Definir" (`documento_id` = ele): o fato anterior à contagem que só chegou depois da
 *   efetivação (a venda, o cancelamento e a devolução de cascos do PDV offline) ou o acerto lançado antes da contagem;
 * - **recebida**: um movimento deste acerto era anterior à contagem de outro "Definir" já efetivado e foi anulado por
 *   ele (a mesma busca de `compensacoesDoDocumento`).
 *
 * Com cada uma: o movimento compensado (tipo, documento de origem, terminal e caixa, o evento e a hora em que a nuvem o
 * recebeu), a hora do fato, o estorno que a desfez (`ESTORNO_ACERTO` com `estorno_de_id` = ela, do estorno de um dos
 * dois acertos) com a compensação que a substituiu (o fato que outro "Definir" efetivado também contou é compensado de
 * novo contra ele no estorno, `estornarAcerto`) e o relógio do caixa no evento. A compensação depende só da hora do
 * fato contra a hora da contagem: com o relógio do caixa errado, a venda pode ter sido compensada sem ter sido contada
 * (ou o contrário), e a aba destaca a linha (`relogioSuspeitoCompensacao`). O relógio é reavaliado no evento pelas
 * mesmas regras que gravam o `RELOGIO_SUSPEITO` (`suspeitasDoRelogio`, SYNC 12.4), e não pelo alerta: o alerta aberto
 * soma as ocorrências do terminal num só registro (só guarda o primeiro e o último evento) e some quando alguém marca
 * "Ciente". A chegada é o `criado_em` da linha de `eventos_recebidos`; na lacuna recuperada (SYNC 8.6) a linha é a do
 * placeholder, e `substituirPlaceholder` passa o `criado_em` para a hora do lote do evento real (a mesma do alerta).
 *
 * Só leitura, sem trava: roda na consulta do detalhe (`detalheAcerto`). O rascunho não tem movimento e não consulta.
 */
import {
  DESVIO_RELOGIO_CRITICO_MS,
  LIMITE_COMPENSACOES_DETALHE,
  MOTIVOS_RELOGIO_COMPENSACAO,
  TIPO_TERMINAL_LACUNA,
  decTexto,
  relogioSuspeitoCompensacao,
  type CompensacaoAcerto,
  type MotivoRelogioCompensacao,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import { suspeitasDoRelogio } from '../sync/relogio.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** O que o evento do PDV que lançou o fato diz do relógio (envelope gravado em `eventos_recebidos`, migração 0010). */
export interface RelogioDoEvento {
  ocorridoEm: Date;
  recebidoEm: Date;
  ativadoEm: Date | null;
  anterior: { sequencia: number; ocorridoEm: Date } | null;
  relogioConfiavel: boolean | null;
  relogioRegrediu: boolean;
  desvioMs: number | null;
}

/**
 * Os motivos de duvidar da hora do fato (sem banco; unitário em `compensacoes-acerto.spec.ts`), na ordem de
 * `MOTIVOS_RELOGIO_COMPENSACAO`: o caixa sem hora confiável, as regras da SYNC 12.4 (as do alerta) e o desvio medido
 * acima do crítico (5 min) **só sem a hora confiável**. Com `relogio_confiavel = true` o `ocorrido_em` já é o
 * `agora_local + desvio` de uma amostra do boot atual (SYNC 12.2; `desvio_relogio_ms` é o "desvio usado na
 * correção", `HoraDoFato.Calcular` no PDV): o desvio grande quer dizer que a hora foi corrigida, não que está errada,
 * e destacá-lo marcaria toda compensação do PC com o relógio do Windows fora (fica só na dica).
 */
export function motivosRelogioDoEvento(ev: RelogioDoEvento): MotivoRelogioCompensacao[] {
  const motivos = new Set<MotivoRelogioCompensacao>();
  if (ev.relogioConfiavel === false) motivos.add('nao_confiavel');
  for (const s of suspeitasDoRelogio(
    { ocorridoEm: ev.ocorridoEm, relogioRegrediu: ev.relogioRegrediu },
    { recebidoEm: ev.recebidoEm, ativadoEm: ev.ativadoEm, anterior: ev.anterior },
  )) {
    motivos.add(s.motivo);
  }
  if (
    ev.relogioConfiavel !== true &&
    ev.desvioMs !== null &&
    Math.abs(ev.desvioMs) > DESVIO_RELOGIO_CRITICO_MS
  )
    motivos.add('desvio');
  return MOTIVOS_RELOGIO_COMPENSACAO.filter((m) => motivos.has(m));
}

/** O documento de origem do movimento compensado, como a tela mostra. */
function rotuloDocumento(tipo: string, numeroVenda: string | null, codigoAcerto: number | null): string {
  switch (tipo) {
    case 'venda':
      return numeroVenda ? `Venda ${numeroVenda}` : 'Venda';
    case 'acerto':
      return codigoAcerto !== null ? `Acerto Nº ${codigoAcerto}` : 'Acerto';
    case 'vasilhame':
      return 'Devolução de cascos';
    case 'troca':
      return 'Troca';
    case 'recebimento':
      return 'Recebimento';
    case 'nota_entrada':
      return 'NF-e de entrada';
    case 'transferencia':
      return 'Transferência';
    default:
      return tipo;
  }
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);

/**
 * As compensações do acerto `acertoId` (as lançadas por ele e as recebidas de outro "Definir"), na ordem da hora do
 * fato, até `LIMITE_COMPENSACOES_DETALHE`, com o total. O custo só com `produtos.ver_custo`.
 */
export async function compensacoesDoAcerto(
  db: DbEmpresa,
  acertoId: string,
  verCusto: boolean,
): Promise<{ compensacoes: CompensacaoAcerto[]; total: number }> {
  const { rows } = await db.execute<{
    id: string;
    sentido: 'lancada' | 'recebida';
    total: number;
    acerto_id: string;
    acerto_codigo: number;
    produto_id: string;
    produto_codigo: number;
    produto_nome: string;
    variacao_id: string | null;
    lote_id: string | null;
    lote: string | null;
    quantidade: string;
    custo_unitario: string;
    data_movimento: Date;
    lancada_em: Date;
    o_id: string;
    o_tipo_movimento: string;
    o_tipo_movimento_nome: string | null;
    o_quantidade: string;
    o_documento_tipo: string;
    o_documento_id: string | null;
    o_numero_venda: string | null;
    o_codigo_acerto: number | null;
    terminal_id: string | null;
    numero_caixa: number | null;
    terminal_descricao: string | null;
    ativado_em: Date | null;
    evento_id: string | null;
    sequencia: string | null;
    ocorrido_em: Date | null;
    recebido_em: Date | null;
    envelope: Record<string, unknown> | null;
    anterior_sequencia: string | null;
    anterior_ocorrido_em: Date | null;
    estorno_id: string | null;
    estorno_em: Date | null;
    estorno_acerto_id: string | null;
    estorno_acerto_codigo: number | null;
    estorno_motivo: string | null;
    substituta_id: string | null;
    substituta_acerto_id: string | null;
    substituta_acerto_codigo: number | null;
  }>(sql`
    with ligadas as (
      select c.id, 'lancada'::text as sentido
        from movimentos_estoque c
       where c.documento_tipo = 'acerto' and c.documento_id = ${acertoId}::uuid
         and c.tipo_movimento = 'ACERTO_COMPENSACAO'
      union all
      select c.id, 'recebida'::text
        from movimentos_estoque o
        join movimentos_estoque c on c.compensa_movimento_id = o.id and c.tipo_movimento = 'ACERTO_COMPENSACAO'
       where o.documento_tipo = 'acerto' and o.documento_id = ${acertoId}::uuid
         -- Fora os estornos dos movimentos do próprio acerto (o ESTORNO_ACERTO e o par invertido da mudança de tipo);
         -- a saída da perda da transferência (F2-B24) estorna o retorno da transferência, não um movimento do acerto.
         and (o.estorno_de_id is null
              or not exists (select 1 from movimentos_estoque x
                              where x.id = o.estorno_de_id and x.documento_tipo = 'acerto' and x.documento_id = o.documento_id))
    ),
    escolhidas as (
      select l.id, l.sentido, count(*) over ()::int as total
        from ligadas l join movimentos_estoque c on c.id = l.id
       order by c.data_movimento, c.id
       limit ${LIMITE_COMPENSACOES_DETALHE}
    )
    select c.id, l.sentido, l.total, ac.id as acerto_id, ac.codigo as acerto_codigo,
           p.id as produto_id, p.codigo as produto_codigo, p.nome as produto_nome, c.variacao_id, c.lote_id,
           pl.lote, c.quantidade::text, c.custo_unitario::text, c.data_movimento, c.criado_em as lancada_em,
           o.id as o_id, o.tipo_movimento as o_tipo_movimento, tm.nome as o_tipo_movimento_nome,
           o.quantidade::text as o_quantidade, o.documento_tipo as o_documento_tipo, o.documento_id as o_documento_id,
           v.numero_exibicao as o_numero_venda, oa.codigo as o_codigo_acerto,
           o.terminal_id, cx.numero as numero_caixa, t.descricao as terminal_descricao, t.ativado_em,
           o.evento_id, er.sequencia_terminal::text as sequencia, er.ocorrido_em, er.criado_em as recebido_em,
           er.envelope, ant.sequencia_terminal::text as anterior_sequencia, ant.ocorrido_em as anterior_ocorrido_em,
           es.id as estorno_id, es.criado_em as estorno_em, es.documento_id as estorno_acerto_id,
           ea.codigo as estorno_acerto_codigo, es.observacao as estorno_motivo,
           sb.id as substituta_id, sb.documento_id as substituta_acerto_id, sa.codigo as substituta_acerto_codigo
      from escolhidas l
      join movimentos_estoque c on c.id = l.id
      join movimentos_estoque o on o.id = c.compensa_movimento_id
      join acertos_estoque ac on ac.id = c.documento_id
      join produtos p on p.id = c.produto_id
      left join produtos_lotes pl on pl.id = c.lote_id
      left join tipos_movimento_estoque tm on tm.codigo = o.tipo_movimento
      left join vendas v on o.documento_tipo = 'venda' and v.id = o.documento_id
      left join acertos_estoque oa on o.documento_tipo = 'acerto' and oa.id = o.documento_id
      left join terminais t on t.id = o.terminal_id
      left join caixas cx on cx.id = t.caixa_id
      left join eventos_recebidos er on er.evento_id = o.evento_id
      left join lateral (
        select a.sequencia_terminal, a.ocorrido_em from eventos_recebidos a
         where a.terminal_id = er.terminal_id and a.sequencia_terminal < er.sequencia_terminal
           and a.tipo <> ${TIPO_TERMINAL_LACUNA}
         order by a.sequencia_terminal desc limit 1) ant on true
      left join lateral (
        select e.id, e.criado_em, case when e.documento_tipo = 'acerto' then e.documento_id end as documento_id,
               e.observacao
          from movimentos_estoque e
         where e.estorno_de_id = c.id order by e.id limit 1) es on true
      left join acertos_estoque ea on ea.id = es.documento_id
      -- Estornada, o fato pode ter ganhado outra compensação, contra o outro "Definir" que também o contou (no estorno
      -- de um deles, em estornarAcerto): a viva (sem estorno) do mesmo movimento, só uma (garantia do motor, migração 0018).
      left join lateral (
        select s.id, s.documento_id from movimentos_estoque s
         where es.id is not null and s.compensa_movimento_id = c.compensa_movimento_id
           and s.tipo_movimento = 'ACERTO_COMPENSACAO' and s.id <> c.id
           and not exists (select 1 from movimentos_estoque se where se.estorno_de_id = s.id)
         order by s.id desc limit 1) sb on true
      left join acertos_estoque sa on sa.id = sb.documento_id
     order by c.data_movimento, c.id`);
  const compensacoes = rows.map((r): CompensacaoAcerto => {
    const env = r.envelope ?? {};
    const relogio =
      r.evento_id && r.ocorrido_em && r.recebido_em
        ? (() => {
            const confiavel = typeof env.relogio_confiavel === 'boolean' ? env.relogio_confiavel : null;
            const desvioMs = typeof env.desvio_relogio_ms === 'number' ? env.desvio_relogio_ms : null;
            const motivos = motivosRelogioDoEvento({
              ocorridoEm: new Date(r.ocorrido_em),
              recebidoEm: new Date(r.recebido_em),
              ativadoEm: r.ativado_em ? new Date(r.ativado_em) : null,
              anterior:
                r.anterior_sequencia !== null && r.anterior_ocorrido_em
                  ? { sequencia: Number(r.anterior_sequencia), ocorridoEm: new Date(r.anterior_ocorrido_em) }
                  : null,
              relogioConfiavel: confiavel,
              relogioRegrediu: env.relogio_regrediu === true,
              desvioMs,
            });
            return { confiavel, desvioMs, motivos };
          })()
        : null;
    return {
      id: r.id,
      sentido: r.sentido,
      acertoId: r.acerto_id,
      acertoCodigo: Number(r.acerto_codigo),
      produtoId: r.produto_id,
      produtoCodigo: Number(r.produto_codigo),
      produtoNome: r.produto_nome,
      variacaoId: r.variacao_id,
      loteId: r.lote_id,
      lote: r.lote,
      quantidade: decTexto(r.quantidade, 3),
      custoUnitario: verCusto ? decTexto(r.custo_unitario, 4) : null,
      dataFato: iso(r.data_movimento)!,
      lancadaEm: iso(r.lancada_em)!,
      compensado: {
        id: r.o_id,
        tipoMovimento: r.o_tipo_movimento,
        tipoMovimentoNome: r.o_tipo_movimento_nome ?? r.o_tipo_movimento,
        quantidade: decTexto(r.o_quantidade, 3),
        documentoTipo: r.o_documento_tipo,
        documentoId: r.o_documento_id,
        documento: rotuloDocumento(
          r.o_documento_tipo,
          r.o_numero_venda,
          r.o_codigo_acerto === null ? null : Number(r.o_codigo_acerto),
        ),
        terminalId: r.terminal_id,
        terminal: r.terminal_id
          ? [
              r.numero_caixa !== null ? `Caixa ${String(r.numero_caixa).padStart(2, '0')}` : 'Terminal',
              r.terminal_descricao,
            ]
              .filter(Boolean)
              .join(' · ')
          : null,
        eventoId: r.evento_id,
        sequencia: r.sequencia === null ? null : Number(r.sequencia),
        recebidoEm: iso(r.recebido_em),
      },
      relogio,
      relogioSuspeito: relogio ? relogioSuspeitoCompensacao(relogio.motivos) : false,
      estorno: r.estorno_id
        ? {
            id: r.estorno_id,
            em: iso(r.estorno_em)!,
            acertoId: r.estorno_acerto_id,
            acertoCodigo: r.estorno_acerto_codigo === null ? null : Number(r.estorno_acerto_codigo),
            motivo: r.estorno_motivo,
            substituidaPor:
              r.substituta_id && r.substituta_acerto_id
                ? {
                    id: r.substituta_id,
                    acertoId: r.substituta_acerto_id,
                    acertoCodigo: Number(r.substituta_acerto_codigo),
                  }
                : null,
          }
        : null,
    };
  });
  return { compensacoes, total: rows[0]?.total ?? 0 };
}
