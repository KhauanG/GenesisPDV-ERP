/**
 * Ambiente isolado para testes de integração contra o PostgreSQL de `DATABASE_URL` (padrão: servidor local).
 * Cada ambiente cria um banco de controle próprio e uma faixa de códigos de empresa livre no servidor, e no fim
 * remove todos os bancos que criou.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { criarEmpresaSchema, type CriarEmpresaEntrada, completarCnpj } from '@genesis/shared';
import pg from 'pg';
import request from 'supertest';
import { criarAplicacao } from '../../src/app.js';
import {
  carregarArquivosEnv,
  carregarConfiguracao,
  type Configuracao,
} from '../../src/config/configuracao.js';
import { garantirBanco, migrarControle, seedControle } from '../../src/database/migracoes/controle.js';
import { criarServicos, type Servicos } from '../../src/servicos.js';

// O DATABASE_URL do apps/api/.env (se houver) vale também para os testes; a variável do processo tem prioridade.
carregarArquivosEnv(fileURLToPath(new URL('../..', import.meta.url)));

export const URL_BASE =
  process.env.DATABASE_URL ?? 'postgres://genesis:genesis_dev@127.0.0.1:5432/genesis_control';

/** Faixa de códigos de empresa dos testes (MD 2.3 começa em 100001; aqui ficam bancos descartáveis). */
export const FAIXA_TESTES = { inicio: 800_000, fim: 990_999 } as const;

/** Faixa do e2e PDV ↔ API (`test/e2e-pdv/servidor.ts`), em blocos de 1.000; o `test:limpar` também a reconhece. */
export const FAIXA_E2E_PDV = { inicio: 600_000, fim: 699_999 } as const;

export function urlDoBanco(nome: string): string {
  const u = new URL(URL_BASE);
  u.pathname = `/${nome}`;
  return u.toString();
}

export async function consultar<T extends pg.QueryResultRow = pg.QueryResultRow>(
  banco: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: urlDoBanco(banco) });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export async function conectar(banco: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoBanco(banco) });
  await c.connect();
  return c;
}

export interface EmpresaTeste {
  empresaId: string;
  codigo: number;
  nomeBanco: string;
  senha: string;
}

export interface Ambiente {
  config: Configuracao;
  servicos: Servicos;
  app: INestApplication | null;
  bancoControle: string;
  http(): ReturnType<typeof request>;
  proximoCodigo(): number;
  criarEmpresa(dados?: Partial<CriarEmpresaEntrada>): Promise<EmpresaTeste>;
  /** Login com troca da senha provisória; devolve o token de acesso já liberado. */
  entrar(codigo: number, login: string, senha: string): Promise<string>;
  fechar(): Promise<void>;
}

/**
 * Reserva uma faixa de 1.000 códigos livre no servidor: a trava consultiva (de sessão) fica numa conexão aberta até
 * o fim do arquivo, então dois arquivos em paralelo nunca escolhem a mesma faixa.
 */
async function reservarFaixaLivre(): Promise<{ base: number; trava: pg.Client }> {
  const trava = await conectar('postgres');
  try {
    for (let i = 0; i < 50; i++) {
      const base = randomInt(FAIXA_TESTES.inicio / 1000, (FAIXA_TESTES.fim + 1) / 1000) * 1000;
      const { rows: lock } = await trava.query<{ ok: boolean }>(
        "select pg_try_advisory_lock(hashtext('genesis:testes:faixa'), $1) as ok",
        [base],
      );
      if (!lock[0]?.ok) continue;
      const { rows } = await trava.query<{ n: number }>(
        `select count(*)::int as n from pg_database
         where datname ~ '^genesis_emp_[0-9]+$' and substring(datname from 13)::int between $1 and $2`,
        [base, base + 999],
      );
      if (rows[0]?.n === 0) return { base, trava };
      await trava.query("select pg_advisory_unlock(hashtext('genesis:testes:faixa'), $1)", [base]);
    }
  } catch (e) {
    await trava.end();
    throw e;
  }
  await trava.end();
  throw new Error('Sem faixa de códigos livre para o teste');
}

export const SENHA_TESTE = 'SenhaNova123';

