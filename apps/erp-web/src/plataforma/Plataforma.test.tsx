import type { PapelAdmin, SituacaoMigracoes } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rotas } from '../rotas';
import { renderizarRotas, simularApi, type RespostaFalsa } from '../teste/utilidades';

afterEach(() => vi.unstubAllGlobals());

type Req = { url: URL; metodo: string; corpo: unknown };
const rota =
  (metodo: string, caminho: string, resposta: (r: Req) => RespostaFalsa) =>
  (r: Req): RespostaFalsa | undefined =>
    r.metodo === metodo && r.url.pathname === caminho ? resposta(r) : undefined;

const sessaoAdmin = (papel: PapelAdmin) =>
  rota('POST', '/api/plataforma/auth/refresh', () => ({
    corpo: {
      tokenAcesso: 'tok',
      expiraEm: new Date(Date.now() + 15 * 60_000).toISOString(),
      admin: { id: 'a1', nome: 'Super', email: 'super@genesis.dev', papel },
    },
  }));

const SITUACAO: SituacaoMigracoes = {
  versaoAtual: '0004_nova',
  migracoes: [],
  resumo: { empresas: 2, emDia: 1, atrasadas: 1, comErro: 1 },
  empresas: [
    {
      id: 'e1',
      codigo: 100001,
      razaoSocial: 'Ice Beer Ltda',
      nomeFantasia: 'Ice Beer',
      status: 'ativa',
      canario: true,
      versaoSchema: '0004_nova',
      pendentes: [],
      situacao: 'em_dia',
      migracaoComErro: null,
      erro: null,
      ultimaExecucaoEm: '2026-10-30T12:00:00Z',
    },
    {
      id: 'e2',
      codigo: 100002,
      razaoSocial: 'Outra Ltda',
      nomeFantasia: null,
      status: 'ativa',
      canario: false,
      versaoSchema: '0003_antiga',
      pendentes: ['0004_nova'],
      situacao: 'com_erro',
      migracaoComErro: '0004_nova',
      erro: 'relation "x" already exists',
      ultimaExecucaoEm: '2026-10-30T12:00:00Z',
    },
  ],
  execucoes: [
    {
      id: 'x1',
      ocorridoEm: '2026-10-30T12:00:00Z',
      adminNome: 'Super',
      executadoPor: 'api:1',
      falhas: 1,
      interrompida: false,
      empresas: [
        { codigo: 100001, status: 'ok', aplicadas: ['0004_nova'] },
        { codigo: 100002, status: 'falhou', aplicadas: [], erro: 'relation "x" already exists' },
      ],
    },
  ],
};

function montarMigracoes(papel: PapelAdmin = 'superadmin') {
  const api = simularApi(
    sessaoAdmin(papel),
    rota('GET', '/api/plataforma/migracoes', ({ url }) => ({
      corpo:
        url.searchParams.get('filtro') === 'com_erro'
          ? { ...SITUACAO, empresas: SITUACAO.empresas.filter((e) => e.situacao === 'com_erro') }
          : SITUACAO,
    })),
    rota('POST', '/api/plataforma/migracoes/aplicar', () => ({
      corpo: {
        canarios: [
          {
            empresaId: 'e2',
            codigo: 100002,
            status: 'ok',
            aplicadas: ['0004_nova'],
            versaoSchema: '0004_nova',
            avisos: ['0004_nova: 2 linha(s) de saldo com a cadeia do razão quebrada'],
          },
        ],
        demais: [],
        falhas: 0,
        interrompida: false,
      },
    })),
    rota('GET', '/api/plataforma/migracoes/simular', ({ url }) => ({
      corpo: {
        fonte: url.searchParams.get('codigo') ? 'banco' : 'versao_schema',
        empresas: [{ codigo: 100002, razaoSocial: 'Outra Ltda', pendentes: ['0004_nova'], alteradas: [] }],
        migracoes: [{ ordem: 4, tag: '0004_nova', sql: 'create table nova (id int);' }],
      },
    })),
  );
  const r = renderizarRotas(rotas, '/plataforma/migracoes');
  return { ...r, ...api };
}

