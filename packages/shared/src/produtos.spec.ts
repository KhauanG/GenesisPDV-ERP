import { describe, expect, it } from 'vitest';
import {
  calcularDvGtin,
  combosMontaveis,
  ehDun14,
  gerarCodigoInterno,
  margemPct,
  markupPct,
  faixaAplicavel,
  precoPeloMarkup,
  precoPeloMarkupTexto,
  resolverPreco,
  resumoCombo,
  simularGrupoPreco,
  validarGtin,
} from './precos.js';
import { CONFIGURACOES_POR_CHAVE } from './configuracoes.js';
import { ajusteEstoqueProdutoSchema } from './estoque.js';
import { cadastroRapidoFornecedorSchema, tipoPessoaDoDocumento } from './pessoas.js';
import {
  cadastroMassaSchema,
  CHAVES_TIPO_PRODUTO,
  chaveFornecedorProduto,
  chaveLoteProduto,
  corpoProdutoRapido,
  criarGrupoPrecoSchema,
  criarProdutoSchema,
  criarRestricaoHorarioSchema,
  faixasSobrepostas,
  historicoPrecosQuerySchema,
  LIMITE_CODIGOS_PESQUISA_EAN_MASSA,
  LIMITE_LINHAS_CADASTRO_MASSA,
  MAXIMO_FORNECEDORES_PRODUTO,
  MAXIMO_LOTES_PRODUTO,
  motivoTipoProdutoBloqueado,
  pesquisaEanCadastroMassaSchema,
  TIPOS_PRODUTO,
  TIPOS_SEM_SALDO_PROPRIO,
  tiposProdutoHabilitados,
} from './produtos.js';

const UN = '0190a000-0000-7000-8000-000000000001';
const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';
const C = '0190a000-0000-7000-8000-00000000000c';
const LOJA = '0190a000-0000-7000-8000-0000000000f1';

const campos = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.path.join('.')).sort();

describe('cadastro em massa (ERP 8.3; F2-B39)', () => {
  const gtin = (base: string) => `${base}${calcularDvGtin(base)}`;
  const EAN = gtin('789980000001');
  const novo = { ean: EAN, nome: 'AGUA FICTICIA 500ML', unidadeId: UN, precoVenda: '2,50', estoque: '12' };

  it('a linha nova exige nome, unidade, preço e o GTIN válido; os decimais saem com ponto', () => {
    const r = cadastroMassaSchema.safeParse({ estoqueId: LOJA, linhas: [novo] });
    expect(r.success).toBe(true);
    expect(r.data!.linhas[0]).toMatchObject({ produtoId: null, precoVenda: '2.5000', estoque: '12.000' });
    expect(
      campos(
        cadastroMassaSchema.safeParse({
          estoqueId: LOJA,
          linhas: [{ ean: '7899800000010', precoVenda: '0' }],
        }),
      ),
    ).toEqual(['linhas.0.ean', 'linhas.0.nome', 'linhas.0.precoVenda', 'linhas.0.unidadeId']);
  });

  it('a Atualização exige o EAN e a versão; os vazios ficam nulos (mantêm o gravado)', () => {
    const r = cadastroMassaSchema.safeParse({
      estoqueId: LOJA,
      linhas: [{ produtoId: A, versao: 7, ean: 'FD12-INTERNO', estoque: '1', precoVenda: '' }],
    });
    expect(r.success).toBe(true);
    expect(r.data!.linhas[0]).toMatchObject({ nome: null, precoVenda: null, unidadeId: null });
    expect(
      campos(cadastroMassaSchema.safeParse({ estoqueId: LOJA, linhas: [{ produtoId: A, estoque: '1' }] })),
    ).toEqual(['linhas.0.ean', 'linhas.0.ean']);
  });

  it('o EAN e o produto repetidos na grade, a marca escolhida e nova juntas e o limite de linhas', () => {
    expect(
      campos(
        cadastroMassaSchema.safeParse({
          estoqueId: LOJA,
          linhas: [novo, { ...novo, marcaId: B, marcaNova: 'Outra' }],
        }),
      ),
    ).toEqual(['linhas.1.ean', 'linhas.1.marcaNova']);
    expect(
      campos(
        cadastroMassaSchema.safeParse({
          estoqueId: LOJA,
          linhas: [
            { produtoId: A, versao: 1, ean: EAN },
            { produtoId: A, versao: 1, ean: gtin('789980000002') },
          ],
        }),
      ),
    ).toEqual(['linhas.1.ean']);
    const muitas = Array.from({ length: LIMITE_LINHAS_CADASTRO_MASSA + 1 }, (_, i) => ({
      ...novo,
      ean: gtin(`7899800${String(i).padStart(5, '0')}`),
    }));
    expect(campos(cadastroMassaSchema.safeParse({ estoqueId: LOJA, linhas: muitas }))).toEqual(['linhas']);
    // O "Pesquisar EAN" aceita a grade colada maior que uma gravação (que se faz em partes).
    const codigos = (n: number) =>
      Array.from({ length: n }, (_, i) => gtin(`7899800${String(i).padStart(5, '0')}`));
    expect(LIMITE_CODIGOS_PESQUISA_EAN_MASSA).toBeGreaterThan(LIMITE_LINHAS_CADASTRO_MASSA);
    expect(
      pesquisaEanCadastroMassaSchema.safeParse({
        estoqueId: LOJA,
        codigos: codigos(LIMITE_CODIGOS_PESQUISA_EAN_MASSA),
      }).success,
    ).toBe(true);
    expect(
      pesquisaEanCadastroMassaSchema.safeParse({
        estoqueId: LOJA,
        codigos: codigos(LIMITE_CODIGOS_PESQUISA_EAN_MASSA + 1),
      }).success,
    ).toBe(false);
  });
});

