/**
 * Ativação do terminal (SYNC 3.3–3.4): a repetição da mesma ativação só devolve a resposta para a mesma requisição da
 * mesma máquina (mesmos ids e as mesmas chaves públicas) e só enquanto o token entregue não foi usado; cada reemissão
 * fica na auditoria da plataforma. O caixa do código precisa continuar vivo e ativo no resgate: excluir ou inativar o
 * caixa (ou excluir a loja) cancela os códigos pendentes dele, e a ativação confere o caixa de novo.
 */
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { envelopeErroSyncSchema, respostaAtivacaoSchema, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessaoErp } from '../../src/auth/auth.service.js';
import type { RequisicaoGenesis } from '../../src/comum/requisicao.js';
import { decifrarDoTerminal } from '../../src/seguranca/ecies.js';
import { caixaAceitaTerminal } from '../../src/sync/ativacao.js';
import { cancelarCodigosPendentes } from '../../src/terminais/codigos-pendentes.js';
import { consultar, criarAmbiente, criarLoja, type Ambiente, type EmpresaTeste } from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;
const HARDWARE = ATIVAR.maquina.id_hardware;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja: string;
let tokenAdmin: string;
let proximoCaixa = 1;

function cabecalhos(token?: string) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': HARDWARE,
  };
}

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

async function novoCaixa(lojaId = loja): Promise<string> {
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [lojaId, proximoCaixa, `Caixa ${proximoCaixa}`],
  );
  proximoCaixa++;
  return c!.id;
}

async function gerarCodigo(caixaId: string, lojaId = loja): Promise<{ codigo: string; ativacaoId: string }> {
  const r = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ lojaId, caixaId, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(r.status).toBe(201);
  return { codigo: r.body.codigo as string, ativacaoId: r.body.ativacaoId as string };
}

type Par = { publicKey: KeyObject; privateKey: KeyObject };

/** Corpo da fixture com as chaves da tentativa (o PDV repete com o mesmo par de chaves e o mesmo id). */
function corpo(codigo: string, chaves: { terminal: Par; backup: Par }, requisicao: string) {
  return {
    ...ATIVAR,
    codigo_empresa: emp.codigo,
    codigo_ativacao: codigo,
    requisicao_ativacao_id: requisicao,
    chave_backup_publica: spki(chaves.backup.publicKey),
    chave_publica_terminal: { algoritmo: 'x25519', chave: spki(chaves.terminal.publicKey) },
  };
}

const novasChaves = () => ({
  terminal: generateKeyPairSync('x25519'),
  backup: generateKeyPairSync('x25519'),
});

const ativar = (c: object) => amb.http().post('/sync/ativar').set(cabecalhos()).send(c);
const estado = (token: string) => amb.http().get('/sync/estado').set(cabecalhos(token));

async function contarPlataforma(acao: string, terminalId: string): Promise<number> {
  const [r] = await consultar<{ n: number }>(
    amb.bancoControle,
    'select count(*)::int as n from auditoria_plataforma where acao = $1 and registro_id = $2',
    [acao, terminalId],
  );
  return r!.n;
}

async function statusCodigo(ativacaoId: string): Promise<string> {
  const [r] = await consultar<{ status: string }>(
    amb.bancoControle,
    'select status from ativacoes_pdv where id = $1',
    [ativacaoId],
  );
  return r!.status;
}

async function statusTerminal(terminalId: string): Promise<{ status: string; motivo: string | null }> {
  const [r] = await consultar<{ status: string; motivo: string | null }>(
    amb.bancoControle,
    'select status, motivo_revogacao as motivo from terminais_pdv where id = $1',
    [terminalId],
  );
  return r!;
}

async function auditoriasCancelar(ativacaoId: string): Promise<number> {
  const [r] = await consultar<{ n: number }>(
    emp.nomeBanco,
    "select count(*)::int as n from auditoria where acao = 'cancelar' and entidade = 'ativacoes_pdv' and registro_id = $1",
    [ativacaoId],
  );
  return r!.n;
}

