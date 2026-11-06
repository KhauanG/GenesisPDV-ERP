import type {
  AcertoDetalhe,
  CompensacaoAcerto,
  ConferenciaAcerto,
  FolhaContagem,
  PreviaContagem,
  ProdutoOpcao,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarComSessao, renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioAcerto, ListaAcertos } from './Acertos';
import { FolhaContagemImpressao } from './FolhaContagem';
import { ListaSaldos } from './Saldos';

afterEach(() => vi.unstubAllGlobals());

const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const ESTOQUE = '0190a000-0000-7000-8000-0000000000e1';
const DISPONIVEL = '0190a000-0000-7000-8000-0000000000d1';
const AVARIA = '0190a000-0000-7000-8000-0000000000d2';
const ACERTO = '0190a000-0000-7000-8000-0000000000c1';
const PERMISSOES = [
  'estoque_acertos.ver',
  'estoque_acertos.criar',
  'estoque_acertos.estornar',
  'produtos.ver_custo',
];

const BRAHMA: ProdutoOpcao = {
  id: '0190a000-0000-7000-8000-000000000011',
  codigo: 11,
  nome: 'CERV BRAHMA LT 350ML',
  tipo: 'simples',
  ativo: true,
  unidadeId: 'u1',
  unidadeSigla: 'UN',
  permiteFracao: false,
  controlaEstoque: true,
  ean: '7891149103102',
  precoVenda: '3.4900',
  precoAtacado: null,
  qtdMinimaAtacado: null,
  precoCusto: '2.0000',
  grupoPrecoQuantidadeId: null,
};

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/estoques'
      ? {
          corpo: {
            itens: [
              {
                id: ESTOQUE,
                codigo: 1,
                nome: 'Loja 1 - Ice Beer Hermes',
                tipo: 'loja',
                lojaId: LOJA,
                lojaNome: 'Loja 1',
                ativo: true,
                versao: 1,
              },
            ],
            total: 1,
            pagina: 1,
            tamanho: 'todos',
          },
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/tipos-estoque'
      ? {
          corpo: [
            { id: DISPONIVEL, nome: 'Disponível', vendavel: true, padrao: true, ativo: true },
            { id: AVARIA, nome: 'Avaria', vendavel: false, padrao: false, ativo: true },
          ],
        }
      : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/produtos/busca' ? { corpo: [BRAHMA] } : undefined),
  ({ url }: { url: URL }) =>
    url.pathname === '/api/saldos-estoque/itens'
      ? { corpo: [{ produtoId: BRAHMA.id, variacaoId: null, quantidade: '18.000', custoMedio: '2.0000' }] }
      : undefined,
];

function detalhe(parcial: Partial<AcertoDetalhe> = {}): AcertoDetalhe {
  return {
    id: ACERTO,
    versao: 3,
    criadoEm: '2026-10-30T12:00:00.000Z',
    atualizadoEm: '2026-10-30T12:00:00.000Z',
    atualizadoPorNome: 'MARIA SILVA',
    codigo: 7,
    estoqueId: ESTOQUE,
    estoqueNome: 'Loja 1 - Ice Beer Hermes',
    lojaId: LOJA,
    tipoEstoqueId: DISPONIVEL,
    tipoEstoqueNome: 'Disponível',
    tipoAjuste: 'definir',
    tipoEstoqueDestinoId: null,
    tipoEstoqueDestinoNome: null,
    dataContagem: '2026-10-30T11:00:00.000Z',
    motivo: 'Inventário',
    responsavelId: 'u1',
    responsavelNome: 'MARIA SILVA',
    observacoes: null,
    origem: 'manual',
    status: 'rascunho',
    efetivadoEm: null,
    efetivadoPorNome: null,
    estornadoEm: null,
    estornadoPorNome: null,
    motivoEstorno: null,
    qtdItens: 1,
    totalVenda: '6.98',
    totalCusto: '4.00',
    itens: [
      {
        id: 'i1',
        sequencia: 1,
        produtoId: BRAHMA.id,
        variacaoId: null,
        loteId: null,
        lote: null,
        produto: BRAHMA,
        quantidade: '20.000',
        saldoAtual: '18.000',
        diferenca: '2.000',
        custoUnitario: '2.0000',
        custoInformado: null,
        precoVenda: '3.4900',
        totalVenda: '6.98',
        totalCusto: '4.00',
      },
    ],
    avisos: [],
    compensacoes: [],
    totalCompensacoes: 0,
    ...parcial,
  };
}

/** Select/Autocomplete do Mantine: o rótulo também nomeia a lista de opções. */
const campo = (rotulo: RegExp) => screen.getAllByLabelText(rotulo)[0]!;
/** A caixa do Select (só ela tem o papel `combobox`; a lista de opções é `listbox`). */
const seletor = (rotulo: RegExp) => screen.getByRole('combobox', { name: rotulo });

function Autenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}

/** Formulário com as rotas reais (`/novo` e `/:id`). */
function renderizarFormulario(url: string) {
  return renderizarRotas(
    [
      {
        element: (
          <ProvedorSessao>
            <Outlet />
          </ProvedorSessao>
        ),
        children: [
          { path: '/estoque/acertos', element: <Autenticado>lista</Autenticado> },
          {
            path: '/estoque/acertos/novo',
            element: (
              <Autenticado>
                <FormularioAcerto />
              </Autenticado>
            ),
          },
          {
            path: '/estoque/acertos/:id',
            element: (
              <Autenticado>
                <FormularioAcerto />
              </Autenticado>
            ),
          },
        ],
      },
    ],
    url,
  );
}

const sessao = (permissoes = PERMISSOES) =>
  rotasSessao({
    permissoes,
    lojas: [{ id: LOJA, codigo: 1, nome: 'Loja 1 - Ice Beer Hermes', ativa: true }],
  });

