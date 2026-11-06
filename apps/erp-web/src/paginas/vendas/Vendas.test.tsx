import type { PaginaVendas, SessaoCaixaDetalhe, VendaDetalhe } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { Dashboard, intervaloDoMes } from '../Dashboard';
import { diaOperacionalHoje } from './comum';
import { DetalheFechamentoCaixa } from './FechamentosCaixa';
import { DetalheVenda, ListaVendas } from './Vendas';

afterEach(() => vi.unstubAllGlobals());

const CENTRO = '01928f3a-0000-7000-8000-0000000000a1';
const TREINO = '01928f3a-0000-7000-8000-0000000000a9';
const SESSAO = '01928f3a-0000-7000-8000-0000000000c1';
const VENDA = '01928f3a-0000-7000-8000-0000000000d1';
const LOJAS = [
  { id: CENTRO, codigo: 1, nome: 'Loja 1 - Centro', ativa: true, treino: false },
  { id: TREINO, codigo: 9, nome: 'Loja Treino', ativa: true, treino: true },
];

const PAGINA: PaginaVendas = {
  itens: [
    {
      id: VENDA,
      numero: 2,
      numeroExibicao: 'L01-C01-000002',
      clienteId: null,
      clienteNome: null,
      diaOperacional: '2026-10-29',
      finalizadaEm: '2026-10-29T20:00:00.000Z',
      tipo: 'pdv',
      canal: 'pdv',
      status: 'cancelada',
      devolucao: 'nenhuma',
      statusFiscal: 'nao_aplicavel',
      subtotalBruto: '80.00',
      descontos: '0.00',
      total: '80.00',
      lojaId: CENTRO,
      lojaCodigo: 1,
      lojaNome: 'Loja 1 - Centro',
      lojaTreino: false,
      numeroCaixa: 1,
      operadorNome: 'MARIA',
    },
  ],
  total: 1,
  pagina: 1,
  tamanho: 20,
  totais: { quantidade: 1, canceladas: 1, totalBruto: '0.00', descontos: '0.00', totalLiquido: '0.00' },
};

describe('diaOperacionalHoje (D7)', () => {
  it('antes das 05:00 de Brasília ainda é o dia anterior', () => {
    expect(diaOperacionalHoje(new Date('2026-11-03T06:59:00Z'))).toBe('2026-11-02');
    expect(diaOperacionalHoje(new Date('2026-11-03T08:00:00Z'))).toBe('2026-11-03');
  });
  it('intervaloDoMes', () => {
    expect(intervaloDoMes('2026-02')).toEqual({ dataInicial: '2026-02-01', dataFinal: '2026-02-28' });
  });
});

