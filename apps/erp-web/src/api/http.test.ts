import { afterEach, describe, expect, it, vi } from 'vitest';
import { simularApi } from '../teste/utilidades';
import { criarCliente, ErroRequisicao, nomeDoArquivo } from './http';

const novoCliente = () => criarCliente({ base: '/api', caminhoRefresh: '/auth/refresh', nomeTrava: 't' });
const futuro = () => new Date(Date.now() + 15 * 60_000).toISOString();

afterEach(() => vi.unstubAllGlobals());

describe('cliente HTTP (token em memória + refresh por cookie)', () => {
  it('401 renova uma única vez (chamadas simultâneas) e repete com o token novo', async () => {
    let refreshes = 0;
    const { chamadas } = simularApi(
      ({ url, metodo }) => {
        if (url.pathname === '/api/auth/refresh' && metodo === 'POST') {
          refreshes++;
          return { corpo: { tokenAcesso: 'novo', expiraEm: futuro() } };
        }
        return undefined;
      },
      ({ url, cabecalhos }) => {
        if (url.pathname !== '/api/dados') return undefined;
        return cabecalhos.get('Authorization') === 'Bearer novo'
          ? { corpo: { ok: true } }
          : { status: 401, corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'Sessão expirada' } };
      },
    );
    const api = novoCliente();
    api.definirSessao({ tokenAcesso: 'velho', expiraEm: futuro() });
    const [a, b] = await Promise.all([api.get('/dados'), api.get('/dados')]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(refreshes).toBe(1);
    expect(chamadas.filter((c) => c.url.pathname === '/api/dados')).toHaveLength(4);
  });

  it('refresh recusado avisa que a sessão expirou e propaga o 401', async () => {
    simularApi(({ url }) =>
      url.pathname === '/api/auth/refresh'
        ? { status: 401, corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'x' } }
        : { status: 401, corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'Sessão expirada ou inválida.' } },
    );
    const api = novoCliente();
    const aoExpirar = vi.fn();
    api.ouvir({ aoExpirar });
    api.definirSessao({ tokenAcesso: 't', expiraEm: futuro() });
    await expect(api.get('/dados')).rejects.toMatchObject({ status: 401, codigo: 'NAO_AUTENTICADO' });
    expect(aoExpirar).toHaveBeenCalledTimes(1);
    expect(api.temToken()).toBe(false);
  });

  it('403 TROCA_SENHA_OBRIGATORIA avisa o app; 403 SEM_PERMISSAO só vira erro', async () => {
    simularApi(({ url }) =>
      url.pathname === '/api/a'
        ? { status: 403, corpo: { codigo: 'TROCA_SENHA_OBRIGATORIA', mensagem: 'Troque a senha' } }
        : {
            status: 403,
            corpo: {
              codigo: 'SEM_PERMISSAO',
              mensagem: 'Sem permissão',
              detalhes: { permissoes: ['x.ver'] },
            },
          },
    );
    const api = novoCliente();
    const aoTrocaSenhaObrigatoria = vi.fn();
    api.ouvir({ aoTrocaSenhaObrigatoria });
    await expect(api.get('/a')).rejects.toBeInstanceOf(ErroRequisicao);
    expect(aoTrocaSenhaObrigatoria).toHaveBeenCalledTimes(1);
    const erro = await api.get('/b').catch((e: unknown) => e);
    expect(erro).toMatchObject({ status: 403, codigo: 'SEM_PERMISSAO', message: 'Sem permissão' });
    expect(aoTrocaSenhaObrigatoria).toHaveBeenCalledTimes(1);
  });

  it('rotas de sessão (semRenovar) não tentam refresh; falha de rede vira mensagem amigável', async () => {
    const { chamadas } = simularApi(() => ({
      status: 401,
      corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'inválido' },
    }));
    const api = novoCliente();
    await expect(api.post('/auth/login', {}, { semRenovar: true })).rejects.toMatchObject({ status: 401 });
    expect(chamadas).toHaveLength(1);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.get('/x')).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('servidor'),
    });
  });

  it('baixar devolve o arquivo com o nome do Content-Disposition e renova o token num 401', async () => {
    let refreshes = 0;
    simularApi(
      ({ url }) => {
        if (url.pathname !== '/api/auth/refresh') return undefined;
        refreshes++;
        return { corpo: { tokenAcesso: 'novo', expiraEm: futuro() } };
      },
      ({ url, cabecalhos }) => {
        if (url.pathname !== '/api/usuarios/exportar') return undefined;
        if (cabecalhos.get('Authorization') !== 'Bearer novo')
          return { status: 401, corpo: { codigo: 'NAO_AUTENTICADO', mensagem: 'x' } };
        return {
          arquivo: {
            conteudo: 'a;b',
            cabecalhos: {
              'Content-Type': 'text/csv',
              'Content-Disposition': 'attachment; filename="Usuarios_30_10_2026_10_00.csv"',
            },
          },
        };
      },
    );
    const api = novoCliente();
    api.definirSessao({ tokenAcesso: 'velho', expiraEm: futuro() });
    const r = await api.baixar('/usuarios/exportar?formato=csv');
    expect(r.nome).toBe('Usuarios_30_10_2026_10_00.csv');
    expect(await r.blob.text()).toBe('a;b');
    expect(refreshes).toBe(1);
  });

  it('nomeDoArquivo: filename* tem prioridade; sem cabeçalho usa o padrão', () => {
    expect(nomeDoArquivo(`attachment; filename="a.csv"; filename*=UTF-8''Usu%C3%A1rios.csv`, 'x')).toBe(
      'Usuários.csv',
    );
    expect(nomeDoArquivo('attachment; filename=b.xlsx', 'x')).toBe('b.xlsx');
    expect(nomeDoArquivo(null, 'padrao.xlsx')).toBe('padrao.xlsx');
  });
});
