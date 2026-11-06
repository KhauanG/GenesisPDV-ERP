import type { Pagina } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProvedorPermissoes } from '../../auth/permissoes';
import { renderizarRotas } from '../../teste/utilidades';
import { salvarArquivo } from '../../util/arquivos';
import { Listagem, type ConfigListagem } from './Listagem';

vi.mock('../../util/arquivos', () => ({ salvarArquivo: vi.fn() }));

interface Item {
  id: string;
  codigo: number;
  nome: string;
  ativo: boolean;
}

const itens = (n: number, inicio = 1): Item[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `id-${inicio + i}`,
    codigo: inicio + i,
    nome: `Item ${inicio + i}`,
    ativo: true,
  }));

function montar({
  url = '/itens',
  total = 3,
  permissoes = ['itens.criar'],
  buscar,
  exportar = vi.fn(async () => ({ blob: new Blob(['x']), nome: 'Itens.xlsx' })),
}: {
  url?: string;
  total?: number;
  permissoes?: string[];
  buscar?: ConfigListagem<Item>['buscar'];
  exportar?: ConfigListagem<Item>['exportar'];
} = {}) {
  const fonte =
    buscar ??
    vi.fn(async (params: Record<string, string>): Promise<Pagina<Item>> => {
      const tamanho = params.tamanho === 'todos' ? total : Number(params.tamanho);
      const pagina = Number(params.pagina);
      const inicio = (pagina - 1) * tamanho + 1;
      return {
        itens: itens(Math.max(0, Math.min(tamanho, total - inicio + 1)), inicio),
        total,
        pagina,
        tamanho: tamanho,
      };
    });
  const config: ConfigListagem<Item> = {
    recurso: 'itens',
    titulo: 'Itens de teste',
    ordenacaoPadrao: 'nome:asc',
    rotaNovo: '/itens/novo',
    rotuloNovo: 'Novo item',
    rotaEdicao: (l) => `/itens/${l.id}`,
    chaveLinha: (l) => l.id,
    filtros: [
      { campo: 'nome', rotulo: 'Nome', tipo: 'texto' },
      {
        campo: 'situacao',
        rotulo: 'Situação',
        tipo: 'selecao',
        padrao: 'ativos',
        opcoes: [
          { value: 'ativos', label: 'Ativos' },
          { value: 'todos', label: 'Todos' },
        ],
      },
    ],
    colunas: [
      { campo: 'codigo', rotulo: 'Cód.', ordenavel: true },
      { campo: 'nome', rotulo: 'Nome', ordenavel: true },
      { campo: 'ativo', rotulo: 'Ativo', formato: (l) => (l.ativo ? 'Sim' : 'Não') },
    ],
    buscar: fonte,
    exportar,
  };
  const pode = (c: string) => permissoes.includes(c);
  const r = renderizarRotas(
    [
      {
        path: '/itens',
        element: (
          <ProvedorPermissoes value={pode}>
            <Listagem config={config} />
          </ProvedorPermissoes>
        ),
      },
      { path: '/itens/:id', element: <p>Formulário aberto</p> },
    ],
    url,
  );
  const busca = () => new URLSearchParams(r.router.state.location.search);
  return { ...r, fonte: fonte as ReturnType<typeof vi.fn>, busca };
}

