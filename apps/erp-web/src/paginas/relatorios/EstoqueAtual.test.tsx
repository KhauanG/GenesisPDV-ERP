import type { LinhaEstoqueAtual, RespostaEstoqueAtual, TipoEstoqueOpcao } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { ModalAjustarEstoque } from '../produtos/BlocosProduto';
import { EstoqueAtual } from './EstoqueAtual';

afterEach(() => vi.unstubAllGlobals());

const id = (n: number) => `0190a000-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`;
const ESTOQUE = id(1);
const DISPONIVEL = id(2);
const AVARIA = id(3);
const PRODUTO = id(4);

const TIPOS: TipoEstoqueOpcao[] = [
  {
    id: DISPONIVEL,
    nome: 'Disponível',
    vendavel: true,
    padrao: true,
    ativo: true,
    chaveSistema: 'disponivel',
    versao: 1,
  },
  {
    id: AVARIA,
    nome: 'Avaria',
    vendavel: false,
    padrao: false,
    ativo: true,
    chaveSistema: 'avaria',
    versao: 1,
  },
];

const linha = (extra: Partial<LinhaEstoqueAtual> = {}): LinhaEstoqueAtual => ({
  chave: `${ESTOQUE}:${PRODUTO}::${DISPONIVEL}`,
  estoqueId: ESTOQUE,
  estoqueNome: 'Estoque Loja 1',
  tipoEstoqueId: DISPONIVEL,
  tipoEstoqueNome: 'Disponível',
  produtoId: PRODUTO,
  produtoCodigo: 12,
  produtoNome: 'CERV SERRA IPA 600',
  variacaoId: null,
  codigoInterno: 'IPA-600',
  marcaNome: 'Cervejaria Serra',
  unidadeSigla: 'UN',
  quantidade: '10.000',
  emTransito: '6.000',
  divergenciaATratar: '0.000',
  estoqueMinimo: '4.000',
  custoMedio: '4.0000',
  custoTotal: '40.00',
  precoVenda: '10.0000',
  precoAtacado: '9.0000',
  precoIfood: '12.5000',
  vendaTotal: '100.00',
  vencendo: null,
  ...extra,
});

const resposta = (
  itens: LinhaEstoqueAtual[],
  extra: Partial<RespostaEstoqueAtual> = {},
): RespostaEstoqueAtual => ({
  itens,
  total: itens.length,
  pagina: 1,
  tamanho: 50,
  totais: { quantidadeItens: itens.length, custoTotal: '40.00', vendaTotal: '100.00' },
  dataBase: null,
  ...extra,
});

const PERMISSOES = [
  'relatorios.estoque_atual',
  'relatorios.exportar',
  'produtos.ver_custo',
  'estoque_acertos.criar',
];

function api(
  opcoes: {
    permissoes?: string[];
    relatorio?: (url: URL) => RespostaEstoqueAtual;
    tipos?: TipoEstoqueOpcao[];
  } = {},
) {
  const permissoes = opcoes.permissoes ?? PERMISSOES;
  return simularApi(...rotasSessao({ permissoes }), ({ url, metodo }) => {
    if (url.pathname === '/api/tipos-estoque') return { corpo: opcoes.tipos ?? TIPOS };
    if (url.pathname === '/api/estoques')
      return {
        corpo: {
          itens: [
            {
              id: ESTOQUE,
              codigo: 1,
              nome: 'Estoque Loja 1',
              tipo: 'loja',
              lojaId: null,
              lojaNome: null,
              ativo: true,
              versao: 1,
            },
          ],
          total: 1,
          pagina: 1,
          tamanho: 'todos',
        },
      };
    if (url.pathname === '/api/marcas')
      return { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } };
    if (url.pathname === '/api/categorias/arvore') return { corpo: [] };
    if (metodo === 'GET' && url.pathname === '/api/relatorios/estoque-atual') {
      const custo = permissoes.includes('produtos.ver_custo');
      const r = opcoes.relatorio?.(url) ?? resposta([linha()]);
      return {
        corpo: custo
          ? r
          : {
              ...r,
              itens: r.itens.map((l) => ({ ...l, custoMedio: null, custoTotal: null })),
              totais: { ...r.totais, custoTotal: null },
            },
      };
    }
    if (metodo === 'POST' && url.pathname === '/api/relatorios/estoque-atual/ajustar')
      return { corpo: { acertoId: id(9), codigo: 77, diferenca: '2.000', movimentos: 1, compensacoes: 0 } };
    return undefined;
  });
}

