import type { MovimentoCaixaDetalhe, PaginaMovimentosCaixa, PaginaSessoesCaixa } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { diaOperacionalHoje } from './comum';
import { ListaFechamentosCaixa } from './FechamentosCaixa';
import { DetalheSangria, ListaSangrias } from './MovimentosCaixa';

/**
 * Telas só de leitura do caixa (Fase 1C, bloco C12): Sangria (ERP 15.3, lista e detalhe) e a lista de Fechamento de
 * caixa (14.9). O totalizador vem da API (só os não cancelados); aqui, o que a tela desenha e manda.
 */

afterEach(() => vi.unstubAllGlobals());

const CENTRO = '01928f3a-0000-7000-8000-0000000000a1';
const SESSAO = '01928f3a-0000-7000-8000-0000000000c1';
const LOJAS = [{ id: CENTRO, codigo: 1, nome: 'Loja 1 - Centro', ativa: true, treino: false }];

const base = {
  diaOperacional: '2026-10-29',
  lojaId: CENTRO,
  lojaCodigo: 1,
  lojaNome: 'Loja 1 - Centro',
  lojaTreino: false,
  numeroCaixa: 2,
  operadorNome: 'MARIA',
  quemRetira: 'CARLOS',
};

const SANGRIAS: PaginaMovimentosCaixa = {
  itens: [
    {
      ...base,
      id: 's1',
      tipo: 'sangria',
      ocorridoEm: '2026-10-29T15:20:00.000Z',
      valor: '1000.00',
      cancelado: true,
    },
    {
      ...base,
      id: 's2',
      tipo: 'sangria_fechamento',
      ocorridoEm: '2026-10-29T23:05:00.000Z',
      valor: '223.50',
      cancelado: false,
    },
  ],
  total: 2,
  pagina: 1,
  tamanho: 20,
  totais: { quantidade: 1, valor: '223.50' },
};

const SANGRIA: MovimentoCaixaDetalhe = {
  ...SANGRIAS.itens[0]!,
  sessaoCaixaId: SESSAO,
  terminalId: 't1',
  terminalDescricao: 'PC do balcão',
  operadorId: 'u1',
  quemRetiraUsuarioNome: null,
  quemRetiraNome: 'CARLOS',
  observacao: 'Depósito banco',
  infAdicionais: 'Malote 4471',
  formaPagamentoDescricao: null,
  autorizadoPorNome: null,
  canceladoEm: '2026-10-29T15:31:00.000Z',
  canceladoPorNome: 'MARIA',
  autorizadoCancelamentoPorNome: 'GERENTE',
  motivoCancelamento: 'Valor digitado errado (era 100,00)',
};

describe('<ListaSangrias> (ERP 15.3, C12)', () => {
  it('a cancelada marcada, o rodapé da API e o tipo "Sangria de fechamento" no filtro', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['movimentos_caixa.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === '/api/movimentos-caixa/sangrias' ? { corpo: SANGRIAS } : undefined),
    );
    renderizarComSessao(<ListaSangrias />, '/vendas/sangrias');
    const tabela = await screen.findByRole('table');
    const cancelada = (await within(tabela).findByText('R$ 1.000,00')).closest('tr')!;
    expect(within(cancelada).getByText('Cancelado')).toBeInTheDocument();
    const doFechamento = within(tabela).getByText('Sangria de fechamento').closest('tr')!;
    expect(doFechamento).toHaveTextContent('Não');
    expect(doFechamento).toHaveTextContent('CARLOS');
    // O rodapé é o da API: só os não cancelados (a de R$ 1.000,00 cancelada fica de fora).
    expect(screen.getByTestId('totais-sangrias')).toHaveTextContent('Não cancelados: 1');
    expect(screen.getByTestId('totais-sangrias')).toHaveTextContent('Valor: R$ 223,50');
    const primeira = chamadas.find((c) => c.url.pathname === '/api/movimentos-caixa/sangrias')!;
    expect(primeira.url.searchParams.get('dataInicial')).toBe(diaOperacionalHoje());

    await u.click(screen.getByRole('combobox', { name: 'Tipo' }));
    expect(await screen.findByRole('option', { name: 'Sangria', hidden: true })).toBeInTheDocument();
    await u.click(await screen.findByRole('option', { name: 'Sangria de fechamento', hidden: true }));
    await u.click(screen.getByRole('button', { name: 'Pesquisar' }));
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) =>
            c.url.pathname === '/api/movimentos-caixa/sangrias' &&
            c.url.searchParams.get('tipo') === 'sangria_fechamento',
        ),
      ).toBe(true),
    );
  }, 30_000);
});

