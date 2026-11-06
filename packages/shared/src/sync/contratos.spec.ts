/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ehAcaoAuditoria, MOTIVOS_FALHA_LOGIN } from '../enums.js';
import { jcs } from '../jcs.js';
import {
  ativarSchema,
  envelopeErroSyncSchema,
  eventosStatusQuerySchema,
  eventoSchema,
  FLUXOS,
  heartbeatSchema,
  LIMITE_RECUPERAR_MAXIMO,
  MAXIMO_IDS_EVENTOS_STATUS,
  MAXIMO_SEQUENCIAS_LACUNA,
  payloadAuditoriaRegistrosSchema,
  pushSchema,
  recuperarQuerySchema,
  renovarTokenSchema,
  respostaAtivacaoSchema,
  respostaEstadoSchema,
  respostaEventosStatusSchema,
  respostaHeartbeatSchema,
  respostaPullSchema,
  respostaPushSchema,
  respostaRecuperarSchema,
  respostaRenovarTokenSchema,
} from './contratos.js';
import { chavesDescartadas, lerFixtureSync as ler, pastaFixturesSync as pasta } from './fixtures.teste.js';

/**
 * Suíte de contrato do sync (SYNC 17): as mesmas fixtures passam aqui pelo zod e, no PDV, pelos records C#
 * (`GenesisPDV.Sync.Tests/ContratosTests.cs`, ida e volta + `payload_sha256` recalculado).
 */

const SCHEMAS: Record<string, z.ZodType> = {
  'ativar.requisicao.json': ativarSchema,
  'ativar.resposta.json': respostaAtivacaoSchema,
  'estado.resposta.json': respostaEstadoSchema,
  'pull.catalogo.resposta.json': respostaPullSchema,
  'push.auditoria.requisicao.json': pushSchema,
  'push.auditoria.resposta.json': respostaPushSchema,
  'push.lacuna.requisicao.json': pushSchema,
  'push.recuperar_lacuna.requisicao.json': pushSchema,
  'push.lacuna.resposta.json': respostaPushSchema,
  'heartbeat.requisicao.json': heartbeatSchema,
  'heartbeat.resposta.json': respostaHeartbeatSchema,
  'eventos-status.resposta.json': respostaEventosStatusSchema,
  'recuperar.resposta.json': respostaRecuperarSchema,
  'token.renovar.requisicao.json': renovarTokenSchema,
  'token.renovar.resposta.json': respostaRenovarTokenSchema,
  'auditoria.registros.payload.json': payloadAuditoriaRegistrosSchema,
};

/**
 * Requisições passam por `z.object` tolerante (a API ignora campo desconhecido): sem esta conferência, uma chave com
 * nome errado na fixture (e no record C#, que concorda com ela) passaria nos dois lados e sumiria no envio real.
 */
const REQUISICOES = [
  'ativar.requisicao.json',
  'push.auditoria.requisicao.json',
  'push.lacuna.requisicao.json',
  'push.recuperar_lacuna.requisicao.json',
  'heartbeat.requisicao.json',
  'token.renovar.requisicao.json',
  'auditoria.registros.payload.json',
];

