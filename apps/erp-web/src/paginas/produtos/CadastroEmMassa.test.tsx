/**
 * Cadastro em massa por estoque (ERP 8.3; F2-B39): as contas da linha (markup ⇄ preço, a marca pelo nome, a
 * Atualização pelo "Pesquisar EAN", a validação por linha e o corpo da API) e a tela: o EAN já cadastrado vira
 * "Atualização" em azul ao sair do campo, a linha nova com a marca nova, o Gravar com o corpo da grade e o resultado
 * com os links; os erros da API voltam à linha (com o número da linha da grade); Limpar esvazia a grade; a colagem do
 * Excel pesquisa os EANs e mantém os preços colados; sem o acerto, a colagem não preenche o estoque escondido. A linha
 * só de estoque manda nulo no cadastro (o custo de 4 casas não se arredonda; a marca gravada sem "Marcas: Ver"). EAN e
 * nomes inventados.
 */
import {
  calcularDvGtin,
  type MarcaResumo,
  type ProdutoEanCadastroMassa,
  type ResultadoCadastroMassa,
} from '@genesis/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderizarComSessao, rotasSessao, simularApi } from '../../teste/utilidades';
import { CadastroEmMassa } from './CadastroEmMassa';
import {
  alterarPreco,
  aplicarPesquisa,
  errosLinhaMassa,
  linhaParaApi,
  novaLinhaMassa,
  type ContextoLinhaMassa,
} from './cadastroMassa';

afterEach(() => vi.unstubAllGlobals());

const ean = (n: number) => {
  const b = `78998${String(n).padStart(7, '0')}`;
  return `${b}${calcularDvGtin(b)}`;
};
const EAN_EXISTENTE = ean(1);
const EAN_NOVO = ean(2);

const UN = '0190a000-0000-7000-8000-0000000000a1';
const KG = '0190a000-0000-7000-8000-0000000000a2';
const ESTOQUE = '0190a000-0000-7000-8000-0000000000e1';
const CD = '0190a000-0000-7000-8000-0000000000e2';
const LOJA = '0190a000-0000-7000-8000-0000000000f1';
const PRODUTO = '0190a000-0000-7000-8000-000000000011';
const MARCA = '0190a000-0000-7000-8000-0000000000b1';
const CATEGORIA = '0190a000-0000-7000-8000-0000000000c1';

const MARCAS: MarcaResumo[] = [
  {
    id: MARCA,
    codigo: 1,
    descricao: 'Cervejaria Ficticia',
    semMarca: false,
    exibeSite: false,
    ordem: 0,
    produtos: 3,
    versao: 1,
  },
];

const ACHADO: ProdutoEanCadastroMassa = {
  id: PRODUTO,
  codigo: 11,
  nome: 'CERV FICTICIA PILSEN LT 350ML',
  versao: 42,
  tipo: 'simples',
  ativo: true,
  unidadeId: UN,
  unidadeSigla: 'UN',
  permiteFracao: false,
  ncm: '22030000',
  marcaId: MARCA,
  marcaNome: 'Cervejaria Ficticia',
  categoriaId: CATEGORIA,
  precoCusto: '2.0000',
  markupPct: '75.0000',
  precoVenda: '3.5000',
  estoqueMinimo: '6.000',
  variacao: false,
  fator: '1.000',
  temEstoqueProprio: true,
};

const CTX: ContextoLinhaMassa = {
  marcas: MARCAS,
  podeCriarMarca: true,
  estoqueTemLoja: true,
  fracaoDaUnidade: (id) => id === KG,
};

