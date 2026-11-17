import type { RespostaEu, RespostaLogin } from '@genesis/shared';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { criarCliente, type OpcoesCliente } from '../api/http';
import { rotas } from '../rotas';
import { renderizarRotas, simularApi, type RespostaFalsa } from '../teste/utilidades';
import { INTERVALO_NOVA_SAIDA_MS } from './sessao';

/**
 * "Sair" confirmado pelo servidor (ERP 4.4; README do ERP › decisão 82): a saída só vale com o 2xx do logout; sem ele
 * o navegador fica fechado (marcador de saída pendente) e não renova a sessão pelo cookie até o logout dar certo.
 */

const USUARIO = {
  id: '01928f3a-7c1e-7b2d-9a40-5e2f1c3d4b5a',
  codigo: 1,
  nome: 'MARIA SILVA',
  login: 'maria',
  master: true,
  senhaProvisoria: false,
};
const EMPRESA = { codigo: 100001, nome: 'Ice Beer' };

const sessao = (): RespostaLogin => ({
  tokenAcesso: 'tok-1',
  expiraEm: new Date(Date.now() + 15 * 60_000).toISOString(),
  trocarSenha: false,
  empresa: EMPRESA,
  usuario: USUARIO,
});

const eu: RespostaEu = {
  usuario: USUARIO,
  empresa: EMPRESA,
  permissoes: ['dashboard.ver'],
  lojas: [],
  todasLojas: false,
};

type Falha = 'rede' | 'erro' | null;
type Req = { url: URL; metodo: string };

/**
 * Servidor falso com estado, como a API: o cookie de refresh vale até um logout responder 204. `falha` faz o logout
 * cair (sem conexão ou 500) sem encerrar nada.
 */
function servidor(prefixo: '/api' | '/api/plataforma', corpoSessao: () => unknown) {
  const estado = { cookieValido: true, falha: null as Falha };
  const rotasFalsas = [
    ({ url, metodo }: Req): RespostaFalsa | undefined => {
      if (metodo !== 'POST' || url.pathname !== `${prefixo}/auth/logout`) return undefined;
      if (estado.falha === 'rede') throw new TypeError('Failed to fetch');
      if (estado.falha === 'erro')
        return { status: 500, corpo: { codigo: 'ERRO_INTERNO', mensagem: 'Erro' } };
      estado.cookieValido = false;
      return { status: 204 };
    },
    ({ url, metodo }: Req): RespostaFalsa | undefined =>
      metodo === 'POST' && url.pathname === `${prefixo}/auth/refresh`
        ? estado.cookieValido
          ? { corpo: corpoSessao() }
          : { status: 401, corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'Sessão expirada' } }
        : undefined,
  ];
  return { estado, rotasFalsas };
}

/**
 * Servidor falso com o cookie do navegador, que as abas compartilham: o login grava um cookie novo; o logout encerra
 * a sessão do cookie apresentado (a família, decisão 206 da API) e apaga o cookie.
 */
function servidorComCookie(prefixo: '/api' | '/api/plataforma', corpoSessao: () => unknown) {
  const estado = {
    cookie: 'velho' as string | null,
    encerrados: [] as string[],
    falha: null as Falha,
    logins: 0,
  };
  const rotasFalsas = [
    ({ url, metodo }: Req): RespostaFalsa | undefined => {
      if (metodo !== 'POST' || url.pathname !== `${prefixo}/auth/logout`) return undefined;
      if (estado.falha === 'rede') throw new TypeError('Failed to fetch');
      if (estado.falha === 'erro')
        return { status: 500, corpo: { codigo: 'ERRO_INTERNO', mensagem: 'Erro' } };
      if (estado.cookie) estado.encerrados.push(estado.cookie);
      estado.cookie = null;
      return { status: 204 };
    },
    ({ url, metodo }: Req): RespostaFalsa | undefined => {
      if (metodo !== 'POST' || url.pathname !== `${prefixo}/auth/login`) return undefined;
      estado.cookie = `novo-${++estado.logins}`;
      return { corpo: corpoSessao() };
    },
    ({ url, metodo }: Req): RespostaFalsa | undefined =>
      metodo === 'POST' && url.pathname === `${prefixo}/auth/refresh`
        ? estado.cookie && !estado.encerrados.includes(estado.cookie)
          ? { corpo: corpoSessao() }
          : { status: 401, corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'Sessão expirada' } }
        : undefined,
  ];
  return { estado, rotasFalsas };
}

