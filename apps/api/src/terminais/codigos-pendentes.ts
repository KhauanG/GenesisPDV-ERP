import { and, eq } from 'drizzle-orm';
import type { SessaoErp } from '../auth/auth.service.js';
import { origemDaRequisicao, type RequisicaoGenesis } from '../comum/requisicao.js';
import { ativacoesPdv } from '../database/controle/schema.js';
import type { Servicos } from '../servicos.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';

type Cancelado = { id: string; codigoFinal: string; numeroCaixa: number };

/**
 * Códigos que cada requisição já cancelou no controle. A transação da empresa é repetida no deadlock e no erro de
 * serialização (`tenancy.transacao`): o `update` do controle (autocommit) não volta com o rollback, a auditoria volta,
 * e na repetição o `update` não acha mais nada `pendente`. A repetição audita também os que a tentativa anterior
 * cancelou (a mesma requisição e o mesmo alvo), então todo código cancelado que commita fica com a sua auditoria.
 */
const canceladosPorRequisicao = new WeakMap<object, Map<string, Map<string, Cancelado>>>();

/**
 * Cancela, no banco de controle, os códigos de ativação pendentes de um caixa ou de uma loja inteira (ERP 12.1
 * `CodigoGerado → Cancelado`) quando o caixa é excluído ou inativado, ou a loja é excluída, com a auditoria de cada
 * um na transação da empresa. Roda dentro dela, com as linhas do caixa já travadas: se a transação não chegar a
 * commitar, o código fica cancelado mesmo assim (basta gerar outro); se ela for repetida e commitar, a auditoria de
 * cada código sai na tentativa que commita. A ativação confere o caixa de novo (SYNC 3.3).
 */
export async function cancelarCodigosPendentes(
  s: Pick<Servicos, 'controle' | 'auditoria'>,
  tx: DbEmpresa,
  sessao: SessaoErp,
  req: RequisicaoGenesis,
  alvo: { lojaId: string; caixaId?: string },
  motivo: string,
): Promise<number> {
  const agora = await s.controle.db
    .update(ativacoesPdv)
    .set({ status: 'cancelado', canceladoEm: new Date(), canceladoPorUsuarioId: sessao.usuarioId })
    .where(
      and(
        eq(ativacoesPdv.empresaId, sessao.empresa.empresaId),
        eq(ativacoesPdv.lojaId, alvo.lojaId),
        alvo.caixaId ? eq(ativacoesPdv.caixaId, alvo.caixaId) : undefined,
        eq(ativacoesPdv.status, 'pendente'),
      ),
    )
    .returning({
      id: ativacoesPdv.id,
      codigoFinal: ativacoesPdv.codigoFinal,
      numeroCaixa: ativacoesPdv.numeroCaixa,
    });
  const chave = `${alvo.lojaId}:${alvo.caixaId ?? '*'}`;
  const porAlvo = canceladosPorRequisicao.get(req) ?? new Map<string, Map<string, Cancelado>>();
  canceladosPorRequisicao.set(req, porAlvo);
  const cancelados = porAlvo.get(chave) ?? new Map<string, Cancelado>();
  porAlvo.set(chave, cancelados);
  for (const a of agora) cancelados.set(a.id, a);
  const origem = origemDaRequisicao(req);
  for (const a of cancelados.values()) {
    await s.auditoria.registrar(tx, origem, {
      acao: 'cancelar',
      entidade: 'ativacoes_pdv',
      registroId: a.id,
      lojaId: alvo.lojaId,
      localizacao: 'PDVs/Terminais › Códigos pendentes',
      descricao: `Código de ativação ••••-••${a.codigoFinal} do caixa ${a.numeroCaixa} cancelado (${motivo})`,
    });
  }
  return cancelados.size;
}
