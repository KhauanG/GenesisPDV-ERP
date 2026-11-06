import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { salvarArquivo } from '../../util/arquivos';
import { Relatorio, type ConfigRelatorio, type ResultadoRelatorio } from './Relatorio';

vi.mock('../../util/arquivos', () => ({ salvarArquivo: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

interface Linha {
  forma: string;
  total: string;
}

const RESULTADO: ResultadoRelatorio<Linha> = {
  resumo: [
    { rotulo: 'Total vendido', valor: 'R$ 150,00' },
    { rotulo: 'Vendas', valor: '3' },
  ],
  linhas: [
    { forma: 'Dinheiro', total: 'R$ 100,00' },
    { forma: 'PIX', total: 'R$ 50,00' },
  ],
  totais: { total: 'R$ 150,00' },
};

function montar({
  url = '/relatorios/vendas_forma_pagamento',
  permissoes = ['relatorios.exportar'],
  gerarAoAbrir = false,
}: { url?: string; permissoes?: string[]; gerarAoAbrir?: boolean } = {}) {
  simularApi(...rotasSessao({ permissoes }));
  const buscar = vi.fn(async () => RESULTADO);
  const exportar = vi.fn(async () => ({ blob: new Blob(['x']), nome: 'Relatorio.xlsx' }));
  const config: ConfigRelatorio<Linha> = {
    nome: 'vendas_forma_pagamento',
    titulo: 'Vendas por forma de pagamento',
    filtros: [
      { campo: 'inicio', rotulo: 'De', tipo: 'texto', padrao: '2026-10-01' },
      {
        campo: 'situacao',
        rotulo: 'Situação',
        tipo: 'selecao',
        opcoes: [
          { value: 'concluidas', label: 'Concluídas' },
          { value: 'canceladas', label: 'Canceladas' },
        ],
      },
    ],
    colunas: [
      { campo: 'forma', rotulo: 'Forma' },
      { campo: 'total', rotulo: 'Total', alinhamento: 'right' },
    ],
    chaveLinha: (l) => l.forma,
    buscar,
    exportar,
    gerarAoAbrir,
  };
  const r = renderizarComSessao(<Relatorio config={config} />, url);
  return { ...r, buscar, exportar };
}

describe('<Relatorio>', () => {
  it('só gera depois do Filtrar; filtros vão para a URL e o resultado mostra cards, tabela e totais', async () => {
    const usuario = userEvent.setup();
    const { buscar, router } = montar();
    expect(await screen.findByText('Escolha os filtros e clique em Filtrar.')).toBeInTheDocument();
    expect(buscar).not.toHaveBeenCalled();

    await usuario.clear(screen.getByLabelText('De'));
    await usuario.type(screen.getByLabelText('De'), '2026-10-15');
    await usuario.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() =>
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
        inicio: '2026-10-15',
        gerado: '1',
      }),
    );
    expect(buscar).toHaveBeenCalledWith({ inicio: '2026-10-15' }, expect.anything());
    expect(await screen.findByText('Total vendido')).toBeInTheDocument();
    expect(screen.getByText('R$ 100,00')).toBeInTheDocument();
    const tabela = screen.getByRole('table', { name: 'Vendas por forma de pagamento' });
    const rodape = within(tabela).getAllByRole('row').at(-1)!;
    expect(rodape).toHaveTextContent('Total');
    expect(rodape).toHaveTextContent('R$ 150,00');
  });

  it('link com filtros na URL já abre gerado; cabeçalho de impressão traz empresa, filtros e usuário', async () => {
    const { buscar } = montar({ url: '/relatorios/x?situacao=canceladas&gerado=1' });
    expect(await screen.findByText('PIX')).toBeInTheDocument();
    expect(buscar).toHaveBeenCalledWith({ inicio: '2026-10-01', situacao: 'canceladas' }, expect.anything());
    expect(screen.getByText('Filtros: De: 2026-10-01 · Situação: Canceladas')).toBeInTheDocument();
    expect(screen.getByText(/Emitido em .* por MARIA SILVA/)).toBeInTheDocument();
    expect(screen.getByText('Ice Beer')).toBeInTheDocument();
  });

  it('Exportar: Excel pela API; PDF e Imprimir pelo layout de impressão; exige relatorios.exportar', async () => {
    const usuario = userEvent.setup();
    const imprimir = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const { exportar, unmount } = montar({ gerarAoAbrir: true });
    await screen.findByText('PIX');
    await usuario.click(screen.getByRole('button', { name: 'Exportar' }));
    await usuario.click(await screen.findByRole('menuitem', { name: 'Excel (.xlsx)' }));
    await waitFor(() => expect(salvarArquivo).toHaveBeenCalledWith(expect.any(Blob), 'Relatorio.xlsx'));
    expect(exportar).toHaveBeenCalledWith({ inicio: '2026-10-01' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exportar' })).toBeEnabled());
    await usuario.click(screen.getByRole('button', { name: 'Exportar' }));
    await usuario.click(await screen.findByRole('menuitem', { name: 'PDF', hidden: true }));
    expect(imprimir).toHaveBeenCalledTimes(1);
    unmount();

    montar({ gerarAoAbrir: true, permissoes: [] });
    await screen.findByText('PIX');
    expect(screen.queryByRole('button', { name: 'Exportar' })).not.toBeInTheDocument();
  });
});
