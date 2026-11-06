/**
 * Importar contagem e folha de contagem (Fase 2, F2-B9; ERP 13.5; README da API › decisão 154), pela API do ERP: um
 * arquivo de coletor com 300 linhas (com fardos de 12 e caixas de 24) vira um rascunho de "Definir" em unidades, a
 * prévia não grava e a efetivação deixa o saldo contado; o EAN ambíguo (duplicado entre produtos), o não encontrado,
 * o combo, o produto "Com variações" e a linha inválida não gravam e voltam na prévia com as linhas; o acerto fora de
 * rascunho devolve 409, o que não é "Definir" 422 e a versão velha 409; a segunda importação soma (ou substitui) o
 * que já estava no rascunho; "Zerar os não contados" grava 0 para quem tem saldo e não está no arquivo; 6.000 itens
 * geram 2 rascunhos com a mesma hora da contagem (e o "Zerar" não zera o que está no outro rascunho da divisão; o
 * produto que já está no outro rascunho é somado ou trocado lá, sem abrir um terceiro); o "Zerar" não zera o produto
 * do arquivo com código ambíguo nem o da linha inválida; o arquivo só com problemas num rascunho com itens é 422 sem
 * mexer na versão; a folha cega sai sem o saldo, a com saldo traz o saldo, por localização ou nome, filtrada por marca
 * e por categoria (com as subcategorias); os lotes da grade do acerto vêm com o saldo do lote. O razão refaz as
 * projeções idênticas no fim (`conferirRazaoDoBanco`).
 */
import { calcularDvGtin } from '@genesis/shared';
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
import { conferirRazaoDoBanco } from './razao.js';

// Muitas importações seguidas do mesmo usuário (o limite real é 20/min, CONTAGEM_IMPORTACOES_POR_MINUTO).
process.env.CONTAGEM_IMPORTACOES_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let vendedor: string;
let un: string;
let estoqueLoja: string;
let cerveja: string;
let refri: string;
let energetico: string;
let combo: string;
let comVariacoes: string;
let duplicadoA: string;
let duplicadoB: string;
let marcaHeineken: string;

const bearer = (t = admin) => ({ Authorization: `Bearer ${t}` });
const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const ean = (base: string) => `${base}${calcularDvGtin(base)}`;

const EAN_CERVEJA = ean('789114910310');
const FARDO_12 = ean('1789114910310');
const CAIXA_24 = ean('2789114910310');
const EAN_DUPLICADO = ean('789000000777');
const EAN_COMBO = ean('789000000888');
const EAN_SUCO = ean('789000000999');

async function produto(corpo: Record<string, unknown>): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ unidadeId: un, precoVenda: '10', precoCusto: '2', ...corpo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Ice Beer');
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja] });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  const [l] = await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [loja],
  );
  estoqueLoja = l!.estoque_id;
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer());
  un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;
  const [m] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into marcas (descricao) values ('HEINEKEN') returning id",
  );
  marcaHeineken = m!.id;
  cerveja = await produto({
    nome: 'CERV HEINEKEN LT 350ML',
    marcaId: marcaHeineken,
    localizacao: 'B-02',
    codigosBarras: [
      { codigo: EAN_CERVEJA, principal: true },
      { codigo: FARDO_12, fator: '12', descricao: 'Fardo 12' },
      { codigo: CAIXA_24, fator: '24', descricao: 'Caixa 24' },
    ],
  });
  refri = await produto({ nome: 'REFRI COCA 2L', codigoInterno: 'REF2L', localizacao: 'A-01' });
  energetico = await produto({ nome: 'ENERGETICO RED BULL 250ML' });
  combo = await produto({
    nome: 'COMBO BALDE',
    tipo: 'kit',
    codigosBarras: [{ codigo: EAN_COMBO, principal: true }],
    componentes: [{ tipo: 'kit', componenteId: cerveja, quantidade: '6', ordem: 0 }],
  });
  // Legado "Com variações" (o tipo está travado na criação desde o F2-B1): contado no pai, é recusado.
  comVariacoes = await produto({ nome: 'CAMISETA ICE BEER', codigoInterno: 'CAMISA' });
  await consultar(emp.nomeBanco, "update produtos set tipo = 'com_variacoes' where id = $1", [comVariacoes]);
  // O EAN duplicado entre produtos, aceito com `geral.ean_duplicado = 'avisar'` (a migração do Nuvem3 os traz).
  duplicadoA = await produto({ nome: 'AGUA CRYSTAL 500ML' });
  duplicadoB = await produto({ nome: 'AGUA CRYSTAL 500ML C/GAS' });
  await consultar(
    emp.nomeBanco,
    `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.ean_duplicado', '"avisar"'::jsonb)`,
  );
  await consultar(
    emp.nomeBanco,
    `insert into produtos_codigos_barras (produto_id, codigo) values ($1, $3), ($2, $3)`,
    [duplicadoA, duplicadoB, EAN_DUPLICADO],
  );
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

