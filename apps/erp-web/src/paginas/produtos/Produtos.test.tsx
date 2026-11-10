import type { ProdutoDetalhe, ProdutoOpcao } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioProduto } from './FormularioProduto';
import { FormularioGrupoPreco } from './GruposPreco';
import { ListaProdutos } from './ListaProdutos';
import { errosParaFormulario, paraCorpo, paraValores, produtoVazio } from './valores';

afterEach(() => vi.unstubAllGlobals());

const UN = '0190a000-0000-7000-8000-0000000000a1';
const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const TODAS = [
  'produtos.ver',
  'produtos.criar',
  'produtos.editar',
  'produtos.ver_custo',
  'marcas.ver',
  'categorias.ver',
  'grupos_preco.ver',
  'grupos_preco.editar',
];
const LOJAS = [{ id: LOJA, codigo: 1, nome: 'Loja Centro', ativa: true }];

function Autenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}

function renderizar(url: string) {
  return renderizarRotas(
    [
      {
        element: (
          <ProvedorSessao>
            <Outlet />
          </ProvedorSessao>
        ),
        children: [
          {
            path: '/produtos',
            element: (
              <Autenticado>
                <ListaProdutos />
              </Autenticado>
            ),
          },
          {
            path: '/produtos/novo',
            element: (
              <Autenticado>
                <FormularioProduto />
              </Autenticado>
            ),
          },
          {
            path: '/produtos/grupos-preco/:id',
            element: (
              <Autenticado>
                <FormularioGrupoPreco />
              </Autenticado>
            ),
          },
          {
            path: '/produtos/:id/:aba?',
            element: (
              <Autenticado>
                <FormularioProduto />
              </Autenticado>
            ),
          },
        ],
      },
    ],
    url,
  );
}

const referencias = [
  ({ url }: { url: URL }) =>
    url.pathname === '/api/referencias/unidades'
      ? {
          corpo: [
            { id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false },
            {
              id: '0190a000-0000-7000-8000-0000000000a2',
              sigla: 'KG',
              descricao: 'Quilo',
              permiteFracao: true,
            },
          ],
        }
      : undefined,
  ({ url }: { url: URL }) =>
    url.pathname === '/api/marcas'
      ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } }
      : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/categorias/arvore' ? { corpo: [] } : undefined),
  ({ url }: { url: URL }) =>
    url.pathname === '/api/grupos-preco-quantidade'
      ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } }
      : undefined,
  ({ url }: { url: URL }) => (url.pathname === '/api/referencias/cfops' ? { corpo: [] } : undefined),
];

const opcao = (id: string, nome: string, custo: string, venda: string): ProdutoOpcao => ({
  id,
  codigo: Number(id.slice(-2)),
  nome,
  tipo: 'simples',
  ativo: true,
  unidadeId: UN,
  unidadeSigla: 'UN',
  permiteFracao: false,
  controlaEstoque: true,
  ean: null,
  precoVenda: venda,
  precoAtacado: null,
  qtdMinimaAtacado: null,
  precoCusto: custo,
  grupoPrecoQuantidadeId: null,
});

const WHISKY = opcao('0190a000-0000-7000-8000-000000000011', 'WHISKY 1L', '80.0000', '120.0000');
const REDBULL = opcao('0190a000-0000-7000-8000-000000000012', 'RED BULL 2L', '10.0000', '18.0000');
const MONSTER = opcao('0190a000-0000-7000-8000-000000000013', 'MONSTER 2L', '12.0000', '20.0000');
const GELO = opcao('0190a000-0000-7000-8000-000000000014', 'GELO COCO', '2.0000', '5.0000');

function detalhe(extra: Partial<ProdutoDetalhe>): ProdutoDetalhe {
  const v = produtoVazio([], UN);
  return {
    ...(Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, x === '' ? null : x]),
    ) as unknown as ProdutoDetalhe),
    id: '0190a000-0000-7000-8000-0000000000c1',
    versao: 3,
    criadoEm: '2026-10-30T12:00:00Z',
    atualizadoEm: '2026-10-30T12:00:00Z',
    atualizadoPorNome: 'MARIA',
    codigo: 50,
    nome: 'COMBO DE WHISKY 1L',
    tipo: 'simples',
    ativo: true,
    unidadeId: UN,
    unidadeSigla: 'UN',
    precoCusto: '0.0000',
    custoMedio: '0.0000',
    markupPct: '0.0000',
    precoVenda: '10.0000',
    categorias: [],
    ean: null,
    codigosBarras: [],
    lojas: [],
    precosQuantidade: [],
    componentes: [],
    grupoPreco: null,
    vasilhame: null,
    usadoEm: [],
    avisos: [],
    temMovimento: false,
    ...extra,
  } as ProdutoDetalhe;
}

