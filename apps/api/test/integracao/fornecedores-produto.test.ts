/**
 * Fornecedores no produto e cadastro rápido de fornecedor (Fase 2, F2-B13; ERP 8.2.14, 13.3; MD 3.6.9; D49; README da
 * API › decisão 158), pela API do ERP. Os vínculos gravam com o produto (auditoria antes/depois, versão agregada), o
 * (fornecedor, código no fornecedor) é único entre os produtos: repetido em outro produto é 409 com o produto atual e
 * "mover vínculo" o traz (com auditoria no outro), repetido no mesmo produto é reaproveitado. O custo do fornecedor
 * só com `produtos.ver_custo`; o corpo sem `fornecedores` mantém os gravados. O cadastro rápido acha a pessoa pelo
 * CNPJ normalizado (com ou sem máscara) ou a cria, e dá a categoria Fornecedor a quem já existe; duas chamadas ao
 * mesmo tempo não duplicam a pessoa.
 */
import { completarCnpj } from '@genesis/shared';
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
let tokenAdmin: string;
/**
 * Estoquista do seed: `produtos.editar`, `pessoas.ver`, `pessoas.criar_fornecedor` e `pessoas.criar` (dono,
 * 05/11/2026), sem `produtos.ver_custo`, `pessoas.editar`, `pessoas.excluir`, `pessoas.importar` nem
 * `pessoas.editar_credito`.
 */
let tokenEstoquista: string;
/** Vendedor do seed: só `pessoas.ver` (nem criar nem editar pessoas). */
let tokenVendedor: string;
let un: string;

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });

/** CNPJ válido a partir de 12 dígitos e a mesma coisa com máscara. */
function cnpj(base12: string) {
  const c = completarCnpj(base12);
  return {
    limpo: c,
    mascara: `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`,
  };
}

const rapido = (corpo: Record<string, unknown>, token = tokenAdmin) =>
  amb.http().post('/api/pessoas/fornecedor-rapido').set(bearer(token)).send(corpo);

async function fornecedor(base12: string, nome: string): Promise<string> {
  const r = await rapido({ cpfCnpj: cnpj(base12).mascara, nome });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.pessoa.id as string;
}

async function criarProduto(nome: string, extra: Record<string, unknown> = {}, token = tokenAdmin) {
  return amb
    .http()
    .post('/api/produtos')
    .set(bearer(token))
    .send({ nome, unidadeId: un, precoVenda: '5', precoCusto: '2', ...extra });
}

type Vinculo = {
  id: string;
  fornecedorId: string;
  fornecedor: { nome: string; cpfCnpj: string | null; excluida: boolean };
  codigoFornecedor: string | null;
  eanFornecedor: string | null;
  unidadeCompra: string | null;
  fator: string;
  custoFornecedor: string | null;
  ultimoCusto: string | null;
  ultimaCompraEm: string | null;
  principal: boolean;
};

async function detalhe(produto: string, token = tokenAdmin) {
  const r = await amb.http().get(`/api/produtos/${produto}`).set(bearer(token));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Record<string, unknown> & { versao: number; fornecedores: Vinculo[] };
}

/** PUT com o que o formulário manda, trocando `fornecedores` quando informado (`undefined` = não manda). */
async function gravar(produto: string, fornecedores?: unknown[], token = tokenAdmin) {
  const d = await detalhe(produto, token);
  return amb
    .http()
    .put(`/api/produtos/${produto}`)
    .set(bearer(token))
    .send({
      nome: d.nome,
      unidadeId: un,
      precoVenda: d.precoVenda,
      ...(d.precoCusto !== null ? { precoCusto: d.precoCusto } : {}),
      versao: d.versao,
      ...(fornecedores !== undefined ? { fornecedores } : {}),
    });
}

