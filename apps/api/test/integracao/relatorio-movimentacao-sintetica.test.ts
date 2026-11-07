/**
 * Relatório Movimentação de Estoque, visão sintética e exportação (Fase 2, F2-B33; ERP 16.5, 3.5, 3.6; README da API ›
 * decisão 180), pela API do ERP, com a fila pg-boss e o S3 em memória: sem filtro, a sintética **fecha com a
 * analítica** em cada linha (saldo inicial = o anterior do primeiro movimento da linha, final = o posterior do último,
 * entradas e saídas = as somas das quantidades, custos = as somas do custo gravado), inclusive com saldo inicial
 * diferente de zero e com o mesmo produto em dois tipos de estoque (linhas e saldos separados); com filtro, fecham as
 * entradas, as saídas e os custos (as somas da analítica filtrada), e os saldos continuam os do começo e do fim do
 * período (não o anterior do primeiro movimento filtrado); a **última compra** vem do `RECEB_NFE` da nota importada e, no período que termina antes dela, do
 * `RECEB_MANUAL` anterior (a última pela data até o fim do período, no local, em qualquer tipo de estoque; a compra de
 * outro local não conta); a
 * página com o total e os totais; o custo só com `produtos.ver_custo`; e a **exportação** das duas visões
 * (`Relatorio_Movimentacao_Estoque_DD_MM_AAAA_HH_MM.xlsx`): na hora, as colunas da visão e o corte do custo; acima do
 * limite (pequeno aqui), os 12 meses (366 dias) como tarefa, com o arquivo inteiro e a auditoria. No fim o razão
 * refaz as projeções idênticas (`conferirRazaoDoBanco`).
 */
import { setTimeout as esperar } from 'node:timers/promises';
import {
  completarCnpj,
  type LinhaMovimentacaoEstoque,
  type LinhaMovimentacaoSintetica,
  type RespostaMovimentacaoEstoque,
  type RespostaMovimentacaoSintetica,
} from '@genesis/shared';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CNPJ_LOJA_1, fixtureNfe } from '../fixtures/nfe/fixtures.js';
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
import { conferirRazaoDoBanco } from './razao.js';
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

process.env.NFE_IMPORTACOES_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let loja1: string;
let estoque1: string;
let estoque2: string;
let un: string;
let fornecedor: string;
let tokenAdmin: string;
/** Estoquista da Loja 1 (só o estoque dela), sem `produtos.ver_custo`, com `relatorios.exportar` (dado no teste). */
let tokenEstoquista: string;

/**
 * Cerveja: Definir 20 há 10 dias, recebimento manual 5 a R$ 6 há 3 dias, a NF-e (10 CX × 12) hoje, saída de 3 (no tipo
 * Disponível); na Avaria, Definir 5 há 20 dias (antes de todo período dos testes) e saída de 2 hoje: a segunda linha da
 * cerveja na sintética, com saldo inicial 5.
 */
let cerveja: string;
let disponivel: string;
let avaria: string;
let nomeDisponivel: string;
let nomeAvaria: string;
/** Refrigerante e água: só a NF-e. */
let refri: string;
let agua: string;
/** Sem compra na Loja 1 (só a contagem); comprado na Loja 2. */
let semCompra: string;
/** 25 produtos num acerto de entrada só (a segunda página da sintética). */
const lote: string[] = [];
let custoNfeCerveja: string;
let dataNfe: string;

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const agora = () => new Date().toISOString();
const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
/**
 * O instante de "hoje" dos testes: guardado no fim do `beforeAll`, logo depois do último lançamento. Os períodos
 * ("hoje", "ontem", "só hoje") saem dele, e não da hora de cada consulta: a meia-noite de Brasília entre o
 * `beforeAll` e um teste não muda o dia dos movimentos lançados "hoje".
 */
let referencia: number | undefined;
/** Hoje − `dias` no fuso de Brasília (`AAAA-MM-DD`), o da empresa de teste. */
const diaLocal = (dias = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    new Date((referencia ?? Date.now()) - dias * 86_400_000),
  );
