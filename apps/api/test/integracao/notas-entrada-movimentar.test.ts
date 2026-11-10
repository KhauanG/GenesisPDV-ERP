/**
 * NF-e de fornecedor por XML: movimentar e estornar (`RECEB_NFE`/`ESTORNO_RECEB_NFE`) com a composição do custo e o
 * vínculo aprendido (Fase 2, F2-B21; ERP 13.4, 13.4.1; MD 3.6.10, 3.8.2; F2-Q8 = D49; D56; README da API › decisão
 * 169), com o S3 em memória. Critério de pronto: a NF-e de bebidas entra no estoque certo com o fator e o custo
 * corretos (ST, frete; qTrib ≠ qCom com a caixa de 12, conferido com a conta feita à mão), o vínculo fornecedor + cProd
 * é aprendido e a nota seguinte do mesmo fornecedor chega com todos os itens sugeridos pelo "vínculo anterior". Também:
 * o FCP-ST e o IPI ligados e desligados pelas chaves, a pergunta do preço de custo (D49), o preço de venda proposto
 * com o histórico na origem `nota_entrada`, o movimentar repetido que não lança de novo, as recusas (pendente,
 * ignorada, estornada, sem permissão), o vínculo sem código que ganha o cProd, o código que troca de produto (o
 * "mover vínculo": `produtos.editar`, a linha antiga excluída e a auditoria no produto antigo), dois códigos movidos
 * para o mesmo produto (um principal só), a nota mais antiga movimentada depois (o último custo não volta), dois
 * códigos do mesmo produto na nota (cada vínculo com o custo do seu item), o item em dois lotes do `rastro` (um
 * movimento por lote; a 2ª parte com o lote já cadastrado em outra data fica com a do cadastro) e o estorno (o comum,
 * o que deixaria saldo negativo — 422 sem a permissão, a confirmação da lista com o Master — e o da nota dividida em
 * lotes). No fim o razão refaz as projeções idênticas (`conferirRazaoDoBanco`, o núcleo do `db:recalcular-saldos`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { variarFixtureNfe } from '../fixtures/nfe/gerar.js';
import { CNPJ_CD, CNPJ_LOJA_1, fixtureNfe } from '../fixtures/nfe/fixtures.js';
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
import { iniciarS3Falso, type S3Falso } from './s3-falso.js';

process.env.NFE_IMPORTACOES_POR_MINUTO = '1000';

let amb: Ambiente;
let emp: EmpresaTeste;
let s3: S3Falso | null = null;
let admin: string;
let vendedor: string;
/** Estoquista do seed: movimenta e estorna a NF-e, sem Master e sem `produtos.ver_custo`. */
let estoquista: string;
/** Perfil personalizado com `notas_entrada.importar`/`movimentar` e sem `produtos.editar`. */
let soNotas: string;
let un: string;
const ids = {
  loja1: '',
  cd: '',
  estoqueLoja1: '',
  estoqueCd: '',
  nota01: '',
  nota01b: '',
  nota02: '',
  nota03: '',
  nota07: '',
  cerveja: '',
  caixaCerveja: '',
  refri: '',
  agua: '',
  agua2: '',
  iogurte: '',
  fornecedor01: '',
};
const bearer = (t = admin) => ({ Authorization: `Bearer ${t}` });

interface Item {
  id: string;
  numeroItem: number;
  codigoFornecedor: string;
  produtoId: string | null;
  fator: string;
  quantidadeEstoque: string | null;
  fatorConfirmado: boolean;
  custoUnitario: string | null;
  loteId: string | null;
  lote: string | null;
  validade: string | null;
  fabricacao: string | null;
  sugestao: { origem: string; produtoId: string; codigoBarrasId: string | null; fator: string } | null;
}
interface Nota {
  id: string;
  versao: number;
  status: string;
  fornecedorId: string;
  dataMovimentacao: string | null;
  movimentadaPorNome: string | null;
  estornadaEm: string | null;
  estornadaPorNome: string | null;
  motivoEstorno: string | null;
  itens: Item[];
}

beforeAll(async () => {
  const s3Real = process.env.ARMAZENAMENTO_TESTE_URL;
  if (!s3Real) s3 = await iniciarS3Falso();
  amb = await criarAmbiente({
    env: {
      ARMAZENAMENTO_ENDPOINT: s3Real ?? s3!.url,
      ARMAZENAMENTO_BUCKET: `genesis-teste-movimentar-nfe-${Date.now()}`,
    },
  });
  await amb.servicos.armazenamento.garantirBucket();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  ids.loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1');
  ids.cd = await criarLoja(emp.nomeBanco, 3, 'CD');
  for (const [id, cnpj] of [
    [ids.loja1, CNPJ_LOJA_1],
    [ids.cd, CNPJ_CD],
  ] as const)
    await consultar(emp.nomeBanco, 'update lojas set cnpj = $1 where id = $2', [cnpj, id]);
  const lojas = await consultar<{ id: string; estoque_id: string }>(
    emp.nomeBanco,
    'select id, estoque_id from lojas where id = any($1)',
    [[ids.loja1, ids.cd]],
  );
  ids.estoqueLoja1 = lojas.find((l) => l.id === ids.loja1)!.estoque_id;
  ids.estoqueCd = lojas.find((l) => l.id === ids.cd)!.estoque_id;
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [ids.loja1] });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [ids.loja1, ids.cd],
    estoques: [ids.estoqueLoja1, ids.estoqueCd],
  });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  // Perfil personalizado que vincula e movimenta a NF-e, mas não edita produtos (o "mover vínculo" exige).
  const [perfil] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into perfis (nome, descricao, chave_sistema) values ('Só notas', 'teste', 'teste_so_notas') returning id",
  );
  for (const permissao of ['notas_entrada.ver', 'notas_entrada.importar', 'notas_entrada.movimentar'])
    await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
      perfil!.id,
      permissao,
    ]);
  await criarUsuario(emp.nomeBanco, {
    login: 'so_notas',
    perfil: 'teste_so_notas',
    lojas: [ids.loja1, ids.cd],
    estoques: [ids.estoqueLoja1, ids.estoqueCd],
  });
  soNotas = await amb.entrar(emp.codigo, 'so_notas', SENHA_TESTE);
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

