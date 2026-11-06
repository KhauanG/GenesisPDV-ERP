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

/** Corpo completo do PUT /api/empresa (ERP 10.1) a partir do GET, com o endereço obrigatório. */
const corpoEmpresa = (e: Record<string, unknown>) => ({
  versao: e.versao,
  razaoSocial: e.razaoSocial,
  nomeFantasia: e.nomeFantasia ?? 'Fantasia',
  cnpj: e.cnpj,
  cep: '01001000',
  logradouro: 'Praça da Sé',
  numero: '1',
  bairro: 'Sé',
  uf: 'SP',
  municipioIbge: 3550308,
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
});

afterAll(async () => {
  await amb?.fechar();
});

describe('permissões (@Permissao) e lojas permitidas (ERP 2)', () => {
  it('usuário sem a permissão recebe 403 SEM_PERMISSAO com a chave que falta', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'vendedor1', perfil: 'vendedor', lojas: [loja1] });
    const token = await amb.entrar(emp.codigo, 'vendedor1', SENHA_TESTE);
    const r = await amb.http().get('/api/usuarios').set(bearer(token));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ codigo: 'SEM_PERMISSAO', detalhes: { permissoes: ['usuarios.ver'] } });
    expect((await amb.http().get('/api/lojas').set(bearer(token))).status).toBe(403);
    expect((await amb.http().get('/api/auditoria').set(bearer(token))).status).toBe(403);
    expect((await amb.http().put('/api/empresa').set(bearer(token)).send({ versao: 1 })).status).toBe(403);
    expect((await amb.http().get('/api/auth/eu').set(bearer(token))).status).toBe(200);
  });

  it('operador de caixa (só permissões pdv.*) não entra no ERP', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'caixa1', perfil: 'operador_caixa', lojas: [loja1] });
    const r = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'caixa1', senha: SENHA_TESTE });
    expect(r.status).toBe(403);
    expect(r.body.mensagem).toBe('Seu usuário não tem acesso ao ERP.');
  });

  it('usuário restrito à Loja 1 não enxerga a Loja 2 (listagem filtrada e 403 no registro)', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'gerente1', perfil: 'gerente', lojas: [loja1] });
    const token = await amb.entrar(emp.codigo, 'gerente1', SENHA_TESTE);
    const lista = await amb.http().get('/api/lojas').set(bearer(token));
    expect(lista.status).toBe(200);
    expect(lista.body.itens.map((l: { id: string }) => l.id)).toEqual([loja1]);
    expect(lista.body.total).toBe(1);
    expect((await amb.http().get(`/api/lojas/${loja1}`).set(bearer(token))).status).toBe(200);
    const outra = await amb.http().get(`/api/lojas/${loja2}`).set(bearer(token));
    expect(outra.status).toBe(403);
    expect(outra.body.mensagem).toBe('Você não tem acesso a esta loja.');
    const eu = await amb.http().get('/api/auth/eu').set(bearer(token));
    expect(eu.body.todasLojas).toBe(false);
    expect(eu.body.lojas.map((l: { id: string }) => l.id)).toEqual([loja1]);
  });

  it('master vê todas as lojas; segredos da loja não voltam ao navegador', async () => {
    const token = await amb.entrar(emp.codigo, 'admin', emp.senha);
    const lista = await amb.http().get('/api/lojas').set(bearer(token));
    expect(lista.body.itens.map((l: { id: string }) => l.id).sort()).toEqual([loja1, loja2].sort());
    await consultar(emp.nomeBanco, "update lojas set nfce_csc_cifrado = '\\x0102'::bytea where id = $1", [
      loja2,
    ]);
    const detalhe = await amb.http().get(`/api/lojas/${loja2}`).set(bearer(token));
    expect(detalhe.body).not.toHaveProperty('nfceCscCifrado');
    expect(detalhe.body).not.toHaveProperty('tefTokenCifrado');
  });

  it('negar vence conceder e a mudança vale na próxima requisição (permissoes_versao)', async () => {
    const id = await criarUsuario(emp.nomeBanco, {
      login: 'gerente2',
      perfil: 'gerente',
      lojas: [loja1, loja2],
    });
    const token = await amb.entrar(emp.codigo, 'gerente2', SENHA_TESTE);
    expect((await amb.http().get('/api/lojas').set(bearer(token))).status).toBe(200);
    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'lojas.ver', 'negar')",
      [id],
    );
    await consultar(
      emp.nomeBanco,
      'update usuarios set permissoes_versao = permissoes_versao + 1 where id = $1',
      [id],
    );
    expect((await amb.http().get('/api/lojas').set(bearer(token))).status).toBe(403);
    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'usuarios.ver', 'conceder')",
      [id],
    );
    await consultar(
      emp.nomeBanco,
      'update usuarios set permissoes_versao = permissoes_versao + 1 where id = $1',
      [id],
    );
    expect((await amb.http().get('/api/usuarios').set(bearer(token))).status).toBe(200);
  });

  it('mudança no perfil (sem mexer em permissoes_versao) e loja excluída valem na próxima requisição', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'gerente4', perfil: 'gerente', lojas: [loja1, loja2] });
    const token = await amb.entrar(emp.codigo, 'gerente4', SENHA_TESTE);
    expect((await amb.http().get('/api/lojas').set(bearer(token))).body.total).toBe(2);
    const remover = (excluido: boolean) =>
      consultar(
        emp.nomeBanco,
        `update perfis_permissoes set excluido_em = ${excluido ? 'now()' : 'null'}
         where permissao = 'lojas.ver' and perfil_id = (select id from perfis where chave_sistema = 'gerente')`,
      );
    await remover(true);
    try {
      expect((await amb.http().get('/api/lojas').set(bearer(token))).status).toBe(403);
    } finally {
      await remover(false);
    }
    expect((await amb.http().get('/api/lojas').set(bearer(token))).status).toBe(200);
    const extra = await criarLoja(emp.nomeBanco, 3, 'Loja 3 - Temporária');
    await consultar(
      emp.nomeBanco,
      'insert into usuarios_lojas (usuario_id, loja_id) select id, $1 from usuarios where login = $2',
      [extra, 'gerente4'],
    );
    expect((await amb.http().get('/api/auth/eu').set(bearer(token))).body.lojas).toHaveLength(3);
    await consultar(emp.nomeBanco, 'update lojas set excluido_em = now() where id = $1', [extra]);
    expect((await amb.http().get('/api/auth/eu').set(bearer(token))).body.lojas).toHaveLength(2);
  });

  it('usuário desativado perde o acesso imediatamente, mesmo com token válido', async () => {
    const id = await criarUsuario(emp.nomeBanco, { login: 'gerente3', perfil: 'gerente', lojas: [loja1] });
    const token = await amb.entrar(emp.codigo, 'gerente3', SENHA_TESTE);
    await consultar(emp.nomeBanco, 'update usuarios set ativo = false where id = $1', [id]);
    expect((await amb.http().get('/api/lojas').set(bearer(token))).status).toBe(401);
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: emp.codigo, login: 'gerente3', senha: SENHA_TESTE });
    expect(login.status).toBe(401);
    const [neg] = await consultar(
      emp.nomeBanco,
      "select descricao from auditoria where acao = 'login_negado' and registro_id = $1",
      [id],
    );
    expect(neg!.descricao).toContain('usuario_inativo');
  });
});

