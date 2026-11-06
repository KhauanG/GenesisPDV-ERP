/**
 * Alerta da transferência parada (ERP 13.7; MD 3.1.8; Fase 2, F2-B26; README da API › decisão 174): a transferência
 * **em trânsito** há mais de `estoque.transferencia_alerta_dias` (padrão 3) desde o envio, ou **recebida com
 * divergência** e com item ainda sem tratamento há mais desses dias desde o recebimento, abre o alerta
 * `TRANSFERENCIA_PARADA` (aviso), um aberto por transferência e situação (`transferencia_parada:<id>:<situação>`), com
 * os dias, as pontas e as quantidades em `dados`; o aberto é atualizado a cada execução (os dias crescem). Fecha sozinho
 * quando a transferência sai da situação: na própria transação do receber, do tratar e do cancelar
 * (`resolverAlertasTransferencia`) e, por garantia, na varredura seguinte; a varredura fecha também o aberto que ficou
 * dentro do prazo porque a chave aumentou (`resolverAlertasDentroDoPrazo`).
 *
 * A varredura (`AlertaTransferencias`) roda a cada hora pelo `schedule` do pg-boss (um job por ocorrência, mesmo com
 * várias instâncias), em cada empresa ativa ou suspensa (em manutenção ou migrando fica para a próxima), uma execução
 * por vez (trava consultiva de sessão no controle); uma empresa com erro não impede as outras e faz o job falhar no fim
 * (`trabalhoPorEmpresas`, `infra/fila.ts`). Só lê as transferências e grava em `alertas` (que não descem ao PDV).
 */
import {
  ALERTA_TRANSFERENCIA_PARADA,
  CHAVE_TRANSFERENCIA_ALERTA_DIAS,
  TRANSFERENCIA_ALERTA_DIAS_PADRAO,
} from '@genesis/shared';
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { fusoDaEmpresa } from '../comum/fuso.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import type { BancoControle } from '../database/controle/conexao.js';
import { empresas } from '../database/controle/schema.js';
import type { ResolvedorEmpresas } from '../tenancy/resolvedor.js';
import type { DbEmpresa, Tenancy } from '../tenancy/tenancy.js';

/** A cada hora, no minuto 23 (fora do minuto 0 das outras recorrências). */
export const CRON_ALERTA_TRANSFERENCIAS = '23 * * * *';

/** A chave do alerta aberto da transferência na situação (`uq_alertas_chave_deduplicacao`). */
export const chaveAlertaTransferencia = (id: string, situacao: 'em_transito' | 'recebida_divergencia') =>
  `transferencia_parada:${id.toLowerCase()}:${situacao}`;

export interface ResultadoAlertasTransferencia {
  /** Alertas abertos agora ou mantidos (atualizados) nesta execução. */
  abertos: number;
  /** Alertas fechados porque a transferência saiu da situação (ou foi excluída) ou voltou para dentro do prazo. */
  resolvidos: number;
}

/**
 * Fecha os alertas abertos da transferência (ou de todas, sem `transferenciaId`) que já saiu da situação do alerta:
 * recebida, divergência tratada, cancelada ou excluída. Na transação de quem mudou a situação, depois do `update`.
 */
export async function resolverAlertasTransferencia(tx: DbEmpresa, transferenciaId?: string): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    update alertas a
       set resolvido_em = now(),
           resolucao = case when t.excluido_em is not null then 'Transferência excluída'
                            when t.status = 'cancelada' then 'Transferência cancelada'
                            when t.status = 'recebida' and a.dados->>'situacao' = 'em_transito' then 'Transferência recebida'
                            when t.status = 'recebida_divergencia' then 'Transferência recebida com divergência'
                            else 'Diferença tratada' end
      from transferencias_estoque t
     where a.tipo = ${ALERTA_TRANSFERENCIA_PARADA} and a.resolvido_em is null and a.excluido_em is null
       and a.registro_id = t.id
       and (t.excluido_em is not null or t.status is distinct from a.dados->>'situacao')
       ${transferenciaId ? sql`and t.id = ${transferenciaId}::uuid` : sql``}
    returning a.id`);
  return rows.length;
}

/**
 * Fecha os alertas abertos cuja transferência continua na situação mas já não passou do prazo atual: a chave
 * `estoque.transferencia_alerta_dias` aumentou depois que o alerta abriu. Sem isso o aberto ficaria congelado (a
 * varredura só atualiza o que passou do prazo) com os dias e o prazo antigos; volta a abrir quando o prazo novo vencer.
 */
async function resolverAlertasDentroDoPrazo(tx: DbEmpresa, dias: number): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    update alertas a
       set resolvido_em = now(), resolucao = 'Prazo do alerta alterado'
      from transferencias_estoque t
     where a.tipo = ${ALERTA_TRANSFERENCIA_PARADA} and a.resolvido_em is null and a.excluido_em is null
       and a.registro_id = t.id and t.excluido_em is null and t.status = a.dados->>'situacao'
       and case when t.status = 'em_transito' then t.enviada_em else t.recebida_em end
           >= now() - make_interval(days => ${dias})
    returning a.id`);
  return rows.length;
}

