import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  ALERTA_EVENTO_COM_ERRO,
  ALERTA_EVENTO_DESCARTADO,
  ALERTA_EVENTO_DIVERGENTE,
  ALERTA_LACUNA_DECLARADA,
  ALERTA_RELOGIO_DESVIO,
  ALERTA_TOKEN_ANTERIOR_REUTILIZADO,
  CONFIGURACOES_POR_CHAVE,
  dashboardQuerySchema,
  dec,
  decTexto,
  MAXIMO_ITENS_PAINEL_DASHBOARD,
  mesOperacionalEm,
  rotuloMes,
  statusConexao,
  type Dashboard,
} from '@genesis/shared';
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { Permissao } from '../autorizacao/decorators.js';
import { ErroApi } from '../comum/erros.js';
import { terminaisPdv } from '../database/controle/schema.js';
import { Sessao } from '../comum/requisicao.js';
import { SERVICOS } from '../comum/tokens-nest.js';
import { validar } from '../comum/zod.js';
import { estoqueVisivel } from '../estoques/permitidos.js';
import { ncmVigente } from '../produtos/ncm.js';
import type { Servicos } from '../servicos.js';
import { terminalDoAlerta } from '../terminais/fila-decisao.js';
import { ALERTA_EVENTOS_NAO_RESOLVIDOS, ALERTA_FORCA_BRUTA } from '../terminais/revogacao.js';
import { condicoesLoja, diaOperacionalAtual, lojaVisivel } from '../vendas/consultas.js';

const FUSO = 'America/Sao_Paulo';
const HORAS_ALERTA_SESSAO = 'pdv.horas_alerta_sessao';

/**
 * Tipos do painel mínimo de alertas críticos (C14; O11): só os que têm onde decidir, para onde cada linha leva (o
 * detalhe do terminal, ERP 12.4–12.5, ou a listagem, para a força bruta). Um tipo crítico novo entra aqui quando
 * ganhar a sua tela (o `RELOGIO_SUSPEITO` é só aviso, nunca crítico); o painel completo, com todos os tipos e o
 * "Ciente" no próprio painel, é da Fase 5.
 */
const TIPOS_ALERTA_PAINEL = [
  ALERTA_EVENTO_DESCARTADO,
  ALERTA_EVENTO_COM_ERRO,
  ALERTA_EVENTO_DIVERGENTE,
  ALERTA_LACUNA_DECLARADA,
  ALERTA_EVENTOS_NAO_RESOLVIDOS,
  ALERTA_TOKEN_ANTERIOR_REUTILIZADO,
  ALERTA_FORCA_BRUTA,
  // C16 (SYNC 12.4): o desvio do relógio acima de 5 min, no detalhe do terminal; fecha sozinho com o desvio normal.
  ALERTA_RELOGIO_DESVIO,
] as const;

const diasNoMes = (mes: string) => {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a!, m!, 0)).getUTCDate();
};

/**
 * Início – Dashboard (ERP 6): pessoas e produtos (com sem preço e NCM inválido), vendas do PDV (Fase 1C, C12) no mês,
 * por loja (dia e mês) e por dia, PDVs e estoque abaixo do mínimo; o financeiro vem com a Fase 4. As vendas contam
 * pelo **dia operacional** (D7) que o caixa gravou: só as finalizadas, e a cancelada abate (sai do total). A loja de
 * treino (O10) fica de fora por padrão, salvo escolhida no filtro. Cache de 60 s por empresa × loja × mês × treino ×
 * o que o usuário enxerga (ERP 6 "Regras").
 *
 * O mês padrão é o do **dia operacional da empresa** (fuso de Brasília e o corte da empresa, D7), não o do
 * calendário: em 01/11 às 02:00, com o corte das 05:00, o "hoje" das lojas ainda é 31/10 e o mês mostrado continua
 * outubro, com o turno da noite em andamento (antes o card do mês zerava enquanto a coluna do dia mostrava 31/10). A
 * loja com corte próprio pode ficar uma ou duas horas fora desse mês na virada; quem quiser outro mês o escolhe.
 *
 * As vendas contam também as lojas **inativas** (a loja desativada no dia 20 vendeu do dia 1 ao 19): a listagem de
 * Vendas, para onde o card leva, não olha `lojas.ativa`, e o total precisa bater com ela (ERP 15.4: "mesma regra do
 * Dashboard"). A loja inativa só aparece na tabela por loja quando tem venda no mês ou no dia; o estoque abaixo do
 * mínimo e os PDVs continuam só com as lojas ativas.
 *
 * Fase 1C (C14; O11): o painel mínimo de **alertas críticos** abertos (com `terminais.ver`) dos tipos de
 * `TIPOS_ALERTA_PAINEL`, todos do PDV e dos terminais e com o terminal para o link (`terminalDoAlerta`), das lojas
 * filtradas e os sem loja (força bruta na ativação), e as **sessões de caixa abertas há mais de
 * `pdv.horas_alerta_sessao`** (com `fechamentos_caixa.ver`; ERP 14.9). Os dois seguem a loja do filtro com a de treino
 * junto, como os PDVs, e trazem o total mais os 10 primeiros.
 */
