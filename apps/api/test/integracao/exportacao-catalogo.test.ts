/**
 * Exportação do catálogo de ida e volta (Fase 2, F2-B40; ERP 8.5; README da API › decisão 186), com a fila pg-boss e o
 * S3 em memória. A massa (inventada) entra pela própria importação e pelo formulário: tipos variados (combo com
 * posições, serviço, matéria-prima, inativo), categorias em caminho e com vírgula no nome, códigos fiscais com zero à
 * esquerda, preços de 4 casas, estoque negativo e fracionado, EAN inválido e dois códigos de barras. A planilha
 * exportada (`.xlsx` na hora, `.csv` e a da tarefa acima de 5.000 linhas) reimportada dá 100% "Sem alteração"; editada,
 * só a célula mudada vira "Atualizar". Também: os filtros, o custo só com `produtos.ver_custo`, a loja e o estoque
 * permitidos, o acesso do cadastro (inclusive pela rota comum dos relatórios) e o "Exportar Clientes".
 *
 * A ida e volta **com a planilha real** da Ice Beer roda só na máquina de quem testa: o arquivo não entra no
 * repositório (público, D60) e fica em `apps/api/test/fixtures/planilhas/reais/` (no `.gitignore`); sem ele o teste é
 * pulado.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import writeXlsxFile from 'write-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITE_EXPORTACAO_CATALOGO } from '@genesis/shared';
import { provedorCatalogoClientes, provedorCatalogoProdutos } from '../../src/produtos/exportacao.js';
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

process.env.IMPORTACAO_PREVIAS_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let admin: string;
let loja1: string;
let loja2: string;
let estoqueLoja1: string;
let cd: string;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** A planilha real (não versionada): o primeiro `.xlsx`/`.csv` da pasta, se existir. */
const PASTA_REAIS = join(import.meta.dirname, '..', 'fixtures', 'planilhas', 'reais');
const PLANILHA_REAL = existsSync(PASTA_REAIS)
  ? (readdirSync(PASTA_REAIS)
      .filter((n) => /\.(xlsx|csv)$/i.test(n))
      .map((n) => join(PASTA_REAIS, n))[0] ?? null)
  : null;

