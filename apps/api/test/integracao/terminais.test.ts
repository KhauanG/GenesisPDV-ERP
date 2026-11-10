/**
 * PDVs/Terminais no ERP (ERP 12; SYNC 3.1, 3.8, 4.3 item 6, 21.1): listagem por lojas permitidas, permissões,
 * códigos pendentes e cancelamento, revogação nos três modos vista pelo próprio terminal (401 no pull, `revogar` no
 * heartbeat, PIN que desce nulo), manutenção periódica (carência, código vencido, `provisionando` esquecido,
 * reconciliação do banco da empresa), "Liberar ativações", comandos, o alerta da D20 e o de token anterior reutilizado
 * (listado e resolvido na tela).
 */
import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ALERTA_TOKEN_ANTERIOR_REUTILIZADO,
  jcs,
  VERSAO_PDV_GUARDA_VARIACOES,
  type Ativar,
  type ListagemEventosComErro,
  type ListagemTerminais,
  type RespostaTerminaisSemGuardaVariacoes,
  type TerminalDetalhe,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;
const HARDWARE = ATIVAR.maquina.id_hardware;
const PIN = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';

let amb: Ambiente;
let emp: EmpresaTeste;
let loja1: string;
let loja2: string;
let tokenAdmin: string;
let tokenGerente: string;
const caixas: Record<string, string> = {};

function cabecalhos(token?: string, hardware = HARDWARE) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': hardware,
  };
}

const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function corpoAtivacao(codigo: string) {
  return {
    ...ATIVAR,
    codigo_empresa: emp.codigo,
    codigo_ativacao: codigo,
    requisicao_ativacao_id: uuidv7(),
    chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
    chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
  };
}

const erp = (token = tokenAdmin) => ({
  get: (url: string) => amb.http().get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, corpo: object = {}) =>
    amb.http().post(url).set('Authorization', `Bearer ${token}`).send(corpo),
  patch: (url: string, corpo: object) =>
    amb.http().patch(url).set('Authorization', `Bearer ${token}`).send(corpo),
  del: (url: string) => amb.http().delete(url).set('Authorization', `Bearer ${token}`),
});

async function gerarCodigo(lojaId: string, caixaId: string, extra: Record<string, unknown> = {}) {
  const r = await erp().post('/api/terminais/ativacoes', { lojaId, caixaId, validadeHoras: 24, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { codigo: string; ativacaoId: string };
}

/** Gera o código no ERP e ativa pelo `/sync/ativar`: devolve id e token do terminal. */
async function ativar(lojaId: string, caixaId: string, extra: Record<string, unknown> = {}) {
  const { codigo } = await gerarCodigo(lojaId, caixaId, extra);
  const r = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao(codigo));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.terminal_id as string, token: r.body.token as string };
}

const heartbeat = (token: string, corpo: Record<string, unknown> = {}, hardware = HARDWARE) =>
  amb.http().post('/sync/heartbeat').set(cabecalhos(token, hardware)).send(corpo);

async function criarCaixa(lojaId: string, numero: number): Promise<string> {
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [lojaId, numero, `Caixa ${String(numero).padStart(2, '0')}`],
  );
  return c!.id;
}

const statusNosBancos = async (id: string) => {
  const [c] = await consultar<{ status: string; motivo: string | null }>(
    amb.bancoControle,
    'select status, motivo_revogacao as motivo from terminais_pdv where id = $1',
    [id],
  );
  const [e] = await consultar<{ status: string }>(
    emp.nomeBanco,
    'select status from terminais where id = $1',
    [id],
  );
  return { controle: c?.status, motivo: c?.motivo ?? null, empresa: e?.status };
};

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  for (const n of [1, 2, 3, 4, 5, 6]) caixas[`l1c${n}`] = await criarCaixa(loja1, n);
  caixas.l2c1 = await criarCaixa(loja2, 1);
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'gerente_l1', perfil: 'gerente', lojas: [loja1] });
  tokenGerente = await amb.entrar(emp.codigo, 'gerente_l1', SENHA_TESTE);
});

afterAll(async () => {
  await amb?.fechar();
});

let t1: { id: string; token: string };
let t2: { id: string; token: string };