const KIT = detalhe({
  tipo: 'kit',
  precoVenda: '139.9000',
  precoCusto: '94.0000',
  componentes: [
    {
      id: '0190a000-0000-7000-8000-0000000000d1',
      tipo: 'kit',
      componenteId: WHISKY.id,
      componenteVariacaoId: null,
      quantidade: '1.000',
      perdaPct: '0.0000',
      rotuloPosicao: null,
      permiteSubstituicao: false,
      ordem: 1,
      componente: WHISKY,
      alternativas: [],
    },
    {
      id: '0190a000-0000-7000-8000-0000000000d2',
      tipo: 'kit',
      componenteId: REDBULL.id,
      componenteVariacaoId: null,
      quantidade: '1.000',
      perdaPct: '0.0000',
      rotuloPosicao: 'Energético 2L',
      permiteSubstituicao: true,
      ordem: 2,
      componente: REDBULL,
      alternativas: [
        {
          id: '0190a000-0000-7000-8000-0000000000e1',
          produtoId: MONSTER.id,
          variacaoId: null,
          acrescimo: '2.0000',
          ordem: 1,
          ativo: true,
          produto: MONSTER,
        },
      ],
    },
    {
      id: '0190a000-0000-7000-8000-0000000000d3',
      tipo: 'kit',
      componenteId: GELO.id,
      componenteVariacaoId: null,
      quantidade: '2.000',
      perdaPct: '0.0000',
      rotuloPosicao: 'Gelo de sabor',
      permiteSubstituicao: false,
      ordem: 3,
      componente: GELO,
      alternativas: [],
    },
  ],
});

describe('valores do formulário de produto', () => {
  it('EAN principal + códigos adicionais, lojas só com dados, combo com alternativas', () => {
    const v = paraValores(KIT, [{ id: LOJA, nome: 'Loja Centro' }]);
    v.ean = '7891149103102';
    v.codigosAdicionais = [
      {
        chave: 'x',
        id: null,
        codigo: '17891149103109',
        tipo: 'gtin',
        descricao: 'Fardo',
        unidadeId: null,
        fator: '12',
        preco: '36,90',
        usaVenda: true,
        usaCompra: true,
      },
    ];
    const c = paraCorpo(v);
    expect(c.codigosBarras).toEqual([
      { id: null, codigo: '7891149103102', tipo: 'gtin', principal: true },
      expect.objectContaining({ codigo: '17891149103109', principal: false, fator: '12', preco: '36,90' }),
    ]);
    expect(c.lojas).toEqual([]);
    expect(c.componentes).toHaveLength(3);
    expect((c.componentes as Array<{ alternativas: unknown[] }>)[1]!.alternativas).toEqual([
      expect.objectContaining({ produtoId: MONSTER.id, acrescimo: '2,00', ativo: true }),
    ]);
    expect(
      errosParaFormulario(v, {
        'codigosBarras.0.codigo': 'a',
        'codigosBarras.1.fator': 'b',
        'componentes.2.quantidade': 'c',
      }),
    ).toEqual({
      ean: 'a',
      'codigosAdicionais.0.fator': 'b',
      'posicoes.2.quantidade': 'c',
    });
  });

  it('duplicar copia sem códigos de barras, código interno nem ids das filhas', () => {
    const v = paraValores(
      {
        ...KIT,
        codigoInterno: 'CMB1',
        codigosBarras: [
          {
            id: 'a',
            codigo: '7891149103102',
            tipo: 'gtin',
            principal: true,
            descricao: null,
            unidadeId: null,
            fator: '1',
            preco: null,
            usaVenda: true,
            usaCompra: true,
          },
        ],
      },
      [],
      true,
    );
    expect(v.ean).toBe('');
    expect(v.codigoInterno).toBe('');
    expect(v.posicoes.every((p) => p.id === null && p.alternativas.every((a) => a.id === null))).toBe(true);
  });
});

