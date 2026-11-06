import { MENSAGEM_CREDENCIAIS_INVALIDAS } from '@genesis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consultar, criarAmbiente, SENHA_TESTE, type Ambiente, type EmpresaTeste } from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;

function cookieRefresh(res: { headers: Record<string, unknown> }): string | undefined {
  const lista = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  const c = lista.find((x) => x.startsWith('genesis_refresh='));
  return c?.split(';')[0];
}

beforeAll(async () => {
  amb = await criarAmbiente({ env: { LOGIN_MAX_TENTATIVAS: '5', LOGIN_BLOQUEIO_MINUTOS: '15' } });
  emp = await amb.criarEmpresa();
});

afterAll(async () => {
  await amb?.fechar();
});

describe('login do ERP (ERP 4)', () => {
  it('senha provisória: login exige troca antes de qualquer outra rota', async () => {
    const r = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: String(emp.codigo), login: 'ADMIN', senha: emp.senha });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      trocarSenha: true,
      empresa: { codigo: emp.codigo },
      usuario: { login: 'admin', master: true },
    });
    const cookie = cookieRefresh(r);
    expect(cookie).toMatch(new RegExp(`^genesis_refresh=${emp.codigo}\\.`));
    const setCookie = (r.headers['set-cookie'] as unknown as string[]).join(';');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/);

    const token = r.body.tokenAcesso as string;
    const bloqueada = await amb.http().get('/api/lojas').set('Authorization', `Bearer ${token}`);
    expect(bloqueada.status).toBe(403);
    expect(bloqueada.body.codigo).toBe('TROCA_SENHA_OBRIGATORIA');

    const eu = await amb.http().get('/api/auth/eu').set('Authorization', `Bearer ${token}`);
    expect(eu.status).toBe(200);
    expect(eu.body.usuario.senhaProvisoria).toBe(true);

    const fraca = await amb
      .http()
      .post('/api/auth/trocar-senha')
      .set('Authorization', `Bearer ${token}`)
      .send({ senhaAtual: emp.senha, novaSenha: 'curta' });
    expect(fraca.status).toBe(422);
    expect(fraca.body.codigo).toBe('VALIDACAO');
    expect(fraca.body.campos.novaSenha).toBeDefined();

    const errada = await amb
      .http()
      .post('/api/auth/trocar-senha')
      .set('Authorization', `Bearer ${token}`)
      .send({ senhaAtual: 'naoEhEssa1', novaSenha: SENHA_TESTE });
    expect(errada.status).toBe(422);

    const t = await amb
      .http()
      .post('/api/auth/trocar-senha')
      .set('Authorization', `Bearer ${token}`)
      .send({ senhaAtual: emp.senha, novaSenha: SENHA_TESTE });
    expect(t.status).toBe(200);
    expect(t.body.trocarSenha).toBe(false);
    const liberada = await amb.http().get('/api/lojas').set('Authorization', `Bearer ${t.body.tokenAcesso}`);
    expect(liberada.status).toBe(200);
    expect(liberada.body).toEqual({ itens: [], total: 0, pagina: 1, tamanho: 20 });

    const [u] = await consultar(
      emp.nomeBanco,
      "select senha_provisoria, senha_alterada_em is not null as alterada from usuarios where login = 'admin'",
    );
    expect(u).toEqual({ senha_provisoria: false, alterada: true });
    const acoes = await consultar<{ acao: string }>(
      emp.nomeBanco,
      "select acao from auditoria where acao in ('login','senha_alterada') order by ocorrido_em",
    );
    expect(acoes.map((a) => a.acao)).toEqual(['login', 'senha_alterada']);
  });

  it('erro genérico: empresa, usuário ou senha errados dão a mesma resposta; tentativa negada é auditada', async () => {
    const casos = [
      { codigoEmpresa: 999999, login: 'admin', senha: SENHA_TESTE },
      { codigoEmpresa: emp.codigo, login: 'nao_existe', senha: SENHA_TESTE },
      { codigoEmpresa: emp.codigo, login: 'admin', senha: 'errada123' },
    ];
    for (const corpo of casos) {
      const r = await amb.http().post('/api/auth/login').send(corpo);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ codigo: 'NAO_AUTENTICADO', mensagem: MENSAGEM_CREDENCIAIS_INVALIDAS });
      expect(Object.keys(r.body).sort()).toEqual(['codigo', 'mensagem', 'requisicao_id']);
    }
    const negados = await consultar<{
      registro_id: string | null;
      descricao: string;
      requisicao_id: string | null;
    }>(
      emp.nomeBanco,
      "select registro_id, descricao, requisicao_id from auditoria where acao = 'login_negado' order by ocorrido_em",
    );
    expect(negados).toHaveLength(2);
    expect(negados[0]!.registro_id).toBeNull();
    expect(negados[1]!.descricao).toContain('senha_invalida');
    expect(negados[1]!.requisicao_id).toMatch(/^[0-9a-f-]{36}$/);
    const historico = await consultar(
      emp.nomeBanco,
      'select login_informado, sucesso, motivo_falha from historico_logins where not sucesso order by ocorrido_em',
    );
    expect(historico).toEqual([
      { login_informado: 'nao_existe', sucesso: false, motivo_falha: 'senha_invalida' },
      { login_informado: 'admin', sucesso: false, motivo_falha: 'senha_invalida' },
    ]);
    const [u] = await consultar(
      emp.nomeBanco,
      "select tentativas_falhas from usuarios where login = 'admin'",
    );
    expect(u).toEqual({ tentativas_falhas: 1 });
  });

  it('login correto zera as tentativas; 5 falhas seguidas bloqueiam mesmo com a senha certa', async () => {
    const ok = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    expect(ok.status).toBe(200);
    for (let i = 0; i < 5; i++) {
      const r = await amb
        .http()
        .post('/api/auth/login')
        .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: `errada${i}xx` });
      expect(r.status).toBe(401);
    }
    const bloqueado = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    expect(bloqueado.status).toBe(401);
    expect(bloqueado.body.mensagem).toMatch(/bloqueado temporariamente. Tente em 1[45] minutos/);
    const [b] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where acao = 'bloqueio'",
    );
    expect(b).toEqual({ n: 1 });
    await consultar(emp.nomeBanco, "update usuarios set bloqueado_ate = null where login = 'admin'");
    const depois = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    expect(depois.status).toBe(200);
  });

  it('refresh rotativo: cada uso troca o token; reuso do antigo derruba todas as sessões', async () => {
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    const c1 = cookieRefresh(login)!;
    const r1 = await amb.http().post('/api/auth/refresh').set('Cookie', c1);
    expect(r1.status).toBe(200);
    const c2 = cookieRefresh(r1)!;
    expect(c2).not.toBe(c1);
    const eu = await amb.http().get('/api/auth/eu').set('Authorization', `Bearer ${r1.body.tokenAcesso}`);
    expect(eu.status).toBe(200);

    // Repetição imediata (requisições simultâneas): recusada sem derrubar a família nem apagar o cookie novo.
    const repetido = await amb.http().post('/api/auth/refresh').set('Cookie', c1);
    expect(repetido.status).toBe(409);
    expect(repetido.body.codigo).toBe('REFRESH_CONCORRENTE');
    expect(repetido.headers['set-cookie']).toBeUndefined();
    // Fora da janela de tolerância é reuso (roubo provável).
    await consultar(
      emp.nomeBanco,
      "update sessoes_usuario set encerrada_em = encerrada_em - interval '5 minutes' where motivo_encerramento = 'rotacionada'",
    );
    const reuso = await amb.http().post('/api/auth/refresh').set('Cookie', c1);
    expect(reuso.status).toBe(401);
    const depoisReuso = await amb.http().post('/api/auth/refresh').set('Cookie', c2);
    expect(depoisReuso.status).toBe(401);
    // Os tokens de acesso da família derrubada deixam de valer, inclusive o do login (sessão já rotacionada).
    const acesso = await amb.http().get('/api/auth/eu').set('Authorization', `Bearer ${r1.body.tokenAcesso}`);
    expect(acesso.status).toBe(401);
    const doLogin = await amb
      .http()
      .get('/api/auth/eu')
      .set('Authorization', `Bearer ${login.body.tokenAcesso}`);
    expect(doLogin.status).toBe(401);
    const abertas = await consultar(
      emp.nomeBanco,
      'select count(*)::int as n from sessoes_usuario where encerrada_em is null',
    );
    expect(abertas).toEqual([{ n: 0 }]);
    const [m] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from sessoes_usuario where motivo_encerramento = 'reuso_detectado'",
    );
    expect(m!.n).toBeGreaterThan(0);
  });

  it('refresh simultâneo com o mesmo cookie: um vence, os outros recebem 409 e nada é derrubado', async () => {
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    const c = cookieRefresh(login)!;
    const respostas = await Promise.all(
      Array.from({ length: 3 }, () => amb.http().post('/api/auth/refresh').set('Cookie', c)),
    );
    expect(respostas.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const venceu = respostas.find((r) => r.status === 200)!;
    expect((await amb.http().post('/api/auth/refresh').set('Cookie', cookieRefresh(venceu)!)).status).toBe(
      200,
    );
  });

  it('token de acesso de antes da rotação deixa de valer com o logout', async () => {
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    const r1 = await amb.http().post('/api/auth/refresh').set('Cookie', cookieRefresh(login)!);
    const bearer = { Authorization: `Bearer ${login.body.tokenAcesso}` };
    expect((await amb.http().get('/api/auth/eu').set(bearer)).status).toBe(200);
    expect((await amb.http().post('/api/auth/logout').set('Cookie', cookieRefresh(r1)!)).status).toBe(204);
    expect((await amb.http().get('/api/auth/eu').set(bearer)).status).toBe(401);
  });

  it('inatividade: 60 min sem requisição encerram a sessão; o refresh não conta como uso', async () => {
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    const sid = async () =>
      (
        await consultar<{ id: string }>(
          emp.nomeBanco,
          'select id from sessoes_usuario where encerrada_em is null order by criado_em desc limit 1',
        )
      )[0]!.id;
    // Uso real há 50 min: o refresh renova o token mas herda a última atividade.
    await consultar(
      emp.nomeBanco,
      "update sessoes_usuario set ultimo_uso_em = now() - interval '50 minutes' where id = $1",
      [await sid()],
    );
    const r1 = await amb.http().post('/api/auth/refresh').set('Cookie', cookieRefresh(login)!);
    expect(r1.status).toBe(200);
    const [herdado] = await consultar<{ minutos: number }>(
      emp.nomeBanco,
      'select round(extract(epoch from now() - ultimo_uso_em) / 60)::int as minutos from sessoes_usuario where id = $1',
      [await sid()],
    );
    expect(herdado!.minutos).toBe(50);
    // Uma requisição real grava a atividade.
    const bearer = { Authorization: `Bearer ${r1.body.tokenAcesso}` };
    expect((await amb.http().get('/api/auth/eu').set(bearer)).status).toBe(200);
    const [agora] = await consultar<{ minutos: number }>(
      emp.nomeBanco,
      'select round(extract(epoch from now() - ultimo_uso_em) / 60)::int as minutos from sessoes_usuario where id = $1',
      [await sid()],
    );
    expect(agora!.minutos).toBe(0);
    // 61 min sem requisição: token de acesso e refresh recusados.
    const aberta = await sid();
    await consultar(
      emp.nomeBanco,
      "update sessoes_usuario set ultimo_uso_em = now() - interval '61 minutes' where id = $1",
      [aberta],
    );
    expect((await amb.http().get('/api/auth/eu').set(bearer)).status).toBe(401);
    expect((await amb.http().post('/api/auth/refresh').set('Cookie', cookieRefresh(r1)!)).status).toBe(401);
    const [m] = await consultar(
      emp.nomeBanco,
      'select motivo_encerramento as m from sessoes_usuario where id = $1',
      [aberta],
    );
    expect(m).toEqual({ m: 'expirada' });
  });

  it('logins errados em paralelo: o bloqueio vale para quem chega depois, mesmo com a senha certa', async () => {
    const outra = await amb.criarEmpresa();
    await amb.entrar(outra.codigo, 'admin', outra.senha);
    const tentativa = (senha: string) =>
      amb.http().post('/api/auth/login').send({ codigoEmpresa: outra.codigo, login: 'admin', senha });
    const erradas = await Promise.all(Array.from({ length: 12 }, (_, i) => tentativa(`errada-${i}-x1`)));
    expect(erradas.every((r) => r.status === 401)).toBe(true);
    const [u] = await consultar<{ bloqueado: boolean }>(
      outra.nomeBanco,
      "select bloqueado_ate > now() as bloqueado from usuarios where login = 'admin'",
    );
    expect(u).toEqual({ bloqueado: true });
    const certa = await tentativa(SENHA_TESTE);
    expect(certa.status).toBe(401);
    expect(certa.body.mensagem).toMatch(/bloqueado temporariamente/);
  });

  it('troca de senha: senha atual errada conta como tentativa e bloqueia', async () => {
    const outra = await amb.criarEmpresa();
    const token = await amb.entrar(outra.codigo, 'admin', outra.senha);
    const trocar = (senhaAtual: string) =>
      amb
        .http()
        .post('/api/auth/trocar-senha')
        .set('Authorization', `Bearer ${token}`)
        .send({ senhaAtual, novaSenha: 'OutraSenha123' });
    for (let i = 0; i < 4; i++) expect((await trocar(`errada${i}xx1`)).status).toBe(422);
    const quinta = await trocar('errada5xx1');
    expect(quinta.status).toBe(401);
    expect(quinta.body.mensagem).toMatch(/bloqueado temporariamente/);
    // Bloqueado, nem a senha atual certa troca (e o login também é recusado).
    expect((await trocar(SENHA_TESTE)).status).toBe(401);
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: outra.codigo, login: 'admin', senha: SENHA_TESTE });
    expect(login.status).toBe(401);
  });

  it('logout encerra a sessão, limpa o cookie e é auditado', async () => {
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'admin', senha: SENHA_TESTE });
    const c = cookieRefresh(login)!;
    const sair = await amb.http().post('/api/auth/logout').set('Cookie', c);
    expect(sair.status).toBe(204);
    expect(String(sair.headers['set-cookie'])).toMatch(/genesis_refresh=;/);
    expect((await amb.http().post('/api/auth/refresh').set('Cookie', c)).status).toBe(401);
    expect(
      (await amb.http().get('/api/auth/eu').set('Authorization', `Bearer ${login.body.tokenAcesso}`)).status,
    ).toBe(401);
    const [n] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where acao = 'logout'",
    );
    expect(n!.n).toBeGreaterThanOrEqual(1);
  });

  it('token inválido, ausente ou de outra audiência → 401 com envelope padrão', async () => {
    const semToken = await amb.http().get('/api/auth/eu');
    expect(semToken.status).toBe(401);
    expect(semToken.body.codigo).toBe('NAO_AUTENTICADO');
    expect((await amb.http().get('/api/auth/eu').set('Authorization', 'Bearer abc.def.ghi')).status).toBe(
      401,
    );
    expect(semToken.headers['x-requisicao-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('valida a entrada com o schema compartilhado (422 com campos)', async () => {
    const r = await amb.http().post('/api/auth/login').send({ codigoEmpresa: '12', login: '', senha: '' });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos).sort()).toEqual(['codigoEmpresa', 'login', 'senha']);
  });
});