describe('listagem e detalhe (ERP 12.2, 12.4)', () => {
  it('só as lojas permitidas; contadores por conexão; filtros de conexão e situação', async () => {
    t1 = await ativar(loja1, caixas.l1c1!);
    t2 = await ativar(loja2, caixas.l2c1!);
    expect((await heartbeat(t1.token, { eventos_pendentes: 0 })).status).toBe(200);

    const admin = await erp().get('/api/terminais');
    expect(admin.status).toBe(200);
    const lista = admin.body as ListagemTerminais;
    expect(lista.itens.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    const um = lista.itens.find((t) => t.id === t1.id)!;
    expect(um).toMatchObject({
      status: 'ativo',
      conexao: 'online',
      lojaNome: 'Loja 1 - Centro',
      numeroCaixa: 1,
      eventosComErro: 0,
      hardwareAlterado: false,
    });
    expect(lista.contadores).toEqual({ online: 1, offline: 0, sem_contato: 1 });
    const online = await erp().get('/api/terminais?conexao=online');
    expect((online.body as ListagemTerminais).itens.map((t) => t.id)).toEqual([t1.id]);
    const revogados = await erp().get('/api/terminais?situacao=revogados');
    expect((revogados.body as ListagemTerminais).itens).toEqual([]);

    // Gerente só da loja 1: não vê o terminal da loja 2 nem abre o detalhe dele.
    const gerente = await erp(tokenGerente).get('/api/terminais');
    expect((gerente.body as ListagemTerminais).itens.map((t) => t.id)).toEqual([t1.id]);
    expect((gerente.body as ListagemTerminais).contadores).toEqual({ online: 1, offline: 0, sem_contato: 0 });
    expect((await erp(tokenGerente).get(`/api/terminais/${t2.id}`)).status).toBe(403);
    expect((await erp(tokenGerente).get(`/api/terminais?lojaId=${loja2}`)).status).toBe(403);
    expect((await erp(tokenGerente).post(`/api/terminais/${t2.id}/ressincronizar`)).status).toBe(403);

    const det = await erp(tokenGerente).get(`/api/terminais/${t1.id}`);
    expect(det.status).toBe(200);
    const d = det.body as TerminalDetalhe;
    expect(d).toMatchObject({ id: t1.id, idHardware: HARDWARE, ativadoPorNome: 'ADMINISTRADOR' });
    expect(d.historico.map((h) => h.titulo)).toContain('Ativação');
    // Sem disco nem banco no heartbeat (caixa que nunca mediu): nulos; a fila vem 0 (padrão do contrato).
    expect(d).toMatchObject({ discoLivreMb: null, tamanhoBancoMb: null, filaImpressaoPendentes: 0 });
  });

  it('saúde do computador no detalhe (Central do PDV G15): disco, banco e fila do último heartbeat', async () => {
    const hb = await heartbeat(t1.token, {
      eventos_pendentes: 0,
      disco_livre_mb: 850,
      tamanho_banco_mb: 412,
      fila_impressao_pendentes: 2,
    });
    expect(hb.status).toBe(200);
    const d = (await erp(tokenGerente).get(`/api/terminais/${t1.id}`)).body as TerminalDetalhe;
    expect(d).toMatchObject({ discoLivreMb: 850, tamanhoBancoMb: 412, filaImpressaoPendentes: 2 });

    // O heartbeat que não conseguiu medir (sem os campos, ou nulos) não apaga o último valor; a fila esvaziou.
    expect((await heartbeat(t1.token, { eventos_pendentes: 0, disco_livre_mb: null })).status).toBe(200);
    const depois = (await erp().get(`/api/terminais/${t1.id}`)).body as TerminalDetalhe;
    expect(depois).toMatchObject({ discoLivreMb: 850, tamanhoBancoMb: 412, filaImpressaoPendentes: 0 });
    // A listagem não carrega a telemetria (só o detalhe, ERP 12.4).
    const lista = (await erp().get('/api/terminais')).body as ListagemTerminais;
    expect(lista.itens.find((t) => t.id === t1.id)).not.toHaveProperty('discoLivreMb');
  });

  it('renomear grava a descrição nos dois bancos; sem terminais.gerenciar → 403', async () => {
    const r = await erp().patch(`/api/terminais/${t1.id}`, { descricao: 'PC do balcão' });
    expect(r.status).toBe(200);
    expect((r.body as TerminalDetalhe).descricao).toBe('PC do balcão');
    const [e] = await consultar(emp.nomeBanco, 'select descricao from terminais where id = $1', [t1.id]);
    expect(e).toEqual({ descricao: 'PC do balcão' });

    const sem = await criarUsuario(emp.nomeBanco, {
      login: 'gerente_sem',
      perfil: 'gerente',
      lojas: [loja1],
    });
    await consultar(
      emp.nomeBanco,
      `insert into usuarios_permissoes (usuario_id, permissao, efeito)
       values ($1, 'terminais.gerenciar', 'negar'), ($1, 'terminais.revogar', 'negar'), ($1, 'terminais.ativar', 'negar')`,
      [sem],
    );
    const tk = await amb.entrar(emp.codigo, 'gerente_sem', SENHA_TESTE);
    expect((await erp(tk).get(`/api/terminais/${t1.id}`)).status).toBe(200);
    expect((await erp(tk).patch(`/api/terminais/${t1.id}`, { descricao: 'x' })).status).toBe(403);
    expect(
      (await erp(tk).post(`/api/terminais/${t1.id}/revogar`, { modo: 'aceitar_pendencias' })).status,
    ).toBe(403);
    expect((await erp(tk).post(`/api/terminais/${t1.id}/mensagem`, { texto: 'oi' })).status).toBe(403);
    expect((await erp(tk).post('/api/terminais/ativacoes/liberar')).status).toBe(403);
  });
});

describe('guarda das variações no caixa (F2-B34; D44)', () => {
  it('lista os terminais ativos abaixo da R1 do PDV ou sem versão; só para quem grava configurações', async () => {
    const antigo = await ativar(loja1, await criarCaixa(loja1, 21));
    const novo = await ativar(loja1, await criarCaixa(loja1, 22));
    const revogado = await ativar(loja1, await criarCaixa(loja1, 23));
    expect((await heartbeat(antigo.token, { eventos_pendentes: 0, versao_app: '0.10.0' })).status).toBe(200);
    expect(
      (await heartbeat(novo.token, { eventos_pendentes: 0, versao_app: VERSAO_PDV_GUARDA_VARIACOES })).status,
    ).toBe(200);
    expect((await heartbeat(revogado.token, { eventos_pendentes: 0, versao_app: '0.9.1' })).status).toBe(200);
    expect(
      (await erp().post(`/api/terminais/${revogado.id}/revogar`, { modo: 'imediato', confirmacaoCaixa: 23 }))
        .status,
    ).toBe(200);
    const r = await erp().get('/api/configuracoes/terminais-sem-guarda-variacoes');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const corpo = r.body as RespostaTerminaisSemGuardaVariacoes;
    expect(corpo.versaoMinima).toBe(VERSAO_PDV_GUARDA_VARIACOES);
    expect(corpo.terminais.find((t) => t.id === antigo.id)).toEqual({
      id: antigo.id,
      lojaNome: 'Loja 1 - Centro',
      numeroCaixa: 21,
      descricao: null,
      versaoApp: '0.10.0',
    });
    expect(corpo.terminais.some((t) => t.id === novo.id)).toBe(false);
    expect(corpo.terminais.some((t) => t.id === revogado.id)).toBe(false);
    // O Master vê todas as lojas: nenhum caixa fica só na contagem.
    expect(corpo.outrasLojas).toBe(0);
    // Sem versão conhecida (nunca mandou o heartbeat com ela): conta como antigo.
    await consultar(emp.nomeBanco, 'update terminais set versao_app = null where id = $1', [novo.id]);
    const semVersao = (await erp().get('/api/configuracoes/terminais-sem-guarda-variacoes'))
      .body as RespostaTerminaisSemGuardaVariacoes;
    expect(semVersao.terminais.find((t) => t.id === novo.id)?.versaoApp).toBeNull();

    // Usuário só da loja 1 (ERP 2.1): o caixa antigo da loja 2 entra só na contagem, sem loja, caixa nem versão.
    const daLoja2 = await ativar(loja2, await criarCaixa(loja2, 21));
    expect((await heartbeat(daLoja2.token, { eventos_pendentes: 0, versao_app: '0.10.0' })).status).toBe(200);
    const todos = (await erp().get('/api/configuracoes/terminais-sem-guarda-variacoes'))
      .body as RespostaTerminaisSemGuardaVariacoes;
    expect(todos.terminais.find((t) => t.id === daLoja2.id)?.lojaNome).toBe('Loja 2 - Bairro');
    expect(todos.outrasLojas).toBe(0);
    const restrito = await erp(tokenGerente).get('/api/configuracoes/terminais-sem-guarda-variacoes');
    expect(restrito.status, JSON.stringify(restrito.body)).toBe(200);
    const doGerente = restrito.body as RespostaTerminaisSemGuardaVariacoes;
    expect(doGerente.terminais.length).toBeGreaterThan(0);
    expect(doGerente.terminais.every((t) => t.lojaNome === 'Loja 1 - Centro')).toBe(true);
    expect(doGerente.terminais.some((t) => t.id === daLoja2.id)).toBe(false);
    // A contagem é a dos antigos da loja 2 que o Master vê (este e o `t2`, ativo e sem versão conhecida).
    const antigosLoja2 = todos.terminais.filter((t) => t.lojaNome === 'Loja 2 - Bairro').length;
    expect(antigosLoja2).toBeGreaterThan(0);
    expect(doGerente.outrasLojas).toBe(antigosLoja2);
    expect(JSON.stringify(doGerente)).not.toContain('Loja 2');

    await criarUsuario(emp.nomeBanco, { login: 'estoquista_b34', perfil: 'estoquista', lojas: [loja1] });
    const estoquista = await amb.entrar(emp.codigo, 'estoquista_b34', SENHA_TESTE);
    expect((await erp(estoquista).get('/api/configuracoes/terminais-sem-guarda-variacoes')).status).toBe(403);
  });
});

describe('códigos de ativação pendentes (ERP 12.2, 12.1)', () => {
  it('lista mascarado, cancela, e o código cancelado não ativa', async () => {
    const { codigo, ativacaoId } = await gerarCodigo(loja1, caixas.l1c2!, { descricao: 'Caixa novo' });
    const lista = await erp().get('/api/terminais/ativacoes');
    expect(lista.status).toBe(200);
    const pendente = lista.body.pendentes.find((p: { id: string }) => p.id === ativacaoId);
    expect(pendente).toMatchObject({
      codigoMascarado: `••••-••${codigo.slice(-2)}`,
      lojaNome: '1 - Loja 1 - Centro',
      numeroCaixa: 2,
      geradoPor: 'ADMINISTRADOR',
    });
    expect(lista.body.bloqueio).toMatchObject({ bloqueado: false, limite: 20 });

    expect((await erp().del(`/api/terminais/ativacoes/${ativacaoId}`)).status).toBe(204);
    const depois = await erp().get('/api/terminais/ativacoes');
    expect(depois.body.pendentes.map((p: { id: string }) => p.id)).not.toContain(ativacaoId);
    expect((await erp().del(`/api/terminais/ativacoes/${ativacaoId}`)).status).toBe(422);
    const r = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao(codigo));
    expect(r.status).toBe(422);
    expect(r.body.erro.codigo).toBe('CODIGO_INVALIDO');
    const [aud] = await consultar(
      emp.nomeBanco,
      "select acao from auditoria where entidade = 'ativacoes_pdv' and registro_id = $1 and acao = 'cancelar'",
      [ativacaoId],
    );
    expect(aud).toEqual({ acao: 'cancelar' });
  });
});