/** EAN-13 com o dígito verificador certo a partir de 12 dígitos. */
function ean13(base: string): string {
  const soma = [...base].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${base}${(10 - (soma % 10)) % 10}`;
}

const EAN_CERVEJA = ean13('789200000001');
const EAN_AVULSO_1 = ean13('789200000002');
const EAN_AVULSO_2 = ean13('789200000003');

type Linha = Record<string, string | number | null>;

/** A massa no nosso layout (cabeçalho = a chave da coluna). */
const MASSA: Linha[] = [
  {
    codigo: 501,
    codigo_interno: 'CERV-350',
    ean: EAN_CERVEJA,
    nome: 'CERVEJA TESTE LATA 350ML',
    tipo: 'Simples',
    unidade: 'UN',
    ativo: 'Sim',
    marca: 'MARCA TESTE',
    categoria: 'BEBIDAS > CERVEJA,PROMOÇÕES',
    preco_custo: 2.1,
    preco_venda: 3.4899,
    preco_atacado: 3.19,
    qtd_minima_atacado: 12,
    preco_promocional: 3.29,
    preco_menu_digital: 3.59,
    preco_ifood: 3.99,
    preco_parcelado: 3.69,
    preco_loja: 3.39,
    estoque_minimo: 24,
    estoque_atual: 120,
    ncm: '22030000',
    cest: '0302100',
    cfop_venda_estado: '5405',
    icms_situacao: '500',
    icms_origem: '0',
    localizacao: 'A1-P2',
    peso_g: 350,
    descricao_curta: 'CERV TESTE LT',
    usa_menu_digital: 'Sim',
    balanca: 'Não usa',
  },
  {
    codigo: 502,
    nome: 'GELO TESTE 5KG',
    unidade: 'KG',
    categoria: 'GELO, CARVÃO E LENHA',
    preco_custo: 4,
    preco_venda: 12.5,
    estoque_atual: -2.5,
    ncm: '22011000',
    balanca: 'Peso',
  },
  {
    codigo: 503,
    nome: 'CARVAO TESTE 3KG',
    ean: '17',
    ativo: 'Não',
    preco_custo: 8,
    preco_venda: 15.9,
    estoque_atual: 0,
    ncm: '99999999',
  },
  { codigo: 504, nome: 'SERVICO TESTE ENTREGA', tipo: 'Serviço', preco_venda: 5 },
  {
    codigo: 505,
    codigo_interno: 'COMBO-TESTE',
    nome: 'COMBO TESTE CERVEJA E GELO',
    tipo: 'Combo / kit',
    preco_venda: 9.9,
    composicao: 'CERV-350*2 | 502*1',
  },
  {
    codigo: 506,
    nome: 'MATERIA PRIMA TESTE',
    tipo: 'Matéria-prima',
    preco_custo: 1.2345,
    preco_venda: 0,
  },
  {
    codigo: 507,
    nome: 'LEITE TESTE 1L',
    preco_custo: 3.5,
    preco_venda: 5.99,
    ncm: '04022130',
    cfop_venda_estado: '5102',
    icms_situacao: '00',
    icms_origem: '0',
    icms_aliquota: 18,
    pis_situacao: '01',
    cofins_situacao: '01',
    ipi_situacao: '99',
  },
];
const CABECALHO = [...new Set(MASSA.flatMap((l) => Object.keys(l)))];

async function xlsx(linhas: Linha[], cabecalho: readonly string[] = CABECALHO): Promise<Buffer> {
  return writeXlsxFile([
    cabecalho.map((c) => ({ value: c })),
    ...linhas.map((l) =>
      cabecalho.map((c) => {
        const v = l[c];
        return v === null || v === undefined ? null : { value: v };
      }),
    ),
  ]).toBuffer();
}

const OPCOES = {
  atualizarEstoque: true,
  atualizarEstoqueMinimo: true,
  atualizarPrecos: true,
  criarMarcasCategorias: true,
};

interface Previa {
  arquivoId: string;
  colunasIgnoradas: string[];
  resumo: Record<string, number> & { porAviso: Record<string, number> };
  linhas: Array<{
    linha: number;
    acao: string;
    descricao: string;
    erros: string[];
    avisos: Array<{ codigo: string; mensagem: string }>;
    alteracoes?: Array<{ campo: string; de: string | null; para: string | null }>;
  }>;
}

/** A prévia da importação (`tipo` produtos com a loja e as opções; clientes sem nada). */
async function previa(
  arquivo: Buffer,
  nome: string,
  {
    token = admin,
    tipo = 'produtos',
    lojaId = loja1,
    estoqueId = null,
    opcoes = OPCOES as Record<string, boolean>,
  }: {
    token?: string;
    tipo?: string;
    lojaId?: string | null;
    estoqueId?: string | null;
    opcoes?: Record<string, boolean>;
  } = {},
): Promise<Previa> {
  let req = amb.http().post(`/api/importacoes/${tipo}/previa`).set(bearer(token));
  if (tipo === 'produtos') {
    if (lojaId) req = req.field('lojaId', lojaId);
    if (estoqueId) req = req.field('estoqueId', estoqueId);
    for (const [k, v] of Object.entries(opcoes)) req = req.field(k, String(v));
    if (opcoes.atualizarEstoque) req = req.field('dataContagem', new Date().toISOString());
  }
  const r = await req.attach('arquivo', arquivo, nome);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Previa;
}

/** Espera a tarefa terminar; `prazoMs` maior para a carga real (o teste dela tem 10 min). */
async function aguardarTarefa(id: string, token = admin, prazoMs = 60_000) {
  const fim = Date.now() + prazoMs;
  for (;;) {
    const r = await amb.http().get(`/api/tarefas/${id}`).set(bearer(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    if (r.body.status === 'concluida' || r.body.status === 'falhou') return r.body;
    if (Date.now() > fim) throw new Error(`tarefa não terminou: ${JSON.stringify(r.body)}`);
    await esperar(200);
  }
}

async function confirmar(arquivoId: string, extra: Record<string, unknown> = {}, tipo = 'produtos') {
  const c = await amb
    .http()
    .post(`/api/importacoes/${tipo}/confirmar`)
    .set(bearer(admin))
    .send({
      arquivoId,
      ...(tipo === 'produtos' ? { lojaId: loja1, ...OPCOES, dataContagem: new Date().toISOString() } : {}),
      ...extra,
    });
  expect(c.status, JSON.stringify(c.body)).toBe(202);
  const t = await aguardarTarefa(c.body.tarefaId);
  expect(t.status, t.erro).toBe('concluida');
  return t.resultado as Record<string, unknown>;
}

/** O pedido de exportação: o arquivo (200) ou a tarefa (202, o corpo em JSON). */
async function exportar(rota: string, token = admin) {
  const r = await amb
    .http()
    .get(rota)
    .set(bearer(token))
    .buffer(true)
    .parse((res, cb) => {
      const partes: Buffer[] = [];
      res.on('data', (p: Buffer) => partes.push(p));
      res.on('end', () => cb(null, Buffer.concat(partes)));
    });
  const corpo = r.body as Buffer;
  const json = r.status === 200 ? null : (JSON.parse(corpo.toString('utf8')) as Record<string, unknown>);
  return { status: r.status, corpo, json, cabecalhos: r.headers as Record<string, string> };
}

/** Cabeçalho e linhas da 1ª aba do `.xlsx`. */
async function lerXlsx(conteudo: Buffer) {
  const livro = new ExcelJS.Workbook();
  await livro.xlsx.load(conteudo as unknown as ArrayBuffer);
  const aba = livro.worksheets[0]!;
  const linhas: unknown[][] = [];
  aba.eachRow((r) => linhas.push((r.values as unknown[]).slice(1)));
  return { cabecalho: linhas[0] as string[], dados: linhas.slice(1) };
}

const semAlteracaoTotal = (p: Previa, linhas: number) => {
  const problemas = p.linhas.filter((l) => l.acao !== 'sem_alteracao');
  expect(problemas, JSON.stringify(problemas, null, 1)).toEqual([]);
  expect(p.resumo).toMatchObject({ linhas, sem_alteracao: linhas, criar: 0, atualizar: 0, ignorar: 0 });
  expect(p.colunasIgnoradas).toEqual([]);
};

const contarProdutos = async (somenteAtivos = false) =>
  Number(
    (
      await consultar<{ n: string }>(
        emp.nomeBanco,
        `select count(*)::text as n from produtos where excluido_em is null ${somenteAtivos ? 'and ativo' : ''}`,
      )
    )[0]!.n,
  );

/** Perfil de teste com exatamente estas permissões. */
async function perfil(chave: string, permissoes: string[]): Promise<void> {
  const [p] = await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into perfis (nome, descricao, chave_sistema) values ($1, $1, $1) returning id',
    [chave],
  );
  for (const permissao of permissoes)
    await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
      p!.id,
      permissao,
    ]);
}

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-expcat-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2');
  [{ id: estoqueLoja1 }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'select estoque_id as id from lojas where id = $1',
    [loja1],
  )) as [{ id: string }];
  [{ id: cd }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD - Estoque Teste', 'deposito') returning id",
  )) as [{ id: string }];

  // A massa: a importação (com o "Definir" do estoque da loja 1) e um produto pelo formulário com dois códigos.
  const p = await previa(await xlsx(MASSA), 'massa.xlsx');
  expect(p.resumo, JSON.stringify(p.linhas.filter((l) => l.erros.length))).toMatchObject({
    criar: MASSA.length,
    ignorar: 0,
  });
  await confirmar(p.arquivoId);
  const un = (
    await consultar<{ id: string }>(emp.nomeBanco, "select id from unidades_medida where sigla = 'UN'")
  )[0]!.id;
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer(admin))
    .send({
      nome: 'AVULSO TESTE DOIS CODIGOS',
      unidadeId: un,
      precoCusto: '1,5',
      precoVenda: '2,75',
      codigosBarras: [
        { codigo: EAN_AVULSO_1, principal: true },
        { codigo: EAN_AVULSO_2, principal: false },
      ],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

const ROTA = '/api/produtos/exportacao';

describe('ida e volta (ERP 8.5)', () => {
  it('xlsx da loja com as informações da NF: reimportado, 100% "Sem alteração" (nada gravado)', async () => {
    const versoes = await consultar<{ v: string }>(
      emp.nomeBanco,
      "select string_agg(versao::text, ',' order by codigo) as v from produtos",
    );
    const e = await exportar(`${ROTA}?lojaId=${loja1}&informacoesNf=true&somenteAtivos=false&formato=xlsx`);
    expect(e.status).toBe(200);
    expect(e.cabecalhos['content-disposition']).toMatch(
      /Exportacao_Produtos_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.xlsx/,
    );
    const { cabecalho, dados } = await lerXlsx(e.corpo);
    expect(cabecalho.slice(0, 4)).toEqual(['Id (UUID)', 'Código', 'Código interno', 'EAN']);
    expect(cabecalho).toEqual(
      expect.arrayContaining([
        'Preço da loja',
        'Estoque mínimo',
        'Estoque atual',
        'NCM',
        'CST/CSOSN do ICMS',
      ]),
    );
    expect(dados).toHaveLength(await contarProdutos());
    const col = (rotulo: string) => cabecalho.indexOf(rotulo);
    const cerveja = dados.find((l) => l[col('Código')] === 501)!;
    expect(cerveja[col('Categoria')]).toBe('BEBIDAS > CERVEJA,PROMOÇÕES');
    expect(cerveja[col('Preço de venda')]).toBe(3.4899);
    expect(cerveja[col('Preço da loja')]).toBe(3.39);
    expect(cerveja[col('Estoque atual')]).toBe(120);
    expect(cerveja[col('CEST')]).toBe('0302100');
    const leite = dados.find((l) => l[col('Código')] === 507)!;
    expect([leite[col('NCM')], leite[col('CST/CSOSN do ICMS')], leite[col('CST do PIS')]]).toEqual([
      '04022130',
      '00',
      '01',
    ]);
    // Combo e serviço sem saldo próprio: o estoque atual fica vazio (a importação o ignora).
    const combo = dados.find((l) => l[col('Código')] === 505)!;
    expect(combo[col('Estoque atual')] ?? null).toBeNull();
    expect(dados.find((l) => l[col('Código')] === 502)![col('Estoque atual')]).toBe(-2.5);

    const p = await previa(e.corpo, 'Exportacao_Produtos.xlsx');
    semAlteracaoTotal(p, dados.length);
    // A confirmação também não grava nada: nem versão nova (o sync não desce nada) nem acerto.
    const r = await confirmar(p.arquivoId);
    expect(r).toMatchObject({ criados: 0, atualizados: 0, semAlteracao: dados.length, acertoId: null });
    expect(
      await consultar<{ v: string }>(
        emp.nomeBanco,
        "select string_agg(versao::text, ',' order by codigo) as v from produtos",
      ),
    ).toEqual(versoes);
    const [aud] = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from auditoria where acao = 'exportar' and entidade = 'produtos'
          and localizacao = 'Produtos › Exportação'`,
    );
    expect(aud!.n).toBeGreaterThanOrEqual(1);
  });

  it('csv: o mesmo layout volta igual (vírgula decimal, zeros à esquerda)', async () => {
    const e = await exportar(`${ROTA}?lojaId=${loja1}&informacoesNf=true&somenteAtivos=false&formato=csv`);
    expect(e.status).toBe(200);
    const texto = e.corpo.toString('utf8');
    expect(texto.startsWith('﻿Id (UUID);Código;')).toBe(true);
    expect(texto).toContain(';3,4899;');
    const p = await previa(e.corpo, 'Exportacao_Produtos.csv');
    semAlteracaoTotal(p, await contarProdutos());
  });

  it('acima do limite vira tarefa; o arquivo da tarefa também volta 100% "Sem alteração"', async () => {
    const opcoes = amb.servicos.exportacoes.opcoes;
    const antes = opcoes.limiteNaHora;
    opcoes.limiteNaHora = 3;
    try {
      const e = await exportar(`${ROTA}?lojaId=${loja1}&informacoesNf=true&somenteAtivos=false`);
      expect(e.status, JSON.stringify(e.json)).toBe(202);
      expect(e.json).toMatchObject({ linhas: await contarProdutos() });
      const t = await aguardarTarefa(String(e.json!.tarefaId));
      expect(t.status, t.erro).toBe('concluida');
      expect(t.resultado).toMatchObject({ relatorio: 'catalogo-produtos', formato: 'xlsx' });
      const baixado = Buffer.from(await (await fetch(t.download as string)).arrayBuffer());
      semAlteracaoTotal(await previa(baixado, 'tarefa.xlsx'), await contarProdutos());
    } finally {
      opcoes.limiteNaHora = antes;
    }
  });

  it('o limite do catálogo (5.000 linhas) vale abaixo do limite da instância: o do provedor vira tarefa', async () => {
    // Os dois provedores do catálogo levam o limite próprio (ERP 8.5: "gera tarefa acima de 5.000 linhas").
    expect(LIMITE_EXPORTACAO_CATALOGO).toBe(5_000);
    expect(provedorCatalogoProdutos().limiteNaHora).toBe(LIMITE_EXPORTACAO_CATALOGO);
    expect(provedorCatalogoClientes().limiteNaHora).toBe(LIMITE_EXPORTACAO_CATALOGO);
    // O `Math.min` com o limite da instância: um provedor igual ao de produtos, com o limite próprio baixo, e a
    // instância bem acima. Só o do provedor manda para a tarefa.
    const opcoes = amb.servicos.exportacoes.opcoes;
    const antes = opcoes.limiteNaHora;
    opcoes.limiteNaHora = 100_000;
    try {
      const chave = `catalogo-produtos-limite-${Date.now()}`;
      amb.servicos.exportacoes.registrar({ ...provedorCatalogoProdutos(), chave, limiteNaHora: 3 });
      const rota = `/api/relatorios/${chave}/exportar?lojaId=${loja1}&somenteAtivos=false`;
      const e = await exportar(rota);
      expect(e.status, JSON.stringify(e.json)).toBe(202);
      expect(e.json).toMatchObject({ linhas: await contarProdutos() });
      const t = await aguardarTarefa(String(e.json!.tarefaId));
      expect(t.status, t.erro).toBe('concluida');
      // O provedor de verdade, com o limite de 5.000, baixa a mesma massa na hora.
      expect((await exportar(`${ROTA}?lojaId=${loja1}&somenteAtivos=false`)).status).toBe(200);
    } finally {
      opcoes.limiteNaHora = antes;
    }
  });

  it('editada: só a célula mudada vira "Atualizar"', async () => {
    const e = await exportar(`${ROTA}?lojaId=${loja1}&somenteAtivos=false`);
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(e.corpo as unknown as ArrayBuffer);
    const aba = livro.worksheets[0]!;
    const cab = (aba.getRow(1).values as unknown[]).slice(1) as string[];
    const colVenda = cab.indexOf('Preço de venda') + 1;
    aba.eachRow((r, n) => {
      if (n > 1 && r.getCell(cab.indexOf('Código') + 1).value === 507) r.getCell(colVenda).value = 6.49;
    });
    const editado = Buffer.from(await livro.xlsx.writeBuffer());
    const p = await previa(editado, 'editado.xlsx');
    expect(p.resumo).toMatchObject({ atualizar: 1, sem_alteracao: (await contarProdutos()) - 1, ignorar: 0 });
    expect(p.linhas.find((l) => l.acao === 'atualizar')).toMatchObject({
      descricao: 'LEITE TESTE 1L',
      alteracoes: [{ campo: 'precoVenda', de: '5,99', para: '6,49' }],
    });
  });

  it('o CD (estoque sem loja) sai só com o estoque atual e volta com a carga do CD', async () => {
    const e = await exportar(`${ROTA}?estoqueId=${cd}&somenteAtivos=false`);
    expect(e.status).toBe(200);
    const { cabecalho } = await lerXlsx(e.corpo);
    expect(cabecalho).toContain('Estoque atual');
    expect(cabecalho).not.toContain('Preço da loja');
    expect(cabecalho).not.toContain('Estoque mínimo');
    const p = await previa(e.corpo, 'cd.xlsx', {
      lojaId: null,
      estoqueId: cd,
      opcoes: { atualizarEstoque: true, atualizarPrecos: true },
    });
    expect(p.resumo).toMatchObject({ sem_alteracao: await contarProdutos(), ignorar: 0 });
  });
});

