// What every events job handler gets. main.ts builds it once; the unit tests
// build it with an in-memory store, a fake AzuraCast and a fixed clock.

import type { TicketsClient } from '../../server/tickets/client'
import type { EventsAzuraCastClient } from '../azuracast/client'
import type { EventsStore } from './store'

export type EventsCtx = {
  store: EventsStore
  az: EventsAzuraCastClient
  tickets: TicketsClient
  // https://events.euphoric.fm (ticket card links)
  origin: string
  // /spool/probe/in-worker (rw): finalize + cleanup_final requests
  spoolInDir: string
  // /spool/probe/out (ro)
  spoolOutDir: string
  // /staging/final (ro)
  finalDir: string
  now: () => number
  alert: (title: string, detail: Record<string, unknown>) => Promise<void>
  // In-process ingest gate: set when a folder link (or a playlist attached
  // to a fresh upload) was seen; cleared only by a restart after a human
  // looked (the start-up folder-link check runs again).
  ingestBlocked?: string | null
}