describe('cadastro rápido de produto (ERP 13.3; F2-B16)', () => {
  const valores = {
    nome: 'CERV NOVA LATA 350ML',
    ean: ' 7891000001233 ',
    unidadeId: UN,
    unidadePermiteFracao: false,
    ncm: '22030000',
    marcaId: null,
    categoriaId: A,
    precoVenda: '4,99',
  };

  it('um Simples sem tributação, a fração da unidade, a categoria principal e o EAN principal; válido no contrato', () => {
    const corpo = corpoProdutoRapido(valores);
    expect(corpo).toEqual({
      nome: 'CERV NOVA LATA 350ML',
      tipo: 'simples',
      unidadeId: UN,
      permiteFracao: false,
      ncm: '22030000',
      marcaId: null,
      categoriaPrincipalId: A,
      categorias: [A],
      precoVenda: '4,99',
      codigosBarras: [{ codigo: '7891000001233', principal: true }],
      confirmarEanDuplicado: false,
    });
    expect(criarProdutoSchema.safeParse(corpo).success).toBe(true);
    // O custo só quando quem abre o conhece (e pode vê-lo); sem EAN, sem código de barras.
    expect(corpoProdutoRapido({ ...valores, precoCusto: '3,10' }, true)).toMatchObject({
      precoCusto: '3,10',
      confirmarEanDuplicado: true,
    });
    expect(corpoProdutoRapido({ ...valores, ean: '', precoCusto: null })).not.toHaveProperty('precoCusto');
    expect(corpoProdutoRapido({ ...valores, ean: '' }).codigosBarras).toEqual([]);
    // O CEST do item da NF-e (F2-B20): vai quando veio e é válido no contrato; vazio ou nulo, não vai.
    const comCest = corpoProdutoRapido({ ...valores, cest: '0302100' });
    expect(comCest).toMatchObject({ cest: '0302100' });
    expect(criarProdutoSchema.parse(comCest).cest).toBe('0302100');
    expect(corpoProdutoRapido({ ...valores, cest: '' })).not.toHaveProperty('cest');
    expect(corpoProdutoRapido({ ...valores, cest: null })).not.toHaveProperty('cest');
  });
});

describe('GTIN (ERP 1.6, 8.2.3)', () => {
  it('confere o DV de GTIN-8, 12, 13 e 14 (DUN-14)', () => {
    expect(validarGtin('7891000315507')).toBe(true); // EAN-13
    expect(validarGtin('7891000315508')).toBe(false);
    expect(validarGtin('96385074')).toBe(true); // GTIN-8
    expect(validarGtin('036000291452')).toBe(true); // UPC-A
    expect(validarGtin('17891000315504')).toBe(true); // DUN-14 do mesmo item
    expect(ehDun14('17891000315504')).toBe(true);
    expect(validarGtin('789100031550')).toBe(false); // 12 dígitos com DV errado
    expect(validarGtin('12345')).toBe(false);
    expect(validarGtin('0000000000000')).toBe(false);
    expect(calcularDvGtin('789100031550')).toBe(7);
  });

  it('código interno com prefixo 2 sai com DV válido', () => {
    const c = gerarCodigoInterno(123);
    expect(c).toMatch(/^2\d{12}$/);
    expect(c.startsWith('200000000123')).toBe(true);
    expect(validarGtin(c)).toBe(true);
  });
});

describe('margem e markup (ERP 8.2.1)', () => {
  it('calcula e arredonda', () => {
    expect(margemPct(6, 10)).toBe(40);
    expect(markupPct(6, 10)).toBeCloseTo(66.6667, 4);
    expect(precoPeloMarkup(6, 66.6667)).toBe(10);
    expect(margemPct(10, 0)).toBeNull();
    expect(markupPct(0, 10)).toBeNull();
  });
});

