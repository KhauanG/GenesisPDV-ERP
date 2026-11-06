/**
 * Conferência do razão de estoque no fim das suítes que o movimentam (Fase 2, F2-B2): em cada banco de empresa do
 * ambiente, todo movimento tem `seq_lancamento`; a cadeia de cada linha de saldo fecha nessa ordem; o encadeamento
 * pelo saldo (`ordenarCadeia`, o que o preenchimento usa nos movimentos antigos) chega à mesma ordem; e o replay pela
 * função pura do shared (`aplicarMovimentoNoSaldo`, a do motor online) repete cada movimento gravado e a projeção
 * `saldos_estoque`. Lê linha a linha, para o banco das suítes (pequeno). Desde o F2-B3, também o núcleo do
 * `db:recalcular-saldos` (`verificarSaldos`): idêntico, sem linha órfã, sem razão inconsistente e com as datas, o
 * último movimento e o `produtos.custo_medio` batendo. Desde o F2-B6 a mesma conferência refaz `saldos_lote` e a última
 * compra: o saldo de cada lote é a soma dos movimentos com ele. Por consequência, Σ `saldos_lote` + a parte sem lote =
 * `saldos_estoque` (em qualquer modo de `estoque.lote_baixa_sem_informar`); a divisão FEFO em si é conferida no
 * `lotes-motor.test.ts`.
 */
import { aplicarMovimentoNoSaldo, dec, movimentoGravadoNoSaldo } from '@genesis/shared';
import { expect } from 'vitest';
import { linhasComCadeiaQuebrada, ordenarCadeia } from '../../src/estoques/cadeia.js';
import { verificarSaldos } from '../../src/estoques/recalcular.js';
import { conectar, consultar } from './ambiente.js';

interface Movimento {
  linha: string;
  id: string;
  seq_lancamento: string | null;
  quantidade: string;
  saldo_anterior: string;
  saldo_posterior: string;
  custo_unitario: string;
  custo_total: string;
  custo_medio_posterior: string;
  estorno_de_id: string | null;
  tipo_movimento: string;
}

export async function conferirRazaoDoBanco(banco: string): Promise<{ linhas: number; movimentos: number }> {
  const c = await conectar(banco);
  try {
    expect(await linhasComCadeiaQuebrada(c), `${banco}: cadeia quebrada`).toEqual([]);
    const { rows } = await c.query<Movimento>(
      `select concat_ws('|', estoque_id, produto_id, coalesce(variacao_id::text, ''), tipo_estoque_id) as linha,
              id, seq_lancamento::text, quantidade::text, saldo_anterior::text, saldo_posterior::text,
              custo_unitario::text, custo_total::text, custo_medio_posterior::text, estorno_de_id, tipo_movimento
         from movimentos_estoque
        order by linha, criado_em, id`,
    );
    expect(
      rows.filter((m) => m.seq_lancamento === null).map((m) => m.id),
      `${banco}: sem ordem`,
    ).toEqual([]);
    const porLinha = new Map<string, Movimento[]>();
    for (const m of rows) porLinha.set(m.linha, [...(porLinha.get(m.linha) ?? []), m]);
    const { rows: saldos } = await c.query<{ linha: string; quantidade: string; custo_medio: string }>(
      `select concat_ws('|', estoque_id, produto_id, coalesce(variacao_id::text, ''), tipo_estoque_id) as linha,
              quantidade::text, custo_medio::text
         from saldos_estoque`,
    );
    const saldoDa = new Map(saldos.map((s) => [s.linha, s]));
    for (const [linha, movimentos] of porLinha) {
      const porSeq = [...movimentos].sort((a, b) => Number(a.seq_lancamento) - Number(b.seq_lancamento));
      // O preenchimento dos antigos (pela cadeia de saldo, desempate por id) acharia a ordem real do lançamento.
      const r = ordenarCadeia(
        movimentos.map((m) => ({
          id: m.id,
          saldoAnterior: m.saldo_anterior,
          saldoPosterior: m.saldo_posterior,
        })),
      );
      expect(r.quebra, `${banco} ${linha}`).toBeNull();
      expect(
        r.ordem.map((e) => e.id),
        `${banco} ${linha}: ordem pela cadeia`,
      ).toEqual(porSeq.map((m) => m.id));
      let quantidade = '0';
      let custoMedio = '0';
      for (const m of porSeq) {
        const refeito = aplicarMovimentoNoSaldo(
          quantidade,
          custoMedio,
          movimentoGravadoNoSaldo({
            quantidade: m.quantidade,
            custoUnitario: m.custo_unitario,
            estornoDeId: m.estorno_de_id,
            tipoMovimento: m.tipo_movimento,
          }),
        );
        expect(refeito, `${banco} ${linha} ${m.id}`).toEqual({
          quantidade: m.quantidade,
          saldoAnterior: m.saldo_anterior,
          saldoPosterior: m.saldo_posterior,
          custoUnitario: m.custo_unitario,
          custoTotal: m.custo_total,
          custoMedioPosterior: m.custo_medio_posterior,
        });
        quantidade = refeito.saldoPosterior;
        custoMedio = refeito.custoMedioPosterior;
      }
      const s = saldoDa.get(linha);
      expect(s, `${banco} ${linha}: sem linha de saldo`).toBeDefined();
      expect(
        dec(s!.quantidade).eq(quantidade) && dec(s!.custo_medio).eq(custoMedio),
        `${banco} ${linha}`,
      ).toBe(true);
    }
    const recalculo = await verificarSaldos(c);
    expect(
      {
        divergencias: recalculo.divergencias,
        custo: recalculo.custoProdutos,
        razao: recalculo.razaoInconsistente,
      },
      `${banco}: db:recalcular-saldos`,
    ).toEqual({ divergencias: [], custo: [], razao: [] });
    expect(recalculo.movimentos).toBe(rows.length);
    return { linhas: porLinha.size, movimentos: rows.length };
  } finally {
    await c.end();
  }
}

/** `conferirRazaoDoBanco` em todos os bancos de empresa do ambiente; devolve o total de movimentos conferidos. */
export async function conferirRazaoDasEmpresas(bancoControle: string): Promise<number> {
  const bancos = await consultar<{ nome_banco: string }>(bancoControle, 'select nome_banco from empresas');
  let movimentos = 0;
  for (const { nome_banco } of bancos) movimentos += (await conferirRazaoDoBanco(nome_banco)).movimentos;
  return movimentos;
}
