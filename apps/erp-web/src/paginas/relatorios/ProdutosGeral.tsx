import {
  RELATORIO_PRODUTOS_GERAL,
  type LinhaProdutosGeral,
  type RespostaProdutosGeral,
} from '@genesis/shared';
import { Anchor, Badge, Group, Text } from '@mantine/core';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { useCategorias, useMarcas } from '../../api/produtos';
import { usePode } from '../../auth/permissoes';
import { useEu } from '../../auth/sessao';
import { formatarDecimal } from '../../componentes/grade/decimal';
import type { FiltroListagem } from '../../componentes/listagem/Listagem';
import {
  exportarPelaApi,
  Relatorio,
  type ColunaRelatorio,
  type ConfigRelatorio,
} from '../../componentes/relatorio/Relatorio';
import { formatarInteiro } from '../../util/formato';
import { ROTA_PRODUTOS } from '../produtos/ListaProdutos';

export const ROTA_PRODUTOS_GERAL = '/relatorios/produtos-geral';

const reais = (v: string | null) => (v === null ? '—' : `R$ ${formatarDecimal(Number(v), 2)}`);
const pct = (v: string | null) => (v === null ? '—' : `${formatarDecimal(Number(v), 2)}%`);
/** Lucro negativo em vermelho (o produto vende abaixo do custo). */
const comSinal = (v: string | null, texto: string) =>
  v !== null && Number(v) < 0 ? (
    <Text span size="sm" c="red">
      {texto}
    </Text>
  ) : (
    texto
  );

/**
 * Relatório **Produtos geral** (ERP 16.1; Fase 2, F2-B41; README do ERP › decisão 75): as margens do catálogo —
 * preço de custo, venda (a da loja escolhida, quando ela tem preço próprio), atacado, lucro em R$, lucro % e markup %
 * — com os departamentos, paginado no servidor, e as médias do relatório inteiro calculadas pela API em decimal (os
 * cards). Filtros: nome/código/EAN, marca, departamento (com os filhos), sem preço, loja (começa na de contexto; vazia
 * = o preço do produto) e situação. Custo, lucro e markup (as colunas, as médias e a ordenação) só com
 * `produtos.ver_custo`. A coluna WooComm fica escondida até a integração (Fase 7). Exportação pela API (Excel/CSV).
 */
