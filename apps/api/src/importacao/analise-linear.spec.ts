/**
 * Custo da análise da importação (README da API › decisão 209): linear no número de linhas e de produtos por EAN e
 * por unidade, com o mesmo resultado de antes, e repartida em fatias que cedem o laço de eventos. O custo é medido
 * contando as leituras das listas de referência (determinístico), em duas escalas: o linear cresce como a escala, o
 * quadrático com o quadrado dela.
 */
import { mapearColunas, TIPOS_PRODUTO, type OpcoesImportacao } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { analisarClientes, analisarClientesCedendo, type ReferenciasClientes } from './clientes.js';
import type { LinhaPlanilha } from './planilha.js';
import {
  analisarProdutos,
  analisarProdutosCedendo,
  type LinhaProduto,
  type ReferenciasProdutos,
} from './produtos.js';

const UN = '0190a000-0000-7000-8000-000000000001';
const OPCOES: OpcoesImportacao = {
  lojaId: '0190a000-0000-7000-8000-0000000000f1',
  atualizarEstoque: false,
  atualizarEstoqueMinimo: false,
  atualizarPrecos: true,
  criarMarcasCategorias: false,
};
const CABECALHO = ['Id Produto', 'Produto', 'Ref. Interna', 'Código de Barras', 'Venda', 'Unidade'];
const mapa = mapearColunas(CABECALHO, 'produtos');

const E = '7890000000017';
const F = '7890000000024';
const G = '7890000000031';
const H = '7890000000048';

type Achado = ReferenciasProdutos['porEan'] extends Map<string, Array<infer A>> ? A : never;
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const produto = (n: number, interno: string | null = null): Achado => ({
  id: id(n),
  nome: `PRODUTO TESTE ${n}`,
  tipo: 'simples',
  codigo: n,
  codigo_interno: interno,
});

function referencias(ajuste: Partial<ReferenciasProdutos> = {}): ReferenciasProdutos {
  return {
    unidades: [{ id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false }],
    unidadePadrao: UN,
    marcas: new Map(),
    nomesMarcas: new Map(),
    categorias: new Map(),
    categoriasPorNome: new Map(),
    nomesCategorias: new Map(),
    ncms: new Set(),
    cfops: new Set(),
    porId: new Map(),
    porCodigo: new Map(),
    porCodigoInterno: new Map(),
    codigosComponentes: new Set(),
    porEan: new Map(),
    atuais: new Map(),
    tiposHabilitados: TIPOS_PRODUTO.filter((t) => t !== 'com_variacoes' && t !== 'com_complementos'),
    ...ajuste,
  };
}

const planilha = (...linhas: Array<Array<string | number | null>>): LinhaPlanilha[] =>
  linhas.map((valores, i) => ({ numero: i + 2, valores }));

/** O que a prévia e a tarefa usam de cada linha: a ação, o produto achado, os erros e os avisos. */
const resumo = (linhas: readonly LinhaProduto[]) =>
  linhas.map((l) => ({
    linha: l.linha,
    acao: l.acao,
    registroId: l.registroId,
    erros: l.erros,
    avisos: l.avisos.map((a) => `${a.codigo}|${a.campo}|${a.mensagem}`),
  }));

/** Lista que conta cada leitura de posição (o `filter`/`find`/`some` e o `for…of` passam por aqui). */
function contada<T>(itens: T[], contador: { leituras: number }): T[] {
  return new Proxy(itens, {
    get(alvo, chave, receptor) {
      if (typeof chave === 'string' && /^\d+$/.test(chave)) contador.leituras++;
      return Reflect.get(alvo, chave, receptor) as unknown;
    },
  });
}

