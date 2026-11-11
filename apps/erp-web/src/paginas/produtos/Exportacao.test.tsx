import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { salvarArquivo } from '../../util/arquivos';
import { Exportacao } from './Exportacao';

vi.mock('../../util/arquivos', () => ({ salvarArquivo: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(salvarArquivo).mockClear();
});

const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const CD = '0190a000-0000-7000-8000-0000000000e9';
const TAREFA = '0192f000-0000-7000-8000-0000000000aa';

function api(permissoes: string[], opcoes: { tarefa?: boolean } = {}) {
  return simularApi(
    ...rotasSessao({
      permissoes,
      lojas: [{ id: LOJA, codigo: 1, nome: 'Loja Centro', ativa: true }],
    }),
    ({ url }) =>
      url.pathname === '/api/estoques'
        ? {
            corpo: {
              itens: [
                {
                  id: CD,
                  codigo: 9,
                  nome: 'CD - Estoque Teste',
                  tipo: 'deposito',
                  lojaId: null,
                  lojaNome: null,
                  ativo: true,
                  versao: 1,
                },
              ],
              total: 1,
              pagina: 1,
              tamanho: 'todos',
            },
          }
        : undefined,
    ({ url }) =>
      url.pathname === '/api/produtos/exportacao'
        ? opcoes.tarefa
          ? { status: 202, corpo: { tarefaId: TAREFA, linhas: 12_000 } }
          : {
              arquivo: {
                conteudo: 'x',
                cabecalhos: {
                  'Content-Disposition': 'attachment; filename="Exportacao_Produtos_10_11_2026_10_00.xlsx"',
                },
              },
            }
        : undefined,
    ({ url }) =>
      url.pathname === '/api/pessoas/exportacao'
        ? {
            arquivo: {
              conteudo: 'x',
              cabecalhos: {
                'Content-Disposition': 'attachment; filename="Exportacao_Clientes_10_11_2026_10_00.csv"',
              },
            },
          }
        : undefined,
    ({ url }) =>
      url.pathname === `/api/tarefas/${TAREFA}`
        ? {
            corpo: {
              id: TAREFA,
              tipo: 'exportar_relatorio',
              status: 'executando',
              progressoPct: 40,
              mensagem: '4.800 de 12.000 linhas',
              resultado: null,
              erro: null,
              criadoEm: '2026-11-10T13:00:00.000Z',
              concluidaEm: null,
              download: null,
              downloadExpirado: false,
            },
          }
        : undefined,
    ({ url }) => (url.pathname === '/api/tarefas' ? { corpo: { pendentes: 1, itens: [] } } : undefined),
  );
}

const pedido = (chamadas: Array<{ url: URL }>, rota: string) =>
  Object.fromEntries(chamadas.find((c) => c.url.pathname === rota)!.url.searchParams);

describe('<Exportacao> (ERP 8.5; F2-B40)', () => {
  it('produtos da loja com as informações da NF: os filtros vão na query e o arquivo baixa', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api(['produtos.ver', 'produtos.exportar', 'estoques.ver']);
    renderizarComSessao(<Exportacao />, '/produtos/exportacao');
    // Sem loja ("Todas"), o filtro de estoque fica desligado.
    const zerado = await screen.findByRole('checkbox', { name: /Estoque zerado ou negativo/ });
    expect(zerado).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Exportar Clientes' })).toBeDisabled();

    await usuario.click(screen.getByRole('combobox', { name: 'Loja' }));
    await usuario.click(await screen.findByRole('option', { name: '1 - Loja Centro', hidden: true }));
    expect(zerado).toBeEnabled();
    await usuario.click(zerado);
    await usuario.click(screen.getByRole('checkbox', { name: /Exportar informações da NF/ }));
    await usuario.click(screen.getByRole('button', { name: 'Exportar Produtos' }));
    await waitFor(() =>
      expect(salvarArquivo).toHaveBeenCalledWith(
        expect.anything(),
        'Exportacao_Produtos_10_11_2026_10_00.xlsx',
      ),
    );
    expect(pedido(chamadas, '/api/produtos/exportacao')).toEqual({
      lojaId: LOJA,
      informacoesNf: 'true',
      ncmInvalido: 'false',
      estoqueZerado: 'true',
      somenteAtivos: 'true',
      formato: 'xlsx',
    });
  });

  it('o CD (estoque sem loja) vai como estoqueId; acima de 5.000 linhas mostra a tarefa', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api(['produtos.ver', 'relatorios.exportar', 'estoques.ver'], { tarefa: true });
    renderizarComSessao(<Exportacao />, '/produtos/exportacao');
    await usuario.click(await screen.findByRole('combobox', { name: 'Loja' }));
    await usuario.click(
      await screen.findByRole('option', { name: 'CD - Estoque Teste (só o estoque)', hidden: true }),
    );
    await usuario.click(screen.getByRole('button', { name: 'Exportar Produtos' }));
    const aviso = await screen.findByTestId('exportacao-em-tarefa');
    expect(within(aviso).getByText('Exportação em segundo plano · 12.000 linhas')).toBeInTheDocument();
    expect(await within(aviso).findByText(/4\.800 de 12\.000 linhas/)).toBeInTheDocument();
    expect(salvarArquivo).not.toHaveBeenCalled();
    expect(pedido(chamadas, '/api/produtos/exportacao')).toMatchObject({
      estoqueId: CD,
      estoqueZerado: 'false',
    });
  });

  it('Exportar Clientes com a permissão de pessoas: só o "Somente ativos" e o formato', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = api(['produtos.ver', 'pessoas.ver', 'pessoas.exportar']);
    renderizarComSessao(<Exportacao />, '/produtos/exportacao');
    expect(await screen.findByRole('button', { name: 'Exportar Produtos' })).toBeDisabled();
    await usuario.click(screen.getByRole('radio', { name: 'CSV' }));
    await usuario.click(screen.getByRole('checkbox', { name: 'Somente ativos' }));
    await usuario.click(screen.getByRole('button', { name: 'Exportar Clientes' }));
    await waitFor(() =>
      expect(salvarArquivo).toHaveBeenCalledWith(
        expect.anything(),
        'Exportacao_Clientes_10_11_2026_10_00.csv',
      ),
    );
    expect(pedido(chamadas, '/api/pessoas/exportacao')).toEqual({ somenteAtivos: 'false', formato: 'csv' });
  });
});
