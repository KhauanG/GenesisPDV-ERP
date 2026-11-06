import type { TipoEstoqueDetalhe, TipoEstoqueOpcao } from '@genesis/shared';
import { useQuery } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioTipoEstoque, TiposEstoque } from './TiposEstoque';

afterEach(() => vi.unstubAllGlobals());

const id = (n: number) => `0190a000-0000-7000-8000-0000000000d${n}`;
const TIPOS: TipoEstoqueOpcao[] = [
  {
    id: id(1),
    nome: 'Disponível',
    vendavel: true,
    padrao: true,
    ativo: true,
    chaveSistema: 'disponivel',
    versao: 1,
  },
  {
    id: id(2),
    nome: 'Avaria',
    vendavel: false,
    padrao: false,
    ativo: true,
    chaveSistema: 'avaria',
    versao: 1,
  },
  {
    id: id(3),
    nome: 'Vasilhame vazio',
    vendavel: false,
    padrao: false,
    ativo: true,
    chaveSistema: 'vasilhame_vazio',
    versao: 1,
  },
  { id: id(4), nome: 'Quebra', vendavel: false, padrao: false, ativo: true, chaveSistema: null, versao: 4 },
];
const TODAS = ['tipos_estoque.ver', 'tipos_estoque.criar', 'tipos_estoque.editar', 'tipos_estoque.excluir'];

const detalhe = (t: TipoEstoqueOpcao): TipoEstoqueDetalhe => ({
  ...t,
  criadoEm: '2026-11-01T12:00:00.000Z',
  atualizadoEm: '2026-11-01T12:00:00.000Z',
  atualizadoPorNome: 'MARIA SILVA',
});

const rotasTipos = [
  ({ url, metodo }: { url: URL; metodo: string }) =>
    metodo === 'GET' && url.pathname === '/api/tipos-estoque' ? { corpo: TIPOS } : undefined,
  ({ url, metodo }: { url: URL; metodo: string }) => {
    const t = TIPOS.find((x) => url.pathname === `/api/tipos-estoque/${x.id}`);
    return metodo === 'GET' && t ? { corpo: detalhe(t) } : undefined;
  },
];

const abrir = (t: TipoEstoqueOpcao) =>
  renderizarComSessao(<FormularioTipoEstoque />, `/estoque/tipos/${t.id}`, 'estoque/tipos/:id');

/** O seletor do acerto e dos saldos (`['opcoes', 'tipos-estoque']`, staleTime longo) montado junto do formulário. */
function SeletorTipos() {
  const q = useQuery({
    queryKey: ['opcoes', 'tipos-estoque'],
    queryFn: () => fetch('/api/tipos-estoque?seletor=1').then((r) => r.json() as Promise<TipoEstoqueOpcao[]>),
    staleTime: 5 * 60_000,
  });
  return <span>{q.data ? `${q.data.length} tipos no seletor` : ''}</span>;
}

describe('<TiposEstoque> – listagem (ERP 13.6)', () => {
  it('mostra o uso pela chave de sistema (Avaria, não "avariado"), o link de edição e o Novo tipo', async () => {
    simularApi(...rotasSessao({ permissoes: TODAS }), ...rotasTipos);
    renderizarComSessao(<TiposEstoque />, '/estoque/tipos');
    const tabela = await screen.findByRole('table', { name: 'Tipos de estoque' });
    const avaria = within(tabela).getByRole('link', { name: 'Avaria' }).closest('tr')!;
    expect(avaria).toHaveTextContent('Avariado: não vende; aguarda troca ou baixa');
    expect(within(tabela).getByRole('link', { name: 'Avaria' })).toHaveAttribute(
      'href',
      `/estoque/tipos/${id(2)}`,
    );
    expect(within(tabela).getByRole('link', { name: 'Quebra' }).closest('tr')).toHaveTextContent('—');
    // De onde o caixa vende vem do padrão, não da chave do Disponível.
    expect(within(tabela).getByRole('link', { name: 'Disponível' }).closest('tr')).toHaveTextContent(
      'Mercadoria à venda (o padrão de fábrica); as vendas do caixa baixam deste tipo',
    );
    expect(screen.getByRole('link', { name: /Novo tipo/ })).toHaveAttribute('href', '/estoque/tipos/novo');
  });

  it('sem permissão de criar, sem o botão Novo tipo', async () => {
    simularApi(...rotasSessao({ permissoes: ['tipos_estoque.ver'] }), ...rotasTipos);
    renderizarComSessao(<TiposEstoque />, '/estoque/tipos');
    await screen.findByRole('table', { name: 'Tipos de estoque' });
    expect(screen.queryByRole('link', { name: /Novo tipo/ })).not.toBeInTheDocument();
  });
});

