import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gerarHashSenha } from '../../src/seguranca/senhas.js';
import {
  consultar,
  criarAmbiente,
  criarUsuario,
  SENHA_TESTE,
  type Ambiente,
  type EmpresaTeste,
} from './ambiente.js';

/**
 * Login com o argon2 ocupado (decisão 204): a espera vencida na fila do login é 503 `SISTEMA_OCUPADO` com
 * `Retry-After`, e **não** conta como senha errada (nem `tentativas_falhas`, nem `login_negado`, nem
 * `historico_logins`), com o usuário existente ou não. Arquivo à parte: as filas do argon2 leem o ambiente ao carregar
 * (aqui, uma vaga só e 1 s de espera máxima), e o `hash` do argon2 pode ser segurado pelo teste para ocupar a vaga.
 */
const controle = vi.hoisted(() => {
  process.env.ARGON2_CONCORRENCIA = '1';
  process.env.ARGON2_ESPERA_MAXIMA_S = '1';
  return { segurar: null as Promise<void> | null, comecou: () => {} };
});

vi.mock('argon2', async (original) => {
  const real = ((await original()) as { default: typeof import('argon2') }).default;
  return {
    default: {
      ...real,
      hash: async (...args: Parameters<typeof real.hash>) => {
        if (controle.segurar) {
          controle.comecou();
          await controle.segurar;
        }
        return real.hash(...args);
      },
    },
  };
});

let amb: Ambiente;
let emp: EmpresaTeste;

beforeAll(async () => {
  amb = await criarAmbiente();
  emp = await amb.criarEmpresa();
  await criarUsuario(emp.nomeBanco, { login: 'caixa_ocupado', master: true });
});

afterAll(async () => {
  await amb?.fechar();
});

/** Ocupa a única vaga do argon2 com um hash de gestão (já calculando) até `soltar()`. */
async function ocuparVaga() {
  let soltar!: () => void;
  const comecou = new Promise<void>((r) => (controle.comecou = r));
  controle.segurar = new Promise<void>((r) => (soltar = r));
  const feito = gerarHashSenha('ocupando');
  await comecou;
  return {
    feito,
    soltar: () => {
      controle.segurar = null;
      soltar();
    },
  };
}

const login = (login: string, senha: string) =>
  amb.http().post('/api/auth/login').send({ codigoEmpresa: emp.codigo, login, senha });

describe('login com o argon2 ocupado (decisão 204)', () => {
  it('503 com Retry-After, sem contar tentativa nem registrar login negado; liberada a vaga, volta ao normal', async () => {
    const vaga = await ocuparVaga();
    try {
      for (const r of await Promise.all([
        login('caixa_ocupado', 'SenhaErrada1'),
        login('caixa_ocupado', SENHA_TESTE),
        login('nao_existe_ocupado', 'SenhaErrada1'),
      ])) {
        expect(r.status).toBe(503);
        expect(r.body.codigo).toBe('SISTEMA_OCUPADO');
        expect(r.headers['retry-after']).toBe('5');
      }
    } finally {
      vaga.soltar();
      await vaga.feito;
    }
    const estado = async () => ({
      usuario: await consultar(
        emp.nomeBanco,
        "select tentativas_falhas, bloqueado_ate from usuarios where login = 'caixa_ocupado'",
      ),
      negados: await consultar(emp.nomeBanco, "select 1 from auditoria where acao = 'login_negado'"),
      historico: await consultar(
        emp.nomeBanco,
        "select login_informado from historico_logins where login_informado in ('caixa_ocupado', 'nao_existe_ocupado')",
      ),
    });
    expect(await estado()).toEqual({
      usuario: [{ tentativas_falhas: 0, bloqueado_ate: null }],
      negados: [],
      historico: [],
    });

    // Com a vaga livre, a senha errada conta (a conferência acima mede de fato) e a certa entra.
    expect((await login('caixa_ocupado', 'SenhaErrada1')).status).toBe(401);
    const depois = await estado();
    expect(depois.usuario).toEqual([{ tentativas_falhas: 1, bloqueado_ate: null }]);
    expect(depois.negados).toHaveLength(1);
    expect((await login('caixa_ocupado', SENHA_TESTE)).status).toBe(200);
  });
});
