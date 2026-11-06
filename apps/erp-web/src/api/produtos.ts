import {
  tiposProdutoHabilitados,
  type CategoriaNo,
  type CfopOpcao,
  type GrupoPrecoResumo,
  type MarcaResumo,
  type NcmOpcao,
  type Pagina,
  type ProdutoOpcao,
  type TiposProdutoHabilitados,
  type UnidadeMedida,
} from '@genesis/shared';
import { useQuery } from '@tanstack/react-query';
import { usePode } from '../auth/permissoes';
import { apiErp } from './clientes';
import { query } from './http';

/** Referências do cadastro de produtos (ERP 8.2): unidades, CFOPs, marcas, categorias e grupos de preço. */
export function useUnidades() {
  return useQuery({
    queryKey: ['referencias', 'unidades'],
    queryFn: () => apiErp.get<UnidadeMedida[]>('/referencias/unidades'),
    staleTime: 5 * 60_000,
  });
}

/** Padrão do catálogo (chaves desligadas): vale enquanto a API não responde. */
const TIPOS_HABILITADOS_PADRAO = tiposProdutoHabilitados(() => false);

/**
 * Chave da lista de tipos (e do bloco Fornecedores): Configurações a invalida ao gravar `CHAVES_TIPO_PRODUTO` ou
 * `geral.produto_usa_fornecedores` (o `staleTime` é longo).
 */
export const CHAVE_TIPOS_HABILITADOS = ['produtos', 'tipos-habilitados'] as const;

/**
 * Tipos que o formulário oferece na criação (F2-B1; D43): "Com variações" e "Com complementos" só com as chaves
 * `produtos.*_habilitados` ligadas. Sem resposta da API vale o padrão (travados), nunca a lista inteira.
 */
export function useTiposProdutoHabilitados() {
  return useConsultaHabilitados().data?.tipos ?? TIPOS_HABILITADOS_PADRAO;
}

/**
 * Bloco Fornecedores do formulário (ERP 8.2.14; F2-B13): `geral.produto_usa_fornecedores`, que vem na mesma consulta
 * dos tipos (sem exigir `configuracoes.ver`). Sem resposta da API, escondido: o formulário então não manda a lista e a
 * API mantém os vínculos gravados.
 */
export function useUsaFornecedores() {
  return useConsultaHabilitados().data?.usaFornecedores ?? false;
}

function useConsultaHabilitados() {
  return useQuery({
    queryKey: CHAVE_TIPOS_HABILITADOS,
    queryFn: () => apiErp.get<TiposProdutoHabilitados>('/produtos/tipos-habilitados'),
    staleTime: 5 * 60_000,
  });
}

export function useCfops(prefixo: '5' | '6') {
  return useQuery({
    queryKey: ['referencias', 'cfops', prefixo],
    queryFn: () => apiErp.get<CfopOpcao[]>(`/referencias/cfops${query({ prefixo })}`),
    staleTime: Infinity,
  });
}

export function useMarcas() {
  const pode = usePode();
  return useQuery({
    queryKey: ['opcoes', 'marcas'],
    queryFn: () =>
      apiErp.get<Pagina<MarcaResumo>>(`/marcas${query({ tamanho: 'todos', ordenar: 'descricao:asc' })}`),
    enabled: pode('marcas.ver'),
    staleTime: 60_000,
  });
}

export function useCategorias() {
  const pode = usePode();
  return useQuery({
    queryKey: ['opcoes', 'categorias'],
    queryFn: () => apiErp.get<CategoriaNo[]>('/categorias/arvore'),
    enabled: pode('categorias.ver'),
    staleTime: 60_000,
  });
}

export function useGruposPreco() {
  const pode = usePode();
  return useQuery({
    queryKey: ['opcoes', 'grupos-preco'],
    queryFn: () =>
      apiErp.get<Pagina<GrupoPrecoResumo>>(
        `/grupos-preco-quantidade${query({ tamanho: 'todos', situacao: 'todos', ordenar: 'nome:asc' })}`,
      ),
    enabled: pode('grupos_preco.ver'),
    staleTime: 30_000,
  });
}

export function buscarProdutos(
  termo: string,
  opcoes: { tipos?: readonly string[]; ids?: readonly string[]; sinal?: AbortSignal } = {},
): Promise<ProdutoOpcao[]> {
  return apiErp.get<ProdutoOpcao[]>(
    `/produtos/busca${query({
      termo,
      tipos: opcoes.tipos?.join(',') || undefined,
      ids: opcoes.ids?.join(',') || undefined,
    })}`,
    { sinal: opcoes.sinal },
  );
}

export function buscarNcms(busca: string, sinal?: AbortSignal): Promise<NcmOpcao[]> {
  return apiErp.get<NcmOpcao[]>(`/ncms${query({ busca })}`, { sinal });
}
