import { main } from './main'

main().catch((err) => {
  console.error('[probe] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
