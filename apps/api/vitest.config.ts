import { defineConfig } from 'vitest/config';

/** Testes unitários (sem banco). */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
  },
});
