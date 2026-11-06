/**
 * Revisão de segurança da Fase 1 (README › Decisões 85–92): escalada pela retirada do "negar", estoques e dados de
 * usuários de outras lojas, faixas de preço de outras lojas no produto e no mix, auditoria redigida pela visão do
 * leitor e limite de hashes argon2 por usuário.
 */
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
let loja2: string;
let estoque2: string;
let un: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Usuário com o perfil do seed e ajustes individuais gravados direto no banco. */
async function usuarioCom(
  login: string,
  perfil: string,
  lojas: string[],
  ajustes: Array<[string, 'conceder' | 'negar']> = [],
): Promise<{ id: string; token: string }> {
  const id = await criarUsuario(emp.nomeBanco, { login, perfil, lojas });
  for (const [permissao, efeito] of ajustes) {
    await consultar(
      emp.nomeBanco,
      'insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, $2, $3)',
      [id, permissao, efeito],
    );
  }
  return { id, token: await amb.entrar(emp.codigo, login, SENHA_TESTE) };
}

beforeAll(async () => {
  // Lido do ambiente do processo a cada chamada (src/comum/limites-processo.ts).
  process.env.HASH_LIMITE_POR_MINUTO = '3';
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2');
  estoque2 = (
    await consultar<{ estoque_id: string }>(emp.nomeBanco, 'select estoque_id from lojas where id = $1', [
      loja2,
    ])
  )[0]!.estoque_id;
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer(admin));
  un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('usuários (ERP 11.2; decisões 86, 89, 92)', () => {
  const adminUsuarios: Array<[string, 'conceder' | 'negar']> = [
    ['usuarios.ver', 'conceder'],
    ['usuarios.editar', 'conceder'],
    ['usuarios.permissoes', 'conceder'],
    ['vendas.criar', 'negar'],
  ];

  it('retirar o "negar" de permissão do perfil que o editor não tem → 403; pôr "negar" é livre', async () => {
    const sub = await usuarioCom('subadmin', 'vendedor', [loja1], adminUsuarios);
    const alvo = await usuarioCom('alvo', 'vendedor', [loja1], [['vendas.criar', 'negar']]);
    const atual = await amb.http().get(`/api/usuarios/${alvo.id}/permissoes`).set(bearer(sub.token));
    expect(atual.status).toBe(200);
    expect(atual.body.doPerfil).toContain('vendas.criar');
    expect(atual.body.efetivas).not.toContain('vendas.criar');
    const escalada = await amb
      .http()
      .put(`/api/usuarios/${alvo.id}/permissoes`)
      .set(bearer(sub.token))
      .send({ versao: atual.body.versao, ajustes: [] });
    expect(escalada.status).toBe(403);
    expect(escalada.body.detalhes.permissoes).toEqual(['vendas.criar']);
    const negarMais = await amb
      .http()
      .put(`/api/usuarios/${alvo.id}/permissoes`)
      .set(bearer(sub.token))
      .send({
        versao: atual.body.versao,
        ajustes: [
          { permissao: 'vendas.criar', efeito: 'negar' },
          { permissao: 'produtos.ver', efeito: 'negar' },
        ],
      });
    expect(negarMais.status, JSON.stringify(negarMais.body)).toBe(200);
  });

  it('estoque fora dos estoques permitidos do editor não é concedido (403) e o já concedido é preservado', async () => {
    const sub = await usuarioCom('subadmin2', 'vendedor', [loja1], adminUsuarios);
    const alvo = await criarUsuario(emp.nomeBanco, { login: 'alvo2', perfil: 'vendedor', lojas: [loja1] });
    const d = await amb.http().get(`/api/usuarios/${alvo}`).set(bearer(sub.token));
    expect(d.status).toBe(200);
    const { id: _i, versao, ...resto } = d.body;
    const corpo = (estoques: string[], v: number) => ({ ...resto, versao: v, estoques });
    const negado = await amb
      .http()
      .put(`/api/usuarios/${alvo}`)
      .set(bearer(sub.token))
      .send(corpo([estoque2], versao));
    expect(negado.status, JSON.stringify(negado.body)).toBe(403);
    // O Master concede o estoque da loja 2: daí o restrito não edita mais esse usuário (acesso maior que o dele).
    const pelaAdmin = await amb
      .http()
      .put(`/api/usuarios/${alvo}`)
      .set(bearer(admin))
      .send(corpo([estoque2], versao));
    expect(pelaAdmin.status, JSON.stringify(pelaAdmin.body)).toBe(200);
    const depois = await amb
      .http()
      .put(`/api/usuarios/${alvo}`)
      .set(bearer(sub.token))
      .send(corpo([], pelaAdmin.body.usuario.versao));
    expect(depois.status).toBe(403);
    expect(depois.body.detalhes.estoquesForaDoSeuAcesso).toBe(true);
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from usuarios_estoques where usuario_id = $1 and excluido_em is null',
      [alvo],
    );
    expect(n!.n).toBe(1);
  });

  it('restrito à loja 1 não lista nem abre usuário só da loja 2 nem o Master', async () => {
    const sub = await usuarioCom('subadmin3', 'vendedor', [loja1], adminUsuarios);
    const daLoja2 = await criarUsuario(emp.nomeBanco, {
      login: 'loja2user',
      perfil: 'vendedor',
      lojas: [loja2],
    });
    const lista = await amb.http().get('/api/usuarios?tamanho=todos').set(bearer(sub.token));
    expect(lista.status).toBe(200);
    const logins = (lista.body.itens as Array<{ login: string }>).map((u) => u.login);
    expect(logins).toContain('subadmin3');
    expect(logins).not.toContain('loja2user');
    expect(logins).not.toContain('admin');
    expect((await amb.http().get(`/api/usuarios/${daLoja2}`).set(bearer(sub.token))).status).toBe(404);
    expect((await amb.http().get(`/api/usuarios/${daLoja2}/permissoes`).set(bearer(sub.token))).status).toBe(
      404,
    );
    const todos = await amb.http().get('/api/usuarios?tamanho=todos').set(bearer(admin));
    expect((todos.body.itens as Array<{ login: string }>).map((u) => u.login)).toContain('loja2user');
  });

  it('PIN: limite de hashes por usuário por minuto → 429', async () => {
    const vend = await usuarioCom('vendpin', 'vendedor', [loja1]);
    const pins = ['918273', '827364', '736455', '645546'];
    const status: number[] = [];
    for (const pin of pins) {
      status.push(
        (await amb.http().put(`/api/usuarios/${vend.id}/pin`).set(bearer(vend.token)).send({ pin })).status,
      );
    }
    expect(status).toEqual([204, 204, 204, 429]);
  });
});