describe('<FormularioProduto> (ERP 8.2)', () => {
  it('valida o dígito do EAN e o preço na tela, sem chamar a API', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(...rotasSessao({ permissoes: TODAS, lojas: LOJAS }), ...referencias);
    renderizar('/produtos/novo');
    await usuario.type(await screen.findByLabelText(/^Nome/), 'CERV BRAHMA LT 350');
    await usuario.type(screen.getByLabelText(/Cód. barras \(EAN-13\)/), '7891149103103');
    expect(screen.getByText('Dígito verificador do GTIN inválido')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByText('Informe o preço de venda')).toBeInTheDocument();
    expect(chamadas.some((c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos')).toBe(false);
  }, 30_000);

  it(
    'markup ⇄ preço: Calcular usa o markup; digitar o preço recalcula o markup e a margem',
    { timeout: 30_000 },
    async () => {
      const usuario = userEvent.setup();
      simularApi(...rotasSessao({ permissoes: TODAS, lojas: LOJAS }), ...referencias);
      renderizar('/produtos/novo');
      const custo = await screen.findByLabelText('Preço de custo');
      await usuario.clear(custo);
      await usuario.type(custo, '6');
      const markup = screen.getByLabelText('Markup %');
      await usuario.clear(markup);
      await usuario.type(markup, '50');
      await usuario.click(screen.getByRole('button', { name: 'Calcular preço pelo markup' }));
      expect(screen.getByLabelText(/^Preço de venda/)).toHaveValue('9,00');
      await usuario.clear(screen.getByLabelText(/^Preço de venda/));
      await usuario.type(screen.getByLabelText(/^Preço de venda/), '10');
      expect(screen.getByLabelText('Markup %')).toHaveValue('66,6667');
      expect(screen.getByLabelText('Margem %')).toHaveValue('40,00%');
    },
  );

  it('EAN duplicado com "avisar": confirma e regrava com confirmarEanDuplicado', async () => {
    const usuario = userEvent.setup();
    let tentativas = 0;
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: TODAS, lojas: LOJAS }),
      ...referencias,
      ({ url, metodo, corpo }) => {
        if (metodo !== 'POST' || url.pathname !== '/api/produtos') return undefined;
        tentativas++;
        return (corpo as { confirmarEanDuplicado: boolean }).confirmarEanDuplicado
          ? { status: 201, corpo: detalhe({ nome: 'BRAHMA 2' }) }
          : {
              status: 409,
              corpo: {
                codigo: 'CONFLITO',
                mensagem: 'O EAN 7891149103102 já está no produto CERV BRAHMA. Gravar mesmo assim?',
                campos: {
                  'codigosBarras.0.codigo': ['O EAN 7891149103102 já está no produto 1 - CERV BRAHMA'],
                },
                detalhes: { eanDuplicado: { modo: 'avisar', confirmar: true, duplicados: [] } },
              },
            };
      },
    );
    renderizar('/produtos/novo');
    await usuario.type(await screen.findByLabelText(/^Nome/), 'BRAHMA 2');
    await usuario.type(screen.getByLabelText(/Cód. barras \(EAN-13\)/), '7891149103102');
    await usuario.type(screen.getByLabelText(/^Preço de venda/), '3,49');
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    const modal = await screen.findByRole('dialog');
    expect(within(modal).getByText(/Gravar mesmo assim\?/)).toBeInTheDocument();
    await usuario.click(within(modal).getByRole('button', { name: 'Gravar mesmo assim' }));
    await waitFor(() => expect(tentativas).toBe(2));
    const posts = chamadas.filter((c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos');
    expect(posts.map((p) => (p.corpo as { confirmarEanDuplicado: boolean }).confirmarEanDuplicado)).toEqual([
      false,
      true,
    ]);
    expect((posts[0]!.corpo as { codigosBarras: unknown[] }).codigosBarras).toEqual([
      { id: null, codigo: '7891149103102', tipo: 'gtin', principal: true },
    ]);
  }, 30_000);

  it('combo: resumo com custo, desconto, margem e faixa com as trocas; combos montáveis no Estoque', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: TODAS, lojas: LOJAS }),
      ...referencias,
      ({ url }) => (url.pathname === `/api/produtos/${KIT.id}` ? { corpo: KIT } : undefined),
      ({ url }) =>
        url.pathname === `/api/produtos/${KIT.id}/saldos`
          ? {
              corpo: {
                combo: true,
                saldos: [],
                montaveis: [
                  {
                    estoqueId: 'e1',
                    estoqueNome: 'Estoque Loja Centro',
                    quantidade: 3,
                    limitadoPor: 'GELO COCO',
                  },
                ],
              },
            }
          : undefined,
    );
    renderizar(`/produtos/${KIT.id}`);
    const resumo = await screen.findByTestId('resumo-combo');
    expect(within(resumo).getByText('R$ 94,00')).toBeInTheDocument();
    expect(within(resumo).getByText('R$ 148,00')).toBeInTheDocument();
    expect(within(resumo).getByText('R$ 8,10 (5,47%)')).toBeInTheDocument();
    expect(within(resumo).getByText('32,81% / 48,83%')).toBeInTheDocument();
    expect(within(resumo).getByText(/de 32,35% a 32,81%/)).toBeInTheDocument();
    expect(screen.getByLabelText('Preço de custo')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Calcular preço pelo markup' })).toBeNull();
    const posicao = screen.getByTestId('posicao-1');
    expect(within(posicao).getByLabelText('Posição 2')).toHaveValue('Energético 2L');
    expect(within(screen.getByTestId('alternativa-1-0')).getByLabelText('Acréscimo')).toHaveValue('2,00');
    await usuario.click(screen.getByRole('button', { name: /^Estoque/ }));
    const montaveis = await screen.findByTestId('montaveis');
    expect(within(montaveis).getByText('GELO COCO')).toBeInTheDocument();
    expect(within(montaveis).getByText('3')).toBeInTheDocument();
  });
});

