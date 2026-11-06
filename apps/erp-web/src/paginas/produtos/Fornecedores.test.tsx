/**
 * Bloco Fornecedores do produto e cadastro rápido de fornecedor (F2-B13; ERP 3.4, 8.2.14, 13.3): escondido sem
 * `geral.produto_usa_fornecedores` (e o corpo não leva a lista), o vínculo com o código no fornecedor e o fator, o
 * 409 do código já ligado a outro produto com "Mover o vínculo", o "+" do seletor com o cadastro rápido e o custo do
 * fornecedor levado ao preço de custo.
 */
import type { DetalhesConflitoFornecedor, PessoaOpcao, PessoaResumo, ProdutoDetalhe } from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvedorSessao, useSessao } from '../../auth/sessao';
import { renderizarRotas, rotasSessao, simularApi } from '../../teste/utilidades';
import { FormularioProduto } from './FormularioProduto';
import { paraCorpo, paraValores, produtoVazio } from './valores';

afterEach(() => vi.unstubAllGlobals());

const UN = '0190a000-0000-7000-8000-0000000000a1';
const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const ID = '0190a000-0000-7000-8000-0000000000c1';
const PERMISSOES = [
  'produtos.ver',
  'produtos.criar',
  'produtos.editar',
  'produtos.ver_custo',
  'pessoas.ver',
  'pessoas.criar',
];
const LOJAS = [{ id: LOJA, codigo: 1, nome: 'Loja 1', ativa: true }];

const FORN_X: PessoaOpcao = {
  id: '0190a000-0000-7000-8000-0000000000b1',
  codigo: 7,
  tipo: 'PJ',
  nome: 'DISTRIBUIDORA X LTDA',
  apelido: 'DISTRIBUIDORA X',
  cpfCnpj: '11222333000181',
  ativa: true,
  excluida: false,
};
const FORN_Y: PessoaOpcao = {
  id: '0190a000-0000-7000-8000-0000000000b2',
  codigo: 8,
  tipo: 'PJ',
  nome: 'BEBIDAS Y',
  apelido: null,
  cpfCnpj: '22333444000150',
  ativa: true,
  excluida: false,
};

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
    markupPct: '150.0000',
    precoVenda: '5.0000',
    categorias: [],
    categoriaPrincipalId: null,
    ean: null,
    codigosBarras: [],
    lojas: [],
    precosQuantidade: [],
    componentes: [],
    relacionados: [],
    fornecedores: [],
    grupoPreco: null,
    vasilhame: null,
    usadoEm: [],
    avisos: [],
    avisosCombo: [],
    temMovimento: false,
    ...extra,
  } as ProdutoDetalhe;
}

const VINCULO_Y = {
  id: '0190a000-0000-7000-8000-0000000000d1',
  fornecedorId: FORN_Y.id,
  fornecedor: FORN_Y,
  codigoFornecedor: 'Y-350',
  eanFornecedor: null,
  unidadeCompra: 'FD',
  fator: '12.000',
  custoFornecedor: '2.4000',
  ultimoCusto: '2.3500',
  ultimaCompraEm: '2026-10-20',
  principal: true,
};

function referencias(usaFornecedores: boolean) {
  return [
    ({ url }: { url: URL }) =>
      url.pathname === '/api/referencias/unidades'
        ? { corpo: [{ id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false }] }
        : undefined,
    ({ url }: { url: URL }) =>
      url.pathname === '/api/produtos/tipos-habilitados'
        ? { corpo: { tipos: ['simples', 'materia_prima', 'produzido', 'kit'], usaFornecedores } }
        : undefined,
    ({ url }: { url: URL }) =>
      url.pathname === '/api/produtos/preco-volume' ? { corpo: { lojasDesligadas: [] } } : undefined,
    ({ url }: { url: URL }) => (url.pathname === '/api/referencias/cfops' ? { corpo: [] } : undefined),
  ];
}

const resumo = (p: PessoaOpcao): PessoaResumo => ({
  ...p,
  telefone: null,
  email: null,
  categorias: ['fornecedor'],
  cidade: null,
  uf: null,
  versao: 1,
});

const corpoDoPut = (chamadas: Array<{ metodo: string; url: URL; corpo: unknown }>, n = 0) =>
  chamadas.filter((c) => c.metodo === 'PUT' && c.url.pathname === `/api/produtos/${ID}`)[n]?.corpo as
    Record<string, unknown> | undefined;

