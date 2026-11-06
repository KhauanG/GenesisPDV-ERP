import { describe, expect, it } from 'vitest';
import { chaveRelogioSuspeito, suspeitasDoRelogio } from './relogio.js';

const MIN = 60_000;
const DIA = 86_400_000;
const recebidoEm = new Date('2026-11-04T15:00:00.000Z');
const ativadoEm = new Date('2026-10-01T12:00:00.000Z');
const em = (ms: number) => new Date(recebidoEm.getTime() + ms);
const motivos = (
  ocorridoMs: number,
  extra: { relogioRegrediu?: boolean; anteriorMs?: number; ativadoEm?: Date | null } = {},
) =>
  suspeitasDoRelogio(
    { ocorridoEm: em(ocorridoMs), relogioRegrediu: extra.relogioRegrediu ?? false },
    {
      recebidoEm,
      ativadoEm: extra.ativadoEm === undefined ? ativadoEm : extra.ativadoEm,
      anterior: extra.anteriorMs === undefined ? null : { sequencia: 7, ocorridoEm: em(extra.anteriorMs) },
    },
  ).map((s) => `${s.motivo}:${s.severidade}`);

describe('suspeitasDoRelogio (SYNC 12.4, C16)', () => {
  it('futuro só acima de 5 min da chegada', () => {
    expect(motivos(5 * MIN)).toEqual([]);
    expect(motivos(5 * MIN + 1)).toEqual(['futuro:aviso']);
    // Atraso de entrega (offline por horas) é métrica, não regra.
    expect(motivos(-30 * DIA)).toEqual([]);
  });

  it('passado: antes da ativação − 1 dia, ou mais de 400 dias', () => {
    const antes = ativadoEm.getTime() - recebidoEm.getTime();
    expect(motivos(antes - DIA)).toEqual([]);
    expect(motivos(antes - DIA - 1)).toEqual(['passado:aviso']);
    // Sem a ativação (linha antiga), vale só o teto de 400 dias.
    expect(motivos(antes - 2 * DIA, { ativadoEm: null })).toEqual([]);
    expect(motivos(-400 * DIA - 1, { ativadoEm: null })).toEqual(['passado:aviso']);
  });

  it('regressão: marcada pelo caixa é info; sem a marca, aviso acima de 1 s', () => {
    expect(motivos(0, { anteriorMs: 1_000 })).toEqual([]);
    expect(motivos(0, { anteriorMs: 1_001 })).toEqual(['regressao:aviso']);
    expect(motivos(0, { anteriorMs: 500, relogioRegrediu: true })).toEqual(['regressao_marcada:info']);
    // A marca sem regressão de fato (o anterior era um placeholder ou chegou com a hora certa) não alerta.
    expect(motivos(0, { anteriorMs: -MIN, relogioRegrediu: true })).toEqual([]);
    // O caixa com a BIOS em 2027 corrigido: o evento seguinte volta com a hora certa e a marca.
    expect(motivos(0, { anteriorMs: 200 * DIA, relogioRegrediu: true })).toEqual(['regressao_marcada:info']);
    // Ainda adiantado e anterior a outro mais adiantado: as duas regras.
    expect(motivos(10 * MIN, { anteriorMs: 20 * MIN })).toEqual(['futuro:aviso', 'regressao:aviso']);
  });

  it('chave: uma aberta por terminal e motivo; a regressão marcada, uma por regressão', () => {
    expect(chaveRelogioSuspeito('t1', 'futuro', 'e1')).toBe('relogio_suspeito:t1:futuro');
    expect(chaveRelogioSuspeito('t1', 'regressao', 'e1')).toBe('relogio_suspeito:t1:regressao');
    expect(chaveRelogioSuspeito('t1', 'regressao_marcada', 'e1')).toBe('relogio_regrediu:e1');
  });
});
