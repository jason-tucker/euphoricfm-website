// Scan window and pacing (plan §3.7 + the P0d-A measurements).
//
// CheckMediaTask runs at minutes 1-59/5 (:01, :06, …, "x1") and deletes any
// media row whose file was not in its listing, so an upload or move that
// straddles the listing→row-walk span loses the row. P0d-A: storages 2 and 14
// finish by p95 1.23 s, whole task by 1.74 s; scan_end_offset_s = 10. There
// is no observable scan-in-progress signal, so this is CLOCK ONLY (the
// accepted residual); the post-scan re-verify and recovery absorb a miss.
//
// A mutation may START only when  now ≥ :x1 + offset + 20 s  and
// now + 30 s < :x6.  With offset 10 that is [:x1:30, :x5:30).

import { sql } from 'drizzle-orm'
import type { DB } from '../../server/db/client'
import { getSetting } from '../../server/settings'
import { DEFAULT_CAPS, type Caps } from '../../server/settings-defaults'

export const SCAN_PERIOD_MS = 300_000
export const SCAN_PHASE_MS = 60_000 // :x1:00
export const START_MARGIN_S = 20
export const END_MARGIN_S = 30
// Plan §3.7: if offset + 20 s exceeds 150 s, stop and ask Jason.
export const MAX_START_S = 150

export class WindowConfigError extends Error {
  constructor(readonly offsetS: number) {
    super(`scan_end_offset_s=${offsetS}: offset + ${START_MARGIN_S} s exceeds ${MAX_START_S} s (stop and ask Jason)`)
    this.name = 'WindowConfigError'
  }
}

function lastScanStart(nowMs: number): number {
  return Math.floor((nowMs - SCAN_PHASE_MS) / SCAN_PERIOD_MS) * SCAN_PERIOD_MS + SCAN_PHASE_MS
}

export function assertOffset(offsetS: number): number {
  if (!Number.isFinite(offsetS) || offsetS < 0 || offsetS + START_MARGIN_S > MAX_START_S) throw new WindowConfigError(offsetS)
  return offsetS
}

// { open, waitMs }: waitMs is 0 when open, else the time until it opens.
export function scanWindow(nowMs: number, offsetS: number): { open: boolean; waitMs: number } {
  assertOffset(offsetS)
  const since = nowMs - lastScanStart(nowMs)
  const start = (offsetS + START_MARGIN_S) * 1000
  const end = SCAN_PERIOD_MS - END_MARGIN_S * 1000
  if (since >= start && since < end) return { open: true, waitMs: 0 }
  return { open: false, waitMs: since < start ? start - since : SCAN_PERIOD_MS - since + start }
}

// The moment by which `scans` further CheckMediaTask runs (strictly after
// `nowMs`) have started and finished, plus the start margin.
export function afterScans(nowMs: number, scans: number, offsetS: number): number {
  assertOffset(offsetS)
  return lastScanStart(nowMs) + scans * SCAN_PERIOD_MS + (offsetS + START_MARGIN_S) * 1000
}

export async function scanOffsetS(db: DB): Promise<number> {
  const v = Number(await getSetting(db, 'scan_end_offset_s'))
  return Number.isFinite(v) ? v : 10
}

export async function getCaps(db: DB): Promise<Caps> {
  const v = await getSetting(db, 'caps')
  const out: Record<string, number> = { ...DEFAULT_CAPS }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k in DEFAULT_CAPS && typeof x === 'number' && Number.isFinite(x) && x > 0) out[k] = x
    }
  }
  return out as Caps
}

// Serial pacing: ≥ ingestSpacingS since the previous upload and at most
// ingestPerHour uploads in any trailing hour. Returns 0 (go) or ms to wait.
// Only uploads in (now − 1 h, now] count, so a row stamped by a test clock
// in the future never blocks a real run.
export function pacingWaitMs(uploadsInLastHour: readonly number[], nowMs: number, caps: { ingestSpacingS: number; ingestPerHour: number }): number {
  const sorted = [...uploadsInLastHour].filter((t) => t <= nowMs && t > nowMs - 3600_000).sort((a, b) => a - b)
  let wait = 0
  const last = sorted.at(-1)
  if (last !== undefined && nowMs - last < caps.ingestSpacingS * 1000) wait = last + caps.ingestSpacingS * 1000 - nowMs
  if (sorted.length >= caps.ingestPerHour) {
    const oldestCounted = sorted[sorted.length - caps.ingestPerHour]!
    wait = Math.max(wait, oldestCounted + 3600_000 - nowMs)
  }
  return Math.max(0, wait)
}

export async function pacingWait(db: DB, nowMs: number, caps: Caps): Promise<number> {
  // Raw sql params go to postgres-js untyped: pass ISO strings and cast.
  const now = new Date(nowMs).toISOString()
  const hourAgo = new Date(nowMs - 3600_000).toISOString()
  const rows = await db.execute<{ t: Date | string }>(
    sql`SELECT uploaded_at AS t FROM ingest_runs WHERE uploaded_at > ${hourAgo}::timestamptz AND uploaded_at <= ${now}::timestamptz`,
  )
  const times = (rows as unknown as { t: Date | string }[]).map((r) => new Date(r.t).getTime())
  return pacingWaitMs(times, nowMs, caps)
}
