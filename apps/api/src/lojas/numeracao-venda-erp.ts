import { CHAVE_NUMERACAO_PROPRIA, type NumeracaoVendaErp } from '@genesis/shared';
import { and, eq, isNull, max } from 'drizzle-orm';
import { ErroApi } from '../comum/erros.js';
import { lerConfiguracao } from '../configuracoes/valores.js';
import { caixas, lojas, numeracoes, vendas } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { garantirNumeracoesLoja } from './numeracoes.js';

/**
 * "Nº da próxima venda" do ERP (ERP 9.10; MD 3.1.4; F3-B12): a numeração `venda` do caixa 0 da loja (o caixa do
 * sistema, dono `nuvem`). O "último usado" é o maior entre o contador e o maior número de venda do caixa 0 já gravado
 * (`uq_vendas_numero` atende): um contador que ficou para trás não deixa repetir um número. Com `travar`, a linha do
 * contador fica com `for update` até o fim da transação, a mesma trava que a venda do ERP (F3-B54) vai pegar para
 * tirar o número: dois "próximo número" ao mesmo tempo, ou um deles com uma venda, ficam em fila.
 */
export async function lerNumeracaoVendaErp(
  tx: DbEmpresa,
  lojaId: string,
  travar: boolean,
): Promise<NumeracaoVendaErp & { numeracaoId: string | null; contador: number }> {
  const [loja] = await tx
    .select({ id: lojas.id })
    .from(lojas)
    .where(and(eq(lojas.id, lojaId), isNull(lojas.excluidoEm)));
  if (!loja) throw ErroApi.naoEncontrado('Loja não encontrada.');
  const [caixa0] = await tx
    .select({ id: caixas.id, numero: caixas.numero })
    .from(caixas)
    .where(and(eq(caixas.lojaId, lojaId), eq(caixas.sistema, true), isNull(caixas.excluidoEm)));
  if (!caixa0) throw new ErroApi('REGRA_NEGOCIO', 'A loja não tem o caixa 0 das vendas do ERP.');
  const buscar = async () => {
    const q = tx
      .select({ id: numeracoes.id, ultimoNumero: numeracoes.ultimoNumero })
      .from(numeracoes)
      .where(
        and(eq(numeracoes.tipo, 'venda'), eq(numeracoes.caixaId, caixa0.id), isNull(numeracoes.excluidoEm)),
      );
    const [n] = await (travar ? q.for('update') : q);
    return n;
  };
  let n = await buscar();
  // A loja sem a linha (criada antes do assistente, MD 7.13) ganha a do `garantir` da criação antes de gravar.
  if (!n && travar) {
    await garantirNumeracoesLoja(tx, lojaId);
    n = await buscar();
  }
  const [v] = await tx
    .select({ n: max(vendas.numero) })
    .from(vendas)
    .where(and(eq(vendas.lojaId, lojaId), eq(vendas.numeroCaixa, caixa0.numero)));
  const ultimoNumero = Math.max(n?.ultimoNumero ?? 0, Number(v?.n ?? 0));
  const numeracaoPropria = (await lerConfiguracao<boolean>(tx, CHAVE_NUMERACAO_PROPRIA)) === true;
  return {
    lojaId,
    numeracaoId: n?.id ?? null,
    contador: n?.ultimoNumero ?? 0,
    ultimoNumero,
    proximoNumero: ultimoNumero + 1,
    numeracaoPropria,
  };
}
