/**
 * Blocos do formulário do produto da Fase 2 (F2-B12; ERP 8.2.7, 8.2.8, 8.2.11): categorias em árvore com a estrela
 * da principal e "Nova categoria", produtos relacionados com a relação inversa e o "Ajustar" do bloco Estoque.
 */
import type { CategoriaNo, ProdutoDetalhe, ProdutoOpcao, SaldosProduto } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioProduto } from './FormularioProduto';
import { produtoVazio } from './valores';

afterEach(() => vi.unstubAllGlobals());

const UN = '0190a000-0000-7000-8000-0000000000a1';
const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const ESTOQUE = '0190a000-0000-7000-8000-0000000000e1';
const DISPONIVEL = '0190a000-0000-7000-8000-0000000000e2';
const ID = '0190a000-0000-7000-8000-0000000000c1';
const PERMISSOES = [
  'produtos.ver',
  'produtos.criar',
  'produtos.editar',
  'produtos.ver_custo',
  'marcas.ver',
  'categorias.ver',
  'categorias.editar',
  'estoque_acertos.criar',
];
const LOJAS = [{ id: LOJA, codigo: 1, nome: 'Loja 1', ativa: true }];

function Autenticado({ children }: { children: ReactNode }) {
  const { estado } = useSessao();
  return estado.status === 'autenticado' ? children : <p>carregando sessão</p>;
}

const renderizar = (url: string) =>
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

const no = (id: string, nome: string, pai: string | null, caminho: string, nivel: number): CategoriaNo => ({
  id,
  nome,
  categoriaPaiId: pai,
  caminhoNomes: caminho,
  nivel,
  ordem: 0,
  ativa: true,
  exibePdv: true,
  exibeMenuDigital: false,
  exibeTotem: false,
  exibeSite: false,
  cor: null,
  produtos: 0,
  versao: 1,
});

const BEBIDAS = no('0190a000-0000-7000-8000-000000000b01', 'BEBIDAS', null, 'BEBIDAS', 1);
const CERVEJA = no('0190a000-0000-7000-8000-000000000b02', 'CERVEJA', BEBIDAS.id, 'BEBIDAS > CERVEJA', 2);
const DESTILADOS = no(
  '0190a000-0000-7000-8000-000000000b03',
  'DESTILADOS',
  BEBIDAS.id,
  'BEBIDAS > DESTILADOS',
  2,
);

const opcao = (id: string, nome: string): ProdutoOpcao => ({
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
  precoVenda: '5.0000',
  precoAtacado: null,
  qtdMinimaAtacado: null,
  precoCusto: '2.0000',
  grupoPrecoQuantidadeId: null,
});
const GELO = opcao('0190a000-0000-7000-8000-000000000014', 'GELO 5KG');
const COPO = opcao('0190a000-0000-7000-8000-000000000015', 'COPO DESCARTÁVEL');

function detalhe(extra: Partial<ProdutoDetalhe> = {}): ProdutoDetalhe {
  const v = produtoVazio([], UN);
  return {
    ...(Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, x === '' ? null : x]),
    ) as unknown as ProdutoDetalhe),
    id: ID,
    versao: 3,
    criadoEm: '2026-10-30T12:00:00Z',
    atualizadoEm: '2026-10-30T12:00:00Z',
    atualizadoPorNome: 'MARIA',
    codigo: 50,
    nome: 'CERV LATA 350',
    tipo: 'simples',
    ativo: true,
    controlaEstoque: true,
    unidadeId: UN,
    unidadeSigla: 'UN',
    precoCusto: '2.0000',
    custoMedio: '2.0000',
    markupPct: '0.0000',
    precoVenda: '5.0000',
    categorias: [],
    categoriaPrincipalId: null,
    ean: null,
    codigosBarras: [],
    lojas: [],
    precosQuantidade: [],
    componentes: [],
    relacionados: [],
    grupoPreco: null,
    vasilhame: null,
    usadoEm: [],
    avisos: [],
    avisosCombo: [],
    temMovimento: false,
    ...extra,
  } as ProdutoDetalhe;
}

