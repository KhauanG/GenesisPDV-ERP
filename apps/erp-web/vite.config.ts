import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const api = env.VITE_API_PROXY ?? 'http://localhost:3000';
  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORTA ?? 5173),
      strictPort: true,
      // Mesmo domínio no navegador: o cookie de refresh (SameSite=Strict, caminho /api/auth) funciona sem CORS.
      proxy: {
        '/api': { target: api, changeOrigin: false },
        '/saude': { target: api, changeOrigin: false },
      },
    },
    preview: {
      port: Number(env.VITE_PORTA_PREVIEW ?? 4173),
      strictPort: true,
      proxy: { '/api': { target: api }, '/saude': { target: api } },
    },
    build: {
      rolldownOptions: {
        output: {
          // Bibliotecas mudam pouco: ficam em arquivos próprios e o navegador as mantém em cache entre versões.
          codeSplitting: {
            groups: [
              {
                name: 'react',
                test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
                priority: 3,
              },
              { name: 'mantine', test: /node_modules[\\/]@mantine[\\/]/, priority: 2 },
              { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
            ],
          },
        },
      },
    },
    define: {
      __VERSAO_ERP__: JSON.stringify(
        (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string })
          .version,
      ),
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/teste/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      exclude: [...configDefaults.exclude],
      css: false,
    },
  };
});