describe('Acerto de Estoque (ERP 13.5)', () => {
  it('novo acerto: estoque e tipo padrão, produto pela busca, custo da Entrada e corpo da API', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/acertos'
        ? { status: 201, corpo: detalhe({ tipoAjuste: 'entrada' }) }
        : undefined,
    );
    renderizarFormulario('/estoque/acertos/novo');
    await screen.findByRole('heading', { name: 'Novo acerto de estoque' });
    await waitFor(() => expect(campo(/^Estoque \(loja\)/)).toHaveValue('Loja 1 - Ice Beer Hermes'));
    expect(campo(/^Tipo de estoque/)).toHaveValue('Disponível');
    await usuario.type(campo(/^Motivo/), 'Saldo inicial');
    const grade = screen.getByRole('table', { name: 'Itens do acerto' });
    await usuario.type(within(grade).getByLabelText('Produto da linha 1'), 'brahma');
    await usuario.click(
      await screen.findByRole(
        'option',
        { name: '11 - CERV BRAHMA LT 350ML', hidden: true },
        { timeout: 3000 },
      ),
    );
    // Saldo atual vem do estoque × tipo.
    expect(await within(grade).findByText('18 UN')).toBeInTheDocument();
    await usuario.type(within(grade).getByLabelText('Quant. da linha 1'), '120');
    await usuario.type(within(grade).getByLabelText('Custo unit. da linha 1'), '2,10');
    expect(screen.getByTestId('totais-acerto')).toHaveTextContent('Total (custo): R$ 252,00');
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')).toBe(true),
    );
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')!;
    expect(post.corpo).toMatchObject({
      estoqueId: ESTOQUE,
      tipoEstoqueId: DISPONIVEL,
      tipoAjuste: 'entrada',
      motivo: 'Saldo inicial',
      itens: [{ id: null, produtoId: BRAHMA.id, quantidade: '120', custoUnitario: '2,10' }],
    });
  }, 20_000);

  it('"Mudar tipo" (F2-B8): exige o destino, avisa o não vendável e manda o par origem/destino', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/acertos'
        ? {
            status: 201,
            corpo: detalhe({
              tipoAjuste: 'mudanca_tipo',
              tipoEstoqueDestinoId: AVARIA,
              tipoEstoqueDestinoNome: 'Avaria',
            }),
          }
        : undefined,
    );
    renderizarFormulario('/estoque/acertos/novo');
    await screen.findByRole('heading', { name: 'Novo acerto de estoque' });
    await waitFor(() => expect(seletor(/^Estoque \(loja\)/)).toHaveValue('Loja 1 - Ice Beer Hermes'));
    await usuario.click(screen.getByRole('radio', { name: 'Mudar tipo' }));
    expect(seletor(/^Tipo de origem/)).toHaveValue('Disponível');
    await usuario.type(seletor(/^Motivo/), 'Avaria');
    const grade = screen.getByRole('table', { name: 'Itens do acerto' });
    await usuario.type(within(grade).getByLabelText('Produto da linha 1'), 'brahma');
    await usuario.click(
      await screen.findByRole(
        'option',
        { name: '11 - CERV BRAHMA LT 350ML', hidden: true },
        { timeout: 3000 },
      ),
    );
    expect(await within(grade).findByText('18 UN')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Saldo na origem' })).toBeInTheDocument();
    await usuario.type(within(grade).getByLabelText('Quant. da linha 1'), '5');
    // Custo médio da origem: 5 × 2,00.
    expect(screen.getByTestId('totais-acerto')).toHaveTextContent('Total (custo): R$ 10,00');
    // Sem o destino, o contrato recusa antes da API.
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Escolha o tipo de destino')).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')).toBe(false);
    // A origem não é opção de destino.
    await usuario.click(seletor(/^Tipo de destino/));
    const destinos = screen.getByRole('listbox', { name: /^Tipo de destino/, hidden: true });
    expect(within(destinos).queryByRole('option', { name: 'Disponível', hidden: true })).toBeNull();
    await usuario.click(within(destinos).getByRole('option', { name: 'Avaria', hidden: true }));
    expect(screen.getByText(/"Avaria" não é vendável/)).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')).toBe(true),
    );
    expect(
      chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')!.corpo,
    ).toMatchObject({
      tipoEstoqueId: DISPONIVEL,
      tipoAjuste: 'mudanca_tipo',
      tipoEstoqueDestinoId: AVARIA,
      itens: [{ produtoId: BRAHMA.id, quantidade: '5', custoUnitario: null }],
    });
  }, 20_000);

  it('Entrada não manda tipo de destino', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/acertos'
        ? { status: 201, corpo: detalhe({ tipoAjuste: 'entrada' }) }
        : undefined,
    );
    renderizarFormulario('/estoque/acertos/novo');
    await screen.findByRole('heading', { name: 'Novo acerto de estoque' });
    await waitFor(() => expect(seletor(/^Estoque \(loja\)/)).toHaveValue('Loja 1 - Ice Beer Hermes'));
    // Escolhe o destino e volta à Entrada: o destino escondido não vai.
    await usuario.click(screen.getByRole('radio', { name: 'Mudar tipo' }));
    await usuario.click(seletor(/^Tipo de destino/));
    await usuario.click(
      within(screen.getByRole('listbox', { name: /^Tipo de destino/, hidden: true })).getByRole('option', {
        name: 'Avaria',
        hidden: true,
      }),
    );
    await usuario.click(screen.getByRole('radio', { name: 'Entrada' }));
    expect(screen.queryByLabelText(/^Tipo de destino/)).not.toBeInTheDocument();
    await usuario.type(seletor(/^Motivo/), 'Bonificação');
    const grade = screen.getByRole('table', { name: 'Itens do acerto' });
    await usuario.type(within(grade).getByLabelText('Produto da linha 1'), 'brahma');
    await usuario.click(
      await screen.findByRole(
        'option',
        { name: '11 - CERV BRAHMA LT 350ML', hidden: true },
        { timeout: 3000 },
      ),
    );
    await usuario.type(within(grade).getByLabelText('Quant. da linha 1'), '1');
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')).toBe(true),
    );
    expect(
      chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')!.corpo,
    ).toMatchObject({
      tipoAjuste: 'entrada',
      tipoEstoqueDestinoId: null,
    });
  }, 20_000);

  it('validação na grade sem chamar a API (quantidade zero na Entrada)', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias);
    renderizarFormulario('/estoque/acertos/novo');
    await screen.findByRole('heading', { name: 'Novo acerto de estoque' });
    await usuario.type(campo(/^Motivo/), 'Avaria');
    const grade = screen.getByRole('table', { name: 'Itens do acerto' });
    await usuario.type(within(grade).getByLabelText('Produto da linha 1'), 'brahma');
    await usuario.click(
      await screen.findByRole(
        'option',
        { name: '11 - CERV BRAHMA LT 350ML', hidden: true },
        { timeout: 3000 },
      ),
    );
    await usuario.type(within(grade).getByLabelText('Quant. da linha 1'), '0');
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(within(grade).getByLabelText('Quant. da linha 1')).toHaveAttribute(
        'title',
        'Quantidade maior que zero',
      ),
    );
    expect(within(grade).getByLabelText('Quant. da linha 1')).toHaveAttribute('aria-invalid', 'true');
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')).toBe(false);
  });

  it('rascunho "Definir": diferença da contagem e Efetivar com a versão', async () => {
    const usuario = userEvent.setup();
    let efetivado = false;
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (metodo === 'POST' && url.pathname === `/api/acertos/${ACERTO}/efetivar`) {
        efetivado = true;
        return {
          corpo: detalhe({
            status: 'efetivado',
            versao: 4,
            efetivadoEm: '2026-10-30T12:05:00.000Z',
            efetivadoPorNome: 'MARIA SILVA',
          }),
        };
      }
      return url.pathname === `/api/acertos/${ACERTO}` ? { corpo: detalhe() } : undefined;
    });
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    const grade = await screen.findByRole('table', { name: 'Itens do acerto' });
    expect(await within(grade).findByText('+2')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Efetivar' }));
    await waitFor(() => expect(efetivado).toBe(true));
    expect(chamadas.find((c) => c.url.pathname.endsWith('/efetivar'))!.corpo).toEqual({ versao: 3 });
    expect(await screen.findByText(/Acerto efetivado: o documento não muda mais/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Estornar' })).toBeInTheDocument();
  });

  it('rascunho com item de lote (F2-B6): mostra o lote e o devolve ao salvar', async () => {
    const usuario = userEvent.setup();
    const LOTE = '0190a000-0000-7000-8000-0000000000c1';
    const comLote = detalhe({
      tipoAjuste: 'saida',
      responsavelId: '0190a000-0000-7000-8000-0000000000a1',
      itens: [
        {
          ...detalhe().itens[0]!,
          id: '0190a000-0000-7000-8000-0000000000b1',
          loteId: LOTE,
          lote: 'L-2612',
          quantidade: '2.000',
          diferenca: '-2.000',
        },
      ],
    });
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url }) =>
      url.pathname === `/api/acertos/${ACERTO}` ? { corpo: comLote } : undefined,
    );
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    const grade = await screen.findByRole('table', { name: 'Itens do acerto' });
    expect(await within(grade).findByText('Lote L-2612')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    const corpo = chamadas.find((c) => c.metodo === 'PUT')!.corpo as {
      itens: Array<Record<string, unknown>>;
    };
    expect(corpo.itens).toEqual([
      expect.objectContaining({ produtoId: BRAHMA.id, loteId: LOTE, quantidade: '2' }),
    ]);
  });

  it('efetivado: Estornar pede o motivo', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (metodo === 'POST' && url.pathname === `/api/acertos/${ACERTO}/estornar`)
        return { corpo: detalhe({ status: 'estornado', versao: 5 }) };
      return url.pathname === `/api/acertos/${ACERTO}`
        ? { corpo: detalhe({ status: 'efetivado', versao: 4 }) }
        : undefined;
    });
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    await usuario.click(await screen.findByRole('button', { name: 'Estornar' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Estornar acerto' });
    const confirmar = within(dialogo).getByRole('button', { name: 'Estornar' });
    expect(confirmar).toBeDisabled();
    await usuario.type(within(dialogo).getByLabelText(/Motivo do estorno/), 'Contagem errada');
    await usuario.click(confirmar);
    await waitFor(() =>
      expect(chamadas.find((c) => c.url.pathname.endsWith('/estornar'))?.corpo).toEqual({
        versao: 4,
        motivo: 'Contagem errada',
      }),
    );
  });

  it('listagem com as colunas do ERP 13.5 e custo só com "Ver custo"', async () => {
    simularApi(...sessao(['estoque_acertos.ver']), ...referencias, ({ url }) =>
      url.pathname === '/api/acertos'
        ? {
            corpo: {
              itens: [
                {
                  id: ACERTO,
                  codigo: 7,
                  dataContagem: '2026-10-30T11:00:00.000Z',
                  responsavelId: 'u1',
                  responsavelNome: 'MARIA SILVA',
                  motivo: 'Importação de planilha',
                  estoqueId: ESTOQUE,
                  estoqueNome: 'Loja 1 - Ice Beer Hermes',
                  tipoAjuste: 'definir',
                  origem: 'importacao',
                  qtdItens: 4,
                  totalCusto: null,
                  totalVenda: '100.00',
                  status: 'efetivado',
                  versao: 2,
                },
              ],
              total: 1,
              pagina: 1,
              tamanho: '20',
            },
          }
        : undefined,
    );
    renderizarComSessao(<ListaAcertos />, '/estoque/acertos');
    const tabela = await screen.findByRole('table');
    expect(await within(tabela).findByText('Importação de planilha')).toBeInTheDocument();
    expect(within(tabela).getByText('Efetivado')).toBeInTheDocument();
    expect(within(tabela).getByText('Definir')).toBeInTheDocument();
    expect(within(tabela).queryByText('Valor de custo')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Novo acerto' })).not.toBeInTheDocument();
  });
});

