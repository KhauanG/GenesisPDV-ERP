import type { LinhaProdutosGeral, RespostaProdutosGeral } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { ProdutosGeral } from './ProdutosGeral';

afterEach(() => vi.unstubAllGlobals());

const id = (n: number) => `0190a000-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`;
const LOJA = id(90);

const linha = (n: number, extra: Partial<LinhaProdutosGeral> = {}): LinhaProdutosGeral => ({
  produtoId: id(n),
  produtoCodigo: n,
  produtoNome: `CERV TESTE ${n}`,
  ativo: true,
  unidadeSigla: 'UN',
  codigoInterno: null,
  codigoBarras: '7899000000010',
  marcaNome: 'MARCA TESTE',
  ncm: '22030000',
  precoCusto: '10.0000',
  precoVenda: '15.0000',
  precoAtacado: null,
  lucro: '5.00',
  lucroPct: '33.33',
  markupPct: '50.00',
  departamentos: ['BEBIDAS › CERVEJAS'],
  ...extra,
});

function api(permissoes: string[], vazio = false) {
  const custo = permissoes.includes('produtos.ver_custo');
  return simularApi(
    ...rotasSessao({
      permissoes,
      lojas: [{ id: LOJA, codigo: 1, nome: 'Loja Centro', ativa: true }],
    }),
    ({ url }) => {
      if (url.pathname === '/api/marcas')
        return { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } };
      if (url.pathname === '/api/categorias/arvore') return { corpo: [] };
      if (url.pathname !== '/api/relatorios/produtos-geral') return undefined;
      const semCusto = (l: LinhaProdutosGeral) =>
        custo ? l : { ...l, precoCusto: null, lucro: null, lucroPct: null, markupPct: null };
      if (vazio)
        return {
          corpo: {
            itens: [],
            total: 0,
            pagina: 1,
            tamanho: 50,
            // O `avg` de zero linhas é nulo: as médias vêm nulas mesmo com o custo.
            totais: { quantidadeProdutos: 0, mediaLucro: null, mediaLucroPct: null, mediaMarkupPct: null },
          } satisfies RespostaProdutosGeral,
        };
      return {
        corpo: {
          itens: [
            linha(1),
            linha(2, { lucro: '-1.00', lucroPct: '-10.00', markupPct: '-9.09', ativo: false }),
          ].map(semCusto),
          total: 2,
          pagina: 1,
          tamanho: 50,
          totais: {
            quantidadeProdutos: 2,
            mediaLucro: custo ? '2.00' : null,
            mediaLucroPct: custo ? '11.67' : null,
            mediaMarkupPct: custo ? '20.46' : null,
          },
        } satisfies RespostaProdutosGeral,
      };
    },
  );
}

const pedidos = (chamadas: Array<{ url: URL }>) =>
  chamadas.filter((c) => c.url.pathname === '/api/relatorios/produtos-geral');

describe('<ProdutosGeral> (ERP 16.1; F2-B41)', () => {
  it('com produtos.ver_custo: as colunas de custo e lucro, as médias da API e o link para editar', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api(['relatorios.produtos_geral', 'produtos.ver_custo', 'relatorios.exportar']);
    renderizarComSessao(<ProdutosGeral />, '/relatorios/produtos-geral');
    await usuario.click(await screen.findByRole('button', { name: 'Filtrar' }));
    const tabela = await screen.findByRole('table', { name: 'Produtos geral' });
    const cabecalho = [...tabela.querySelectorAll('thead th')].map((c) => c.textContent);
    expect(cabecalho).toEqual(
      expect.arrayContaining([
        'Preço custo',
        'Preço venda',
        'Preço atacado',
        'Lucro R$',
        'Lucro %',
        'Markup %',
      ]),
    );
    expect(cabecalho).not.toContain('WooComm');
    expect(within(tabela).getByRole('link', { name: 'Editar 1 - CERV TESTE 1' })).toHaveAttribute(
      'href',
      `/produtos/${id(1)}`,
    );
    const l2 = within(tabela).getByText('2 - CERV TESTE 2').closest('tr')!;
    expect(within(l2).getByText('Inativo')).toBeInTheDocument();
    expect(within(l2).getByText('-10,00%')).toBeInTheDocument();
    expect(screen.getByText('Lucro médio')).toBeInTheDocument();
    expect(screen.getByText('Markup % médio')).toBeInTheDocument();
    expect(screen.getAllByText('20,46%').length).toBeGreaterThan(0);
    // A loja começa vazia (sem loja de contexto): o preço do produto.
    await waitFor(() => expect(pedidos(chamadas).at(-1)!.url.searchParams.get('lojaId')).toBeNull());
  });

  it('com produtos.ver_custo e nenhuma linha: os três cards de média com "—", como a linha de totais', async () => {
    const usuario = userEvent.setup();
    api(['relatorios.produtos_geral', 'produtos.ver_custo'], true);
    renderizarComSessao(<ProdutosGeral />, '/relatorios/produtos-geral');
    await usuario.click(await screen.findByRole('button', { name: 'Filtrar' }));
    for (const rotulo of ['Lucro médio', 'Lucro % médio', 'Markup % médio'])
      expect(await screen.findByText(rotulo)).toBeInTheDocument();
  });

  it('sem produtos.ver_custo: sem custo, lucro, markup nem médias', async () => {
    const usuario = userEvent.setup();
    api(['relatorios.produtos_geral']);
    renderizarComSessao(<ProdutosGeral />, '/relatorios/produtos-geral');
    await usuario.click(await screen.findByRole('button', { name: 'Filtrar' }));
    const tabela = await screen.findByRole('table', { name: 'Produtos geral' });
    const cabecalho = [...tabela.querySelectorAll('thead th')].map((c) => c.textContent);
    for (const c of ['Preço custo', 'Lucro R$', 'Lucro %', 'Markup %']) expect(cabecalho).not.toContain(c);
    expect(cabecalho).toContain('Preço venda');
    expect(screen.queryByText('Lucro médio')).toBeNull();
    expect(screen.queryByText('Markup % médio')).toBeNull();
  });
});
