import { PERFIS_PADRAO, PERMISSOES } from '@genesis/shared';
import {
  FORMAS_PAGAMENTO_PADRAO,
  TEMPLATES_PADRAO,
  TIPOS_ESTOQUE_PADRAO,
  UNIDADES_MEDIDA_PADRAO,
} from '../../src/database/seed/dados/cadastros.js';
import {
  ATALHOS_PDV_PADRAO,
  PLANO_CONTAS_PADRAO,
  TIPOS_MOVIMENTO_ESTOQUE,
} from '../../src/database/seed/dados/tabelas-md.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErroApi } from '../../src/comum/erros.js';
import { lerMigracoes, PASTA_MIGRACOES_EMPRESA } from '../../src/database/migracoes/journal.js';
import { posMigracaoSemAdmin } from '../../src/plataforma/provisionamento.js';
import { conectar, consultar, criarAmbiente, criarUsuario, type Ambiente } from './ambiente.js';

let amb: Ambiente;

beforeAll(async () => {
  amb = await criarAmbiente({ comApp: false });
});

afterAll(async () => {
  await amb?.fechar();
});

async function contagens(banco: string) {
  const [r] = await consultar<Record<string, number>>(
    banco,
    `select
      (select count(*)::int from perfis) as perfis,
      (select count(*)::int from permissoes) as permissoes,
      (select count(*)::int from perfis_permissoes) as perfis_permissoes,
      (select count(*)::int from formas_pagamento) as formas_pagamento,
      (select count(*)::int from planos_contas) as planos_contas,
      (select count(*)::int from contas_correntes) as contas_correntes,
      (select count(*)::int from tipos_movimento_estoque) as tipos_movimento,
      (select count(*)::int from tipos_estoque) as tipos_estoque,
      (select count(*)::int from unidades_medida) as unidades,
      (select count(*)::int from cfops) as cfops,
      (select count(*)::int from cfops_grupos) as cfops_grupos,
      (select count(*)::int from atalhos_pdv) as atalhos,
      (select count(*)::int from templates_documentos) as templates,
      (select count(*)::int from ufs) as ufs,
      (select count(*)::int from municipios) as municipios,
      (select count(*)::int from meios_pagamento_fiscais) as meios_pagamento,
      (select count(*)::int from usuarios) as usuarios,
      (select count(*)::int from empresa) as empresa,
      (select count(*)::int from configuracoes) as configuracoes,
      (select last_value::int from seq_versao) as seq_versao`,
  );
  return r!;
}