describe('Saldos de estoque (ERP 8.2.11 / 16.4)', () => {
  it('lista por estoque com totais e custo só com permissão', async () => {
    const { chamadas } = simularApi(...sessao(['estoque_saldos.ver']), ...referencias, ({ url }) =>
      url.pathname === '/api/saldos-estoque'
        ? {
            corpo: {
              itens: [
                {
                  chave: `${ESTOQUE}:${BRAHMA.id}:${DISPONIVEL}`,
                  estoqueId: ESTOQUE,
                  estoqueNome: 'Loja 1 - Ice Beer Hermes',
                  tipoEstoqueId: DISPONIVEL,
                  tipoEstoqueNome: 'Disponível',
                  produtoId: BRAHMA.id,
                  produtoCodigo: 11,
                  produtoNome: 'CERV BRAHMA LT 350ML',
                  codigoInterno: 'BRAHMA350',
                  unidadeSigla: 'UN',
                  quantidade: '120.000',
                  estoqueMinimo: '24.000',
                  custoMedio: null,
                  custoTotal: null,
                  precoVenda: '3.4900',
                  vendaTotal: '418.80',
                  ultimaEntradaEm: '2026-10-30T12:00:00.000Z',
                  ultimaSaidaEm: null,
                },
              ],
              total: 1,
              pagina: 1,
              tamanho: '20',
              totais: { quantidadeItens: 1, custoTotal: null, vendaTotal: '418.80' },
            },
          }
        : undefined,
    );
    renderizarComSessao(<ListaSaldos />, '/estoque/saldos');
    expect(await screen.findByRole('link', { name: '11 - CERV BRAHMA LT 350ML' })).toBeInTheDocument();
    expect(screen.getByTestId('totais-saldos')).toHaveTextContent('Venda total: R$ 418,80');
    expect(screen.getByTestId('totais-saldos')).not.toHaveTextContent('Custo total');
    expect(screen.queryByText('Custo médio')).not.toBeInTheDocument();
    const consulta = chamadas.find((c) => c.url.pathname === '/api/saldos-estoque')!.url.searchParams;
    expect(consulta.get('situacao')).toBe('ativos');
    expect(consulta.get('situacaoSaldo')).toBe('todos');
  });
});