describe('combo (ERP 8.2.17)', () => {
  // COMBO DE WHISKY 1L: Whisky (1) + Energético 2L (1, alternativas) + Gelo de sabor (2).
  const posicoes = [
    { quantidade: 1, padrao: { custo: 80, preco: 120 } },
    {
      quantidade: 1,
      padrao: { custo: 10, preco: 18 },
      alternativas: [
        { custo: 12, preco: 20, acrescimo: 2 },
        { custo: 7, preco: 14, acrescimo: 0 },
      ],
    },
    { quantidade: 2, padrao: { custo: 2, preco: 5 } },
  ];

  it('custo = Σ custo × qtd; soma de preços; desconto; margem e faixa com alternativas', () => {
    const r = resumoCombo(posicoes, 139.9);
    expect(r.custo).toBe(94);
    expect(r.somaPrecos).toBe(148);
    expect(r.descontoCombo).toBe(8.1);
    expect(r.margemPct).toBe(32.81);
    // mais cara: 80 + 12 + 4 = 96 sobre 141,90; mais barata: 80 + 7 + 4 = 91 sobre 139,90
    expect(r.margemMinPct).toBe(32.35);
    expect(r.margemMaxPct).toBe(34.95);
  });

  it('faixa de margem inclui o cenário padrão e pesa o acréscimo (não só o custo)', () => {
    // Combo 129,90: Whisky custo 60 + Energético padrão custo 10; alternativas custo 12 (+6,00) e custo 8 (+0).
    const r = resumoCombo(
      [
        { quantidade: 1, padrao: { custo: 60, preco: 100 } },
        {
          quantidade: 1,
          padrao: { custo: 10, preco: 18 },
          alternativas: [
            { custo: 12, preco: 20, acrescimo: 6 },
            { custo: 8, preco: 16, acrescimo: 0 },
          ],
        },
      ],
      '129.90',
    );
    expect(r.margemPct).toBe(46.11);
    // +6,00 com custo 12: (135,90 − 72) ÷ 135,90 = 47,02%; custo 8: (129,90 − 68) ÷ 129,90 = 47,65%
    expect(r.margemMinPct).toBe(46.11);
    expect(r.margemMaxPct).toBe(47.65);
  });

  it('combo mais caro que os itens avulsos: desconto negativo e percentual', () => {
    const r = resumoCombo([{ quantidade: 1, padrao: { custo: 100, preco: 145.8 } }], 149.9);
    expect(r.descontoCombo).toBe(-4.1);
    expect(r.descontoPct).toBe(-2.81);
  });

  it('contas em decimal com meio para cima (como o C# decimal do PDV)', () => {
    // Em ponto flutuante 2.675 × 1 = 2.67499999… e 1.005 × 100 = 100.49999…
    expect(precoPeloMarkup('2.675', 0)).toBe(2.68);
    expect(precoPeloMarkup('1.005', '0')).toBe(1.01);
    expect(precoPeloMarkupTexto('1.0005', '200')).toBe('3.00');
    expect(margemPct('0.3', '0.1')).toBe(-200);
    expect(resumoCombo([{ quantidade: 3, padrao: { custo: '0.1', preco: '1.0005' } }], '3').custo).toBe(0.3);
  });

  it('combos montáveis somam as posições com o mesmo componente (duas posições "Gelo de sabor")', () => {
    expect(
      combosMontaveis([
        { nome: 'GELO COCO', chave: 'g', quantidade: 1, controlaEstoque: true, saldo: 5 },
        { nome: 'GELO COCO', chave: 'g', quantidade: 1, controlaEstoque: true, saldo: 5 },
        { nome: 'WHISKY', chave: 'w', quantidade: 1, controlaEstoque: true, saldo: 10 },
      ]),
    ).toEqual({ quantidade: 2, limitadoPor: 'GELO COCO' });
  });

  it('combos montáveis = mínimo de ⌊saldo ÷ qtd⌋ das posições que controlam estoque', () => {
    expect(
      combosMontaveis([
        { nome: 'WHISKY', quantidade: 1, controlaEstoque: true, saldo: 10 },
        { nome: 'GELO COCO', quantidade: 2, controlaEstoque: true, saldo: 7 },
        { nome: 'TAXA', quantidade: 1, controlaEstoque: false, saldo: 0 },
      ]),
    ).toEqual({ quantidade: 3, limitadoPor: 'GELO COCO' });
    expect(combosMontaveis([{ nome: 'X', quantidade: 1, controlaEstoque: true, saldo: -4 }]).quantidade).toBe(
      0,
    );
    expect(combosMontaveis([{ nome: 'X', quantidade: 1, controlaEstoque: false, saldo: 0 }])).toEqual({
      quantidade: null,
      limitadoPor: null,
    });
  });
});