describe('filtros', () => {
  const codigos = async (consulta: string) => {
    const e = await exportar(`${ROTA}?${consulta}`);
    expect(e.status, e.json ? JSON.stringify(e.json) : '').toBe(200);
    const { cabecalho, dados } = await lerXlsx(e.corpo);
    return dados.map((l) => l[cabecalho.indexOf('Código')] as number).sort((a, b) => a - b);
  };

  it('Somente ativos (padrão Sim), Com NCM inválido e Estoque zerado ou negativo', async () => {
    const ativos = await codigos('');
    expect(ativos).not.toContain(503);
    expect(ativos).toHaveLength(await contarProdutos(true));
    // NCM vazio ou fora da tabela vigente (a regra do filtro "Sem NCM" da listagem).
    const semNcm = (
      await consultar<{ codigo: number }>(
        emp.nomeBanco,
        `select codigo from produtos p where excluido_em is null and ativo
            and (ncm is null or not exists (select 1 from ncms n where n.codigo = p.ncm and n.excluido_em is null
                                              and (n.vigencia_fim is null or n.vigencia_fim >= current_date)))
          order by codigo`,
      )
    ).map((r) => r.codigo);
    expect(await codigos('ncmInvalido=true')).toEqual(semNcm);
    expect(semNcm).toEqual(expect.arrayContaining([504, 505, 506]));
    expect(semNcm).not.toContain(501);
    // Saldo ≤ 0 no estoque da loja, só produto com saldo próprio: o gelo negativo, a matéria-prima, o leite e o
    // avulso sem saldo gravado; não a cerveja (120), o combo nem o serviço.
    const [avulso] = await consultar<{ codigo: number }>(
      emp.nomeBanco,
      "select codigo from produtos where nome = 'AVULSO TESTE DOIS CODIGOS'",
    );
    expect(await codigos(`lojaId=${loja1}&estoqueZerado=true`)).toEqual(
      [avulso!.codigo, 502, 506, 507].sort((a, b) => a - b),
    );
    const sem = await exportar(`${ROTA}?estoqueZerado=true`);
    expect(sem.status).toBe(422);
    const ambos = await exportar(`${ROTA}?lojaId=${loja1}&estoqueId=${cd}`);
    expect(ambos.status).toBe(422);
  });
});

