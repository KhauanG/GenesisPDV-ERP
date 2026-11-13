import { describe, expect, it } from 'vitest';
import {
  alteracoesDiferencas,
  diferencasProduto,
  ESCOPO_GRAVADO,
  referenciasDiferencas,
  textoDiferencas,
  TRECHO_CUSTO_GRAVADO,
  type EscopoDiferenca,
  type Nomes,
} from './diferenca-produto.js';

// Ids e nomes inventados (repositório público).
const id = (n: number) => `0190a000-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`;
const MARCA = id(1);
const LOJA_A = id(2);
const LOJA_B = id(3);
const CATEGORIA = id(4);
const FORNECEDOR = id(5);
const COMPONENTE = id(6);
const ESTOQUE_A = id(7);
const ESTOQUE_B = id(8);
const LOTE = id(9);

const nomes: Nomes = {
  marca: new Map([[MARCA, 'MARCA INVENTADA']]),
  loja: new Map([
    [LOJA_A, 'Centro'],
    [LOJA_B, 'Praia'],
  ]),
  categoria: new Map([[CATEGORIA, 'BEBIDAS › CERVEJAS']]),
  pessoa: new Map([[FORNECEDOR, 'DISTRIBUIDORA TESTE']]),
  produto: new Map([[COMPONENTE, '12 - LATA TESTE']]),
  estoque: new Map([
    [ESTOQUE_A, 'Depósito Centro'],
    [ESTOQUE_B, 'Depósito Praia'],
  ]),
};

const TUDO: EscopoDiferenca = { custo: 'valores', lojas: null, estoques: null };

/** O detalhe (antes) e a linha gravada (depois) de um produto, com os decimais como o banco os devolve. */
const base = () => ({
  id: id(50),
  codigo: 1,
  nome: 'CERVEJA TESTE 350ML',
  tipo: 'simples',
  ativo: true,
  precoVenda: '9.9000',
  precoCusto: '5.0000',
  markupPct: '98.0000',
  marcaId: null as string | null,
  versao: 3,
  atualizadoEm: '2026-11-03T17:00:00.000Z',
  codigosBarras: [
    {
      id: id(60),
      codigo: '7890000000017',
      tipo: 'gtin',
      principal: true,
      descricao: null,
      unidadeId: null,
      fator: '1.000',
      preco: null,
      usaVenda: true,
      usaCompra: true,
    },
  ],
  lojas: [
    {
      lojaId: LOJA_A,
      precoVenda: '9.9000',
      estoqueMinimo: null,
      estoqueMaximo: null,
      ativoNaLoja: true,
      acrescimoGelada: null,
    },
  ],
  precosQuantidade: [] as Array<Record<string, unknown>>,
  componentes: [] as Array<Record<string, unknown>>,
  categorias: [] as string[],
  fornecedores: [] as Array<Record<string, unknown>>,
  lotes: [] as Array<Record<string, unknown>>,
});

const texto = (antes: unknown, depois: unknown, e: EscopoDiferenca = TUDO) =>
  textoDiferencas(diferencasProduto(antes, depois), nomes, e);

