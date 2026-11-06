import { eq } from 'drizzle-orm';
import { municipios } from '../database/empresa/schema/index.js';
import type { DbEmpresa } from '../tenancy/tenancy.js';
import { ErroApi } from '../comum/erros.js';

/** Município existente e da UF informada (ERP 1.6): mensagem por campo em vez do erro de FK. */
export async function garantirMunicipio(
  db: DbEmpresa,
  codigo: number | null,
  uf: string | null,
  prefixo = '',
): Promise<void> {
  if (codigo === null) return;
  const [m] = await db
    .select({ uf: municipios.uf })
    .from(municipios)
    .where(eq(municipios.codigoIbge, codigo));
  if (!m) {
    throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
      campos: { [`${prefixo}municipioIbge`]: ['Cidade inexistente'] },
    });
  }
  if (uf && m.uf !== uf) {
    throw new ErroApi('VALIDACAO', 'Verifique os campos destacados.', {
      campos: { [`${prefixo}municipioIbge`]: [`A cidade não é da UF ${uf}`] },
    });
  }
}