describe('<FormularioTipoEstoque> (ERP 13.6)', () => {
  it('Disponível: vendável, padrão e ativo travados, sem Excluir', async () => {
    simularApi(...rotasSessao({ permissoes: TODAS }), ...rotasTipos);
    abrir(TIPOS[0]!);
    expect(await screen.findByDisplayValue('Disponível')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /^Vendável/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /^Padrão/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Ativo' })).toBeDisabled();
    expect(screen.getByText(/Sempre há um tipo padrão/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Excluir/ })).not.toBeInTheDocument();
  });

  it('Vasilhame vazio: vendável, ativo e padrão travados (o padrão é sempre vendável)', async () => {
    simularApi(...rotasSessao({ permissoes: TODAS }), ...rotasTipos);
    abrir(TIPOS[2]!);
    expect(await screen.findByDisplayValue('Vasilhame vazio')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /^Vendável/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Ativo' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /^Padrão/ })).toBeDisabled();
    expect(screen.getByText(/não pode ser o padrão: os cascos vazios não se vendem/)).toBeInTheDocument();
  });

  it('desmarcar o "Padrão" recém marcado devolve o vendável e o ativo de antes', async () => {
    const u = userEvent.setup();
    simularApi(...rotasSessao({ permissoes: TODAS }), ...rotasTipos);
    abrir(TIPOS[3]!);
    expect(await screen.findByDisplayValue('Quebra')).toBeInTheDocument();
    const vendavel = () => screen.getByRole('switch', { name: /^Vendável/ });
    await u.click(screen.getByRole('switch', { name: /^Padrão/ }));
    expect(vendavel()).toBeChecked();
    await u.click(screen.getByRole('switch', { name: /^Padrão/ }));
    expect(vendavel()).not.toBeChecked();
    expect(vendavel()).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Ativo' })).toBeChecked();
    expect(screen.queryByText('Trocar o tipo padrão')).not.toBeInTheDocument();
  });

  it('excluir invalida também a lista dos seletores do acerto e dos saldos', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: TODAS }),
      ({ url, metodo }) =>
        metodo === 'DELETE' && url.pathname === `/api/tipos-estoque/${id(4)}` ? { status: 204 } : undefined,
      ...rotasTipos,
    );
    renderizarComSessao(
      <>
        <FormularioTipoEstoque />
        <SeletorTipos />
      </>,
      `/estoque/tipos/${id(4)}`,
      'estoque/tipos/:id',
    );
    expect(await screen.findByText('4 tipos no seletor')).toBeInTheDocument();
    const doSeletor = () => chamadas.filter((c) => c.url.search === '?seletor=1').length;
    expect(doSeletor()).toBe(1);
    await u.click(screen.getByRole('button', { name: /Excluir/ }));
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'DELETE')).toBe(true));
    await waitFor(() => expect(doSeletor()).toBe(2));
  });

  it('mudar o vendável avisa da ressincronização e grava com a versão', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: TODAS }),
      ({ url, metodo }) =>
        metodo === 'PUT' && url.pathname === `/api/tipos-estoque/${id(2)}`
          ? {
              corpo: {
                ...detalhe({ ...TIPOS[1]!, vendavel: true, versao: 2 }),
                terminaisRessincronizados: 3,
              },
            }
          : undefined,
      ...rotasTipos,
    );
    abrir(TIPOS[1]!);
    expect(await screen.findByDisplayValue('Avaria')).toBeInTheDocument();
    expect(screen.queryByText('Os PDVs vão ressincronizar o estoque')).not.toBeInTheDocument();
    await u.click(screen.getByRole('switch', { name: /^Vendável/ }));
    expect(screen.getByText('Os PDVs vão ressincronizar o estoque')).toBeInTheDocument();
    expect(screen.getByText(/passa a descer para o caixa/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toEqual({
      nome: 'Avaria',
      vendavel: true,
      padrao: false,
      ativo: true,
      versao: 1,
    });
    expect(await screen.findByText('3 PDV(s) vão ressincronizar o estoque.')).toBeInTheDocument();
  });

  it('marcar como padrão força vendável e ativo e avisa que o padrão atual deixa de sê-lo', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: TODAS }),
      ({ url, metodo }) =>
        metodo === 'PUT' && url.pathname === `/api/tipos-estoque/${id(4)}`
          ? { corpo: detalhe({ ...TIPOS[3]!, vendavel: true, padrao: true, versao: 5 }) }
          : undefined,
      ...rotasTipos,
    );
    abrir(TIPOS[3]!);
    expect(await screen.findByDisplayValue('Quebra')).toBeInTheDocument();
    // Tipo da empresa, nunca padrão: pode ser excluído (a API recusa o já usado).
    expect(screen.getByRole('button', { name: /Excluir/ })).toBeInTheDocument();
    await u.click(screen.getByRole('switch', { name: /^Padrão/ }));
    expect(screen.getByRole('switch', { name: /^Vendável/ })).toBeChecked();
    expect(screen.getByRole('switch', { name: /^Vendável/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Ativo' })).toBeDisabled();
    expect(screen.getByText('Trocar o tipo padrão')).toBeInTheDocument();
    expect(screen.getByText(/"Disponível" deixa de ser o padrão/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    expect(chamadas.find((c) => c.metodo === 'PUT')!.corpo).toMatchObject({
      padrao: true,
      vendavel: true,
      ativo: true,
      versao: 4,
    });
  });

  it('novo tipo nasce não vendável e mostra o erro de nome repetido da API', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: TODAS }),
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/tipos-estoque'
          ? {
              status: 409,
              corpo: {
                codigo: 'CONFLITO',
                mensagem: 'Já existe um registro com estes dados.',
                campos: { nome: ['Já existe um tipo de estoque com este nome'] },
              },
            }
          : undefined,
      ...rotasTipos,
    );
    renderizarComSessao(<FormularioTipoEstoque />, '/estoque/tipos/novo', 'estoque/tipos/novo');
    expect(await screen.findByText('Novo tipo de estoque')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /^Vendável/ })).not.toBeChecked();
    await u.type(screen.getByLabelText(/^Nome/), 'Quebra');
    await u.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByText('Já existe um tipo de estoque com este nome')).toBeInTheDocument();
    expect(
      chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/tipos-estoque')!.corpo,
    ).toEqual({
      nome: 'Quebra',
      vendavel: false,
      padrao: false,
      ativo: true,
    });
  });
});
