// v0.3.6: the one-off import of the pre-portal UNRELEASED folder into the
// portal archive. Shared by the web (the manager's dry run + confirm on the
// admin page), the worker (the plan job) and the operator CLI.
//
//   1. dry run: the web stores a plan request in settings.legacy_import_plan
//      ({id, status 'queued'}) and queues legacy_import_plan; the worker
//      lists the folder READ-ONLY and stores the plan (status 'ready'): every
//      planned move (source → Removed/<id>/<name>), the station playlists
//      each file loses, the files refused (Events) or skipped;
//   2. confirm: only a 'ready' plan of the same id, at most PLAN_MAX_AGE_MS
//      old, never twice, and never while an import job is still queued or
//      running. One import_legacy_archive job per planned file, bound to its
//      planned path, staggered one scan window (300 s) apart; the job itself
//      keeps one file per window slot.
//
// The web holds no AzuraCast key: it never lists or writes the folder.

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit'
import type { DB } from '../db/client'
import { settings } from '../db/schema'
import { enqueue } from '../jobs'

export const PLAN_KEY = 'legacy_import_plan'
export const PLAN_MAX_AGE_MS = 60 * 60_000
export const SLOT_MS = 300_000

export type LegacyPlanAction = 'archive' | 'refuse_events' | 'skip_archived' | 'skip_queued'

export type LegacyPlanFile = {
  mediaId: number
  path: string
  dest: string
  artist: string | null
  title: string | null
  lengthS: number | null
  // Station-1 memberships the archive clears (the song leaves rotation).
  playlistIds: number[]
  // Memberships outside the station set (Events, station 14): refused.
  foreignPlaylistIds: number[]
  action: LegacyPlanAction
  note?: string
}

export type LegacyPlanOther = { path: string; type: string; reason: 'not_scanned' | 'not_a_media_row' | 'unsupported_path' }

export type LegacyPlan = {
  root: string
  folder: string
  files: LegacyPlanFile[]
  others: LegacyPlanOther[]
  playlistNames: Record<string, string>
  summary: { archive: number; offAir: number; refused: number; skipped: number; others: number }
}

export type PlanState =
  | { id: string; status: 'queued'; requestedAt: string; requestedBy: string | null }
  | { id: string; status: 'ready'; requestedAt: string; requestedBy: string | null; readyAt: string; plan: LegacyPlan }
  | { id: string; status: 'failed'; requestedAt: string; requestedBy: string | null; failedAt: string; error: string }
  | { id: string; status: 'confirmed'; requestedAt: string; requestedBy: string | null; readyAt: string; plan: LegacyPlan; confirmedAt: string; confirmedBy: string | null; queued: number }

const planStateSchema = z
  .object({ id: z.string().uuid(), status: z.enum(['queued', 'ready', 'failed', 'confirmed']) })
  .passthrough()

export async function loadPlanState(db: DB): Promise<PlanState | null> {
  const row = await db.query.settings.findFirst({ where: sql`${settings.key} = ${PLAN_KEY}` })
  const r = planStateSchema.safeParse(row?.value)
  return r.success ? (r.data as unknown as PlanState) : null
}

export const summarize = (files: readonly LegacyPlanFile[], others: readonly LegacyPlanOther[]): LegacyPlan['summary'] => ({
  archive: files.filter((f) => f.action === 'archive').length,
  offAir: files.filter((f) => f.action === 'archive' && f.playlistIds.length > 0).length,
  refused: files.filter((f) => f.action === 'refuse_events').length,
  skipped: files.filter((f) => f.action === 'skip_archived' || f.action === 'skip_queued').length,
  others: others.length,
})

// Files a confirmed plan queues: every file still to import. A file planned
// as refused (Events) is queued too: its job checks again and refuses with
// an alert, writing nothing (the owner's rule: every file goes, except
// where the Events refusal holds at run time).
export const toQueue = (plan: LegacyPlan) => plan.files.filter((f) => f.action === 'archive' || f.action === 'refuse_events')

export async function importJobsLive(db: Pick<DB, 'execute'>): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM jobs WHERE kind = 'import_legacy_archive' AND status IN ('queued', 'running')`)
  return Number((rows as unknown as { n: number }[])[0]?.n ?? 0)
}

type Actor = { actorUserId: string | null; actorDiscordId: string | null }

// One job per file, bound to its planned path; staggered one window apart
// (the job re-checks the window and claims its slot itself). Run inside the
// caller's transaction, together with the plan's claim.
export async function enqueueImportJobs(
  tx: Parameters<typeof enqueue>[0],
  planId: string,
  files: readonly LegacyPlanFile[],
  actor: Actor,
  nowMs: number,
  via: 'web' | 'cli',
): Promise<number> {
  let i = 0
  for (const f of files) {
    await enqueue(
      tx,
      'import_legacy_archive',
      { mediaId: f.mediaId, path: f.path, planId, ...actor },
      { dedupeKey: `import_legacy_archive:${planId}:${f.mediaId}`, runAfter: new Date(nowMs + i * SLOT_MS) },
    )
    i++
  }
  await audit(tx, {
    ...actor,
    action: 'legacy_import.run',
    targetType: 'legacy_import',
    targetId: planId,
    detail: { via, queued: files.length, mediaIds: files.map((f) => f.mediaId) },
  })
  return files.length
}

export const newPlanId = () => randomUUID()