const periodo = (dias = 11) => ({ estoqueId: estoque1, dataInicial: diaLocal(dias), dataFinal: diaLocal() });

async function sintetica(
  query: Record<string, string>,
  tk = tokenAdmin,
): Promise<RespostaMovimentacaoSintetica> {
  const r = await amb
    .http()
    .get('/api/relatorios/movimentacao-estoque/sintetica')
    .query(query)
    .set(bearer(tk));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as RespostaMovimentacaoSintetica;
}

/** A sintética inteira (todas as páginas de 50). */
async function sinteticaInteira(query: Record<string, string>, tk = tokenAdmin) {
  const itens: LinhaMovimentacaoSintetica[] = [];
  for (let pagina = 1; pagina < 50; pagina++) {
    const r = await sintetica({ ...query, pagina: String(pagina), tamanho: '50' }, tk);
    itens.push(...r.itens);
    if (itens.length >= r.total) return itens;
  }
  throw new Error('a sintética não terminou');
}

/** A analítica inteira, seguindo o cursor. */
async function analitica(query: Record<string, string>, tk = tokenAdmin) {
  const itens: LinhaMovimentacaoEstoque[] = [];
  let cursor: string | null = null;
  do {
    const r = await amb
      .http()
      .get('/api/relatorios/movimentacao-estoque')
      .query({ ...query, tamanho: '50', ...(cursor ? { cursor } : {}) })
      .set(bearer(tk));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body as RespostaMovimentacaoEstoque;
    itens.push(...b.itens);
    cursor = b.proximoCursor;
  } while (cursor);
  return itens;
}

