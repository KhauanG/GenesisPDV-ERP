import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiErp } from '../../api/clientes';
import { query } from '../../api/http';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { Layout } from '../../layout/Layout';
import { ProvedorLojaContexto, useLojaContexto } from '../../layout/lojaContexto';
import {
  renderizarComSessao,
  renderizarRotas,
  rotasSessao,
  simularApi,
  type RespostaFalsa,
} from '../../teste/utilidades';
import { salvarArquivo } from '../../util/arquivos';
import { CHAVE_TAREFAS } from '../tarefas/tarefas';
import {
  exportarPelaApi,
  Relatorio,
  type ConfigRelatorio,
  type PaginacaoRelatorio,
  type ResultadoRelatorio,
} from './Relatorio';

vi.mock('../../util/arquivos', () => ({ salvarArquivo: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

interface Linha {
  forma: string;
  total: string;
}

const RESULTADO: ResultadoRelatorio<Linha> = {
  resumo: [
    { rotulo: 'Total vendido', valor: 'R$ 150,00' },
    { rotulo: 'Vendas', valor: '3' },
  ],
  linhas: [
    { forma: 'Dinheiro', total: 'R$ 100,00' },
    { forma: 'PIX', total: 'R$ 50,00' },
  ],
  totais: { total: 'R$ 150,00' },
};

function montar({
  url = '/relatorios/vendas_forma_pagamento',
  permissoes = ['relatorios.exportar'],
  gerarAoAbrir = false,
}: { url?: string; permissoes?: string[]; gerarAoAbrir?: boolean } = {}) {
  simularApi(...rotasSessao({ permissoes }));
  const buscar = vi.fn(async () => RESULTADO);
  const exportar = vi.fn(async () => ({ blob: new Blob(['x']), nome: 'Relatorio.xlsx' }));
  const config: ConfigRelatorio<Linha> = {
    nome: 'vendas_forma_pagamento',
    titulo: 'Vendas por forma de pagamento',
    filtros: [
      { campo: 'inicio', rotulo: 'De', tipo: 'texto', padrao: '2026-10-01' },
      {
        campo: 'situacao',
        rotulo: 'Situação',
        tipo: 'selecao',
        opcoes: [
          { value: 'concluidas', label: 'Concluídas' },
          { value: 'canceladas', label: 'Canceladas' },
        ],
      },
    ],
    colunas: [
      { campo: 'forma', rotulo: 'Forma' },
      { campo: 'total', rotulo: 'Total', alinhamento: 'right' },
    ],
    chaveLinha: (l) => l.forma,
    buscar,
    exportar,
    gerarAoAbrir,
  };
  const r = renderizarComSessao(<Relatorio config={config} />, url);
  return { ...r, buscar, exportar };
}

describe('<Relatorio>', () => {
  it('só gera depois do Filtrar; filtros vão para a URL e o resultado mostra cards, tabela e totais', async () => {
    const usuario = userEvent.setup();
    const { buscar, router } = montar();
    expect(await screen.findByText('Escolha os filtros e clique em Filtrar.')).toBeInTheDocument();
    expect(buscar).not.toHaveBeenCalled();

    await usuario.clear(screen.getByLabelText('De'));
    await usuario.type(screen.getByLabelText('De'), '2026-10-15');
    await usuario.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() =>
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toEqual({
        inicio: '2026-10-15',
        gerado: '1',
      }),
    );
    expect(buscar).toHaveBeenCalledWith({ inicio: '2026-10-15' }, expect.anything());
    expect(await screen.findByText('Total vendido')).toBeInTheDocument();
    expect(screen.getByText('R$ 100,00')).toBeInTheDocument();
    const tabela = screen.getByRole('table', { name: 'Vendas por forma de pagamento' });
    const rodape = within(tabela).getAllByRole('row').at(-1)!;
    expect(rodape).toHaveTextContent('Total');
    expect(rodape).toHaveTextContent('R$ 150,00');
  });

  it('link com filtros na URL já abre gerado; cabeçalho de impressão traz empresa, filtros e usuário', async () => {
    const { buscar } = montar({ url: '/relatorios/x?situacao=canceladas&gerado=1' });
    expect(await screen.findByText('PIX')).toBeInTheDocument();
    expect(buscar).toHaveBeenCalledWith({ inicio: '2026-10-01', situacao: 'canceladas' }, expect.anything());
    expect(screen.getByText('Filtros: De: 2026-10-01 · Situação: Canceladas')).toBeInTheDocument();
    expect(screen.getByText(/Emitido em .* por MARIA SILVA/)).toBeInTheDocument();
    expect(screen.getByText('Ice Beer')).toBeInTheDocument();
  });

  it('Exportar: Excel pela API; PDF e Imprimir pelo layout de impressão; exige relatorios.exportar', async () => {
    const usuario = userEvent.setup();
    const imprimir = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const { exportar, unmount } = montar({ gerarAoAbrir: true });
    await screen.findByText('PIX');
    await usuario.click(screen.getByRole('button', { name: 'Exportar' }));
    await usuario.click(await screen.findByRole('menuitem', { name: 'Excel (.xlsx)' }));
    await waitFor(() => expect(salvarArquivo).toHaveBeenCalledWith(expect.any(Blob), 'Relatorio.xlsx'));
    expect(exportar).toHaveBeenCalledWith({ inicio: '2026-10-01' }, 'xlsx');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exportar' })).toBeEnabled());
    await usuario.click(screen.getByRole('button', { name: 'Exportar' }));
    await usuario.click(await screen.findByRole('menuitem', { name: 'PDF', hidden: true }));
    expect(imprimir).toHaveBeenCalledTimes(1);
    unmount();

    montar({ gerarAoAbrir: true, permissoes: [] });
    await screen.findByText('PIX');
    expect(screen.queryByRole('button', { name: 'Exportar' })).not.toBeInTheDocument();
  });
});

/** Linha do relatório de teste (só nos testes: nenhum relatório falso vai para produção). */
interface LinhaTeste {
  id: number;
  descricao: string;
}

const TOTAL_TESTE = 100_000;

type Requisicao = { url: URL; metodo: string };

/**
 * O "servidor" do relatório de teste: 100 mil linhas geradas sob demanda, devolvendo só a página pedida (por página
 * e tamanho, com o total, ou por cursor, com o próximo).
 */
function servidorRelatorio(paginacao: PaginacaoRelatorio) {
  return ({ url }: Requisicao): RespostaFalsa | undefined => {
    if (url.pathname !== '/api/relatorios/teste') return undefined;
    const tamanho = Number(url.searchParams.get('tamanho'));
    const inicio =
      paginacao === 'pagina'
        ? (Number(url.searchParams.get('pagina')) - 1) * tamanho
        : Number(url.searchParams.get('cursor') ?? 0);
    const n = Math.max(0, Math.min(tamanho, TOTAL_TESTE - inicio));
    const linhas = Array.from({ length: n }, (_, i) => ({
      id: inicio + i + 1,
      descricao: `Produto ${inicio + i + 1}`,
    }));
    return {
      corpo:
        paginacao === 'pagina'
          ? { linhas, total: TOTAL_TESTE }
          : { linhas, proximoCursor: inicio + n < TOTAL_TESTE ? String(inicio + n) : null },
    };
  };
}

function configTeste(
  paginacao: PaginacaoRelatorio,
  extra: Partial<ConfigRelatorio<LinhaTeste>> = {},
): ConfigRelatorio<LinhaTeste> {
  return {
    nome: 'teste',
    titulo: 'Relatório de teste',
    filtros: [{ campo: 'texto', rotulo: 'Texto', tipo: 'texto' }],
    colunas: [
      { campo: 'id', rotulo: 'Nº' },
      { campo: 'descricao', rotulo: 'Descrição' },
    ],
    chaveLinha: (l) => String(l.id),
    buscar: (p, sinal) =>
      apiErp.get<ResultadoRelatorio<LinhaTeste>>(`/relatorios/teste${query(p)}`, { sinal }),
    paginacao,
    ...extra,
  };
}

const pedidosRelatorio = (chamadas: Array<{ url: URL }>) =>
  chamadas
    .filter((c) => c.url.pathname === '/api/relatorios/teste')
    .map((c) => Object.fromEntries(c.url.searchParams));

async function escolherTamanho(usuario: ReturnType<typeof userEvent.setup>, valor: string) {
  const seletor = screen.getAllByLabelText('Linhas por página').find((e) => e.tagName === 'INPUT')!;
  await usuario.click(seletor);
  await waitFor(() => expect(seletor).toHaveAttribute('aria-controls'));
  const lista = document.getElementById(seletor.getAttribute('aria-controls')!)!;
  await usuario.click(within(lista).getByRole('option', { name: valor, hidden: true }));
}

describe('<Relatorio> paginado no servidor (F2-B30)', () => {
  it('100 mil linhas: só a página vai e volta; página e tamanho na URL, com o total da API', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...rotasSessao(), servidorRelatorio('pagina'));
    const { router } = renderizarComSessao(
      <Relatorio config={configTeste('pagina')} />,
      '/relatorios/teste?gerado=1',
    );
    expect(await screen.findByText('Produto 50')).toBeInTheDocument();
    expect(screen.getByText('100.000 registros')).toBeInTheDocument();
    expect(screen.getAllByText('Página 1 de 2.000').length).toBeGreaterThan(0);
    const tabela = screen.getByRole('table', { name: 'Relatório de teste' });
    expect(within(tabela).getAllByRole('row')).toHaveLength(51);
    expect(pedidosRelatorio(chamadas).at(-1)).toEqual({ pagina: '1', tamanho: '50' });

    const busca = () => new URLSearchParams(router.state.location.search);
    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(busca().get('pagina')).toBe('2'));
    expect(await screen.findByText('Produto 51')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Última página' }));
    expect(await screen.findByText('Produto 100000')).toBeInTheDocument();
    expect(busca().get('pagina')).toBe('2000');
    expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
    expect(pedidosRelatorio(chamadas).at(-1)).toEqual({ pagina: '2000', tamanho: '50' });

    // O tamanho volta à primeira página; o Filtrar mantém o tamanho e volta à primeira.
    await escolherTamanho(usuario, '20');
    await waitFor(() => expect(busca().get('tamanho')).toBe('20'));
    expect(busca().get('pagina')).toBeNull();
    expect(await screen.findAllByText('Página 1 de 5.000')).not.toHaveLength(0);
    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(busca().get('pagina')).toBe('2'));
    await usuario.type(screen.getByLabelText('Texto'), 'x');
    await usuario.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() =>
      expect(Object.fromEntries(busca())).toEqual({ texto: 'x', tamanho: '20', gerado: '1' }),
    );
    await waitFor(() =>
      expect(pedidosRelatorio(chamadas).at(-1)).toEqual({ texto: 'x', pagina: '1', tamanho: '20' }),
    );
  });

  it('o link com a página na URL reabre a mesma página', async () => {
    const { chamadas } = simularApi(...rotasSessao(), servidorRelatorio('pagina'));
    renderizarComSessao(
      <Relatorio config={configTeste('pagina')} />,
      '/relatorios/teste?gerado=1&pagina=1234&tamanho=20',
    );
    expect(await screen.findByText('Produto 24661')).toBeInTheDocument();
    expect(pedidosRelatorio(chamadas).at(-1)).toEqual({ pagina: '1234', tamanho: '20' });
  });

  it('por cursor: Próxima leva o cursor da API na URL; Anterior e Primeira voltam', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...rotasSessao(), servidorRelatorio('cursor'));
    const { router } = renderizarComSessao(
      <Relatorio config={configTeste('cursor', { tamanhoPadrao: 20 })} />,
      '/relatorios/teste?gerado=1',
    );
    expect(await screen.findByText('Produto 20')).toBeInTheDocument();
    expect(pedidosRelatorio(chamadas).at(-1)).toEqual({ tamanho: '20' });
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    const busca = () => new URLSearchParams(router.state.location.search);

    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(await screen.findByText('Produto 21')).toBeInTheDocument();
    expect(busca().get('cursor')).toBe('20');
    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(await screen.findByText('Produto 41')).toBeInTheDocument();
    expect(screen.getAllByText('Página 3').length).toBeGreaterThan(0);
    expect(pedidosRelatorio(chamadas).at(-1)).toEqual({ tamanho: '20', cursor: '40' });

    await usuario.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(await screen.findByText('Produto 21')).toBeInTheDocument();
    expect(busca().get('cursor')).toBe('20');
    await usuario.click(screen.getByRole('button', { name: 'Primeira página' }));
    expect(await screen.findByText('Produto 1')).toBeInTheDocument();
    expect(busca().get('cursor')).toBeNull();
    expect(screen.getByRole('button', { name: 'Primeira página' })).toBeDisabled();
  });

  it('por cursor: o Voltar e o Avançar do navegador trazem a página e a pilha dos cursores juntas', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasSessao(), servidorRelatorio('cursor'));
    const { router } = renderizarComSessao(
      <Relatorio config={configTeste('cursor', { tamanhoPadrao: 20 })} />,
      '/relatorios/teste?gerado=1',
    );
    expect(await screen.findByText('Produto 20')).toBeInTheDocument();
    const busca = () => new URLSearchParams(router.state.location.search);
    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(await screen.findByText('Produto 21')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(await screen.findByText('Produto 41')).toBeInTheDocument();
    expect(screen.getAllByText('Página 3').length).toBeGreaterThan(0);

    // Voltar do navegador: a página 2, com o rótulo e o "Anterior" da página 2.
    await act(() => router.navigate(-1));
    expect(await screen.findByText('Produto 21')).toBeInTheDocument();
    expect(busca().get('cursor')).toBe('20');
    expect(screen.getAllByText('Página 2').length).toBeGreaterThan(0);
    expect(screen.queryByText('Página 3')).not.toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(await screen.findByText('Produto 1')).toBeInTheDocument();
    expect(busca().get('cursor')).toBeNull();
    expect(screen.getAllByText('Página 1').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();

    // Voltar duas vezes e Avançar: cada entrada do histórico tem a própria pilha.
    await act(() => router.navigate(-1));
    expect(await screen.findByText('Produto 21')).toBeInTheDocument();
    expect(screen.getAllByText('Página 2').length).toBeGreaterThan(0);
    await act(() => router.navigate(-1));
    expect(await screen.findByText('Produto 1')).toBeInTheDocument();
    expect(screen.getAllByText('Página 1').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
    await act(() => router.navigate(1));
    expect(await screen.findByText('Produto 21')).toBeInTheDocument();
    expect(screen.getAllByText('Página 2').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Página anterior' })).toBeEnabled();
  });

  it('trocar a loja de contexto (filtro fora da URL) volta à primeira página, sem o cursor da loja anterior', async () => {
    const usuario = userEvent.setup();
    const LOJA_B = '0192f000-0000-7000-8000-0000000000bb';
    const { chamadas } = simularApi(...rotasSessao(), servidorRelatorio('cursor'));
    function TrocarLoja() {
      const { definir } = useLojaContexto();
      return (
        <button type="button" onClick={() => definir(LOJA_B)}>
          Trocar para a loja B
        </button>
      );
    }
    const { router } = renderizarComSessao(
      <ProvedorLojaContexto chave="teste-relatorio-loja" permitidas={[LOJA_B]}>
        <TrocarLoja />
        <Relatorio
          config={configTeste('cursor', {
            tamanhoPadrao: 20,
            filtros: [{ campo: 'lojaId', rotulo: 'Loja', tipo: 'loja' }],
          })}
        />
      </ProvedorLojaContexto>,
      '/relatorios/teste?gerado=1',
    );
    expect(await screen.findByText('Produto 20')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(await screen.findByText('Produto 21')).toBeInTheDocument();
    const busca = () => new URLSearchParams(router.state.location.search);
    expect(busca().get('cursor')).toBe('20');

    await usuario.click(screen.getByRole('button', { name: 'Trocar para a loja B' }));
    expect(await screen.findByText('Produto 1')).toBeInTheDocument();
    expect(busca().get('cursor')).toBeNull();
    expect(screen.getAllByText('Página 1').length).toBeGreaterThan(0);
    expect(screen.queryByText('Página aberta pelo link')).not.toBeInTheDocument();
    // Nenhum pedido juntou a loja nova com o cursor da anterior.
    const daLojaB = pedidosRelatorio(chamadas).filter((p) => p.lojaId === LOJA_B);
    expect(daLojaB).toEqual([{ lojaId: LOJA_B, tamanho: '20' }]);
  });

  it('seleção de linhas: marca uma ou a página toda, a ação recebe as linhas; trocar de página limpa', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasSessao(), servidorRelatorio('pagina'));
    const acao = vi.fn();
    renderizarComSessao(
      <Relatorio
        config={configTeste('pagina', {
          tamanhoPadrao: 20,
          selecao: {
            rotuloLinha: (l) => l.descricao,
            acoes: (linhas, limpar) => (
              <button
                type="button"
                onClick={() => {
                  acao(linhas.map((l) => l.id));
                  limpar();
                }}
              >
                Definir em lote
              </button>
            ),
          },
        })}
      />,
      '/relatorios/teste?gerado=1',
    );
    await screen.findByText('Produto 20');
    expect(screen.queryByRole('toolbar', { name: 'Linhas selecionadas' })).not.toBeInTheDocument();
    await usuario.click(screen.getByRole('checkbox', { name: 'Selecionar Produto 2' }));
    await usuario.click(screen.getByRole('checkbox', { name: 'Selecionar Produto 5' }));
    const barra = screen.getByRole('toolbar', { name: 'Linhas selecionadas' });
    expect(within(barra).getByText('2 selecionada(s)')).toBeInTheDocument();
    const todas = screen.getByRole('checkbox', { name: 'Selecionar todas as linhas da página' });
    expect(todas).toHaveAttribute('data-indeterminate', 'true');
    await usuario.click(within(barra).getByRole('button', { name: 'Definir em lote' }));
    expect(acao).toHaveBeenCalledWith([2, 5]);
    expect(screen.queryByRole('toolbar', { name: 'Linhas selecionadas' })).not.toBeInTheDocument();

    await usuario.click(todas);
    expect(screen.getByText('20 selecionada(s)')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(await screen.findByText('Produto 21')).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Linhas selecionadas' })).not.toBeInTheDocument();
  });
});

function Autenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}

describe('critério de pronto do F2-B30: a exportação grande aparece no ícone Tarefas com o link', () => {
  it('202 vira tarefa: aviso e andamento no relatório, contador no ícone e o link quando termina', async () => {
    const usuario = userEvent.setup();
    const TAREFA = '0192f000-0000-7000-8000-000000000001';
    // A tarefa fica "executando" até o teste mandar terminar (sem esperar o intervalo da consulta no relógio).
    let situacao: 'nenhuma' | 'executando' | 'concluida' = 'nenhuma';
    const tarefa = () => ({
      id: TAREFA,
      tipo: 'exportar_relatorio',
      status: situacao,
      progressoPct: situacao === 'concluida' ? 100 : 30,
      mensagem: situacao === 'concluida' ? null : 'Linha 30.000 de 100.000',
      resultado:
        situacao === 'concluida'
          ? {
              relatorio: 'teste',
              formato: 'xlsx',
              linhas: 100_000,
              abas: 1,
              tamanhoBytes: 1234,
              nomeArquivo: 'Relatorio_Teste_07_11_2026_10_00.xlsx',
            }
          : null,
      erro: null,
      criadoEm: '2026-11-07T13:00:00.000Z',
      concluidaEm: situacao === 'concluida' ? '2026-11-07T13:01:00.000Z' : null,
      download: situacao === 'concluida' ? 'http://s3/Relatorio_Teste.xlsx' : null,
      downloadExpirado: false,
    });
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['relatorios.exportar'] }),
      servidorRelatorio('pagina'),
      ({ url }) =>
        url.pathname === '/api/relatorios/teste/exportar'
          ? ((situacao = 'executando'), { status: 202, corpo: { tarefaId: TAREFA, linhas: TOTAL_TESTE } })
          : undefined,
      ({ url }) => (url.pathname === `/api/tarefas/${TAREFA}` ? { corpo: tarefa() } : undefined),
      ({ url }) =>
        url.pathname === '/api/tarefas'
          ? {
              corpo:
                situacao === 'nenhuma'
                  ? { pendentes: 0, itens: [] }
                  : { pendentes: situacao === 'executando' ? 1 : 0, itens: [tarefa()] },
            }
          : undefined,
    );
    const { queryClient } = renderizarRotas(
      [
        {
          element: (
            <ProvedorSessao>
              <Outlet />
            </ProvedorSessao>
          ),
          children: [
            {
              element: (
                <Autenticado>
                  <Layout />
                </Autenticado>
              ),
              children: [
                {
                  path: '*',
                  element: (
                    <Relatorio config={configTeste('pagina', { exportar: exportarPelaApi('teste') })} />
                  ),
                },
              ],
            },
          ],
        },
      ],
      '/relatorios/teste?gerado=1&texto=cerveja',
    );
    expect(await screen.findByText('100.000 registros')).toBeInTheDocument();
    const icone = await screen.findByRole('button', { name: 'Tarefas' });

    await usuario.click(screen.getByRole('button', { name: 'Exportar' }));
    await usuario.click(await screen.findByRole('menuitem', { name: 'Excel (.xlsx)' }));
    // A exportação vai com os filtros, sem a página.
    const pedido = chamadas.find((c) => c.url.pathname === '/api/relatorios/teste/exportar')!;
    expect(Object.fromEntries(pedido.url.searchParams)).toEqual({ texto: 'cerveja', formato: 'xlsx' });
    expect(salvarArquivo).not.toHaveBeenCalled();

    const aviso = await screen.findByTestId('exportacao-em-tarefa');
    expect(within(aviso).getByText('Exportação em segundo plano · 100.000 linhas')).toBeInTheDocument();
    expect(within(aviso).getByRole('progressbar', { name: 'Progresso da exportação' })).toBeInTheDocument();
    expect(within(aviso).getByText(/Linha 30\.000 de 100\.000/)).toBeInTheDocument();
    // O ícone conta a tarefa em andamento (a lista foi atualizada na hora do 202).
    expect(await screen.findByRole('button', { name: 'Tarefas: 1 em andamento' })).toBe(icone);

    // Termina (a próxima consulta, que o intervalo faria, já acha a tarefa concluída): o link no aviso e no ícone,
    // com a notificação.
    situacao = 'concluida';
    await queryClient.invalidateQueries({ queryKey: CHAVE_TAREFAS });
    expect(await within(aviso).findByRole('link', { name: 'Baixar o arquivo' })).toHaveAttribute(
      'href',
      'http://s3/Relatorio_Teste.xlsx',
    );
    expect(
      within(aviso).getByText(/Relatorio_Teste_07_11_2026_10_00\.xlsx \(100\.000 linhas\)/),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Tarefas' })).toBe(icone);
    expect(await screen.findByText('Exportação de relatório: concluída')).toBeInTheDocument();
    await usuario.click(icone);
    const painel = await screen.findByRole('region', { name: 'Painel de tarefas' });
    const item = within(painel).getByTestId(`tarefa-${TAREFA}`);
    expect(within(item).getByText('Concluída')).toBeInTheDocument();
    expect(
      within(item).getByText(/Relatorio_Teste_07_11_2026_10_00\.xlsx · 100\.000 linha\(s\)/),
    ).toBeInTheDocument();
    expect(await within(item).findByRole('link', { name: /Baixar arquivo/ })).toHaveAttribute(
      'href',
      'http://s3/Relatorio_Teste.xlsx',
    );
  }, 15_000);
});