/** Os mesmos parâmetros de `apiErp` / `apiPlataforma` (`src/api/clientes.ts`): a "outra aba" é outro cliente. */
const OPCOES_ERP: OpcoesCliente = {
  base: '/api',
  caminhoRefresh: '/auth/refresh',
  caminhoLogout: '/auth/logout',
  nomeTrava: 'genesis-erp-refresh',
  chaveSaidaPendente: 'genesis:erp-saida-pendente',
};
const OPCOES_PLATAFORMA: OpcoesCliente = {
  base: '/api/plataforma',
  caminhoRefresh: '/auth/refresh',
  caminhoLogout: '/auth/logout',
  nomeTrava: 'genesis-plataforma-refresh',
  chaveSaidaPendente: 'genesis:plataforma-saida-pendente',
};

/** Só os temporizadores falsos (o intervalo da nova tentativa), andando também com o relógio real. */
function relogioFalso() {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  return { avancar: (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms)) };
}

/** `BroadcastChannel` falso: guarda o que a aba manda e deixa o teste entregar mensagens "de outra aba". */
class CanalFalso {
  static enviadas: unknown[] = [];
  static abertos = new Set<CanalFalso>();
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {
    CanalFalso.abertos.add(this);
  }
  postMessage(dados: unknown) {
    CanalFalso.enviadas.push(dados);
  }
  close() {
    CanalFalso.abertos.delete(this);
  }
  static deOutraAba(dados: unknown) {
    for (const c of CanalFalso.abertos) c.onmessage?.({ data: dados } as MessageEvent);
  }
}

const AVISO = /A saída não foi confirmada pelo servidor/;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  CanalFalso.enviadas = [];
  CanalFalso.abertos.clear();
});

describe('Sair do ERP', () => {
  it.each(['rede', 'erro'] as const)(
    'logout que falha (%s) não vale como saída: avisa, e a próxima abertura não entra de novo',
    async (falha) => {
      const srv = servidor('/api', sessao);
      const { chamadas } = simularApi(...srv.rotasFalsas, ({ url }) =>
        url.pathname === '/api/auth/eu' ? { corpo: eu } : undefined,
      );
      const primeira = renderizarRotas(rotas, '/');
      expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
      srv.estado.falha = falha;
      await primeira.router.navigate('/sair');
      expect(await screen.findByText(/A saída não foi confirmada pelo servidor/)).toBeInTheDocument();
      expect(primeira.router.state.location.pathname).toBe('/login');
      primeira.unmount();

      // A próxima pessoa abre o ERP no mesmo navegador: tenta o logout antes de qualquer renovação.
      chamadas.length = 0;
      const segunda = renderizarRotas(rotas, '/');
      expect(await screen.findByText(/A saída não foi confirmada pelo servidor/)).toBeInTheDocument();
      expect(segunda.router.state.location.pathname).toBe('/login');
      expect(screen.queryByText(/Olá, Maria/)).not.toBeInTheDocument();
      expect(chamadas.map((c) => c.url.pathname)).not.toContain('/api/auth/refresh');
      expect(chamadas.map((c) => c.url.pathname)).toContain('/api/auth/logout');

      // O servidor volta: "Tentar sair de novo" conclui a saída e o aviso some.
      srv.estado.falha = null;
      await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar sair de novo' }));
      await waitFor(() =>
        expect(screen.queryByText(/A saída não foi confirmada pelo servidor/)).not.toBeInTheDocument(),
      );
      expect(srv.estado.cookieValido).toBe(false);
      segunda.unmount();

      // Saída concluída: a abertura seguinte volta a renovar normalmente (e o cookie já não vale).
      chamadas.length = 0;
      const terceira = renderizarRotas(rotas, '/');
      expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
      expect(terceira.router.state.location.pathname).toBe('/login');
      expect(chamadas.map((c) => c.url.pathname)).toEqual(['/api/auth/refresh']);
    },
  );

  it('controle: logout com 204 sai sem aviso e a próxima abertura só tenta renovar', async () => {
    const srv = servidor('/api', sessao);
    const { chamadas } = simularApi(...srv.rotasFalsas, ({ url }) =>
      url.pathname === '/api/auth/eu' ? { corpo: eu } : undefined,
    );
    const primeira = renderizarRotas(rotas, '/');
    expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
    await primeira.router.navigate('/sair');
    await waitFor(() => expect(primeira.router.state.location.pathname).toBe('/login'));
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByText(/A saída não foi confirmada/)).not.toBeInTheDocument();
    primeira.unmount();
    chamadas.length = 0;
    renderizarRotas(rotas, '/');
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(chamadas.map((c) => c.url.pathname)).toEqual(['/api/auth/refresh']);
  });

  it('entrar de novo com a saída pendente tenta o logout antes e libera a renovação depois', async () => {
    const srv = servidor('/api', sessao);
    const { chamadas } = simularApi(
      ...srv.rotasFalsas,
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === '/api/auth/login' ? { corpo: sessao() } : undefined,
      ({ url }) => (url.pathname === '/api/auth/eu' ? { corpo: eu } : undefined),
    );
    const primeira = renderizarRotas(rotas, '/');
    expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
    srv.estado.falha = 'rede';
    await primeira.router.navigate('/sair');
    expect(await screen.findByText(/A saída não foi confirmada pelo servidor/)).toBeInTheDocument();
    srv.estado.falha = null;
    chamadas.length = 0;
    const usuario = userEvent.setup();
    await usuario.type(screen.getByLabelText(/Código da empresa/), '100001');
    await usuario.type(screen.getByLabelText(/Usuário/), 'maria');
    await usuario.type(screen.getByLabelText(/^Senha/), 'Senha123');
    await usuario.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
    const caminhos = chamadas.map((c) => c.url.pathname);
    expect(caminhos.indexOf('/api/auth/logout')).toBeGreaterThanOrEqual(0);
    expect(caminhos.indexOf('/api/auth/logout')).toBeLessThan(caminhos.indexOf('/api/auth/login'));
    primeira.unmount();
    // Depois do login a renovação pelo cookie volta a valer.
    srv.estado.cookieValido = true;
    chamadas.length = 0;
    renderizarRotas(rotas, '/');
    expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
    expect(chamadas[0]!.url.pathname).toBe('/api/auth/refresh');
  });
});

