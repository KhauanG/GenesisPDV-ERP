/**
 * Relatório **Histórico de produtos** (ERP 16.2; Fase 2, F2-B42; README da API › decisão 188).
 *
 * - O critério de pronto: a edição pelo formulário aparece como "Fulano, data/hora, Cad. prod.: Preço de venda 9,90
 *   → 10,90; EAN adicionado 789…", com a marca pelo nome e a loja alterada; a gravação passa a guardar a `descricao`
 *   legível sem os valores de custo nem o que é de loja (a tela de auditoria a mostra a todos com `auditoria.ver`).
 * - O usuário de uma loja só que grava o produto não deixa as outras lojas "removidas" no histórico (o `depois` das
 *   lojas e das faixas vem do banco).
 * - O escopo de quem consulta: sem `produtos.ver_custo`, nada de custo (no texto e no "ver diferença completa"); as
 *   lojas e as linhas de loja fora das permitidas não aparecem.
 * - O período obrigatório (e o teto de 366 dias), a consulta só nas partições do período (`EXPLAIN`), os filtros
 *   (texto sem acento, usuário, tipo G/E/R/I, produto), a paginação, a legenda e a localização mapeadas, as ações e as
 *   entidades de fora (exportação, marca), o 404 do detalhe fora do produto e as permissões.
 *
 * Nomes, códigos e EANs inventados (repositório público).
 */