describe('regra de preço por quantidade (PDV 11.3, 11.3.1)', () => {
  const p = { precoVenda: 3.49, precoAtacado: 3.19, qtdMinimaAtacado: 12 };
  const params = { usaPrecoVolume: true, lojaId: LOJA };

  it('atacado a partir da quantidade mínima; faixa da loja prevalece; menor preço vence', () => {
    expect(resolverPreco(p, 11, null, params).origem).toBe('varejo');
    expect(resolverPreco(p, 12, null, params)).toMatchObject({ preco: 3.19, origem: 'atacado' });
    const faixas = [
      { lojaId: null, quantidadeInicial: 6, quantidadeFinal: null, preco: 3.29 },
      { lojaId: LOJA, quantidadeInicial: 6, quantidadeFinal: null, preco: 3.25 },
    ];
    expect(resolverPreco({ ...p, faixas }, 6, null, params)).toMatchObject({
      preco: 3.25,
      origem: 'quantidade',
    });
    expect(resolverPreco({ ...p, faixas }, 6, null, { ...params, usaPrecoVolume: false }).origem).toBe(
      'varejo',
    );
  });

  it('limite final da faixa é inclusivo; faixas que se tocam: vence a de maior início (PDV FaixaPreco.Contem)', () => {
    const base = { precoVenda: 3.49 };
    const faixas = [
      { lojaId: null, quantidadeInicial: 6, quantidadeFinal: 11, preco: 3.39 },
      { lojaId: null, quantidadeInicial: 12, quantidadeFinal: null, preco: 3.19 },
    ];
    expect(resolverPreco({ ...base, faixas }, 11, null, params)).toMatchObject({
      preco: 3.39,
      origem: 'quantidade',
    });
    const tocam = [
      { lojaId: null, quantidadeInicial: 6, quantidadeFinal: 12, preco: 3.39 },
      { lojaId: null, quantidadeInicial: 12, quantidadeFinal: null, preco: 3.29 },
    ];
    expect(faixaAplicavel(tocam, 12, null)?.preco).toBe(3.29);
    expect(faixaAplicavel(tocam, 11.5, null)?.preco).toBe(3.39);
  });

  it('simular: modo produto + faixa própria 12+ do membro; linhas do mesmo produto somam', () => {
    const r = simularGrupoPreco(
      { ativo: true, modo: 'produto', faixas: [] },
      [
        {
          produtoId: A,
          nome: 'BRAHMA',
          quantidade: 4,
          produto: {
            precoVenda: 3.49,
            faixas: [{ lojaId: null, quantidadeInicial: 12, quantidadeFinal: null, preco: 3.15 }],
          },
        },
        { produtoId: B, nome: 'SKOL', quantidade: 8, produto: { precoVenda: 3.39 } },
      ],
      params,
    );
    // 4 + 8 = 12 do grupo ativam a faixa 12+ da Brahma
    expect(r[0]).toMatchObject({ preco: 3.15, origem: 'quantidade', total: 12.6 });
    const mesmo = simularGrupoPreco(
      { ativo: false, modo: 'produto', faixas: [] },
      [
        { produtoId: A, nome: 'BRAHMA', quantidade: 6, produto: p },
        { produtoId: A, nome: 'BRAHMA', quantidade: 6, produto: p },
      ],
      params,
    );
    expect(mesmo.map((l) => l.origem)).toEqual(['atacado', 'atacado']);
  });

  it('mix: 6 Brahma + 6 Skol = 12 latas no preço de oferta; inativo conta só o próprio produto', () => {
    const grupo = {
      ativo: true,
      modo: 'grupo' as const,
      faixas: [{ lojaId: null, quantidadeInicial: 12, quantidadeFinal: null, preco: 2.99 }],
    };
    const linhas = [
      { produtoId: A, nome: 'BRAHMA', quantidade: 6, produto: { precoVenda: 3.49 } },
      { produtoId: B, nome: 'SKOL', quantidade: 6, produto: { precoVenda: 3.39 } },
    ];
    const r = simularGrupoPreco(grupo, linhas, params);
    expect(r.map((l) => [l.preco, l.origem])).toEqual([
      [2.99, 'grupo_mix'],
      [2.99, 'grupo_mix'],
    ]);
    expect(simularGrupoPreco({ ...grupo, ativo: false }, linhas, params).map((l) => l.origem)).toEqual([
      'varejo',
      'varejo',
    ]);
    // modo produto: a soma do grupo ativa o atacado de cada produto
    const r2 = simularGrupoPreco(
      { ativo: true, modo: 'produto', faixas: [] },
      [
        { produtoId: A, nome: 'BRAHMA', quantidade: 6, produto: p },
        {
          produtoId: B,
          nome: 'SKOL',
          quantidade: 6,
          produto: { precoVenda: 3.39, precoAtacado: 3.09, qtdMinimaAtacado: 12 },
        },
      ],
      params,
    );
    expect(r2.map((l) => l.preco)).toEqual([3.19, 3.09]);
  });
});

