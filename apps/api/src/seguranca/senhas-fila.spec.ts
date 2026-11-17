import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `verificarSenha` com a fila do argon2 esgotada (decisão 204): o `SISTEMA_OCUPADO` sobe como erro (o login responde
 * 503 sem contar tentativa nem bloquear a conta), com ou sem hash; só o hash inválido é `false`. Arquivo à parte
 * porque as filas do módulo leem o ambiente ao carregar: aqui, uma vaga só e 1 s de espera máxima, e o argon2 é
 * substituído por um que segura o hash enquanto o teste quiser.
 */
const controle = vi.hoisted(() => {
  process.env.ARGON2_CONCORRENCIA = '1';
  process.env.ARGON2_ESPERA_MAXIMA_S = '1';
  return { segurar: null as Promise<void> | null, hashes: 0 };
});

vi.mock('argon2', () => ({
  default: {
    argon2id: 2,
    hash: async (senha: string) => {
      controle.hashes++;
      if (controle.segurar) await controle.segurar;
      return `hash:${senha}`;
    },
    verify: async (hash: string, senha: string) => {
      if (!hash.startsWith('hash:')) throw new Error('hash inválido');
      return hash === `hash:${senha}`;
    },
  },
}));

const { gerarHashSenha, verificarSenha } = await import('./senhas.js');

/** Ocupa a única vaga do argon2 com um hash de gestão (já calculando) até `soltar()`. */
async function ocuparVaga() {
  let soltar!: () => void;
  controle.segurar = new Promise<void>((r) => (soltar = r));
  const antes = controle.hashes;
  const feito = gerarHashSenha('ocupando');
  // A vaga da gestão é pega na hora, mas a geral só alguns ticks depois: espera o hash começar.
  while (controle.hashes === antes) await new Promise((r) => setImmediate(r));
  return {
    feito,
    soltar: () => {
      controle.segurar = null;
      soltar();
    },
  };
}

afterEach(() => {
  controle.segurar = null;
});

describe('verificarSenha com a fila do argon2 esgotada (decisão 204)', () => {
  it('com e sem hash rejeita com SISTEMA_OCUPADO (503), em vez de devolver false', async () => {
    const vaga = await ocuparVaga();
    try {
      const [comHash, semHash] = await Promise.allSettled([
        verificarSenha('hash:Segredo123', 'Segredo123'),
        verificarSenha(null, 'Segredo123'),
      ]);
      for (const r of [comHash, semHash]) {
        expect(r.status).toBe('rejected');
        expect((r as PromiseRejectedResult).reason).toMatchObject({ codigo: 'SISTEMA_OCUPADO', status: 503 });
      }
    } finally {
      vaga.soltar();
      await vaga.feito;
    }
  });

  it('depois da rejeição do hash fictício, a chamada seguinte calcula de novo e funciona', async () => {
    const vaga = await ocuparVaga();
    try {
      await expect(verificarSenha(undefined, 'x')).rejects.toMatchObject({ codigo: 'SISTEMA_OCUPADO' });
    } finally {
      vaga.soltar();
      await vaga.feito;
    }
    const antes = controle.hashes;
    // O fictício rejeitado não ficou guardado: calcula agora (1 hash) e a conferência sem usuário é `false`.
    expect(await verificarSenha(undefined, 'x')).toBe(false);
    expect(controle.hashes).toBe(antes + 1);
    // E fica guardado depois de dar certo.
    expect(await verificarSenha(null, 'y')).toBe(false);
    expect(controle.hashes).toBe(antes + 1);
  });

  it('com a fila livre: hash inválido é false, a senha certa true e a errada false', async () => {
    expect(await verificarSenha('lixo', 'x')).toBe(false);
    expect(await verificarSenha('hash:Segredo123', 'Segredo123')).toBe(true);
    expect(await verificarSenha('hash:Segredo123', 'outra')).toBe(false);
  });
});