export function ProdutosGeral() {
  const pode = usePode();
  const eu = useEu();
  const marcas = useMarcas();
  const categorias = useCategorias();
  const verCusto = pode('produtos.ver_custo');

  const config = useMemo<ConfigRelatorio<LinhaProdutosGeral>>(() => {
    const filtros: FiltroListagem[] = [
      { campo: 'nome', rotulo: 'Nome/código', tipo: 'texto', placeholder: 'Nome, código interno ou EAN' },
      {
        campo: 'marcaId',
        rotulo: 'Marca',
        tipo: 'selecao',
        opcoes: (marcas.data?.itens ?? []).map((m) => ({ value: m.id, label: m.descricao })),
      },
      {
        campo: 'categoriaId',
        rotulo: 'Departamento',
        tipo: 'selecao',
        placeholder: 'Todos (inclui os filhos)',
        opcoes: (categorias.data ?? [])
          .map((c) => ({ value: c.id, label: c.caminhoNomes }))
          .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR')),
      },
      {
        campo: 'lojaId',
        rotulo: 'Loja (preço)',
        tipo: 'loja',
        placeholder: 'Preço do produto',
        opcoes: eu.lojas
          .filter((l) => l.ativa)
          .map((l) => ({ value: l.id, label: `${l.codigo} - ${l.nome}${l.treino ? ' (treino)' : ''}` })),
      },
      {
        campo: 'semPreco',
        rotulo: 'Preço',
        tipo: 'selecao',
        placeholder: 'Todos',
        opcoes: [{ value: 'true', label: 'Somente sem preço' }],
      },
      {
        campo: 'situacao',
        rotulo: 'Produtos',
        tipo: 'selecao',
        padrao: 'ativos',
        opcoes: [
          { value: 'ativos', label: 'Somente ativos' },
          { value: 'inativos', label: 'Somente inativos' },
          { value: 'todos', label: 'Todos' },
        ],
      },
    ];

    const colunas: ColunaRelatorio<LinhaProdutosGeral>[] = [
      {
        campo: 'produto',
        rotulo: 'Produto',
        formato: (l) => (
          <Group gap="xs" wrap="nowrap">
            <Anchor
              component={Link}
              to={`${ROTA_PRODUTOS}/${l.produtoId}`}
              size="sm"
              aria-label={`Editar ${l.produtoCodigo} - ${l.produtoNome}`}
            >
              {l.produtoCodigo} - {l.produtoNome}
            </Anchor>
            {!l.ativo && (
              <Badge variant="light" size="xs" color="gray">
                Inativo
              </Badge>
            )}
          </Group>
        ),
      },
      { campo: 'unidadeSigla', rotulo: 'Unidade', formato: (l) => l.unidadeSigla },
      { campo: 'codigoInterno', rotulo: 'Código Interno', formato: (l) => l.codigoInterno ?? '—' },
      { campo: 'codigoBarras', rotulo: 'Código Barras', formato: (l) => l.codigoBarras ?? '—' },
      { campo: 'marcaNome', rotulo: 'Marca', formato: (l) => l.marcaNome ?? '—' },
      { campo: 'ncm', rotulo: 'NCM', formato: (l) => l.ncm ?? '—' },
      ...(verCusto
        ? [
            {
              campo: 'precoCusto',
              rotulo: 'Preço custo',
              alinhamento: 'right' as const,
              formato: (l: LinhaProdutosGeral) => reais(l.precoCusto),
            },
          ]
        : []),
      {
        campo: 'precoVenda',
        rotulo: 'Preço venda',
        alinhamento: 'right',
        formato: (l) => reais(l.precoVenda),
      },
      {
        campo: 'precoAtacado',
        rotulo: 'Preço atacado',
        alinhamento: 'right',
        formato: (l) => reais(l.precoAtacado),
      },
      ...(verCusto
        ? ([
            {
              campo: 'lucro',
              rotulo: 'Lucro R$',
              alinhamento: 'right',
              formato: (l) => comSinal(l.lucro, reais(l.lucro)),
            },
            {
              campo: 'lucroPct',
              rotulo: 'Lucro %',
              alinhamento: 'right',
              formato: (l) => comSinal(l.lucroPct, pct(l.lucroPct)),
            },
            {
              campo: 'markupPct',
              rotulo: 'Markup %',
              alinhamento: 'right',
              formato: (l) => comSinal(l.markupPct, pct(l.markupPct)),
            },
          ] satisfies ColunaRelatorio<LinhaProdutosGeral>[])
        : []),
      {
        campo: 'departamentos',
        rotulo: 'Departamentos',
        formato: (l) => (l.departamentos.length ? l.departamentos.join(' | ') : '—'),
      },
    ];

    return {
      nome: RELATORIO_PRODUTOS_GERAL,
      titulo: 'Produtos geral',
      filtros,
      colunas,
      paginacao: 'pagina',
      chaveLinha: (l) => l.produtoId,
      exportar: exportarPelaApi(RELATORIO_PRODUTOS_GERAL),
      nota: verCusto
        ? 'Lucro = venda − preço de custo do cadastro; Lucro % = lucro ÷ venda; Markup % = lucro ÷ custo. As médias são do relatório inteiro (o lucro % só dos produtos com venda; o markup % só dos com custo).'
        : undefined,
      buscar: async (p, sinal) => {
        const r = await apiErp.get<RespostaProdutosGeral>(`/relatorios/produtos-geral${query(p)}`, { sinal });
        const t = r.totais;
        return {
          linhas: r.itens,
          total: r.total,
          resumo: [
            { rotulo: 'Produtos', valor: formatarInteiro(t.quantidadeProdutos) },
            // O mesmo critério da linha de totais: com `produtos.ver_custo`, os três cards (sem linhas, "—").
            ...(verCusto
              ? [
                  { rotulo: 'Lucro médio', valor: reais(t.mediaLucro) },
                  { rotulo: 'Lucro % médio', valor: pct(t.mediaLucroPct) },
                  { rotulo: 'Markup % médio', valor: pct(t.mediaMarkupPct) },
                ]
              : []),
          ],
          totais: {
            produto: `Total (${formatarInteiro(t.quantidadeProdutos)} produtos)`,
            ...(verCusto
              ? {
                  lucro: `Média ${reais(t.mediaLucro)}`,
                  lucroPct: `Média ${pct(t.mediaLucroPct)}`,
                  markupPct: `Média ${pct(t.mediaMarkupPct)}`,
                }
              : {}),
          },
        };
      },
    };
  }, [marcas.data, categorias.data, eu.lojas, verCusto]);

  return <Relatorio config={config} />;
}