describe('Seletores de estoque: só os permitidos (README da API › decisão 149)', () => {
  // O usuário tem a loja de contexto, mas não o estoque dela: a API devolve só o CD e o da Petiscaria 2.
  const CD = '0190a000-0000-7000-8000-0000000000e3';
  const PETISCARIA = '0190a000-0000-7000-8000-0000000000e2';
  const permitidos = [
    {
      id: CD,
      codigo: 3,
      nome: 'CD - Estoque Ice Beer',
      tipo: 'deposito',
      lojaId: null,
      lojaNome: null,
      ativo: true,
      versao: 1,
    },
    {
      id: PETISCARIA,
      codigo: 2,
      nome: 'Estoque Petiscaria 2',
      tipo: 'loja',
      lojaId: '0190a000-0000-7000-8000-0000000000f2',
      lojaNome: 'Petiscaria 2',
      ativo: true,
      versao: 1,
    },
  ];
  const soPermitidos = [
    ({ url }: { url: URL }) =>
      url.pathname === '/api/estoques'
        ? { corpo: { itens: permitidos, total: permitidos.length, pagina: 1, tamanho: 'todos' } }
        : undefined,
    ...referencias.slice(1),
  ];

  /** O campo de digitação do Select (a lista de opções, quando montada, vem antes no `getAllByLabelText`). */
  const entrada = (rotulo: RegExp) => screen.getAllByLabelText(rotulo).find((e) => e.tagName === 'INPUT')!;

  /** Textos das opções da lista aberta de um Select (o rótulo também nomeia a lista). */
  function opcoes(rotulo: RegExp): string[] {
    const lista = screen.getAllByLabelText(rotulo).find((e) => e.getAttribute('role') === 'listbox')!;
    return within(lista)
      .getAllByRole('option', { hidden: true })
      .map((o) => o.textContent ?? '');
  }

  it('acerto novo: sem o estoque da loja de contexto, o padrão é o primeiro permitido e só eles são opção', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...soPermitidos, ({ url, metodo }) =>
      metodo === 'POST' && url.pathname === '/api/acertos'
        ? {
            status: 201,
            corpo: detalhe({ estoqueId: CD, estoqueNome: 'CD - Estoque Ice Beer', lojaId: null }),
          }
        : undefined,
    );
    renderizarFormulario('/estoque/acertos/novo');
    await screen.findByRole('heading', { name: 'Novo acerto de estoque' });
    await waitFor(() => expect(entrada(/^Estoque \(loja\)/)).toHaveValue('CD - Estoque Ice Beer'), {
      timeout: 3000,
    });
    await usuario.click(entrada(/^Estoque \(loja\)/));
    await waitFor(() =>
      expect(opcoes(/^Estoque \(loja\)/)).toEqual(['CD - Estoque Ice Beer', 'Estoque Petiscaria 2']),
    );
    await usuario.keyboard('{Escape}');
    await usuario.type(entrada(/^Motivo/), 'Quebra');
    const grade = screen.getByRole('table', { name: 'Itens do acerto' });
    await usuario.type(within(grade).getByLabelText('Produto da linha 1'), 'brahma');
    await usuario.click(
      await screen.findByRole(
        'option',
        { name: '11 - CERV BRAHMA LT 350ML', hidden: true },
        { timeout: 3000 },
      ),
    );
    await usuario.type(within(grade).getByLabelText('Quant. da linha 1'), '1');
    await usuario.type(within(grade).getByLabelText('Custo unit. da linha 1'), '2');
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')).toBe(true),
    );
    expect(
      chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/acertos')!.corpo,
    ).toMatchObject({ estoqueId: CD });
  }, 20_000);

  it('filtros de Acertos e de Saldos: só os estoques que a API devolve', async () => {
    const usuario = userEvent.setup();
    const pagina = (extra: Record<string, unknown> = {}) => ({
      corpo: { itens: [], total: 0, pagina: 1, tamanho: '20', ...extra },
    });
    simularApi(
      ...sessao(['estoque_acertos.ver', 'estoque_saldos.ver']),
      ...soPermitidos,
      ({ url }) => (url.pathname === '/api/acertos' ? pagina() : undefined),
      ({ url }) =>
        url.pathname === '/api/saldos-estoque'
          ? pagina({ totais: { quantidadeItens: 0, custoTotal: null, vendaTotal: '0.00' } })
          : undefined,
    );
    const { unmount } = renderizarComSessao(<ListaAcertos />, '/estoque/acertos');
    await screen.findByRole('search', { name: /Filtros de/ });
    await usuario.click(entrada(/^Estoque$/));
    await waitFor(() =>
      expect(opcoes(/^Estoque$/)).toEqual(['CD - Estoque Ice Beer', 'Estoque Petiscaria 2']),
    );
    unmount();

    renderizarComSessao(<ListaSaldos />, '/estoque/saldos');
    await screen.findByRole('search', { name: /Filtros de/ });
    await usuario.click(entrada(/^Estoque$/));
    await waitFor(() =>
      expect(opcoes(/^Estoque$/)).toEqual(['CD - Estoque Ice Beer', 'Estoque Petiscaria 2']),
    );
  });
});

const PREVIA: PreviaContagem = {
  arquivo: 'coletor.txt',
  separador: ';',
  cabecalho: null,
  linhas: 4,
  leituras: 4,
  itens: [
    {
      produto: { id: BRAHMA.id, codigo: 11, nome: 'CERV BRAHMA LT 350ML', unidadeSigla: 'UN' },
      quantidadeArquivo: '25.000',
      quantidadeAnterior: '20.000',
      quantidadeFinal: '45.000',
      leituras: 2,
      codigos: [
        { codigo: '7891149103102', fator: '1.000', leituras: 1, quantidadeLida: '1.000' },
        { codigo: '17891149103109', fator: '12.000', leituras: 1, quantidadeLida: '2.000' },
      ],
      zerado: false,
      rascunho: 0,
      outroAcerto: null,
    },
    {
      produto: { id: 'skol', codigo: 12, nome: 'CERV SKOL LT 350ML', unidadeSigla: 'UN' },
      quantidadeArquivo: '6.000',
      quantidadeAnterior: '30.000',
      quantidadeFinal: '36.000',
      leituras: 1,
      codigos: [{ codigo: '7891149200009', fator: '1.000', leituras: 1, quantidadeLida: '6.000' }],
      zerado: false,
      rascunho: 0,
      outroAcerto: 9,
    },
  ],
  problemas: [
    {
      tipo: 'ambiguo',
      codigo: '7890000007771',
      linhas: [3],
      leituras: 1,
      quantidadeLida: '3.000',
      mensagem: 'O mesmo código está em mais de um produto',
      produtos: [
        { id: 'a', codigo: 21, nome: 'AGUA CRYSTAL', unidadeSigla: 'UN' },
        { id: 'b', codigo: 22, nome: 'AGUA CRYSTAL C/GAS', unidadeSigla: 'UN' },
      ],
    },
    {
      tipo: 'nao_encontrado',
      codigo: '7899999999999',
      linhas: [4],
      leituras: 1,
      quantidadeLida: '1.000',
      mensagem: 'Código não encontrado',
      produtos: [],
    },
  ],
  totais: { produtos: 2, novos: 0, alterados: 2, zerados: 0, leiturasRecusadas: 2, unidades: '31.000' },
  rascunhos: 1,
  avisos: ['2 produto(s) já estavam no rascunho: a quantidade do arquivo é somada à gravada.'],
  gravado: false,
  acertos: [],
  outrosAcertos: [{ id: 'outro', codigo: 9, qtdItens: 1000 }],
};