/** Rotas de referência do formulário; `arvore` é lida a cada chamada (a "Nova categoria" a altera). */
function referencias(arvore: CategoriaNo[]) {
  return [
    ({ url }: { url: URL }) =>
      url.pathname === '/api/referencias/unidades'
        ? { corpo: [{ id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false }] }
        : undefined,
    ({ url }: { url: URL }) =>
      url.pathname === '/api/marcas'
        ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } }
        : undefined,
    ({ url }: { url: URL }) => (url.pathname === '/api/categorias/arvore' ? { corpo: arvore } : undefined),
    ({ url }: { url: URL }) =>
      url.pathname === '/api/grupos-preco-quantidade'
        ? { corpo: { itens: [], total: 0, pagina: 1, tamanho: 'todos' } }
        : undefined,
    ({ url }: { url: URL }) => (url.pathname === '/api/referencias/cfops' ? { corpo: [] } : undefined),
    ({ url }: { url: URL }) =>
      url.pathname === '/api/produtos/tipos-habilitados'
        ? { corpo: { tipos: ['simples', 'materia_prima', 'produzido', 'kit'] } }
        : undefined,
    ({ url }: { url: URL }) =>
      url.pathname === '/api/produtos/preco-volume' ? { corpo: { lojasDesligadas: [] } } : undefined,
  ];
}

/** O input do seletor (o rótulo também nomeia a lista de opções do Select). */
const campoRelacionado = () =>
  screen.getAllByLabelText('Produto relacionado').find((e) => e.tagName === 'INPUT')!;
const campoRelacionadoAsync = async () => {
  await screen.findAllByLabelText('Produto relacionado');
  return campoRelacionado();
};

/** O input do Select de tipo da linha do GELO (o rótulo também nomeia a lista de opções). */
const campoTipoGelo = (tabela: HTMLElement) =>
  within(tabela)
    .getAllByLabelText('Tipo GELO 5KG')
    .find((e) => e.tagName === 'INPUT')!;

/** Escolhe o tipo na lista do próprio Select (as listas das outras linhas e do "Inserir" também têm as opções). */
async function escolherTipoGelo(
  usuario: ReturnType<typeof userEvent.setup>,
  tabela: HTMLElement,
  nome: string,
) {
  const campo = campoTipoGelo(tabela);
  await usuario.click(campo);
  const lista = await waitFor(() => document.getElementById(campo.getAttribute('aria-controls')!)!);
  await usuario.click(within(lista).getByRole('option', { name: nome, hidden: true }));
}

const corpoDoPut = (chamadas: Array<{ metodo: string; url: URL; corpo: unknown }>) =>
  chamadas.find((c) => c.metodo === 'PUT' && c.url.pathname === `/api/produtos/${ID}`)?.corpo as
    Record<string, unknown> | undefined;