describe('revogação (SYNC 3.8; ERP 12.4)', () => {
  it('imediato: confere o nº do caixa, 401 TERMINAL_REVOGADO no pull e o caixa fica livre', async () => {
    const errado = await erp().post(`/api/terminais/${t2.id}/revogar`, {
      modo: 'imediato',
      confirmacaoCaixa: 7,
    });
    expect(errado.status).toBe(422);
    expect(errado.body.campos.confirmacaoCaixa).toBeDefined();
    const r = await erp().post(`/api/terminais/${t2.id}/revogar`, { modo: 'imediato', confirmacaoCaixa: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await statusNosBancos(t2.id)).toEqual({
      controle: 'revogado',
      motivo: 'revogado_imediato',
      empresa: 'revogado',
    });
    const pull = await amb.http().get('/sync/pull?fluxo=configuracao&desde=0').set(cabecalhos(t2.token));
    expect(pull.status).toBe(401);
    expect(pull.body.erro.codigo).toBe('TERMINAL_REVOGADO');
    const [cx] = await consultar(
      emp.nomeBanco,
      'select terminal_id, terminal_anterior_id from caixas where id = $1',
      [caixas.l2c1],
    );
    expect(cx).toEqual({ terminal_id: null, terminal_anterior_id: t2.id });
    // Repetir a mesma revogação é idempotente; outro modo num revogado é recusado.
    expect(
      (await erp().post(`/api/terminais/${t2.id}/revogar`, { modo: 'imediato', confirmacaoCaixa: 1 })).status,
    ).toBe(200);
    expect((await erp().post(`/api/terminais/${t2.id}/revogar`, { modo: 'aceitar_pendencias' })).status).toBe(
      422,
    );
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where acao = 'terminal_revogado' and registro_id = $1",
      [t2.id],
    )) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('aceitar pendências: heartbeat recebe revogar; pull só de acesso/configuracao; carência vencida → revogado', async () => {
    const r = await erp().post(`/api/terminais/${t1.id}/revogar`, { modo: 'aceitar_pendencias' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await statusNosBancos(t1.id)).toEqual({
      controle: 'desativando',
      motivo: 'aceitar_pendencias',
      empresa: 'desativando',
    });
    const hb = await heartbeat(t1.token, { eventos_pendentes: 2 });
    expect(hb.status).toBe(200);
    expect(hb.body.status_terminal).toBe('desativando');
    expect(hb.body.comandos.filter((c: { tipo: string }) => c.tipo === 'revogar')).toHaveLength(1);
    expect((await amb.http().get('/sync/pull?fluxo=acesso&desde=0').set(cabecalhos(t1.token))).status).toBe(
      200,
    );
    const catalogo = await amb.http().get('/sync/pull?fluxo=catalogo&desde=0').set(cabecalhos(t1.token));
    expect(catalogo.status).toBe(403);
    expect(catalogo.body.erro.codigo).toBe('ESCOPO_INVALIDO');
    const lista = await erp().get('/api/terminais?situacao=desativando');
    expect((lista.body as ListagemTerminais).itens.map((t) => t.id)).toEqual([t1.id]);

    // O PDV nunca confirmou: vencida a carência (simulada), a manutenção revoga sem confirmação.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set carencia_ate = now() - interval '1 minute' where id = $1",
      [t1.id],
    );
    const m = await amb.servicos.manutencaoTerminais.executar();
    expect(m).toMatchObject({ executada: true, carenciasVencidas: 1, falhas: [] });
    expect(await statusNosBancos(t1.id)).toEqual({
      controle: 'revogado',
      motivo: 'carencia_vencida',
      empresa: 'revogado',
    });
    expect((await heartbeat(t1.token)).status).toBe(401);
    // O próximo terminal do caixa recebe o salto de segurança (sem confirmação).
    const novo = await ativar(loja1, caixas.l1c1!);
    const [aud] = await consultar<{ depois: Record<string, unknown> }>(
      emp.nomeBanco,
      "select depois from auditoria where acao = 'terminal_ativado' and registro_id = $1",
      [novo.id],
    );
    expect(aud!.depois).toMatchObject({ terminal_anterior_id: t1.id, salto: true });
  });

  it('perdido/roubado: o PIN de quem acessa a loja e a senha do cliente descem nulos para os outros terminais', async () => {
    const operador = await criarUsuario(emp.nomeBanco, {
      login: 'op_loja1',
      lojas: [loja1],
      perfil: 'operador_caixa',
    });
    const outraLoja = await criarUsuario(emp.nomeBanco, {
      login: 'op_loja2',
      lojas: [loja2],
      perfil: 'operador_caixa',
    });
    await consultar(emp.nomeBanco, 'update usuarios set senha_pdv_hash = $2 where id = any($1)', [
      [operador, outraLoja],
      PIN,
    ]);
    // Só a senha que desce para a loja é anulada (ERP 12.4): exigência ligada na loja 1 e crediário com limite.
    await consultar(
      emp.nomeBanco,
      "insert into configuracoes (escopo, loja_id, chave, valor) values ('loja', $1, 'pdv.crediario_exige_senha_cliente', 'true')",
      [loja1],
    );
    const [cliente] = await consultar<{ id: string }>(
      emp.nomeBanco,
      'insert into pessoas (nome, senha_hash, limite_compras) values ($1, $2, 500) returning id',
      ['Cliente Crediário', PIN],
    );
    const [semCrediario] = await consultar<{ id: string }>(
      emp.nomeBanco,
      'insert into pessoas (nome, senha_hash) values ($1, $2) returning id',
      ['Cliente sem crediário', PIN],
    );
    for (const p of [cliente!.id, semCrediario!.id]) {
      await consultar(
        emp.nomeBanco,
        "insert into pessoas_relevancia_loja (pessoa_id, loja_id, motivo, ultima_ocorrencia_em) values ($1, $2, 'crediario', now())",
        [p, loja1],
      );
    }
    const perdido = await ativar(loja1, caixas.l1c3!);
    const outro = await ativar(loja1, caixas.l1c4!);
    const carga = await amb
      .http()
      .get('/sync/pull?fluxo=acesso&desde=0&limite=2000')
      .set(cabecalhos(outro.token));
    expect(carga.status).toBe(200);
    const pinAntes = carga.body.alteracoes.find(
      (a: { tabela: string; linha: { id: string } }) => a.tabela === 'usuarios' && a.linha.id === operador,
    );
    expect(pinAntes.linha.senha_pdv_hash).toBe(PIN);

    const r = await erp().post(`/api/terminais/${perdido.id}/revogar`, {
      modo: 'perdido',
      confirmacaoCaixa: 3,
      observacao: 'Roubado na madrugada',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'revogado', senhasClienteAnuladas: 1 });
    expect(r.body.pinsAnulados).toBeGreaterThanOrEqual(1);
    const novos = await amb
      .http()
      .get(`/sync/pull?fluxo=acesso&desde=${carga.body.novo_cursor}&limite=2000`)
      .set(cabecalhos(outro.token));
    const pinDepois = novos.body.alteracoes.find(
      (a: { tabela: string; linha: { id: string } }) => a.tabela === 'usuarios' && a.linha.id === operador,
    );
    expect(pinDepois.linha.senha_pdv_hash).toBeNull();
    // Quem não acessa a loja mantém o PIN; a senha do cliente da loja foi anulada.
    const [fora] = await consultar(emp.nomeBanco, 'select senha_pdv_hash from usuarios where id = $1', [
      outraLoja,
    ]);
    expect(fora).toEqual({ senha_pdv_hash: PIN });
    const [p] = await consultar(emp.nomeBanco, 'select senha_hash from pessoas where id = $1', [cliente!.id]);
    expect(p).toEqual({ senha_hash: null });
    // Sem limite de crediário a senha nunca desceu: fica.
    const [sem] = await consultar(emp.nomeBanco, 'select senha_hash from pessoas where id = $1', [
      semCrediario!.id,
    ]);
    expect(sem).toEqual({ senha_hash: PIN });
    const aud = await consultar<{ entidade: string }>(
      emp.nomeBanco,
      "select entidade from auditoria where acao = 'senha_redefinida' and registro_id = any($1) order by entidade",
      [[operador, cliente!.id]],
    );
    expect(aud.map((a) => a.entidade)).toEqual(['pessoas', 'usuarios']);
    expect((await heartbeat(perdido.token)).status).toBe(401);
  });
});

describe('manutenção periódica (pg-boss schedule)', () => {
  it('código vencido → expirado; provisionando esquecido com a etapa feita → ativo; empresa alcança o controle', async () => {
    const { ativacaoId } = await gerarCodigo(loja1, caixas.l1c5!);
    await consultar(
      amb.bancoControle,
      "update ativacoes_pdv set expira_em = now() - interval '1 minute' where id = $1",
      [ativacaoId],
    );
    const t = await ativar(loja1, caixas.l1c6!);
    // A API caiu entre a etapa da empresa e o 3º commit: o controle ficou `provisionando`.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set status = 'provisionando', ativado_em = now() - interval '20 minutes' where id = $1",
      [t.id],
    );
    const m1 = await amb.servicos.manutencaoTerminais.executar();
    expect(m1).toMatchObject({ codigosExpirados: 1, provisionandoConcluidos: 1, falhas: [] });
    const [a] = await consultar(amb.bancoControle, 'select status from ativacoes_pdv where id = $1', [
      ativacaoId,
    ]);
    expect(a).toEqual({ status: 'expirado' });
    expect(await statusNosBancos(t.id)).toMatchObject({ controle: 'ativo', empresa: 'ativo' });

    // A revogação gravou o controle, mas a etapa da empresa não rodou: a manutenção completa.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set status = 'revogado', revogado_em = now(), motivo_revogacao = 'revogado_imediato' where id = $1",
      [t.id],
    );
    const m2 = await amb.servicos.manutencaoTerminais.executar();
    expect(m2.terminaisAlcancados).toBe(1);
    expect(await statusNosBancos(t.id)).toEqual({
      controle: 'revogado',
      motivo: 'revogado_imediato',
      empresa: 'revogado',
    });
    const m3 = await amb.servicos.manutencaoTerminais.executar();
    expect(m3.terminaisAlcancados).toBe(0);
  });
});