/** Os campos do multipart da última chamada a `importar-contagem`. */
function camposEnviados(mock: ReturnType<typeof simularApi>['mock']) {
  const chamada = mock.mock.calls.filter(([u]) => String(u).includes('/importar-contagem')).at(-1)!;
  const f = (chamada[1] as RequestInit).body as FormData;
  return Object.fromEntries(
    [...f.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : (v as File).name]),
  );
}

describe('Importar contagem, folha de contagem e lote na grade (F2-B9)', () => {
  it('prévia do arquivo (fardo em unidades, problemas, aviso) e gravação com a versão', async () => {
    const usuario = userEvent.setup();
    let gravou = false;
    const { mock } = simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (url.pathname === `/api/acertos/${ACERTO}` && metodo === 'GET')
        return { corpo: gravou ? detalhe({ versao: 5, qtdItens: 1 }) : detalhe() };
      if (url.pathname === `/api/acertos/${ACERTO}/importar-contagem`) {
        const modo = camposEnviados(mock).modo;
        if (modo === 'gravar') gravou = true;
        return {
          corpo:
            modo === 'gravar'
              ? { ...PREVIA, gravado: true, acertos: [{ id: ACERTO, codigo: 7, qtdItens: 1 }] }
              : PREVIA,
        };
      }
      return undefined;
    });
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    await screen.findByRole('heading', { name: 'Acerto de estoque Nº 7' });
    await usuario.click(screen.getByRole('button', { name: 'Importar contagem' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Importar contagem' });
    expect(within(dialogo).getByRole('button', { name: 'Ver prévia' })).toBeDisabled();
    const entrada = document.querySelector('input[type="file"]') as HTMLInputElement;
    await usuario.upload(entrada, new File(['7891149103102;1\n'], 'coletor.txt', { type: 'text/plain' }));
    await usuario.click(within(dialogo).getByLabelText(/Zerar os não contados/));
    await usuario.click(within(dialogo).getByRole('button', { name: 'Ver prévia' }));
    const previa = await within(dialogo).findByTestId('previa-contagem');
    expect(previa).toHaveTextContent('2 produto(s) (0 novo(s), 2 já no rascunho)');
    expect(previa).toHaveTextContent('2 leitura(s) recusada(s)');
    expect(within(previa).getByText(/somada à gravada/)).toBeInTheDocument();
    const problemas = within(previa).getByRole('table', { name: 'Problemas da contagem' });
    expect(within(problemas).getByText('Código ambíguo')).toBeInTheDocument();
    expect(within(problemas).getByText(/21 AGUA CRYSTAL; 22 AGUA CRYSTAL C\/GAS/)).toBeInTheDocument();
    expect(within(problemas).getByText('Não encontrado')).toBeInTheDocument();
    const itens = within(previa).getByRole('table', { name: 'Itens da contagem' });
    expect(within(itens).getByText(/17891149103109 \(×12\): 2/)).toBeInTheDocument();
    expect(within(itens).getByText('45')).toBeInTheDocument();
    // O produto que já estava noutro rascunho da mesma contagem: a soma vai para o Nº 9.
    expect(within(itens).getByRole('columnheader', { name: 'Rascunho' })).toBeInTheDocument();
    expect(within(itens).getByText('Nº 9')).toBeInTheDocument();
    expect(within(itens).getByText('Este')).toBeInTheDocument();
    expect(camposEnviados(mock)).toEqual({
      modo: 'previa',
      zerarNaoContados: 'true',
      itensExistentes: 'somar',
      arquivo: 'coletor.txt',
    });
    await usuario.click(within(dialogo).getByRole('button', { name: 'Gravar no rascunho' }));
    await waitFor(() => expect(gravou).toBe(true));
    expect(camposEnviados(mock)).toMatchObject({ modo: 'gravar', versao: '3', zerarNaoContados: 'true' });
    expect(await screen.findByText(/Contagem gravada: 2 produto.*Também alterado.*Nº 9/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Importar contagem' })).not.toBeInTheDocument(),
    );
  }, 20_000);

  it('"Importar contagem" só no Definir em rascunho; "Imprimir" abre a folha com as opções', async () => {
    const usuario = userEvent.setup();
    const abrir = vi.fn();
    vi.stubGlobal('open', abrir);
    simularApi(...sessao(), ...referencias, ({ url }) =>
      url.pathname === `/api/acertos/${ACERTO}` ? { corpo: detalhe({ status: 'efetivado' }) } : undefined,
    );
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    await screen.findByRole('heading', { name: 'Acerto de estoque Nº 7' });
    expect(screen.queryByRole('button', { name: 'Importar contagem' })).not.toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Imprimir' }));
    const dialogo = await screen.findByRole('dialog', { name: 'Folha de contagem' });
    await usuario.click(within(dialogo).getByRole('radio', { name: 'Com o saldo' }));
    await usuario.click(within(dialogo).getByRole('button', { name: 'Abrir para imprimir' }));
    expect(abrir).toHaveBeenCalledTimes(1);
    const url = new URL(String(abrir.mock.calls[0]![0]), 'http://localhost');
    expect(url.pathname).toBe('/estoque/folha-contagem');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      estoqueId: ESTOQUE,
      tipoEstoqueId: DISPONIVEL,
      cega: 'false',
      ordem: 'localizacao',
      imprimir: '1',
    });
  });

  it('folha cega sem a coluna de saldo; com saldo traz a coluna; a impressão é chamada', async () => {
    const imprimir = vi.fn();
    vi.stubGlobal('print', imprimir);
    const folha = (cega: boolean): FolhaContagem => ({
      estoqueNome: 'Loja 1 - Ice Beer Hermes',
      tipoEstoqueNome: 'Disponível',
      cega,
      ordem: 'localizacao',
      marca: null,
      categoria: null,
      geradaEm: '2026-11-04T12:00:00.000Z',
      linhas: [
        {
          produtoId: BRAHMA.id,
          codigo: 11,
          codigoInterno: null,
          codigoBarras: '7891149103102',
          nome: 'CERV BRAHMA LT 350ML',
          unidadeSigla: 'UN',
          localizacao: 'B-02',
          marca: 'AMBEV',
          saldo: cega ? null : '18.000',
        },
      ],
    });
    const { chamadas } = simularApi(...sessao(), ({ url }) =>
      url.pathname === '/api/acertos/folha-contagem'
        ? { corpo: folha(url.searchParams.get('cega') !== 'false') }
        : undefined,
    );
    const rotas = (url: string) =>
      renderizarRotas(
        [
          {
            element: (
              <ProvedorSessao>
                <Outlet />
              </ProvedorSessao>
            ),
            children: [
              {
                path: '/estoque/folha-contagem',
                element: (
                  <Autenticado>
                    <FolhaContagemImpressao />
                  </Autenticado>
                ),
              },
            ],
          },
        ],
        url,
      );
    const cega = rotas(`/estoque/folha-contagem?estoqueId=${ESTOQUE}&cega=true&ordem=localizacao&imprimir=1`);
    expect(await screen.findByRole('heading', { name: /Folha de contagem \(cega\)/ })).toBeInTheDocument();
    expect(screen.getByText('CERV BRAHMA LT 350ML')).toBeInTheDocument();
    expect(screen.queryByTestId('coluna-saldo')).not.toBeInTheDocument();
    expect(screen.queryByText('18')).not.toBeInTheDocument();
    await waitFor(() => expect(imprimir).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(
      chamadas.find((c) => c.url.pathname === '/api/acertos/folha-contagem')!.url.searchParams.get('cega'),
    ).toBe('true');
    cega.unmount();
    rotas(`/estoque/folha-contagem?estoqueId=${ESTOQUE}&cega=false`);
    expect(await screen.findByTestId('coluna-saldo')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('lote na grade da Saída: escolhe o lote do produto e manda o loteId', async () => {
    const usuario = userEvent.setup();
    const LOTE = '0190a000-0000-7000-8000-0000000000a1';
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url, metodo }) => {
      if (url.pathname === `/api/acertos/${ACERTO}`)
        return metodo === 'PUT'
          ? { corpo: detalhe({ tipoAjuste: 'saida' }) }
          : {
              corpo: detalhe({
                tipoAjuste: 'saida',
                responsavelId: '0190a000-0000-7000-8000-0000000000b9',
                itens: [
                  {
                    ...detalhe().itens[0]!,
                    id: '0190a000-0000-7000-8000-0000000000b1',
                    quantidade: '2.000',
                    diferenca: '-2.000',
                  },
                ],
              }),
            };
      if (url.pathname === '/api/saldos-estoque/lotes')
        return {
          corpo: [
            {
              loteId: LOTE,
              produtoId: BRAHMA.id,
              variacaoId: null,
              lote: 'L-01',
              validade: '2027-01-31',
              quantidade: '6.000',
            },
          ],
        };
      return undefined;
    });
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    await screen.findByRole('heading', { name: 'Acerto de estoque Nº 7' });
    const grade = screen.getByRole('table', { name: 'Itens do acerto' });
    const lote = await within(grade).findByLabelText('Lote da linha 1');
    expect(
      within(lote).getByRole('option', { name: 'L-01 · val. 31/01/2027 · saldo 6' }),
    ).toBeInTheDocument();
    expect(lote).toHaveValue('');
    await usuario.selectOptions(lote, LOTE);
    await usuario.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(chamadas.some((c) => c.metodo === 'PUT')).toBe(true));
    const put = chamadas.find((c) => c.metodo === 'PUT')!;
    expect(put.corpo).toMatchObject({
      itens: [{ id: '0190a000-0000-7000-8000-0000000000b1', produtoId: BRAHMA.id, loteId: LOTE }],
    });
    expect(within(grade).queryByText('Sem lote (FEFO)')).toBeInTheDocument();
  }, 20_000);
});

