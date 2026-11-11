import { mapearColunas, TIPOS_PRODUTO, type OpcoesImportacao } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import type { LinhaPlanilha } from './planilha.js';
import {
  analisarProdutos,
  formatarDinheiro,
  formatarQuantidade,
  type EstadoProduto,
  type LinhaProduto,
  type ReferenciasProdutos,
} from './produtos.js';

const UN = '0190a000-0000-7000-8000-000000000001';
const CJ = '0190a000-0000-7000-8000-000000000002';
const CAT_CERVEJA = '0190a000-0000-7000-8000-0000000000c1';
const CAT_AGUA = '0190a000-0000-7000-8000-0000000000c2';
const CAT_ALIMENTOS = '0190a000-0000-7000-8000-0000000000c3';
const CAT_MERCEARIA = '0190a000-0000-7000-8000-0000000000c4';
const PRODUTO = '0190a000-0000-7000-8000-0000000000a1';

const CABECALHO = [
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

const ATUAL: EstadoProduto = {
  id: PRODUTO,
  codigo: 91000202,
  nome: 'CERVEJA - TESTE LN 330ML',
  tipo: 'simples',
  ativo: true,
  controlaEstoque: true,
  codigoInterno: null,
  unidadeId: UN,
  ncm: '22030000',
  cest: null,
  precoCusto: '3.2000',
  markupPct: '0.0000',
  precoVenda: '4.4900',
  precoAtacado: null,
  qtdMinimaAtacado: null,
  precoPromocional: null,
  precoMenuDigital: null,
  precoIfood: null,
  precoParcelado: null,
  cfopVendaEstado: null,
  icmsSituacao: null,
  icmsOrigem: null,
  icmsAliquota: null,
  pisSituacao: null,
  cofinsSituacao: null,
  ipiSituacao: null,
  localizacao: null,
  pesoG: null,
  descricaoCurta: null,
  marcaId: null,
  categoriaPrincipalId: CAT_CERVEJA,
  categorias: [CAT_CERVEJA],
  codigosBarras: ['7891149103102'],
  usaMenuDigital: false,
  balancaTipo: 'nao_usa',
  temPosicoes: false,
  estoqueMinimo: '12.000',
  precoLoja: null,
  saldo: '-3.000',
};

function referencias(): ReferenciasProdutos {
  const achado = { id: PRODUTO, nome: ATUAL.nome, tipo: 'simples', codigo: ATUAL.codigo };
  return {
    unidades: [
      { id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false },
      { id: CJ, sigla: 'CJ', descricao: 'Conjunto', permiteFracao: false },
    ],
    unidadePadrao: UN,
    marcas: new Map(),
    nomesMarcas: new Map(),
    categorias: new Map([
      ['cerveja', CAT_CERVEJA],
      ['agua', CAT_AGUA],
      ['alimentos', CAT_ALIMENTOS],
      ['alimentos>mercearia', CAT_MERCEARIA],
    ]),
    categoriasPorNome: new Map([
      ['cerveja', [CAT_CERVEJA]],
      ['agua', [CAT_AGUA]],
      ['alimentos', [CAT_ALIMENTOS]],
      ['mercearia', [CAT_MERCEARIA]],
    ]),
    nomesCategorias: new Map([
      [CAT_CERVEJA, 'CERVEJA'],
      [CAT_AGUA, 'ÁGUA'],
      [CAT_ALIMENTOS, 'ALIMENTOS'],
      [CAT_MERCEARIA, 'ALIMENTOS > MERCEARIA'],
    ]),
    ncms: new Set(['22030000', '09030090']),
    cfops: new Set(),
    porId: new Map(),
    porCodigo: new Map([[ATUAL.codigo, { ...achado, excluido: false }]]),
    porCodigoInterno: new Map(),
    porEan: new Map([['7891149103102', [{ ...achado, codigo_interno: null }]]]),
    codigosComponentes: new Set(),
    atuais: new Map([[PRODUTO, ATUAL]]),
    tiposHabilitados: TIPOS_PRODUTO.filter((t) => t !== 'com_variacoes' && t !== 'com_complementos'),
  };
}

const OPCOES: OpcoesImportacao = {
  lojaId: '0190a000-0000-7000-8000-0000000000f1',
  atualizarEstoque: true,
  atualizarEstoqueMinimo: true,
  atualizarPrecos: true,
  criarMarcasCategorias: false,
};

function analisarCom(
  ajuste: {
    ref?: Partial<ReferenciasProdutos>;
    opcoes?: Partial<OpcoesImportacao>;
    estoqueNegativo?: boolean;
  },
  ...linhas: Array<Array<string | number | null>>
) {
  const mapa = mapearColunas(CABECALHO, 'produtos');
  const planilha: LinhaPlanilha[] = linhas.map((valores, i) => ({ numero: i + 2, valores }));
  const opcoes = { ...OPCOES, ...ajuste.opcoes };
  return analisarProdutos(planilha, mapa.indices, { ...referencias(), ...ajuste.ref }, opcoes, {
    criarMarcas: opcoes.criarMarcasCategorias,
    criarCategorias: opcoes.criarMarcasCategorias,
    verCusto: true,
    estoqueNegativo: ajuste.estoqueNegativo ?? true,
  });
}
const analisar = (...linhas: Array<Array<string | number | null>>) => analisarCom({}, ...linhas);

// IdProduto, Nome, Interno, EAN, NCM, Custo, PJ, Venda, Mín., Atual, Categoria, Unidade, Menu, Balança, Excluir
const IGUAL = [
  91000202,
  'CERVEJA - TESTE LN 330ML',
  null,
  7891149103102,
  22030000,
  3.2,
  0,
  4.49,
  12,
  -3,
  'CERVEJA,',
  'Unidade',
  null,
  null,
  null,
];

describe('análise da planilha do Nuvem3 (identificação pelo código e o que muda)', () => {
  it('mesmo produto, valores iguais como decimal (3,2 = 3.2000; -3 = -3.000): sem_alteracao, nada a gravar', () => {
    const [l] = analisar(IGUAL);
    expect(l).toMatchObject({ acao: 'sem_alteracao', registroId: PRODUTO, erros: [], alteracoes: [] });
    expect(l!.dados).toEqual({});
    expect(l!.estoqueAtual).toBeNull();
    expect(l!.estoqueMinimo).toBeNull();
    // Estoque negativo que já é o saldo não é avisado de novo.
    expect(l!.avisos).toEqual([]);
  });

  it('só os campos alterados ficam na linha, com de → para formatado', () => {
    const linha = [...IGUAL];
    linha[7] = 4.99;
    linha[9] = 50;
    linha[10] = 'CERVEJA,ÁGUA,';
    linha[11] = 'Conjunto';
    linha[12] = 'Sim';
    const [l] = analisar(linha);
    expect(l!.acao).toBe('atualizar');
    expect(l!.alteracoes).toEqual([
      { campo: 'precoVenda', rotulo: 'Preço de venda', de: '4,49', para: '4,99' },
      { campo: 'usaMenuDigital', rotulo: 'Usa no menu digital', de: 'Não', para: 'Sim' },
      { campo: 'unidade', rotulo: 'Unidade', de: 'UN', para: 'CJ' },
      { campo: 'categorias', rotulo: 'Categorias', de: 'CERVEJA', para: 'CERVEJA, ÁGUA' },
      { campo: 'estoque_atual', rotulo: 'Estoque atual', de: '-3', para: '50' },
    ]);
    expect(l!.dados).toEqual({
      precoVenda: '4.99',
      usaMenuDigital: true,
      unidadeId: CJ,
      permiteFracao: false,
      categorias: [CAT_CERVEJA, CAT_AGUA],
      categoriaPrincipalId: CAT_CERVEJA,
    });
    expect(l!.estoqueMinimo).toBeNull();
    expect(l!.estoqueAtual).toBe('50');
  });

  it('código novo cria com o código; NCM de 7 dígitos completado; código inválido/repetido é erro', () => {
    const [novo, invalido, repetido] = analisar(
      [
        91999999,
        'ERVA - MATE TESTE 1KG',
        null,
        null,
        9030090,
        10,
        0,
        19.9,
        0,
        -1,
        null,
        'Pacote',
        null,
        null,
        null,
      ],
      ['12a', 'X', null, null, null, null, null, 1, null, null, null, null, null, null, null],
      [91999999, 'OUTRO', null, null, null, null, null, 1, null, null, null, null, null, null, null],
    );
    expect(novo).toMatchObject({
      acao: 'ignorar',
      erros: ['Unidade "Pacote" inexistente (Cadastros › Unidades)'],
    });
    expect(novo!.dados.ncm).toBe('09030090');
    expect(invalido!.erros[0]).toContain('Código "12a" inválido');
    expect(repetido!.erros).toEqual(['Código 91999999 repetido (linha 2)']);
    const [ok] = analisar([
      91999999,
      'ERVA - MATE TESTE 1KG',
      null,
      null,
      9030090,
      10,
      0,
      19.9,
      0,
      -1,
      null,
      'unidade',
      null,
      null,
      null,
    ]);
    expect(ok).toMatchObject({ acao: 'criar', codigo: 91999999, estoqueAtual: '-1' });
    expect(ok!.avisos.map((a) => a.codigo)).toEqual(['estoque_negativo']);
  });

  it('Excluir: existente → inativar (só o ativo); inexistente → ignorada com aviso', () => {
    const marcado = [...IGUAL];
    marcado[14] = 'S';
    marcado[7] = 99;
    const [inativar, semProduto] = analisar(marcado, [
      99999999,
      'NAO EXISTE',
      null,
      null,
      null,
      null,
      null,
      1,
      null,
      null,
      null,
      null,
      null,
      null,
      'Sim',
    ]);
    expect(inativar).toMatchObject({
      acao: 'inativar',
      dados: { ativo: false },
      alteracoes: [{ campo: 'ativo', rotulo: 'Ativo', de: 'Sim', para: 'Não' }],
    });
    expect(semProduto).toMatchObject({
      acao: 'ignorar',
      erros: [],
      avisos: [expect.objectContaining({ codigo: 'exclusao_sem_produto' })],
    });
  });

  it('código achado com nome totalmente diferente: aviso codigo_conflito (não bloqueia)', () => {
    const linha = [...IGUAL];
    linha[1] = 'CARVAO VEGETAL 3KG';
    const [l] = analisar(linha);
    expect(l!.acao).toBe('atualizar');
    expect(l!.avisos).toEqual([expect.objectContaining({ codigo: 'codigo_conflito', campo: 'nome' })]);
  });

  it('subcategoria achada pelo nome + categoria nova na mesma célula: a existente vai pelo id, não recriada na raiz', () => {
    const linha = [...IGUAL];
    linha[10] = 'MERCEARIA,PIPOCA NOVA,';
    const [l] = analisarCom({ opcoes: { criarMarcasCategorias: true } }, linha);
    expect(l!.categoriaNova).toEqual([
      { id: CAT_MERCEARIA, caminho: ['ALIMENTOS', 'MERCEARIA'] },
      { id: null, caminho: ['PIPOCA NOVA'] },
    ]);
    expect(l!.alteracoes).toContainEqual({
      campo: 'categorias',
      rotulo: 'Categorias',
      de: 'CERVEJA',
      para: 'ALIMENTOS > MERCEARIA, PIPOCA NOVA (nova)',
    });
  });

  it('categorias por célula limitadas (antes de criar qualquer uma)', () => {
    const linha = [...IGUAL];
    linha[10] = Array.from({ length: 51 }, (_, i) => `C${i},`).join('');
    const [l] = analisarCom({ opcoes: { criarMarcasCategorias: true } }, linha);
    expect(l).toMatchObject({ acao: 'ignorar', categoriaNova: null });
    expect(l!.erros).toEqual(['Categoria: 51 categorias na célula (máximo 50 por produto)']);
  });

  it('produto que não controla estoque: estoque atual fora do diff (sem atualizar fantasma)', () => {
    const linha = [...IGUAL];
    linha[9] = 7;
    const [l] = analisarCom(
      { ref: { atuais: new Map([[PRODUTO, { ...ATUAL, controlaEstoque: false }]]) } },
      linha,
    );
    expect(l).toMatchObject({ acao: 'sem_alteracao', estoqueAtual: null, alteracoes: [] });
    expect(l!.avisos).toEqual([
      expect.objectContaining({ codigo: 'outro', mensagem: expect.stringContaining('não controla estoque') }),
    ]);
  });

  it('saldo negativo sem permissão (Master ou config da loja): não lançado, com aviso', () => {
    const linha = [...IGUAL];
    linha[9] = -5;
    const [l] = analisarCom({ estoqueNegativo: false }, linha);
    expect(l).toMatchObject({ acao: 'sem_alteracao', estoqueAtual: null });
    expect(l!.avisos).toEqual([
      expect.objectContaining({
        codigo: 'estoque_negativo',
        mensagem: expect.stringContaining('não lançado'),
      }),
    ]);
    // O saldo que já é o da planilha não é avisado.
    expect(analisarCom({ estoqueNegativo: false }, IGUAL)[0]!.avisos).toEqual([]);
  });

  it('duas linhas no mesmo produto: a 2ª é erro (inclusive pelo EAN quando o código é de outra linha)', () => {
    const pelaEan = [...IGUAL];
    pelaEan[0] = 60000001;
    pelaEan[1] = 'CERVEJA - TESTE LN 330ML B';
    const [porEan, porCodigo] = analisar(pelaEan, IGUAL);
    // O código da 2ª linha é a identificação forte: ela fica com o produto e a do EAN é recusada.
    expect(porEan).toMatchObject({ acao: 'ignorar' });
    expect(porEan!.erros[0]).toContain('que é o da linha 3 (pelo código)');
    expect(porCodigo!.acao).toBe('sem_alteracao');
    const outra = [...pelaEan];
    outra[0] = 60000002;
    outra[14] = 'S';
    const [a, b] = analisar(pelaEan, outra);
    expect(a!.acao).toBe('atualizar');
    expect(b).toMatchObject({ acao: 'ignorar', registroId: PRODUTO });
    expect(b!.erros[0]).toContain('já identificado pela linha 2');
  });

  it('formatação da prévia', () => {
    expect(formatarDinheiro('4.4900')).toBe('4,49');
    expect(formatarDinheiro('0.1250')).toBe('0,125');
    expect(formatarDinheiro('3')).toBe('3,00');
    expect(formatarQuantidade('120.000')).toBe('120');
    expect(formatarQuantidade('-2.500')).toBe('-2,5');
    expect(formatarQuantidade(null)).toBeNull();
  });
});

describe('tipos sem suporte na planilha (F2-B1; D43)', () => {
  const COM_TIPO = ['IdProduto', 'NomeProduto', 'Tipo', 'PrecoVenda'];
  const analisarTipo = (ref: Partial<ReferenciasProdutos>, ...linhas: Array<Array<string | number | null>>) =>
    analisarProdutos(
      linhas.map((valores, i) => ({ numero: i + 2, valores })),
      mapearColunas(COM_TIPO, 'produtos').indices,
      { ...referencias(), ...ref },
      OPCOES,
    );
  const legado = (tipo: string): Partial<ReferenciasProdutos> => ({
    porCodigo: new Map([
      [ATUAL.codigo, { id: PRODUTO, nome: ATUAL.nome, tipo, codigo: ATUAL.codigo, excluido: false }],
    ]),
    atuais: new Map([[PRODUTO, { ...ATUAL, tipo }]]),
  });

  it('criar Com variações ou Com complementos é recusado com o motivo; Simples passa', () => {
    const linhas = analisarTipo(
      {},
      [null, 'LANCHE NOVO', 'Com complementos', 20],
      [null, 'CAMISETA NOVA', 'Com variações', 50],
      [null, 'AGUA NOVA', 'Simples', 2],
    );
    expect(linhas.map((l) => l.acao)).toEqual(['ignorar', 'ignorar', 'criar']);
    expect(linhas[0]!.erros).toEqual([
      'Tipo disponível em breve: "Com complementos" ainda não tem suporte nesta versão',
    ]);
    expect(linhas[1]!.erros[0]).toMatch(/^Tipo disponível em breve: "Com variações"/);
  });

  it('o legado Com complementos reimporta sem alteração e atualiza o que mudou', () => {
    const ref = legado('com_complementos');
    const [igual] = analisarTipo(ref, [ATUAL.codigo, ATUAL.nome, 'Com complementos', 4.49]);
    expect(igual).toMatchObject({ acao: 'sem_alteracao', erros: [], alteracoes: [] });
    const [mudou] = analisarTipo(ref, [ATUAL.codigo, ATUAL.nome, 'Com complementos', 4.99]);
    expect(mudou).toMatchObject({ acao: 'atualizar', erros: [] });
    expect(mudou!.alteracoes?.map((a) => a.campo)).toEqual(['precoVenda']);
  });

  it('trocar um Simples para o tipo travado é recusado; o legado pode sair dele', () => {
    const [paraTravado] = analisarTipo({}, [ATUAL.codigo, ATUAL.nome, 'Com variações', 4.49]);
    expect(paraTravado!.acao).toBe('ignorar');
    expect(paraTravado!.erros[0]).toMatch(/^Tipo disponível em breve/);
    const [saida] = analisarTipo(legado('com_variacoes'), [ATUAL.codigo, ATUAL.nome, 'Simples', 4.49]);
    expect(saida).toMatchObject({ acao: 'atualizar', erros: [] });
    expect(saida!.alteracoes).toEqual([
      { campo: 'tipo', rotulo: 'Tipo', de: 'Com variações', para: 'Simples' },
    ]);
  });

  it('o legado Com variações não leva o estoque atual ao "Definir" (o saldo é por variação)', () => {
    const colunas = mapearColunas([...COM_TIPO, 'EstoqueAtual'], 'produtos').indices;
    const analisar = (estoque: number) =>
      analisarProdutos(
        [{ numero: 2, valores: [ATUAL.codigo, ATUAL.nome, 'Com variações', 4.49, estoque] }],
        colunas,
        { ...referencias(), ...legado('com_variacoes') },
        OPCOES,
      )[0]!;
    const doEstoque = (l: LinhaProduto) =>
      l.avisos.filter((a) => a.campo === 'estoque_atual').map((a) => a.mensagem);
    // Prévia e gravação iguais: nem "Estoque atual X → Y" nem a linha contada (o acerto recusaria sem a variação).
    const mudou = analisar(5);
    expect(mudou).toMatchObject({ acao: 'sem_alteracao', estoqueAtual: null, estoqueContado: null });
    expect(doEstoque(mudou)).toEqual([
      'Estoque atual ignorado: o estoque do produto com variações é por variação (Estoques › Acertos)',
    ]);
    // Igual ao saldo (-3): sem aviso, e também fora do "Definir".
    const igual = analisar(-3);
    expect(igual).toMatchObject({ acao: 'sem_alteracao', estoqueContado: null });
    expect(doEstoque(igual)).toEqual([]);
  });

  it('com a chave ligada o tipo é criado (variações continuam só pelo ERP, com a grade)', () => {
    const [l, v] = analisarTipo(
      { tiposHabilitados: [...TIPOS_PRODUTO] },
      [null, 'LANCHE NOVO', 'Com complementos', 20],
      [null, 'CAMISETA NOVA', 'Com variações', 50],
    );
    expect(l).toMatchObject({ acao: 'criar', erros: [] });
    expect(v!.erros).toEqual(['Produto com variações não é criado pela planilha: cadastre a grade no ERP']);
  });
});

describe('serviço pela planilha (F2-B40)', () => {
  it('serviço novo é criado sem controle de estoque (a regra do formulário); o já gravado fica sem alteração', () => {
    const mapa = mapearColunas(['codigo', 'nome', 'tipo', 'preco_venda'], 'produtos');
    const linhas: LinhaPlanilha[] = [{ numero: 2, valores: [700, 'ENTREGA TESTE', 'Serviço', 5] }];
    const ref = referencias();
    const [novo] = analisarProdutos(linhas, mapa.indices, ref, OPCOES);
    expect(novo).toMatchObject({ acao: 'criar', erros: [] });
    expect(novo!.dados.controlaEstoque).toBe(false);
    const gravado: EstadoProduto = {
      ...ATUAL,
      id: PRODUTO,
      codigo: 700,
      nome: 'ENTREGA TESTE',
      tipo: 'servico',
      controlaEstoque: false,
      precoVenda: '5.0000',
      categoriaPrincipalId: null,
      categorias: [],
      codigosBarras: [],
    };
    const achado = { id: PRODUTO, nome: gravado.nome, tipo: 'servico', codigo: 700 };
    const [igual] = analisarProdutos(
      linhas,
      mapa.indices,
      {
        ...ref,
        porCodigo: new Map([[700, { ...achado, excluido: false }]]),
        atuais: new Map([[PRODUTO, gravado]]),
      },
      OPCOES,
    );
    expect(igual).toMatchObject({ acao: 'sem_alteracao', alteracoes: [] });
  });
});