describe('comandos (SYNC 21.1) e D20', () => {
  let t5: { id: string; token: string };

  it('ressincronizar (todos ou um fluxo) e mensagem chegam no heartbeat; o mesmo pedido não se repete', async () => {
    t5 = await ativar(loja1, caixas.l1c5!);
    const a = await erp().post(`/api/terminais/${t5.id}/ressincronizar`, { fluxo: 'catalogo' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await erp().post(`/api/terminais/${t5.id}/ressincronizar`, { fluxo: 'catalogo' });
    expect(b.body.comandoId).toBe(a.body.comandoId);
    expect((await erp().post(`/api/terminais/${t5.id}/ressincronizar`)).status).toBe(201);
    expect(
      (await erp().post(`/api/terminais/${t5.id}/mensagem`, { texto: 'Feche o caixa às 22h' })).status,
    ).toBe(201);
    expect((await erp().post(`/api/terminais/${t5.id}/ressincronizar`, { fluxo: 'vendas' })).status).toBe(
      422,
    );
    const hb = await heartbeat(t5.token);
    expect(
      hb.body.comandos.map((c: { tipo: string; parametros: unknown }) => [c.tipo, c.parametros]),
    ).toEqual([
      ['ressincronizar_fluxo', { fluxo: 'catalogo' }],
      ['ressincronizar', {}],
      ['mensagem', { texto: 'Feche o caixa às 22h' }],
    ]);
    const det = (await erp().get(`/api/terminais/${t5.id}`)).body as TerminalDetalhe;
    expect(det.historico.filter((h) => h.tipo === 'comando')).toHaveLength(3);
  });

  it('hardware alterado: aparece no filtro e "Confirmar troca" grava o novo id nos dois bancos', async () => {
    const novoHw = 'B'.repeat(64);
    expect((await heartbeat(t5.token, {}, novoHw)).status).toBe(200);
    const lista = await erp().get('/api/terminais?conexao=hardware_alterado');
    expect((lista.body as ListagemTerminais).itens.map((t) => t.id)).toEqual([t5.id]);
    const confirmar = () =>
      erp().post(`/api/terminais/${t5.id}/hardware/confirmar`, { idHardwarePendente: novoHw });
    const r = await confirmar();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      idHardware: novoHw,
      idHardwarePendente: null,
      hardwarePendente: null,
      hardwareAlterado: false,
    });
    const [e] = await consultar(emp.nomeBanco, 'select id_hardware from terminais where id = $1', [t5.id]);
    expect(e).toEqual({ id_hardware: novoHw });
    expect((await confirmar()).status).toBe(422);
  });

  it('D20: substituir um terminal com evento em erro libera a numeração na hora e gera alerta no ERP', async () => {
    const payload = { registros: [], logins: [] };
    const ev = {
      evento_id: uuidv7(),
      sequencia: 1,
      tipo: 'auditoria.registros',
      versao_schema: 1,
      agregado_tipo: 'auditoria',
      agregado_id: uuidv7(),
      dependencias: [],
      ocorrido_em: new Date().toISOString(),
      ocorrido_em_local: new Date().toISOString(),
      relogio_confiavel: true,
      usuario_id: null,
      contexto: {
        loja_id: loja1,
        caixa_id: caixas.l1c5,
        numero_caixa: 5,
        versao_app: '1.0.0',
        versao_schema_local: 1,
      },
      payload,
      // Hash errado de propósito: o evento fica `erro` (PAYLOAD_INVALIDO) e ocupa a sequência.
      payload_sha256: createHash('sha256')
        .update(`${jcs(payload)}x`, 'utf8')
        .digest('hex'),
    };
    const p = await amb
      .http()
      .post('/sync/push')
      .set(cabecalhos(t5.token, 'B'.repeat(64)))
      .send({ lote_id: uuidv7(), terminal_id: t5.id, enviado_em: new Date().toISOString(), eventos: [ev] });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.resultados[0].status).toBe('rejeitado');

    const erros = await erp().get(`/api/terminais/${t5.id}/eventos-erro`);
    expect(erros.status).toBe(200);
    expect(erros.body).toMatchObject({
      total: 1,
      pagina: 1,
      codigos: [{ codigo: 'PAYLOAD_INVALIDO', quantidade: 1 }],
    });
    expect(erros.body.itens).toHaveLength(1);
    expect(erros.body.itens[0]).toMatchObject({
      sequencia: 1,
      status: 'erro',
      erroCodigo: 'PAYLOAD_INVALIDO',
      payload,
    });
    // Sem terminais.gerenciar a aba lista, mas sem o payload.
    const gerenteSem = await amb.entrar(emp.codigo, 'gerente_sem', SENHA_TESTE);
    const semPayload = await erp(gerenteSem).get(`/api/terminais/${t5.id}/eventos-erro`);
    expect(semPayload.body.itens[0].payload).toBeNull();

    const substituto = await ativar(loja1, caixas.l1c5!, { substituiTerminalId: t5.id });
    expect(await statusNosBancos(t5.id)).toMatchObject({ controle: 'desativando', empresa: 'desativando' });
    const lista = (await erp().get('/api/terminais?situacao=todos')).body as ListagemTerminais;
    const alerta = lista.alertas.find((a) => a.tipo === 'TERMINAL_DESATIVADO_COM_EVENTOS');
    expect(alerta).toMatchObject({ terminalId: t5.id, severidade: 'critico' });
    expect(lista.itens.find((t) => t.id === t5.id)?.eventosComErro).toBe(1);
    expect(lista.itens.find((t) => t.id === substituto.id)?.status).toBe('ativo');
    const det = (await erp().get(`/api/terminais/${t5.id}`)).body as TerminalDetalhe;
    // O detalhe mostra o D20 e o EVENTO_COM_ERRO do evento (SYNC 11.3), tirado de `dados.terminal_id`.
    expect(det.alertas.map((a) => a.tipo).sort()).toEqual([
      'EVENTO_COM_ERRO',
      'TERMINAL_DESATIVADO_COM_EVENTOS',
    ]);
    expect(det.alertas.find((a) => a.tipo === 'TERMINAL_DESATIVADO_COM_EVENTOS')?.id).toBe(alerta!.id);
    // Enquanto o evento estiver em erro, a manutenção mantém o alerta aberto.
    expect((await amb.servicos.manutencaoTerminais.executar()).alertasResolvidos).toBe(0);
    await consultar(
      emp.nomeBanco,
      "update eventos_recebidos set status = 'descartado' where terminal_id = $1",
      [t5.id],
    );
    expect((await amb.servicos.manutencaoTerminais.executar()).alertasResolvidos).toBe(1);
  });
});

describe('"Liberar ativações" (SYNC 3.1; ERP 12.2)', () => {
  it('20 falhas em 1 h bloqueiam o código da empresa com alerta; liberar zera o bloqueio e é auditado', async () => {
    const [{ n }] = (await consultar<{ n: number }>(
      amb.bancoControle,
      `select count(*)::int as n from tentativas_ativacao
        where codigo_empresa = $1 and not sucesso and motivo_falha in ('codigo_invalido','expirado','empresa_inativa')`,
      [emp.codigo],
    )) as [{ n: number }];
    // De outro IP (o bloqueio por IP é separado), até faltar uma falha.
    for (let i = n; i < 19; i++) {
      await consultar(
        amb.bancoControle,
        "insert into tentativas_ativacao (ip, codigo_empresa, sucesso, motivo_falha) values ('10.9.9.9', $1, false, 'codigo_invalido')",
        [emp.codigo],
      );
    }
    const vigesima = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao('ZZZZZZZZ'));
    expect(vigesima.status).toBe(422);
    const { codigo } = await gerarCodigo(loja2, caixas.l2c1!);
    const bloqueada = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao(codigo));
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body.erro.codigo).toBe('ATIVACAO_BLOQUEADA');

    const estado = await erp().get('/api/terminais/ativacoes');
    expect(estado.body.bloqueio).toMatchObject({ bloqueado: true, falhas: 20 });
    expect(estado.body.bloqueio.ate).not.toBeNull();
    const lista = (await erp().get('/api/terminais')).body as ListagemTerminais;
    expect(lista.alertas.map((a) => a.tipo)).toContain('ATIVACAO_FORCA_BRUTA');

    const liberar = await erp(tokenGerente).post('/api/terminais/ativacoes/liberar');
    expect(liberar.status).toBe(200);
    expect(liberar.body).toMatchObject({ bloqueado: false, falhas: 0 });
    const [alerta] = await consultar(
      emp.nomeBanco,
      "select resolvido_em is not null as resolvido from alertas where tipo = 'ATIVACAO_FORCA_BRUTA'",
    );
    expect(alerta).toEqual({ resolvido: true });
    const [aud] = await consultar(
      emp.nomeBanco,
      "select usuario_nome from auditoria where acao = 'liberacao'",
    );
    expect(aud).toEqual({ usuario_nome: 'GERENTE_L1' });
    const ativada = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao(codigo));
    expect(ativada.status, JSON.stringify(ativada.body)).toBe(201);
  });
});

/**
 * Push de um evento `auditoria.registros`: com `hashErrado` fica `erro` (PAYLOAD_INVALIDO) e ocupa a sequência; com
 * `dependencias` apontando para o agregado de um evento em erro, fica `retido`.
 */
