/**
 * Complementos do produto no cadastro do ERP (Fase 2, F2-B51; F2-Q1 = roadmap D43: complementos sim; ERP 8.2.16; MD
 * 3.6.8; README da API › decisão 194). O critério de pronto: um produto "Porção" com o grupo "Molhos (0 a 2)" gravado
 * pelo `POST /api/produtos` do ERP desce no pull do `catalogo` (as duas tabelas, com todas as colunas), pronto para o
 * SQLite do caixa (o `AplicadorPullTests` do PDV aplica a mesma página).
 *
 * Também: a chave `produtos.complementos_habilitados` nasce ligada; tirar um complemento só o inativa e tirar o grupo o
 * exclui logicamente com os complementos (tombstone ao caixa; nada é apagado); a linha igual não é regravada; a versão
 * do cadastro cobre os complementos (409); o corpo sem a lista mantém os grupos (a importação, o ERP antigo); sair do
 * tipo exige a lista; as regras do produto vinculado (tipo, ativo, ele mesmo, fração na baixa); o vinculado ativo não
 * se exclui nem troca para um tipo que não pode ser complemento; a exclusão do produto leva os grupos; as permissões
 * são as do formulário; e a auditoria legível no histórico do produto. Dados inventados.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { respostaPullSchema, type Ativar, type ProdutoDetalhe } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
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

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let vendedor: string;
let estoquista: string;
let un: string;
let kg: string;
let loja: string;
let terminal: { id: string; token: string };
/** Os vinculáveis: matéria-prima em KG (fração), simples em UN, e os que não podem ser complemento. */
let cheddar: string;
let bacon: string;
let servico: string;

const bearer = (tk = admin) => ({ Authorization: `Bearer ${tk}` });
const spki = (k: KeyObject) => k.export({ type: 'spki', format: 'der' }).toString('base64');

function cabecalhos(tk?: string) {
  return {
    ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
    'X-Genesis-Protocolo': '1',
    'X-Genesis-App-Versao': '0.12.0',
    'X-Genesis-Plataforma': 'windows_x64',
    'X-Requisicao-Id': uuidv7(),
    'X-Genesis-Hora-Local': new Date().toISOString(),
    'X-Genesis-Id-Hardware': ATIVAR.maquina.id_hardware,
  };
}

/** Terminal da loja ativado pelo `/sync/ativar` real (só o pull é usado). */
async function ativarTerminal(): Promise<{ id: string; token: string }> {
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    "insert into caixas (loja_id, numero, descricao) values ($1, 1, 'Caixa 01') returning id",
    [loja],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer())
    .send({ lojaId: loja, caixaId: caixa, descricao: 'PC do balcão', validadeHoras: 24 });
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

type Linha = Record<string, unknown>;

