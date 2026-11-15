import {
  criarProdutoSchema,
  produtoLojaSchema,
  type CriarProduto,
  type ProdutoDetalhe,
} from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import {
  CAMPOS_PRECO_LOJA,
  CAMPOS_PRECO_PRODUTO,
  mudancasDePreco,
  type ContextoTravaPreco,
  type OpcoesExcluidas,
} from './trava-preco.js';

/**
 * A lista única da trava "Altera Preço do Produto no ERP" (decisões 68 e 208): cada campo de preço, quando muda, é
 * apontado; repetir o gravado (com outra escrita do mesmo número, da mesma data no minuto, do mesmo id) não é mudança.
 * A integração (`test/integracao/produtos.test.ts`) confere o 403 de cada um pelo PUT com o perfil Estoquista.
 */
const LOJA_A = '0190a000-0000-7000-8000-00000000000a';
const LOJA_B = '0190a000-0000-7000-8000-00000000000b';
const LOJA_INATIVA = '0190a000-0000-7000-8000-00000000000c';
const LOJA_OCULTA = '0190a000-0000-7000-8000-00000000000d';
const GRUPO = '0190a000-0000-7000-8000-0000000000e1';
const CB_EAN = '0190a000-0000-7000-8000-0000000000c1';
const CB_FARDO = '0190a000-0000-7000-8000-0000000000c2';
const CB_CAIXA = '0190a000-0000-7000-8000-0000000000c3';
const DUN = '17891149103109';
const POSICAO = '0190a000-0000-7000-8000-0000000000f1';
const ALT = '0190a000-0000-7000-8000-0000000000f2';
const PROD_ALT = '0190a000-0000-7000-8000-0000000000f3';
const PROD_ALT2 = '0190a000-0000-7000-8000-0000000000f4';
const GRUPO_COMPL = '0190a000-0000-7000-8000-0000000000a1';
const COMPL = '0190a000-0000-7000-8000-0000000000a2';
const PROD_COMPL = '0190a000-0000-7000-8000-0000000000a3';
const GRUPO_COMPL2 = '0190a000-0000-7000-8000-0000000000a4';
const COMPL2 = '0190a000-0000-7000-8000-0000000000a5';
const POSICAO2 = '0190a000-0000-7000-8000-0000000000f5';
const ALT2 = '0190a000-0000-7000-8000-0000000000f6';

const ctx: ContextoTravaPreco = {
  lojaVisivel: (l) => l !== LOJA_OCULTA,
  lojaAtiva: (l) => l !== LOJA_INATIVA,
  excluidas: { codigosBarras: [], complementos: [], alternativas: [] },
};

/** O contexto com as opções excluídas em salvamentos anteriores (da mais nova para a mais antiga). */
const comExcluidas = (excluidas: Partial<OpcoesExcluidas>): ContextoTravaPreco => ({
  ...ctx,
  excluidas: { ...ctx.excluidas, ...excluidas },
});

