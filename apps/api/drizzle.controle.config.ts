import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/controle/schema.ts',
  out: './drizzle/controle',
  strict: true,
});