describe('GET /api/auditoria (ERP 17.3, 2.1)', () => {
  it('usuário restrito à Loja 1 não vê auditoria da Loja 2; filtros de período, origem e texto', async () => {
    const id = await criarUsuario(emp.nomeBanco, { login: 'auditor1', perfil: 'gerente', lojas: [loja1] });
    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'auditoria.ver', 'conceder')",
      [id],
    );
    const inserir = (loja: string | null, descricao: string, origem = 'pdv', diasAtras = 0) =>
      consultar(
        emp.nomeBanco,
        `insert into auditoria (id, ocorrido_em, origem, entidade, acao, loja_id, descricao)
         values (fn_uuid_v7(), now() - make_interval(days => $4), $3, 'teste_auditoria', 'editar', $1, $2)`,
        [loja, descricao, origem, diasAtras],
      );
    await inserir(loja1, 'Alteração na loja 1');
    await inserir(loja2, 'Alteração na loja 2 (segredo comercial)');
    await inserir(null, 'Alteração global', 'erp');
    await inserir(loja1, 'Alteração antiga na loja 1', 'pdv', 3);
    const token = await amb.entrar(emp.codigo, 'auditor1', SENHA_TESTE);
    const listar = async (q: string) => {
      const r = await amb.http().get(`/api/auditoria?entidade=teste_auditoria${q}`).set(bearer(token));
      expect(r.status).toBe(200);
      return (r.body.itens as Array<{ descricao: string }>).map((x) => x.descricao).sort();
    };
    expect(await listar('')).toEqual(['Alteração global', 'Alteração na loja 1']);
    const tresDias = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
    expect(await listar(`&de=${tresDias}`)).toEqual([
      'Alteração antiga na loja 1',
      'Alteração global',
      'Alteração na loja 1',
    ]);
    expect(await listar('&origem=erp')).toEqual(['Alteração global']);
    expect(await listar('&texto=loja%201')).toEqual(['Alteração na loja 1']);
    const outra = await amb.http().get(`/api/auditoria?loja_id=${loja2}`).set(bearer(token));
    expect(outra.status).toBe(403);
    const master = await amb.entrar(emp.codigo, 'admin', SENHA_TESTE);
    const todas = await amb.http().get('/api/auditoria?entidade=teste_auditoria').set(bearer(master));
    expect(todas.body.total).toBe(3);
  });
});