describe('<ListaVendas> (ERP 15.4.1, C12)', () => {
  it('padrão: dia operacional de hoje e sem a loja de treino; a sessão vinda do link vai à API', async () => {
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['vendas.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === '/api/vendas' ? { corpo: PAGINA } : undefined),
    );
    renderizarComSessao(<ListaVendas />, `/vendas?sessaoCaixaId=${SESSAO}&dataInicial=&dataFinal=`);
    expect(await screen.findByText('L01-C01-000002')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Cancelada')).toBeInTheDocument();
    expect(screen.getByTestId('totais-vendas')).toHaveTextContent('1 cancelada(s), fora dos valores');
    expect(screen.getByRole('combobox', { name: 'Loja de treino' })).toHaveValue('Sem a loja de treino');
    const busca = chamadas.find((c) => c.url.pathname === '/api/vendas')!;
    expect(busca.url.searchParams.get('sessaoCaixaId')).toBe(SESSAO);
    expect(busca.url.searchParams.get('treino')).toBe('excluir');
    expect(busca.url.searchParams.has('dataInicial')).toBe(false);
    // Sem `usuarios.ver` e `formas_pagamento.ver` os filtros de operador e de forma não aparecem.
    expect(screen.queryByRole('combobox', { name: 'Operador PDV' })).not.toBeInTheDocument();
  }, 30_000);

  it('o filtro da sessão (link do fechamento) aparece como aviso e sai pelo Remover', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['vendas.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === '/api/vendas' ? { corpo: PAGINA } : undefined),
    );
    renderizarComSessao(
      <ListaVendas />,
      `/vendas?sessaoCaixaId=${SESSAO}&lojaId=${CENTRO}&dataInicial=&dataFinal=`,
    );
    const aviso = await screen.findByTestId('filtro-oculto-sessaoCaixaId');
    expect(aviso).toHaveTextContent('Mostrando só as vendas de uma sessão de caixa');
    // Trocar as datas e pesquisar mantém a sessão (o aviso continua dizendo por quê).
    await u.type(screen.getByLabelText('Data inicial (dia operacional)'), '29/10/2026');
    await u.click(screen.getByRole('button', { name: 'Pesquisar' }));
    expect(screen.getByTestId('filtro-oculto-sessaoCaixaId')).toBeInTheDocument();
    await u.click(within(aviso).getByRole('button', { name: 'Remover o filtro Sessão de caixa' }));
    await waitFor(() => expect(screen.queryByTestId('filtro-oculto-sessaoCaixaId')).not.toBeInTheDocument());
    const ultima = chamadas.filter((c) => c.url.pathname === '/api/vendas').at(-1)!;
    expect(ultima.url.searchParams.has('sessaoCaixaId')).toBe(false);
    expect(ultima.url.searchParams.get('lojaId')).toBe(CENTRO);
  }, 30_000);

  it('sem a sessão no link, as datas padrão são o dia operacional de hoje', async () => {
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['vendas.ver'], lojas: [LOJAS[0]!], todasLojas: true }),
      ({ url }) => (url.pathname === '/api/vendas' ? { corpo: { ...PAGINA, itens: [] } } : undefined),
    );
    renderizarComSessao(<ListaVendas />, '/vendas');
    await waitFor(() => expect(chamadas.some((c) => c.url.pathname === '/api/vendas')).toBe(true));
    const busca = chamadas.find((c) => c.url.pathname === '/api/vendas')!;
    expect(busca.url.searchParams.get('dataInicial')).toBe(diaOperacionalHoje());
    expect(busca.url.searchParams.get('dataFinal')).toBe(diaOperacionalHoje());
    // Sem loja de treino na empresa, sem o filtro; sem a sessão no link, sem o aviso dela.
    expect(screen.queryByRole('combobox', { name: 'Loja de treino' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('filtro-oculto-sessaoCaixaId')).not.toBeInTheDocument();
  }, 30_000);
});

const DETALHE: VendaDetalhe = {
  ...PAGINA.itens[0]!,
  modo: 'balcao',
  iniciadaEm: '2026-10-29T19:58:00.000Z',
  terminalId: null,
  terminalDescricao: 'PC do balcão',
  sessaoCaixaId: SESSAO,
  operadorId: 'u1',
  cpfCnpjNota: null,
  nomeNota: null,
  tipoPreco: 'varejo',
  qtdItens: 1,
  descontoItens: '0.00',
  descontoTotal: '0.00',
  descontoTotalOrigem: null,
  acrescimoTotal: '0.00',
  troco: '0.00',
  observacao: null,
  relogioConfiavel: true,
  canceladaEm: '2026-10-29T20:10:00.000Z',
  canceladaPorNome: 'MARIA',
  cancelamentoAutorizadoPorNome: 'GERENTE',
  motivoCancelamento: 'Cliente desistiu da compra apos o pagamento',
  cancelamentoOrigem: 'pdv',
  itens: [
    {
      id: 'i1',
      sequencia: 1,
      produtoId: 'p1',
      produtoCodigo: 7,
      descricao: 'CERV BRAHMA LT 350ML',
      codigoLido: null,
      unidade: 'UN',
      quantidade: '16.000',
      precoTabela: '5.0000',
      precoUnitario: '5.0000',
      origemPreco: 'varejo',
      valorBruto: '80.00',
      descontoItem: '0.00',
      descontoRateado: '0.00',
      valorLiquido: '80.00',
      kitDescricao: null,
      vasilhameItemOrigemId: null,
      lote: null,
      cancelado: false,
      canceladoEm: null,
      canceladoPorNome: null,
      motivoCancelamento: null,
      custoUnitario: null,
    },
  ],
  pagamentos: [
    {
      id: 'pg1',
      sequencia: 1,
      formaPagamentoId: 'f1',
      descricaoForma: 'Cartão de Crédito',
      tipoForma: 'cartao_credito',
      valor: '80.00',
      valorRecebido: null,
      troco: '0.00',
      parcelas: 1,
      status: 'estornado',
      bandeiraNome: 'Visa',
      nsu: '123',
      autorizacao: null,
      autorizadoPorNome: null,
    },
  ],
  lucro: null,
};

