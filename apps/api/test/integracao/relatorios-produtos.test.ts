/**
 * Relatórios **Produtos geral** (ERP 16.1) e **NCMs inválidos** (ERP 16.3), com a carga do CEST (Fase 2, F2-B41;
 * README da API › decisão 187).
 *
 * - Produtos geral: o lucro, o lucro % e o markup % por produto e as médias do relatório inteiro em decimal (a média
 *   que cai em ",xx5" arredonda para longe do zero, o que o `float` erra), o preço da loja, os filtros (sem preço,
 *   situação, departamento com as filhas, marca), o custo só com `produtos.ver_custo` (e a ordenação por custo 403), a
 *   loja fora das permitidas 403 e a exportação.
 * - NCMs inválidos: os motivos vazio, inexistente e fora de vigência (o conjunto é o `not ncmVigente`), sem combo nem
 *   serviço; o motivo CEST some com a tabela `cests` vazia e aparece com a carga (a lista de NCMs do CEST pelo começo
 *   do código: a posição "2203" aceita 2203.00.00, sem falso positivo); a exclusão lógica do CEST que sai do arquivo e
 *   a volta dele; o "Definir NCM" em lote de 50 produtos, cada um com a versão nova e a própria auditoria; tudo ou
 *   nada (o lote com um produto válido e uma versão velha 409 sem gravar o válido; só conflitos = 409, senão 422); o
 *   NCM fora da tabela 422; as duas permissões.
 *
 * A carga do CEST usa a fixture **inventada** `test/fixtures/referencias/cests-inventado.csv` (CEST 99xxxxx, que não
 * existem no convênio). A "tabela vazia" é montada pelo próprio teste (exclui logicamente o que o provisionamento
 * carregou do `cests.csv`), para seguir valendo quando a lista oficial do CONFAZ entrar no arquivo.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dec,
  decTexto,
  type RespostaNcmInvalidos,
  type RespostaProdutosGeral,
  type ResultadoDefinirNcm,
} from '@genesis/shared';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carregarCests, lerCests } from '../../src/database/referencias/carregar.js';
import { ncmVigente } from '../../src/produtos/ncm.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURE_CESTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'referencias',
  'cests-inventado.csv',
);
const NCM_CERVEJA = '22030000';
const NCM_VENCIDO = '01012100';
const LOCALIZACAO = 'Relatórios › NCMs inválidos';

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let estoquista: string;
let un: string;
let loja: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function criar(corpo: Record<string, unknown>) {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer(admin))
    .send({ unidadeId: un, precoVenda: '10', ...corpo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function geral(query: Record<string, string> = {}, token = admin) {
  const r = await amb.http().get('/api/relatorios/produtos-geral').query(query).set(bearer(token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RespostaProdutosGeral;
}

async function invalidos(query: Record<string, string> = {}, token = admin) {
  const r = await amb.http().get('/api/relatorios/ncm-invalidos').query(query).set(bearer(token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RespostaNcmInvalidos;
}

const definir = (corpo: object, token = admin) =>
  amb.http().post('/api/relatorios/ncm-invalidos/definir-ncm').set(bearer(token)).send(corpo);

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  const [u] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from unidades_medida where sigla = 'UN'",
  );
  un = u!.id;
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja Teste');
});

afterAll(async () => {
  await amb?.fechar();
});

describe('Produtos geral (ERP 16.1)', () => {
  let p1: string;
  let p2: string;
  let semPreco: string;
  let filha: string;
  let marcaId: string;

  beforeAll(async () => {
    const m = await amb
      .http()
      .post('/api/marcas')
      .set(bearer(admin))
      .send({ descricao: 'MARCA TESTE GERAL' });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    marcaId = m.body.id as string;
    const pai = await amb.http().post('/api/categorias').set(bearer(admin)).send({ nome: 'BEBIDAS TESTE' });
    expect(pai.status, JSON.stringify(pai.body)).toBe(201);
    const f = await amb
      .http()
      .post('/api/categorias')
      .set(bearer(admin))
      .send({ nome: 'CERVEJAS TESTE', categoriaPaiId: pai.body.id });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    filha = f.body.id as string;
    // P1: custo 10, venda 15 (na loja, 20); P2: custo 3, venda 4,01. Lucros 5,00 e 1,01: a média 3,005 vira 3,01.
    p1 = await criar({
      nome: 'GERAL TESTE A',
      ncm: NCM_CERVEJA,
      precoCusto: '10',
      precoVenda: '15',
      precoAtacado: '14',
      marcaId,
      categorias: [filha],
      categoriaPrincipalId: filha,
      lojas: [{ lojaId: loja, precoVenda: '20' }],
    });
    p2 = await criar({ nome: 'GERAL TESTE B', ncm: NCM_CERVEJA, precoCusto: '3', precoVenda: '4.01' });
    // Inativo e sem preço (a matéria-prima pode ter venda zero): fora do padrão "ativos".
    semPreco = await criar({
      nome: 'GERAL TESTE C',
      ncm: NCM_CERVEJA,
      tipo: 'materia_prima',
      precoCusto: '2',
      precoVenda: '0',
      ativo: false,
    });
  });

  it('o lucro, as porcentagens e as médias do relatório inteiro em decimal', async () => {
    const r = await geral({ nome: 'GERAL TESTE' });
    expect(r.total).toBe(2);
    const a = r.itens.find((i) => i.produtoId === p1)!;
    expect(a).toMatchObject({
      precoCusto: '10.0000',
      precoVenda: '15.0000',
      precoAtacado: '14.0000',
      lucro: '5.00',
      lucroPct: '33.33',
      markupPct: '50.00',
      marcaNome: 'MARCA TESTE GERAL',
      departamentos: [expect.stringMatching(/BEBIDAS TESTE.*CERVEJAS TESTE/)],
    });
    const b = r.itens.find((i) => i.produtoId === p2)!;
    expect(b).toMatchObject({ lucro: '1.01', lucroPct: '25.19', markupPct: '33.67', departamentos: [] });
    // As médias das linhas sem arredondar (o decimal da API, conferido com o `dec` do shared).
    const pct = (l: string, base: string) => dec(l).div(base).times(100);
    expect(r.totais).toEqual({
      quantidadeProdutos: 2,
      mediaLucro: '3.01',
      mediaLucroPct: decTexto(pct('5', '15').plus(pct('1.01', '4.01')).div(2), 2),
      mediaMarkupPct: decTexto(pct('5', '10').plus(pct('1.01', '3')).div(2), 2),
    });
    // No `float`, (5 + 1,01) ÷ 2 = 3,0049999…: a média sairia 3,00.
    expect(((5 + 1.01) / 2).toFixed(2)).toBe('3.00');
  });

  it('a loja dá o preço dela; sem preço, situação, departamento (com as filhas) e marca', async () => {
    const naLoja = await geral({ nome: 'GERAL TESTE', lojaId: loja });
    expect(naLoja.itens.find((i) => i.produtoId === p1)).toMatchObject({
      precoVenda: '20.0000',
      lucro: '10.00',
      markupPct: '100.00',
    });
    // P2 não tem preço na loja: o do produto.
    expect(naLoja.itens.find((i) => i.produtoId === p2)!.precoVenda).toBe('4.0100');

    const sem = await geral({ nome: 'GERAL TESTE', semPreco: 'true', situacao: 'todos' });
    expect(sem.itens.map((i) => i.produtoId)).toEqual([semPreco]);
    expect(sem.itens[0]).toMatchObject({ lucro: '-2.00', lucroPct: null, markupPct: '-100.00' });
    expect(sem.totais).toMatchObject({
      quantidadeProdutos: 1,
      mediaLucroPct: null,
      mediaMarkupPct: '-100.00',
    });

    const inativos = await geral({ nome: 'GERAL TESTE', situacao: 'inativos' });
    expect(inativos.itens.map((i) => i.produtoId)).toEqual([semPreco]);

    const [pai] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "select id from categorias where nome = 'BEBIDAS TESTE'",
    );
    const porPai = await geral({ categoriaId: pai!.id });
    expect(porPai.itens.map((i) => i.produtoId)).toEqual([p1]);
    const porMarca = await geral({ marcaId });
    expect(porMarca.itens.map((i) => i.produtoId)).toEqual([p1]);

    // O markup do B (33,67) é menor que o do A (50): a ordem crescente inverte a do nome (o padrão).
    const ordenado = await geral({ nome: 'GERAL TESTE', ordenar: 'markup_pct:asc' });
    expect(ordenado.itens.map((i) => i.produtoId)).toEqual([p2, p1]);
    const decrescente = await geral({ nome: 'GERAL TESTE', ordenar: 'markup_pct:desc' });
    expect(decrescente.itens.map((i) => i.produtoId)).toEqual([p1, p2]);
  });

  it('sem produtos.ver_custo: custo, lucro e médias nulos; ordenar por custo e loja fora das permitidas 403', async () => {
    const r = await geral({ nome: 'GERAL TESTE' }, estoquista);
    expect(r.itens.find((i) => i.produtoId === p1)).toMatchObject({
      precoCusto: null,
      lucro: null,
      lucroPct: null,
      markupPct: null,
      precoVenda: '15.0000',
    });
    expect(r.totais).toEqual({
      quantidadeProdutos: 2,
      mediaLucro: null,
      mediaLucroPct: null,
      mediaMarkupPct: null,
    });
    const ordenar = await amb
      .http()
      .get('/api/relatorios/produtos-geral')
      .query({ ordenar: 'lucro:asc' })
      .set(bearer(estoquista));
    expect(ordenar.status).toBe(403);
    // O estoquista de teste não tem loja.
    const outra = await amb
      .http()
      .get('/api/relatorios/produtos-geral')
      .query({ lojaId: loja })
      .set(bearer(estoquista));
    expect(outra.status).toBe(403);
    expect(outra.body.campos.lojaId).toBeDefined();
  });

  it('exportação pela rota comum com as colunas de custo', async () => {
    const r = await amb
      .http()
      .get('/api/relatorios/produtos-geral/exportar')
      .query({ formato: 'csv', nome: 'GERAL TESTE' })
      .set(bearer(admin));
    expect(r.status, r.text).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/Relatorio_Produtos_Geral_/);
    const linhas = r.text.trim().split(/\r?\n/);
    expect(linhas[0]).toContain('Markup %');
    expect(linhas).toHaveLength(3);
    expect(
      linhas.find((l) => l.includes('GERAL TESTE A')),
      linhas.join('\n'),
    ).toMatch(/33[.,]33/);
  });
});

describe('NCMs inválidos (ERP 16.3) e a carga do CEST', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // Todos com o NCM válido na criação; o banco recebe depois o que a importação/migração deixaria.
    for (const n of [
      'vazio',
      'inexistente',
      'vencido',
      'cestOk',
      'cestFora',
      'cestVencido',
      'cestSem',
      'valido',
    ])
      ids[n] = await criar({ nome: `NCM TESTE ${n.toUpperCase()}`, ncm: NCM_CERVEJA });
    ids.servico = await criar({ nome: 'NCM TESTE SERVICO', tipo: 'servico', controlaEstoque: false });
    await consultar(emp.nomeBanco, `update ncms set vigencia_fim = '2020-12-31' where codigo = $1`, [
      NCM_VENCIDO,
    ]);
    const sqlProduto = (id: string, campos: string) =>
      consultar(emp.nomeBanco, `update produtos set ${campos} where id = $1`, [id]);
    await sqlProduto(ids.vazio!, 'ncm = null');
    await sqlProduto(ids.inexistente!, "ncm = '99999999'");
    await sqlProduto(ids.vencido!, `ncm = '${NCM_VENCIDO}'`);
    await sqlProduto(ids.cestOk!, "cest = '9900100'");
    await sqlProduto(ids.cestFora!, "cest = '9900200'");
    await sqlProduto(ids.cestVencido!, "cest = '9900300'");
    await sqlProduto(ids.cestSem!, "cest = '1234567'");
    // A "tabela vazia" do primeiro teste: o provisionamento carrega o `cests.csv` versionado (hoje só o cabeçalho;
    // amanhã, a lista oficial), então o teste a esvazia ele mesmo.
    await consultar(emp.nomeBanco, 'update cests set excluido_em = now() where excluido_em is null');
  });

  it('com a tabela cests vazia: só os motivos do NCM, que são o "not ncmVigente"; sem serviço', async () => {
    const r = await invalidos();
    expect(r.cestCarregado).toBe(false);
    const porId = new Map(r.itens.map((i) => [i.produtoId, i]));
    expect(porId.get(ids.vazio!)).toMatchObject({ motivo: 'vazio', ncm: null, detalhe: null });
    expect(porId.get(ids.inexistente!)).toMatchObject({
      motivo: 'inexistente',
      detalhe: 'O NCM 99999999 não está na tabela vigente',
    });
    expect(porId.get(ids.vencido!)).toMatchObject({
      motivo: 'fora_vigencia',
      detalhe: 'Vigência até 31/12/2020',
    });
    for (const n of ['cestOk', 'cestFora', 'cestVencido', 'cestSem', 'valido', 'servico'])
      expect(porId.has(ids[n]!), n).toBe(false);
    expect(r.porMotivo).toEqual({ vazio: 1, inexistente: 1, fora_vigencia: 1, cest_incompativel: 0 });
    // O mesmo conjunto do filtro "NCM inválido": o próprio `ncmVigente` (o helper da listagem, da exportação e do
    // cadastro, decisão 98), fora combo e serviço.
    const q = new PgDialect().sqlToQuery(sql`
      select p.id from produtos p where p.excluido_em is null and p.tipo not in ('kit','servico')
         and (p.ncm is null or not ${ncmVigente(sql`p.ncm`)})`);
    const invalidosHelper = await consultar<{ id: string }>(emp.nomeBanco, q.sql, q.params);
    expect(new Set(r.itens.map((i) => i.produtoId))).toEqual(new Set(invalidosHelper.map((v) => v.id)));
  });

  it('com a carga (fixture inventada): o CEST incompatível aparece, pela lista de NCMs do CEST', async () => {
    const linhas = lerCests(FIXTURE_CESTS);
    expect(linhas.map((l) => [l.codigo, l.ncms])).toEqual([
      ['9900100', ['22030000']],
      ['9900200', ['2201', '220210']],
      ['9900300', ['2203']],
    ]);
    // A descrição com ";" entre aspas.
    expect(linhas[0]!.descricao).toContain('INVENTADO PARA TESTE; NÃO É A TABELA OFICIAL');
    const c = await conectar(emp.nomeBanco);
    try {
      expect(await carregarCests(c, linhas)).toBe(3);
      // Idempotente; e o arquivo vazio não mexe na tabela.
      expect(await carregarCests(c, linhas)).toBe(0);
      expect(await carregarCests(c, [])).toBe(0);
      // O CEST que sai do arquivo é excluído logicamente; o que volta é reativado (a atualização do F2-B46).
      const excluidoEm = async () =>
        (await c.query<{ e: Date | null }>("select excluido_em as e from cests where codigo = '9900300'"))
          .rows[0]!.e;
      expect(await carregarCests(c, linhas.slice(0, 2))).toBe(1);
      expect(await excluidoEm()).not.toBeNull();
      expect(await carregarCests(c, linhas)).toBe(1);
      expect(await excluidoEm()).toBeNull();
    } finally {
      await c.end();
    }
    const r = await invalidos();
    expect(r.cestCarregado).toBe(true);
    const porId = new Map(r.itens.map((i) => [i.produtoId, i]));
    expect(porId.has(ids.cestOk!)).toBe(false);
    expect(porId.get(ids.cestFora!)).toMatchObject({
      motivo: 'cest_incompativel',
      cest: '9900200',
      detalhe: 'O NCM não está na lista do CEST 9900200',
    });
    expect(porId.get(ids.cestVencido!)).toMatchObject({
      motivo: 'cest_incompativel',
      detalhe: 'O CEST 9900300 não está na tabela vigente',
    });
    expect(porId.get(ids.cestSem!)).toMatchObject({
      motivo: 'cest_incompativel',
      detalhe: 'O CEST 1234567 não está na tabela vigente',
    });
    expect(porId.has(ids.valido!)).toBe(false);
    expect(r.porMotivo).toEqual({ vazio: 1, inexistente: 1, fora_vigencia: 1, cest_incompativel: 3 });

    // A posição "2203" do CEST aceita o item 2203.00.00 (o começo do código): o vencido de lá sai quando vigente.
    await consultar(emp.nomeBanco, "update cests set vigencia_fim = null where codigo = '9900300'");
    expect((await invalidos()).porMotivo.cest_incompativel).toBe(2);
    await consultar(emp.nomeBanco, "update cests set vigencia_fim = '2019-12-31' where codigo = '9900300'");
  });

  it('"Definir NCM" em lote: 50 produtos, cada um com a versão nova e a própria auditoria', async () => {
    // Mais 47 sem NCM (o que a migração do Nuvem3 deixa): com os 3 do NCM, 50 numa página.
    const extras: string[] = [];
    for (let i = 0; i < 47; i++)
      extras.push(
        await criar({
          nome: `NCM TESTE LOTE ${String(i).padStart(2, '0')}`,
          // O primeiro com preço na loja e código de barras: o "Definir NCM" troca só o NCM.
          ...(i === 0
            ? {
                lojas: [{ lojaId: loja, precoVenda: '9' }],
                codigosBarras: [{ codigo: '2000000000015', tipo: 'interno' }],
              }
            : {}),
        }),
      );
    // Os 53 do relatório em duas páginas de 50; os 50 de motivo do NCM (os 3 do CEST ficam para o teste seguinte).
    const paginas = [await invalidos({ tamanho: '50' }), await invalidos({ tamanho: '50', pagina: '2' })];
    expect(paginas.map((p) => p.itens.length)).toEqual([50, 3]);
    const alvos = paginas.flatMap((p) => p.itens).filter((i) => i.motivo !== 'cest_incompativel');
    expect(alvos).toHaveLength(50);
    const antes = await consultar<{ id: string; versao: string }>(
      emp.nomeBanco,
      'select id, versao::text from produtos where id = any($1::uuid[])',
      [alvos.map((a) => a.produtoId)],
    );
    const r = await definir({
      ncm: NCM_CERVEJA,
      produtos: alvos.map((a) => ({ id: a.produtoId, versao: a.versao })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const res = r.body as ResultadoDefinirNcm;
    expect(res.atualizados).toHaveLength(50);
    expect(res.semMudanca).toBe(0);
    expect(res.atualizados.every((a) => a.codigo > 0)).toBe(true);

    const depois = await consultar<{ id: string; versao: string; ncm: string }>(
      emp.nomeBanco,
      'select id, versao::text, ncm from produtos where id = any($1::uuid[])',
      [alvos.map((a) => a.produtoId)],
    );
    const versaoAntes = new Map(antes.map((a) => [a.id, BigInt(a.versao)]));
    // A versão nova de cada um (é o que desce ao PDV) e o NCM gravado.
    expect(depois.every((d) => d.ncm === NCM_CERVEJA && BigInt(d.versao) > versaoAntes.get(d.id)!)).toBe(
      true,
    );
    const auditoria = await consultar<{ registro_id: string; n: number }>(
      emp.nomeBanco,
      `select registro_id, count(*)::int as n from auditoria
        where entidade = 'produtos' and acao = 'editar' and localizacao = $1 and registro_id = any($2::uuid[])
        group by registro_id`,
      [LOCALIZACAO, alvos.map((a) => a.produtoId)],
    );
    expect(auditoria).toHaveLength(50);
    expect(auditoria.every((a) => a.n === 1)).toBe(true);
    const [aud] = await consultar<{ antes: { ncm: string | null }; depois: { ncm: string } }>(
      emp.nomeBanco,
      'select antes, depois from auditoria where localizacao = $1 and registro_id = $2',
      [LOCALIZACAO, ids.inexistente],
    );
    expect(aud!.antes.ncm).toBe('99999999');
    expect(aud!.depois.ncm).toBe(NCM_CERVEJA);

    const [filhas] = await consultar<{ preco: string; codigos: number }>(
      emp.nomeBanco,
      `select (select preco_venda::text from produtos_lojas where produto_id = $1 and excluido_em is null) as preco,
              (select count(*)::int from produtos_codigos_barras where produto_id = $1 and excluido_em is null) as codigos`,
      [extras[0]],
    );
    expect(filhas).toEqual({ preco: '9.0000', codigos: 1 });
    const restante = await invalidos();
    expect(restante.porMotivo).toEqual({ vazio: 0, inexistente: 0, fora_vigencia: 0, cest_incompativel: 3 });
    expect(extras).toHaveLength(47);
  });

  it('a versão velha é 409 sem gravar nada; o NCM fora da tabela, 422; o mesmo NCM não regrava', async () => {
    const r = await invalidos();
    const fora = r.itens.find((i) => i.produtoId === ids.cestFora)!;
    const sem = r.itens.find((i) => i.produtoId === ids.cestSem)!;
    const gravado = async (id: string) =>
      (
        await consultar<{ ncm: string; versao: string }>(
          emp.nomeBanco,
          'select ncm, versao::text from produtos where id = $1',
          [id],
        )
      )[0]!;

    // Tudo ou nada: o produto válido do lote não é gravado quando outro tem a versão velha (só conflitos = 409).
    const antesFora = await gravado(fora.produtoId);
    const misto = await definir({
      ncm: '22011000',
      produtos: [
        { id: fora.produtoId, versao: fora.versao },
        { id: sem.produtoId, versao: sem.versao - 1 },
      ],
    });
    expect(misto.status, JSON.stringify(misto.body)).toBe(409);
    expect(Object.keys(misto.body.campos)).toEqual(['produtos.1']);
    expect(await gravado(fora.produtoId)).toEqual(antesFora);
    expect(antesFora.ncm).toBe(NCM_CERVEJA);

    // Conflito e outro erro juntos: 422, com a mensagem de cada um (o não encontrado também).
    const conflitoEOutro = await definir({
      ncm: '22011000',
      produtos: [
        { id: fora.produtoId, versao: fora.versao - 1 },
        { id: randomUUID(), versao: 1 },
      ],
    });
    expect(conflitoEOutro.status, JSON.stringify(conflitoEOutro.body)).toBe(422);
    expect(Object.keys(conflitoEOutro.body.campos)).toEqual(['produtos.0', 'produtos.1']);
    expect(conflitoEOutro.body.campos['produtos.1']).toEqual(['Produto não encontrado']);
    // O excluído depois de abrir o relatório sai identificado (o gerente sabe qual desmarcar).
    const excluido = await criar({ nome: 'NCM TESTE EXCLUIDO' });
    const [ex] = await consultar<{ codigo: number; versao: string }>(
      emp.nomeBanco,
      'update produtos set excluido_em = now() where id = $1 returning codigo, versao::text',
      [excluido],
    );
    const comExcluido = await definir({
      ncm: '22011000',
      produtos: [{ id: excluido, versao: Number(ex!.versao) }],
    });
    expect(comExcluido.status, JSON.stringify(comExcluido.body)).toBe(422);
    expect(comExcluido.body.campos['produtos.0']).toEqual([
      `${ex!.codigo} - NCM TESTE EXCLUIDO: excluído depois de abrir o relatório; gere o relatório de novo`,
    ]);

    const velha = await definir({
      ncm: '22011000',
      produtos: [
        { id: fora.produtoId, versao: fora.versao - 1 },
        { id: sem.produtoId, versao: sem.versao - 1 },
      ],
    });
    expect(velha.status, JSON.stringify(velha.body)).toBe(409);
    expect(Object.keys(velha.body.campos)).toEqual(['produtos.0', 'produtos.1']);
    const [g] = await consultar<{ ncm: string }>(emp.nomeBanco, 'select ncm from produtos where id = $1', [
      fora.produtoId,
    ]);
    expect(g!.ncm).toBe(NCM_CERVEJA);

    const inexistente = await definir({
      ncm: '99999999',
      produtos: [{ id: fora.produtoId, versao: fora.versao }],
    });
    expect(inexistente.status).toBe(422);
    expect(inexistente.body.campos.ncm).toBeDefined();

    // O CEST 9900200 lista a água (2201): o NCM certo tira o produto do relatório.
    const certo = await definir({ ncm: '22011000', produtos: [{ id: fora.produtoId, versao: fora.versao }] });
    expect(certo.status, JSON.stringify(certo.body)).toBe(200);
    expect((await invalidos()).itens.some((i) => i.produtoId === fora.produtoId)).toBe(false);

    // O produto que já tem o NCM não ganha versão nem auditoria.
    const atual = (await invalidos()).itens.find((i) => i.produtoId === sem.produtoId)!;
    const igual = await definir({
      ncm: NCM_CERVEJA,
      produtos: [{ id: sem.produtoId, versao: atual.versao }],
    });
    expect(igual.status).toBe(200);
    expect(igual.body).toEqual({ atualizados: [], semMudanca: 1 });
  });

  it('permissões: o relatório exige relatorios.ncm_invalidos; o "Definir NCM", ela e produtos.editar', async () => {
    // O estoquista tem produtos.editar e não tem o relatório.
    const r = await amb.http().get('/api/relatorios/ncm-invalidos').set(bearer(estoquista));
    expect(r.status).toBe(403);
    const d = await definir({ ncm: NCM_CERVEJA, produtos: [{ id: ids.cestSem, versao: 1 }] }, estoquista);
    expect(d.status).toBe(403);

    // Só o relatório (sem produtos.editar): vê a lista e não define o NCM.
    const [perfil] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome, descricao, chave_sistema) values ('Só NCMs inválidos', 'teste', 'teste_so_ncm_invalidos') returning id",
    );
    await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
      perfil!.id,
      'relatorios.ncm_invalidos',
    ]);
    await criarUsuario(emp.nomeBanco, { login: 'soncm', perfil: 'teste_so_ncm_invalidos' });
    const soRelatorio = await amb.entrar(emp.codigo, 'soncm', SENHA_TESTE);
    const lista = await invalidos({}, soRelatorio);
    const alvo = lista.itens.find((i) => i.produtoId === ids.cestSem)!;
    const antes = await consultar<{ versao: string }>(
      emp.nomeBanco,
      'select versao::text from produtos where id = $1',
      [alvo.produtoId],
    );
    const semEditar = await definir(
      { ncm: '22011000', produtos: [{ id: alvo.produtoId, versao: alvo.versao }] },
      soRelatorio,
    );
    expect(semEditar.status, JSON.stringify(semEditar.body)).toBe(403);
    expect(
      await consultar<{ versao: string }>(emp.nomeBanco, 'select versao::text from produtos where id = $1', [
        alvo.produtoId,
      ]),
    ).toEqual(antes);
  });

  it('exportação pela rota comum: uma linha por produto com o motivo e o detalhe', async () => {
    const r = await amb
      .http()
      .get('/api/relatorios/ncm-invalidos/exportar')
      .query({ formato: 'csv' })
      .set(bearer(admin));
    expect(r.status, r.text).toBe(200);
    const linhas = r.text.trim().split(/\r?\n/);
    expect(linhas[0]).toContain('Motivo');
    expect(linhas).toHaveLength(3);
    expect(linhas.slice(1).every((l) => l.includes('CEST incompatível'))).toBe(true);
  });
});