const CAIXA1 = '0190a000-0000-7000-8000-0000000000a1';
const VENDA1 = '0190a000-0000-7000-8000-0000000000b1';

function compensacao(parcial: Partial<CompensacaoAcerto> = {}): CompensacaoAcerto {
  return {
    id: 'comp-1',
    sentido: 'lancada',
    acertoId: ACERTO,
    acertoCodigo: 7,
    produtoId: BRAHMA.id,
    produtoCodigo: BRAHMA.codigo,
    produtoNome: BRAHMA.nome,
    variacaoId: null,
    loteId: null,
    lote: null,
    quantidade: '2.000',
    custoUnitario: '2.0000',
    dataFato: '2026-10-30T10:00:00.000Z',
    lancadaEm: '2026-10-30T13:00:00.000Z',
    compensado: {
      id: 'mov-venda-1',
      tipoMovimento: 'VENDA_PDV',
      tipoMovimentoNome: 'Venda pelo PDV',
      quantidade: '-2.000',
      documentoTipo: 'venda',
      documentoId: VENDA1,
      documento: 'Venda L01-C01-000012',
      terminalId: CAIXA1,
      terminal: 'Caixa 01 · PC do balcão',
      eventoId: 'ev-1',
      sequencia: 41,
      recebidoEm: '2026-10-30T13:00:00.000Z',
    },
    relogio: { confiavel: true, desvioMs: null, motivos: [] },
    relogioSuspeito: false,
    estorno: null,
    ...parcial,
  };
}