describe('<DetalheVenda> (ERP 15.4.2, C12)', () => {
  it('venda cancelada: aviso com o motivo, itens e, no Financeiro, pagamento estornado sem o lucro', async () => {
    const u = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: ['vendas.ver', 'fechamentos_caixa.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === `/api/vendas/${VENDA}` ? { corpo: DETALHE } : undefined),
    );
    renderizarComSessao(<DetalheVenda />, `/vendas/${VENDA}`, 'vendas/:id/:aba?');
    expect(await screen.findByRole('heading', { name: 'Venda L01-C01-000002' })).toBeInTheDocument();
    expect(screen.getByText(/Motivo: Cliente desistiu da compra apos o pagamento/)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Itens da venda' })).toHaveTextContent(
      '7 - CERV BRAHMA LT 350ML',
    );
    expect(screen.getByRole('link', { name: 'Ver fechamento' })).toHaveAttribute(
      'href',
      `/financeiro/fechamentos-caixa/${SESSAO}`,
    );
    await u.click(screen.getByRole('tab', { name: 'Financeiro' }));
    const pagamentos = await screen.findByRole('table', { name: 'Pagamentos da venda' });
    expect(within(pagamentos).getByText('estornado')).toBeInTheDocument();
    expect(within(pagamentos).getByText('Visa · NSU 123')).toBeInTheDocument();
    expect(screen.queryByText('Lucro')).not.toBeInTheDocument();
  }, 30_000);
});

const SESSAO_DETALHE: SessaoCaixaDetalhe = {
  id: SESSAO,
  lojaId: CENTRO,
  lojaCodigo: 1,
  lojaNome: 'Loja 1 - Centro',
  lojaTreino: false,
  numeroCaixa: 1,
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
  caixaId: 'c1',
  terminalId: 't1',
  terminalDescricao: 'PC do balcão',
  operadorId: 'u1',
  fundoTroco: '150.00',
  aberturaAutomatica: false,
  sessaoAnteriorId: null,
  valorRecebidoAnterior: null,
  diferencaRecebimento: null,
  fechamentoForcadoMotivo: null,
  fechamento: {
    id: 'fc1',
    tipo: 'fechamento',
    zeraCaixa: true,
    ocorridoEm: '2026-10-29T23:05:00.000Z',
    fechamentoCego: true,
    recontagem: false,
    justificativa: null,
    usuarioAnteriorNome: 'MARIA',
    usuarioSubsequenteNome: null,
    resumo: {},
  },
  formas: [
    {
      formaPagamentoId: 'f1',
      descricaoForma: 'Dinheiro',
      tipoForma: 'dinheiro',
      valorCalculado: '225.00',
      valorInformado: '223.50',
      diferenca: '-1.50',
      quantidadePagamentos: 2,
    },
    {
      formaPagamentoId: 'f2',
      descricaoForma: 'PIX',
      tipoForma: 'pix',
      valorCalculado: '35.00',
      valorInformado: '35.00',
      diferenca: '0.00',
      quantidadePagamentos: 2,
    },
  ],
  calculoDinheiro: {
    fundoTroco: '150.00',
    vendasDinheiro: '65.00',
    trocoOutrasFormas: '0.00',
    reforcos: '50.00',
    sangrias: '0.00',
    estornosDinheiro: '40.00',
    devolucoes: '0.00',
    esperado: '225.00',
    sangriaFechamento: '223.50',
  },
  movimentos: [
    {
      id: 'm1',
      tipo: 'sangria',
      ocorridoEm: '2026-10-29T15:20:00.000Z',
      valor: '1000.00',
      formaPagamentoDescricao: null,
      quemRetira: 'CARLOS',
      observacao: 'Depósito banco',
      cancelado: true,
    },
  ],
  vendas: { quantidade: 2, total: '60.00', canceladas: 1, totalCanceladas: '80.00' },
};