async function enviarEvento(
  t: { id: string; token: string },
  caixaId: string,
  numero: number,
  opcoes: { sequencia: number; hashErrado?: boolean; dependeDe?: string },
) {
  const payload = { registros: [], logins: [] };
  const ev = {
    evento_id: uuidv7(),
    sequencia: opcoes.sequencia,
    tipo: 'auditoria.registros',
    versao_schema: 1,
    agregado_tipo: 'auditoria',
    agregado_id: uuidv7(),
    dependencias: opcoes.dependeDe ? [{ agregado_tipo: 'auditoria', agregado_id: opcoes.dependeDe }] : [],
    ocorrido_em: new Date().toISOString(),
    ocorrido_em_local: new Date().toISOString(),
    relogio_confiavel: true,
    usuario_id: null,
    contexto: {
      loja_id: loja1,
      caixa_id: caixaId,
      numero_caixa: numero,
      versao_app: '1.0.0',
      versao_schema_local: 1,
    },
    payload,
    payload_sha256: createHash('sha256')
      .update(`${jcs(payload)}${opcoes.hashErrado ? 'x' : ''}`, 'utf8')
      .digest('hex'),
  };
  const p = await amb
    .http()
    .post('/sync/push')
    .set(cabecalhos(t.token))
    .send({ lote_id: uuidv7(), terminal_id: t.id, enviado_em: new Date().toISOString(), eventos: [ev] });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return { ev, status: p.body.resultados[0].status as string };
}

const auditoriasRevogado = async (id: string) =>
  consultar<{ status: string; motivo: string | null }>(
    emp.nomeBanco,
    `select depois ->> 'status' as status, depois ->> 'motivo' as motivo from auditoria
      where acao = 'terminal_revogado' and registro_id = $1 order by ocorrido_em`,
    [id],
  );

async function usuarioComPin(login: string): Promise<string> {
  const id = await criarUsuario(emp.nomeBanco, { login, lojas: [loja1], perfil: 'operador_caixa' });
  await consultar(emp.nomeBanco, 'update usuarios set senha_pdv_hash = $2 where id = $1', [id, PIN]);
  return id;
}

const pinDe = async (id: string) =>
  (
    await consultar<{ pin: string | null }>(
      emp.nomeBanco,
      'select senha_pdv_hash as pin from usuarios where id = $1',
      [id],
    )
  )[0]!.pin;