/** O pull do `catalogo` desde `desde`, até o fim: a última versão de cada linha por tabela, e o cursor novo. */
async function puxar(desde = 0): Promise<{ linhas: Map<string, Map<string, Linha>>; cursor: number }> {
  const linhas = new Map<string, Map<string, Linha>>();
  let cursor = desde;
  for (let i = 0; i < 50; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=catalogo&desde=${cursor}&limite=2000`)
      .set(cabecalhos(terminal.token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    for (const a of r.body.alteracoes as Array<{ tabela: string; linha: Linha }>) {
      if (!linhas.has(a.tabela)) linhas.set(a.tabela, new Map());
      linhas.get(a.tabela)!.set(a.linha.id as string, a.linha);
    }
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { linhas, cursor };
  }
  throw new Error('pull não terminou');
}
const daTabela = (p: Awaited<ReturnType<typeof puxar>>, tabela: string) => [
  ...(p.linhas.get(tabela)?.values() ?? []),
];

async function criar(corpo: Record<string, unknown>, token = admin) {
  return amb
    .http()
    .post('/api/produtos')
    .set(bearer(token))
    .send({ unidadeId: un, precoVenda: '10', ...corpo });
}

const detalhe = async (id: string) => {
  const r = await amb.http().get(`/api/produtos/${id}`).set(bearer());
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as ProdutoDetalhe;
};

/** O `PUT` como o formulário manda: o detalhe com as mudanças (o zod ignora os campos só de leitura). */
async function alterar(id: string, mudancas: Record<string, unknown>, token = admin, base?: ProdutoDetalhe) {
  const atual = base ?? (await detalhe(id));
  return amb
    .http()
    .put(`/api/produtos/${id}`)
    .set(bearer(token))
    .send({ ...atual, ...mudancas });
}

/** Os grupos do detalhe no formato do corpo, para mexer num campo e mandar de volta. */
const corpoGrupos = (d: ProdutoDetalhe) =>
  d.gruposComplementos.map((g) => ({
    ...g,
    complementos: g.complementos.map(({ produto: _p, ...c }) => c),
  }));

const molhos = () => ({
  nome: 'Molhos',
  minimo: 0,
  maximo: 2,
  complementos: [
    { descricao: 'Barbecue', precoAdicional: '2,00' },
    { produtoId: cheddar, precoAdicional: '3,5', baixaEstoque: true, quantidadeBaixa: '0,05' },
  ],
});

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor' });
  vendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  // Tem "Produtos: Editar" e não tem "Produtos: Alterar preço".
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer());
  const sigla = (s: string) =>
    (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === s)!.id;
  un = sigla('UN');
  kg = sigla('KG');
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja Centro');
  terminal = await ativarTerminal();
  const novo = async (corpo: Record<string, unknown>) => {
    const r = await criar(corpo);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };
  cheddar = await novo({
    nome: 'CHEDDAR CREMOSO',
    tipo: 'materia_prima',
    unidadeId: kg,
    permiteFracao: true,
    precoVenda: '0',
  });
  bacon = await novo({ nome: 'BACON EM CUBOS PORCAO' });
  servico = await novo({ nome: 'TAXA DE ENTREGA', tipo: 'servico', controlaEstoque: false });
});

afterAll(async () => {
  await amb?.fechar();
});

describe('complementos no cadastro do produto (F2-B51)', () => {
  let porcao: string;
  let cursor: number;

  it('critério de pronto: a "Porção" com o grupo "Molhos (0 a 2)" gravada no ERP desce no pull do catalogo', async () => {
    // A chave nasce ligada: o tipo é oferecido e a criação passa, sem mexer em Configurações.
    const tipos = await amb.http().get('/api/produtos/tipos-habilitados').set(bearer());
    expect(tipos.body.tipos).toContain('com_complementos');
    expect(tipos.body.tipos).not.toContain('com_variacoes');
    cursor = (await puxar()).cursor;

    const r = await criar({
      nome: 'PORÇÃO DE BATATA FRITA',
      tipo: 'com_complementos',
      precoVenda: '29,90',
      gruposComplementos: [molhos()],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    porcao = r.body.id as string;
    const d = r.body as ProdutoDetalhe;
    expect(d.gruposComplementos).toHaveLength(1);
    const [g] = d.gruposComplementos;
    expect(g).toMatchObject({ nome: 'Molhos', minimo: 0, maximo: 2, obrigatorio: false, ordem: 1 });
    expect(g!.complementos.map((c) => [c.descricao, c.produto?.nome ?? null, c.precoAdicional])).toEqual([
      ['Barbecue', null, '2.0000'],
      [null, 'CHEDDAR CREMOSO', '3.5000'],
    ]);
    expect(g!.complementos[1]).toMatchObject({
      produtoId: cheddar,
      baixaEstoque: true,
      quantidadeBaixa: '0.050',
      ordem: 2,
      ativo: true,
    });

    // O pull do caixa: o produto, o grupo e as duas opções, com todas as colunas que o espelho do PDV 0.12.0 tem.
    const p = await puxar(cursor);
    cursor = p.cursor;
    expect(p.linhas.get('produtos')?.get(porcao)).toMatchObject({
      nome: 'PORÇÃO DE BATATA FRITA',
      tipo: 'com_complementos',
      preco_venda: '29.9000',
    });
    const [grupo] = daTabela(p, 'produtos_grupos_complementos');
    expect(grupo).toEqual({
      id: g!.id,
      produto_id: porcao,
      nome: 'Molhos',
      minimo: 0,
      maximo: 2,
      obrigatorio: false,
      ordem: 1,
      versao: expect.any(Number),
      criado_em: expect.any(String),
      atualizado_em: expect.any(String),
      excluido_em: null,
      criado_por_id: expect.any(String),
      atualizado_por_id: expect.any(String),
    });
    const opcoes = daTabela(p, 'produtos_complementos').sort((a, b) => Number(a.ordem) - Number(b.ordem));
    expect(opcoes).toEqual([
      expect.objectContaining({
        grupo_id: g!.id,
        produto_id: null,
        descricao: 'Barbecue',
        preco_adicional: '2.0000',
        baixa_estoque: false,
        quantidade_baixa: '1.000',
        ordem: 1,
        ativo: true,
        excluido_em: null,
      }),
      expect.objectContaining({
        grupo_id: g!.id,
        produto_id: cheddar,
        descricao: null,
        preco_adicional: '3.5000',
        baixa_estoque: true,
        quantidade_baixa: '0.050',
        ordem: 2,
        ativo: true,
        excluido_em: null,
      }),
    ]);

    // A auditoria legível no histórico do produto.
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      "select descricao from auditoria where entidade = 'produtos' and registro_id = $1 and acao = 'criar'",
      [porcao],
    );
    expect(aud!.descricao).toContain('Grupo de complementos adicionado Molhos (Máximo 2)');
    expect(aud!.descricao).toContain('Complemento adicionado Molhos: Barbecue (Preço adicional 2,00)');
    expect(aud!.descricao).toContain(
      'Complemento adicionado Molhos: ' + `${(await detalhe(cheddar)).codigo} - CHEDDAR CREMOSO`,
    );
  });

  it('a linha igual não é regravada; tirar um complemento só o inativa (continua no detalhe e no caixa)', async () => {
    const antes = await detalhe(porcao);
    // O mesmo corpo de volta: nada sobe de versão nem desce de novo ao caixa.
    const igual = await alterar(porcao, {}, admin, antes);
    expect(igual.status, JSON.stringify(igual.body)).toBe(200);
    expect((igual.body as ProdutoDetalhe).versao).toBe(antes.versao);
    expect(daTabela(await puxar(cursor), 'produtos_complementos')).toEqual([]);

    const grupos = corpoGrupos(antes);
    grupos[0]!.complementos = grupos[0]!.complementos.filter((c) => c.descricao !== 'Barbecue');
    const r = await alterar(porcao, { gruposComplementos: grupos }, admin, antes);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body as ProdutoDetalhe;
    expect(d.versao).toBeGreaterThan(antes.versao);
    expect(d.gruposComplementos[0]!.complementos.map((c) => [c.descricao, c.ativo])).toEqual([
      ['Barbecue', false],
      [null, true],
    ]);
    const p = await puxar(cursor);
    cursor = p.cursor;
    expect(daTabela(p, 'produtos_complementos')).toEqual([
      expect.objectContaining({ descricao: 'Barbecue', ativo: false, excluido_em: null }),
    ]);
    const [aud] = await consultar<{ descricao: string }>(
      emp.nomeBanco,
      `select descricao from auditoria where entidade = 'produtos' and registro_id = $1 and acao = 'editar'
        order by ocorrido_em desc limit 1`,
      [porcao],
    );
    expect(aud!.descricao).toBe('Complemento Molhos: Barbecue: Ativo Sim → Não');

    // Reativar e mudar o preço adicional (4 casas, como os preços do catálogo).
    const grupos2 = corpoGrupos(d);
    grupos2[0]!.complementos[0] = { ...grupos2[0]!.complementos[0]!, ativo: true, precoAdicional: '2.4567' };
    const reativado = await alterar(porcao, { gruposComplementos: grupos2 }, admin, d);
    expect(reativado.status, JSON.stringify(reativado.body)).toBe(200);
    expect((reativado.body as ProdutoDetalhe).gruposComplementos[0]!.complementos[0]).toMatchObject({
      descricao: 'Barbecue',
      ativo: true,
      precoAdicional: '2.4567',
    });
  });

  it('versão do cadastro: quem abriu antes da mudança dos complementos recebe 409', async () => {
    const velho = await detalhe(porcao);
    const grupos = corpoGrupos(velho);
    grupos[0]!.maximo = 3;
    expect((await alterar(porcao, { gruposComplementos: grupos }, admin, velho)).status).toBe(200);
    const conflito = await alterar(porcao, { localizacao: 'COZINHA' }, admin, velho);
    expect(conflito.status, JSON.stringify(conflito.body)).toBe(409);
  });

  it('o corpo sem a lista mantém os grupos (a importação, o ERP antigo); o usuário sem "Produtos: Editar" recebe 403', async () => {
    const { gruposComplementos: _g, ...semLista } = await detalhe(porcao);
    const r = await amb
      .http()
      .put(`/api/produtos/${porcao}`)
      .set(bearer())
      .send({ ...semLista, localizacao: 'BALCAO' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as ProdutoDetalhe).gruposComplementos[0]!.complementos).toHaveLength(2);
    const negado = await alterar(porcao, { gruposComplementos: [] }, vendedor);
    expect(negado.status).toBe(403);
    expect((await detalhe(porcao)).gruposComplementos).toHaveLength(1);
  });

  it('regras: o tipo, o produto vinculado (existe, ativo, pode ser complemento, não é ele mesmo) e a fração da baixa', async () => {
    const recusa = async (gruposComplementos: unknown[], extra: Record<string, unknown> = {}) => {
      const r = await alterar(porcao, { gruposComplementos, ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      return r.body.campos as Record<string, string[]>;
    };
    const com = (c: Record<string, unknown>) => [{ ...molhos(), complementos: [c] }];
    expect((await recusa([molhos()], { tipo: 'simples' })).gruposComplementos).toEqual([
      'Só o tipo Com complementos tem complementos',
    ]);
    expect(
      (await recusa(com({ produtoId: servico })))['gruposComplementos.0.complementos.0.produtoId'],
    ).toEqual([
      'Serviço não pode ser complemento: use Simples, Matéria-prima ou Produzido, ou um complemento livre',
    ]);
    expect(
      (await recusa(com({ produtoId: porcao })))['gruposComplementos.0.complementos.0.produtoId'],
    ).toEqual(['O produto não pode ser complemento de si mesmo']);
    expect(
      (await recusa(com({ produtoId: uuidv7() })))['gruposComplementos.0.complementos.0.produtoId'],
    ).toEqual(['Produto inexistente']);
    expect(
      (await recusa(com({ produtoId: bacon, baixaEstoque: true, quantidadeBaixa: '0,5' })))[
        'gruposComplementos.0.complementos.0.quantidadeBaixa'
      ],
    ).toEqual(['O produto BACON EM CUBOS PORCAO não permite fração: informe uma quantidade inteira']);
    // As regras dos CHECKs (MD 3.6.8) chegam como 422 no campo, antes do banco.
    expect((await recusa([{ ...molhos(), minimo: 3, maximo: 2 }]))['gruposComplementos.0.maximo']).toEqual([
      'O máximo não pode ser menor que o mínimo',
    ]);
    expect(
      (await recusa(com({ descricao: 'Livre', baixaEstoque: true })))[
        'gruposComplementos.0.complementos.0.baixaEstoque'
      ],
    ).toEqual(['Só o complemento vinculado a um produto baixa estoque']);

    // O vinculado inativo não entra num complemento novo.
    const inativo = await alterar(bacon, { ativo: false });
    expect(inativo.status, JSON.stringify(inativo.body)).toBe(200);
    expect(
      (await recusa(com({ produtoId: bacon })))['gruposComplementos.0.complementos.0.produtoId'],
    ).toEqual(['O produto BACON EM CUBOS PORCAO está inativo']);
    expect((await alterar(bacon, { ativo: true })).status).toBe(200);
  });

  it('o vinculado ativo não se exclui nem vira um tipo que não pode ser complemento', async () => {
    const excluir = await amb.http().delete(`/api/produtos/${cheddar}`).set(bearer());
    expect(excluir.status).toBe(422);
    expect(excluir.body.mensagem).toMatch(/complemento de \d+ - PORÇÃO DE BATATA FRITA/);
    const troca = await alterar(cheddar, { tipo: 'servico', controlaEstoque: false, precoVenda: '5' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(422);
    expect(troca.body.campos.tipo[0]).toMatch(/^O produto é complemento de \d+ - PORÇÃO DE BATATA FRITA/);
  });

  describe('a "Porção de mandioca" com o vinculado próprio (AZEITONA VERDE)', () => {
    let mandioca: string;
    let azeitona: string;

    it('o vinculado inativado depois não trava o resto do cadastro; reativar o complemento dele, sim', async () => {
      const a = await criar({ nome: 'AZEITONA VERDE' });
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      azeitona = a.body.id as string;
      const m = await criar({
        nome: 'PORÇÃO DE MANDIOCA',
        tipo: 'com_complementos',
        gruposComplementos: [
          { nome: 'Extras', maximo: 2, complementos: [{ produtoId: azeitona, precoAdicional: '4' }] },
        ],
      });
      expect(m.status, JSON.stringify(m.body)).toBe(201);
      mandioca = m.body.id as string;

      // A inativação do produto não é barrada pelo complemento (só a exclusão e a troca de tipo são).
      expect((await alterar(azeitona, { ativo: false })).status).toBe(200);
      // O ERP manda a lista inteira de volta: o complemento gravado que não mudou não é conferido de novo.
      const r = await alterar(mandioca, { localizacao: 'COZINHA' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((r.body as ProdutoDetalhe).gruposComplementos[0]!.complementos[0]).toMatchObject({
        produtoId: azeitona,
        ativo: true,
      });
      // Inativar o complemento do produto inativo passa; reativá-lo com o produto ainda inativo, não.
      const grupos = corpoGrupos(r.body as ProdutoDetalhe);
      grupos[0]!.complementos[0]!.ativo = false;
      const inativado = await alterar(mandioca, { gruposComplementos: grupos });
      expect(inativado.status, JSON.stringify(inativado.body)).toBe(200);
      const volta = corpoGrupos(inativado.body as ProdutoDetalhe);
      volta[0]!.complementos[0]!.ativo = true;
      const reativar = await alterar(mandioca, { gruposComplementos: volta });
      expect(reativar.status, JSON.stringify(reativar.body)).toBe(422);
      expect(reativar.body.campos['gruposComplementos.0.complementos.0.produtoId']).toEqual([
        'O produto AZEITONA VERDE está inativo',
      ]);
      expect((await alterar(azeitona, { ativo: true })).status).toBe(200);
    });

    it('sem "Produtos: Alterar preço" e com a chave desligada, o preço adicional não muda', async () => {
      await consultar(
        emp.nomeBanco,
        `insert into configuracoes (escopo, chave, valor) values ('empresa', 'geral.altera_preco_produto_erp', 'false')`,
      );
      try {
        const d = await detalhe(mandioca);
        // Repetir o preço de agora não é alteração.
        const igual = await alterar(mandioca, { localizacao: 'BALCAO' }, estoquista, d);
        expect(igual.status, JSON.stringify(igual.body)).toBe(200);
        // O detalhe completo (o do estoquista vem sem o custo).
        const base = await detalhe(mandioca);
        const mudar = async (mexer: (g: ReturnType<typeof corpoGrupos>) => void) => {
          const grupos = corpoGrupos(base);
          mexer(grupos);
          return alterar(mandioca, { gruposComplementos: grupos }, estoquista, base);
        };
        const preco = await mudar((g) => (g[0]!.complementos[0]!.precoAdicional = '5.0000'));
        expect(preco.status, JSON.stringify(preco.body)).toBe(403);
        expect(preco.body.mensagem).toBe('Alterar preço no ERP exige "Produtos: Alterar preço".');
        const novoComPreco = await mudar((g) =>
          g[0]!.complementos.push({ descricao: 'Farofa', precoAdicional: '1,00' } as never),
        );
        expect(novoComPreco.status).toBe(403);
        // O complemento novo sem preço não é alteração de preço.
        const novoSemPreco = await mudar((g) => g[0]!.complementos.push({ descricao: 'Farofa' } as never));
        expect(novoSemPreco.status, JSON.stringify(novoSemPreco.body)).toBe(200);
        expect(
          (await detalhe(mandioca)).gruposComplementos[0]!.complementos.map((c) => [
            c.descricao,
            c.precoAdicional,
          ]),
        ).toEqual([
          [null, '4.0000'],
          ['Farofa', '0.0000'],
        ]);
      } finally {
        await consultar(
          emp.nomeBanco,
          `delete from configuracoes where chave = 'geral.altera_preco_produto_erp'`,
        );
      }
    });

    it('corrida: o vinculado excluído por outra transação ao mesmo tempo não entra num complemento novo', async () => {
      const pi = await criar({ nome: 'PICLES EM CONSERVA' });
      expect(pi.status, JSON.stringify(pi.body)).toBe(201);
      const picles = pi.body.id as string;
      const d = await detalhe(mandioca);
      const grupos = corpoGrupos(d);
      grupos[0]!.complementos.push({ produtoId: picles } as never);
      // A outra transação faz o que a exclusão faz (trava a linha, confere e marca `excluido_em`) e ainda não deu commit.
      const outra = await conectar(emp.nomeBanco);
      try {
        const pid = (await outra.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
        await outra.query('begin');
        await outra.query('select id from produtos where id = $1 for update', [picles]);
        await outra.query('update produtos set excluido_em = now() where id = $1', [picles]);
        const pu = alterar(mandioca, { gruposComplementos: grupos }, admin, d).then((x) => x);
        for (let i = 0; ; i++) {
          const espera = await consultar(
            emp.nomeBanco,
            `select 1 from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and pid <> $2`,
            [emp.nomeBanco, pid],
          );
          if (espera.length) break;
          if (i > 250) throw new Error('o PUT não chegou a esperar a trava');
          await new Promise((ok) => setTimeout(ok, 20));
        }
        await outra.query('commit');
        // O PUT esperou a outra (a trava de ordenação do início da transação; o `for share` do vinculado garante o
        // mesmo sem ela) e leu o produto já excluído.
        const r = await pu;
        expect(r.status, JSON.stringify(r.body)).toBe(422);
        expect(
          r.body.campos['gruposComplementos.0.complementos.2.produtoId'],
          JSON.stringify(r.body),
        ).toEqual(['Produto inexistente']);
      } finally {
        await outra.end();
      }
    });

    it('o complemento inativo num grupo vivo não conta: o vinculado volta a poder ser excluído', async () => {
      // Ativo: a exclusão é recusada.
      const ativar = corpoGrupos(await detalhe(mandioca));
      ativar[0]!.complementos[0]!.ativo = true;
      const ativo = await alterar(mandioca, { gruposComplementos: ativar });
      expect(ativo.status, JSON.stringify(ativo.body)).toBe(200);
      expect((await amb.http().delete(`/api/produtos/${azeitona}`).set(bearer())).status).toBe(422);
      // Inativado, com o grupo vivo: a exclusão passa.
      const grupos = corpoGrupos(ativo.body as ProdutoDetalhe);
      grupos[0]!.complementos[0]!.ativo = false;
      const r = await alterar(mandioca, { gruposComplementos: grupos }, admin, ativo.body as ProdutoDetalhe);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      // O grupo continua vivo, com o complemento inativo dentro.
      expect((await detalhe(mandioca)).gruposComplementos[0]!.complementos[0]).toMatchObject({
        produtoId: azeitona,
        ativo: false,
      });
      expect((await amb.http().delete(`/api/produtos/${azeitona}`).set(bearer())).status).toBe(204);
      // O que mudou aqui não entra na conferência do pull dos próximos testes.
      cursor = (await puxar(cursor)).cursor;
    });
  });

  it('sair do tipo exige a lista; a lista vazia exclui o grupo com os complementos (tombstone), sem apagar nada', async () => {
    const semLista = await detalhe(porcao);
    const { gruposComplementos: _g, ...corpo } = semLista;
    const r = await amb
      .http()
      .put(`/api/produtos/${porcao}`)
      .set(bearer())
      .send({ ...corpo, tipo: 'simples' });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.campos.tipo[0]).toMatch(/^O produto tem grupos de complementos/);

    const ok = await alterar(porcao, { tipo: 'simples', gruposComplementos: [] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as ProdutoDetalhe).gruposComplementos).toEqual([]);
    const p = await puxar(cursor);
    cursor = p.cursor;
    expect(daTabela(p, 'produtos_grupos_complementos')).toEqual([
      expect.objectContaining({ produto_id: porcao, excluido_em: expect.any(String) }),
    ]);
    const opcoes = daTabela(p, 'produtos_complementos');
    expect(opcoes).toHaveLength(2);
    for (const o of opcoes) expect(o).toMatchObject({ ativo: false, excluido_em: expect.any(String) });
    // As linhas continuam na nuvem (o caixa offline pode ter o id numa venda).
    const [n] = await consultar<{ g: number; c: number }>(
      emp.nomeBanco,
      `select (select count(*)::int from produtos_grupos_complementos where produto_id = $1) as g,
              (select count(*)::int from produtos_complementos c join produtos_grupos_complementos x on x.id = c.grupo_id
                where x.produto_id = $1) as c`,
      [porcao],
    );
    expect(n).toEqual({ g: 1, c: 2 });
    // Sem complemento ativo, o cheddar volta a poder ser excluído.
    expect((await amb.http().delete(`/api/produtos/${cheddar}`).set(bearer())).status).toBe(204);
  });

  it('excluir o produto exclui os grupos e os complementos (lógico)', async () => {
    const r = await criar({
      nome: 'PORÇÃO DE CALABRESA',
      tipo: 'com_complementos',
      gruposComplementos: [
        { nome: 'Molhos', maximo: 2, complementos: [{ descricao: 'Vinagrete' }, { produtoId: bacon }] },
        {
          nome: 'Pão',
          minimo: 1,
          maximo: 1,
          obrigatorio: true,
          complementos: [{ descricao: 'Pão francês' }],
        },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    expect((await amb.http().delete(`/api/produtos/${id}`).set(bearer())).status).toBe(204);
    const linhas = await consultar<{ t: string; vivo: boolean; ativo: boolean | null }>(
      emp.nomeBanco,
      `select 'g' as t, g.excluido_em is null as vivo, null::boolean as ativo
         from produtos_grupos_complementos g where g.produto_id = $1
       union all
       select 'c', c.excluido_em is null, c.ativo
         from produtos_complementos c join produtos_grupos_complementos g on g.id = c.grupo_id where g.produto_id = $1`,
      [id],
    );
    expect(linhas).toHaveLength(5);
    expect(linhas.every((l) => !l.vivo && l.ativo !== true)).toBe(true);
  });
});
