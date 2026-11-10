import {
  ROTULOS_SITUACAO_CADASTRO,
  ROTULOS_TIPO_PRODUTO,
  SITUACOES_CADASTRO_PRODUTO,
  TIPOS_PRODUTO,
  type Pagina,
  type ProdutoResumo,
} from '@genesis/shared';
import { Anchor, Badge, Button, Group } from '@mantine/core';
import { IconBarcode } from '@tabler/icons-react';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { useCategorias, useMarcas } from '../../api/produtos';
import { Listagem, type ConfigListagem } from '../../componentes/listagem/Listagem';
import { ROTA_EAN_DUPLICADO } from '../relatorios/EanDuplicado';
import { decimalParaTela } from './valores';

export const ROTA_PRODUTOS = '/produtos';

const dinheiro = (v: string | null) => (v === null ? '—' : `R$ ${decimalParaTela(v)}`);

/**
 * Cadastro de produtos – listagem (ERP 8.1): filtros e colunas do Nuvem3 + Categoria e Situação de cadastro. Com o
 * filtro "EAN duplicado", o atalho para o relatório que agrupa por código (F2-B38; README do ERP › decisão 72).
 */
export function ListaProdutos() {
  const [params] = useSearchParams();
  const eanDuplicado = params.get('situacaoCadastro') === 'ean_duplicado';
  const marcas = useMarcas();
  const categorias = useCategorias();
  const config = useMemo<ConfigListagem<ProdutoResumo>>(
    () => ({
      recurso: 'produtos',
      titulo: 'Cadastro de produtos',
      ordenacaoPadrao: 'nome:asc',
      rotaNovo: `${ROTA_PRODUTOS}/novo`,
      rotuloNovo: 'Novo produto',
      rotaEdicao: (p) => `${ROTA_PRODUTOS}/${p.id}`,
      chaveLinha: (p) => p.id,
      filtros: [
        { campo: 'nome', rotulo: 'Nome', tipo: 'texto' },
        { campo: 'codigo', rotulo: 'Cód. (Id Produto)', tipo: 'numero' },
        { campo: 'codigoInterno', rotulo: 'Cód. interno', tipo: 'texto' },
        { campo: 'codigoBarras', rotulo: 'Cód. barras', tipo: 'texto' },
        { campo: 'ncm', rotulo: 'NCM', tipo: 'texto', placeholder: 'Prefixo, ex.: 2203' },
        {
          campo: 'marcaId',
          rotulo: 'Marca',
          tipo: 'selecao',
          opcoes: (marcas.data?.itens ?? []).map((m) => ({ value: m.id, label: m.descricao })),
        },
        {
          campo: 'categoriaId',
          rotulo: 'Categoria',
          tipo: 'selecao',
          opcoes: (categorias.data ?? [])
            .map((c) => ({ value: c.id, label: c.caminhoNomes }))
            .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
        },
        {
          campo: 'situacao',
          rotulo: 'Produtos ativos',
          tipo: 'selecao',
          padrao: 'ativos',
          opcoes: [
            { value: 'ativos', label: 'Somente ativos' },
            { value: 'inativos', label: 'Somente inativos' },
            { value: 'todos', label: 'Todos' },
          ],
        },
        {
          campo: 'local',
          rotulo: 'Local',
          tipo: 'selecao',
          padrao: 'todos',
          opcoes: [
            { value: 'todos', label: 'Todos' },
            { value: 'pdv', label: 'PDV' },
            { value: 'totem', label: 'Totem' },
            { value: 'menu_digital', label: 'Menu digital' },
          ],
        },
        {
          campo: 'tipo',
          rotulo: 'Tipo de produto',
          tipo: 'selecao',
          opcoes: TIPOS_PRODUTO.map((t) => ({ value: t, label: ROTULOS_TIPO_PRODUTO[t] })),
        },
        {
          campo: 'situacaoCadastro',
          rotulo: 'Situação de cadastro',
          tipo: 'selecao',
          padrao: 'todos',
          opcoes: SITUACOES_CADASTRO_PRODUTO.map((s) => ({ value: s, label: ROTULOS_SITUACAO_CADASTRO[s] })),
        },
      ],
      colunas: [
        {
          campo: 'nome',
          rotulo: 'Nome',
          ordenavel: true,
          formato: (p) => (
            <Group gap="xs" wrap="nowrap">
              <Anchor component={Link} to={`${ROTA_PRODUTOS}/${p.id}`} c="inherit">
                {p.nome}
              </Anchor>
              {p.tipo !== 'simples' && (
                <Badge variant="light" size="xs" color={p.tipo === 'kit' ? 'grape' : 'gray'}>
                  {ROTULOS_TIPO_PRODUTO[p.tipo]}
                </Badge>
              )}
              {!p.ativo && (
                <Badge variant="light" size="xs" color="gray">
                  Inativo
                </Badge>
              )}
            </Group>
          ),
        },
        {
          campo: 'codigoInterno',
          campoOrdenacao: 'codigo_interno',
          rotulo: 'Ref. interna',
          ordenavel: true,
          formato: (p) => p.codigoInterno ?? '—',
        },
        { campo: 'ean', rotulo: 'Cód. barras', ordenavel: true, formato: (p) => p.ean ?? '—' },
        {
          campo: 'marcaNome',
          campoOrdenacao: 'marca',
          rotulo: 'Marca',
          ordenavel: true,
          formato: (p) => p.marcaNome ?? '—',
        },
        {
          campo: 'localizacao',
          rotulo: 'Localização',
          ordenavel: true,
          formato: (p) => p.localizacao ?? '—',
        },
        {
          campo: 'precoCusto',
          campoOrdenacao: 'preco_custo',
          rotulo: 'Preço custo',
          ordenavel: true,
          alinhamento: 'right',
          permissao: 'produtos.ver_custo',
          formato: (p) => dinheiro(p.precoCusto),
        },
        {
          campo: 'precoVenda',
          campoOrdenacao: 'preco_venda',
          rotulo: 'Preço venda',
          ordenavel: true,
          alinhamento: 'right',
          formato: (p) => dinheiro(p.precoVenda),
        },
      ],
      buscar: (params, sinal) => apiErp.get<Pagina<ProdutoResumo>>(`/produtos${query(params)}`, { sinal }),
      exportar: (params, formato) => apiErp.baixar(`/produtos/exportar${query({ ...params, formato })}`),
    }),
    [marcas.data, categorias.data],
  );
  return (
    <Listagem
      config={config}
      acoes={
        eanDuplicado && (
          <Button
            component={Link}
            to={ROTA_EAN_DUPLICADO}
            variant="default"
            leftSection={<IconBarcode size={16} />}
          >
            Relatório de EAN duplicado
          </Button>
        )
      }
    />
  );
}