describe('schema do produto', () => {
  const base = { nome: 'CERV BRAHMA LT 350', unidadeId: UN, precoVenda: '3,49' };

  it('aceita o mínimo e normaliza decimais', () => {
    const r = criarProdutoSchema.parse(base);
    expect(r).toMatchObject({ tipo: 'simples', precoVenda: '3.4900', ativo: true, controlaEstoque: true });
  });

  it('EAN com DV errado, código repetido, dois principais e preço zerado', () => {
    const r = criarProdutoSchema.safeParse({
      ...base,
      precoVenda: '0',
      codigosBarras: [
        { codigo: '7891000315508', principal: true },
        { codigo: '7891000315507', principal: true },
        { codigo: '7891000315507', fator: 12 },
      ],
    });
    expect(campos(r)).toEqual([
      'codigosBarras',
      'codigosBarras.0.codigo',
      'codigosBarras.2.codigo',
      'precoVenda',
    ]);
  });

  it('combo: ao menos uma posição, alternativa diferente do padrão e só com "Permite troca"', () => {
    expect(campos(criarProdutoSchema.safeParse({ ...base, tipo: 'kit' }))).toEqual(['componentes']);
    const r = criarProdutoSchema.safeParse({
      ...base,
      tipo: 'kit',
      componentes: [
        {
          tipo: 'kit',
          componenteId: A,
          quantidade: 1,
          permiteSubstituicao: true,
          alternativas: [{ produtoId: A }],
        },
        { tipo: 'kit', componenteId: B, quantidade: 2, alternativas: [{ produtoId: C }] },
        { tipo: 'kit', componenteId: C, quantidade: 1, permiteSubstituicao: true },
      ],
    });
    expect(campos(r)).toEqual([
      'componentes.0.alternativas.0.produtoId',
      'componentes.1.permiteSubstituicao',
      'componentes.2.alternativas',
    ]);
  });

  it('vasilhame, grupo de preço, tributação (5405 × CST, CEST com ST)', () => {
    const r = criarProdutoSchema.safeParse({
      ...base,
      vasilhameProdutoId: A,
      permiteFracao: true,
      grupoPrecoQuantidadeId: B,
      cfopVendaEstado: '5405',
      icmsSituacao: '102',
    });
    expect(campos(r)).toEqual(['grupoPrecoQuantidadeId', 'icmsSituacao', 'vasilhameQuantidade']);
    const st = criarProdutoSchema.safeParse({ ...base, cfopVendaEstado: '5405', icmsSituacao: '500' });
    expect(campos(st)).toEqual(['cest']);
  });

  it('faixas sobrepostas na mesma loja', () => {
    expect(
      faixasSobrepostas([
        { lojaId: null, quantidadeInicial: '6', quantidadeFinal: '12' },
        { lojaId: null, quantidadeInicial: '12', quantidadeFinal: null },
        { lojaId: LOJA, quantidadeInicial: '6', quantidadeFinal: null },
        { lojaId: null, quantidadeInicial: '10', quantidadeFinal: '20' },
      ]),
    ).toEqual([3]);
  });
});

describe('grupo de preço e restrição de horário', () => {
  it('modo grupo exige faixa', () => {
    expect(campos(criarGrupoPrecoSchema.safeParse({ nome: 'MIX', modoPreco: 'grupo' }))).toEqual(['faixas']);
  });
  it('restrição exige categoria ou idade e horário diferente', () => {
    const r = criarRestricaoHorarioSchema.safeParse({
      descricao: 'Lei',
      horaInicio: '22:00',
      horaFim: '22:00',
    });
    expect(campos(r)).toEqual(['categoriaId', 'horaFim']);
    const ok = criarRestricaoHorarioSchema.parse({
      descricao: 'Lei',
      idadeMinimaProduto: 18,
      horaInicio: '22:00',
      horaFim: '06:00',
      diasSemana: [6, 5, 5],
    });
    expect(ok).toMatchObject({ horaInicio: '22:00:00', diasSemana: [5, 6] });
  });
});

describe('tipos sem suporte (F2-B1; D43)', () => {
  it('as chaves existem no catálogo, desligadas por padrão, e não descem ao PDV', () => {
    for (const chave of Object.values(CHAVES_TIPO_PRODUTO)) {
      const def = CONFIGURACOES_POR_CHAVE.get(chave!);
      expect(def, chave).toMatchObject({ padrao: false, loja: false, pdv: false });
    }
  });

  it('padrão: todos os tipos menos Com variações e Com complementos; cada chave libera o seu', () => {
    expect(tiposProdutoHabilitados(() => false)).toEqual(
      TIPOS_PRODUTO.filter((t) => t !== 'com_variacoes' && t !== 'com_complementos'),
    );
    expect(tiposProdutoHabilitados(() => true)).toEqual([...TIPOS_PRODUTO]);
    const soVariacoes = tiposProdutoHabilitados((c) => c === 'produtos.variacoes_habilitadas');
    expect(soVariacoes).toContain('com_variacoes');
    expect(soVariacoes).not.toContain('com_complementos');
  });

  it('recusa só a escolha do tipo travado: o produto já gravado com ele continua aceito', () => {
    const padrao = tiposProdutoHabilitados(() => false);
    // Criação (sem tipo gravado).
    expect(motivoTipoProdutoBloqueado('com_variacoes', null, padrao)).toMatch(/^Tipo disponível em breve/);
    expect(motivoTipoProdutoBloqueado('com_complementos', null, padrao)).toContain('Com complementos');
    expect(motivoTipoProdutoBloqueado('simples', null, padrao)).toBeNull();
    // Edição: o legado mantém o tipo; trocar para o tipo travado é recusado; sair dele é livre.
    expect(motivoTipoProdutoBloqueado('com_complementos', 'com_complementos', padrao)).toBeNull();
    expect(motivoTipoProdutoBloqueado('com_variacoes', 'simples', padrao)).not.toBeNull();
    expect(motivoTipoProdutoBloqueado('simples', 'com_variacoes', padrao)).toBeNull();
    // Chave ligada: livre.
    expect(motivoTipoProdutoBloqueado('com_variacoes', null, [...TIPOS_PRODUTO])).toBeNull();
  });
});

