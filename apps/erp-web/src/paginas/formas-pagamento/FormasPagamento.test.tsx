import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioFormaPagamento, ListaFormasPagamento, podeDarTroco, rotuloLojas } from './FormasPagamento';

afterEach(() => vi.unstubAllGlobals());

const HERMES = '01928f3a-0000-7000-8000-0000000000a1';
const TREINO = '01928f3a-0000-7000-8000-0000000000a9';
const LOJAS = [
  { id: HERMES, codigo: 1, nome: 'Loja 1 - Hermes', ativa: true },
  { id: TREINO, codigo: 9, nome: 'Loja Treino', ativa: true },
];
const sessao = (permissoes: string[]) => rotasSessao({ permissoes, lojas: LOJAS, todasLojas: true });

const opcoes = ({ url }: { url: URL }) =>
  url.pathname === '/api/formas-pagamento/opcoes'
    ? {
        corpo: {
          meiosFiscais: [
            { codigo: '01', descricao: 'Dinheiro', ativo: true },
            { codigo: '99', descricao: 'Outros', ativo: true },
          ],
          contasCorrentes: [],
          planosContas: [],
        },
      }
    : undefined;

/** Erro de validação da API: o teste só olha o corpo que o formulário mandou. */
const recusarPost = ({ url, metodo }: { url: URL; metodo: string }) =>
  metodo === 'POST' && url.pathname === '/api/formas-pagamento'
    ? { status: 422, corpo: { codigo: 'VALIDACAO', mensagem: 'x', campos: {} } }
    : undefined;

describe('<FormularioFormaPagamento> – formas personalizadas por loja (C8b, O9a)', () => {
  it('"Fiado Balcão" só na Loja Treino, com supervisor: manda lojaIds e exigeSupervisor', async () => {
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...sessao(['formas_pagamento.ver', 'formas_pagamento.criar']),
      opcoes,
      recusarPost,
    );
    renderizarComSessao(<FormularioFormaPagamento />);
    await u.type(await screen.findByRole('textbox', { name: /^Descrição( \*)?$/ }), 'Fiado Balcão');
    await u.click(screen.getByRole('combobox', { name: /^Meio de pagamento/ }));
    await u.click(await screen.findByRole('option', { name: '99 - Outros', hidden: true }));
    await u.type(screen.getByRole('textbox', { name: /^Descrição fiscal/ }), 'Fiado');
    await u.click(screen.getByPlaceholderText('Todas as lojas'));
    await u.click(await screen.findByRole('option', { name: '9 - Loja Treino', hidden: true }));
    await u.click(screen.getByRole('tab', { name: /Uso no PDV/ }));
    await u.click(screen.getByRole('checkbox', { name: 'Exige liberação do supervisor no PDV' }));
    await u.click(screen.getByRole('button', { name: /Salvar/ }));
    const post = () =>
      chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/formas-pagamento');
    await waitFor(() => expect(post()).toBeDefined());
    expect(post()!.corpo).toMatchObject({
      descricao: 'Fiado Balcão',
      meioPagamentoFiscal: '99',
      lojaIds: [TREINO],
      exigeSupervisor: true,
      permiteTroco: false,
    });
  }, 30_000);

  it('integração pela maquininha tira o troco e bloqueia a flag (O23)', async () => {
    const u = userEvent.setup();
    simularApi(...sessao(['formas_pagamento.ver', 'formas_pagamento.criar']), opcoes);
    renderizarComSessao(<FormularioFormaPagamento />);
    await u.click(await screen.findByRole('tab', { name: /Uso no PDV/ }));
    const troco = screen.getByRole('checkbox', { name: /^Dá troco/ });
    await u.click(troco);
    expect(troco).toBeChecked();
    await u.click(screen.getByRole('combobox', { name: /^Integração/ }));
    await u.click(await screen.findByRole('option', { name: 'Maquininha (POS)', hidden: true }));
    expect(troco).not.toBeChecked();
    expect(troco).toBeDisabled();
  }, 30_000);
});