/** `etapaEmpresa` é privada: o espião troca a próxima chamada (corridas que o HTTP sozinho não produz). */
type EtapaEspiavel = { etapaEmpresa: (...args: unknown[]) => Promise<unknown> };
function espiarEtapa(
  fazer: (original: (...args: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>,
) {
  const servico = amb.servicos.ativacao as unknown as EtapaEspiavel;
  const original = servico.etapaEmpresa.bind(servico);
  return vi.spyOn(servico, 'etapaEmpresa').mockImplementationOnce((...args) => fazer(original, args));
}

async function terminaisDoCaixa(caixaId: string): Promise<number> {
  const [r] = await consultar<{ n: number }>(
    amb.bancoControle,
    "select count(*)::int as n from terminais_pdv where caixa_id = $1 and status in ('provisionando','ativo')",
    [caixaId],
  );
  return r!.n;
}

/** Ativação legítima: devolve o necessário para repetir (mesmo id, mesmas chaves). */
async function ativarCaixa(caixaId: string) {
  const { codigo, ativacaoId } = await gerarCodigo(caixaId);
  const chaves = novasChaves();
  const requisicao = uuidv7();
  const r = await ativar(corpo(codigo, chaves, requisicao));
  expect(r.status).toBe(201);
  respostaAtivacaoSchema.parse(r.body);
  return {
    codigo,
    ativacaoId,
    chaves,
    requisicao,
    terminalId: r.body.terminal_id as string,
    token: r.body.token as string,
  };
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
});

// As recusas de cada caso não podem somar para o bloqueio por IP (5 em 10 min, SYNC 3.1) dos casos seguintes.
beforeEach(async () => {
  await consultar(amb.bancoControle, 'delete from tentativas_ativacao');
});

afterAll(async () => {
  await amb?.fechar();
});

describe('repetição da ativação (SYNC 3.4)', () => {
  it('a repetição legítima (mesmo id, mesma máquina, mesmas chaves) devolve token novo e fica auditada', async () => {
    const a = await ativarCaixa(await novoCaixa());
    const r = await ativar(corpo(a.codigo, a.chaves, a.requisicao));
    expect(r.status).toBe(201);
    expect(r.body.terminal_id).toBe(a.terminalId);
    expect(r.body.token).not.toBe(a.token);
    // A chave de backup abre com a chave de backup da própria tentativa.
    expect(() =>
      decifrarDoTerminal(Buffer.from(r.body.chave_backup_cifrada, 'base64'), a.chaves.backup.privateKey),
    ).not.toThrow();
    expect((await estado(r.body.token)).status).toBe(200);
    expect((await estado(a.token)).status).toBe(401);
    expect(await contarPlataforma('terminal_ativacao_repetida', a.terminalId)).toBe(1);
  });

  it('chave pública do terminal diferente: recusa, e o token entregue continua valendo', async () => {
    const a = await ativarCaixa(await novoCaixa());
    const outras = novasChaves();
    const r = await ativar(
      corpo(a.codigo, { terminal: outras.terminal, backup: a.chaves.backup }, a.requisicao),
    );
    expect(r.status).toBe(422);
    envelopeErroSyncSchema.parse(r.body);
    expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    expect((await estado(a.token)).status).toBe(200);
    expect(await contarPlataforma('terminal_ativacao_repetida', a.terminalId)).toBe(0);
  });

  it('chave pública de backup diferente: recusa, e o token entregue continua valendo', async () => {
    const a = await ativarCaixa(await novoCaixa());
    const outras = novasChaves();
    const r = await ativar(
      corpo(a.codigo, { terminal: a.chaves.terminal, backup: outras.backup }, a.requisicao),
    );
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    expect((await estado(a.token)).status).toBe(200);
  });

  it('depois que o token entregue já autenticou, a repetição é recusada (CODIGO_USADO)', async () => {
    const a = await ativarCaixa(await novoCaixa());
    expect((await estado(a.token)).status).toBe(200);
    const [t] = await consultar<{ usado: Date | null }>(
      amb.bancoControle,
      'select token_atual_usado_em as usado from terminais_pdv where id = $1',
      [a.terminalId],
    );
    expect(t!.usado).not.toBeNull();
    const r = await ativar(corpo(a.codigo, a.chaves, a.requisicao));
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CODIGO_USADO');
    expect((await estado(a.token)).status).toBe(200);
    expect(await contarPlataforma('terminal_ativacao_repetida', a.terminalId)).toBe(0);
  });

  it('depois da renovação do token, a repetição é recusada (CODIGO_USADO) mesmo com o token novo sem uso', async () => {
    const a = await ativarCaixa(await novoCaixa());
    const segredo = randomBytes(32).toString('base64url');
    const renovacao = await amb
      .http()
      .post('/sync/token/renovar')
      .set(cabecalhos(a.token))
      .send({ novo_token_hash: createHash('sha256').update(segredo).digest('hex'), requisicao_id: uuidv7() });
    expect(renovacao.status, JSON.stringify(renovacao.body)).toBe(200);
    // A renovação zera o uso do token novo: só o `token_hash_anterior` barra a repetição.
    const [t] = await consultar<{ usado: Date | null; anterior: string | null }>(
      amb.bancoControle,
      'select token_atual_usado_em as usado, token_hash_anterior as anterior from terminais_pdv where id = $1',
      [a.terminalId],
    );
    expect(t!.usado).toBeNull();
    expect(t!.anterior).not.toBeNull();
    const r = await ativar(corpo(a.codigo, a.chaves, a.requisicao));
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CODIGO_USADO');
    expect(await contarPlataforma('terminal_ativacao_repetida', a.terminalId)).toBe(0);
    expect((await estado(`${a.terminalId}.${segredo}`)).status).toBe(200);
  });
});

describe('ciclo de vida do caixa no resgate do código (SYNC 3.3)', () => {
  it('excluir o caixa cancela o código pendente; o resgate é recusado e o caixa fica sem terminal', async () => {
    const caixa = await novoCaixa();
    const { codigo, ativacaoId } = await gerarCodigo(caixa);
    const del = await amb
      .http()
      .delete(`/api/lojas/${loja}/caixas/${caixa}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    expect(del.status).toBe(204);
    expect(await statusCodigo(ativacaoId)).toBe('cancelado');
    expect(await auditoriasCancelar(ativacaoId)).toBe(1);
    const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    expect(await terminaisDoCaixa(caixa)).toBe(0);
  });

  it('inativar o caixa cancela o código pendente; código novo para caixa inativo é recusado', async () => {
    const caixa = await novoCaixa();
    const { codigo, ativacaoId } = await gerarCodigo(caixa);
    const [c] = await consultar<{ versao: number }>(
      emp.nomeBanco,
      'select versao from caixas where id = $1',
      [caixa],
    );
    const put = await amb
      .http()
      .put(`/api/lojas/${loja}/caixas/${caixa}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ descricao: 'Caixa parado', ativo: false, versao: Number(c!.versao) });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await statusCodigo(ativacaoId)).toBe('cancelado');
    const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    expect(await terminaisDoCaixa(caixa)).toBe(0);
    const novo = await amb
      .http()
      .post('/api/terminais/ativacoes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ lojaId: loja, caixaId: caixa, validadeHoras: 1 });
    expect(novo.status).toBe(422);
  });

  it('código ainda pendente de caixa excluído ou inativo (sem o cancelamento): o resgate confere o caixa', async () => {
    for (const mudanca of ['excluido_em = now()', 'ativo = false']) {
      const caixa = await novoCaixa();
      const { codigo, ativacaoId } = await gerarCodigo(caixa);
      await consultar(emp.nomeBanco, `update caixas set ${mudanca} where id = $1`, [caixa]);
      const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
      expect(r.status).toBe(422);
      expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
      expect(await terminaisDoCaixa(caixa)).toBe(0);
      const [cx] = await consultar<{ terminal_id: string | null }>(
        emp.nomeBanco,
        'select terminal_id from caixas where id = $1',
        [caixa],
      );
      expect(cx!.terminal_id).toBeNull();
      // Quem tem o código não conta como tentativa errada (não alimenta o bloqueio por força bruta).
      const [f] = await consultar<{ motivo: string | null }>(
        amb.bancoControle,
        'select motivo_falha as motivo from tentativas_ativacao where codigo_empresa = $1 order by criado_em desc limit 1',
        [emp.codigo],
      );
      expect(f!.motivo).toBeNull();
      expect(await statusCodigo(ativacaoId)).toBe('pendente');
    }
  });

  it('a repetição depois de inativar o caixa é recusada antes da troca do segredo: o token entregue continua', async () => {
    const caixa = await novoCaixa();
    const a = await ativarCaixa(caixa);
    await consultar(emp.nomeBanco, 'update caixas set ativo = false where id = $1', [caixa]);
    const r = await ativar(corpo(a.codigo, a.chaves, a.requisicao));
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    // Nada foi reemitido: sem `terminal_ativacao_repetida`, o terminal segue `ativo` e o token entregue vale.
    expect(await contarPlataforma('terminal_ativacao_repetida', a.terminalId)).toBe(0);
    expect(await statusTerminal(a.terminalId)).toEqual({ status: 'ativo', motivo: null });
    expect((await estado(a.token)).status).toBe(200);
  });

  it('etapa da empresa já gravada e o controle ainda provisionando: a recusa da repetição não compensa', async () => {
    const caixa = await novoCaixa();
    const a = await ativarCaixa(caixa);
    // A API caiu entre a etapa da empresa e o 3º commit; depois o caixa foi inativado no ERP.
    await consultar(amb.bancoControle, "update terminais_pdv set status = 'provisionando' where id = $1", [
      a.terminalId,
    ]);
    await consultar(emp.nomeBanco, 'update caixas set ativo = false where id = $1', [caixa]);
    const r = await ativar(corpo(a.codigo, a.chaves, a.requisicao));
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    expect(await statusTerminal(a.terminalId)).toEqual({ status: 'provisionando', motivo: null });
    expect(await statusCodigo(a.ativacaoId)).toBe('usado');
    expect(await contarPlataforma('terminal_ativacao_repetida', a.terminalId)).toBe(0);
    // A manutenção conclui (a etapa está feita no banco da empresa): os dois bancos convergem.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set ativado_em = now() - interval '25 minutes' where id = $1",
      [a.terminalId],
    );
    await amb.servicos.manutencaoTerminais.executar();
    expect(await statusTerminal(a.terminalId)).toEqual({ status: 'ativo', motivo: null });
    const [cx] = await consultar<{ terminal_id: string | null }>(
      emp.nomeBanco,
      'select terminal_id from caixas where id = $1',
      [caixa],
    );
    expect(cx!.terminal_id).toBe(a.terminalId);
  });

  it('a etapa da empresa repetida é idempotente antes da conferência do caixa', async () => {
    const caixa = await novoCaixa();
    const { codigo } = await gerarCodigo(caixa);
    // A etapa commita; o caixa é inativado; a mesma etapa roda de novo (a repetição que passou pela conferência
    // antes da inativação): devolve a decisão gravada em vez de recusar e levar `concluir` a compensar.
    const espiao = espiarEtapa(async (original, args) => {
      const primeira = await original(...args);
      await consultar(emp.nomeBanco, 'update caixas set ativo = false where id = $1', [caixa]);
      const segunda = await original(...args);
      expect(segunda).toMatchObject({ numeracoes: (primeira as { numeracoes: unknown }).numeracoes });
      return segunda;
    });
    try {
      const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await statusTerminal(r.body.terminal_id)).toEqual({ status: 'ativo', motivo: null });
    } finally {
      espiao.mockRestore();
    }
  });

  it('caixa inativado entre o passo 5 e a etapa da empresa: compensa e o código fica cancelado', async () => {
    const caixa = await novoCaixa();
    const { codigo, ativacaoId } = await gerarCodigo(caixa);
    const espiao = espiarEtapa(async (original, args) => {
      await consultar(emp.nomeBanco, 'update caixas set ativo = false where id = $1', [caixa]);
      return original(...args);
    });
    try {
      const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
      expect(r.status).toBe(422);
      expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
      expect(r.body.erro.mensagem).toContain('caixa foi excluído ou inativado');
    } finally {
      espiao.mockRestore();
    }
    const [t] = await consultar<{ id: string }>(
      amb.bancoControle,
      'select id from terminais_pdv where caixa_id = $1',
      [caixa],
    );
    expect(await statusTerminal(t!.id)).toEqual({ status: 'revogado', motivo: 'falha_ativacao' });
    expect(await statusCodigo(ativacaoId)).toBe('cancelado');
    expect(await terminaisDoCaixa(caixa)).toBe(0);
  });

  it('loja inativada entre o passo 5 e a etapa da empresa: LOJA_INATIVA e o código continua valendo', async () => {
    const outraLoja = await criarLoja(emp.nomeBanco, 3, 'Loja 3 - Feira');
    const caixa = await novoCaixa(outraLoja);
    const { codigo, ativacaoId } = await gerarCodigo(caixa, outraLoja);
    const espiao = espiarEtapa(async (original, args) => {
      await consultar(emp.nomeBanco, 'update lojas set ativa = false where id = $1', [outraLoja]);
      return original(...args);
    });
    try {
      const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
      expect(r.status).toBe(403);
      expect(r.body.erro.codigo).toBe('LOJA_INATIVA');
    } finally {
      espiao.mockRestore();
    }
    expect(await statusCodigo(ativacaoId)).toBe('pendente');
    expect(await terminaisDoCaixa(caixa)).toBe(0);
    // Reativada a loja, o mesmo código ativa.
    await consultar(emp.nomeBanco, 'update lojas set ativa = true where id = $1', [outraLoja]);
    const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('provisionando esquecido com o caixa inativado depois do 1º commit: a manutenção compensa e cancela o código', async () => {
    const caixa = await novoCaixa();
    const { codigo, ativacaoId } = await gerarCodigo(caixa);
    // A etapa da empresa falha e a compensação dentro de `concluir` também (como a API caindo entre os dois).
    const etapa = espiarEtapa(async () => {
      throw new Error('queda simulada antes da etapa da empresa');
    });
    const compensar = vi
      .spyOn(amb.servicos.ativacao, 'compensar')
      .mockRejectedValueOnce(new Error('queda simulada da compensação'));
    try {
      const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
      expect(r.status).toBe(503);
    } finally {
      etapa.mockRestore();
      compensar.mockRestore();
    }
    expect(await statusCodigo(ativacaoId)).toBe('usado');
    // O caixa é inativado pelo ERP enquanto o código está `usado`: o cancelamento do ERP não o alcança.
    const [c] = await consultar<{ versao: number }>(
      emp.nomeBanco,
      'select versao from caixas where id = $1',
      [caixa],
    );
    const put = await amb
      .http()
      .put(`/api/lojas/${loja}/caixas/${caixa}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ descricao: 'Caixa parado', ativo: false, versao: Number(c!.versao) });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await statusCodigo(ativacaoId)).toBe('usado');
    const [t] = await consultar<{ id: string }>(
      amb.bancoControle,
      "update terminais_pdv set ativado_em = now() - interval '25 minutes' where caixa_id = $1 returning id",
      [caixa],
    );
    await amb.servicos.manutencaoTerminais.executar();
    expect(await statusTerminal(t!.id)).toEqual({ status: 'revogado', motivo: 'falha_ativacao' });
    expect(await statusCodigo(ativacaoId)).toBe('cancelado');
  });

  it('transação da empresa repetida (deadlock) depois do cancelamento: o código cancelado fica auditado', async () => {
    const caixa = await novoCaixa();
    const { ativacaoId } = await gerarCodigo(caixa);
    const empresa = (await amb.servicos.resolvedor.porCodigo(emp.codigo))!;
    const [admin] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'admin'",
    );
    const sessao = { usuarioId: admin!.id, empresa: { empresaId: empresa.id } } as unknown as SessaoErp;
    const req = { headers: {}, ip: '127.0.0.1', sessao } as unknown as RequisicaoGenesis;
    let tentativas = 0;
    const n = await amb.servicos.tenancy.executarNaEmpresa(amb.servicos.resolvedor.contexto(empresa), () =>
      amb.servicos.tenancy.cx().transacao(async (tx) => {
        const r = await cancelarCodigosPendentes(
          amb.servicos,
          tx,
          sessao,
          req,
          { lojaId: loja, caixaId: caixa },
          'caixa inativado',
        );
        if (++tentativas === 1) throw Object.assign(new Error('deadlock simulado'), { code: '40P01' });
        return r;
      }),
    );
    expect(tentativas).toBe(2);
    expect(n).toBe(1);
    expect(await statusCodigo(ativacaoId)).toBe('cancelado');
    expect(await auditoriasCancelar(ativacaoId)).toBe(1);
  });

  it('excluir a loja cancela os códigos pendentes dos caixas dela', async () => {
    const outraLoja = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
    const caixa = await novoCaixa(outraLoja);
    const { codigo, ativacaoId } = await gerarCodigo(caixa, outraLoja);
    const del = await amb
      .http()
      .delete(`/api/lojas/${outraLoja}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    expect(del.status).toBe(204);
    expect(await statusCodigo(ativacaoId)).toBe('cancelado');
    const r = await ativar(corpo(codigo, novasChaves(), uuidv7()));
    expect(r.status).toBe(422);
    expect(await terminaisDoCaixa(caixa)).toBe(0);
  });

  it('regra do caixa que aceita terminal', () => {
    const base = { lojaId: 'L', excluidoEm: null, ativo: true, sistema: false, numero: 1 };
    expect(caixaAceitaTerminal(base, 'L')).toBe(true);
    expect(caixaAceitaTerminal(undefined, 'L')).toBe(false);
    expect(caixaAceitaTerminal(base, 'M')).toBe(false);
    expect(caixaAceitaTerminal({ ...base, excluidoEm: new Date() }, 'L')).toBe(false);
    expect(caixaAceitaTerminal({ ...base, ativo: false }, 'L')).toBe(false);
    expect(caixaAceitaTerminal({ ...base, sistema: true, numero: 0 }, 'L')).toBe(false);
  });
});