const campoFornecedor = () => screen.getAllByLabelText('Fornecedor').find((e) => e.tagName === 'INPUT')!;

describe('bloco Fornecedores do produto (F2-B13; ERP 8.2.14)', () => {
  it('fica escondido sem geral.produto_usa_fornecedores, e o corpo não leva a lista (a API mantém)', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias(false),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? { corpo: detalhe({ fornecedores: [VINCULO_Y] }) }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await screen.findByRole('button', { name: /^Produtos relacionados/ });
    expect(screen.queryByRole('button', { name: /^Fornecedores/ })).toBeNull();
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    expect(corpoDoPut(chamadas)).not.toHaveProperty('fornecedores');
  }, 30_000);

  it('liga o fornecedor X com o código "CX24-ABC" e o fator 24, e grava a lista inteira', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias(true),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? { corpo: detalhe({ fornecedores: [VINCULO_Y] }) }
          : undefined,
      ({ url }) =>
        url.pathname === '/api/pessoas' && url.searchParams.get('categorias') === 'fornecedor'
          ? { corpo: { itens: [resumo(FORN_X)], total: 1, pagina: 1, tamanho: 20 } }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Fornecedores/ }));
    const tabela = await screen.findByTestId('fornecedores');
    // O gravado: último custo e última compra só leitura.
    expect(within(tabela).getByText('8 - BEBIDAS Y')).toBeInTheDocument();
    expect(within(tabela).getByText('R$ 2,35')).toBeInTheDocument();
    expect(within(tabela).getByText('20/10/2026')).toBeInTheDocument();

    await usuario.type(campoFornecedor(), 'distri');
    await usuario.click(
      await screen.findByRole(
        'option',
        { name: /7 - DISTRIBUIDORA X LTDA \(DISTRIBUIDORA X\)/, hidden: true },
        { timeout: 3000 },
      ),
    );
    await usuario.click(screen.getByRole('button', { name: 'Inserir' }));
    await usuario.type(within(tabela).getByLabelText('Código no fornecedor DISTRIBUIDORA X'), 'CX24-ABC');
    await usuario.clear(within(tabela).getByLabelText('Fator DISTRIBUIDORA X'));
    await usuario.type(within(tabela).getByLabelText('Fator DISTRIBUIDORA X'), '24');
    await usuario.type(within(tabela).getByLabelText('Unidade de compra DISTRIBUIDORA X'), 'CX');
    // Só um principal: marcar o X tira a marca do Y.
    await usuario.click(within(tabela).getByLabelText('Principal DISTRIBUIDORA X'));
    expect(within(tabela).getByLabelText('Principal BEBIDAS Y')).not.toBeChecked();

    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    expect(corpoDoPut(chamadas)!.fornecedores).toEqual([
      {
        id: VINCULO_Y.id,
        fornecedorId: FORN_Y.id,
        codigoFornecedor: 'Y-350',
        eanFornecedor: null,
        unidadeCompra: 'FD',
        fator: '12',
        custoFornecedor: '2,4',
        principal: false,
        moverVinculo: false,
      },
      {
        id: null,
        fornecedorId: FORN_X.id,
        codigoFornecedor: 'CX24-ABC',
        eanFornecedor: null,
        unidadeCompra: 'CX',
        fator: '24',
        custoFornecedor: null,
        principal: true,
        moverVinculo: false,
      },
    ]);
  }, 30_000);

  it('o 409 do código ligado a outro produto cai na linha, e "Mover o vínculo" regrava com moverVinculo', async () => {
    const conflito = {
      linha: 0,
      fornecedorId: FORN_Y.id,
      codigoFornecedor: 'Y-350',
      produto: { id: '0190a000-0000-7000-8000-0000000000c2', codigo: 12, nome: 'CERV GARRAFA' },
    };
    // O formato real da API (README da API › decisão 158): o primeiro conflito e a lista de todos.
    const CONFLITO_Y: DetalhesConflitoFornecedor = { ...conflito, conflitos: [conflito] };
    const usuario = userEvent.setup();
    let puts = 0;
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias(true),
      ({ url, metodo }) => {
        if (url.pathname !== `/api/produtos/${ID}`) return undefined;
        if (metodo === 'PUT' && puts++ === 0)
          return {
            status: 409,
            corpo: {
              codigo: 'CONFLITO',
              mensagem: 'O código "Y-350" deste fornecedor já está ligado ao produto 12 - CERV GARRAFA.',
              campos: { 'fornecedores.0.codigoFornecedor': ['Já ligado ao produto 12 - CERV GARRAFA'] },
              detalhes: CONFLITO_Y,
            },
          };
        return { corpo: detalhe({ fornecedores: [VINCULO_Y] }) };
      },
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Fornecedores/ }));
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    expect(await screen.findByText('Já ligado ao produto 12 - CERV GARRAFA')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: 'Mover o vínculo para este produto' }));
    expect(screen.getByText('Sai do outro produto ao gravar')).toBeInTheDocument();
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas, 1)).toBeDefined());
    expect(corpoDoPut(chamadas, 1)!.fornecedores).toMatchObject([
      { codigoFornecedor: 'Y-350', moverVinculo: true },
    ]);
  }, 30_000);

  it('"Usar como preço de custo" leva o custo do fornecedor ao preço de custo e recalcula o markup', async () => {
    const usuario = userEvent.setup();
    simularApi(...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }), ...referencias(true), ({ url }) =>
      url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe({ fornecedores: [VINCULO_Y] }) } : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Fornecedores/ }));
    await usuario.click(
      await screen.findByRole('button', { name: 'Usar o custo de BEBIDAS Y como preço de custo' }),
    );
    expect(screen.getByLabelText(/^Preço de custo/)).toHaveValue('2,4');
    // (5 − 2,40) / 2,40 = 108,33%
    expect(screen.getByLabelText(/^Markup/)).toHaveValue('108,3333');
  }, 30_000);

  it('o fornecedor excluído depois do vínculo aparece com o selo e a linha volta inteira no PUT', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias(true),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? {
              corpo: detalhe({
                fornecedores: [{ ...VINCULO_Y, fornecedor: { ...FORN_Y, cpfCnpj: null, excluida: true } }],
              }),
            }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Fornecedores/ }));
    const tabela = await screen.findByTestId('fornecedores');
    expect(within(tabela).getByText('excluído')).toBeInTheDocument();
    expect(within(tabela).queryByText('inativo')).toBeNull();
    await usuario.click(screen.getByRole('button', { name: /Salvar/ }));
    await waitFor(() => expect(corpoDoPut(chamadas)).toBeDefined());
    expect(corpoDoPut(chamadas)!.fornecedores).toMatchObject([
      { id: VINCULO_Y.id, fornecedorId: FORN_Y.id, codigoFornecedor: 'Y-350' },
    ]);
  }, 30_000);

  it('sem produtos.ver_custo não mostra os custos do fornecedor', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES.filter((p) => p !== 'produtos.ver_custo'), lojas: LOJAS }),
      ...referencias(true),
      ({ url }) =>
        url.pathname === `/api/produtos/${ID}`
          ? { corpo: detalhe({ fornecedores: [{ ...VINCULO_Y, custoFornecedor: null, ultimoCusto: null }] }) }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Fornecedores/ }));
    const tabela = await screen.findByTestId('fornecedores');
    expect(within(tabela).queryByText('Custo do fornecedor')).toBeNull();
    expect(within(tabela).queryByText('Último custo')).toBeNull();
  }, 30_000);
});