async function criarProduto(nome: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '10', precoCusto: '4' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

async function acerto(corpo: Record<string, unknown>): Promise<string> {
  const a = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({ estoqueId: estoque1, motivo: 'Teste da sintética', dataContagem: agora(), ...corpo });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const ef = await amb
    .http()
    .post(`/api/acertos/${a.body.id}/efetivar`)
    .set(bearer())
    .send({ versao: a.body.versao });
  expect(ef.status, JSON.stringify(ef.body)).toBe(200);
  return a.body.id as string;
}

async function recebimento(lojaId: string, produtoId: string, quantidade: string, preco: string) {
  const rec = await amb
    .http()
    .post('/api/recebimentos')
    .set(bearer())
    .send({
      lojaId,
      fornecedorId: fornecedor,
      dataRecebimento: diaLocal(),
      itens: [{ produtoId, fator: '1', quantidade, precoCompra: preco }],
    });
  expect(rec.status, JSON.stringify(rec.body)).toBe(201);
  const mov = await amb
    .http()
    .post(`/api/recebimentos/${rec.body.id}/movimentar`)
    .set(bearer())
    .send({ atualizarPrecoCusto: false });
  expect(mov.status, JSON.stringify(mov.body)).toBe(200);
  return rec.body.id as string;
}

async function aguardarTarefa(id: string, tk = tokenAdmin) {
  const fim = Date.now() + 60_000;
  for (;;) {
    const r = await amb.http().get(`/api/tarefas/${id}`).set(bearer(tk));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    if (r.body.status === 'concluida' || r.body.status === 'falhou') return r.body;
    if (Date.now() > fim) throw new Error(`tarefa não terminou: ${JSON.stringify(r.body)}`);
    await esperar(200);
  }
}

/** A primeira aba do `.xlsx`: o cabeçalho e as linhas de dados. */
async function lerXlsx(conteudo: Buffer) {
  const livro = new ExcelJS.Workbook();
  await livro.xlsx.load(conteudo as unknown as ArrayBuffer);
  const linhas: unknown[][] = [];
  livro.worksheets[0]!.eachRow((r) => linhas.push((r.values as unknown[]).slice(1)));
  return { cabecalho: linhas[0] as string[], dados: linhas.slice(1) };
}

const somar = (vs: string[]) => vs.reduce((t, v) => t + Number(v), 0);
const chave = (l: { produtoId: string; variacaoId: string | null; tipoEstoqueId: string }) =>
  `${l.produtoId}:${l.variacaoId ?? ''}:${l.tipoEstoqueId}`;
/** A linha do produto no tipo (padrão: o Disponível) entre as da sintética. */
const linhaDe = (ls: LinhaMovimentacaoSintetica[], produtoId: string, tipoEstoqueId = disponivel) =>
  ls.find((s) => s.produtoId === produtoId && s.tipoEstoqueId === tipoEstoqueId)!;

/**
 * Sem filtro de movimento, cada linha da sintética fecha com a analítica do mesmo período: o saldo inicial é o
 * `saldoAnterior` do primeiro movimento da linha, o final o `saldoPosterior` do último, e as somas batem.
 */
async function conferirComAnalitica(query: Record<string, string>) {
  const sint = await sinteticaInteira(query);
  const anal = await analitica(query);
  const porLinha = new Map<string, LinhaMovimentacaoEstoque[]>();
  for (const l of anal) porLinha.set(chave(l), [...(porLinha.get(chave(l)) ?? []), l]);
  expect(sint).toHaveLength(porLinha.size);
  for (const s of sint) {
    const ms = porLinha.get(chave(s))!;
    expect(ms, s.produtoNome).toBeDefined();
    const entradas = ms.filter((m) => Number(m.quantidade) > 0);
    const saidas = ms.filter((m) => Number(m.quantidade) < 0);
    expect(Number(s.saldoInicial), s.produtoNome).toBe(Number(ms[0]!.saldoAnterior));
    expect(Number(s.saldoFinal), s.produtoNome).toBe(Number(ms.at(-1)!.saldoPosterior));
    expect(Number(s.entradas)).toBeCloseTo(somar(entradas.map((m) => m.quantidade)), 3);
    expect(Number(s.saidas)).toBeCloseTo(-somar(saidas.map((m) => m.quantidade)), 3);
    expect(s.movimentos).toBe(ms.length);
    expect(Number(s.custoEntradas)).toBeCloseTo(somar(entradas.map((m) => m.custoTotal!)), 2);
    expect(Number(s.custoSaidas)).toBeCloseTo(somar(saidas.map((m) => m.custoTotal!)), 2);
    // Sem filtro: final = inicial + entradas − saídas.
    expect(Number(s.saldoFinal)).toBeCloseTo(
      Number(s.saldoInicial) + Number(s.entradas) - Number(s.saidas),
      3,
    );
  }
  return sint;
}

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      FILA_TRABALHADOR: 'true',
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-mov-sintetica-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  await amb.servicos.fila.iniciar();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  const loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  await consultar(emp.nomeBanco, 'update lojas set cnpj = $1 where id = $2', [CNPJ_LOJA_1, loja1]);
  const estoqueDa = async (loja: string) =>
    (
      (await consultar<{ estoque_id: string }>(emp.nomeBanco, 'select estoque_id from lojas where id = $1', [
        loja,
      ])) as [{ estoque_id: string }]
    )[0].estoque_id;
  estoque1 = await estoqueDa(loja1);
  estoque2 = await estoqueDa(loja2);
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  // O estoquista do seed não exporta: o teste dá `relatorios.exportar` ao perfil (o corte do custo no arquivo).
  await consultar(
    emp.nomeBanco,
    `insert into perfis_permissoes (perfil_id, permissao)
     select id, 'relatorios.exportar' from perfis where chave_sistema = 'estoquista'`,
  );
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [estoque1],
  });
  tokenEstoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  const [u] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "select id from unidades_medida where sigla = 'UN'",
  );
  un = u!.id;
  const f = await amb
    .http()
    .post('/api/pessoas/fornecedor-rapido')
    .set(bearer())
    .send({ cpfCnpj: completarCnpj('112223330007'), nome: 'Distribuidora Sintética Ltda' });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  fornecedor = f.body.pessoa.id as string;

  const tipos = await consultar<{ id: string; nome: string; chave_sistema: string }>(
    emp.nomeBanco,
    'select id, nome, chave_sistema from tipos_estoque where chave_sistema is not null',
  );
  const tipo = (chave: string) => tipos.find((t) => t.chave_sistema === chave)!;
  [disponivel, nomeDisponivel] = [tipo('disponivel').id, tipo('disponivel').nome];
  [avaria, nomeAvaria] = [tipo('avaria').id, tipo('avaria').nome];

  cerveja = await criarProduto('CERVEJA SINTETICA LATA 350ML');
  refri = await criarProduto('REFRIGERANTE SINTETICO 2L');
  agua = await criarProduto('AGUA SINTETICA 500ML');
  semCompra = await criarProduto('PETISCO SEM COMPRA');
  // A cerveja na Avaria antes de todo período: o saldo inicial 5 da linha dela (só dela, não da Disponível).
  await acerto({
    tipoAjuste: 'definir',
    tipoEstoqueId: avaria,
    dataContagem: diasAtras(20),
    itens: [{ produtoId: cerveja, quantidade: '5' }],
  });
  await acerto({
    tipoAjuste: 'definir',
    dataContagem: diasAtras(10),
    itens: [
      { produtoId: cerveja, quantidade: '20' },
      { produtoId: semCompra, quantidade: '4' },
    ],
  });
  // O recebimento manual "de 3 dias atrás": a data do movimento vai para trás logo depois de lançado (antes de
  // qualquer outro movimento da linha, então a cadeia e as datas da projeção continuam as do razão).
  // O razão é imutável (gatilho): a correção da data passa com os gatilhos desligados nesta sessão só.
  const recManual = await recebimento(loja1, cerveja, '5', '6');
  const c = await conectar(emp.nomeBanco);
  try {
    await c.query('set session_replication_role = replica');
    await c.query(
      `update movimentos_estoque set data_movimento = $2
        where documento_tipo = 'recebimento' and documento_id = $1`,
      [recManual, diasAtras(3)],
    );
  } finally {
    await c.end();
  }
  await consultar(
    emp.nomeBanco,
    `update saldos_estoque s set ultima_entrada_em = $3, ultima_compra_em = $3
      where s.estoque_id = $1 and s.produto_id = $2 and s.tipo_estoque_id = $4`,
    [estoque1, cerveja, diasAtras(3), disponivel],
  );
  // A compra do produto "sem compra" na Loja 2: não é a última compra dele na Loja 1.
  await recebimento(loja2, semCompra, '2', '9');

  // A NF-e de bebidas (10 CX × 12 de cerveja, 5 FD × 6 de refrigerante, 24 águas) importada e movimentada.
  const imp = await amb
    .http()
    .post('/api/notas-entrada/importar')
    .set(bearer())
    .attach('arquivos', Buffer.from(fixtureNfe('01-icms-st.xml')), '01-icms-st.xml');
  expect(imp.status, JSON.stringify(imp.body)).toBe(200);
  const notaId = imp.body.resultados[0].notaId as string;
  const d = (await amb.http().get(`/api/notas-entrada/${notaId}`).set(bearer())).body as {
    versao: number;
    itens: Array<{ id: string }>;
  };
  const v = await amb
    .http()
    .put(`/api/notas-entrada/${notaId}/itens`)
    .set(bearer())
    .send({
      versao: d.versao,
      itens: [
        { id: d.itens[0]!.id, produtoId: cerveja, fator: '12', fatorConfirmado: true },
        { id: d.itens[1]!.id, produtoId: refri, fator: '6', fatorConfirmado: true },
        { id: d.itens[2]!.id, produtoId: agua, fator: '1', fatorConfirmado: true },
      ],
    });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  const mov = await amb
    .http()
    .post(`/api/notas-entrada/${notaId}/movimentar`)
    .set(bearer())
    .send({ versao: v.body.versao, atualizarPrecoCusto: false });
  expect(mov.status, JSON.stringify(mov.body)).toBe(200);
  const [nfe] = await consultar<{ custo: string; data: string }>(
    emp.nomeBanco,
    `select custo_unitario::text as custo,
            to_char(data_movimento at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as data
       from movimentos_estoque where tipo_movimento = 'RECEB_NFE' and produto_id = $1`,
    [cerveja],
  );
  custoNfeCerveja = nfe!.custo;
  dataNfe = nfe!.data;
  await acerto({ tipoAjuste: 'saida', itens: [{ produtoId: cerveja, quantidade: '3' }] });
  await acerto({
    tipoAjuste: 'saida',
    tipoEstoqueId: avaria,
    itens: [{ produtoId: cerveja, quantidade: '2' }],
  });

  for (let i = 0; i < 25; i++) lote.push(await criarProduto(`SALGADINHO LOTE ${String(i).padStart(2, '0')}`));
  await acerto({
    tipoAjuste: 'entrada',
    itens: lote.map((p, i) => ({ produtoId: p, quantidade: String(i + 1), custoUnitario: '2' })),
  });
  referencia = Date.now();
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
  await s3?.fechar();
});