@Controller('dashboard')
export class DashboardController {
  private readonly cache = new Map<string, { valor: Dashboard; expira: number }>();

  constructor(@Inject(SERVICOS) private readonly s: Servicos) {}

  @Permissao('dashboard.ver')
  @Get()
  async obter(@Query() query: unknown, @Sessao() sessao: SessaoErp): Promise<Dashboard> {
    const q = validar(dashboardQuerySchema, query);
    if (q.lojaId && sessao.lojas !== null && !sessao.lojas.includes(q.lojaId))
      throw ErroApi.semPermissao('A loja está fora das suas lojas permitidas.');
    const mes = q.mes ?? (await this.mesOperacional());
    const verFinanceiro = sessao.permissoes.has('dashboard.ver_financeiro');
    const verPdvs = sessao.permissoes.has('terminais.ver');
    const verEstoque = sessao.permissoes.has('estoque_saldos.ver');
    const verSessoes = sessao.permissoes.has('fechamentos_caixa.ver');
    const chave = [
      sessao.empresa.empresaId,
      q.lojaId ?? '*',
      mes,
      q.treino,
      sessao.lojas === null ? '*' : [...sessao.lojas].sort().join(','),
      sessao.estoques === null ? '*' : [...sessao.estoques].sort().join(','),
      verFinanceiro,
      verPdvs,
      verEstoque,
      verSessoes,
    ].join('|');
    const agora = Date.now();
    const emCache = this.cache.get(chave);
    const validade = this.s.config.dashboardCacheMs;
    if (validade > 0 && emCache && emCache.expira > agora) return emCache.valor;

    const lojasFiltro: SQL[] = [sql`l.excluido_em is null`, sql`l.ativa`];
    // Os PDVs seguem a loja do filtro com a de treino junto (o terminal dela também precisa de acompanhamento); as
    // vendas e o estoque abaixo do mínimo deixam a loja de treino de fora, salvo escolhida (O10). As vendas contam a
    // loja inativa (`ondeLojasVendas`, como a listagem de Vendas); o estoque e os PDVs, só as ativas.
    if (q.lojaId) lojasFiltro.push(sql`l.id = ${q.lojaId}`);
    if (sessao.lojas !== null) lojasFiltro.push(sql`l.id = any(${`{${sessao.lojas.join(',')}}`}::uuid[])`);
    const ondeLojas = sql.join(lojasFiltro, sql` and `);
    const ondeLojasVendas = sql.join([sql`l.excluido_em is null`, ...condicoesLoja(sessao, q)], sql` and `);
    const ondeLojasReais = sql`${ondeLojasVendas} and l.ativa`;
    // Estoque abaixo do mínimo: além da loja, o estoque dela tem de estar entre os permitidos (decisão 149).
    const estoqueBaixoVisivel = estoqueVisivel(sessao, sql`l.estoque_id`) ?? sql`true`;
    const diaMes = sql`(${`${mes}-01`}::date)`;
    const anterior = sql`(${diaMes} - interval '1 month')::date`;
    const inicio = sql`(${`${mes}-01`}::date)::timestamp at time zone ${FUSO}`;
    const fim = sql`((${`${mes}-01`}::date + interval '1 month')::timestamp) at time zone ${FUSO}`;
    // Alertas: os da loja do filtro (ou das permitidas) e os da empresa, sem loja.
    const alertasFiltro: SQL[] = [];
    if (q.lojaId) alertasFiltro.push(sql`(a.loja_id is null or a.loja_id = ${q.lojaId})`);
    const alertaVisivel = lojaVisivel(sessao, sql`a.loja_id`);
    if (alertaVisivel) alertasFiltro.push(sql`(a.loja_id is null or ${alertaVisivel})`);
    const ondeAlertas = sql.join(
      [
        sql`a.severidade = 'critico'`,
        sql`a.tipo = any(${`{${TIPOS_ALERTA_PAINEL.join(',')}}`}::text[])`,
        sql`a.resolvido_em is null`,
        sql`a.excluido_em is null`,
        ...alertasFiltro,
      ],
      sql` and `,
    );

    const valor = await this.s.tenancy.cx().consulta(async (db) => {
      const [
        pessoas,
        produtos,
        lojas,
        porDia,
        pdvs,
        estoque,
        alertasRecentes,
        alertasPorTipo,
        sessoesAntigas,
      ] = await Promise.all([
        db.execute<{ ativas: number; novas: number }>(sql`
          select count(*) filter (where ativa)::int as ativas,
                 count(*) filter (where criado_em >= ${inicio} and criado_em < ${fim})::int as novas
            from pessoas where excluido_em is null`),
        db.execute<{ ativos: number; sem_preco: number; ncm_invalido: number }>(sql`
          select count(*)::int as ativos,
                 count(*) filter (where tipo <> 'materia_prima' and preco_venda <= 0)::int as sem_preco,
                 count(*) filter (where tipo not in ('kit', 'servico')
                                    and (ncm is null or not ${ncmVigente(sql`p.ncm`)}))::int as ncm_invalido
            from produtos p where excluido_em is null and ativo`),
        // Vendas por loja: as finalizadas do mês e do dia operacional corrente de cada loja (fuso e corte dela).
        db.execute<{
          id: string;
          codigo: number;
          nome: string;
          treino: boolean;
          total_mes: string;
          qtd_mes: number;
          total_dia: string;
          qtd_dia: number;
        }>(sql`
          select l.id, l.codigo, l.nome, l.treino,
                 coalesce(sum(v.total) filter (where v.dia_operacional >= ${diaMes}
                                                 and v.dia_operacional < (${diaMes} + interval '1 month')::date), 0)::numeric(15, 2)::text as total_mes,
                 count(v.id) filter (where v.dia_operacional >= ${diaMes}
                                       and v.dia_operacional < (${diaMes} + interval '1 month')::date)::int as qtd_mes,
                 coalesce(sum(v.total) filter (where v.dia_operacional = h.hoje), 0)::numeric(15, 2)::text as total_dia,
                 count(v.id) filter (where v.dia_operacional = h.hoje)::int as qtd_dia
            from lojas l
            cross join lateral (select ${diaOperacionalAtual} as hoje) h
            left join vendas v on v.loja_id = l.id and v.status = 'finalizada'
                              and ((v.dia_operacional >= ${diaMes} and v.dia_operacional < (${diaMes} + interval '1 month')::date)
                                   or v.dia_operacional = h.hoje)
           where ${ondeLojasVendas}
           group by l.id, l.codigo, l.nome, l.treino, l.ativa
          having l.ativa or count(v.id) > 0
           order by l.codigo`),
        db.execute<{ dia: number; total: string; anterior: string }>(sql`
          select extract(day from v.dia_operacional)::int as dia,
                 coalesce(sum(v.total) filter (where v.dia_operacional >= ${diaMes}), 0)::numeric(15, 2)::text as total,
                 coalesce(sum(v.total) filter (where v.dia_operacional < ${diaMes}), 0)::numeric(15, 2)::text as anterior
            from vendas v join lojas l on l.id = v.loja_id
           where v.status = 'finalizada' and ${ondeLojasVendas}
             and v.dia_operacional >= ${anterior} and v.dia_operacional < (${diaMes} + interval '1 month')::date
           group by 1`),
        verPdvs
          ? db.execute<{ id: string; ultimo_contato_em: Date | null; pendencias: boolean }>(sql`
              select t.id, t.ultimo_contato_em,
                     (t.eventos_pendentes > 0 or t.nfce_contingencia_pendentes > 0) as pendencias
                from terminais t join lojas l on l.id = t.loja_id
               where t.status = 'ativo' and t.excluido_em is null and ${ondeLojas}`)
          : null,
        verEstoque
          ? db.execute<{
              produto_id: string;
              produto_nome: string;
              loja_nome: string;
              q: string;
              minimo: string;
            }>(sql`
              select p.id as produto_id, p.nome as produto_nome, l.nome as loja_nome,
                     coalesce(sum(s.quantidade), 0)::text as q, pl.estoque_minimo::text as minimo
                from produtos_lojas pl
                join produtos p on p.id = pl.produto_id and p.excluido_em is null and p.ativo and p.controla_estoque
                join lojas l on l.id = pl.loja_id
                left join saldos_estoque s on s.produto_id = p.id and s.estoque_id = l.estoque_id
                left join tipos_estoque t on t.id = s.tipo_estoque_id
               where pl.excluido_em is null and pl.estoque_minimo > 0 and ${ondeLojasReais}
                 and (t.id is null or t.vendavel) and ${estoqueBaixoVisivel}
               group by p.id, p.nome, l.nome, l.codigo, pl.estoque_minimo
              having coalesce(sum(s.quantidade), 0) < pl.estoque_minimo
               order by coalesce(sum(s.quantidade), 0) - pl.estoque_minimo, p.nome
               limit 10`)
          : null,
        verPdvs
          ? db.execute<{
              id: string;
              tipo: string;
              titulo: string;
              mensagem: string | null;
              loja_nome: string | null;
              terminal_id: string | null;
              criado_em: Date | string;
            }>(sql`
              select a.id, a.tipo, a.titulo, a.mensagem, l.nome as loja_nome, a.criado_em,
                     ${terminalDoAlerta({ entidade: sql`a.entidade`, registroId: sql`a.registro_id`, dados: sql`a.dados` })} as terminal_id
                from alertas a left join lojas l on l.id = a.loja_id
               where ${ondeAlertas}
               order by a.criado_em desc, a.id desc
               limit ${MAXIMO_ITENS_PAINEL_DASHBOARD}`)
          : null,
        verPdvs
          ? db.execute<{ tipo: string; quantidade: number }>(sql`
              select a.tipo, count(*)::int as quantidade from alertas a
               where ${ondeAlertas}
               group by a.tipo order by count(*) desc, a.tipo`)
          : null,
        verSessoes
          ? db.execute<{
              id: string;
              loja_nome: string;
              numero_caixa: number;
              operador_nome: string | null;
              aberta_em: Date | string;
              horas: number;
              total: number;
            }>(sql`
              select s.id, l.nome as loja_nome, s.numero_caixa, u.nome as operador_nome, s.aberta_em,
                     floor(extract(epoch from now() - s.aberta_em) / 3600)::int as horas,
                     count(*) over ()::int as total
                from sessoes_caixa s
                join lojas l on l.id = s.loja_id
                left join usuarios u on u.id = s.operador_id
               where s.status <> 'fechada' and s.excluido_em is null and ${ondeLojas}
                 and s.aberta_em < now() - make_interval(hours => coalesce(
                   (select (c.valor #>> '{}')::int from configuracoes c
                     where c.chave = ${HORAS_ALERTA_SESSAO} and c.excluido_em is null
                       and c.escopo = 'loja' and c.loja_id = l.id),
                   (select (c.valor #>> '{}')::int from configuracoes c
                     where c.chave = ${HORAS_ALERTA_SESSAO} and c.excluido_em is null and c.escopo = 'empresa'),
                   ${Number(CONFIGURACOES_POR_CHAVE.get(HORAS_ALERTA_SESSAO)?.padrao ?? 24)}))
               order by s.aberta_em, s.id
               limit ${MAXIMO_ITENS_PAINEL_DASHBOARD}`)
          : null,
      ]);
      const zero = '0.00';
      const totalMes = lojas.rows.reduce((t, l) => t.plus(dec(l.total_mes)), dec(0));
      const quantidadeMes = lojas.rows.reduce((t, l) => t + l.qtd_mes, 0);
      // O mês anterior soma no mesmo dia do mês (o dia 31 de um mês de 30 fica sem a comparação).
      const dias = new Map(porDia.rows.map((d) => [d.dia, d]));
      const resultado: Dashboard = {
        mes,
        rotuloMes: rotuloMes(mes),
        lojaId: q.lojaId ?? null,
        geradoEm: new Date().toISOString(),
        pessoas: { ativas: pessoas.rows[0]!.ativas, novasNoMes: pessoas.rows[0]!.novas },
        produtos: {
          ativos: produtos.rows[0]!.ativos,
          semPreco: produtos.rows[0]!.sem_preco,
          ncmInvalido: produtos.rows[0]!.ncm_invalido,
        },
        vendas: {
          total: decTexto(totalMes, 2),
          quantidade: quantidadeMes,
          ticketMedio: quantidadeMes > 0 ? decTexto(totalMes.div(quantidadeMes), 2) : zero,
          porLoja: lojas.rows.map((l) => ({
            lojaId: l.id,
            lojaCodigo: l.codigo,
            lojaNome: l.nome,
            lojaTreino: l.treino,
            totalDia: l.total_dia,
            quantidadeDia: l.qtd_dia,
            totalMes: l.total_mes,
            quantidadeMes: l.qtd_mes,
          })),
        },
        vendasPorDia: Array.from({ length: diasNoMes(mes) }, (_, i) => ({
          dia: i + 1,
          total: dias.get(i + 1)?.total ?? zero,
          mesAnterior: dias.get(i + 1)?.anterior ?? zero,
        })),
        financeiro: verFinanceiro
          ? {
              receber: { total: zero, recebido: zero, emAberto: zero, atrasado: zero },
              pagar: { total: zero, pago: zero, emAberto: zero, atrasado: zero },
            }
          : null,
        pdvs: pdvs ? await this.contarPdvs(pdvs.rows) : null,
        alertasCriticos:
          alertasRecentes && alertasPorTipo
            ? {
                total: alertasPorTipo.rows.reduce((t, r) => t + r.quantidade, 0),
                porTipo: alertasPorTipo.rows.map((r) => ({ tipo: r.tipo, quantidade: r.quantidade })),
                recentes: alertasRecentes.rows.map((a) => ({
                  id: a.id,
                  tipo: a.tipo,
                  titulo: a.titulo,
                  mensagem: a.mensagem,
                  lojaNome: a.loja_nome,
                  terminalId: a.terminal_id,
                  criadoEm: new Date(a.criado_em).toISOString(),
                })),
              }
            : null,
        sessoesAntigas: sessoesAntigas
          ? {
              total: sessoesAntigas.rows[0]?.total ?? 0,
              recentes: sessoesAntigas.rows.map((r) => ({
                sessaoId: r.id,
                lojaNome: r.loja_nome,
                numeroCaixa: r.numero_caixa,
                operadorNome: r.operador_nome,
                abertaEm: new Date(r.aberta_em).toISOString(),
                horas: r.horas,
              })),
            }
          : null,
        estoqueBaixo: estoque
          ? estoque.rows.map((r) => ({
              produtoId: r.produto_id,
              produtoNome: r.produto_nome,
              lojaNome: r.loja_nome,
              quantidade: r.q,
              estoqueMinimo: r.minimo,
            }))
          : null,
      };
      return resultado;
    });
    if (validade > 0) {
      while (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(chave, { valor, expira: agora + validade });
    }
    return valor;
  }

  /**
   * Mês padrão (`AAAA-MM`): o do dia operacional de agora com o corte da empresa (`geral.dia_operacional_hora_corte`
   * no escopo empresa, ou o padrão 05:00, D7) no fuso de Brasília, a mesma conta de `diaOperacionalAtual`.
   */
  private async mesOperacional(): Promise<string> {
    const chave = 'geral.dia_operacional_hora_corte';
    const { rows } = await this.s.tenancy.cx().consulta((db) =>
      db.execute<{ corte: string | null }>(sql`
        select c.valor #>> '{}' as corte from configuracoes c
         where c.chave = ${chave} and c.escopo = 'empresa' and c.excluido_em is null limit 1`),
    );
    const corte = rows[0]?.corte ?? String(CONFIGURACOES_POR_CHAVE.get(chave)?.padrao ?? '00:00');
    return mesOperacionalEm(new Date(), corte, FUSO);
  }

  /**
   * Card PDVs (ERP 6): online pelo mesmo `statusConexao` e o mesmo "último contato" da tela de Terminais (o mais
   * recente entre `terminais_pdv`, qualquer chamada `/sync/*`, e `terminais`, o heartbeat). "Com pendências" segue o
   * ERP 6 (eventos pendentes ou NFC-e em contingência no último heartbeat), não o badge da listagem, que só aparece
   * depois de 1 h sem contato (ERP 12.1).
   */
  private async contarPdvs(
    linhas: Array<{ id: string; ultimo_contato_em: Date | string | null; pendencias: boolean }>,
  ): Promise<NonNullable<Dashboard['pdvs']>> {
    const doControle = linhas.length
      ? await this.s.controle.db
          .select({ id: terminaisPdv.id, ultimoContatoEm: terminaisPdv.ultimoContatoEm })
          .from(terminaisPdv)
          .where(
            inArray(
              terminaisPdv.id,
              linhas.map((l) => l.id),
            ),
          )
      : [];
    const contatoControle = new Map(doControle.map((t) => [t.id, t.ultimoContatoEm]));
    const agora = Date.now();
    const instante = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : 0);
    let online = 0;
    for (const l of linhas) {
      const ultimo = Math.max(instante(l.ultimo_contato_em), instante(contatoControle.get(l.id)));
      if (statusConexao(ultimo ? new Date(ultimo) : null, agora) === 'online') online++;
    }
    return {
      total: linhas.length,
      online,
      offline: linhas.length - online,
      comPendencias: linhas.filter((l) => l.pendencias).length,
    };
  }
}