describe('análise da importação de produtos: EAN em vários produtos', () => {
  it('o resultado da análise é o mesmo de antes (ações, produtos achados, erros e avisos)', () => {
    const p1 = produto(1);
    const p2 = produto(2, 'X2');
    const p3 = produto(3);
    const p4 = produto(4, 'X4');
    const p5 = produto(5);
    const p6 = produto(6, 'X6');
    const p7 = produto(7);
    const porCodigo = new Map([p1, p2, p7].map((p) => [p.codigo, { ...p, excluido: false }]));
    const ref = referencias({
      porCodigo,
      // O mesmo produto pode vir duas vezes no mesmo EAN (código do produto e da variação): conta como antes.
      porEan: new Map([
        [E, [p1, p1, p2, p3]],
        [F, [p4]],
        [G, [p5, p6]],
      ]),
    });
    const linhas = analisarProdutos(
      planilha(
        [null, 'SEM CHAVE', null, E, 5, null],
        [null, 'COM INTERNO NOVO', 'NOVO1', E, 5, null],
        [null, 'PELO EAN SEM INTERNO', 'NOVO2', G, 5, null],
        [null, 'EAN EM DOIS', null, G, 5, null],
        [2, 'PRODUTO TESTE 2', null, E, 5, null],
        [7, 'PRODUTO TESTE 7', null, F, 5, null],
        [null, 'PELO EAN', null, F, 5, null],
        [null, 'NOVO COM EAN', null, H, 5, null],
        [1, 'PRODUTO TESTE 1', null, E, 5, null],
      ),
      mapa.indices,
      ref,
      OPCOES,
    );
    expect(resumo(linhas)).toEqual(ESPERADO);
  });

  it('o custo cresce como o número de linhas e de produtos do EAN, não como o produto dos dois', () => {
    const custo = (n: number) => {
      const contador = { leituras: 0 };
      const lista = contada(
        Array.from({ length: n }, (_, i) => produto(i + 1, i % 3 ? `I${i}` : null)),
        contador,
      );
      const linhas = planilha(
        ...Array.from({ length: n }, (_, i): Array<string | number | null> => [
          i % 4 === 0 ? i + 1 : null,
          `PRODUTO NOVO ${i}`,
          i % 2 ? `N${i}` : null,
          E,
          5,
          null,
        ]),
      );
      const porCodigo = new Map(
        Array.from({ length: n }, (_, i) => produto(i + 1)).map((p) => [p.codigo, { ...p, excluido: false }]),
      );
      const r = analisarProdutos(
        linhas,
        mapa.indices,
        referencias({ porCodigo, porEan: new Map([[E, lista]]) }),
        OPCOES,
      );
      expect(r[1]!.erros).toEqual([
        `EAN ${E} está em ${Math.ceil(n / 3)} produtos: informe o Id ou o código interno`,
      ]);
      return contador.leituras;
    };
    const pequeno = custo(500);
    const grande = custo(3_000);
    // Linear: ~6× (3.000 / 500); quadrático: ~36×.
    expect(grande / pequeno).toBeLessThan(12);
    expect(grande).toBeLessThan(20 * 3_000);
  });

  it('a unidade da planilha é achada sem percorrer a lista de unidades a cada linha', () => {
    const custo = (n: number) => {
      const contador = { leituras: 0 };
      const unidades = contada(
        [
          ...Array.from({ length: n }, (_, i) => ({
            id: id(10_000 + i),
            sigla: `U${i}`,
            descricao: `Unidade ${i}`,
            permiteFracao: false,
          })),
          { id: UN, sigla: 'UN', descricao: 'Unidade', permiteFracao: false },
        ],
        contador,
      );
      const r = analisarProdutos(
        planilha(
          ...Array.from({ length: n }, (_, i) => [null, `NOVO ${i}`, null, null, 5, i % 2 ? 'UN' : `U${i}`]),
        ),
        mapa.indices,
        referencias({ unidades }),
        OPCOES,
      );
      expect(r[0]!.dados.unidadeId).toBe(id(10_000));
      expect(r[1]!.dados.unidadeId).toBe(UN);
      return contador.leituras;
    };
    const pequeno = custo(500);
    const grande = custo(3_000);
    expect(grande / pequeno).toBeLessThan(12);
    expect(grande).toBeLessThan(20 * 3_000);
  });
});