const vinculosVivos = (produto: string) =>
  consultar<{ id: string; codigo_fornecedor: string | null; custo_fornecedor: string | null }>(
    emp.nomeBanco,
    `select id, codigo_fornecedor, custo_fornecedor::text from produtos_fornecedores
      where produto_id = $1 and excluido_em is null order by criado_em`,
    [produto],
  );

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  const loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista', lojas: [loja] });
  tokenEstoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja] });
  tokenVendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('cadastro rápido de fornecedor (F2-B13; ERP 3.4, 13.3)', () => {
  it('cria pela máscara e reaproveita pelo CNPJ sem máscara, sem duplicar a pessoa (critério de pronto)', async () => {
    const doc = cnpj('112223330001');
    const r = await rapido({
      cpfCnpj: doc.mascara,
      nome: 'Distribuidora X Ltda',
      apelido: 'Distribuidora X',
      rgIe: '9012345678',
      telefone: '(41) 3333-4444',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      criada: true,
      categoriaAdicionada: false,
      pessoa: { tipo: 'PJ', nome: 'Distribuidora X Ltda', cpfCnpj: doc.limpo, ativa: true },
    });
    const id = r.body.pessoa.id as string;

    const outra = await rapido({ cpfCnpj: doc.limpo, nome: 'Outro nome qualquer' });
    expect(outra.status, JSON.stringify(outra.body)).toBe(200);
    expect(outra.body).toMatchObject({ criada: false, categoriaAdicionada: false, pessoa: { id } });

    const linhas = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from pessoas where cpf_cnpj = $1 and excluido_em is null',
      [doc.limpo],
    );
    expect(linhas[0]!.n).toBe(1);
    // O nome não mudou, a IE ficou com o indicador de contribuinte e o telefone com o DDD.
    const p = (await amb.http().get(`/api/pessoas/${id}`).set(bearer())).body;
    expect(p).toMatchObject({
      nome: 'Distribuidora X Ltda',
      rgIe: '9012345678',
      indicadorIe: 'contribuinte',
      categorias: ['fornecedor'],
      origem: 'erp',
    });
    expect(p.telefones).toMatchObject([{ ddd: '41', numero: '33334444', principal: true }]);
    const auds = await consultar<{ acao: string }>(
      emp.nomeBanco,
      `select acao from auditoria where entidade = 'pessoas' and registro_id = $1`,
      [id],
    );
    expect(auds.map((a) => a.acao)).toEqual(['criar']);
  });

  it('dá a categoria Fornecedor a quem já existe como cliente, sem mudar o resto (exige pessoas.editar)', async () => {
    const doc = cnpj('223334440001');
    const cliente = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer())
      .send({ tipo: 'PJ', nome: 'Bar do Zé', cpfCnpj: doc.limpo, categorias: ['cliente'] });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);

    // Quem não cria nem edita pessoas (o vendedor do seed): 403, sem gravar.
    const negado = await rapido({ cpfCnpj: doc.mascara, nome: 'Bar do Zé' }, tokenVendedor);
    expect(negado.status, JSON.stringify(negado.body)).toBe(403);
    expect(negado.body.mensagem).toMatch(
      /"Pessoas: Cadastrar fornecedor", "Pessoas: Criar" ou "Pessoas: Editar"/,
    );

    const r = await rapido({ cpfCnpj: doc.mascara, nome: 'Nome diferente' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ criada: false, categoriaAdicionada: true, pessoa: { nome: 'Bar do Zé' } });
    const p = (await amb.http().get(`/api/pessoas/${cliente.body.id}`).set(bearer())).body;
    expect(p.categorias).toEqual(['cliente', 'fornecedor']);
    const [aud] = await consultar<{ acao: string; antes: unknown; depois: unknown }>(
      emp.nomeBanco,
      `select acao, antes, depois from auditoria where entidade = 'pessoas' and registro_id = $1 and acao = 'editar'`,
      [cliente.body.id],
    );
    expect(aud).toMatchObject({
      antes: { categorias: ['cliente'] },
      depois: { categorias: ['cliente', 'fornecedor'] },
    });

    // Já fornecedor: o estoquista a reaproveita (bastaria `pessoas.ver`).
    const deNovo = await rapido({ cpfCnpj: doc.limpo, nome: 'Qualquer' }, tokenEstoquista);
    expect(deNovo.status, JSON.stringify(deNovo.body)).toBe(200);
    expect(deNovo.body).toMatchObject({ criada: false, categoriaAdicionada: false });
  });

  it('criar exige pessoas.criar ou pessoas.criar_fornecedor; documento inválido, telefone sem DDD e endereço incompleto são 422', async () => {
    const negado = await rapido({ cpfCnpj: cnpj('334445550001').limpo, nome: 'Nova Ltda' }, tokenVendedor);
    expect(negado.status, JSON.stringify(negado.body)).toBe(403);
    expect(
      (
        await consultar<{ n: number }>(
          emp.nomeBanco,
          'select count(*)::int as n from pessoas where cpf_cnpj = $1',
          [cnpj('334445550001').limpo],
        )
      )[0]!.n,
    ).toBe(0);

    const ruim = await rapido({ cpfCnpj: '11.222.333/0001-00', nome: 'X', telefone: '3333-4444' });
    expect(ruim.status).toBe(422);
    expect(Object.keys(ruim.body.campos).sort()).toEqual(['cpfCnpj', 'nome', 'telefone']);

    const semEndereco = await rapido({
      cpfCnpj: cnpj('334445550001').limpo,
      nome: 'Nova Ltda',
      endereco: { cep: '80000000', uf: 'PR' },
    });
    expect(semEndereco.status).toBe(422);
    expect(semEndereco.body.campos).toHaveProperty(['endereco.logradouro']);

    // CPF: pessoa física, o campo de IE não vira RG.
    const pf = await rapido({ cpfCnpj: '529.982.247-25', nome: 'Produtor Rural', rgIe: '123' });
    expect(pf.status, JSON.stringify(pf.body)).toBe(200);
    expect(pf.body.pessoa).toMatchObject({ tipo: 'PF', cpfCnpj: '52998224725' });
    const p = (await amb.http().get(`/api/pessoas/${pf.body.pessoa.id}`).set(bearer())).body;
    expect(p).toMatchObject({ rgIe: null, indicadorIe: 'nao_contribuinte' });
  });

  it('o Estoquista do seed (pessoas.criar_fornecedor e pessoas.criar, sem pessoas.editar) cadastra o fornecedor e dá a categoria, sem editar o resto (decisão do dono de 05/11/2026)', async () => {
    // Novo: cria com a categoria Fornecedor.
    const novo = await rapido(
      { cpfCnpj: cnpj('121314150001').mascara, nome: 'Bebidas Sul Ltda' },
      tokenEstoquista,
    );
    expect(novo.status, JSON.stringify(novo.body)).toBe(200);
    expect(novo.body).toMatchObject({
      criada: true,
      categoriaAdicionada: false,
      pessoa: { nome: 'Bebidas Sul Ltda' },
    });

    // Já cliente: só ganha a categoria; nome, IE e o resto ficam como estavam.
    const doc = cnpj('131415160001');
    const cliente = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer())
      .send({
        tipo: 'PJ',
        nome: 'Mercado Bom Preço',
        cpfCnpj: doc.limpo,
        rgIe: '1234567890',
        categorias: ['cliente'],
      });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);
    const r = await rapido(
      { cpfCnpj: doc.mascara, nome: 'Outro nome', rgIe: '999', telefone: '41999998888' },
      tokenEstoquista,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      criada: false,
      categoriaAdicionada: true,
      pessoa: { nome: 'Mercado Bom Preço' },
    });
    const depois = (await amb.http().get(`/api/pessoas/${cliente.body.id}`).set(bearer())).body;
    expect(depois).toMatchObject({
      nome: 'Mercado Bom Preço',
      rgIe: '1234567890',
      categorias: ['cliente', 'fornecedor'],
      telefones: [],
    });
    // Editar a pessoa continua exigindo pessoas.editar.
    const editar = await amb
      .http()
      .put(`/api/pessoas/${cliente.body.id}`)
      .set(bearer(tokenEstoquista))
      .send({ ...depois, nome: 'Trocado' });
    expect(editar.status, JSON.stringify(editar.body)).toBe(403);
  });

  it('o Estoquista do seed faz o cadastro completo de pessoas (POST /pessoas), sem editar, excluir, importar nem mexer no crédito (decisão do dono de 05/11/2026; README da API › 168)', async () => {
    const corpo = {
      tipo: 'PF',
      nome: 'Fulano de Tal',
      cpfCnpj: '111.444.777-35',
      categorias: ['cliente', 'funcionario'],
      descontoPct: '5',
      senha: '480297',
      telefones: [{ numero: '(41) 99999-1234', principal: true }],
      emails: [{ email: 'fulano@exemplo.com', principal: true }],
      enderecos: [
        {
          tipo: 'principal',
          cep: '80010-000',
          logradouro: 'Rua XV de Novembro',
          numero: '100',
          bairro: 'Centro',
          uf: 'PR',
          municipioIbge: 4106902,
        },
      ],
    };
    // Limite de compras e bloqueio continuam com `pessoas.editar_credito`: nada é gravado.
    const comCredito = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer(tokenEstoquista))
      .send({ ...corpo, limiteCompras: '500,00' });
    expect(comCredito.status, JSON.stringify(comCredito.body)).toBe(403);

    const r = await amb.http().post('/api/pessoas').set(bearer(tokenEstoquista)).send(corpo);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      tipo: 'PF',
      nome: 'Fulano de Tal',
      cpfCnpj: '11144477735',
      categorias: ['cliente', 'funcionario'],
      limiteCompras: null,
    });
    expect(r.body.enderecos).toHaveLength(1);
    expect(r.body.telefones).toHaveLength(1);
    const [auditoria] = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from auditoria a join usuarios u on u.id = a.usuario_id
        where a.entidade = 'pessoas' and a.registro_id = $1 and a.acao = 'criar' and u.login = 'estoquista'`,
      [r.body.id],
    );
    expect(auditoria!.n).toBe(1);

    // Corrigir depois de gravado é `pessoas.editar`, excluir é `pessoas.excluir` e a planilha de clientes é
    // `pessoas.importar`: o perfil não tem nenhuma das três.
    const id = r.body.id as string;
    const editar = await amb
      .http()
      .put(`/api/pessoas/${id}`)
      .set(bearer(tokenEstoquista))
      .send({ ...corpo, versao: r.body.versao, nome: 'Trocado' });
    expect(editar.status, JSON.stringify(editar.body)).toBe(403);
    const excluir = await amb.http().delete(`/api/pessoas/${id}`).set(bearer(tokenEstoquista));
    expect(excluir.status, JSON.stringify(excluir.body)).toBe(403);
    const importar = await amb.http().get('/api/importacoes/clientes/modelo').set(bearer(tokenEstoquista));
    expect(importar.status, JSON.stringify(importar.body)).toBe(403);
    const depois = await amb.http().get(`/api/pessoas/${id}`).set(bearer());
    expect(depois.status).toBe(200);
    expect(depois.body).toMatchObject({ nome: 'Fulano de Tal', versao: r.body.versao });
  });

  it('duas chamadas ao mesmo tempo com o mesmo CNPJ criam uma pessoa só', async () => {
    const doc = cnpj('445556660001');
    const [a, b, c] = await Promise.all([
      rapido({ cpfCnpj: doc.mascara, nome: 'Concorrente A' }),
      rapido({ cpfCnpj: doc.limpo, nome: 'Concorrente B' }),
      rapido({ cpfCnpj: doc.limpo.toLowerCase(), nome: 'Concorrente C' }),
    ]);
    for (const r of [a, b, c]) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([a, b, c].filter((r) => r.body.criada)).toHaveLength(1);
    expect(new Set([a, b, c].map((r) => r.body.pessoa.id)).size).toBe(1);
  });
});

describe('fornecedores no produto (F2-B13; ERP 8.2.14; MD 3.6.9)', () => {
  let fornX: string;
  let fornY: string;

  beforeAll(async () => {
    fornX = await fornecedor('556667770001', 'Fornecedor X');
    fornY = await fornecedor('667778880001', 'Fornecedor Y');
  });

  it('liga o fornecedor X com o código "CX24-ABC" e o fator 24, e o Y sem código (critério de pronto)', async () => {
    const r = await criarProduto('CERV FORNECEDORES', {
      fornecedores: [
        { fornecedorId: fornY, unidadeCompra: 'fd', fator: '12', custoFornecedor: '3,10' },
        {
          fornecedorId: fornX,
          codigoFornecedor: ' CX24-ABC ',
          eanFornecedor: '17891234567892',
          unidadeCompra: 'CX',
          fator: '24',
          custoFornecedor: '2.95',
          principal: true,
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // O principal primeiro; último custo e última compra vazios (vêm da compra, F2-B15/F2-B21).
    expect(r.body.fornecedores).toMatchObject([
      {
        fornecedorId: fornX,
        // Sem o documento: o CNPJ/CPF só sai pela API de pessoas (pessoas.ver).
        fornecedor: { nome: 'Fornecedor X', cpfCnpj: null, excluida: false },
        codigoFornecedor: 'CX24-ABC',
        eanFornecedor: '17891234567892',
        unidadeCompra: 'CX',
        fator: '24.000',
        custoFornecedor: '2.9500',
        ultimoCusto: null,
        ultimaCompraEm: null,
        principal: true,
      },
      {
        fornecedorId: fornY,
        codigoFornecedor: null,
        unidadeCompra: 'FD',
        fator: '12.000',
        custoFornecedor: '3.1000',
      },
    ]);
    const [aud] = await consultar<{ depois: { fornecedores: unknown[] } }>(
      emp.nomeBanco,
      `select depois from auditoria where entidade = 'produtos' and registro_id = $1 and acao = 'criar'`,
      [r.body.id],
    );
    expect(aud!.depois.fornecedores).toHaveLength(2);

    // Gravar de novo o que veio (com os ids) não cria linhas; trocar o fator sobe a versão agregada e audita.
    const antes = await vinculosVivos(r.body.id);
    const d = await detalhe(r.body.id);
    const linhas = d.fornecedores.map((f) => ({ ...f, fator: f.codigoFornecedor ? '12' : f.fator }));
    const g = await gravar(r.body.id, linhas);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.versao).toBeGreaterThan(d.versao);
    expect((await vinculosVivos(r.body.id)).map((v) => v.id).sort()).toEqual(antes.map((v) => v.id).sort());
    expect(g.body.fornecedores[0]).toMatchObject({ codigoFornecedor: 'CX24-ABC', fator: '12.000' });
    const [ed] = await consultar<{ antes: { fornecedores: Vinculo[] } }>(
      emp.nomeBanco,
      `select antes from auditoria where entidade = 'produtos' and registro_id = $1 and acao = 'editar'`,
      [r.body.id],
    );
    expect(ed!.antes.fornecedores[0]).toMatchObject({ fator: '24.000' });
  });

  it('o mesmo código no mesmo produto é reaproveitado; em outro produto é 409, e "mover vínculo" o traz', async () => {
    const a = await criarProduto('PROD A VINCULO', {
      fornecedores: [
        { fornecedorId: fornX, codigoFornecedor: 'COD-A', fator: '6' },
        { fornecedorId: fornY, codigoFornecedor: 'COD-A9' },
      ],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const vinculoA = (await vinculosVivos(a.body.id)).find((v) => v.codigo_fornecedor === 'COD-A')!;

    // Mesmo produto, as linhas digitadas de novo (sem id): reaproveitadas, mesmas linhas, fator novo.
    const mesmo = await gravar(a.body.id, [
      { fornecedorId: fornX, codigoFornecedor: 'COD-A', fator: '8' },
      { fornecedorId: fornY, codigoFornecedor: 'COD-A9' },
    ]);
    expect(mesmo.status, JSON.stringify(mesmo.body)).toBe(200);
    const vivosA = await vinculosVivos(a.body.id);
    expect(vivosA).toHaveLength(2);
    expect(vivosA.find((v) => v.codigo_fornecedor === 'COD-A')!.id).toBe(vinculoA.id);

    // Outro produto: 409 com o produto atual, no campo de cada linha em conflito; nada gravado. `detalhes` traz o
    // primeiro conflito (o da mensagem) e a lista de todos (`DetalhesConflitoFornecedor`).
    const b = await criarProduto('PROD B VINCULO');
    expect(b.status).toBe(201);
    const conflito = await gravar(b.body.id, [
      { fornecedorId: fornY, codigoFornecedor: 'COD-A' },
      { fornecedorId: fornX, codigoFornecedor: 'COD-A', fator: '6' },
      { fornecedorId: fornY, codigoFornecedor: 'COD-A9' },
    ]);
    expect(conflito.status, JSON.stringify(conflito.body)).toBe(409);
    expect(conflito.body.codigo).toBe('CONFLITO');
    expect(conflito.body.mensagem).toContain('"COD-A" deste fornecedor');
    expect(conflito.body.mensagem).toContain(`${a.body.codigo} - PROD A VINCULO`);
    const ligado = [`Já ligado ao produto ${a.body.codigo} - PROD A VINCULO`];
    expect(conflito.body.campos).toEqual({
      'fornecedores.1.codigoFornecedor': ligado,
      'fornecedores.2.codigoFornecedor': ligado,
    });
    const produtoA = { id: a.body.id, codigo: a.body.codigo, nome: 'PROD A VINCULO' };
    expect(conflito.body.detalhes).toEqual({
      linha: 1,
      fornecedorId: fornX,
      codigoFornecedor: 'COD-A',
      produto: produtoA,
      conflitos: [
        { linha: 1, fornecedorId: fornX, codigoFornecedor: 'COD-A', produto: produtoA },
        { linha: 2, fornecedorId: fornY, codigoFornecedor: 'COD-A9', produto: produtoA },
      ],
    });
    expect(await vinculosVivos(b.body.id)).toEqual([]);

    // O estoquista tem produtos.editar: pode mover. O vínculo sai do A (auditoria lá) e entra no B.
    const movido = await gravar(
      b.body.id,
      [{ fornecedorId: fornX, codigoFornecedor: 'COD-A', fator: '6', moverVinculo: true }],
      tokenEstoquista,
    );
    expect(movido.status, JSON.stringify(movido.body)).toBe(200);
    expect(await vinculosVivos(a.body.id)).toMatchObject([{ codigo_fornecedor: 'COD-A9' }]);
    expect(await vinculosVivos(b.body.id)).toMatchObject([{ codigo_fornecedor: 'COD-A' }]);
    // A auditoria do A traz os vínculos vivos dele antes e depois (o que ficou, não uma lista vazia).
    const [aud] = await consultar<{
      descricao: string;
      antes: { fornecedores: Vinculo[] };
      depois: { fornecedores: Vinculo[] };
    }>(
      emp.nomeBanco,
      `select descricao, antes, depois from auditoria where entidade = 'produtos' and registro_id = $1
          and acao = 'editar' order by ocorrido_em desc limit 1`,
      [a.body.id],
    );
    expect(aud!.descricao).toBe(
      `Vínculo do fornecedor (código "COD-A") movido para o produto ${b.body.codigo} - PROD B VINCULO`,
    );
    expect(aud!.antes.fornecedores.map((f) => f.codigoFornecedor).sort()).toEqual(['COD-A', 'COD-A9']);
    expect(aud!.antes.fornecedores.find((f) => f.codigoFornecedor === 'COD-A')).toMatchObject({
      id: vinculoA.id,
      fator: '8.000',
    });
    expect(aud!.depois.fornecedores).toMatchObject([{ codigoFornecedor: 'COD-A9', fornecedorId: fornY }]);
  });

  it('mover o vínculo exige produtos.editar (altera o outro produto), também no POST', async () => {
    const a = await criarProduto('PROD C VINCULO', {
      fornecedores: [{ fornecedorId: fornX, codigoFornecedor: 'COD-C' }],
    });
    expect(a.status).toBe(201);
    // Estoquista sem produtos.editar (negada no usuário): cria produto, mas não altera o outro.
    const u = await criarUsuario(emp.nomeBanco, { login: 'socria', perfil: 'estoquista' });
    await consultar(
      emp.nomeBanco,
      "insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, 'produtos.editar', 'negar')",
      [u],
    );
    const token = await amb.entrar(emp.codigo, 'socria', SENHA_TESTE);
    const r = await criarProduto(
      'PROD D VINCULO',
      { fornecedores: [{ fornecedorId: fornX, codigoFornecedor: 'COD-C', moverVinculo: true }] },
      token,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.campos).toHaveProperty(['fornecedores.0.moverVinculo']);
    expect(await vinculosVivos(a.body.id)).toMatchObject([{ codigo_fornecedor: 'COD-C' }]);
  });

  it('troca os códigos entre duas linhas do mesmo produto sem colidir no índice único', async () => {
    const p = await criarProduto('PROD TROCA CODIGOS', {
      fornecedores: [
        { fornecedorId: fornY, codigoFornecedor: 'T1', fator: '1' },
        { fornecedorId: fornY, codigoFornecedor: 'T2', fator: '2' },
      ],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const d = await detalhe(p.body.id);
    const l1 = d.fornecedores.find((f) => f.codigoFornecedor === 'T1');
    const l2 = d.fornecedores.find((f) => f.codigoFornecedor === 'T2');
    const g = await gravar(p.body.id, [
      { ...l1, codigoFornecedor: 'T2' },
      { ...l2, codigoFornecedor: 'T1' },
    ]);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const depois = (await detalhe(p.body.id)).fornecedores;
    expect(depois.find((f) => f.id === l1!.id)).toMatchObject({ codigoFornecedor: 'T2', fator: '1.000' });
    expect(depois.find((f) => f.id === l2!.id)).toMatchObject({ codigoFornecedor: 'T1', fator: '2.000' });
  });

  it('o corpo sem fornecedores mantém os gravados; a lista vazia remove; excluir o produto libera o código', async () => {
    const p = await criarProduto('PROD MANTEM', {
      fornecedores: [{ fornecedorId: fornX, codigoFornecedor: 'COD-M' }],
    });
    expect(p.status).toBe(201);
    expect((await gravar(p.body.id)).status).toBe(200);
    expect(await vinculosVivos(p.body.id)).toHaveLength(1);
    expect((await gravar(p.body.id, [])).status).toBe(200);
    expect(await vinculosVivos(p.body.id)).toEqual([]);

    // Excluir o produto exclui os vínculos junto: não sobra vínculo vivo de produto excluído.
    const q = await criarProduto('PROD EXCLUIDO', {
      fornecedores: [{ fornecedorId: fornX, codigoFornecedor: 'COD-E' }],
    });
    expect(q.status).toBe(201);
    expect((await amb.http().delete(`/api/produtos/${q.body.id}`).set(bearer())).status).toBe(204);
    expect(await vinculosVivos(q.body.id)).toEqual([]);
    const r = await criarProduto('PROD HERDA CODIGO', {
      fornecedores: [{ fornecedorId: fornX, codigoFornecedor: 'COD-E' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('o custo do fornecedor só com produtos.ver_custo: o estoquista não o vê e não o apaga', async () => {
    const p = await criarProduto('PROD CUSTO FORN', {
      fornecedores: [{ fornecedorId: fornX, codigoFornecedor: 'COD-CUSTO', custoFornecedor: '4.5' }],
    });
    expect(p.status).toBe(201);
    const d = await detalhe(p.body.id, tokenEstoquista);
    expect(d.fornecedores[0]).toMatchObject({ custoFornecedor: null, ultimoCusto: null });
    // O estoquista grava a linha (sem custo) e uma nova com custo: o gravado fica, o novo é ignorado.
    const g = await gravar(
      p.body.id,
      [
        { ...d.fornecedores[0], fator: '3' },
        { fornecedorId: fornY, codigoFornecedor: 'COD-CUSTO-2', custoFornecedor: '9' },
      ],
      tokenEstoquista,
    );
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect((await vinculosVivos(p.body.id)).map((v) => [v.codigo_fornecedor, v.custo_fornecedor])).toEqual([
      ['COD-CUSTO', '4.5000'],
      ['COD-CUSTO-2', null],
    ]);
    // A auditoria registra o que ficou no banco, no formato do `antes`: o custo não "sumiu" nem "nasceu".
    const [aud] = await consultar<{
      antes: { fornecedores: Vinculo[] };
      depois: { fornecedores: Vinculo[] };
    }>(
      emp.nomeBanco,
      `select antes, depois from auditoria where entidade = 'produtos' and registro_id = $1 and acao = 'editar'
        order by ocorrido_em desc limit 1`,
      [p.body.id],
    );
    expect(aud!.antes.fornecedores).toMatchObject([
      { codigoFornecedor: 'COD-CUSTO', fator: '1.000', custoFornecedor: '4.5000' },
    ]);
    expect(aud!.depois.fornecedores).toMatchObject([
      {
        codigoFornecedor: 'COD-CUSTO',
        fator: '3.000',
        custoFornecedor: '4.5000',
        ultimoCusto: null,
        ultimaCompraEm: null,
        fornecedor: { nome: 'Fornecedor X', cpfCnpj: null },
      },
      { codigoFornecedor: 'COD-CUSTO-2', custoFornecedor: null },
    ]);
  });

  it('a pessoa que perdeu a categoria Fornecedor: a linha gravada continua gravável, a troca de pessoa não', async () => {
    const forn = await fornecedor('778889990001', 'Fornecedor Sem Categoria');
    const cliente = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer())
      .send({ nome: 'Cliente Troca', categorias: ['cliente'] });
    expect(cliente.status).toBe(201);
    const p = await criarProduto('PROD CATEGORIA PERDIDA', {
      fornecedores: [
        { fornecedorId: forn, codigoFornecedor: 'CP-1', principal: true },
        { fornecedorId: fornY, codigoFornecedor: 'CP-2' },
      ],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    // A categoria sai depois do vínculo (o cadastro de pessoas não confere os produtos).
    await consultar(
      emp.nomeBanco,
      `update pessoas_categorias set excluido_em = now() where pessoa_id = $1 and categoria = 'fornecedor'`,
      [forn],
    );
    const d = await detalhe(p.body.id);
    // Mudar só o fator da linha gravada (mesmo id, mesma pessoa): grava.
    const g = await gravar(
      p.body.id,
      d.fornecedores.map((f) => ({ ...f, fator: f.fornecedorId === forn ? '2' : f.fator })),
    );
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    // A linha nova com essa pessoa, ou a gravada do Y trocada para ela ou para um cliente, exige a categoria.
    const [deForn, deY] = [
      d.fornecedores.find((f) => f.fornecedorId === forn)!,
      d.fornecedores.find((f) => f.fornecedorId === fornY)!,
    ];
    const troca = await gravar(p.body.id, [
      { ...deForn, fornecedorId: cliente.body.id },
      { ...deY, fornecedorId: forn },
      { fornecedorId: forn, codigoFornecedor: 'CP-3' },
    ]);
    expect(troca.status, JSON.stringify(troca.body)).toBe(422);
    expect(troca.body.campos).toEqual({
      'fornecedores.0.fornecedorId': ['A pessoa não tem a categoria Fornecedor'],
      'fornecedores.1.fornecedorId': ['A pessoa não tem a categoria Fornecedor'],
      'fornecedores.2.fornecedorId': ['A pessoa não tem a categoria Fornecedor'],
    });
  });

  it('a pessoa excluída: os vínculos ficam, o detalhe a marca e o produto continua gravável; linha nova não', async () => {
    const forn = await fornecedor('889990000001', 'Distribuidora Duplicada');
    const p = await criarProduto('PROD FORN EXCLUIDO', {
      fornecedores: [{ fornecedorId: forn, codigoFornecedor: 'DUP-1', custoFornecedor: '1.5' }],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect((await amb.http().delete(`/api/pessoas/${forn}`).set(bearer())).status).toBe(204);

    const d = await detalhe(p.body.id);
    expect(d.fornecedores).toMatchObject([
      {
        fornecedorId: forn,
        codigoFornecedor: 'DUP-1',
        fornecedor: { nome: 'Distribuidora Duplicada', cpfCnpj: null, excluida: true },
      },
    ]);
    // Mudar só o preço, com a lista inteira (o bloco visível): grava, e o vínculo fica como estava.
    const vinculo = (await vinculosVivos(p.body.id))[0]!;
    const g = await amb.http().put(`/api/produtos/${p.body.id}`).set(bearer()).send({
      nome: d.nome,
      unidadeId: un,
      precoVenda: '6',
      precoCusto: d.precoCusto,
      versao: d.versao,
      fornecedores: d.fornecedores,
    });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(await vinculosVivos(p.body.id)).toEqual([vinculo]);

    // A pessoa excluída não entra em linha nova nem por troca de pessoa.
    const novo = await criarProduto('PROD FORN EXCLUIDO 2', {
      fornecedores: [{ fornecedorId: forn, codigoFornecedor: 'DUP-2' }],
    });
    expect(novo.status, JSON.stringify(novo.body)).toBe(422);
    expect(novo.body.campos).toEqual({
      'fornecedores.0.fornecedorId': ['Fornecedor excluído: remova a linha'],
    });
    const q = await criarProduto('PROD FORN TROCA', {
      fornecedores: [{ fornecedorId: fornY, codigoFornecedor: 'DUP-3' }],
    });
    expect(q.status).toBe(201);
    const dq = await detalhe(q.body.id);
    const troca = await gravar(q.body.id, [{ ...dq.fornecedores[0], fornecedorId: forn }]);
    expect(troca.status, JSON.stringify(troca.body)).toBe(422);
    expect(troca.body.campos).toEqual({
      'fornecedores.0.fornecedorId': ['Fornecedor excluído: remova a linha'],
    });
  });

  it('a ordem dos vínculos gravados juntos fica estável depois de editar um deles', async () => {
    const p = await criarProduto('PROD ORDEM FORN', {
      fornecedores: [
        { fornecedorId: fornY, codigoFornecedor: 'ORD-1' },
        { fornecedorId: fornY, codigoFornecedor: 'ORD-2' },
        { fornecedorId: fornY, codigoFornecedor: 'ORD-3' },
        { fornecedorId: fornX, codigoFornecedor: 'ORD-P', principal: true },
      ],
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const ordem = (await detalhe(p.body.id)).fornecedores.map((f) => f.id);
    expect((await detalhe(p.body.id)).fornecedores[0]!.codigoFornecedor).toBe('ORD-P');
    // Edita o código de cada um dos não principais (coluna do índice único: o UPDATE leva a linha para outra posição
    // física e outra entrada no índice): a grade não troca as linhas de lugar.
    for (const alvo of ordem.slice(1)) {
      const d = await detalhe(p.body.id);
      const g = await gravar(
        p.body.id,
        d.fornecedores.map((f) =>
          f.id === alvo ? { ...f, codigoFornecedor: `${f.codigoFornecedor}-E` } : f,
        ),
      );
      expect(g.status, JSON.stringify(g.body)).toBe(200);
      expect((await detalhe(p.body.id)).fornecedores.map((f) => f.id)).toEqual(ordem);
    }
  });

  it('valida: pessoa sem a categoria Fornecedor, inexistente, código repetido, dois principais e EAN', async () => {
    const cliente = await amb
      .http()
      .post('/api/pessoas')
      .set(bearer())
      .send({ nome: 'Só Cliente', categorias: ['cliente'] });
    expect(cliente.status).toBe(201);
    const r = await criarProduto('PROD INVALIDO', {
      fornecedores: [
        { fornecedorId: cliente.body.id, codigoFornecedor: 'Z1' },
        { fornecedorId: '0190f2a0-0000-7000-8000-000000000000', codigoFornecedor: 'Z2' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.campos).toEqual({
      'fornecedores.0.fornecedorId': ['A pessoa não tem a categoria Fornecedor'],
      'fornecedores.1.fornecedorId': ['Fornecedor inexistente: remova a linha'],
    });

    // Campos da linha: EAN com dígito errado e fator zero.
    const campos = await criarProduto('PROD INVALIDO', {
      fornecedores: [{ fornecedorId: fornY, eanFornecedor: '7891234567890', fator: '0' }],
    });
    expect(campos.status, JSON.stringify(campos.body)).toBe(422);
    expect(Object.keys(campos.body.campos).sort()).toEqual([
      'fornecedores.0.eanFornecedor',
      'fornecedores.0.fator',
    ]);

    // Regras da lista: o mesmo código duas vezes, o mesmo fornecedor sem código duas vezes, dois principais.
    const z = await criarProduto('PROD INVALIDO', {
      fornecedores: [
        { fornecedorId: fornX, codigoFornecedor: 'Z3', principal: true },
        { fornecedorId: fornX, codigoFornecedor: 'Z3', principal: true },
        { fornecedorId: fornY },
        { fornecedorId: fornY, eanFornecedor: '7891234567895' },
      ],
    });
    expect(z.status, JSON.stringify(z.body)).toBe(422);
    expect(z.body.campos).toEqual({
      fornecedores: ['Marque um fornecedor principal só'],
      'fornecedores.1.codigoFornecedor': ['Código repetido para o mesmo fornecedor (linha 1)'],
      'fornecedores.3.fornecedorId': [
        'Fornecedor repetido sem código (linha 3): informe o código no fornecedor',
      ],
    });
  });

  it('GET /produtos/tipos-habilitados leva geral.produto_usa_fornecedores (o bloco do formulário)', async () => {
    const antes = await amb.http().get('/api/produtos/tipos-habilitados').set(bearer(tokenEstoquista));
    expect(antes.status).toBe(200);
    expect(antes.body.usaFornecedores).toBe(false);
    const c = await amb
      .http()
      .put('/api/configuracoes')
      .set(bearer())
      .send({ lojaId: null, valores: { 'geral.produto_usa_fornecedores': true } });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const depois = await amb.http().get('/api/produtos/tipos-habilitados').set(bearer(tokenEstoquista));
    expect(depois.body.usaFornecedores).toBe(true);
  });
});
