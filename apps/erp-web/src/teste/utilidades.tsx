import type { RespostaEu } from '@genesis/shared';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import { criarQueryClient, Provedores } from '../App';
import { ProvedorSessao, useSessao } from '../auth/sessao';

/** Renderiza rotas num roteador em memória com os mesmos provedores do app. */
export function renderizarRotas(rotas: RouteObject[], url: string) {
  const router = createMemoryRouter(rotas, { initialEntries: [url] });
  const queryClient = criarQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  const r = render(
    <Provedores queryClient={queryClient}>
      <RouterProvider router={router} />
    </Provedores>,
  );
  return { ...r, router, queryClient };
}

export interface RespostaFalsa {
  status?: number;
  corpo?: unknown;
  /** Resposta de arquivo (exportações): conteúdo bruto e cabeçalhos. */
  arquivo?: { conteudo: string; cabecalhos: Record<string, string> };
}

type Rota = (req: {
  url: URL;
  metodo: string;
  corpo: unknown;
  cabecalhos: Headers;
}) => RespostaFalsa | undefined;

/**
 * `fetch` falso: cada rota recebe a requisição e devolve `{ status, corpo }` (ou `undefined` para a próxima).
 * Guarda as chamadas para as asserções.
 */
export function simularApi(...rotas: Rota[]) {
  const chamadas: Array<{ metodo: string; url: URL; corpo: unknown; cabecalhos: Headers }> = [];
  const mock = vi.fn(async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(entrada), 'http://localhost');
    const metodo = (init?.method ?? 'GET').toUpperCase();
    // JSON vira objeto; o multipart (upload) fica como o `FormData` enviado.
    const corpo =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : init?.body instanceof FormData
          ? init.body
          : undefined;
    const cabecalhos = new Headers(init?.headers);
    chamadas.push({ metodo, url, corpo, cabecalhos });
    for (const rota of rotas) {
      const r = rota({ url, metodo, corpo, cabecalhos });
      if (r?.arquivo) {
        return new Response(r.arquivo.conteudo, { status: r.status ?? 200, headers: r.arquivo.cabecalhos });
      }
      if (r) {
        const status = r.status ?? 200;
        return new Response(status === 204 ? null : JSON.stringify(r.corpo ?? {}), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ codigo: 'NAO_ENCONTRADO', mensagem: 'Rota não simulada' }), {
      status: 404,
    });
  });
  vi.stubGlobal('fetch', mock);
  return { mock, chamadas };
}

const EU_PADRAO: RespostaEu = {
  usuario: {
    id: '01928f3a-7c1e-7b2d-9a40-5e2f1c3d4b5a',
    codigo: 1,
    nome: 'MARIA SILVA',
    login: 'maria',
    master: false,
    senhaProvisoria: false,
  },
  empresa: { codigo: 100001, nome: 'Ice Beer' },
  permissoes: [],
  lojas: [],
  todasLojas: false,
};

/** Rotas falsas de uma sessão já aberta (refresh pelo cookie + `/auth/eu`). */
export function rotasSessao(eu: Partial<RespostaEu> = {}): Rota[] {
  const completo = { ...EU_PADRAO, ...eu };
  return [
    ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/auth/refresh'
        ? {
            corpo: {
              tokenAcesso: 'tok',
              expiraEm: new Date(Date.now() + 15 * 60_000).toISOString(),
              trocarSenha: false,
              empresa: completo.empresa,
              usuario: completo.usuario,
            },
          }
        : undefined,
    ({ url }) => (url.pathname === '/api/auth/eu' ? { corpo: completo } : undefined),
  ];
}

/**
 * Renderiza um componente da área autenticada (precisa de `rotasSessao` no `simularApi`). `caminho` dá os parâmetros
 * de rota (ex.: `cadastros/pdvs/:id`) para telas que usam `useParams`.
 */
export function renderizarComSessao(elemento: ReactNode, url = '/', caminho = '*') {
  return renderizarRotas(
    [
      {
        element: (
          <ProvedorSessao>
            <Outlet />
          </ProvedorSessao>
        ),
        children: [{ path: caminho, element: <ApenasAutenticado>{elemento}</ApenasAutenticado> }],
      },
    ],
    url,
  );
}

function ApenasAutenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}
