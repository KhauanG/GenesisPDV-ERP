import type {
  ComprovanteMovimentoCaixa,
  MovimentoCaixaDetalhe,
  PaginaSessoesCaixa,
  SessaoCaixaDetalhe,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { DetalheFechamentoCaixa, ListaFechamentosCaixa } from './FechamentosCaixa';
import { DetalheReforco } from './MovimentosCaixa';
import { ComprovanteMovimentoImpressao } from './MovimentosCaixaComprovante';

/**
 * Conferência do fechamento (ERP 14.9; Fase 3, F3-B9; D114) e o comprovante de reforço e sangria (15.2, 15.3): o que a
 * tela desenha e manda. A regra da situação é a do shared (`situacaoConferencia`), a mesma da API.
 */

afterEach(() => vi.unstubAllGlobals());

const CENTRO = '01928f3a-0000-7000-8000-0000000000a1';
const SESSAO = '01928f3a-0000-7000-8000-0000000000c1';
const SESSAO_B = '01928f3a-0000-7000-8000-0000000000c2';
const DINHEIRO = '01928f3a-0000-7000-8000-0000000000f1';
const PIX = '01928f3a-0000-7000-8000-0000000000f2';
const LOJAS = [{ id: CENTRO, codigo: 1, nome: 'Loja 1 - Centro', ativa: true, treino: false }];

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
  totalConferido: null,
  diferencaConferida: null,
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
      formaPagamentoId: DINHEIRO,
      descricaoForma: 'Dinheiro',
      tipoForma: 'dinheiro',
      valorCalculado: '225.00',
      valorInformado: '223.50',
      diferenca: '-1.50',
      quantidadePagamentos: 2,
    },
    {
      formaPagamentoId: PIX,
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
  movimentos: [],
  vendas: { quantidade: 2, total: '60.00', canceladas: 1, totalCanceladas: '80.00' },
  conferencia: null,
  toleranciaConferencia: '0.00',
  motivoSemConferencia: null,
  avisosConferencia: [],
};

const CONFERIDA: SessaoCaixaDetalhe = {
  ...SESSAO_DETALHE,
  situacao: 'conferida',
  totalConferido: '260.00',
  diferencaConferida: '0.00',
  conferencia: {
    id: 'cc1',
    versao: 41,
    situacao: 'conferida',
    conferidoEm: '2026-10-30T12:00:00.000Z',
    conferidoPorNome: 'GERENTE',
    observacao: 'Envelope recontado',
    totalConferido: '260.00',
    diferenca: '0.00',
    formas: [
      { formaPagamentoId: DINHEIRO, valorConferido: '225.00', diferenca: '0.00' },
      { formaPagamentoId: PIX, valorConferido: '35.00', diferenca: '0.00' },
    ],
  },
};

function renderizarDetalhe(permissoes: string[], ...rotas: Parameters<typeof simularApi>) {
  const api = simularApi(...rotasSessao({ permissoes, lojas: LOJAS, todasLojas: true }), ...rotas);
  renderizarComSessao(
    <DetalheFechamentoCaixa />,
    `/financeiro/fechamentos-caixa/${SESSAO}`,
    'financeiro/fechamentos-caixa/:id',
  );
  return api;
}

const detalhe =
  (corpo: SessaoCaixaDetalhe) =>
  ({ url, metodo }: { url: URL; metodo: string }) =>
    metodo === 'GET' && url.pathname === `/api/sessoes-caixa/${corpo.id}` ? { corpo } : undefined;

/** A sessão A (a de cima) e a B, uma apontando para a outra como "sessão anterior" para navegar pelo link. */
const SESSAO_A_LIGADA: SessaoCaixaDetalhe = {
  ...SESSAO_DETALHE,
  sessaoAnteriorId: SESSAO_B,
  valorRecebidoAnterior: '149.00',
  diferencaRecebimento: '0.00',
};
const SESSAO_B_LIGADA: SessaoCaixaDetalhe = {
  ...SESSAO_DETALHE,
  id: SESSAO_B,
  numeroCaixa: 2,
  sessaoAnteriorId: SESSAO,
  valorRecebidoAnterior: '151.00',
  diferencaRecebimento: '0.00',
  totalInformado: '214.00',
  diferenca: '-46.00',
  formas: [
    { ...SESSAO_DETALHE.formas[0]!, valorInformado: '180.00', diferenca: '-45.00' },
    { ...SESSAO_DETALHE.formas[1]!, valorInformado: '34.00', diferenca: '-1.00' },
  ],
};

