import type { RespostaEu, RespostaLogin } from '@genesis/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rotas } from '../rotas';
import { renderizarRotas, simularApi, type RespostaFalsa } from '../teste/utilidades';
import { CHAVE_CODIGO_EMPRESA } from './Login';

const USUARIO = {
  id: '01928f3a-7c1e-7b2d-9a40-5e2f1c3d4b5a',
  codigo: 1,
  nome: 'MARIA SILVA',
  login: 'maria',
  master: false,
  senhaProvisoria: false,
};
const EMPRESA = { codigo: 100001, nome: 'Ice Beer' };

const respostaLogin = (trocarSenha = false, token = 'tok-1'): RespostaLogin => ({
  tokenAcesso: token,
  expiraEm: new Date(Date.now() + 15 * 60_000).toISOString(),
  trocarSenha,
  empresa: EMPRESA,
  usuario: { ...USUARIO, senhaProvisoria: trocarSenha },
});

const eu = (permissoes: string[], senhaProvisoria = false): RespostaEu => ({
  usuario: { ...USUARIO, senhaProvisoria },
  empresa: EMPRESA,
  permissoes,
  lojas: [],
  todasLojas: false,
});

type Req = { url: URL; metodo: string; corpo: unknown; cabecalhos: Headers };
const rota =
  (metodo: string, caminho: string, resposta: (r: Req) => RespostaFalsa) =>
  (r: Req): RespostaFalsa | undefined =>
    r.metodo === metodo && r.url.pathname === caminho ? resposta(r) : undefined;

const semSessao = rota('POST', '/api/auth/refresh', () => ({
  status: 401,
  corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'Sessão expirada' },
}));

afterEach(() => vi.unstubAllGlobals());

async function preencher(codigo: string | null, login: string, senha: string) {
  const usuario = userEvent.setup();
  if (codigo !== null) {
    await usuario.clear(screen.getByLabelText(/Código da empresa/));
    await usuario.type(screen.getByLabelText(/Código da empresa/), codigo);
  }
  await usuario.type(screen.getByLabelText(/Usuário/), login);
  await usuario.type(screen.getByLabelText(/^Senha/), senha);
  await usuario.click(screen.getByRole('button', { name: 'Entrar' }));
  return usuario;
}