describe('diferença legível do produto (ERP 16.2; F2-B42)', () => {
  it('o critério de pronto: preço de venda e EAN adicionado, com o decimal do banco igual ao do corpo', () => {
    const antes = base();
    const depois = {
      ...base(),
      precoVenda: '10.90',
      precoCusto: '5',
      versao: 4,
      atualizadoEm: '2026-11-03T17:02:00.000Z',
      codigosBarras: [
        ...base().codigosBarras,
        { ...base().codigosBarras[0]!, id: null, codigo: '7891234567895', principal: false },
      ],
    };
    expect(texto(antes, depois)).toBe('Preço de venda: 9,90 → 10,90; EAN adicionado 7891234567895');
  });

  it('nada mudou: vazio (o "9.9000" do detalhe e o "9.9" do corpo são o mesmo preço)', () => {
    expect(texto(base(), { ...base(), precoVenda: '9.9', versao: 9 })).toBe('');
    expect(diferencasProduto(base(), base())).toEqual([]);
  });

  it('referência pelo nome: "Marca: — → MARCA INVENTADA"; e os ids que a página precisa buscar', () => {
    const itens = diferencasProduto(base(), { ...base(), marcaId: MARCA });
    expect(textoDiferencas(itens, nomes, TUDO)).toBe('Marca: — → MARCA INVENTADA');
    expect([...referenciasDiferencas(itens, TUDO).marca]).toEqual([MARCA]);
    expect(textoDiferencas(itens, {}, TUDO)).toBe('Marca: — → (não encontrado)');
  });

  it('filhas adicionadas, removidas e alteradas (lojas, faixas, categorias, fornecedores, componentes)', () => {
    const antes = {
      ...base(),
      precosQuantidade: [
        { id: id(70), lojaId: null, quantidadeInicial: '6.000', quantidadeFinal: null, preco: '8.5000' },
      ],
      categorias: [CATEGORIA],
      fornecedores: [
        {
          id: id(71),
          fornecedorId: FORNECEDOR,
          fornecedor: { id: FORNECEDOR, nome: 'DISTRIBUIDORA TESTE' },
          codigoFornecedor: 'ABC-1',
          eanFornecedor: null,
          unidadeCompra: 'CX',
          fator: '12.000',
          custoFornecedor: '50.0000',
          ultimoCusto: null,
          ultimaCompraEm: null,
          principal: true,
        },
      ],
    };
    const depois = {
      ...base(),
      lojas: [
        { ...base().lojas[0]!, precoVenda: '10.9', estoqueMinimo: '6' },
        {
          lojaId: LOJA_B,
          precoVenda: '11',
          estoqueMinimo: null,
          estoqueMaximo: null,
          ativoNaLoja: true,
          acrescimoGelada: null,
        },
      ],
      precosQuantidade: [
        { id: id(70), lojaId: null, quantidadeInicial: '6', quantidadeFinal: null, preco: '8' },
      ],
      categorias: [],
      fornecedores: [{ ...antes.fornecedores[0]!, fator: '24.000', custoFornecedor: '55.0000' }],
      componentes: [
        {
          id: null,
          tipo: 'kit',
          componenteId: COMPONENTE,
          componenteVariacaoId: null,
          quantidade: '2',
          perdaPct: '0.0000',
          rotuloPosicao: null,
          permiteSubstituicao: false,
          ordem: 0,
          alternativas: [],
        },
      ],
    };
    expect(texto(antes, depois)).toBe(
      [
        'Loja Centro: Preço de venda 9,90 → 10,90, Estoque mínimo — → 6',
        'Loja adicionada Praia (Preço de venda 11,00)',
        'Faixa de preço a partir de 6 em todas as lojas: Preço 8,50 → 8,00',
        'Componente do combo adicionado 12 - LATA TESTE (Qtd 2)',
        'Fornecedor DISTRIBUIDORA TESTE (código "ABC-1"): Fator 12 → 24, Custo do fornecedor 50,00 → 55,00',
        'Categoria removida BEBIDAS › CERVEJAS',
      ].join('; '),
    );
    // A filha removida: a faixa e o fornecedor que saem.
    expect(texto(depois, { ...depois, precosQuantidade: [], fornecedores: [] })).toBe(
      'Faixa de preço removida a partir de 6 em todas as lojas; Fornecedor removido DISTRIBUIDORA TESTE (código "ABC-1")',
    );
  });

  it('campos desconhecidos entram com o nome da chave; objeto só como "(alterado)"; o derivado e a lista de um lado só não', () => {
    const antes = { ...base(), campoNovo: 'A', configuracao_extra: { x: 1 }, unidadeSigla: 'UN' };
    const depois = { ...base(), campoNovo: 'B', configuracao_extra: { x: 2 }, colunaSoNoDepois: 'X' };
    expect(texto(antes, depois)).toBe('Campo novo: A → B; Configuracao extra: (alterado)');
    // A lista que não veio no `depois` (o relacionado fora do corpo) não é "tudo removido".
    const { codigosBarras: _c, ...semCodigos } = base();
    expect(texto(base(), semCodigos)).toBe('');
    // Campo desconhecido com cara de custo segue a regra do custo.
    expect(texto({ ...base(), custoNovo: '1' }, { ...base(), custoNovo: '2' }, ESCOPO_GRAVADO)).toBe(
      'Custo novo: (alterado)',
    );
  });

  it('o custo: com os valores para quem tem produtos.ver_custo, só o rótulo no texto gravado, nada sem a permissão', () => {
    const depois = { ...base(), precoCusto: '6.5', precoVenda: '11' };
    expect(texto(base(), depois)).toBe('Preço de custo: 5,00 → 6,50; Preço de venda: 9,90 → 11,00');
    expect(texto(base(), depois, ESCOPO_GRAVADO)).toBe(
      'Preço de custo: (alterado); Preço de venda: 9,90 → 11,00',
    );
    const semCusto: EscopoDiferenca = { custo: 'oculto', lojas: null, estoques: null };
    expect(texto(base(), depois, semCusto)).toBe('Preço de venda: 9,90 → 11,00');
    expect(texto(base(), { ...base(), precoCusto: '6.5' }, semCusto)).toBe('');
    // Também na tabela do "ver diferença completa".
    const itens = diferencasProduto(base(), depois);
    expect(alteracoesDiferencas(itens, nomes, semCusto)).toEqual([
      { campo: 'Preço de venda', antes: '9,90', depois: '11,00' },
    ]);
    expect(alteracoesDiferencas(itens, nomes, ESCOPO_GRAVADO)[0]).toEqual({
      campo: 'Preço de custo',
      antes: '(alterado)',
      depois: '(alterado)',
    });
  });

  it('os trechos de custo do texto gravado (TRECHO_CUSTO_GRAVADO): o filtro "Histórico" de quem não tem produtos.ver_custo', () => {
    // O PostgreSQL aplica a mesma expressão (`regexp_replace(..., 'gi')`) antes do `ilike`.
    const tirar = (t: string) => t.replace(new RegExp(TRECHO_CUSTO_GRAVADO, 'gi'), '');
    const gravado = texto(
      base(),
      { ...base(), precoCusto: '6.5', markupPct: '69.2308', precoVenda: '11' },
      ESCOPO_GRAVADO,
    );
    expect(gravado).toContain('Preço de custo: (alterado)');
    expect(gravado).toContain('Markup %: (alterado)');
    expect(tirar(gravado)).not.toMatch(/custo|markup|alterado/i);
    expect(tirar(gravado)).toContain('Preço de venda: 9,90 → 11,00');
    // A criação ("(preenchido)"), o custo dentro da filha e o prefixo do documento da entrada.
    expect(tirar('Nome: CERVEJA; Preço de custo: (preenchido); Markup %: (preenchido)')).toBe(
      'Nome: CERVEJA;;',
    );
    expect(
      tirar('Fornecedor DISTRIBUIDORA TESTE (código "ABC-1"): Fator 12 → 24, Custo do fornecedor (alterado)'),
    ).toBe('Fornecedor DISTRIBUIDORA TESTE (código "ABC-1"): Fator 12 → 24,');
    expect(tirar('Recebimento Nº 12: Preço de custo: (alterado); Preço de venda: 8,00 → 8,90')).toBe(
      'Recebimento Nº 12:; Preço de venda: 8,00 → 8,90',
    );
    // O que não é rótulo de custo fica (o nome com "custo", sem o "(alterado)").
    expect(tirar('Nome: A → CERVEJA CUSTO BAIXO')).toBe('Nome: A → CERVEJA CUSTO BAIXO');
  });

  it('o que é de loja: só as lojas e os estoques permitidos; no texto gravado, um aviso sem loja nem valor', () => {
    const antes = {
      ...base(),
      lojas: [...base().lojas, { ...base().lojas[0]!, lojaId: LOJA_B }],
      lotes: [
        {
          id: LOTE,
          estoqueId: ESTOQUE_B,
          lote: 'L-1',
          validade: '2026-12-10',
          fabricacao: null,
          fornecedorId: null,
          ativo: true,
        },
      ],
    };
    const depois = {
      ...antes,
      precoVenda: '10',
      lojas: [antes.lojas[0]!, { ...antes.lojas[1]!, precoVenda: '12' }],
      lotes: [{ ...antes.lotes[0]!, validade: '2026-12-20' }],
    };
    expect(texto(antes, depois)).toBe(
      'Preço de venda: 9,90 → 10,00; Loja Praia: Preço de venda 9,90 → 12,00; Lote L-1 (Depósito Praia): Validade 10/12/2026 → 20/12/2026',
    );
    const soCentro: EscopoDiferenca = { custo: 'valores', lojas: [LOJA_A], estoques: [ESTOQUE_A] };
    expect(texto(antes, depois, soCentro)).toBe('Preço de venda: 9,90 → 10,00');
    const itens = diferencasProduto(antes, depois);
    expect(referenciasDiferencas(itens, soCentro).loja.size).toBe(0);
    expect(referenciasDiferencas(itens, soCentro).estoque.size).toBe(0);
    expect(texto(antes, depois, ESCOPO_GRAVADO)).toBe(
      'Preço de venda: 9,90 → 10,00; Dados de loja alterados',
    );
    expect(textoDiferencas(itens, nomes, ESCOPO_GRAVADO)).not.toMatch(/Praia|12,00/);
  });

  it('a criação lista o que foi preenchido fora do padrão, e as filhas como adicionadas', () => {
    const depois = { ...base(), marcaId: MARCA, categorias: [CATEGORIA], permiteFracao: false };
    expect(texto(null, depois)).toBe(
      [
        'Nome: CERVEJA TESTE 350ML',
        'Preço de custo: 5,00',
        'Markup %: 98,00',
        'Preço de venda: 9,90',
        'Marca: MARCA INVENTADA',
        'EAN adicionado 7890000000017',
        'Loja adicionada Centro (Preço de venda 9,90)',
        'Categoria adicionada BEBIDAS › CERVEJAS',
      ].join('; '),
    );
    expect(texto(null, depois, ESCOPO_GRAVADO)).toBe(
      [
        'Nome: CERVEJA TESTE 350ML',
        'Preço de custo: (preenchido)',
        'Markup %: (preenchido)',
        'Preço de venda: 9,90',
        'Marca: MARCA INVENTADA',
        'EAN adicionado 7890000000017',
        'Categoria adicionada BEBIDAS › CERVEJAS',
        'Dados de loja alterados',
      ].join('; '),
    );
  });

  it('a tabela do "ver diferença completa": um campo por linha, com a filha no rótulo', () => {
    const depois = {
      ...base(),
      precoVenda: '10.9',
      lojas: [{ ...base().lojas[0]!, precoVenda: '10.9' }],
      codigosBarras: [],
    };
    expect(alteracoesDiferencas(diferencasProduto(base(), depois), nomes, TUDO)).toEqual([
      { campo: 'Preço de venda', antes: '9,90', depois: '10,90' },
      { campo: 'EAN 7890000000017', antes: 'Existia', depois: 'Removido' },
      { campo: 'Loja Centro › Preço de venda', antes: '9,90', depois: '10,90' },
    ]);
  });

  it('complementos (F2-B51): o grupo e cada complemento com o nome do grupo; a inativação e o grupo excluído', () => {
    const GRUPO = id(80);
    const BARBECUE = id(81);
    const VINCULADO = id(82);
    const complemento = (extra: Record<string, unknown>) => ({
      produtoId: null,
      produto: null,
      descricao: null,
      precoAdicional: '0.0000',
      baixaEstoque: false,
      quantidadeBaixa: '1.000',
      ordem: 1,
      ativo: true,
      ...extra,
    });
    const grupo = (complementos: unknown[], extra: Record<string, unknown> = {}) => ({
      id: GRUPO,
      nome: 'Molhos',
      minimo: 0,
      maximo: 2,
      obrigatorio: false,
      ordem: 1,
      complementos,
      ...extra,
    });
    const comGrupos = (gruposComplementos: unknown[]) => ({
      ...base(),
      tipo: 'com_complementos',
      gruposComplementos,
    });
    const antes = comGrupos([
      grupo([complemento({ id: BARBECUE, descricao: 'Barbecue', precoAdicional: '2.0000' })]),
    ]);
    const depois = comGrupos([
      grupo(
        [
          complemento({ id: BARBECUE, descricao: 'Barbecue', precoAdicional: '2.5000' }),
          complemento({
            id: VINCULADO,
            produtoId: COMPONENTE,
            produto: { id: COMPONENTE, nome: 'LATA TESTE' },
            precoAdicional: '3.5000',
            baixaEstoque: true,
            quantidadeBaixa: '0.050',
            ordem: 2,
          }),
        ],
        { maximo: 3 },
      ),
    ]);
    expect(texto(antes, depois)).toBe(
      [
        'Grupo de complementos Molhos: Máximo 2 → 3',
        'Complemento Molhos: Barbecue: Preço adicional 2,00 → 2,50',
        'Complemento adicionado Molhos: 12 - LATA TESTE (Preço adicional 3,50, Baixa estoque Sim, Qtd da baixa 0,05)',
      ].join('; '),
    );
    // O complemento que saiu da lista fica inativo (a gravação não o apaga).
    const inativo = comGrupos([
      grupo([complemento({ id: BARBECUE, descricao: 'Barbecue', precoAdicional: '2.0000', ativo: false })]),
    ]);
    expect(texto(antes, inativo)).toBe('Complemento Molhos: Barbecue: Ativo Sim → Não');
    // O grupo excluído leva os complementos; a criação lista os dois.
    expect(texto(antes, comGrupos([]))).toBe(
      'Grupo de complementos removido Molhos; Complemento removido Molhos: Barbecue',
    );
    expect(texto(null, antes)).toContain(
      'Grupo de complementos adicionado Molhos (Máximo 2); Complemento adicionado Molhos: Barbecue (Preço adicional 2,00)',
    );
    // A lista ausente de um lado (o corpo antigo sem os grupos) não é mudança.
    expect(texto(antes, base())).toBe('Tipo: Com complementos → Simples');
  });
});