describe('<DetalheFechamentoCaixa> (ERP 14.9, C12; O3)', () => {
  it('formas com calculado × informado × diferença, o esperado na gaveta e o link das vendas da sessão', async () => {
    simularApi(
      ...rotasSessao({ permissoes: ['fechamentos_caixa.ver', 'vendas.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === `/api/sessoes-caixa/${SESSAO}` ? { corpo: SESSAO_DETALHE } : undefined),
    );
    renderizarComSessao(
      <DetalheFechamentoCaixa />,
      `/financeiro/fechamentos-caixa/${SESSAO}`,
      'financeiro/fechamentos-caixa/:id',
    );
    const formas = await screen.findByRole('table', { name: 'Resumo por forma de pagamento' });
    const dinheiro = within(formas).getByText('Dinheiro').closest('tr')!;
    expect(dinheiro).toHaveTextContent('R$ 225,00');
    expect(dinheiro).toHaveTextContent('R$ 223,50');
    expect(dinheiro).toHaveTextContent('R$ -1,50');
    expect(screen.getByTestId('esperado-gaveta')).toHaveTextContent('R$ 225,00');
    expect(screen.queryByText(/ainda falta chegar/)).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Movimentos da sessão' })).toHaveTextContent(
      'Sangria (cancelado)',
    );
    expect(screen.getByRole('link', { name: 'Ver as vendas da sessão' })).toHaveAttribute(
      'href',
      `/vendas?sessaoCaixaId=${SESSAO}&lojaId=${CENTRO}&dataInicial=&dataFinal=`,
    );
  }, 30_000);

  it('o calculado do PDV diferente do refeito na nuvem avisa evento da sessão ainda por chegar', async () => {
    simularApi(
      ...rotasSessao({ permissoes: ['fechamentos_caixa.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) =>
        url.pathname === `/api/sessoes-caixa/${SESSAO}`
          ? {
              corpo: {
                ...SESSAO_DETALHE,
                calculoDinheiro: { ...SESSAO_DETALHE.calculoDinheiro, esperado: '185.00' },
              },
            }
          : undefined,
    );
    renderizarComSessao(
      <DetalheFechamentoCaixa />,
      `/financeiro/fechamentos-caixa/${SESSAO}`,
      'financeiro/fechamentos-caixa/:id',
    );
    expect(await screen.findByText(/ainda falta chegar/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ver as vendas da sessão' })).not.toBeInTheDocument();
  }, 30_000);
});

describe('<DetalheFechamentoCaixa> da sessão fechada pela nuvem (MD 3.12.1)', () => {
  const renderizar = (corpo: SessaoCaixaDetalhe) => {
    simularApi(
      ...rotasSessao({ permissoes: ['fechamentos_caixa.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === `/api/sessoes-caixa/${SESSAO}` ? { corpo } : undefined),
    );
    renderizarComSessao(
      <DetalheFechamentoCaixa />,
      `/financeiro/fechamentos-caixa/${SESSAO}`,
      'financeiro/fechamentos-caixa/:id',
    );
  };

  it('sem o caixa.fechado: "Fechada pela nuvem" e o alerta de que o fechamento não chegou', async () => {
    renderizar({
      ...SESSAO_DETALHE,
      situacao: 'fechada_forcado',
      fechamentoForcadoMotivo: 'substituicao_terminal',
      tipoFechamento: null,
      fechamento: null,
      formas: [],
    });
    expect(
      await screen.findByText(/Sessão fechada pela nuvem na substituição do terminal/),
    ).toHaveTextContent('o fechamento do caixa ainda não chegou');
    expect(screen.getByText('Fechada pela nuvem')).toBeInTheDocument();
  }, 30_000);

  it('com o fechamento tardio já gravado: "Fechada", sem o alerta, e a marca de que a nuvem fechou', async () => {
    renderizar({ ...SESSAO_DETALHE, situacao: 'fechada', fechamentoForcadoMotivo: 'substituicao_terminal' });
    expect(await screen.findByText(/o fechamento do caixa chegou depois/)).toBeInTheDocument();
    expect(screen.queryByText(/ainda não chegou/)).not.toBeInTheDocument();
    expect(screen.queryByText('Fechada pela nuvem')).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Resumo por forma de pagamento' })).toHaveTextContent(
      'R$ 223,50',
    );
  }, 30_000);
});

describe('Dashboard com loja de treino (O10)', () => {
  it('"Incluir loja de treino" manda treino=incluir; o card de vendas leva à listagem do mês', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: ['dashboard.ver', 'vendas.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) =>
        url.pathname === '/api/dashboard'
          ? {
              corpo: {
                mes: '2026-10',
                rotuloMes: 'Outubro/2026',
                lojaId: null,
                geradoEm: '2026-10-30T15:00:00.000Z',
                pessoas: { ativas: 0, novasNoMes: 0 },
                produtos: { ativos: 0, semPreco: 0, ncmInvalido: 0 },
                vendas: {
                  total: '70.00',
                  quantidade: 2,
                  ticketMedio: '35.00',
                  porLoja: [
                    {
                      lojaId: TREINO,
                      lojaCodigo: 9,
                      lojaNome: 'Loja Treino',
                      lojaTreino: true,
                      totalDia: '0.00',
                      quantidadeDia: 0,
                      totalMes: '20.00',
                      quantidadeMes: 1,
                    },
                  ],
                },
                vendasPorDia: [],
                financeiro: null,
                pdvs: null,
                estoqueBaixo: null,
              },
            }
          : undefined,
    );
    renderizarComSessao(<Dashboard />, '/');
    const cards = await screen.findByTestId('cards-dashboard');
    expect(within(cards).getByText('R$ 70,00')).toBeInTheDocument();
    // Sem mês escolhido, a API decide (mês do dia operacional da empresa, D7) e o campo mostra o que ela devolveu.
    const primeira = chamadas.find((c) => c.url.pathname === '/api/dashboard')!;
    expect(primeira.url.searchParams.has('mes')).toBe(false);
    expect(screen.getByLabelText('Mês/Ano')).toHaveTextContent(/outubro\/2026/i);
    expect(within(cards).getByRole('link', { name: 'Listagem' })).toHaveAttribute(
      'href',
      '/vendas?dataInicial=2026-10-01&dataFinal=2026-10-31&situacao=finalizada&lojaId=',
    );
    expect(screen.getByRole('table', { name: 'Vendas por loja' })).toHaveTextContent('treino');
    await u.click(screen.getByRole('checkbox', { name: 'Incluir loja de treino' }));
    await u.click(screen.getByRole('button', { name: 'Filtrar' }));
    await waitFor(() =>
      expect(
        chamadas.some(
          (c) => c.url.pathname === '/api/dashboard' && c.url.searchParams.get('treino') === 'incluir',
        ),
      ).toBe(true),
    );
    // O link do card leva a listagem com a loja de treino junto, o mesmo recorte do total.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('cards-dashboard')).getByRole('link', { name: 'Listagem' }),
      ).toHaveAttribute(
        'href',
        '/vendas?dataInicial=2026-10-01&dataFinal=2026-10-31&situacao=finalizada&treino=incluir&lojaId=',
      ),
    );
  }, 30_000);
});
