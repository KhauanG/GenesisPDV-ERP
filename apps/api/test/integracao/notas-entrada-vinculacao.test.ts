/**
 * NF-e de fornecedor por XML: vinculação dos itens com o fator e o fornecedor aprendido (Fase 2, F2-B20; ERP 13.4.1;
 * MD 3.8.2; README da API › decisão 167), com o S3 em memória. Critério de pronto: numa nota de bebidas, os itens com
 * EAN são sugeridos sozinhos (o EAN do fardo sugere o fator 12; o EAN da unidade, qTrib/qCom), o usuário vincula o
 * resto, confirma os fatores e a nota fica "pronta". Também: o cEAN igual ao cEANTrib (o GTIN da lata nos dois, com
 * uCom CX) sugere qTrib/qCom e não o fator 1 da lata, "SEM GTIN" cai no manual, sem a confirmação do fator a nota não
 * fica pronta (e volta a pendente quando o fator perde a confirmação), "Ignorar item" com motivo, o vínculo aprendido
 * com o fornecedor (fornecedor + cProd) com o fator dele (e a embalagem do cEAN) e a origem "manual" quando o usuário
 * diverge, o EAN só numa variação e o EAN em dois produtos sem sugestão (casos separados), as recusas da conferência
 * (tipo sem estoque, embalagem de outro produto, fator diferente do da embalagem, item de outra nota, fabricação
 * futura, lote do produto que pede lote), a nota ignorada, o "Reabrir" com tudo resolvido, a versão, as permissões
 * (`notas_entrada.importar` no `PUT` e `notas_entrada.ver` sem `recebimentos.ver` nos dados de compra, cada uma num
 * perfil só com ela), a loja gravada fora das permitidas e a auditoria.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CNPJ_LOJA_1, CNPJ_PETISCARIA_2, fixtureNfe } from '../fixtures/nfe/fixtures.js';
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

process.env.NFE_IMPORTACOES_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let admin: string;
let vendedor: string;
/** Só `notas_entrada.ver` (sem `notas_entrada.importar` nem `recebimentos.ver`), na Loja 1. */
let soVer: string;
/** `notas_entrada.ver` e `.importar` na Loja 1, com o estoque da Petiscaria 2 também (para a recusa pela loja). */
let importaLoja1: string;
let un: string;
const ids = {
  loja1: '',
  petiscaria: '',
  nota01: '',
  nota03: '',
  nota05: '',
  nota06: '',
  cerveja: '',
  caixaCerveja: '',
  refri: '',
  agua: '',
  queijo: '',
};
const bearer = (t = admin) => ({ Authorization: `Bearer ${t}` });

interface Item {
  id: string;
  numeroItem: number;
  codigoFornecedor: string;
  ean: string | null;
  eanTributavel: string | null;
  produtoId: string | null;
  fator: string;
  quantidadeEstoque: string | null;
  fatorConfirmado: boolean;
  fatorTributavel: string | null;
  ignorado: boolean;
  motivoIgnorado: string | null;
  origemVinculo: string | null;
  sugestao: { origem: string; produtoId: string; codigoBarrasId: string | null; fator: string } | null;
  vinculoAnterior: { produtoId: string; fator: string } | null;
}

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-vinculo-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  ids.loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  ids.petiscaria = await criarLoja(emp.nomeBanco, 2, 'Petiscaria 2');
  for (const [id, cnpj] of [
    [ids.loja1, CNPJ_LOJA_1],
    [ids.petiscaria, CNPJ_PETISCARIA_2],
  ] as const)
    await consultar(emp.nomeBanco, 'update lojas set cnpj = $1 where id = $2', [cnpj, id]);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [ids.loja1] });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  // Perfis com as permissões separadas: cada teste de permissão prova uma só.
  for (const [chave, permissoes] of [
    ['teste_so_ver_notas', ['notas_entrada.ver']],
    ['teste_importa_notas', ['notas_entrada.ver', 'notas_entrada.importar']],
  ] as const) {
    const [perfil] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome, descricao, chave_sistema) values ($1, 'teste', $1) returning id",
      [chave],
    );
    for (const permissao of permissoes)
      await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
        perfil!.id,
        permissao,
      ]);
  }
  await criarUsuario(emp.nomeBanco, {
    login: 'so_ver_notas',
    perfil: 'teste_so_ver_notas',
    lojas: [ids.loja1],
  });
  soVer = await amb.entrar(emp.codigo, 'so_ver_notas', SENHA_TESTE);
  const estoques = await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = any($1)',
    [[ids.loja1, ids.petiscaria]],
  );
  await criarUsuario(emp.nomeBanco, {
    login: 'importa_loja1',
    perfil: 'teste_importa_notas',
    lojas: [ids.loja1],
    estoques: estoques.map((e) => e.estoque_id),
  });
  importaLoja1 = await amb.entrar(emp.codigo, 'importa_loja1', SENHA_TESTE);
  const [u] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from unidades_medida where sigla = 'UN'",
  );
  un = u!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