describe('novas tentativas automáticas do logout no ERP', () => {
  it('tenta de novo sozinho a cada INTERVALO_NOVA_SAIDA_MS e conclui quando o servidor volta', async () => {
    const relogio = relogioFalso();
    const srv = servidor('/api', sessao);
    const { chamadas } = simularApi(...srv.rotasFalsas);
    window.localStorage.setItem(OPCOES_ERP.chaveSaidaPendente, '1');
    srv.estado.falha = 'rede';
    renderizarRotas(rotas, '/');
    expect(await screen.findByText(AVISO)).toBeInTheDocument();
    // Ainda sem servidor: o tique tenta e o aviso continua.
    chamadas.length = 0;
    await relogio.avancar(INTERVALO_NOVA_SAIDA_MS);
    expect(chamadas.map((c) => c.url.pathname)).toEqual(['/api/auth/logout']);
    expect(screen.getByText(AVISO)).toBeInTheDocument();
    srv.estado.falha = null;
    await relogio.avancar(INTERVALO_NOVA_SAIDA_MS);
    await waitFor(() => expect(screen.queryByText(AVISO)).not.toBeInTheDocument());
    expect(srv.estado.cookieValido).toBe(false);
    expect(window.localStorage.getItem(OPCOES_ERP.chaveSaidaPendente)).toBeNull();
    // Concluída a saída, o intervalo para.
    chamadas.length = 0;
    await relogio.avancar(INTERVALO_NOVA_SAIDA_MS * 2);
    expect(chamadas).toEqual([]);
  });

  it('tenta de novo quando a conexão volta (evento online)', async () => {
    const srv = servidor('/api', sessao);
    simularApi(...srv.rotasFalsas);
    window.localStorage.setItem(OPCOES_ERP.chaveSaidaPendente, '1');
    srv.estado.falha = 'rede';
    renderizarRotas(rotas, '/');
    expect(await screen.findByText(AVISO)).toBeInTheDocument();
    srv.estado.falha = null;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(screen.queryByText(AVISO)).not.toBeInTheDocument());
    expect(srv.estado.cookieValido).toBe(false);
  });

  it('a nova tentativa não derruba a sessão que outra aba abriu (o login dela apagou o marcador)', async () => {
    const relogio = relogioFalso();
    const srv = servidorComCookie('/api', sessao);
    const { chamadas } = simularApi(...srv.rotasFalsas);
    // Aba B: abre com a saída pendente e o logout falhando (API reiniciando).
    window.localStorage.setItem(OPCOES_ERP.chaveSaidaPendente, '1');
    srv.estado.falha = 'erro';
    renderizarRotas(rotas, '/');
    expect(await screen.findByText(AVISO)).toBeInTheDocument();
    // A API volta e o usuário entra pela aba A (outro cliente HTTP; o mesmo localStorage e o mesmo cookie), como o
    // `entrar()`: conclui a saída antiga e faz o login. O evento `storage` não chega à aba B aqui.
    srv.estado.falha = null;
    const abaA = criarCliente(OPCOES_ERP);
    expect(await abaA.repetirSaida()).toBe(true);
    await abaA.abrirSessao<RespostaLogin>('/auth/login', { empresa: 100001, login: 'maria', senha: 'x' });
    expect(srv.estado.cookie).toBe('novo-1');
    expect(abaA.saidaPendente()).toBe(false);
    // O tique da aba B não chama o logout (sairia com o cookie novo) nem regrava o marcador: só tira o aviso.
    chamadas.length = 0;
    await relogio.avancar(INTERVALO_NOVA_SAIDA_MS);
    await waitFor(() => expect(screen.queryByText(AVISO)).not.toBeInTheDocument());
    expect(chamadas.map((c) => c.url.pathname)).not.toContain('/api/auth/logout');
    expect(srv.estado.encerrados).toEqual(['velho']);
    expect(srv.estado.cookie).toBe('novo-1');
    expect(abaA.saidaPendente()).toBe(false);
    // A renovação da aba A segue valendo.
    expect(await abaA.renovar()).not.toBeNull();
  });

  it('o evento storage (outra aba apagou o marcador) tira o aviso sem chamar o logout', async () => {
    const srv = servidorComCookie('/api', sessao);
    const { chamadas } = simularApi(...srv.rotasFalsas);
    window.localStorage.setItem(OPCOES_ERP.chaveSaidaPendente, '1');
    srv.estado.falha = 'erro';
    renderizarRotas(rotas, '/');
    expect(await screen.findByText(AVISO)).toBeInTheDocument();
    chamadas.length = 0;
    window.localStorage.removeItem(OPCOES_ERP.chaveSaidaPendente);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: OPCOES_ERP.chaveSaidaPendente, oldValue: '1', newValue: null }),
      );
    });
    await waitFor(() => expect(screen.queryByText(AVISO)).not.toBeInTheDocument());
    expect(chamadas).toEqual([]);
    expect(window.localStorage.getItem(OPCOES_ERP.chaveSaidaPendente)).toBeNull();
  });
});