describe('provisionamento de empresa (MD 7; ERP 19.4)', () => {
  it('cria o banco, aplica as migrações e o seed, com admin de senha provisória', async () => {
    const e = await amb.criarEmpresa({ razaoSocial: 'Ice Beer Teste Ltda', regime: 'simples_nacional' });
    expect(e.codigo).toBeGreaterThan(800000);
    expect(e.nomeBanco).toBe(`genesis_emp_${e.codigo}`);
    expect(e.senha).toMatch(/^[A-Za-z0-9]{12}$/);

    // `daticulocale` virou `datlocale` no PostgreSQL 17: lido pelo JSON da linha para valer no 16 e no 18 (I1).
    const [banco] = await consultar<{ datname: string; provedor: string; locale: string | null }>(
      'postgres',
      `select datname, datlocprovider::text as provedor,
              coalesce(to_jsonb(d) ->> 'datlocale', to_jsonb(d) ->> 'daticulocale') as locale
         from pg_database d where datname = $1`,
      [e.nomeBanco],
    );
    expect(banco).toMatchObject({ provedor: 'i', locale: 'pt-BR' });

    const c = await contagens(e.nomeBanco);
    expect(c).toMatchObject({
      perfis: PERFIS_PADRAO.length,
      permissoes: PERMISSOES.length,
      formas_pagamento: FORMAS_PAGAMENTO_PADRAO.length,
      planos_contas: PLANO_CONTAS_PADRAO.length,
      contas_correntes: 1,
      tipos_movimento: TIPOS_MOVIMENTO_ESTOQUE.length,
      tipos_estoque: TIPOS_ESTOQUE_PADRAO.length,
      unidades: UNIDADES_MEDIDA_PADRAO.length,
      atalhos: ATALHOS_PDV_PADRAO.length,
      templates: TEMPLATES_PADRAO.length,
      ufs: 27,
      municipios: 5571,
      meios_pagamento: 18,
      usuarios: 1,
      empresa: 1,
      configuracoes: 1,
    });
    expect(c.cfops_grupos).toBe(3 + 4 + 1 + 1 + 28);
    expect(c.perfis_permissoes).toBe(PERFIS_PADRAO.reduce((n, p) => n + p.permissoes.length, 0));

    const [admin] = await consultar(
      e.nomeBanco,
      `select u.codigo, u.login, u.master, u.senha_provisoria, u.senha_hash like '$argon2id$%' as argon, p.chave_sistema
       from usuarios u join perfis p on p.id = u.perfil_id`,
    );
    expect(admin).toEqual({
      codigo: 1,
      login: 'admin',
      master: true,
      senha_provisoria: true,
      argon: true,
      chave_sistema: 'administrador',
    });

    const [formaDinheiro] = await consultar(
      e.nomeBanco,
      `select f.lanca_quitada, f.permite_troco, f.abrir_gaveta, f.exige_pessoa, cc.chave_sistema as conta, pc.chave_sistema as plano
       from formas_pagamento f join contas_correntes cc on cc.id = f.conta_corrente_id join planos_contas pc on pc.id = f.plano_contas_id
       where f.descricao = 'Dinheiro'`,
    );
    expect(formaDinheiro).toEqual({
      lanca_quitada: true,
      permite_troco: true,
      abrir_gaveta: true,
      exige_pessoa: false,
      conta: 'caixa_interno',
      plano: 'vendas_pdv',
    });
    const [pai] = await consultar(
      e.nomeBanco,
      "select p.codigo from planos_contas f join planos_contas p on p.id = f.pai_id where f.codigo = '1.01.001'",
    );
    expect(pai).toEqual({ codigo: '1.01' });

    const migracoes = await consultar<{ migracao: string; status: string; hash: string }>(
      amb.bancoControle,
      'select migracao, status, hash from migracoes_empresas where empresa_id = $1 order by ordem',
      [e.empresaId],
    );
    expect(migracoes.map((m) => m.status)).toEqual(
      lerMigracoes(PASTA_MIGRACOES_EMPRESA).map(() => 'aplicada'),
    );
    expect(migracoes.every((m) => /^[0-9a-f]{64}$/.test(m.hash))).toBe(true);

    const [empresa] = await consultar(
      amb.bancoControle,
      'select status, versao_schema, ativada_em is not null as ativada from empresas where id = $1',
      [e.empresaId],
    );
    expect(empresa).toEqual({
      status: 'ativa',
      versao_schema: lerMigracoes(PASTA_MIGRACOES_EMPRESA).at(-1)!.tag,
      ativada: true,
    });

    const acoes = await consultar<{ acao: string }>(
      amb.bancoControle,
      'select acao from auditoria_plataforma where empresa_id = $1 order by criado_em',
      [e.empresaId],
    );
    expect(acoes.map((a) => a.acao)).toEqual(['empresa_criada', 'empresa_provisionada']);
    const [criada] = await consultar(
      amb.bancoControle,
      "select depois from auditoria_plataforma where acao = 'empresa_criada' and empresa_id = $1",
      [e.empresaId],
    );
    expect(JSON.stringify(criada)).not.toContain(e.senha);

    // Seed idempotente: reaplicar não muda nada nem gera versão nova.
    const r = await amb.servicos.migrador.migrarTodas({
      codigos: [e.codigo],
      posMigracao: posMigracaoSemAdmin(amb.servicos.controle),
    });
    expect(r.falhas).toBe(0);
    const depois = await contagens(e.nomeBanco);
    expect(depois).toEqual(c);
  });

  it('o seed repõe só o que falta (item padrão novo) e não ressuscita o que a empresa excluiu', async () => {
    const e = await amb.criarEmpresa();
    const db = await conectar(e.nomeBanco);
    try {
      await db.query("delete from atalhos_pdv where acao = 'ajuda'");
      await db.query("update formas_pagamento set excluido_em = now() where descricao = 'Boleto'");
    } finally {
      await db.end();
    }
    await amb.servicos.migrador.migrarTodas({
      codigos: [e.codigo],
      posMigracao: posMigracaoSemAdmin(amb.servicos.controle),
    });
    const [r] = await consultar(
      e.nomeBanco,
      `select (select count(*)::int from atalhos_pdv where acao = 'ajuda') as ajuda,
              (select count(*)::int from formas_pagamento where descricao = 'Boleto' and excluido_em is null) as boleto`,
    );
    expect(r).toEqual({ ajuda: 1, boleto: 0 });
  });

  // Decisões do dono de 05/11/2026 (README da API › 165 e 168): o cadastro rápido de fornecedor e, depois, o cadastro
  // completo de pessoas. A empresa antiga é a de antes de cada uma: o perfil sem a linha daquela permissão.
  it.each(['pessoas.criar_fornecedor', 'pessoas.criar'])(
    'perfil Estoquista com %s (dono, 05/11/2026): o pós-migração acrescenta na empresa antiga e não devolve o que a empresa tirou',
    async (permissao) => {
      const e = await amb.criarEmpresa();
      const estoquista = `(select id from perfis where chave_sistema = 'estoquista')`;
      const linha = () =>
        consultar<{ excluida: boolean }>(
          e.nomeBanco,
          `select excluido_em is not null as excluida from perfis_permissoes
          where perfil_id = ${estoquista} and permissao = $1`,
          [permissao],
        );
      // O seed de agora já dá a permissão ao perfil.
      expect(await linha()).toEqual([{ excluida: false }]);
      // A empresa criada antes da decisão: o perfil sem a linha, com um usuário estoquista.
      await consultar(
        e.nomeBanco,
        `delete from perfis_permissoes where perfil_id = ${estoquista} and permissao = $1`,
        [permissao],
      );
      const usuario = await criarUsuario(e.nomeBanco, { login: 'estoquista', perfil: 'estoquista' });
      const versao = async () =>
        (
          await consultar<{ v: number }>(
            e.nomeBanco,
            'select permissoes_versao as v from usuarios where id = $1',
            [usuario],
          )
        )[0]!.v;
      const antes = await versao();
      const migrar = () =>
        amb.servicos.migrador.migrarTodas({
          codigos: [e.codigo],
          posMigracao: posMigracaoSemAdmin(amb.servicos.controle),
        });
      expect((await migrar()).falhas).toBe(0);
      expect(await linha()).toEqual([{ excluida: false }]);
      // O usuário do perfil renova as permissões (o cache de acesso das instâncias da API).
      expect(await versao()).toBe(antes + 1);
      // A empresa que tirou a permissão do perfil não a recebe de volta.
      await consultar(
        e.nomeBanco,
        `update perfis_permissoes set excluido_em = now() where perfil_id = ${estoquista} and permissao = $1`,
        [permissao],
      );
      expect((await migrar()).falhas).toBe(0);
      expect(await linha()).toEqual([{ excluida: true }]);
      // Nada acrescentado, nada a renovar.
      expect(await versao()).toBe(antes + 1);
    },
  );

  it('perfil de sistema novo (Encarregado) e permissões da Central chegam à empresa já criada, uma vez só', async () => {
    // Decisão 66 do README do PDV: a empresa criada antes do G1 não tinha o Encarregado nem as permissões da Central, e
    // o dono pode já ter criado um perfil próprio chamado "Encarregado".
    const e = await amb.criarEmpresa();
    const CENTRAL = ['pdv.venda.consultar_historico', 'pdv.diagnostico.ver'];
    const db = await conectar(e.nomeBanco);
    let supervisorId: string;
    let proprioId: string;
    try {
      await db.query(
        "delete from perfis_permissoes where perfil_id = (select id from perfis where chave_sistema = 'encarregado')",
      );
      await db.query("delete from perfis where chave_sistema = 'encarregado'");
      await db.query(
        `delete from perfis_permissoes
          where permissao = any($1::varchar[]) and perfil_id = (select id from perfis where chave_sistema = 'supervisor_caixa')`,
        [CENTRAL],
      );
      const proprio = await db.query<{ id: string }>(
        `with p as (insert into perfis (nome, descricao) values ('ENCARREGADO', 'do dono') returning id)
         insert into perfis_permissoes (perfil_id, permissao) select id, 'pdv.acesso.entrar' from p returning perfil_id as id`,
      );
      proprioId = proprio.rows[0]!.id;
      const supervisor = await db.query<{ id: string }>(
        `insert into usuarios (nome, login, perfil_id)
         values ('Fiscal', 'fiscal', (select id from perfis where chave_sistema = 'supervisor_caixa')) returning id`,
      );
      supervisorId = supervisor.rows[0]!.id;
    } finally {
      await db.end();
    }
    const versao = async () =>
      (
        await consultar<{ v: number }>(
          e.nomeBanco,
          'select permissoes_versao as v from usuarios where id = $1',
          [supervisorId],
        )
      )[0]!.v;
    const antes = await versao();

    const migrar = () =>
      amb.servicos.migrador.migrarTodas({
        codigos: [e.codigo],
        posMigracao: posMigracaoSemAdmin(amb.servicos.controle),
      });
    expect((await migrar()).falhas).toBe(0);

    const perfisNome = await consultar<{ nome: string; chave: string | null; permissoes: string[] }>(
      e.nomeBanco,
      `select p.nome, p.chave_sistema as chave,
              array(select pp.permissao from perfis_permissoes pp
                     where pp.perfil_id = p.id and pp.excluido_em is null order by pp.permissao) as permissoes
         from perfis p where lower(p.nome) like 'encarregado%' order by p.chave_sistema nulls last`,
    );
    const esperado = PERFIS_PADRAO.find((p) => p.chaveSistema === 'encarregado')!;
    expect(perfisNome).toEqual([
      { nome: 'Encarregado (padrão)', chave: 'encarregado', permissoes: [...esperado.permissoes].sort() },
      { nome: 'ENCARREGADO', chave: null, permissoes: ['pdv.acesso.entrar'] },
    ]);
    const [proprio] = await consultar(e.nomeBanco, 'select descricao from perfis where id = $1', [
      proprioId!,
    ]);
    expect(proprio).toEqual({ descricao: 'do dono' });
    const [doSupervisor] = await consultar<{ n: number }>(
      e.nomeBanco,
      `select count(*)::int as n from perfis_permissoes
        where permissao = any($1::varchar[]) and excluido_em is null
          and perfil_id = (select id from perfis where chave_sistema = 'supervisor_caixa')`,
      [CENTRAL],
    );
    expect(doSupervisor!.n).toBe(CENTRAL.length);
    expect(await versao()).toBe(antes + 1);

    // De novo: nada a acrescentar, a versão do usuário não muda e não nasce um "Encarregado (padrão 2)".
    const contagem = await contagens(e.nomeBanco);
    expect((await migrar()).falhas).toBe(0);
    expect(await versao()).toBe(antes + 1);
    expect(await contagens(e.nomeBanco)).toEqual(contagem);
  });

  it('Encarregado cancela a venda paga (dono, 05/11/2026): o pós-migração acrescenta na empresa antiga, só nele, uma vez', async () => {
    // Decisão 78 do README do PDV: a empresa migrada no G1 tem o Encarregado igual ao Supervisor, com a descrição de então.
    const e = await amb.criarEmpresa();
    const PERMISSAO = 'pdv.venda.cancelar_venda_finalizada';
    const encarregado = PERFIS_PADRAO.find((p) => p.chaveSistema === 'encarregado')!;
    const perfilDe = (chave: string) => `(select id from perfis where chave_sistema = '${chave}')`;
    const linha = (chave: string) =>
      consultar<{ excluida: boolean }>(
        e.nomeBanco,
        `select excluido_em is not null as excluida from perfis_permissoes
          where perfil_id = ${perfilDe(chave)} and permissao = $1`,
        [PERMISSAO],
      );
    const descricao = async () =>
      (
        await consultar<{ descricao: string }>(
          e.nomeBanco,
          `select descricao from perfis where chave_sistema = 'encarregado'`,
        )
      )[0]!.descricao;
    // O seed de agora já dá a permissão e a descrição nova ao Encarregado; o Supervisor de caixa continua sem.
    expect(await linha('encarregado')).toEqual([{ excluida: false }]);
    expect(await linha('supervisor_caixa')).toEqual([]);
    expect(await descricao()).toBe(encarregado.descricao);
    // A empresa do G1: sem a linha e com a descrição antiga, um usuário encarregado e um supervisor.
    await consultar(
      e.nomeBanco,
      `delete from perfis_permissoes where perfil_id = ${perfilDe('encarregado')} and permissao = $1`,
      [PERMISSAO],
    );
    await consultar(e.nomeBanco, `update perfis set descricao = $1 where chave_sistema = 'encarregado'`, [
      encarregado.descricoesAnteriores![0],
    ]);
    const usuarioEncarregado = await criarUsuario(e.nomeBanco, {
      login: 'encarregado',
      perfil: 'encarregado',
    });
    const usuarioSupervisor = await criarUsuario(e.nomeBanco, {
      login: 'fiscal',
      perfil: 'supervisor_caixa',
    });
    const versao = async (id: string) =>
      (
        await consultar<{ v: number }>(
          e.nomeBanco,
          'select permissoes_versao as v from usuarios where id = $1',
          [id],
        )
      )[0]!.v;
    const antes = {
      encarregado: await versao(usuarioEncarregado),
      supervisor: await versao(usuarioSupervisor),
    };
    const migrar = () =>
      amb.servicos.migrador.migrarTodas({
        codigos: [e.codigo],
        posMigracao: posMigracaoSemAdmin(amb.servicos.controle),
      });

    expect((await migrar()).falhas).toBe(0);
    expect(await linha('encarregado')).toEqual([{ excluida: false }]);
    expect(await linha('supervisor_caixa')).toEqual([]);
    expect(await descricao()).toBe(encarregado.descricao);
    // O encarregado renova as permissões (o PDV recebe o perfil novo no próximo pull); o supervisor não muda.
    expect(await versao(usuarioEncarregado)).toBe(antes.encarregado + 1);
    expect(await versao(usuarioSupervisor)).toBe(antes.supervisor);

    // De novo: nada muda.
    expect((await migrar()).falhas).toBe(0);
    expect(await versao(usuarioEncarregado)).toBe(antes.encarregado + 1);

    // A empresa que tirou a permissão do perfil não a recebe de volta, e a descrição que ela reescreveu fica.
    await consultar(
      e.nomeBanco,
      `update perfis_permissoes set excluido_em = now() where perfil_id = ${perfilDe('encarregado')} and permissao = $1`,
      [PERMISSAO],
    );
    await consultar(
      e.nomeBanco,
      `update perfis set descricao = 'do dono' where chave_sistema = 'encarregado'`,
    );
    expect((await migrar()).falhas).toBe(0);
    expect(await linha('encarregado')).toEqual([{ excluida: true }]);
    expect(await descricao()).toBe('do dono');
  });

  it('perfil de sistema novo nunca fica sem nome, mesmo com os nomes de reserva ocupados por perfis da empresa', async () => {
    // O nome base e o "(padrão)" ocupados, mais nomes parecidos ("Encarregado (2)" a "(9)"): entra o próximo "(padrão N)"
    // livre e o pós-migração da empresa não cai.
    const e = await amb.criarEmpresa();
    const ocupados = [
      'Encarregado',
      'Encarregado (padrão)',
      ...Array.from({ length: 8 }, (_, i) => `Encarregado (${i + 2})`),
    ];
    const db = await conectar(e.nomeBanco);
    try {
      await db.query(
        "delete from perfis_permissoes where perfil_id = (select id from perfis where chave_sistema = 'encarregado')",
      );
      await db.query("delete from perfis where chave_sistema = 'encarregado'");
      await db.query('insert into perfis (nome) select unnest($1::varchar[])', [ocupados]);
    } finally {
      await db.end();
    }

    const r = await amb.servicos.migrador.migrarTodas({
      codigos: [e.codigo],
      posMigracao: posMigracaoSemAdmin(amb.servicos.controle),
    });
    expect(r.falhas).toBe(0);
    const [sistema] = await consultar<{ nome: string }>(
      e.nomeBanco,
      "select nome from perfis where chave_sistema = 'encarregado'",
    );
    expect(sistema).toEqual({ nome: 'Encarregado (padrão 2)' });
    const [proprios] = await consultar<{ n: number }>(
      e.nomeBanco,
      'select count(*)::int as n from perfis where chave_sistema is null and nome = any($1::varchar[])',
      [ocupados],
    );
    expect(proprios!.n).toBe(ocupados.length);
  });

  it('falha no provisionamento: fica "provisionando"; tentar novamente conclui e mostra nova senha', async () => {
    const codigo = amb.proximoCodigo();
    const nomeBanco = `genesis_emp_${codigo}`;
    // Banco pré-existente com um objeto conflitante faz a migração 0001 falhar.
    await consultar('postgres', `create database "${nomeBanco}"`);
    await consultar(nomeBanco, 'create table perfis (id int)');

    const erro = await amb
      .criarEmpresa({ codigo })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroApi);
    expect((erro as ErroApi).codigo).toBe('REGRA_NEGOCIO');
    expect((erro as ErroApi).extras.detalhes).toMatchObject({
      codigo,
      acoes: ['tentar_novamente', 'descartar'],
    });

    const [empresa] = await consultar<{ id: string; status: string }>(
      amb.bancoControle,
      'select id, status from empresas where codigo = $1',
      [codigo],
    );
    expect(empresa?.status).toBe('provisionando');
    const falhas = await consultar(
      amb.bancoControle,
      "select migracao, erro from migracoes_empresas where empresa_id = $1 and status = 'falhou'",
      [empresa!.id],
    );
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toMatchObject({ migracao: '0001_fundacao' });

    await consultar(nomeBanco, 'drop table perfis');
    const r = await amb.servicos.provisionamento.tentarNovamente(codigo, undefined);
    expect(r.status).toBe('ativa');
    expect(r.senhaProvisoria).toBeTruthy();
    const [depois] = await consultar(amb.bancoControle, 'select status from empresas where codigo = $1', [
      codigo,
    ]);
    expect(depois).toEqual({ status: 'ativa' });
    const pendentes = await consultar(
      amb.bancoControle,
      "select 1 from migracoes_empresas where empresa_id = $1 and status <> 'aplicada'",
      [empresa!.id],
    );
    expect(pendentes).toHaveLength(0);
  });

  it('descartar remove o banco e marca a empresa como cancelada/excluída (código não é reutilizado)', async () => {
    const codigo = amb.proximoCodigo();
    const nomeBanco = `genesis_emp_${codigo}`;
    await consultar('postgres', `create database "${nomeBanco}"`);
    await consultar(nomeBanco, 'create table usuarios (id int)');
    await expect(amb.criarEmpresa({ codigo })).rejects.toBeInstanceOf(ErroApi);

    await amb.servicos.provisionamento.descartar(codigo);
    const bancos = await consultar('postgres', 'select 1 from pg_database where datname = $1', [nomeBanco]);
    expect(bancos).toHaveLength(0);
    const [e] = await consultar(
      amb.bancoControle,
      'select status, excluido_em is not null as excluida from empresas where codigo = $1',
      [codigo],
    );
    expect(e).toEqual({ status: 'cancelada', excluida: true });
    await expect(amb.criarEmpresa({ codigo })).rejects.toMatchObject({ codigo: 'VALIDACAO' });
    const acoes = await consultar<{ acao: string }>(
      amb.bancoControle,
      'select a.acao from auditoria_plataforma a join empresas e on e.id = a.empresa_id where e.codigo = $1 order by a.criado_em',
      [codigo],
    );
    expect(acoes.map((a) => a.acao)).toEqual([
      'empresa_criada',
      'provisionamento_falhou',
      'provisionamento_descartado',
    ]);
  });

  it('plano inexistente é erro de validação e não cria empresa', async () => {
    await expect(amb.criarEmpresa({ planoCodigo: 'nao_existe' })).rejects.toMatchObject({
      codigo: 'VALIDACAO',
    });
  });
});
