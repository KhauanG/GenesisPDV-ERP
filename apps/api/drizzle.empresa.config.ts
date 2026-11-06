import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/empresa/schema/*.ts',
  out: './drizzle/empresa',
  strict: true,
});
