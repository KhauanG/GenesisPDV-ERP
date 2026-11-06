import { createHash } from 'node:crypto';
import { jcs } from '@genesis/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ClienteEmpresa } from '../tenancy/tenancy.js';
import {
  aplicarEvento,
  envelopeDaLinha,
  envelopeSemPayload,
  MedidorTravaVersao,
  type TerminalDoEvento,
} from './aplicacao.js';
import type { EnvelopeEvento } from './contratos.js';
import { ErroRegraEvento } from './erros.js';
import type { CatalogoHandlers } from './eventos.js';

const terminal: TerminalDoEvento = {
  terminalId: uuidv7(),
  lojaId: uuidv7(),
  caixaId: uuidv7(),
  numeroCaixa: 2,
  ip: '10.0.0.7',
};

function envelope(extra: Partial<EnvelopeEvento> = {}): EnvelopeEvento {
  const payload = { valor: 1 };
  return {
    evento_id: uuidv7(),
    sequencia: 1,
    tipo: 'teste.aplicado',
    versao_schema: 1,
    agregado_tipo: 'teste',
    agregado_id: uuidv7(),
    dependencias: [],
    ocorrido_em: new Date().toISOString(),
    usuario_id: uuidv7(),
    relogio_confiavel: false,
    desvio_relogio_ms: 1500,
    contexto: { loja_id: terminal.lojaId, caixa_id: terminal.caixaId, numero_caixa: 2, estoque_id: uuidv7() },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
    ...extra,
  };
}