/** O gravado, como o detalhe devolve (só o que a trava lê). */
function gravado(): ProdutoDetalhe {
  return {
    precoVenda: '5.0000',
    precoAtacado: '4.5000',
    qtdMinimaAtacado: '12.000',
    precoPromocional: '4.0000',
    promocaoInicio: '2026-11-01T03:00:00.000Z',
    promocaoFim: '2026-11-30T23:59:30.000Z',
    precoParcelado: null,
    precoMenuDigital: null,
    precoIfood: null,
    grupoPrecoQuantidadeId: GRUPO,
    solicitaPrecoPdv: false,
    generico: false,
    codigosBarras: [
      { id: CB_EAN, codigo: '7891149103102', fator: '1.000', preco: null, usaVenda: true },
      { id: CB_FARDO, codigo: DUN, fator: '12.000', preco: '54.0000', usaVenda: true },
      // A caixa sem preço próprio: o caixa cobra o preço do produto × o fator.
      { id: CB_CAIXA, codigo: 'CX6', fator: '6.000', preco: null, usaVenda: true },
    ],
    lojas: [
      { lojaId: LOJA_A, precoVenda: '5.5000', acrescimoGelada: '1.0000' },
      { lojaId: LOJA_B, precoVenda: null, acrescimoGelada: null },
      { lojaId: LOJA_INATIVA, precoVenda: '9.0000', acrescimoGelada: null },
      { lojaId: LOJA_OCULTA, precoVenda: '7.0000', acrescimoGelada: null },
    ],
    precosQuantidade: [
      { id: 'f1', lojaId: null, quantidadeInicial: '6.000', quantidadeFinal: null, preco: '4.8000' },
      { id: 'f2', lojaId: LOJA_OCULTA, quantidadeInicial: '6.000', quantidadeFinal: null, preco: '4.7000' },
    ],
    componentes: [
      {
        id: POSICAO,
        tipo: 'kit',
        alternativas: [{ id: ALT, produtoId: PROD_ALT, variacaoId: null, acrescimo: '2.0000', ativo: true }],
      },
    ],
    gruposComplementos: [
      {
        id: GRUPO_COMPL,
        complementos: [
          { id: COMPL, produtoId: PROD_COMPL, descricao: null, precoAdicional: '3.0000', ativo: true },
        ],
      },
    ],
  } as unknown as ProdutoDetalhe;
}

/** O corpo que repete o gravado (outra escrita dos mesmos valores, como o formulário manda). */
function corpo(): CriarProduto {
  return {
    precoVenda: '5.00',
    precoAtacado: '4.50',
    qtdMinimaAtacado: '12',
    precoPromocional: '4',
    promocaoInicio: '2026-11-01T00:00:00-03:00',
    // O formulário devolve a hora no minuto: os 30 s gravados não são mudança.
    promocaoFim: '2026-11-30T23:59:00.000Z',
    precoParcelado: null,
    precoMenuDigital: null,
    precoIfood: null,
    grupoPrecoQuantidadeId: GRUPO.toUpperCase(),
    solicitaPrecoPdv: false,
    generico: false,
    codigosBarras: [
      // O principal do formulário vem sem preço, fator nem "usa na venda": os padrões.
      { id: CB_EAN, codigo: '7891149103102', fator: '1.000', preco: null, usaVenda: true },
      { id: CB_FARDO, codigo: DUN, fator: '12', preco: '54.00', usaVenda: true },
      { id: CB_CAIXA, codigo: 'CX6', fator: '6', preco: null, usaVenda: true },
    ],
    // A loja inativa e a oculta não vêm (o formulário lista só as ativas permitidas).
    lojas: [
      { lojaId: LOJA_A, precoVenda: '5.50', acrescimoGelada: '1' },
      { lojaId: LOJA_B, precoVenda: null, acrescimoGelada: null },
    ],
    precosQuantidade: [
      { id: 'f1', lojaId: null, quantidadeInicial: '6', quantidadeFinal: null, preco: '4.80' },
    ],
    componentes: [
      {
        id: POSICAO,
        tipo: 'kit',
        alternativas: [{ id: ALT, produtoId: PROD_ALT, variacaoId: null, acrescimo: '2.00', ativo: true }],
      },
    ],
    gruposComplementos: [
      {
        id: GRUPO_COMPL,
        complementos: [
          { id: COMPL, produtoId: PROD_COMPL, descricao: null, precoAdicional: '3.00', ativo: true },
        ],
      },
    ],
  } as unknown as CriarProduto;
}

type Mutavel = Record<string, unknown> & {
  codigosBarras: Array<Record<string, unknown>>;
  lojas: Array<Record<string, unknown>>;
  componentes: Array<{ id: string | null; tipo: string; alternativas: Array<Record<string, unknown>> }>;
  gruposComplementos: Array<{ id: string | null; complementos: Array<Record<string, unknown>> }>;
  precosQuantidade: Array<Record<string, unknown>>;
};