describe('<FormularioProduto>: tipos sem suporte (F2-B1)', () => {
  const tiposPadrao = ({ url }: { url: URL }) =>
    url.pathname === '/api/produtos/tipos-habilitados'
      ? {
          corpo: {
            tipos: ['simples', 'kit', 'materia_prima', 'servico', 'produzido', 'vasilhame'],
          },
        }
      : undefined;

  it('na criação o select não oferece Com variações nem Com complementos', async () => {
    const u = userEvent.setup();
    simularApi(...rotasSessao({ permissoes: TODAS, lojas: LOJAS }), ...referencias, tiposPadrao);
    renderizar('/produtos/novo');
    await u.click(await screen.findByRole('combobox', { name: 'Tipo' }));
    expect(await screen.findByRole('option', { name: 'Simples', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Combo / kit', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Com variações', hidden: true })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Com complementos', hidden: true })).toBeNull();
  }, 30_000);

  it('com as chaves ligadas na API o select passa a oferecer os dois tipos', async () => {
    // A rota devolve uma lista diferente do padrão local: o teste falha se o hook se desligar da API.
    const u = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: TODAS, lojas: LOJAS }),
      ...referencias,
      ({ url }) =>
        url.pathname === '/api/produtos/tipos-habilitados'
          ? {
              corpo: {
                tipos: [
                  'simples',
                  'kit',
                  'com_variacoes',
                  'com_complementos',
                  'materia_prima',
                  'servico',
                  'produzido',
                  'vasilhame',
                ],
              },
            }
          : undefined,
    );
    renderizar('/produtos/novo');
    await u.click(await screen.findByRole('combobox', { name: 'Tipo' }));
    expect(await screen.findByRole('option', { name: 'Com complementos', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Com variações', hidden: true })).toBeInTheDocument();
    expect(
      chamadas.some((c) => c.metodo === 'GET' && c.url.pathname === '/api/produtos/tipos-habilitados'),
    ).toBe(true);
  }, 30_000);

  it('na edição do legado mostra o tipo gravado e orienta a trocar para Simples', async () => {
    const u = userEvent.setup();
    const legado = detalhe({ tipo: 'com_variacoes', nome: 'CERVEJA LEGADO', temMovimento: true });
    simularApi(...rotasSessao({ permissoes: TODAS, lojas: LOJAS }), ...referencias, tiposPadrao, ({ url }) =>
      url.pathname === `/api/produtos/${legado.id}` ? { corpo: legado } : undefined,
    );
    renderizar(`/produtos/${legado.id}`);
    const tipo = await screen.findByRole('combobox', { name: 'Tipo' });
    await waitFor(() => expect(tipo).toHaveValue('Com variações'));
    expect(screen.getByText('Tipo sem suporte nesta versão')).toBeInTheDocument();
    expect(screen.getByText(/Troque o tipo para Simples/)).toBeInTheDocument();
    // Com movimento, o legado sem grade ainda pode sair do tipo.
    expect(tipo).toBeEnabled();
    await u.click(tipo);
    expect(await screen.findByRole('option', { name: 'Simples', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Com complementos', hidden: true })).toBeNull();
  }, 30_000);
});

describe('<ListaProdutos> (ERP 8.1)', () => {
  it('lista com o EAN e esconde o custo sem produtos.ver_custo', async () => {
    simularApi(
      ...rotasSessao({ permissoes: ['produtos.ver', 'marcas.ver', 'categorias.ver'], lojas: LOJAS }),
      ...referencias,
      ({ url }) =>
        url.pathname === '/api/produtos'
          ? {
              corpo: {
                itens: [
                  {
                    id: '0190a000-0000-7000-8000-0000000000c9',
                    codigo: 9,
                    nome: 'CERV BRAHMA LT 350ML',
                    tipo: 'simples',
                    ativo: true,
                    codigoInterno: 'BRH350',
                    ean: '7891149103102',
                    marcaNome: 'BRAHMA',
                    localizacao: 'G1',
                    unidadeSigla: 'UN',
                    precoCusto: null,
                    precoVenda: '3.4900',
                    versao: 1,
                  },
                ],
                total: 1,
                pagina: 1,
                tamanho: 20,
              },
            }
          : undefined,
    );
    renderizar('/produtos');
    expect(await screen.findByText('CERV BRAHMA LT 350ML')).toBeInTheDocument();
    expect(screen.getByText('7891149103102')).toBeInTheDocument();
    expect(screen.getByText('R$ 3,49')).toBeInTheDocument();
    expect(screen.queryByText('Preço custo')).toBeNull();
    // Sem o filtro "EAN duplicado", sem o atalho do relatório.
    expect(screen.queryByRole('link', { name: 'Relatório de EAN duplicado' })).toBeNull();
  });

  it('com o filtro "EAN duplicado", o atalho para o relatório (F2-B38)', async () => {
    simularApi(
      ...rotasSessao({ permissoes: ['produtos.ver', 'marcas.ver', 'categorias.ver'], lojas: LOJAS }),
      ...referencias,
      ({ url }) =>
        url.pathname === '/api/produtos'
          ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 20 } }
          : undefined,
    );
    renderizar('/produtos?situacaoCadastro=ean_duplicado');
    const atalho = await screen.findByRole('link', { name: 'Relatório de EAN duplicado' });
    expect(atalho).toHaveAttribute('href', '/relatorios/ean-duplicado');
  });
});

describe('<FormularioGrupoPreco> (ERP 8.10)', () => {
  it('Simular: 6 Brahma + 6 Skol = 12 latas no preço do grupo', async () => {
    const usuario = userEvent.setup();
    const brahma = { ...opcao('0190a000-0000-7000-8000-000000000021', 'BRAHMA LT', '2', '3.4900') };
    const skol = { ...opcao('0190a000-0000-7000-8000-000000000022', 'SKOL LT', '2', '3.3900') };
    const grupoId = '0190a000-0000-7000-8000-0000000000b1';
    simularApi(...rotasSessao({ permissoes: TODAS, lojas: LOJAS }), ...referencias, ({ url }) =>
      url.pathname === `/api/grupos-preco-quantidade/${grupoId}`
        ? {
            corpo: {
              id: grupoId,
              versao: 1,
              criadoEm: '2026-10-30T12:00:00Z',
              atualizadoEm: '2026-10-30T12:00:00Z',
              atualizadoPorNome: null,
              codigo: 1,
              nome: 'MIX LATAS 350ML',
              modoPreco: 'grupo',
              ativo: true,
              faixas: [
                {
                  id: 'f1',
                  lojaId: null,
                  quantidadeInicial: '12.000',
                  quantidadeFinal: null,
                  preco: '2.9900',
                },
              ],
              produtos: [brahma, skol],
            },
          }
        : undefined,
    );
    renderizar(`/produtos/grupos-preco/${grupoId}`);
    await usuario.type(await screen.findByLabelText('Quantidade simulada BRAHMA LT'), '6');
    expect(screen.getByTestId(`simulacao-${brahma.id}`)).toHaveTextContent('R$ 3,49 · Varejo');
    await usuario.type(screen.getByLabelText('Quantidade simulada SKOL LT'), '6');
    expect(screen.getByTestId(`simulacao-${brahma.id}`)).toHaveTextContent('R$ 2,99 · Mix (grupo)');
    expect(screen.getByTestId(`simulacao-${skol.id}`)).toHaveTextContent('R$ 2,99 · Mix (grupo)');
    expect(screen.getByTestId('simulacao-total')).toHaveTextContent('12 un do grupo · total R$ 35,88');
  });
});
