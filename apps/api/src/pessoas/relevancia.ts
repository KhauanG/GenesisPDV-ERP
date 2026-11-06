/**
 * Manutenção de `pessoas_relevancia_loja` (MD 3.5.4; D19): quais pessoas descem para o espelho do PDV. A Fase 1B
 * mantém os motivos `funcionario` (categoria Funcionário ou vínculo `usuarios.pessoa_id`), `crediario` (`limite_compras
 * > 0` ou saldo em aberto em `saldos_credito_pessoas`) e `manual` (marcado no cadastro, "Manter no PDV"), todos com
 * `loja_id` nulo (relevantes em todas as lojas). O motivo `compra` entra com a aplicação da venda (1C,
 * `sync/handlers/vendas.ts`) e `delivery` com o pedido; a expiração diária deles (e do `crediario` que perdeu limite e
 * saldo) é `expirarRelevancias`, chamada pela tarefa `ExpiracaoRelevancia` (C14).
 *
 * Recalcula na transação do fato (CRUD de pessoas, que a importação do Nuvem3 também usa, e CRUD de usuários): cria a
 * linha que falta e exclui logicamente a que deixou de valer (`pessoa_id`, `loja_id` e `motivo` são imutáveis, MD 6.4
 * regra 2; a exclusão desce e o PDV purga a pessoa local). A pessoa que ganhou linha nova é tocada com as filhas
 * (`sync/toque.ts`), senão as linhas antigas dela ficariam abaixo do cursor dos terminais e nunca desceriam. As
 * pessoas gravadas antes desta manutenção ganharam as linhas pela migração 0009, com as mesmas regras em SQL: mudou
 * uma regra aqui, ela precisa de uma migração equivalente.
 */
import { CONFIGURACOES_POR_CHAVE } from '@genesis/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { pessoasRelevanciaLoja } from '../database/empresa/schema/index.js';
import { tocarPessoas } from '../sync/toque.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Motivos que a API mantém nesta fase (D19). */
export const MOTIVOS_MANTIDOS = ['funcionario', 'crediario', 'manual'] as const;
type Motivo = (typeof MOTIVOS_MANTIDOS)[number];

export interface OpcoesRelevancia {
  /** "Manter no PDV" informado no cadastro, por pessoa; ausente = mantém a marcação manual atual. */
  manual?: ReadonlyMap<string, boolean>;
}

/** Recalcula os motivos mantidos das pessoas informadas; devolve as que passaram a ter linha nova (e foram tocadas). */
export async function recalcularRelevancia(
  tx: DbEmpresa,
  pessoaIds: readonly string[],
  opcoes: OpcoesRelevancia = {},
): Promise<string[]> {
  const ids = [...new Set(pessoaIds)];
  if (!ids.length) return [];
  const { rows } = await tx.execute<{
    id: string;
    viva: boolean;
    funcionario: boolean;
    crediario: boolean;
  }>(sql`
    select p.id, p.excluido_em is null as viva,
      exists (select 1 from pessoas_categorias c
               where c.pessoa_id = p.id and c.categoria = 'funcionario' and c.excluido_em is null)
        or exists (select 1 from usuarios u where u.pessoa_id = p.id and u.excluido_em is null) as funcionario,
      coalesce(p.limite_compras, 0) > 0
        or exists (select 1 from saldos_credito_pessoas s
                    where s.pessoa_id = p.id and s.saldo_aberto > 0 and s.excluido_em is null) as crediario
    from pessoas p
    where p.id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  const atuais = await tx
    .select({
      id: pessoasRelevanciaLoja.id,
      pessoaId: pessoasRelevanciaLoja.pessoaId,
      motivo: pessoasRelevanciaLoja.motivo,
    })
    .from(pessoasRelevanciaLoja)
    .where(
      and(
        inArray(pessoasRelevanciaLoja.pessoaId, ids),
        isNull(pessoasRelevanciaLoja.lojaId),
        inArray(pessoasRelevanciaLoja.motivo, [...MOTIVOS_MANTIDOS]),
        isNull(pessoasRelevanciaLoja.excluidoEm),
      ),
    );
  const agora = new Date();
  const novas: Array<{ pessoaId: string; motivo: Motivo }> = [];
  const sairam: string[] = [];
  for (const p of rows) {
    const atuaisDaPessoa = atuais.filter((a) => a.pessoaId === p.id);
    const tem = (m: Motivo) => atuaisDaPessoa.some((a) => a.motivo === m);
    const manual = opcoes.manual?.get(p.id) ?? tem('manual');
    const desejado: Record<Motivo, boolean> = {
      funcionario: p.viva && p.funcionario,
      crediario: p.viva && p.crediario,
      manual: p.viva && manual,
    };
    for (const m of MOTIVOS_MANTIDOS) {
      if (desejado[m] && !tem(m)) novas.push({ pessoaId: p.id, motivo: m });
      if (!desejado[m]) sairam.push(...atuaisDaPessoa.filter((a) => a.motivo === m).map((a) => a.id));
    }
  }
  // Projeção sem autoria (MD 3.5.4): quem mudou fica na auditoria do cadastro que motivou a mudança.
  if (sairam.length) {
    await tx
      .update(pessoasRelevanciaLoja)
      .set({ excluidoEm: agora })
      .where(inArray(pessoasRelevanciaLoja.id, sairam));
  }
  if (novas.length) {
    await tx
      .insert(pessoasRelevanciaLoja)
      .values(novas.map((n) => ({ ...n, lojaId: null, ultimaOcorrenciaEm: agora })));
  }
  // Depois das linhas de relevância: a pessoa e as filhas ganham versão maior que a linha nova (o PDV aplica em ordem).
  const tocadas = [...new Set(novas.map((n) => n.pessoaId))];
  await tocarPessoas(tx, tocadas);
  return tocadas;
}

/** Marcação manual atual de uma pessoa (detalhe do cadastro). */
export async function manterNoPdv(db: DbEmpresa, pessoaId: string): Promise<boolean> {
  const [r] = await db
    .select({ id: pessoasRelevanciaLoja.id })
    .from(pessoasRelevanciaLoja)
    .where(
      and(
        eq(pessoasRelevanciaLoja.pessoaId, pessoaId),
        eq(pessoasRelevanciaLoja.motivo, 'manual'),
        isNull(pessoasRelevanciaLoja.excluidoEm),
      ),
    )
    .limit(1);
  return !!r;
}

/** Configuração dos meses sem compra/pedido na loja depois dos quais a pessoa deixa de descer (MD 3.5.4, LGPD). */
const MESES_RELEVANCIA = 'pdv.pessoas_meses_relevancia';

/** Linhas excluídas por transação da expiração: cada uma segura a trava de versão (MD 1.5) só por um lote. */
export const LOTE_EXPIRACAO_RELEVANCIA = 500;

/**
 * Antes da expiração (C14): a `compra`/`delivery` com `ultima_ocorrencia_em` no futuro (relógio adiantado do caixa
 * gravado antes do teto de `relevanciaCompra`) passa a valer `now()`, para o prazo de `pdv.pessoas_meses_relevancia`
 * contar de hoje, e não da data futura (o cliente ficaria no espelho dos caixas além do prazo da LGPD). Uma vez por
 * linha (depois ela deixa de estar no futuro); ganha versão e desce como qualquer alteração. Devolve quantas corrigiu.
 */
export async function corrigirRelevanciasFuturas(tx: DbEmpresa): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    update pessoas_relevancia_loja set ultima_ocorrencia_em = now()
     where excluido_em is null and motivo in ('compra', 'delivery') and ultima_ocorrencia_em > now()
    returning id`);
  return rows.length;
}

