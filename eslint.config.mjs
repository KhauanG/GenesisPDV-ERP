import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'apps/pdv/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // ContextoEmpresa é a única porta para os bancos das empresas (visao-geral.md 4.3.1).
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/servicos.ts',
      'apps/api/src/tenancy/**',
      'apps/api/src/database/**',
      'apps/api/src/plataforma/**',
      'apps/api/src/cli/**',
      'apps/api/src/**/*.spec.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Use contexto.cx() do módulo tenancy; não abra conexões fora dele.' },
          ],
          patterns: [
            {
              group: ['**/tenancy/pools-empresas*'],
              message: 'O pool de empresas só é usado dentro do tenancy.',
            },
          ],
        },
      ],
    },
  },
  {
    // ERP web (navegador): regras de hooks do React (inclui as do React Compiler).
    files: ['apps/erp-web/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Página de download do PDV (apps/erp-web/nginx/download): script clássico do navegador, servido sem build.
    files: ['apps/erp-web/nginx/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  prettier,
);
