/** Perfis de acesso (ERP 11.3) e o restante do cadastro de usuários (ERP 11.2): PIN, permissões, RH, estoques. */
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
let admin: string;
let loja1: string;
let gerente: string;
let gerenteId: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  gerenteId = await criarUsuario(emp.nomeBanco, { login: 'gerente', perfil: 'gerente', lojas: [loja1] });
  gerente = await amb.entrar(emp.codigo, 'gerente', SENHA_TESTE);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('Perfis de acesso (ERP 11.3)', () => {
  let perfilId: string;

  it('cria com permissões do catálogo; permissão inexistente → 422; nome repetido → 409', async () => {
    const r = await amb
      .http()
      .post('/api/perfis')
      .set(bearer(admin))
      .send({
        nome: 'Repositor',
        descricao: 'Consulta de produtos',
        permissoes: ['produtos.ver', 'pdv.acesso.entrar', 'produtos.ver'],
      });
    expect(r.status).toBe(201);
    perfilId = r.body.id;
    expect(r.body).toMatchObject({
      nome: 'Repositor',
      permissoes: ['pdv.acesso.entrar', 'produtos.ver'],
      usuarios: 0,
    });
    const invalida = await amb
      .http()
      .post('/api/perfis')
      .set(bearer(admin))
      .send({ nome: 'X', permissoes: ['nao.existe'] });
    expect(invalida.status).toBe(422);
    const dup = await amb
      .http()
      .post('/api/perfis')
      .set(bearer(admin))
      .send({ nome: 'REPOSITOR', permissoes: [] });
    expect(dup.status).toBe(409);
    expect(dup.body.campos.nome).toBeDefined();
  });

  it('alterar permissões incrementa permissoes_versao dos usuários do perfil e audita; versão velha → 409', async () => {
    const uid = await criarUsuario(emp.nomeBanco, { login: 'repo1', perfil: 'vendedor', lojas: [loja1] });
    await consultar(emp.nomeBanco, 'update usuarios set perfil_id = $1 where id = $2', [perfilId, uid]);
    const [antes] = await consultar<{ permissoes_versao: number }>(
      emp.nomeBanco,
      'select permissoes_versao from usuarios where id = $1',
      [uid],
    );
    const d = await amb.http().get(`/api/perfis/${perfilId}`).set(bearer(admin));
    expect(d.body.usuarios).toBe(1);
    const r = await amb
      .http()
      .put(`/api/perfis/${perfilId}`)
      .set(bearer(admin))
      .send({ versao: d.body.versao, nome: 'Repositor', permissoes: ['produtos.ver', 'estoque_saldos.ver'] });
    expect(r.status).toBe(200);
    expect(r.body.permissoes).toEqual(['estoque_saldos.ver', 'produtos.ver']);
    const [depois] = await consultar<{ permissoes_versao: number }>(
      emp.nomeBanco,
      'select permissoes_versao from usuarios where id = $1',
      [uid],
    );
    expect(depois!.permissoes_versao).toBe(antes!.permissoes_versao + 1);
    const [aud] = await consultar(
      emp.nomeBanco,
      "select depois->'removidas' as removidas from auditoria where entidade = 'perfis' and acao = 'permissoes_alteradas' and registro_id = $1",
      [perfilId],
    );
    expect(aud!.removidas).toEqual(['pdv.acesso.entrar']);
    const velho = await amb
      .http()
      .put(`/api/perfis/${perfilId}`)
      .set(bearer(admin))
      .send({ versao: d.body.versao, nome: 'Repositor', permissoes: [] });
    expect(velho.status).toBe(409);
    expect(velho.body.codigo).toBe('CONFLITO_VERSAO');
    // Excluir perfil com usuários é bloqueado.
    expect((await amb.http().delete(`/api/perfis/${perfilId}`).set(bearer(admin))).status).toBe(422);
  });

  it('duplicar copia as permissões; sem perfis.criar → 403; escalada: só concede o que tem', async () => {
    const dup = await amb.http().post(`/api/perfis/${perfilId}/duplicar`).set(bearer(admin));
    expect(dup.status).toBe(201);
    expect(dup.body).toMatchObject({
      nome: 'Repositor (cópia)',
      permissoes: ['estoque_saldos.ver', 'produtos.ver'],
    });
    // Gerente não tem perfis.criar (sem usuários/configurações): 403.
    const semPermissao = await amb
      .http()
      .post('/api/perfis')
      .set(bearer(gerente))
      .send({ nome: 'G', permissoes: [] });
    expect(semPermissao.status).toBe(403);
    // Um "editor de perfis" sem auditoria.ver não pode concedê-la.
    const editor = await amb
      .http()
      .post('/api/perfis')
      .set(bearer(admin))
      .send({ nome: 'Editor', permissoes: ['perfis.ver', 'perfis.criar', 'perfis.editar'] });
    const uid = await criarUsuario(emp.nomeBanco, { login: 'editor', perfil: 'vendedor', lojas: [loja1] });
    await consultar(emp.nomeBanco, 'update usuarios set perfil_id = $1 where id = $2', [editor.body.id, uid]);
    const tok = await amb.entrar(emp.codigo, 'editor', SENHA_TESTE);
    const r = await amb
      .http()
      .post('/api/perfis')
      .set(bearer(tok))
      .send({ nome: 'Auditor', permissoes: ['auditoria.ver'] });
    expect(r.status).toBe(403);
    expect(r.body.detalhes.permissoes).toEqual(['auditoria.ver']);
    expect((await amb.http().delete(`/api/perfis/${dup.body.id}`).set(bearer(admin))).status).toBe(204);
  });
});

