import { describe, expect, it } from 'vitest';
import {
  confirmarImportacaoSchema,
  lerBalancaPlanilha,
  lerBooleanoPlanilha,
  lerCodigoPlanilha,
  lerExcluirPlanilha,
  lerListaCategorias,
  lerNcmPlanilha,
  lerNumeroPlanilha,
  mapearColunas,
  mesmoDecimal,
  nomesParecidos,
  opcoesImportacaoSchema,
  resolverUnidadePlanilha,
  resumirLinhas,
} from './importacao.js';

describe('importação por planilha (ERP 8.5, 8.6)', () => {
  it('reconhece o nosso layout e os cabeçalhos do Nuvem3 sem acento/caixa/pontuação', () => {
    const m = mapearColunas(
      [
        'Ref. Interna',
        'Produto',
        'Preço Custo',
        'Venda',
        'Atacado',
        'iFood',
        'Est. Mínimo',
        'Est. Atual',
        'Unidade',
        'NCM',
        'Coluna X',
        'ean',
        'EAN',
      ],
      'produtos',
    );
    expect(m.indices).toEqual({
      codigo_interno: 0,
      nome: 1,
      preco_custo: 2,
      preco_venda: 3,
      preco_atacado: 4,
      preco_ifood: 5,
      estoque_minimo: 6,
      estoque_atual: 7,
      unidade: 8,
      ncm: 9,
      ean: 11,
    });
    expect(m.ignoradas).toEqual(['Coluna X']);
    expect(m.repetidas).toEqual(['EAN']);
    const c = mapearColunas(['CPF/CNPJ', 'Razão Social', 'Município', 'E-mail', 'cep'], 'clientes');
    expect(c.indices).toEqual({ cpf_cnpj: 0, nome: 1, cidade: 2, email: 3, cep: 4 });
  });

  it('lê números pt-BR, moeda e percentual; códigos numéricos do Excel viram texto', () => {
    expect(lerNumeroPlanilha('1.234,56')).toBe(1234.56);
    expect(lerNumeroPlanilha('R$ 9,90')).toBe(9.9);
    expect(lerNumeroPlanilha('35%')).toBe(35);
    expect(lerNumeroPlanilha('1234.5')).toBe(1234.5);
    expect(lerNumeroPlanilha('1.000')).toBe(1000);
    expect(lerNumeroPlanilha(12)).toBe(12);
    expect(lerNumeroPlanilha('')).toBeNull();
    expect(lerNumeroPlanilha('abc')).toBeNaN();
    expect(lerCodigoPlanilha(7891149103102)).toBe('7891149103102');
    expect(lerCodigoPlanilha(' 22030000 ')).toBe('22030000');
    expect(lerBooleanoPlanilha('Não')).toBe(false);
    expect(lerBooleanoPlanilha('S')).toBe(true);
    expect(lerBooleanoPlanilha('talvez')).toBeNull();
  });

  it('opções do formulário (multipart) e resumo das linhas', () => {
    expect(
      opcoesImportacaoSchema.parse({
        atualizarEstoque: 'true',
        lojaId: '',
        estoqueId: '',
        dataContagem: '2026-11-04T18:30:00-03:00',
      }),
    ).toEqual({
      atualizarEstoque: true,
      atualizarEstoqueMinimo: false,
      atualizarPrecos: false,
      criarMarcasCategorias: false,
      dataContagem: '2026-11-04T21:30:00.000Z',
    });
    // "Atualizar estoque" exige a hora da contagem (F2-B11), que não pode ser futura nem inválida.
    const erroEm = (v: Record<string, unknown>) =>
      opcoesImportacaoSchema.safeParse(v).error?.issues.map((i) => [i.path.join('.'), i.message]);
    expect(erroEm({ atualizarEstoque: 'true' })).toEqual([
      ['dataContagem', 'Informe a data/hora da contagem'],
    ]);
    expect(erroEm({ atualizarEstoque: 'true', dataContagem: 'ontem' })).toEqual([
      ['dataContagem', 'Data/hora inválida'],
    ]);
    expect(
      erroEm({ atualizarEstoque: 'true', dataContagem: new Date(Date.now() + 3_600_000).toISOString() }),
    ).toEqual([['dataContagem', 'A data não pode ser futura']]);
    expect(erroEm({ atualizarEstoque: 'false' })).toBeUndefined();
    expect(
      confirmarImportacaoSchema.safeParse({
        arquivoId: '0190f1a0-0000-7000-8000-000000000000',
        atualizarEstoque: true,
      }).success,
    ).toBe(false);
    expect(
      resumirLinhas([
        {
          linha: 2,
          acao: 'criar',
          descricao: 'A',
          registroId: null,
          erros: [],
          avisos: [{ codigo: 'sem_preco', campo: null, mensagem: '' }],
        },
        { linha: 3, acao: 'ignorar', descricao: 'B', registroId: null, erros: ['x'], avisos: [] },
        {
          linha: 4,
          acao: 'atualizar',
          descricao: 'C',
          registroId: 'id',
          erros: [],
          avisos: [
            { codigo: 'ean_duplicado', campo: 'ean', mensagem: '' },
            { codigo: 'ean_duplicado', campo: 'ean', mensagem: '' },
          ],
        },
      ]),
    ).toEqual({
      linhas: 3,
      criar: 1,
      atualizar: 1,
      sem_alteracao: 0,
      inativar: 0,
      ignorar: 1,
      comAviso: 2,
      porAviso: { sem_preco: 1, ean_duplicado: 1 },
    });
  });
});