describe('categorias em árvore (F2-B12; ERP 8.2.7)', () => {
  it('marca 2 categorias, a primeira vira a principal e a estrela troca; grava as duas com a principal', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([BEBIDAS, CERVEJA, DESTILADOS]),
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Categorias/ }));
    const arvore = await screen.findByTestId('arvore-categorias');
    // Fechada: só a raiz aparece até expandir.
    expect(within(arvore).queryByLabelText('CERVEJA')).toBeNull();
    await usuario.click(within(arvore).getByRole('button', { name: 'Expandir BEBIDAS' }));
    await usuario.click(within(arvore).getByLabelText('CERVEJA'));
    expect(within(arvore).getByRole('button', { name: 'Principal: CERVEJA' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await usuario.click(within(arvore).getByLabelText('DESTILADOS'));
    const estrelaDestilados = within(arvore).getByRole('button', { name: 'Principal: DESTILADOS' });
    expect(estrelaDestilados).toHaveAttribute('aria-pressed', 'false');
    await usuario.click(estrelaDestilados);
    expect(estrelaDestilados).toHaveAttribute('aria-pressed', 'true');
    expect(within(arvore).getByText(/Principal: BEBIDAS › DESTILADOS/)).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    expect(corpoDoPut(chamadas)).toMatchObject({
      categorias: [CERVEJA.id, DESTILADOS.id],
      categoriaPrincipalId: DESTILADOS.id,
    });
  }, 30_000);

  it('desmarcar a principal passa a estrela para a próxima marcada', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([BEBIDAS, CERVEJA, DESTILADOS]),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? { corpo: detalhe({ categorias: [CERVEJA.id, DESTILADOS.id], categoriaPrincipalId: CERVEJA.id }) }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Categorias/ }));
    const arvore = await screen.findByTestId('arvore-categorias');
    // Abre já expandido até as marcadas.
    expect(within(arvore).getByLabelText('CERVEJA')).toBeChecked();
    await usuario.click(within(arvore).getByLabelText('CERVEJA'));
    expect(within(arvore).getByRole('button', { name: 'Principal: DESTILADOS' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }, 30_000);

  it('"Nova categoria" cria pela API e já a marca', async () => {
    const usuario = userEvent.setup();
    const arvore = [BEBIDAS];
    const NOVA = no('0190a000-0000-7000-8000-000000000b09', 'PETISCOS', null, 'PETISCOS', 1);
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias(arvore),
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
      ({ url, metodo }) => {
        if (url.pathname !== '/api/categorias' || metodo !== 'POST') return undefined;
        arvore.push(NOVA);
        return { status: 201, corpo: NOVA };
      },
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Categorias/ }));
    await usuario.click(await screen.findByRole('button', { name: 'Nova categoria' }));
    const modal = await screen.findByRole('dialog');
    await usuario.type(within(modal).getByLabelText(/^Nome/), 'PETISCOS');
    await usuario.click(within(modal).getByRole('button', { name: 'Criar e marcar' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('arvore-categorias')).getByLabelText('PETISCOS')).toBeChecked(),
    );
    expect(
      chamadas.find((c) => c.metodo === 'POST' && c.url.pathname === '/api/categorias')?.corpo,
    ).toMatchObject({ nome: 'PETISCOS', categoriaPaiId: null });
  }, 30_000);
});