describe('auditoria na mesma transação (ERP 17)', () => {
  it('PUT /api/empresa grava antes/depois; versão desatualizada → 409 sem auditoria', async () => {
    const token = await amb.entrar(emp.codigo, 'admin', SENHA_TESTE);
    const atual = await amb.http().get('/api/empresa').set(bearer(token));
    expect(atual.status).toBe(200);
    const r = await amb
      .http()
      .put('/api/empresa')
      .set(bearer(token))
      .set('X-Requisicao-Id', '01a18aa7-b34c-7ecf-be3c-23bd5d29385f')
      .send({ ...corpoEmpresa(atual.body), nomeFantasia: 'Ice Beer', telefone: '11999990000' });
    expect(r.status).toBe(200);
    expect(r.body.versao).toBeGreaterThan(atual.body.versao);
    const [aud] = await consultar(
      emp.nomeBanco,
      "select antes->>'nomeFantasia' as antes, depois->>'nomeFantasia' as depois, usuario_nome, origem, requisicao_id::text from auditoria where entidade = 'empresa' and acao = 'editar'",
    );
    expect(aud).toEqual({
      antes: null,
      depois: 'Ice Beer',
      usuario_nome: 'ADMINISTRADOR',
      origem: 'erp',
      requisicao_id: '01a18aa7-b34c-7ecf-be3c-23bd5d29385f',
    });

    const conflito = await amb
      .http()
      .put('/api/empresa')
      .set(bearer(token))
      .send({ ...corpoEmpresa(atual.body), telefone: '1' });
    expect(conflito.status).toBe(409);
    expect(conflito.body.codigo).toBe('CONFLITO_VERSAO');
    const [n] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where entidade = 'empresa' and acao = 'editar'",
    );
    expect(n).toEqual({ n: 1 });
  });

  it('rollback da transação leva a linha de auditoria junto; campos sensíveis são mascarados', async () => {
    const contexto = amb.servicos.resolvedor.contexto((await amb.servicos.resolvedor.porCodigo(emp.codigo))!);
    await expect(
      amb.servicos.tenancy.executarNaEmpresa(contexto, () =>
        amb.servicos.tenancy.cx().transacao(async (tx) => {
          await amb.servicos.auditoria.registrar(
            tx,
            { origem: 'sistema' },
            { acao: 'editar', entidade: 'teste_rollback' },
          );
          throw new Error('falha depois da auditoria');
        }),
      ),
    ).rejects.toThrow('falha depois da auditoria');
    expect(
      await consultar(emp.nomeBanco, "select 1 from auditoria where entidade = 'teste_rollback'"),
    ).toHaveLength(0);

    await amb.servicos.tenancy.executarNaEmpresa(contexto, () =>
      amb.servicos.tenancy.cx().transacao((tx) =>
        amb.servicos.auditoria.registrar(
          tx,
          { origem: 'sistema' },
          {
            acao: 'editar',
            entidade: 'teste_mascara',
            antes: { senha_hash: '$argon2id$x', nome: 'A', nfce_csc_cifrado: 'abc' },
            depois: { senha_hash: '$argon2id$y', nome: 'B' },
          },
        ),
      ),
    );
    const [m] = await consultar(
      emp.nomeBanco,
      "select antes, depois from auditoria where entidade = 'teste_mascara'",
    );
    expect(m).toEqual({
      antes: { senha_hash: '***', nome: 'A', nfce_csc_cifrado: '***' },
      depois: { senha_hash: '***', nome: 'B' },
    });
  });

  it('auditoria é append-only e particionada por mês', async () => {
    await expect(consultar(emp.nomeBanco, "update auditoria set descricao = 'x'")).rejects.toThrow(
      /AUDITORIA_IMUTAVEL/,
    );
    await expect(consultar(emp.nomeBanco, 'delete from auditoria')).rejects.toThrow(/AUDITORIA_IMUTAVEL/);
    const [p] = await consultar(
      emp.nomeBanco,
      "select count(*)::int as n, bool_or(c.relname = 'auditoria_' || to_char(now() at time zone 'UTC', 'YYYY_MM')) as mes_atual from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'auditoria'::regclass",
    );
    expect(p).toEqual({ n: 16, mes_atual: true });
  });
});