describe('saída propagada entre abas do ERP (BroadcastChannel)', () => {
  it.each([
    ['falha', 'erro' as const, true],
    ['dá certo', null, false],
  ])('o "Sair" que %s avisa as outras abas com pendente: %s', async (_nome, falha, pendente) => {
    vi.stubGlobal('BroadcastChannel', CanalFalso);
    const srv = servidor('/api', sessao);
    simularApi(...srv.rotasFalsas, ({ url }) =>
      url.pathname === '/api/auth/eu' ? { corpo: eu } : undefined,
    );
    const aba = renderizarRotas(rotas, '/');
    expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
    srv.estado.falha = falha;
    await aba.router.navigate('/sair');
    await waitFor(() => expect(aba.router.state.location.pathname).toBe('/login'));
    await waitFor(() => expect(CanalFalso.enviadas).toEqual([{ tipo: 'saiu', pendente }]));
  });

  it.each([true, false])('a mensagem de outra aba com pendente: %s leva ao login certo', async (pendente) => {
    vi.stubGlobal('BroadcastChannel', CanalFalso);
    const srv = servidor('/api', sessao);
    simularApi(...srv.rotasFalsas, ({ url }) =>
      url.pathname === '/api/auth/eu' ? { corpo: eu } : undefined,
    );
    const aba = renderizarRotas(rotas, '/');
    expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
    // A outra aba gravou o marcador (quando o logout dela falhou) e avisou.
    if (pendente) window.localStorage.setItem(OPCOES_ERP.chaveSaidaPendente, '1');
    act(() => CanalFalso.deOutraAba({ tipo: 'saiu', pendente }));
    await waitFor(() => expect(aba.router.state.location.pathname).toBe('/login'));
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    if (pendente) expect(screen.getByText(AVISO)).toBeInTheDocument();
    else expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });
});