async function importar(arquivo: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/notas-entrada/importar')
    .set(bearer())
    .attach('arquivos', Buffer.from(fixtureNfe(arquivo)), arquivo);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.resultados[0].situacao, JSON.stringify(r.body)).toBe('importada');
  return r.body.resultados[0].notaId as string;
}

async function nota(id: string) {
  const r = await amb.http().get(`/api/notas-entrada/${id}`).set(bearer());
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { versao: number; status: string; itens: Item[]; vinculacao: Record<string, unknown> };
}

async function produto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '8', precoCusto: '4', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** Código de barras direto no banco (o fardo de compra com fator, ou o EAN de uma variação). */
async function codigo(
  produtoId: string,
  cod: string,
  extra: { fator?: string; variacaoId?: string; usaCompra?: boolean } = {},
): Promise<string> {
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into produtos_codigos_barras (produto_id, variacao_id, codigo, tipo, fator, usa_venda, usa_compra)
     values ($1, $2, $3, 'gtin', $4, false, $5) returning id`,
    [produtoId, extra.variacaoId ?? null, cod, extra.fator ?? '1', extra.usaCompra ?? true],
  );
  return c!.id;
}

function vincular(id: string, versao: number, itens: Array<Record<string, unknown>>, token = admin) {
  return amb.http().put(`/api/notas-entrada/${id}/itens`).set(bearer(token)).send({ versao, itens });
}

describe('sugestão e vinculação (ERP 13.4.1) – nota de bebidas', () => {
  it('o EAN do fardo sugere o fator 12, o da unidade sugere qTrib/qCom e o item sem produto fica manual', async () => {
    ids.nota01 = await importar('01-icms-st.xml');
    const antes = await nota(ids.nota01);
    const [cerveja, refri, agua] = antes.itens;
    // A cerveja: o EAN da lata no produto e o da caixa como código adicional com fator 12.
    ids.cerveja = await produto('CERVEJA PILSEN LATA 350ML', {
      codigosBarras: [{ codigo: cerveja!.eanTributavel, principal: true }],
    });
    ids.caixaCerveja = await codigo(ids.cerveja, cerveja!.ean!, { fator: '12' });
    // O refrigerante só com o EAN da garrafa: o cEANTrib dá o fator pela nota (30 UN em 5 FD).
    ids.refri = await produto('REFRIGERANTE COLA PET 2L', {
      codigosBarras: [{ codigo: refri!.eanTributavel, principal: true }],
    });
    const d = await nota(ids.nota01);
    expect(d.status).toBe('pendente');
    expect(d.vinculacao).toMatchObject({
      resolvidos: 0,
      total: 3,
      podeAlterarPreco: true,
      parcelasCusto: { incluiSt: true, incluiIpi: true, incluiFrete: true },
    });
    const [c, r, a] = d.itens;
    expect(c!.sugestao).toMatchObject({
      origem: 'ean',
      produtoId: ids.cerveja,
      codigoBarrasId: ids.caixaCerveja,
      fator: '12.000',
    });
    expect(c!.fatorTributavel).toBe('12.000');
    expect(r!.sugestao).toMatchObject({
      origem: 'ean',
      produtoId: ids.refri,
      codigoBarrasId: null,
      fator: '6.000',
    });
    expect(a!.sugestao).toBeNull();
    expect(a!.codigoFornecedor).toBe(agua!.codigoFornecedor);
    // A sugestão nunca é gravada sozinha.
    for (const i of d.itens)
      expect(i).toMatchObject({ produtoId: null, fatorConfirmado: false, origemVinculo: null });
  });

  it('sem a confirmação do fator a nota não fica pronta; confirmados (e o resto vinculado à mão), fica', async () => {
    ids.agua = await produto('AGUA MINERAL 500ML');
    let d = await nota(ids.nota01);
    const [c, r, a] = d.itens;
    const sugeridos = [
      { id: c!.id, produtoId: ids.cerveja, codigoBarrasId: ids.caixaCerveja, fator: '12' },
      { id: r!.id, produtoId: ids.refri, fator: '6' },
      { id: a!.id, produtoId: ids.agua, fator: '1' },
    ];
    let resp = await vincular(ids.nota01, d.versao, sugeridos);
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    expect(resp.body.status).toBe('pendente');
    expect(
      resp.body.itens.map((i: Item) => [i.quantidadeEstoque, i.fatorConfirmado, i.origemVinculo]),
    ).toEqual([
      [null, false, 'ean'],
      [null, false, 'ean'],
      [null, false, 'manual'],
    ]);
    d = resp.body;
    resp = await vincular(
      ids.nota01,
      d.versao,
      sugeridos.map((s) => ({ ...s, fatorConfirmado: true })),
    );
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    expect(resp.body.status).toBe('pronta');
    expect(resp.body.vinculacao).toMatchObject({ resolvidos: 3, total: 3 });
    // 10 CX × 12, 5 FD × 6, 24 UN × 1.
    expect(resp.body.itens.map((i: Item) => i.quantidadeEstoque)).toEqual(['120.000', '30.000', '24.000']);
    const [aud] = await consultar<{ descricao: string; depois: { status: string; itens: unknown[] } }>(
      emp.nomeBanco,
      `select descricao, depois from auditoria where entidade = 'notas_entrada' and registro_id = $1
        order by criado_em desc limit 1`,
      [ids.nota01],
    );
    expect(aud!.descricao).toMatch(/3 item\(ns\) alterado\(s\); a nota ficou "pronta"/);
    expect(aud!.depois.status).toBe('pronta');
    expect(aud!.depois.itens).toHaveLength(3);
    // O fator volta sem confirmação: a nota volta a pendente; o item ignorado com motivo a deixa pronta de novo.
    d = resp.body;
    resp = await vincular(ids.nota01, d.versao, [{ id: a!.id, produtoId: ids.agua, fator: '1' }]);
    expect(resp.body.status).toBe('pendente');
    d = resp.body;
    resp = await vincular(ids.nota01, d.versao, [
      { id: a!.id, ignorado: true, motivoIgnorado: 'Brinde do fornecedor' },
    ]);
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    expect(resp.body.status).toBe('pronta');
    expect(resp.body.itens[2]).toMatchObject({
      ignorado: true,
      motivoIgnorado: 'Brinde do fornecedor',
      produtoId: null,
      quantidadeEstoque: null,
    });
  });

  it('sem nada mudado, a gravação não toca na nota nem na auditoria', async () => {
    const d = await nota(ids.nota01);
    const contar = async () =>
      (
        await consultar<{ n: number }>(
          emp.nomeBanco,
          "select count(*)::int as n from auditoria where entidade = 'notas_entrada' and registro_id = $1",
          [ids.nota01],
        )
      )[0]!.n;
    const n = await contar();
    const [c] = d.itens;
    const resp = await vincular(ids.nota01, d.versao, [
      {
        id: c!.id,
        produtoId: ids.cerveja,
        codigoBarrasId: ids.caixaCerveja,
        fator: '12',
        fatorConfirmado: true,
      },
    ]);
    expect(resp.status, JSON.stringify(resp.body)).toBe(200);
    expect(resp.body.versao).toBe(d.versao);
    expect(await contar()).toBe(n);
  });

  it('a versão desatualizada é conflito e o PUT exige notas_entrada.importar (notas_entrada.ver não basta)', async () => {
    const d = await nota(ids.nota01);
    const [c] = d.itens;
    const item = { id: c!.id, produtoId: ids.cerveja, fator: '12' };
    expect((await vincular(ids.nota01, d.versao - 1, [item])).status).toBe(409);
    // Quem só vê a nota (e a loja e o estoque dela) não vincula.
    expect((await amb.http().get(`/api/notas-entrada/${ids.nota01}`).set(bearer(soVer))).status).toBe(200);
    const r = await vincular(ids.nota01, d.versao, [item], soVer);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect((await vincular(ids.nota01, d.versao, [item], vendedor)).status).toBe(403);
  });

  it('os dados de compra dos produtos saem com notas_entrada.ver, sem recebimentos.ver (as embalagens do fardo)', async () => {
    const url = `/api/notas-entrada/dados-produtos?produtoIds=${ids.cerveja}&lojaId=${ids.loja1}`;
    // O perfil só com notas_entrada.ver: a rota da nota responde e a do recebimento não.
    const r = await amb.http().get(url).set(bearer(soVer));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.produtos[0].embalagens).toContainEqual(
      expect.objectContaining({ id: ids.caixaCerveja, fator: '12.000' }),
    );
    const receb = await amb
      .http()
      .get(`/api/recebimentos/dados-produtos?produtoIds=${ids.cerveja}&lojaId=${ids.loja1}`)
      .set(bearer(soVer));
    expect(receb.status).toBe(403);
    // Sem notas_entrada.ver, 403.
    expect((await amb.http().get(url).set(bearer(vendedor))).status).toBe(403);
  });

  it('o cEAN igual ao cEANTrib (o GTIN da lata nos dois, uCom CX) sugere qTrib/qCom, não o fator 1 da lata', async () => {
    // 4 CX de IPA com o cEAN = cEANTrib = o EAN da garrafa e 48 UN tributáveis: a primeira nota do fornecedor.
    ids.nota03 = await importar('03-ipi-industria.xml');
    const antes = await nota(ids.nota03);
    const [ipa] = antes.itens;
    expect(ipa).toMatchObject({ ean: ipa!.eanTributavel, fatorTributavel: '12.000', vinculoAnterior: null });
    const produtoIpa = await produto('CERVEJA IPA 600ML', {
      codigosBarras: [{ codigo: ipa!.ean, principal: true }],
    });
    const d = await nota(ids.nota03);
    // O código da garrafa tem fator 1: a sugestão é 1 × 48/4 = 12, sem a embalagem (o fator não é o dela).
    expect(d.itens[0]!.sugestao).toMatchObject({
      origem: 'ean',
      produtoId: produtoIpa,
      codigoBarrasId: null,
      fator: '12.000',
    });
    const r = await vincular(ids.nota03, d.versao, [
      { id: ipa!.id, produtoId: produtoIpa, fator: '12', fatorConfirmado: true },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.itens[0]).toMatchObject({ quantidadeEstoque: '48.000', origemVinculo: 'ean' });
    // Com qTrib = qCom (a água: 24 UN e 24 UN, o mesmo EAN nos dois), o fator é o do código e a embalagem vai junto.
    const garrafa = await codigo(ids.agua, (await nota(ids.nota01)).itens[2]!.ean!);
    expect((await nota(ids.nota01)).itens[2]!.sugestao).toMatchObject({
      origem: 'ean',
      produtoId: ids.agua,
      codigoBarrasId: garrafa,
      fator: '1.000',
    });
  });
});

describe('"SEM GTIN", vínculo aprendido e recusas', () => {
  it('"SEM GTIN" cai no manual, com o fator pelas quantidades do XML', async () => {
    ids.nota06 = await importar('06-sem-gtin-produtor-rural.xml');
    const d = await nota(ids.nota06);
    expect(d.itens[0]).toMatchObject({
      ean: null,
      eanTributavel: null,
      sugestao: null,
      fatorTributavel: '20.000',
    });
  });

  it('o vínculo aprendido com o fornecedor (fornecedor + cProd) sugere o produto e o fator dele', async () => {
    ids.nota05 = await importar('05-qtrib-diferente.xml');
    let d = await nota(ids.nota05);
    const [queijo, calabresa] = d.itens;
    ids.queijo = await produto('QUEIJO MUSSARELA KG', { permiteFracao: true });
    const [f] = await consultar<{ fornecedor_id: string }>(
      emp.nomeBanco,
      'select fornecedor_id from notas_entrada where id = $1',
      [ids.nota05],
    );
    await consultar(
      emp.nomeBanco,
      `insert into produtos_fornecedores (produto_id, fornecedor_id, codigo_fornecedor, fator)
       values ($1, $2, $3, 12.107)`,
      [ids.queijo, f!.fornecedor_id, queijo!.codigoFornecedor],
    );
    d = await nota(ids.nota05);
    expect(d.itens[0]).toMatchObject({
      sugestao: { origem: 'vinculo_anterior', produtoId: ids.queijo, fator: '12.107', codigoBarrasId: null },
      vinculoAnterior: { produtoId: ids.queijo, fator: '12.107' },
    });
    expect(d.itens[1]!.sugestao).toBeNull();
    // O usuário diverge do fator aprendido: o vínculo gravado é "manual" e o aprendido continua visível.
    const r = await vincular(ids.nota05, d.versao, [
      { id: queijo!.id, produtoId: ids.queijo, fator: '12.1', fatorConfirmado: true },
      { id: calabresa!.id, ignorado: true, motivoIgnorado: 'Devolvido na entrega' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('pronta');
    expect(r.body.itens[0]).toMatchObject({
      origemVinculo: 'manual',
      vinculoAnterior: { fator: '12.107' },
      quantidadeEstoque: '42.350',
    });
  });

  it('a loja gravada fora das permitidas recusa o PUT, mesmo com o estoque da nota permitido', async () => {
    // A nota 05 é da Petiscaria 2: o usuário vê o estoque dela, mas só tem a Loja 1.
    const d = await nota(ids.nota05);
    const r = await vincular(
      ids.nota05,
      d.versao,
      [{ id: d.itens[0]!.id, produtoId: ids.queijo, fator: '12.107' }],
      importaLoja1,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.mensagem).toMatch(/fora das suas lojas permitidas/);
    expect((await nota(ids.nota05)).versao).toBe(d.versao);
  });

  it('o vínculo anterior leva a embalagem do cEAN quando é do mesmo produto, de compra e com o mesmo fator', async () => {
    const [f] = await consultar<{ fornecedor_id: string }>(
      emp.nomeBanco,
      'select fornecedor_id from notas_entrada where id = $1',
      [ids.nota01],
    );
    const d0 = await nota(ids.nota01);
    const [vinculo] = await consultar<{ id: string }>(
      emp.nomeBanco,
      `insert into produtos_fornecedores (produto_id, fornecedor_id, codigo_fornecedor, fator)
       values ($1, $2, $3, 12) returning id`,
      [ids.cerveja, f!.fornecedor_id, d0.itens[0]!.codigoFornecedor],
    );
    let d = await nota(ids.nota01);
    expect(d.itens[0]).toMatchObject({
      sugestao: {
        origem: 'vinculo_anterior',
        produtoId: ids.cerveja,
        codigoBarrasId: ids.caixaCerveja,
        fator: '12.000',
      },
      origemVinculo: 'vinculo_anterior',
    });
    // Com outro fator aprendido, a embalagem (fator 12) não vai.
    await consultar(emp.nomeBanco, 'update produtos_fornecedores set fator = 6 where id = $1', [vinculo!.id]);
    d = await nota(ids.nota01);
    expect(d.itens[0]!.sugestao).toMatchObject({
      origem: 'vinculo_anterior',
      codigoBarrasId: null,
      fator: '6.000',
    });
    await consultar(emp.nomeBanco, 'delete from produtos_fornecedores where id = $1', [vinculo!.id]);
  });

  it('o EAN só numa variação de um produto não sugere o pai (D43)', async () => {
    // O EAN da STOUT não está em nenhum outro produto: só a regra da variação o tira da sugestão.
    const stout = (await nota(ids.nota03)).itens[1]!;
    expect(stout.sugestao).toBeNull();
    const pai = await produto('CERVEJA STOUT PAI', { tipo: 'simples' });
    const [v] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into produtos_variacoes (produto_id, nome) values ($1, 'LATA') returning id",
      [pai],
    );
    const daVariacao = await codigo(pai, stout.ean!, { variacaoId: v!.id });
    expect((await nota(ids.nota03)).itens[1]!.sugestao).toBeNull();
    // O mesmo EAN no produto (sem a variação) sugere o pai: a recusa acima é a da variação.
    await consultar(emp.nomeBanco, 'update produtos_codigos_barras set excluido_em = now() where id = $1', [
      daVariacao,
    ]);
    await codigo(pai, stout.ean!);
    expect((await nota(ids.nota03)).itens[1]!.sugestao).toMatchObject({ origem: 'ean', produtoId: pai });
    await consultar(
      emp.nomeBanco,
      'update produtos_codigos_barras set excluido_em = now() where produto_id = $1',
      [pai],
    );
  });

  it('o EAN em dois produtos não sugere nada', async () => {
    const d0 = await nota(ids.nota01);
    expect(d0.itens[1]!.sugestao).toMatchObject({ origem: 'ean', produtoId: ids.refri });
    // O EAN repetido só entra com `geral.ean_duplicado = 'avisar'` (o padrão bloqueia).
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.ean_duplicado', '"avisar"'::jsonb)`,
    );
    // Um segundo produto com o EAN da garrafa do refrigerante: ambíguo.
    const outro = await produto('REFRIGERANTE COLA PET 2L (DUPLICADO)');
    await codigo(outro, d0.itens[1]!.eanTributavel!);
    const d = await nota(ids.nota01);
    expect(d.itens[1]!.sugestao).toBeNull();
    // Sem a sugestão, o vínculo gravado vira "manual".
    expect(d.itens[1]!.origemVinculo).toBe('manual');
    await consultar(
      emp.nomeBanco,
      'update produtos_codigos_barras set excluido_em = now() where produto_id = $1',
      [outro],
    );
    await consultar(
      emp.nomeBanco,
      "update configuracoes set excluido_em = now() where chave = 'geral.ean_duplicado' and excluido_em is null",
    );
  });

  it('recusa o tipo sem estoque, a embalagem de outro produto, o fator diferente e o item de outra nota', async () => {
    const d = await nota(ids.nota06);
    const [item] = d.itens;
    const servico = await produto('FRETE AVULSO', { tipo: 'servico', controlaEstoque: false });
    let r = await vincular(ids.nota06, d.versao, [{ id: item!.id, produtoId: servico, fator: '1' }]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.produtoId']).toEqual(['Serviço não tem estoque']);
    r = await vincular(ids.nota06, d.versao, [
      { id: item!.id, produtoId: ids.agua, codigoBarrasId: ids.caixaCerveja, fator: '12' },
    ]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.codigoBarrasId']).toEqual(['A embalagem não é deste produto']);
    r = await vincular(ids.nota06, d.versao, [
      { id: item!.id, produtoId: ids.cerveja, codigoBarrasId: ids.caixaCerveja, fator: '6' },
    ]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.fator']).toEqual(['O fator é o da embalagem (12)']);
    const outra = await nota(ids.nota01);
    r = await vincular(ids.nota06, d.versao, [{ id: outra.itens[0]!.id, produtoId: ids.agua }]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.id']).toEqual(['O item não é desta nota']);
    r = await vincular(ids.nota06, d.versao, [
      { id: item!.id, produtoId: ids.agua, fator: '1', lote: 'L1', fabricacao: '2099-01-01' },
    ]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.fabricacao']).toEqual(['A fabricação não pode ser futura']);
    r = await vincular(ids.nota06, d.versao, [{ id: item!.id, ignorado: true }]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.motivoIgnorado']).toBeDefined();
    r = await vincular(ids.nota06, d.versao, [{ id: item!.id, fatorConfirmado: true }]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.produtoId']).toEqual(['Escolha o produto antes de confirmar']);
    // O fator apagado não vira 1 confirmado (6 CX entrariam como 6 KG).
    r = await vincular(ids.nota06, d.versao, [
      { id: item!.id, produtoId: ids.agua, fator: '', fatorConfirmado: true },
    ]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.fator']).toEqual(['Informe o fator']);
  });

  it('o produto que pede lote exige o lote só ao confirmar o fator', async () => {
    const d = await nota(ids.nota06);
    const [item] = d.itens;
    const limao = await produto('LIMAO TAHITI KG', { permiteFracao: true, solicitaLotePdv: true });
    let r = await vincular(ids.nota06, d.versao, [{ id: item!.id, produtoId: limao, fator: '20' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    r = await vincular(ids.nota06, r.body.versao, [
      { id: item!.id, produtoId: limao, fator: '20', fatorConfirmado: true },
    ]);
    expect(r.status).toBe(422);
    expect(r.body.campos['itens.0.lote']).toEqual(['O produto pede lote: informe o lote']);
    const v = (await nota(ids.nota06)).versao;
    r = await vincular(ids.nota06, v, [
      {
        id: item!.id,
        produtoId: limao,
        fator: '20',
        fatorConfirmado: true,
        lote: 'SAFRA26',
        validade: '2026-12-31',
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('pronta');
    expect(r.body.itens[0]).toMatchObject({ quantidadeEstoque: '120.000', lote: 'SAFRA26' });
  });

  it('a nota ignorada não muda os itens e o "Reabrir" com tudo resolvido volta a pronta', async () => {
    let d = await nota(ids.nota06);
    let r = await amb
      .http()
      .post(`/api/notas-entrada/${ids.nota06}/ignorar`)
      .set(bearer())
      .send({ versao: d.versao, motivo: 'Conferir com o produtor' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    d = r.body;
    r = await vincular(ids.nota06, d.versao, [{ id: d.itens[0]!.id, produtoId: ids.agua }]);
    expect(r.status).toBe(422);
    expect(r.body.mensagem).toMatch(/reabra a nota/);
    r = await amb
      .http()
      .post(`/api/notas-entrada/${ids.nota06}/reabrir`)
      .set(bearer())
      .send({ versao: d.versao });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('pronta');
  });
});