async function criarAcerto(corpo: Record<string, unknown> = {}) {
  const r = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId: estoqueLoja,
      tipoAjuste: 'definir',
      dataContagem: horasAtras(1),
      motivo: 'Inventário',
      ...corpo,
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; versao: number; codigo: number };
}

async function detalhe(id: string) {
  const r = await amb.http().get(`/api/acertos/${id}`).set(bearer());
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as {
    versao: number;
    status: string;
    dataContagem: string;
    qtdItens: number;
    itens: Array<{ produtoId: string; quantidade: string }>;
  };
}

function importar(
  id: string,
  texto: string,
  campos: Record<string, string> = {},
  token = admin,
  nome = 'coletor.txt',
) {
  let req = amb.http().post(`/api/acertos/${id}/importar-contagem`).set(bearer(token));
  for (const [k, v] of Object.entries(campos)) req = req.field(k, v);
  return req.attach('arquivo', Buffer.from(texto, 'utf8'), nome);
}

async function gravar(id: string, texto: string, campos: Record<string, string> = {}) {
  const { versao } = await detalhe(id);
  const r = await importar(id, texto, { modo: 'gravar', versao: String(versao), ...campos });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

async function efetivar(id: string) {
  const { versao } = await detalhe(id);
  const r = await amb.http().post(`/api/acertos/${id}/efetivar`).set(bearer()).send({ versao });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function saldo(produtoId: string) {
  const [s] = await consultar<{ q: string }>(
    emp.nomeBanco,
    `select quantidade::text as q from saldos_estoque s join tipos_estoque t on t.id = s.tipo_estoque_id
      where s.estoque_id = $1 and s.produto_id = $2 and t.padrao`,
    [estoqueLoja, produtoId],
  );
  return s ? Number(s.q) : 0;
}

const quantidadeDe = (d: { itens: Array<{ produtoId: string; quantidade: string }> }, p: string) =>
  d.itens.find((i) => i.produtoId === p)?.quantidade;

describe('importar contagem (ERP 13.5)', () => {
  it('coletor com 300 linhas (com fardos) vira um rascunho de Definir em unidades; a prévia não grava', async () => {
    const linhas = ['EAN;Quantidade'];
    for (let i = 0; i < 100; i++) linhas.push(`${EAN_CERVEJA};1`);
    for (let i = 0; i < 100; i++) linhas.push(`${FARDO_12};1`); // 100 fardos de 12 = 1.200
    for (let i = 0; i < 90; i++) linhas.push('ref2l;2'); // código interno sem diferença de maiúsculas
    for (let i = 0; i < 10; i++) linhas.push(`${CAIXA_24};0,5`); // meia caixa de 24 = 12, dez vezes
    const arquivo = `\uFEFF${linhas.join('\r\n')}\r\n`;
    const a = await criarAcerto();
    const p = await importar(a.id, arquivo);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({
      gravado: false,
      separador: ';',
      linhas: 300,
      leituras: 300,
      rascunhos: 1,
      problemas: [],
      totais: { produtos: 2, novos: 2, alterados: 0, zerados: 0, leiturasRecusadas: 0, unidades: '1600.000' },
    });
    const itemCerveja = p.body.itens.find((i: { produto: { id: string } }) => i.produto.id === cerveja);
    expect(itemCerveja).toMatchObject({
      quantidadeArquivo: '1420.000',
      quantidadeFinal: '1420.000',
      leituras: 210,
    });
    expect(itemCerveja.codigos).toEqual([
      { codigo: EAN_CERVEJA, fator: '1.000', leituras: 100, quantidadeLida: '100.000' },
      { codigo: FARDO_12, fator: '12.000', leituras: 100, quantidadeLida: '100.000' },
      { codigo: CAIXA_24, fator: '24.000', leituras: 10, quantidadeLida: '5.000' },
    ]);
    expect((await detalhe(a.id)).qtdItens).toBe(0);

    const g = await gravar(a.id, arquivo);
    expect(g.gravado).toBe(true);
    expect(g.acertos).toEqual([{ id: a.id, codigo: a.codigo, qtdItens: 2 }]);
    const d = await detalhe(a.id);
    expect(d.status).toBe('rascunho');
    expect(quantidadeDe(d, cerveja)).toBe('1420.000');
    expect(quantidadeDe(d, refri)).toBe('180.000');
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      "select descricao from auditoria where entidade = 'acertos_estoque' and registro_id = $1 and acao = 'importar'",
      [a.id],
    );
    expect(aud!.descricao).toMatch(/coletor\.txt.*2 produto/);

    await efetivar(a.id);
    expect(await saldo(cerveja)).toBe(1420);
    expect(await saldo(refri)).toBe(180);
  });

  it('EAN ambíguo, não encontrado, combo, "Com variações" e linha inválida não gravam e voltam na prévia', async () => {
    const a = await criarAcerto();
    const arquivo = [
      `${EAN_DUPLICADO};3`,
      `${EAN_CERVEJA};2`,
      '7899999999999;1',
      `${EAN_COMBO};4`,
      'CAMISA;1',
      `${EAN_DUPLICADO};1`,
      `${EAN_CERVEJA};abc`,
    ].join('\n');
    const g = await gravar(a.id, arquivo);
    expect(g.totais).toMatchObject({ produtos: 1, leiturasRecusadas: 6 });
    expect(
      g.problemas.map((p: { tipo: string; codigo: string | null; linhas: number[] }) => [
        p.tipo,
        p.codigo,
        p.linhas,
      ]),
    ).toEqual([
      ['ambiguo', EAN_DUPLICADO, [1, 6]],
      ['nao_encontrado', '7899999999999', [3]],
      ['sem_estoque', EAN_COMBO, [4]],
      ['com_variacoes', 'CAMISA', [5]],
      ['linha_invalida', EAN_CERVEJA, [7]],
    ]);
    const amb1 = g.problemas[0];
    expect(amb1.quantidadeLida).toBe('4.000');
    expect(amb1.produtos.map((x: { id: string }) => x.id).sort()).toEqual([duplicadoA, duplicadoB].sort());
    const d = await detalhe(a.id);
    expect(d.itens.map((i) => i.produtoId)).toEqual([cerveja]);
    expect(d.itens.some((i) => [duplicadoA, duplicadoB, combo, comVariacoes].includes(i.produtoId))).toBe(
      false,
    );
    // Só problemas: nada a gravar.
    const b = await criarAcerto();
    const { versao } = await detalhe(b.id);
    const r = await importar(b.id, `${EAN_DUPLICADO};1\n`, { modo: 'gravar', versao: String(versao) });
    expect(r.status).toBe(422);
    expect((await detalhe(b.id)).qtdItens).toBe(0);
  });

  it('fora de rascunho: 409; Entrada: 422; versão velha: 409; sem permissão: 403; sem arquivo ou formato errado: 422', async () => {
    const efetivado = await criarAcerto();
    await gravar(efetivado.id, `${EAN_CERVEJA};1\n`);
    await efetivar(efetivado.id);
    const r = await importar(efetivado.id, `${EAN_CERVEJA};1\n`);
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('CONFLITO');
    const entrada = await criarAcerto({ tipoAjuste: 'entrada' });
    const e = await importar(entrada.id, `${EAN_CERVEJA};1\n`);
    expect(e.status).toBe(422);
    expect(e.body.campos).toHaveProperty('tipoAjuste');
    const a = await criarAcerto();
    const v = await importar(a.id, `${EAN_CERVEJA};1\n`, { modo: 'gravar', versao: String(a.versao - 1) });
    expect(v.status).toBe(409);
    expect(v.body.codigo).toBe('CONFLITO_VERSAO');
    const semVersao = await importar(a.id, `${EAN_CERVEJA};1\n`, { modo: 'gravar' });
    expect(semVersao.status).toBe(422);
    expect((await importar(a.id, `${EAN_CERVEJA};1\n`, {}, vendedor)).status).toBe(403);
    const pdf = await importar(a.id, 'x', {}, admin, 'contagem.pdf');
    expect(pdf.status).toBe(422);
    expect((await importar(a.id, '\n\n')).body.campos).toHaveProperty('arquivo');
    const sem = await amb
      .http()
      .post(`/api/acertos/${a.id}/importar-contagem`)
      .set(bearer())
      .field('modo', 'previa');
    expect(sem.status).toBe(422);
    expect((await detalhe(a.id)).qtdItens).toBe(0);
  });

  it('a segunda importação soma no rascunho; "substituir" grava a do arquivo', async () => {
    const a = await criarAcerto();
    await gravar(a.id, `${EAN_CERVEJA};5\nREF2L;1\n`);
    const g = await gravar(a.id, `${FARDO_12};1\n`);
    expect(g.totais).toMatchObject({ novos: 0, alterados: 1 });
    expect(g.itens[0]).toMatchObject({
      quantidadeAnterior: '5.000',
      quantidadeArquivo: '12.000',
      quantidadeFinal: '17.000',
    });
    expect(quantidadeDe(await detalhe(a.id), cerveja)).toBe('17.000');
    await gravar(a.id, `${EAN_CERVEJA};3\n`, { itensExistentes: 'substituir' });
    const d = await detalhe(a.id);
    expect(quantidadeDe(d, cerveja)).toBe('3.000');
    expect(quantidadeDe(d, refri)).toBe('1.000');
  });

  it('"Zerar os não contados" grava 0 para o produto com saldo que não está no arquivo', async () => {
    const entrada = await criarAcerto({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: energetico, quantidade: '7' }],
    });
    await efetivar(entrada.id);
    expect(await saldo(energetico)).toBe(7);
    // A contagem de agora: a Entrada efetivada antes dela entra no saldo que a contagem viu (13.1.5).
    const a = await criarAcerto({ dataContagem: new Date().toISOString() });
    const sem = await importar(a.id, `${EAN_CERVEJA};1420\n`);
    expect(sem.body.totais.zerados).toBe(0);
    const g = await gravar(a.id, `${EAN_CERVEJA};1420\n`, { zerarNaoContados: 'true' });
    // Refri (180) e energético (7) têm saldo e não estão no arquivo; o combo e os sem saldo ficam de fora.
    const zerados = g.itens
      .filter((i: { zerado: boolean }) => i.zerado)
      .map((i: { produto: { id: string } }) => i.produto.id);
    expect(zerados.sort()).toEqual([energetico, refri].sort());
    expect(g.totais.zerados).toBe(2);
    const d = await detalhe(a.id);
    expect(quantidadeDe(d, energetico)).toBe('0.000');
    await efetivar(a.id);
    expect(await saldo(energetico)).toBe(0);
    expect(await saldo(refri)).toBe(0);
    expect(await saldo(cerveja)).toBe(1420);
  });

  it('"Zerar" não zera o produto do arquivo com código ambíguo nem o da linha inválida; só problemas num rascunho com itens: 422', async () => {
    const entrada = await criarAcerto({
      tipoAjuste: 'entrada',
      dataContagem: new Date().toISOString(),
      itens: [
        { produtoId: duplicadoA, quantidade: '30' },
        { produtoId: duplicadoB, quantidade: '12' },
        { produtoId: refri, quantidade: '9' },
        { produtoId: energetico, quantidade: '5' },
      ],
    });
    await efetivar(entrada.id);
    const a = await criarAcerto({ dataContagem: new Date().toISOString() });
    // O EAN 789… está em A e em B (a leitura de 24 é de um dos dois) e a linha do refri tem a quantidade ruim: os três
    // foram contados e não podem ir a 0; o energético não está no arquivo e é zerado.
    const g = await gravar(a.id, `${EAN_DUPLICADO};24\nREF2L;abc\n${EAN_CERVEJA};1420\n`, {
      zerarNaoContados: 'true',
    });
    const zerados = g.itens
      .filter((i: { zerado: boolean }) => i.zerado)
      .map((i: { produto: { id: string } }) => i.produto.id);
    expect(zerados).toContain(energetico);
    for (const contado of [duplicadoA, duplicadoB, refri]) expect(zerados).not.toContain(contado);
    expect(g.avisos.join(' ')).toMatch(/3 produto\(s\) do arquivo com leitura recusada/);
    expect(g.problemas.map((p: { tipo: string; codigo: string | null }) => [p.tipo, p.codigo])).toEqual([
      ['ambiguo', EAN_DUPLICADO],
      ['linha_invalida', 'REF2L'],
    ]);
    const d = await detalhe(a.id);
    expect(d.itens.some((i) => [duplicadoA, duplicadoB, refri].includes(i.produtoId))).toBe(false);
    // O arquivo só com problemas no rascunho que já tem itens: 422, sem regravar nem mudar a versão.
    const r = await importar(a.id, `${EAN_DUPLICADO};1\n7899999999999;2\n`, {
      modo: 'gravar',
      versao: String(d.versao),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.codigo).toBe('REGRA_NEGOCIO');
    expect((await detalhe(a.id)).versao).toBe(d.versao);
    const [aud] = await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where registro_id = $1 and acao = 'importar'",
      [a.id],
    );
    expect(aud!.n).toBe(1);
  });

  it('quantidade acima do máximo (o EAN bipado no campo da quantidade) volta na prévia e não estoura a gravação', async () => {
    const a = await criarAcerto();
    const p = await importar(a.id, `${EAN_CERVEJA};${EAN_CERVEJA}\n${FARDO_12};100000000000\nREF2L;1\n`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.problemas.map((x: { tipo: string; linhas: number[] }) => [x.tipo, x.linhas])).toEqual([
      ['linha_invalida', [1]],
      ['acima_do_maximo', [2]],
    ]);
    expect(p.body.itens.map((i: { produto: { id: string } }) => i.produto.id)).toEqual([refri]);
    const g = await gravar(a.id, `${EAN_CERVEJA};${EAN_CERVEJA}\nREF2L;1\n`);
    expect(g.totais.produtos).toBe(1);
    // A soma com o já gravado acima do máximo também vira problema (somar), sem 500.
    const s = await importar(a.id, 'REF2L;999999999999\n');
    expect(s.body.problemas.map((x: { tipo: string }) => x.tipo)).toEqual(['acima_do_maximo']);
  });

  it('6.000 itens geram 2 rascunhos com a mesma hora da contagem; o "Zerar" respeita o outro rascunho', async () => {
    const [seq] = await consultar<{ n: string }>(
      emp.nomeBanco,
      'select last_value::text as n from seq_codigo_produtos',
    );
    const inicio = Number(seq!.n) + 1;
    await consultar(
      emp.nomeBanco,
      `insert into produtos (nome, unidade_id, codigo, codigo_interno)
       select 'CONTAGEM ' || g, $2, g, 'CT-' || g from generate_series($1::int, $1::int + 5999) g`,
      [inicio, un],
    );
    const arquivo = Array.from({ length: 6000 }, (_, i) => `CT-${inicio + i};${(i % 7) + 1}`).join('\n');
    const a = await criarAcerto();
    const p = await importar(a.id, arquivo);
    expect(p.status, JSON.stringify(p.body).slice(0, 500)).toBe(200);
    expect(p.body.rascunhos).toBe(2);
    expect(p.body.avisos.join(' ')).toMatch(/2 rascunhos/);
    const g = await gravar(a.id, arquivo);
    expect(g.acertos.map((x: { qtdItens: number }) => x.qtdItens)).toEqual([5000, 1000]);
    const outro = g.acertos[1].id as string;
    const [d1, d2] = [await detalhe(a.id), await detalhe(outro)];
    expect(d1.qtdItens).toBe(5000);
    expect(d2.qtdItens).toBe(1000);
    expect(d2.status).toBe('rascunho');
    expect(d2.dataContagem).toBe(d1.dataContagem);
    const [c] = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(distinct i.produto_id)::int as n from itens_acerto_estoque i
        where i.acerto_id = any($1::uuid[]) and i.excluido_em is null`,
      [[a.id, outro]],
    );
    expect(c!.n).toBe(6000);
    // Um arquivo do outro setor com "Zerar" no 2º rascunho: o produto com saldo que está no 1º rascunho da mesma
    // contagem não é zerado (o primeiro da faixa ficou no 1º).
    const [primeiro] = await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from produtos where codigo_interno = $1',
      [`CT-${inicio}`],
    );
    const entrada = await criarAcerto({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: primeiro!.id, quantidade: '4' }],
    });
    await efetivar(entrada.id);
    const z = await importar(outro, `${EAN_CERVEJA};1\n`, { zerarNaoContados: 'true' });
    expect(z.status, JSON.stringify(z.body).slice(0, 500)).toBe(200);
    expect(z.body.itens.some((i: { produto: { id: string } }) => i.produto.id === primeiro!.id)).toBe(false);
    expect(d1.itens.some((i) => i.produtoId === primeiro!.id)).toBe(true);

    // O segundo coletor importado no 1º rascunho (cheio) traz um produto que está no 2º: a soma vai para o 2º, sem
    // abrir um 3º nem deixar o produto em dois "Definir" da mesma hora (o último efetivado venceria).
    const [ultimo] = await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from produtos where codigo_interno = $1',
      [`CT-${inicio + 5999}`],
    );
    const arquivoSetor2 = `CT-${inicio + 5999};15\n`;
    const s = await importar(a.id, arquivoSetor2);
    expect(s.status, JSON.stringify(s.body).slice(0, 500)).toBe(200);
    expect(s.body.rascunhos).toBe(1);
    expect(s.body.itens).toHaveLength(1);
    expect(s.body.itens[0]).toMatchObject({
      quantidadeAnterior: '1.000',
      quantidadeFinal: '16.000',
      rascunho: 0,
      outroAcerto: g.acertos[1].codigo,
    });
    expect(s.body.outrosAcertos).toEqual([{ id: outro, codigo: g.acertos[1].codigo, qtdItens: 1000 }]);
    const gs = await gravar(a.id, arquivoSetor2);
    expect(gs.acertos).toEqual([{ id: a.id, codigo: a.codigo, qtdItens: 5000 }]);
    expect(gs.outrosAcertos.map((x: { id: string }) => x.id)).toEqual([outro]);
    const d2b = await detalhe(outro);
    expect(d2b.qtdItens).toBe(1000);
    expect(d2b.versao).toBeGreaterThan(d2.versao);
    expect(quantidadeDe(d2b, ultimo!.id)).toBe('16.000');
    expect((await detalhe(a.id)).qtdItens).toBe(5000);
    // "Substituir" importado no 2º rascunho de um produto do 1º troca a quantidade lá.
    const t = await gravar(outro, `CT-${inicio};9\n`, { itensExistentes: 'substituir' });
    expect(t.outrosAcertos.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(quantidadeDe(await detalhe(a.id), primeiro!.id)).toBe('9.000');
    expect((await detalhe(outro)).qtdItens).toBe(1000);
  }, 180_000);
});

describe('folha de contagem (ERP 13.5 "Imprimir")', () => {
  it('cega sem o saldo, com saldo, por localização ou por nome, filtrada por marca e por categoria', async () => {
    // O saldo, a marca e a categoria que a folha mostra são deste teste (não dependem dos anteriores).
    const categoria = async (nome: string, categoriaPaiId?: string) => {
      const r = await amb.http().post('/api/categorias').set(bearer()).send({ nome, categoriaPaiId });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const bebidas = await categoria('BEBIDAS FOLHA');
    const sucos = await categoria('SUCOS FOLHA', bebidas);
    const [m] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into marcas (descricao) values ('MARCA FOLHA') returning id",
    );
    const suco = await produto({
      nome: 'SUCO FOLHA 1L',
      marcaId: m!.id,
      localizacao: 'C-03',
      categorias: [sucos],
      codigosBarras: [{ codigo: EAN_SUCO, principal: true }],
    });
    const entrada = await criarAcerto({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: suco, quantidade: '37' }],
    });
    await efetivar(entrada.id);
    const cega = await amb
      .http()
      .get(`/api/acertos/folha-contagem?estoqueId=${estoqueLoja}&marcaId=${m!.id}`)
      .set(bearer());
    expect(cega.status, JSON.stringify(cega.body)).toBe(200);
    expect(cega.body).toMatchObject({
      cega: true,
      ordem: 'localizacao',
      marca: 'MARCA FOLHA',
      tipoEstoqueNome: 'Disponível',
    });
    expect(cega.body.linhas).toHaveLength(1);
    expect(cega.body.linhas[0]).toMatchObject({
      produtoId: suco,
      codigoBarras: EAN_SUCO,
      localizacao: 'C-03',
      saldo: null,
    });
    const comSaldo = await amb
      .http()
      .get(`/api/acertos/folha-contagem?estoqueId=${estoqueLoja}&cega=false&marcaId=${m!.id}`)
      .set(bearer());
    expect(comSaldo.body.linhas[0].saldo).toBe('37.000');
    // A categoria pai traz o produto da subcategoria; a marca Heineken traz só a cerveja.
    const porCategoria = await amb
      .http()
      .get(`/api/acertos/folha-contagem?estoqueId=${estoqueLoja}&categoriaId=${bebidas}`)
      .set(bearer());
    expect(porCategoria.status, JSON.stringify(porCategoria.body)).toBe(200);
    expect(porCategoria.body.categoria).toBe('BEBIDAS FOLHA');
    expect(porCategoria.body.linhas.map((l: { produtoId: string }) => l.produtoId)).toEqual([suco]);
    const filha = await amb
      .http()
      .get(`/api/acertos/folha-contagem?estoqueId=${estoqueLoja}&categoriaId=${sucos}`)
      .set(bearer());
    expect(filha.body.linhas.map((l: { produtoId: string }) => l.produtoId)).toEqual([suco]);
    const heineken = await amb
      .http()
      .get(`/api/acertos/folha-contagem?estoqueId=${estoqueLoja}&marcaId=${marcaHeineken}`)
      .set(bearer());
    expect(heineken.body.linhas.map((l: { produtoId: string }) => l.produtoId)).toEqual([cerveja]);
    const porLocal = await amb
      .http()
      .get(`/api/acertos/folha-contagem?estoqueId=${estoqueLoja}`)
      .set(bearer());
    const nomes = porLocal.body.linhas.map((l: { nome: string }) => l.nome);
    // A-01 antes de B-02; sem localização depois, por nome; combo e "Com variações" fora.
    expect(nomes.slice(0, 2)).toEqual(['REFRI COCA 2L', 'CERV HEINEKEN LT 350ML']);
    expect(nomes).not.toContain('COMBO BALDE');
    expect(nomes).not.toContain('CAMISETA ICE BEER');
    const porNome = await amb
      .http()
      .get(`/api/acertos/folha-contagem?estoqueId=${estoqueLoja}&ordem=nome`)
      .set(bearer());
    expect(porNome.body.linhas[0].nome).toBe('AGUA CRYSTAL 500ML');
    expect((await amb.http().get('/api/acertos/folha-contagem?estoqueId=x').set(bearer())).status).toBe(422);
  });

  it('lotes da grade do acerto com o saldo do lote', async () => {
    const [lote] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into produtos_lotes (produto_id, estoque_id, lote, validade) values ($1, $2, 'L-01', '2027-01-31') returning id",
      [refri, estoqueLoja],
    );
    const entrada = await criarAcerto({
      tipoAjuste: 'entrada',
      itens: [{ produtoId: refri, quantidade: '6', loteId: lote!.id }],
    });
    await efetivar(entrada.id);
    const r = await amb
      .http()
      .get(`/api/saldos-estoque/lotes?estoqueId=${estoqueLoja}&produtoIds=${refri},${cerveja}`)
      .set(bearer());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual([
      {
        loteId: lote!.id,
        produtoId: refri,
        variacaoId: null,
        lote: 'L-01',
        validade: '2027-01-31',
        quantidade: '6.000',
      },
    ]);
  });

  it('o razão refaz as projeções idênticas', async () => {
    await conferirRazaoDoBanco(emp.nomeBanco);
  });
});
