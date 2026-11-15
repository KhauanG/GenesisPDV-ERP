/**
 * Revisão de segurança da Fase 1 (README › Decisões 85–92): escalada pela retirada do "negar", estoques e dados de
 * usuários de outras lojas, faixas de preço de outras lojas no produto e no mix, auditoria redigida pela visão do
 * leitor e limite de hashes argon2 por usuário. Escopo de loja dentro da empresa (decisão 207): a auditoria de usuário,
 * login e sessão segue a visibilidade do usuário, os dados de compra só dão o preço de loja permitida e excluir o mix
 * ou o produto com linha de loja oculta é recusado.
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

  it('dados de compra: o preço da loja só de loja permitida (recebimento e NF-e)', async () => {
    for (const rota of ['recebimentos', 'notas-entrada']) {
      const url = (loja: string) => `/api/${rota}/dados-produtos?produtoIds=${produtoId}&lojaId=${loja}`;
      const daLoja1 = await amb.http().get(url(loja1)).set(bearer(restrito));
      expect(daLoja1.status, JSON.stringify(daLoja1.body)).toBe(200);
      expect(Number(daLoja1.body.produtos[0].precoVendaLoja)).toBe(3.39);
      const daLoja2 = await amb.http().get(url(loja2)).set(bearer(restrito));
      expect(daLoja2.status).toBe(200);
      expect(daLoja2.body.produtos).toHaveLength(1);
      expect(daLoja2.body.produtos[0].precoVendaLoja).toBeNull();
      const peloAdmin = await amb.http().get(url(loja2)).set(bearer(admin));
      expect(Number(peloAdmin.body.produtos[0].precoVendaLoja)).toBe(3.29);
    }
  });

  it('excluir o mix com faixa de loja oculta → 403 e nada muda; sem ela, exclui', async () => {
    const criar = (nome: string, faixas: unknown[]) =>
      amb
        .http()
        .post('/api/grupos-preco-quantidade')
        .set(bearer(admin))
        .send({ nome, modoPreco: 'grupo', faixas, produtos: [] });
    const comLoja2 = await criar('MIX COM LOJA 2', [
      { lojaId: null, quantidadeInicial: '12', quantidadeFinal: null, preco: '2,99' },
      { lojaId: loja2, quantidadeInicial: '24', quantidadeFinal: null, preco: '2,79' },
    ]);
    expect(comLoja2.status, JSON.stringify(comLoja2.body)).toBe(201);
    const negado = await amb
      .http()
      .delete(`/api/grupos-preco-quantidade/${comLoja2.body.id}`)
      .set(bearer(restrito));
    expect(negado.status).toBe(403);
    expect(negado.body.codigo).toBe('SEM_PERMISSAO');
    const [vivo] = await consultar<{ grupo: boolean; faixas: number }>(
      emp.nomeBanco,
      `select (select excluido_em is null from grupos_preco_quantidade where id = $1) as grupo,
              (select count(*)::int from grupos_preco_quantidade_faixas
                where grupo_id = $1 and excluido_em is null) as faixas`,
      [comLoja2.body.id],
    );
    expect(vivo).toEqual({ grupo: true, faixas: 2 });
    const semLoja2 = await criar('MIX LOJA 1', [
      { lojaId: null, quantidadeInicial: '12', quantidadeFinal: null, preco: '2,99' },
      { lojaId: loja1, quantidadeInicial: '24', quantidadeFinal: null, preco: '2,79' },
    ]);
    expect(semLoja2.status, JSON.stringify(semLoja2.body)).toBe(201);
    const ok = await amb
      .http()
      .delete(`/api/grupos-preco-quantidade/${semLoja2.body.id}`)
      .set(bearer(restrito));
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    // Quem tem a loja 2 exclui o primeiro.
    expect(
      (await amb.http().delete(`/api/grupos-preco-quantidade/${comLoja2.body.id}`).set(bearer(admin))).status,
    ).toBe(204);
  });

  it('excluir o produto com preço ou faixa de loja oculta → 403; só com as lojas permitidas, exclui', async () => {
    const criar = (nome: string, extra: Record<string, unknown>) =>
      amb
        .http()
        .post('/api/produtos')
        .set(bearer(admin))
        .send({ nome, unidadeId: un, precoVenda: '5', ...extra });
    const comPreco = await criar('PROD PRECO LOJA 2', { lojas: [{ lojaId: loja2, precoVenda: '4,90' }] });
    const comFaixa = await criar('PROD FAIXA LOJA 2', {
      precosQuantidade: [{ lojaId: loja2, quantidadeInicial: '6', quantidadeFinal: null, preco: '4,50' }],
    });
    const daLoja1 = await criar('PROD SO LOJA 1', {
      lojas: [{ lojaId: loja1, precoVenda: '4,80' }],
      precosQuantidade: [{ lojaId: null, quantidadeInicial: '6', quantidadeFinal: null, preco: '4,50' }],
    });
    for (const r of [comPreco, comFaixa, daLoja1]) expect(r.status, JSON.stringify(r.body)).toBe(201);
    for (const r of [comPreco, comFaixa]) {
      const negado = await amb.http().delete(`/api/produtos/${r.body.id}`).set(bearer(restrito));
      expect(negado.status).toBe(403);
      const [p] = await consultar<{ vivo: boolean }>(
        emp.nomeBanco,
        'select excluido_em is null as vivo from produtos where id = $1',
        [r.body.id],
      );
      expect(p!.vivo).toBe(true);
    }
    const ok = await amb.http().delete(`/api/produtos/${daLoja1.body.id}`).set(bearer(restrito));
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    expect((await amb.http().delete(`/api/produtos/${comPreco.body.id}`).set(bearer(admin))).status).toBe(
      204,
    );
  });

  it('linha de loja excluída não é loja oculta: o restrito exclui o produto e o mix', async () => {
    // A exclusão da loja não apaga o preço, o estoque mínimo nem as faixas dela (ficam vivos no banco).
    const loja3 = await criarLoja(emp.nomeBanco, 3, 'Loja 3');
    const produto = await amb
      .http()
      .post('/api/produtos')
      .set(bearer(admin))
      .send({
        nome: 'PROD LOJA 3 FECHADA',
        unidadeId: un,
        precoVenda: '5',
        lojas: [
          { lojaId: loja1, precoVenda: '4,80' },
          { lojaId: loja3, precoVenda: '4,70', estoqueMinimo: '5' },
        ],
        precosQuantidade: [{ lojaId: loja3, quantidadeInicial: '6', quantidadeFinal: null, preco: '4,40' }],
      });
    expect(produto.status, JSON.stringify(produto.body)).toBe(201);
    const mix = await amb
      .http()
      .post('/api/grupos-preco-quantidade')
      .set(bearer(admin))
      .send({
        nome: 'MIX LOJA 3 FECHADA',
        modoPreco: 'grupo',
        faixas: [{ lojaId: loja3, quantidadeInicial: '12', quantidadeFinal: null, preco: '2,79' }],
        produtos: [],
      });
    expect(mix.status, JSON.stringify(mix.body)).toBe(201);
    // Com a loja 3 viva, ela é oculta para o restrito.
    expect((await amb.http().delete(`/api/produtos/${produto.body.id}`).set(bearer(restrito))).status).toBe(
      403,
    );
    const fechou = await amb.http().delete(`/api/lojas/${loja3}`).set(bearer(admin));
    expect(fechou.status, JSON.stringify(fechou.body)).toBe(204);
    const [vivas] = await consultar<{ precos: number; faixas: number; mix: number }>(
      emp.nomeBanco,
      `select (select count(*)::int from produtos_lojas where loja_id = $1 and excluido_em is null) as precos,
              (select count(*)::int from produtos_precos_quantidade where loja_id = $1 and excluido_em is null) as faixas,
              (select count(*)::int from grupos_preco_quantidade_faixas where loja_id = $1 and excluido_em is null) as mix`,
      [loja3],
    );
    expect(vivas).toEqual({ precos: 1, faixas: 1, mix: 1 });
    const okProduto = await amb.http().delete(`/api/produtos/${produto.body.id}`).set(bearer(restrito));
    expect(okProduto.status, JSON.stringify(okProduto.body)).toBe(204);
    const okMix = await amb
      .http()
      .delete(`/api/grupos-preco-quantidade/${mix.body.id}`)
      .set(bearer(restrito));
    expect(okMix.status, JSON.stringify(okMix.body)).toBe(204);
  });
});

describe('auditoria de usuário, login e sessão com lojas restritas (decisões 92 e 207)', () => {
  let leitor: { id: string; token: string };
  let master2: { id: string; token: string };
  let daLoja1: string;
  let daLoja2: string;
  let outroMaster: string;
  // Período explícito (ontem, calculado antes de gravar): sem `de` nem `registro_id` a rota abre em "hoje" no fuso de
  // São Paulo, e uma execução que passasse da meia-noite entre a gravação e a consulta perderia as linhas.
  let de: string;
  const auditoria = (token: string, query: string) =>
    amb.http().get(`/api/auditoria?tamanho=50&de=${de}&${query}`).set(bearer(token));

  beforeAll(async () => {
    de = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    // O "Administrador" padrão (auditoria.ver e usuarios.ver) só na loja 1.
    leitor = await usuarioCom('admloja1', 'administrador', [loja1]);
    // Um segundo Master grava os cadastros (o limite de hashes do teste é por usuário).
    await criarUsuario(emp.nomeBanco, { login: 'master2', master: true });
    master2 = {
      id: (
        await consultar<{ id: string }>(emp.nomeBanco, "select id from usuarios where login = 'master2'")
      )[0]!.id,
      token: await amb.entrar(emp.codigo, 'master2', SENHA_TESTE),
    };
    const [vendedor] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from perfis where chave_sistema = 'vendedor'",
    );
    const perfilId = vendedor!.id;
    const criar = async (corpo: Record<string, unknown>) => {
      const r = await amb.http().post('/api/usuarios').set(bearer(master2.token)).send(corpo);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.usuario.id as string;
    };
    daLoja2 = await criar({
      nome: 'Ciclano Teste',
      login: 'ciclanoteste',
      perfilId,
      cpf: '11144477735',
      telefone: '11911112222',
      observacoes: 'obs-da-loja-2',
      lojas: [loja2],
    });
    outroMaster = await criar({
      nome: 'Master Teste',
      login: 'masterteste',
      master: true,
      observacoes: 'obs-master',
    });
    daLoja1 = await criar({
      nome: 'Beltrano Teste',
      login: 'beltranoteste',
      perfilId,
      observacoes: 'obs-da-loja-1',
      lojas: [loja1],
    });
    // A linha de sessão encerrada (reuso do refresh) do Master, gravada pelo sistema.
    await consultar(
      emp.nomeBanco,
      `insert into auditoria (id, ocorrido_em, origem, usuario_id, entidade, registro_id, acao, descricao)
       values (gen_random_uuid(), now(), 'sistema', $1, 'sessoes_usuario', gen_random_uuid(), 'logout', 'Sessões encerradas')`,
      [master2.id],
    );
    // As sessões encerradas do próprio leitor e do usuário da loja 1: o `registro_id` é a sessão, o usuário é o dono.
    for (const [dono, descricao] of [
      [leitor.id, 'sessao-do-leitor'],
      [daLoja1, 'sessao-da-loja-1'],
    ] as const) {
      await consultar(
        emp.nomeBanco,
        `insert into auditoria (id, ocorrido_em, origem, usuario_id, entidade, registro_id, acao, descricao)
         values (gen_random_uuid(), now(), 'sistema', $1, 'sessoes_usuario', gen_random_uuid(), 'logout', $2)`,
        [dono, descricao],
      );
    }
    // Uma linha de login do Master com a loja 1 preenchida e o login negado de um login inexistente (sem usuário).
    await consultar(
      emp.nomeBanco,
      `insert into auditoria (id, ocorrido_em, origem, usuario_id, loja_id, entidade, registro_id, acao, descricao)
       values (gen_random_uuid(), now(), 'erp', $1, $2, 'login', $1, 'login', 'login-master-na-loja-1'),
              (gen_random_uuid(), now(), 'erp', null, null, 'login', null, 'login_negado', 'login-inexistente')`,
      [master2.id, loja1],
    );
  });

  it('o cadastro de usuário só de outra loja ou Master não aparece; o da própria loja e o próprio, sim', async () => {
    for (const alvo of [daLoja2, outroMaster]) {
      const r = await auditoria(leitor.token, `entidade=usuarios&registro_id=${alvo}`);
      expect(r.status).toBe(200);
      expect(r.body.itens).toEqual([]);
      expect(r.body.total).toBe(0);
      const doMaster = await auditoria(master2.token, `entidade=usuarios&registro_id=${alvo}`);
      expect(doMaster.body.itens.length).toBeGreaterThan(0);
    }
    const daMesmaLoja = await auditoria(leitor.token, `entidade=usuarios&registro_id=${daLoja1}`);
    expect(daMesmaLoja.body.itens.length).toBeGreaterThan(0);
    expect(JSON.stringify(daMesmaLoja.body.itens)).toContain('obs-da-loja-1');
    const proprio = await auditoria(leitor.token, `entidade=login&registro_id=${leitor.id}`);
    expect(proprio.body.itens.length).toBeGreaterThan(0);
  });

  it('login e sessão do Master não aparecem; o filtro de quem fez traz só o que é visível', async () => {
    const login = await auditoria(leitor.token, `entidade=login&usuario_id=${master2.id}`);
    expect(login.status).toBe(200);
    expect(login.body.itens).toEqual([]);
    const sessao = await auditoria(leitor.token, `entidade=sessoes_usuario&usuario_id=${master2.id}`);
    expect(sessao.body.itens).toEqual([]);
    const tudo = await auditoria(leitor.token, `usuario_id=${master2.id}`);
    expect(tudo.status).toBe(200);
    const texto = JSON.stringify(tudo.body.itens);
    expect(texto).not.toContain('obs-da-loja-2');
    expect(texto).not.toContain('obs-master');
    expect(texto).not.toContain('11144477735');
    // Só a linha do usuário da loja 1 (que o Master criou) sobra.
    expect((tudo.body.itens as Array<{ registroId: string }>).map((i) => i.registroId)).toEqual([daLoja1]);
    const doMaster = await auditoria(master2.token, `usuario_id=${master2.id}`);
    const entidades = new Set((doMaster.body.itens as Array<{ entidade: string }>).map((i) => i.entidade));
    expect([...entidades].sort()).toEqual(['login', 'sessoes_usuario', 'usuarios']);
  });

  it('a sessão vale pelo dono dela: a do próprio e a do usuário da loja aparecem', async () => {
    for (const [dono, descricao] of [
      [leitor.id, 'sessao-do-leitor'],
      [daLoja1, 'sessao-da-loja-1'],
    ] as const) {
      const r = await auditoria(leitor.token, `entidade=sessoes_usuario&usuario_id=${dono}`);
      expect(r.status).toBe(200);
      expect((r.body.itens as Array<{ descricao: string }>).map((i) => i.descricao)).toEqual([descricao]);
    }
  });

  it('login de usuário não visível com loja na linha e login de login inexistente: só quem vê todas as lojas', async () => {
    const descricoes = async (token: string) => {
      const r = await auditoria(token, 'entidade=login&texto=login-');
      expect(r.status).toBe(200);
      return (r.body.itens as Array<{ descricao: string }>).map((i) => i.descricao).sort();
    };
    expect(await descricoes(leitor.token)).toEqual([]);
    expect(await descricoes(master2.token)).toEqual(['login-inexistente', 'login-master-na-loja-1']);
  });
});
