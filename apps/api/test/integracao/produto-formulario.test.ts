/**
 * Formulário do produto: "Ajustar" do bloco Estoque e produtos relacionados (Fase 2, F2-B12; ERP 8.2.8, 8.2.11;
 * README da API › decisão 157), pela API do ERP. O "Ajustar" cria e efetiva um "Definir" de um item com a origem
 * `cadastro_produto` (movimento `AJUSTE_CADASTRO`), que aparece no razão e desce ao PDV no fluxo `estoque`; a hora da
 * contagem informada desconta os movimentos posteriores (13.1.5); o produzido (sem saldo próprio, decisão 91) e o
 * produto sem controle de estoque são recusados; sem `estoque_acertos.criar` é 403, e fora dos estoques permitidos
 * também. Os relacionados gravam com o produto, com auditoria antes/depois; "Criar relação inversa" grava a do outro
 * produto (e a auditoria dele), remover não a remove, o corpo sem `relacionados` mantém os gravados, e a exclusão do
 * produto tira as relações nos dois sentidos. A inversa não leva o outro produto além do teto de relacionados (senão
 * ele não grava mais pelo formulário) e exige `produtos.editar` (altera o outro produto). O razão refaz as projeções
 * idênticas no fim (`conferirRazaoDoBanco`).
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MAXIMO_RELACIONADOS, respostaPullSchema, type Ativar } from '@genesis/shared';
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
let loja: string;
let estoqueLoja: string;
let disponivel: string;
let tokenAdmin: string;
let tokenVendedor: string;
/** Estoquista só com o estoque da loja: o CD fica fora dos permitidos. */
let tokenEstoquista: string;
let cd: string;
let un: string;

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

/** Terminal ativado pelo `/sync/ativar` real num caixa novo da loja; devolve o token. */
async function ativarTerminal(): Promise<string> {
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [loja, 'Caixa 01'],
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
  return r.body.token as string;
}

type Alteracao = { tabela: string; linha: Record<string, unknown> };