describe('permissões', () => {
  it('sem produtos.ver_custo: sem o custo e o markup, e a reimportação continua "Sem alteração"', async () => {
    await perfil('exp_sem_custo', ['produtos.ver', 'produtos.exportar', 'produtos.importar']);
    await criarUsuario(emp.nomeBanco, {
      login: 'sem_custo',
      perfil: 'exp_sem_custo',
      lojas: [loja1],
      estoques: [estoqueLoja1],
    });
    const token = await amb.entrar(emp.codigo, 'sem_custo', SENHA_TESTE);
    const e = await exportar(`${ROTA}?lojaId=${loja1}&somenteAtivos=false`, token);
    expect(e.status).toBe(200);
    const { cabecalho } = await lerXlsx(e.corpo);
    expect(cabecalho).not.toContain('Preço de custo');
    expect(cabecalho).not.toContain('Markup %');
    expect(cabecalho).toContain('Preço de venda');
    const p = await previa(e.corpo, 'sem_custo.xlsx', {
      token,
      opcoes: { atualizarPrecos: true, atualizarEstoqueMinimo: true },
    });
    semAlteracaoTotal(p, await contarProdutos());
    // A loja e o estoque fora dos permitidos: 403.
    expect((await exportar(`${ROTA}?lojaId=${loja2}`, token)).status).toBe(403);
    expect((await exportar(`${ROTA}?estoqueId=${cd}`, token)).status).toBe(403);
  });

  it('loja permitida com o estoque dela fora dos permitidos: sem o estoque atual (e o filtro dele é 403)', async () => {
    await criarUsuario(emp.nomeBanco, {
      login: 'sem_estoque',
      perfil: 'exp_sem_custo',
      lojas: [loja1],
      estoques: [],
    });
    const token = await amb.entrar(emp.codigo, 'sem_estoque', SENHA_TESTE);
    const e = await exportar(`${ROTA}?lojaId=${loja1}`, token);
    expect(e.status).toBe(200);
    const { cabecalho } = await lerXlsx(e.corpo);
    expect(cabecalho).toContain('Preço da loja');
    expect(cabecalho).not.toContain('Estoque atual');
    expect((await exportar(`${ROTA}?lojaId=${loja1}&estoqueZerado=true`, token)).status).toBe(403);
  });

  it('exportar é do cadastro: sem a permissão de exportar, ou sem ver produtos (também pela rota dos relatórios), 403', async () => {
    await perfil('exp_so_ver', ['produtos.ver', 'pessoas.ver']);
    await perfil('exp_so_relatorios', ['relatorios.exportar']);
    await perfil('exp_relatorios_ver', ['relatorios.exportar', 'produtos.ver', 'pessoas.ver']);
    for (const login of ['so_ver', 'so_relatorios', 'relatorios_ver'])
      await criarUsuario(emp.nomeBanco, { login, perfil: `exp_${login}`, lojas: [loja1] });
    const soVer = await amb.entrar(emp.codigo, 'so_ver', SENHA_TESTE);
    const soRelatorios = await amb.entrar(emp.codigo, 'so_relatorios', SENHA_TESTE);
    const relatoriosVer = await amb.entrar(emp.codigo, 'relatorios_ver', SENHA_TESTE);
    expect((await exportar(ROTA, soVer)).status).toBe(403);
    expect((await exportar('/api/pessoas/exportacao', soVer)).status).toBe(403);
    expect((await exportar(ROTA, soRelatorios)).status).toBe(403);
    // A rota comum dos relatórios não contorna o acesso do cadastro.
    expect((await exportar('/api/relatorios/catalogo-produtos/exportar', soRelatorios)).status).toBe(403);
    expect((await exportar('/api/relatorios/catalogo-clientes/exportar', soRelatorios)).status).toBe(403);
    // `relatorios.exportar` vale como a de exportar (ERP 3.1), com o ver do cadastro.
    expect((await exportar(ROTA, relatoriosVer)).status).toBe(200);
    expect((await exportar('/api/pessoas/exportacao', relatoriosVer)).status).toBe(200);
  });
});

