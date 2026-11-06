import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Teste de ponta a ponta (fora do CI por enquanto): sobe a API com um banco de controle descartável e o Vite, e
 * percorre o fluxo painel → empresa → login no ERP → usuários → suspender/reativar. Precisa do PostgreSQL de
 * `DATABASE_URL` (padrão: servidor local) e do Chromium do Playwright (`pnpm --filter erp-web exec playwright install
 * chromium`).
 */
const PORTA_API = Number(process.env.E2E_PORTA_API ?? 3100);
const PORTA_WEB = Number(process.env.E2E_PORTA_WEB ?? 5174);
const ORIGEM_WEB = `http://localhost:${PORTA_WEB}`;

// O config é avaliado também nos workers: o `??=` mantém os mesmos valores do processo principal.
process.env.E2E_BANCO ??= `genesis_e2e_${Date.now().toString(36)}`;
process.env.E2E_ESTADO ??= join(tmpdir(), `${process.env.E2E_BANCO}.json`);
process.env.E2E_PORTA_API = String(PORTA_API);
process.env.E2E_ORIGEM_WEB = ORIGEM_WEB;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalTeardown: './e2e/limpeza.ts',
  use: {
    baseURL: ORIGEM_WEB,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter api exec tsx ../erp-web/e2e/servidor-api.ts',
      url: `http://127.0.0.1:${PORTA_API}/saude`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Build de produção servido pelo `vite preview`: no `vite dev`, a otimização de dependências na primeira
      // visita de uma tela recarrega a página no meio do teste.
      command: 'pnpm exec vite build --logLevel warn && pnpm exec vite preview',
      url: ORIGEM_WEB,
      timeout: 180_000,
      reuseExistingServer: false,
      env: { VITE_PORTA_PREVIEW: String(PORTA_WEB), VITE_API_PROXY: `http://127.0.0.1:${PORTA_API}` },
    },
  ],
});