describe('planilha de produtos do Nuvem3 (edição em massa)', () => {
  const CABECALHO_NUVEM3 = [
    'IdProduto',
    'NomeProduto',
    'CodigoInterno',
    'CodigoBarras',
    'NCM',
    'PrecoCusto',
    'PrecoPJ',
    'PrecoVenda',
    'EstoqueMinimo',
    'EstoqueAtual',
    'Categoria',
    'Unidade',
    'UsaNoMenuDigital',
    'UsaBalancaEtiquetadoraStr',
    'Excluir',
  ];

  it('reconhece as 15 colunas; PrecoPJ fica ignorada com o motivo', () => {
    const m = mapearColunas(CABECALHO_NUVEM3, 'produtos');
    expect(m.indices).toEqual({
      codigo: 0,
      nome: 1,
      codigo_interno: 2,
      ean: 3,
      ncm: 4,
      preco_custo: 5,
      preco_venda: 7,
      estoque_minimo: 8,
      estoque_atual: 9,
      categoria: 10,
      unidade: 11,
      usa_menu_digital: 12,
      balanca: 13,
      excluir: 14,
    });
    expect(m.ignoradas).toEqual([expect.stringMatching(/^PrecoPJ \(sem equivalente no GenesisPDV/)]);
  });

  it('categoria: vírgula não seguida de espaço separa; vírgula final é ignorada', () => {
    expect(lerListaCategorias('CERVEJA,')).toEqual(['CERVEJA']);
    expect(lerListaCategorias('MERCEARIA,PIPOCA,')).toEqual(['MERCEARIA', 'PIPOCA']);
    expect(lerListaCategorias('NICSALTS, JUICE E PODS,')).toEqual(['NICSALTS, JUICE E PODS']);
    expect(lerListaCategorias('DIVERSOS,TABACARIA,NICSALTS, JUICE E PODS,')).toEqual([
      'DIVERSOS',
      'TABACARIA',
      'NICSALTS, JUICE E PODS',
    ]);
    expect(lerListaCategorias('CERVEJA > LATA')).toEqual(['CERVEJA > LATA']);
    expect(lerListaCategorias(',')).toEqual([]);
  });

  it('NCM com 7 dígitos ganha o zero à esquerda', () => {
    expect(lerNcmPlanilha('9030090')).toEqual({ ncm: '09030090', completado: true });
    expect(lerNcmPlanilha('2203.00.00')).toEqual({ ncm: '22030000', completado: false });
    expect(lerNcmPlanilha('123')).toEqual({ ncm: '123', completado: false });
    expect(lerNcmPlanilha('')).toBeNull();
    expect(lerNcmPlanilha(null)).toBeNull();
  });

  it('unidade por sigla, descrição ou sinônimo do Nuvem3 (sem acento/caixa)', () => {
    const unidades = [
      { sigla: 'UN', descricao: 'Unidade' },
      { sigla: 'CJ', descricao: 'Conjunto' },
      { sigla: 'PCT', descricao: 'Pacote' },
      { sigla: 'KG', descricao: 'Quilograma' },
      { sigla: 'PC', descricao: 'Peça' },
      { sigla: 'DZ', descricao: 'Dúzia' },
      { sigla: 'FD', descricao: 'Fardo' },
    ];
    const sigla = (t: string) => resolverUnidadePlanilha(t, unidades)?.sigla ?? null;
    expect(sigla('Unidade')).toBe('UN');
    expect(sigla('UNIDADE')).toBe('UN');
    expect(sigla('un')).toBe('UN');
    expect(sigla('Conjunto')).toBe('CJ');
    expect(sigla('Pacote')).toBe('PCT');
    expect(sigla('Quilo')).toBe('KG');
    expect(sigla('PEÇA')).toBe('PC');
    expect(sigla('Duzia')).toBe('DZ');
    expect(sigla('fardos')).toBe('FD');
    expect(sigla('Garrafa')).toBeNull();
    expect(sigla('Litro')).toBeNull();
  });

  it('Excluir, balança e comparação decimal', () => {
    for (const v of ['S', 'Sim', 'x', '1', 'true', 1, true]) expect(lerExcluirPlanilha(v)).toBe(true);
    for (const v of [null, undefined, '', '  ', 'N', 'Não', '0', 0, false])
      expect(lerExcluirPlanilha(v)).toBe(false);
    expect(lerExcluirPlanilha('talvez')).toBeNull();
    expect(lerExcluirPlanilha('Ativo')).toBeNull();
    expect(lerBalancaPlanilha('Peso')).toBe('peso');
    expect(lerBalancaPlanilha('Sim')).toBe('peso');
    expect(lerBalancaPlanilha('Unidade')).toBe('unidade');
    expect(lerBalancaPlanilha('Não')).toBe('nao_usa');
    expect(lerBalancaPlanilha('')).toBeNull();
    expect(lerBalancaPlanilha('talvez')).toBe(false);
    expect(mesmoDecimal('2.5', '2.50')).toBe(true);
    expect(mesmoDecimal('4.4900', '4.49')).toBe(true);
    expect(mesmoDecimal('0.1', '0.10000000000000001')).toBe(false);
    expect(mesmoDecimal(null, '')).toBe(true);
    expect(mesmoDecimal(null, '0')).toBe(false);
  });

  it('nomes totalmente diferentes (proteção do cruzamento pelo código)', () => {
    expect(nomesParecidos('CERVEJA - AMSTEL ULTRA LN 330ML', 'CERV AMSTEL ULTRA 330')).toBe(true);
    expect(nomesParecidos('CERVEJA - SKOL LT 350ML', 'CERVEJA - BRAHMA LT 350ML')).toBe(false);
    expect(nomesParecidos('AGUA CRYSTAL 500ML', 'CARVÃO 3KG')).toBe(false);
    expect(nomesParecidos('ÁGUA CRYSTAL', 'AGUA CRYSTAL S/ GAS')).toBe(true);
    expect(nomesParecidos('350ML', 'X 1L')).toBe(true);
    // Mesma categoria, marcas diferentes: as palavras de embalagem (LATA, LONG NECK, COLA, SEM GAS) não contam.
    expect(nomesParecidos('CERVEJA - SKOL LATA 350ML', 'CERVEJA - BRAHMA LATA 350ML')).toBe(false);
    expect(nomesParecidos('CERVEJA - HEINEKEN LONG NECK 330ML', 'CERVEJA - BUDWEISER LONG NECK 330ML')).toBe(
      false,
    );
    expect(nomesParecidos('REFRIGERANTE - COCA COLA 2L', 'REFRIGERANTE - PEPSI COLA 2L')).toBe(false);
    expect(nomesParecidos('AGUA - CRYSTAL SEM GAS 500ML', 'CARVAO - CARVAO SEM FUMACA 3KG')).toBe(false);
    expect(nomesParecidos('CERVEJA - SKOL PILSEN LATA', 'CERVEJA - BRAHMA PILSEN LATA')).toBe(false);
    // Mesma marca (1ª palavra), abreviação ou a maioria das palavras em comum: parecidos.
    expect(nomesParecidos('CERVEJA - HEINEKEN LONG NECK 330ML', 'CERV HEINE LN 330')).toBe(true);
    expect(nomesParecidos('CERVEJA - AMSTEL ULTRA LN 330ML', 'CERVEJA - AMSTEL ULTRA SLEEK 350ML')).toBe(
      true,
    );
    expect(nomesParecidos('REFRI - GUARANA ANTARCTICA 2L', 'REFRIGERANTE - GUARANA ANTARTICA 2L')).toBe(true);
    expect(nomesParecidos('CERVEJA - LATA 350ML', 'CERVEJA - LONG NECK')).toBe(true);
  });
});
