/**
 * Descida real da Fase 1B (bloco B4): relevância de pessoas mantida pela API (MD 3.5.4; D19) com o toque que faz a
 * pessoa que se torna relevante depois da carga descer; telefone, admissão e demissão de funcionário fora do caixa
 * (D19) com `ativo` já calculado pela demissão e o toque da manutenção no dia; `ressincronizar_fluxo` nas mudanças
 * estruturais da loja (MD 6.4 regra 3).
 */
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { jcs, respostaPullSchema, respostaPushSchema, type Ativar } from '@genesis/shared';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consultar,
  criarAmbiente,
  criarLoja,
  criarUsuario,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

const FIXTURES = new URL('../../../../packages/shared/testes/sync/', import.meta.url);
const ATIVAR = JSON.parse(readFileSync(new URL('ativar.requisicao.json', FIXTURES), 'utf8')) as Ativar;

let amb: Ambiente;
let emp: EmpresaTeste;
let loja1: string;
let loja2: string;
let caixa1: string;
let admin: string;
let terminalId: string;
let token: string;

type Alteracao = { tabela: string; versao: number; linha: Record<string, unknown> };

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

/** Páginas do fluxo desde `desde` até `tem_mais = false` (o mesmo laço da carga inicial e do ciclo do PDV). */
async function puxar(fluxo: string, desde = 0): Promise<{ alteracoes: Alteracao[]; cursor: number }> {
  const alteracoes: Alteracao[] = [];
  let cursor = desde;
  for (let i = 0; i < 100; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=${fluxo}&desde=${cursor}&limite=2000`)
      .set(cabecalhos(token));
    expect(r.status).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...(r.body.alteracoes as Alteracao[]));
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return { alteracoes, cursor };
  }
  throw new Error('pull não terminou');
}

/** Hoje no fuso da empresa de teste (o padrão, `America/Sao_Paulo`): a demissão é data civil da empresa. */
const HOJE = "(now() at time zone 'America/Sao_Paulo')::date";

const da = (alteracoes: Alteracao[], tabela: string) =>
  alteracoes.filter((a) => a.tabela === tabela).map((a) => a.linha);

const endereco = {
  tipo: 'principal',
  cep: '01001000',
  logradouro: 'Praça da Sé',
  numero: '1',
  bairro: 'Sé',
  uf: 'SP',
  municipioIbge: 3550308,
};

async function criarPessoa(corpo: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await amb.http().post('/api/pessoas').set(bearer(admin)).send(corpo);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Record<string, unknown>;
}

/** PUT com o detalhe atual alterado (a API exige a versão agregada e o cadastro inteiro). */
async function alterarPessoa(id: string, mudar: Record<string, unknown>): Promise<Record<string, unknown>> {
  const d = await amb.http().get(`/api/pessoas/${id}`).set(bearer(admin));
  const {
    id: _i,
    codigo: _c,
    origem: _o,
    senhaDefinida: _s,
    criadoEm: _cr,
    atualizadoEm: _a,
    atualizadoPorNome: _ap,
    ...corpo
  } = d.body as Record<string, unknown>;
  const r = await amb
    .http()
    .put(`/api/pessoas/${id}`)
    .set(bearer(admin))
    .send({ ...corpo, ...mudar });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Record<string, unknown>;
}

async function relevancias(pessoaId: string) {
  return consultar<{ motivo: string; loja_id: string | null; excluida: boolean }>(
    emp.nomeBanco,
    `select motivo, loja_id, excluido_em is not null as excluida from pessoas_relevancia_loja
     where pessoa_id = $1 order by criado_em, motivo`,
    [pessoaId],
  );
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Loja 2 - Bairro');
  [{ id: caixa1 }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, 1, $2) returning id',
    [loja1, 'Caixa 01'],
  )) as [{ id: string }];
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  const codigo = await amb
    .http()
    .post('/api/terminais/ativacoes')
    .set(bearer(admin))
    .send({ lojaId: loja1, caixaId: caixa1, validadeHoras: 1 });
  expect(codigo.status).toBe(201);
  const r = await amb
    .http()
    .post('/sync/ativar')
    .set(cabecalhos())
    .send({
      ...ATIVAR,
      codigo_empresa: emp.codigo,
      codigo_ativacao: codigo.body.codigo,
      requisicao_ativacao_id: uuidv7(),
      chave_backup_publica: spki(generateKeyPairSync('x25519').publicKey),
      chave_publica_terminal: { algoritmo: 'x25519', chave: spki(generateKeyPairSync('x25519').publicKey) },
    });
  expect(r.status).toBe(201);
  terminalId = r.body.terminal_id;
  token = r.body.token;
});

afterAll(async () => {
  await amb?.fechar();
});

describe('relevância de pessoas mantida pela API (MD 3.5.4; D19)', () => {
  it('funcionário, crediário e "Manter no PDV" criam a relevância; cliente comum não desce', async () => {
    const funcionario = await criarPessoa({
      nome: 'Maria Funcionária',
      categorias: ['funcionario'],
      enderecos: [endereco],
      telefones: [{ numero: '(41) 99999-1234', principal: true }],
    });
    const crediario = await criarPessoa({
      nome: 'João Crediário',
      categorias: ['cliente'],
      limiteCompras: '500.00',
      telefones: [{ numero: '(41) 98888-1111', principal: true }],
    });
    const manual = await criarPessoa({ nome: 'Ana Manual', categorias: ['cliente'], manterNoPdv: true });
    const comum = await criarPessoa({ nome: 'Pedro Comum', categorias: ['cliente'] });
    expect(manual.manterNoPdv).toBe(true);
    expect(comum.manterNoPdv).toBe(false);
    expect(await relevancias(funcionario.id as string)).toEqual([
      { motivo: 'funcionario', loja_id: null, excluida: false },
    ]);
    expect((await relevancias(crediario.id as string)).map((r) => r.motivo)).toEqual(['crediario']);
    expect((await relevancias(manual.id as string)).map((r) => r.motivo)).toEqual(['manual']);
    expect(await relevancias(comum.id as string)).toEqual([]);

    const { alteracoes } = await puxar('pessoas');
    expect(
      da(alteracoes, 'pessoas')
        .map((p) => p.nome)
        .sort(),
    ).toEqual(['Ana Manual', 'João Crediário', 'Maria Funcionária']);
    // D19: o funcionário desce sem telefone nem endereço; o cliente do crediário, com.
    expect(da(alteracoes, 'pessoas_telefones').map((t) => t.pessoa_id)).toEqual([crediario.id]);
    expect(da(alteracoes, 'pessoas_enderecos')).toEqual([]);
    expect(da(alteracoes, 'pessoas_categorias').map((c) => c.pessoa_id)).toContain(funcionario.id);
  });

  it('a pessoa que se torna relevante depois da carga desce com as filhas (toque)', async () => {
    // Cadastrada antes da carga, sem relevância: telefone e categoria ficam abaixo do cursor do terminal.
    const pessoa = await criarPessoa({
      nome: 'Carla Antiga',
      categorias: ['cliente'],
      telefones: [{ numero: '(41) 97777-2222', principal: true }],
    });
    const { cursor } = await puxar('pessoas');
    await alterarPessoa(pessoa.id as string, { manterNoPdv: true });
    const { alteracoes, cursor: depois } = await puxar('pessoas', cursor);
    expect(da(alteracoes, 'pessoas_relevancia_loja')).toMatchObject([
      { pessoa_id: pessoa.id, motivo: 'manual', loja_id: null, excluido_em: null },
    ]);
    expect(da(alteracoes, 'pessoas').map((p) => p.id)).toEqual([pessoa.id]);
    expect(da(alteracoes, 'pessoas_telefones').map((t) => t.pessoa_id)).toEqual([pessoa.id]);
    expect(da(alteracoes, 'pessoas_categorias').map((c) => c.categoria)).toEqual(['cliente']);
    // A relevância chega antes da pessoa (versão menor): o PDV aplica em ordem.
    const versoes = alteracoes.map((a) => [a.tabela, a.versao] as const);
    const rel = versoes.find(([t]) => t === 'pessoas_relevancia_loja')![1];
    expect(versoes.filter(([t]) => t !== 'pessoas_relevancia_loja').every(([, v]) => v > rel)).toBe(true);

    // Gravar de novo sem mudar a relevância não cria linha nem toca a pessoa (as filhas regravadas pelo formulário
    // ainda podem gerar versão própria: o "principal" é desligado e religado).
    await alterarPessoa(pessoa.id as string, {});
    const regravada = await puxar('pessoas', depois);
    expect(da(regravada.alteracoes, 'pessoas_relevancia_loja')).toEqual([]);
    expect(da(regravada.alteracoes, 'pessoas')).toEqual([]);

    // Desmarcar: a relevância desce excluída (o PDV purga a pessoa local).
    await alterarPessoa(pessoa.id as string, { manterNoPdv: false });
    const saida = await puxar('pessoas', depois);
    expect(da(saida.alteracoes, 'pessoas_relevancia_loja')).toHaveLength(1);
    expect(da(saida.alteracoes, 'pessoas_relevancia_loja')[0]!.excluido_em).not.toBeNull();
  });

  it('funcionário que ganha crediário passa a descer o telefone; excluir a pessoa exclui a relevância', async () => {
    const pessoa = await criarPessoa({
      nome: 'Bruno Funcionário',
      categorias: ['funcionario'],
      telefones: [{ numero: '(41) 96666-3333', principal: true }],
    });
    const { alteracoes, cursor } = await puxar('pessoas');
    expect(da(alteracoes, 'pessoas_telefones').map((t) => t.pessoa_id)).not.toContain(pessoa.id);
    await alterarPessoa(pessoa.id as string, { limiteCompras: '200.00' });
    const depois = await puxar('pessoas', cursor);
    expect(da(depois.alteracoes, 'pessoas_telefones').map((t) => t.pessoa_id)).toEqual([pessoa.id]);
    expect((await relevancias(pessoa.id as string)).filter((r) => !r.excluida).map((r) => r.motivo)).toEqual([
      'funcionario',
      'crediario',
    ]);

    const excluir = await amb.http().delete(`/api/pessoas/${pessoa.id}`).set(bearer(admin));
    expect(excluir.status).toBe(204);
    expect((await relevancias(pessoa.id as string)).every((r) => r.excluida)).toBe(true);
    const saida = await puxar('pessoas', depois.cursor);
    expect(da(saida.alteracoes, 'pessoas_relevancia_loja').every((r) => r.excluido_em !== null)).toBe(true);
  });

  it('vínculo usuarios.pessoa_id também é motivo funcionario; excluir o usuário tira a relevância', async () => {
    const pessoa = await criarPessoa({ nome: 'Gerente Vinculado', categorias: ['cliente'] });
    const usuario = await criarUsuario(emp.nomeBanco, {
      login: 'gerente_vinculado',
      perfil: 'gerente',
      lojas: [loja1],
    });
    await consultar(emp.nomeBanco, 'update usuarios set pessoa_id = $1 where id = $2', [pessoa.id, usuario]);
    // A edição do usuário pelo ERP recalcula a relevância da pessoa vinculada.
    const d = await amb.http().get(`/api/usuarios/${usuario}`).set(bearer(admin));
    const r = await amb
      .http()
      .put(`/api/usuarios/${usuario}`)
      .set(bearer(admin))
      .send({ ...d.body, nome: 'GERENTE VINCULADO' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await relevancias(pessoa.id as string)).map((x) => x.motivo)).toEqual(['funcionario']);
    expect((await amb.http().delete(`/api/usuarios/${usuario}`).set(bearer(admin))).status).toBe(204);
    expect((await relevancias(pessoa.id as string)).every((x) => x.excluida)).toBe(true);
  });
  it('"Manter no PDV" fica na auditoria do cadastro (antes e depois)', async () => {
    const pessoa = await criarPessoa({ nome: 'Lia Auditada', categorias: ['cliente'] });
    const [criar] = await consultar<{ depois: Record<string, unknown> }>(
      emp.nomeBanco,
      "select depois from auditoria where registro_id = $1 and acao = 'criar'",
      [pessoa.id],
    );
    expect(criar!.depois.manterNoPdv).toBe(false);
    // Só a marcação muda: sem ela no registro, a auditoria não diria quem expôs a pessoa aos caixas.
    await alterarPessoa(pessoa.id as string, { manterNoPdv: true });
    const [editar] = await consultar<{ antes: Record<string, unknown>; depois: Record<string, unknown> }>(
      emp.nomeBanco,
      "select antes, depois from auditoria where registro_id = $1 and acao = 'editar' order by ocorrido_em desc limit 1",
      [pessoa.id],
    );
    expect(editar!.antes.manterNoPdv).toBe(false);
    expect(editar!.depois.manterNoPdv).toBe(true);
  });

  it('pessoas gravadas antes da Fase 1B ganham a relevância pela migração 0009 (sem o CRUD)', async () => {
    // Como a Fase 1A e a importação do Nuvem3 gravavam: direto na tabela, sem `recalcularRelevancia`.
    const inserir = async (nome: string, colunas = '', valores = '') =>
      (
        await consultar<{ id: string }>(
          emp.nomeBanco,
          `insert into pessoas (nome${colunas}) values ($1${valores}) returning id`,
          [nome],
        )
      )[0]!.id;
    const funcionaria = await inserir('Antiga Funcionária');
    await consultar(
      emp.nomeBanco,
      "insert into pessoas_categorias (pessoa_id, categoria) values ($1, 'funcionario')",
      [funcionaria],
    );
    const comLimite = await inserir('Antigo Com Limite', ', limite_compras', ", '300.00'");
    const comSaldo = await inserir('Antigo Com Saldo');
    await consultar(
      emp.nomeBanco,
      "insert into saldos_credito_pessoas (pessoa_id, saldo_aberto) values ($1, '45.90')",
      [comSaldo],
    );
    const vinculada = await inserir('Antiga Vinculada');
    const usuario = await criarUsuario(emp.nomeBanco, {
      login: 'antigo_vinculo',
      perfil: 'gerente',
      lojas: [loja1],
    });
    await consultar(emp.nomeBanco, 'update usuarios set pessoa_id = $1 where id = $2', [vinculada, usuario]);
    const excluida = await inserir('Antiga Excluída', ', limite_compras, excluido_em', ", '100.00', now()");
    const comum = await inserir('Antigo Comum', ', limite_compras', ", '0.00'");
    for (const id of [funcionaria, comLimite, comSaldo, vinculada, excluida, comum]) {
      expect(await relevancias(id)).toEqual([]);
    }

    const migracao = readFileSync(
      new URL('../../drizzle/empresa/0009_relevancia_inicial_motivos_login.sql', import.meta.url),
      'utf8',
    );
    const rodar = async () => {
      for (const comando of migracao.split('--> statement-breakpoint'))
        await consultar(emp.nomeBanco, comando);
    };
    await rodar();
    const motivos = async (id: string) => (await relevancias(id)).map((r) => `${r.motivo}:${r.loja_id}`);
    expect(await motivos(funcionaria)).toEqual(['funcionario:null']);
    expect(await motivos(comLimite)).toEqual(['crediario:null']);
    expect(await motivos(comSaldo)).toEqual(['crediario:null']);
    expect(await motivos(vinculada)).toEqual(['funcionario:null']);
    expect(await motivos(excluida)).toEqual([]);
    expect(await motivos(comum)).toEqual([]);
    // Idempotente: rodar de novo não duplica (o índice único também recusaria).
    await rodar();
    expect(await motivos(funcionaria)).toEqual(['funcionario:null']);

    const { alteracoes } = await puxar('pessoas');
    const nomes = da(alteracoes, 'pessoas').map((p) => p.nome);
    expect(nomes).toEqual(
      expect.arrayContaining([
        'Antiga Funcionária',
        'Antigo Com Limite',
        'Antigo Com Saldo',
        'Antiga Vinculada',
      ]),
    );
    expect(nomes).not.toContain('Antiga Excluída');
    expect(nomes).not.toContain('Antigo Comum');
  });
});

describe('fluxo acesso sem dados pessoais do funcionário (D19)', () => {
  it('telefone, admissão e demissão não descem; ativo já considera a demissão', async () => {
    const ativo = await criarUsuario(emp.nomeBanco, {
      login: 'op_ativo',
      perfil: 'operador_caixa',
      lojas: [loja1],
    });
    const demitido = await criarUsuario(emp.nomeBanco, {
      login: 'op_demitido',
      perfil: 'operador_caixa',
      lojas: [loja1],
    });
    const futuro = await criarUsuario(emp.nomeBanco, {
      login: 'op_futuro',
      perfil: 'operador_caixa',
      lojas: [loja1],
    });
    await consultar(
      emp.nomeBanco,
      `update usuarios set telefone = '41999990000', admissao = ${HOJE} - 400,
         demissao = case login when 'op_demitido' then ${HOJE} - 1 when 'op_futuro' then ${HOJE} + 30 end
       where id in ($1, $2, $3)`,
      [ativo, demitido, futuro],
    );
    const { alteracoes, cursor } = await puxar('acesso');
    const porLogin = new Map(da(alteracoes, 'usuarios').map((u) => [u.login, u]));
    for (const login of ['op_ativo', 'op_demitido', 'op_futuro']) {
      const u = porLogin.get(login)!;
      expect(u).not.toHaveProperty('telefone');
      expect(u).not.toHaveProperty('admissao');
      expect(u).not.toHaveProperty('demissao');
    }
    expect(porLogin.get('op_ativo')!.ativo).toBe(true);
    expect(porLogin.get('op_demitido')!.ativo).toBe(false);
    expect(porLogin.get('op_futuro')!.ativo).toBe(true);

    // O dia da demissão chega (simulado: demissão hoje e a última gravação antes dela, sem o trigger de versão).
    await consultar(emp.nomeBanco, 'alter table usuarios disable trigger tg_usuarios_versao');
    await consultar(
      emp.nomeBanco,
      `update usuarios set demissao = ${HOJE}, atualizado_em = now() - interval '2 days' where id = $1`,
      [futuro],
    );
    await consultar(emp.nomeBanco, 'alter table usuarios enable trigger tg_usuarios_versao');
    expect((await puxar('acesso', cursor)).alteracoes).toEqual([]);
    const resumo = await amb.servicos.manutencaoTerminais.executar();
    expect(resumo.falhas).toEqual([]);
    expect(resumo.usuariosDemitidosTocados).toBe(1);
    const depois = await puxar('acesso', cursor);
    expect(da(depois.alteracoes, 'usuarios')).toMatchObject([{ id: futuro, ativo: false }]);
    // Um toque só: a próxima execução não gera versão nova.
    expect((await amb.servicos.manutencaoTerminais.executar()).usuariosDemitidosTocados).toBe(0);
  });
  it('o dia da demissão é o do fuso da empresa, não o da sessão do Postgres (UTC)', async () => {
    // Um fuso cujo dia difere do dia em UTC agora: UTC−12 antes do meio-dia UTC, UTC+14 depois das 10 h UTC.
    const fuso = new Date().getUTCHours() < 12 ? 'Etc/GMT+12' : 'Etc/GMT-14';
    const [{ antes }] = (await consultar<{ antes: string }>(
      emp.nomeBanco,
      'select fuso_horario as antes from empresa',
    )) as [{ antes: string }];
    await consultar(emp.nomeBanco, 'update empresa set fuso_horario = $1', [fuso]);
    try {
      const hoje = `(now() at time zone '${fuso}')::date`;
      const { cursor } = await puxar('acesso');
      const ehHoje = await criarUsuario(emp.nomeBanco, {
        login: 'fuso_hoje',
        perfil: 'operador_caixa',
        lojas: [loja1],
      });
      const amanha = await criarUsuario(emp.nomeBanco, {
        login: 'fuso_amanha',
        perfil: 'operador_caixa',
        lojas: [loja1],
      });
      await consultar(
        emp.nomeBanco,
        `update usuarios set demissao = case login when 'fuso_hoje' then ${hoje} else ${hoje} + 1 end
         where id in ($1, $2)`,
        [ehHoje, amanha],
      );
      const porLogin = new Map(
        da((await puxar('acesso', cursor)).alteracoes, 'usuarios').map((u) => [u.login, u]),
      );
      expect(porLogin.get('fuso_hoje')!.ativo).toBe(false);
      expect(porLogin.get('fuso_amanha')!.ativo).toBe(true);

      // A manutenção vira o dia no mesmo fuso: toca quem foi gravado antes da meia-noite local do dia da demissão e
      // não toca quem foi gravado antes da meia-noite UTC de uma demissão que, no fuso da empresa, ainda é amanhã.
      await consultar(emp.nomeBanco, 'alter table usuarios disable trigger tg_usuarios_versao');
      await consultar(
        emp.nomeBanco,
        `update usuarios set atualizado_em = least(
             demissao::timestamp at time zone '${fuso}', demissao::timestamp at time zone 'UTC') - interval '1 minute'
         where id in ($1, $2)`,
        [ehHoje, amanha],
      );
      await consultar(emp.nomeBanco, 'alter table usuarios enable trigger tg_usuarios_versao');
      const { cursor: depois } = await puxar('acesso', cursor);
      const resumo = await amb.servicos.manutencaoTerminais.executar();
      expect(resumo.falhas).toEqual([]);
      expect(resumo.usuariosDemitidosTocados).toBe(1);
      expect(da((await puxar('acesso', depois)).alteracoes, 'usuarios')).toMatchObject([
        { id: ehHoje, ativo: false },
      ]);
    } finally {
      await consultar(emp.nomeBanco, 'update empresa set fuso_horario = $1', [antes]);
    }
  });
});

describe('mudanças estruturais da loja geram ressincronizar_fluxo (MD 6.4 regra 3)', () => {
  // Ordem pelo fluxo: os comandos do mesmo PUT nascem na mesma transação, com o mesmo `criado_em` (`now()`).
  const comandos = async () =>
    (
      await consultar<{ fluxo: string }>(
        emp.nomeBanco,
        `select parametros->>'fluxo' as fluxo from comandos_terminal
         where terminal_id = $1 and tipo = 'ressincronizar_fluxo' and status = 'pendente'
         order by parametros->>'fluxo'`,
        [terminalId],
      )
    ).map((c) => c.fluxo);

  async function alterarLoja(id: string, mudar: Record<string, unknown>) {
    const d = await amb.http().get(`/api/lojas/${id}`).set(bearer(admin));
    const {
      id: _i,
      codigo: _c,
      estoqueNome: _e,
      municipioNome: _m,
      contaCaixaId: _cc,
      nfeProximoNumero: _n,
      criadoEm: _cr,
      atualizadoEm: _a,
      atualizadoPorNome: _ap,
      logotipoArquivoId: _l,
      fotoArquivoId: _f,
      ...corpo
    } = d.body as Record<string, unknown>;
    const r = await amb
      .http()
      .put(`/api/lojas/${id}`)
      .set(bearer(admin))
      .send({ ...corpo, ...mudar });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  it('estoque_id → estoque, catalogo e configuracao; UF/município → referencia e catalogo; outra loja não alcança o terminal', async () => {
    await consultar(
      emp.nomeBanco,
      "update comandos_terminal set status = 'cancelado' where terminal_id = $1",
      [terminalId],
    );
    await alterarLoja(loja1, { fraseRodapeCupom: 'Volte sempre!' });
    expect(await comandos()).toEqual([]);

    const [novo] = await consultar<{ id: string }>(
      emp.nomeBanco,
      "insert into estoques (nome) values ('Estoque novo da Loja 1') returning id",
    );
    await alterarLoja(loja1, { estoqueId: novo!.id });
    expect(await comandos()).toEqual(['catalogo', 'configuracao', 'estoque']);

    // O pendente igual não se repete (comando idempotente): só entra o que falta.
    await alterarLoja(loja1, { uf: 'PR', municipioIbge: 4106902 });
    expect(await comandos()).toEqual(['catalogo', 'configuracao', 'estoque', 'referencia']);

    await alterarLoja(loja2, { uf: 'PR', municipioIbge: 4106902 });
    expect(await comandos()).toEqual(['catalogo', 'configuracao', 'estoque', 'referencia']);
  });
});

describe('auditoria do login offline sobe no push (SYNC 4.5; catálogo único)', () => {
  it('ação hash_fora_dos_limites e os motivos próprios do caixa são aceitos, sem PAYLOAD_INVALIDO', async () => {
    const payload = JSON.parse(
      readFileSync(new URL('auditoria.registros.payload.json', FIXTURES), 'utf8'),
    ) as {
      registros: Array<Record<string, unknown>>;
      logins: Array<Record<string, unknown>>;
    };
    const agora = new Date().toISOString();
    // Ids novos, hora atual (partição do mês corrente) e sem o usuário da fixture (chave estrangeira); o resto é a
    // fixture do contrato.
    for (const r of [...payload.registros, ...payload.logins]) {
      Object.assign(r, { id: uuidv7(), ocorrido_em: agora, usuario_id: null });
    }
    const evento = {
      evento_id: uuidv7(),
      sequencia: 1,
      tipo: 'auditoria.registros',
      versao_schema: 1,
      agregado_tipo: 'auditoria',
      agregado_id: uuidv7(),
      dependencias: [],
      ocorrido_em: agora,
      usuario_id: null,
      contexto: { loja_id: loja1, caixa_id: caixa1 },
      payload,
      payload_sha256: createHash('sha256').update(jcs(payload), 'utf8').digest('hex'),
    };
    const r = await amb
      .http()
      .post('/sync/push')
      .set(cabecalhos(token))
      .send({ lote_id: uuidv7(), terminal_id: terminalId, enviado_em: agora, eventos: [evento] });
    expect(r.status).toBe(200);
    respostaPushSchema.parse(r.body);
    expect(r.body.resultados[0], JSON.stringify(r.body)).toMatchObject({ status: 'aplicado' });
    const motivos = await consultar<{ motivo_falha: string }>(
      emp.nomeBanco,
      "select motivo_falha from historico_logins where origem = 'pdv' and motivo_falha is not null",
    );
    expect(motivos.map((m) => m.motivo_falha)).toEqual(
      expect.arrayContaining(['sem_acesso_pdv', 'totem', 'hash_fora_dos_limites']),
    );
    const [hash] = await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where acao = 'hash_fora_dos_limites' and origem = 'pdv'",
    );
    expect(hash!.n).toBe(1);
  });
});
