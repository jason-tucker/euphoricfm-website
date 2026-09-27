// Scan-window and on-air gates for moves, archives and restores (plan §3.7,
// P0d-A: CheckMediaTask starts at :x1/:x6, storages 2+14 done by p95 1.23 s,
// scan_end_offset_s = 10). A mutation may START only when
//     now >= :x1 + offset + 20 s   and   now + 30 s < :x6
// There is no observable scan-in-progress signal, so this is clock-only (the
// accepted residual); the post-scan re-verify absorbs a miss.
//
// NOTE(dedupe): P3 owns the ingest scheduler and may ship its own window
// helper; this one is local to P4 until they are merged into one.

import type { AzuraCastClient, StationMedia } from '../../server/azuracast/client'
import type { DB } from '../../server/db/client'
import { getSetting } from '../../server/settings'
import { Permanent, RetryLater } from '../handlers'

export const SCAN_PERIOD_S = 300
export const SCAN_PHASE_S = 60 // scans start at minute ≡ 1 (mod 5)
export const START_MARGIN_S = 20
export const END_MARGIN_S = 30
export const MAX_START_S = 150 // plan: offset + 20 s over 150 s → stop and ask Jason

// A job that must wait (outside the window, or the song is on air). The
// runner requeues it without spending an attempt.
export class Deferred extends RetryLater {
  constructor(delayS: number, readonly reason: string) {
    super(Math.max(1, Math.ceil(delayS)), `deferred: ${reason}`)
    this.name = 'Deferred'
  }
}

// Seconds since the most recent scan start.
export function scanPhase(nowMs: number): number {
  const s = Math.floor(nowMs / 1000)
  return (((s - SCAN_PHASE_S) % SCAN_PERIOD_S) + SCAN_PERIOD_S) % SCAN_PERIOD_S
}

export function inMutationWindow(nowMs: number, offsetS: number): boolean {
  const ph = scanPhase(nowMs)
  return ph >= offsetS + START_MARGIN_S && ph + END_MARGIN_S < SCAN_PERIOD_S
}

// Delay (s) until the window next opens (0 when open now).
export function secondsUntilWindow(nowMs: number, offsetS: number): number {
  if (inMutationWindow(nowMs, offsetS)) return 0
  const ph = scanPhase(nowMs)
  const open = offsetS + START_MARGIN_S
  return ph < open ? open - ph : SCAN_PERIOD_S - ph + open
}

// When the n-th scan after now has finished (+ the start margin): the time a
// post-scan re-verify should run.
export function afterScansMs(nowMs: number, n: number, offsetS: number): number {
  const lastStart = Math.floor(nowMs / 1000) - scanPhase(nowMs)
  return (lastStart + SCAN_PERIOD_S * n + offsetS + START_MARGIN_S) * 1000
}

export async function scanOffset(db: DB): Promise<number> {
  const v = await getSetting(db, 'scan_end_offset_s')
  const n = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 10
  if (n + START_MARGIN_S > MAX_START_S) throw new Permanent('scan_offset_over_150s')
  return n
}

export async function assertMutationWindow(db: DB, nowMs: number): Promise<number> {
  const offset = await scanOffset(db)
  const wait = secondsUntilWindow(nowMs, offset)
  if (wait > 0) throw new Deferred(wait, 'outside_scan_window')
  return offset
}

// ------------------------------------------------------------ on air ---

type NpSong = { id?: unknown; text?: unknown; artist?: unknown; title?: unknown }

function songsOf(np: unknown): NpSong[] {
  const o = (np ?? {}) as { now_playing?: { song?: NpSong } | null; playing_next?: { song?: NpSong } | null }
  return [o.now_playing?.song, o.playing_next?.song].filter((s): s is NpSong => !!s && typeof s === 'object')
}

const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

// NowPlaying carries song ids (hash of artist+title), not media ids, so a
// file is on air when its song_id or its "artist - title" text matches the
// current or the next song.
export function isOnAir(np: unknown, media: StationMedia): boolean {
  const raw = (media as Record<string, unknown>).song_id
  const songId = typeof raw === 'string' ? raw : null
  const text = norm(`${media.artist ?? ''} - ${media.title ?? ''}`)
  return songsOf(np).some((s) => {
    if (songId && s.id === songId) return true
    const t = typeof s.text === 'string' ? s.text : typeof s.artist === 'string' && typeof s.title === 'string' ? `${s.artist} - ${s.title}` : null
    return t !== null && norm(t) === text
  })
}

export async function assertNotOnAir(db: DB, az: AzuraCastClient, media: StationMedia): Promise<void> {
  const sc = await getSetting(db, 'nowplaying_shortcode')
  const shortcode = typeof sc === 'string' && /^[a-z0-9_]{1,64}$/.test(sc) ? sc : 'euphoricfm'
  let np: unknown
  try {
    np = await az.nowPlaying(shortcode)
  } catch {
    // Unknown is not "safe": wait and look again.
    throw new Deferred(60, 'nowplaying_unavailable')
  }
  if (isOnAir(np, media)) throw new Deferred(60, 'now_playing')
}

// Contract drift (or an operator) pauses the mutating queues via
// settings.queues_paused. Re-checked right before each AzuraCast write, so a
// pause that lands mid-job still stops it.
export async function assertQueuesRunning(db: DB): Promise<void> {
  const v = await getSetting(db, 'queues_paused')
  if (v !== null && v !== undefined && v !== false) throw new Deferred(300, 'queues_paused')
}