describe('análise da importação: o laço de eventos é cedido', () => {
  it('produtos: outra tarefa do processo roda no meio da análise, e o resultado é o mesmo da análise direta', async () => {
    const linhas = planilha(
      ...Array.from({ length: 5_000 }, (_, i) => [null, `NOVO ${i}`, null, null, 5, null]),
    );
    const ordem: string[] = [];
    setImmediate(() => ordem.push('outra'));
    const r = await analisarProdutosCedendo(linhas, mapa.indices, referencias(), OPCOES);
    ordem.push('fim');
    expect(ordem).toEqual(['outra', 'fim']);
    expect(r).toEqual(analisarProdutos(linhas, mapa.indices, referencias(), OPCOES));
  });

  it('clientes: idem', async () => {
    const ref: ReferenciasClientes = {
      municipios: new Map(),
      porId: new Map(),
      porDocumento: new Map(),
      porCodigo: new Map(),
      atuais: new Map(),
    };
    const m = mapearColunas(['Nome'], 'clientes');
    const linhas = planilha(...Array.from({ length: 5_000 }, (_, i) => [`CLIENTE TESTE ${i}`]));
    const ordem: string[] = [];
    setImmediate(() => ordem.push('outra'));
    const r = await analisarClientesCedendo(linhas, m.indices, ref);
    ordem.push('fim');
    expect(ordem).toEqual(['outra', 'fim']);
    expect(r).toEqual(analisarClientes(linhas, m.indices, ref));
  });
});

const ESPERADO: ReturnType<typeof resumo> = [
  {
    linha: 2,
    acao: 'ignorar',
    registroId: null,
    erros: ['EAN 7890000000017 está em 4 produtos: informe o Id ou o código interno'],
    avisos: [
      'ean_duplicado|ean|EAN 7890000000017 já está no produto 1 - PRODUTO TESTE 1',
      'ncm_invalido|ncm|Sem NCM',
    ],
  },
  {
    linha: 3,
    acao: 'ignorar',
    registroId: null,
    erros: ['EAN 7890000000017 está em 3 produtos: informe o Id ou o código interno'],
    avisos: [
      'ean_duplicado|ean|EAN 7890000000017 já está no produto 1 - PRODUTO TESTE 1',
      'ncm_invalido|ncm|Sem NCM',
    ],
  },
  {
    linha: 4,
    acao: 'atualizar',
    registroId: id(5),
    erros: [],
    avisos: ['ean_duplicado|ean|EAN 7890000000031 já está no produto 6 - PRODUTO TESTE 6'],
  },
  {
    linha: 5,
    acao: 'ignorar',
    registroId: null,
    erros: ['EAN 7890000000031 está em 2 produtos: informe o Id ou o código interno'],
    avisos: [
      'ean_duplicado|ean|EAN 7890000000031 já está no produto 5 - PRODUTO TESTE 5',
      'ncm_invalido|ncm|Sem NCM',
    ],
  },
  {
    linha: 6,
    acao: 'atualizar',
    registroId: id(2),
    erros: [],
    avisos: ['ean_duplicado|ean|EAN 7890000000017 já está no produto 1 - PRODUTO TESTE 1'],
  },
  {
    linha: 7,
    acao: 'atualizar',
    registroId: id(7),
    erros: [],
    avisos: [
      'codigo_conflito|ean|EAN 7890000000024 é do produto 4 - PRODUTO TESTE 4, não do código 7 (PRODUTO TESTE 7): confira o código',
      'ean_duplicado|ean|EAN 7890000000024 já está no produto 4 - PRODUTO TESTE 4',
    ],
  },
  {
    linha: 8,
    acao: 'atualizar',
    registroId: id(4),
    erros: [],
    avisos: ['ean_duplicado|ean|EAN 7890000000024 repetido na planilha (linha 7)'],
  },
  { linha: 9, acao: 'criar', registroId: null, erros: [], avisos: ['ncm_invalido|ncm|Sem NCM'] },
  {
    linha: 10,
    acao: 'atualizar',
    registroId: id(1),
    erros: [],
    avisos: ['ean_duplicado|ean|EAN 7890000000017 já está no produto 2 - PRODUTO TESTE 2'],
  },
];
