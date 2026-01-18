import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  // For local D1, use the wrangler d1 database
  // Migrations are plain SQL files that Wrangler can also apply
});