describe('linhas do cadastro em massa', () => {
  it('a pesquisa que acha o produto vira Atualização com os valores gravados; a que não acha volta a linha nova limpa', () => {
    const l = { ...novaLinhaMassa(UN), ean: EAN_EXISTENTE };
    const atualizacao = aplicarPesquisa(l, [ACHADO], UN);
    expect(atualizacao).toMatchObject({
      situacao: 'atualizacao',
      pesquisado: EAN_EXISTENTE,
      nome: 'CERV FICTICIA PILSEN LT 350ML',
      marca: 'Cervejaria Ficticia',
      precoCusto: '2,00',
      markupPct: '75',
      precoVenda: '3,50',
      estoqueMinimo: '6',
    });
    // O mesmo produto de novo (outro estoque): o digitado fica, o estoque mínimo é o da loja nova.
    const editada = { ...atualizacao, precoVenda: '3,99' };
    expect(aplicarPesquisa(editada, [{ ...ACHADO, estoqueMinimo: null }], UN)).toMatchObject({
      precoVenda: '3,99',
      estoqueMinimo: '',
    });
    const outra = aplicarPesquisa({ ...atualizacao, ean: EAN_NOVO }, [], UN);
    expect(outra).toMatchObject({ situacao: 'novo', nome: '', precoVenda: '', unidadeId: UN, ean: EAN_NOVO });
    // Ao deixar de ser Atualização, o que o usuário digitou fica; só sai o que a pesquisa trouxe.
    expect(aplicarPesquisa({ ...editada, ean: EAN_NOVO }, [], UN)).toMatchObject({
      situacao: 'novo',
      nome: '',
      precoVenda: '3,99',
      gravados: null,
    });
    expect(aplicarPesquisa(l, [ACHADO, { ...ACHADO, id: 'x' }]).situacao).toBe('duplicado');
    expect(aplicarPesquisa(l, [{ ...ACHADO, variacao: true }]).situacao).toBe('variacao');
  });

  it('markup ⇄ preço: o markup refaz o preço, o preço refaz o markup e o custo refaz o preço pelo markup', () => {
    const l = novaLinhaMassa(UN);
    const comCusto = alterarPreco(l, 'precoCusto', '4,00');
    expect(alterarPreco(comCusto, 'markupPct', '50').precoVenda).toBe('6,00');
    expect(alterarPreco(comCusto, 'precoVenda', '5').markupPct).toBe('25');
    const comMarkup = alterarPreco(alterarPreco(comCusto, 'markupPct', '50'), 'precoCusto', '10');
    expect(comMarkup.precoVenda).toBe('15,00');
    // Sem custo, não há markup.
    expect(alterarPreco(l, 'precoVenda', '5').markupPct).toBe('');
  });

  it('valida por linha: o novo exige nome, unidade e preço; o EAN precisa da pesquisa; o estoque inteiro sem fração', () => {
    const l = { ...novaLinhaMassa(UN), ean: EAN_NOVO, estoque: '1,5', estoqueMinimo: '2' };
    expect(errosLinhaMassa(l, CTX)).toMatchObject({
      ean: expect.stringMatching(/Pesquise o EAN/),
      nome: 'Informe o nome',
      precoVenda: 'Informe o preço de venda',
      estoque: 'Sem fração: quantidade inteira',
    });
    const pronta = { ...l, nome: 'AGUA FICTICIA 500ML', precoVenda: '2', estoque: '3', pesquisado: EAN_NOVO };
    expect(errosLinhaMassa({ ...pronta, situacao: 'novo' }, CTX)).toEqual({});
    expect(errosLinhaMassa({ ...pronta, situacao: 'novo' }, { ...CTX, estoqueTemLoja: false })).toEqual({
      estoqueMinimo: 'O estoque não é de uma loja: o mínimo é por loja',
    });
    expect(
      errosLinhaMassa(
        { ...pronta, situacao: 'novo', marca: 'Outra marca' },
        { ...CTX, podeCriarMarca: false },
      ).marca,
    ).toMatch(/Marca inexistente/);
    expect(
      errosLinhaMassa({ ...pronta, ean: '7890000000001', pesquisado: '7890000000001' }, CTX).ean,
    ).toMatch(/GTIN inválido/);
  });

  it('o corpo da API: a Atualização com o produto e a versão; a marca existente pelo id e a nova pelo nome', () => {
    const at = aplicarPesquisa({ ...novaLinhaMassa(UN), ean: EAN_EXISTENTE }, [ACHADO], UN);
    // Só o estoque: o cadastro vai nulo (mantém o gravado, sem regravar o produto).
    expect(linhaParaApi({ ...at, estoque: '12' }, CTX)).toEqual({
      produtoId: PRODUTO,
      versao: 42,
      ean: EAN_EXISTENTE,
      nome: null,
      unidadeId: null,
      ncm: null,
      marcaId: null,
      marcaNova: null,
      categoriaId: null,
      precoCusto: null,
      markupPct: null,
      precoVenda: null,
      estoque: '12',
      estoqueMinimo: null,
    });
    // O que mudou desde a pesquisa vai; o resto continua nulo.
    expect(
      linhaParaApi({ ...at, precoVenda: '3,99', estoqueMinimo: '8', marca: 'Marca Nova Ficticia' }, CTX),
    ).toMatchObject({
      nome: null,
      precoCusto: null,
      precoVenda: '3.99',
      estoqueMinimo: '8',
      marcaId: null,
      marcaNova: 'Marca Nova Ficticia',
    });
    const nova = {
      ...novaLinhaMassa(UN),
      ean: EAN_NOVO,
      nome: 'AGUA FICTICIA',
      marca: 'cervejaria ficticía',
      precoVenda: '1.234,50',
    };
    expect(linhaParaApi(nova, CTX)).toMatchObject({ produtoId: null, marcaId: MARCA, precoVenda: '1234.50' });
    expect(linhaParaApi({ ...nova, marca: 'Marca Nova Ficticia' }, CTX)).toMatchObject({
      marcaId: null,
      marcaNova: 'Marca Nova Ficticia',
    });
  });

  it('o custo e o preço gravados com 4 casas aparecem inteiros e a linha só de estoque não os manda (nem arredondados)', () => {
    // O custo de um recebimento (o fardo de 41,48 por 12).
    const achado = { ...ACHADO, precoCusto: '3.4567', markupPct: '73.2900', precoVenda: '5.9900' };
    const at = aplicarPesquisa({ ...novaLinhaMassa(UN), ean: EAN_EXISTENTE }, [achado], UN);
    expect(at).toMatchObject({ precoCusto: '3,4567', markupPct: '73,29', precoVenda: '5,99' });
    expect(linhaParaApi({ ...at, estoque: '24' }, CTX)).toMatchObject({
      precoCusto: null,
      markupPct: null,
      precoVenda: null,
      estoque: '24',
    });
    // Mexido, o custo vai com as casas digitadas.
    expect(linhaParaApi(alterarPreco(at, 'precoCusto', '3,5'), CTX)).toMatchObject({ precoCusto: '3.5' });
  });

  it('a colagem com um EAN já cadastrado: os valores colados ficam e os vazios vêm do gravado', () => {
    const colada = {
      ...novaLinhaMassa(UN),
      ean: EAN_EXISTENTE,
      nome: 'CERV FICTICIA PILSEN LATA 350ML NOVA',
      precoCusto: '2,20',
      precoVenda: '3,96',
      estoque: '48',
    };
    const at = aplicarPesquisa(colada, [ACHADO], UN);
    expect(at).toMatchObject({
      situacao: 'atualizacao',
      nome: 'CERV FICTICIA PILSEN LATA 350ML NOVA',
      precoCusto: '2,20',
      precoVenda: '3,96',
      // O markup gravado (75%) não confere com o custo e o preço colados: sai da conta.
      markupPct: '80',
      ncm: '22030000',
      marca: 'Cervejaria Ficticia',
      categoriaId: CATEGORIA,
      unidadeId: UN,
      estoque: '48',
    });
    expect(linhaParaApi(at, CTX)).toMatchObject({
      produtoId: PRODUTO,
      nome: 'CERV FICTICIA PILSEN LATA 350ML NOVA',
      precoCusto: '2.20',
      precoVenda: '3.96',
      markupPct: '80',
      ncm: null,
      marcaId: null,
      categoriaId: null,
      estoque: '48',
    });
  });

  it('a marca gravada da Atualização vale sem a lista de marcas (sem "Marcas: Ver" nem "Marcas: Criar")', () => {
    const semMarcas = { ...CTX, marcas: [], podeCriarMarca: false };
    const at = aplicarPesquisa({ ...novaLinhaMassa(UN), ean: EAN_EXISTENTE }, [ACHADO], UN);
    const l = { ...at, estoque: '6' };
    expect(errosLinhaMassa(l, semMarcas)).toEqual({});
    expect(linhaParaApi(l, semMarcas)).toMatchObject({ marcaId: null, marcaNova: null });
    // A marca trocada para uma que não existe continua recusada.
    expect(errosLinhaMassa({ ...l, marca: 'Outra Ficticia' }, semMarcas).marca).toMatch(/Marca inexistente/);
  });
});