describe('nova tentativa do logout no cliente HTTP (repetirSaida)', () => {
  afterEach(() => {
    delete (navigator as { locks?: unknown }).locks;
  });

  it('nunca grava o marcador e confere-o dentro da trava, antes do fetch', async () => {
    const mock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', mock);
    const cliente = criarCliente({ ...OPCOES_ERP, nomeTrava: 'teste-trava' });
    // Sem marcador: não chama o servidor e não o cria.
    expect(await cliente.repetirSaida()).toBe(false);
    expect(mock).not.toHaveBeenCalled();
    expect(cliente.saidaPendente()).toBe(false);
    // Marcador apagado por outra aba enquanto esta esperava a trava (o login dela segura a mesma trava).
    window.localStorage.setItem(OPCOES_ERP.chaveSaidaPendente, '1');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_nome: string, fn: () => Promise<unknown>) => {
          window.localStorage.removeItem(OPCOES_ERP.chaveSaidaPendente);
          return fn();
        },
      },
    });
    expect(await cliente.repetirSaida()).toBe(false);
    expect(mock).not.toHaveBeenCalled();
    expect(cliente.saidaPendente()).toBe(false);
    // Com o marcador: sai e o apaga.
    delete (navigator as { locks?: unknown }).locks;
    window.localStorage.setItem(OPCOES_ERP.chaveSaidaPendente, '1');
    expect(await cliente.repetirSaida()).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(cliente.saidaPendente()).toBe(false);
  });

  it('o login segura a trava até apagar o marcador', async () => {
    const ordem: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        ordem.push('fetch');
        return new Response(JSON.stringify(sessao()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_nome: string, fn: () => Promise<unknown>) => {
          ordem.push('trava');
          const r = await fn();
          ordem.push(
            `solta (marcador: ${window.localStorage.getItem(OPCOES_ERP.chaveSaidaPendente) ?? 'apagado'})`,
          );
          return r;
        },
      },
    });
    window.localStorage.setItem(OPCOES_ERP.chaveSaidaPendente, '1');
    const cliente = criarCliente(OPCOES_ERP);
    await cliente.abrirSessao('/auth/login', {});
    expect(ordem).toEqual(['trava', 'fetch', 'solta (marcador: apagado)']);
    expect(cliente.temToken()).toBe(true);
  });
});