describe('produtos relacionados e "Ajustar" (F2-B12; ERP 8.2.8, 8.2.11)', () => {
  const base = { nome: 'CERV LATA', unidadeId: UN, precoVenda: '5' };

  it('relacionados: ausente fica ausente (a API mantém os gravados); repetido com o mesmo tipo é recusado', () => {
    const sem = criarProdutoSchema.parse(base);
    expect(sem.relacionados).toBeUndefined();
    const com = criarProdutoSchema.parse({ ...base, relacionados: [{ relacionadoId: A }] });
    expect(com.relacionados).toEqual([
      { id: null, relacionadoId: A, tipo: 'sugestao', ordem: 0, criarInversa: false },
    ]);
    const repetido = criarProdutoSchema.safeParse({
      ...base,
      relacionados: [
        { relacionadoId: A, tipo: 'sugestao' },
        { relacionadoId: A.toUpperCase(), tipo: 'sugestao' },
      ],
    });
    expect(campos(repetido)).toEqual(['relacionados.1.relacionadoId']);
    // O mesmo produto com outro tipo é outra relação.
    expect(
      criarProdutoSchema.safeParse({
        ...base,
        relacionados: [
          { relacionadoId: A, tipo: 'sugestao' },
          { relacionadoId: A, tipo: 'acessorio' },
        ],
      }).success,
    ).toBe(true);
  });

  it('ajuste: nova quantidade ≥ 0, motivo obrigatório, hora opcional e não futura', () => {
    const ok = ajusteEstoqueProdutoSchema.parse({ estoqueId: B, quantidade: '12,5', motivo: 'Inventário' });
    expect(ok).toMatchObject({ estoqueId: B, tipoEstoqueId: null, quantidade: '12.500', observacoes: null });
    expect(ok.dataContagem).toBeUndefined();
    expect(
      ajusteEstoqueProdutoSchema.parse({ estoqueId: B, quantidade: '0', motivo: 'x', dataContagem: '' }),
    ).toMatchObject({ quantidade: '0.000' });
    const ruim = ajusteEstoqueProdutoSchema.safeParse({
      estoqueId: C,
      quantidade: '-1',
      motivo: ' ',
      dataContagem: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(campos(ruim)).toEqual(['dataContagem', 'motivo', 'quantidade']);
  });
});

describe('fornecedores do produto e cadastro rápido (F2-B13; ERP 8.2.14, 13.3)', () => {
  const base = { nome: 'CERV LATA', unidadeId: UN, precoVenda: '5' };

  it('ausente fica ausente (a API mantém os gravados); a linha normaliza código, EAN, unidade e fator', () => {
    expect(criarProdutoSchema.parse(base).fornecedores).toBeUndefined();
    const com = criarProdutoSchema.parse({
      ...base,
      fornecedores: [
        {
          fornecedorId: A,
          codigoFornecedor: '  CX24-ABC ',
          eanFornecedor: ' 7891000315507 ',
          unidadeCompra: ' cx ',
          fator: '24',
          custoFornecedor: '2,95',
        },
      ],
    });
    expect(com.fornecedores).toEqual([
      {
        id: null,
        fornecedorId: A,
        codigoFornecedor: 'CX24-ABC',
        eanFornecedor: '7891000315507',
        unidadeCompra: 'CX',
        fator: '24.000',
        custoFornecedor: '2.9500',
        principal: false,
        moverVinculo: false,
      },
    ]);
  });

  it('recusa EAN inválido, fator zero, código repetido no mesmo fornecedor e dois principais', () => {
    expect(
      campos(
        criarProdutoSchema.safeParse({
          ...base,
          fornecedores: [
            { fornecedorId: A, eanFornecedor: '7891000315508', fator: '0', unidadeCompra: 'FARDO12' },
          ],
        }),
      ),
    ).toEqual(['fornecedores.0.eanFornecedor', 'fornecedores.0.fator', 'fornecedores.0.unidadeCompra']);
    expect(
      campos(
        criarProdutoSchema.safeParse({
          ...base,
          fornecedores: [
            { fornecedorId: A, codigoFornecedor: 'X', principal: true },
            { fornecedorId: A.toUpperCase(), codigoFornecedor: 'X', principal: true },
            { fornecedorId: B },
            { fornecedorId: B },
          ],
        }),
      ),
    ).toEqual(['fornecedores', 'fornecedores.1.codigoFornecedor', 'fornecedores.3.fornecedorId']);
    // O mesmo fornecedor com códigos diferentes (CX 12 e CX 24) são dois vínculos; o código diferencia maiúsculas.
    expect(
      criarProdutoSchema.safeParse({
        ...base,
        fornecedores: [
          { fornecedorId: A, codigoFornecedor: 'CX12' },
          { fornecedorId: A, codigoFornecedor: 'cx12' },
          { fornecedorId: A },
        ],
      }).success,
    ).toBe(true);
    expect(chaveFornecedorProduto({ fornecedorId: A.toUpperCase(), codigoFornecedor: null })).toBe(`${A}:`);
  });

  it(`aceita até ${MAXIMO_FORNECEDORES_PRODUTO} vínculos; um a mais é recusado na lista`, () => {
    const linhas = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ fornecedorId: A, codigoFornecedor: `COD-${i}` }));
    expect(MAXIMO_FORNECEDORES_PRODUTO).toBe(30);
    expect(criarProdutoSchema.safeParse({ ...base, fornecedores: linhas(30) }).success).toBe(true);
    const r = criarProdutoSchema.safeParse({ ...base, fornecedores: linhas(31) });
    expect(campos(r)).toEqual(['fornecedores']);
    expect(r.error!.issues[0]!.message).toBe('No máximo 30 fornecedores');
  });

  it('cadastro rápido: o documento é normalizado e conferido; telefone com DDD; endereço opcional e completo', () => {
    expect(tipoPessoaDoDocumento('11222333000181')).toBe('PJ');
    expect(tipoPessoaDoDocumento('52998224725')).toBe('PF');
    expect(tipoPessoaDoDocumento('123')).toBeNull();
    const ok = cadastroRapidoFornecedorSchema.parse({
      cpfCnpj: '11.222.333/0001-81',
      nome: ' Distribuidora ',
      rgIe: ' isento ',
      telefone: '(41) 99999-0000',
    });
    expect(ok).toEqual({
      cpfCnpj: '11222333000181',
      nome: 'Distribuidora',
      apelido: null,
      rgIe: 'ISENTO',
      telefone: '41999990000',
      endereco: null,
    });
    expect(
      campos(
        cadastroRapidoFornecedorSchema.safeParse({
          cpfCnpj: '11.222.333/0001-80',
          nome: 'D',
          telefone: '99999-0000',
          endereco: { cep: '80000-000' },
        }),
      ),
    ).toEqual([
      'cpfCnpj',
      'endereco.bairro',
      'endereco.logradouro',
      'endereco.municipioIbge',
      'endereco.numero',
      'endereco.uf',
      'nome',
      'telefone',
    ]);
    expect(campos(cadastroRapidoFornecedorSchema.safeParse({ cpfCnpj: '', nome: 'Distribuidora' }))).toEqual([
      'cpfCnpj',
    ]);
  });
});