describe('<DetalheSangria> (ERP 15.3, C12)', () => {
  const rotaDetalhe = ({ url }: { url: URL }) =>
    url.pathname === `/api/movimentos-caixa/${SANGRIA.id}` ? { corpo: SANGRIA } : undefined;

  it('cancelamento feito no PDV e o link para o fechamento com fechamentos_caixa.ver', async () => {
    simularApi(
      ...rotasSessao({
        permissoes: ['movimentos_caixa.ver', 'fechamentos_caixa.ver'],
        lojas: LOJAS,
        todasLojas: true,
      }),
      rotaDetalhe,
    );
    renderizarComSessao(<DetalheSangria />, `/vendas/sangrias/${SANGRIA.id}`, 'vendas/sangrias/:id');
    expect(await screen.findByRole('heading', { name: /Sangria de R\$ 1\.000,00/ })).toBeInTheDocument();
    const cancelamento = screen.getByText('Cancelamento (no PDV)').parentElement!;
    expect(cancelamento).toHaveTextContent('Valor digitado errado (era 100,00)');
    expect(cancelamento).toHaveTextContent('GERENTE');
    expect(screen.getByText('Malote 4471')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver fechamento' })).toHaveAttribute(
      'href',
      `/financeiro/fechamentos-caixa/${SESSAO}`,
    );
  }, 30_000);

  it('sem fechamentos_caixa.ver, a sessão aparece sem o link', async () => {
    simularApi(
      ...rotasSessao({ permissoes: ['movimentos_caixa.ver'], lojas: LOJAS, todasLojas: true }),
      rotaDetalhe,
    );
    renderizarComSessao(<DetalheSangria />, `/vendas/sangrias/${SANGRIA.id}`, 'vendas/sangrias/:id');
    expect(await screen.findByText('Cancelamento (no PDV)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ver fechamento' })).not.toBeInTheDocument();
  }, 30_000);
});

const SESSOES: PaginaSessoesCaixa = {
  itens: [
    {
      id: SESSAO,
      lojaId: CENTRO,
      lojaCodigo: 1,
      lojaNome: 'Loja 1 - Centro',
      lojaTreino: false,
      numeroCaixa: 2,
      diaOperacional: '2026-10-29',
      abertaEm: '2026-10-29T11:00:00.000Z',
      fechadaEm: '2026-10-29T23:05:00.000Z',
      operadorNome: 'MARIA',
      usuarioSubsequenteNome: null,
      situacao: 'fechada',
      tipoFechamento: 'fechamento',
      valorCaixa: '0.00',
      totalCalculado: '260.00',
      totalInformado: '258.50',
      diferenca: '-1.50',
    },
  ],
  total: 1,
  pagina: 1,
  tamanho: 20,
  totais: { calculado: '260.00', informado: '258.50', diferenca: '-1.50' },
};

describe('<ListaFechamentosCaixa> (ERP 14.9, C12)', () => {
  it('padrão: o dia operacional de hoje; "Somente com diferença" vai à API; rodapé com os totais', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['fechamentos_caixa.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === '/api/sessoes-caixa' ? { corpo: SESSOES } : undefined),
    );
    renderizarComSessao(<ListaFechamentosCaixa />, '/financeiro/fechamentos-caixa');
    const linha = (await screen.findByText('MARIA')).closest('tr')!;
    expect(linha).toHaveTextContent('R$ 260,00');
    expect(linha).toHaveTextContent('R$ -1,50');
    expect(within(linha).getByText('Fechada')).toBeInTheDocument();
    expect(screen.getByTestId('totais-fechamentos')).toHaveTextContent('Sessões: 1');
    const primeira = chamadas.find((c) => c.url.pathname === '/api/sessoes-caixa')!;
    expect(primeira.url.searchParams.get('dataInicial')).toBe(diaOperacionalHoje());
    expect(primeira.url.searchParams.get('dataFinal')).toBe(diaOperacionalHoje());
    expect(primeira.url.searchParams.get('somenteComDiferenca')).toBe('false');

    await u.click(screen.getByRole('combobox', { name: 'Somente com diferença' }));
    await u.click(await screen.findByRole('option', { name: 'Sim', hidden: true }));
    await u.click(screen.getByRole('button', { name: 'Pesquisar' }));
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) =>
            c.url.pathname === '/api/sessoes-caixa' &&
            c.url.searchParams.get('somenteComDiferenca') === 'true',
        ),
      ).toBe(true),
    );
  }, 30_000);
});
