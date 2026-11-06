import { main } from './main'

main().catch((err) => {
  // Start-up refusals (profile guard, self-check, env) land here: exit non-zero
  // so compose restarts are visible and nothing runs half-configured.
  console.error('[worker] refusing to start:', err instanceof Error ? `${err.name}: ${err.message}` : err)
  process.exit(1)
})