const RESULTADO: ResultadoCadastroMassa = {
  criados: 1,
  atualizados: 1,
  produtos: [
    { linha: 1, id: PRODUTO, codigo: 11, nome: 'CERV FICTICIA PILSEN LT 350ML', acao: 'atualizado' },
    {
      linha: 2,
      id: '0190a000-0000-7000-8000-000000000012',
      codigo: 12,
      nome: 'AGUA FICTICIA 500ML',
      acao: 'criado',
    },
  ],
  acerto: { id: '0190a000-0000-7000-8000-0000000000d1', codigo: 77, itens: 2, movimentos: 2 },
  marcasCriadas: 1,
};

const PERMISSOES = [
  'produtos.cadastro_massa',
  'produtos.criar',
  'produtos.editar',
  'produtos.ver_custo',
  'estoque_acertos.criar',
  'marcas.ver',
  'marcas.criar',
  'categorias.ver',
];

function referencias(
  gravar: (corpo: unknown) => { status?: number; corpo: unknown },
  permissoes = PERMISSOES,
) {
  return [
    ...rotasSessao({ permissoes }),
    ({ url }: { url: URL }) =>
      url.pathname === '/api/estoques'
        ? {
            corpo: {
              itens: [
                {
                  id: ESTOQUE,
                  codigo: 1,
                  nome: 'Loja 1 - Ficticia',
                  tipo: 'loja',
                  lojaId: LOJA,
                  lojaNome: 'Loja 1',
                  ativo: true,
                  versao: 1,
                },
                {
                  id: CD,
                  codigo: 2,
                  nome: 'CD - Ficticio',
                  tipo: 'deposito',
                  lojaId: null,
                  lojaNome: null,
                  ativo: true,
                  versao: 1,
                },
              ],
              total: 2,
              pagina: 1,
              tamanho: 'todos',
            },
          }
        : undefined,
    ({ url }: { url: URL }) =>
      url.pathname === '/api/referencias/unidades'
        ? {
            corpo: [
              { id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false },
              { id: KG, sigla: 'KG', descricao: 'Quilograma', permiteFracao: true },
            ],
          }
        : undefined,
    ({ url }: { url: URL }) =>
      url.pathname === '/api/marcas'
        ? { corpo: { itens: MARCAS, total: 1, pagina: 1, tamanho: 'todos' } }
        : undefined,
    ({ url }: { url: URL }) =>
      url.pathname === '/api/categorias/arvore'
        ? {
            corpo: [
              {
                id: CATEGORIA,
                nome: 'Cervejas',
                categoriaPaiId: null,
                caminhoNomes: 'Bebidas > Cervejas',
                nivel: 1,
                ordem: 0,
                ativa: true,
                exibePdv: false,
                exibeMenuDigital: false,
                exibeTotem: false,
                exibeSite: false,
                cor: null,
                produtos: 1,
                versao: 1,
              },
            ],
          }
        : undefined,
    ({ url, corpo }: { url: URL; corpo: unknown }) =>
      url.pathname === '/api/produtos/cadastro-em-massa/pesquisar-ean'
        ? {
            corpo: {
              itens: (corpo as { codigos: string[] }).codigos.includes(EAN_EXISTENTE)
                ? [{ codigo: EAN_EXISTENTE, produtos: [ACHADO] }]
                : [],
            },
          }
        : undefined,
    ({ url, metodo, corpo }: { url: URL; metodo: string; corpo: unknown }) =>
      metodo === 'POST' && url.pathname === '/api/produtos/cadastro-em-massa' ? gravar(corpo) : undefined,
  ];
}

