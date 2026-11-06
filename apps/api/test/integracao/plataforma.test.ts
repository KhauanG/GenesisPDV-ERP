import { completarCnpj } from '@genesis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { AAD_TOTP } from '../../src/plataforma/admin-auth.service.js';
import { gerarCodigoTotp } from '../../src/seguranca/totp.js';
import { consultar, criarAmbiente, SENHA_TESTE, type Ambiente } from './ambiente.js';

let amb: Ambiente;
let superadmin: { email: string; senha: string; totp: string };
let leitor: { email: string; senha: string; totp: string };

/**
 * Código TOTP ainda não usado por este segredo: o mesmo passo de 30 s não vale duas vezes (proteção contra
 * repetição), então o segundo login na mesma janela usa o código do passo seguinte (aceito pela tolerância).
 */
const ultimoPasso = new Map<string, number>();
async function codigoNovo(segredo: string): Promise<string> {
  const atual = Math.floor(Date.now() / 30_000);
  const passo = Math.max(atual, (ultimoPasso.get(segredo) ?? -1) + 1);
  if (passo > atual + 1) throw new Error('Mais de dois logins do mesmo admin na mesma janela TOTP');
  ultimoPasso.set(segredo, passo);
  return gerarCodigoTotp(segredo, passo - atual);
}

const tokens = new Map<string, string>();
async function loginPlataforma(a: { email: string; senha: string; totp: string }) {
  return amb
    .http()
    .post('/api/plataforma/auth/login')
    .send({ email: a.email, senha: a.senha, codigoTotp: await codigoNovo(a.totp) });
}

/** Token de acesso do admin (um login por arquivo; o token vale 15 min). */
async function entrarPlataforma(a: { email: string; senha: string; totp: string }): Promise<string> {
  const emCache = tokens.get(a.email);
  if (emCache) return emCache;
  const r = await loginPlataforma(a);
  if (r.status !== 200) throw new Error(`login plataforma: ${r.status} ${JSON.stringify(r.body)}`);
  tokens.set(a.email, r.body.tokenAcesso as string);
  return r.body.tokenAcesso as string;
}

const cookieDe = (r: { headers: Record<string, unknown> }) =>
  (r.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;

/** Admin novo para os testes que consomem códigos TOTP ou bloqueiam a conta. */
async function novoAdmin(nome: string) {
  const email = `${nome}@genesis.dev`;
  const senha = `senha-${nome}-123456`;
  const r = await amb.servicos.adminAuth.criarAdmin({ nome, email, papel: 'suporte', senha });
  return { email, senha, totp: r.totpSegredo, id: r.id };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  amb = await criarAmbiente();
  const s = await amb.servicos.adminAuth.criarAdmin({
    nome: 'Super',
    email: 'Super@Genesis.dev',
    papel: 'superadmin',
  });
  superadmin = { email: 'super@genesis.dev', senha: s.senha, totp: s.totpSegredo };
  const l = await amb.servicos.adminAuth.criarAdmin({
    nome: 'Leitor',
    email: 'leitor@genesis.dev',
    papel: 'somente_leitura',
    senha: 'senha-do-leitor-123',
  });
  leitor = { email: 'leitor@genesis.dev', senha: 'senha-do-leitor-123', totp: l.totpSegredo };
});

afterAll(async () => {
  await amb?.fechar();
});