/** Páginas do fluxo `estoque` desde `desde`, como o PDV. */
async function puxarEstoque(token: string, desde: number) {
  const alteracoes: Alteracao[] = [];
  let cursor = desde;
  for (let i = 0; i < 50; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=estoque&desde=${cursor}&limite=2000`)
      .set(cabecalhos(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...(r.body.alteracoes as Alteracao[]));
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { alteracoes, cursor };
  }
  throw new Error('pull não terminou');
}

async function criarProduto(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome, unidadeId: un, precoVenda: '5', precoCusto: '2', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

const ajustar = (produto: string, corpo: Record<string, unknown>, token = tokenAdmin) =>
  amb
    .http()
    .post(`/api/produtos/${produto}/ajustar-estoque`)
    .set(bearer(token))
    .send({ estoqueId: estoqueLoja, motivo: 'Inventário', ...corpo });

async function saldo(produto: string, estoque = estoqueLoja): Promise<string> {
  const [s] = await consultar<{ q: string }>(
    emp.nomeBanco,
    `select quantidade::text as q from saldos_estoque
      where estoque_id = $1 and produto_id = $2 and tipo_estoque_id = $3`,
    [estoque, produto, disponivel],
  );
  return s?.q ?? '0.000';
}

const movimentosDoProduto = (produto: string) =>
  consultar<{ tipo_movimento: string; quantidade: string; documento_id: string; data_movimento: Date }>(
    emp.nomeBanco,
    `select tipo_movimento, quantidade::text, documento_id, data_movimento from movimentos_estoque
      where produto_id = $1 order by seq_lancamento`,
    [produto],
  );

async function detalhe(produto: string) {
  const r = await amb.http().get(`/api/produtos/${produto}`).set(bearer());
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Record<string, unknown> & {
    versao: number;
    relacionados: Array<{ relacionadoId: string; tipo: string; inversa: boolean; produto: { nome: string } }>;
  };
}

/** Corpo do PUT a partir do detalhe (o que o formulário manda), com `relacionados` trocado quando informado. */
async function gravar(produto: string, relacionados?: unknown[]) {
  const d = await detalhe(produto);
  const r = await amb
    .http()
    .put(`/api/produtos/${produto}`)
    .set(bearer())
    .send({
      nome: d.nome,
      unidadeId: un,
      precoVenda: d.precoVenda,
      precoCusto: d.precoCusto,
      versao: d.versao,
      ...(relacionados !== undefined ? { relacionados } : {}),
    });
  return r;
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  tokenAdmin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  [{ estoque_id: estoqueLoja }] = (await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [loja],
  )) as [{ estoque_id: string }];
  [{ id: cd }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    `insert into estoques (nome, tipo) values ('CD - Estoque Teste', 'deposito') returning id`,
  )) as [{ id: string }];
  await criarUsuario(emp.nomeBanco, { login: 'vendedor', perfil: 'vendedor', lojas: [loja] });
  tokenVendedor = await amb.entrar(emp.codigo, 'vendedor', SENHA_TESTE);
  await criarUsuario(emp.nomeBanco, {
    login: 'estoquista',
    perfil: 'estoquista',
    lojas: [loja],
    estoques: [estoqueLoja],
  });
  tokenEstoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  [{ id: disponivel }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    `select id from tipos_estoque where chave_sistema = 'disponivel'`,
  )) as [{ id: string }];
  const unidades = (await amb.http().get('/api/referencias/unidades').set(bearer())).body as Array<{
    id: string;
    sigla: string;
  }>;
  un = unidades.find((u) => u.sigla === 'UN')!.id;
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('"Ajustar" do bloco Estoque do produto (F2-B12; ERP 8.2.11)', () => {
  it('cria e efetiva um Definir de origem cadastro_produto (AJUSTE_CADASTRO), que aparece no razão e no PDV', async () => {
    const token = await ativarTerminal();
    const { cursor } = await puxarEstoque(token, 0);
    const prod = await criarProduto('CERV AJUSTAR LOJA 1');

    const r = await ajustar(prod, { quantidade: '10' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ diferenca: '10.000', movimentos: 1, compensacoes: 0 });
    expect(await saldo(prod)).toBe('10.000');
    const [a] = await consultar<Record<string, unknown>>(
      emp.nomeBanco,
      `select codigo, origem, tipo_ajuste, status, motivo, responsavel_id is not null as tem_responsavel
         from acertos_estoque where id = $1`,
      [r.body.acertoId],
    );
    expect(a).toMatchObject({
      codigo: r.body.codigo,
      origem: 'cadastro_produto',
      tipo_ajuste: 'definir',
      status: 'efetivado',
      motivo: 'Inventário',
      tem_responsavel: true,
    });
    // O detalhe do acerto (tela de acertos) mostra a origem do cadastro.
    const det = await amb.http().get(`/api/acertos/${r.body.acertoId}`).set(bearer());
    expect(det.status).toBe(200);
    expect(det.body).toMatchObject({ origem: 'cadastro_produto', status: 'efetivado' });

    // Nova quantidade 7: a diferença é −3.
    const r2 = await ajustar(prod, { quantidade: '7' });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.diferenca).toBe('-3.000');
    expect((await movimentosDoProduto(prod)).map((m) => [m.tipo_movimento, m.quantidade])).toEqual([
      ['AJUSTE_CADASTRO', '10.000'],
      ['AJUSTE_CADASTRO', '-3.000'],
    ]);

    // O PDV da loja recebe a linha de saldo com o 7.
    const { alteracoes } = await puxarEstoque(token, cursor);
    const linhas = alteracoes.filter((x) => x.tabela === 'saldos_estoque' && x.linha.produto_id === prod);
    expect(linhas.length).toBeGreaterThan(0);
    expect(Number(linhas.at(-1)!.linha.quantidade)).toBe(7);

    // Auditoria no acerto (criar + efetivar), com a localização do cadastro de produtos.
    const auds = await consultar<{ acao: string; localizacao: string }>(
      emp.nomeBanco,
      `select acao, localizacao from auditoria where entidade = 'acertos_estoque' and registro_id = $1
        order by ocorrido_em, acao`,
      [r.body.acertoId],
    );
    expect(auds.map((x) => x.acao).sort()).toEqual(['criar', 'efetivar']);
    expect(new Set(auds.map((x) => x.localizacao))).toEqual(new Set(['Produtos › Cadastro de produtos']));
    await conferirRazaoDoBanco(emp.nomeBanco);
  });

  it('a hora da contagem informada desconta os movimentos posteriores (ERP 13.1.5)', async () => {
    const prod = await criarProduto('CERV AJUSTAR CONTAGEM');
    const contagem = new Date(Date.now() - 60 * 60_000).toISOString();
    // Entrada de 10 agora, depois da contagem de 1 hora atrás.
    const ent = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoqueLoja,
        tipoAjuste: 'entrada',
        dataContagem: new Date().toISOString(),
        motivo: 'Bonificação',
        itens: [{ produtoId: prod, quantidade: '10', custoUnitario: '2' }],
      });
    expect(ent.status, JSON.stringify(ent.body)).toBe(201);
    const ef = await amb
      .http()
      .post(`/api/acertos/${ent.body.id}/efetivar`)
      .set(bearer())
      .send({ versao: ent.body.versao });
    expect(ef.status, JSON.stringify(ef.body)).toBe(200);

    // Contou 4 uma hora atrás (antes da entrada): +4 na contagem, e o saldo de agora fica 14.
    const r = await ajustar(prod, { quantidade: '4', dataContagem: contagem });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.diferenca).toBe('4.000');
    expect(await saldo(prod)).toBe('14.000');
    const ajuste = (await movimentosDoProduto(prod)).find((m) => m.tipo_movimento === 'AJUSTE_CADASTRO')!;
    expect(new Date(ajuste.data_movimento).toISOString()).toBe(contagem);
    await conferirRazaoDoBanco(emp.nomeBanco);
  });

  it('recusa o produzido (sem saldo próprio, decisão 91) e o produto sem controle de estoque', async () => {
    const insumo = await criarProduto('MALTE AJUSTAR', { tipo: 'materia_prima', precoVenda: '0' });
    const produzido = await criarProduto('CHOPP AJUSTAR', {
      tipo: 'produzido',
      usaFichaTecnica: true,
      componentes: [{ tipo: 'ficha_tecnica', componenteId: insumo, quantidade: '1' }],
    });
    const r = await ajustar(produzido, { quantidade: '5' });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.mensagem).toMatch(/produzido não tem estoque próprio/i);

    const taxa = await criarProduto('TAXA AJUSTAR', { controlaEstoque: false });
    const r2 = await ajustar(taxa, { quantidade: '5' });
    expect(r2.status, JSON.stringify(r2.body)).toBe(422);
    expect(r2.body.mensagem).toMatch(/não controla estoque/);
    // Nada foi gravado.
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from acertos_estoque a join itens_acerto_estoque i on i.acerto_id = a.id
        where i.produto_id = any($1::uuid[])`,
      [[produzido, taxa]],
    );
    expect(n!.n).toBe(0);
  });

  it('exige estoque_acertos.criar e o estoque permitido para movimentar', async () => {
    const prod = await criarProduto('CERV AJUSTAR PERMISSAO');
    const semPermissao = await ajustar(prod, { quantidade: '1' }, tokenVendedor);
    expect(semPermissao.status).toBe(403);
    const foraDoPermitido = await ajustar(prod, { estoqueId: cd, quantidade: '1' }, tokenEstoquista);
    expect(foraDoPermitido.status, JSON.stringify(foraDoPermitido.body)).toBe(403);
    expect(foraDoPermitido.body.campos).toEqual({ estoqueId: ['Fora dos seus estoques permitidos'] });
    // No estoque da loja, o estoquista ajusta.
    const ok = await ajustar(prod, { quantidade: '2' }, tokenEstoquista);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await saldo(prod)).toBe('2.000');
    // E o CD, para o admin (todos os estoques).
    const noCd = await ajustar(prod, { estoqueId: cd, quantidade: '30' });
    expect(noCd.status, JSON.stringify(noCd.body)).toBe(200);
    expect(await saldo(prod, cd)).toBe('30.000');
    await conferirRazaoDoBanco(emp.nomeBanco);
  });

  it('valida o contrato: quantidade não negativa, motivo e hora futura', async () => {
    const prod = await criarProduto('CERV AJUSTAR CONTRATO');
    const r = await amb
      .http()
      .post(`/api/produtos/${prod}/ajustar-estoque`)
      .set(bearer())
      .send({
        estoqueId: estoqueLoja,
        quantidade: '-1',
        motivo: '',
        dataContagem: new Date(Date.now() + 86_400_000).toISOString(),
      });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.campos).sort()).toEqual(['dataContagem', 'motivo', 'quantidade']);
  });
});

