// Enqueue an events job (event_jobs), shared by events-web (A) and the
// events worker (C). The payload is validated against the contract before it
// is written. Mirrors server/jobs.ts enqueue() (ON CONFLICT DO NOTHING on
// dedupe_key). Dedupe keys are PERMANENT (a done job keeps its key), so:
// - default: eventJobDedupeKey(kind, payload, opts.dedupeExtra);
// - start_kick / end_kick / recheck / teardown / build_now: pass the event
//   version (or another discriminator) as dedupeExtra, or a rescheduled kick
//   after a rebuild is silently dropped;
// - periodic sweeps: no default key (null) unless dedupeKey/dedupeExtra (a
//   time bucket) is given.

import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { eventJobs } from '../server/db/schema'
import { eventJobDedupeKey, parseEventJobPayload, PERIODIC_EVENT_JOB_KINDS, type EventJobKind, type EventJobPayload } from './contract/jobs'

type Writer = Pick<PgDatabase<PgQueryResultHKT, Record<string, never>>, 'insert'>

export async function enqueueEventJob<K extends EventJobKind>(
  db: Writer,
  kind: K,
  payload: EventJobPayload<K>,
  opts: { dedupeKey?: string | null; dedupeExtra?: string | number; runAfter?: Date } = {},
): Promise<void> {
  const p = parseEventJobPayload(kind, payload)
  const periodic = (PERIODIC_EVENT_JOB_KINDS as readonly string[]).includes(kind)
  const dedupeKey =
    opts.dedupeKey !== undefined ? opts.dedupeKey : periodic && opts.dedupeExtra === undefined ? null : eventJobDedupeKey(kind, p, opts.dedupeExtra)
  await db
    .insert(eventJobs)
    .values({ kind, payload: p as Record<string, unknown>, dedupeKey, runAfter: opts.runAfter ?? sql`now()` })
    .onConflictDoNothing()
}