describe('Exportar Clientes', () => {
  it('só os clientes não anonimizados, no layout da importação de clientes, que os reconhece de volta', async () => {
    const clientes: Linha[] = [
      {
        tipo: 'PF',
        nome: 'MARIA TESTE DA SILVA',
        cpf_cnpj: '529.982.247-25',
        telefone: '(43) 99999-0000',
        email: 'maria@exemplo.com',
        cep: '01001-000',
        logradouro: 'Rua Exemplo',
        numero: '100',
        bairro: 'Centro',
        cidade: 'São Paulo',
        uf: 'SP',
        limite_compras: 500,
        nascimento: '01/05/1990',
        categorias: 'Cliente',
      },
      {
        tipo: 'PJ',
        nome: 'EMPRESA TESTE LTDA',
        cpf_cnpj: '11.222.333/0001-81',
        categorias: 'Cliente, Fornecedor',
      },
      { nome: 'FORNECEDOR SO TESTE', categorias: 'Fornecedor' },
      { nome: 'CLIENTE INATIVO TESTE', categorias: 'Cliente' },
      { nome: 'CLIENTE ANONIMIZADO TESTE', categorias: 'Cliente' },
    ];
    const cab = [...new Set(clientes.flatMap((l) => Object.keys(l)))];
    const p = await previa(await xlsx(clientes, cab), 'clientes.xlsx', { tipo: 'clientes' });
    expect(p.resumo).toMatchObject({ criar: clientes.length, ignorar: 0 });
    await confirmar(p.arquivoId, {}, 'clientes');
    await consultar(emp.nomeBanco, "update pessoas set ativa = false where nome = 'CLIENTE INATIVO TESTE'");
    await consultar(
      emp.nomeBanco,
      "update pessoas set anonimizada_em = now() where nome = 'CLIENTE ANONIMIZADO TESTE'",
    );

    const e = await exportar('/api/pessoas/exportacao?formato=xlsx');
    expect(e.status).toBe(200);
    expect(e.cabecalhos['content-disposition']).toMatch(/Exportacao_Clientes_/);
    const { cabecalho, dados } = await lerXlsx(e.corpo);
    expect(cabecalho.slice(0, 4)).toEqual(['Id (UUID)', 'Código', 'Tipo (PF/PJ)', 'Nome']);
    const col = (r: string) => cabecalho.indexOf(r);
    const nomes = dados.map((l) => l[col('Nome')]).sort();
    expect(nomes).toEqual(['EMPRESA TESTE LTDA', 'MARIA TESTE DA SILVA']);
    const maria = dados.find((l) => l[col('Nome')] === 'MARIA TESTE DA SILVA')!;
    expect([
      maria[col('CPF/CNPJ')],
      maria[col('Telefone')],
      maria[col('Cidade')],
      maria[col('Nascimento')],
    ]).toEqual(['529.982.247-25', '(43) 99999-0000', 'São Paulo', '01/05/1990']);
    const todos = await exportar('/api/pessoas/exportacao?somenteAtivos=false');
    expect((await lerXlsx(todos.corpo)).dados).toHaveLength(3);

    // Reimportada, cada linha acha o próprio cliente (pelo Id) sem erro nem cadastro novo: 100% "Sem alteração".
    const volta = await previa(e.corpo, 'Exportacao_Clientes.xlsx', { tipo: 'clientes' });
    expect(volta.colunasIgnoradas).toEqual([]);
    expect(volta.linhas.every((l) => !l.erros.length && !l.avisos.length)).toBe(true);
    expect(volta.linhas.filter((l) => l.acao !== 'sem_alteracao')).toEqual([]);
    expect(volta.resumo).toMatchObject({ linhas: 2, criar: 0, atualizar: 0, sem_alteracao: 2, ignorar: 0 });
  });

  interface EstadoCliente {
    nome: string;
    versao: string;
    limite: string | null;
    telefones: Array<{ id: string; n: string; p: boolean; v: number }>;
    emails: Array<{ id: string; e: string; p: boolean; v: number }>;
    enderecos: Array<{ id: string; tipo: string; ref: string | null; log: string | null; v: number }>;
  }
  const semVersao = <T extends { v: number }>(l: T[]) => l.map(({ v: _v, ...x }) => x);

  /** Versões, filhas (com a marca de principal) e a referência do endereço dos clientes (EMPRESA, MARIA). */
  const estadoClientes = () =>
    consultar<EstadoCliente>(
      emp.nomeBanco,
      `select p.nome, p.versao, p.limite_compras::text as limite,
              (select json_agg(json_build_object('id', t.id, 'n', t.ddd || t.numero, 'p', t.principal, 'v', t.versao)
                       order by t.id)
                 from pessoas_telefones t where t.pessoa_id = p.id and t.excluido_em is null) as telefones,
              (select json_agg(json_build_object('id', m.id, 'e', m.email, 'p', m.principal, 'v', m.versao)
                       order by m.id)
                 from pessoas_emails m where m.pessoa_id = p.id and m.excluido_em is null) as emails,
              (select json_agg(json_build_object('id', en.id, 'tipo', en.tipo, 'ref', en.referencia,
                                                 'log', en.logradouro, 'v', en.versao) order by en.id)
                 from pessoas_enderecos en where en.pessoa_id = p.id and en.excluido_em is null) as enderecos
         from pessoas p where p.excluido_em is null and p.nome in ('MARIA TESTE DA SILVA', 'EMPRESA TESTE LTDA')
        order by p.nome`,
    );

  it('reimportar a planilha exportada sem mexer não grava nada; editada, só a célula mudada é gravada', async () => {
    // O que a exportação não leva fica no cadastro: o ponto de referência e um segundo telefone.
    await consultar(
      emp.nomeBanco,
      `update pessoas_enderecos set referencia = 'ao lado do mercado'
        where pessoa_id = (select id from pessoas where nome = 'MARIA TESTE DA SILVA')`,
    );
    await consultar(
      emp.nomeBanco,
      `insert into pessoas_telefones (pessoa_id, tipo, ddd, numero, principal)
       select id, 'residencial', '43', '33334444', false from pessoas where nome = 'MARIA TESTE DA SILVA'`,
    );
    const antes = await estadoClientes();
    const auditoria = async () =>
      Number(
        (
          await consultar<{ n: string }>(
            emp.nomeBanco,
            "select count(*)::text as n from auditoria where entidade = 'pessoas' and acao = 'editar'",
          )
        )[0]!.n,
      );
    const auditoriaAntes = await auditoria();

    const e = await exportar('/api/pessoas/exportacao?formato=xlsx');
    const igual = await previa(e.corpo, 'Exportacao_Clientes.xlsx', { tipo: 'clientes' });
    expect(igual.resumo).toMatchObject({ sem_alteracao: 2, atualizar: 0 });
    const r = await confirmar(igual.arquivoId, {}, 'clientes');
    expect(r).toMatchObject({ criados: 0, atualizados: 0, semAlteracao: 2, comErro: 0 });
    // Nada gravado: nem versão nova (os PDVs não baixam de novo), nem auditoria, e as filhas como estavam.
    expect(await estadoClientes()).toEqual(antes);
    expect(await auditoria()).toBe(auditoriaAntes);

    // Editada no Excel: só o e-mail da MARIA muda; o resto do cadastro fica.
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(e.corpo as unknown as ArrayBuffer);
    const aba = livro.worksheets[0]!;
    const cab = (aba.getRow(1).values as unknown[]).slice(1) as string[];
    aba.eachRow((linha, n) => {
      if (n > 1 && linha.getCell(cab.indexOf('Nome') + 1).value === 'MARIA TESTE DA SILVA')
        linha.getCell(cab.indexOf('E-mail') + 1).value = 'maria.nova@exemplo.com';
    });
    const editado = await previa(Buffer.from(await livro.xlsx.writeBuffer()), 'editado.xlsx', {
      tipo: 'clientes',
    });
    expect(editado.resumo).toMatchObject({ atualizar: 1, sem_alteracao: 1 });
    expect(editado.linhas.find((l) => l.acao === 'atualizar')!.alteracoes).toEqual([
      { campo: 'email', rotulo: 'E-mail', de: 'maria@exemplo.com', para: 'maria.nova@exemplo.com' },
    ]);
    expect(await confirmar(editado.arquivoId, {}, 'clientes')).toMatchObject({
      atualizados: 1,
      semAlteracao: 1,
    });
    const depois = await estadoClientes();
    const [empresaAntes, mariaAntes] = antes as [EstadoCliente, EstadoCliente];
    const [empresaDepois, mariaDepois] = depois as [EstadoCliente, EstadoCliente];
    expect(empresaDepois).toEqual(empresaAntes);
    // Os telefones e o endereço (com a referência) não mudam; o e-mail novo é o principal, e o antigo fica.
    expect(semVersao(mariaDepois.telefones)).toEqual(semVersao(mariaAntes.telefones));
    expect(mariaDepois.telefones.filter((t) => t.p).map((t) => t.n)).toEqual(['43999990000']);
    expect(semVersao(mariaDepois.enderecos)).toEqual(semVersao(mariaAntes.enderecos));
    expect(mariaDepois.enderecos[0]).toMatchObject({ tipo: 'principal', ref: 'ao lado do mercado' });
    expect(
      mariaDepois.emails.map((m) => [m.e, m.p]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ['maria.nova@exemplo.com', true],
      ['maria@exemplo.com', false],
    ]);
    expect(mariaDepois.limite).toBe(mariaAntes.limite);
  });

  it('o telefone que já existe só passa a principal; o endereço editado mantém o id e a referência', async () => {
    const e = await exportar('/api/pessoas/exportacao?formato=xlsx');
    const livro = new ExcelJS.Workbook();
    await livro.xlsx.load(e.corpo as unknown as ArrayBuffer);
    const aba = livro.worksheets[0]!;
    const cab = (aba.getRow(1).values as unknown[]).slice(1) as string[];
    aba.eachRow((linha, n) => {
      if (n > 1 && linha.getCell(cab.indexOf('Nome') + 1).value === 'MARIA TESTE DA SILVA') {
        linha.getCell(cab.indexOf('Telefone') + 1).value = '(43) 3333-4444';
        linha.getCell(cab.indexOf('Número') + 1).value = '200';
      }
    });
    const antes = (await estadoClientes())[1]!;
    const p = await previa(Buffer.from(await livro.xlsx.writeBuffer()), 'telefone.xlsx', {
      tipo: 'clientes',
    });
    expect(p.linhas.find((l) => l.acao === 'atualizar')!.alteracoes).toEqual([
      { campo: 'telefone', rotulo: 'Telefone', de: '(43) 99999-0000', para: '(43) 3333-4444' },
      {
        campo: 'endereco',
        rotulo: 'Endereço',
        de: 'Rua Exemplo, 100 - Centro - São Paulo/SP - 01001-000',
        para: 'Rua Exemplo, 200 - Centro - São Paulo/SP - 01001-000',
      },
    ]);
    await confirmar(p.arquivoId, {}, 'clientes');
    const depois = (await estadoClientes())[1]!;
    expect(depois.telefones.map((t) => [t.id, t.n, t.p])).toEqual(
      antes.telefones.map((t) => [t.id, t.n, t.n === '4333334444']),
    );
    expect(depois.enderecos.map((en) => [en.id, en.tipo, en.ref])).toEqual([
      [antes.enderecos[0]!.id, 'principal', 'ao lado do mercado'],
    ]);
    const [numero] = await consultar<{ numero: string }>(
      emp.nomeBanco,
      'select numero from pessoas_enderecos where id = $1',
      [antes.enderecos[0]!.id],
    );
    expect(numero!.numero).toBe('200');
  });
});

