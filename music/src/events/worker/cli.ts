// Bundle entry of /app/events-worker.mjs (scripts/bundle.mjs).
import { main } from './main'

main().catch((err) => {
  // Start-up refusals (env, station, key self-check) land here: exit non-zero
  // so compose restarts are visible and nothing runs half-configured.
  console.error('[events-worker] refusing to start:', err instanceof Error ? `${err.name}: ${err.message}` : err)
  process.exit(1)
})