describe('cadastro rápido de fornecedor (F2-B13; ERP 3.4)', () => {
  it('o "+" do seletor cadastra pelo CNPJ e já escolhe o fornecedor; o já cadastrado é avisado', async () => {
    const usuario = userEvent.setup();
    const { chamadas } = simularApi(
      ...rotasSessao({ permissoes: PERMISSOES, lojas: LOJAS }),
      ...referencias(true),
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
      ({ url, metodo }) =>
        url.pathname === '/api/pessoas/fornecedor-rapido' && metodo === 'POST'
          ? { corpo: { pessoa: FORN_X, criada: false, categoriaAdicionada: true } }
          : undefined,
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Fornecedores/ }));
    await usuario.click(await screen.findByRole('button', { name: 'Cadastro rápido de fornecedor' }));
    const modal = await screen.findByRole('dialog');
    // Validação local antes da API: CNPJ com DV errado.
    await usuario.type(within(modal).getByLabelText(/^CNPJ ou CPF/), '11.222.333/0001-80');
    await usuario.type(within(modal).getByLabelText(/^Nome/), 'Distribuidora X Ltda');
    await usuario.click(within(modal).getByRole('button', { name: 'Gravar' }));
    expect(await within(modal).findByText('CNPJ inválido')).toBeInTheDocument();
    expect(chamadas.some((c) => c.url.pathname === '/api/pessoas/fornecedor-rapido')).toBe(false);

    await usuario.clear(within(modal).getByLabelText(/^CNPJ ou CPF/));
    await usuario.type(within(modal).getByLabelText(/^CNPJ ou CPF/), '11.222.333/0001-81');
    await usuario.click(within(modal).getByRole('button', { name: 'Gravar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(chamadas.find((c) => c.url.pathname === '/api/pessoas/fornecedor-rapido')?.corpo).toMatchObject({
      cpfCnpj: '11.222.333/0001-81',
      nome: 'Distribuidora X Ltda',
      endereco: null,
    });
    expect(await screen.findByText(/já era cadastrado: passou a ser fornecedor/)).toBeInTheDocument();
    expect(campoFornecedor()).toHaveValue('7 - DISTRIBUIDORA X LTDA (DISTRIBUIDORA X) · 11.222.333/0001-81');
    await usuario.click(screen.getByRole('button', { name: 'Inserir' }));
    expect(
      within(screen.getByTestId('fornecedores')).getByText('7 - DISTRIBUIDORA X LTDA'),
    ).toBeInTheDocument();
  }, 30_000);

  it('só com pessoas.criar_fornecedor (o Estoquista; dono, 05/11/2026) o "+" aparece', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({
        permissoes: [...PERMISSOES.filter((p) => p !== 'pessoas.criar'), 'pessoas.criar_fornecedor'],
        lojas: LOJAS,
      }),
      ...referencias(true),
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Fornecedores/ }));
    await screen.findAllByLabelText('Fornecedor');
    expect(screen.getAllByRole('button', { name: 'Cadastro rápido de fornecedor' }).length).toBeGreaterThan(
      0,
    );
  }, 30_000);

  it('sem pessoas.criar, pessoas.criar_fornecedor nem pessoas.editar o "+" não aparece', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...rotasSessao({ permissoes: PERMISSOES.filter((p) => p !== 'pessoas.criar'), lojas: LOJAS }),
      ...referencias(true),
      ({ url }) => (url.pathname === `/api/produtos/${ID}` ? { corpo: detalhe() } : undefined),
    );
    renderizar(`/produtos/${ID}`);
    await usuario.click(await screen.findByRole('button', { name: /^Fornecedores/ }));
    await screen.findAllByLabelText('Fornecedor');
    expect(screen.queryByRole('button', { name: 'Cadastro rápido de fornecedor' })).toBeNull();
  }, 30_000);
});