describe('Compensações visíveis no acerto (F2-B10)', () => {
  const efetivado = (parcial: Partial<AcertoDetalhe>) =>
    simularApi(...sessao([...PERMISSOES, 'vendas.ver', 'terminais.ver']), ...referencias, ({ url }) =>
      url.pathname === `/api/acertos/${ACERTO}`
        ? { corpo: detalhe({ status: 'efetivado', efetivadoEm: '2026-10-30T12:00:00.000Z', ...parcial }) }
        : undefined,
    );

  it('aba com cada compensação: terminal, hora, documento, relógio suspeito destacado e o estorno', async () => {
    const usuario = userEvent.setup();
    efetivado({
      totalCompensacoes: 3,
      compensacoes: [
        compensacao(),
        compensacao({
          id: 'comp-2',
          quantidade: '1.000',
          dataFato: '2026-10-30T10:30:00.000Z',
          compensado: { ...compensacao().compensado, id: 'mov-venda-2', documento: 'Venda L01-C01-000013' },
          relogio: { confiavel: false, desvioMs: 600_000, motivos: ['nao_confiavel', 'desvio'] },
          relogioSuspeito: true,
        }),
        compensacao({
          id: 'comp-3',
          sentido: 'recebida',
          acertoId: 'outro-acerto',
          acertoCodigo: 9,
          quantidade: '-5.000',
          compensado: {
            ...compensacao().compensado,
            id: 'mov-acerto',
            tipoMovimento: 'ACERTO_DEFINIR',
            tipoMovimentoNome: 'Acerto de estoque – Definir',
            documentoTipo: 'acerto',
            documentoId: ACERTO,
            documento: 'Acerto Nº 7',
            terminalId: null,
            terminal: null,
            eventoId: null,
            sequencia: null,
            recebidoEm: null,
          },
          relogio: null,
          estorno: {
            id: 'est-1',
            em: '2026-10-31T09:00:00.000Z',
            acertoId: ACERTO,
            acertoCodigo: 7,
            motivo: 'Contagem refeita',
            substituidaPor: null,
          },
        }),
      ],
    });
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    const aba = await screen.findByRole('tab', { name: 'Compensações (3)' });
    // O relógio suspeito marca a aba (laranja), antes mesmo de abrir.
    expect(aba.querySelector('[data-marcador="aviso"]')).not.toBeNull();
    await usuario.click(aba);
    expect(await screen.findByTestId('alerta-relogio-suspeito')).toHaveTextContent(
      '1 compensação(ões) com o relógio do caixa suspeito',
    );
    const venda = screen.getByTestId('compensacao-comp-1');
    expect(within(venda).getByRole('link', { name: 'Venda L01-C01-000012' })).toHaveAttribute(
      'href',
      `/vendas/${VENDA1}`,
    );
    expect(within(venda).getByRole('link', { name: 'Caixa 01 · PC do balcão' })).toHaveAttribute(
      'href',
      `/cadastros/pdvs/${CAIXA1}`,
    );
    expect(venda).toHaveTextContent('evento nº 41');
    expect(venda).toHaveTextContent('Venda pelo PDV: -2');
    // O custo unitário, com "Ver custo".
    expect(within(venda).getByText('R$ 2')).toBeInTheDocument();
    expect(within(venda).getByTestId('relogio-comp-1')).toHaveTextContent('Confiável');
    expect(within(venda).getByText('Valendo')).toBeInTheDocument();
    expect(venda).not.toHaveAttribute('data-suspeito');
    const suspeita = screen.getByTestId('compensacao-comp-2');
    expect(suspeita).toHaveAttribute('data-suspeito', 'true');
    expect(within(suspeita).getByTestId('relogio-comp-2')).toHaveTextContent('Suspeito');
    await usuario.hover(within(suspeita).getByTestId('relogio-comp-2'));
    expect(
      await screen.findByText(
        /o caixa estava sem hora confiável; relógio do computador mais de 5 min errado/,
      ),
    ).toBeInTheDocument();
    // A recebida: o movimento deste acerto anulado pelo Nº 9, já estornada.
    expect(screen.getByText(/anulados por outro "Definir"/)).toBeInTheDocument();
    const recebida = screen.getByTestId('compensacao-comp-3');
    expect(within(recebida).getByRole('link', { name: 'Acerto Nº 9' })).toHaveAttribute(
      'href',
      '/estoque/acertos/outro-acerto',
    );
    expect(recebida).toHaveTextContent('ERP');
    expect(within(recebida).getByText('Estornada')).toBeInTheDocument();
  });

  it('acima do limite avisa quantas há; a regressão marcada é "Corrigido" sem destaque; o desvio corrigido não destaca; a estornada aponta a substituta', async () => {
    const usuario = userEvent.setup();
    efetivado({
      totalCompensacoes: 6000,
      compensacoes: [
        compensacao({
          relogio: { confiavel: true, desvioMs: 600_000, motivos: ['regressao_marcada'] },
          relogioSuspeito: false,
          estorno: {
            id: 'est-1',
            em: '2026-10-31T09:00:00.000Z',
            acertoId: ACERTO,
            acertoCodigo: 7,
            motivo: 'Contagem refeita',
            substituidaPor: { id: 'comp-9', acertoId: 'acerto-anterior', acertoCodigo: 5 },
          },
        }),
        compensacao({
          id: 'comp-2',
          relogio: { confiavel: true, desvioMs: 600_000, motivos: [] },
          relogioSuspeito: false,
        }),
      ],
    });
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    const aba = await screen.findByRole('tab', { name: 'Compensações (6.000)' });
    // Nada suspeito: a aba sem o marcador e sem o aviso do relógio.
    expect(aba.querySelector('[data-marcador]')).toBeNull();
    await usuario.click(aba);
    expect(await screen.findByText(/Mostrando as primeiras 2 de 6\.000 compensações/)).toBeInTheDocument();
    expect(screen.queryByTestId('alerta-relogio-suspeito')).toBeNull();
    expect(screen.getByText(/compensado de novo contra esse outro acerto/)).toBeInTheDocument();
    const marcada = screen.getByTestId('compensacao-comp-1');
    expect(marcada).not.toHaveAttribute('data-suspeito');
    expect(within(marcada).getByTestId('relogio-comp-1')).toHaveTextContent('Corrigido');
    expect(within(marcada).getByText('Estornada')).toBeInTheDocument();
    expect(within(marcada).getByTestId('substituida-comp-1')).toHaveTextContent(
      'Compensado de novo pelo Acerto Nº 5',
    );
    expect(within(marcada).getByRole('link', { name: 'Acerto Nº 5' })).toHaveAttribute(
      'href',
      '/estoque/acertos/acerto-anterior',
    );
    // O Windows 10 min atrasado com a hora confiável: "Confiável", com o desvio (já corrigido) na dica.
    const corrigida = screen.getByTestId('compensacao-comp-2');
    expect(corrigida).not.toHaveAttribute('data-suspeito');
    expect(within(corrigida).getByTestId('relogio-comp-2')).toHaveTextContent('Confiável');
    expect(within(corrigida).queryByTestId('substituida-comp-2')).toBeNull();
    await usuario.hover(within(corrigida).getByText('Confiável'));
    expect(await screen.findByText(/a hora do fato já foi corrigida por ele/)).toBeInTheDocument();
  }, 20_000);

  it('sem compensações a aba explica; sem "Ver custo" não há a coluna de custo; o rascunho não tem a aba', async () => {
    const usuario = userEvent.setup();
    efetivado({});
    const { unmount } = renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    const aba = await screen.findByRole('tab', { name: 'Compensações' });
    expect(aba.querySelector('[data-marcador]')).toBeNull();
    await usuario.click(aba);
    expect(await screen.findByTestId('sem-compensacoes')).toHaveTextContent('Nenhuma compensação');
    unmount();
    vi.unstubAllGlobals();

    simularApi(...sessao(['estoque_acertos.ver']), ...referencias, ({ url }) =>
      url.pathname === `/api/acertos/${ACERTO}`
        ? {
            corpo: detalhe({
              status: 'efetivado',
              totalCusto: null,
              totalCompensacoes: 1,
              compensacoes: [compensacao({ custoUnitario: null })],
            }),
          }
        : undefined,
    );
    const outro = renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    await usuario.click(await screen.findByRole('tab', { name: 'Compensações (1)' }));
    const linha = await screen.findByTestId('compensacao-comp-1');
    expect(screen.queryByRole('columnheader', { name: 'Custo' })).toBeNull();
    // Sem "vendas.ver" e "terminais.ver", o documento e o terminal vêm sem link.
    expect(within(linha).queryByRole('link')).toBeNull();
    expect(linha).toHaveTextContent('Venda L01-C01-000012');
    outro.unmount();
    vi.unstubAllGlobals();

    simularApi(...sessao(), ...referencias, ({ url }) =>
      url.pathname === `/api/acertos/${ACERTO}` ? { corpo: detalhe() } : undefined,
    );
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    expect(await screen.findByRole('tab', { name: 'Acerto' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Compensações/ })).toBeNull();
  });
});

