import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { criarContexto } from './contexto.js';
import type { PoolsEmpresas } from './pools-empresas.js';
import { REPETICOES_TRANSACAO, Tenancy } from './tenancy.js';

const contexto = criarContexto({
  id: '01a18751-a521-7238-b924-56de3eb13b90',
  codigo: 100001,
  nomeBanco: 'genesis_emp_100001',
  servidorBancoId: '01a18751-a521-7238-b924-56de3eb13b91',
  geracaoBanco: 1,
  razaoSocial: 'Teste',
  nomeFantasia: null,
});

function poolsFalsos() {
  const comandos: string[] = [];
  const pools = {
    conectar: async () => ({
      query: async (sql: string) => {
        comandos.push(sql);
        return { rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as PoolsEmpresas;
  return { pools, comandos };
}

describe('Tenancy.transacao (MD 1.5)', () => {
  it('repete até 3 vezes em deadlock/serialização (4 tentativas no total) e então desiste', async () => {
    const { pools } = poolsFalsos();
    const t = new Tenancy(pools);
    let tentativas = 0;
    const r = t.executarNaEmpresa(contexto, () =>
      t.cx().transacao(async () => {
        tentativas++;
        throw Object.assign(new Error('deadlock'), { code: '40P01' });
      }),
    );
    await expect(r).rejects.toThrow('deadlock');
    expect(tentativas).toBe(1 + REPETICOES_TRANSACAO);
  });

  it('sucesso na repetição confirma; outros erros não são repetidos', async () => {
    const { pools, comandos } = poolsFalsos();
    const t = new Tenancy(pools);
    let n = 0;
    const ok = await t.executarNaEmpresa(contexto, () =>
      t.cx().transacao(async () => {
        if (++n < 3) throw Object.assign(new Error('serialização'), { code: '40001' });
        return 'ok';
      }),
    );
    expect(ok).toBe('ok');
    expect(comandos.filter((c) => c === 'commit')).toHaveLength(1);
    let m = 0;
    const outro = t.executarNaEmpresa(contexto, () =>
      t.cx().transacao(async () => {
        m++;
        throw Object.assign(new Error('violação'), { code: '23505' });
      }),
    );
    await expect(outro).rejects.toThrow('violação');
    expect(m).toBe(1);
  });

  it('repete também o deadlock de consulta do Drizzle (SQLSTATE só em DrizzleQueryError.cause)', async () => {
    const { pools, comandos } = poolsFalsos();
    const t = new Tenancy(pools);
    let n = 0;
    const ok = await t.executarNaEmpresa(contexto, () =>
      t.cx().transacao(async () => {
        if (++n < 2) {
          throw new DrizzleQueryError(
            'update x',
            [],
            Object.assign(new Error('deadlock'), { code: '40P01' }),
          );
        }
        return 'ok';
      }),
    );
    expect(ok).toBe('ok');
    expect(n).toBe(2);
    expect(comandos.filter((c) => c === 'commit')).toHaveLength(1);
  });

  it('limita só a espera pela 7300001 (ERP, C13) e as tarefas esperam sem limite', async () => {
    const { pools, comandos } = poolsFalsos();
    const t = new Tenancy(pools, { esperaTravaVersaoMs: 5000 });
    await t.executarNaEmpresa(contexto, () => t.cx().transacao(async () => 1, { travaVersao: true }));
    expect(comandos).toEqual([
      'begin',
      'set local lock_timeout = 5000',
      'select fn_trava_versao()',
      'set local lock_timeout to default',
      'commit',
    ]);
    comandos.length = 0;
    await t.executarNaEmpresa(contexto, () =>
      t.cx().transacao(async () => 1, { travaVersao: true, esperaSemLimite: true }),
    );
    expect(comandos).toEqual(['begin', 'select fn_trava_versao()', 'commit']);
    comandos.length = 0;
    await t.executarNaEmpresa(contexto, () => t.cx().transacao(async () => 1));
    expect(comandos).toEqual(['begin', 'commit']);
  });

  it('a trava ocupada (55P03) não é repetida: vira SISTEMA_OCUPADO no filtro de erros', async () => {
    const { pools } = poolsFalsos();
    const t = new Tenancy(pools, { esperaTravaVersaoMs: 10 });
    let n = 0;
    const r = t.executarNaEmpresa(contexto, () =>
      t.cx().transacao(async () => {
        n++;
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      }),
    );
    await expect(r).rejects.toMatchObject({ code: '55P03' });
    expect(n).toBe(1);
  });
});
