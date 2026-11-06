import { runMigrate } from './main'

runMigrate().catch((err) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
