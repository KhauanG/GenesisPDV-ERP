/**
 * Relatório **EAN duplicado** (Fase 2, F2-B38; MD 3.6.5; README da API › decisão 184): `GET /relatorios/ean-duplicado`
 * com 3 produtos e 2 códigos repetidos (um deles no fardo de um e no EAN principal de outro, com o produto inativo
 * incluído), o código interno repetido e o produto excluído fora, os filtros (começo do EAN e nome, que traz o grupo
 * inteiro), a página com o total, o `geral.ean_duplicado` de agora, a permissão (`produtos.ver`), a exportação pela
 * rota comum e a correção de um produto tirando o par do relatório. O EXPLAIN confere que o agrupamento lê o
 * `ix_produtos_codigos_barras_codigo`. Os EAN são inventados, com o dígito verificador calculado.
 */
import { calcularDvGtin, type RespostaEanDuplicado } from '@genesis/shared';
import ExcelJS from 'exceljs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sqlCodigosDuplicados } from '../../src/relatorios/ean-duplicado.js';
import {
  conectar,
  consultar,
  criarAmbiente,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let estoquista: string;
let financeiro: string;
let un: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** EAN-13 inventado (prefixo 789 + base) com o dígito verificador certo. */
const ean = (base: string) => {
  const b = `789${base}`.padEnd(12, '0');
  return `${b}${calcularDvGtin(b)}`;
};
const EAN_A = ean('900000001');
const EAN_B = ean('900000002');
const EAN_UNICO = ean('900000003');
const EAN_EXCLUIDO = ean('900000004');

let produtoA: string;
let produtoB: string;
let produtoC: string;

const relatorio = (query: Record<string, string> = {}, token = admin) =>
  amb.http().get('/api/relatorios/ean-duplicado').query(query).set(bearer(token));

async function ler(query: Record<string, string> = {}, token = admin) {
  const r = await relatorio(query, token);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RespostaEanDuplicado;
}

async function criar(corpo: Record<string, unknown>) {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer(admin))
    .send({ unidadeId: un, precoVenda: '10', confirmarEanDuplicado: true, ...corpo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** A primeira aba do `.xlsx`: o cabeçalho e as linhas de dados. */
async function lerXlsx(conteudo: Buffer) {
  const livro = new ExcelJS.Workbook();
  await livro.xlsx.load(conteudo as unknown as ArrayBuffer);
  const linhas: unknown[][] = [];
  livro.worksheets[0]!.eachRow((r) => linhas.push((r.values as unknown[]).slice(1)));
  return { cabecalho: linhas[0] as string[], dados: linhas.slice(1) };
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
  await criarUsuario(emp.nomeBanco, { login: 'financeiro', perfil: 'financeiro' });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  financeiro = await amb.entrar(emp.codigo, 'financeiro', SENHA_TESTE);
  const [u] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from unidades_medida where sigla = 'UN'",
  );
  un = u!.id;

  // Período de migração: o EAN repetido grava com a confirmação (o que a importação do Nuvem3 deixa).
  await consultar(
    emp.nomeBanco,
    `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.ean_duplicado', '"avisar"')`,
  );
  // A: o EAN_A principal e o EAN_B no fardo; B: o EAN_A; C (inativo): o EAN_B.
  produtoA = await criar({
    nome: 'CERV TESTE PILSEN LATA 350ML',
    codigosBarras: [
      { codigo: EAN_A, principal: true },
      { codigo: EAN_B, descricao: 'Fardo 12', fator: '12' },
    ],
  });
  produtoB = await criar({
    nome: 'CERV TESTE PILSEN LATA 350ML (CADASTRO ANTIGO)',
    codigosBarras: [{ codigo: EAN_A, principal: true }],
  });
  produtoC = await criar({
    nome: 'FARDO TESTE PILSEN 12UN',
    ativo: false,
    codigosBarras: [{ codigo: EAN_B, principal: true }],
  });
  // Fora do relatório: o EAN único, o repetido só com um produto excluído e o código interno repetido.
  const unico = await criar({
    nome: 'AGUA TESTE 500ML',
    codigosBarras: [
      { codigo: EAN_UNICO, principal: true },
      { codigo: '2000000000015', tipo: 'interno' },
    ],
  });
  await criar({ nome: 'SUCO TESTE 1L', codigosBarras: [{ codigo: EAN_EXCLUIDO, principal: true }] });
  const excluido = await criar({
    nome: 'SUCO TESTE 1L EXCLUIDO',
    codigosBarras: [
      { codigo: EAN_EXCLUIDO, principal: true },
      { codigo: '2000000000015', tipo: 'interno' },
    ],
  });
  expect((await amb.http().delete(`/api/produtos/${excluido}`).set(bearer(admin))).status).toBe(204);
  // O interno repetido entre dois produtos vivos (a unicidade não vale para o `interno`).
  await consultar(
    emp.nomeBanco,
    `insert into produtos_codigos_barras (produto_id, codigo, tipo) values ($1, '2000000000015', 'interno')`,
    [produtoB],
  );
  expect(unico).toBeTruthy();
});

afterAll(async () => {
  await amb?.fechar();
});

describe('EAN duplicado (MD 3.6.5; ERP 8.2 "Regras")', () => {
  it('lista cada EAN repetido com os produtos dele, o inativo incluído, sem o interno nem o excluído', async () => {
    const r = await ler();
    expect(r).toMatchObject({ total: 2, pagina: 1, tamanho: 50, modo: 'avisar' });
    expect(r.itens.map((i) => [i.codigo, i.quantidadeProdutos])).toEqual([
      [EAN_A, 2],
      [EAN_B, 2],
    ]);
    const [a, b] = r.itens;
    expect(a!.produtos.map((p) => [p.produtoId, p.principal, p.ativo])).toEqual([
      [produtoA, true, true],
      [produtoB, true, true],
    ]);
    // No EAN_B, o fardo do A (fator 12) e o principal do C, inativo.
    expect(b!.produtos.map((p) => [p.produtoId, p.principal, p.descricao, Number(p.fator), p.ativo])).toEqual(
      [
        [produtoA, false, 'Fardo 12', 12, true],
        [produtoC, true, null, 1, false],
      ],
    );
    expect(b!.produtos[0]).toMatchObject({
      produtoNome: 'CERV TESTE PILSEN LATA 350ML',
      unidadeSigla: 'UN',
      variacaoId: null,
      marcaNome: null,
    });
    expect(typeof b!.produtos[0]!.produtoCodigo).toBe('number');
  });

  it('filtros: o começo do EAN e o nome (que traz o código com todos os produtos); a página com o total', async () => {
    expect((await ler({ ean: EAN_B.slice(0, 12) })).itens.map((i) => i.codigo)).toEqual([EAN_B]);
    const porNome = await ler({ nome: 'fardo teste' });
    expect(porNome.itens.map((i) => i.codigo)).toEqual([EAN_B]);
    expect(porNome.itens[0]!.produtos.map((p) => p.produtoId)).toEqual([produtoA, produtoC]);
    expect((await ler({ nome: 'nada parecido' })).total).toBe(0);
    // Depois da última página: vazia, com o total.
    expect(await ler({ pagina: '2', tamanho: '20' })).toMatchObject({ itens: [], total: 2, pagina: 2 });
    expect((await relatorio({ ean: '78A' })).status).toBe(422);
    expect((await relatorio({ tamanho: '30' })).status).toBe(422);
  });

  it('quem vê o cadastro vê o relatório (produtos.ver); o financeiro não', async () => {
    expect((await ler({}, estoquista)).total).toBe(2);
    expect((await relatorio({}, financeiro)).status).toBe(403);
  });

  it('exportação pela rota comum: uma linha por código × produto, na ordem do relatório', async () => {
    const r = await amb
      .http()
      .get('/api/relatorios/ean-duplicado/exportar')
      .query({ formato: 'xlsx' })
      .set(bearer(admin))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(
      /Relatorio_EAN_Duplicado_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.xlsx/,
    );
    const x = await lerXlsx(r.body as Buffer);
    expect(x.cabecalho).toEqual([
      'EAN',
      'Produtos no EAN',
      'Código',
      'Ref. Interna',
      'Produto',
      'Variação',
      'Marca',
      'EAN principal',
      'Embalagem',
      'Fator',
      'Unidade',
      'Ativo',
    ]);
    expect(x.dados.map((l) => [l[0], l[1], l[4], l[7], l[11]])).toEqual([
      [EAN_A, 2, 'CERV TESTE PILSEN LATA 350ML', 'Sim', 'Sim'],
      [EAN_A, 2, 'CERV TESTE PILSEN LATA 350ML (CADASTRO ANTIGO)', 'Sim', 'Sim'],
      [EAN_B, 2, 'CERV TESTE PILSEN LATA 350ML', 'Não', 'Sim'],
      [EAN_B, 2, 'FARDO TESTE PILSEN 12UN', 'Sim', 'Não'],
    ]);
    // O filtro vale no arquivo também.
    const f = await amb
      .http()
      .get('/api/relatorios/ean-duplicado/exportar')
      .query({ formato: 'csv', ean: EAN_A })
      .set(bearer(admin));
    expect(f.status).toBe(200);
    const csv = f.text.trim().split(/\r?\n/);
    expect(csv).toHaveLength(3);
    expect(csv.slice(1).every((l) => l.includes(EAN_A))).toBe(true);
  });

  it('o agrupamento lê o ix_produtos_codigos_barras_codigo', async () => {
    const c = await conectar(emp.nomeBanco);
    try {
      await c.query('analyze produtos_codigos_barras');
      await c.query('begin');
      // Com poucas linhas o planejador lê a tabela inteira: sem a leitura sequencial, a opção é o índice do código.
      await c.query('set local enable_seqscan = off');
      await c.query('set local enable_bitmapscan = off');
      const q = new PgDialect().sqlToQuery(sqlCodigosDuplicados({}));
      const { rows } = await c.query<{ 'QUERY PLAN': string }>(`explain ${q.sql}`, q.params);
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(
        'Index Scan using ix_produtos_codigos_barras_codigo',
      );
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('corrigir um produto tira o par do relatório; o modo volta a "bloquear"', async () => {
    const atual = (await amb.http().get(`/api/produtos/${produtoB}`).set(bearer(admin))).body;
    const novoEan = ean('900000005');
    const r = await amb
      .http()
      .put(`/api/produtos/${produtoB}`)
      .set(bearer(admin))
      .send({
        ...atual,
        codigosBarras: (atual.codigosBarras as Array<{ codigo: string }>).map((c) =>
          c.codigo === EAN_A ? { ...c, codigo: novoEan } : c,
        ),
      });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const depois = await ler();
    expect(depois.itens.map((i) => i.codigo)).toEqual([EAN_B]);

    // O C deixa de ter o EAN_B: o relatório zera e a empresa volta a "bloquear".
    const c = (await amb.http().get(`/api/produtos/${produtoC}`).set(bearer(admin))).body;
    const rc = await amb
      .http()
      .put(`/api/produtos/${produtoC}`)
      .set(bearer(admin))
      .send({ ...c, codigosBarras: [] });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    expect(await ler()).toMatchObject({ itens: [], total: 0 });
    await consultar(emp.nomeBanco, `delete from configuracoes where chave = 'geral.ean_duplicado'`);
    expect((await ler()).modo).toBe('bloquear');
  });
});