describe('lotes do bloco Validade (F2-B17; ERP 8.2.12)', () => {
  const base = { nome: 'IOGURTE 170G', unidadeId: UN, precoVenda: '5' };

  it('ausente fica ausente (a API mantém os gravados); a linha normaliza o lote e as datas vazias', () => {
    expect(criarProdutoSchema.parse(base).lotes).toBeUndefined();
    const com = criarProdutoSchema.parse({
      ...base,
      lotes: [{ estoqueId: '', lote: '  L2611 ', validade: '2026-11-30', fabricacao: '', fornecedorId: '' }],
    });
    expect(com.lotes).toEqual([
      {
        id: null,
        estoqueId: null,
        lote: 'L2611',
        validade: '2026-11-30',
        fabricacao: null,
        fornecedorId: null,
        ativo: true,
      },
    ]);
  });

  it('lote obrigatório até 30, data que existe, fabricação até a validade', () => {
    const r = criarProdutoSchema.safeParse({
      ...base,
      lotes: [
        { lote: '' },
        { lote: 'X'.repeat(31) },
        { lote: 'L1', validade: '2026-02-30' },
        { lote: 'L2', validade: '2026-11-01', fabricacao: '2026-11-02' },
        { lote: 'L3', validade: '2026-11-01', fabricacao: '2026-11-01' },
      ],
    });
    expect(campos(r)).toEqual(['lotes.0.lote', 'lotes.1.lote', 'lotes.2.validade', 'lotes.3.fabricacao']);
  });

  it('um lote por (loja, texto): o mesmo texto em lojas diferentes passa; os tipos sem saldo próprio não têm lote', () => {
    const r = criarProdutoSchema.safeParse({
      ...base,
      lotes: [
        { lote: 'L1' },
        { lote: 'L1', estoqueId: A },
        { lote: 'L1', estoqueId: A.toUpperCase() },
        { lote: 'l1' },
      ],
    });
    expect(campos(r)).toEqual(['lotes.2.lote']);
    expect(chaveLoteProduto({ estoqueId: null, lote: 'L1' })).toBe(':L1');
    expect(
      campos(
        criarProdutoSchema.safeParse({
          ...base,
          tipo: 'servico',
          controlaEstoque: false,
          lotes: [{ lote: 'L1' }],
        }),
      ),
    ).toEqual(['lotes']);
    expect(
      campos(criarProdutoSchema.safeParse({ ...base, tipo: 'servico', controlaEstoque: false, lotes: [] })),
    ).toEqual([]);
    // Produzido (a venda baixa os insumos) e "Com variações" (o saldo é por variação) também não têm saldo próprio:
    // a mesma lista do "Ajustar" e do recebimento (TIPOS_SEM_SALDO_PROPRIO).
    expect(TIPOS_SEM_SALDO_PROPRIO).toEqual(['kit', 'servico', 'produzido', 'com_variacoes']);
    for (const tipo of ['produzido', 'com_variacoes'] as const)
      expect(
        campos(criarProdutoSchema.safeParse({ ...base, tipo, lotes: [{ lote: 'L1' }] })).filter((c) =>
          c.startsWith('lotes'),
        ),
        tipo,
      ).toEqual(['lotes']);
    expect(
      campos(criarProdutoSchema.safeParse({ ...base, tipo: 'materia_prima', lotes: [{ lote: 'L1' }] })),
    ).toEqual([]);
  });

  it('o teto vale para o que muda numa gravação (os gravados sem mudança não vão); o excluído não vem alterado', () => {
    const muitos = (n: number) => Array.from({ length: n }, (_, i) => ({ lote: `L${i}` }));
    expect(campos(criarProdutoSchema.safeParse({ ...base, lotes: muitos(MAXIMO_LOTES_PRODUTO) }))).toEqual(
      [],
    );
    const teto = criarProdutoSchema.safeParse({ ...base, lotes: muitos(MAXIMO_LOTES_PRODUTO + 1) });
    expect(campos(teto)).toEqual(['lotes']);
    expect(teto.error!.issues[0]!.message).toBe('No máximo 200 lotes alterados numa gravação');
    const ids = Array.from({ length: MAXIMO_LOTES_PRODUTO + 1 }, () => crypto.randomUUID());
    expect(campos(criarProdutoSchema.safeParse({ ...base, lotesExcluidos: ids }))).toEqual([
      'lotesExcluidos',
    ]);
    expect(criarProdutoSchema.parse({ ...base, lotesExcluidos: [A] }).lotesExcluidos).toEqual([A]);

    // A mesma linha gravada duas vezes, ou alterada e excluída na mesma gravação.
    expect(
      campos(
        criarProdutoSchema.safeParse({
          ...base,
          lotes: [
            { id: A, lote: 'L1' },
            { id: A.toUpperCase(), lote: 'L2' },
          ],
          lotesExcluidos: [A],
        }),
      ),
    ).toEqual(['lotes.1.id', 'lotesExcluidos.0']);
  });
});

