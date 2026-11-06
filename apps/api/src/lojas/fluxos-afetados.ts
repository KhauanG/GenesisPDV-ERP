import type { Fluxo } from '@genesis/shared';
import type { lojas } from '../database/empresa/schema/index.js';

type ColunasEstruturais = Pick<
  typeof lojas.$inferSelect,
  'estoqueId' | 'uf' | 'municipioIbge' | 'tipoEmissao'
>;

/**
 * Mudanças estruturais da loja (MD 6.4 regra 3): a saída de filtro não desce tombstone, então os terminais da loja
 * refazem os fluxos cujo filtro depende da coluna alterada — `estoque_id` (saldos e lotes do estoque E no `estoque` e
 * no `catalogo`; a linha de `estoques` da loja no `configuracao`), UF ou município (parâmetros fiscais e tributação
 * por UF) e `tipo_emissao` (o certificado entra ou sai do filtro).
 */
export function fluxosAfetados(antes: ColunasEstruturais, depois: ColunasEstruturais): Fluxo[] {
  const fluxos: Fluxo[] = [];
  if (antes.estoqueId !== depois.estoqueId) fluxos.push('estoque', 'catalogo', 'configuracao');
  if (antes.uf !== depois.uf || antes.municipioIbge !== depois.municipioIbge)
    fluxos.push('referencia', 'catalogo');
  if (antes.tipoEmissao !== depois.tipoEmissao) fluxos.push('configuracao');
  return [...new Set(fluxos)];
}