// ---------------------------------------------------------------- Testes

describe('Movimentação sintética (ERP 16.5): fecha com a analítica e a última compra', () => {
  it('cada linha fecha com a analítica: saldos, entradas, saídas, movimentos e custos; o final é o saldo de hoje', async () => {
    const sint = await conferirComAnalitica(periodo());
    // A cerveja em duas linhas (Disponível e Avaria), mais 3 produtos e o lote.
    expect(sint).toHaveLength(5 + 25);
    // O período vai até hoje: o final é a projeção (`saldos_estoque`).
    const projecao = await consultar<{ produto_id: string; tipo_estoque_id: string; quantidade: string }>(
      emp.nomeBanco,
      'select produto_id, tipo_estoque_id, quantidade::text from saldos_estoque where estoque_id = $1',
      [estoque1],
    );
    for (const s of sint)
      expect(s.saldoFinal).toBe(
        projecao.find((p) => p.produto_id === s.produtoId && p.tipo_estoque_id === s.tipoEstoqueId)!
          .quantidade,
      );
    expect(linhaDe(sint, cerveja)).toMatchObject({
      saldoInicial: '0.000',
      entradas: '145.000',
      saidas: '3.000',
      saldoFinal: '142.000',
      movimentos: 4,
      unidadeBase: 'UN',
    });
    // A Avaria da cerveja: o saldo inicial é só o dela (o da Disponível é 0), e a última compra (em qualquer tipo de
    // estoque) é a mesma nota.
    expect(linhaDe(sint, cerveja, avaria)).toMatchObject({
      saldoInicial: '5.000',
      entradas: '0.000',
      saidas: '2.000',
      saldoFinal: '3.000',
      movimentos: 1,
      ultimaCompraEm: dataNfe,
      ultimoCusto: custoNfeCerveja,
    });
  });

  it('com saldo inicial nos dois tipos de estoque, cada linha fecha com a analítica separada', async () => {
    // Do 5º dia para cá: a contagem da Disponível (há 10 dias) e a da Avaria (há 20) ficam antes do período.
    const sint = await conferirComAnalitica(periodo(5));
    const disp = linhaDe(sint, cerveja);
    const av = linhaDe(sint, cerveja, avaria);
    expect(disp).toMatchObject({
      saldoInicial: '20.000',
      entradas: '125.000',
      saidas: '3.000',
      saldoFinal: '142.000',
      movimentos: 3,
      ultimaCompraEm: dataNfe,
    });
    expect(av).toMatchObject({
      saldoInicial: '5.000',
      saldoFinal: '3.000',
      movimentos: 1,
      ultimaCompraEm: dataNfe,
    });
    expect(disp.chave).not.toBe(av.chave);
  });

  it('a última compra vem do RECEB_NFE da nota; antes dela, do recebimento manual; sem compra no local, vazia', async () => {
    const hoje = await sinteticaInteira(periodo());
    const de = (id: string, ls = hoje) => linhaDe(ls, id);
    expect(de(cerveja)).toMatchObject({ ultimaCompraEm: dataNfe, ultimoCusto: custoNfeCerveja });
    expect(de(refri).ultimaCompraEm).not.toBeNull();
    expect(de(agua)).toMatchObject({ ultimoCusto: '1.3750' });
    // Comprado só na Loja 2: na Loja 1 não tem última compra.
    expect(de(semCompra)).toMatchObject({ ultimaCompraEm: null, ultimoCusto: null });
    // O acerto de entrada não é compra.
    expect(de(lote[0]!)).toMatchObject({ ultimaCompraEm: null });

    // O período que termina ontem: a nota de hoje fica de fora, a última compra é o recebimento manual.
    const ontem = await sinteticaInteira({ ...periodo(), dataFinal: diaLocal(1) });
    expect(ontem.map((s) => s.produtoId).sort()).toEqual([cerveja, semCompra].sort());
    expect(de(cerveja, ontem)).toMatchObject({
      saldoInicial: '0.000',
      entradas: '25.000',
      saldoFinal: '25.000',
      ultimoCusto: '6.0000',
    });
    expect(Date.parse(de(cerveja, ontem).ultimaCompraEm!)).toBeLessThan(Date.parse(dataNfe));

    // Só hoje: o saldo inicial é o de antes (a contagem e o manual), e a última compra continua a nota.
    const soHoje = await sinteticaInteira({ ...periodo(), dataInicial: diaLocal() });
    expect(de(cerveja, soHoje)).toMatchObject({
      saldoInicial: '25.000',
      entradas: '120.000',
      saidas: '3.000',
      saldoFinal: '142.000',
      movimentos: 2,
      ultimaCompraEm: dataNfe,
    });
  });

  it('com filtro, as entradas e as saídas são só as filtradas e os saldos continuam os da linha', async () => {
    const compras = await sinteticaInteira({ ...periodo(), tiposMovimento: 'RECEB_MANUAL,RECEB_NFE' });
    expect(compras.map((s) => s.produtoId).sort()).toEqual([cerveja, refri, agua].sort());
    const c = linhaDe(compras, cerveja);
    expect(c).toMatchObject({
      saldoInicial: '0.000',
      entradas: '125.000',
      saidas: '0.000',
      saldoFinal: '142.000',
      movimentos: 2,
    });
    // A analítica com o mesmo filtro: as mesmas somas (os saldos não: o "Est. anterior" do primeiro recebimento
    // filtrado já inclui a contagem, e o saldo inicial da sintética é o do começo do período).
    const anal = (await analitica({ ...periodo(), tiposMovimento: 'RECEB_MANUAL,RECEB_NFE' })).filter(
      (l) => l.produtoId === cerveja,
    );
    expect(somar(anal.map((l) => l.quantidade))).toBe(125);
    expect(anal).toHaveLength(c.movimentos);
    expect(Number(c.custoEntradas)).toBeCloseTo(somar(anal.map((l) => l.custoTotal!)), 2);
    expect(anal[0]!.saldoAnterior).toBe('20.000');
    // Produto e pessoa (o fornecedor da nota não é o do recebimento manual).
    const soCerveja = await sinteticaInteira({ ...periodo(), produtoId: cerveja });
    expect(soCerveja.map((s) => s.tipoEstoqueId).sort()).toEqual([disponivel, avaria].sort());
    const doFornecedor = await sinteticaInteira({ ...periodo(), pessoaId: fornecedor });
    expect(doFornecedor.map((s) => [s.produtoId, s.entradas])).toEqual([[cerveja, '5.000']]);
  });

  it('página com o total e os totais de custo; a página além do fim; o custo só com "Ver custo"', async () => {
    const p1 = await sintetica({ ...periodo(), tamanho: '20' });
    const p2 = await sintetica({ ...periodo(), tamanho: '20', pagina: '2' });
    expect(p1).toMatchObject({ total: 30, pagina: 1, tamanho: 20 });
    expect(p1.itens).toHaveLength(20);
    expect(p2.itens).toHaveLength(10);
    // Ordem pelo nome do produto, sem repetir a linha (a cerveja tem duas: Disponível e Avaria).
    const nomes = [...p1.itens, ...p2.itens].map((s) => s.produtoNome);
    expect(new Set([...p1.itens, ...p2.itens].map((s) => s.chave)).size).toBe(30);
    expect(new Set(nomes).size).toBe(29);
    expect(nomes).toEqual([...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR')));
    const todas = [...p1.itens, ...p2.itens];
    expect(Number(p1.totais!.custoEntradas)).toBeCloseTo(somar(todas.map((s) => s.custoEntradas!)), 2);
    expect(p2.totais).toEqual(p1.totais);
    const alem = await sintetica({ ...periodo(), tamanho: '20', pagina: '5' });
    expect(alem).toMatchObject({ itens: [], total: 30, totais: p1.totais });
    expect(p1.referencias.estoque).toEqual({ id: estoque1, nome: expect.any(String) });

    const e = await sintetica({ ...periodo(), produtoId: cerveja }, tokenEstoquista);
    expect(e.totais).toBeNull();
    expect(linhaDe(e.itens, cerveja)).toMatchObject({
      custoEntradas: null,
      custoSaidas: null,
      ultimoCusto: null,
      ultimaCompraEm: dataNfe,
      saldoFinal: '142.000',
    });
    const fora = await amb
      .http()
      .get('/api/relatorios/movimentacao-estoque/sintetica')
      .query({ ...periodo(), estoqueId: estoque2 })
      .set(bearer(tokenEstoquista));
    expect(fora.status).toBe(403);
    const longo = await amb
      .http()
      .get('/api/relatorios/movimentacao-estoque/sintetica')
      .query({ ...periodo(), dataInicial: diaLocal(366) })
      .set(bearer());
    expect(longo.status).toBe(422);
    expect(longo.body.campos.dataFinal).toBeDefined();
  });
});

describe('Movimentação: exportação das duas visões (ERP 3.5, 3.6)', () => {
  const exportar = (query: Record<string, string>, tk = tokenAdmin) =>
    amb
      .http()
      .get('/api/relatorios/movimentacao-estoque/exportar')
      .query(query)
      .set(bearer(tk))
      .buffer(true)
      .parse((res, cb) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => cb(null, Buffer.concat(partes)));
      });

  it('na hora: a analítica com as colunas do Nuvem3 e a sintética, com o nome do arquivo e sem o custo', async () => {
    const a = await exportar({ ...periodo(), formato: 'xlsx' });
    expect(a.status).toBe(200);
    expect(a.headers['content-disposition']).toMatch(
      /Relatorio_Movimentacao_Estoque_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.xlsx/,
    );
    const xa = await lerXlsx(a.body as Buffer);
    const anal = await analitica(periodo());
    expect(xa.dados).toHaveLength(anal.length);
    expect(xa.cabecalho).toEqual(
      expect.arrayContaining([
        'Data/hora',
        'Ref. Interna',
        'Produto',
        'Est. anterior',
        'Qtd. movimentada',
        'Est. atual',
        'Custo unit.',
        'Custo total',
        'Documento',
        'Fornecedor',
        'idmovimentacaoestoque',
      ]),
    );
    // A ordem da analítica: o id do movimento de cada linha.
    const colId = xa.cabecalho.indexOf('idmovimentacaoestoque');
    expect(xa.dados.map((l) => l[colId])).toEqual(anal.map((l) => l.id));

    const s = await exportar({ ...periodo(), visao: 'sintetica', formato: 'xlsx' });
    expect(s.status).toBe(200);
    const xs = await lerXlsx(s.body as Buffer);
    expect(xs.cabecalho).toEqual([
      'Ref. Interna',
      'Código',
      'Produto',
      'Variação',
      'Tipo de estoque',
      'Unidade',
      'Saldo inicial',
      'Entradas',
      'Saídas',
      'Saldo final',
      'Movimentos',
      'Custo das entradas',
      'Custo das saídas',
      'Data da última compra',
      'Último custo',
    ]);
    expect(xs.dados).toHaveLength(30);
    // As duas linhas da cerveja (Disponível e Avaria), cada uma com o tipo e os saldos dela.
    const linhasCerveja = xs.dados.filter((l) => l[2] === 'CERVEJA SINTETICA LATA 350ML');
    expect(linhasCerveja.map((l) => [l[4], ...l.slice(6, 11)])).toEqual(
      expect.arrayContaining([
        [nomeDisponivel, 0, 145, 3, 142, 4],
        [nomeAvaria, 5, 0, 2, 3, 1],
      ]),
    );
    expect(linhasCerveja).toHaveLength(2);
    for (const l of linhasCerveja) expect(l[14]).toBe(Number(custoNfeCerveja));

    // Sem "Ver custo", as colunas de custo saem do arquivo (a data da última compra fica).
    const e = await exportar({ ...periodo(), visao: 'sintetica', formato: 'xlsx' }, tokenEstoquista);
    expect(e.status).toBe(200);
    const xe = await lerXlsx(e.body as Buffer);
    expect(xe.cabecalho).not.toContain('Custo das entradas');
    expect(xe.cabecalho).not.toContain('Último custo');
    expect(xe.cabecalho).toContain('Data da última compra');
    const ea = await lerXlsx(
      (await exportar({ ...periodo(), formato: 'xlsx' }, tokenEstoquista)).body as Buffer,
    );
    expect(ea.cabecalho).not.toContain('Custo unit.');
    // O local fora dos permitidos e a visão inválida.
    expect((await exportar({ ...periodo(), estoqueId: estoque2 }, tokenEstoquista)).status).toBe(403);
    const invalida = await amb
      .http()
      .get('/api/relatorios/movimentacao-estoque/exportar')
      .query({ ...periodo(), visao: 'diaria' })
      .set(bearer());
    expect(invalida.status).toBe(422);
    expect(invalida.body.campos.visao).toBeDefined();
  });

  it('critério de pronto: os 12 meses (366 dias) de uma loja exportam em tarefa, nas duas visões', async () => {
    const opcoes = amb.servicos.exportacoes.opcoes;
    const antes = opcoes.limiteNaHora;
    // O limite da exportação na hora pequeno: os 12 meses desta loja de teste passam dele e viram tarefa.
    opcoes.limiteNaHora = 10;
    try {
      const doze = { ...periodo(365), formato: 'xlsx' };
      const anal = await analitica(periodo(365));
      for (const [visao, linhas] of [
        ['analitica', anal.length],
        ['sintetica', 30],
      ] as const) {
        const r = await amb
          .http()
          .get('/api/relatorios/movimentacao-estoque/exportar')
          .query({ ...doze, visao })
          .set(bearer());
        expect(r.status, JSON.stringify(r.body)).toBe(202);
        expect(r.body.linhas).toBe(linhas);
        const t = await aguardarTarefa(r.body.tarefaId as string);
        expect(t.status, JSON.stringify(t)).toBe('concluida');
        expect(t.resultado).toMatchObject({ relatorio: 'movimentacao-estoque', formato: 'xlsx', linhas });
        expect(t.resultado.nomeArquivo).toMatch(
          /^Relatorio_Movimentacao_Estoque_\d{2}_\d{2}_\d{4}_\d{2}_\d{2}\.xlsx$/,
        );
        const arquivo = Buffer.from(await (await fetch(t.download as string)).arrayBuffer());
        const x = await lerXlsx(arquivo);
        expect(x.dados).toHaveLength(linhas);
        const [aud] = await consultar<{ localizacao: string; depois: { tarefaId: string; filtros: object } }>(
          emp.nomeBanco,
          `select localizacao, depois from auditoria
            where acao = 'exportar' and depois->>'tarefaId' = $1`,
          [r.body.tarefaId],
        );
        expect(aud).toMatchObject({
          localizacao: 'Relatórios › Movimentação de Estoque',
          depois: { filtros: expect.objectContaining({ visao }) },
        });
      }
    } finally {
      opcoes.limiteNaHora = antes;
    }
  });

  it('o razão refaz as projeções idênticas', async () => {
    await conferirRazaoDoBanco(emp.nomeBanco);
  });
});
