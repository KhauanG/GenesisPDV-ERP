import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let loja1: string;
let loja2: string;
let tokenAdmin: string;
let perfilGerente: string;
let perfilVendedor: string;
let perfilAdministrador: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const perfis = await consultar<{ id: string; chave_sistema: string }>(
    emp.nomeBanco,
    'select id, chave_sistema from perfis',
  );
  const id = (c: string) => perfis.find((p) => p.chave_sistema === c)!.id;
  perfilGerente = id('gerente');
  perfilVendedor = id('vendedor');
  perfilAdministrador = id('administrador');
});

afterAll(async () => {
  await amb?.fechar();
});

describe('GET /api/perfis', () => {
  it('lista os perfis do seed com a quantidade de usuários', async () => {
    const r = await amb.http().get('/api/perfis?tamanho=todos').set(bearer(tokenAdmin));
    expect(r.status).toBe(200);
    // Os 7 de sempre + o Encarregado (decisão 66 do README do PDV).
    expect(r.body.total).toBe(8);
    expect(r.body.itens.map((p: { nome: string }) => p.nome)).toContain('Gerente');
    expect(r.body.itens.map((p: { nome: string }) => p.nome)).toContain('Encarregado');
    expect(r.body.itens.every((p: { usuarios: number }) => typeof p.usuarios === 'number')).toBe(true);
  });
});