function com(
  mudar: (d: Mutavel) => void,
  mudarGravado: (a: Mutavel) => void = () => undefined,
  contexto = ctx,
): string[] {
  const d = corpo() as unknown as Mutavel;
  mudar(d);
  const a = gravado() as unknown as Mutavel;
  mudarGravado(a);
  return mudancasDePreco(a as unknown as ProdutoDetalhe, d as unknown as CriarProduto, contexto);
}

describe('trava de preço: a lista única dos campos de preço', () => {
  it('repetir o gravado (outra escrita dos mesmos valores) não é mudança', () => {
    expect(mudancasDePreco(gravado(), corpo(), ctx)).toEqual([]);
  });

  it.each([
    ['precoVenda', '5.01'],
    ['precoAtacado', null],
    ['qtdMinimaAtacado', '1'],
    ['precoPromocional', '3.99'],
    ['promocaoInicio', null],
    ['promocaoFim', '2026-12-31T23:59:00.000Z'],
    ['precoParcelado', '5.20'],
    ['precoMenuDigital', '6'],
    ['precoIfood', '6.50'],
    ['grupoPrecoQuantidadeId', null],
    ['solicitaPrecoPdv', true],
    ['generico', true],
  ] as const)('o campo do produto %s', (campo, novo) => {
    expect(com((d) => (d[campo] = novo))).toEqual([campo]);
  });

  it('a lista do produto e a da loja cobrem os campos de preço do contrato', () => {
    // Derivado do contrato: um campo de preço novo no schema (`preco*`, `promocao*`, `*atacado*`, `acrescimo*`) que
    // não entrou na trava faz este teste falhar. Fora de propósito: o custo (decisão 68, `produtos.ver_custo`) e as
    // faixas (`precosQuantidade`, comparadas à parte).
    const dePreco = (chaves: string[], fora: string[]) =>
      chaves.filter((c) => /preco|promocao|atacado|acrescimo/i.test(c) && !fora.includes(c)).sort();
    const produto = dePreco(Object.keys(criarProdutoSchema.shape), ['precoCusto', 'precosQuantidade']);
    expect(produto.length).toBeGreaterThan(5);
    expect(produto.filter((c) => !(c in CAMPOS_PRECO_PRODUTO))).toEqual([]);
    const loja = dePreco(Object.keys(produtoLojaSchema.shape), []);
    expect(loja.filter((c) => !(c in CAMPOS_PRECO_LOJA))).toEqual([]);
    // As condições do preço que o nome não denuncia continuam na lista.
    expect(Object.keys(CAMPOS_PRECO_PRODUTO)).toEqual(
      expect.arrayContaining(['qtdMinimaAtacado', 'generico']),
    );
  });

  it('código de barras: preço do principal, preço e fator da embalagem, código e "usa na venda" de quem tem preço', () => {
    expect(com((d) => (d.codigosBarras[0]!.preco = '0.01'))).toEqual(['codigosBarras.0.preco']);
    expect(com((d) => (d.codigosBarras[1]!.preco = '30'))).toEqual(['codigosBarras.1.preco']);
    expect(com((d) => (d.codigosBarras[1]!.preco = null))).toEqual(['codigosBarras.1.preco']);
    expect(com((d) => (d.codigosBarras[1]!.fator = '24'))).toEqual(['codigosBarras.1.fator']);
    expect(com((d) => (d.codigosBarras[1]!.codigo = '7894900011517'))).toEqual(['codigosBarras.1.codigo']);
    // Tirar da venda e o preço junto: o preço gravado é o que vale quando o código volta.
    expect(
      com((d) => {
        d.codigosBarras[1]!.usaVenda = false;
        d.codigosBarras[1]!.preco = null;
      }),
    ).toEqual(['codigosBarras.1.preco']);
    // Código novo: com preço (até 0) conta; sem preço, não.
    expect(
      com((d) =>
        d.codigosBarras.push({ id: null, codigo: '7894900011517', fator: '6', preco: '0', usaVenda: true }),
      ),
    ).toEqual(['codigosBarras.3.preco']);
    expect(
      com((d) =>
        d.codigosBarras.push({ id: null, codigo: '7894900011517', fator: '6', preco: null, usaVenda: true }),
      ),
    ).toEqual([]);
  });

  it('código de barras: o que sai da venda e o fator e o código do código sem preço não são mudança de preço', () => {
    expect(com((d) => d.codigosBarras.splice(1, 1))).toEqual([]);
    expect(com((d) => (d.codigosBarras[1]!.usaVenda = false))).toEqual([]);
    // O fator da caixa sem preço próprio só muda a quantidade da embalagem.
    expect(com((d) => (d.codigosBarras[2]!.fator = '12'))).toEqual([]);
    expect(com((d) => (d.codigosBarras[0]!.codigo = '7894900011517'))).toEqual([]);
  });

  it('código de barras: excluir e recriar o código no mesmo salvamento não troca o preço dele', () => {
    const recriar = (novo: Record<string, unknown>) =>
      com((d) => {
        d.codigosBarras[1] = { id: null, codigo: DUN, usaVenda: true, ...novo };
      });
    // Sem preço (o caixa passaria a cobrar 12 × 5,00), com outro fator ou outro preço: conta.
    expect(recriar({ fator: '12', preco: null })).toEqual(['codigosBarras.1.preco']);
    expect(recriar({ fator: '1', preco: null })).toEqual(['codigosBarras.1.preco']);
    expect(recriar({ fator: '24', preco: '54' })).toEqual(['codigosBarras.1.fator']);
    expect(recriar({ fator: '12', preco: '50' })).toEqual(['codigosBarras.1.preco']);
    // O mesmo preço e o mesmo fator: nada muda no caixa.
    expect(recriar({ fator: '12', preco: '54' })).toEqual([]);
    // O id de outro produto não casa: é o mesmo que recriar.
    expect(com((d) => (d.codigosBarras[1]!.id = '0190a000-0000-7000-8000-0000000000c9'))).toEqual([]);
    expect(
      com((d) => {
        d.codigosBarras[1]!.id = '0190a000-0000-7000-8000-0000000000c9';
        d.codigosBarras[1]!.preco = null;
      }),
    ).toEqual(['codigosBarras.1.preco']);
    // O código sem preço que fica com o número do fardo retirado.
    expect(
      com((d) => {
        d.codigosBarras[0]!.codigo = DUN;
        d.codigosBarras.splice(1, 1);
      }),
    ).toEqual(['codigosBarras.0.preco']);
    // O código sem preço retirado e recriado sem preço: não conta.
    expect(
      com((d) => (d.codigosBarras[2] = { id: null, codigo: 'CX6', fator: '8', preco: null, usaVenda: true })),
    ).toEqual([]);
  });

  it('código de barras: o que volta para a venda, ou é recriado depois de excluído, com o preço que teve conta', () => {
    const foraDaVenda = (a: Mutavel) => (a.codigosBarras[1]!.usaVenda = false);
    // Volta com preço, ou sem o preço que tinha.
    expect(com(() => undefined, foraDaVenda)).toEqual(['codigosBarras.1.preco']);
    expect(com((d) => (d.codigosBarras[1]!.preco = null), foraDaVenda)).toEqual(['codigosBarras.1.preco']);
    // Fora da venda, o preço também não muda (é o que vale quando ele voltar).
    expect(
      com((d) => {
        d.codigosBarras[1]!.usaVenda = false;
        d.codigosBarras[1]!.preco = null;
      }, foraDaVenda),
    ).toEqual(['codigosBarras.1.preco']);
    // Excluído num salvamento, recriado sem preço noutro: a última exclusão dele tinha preço.
    const semFardo = (a: Mutavel) => a.codigosBarras.splice(1, 1);
    const recriado = (d: Mutavel) =>
      (d.codigosBarras[1] = { id: null, codigo: DUN, fator: '12', preco: null, usaVenda: true });
    expect(
      com(recriado, semFardo, comExcluidas({ codigosBarras: [{ codigo: DUN, preco: '54.0000' }] })),
    ).toEqual(['codigosBarras.1.preco']);
    // A última exclusão (a mais nova) era sem preço: volta sem preço.
    expect(
      com(
        recriado,
        semFardo,
        comExcluidas({
          codigosBarras: [
            { codigo: DUN, preco: null },
            { codigo: DUN, preco: '54.0000' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('loja: preço próprio, acréscimo gelado, a linha nova com preço e a linha com preço retirada', () => {
    expect(com((d) => (d.lojas[0]!.acrescimoGelada = '9'))).toEqual(['lojas.0.acrescimoGelada']);
    expect(com((d) => (d.lojas[0]!.acrescimoGelada = null))).toEqual(['lojas.0.acrescimoGelada']);
    expect(com((d) => (d.lojas[1]!.acrescimoGelada = '0.50'))).toEqual(['lojas.1.acrescimoGelada']);
    expect(com((d) => (d.lojas[0]!.precoVenda = '4'))).toEqual(['lojas.0.precoVenda']);
    expect(com((d) => d.lojas.splice(0, 1))).toEqual([`lojas:${LOJA_A}`]);
    // A linha sem preço retirada, e as lojas inativa e oculta que não vêm, não mudam preço.
    expect(com((d) => d.lojas.splice(1, 1))).toEqual([]);
  });

  it('faixas, complementos e alternativas do combo', () => {
    expect(com((d) => (d.precosQuantidade[0]!.preco = '4.10'))).toEqual(['precosQuantidade']);
    expect(com((d) => (d.gruposComplementos[0]!.complementos[0]!.precoAdicional = '0'))).toEqual([
      'gruposComplementos.0.complementos.0.precoAdicional',
    ]);
    expect(com((d) => (d.componentes[0]!.alternativas[0]!.acrescimo = '0'))).toEqual([
      'componentes.0.alternativas.0.acrescimo',
    ]);
    // Alternativa nova: sem acréscimo, não conta; com acréscimo, conta.
    expect(
      com((d) =>
        d.componentes[0]!.alternativas.push({
          id: null,
          produtoId: PROD_ALT2,
          variacaoId: null,
          acrescimo: '0',
          ativo: true,
        }),
      ),
    ).toEqual([]);
    expect(
      com((d) =>
        d.componentes[0]!.alternativas.push({
          id: null,
          produtoId: PROD_ALT2,
          variacaoId: null,
          acrescimo: '1',
          ativo: true,
        }),
      ),
    ).toEqual(['componentes.0.alternativas.1.acrescimo']);
  });

  it('excluir e recriar a opção não troca o preço dela', () => {
    // A mesma alternativa recriada (sem o id, numa posição nova) com outro acréscimo; com o gravado, passa.
    expect(
      com((d) => {
        d.componentes = [
          {
            id: null,
            tipo: 'kit',
            alternativas: [{ id: null, produtoId: PROD_ALT, variacaoId: null, acrescimo: '0', ativo: true }],
          },
        ];
      }),
    ).toEqual(['componentes.0.alternativas.0.acrescimo']);
    expect(
      com((d) => {
        d.componentes = [
          {
            id: null,
            tipo: 'kit',
            alternativas: [{ id: null, produtoId: PROD_ALT, variacaoId: null, acrescimo: '2', ativo: true }],
          },
        ];
      }),
    ).toEqual([]);
    // O mesmo complemento num grupo novo, de graça.
    expect(
      com((d) => {
        d.gruposComplementos = [
          {
            id: null,
            complementos: [
              { id: null, produtoId: PROD_COMPL, descricao: null, precoAdicional: '0', ativo: true },
            ],
          },
        ];
      }),
    ).toEqual(['gruposComplementos.0.complementos.0.precoAdicional']);
    // Complemento livre novo sem preço: não conta.
    expect(
      com((d) =>
        d.gruposComplementos[0]!.complementos.push({
          id: null,
          produtoId: null,
          descricao: 'Sem gelo',
          precoAdicional: '0',
          ativo: true,
        }),
      ),
    ).toEqual([]);
  });

  it('a opção recriada compara só com a que sai, não com a mesma opção noutro grupo ou posição', () => {
    // O mesmo complemento a 3,00 no grupo 1 e de graça no grupo 2: apagar o grupo 1 e recriá-lo de graça conta.
    const doisGrupos = (a: Mutavel) =>
      a.gruposComplementos.push({
        id: GRUPO_COMPL2,
        complementos: [
          { id: COMPL2, produtoId: PROD_COMPL, descricao: null, precoAdicional: '0.0000', ativo: true },
        ],
      });
    const comGrupo2 = (d: Mutavel) =>
      d.gruposComplementos.push({
        id: GRUPO_COMPL2,
        complementos: [
          { id: COMPL2, produtoId: PROD_COMPL, descricao: null, precoAdicional: '0', ativo: true },
        ],
      });
    expect(
      com((d) => {
        comGrupo2(d);
        d.gruposComplementos[0] = {
          id: null,
          complementos: [
            { id: null, produtoId: PROD_COMPL, descricao: null, precoAdicional: '0', ativo: true },
          ],
        };
      }, doisGrupos),
    ).toEqual(['gruposComplementos.0.complementos.0.precoAdicional']);
    // A alternativa a 2,00 na posição 1 e sem acréscimo na posição 2: o mesmo.
    const duasPosicoes = (a: Mutavel) =>
      a.componentes.push({
        id: POSICAO2,
        tipo: 'kit',
        alternativas: [{ id: ALT2, produtoId: PROD_ALT, variacaoId: null, acrescimo: '0.0000', ativo: true }],
      });
    expect(
      com((d) => {
        d.componentes[0]!.alternativas = [
          { id: null, produtoId: PROD_ALT, variacaoId: null, acrescimo: '0', ativo: true },
        ];
        d.componentes.push({
          id: POSICAO2,
          tipo: 'kit',
          alternativas: [{ id: ALT2, produtoId: PROD_ALT, variacaoId: null, acrescimo: '0', ativo: true }],
        });
      }, duasPosicoes),
    ).toEqual(['componentes.0.alternativas.0.acrescimo']);
    // A mesma opção nova num grupo novo, de graça, enquanto a de 3,00 continua à venda: conta (o cliente escolhe a de
    // graça); a opção que não tem preço em lugar nenhum entra de graça.
    expect(
      com((d) =>
        d.gruposComplementos.push({
          id: null,
          complementos: [
            { id: null, produtoId: PROD_COMPL, descricao: null, precoAdicional: '0', ativo: true },
          ],
        }),
      ),
    ).toEqual(['gruposComplementos.1.complementos.0.precoAdicional']);
    expect(
      com(
        (d) => {
          d.gruposComplementos[0]!.complementos[0]!.precoAdicional = '0';
          comGrupo2(d);
          d.gruposComplementos.push({
            id: null,
            complementos: [
              { id: null, produtoId: PROD_COMPL, descricao: null, precoAdicional: '0', ativo: true },
            ],
          });
        },
        (a) => {
          doisGrupos(a);
          a.gruposComplementos[0]!.complementos[0]!.precoAdicional = '0.0000';
        },
      ),
    ).toEqual([]);
  });

  it('a opção reativada com preço conta; sem preço, não', () => {
    const inativo = (a: Mutavel) => (a.gruposComplementos[0]!.complementos[0]!.ativo = false);
    expect(com(() => undefined, inativo)).toEqual(['gruposComplementos.0.complementos.0.precoAdicional']);
    // Inativa e continua inativa: não conta; e o preço dela não muda enquanto está inativa.
    expect(com((d) => (d.gruposComplementos[0]!.complementos[0]!.ativo = false), inativo)).toEqual([]);
    expect(
      com((d) => {
        d.gruposComplementos[0]!.complementos[0]!.ativo = false;
        d.gruposComplementos[0]!.complementos[0]!.precoAdicional = '0';
      }, inativo),
    ).toEqual(['gruposComplementos.0.complementos.0.precoAdicional']);
    // A inativa com preço faz a mesma opção nova, noutro grupo, também só voltar com a permissão.
    expect(
      com((d) => {
        d.gruposComplementos[0]!.complementos[0]!.ativo = false;
        d.gruposComplementos.push({
          id: null,
          complementos: [
            { id: null, produtoId: PROD_COMPL, descricao: null, precoAdicional: '0', ativo: true },
          ],
        });
      }, inativo),
    ).toEqual(['gruposComplementos.1.complementos.0.precoAdicional']);
    const semPreco = (a: Mutavel) => {
      inativo(a);
      a.gruposComplementos[0]!.complementos[0]!.precoAdicional = '0.0000';
    };
    expect(com((d) => (d.gruposComplementos[0]!.complementos[0]!.precoAdicional = '0'), semPreco)).toEqual(
      [],
    );
    // A alternativa inativa com acréscimo, reativada.
    const altInativa = (a: Mutavel) => (a.componentes[0]!.alternativas[0]!.ativo = false);
    expect(com(() => undefined, altInativa)).toEqual(['componentes.0.alternativas.0.acrescimo']);
  });

  it('a opção excluída num salvamento e recriada noutro só volta sem preço se a última dela não tinha preço', () => {
    // Combo: a alternativa (acréscimo 2,00) tirada antes; recriá-la de graça, ou com o acréscimo, conta.
    const semAlternativa = (a: Mutavel) => (a.componentes[0]!.alternativas = []);
    const recriarAlt = (acrescimo: string) => (d: Mutavel) =>
      (d.componentes[0]!.alternativas = [
        { id: null, produtoId: PROD_ALT, variacaoId: null, acrescimo, ativo: true },
      ]);
    const altExcluida = comExcluidas({
      alternativas: [{ produtoId: PROD_ALT, variacaoId: null, acrescimo: '2.0000' }],
    });
    expect(com(recriarAlt('0'), semAlternativa, altExcluida)).toEqual([
      'componentes.0.alternativas.0.acrescimo',
    ]);
    expect(com(recriarAlt('2'), semAlternativa, altExcluida)).toEqual([
      'componentes.0.alternativas.0.acrescimo',
    ]);
    // A de outro produto excluída não pesa sobre esta.
    expect(
      com(
        recriarAlt('0'),
        semAlternativa,
        comExcluidas({ alternativas: [{ produtoId: PROD_ALT2, variacaoId: null, acrescimo: '2.0000' }] }),
      ),
    ).toEqual([]);
    // Complemento: o grupo apagado antes (com o complemento a 3,00); recriado de graça, conta.
    const semGrupo = (a: Mutavel) => (a.gruposComplementos = []);
    const recriarCompl = (d: Mutavel) =>
      (d.gruposComplementos = [
        {
          id: null,
          complementos: [
            { id: null, produtoId: PROD_COMPL, descricao: null, precoAdicional: '0', ativo: true },
          ],
        },
      ]);
    expect(
      com(
        recriarCompl,
        semGrupo,
        comExcluidas({
          complementos: [{ produtoId: PROD_COMPL, descricao: null, precoAdicional: '3.0000' }],
        }),
      ),
    ).toEqual(['gruposComplementos.0.complementos.0.precoAdicional']);
    // A última exclusão (a mais nova) era de graça: volta de graça.
    expect(
      com(
        recriarCompl,
        semGrupo,
        comExcluidas({
          complementos: [
            { produtoId: PROD_COMPL.toUpperCase(), descricao: null, precoAdicional: '0.0000' },
            { produtoId: PROD_COMPL, descricao: null, precoAdicional: '3.0000' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('a lista de complementos ausente mantém os gravados (não é mudança)', () => {
    expect(com((d) => delete (d as Record<string, unknown>).gruposComplementos)).toEqual([]);
  });
});
