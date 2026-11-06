/**
 * Cadastro de Tipo de Estoque (Fase 2, F2-B7; ERP 13.6; MD 3.2.6, 6.4 regra 3, 7.4; SYNC 6.7; README da API › decisão
 * 152): cada regra recusada (nome repetido 409; padrão não vendável ou inativo, padrão desmarcado sem outro, vendável
 * travado do Disponível e do Vasilhame vazio, Vasilhame vazio inativo, inativar com saldo ou com acerto em rascunho,
 * tirar o "vendável" com saldo, excluir tipo do sistema, o padrão ou um tipo usado: 422; versão velha 409; sem
 * permissão 403); o gerente cria "Quebra" não vendável sem ressincronizar ninguém; tirar o "vendável" de um tipo com
 * saldo zero cria um `ressincronizar_fluxo 'estoque'` por terminal ativo de todas as lojas (o revogado fica de fora, e
 * repetir a mudança não empilha comandos) e o pull do cursor 0 deixa de trazer a linha do tipo — e volta a trazê-la
 * quando o tipo volta a ser vendável (o PDV instalado não apaga o que sai do filtro: por isso a regra do saldo zero);
 * o acerto não se efetiva nem se estorna num tipo inativo; marcar outro tipo como padrão tira a marca do anterior na
 * mesma gravação, ressincroniza e fica no histórico dos dois.
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

let amb: Ambiente;
let emp: EmpresaTeste;
let admin: string;
let gerente: string;
let estoquista: string;
let loja1: string;
let loja2: string;
let estoqueLoja1: string;
let produto: string;
/** Terminais ativos: dois na loja 1 e um na loja 2; o revogado da loja 2 não recebe comando. */
let terminais: Array<{ id: string; token: string; loja: string }>;
let revogado: string;
let numeroCaixa = 0;

type Alteracao = { tabela: string; versao: number; linha: Record<string, unknown> };
type Tipo = {
  id: string;
  nome: string;
  vendavel: boolean;
  padrao: boolean;
  ativo: boolean;
  chaveSistema: string | null;
  versao: number;
};

const bearer = (t = admin) => ({ Authorization: `Bearer ${t}` });
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

