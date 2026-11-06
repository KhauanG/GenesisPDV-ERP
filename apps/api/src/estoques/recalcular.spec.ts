/**
 * Núcleo do `db:recalcular-saldos` (Fase 2, F2-B3) sem banco: a junção do razão com as linhas de saldo em ordem de
 * chave, o replay e a comparação. A paginação não muda o resultado (uma linha com mais de 10 mil movimentos cortada em
 * páginas de 10 mil, de 7 ou numa só), e cada divergência sai com o campo, o gravado, o recalculado e a diferença.
 */
import { aplicarMovimentoNoSaldo, dec } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import {
  compararChave,
  conferirProjecao,
  MOVIMENTOS_POR_PAGINA,
  ReplayLinha,
  type MovimentoLido,
  type RelatorioRecalculo,
  type SaldoLido,
} from './recalcular.js';

const uuid = (prefixo: string, n: number) =>
  `${prefixo.padEnd(8, '0')}-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ESTOQUE = uuid('e1', 1);
const TIPO = uuid('a1', 1);
const produto = (n: number) => uuid('b1', n);

/** Gerador congruencial de semente fixa: o mesmo razão a cada execução. */
function gerador(semente: number) {
  let s = semente >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const dataUs = (n: number) => BigInt(Date.UTC(2026, 10, 1)) * 1000n + BigInt(n) * 1000n;
const dataTexto = (us: bigint) =>
  new Date(Number(us / 1000n)).toISOString().replace('T', ' ').replace('Z', '+00');

/** O razão de uma linha como o motor o grava (a mesma conta), e a projeção correspondente. */
function linha(
  produtoId: string,
  quantos: number,
  semente: number,
  variacaoId: string | null = null,
): { movimentos: MovimentoLido[]; saldo: SaldoLido } {
  const aleatorio = gerador(semente);
  let saldo = '0';
  let custo = '0';
  const movimentos: MovimentoLido[] = [];
  let entrada: bigint | null = null;
  let saida: bigint | null = null;
  for (let i = 0; i < quantos; i++) {
    const entra = aleatorio() < 0.45;
    const q = ((1 + Math.floor(aleatorio() * 900)) / 100).toFixed(3);
    const r = aplicarMovimentoNoSaldo(saldo, custo, {
      quantidade: entra ? q : `-${q}`,
      custoUnitario: entra ? (1 + aleatorio() * 9).toFixed(4) : null,
      custoReferencia: '2.5',
    });
    const us = dataUs(semente * 1_000_000 + i);
    if (entra) entrada = us;
    else saida = us;
    movimentos.push({
      estoque_id: ESTOQUE,
      produto_id: produtoId,
      variacao_id: variacaoId,
      tipo_estoque_id: TIPO,
      id: uuid('c1', semente * 1_000_000 + i),
      seq_lancamento: String(1_000_000_000_000 + semente * 1_000_000 + i),
      quantidade: r.quantidade,
      saldo_anterior: r.saldoAnterior,
      saldo_posterior: r.saldoPosterior,
      custo_unitario: r.custoUnitario,
      custo_total: r.custoTotal,
      custo_medio_posterior: r.custoMedioPosterior,
      estorno_de_id: null,
      data_movimento: dataTexto(us),
      data_us: String(us),
      tipo_movimento: entra ? 'ACERTO_ENTRADA' : 'ACERTO_SAIDA',
      lote_id: null,
    });
    saldo = r.saldoPosterior;
    custo = r.custoMedioPosterior;
  }
  return {
    movimentos,
    saldo: {
      id: uuid('d1', semente),
      estoque_id: ESTOQUE,
      produto_id: produtoId,
      variacao_id: variacaoId,
      tipo_estoque_id: TIPO,
      quantidade: saldo,
      custo_medio: custo,
      ultima_entrada_em: entrada === null ? null : dataTexto(entrada),
      ultima_entrada_us: entrada === null ? null : String(entrada),
      ultima_saida_em: saida === null ? null : dataTexto(saida),
      ultima_saida_us: saida === null ? null : String(saida),
      ultimo_movimento_id: movimentos.at(-1)?.id ?? null,
      ultima_compra_em: null,
      ultima_compra_us: null,
      ultimo_custo_compra: null,
      lotes: null,
    },
  };
}

async function* emPaginas<T>(itens: readonly T[], tamanho: number): AsyncGenerator<T[]> {
  for (let i = 0; i < itens.length; i += tamanho) yield itens.slice(i, i + tamanho);
}

const conferir = (m: readonly MovimentoLido[], s: readonly SaldoLido[], tamanho: number) =>
  conferirProjecao(emPaginas(m, tamanho), emPaginas(s, tamanho));

/** Razão de quatro linhas, na ordem dos cursores: a grande (25 mil movimentos), duas pequenas e uma com variação. */
function razao() {
  const linhas = [
    linha(produto(1), 25_000, 1),
    linha(produto(2), 40, 2),
    linha(produto(3), 3, 3, uuid('f1', 1)),
    linha(produto(3), 12, 4),
  ];
  const ordem = (a: MovimentoLido | SaldoLido, b: MovimentoLido | SaldoLido) =>
    compararChave(
      {
        estoqueId: a.estoque_id,
        produtoId: a.produto_id,
        variacaoId: a.variacao_id,
        tipoEstoqueId: a.tipo_estoque_id,
      },
      {
        estoqueId: b.estoque_id,
        produtoId: b.produto_id,
        variacaoId: b.variacao_id,
        tipoEstoqueId: b.tipo_estoque_id,
      },
    );
  linhas.sort((a, b) => ordem(a.saldo, b.saldo));
  return { movimentos: linhas.flatMap((l) => l.movimentos), saldos: linhas.map((l) => l.saldo) };
}

describe('recalcular saldos pelo razão (F2-B3)', () => {
  it('a variação nula vem depois da preenchida, como no ORDER BY do PostgreSQL', () => {
    const base = { estoqueId: ESTOQUE, produtoId: produto(3), tipoEstoqueId: TIPO };
    expect(compararChave({ ...base, variacaoId: null }, { ...base, variacaoId: uuid('f1', 1) })).toBe(1);
    expect(compararChave({ ...base, variacaoId: uuid('f1', 1) }, { ...base, variacaoId: null })).toBe(-1);
    expect(compararChave({ ...base, variacaoId: null }, { ...base, variacaoId: null })).toBe(0);
    // O uuid compara pelos bytes = texto em minúsculas, qualquer que seja a caixa recebida.
    expect(
      compararChave(
        { ...base, variacaoId: null, produtoId: produto(3).toUpperCase() },
        { ...base, variacaoId: null },
      ),
    ).toBe(0);
  });

  it('razão íntegro: idêntico, e a linha com mais de 10 mil movimentos dá o mesmo em qualquer paginação', async () => {
    const { movimentos, saldos } = razao();
    const r = await conferir(movimentos, saldos, MOVIMENTOS_POR_PAGINA);
    expect(r).toEqual({
      linhas: 4,
      movimentos: 25_055,
      divergencias: [],
      razaoInconsistente: [],
    } satisfies Omit<RelatorioRecalculo, 'custoProdutos'>);
    expect(await conferir(movimentos, saldos, 7)).toEqual(r);
    expect(await conferir(movimentos, saldos, movimentos.length)).toEqual(r);
  });

  it('com a projeção corrompida, as mesmas divergências em qualquer paginação, com gravado, recalculado e diferença', async () => {
    const { movimentos, saldos } = razao();
    const grande = saldos.find((s) => s.produto_id === produto(1))!;
    const certo = { ...grande };
    grande.quantidade = dec(grande.quantidade).plus('5.5').toFixed(3);
    grande.custo_medio = '99.0000';
    const pequena = saldos.find((s) => s.produto_id === produto(2))!;
    pequena.ultimo_movimento_id = movimentos[0]!.id;
    const paginada = await conferir(movimentos, saldos, MOVIMENTOS_POR_PAGINA);
    expect(await conferir(movimentos, saldos, 7)).toEqual(paginada);
    expect(await conferir(movimentos, saldos, movimentos.length)).toEqual(paginada);
    expect(paginada.divergencias.map((d) => [d.produtoId, d.situacao, d.campos])).toEqual([
      [
        produto(1),
        'divergente',
        [
          {
            campo: 'quantidade',
            gravado: grande.quantidade,
            recalculado: certo.quantidade,
            diferenca: '-5.500',
          },
          {
            campo: 'custo_medio',
            gravado: '99.0000',
            recalculado: certo.custo_medio,
            diferenca: dec(certo.custo_medio).minus(99).toFixed(4),
          },
        ],
      ],
      [
        produto(2),
        'divergente',
        [
          {
            campo: 'ultimo_movimento_id',
            gravado: movimentos[0]!.id,
            recalculado: pequenaUltimo(movimentos),
            diferenca: null,
          },
        ],
      ],
    ]);
    // O replay chegou ao fim da linha (para continuar sob a trava do `--corrigir`) e o razão em si está íntegro.
    expect(paginada.divergencias[0]!.recalculado).toMatchObject({
      movimentos: 25_000,
      quantidade: certo.quantidade,
    });
    expect(paginada.divergencias[0]!.razao).toBeNull();
  });

  it('linha órfã (saldo sem razão), razão sem linha de saldo e datas de última entrada e saída', async () => {
    const { movimentos, saldos } = razao();
    const semSaldo = saldos.filter((s) => s.produto_id !== produto(2));
    const orfa: SaldoLido = {
      ...saldos[0]!,
      id: uuid('d9', 9),
      produto_id: uuid('ff', 1),
      quantidade: '3.000',
      custo_medio: '0.0000',
      ultima_entrada_em: null,
      ultima_entrada_us: null,
      ultima_saida_em: null,
      ultima_saida_us: null,
      ultimo_movimento_id: null,
    };
    const datas = semSaldo.find((s) => s.produto_id === produto(1))!;
    datas.ultima_saida_em = null;
    datas.ultima_saida_us = null;
    const r = await conferir(movimentos, [...semSaldo, orfa], 1000);
    expect(r.divergencias.map((d) => [d.produtoId, d.situacao, d.campos.map((c) => c.campo)])).toEqual([
      [produto(1), 'divergente', ['ultima_saida_em']],
      [
        produto(2),
        'sem_linha',
        ['quantidade', 'custo_medio', 'ultima_entrada_em', 'ultima_saida_em', 'ultimo_movimento_id'],
      ],
      [uuid('ff', 1), 'orfa', ['quantidade']],
    ]);
    expect(r.divergencias[1]!.saldoId).toBeNull();
    expect(r.divergencias[2]!.campos[0]).toEqual({
      campo: 'quantidade',
      gravado: '3.000',
      recalculado: '0.000',
      diferenca: '-3.000',
    });
  });

  it('cadeia quebrada e movimento que o replay não repete: histórico, sem divergência na projeção certa', async () => {
    const { movimentos, saldos } = razao();
    const daLinha = movimentos.filter((m) => m.produto_id === produto(2));
    // O 10º movimento foi lançado sobre um saldo 1 acima do fim do razão (a projeção estava errada naquela hora).
    const m = daLinha[9]!;
    m.saldo_anterior = dec(m.saldo_anterior).plus(1).toFixed(3);
    const r = await conferir(movimentos, saldos, 10_000);
    expect(r.divergencias).toEqual([]);
    expect(r.razaoInconsistente).toEqual([
      {
        estoqueId: ESTOQUE,
        produtoId: produto(2),
        variacaoId: null,
        tipoEstoqueId: TIPO,
        movimentos: 40,
        quebras: 1,
        primeiraQuebra: {
          posicao: 10,
          movimentoId: m.id,
          seqLancamento: m.seq_lancamento,
          saldoEsperado: daLinha[8]!.saldo_posterior,
          saldoAnterior: m.saldo_anterior,
        },
        movimentosDivergentes: 1,
        primeiroMovimentoDivergente: { posicao: 10, movimentoId: m.id, seqLancamento: m.seq_lancamento },
      },
    ]);
  });

  it('o replay continuado de onde parou (o `--corrigir` sob a trava) chega ao mesmo estado do replay inteiro', () => {
    const { movimentos } = linha(produto(7), 500, 7);
    const inteiro = new ReplayLinha();
    for (const m of movimentos) inteiro.aplicar(m);
    const parte = new ReplayLinha();
    for (const m of movimentos.slice(0, 321)) parte.aplicar(m);
    const continuado = new ReplayLinha(parte.estado());
    for (const m of movimentos.slice(321)) continuado.aplicar(m);
    expect(continuado.estado()).toEqual(inteiro.estado());
  });
});

describe('lote e última compra no replay (F2-B6)', () => {
  const L1 = uuid('a7', 1);
  const L2 = uuid('a7', 2);
  /** Uma linha com compra com lote, venda do lote e uma compra sem lote (a última): o razão como o motor grava. */
  function linhaComLote(): { movimentos: MovimentoLido[]; saldo: SaldoLido } {
    const fatos: Array<[tipo: string, quantidade: string, custo: string | null, lote: string | null]> = [
      ['RECEB_MANUAL', '10', '3', L1],
      ['VENDA_PDV', '-4', null, L1],
      ['RECEB_NFE', '5', '4', null],
      ['VENDA_PDV', '-1', null, null],
    ];
    let saldo = '0';
    let custo = '0';
    const movimentos = fatos.map(([tipo, q, c, lote], i) => {
      const r = aplicarMovimentoNoSaldo(saldo, custo, {
        quantidade: q,
        custoUnitario: c,
        custoReferencia: '2',
      });
      saldo = r.saldoPosterior;
      custo = r.custoMedioPosterior;
      const us = dataUs(900 + i);
      return {
        estoque_id: ESTOQUE,
        produto_id: produto(8),
        variacao_id: null,
        tipo_estoque_id: TIPO,
        id: uuid('c8', i + 1),
        seq_lancamento: String(800 + i),
        quantidade: r.quantidade,
        saldo_anterior: r.saldoAnterior,
        saldo_posterior: r.saldoPosterior,
        custo_unitario: r.custoUnitario,
        custo_total: r.custoTotal,
        custo_medio_posterior: r.custoMedioPosterior,
        estorno_de_id: null,
        data_movimento: dataTexto(us),
        data_us: String(us),
        tipo_movimento: tipo,
        lote_id: lote,
      } satisfies MovimentoLido;
    });
    const ultima = (sinal: 1 | -1) => movimentos.filter((m) => Number(m.quantidade) * sinal > 0).at(-1)!;
    return {
      movimentos,
      saldo: {
        id: uuid('d8', 1),
        estoque_id: ESTOQUE,
        produto_id: produto(8),
        variacao_id: null,
        tipo_estoque_id: TIPO,
        quantidade: saldo,
        custo_medio: custo,
        ultima_entrada_em: ultima(1).data_movimento,
        ultima_entrada_us: ultima(1).data_us,
        ultima_saida_em: ultima(-1).data_movimento,
        ultima_saida_us: ultima(-1).data_us,
        ultimo_movimento_id: movimentos.at(-1)!.id,
        ultima_compra_em: movimentos[2]!.data_movimento,
        ultima_compra_us: movimentos[2]!.data_us,
        ultimo_custo_compra: '4.0000',
        lotes: [[L1, '6.000']],
      },
    };
  }

  it('refaz o saldo de cada lote e a última compra (a última entrada de compra lançada)', async () => {
    const { movimentos, saldo } = linhaComLote();
    const r = await conferir(movimentos, [saldo], 3);
    expect(r.divergencias).toEqual([]);
    const replay = new ReplayLinha();
    for (const m of movimentos) replay.aplicar(m);
    expect(replay.estado()).toMatchObject({
      quantidade: '10.000',
      ultimoCustoCompra: '4.0000',
      lotes: new Map([[L1, '6.000']]),
    });
  });

  it('acusa o lote gravado diferente (inclusive o que o razão não tem) e a última compra divergente', async () => {
    const { movimentos, saldo } = linhaComLote();
    const errado: SaldoLido = {
      ...saldo,
      ultimo_custo_compra: '3.0000',
      lotes: [
        [L1, '5.000'],
        [L2, '1.000'],
      ],
    };
    const r = await conferir(movimentos, [errado], 10);
    expect(r.divergencias).toHaveLength(1);
    expect(r.divergencias[0]!.situacao).toBe('divergente');
    expect(r.divergencias[0]!.campos).toEqual([
      { campo: 'ultimo_custo_compra', gravado: '3.0000', recalculado: '4.0000', diferenca: null },
      { campo: 'saldo_lote', loteId: L1, gravado: '5.000', recalculado: '6.000', diferenca: '1.000' },
      { campo: 'saldo_lote', loteId: L2, gravado: '1.000', recalculado: '0.000', diferenca: '-1.000' },
    ]);
  });
});

/** O último movimento da linha do produto 2 (o `ultimo_movimento_id` certo dela). */
function pequenaUltimo(movimentos: readonly MovimentoLido[]): string {
  return movimentos.filter((m) => m.produto_id === produto(2)).at(-1)!.id;
}
