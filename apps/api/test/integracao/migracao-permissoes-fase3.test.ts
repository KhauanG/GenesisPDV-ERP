/**
 * Migração 0031 (Fase 3, F3-B3; ERP 8.8, 11.3, 11.4; README da API › decisão 222): só dados. Numa empresa que já existia
 * (catálogo e perfis de antes do F3-B3), as promoções ganham permissões próprias e a permissão efetiva de promoções de
 * cada usuário passa a ser a de produtos de hoje: o perfil com `produtos.editar` (personalizado ou de sistema) ganha
 * ver/criar/editar com a auditoria, o ajuste por usuário (concedida ou negada) vale também para elas, e o perfil de
 * sistema de que a empresa tirou a permissão de produtos não as recebe nem pelo seed. Depois do pós-migração (o seed
 * desta versão), as únicas linhas novas nos perfis são as dessa regra e as da matriz da fase (comodato, devolução em
 * dinheiro do Encarregado, baixa interna do Supervisor); nenhuma sai. A empresa nova recebe tudo pelo seed.
 *
 * A 0031 já rodou nas empresas e não se edita mais, então o teste não pode quebrar quando um bloco futuro mexer no
 * catálogo ou no seed: o que a migração grava se confere com os valores fixos do SQL dela (aplicada sozinha, sem as
 * migrações de depois); o que o pós-migração acerta (ordem e texto do catálogo, o seed) se confere com o shared de
 * hoje (o retrato de antes já sai do seed de hoje, então a permissão de um bloco futuro que o seed der a um perfil
 * aparece antes e depois). A lista dos perfis de sistema que a 0031 protege, conferida com o seed de hoje, fica no
 * `permissoes.spec.ts` do shared.
 */
import { calcularPermissoesEfetivas, PERFIS_PADRAO, PERMISSOES } from '@genesis/shared';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garantirBanco } from '../../src/database/migracoes/controle.js';
import { aplicarMigracoes } from '../../src/database/migracoes/executor.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { PREPARACOES_MIGRACAO_EMPRESA } from '../../src/database/migracoes/preparacoes-empresa.js';
import { posMigracaoEmpresa } from '../../src/plataforma/provisionamento.js';
import { conectar, consultar, criarAmbiente, urlDoBanco, type Ambiente } from './ambiente.js';

const TAG = '0031_fase3_permissoes';
const migracoes = lerMigracoes(PASTA_MIGRACOES_EMPRESA);
const corte = migracoes.findIndex((m) => m.tag === TAG);

const PROMOCOES = ['promocoes.ver', 'promocoes.criar', 'promocoes.editar', 'promocoes.excluir'];
const EDITAR = PROMOCOES.slice(0, 3);
/** As chaves que o catálogo de antes do F3-B3 não tinha. */
const NOVAS = [...PROMOCOES, 'pdv.vasilhame.comodato'];
/** As chaves de antes que a matriz da fase acrescenta aos perfis de sistema pelo seed. */
const MATRIZ_FASE = ['pdv.troca.devolver_dinheiro', 'pdv.pagamento.consumo_interno'];
/** O que o SQL da 0031 grava no catálogo (fixo; o pós-migração acerta a ordem e o texto com o shared de hoje). */
const CATALOGO_0031 = [
  { chave: 'promocoes.criar', modulo: 'erp', grupo: 'Produtos', descricao: 'Promoções: Criar', ordem: 3016 },
  {
    chave: 'promocoes.editar',
    modulo: 'erp',
    grupo: 'Produtos',
    descricao: 'Promoções: Editar',
    ordem: 3017,
  },
  {
    chave: 'promocoes.excluir',
    modulo: 'erp',
    grupo: 'Produtos',
    descricao: 'Promoções: Excluir',
    ordem: 3018,
  },
  { chave: 'promocoes.ver', modulo: 'erp', grupo: 'Produtos', descricao: 'Promoções: Ver', ordem: 3015 },
].map((p) => ({ ...p, permiteLiberacao: true }));
const DESCRICAO_ENCARREGADO_ANTERIOR =
  'Perfil do sistema, só PDV: Supervisor de caixa + cancelar a venda paga do caixa aberto (libera ações no caixa); para quem libera na loja sem gerente';

const DADOS = {
  codigo: 999_031,
  razaoSocial: 'Empresa Antiga Ltda',
  nomeFantasia: null,
  cnpj: '11222333000181',
  email: null,
  regime: 'simples_nacional' as const,
};