/** Caixa novo na loja com o terminal ativado pelo `/sync/ativar` real. */
async function ativarTerminal(loja: string): Promise<{ id: string; token: string; loja: string }> {
  const numero = ++numeroCaixa;
  const [{ id: caixa }] = (await consultar<{ id: string }>(
    emp.nomeBanco,
    'insert into caixas (loja_id, numero, descricao) values ($1, $2, $3) returning id',
    [loja, numero, `Caixa ${String(numero).padStart(2, '0')}`],
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
  return { id: r.body.terminal_id as string, token: r.body.token as string, loja };
}

/** Páginas do fluxo desde `desde` até `tem_mais = false`, como a carga inicial e a ressincronização do PDV. */
async function puxar(token: string, fluxo: string, desde = 0): Promise<Alteracao[]> {
  const alteracoes: Alteracao[] = [];
  let cursor = desde;
  for (let i = 0; i < 100; i++) {
    const r = await amb
      .http()
      .get(`/sync/pull?fluxo=${fluxo}&desde=${cursor}&limite=2000`)
      .set(cabecalhos(token));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    respostaPullSchema.parse(r.body);
    alteracoes.push(...(r.body.alteracoes as Alteracao[]));
    cursor = r.body.novo_cursor;
    if (!r.body.tem_mais) return alteracoes;
  }
  throw new Error('pull não terminou');
}

const saldosDoTipo = (alteracoes: Alteracao[], tipoId: string) =>
  alteracoes
    .filter((a) => a.tabela === 'saldos_estoque' && a.linha.tipo_estoque_id === tipoId)
    .map((a) => a.linha);

async function tipos(): Promise<Tipo[]> {
  const r = await amb.http().get('/api/tipos-estoque').set(bearer(estoquista));
  expect(r.status).toBe(200);
  return r.body as Tipo[];
}

const porChave = async (chave: string) => (await tipos()).find((t) => t.chaveSistema === chave)!;

/** PUT com os campos atuais do tipo trocados pelos de `mudancas` (e a versão atual, salvo se informada). */
async function alterar(tipo: Tipo, mudancas: Partial<Tipo>, token = admin) {
  const atual = (await tipos()).find((t) => t.id === tipo.id)!;
  const { nome, vendavel, padrao, ativo, versao } = { ...atual, ...mudancas };
  return amb
    .http()
    .put(`/api/tipos-estoque/${tipo.id}`)
    .set(bearer(token))
    .send({ nome, vendavel, padrao, ativo, versao });
}

/** Soma do saldo do tipo em todos os estoques (o espelho da nuvem, `saldos_estoque`). */
async function saldoDoTipo(tipoId: string): Promise<number> {
  const [r] = await consultar<{ q: string }>(
    emp.nomeBanco,
    'select coalesce(sum(quantidade), 0)::text as q from saldos_estoque where tipo_estoque_id = $1',
    [tipoId],
  );
  return Number(r!.q);
}

async function comandosPendentes(): Promise<Map<string, number>> {
  const linhas = await consultar<{ terminal_id: string; n: number }>(
    emp.nomeBanco,
    `select terminal_id, count(*)::int as n from comandos_terminal
      where tipo = 'ressincronizar_fluxo' and status = 'pendente' and parametros = '{"fluxo":"estoque"}'::jsonb
      group by terminal_id`,
  );
  return new Map(linhas.map((l) => [l.terminal_id, l.n]));
}

/** O PDV recebeu os comandos (o heartbeat entrega): a próxima mudança gera um novo, não reaproveita o pendente. */
const entregarComandos = () =>
  consultar(emp.nomeBanco, "update comandos_terminal set status = 'executado' where status = 'pendente'");

/** Acerto em rascunho no estoque da loja 1 (`{ id, versao }`). */
async function rascunho(
  tipoAjuste: 'entrada' | 'saida',
  tipoEstoqueId: string,
  quantidade: string,
): Promise<{ id: string; versao: number }> {
  const r = await amb
    .http()
    .post('/api/acertos')
    .set(bearer())
    .send({
      estoqueId: estoqueLoja1,
      tipoEstoqueId,
      tipoAjuste,
      dataContagem: new Date().toISOString(),
      motivo: 'Mostruário da vitrine',
      itens: [
        { produtoId: produto, quantidade, ...(tipoAjuste === 'entrada' ? { custoUnitario: '2' } : {}) },
      ],
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id as string, versao: r.body.versao as number };
}

const efetivar = (a: { id: string; versao: number }) =>
  amb.http().post(`/api/acertos/${a.id}/efetivar`).set(bearer()).send({ versao: a.versao });

/** Acerto efetivado (`{ id, versao }` depois de efetivar, para o estorno). */
async function acerto(tipoAjuste: 'entrada' | 'saida', tipoEstoqueId: string, quantidade: string) {
  const e = await efetivar(await rascunho(tipoAjuste, tipoEstoqueId, quantidade));
  expect(e.status, JSON.stringify(e.body)).toBe(200);
  return { id: e.body.id as string, versao: e.body.versao as number };
}

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  admin = await amb.entrar(emp.codigo, 'admin', emp.senha);
  loja1 = await criarLoja(emp.nomeBanco, 1, 'Loja 1 - Centro');
  loja2 = await criarLoja(emp.nomeBanco, 2, 'Petiscaria 2');
  await criarUsuario(emp.nomeBanco, { login: 'gerente', perfil: 'gerente', lojas: [loja1, loja2] });
  await criarUsuario(emp.nomeBanco, { login: 'estoquista', perfil: 'estoquista', lojas: [loja1] });
  gerente = await amb.entrar(emp.codigo, 'gerente', SENHA_TESTE);
  estoquista = await amb.entrar(emp.codigo, 'estoquista', SENHA_TESTE);
  [{ estoque_id: estoqueLoja1 }] = (await consultar<{ estoque_id: string }>(
    emp.nomeBanco,
    'select estoque_id from lojas where id = $1',
    [loja1],
  )) as [{ estoque_id: string }];
  const unidades = await amb.http().get('/api/referencias/unidades').set(bearer());
  const un = (unidades.body as Array<{ id: string; sigla: string }>).find((u) => u.sigla === 'UN')!.id;
  const p = await amb
    .http()
    .post('/api/produtos')
    .set(bearer())
    .send({ nome: 'CERV HEINEKEN LN 330ML', unidadeId: un, precoCusto: '2', precoVenda: '7,90' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  produto = p.body.id as string;
  terminais = [await ativarTerminal(loja1), await ativarTerminal(loja1), await ativarTerminal(loja2)];
  revogado = (await ativarTerminal(loja2)).id;
  await consultar(emp.nomeBanco, "update terminais set status = 'revogado' where id = $1", [revogado]);
}, 120_000);

afterAll(async () => {
  await amb?.fechar();
});

describe('regras do Tipo de Estoque (ERP 13.6)', () => {
  it('lista os 5 tipos do seed com a chave de sistema e a versão, o padrão primeiro', async () => {
    const lista = await tipos();
    expect(lista[0]).toMatchObject({ chaveSistema: 'disponivel', padrao: true, vendavel: true, ativo: true });
    expect(lista.map((t) => t.chaveSistema).sort()).toEqual([
      'avaria',
      'disponivel',
      'uso_consumo',
      'vasilhame_vazio',
      'vencido',
    ]);
    expect(lista.every((t) => typeof t.versao === 'number')).toBe(true);
  });

  it('o gerente cria "Quebra" não vendável; ninguém é ressincronizado', async () => {
    const r = await amb.http().post('/api/tipos-estoque').set(bearer(gerente)).send({ nome: 'Quebra' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      nome: 'Quebra',
      vendavel: false,
      padrao: false,
      ativo: true,
      chaveSistema: null,
      terminaisRessincronizados: 0,
      atualizadoPorNome: 'GERENTE',
    });
    expect((await comandosPendentes()).size).toBe(0);
    const d = await amb.http().get(`/api/tipos-estoque/${r.body.id}`).set(bearer(estoquista));
    expect(d.body).toMatchObject({ nome: 'Quebra', versao: r.body.versao });
    const [aud] = await consultar<{ n: number }>(
      emp.nomeBanco,
      "select count(*)::int as n from auditoria where entidade = 'tipos_estoque' and registro_id = $1 and acao = 'criar'",
      [r.body.id],
    );
    expect(aud!.n).toBe(1);
  });

  it('recusa cada regra (409/422/403)', async () => {
    const post = (corpo: Record<string, unknown>, token = admin) =>
      amb.http().post('/api/tipos-estoque').set(bearer(token)).send(corpo);
    // Nome único (sem diferença de maiúsculas), também na edição.
    expect((await post({ nome: 'quebra' })).status).toBe(409);
    const avaria = await porChave('avaria');
    const dup = await alterar(avaria, { nome: 'QUEBRA' });
    expect(dup.status).toBe(409);
    expect(dup.body.campos).toEqual({ nome: ['Já existe um tipo de estoque com este nome'] });
    // O padrão é sempre vendável e ativo.
    const naoVendavel = await post({ nome: 'Loja virtual', padrao: true, vendavel: false });
    expect(naoVendavel.status).toBe(422);
    expect(Object.keys(naoVendavel.body.campos)).toEqual(['vendavel']);
    expect((await post({ nome: 'Loja virtual', padrao: true, vendavel: true, ativo: false })).status).toBe(
      422,
    );
    const disponivel = await porChave('disponivel');
    expect((await alterar(disponivel, { vendavel: false })).status).toBe(422);
    expect((await alterar(disponivel, { ativo: false })).status).toBe(422);
    // Desmarcar o padrão sem marcar outro deixaria a empresa sem padrão.
    const semPadrao = await alterar(disponivel, { padrao: false });
    expect(semPadrao.status).toBe(422);
    expect(Object.keys(semPadrao.body.campos)).toEqual(['padrao']);
    // Vendável travado dos tipos de que o código depende, e o Vasilhame vazio sempre ativo.
    const cascos = await porChave('vasilhame_vazio');
    expect((await alterar(cascos, { vendavel: true })).status).toBe(422);
    expect((await alterar(cascos, { ativo: false })).status).toBe(422);
    // Os outros tipos do sistema são livres (vendável e ativo), mas não se excluem.
    const vencido = await porChave('vencido');
    expect((await amb.http().delete(`/api/tipos-estoque/${vencido.id}`).set(bearer())).status).toBe(422);
    expect((await amb.http().delete(`/api/tipos-estoque/${disponivel.id}`).set(bearer())).status).toBe(422);
    // Versão velha.
    expect((await alterar(vencido, { nome: 'Vencidos', versao: vencido.versao - 1 })).status).toBe(409);
    // Permissões: o estoquista só vê.
    expect((await post({ nome: 'Doação' }, estoquista)).status).toBe(403);
    expect((await alterar(vencido, { nome: 'Vencidos' }, estoquista)).status).toBe(403);
    // Nada mudou: o Disponível continua o único padrão, vendável.
    const depois = await tipos();
    expect(depois.filter((t) => t.padrao).map((t) => t.chaveSistema)).toEqual(['disponivel']);
    expect(depois.find((t) => t.chaveSistema === 'disponivel')!.versao).toBe(disponivel.versao);
    expect((await comandosPendentes()).size).toBe(0);
  });

  it('exclui o tipo nunca usado; o usado só se inativa', async () => {
    const r = await amb.http().post('/api/tipos-estoque').set(bearer()).send({ nome: 'Temporário' });
    expect(r.status).toBe(201);
    expect((await amb.http().delete(`/api/tipos-estoque/${r.body.id}`).set(bearer())).status).toBe(204);
    expect((await amb.http().get(`/api/tipos-estoque/${r.body.id}`).set(bearer())).status).toBe(404);
    // O nome volta a ficar livre.
    expect(
      (await amb.http().post('/api/tipos-estoque').set(bearer()).send({ nome: 'Temporário' })).status,
    ).toBe(201);
  });
});

describe('mudar o vendável ou o padrão ressincroniza o estoque (MD 6.4 regra 3; SYNC 6.7)', () => {
  let mostruario: Tipo;
  /** A Saída que zerou o Mostruário antes de ele ser inativado (estornada depois de reativar). */
  let saidaMostruario: { id: string; versao: number };

  it('tirar o vendável exige saldo zero; sem saldo, um comando por terminal ativo e a linha sai do pull', async () => {
    const r = await amb
      .http()
      .post('/api/tipos-estoque')
      .set(bearer())
      .send({ nome: 'Mostruário', vendavel: true });
    expect(r.status).toBe(201);
    // Tipo novo não tem saldo: criar vendável não ressincroniza.
    expect(r.body.terminaisRessincronizados).toBe(0);
    mostruario = r.body as Tipo;
    await acerto('entrada', mostruario.id, '5');
    const [t1] = terminais;
    expect(saldosDoTipo(await puxar(t1!.token, 'estoque'), mostruario.id)).toMatchObject([
      { produto_id: produto, quantidade: '5.000' },
    ]);

    // Com saldo, a linha sairia do filtro do pull mas ficaria no espelho do PDV instalado (sem a sombra da SYNC
    // 6.11) com as 5 unidades, contando no saldo estimado do caixa.
    const comSaldo = await alterar(mostruario, { vendavel: false });
    expect(comSaldo.status).toBe(422);
    expect(comSaldo.body.campos).toEqual({ vendavel: ['Há 1 saldo(s) diferente(s) de zero neste tipo'] });
    expect((await comandosPendentes()).size).toBe(0);
    // Zerado, o PDV recebe a linha com 0 antes de ela sair do filtro: o que fica no espelho vale 0.
    await acerto('saida', mostruario.id, '5');
    expect(saldosDoTipo(await puxar(t1!.token, 'estoque'), mostruario.id)).toMatchObject([
      { produto_id: produto, quantidade: '0.000' },
    ]);

    const tirar = await alterar(mostruario, { vendavel: false });
    expect(tirar.status, JSON.stringify(tirar.body)).toBe(200);
    expect(tirar.body).toMatchObject({ vendavel: false, terminaisRessincronizados: 3 });
    const pendentes = await comandosPendentes();
    expect([...pendentes.keys()].sort()).toEqual(terminais.map((t) => t.id).sort());
    expect([...pendentes.values()]).toEqual([1, 1, 1]);
    expect(pendentes.has(revogado)).toBe(false);
    // A ressincronização puxa do cursor 0: a linha do tipo não vendável não desce mais.
    for (const t of terminais)
      expect(saldosDoTipo(await puxar(t.token, 'estoque'), mostruario.id)).toEqual([]);
    // O próprio tipo continua descendo (fluxo `configuracao`, sem filtro), agora não vendável.
    const tiposPdv = (await puxar(t1!.token, 'configuracao')).filter((a) => a.tabela === 'tipos_estoque');
    expect(tiposPdv.find((a) => a.linha.id === mostruario.id)?.linha).toMatchObject({ vendavel: false });

    // Uma segunda mudança antes do PDV buscar o comando não empilha outro.
    expect(
      (await alterar(mostruario, { nome: 'Mostruário da vitrine' })).body.terminaisRessincronizados,
    ).toBe(0);
    const devolver = await alterar(mostruario, { vendavel: true });
    expect(devolver.body.terminaisRessincronizados).toBe(3);
    expect([...(await comandosPendentes()).values()]).toEqual([1, 1, 1]);
    expect(saldosDoTipo(await puxar(t1!.token, 'estoque'), mostruario.id)).toMatchObject([
      { quantidade: '0.000' },
    ]);
    await entregarComandos();
  });

  it('inativar exige saldo zero e nenhum acerto em rascunho; o tipo usado não se exclui', async () => {
    await acerto('entrada', mostruario.id, '5');
    const comSaldo = await alterar(mostruario, { ativo: false });
    expect(comSaldo.status).toBe(422);
    expect(Object.keys(comSaldo.body.campos)).toEqual(['ativo']);
    const usado = await amb.http().delete(`/api/tipos-estoque/${mostruario.id}`).set(bearer());
    expect(usado.status).toBe(422);
    expect(usado.body.mensagem).toContain('inative');
    saidaMostruario = await acerto('saida', mostruario.id, '5');
    // Saldo zero, mas um rascunho de Entrada no tipo: efetivá-lo depois lançaria saldo no tipo inativo.
    const pendente = await rascunho('entrada', mostruario.id, '10');
    const comRascunho = await alterar(mostruario, { ativo: false });
    expect(comRascunho.status).toBe(422);
    expect(comRascunho.body.campos).toEqual({ ativo: ['Há 1 acerto(s) em rascunho neste tipo'] });
    // A efetivação também confere o tipo (o rascunho gravado antes de o tipo ser inativado por outro caminho).
    await consultar(emp.nomeBanco, 'update tipos_estoque set ativo = false where id = $1', [mostruario.id]);
    const efetivado = await efetivar(pendente);
    expect(efetivado.status).toBe(422);
    expect(Object.keys(efetivado.body.campos)).toEqual(['tipoEstoqueId']);
    expect(efetivado.body.mensagem).toContain('inativo');
    await consultar(emp.nomeBanco, 'update tipos_estoque set ativo = true where id = $1', [mostruario.id]);
    expect((await amb.http().delete(`/api/acertos/${pendente.id}`).set(bearer())).status).toBe(204);

    const inativo = await alterar(mostruario, { ativo: false });
    expect(inativo.status, JSON.stringify(inativo.body)).toBe(200);
    expect(inativo.body).toMatchObject({ ativo: false, terminaisRessincronizados: 0 });
    // O acerto não aceita mais o tipo inativo.
    const novo = await amb
      .http()
      .post('/api/acertos')
      .set(bearer())
      .send({
        estoqueId: estoqueLoja1,
        tipoEstoqueId: mostruario.id,
        tipoAjuste: 'entrada',
        dataContagem: new Date().toISOString(),
        motivo: 'Teste',
        itens: [{ produtoId: produto, quantidade: '1' }],
      });
    expect(novo.status).toBe(422);
    expect(await saldoDoTipo(mostruario.id)).toBe(0);
  });

  it('o estorno não devolve saldo a um tipo inativo: reative antes de estornar', async () => {
    const estornar = () =>
      amb
        .http()
        .post(`/api/acertos/${saidaMostruario.id}/estornar`)
        .set(bearer())
        .send({ versao: saidaMostruario.versao, motivo: 'Saída lançada no tipo errado' });
    const recusado = await estornar();
    expect(recusado.status).toBe(422);
    expect(Object.keys(recusado.body.campos)).toEqual(['tipoEstoqueId']);
    expect(recusado.body.mensagem).toContain('reative');
    expect(await saldoDoTipo(mostruario.id)).toBe(0);
    expect((await alterar(mostruario, { ativo: true })).status).toBe(200);
    const estornado = await estornar();
    expect(estornado.status, JSON.stringify(estornado.body)).toBe(200);
    expect(await saldoDoTipo(mostruario.id)).toBe(5);
  });

  it('marcar outro tipo como padrão tira a marca do anterior, ressincroniza e fica no histórico dos dois', async () => {
    const disponivel = await porChave('disponivel');
    const r = await alterar(mostruario, { padrao: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ padrao: true, terminaisRessincronizados: 3 });
    const lista = await tipos();
    expect(lista.filter((t) => t.padrao).map((t) => t.id)).toEqual([mostruario.id]);
    expect(lista[0]!.id).toBe(mostruario.id);
    const antigo = lista.find((t) => t.id === disponivel.id)!;
    expect(antigo).toMatchObject({ padrao: false, vendavel: true });
    expect(antigo.versao).toBeGreaterThan(disponivel.versao);
    expect([...(await comandosPendentes()).values()]).toEqual([1, 1, 1]);
    const aud = await consultar<{ registro_id: string }>(
      emp.nomeBanco,
      `select registro_id from auditoria where entidade = 'tipos_estoque' and acao = 'editar'
          and registro_id = any($1::uuid[]) and (antes->>'padrao')::boolean <> (depois->>'padrao')::boolean`,
      [[mostruario.id, disponivel.id]],
    );
    expect(aud.map((a) => a.registro_id).sort()).toEqual([mostruario.id, disponivel.id].sort());
    // O novo padrão não se exclui nem perde o vendável; o Disponível, sem a marca, continua vendável (travado).
    expect((await amb.http().delete(`/api/tipos-estoque/${mostruario.id}`).set(bearer())).status).toBe(422);
    expect((await alterar(mostruario, { vendavel: false })).status).toBe(422);
    expect((await alterar(antigo, { vendavel: false })).status).toBe(422);
    // Volta ao Disponível (o acerto sem tipo e a venda do PDV usam o padrão).
    await entregarComandos();
    const volta = await alterar(antigo, { padrao: true });
    expect(volta.status).toBe(200);
    expect(volta.body.terminaisRessincronizados).toBe(3);
    expect((await tipos()).filter((t) => t.padrao).map((t) => t.chaveSistema)).toEqual(['disponivel']);
  });

  it('o padrão não se exclui, mesmo nunca usado', async () => {
    const r = await amb
      .http()
      .post('/api/tipos-estoque')
      .set(bearer())
      .send({ nome: 'Loja virtual', vendavel: true, padrao: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ padrao: true, terminaisRessincronizados: 3 });
    const excluir = await amb.http().delete(`/api/tipos-estoque/${r.body.id}`).set(bearer());
    expect(excluir.status).toBe(422);
    expect(excluir.body.mensagem).toBe('O tipo padrão não se exclui: marque outro como padrão antes.');
    // Devolvido o padrão ao Disponível, o tipo nunca usado se exclui.
    await entregarComandos();
    expect((await alterar(await porChave('disponivel'), { padrao: true })).status).toBe(200);
    expect((await amb.http().delete(`/api/tipos-estoque/${r.body.id}`).set(bearer())).status).toBe(204);
    await entregarComandos();
  });
});
