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
  // P4 (src/worker/requests): request tickets, edits, moves, archive/restore,
  // manager playlist merges and the post-scan re-verify / recovery.
  'request_ticket_open',
  'request_ticket_post',
  'apply_edit',
  'apply_art',
  'move',
  'archive',
  'restore',
  'set_playlists',
  'reverify',
] as const
export type JobKind = (typeof JOB_KINDS)[number]

export async function enqueue(db: Writer, kind: JobKind, payload: Record<string, unknown>, opts: { dedupeKey?: string; runAfter?: Date } = {}) {
  await db
    .insert(jobs)
    .values({ kind, payload, dedupeKey: opts.dedupeKey ?? null, runAfter: opts.runAfter ?? sql`now()` })
    .onConflictDoNothing()
}
