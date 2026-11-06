/**
 * NCM "existente e vigente" (MD 3.6.3): na tabela `ncms`, não excluído e sem fim de vigência no passado. Um só
 * helper para o cadastro, os avisos do combo, o filtro "Situação de cadastro", a importação e o dashboard — quando a
 * tabela oficial for atualizada com fim de vigência, o produto deixa de ser "válido" em todos os lugares juntos.
 */
import { sql, type SQL } from 'drizzle-orm';

export const NCM_VIGENTE_SQL = sql`n.excluido_em is null and (n.vigencia_fim is null or n.vigencia_fim >= current_date)`;

/** `exists` do NCM vigente para a expressão `codigo` (coluna ou parâmetro). */
export const ncmVigente = (codigo: SQL | string) =>
  sql`exists (select 1 from ncms n where n.codigo = ${codigo} and ${NCM_VIGENTE_SQL})`;