describe('consulta do histórico de preços (F2-B37)', () => {
  it('aceita a página, o tipo, a loja (ou o geral) e o período; vazio é sem filtro', () => {
    expect(historicoPrecosQuerySchema.parse({})).toEqual({
      pagina: 1,
      tamanho: 20,
      dataInicial: null,
      dataFinal: null,
    });
    expect(
      historicoPrecosQuerySchema.parse({
        pagina: '2',
        tamanho: '50',
        tipo: 'quantidade',
        loja: A,
        dataInicial: '2026-11-01',
        dataFinal: '2026-11-01',
      }),
    ).toMatchObject({ pagina: 2, tamanho: 50, tipo: 'quantidade', loja: A });
    expect(historicoPrecosQuerySchema.parse({ loja: 'geral', tipo: '' })).toMatchObject({ loja: 'geral' });
  });

  it('recusa o tipo e a loja desconhecidos, a data que não existe e o período invertido', () => {
    const caminhos = (v: unknown) => {
      const r = historicoPrecosQuerySchema.safeParse(v);
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    };
    expect(caminhos({ tipo: 'markup' })).toEqual(['tipo']);
    expect(caminhos({ loja: 'loja-1' })).toEqual(['loja']);
    expect(caminhos({ dataInicial: '2026-02-30' })).toEqual(['dataInicial']);
    expect(caminhos({ dataInicial: '2026-11-10', dataFinal: '2026-11-01' })).toEqual(['dataFinal']);
  });
});