const banco = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_m31`;
let c: pg.Client;
let amb: Ambiente;
let bancoNovo: string;
const perfil: Record<string, string> = {};
const usuario: Record<string, string> = {};

type Retrato = {
  /** `perfil_id permissao` das linhas ativas. */
  ativas: Set<string>;
  /** `perfil_id permissao` das linhas excluídas. */
  excluidas: Set<string>;
  versoes: Map<string, number>;
};

async function um(sql: string, params: unknown[] = []): Promise<string> {
  return (await c.query<{ id: string }>(sql, params)).rows[0]!.id;
}

async function idPerfil(chave: string): Promise<string> {
  return um('select id from perfis where chave_sistema = $1', [chave]);
}

async function criarPerfil(nome: string, permissoes: string[], excluido = false): Promise<string> {
  const id = await um(
    `insert into perfis (nome, descricao, excluido_em) values ($1, 'Perfil da empresa', $2) returning id`,
    [nome, excluido ? new Date() : null],
  );
  for (const p of permissoes)
    await c.query('insert into perfis_permissoes (perfil_id, permissao) values ($1, $2)', [id, p]);
  return id;
}

async function criarUsuario(
  login: string,
  perfilId: string,
  ajustes: Array<[string, 'conceder' | 'negar']> = [],
) {
  const id = await um(
    `insert into usuarios (nome, login, senha_hash, perfil_id) values ($1, $1, 'x', $2) returning id`,
    [login, perfilId],
  );
  for (const [permissao, efeito] of ajustes)
    await c.query('insert into usuarios_permissoes (usuario_id, permissao, efeito) values ($1, $2, $3)', [
      id,
      permissao,
      efeito,
    ]);
  return id;
}

async function tirar(perfilId: string, permissao: string): Promise<void> {
  await c.query(
    'update perfis_permissoes set excluido_em = now() where perfil_id = $1 and permissao = $2 and excluido_em is null',
    [perfilId, permissao],
  );
}

async function retrato(): Promise<Retrato> {
  const { rows } = await c.query<{ perfil_id: string; permissao: string; excluida: boolean }>(
    'select perfil_id, permissao, excluido_em is not null as excluida from perfis_permissoes',
  );
  const versoes = await c.query<{ id: string; permissoes_versao: number }>(
    'select id, permissoes_versao from usuarios',
  );
  return {
    ativas: new Set(rows.filter((r) => !r.excluida).map((r) => `${r.perfil_id} ${r.permissao}`)),
    excluidas: new Set(rows.filter((r) => r.excluida).map((r) => `${r.perfil_id} ${r.permissao}`)),
    versoes: new Map(versoes.rows.map((r) => [r.id, r.permissoes_versao])),
  };
}

/** Permissões efetivas de um usuário pelo banco (MD 3.3.4), com a mesma função do login. */
async function efetivas(usuarioId: string): Promise<Set<string>> {
  const [u] = (
    await c.query<{ master: boolean; perfil_id: string | null }>(
      'select master, perfil_id from usuarios where id = $1',
      [usuarioId],
    )
  ).rows;
  const doPerfil = (
    await c.query<{ permissao: string }>(
      'select permissao from perfis_permissoes where perfil_id = $1 and excluido_em is null',
      [u!.perfil_id],
    )
  ).rows.map((r) => r.permissao);
  const ajustes = (
    await c.query<{ permissao: string; efeito: string }>(
      'select permissao, efeito from usuarios_permissoes where usuario_id = $1 and excluido_em is null',
      [usuarioId],
    )
  ).rows;
  return calcularPermissoesEfetivas({
    master: u!.master,
    doPerfil,
    concedidas: ajustes.filter((a) => a.efeito === 'conceder').map((a) => a.permissao),
    negadas: ajustes.filter((a) => a.efeito === 'negar').map((a) => a.permissao),
  });
}

const diferenca = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();

async function catalogoDePromocoes(): Promise<Array<Record<string, unknown>>> {
  return (
    await c.query(
      `select chave, modulo, grupo, descricao, ordem, permite_liberacao as "permiteLiberacao"
         from permissoes where chave = any($1::varchar[]) order by chave`,
      [PROMOCOES],
    )
  ).rows;
}

let antes: Retrato;
let depoisMigracao: Retrato;
let depois: Retrato;
let catalogoDaMigracao: Array<Record<string, unknown>>;
const efetivasAntes = new Map<string, Set<string>>();

beforeAll(async () => {
  expect(corte).toBeGreaterThan(0);
  await garantirBanco(urlDoBanco(banco));
  c = await conectar(banco);
  await aplicarMigracoes(c, migracoes.slice(0, corte));
  await posMigracaoEmpresa(c, DADOS);
  // O pós-migração já roda com o catálogo e o seed desta versão: volta a empresa ao que ela era antes do F3-B3 (sem as
  // chaves novas e sem as linhas que o seed novo acrescenta aos perfis de sistema, com a descrição antiga do
  // Encarregado).
  await c.query('delete from perfis_permissoes where permissao = any($1::varchar[])', [NOVAS]);
  await c.query(
    `delete from perfis_permissoes pp using perfis p
      where pp.perfil_id = p.id
        and ((p.chave_sistema = 'encarregado' and pp.permissao = 'pdv.troca.devolver_dinheiro')
          or (p.chave_sistema in ('supervisor_caixa', 'encarregado') and pp.permissao = 'pdv.pagamento.consumo_interno'))`,
  );
  await c.query('delete from permissoes where chave = any($1::varchar[])', [NOVAS]);
  await c.query("update perfis set descricao = $1 where chave_sistema = 'encarregado'", [
    DESCRICAO_ENCARREGADO_ANTERIOR,
  ]);

  for (const p of PERFIS_PADRAO) perfil[p.chaveSistema] = await idPerfil(p.chaveSistema);
  // A empresa mexeu em dois perfis de sistema: o Estoquista não edita mais produtos e o Gerente não exclui.
  await tirar(perfil.estoquista!, 'produtos.editar');
  await tirar(perfil.gerente!, 'produtos.excluir');
  perfil.editor = await criarPerfil('Balconista que edita', [
    'produtos.ver',
    'produtos.editar',
    'pessoas.ver',
  ]);
  perfil.consulta = await criarPerfil('Só consulta', ['produtos.ver']);
  perfil.exEditor = await criarPerfil('Ex-editor', ['produtos.ver', 'produtos.editar']);
  await tirar(perfil.exEditor, 'produtos.editar');
  perfil.excluido = await criarPerfil('Perfil apagado', ['produtos.editar'], true);

  usuario.editor = await criarUsuario('editor', perfil.editor);
  usuario.editorNegado = await criarUsuario('editor_negado', perfil.editor, [['produtos.editar', 'negar']]);
  usuario.consulta = await criarUsuario('consulta', perfil.consulta);
  usuario.consultaConcedido = await criarUsuario('consulta_concedido', perfil.consulta, [
    ['produtos.editar', 'conceder'],
    ['produtos.excluir', 'conceder'],
  ]);
  usuario.exEditor = await criarUsuario('ex_editor', perfil.exEditor);
  usuario.gerenteNegado = await criarUsuario('gerente_negado', perfil.gerente!, [
    ['produtos.editar', 'negar'],
    ['produtos.excluir', 'negar'],
  ]);
  usuario.gerente = await criarUsuario('gerente', perfil.gerente!);
  usuario.administrador = await criarUsuario('administrador', perfil.administrador!);
  usuario.estoquista = await criarUsuario('estoquista', perfil.estoquista!);
  usuario.operador = await criarUsuario('operador', perfil.operador_caixa!);
  usuario.encarregado = await criarUsuario('encarregado', perfil.encarregado!);
  usuario.vendedor = await criarUsuario('vendedor', perfil.vendedor!);
  for (const id of Object.values(usuario)) efetivasAntes.set(id, await efetivas(id));
  antes = await retrato();

  // A 0031 sozinha (sem as migrações de depois, que um bloco futuro pode acrescentar) e só então o resto e o seed.
  await aplicarMigracoes(c, migracoes.slice(0, corte + 1), { preparacoes: PREPARACOES_MIGRACAO_EMPRESA });
  depoisMigracao = await retrato();
  catalogoDaMigracao = await catalogoDePromocoes();
  await aplicarMigracoes(c, migracoes, { preparacoes: PREPARACOES_MIGRACAO_EMPRESA });
  await posMigracaoEmpresa(c, DADOS);
  depois = await retrato();

  amb = await criarAmbiente({ comApp: false });
  bancoNovo = (await amb.criarEmpresa()).nomeBanco;
}, 180_000);

afterAll(async () => {
  await c?.end();
  await consultar('postgres', `drop database if exists "${banco}" with (force)`);
  await amb?.fechar();
});

describe('migração 0031_fase3_permissoes (F3-B3)', () => {
  it('as chaves de promoções entram no catálogo pela própria migração (a FK dos perfis exige a chave)', () => {
    expect(catalogoDaMigracao).toEqual(CATALOGO_0031);
  });

  it('o pós-migração deixa o catálogo de promoções igual ao do shared de hoje (ordem e texto inclusive)', async () => {
    const doShared = PERMISSOES.filter((p) => PROMOCOES.includes(p.chave))
      .map((p) => ({ ...p }))
      .sort((a, b) => a.chave.localeCompare(b.chave));
    expect(await catalogoDePromocoes()).toEqual(doShared);
  });

  it('a permissão efetiva de promoções de cada usuário é a de produtos de antes (ver/criar/editar ⇔ produtos.editar)', async () => {
    for (const [nome, id] of Object.entries(usuario)) {
      const agora = await efetivas(id);
      const antesDele = efetivasAntes.get(id)!;
      for (const p of EDITAR) expect(agora.has(p), `${nome}: ${p}`).toBe(antesDele.has('produtos.editar'));
      // Excluir promoções só com excluir produtos, e só pelos perfis de sistema que o têm no seed.
      if (agora.has('promocoes.excluir')) expect(antesDele.has('produtos.excluir'), nome).toBe(true);
      // Fora das promoções e da matriz da fase, nada mudou para ninguém.
      const fase = new Set([...NOVAS, ...MATRIZ_FASE]);
      expect(
        [...agora].filter((x) => !fase.has(x) && !antesDele.has(x)),
        `${nome}: ganhou`,
      ).toEqual([]);
      expect(
        [...antesDele].filter((x) => !agora.has(x)),
        `${nome}: perdeu`,
      ).toEqual([]);
    }
    const promocoesDe = async (u: string) =>
      [...(await efetivas(u))].filter((x) => x.startsWith('promocoes.')).sort();
    expect(await promocoesDe(usuario.editor!)).toEqual([
      'promocoes.criar',
      'promocoes.editar',
      'promocoes.ver',
    ]);
    expect(await promocoesDe(usuario.editorNegado!)).toEqual([]);
    expect(await promocoesDe(usuario.consulta!)).toEqual([]);
    expect(await promocoesDe(usuario.consultaConcedido!)).toEqual([
      'promocoes.criar',
      'promocoes.editar',
      'promocoes.ver',
    ]);
    expect(await promocoesDe(usuario.exEditor!)).toEqual([]);
    expect(await promocoesDe(usuario.gerenteNegado!)).toEqual([]);
    expect(await promocoesDe(usuario.gerente!)).toEqual([
      'promocoes.criar',
      'promocoes.editar',
      'promocoes.ver',
    ]);
    expect(await promocoesDe(usuario.administrador!)).toEqual([...PROMOCOES].sort());
    expect(await promocoesDe(usuario.estoquista!)).toEqual([]);
    for (const u of ['operador', 'encarregado', 'vendedor'])
      expect(await promocoesDe(usuario[u]!), u).toEqual([]);
  });

  it('nos perfis, só entram as linhas da regra e da matriz da fase; nenhuma sai', () => {
    const linha = (p: string, permissao: string) => `${perfil[p]} ${permissao}`;
    expect(diferenca(antes.ativas, depois.ativas)).toEqual([]);
    expect(diferenca(depois.ativas, antes.ativas)).toEqual(
      [
        ...EDITAR.map((p) => linha('editor', p)),
        ...PROMOCOES.map((p) => linha('administrador', p)),
        linha('administrador', 'pdv.vasilhame.comodato'),
        ...EDITAR.map((p) => linha('gerente', p)),
        linha('gerente', 'pdv.vasilhame.comodato'),
        linha('operador_caixa', 'pdv.vasilhame.comodato'),
        linha('supervisor_caixa', 'pdv.vasilhame.comodato'),
        linha('supervisor_caixa', 'pdv.pagamento.consumo_interno'),
        linha('encarregado', 'pdv.vasilhame.comodato'),
        linha('encarregado', 'pdv.pagamento.consumo_interno'),
        linha('encarregado', 'pdv.troca.devolver_dinheiro'),
      ].sort(),
    );
    // Os perfis de sistema que a empresa tirou de produtos ficam com as linhas de promoções já excluídas (o seed não
    // as acrescenta); os personalizados sem a permissão, sem linha nenhuma.
    expect(diferenca(depois.excluidas, antes.excluidas)).toEqual(
      [...EDITAR.map((p) => linha('estoquista', p)), linha('gerente', 'promocoes.excluir')].sort(),
    );
  });

  it('a migração sozinha mexe só em promoções; o resto da matriz chega pelo seed', () => {
    const novas = diferenca(depoisMigracao.ativas, antes.ativas);
    expect(novas.every((l) => / promocoes\.(ver|criar|editar)$/.test(l))).toBe(true);
    expect(novas.filter((l) => l.startsWith(`${perfil.editor} `))).toHaveLength(3);
    for (const p of ['consulta', 'exEditor', 'excluido', 'estoquista', 'operador_caixa'])
      expect(
        novas.filter((l) => l.startsWith(`${perfil[p]} `)),
        p,
      ).toEqual([]);
  });

  it('auditoria: uma linha por perfil e por usuário alterado, com o antes e o incluído', async () => {
    const { rows } = await c.query<{
      entidade: string;
      registro_id: string;
      origem: string;
      antes: Record<string, unknown>;
      depois: Record<string, unknown>;
    }>(
      `select entidade, registro_id, origem, antes, depois from auditoria
        where acao = 'permissoes_alteradas' and descricao like 'Fase 3 (migração 0031)%' order by entidade, registro_id`,
    );
    const perfis = rows.filter((r) => r.entidade === 'perfis');
    expect(perfis.map((r) => r.registro_id).sort()).toEqual(
      [perfil.editor!, perfil.administrador!, perfil.gerente!].sort(),
    );
    const doEditor = perfis.find((r) => r.registro_id === perfil.editor)!;
    expect(doEditor.origem).toBe('sistema');
    expect(doEditor.antes).toEqual({ permissoes: ['pessoas.ver', 'produtos.editar', 'produtos.ver'] });
    expect(doEditor.depois).toEqual({
      permissoes: ['pessoas.ver', 'produtos.editar', 'produtos.ver', ...EDITAR].sort(),
      incluidas: [...EDITAR].sort(),
      removidas: [],
    });
    const usuarios = rows.filter((r) => r.entidade === 'usuarios');
    expect(usuarios.map((r) => r.registro_id).sort()).toEqual(
      [usuario.editorNegado!, usuario.consultaConcedido!, usuario.gerenteNegado!].sort(),
    );
    const concedido = usuarios.find((r) => r.registro_id === usuario.consultaConcedido)!;
    expect(concedido.depois.incluidos).toEqual(
      [...EDITAR].sort().map((permissao) => ({ permissao, efeito: 'conceder' })),
    );
    const negado = usuarios.find((r) => r.registro_id === usuario.gerenteNegado)!;
    expect(negado.depois.incluidos).toEqual(
      [...PROMOCOES].sort().map((permissao) => ({ permissao, efeito: 'negar' })),
    );
  });

  it('permissoes_versao + 1 só de quem a migração alterou (o ERP e o PDV recarregam as permissões)', () => {
    const subiu = (u: string) => depoisMigracao.versoes.get(usuario[u]!)! - antes.versoes.get(usuario[u]!)!;
    for (const u of ['editor', 'consultaConcedido', 'gerente', 'administrador']) expect(subiu(u), u).toBe(1);
    // O negado do perfil Balconista: +1 pelo perfil e +1 pelo próprio ajuste.
    expect(subiu('editorNegado')).toBe(2);
    expect(subiu('gerenteNegado')).toBe(2);
    for (const u of ['consulta', 'exEditor', 'estoquista', 'operador', 'encarregado', 'vendedor'])
      expect(subiu(u), u).toBe(0);
  });

  it('o pós-migração troca a descrição antiga do Encarregado e reaplicar não muda nada', async () => {
    const [enc] = (
      await c.query<{ descricao: string }>("select descricao from perfis where chave_sistema = 'encarregado'")
    ).rows;
    expect(enc!.descricao).toBe(PERFIS_PADRAO.find((p) => p.chaveSistema === 'encarregado')!.descricao);
    await posMigracaoEmpresa(c, DADOS);
    const outra = await retrato();
    expect(outra.ativas).toEqual(depois.ativas);
    expect(outra.excluidas).toEqual(depois.excluidas);
    expect(outra.versoes).toEqual(depois.versoes);
  });

  it('empresa nova: os perfis de sistema recebem pelo seed as permissões da fase, como no PERFIS_PADRAO', async () => {
    const rows = await consultar<{ chave_sistema: string; permissao: string }>(
      bancoNovo,
      `select p.chave_sistema, pp.permissao from perfis_permissoes pp join perfis p on p.id = pp.perfil_id
        where pp.excluido_em is null and p.chave_sistema is not null`,
    );
    for (const p of PERFIS_PADRAO) {
      const noBanco = rows
        .filter((r) => r.chave_sistema === p.chaveSistema)
        .map((r) => r.permissao)
        .sort();
      expect(noBanco, p.chaveSistema).toEqual([...new Set(p.permissoes)].sort());
    }
  });
});