describe('produtos relacionados (F2-B12; ERP 8.2.8)', () => {
  it('mostra a relação nos dois sentidos, insere com "Criar relação inversa", remove e grava a lista inteira', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? {
              corpo: detalhe({
                relacionados: [
                  {
                    id: '0190a000-0000-7000-8000-0000000000d1',
                    relacionadoId: GELO.id,
                    tipo: 'sugestao',
                    ordem: 1,
                    inversa: true,
                    produto: GELO,
                  },
                ],
              }),
            }
          : undefined,
      ({ url }) => (url.pathname === '/api/produtos/busca' ? { corpo: [COPO] } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Produtos relacionados/ }));
    const tabela = await screen.findByTestId('relacionados');
    expect(within(tabela).getByText(/GELO 5KG/)).toBeInTheDocument();
    expect(within(tabela).getByText('Nos dois sentidos')).toBeInTheDocument();

    await usuario.type(campoRelacionado(), 'copo');
    await usuario.click(
      await screen.findByRole('option', { name: '15 - COPO DESCARTÁVEL', hidden: true }, { timeout: 3000 }),
    );
    const blocoInserir = screen.getByRole('button', { name: 'Inserir' }).parentElement!;
    await usuario.click(within(blocoInserir).getByLabelText('Criar relação inversa'));
    await usuario.click(screen.getByRole('button', { name: 'Inserir' }));
    expect(within(tabela).getByText(/COPO DESCARTÁVEL/)).toBeInTheDocument();
    await usuario.click(within(tabela).getByRole('button', { name: 'Remover GELO 5KG' }));
    expect(within(tabela).queryByText(/GELO 5KG/)).toBeNull();

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    expect(corpoDoPut(chamadas)!.relacionados).toEqual([
      { id: null, relacionadoId: COPO.id, tipo: 'sugestao', ordem: 1, criarInversa: true },
    ]);
  }, 30_000);

  const comGelo = (inversa: boolean) => ({
    corpo: detalhe({
      relacionados: [
        {
          id: '0190a000-0000-7000-8000-0000000000d1',
          relacionadoId: GELO.id,
          tipo: 'sugestao',
          ordem: 1,
          inversa,
          produto: GELO,
        },
      ],
    }),
  });

  it('trocar o tipo de uma linha "Nos dois sentidos" volta a oferecer a inversa (a gravada é do tipo antigo)', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? comGelo(true) : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Produtos relacionados/ }));
    const tabela = await screen.findByTestId('relacionados');
    expect(within(tabela).getByText('Nos dois sentidos')).toBeInTheDocument();
    await escolherTipoGelo(usuario, tabela, 'Acessório');
    expect(within(tabela).queryByText('Nos dois sentidos')).toBeNull();
    await usuario.click(within(tabela).getByLabelText('Criar relação inversa'));
    // Voltar ao tipo gravado mostra de novo o selo.
    await escolherTipoGelo(usuario, tabela, 'Sugestão');
    expect(within(tabela).getByText('Nos dois sentidos')).toBeInTheDocument();
    await escolherTipoGelo(usuario, tabela, 'Acessório');

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    expect(corpoDoPut(chamadas)!.relacionados).toEqual([
      {
        id: '0190a000-0000-7000-8000-0000000000d1',
        relacionadoId: GELO.id,
        tipo: 'acessorio',
        ordem: 1,
        criarInversa: true,
      },
    ]);
  }, 30_000);

  it('sem produtos.editar não oferece "Criar relação inversa" (altera o outro produto)', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES.filter((p) => p !== 'produtos.editar'), lojas: LOJAS }),
      ...referencias([]),
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? comGelo(false) : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Produtos relacionados/ }));
    const tabela = await screen.findByTestId('relacionados');
    expect(within(tabela).getByText('Só neste sentido')).toBeInTheDocument();
    expect(screen.queryByLabelText('Criar relação inversa')).toBeNull();
  }, 30_000);

  it('mostra o erro da lista inteira (teto de relacionados) e o da inversa recusada pela API', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ({ url, metodo }) =>
        url.pathname === `/api/produtos/${ID}` && metodo === 'PUT'
          ? {
              status: 422,
              corpo: {
                codigo: 'VALIDACAO',
                mensagem: 'Verifique os campos destacados.',
                campos: {
                  relacionados: ['No máximo 50 produtos relacionados'],
                  'relacionados.0.criarInversa': ['O produto 14 - GELO 5KG já tem 50 produtos relacionados'],
                },
              },
            }
          : undefined,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? comGelo(false) : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Produtos relacionados/ }));
    const tabela = await screen.findByTestId('relacionados');
    await usuario.click(within(tabela).getByLabelText('Criar relação inversa'));
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByText('No máximo 50 produtos relacionados')).toBeInTheDocument();
    expect(
      within(tabela).getByText('O produto 14 - GELO 5KG já tem 50 produtos relacionados'),
    ).toBeInTheDocument();
  }, 30_000);

  it('não deixa inserir o mesmo produto com o mesmo tipo', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? {
              corpo: detalhe({
                relacionados: [
                  {
                    id: '0190a000-0000-7000-8000-0000000000d1',
                    relacionadoId: COPO.id,
                    tipo: 'sugestao',
                    ordem: 1,
                    inversa: false,
                    produto: COPO,
                  },
                ],
              }),
            }
          : undefined,
      ({ url }) => (url.pathname === '/api/produtos/busca' ? { corpo: [COPO] } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Produtos relacionados/ }));
    await usuario.type(await campoRelacionadoAsync(), 'copo');
    await usuario.click(
      await screen.findByRole('option', { name: '15 - COPO DESCARTÁVEL', hidden: true }, { timeout: 3000 }),
    );
    await usuario.click(screen.getByRole('button', { name: 'Inserir' }));
    expect(screen.getByText('COPO DESCARTÁVEL já está na lista como Sugestão')).toBeInTheDocument();
    expect(within(screen.getByTestId('relacionados')).getAllByText(/COPO DESCARTÁVEL/)).toHaveLength(1);
  }, 30_000);
});