import type { DetalheHistoricoProduto, RespostaHistoricoProdutos } from '@genesis/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlHistoricoProdutos } from '../../src/relatorios/historico-produtos.js';
import { LOCALIZACAO_ALERTA_CADASTRO_PDV } from '../../src/sync/handlers/alertas.js';
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
let adminId: string;
/** Só da Loja Centro, sem `produtos.ver_custo`: vê e exporta o relatório e edita produto. */
let restrito: string;
let restritoId: string;
let estoquista: string;
let un: string;
let lojaCentro: string;
let lojaPraia: string;
let marcaId: string;
let produtoId: string;
let excluidoId: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** EAN-13 válido a partir de 12 dígitos (o dígito verificador do GTIN). */
function ean13(base: string): string {
  const soma = [...base].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${base}${(10 - (soma % 10)) % 10}`;
}
const EAN1 = ean13('789000042001');
const EAN2 = ean13('789000042002');

/** Hoje (`AAAA-MM-DD`) no fuso da empresa de teste (o de Brasília). */
const diaEmBrasilia = (deslocamentoDias = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    new Date(Date.now() + deslocamentoDias * 86_400_000),
  );
/** Só hoje: o `EXPLAIN` (uma partição, duas no fim do mês) e as recusas. */
const HOJE = () => ({ dataInicial: diaEmBrasilia(), dataFinal: diaEmBrasilia() });
/**
 * O período padrão das consultas, de ontem a hoje: as linhas são gravadas no `beforeAll` e nos testes anteriores, e a
 * meia-noite de Brasília no meio da execução não as tira do período (a empresa é nova, sem linhas de ontem).
 */
const PERIODO = () => ({ dataInicial: diaEmBrasilia(-1), dataFinal: diaEmBrasilia() });

const consulta = (query: Record<string, string>, token = admin) =>
  amb.http().get('/api/relatorios/historico-produtos').query(query).set(bearer(token));

async function historico(query: Record<string, string> = {}, token = admin) {
  const r = await consulta({ ...PERIODO(), ...query }, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RespostaHistoricoProdutos;
}

async function detalhe(linha: { id: string; ocorridoEm: string }, token = admin) {
  const r = await amb
    .http()
    .get(`/api/relatorios/historico-produtos/${linha.id}`)
    .query({ ocorridoEm: linha.ocorridoEm })
    .set(bearer(token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as DetalheHistoricoProduto;
}

async function editar(id: string, token: string, mudar: (atual: Record<string, unknown>) => object) {
  const atual = (await amb.http().get(`/api/produtos/${id}`).set(bearer(token))).body as Record<
    string,
    unknown
  >;
  const r = await amb
    .http()
    .put(`/api/produtos/${id}`)
    .set(bearer(token))
    .send({ ...atual, ...mudar(atual) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Uma linha de auditoria escrita direto (a tabela só aceita inserção): as origens e os meses que a tela não gera. */
async function inserirAuditoria(c: {
  ocorridoEm?: string;
  origem?: string;
  entidade?: string;
  acao?: string;
  lojaId?: string | null;
  localizacao?: string | null;
  descricao?: string | null;
  antes?: object | null;
  depois?: object | null;
}) {
  const [l] = await consultar<{ id: string; ocorrido_em: Date }>(
    emp.nomeBanco,
    `insert into auditoria (id, ocorrido_em, origem, usuario_id, usuario_nome, entidade, registro_id, acao, localizacao,
                            descricao, antes, depois, loja_id)
     values (gen_random_uuid(), coalesce($1::timestamptz, now()), $2, $3, 'ADMIN TESTE', $4, $5, $6, $7, $8, $9, $10, $11)
     returning id, ocorrido_em`,
    [
      c.ocorridoEm ?? null,
      c.origem ?? 'erp',
      adminId,
      c.entidade ?? 'produtos',
      produtoId,
      c.acao ?? 'editar',
      c.localizacao ?? null,
      c.descricao ?? null,
      c.antes === undefined ? null : JSON.stringify(c.antes),
      c.depois === undefined ? null : JSON.stringify(c.depois),
      c.lojaId ?? null,
    ],
  );
  return { id: l!.id, ocorridoEm: new Date(l!.ocorrido_em).toISOString() };
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  [{ id: adminId }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from usuarios where login = 'admin'",
  )) as [{ id: string }];
  lojaCentro = await criarLoja(emp.nomeBanco, 1, 'Centro Teste');
  lojaPraia = await criarLoja(emp.nomeBanco, 2, 'Praia Teste');
  const [{ id: perfil }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into perfis (nome, descricao, chave_sistema) values ('teste_historico', 'teste', 'teste_historico') returning id",
  )) as [{ id: string }];
  for (const permissao of [
    'relatorios.historico_produtos',
    'relatorios.exportar',
    'produtos.ver',
    'produtos.editar',
  ])
    await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
      perfil,
      permissao,
    ]);
  restritoId = await criarUsuario(emp.nomeBanco, {
    login: 'restrito',
    nome: 'FULANO RESTRITO',
    perfil: 'teste_historico',
    lojas: [lojaCentro],
  });
  restrito = await amb.entrar(emp.codigo, 'restrito', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer(admin));
  un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;
  const m = await amb
    .http()
    .post('/api/marcas')
    .set(bearer(admin))
    .send({ descricao: 'MARCA HISTORICO TESTE' });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  marcaId = m.body.id as string;

  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer(admin))
    .send({
      nome: 'CERVEJA HISTORICO TESTE',
      unidadeId: un,
      precoCusto: '5,00',
      precoVenda: '9,90',
      codigosBarras: [{ codigo: EAN1, principal: true }],
      lojas: [
        { lojaId: lojaCentro, precoVenda: '9,50' },
        { lojaId: lojaPraia, precoVenda: '9,70' },
      ],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  produtoId = r.body.id as string;

  // O critério de pronto: o preço, o EAN novo, o custo, a marca e o preço da Loja Praia, pelo administrador.
  await editar(produtoId, admin, (atual) => ({
    precoVenda: '10,90',
    precoCusto: '5,50',
    marcaId,
    codigosBarras: [...(atual.codigosBarras as object[]), { codigo: EAN2, principal: false }],
    lojas: [
      { lojaId: lojaCentro, precoVenda: '9,50' },
      { lojaId: lojaPraia, precoVenda: '9,80' },
    ],
  }));
  // O usuário só da Loja Centro: o corpo dele não traz a Loja Praia (a gravação a preserva).
  // Sem o custo (o detalhe dele vem nulo; o formulário não o manda e a gravação o ignora).
  await editar(produtoId, restrito, () => ({
    localizacao: 'GONDOLA 3',
    precoCusto: undefined,
    markupPct: undefined,
  }));

  // Um segundo produto, excluído (a "E" da legenda).
  const x = await amb
    .http()
    .post('/api/produtos')
    .set(bearer(admin))
    .send({ nome: 'PRODUTO EXCLUIDO HISTORICO TESTE', unidadeId: un, precoVenda: '3' });
  expect(x.status, JSON.stringify(x.body)).toBe(201);
  excluidoId = x.body.id as string;
  const d = await amb.http().delete(`/api/produtos/${excluidoId}`).set(bearer(admin));
  expect(d.status, JSON.stringify(d.body)).toBe(204);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('Histórico de produtos (ERP 16.2; F2-B42)', () => {
  it('o critério de pronto: quem, quando, onde e o texto legível da edição, a mais recente primeiro', async () => {
    const r = await historico({ produtoId });
    expect(r.total).toBe(3);
    const [doRestrito, doAdmin, criacao] = r.itens;
    expect(doAdmin).toMatchObject({
      tipo: 'G',
      acao: 'editar',
      localizacao: 'Cad. prod.',
      usuarioId: adminId,
      produto: { id: produtoId, nome: 'CERVEJA HISTORICO TESTE', excluido: false },
    });
    expect(doAdmin!.historico).toBe(
      [
        'Preço de custo: 5,00 → 5,50',
        'Preço de venda: 9,90 → 10,90',
        'Marca: — → MARCA HISTORICO TESTE',
        `EAN adicionado ${EAN2}`,
        'Loja Praia Teste: Preço de venda 9,70 → 9,80',
      ].join('; '),
    );
    // O da Loja Centro não deixou a Loja Praia "removida".
    expect(doRestrito).toMatchObject({ usuarioId: restritoId, usuarioNome: 'FULANO RESTRITO', tipo: 'G' });
    expect(doRestrito!.historico).toBe('Localização: — → GONDOLA 3');
    expect(criacao).toMatchObject({ tipo: 'G', acao: 'criar', localizacao: 'Cad. prod.' });
    expect(criacao!.historico).toContain(`EAN adicionado ${EAN1}`);
    expect(new Date(doAdmin!.ocorridoEm).getTime()).toBeLessThanOrEqual(
      new Date(doRestrito!.ocorridoEm).getTime(),
    );
  });

  it('a gravação guarda a descrição legível sem valores de custo nem o que é de loja (a tela de auditoria a mostra)', async () => {
    const linhas = await consultar<{ acao: string; descricao: string | null }>(
      emp.nomeBanco,
      "select acao, descricao from auditoria where entidade = 'produtos' and registro_id = $1 order by ocorrido_em",
      [produtoId],
    );
    expect(linhas.map((l) => l.acao)).toEqual(['criar', 'editar', 'editar']);
    expect(linhas[1]!.descricao).toBe(
      [
        'Preço de custo: (alterado)',
        'Preço de venda: 9,90 → 10,90',
        'Marca: — → MARCA HISTORICO TESTE',
        `EAN adicionado ${EAN2}`,
        'Dados de loja alterados',
      ].join('; '),
    );
    expect(linhas[0]!.descricao).toContain('Preço de custo: (preenchido)');
    for (const l of linhas) expect(l.descricao).not.toMatch(/5,00|5,50|9,70|9,80|Praia/);
    expect(linhas[2]!.descricao).toBe('Localização: — → GONDOLA 3');
  });

  it('sem produtos.ver_custo e só com a Loja Centro: nada de custo nem da Loja Praia, no texto e na diferença completa', async () => {
    const r = await historico({ produtoId }, restrito);
    const doAdmin = r.itens[1]!;
    expect(doAdmin.historico).toBe(
      ['Preço de venda: 9,90 → 10,90', 'Marca: — → MARCA HISTORICO TESTE', `EAN adicionado ${EAN2}`].join(
        '; ',
      ),
    );
    for (const l of r.itens) expect(l.historico).not.toMatch(/custo|Markup|Praia|9,70|9,80|5,00|5,50/i);
    const det = await detalhe(doAdmin, restrito);
    expect(det.alteracoes).toEqual([
      { campo: 'Preço de venda', antes: '9,90', depois: '10,90' },
      { campo: 'Marca', antes: '—', depois: 'MARCA HISTORICO TESTE' },
      { campo: `EAN ${EAN2}`, antes: '—', depois: 'Adicionado' },
    ]);
    // A criação, completa para quem vê tudo; sem o custo e a Loja Praia para o restrito.
    const criacao = r.itens[2]!;
    expect(JSON.stringify(await detalhe(criacao, restrito))).not.toMatch(/custo|Markup|Praia/i);
    const completa = await detalhe(criacao);
    expect(completa.alteracoes).toEqual(
      expect.arrayContaining([
        { campo: 'Preço de custo', antes: '—', depois: '5,00' },
        { campo: 'Loja Praia Teste', antes: '—', depois: 'Preço de venda 9,70' },
      ]),
    );
    // O administrador vê o custo com os valores na diferença completa.
    expect((await detalhe(r.itens[1]!)).alteracoes[0]).toEqual({
      campo: 'Preço de custo',
      antes: '5,00',
      depois: '5,50',
    });
  });

  it('a linha de uma loja fora das permitidas não aparece (nem pelo detalhe); a de outra entidade e a exportação também não', async () => {
    const daPraia = await inserirAuditoria({ lojaId: lojaPraia, descricao: 'Linha da Loja Praia' });
    const marca = await inserirAuditoria({ entidade: 'marcas', descricao: 'Linha de marca' });
    await inserirAuditoria({ acao: 'exportar', descricao: 'Exportação CSV com 1 linha(s)' });
    const admin1 = await historico({ produtoId });
    expect(admin1.itens.map((l) => l.id)).toContain(daPraia.id);
    expect(admin1.itens.map((l) => l.historico)).not.toContain('Exportação CSV com 1 linha(s)');
    expect(admin1.itens.map((l) => l.id)).not.toContain(marca.id);
    const doRestrito = await historico({ produtoId }, restrito);
    expect(doRestrito.itens.map((l) => l.id)).not.toContain(daPraia.id);
    expect(doRestrito.total).toBe(admin1.total - 1);
    const fora = await amb
      .http()
      .get(`/api/relatorios/historico-produtos/${daPraia.id}`)
      .query({ ocorridoEm: daPraia.ocorridoEm })
      .set(bearer(restrito));
    expect(fora.status).toBe(404);
    const deMarca = await amb
      .http()
      .get(`/api/relatorios/historico-produtos/${marca.id}`)
      .query({ ocorridoEm: marca.ocorridoEm })
      .set(bearer(admin));
    expect(deMarca.status).toBe(404);
  });

  it('a legenda G/E/R/I e a localização mapeadas, com o filtro do tipo', async () => {
    const imp = await inserirAuditoria({
      origem: 'importacao',
      localizacao: 'Produtos › Importação',
      antes: { nome: 'A', precoVenda: '1' },
      depois: { nome: 'A', precoVenda: '2' },
    });
    const api = await inserirAuditoria({
      origem: 'api',
      localizacao: 'Produtos › Cadastro de produtos',
      antes: { nome: 'A', ncm: null },
      depois: { nome: 'A', ncm: '22030000' },
    });
    await inserirAuditoria({ acao: 'restaurar' });
    const r = await historico({ produtoId });
    const porId = new Map(r.itens.map((l) => [l.id, l]));
    expect(porId.get(imp.id)).toMatchObject({
      tipo: 'I',
      localizacao: 'Importação',
      historico: 'Preço de venda: 1,00 → 2,00',
    });
    expect(porId.get(api.id)).toMatchObject({
      tipo: 'G',
      localizacao: 'API',
      historico: 'NCM: — → 22030000',
    });
    expect((await historico({ tipo: 'I' })).itens.map((l) => l.id)).toEqual([imp.id]);
    expect((await historico({ tipo: 'R', produtoId })).itens.map((l) => l.historico)).toEqual([
      'Produto restaurado',
    ]);
    const exclusao = await historico({ tipo: 'E' });
    expect(exclusao.itens).toHaveLength(1);
    expect(exclusao.itens[0]).toMatchObject({
      acao: 'excluir',
      historico: expect.stringMatching(/^Produto \d+ - PRODUTO EXCLUIDO HISTORICO TESTE excluído$/),
      produto: { id: excluidoId, excluido: true },
    });
    // O "ver diferença completa" da exclusão mostra o cadastro que existia.
    expect((await detalhe(exclusao.itens[0]!)).alteracoes).toEqual(
      expect.arrayContaining([{ campo: 'Nome', antes: 'PRODUTO EXCLUIDO HISTORICO TESTE', depois: '—' }]),
    );
  });

  it('os filtros de texto (sem acento nem caixa), usuário e produto, e a paginação', async () => {
    const gondola = await historico({ texto: 'gondola' });
    expect(gondola.itens.map((l) => l.usuarioId)).toEqual([restritoId]);
    const preco = await historico({ texto: 'preco de venda: 9,90 → 10,90' });
    expect(preco.itens.map((l) => l.usuarioId)).toEqual([adminId]);
    // O `%` e o `_` do texto são literais.
    expect((await historico({ texto: '%' })).total).toBe(0);
    expect((await historico({ usuarioId: restritoId })).total).toBe(1);
    expect((await historico({ produtoId: excluidoId })).total).toBe(2);
    for (let i = 1; i <= 15; i++) await inserirAuditoria({ descricao: `Linha de paginação ${i}` });
    const todas = await historico({ tamanho: '50' });
    expect(todas.total).toBeGreaterThan(20);
    const p1 = await historico({ tamanho: '20', pagina: '1' });
    const p2 = await historico({ tamanho: '20', pagina: '2' });
    expect(p1.total).toBe(todas.total);
    expect([...p1.itens, ...p2.itens].map((l) => l.id)).toEqual(todas.itens.map((l) => l.id));
  });

  it('o filtro de texto no escopo de quem consulta: sem produtos.ver_custo não acha o custo; com lojas restritas, não acha o aviso de loja', async () => {
    // O administrador acha a criação ("Preço de custo: (preenchido)") e a edição ("(alterado)"), as duas com o
    // aviso "Dados de loja alterados".
    const custoAdmin = await historico({ produtoId, texto: 'custo' });
    expect(custoAdmin.itens.map((l) => l.acao).sort()).toEqual(['criar', 'editar']);
    expect((await historico({ produtoId, texto: 'dados de loja' })).itens.map((l) => l.acao).sort()).toEqual([
      'criar',
      'editar',
    ]);
    // O restrito não: o texto da linha dele nem cita o custo nem a Loja Praia, e o filtro não pode contar.
    for (const texto of ['custo', 'markup', 'preenchido', 'dados de loja', '(alterado)'])
      expect((await historico({ produtoId, texto }, restrito)).total, texto).toBe(0);
    // O resto do texto gravado continua pesquisável para ele.
    expect(
      (await historico({ produtoId, texto: 'preço de venda: 9,90 → 10,90' }, restrito)).itens.map(
        (l) => l.usuarioId,
      ),
    ).toEqual([adminId]);
    expect(
      (await historico({ produtoId, texto: `ean adicionado ${EAN2}` }, restrito)).itens.map(
        (l) => l.usuarioId,
      ),
    ).toEqual([adminId]);
  });

  it('o aviso de cadastro do caixa não é gravação do produto: fica fora (nem pelo detalhe); outra linha do PDV entra', async () => {
    const aviso = await inserirAuditoria({
      origem: 'pdv',
      acao: 'criar',
      localizacao: LOCALIZACAO_ALERTA_CADASTRO_PDV,
      descricao: 'Produto sem preço avisado pelo caixa 3: aviso de teste',
      depois: { tipo_alerta: 'sem_preco', alerta_novo: true, detalhes: null },
    });
    const doPdv = await inserirAuditoria({
      origem: 'pdv',
      localizacao: 'PDV › Outra tela',
      antes: { nome: 'A', localizacao: null },
      depois: { nome: 'A', localizacao: 'CAIXA TESTE' },
    });
    const r = await historico({ produtoId });
    const ids = r.itens.map((l) => l.id);
    expect(ids).not.toContain(aviso.id);
    expect(r.itens.find((l) => l.id === doPdv.id)).toMatchObject({
      tipo: 'G',
      localizacao: 'PDV',
      historico: 'Localização: — → CAIXA TESTE',
    });
    expect((await historico({ texto: 'avisado pelo caixa' })).total).toBe(0);
    const det = await amb
      .http()
      .get(`/api/relatorios/historico-produtos/${aviso.id}`)
      .query({ ocorridoEm: aviso.ocorridoEm })
      .set(bearer(admin));
    expect(det.status).toBe(404);
  });

  it('exportação (ERP 3.5) pela rota comum: os filtros e as colunas da tela, com o texto no escopo de quem exporta', async () => {
    const exportar = (token: string, query: Record<string, string> = {}) =>
      amb
        .http()
        .get('/api/relatorios/historico-produtos/exportar')
        .query({ formato: 'csv', ...PERIODO(), produtoId, ...query })
        .set(bearer(token));
    const tela = await historico({ produtoId, tamanho: '50' });
    const r = await exportar(admin);
    expect(r.status, r.text).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/Relatorio_Historico_Produtos_/);
    const linhas = r.text.trim().split(/\r?\n/);
    for (const c of ['Usuário', 'Tipo', 'Localização', 'Data/hora', 'Código', 'Produto', 'Histórico'])
      expect(linhas[0]).toContain(c);
    expect(linhas).toHaveLength(tela.total + 1);
    expect(r.text).toContain('Preço de custo: 5,00 → 5,50');
    expect(r.text).toContain('Loja Praia Teste: Preço de venda 9,70 → 9,80');
    expect(r.text).toContain('CERVEJA HISTORICO TESTE');
    // O filtro de tipo vale também na exportação.
    const exclusao = await exportar(admin, { produtoId: excluidoId, tipo: 'E' });
    expect(exclusao.status, exclusao.text).toBe(200);
    expect(exclusao.text.trim().split(/\r?\n/)).toHaveLength(2);
    expect(exclusao.text).toContain('PRODUTO EXCLUIDO HISTORICO TESTE (excluído)');
    // O restrito: sem custo, sem a Loja Praia e sem a linha da loja de fora, como na tela dele.
    const doRestrito = await exportar(restrito);
    expect(doRestrito.status, doRestrito.text).toBe(200);
    expect(doRestrito.text).not.toMatch(/custo|Markup|Praia|9,70|9,80|5,00|5,50/i);
    expect(doRestrito.text).toContain('Preço de venda: 9,90 → 10,90');
    expect(doRestrito.text.trim().split(/\r?\n/)).toHaveLength(
      (await historico({ produtoId }, restrito)).total + 1,
    );
    // Sem `relatorios.historico_produtos`, a rota comum recusa.
    expect((await exportar(estoquista)).status).toBe(403);
  });

  it('o período é obrigatório e vai até 366 dias; fora dele a linha não aparece; as permissões', async () => {
    expect((await consulta({})).status).toBe(422);
    expect((await consulta({ dataInicial: diaEmBrasilia() })).status).toBe(422);
    expect((await consulta({ dataInicial: diaEmBrasilia(-366), dataFinal: diaEmBrasilia() })).status).toBe(
      422,
    );
    expect((await consulta({ dataInicial: diaEmBrasilia(-365), dataFinal: diaEmBrasilia() })).status).toBe(
      200,
    );
    expect((await consulta(HOJE(), estoquista)).status).toBe(403);
    const antiga = await inserirAuditoria({
      ocorridoEm: new Date(Date.now() - 62 * 86_400_000).toISOString(),
      descricao: 'Linha antiga do teste',
    });
    expect((await historico({ produtoId })).itens.map((l) => l.id)).not.toContain(antiga.id);
    const doPeriodo = await historico({
      produtoId,
      dataInicial: diaEmBrasilia(-70),
      dataFinal: diaEmBrasilia(),
    });
    expect(doPeriodo.itens.map((l) => l.id)).toContain(antiga.id);
    expect(doPeriodo.itens.at(-1)!.id).toBe(antiga.id);
  });

  it('a consulta só lê as partições do período (EXPLAIN)', async () => {
    const [{ fuso }] = (await consultar<{ fuso: string }>(
      emp.nomeBanco,
      "select coalesce((select fuso_horario from empresa limit 1), 'America/Sao_Paulo') as fuso",
    )) as [{ fuso: string }];
    const particoes = await consultar<{ nome: string }>(
      emp.nomeBanco,
      "select c.relname as nome from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent where p.relname = 'auditoria'",
    );
    expect(particoes.length).toBeGreaterThan(3);
    const q = new PgDialect().sqlToQuery(
      // Sem `produtos.ver_custo` e com lojas restritas: a busca no texto sem o custo nem o aviso de loja.
      sqlHistoricoProdutos(
        { lojas: [lojaCentro], estoques: [], permissoes: new Set<string>() },
        { ...HOJE(), fuso, texto: 'teste' },
        { limite: 50, deslocamento: 0 },
      ),
    );
    const plano = (await consultar<{ 'QUERY PLAN': string }>(emp.nomeBanco, `explain ${q.sql}`, q.params))
      .map((l) => l['QUERY PLAN'])
      .join('\n');
    const lidas = particoes.filter((p) => new RegExp(`\\b${p.nome}\\b`).test(plano)).map((p) => p.nome);
    // Hoje no fuso da empresa cabe em um mês (dois, no último dia do mês em UTC).
    expect(lidas.length).toBeGreaterThanOrEqual(1);
    expect(lidas.length).toBeLessThanOrEqual(2);
    const mesAtual = `auditoria_${new Date().toISOString().slice(0, 7).replace('-', '_')}`;
    expect(lidas).toContain(mesAtual);
  });
});