describe('produtos relacionados (F2-B12; ERP 8.2.8)', () => {
  it('liga um relacionado nas duas direções pela "relação inversa", com auditoria nos dois produtos', async () => {
    const gelo = await criarProduto('GELO 5KG REL');
    const cerveja = await criarProduto('CERV LATA REL', {
      relacionados: [{ relacionadoId: gelo, tipo: 'sugestao', criarInversa: true }],
    });
    const dc = await detalhe(cerveja);
    expect(dc.relacionados).toMatchObject([
      { relacionadoId: gelo, tipo: 'sugestao', inversa: true, produto: { nome: 'GELO 5KG REL' } },
    ]);
    const dg = await detalhe(gelo);
    expect(dg.relacionados).toMatchObject([{ relacionadoId: cerveja, tipo: 'sugestao', inversa: true }]);

    // Auditoria do gelo: a relação veio do cadastro da cerveja.
    const [aud] = await consultar<{ descricao: string; antes: unknown; depois: unknown }>(
      emp.nomeBanco,
      `select descricao, antes, depois from auditoria where entidade = 'produtos' and registro_id = $1 and acao = 'editar'`,
      [gelo],
    );
    expect(aud!.descricao).toMatch(
      /Relação inversa \(sugestao\) criada pelo cadastro do produto \d+ - CERV LATA REL/,
    );
    expect(aud!.antes).toEqual({ relacionados: [] });
    expect(aud!.depois).toEqual({ relacionados: [{ relacionadoId: cerveja, tipo: 'sugestao', ordem: 1 }] });

    // Sem `relacionados` no corpo (importação, ERP antigo): mantém.
    const sem = await gravar(cerveja);
    expect(sem.status, JSON.stringify(sem.body)).toBe(200);
    expect(sem.body.relacionados).toHaveLength(1);

    // Trocar o tipo e remover: a inversa (do gelo) fica.
    const troca = await gravar(cerveja, [{ relacionadoId: gelo, tipo: 'acessorio' }]);
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(troca.body.relacionados).toMatchObject([
      { relacionadoId: gelo, tipo: 'acessorio', inversa: false },
    ]);
    const vazio = await gravar(cerveja, []);
    expect(vazio.status, JSON.stringify(vazio.body)).toBe(200);
    expect(vazio.body.relacionados).toEqual([]);
    expect((await detalhe(gelo)).relacionados).toMatchObject([{ relacionadoId: cerveja, tipo: 'sugestao' }]);

    // Auditoria antes/depois na cerveja.
    const [ed] = await consultar<{ antes: { relacionados: unknown[] }; depois: { relacionados: unknown[] } }>(
      emp.nomeBanco,
      `select antes, depois from auditoria where entidade = 'produtos' and registro_id = $1 and acao = 'editar'
        order by ocorrido_em desc limit 1`,
      [cerveja],
    );
    expect(ed!.antes.relacionados).toHaveLength(1);
    expect(ed!.depois.relacionados).toEqual([]);
  });

  it('recusa o próprio produto, o inexistente e o repetido com o mesmo tipo', async () => {
    const a = await criarProduto('PROD REL A');
    const b = await criarProduto('PROD REL B');
    const proprio = await gravar(a, [{ relacionadoId: a, tipo: 'sugestao' }]);
    expect(proprio.status).toBe(422);
    expect(proprio.body.campos['relacionados.0.relacionadoId']).toEqual([
      'O produto não pode ser relacionado a si mesmo',
    ]);
    const inexistente = await gravar(a, [{ relacionadoId: uuidv7(), tipo: 'sugestao' }]);
    expect(inexistente.status).toBe(422);
    expect(inexistente.body.campos['relacionados.0.relacionadoId']).toEqual(['Produto inexistente']);
    const repetido = await gravar(a, [
      { relacionadoId: b, tipo: 'sugestao' },
      { relacionadoId: b, tipo: 'sugestao' },
    ]);
    expect(repetido.status).toBe(422);
    // O mesmo produto com outro tipo é outra relação.
    const doisTipos = await gravar(a, [
      { relacionadoId: b, tipo: 'sugestao' },
      { relacionadoId: b, tipo: 'substituto' },
    ]);
    expect(doisTipos.status, JSON.stringify(doisTipos.body)).toBe(200);
    expect(doisTipos.body.relacionados.map((r: { tipo: string }) => r.tipo)).toEqual([
      'sugestao',
      'substituto',
    ]);
  });

  it('a inversa não leva o outro produto além do teto de relacionados (ele continua gravando pelo formulário)', async () => {
    expect(MAXIMO_RELACIONADOS).toBe(50);
    const gelo = await criarProduto('GELO TETO REL');
    // 17 produtos × 3 tipos = 51 combinações: o gelo fica com 49 (uma vaga).
    const outros: string[] = [];
    for (let i = 1; i <= 17; i++) outros.push(await criarProduto(`CERV TETO REL ${i}`));
    const tipos = ['sugestao', 'substituto', 'acessorio'];
    const lista = outros.flatMap((o) => tipos.map((tipo) => ({ relacionadoId: o, tipo }))).slice(0, 49);
    const base = await gravar(gelo, lista);
    expect(base.status, JSON.stringify(base.body)).toBe(200);

    // Duas inversas para o gelo no mesmo corpo: a segunda passaria de 50 e é recusada no campo dela; nada é gravado.
    const duas = await amb
      .http()
      .post('/api/produtos')
      .set(bearer())
      .send({
        nome: 'CERV TETO DUAS',
        unidadeId: un,
        precoVenda: '5',
        relacionados: [
          { relacionadoId: gelo, tipo: 'sugestao', criarInversa: true },
          { relacionadoId: gelo, tipo: 'acessorio', criarInversa: true },
        ],
      });
    expect(duas.status, JSON.stringify(duas.body)).toBe(422);
    expect(Object.keys(duas.body.campos)).toEqual(['relacionados.1.criarInversa']);
    expect(duas.body.campos['relacionados.1.criarInversa'][0]).toMatch(
      /O produto \d+ - GELO TETO REL já tem 50 produtos relacionados/,
    );
    expect((await detalhe(gelo)).relacionados).toHaveLength(49);

    // Uma só: cabe (50).
    const cerveja = await criarProduto('CERV TETO UMA', {
      relacionados: [{ relacionadoId: gelo, tipo: 'sugestao', criarInversa: true }],
    });
    expect((await detalhe(gelo)).relacionados).toHaveLength(50);
    // Pedir de novo a inversa que já existe não conta.
    const repete = await gravar(cerveja, [{ relacionadoId: gelo, tipo: 'sugestao', criarInversa: true }]);
    expect(repete.status, JSON.stringify(repete.body)).toBe(200);
    // Outra cerveja: o gelo já está cheio.
    const cheio = await amb
      .http()
      .post('/api/produtos')
      .set(bearer())
      .send({
        nome: 'CERV TETO CHEIO',
        unidadeId: un,
        precoVenda: '5',
        relacionados: [{ relacionadoId: gelo, tipo: 'sugestao', criarInversa: true }],
      });
    expect(cheio.status, JSON.stringify(cheio.body)).toBe(422);
    expect(Object.keys(cheio.body.campos)).toEqual(['relacionados.0.criarInversa']);
    // Sem a inversa, a relação deste lado grava (o teto é do gelo).
    await criarProduto('CERV TETO SEM INVERSA', {
      relacionados: [{ relacionadoId: gelo, tipo: 'sugestao' }],
    });

    // O gelo, com 50, continua gravando pelo formulário (lista inteira) só para mudar o preço.
    const dg = await detalhe(gelo);
    const preco = await amb
      .http()
      .put(`/api/produtos/${gelo}`)
      .set(bearer())
      .send({
        nome: dg.nome,
        unidadeId: un,
        precoVenda: '9',
        versao: dg.versao,
        relacionados: dg.relacionados.map((r, i) => ({
          relacionadoId: r.relacionadoId,
          tipo: r.tipo,
          ordem: i + 1,
        })),
      });
    expect(preco.status, JSON.stringify(preco.body)).toBe(200);
    expect(preco.body.relacionados).toHaveLength(50);
  }, 60_000);

  it('"Criar relação inversa" exige produtos.editar (altera o outro produto), também no POST', async () => {
    const [perfil] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into perfis (nome, descricao, chave_sistema) values ('Só cria produto', 'teste', 'teste_cria_produto') returning id",
    );
    for (const permissao of ['produtos.ver', 'produtos.criar'])
      await consultar(emp.nomeBanco, 'insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [
        perfil!.id,
        permissao,
      ]);
    await criarUsuario(emp.nomeBanco, { login: 'criaproduto', perfil: 'teste_cria_produto', lojas: [loja] });
    const token = await amb.entrar(emp.codigo, 'criaproduto', SENHA_TESTE);
    const copo = await criarProduto('COPO PERM REL');
    const versaoAntes = (await detalhe(copo)).versao;
    const corpo = (criarInversa: boolean) => ({
      nome: `CHOPP PERM REL ${criarInversa ? 'INV' : 'SO'}`,
      unidadeId: un,
      precoVenda: '5',
      relacionados: [{ relacionadoId: copo, tipo: 'acessorio', criarInversa }],
    });
    const comInversa = await amb.http().post('/api/produtos').set(bearer(token)).send(corpo(true));
    expect(comInversa.status, JSON.stringify(comInversa.body)).toBe(403);
    expect(Object.keys(comInversa.body.campos)).toEqual(['relacionados.0.criarInversa']);
    const dc = await detalhe(copo);
    expect(dc.relacionados).toEqual([]);
    expect(dc.versao).toBe(versaoAntes);
    // Só neste sentido, cria.
    const so = await amb.http().post('/api/produtos').set(bearer(token)).send(corpo(false));
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    expect((await detalhe(copo)).relacionados).toEqual([]);
  });

  it('excluir o produto tira as relações nos dois sentidos', async () => {
    const copo = await criarProduto('COPO REL');
    const chopp = await criarProduto('CHOPP REL', {
      relacionados: [{ relacionadoId: copo, tipo: 'acessorio', criarInversa: true }],
    });
    const r = await amb.http().delete(`/api/produtos/${copo}`).set(bearer());
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect((await detalhe(chopp)).relacionados).toEqual([]);
    const [n] = await consultar<{ n: number }>(
      emp.nomeBanco,
      `select count(*)::int as n from produtos_relacionados
        where (produto_id = $1 or relacionado_id = $1) and excluido_em is null`,
      [copo],
    );
    expect(n!.n).toBe(0);
  });
});
