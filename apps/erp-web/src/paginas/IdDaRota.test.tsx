import { PERMISSOES } from '@genesis/shared';
import { screen, waitFor } from '@testing-library/react';
import type { RouteObject } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rotas } from '../rotas';
import { renderizarComSessao, renderizarRotas, rotasSessao, simularApi } from '../teste/utilidades';
import { FormularioPerfil } from './perfis/Perfis';
import { FormularioUsuario } from './usuarios/FormularioUsuario';

/**
 * Ids de rota (README do ERP › decisão 85): a tela de um registro só fala com a rota da API do próprio tipo; um `:id`
 * que não é um id de registro é "não encontrado", sem nenhuma chamada à API com ele.
 */

afterEach(() => vi.unstubAllGlobals());

const ALVO = '0193bbbb-0000-7000-8000-000000000002';
const TODAS = PERMISSOES.map((p) => p.chave);

/** Endereços (crus, como o `fetch` recebeu) das chamadas feitas. */
const enderecos = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((c) => String(c[0]));

/** Nenhuma chamada citou o valor, cru ou depois de o navegador resolver o endereço. */
function semChamadaCom(
  mock: { mock: { calls: unknown[][] } },
  chamadas: Array<{ url: URL }>,
  valor: string,
): void {
  expect(enderecos(mock).filter((e) => e.includes(valor))).toEqual([]);
  expect(chamadas.filter((c) => c.url.pathname.includes(valor)).map((c) => c.url.pathname)).toEqual([]);
}

/** Todas as rotas da árvore, com o caminho completo. */
function caminhos(lista: RouteObject[], prefixo = ''): string[] {
  return lista.flatMap((r) => {
    const atual = r.path
      ? r.path.startsWith('/')
        ? r.path
        : `${prefixo.replace(/\/$/, '')}/${r.path}`
      : prefixo;
    return [...(r.path ? [atual] : []), ...caminhos(r.children ?? [], atual)];
  });
}

describe('id da rota fora do formato de registro', () => {
  it('link da tela de perfis com o id de um usuário embutido: "não encontrado" e nada pedido ao usuário', async () => {
    const { mock, chamadas } = simularApi(...rotasSessao({ permissoes: TODAS }));
    renderizarRotas(rotas, `/cadastros/perfis/..%2Fusuarios%2F${ALVO}`);
    expect(await screen.findByText('Página não encontrada')).toBeInTheDocument();
    semChamadaCom(mock, chamadas, ALVO);
    expect(screen.queryByRole('button', { name: /Excluir/ })).not.toBeInTheDocument();
  });

  it('o mesmo no sentido contrário (tela de usuários com o id de um perfil)', async () => {
    const { mock, chamadas } = simularApi(...rotasSessao({ permissoes: TODAS }));
    renderizarRotas(rotas, `/cadastros/usuarios/..%2Fperfis%2F${ALVO}`);
    expect(await screen.findByText('Página não encontrada')).toBeInTheDocument();
    semChamadaCom(mock, chamadas, ALVO);
  });

  it('login com `voltar` que esconde outro caminho volta para o início, sem chamar a API com o id', async () => {
    const { mock, chamadas } = simularApi(...rotasSessao({ permissoes: TODAS }));
    const { router } = renderizarRotas(
      rotas,
      `/login?voltar=%2Fcadastros%2Fperfis%2F..%252Fusuarios%252F${ALVO}`,
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    semChamadaCom(mock, chamadas, ALVO);
  });

  it('toda rota com `:id` (e o `:codigo` da empresa no painel) recusa o id fora do formato antes da tela', async () => {
    const comId = caminhos(rotas).filter((c) => /\/:(id|codigo)(\/|$|\?)/.test(c));
    // As telas de registro do ERP e a da empresa no painel (a lista cresce com as telas novas).
    expect(comId.length).toBeGreaterThanOrEqual(20);
    for (const caminho of comId) {
      const plataforma = caminho.startsWith('/plataforma');
      const url = caminho
        .replace(/\/:aba\?$/, '')
        .replace(/:(id|codigo)/, 'nao-e-id')
        .replace(/\/:aba\?/, '');
      vi.unstubAllGlobals();
      const { mock, chamadas } = simularApi(...rotasSessao({ permissoes: TODAS }), ({ url: u, metodo }) =>
        metodo === 'POST' && u.pathname === '/api/plataforma/auth/refresh'
          ? {
              corpo: {
                tokenAcesso: 'tok',
                expiraEm: new Date(Date.now() + 15 * 60_000).toISOString(),
                admin: { id: 'a1', nome: 'Super', email: 'super@genesis.dev', papel: 'super' },
              },
            }
          : undefined,
      );
      const r = renderizarRotas(rotas, url);
      expect(
        await screen.findByText('Página não encontrada', {}, { timeout: 3000 }),
        url,
      ).toBeInTheDocument();
      expect(r.router.state.location.pathname, caminho).toBe(url);
      semChamadaCom(mock, chamadas, 'nao-e-id');
      if (plataforma)
        expect(screen.getByRole('link', { name: 'Voltar ao início' })).toHaveAttribute(
          'href',
          '/plataforma/empresas',
        );
      r.unmount();
    }
  }, 60_000);

  it('o formulário de cadastro (useCadastro) também recusa sozinho o id fora do formato', async () => {
    const { mock, chamadas } = simularApi(...rotasSessao({ permissoes: TODAS }));
    renderizarComSessao(<FormularioPerfil />, '/cadastros/perfis/nao-e-id', 'cadastros/perfis/:id/:aba?');
    expect(await screen.findByText('Página não encontrada')).toBeInTheDocument();
    semChamadaCom(mock, chamadas, 'nao-e-id');
  });

  it('o formulário de usuários também recusa sozinho o id fora do formato', async () => {
    const { mock, chamadas } = simularApi(...rotasSessao({ permissoes: TODAS }));
    renderizarComSessao(
      <FormularioUsuario />,
      '/cadastros/usuarios/nao-e-id',
      'cadastros/usuarios/:id/:aba?',
    );
    expect(await screen.findByText('Página não encontrada')).toBeInTheDocument();
    semChamadaCom(mock, chamadas, 'nao-e-id');
  });

  it('o id de registro segue abrindo o registro do tipo da tela', async () => {
    const { chamadas } = simularApi(...rotasSessao({ permissoes: TODAS }), ({ url }) =>
      url.pathname === `/api/perfis/${ALVO}`
        ? {
            corpo: {
              id: ALVO,
              nome: 'CAIXA',
              descricao: null,
              ativo: true,
              sistema: false,
              permissoes: [],
              versao: 1,
              criadoEm: '2026-01-01T00:00:00Z',
              atualizadoEm: '2026-01-01T00:00:00Z',
            },
          }
        : undefined,
    );
    renderizarRotas(rotas, `/cadastros/perfis/${ALVO}`);
    await waitFor(() => expect(chamadas.some((c) => c.url.pathname === `/api/perfis/${ALVO}`)).toBe(true));
    expect(screen.queryByText('Página não encontrada')).not.toBeInTheDocument();
  });
});