describe('fluxo de login do ERP', () => {
  it('sem sessão vai para /login; entra, lembra o código e mostra o menu só com o permitido', async () => {
    const { chamadas } = simularApi(
      semSessao,
      rota('POST', '/api/auth/login', () => ({ corpo: respostaLogin() })),
      rota('GET', '/api/auth/eu', () => ({ corpo: eu(['dashboard.ver', 'usuarios.ver', 'pessoas.ver']) })),
    );
    const { router } = renderizarRotas(rotas, '/');
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');

    await preencher('100001', ' Maria ', 'Senha123');
    expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    const login = chamadas.find((c) => c.url.pathname === '/api/auth/login')!;
    expect(login.corpo).toEqual({ codigoEmpresa: '100001', login: 'Maria', senha: 'Senha123' });
    const chamadaEu = chamadas.find((c) => c.url.pathname === '/api/auth/eu')!;
    expect(chamadaEu.cabecalhos.get('Authorization')).toBe('Bearer tok-1');
    expect(window.localStorage.getItem(CHAVE_CODIGO_EMPRESA)).toBe('100001');
    // O token nunca vai para o armazenamento do navegador.
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('tok-1');

    const menu = screen.getByRole('navigation', { name: 'Menu principal' });
    expect(menu).toHaveTextContent('PESSOAS');
    expect(menu).toHaveTextContent('CADASTROS');
    expect(menu).not.toHaveTextContent('FINANCEIRO');
    expect(menu).not.toHaveTextContent('PRODUTOS');
  });

  it('credenciais inválidas mostram a mensagem genérica e limpam a senha', async () => {
    window.localStorage.setItem(CHAVE_CODIGO_EMPRESA, '100001');
    simularApi(
      semSessao,
      rota('POST', '/api/auth/login', () => ({
        status: 401,
        corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'Código da empresa, usuário ou senha inválidos.' },
      })),
    );
    renderizarRotas(rotas, '/login');
    await screen.findByRole('button', { name: 'Entrar' });
    expect(screen.getByLabelText(/Código da empresa/)).toHaveValue('100001');
    await preencher(null, 'maria', 'errada1');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Código da empresa, usuário ou senha inválidos.',
    );
    expect(screen.getByLabelText(/^Senha/)).toHaveValue('');
  });

  it('valida o formulário antes de chamar a API (código com 6 dígitos)', async () => {
    const { chamadas } = simularApi(semSessao);
    renderizarRotas(rotas, '/login');
    await screen.findByRole('button', { name: 'Entrar' });
    await preencher('123', 'maria', 'x');
    expect(await screen.findByText('Código da empresa deve ter 6 dígitos')).toBeInTheDocument();
    expect(chamadas.some((c) => c.url.pathname === '/api/auth/login')).toBe(false);
  });

  it('senha provisória obriga a troca antes de qualquer tela e depois volta à rota pedida', async () => {
    let trocou = false;
    simularApi(
      semSessao,
      rota('POST', '/api/auth/login', () => ({ corpo: respostaLogin(true) })),
      rota('GET', '/api/auth/eu', () => ({ corpo: eu(['dashboard.ver', 'usuarios.ver'], !trocou) })),
      rota('POST', '/api/auth/trocar-senha', ({ corpo }) => {
        expect(corpo).toEqual({
          senhaAtual: 'Provisoria9',
          novaSenha: 'MinhaSenha1',
          confirmacao: 'MinhaSenha1',
        });
        trocou = true;
        return { corpo: respostaLogin(false, 'tok-2') };
      }),
      rota('GET', '/api/usuarios', () => ({ corpo: { itens: [], total: 0, pagina: 1, tamanho: 20 } })),
      rota('GET', '/api/perfis', () => ({ status: 403, corpo: { codigo: 'SEM_PERMISSAO', mensagem: 'x' } })),
    );
    const { router } = renderizarRotas(rotas, '/cadastros/usuarios');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('?voltar=%2Fcadastros%2Fusuarios');

    const usuario = await preencher('100001', 'maria', 'Provisoria9');
    expect(await screen.findByText('Troque a senha provisória')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/trocar-senha');

    await usuario.type(screen.getByLabelText(/Senha provisória/), 'Provisoria9');
    await usuario.type(screen.getByLabelText(/^Nova senha/), 'MinhaSenha1');
    await usuario.type(screen.getByLabelText(/Confirmar nova senha/), 'MinhaSenha1');
    await usuario.click(screen.getByRole('button', { name: 'Trocar senha' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/cadastros/usuarios'));
    expect(await screen.findByRole('heading', { name: 'Usuários' })).toBeInTheDocument();
  });

  it('com sessão válida no cookie, a rota abre direto; Sair encerra e volta ao login', async () => {
    const { chamadas } = simularApi(
      rota('POST', '/api/auth/refresh', () => ({ corpo: respostaLogin() })),
      rota('GET', '/api/auth/eu', () => ({ corpo: eu(['dashboard.ver']) })),
      rota('POST', '/api/auth/logout', () => ({ status: 204 })),
    );
    const { router } = renderizarRotas(rotas, '/');
    expect(await screen.findByText(/Olá, Maria/)).toBeInTheDocument();
    await router.navigate('/sair');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(chamadas.some((c) => c.url.pathname === '/api/auth/logout')).toBe(true);
  });

  it('rota de tela sem a permissão mostra "Sem permissão"; tela futura mostra "Em construção"', async () => {
    simularApi(
      rota('POST', '/api/auth/refresh', () => ({ corpo: respostaLogin() })),
      rota('GET', '/api/auth/eu', () => ({ corpo: eu(['dashboard.ver', 'transferencias.ver']) })),
    );
    const { router } = renderizarRotas(rotas, '/cadastros/usuarios');
    expect(await screen.findByRole('heading', { name: 'Sem permissão' })).toBeInTheDocument();
    await router.navigate('/estoque/transferencias');
    expect(await screen.findByText('Em construção · Fase 2')).toBeInTheDocument();
  });
});