describe('Conferência do fechamento (ERP 14.9; F3-B9)', () => {
  it('com fechamentos_caixa.conferir: informado pré-preenchido, diferença e selo ao vivo, e o POST do que foi digitado', async () => {
    const u = userEvent.setup();
    const { chamadas } = renderizarDetalhe(
      ['fechamentos_caixa.ver', 'fechamentos_caixa.conferir'],
      detalhe(SESSAO_DETALHE),
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/sessoes-caixa/${SESSAO}/conferir`
          ? { corpo: CONFERIDA }
          : undefined,
    );
    const tabela = await screen.findByRole('table', { name: 'Conferência por forma de pagamento' });
    const campo = within(tabela).getByRole('textbox', { name: 'Conferido Dinheiro' });
    expect(campo).toHaveValue('223,50');
    expect(within(tabela).getByRole('textbox', { name: 'Conferido PIX' })).toHaveValue('35,00');
    // Tolerância R$ 0,00 (o padrão): R$ 1,50 a menos no dinheiro já é "Divergente".
    expect(screen.getByTestId('selo-conferencia')).toHaveTextContent('Ainda não conferida');
    expect(screen.getByText('Tolerância por forma: R$ 0,00 (Configurações › PDV)')).toBeInTheDocument();
    const previsto = () => screen.getByTestId('selo-previsto');
    expect(previsto()).toHaveTextContent('Divergente');
    expect(screen.getByTestId(`diferenca-conferida-${DINHEIRO}`)).toHaveTextContent('R$ -1,50');

    await u.clear(campo);
    await u.type(campo, '224,99');
    expect(previsto()).toHaveTextContent('Divergente');
    expect(screen.getByTestId(`diferenca-conferida-${DINHEIRO}`)).toHaveTextContent('R$ -0,01');
    await u.clear(campo);
    await u.type(campo, '225');
    expect(previsto()).toHaveTextContent('Conferida');
    expect(screen.getByTestId(`diferenca-conferida-${DINHEIRO}`)).toHaveTextContent('R$ 0,00');
    // Valor inválido trava o botão e some com a previsão.
    await u.type(campo, ',999');
    expect(screen.getByRole('button', { name: 'Conferir' })).toBeDisabled();
    expect(screen.queryByTestId('selo-previsto')).not.toBeInTheDocument();
    await u.clear(campo);
    await u.type(campo, '225');

    await u.type(screen.getByRole('textbox', { name: 'Observação' }), 'Envelope recontado');
    await u.click(screen.getByRole('button', { name: 'Conferir' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/conferir'))).toBe(true),
    );
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/conferir'))!;
    expect(post.corpo).toEqual({
      versao: null,
      formas: [
        { formaPagamentoId: DINHEIRO, valorConferido: '225' },
        { formaPagamentoId: PIX, valorConferido: '35,00' },
      ],
      observacao: 'Envelope recontado',
    });
    // A resposta é o detalhe atualizado: o selo da sessão e o refazer.
    expect(await screen.findByRole('button', { name: 'Refazer conferência' })).toBeInTheDocument();
    expect(screen.getByTestId('conferida-por')).toHaveTextContent('GERENTE');
    expect(screen.getByTestId('selo-conferencia')).toHaveTextContent('Conferida');
  }, 30_000);

  it('trocar de sessão com o detalhe já no cache recomeça o formulário (sem levar valores e observação da outra)', async () => {
    const u = userEvent.setup();
    const { chamadas } = renderizarDetalhe(
      ['fechamentos_caixa.ver', 'fechamentos_caixa.conferir'],
      detalhe(SESSAO_A_LIGADA),
      detalhe(SESSAO_B_LIGADA),
    );
    const dinheiro = () => screen.getByRole('textbox', { name: 'Conferido Dinheiro' });
    expect(await screen.findByRole('textbox', { name: 'Conferido Dinheiro' })).toHaveValue('223,50');
    // A → B: B ainda não está no cache (passa pelo Skeleton).
    await u.click(screen.getByRole('link', { name: 'R$ 149,00' }));
    expect(await screen.findByRole('heading', { name: /Caixa 2/ })).toBeInTheDocument();
    expect(dinheiro()).toHaveValue('180,00');
    expect(screen.getByRole('textbox', { name: 'Conferido PIX' })).toHaveValue('34,00');
    await u.clear(dinheiro());
    await u.type(dinheiro(), '181');
    await u.type(screen.getByRole('textbox', { name: 'Observação' }), 'Digitado em B');
    // B → A: A já está no cache, a tela não passa pelo Skeleton; o bloco tem de recomeçar com o informado de A.
    await u.click(screen.getByRole('link', { name: 'R$ 151,00' }));
    expect(await screen.findByRole('heading', { name: /Caixa 1/ })).toBeInTheDocument();
    expect(dinheiro()).toHaveValue('223,50');
    expect(screen.getByRole('textbox', { name: 'Conferido PIX' })).toHaveValue('35,00');
    expect(screen.getByRole('textbox', { name: 'Observação' })).toHaveValue('');
    expect(chamadas.some((c) => c.url.pathname.endsWith('/conferir'))).toBe(false);
  }, 30_000);

  it('gravar a conferência atualiza o Histórico da página, com a ação "Conferência"', async () => {
    const u = userEvent.setup();
    let gravada = false;
    renderizarDetalhe(
      ['fechamentos_caixa.ver', 'fechamentos_caixa.conferir', 'auditoria.ver'],
      detalhe(SESSAO_DETALHE),
      ({ url, metodo }) => {
        if (metodo === 'POST' && url.pathname === `/api/sessoes-caixa/${SESSAO}/conferir`) {
          gravada = true;
          return { corpo: { ...CONFERIDA, situacao: 'divergente' } };
        }
        if (url.pathname === '/api/auditoria')
          return {
            corpo: {
              itens: gravada
                ? [
                    {
                      id: 'a1',
                      ocorridoEm: '2026-10-30T12:00:00.000Z',
                      acao: 'conferir',
                      usuarioNome: 'GERENTE',
                      origem: 'erp',
                      descricao: 'Sessão do caixa 1 conferido: Divergente (tolerância R$ 0,00)',
                    },
                  ]
                : [],
            },
          };
        return undefined;
      },
    );
    expect(await screen.findByText('Nenhuma alteração registrada.')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Conferir' }));
    const descricao = await screen.findByText(/conferido: Divergente/);
    const item = descricao.closest('.mantine-Timeline-item')!;
    expect(item).toHaveTextContent('Conferência');
    expect(item).not.toHaveTextContent('conferir');
  }, 30_000);

  it('refazer manda a versão lida; o 409 de outra conferência gravada no meio aparece no bloco', async () => {
    const u = userEvent.setup();
    const { chamadas } = renderizarDetalhe(
      ['fechamentos_caixa.ver', 'fechamentos_caixa.conferir'],
      detalhe(CONFERIDA),
      ({ url, metodo }) =>
        metodo === 'POST' && url.pathname === `/api/sessoes-caixa/${SESSAO}/conferir`
          ? {
              status: 409,
              corpo: {
                codigo: 'CONFLITO_VERSAO',
                mensagem: 'Registro alterado por outro usuário. Recarregue e tente de novo.',
              },
            }
          : undefined,
    );
    const campo = await screen.findByRole('textbox', { name: 'Conferido Dinheiro' });
    // Pré-preenchido com a conferência anterior, não com o informado pelo operador.
    expect(campo).toHaveValue('225,00');
    expect(screen.getByRole('textbox', { name: 'Observação' })).toHaveValue('Envelope recontado');
    await u.click(screen.getByRole('button', { name: 'Refazer conferência' }));
    expect(await screen.findByText(/Registro alterado por outro usuário/)).toBeInTheDocument();
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/conferir'))!;
    expect(post.corpo).toMatchObject({ versao: 41 });
  }, 30_000);

  it('sem fechamentos_caixa.conferir: só a conferência gravada, sem campos; os avisos aparecem uma vez só', async () => {
    renderizarDetalhe(
      ['fechamentos_caixa.ver'],
      detalhe({
        ...CONFERIDA,
        situacao: 'divergente',
        totalConferido: '259.00',
        diferencaConferida: '-1.00',
        conferencia: {
          ...CONFERIDA.conferencia!,
          situacao: 'divergente',
          totalConferido: '259.00',
          diferenca: '-1.00',
          // Conferido diferente do calculado (225,00) e do informado (223,50): a célula só pode vir da conferência.
          formas: [
            { formaPagamentoId: DINHEIRO, valorConferido: '224.00', diferenca: '-1.00' },
            { formaPagamentoId: PIX, valorConferido: '35.00', diferenca: '0.00' },
          ],
        },
        avisosConferencia: [
          {
            codigo: 'eventos_pendentes',
            mensagem: '1 evento(s) do turno ainda em erro ou retido(s) na nuvem',
          },
          {
            codigo: 'calculo_divergente',
            mensagem: 'O caixa calculou R$ 230,00 em dinheiro e o cálculo da nuvem dá R$ 225,00.',
          },
        ],
      }),
    );
    const tabela = await screen.findByRole('table', { name: 'Conferência por forma de pagamento' });
    expect(within(tabela).queryByRole('textbox')).not.toBeInTheDocument();
    const celulas = within(within(tabela).getByText('Dinheiro').closest('tr')!).getAllByRole('cell');
    // Forma, Calculado, Informado, Conferido, Diferença.
    expect(celulas[3]).toHaveTextContent('R$ 224,00');
    expect(screen.getByTestId(`diferenca-conferida-${DINHEIRO}`)).toHaveTextContent('R$ -1,00');
    // O cálculo da nuvem diferente sai só no bloco "Cálculo do dinheiro" (uma fonte: o aviso da API).
    expect(screen.getAllByText(/O caixa calculou/)).toHaveLength(1);
    expect(screen.getByTestId('aviso-calculo-divergente')).toHaveTextContent('O caixa calculou R$ 230,00');
    expect(screen.queryByRole('button', { name: /Conferir|Refazer/ })).not.toBeInTheDocument();
    expect(screen.getByText(/ainda em erro ou retido/)).toBeInTheDocument();
    expect(screen.getByTestId('conferida-por')).toHaveTextContent('Conferida em');
    expect(screen.getByTestId('selo-conferencia')).toHaveTextContent('Divergente');
    expect(screen.queryByTestId('selo-previsto')).not.toBeInTheDocument();
  }, 30_000);

  it('sessão sem o fechamento do caixa: o bloco mostra o motivo, sem formulário', async () => {
    renderizarDetalhe(
      ['fechamentos_caixa.ver', 'fechamentos_caixa.conferir'],
      detalhe({
        ...SESSAO_DETALHE,
        situacao: 'aberta',
        fechamento: null,
        formas: [],
        motivoSemConferencia:
          'A sessão ainda está aberta no caixa: a conferência é feita depois do fechamento.',
      }),
    );
    expect(await screen.findByText(/a conferência é feita depois do fechamento/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Conferir' })).not.toBeInTheDocument();
  }, 30_000);
});

describe('<ListaFechamentosCaixa> com a conferência (ERP 14.9; F3-B9)', () => {
  it('a sessão divergente: selo vermelho, coluna Conferido com a diferença, e o filtro com as 4 situações', async () => {
    const u = userEvent.setup();
    const pagina: PaginaSessoesCaixa = {
      itens: [
        {
          ...SESSAO_DETALHE,
          situacao: 'divergente',
          totalConferido: '258.50',
          diferencaConferida: '-1.50',
          // Diferença do informado diferente da do conferido: a coluna Conferido tem de ler a da conferência.
          totalInformado: '255.00',
          diferenca: '-5.00',
        },
      ],
      total: 1,
      pagina: 1,
      tamanho: 20,
      totais: { calculado: '260.00', informado: '255.00', diferenca: '-5.00' },
    };
    simularApi(
      ...rotasSessao({ permissoes: ['fechamentos_caixa.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === '/api/sessoes-caixa' ? { corpo: pagina } : undefined),
    );
    renderizarComSessao(<ListaFechamentosCaixa />, '/financeiro/fechamentos-caixa');
    const linha = (await screen.findByText('MARIA')).closest('tr')!;
    const cabecalhos = within(linha.closest('table')!)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    const celulas = within(linha).getAllByRole('cell');
    const conferido = celulas[cabecalhos.indexOf('Conferido')]!;
    expect(conferido).toHaveTextContent('R$ 258,50');
    expect(conferido).toHaveTextContent('R$ -1,50');
    expect(conferido).not.toHaveTextContent('R$ -5,00');
    const selo = within(linha).getByText('Divergente').closest('.mantine-Badge-root')!;
    expect(selo.getAttribute('style')).toContain('red');

    await u.click(screen.getByRole('combobox', { name: 'Situação' }));
    expect(await screen.findByRole('option', { name: 'Conferida', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Divergente', hidden: true })).toBeInTheDocument();
  }, 30_000);
});

const REFORCO: MovimentoCaixaDetalhe = {
  id: '01928f3a-0000-7000-8000-0000000000e1',
  tipo: 'reforco',
  ocorridoEm: '2026-10-29T14:00:00.000Z',
  diaOperacional: '2026-10-29',
  valor: '50.00',
  lojaId: CENTRO,
  lojaCodigo: 1,
  lojaNome: 'Loja 1 - Centro',
  lojaTreino: false,
  numeroCaixa: 2,
  operadorNome: 'MARIA',
  quemRetira: null,
  cancelado: false,
  sessaoCaixaId: SESSAO,
  terminalId: 't1',
  terminalDescricao: 'PC do balcão',
  operadorId: 'u1',
  quemRetiraUsuarioNome: null,
  quemRetiraNome: null,
  observacao: 'Troco para o sábado',
  infAdicionais: null,
  formaPagamentoDescricao: null,
  autorizadoPorNome: null,
  canceladoEm: null,
  canceladoPorNome: null,
  autorizadoCancelamentoPorNome: null,
  motivoCancelamento: null,
};

describe('Comprovante de reforço e sangria (ERP 15.2, 15.3; F3-B9)', () => {
  it('o botão do detalhe só com movimentos_caixa.imprimir, e abre o comprovante em aba nova', async () => {
    const u = userEvent.setup();
    const abrir = vi.fn();
    vi.stubGlobal('open', abrir);
    simularApi(
      ...rotasSessao({
        permissoes: ['movimentos_caixa.ver', 'movimentos_caixa.imprimir'],
        lojas: LOJAS,
        todasLojas: true,
      }),
      ({ url }) => (url.pathname === `/api/movimentos-caixa/${REFORCO.id}` ? { corpo: REFORCO } : undefined),
    );
    renderizarComSessao(<DetalheReforco />, `/vendas/reforcos/${REFORCO.id}`, 'vendas/reforcos/:id');
    await u.click(await screen.findByRole('button', { name: 'Imprimir comprovante' }));
    expect(abrir).toHaveBeenCalledWith(`/vendas/reforcos/${REFORCO.id}/comprovante?imprimir=1`, '_blank');
  }, 30_000);

  it('sem movimentos_caixa.imprimir, o detalhe não oferece o comprovante', async () => {
    simularApi(
      ...rotasSessao({ permissoes: ['movimentos_caixa.ver'], lojas: LOJAS, todasLojas: true }),
      ({ url }) => (url.pathname === `/api/movimentos-caixa/${REFORCO.id}` ? { corpo: REFORCO } : undefined),
    );
    renderizarComSessao(<DetalheReforco />, `/vendas/reforcos/${REFORCO.id}`, 'vendas/reforcos/:id');
    expect(await screen.findByRole('heading', { name: /Reforço de R\$ 50,00/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Imprimir comprovante' })).not.toBeInTheDocument();
  }, 30_000);

  it('sangria: 2 vias com a empresa, a loja, quem retira e as assinaturas; a cancelada sai marcada', async () => {
    const comprovante: ComprovanteMovimentoCaixa = {
      empresa: { razaoSocial: 'EMPRESA TESTE LTDA', nomeFantasia: 'Loja Teste', cnpj: '11222333000181' },
      loja: { codigo: 1, nome: 'Loja 1 - Centro', razaoSocial: null, cnpj: null },
      movimento: {
        ...REFORCO,
        tipo: 'sangria',
        valor: '1000.00',
        quemRetira: 'CARLOS',
        quemRetiraNome: 'CARLOS',
        infAdicionais: 'Malote 4471',
        cancelado: true,
        canceladoEm: '2026-10-29T15:31:00.000Z',
        motivoCancelamento: 'Valor digitado errado',
      },
      geradoEm: '2026-10-30T12:00:00.000Z',
    };
    const imprimir = vi.fn();
    vi.stubGlobal('print', imprimir);
    renderizarComprovante(comprovante);
    const vias = await screen.findAllByTestId('comprovante-via');
    expect(vias).toHaveLength(2);
    expect(vias[0]).toHaveTextContent('Via do caixa');
    expect(vias[1]).toHaveTextContent('Via de quem retira');
    for (const via of vias) {
      expect(via).toHaveTextContent('Comprovante de sangria – R$ 1.000,00');
      expect(via).toHaveTextContent('CNPJ 11.222.333/0001-81');
      expect(via).toHaveTextContent('Quem retira: CARLOS');
      expect(via).toHaveTextContent('Malote 4471');
      expect(via).toHaveTextContent('CANCELADO no caixa');
      expect(within(via).getByTestId('comprovante-assinaturas')).toHaveTextContent('Quem retira: CARLOS');
      expect(within(via).queryByTestId('comprovante-treino')).not.toBeInTheDocument();
    }
    // `imprimir=1` (decisão 89): a impressão do navegador é chamada uma vez, quando os dados chegam.
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1), { timeout: 2000 });
  }, 30_000);

  it('da loja de treino (O10): cada via sai com "TREINO – SEM VALOR"', async () => {
    vi.stubGlobal('print', vi.fn());
    renderizarComprovante({
      empresa: { razaoSocial: 'EMPRESA TESTE LTDA', nomeFantasia: 'Loja Teste', cnpj: '11222333000181' },
      loja: { codigo: 9, nome: 'Treino', razaoSocial: null, cnpj: null },
      movimento: { ...REFORCO, tipo: 'sangria', valor: '500.00', lojaTreino: true, quemRetiraNome: 'CARLOS' },
      geradoEm: '2026-10-30T12:00:00.000Z',
    });
    const vias = await screen.findAllByTestId('comprovante-via');
    expect(vias).toHaveLength(2);
    for (const via of vias)
      expect(within(via).getByTestId('comprovante-treino')).toHaveTextContent('TREINO – SEM VALOR');
  }, 30_000);
});

function renderizarComprovante(comprovante: ComprovanteMovimentoCaixa) {
  simularApi(
    ...rotasSessao({ permissoes: ['movimentos_caixa.imprimir'], lojas: LOJAS, todasLojas: true }),
    ({ url }) =>
      url.pathname === `/api/movimentos-caixa/${REFORCO.id}/comprovante` ? { corpo: comprovante } : undefined,
  );
  renderizarComSessao(
    <ComprovanteMovimentoImpressao />,
    `/vendas/sangrias/${REFORCO.id}/comprovante?imprimir=1`,
    'vendas/sangrias/:id/comprovante',
  );
}