describe('Usuários – PIN do PDV (SYNC 4.3) e demais campos (ERP 11.2)', () => {
  it('PIN: recusa sequência, repetição, curto e o código; grava argon2id m=64 MiB; nunca devolve o hash', async () => {
    const [{ codigo }] = (await consultar<{ codigo: number }>(
      emp.nomeBanco,
      'select codigo from usuarios where id = $1',
      [gerenteId],
    )) as [{ codigo: number }];
    for (const [pin, msg] of [
      ['123456', 'sequências'],
      ['111111', 'repetidos'],
      ['1234', '6 a 8'],
      ['12a456', 'números'],
    ] as const) {
      const r = await amb.http().put(`/api/usuarios/${gerenteId}/pin`).set(bearer(admin)).send({ pin });
      expect(r.status).toBe(422);
      expect(r.body.campos.pin[0]).toContain(msg);
    }
    await consultar(emp.nomeBanco, 'update usuarios set codigo = 482915 where id = $1', [gerenteId]);
    const proprioCodigo = await amb
      .http()
      .put(`/api/usuarios/${gerenteId}/pin`)
      .set(bearer(admin))
      .send({ pin: '482915' });
    expect(proprioCodigo.status).toBe(422);
    await consultar(emp.nomeBanco, 'update usuarios set codigo = $2 where id = $1', [gerenteId, codigo]);
    const ok = await amb
      .http()
      .put(`/api/usuarios/${gerenteId}/pin`)
      .set(bearer(admin))
      .send({ pin: '480297' });
    expect(ok.status).toBe(204);
    const [{ h }] = (await consultar<{ h: string }>(
      emp.nomeBanco,
      'select senha_pdv_hash as h from usuarios where id = $1',
      [gerenteId],
    )) as [{ h: string }];
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    const d = await amb.http().get(`/api/usuarios/${gerenteId}`).set(bearer(admin));
    expect(d.body.pinDefinido).toBe(true);
    expect(JSON.stringify(d.body)).not.toContain('argon2');
    // O próprio usuário define o PIN sem `usuarios.editar`; PIN curto só com pdv.permite_pin_curto.
    const vend = await criarUsuario(emp.nomeBanco, { login: 'vend', perfil: 'vendedor', lojas: [loja1] });
    const tokVend = await amb.entrar(emp.codigo, 'vend', SENHA_TESTE);
    expect(
      (await amb.http().put(`/api/usuarios/${vend}/pin`).set(bearer(tokVend)).send({ pin: '918273' })).status,
    ).toBe(204);
    expect(
      (await amb.http().put(`/api/usuarios/${gerenteId}/pin`).set(bearer(tokVend)).send({ pin: '918273' }))
        .status,
    ).toBe(403);
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (chave, valor) values ('pdv.permite_pin_curto', 'true')`,
    );
    expect(
      (await amb.http().put(`/api/usuarios/${vend}/pin`).set(bearer(tokVend)).send({ pin: '9182' })).status,
    ).toBe(204);
    expect(
      (await amb.http().put(`/api/usuarios/${vend}/pin`).set(bearer(tokVend)).send({ pin: null })).status,
    ).toBe(204);
    const [{ h: removido }] = (await consultar<{ h: string | null }>(
      emp.nomeBanco,
      'select senha_pdv_hash as h from usuarios where id = $1',
      [vend],
    )) as [{ h: string | null }];
    expect(removido).toBeNull();
  });

  it('salário só com usuarios.ver_dados_rh; totem sem perfil; estoques permitidos; endereço com cidade da UF', async () => {
    const [cd] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo) values ('CD', 'deposito') returning id",
    );
    const r = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(admin))
      .send({
        nome: 'Totem Loja 1',
        login: 'totem1',
        totem: true,
        salario: '1500,50',
        lojas: [loja1],
        estoques: [cd!.id],
        cep: '80010000',
        logradouro: 'Rua A',
        numero: '1',
        bairro: 'Centro',
        uf: 'PR',
        municipioIbge: 4106902,
      });
    expect(r.status).toBe(201);
    expect(r.body.usuario).toMatchObject({
      totem: true,
      perfilId: null,
      salario: '1500.50',
      estoques: [cd!.id],
      municipioNome: 'Curitiba',
    });
    // Quem vê usuários sem `usuarios.ver_dados_rh` não vê nem altera o salário.
    const p = await amb
      .http()
      .post('/api/perfis')
      .set(bearer(admin))
      .send({ nome: 'Consulta usuários', permissoes: ['usuarios.ver'] });
    const uid = await criarUsuario(emp.nomeBanco, { login: 'consulta', perfil: 'vendedor', lojas: [loja1] });
    await consultar(emp.nomeBanco, 'update usuarios set perfil_id = $1 where id = $2', [p.body.id, uid]);
    const tok = await amb.entrar(emp.codigo, 'consulta', SENHA_TESTE);
    const g = await amb.http().get(`/api/usuarios/${r.body.usuario.id}`).set(bearer(tok));
    expect(g.status).toBe(200);
    expect(g.body.salario).toBeNull();
    const errado = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(admin))
      .send({
        nome: 'X',
        login: 'x1',
        totem: true,
        lojas: [loja1],
        cep: '80010000',
        logradouro: 'A',
        numero: '1',
        bairro: 'B',
        uf: 'SP',
        municipioIbge: 4106902,
      });
    expect(errado.status).toBe(422);
    expect(errado.body.campos.municipioIbge).toBeDefined();
  });

  it('permissões individuais: concede/nega, efetivas recalculadas, auto-edição e escalada barradas', async () => {
    const atual = await amb.http().get(`/api/usuarios/${gerenteId}/permissoes`).set(bearer(admin));
    expect(atual.status).toBe(200);
    expect(atual.body.doPerfil).toContain('produtos.ver');
    const r = await amb
      .http()
      .put(`/api/usuarios/${gerenteId}/permissoes`)
      .set(bearer(admin))
      .send({
        versao: atual.body.versao,
        ajustes: [
          { permissao: 'auditoria.ver', efeito: 'conceder' },
          { permissao: 'produtos.ver', efeito: 'negar' },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.efetivas).toContain('auditoria.ver');
    expect(r.body.efetivas).not.toContain('produtos.ver');
    // A sessão do gerente já reflete (cache invalidado pela geração).
    expect((await amb.http().get('/api/auditoria').set(bearer(gerente))).status).toBe(200);
    const velho = await amb
      .http()
      .put(`/api/usuarios/${gerenteId}/permissoes`)
      .set(bearer(admin))
      .send({ versao: atual.body.versao, ajustes: [] });
    expect(velho.status).toBe(409);
    const proprio = await amb
      .http()
      .put(`/api/usuarios/${gerenteId}/permissoes`)
      .set(bearer(gerente))
      .send({ versao: r.body.versao, ajustes: [] });
    expect(proprio.status).toBe(403);
  });

  it('redefinir senha: provisória exibida uma vez, encerra sessões; sem a permissão → 403', async () => {
    const semPermissao = await amb
      .http()
      .post(`/api/usuarios/${gerenteId}/redefinir-senha`)
      .set(bearer(gerente));
    expect(semPermissao.status).toBe(403);
    const r = await amb.http().post(`/api/usuarios/${gerenteId}/redefinir-senha`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body.senhaProvisoria).toMatch(/^[A-Za-z0-9]{12}$/);
    expect((await amb.http().get('/api/auth/eu').set(bearer(gerente))).status).toBe(401);
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'gerente', senha: r.body.senhaProvisoria });
    expect(login.body.trocarSenha).toBe(true);
  });
});