describe('perdido/roubado depois da revogação e revogação incompleta (SYNC 4.3 item 6; D20)', () => {
  beforeAll(async () => {
    for (const n of [7, 8, 9, 10, 11, 12]) caixas[`l1c${n}`] = await criarCaixa(loja1, n);
  });

  it('furto descoberto depois de "Revogar imediatamente": perdido anula os PINs uma vez; falha_ativacao → 422', async () => {
    const op = await usuarioComPin('op_furto');
    const t = await ativar(loja1, caixas.l1c7!);
    expect(
      (await erp().post(`/api/terminais/${t.id}/revogar`, { modo: 'imediato', confirmacaoCaixa: 7 })).status,
    ).toBe(200);
    expect(await pinDe(op)).toBe(PIN);

    const r = await erp().post(`/api/terminais/${t.id}/revogar`, {
      modo: 'perdido',
      confirmacaoCaixa: 7,
      observacao: 'Máquina furtada da loja',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'revogado', motivo: 'perdido_roubado', alterado: true });
    expect(r.body.pinsAnulados).toBeGreaterThanOrEqual(1);
    expect(await pinDe(op)).toBeNull();
    expect(await statusNosBancos(t.id)).toEqual({
      controle: 'revogado',
      motivo: 'perdido_roubado',
      empresa: 'revogado',
    });
    const [e] = await consultar(emp.nomeBanco, 'select motivo_revogacao from terminais where id = $1', [
      t.id,
    ]);
    expect(e).toEqual({ motivo_revogacao: 'perdido_roubado' });
    expect(await auditoriasRevogado(t.id)).toEqual([
      { status: 'revogado', motivo: 'revogado_imediato' },
      { status: 'revogado', motivo: 'perdido_roubado' },
    ]);
    // Repetir não anula de novo; voltar a outro modo continua recusado.
    await consultar(emp.nomeBanco, 'update usuarios set senha_pdv_hash = $2 where id = $1', [op, PIN]);
    const de_novo = await erp().post(`/api/terminais/${t.id}/revogar`, {
      modo: 'perdido',
      confirmacaoCaixa: 7,
    });
    expect(de_novo.body).toMatchObject({ alterado: false, pinsAnulados: 0 });
    expect(await pinDe(op)).toBe(PIN);
    expect(
      (await erp().post(`/api/terminais/${t.id}/revogar`, { modo: 'imediato', confirmacaoCaixa: 7 })).status,
    ).toBe(422);

    // A ativação que não concluiu nunca recebeu credenciais: nada a anular.
    const f = await ativar(loja1, caixas.l1c8!);
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set status = 'revogado', motivo_revogacao = 'falha_ativacao', revogado_em = now() where id = $1",
      [f.id],
    );
    expect(
      (await erp().post(`/api/terminais/${f.id}/revogar`, { modo: 'perdido', confirmacaoCaixa: 8 })).status,
    ).toBe(422);
  });

  it('perdido gravado no controle sem a etapa da empresa: a ativação do novo no caixa completa a anulação', async () => {
    const op = await usuarioComPin('op_furto2');
    const t = await ativar(loja1, caixas.l1c9!);
    // A transação da empresa da revogação falhou (500) depois do controle.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set status = 'revogado', motivo_revogacao = 'perdido_roubado', revogado_em = now() where id = $1",
      [t.id],
    );
    const novo = await ativar(loja1, caixas.l1c9!);
    expect(await statusNosBancos(t.id)).toMatchObject({ controle: 'revogado', empresa: 'revogado' });
    expect(await pinDe(op)).toBeNull();
    expect(await auditoriasRevogado(t.id)).toEqual([{ status: 'revogado', motivo: 'perdido_roubado' }]);
    const [cx] = await consultar(
      emp.nomeBanco,
      'select terminal_id, terminal_anterior_id from caixas where id = $1',
      [caixas.l1c9],
    );
    expect(cx).toEqual({ terminal_id: novo.id, terminal_anterior_id: t.id });
    // A manutenção não refaz.
    await amb.servicos.manutencaoTerminais.executar();
    expect(await auditoriasRevogado(t.id)).toHaveLength(1);
  });

  it('desativação confirmada no heartbeat: caixa livre, auditoria, alerta da D20 e o próximo continua a série', async () => {
    const t = await ativar(loja1, caixas.l1c10!);
    const comErro = await enviarEvento(t, caixas.l1c10!, 10, { sequencia: 1, hashErrado: true });
    expect(comErro.status).toBe('rejeitado');
    const retido = await enviarEvento(t, caixas.l1c10!, 10, {
      sequencia: 2,
      dependeDe: comErro.ev.agregado_id,
    });
    expect(retido.status).toBe('retido');
    // ERP 12.5: o retido diz qual evento o segura.
    const aba = ((await erp().get(`/api/terminais/${t.id}/eventos-erro`)).body as ListagemEventosComErro)
      .itens;
    expect(aba.find((e) => e.sequencia === 2)).toMatchObject({
      status: 'retido',
      aguardando: [{ eventoId: comErro.ev.evento_id, sequencia: 1, tipo: 'auditoria.registros' }],
      dependencias: [{ agregadoTipo: 'auditoria', agregadoId: comErro.ev.agregado_id }],
    });
    expect(aba.find((e) => e.sequencia === 1)?.aguardando).toEqual([]);
    expect((await erp().post(`/api/terminais/${t.id}/revogar`, { modo: 'aceitar_pendencias' })).status).toBe(
      200,
    );
    const hb = await heartbeat(t.token, {
      estado_local: 'desativando_confirmado',
      eventos_pendentes: 0,
      ultima_sequencia_gerada: 2,
      venda_ultimo_numero: 42,
    });
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    expect(hb.body.status_terminal).toBe('revogado');
    expect(await statusNosBancos(t.id)).toEqual({
      controle: 'revogado',
      motivo: 'desativacao_confirmada',
      empresa: 'revogado',
    });
    const [cx] = await consultar(
      emp.nomeBanco,
      'select terminal_id, terminal_anterior_id from caixas where id = $1',
      [caixas.l1c10],
    );
    expect(cx).toEqual({ terminal_id: null, terminal_anterior_id: t.id });
    const alertas = await consultar(
      emp.nomeBanco,
      "select tipo from alertas where registro_id = $1 and resolvido_em is null and tipo = 'TERMINAL_DESATIVADO_COM_EVENTOS'",
      [t.id],
    );
    expect(alertas).toHaveLength(1);
    expect(await auditoriasRevogado(t.id)).toEqual([
      { status: 'desativando', motivo: null },
      { status: 'revogado', motivo: 'desativacao_confirmada' },
    ]);
    // O `revogar` foi um só (o da revogação no ERP), e a manutenção não refaz a revogação.
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from comandos_terminal where terminal_id = $1 and tipo = 'revogar'",
      [t.id],
    )) as [{ n: number }];
    expect(n).toBe(1);
    await amb.servicos.manutencaoTerminais.executar();
    expect(await auditoriasRevogado(t.id)).toHaveLength(2);

    const novo = await ativar(loja1, caixas.l1c10!);
    const [aud] = await consultar<{ depois: Record<string, unknown> }>(
      emp.nomeBanco,
      "select depois from auditoria where acao = 'terminal_ativado' and registro_id = $1",
      [novo.id],
    );
    expect(aud!.depois).toMatchObject({ terminal_anterior_id: t.id, salto: false });
    expect((aud!.depois as { numeracoes: { venda: { ultimo: number } } }).numeracoes).toBeDefined();
  });

  it('o alerta da D20 fecha sozinho mesmo com o terminal revogado há mais de 7 dias', async () => {
    const [alerta] = await consultar<{ id: string; registro_id: string }>(
      emp.nomeBanco,
      "select id, registro_id from alertas where tipo = 'TERMINAL_DESATIVADO_COM_EVENTOS' and resolvido_em is null",
    );
    expect(alerta).toBeDefined();
    // Nada da empresa mudou nos últimos 7 dias (o trigger de versão é desligado só para envelhecer as linhas).
    await consultar(
      amb.bancoControle,
      `set session_replication_role = replica;
       update terminais_pdv set atualizado_em = now() - interval '10 days' where empresa_id = '${emp.empresaId}';
       set session_replication_role = origin;`,
    );
    const antes = await amb.servicos.manutencaoTerminais.executar();
    expect(antes).toMatchObject({ empresasReconciliadas: 0, alertasResolvidos: 0, falhas: [] });
    await consultar(
      emp.nomeBanco,
      "update eventos_recebidos set status = 'descartado' where terminal_id = $1 and status in ('erro','retido')",
      [alerta!.registro_id],
    );
    const depois = await amb.servicos.manutencaoTerminais.executar();
    expect(depois.alertasResolvidos).toBeGreaterThanOrEqual(1);
    const [a] = await consultar(
      emp.nomeBanco,
      'select resolvido_em is not null as resolvido from alertas where id = $1',
      [alerta!.id],
    );
    expect(a).toEqual({ resolvido: true });
  });

  it('provisionando esquecido sem a etapa da empresa: compensa, e a substituição em andamento não mexe no antigo', async () => {
    const antigo = await ativar(loja1, caixas.l1c11!);
    const { ativacaoId } = await gerarCodigo(loja1, caixas.l1c11!, { substituiTerminalId: antigo.id });
    // 1º commit da ativação do substituto feito, e a API caiu antes da etapa da empresa.
    const novoId = uuidv7();
    await consultar(
      amb.bancoControle,
      `update terminais_pdv set status = 'desativando', carencia_ate = now() + interval '7 days' where id = $1`,
      [antigo.id],
    );
    await consultar(
      amb.bancoControle,
      `insert into terminais_pdv (id, empresa_id, loja_id, caixa_id, numero_caixa, token_hash, chave_publica_terminal,
                                  chave_publica_algoritmo, status, ativacao_id, ativado_em)
       values ($1, $2, $3, $4, 11, repeat('0', 64), '\\x00'::bytea, 'x25519', 'provisionando', $5,
               now() - interval '5 minutes')`,
      [novoId, emp.empresaId, loja1, caixas.l1c11, ativacaoId],
    );
    await consultar(
      amb.bancoControle,
      'update terminais_pdv set substituido_por_terminal_id = $2 where id = $1',
      [antigo.id, novoId],
    );
    await consultar(
      amb.bancoControle,
      "update ativacoes_pdv set status = 'usado', usado_em = now(), terminal_id = $2 where id = $1",
      [ativacaoId, novoId],
    );
    // Dentro da janela de repetição a manutenção não leva o antigo a `desativando` na empresa.
    await amb.servicos.manutencaoTerminais.executar();
    expect(await statusNosBancos(antigo.id)).toMatchObject({ controle: 'desativando', empresa: 'ativo' });
    expect(await auditoriasRevogado(antigo.id)).toEqual([]);

    // Passada a janela de repetição (15 min), a manutenção ainda dá margem à etapa de uma repetição em andamento.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set ativado_em = now() - interval '17 minutes' where id = $1",
      [novoId],
    );
    expect(await amb.servicos.manutencaoTerminais.executar()).toMatchObject({ provisionandoCompensados: 0 });
    expect(await statusNosBancos(novoId)).toMatchObject({ controle: 'provisionando' });
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set ativado_em = now() - interval '25 minutes' where id = $1",
      [novoId],
    );
    const m = await amb.servicos.manutencaoTerminais.executar();
    expect(m).toMatchObject({ provisionandoCompensados: 1, falhas: [] });
    expect(await statusNosBancos(novoId)).toEqual({
      controle: 'revogado',
      motivo: 'falha_ativacao',
      empresa: undefined,
    });
    expect(await statusNosBancos(antigo.id)).toMatchObject({ controle: 'ativo', empresa: 'ativo' });
    const [a] = await consultar(
      amb.bancoControle,
      'select status, terminal_id from ativacoes_pdv where id = $1',
      [ativacaoId],
    );
    expect(a).toEqual({ status: 'pendente', terminal_id: null });
    expect((await erp().del(`/api/terminais/ativacoes/${ativacaoId}`)).status).toBe(204);
  });

  it('caixas livres pela rota de terminais: basta terminais.ativar; o caixa do terminal em desativação aparece', async () => {
    const suporte = await criarUsuario(emp.nomeBanco, {
      login: 'suporte_caixa',
      perfil: 'gerente',
      lojas: [loja1],
    });
    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'lojas.ver', 'negar')",
      [suporte],
    );
    const tk = await amb.entrar(emp.codigo, 'suporte_caixa', SENHA_TESTE);
    expect((await erp(tk).get(`/api/lojas/${loja1}/caixas`)).status).toBe(403);

    const saindo = await ativar(loja1, caixas.l1c12!);
    expect(
      (await erp().post(`/api/terminais/${saindo.id}/revogar`, { modo: 'aceitar_pendencias' })).status,
    ).toBe(200);
    const r = await erp(tk).get(`/api/terminais/caixas-livres?lojaId=${loja1}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const porId = new Map(
      (r.body as Array<{ id: string; terminalDesativandoId: string | null }>).map((c) => [c.id, c]),
    );
    expect(porId.get(caixas.l1c12!)?.terminalDesativandoId).toBe(saindo.id);
    expect(porId.has(caixas.l1c9!)).toBe(false); // ocupado pelo terminal ativo
    expect(porId.get(caixas.l1c7!)?.terminalDesativandoId).toBeNull();
    expect((await erp(tk).get(`/api/terminais/caixas-livres?lojaId=${loja2}`)).status).toBe(403);
    expect((await erp(tk).get('/api/terminais/caixas-livres')).status).toBe(422);

    // O código sem substituição ativa no caixa; o antigo sai dele com a D20 avaliada.
    const { codigo } = (
      await erp(tk).post('/api/terminais/ativacoes', { lojaId: loja1, caixaId: caixas.l1c12 })
    ).body as { codigo: string };
    const novo = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao(codigo));
    expect(novo.status, JSON.stringify(novo.body)).toBe(201);
    const [cx] = await consultar(
      emp.nomeBanco,
      'select terminal_id, terminal_anterior_id from caixas where id = $1',
      [caixas.l1c12],
    );
    expect(cx).toEqual({ terminal_id: novo.body.terminal_id, terminal_anterior_id: saindo.id });

    // Dashboard (ERP 6) e listagem contam "online" pelo mesmo último contato: o pull sem heartbeat já vale.
    const pull = await amb
      .http()
      .get('/sync/pull?fluxo=configuracao&desde=0')
      .set(cabecalhos(`${novo.body.token}`));
    expect(pull.status).toBe(200);
    const lista = (await erp().get('/api/terminais')).body as ListagemTerminais;
    expect(lista.itens.find((t) => t.id === novo.body.terminal_id)?.conexao).toBe('online');
    const painel = await erp().get('/api/dashboard');
    expect(painel.status).toBe(200);
    expect(painel.body.pdvs.online).toBe(lista.contadores.online);
  });
});

describe('revisão integrada da 1B: substituição, ativação, hardware e limite de comandos', () => {
  beforeAll(async () => {
    for (const n of [13, 14, 15, 16, 17, 18, 19]) caixas[`l1c${n}`] = await criarCaixa(loja1, n);
  });

  /** O 1º commit da ativação do substituto, sem a etapa da empresa (a API caiu entre os dois). */
  async function primeiroCommitDaSubstituicao(antigoId: string, caixa: string, numero: number) {
    const { ativacaoId } = await gerarCodigo(loja1, caixa, { substituiTerminalId: antigoId });
    const novoId = uuidv7();
    await consultar(
      amb.bancoControle,
      `update terminais_pdv set status = 'desativando', carencia_ate = now() + interval '7 days' where id = $1`,
      [antigoId],
    );
    await consultar(
      amb.bancoControle,
      `insert into terminais_pdv (id, empresa_id, loja_id, caixa_id, numero_caixa, token_hash, chave_publica_terminal,
                                  chave_publica_algoritmo, status, ativacao_id, ativado_em)
       values ($1, $2, $3, $4, $5, repeat('0', 64), '\\x00'::bytea, 'x25519', 'provisionando', $6, now())`,
      [novoId, emp.empresaId, loja1, caixa, numero, ativacaoId],
    );
    await consultar(
      amb.bancoControle,
      'update terminais_pdv set substituido_por_terminal_id = $2 where id = $1',
      [antigoId, novoId],
    );
    await consultar(
      amb.bancoControle,
      "update ativacoes_pdv set status = 'usado', usado_em = now(), terminal_id = $2 where id = $1",
      [ativacaoId, novoId],
    );
    return novoId;
  }

  const revogarDoTerminal = (id: string) =>
    consultar<{ status: string }>(
      emp.nomeBanco,
      "select status from comandos_terminal where terminal_id = $1 and tipo = 'revogar' order by criado_em",
      [id],
    );
  const tipos = (hb: { body: { comandos: Array<{ tipo: string }> } }) => hb.body.comandos.map((c) => c.tipo);

  it('substituição em andamento: o antigo segue ativo no heartbeat e no estado; a compensação cancela o revogar entregue', async () => {
    const antigo = await ativar(loja1, caixas.l1c13!);
    const novoId = await primeiroCommitDaSubstituicao(antigo.id, caixas.l1c13!, 13);

    // Sem pendências e "confirmando": nem revogar, nem desativação confirmada enquanto o novo provisiona.
    const hb = await heartbeat(antigo.token, {
      estado_local: 'desativando_confirmado',
      eventos_pendentes: 0,
    });
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    expect(hb.body.status_terminal).toBe('ativo');
    expect(tipos(hb)).not.toContain('revogar');
    expect(await revogarDoTerminal(antigo.id)).toEqual([]);
    expect(await statusNosBancos(antigo.id)).toMatchObject({ controle: 'desativando', empresa: 'ativo' });
    const estado = await amb.http().get('/sync/estado').set(cabecalhos(antigo.token));
    expect(estado.status).toBe(200);
    expect(estado.body.terminal.status).toBe('ativo');
    expect(
      (await amb.http().get('/sync/pull?fluxo=catalogo&desde=0').set(cabecalhos(antigo.token))).status,
    ).toBe(200);
    // "Aceitar pendências" no ERP seria desfeito em silêncio pela compensação: recusado.
    const aceitar = await erp().post(`/api/terminais/${antigo.id}/revogar`, { modo: 'aceitar_pendencias' });
    expect(aceitar.status).toBe(422);
    expect(await revogarDoTerminal(antigo.id)).toEqual([]);

    // Um `revogar` que ganhou a corrida e já foi entregue: não desce de novo durante a substituição...
    await consultar(
      emp.nomeBanco,
      "insert into comandos_terminal (terminal_id, tipo, status, entregue_em) values ($1, 'revogar', 'entregue', now())",
      [antigo.id],
    );
    expect(tipos(await heartbeat(antigo.token))).not.toContain('revogar');

    // ...e a compensação (provisionando esquecido) o cancela junto com a volta do antigo a `ativo`.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set ativado_em = now() - interval '25 minutes' where id = $1",
      [novoId],
    );
    expect(await amb.servicos.manutencaoTerminais.executar()).toMatchObject({
      provisionandoCompensados: 1,
      falhas: [],
    });
    expect(await revogarDoTerminal(antigo.id)).toEqual([{ status: 'cancelado' }]);
    const depois = await heartbeat(antigo.token, { estado_local: 'ativo' });
    expect(depois.body.status_terminal).toBe('ativo');
    expect(tipos(depois)).not.toContain('revogar');
    expect(await statusNosBancos(antigo.id)).toMatchObject({ controle: 'ativo', empresa: 'ativo' });
  });

  it('desativação só se confirma com o terminal em desativando também no banco da empresa', async () => {
    const t = await ativar(loja1, caixas.l1c14!);
    // O controle foi para `desativando` e a etapa da empresa da revogação não rodou.
    await consultar(
      amb.bancoControle,
      "update terminais_pdv set status = 'desativando', carencia_ate = now() + interval '7 days', motivo_revogacao = 'aceitar_pendencias' where id = $1",
      [t.id],
    );
    const confirmar = () =>
      heartbeat(t.token, { estado_local: 'desativando_confirmado', eventos_pendentes: 0 });
    const hb = await confirmar();
    expect(hb.body.status_terminal).toBe('desativando');
    expect(await statusNosBancos(t.id)).toMatchObject({ controle: 'desativando', empresa: 'ativo' });
    const [e] = await consultar(
      emp.nomeBanco,
      'select desativacao_confirmada_em from terminais where id = $1',
      [t.id],
    );
    expect(e).toEqual({ desativacao_confirmada_em: null });
    // A manutenção alcança a empresa; o heartbeat seguinte confirma.
    await amb.servicos.manutencaoTerminais.executar();
    expect(await statusNosBancos(t.id)).toMatchObject({ empresa: 'desativando' });
    expect((await confirmar()).body.status_terminal).toBe('revogado');
    expect(await statusNosBancos(t.id)).toMatchObject({
      controle: 'revogado',
      motivo: 'desativacao_confirmada',
    });
  });

  it('heartbeat de outra máquina não confirma a desativação nem grava a telemetria do terminal', async () => {
    const t = await ativar(loja1, caixas.l1c15!);
    await heartbeat(t.token, { so: 'Windows 11 Pro', venda_ultimo_numero: 10, eventos_pendentes: 3 });
    expect((await erp().post(`/api/terminais/${t.id}/revogar`, { modo: 'aceitar_pendencias' })).status).toBe(
      200,
    );
    const hb = await heartbeat(
      t.token,
      {
        estado_local: 'desativando_confirmado',
        eventos_pendentes: 0,
        ultima_sequencia_gerada: 0,
        venda_ultimo_numero: 99,
        so: 'Linux da cópia',
      },
      'E'.repeat(64),
    );
    expect(hb.status).toBe(200);
    expect(hb.body.status_terminal).toBe('hardware_alterado');
    expect(await statusNosBancos(t.id)).toMatchObject({ controle: 'desativando', empresa: 'desativando' });
    const [e] = await consultar(
      emp.nomeBanco,
      `select desativacao_confirmada_em, venda_ultimo_numero, eventos_pendentes, sistema_operacional, estado_local
         from terminais where id = $1`,
      [t.id],
    );
    expect(e).toEqual({
      desativacao_confirmada_em: null,
      venda_ultimo_numero: '10',
      eventos_pendentes: 3,
      sistema_operacional: 'Windows 11 Pro',
      estado_local: 'ativo',
    });
  });

  it('troca de hardware: o ERP vê a primeira chamada da outra máquina e confirma só o id exibido', async () => {
    const t = await ativar(loja1, caixas.l1c16!);
    const h3 = 'F'.repeat(64);
    const h4 = 'G'.repeat(64);
    await heartbeat(t.token, { so: 'Windows 11 Pro' });
    await heartbeat(t.token, { so: 'Ubuntu 24.04' }, h3);
    // A máquina registrada continua batendo, e a cópia chama de novo com outro SO: o pendente fica com a 1ª chamada.
    await heartbeat(t.token, { so: 'Windows 11 Pro' });
    await heartbeat(t.token, { so: 'Outro SO' }, h3);
    const det = (await erp().get(`/api/terminais/${t.id}`)).body as TerminalDetalhe;
    expect(det).toMatchObject({
      hardwareAlterado: true,
      sistemaOperacional: 'Windows 11 Pro',
      idHardwarePendente: h3,
      hardwarePendente: { id: h3, sistemaOperacional: 'Ubuntu 24.04' },
    });
    expect(det.hardwarePendente!.desde).not.toBeNull();
    expect(det.hardwarePendente!.ip).not.toBeNull();
    const [c] = await consultar(
      amb.bancoControle,
      'select sistema_operacional from terminais_pdv where id = $1',
      [t.id],
    );
    expect(c).toEqual({ sistema_operacional: 'Windows 11 Pro' });

    // Uma terceira máquina chamou depois que o gerente abriu a tela: a confirmação do que ele viu é recusada.
    expect((await amb.http().get('/sync/estado').set(cabecalhos(t.token, h4))).status).toBe(200);
    const recusada = await erp().post(`/api/terminais/${t.id}/hardware/confirmar`, {
      idHardwarePendente: h3,
    });
    expect(recusada.status).toBe(409);
    expect(recusada.body.codigo).toBe('CONFLITO');
    const det2 = (await erp().get(`/api/terminais/${t.id}`)).body as TerminalDetalhe;
    expect(det2).toMatchObject({
      idHardware: HARDWARE,
      hardwarePendente: { id: h4, sistemaOperacional: null },
    });
    expect((await erp().post(`/api/terminais/${t.id}/hardware/confirmar`, {})).status).toBe(422);
    const ok = await erp().post(`/api/terminais/${t.id}/hardware/confirmar`, { idHardwarePendente: h4 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ idHardware: h4, hardwarePendente: null, hardwareAlterado: false });
  });

  it('o heartbeat entrega no máximo 100 comandos; o resto sai conforme os acks chegam', async () => {
    const t = await ativar(loja1, caixas.l1c17!);
    await consultar(
      emp.nomeBanco,
      `insert into comandos_terminal (terminal_id, tipo, parametros)
       select $1, 'mensagem', jsonb_build_object('texto', 'Aviso ' || g) from generate_series(1, 101) g`,
      [t.id],
    );
    const hb = await heartbeat(t.token);
    expect(hb.body.comandos).toHaveLength(100);
    const acks = (hb.body.comandos as Array<{ id: string }>).map((c) => ({
      comando_id: c.id,
      status: 'executado',
    }));
    // O contrato da requisição continua com no máximo 100 acks (o PDV fatia).
    const demais = await heartbeat(t.token, {
      comandos_resultado: [...acks, { comando_id: uuidv7(), status: 'executado' }],
    });
    expect(demais.status).toBe(400);
    const seguinte = await heartbeat(t.token, { comandos_resultado: acks });
    expect(seguinte.status).toBe(200);
    expect(seguinte.body.comandos).toHaveLength(1);
    expect(acks.map((a) => a.comando_id)).not.toContain(seguinte.body.comandos[0].id);
  });

  it('ativação: a janela de repetição usa o relógio do banco; sem promoção no 3º commit não há token', async () => {
    const { codigo } = await gerarCodigo(loja1, caixas.l1c18!);
    const corpo = corpoAtivacao(codigo);
    expect((await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpo)).status).toBe(201);
    // O relógio da API adiantado 16 min não fecha a janela: quem mede é o banco.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 16 * 60_000);
      const repeticao = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpo);
      expect(repeticao.status, JSON.stringify(repeticao.body)).toBe(201);
    } finally {
      vi.useRealTimers();
    }

    // A manutenção compensou enquanto a etapa da empresa rodava: o terminal não chega a `ativo` e o token não sai.
    const { codigo: outro } = await gerarCodigo(loja1, caixas.l1c19!);
    const corpo2 = corpoAtivacao(outro);
    const servico = amb.servicos.ativacao as unknown as {
      etapaEmpresa: (empresa: unknown, t: { id: string }, ...resto: unknown[]) => Promise<unknown>;
    };
    const original = servico.etapaEmpresa.bind(servico);
    const espiao = vi.spyOn(servico, 'etapaEmpresa').mockImplementationOnce(async (empresa, t, ...resto) => {
      const r = await original(empresa, t, ...resto);
      await amb.servicos.ativacao.compensar(t.id);
      return r;
    });
    try {
      const r = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpo2);
      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(r.body.erro.codigo).toBe('MANUTENCAO');
      expect(r.body).not.toHaveProperty('token');
    } finally {
      espiao.mockRestore();
    }
    // O código voltou a `pendente`: a nova tentativa do PDV ativa outro terminal no caixa.
    const nova = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpo2);
    expect(nova.status, JSON.stringify(nova.body)).toBe(201);
    expect(await statusNosBancos(nova.body.terminal_id)).toMatchObject({
      controle: 'ativo',
      empresa: 'ativo',
    });
  });
});

describe('token anterior reutilizado no ERP (SYNC 3.7; ERP 12.4)', () => {
  it('aparece na listagem e no detalhe, "Resolver" grava quem e o quê, e um novo uso abre outro', async () => {
    const t = await ativar(loja1, await criarCaixa(loja1, 31));
    const segredo = randomBytes(32).toString('base64url');
    const renovacao = await amb
      .http()
      .post('/sync/token/renovar')
      .set(cabecalhos(t.token))
      .send({ novo_token_hash: createHash('sha256').update(segredo).digest('hex'), requisicao_id: uuidv7() });
    expect(renovacao.status, JSON.stringify(renovacao.body)).toBe(200);
    const estado = (token: string) => amb.http().get('/sync/estado').set(cabecalhos(token));
    expect((await estado(`${t.id}.${segredo}`)).status).toBe(200);
    await consultar(
      amb.bancoControle,
      `update terminais_pdv set token_atual_usado_em = now() - interval '1 minute' where id = $1`,
      [t.id],
    );
    expect((await estado(t.token)).status).toBe(200);

    const lista = (await erp().get('/api/terminais')).body as ListagemTerminais;
    const alerta = lista.alertas.find(
      (a) => a.tipo === ALERTA_TOKEN_ANTERIOR_REUTILIZADO && a.terminalId === t.id,
    );
    expect(alerta).toMatchObject({ severidade: 'critico' });
    const det = (await erp().get(`/api/terminais/${t.id}`)).body as TerminalDetalhe;
    expect(det.alertas.map((a) => a.id)).toEqual([alerta!.id]);
    expect(det.historico.map((h) => h.titulo)).toContain('Token anterior reutilizado');
    // O gerente da loja também vê (a listagem filtra pelas lojas permitidas).
    expect(
      (await erp(tokenGerente).get('/api/terminais')).body.alertas.some(
        (a: { id: string }) => a.id === alerta!.id,
      ),
    ).toBe(true);

    const resolver = (corpo: object, alertaId = alerta!.id) =>
      erp().post(`/api/terminais/${t.id}/alertas/${alertaId}/resolver`, corpo);
    expect((await resolver({ resolucao: '' })).status).toBe(422);
    const r = await resolver({ resolucao: 'Máquina do caixa conferida: restauração de backup, sem cópia' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as TerminalDetalhe).alertas).toEqual([]);
    expect((r.body as TerminalDetalhe).historico.map((h) => h.titulo)).toContain('Alerta resolvido');
    const [linha] = await consultar<{ resolvido_por_id: string | null; resolucao: string }>(
      emp.nomeBanco,
      'select resolvido_por_id, resolucao from alertas where id = $1',
      [alerta!.id],
    );
    expect(linha!.resolvido_por_id).not.toBeNull();
    expect(linha!.resolucao).toContain('sem cópia');
    // Repetir não muda nada; o próximo uso do anterior abre outro alerta.
    expect((await resolver({ resolucao: 'de novo' })).status).toBe(200);
    expect((await estado(t.token)).status).toBe(200);
    const depois = (await erp().get(`/api/terminais/${t.id}`)).body as TerminalDetalhe;
    expect(depois.alertas).toHaveLength(1);
    expect(depois.alertas[0]!.id).not.toBe(alerta!.id);
  });

  it('alertas que fecham sozinhos não se resolvem por aqui; alerta de outro terminal → 404', async () => {
    const t = await ativar(loja1, await criarCaixa(loja1, 32));
    const [d20] = await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into alertas (tipo, severidade, titulo, loja_id, entidade, registro_id)
       values ('TERMINAL_DESATIVADO_COM_EVENTOS', 'critico', 'D20 de teste', $1, 'terminais', $2) returning id`,
      [loja1, t.id],
    );
    const url = (terminalId: string) => `/api/terminais/${terminalId}/alertas/${d20!.id}/resolver`;
    expect((await erp().post(url(t.id), { resolucao: 'tentativa' })).status).toBe(422);
    const outro = await ativar(loja1, await criarCaixa(loja1, 33));
    expect((await erp().post(url(outro.id), { resolucao: 'tentativa' })).status).toBe(404);
  });
});