describe('<FormularioFormaPagamento> – forma que também vale em loja alheia (ERP 10.2)', () => {
  const FORMA = '01928f3a-0000-7000-8000-0000000000f3';
  const detalhe = (lojaIds: string[]) => ({
    id: FORMA,
    versao: 3,
    criadoEm: '2026-10-31T12:00:00.000Z',
    atualizadoEm: '2026-10-31T12:00:00.000Z',
    atualizadoPorNome: 'Dono',
    descricao: 'Fiado Balcão',
    ordem: 20,
    tipoForma: 'outros',
    meioPagamentoFiscal: '99',
    descricaoFiscal: 'Fiado',
    integracao: 'nenhuma',
    tipoPinpad: null,
    lojaIds,
    taxaPct: '0',
    diasRecebimento: 0,
    contaCorrenteId: null,
    planoContasId: null,
    lancaQuitada: true,
    ativa: true,
    permiteParcelar: false,
    parcelasMaximo: 1,
    parcelaValorMinimo: null,
    usaPdv: true,
    usaTotem: false,
    usaMenuDigital: false,
    sempreZeradoPdv: false,
    permiteTroco: false,
    abrirGaveta: false,
    exigePessoa: false,
    aPrazo: false,
    creditoFuncionario: false,
    valeCompra: false,
    eBoleto: false,
    restringeIdadeMinima: false,
    geraQrcodePix: false,
    exigeDadosPos: false,
    exigeSupervisor: false,
    senhaLiberacaoDefinida: false,
  });
  /** Gerente só da Hermes, com permissão de editar e excluir formas. */
  const gerenteHermes = () =>
    rotasSessao({
      permissoes: ['formas_pagamento.ver', 'formas_pagamento.editar', 'formas_pagamento.excluir'],
      lojas: [LOJAS[0]!],
      todasLojas: false,
    });
  const abrir = (lojaIds: string[]) => {
    simularApi(...gerenteHermes(), opcoes, ({ url }) =>
      url.pathname === `/api/formas-pagamento/${FORMA}` ? { corpo: detalhe(lojaIds) } : undefined,
    );
    renderizarComSessao(
      <FormularioFormaPagamento />,
      `/cadastros/formas-pagamento/${FORMA}`,
      'cadastros/formas-pagamento/:id',
    );
  };

  it('[Hermes, Treino] para o gerente só da Hermes: só leitura, e a Treino aparece como "Loja sem acesso"', async () => {
    abrir([HERMES, TREINO]);
    expect(await screen.findByText(/também vale em loja a que você não tem acesso/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Salvar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Excluir/ })).not.toBeInTheDocument();
    // A pílula (e a opção oculta do MultiSelect) com rótulo, nunca o id cru da loja.
    expect(screen.getAllByText('Loja sem acesso').length).toBeGreaterThan(0);
    expect(screen.queryByText(TREINO)).not.toBeInTheDocument();
  });

  it('só na Hermes: o mesmo gerente edita', async () => {
    abrir([HERMES]);
    expect(await screen.findByRole('button', { name: /Salvar/ })).toBeInTheDocument();
    expect(screen.queryByText(/Somente leitura/)).not.toBeInTheDocument();
  });
});

describe('<ListaFormasPagamento>', () => {
  it('coluna Lojas: "Todas" sem vínculo de loja, senão os nomes', async () => {
    simularApi(...sessao(['formas_pagamento.ver']), ({ url }) =>
      url.pathname === '/api/formas-pagamento'
        ? {
            corpo: {
              itens: [
                {
                  id: '01928f3a-0000-7000-8000-0000000000f1',
                  descricao: 'Dinheiro',
                  ordem: 1,
                  tipoForma: 'dinheiro',
                  usaPdv: true,
                  usaTotem: false,
                  usaMenuDigital: false,
                  lojas: [],
                  ativa: true,
                  versao: 1,
                },
                {
                  id: '01928f3a-0000-7000-8000-0000000000f2',
                  descricao: 'Fiado Balcão',
                  ordem: 20,
                  tipoForma: 'outros',
                  usaPdv: true,
                  usaTotem: false,
                  usaMenuDigital: false,
                  lojas: [{ id: TREINO, codigo: 9, nome: 'Loja Treino' }],
                  ativa: true,
                  versao: 1,
                },
              ],
              total: 2,
              pagina: 1,
              tamanho: '20',
            },
          }
        : undefined,
    );
    renderizarComSessao(<ListaFormasPagamento />, '/cadastros/formas-pagamento');
    const tabela = await screen.findByRole('table');
    const fiado = (await within(tabela).findAllByRole('link', { name: 'Fiado Balcão' }))[0]!.closest('tr')!;
    expect(within(fiado).getByText('Loja Treino')).toBeInTheDocument();
    const dinheiro = within(tabela).getAllByRole('link', { name: 'Dinheiro' })[0]!.closest('tr')!;
    expect(within(dinheiro).getByText('Todas')).toBeInTheDocument();
  });
});

describe('regras puras', () => {
  it('rotuloLojas e podeDarTroco', () => {
    expect(rotuloLojas([])).toBe('Todas');
    expect(
      rotuloLojas([
        { id: HERMES, codigo: 1, nome: 'Hermes' },
        { id: TREINO, codigo: 9, nome: 'Treino' },
      ]),
    ).toBe('Hermes, Treino');
    expect(podeDarTroco({ tipoForma: 'dinheiro', integracao: 'nenhuma' })).toBe(true);
    expect(podeDarTroco({ tipoForma: 'outros', integracao: 'nenhuma' })).toBe(true);
    expect(podeDarTroco({ tipoForma: 'pix', integracao: 'nenhuma' })).toBe(false);
    expect(podeDarTroco({ tipoForma: 'outros', integracao: 'pos_externo' })).toBe(false);
  });
});