describe('fixtures do protocolo de sincronização', () => {
  it('toda fixture da pasta tem schema (nenhuma fica sem teste)', () => {
    // `erros.json` tem teste próprio abaixo; `argon2.vetores.json` é conferido pela API (senhas.spec) e pelo PDV; os
    // payloads de evento (`*.payload.json`) e `eventos.conferencias.json` ficam com `eventos.spec.ts`, salvo o payload
    // da auditoria, que é da Fase 0 e só passa por aqui; `caixa.apuracao.vetores.json` é do `vendas.spec.ts`, do
    // teste de integração das consultas (API) e do `ApuracaoVetoresTests` (PDV).
    const arquivos = readdirSync(pasta).filter(
      (f) => f.endsWith('.json') && (!f.endsWith('.payload.json') || f in SCHEMAS),
    );
    expect(arquivos.sort()).toEqual(
      [
        ...Object.keys(SCHEMAS),
        'erros.json',
        'argon2.vetores.json',
        'eventos.conferencias.json',
        'caixa.apuracao.vetores.json',
      ].sort(),
    );
  });

  it.each(Object.entries(SCHEMAS))('%s passa pelo schema', (nome, schema) => {
    const r = schema.safeParse(ler(nome));
    expect(r.error?.issues ?? []).toEqual([]);
  });

  it.each(REQUISICOES)('%s: nenhuma chave da fixture é descartada pelo schema', (nome) => {
    const fixture = ler(nome);
    const r = SCHEMAS[nome]!.parse(fixture);
    expect(chavesDescartadas(fixture, r)).toEqual([]);
    // Os eventos do push passam pelo envelope à parte (`eventos` é `unknown[]` no lote).
    if (nome.startsWith('push.')) {
      for (const ev of (fixture as { eventos: unknown[] }).eventos) {
        expect(chavesDescartadas(ev, eventoSchema.parse(ev))).toEqual([]);
      }
    }
  });

  it('push com lacuna (SYNC 8.6): só a declaração vai sem eventos; faixa válida; declarar e recuperar não vão juntos', () => {
    const declarar = pushSchema.parse(ler('push.lacuna.requisicao.json'));
    expect(declarar.eventos).toEqual([]);
    expect(declarar.declarar_lacuna).toMatchObject({ de: 1048, ate: 1049, motivo: 'banco_local_perdido' });
    const recuperar = pushSchema.parse(ler('push.recuperar_lacuna.requisicao.json'));
    // A recuperação é da faixa declarada na outra fixture, e os eventos são os que a resposta devolveu como
    // `lacuna_recuperavel` no envio anterior, sem a liberação (outro lote).
    expect(recuperar.recuperar_lacuna).toMatchObject({ de: 1048, ate: 1049 });
    const achados = recuperar.eventos.map((e) => eventoSchema.parse(e));
    expect(achados.map((e) => e.sequencia)).toEqual([1048, 1049]);
    const base = ler('push.lacuna.requisicao.json') as Record<string, unknown>;
    const faixa = base.declarar_lacuna as Record<string, unknown>;
    const { declarar_lacuna: _d, ...semDeclaracao } = base;
    expect(pushSchema.safeParse(semDeclaracao).success).toBe(false);
    expect(pushSchema.safeParse({ ...base, declarar_lacuna: { ...faixa, ate: 1047 } }).success).toBe(false);
    expect(
      pushSchema.safeParse({
        ...base,
        declarar_lacuna: { ...faixa, ate: 1048 + MAXIMO_SEQUENCIAS_LACUNA },
      }).success,
    ).toBe(false);
    expect(pushSchema.safeParse({ ...base, declarar_lacuna: { ...faixa, motivo: 'qualquer' } }).success).toBe(
      false,
    );
    expect(pushSchema.safeParse({ ...base, recuperar_lacuna: recuperar.recuperar_lacuna }).success).toBe(
      false,
    );
    const resposta = respostaPushSchema.parse(ler('push.lacuna.resposta.json'));
    expect(resposta.resultados.map((r) => r.status)).toEqual(['lacuna_recuperavel', 'nao_processado']);
    expect(resposta.resultados[0]!.resultado).toEqual({ lacuna: { de: 1048, ate: 1049 } });
    expect(resposta.lote_id).not.toBe(recuperar.lote_id);
    expect(resposta.resultados.map((r) => [r.evento_id, r.sequencia])).toEqual(
      achados.map((e) => [e.evento_id, e.sequencia]),
    );
  });

  it('chave com nome errado numa requisição é apontada (o zod só a descartaria)', () => {
    const hb = ler('heartbeat.requisicao.json') as Record<string, unknown>;
    const errado = { ...hb, nfce_contingencia_mais_antiga: hb.nfce_contingencia_mais_antiga_em };
    expect(heartbeatSchema.safeParse(errado).success).toBe(true);
    expect(chavesDescartadas(errado, heartbeatSchema.parse(errado))).toEqual([
      'nfce_contingencia_mais_antiga',
    ]);
  });

  it('ativar: o código é normalizado (sem hífen, maiúsculo) e a resposta lista os fluxos na ordem da carga', () => {
    expect(ativarSchema.parse(ler('ativar.requisicao.json')).codigo_ativacao).toBe('K7QM2XRD');
    expect(respostaAtivacaoSchema.parse(ler('ativar.resposta.json')).fluxos).toEqual([...FLUXOS]);
  });

  it('push: cada evento passa pelo envelope e o payload_sha256 é o SHA-256 do JCS do payload', () => {
    const lote = pushSchema.parse(ler('push.auditoria.requisicao.json'));
    expect(lote.eventos.length).toBeGreaterThan(0);
    for (const bruto of lote.eventos) {
      const ev = eventoSchema.parse(bruto);
      expect(ev.terminal_id).toBe(lote.terminal_id);
      expect(createHash('sha256').update(jcs(ev.payload), 'utf8').digest('hex')).toBe(ev.payload_sha256);
    }
  });

  it('pull: a página traz um tombstone (excluido_em preenchido) e decimais em texto', () => {
    const pagina = respostaPullSchema.parse(ler('pull.catalogo.resposta.json'));
    expect(pagina.alteracoes.some((a) => typeof a.linha.excluido_em === 'string')).toBe(true);
    const produto = pagina.alteracoes.find((a) => a.tabela === 'produtos')!.linha;
    expect(produto.preco_venda).toBe('4.9900');
    expect(produto).not.toHaveProperty('preco_custo');
    // Página não cortada termina no teto (SYNC 6.4): é o que deixa a carga inicial acabar.
    expect(pagina.tem_mais).toBe(false);
    expect(pagina.novo_cursor).toBe(pagina.cursor_teto);
  });

  it('erros: todo caso usa o envelope { erro: { codigo, mensagem, detalhes, requisicao_id } }', () => {
    const { casos } = ler('erros.json') as {
      casos: Array<{
        descricao: string;
        status: number;
        corpo: unknown;
        cabecalhos?: Record<string, string>;
      }>;
    };
    expect(casos.length).toBeGreaterThan(0);
    for (const c of casos) {
      const r = envelopeErroSyncSchema.safeParse(c.corpo);
      expect({ caso: c.descricao, issues: r.error?.issues ?? [] }).toEqual({ caso: c.descricao, issues: [] });
      expect(c.status).toBeGreaterThanOrEqual(400);
      // Só os cabeçalhos que o cliente lê (o PDV expõe o Retry-After no `ErroSyncException.RepetirApos`).
      for (const [nome, valor] of Object.entries(c.cabecalhos ?? {})) {
        expect(nome).toBe('Retry-After');
        expect(valor).toMatch(/^\d+$/);
      }
    }
    expect(casos.some((c) => c.cabecalhos?.['Retry-After'])).toBe(true);
  });

  it('auditoria.registros: o que o PDV grava (login offline, ativação) está no catálogo da API', () => {
    // Ação fora de ACOES_AUDITORIA recusa o evento inteiro (PAYLOAD_INVALIDO) e leva junto o lote do caixa.
    const p = payloadAuditoriaRegistrosSchema.parse(ler('auditoria.registros.payload.json'));
    expect(p.registros.filter((r) => !ehAcaoAuditoria(r.acao)).map((r) => r.acao)).toEqual([]);
    expect(p.registros.map((r) => r.acao)).toContain('hash_fora_dos_limites');
    // As recusas próprias do caixa (PDV 7.2) também valem em `historico_logins` (check da migração 0009).
    const motivos = p.logins.map((l) => l.motivo_falha).filter((m) => m != null);
    expect(motivos).toEqual(expect.arrayContaining(['sem_acesso_pdv', 'totem', 'hash_fora_dos_limites']));
    expect(motivos.every((m) => (MOTIVOS_FALHA_LOGIN as readonly string[]).includes(m))).toBe(true);
    const comAcaoForaDoCatalogo = { registros: [{ ...p.registros[0], acao: 'acao_inventada' }] };
    expect(
      ehAcaoAuditoria(payloadAuditoriaRegistrosSchema.parse(comAcaoForaDoCatalogo).registros[0]!.acao),
    ).toBe(false);
    const motivoInventado = { logins: [{ ...p.logins[0], motivo_falha: 'motivo_inventado' }] };
    expect(payloadAuditoriaRegistrosSchema.safeParse(motivoInventado).success).toBe(false);
  });

  it('eventos-status: ids por vírgula ou repetidos, sem repetição, de 1 a 200; erro e retido trazem o erro', () => {
    const a = '01a18771-4e5f-7061-8273-8d9e0f1a2b3c';
    const b = '01a18772-5f60-7172-9384-9e0f1a2b3c4d';
    expect(eventosStatusQuerySchema.parse({ ids: `${a}, ${b.toUpperCase()},${a}` }).ids).toEqual([a, b]);
    expect(eventosStatusQuerySchema.parse({ ids: [a, `${b},${a}`] }).ids).toEqual([a, b]);
    expect(eventosStatusQuerySchema.safeParse({}).success).toBe(false);
    expect(eventosStatusQuerySchema.safeParse({ ids: '' }).success).toBe(false);
    expect(eventosStatusQuerySchema.safeParse({ ids: `${a},nao-e-uuid` }).success).toBe(false);
    const muitos = Array.from(
      { length: MAXIMO_IDS_EVENTOS_STATUS + 1 },
      (_, i) => `01a18771-4e5f-7061-8273-${String(i).padStart(12, '0')}`,
    );
    expect(eventosStatusQuerySchema.safeParse({ ids: muitos.slice(0, -1).join(',') }).success).toBe(true);
    expect(eventosStatusQuerySchema.safeParse({ ids: muitos.join(',') }).success).toBe(false);
    const r = respostaEventosStatusSchema.parse(ler('eventos-status.resposta.json'));
    expect(r.eventos.map((e) => e.status)).toEqual(['aplicado', 'descartado', 'erro', 'retido']);
    expect(r.eventos.filter((e) => e.erro).map((e) => e.status)).toEqual(['erro', 'retido']);
  });

  it('recuperar: desde_sequencia obrigatório, limite de 1 a 200 (padrão 50); placeholder marcado e payload anulado nulo', () => {
    expect(recuperarQuerySchema.parse({ desde_sequencia: '1020' })).toEqual({
      desde_sequencia: 1020,
      limite: 50,
    });
    expect(recuperarQuerySchema.parse({ desde_sequencia: '0', limite: '200' }).limite).toBe(
      LIMITE_RECUPERAR_MAXIMO,
    );
    expect(recuperarQuerySchema.safeParse({}).success).toBe(false);
    expect(recuperarQuerySchema.safeParse({ desde_sequencia: '-1' }).success).toBe(false);
    expect(recuperarQuerySchema.safeParse({ desde_sequencia: '1', limite: '201' }).success).toBe(false);
    expect(recuperarQuerySchema.safeParse({ desde_sequencia: '1', limite: '0' }).success).toBe(false);
    const r = respostaRecuperarSchema.parse(ler('recuperar.resposta.json'));
    expect(r.eventos.map((e) => e.envelope.sequencia)).toEqual([1021, 1022, 1023, 1024]);
    expect(r.eventos.filter((e) => e.lacuna).map((e) => e.envelope.tipo)).toEqual(['terminal.lacuna']);
    expect(r.eventos.filter((e) => e.envelope.payload === null).map((e) => e.status)).toEqual(['descartado']);
    expect(r.eventos.filter((e) => e.erro).map((e) => e.status)).toEqual(['erro']);
    for (const { envelope } of r.eventos.filter((e) => e.envelope.payload !== null)) {
      expect(createHash('sha256').update(jcs(envelope.payload), 'utf8').digest('hex')).toBe(
        envelope.payload_sha256,
      );
    }
    const item = (ler('recuperar.resposta.json') as { eventos: Array<Record<string, unknown>> }).eventos[0]!;
    expect(
      respostaRecuperarSchema.safeParse({
        ...r,
        eventos: [{ ...item, envelope: { ...(item.envelope as object), x: 1 } }],
      }).success,
    ).toBe(false);
  });

  it('respostas são estritas: campo novo na API sem fixture/record C# quebra o contrato', () => {
    const estado = ler('estado.resposta.json') as Record<string, unknown>;
    expect(respostaEstadoSchema.safeParse({ ...estado, campo_novo: 1 }).success).toBe(false);
    const hb = ler('heartbeat.resposta.json') as Record<string, unknown>;
    expect(respostaHeartbeatSchema.safeParse({ ...hb, intervalos: { heartbeat_s: 30 } }).success).toBe(false);
  });
});
