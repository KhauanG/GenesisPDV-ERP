/**
 * A projeção `vendas_status_pdv` (MD 3.11.9; SYNC 16.3; F3-B10, README da API › decisão 228): o estado da venda do
 * caixa alterada **fora** do terminal que a criou (cancelamento pelo ERP, F3-B11; troca registrada em outro caixa,
 * F3-B43; status fiscal resolvido pela nuvem, 3F), gravado na mesma transação da mudança. Desce no fluxo `operacao`
 * pelo **caixa** da venda (`fluxos.ts`), e no caixa as colunas da projeção prevalecem sobre a `vendas` local.
 *
 * Regras (`acaoStatusPdv`):
 * - venda sem terminal (a do ERP, no caixa 0) não tem caixa que a leia: nada;
 * - a mudança da nuvem (`'nuvem'`) ou de outro terminal grava a linha (upsert pelo `id` da venda; `caixa_id` e
 *   `terminal_id` só no `INSERT`, imutáveis, `tg_vendas_status_pdv_filtro_imutavel`);
 * - a mudança do próprio terminal da venda não cria a linha (o caixa já sabe), mas atualiza a que já existe: senão a
 *   linha antiga, que prevalece no caixa, contradiria o que ele acabou de fazer (o ERP resolveu o fiscal e, depois, o
 *   caixa cancelou).
 *
 * A gravação passa pelo `fn_versao` (a trava 7300001): chame **depois** das outras escritas da transação, com a linha
 * da venda já travada (`for update`), para a trava ficar presa o menor tempo possível (Padrões da Fase 3). O UPDATE
 * sem mudança real não gera versão (`fn_versao`).
 */
import { eq, sql } from 'drizzle-orm';
import { vendas, vendasStatusPdv } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

/** Quem mudou a venda: a nuvem (ERP, tarefa) ou um terminal (o evento dele). */
export type OrigemMudancaVenda = 'nuvem' | { terminalId: string };

/** O que fazer com a projeção. Função pura (`status-pdv.spec.ts`). */
export function acaoStatusPdv(
  terminalDaVenda: string | null,
  origem: OrigemMudancaVenda,
): 'gravar' | 'atualizar_existente' | 'nada' {
  if (!terminalDaVenda) return 'nada';
  if (origem !== 'nuvem' && origem.terminalId.toLowerCase() === terminalDaVenda.toLowerCase())
    return 'atualizar_existente';
  return 'gravar';
}

/**
 * Grava (ou mantém em dia) a linha da projeção com o estado **atual** da venda, lido na transação. Devolve se a linha
 * foi escrita. A venda tem de existir.
 */
export async function registrarStatusPdv(
  tx: DbEmpresa,
  vendaId: string,
  origem: OrigemMudancaVenda,
): Promise<boolean> {
  const [v] = await tx
    .select({
      id: vendas.id,
      caixaId: vendas.caixaId,
      terminalId: vendas.terminalId,
      status: vendas.status,
      statusFiscal: vendas.statusFiscal,
      devolucao: vendas.devolucao,
      canceladaEm: vendas.canceladaEm,
      cancelamentoOrigem: vendas.cancelamentoOrigem,
    })
    .from(vendas)
    .where(eq(vendas.id, vendaId.toLowerCase()));
  if (!v) throw new Error(`Venda ${vendaId} sem linha para a projeção de status`);
  const acao = acaoStatusPdv(v.terminalId, origem);
  if (acao === 'nada') return false;
  const estado = {
    status: v.status,
    statusFiscal: v.statusFiscal,
    devolucao: v.devolucao,
    canceladaEm: v.canceladaEm,
    cancelamentoOrigem: v.cancelamentoOrigem,
  };
  if (acao === 'atualizar_existente') {
    const atualizadas = await tx
      .update(vendasStatusPdv)
      .set(estado)
      .where(eq(vendasStatusPdv.id, v.id))
      .returning({ id: vendasStatusPdv.id });
    return atualizadas.length > 0;
  }
  await tx
    .insert(vendasStatusPdv)
    .values({ id: v.id, caixaId: v.caixaId, terminalId: v.terminalId!, ...estado })
    .onConflictDoUpdate({
      target: vendasStatusPdv.id,
      set: {
        status: sql`excluded.status`,
        statusFiscal: sql`excluded.status_fiscal`,
        devolucao: sql`excluded.devolucao`,
        canceladaEm: sql`excluded.cancelada_em`,
        cancelamentoOrigem: sql`excluded.cancelamento_origem`,
      },
    });
  return true;
}