describe('cadastro de usuários (ERP 11.1, 11.2)', () => {
  it('cria com senha provisória exibida uma vez, lojas permitidas e auditoria sem a senha', async () => {
    const r = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(tokenAdmin))
      .send({
        nome: 'Maria Gerente',
        login: ' Maria ',
        perfilId: perfilGerente,
        lojas: [loja1],
        limiteDescontoPct: 10,
        cpf: '529.982.247-25',
      });
    expect(r.status).toBe(201);
    expect(r.body.senhaProvisoria).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(r.body.usuario).toMatchObject({
      nome: 'Maria Gerente',
      login: 'maria',
      perfilNome: 'Gerente',
      lojas: [loja1],
      limiteDescontoPct: '10.0000',
      cpf: '52998224725',
      senhaProvisoria: true,
      ativo: true,
    });
    expect(r.body.usuario.senhaHash).toBeUndefined();

    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'maria', senha: r.body.senhaProvisoria });
    expect(login.status).toBe(200);
    expect(login.body.trocarSenha).toBe(true);

    const [aud] = await consultar(
      emp.nomeBanco,
      "select depois->>'senhaHash' as hash, usuario_nome from auditoria where entidade = 'usuarios' and acao = 'criar' and registro_id = $1",
      [r.body.usuario.id],
    );
    expect(aud).toEqual({ hash: '***', usuario_nome: 'ADMINISTRADOR' });
  });

  it('valida campos (422) e login/CPF duplicados (409 CONFLITO com o campo)', async () => {
    const invalido = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(tokenAdmin))
      .send({ nome: '', login: 'com espaco', cpf: '111.111.111-11', lojas: [loja1] });
    expect(invalido.status).toBe(422);
    expect(Object.keys(invalido.body.campos).sort()).toEqual(['cpf', 'login', 'nome', 'perfilId']);

    const dup = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(tokenAdmin))
      .send({ nome: 'Outra', login: 'MARIA', perfilId: perfilGerente, lojas: [loja1], cpf: '52998224725' });
    expect(dup.status).toBe(409);
    expect(dup.body.codigo).toBe('CONFLITO');
    expect(Object.keys(dup.body.campos).sort()).toEqual(['cpf', 'login']);
  });

  it('exige ao menos uma loja quando a empresa já tem lojas (Master dispensa)', async () => {
    const r = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(tokenAdmin))
      .send({ nome: 'Sem Loja', login: 'semloja', perfilId: perfilVendedor });
    expect(r.status).toBe(422);
    expect(r.body.campos.lojas).toEqual(['Escolha ao menos uma loja']);
    const master = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(tokenAdmin))
      .send({ nome: 'Segundo Master', login: 'master2', master: true, senha: 'Provisoria1' });
    expect(master.status).toBe(201);
    expect(master.body.senhaProvisoria).toBeUndefined();
    expect(master.body.usuario.lojas).toEqual([]);
  });

  it('lista com filtros (nome/código, situação, perfil, loja), ordenação e paginação', async () => {
    await criarUsuario(emp.nomeBanco, {
      login: 'vend_a',
      nome: 'ANA VENDEDORA',
      perfil: 'vendedor',
      lojas: [loja2],
    });
    await criarUsuario(emp.nomeBanco, {
      login: 'vend_b',
      nome: 'BRUNO VENDEDOR',
      perfil: 'vendedor',
      lojas: [loja1],
    });
    await consultar(emp.nomeBanco, "update usuarios set ativo = false where login = 'vend_b'");

    const todos = await amb.http().get('/api/usuarios?situacao=todos&tamanho=todos').set(bearer(tokenAdmin));
    expect(todos.body.total).toBe(5);

    const ativos = await amb.http().get('/api/usuarios').set(bearer(tokenAdmin));
    expect(ativos.body.itens.map((u: { login: string }) => u.login)).not.toContain('vend_b');

    const inativos = await amb.http().get('/api/usuarios?situacao=inativos').set(bearer(tokenAdmin));
    expect(inativos.body.itens.map((u: { login: string }) => u.login)).toEqual(['vend_b']);

    const porPerfil = await amb
      .http()
      .get(`/api/usuarios?situacao=todos&perfilId=${perfilVendedor}&ordenar=nome:desc`)
      .set(bearer(tokenAdmin));
    expect(
      porPerfil.body.itens.map((u: { nome: string; perfilNome: string }) => [u.nome, u.perfilNome]),
    ).toEqual([
      ['BRUNO VENDEDOR', 'Vendedor'],
      ['ANA VENDEDORA', 'Vendedor'],
    ]);

    // Masters aparecem em qualquer loja (têm todas).
    const porLoja = await amb.http().get(`/api/usuarios?lojaId=${loja2}`).set(bearer(tokenAdmin));
    expect(porLoja.body.itens.map((u: { login: string }) => u.login).sort()).toEqual([
      'admin',
      'master2',
      'vend_a',
    ]);

    const [maria] = await consultar<{ codigo: number }>(
      emp.nomeBanco,
      "select codigo from usuarios where login = 'maria'",
    );
    const porCodigo = await amb.http().get(`/api/usuarios?nome=${maria!.codigo}`).set(bearer(tokenAdmin));
    expect(porCodigo.body.itens.map((u: { login: string }) => u.login)).toContain('maria');

    const pagina2 = await amb
      .http()
      .get('/api/usuarios?situacao=todos&tamanho=20&pagina=2&ordenar=codigo:asc')
      .set(bearer(tokenAdmin));
    expect(pagina2.body).toMatchObject({ itens: [], total: 5, pagina: 2, tamanho: 20 });

    const ordemInvalida = await amb
      .http()
      .get('/api/usuarios?ordenar=senha_hash:asc')
      .set(bearer(tokenAdmin));
    expect(ordemInvalida.status).toBe(422);
  });

  it('exporta a listagem (ERP 3.1, 1.8) em CSV e xlsx com os mesmos filtros e ordenação, auditado', async () => {
    const csv = await amb
      .http()
      .get(`/api/usuarios/exportar?formato=csv&situacao=todos&perfilId=${perfilVendedor}&ordenar=nome:desc`)
      .set(bearer(tokenAdmin));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(
      /^attachment; filename="Usuarios_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.csv"$/,
    );
    const linhas = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(linhas[0]).toBe('Cód.;Nome;Login;Perfil;Último acesso;Ativo');
    expect(linhas.slice(1).map((l) => l.split(';').slice(1, 4).concat(l.split(';')[5]!))).toEqual([
      ['BRUNO VENDEDOR', 'vend_b', 'Vendedor', 'Não'],
      ['ANA VENDEDORA', 'vend_a', 'Vendedor', 'Sim'],
    ]);

    const xlsx = await amb
      .http()
      .get('/api/usuarios/exportar?formato=xlsx')
      .set(bearer(tokenAdmin))
      .buffer(true)
      .parse((res, fim) => {
        const partes: Buffer[] = [];
        res.on('data', (c: Buffer) => partes.push(c));
        res.on('end', () => fim(null, Buffer.concat(partes)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    const [aud] = await consultar<{ descricao: string; depois: { formato: string; linhas: number } }>(
      emp.nomeBanco,
      "select descricao, depois from auditoria where acao = 'exportar' and entidade = 'usuarios' order by ocorrido_em limit 1",
    );
    expect(aud).toMatchObject({
      descricao: 'Exportação CSV com 2 linha(s)',
      depois: { formato: 'csv', linhas: 2 },
    });

    expect((await amb.http().get('/api/usuarios/exportar?formato=pdf').set(bearer(tokenAdmin))).status).toBe(
      422,
    );

    // usuarios.ver sem relatorios.exportar (não há `usuarios.exportar` no catálogo) → 403.
    const [perfil] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome) values ('SÓ USUÁRIOS') returning id",
    );
    await consultar(
      emp.nomeBanco,
      "insert into perfis_permissoes (perfil_id, permissao) values ($1, 'usuarios.ver')",
      [perfil!.id],
    );
    await criarUsuario(emp.nomeBanco, { login: 'so_ver', perfil: 'vendedor', lojas: [loja1] });
    await consultar(emp.nomeBanco, "update usuarios set perfil_id = $1 where login = 'so_ver'", [perfil!.id]);
    const tokenVer = await amb.entrar(emp.codigo, 'so_ver', SENHA_TESTE);
    expect((await amb.http().get('/api/usuarios').set(bearer(tokenVer))).status).toBe(200);
    const negado = await amb.http().get('/api/usuarios/exportar').set(bearer(tokenVer));
    expect(negado.status).toBe(403);
    expect(negado.body.codigo).toBe('SEM_PERMISSAO');
    await consultar(emp.nomeBanco, "update usuarios set excluido_em = now() where login = 'so_ver'");
  });

  it('altera com versão: 409 CONFLITO_VERSAO com quem alterou; perfil/lojas incrementam permissoes_versao', async () => {
    const [u] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'maria'",
    );
    const atual = await amb.http().get(`/api/usuarios/${u!.id}`).set(bearer(tokenAdmin));
    expect(atual.status).toBe(200);
    const [pvAntes] = await consultar<{ pv: number }>(
      emp.nomeBanco,
      'select permissoes_versao as pv from usuarios where id = $1',
      [u!.id],
    );
    const { id: _id, versao, ...corpo } = atual.body;
    const r = await amb
      .http()
      .put(`/api/usuarios/${u!.id}`)
      .set(bearer(tokenAdmin))
      .send({ ...corpo, versao, telefone: '11999990000', lojas: [loja1, loja2] });
    expect(r.status).toBe(200);
    expect(r.body.usuario.lojas.sort()).toEqual([loja1, loja2].sort());
    expect(r.body.usuario.atualizadoPorNome).toBe('ADMINISTRADOR');
    const [pvDepois] = await consultar<{ pv: number }>(
      emp.nomeBanco,
      'select permissoes_versao as pv from usuarios where id = $1',
      [u!.id],
    );
    expect(pvDepois!.pv).toBe(pvAntes!.pv + 1);

    const conflito = await amb
      .http()
      .put(`/api/usuarios/${u!.id}`)
      .set(bearer(tokenAdmin))
      .send({ ...corpo, versao, telefone: '1' });
    expect(conflito.status).toBe(409);
    expect(conflito.body).toMatchObject({
      codigo: 'CONFLITO_VERSAO',
      detalhes: { alteradoPorNome: 'ADMINISTRADOR' },
    });
    const acoes = await consultar<{ acao: string }>(
      emp.nomeBanco,
      "select acao from auditoria where entidade = 'usuarios' and registro_id = $1 order by ocorrido_em",
      [u!.id],
    );
    // As três auditorias da mesma requisição podem ter o mesmo `ocorrido_em` (a ordem entre elas não é garantida): confere
    // o conjunto, não a ordem (falhava de vez em quando no CI).
    expect(acoes.map((a) => a.acao).sort()).toEqual(['criar', 'editar', 'permissoes_alteradas']);
  });

  it('não deixa sem Master ativo; não deixa alterar o próprio acesso; não exclui a si mesmo', async () => {
    const [admin] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'admin'",
    );
    const [m2] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'master2'",
    );
    const proprio = await amb.http().get(`/api/usuarios/${admin!.id}`).set(bearer(tokenAdmin));
    const { id: _a, versao, ...corpo } = proprio.body;
    const desmarcar = await amb
      .http()
      .put(`/api/usuarios/${admin!.id}`)
      .set(bearer(tokenAdmin))
      .send({ ...corpo, versao, master: false, perfilId: perfilAdministrador });
    expect(desmarcar.status).toBe(403);
    expect(desmarcar.body.mensagem).toContain('próprio perfil');

    expect((await amb.http().delete(`/api/usuarios/${admin!.id}`).set(bearer(tokenAdmin))).status).toBe(422);

    // Com o master2 excluído, o admin vira o último Master: desativá-lo é bloqueado.
    expect((await amb.http().delete(`/api/usuarios/${m2!.id}`).set(bearer(tokenAdmin))).status).toBe(204);
    expect((await amb.http().get(`/api/usuarios/${m2!.id}`).set(bearer(tokenAdmin))).status).toBe(404);
    const atual = await amb.http().get(`/api/usuarios/${admin!.id}`).set(bearer(tokenAdmin));
    const { id: _b, versao: v2, ...c2 } = atual.body;
    const desativar = await amb
      .http()
      .put(`/api/usuarios/${admin!.id}`)
      .set(bearer(tokenAdmin))
      .send({ ...c2, versao: v2, ativo: false });
    expect(desativar.status).toBe(422);
    expect(desativar.body.codigo).toBe('REGRA_NEGOCIO');
    const [aud] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where entidade = 'usuarios' and acao = 'excluir' and registro_id = $1",
      [m2!.id],
    );
    expect(aud).toEqual({ n: 1 });
  });

  it('quem não é Master não escala: nem perfil com mais permissões, nem lojas que não tem, nem Master', async () => {
    // Gerente não tem usuarios.*: concede usuarios.ver/criar/editar individualmente.
    const gid = await criarUsuario(emp.nomeBanco, { login: 'chefe', perfil: 'gerente', lojas: [loja1] });
    for (const p of ['usuarios.ver', 'usuarios.criar', 'usuarios.editar', 'perfis.ver']) {
      await consultar(
        emp.nomeBanco,
        "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, $2, 'conceder')",
        [gid, p],
      );
    }
    const token = await amb.entrar(emp.codigo, 'chefe', SENHA_TESTE);
    const base = { nome: 'Novo', login: 'novo1', lojas: [loja1] };

    const admin = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(token))
      .send({ ...base, perfilId: perfilAdministrador });
    expect(admin.status).toBe(403);
    expect(admin.body.detalhes.permissoes.length).toBeGreaterThan(0);

    const outraLoja = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(token))
      .send({ ...base, perfilId: perfilVendedor, lojas: [loja2] });
    expect(outraLoja.status).toBe(403);

    const master = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(token))
      .send({ ...base, master: true });
    expect(master.status).toBe(403);

    const ok = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(token))
      .send({ ...base, perfilId: perfilVendedor });
    expect(ok.status).toBe(201);

    const editar = async (id: string, mudanca: Record<string, unknown>) => {
      const atual = await amb.http().get(`/api/usuarios/${id}`).set(bearer(token));
      const { id: _i, versao, ...corpo } = atual.body;
      return amb
        .http()
        .put(`/api/usuarios/${id}`)
        .set(bearer(token))
        .send({ ...corpo, versao, ...mudanca });
    };
    const editado = await editar(ok.body.usuario.id, { nome: 'Novo Nome' });
    expect(editado.status).toBe(200);

    // Limite de desconto é permissão numérica: não passa do do próprio editor (0% para o chefe).
    const desconto = await editar(ok.body.usuario.id, { limiteDescontoPct: '15.0000' });
    expect(desconto.status).toBe(403);
    expect(desconto.body.campos.limiteDescontoPct).toBeDefined();

    // Usuário com loja que o chefe não enxerga: nada de alterar (e-mail, login, desativar) nem excluir.
    await consultar(emp.nomeBanco, 'insert into usuarios_lojas (usuario_id, loja_id) values ($1, $2)', [
      ok.body.usuario.id,
      loja2,
    ]);
    const outraLojaAlvo = await editar(ok.body.usuario.id, { email: 'eu@atacante.dev' });
    expect(outraLojaAlvo.status).toBe(403);
    expect(outraLojaAlvo.body.detalhes.lojasForaDoSeuAcesso).toBe(true);

    // Usuário com mais permissões (perfil Administrador, não Master) também é intocável para o chefe.
    const poderosoId = await criarUsuario(emp.nomeBanco, {
      login: 'poderoso',
      perfil: 'administrador',
      lojas: [loja1],
    });
    const poderoso = await editar(poderosoId, { email: 'eu@atacante.dev' });
    expect(poderoso.status).toBe(403);
    expect(poderoso.body.detalhes.permissoes.length).toBeGreaterThan(0);
    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'usuarios.excluir', 'conceder')",
      [gid],
    );
    await consultar(
      emp.nomeBanco,
      'update usuarios set permissoes_versao = permissoes_versao + 1 where id = $1',
      [gid],
    );
    expect((await amb.http().delete(`/api/usuarios/${poderosoId}`).set(bearer(token))).status).toBe(403);
    // O Master pode (e é o único que desbloqueia).
    await consultar(
      emp.nomeBanco,
      "update usuarios set bloqueado_ate = now() + interval '10 minutes' where id = $1",
      [poderosoId],
    );
    expect((await amb.http().post(`/api/usuarios/${poderosoId}/desbloquear`).set(bearer(token))).status).toBe(
      403,
    );
    expect(
      (await amb.http().post(`/api/usuarios/${poderosoId}/desbloquear`).set(bearer(tokenAdmin))).status,
    ).toBe(204);
    const [desbloqueado] = await consultar(
      emp.nomeBanco,
      'select bloqueado_ate from usuarios where id = $1',
      [poderosoId],
    );
    expect(desbloqueado).toEqual({ bloqueado_ate: null });

    const [adm] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from usuarios where login = 'admin'",
    );
    // O Master nem aparece para quem tem lojas restritas (decisão 92); editar com o corpo certo continua 403.
    expect((await amb.http().get(`/api/usuarios/${adm!.id}`).set(bearer(token))).status).toBe(404);
    const adminAtual = await amb.http().get(`/api/usuarios/${adm!.id}`).set(bearer(tokenAdmin));
    const { id: _x, versao: v2, ...c2 } = adminAtual.body;
    const editarMaster = await amb
      .http()
      .put(`/api/usuarios/${adm!.id}`)
      .set(bearer(token))
      .send({ ...c2, versao: v2, nome: 'Hackeado' });
    expect(editarMaster.status).toBe(403);
  });

  it('sem usuarios.criar/editar → 403; perfis.ver é exigida em /perfis', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'vend_c', perfil: 'vendedor', lojas: [loja1] });
    const token = await amb.entrar(emp.codigo, 'vend_c', SENHA_TESTE);
    expect((await amb.http().post('/api/usuarios').set(bearer(token)).send({})).status).toBe(403);
    expect((await amb.http().get('/api/perfis').set(bearer(token))).status).toBe(403);
    expect(
      (await amb.http().put(`/api/usuarios/00000000-0000-7000-8000-000000000000`).set(bearer(token)).send({}))
        .status,
    ).toBe(403);
  });
});
