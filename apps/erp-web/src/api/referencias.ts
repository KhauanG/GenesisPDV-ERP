import type { EnderecoCep } from '@genesis/shared';
import { useQuery } from '@tanstack/react-query';
import { apiErp } from './clientes';
import { query } from './http';

export interface Municipio {
  codigoIbge: number;
  nome: string;
  uf: string;
}

/** UFs e municípios do IBGE (referências locais da empresa; mudam só com a carga de referências). */
export function useUfs() {
  return useQuery({
    queryKey: ['referencias', 'ufs'],
    queryFn: () => apiErp.get<Array<{ sigla: string; nome: string }>>('/referencias/ufs'),
    staleTime: Infinity,
  });
}

export function useMunicipios(uf: string | null | undefined) {
  return useQuery({
    queryKey: ['referencias', 'municipios', uf],
    queryFn: () => apiErp.get<Municipio[]>(`/referencias/municipios${query({ uf })}`),
    enabled: !!uf && /^[A-Z]{2}$/.test(uf),
    staleTime: Infinity,
  });
}

export function usePaises() {
  return useQuery({
    queryKey: ['referencias', 'paises'],
    queryFn: () => apiErp.get<Array<{ codigoBacen: string; nome: string }>>('/referencias/paises'),
    staleTime: Infinity,
  });
}

/** Consulta de CEP (ERP 7.2): `null` quando não encontrado ou sem internet — a tela segue com o endereço digitado. */
export async function buscarCep(cep: string): Promise<EnderecoCep | null> {
  const digitos = cep.replace(/\D/g, '');
  if (digitos.length !== 8) return null;
  try {
    return await apiErp.get<EnderecoCep>(`/utilitarios/cep/${digitos}`);
  } catch {
    return null;
  }
}
