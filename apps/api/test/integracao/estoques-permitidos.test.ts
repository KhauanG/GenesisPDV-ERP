/**
 * Estoques permitidos de verdade (Fase 2, F2-B5; ERP 2.1; MD 3.3.5; F2-Q4 (a) = D45; README › decisões 89 e 149):
 * quem não é Master nem tem `estoques.todos` só vê e movimenta os estoques de `usuarios_estoques`, inclusive o CD.
 * Escalada por id direto e por filtro (acerto, saldos, produto, dashboard, importação, locais de estoque e lojas), o
 * estoque excluído (some da lista de quem o tinha sem travar a edição do usuário), a virada da migração 0019 (mesma
 * visão antes e depois, para cada perfil padrão, sem ganho pelos "adicionais" da Fase 1) e o usuário criado depois.
 */
import { readFileSync } from 'node:fs';
import { completarCnpj, PERFIS_PADRAO } from '@genesis/shared';
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
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

let amb: Ambiente;
let s3: S3Falso | null = null;
let emp: EmpresaTeste;
let admin: string;
let loja1: string;
let loja2: string;
let estoque1: string;
let estoque2: string;
let cd: string;
/** "Depósito da Loja 1": sem loja, criado pelo gerente restrito (passo "quem cria um estoque"). */
let deposito: string;
/** Estoque sem loja excluído direto no banco com os vínculos vivos (dado de antes da correção da exclusão). */
let antigo: string;
let cerveja: string;
/** Gerente com as lojas 1 e 2, mas só o estoque da loja 1 permitido. */
let restrito: { id: string; token: string };
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function estoqueDaLoja(loja: string): Promise<string> {
  const [l] = await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [loja],
  );
  return l!.estoque_id;
}

