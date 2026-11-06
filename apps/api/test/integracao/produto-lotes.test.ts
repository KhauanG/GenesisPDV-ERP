/**
 * Bloco Validade do cadastro do produto (Fase 2, F2-B17; ERP 8.2.12; MD 3.6.9, 3.7.4; README da API › decisão 162). O
 * critério de pronto: depois de 2 recebimentos com validades diferentes, o produto mostra o saldo de cada lote
 * (`GET /produtos/:id/saldos`), igual ao `saldos_lote` que desce ao PDV. O corpo leva só os lotes novos e os alterados
 * (`lotes`) e os excluídos (`lotesExcluidos`): o gravado que não vem fica. Também: o estoque do lote gravado não muda
 * (422), o lote com saldo ou com movimento não é excluído (422) e se inativa, o lote sem histórico sai, a troca de
 * textos entre dois lotes, a colisão com um gravado que não veio, a linha igual não regravada (a versão não sobe), a
 * linha sem id reaproveitando o gravado pela chave, o fornecedor sem a categoria recusado, o lote desce ao PDV com o
 * filtro da loja (`estoque_id is null or = E`), o produto com mais de 200 lotes criados pelo recebimento continua
 * gravável, e o usuário restrito não vê o lote nem o saldo de lote de um estoque fora dos permitidos, não o apaga (e
 * recebe 403 ao mandá-lo).
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  completarCnpj,
  MAXIMO_LOTES_PRODUTO,
  respostaPullSchema,
  type Ativar,
  type LoteProdutoDetalhe,
  type ProdutoDetalhe,
  type SaldosProduto,
} from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
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

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let tokenAdmin: string;
/** Estoquista do seed só com a Loja 1 e o estoque dela. */
let tokenRestrito: string;
let un: string;
let loja1: string;
let loja2: string;
let estoque1: string;
let estoque2: string;
let fornecedor: string;
/** Pessoa sem a categoria Fornecedor. */
let cliente: string;
let terminal: { id: string; token: string };

