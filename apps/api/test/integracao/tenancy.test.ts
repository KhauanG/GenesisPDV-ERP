import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssinadorJwt } from '../../src/seguranca/jwt.js';
import { criarContexto } from '../../src/tenancy/contexto.js';
import { BancoErradoErro, PoolsEmpresas } from '../../src/tenancy/pools-empresas.js';
import { SemContextoEmpresaErro } from '../../src/tenancy/tenancy.js';
import {
  consultar,
  criarAmbiente,
  criarUsuario,
  SENHA_TESTE,
  urlDoBanco,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

let amb: Ambiente;
let a: EmpresaTeste;
let b: EmpresaTeste;
let tokenA: string;
let tokenB: string;

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  amb = await criarAmbiente();
  a = await amb.criarEmpresa({ razaoSocial: 'Empresa A Ltda' });
  b = await amb.criarEmpresa({ razaoSocial: 'Empresa B Ltda' });
  tokenA = await amb.entrar(a.codigo, 'admin', a.senha);
  tokenB = await amb.entrar(b.codigo, 'admin', b.senha);
});

afterAll(async () => {
  await amb?.fechar();
});

describe('isolamento entre empresas (ADR-02; VG 4.3.1)', () => {
  it('requisições intercaladas de A e B sempre leem o próprio banco', async () => {
    const pedidos: Array<['A' | 'B', string]> = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? ['A', tokenA] : ['B', tokenB],
    );
    const respostas = await Promise.all(
      pedidos.map(([, t]) => amb.http().get('/api/empresa').set(bearer(t))),
    );
    respostas.forEach((r, i) => {
      expect(r.status).toBe(200);
      expect(r.body.codigo).toBe(pedidos[i]![0] === 'A' ? a.codigo : b.codigo);
    });
  });

  it('o mesmo login existe nas duas empresas, mas o token de A só vê o usuário de A', async () => {
    await criarUsuario(a.nomeBanco, { login: 'joao', perfil: 'gerente', nome: 'JOÃO DA A' });
    await criarUsuario(b.nomeBanco, { login: 'joao', perfil: 'gerente', nome: 'JOÃO DA B' });
    const lista = await amb.http().get('/api/usuarios?nome=joao').set(bearer(tokenA));
    expect(lista.body.itens.map((u: { nome: string }) => u.nome)).toEqual(['JOÃO DA A']);
    const t = await amb.entrar(b.codigo, 'joao', SENHA_TESTE);
    const eu = await amb.http().get('/api/auth/eu').set(bearer(t));
    expect(eu.body.empresa.codigo).toBe(b.codigo);
    expect(eu.body.usuario.nome).toBe('JOÃO DA B');
  });

  it('token de A não alcança B: claims trocadas, assinatura alheia e usuário de outra empresa → 401', async () => {
    const claimsA = JSON.parse(Buffer.from(tokenA.split('.')[1]!, 'base64url').toString());
    const jwt = new AssinadorJwt(amb.config.jwt.segredo, 'erp', 15);
    const [empB] = await consultar<{ id: string }>(
      amb.bancoControle,
      'select id from empresas where codigo = $1',
      [b.codigo],
    );

    // (1) eid de B com emp de A: o código precisa bater com a empresa resolvida.
    const misturado = (await jwt.assinar({ ...claimsA, eid: empB!.id })).token;
    expect((await amb.http().get('/api/empresa').set(bearer(misturado))).status).toBe(401);
    // (2) eid+emp de B com o usuário/sessão de A: o usuário não existe no banco de B.
    const outraEmpresa = (await jwt.assinar({ ...claimsA, eid: empB!.id, emp: b.codigo })).token;
    expect((await amb.http().get('/api/empresa').set(bearer(outraEmpresa))).status).toBe(401);
    // (3) payload adulterado sem reassinar.
    const corpo = Buffer.from(JSON.stringify({ ...claimsA, eid: empB!.id, emp: b.codigo })).toString(
      'base64url',
    );
    const adulterado = `${tokenA.split('.')[0]}.${corpo}.${tokenA.split('.')[2]}`;
    expect((await amb.http().get('/api/empresa').set(bearer(adulterado))).status).toBe(401);
    // (4) assinado com outra chave.
    const alheio = (await new AssinadorJwt('x'.repeat(48), 'erp', 15).assinar(claimsA)).token;
    expect((await amb.http().get('/api/empresa').set(bearer(alheio))).status).toBe(401);
    // Não há cabeçalho/parâmetro que escolha a empresa.
    const comCabecalho = await amb
      .http()
      .get('/api/empresa')
      .set(bearer(tokenA))
      .set('X-Empresa', String(b.codigo))
      .query({ empresa: b.codigo });
    expect(comCabecalho.body.codigo).toBe(a.codigo);
  });

  it('refresh token de A apresentado com o código de B é recusado', async () => {
    const login = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: a.codigo, login: 'admin', senha: SENHA_TESTE });
    const cookie = (login.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('genesis_refresh='))!
      .split(';')[0]!;
    const trocado = cookie.replace(`=${a.codigo}.`, `=${b.codigo}.`);
    expect((await amb.http().post('/api/auth/refresh').set('Cookie', trocado)).status).toBe(401);
  });

  it('acesso ao banco sem ContextoEmpresa ativo falha (nunca cai num padrão)', () => {
    expect(() => amb.servicos.tenancy.cx()).toThrow(SemContextoEmpresaErro);
  });

  it('cache de pools: chave inclui a geração, respeita o tamanho máximo e fecha os ociosos', async () => {
    const pools = new PoolsEmpresas(amb.servicos.servidores, {
      maximo: 1,
      ociosoMs: 60_000,
      conexoesPorEmpresa: 2,
    });
    try {
      const [ea, eb] = await consultar<{
        id: string;
        codigo: number;
        nome_banco: string;
        servidor_banco_id: string;
      }>(
        amb.bancoControle,
        'select id, codigo, nome_banco, servidor_banco_id from empresas where codigo in ($1, $2) order by codigo',
        [a.codigo, b.codigo],
      );
      const ctx = (e: typeof ea, geracao = 1) =>
        criarContexto({
          id: e!.id,
          codigo: e!.codigo,
          nomeBanco: e!.nome_banco,
          servidorBancoId: e!.servidor_banco_id,
          geracaoBanco: geracao,
          razaoSocial: 'x',
          nomeFantasia: null,
        });
      const usar = async (c: ReturnType<typeof ctx>) => {
        const cli = await pools.conectar(c);
        const { rows } = await cli.query<{ db: string; app: string }>(
          "select current_database() as db, current_setting('application_name') as app",
        );
        cli.release();
        return rows[0]!;
      };
      expect(await usar(ctx(ea))).toEqual({ db: a.nomeBanco, app: `emp_${a.codigo}` });
      expect(await usar(ctx(eb))).toEqual({ db: b.nomeBanco, app: `emp_${b.codigo}` });
      expect(pools.tamanho).toBe(1);
      expect(pools.chaves()[0]).toContain(eb!.id);
      await usar(ctx(eb, 2));
      expect(pools.chaves()[0]).toMatch(/\|2$/);
      expect(await pools.fecharOciosos(Date.now() + 120_000)).toBe(1);
      expect(pools.tamanho).toBe(0);
    } finally {
      await pools.fecharTodos();
    }
  });

  it('cache de pools cheio: pool com conexão emprestada nunca é fechado (o cache passa do máximo)', async () => {
    const pools = new PoolsEmpresas(amb.servicos.servidores, {
      maximo: 1,
      ociosoMs: 60_000,
      conexoesPorEmpresa: 2,
    });
    try {
      const linhas = await consultar<{
        id: string;
        codigo: number;
        nome_banco: string;
        servidor_banco_id: string;
      }>(
        amb.bancoControle,
        'select id, codigo, nome_banco, servidor_banco_id from empresas where codigo in ($1, $2) order by codigo',
        [a.codigo, b.codigo],
      );
      const [ca, cb] = linhas.map((e) =>
        criarContexto({
          id: e.id,
          codigo: e.codigo,
          nomeBanco: e.nome_banco,
          servidorBancoId: e.servidor_banco_id,
          geracaoBanco: 1,
          razaoSocial: 'x',
          nomeFantasia: null,
        }),
      );
      const emprestada = await pools.conectar(ca!);
      const outra = await pools.conectar(cb!);
      outra.release();
      expect(pools.tamanho).toBe(2);
      // A conexão de A continua utilizável e uma nova conexão de A também.
      expect((await emprestada.query('select 1 as x')).rows).toEqual([{ x: 1 }]);
      const segunda = await pools.conectar(ca!);
      segunda.release();
      emprestada.release();
      // Livre de novo, o excedente sai no próximo descarte.
      const terceira = await pools.conectar(ca!);
      terceira.release();
      expect(pools.tamanho).toBe(1);
    } finally {
      await pools.fecharTodos();
    }
  });

  it('conexão que aponta para outro banco (pooler mal roteado) é derrubada antes de qualquer consulta', async () => {
    const pools = new PoolsEmpresas(amb.servicos.servidores, {
      maximo: 5,
      ociosoMs: 60_000,
      conexoesPorEmpresa: 1,
      // Simula um PgBouncer que entrega o banco de B para o contexto de A.
      criarPool: (config) =>
        new pg.Pool({ ...config, connectionString: urlDoBanco(b.nomeBanco), database: b.nomeBanco }),
    });
    try {
      const [ea] = await consultar<{ id: string; servidor_banco_id: string }>(
        amb.bancoControle,
        'select id, servidor_banco_id from empresas where codigo = $1',
        [a.codigo],
      );
      const contexto = criarContexto({
        id: ea!.id,
        codigo: a.codigo,
        nomeBanco: a.nomeBanco,
        servidorBancoId: ea!.servidor_banco_id,
        geracaoBanco: 1,
        razaoSocial: 'A',
        nomeFantasia: null,
      });
      await expect(pools.conectar(contexto)).rejects.toBeInstanceOf(BancoErradoErro);
    } finally {
      await pools.fecharTodos();
    }
  });
});

describe('status da empresa no ERP (MD 2.3)', () => {
  it('suspensa: credencial certa → 403 EMPRESA_SUSPENSA com motivo; errada continua 401 genérico; token ativo é barrado', async () => {
    await amb.servicos.provisionamento.alterarStatus(b.codigo, 'suspender', 'inadimplência');
    const certa = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: b.codigo, login: 'admin', senha: SENHA_TESTE });
    expect(certa.status).toBe(403);
    expect(certa.body).toMatchObject({ codigo: 'EMPRESA_SUSPENSA', detalhes: { motivo: 'inadimplência' } });
    const errada = await amb
      .http()
      .post('/api/auth/login')
      .send({ codigoEmpresa: b.codigo, login: 'admin', senha: 'errada123' });
    expect(errada.status).toBe(401);
    expect((await amb.http().get('/api/empresa').set(bearer(tokenB))).body.codigo).toBe('EMPRESA_SUSPENSA');
    expect((await amb.http().get('/api/empresa').set(bearer(tokenA))).status).toBe(200);
    await amb.servicos.provisionamento.alterarStatus(b.codigo, 'reativar', null);
    expect((await amb.http().get('/api/empresa').set(bearer(tokenB))).status).toBe(200);
  });
});
