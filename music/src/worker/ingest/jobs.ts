// Job handlers for the P3 job kinds (src/server/jobs.ts JOB_KINDS). main.ts
// dispatches any kind it does not handle itself through this table.

import { z } from 'zod'
import { Permanent } from '../handlers'
import { isFetchCtx, runSoundcloudFetch } from '../soundcloud'
import { syncLibrary } from '../library/sync'
import { batchSummary, ticketAutoclose, ticketItemEvent } from '../scheduler/tickets'
import type { P3Ctx } from './context'
import { runIngest, runIngestVerify } from './pipeline'

const itemPayload = z.object({ itemId: z.number().int().positive() })
const batchPayload = z.object({ batchId: z.number().int().positive() })
const eventPayload = z.object({ itemId: z.number().int().positive(), event: z.enum(['live', 'failed']) })

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const r = schema.safeParse(payload)
  if (!r.success) throw new Permanent('bad job payload')
  return r.data
}

export const P3_JOBS: Record<string, (ctx: P3Ctx, payload: unknown) => Promise<unknown>> = {
  ingest: (ctx, p) => runIngest(ctx, parse(itemPayload, p)),
  ingest_verify: (ctx, p) => runIngestVerify(ctx, parse(itemPayload, p)),
  library_sync: (ctx) => syncLibrary(ctx),
  ticket_item_event: (ctx, p) => ticketItemEvent(ctx, parse(eventPayload, p)),
  batch_summary: (ctx, p) => batchSummary(ctx, parse(batchPayload, p)),
  ticket_autoclose: (ctx, p) => ticketAutoclose(ctx, parse(batchPayload, p)),
  // v0.4.0 (worker/soundcloud.ts)
  soundcloud_fetch: (ctx, p) => {
    if (!isFetchCtx(ctx)) throw new Permanent('soundcloud_fetch needs the fetch spool dirs')
    return runSoundcloudFetch(ctx, parse(itemPayload, p))
  },
}