/**
 * Abre (ou atualiza) o alerta de cada transferência parada além do prazo da chave e fecha os que se resolveram. Uma
 * transação curta por empresa; o prazo e as datas pelo relógio do banco (`now()`).
 */
export async function registrarAlertasTransferencias(tx: DbEmpresa): Promise<ResultadoAlertasTransferencia> {
  const dias =
    (await lerConfiguracao<number | null>(tx, CHAVE_TRANSFERENCIA_ALERTA_DIAS)) ??
    TRANSFERENCIA_ALERTA_DIAS_PADRAO;
  const resolvidos =
    (await resolverAlertasTransferencia(tx)) + (await resolverAlertasDentroDoPrazo(tx, dias));
  // Em trânsito: desde o envio, na loja do destino (quem tem de receber). Divergência: desde o recebimento, com item
  // ainda sem tratamento, na loja da origem (onde o tratamento lança). A loja de um estoque é a de menor código
  // (`lojaDoEstoque`), nula no CD. `Nº`, nomes e quantidades no título, na mensagem e em `dados`; a data da mensagem
  // no fuso da loja do alerta e, no CD, no da empresa (ERP 1.5).
  // `for share of t skip locked`: a transferência que um receber, tratar ou cancelar está mudando agora (eles a leem
  // com `for update`) fica para a próxima varredura, e a que mudou depois da foto deste comando é relida (o Postgres
  // reavalia o `where` na versão nova). Sem a trava, a varredura podia reabrir o alerta que o recebimento acabou de
  // fechar: o índice parcial da chave não acha mais o aberto e o `insert` grava outro.
  const { rows } = await tx.execute<{ id: string }>(sql`
    with paradas as (
      select t.id, t.codigo, t.status as situacao, t.estoque_origem_id, t.estoque_destino_id, t.tipo_estoque_id,
             eo.nome as origem_nome, ed.nome as destino_nome,
             case when t.status = 'em_transito' then t.enviada_em else t.recebida_em end as desde,
             (select l.id from lojas l
               where l.estoque_id = case when t.status = 'em_transito' then t.estoque_destino_id
                                         else t.estoque_origem_id end
                 and l.excluido_em is null
               order by l.codigo limit 1) as loja_id,
             (select count(*)::int from itens_transferencia i
               where i.transferencia_id = t.id and i.excluido_em is null
                 and (t.status = 'em_transito' or (i.tratamento_divergencia is null and i.diferenca > 0))) as itens,
             (select coalesce(sum(case when t.status = 'em_transito' then i.quantidade_enviada else i.diferenca end), 0)
                from itens_transferencia i
               where i.transferencia_id = t.id and i.excluido_em is null
                 and (t.status = 'em_transito' or (i.tratamento_divergencia is null and i.diferenca > 0))) as quantidade
        from transferencias_estoque t
        join estoques eo on eo.id = t.estoque_origem_id
        join estoques ed on ed.id = t.estoque_destino_id
       where t.excluido_em is null
         and ((t.status = 'em_transito' and t.enviada_em < now() - make_interval(days => ${dias}))
           or (t.status = 'recebida_divergencia' and t.recebida_em < now() - make_interval(days => ${dias})))
         for share of t skip locked
    ),
    contadas as (
      select p.*, floor(extract(epoch from now() - p.desde) / 86400)::int as dias_parada,
             to_char(p.desde at time zone coalesce((select l.fuso_horario from lojas l where l.id = p.loja_id),
                                                   ${fusoDaEmpresa}), 'DD/MM/YYYY') as desde_texto
        from paradas p
       where p.itens > 0
    )
    insert into alertas (tipo, severidade, titulo, mensagem, loja_id, entidade, registro_id, dados, chave_deduplicacao)
    select ${ALERTA_TRANSFERENCIA_PARADA}, 'aviso',
           left(case when c.situacao = 'em_transito'
                     then 'Transferência Nº ' || c.codigo || ' em trânsito há ' || c.dias_parada
                     else 'Transferência Nº ' || c.codigo || ' com divergência a tratar há ' || c.dias_parada end
                || case when c.dias_parada = 1 then ' dia' else ' dias' end, 150),
           case when c.situacao = 'em_transito'
                then 'Enviada de ' || c.origem_nome || ' para ' || c.destino_nome || ' em ' || c.desde_texto
                     || ' e ainda não recebida (' || c.itens || ' item(ns)). Receba no destino ou cancele o envio: '
                     || 'enquanto isso a mercadoria não está em nenhum estoque.'
                else 'Recebida em ' || c.destino_nome || ' em ' || c.desde_texto || ' com ' || c.itens
                     || ' item(ns) a menor ainda sem tratamento. Trate a diferença (retornar à origem, '
                     || c.origem_nome || ', ou baixar como perda).' end,
           c.loja_id, 'transferencias_estoque', c.id,
           jsonb_build_object(
             'situacao', c.situacao, 'codigo', c.codigo, 'dias', c.dias_parada, 'prazo_dias', ${dias}::int,
             'desde', c.desde, 'estoque_origem_id', c.estoque_origem_id, 'estoque_destino_id', c.estoque_destino_id,
             'tipo_estoque_id', c.tipo_estoque_id, 'itens', c.itens, 'quantidade', c.quantidade::text),
           'transferencia_parada:' || c.id || ':' || c.situacao
      from contadas c
    on conflict (chave_deduplicacao) where resolvido_em is null and excluido_em is null
    do update set titulo = excluded.titulo, mensagem = excluded.mensagem, loja_id = excluded.loja_id,
                  dados = excluded.dados
    returning id`);
  return { abertos: rows.length, resolvidos };
}

