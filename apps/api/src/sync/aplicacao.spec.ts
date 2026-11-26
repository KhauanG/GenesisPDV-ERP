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
import { versoesSchemaAceitas, type CatalogoHandlers, type ContextoHandler } from './eventos.js';
import { converterPayload, resolverHandler } from './handlers/comum.js';

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

describe('versões por tipo e upcasters (SYNC 17.5; F3-B4)', () => {
  const v1 = z.object({ valor: z.number() });
  const v2 = z.object({ valor: z.number(), unidade: z.enum(['un', 'cx']) });
  type V2 = z.infer<typeof v2>;

  /**
   * Tipo de teste com duas versões: a v2 (o handler) e a v1 pelo upcast (a v1 não tinha unidade: era sempre `un`). A
   * v2 ainda não foi anunciada (`anunciada: false`), como no meio de uma onda. A regra da v1: valor negativo era
   * recusado na v1 (e continua recusado para quem veio dela); na v2, o valor negativo é um estorno aceito.
   */
  function versionado(log: Array<{ versaoOrigem: number; payload: V2 }>, upcast?: (p: never) => unknown) {
    return {
      'teste.versionado': {
        2: {
          schema: v2,
          anunciada: false,
          versoes: {
            1: { schema: v1, upcast: upcast ?? ((p: z.infer<typeof v1>): V2 => ({ ...p, unidade: 'un' })) },
          },
          async aplicar(ctx: ContextoHandler, p: V2) {
            if (ctx.versaoOrigem === 1 && p.valor < 0) {
              throw new ErroRegraEvento('PAYLOAD_INVALIDO', 'Valor negativo não existe na v1.');
            }
            log.push({ versaoOrigem: ctx.versaoOrigem, payload: p });
            return { valor: p.valor, unidade: p.unidade };
          },
        },
      },
    } satisfies CatalogoHandlers;
  }

  const evento = (versao: number, payload: Record<string, unknown>) =>
    envelope({ tipo: 'teste.versionado', versao_schema: versao, payload });

  it('a v1 aplica pelo upcast (com a versão de origem) e a v2 direto; o payload do envelope não muda', async () => {
    const log: Array<{ versaoOrigem: number; payload: V2 }> = [];
    const handlers = versionado(log);
    const { c, tx } = clienteFalso();
    const ev1 = evento(1, { valor: 3 });
    await expect(aplicarEvento(tx, c, terminal, ev1, { handlers })).resolves.toMatchObject({
      status: 'aplicado',
      resultado: { valor: 3, unidade: 'un' },
    });
    expect(ev1.payload).toEqual({ valor: 3 });
    await expect(
      aplicarEvento(tx, c, terminal, evento(2, { valor: 5, unidade: 'cx' }), { handlers }),
    ).resolves.toMatchObject({ status: 'aplicado', resultado: { valor: 5, unidade: 'cx' } });
    expect(log).toEqual([
      { versaoOrigem: 1, payload: { valor: 3, unidade: 'un' } },
      { versaoOrigem: 2, payload: { valor: 5, unidade: 'cx' } },
    ]);
  });

  it('versão acima da maior conhecida (e a 0) é SCHEMA_DESCONHECIDO transitório, sem a 7300001', async () => {
    const { c, tx, log } = clienteFalso();
    const handlers = versionado([]);
    for (const versao of [3, 0]) {
      await expect(
        aplicarEvento(tx, c, terminal, evento(versao, { valor: 1, unidade: 'un' }), { handlers }),
      ).rejects.toMatchObject({ name: 'ErroTransitorioEvento', codigo: 'SCHEMA_DESCONHECIDO' });
    }
    expect(log.join()).not.toContain('fn_trava_versao');
  });

  it('a v1 recusada pela regra da v1 continua recusada depois do upcast; na v2 o mesmo valor é aceito', async () => {
    const log: Array<{ versaoOrigem: number; payload: V2 }> = [];
    const handlers = versionado(log);
    const { c, tx } = clienteFalso();
    await expect(
      aplicarEvento(tx, c, terminal, evento(1, { valor: -2 }), { handlers }),
    ).rejects.toMatchObject({
      codigo: 'PAYLOAD_INVALIDO',
      message: 'Valor negativo não existe na v1.',
    });
    await expect(
      aplicarEvento(tx, c, terminal, evento(2, { valor: -2, unidade: 'un' }), { handlers }),
    ).resolves.toMatchObject({ status: 'aplicado' });
    expect(log.map((l) => l.versaoOrigem)).toEqual([2]);
  });

  it('payload fora do schema da v1, upcaster que lança e upcaster que gera payload inválido: PAYLOAD_INVALIDO', async () => {
    const { c, tx, log } = clienteFalso();
    await expect(
      aplicarEvento(tx, c, terminal, evento(1, { valor: 'x' }), { handlers: versionado([]) }),
    ).rejects.toMatchObject({ codigo: 'PAYLOAD_INVALIDO', message: 'Payload fora do schema do tipo.' });
    const lanca = versionado([], () => {
      throw new TypeError('defeito de teste no upcaster');
    });
    await expect(
      aplicarEvento(tx, c, terminal, evento(1, { valor: 1 }), { handlers: lanca }),
    ).rejects.toMatchObject({
      codigo: 'PAYLOAD_INVALIDO',
      message: 'Falha na conversão do payload da v1 para a v2.',
      detalhes: { versao_origem: 1, versao: 1, falha: 'defeito de teste no upcaster' },
    });
    const invalido = versionado([], (p: { valor: number }) => ({ ...p, unidade: 'litro' }));
    await expect(
      aplicarEvento(tx, c, terminal, evento(1, { valor: 1 }), { handlers: invalido }),
    ).rejects.toMatchObject({
      codigo: 'PAYLOAD_INVALIDO',
      message: 'Payload convertido da v1 fora do schema da v2.',
      detalhes: { versao_origem: 1, versao: 2 },
    });
    expect(log.join()).not.toContain('fn_trava_versao');
  });

  it('versoes_schema: a v2 aceita e não anunciada fica fora; anunciada, entra; tipo sem versão anunciada some', () => {
    const handlers = versionado([]);
    expect(versoesSchemaAceitas(handlers)).toEqual({ 'teste.versionado': [1] });
    const anunciada: CatalogoHandlers = {
      'teste.versionado': { 2: { ...handlers['teste.versionado'][2], anunciada: true } },
    };
    expect(versoesSchemaAceitas(anunciada)).toEqual({ 'teste.versionado': [1, 2] });
    const novo: CatalogoHandlers = {
      'teste.novo': { 1: { schema: v1, anunciada: false, aplicar: () => Promise.resolve({}) } },
    };
    expect(versoesSchemaAceitas(novo)).toEqual({});
  });

  it('resolverHandler: o próprio, o de cima com o encadeamento completo, e nenhum com um buraco', () => {
    const h3 = {
      schema: v2,
      versoes: { 2: { schema: v1, upcast: (p: unknown) => p } },
      aplicar: () => Promise.resolve({}),
    };
    const h1 = { schema: v1, aplicar: () => Promise.resolve({}) };
    const catalogo: CatalogoHandlers = { 'teste.encadeado': { 1: h1, 3: h3 } };
    expect(resolverHandler(catalogo, 'teste.encadeado', 1)).toEqual({ handler: h1, versaoHandler: 1 });
    expect(resolverHandler(catalogo, 'teste.encadeado', 2)).toEqual({ handler: h3, versaoHandler: 3 });
    expect(resolverHandler(catalogo, 'teste.encadeado', 3)).toEqual({ handler: h3, versaoHandler: 3 });
    expect(resolverHandler(catalogo, 'teste.encadeado', 4)).toBeNull();
    expect(resolverHandler({ 'teste.buraco': { 3: h3 } }, 'teste.buraco', 1)).toBeNull();
    expect(resolverHandler(catalogo, 'teste.outro', 1)).toBeNull();
  });

  it('o encadeamento v1 → v2 → v3 passa por cada schema, na ordem', () => {
    const passos: string[] = [];
    const r = {
      versaoHandler: 3,
      handler: {
        schema: z.object({ n: z.number(), c: z.literal(true) }),
        versoes: {
          1: {
            schema: z.object({ n: z.number() }),
            upcast: (p: { n: number }) => (passos.push('1→2'), { ...p, b: true }),
          },
          2: {
            schema: z.object({ n: z.number(), b: z.literal(true) }),
            upcast: (p: { n: number }) => (passos.push('2→3'), { n: p.n, c: true }),
          },
        },
        aplicar: () => Promise.resolve({}),
      },
    };
    expect(converterPayload(r, 1, { n: 7 })).toEqual({ success: true, data: { n: 7, c: true } });
    expect(passos).toEqual(['1→2', '2→3']);
    expect(converterPayload(r, 2, { n: 7 })).toMatchObject({ success: false, versao: 2 });
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
