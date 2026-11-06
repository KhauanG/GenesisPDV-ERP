/**
 * Propriedade da conta do razão (Fase 2, F2-B2): a função pura `aplicarMovimentoNoSaldo`, usada pelo motor online,
 * aplicada passo a passo sobre o documento, e o replay da lista gravada (`movimentoGravadoNoSaldo`, o que o
 * `db:recalcular-saldos` do F2-B3 faz na ordem de `seq_lancamento`) chegam ao mesmo saldo e ao mesmo custo médio, em
 * decimal, movimento a movimento. Sequências aleatórias com semente fixa (o gerador de `gerador.teste.ts`, sem dependência nova):
 * entradas com e sem custo, saídas além do saldo (zero e negativo), estornos de saída ao custo original (T20) e de
 * entrada, o estorno da perna de entrada da mudança de tipo ao custo gravado (F2-B8; a perda da transferência, F2-B24,
 * usa a mesma conta), compensações do "Definir" (T23)
 * e o próprio "Definir", com o custo de referência do cadastro mudando no meio.
 */
import { describe, expect, it } from 'vitest';
import { dec, decTexto } from './decimal.js';
import { gerador } from './gerador.teste.js';
import {
  aplicarMovimentoNoSaldo,
  diferencaDefinirTexto,
  TIPO_MOVIMENTO_MUDANCA_TIPO,
  movimentoGravadoNoSaldo,
  saidaAoCustoInformado,
  saidaDaPerdaTransferencia,
  type MovimentoNoSaldo,
  type SaldoAposMovimento,
} from './estoque.js';

interface Gravado extends SaldoAposMovimento {
  id: number;
  tipo: string;
  /** O que o replay lê do tipo gravado: só o estorno da mudança de tipo muda a conta (`estornoDeMudancaTipo`). */
  tipoMovimento: string;
  estornoDeId: string | null;
}

/** Uma sequência de documentos e o razão que o motor online gravaria, passo a passo. */
function lancarSequencia(semente: number, tamanho: number): Gravado[] {
  const g = gerador(semente);
  const gravados: Gravado[] = [];
  const estornados = new Set<number>();
  let saldo = '0';
  let custoMedio = '0';
  let custoReferencia = g.decimal(30, 4);
  const lancar = (tipo: string, mov: MovimentoNoSaldo, estornoDe: number | null = null) => {
    const r = aplicarMovimentoNoSaldo(saldo, custoMedio, mov);
    saldo = r.saldoPosterior;
    custoMedio = r.custoMedioPosterior;
    gravados.push({
      ...r,
      id: gravados.length,
      tipo,
      tipoMovimento: mov.saidaAoCusto ? TIPO_MOVIMENTO_MUDANCA_TIPO : 'OUTRO',
      estornoDeId: estornoDe === null ? null : `m${estornoDe}`,
    });
    if (estornoDe !== null) estornados.add(estornoDe);
  };
  for (let i = 0; i < tamanho; i++) {
    // O preço de custo do cadastro muda de vez em quando (é a referência da saída sem custo médio).
    if (g.inteiro(1, 8) === 1) custoReferencia = g.inteiro(1, 5) === 1 ? '0' : g.decimal(30, 4);
    const tipo = g.escolher([
      'entrada',
      'entrada_sem_custo',
      'saida',
      'saida',
      'saida_grande',
      'estorno_saida',
      'estorno_entrada',
      'estorno_mudanca',
      'compensacao',
      'definir',
      'zerar',
    ]);
    switch (tipo) {
      case 'entrada':
        lancar(tipo, {
          quantidade: g.decimal(200, 3),
          custoUnitario: g.inteiro(1, 10) === 1 ? '0' : g.decimal(50, 4),
          custoReferencia,
        });
        break;
      case 'entrada_sem_custo':
        lancar(tipo, { quantidade: g.decimal(50, 3), custoUnitario: null, custoReferencia });
        break;
      case 'saida':
        lancar(tipo, { quantidade: `-${g.decimal(40, 3)}`, custoReferencia });
        break;
      case 'saida_grande':
        // Caixa offline vendendo sem estoque: o saldo passa de zero para negativo.
        lancar(tipo, { quantidade: `-${g.decimal(400, 3)}`, custoReferencia });
        break;
      case 'estorno_saida':
      case 'estorno_entrada':
      case 'estorno_mudanca': {
        const alvos = gravados.filter(
          (m) =>
            m.estornoDeId === null &&
            !estornados.has(m.id) &&
            (tipo === 'estorno_saida' ? dec(m.quantidade).lt(0) : dec(m.quantidade).gt(0)),
        );
        if (!alvos.length) break;
        const alvo = g.escolher(alvos);
        // Cancelamento de venda / estorno de acerto: sinal oposto; a entrada de estorno vai ao custo original (T20). O
        // da mudança de tipo sai ao custo da entrada (F2-B8), com a conta inversa ou, sem ela, a saída comum.
        lancar(
          tipo,
          {
            quantidade: dec(alvo.quantidade).neg().toFixed(3),
            custoUnitario: tipo === 'estorno_entrada' ? null : alvo.custoUnitario,
            custoReferencia,
            estorno: true,
            saidaAoCusto: tipo === 'estorno_mudanca',
          },
          alvo.id,
        );
        break;
      }
      case 'compensacao': {
        // ACERTO_COMPENSACAO (T23): o oposto de um movimento tardio, ao custo médio vigente.
        const q = g.decimal(20, 3);
        lancar(tipo, { quantidade: g.inteiro(0, 1) ? q : `-${q}`, custoReferencia });
        break;
      }
      case 'definir': {
        // "Definir": a diferença entre o contado e o saldo (descontados posteriores, aqui nenhum), ao custo médio.
        const diferenca = diferencaDefinirTexto(g.decimal(300, 3), saldo, 0);
        if (!dec(diferenca).isZero()) lancar(tipo, { quantidade: diferenca, custoReferencia });
        break;
      }
      case 'zerar':
        if (!dec(saldo).isZero()) lancar(tipo, { quantidade: dec(saldo).neg().toFixed(3), custoReferencia });
        break;
    }
  }
  return gravados;
}