describe('limite de taxa no login', () => {
  let pequeno: Ambiente;
  let porConta: Ambiente;
  beforeAll(async () => {
    pequeno = await criarAmbiente({ env: { LOGIN_LIMITE_POR_MINUTO: '3' } });
    porConta = await criarAmbiente({ env: { LOGIN_LIMITE_POR_CONTA_MINUTO: '3' } });
  });
  afterAll(async () => {
    await porConta?.fechar();
  });

  it('limite por código+login (ERP 4.1): a conta para de aceitar tentativas, as outras seguem', async () => {
    const alvo = { codigoEmpresa: 999998, login: 'admin', senha: 'y' };
    for (let i = 0; i < 3; i++)
      expect((await porConta.http().post('/api/auth/login').send(alvo)).status).toBe(401);
    // Mesma conta (maiúsculas não importam) → 429; outra conta do mesmo IP continua com 401.
    const r = await porConta
      .http()
      .post('/api/auth/login')
      .send({ ...alvo, login: 'ADMIN' });
    expect(r.status).toBe(429);
    expect(
      (
        await porConta
          .http()
          .post('/api/auth/login')
          .send({ ...alvo, login: 'outro' })
      ).status,
    ).toBe(401);
  });
  afterAll(async () => {
    await pequeno?.fechar();
  });

  it('acima do limite por IP responde 429 LIMITE_TAXA com Retry-After', async () => {
    const corpo = { codigoEmpresa: 999999, login: 'x', senha: 'y' };
    for (let i = 0; i < 3; i++)
      expect((await pequeno.http().post('/api/auth/login').send(corpo)).status).toBe(401);
    const r = await pequeno.http().post('/api/auth/login').send(corpo);
    expect(r.status).toBe(429);
    expect(r.body.codigo).toBe('LIMITE_TAXA');
    expect(r.headers['retry-after']).toBeDefined();
    expect((await pequeno.http().get('/saude')).status).toBe(200);
  });
});
