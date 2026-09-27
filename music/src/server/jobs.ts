// Job queue helpers shared by web (enqueue) and worker (claim / finish).

import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { jobs } from './db/schema'

type Writer = Pick<PgDatabase<PgQueryResultHKT, Record<string, never>>, 'insert'>

export const JOB_KINDS = [
  'ticket_open',
  'ticket_comment',
  'ticket_decision',
  'contract_probe',
  // P3 (src/worker/ingest, src/worker/library, src/worker/scheduler)
  'ingest',
  'ingest_verify',
  'library_sync',
  'ticket_item_event',
  'batch_summary',
  'ticket_autoclose',
] as const
export type JobKind = (typeof JOB_KINDS)[number]

export async function enqueue(db: Writer, kind: JobKind, payload: Record<string, unknown>, opts: { dedupeKey?: string; runAfter?: Date } = {}) {
  await db
    .insert(jobs)
    .values({ kind, payload, dedupeKey: opts.dedupeKey ?? null, runAfter: opts.runAfter ?? sql`now()` })
    .onConflictDoNothing()
}
