import type {
  DetalheHistoricoProduto,
  LinhaHistoricoProduto,
  RespostaHistoricoProdutos,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { HistoricoProdutos } from './HistoricoProdutos';

afterEach(() => vi.unstubAllGlobals());

// Nomes e EANs inventados (repositório público).
const id = (n: number) => `0190a000-0000-7000-8000-0000000006${String(n).padStart(2, '0')}`;
const PRODUTO = id(1);

const linha = (n: number, extra: Partial<LinhaHistoricoProduto> = {}): LinhaHistoricoProduto => ({
  id: id(10 + n),
  ocorridoEm: '2026-11-03T17:02:00.123Z',
  usuarioId: id(2),
  usuarioNome: 'FULANO TESTE',
  tipo: 'G',
  acao: 'editar',
  localizacao: 'Cad. prod.',
  produto: { id: PRODUTO, codigo: 12, nome: 'CERVEJA TESTE 350ML', excluido: false },
  historico: 'Preço de venda: 9,90 → 10,90; EAN adicionado 7891234567895',
  ...extra,
});

function api(permissoes: string[]) {
  return simularApi(...rotasSessao({ permissoes }), ({ url }) => {
    if (url.pathname === '/api/usuarios')
      return { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } };
    if (url.pathname === `/api/relatorios/historico-produtos/${id(11)}`)
      return {
        corpo: {
          ...linha(1),
          alteracoes: [
            { campo: 'Preço de venda', antes: '9,90', depois: '10,90' },
            { campo: 'EAN 7891234567895', antes: '—', depois: 'Adicionado' },
          ],
        } satisfies DetalheHistoricoProduto,
      };
    if (url.pathname === '/api/relatorios/historico-produtos/exportar')
      return { status: 202, corpo: { tarefaId: id(20), linhas: 60_000 } };
    if (url.pathname !== '/api/relatorios/historico-produtos') return undefined;
    return {
      corpo: {
        itens: [
          linha(1),
          linha(2, {
            tipo: 'E',
            acao: 'excluir',
            produto: { id: id(3), codigo: 13, nome: 'PRODUTO EXCLUIDO TESTE', excluido: true },
            historico: 'Produto 13 - PRODUTO EXCLUIDO TESTE excluído',
          }),
        ],
        total: 2,
        pagina: 1,
        tamanho: 50,
      } satisfies RespostaHistoricoProdutos,
    };
  });
}

const pedidos = (chamadas: Array<{ url: URL }>) =>
  chamadas.filter((c) => c.url.pathname === '/api/relatorios/historico-produtos');

describe('<HistoricoProdutos> (ERP 16.2; F2-B42)', () => {
  it('o período padrão vai à API, e a linha mostra quem, onde, quando e o texto legível', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api(['relatorios.historico_produtos', 'produtos.ver']);
    renderizarComSessao(<HistoricoProdutos />, '/relatorios/historico-produtos');
    await usuario.click(await screen.findByRole('button', { name: 'Filtrar' }));
    const tabela = await screen.findByRole('table', { name: 'Histórico de produtos' });
    const cabecalho = [...tabela.querySelectorAll('thead th')].map((c) => c.textContent);
    expect(cabecalho).toEqual(
      expect.arrayContaining(['Usuário', 'Tipo', 'Localização', 'Data/hora', 'Produto', 'Histórico']),
    );
    const l1 = within(tabela)
      .getByText(/Preço de venda: 9,90 → 10,90/)
      .closest('tr')!;
    expect(within(l1).getByText('FULANO TESTE')).toBeInTheDocument();
    expect(within(l1).getByText('Cad. prod.')).toBeInTheDocument();
    expect(within(l1).getByText('03/11/2026 14:02')).toBeInTheDocument();
    expect(within(l1).getByRole('link', { name: 'Abrir 12 - CERVEJA TESTE 350ML' })).toHaveAttribute(
      'href',
      `/produtos/${PRODUTO}`,
    );
    // O excluído sem link, marcado.
    const l2 = within(tabela).getByText('13 - PRODUTO EXCLUIDO TESTE').closest('tr')!;
    expect(within(l2).getByText('Excluído')).toBeInTheDocument();
    expect(within(l2).queryByRole('link')).toBeNull();
    expect(screen.getByText(/G = Gravação/)).toBeInTheDocument();
    await waitFor(() => {
      const p = pedidos(chamadas).at(-1)!.url.searchParams;
      expect(p.get('dataInicial')).toMatch(/^\d{4}-\d{2}-01$/);
      expect(p.get('dataFinal')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it('"Ver diferença" abre a tabela campo × antes × depois da linha', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api(['relatorios.historico_produtos']);
    renderizarComSessao(<HistoricoProdutos />, '/relatorios/historico-produtos');
    await usuario.click(await screen.findByRole('button', { name: 'Filtrar' }));
    const tabela = await screen.findByRole('table', { name: 'Histórico de produtos' });
    // Sem produtos.ver: o produto sem link.
    expect(within(tabela).queryByRole('link', { name: /Abrir/ })).toBeNull();
    await usuario.click(within(tabela).getAllByRole('button', { name: /Ver diferença completa/ })[0]!);
    const modal = await screen.findByRole('table', { name: 'Campos alterados' });
    expect(within(modal).getByText('EAN 7891234567895')).toBeInTheDocument();
    expect(within(modal).getByText('10,90')).toBeInTheDocument();
    const pedido = chamadas.find((c) => c.url.pathname.endsWith(id(11)))!;
    expect(pedido.url.searchParams.get('ocorridoEm')).toBe('2026-11-03T17:02:00.123Z');
  });

  it('Exportar: o Excel pela API com os filtros da tela (ERP 3.5)', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api(['relatorios.historico_produtos', 'relatorios.exportar']);
    renderizarComSessao(
      <HistoricoProdutos />,
      '/relatorios/historico-produtos?gerado=1&dataInicial=2026-11-01&dataFinal=2026-11-07&tipo=G',
    );
    await screen.findByRole('table', { name: 'Histórico de produtos' });
    await usuario.click(screen.getByRole('button', { name: 'Exportar' }));
    await usuario.click(await screen.findByRole('menuitem', { name: 'Excel (.xlsx)' }));
    expect(await screen.findByTestId('exportacao-em-tarefa')).toHaveTextContent('60.000 linhas');
    const exp = chamadas.find((c) => c.url.pathname === '/api/relatorios/historico-produtos/exportar')!;
    expect(Object.fromEntries(exp.url.searchParams)).toMatchObject({
      dataInicial: '2026-11-01',
      dataFinal: '2026-11-07',
      tipo: 'G',
      formato: 'xlsx',
    });
  });
});