export interface ExpiradasRelevancia {
  compra: number;
  delivery: number;
  crediario: number;
}

/**
 * Expiração diária de `pessoas_relevancia_loja` (MD 3.5.4; C14): exclui logicamente, num lote de até `limite` linhas,
 * as `compra`/`delivery` com `ultima_ocorrencia_em` anterior a `pdv.pessoas_meses_relevancia` meses (loja da linha ??
 * empresa ?? 12) e as `crediario` cuja pessoa ficou sem limite próprio e sem saldo em aberto (a rede de segurança do
 * recálculo na transação do fato, que na Fase 4 é a baixa da parcela). A exclusão ganha versão (`fn_versao`) e desce
 * como tombstone no fluxo `pessoas`: o PDV purga a pessoa do espelho se ela não tiver outra linha ativa na loja nem
 * evento local pendente (`AplicadorPull`). Sem toque e sem auditoria (projeção, como `recalcularRelevancia`). A
 * transação precisa da trava de versão (`travaVersao`, MD 1.5). `skip locked`: a linha que uma venda está tocando
 * agora fica para o lote seguinte (ou para amanhã), sem esperar.
 */
export async function expirarRelevancias(
  tx: DbEmpresa,
  limite = LOTE_EXPIRACAO_RELEVANCIA,
): Promise<ExpiradasRelevancia> {
  const padrao = Number(CONFIGURACOES_POR_CHAVE.get(MESES_RELEVANCIA)?.padrao ?? 12);
  const { rows } = await tx.execute<{ motivo: keyof ExpiradasRelevancia }>(sql`
    with alvo as (
      select r.id from pessoas_relevancia_loja r
       where r.excluido_em is null
         and (
           (r.motivo in ('compra', 'delivery')
             and r.ultima_ocorrencia_em < now() - make_interval(months => coalesce(
               (select (c.valor #>> '{}')::int from configuracoes c
                 where c.chave = ${MESES_RELEVANCIA} and c.excluido_em is null
                   and c.escopo = 'loja' and c.loja_id = r.loja_id),
               (select (c.valor #>> '{}')::int from configuracoes c
                 where c.chave = ${MESES_RELEVANCIA} and c.excluido_em is null and c.escopo = 'empresa'),
               ${padrao})))
           or (r.motivo = 'crediario'
             and not exists (select 1 from pessoas p
                              where p.id = r.pessoa_id and coalesce(p.limite_compras, 0) > 0)
             and not exists (select 1 from saldos_credito_pessoas s
                              where s.pessoa_id = r.pessoa_id and s.saldo_aberto > 0 and s.excluido_em is null))
         )
       order by r.id
       limit ${limite}
       for update of r skip locked
    )
    update pessoas_relevancia_loja r set excluido_em = now()
      from alvo where r.id = alvo.id
    returning r.motivo`);
  const n = (m: keyof ExpiradasRelevancia) => rows.filter((r) => r.motivo === m).length;
  return { compra: n('compra'), delivery: n('delivery'), crediario: n('crediario') };
}