describe('"Ajustar" do bloco Estoque (F2-B12; ERP 8.2.11)', () => {
  const saldos = (quantidade: string): SaldosProduto => ({
    combo: false,
    montaveis: [],
    lotes: [],
    saldos: [
      {
        estoqueId: ESTOQUE,
        estoqueNome: 'Estoque Loja 1',
        tipoEstoqueId: DISPONIVEL,
        tipoEstoqueNome: 'Disponível',
        vendavel: true,
        quantidade,
        emTransito: '0.000',
        divergenciaATratar: '0.000',
        custoMedio: '2.0000',
        ultimaEntradaEm: null,
        ultimaSaidaEm: null,
      },
    ],
  });
  const rotasEstoque = [
    ({ url }: { url: URL }) =>
      url.pathname === '/api/estoques'
        ? {
            corpo: {
              itens: [
                {
                  id: ESTOQUE,
                  codigo: 1,
                  nome: 'Estoque Loja 1',
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
              {
                id: DISPONIVEL,
                nome: 'Disponível',
                vendavel: true,
                padrao: true,
                ativo: true,
                chaveSistema: 'disponivel',
                versao: 1,
              },
            ],
          }
        : undefined,
  ];

  it('"Em trânsito" e "Divergência a tratar" (F2-B26): 60 a caminho da Loja 2 sem saldo lançado e 10 a tratar no CD', async () => {
    const usuario = userEvent.setup();
    const LOJA2 = '0190a000-0000-7000-8000-0000000000e5';
    const CD = '0190a000-0000-7000-8000-0000000000e6';
    const base = saldos('40.000').saldos[0]!;
    const comPendencias: SaldosProduto = {
      ...saldos('0'),
      saldos: [
        { ...base, estoqueId: CD, estoqueNome: 'CD - Estoque Ice Beer', divergenciaATratar: '10.000' },
        {
          ...base,
          estoqueId: LOJA2,
          estoqueNome: 'Estoque Loja 2',
          quantidade: '0.000',
          emTransito: '60.000',
          custoMedio: '0',
        },
      ],
    };
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ...rotasEstoque,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
      ({ url }) => (url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: comPendencias } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    const loja2 = (await screen.findByText('Estoque Loja 2')).closest('tr')!;
    const cd = screen.getByText('CD - Estoque Ice Beer').closest('tr')!;
    expect(screen.getByRole('columnheader', { name: 'Em trânsito' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Divergência a tratar' })).toBeInTheDocument();
    expect(within(loja2).getByTestId('em-transito')).toHaveTextContent('60');
    expect(within(cd).getByTestId('em-transito')).toHaveTextContent('—');
    expect(within(cd).getByText('10')).toBeInTheDocument();
  }, 30_000);

  it('sem divergência, a coluna "Divergência a tratar" não aparece; o "Em trânsito" sempre', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ...rotasEstoque,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
      ({ url }) => (url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: saldos('4.000') } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    expect(await screen.findByRole('columnheader', { name: 'Em trânsito' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Divergência a tratar' })).toBeNull();
  }, 30_000);

  const rotasVerMovimentacao = (permissoes: string[]) => [
    ...rotasSessao({ permissoes, lojas: LOJAS }),
    ...referencias([]),
    ...rotasEstoque,
    ({ url }: { url: URL }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
    ({ url }: { url: URL }) =>
      url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: saldos('4.000') } : undefined,
  ];

  it('"Ver movimentação" (F2-B33) em cada linha leva o estoque, o produto e os últimos 30 dias', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasVerMovimentacao([...PERMISSOES, 'relatorios.movimentacao_estoque']));
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    const link = await screen.findByRole('link', { name: /^Ver movimentação em Estoque Loja 1/ });
    const href = new URL(link.getAttribute('href')!, 'http://erp');
    expect(href.pathname).toBe('/relatorios/movimentacao-estoque');
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    expect(Object.fromEntries(href.searchParams)).toMatchObject({
      estoqueId: saldos('4.000').saldos[0]!.estoqueId,
      produtoId: ID,
      dataFinal: hoje,
      gerado: '1',
    });
    const dias = (Date.parse(hoje) - Date.parse(href.searchParams.get('dataInicial')!)) / 86_400_000;
    expect(dias).toBe(29);
  }, 30_000);

  it('sem relatorios.movimentacao_estoque, o bloco Estoque não tem o "Ver movimentação"', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasVerMovimentacao(PERMISSOES));
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    expect(await screen.findByRole('columnheader', { name: 'Em trânsito' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ver movimentação/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Movimentação' })).toBeNull();
  }, 30_000);

  it('ajusta a nova quantidade da Loja 1: um POST com estoque, tipo padrão e motivo (hora: a da API)', async () => {
    const usuario = userEvent.setup();
    let atual = '4.000';
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ...rotasEstoque,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
      ({ url }) => (url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: saldos(atual) } : undefined),
      ({ url, metodo }) => {
        if (url.pathname !== `/api/produtos/${ID}/ajustar-estoque` || metodo !== 'POST') return undefined;
        atual = '12.000';
        return {
          corpo: { acertoId: 'a1', codigo: 77, diferenca: '8.000', movimentos: 1, compensacoes: 0 },
        };
      },
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    await usuario.click(await screen.findByRole('button', { name: 'Ajustar' }));
    const modal = await screen.findByRole('dialog');
    expect(await within(modal).findByTestId('saldo-atual-ajuste')).toHaveTextContent('Saldo atual: 4');
    await usuario.type(within(modal).getByLabelText(/^Nova quantidade/), '12');
    await usuario.type(within(modal).getByLabelText(/^Motivo/), 'Inventário');
    await usuario.click(within(modal).getByRole('button', { name: 'Ajustar' }));
    expect(await screen.findByText(/Acerto Nº 77 efetivado: \+8 na contagem/)).toBeInTheDocument();
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/ajustar-estoque'));
    expect(post?.corpo).toMatchObject({
      estoqueId: ESTOQUE,
      tipoEstoqueId: DISPONIVEL,
      quantidade: '12.000',
      motivo: 'Inventário',
    });
    // Sem mexer na hora, ela não vai: "agora" é o instante em que a API recebe.
    expect(post!.corpo).not.toHaveProperty('dataContagem');
    // O saldo do bloco é recarregado.
    await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());
  }, 30_000);

  it('a hora da contagem é a da abertura do modal, não a da montagem do bloco nem a do último fechamento', async () => {
    // Só o Date é falso: o userEvent e o react-query seguem com os timers reais.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 10, 5, 9, 0, 0));
      const usuario = userEvent.setup();
      simularApi(
        ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
        ...referencias([]),
        ...rotasEstoque,
        ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
        ({ url }) => (url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: saldos('4.000') } : undefined),
      );
      renderizar(`/produtos/${ID}`);
      await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
      await screen.findByRole('button', { name: 'Ajustar' });
      // O bloco montou às 09:00; o usuário só abre o Ajustar às 11:00.
      vi.setSystemTime(new Date(2026, 10, 5, 11, 0, 0));
      await usuario.click(screen.getByRole('button', { name: 'Ajustar' }));
      let modal = await screen.findByRole('dialog');
      expect(within(modal).getByText('05/11/2026 11:00')).toBeInTheDocument();
      expect(within(modal).queryByText('05/11/2026 09:00')).toBeNull();
      await usuario.click(within(modal).getByRole('button', { name: 'Cancelar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      // Fechou às 11:00 e reabre às 11:40: vale a reabertura.
      vi.setSystemTime(new Date(2026, 10, 5, 11, 40, 0));
      await usuario.click(screen.getByRole('button', { name: 'Ajustar' }));
      modal = await screen.findByRole('dialog');
      expect(within(modal).getByText('05/11/2026 11:40')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('o estoque padrão é um dos que estão nas opções (o saldo de estoque inativo não entra)', async () => {
    const usuario = userEvent.setup();
    const INATIVO = '0190a000-0000-7000-8000-0000000000e9';
    const comInativo = saldos('4.000');
    comInativo.saldos.unshift({
      ...comInativo.saldos[0]!,
      estoqueId: INATIVO,
      estoqueNome: 'CD Antigo',
      quantidade: '7.000',
    });
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ...rotasEstoque,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
      ({ url }) => (url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: comInativo } : undefined),
      ({ url, metodo }) =>
        url.pathname === `/api/produtos/${ID}/ajustar-estoque` && metodo === 'POST'
          ? { corpo: { acertoId: 'a1', codigo: 78, diferenca: '1.000', movimentos: 1, compensacoes: 0 } }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    await usuario.click(await screen.findByRole('button', { name: 'Ajustar' }));
    const modal = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(modal)
          .getAllByLabelText(/^Estoque/)
          .find((e) => e.tagName === 'INPUT'),
      ).toHaveValue('Estoque Loja 1'),
    );
    expect(within(modal).getByTestId('saldo-atual-ajuste')).toHaveTextContent('Saldo atual: 4');
    await usuario.type(within(modal).getByLabelText(/^Nova quantidade/), '5');
    await usuario.type(within(modal).getByLabelText(/^Motivo/), 'Inventário');
    await usuario.click(within(modal).getByRole('button', { name: 'Ajustar' }));
    await screen.findByText(/Acerto Nº 78 efetivado/);
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.pathname.endsWith('/ajustar-estoque'));
    expect(post?.corpo).toMatchObject({ estoqueId: ESTOQUE });
  }, 30_000);

  it('valida o modal sem chamar a API (quantidade e motivo)', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ...rotasEstoque,
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
      ({ url }) => (url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: saldos('4.000') } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    await usuario.click(await screen.findByRole('button', { name: 'Ajustar' }));
    const modal = await screen.findByRole('dialog');
    await usuario.click(within(modal).getByRole('button', { name: 'Ajustar' }));
    expect(within(modal).getByText('Informe o motivo')).toBeInTheDocument();
    expect(within(modal).getByText('Quantidade inválida')).toBeInTheDocument();
    expect(chamadas.some((c) => c.url.pathname.endsWith('/ajustar-estoque'))).toBe(false);
  }, 30_000);

  it('produzido não tem o botão (ajusta os insumos); sem estoque_acertos.criar também não', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias([]),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? { corpo: detalhe({ tipo: 'produzido', usaFichaTecnica: true }) }
          : undefined,
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}/saldos`
          ? { corpo: { combo: false, saldos: [], montaveis: [] } }
          : undefined,
    );
    const { unmount } = renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    expect(
      await screen.findByText(
        'Produto produzido não tem estoque próprio: ajuste os insumos da ficha técnica.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ajustar' })).toBeNull();
    unmount();
    vi.unstubAllGlobals();

    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES.filter((p) => p !== 'estoque_acertos.criar'), lojas: LOJAS }),
      ...referencias([]),
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
      ({ url }) => (url.pathname === `/api/produtos/${ID}/saldos` ? { corpo: saldos('4.000') } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Estoque/ }));
    expect(await screen.findByText('Estoque Loja 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ajustar' })).toBeNull();
  }, 30_000);
});