describe('painel › Migrações (ERP 19.7)', () => {
  it('mostra a versão do código × a de cada empresa, com erro, e o log das execuções', async () => {
    montarMigracoes();
    const tabela = await screen.findByRole('table', { name: 'Situação das empresas' });
    await within(tabela).findByText('Ice Beer');
    const linhas = within(tabela).getAllByRole('row');
    expect(linhas).toHaveLength(3);
    expect(linhas[1]).toHaveTextContent('Ice Beer');
    expect(linhas[1]).toHaveTextContent('Canário');
    expect(linhas[1]).toHaveTextContent('Em dia');
    expect(linhas[2]).toHaveTextContent('Com erro');
    expect(linhas[2]).toHaveTextContent('0004_nova: relation "x" already exists');
    expect(screen.getByText('0004_nova', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('1 falha(s)')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Menu da plataforma' })).toBeInTheDocument();
  });

  it('filtro "Com erro" vai para a URL e para a API', async () => {
    const usuario = userEvent.setup();
    const { router, chamadas } = montarMigracoes();
    await screen.findByRole('table', { name: 'Situação das empresas' });
    await usuario.click(screen.getByRole('radio', { name: 'Com erro' }));
    await waitFor(() => expect(router.state.location.search).toBe('?filtro=com_erro'));
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) =>
            c.url.pathname === '/api/plataforma/migracoes' && c.url.searchParams.get('filtro') === 'com_erro',
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('table', { name: 'Situação das empresas' })).getAllByRole('row'),
      ).toHaveLength(2),
    );
  });

  it('Aplicar em uma empresa confirma, envia o código e mostra o resultado', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = montarMigracoes();
    await usuario.click(await screen.findByRole('button', { name: 'Aplicar em 100002' }));
    const confirmar = await screen.findByRole('dialog');
    expect(confirmar).toHaveTextContent('Aplicar migrações na empresa 100002');
    await usuario.click(within(confirmar).getByRole('button', { name: 'Aplicar' }));
    const resultado = await screen.findByRole('dialog', { name: 'Resultado da migração' });
    expect(resultado).toHaveTextContent('Sem falhas');
    expect(resultado).toHaveTextContent('0004_nova');
    // Aviso de uma preparação (F2-B2): aparece na linha da empresa, sem virar falha.
    expect(resultado).toHaveTextContent('0004_nova: 2 linha(s) de saldo com a cadeia do razão quebrada');
    const post = chamadas.find((c) => c.url.pathname === '/api/plataforma/migracoes/aplicar')!;
    expect(post.corpo).toEqual({ codigos: [100002], pararNoPrimeiroErro: false });
  });

  it('Aplicar em todas respeita "parar no primeiro erro"; Simular mostra pendentes e o SQL', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = montarMigracoes('suporte');
    await screen.findByRole('table', { name: 'Situação das empresas' });
    await usuario.click(screen.getByRole('checkbox', { name: 'Parar no primeiro erro' }));
    await usuario.click(screen.getByRole('button', { name: 'Aplicar em todas' }));
    await usuario.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Aplicar' }));
    await screen.findByRole('dialog', { name: 'Resultado da migração' });
    expect(chamadas.find((c) => c.url.pathname === '/api/plataforma/migracoes/aplicar')!.corpo).toEqual({
      pararNoPrimeiroErro: true,
    });
    await usuario.keyboard('{Escape}');

    await usuario.click(screen.getByRole('button', { name: 'Simular 100002' }));
    const sim = await screen.findByRole('dialog', { name: 'Simulação' });
    expect(sim).toHaveTextContent('Lido do registro de migrações do banco da empresa');
    expect(sim).toHaveTextContent('create table nova (id int);');
    expect(
      chamadas
        .find((c) => c.url.pathname === '/api/plataforma/migracoes/simular')!
        .url.searchParams.get('codigo'),
    ).toBe('100002');
  });

  it('somente leitura vê a situação, sem Aplicar/Simular', async () => {
    montarMigracoes('somente_leitura');
    await screen.findByRole('table', { name: 'Situação das empresas' });
    expect(screen.queryByRole('button', { name: 'Aplicar em todas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Simular/ })).not.toBeInTheDocument();
  });
});

describe('painel › Planos (ERP 19.8)', () => {
  it('lista os planos com limites, módulos e valor', async () => {
    simularApi(
      sessaoAdmin('financeiro'),
      rota('GET', '/api/plataforma/planos', () => ({
        corpo: {
          itens: [
            {
              id: 'p1',
              codigo: 'padrao',
              nome: 'Padrão',
              descricao: 'Plano inicial',
              limiteLojas: 3,
              limiteTerminais: 6,
              limiteUsuarios: null,
              recursos: { fiscal: true, tef: false },
              precoMensal: '199.90',
              ativo: true,
            },
          ],
          total: 1,
          pagina: 1,
          tamanho: 'todos',
        },
      })),
    );
    renderizarRotas(rotas, '/plataforma/planos');
    const tabela = await screen.findByRole('table', { name: 'Planos' });
    const linha = await within(tabela).findByText('Padrão');
    const tr = linha.closest('tr')!;
    expect(tr).toHaveTextContent('Plano inicial');
    expect(tr).toHaveTextContent('Sem limite');
    expect(tr).toHaveTextContent('fiscal');
    expect(within(tr).queryByText('tef')).not.toBeInTheDocument();
    expect(tr).toHaveTextContent('R$ 199,90');
    expect(tr).toHaveTextContent('Ativo');
  });
});