describe('tela Cadastro em massa (ERP 8.3)', () => {
  it('o EAN cadastrado vira Atualização em azul; a linha nova com a marca nova; Gravar manda a grade e mostra os links', async () => {
    const usuario = userEvent.setup();
    const api = simularApi(...referencias(() => ({ status: 201, corpo: RESULTADO })));
    renderizarComSessao(<CadastroEmMassa />);
    const grade = await screen.findByRole('table', { name: 'Produtos do cadastro em massa' });
    expect(await screen.findByDisplayValue('Loja 1 - Ficticia')).toBeInTheDocument();

    await usuario.type(within(grade).getByLabelText('EAN da linha 1'), EAN_EXISTENTE);
    await usuario.tab();
    await waitFor(() =>
      expect(within(grade).getByLabelText('Nome da linha 1')).toHaveValue('CERV FICTICIA PILSEN LT 350ML'),
    );
    const linha1 = within(grade).getByLabelText('EAN da linha 1').closest('tr')!;
    expect(linha1).toHaveAttribute('data-destaque', 'Atualização');
    expect(within(linha1).getByText('Cód. 11')).toBeInTheDocument();
    expect(within(grade).getByLabelText('Estoque mín. da linha 1')).toHaveValue('6');
    await usuario.type(within(grade).getByLabelText('Estoque (+) da linha 1'), '12');

    await usuario.click(screen.getByRole('button', { name: /Inserir linha/ }));
    await usuario.type(within(grade).getByLabelText('EAN da linha 2'), EAN_NOVO);
    await usuario.tab();
    await waitFor(() => expect(within(grade).getAllByText('Novo').length).toBeGreaterThan(0));
    await usuario.type(within(grade).getByLabelText('Nome da linha 2'), 'AGUA FICTICIA 500ML');
    await usuario.type(within(grade).getByLabelText('Marca da linha 2'), 'Marca Nova Ficticia');
    await usuario.type(within(grade).getByLabelText('Preço custo da linha 2'), '1');
    await usuario.type(within(grade).getByLabelText('Markup % da linha 2'), '100');
    expect(within(grade).getByLabelText('Preço venda da linha 2')).toHaveValue('2,00');
    await usuario.type(within(grade).getByLabelText('Estoque (+) da linha 2'), '24');

    await usuario.click(screen.getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText('Cadastro em massa gravado')).toBeInTheDocument();
    const envio = api.chamadas.find(
      (c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos/cadastro-em-massa',
    )!;
    expect(envio.corpo).toMatchObject({
      estoqueId: ESTOQUE,
      confirmarEanDuplicado: false,
      linhas: [
        {
          produtoId: PRODUTO,
          versao: 42,
          ean: EAN_EXISTENTE,
          estoque: '12',
          estoqueMinimo: null,
          precoVenda: null,
        },
        {
          produtoId: null,
          ean: EAN_NOVO,
          nome: 'AGUA FICTICIA 500ML',
          unidadeId: UN,
          marcaId: null,
          marcaNova: 'Marca Nova Ficticia',
          precoCusto: '1',
          markupPct: '100',
          precoVenda: '2.00',
          estoque: '24',
        },
      ],
    });
    expect(screen.getByRole('link', { name: 'acerto de Entrada Nº 77' })).toHaveAttribute(
      'href',
      '/estoque/acertos/0190a000-0000-7000-8000-0000000000d1',
    );
    expect(screen.getByRole('link', { name: '12 - AGUA FICTICIA 500ML' })).toHaveAttribute(
      'href',
      '/produtos/0190a000-0000-7000-8000-000000000012',
    );
    // A grade volta vazia.
    expect(within(grade).getByLabelText('EAN da linha 1')).toHaveValue('');
  }, 30_000);

  it('os erros da API voltam à linha e à coluna; Limpar esvazia a grade com a confirmação', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...referencias(() => ({
        status: 422,
        corpo: {
          codigo: 'VALIDACAO',
          mensagem: 'Verifique as linhas destacadas (1 linha(s) com erro). Nada foi gravado.',
          campos: { 'linhas.0.categoriaId': ['Categoria inexistente'] },
        },
      })),
    );
    renderizarComSessao(<CadastroEmMassa />);
    const grade = await screen.findByRole('table', { name: 'Produtos do cadastro em massa' });
    expect(await screen.findByDisplayValue('Loja 1 - Ficticia')).toBeInTheDocument();
    await usuario.type(within(grade).getByLabelText('EAN da linha 1'), EAN_NOVO);
    await usuario.tab();
    await usuario.type(within(grade).getByLabelText('Nome da linha 1'), 'AGUA FICTICIA 500ML');
    await usuario.type(within(grade).getByLabelText('Preço venda da linha 1'), '2');
    await usuario.click(screen.getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText(/Verifique as linhas destacadas/)).toBeInTheDocument();
    expect(within(grade).getByLabelText('Categoria da linha 1')).toHaveAttribute('aria-invalid', 'true');

    await usuario.click(screen.getByRole('button', { name: 'Limpar' }));
    await usuario.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Limpar' }));
    await waitFor(() => expect(within(grade).getByLabelText('Nome da linha 1')).toHaveValue(''));
  }, 30_000);
  it('colar 2 linhas do Excel na grade nova pesquisa os EANs: a já cadastrada vira Atualização com o preço colado', async () => {
    const usuario = userEvent.setup();
    const api = simularApi(...referencias(() => ({ status: 201, corpo: RESULTADO })));
    renderizarComSessao(<CadastroEmMassa />);
    const grade = await screen.findByRole('table', { name: 'Produtos do cadastro em massa' });
    expect(await screen.findByDisplayValue('Loja 1 - Ficticia')).toBeInTheDocument();
    await usuario.click(within(grade).getByLabelText('EAN da linha 1'));
    // EAN, nome, custo, preço e estoque (a ordem da colagem com "Ver custo").
    await usuario.paste(
      `${EAN_EXISTENTE}\tCERV FICTICIA NOVA\t2,20\t3,85\t48\r\n${EAN_NOVO}\tAGUA FICTICIA\t1\t2\t12\r\n`,
    );
    await waitFor(() =>
      expect(within(grade).getByLabelText('EAN da linha 1').closest('tr')).toHaveAttribute(
        'data-destaque',
        'Atualização',
      ),
    );
    expect(
      api.chamadas.filter((c) => c.url.pathname === '/api/produtos/cadastro-em-massa/pesquisar-ean'),
    ).toHaveLength(1);
    expect(within(grade).getByLabelText('Nome da linha 1')).toHaveValue('CERV FICTICIA NOVA');
    expect(within(grade).getByLabelText('Preço venda da linha 1')).toHaveValue('3,85');
    expect(within(grade).getByLabelText('NCM da linha 1')).toHaveValue('22030000');

    await usuario.click(screen.getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText('Cadastro em massa gravado')).toBeInTheDocument();
    const envio = api.chamadas.find(
      (c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos/cadastro-em-massa',
    )!;
    expect(envio.corpo).toMatchObject({
      linhas: [
        {
          produtoId: PRODUTO,
          nome: 'CERV FICTICIA NOVA',
          precoCusto: '2.20',
          precoVenda: '3.85',
          estoque: '48',
        },
        { produtoId: null, nome: 'AGUA FICTICIA', precoCusto: '1', precoVenda: '2', estoque: '12' },
      ],
    });
  }, 30_000);

  it('sem o acerto de estoque, a colagem não preenche o "Estoque (+)" escondido', async () => {
    const usuario = userEvent.setup();
    const api = simularApi(
      ...referencias(
        () => ({ status: 201, corpo: { ...RESULTADO, acerto: null } }),
        PERMISSOES.filter((p) => p !== 'estoque_acertos.criar'),
      ),
    );
    renderizarComSessao(<CadastroEmMassa />);
    const grade = await screen.findByRole('table', { name: 'Produtos do cadastro em massa' });
    expect(await screen.findByDisplayValue('Loja 1 - Ficticia')).toBeInTheDocument();
    expect(within(grade).queryByLabelText('Estoque (+) da linha 1')).not.toBeInTheDocument();
    await usuario.click(within(grade).getByLabelText('EAN da linha 1'));
    await usuario.paste(`${EAN_NOVO}\tAGUA FICTICIA\t1\t2\t12\r\n${ean(3)}\tAGUA FICTICIA 2\t1\t2\t5\r\n`);
    await waitFor(() =>
      expect(within(grade).getByLabelText('Nome da linha 2')).toHaveValue('AGUA FICTICIA 2'),
    );
    await usuario.click(screen.getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText('Cadastro em massa gravado')).toBeInTheDocument();
    const envio = api.chamadas.find(
      (c) => c.metodo === 'POST' && c.url.pathname === '/api/produtos/cadastro-em-massa',
    )!;
    expect(envio.corpo).toMatchObject({
      linhas: [
        { nome: 'AGUA FICTICIA', estoque: null },
        { nome: 'AGUA FICTICIA 2', estoque: null },
      ],
    });
  }, 30_000);

  it('a mensagem da API cita a linha da grade (com a linha vazia do meio), não a posição entre as enviadas', async () => {
    const usuario = userEvent.setup();
    simularApi(
      ...referencias(() => ({
        status: 403,
        corpo: {
          codigo: 'SEM_PERMISSAO',
          mensagem: 'Linha 2: Alterar preço no ERP exige "Produtos: Alterar preço".',
          campos: { 'linhas.1._linha': ['Alterar preço no ERP exige "Produtos: Alterar preço".'] },
        },
      })),
    );
    renderizarComSessao(<CadastroEmMassa />);
    const grade = await screen.findByRole('table', { name: 'Produtos do cadastro em massa' });
    expect(await screen.findByDisplayValue('Loja 1 - Ficticia')).toBeInTheDocument();
    await usuario.type(within(grade).getByLabelText('Nome da linha 1'), 'AGUA FICTICIA 500ML');
    await usuario.type(within(grade).getByLabelText('Preço venda da linha 1'), '2');
    await usuario.click(screen.getByRole('button', { name: /Inserir linha/ }));
    await usuario.click(screen.getByRole('button', { name: /Inserir linha/ }));
    await usuario.type(within(grade).getByLabelText('Nome da linha 3'), 'AGUA FICTICIA 1L');
    await usuario.type(within(grade).getByLabelText('Preço venda da linha 3'), '3');
    await usuario.click(screen.getByRole('button', { name: 'Gravar' }));
    expect(await screen.findByText(/^Linha 3: Alterar preço/)).toBeInTheDocument();
    expect(within(grade).getByLabelText('Nome da linha 3').closest('tr')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  }, 30_000);
});
