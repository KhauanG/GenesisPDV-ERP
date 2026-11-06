import type { UsuarioResumo } from '@genesis/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { SeletorLoja } from './SeletorLoja';
import { SeletorUsuario, type UsuarioSelecionado } from './SeletorUsuario';

afterEach(() => vi.unstubAllGlobals());

const LOJAS = [
  { id: '01928f3a-0000-7000-8000-000000000001', codigo: 1, nome: 'Centro', ativa: true },
  { id: '01928f3a-0000-7000-8000-000000000002', codigo: 2, nome: 'Bairro', ativa: false },
  { id: '01928f3a-0000-7000-8000-000000000003', codigo: 3, nome: 'CD', ativa: true },
];

function ComLoja({ inicial = null, todas = false }: { inicial?: string | null; todas?: boolean }) {
  const [v, setV] = useState<string | null>(inicial);
  return (
    <>
      <SeletorLoja label="Loja" value={v} onChange={setV} permitirTodas={todas} />
      <output>valor:{v ?? 'nenhum'}</output>
    </>
  );
}

describe('<SeletorLoja>', () => {
  it('lista só as lojas permitidas e ativas; "Todas" vale null onde a tela permite', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasSessao({ lojas: LOJAS }));
    renderizarComSessao(<ComLoja todas />);
    const campo = await screen.findByRole('combobox', { name: 'Loja' });
    expect(campo).toHaveValue('Todas as lojas');
    await usuario.click(campo);
    expect(await screen.findByRole('option', { name: '1 - Centro', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '3 - CD', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Bairro/, hidden: true })).not.toBeInTheDocument();
    await usuario.click(screen.getByRole('option', { name: '3 - CD', hidden: true }));
    expect(screen.getByText(`valor:${LOJAS[2]!.id}`)).toBeInTheDocument();
    await usuario.click(campo);
    await usuario.click(await screen.findByRole('option', { name: 'Todas as lojas', hidden: true }));
    expect(screen.getByText('valor:nenhum')).toBeInTheDocument();
  });

  it('loja inativa já gravada continua visível (marcada), sem poder ser escolhida de novo', async () => {
    simularApi(...rotasSessao({ lojas: LOJAS }));
    renderizarComSessao(<ComLoja inicial={LOJAS[1]!.id} />);
    expect(await screen.findByRole('combobox', { name: 'Loja' })).toHaveValue('2 - Bairro (inativa)');
  });
});

const USUARIOS: UsuarioResumo[] = [
  {
    id: '01928f3a-0000-7000-8000-0000000000a1',
    codigo: 7,
    nome: 'ANA VENDEDORA',
    login: 'ana',
    perfilId: null,
    perfilNome: 'Vendedor',
    master: false,
    ativo: true,
    ultimoLoginEm: null,
    versao: 1,
  },
  {
    id: '01928f3a-0000-7000-8000-0000000000a2',
    codigo: 8,
    nome: 'ANDRÉ CAIXA',
    login: 'andre',
    perfilId: null,
    perfilNome: 'Caixa',
    master: false,
    ativo: true,
    ultimoLoginEm: null,
    versao: 1,
  },
];

function ComUsuario({
  inicial = null,
  aoMudar,
}: {
  inicial?: string | null;
  aoMudar?: (u: UsuarioSelecionado | null) => void;
}) {
  const [v, setV] = useState<string | null>(inicial);
  return (
    <SeletorUsuario
      label="Usuário"
      value={v}
      lojaId={LOJAS[0]!.id}
      onChange={(id, u) => {
        setV(id);
        aoMudar?.(u);
      }}
    />
  );
}

describe('<SeletorUsuario>', () => {
  it('pesquisa no servidor a partir de 2 caracteres (nome, login ou código) e devolve o escolhido', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...rotasSessao(), ({ url }) =>
      url.pathname === '/api/usuarios'
        ? {
            corpo: {
              itens: USUARIOS.filter((u) =>
                u.nome.includes((url.searchParams.get('nome') ?? '').toUpperCase()),
              ),
              total: 2,
              pagina: 1,
              tamanho: 20,
            },
          }
        : undefined,
    );
    const aoMudar = vi.fn();
    renderizarComSessao(<ComUsuario aoMudar={aoMudar} />);
    const campo = await screen.findByRole('combobox', { name: 'Usuário' });
    await usuario.type(campo, 'a');
    expect(await screen.findByText('Digite ao menos 2 caracteres')).toBeInTheDocument();
    await usuario.type(campo, 'n');
    expect(
      await screen.findByRole('option', { name: '7 - ANA VENDEDORA', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '8 - ANDRÉ CAIXA', hidden: true })).toBeInTheDocument();
    const busca = chamadas.filter((c) => c.url.pathname === '/api/usuarios').at(-1)!;
    expect(Object.fromEntries(busca.url.searchParams)).toEqual({
      nome: 'an',
      situacao: 'ativos',
      lojaId: LOJAS[0]!.id,
      tamanho: '20',
      ordenar: 'nome:asc',
    });
    await usuario.click(screen.getByRole('option', { name: '8 - ANDRÉ CAIXA', hidden: true }));
    expect(aoMudar).toHaveBeenLastCalledWith({ id: USUARIOS[1]!.id, codigo: 8, nome: 'ANDRÉ CAIXA' });
    await waitFor(() => expect(campo).toHaveValue('8 - ANDRÉ CAIXA'));
  });

  it('valor vindo do registro/URL é resolvido por GET /usuarios/:id para mostrar o nome', async () => {
    const { chamadas } = simularApi(...rotasSessao(), ({ url }) =>
      url.pathname === `/api/usuarios/${USUARIOS[0]!.id}` ? { corpo: USUARIOS[0] } : undefined,
    );
    renderizarComSessao(<ComUsuario inicial={USUARIOS[0]!.id} />);
    const campo = await screen.findByRole('combobox', { name: 'Usuário' });
    await waitFor(() => expect(campo).toHaveValue('7 - ANA VENDEDORA'));
    // Mostrar o nome do selecionado não dispara uma pesquisa com o próprio rótulo.
    expect(chamadas.some((c) => c.url.pathname === '/api/usuarios')).toBe(false);
  });
});
