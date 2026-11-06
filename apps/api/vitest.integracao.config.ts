import { defineConfig } from 'vitest/config';

/**
 * Testes de integração contra o PostgreSQL local (DATABASE_URL). Cada arquivo cria e remove os próprios bancos
 * (controle + empresas com nomes únicos). No máximo 2 arquivos em paralelo: a máquina de CI/desenvolvimento é pequena.
 */
export default defineConfig({
  test: {
    include: ['test/integracao/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