export async function criarAmbiente(
  opcoes: { comApp?: boolean; env?: Record<string, string> } = {},
): Promise<Ambiente> {
  const bancoControle = `genesis_t_${Date.now().toString(36)}${randomBytes(3).toString('hex')}_ctl`;
  const url = urlDoBanco(bancoControle);
  await garantirBanco(url);
  await migrarControle(url);
  const { base, trava } = await reservarFaixaLivre();
  await consultar(bancoControle, `alter sequence seq_codigo_empresa restart with ${base + 1}`);
  let codigoManual = base + 500;

  const config = carregarConfiguracao({
    AMBIENTE: 'teste',
    DATABASE_URL: url,
    LOG_NIVEL: 'silent',
    TENANCY_CACHE_MS: '0',
    LOGIN_LIMITE_POR_MINUTO: '1000',
    LOGIN_LIMITE_POR_CONTA_MINUTO: '1000',
    // A fila (pg-boss) só sobe nos testes que a usam.
    FILA_TRABALHADOR: 'false',
    ...opcoes.env,
  });
  const servicos = criarServicos(config, { executadoPor: 'vitest' });
  await seedControle(servicos.controle, servicos.servidores);
  let app: INestApplication | null = null;
  if (opcoes.comApp !== false) {
    app = (await criarAplicacao(config, servicos)).app;
    await app.init();
    // Servidor já escutando: o supertest não abre uma porta nova por requisição.
    await app.listen(0, '127.0.0.1');
  }

  const ambiente: Ambiente = {
    config,
    servicos,
    app,
    bancoControle,
    http() {
      if (!app) throw new Error('Ambiente sem app HTTP');
      return request(app.getHttpServer());
    },
    proximoCodigo() {
      return ++codigoManual;
    },
    async criarEmpresa(dados = {}) {
      const entrada = criarEmpresaSchema.parse({
        razaoSocial: `Empresa Teste ${randomBytes(2).toString('hex')} Ltda`,
        cnpj: completarCnpj(`${randomInt(10 ** 11, 10 ** 12 - 1)}`.slice(0, 12)),
        planoCodigo: 'padrao',
        ...dados,
      });
      const r = await servicos.provisionamento.criar(entrada);
      return { empresaId: r.empresaId, codigo: r.codigo, nomeBanco: r.nomeBanco, senha: r.senhaProvisoria! };
    },
    async entrar(codigo, login, senha) {
      const r = await ambiente.http().post('/api/auth/login').send({ codigoEmpresa: codigo, login, senha });
      if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${JSON.stringify(r.body)}`);
      if (!r.body.trocarSenha) return r.body.tokenAcesso as string;
      const t = await ambiente
        .http()
        .post('/api/auth/trocar-senha')
        .set('Authorization', `Bearer ${r.body.tokenAcesso}`)
        .send({ senhaAtual: senha, novaSenha: SENHA_TESTE });
      if (t.status !== 200) throw new Error(`troca de senha falhou: ${t.status} ${JSON.stringify(t.body)}`);
      return t.body.tokenAcesso as string;
    },
    async fechar() {
      const bancos = await consultar<{ nome_banco: string }>(
        bancoControle,
        'select nome_banco from empresas',
      );
      if (app) await app.close();
      else await servicos.fechar();
      for (const { nome_banco } of bancos) {
        await consultar('postgres', `drop database if exists "${nome_banco}" with (force)`);
        await consultar('postgres', `drop role if exists "${nome_banco}_app"`);
      }
      await consultar('postgres', `drop database if exists "${bancoControle}" with (force)`);
      await trava.end();
    },
  };
  return ambiente;
}

/** Loja + estoque vinculado (o assistente de primeira configuração entra na Fase 1). */
export async function criarLoja(banco: string, codigo: number, nome: string): Promise<string> {
  const [estoque] = await consultar<{ id: string }>(
    banco,
    'insert into estoques (nome) values ($1) returning id',
    [`Estoque ${nome}`],
  );
  const cnpj = completarCnpj(`${codigo}`.padStart(2, '0') + randomInt(10 ** 9, 10 ** 10 - 1).toString());
  const [loja] = await consultar<{ id: string }>(
    banco,
    `insert into lojas (codigo, nome, razao_social, nome_fantasia, cnpj, estoque_id, cep, logradouro, numero, bairro, municipio_ibge, uf)
     values ($1, $2, $2, $2, $3, $4, '01001000', 'Praça da Sé', '1', 'Sé', 3550308, 'SP') returning id`,
    [codigo, nome, cnpj, estoque!.id],
  );
  return loja!.id;
}

/**
 * Usuário de teste com a senha `SENHA_TESTE`. Estoques permitidos (decisão 149): sem `estoques`, o usuário recebe o
 * que a virada (migração 0019) daria a um usuário do piloto — os estoques das lojas dele e os sem loja que existem
 * agora —, para as suítes anteriores à Fase 2 seguirem com o mesmo acesso. `estoques: []` = nenhum.
 */
export async function criarUsuario(
  banco: string,
  dados: {
    login: string;
    perfil?: string;
    master?: boolean;
    lojas?: string[];
    nome?: string;
    estoques?: readonly string[];
  },
): Promise<string> {
  const { gerarHashSenha } = await import('../../src/seguranca/senhas.js');
  const [u] = await consultar<{ id: string }>(
    banco,
    `insert into usuarios (nome, login, senha_hash, master, perfil_id)
     values ($1, $2, $3, $4, (select id from perfis where chave_sistema = $5)) returning id`,
    [
      dados.nome ?? dados.login.toUpperCase(),
      dados.login,
      await gerarHashSenha(SENHA_TESTE),
      dados.master ?? false,
      dados.perfil ?? null,
    ],
  );
  for (const loja of dados.lojas ?? []) {
    await consultar(banco, 'insert into usuarios_lojas (usuario_id, loja_id) values ($1, $2)', [u!.id, loja]);
  }
  if (dados.master) return u!.id;
  if (dados.estoques) {
    for (const estoque of dados.estoques) {
      await consultar(banco, 'insert into usuarios_estoques (usuario_id, estoque_id) values ($1, $2)', [
        u!.id,
        estoque,
      ]);
    }
  } else {
    await consultar(
      banco,
      `insert into usuarios_estoques (usuario_id, estoque_id)
       select $1, e.id from estoques e
        where e.excluido_em is null
          and not exists (select 1 from lojas lx where lx.estoque_id = e.id and lx.excluido_em is null
                            and not (lx.id = any($2::uuid[])))`,
      [u!.id, dados.lojas ?? []],
    );
  }
  return u!.id;
}