/** Conexão falsa: registra cada SQL em ordem (o do Drizzle e o cru) e responde vazio, salvo o `nextval`. */
function clienteFalso() {
  const log: string[] = [];
  let versao = 100;
  const cliente = {
    query(q: string | { text: string }, valores?: unknown[]) {
      const texto = typeof q === 'string' ? q : q.text;
      log.push(
        valores?.some((v) => String(v).startsWith('push:')) ? `${texto} [${String(valores[0])}]` : texto,
      );
      if (texto.includes('nextval')) return Promise.resolve({ rows: [{ v: String(++versao) }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0, fields: [] });
    },
  };
  const c = cliente as unknown as ClienteEmpresa;
  return { c, tx: drizzle(c), log };
}

function catalogo(log: string[]): CatalogoHandlers {
  return {
    'teste.aplicado': {
      1: {
        schema: z.object({ valor: z.number() }),
        async aplicar({ c }) {
          log.push('handler');
          await c.query('select 1 as efeito');
          return { ok: true };
        },
      },
    },
  };
}

describe('aplicarEvento (SYNC 8.1, 8.3)', () => {
  it('ordem das travas: push:<terminal> → fn_trava_versao → marcador → handler → marcador → aplicado', async () => {
    const { c, tx, log } = clienteFalso();
    const d = await aplicarEvento(tx, c, terminal, envelope(), {
      handlers: catalogo(log),
      entregueNaResposta: true,
    });
    expect(d).toMatchObject({
      status: 'aplicado',
      versaoNuvem: 101,
      versaoNuvemFim: 102,
      resultado: { ok: true },
    });
    const pos = (trecho: string) => log.findIndex((l) => l.includes(trecho));
    expect(pos(`push:${terminal.terminalId}`)).toBe(0);
    expect(log[0]).toContain('pg_advisory_xact_lock(hashtextextended');
    expect(pos('fn_trava_versao')).toBeGreaterThan(0);
    expect(pos('nextval')).toBeGreaterThan(pos('fn_trava_versao'));
    expect(pos('handler')).toBeGreaterThan(pos('nextval'));
    expect(log.findLastIndex((l) => l.includes('nextval'))).toBeGreaterThan(pos('handler'));
    expect(log.at(-1)).toMatch(/^update "eventos_recebidos"/);
    // Nenhuma outra trava consultiva antes da do terminal.
    expect(log.slice(0, pos(`push:${terminal.terminalId}`)).join()).not.toContain('advisory');
  });

  it('preparar lê antes da 7300001 e o que devolve chega ao aplicar (C6a)', async () => {
    const { c, tx, log } = clienteFalso();
    const handlers: CatalogoHandlers = {
      'teste.aplicado': {
        1: {
          schema: z.object({ valor: z.number() }),
          async preparar({ c: cx }, p: { valor: number }) {
            await cx.query('select id from produtos as leitura_cadastro');
            return { lido: p.valor + 1 };
          },
          async aplicar(_ctx, _p, preparado: { lido: number }) {
            log.push(`handler:${preparado.lido}`);
            return { lido: preparado.lido };
          },
        },
      },
    };
    const d = await aplicarEvento(tx, c, terminal, envelope(), { handlers });
    expect(d).toMatchObject({ status: 'aplicado', resultado: { lido: 2 } });
    const pos = (trecho: string) => log.findIndex((l) => l.includes(trecho));
    expect(pos('leitura_cadastro')).toBeGreaterThan(pos(`push:${terminal.terminalId}`));
    expect(pos('leitura_cadastro')).toBeLessThan(pos('fn_trava_versao'));
    expect(pos('handler:2')).toBeGreaterThan(pos('fn_trava_versao'));
  });

  it('preparar não roda com payload inválido (nem pega a 7300001)', async () => {
    const { c, tx, log } = clienteFalso();
    let preparou = 0;
    const handlers: CatalogoHandlers = {
      'teste.aplicado': {
        1: {
          schema: z.object({ valor: z.number() }),
          async preparar() {
            preparou++;
            return null;
          },
          async aplicar() {
            return {};
          },
        },
      },
    };
    await expect(
      aplicarEvento(tx, c, terminal, envelope({ payload: { valor: 'x' } }), { handlers }),
    ).rejects.toBeInstanceOf(ErroRegraEvento);
    expect(preparou).toBe(0);
    expect(log.join()).not.toContain('fn_trava_versao');
  });

  it('escopo de outra loja: recusa antes de pegar a 7300001', async () => {
    const { c, tx, log } = clienteFalso();
    const ev = envelope({ contexto: { loja_id: uuidv7(), caixa_id: terminal.caixaId } });
    await expect(aplicarEvento(tx, c, terminal, ev, { handlers: catalogo(log) })).rejects.toMatchObject({
      codigo: 'ESCOPO_INVALIDO',
    });
    expect(log.join()).not.toContain('fn_trava_versao');
  });

  it('tipo sem handler é transitório e payload fora do schema é regra, ambos sem a 7300001', async () => {
    const { c, tx, log } = clienteFalso();
    await expect(
      aplicarEvento(tx, c, terminal, envelope({ tipo: 'teste.desconhecido' }), { handlers: catalogo(log) }),
    ).rejects.toMatchObject({ name: 'ErroTransitorioEvento', codigo: 'SCHEMA_DESCONHECIDO' });
    const errado = envelope({ payload: { valor: 'x' } });
    await expect(aplicarEvento(tx, c, terminal, errado, { handlers: catalogo(log) })).rejects.toBeInstanceOf(
      ErroRegraEvento,
    );
    expect(log.join()).not.toContain('fn_trava_versao');
  });
});

describe('envelope gravado (T1)', () => {
  it('guarda tudo menos o payload e remonta o mesmo envelope', () => {
    const ev = envelope({ relogio_regrediu: true, ocorrido_em_local: new Date().toISOString() });
    const gravado = envelopeSemPayload(ev);
    expect(gravado).not.toHaveProperty('payload');
    expect(gravado).toMatchObject({
      usuario_id: ev.usuario_id,
      contexto: ev.contexto,
      relogio_confiavel: false,
    });
    const linha = {
      eventoId: ev.evento_id,
      terminalId: terminal.terminalId,
      lojaId: terminal.lojaId,
      sequenciaTerminal: ev.sequencia,
      tipo: ev.tipo,
      versaoSchema: ev.versao_schema,
      agregadoTipo: ev.agregado_tipo,
      agregadoId: ev.agregado_id,
      dependencias: [],
      ocorridoEm: new Date(ev.ocorrido_em),
      ocorridoEmLocal: null,
      payload: ev.payload,
      payloadSha256: ev.payload_sha256,
      envelope: JSON.parse(JSON.stringify(gravado)) as unknown,
    } as unknown as Parameters<typeof envelopeDaLinha>[0];
    expect(envelopeDaLinha(linha, terminal)).toEqual({ ...ev, terminal_id: terminal.terminalId });
  });

  it('linha anterior à 0010 (envelope vazio): colunas, contexto do terminal, sem os bloqueadores da coluna', () => {
    const ev = envelope();
    const dep = { agregado_tipo: 'sessao_caixa', agregado_id: uuidv7() };
    const linha = {
      eventoId: ev.evento_id,
      terminalId: terminal.terminalId,
      lojaId: terminal.lojaId,
      sequenciaTerminal: 7,
      tipo: ev.tipo,
      versaoSchema: 1,
      agregadoTipo: ev.agregado_tipo,
      agregadoId: ev.agregado_id,
      dependencias: [dep, { evento_id_bloqueador: uuidv7() }],
      ocorridoEm: new Date(ev.ocorrido_em),
      ocorridoEmLocal: null,
      payload: ev.payload,
      payloadSha256: ev.payload_sha256,
      envelope: {},
    } as unknown as Parameters<typeof envelopeDaLinha>[0];
    expect(envelopeDaLinha(linha, terminal)).toMatchObject({
      sequencia: 7,
      usuario_id: null,
      dependencias: [dep],
      contexto: { loja_id: terminal.lojaId, caixa_id: terminal.caixaId, numero_caixa: 2 },
      payload: ev.payload,
    });
    expect(() => envelopeDaLinha({ ...linha, payload: null } as typeof linha, terminal)).toThrowError(
      ErroRegraEvento,
    );
  });
});

describe('MedidorTravaVersao', () => {
  it('p95 pelo posto mais próximo, numa janela circular', () => {
    const m = new MedidorTravaVersao(100);
    expect(m.resumo()).toEqual({ amostras: 0, total: 0, p50: null, p95: null, maximo: null });
    for (let i = 1; i <= 100; i++) m.registrar(i);
    expect(m.resumo()).toEqual({ amostras: 100, total: 100, p50: 50, p95: 95, maximo: 100 });
    for (let i = 0; i < 100; i++) m.registrar(1);
    expect(m.resumo()).toMatchObject({ amostras: 100, total: 200, p95: 1, maximo: 1 });
    m.registrar(Number.NaN);
    m.registrar(-1);
    expect(m.resumo().total).toBe(200);
  });
});
