/**
 * Formas de pagamento personalizadas por loja (Fase 1C, bloco C8b; pedido do dono O9a/D25; MD 3.10.1): CRUD com as
 * lojas da forma (`formas_pagamento_lojas`, linha de loja nula = todas), permissões por loja, regra do troco (O23) e a
 * descida no fluxo `configuracao` só ao caixa das lojas em que a forma vale, com a exclusão do vínculo tirando a forma do
 * caixa que deixou de tê-la. Critério de pronto: "Fiado Balcão" só na Loja Treino desce só para o caixa dessa loja.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { respostaPullSchema, type Ativar } from '@genesis/shared';
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

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

type Alteracao = { tabela: string; versao: number; linha: Record<string, unknown> };
interface Caixa {
  lojaId: string;
  token: string;
  cursor: number;
}

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let gerente: string;
let hermes: string;
let treino: string;
let caixaHermes: Caixa;
let caixaTreino: Caixa;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
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

async function ativar(lojaId: string): Promise<Caixa> {
  const [{ id: caixaId }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [lojaId, 'Caixa 01'],
  )) as [{ id: string }];
  const g = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer(admin))
    .send({ lojaId, caixaId, validadeHoras: 1 });
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
  return { lojaId, token: r.body.token as string, cursor: 0 };
}

/** Páginas do `configuracao` desde o cursor do caixa até `tem_mais = false`; o cursor do caixa avança. */
async function puxar(c: Caixa): Promise<Alteracao[]> {
  const alteracoes: Alteracao[] = [];
  for (let i = 0; i < 100; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=configuracao&desde=${c.cursor}&limite=2000`)
      .set(cabecalhos(c.token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...(r.body.alteracoes as Alteracao[]));
    c.cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return alteracoes;
  }
  throw new Error('pull não terminou');
}

const da = (alteracoes: Alteracao[], tabela: string) =>
  alteracoes.filter((a) => a.tabela === tabela).map((a) => a.linha);

/** Formas que o caixa ofereceria (a mesma regra de `CatalogoLocal.FormasPagamentoAsync` do PDV) depois de aplicar tudo. */
function oferecidas(todas: Alteracao[]): string[] {
  const ultima = new Map<string, Record<string, unknown>>();
  for (const a of [...todas].sort((x, y) => x.versao - y.versao))
    ultima.set(`${a.tabela}:${a.linha.id}`, a.linha);
  const linhas = [...ultima.entries()];
  const vinculos = linhas
    .filter(([k, l]) => k.startsWith('formas_pagamento_lojas:') && l.excluido_em === null)
    .map(([, l]) => l.forma_pagamento_id);
  return linhas
    .filter(([k, l]) => k.startsWith('formas_pagamento:') && l.excluido_em === null && l.ativa && l.usa_pdv)
    .filter(([, l]) => vinculos.includes(l.id))
    .map(([, l]) => l.descricao as string)
    .sort();
}

async function corpoAtual(id: string): Promise<Record<string, unknown>> {
  const d = await amb.http().get(`/api/formas-pagamento/${id}`).set(bearer(admin));
  expect(d.status).toBe(200);
  const {
    id: _i,
    criadoEm: _c,
    atualizadoEm: _a,
    atualizadoPorNome: _n,
    senhaLiberacaoDefinida: _s,
    ...corpo
  } = d.body as Record<string, unknown>;
  return corpo;
}

async function alterar(id: string, mudar: Record<string, unknown>, token = admin) {
  return amb
    .http()
    .put(`/api/formas-pagamento/${id}`)
    .set(bearer(token))
    .send({ ...(await corpoAtual(id)), ...mudar });
}

const idDa = async (descricao: string) =>
  (
    await consultar<{ id: string }>(
      emp.nomeBanco,
      'select id from formas_pagamento where descricao = $1 and excluido_em is null',
      [descricao],
    )
  )[0]!.id;

let historicoHermes: Alteracao[] = [];
let historicoTreino: Alteracao[] = [];

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  hermes = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Hermes');
  treino = await criarLoja(emp.nomeBanco, 9, 'Loja Treino');
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  await criarUsuario(emp.nomeBanco, { login: 'gerente', perfil: 'gerente', lojas: [hermes] });
  gerente = await amb.entrar(emp.codigo, 'gerente', SENHA_TESTE);
  caixaHermes = await ativar(hermes);
  caixaTreino = await ativar(treino);
  historicoHermes = await puxar(caixaHermes);
  historicoTreino = await puxar(caixaTreino);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('formas de pagamento por loja (C8b, O9a/D25)', () => {
  it('seed: todas as formas valem em todas as lojas (vínculo de loja nula); VA/VR nascem inativas (O9a)', async () => {
    const vinculos = await consultar<{ n: number; nulos: number }>(
      emp.nomeBanco,
      `select count(*)::int as n, count(*) filter (where loja_id is null)::int as nulos
         from formas_pagamento_lojas where excluido_em is null`,
    );
    expect(vinculos[0]).toEqual({ n: 13, nulos: 13 });
    const va = await consultar<{ descricao: string; ativa: boolean }>(
      emp.nomeBanco,
      "select descricao, ativa from formas_pagamento where tipo_forma in ('vale_alimentacao','vale_refeicao') order by ordem",
    );
    expect(va).toEqual([
      { descricao: 'Vale Alimentação', ativa: false },
      { descricao: 'Vale Refeição', ativa: false },
    ]);
    // Carga inicial: as 13 formas e os 13 vínculos descem às duas lojas; o caixa oferece as ativas de uso no PDV.
    for (const h of [historicoHermes, historicoTreino]) {
      expect(da(h, 'formas_pagamento')).toHaveLength(13);
      expect(da(h, 'formas_pagamento_lojas')).toHaveLength(13);
      expect(oferecidas(h)).toEqual([
        'Caderneta',
        'Cartão de Crédito',
        'Cartão de Crédito Parcelado',
        'Cartão de Débito',
        'Crédito Funcionário',
        'Dinheiro',
        'PIX',
        'Vale Compra',
      ]);
      expect(da(h, 'formas_pagamento')[0]).toHaveProperty('exige_supervisor', false);
      expect(da(h, 'formas_pagamento')[0]).not.toHaveProperty('loja_id');
    }
  });

  it('pronto quando: "Fiado Balcão" só na Loja Treino desce só para o caixa dessa loja', async () => {
    const r = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({
        descricao: 'Fiado Balcão',
        tipoForma: 'outros',
        meioPagamentoFiscal: '99',
        descricaoFiscal: 'Fiado',
        lojaIds: [treino],
        exigeSupervisor: true,
        ordem: 20,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ lojaIds: [treino], exigeSupervisor: true, permiteTroco: false });

    const treinoNovas = await puxar(caixaTreino);
    expect(da(treinoNovas, 'formas_pagamento').map((f) => f.descricao)).toEqual(['Fiado Balcão']);
    expect(da(treinoNovas, 'formas_pagamento')[0]).toMatchObject({ exige_supervisor: true });
    expect(da(treinoNovas, 'formas_pagamento_lojas')).toMatchObject([
      { forma_pagamento_id: r.body.id, loja_id: treino, excluido_em: null },
    ]);
    historicoTreino.push(...treinoNovas);
    expect(oferecidas(historicoTreino)).toContain('Fiado Balcão');

    const hermesNovas = await puxar(caixaHermes);
    expect(hermesNovas).toEqual([]);
    expect(oferecidas(historicoHermes)).not.toContain('Fiado Balcão');

    // A listagem mostra a loja; o filtro por loja traz as de "todas" e as da loja.
    const lista = await amb
      .http()
      .get(`/api/formas-pagamento?situacao=todos&tamanho=50&lojaId=${hermes}`)
      .set(bearer(admin));
    expect(lista.body.itens.map((f: { descricao: string }) => f.descricao)).not.toContain('Fiado Balcão');
    const daTreino = await amb
      .http()
      .get(`/api/formas-pagamento?situacao=todos&tamanho=50&lojaId=${treino}`)
      .set(bearer(admin));
    expect(
      daTreino.body.itens.find((f: { descricao: string }) => f.descricao === 'Fiado Balcão'),
    ).toMatchObject({
      lojas: [{ id: treino, codigo: 9, nome: 'Loja Treino' }],
    });
    expect(daTreino.body.total).toBe(14);
  });

  it('ganhar uma loja toca a forma (desce ao caixa novo); perder tira só do caixa daquela loja', async () => {
    const fiado = await idDa('Fiado Balcão');
    expect((await alterar(fiado, { lojaIds: [treino, hermes] })).status).toBe(200);
    const hermesNovas = await puxar(caixaHermes);
    expect(da(hermesNovas, 'formas_pagamento').map((f) => f.descricao)).toEqual(['Fiado Balcão']);
    expect(da(hermesNovas, 'formas_pagamento_lojas')).toMatchObject([{ loja_id: hermes, excluido_em: null }]);
    historicoHermes.push(...hermesNovas);
    expect(oferecidas(historicoHermes)).toContain('Fiado Balcão');
    // A Loja Treino só vê a forma tocada (o vínculo novo da Hermes não desce para ela).
    const treinoNovas = await puxar(caixaTreino);
    expect(da(treinoNovas, 'formas_pagamento_lojas')).toEqual([]);
    historicoTreino.push(...treinoNovas);

    expect((await alterar(fiado, { lojaIds: [treino] })).status).toBe(200);
    const hermesDepois = await puxar(caixaHermes);
    expect(da(hermesDepois, 'formas_pagamento_lojas')).toMatchObject([{ loja_id: hermes }]);
    expect(da(hermesDepois, 'formas_pagamento_lojas')[0]!.excluido_em).not.toBeNull();
    historicoHermes.push(...hermesDepois);
    expect(oferecidas(historicoHermes)).not.toContain('Fiado Balcão');
    historicoTreino.push(...(await puxar(caixaTreino)));
    expect(oferecidas(historicoTreino)).toContain('Fiado Balcão');
  });

  it('"todas" → lojas escolhidas: a exclusão do vínculo de loja nula desce e tira a forma das outras lojas', async () => {
    const parcelado = await idDa('Cartão de Crédito Parcelado');
    expect((await alterar(parcelado, { lojaIds: [hermes] })).status).toBe(200);
    const treinoNovas = await puxar(caixaTreino);
    const vinculoNulo = da(treinoNovas, 'formas_pagamento_lojas');
    expect(vinculoNulo).toMatchObject([{ forma_pagamento_id: parcelado, loja_id: null }]);
    expect(vinculoNulo[0]!.excluido_em).not.toBeNull();
    historicoTreino.push(...treinoNovas);
    expect(oferecidas(historicoTreino)).not.toContain('Cartão de Crédito Parcelado');
    historicoHermes.push(...(await puxar(caixaHermes)));
    expect(oferecidas(historicoHermes)).toContain('Cartão de Crédito Parcelado');

    // De volta para "todas": a linha de loja nula volta (nova) e a da Hermes sai.
    expect((await alterar(parcelado, { lojaIds: [] })).status).toBe(200);
    historicoTreino.push(...(await puxar(caixaTreino)));
    historicoHermes.push(...(await puxar(caixaHermes)));
    expect(oferecidas(historicoTreino)).toContain('Cartão de Crédito Parcelado');
    expect(oferecidas(historicoHermes)).toContain('Cartão de Crédito Parcelado');
    const vivos = await consultar<{ loja_id: string | null }>(
      emp.nomeBanco,
      'select loja_id from formas_pagamento_lojas where forma_pagamento_id = $1 and excluido_em is null',
      [parcelado],
    );
    expect(vivos).toEqual([{ loja_id: null }]);
    // Gravar sem mudar as lojas não toca a forma nem cria vínculo.
    const antes = (await corpoAtual(parcelado)).versao;
    expect((await alterar(parcelado, {})).status).toBe(200);
    expect((await corpoAtual(parcelado)).versao).toBe(antes);
  });

  it('excluir a forma desce a exclusão aos caixas que a tinham', async () => {
    const r = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({
        descricao: 'Ticket Treino',
        meioPagamentoFiscal: '99',
        descricaoFiscal: 'Ticket',
        lojaIds: [treino],
      });
    expect(r.status).toBe(201);
    historicoTreino.push(...(await puxar(caixaTreino)));
    expect(oferecidas(historicoTreino)).toContain('Ticket Treino');
    expect((await amb.http().delete(`/api/formas-pagamento/${r.body.id}`).set(bearer(admin))).status).toBe(
      204,
    );
    const novas = await puxar(caixaTreino);
    expect(da(novas, 'formas_pagamento')).toMatchObject([{ id: r.body.id }]);
    expect(da(novas, 'formas_pagamento')[0]!.excluido_em).not.toBeNull();
    historicoTreino.push(...novas);
    expect(oferecidas(historicoTreino)).not.toContain('Ticket Treino');
    expect(await puxar(caixaHermes)).toEqual([]);
  });

  it('permissões por loja: o gerente da Hermes não vê nem grava a forma só da Treino', async () => {
    const fiado = await idDa('Fiado Balcão');
    const lista = await amb
      .http()
      .get('/api/formas-pagamento?situacao=todos&tamanho=50')
      .set(bearer(gerente));
    expect(lista.status).toBe(200);
    expect(lista.body.itens.map((f: { descricao: string }) => f.descricao)).not.toContain('Fiado Balcão');
    expect((await amb.http().get(`/api/formas-pagamento/${fiado}`).set(bearer(gerente))).status).toBe(403);
    const criar = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(gerente))
      .send({
        descricao: 'Do gerente',
        meioPagamentoFiscal: '01',
        lojaIds: [hermes, treino],
      });
    expect(criar.status).toBe(403);
    // Forma das duas lojas: ele vê (vale na Hermes), mas não grava (tiraria a Treino sem ver).
    expect((await alterar(fiado, { lojaIds: [treino, hermes] })).status).toBe(200);
    expect((await amb.http().get(`/api/formas-pagamento/${fiado}`).set(bearer(gerente))).status).toBe(200);
    expect((await alterar(fiado, { lojaIds: [hermes] }, gerente)).status).toBe(403);
    expect((await amb.http().delete(`/api/formas-pagamento/${fiado}`).set(bearer(gerente))).status).toBe(403);
    // A de "todas" ele edita (como antes da 1C); a da loja dele também.
    const dinheiro = await idDa('Dinheiro');
    expect((await alterar(dinheiro, { ordem: 1 }, gerente)).status).toBe(200);
    const propria = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(gerente))
      .send({
        descricao: 'Da Hermes',
        meioPagamentoFiscal: '01',
        lojaIds: [hermes],
      });
    expect(propria.status).toBe(201);
  });

  it('excluir a loja exclui os vínculos dela; a forma que só valia nela sai junto, a outra segue editável', async () => {
    const fechada = await criarLoja(emp.nomeBanco, 5, 'Loja Fechada');
    const criar = async (descricao: string, lojaIds: string[]) => {
      const r = await amb
        .http()
        .post('/api/formas-pagamento')
        .set(bearer(admin))
        .send({ descricao, meioPagamentoFiscal: '01', lojaIds });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    const soDela = await criar('Só da Fechada', [fechada]);
    const comHermes = await criar('Fechada e Hermes', [fechada, hermes]);
    expect((await amb.http().delete(`/api/lojas/${fechada}`).set(bearer(admin))).status).toBe(204);

    expect(
      await consultar(
        emp.nomeBanco,
        'select 1 from formas_pagamento_lojas where loja_id = $1 and excluido_em is null',
        [fechada],
      ),
    ).toEqual([]);
    // Sem vínculo vivo a forma não valeria em loja nenhuma (e o ERP a mostraria como "todas"): excluída com a loja.
    expect((await amb.http().get(`/api/formas-pagamento/${soDela}`).set(bearer(admin))).status).toBe(404);
    const [aud] = await consultar<{ descricao: string; loja_id: string }>(
      emp.nomeBanco,
      "select descricao, loja_id from auditoria where entidade = 'formas_pagamento' and registro_id = $1 and acao = 'excluir'",
      [soDela],
    );
    expect(aud).toEqual({ descricao: 'Excluída com a loja, a única em que valia.', loja_id: fechada });
    // A outra perde só a loja excluída: o detalhe não traz o id dela e gravar sem mexer não dá 422.
    expect((await corpoAtual(comHermes)).lojaIds).toEqual([hermes]);
    expect((await alterar(comHermes, { ordem: 3 })).status).toBe(200);
    const lista = await amb
      .http()
      .get('/api/formas-pagamento?descricao=Fechada&situacao=todos')
      .set(bearer(admin));
    expect(lista.body.itens).toMatchObject([
      { descricao: 'Fechada e Hermes', lojas: [{ id: hermes, nome: 'Loja 1 - Hermes' }] },
    ]);
    historicoHermes.push(...(await puxar(caixaHermes)));
  });

  it('descrição única na empresa, loja inexistente, troco só sem maquininha e fora de cartão/PIX (O23)', async () => {
    const dup = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({
        descricao: 'fiado balcão',
        meioPagamentoFiscal: '99',
        descricaoFiscal: 'X',
        lojaIds: [hermes],
      });
    expect(dup.status).toBe(409);
    const semLoja = await amb
      .http()
      .post('/api/formas-pagamento')
      .set(bearer(admin))
      .send({ descricao: 'Sem loja', meioPagamentoFiscal: '01', lojaIds: [uuidv7()] });
    expect(semLoja.status).toBe(422);
    expect(semLoja.body.campos.lojaIds).toEqual(['Loja inexistente ou excluída']);
    for (const errado of [
      { tipoForma: 'pix', meioPagamentoFiscal: '20' },
      { tipoForma: 'outros', meioPagamentoFiscal: '01', integracao: 'pos_externo' },
    ]) {
      const r = await amb
        .http()
        .post('/api/formas-pagamento')
        .set(bearer(admin))
        .send({ descricao: 'Com troco', permiteTroco: true, ...errado });
      expect(r.status).toBe(422);
      expect(r.body.campos.permiteTroco).toEqual(['Cartão, PIX e formas pela maquininha não dão troco']);
    }
    const ok = await amb.http().post('/api/formas-pagamento').set(bearer(admin)).send({
      descricao: 'Vale da casa',
      tipoForma: 'outros',
      meioPagamentoFiscal: '01',
      permiteTroco: true,
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ permiteTroco: true, lojaIds: [] });
    // O CHECK do banco repete a regra (O23).
    await expect(
      consultar(emp.nomeBanco, 'update formas_pagamento set permite_troco = true where id = $1', [
        await idDa('PIX'),
      ]),
    ).rejects.toThrow(/ck_formas_pagamento_troco/);
    // Auditoria guarda as lojas antes e depois.
    const [aud] = await consultar<{ depois: { lojaIds: string[] } }>(
      emp.nomeBanco,
      "select depois from auditoria where entidade = 'formas_pagamento' and registro_id = $1 and acao = 'criar'",
      [ok.body.id],
    );
    expect(aud!.depois.lojaIds).toEqual([]);
  });
});
