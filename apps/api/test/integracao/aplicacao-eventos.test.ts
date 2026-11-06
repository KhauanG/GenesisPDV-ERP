/**
 * Base da aplicação de eventos da Fase 1C (bloco C1): o envelope fica guardado em `eventos_recebidos.envelope` (T1),
 * `aplicarEvento` reaplica um evento gravado com o mesmo resultado (como o reprocessamento do ERP vai fazer), os
 * erros do PostgreSQL viram os códigos da SYNC 11.2 (T14) sem passar pelas tentativas do `ERRO_INTERNO`, a auditoria
 * comum grava `origem = 'pdv'` com o `evento_id`, e o tempo com a trava 7300001 presa é medido.
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { jcs, respostaPushSchema, type Ativar } from '@genesis/shared';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { caixas, eventosRecebidos } from '../../src/database/empresa/schema/index.js';
import type { ContextoEmpresa } from '../../src/tenancy/contexto.js';
import {
  aplicarEvento,
  carregarTerminalDoEvento,
  envelopeDaLinha,
  type DesfechoAplicacao,
} from '../../src/sync/aplicacao.js';
import { HANDLERS, type CatalogoHandlers } from '../../src/sync/eventos.js';
import { PushSync } from '../../src/sync/push.js';
import type { TerminalAutenticado } from '../../src/sync/terminal.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let contexto: ContextoEmpresa;
let loja1: string;
let caixa1: string;
let terminalId: string;
let token: string;
let seq = 0;

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function cabecalhos(tk?: string) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

function evento(tipo: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    evento_id: uuidv7(),
    sequencia: ++seq,
    tipo,
    versao_schema: 1,
    agregado_tipo: 'terminal',
    agregado_id: uuidv7(),
    dependencias: [],
    ocorrido_em: new Date().toISOString(),
    ocorrido_em_local: new Date().toISOString(),
    relogio_confiavel: true,
    usuario_id: null,
    contexto: {
      loja_id: loja1,
      caixa_id: caixa1,
      numero_caixa: 1,
      versao_app: '1.0.0',
      versao_schema_local: 1,
    },
    payload,
    payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
    ...extra,
  };
}

const lote = (eventos: unknown[]) => ({
  lote_id: uuidv7(),
  terminal_id: terminalId,
  enviado_em: new Date().toISOString(),
  eventos,
});

const push = (eventos: unknown[]) => amb.http().post('/sync/push').set(cabecalhos(token)).send(lote(eventos));

const naEmpresa = <T>(fn: () => Promise<T>) => amb.servicos.tenancy.executarNaEmpresa(contexto, fn);

/** Reaplica a linha gravada como o reprocessamento do ERP vai fazer: terminal lido de `terminais`, envelope da linha. */
const reaplicar = (eventoId: string) =>
  naEmpresa(() =>
    amb.servicos.tenancy.cx().transacao(async (tx, c): Promise<DesfechoAplicacao> => {
      const t = await carregarTerminalDoEvento(c, terminalId);
      const [linha] = await tx.select().from(eventosRecebidos).where(eq(eventosRecebidos.eventoId, eventoId));
      return aplicarEvento(tx, c, t!, envelopeDaLinha(linha!, t!));
    }),
  );

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  contexto = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  [{ id: caixa1 }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [loja1, 'Caixa 01'],
  )) as [{ id: string }];
  const tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ lojaId: loja1, caixaId: caixa1, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status).toBe(201);
  terminalId = r.body.terminal_id;
  token = r.body.token;
});

afterAll(async () => {
  await amb?.fechar();
});

