import { relogioSuspeitoCompensacao } from '@genesis/shared';
import { describe, expect, it } from 'vitest';
import { motivosRelogioDoEvento, type RelogioDoEvento } from './compensacoes-acerto.js';

const MIN = 60_000;
const recebidoEm = new Date('2026-11-04T15:00:00.000Z');
const em = (ms: number) => new Date(recebidoEm.getTime() + ms);
/** A venda offline de há 2 h, recebida agora, com o relógio certo: nada a duvidar. */
const evento = (extra: Partial<RelogioDoEvento> = {}): RelogioDoEvento => ({
  ocorridoEm: em(-120 * MIN),
  recebidoEm,
  ativadoEm: new Date('2026-10-01T12:00:00.000Z'),
  anterior: { sequencia: 4, ocorridoEm: em(-130 * MIN) },
  relogioConfiavel: true,
  relogioRegrediu: false,
  desvioMs: 1_500,
  ...extra,
});

describe('motivosRelogioDoEvento (F2-B10; SYNC 12.3–12.4)', () => {
  it('a venda offline com o relógio certo não tem motivo (o atraso da entrega não é suspeita)', () => {
    expect(motivosRelogioDoEvento(evento())).toEqual([]);
    expect(motivosRelogioDoEvento(evento({ ocorridoEm: em(-30 * 24 * 60 * MIN), anterior: null }))).toEqual(
      [],
    );
  });

  it('o caixa sem hora confiável e o desvio acima de 5 min só sem a hora confiável', () => {
    expect(motivosRelogioDoEvento(evento({ relogioConfiavel: false }))).toEqual(['nao_confiavel']);
    expect(motivosRelogioDoEvento(evento({ relogioConfiavel: false, desvioMs: 5 * MIN }))).toEqual([
      'nao_confiavel',
    ]);
    expect(motivosRelogioDoEvento(evento({ relogioConfiavel: false, desvioMs: -5 * MIN - 1 }))).toEqual([
      'nao_confiavel',
      'desvio',
    ]);
    // Sem dizer se a hora é confiável, o desvio grande conta sozinho.
    expect(motivosRelogioDoEvento(evento({ relogioConfiavel: null, desvioMs: 10 * MIN }))).toEqual([
      'desvio',
    ]);
    // Sem a medida (caixa antigo), o desvio não conta.
    expect(motivosRelogioDoEvento(evento({ relogioConfiavel: null, desvioMs: null }))).toEqual([]);
  });

  it('o desvio grande com a hora confiável não é suspeita: o caixa já corrigiu a hora do fato por ele (SYNC 12.2)', () => {
    // O PC com o Windows 10 min (ou 20) atrasado, online, mede o desvio pela API e grava a hora certa.
    for (const desvioMs of [10 * MIN, -20 * MIN]) {
      const motivos = motivosRelogioDoEvento(evento({ relogioConfiavel: true, desvioMs }));
      expect(motivos).toEqual([]);
      expect(relogioSuspeitoCompensacao(motivos)).toBe(false);
    }
  });

  it('as regras da SYNC 12.4 (as mesmas do alerta RELOGIO_SUSPEITO), na ordem dos motivos', () => {
    expect(motivosRelogioDoEvento(evento({ ocorridoEm: em(6 * MIN), anterior: null }))).toEqual(['futuro']);
    expect(
      motivosRelogioDoEvento(evento({ ocorridoEm: new Date('2026-09-01T00:00:00.000Z'), anterior: null })),
    ).toEqual(['passado']);
    expect(motivosRelogioDoEvento(evento({ anterior: { sequencia: 4, ocorridoEm: em(-60 * MIN) } }))).toEqual(
      ['regressao'],
    );
    expect(
      motivosRelogioDoEvento(
        evento({ relogioConfiavel: false, desvioMs: 10 * MIN, ocorridoEm: em(6 * MIN), anterior: null }),
      ),
    ).toEqual(['nao_confiavel', 'futuro', 'desvio']);
  });

  it('a regressão marcada pelo caixa aparece, mas não destaca a compensação', () => {
    const marcada = motivosRelogioDoEvento(
      evento({ relogioRegrediu: true, anterior: { sequencia: 4, ocorridoEm: em(-60 * MIN) } }),
    );
    expect(marcada).toEqual(['regressao_marcada']);
    expect(relogioSuspeitoCompensacao(marcada)).toBe(false);
    expect(relogioSuspeitoCompensacao(['regressao_marcada', 'desvio'])).toBe(true);
    expect(relogioSuspeitoCompensacao([])).toBe(false);
  });
});