/** As consultas da tabela principal (as do modal filtram o produto: `produtoId`). */
const daTabela = (chamadas: Array<{ url: URL }>) =>
  chamadas.filter(
    (c) => c.url.pathname === '/api/relatorios/estoque-atual' && !c.url.searchParams.has('produtoId'),
  );

const abrir = (busca = 'gerado=1') =>
  renderizarComSessao(<EstoqueAtual />, `/relatorios/estoque-atual?${busca}`);

describe('<EstoqueAtual> (ERP 16.4; F2-B31)', () => {
  it('mostra as colunas do Nuvem3 com o Em trânsito, os totais do relatório e manda os filtros da URL', async () => {
    const { chamadas } = api();
    abrir(`gerado=1&estoqueId=${ESTOQUE}&nome=IPA`);
    const tabela = await screen.findByRole('table', { name: 'Estoque Atual' });
    const cabecalho = [...tabela.querySelectorAll('thead th')].map((c) => c.textContent);
    expect(cabecalho).toEqual([
      'Ref. Interna',
      'Produto',
      'Preço Custo',
      'Venda',
      'Atacado',
      'iFood',
      'Est. Mínimo',
      'Est. Atual',
      'Em trânsito',
      'Divergência a tratar',
      'Custo total',
      'Venda total',
      'Unidade',
      'Estoque',
      'Tipo',
    ]);
    const l = within(tabela).getByRole('link', { name: '12 - CERV SERRA IPA 600' }).closest('tr')!;
    expect(l).toHaveTextContent('R$ 4,00');
    expect(l).toHaveTextContent('R$ 9,00');
    expect(l).toHaveTextContent('R$ 12,50');
    expect(within(l).getAllByRole('cell')[8]).toHaveTextContent('6');
    expect(l).toHaveTextContent('Estoque Loja 1');
    expect(within(tabela).getByText('Total (1 itens)')).toBeInTheDocument();
    const pedido = chamadas.find((c) => c.url.pathname === '/api/relatorios/estoque-atual')!;
    expect(Object.fromEntries(pedido.url.searchParams)).toMatchObject({
      estoqueId: ESTOQUE,
      nome: 'IPA',
      situacaoSaldo: 'todos',
      situacao: 'ativos',
      pagina: '1',
      tamanho: '50',
    });
  });

  it('sem "Ver custo", sem as colunas de custo; sem a loja de contexto, o estoque padrão é "Todas"', async () => {
    const { chamadas } = api({ permissoes: ['relatorios.estoque_atual'] });
    abrir();
    const tabela = await screen.findByRole('table', { name: 'Estoque Atual' });
    const cabecalho = [...tabela.querySelectorAll('thead th')].map((c) => c.textContent);
    expect(cabecalho).not.toContain('Preço Custo');
    expect(cabecalho).not.toContain('Custo total');
    expect(screen.queryByText('Custo total')).not.toBeInTheDocument();
    const pedido = chamadas.find((c) => c.url.pathname === '/api/relatorios/estoque-atual')!;
    expect(pedido.url.searchParams.get('estoqueId')).toBe('todas');
    // Sem `estoque_acertos.criar`, o saldo não abre o ajuste.
    expect(screen.queryByRole('button', { name: /Ajustar o saldo/ })).not.toBeInTheDocument();
  });

  it('o clique no saldo abre o modal com o estoque e o tipo da linha e grava o ajuste pela rota do relatório', async () => {
    const { chamadas } = api({
      relatorio: (url) =>
        url.searchParams.get('produtoId')
          ? resposta([
              linha(),
              linha({
                chave: 'avaria',
                tipoEstoqueId: AVARIA,
                tipoEstoqueNome: 'Avaria',
                quantidade: '2.000',
              }),
            ])
          : resposta([linha()]),
    });
    abrir(`gerado=1&estoqueId=${ESTOQUE}`);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Ajustar o saldo de CERV SERRA IPA 600 em Estoque Loja 1 (Disponível)',
      }),
    );
    const modal = await screen.findByRole('dialog', { name: 'Ajustar o saldo' });
    expect(within(modal).getByLabelText('Produto')).toHaveValue('12 - CERV SERRA IPA 600');
    expect(within(modal).getByLabelText('Estoque')).toHaveValue('Estoque Loja 1');
    // O "Saldo atual" vem da consulta do produto no estoque e acompanha a troca do tipo (o Avaria só existe nela).
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) =>
            c.url.pathname === '/api/relatorios/estoque-atual' &&
            c.url.searchParams.get('produtoId') === PRODUTO &&
            c.url.searchParams.get('estoqueId') === ESTOQUE,
        ),
      ).toBe(true),
    );
    expect(within(modal).getByTestId('saldo-atual-ajuste')).toHaveTextContent('10');
    const tipo = within(modal).getByLabelText(/^Tipo de estoque/);
    expect(tipo).toHaveValue('Disponível');
    await userEvent.click(tipo);
    const opcoes = await waitFor(() => document.getElementById(tipo.getAttribute('aria-controls')!)!);
    await userEvent.click(
      within(opcoes).getByRole('option', { name: 'Avaria (não vendável)', hidden: true }),
    );
    await waitFor(() => expect(within(modal).getByTestId('saldo-atual-ajuste')).toHaveTextContent('2'));
    await userEvent.click(tipo);
    await userEvent.click(
      within(document.getElementById(tipo.getAttribute('aria-controls')!)!).getByRole('option', {
        name: 'Disponível',
        hidden: true,
      }),
    );
    expect(within(modal).getByTestId('saldo-atual-ajuste')).toHaveTextContent('10');
    await userEvent.type(within(modal).getByLabelText(/Nova quantidade/), '12');
    await userEvent.type(within(modal).getByLabelText(/^Motivo/), 'Inventário');
    const antes = daTabela(chamadas).length;
    await userEvent.click(within(modal).getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname.startsWith('/api/relatorios'))!;
    expect(post.url.pathname).toBe('/api/relatorios/estoque-atual/ajustar');
    expect(post.corpo).toEqual({
      estoqueId: ESTOQUE,
      tipoEstoqueId: DISPONIVEL,
      quantidade: '12.000',
      motivo: 'Inventário',
      observacoes: null,
      produtoId: PRODUTO,
    });
    expect(await screen.findByText(/Acerto Nº 77 efetivado/)).toBeInTheDocument();
    // A tabela do relatório é consultada de novo (o saldo novo aparece sem recarregar); a consulta do modal não conta.
    await waitFor(() => expect(daTabela(chamadas).length).toBeGreaterThan(antes));
  });

  it('o saldo do tipo de estoque inativo não abre o ajuste (o modal não troca calado pelo tipo padrão)', async () => {
    api({
      tipos: TIPOS.map((t) => (t.id === AVARIA ? { ...t, ativo: false } : t)),
      relatorio: () =>
        resposta([
          linha(),
          linha({ chave: 'avaria', tipoEstoqueId: AVARIA, tipoEstoqueNome: 'Avaria', quantidade: '0.000' }),
        ]),
    });
    abrir(`gerado=1&estoqueId=${ESTOQUE}`);
    expect(
      await screen.findByRole('button', {
        name: 'Ajustar o saldo de CERV SERRA IPA 600 em Estoque Loja 1 (Disponível)',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /\(Avaria\)$/ })).not.toBeInTheDocument();
    const tabela = screen.getByRole('table', { name: 'Estoque Atual' });
    const avaria = within(tabela).getByText('Avaria').closest('tr')!;
    await userEvent.hover(within(avaria).getByText('0'));
    expect(
      await screen.findByText('Tipo de estoque inativo: reative o tipo para ajustar'),
    ).toBeInTheDocument();
  });

  it('na data-base e no "Todas" o saldo não abre o ajuste; a data-base dá nome à coluna e ao resumo', async () => {
    api({
      relatorio: (url) =>
        url.searchParams.get('dataBase')
          ? resposta([linha({ emTransito: null, divergenciaATratar: null })], { dataBase: '2026-11-06' })
          : resposta([linha({ estoqueId: null, estoqueNome: 'Todas', chave: 'todas' })]),
    });
    const { unmount } = abrir(`gerado=1&estoqueId=${ESTOQUE}&dataBase=2026-11-06`);
    const tabela = await screen.findByRole('table', { name: 'Estoque Atual' });
    expect(within(tabela).getByRole('columnheader', { name: 'Saldo em 06/11/2026' })).toBeInTheDocument();
    expect(screen.getByText('Saldo em')).toBeInTheDocument();
    expect(within(tabela).queryByRole('button', { name: /Ajustar o saldo/ })).not.toBeInTheDocument();
    unmount();
    abrir('gerado=1&estoqueId=todas');
    const todas = await screen.findByRole('table', { name: 'Estoque Atual' });
    expect(within(todas).getByText('Todas')).toBeInTheDocument();
    expect(within(todas).queryByRole('button', { name: /Ajustar o saldo/ })).not.toBeInTheDocument();
  });

  it('o modal com o tipo inicial inativo avisa e pede o tipo, em vez de cair no padrão', async () => {
    api({ tipos: TIPOS.map((t) => (t.id === AVARIA ? { ...t, ativo: false } : t)) });
    const enviar = vi.fn(async () => ({
      acertoId: id(9),
      codigo: 78,
      diferenca: '1.000',
      movimentos: 1,
      compensacoes: 0,
    }));
    renderizarComSessao(
      <ModalAjustarEstoque
        aberto
        produtoId={PRODUTO}
        saldos={[
          { estoqueId: ESTOQUE, tipoEstoqueId: DISPONIVEL, quantidade: '10.000' },
          { estoqueId: ESTOQUE, tipoEstoqueId: AVARIA, quantidade: '0.000' },
        ]}
        estoqueFixo={{ id: ESTOQUE, nome: 'Estoque Loja 1' }}
        tipoInicial={AVARIA}
        titulo="Ajustar o saldo"
        rotuloGravar="Gravar"
        enviar={enviar}
        aoAjustar={() => undefined}
        aoFechar={() => undefined}
      />,
      '/relatorios/estoque-atual',
    );
    const modal = await screen.findByRole('dialog', { name: 'Ajustar o saldo' });
    expect(await within(modal).findByTestId('tipo-inicial-inativo')).toHaveTextContent(/inativo/);
    const tipo = within(modal).getByLabelText(/^Tipo de estoque/);
    expect(tipo).toHaveValue('');
    expect(within(modal).getByTestId('saldo-atual-ajuste')).toHaveTextContent('0');
    await userEvent.type(within(modal).getByLabelText(/Nova quantidade/), '11');
    await userEvent.type(within(modal).getByLabelText(/^Motivo/), 'Inventário');
    await userEvent.click(within(modal).getByRole('button', { name: 'Gravar' }));
    expect(await within(modal).findByText('Escolha o tipo de estoque')).toBeInTheDocument();
    expect(enviar).not.toHaveBeenCalled();
    // Escolhido o Disponível, o saldo é o dele e o ajuste vai nele.
    await userEvent.click(tipo);
    const opcoes = await waitFor(() => document.getElementById(tipo.getAttribute('aria-controls')!)!);
    await userEvent.click(within(opcoes).getByRole('option', { name: 'Disponível', hidden: true }));
    expect(within(modal).getByTestId('saldo-atual-ajuste')).toHaveTextContent('10');
    await userEvent.click(within(modal).getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(enviar).toHaveBeenCalledOnce());
    expect(enviar.mock.calls[0]).toEqual([
      expect.objectContaining({ estoqueId: ESTOQUE, tipoEstoqueId: DISPONIVEL, quantidade: '11.000' }),
    ]);
  });

  it('com o "Vencendo", a coluna da quantidade e da validade mais próxima', async () => {
    api({
      relatorio: () => resposta([linha({ vencendo: { quantidade: '4.000', validade: '2026-11-10' } })]),
    });
    abrir(`gerado=1&estoqueId=${ESTOQUE}&vencendoEmDias=7`);
    const tabela = await screen.findByRole('table', { name: 'Estoque Atual' });
    expect(within(tabela).getByRole('columnheader', { name: 'Vencendo' })).toBeInTheDocument();
    expect(within(tabela).getByText('4 até 10/11/2026')).toBeInTheDocument();
  });
});