async function importar(arquivo: string, conteudo = fixtureNfe(arquivo)): Promise<string> {
  const r = await amb
    .http()
    .post('/api/notas-entrada/importar')
    .set(bearer())
    .attach('arquivos', Buffer.from(conteudo), arquivo);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.resultados[0].situacao, JSON.stringify(r.body)).toBe('importada');
  return r.body.resultados[0].notaId as string;
}

async function nota(id: string): Promise<Nota> {
  const r = await amb.http().get(`/api/notas-entrada/${id}`).set(bearer());
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Nota;
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

async function codigo(produtoId: string, cod: string, fator: string): Promise<string> {
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into produtos_codigos_barras (produto_id, codigo, tipo, fator, usa_venda, usa_compra)
     values ($1, $2, 'gtin', $3, false, true) returning id`,
    [produtoId, cod, fator],
  );
  return c!.id;
}

async function vincular(id: string, itens: Array<Record<string, unknown>>) {
  const d = await nota(id);
  const r = await amb
    .http()
    .put(`/api/notas-entrada/${id}/itens`)
    .set(bearer())
    .send({ versao: d.versao, itens });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Nota;
}

/** "Confirmar todos" da aba: cada item com a sugestão de agora e o fator confirmado. */
async function confirmarSugestoes(id: string): Promise<Nota> {
  const d = await nota(id);
  for (const i of d.itens) expect(i.sugestao, `item ${i.numeroItem} sem sugestão`).not.toBeNull();
  return vincular(
    id,
    d.itens.map((i) => ({
      id: i.id,
      produtoId: i.sugestao!.produtoId,
      codigoBarrasId: i.sugestao!.codigoBarrasId,
      fator: i.sugestao!.fator,
      fatorConfirmado: true,
      lote: i.lote,
      validade: i.validade,
      fabricacao: i.fabricacao,
    })),
  );
}

const movimentar = (id: string, corpo: Record<string, unknown> = {}, token = admin) =>
  amb.http().post(`/api/notas-entrada/${id}/movimentar`).set(bearer(token)).send(corpo);
const estornar = (id: string, motivo: string, token = admin, extra: Record<string, unknown> = {}) =>
  amb
    .http()
    .post(`/api/notas-entrada/${id}/estornar`)
    .set(bearer(token))
    .send({ motivo, ...extra });

const movimentos = (documentoId: string) =>
  consultar<{
    tipo_movimento: string;
    produto_id: string;
    quantidade: string;
    custo_unitario: string;
    fator: string;
    unidade_documento: string | null;
    pessoa_id: string | null;
    lote_id: string | null;
    documento_item_id: string;
    estorno_de_id: string | null;
  }>(
    emp.nomeBanco,
    `select tipo_movimento, produto_id, quantidade::text, custo_unitario::text, fator::text, unidade_documento,
            pessoa_id, lote_id, documento_item_id, estorno_de_id
       from movimentos_estoque where documento_tipo = 'nota_entrada' and documento_id = $1
      order by seq_lancamento`,
    [documentoId],
  );

async function saldo(produtoId: string, estoqueId = ids.estoqueLoja1) {
  const [s] = await consultar<{
    quantidade: string;
    custo_medio: string;
    ultimo_custo_compra: string | null;
  }>(
    emp.nomeBanco,
    `select s.quantidade::text, s.custo_medio::text, s.ultimo_custo_compra::text
       from saldos_estoque s join tipos_estoque t on t.id = s.tipo_estoque_id
      where s.estoque_id = $1 and s.produto_id = $2 and t.padrao`,
    [estoqueId, produtoId],
  );
  return s ?? null;
}

/** Todos os vínculos do produto, os excluídos também (o "mover vínculo" exclui a linha antiga). */
const vinculosComExcluidos = (produtoId: string) =>
  consultar<{ codigo_fornecedor: string | null; custo_fornecedor: string | null; excluido: boolean }>(
    emp.nomeBanco,
    `select codigo_fornecedor, custo_fornecedor::text, excluido_em is not null as excluido
       from produtos_fornecedores where produto_id = $1 order by criado_em`,
    [produtoId],
  );

const vinculos = (produtoId: string) =>
  consultar<Record<string, unknown>>(
    emp.nomeBanco,
    `select produto_id, codigo_fornecedor, unidade_compra, fator::text, ultimo_custo::text, ultima_compra_em::text,
            custo_fornecedor::text, principal
       from produtos_fornecedores where produto_id = $1 and excluido_em is null order by criado_em`,
    [produtoId],
  );

async function configurar(chave: string, valor: unknown) {
  await consultar(emp.nomeBanco, 'delete from configuracoes where chave = $1', [chave]);
  if (valor !== null)
    await consultar(
      emp.nomeBanco,
      `insert into configuracoes (escopo, chave, valor) values ('empresa', $1, $2::jsonb)`,
      [chave, JSON.stringify(valor)],
    );
}

describe('movimentar (ERP 13.4): custo, fator, preço e vínculo aprendido', () => {
  it('recusa a nota pendente e quem não tem notas_entrada.movimentar', async () => {
    ids.nota01 = await importar('01-icms-st.xml');
    const r = await movimentar(ids.nota01);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.mensagem).toMatch(/ainda não está pronta/);
    expect((await movimentar(ids.nota01, {}, vendedor)).status).toBe(403);
    expect(await movimentos(ids.nota01)).toHaveLength(0);
  });

  it('critério de pronto: a NF-e de bebidas entra com o fator e o custo da conta à mão, e aprende o vínculo', async () => {
    let d = await nota(ids.nota01);
    ids.fornecedor01 = d.fornecedorId;
    const [cerveja, refri, agua] = d.itens;
    ids.cerveja = await produto('CERVEJA PILSEN LATA 350ML', {
      codigosBarras: [{ codigo: '7891000000014', principal: true }],
    });
    ids.caixaCerveja = await codigo(ids.cerveja, '17891000000011', '12');
    ids.refri = await produto('REFRIGERANTE COLA PET 2L', {
      codigosBarras: [{ codigo: '7891000000021', principal: true }],
    });
    ids.agua = await produto('AGUA MINERAL 500ML', {
      codigosBarras: [{ codigo: '7891000000038', principal: true }],
    });
    // O refrigerante já tinha um vínculo sem código com o fornecedor (o recebimento manual): ganha o cProd.
    await consultar(
      emp.nomeBanco,
      `insert into produtos_fornecedores (produto_id, fornecedor_id, unidade_compra, fator, ultimo_custo,
                                          ultima_compra_em, principal)
       values ($1, $2, 'FD', 6, 7.5, '2026-10-01', true)`,
      [ids.refri, ids.fornecedor01],
    );
    d = await vincular(ids.nota01, [
      {
        id: cerveja!.id,
        produtoId: ids.cerveja,
        codigoBarrasId: ids.caixaCerveja,
        fator: '12',
        fatorConfirmado: true,
        precoVenda: '6.5',
        atualizarPreco: 'geral',
      },
      { id: refri!.id, produtoId: ids.refri, fator: '6', fatorConfirmado: true },
      { id: agua!.id, produtoId: ids.agua, fator: '1', fatorConfirmado: true },
    ]);
    expect(d.status).toBe('pronta');

    // A pergunta do preço de custo (D49, 'perguntar' por padrão) para quem vê o custo; nada lançado.
    const pergunta = await movimentar(ids.nota01, { versao: d.versao });
    expect(pergunta.status, JSON.stringify(pergunta.body)).toBe(422);
    expect(pergunta.body.campos.atualizarPrecoCusto).toHaveLength(1);
    expect(pergunta.body.detalhes.precosCusto).toHaveLength(3);
    expect(await movimentos(ids.nota01)).toHaveLength(0);
    // A versão desatualizada é conflito.
    expect((await movimentar(ids.nota01, { versao: d.versao - 1, atualizarPrecoCusto: true })).status).toBe(
      409,
    );

    const ok = await movimentar(ids.nota01, { versao: d.versao, atualizarPrecoCusto: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const m = ok.body as Nota;
    expect(m.status).toBe('movimentada');
    expect(m.dataMovimentacao).not.toBeNull();
    expect(m.movimentadaPorNome).not.toBeNull();
    // Conta à mão (todas as parcelas ligadas, o padrão):
    // cerveja (399,00 + frete 15,00 + ST 52,16) / (10 CX × 12) = 466,16 / 120 = 3,88466… → 3,8847;
    // refrigerante (228,00 + 7,00 + 29,61) / (5 FD × 6) = 264,61 / 30 = 8,82033… → 8,8203;
    // água (30,00 + 3,00) / 24 = 1,3750.
    expect(m.itens.map((i) => [i.quantidadeEstoque, i.custoUnitario])).toEqual([
      ['120.000', '3.8847'],
      ['30.000', '8.8203'],
      ['24.000', '1.3750'],
    ]);
    const movs = await movimentos(ids.nota01);
    expect(
      movs.map((x) => [x.tipo_movimento, x.quantidade, x.custo_unitario, x.fator, x.unidade_documento]),
    ).toEqual([
      ['RECEB_NFE', '120.000', '3.8847', '12.000', 'CX'],
      ['RECEB_NFE', '30.000', '8.8203', '6.000', 'FD'],
      ['RECEB_NFE', '24.000', '1.3750', '1.000', 'UN'],
    ]);
    for (const x of movs) expect(x.pessoa_id).toBe(ids.fornecedor01);
    expect(movs.map((x) => x.documento_item_id)).toEqual(m.itens.map((i) => i.id));
    expect(await saldo(ids.cerveja)).toMatchObject({
      quantidade: '120.000',
      custo_medio: '3.8847',
      ultimo_custo_compra: '3.8847',
    });
    // O preço de custo (respondido "sim") e o preço de venda proposto, com o histórico na origem da nota.
    const [p] = await consultar<{ preco_custo: string; preco_venda: string }>(
      emp.nomeBanco,
      'select preco_custo::text, preco_venda::text from produtos where id = $1',
      [ids.cerveja],
    );
    expect(p).toEqual({ preco_custo: '3.8847', preco_venda: '6.5000' });
    const historico = await consultar<{ tipo_preco: string; origem: string; origem_id: string }>(
      emp.nomeBanco,
      `select tipo_preco, origem, origem_id from produtos_historico_precos
        where produto_id = $1 and origem <> 'cadastro' order by tipo_preco`,
      [ids.cerveja],
    );
    expect(historico.length).toBeGreaterThanOrEqual(2);
    for (const h of historico) expect(h).toMatchObject({ origem: 'nota_entrada', origem_id: ids.nota01 });
    // A consulta do histórico (F2-B37): a origem NF-e com o número da nota.
    const [notaGravada] = await consultar<{ numero: number }>(
      emp.nomeBanco,
      'select numero from notas_entrada where id = $1',
      [ids.nota01],
    );
    const consulta = await amb.http().get(`/api/produtos/${ids.cerveja}/historico-precos`).set(bearer());
    expect(consulta.status, JSON.stringify(consulta.body)).toBe(200);
    const daNota = (consulta.body.itens as Array<Record<string, unknown>>).filter(
      (h) => h.origem === 'nota_entrada',
    );
    expect(daNota.map((h) => h.tipoPreco).sort()).toEqual(historico.map((h) => h.tipo_preco).sort());
    for (const h of daNota)
      expect(h.documento).toEqual({ id: ids.nota01, numero: String(notaGravada!.numero) });

    // O vínculo aprendido: fornecedor + cProd → produto, fator e uCom, com o custo e a data da emissão.
    expect(await vinculos(ids.cerveja)).toEqual([
      {
        produto_id: ids.cerveja,
        codigo_fornecedor: 'CERV-LT350-CX12',
        unidade_compra: 'CX',
        fator: '12.000',
        ultimo_custo: '3.8847',
        ultima_compra_em: '2026-10-20',
        custo_fornecedor: null,
        principal: true,
      },
    ]);
    // O vínculo sem código do refrigerante ganhou o cProd (sem um segundo vínculo do mesmo fornecedor).
    expect(await vinculos(ids.refri)).toEqual([
      expect.objectContaining({
        codigo_fornecedor: 'REFRI-2L-FD6',
        fator: '6.000',
        ultimo_custo: '8.8203',
        ultima_compra_em: '2026-10-20',
        principal: true,
      }),
    ]);
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'notas_entrada' and registro_id = $1 and acao = 'movimentar'`,
      [ids.nota01],
    );
    expect(aud!.descricao).toMatch(/3 item\(ns\), 3 movimento\(s\).*3 vínculo\(s\) fornecedor \+ código/);
  });

  it('movimentar de novo é idempotente (nada é lançado, nem com a versão velha)', async () => {
    const r = await movimentar(ids.nota01, { versao: 1, atualizarPrecoCusto: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('movimentada');
    expect(await movimentos(ids.nota01)).toHaveLength(3);
    expect((await saldo(ids.cerveja))!.quantidade).toBe('120.000');
  });

  it('a nota seguinte do mesmo fornecedor vem 100% sugerida pelo vínculo anterior; o código que troca de produto', async () => {
    const variante = variarFixtureNfe('01-icms-st.xml', {
      nNF: '12399',
      cNF: '10203099',
      nProt: '135260000000199',
    });
    ids.nota01b = await importar('01-segunda.xml', variante.xml);
    const d = await nota(ids.nota01b);
    expect(d.fornecedorId).toBe(ids.fornecedor01);
    expect(d.itens.map((i) => [i.sugestao?.origem, i.sugestao?.produtoId, i.sugestao?.fator])).toEqual([
      ['vinculo_anterior', ids.cerveja, '12.000'],
      ['vinculo_anterior', ids.refri, '6.000'],
      ['vinculo_anterior', ids.agua, '1.000'],
    ]);
    // "Confirmar todos" com as sugestões, menos a água, que o usuário liga a outro produto. O vínculo AGUA-500 da água
    // tem o custo do fornecedor digitado, e a água com gás já tem o fornecedor principal (outro).
    ids.agua2 = await produto('AGUA MINERAL COM GAS 500ML');
    await consultar(
      emp.nomeBanco,
      `update produtos_fornecedores set custo_fornecedor = 1.10
        where produto_id = $1 and codigo_fornecedor = 'AGUA-500'`,
      [ids.agua],
    );
    const [outroFornecedor] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into pessoas (nome, tipo) values ('OUTRO DISTRIBUIDOR', 'PJ') returning id",
    );
    await consultar(
      emp.nomeBanco,
      `insert into produtos_fornecedores (produto_id, fornecedor_id, fator, principal) values ($1, $2, 1, true)`,
      [ids.agua2, outroFornecedor!.id],
    );
    const confirmada = await confirmarSugestoes(ids.nota01b);
    expect(confirmada.status).toBe('pronta');
    const agua = confirmada.itens[2]!;
    const pronta = await vincular(ids.nota01b, [
      { id: agua.id, produtoId: ids.agua2, fator: '1', fatorConfirmado: true },
    ]);
    expect(pronta.status).toBe('pronta');
    // Tirar o AGUA-500 da água altera o cadastro dela: sem "Produtos: Editar", 403 no item (como o "mover vínculo"
    // do produto), antes da pergunta do preço de custo e sem lançar nada.
    const semEditar = await movimentar(ids.nota01b, {}, soNotas);
    expect(semEditar.status, JSON.stringify(semEditar.body)).toBe(403);
    expect(Object.keys(semEditar.body.campos)).toEqual(['itens.2.produtoId']);
    expect(semEditar.body.campos['itens.2.produtoId'][0]).toMatch(
      /"AGUA-500" deste fornecedor está ligado ao produto \d+ - AGUA MINERAL 500ML/,
    );
    expect(await movimentos(ids.nota01b)).toHaveLength(0);
    expect(await vinculos(ids.agua)).toHaveLength(1);

    const r = await movimentar(ids.nota01b, { atualizarPrecoCusto: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // O mesmo custo da primeira nota: o custo médio fica, e o saldo dobra.
    expect(await saldo(ids.cerveja)).toMatchObject({ quantidade: '240.000', custo_medio: '3.8847' });
    // O preço de custo respondido "não" ficou (o do cadastro: 4,00; o da nota seria 1,3750).
    const [p] = await consultar<{ preco_custo: string }>(
      emp.nomeBanco,
      'select preco_custo::text from produtos where id = $1',
      [ids.agua2],
    );
    expect(p!.preco_custo).toBe('4.0000');
    // Um vínculo por cProd: a cerveja continua com um só. O AGUA-500 saiu da água como no "mover vínculo": a linha
    // antiga excluída (com o custo do fornecedor dela) e uma nova na água com gás, sem o custo do fornecedor e sem
    // ser principal (o produto já tinha o principal).
    expect(await vinculos(ids.cerveja)).toHaveLength(1);
    expect(await vinculos(ids.agua)).toEqual([]);
    expect(await vinculosComExcluidos(ids.agua)).toEqual([
      { codigo_fornecedor: 'AGUA-500', custo_fornecedor: '1.1000', excluido: true },
    ]);
    expect(await vinculos(ids.agua2)).toEqual([
      expect.objectContaining({ codigo_fornecedor: null, principal: true }),
      expect.objectContaining({
        codigo_fornecedor: 'AGUA-500',
        fator: '1.000',
        ultimo_custo: '1.3750',
        ultima_compra_em: '2026-10-20',
        custo_fornecedor: null,
        principal: false,
      }),
    ]);
    // A água (o produto antigo) ganha a auditoria "editar" com os vínculos de antes e de depois.
    const audAgua = await consultar<{
      descricao: string;
      antes: { fornecedores: Array<{ codigoFornecedor: string | null }> };
      depois: { fornecedores: unknown[] };
    }>(
      emp.nomeBanco,
      `select descricao, antes, depois from auditoria
        where entidade = 'produtos' and registro_id = $1 and acao = 'editar'`,
      [ids.agua],
    );
    expect(audAgua).toHaveLength(1);
    expect(audAgua[0]!.descricao).toMatch(
      /^Vínculo do fornecedor movido pela NF-e Nº 12399: código "AGUA-500" para o produto \d+ - AGUA MINERAL COM GAS 500ML$/,
    );
    expect(audAgua[0]!.antes.fornecedores.map((f) => f.codigoFornecedor)).toEqual(['AGUA-500']);
    expect(audAgua[0]!.depois.fornecedores).toEqual([]);
  });

  it('as parcelas do custo pelas chaves: FCP-ST e ST desligados (02) e IPI desligado (03)', async () => {
    ids.nota02 = await importar('02-fcp-st.xml');
    const n02 = await nota(ids.nota02);
    const a = await produto('ENERGETICO 250ML');
    const b = await produto('ENERGETICO 473ML');
    await vincular(ids.nota02, [
      { id: n02.itens[0]!.id, produtoId: a, fator: '1', fatorConfirmado: true },
      { id: n02.itens[1]!.id, produtoId: b, fator: '1', fatorConfirmado: true },
    ]);
    await configurar('estoque.custo_inclui_st', false);
    try {
      const r = await movimentar(ids.nota02, { atualizarPrecoCusto: false });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // Sem ST e FCP-ST: 311,52 / 48 = 6,49; 52,00 / 12 = 4,3333 (com eles seriam 361,36 / 48 = 7,5283).
      expect((r.body as Nota).itens.map((i) => i.custoUnitario)).toEqual(['6.4900', '4.3333']);
    } finally {
      await configurar('estoque.custo_inclui_st', null);
    }

    ids.nota03 = await importar('03-ipi-industria.xml');
    const n03 = await nota(ids.nota03);
    const ipa = await produto('CERVEJA IPA 600ML');
    const stout = await produto('CERVEJA STOUT 355ML');
    await vincular(ids.nota03, [
      { id: n03.itens[0]!.id, produtoId: ipa, fator: '12', fatorConfirmado: true },
      { id: n03.itens[1]!.id, produtoId: stout, fator: '24', fatorConfirmado: true },
    ]);
    await configurar('estoque.custo_inclui_ipi', false);
    try {
      const r = await movimentar(ids.nota03, { atualizarPrecoCusto: false });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // Sem o IPI, com o seguro e as outras despesas e menos o desconto:
      // IPA (528,00 + 6,60 + 10,00 − 26,40) / (4 CX × 12) = 518,20 / 48 = 10,79583… → 10,7958;
      // stout (191,00 + 2,40 + 5,00 − 9,55) / (2 CX × 24) = 188,85 / 48 = 3,934375 → 3,9344.
      expect((r.body as Nota).itens.map((i) => i.custoUnitario)).toEqual(['10.7958', '3.9344']);
    } finally {
      await configurar('estoque.custo_inclui_ipi', null);
    }
  });

  it('Estoquista (sem produtos.ver_custo) movimenta sem a pergunta: o preço de custo fica', async () => {
    const variante = variarFixtureNfe('01-icms-st.xml', {
      nNF: '12400',
      cNF: '10203100',
      nProt: '135260000000200',
    });
    const id = await importar('01-terceira.xml', variante.xml);
    await confirmarSugestoes(id);
    // A água com gás (o AGUA-500 desde a segunda nota) tem o preço de custo 4,00 e o custo desta nota é 1,3750: quem
    // vê o custo recebe a pergunta (o produto com o custo diferente existe nesta nota).
    const pergunta = await movimentar(id);
    expect(pergunta.status, JSON.stringify(pergunta.body)).toBe(422);
    expect(pergunta.body.detalhes.precosCusto).toEqual([
      expect.objectContaining({ produtoId: ids.agua2, atual: '4.0000', novo: '1.3750' }),
    ]);
    expect(await movimentos(id)).toHaveLength(0);
    const r = await movimentar(id, {}, estoquista);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await movimentos(id)).toHaveLength(3);
    const [depois] = await consultar<{ preco_custo: string }>(
      emp.nomeBanco,
      'select preco_custo::text from produtos where id = $1',
      [ids.agua2],
    );
    expect(depois!.preco_custo).toBe('4.0000');
    // Estornada para não pesar nos saldos dos testes seguintes.
    expect((await estornar(id, 'Lançada em duplicidade', estoquista)).status).toBe(200);
  });

  it('o vínculo aprendido: códigos movidos para o mesmo produto, a nota mais antiga e dois códigos do mesmo produto', async () => {
    // A quarta nota do fornecedor, **emitida antes** das outras (10/10), com dois itens a mais: a cerveja e o
    // refrigerante com os códigos novos NOVO-CX e NOVO-FD, e a água mais barata (24 × 1,00 + 3,00 de frete = 1,1250).
    const variante = variarFixtureNfe('01-icms-st.xml', {
      nNF: '12401',
      cNF: '10203101',
      nProt: '135260000000201',
      dhEmi: '2026-10-10T08:15:00-03:00',
      itens: (base) => [
        ...base.map((i) => (i.cProd === 'AGUA-500' ? { ...i, vUnCom: '1.0000000000' } : i)),
        { ...base[0]!, cProd: 'NOVO-CX' },
        { ...base[1]!, cProd: 'NOVO-FD' },
      ],
    });
    const id = await importar('01-quarta.xml', variante.xml);
    const d = await nota(id);
    expect(d.itens.map((i) => i.codigoFornecedor)).toEqual([
      'CERV-LT350-CX12',
      'REFRI-2L-FD6',
      'AGUA-500',
      'NOVO-CX',
      'NOVO-FD',
    ]);
    // O "kit" sem vínculo nenhum recebe os dois códigos que estavam na cerveja e no refrigerante; o "fardo misto" tem
    // um vínculo sem código com o fornecedor (o do recebimento manual) e recebe os dois códigos novos.
    const kit = await produto('KIT CERVEJA E REFRIGERANTE');
    const misto = await produto('FARDO MISTO');
    await consultar(
      emp.nomeBanco,
      `insert into produtos_fornecedores (produto_id, fornecedor_id, unidade_compra, fator, ultimo_custo,
                                          ultima_compra_em, principal)
       values ($1, $2, 'UN', 1, 9.99, '2026-09-01', true)`,
      [misto, ids.fornecedor01],
    );
    const [cerv, refri, agua, novoCx, novoFd] = d.itens;
    await vincular(id, [
      { id: cerv!.id, produtoId: kit, fator: '12', fatorConfirmado: true },
      { id: refri!.id, produtoId: kit, fator: '6', fatorConfirmado: true },
      { id: agua!.id, produtoId: ids.agua2, fator: '1', fatorConfirmado: true },
      { id: novoCx!.id, produtoId: misto, fator: '12', fatorConfirmado: true },
      { id: novoFd!.id, produtoId: misto, fator: '6', fatorConfirmado: true },
    ]);
    const r = await movimentar(id, { atualizarPrecoCusto: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as Nota).itens.map((i) => i.custoUnitario)).toEqual([
      '3.8847',
      '8.8203',
      '1.1250',
      '3.8847',
      '8.8203',
    ]);

    // Os dois códigos que saíram da cerveja e do refrigerante para o kit: um vínculo novo cada, com o custo do item e
    // a data desta nota, e **um só principal** (o kit não tinha vínculo nenhum).
    const doKit = await vinculos(kit);
    expect(doKit.map((v) => [v.codigo_fornecedor, v.fator, v.ultimo_custo, v.ultima_compra_em])).toEqual([
      ['CERV-LT350-CX12', '12.000', '3.8847', '2026-10-10'],
      ['REFRI-2L-FD6', '6.000', '8.8203', '2026-10-10'],
    ]);
    expect(doKit.filter((v) => v.principal)).toHaveLength(1);
    expect(await vinculos(ids.cerveja)).toEqual([]);
    expect(await vinculos(ids.refri)).toEqual([]);
    const auds = await consultar<{ registro_id: string; descricao: string }>(
      emp.nomeBanco,
      `select registro_id, descricao from auditoria
        where entidade = 'produtos' and acao = 'editar' and registro_id = any($1) order by descricao`,
      [[ids.cerveja, ids.refri]],
    );
    expect(auds.map((a) => a.descricao)).toEqual([
      expect.stringMatching(/NF-e Nº 12401: código "CERV-LT350-CX12" para o produto \d+ - KIT CERVEJA/),
      expect.stringMatching(/NF-e Nº 12401: código "REFRI-2L-FD6" para o produto \d+ - KIT CERVEJA/),
    ]);

    // O AGUA-500 no mesmo produto: o fator e a unidade são os desta nota, mas a nota é mais antiga que a última
    // compra (20/10): o último custo e a última compra não voltam para trás.
    expect(await vinculos(ids.agua2)).toEqual([
      expect.objectContaining({ codigo_fornecedor: null }),
      expect.objectContaining({
        codigo_fornecedor: 'AGUA-500',
        unidade_compra: 'UN',
        fator: '1.000',
        ultimo_custo: '1.3750',
        ultima_compra_em: '2026-10-20',
      }),
    ]);

    // Dois códigos novos do mesmo produto: o vínculo sem código adota um (fica principal) e o outro é criado; cada um
    // com o custo do seu item (o passo comum não sobrescreve um com o do outro), e nenhum vínculo sem código sobra.
    const doMisto = await vinculos(misto);
    expect(doMisto).toHaveLength(2);
    const porCodigo = Object.fromEntries(doMisto.map((v) => [v.codigo_fornecedor as string, v]));
    expect(porCodigo['NOVO-CX']).toMatchObject({
      fator: '12.000',
      unidade_compra: 'CX',
      ultimo_custo: '3.8847',
    });
    expect(porCodigo['NOVO-FD']).toMatchObject({
      fator: '6.000',
      unidade_compra: 'FD',
      ultimo_custo: '8.8203',
    });
    // O adotado tinha a última compra de 01/09 e passa à desta nota (10/10); o novo nasce com ela.
    for (const v of doMisto) expect(v.ultima_compra_em).toBe('2026-10-10');
    expect(doMisto.filter((v) => v.principal)).toHaveLength(1);

    // Estornada para não pesar nos saldos dos testes seguintes (o vínculo aprendido fica).
    expect((await estornar(id, 'Teste do vínculo aprendido')).status).toBe(200);
  });
});

