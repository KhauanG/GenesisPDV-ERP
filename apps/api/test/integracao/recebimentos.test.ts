/**
 * Recebimento manual: schema, contratos e rascunho (Fase 2, F2-B14; ERP 13.3; MD 3.8.1; README da API › decisão 159),
 * pela API do ERP. O rascunho com 20 itens (fardos com o fator da embalagem de compra) é criado, editado e excluído com
 * auditoria e a versão do documento (409 com a versão velha); os totais saem da quantidade × preço de compra mais
 * frete e outras despesas menos o desconto; o "Cód. remessa" repetido para o mesmo fornecedor só avisa. Fora do
 * rascunho o documento é imutável (trigger) e a API recusa a edição; a loja e o estoque fora dos permitidos são 403 no
 * campo, e o recebimento de estoque não permitido não aparece (404 pelo id).
 */
import { completarCnpj } from '@genesis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

let amb: Ambiente;
let emp: EmpresaTeste;
let tokenAdmin: string;
/** Estoquista do seed só com a Loja 1 e o estoque dela (sem o CD nem a Loja 2). */
let tokenRestrito: string;
let un: string;
let loja1: string;
let loja2: string;
let estoqueLoja1: string;
let cd: string;
let fornecedorX: string;
let fornecedorY: string;
/** 20 produtos simples; os pares com fardo de 12 (embalagem de compra). */
const produtos: string[] = [];
const fardos = new Map<string, string>();

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });

async function fornecedor(base12: string, nome: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/pessoas/fornecedor-rapido')
    .set(bearer())
    .send({ cpfCnpj: completarCnpj(base12), nome });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.pessoa.id as string;
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

/** Fardo (DUN-14 interno) de compra com o fator dado, direto no banco. */
async function fardo(produtoId: string, codigo: string, fator: string, usaCompra = true): Promise<string> {
  const [c] = await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into produtos_codigos_barras (produto_id, codigo, tipo, fator, descricao, usa_venda, usa_compra,
                                          unidade_id)
     values ($1, $2, 'interno', $3, 'Fardo', false, $4, (select id from unidades_medida where sigla = 'FD'))
     returning id`,
    [produtoId, codigo, fator, usaCompra],
  );
  return c!.id;
}

/** Os 20 itens do critério de pronto: os pares em fardo de 12 a R$ 60,00, os ímpares avulsos a R$ 5,00. */
function itensCriterio() {
  return produtos.map((p, i) =>
    fardos.has(p)
      ? {
          produtoId: p,
          codigoBarrasId: fardos.get(p),
          fator: '12',
          quantidade: '10',
          precoCompra: '60',
          precoVenda: '8.90',
          markupPct: '74.5098',
          atualizarPreco: 'geral',
        }
      : { produtoId: p, quantidade: String(i + 1), precoCompra: '5.00' },
  );
}

const cabecalho = (extra: Record<string, unknown> = {}) => ({
  lojaId: loja1,
  fornecedorId: fornecedorX,
  dataRecebimento: '2026-11-01',
  codigoRemessa: 'NF 1234',
  valorFrete: '12.00',
  valorDesconto: '2.50',
  valorOutrasDespesas: '1.00',
  ...extra,
});

const criar = (corpo: Record<string, unknown>, token = tokenAdmin) =>
  amb.http().post('/api/recebimentos').set(bearer(token)).send(corpo);
const obter = (id: string, token = tokenAdmin) =>
  amb.http().get(`/api/recebimentos/${id}`).set(bearer(token));

type Item = {
  id: string;
  sequencia: number;
  produtoId: string;
  fator: string;
  quantidade: string;
  quantidadeEstoque: string;
  precoCompra: string;
  unidadeCompra: string | null;
  codigoBarrasId: string | null;
  valorTotal: string;
  custoUnitarioFinal: string;
};

const auditoria = (id: string) =>
  consultar<{ acao: string; loja_id: string | null }>(
    emp.nomeBanco,
    `select acao, loja_id from auditoria where entidade = 'recebimentos' and registro_id = $1 order by criado_em`,
    [id],
  );

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Petiscaria 2');
  const [l1] = await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [loja1],
  );
  estoqueLoja1 = l1!.estoque_id;
  const [d] = await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into estoques (nome, tipo) values ('CD - Estoque Ice Beer', 'deposito') returning id",
  );
  cd = d!.id;
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [estoqueLoja1],
  });
  tokenRestrito = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  fornecedorX = await fornecedor('112223330001', 'Distribuidora X Ltda');
  fornecedorY = await fornecedor('445556660001', 'Bebidas Y Ltda');
  for (let i = 0; i < 20; i++) {
    const p = await produto(`Cerveja ${String(i + 1).padStart(2, '0')} lata 350ml`);
    produtos.push(p);
    if (i % 2 === 0) fardos.set(p, await fardo(p, `CX24-${i}`, '12'));
  }
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('rascunho do recebimento (F2-B14; ERP 13.3)', () => {
  it('20 itens com fardos: cria, edita e exclui pela API, com auditoria e trava de versão (critério de pronto)', async () => {
    const r = await criar({ ...cabecalho(), itens: itensCriterio() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    expect(r.body).toMatchObject({
      status: 'rascunho',
      lojaId: loja1,
      // Sem estoque informado: o vinculado à loja; sem tipo: o padrão.
      estoqueId: estoqueLoja1,
      tipoEstoqueNome: 'Disponível',
      fornecedorId: fornecedorX,
      fornecedor: { nome: 'Distribuidora X Ltda' },
      dataRecebimento: '2026-11-01',
      codigoRemessa: 'NF 1234',
      qtdItens: 20,
      // 10 fardos × R$ 60,00 × 10 itens = 6.000,00; avulsos: 5,00 × (2 + 4 + … + 20) = 550,00.
      valorProdutos: '6550.00',
      valorFrete: '12.00',
      valorDesconto: '2.50',
      valorOutrasDespesas: '1.00',
      valorTotal: '6560.50',
      remessaRepetida: [],
      avisos: [],
    });
    expect(r.body.codigo).toBeGreaterThan(0);
    const itens = r.body.itens as Item[];
    expect(itens.map((i) => i.sequencia)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const primeiro = itens[0]!;
    expect(primeiro).toMatchObject({
      produtoId: produtos[0],
      codigoBarrasId: fardos.get(produtos[0]!),
      unidadeCompra: 'FD',
      fator: '12.000',
      quantidade: '10.000',
      quantidadeEstoque: '120.000',
      precoCompra: '60.0000',
      valorTotal: '600.00',
      // Rateio e custo final só ao movimentar (F2-B15).
      custoUnitarioFinal: '0.0000',
    });
    expect(itens[1]).toMatchObject({ unidadeCompra: 'UN', fator: '1.000', quantidadeEstoque: '2.000' });

    // Edita: tira os dois últimos, muda a quantidade do primeiro e acrescenta um item novo.
    const editados = itens.slice(0, 18).map((i, n) => ({
      ...itensCriterio()[n],
      id: i.id,
      ...(n === 0 ? { quantidade: '5' } : {}),
    }));
    const novo = await produto('Água mineral 500ml');
    const pu = await amb
      .http()
      .put(`/api/recebimentos/${id}`)
      .set(bearer())
      .send({
        ...cabecalho({ codigoRemessa: 'NF 1235', valorDesconto: '0' }),
        versao: r.body.versao,
        itens: [...editados, { produtoId: novo, quantidade: '24', precoCompra: '1.25' }],
      });
    expect(pu.status, JSON.stringify(pu.body)).toBe(200);
    expect(pu.body.versao).toBeGreaterThan(r.body.versao);
    const itensEditados = pu.body.itens as Item[];
    expect(itensEditados).toHaveLength(19);
    // O item mantido conserva o id e a sequência; o novo entra depois da maior já usada (inclusive as excluídas).
    expect(itensEditados[0]).toMatchObject({ id: primeiro.id, sequencia: 1, quantidadeEstoque: '60.000' });
    expect(itensEditados.at(-1)).toMatchObject({ produtoId: novo, sequencia: 21, valorTotal: '30.00' });
    expect(pu.body).toMatchObject({ codigoRemessa: 'NF 1235', qtdItens: 19 });
    const [excluidos] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from itens_recebimento where recebimento_id = $1 and excluido_em is not null',
      [id],
    );
    expect(excluidos!.n).toBe(2);

    // A versão velha é 409 com quem alterou.
    const velho = await amb
      .http()
      .put(`/api/recebimentos/${id}`)
      .set(bearer())
      .send({ ...cabecalho(), versao: r.body.versao, itens: itensCriterio() });
    expect(velho.status).toBe(409);
    expect(velho.body.codigo).toBe('CONFLITO_VERSAO');
    const delVelho = await amb.http().delete(`/api/recebimentos/${id}?versao=${r.body.versao}`).set(bearer());
    expect(delVelho.status).toBe(409);

    const del = await amb.http().delete(`/api/recebimentos/${id}?versao=${pu.body.versao}`).set(bearer());
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    expect((await obter(id)).status).toBe(404);
    const [vivos] = await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from itens_recebimento where recebimento_id = $1 and excluido_em is null',
      [id],
    );
    expect(vivos!.n).toBe(0);
    expect((await auditoria(id)).map((a) => a.acao)).toEqual(['criar', 'editar', 'excluir']);
    expect((await auditoria(id)).every((a) => a.loja_id === loja1)).toBe(true);
  });

  it('Cód. remessa repetido para o mesmo fornecedor só avisa; outro fornecedor e o estornado não contam', async () => {
    const a = await criar({ ...cabecalho({ codigoRemessa: 'REM-77' }), itens: itensCriterio().slice(0, 1) });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await criar({
      ...cabecalho({ codigoRemessa: ' rem-77 ' }),
      itens: itensCriterio().slice(1, 2),
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.remessaRepetida).toEqual([
      { id: a.body.id, codigo: a.body.codigo, dataRecebimento: '2026-11-01', status: 'rascunho' },
    ]);
    expect(b.body.avisos[0]).toContain(`Nº ${a.body.codigo}`);
    // O primeiro também passa a avisar (a repetição vale nos dois sentidos).
    expect((await obter(a.body.id)).body.remessaRepetida).toHaveLength(1);
    const c = await criar({
      ...cabecalho({ codigoRemessa: 'REM-77', fornecedorId: fornecedorY }),
      itens: itensCriterio().slice(0, 1),
    });
    expect(c.body.remessaRepetida).toEqual([]);
    // Estornado não conta (a remessa pode entrar de novo): o estado vem do banco, o estorno é do F2-B15.
    await consultar(
      emp.nomeBanco,
      `update recebimentos set status = 'estornado', movimentado_em = now(), estornado_em = now(),
              motivo_estorno = 'teste' where id = $1`,
      [a.body.id],
    );
    expect((await obter(b.body.id)).body.remessaRepetida).toEqual([]);
  });

  it('valida fornecedor, produto, embalagem, desconto, data e lote', async () => {
    const [semCategoria] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into pessoas (nome, tipo) values ('Cliente qualquer', 'PF') returning id",
    );
    const r1 = await criar({ ...cabecalho({ fornecedorId: semCategoria!.id }), itens: [] });
    expect(r1.status).toBe(422);
    expect(r1.body.campos.fornecedorId[0]).toContain('não é fornecedor');

    const combo = await produto('Combo churrasco', {
      tipo: 'kit',
      componentes: [{ tipo: 'kit', componenteId: produtos[1], quantidade: '2' }],
    });
    const r2 = await criar({
      ...cabecalho(),
      itens: [{ produtoId: combo, quantidade: '1', precoCompra: '10' }],
    });
    expect(r2.status, JSON.stringify(r2.body)).toBe(422);
    expect(r2.body.campos['itens.0.produtoId'][0]).toContain('Combo');

    // Embalagem com outro fator, de outro produto e sem "usa na compra".
    const venda = await fardo(produtos[1]!, 'SO-VENDA', '6', false);
    const r3 = await criar({
      ...cabecalho(),
      itens: [
        {
          produtoId: produtos[0],
          codigoBarrasId: fardos.get(produtos[0]!),
          fator: '6',
          quantidade: '1',
          precoCompra: '1',
        },
        {
          produtoId: produtos[2],
          codigoBarrasId: fardos.get(produtos[0]!),
          fator: '12',
          quantidade: '1',
          precoCompra: '1',
        },
        { produtoId: produtos[1], codigoBarrasId: venda, fator: '6', quantidade: '1', precoCompra: '1' },
      ],
    });
    expect(r3.status).toBe(422);
    expect(r3.body.campos['itens.0.fator'][0]).toContain('12');
    expect(r3.body.campos['itens.1.codigoBarrasId'][0]).toContain('não é deste produto');
    expect(r3.body.campos['itens.2.codigoBarrasId'][0]).toContain('compra');

    const r4 = await criar({
      ...cabecalho({ valorDesconto: '700', valorFrete: '0', valorOutrasDespesas: '0' }),
      itens: [{ produtoId: produtos[1], quantidade: '100', precoCompra: '5' }],
    });
    expect(r4.status).toBe(422);
    expect(r4.body.campos.valorDesconto).toBeDefined();

    const r5 = await criar({ ...cabecalho({ dataRecebimento: '2099-01-01' }), itens: [] });
    expect(r5.status).toBe(422);
    expect(r5.body.campos.dataRecebimento[0]).toContain('futura');

    // "Tem prazo de validade" e o produto que pede lote exigem lote e validade.
    const r6 = await criar({
      ...cabecalho({ temValidade: true }),
      itens: [{ produtoId: produtos[1], quantidade: '1', precoCompra: '5' }],
    });
    expect(r6.status).toBe(422);
    expect(Object.keys(r6.body.campos)).toEqual(expect.arrayContaining(['itens.0.lote', 'itens.0.validade']));
    await consultar(emp.nomeBanco, 'update produtos set solicita_lote_pdv = true where id = $1', [
      produtos[3],
    ]);
    const r7 = await criar({
      ...cabecalho(),
      itens: [{ produtoId: produtos[3], quantidade: '1', precoCompra: '5' }],
    });
    expect(r7.status).toBe(422);
    expect(r7.body.campos['itens.0.lote']).toBeDefined();
    const r8 = await criar({
      ...cabecalho(),
      itens: [
        {
          produtoId: produtos[3],
          quantidade: '1',
          precoCompra: '5',
          lote: 'L2026-11',
          validade: '2027-05-01',
          fabricacao: '2026-10-01',
        },
      ],
    });
    expect(r8.status, JSON.stringify(r8.body)).toBe(201);
    expect(r8.body.itens[0]).toMatchObject({ lote: 'L2026-11', validade: '2027-05-01', loteId: null });
  });

  it('fora do rascunho: a API recusa e o trigger protege cabeçalho e itens (liberadas só as colunas do estorno)', async () => {
    const r = await criar({ ...cabecalho({ codigoRemessa: 'IMUT-1' }), itens: itensCriterio().slice(0, 3) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    const itemId = (r.body.itens as Item[])[0]!.id;
    // A movimentação é do F2-B15: aqui o status muda direto no banco, a partir do rascunho (o OLD aberto deixa).
    await consultar(
      emp.nomeBanco,
      "update recebimentos set status = 'movimentado', movimentado_em = now() where id = $1",
      [id],
    );
    const d = (await obter(id)).body;
    const pu = await amb
      .http()
      .put(`/api/recebimentos/${id}`)
      .set(bearer())
      .send({ ...cabecalho(), versao: d.versao, itens: [] });
    expect(pu.status).toBe(422);
    expect(pu.body.codigo).toBe('REGRA_NEGOCIO');
    expect((await amb.http().delete(`/api/recebimentos/${id}`).set(bearer())).status).toBe(422);

    await expect(
      consultar(emp.nomeBanco, 'update recebimentos set valor_frete = 99 where id = $1', [id]),
    ).rejects.toMatchObject({ code: 'P0001', message: 'DOCUMENTO_IMUTAVEL' });
    await expect(
      consultar(emp.nomeBanco, 'update itens_recebimento set quantidade = 99 where id = $1', [itemId]),
    ).rejects.toMatchObject({ code: 'P0001', message: 'DOCUMENTO_IMUTAVEL' });
    await expect(
      consultar(
        emp.nomeBanco,
        `insert into itens_recebimento (recebimento_id, sequencia, produto_id, quantidade, quantidade_estoque,
                                        preco_compra)
         values ($1, 99, $2, 1, 1, 1)`,
        [id, produtos[0]],
      ),
    ).rejects.toMatchObject({ code: 'P0001', message: 'DOCUMENTO_IMUTAVEL' });
    // O estorno mexe só nas colunas dele.
    await consultar(
      emp.nomeBanco,
      `update recebimentos set status = 'estornado', estornado_em = now(), motivo_estorno = 'Entrada em dobro'
        where id = $1`,
      [id],
    );
    await expect(
      consultar(
        emp.nomeBanco,
        "update recebimentos set motivo_estorno = 'outro', observacoes = 'x' where id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ message: 'DOCUMENTO_IMUTAVEL' });
    // Os CHECKs do MD 3.8.1.
    await expect(
      consultar(
        emp.nomeBanco,
        "update recebimentos set status = 'aberto' where status = 'rascunho' and id = $1",
        [(await criar({ ...cabecalho({ codigoRemessa: null }), itens: [] })).body.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      consultar(
        emp.nomeBanco,
        `insert into itens_recebimento (recebimento_id, sequencia, produto_id, quantidade, quantidade_estoque,
                                        preco_compra, atualizar_preco)
         values ((select id from recebimentos where status = 'rascunho' limit 1), 98, $1, 0, 0, 1, 'nao')`,
        [produtos[0]],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('loja e estoque fora dos permitidos são 403 no campo; o recebimento do CD não aparece para o restrito', async () => {
    // O restrito grava na Loja 1, no estoque dela.
    const meu = await criar(
      { ...cabecalho({ codigoRemessa: 'R-1' }), itens: itensCriterio().slice(0, 1) },
      tokenRestrito,
    );
    expect(meu.status, JSON.stringify(meu.body)).toBe(201);
    // CD (estoque sem loja, fora dos permitidos dele): 403 no campo.
    const noCd = await criar({ ...cabecalho({ estoqueId: cd }), itens: [] }, tokenRestrito);
    expect(noCd.status).toBe(403);
    expect(noCd.body.campos.estoqueId).toBeDefined();
    // Loja 2 (fora das lojas dele): 403 no campo da loja.
    const naLoja2 = await criar(
      { ...cabecalho({ lojaId: loja2, estoqueId: estoqueLoja1 }), itens: [] },
      tokenRestrito,
    );
    expect(naLoja2.status).toBe(403);
    expect(naLoja2.body.campos.lojaId).toBeDefined();

    // O admin recebe no CD com a nota em nome da Loja 1 (F2-Q3: o destinatário e o destino são independentes).
    const doCd = await criar({
      ...cabecalho({ estoqueId: cd, codigoRemessa: 'CD-1' }),
      itens: itensCriterio().slice(0, 2),
    });
    expect(doCd.status, JSON.stringify(doCd.body)).toBe(201);
    expect(doCd.body).toMatchObject({ estoqueId: cd, estoqueNome: 'CD - Estoque Ice Beer', lojaId: loja1 });
    const id = doCd.body.id as string;
    expect((await obter(id, tokenRestrito)).status).toBe(404);
    const pu = await amb
      .http()
      .put(`/api/recebimentos/${id}`)
      .set(bearer(tokenRestrito))
      .send({ ...cabecalho(), versao: doCd.body.versao, itens: [] });
    expect(pu.status).toBe(404);
    expect((await amb.http().delete(`/api/recebimentos/${id}`).set(bearer(tokenRestrito))).status).toBe(404);
    const lista = await amb.http().get('/api/recebimentos?tamanho=50').set(bearer(tokenRestrito));
    expect(lista.status).toBe(200);
    const estoques = new Set((lista.body.itens as Array<{ estoqueId: string }>).map((x) => x.estoqueId));
    expect([...estoques]).toEqual([estoqueLoja1]);
    // Mudar o rascunho dele para o CD também é 403.
    const mover = await amb
      .http()
      .put(`/api/recebimentos/${meu.body.id}`)
      .set(bearer(tokenRestrito))
      .send({ ...cabecalho({ estoqueId: cd }), versao: meu.body.versao, itens: [] });
    expect(mover.status).toBe(403);
  });

  it('listagem: filtros de fornecedor, Id, remessa, estoque, loja, período e situação; ordenação', async () => {
    const base = await criar({
      ...cabecalho({ codigoRemessa: 'FILTRO-ABC', dataRecebimento: '2026-10-15', fornecedorId: fornecedorY }),
      itens: itensCriterio().slice(0, 1),
    });
    expect(base.status).toBe(201);
    // O do CD e o estornado são criados aqui: os filtros não dependem do que os testes anteriores deixaram.
    const doCd = await criar({
      ...cabecalho({ codigoRemessa: 'FILTRO-CD', estoqueId: cd, fornecedorId: fornecedorY }),
      itens: itensCriterio().slice(0, 1),
    });
    expect(doCd.status, JSON.stringify(doCd.body)).toBe(201);
    const estornado = await criar({ ...cabecalho({ codigoRemessa: 'FILTRO-EST' }), itens: [] });
    expect(estornado.status).toBe(201);
    await consultar(
      emp.nomeBanco,
      `update recebimentos set status = 'estornado', movimentado_em = now(), estornado_em = now(),
              motivo_estorno = 'teste' where id = $1`,
      [estornado.body.id],
    );
    const listar = async (q: string) => {
      const r = await amb.http().get(`/api/recebimentos?tamanho=50&${q}`).set(bearer());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { total: number; itens: Array<Record<string, unknown>> };
    };
    const porRemessa = await listar('codigoRemessa=filtro-a');
    expect(porRemessa.itens.map((i) => i.id)).toEqual([base.body.id]);
    expect(porRemessa.itens[0]).toMatchObject({
      codigo: base.body.codigo,
      fornecedorNome: 'Bebidas Y Ltda',
      lojaNome: 'Loja 1 - Centro',
      estoqueId: estoqueLoja1,
      qtdItens: 1,
      valorTotal: '610.50',
      status: 'rascunho',
      dataRecebimento: '2026-10-15',
    });
    expect((await listar(`codigo=${base.body.codigo}`)).total).toBe(1);
    // Cada filtro traz o esperado (o `every` sozinho passaria com a lista vazia) e só ele.
    const porFornecedor = (await listar(`fornecedorId=${fornecedorY}`)).itens;
    expect(porFornecedor.map((i) => i.id)).toEqual(expect.arrayContaining([base.body.id, doCd.body.id]));
    expect(porFornecedor.every((i) => i.fornecedorId === fornecedorY)).toBe(true);
    expect((await listar('dataInicial=2026-10-01&dataFinal=2026-10-31')).itens.map((i) => i.id)).toEqual([
      base.body.id,
    ]);
    const noCd = (await listar(`estoqueId=${cd}`)).itens;
    expect(noCd.map((i) => i.id)).toContain(doCd.body.id);
    expect(noCd.every((i) => i.estoqueId === cd)).toBe(true);
    expect((await listar(`lojaId=${loja2}`)).total).toBe(0);
    const estornados = (await listar('status=estornado')).itens;
    expect(estornados.map((i) => i.id)).toContain(estornado.body.id);
    expect(estornados.every((i) => i.status === 'estornado')).toBe(true);
    expect((await listar('status=rascunho')).itens.map((i) => i.id)).not.toContain(estornado.body.id);
    // A data impossível no filtro é 422 (não o 22008 do `::date`, que sairia 500).
    const impossivel = await amb.http().get('/api/recebimentos?dataInicial=2026-02-30').set(bearer());
    expect(impossivel.status).toBe(422);
    const porTotal = await listar('ordenar=total:desc');
    const totais = porTotal.itens.map((i) => Number(i.valorTotal));
    expect(totais).toEqual([...totais].sort((a, b) => b - a));
    const ruim = await amb.http().get('/api/recebimentos?ordenar=custo:asc').set(bearer());
    expect(ruim.status).toBe(422);
  });

  it('sem recebimentos.criar é 403; sem recebimentos.ver também', async () => {
    await criarUsuario(emp.nomeBanco, { login: 'vendedor_rec', perfil: 'vendedor', lojas: [loja1] });
    const tk = await amb.entrar(emp.codigo, 'vendedor_rec', SENHA_TESTE);
    expect((await amb.http().get('/api/recebimentos').set(bearer(tk))).status).toBe(403);
    expect((await criar({ ...cabecalho(), itens: [] }, tk)).status).toBe(403);
  });

  it('só recebimentos.ver: consulta, mas criar, alterar e excluir são 403 (o rascunho fica como estava)', async () => {
    const [perfil] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome, descricao, chave_sistema) values ('Só vê recebimentos', 'teste', 'teste_ver_receb') returning id",
    );
    await consultar(
      emp.nomeBanco,
      "insert into perfis_permissoes (perfil_id, permissao) values ($1, 'recebimentos.ver')",
      [perfil!.id],
    );
    await criarUsuario(emp.nomeBanco, { login: 'so_ver_rec', perfil: 'teste_ver_receb', lojas: [loja1] });
    const tk = await amb.entrar(emp.codigo, 'so_ver_rec', SENHA_TESTE);
    const r = await criar({ ...cabecalho({ codigoRemessa: 'SO-VER' }), itens: itensCriterio().slice(0, 1) });
    expect(r.status).toBe(201);
    expect((await obter(r.body.id, tk)).status).toBe(200);
    expect((await criar({ ...cabecalho(), itens: [] }, tk)).status).toBe(403);
    const pu = await amb
      .http()
      .put(`/api/recebimentos/${r.body.id}`)
      .set(bearer(tk))
      .send({ ...cabecalho({ codigoRemessa: 'TOMADO' }), versao: r.body.versao, itens: [] });
    expect(pu.status).toBe(403);
    expect((await amb.http().delete(`/api/recebimentos/${r.body.id}`).set(bearer(tk))).status).toBe(403);
    expect((await obter(r.body.id)).body).toMatchObject({ codigoRemessa: 'SO-VER', qtdItens: 1 });
  });
});

describe('correções do rascunho (F2-B14, revisão)', () => {
  it('o rascunho de outra loja no estoque compartilhado se vê, mas não se exclui nem se toma trocando a loja', async () => {
    // Tem o CD (e o estoque da Loja 1) para movimentar, mas só a Loja 1.
    await criarUsuario(emp.nomeBanco, {
      login: 'estoquista_cd',
      perfil: 'estoquista',
      lojas: [loja1],
      estoques: [estoqueLoja1, cd],
    });
    const tk = await amb.entrar(emp.codigo, 'estoquista_cd', SENHA_TESTE);
    const daLoja2 = await criar({
      ...cabecalho({ lojaId: loja2, estoqueId: cd, codigoRemessa: 'P2-CD' }),
      itens: itensCriterio().slice(0, 1),
    });
    expect(daLoja2.status, JSON.stringify(daLoja2.body)).toBe(201);
    const id = daLoja2.body.id as string;
    // Ver é pelo estoque (D45).
    expect((await obter(id, tk)).status).toBe(200);
    const excluir = await amb.http().delete(`/api/recebimentos/${id}`).set(bearer(tk));
    expect(excluir.status).toBe(403);
    expect(excluir.body.mensagem).toContain('loja');
    const tomar = await amb
      .http()
      .put(`/api/recebimentos/${id}`)
      .set(bearer(tk))
      .send({ ...cabecalho({ lojaId: loja1, estoqueId: cd }), versao: daLoja2.body.versao, itens: [] });
    expect(tomar.status).toBe(403);
    expect((await obter(id)).body).toMatchObject({ lojaId: loja2, qtdItens: 1, codigoRemessa: 'P2-CD' });
    expect((await auditoria(id)).map((a) => a.acao)).toEqual(['criar']);
    // O da Loja 1 no CD ele altera e exclui normalmente.
    const meu = await criar({ ...cabecalho({ estoqueId: cd, codigoRemessa: 'L1-CD' }), itens: [] }, tk);
    expect(meu.status, JSON.stringify(meu.body)).toBe(201);
    expect(
      (await amb.http().delete(`/api/recebimentos/${meu.body.id}?versao=${meu.body.versao}`).set(bearer(tk)))
        .status,
    ).toBe(204);
  });

  it('o mesmo item duas vezes no PUT é 422; os totais do cabeçalho fecham com os itens gravados', async () => {
    const r = await criar({ ...cabecalho({ codigoRemessa: 'DUP' }), itens: itensCriterio().slice(1, 2) });
    expect(r.status).toBe(201);
    const x = (r.body.itens as Item[])[0]!;
    const linha = (quantidade: string) => ({
      id: x.id,
      produtoId: x.produtoId,
      quantidade,
      precoCompra: '60',
    });
    const pu = await amb
      .http()
      .put(`/api/recebimentos/${r.body.id}`)
      .set(bearer())
      .send({
        ...cabecalho({ codigoRemessa: 'DUP' }),
        versao: r.body.versao,
        itens: [linha('10'), linha('5')],
      });
    expect(pu.status).toBe(422);
    expect(Object.keys(pu.body.campos)).toEqual(['itens.1.id']);
    // A soma do cabeçalho sai das linhas vivas: frete 12 + outras 1 − desconto 2,50 sobre 2 × 5,00.
    const [cab] = await consultar<{
      qtd_itens: number;
      valor_produtos: string;
      valor_total: string;
      soma: string;
    }>(
      emp.nomeBanco,
      `select r.qtd_itens, r.valor_produtos::text, r.valor_total::text, (select sum(i.valor_total)::text
          from itens_recebimento i where i.recebimento_id = r.id and i.excluido_em is null) as soma
         from recebimentos r where r.id = $1`,
      [r.body.id],
    );
    expect(cab).toMatchObject({ qtd_itens: 1, valor_produtos: '10.00', valor_total: '20.50', soma: '10.00' });
  });

  it('data e fabricação: "hoje" e "não futura" no fuso da loja destinatária (ERP 1.5)', async () => {
    // Kiritimati (UTC+14) e Pago Pago (UTC−11): sempre um dia de diferença entre as duas.
    const adiantada = await criarLoja(emp.nomeBanco, 7, 'Loja Kiritimati');
    const atrasada = await criarLoja(emp.nomeBanco, 8, 'Loja Pago Pago');
    await consultar(emp.nomeBanco, "update lojas set fuso_horario = 'Pacific/Kiritimati' where id = $1", [
      adiantada,
    ]);
    await consultar(emp.nomeBanco, "update lojas set fuso_horario = 'Pacific/Pago_Pago' where id = $1", [
      atrasada,
    ]);
    const [d] = await consultar<{ kiri: string; pago: string }>(
      emp.nomeBanco,
      `select (now() at time zone 'Pacific/Kiritimati')::date::text as kiri,
              (now() at time zone 'Pacific/Pago_Pago')::date::text as pago`,
    );
    // Data vazia = hoje na loja.
    const vazia = await criar({ ...cabecalho({ lojaId: adiantada, dataRecebimento: '' }), itens: [] });
    expect(vazia.status, JSON.stringify(vazia.body)).toBe(201);
    expect(vazia.body.dataRecebimento).toBe(d!.kiri);
    const vaziaAtrasada = await criar({
      ...cabecalho({ lojaId: atrasada, dataRecebimento: null }),
      itens: [],
    });
    expect(vaziaAtrasada.body.dataRecebimento).toBe(d!.pago);
    // O dia de Kiritimati já é hoje lá (aceito) e ainda é futuro em Pago Pago (recusado).
    expect(
      (await criar({ ...cabecalho({ lojaId: adiantada, dataRecebimento: d!.kiri }), itens: [] })).status,
    ).toBe(201);
    const futura = await criar({ ...cabecalho({ lojaId: atrasada, dataRecebimento: d!.kiri }), itens: [] });
    expect(futura.status).toBe(422);
    expect(futura.body.campos.dataRecebimento[0]).toContain('futura');
    // A fabricação segue a mesma régua, no item.
    const fab = (lojaId: string) =>
      criar({
        ...cabecalho({ lojaId, dataRecebimento: d!.pago }),
        itens: [{ ...itensCriterio()[1]!, lote: 'L-FUSO', validade: '2030-01-31', fabricacao: d!.kiri }],
      });
    expect((await fab(adiantada)).status).toBe(201);
    const fabFutura = await fab(atrasada);
    expect(fabFutura.status).toBe(422);
    expect(fabFutura.body.campos).toEqual({ 'itens.0.fabricacao': ['A fabricação não pode ser futura'] });
    // No PUT também: a mesma data, que era de hoje na Kiritimati, fica futura ao trocar para Pago Pago.
    const pu = await amb
      .http()
      .put(`/api/recebimentos/${vazia.body.id}`)
      .set(bearer())
      .send({
        ...cabecalho({ lojaId: atrasada, dataRecebimento: d!.kiri }),
        versao: vazia.body.versao,
        itens: [],
      });
    expect(pu.status).toBe(422);
    expect(Object.keys(pu.body.campos)).toEqual(['dataRecebimento']);
  });

  it('o produto excluído depois de entrar no rascunho continua no detalhe, e o item pode sair', async () => {
    const p = await produto('Cerveja excluída lata 350ml');
    const r = await criar({
      ...cabecalho({ codigoRemessa: 'EXCL' }),
      itens: [itensCriterio()[1]!, { produtoId: p, quantidade: '2', precoCompra: '3' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // Sem saldo e sem ser componente: a exclusão do produto passa.
    expect((await amb.http().delete(`/api/produtos/${p}`).set(bearer())).status).toBe(204);
    const d = await obter(r.body.id);
    expect(d.status).toBe(200);
    const itens = d.body.itens as Array<Item & { produto: { id: string; nome: string } }>;
    expect(itens[1]!.produto).toMatchObject({ id: p, nome: 'Cerveja excluída lata 350ml' });
    // Regravar sem o item excluído.
    const pu = await amb
      .http()
      .put(`/api/recebimentos/${r.body.id}`)
      .set(bearer())
      .send({
        ...cabecalho({ codigoRemessa: 'EXCL' }),
        versao: d.body.versao,
        itens: [{ ...itensCriterio()[1]!, id: itens[0]!.id }],
      });
    expect(pu.status, JSON.stringify(pu.body)).toBe(200);
    expect(pu.body.qtdItens).toBe(1);
  });

  it('o tipo de estoque com recebimento em rascunho não se inativa; com recebimento, não se exclui', async () => {
    const novoTipo = async (nome: string) => {
      const t = await amb.http().post('/api/tipos-estoque').set(bearer()).send({ nome });
      expect(t.status, JSON.stringify(t.body)).toBe(201);
      return t.body.id as string;
    };
    const alterarTipo = async (tipoId: string, ativo: boolean) => {
      const atual = (await amb.http().get(`/api/tipos-estoque/${tipoId}`).set(bearer())).body;
      return amb.http().put(`/api/tipos-estoque/${tipoId}`).set(bearer()).send({
        nome: atual.nome,
        vendavel: atual.vendavel,
        padrao: atual.padrao,
        ativo,
        versao: atual.versao,
      });
    };
    const excluirTipo = (tipoId: string) => amb.http().delete(`/api/tipos-estoque/${tipoId}`).set(bearer());
    const avaria = await novoTipo('Avaria de recebimento');
    const r = await criar({
      ...cabecalho({ tipoEstoqueId: avaria, codigoRemessa: 'TIPO' }),
      itens: itensCriterio().slice(1, 2),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.tipoEstoqueId).toBe(avaria);
    // Saldo zero e nunca movimentado, mas o rascunho vai lançar nele: nem inativa nem exclui.
    const inativar = await alterarTipo(avaria, false);
    expect(inativar.status).toBe(422);
    expect(inativar.body.campos).toEqual({ ativo: ['Há 1 recebimento(s) em rascunho neste tipo'] });
    const usado = await excluirTipo(avaria);
    expect(usado.status).toBe(422);
    expect(usado.body.mensagem).toContain('recebimentos');
    expect((await obter(r.body.id)).body.tipoEstoqueNome).toBe('Avaria de recebimento');
    // Excluído o rascunho, o tipo volta a estar livre.
    expect((await amb.http().delete(`/api/recebimentos/${r.body.id}`).set(bearer())).status).toBe(204);
    expect((await alterarTipo(avaria, false)).status).toBe(200);
    expect((await excluirTipo(avaria)).status).toBe(204);

    // O recebimento estornado não trava o inativar (não vai lançar mais), mas é uso: o histórico aponta para o tipo.
    const quebra = await novoTipo('Quebra de recebimento');
    const estornado = await criar({
      ...cabecalho({ tipoEstoqueId: quebra, codigoRemessa: 'TIPO-2' }),
      itens: [],
    });
    expect(estornado.status).toBe(201);
    await consultar(
      emp.nomeBanco,
      `update recebimentos set status = 'estornado', movimentado_em = now(), estornado_em = now(),
              motivo_estorno = 'teste' where id = $1`,
      [estornado.body.id],
    );
    expect((await alterarTipo(quebra, false)).status).toBe(200);
    const comHistorico = await excluirTipo(quebra);
    expect(comHistorico.status).toBe(422);
    expect(comHistorico.body.mensagem).toContain('recebimentos');
  });

  it('a versão velha dá 409 mesmo quando quem tinha a trava só mexeu nos itens (instantâneo depois da trava)', async () => {
    const r = await criar({ ...cabecalho({ codigoRemessa: 'TRAVA' }), itens: itensCriterio().slice(1, 2) });
    expect(r.status).toBe(201);
    const id = r.body.id as string;
    const item = (r.body.itens as Item[])[0]!;
    // Outra transação trava o cabeçalho (sem mudar o conteúdo dele: a versão do cabeçalho fica) e muda só o lote.
    const outra = await conectar(emp.nomeBanco);
    try {
      const pid = (await outra.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      await outra.query('begin');
      await outra.query('select id from recebimentos where id = $1 for update', [id]);
      await outra.query("update itens_recebimento set lote = 'L-OUTRO' where id = $1", [item.id]);
      const pu = amb
        .http()
        .put(`/api/recebimentos/${id}`)
        .set(bearer())
        .send({
          ...cabecalho({ codigoRemessa: 'TRAVA' }),
          versao: r.body.versao,
          itens: [{ ...itensCriterio()[1]!, id: item.id, quantidade: '7' }],
        })
        .then((x) => x);
      await esperarEmTrava(pid);
      await outra.query('commit');
      const resp = await pu;
      expect(resp.status, JSON.stringify(resp.body)).toBe(409);
    } finally {
      await outra.end();
    }
    const [i] = await consultar<{ lote: string; quantidade: string }>(
      emp.nomeBanco,
      'select lote, quantidade::text from itens_recebimento where id = $1',
      [item.id],
    );
    expect(i).toEqual({ lote: 'L-OUTRO', quantidade: '2.000' });
  });
});

/** Espera uma conexão da empresa (fora a que tem a trava) ficar parada numa trava de linha. */
async function esperarEmTrava(ignorar: number) {
  for (let i = 0; i < 250; i++) {
    const linhas = await consultar<{ pid: number }>(
      emp.nomeBanco,
      `select pid from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and pid <> $2`,
      [emp.nomeBanco, ignorar],
    );
    if (linhas.length) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error('o PUT não chegou a esperar a trava');
}