/** Cada espera da carga real (a importação de ~1.664 produtos, uma transação por produto, e a exportação). */
const PRAZO_REAL = 540_000;

describe('planilha real (só local)', () => {
  it.skipIf(!PLANILHA_REAL)(
    'a carga real numa empresa nova, exportada e reimportada: 100% "Sem alteração"',
    async () => {
      const outra = await amb.criarEmpresa();
      const token = await amb.entrar(outra.codigo, 'admin', outra.senha);
      const loja = await criarLoja(outra.nomeBanco, 1, 'Loja 1');
      const conteudo = readFileSync(PLANILHA_REAL!);
      const primeira = await previa(conteudo, PLANILHA_REAL!, { token, lojaId: loja });
      const c = await amb
        .http()
        .post('/api/importacoes/produtos/confirmar')
        .set(bearer(token))
        .send({
          arquivoId: primeira.arquivoId,
          lojaId: loja,
          ...OPCOES,
          dataContagem: new Date().toISOString(),
        });
      expect(c.status, JSON.stringify(c.body)).toBe(202);
      const t = await aguardarTarefa(c.body.tarefaId, token, PRAZO_REAL);
      expect(t.status, t.erro).toBe('concluida');
      const e = await exportar(`${ROTA}?lojaId=${loja}&informacoesNf=true&somenteAtivos=false`, token);
      let arquivo = e.corpo;
      if (e.status === 202) {
        const tt = await aguardarTarefa(String(e.json!.tarefaId), token, PRAZO_REAL);
        expect(tt.status, tt.erro).toBe('concluida');
        arquivo = Buffer.from(await (await fetch(tt.download as string)).arrayBuffer());
      } else expect(e.status).toBe(200);
      const [n] = await consultar<{ n: string }>(
        outra.nomeBanco,
        'select count(*)::text as n from produtos where excluido_em is null',
      );
      semAlteracaoTotal(
        await previa(arquivo, 'Exportacao_Produtos.xlsx', { token, lojaId: loja }),
        Number(n!.n),
      );
    },
    600_000,
  );
});