describe('painel da plataforma (ERP 19)', () => {
  it('admin criado pelo CLI tem senha argon2id e TOTP cifrado (AES-256-GCM com AAD)', async () => {
    const [a] = await consultar<{ senha_hash: string; totp: Buffer; totp_ativo: boolean }>(
      amb.bancoControle,
      "select senha_hash, totp_segredo_cifrado as totp, totp_ativo from admins_plataforma where email = 'super@genesis.dev'",
    );
    expect(a!.senha_hash.startsWith('$argon2id$')).toBe(true);
    expect(a!.totp_ativo).toBe(true);
    expect(a!.totp.toString('utf8')).not.toContain(superadmin.totp);
    expect(amb.servicos.cifra.decifrarTexto(a!.totp, AAD_TOTP)).toBe(superadmin.totp);
  });

  it('login exige senha e código TOTP válidos; mensagem genérica; tudo auditado', async () => {
    const semTotp = await amb
      .http()
      .post('/api/plataforma/auth/login')
      .send({ email: superadmin.email, senha: superadmin.senha, codigoTotp: '000000' });
    expect(semTotp.status).toBe(401);
    const senhaErrada = await amb
      .http()
      .post('/api/plataforma/auth/login')
      .send({ email: superadmin.email, senha: 'errada', codigoTotp: await gerarCodigoTotp(superadmin.totp) });
    expect(senhaErrada.status).toBe(401);
    expect(senhaErrada.body.mensagem).toBe(semTotp.body.mensagem);
    const token = await entrarPlataforma(superadmin);
    const eu = await amb.http().get('/api/plataforma/auth/eu').set(bearer(token));
    expect(eu.body).toMatchObject({ email: superadmin.email, papel: 'superadmin' });
    const acoes = await consultar<{ acao: string; motivo: string | null }>(
      amb.bancoControle,
      "select acao, depois->>'motivo' as motivo from auditoria_plataforma where entidade = 'admins_plataforma' and acao like 'login%' order by criado_em",
    );
    expect(acoes).toEqual([
      { acao: 'login_negado', motivo: 'totp_invalido' },
      { acao: 'login_negado', motivo: 'senha_invalida' },
      { acao: 'login', motivo: null },
    ]);
  });

  it('migrações (ERP 19.7): situação para qualquer admin; simular e aplicar só superadmin/suporte', async () => {
    const token = await entrarPlataforma(superadmin);
    const e = await amb.criarEmpresa();
    const ultima = lerMigracoes(PASTA_MIGRACOES_EMPRESA).at(-1)!.tag;

    const tokenLeitor = await entrarPlataforma(leitor);
    const situacao = await amb.http().get('/api/plataforma/migracoes').set(bearer(tokenLeitor));
    expect(situacao.status).toBe(200);
    expect(situacao.body.versaoAtual).toBe(ultima);
    expect(situacao.body.empresas).toContainEqual(
      expect.objectContaining({ codigo: e.codigo, versaoSchema: ultima, situacao: 'em_dia', pendentes: [] }),
    );
    const filtrada = await amb
      .http()
      .get('/api/plataforma/migracoes?filtro=com_erro')
      .set(bearer(tokenLeitor));
    expect(filtrada.body.empresas.map((x: { codigo: number }) => x.codigo)).not.toContain(e.codigo);
    expect((await amb.http().get('/api/plataforma/migracoes?filtro=x').set(bearer(tokenLeitor))).status).toBe(
      422,
    );

    expect(
      (await amb.http().get(`/api/plataforma/migracoes/simular?codigo=${e.codigo}`).set(bearer(tokenLeitor)))
        .status,
    ).toBe(403);
    expect(
      (await amb.http().post('/api/plataforma/migracoes/aplicar').set(bearer(tokenLeitor)).send({})).status,
    ).toBe(403);

    const sim = await amb
      .http()
      .get(`/api/plataforma/migracoes/simular?codigo=${e.codigo}`)
      .set(bearer(token));
    expect(sim.status).toBe(200);
    expect(sim.body).toEqual({
      fonte: 'banco',
      empresas: [{ codigo: e.codigo, razaoSocial: expect.any(String), pendentes: [], alteradas: [] }],
      migracoes: [],
    });
    expect(
      (await amb.http().get('/api/plataforma/migracoes/simular?codigo=999999').set(bearer(token))).status,
    ).toBe(404);

    const aplicar = await amb
      .http()
      .post('/api/plataforma/migracoes/aplicar')
      .set(bearer(token))
      .send({ codigos: [e.codigo] });
    expect(aplicar.status).toBe(200);
    expect(aplicar.body).toMatchObject({ falhas: 0, interrompida: false });
    expect(aplicar.body.canarios).toEqual([
      expect.objectContaining({ codigo: e.codigo, status: 'ok', aplicadas: [] }),
    ]);
    const log = await amb.http().get('/api/plataforma/migracoes').set(bearer(token));
    expect(log.body.execucoes[0]).toMatchObject({ adminNome: 'Super', falhas: 0 });
  });

  it('token do ERP não serve no painel e o da plataforma não serve no ERP', async () => {
    const token = await entrarPlataforma(superadmin);
    expect((await amb.http().get('/api/auth/eu').set(bearer(token))).status).toBe(401);
    const e = await amb.criarEmpresa();
    const tokenErp = await amb.entrar(e.codigo, 'admin', e.senha);
    expect((await amb.http().get('/api/plataforma/empresas').set(bearer(tokenErp))).status).toBe(401);
  });

  it('cria empresa pelo painel (senha provisória uma vez), lista, suspende e reativa, com auditoria', async () => {
    const token = await entrarPlataforma(superadmin);
    const planos = await amb.http().get('/api/plataforma/planos').set(bearer(token));
    expect(planos.status).toBe(200);
    expect(planos.body.itens.map((p: { codigo: string }) => p.codigo)).toContain('padrao');

    const cnpj = completarCnpj('12ABC34501DE');
    const criada = await amb.http().post('/api/plataforma/empresas').set(bearer(token)).send({
      razaoSocial: 'Ice Beer Comércio de Bebidas Ltda',
      nomeFantasia: 'Ice Beer',
      cnpj,
      planoCodigo: 'padrao',
      regime: 'simples_nacional',
    });
    expect(criada.status).toBe(201);
    expect(criada.body).toMatchObject({ status: 'ativa', adminLogin: 'admin' });
    expect(criada.body.senhaProvisoria).toMatch(/^[A-Za-z0-9]{12}$/);
    const codigo = criada.body.codigo as number;

    const lista = await amb.http().get(`/api/plataforma/empresas?busca=${codigo}`).set(bearer(token));
    expect(lista.body.itens).toHaveLength(1);
    expect(lista.body.itens[0]).toMatchObject({
      codigo,
      cnpj,
      status: 'ativa',
      plano: 'padrao',
      migracaoComFalha: false,
    });
    const detalhe = await amb.http().get(`/api/plataforma/empresas/${codigo}`).set(bearer(token));
    expect(detalhe.body.migracoes).toHaveLength(lerMigracoes(PASTA_MIGRACOES_EMPRESA).length);

    const tokenErp = await amb.entrar(codigo, 'admin', criada.body.senhaProvisoria);
    const suspensa = await amb
      .http()
      .post(`/api/plataforma/empresas/${codigo}/suspender`)
      .set(bearer(token))
      .send({ motivo: 'inadimplência' });
    expect(suspensa.body).toEqual({ codigo, status: 'suspensa', motivoStatus: 'inadimplência' });
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: codigo, login: 'admin', senha: SENHA_TESTE });
    expect(login.status).toBe(403);
    expect(login.body.codigo).toBe('EMPRESA_SUSPENSA');
    expect((await amb.http().get('/api/auth/eu').set(bearer(tokenErp))).status).toBe(403);
    expect(
      (
        await amb
          .http()
          .post(`/api/plataforma/empresas/${codigo}/suspender`)
          .set(bearer(token))
          .send({ motivo: 'de novo' })
      ).status,
    ).toBe(422);

    const reativada = await amb.http().post(`/api/plataforma/empresas/${codigo}/reativar`).set(bearer(token));
    expect(reativada.body.status).toBe('ativa');
    expect(
      (
        await amb
          .http()
          .post('/api/auth/login')
          .send({ codigoEmpresa: codigo, login: 'admin', senha: SENHA_TESTE })
      ).status,
    ).toBe(200);

    const acoes = await consultar<{ acao: string; admin: boolean }>(
      amb.bancoControle,
      'select a.acao, a.admin_id is not null as admin from auditoria_plataforma a join empresas e on e.id = a.empresa_id where e.codigo = $1 order by a.criado_em',
      [codigo],
    );
    expect(acoes).toEqual([
      { acao: 'empresa_criada', admin: true },
      { acao: 'empresa_provisionada', admin: true },
      { acao: 'empresa_suspensa', admin: true },
      { acao: 'empresa_reativada', admin: true },
    ]);
  });

  it('papel somente_leitura consulta mas não cria nem suspende', async () => {
    const token = await entrarPlataforma(leitor);
    expect((await amb.http().get('/api/plataforma/empresas').set(bearer(token))).status).toBe(200);
    const criar = await amb.http().post('/api/plataforma/empresas').set(bearer(token)).send({});
    expect(criar.status).toBe(403);
    expect(criar.body.codigo).toBe('SEM_PERMISSAO');
    expect(
      (
        await amb
          .http()
          .post('/api/plataforma/empresas/100001/suspender')
          .set(bearer(token))
          .send({ motivo: 'teste' })
      ).status,
    ).toBe(403);
  });

  it('validação de entrada na criação (CNPJ, plano) e sem token → 401', async () => {
    const token = await entrarPlataforma(superadmin);
    const r = await amb
      .http()
      .post('/api/plataforma/empresas')
      .set(bearer(token))
      .send({ razaoSocial: 'X', cnpj: '123', planoCodigo: '' });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos)).toEqual(
      expect.arrayContaining(['cnpj', 'razaoSocial', 'planoCodigo']),
    );
    expect((await amb.http().get('/api/plataforma/empresas')).status).toBe(401);
  });

  it('refresh da plataforma rotaciona o token e logout encerra a sessão e os tokens de acesso dela', async () => {
    const r = await loginPlataforma(leitor);
    const cookie = cookieDe(r);
    expect(cookie).toMatch(/^genesis_refresh_plataforma=/);
    const r2 = await amb.http().post('/api/plataforma/auth/refresh').set('Cookie', cookie);
    expect(r2.status).toBe(200);
    // Repetição imediata do cookie antigo (dentro da tolerância): recusada sem derrubar a sessão nova.
    const repetido = await amb.http().post('/api/plataforma/auth/refresh').set('Cookie', cookie);
    expect(repetido.status).toBe(409);
    expect(repetido.body.codigo).toBe('REFRESH_CONCORRENTE');
    const cookie2 = cookieDe(r2);
    const tokenLogin = r.body.tokenAcesso as string;
    expect((await amb.http().get('/api/plataforma/auth/eu').set(bearer(tokenLogin))).status).toBe(200);
    expect((await amb.http().post('/api/plataforma/auth/logout').set('Cookie', cookie2)).status).toBe(204);
    expect((await amb.http().post('/api/plataforma/auth/refresh').set('Cookie', cookie2)).status).toBe(401);
    // Depois do logout nenhum token de acesso da família vale (nem o do login, de antes da rotação).
    expect((await amb.http().get('/api/plataforma/auth/eu').set(bearer(tokenLogin))).status).toBe(401);
    expect(
      (
        await amb
          .http()
          .get('/api/plataforma/auth/eu')
          .set(bearer(r2.body.tokenAcesso as string))
      ).status,
    ).toBe(401);
  });

  it('refresh simultâneo com o mesmo cookie não bifurca a sessão; reuso fora da janela derruba tudo', async () => {
    const a = await novoAdmin('paralelo');
    const login = await loginPlataforma(a);
    const cookie = cookieDe(login);
    const respostas = await Promise.all(
      Array.from({ length: 4 }, () => amb.http().post('/api/plataforma/auth/refresh').set('Cookie', cookie)),
    );
    const status = respostas.map((x) => x.status).sort();
    expect(status).toEqual([200, 409, 409, 409]);
    const venceu = respostas.find((x) => x.status === 200)!;
    const [abertas] = await consultar<{ n: number }>(
      amb.bancoControle,
      'select count(*)::int as n from sessoes_admin where admin_id = $1 and encerrada_em is null',
      [a.id],
    );
    expect(abertas!.n).toBe(1);

    // Cookie antigo reaparece depois da janela de tolerância: roubo provável.
    await consultar(
      amb.bancoControle,
      "update sessoes_admin set encerrada_em = encerrada_em - interval '5 minutes' where admin_id = $1 and motivo_encerramento = 'rotacionada'",
      [a.id],
    );
    expect((await amb.http().post('/api/plataforma/auth/refresh').set('Cookie', cookie)).status).toBe(401);
    expect(
      (await amb.http().post('/api/plataforma/auth/refresh').set('Cookie', cookieDe(venceu))).status,
    ).toBe(401);
    expect(
      (
        await amb
          .http()
          .get('/api/plataforma/auth/eu')
          .set(bearer(venceu.body.tokenAcesso as string))
      ).status,
    ).toBe(401);
    const [aud] = await consultar(
      amb.bancoControle,
      "select count(*)::int as n from auditoria_plataforma where admin_id = $1 and acao = 'token_anterior_reutilizado'",
      [a.id],
    );
    expect(aud).toEqual({ n: 1 });
  });

  it('o mesmo código TOTP não serve duas vezes', async () => {
    const a = await novoAdmin('repeticao');
    const codigo = await gerarCodigoTotp(a.totp);
    const corpo = { email: a.email, senha: a.senha, codigoTotp: codigo };
    expect((await amb.http().post('/api/plataforma/auth/login').send(corpo)).status).toBe(200);
    expect((await amb.http().post('/api/plataforma/auth/login').send(corpo)).status).toBe(401);
  });

  it('tentativas erradas em paralelo contam todas e bloqueiam a conta', async () => {
    const a = await novoAdmin('forcabruta');
    const respostas = await Promise.all(
      Array.from({ length: 12 }, async (_, i) =>
        amb
          .http()
          .post('/api/plataforma/auth/login')
          .send({ email: a.email, senha: a.senha, codigoTotp: String(100000 + i) }),
      ),
    );
    expect(respostas.every((x) => x.status === 401)).toBe(true);
    const [linha] = await consultar<{ bloqueado: boolean }>(
      amb.bancoControle,
      'select bloqueado_ate > now() as bloqueado from admins_plataforma where id = $1',
      [a.id],
    );
    expect(linha).toEqual({ bloqueado: true });
    // Bloqueada, nem a senha e o código certos entram.
    const certo = await loginPlataforma(a);
    expect(certo.status).toBe(401);
    expect(certo.body.mensagem).toMatch(/bloqueado/);
  });

  it('inatividade do painel é medida pela última requisição, não pelo refresh', async () => {
    const a = await novoAdmin('inativo');
    const login = await loginPlataforma(a);
    await consultar(
      amb.bancoControle,
      "update sessoes_admin set ultimo_uso_em = now() - interval '31 minutes' where admin_id = $1",
      [a.id],
    );
    expect(
      (await amb.http().post('/api/plataforma/auth/refresh').set('Cookie', cookieDe(login))).status,
    ).toBe(401);
    expect(
      (
        await amb
          .http()
          .get('/api/plataforma/auth/eu')
          .set(bearer(login.body.tokenAcesso as string))
      ).status,
    ).toBe(401);
  });
});