describe('envelope em eventos_recebidos (T1; MD 3.15.2; SYNC 12.4)', () => {
  it('guarda usuário, contexto e relógio do envelope, sem duplicar o payload', async () => {
    const usuario = uuidv7();
    const estoque = uuidv7();
    const ev = evento(
      'terminal.configuracao_alterada',
      {
        alteracoes: [{ chave: 'pdv.tema', valor_anterior: 'claro', valor_novo: 'escuro' }],
        configuracao_completa: { 'pdv.tema': 'escuro' },
      },
      {
        usuario_id: usuario,
        desvio_relogio_ms: -4200,
        relogio_confiavel: false,
        relogio_regrediu: true,
        contexto: {
          loja_id: loja1,
          caixa_id: caixa1,
          numero_caixa: 1,
          estoque_id: estoque,
          sessao_caixa_id: null,
        },
      },
    );
    const r = await push([ev]);
    expect(r.status).toBe(200);
    respostaPushSchema.parse(r.body);
    expect(r.body.resultados[0]).toMatchObject({ status: 'aplicado' });
    const [linha] = await consultar<{ envelope: Record<string, unknown> }>(
      emp.nomeBanco,
      'select envelope from eventos_recebidos where evento_id = $1',
      [ev.evento_id],
    );
    const { payload: _p, ...esperado } = ev;
    expect(linha!.envelope).toEqual(esperado);
    expect(linha!.envelope).not.toHaveProperty('payload');

    // Auditoria comum da aplicação (rodapé da SYNC 10.1).
    const aud = await consultar(
      emp.nomeBanco,
      `select origem, usuario_id, terminal_id, loja_id, acao, (ip is not null) as tem_ip
         from auditoria where evento_id = $1`,
      [ev.evento_id],
    );
    expect(aud).toEqual([
      {
        origem: 'pdv',
        usuario_id: usuario,
        terminal_id: terminalId,
        loja_id: loja1,
        acao: 'editar',
        tem_ip: true,
      },
    ]);
  });
});

describe('envelope de linha `recebido` anterior à 0010 (T1)', () => {
  it('o reenvio do mesmo evento regrava o envelope sobre o `{}` da migração', async () => {
    let chamadas = 0;
    const catalogo: CatalogoHandlers = {
      ...HANDLERS,
      'teste.falha_uma_vez': {
        1: {
          schema: z.object({}),
          async aplicar() {
            if (++chamadas === 1) throw new Error('falha não classificada de teste');
            return { ok: true };
          },
        },
      },
    };
    const pushTeste = new PushSync(amb.servicos.tenancy, { handlers: catalogo });
    const usuario = uuidv7();
    const ev = evento('teste.falha_uma_vez', {}, { usuario_id: usuario, relogio_confiavel: false });
    const t = {
      terminalId,
      lojaId: loja1,
      caixaId: caixa1,
      numeroCaixa: 1,
      ip: '127.0.0.1',
    } as unknown as TerminalAutenticado;
    const r1 = await naEmpresa(() => pushTeste.receber(t, lote([ev])));
    expect(r1.resultados[0]).toMatchObject({ status: 'erro_temporario', erro: { codigo: 'ERRO_INTERNO' } });
    // Como uma linha gravada antes da migração 0010: `recebido`, envelope no default.
    await consultar(emp.nomeBanco, "update eventos_recebidos set envelope = '{}' where evento_id = $1", [
      ev.evento_id,
    ]);
    const [antes] = await consultar<{ status: string; envelope: unknown }>(
      emp.nomeBanco,
      'select status, envelope from eventos_recebidos where evento_id = $1',
      [ev.evento_id],
    );
    expect(antes).toEqual({ status: 'recebido', envelope: {} });

    const r2 = await naEmpresa(() => pushTeste.receber(t, lote([ev])));
    expect(r2.resultados[0]).toMatchObject({ status: 'aplicado', resultado: { ok: true } });
    const [linha] = await consultar<{ envelope: Record<string, unknown>; tentativas: number }>(
      emp.nomeBanco,
      'select envelope, tentativas from eventos_recebidos where evento_id = $1',
      [ev.evento_id],
    );
    const { payload: _p, ...esperado } = ev;
    expect(linha!.envelope).toEqual(esperado);
    expect(linha!.envelope).toMatchObject({ usuario_id: usuario, relogio_confiavel: false });
    expect(linha!.tentativas).toBe(2);
  });
});