describe('logout serializado com a renovação (cliente HTTP)', () => {
  it('espera a renovação em andamento, sai com o cookie novo e não reinstala o token que chega depois', async () => {
    let liberarRefresh!: (r: Response) => void;
    const pedidos: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (entrada: RequestInfo | URL) => {
        const caminho = new URL(String(entrada), 'http://localhost').pathname;
        pedidos.push(caminho);
        if (caminho === '/api/auth/refresh') {
          return new Promise<Response>((ok) => {
            liberarRefresh = ok;
          });
        }
        return new Response(null, { status: 204 });
      }),
    );
    const cliente = criarCliente({
      base: '/api',
      caminhoRefresh: '/auth/refresh',
      caminhoLogout: '/auth/logout',
      nomeTrava: 'teste-refresh',
      chaveSaidaPendente: 'teste:saida-pendente',
    });
    const renovacao = cliente.renovar();
    const saida = cliente.encerrarSessao();
    await waitFor(() => expect(pedidos).toEqual(['/api/auth/refresh']));
    // O logout não sai enquanto a renovação não termina.
    await new Promise((ok) => setTimeout(ok, 20));
    expect(pedidos).toEqual(['/api/auth/refresh']);
    liberarRefresh(
      new Response(JSON.stringify(sessao()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(await renovacao).toBeNull();
    await saida;
    expect(pedidos).toEqual(['/api/auth/refresh', '/api/auth/logout']);
    expect(cliente.temToken()).toBe(false);
    expect(cliente.saidaPendente()).toBe(false);
  });

  it('com a saída pendente, a renovação não chama o servidor', async () => {
    const mock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', mock);
    const cliente = criarCliente({
      base: '/api',
      caminhoRefresh: '/auth/refresh',
      caminhoLogout: '/auth/logout',
      nomeTrava: 'teste-refresh',
      chaveSaidaPendente: 'teste:saida-pendente',
    });
    await expect(cliente.encerrarSessao()).rejects.toThrow();
    expect(cliente.saidaPendente()).toBe(true);
    mock.mockClear();
    expect(await cliente.renovar()).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('Sair do painel da plataforma', () => {
  const admin = { id: 'a1', nome: 'ADMIN TESTE', email: 'admin@exemplo.test', papel: 'superadmin' as const };
  const sessaoAdmin = () => ({
    tokenAcesso: 'tok',
    expiraEm: new Date(Date.now() + 15 * 60_000).toISOString(),
    admin,
  });

  it.each(['rede', 'erro'] as const)(
    'logout que falha (%s): avisa e a próxima abertura não entra de novo',
    async (falha) => {
      const srv = servidor('/api/plataforma', sessaoAdmin);
      const { chamadas } = simularApi(...srv.rotasFalsas, ({ url }) =>
        url.pathname === '/api/plataforma/empresas'
          ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 50 } }
          : undefined,
      );
      const primeira = renderizarRotas(rotas, '/plataforma/empresas');
      expect(await screen.findByText('ADMIN TESTE')).toBeInTheDocument();
      srv.estado.falha = falha;
      await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }));
      expect(await screen.findByText(/A saída não foi confirmada pelo servidor/)).toBeInTheDocument();
      expect(primeira.router.state.location.pathname).toBe('/plataforma/login');
      primeira.unmount();

      chamadas.length = 0;
      const segunda = renderizarRotas(rotas, '/plataforma/empresas');
      expect(await screen.findByText(/A saída não foi confirmada pelo servidor/)).toBeInTheDocument();
      expect(segunda.router.state.location.pathname).toBe('/plataforma/login');
      expect(screen.queryByText('ADMIN TESTE')).not.toBeInTheDocument();
      expect(chamadas.map((c) => c.url.pathname)).not.toContain('/api/plataforma/auth/refresh');

      srv.estado.falha = null;
      await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar sair de novo' }));
      await waitFor(() =>
        expect(screen.queryByText(/A saída não foi confirmada pelo servidor/)).not.toBeInTheDocument(),
      );
      expect(srv.estado.cookieValido).toBe(false);
    },
  );

  it('tenta de novo sozinho a cada INTERVALO_NOVA_SAIDA_MS e conclui quando o servidor volta', async () => {
    const relogio = relogioFalso();
    const srv = servidor('/api/plataforma', sessaoAdmin);
    simularApi(...srv.rotasFalsas);
    window.localStorage.setItem(OPCOES_PLATAFORMA.chaveSaidaPendente, '1');
    srv.estado.falha = 'erro';
    renderizarRotas(rotas, '/plataforma/empresas');
    expect(await screen.findByText(AVISO)).toBeInTheDocument();
    srv.estado.falha = null;
    await relogio.avancar(INTERVALO_NOVA_SAIDA_MS);
    await waitFor(() => expect(screen.queryByText(AVISO)).not.toBeInTheDocument());
    expect(srv.estado.cookieValido).toBe(false);
  });

  it('a nova tentativa não derruba a sessão que outra aba abriu', async () => {
    const relogio = relogioFalso();
    const srv = servidorComCookie('/api/plataforma', sessaoAdmin);
    const { chamadas } = simularApi(...srv.rotasFalsas);
    window.localStorage.setItem(OPCOES_PLATAFORMA.chaveSaidaPendente, '1');
    srv.estado.falha = 'erro';
    renderizarRotas(rotas, '/plataforma/empresas');
    expect(await screen.findByText(AVISO)).toBeInTheDocument();
    srv.estado.falha = null;
    const abaA = criarCliente(OPCOES_PLATAFORMA);
    await abaA.repetirSaida();
    await abaA.abrirSessao('/auth/login', { email: 'admin@exemplo.test', senha: 'x' });
    chamadas.length = 0;
    await relogio.avancar(INTERVALO_NOVA_SAIDA_MS);
    await waitFor(() => expect(screen.queryByText(AVISO)).not.toBeInTheDocument());
    expect(chamadas.map((c) => c.url.pathname)).not.toContain('/api/plataforma/auth/logout');
    expect(srv.estado.cookie).toBe('novo-1');
    expect(abaA.saidaPendente()).toBe(false);
  });
});