describe('força bruta: o alerta fecha quando o bloqueio cai sozinho (SYNC 3.1)', () => {
  it('sem "Liberar ativações", a manutenção fecha o alerta depois de 1 h; um bloqueio novo abre outro', async () => {
    const bloquear = async () => {
      for (let i = 0; i < 19; i++) {
        await consultar(
          amb.bancoControle,
          "insert into tentativas_ativacao (ip, codigo_empresa, sucesso, motivo_falha) values ('10.9.9.8', $1, false, 'codigo_invalido')",
          [emp.codigo],
        );
      }
      const r = await amb.http().post('/sync/ativar').set(cabecalhos()).send(corpoAtivacao('ZZZZZZZZ'));
      expect(r.status).toBe(422);
    };
    const abertos = async () =>
      consultar<{ id: string }>(
        emp.nomeBanco,
        "select id from alertas where tipo = 'ATIVACAO_FORCA_BRUTA' and resolvido_em is null",
      );
    await bloquear();
    expect(await abertos()).toHaveLength(1);
    expect((await amb.servicos.manutencaoTerminais.executar()).alertasForcaBrutaResolvidos).toBe(0);

    // Uma hora depois (simulada) o bloqueio caiu sozinho.
    await consultar(
      amb.bancoControle,
      "update tentativas_ativacao set criado_em = criado_em - interval '2 hours' where codigo_empresa = $1",
      [emp.codigo],
    );
    expect((await erp().get('/api/terminais/ativacoes')).body.bloqueio.bloqueado).toBe(false);
    expect((await amb.servicos.manutencaoTerminais.executar()).alertasForcaBrutaResolvidos).toBe(1);
    expect(await abertos()).toHaveLength(0);
    const [r] = await consultar(
      emp.nomeBanco,
      "select resolucao from alertas where tipo = 'ATIVACAO_FORCA_BRUTA' order by criado_em desc limit 1",
    );
    expect(r).toEqual({ resolucao: 'O bloqueio de 1 h expirou sem novas falhas' });

    await bloquear();
    expect(await abertos()).toHaveLength(1);
  });
});
