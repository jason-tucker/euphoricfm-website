// The mutating-queue pause (plan §3.7 contract probe). `settings.queues_paused`
// is JSON null when the queues run, and an object {reason, at, …} when they
// are paused. While it is set:
//
//   * claimJob() never claims a MUTATING_JOB_KINDS job (worker/main.ts);
//   * the AzuraCast wrapper's write gate refuses every write (POST upload,
//     metadata PUT, batch) immediately before the request leaves the process,
//     whichever handler built it (worker/main.ts wires assertQueuesNotPaused);
//   * mutating handlers can also call assertQueuesNotPaused() themselves
//     right before their first write.
//
// Reasons: 'contract_drift' (spec slices changed), 'contract_unverified' (the
// probe could not fetch or check the spec: fail closed), and any reason a
// later probe sets (e.g. P3's 'contract_behaviour_drift'). Only
// 'contract_unverified' is cleared automatically, by the next successful
// probe; every other reason needs an operator to clear the setting.

import { eq, sql } from 'drizzle-orm'
import { audit } from './audit'
import type { DB } from './db/client'
import { settings } from './db/schema'

// Every job kind that writes to AzuraCast (or may, via recovery). Plain
// strings: later phases add kinds to JOB_KINDS; keep this list in step.
export const MUTATING_JOB_KINDS: readonly string[] = [
  'ingest',
  'ingest_verify',
  'move',
  'archive',
  'restore',
  'apply_edit',
  'apply_art',
  'set_playlists',
  'recovery',
  'reverify',
  'reconcile_archive',
]

export type PauseState = { reason: string; at: string; [k: string]: unknown }

export class QueuesPausedError extends Error {
  constructor(readonly state: PauseState) {
    super(`queues paused: ${state.reason}`)
    this.name = 'QueuesPausedError'
  }
}

export async function getQueuesPaused(db: DB): Promise<PauseState | null> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, 'queues_paused') })
  const v = row?.value as unknown
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && !Array.isArray(v) && typeof (v as { reason?: unknown }).reason === 'string') return v as PauseState
  // Anything else non-null (a hand-edited value) still counts as paused.
  return { reason: 'unknown', at: '', value: v }
}

export async function assertQueuesNotPaused(db: DB): Promise<void> {
  const p = await getQueuesPaused(db)
  if (p) throw new QueuesPausedError(p)
}

export async function pauseQueues(db: DB, reason: string, detail: Record<string, unknown> = {}): Promise<PauseState> {
  const value: PauseState = { ...detail, reason, at: new Date().toISOString() }
  await db
    .insert(settings)
    .values({ key: 'queues_paused', value, updatedBy: 'worker' })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date(), updatedBy: 'worker' } })
  await audit(db, { action: 'queues.paused', detail: value })
  return value
}

// Clears the pause only if it is still the given reason (conditional, so an
// operator's or another probe's newer pause is never clobbered).
export async function resumeQueuesIf(db: DB, reason: string): Promise<boolean> {
  const rows = await db.execute(
    sql`UPDATE settings SET value = 'null'::jsonb, updated_at = now(), updated_by = 'worker'
        WHERE key = 'queues_paused' AND value ->> 'reason' = ${reason} RETURNING key`,
  )
  const n = (rows as unknown as unknown[]).length
  if (n > 0) await audit(db, { action: 'queues.resumed', detail: { reason } })
  return n > 0
}

// SQL predicate for claimJob: true when the queues are paused.
export const PAUSED_SQL = sql`EXISTS (SELECT 1 FROM settings WHERE key = 'queues_paused' AND value <> 'null'::jsonb)`