describe('aplicarEvento fora do push (base do reprocessamento, SYNC 11.4)', () => {
  it('reaplicar o evento gravado dá o mesmo resultado, com marcadores novos e a resolução pendente de entrega', async () => {
    const config = evento('terminal.configuracao_alterada', {
      alteracoes: [{ chave: 'pdv.som', valor_novo: true }],
      configuracao_completa: { 'pdv.som': true },
    });
    const descricao = `reaplicação ${uuidv7()}`;
    const registros = evento('auditoria.registros', {
      registros: [
        {
          id: uuidv7(),
          ocorrido_em: new Date().toISOString(),
          acao: 'gaveta_aberta',
          entidade: 'pdv',
          descricao,
        },
      ],
      logins: [],
    });
    const r = await push([config, registros]);
    expect(r.body.resultados.map((x: { status: string }) => x.status)).toEqual(['aplicado', 'aplicado']);
    const original = r.body.resultados[0];
    const [antes] = await consultar(emp.nomeBanco, 'select configuracao_local from terminais where id = $1', [
      terminalId,
    ]);

    // Como se o ERP mandasse reprocessar (C8): a linha volta a `erro` e é aplicada de novo.
    await consultar(
      emp.nomeBanco,
      "update eventos_recebidos set status = 'erro', erro_codigo = 'ERRO_INTERNO' where evento_id = any($1)",
      [[config.evento_id, registros.evento_id]],
    );
    const d = await reaplicar(config.evento_id);
    expect(d).toMatchObject({ status: 'aplicado', resultado: original.resultado });
    if (d.status !== 'aplicado') throw new Error('não aplicou');
    expect(d.versaoNuvem).toBeGreaterThan(original.versao_nuvem_fim);
    const [depois] = await consultar(
      emp.nomeBanco,
      'select configuracao_local from terminais where id = $1',
      [terminalId],
    );
    expect(depois).toEqual(antes);
    const [linha] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select status, erro_codigo, resolucao_entregue_em, versao_nuvem::int as v
         from eventos_recebidos where evento_id = $1`,
      [config.evento_id],
    );
    expect(linha).toEqual({
      status: 'aplicado',
      erro_codigo: null,
      resolucao_entregue_em: null,
      v: d.versaoNuvem,
    });

    // `auditoria.registros` é idempotente pelo id local: reaplicar não duplica.
    expect(await reaplicar(registros.evento_id)).toMatchObject({ status: 'aplicado' });
    const auds = await consultar(emp.nomeBanco, 'select id from auditoria where descricao = $1', [descricao]);
    expect(auds).toHaveLength(1);
  });

  it('escopo de outro caixa é recusado também fora do push', async () => {
    const ev = evento('auditoria.registros', { registros: [], logins: [] });
    expect((await push([ev])).body.resultados[0].status).toBe('aplicado');
    await consultar(
      emp.nomeBanco,
      `update eventos_recebidos set status = 'erro',
              envelope = jsonb_set(envelope, '{contexto,caixa_id}', to_jsonb($2::text))
        where evento_id = $1`,
      [ev.evento_id, uuidv7()],
    );
    await expect(reaplicar(ev.evento_id)).rejects.toMatchObject({ codigo: 'ESCOPO_INVALIDO' });
  });
});

describe('erros do PostgreSQL → códigos da SYNC 11.2 (T14)', () => {
  /** Tipo de teste que provoca a violação pedida numa tabela de negócio (`caixas`). */
  const violacoes: CatalogoHandlers = {
    ...HANDLERS,
    'teste.violacao': {
      1: {
        schema: z.object({ violar: z.enum(['fk', 'unico', 'check']) }),
        async aplicar({ c }, p: { violar: 'fk' | 'unico' | 'check' }) {
          if (p.violar === 'fk') {
            await c.query("insert into caixas (loja_id, numero, descricao) values ($1, 50, 'x')", [uuidv7()]);
          } else if (p.violar === 'unico') {
            await c.query("insert into caixas (id, loja_id, numero, descricao) values ($1, $2, 51, 'x')", [
              caixa1,
              loja1,
            ]);
          } else {
            await c.query("insert into caixas (loja_id, numero, descricao) values ($1, 150, 'x')", [loja1]);
          }
          return {};
        },
      },
    },
  };
  const terminal = () =>
    ({
      terminalId,
      lojaId: loja1,
      caixaId: caixa1,
      numeroCaixa: 1,
      ip: '127.0.0.1',
    }) as unknown as TerminalAutenticado;

  it('FK, unicidade e CHECK viram erro permanente na 1ª vez (sem erro_temporario); o dependente fica retido', async () => {
    const pushTeste = new PushSync(amb.servicos.tenancy, { handlers: violacoes });
    const fk = evento('teste.violacao', { violar: 'fk' }, { agregado_tipo: 'teste' });
    const unico = evento('teste.violacao', { violar: 'unico' });
    const check = evento('teste.violacao', { violar: 'check' });
    const dependente = evento(
      'auditoria.registros',
      { registros: [], logins: [] },
      { dependencias: [{ agregado_tipo: 'teste', agregado_id: fk.agregado_id }] },
    );
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote([fk, unico, check, dependente])));
    expect(r.resultados.map((x) => [x.status, x.erro?.codigo])).toEqual([
      ['rejeitado', 'REFERENCIA_INEXISTENTE'],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
      ['rejeitado', 'PAYLOAD_INVALIDO'],
      ['retido', 'DEPENDENCIA_PENDENTE'],
    ]);
    const linhas = await consultar<{
      status: string;
      erro_codigo: string;
      tentativas: number;
      restricao: string;
    }>(
      emp.nomeBanco,
      `select status, erro_codigo, tentativas, resultado #>> '{detalhes,restricao}' as restricao
         from eventos_recebidos where evento_id = any($1) order by sequencia_terminal`,
      [[fk.evento_id, unico.evento_id, check.evento_id, dependente.evento_id]],
    );
    expect(linhas).toEqual([
      {
        status: 'erro',
        erro_codigo: 'REFERENCIA_INEXISTENTE',
        tentativas: 1,
        restricao: 'fk_caixas_loja_id',
      },
      { status: 'erro', erro_codigo: 'AGREGADO_DIVERGENTE', tentativas: 1, restricao: 'pk_caixas' },
      { status: 'erro', erro_codigo: 'PAYLOAD_INVALIDO', tentativas: 1, restricao: 'ck_caixas_numero' },
      { status: 'retido', erro_codigo: 'DEPENDENCIA_PENDENTE', tentativas: 1, restricao: null },
    ]);
    const restantes = await consultar(emp.nomeBanco, 'select id from caixas where numero in (50, 51, 150)');
    expect(restantes).toEqual([]);
  });

  it('a violação pelo tx do Drizzle (DrizzleQueryError) é traduzida igual, sem o detail cru do PostgreSQL', async () => {
    const pelaOrm: CatalogoHandlers = {
      ...HANDLERS,
      'teste.violacao_orm': {
        1: {
          schema: z.object({ violar: z.enum(['fk', 'unico', 'check']) }),
          async aplicar({ tx }, p: { violar: 'fk' | 'unico' | 'check' }) {
            if (p.violar === 'fk') {
              await tx.insert(caixas).values({ lojaId: uuidv7(), numero: 60, descricao: 'x' });
            } else if (p.violar === 'unico') {
              await tx.insert(caixas).values({ id: caixa1, lojaId: loja1, numero: 61, descricao: 'x' });
            } else {
              await tx.insert(caixas).values({ lojaId: loja1, numero: 160, descricao: 'x' });
            }
            return {};
          },
        },
      },
    };
    const pushTeste = new PushSync(amb.servicos.tenancy, { handlers: pelaOrm });
    const evs = (['fk', 'unico', 'check'] as const).map((violar) => evento('teste.violacao_orm', { violar }));
    const r = await naEmpresa(() => pushTeste.receber(terminal(), lote(evs)));
    expect(r.resultados.map((x) => [x.status, x.erro?.codigo])).toEqual([
      ['rejeitado', 'REFERENCIA_INEXISTENTE'],
      ['rejeitado', 'AGREGADO_DIVERGENTE'],
      ['rejeitado', 'PAYLOAD_INVALIDO'],
    ]);
    const linhas = await consultar<{ tentativas: number; resultado: Record<string, unknown> }>(
      emp.nomeBanco,
      `select tentativas, resultado from eventos_recebidos where evento_id = any($1) order by sequencia_terminal`,
      [evs.map((e) => e.evento_id)],
    );
    expect(linhas).toEqual([
      {
        tentativas: 1,
        resultado: {
          detalhes: {
            sqlstate: '23503',
            restricao: 'fk_caixas_loja_id',
            tabela: 'caixas',
            colunas: ['loja_id'],
          },
        },
      },
      {
        tentativas: 1,
        resultado: {
          detalhes: { sqlstate: '23505', restricao: 'pk_caixas', tabela: 'caixas', colunas: ['id'] },
        },
      },
      {
        tentativas: 1,
        resultado: {
          detalhes: { sqlstate: '23514', restricao: 'ck_caixas_numero', tabela: 'caixas', colunas: null },
        },
      },
    ]);
    // O valor da chave (aqui o id do caixa) não vai para `resultado` (LGPD, D19).
    expect(JSON.stringify(linhas)).not.toContain(caixa1);
  });

  it('auditoria com data sem partição vira PAYLOAD_INVALIDO na 1ª vez (README 127; SYNC 11.2)', async () => {
    const antigo = '2001-01-15T12:00:00.000Z';
    const config = evento(
      'terminal.configuracao_alterada',
      {
        alteracoes: [{ chave: 'pdv.tema', valor_novo: 'claro' }],
        configuracao_completa: { 'pdv.tema': 'claro' },
      },
      { ocorrido_em: antigo, ocorrido_em_local: antigo },
    );
    const r1 = await push([config]);
    expect(r1.body.resultados[0]).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'PAYLOAD_INVALIDO' },
    });
    const registros = evento('auditoria.registros', {
      registros: [{ id: uuidv7(), ocorrido_em: antigo, acao: 'gaveta_aberta', entidade: 'pdv' }],
      logins: [],
    });
    const r2 = await push([registros]);
    expect(r2.body.resultados[0]).toMatchObject({
      status: 'rejeitado',
      erro: { codigo: 'PAYLOAD_INVALIDO' },
    });
    const linhas = await consultar(
      emp.nomeBanco,
      'select status, erro_codigo, tentativas from eventos_recebidos where evento_id = any($1) order by sequencia_terminal',
      [[config.evento_id, registros.evento_id]],
    );
    expect(linhas).toEqual([
      { status: 'erro', erro_codigo: 'PAYLOAD_INVALIDO', tentativas: 1 },
      { status: 'erro', erro_codigo: 'PAYLOAD_INVALIDO', tentativas: 1 },
    ]);
  });
});

describe('tempo com a trava 7300001 presa (crítica da 1C, item 6)', () => {
  it('cada evento aplicado pelo push entra no medidor', async () => {
    const medidor = amb.servicos.push.medidorTrava;
    const antes = medidor.resumo().total;
    const r = await push([
      evento('auditoria.registros', { registros: [], logins: [] }),
      evento('auditoria.registros', { registros: [], logins: [] }),
    ]);
    expect(r.body.resultados.map((x: { status: string }) => x.status)).toEqual(['aplicado', 'aplicado']);
    const resumo = medidor.resumo();
    expect(resumo.total).toBe(antes + 2);
    expect(resumo.p95).not.toBeNull();
    expect(resumo.p95!).toBeGreaterThanOrEqual(0);
  });
});