describe('Conferência do "Definir" com tolerância (F2-B11)', () => {
  const CERV2 = '0190a000-0000-7000-8000-000000000012';
  function conferencia(parcial: Partial<ConferenciaAcerto> = {}): ConferenciaAcerto {
    return {
      acertoId: ACERTO,
      codigo: 7,
      estoqueNome: 'CD - Estoque Ice Beer',
      tipoEstoqueNome: 'Disponível',
      dataContagem: '2026-10-30T11:00:00.000Z',
      estimativa: false,
      toleranciaTotalPct: '1',
      toleranciaItemPct: '5',
      valorContado: '338.00',
      valorSistema: '360.00',
      valorDiferenca: '-22.00',
      valorDiferencaAbsoluta: '22.00',
      diferencaTotalPct: '6.51',
      totalForaTolerancia: true,
      itensForaTolerancia: 1,
      veredito: 'fora_tolerancia',
      itens: [
        {
          itemId: 'i2',
          produtoId: CERV2,
          produtoCodigo: 12,
          produtoNome: 'CERV SKOL LT 350ML',
          unidadeSigla: 'UN',
          contado: '24.000',
          saldoSistema: '30.000',
          compensado: '2.000',
          diferenca: '-6.000',
          custoUnitario: '2.0000',
          valorContado: '48.00',
          valorSistema: '60.00',
          valorDiferenca: '-12.00',
          diferencaPct: '20.00',
          foraTolerancia: true,
        },
        {
          itemId: 'i1',
          produtoId: BRAHMA.id,
          produtoCodigo: 11,
          produtoNome: 'CERV BRAHMA LT 350ML',
          unidadeSigla: 'UN',
          contado: '95.000',
          saldoSistema: '100.000',
          compensado: '0.000',
          diferenca: '-5.000',
          custoUnitario: '2.0000',
          valorContado: '190.00',
          valorSistema: '200.00',
          valorDiferenca: '-10.00',
          diferencaPct: '5.00',
          foraTolerancia: false,
        },
      ],
      ...parcial,
    };
  }

  it('efetivado: veredito, totais a custo, item fora destacado e os limites trocados só na consulta', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...sessao(), ...referencias, ({ url }) => {
      if (url.pathname === `/api/acertos/${ACERTO}`)
        return { corpo: detalhe({ status: 'efetivado', origem: 'importacao' }) };
      if (url.pathname !== `/api/acertos/${ACERTO}/conferencia`) return undefined;
      return {
        corpo: url.searchParams.get('toleranciaItemPct')
          ? conferencia({
              toleranciaTotalPct: '7',
              toleranciaItemPct: '20',
              totalForaTolerancia: false,
              itensForaTolerancia: 0,
              veredito: 'conferido',
              itens: conferencia().itens.map((i) => ({ ...i, foraTolerancia: false })),
            })
          : conferencia(),
      };
    });
    renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    await usuario.click(await screen.findByRole('tab', { name: 'Conferência' }));
    expect(await screen.findByTestId('veredito-conferencia')).toHaveTextContent('Fora da tolerância');
    const totais = screen.getByTestId('totais-conferencia');
    expect(totais).toHaveTextContent('R$ 338');
    expect(totais).toHaveTextContent('Soma dos módulos: R$ 22');
    expect(totais).toHaveTextContent('6,51%');
    expect(within(totais).getByText('Itens acima de 5,00%').nextSibling).toHaveTextContent('1');
    const fora = screen.getByTestId(`conferencia-${CERV2}`);
    expect(fora).toHaveAttribute('data-fora', 'true');
    expect(fora).toHaveTextContent('20,00%');
    expect(fora).toHaveTextContent('com 2 de venda(s) tardia(s) compensada(s)');
    expect(fora).toHaveTextContent('R$ -12');
    expect(screen.getByTestId(`conferencia-${BRAHMA.id}`)).not.toHaveAttribute('data-fora');

    await usuario.type(screen.getByLabelText('Tolerância total (%)'), '7');
    await usuario.type(screen.getByLabelText('Tolerância por item (%)'), '20');
    await usuario.click(screen.getByRole('button', { name: 'Recalcular' }));
    await waitFor(() => expect(screen.getByTestId('veredito-conferencia')).toHaveTextContent('Conferido'));
    const ultima = chamadas.filter((c) => c.url.pathname.endsWith('/conferencia')).at(-1)!;
    expect(Object.fromEntries(ultima.url.searchParams)).toEqual({
      toleranciaTotalPct: '7',
      toleranciaItemPct: '20',
    });
  });

  it('rascunho é estimativa; sem "Ver custo" só percentuais; a Entrada e o estornado não têm a aba', async () => {
    const usuario = userEvent.setup();
    simularApi(...sessao(['estoque_acertos.ver']), ...referencias, ({ url }) =>
      url.pathname === `/api/acertos/${ACERTO}`
        ? { corpo: detalhe() }
        : url.pathname === `/api/acertos/${ACERTO}/conferencia`
          ? {
              corpo: conferencia({
                estimativa: true,
                valorContado: null,
                valorSistema: null,
                valorDiferenca: null,
                valorDiferencaAbsoluta: null,
                itens: conferencia().itens.map((i) => ({
                  ...i,
                  custoUnitario: null,
                  valorContado: null,
                  valorSistema: null,
                  valorDiferenca: null,
                })),
              }),
            }
          : undefined,
    );
    const { unmount } = renderizarFormulario(`/estoque/acertos/${ACERTO}`);
    await usuario.click(await screen.findByRole('tab', { name: 'Conferência' }));
    expect(await screen.findByText(/Rascunho: estimativa com o saldo de agora/)).toBeInTheDocument();
    expect(screen.queryByText('Valor contado (custo)')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Diferença a custo' })).toBeNull();
    expect(screen.getByTestId(`conferencia-${CERV2}`)).toHaveTextContent('20,00%');
    unmount();
    vi.unstubAllGlobals();

    for (const parcial of [
      { status: 'estornado' as const },
      { tipoAjuste: 'entrada' as const, status: 'efetivado' as const },
    ]) {
      simularApi(...sessao(), ...referencias, ({ url }) =>
        url.pathname === `/api/acertos/${ACERTO}` ? { corpo: detalhe(parcial) } : undefined,
      );
      const r = renderizarFormulario(`/estoque/acertos/${ACERTO}`);
      expect(await screen.findByRole('tab', { name: 'Acerto' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Conferência' })).toBeNull();
      r.unmount();
      vi.unstubAllGlobals();
    }
  });
});
