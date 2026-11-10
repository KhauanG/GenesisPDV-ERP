/**
 * Modal "Histórico de preços" do produto (F2-B37; MD 3.6.10): as linhas com o tipo, a loja, a faixa, o anterior, o
 * novo, a variação em % e a origem com o documento (o link da NF-e para quem pode ver); o filtro de tipo indo à API
 * (e, trocado na página 2, voltando à primeira); sem `produtos.ver_custo`, o filtro não oferece "Custo".
 */
import type { HistoricoPrecoProduto, Pagina } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { ModalHistoricoPrecos, variacaoPct } from './HistoricoPrecos';

afterEach(() => vi.unstubAllGlobals());

const ID = '0190a000-0000-7000-8000-0000000000c1';
const NOTA = '0190a000-0000-7000-8000-0000000000e1';
const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const LOJAS = [{ id: LOJA, codigo: 1, nome: 'Loja 1', ativa: true }];

const linha = (extra: Partial<HistoricoPrecoProduto>): HistoricoPrecoProduto => ({
  id: crypto.randomUUID(),
  criadoEm: '2026-11-10T13:00:00Z',
  tipoPreco: 'venda',
  variacaoId: null,
  variacaoNome: null,
  lojaId: null,
  lojaNome: null,
  quantidadeInicial: null,
  quantidadeFinal: null,
  valorAnterior: null,
  valorNovo: null,
  origem: 'cadastro',
  documento: null,
  usuarioNome: 'MARIA',
  ...extra,
});

const PAGINA: Pagina<HistoricoPrecoProduto> = {
  itens: [
    linha({
      valorAnterior: '9.9000',
      valorNovo: '10.9000',
      origem: 'nota_entrada',
      documento: { id: NOTA, numero: '4521' },
    }),
    linha({ tipoPreco: 'custo', valorAnterior: '5.0000', valorNovo: '5.5125', origem: 'importacao' }),
    linha({
      tipoPreco: 'quantidade',
      quantidadeInicial: '6.000',
      quantidadeFinal: '11.000',
      valorAnterior: null,
      valorNovo: '9.4000',
    }),
    linha({
      tipoPreco: 'quantidade',
      lojaId: LOJA,
      lojaNome: 'Loja 1',
      quantidadeInicial: '12.000',
      valorAnterior: '9.2000',
      valorNovo: null,
    }),
  ],
  total: 4,
  pagina: 1,
  tamanho: 20,
};

const rotaHistorico = ({ url }: { url: URL }) =>
  url.pathname === `/api/produtos/${ID}/historico-precos` ? { corpo: PAGINA } : undefined;

describe('modal Histórico de preços (F2-B37)', () => {
  it('mostra a faixa, a variação, a origem com o link da NF-e e o custo com 4 casas', async () => {
    simularApi(
      ...rotasSessao({
        permissoes: ['produtos.ver', 'produtos.ver_custo', 'notas_entrada.ver'],
        lojas: LOJAS,
      }),
      rotaHistorico,
    );
    renderizarComSessao(<ModalHistoricoPrecos produtoId={ID} aberto aoFechar={() => {}} />);
    const tabela = await screen.findByTestId('historico-precos');
    const linhas = within(tabela).getAllByRole('row').slice(1);
    expect(within(linhas[0]!).getByText('10,90')).toBeInTheDocument();
    expect(within(linhas[0]!).getByText('9,90')).toBeInTheDocument();
    expect(within(linhas[0]!).getByText('+10,10%')).toBeInTheDocument();
    expect(within(linhas[0]!).getByRole('link', { name: 'NF-e de entrada nº 4521' })).toHaveAttribute(
      'href',
      `/estoque/notas-entrada/${NOTA}`,
    );
    expect(within(linhas[1]!).getByText('5,5125')).toBeInTheDocument();
    expect(within(linhas[1]!).getByText('Importação de planilha')).toBeInTheDocument();
    expect(within(linhas[2]!).getByText('Por quantidade · 6 a 11 · todas as lojas')).toBeInTheDocument();
    expect(within(linhas[3]!).getByText('Por quantidade · 12 ou mais · Loja 1')).toBeInTheDocument();
    expect(within(linhas[3]!).getAllByText('—')).toHaveLength(1);
    expect(screen.getByText('4 alteração(ões)')).toBeInTheDocument();
  });

  it('o filtro de tipo vai à API; sem ver_custo não há "Custo" nem o link sem a permissão da nota', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['produtos.ver'], lojas: LOJAS }),
      rotaHistorico,
    );
    renderizarComSessao(<ModalHistoricoPrecos produtoId={ID} aberto aoFechar={() => {}} />);
    const tabela = await screen.findByTestId('historico-precos');
    expect(within(tabela).queryByRole('link')).toBeNull();
    expect(within(tabela).getByText('NF-e de entrada nº 4521')).toBeInTheDocument();
    await u.click(screen.getByRole('combobox', { name: 'Tipo' }));
    expect(screen.queryByRole('option', { name: 'Custo', hidden: true })).toBeNull();
    await u.click(await screen.findByRole('option', { name: 'Por quantidade', hidden: true }));
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) =>
            c.url.pathname === `/api/produtos/${ID}/historico-precos` &&
            c.url.searchParams.get('tipo') === 'quantidade' &&
            c.url.searchParams.get('pagina') === '1',
        ),
      ).toBe(true),
    );
  });

  it('trocar o filtro na página 2 volta à primeira página', async () => {
    const u = userEvent.setup();
    // 45 alterações: 3 páginas de 20, a paginação aparece.
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['produtos.ver'], lojas: LOJAS }),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}/historico-precos`
          ? { corpo: { ...PAGINA, total: 45, pagina: Number(url.searchParams.get('pagina')) } }
          : undefined,
    );
    renderizarComSessao(<ModalHistoricoPrecos produtoId={ID} aberto aoFechar={() => {}} />);
    await screen.findByTestId('historico-precos');
    const doHistorico = () =>
      chamadas.filter((c) => c.url.pathname === `/api/produtos/${ID}/historico-precos`);
    await u.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(doHistorico().at(-1)!.url.searchParams.get('pagina')).toBe('2'));
    await u.click(screen.getByRole('combobox', { name: 'Tipo' }));
    await u.click(await screen.findByRole('option', { name: 'Por quantidade', hidden: true }));
    await waitFor(() => expect(doHistorico().at(-1)!.url.searchParams.get('tipo')).toBe('quantidade'));
    expect(doHistorico().at(-1)!.url.searchParams.get('pagina')).toBe('1');
  });

  it('variacaoPct: a variação do anterior para o novo, vazia sem um dos dois ou com o anterior zero', () => {
    expect(variacaoPct('9.9000', '10.9000')).toBe('+10,10%');
    expect(variacaoPct('10.0000', '9.0000')).toBe('-10,00%');
    expect(variacaoPct(null, '9.0000')).toBe('');
    expect(variacaoPct('0.0000', '9.0000')).toBe('');
  });
});