describe('produto e mix com usuário de 1 loja × produto de 2 lojas (decisões 87, 88)', () => {
  let produtoId: string;
  let restrito: string;

  beforeAll(async () => {
    restrito = (
      await usuarioCom(
        'gerente1',
        'gerente',
        [loja1],
        [
          ['produtos.ver_custo', 'negar'],
          ['auditoria.ver', 'conceder'],
        ],
      )
    ).token;
    const r = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({
        nome: 'CERV LOJAS',
        unidadeId: un,
        precoCusto: '2',
        precoVenda: '3,49',
        lojas: [
          { lojaId: loja1, precoVenda: '3,39' },
          { lojaId: loja2, precoVenda: '3,29', estoqueMinimo: '10' },
        ],
        precosQuantidade: [
          { lojaId: null, quantidadeInicial: '6', quantidadeFinal: null, preco: '3,30' },
          { lojaId: loja1, quantidadeInicial: '12', quantidadeFinal: null, preco: '3,10' },
          { lojaId: loja2, quantidadeInicial: '12', quantidadeFinal: null, preco: '2,99' },
        ],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    produtoId = r.body.id;
  });

  it('o detalhe esconde a loja 2; gravar sem as linhas dela as preserva; enviá-las → 403', async () => {
    const d = await amb.http().get(`/api/produtos/${produtoId}`).set(bearer(restrito));
    expect(d.status).toBe(200);
    expect((d.body.lojas as Array<{ lojaId: string }>).map((l) => l.lojaId)).toEqual([loja1]);
    expect((d.body.precosQuantidade as Array<{ lojaId: string | null }>).map((f) => f.lojaId).sort()).toEqual(
      [loja1, null].sort(),
    );
    const salvo = await amb
      .http()
      .put(`/api/produtos/${produtoId}`)
      .set(bearer(restrito))
      .send({
        ...d.body,
        precoCusto: undefined,
        markupPct: undefined,
        nome: 'CERV LOJAS ALTERADA',
        precosQuantidade: d.body.precosQuantidade.slice(0, 1),
      });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    const faixas = await consultar<{ loja_id: string | null; preco: string }>(
      emp.nomeBanco,
      `select loja_id, preco::text from produtos_precos_quantidade
        where produto_id = $1 and excluido_em is null order by preco`,
      [produtoId],
    );
    // A da loja 2 ficou; a da loja 1 (omitida) saiu.
    expect(faixas.map((f) => f.loja_id)).toContain(loja2);
    expect(faixas.map((f) => f.loja_id)).not.toContain(loja1);
    const completo = await amb.http().get(`/api/produtos/${produtoId}`).set(bearer(admin));
    const comLoja2 = await amb
      .http()
      .put(`/api/produtos/${produtoId}`)
      .set(bearer(restrito))
      .send({
        ...salvo.body,
        precoCusto: undefined,
        markupPct: undefined,
        versao: completo.body.versao,
        precosQuantidade: completo.body.precosQuantidade,
      });
    expect(comLoja2.status).toBe(403);
  });

  it('auditoria do produto: sem ver_custo não vê custo; linhas da loja 2 somem', async () => {
    const r = await amb
      .http()
      .get(`/api/auditoria?entidade=produtos&registro_id=${produtoId}`)
      .set(bearer(restrito));
    expect(r.status).toBe(200);
    expect(r.body.itens.length).toBeGreaterThan(0);
    const texto = JSON.stringify(
      r.body.itens.map((i: { antes: unknown; depois: unknown }) => [i.antes, i.depois]),
    );
    expect(texto).not.toMatch(/precoCusto|preco_custo|custoMedio|custo_medio|markup/);
    expect(texto).not.toContain(loja2);
    const doAdmin = await amb
      .http()
      .get(`/api/auditoria?entidade=produtos&registro_id=${produtoId}`)
      .set(bearer(admin));
    expect(JSON.stringify(doAdmin.body.itens)).toMatch(/precoCusto|preco_custo/);
  });

  it('mix: faixa da loja 2 não é criada pelo restrito (403) e a existente é preservada', async () => {
    const g = await amb
      .http()
      .post('/api/grupos-preco-quantidade')
      .set(bearer(admin))
      .send({
        nome: 'LATAS 350 MIX',
        modoPreco: 'grupo',
        faixas: [
          { lojaId: null, quantidadeInicial: '12', quantidadeFinal: null, preco: '2,99' },
          { lojaId: loja2, quantidadeInicial: '24', quantidadeFinal: null, preco: '2,79' },
        ],
        produtos: [],
      });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const d = await amb.http().get(`/api/grupos-preco-quantidade/${g.body.id}`).set(bearer(restrito));
    expect((d.body.faixas as Array<{ lojaId: string | null }>).map((f) => f.lojaId)).toEqual([null]);
    const corpo = {
      versao: d.body.versao,
      nome: d.body.nome,
      modoPreco: 'grupo',
      ativo: true,
      produtos: [],
      faixas: d.body.faixas,
    };
    const invasao = await amb
      .http()
      .put(`/api/grupos-preco-quantidade/${g.body.id}`)
      .set(bearer(restrito))
      .send({
        ...corpo,
        faixas: [
          ...corpo.faixas,
          { id: null, lojaId: loja2, quantidadeInicial: '6', quantidadeFinal: '11', preco: '1' },
        ],
      });
    expect(invasao.status).toBe(403);
    const ok = await amb
      .http()
      .put(`/api/grupos-preco-quantidade/${g.body.id}`)
      .set(bearer(restrito))
      .send({ ...corpo, nome: 'LATAS 350 MIX (ALT)' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from grupos_preco_quantidade_faixas where grupo_id = $1 and loja_id = $2 and excluido_em is null',
      [g.body.id, loja2],
    );
    expect(n!.n).toBe(1);
    const produto = await amb
      .http()
      .put(`/api/grupos-preco-quantidade/${g.body.id}`)
      .set(bearer(restrito))
      .send({ ...corpo, versao: ok.body.versao, modoPreco: 'produto', faixas: [] });
    expect(produto.status).toBe(403);
  });

  it('auditoria de usuário: salário só com usuarios.ver_dados_rh', async () => {
    const r = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(admin))
      .send({ nome: 'Totem RH', login: 'totemrh', totem: true, salario: '2500', lojas: [loja1] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = await amb
      .http()
      .get(`/api/auditoria?entidade=usuarios&registro_id=${r.body.usuario.id}`)
      .set(bearer(restrito));
    expect(a.status).toBe(200);
    expect(a.body.itens.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.body.itens)).not.toContain('"salario"');
    const doAdmin = await amb
      .http()
      .get(`/api/auditoria?entidade=usuarios&registro_id=${r.body.usuario.id}`)
      .set(bearer(admin));
    expect(JSON.stringify(doAdmin.body.itens)).toContain('"salario"');
  });
});