/** O replay da lista gravada, na ordem de lançamento, a partir da linha zerada. */
function reaplicar(gravados: readonly Gravado[]): SaldoAposMovimento[] {
  let saldo = '0';
  let custoMedio = '0';
  return gravados.map((m) => {
    const r = aplicarMovimentoNoSaldo(saldo, custoMedio, movimentoGravadoNoSaldo(m));
    saldo = r.saldoPosterior;
    custoMedio = r.custoMedioPosterior;
    return r;
  });
}

const SEMENTES = Array.from({ length: 300 }, (_, i) => 20261104 + i * 7919);

describe('conta do razão: online × replay (F2-B2; ADR-05; T20, T23)', () => {
  it('o replay da lista gravada repete saldo, custos e custo médio de cada movimento, em 300 sequências', () => {
    let negativos = 0;
    let zerados = 0;
    let estornos = 0;
    const mudancas = { inversa: 0, comum: 0 };
    for (const semente of SEMENTES) {
      const gravados = lancarSequencia(semente, 80);
      const refeitos = reaplicar(gravados);
      for (let i = 0; i < gravados.length; i++) {
        const { id: _id, tipo, tipoMovimento: _t, estornoDeId: _e, ...gravado } = gravados[i]!;
        expect(refeitos[i], `semente ${semente}, movimento ${i} (${tipo})`).toEqual(gravado);
      }
      negativos += gravados.filter((m) => dec(m.saldoPosterior).lt(0)).length;
      zerados += gravados.filter((m) => dec(m.saldoPosterior).isZero()).length;
      estornos += gravados.filter((m) => m.estornoDeId !== null).length;
      for (const m of gravados.filter((g) => g.tipo === 'estorno_mudanca')) {
        // A conta inversa muda o custo médio (salvo coincidência); a saída comum não.
        if (m.custoMedioPosterior === refeitos[gravados.indexOf(m) - 1]?.custoMedioPosterior)
          mudancas.comum++;
        else mudancas.inversa++;
      }
    }
    // A geração cobre o que importa (saldo negativo, zerado e estorno), senão a propriedade não diz nada.
    expect(negativos).toBeGreaterThan(500);
    expect(zerados).toBeGreaterThan(100);
    expect(estornos).toBeGreaterThan(500);
    expect(mudancas.inversa).toBeGreaterThan(50);
    expect(mudancas.comum).toBeGreaterThan(20);
  });

  it('a cadeia gravada fecha: saldo anterior = posterior do anterior, saldo final = Σ quantidades, custo ≥ 0', () => {
    for (const semente of SEMENTES.slice(0, 50)) {
      const gravados = lancarSequencia(semente, 120);
      let anterior = '0.000';
      let soma = dec(0);
      for (const m of gravados) {
        expect(m.saldoAnterior).toBe(anterior);
        expect(dec(m.saldoPosterior).eq(dec(m.saldoAnterior).plus(m.quantidade))).toBe(true);
        expect(dec(m.custoMedioPosterior).gte(0)).toBe(true);
        expect(m.custoTotal).toBe(decTexto(dec(m.quantidade).abs().times(m.custoUnitario), 2));
        anterior = m.saldoPosterior;
        soma = soma.plus(m.quantidade);
      }
      expect(decTexto(soma, 3)).toBe(gravados.at(-1)?.saldoPosterior ?? '0.000');
    }
  });

  it('casos fixos: entrada pondera, saída usa o custo médio, estorno de saída não puxa o custo do saldo negativo', () => {
    const e1 = aplicarMovimentoNoSaldo('0', '0', {
      quantidade: '10',
      custoUnitario: '5',
      custoReferencia: '9',
    });
    expect(e1).toEqual({
      quantidade: '10.000',
      saldoAnterior: '0.000',
      saldoPosterior: '10.000',
      custoUnitario: '5.0000',
      custoTotal: '50.00',
      custoMedioPosterior: '5.0000',
    });
    const e2 = aplicarMovimentoNoSaldo('10', '5', {
      quantidade: '10',
      custoUnitario: '7',
      custoReferencia: '9',
    });
    expect(e2.custoMedioPosterior).toBe('6.0000');
    // Saída sem custo médio: vai pelo custo de referência, que passa a ser o custo médio da linha.
    const s1 = aplicarMovimentoNoSaldo('0', '0', { quantidade: '-2', custoReferencia: '3.25' });
    expect([s1.custoUnitario, s1.custoMedioPosterior, s1.saldoPosterior]).toEqual([
      '3.2500',
      '3.2500',
      '-2.000',
    ]);
    // Saldo −10 com custo médio 14: devolver 1 a 8,00 mantém o 14 (T20).
    const t20 = aplicarMovimentoNoSaldo('-10', '14', {
      quantidade: '1',
      custoUnitario: '8',
      custoReferencia: '1',
      estorno: true,
    });
    expect([t20.custoUnitario, t20.custoMedioPosterior]).toEqual(['8.0000', '14.0000']);
    // Estorno de entrada é uma saída ao custo médio vigente.
    const ee = aplicarMovimentoNoSaldo('10', '6', { quantidade: '-4', custoReferencia: '1', estorno: true });
    expect([ee.custoUnitario, ee.custoMedioPosterior]).toEqual(['6.0000', '6.0000']);
    // Estorno da perna de entrada da mudança de tipo (F2-B8): Avaria 10 a 3,25 tira 5 a 2,50 e volta a 4,00.
    const em = aplicarMovimentoNoSaldo('10', '3.25', {
      quantidade: '-5',
      custoUnitario: '2.5',
      custoReferencia: '2.5',
      estorno: true,
      saidaAoCusto: true,
    });
    expect([em.custoUnitario, em.custoTotal, em.custoMedioPosterior]).toEqual(['2.5000', '12.50', '4.0000']);
    // A perda da transferência (F2-B24): o CD com 100 a 5,50 recebe o retorno de 2 a 5,00 (102 a 5,4902) e a perda,
    // o ACERTO_SAIDA que estorna o retorno, sai a 5,00: o CD volta a 100 a 5,50, e a perda fica em R$ 10,00.
    const retorno = aplicarMovimentoNoSaldo('100', '5.5', {
      quantidade: '2',
      custoUnitario: '5',
      custoReferencia: '5',
      estorno: true,
    });
    expect([retorno.saldoPosterior, retorno.custoMedioPosterior]).toEqual(['102.000', '5.4902']);
    const perdaGravada = movimentoGravadoNoSaldo({
      quantidade: '-2',
      custoUnitario: '5',
      estornoDeId: 'retorno',
      tipoMovimento: 'ACERTO_SAIDA',
    });
    expect(perdaGravada.saidaAoCusto).toBe(true);
    const perda = aplicarMovimentoNoSaldo(retorno.saldoPosterior, retorno.custoMedioPosterior, perdaGravada);
    expect([perda.saldoPosterior, perda.custoUnitario, perda.custoTotal, perda.custoMedioPosterior]).toEqual([
      '100.000',
      '5.0000',
      '10.00',
      '5.5000',
    ]);
    // O ACERTO_SAIDA comum (sem estorno) e o ESTORNO_ACERTO saem ao custo médio vigente.
    expect(saidaAoCustoInformado({ tipoMovimento: 'ACERTO_SAIDA', estornoDeId: null })).toBe(false);
    expect(saidaAoCustoInformado({ tipoMovimento: 'ESTORNO_ACERTO', estornoDeId: 'x' })).toBe(false);
    expect(saidaDaPerdaTransferencia({ tipoMovimento: 'ACERTO_SAIDA', estornoDeId: 'x' })).toBe(true);
    expect(saidaAoCustoInformado({ tipoMovimento: TIPO_MOVIMENTO_MUDANCA_TIPO, estornoDeId: 'x' })).toBe(
      true,
    );
    // Sem nada que sobre, ou com o médio que ficaria ≤ 0, é a saída comum ao custo médio vigente.
    const zera = aplicarMovimentoNoSaldo('5', '3.25', {
      quantidade: '-5',
      custoUnitario: '2.5',
      custoReferencia: '2.5',
      saidaAoCusto: true,
    });
    expect([zera.custoUnitario, zera.custoMedioPosterior]).toEqual(['3.2500', '3.2500']);
    const negativo = aplicarMovimentoNoSaldo('10', '1', {
      quantidade: '-5',
      custoUnitario: '3',
      custoReferencia: '3',
      saidaAoCusto: true,
    });
    expect([negativo.custoUnitario, negativo.custoMedioPosterior]).toEqual(['1.0000', '1.0000']);
    expect(() =>
      aplicarMovimentoNoSaldo('10', '1', { quantidade: '-1', custoReferencia: '1', saidaAoCusto: true }),
    ).toThrow('sem o custo');
    expect(() => aplicarMovimentoNoSaldo('1', '1', { quantidade: '0.0004', custoReferencia: '1' })).toThrow(
      'quantidade zero',
    );
    expect(() =>
      aplicarMovimentoNoSaldo('1', '1', { quantidade: '1', custoReferencia: '1', estorno: true }),
    ).toThrow('custo da saída original');
  });
});