describe('valores do bloco Fornecedores (F2-B13)', () => {
  const comDois = detalhe({
    fornecedores: [
      VINCULO_Y,
      {
        ...VINCULO_Y,
        id: '0190a000-0000-7000-8000-0000000000d2',
        codigoFornecedor: 'Y-CX24',
        principal: false,
      },
      {
        ...VINCULO_Y,
        id: '0190a000-0000-7000-8000-0000000000d3',
        fornecedorId: FORN_X.id,
        fornecedor: FORN_X,
      },
    ],
  });

  it('duplicar copia um vínculo por fornecedor, sem código, EAN, ids nem histórico de compra', () => {
    const v = paraValores(comDois, [], true);
    expect(v.fornecedores).toMatchObject([
      {
        id: null,
        fornecedorId: FORN_Y.id,
        codigoFornecedor: '',
        fator: '12',
        principal: true,
        ultimoCusto: null,
      },
      { id: null, fornecedorId: FORN_X.id, codigoFornecedor: '', ultimaCompraEm: null },
    ]);
  });

  it('o corpo só leva a lista com o bloco visível', () => {
    const v = paraValores(comDois, []);
    expect(paraCorpo(v)).not.toHaveProperty('fornecedores');
    expect(paraCorpo(v, { comFornecedores: true }).fornecedores).toHaveLength(3);
  });
});
