import { defineConfig } from 'drizzle-kit'

// Used only to GENERATE migration SQL (`pnpm db:generate`). Runtime applies
// the committed SQL in ./drizzle via src/migrate/main.ts, never `push`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
})