export interface ResumoAlertaTransferencias extends ResultadoAlertasTransferencia {
  executada: boolean;
  empresas: number;
  falhas: Array<{ empresaId: string; erro: string }>;
}

export class AlertaTransferencias {
  constructor(
    private readonly controle: BancoControle,
    private readonly resolvedor: ResolvedorEmpresas,
    private readonly tenancy: Tenancy,
  ) {}

  async executar(): Promise<ResumoAlertaTransferencias> {
    const resumo: ResumoAlertaTransferencias = {
      executada: false,
      empresas: 0,
      abertos: 0,
      resolvidos: 0,
      falhas: [],
    };
    const trava = await this.controle.pool.connect();
    try {
      const { rows } = await trava.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('genesis:alerta_transferencias')) as ok",
      );
      if (!rows[0]?.ok) return resumo;
      try {
        resumo.executada = true;
        await this.executarEmpresas(resumo);
      } finally {
        await trava.query("select pg_advisory_unlock(hashtext('genesis:alerta_transferencias'))");
      }
    } finally {
      trava.release();
    }
    return resumo;
  }

  private async executarEmpresas(resumo: ResumoAlertaTransferencias): Promise<void> {
    const lista = await this.controle.db
      .select({ id: empresas.id })
      .from(empresas)
      .where(and(inArray(empresas.status, ['ativa', 'suspensa']), isNull(empresas.excluidoEm)));
    for (const { id } of lista) {
      try {
        const empresa = await this.resolvedor.porId(id);
        if (!empresa || empresa.excluida || empresa.emManutencao || empresa.status === 'migrando') continue;
        await this.tenancy.executarNaEmpresa(this.resolvedor.contexto(empresa), async () => {
          const r = await this.tenancy.cx().transacao((tx) => registrarAlertasTransferencias(tx));
          resumo.abertos += r.abertos;
          resumo.resolvidos += r.resolvidos;
        });
        resumo.empresas++;
      } catch (e) {
        resumo.falhas.push({ empresaId: id, erro: (e as Error).message });
      }
    }
  }
}