/** Acerto de Entrada do admin, já efetivado (saldo para as consultas). */
async function entradaEfetivada(estoqueId: string, quantidade: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/acertos')
    .set(bearer(admin))
    .send({
      estoqueId,
      tipoAjuste: 'entrada',
      dataContagem: horasAtras(1),
      motivo: 'Saldo inicial',
      itens: [{ produtoId: cerveja, quantidade, custoUnitario: '2' }],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const e = await amb
    .http()
    .post(`/api/acertos/${r.body.id}/efetivar`)
    .set(bearer(admin))
    .send({ versao: r.body.versao });
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  return r.body.id as string;
}

/** Ids dos estoques que a listagem devolve ao token. */
async function idsVisiveis(token: string): Promise<string[]> {
  const r = await amb.http().get('/api/estoques').set(bearer(token)).query({ tamanho: 'todos' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body.itens as Array<{ id: string }>).map((e) => e.id).sort();
}

beforeAll(async () => {
  // A prévia da importação grava a planilha no armazenamento (S3 em memória, como em importacao-dashboard).
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      DASHBOARD_CACHE_MS: '0',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-estoques-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Petiscaria 2');
  estoque1 = await estoqueDaLoja(loja1);
  estoque2 = await estoqueDaLoja(loja2);
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD - Estoque Ice Beer', 'deposito') returning id",
  );
  cd = c!.id;
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer(admin));
  const un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;
  const p = await amb
    .http()
    .post('/api/produtos')
    .set(bearer(admin))
    .send({
      nome: 'CERV BRAHMA LT 350ML',
      codigoInterno: 'BRAHMA350',
      unidadeId: un,
      precoCusto: '2',
      precoVenda: '3,49',
      // Estoque mínimo nas duas lojas: o dashboard mostra "abaixo do mínimo" por loja.
      lojas: [
        { lojaId: loja1, estoqueMinimo: '500' },
        { lojaId: loja2, estoqueMinimo: '500' },
      ],
    });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  cerveja = p.body.id;
  await entradaEfetivada(estoque1, '10');
  await entradaEfetivada(estoque2, '20');
  await entradaEfetivada(cd, '30');
  const id = await criarUsuario(emp.nomeBanco, {
    login: 'gerente1',
    perfil: 'gerente',
    lojas: [loja1, loja2],
    estoques: [estoque1],
  });
  restrito = { id, token: await amb.entrar(emp.codigo, 'gerente1', SENHA_TESTE) };
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

describe('escalada: só os estoques permitidos (decisão 149)', () => {
  it('locais de estoque: a listagem e o detalhe mostram só o estoque da loja 1 (nem a loja 2 nem o CD)', async () => {
    expect(await idsVisiveis(restrito.token)).toEqual([estoque1]);
    for (const fora of [estoque2, cd]) {
      const r = await amb.http().get(`/api/estoques/${fora}`).set(bearer(restrito.token));
      expect(r.status).toBe(404);
    }
    // O Master continua vendo tudo.
    expect(await idsVisiveis(admin)).toEqual([estoque1, estoque2, cd].sort());
  });

  it('acerto: criar no CD é 403; abrir, excluir, efetivar e estornar o do CD pelo id é 404; o filtro não lista', async () => {
    const criar = await amb
      .http()
      .post('/api/acertos')
      .set(bearer(restrito.token))
      .send({
        estoqueId: cd,
        tipoAjuste: 'saida',
        dataContagem: horasAtras(1),
        motivo: 'Tentativa',
        itens: [{ produtoId: cerveja, quantidade: '1' }],
      });
    expect(criar.status, JSON.stringify(criar.body)).toBe(403);
    expect(criar.body.campos.estoqueId).toBeDefined();

    // Rascunho do admin no CD: o restrito não o enxerga por nenhum caminho.
    const rascunho = await amb
      .http()
      .post('/api/acertos')
      .set(bearer(admin))
      .send({
        estoqueId: cd,
        tipoAjuste: 'saida',
        dataContagem: horasAtras(1),
        motivo: 'Rascunho do CD',
        itens: [{ produtoId: cerveja, quantidade: '1' }],
      });
    expect(rascunho.status).toBe(201);
    const id = rascunho.body.id as string;
    const versao = rascunho.body.versao as number;
    expect((await amb.http().get(`/api/acertos/${id}`).set(bearer(restrito.token))).status).toBe(404);
    const efetivar = await amb
      .http()
      .post(`/api/acertos/${id}/efetivar`)
      .set(bearer(restrito.token))
      .send({ versao });
    expect(efetivar.status).toBe(404);
    const excluir = await amb.http().delete(`/api/acertos/${id}`).set(bearer(restrito.token));
    expect(excluir.status).toBe(404);
    const [efetivadoNoCd] = await consultar<{ id: string; versao: number }>(
      emp.nomeBanco,
      "select id, versao from acertos_estoque where estoque_id = $1 and status = 'efetivado' limit 1",
      [cd],
    );
    const estornar = await amb
      .http()
      .post(`/api/acertos/${efetivadoNoCd!.id}/estornar`)
      .set(bearer(restrito.token))
      .send({ versao: Number(efetivadoNoCd!.versao), motivo: 'Tentativa' });
    expect(estornar.status, JSON.stringify(estornar.body)).toBe(404);
    const [situacao] = await consultar<{ status: string }>(
      emp.nomeBanco,
      'select status from acertos_estoque where id = $1',
      [id],
    );
    expect(situacao!.status).toBe('rascunho');

    const porFiltro = await amb
      .http()
      .get('/api/acertos')
      .set(bearer(restrito.token))
      .query({ estoqueId: cd });
    expect(porFiltro.status).toBe(200);
    expect(porFiltro.body.total).toBe(0);
    const todos = await amb.http().get('/api/acertos').set(bearer(restrito.token));
    expect(new Set((todos.body.itens as Array<{ estoqueId: string }>).map((a) => a.estoqueId))).toEqual(
      new Set([estoque1]),
    );
    // No estoque permitido, o acerto segue normal.
    const ok = await amb
      .http()
      .post('/api/acertos')
      .set(bearer(restrito.token))
      .send({
        estoqueId: estoque1,
        tipoAjuste: 'saida',
        dataContagem: horasAtras(1),
        motivo: 'Quebra',
        itens: [{ produtoId: cerveja, quantidade: '1' }],
      });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('saldos: o filtro pelo CD vem vazio, a lista sem filtro só traz a loja 1 e a grade do acerto no CD é 404', async () => {
    const porFiltro = await amb
      .http()
      .get('/api/saldos-estoque')
      .set(bearer(restrito.token))
      .query({ estoqueId: cd });
    expect(porFiltro.status).toBe(200);
    expect(porFiltro.body.total).toBe(0);
    const todos = await amb.http().get('/api/saldos-estoque').set(bearer(restrito.token));
    expect(new Set((todos.body.itens as Array<{ estoqueId: string }>).map((s) => s.estoqueId))).toEqual(
      new Set([estoque1]),
    );
    const semMovimento = await amb
      .http()
      .get('/api/saldos-estoque')
      .set(bearer(restrito.token))
      .query({ incluirSemMovimento: 'true', tamanho: 'todos' });
    expect(semMovimento.status, JSON.stringify(semMovimento.body)).toBe(200);
    expect(
      new Set((semMovimento.body.itens as Array<{ estoqueId: string }>).map((s) => s.estoqueId)),
    ).toEqual(new Set([estoque1]));
    const grade = await amb
      .http()
      .get('/api/saldos-estoque/itens')
      .set(bearer(restrito.token))
      .query({ estoqueId: cd, produtoIds: cerveja });
    expect(grade.status).toBe(404);
  });

  it('produto: GET /produtos/:id/saldos traz só o estoque permitido', async () => {
    const r = await amb.http().get(`/api/produtos/${cerveja}/saldos`).set(bearer(restrito.token));
    expect(r.status).toBe(200);
    expect((r.body.saldos as Array<{ estoqueId: string }>).map((s) => s.estoqueId)).toEqual([estoque1]);
    const doAdmin = await amb.http().get(`/api/produtos/${cerveja}/saldos`).set(bearer(admin));
    expect(new Set((doAdmin.body.saldos as Array<{ estoqueId: string }>).map((s) => s.estoqueId))).toEqual(
      new Set([estoque1, estoque2, cd]),
    );
  });

  it('dashboard: "abaixo do mínimo" só da loja cujo estoque é permitido', async () => {
    const r = await amb.http().get('/api/dashboard').set(bearer(restrito.token));
    expect(r.status).toBe(200);
    expect((r.body.estoqueBaixo as Array<{ lojaNome: string }>).map((e) => e.lojaNome)).toEqual(['Loja 1']);
    const doAdmin = await amb.http().get('/api/dashboard').set(bearer(admin));
    expect(
      new Set((doAdmin.body.estoqueBaixo as Array<{ lojaNome: string }>).map((e) => e.lojaNome)),
    ).toEqual(new Set(['Loja 1', 'Petiscaria 2']));
  });

  it('importação: "Atualizar estoque" na loja 2 (loja permitida, estoque não) é 403 na prévia e na confirmação', async () => {
    const csv = Buffer.from(
      'Ref. Interna;Produto;Venda;Estoque atual\nBRAHMA350;CERV BRAHMA LT 350ML;3,49;99\n',
    );
    const previa = (lojaId: string, atualizarEstoque: boolean) =>
      amb
        .http()
        .post('/api/importacoes/produtos/previa')
        .set(bearer(restrito.token))
        .field('lojaId', lojaId)
        .field('atualizarEstoque', String(atualizarEstoque))
        .field('dataContagem', new Date().toISOString())
        .attach('arquivo', csv, 'contagem.csv');
    const negada = await previa(loja2, true);
    expect(negada.status, JSON.stringify(negada.body)).toBe(403);
    expect(negada.body.campos.atualizarEstoque).toBeDefined();
    // Sem "Atualizar estoque" a loja 2 serve (o cadastro é da loja, não do estoque).
    const semEstoque = await previa(loja2, false);
    expect(semEstoque.status, JSON.stringify(semEstoque.body)).toBe(200);
    const confirmar = await amb
      .http()
      .post('/api/importacoes/produtos/confirmar')
      .set(bearer(restrito.token))
      .send({
        arquivoId: semEstoque.body.arquivoId,
        lojaId: loja2,
        atualizarEstoque: true,
        dataContagem: new Date().toISOString(),
      });
    expect(confirmar.status, JSON.stringify(confirmar.body)).toBe(403);
    // Na loja 1 (estoque permitido) a prévia com "Atualizar estoque" passa.
    expect((await previa(loja1, true)).status).toBe(200);
  });

  it('importação no CD (F2-B11): sem a loja vale o estoque escolhido; fora dos permitidos é 403 no campo', async () => {
    const csv = Buffer.from(
      'Ref. Interna;Produto;Venda;Estoque atual\nBRAHMA350;CERV BRAHMA LT 350ML;3,49;31\n',
    );
    const previa = (token: string, campos: Record<string, string>) => {
      let req = amb.http().post('/api/importacoes/produtos/previa').set(bearer(token));
      for (const [k, v] of Object.entries(campos)) req = req.field(k, v);
      return req.attach('arquivo', csv, 'contagem-cd.csv');
    };
    const noCd = { estoqueId: cd, atualizarEstoque: 'true', dataContagem: horasAtras(24) };
    // O gerente tem as duas lojas, mas não o CD: 403 no campo do estoque, antes de ler a planilha.
    const negada = await previa(restrito.token, noCd);
    expect(negada.status, JSON.stringify(negada.body)).toBe(403);
    expect(negada.body.campos.estoqueId).toBeDefined();
    // Sem "Atualizar estoque" o estoque escolhido não dispensa a loja (o cadastro por loja precisa dela).
    const semLoja = await previa(restrito.token, { estoqueId: cd });
    expect(semLoja.status, JSON.stringify(semLoja.body)).toBe(422);
    expect(semLoja.body.campos.lojaId).toBeDefined();
    // Sem a hora da contagem o "Atualizar estoque" é recusado no contrato.
    const semHora = await previa(admin, { estoqueId: cd, atualizarEstoque: 'true' });
    expect(semHora.status, JSON.stringify(semHora.body)).toBe(422);
    expect(semHora.body.campos.dataContagem).toBeDefined();
    // Quem tem o CD (e nenhuma loja) importa a contagem dele. O saldo comparado é o do CD na hora da contagem (ontem):
    // a Entrada de 30 do início lançou na efetivação, depois dela, e não conta.
    await criarUsuario(emp.nomeBanco, {
      login: 'estoquista.cd',
      perfil: 'estoquista',
      lojas: [],
      estoques: [cd],
    });
    const doCd = await amb.entrar(emp.codigo, 'estoquista.cd', SENHA_TESTE);
    const ok = await previa(doCd, noCd);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.linhas[0]).toMatchObject({
      acao: 'atualizar',
      alteracoes: [expect.objectContaining({ campo: 'estoque_atual', de: '0', para: '31' })],
    });
  });

  it('lojas: vincular a loja nova a um estoque fora dos permitidos é 403 (não vira concessão de acesso)', async () => {
    const r = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(restrito.token))
      .send({
        nome: 'CD Ice Beer',
        razaoSocial: 'CD Ice Beer Ltda',
        nomeFantasia: 'CD Ice Beer',
        cnpj: completarCnpj('112223330001'),
        tipo: 'deposito',
        usaPdv: false,
        ativa: false,
        estoqueId: cd,
        cep: '80010-000',
        logradouro: 'Rua XV de Novembro',
        numero: '100',
        bairro: 'Centro',
        uf: 'PR',
        municipioIbge: 4106902,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from usuarios_estoques where usuario_id = $1 and estoque_id = $2 and excluido_em is null',
      [restrito.id, cd],
    );
    expect(n!.n).toBe(0);
  });

  it('quem cria um estoque passa a tê-lo; `estoques.todos` dispensa a lista; perder o estoque vale na hora', async () => {
    const criado = await amb
      .http()
      .post('/api/estoques')
      .set(bearer(restrito.token))
      .send({ nome: 'Depósito da Loja 1', tipo: 'deposito' });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    expect(criado.body.nome).toBe('Depósito da Loja 1');
    deposito = criado.body.id as string;
    expect(await idsVisiveis(restrito.token)).toEqual([estoque1, criado.body.id].sort());

    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'estoques.todos', 'conceder')",
      [restrito.id],
    );
    expect(await idsVisiveis(restrito.token)).toEqual([estoque1, estoque2, cd, criado.body.id].sort());
    await consultar(
      emp.nomeBanco,
      "update usuarios_permissoes set excluido_em = now() where usuario_id = $1 and permissao = 'estoques.todos'",
      [restrito.id],
    );
    // A lista volta a valer e fica no cache de acesso da instância.
    expect(await idsVisiveis(restrito.token)).toEqual([estoque1, criado.body.id].sort());
    // Só `usuarios_estoques` muda: a geração das permissões a inclui, então a retirada vale na requisição seguinte,
    // sem esperar o cache vencer.
    await consultar(
      emp.nomeBanco,
      'update usuarios_estoques set excluido_em = now() where usuario_id = $1 and estoque_id = $2',
      [restrito.id, criado.body.id],
    );
    expect(await idsVisiveis(restrito.token)).toEqual([estoque1]);
  });

  it('locais de estoque: alterar e excluir o CD ou o da loja 2 pelo id é 404, e nada muda', async () => {
    for (const fora of [cd, estoque2]) {
      const alterar = await amb
        .http()
        .put(`/api/estoques/${fora}`)
        .set(bearer(restrito.token))
        .send({ nome: 'Tomado', tipo: 'deposito', ativo: false, versao: 1 });
      expect(alterar.status, JSON.stringify(alterar.body)).toBe(404);
      const excluir = await amb.http().delete(`/api/estoques/${fora}`).set(bearer(restrito.token));
      expect(excluir.status).toBe(404);
    }
    const linhas = await consultar<{ nome: string; ativo: boolean; excluido: boolean }>(
      emp.nomeBanco,
      'select nome, ativo, excluido_em is not null as excluido from estoques where id = any($1::uuid[]) order by nome',
      [[cd, estoque2]],
    );
    expect(linhas).toEqual([
      { nome: 'CD - Estoque Ice Beer', ativo: true, excluido: false },
      { nome: 'Estoque Petiscaria 2', ativo: true, excluido: false },
    ]);
  });

  it('acertos: alterar o do CD pelo id é 404; trocar o estoque do próprio rascunho para o CD é 403', async () => {
    const corpo = (estoqueId: string) => ({
      estoqueId,
      tipoAjuste: 'saida',
      dataContagem: horasAtras(1),
      motivo: 'Quebra',
      itens: [{ produtoId: cerveja, quantidade: '1' }],
    });
    const doCd = await amb.http().post('/api/acertos').set(bearer(admin)).send(corpo(cd));
    expect(doCd.status).toBe(201);
    const alterarDoCd = await amb
      .http()
      .put(`/api/acertos/${doCd.body.id}`)
      .set(bearer(restrito.token))
      .send({ ...corpo(estoque1), versao: doCd.body.versao });
    expect(alterarDoCd.status, JSON.stringify(alterarDoCd.body)).toBe(404);

    const proprio = await amb.http().post('/api/acertos').set(bearer(restrito.token)).send(corpo(estoque1));
    expect(proprio.status, JSON.stringify(proprio.body)).toBe(201);
    const paraOCd = await amb
      .http()
      .put(`/api/acertos/${proprio.body.id}`)
      .set(bearer(restrito.token))
      .send({ ...corpo(cd), versao: proprio.body.versao });
    expect(paraOCd.status, JSON.stringify(paraOCd.body)).toBe(403);
    expect(paraOCd.body.campos.estoqueId).toBeDefined();
    const [estoques] = await consultar<{ do_cd: string; proprio: string }>(
      emp.nomeBanco,
      `select (select estoque_id from acertos_estoque where id = $1) as do_cd,
              (select estoque_id from acertos_estoque where id = $2) as proprio`,
      [doCd.body.id, proprio.body.id],
    );
    expect(estoques).toEqual({ do_cd: cd, proprio: estoque1 });
  });

  it('lojas: trocar o estoque da loja 1 para o CD na edição é 403; a loja nova com estoque novo dá o estoque ao criador', async () => {
    const atual = await amb.http().get(`/api/lojas/${loja1}`).set(bearer(restrito.token));
    expect(atual.status).toBe(200);
    const trocar = await amb
      .http()
      .put(`/api/lojas/${loja1}`)
      .set(bearer(restrito.token))
      .send({ ...atual.body, estoqueId: cd });
    expect(trocar.status, JSON.stringify(trocar.body)).toBe(403);
    expect(await estoqueDaLoja(loja1)).toBe(estoque1);

    // Sem `estoqueId`, o assistente cria o estoque homônimo, e quem criou passa a vê-lo (`concederEstoqueAoCriador`).
    const nova = await amb
      .http()
      .post('/api/lojas')
      .set(bearer(restrito.token))
      .send({
        nome: 'Loja 3',
        razaoSocial: 'Loja 3 Ltda',
        nomeFantasia: 'Loja 3',
        cnpj: completarCnpj('445556660001'),
        tipo: 'ponto_venda',
        usaPdv: false,
        ativa: false,
        cep: '80010-000',
        logradouro: 'Rua XV de Novembro',
        numero: '300',
        bairro: 'Centro',
        uf: 'PR',
        municipioIbge: 4106902,
      });
    expect(nova.status, JSON.stringify(nova.body)).toBe(201);
    const estoque3 = await estoqueDaLoja(nova.body.id as string);
    expect(await idsVisiveis(restrito.token)).toEqual([estoque1, estoque3].sort());
    // O Master não ganha linha (vê todos de qualquer jeito).
    const [doAdmin] = await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from usuarios_estoques ue join usuarios u on u.id = ue.usuario_id where u.login = 'admin'",
    );
    expect(doAdmin!.n).toBe(0);
  });

  it('estoque excluído: os vínculos saem junto, e o editor restrito e o Master continuam gravando quem o tinha', async () => {
    // Editor restrito com "Usuários: Editar" (o Administrador do seed não tem `estoques.todos`) e o caixa alvo; os
    // dois têm o "Depósito teste", sem loja e sem movimento.
    const teste = await amb
      .http()
      .post('/api/estoques')
      .set(bearer(admin))
      .send({ nome: 'Depósito teste', tipo: 'deposito' });
    expect(teste.status, JSON.stringify(teste.body)).toBe(201);
    // Dado de antes da correção: estoque excluído direto, com os vínculos ainda vivos.
    const [a] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo, excluido_em) values ('Depósito antigo', 'deposito', now()) returning id",
    );
    antigo = a!.id;
    await criarUsuario(emp.nomeBanco, {
      login: 'adm_restrito',
      perfil: 'administrador',
      lojas: [loja1, loja2],
      estoques: [estoque1, teste.body.id, antigo],
    });
    const alvo = await criarUsuario(emp.nomeBanco, {
      login: 'caixa_deposito',
      perfil: 'operador_caixa',
      lojas: [loja1],
      estoques: [estoque1, teste.body.id, antigo],
    });
    const editor = await amb.entrar(emp.codigo, 'adm_restrito', SENHA_TESTE);

    expect((await amb.http().delete(`/api/estoques/${teste.body.id}`).set(bearer(admin))).status).toBe(204);
    const [vivos] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from usuarios_estoques where estoque_id = $1 and excluido_em is null',
      [teste.body.id],
    );
    expect(vivos!.n).toBe(0);
    expect(await idsVisiveis(editor)).toEqual([estoque1]);

    for (const [quem, token] of [
      ['editor restrito', editor],
      ['Master', admin],
    ] as const) {
      const d = await amb.http().get(`/api/usuarios/${alvo}`).set(bearer(token));
      expect(d.status, quem).toBe(200);
      // O detalhe não traz o excluído (nem o antigo, com o vínculo ainda vivo): nada de "estoque a que você não tem
      // acesso" nem de 422 "Estoque inexistente ou excluído" ao gravar sem mexer no campo.
      expect(d.body.estoques, quem).toEqual([estoque1]);
      const r = await amb
        .http()
        .put(`/api/usuarios/${alvo}`)
        .set(bearer(token))
        .send({ ...d.body, nome: `CAIXA ALTERADO PELO ${quem.toUpperCase()}` });
      expect(r.status, `${quem}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.usuario.estoques, quem).toEqual([estoque1]);
    }
  });
});

describe('usuário criado depois da virada', () => {
  it('sem estoques permitidos não vê nenhum, mesmo com a loja; o ERP grava a lista que o gerente escolher', async () => {
    const [p] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from perfis where chave_sistema = 'estoquista'",
    );
    const perfilEstoquista = p!.id;
    const r = await amb
      .http()
      .post('/api/usuarios')
      .set(bearer(admin))
      .send({
        nome: 'Atendente Teste',
        login: 'atendente.teste',
        perfilId: perfilEstoquista,
        lojas: [loja1],
        estoques: [],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.usuario.estoques).toEqual([]);
    await consultar(
      emp.nomeBanco,
      'update usuarios set senha_hash = $1, senha_provisoria = false where id = $2',
      [
        (
          await consultar<{ h: string }>(
            emp.nomeBanco,
            "select senha_hash as h from usuarios where login = 'gerente1'",
          )
        )[0]!.h,
        r.body.usuario.id,
      ],
    );
    const token = await amb.entrar(emp.codigo, 'atendente.teste', SENHA_TESTE);
    expect(await idsVisiveis(token)).toEqual([]);
    const saldos = await amb.http().get('/api/saldos-estoque').set(bearer(token));
    expect(saldos.body.total).toBe(0);
    const doProduto = await amb.http().get(`/api/produtos/${cerveja}/saldos`).set(bearer(token));
    expect(doProduto.body.saldos).toEqual([]);
  });
});

describe('virada (migração 0019): ninguém perde nem ganha acesso no deploy', () => {
  /**
   * A regra antiga (decisão 51, até a 0018): estoques das lojas permitidas e todos os sem loja. Reescrita da regra,
   * só conferência extra: o gabarito do teste são os conjuntos literais por combinação de lojas.
   */
  async function visiveisPelaRegraAntiga(usuarioId: string): Promise<string[]> {
    const linhas = await consultar<{ id: string }>(
      emp.nomeBanco,
      `select e.id from estoques e
        where e.excluido_em is null
          and not exists (select 1 from lojas lx where lx.estoque_id = e.id and lx.excluido_em is null
                            and not exists (select 1 from usuarios_lojas ul where ul.usuario_id = $1
                                              and ul.loja_id = lx.id and ul.excluido_em is null))
        order by e.id`,
      [usuarioId],
    );
    return linhas.map((l) => l.id).sort();
  }

  async function permitidosNoBanco(usuarioId: string): Promise<string[]> {
    const linhas = await consultar<{ id: string }>(
      emp.nomeBanco,
      'select estoque_id as id from usuarios_estoques where usuario_id = $1 and excluido_em is null order by 1',
      [usuarioId],
    );
    return linhas.map((l) => l.id).sort();
  }

  const migracao = readFileSync(
    new URL('../../drizzle/empresa/0019_usuarios_estoques_virada.sql', import.meta.url),
    'utf8',
  );
  const rodar = () => consultar(emp.nomeBanco, migracao);

  it('para cada perfil padrão e cada combinação de lojas, a lista de estoques visíveis antes = depois', async () => {
    // Usuários "de antes da virada": nenhuma linha em `usuarios_estoques`. Os estoques vivos neste ponto: o da loja 1,
    // o da Petiscaria 2, o da Loja 3 (criada pelo gerente restrito), o CD e o "Depósito da Loja 1" (sem loja); o
    // "Depósito teste" e o "Depósito antigo" estão excluídos. O esperado é o gabarito literal de cada combinação.
    const estoque3 = (
      await consultar<{ estoque_id: string }>(
        emp.nomeBanco,
        "select estoque_id from lojas where nome = 'Loja 3'",
      )
    )[0]!.estoque_id;
    const combinacoes: Array<[string, string[], string[]]> = [
      ['nenhuma', [], [cd, deposito]],
      ['loja1', [loja1], [estoque1, cd, deposito]],
      ['as2', [loja1, loja2], [estoque1, estoque2, cd, deposito]],
    ];
    const usuarios: Array<{ id: string; login: string; perfil: string; antes: string[] }> = [];
    for (const perfil of PERFIS_PADRAO) {
      for (const [nome, lojas, esperado] of combinacoes) {
        const login = `v_${perfil.chaveSistema}_${nome}`.slice(0, 60);
        const id = await criarUsuario(emp.nomeBanco, {
          login,
          perfil: perfil.chaveSistema,
          lojas,
          estoques: [],
        });
        const antes = await visiveisPelaRegraAntiga(id);
        expect(antes, login).toEqual([...esperado].sort());
        expect(antes, login).not.toContain(estoque3);
        usuarios.push({ id, login, perfil: perfil.chaveSistema, antes });
      }
    }
    // Usuário com "Estoques adicionais" gravados na Fase 1 (sem efeito até a 0018): o da Petiscaria 2, fora das lojas
    // dele, é encerrado (senão ele ganharia o acesso no deploy); o CD, que ele já via, fica como está; o vínculo com
    // estoque excluído também é encerrado.
    const adicional = await criarUsuario(emp.nomeBanco, {
      login: 'v_adicional',
      perfil: 'estoquista',
      lojas: [loja1],
      estoques: [estoque2, cd, antigo],
    });
    const [linhaDoCd] = await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from usuarios_estoques where usuario_id = $1 and estoque_id = $2',
      [adicional, cd],
    );
    // Usuário excluído não recebe nada; o Master não precisa (vê tudo).
    const excluido = await criarUsuario(emp.nomeBanco, {
      login: 'v_excluido',
      perfil: 'vendedor',
      lojas: [loja1],
      estoques: [],
    });
    await consultar(emp.nomeBanco, 'update usuarios set excluido_em = now() where id = $1', [excluido]);

    await rodar();
    for (const u of usuarios) {
      expect(await permitidosNoBanco(u.id), u.login).toEqual(u.antes);
      // Quem entra no ERP e vê locais de estoque confere também pela API (a sessão lê a mesma lista).
      const perfil = PERFIS_PADRAO.find((p) => p.chaveSistema === u.perfil)!;
      if (perfil.permissoes.includes('estoques.ver')) {
        const token = await amb.entrar(emp.codigo, u.login, SENHA_TESTE);
        expect(await idsVisiveis(token), u.login).toEqual(u.antes);
      }
    }
    expect(await permitidosNoBanco(excluido)).toEqual([]);
    expect(await permitidosNoBanco(adicional)).toEqual([estoque1, cd, deposito].sort());
    const encerradas = await consultar<{ id: string; estoque_id: string }>(
      emp.nomeBanco,
      'select id, estoque_id from usuarios_estoques where usuario_id = $1 and excluido_em is not null',
      [adicional],
    );
    // O histórico fica (exclusão lógica); a linha do CD é a mesma de antes, não uma cópia.
    expect(encerradas.map((l) => l.estoque_id).sort()).toEqual([estoque2, antigo].sort());
    expect(
      (
        await consultar<{ id: string }>(
          emp.nomeBanco,
          'select id from usuarios_estoques where usuario_id = $1 and estoque_id = $2 and excluido_em is null',
          [adicional, cd],
        )
      )[0]!.id,
    ).toBe(linhaDoCd!.id);
    expect(await idsVisiveis(await amb.entrar(emp.codigo, 'v_adicional', SENHA_TESTE))).toEqual(
      [estoque1, cd, deposito].sort(),
    );
    // Nenhum vínculo vivo aponta para estoque excluído (nem os do editor e do caixa do "Depósito antigo").
    const [comExcluido] = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from usuarios_estoques ue join estoques e on e.id = ue.estoque_id
        where ue.excluido_em is null and e.excluido_em is not null`,
    );
    expect(comExcluido!.n).toBe(0);
    const [master] = await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from usuarios_estoques ue join usuarios u on u.id = ue.usuario_id where u.login = 'admin'",
    );
    expect(master!.n).toBe(0);

    // Idempotente: rodar de novo não duplica nem muda nada.
    const [antes] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from usuarios_estoques where excluido_em is null',
    );
    await rodar();
    const [depois] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from usuarios_estoques where excluido_em is null',
    );
    expect(depois!.n).toBe(antes!.n);
  });
});