describe('<Listagem>', () => {
  it('abre já pesquisando com os filtros padrão e mostra linhas e total', async () => {
    const { fonte } = montar();
    expect(await screen.findByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('3 registros')).toBeInTheDocument();
    expect(fonte).toHaveBeenCalledWith(
      { pagina: '1', tamanho: '20', ordenar: 'nome:asc', situacao: 'ativos' },
      expect.anything(),
    );
    expect(screen.getByRole('columnheader', { name: /Nome/ })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('filtros vão para a URL ao pesquisar (Enter) e Limpar restaura o padrão mantendo a ordenação', async () => {
    const usuario = userEvent.setup();
    const { fonte, busca } = montar({ url: '/itens?ordenar=codigo:desc' });
    await screen.findByText('Item 1');
    await usuario.type(screen.getByLabelText('Nome'), 'agua{Enter}');
    await waitFor(() => expect(busca().get('nome')).toBe('agua'));
    expect(fonte).toHaveBeenLastCalledWith(
      expect.objectContaining({ nome: 'agua', pagina: '1' }),
      expect.anything(),
    );

    await usuario.click(screen.getByRole('button', { name: 'Limpar' }));
    await waitFor(() => expect(busca().get('nome')).toBeNull());
    expect(busca().get('ordenar')).toBe('codigo:desc');
    expect(screen.getByLabelText('Nome')).toHaveValue('');
  });

  it('carrega filtros, página e tamanho que vêm na URL (link compartilhado / voltar do formulário)', async () => {
    const { fonte } = montar({ url: '/itens?nome=cerveja&situacao=todos&pagina=2&tamanho=25', total: 40 });
    expect(await screen.findByText('Item 26')).toBeInTheDocument();
    expect(fonte).toHaveBeenCalledWith(
      { pagina: '2', tamanho: '25', ordenar: 'nome:asc', nome: 'cerveja', situacao: 'todos' },
      expect.anything(),
    );
    expect(screen.getByLabelText('Nome')).toHaveValue('cerveja');
    expect(screen.getByText('página 2 de 2')).toBeInTheDocument();
  });

  it('cabeçalho ordenável alterna asc → desc → padrão na URL', async () => {
    const usuario = userEvent.setup();
    const { busca } = montar();
    await screen.findByText('Item 1');
    await usuario.click(screen.getByRole('button', { name: 'Ordenar por Cód.' }));
    await waitFor(() => expect(busca().get('ordenar')).toBe('codigo:asc'));
    await usuario.click(screen.getByRole('button', { name: 'Ordenar por Cód.' }));
    await waitFor(() => expect(busca().get('ordenar')).toBe('codigo:desc'));
    expect(screen.getByRole('columnheader', { name: /Cód/ })).toHaveAttribute('aria-sort', 'descending');
    await usuario.click(screen.getByRole('button', { name: 'Ordenar por Cód.' }));
    await waitFor(() => expect(busca().get('ordenar')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Ordenar por Ativo' })).not.toBeInTheDocument();
  });

  it('paginação Primeiro/Ant./Próx./Último e tamanho 20/25/35/50/Todos lembrado no navegador', async () => {
    const usuario = userEvent.setup();
    const { busca } = montar({ total: 45 });
    expect(await screen.findByText('página 1 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(busca().get('pagina')).toBe('2'));
    await usuario.click(screen.getByRole('button', { name: 'Última página' }));
    await waitFor(() => expect(busca().get('pagina')).toBe('3'));
    expect(await screen.findByText('Item 45')).toBeInTheDocument();

    const seletor = screen.getAllByLabelText('Registros por página').find((e) => e.tagName === 'INPUT')!;
    await usuario.click(seletor);
    await waitFor(() => expect(seletor).toHaveAttribute('aria-controls'));
    const lista = document.getElementById(seletor.getAttribute('aria-controls')!)!;
    const opcoes = within(lista).getAllByRole('option', { hidden: true });
    expect(opcoes.map((o) => o.textContent)).toEqual(['20', '25', '35', '50', 'Todos']);
    await usuario.click(within(lista).getByRole('option', { name: 'Todos', hidden: true }));
    await waitFor(() => expect(busca().get('tamanho')).toBe('todos'));
    expect(busca().get('pagina')).toBeNull();
    expect(window.localStorage.getItem('genesis:listagem:itens:tamanho')).toBe('todos');
    expect(await screen.findByText('página 1 de 1')).toBeInTheDocument();
  });

  it('clique na 1ª coluna (link) ou na linha abre o formulário; Novo só com a permissão', async () => {
    const usuario = userEvent.setup();
    const { router } = montar();
    const link = await screen.findByRole('link', { name: '1' });
    expect(link).toHaveAttribute('href', '/itens/id-1');
    expect(screen.getByRole('link', { name: 'Novo item' })).toHaveAttribute('href', '/itens/novo');
    const linha = screen.getByText('Item 2').closest('tr')!;
    await usuario.click(within(linha).getByText('Sim'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/itens/id-2'));
    expect(screen.getByText('Formulário aberto')).toBeInTheDocument();
  });

  it('sem `<recurso>.criar` não mostra Novo; Exportar exige permissão', async () => {
    montar({ permissoes: ['relatorios.exportar'] });
    await screen.findByText('Item 1');
    expect(screen.queryByRole('link', { name: 'Novo item' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exportar' })).toBeInTheDocument();
  });

  it('Exportar baixa o arquivo com os filtros e a ordenação atuais, sem paginação', async () => {
    const usuario = userEvent.setup();
    const exportar = vi.fn(async () => ({ blob: new Blob(['x']), nome: 'Itens_30_10_2026_10_00.csv' }));
    montar({
      url: '/itens?nome=agua&ordenar=codigo:desc&pagina=2&tamanho=50',
      permissoes: ['itens.exportar'],
      exportar,
    });
    await usuario.click(await screen.findByRole('button', { name: 'Exportar' }));
    await usuario.click(await screen.findByRole('menuitem', { name: 'CSV' }));
    await waitFor(() =>
      expect(salvarArquivo).toHaveBeenCalledWith(expect.any(Blob), 'Itens_30_10_2026_10_00.csv'),
    );
    expect(exportar).toHaveBeenCalledWith(
      { nome: 'agua', situacao: 'ativos', ordenar: 'codigo:desc' },
      'csv',
    );
  });

  it('sem a função de exportação ou sem permissão, não há Exportar; erro da exportação vira aviso', async () => {
    const usuario = userEvent.setup();
    const { unmount } = montar({ permissoes: [] });
    await screen.findByText('Item 1');
    expect(screen.queryByRole('button', { name: 'Exportar' })).not.toBeInTheDocument();
    unmount();

    montar({
      permissoes: ['relatorios.exportar'],
      exportar: vi.fn(async () => {
        throw new Error('A exportação passa de 50.000 linhas.');
      }),
    });
    await screen.findByText('Item 1');
    await usuario.click(screen.getByRole('button', { name: 'Exportar' }));
    await usuario.click(await screen.findByRole('menuitem', { name: 'Excel (.xlsx)' }));
    expect(await screen.findByText('A exportação passa de 50.000 linhas.')).toBeInTheDocument();
  });

  it('vazio mostra a mensagem com Limpar filtros; erro mostra a faixa com Tentar novamente', async () => {
    const usuario = userEvent.setup();
    let falhar = true;
    const buscar = vi.fn(async () => {
      if (falhar) throw new Error('Servidor indisponível');
      return { itens: [], total: 0, pagina: 1, tamanho: 20 as const };
    });
    montar({ buscar });
    expect(await screen.findByRole('alert')).toHaveTextContent('Servidor indisponível');
    falhar = false;
    await usuario.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByText('Nenhum registro encontrado com os filtros informados.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toBeInTheDocument();
  });
});