describe('estornar (ERP 13.4; D56 com aviso)', () => {
  it('o estorno tira o que a nota lançou; a estornada não volta nem se movimenta de novo', async () => {
    expect((await estornar(ids.nota03, '')).status).toBe(422);
    expect((await estornar(ids.nota03, 'Nota cancelada pelo emitente', vendedor)).status).toBe(403);
    const r = await estornar(ids.nota03, 'Nota cancelada pelo emitente');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const e = r.body as Nota;
    expect(e).toMatchObject({ status: 'estornada', motivoEstorno: 'Nota cancelada pelo emitente' });
    expect(e.estornadaEm).not.toBeNull();
    expect(e.estornadaPorNome).not.toBeNull();
    const movs = await movimentos(ids.nota03);
    expect(movs.map((x) => [x.tipo_movimento, x.quantidade])).toEqual([
      ['RECEB_NFE', '48.000'],
      ['RECEB_NFE', '48.000'],
      ['ESTORNO_RECEB_NFE', '-48.000'],
      ['ESTORNO_RECEB_NFE', '-48.000'],
    ]);
    for (const p of movs.slice(0, 2)) expect((await saldo(p.produto_id))!.quantidade).toBe('0.000');
    // O vínculo aprendido continua (o estorno não desfaz o registro da compra).
    expect(await vinculos(movs[0]!.produto_id)).toHaveLength(1);
    const de_novo = await movimentar(ids.nota03);
    expect(de_novo.status).toBe(422);
    expect(de_novo.body.mensagem).toMatch(/estornada não pode ser movimentada/);
    const outro = await estornar(ids.nota03, 'De novo');
    expect(outro.status).toBe(422);
    expect(outro.body.mensagem).toMatch(/já foi estornada/);
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'notas_entrada' and registro_id = $1 and acao = 'estornar'`,
      [ids.nota03],
    );
    expect(aud!.descricao).toMatch(/estornada \(2 movimento\(s\)\): Nota cancelada pelo emitente/);
  });

  it('o estorno que deixaria saldo negativo: 422 sem a permissão; o Master confirma a lista', async () => {
    // A cerveja saiu do estoque (230 de 240): estornar a segunda nota (120) deixaria -110.
    const a = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: ids.estoqueLoja1,
        motivo: 'Saída para o teste do estorno',
        tipoAjuste: 'saida',
        dataContagem: new Date().toISOString(),
        itens: [{ produtoId: ids.cerveja, quantidade: '230' }],
      });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const ef = await amb
      .http()
      .post(`/api/acertos/${a.body.id}/efetivar`)
      .set(bearer())
      .send({ versao: a.body.versao });
    expect(ef.status, JSON.stringify(ef.body)).toBe(200);
    expect((await saldo(ids.cerveja))!.quantidade).toBe('10.000');
    const negativo = {
      produtoId: ids.cerveja,
      nome: 'CERVEJA PILSEN LATA 350ML',
      lote: null,
      saldoAtual: '10.000',
      saldoFinal: '-110.000',
    };
    const recusa = await estornar(ids.nota01b, 'Devolvida', estoquista);
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(422);
    expect(recusa.body.campos?.confirmarNegativo).toBeUndefined();
    expect(recusa.body.detalhes.saldosNegativos).toEqual([negativo]);
    const pergunta = await estornar(ids.nota01b, 'Devolvida');
    expect(pergunta.status).toBe(422);
    expect(pergunta.body.campos.confirmarNegativo).toHaveLength(1);
    expect((await nota(ids.nota01b)).status).toBe('movimentada');
    const ok = await estornar(ids.nota01b, 'Devolvida', admin, {
      confirmarNegativo: pergunta.body.detalhes.saldosNegativos,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await saldo(ids.cerveja))!.quantidade).toBe('-110.000');
    const [aud] = await consultar<{ descricao: string; depois: Record<string, unknown> }>(
      emp.nomeBanco,
      `select descricao, depois from auditoria where entidade = 'notas_entrada' and registro_id = $1 and acao = 'estornar'`,
      [ids.nota01b],
    );
    expect(aud!.descricao).toMatch(/saldo negativo confirmado em: CERVEJA PILSEN LATA 350ML/);
    expect(aud!.depois).toEqual({ saldoNegativoConfirmado: true, saldosNegativos: [negativo] });
  });

  it('a nota ignorada e a com todos os itens ignorados não se movimentam; a pendente não se estorna', async () => {
    const variante = variarFixtureNfe('02-fcp-st.xml', {
      nNF: '777',
      cNF: '10203777',
      nProt: '135260000000777',
    });
    const id = await importar('02-segunda.xml', variante.xml);
    expect((await estornar(id, 'Teste')).body.mensagem).toMatch(/Só a nota movimentada/);
    const d = await nota(id);
    await vincular(
      id,
      d.itens.map((i) => ({ id: i.id, ignorado: true, motivoIgnorado: 'Bonificação' })),
    );
    const todos = await movimentar(id);
    expect(todos.status, JSON.stringify(todos.body)).toBe(422);
    expect(todos.body.mensagem).toMatch(/Todos os itens da nota estão ignorados/);
    const v = await nota(id);
    expect(
      (
        await amb
          .http()
          .post(`/api/notas-entrada/${id}/ignorar`)
          .set(bearer())
          .send({ versao: v.versao, motivo: 'Bonificação' })
      ).status,
    ).toBe(200);
    const ignorada = await movimentar(id);
    expect(ignorada.status).toBe(422);
    expect(ignorada.body.mensagem).toMatch(/ignorada: reabra/);
  });
});

describe('lotes do rastro (F2-Q7 = D48)', () => {
  it('o item em dois lotes entra em cada um com a sua parte; o estorno devolve cada lote', async () => {
    ids.nota07 = await importar('07-rastro-cd.xml');
    const d = await nota(ids.nota07);
    expect(d.itens.map((i) => i.lote)).toEqual(['L2610A', '0925X']);
    const iogurte = await produto('IOGURTE MORANGO 170G', {
      codigosBarras: [{ codigo: '7891000000410', principal: true }],
    });
    ids.iogurte = iogurte;
    const leite = await produto('LEITE INTEGRAL 1L', {
      codigosBarras: [{ codigo: '7891000000427', principal: true }],
    });
    const pronta = await confirmarSugestoes(ids.nota07);
    expect(pronta.itens.map((i) => i.quantidadeEstoque)).toEqual(['120.000', '120.000']);
    const r = await movimentar(ids.nota07, { atualizarPrecoCusto: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const movs = await movimentos(ids.nota07);
    // 20 FD × 6 = 120 do iogurte: 72 no L2610A e 48 no L2612B (o qLote do rastro); o leite num lote só.
    const lotes = await consultar<{ id: string; lote: string; validade: string; estoque_id: string | null }>(
      emp.nomeBanco,
      `select id, lote, validade::text, estoque_id from produtos_lotes where produto_id = any($1) order by lote`,
      [[iogurte, leite]],
    );
    const nomeLote = (id: string | null) => lotes.find((l) => l.id === id)?.lote;
    expect(movs.map((x) => [nomeLote(x.lote_id), x.quantidade, x.documento_item_id])).toEqual([
      ['L2610A', '72.000', d.itens[0]!.id],
      ['L2612B', '48.000', d.itens[0]!.id],
      ['0925X', '120.000', d.itens[1]!.id],
    ]);
    expect(lotes.map((l) => [l.lote, l.validade, l.estoque_id])).toEqual([
      ['0925X', '2027-01-23', null],
      ['L2610A', '2026-11-25', null],
      ['L2612B', '2026-11-27', null],
    ]);
    expect(await saldo(iogurte, ids.estoqueCd)).toMatchObject({ quantidade: '120.000' });
    const porLote = await consultar<{ lote: string; quantidade: string }>(
      emp.nomeBanco,
      `select l.lote, s.quantidade::text from saldos_lote s join produtos_lotes l on l.id = s.lote_id
        where s.produto_id = $1 order by l.lote`,
      [iogurte],
    );
    expect(porLote).toEqual([
      { lote: 'L2610A', quantidade: '72.000' },
      { lote: 'L2612B', quantidade: '48.000' },
    ]);
    // O item guarda o lote da primeira parte (o da vinculação).
    const m = r.body as Nota;
    expect(nomeLote(m.itens[0]!.loteId)).toBe('L2610A');
    expect(nomeLote(m.itens[1]!.loteId)).toBe('0925X');

    const e = await estornar(ids.nota07, 'Mercadoria devolvida');
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(
      (
        await consultar<{ quantidade: string }>(
          emp.nomeBanco,
          'select quantidade::text from saldos_lote where produto_id = $1 order by lote_id',
          [iogurte],
        )
      ).map((s) => s.quantidade),
    ).toEqual(['0.000', '0.000']);
    expect((await saldo(leite, ids.estoqueCd))!.quantidade).toBe('0.000');
  });

  it('o lote do rastro já cadastrado com outra data: a 2ª parte fica com a do cadastro; a 1ª é erro no item', async () => {
    const variante = variarFixtureNfe('07-rastro-cd.xml', {
      nNF: '4401',
      cNF: '10204401',
      nProt: '135260000004401',
    });
    const id = await importar('07-segunda.xml', variante.xml);
    await confirmarSugestoes(id);
    // O L2612B (a 2ª parte do iogurte, as datas do rastro: 27/11) foi cadastrado com 20/11; o L2610A (a 1ª parte, a
    // validade da vinculação: 25/11) com 24/11.
    const lote = (nome: string, validade: string) =>
      consultar(
        emp.nomeBanco,
        'update produtos_lotes set validade = $1 where produto_id = $2 and lote = $3',
        [validade, ids.iogurte, nome],
      );
    await lote('L2612B', '2026-11-20');
    await lote('L2610A', '2026-11-24');
    // Só a 1ª parte é erro (a validade que se corrige na aba); a 2ª não: a data dela não se edita na tela.
    const recusa = await movimentar(id, { atualizarPrecoCusto: false });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(422);
    expect(recusa.body.campos).toEqual({
      'itens.0.validade': ['O lote L2610A já está cadastrado com a validade 24/11/2026'],
    });
    expect(await movimentos(id)).toHaveLength(0);
    await lote('L2610A', '2026-11-25');
    const r = await movimentar(id, { atualizarPrecoCusto: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lotes = await consultar<{ lote: string; validade: string; quantidade: string }>(
      emp.nomeBanco,
      `select l.lote, l.validade::text, s.quantidade::text
         from produtos_lotes l join saldos_lote s on s.lote_id = l.id
        where l.produto_id = $1 order by l.lote`,
      [ids.iogurte],
    );
    expect(lotes).toEqual([
      { lote: 'L2610A', validade: '2026-11-25', quantidade: '72.000' },
      { lote: 'L2612B', validade: '2026-11-20', quantidade: '48.000' },
    ]);
    expect((await estornar(id, 'Teste do lote do rastro')).status).toBe(200);
  });

  it('o razão refaz as projeções idênticas (o db:recalcular-saldos)', async () => {
    const r = await conferirRazaoDoBanco(emp.nomeBanco);
    expect(r.movimentos).toBeGreaterThan(0);
  });
});