const bearer = (tk = tokenAdmin) => ({ Authorization: `Bearer ${tk}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function cabecalhos(tk?: string) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '1.0.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

/** Terminal da Loja 1 ativado pelo `/sync/ativar` real (só o pull é usado). */
async function ativarTerminal(): Promise<{ id: string; token: string }> {
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja1],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: loja1, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: g.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.terminal_id as string, token: r.body.token as string };
}

/** As linhas vivas de `tabela` no fluxo, do zero (a última versão de cada id). */
async function puxar(fluxo: 'catalogo' | 'estoque', tabela: string) {
  const linhas = new Map<string, Record<string, unknown>>();
  let cursor = 0;
  for (let i = 0; i < 50; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=${fluxo}&desde=${cursor}&limite=2000`)
      .set(cabecalhos(terminal.token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    for (const a of r.body.alteracoes as Array<{ tabela: string; linha: Record<string, unknown> }>)
      if (a.tabela === tabela) linhas.set(a.linha.id as string, a.linha);
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return [...linhas.values()].filter((l) => !l.excluido_em);
  }
  throw new Error('pull não terminou');
}

async function produto(nome: string): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '8', precoCusto: '4' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

const detalhe = async (id: string, tk = tokenAdmin) => {
  const r = await amb.http().get(`/api/produtos/${id}`).set(bearer(tk));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ProdutoDetalhe;
};
const saldos = async (id: string, tk = tokenAdmin) => {
  const r = await amb.http().get(`/api/produtos/${id}/saldos`).set(bearer(tk));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as SaldosProduto;
};

/** O lote do detalhe no formato do corpo (como o formulário devolve o que recebeu). */
const doDetalhe = (l: LoteProdutoDetalhe) => ({
  id: l.id,
  estoqueId: l.estoqueId,
  lote: l.lote,
  validade: l.validade,
  fabricacao: l.fabricacao,
  fornecedorId: l.fornecedorId,
  ativo: l.ativo,
});

/**
 * `PUT` do produto com os dados do teste, os lotes novos ou alterados dados (`undefined` = sem a lista) e os ids a
 * excluir (`undefined` = sem a lista).
 */
async function gravar(
  id: string,
  lotes: Array<Record<string, unknown>> | undefined,
  excluidos?: string[],
  precoVenda = '8',
) {
  const d = await detalhe(id);
  return amb
    .http()
    .put(`/api/produtos/${id}`)
    .set(bearer())
    .send({
      versao: d.versao,
      nome: d.nome,
      unidadeId: un,
      precoVenda,
      precoCusto: '4',
      ...(lotes !== undefined ? { lotes } : {}),
      ...(excluidos !== undefined ? { lotesExcluidos: excluidos } : {}),
    });
}

/** Recebimento manual movimentado com os itens dados (lote e validade), na Loja 1 se outra não for dada. */
async function receberItens(
  produtoId: string,
  itens: Array<{ quantidade: string; lote: string; validade: string }>,
  lojaId = loja1,
): Promise<string[]> {
  const r = await amb
    .http()
    .post('/api/recebimentos')
    .set(bearer())
    .send({
      lojaId,
      fornecedorId: fornecedor,
      dataRecebimento: '2026-11-01',
      temValidade: true,
      itens: itens.map((it) => ({ produtoId, precoCompra: '4', ...it })),
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const m = await amb
    .http()
    .post(`/api/recebimentos/${r.body.id}/movimentar`)
    .set(bearer())
    .send({ atualizarPrecoCusto: false });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
  return (m.body.itens as Array<{ loteId: string }>).map((it) => it.loteId);
}

/** Recebimento manual movimentado com um item com lote. */
const receber = async (
  produtoId: string,
  quantidade: string,
  lote: string,
  validade: string,
  lojaId = loja1,
) => (await receberItens(produtoId, [{ quantidade, lote, validade }], lojaId))[0]!;

/** `versao` de cada lote vivo do produto (a linha regravada sobe a versão e desce de novo ao PDV). */
const versoesLotes = async (produtoId: string) =>
  Object.fromEntries(
    (
      await consultar<{ id: string; versao: string }>(
        emp.nomeBanco,
        'select id, versao::text from produtos_lotes where produto_id = $1 and excluido_em is null',
        [produtoId],
      )
    ).map((l) => [l.id, l.versao]),
  );

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Petiscaria 2');
  const estoques = await consultar<{ id: string; estoque_id: string }>(
    emp.nomeBanco,
    'select id, estoque_id from lojas where id = any($1::uuid[])',
    [[loja1, loja2]],
  );
  estoque1 = estoques.find((e) => e.id === loja1)!.estoque_id;
  estoque2 = estoques.find((e) => e.id === loja2)!.estoque_id;
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [loja1],
    estoques: [estoque1],
  });
  tokenRestrito = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
  const f = await amb
    .http()
    .post('/api/pessoas/fornecedor-rapido')
    .set(bearer())
    .send({ cpfCnpj: completarCnpj('112223330001'), nome: 'Laticínios X Ltda' });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  fornecedor = f.body.pessoa.id as string;
  [{ id: cliente }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into pessoas (tipo, nome) values ('PF', 'Cliente Sem Categoria') returning id",
  )) as [{ id: string }];
  terminal = await ativarTerminal();
}, 180_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('bloco Validade do produto (F2-B17; ERP 8.2.12)', () => {
  it('2 recebimentos com validades diferentes: o produto mostra o saldo de cada lote, igual ao do PDV (critério de pronto)', async () => {
    const p = await produto('Iogurte natural 170g');
    const l1 = await receber(p, '10', 'IOG-2611', '2026-11-30');
    const l2 = await receber(p, '6', 'IOG-2612', '2026-12-31');

    // O cadastro mostra os dois lotes (criados pelo recebimento: sem estoque, com o fornecedor), na ordem FEFO.
    const d = await detalhe(p);
    expect(d.lotes).toEqual([
      expect.objectContaining({
        id: l1,
        estoqueId: null,
        lojaNome: null,
        lote: 'IOG-2611',
        validade: '2026-11-30',
        fornecedorId: fornecedor,
        ativo: true,
        temMovimento: true,
      }),
      expect.objectContaining({ id: l2, lote: 'IOG-2612', validade: '2026-12-31', temMovimento: true }),
    ]);
    expect(d.lotes[0]!.fornecedor).toMatchObject({ id: fornecedor, cpfCnpj: null });

    const s = await saldos(p);
    const porLote = (id: string) => s.lotes.filter((x) => x.loteId === id);
    expect(porLote(l1)).toEqual([expect.objectContaining({ estoqueId: estoque1, quantidade: '10.000' })]);
    expect(porLote(l2)).toEqual([expect.objectContaining({ estoqueId: estoque1, quantidade: '6.000' })]);

    // O PDV da Loja 1 recebe o mesmo `saldos_lote` (o tipo vendável) e os dois lotes (sem estoque = de todos).
    const pdv = (await puxar('estoque', 'saldos_lote')).filter((x) => x.produto_id === p);
    expect(Object.fromEntries(pdv.map((x) => [x.lote_id as string, x.quantidade]))).toEqual(
      Object.fromEntries(s.lotes.filter((x) => x.vendavel).map((x) => [x.loteId, x.quantidade])),
    );
    const lotesPdv = (await puxar('catalogo', 'produtos_lotes')).filter((x) => x.produto_id === p);
    expect(lotesPdv.map((x) => x.lote).sort()).toEqual(['IOG-2611', 'IOG-2612']);
    await conferirRazaoDoBanco(emp.nomeBanco);
  });

  it('o lote desce ao PDV com o filtro da loja; trocar o estoque de um lote gravado é 422', async () => {
    const p = await produto('Queijo minas frescal kg');
    const r = await gravar(p, [
      { estoqueId: estoque1, lote: 'QM-L1', validade: '2026-12-10' },
      { estoqueId: estoque2, lote: 'QM-L2', validade: '2026-12-11' },
      { estoqueId: null, lote: 'QM-TODAS', validade: '2026-12-12', fornecedorId: fornecedor },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as ProdutoDetalhe;
    expect(d.lotes.map((l) => [l.lote, l.lojaNome])).toEqual([
      ['QM-L1', 'Loja 1 - Centro'],
      ['QM-L2', 'Petiscaria 2'],
      ['QM-TODAS', null],
    ]);
    // O terminal da Loja 1 recebe o lote dela e o de todas as lojas, não o da Petiscaria.
    const pdv = (await puxar('catalogo', 'produtos_lotes')).filter((x) => x.produto_id === p);
    expect(pdv.map((x) => x.lote).sort()).toEqual(['QM-L1', 'QM-TODAS']);

    // Trocar a loja de um lote gravado: 422 no campo da linha, nada muda.
    const lote = (texto: string) => doDetalhe(d.lotes.find((l) => l.lote === texto)!);
    const troca = await gravar(p, [lote('QM-TODAS'), { ...lote('QM-L1'), estoqueId: estoque2 }]);
    expect(troca.status, JSON.stringify(troca.body)).toBe(422);
    expect(troca.body.campos['lotes.1.estoqueId'][0]).toMatch(/não muda depois de gravado/);
    // Nem tirar o estoque (vale para "todas as lojas").
    const semLoja = await gravar(p, [{ ...lote('QM-L2'), estoqueId: null }]);
    expect(semLoja.status).toBe(422);
    expect(semLoja.body.campos['lotes.0.estoqueId']).toBeDefined();
    expect((await detalhe(p)).lotes.map((l) => l.estoqueId)).toEqual([estoque1, estoque2, null]);

    // Estoque sem loja (ou inexistente) no lote novo: 422.
    const [{ id: deposito }] = (await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome, tipo) values ('Depósito antigo', 'deposito') returning id",
    )) as [{ id: string }];
    const semLojaNova = await gravar(p, [{ estoqueId: deposito, lote: 'QM-X' }]);
    expect(semLojaNova.status).toBe(422);
    expect(semLojaNova.body.campos['lotes.0.estoqueId'][0]).toMatch(/Loja inexistente/);
  });

  it('lote com saldo ou com movimento não é excluído (inativa-se); o sem histórico sai; o lote que não vem fica', async () => {
    const p = await produto('Requeijão cremoso 200g');
    const comSaldo = await receber(p, '5', 'RQ-SALDO', '2027-01-15');
    // Só o lote novo no corpo: o RQ-SALDO, que não vem, fica como está.
    const r = await gravar(p, [{ estoqueId: null, lote: 'RQ-VAZIO', validade: '2027-02-01' }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as ProdutoDetalhe).lotes.map((l) => l.lote)).toEqual(['RQ-SALDO', 'RQ-VAZIO']);

    // Excluir o lote com saldo: 422 na lista, nada sai.
    const vazio = (r.body as ProdutoDetalhe).lotes.find((l) => l.lote === 'RQ-VAZIO')!;
    expect(vazio.temMovimento).toBe(false);
    const recusa = await gravar(p, undefined, [comSaldo]);
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(422);
    expect(recusa.body.campos.lotes).toEqual([
      'O lote RQ-SALDO tem saldo em estoque: não pode ser excluído (inative-o)',
    ]);
    expect((await detalhe(p)).lotes).toHaveLength(2);

    // Zerado por um acerto de saída com o lote, continua com movimento: também não sai.
    const a = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoque1,
        tipoAjuste: 'saida',
        motivo: 'Vencido',
        dataContagem: new Date().toISOString(),
        itens: [{ produtoId: p, loteId: comSaldo, quantidade: '5' }],
      });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const ef = await amb
      .http()
      .post(`/api/acertos/${a.body.id}/efetivar`)
      .set(bearer())
      .send({ versao: a.body.versao });
    expect(ef.status, JSON.stringify(ef.body)).toBe(200);
    expect((await saldos(p)).lotes.filter((x) => x.loteId === comSaldo)).toEqual([]);
    const comMovimento = await gravar(p, [], [comSaldo]);
    expect(comMovimento.status).toBe(422);
    expect(comMovimento.body.campos.lotes[0]).toMatch(/RQ-SALDO já tem movimento de estoque/);

    // As listas ausentes (importação, ERP antigo, o "Gravar" que não mexeu nos lotes) mantêm os dois.
    expect((await gravar(p, undefined)).status).toBe(200);
    expect((await detalhe(p)).lotes).toHaveLength(2);
    // O id que já não está entre os lotes vivos é ignorado.
    expect((await gravar(p, undefined, [uuidv7()])).status).toBe(200);
    expect((await detalhe(p)).lotes).toHaveLength(2);

    // Inativar o com movimento e excluir o vazio: grava.
    const d = await detalhe(p);
    const ok = await gravar(
      p,
      d.lotes.filter((l) => l.lote === 'RQ-SALDO').map((l) => ({ ...doDetalhe(l), ativo: false })),
      [vazio.id],
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as ProdutoDetalhe).lotes).toEqual([
      expect.objectContaining({ id: comSaldo, ativo: false, temMovimento: true }),
    ]);
    const [excluido] = await consultar<{ excluido_em: Date | null }>(
      emp.nomeBanco,
      'select excluido_em from produtos_lotes where id = $1',
      [vazio.id],
    );
    expect(excluido!.excluido_em).not.toBeNull();
    await conferirRazaoDoBanco(emp.nomeBanco);
  });

  it('lote em acerto de rascunho não sai; a troca de textos entre dois lotes grava; o fornecedor precisa da categoria', async () => {
    const p = await produto('Manteiga 200g');
    const r = await gravar(p, [
      { estoqueId: estoque1, lote: 'MT-A', validade: '2027-03-01', fabricacao: '2026-09-01' },
      { estoqueId: estoque1, lote: 'MT-B', validade: '2027-04-01' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [a, b] = (r.body as ProdutoDetalhe).lotes as [LoteProdutoDetalhe, LoteProdutoDetalhe];

    // Troca dos textos entre as duas linhas (sem colidir em `uq_produtos_lotes`).
    const troca = await gravar(p, [
      { ...doDetalhe(a), lote: 'MT-B' },
      { ...doDetalhe(b), lote: 'MT-A' },
    ]);
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    const depois = (troca.body as ProdutoDetalhe).lotes;
    expect(depois.find((l) => l.id === a.id)!.lote).toBe('MT-B');
    expect(depois.find((l) => l.id === b.id)!.lote).toBe('MT-A');

    // Repetido na mesma loja: 422 do zod.
    const repetido = await gravar(p, [
      doDetalhe(depois.find((l) => l.id === a.id)!),
      { estoqueId: estoque1, lote: 'MT-B' },
    ]);
    expect(repetido.status).toBe(422);
    expect(repetido.body.campos['lotes.1.lote'][0]).toMatch(/repetido na mesma loja/);
    // O texto de um gravado que não veio no corpo (o zod não o vê): 422 da API na linha, nada muda.
    const colide = await gravar(p, [{ ...doDetalhe(depois.find((l) => l.id === a.id)!), lote: 'MT-A' }]);
    expect(colide.status, JSON.stringify(colide.body)).toBe(422);
    expect(colide.body.campos['lotes.0.lote'][0]).toBe('O lote MT-A já existe nesta loja');
    expect((await detalhe(p)).lotes.find((l) => l.id === a.id)!.lote).toBe('MT-B');

    // Fornecedor sem a categoria: 422 na linha.
    const semCategoria = await gravar(p, [{ estoqueId: null, lote: 'MT-C', fornecedorId: cliente }]);
    expect(semCategoria.status).toBe(422);
    expect(semCategoria.body.campos['lotes.0.fornecedorId'][0]).toMatch(/categoria Fornecedor/);

    // O lote num acerto em rascunho não sai.
    const ac = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoque1,
        tipoAjuste: 'entrada',
        motivo: 'Contagem',
        dataContagem: new Date().toISOString(),
        itens: [{ produtoId: p, loteId: a.id, quantidade: '1', custoUnitario: '3' }],
      });
    expect(ac.status, JSON.stringify(ac.body)).toBe(201);
    const recusa = await gravar(p, undefined, [a.id]);
    expect(recusa.status).toBe(422);
    expect(recusa.body.campos.lotes[0]).toMatch(new RegExp(`acerto Nº ${ac.body.codigo} em rascunho`));
    expect((await detalhe(p)).lotes.find((l) => l.id === a.id)!.temMovimento).toBe(true);
  });

  it('o restrito não vê o lote nem o saldo de lote de outro estoque, e não o apaga; mandar outro estoque é 403', async () => {
    const p = await produto('Doce de leite 400g');
    const r = await gravar(p, [
      { estoqueId: estoque1, lote: 'DL-L1' },
      { estoqueId: estoque2, lote: 'DL-L2' },
      { estoqueId: null, lote: 'DL-TODAS' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Saldo de lote nos dois estoques: o recebimento de cada loja cria um lote sem estoque (de todas as lojas).
    const naLoja1 = await receber(p, '3', 'DL-R1', '2027-05-01');
    const naLoja2 = await receber(p, '7', 'DL-R2', '2027-05-02', loja2);
    const todos = await saldos(p);
    expect(todos.lotes.map((x) => [x.loteId, x.estoqueId, x.quantidade]).sort()).toEqual(
      [
        [naLoja1, estoque1, '3.000'],
        [naLoja2, estoque2, '7.000'],
      ].sort(),
    );
    // O restrito vê o saldo do lote só no estoque dele (o lote DL-R2 vale em todas as lojas, o saldo não).
    const restrito = await saldos(p, tokenRestrito);
    expect(restrito.lotes.map((x) => [x.loteId, x.estoqueId])).toEqual([[naLoja1, estoque1]]);
    expect(restrito.saldos.every((x) => x.estoqueId === estoque1)).toBe(true);

    // O `/auth/eu` dá o estoque só da loja cujo estoque ele vê.
    const eu = await amb.http().get('/api/auth/eu').set(bearer(tokenRestrito));
    expect(eu.body.lojas).toEqual([expect.objectContaining({ id: loja1, estoqueId: estoque1 })]);

    const visto = await detalhe(p, tokenRestrito);
    expect(visto.lotes.map((l) => l.lote)).toEqual(['DL-R1', 'DL-R2', 'DL-L1', 'DL-TODAS']);
    const d = await detalhe(p);
    const dl2 = d.lotes.find((l) => l.lote === 'DL-L2')!.id;
    const put = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(tokenRestrito))
      .send({
        versao: d.versao,
        nome: d.nome,
        unidadeId: un,
        precoVenda: '8',
        // O DL-L2 é de um estoque que ele não vê: o id é ignorado.
        lotesExcluidos: [visto.lotes.find((l) => l.lote === 'DL-L1')!.id, dl2],
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    // Saiu o DL-L1 (que ele vê e tirou); o DL-L2 ficou.
    expect((await detalhe(p)).lotes.map((l) => l.lote)).toEqual(['DL-R1', 'DL-R2', 'DL-L2', 'DL-TODAS']);

    const outro = await amb
      .http()
      .put(`/api/produtos/${p}`)
      .set(bearer(tokenRestrito))
      .send({
        versao: (await detalhe(p)).versao,
        nome: d.nome,
        unidadeId: un,
        precoVenda: '8',
        lotes: [{ estoqueId: estoque2, lote: 'DL-INVASOR' }],
      });
    expect(outro.status).toBe(403);
  });
  it('a linha igual à gravada não é regravada (a versão não sobe); a linha sem id reaproveita o gravado pela chave', async () => {
    const p = await produto('Creme de leite 200g');
    const r = await gravar(p, [
      { estoqueId: estoque1, lote: 'CL-A', validade: '2027-01-10', fornecedorId: fornecedor },
      { estoqueId: null, lote: 'CL-B', validade: '2027-02-10' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as ProdutoDetalhe;
    const antes = await versoesLotes(p);
    const [{ cursor: cursorAntes }] = (await consultar<{ cursor: string }>(
      emp.nomeBanco,
      'select coalesce(max(versao), 0)::text as cursor from produtos_lotes',
    )) as [{ cursor: string }];

    // Regravar as mesmas linhas, com o fornecedor em maiúsculas (o ERP pode mandar assim): nada muda.
    const mesma = await gravar(
      p,
      d.lotes.map((l) => ({ ...doDetalhe(l), fornecedorId: l.fornecedorId?.toUpperCase() ?? null })),
    );
    expect(mesma.status, JSON.stringify(mesma.body)).toBe(200);
    expect(await versoesLotes(p)).toEqual(antes);
    const [{ cursor: cursorDepois }] = (await consultar<{ cursor: string }>(
      emp.nomeBanco,
      'select coalesce(max(versao), 0)::text as cursor from produtos_lotes',
    )) as [{ cursor: string }];
    expect(cursorDepois).toBe(cursorAntes);

    // A linha sem id com a (loja, lote) de um gravado: o mesmo lote é atualizado, nada é excluído nem incluído.
    const a = d.lotes.find((l) => l.lote === 'CL-A')!;
    const chave = await gravar(p, [{ estoqueId: estoque1, lote: 'CL-A', validade: '2027-01-20' }]);
    expect(chave.status, JSON.stringify(chave.body)).toBe(200);
    expect((chave.body as ProdutoDetalhe).lotes).toEqual([
      expect.objectContaining({ id: a.id, lote: 'CL-A', validade: '2027-01-20', fornecedorId: null }),
      expect.objectContaining({ lote: 'CL-B' }),
    ]);
    const versoes = await versoesLotes(p);
    expect(Object.keys(versoes).sort()).toEqual(Object.keys(antes).sort());
    expect(Number(versoes[a.id])).toBeGreaterThan(Number(antes[a.id]));
    expect(versoes[d.lotes.find((l) => l.lote === 'CL-B')!.id]).toBe(
      antes[d.lotes.find((l) => l.lote === 'CL-B')!.id],
    );
    const [{ n }] = (await consultar<{ n: number }>(
      emp.nomeBanco,
      'select count(*)::int as n from produtos_lotes where produto_id = $1 and excluido_em is not null',
      [p],
    )) as [{ n: number }];
    expect(n).toBe(0);
  });

  it('o produto com mais de 200 lotes criados pelo recebimento continua gravável pelo formulário', async () => {
    const p = await produto('Pão francês kg');
    const total = MAXIMO_LOTES_PRODUTO + 5;
    const ids = await receberItens(
      p,
      Array.from({ length: total }, (_, i) => ({
        quantidade: '1',
        lote: `PF-${String(i).padStart(3, '0')}`,
        validade: '2027-03-01',
      })),
    );
    expect(new Set(ids).size).toBe(total);
    const d = await detalhe(p);
    expect(d.lotes).toHaveLength(total);
    expect(d.lotes.every((l) => l.temMovimento)).toBe(true);

    // A troca de preço (o ERP não manda os lotes que não mudaram): grava, e os lotes ficam.
    const preco = await gravar(p, undefined, undefined, '9');
    expect(preco.status, JSON.stringify(preco.body)).toBe(200);
    expect((preco.body as ProdutoDetalhe).precoVenda).toBe('9.0000');
    expect((preco.body as ProdutoDetalhe).lotes).toHaveLength(total);
    // Inativar alguns e incluir um novo: só eles vão no corpo.
    const mudados = d.lotes.slice(0, 3).map((l) => ({ ...doDetalhe(l), ativo: false }));
    const parcial = await gravar(p, [...mudados, { estoqueId: estoque1, lote: 'PF-NOVO' }]);
    expect(parcial.status, JSON.stringify(parcial.body)).toBe(200);
    const depois = (parcial.body as ProdutoDetalhe).lotes;
    expect(depois).toHaveLength(total + 1);
    expect(depois.filter((l) => !l.ativo).map((l) => l.id)).toEqual(mudados.map((l) => l.id));
    // O teto vale para o que muda numa gravação, não para os lotes do produto.
    const demais = await gravar(
      p,
      d.lotes.map((l) => ({ ...doDetalhe(l), validade: '2027-04-01' })),
    );
    expect(demais.status).toBe(422);
    expect(demais.body.campos.lotes[0]).toBe('No máximo 200 lotes alterados numa gravação');
    await conferirRazaoDoBanco(emp.nomeBanco);
  }, 120_000);
});
