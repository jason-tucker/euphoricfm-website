// Event → AzuraCast plan compiler (plan §4 "AzuraCast compile"). PURE: the
// same input always gives the same plan; no I/O, no clock (the caller passes
// `now`). The worker resolves every track / announcement to a live station
// media id first (resolve.ts) and applies the plan (jobs/build.ts).
//
// What it produces for one event:
//   * main playlist — the event's non-pinned songs, shuffle or sequential,
//     one row per America/New_York date of the event;
//   * one pin playlist per pinned song (`~EVT<id> s<n>`): single_track,
//     loop_once, window [pin, min(pin + 15 min, end)] (no interrupt: songs
//     never cut);
//   * one announcement playlist per distinct audio (`~EVT<id> a<n>`):
//     interrupt + single_track, loop_once, one row per occurrence
//     [t, t + duration + 1 min] ('every' expanded), clamped to the event.
//
// Rows are same-date (start_date = end_date), HHMM wall clock in ET,
// converted per occurrence (DST-safe). A main window crossing midnight is
// split per date; a pin window is truncated at 23:59 (a split would let
// single_track fire once per row); an announcement window may not cross
// midnight at all (an interrupt row cuts its track at the row's end).
// Pins/announcements touching 01:55–02:05 ET (the nightly stack restart)
// or the repeated fall-back hour are refused. Strategy settings choose how
// pins and announcements compete with the main playlist (live test §7.8).

import { annName, pinName } from '../contract/paths'
import { ANNOUNCE_TAIL_S, PIN_WINDOW_MIN } from '../contract/rules'
import { ANNOUNCE_STRATEGIES, PIN_STRATEGIES, type AnnounceStrategy, type PinStrategy } from '../contract/settings'
import { BACKEND_OPTIONS, isMainName, PlaylistBody, type BackendOption, type PlaylistBodyT, type ScheduleItem } from './allowlist'
import { ceilMinute, etParts, floorMinute, isFallBackDate, minutesToHhmm, segmentMinutes, splitByEtDate } from './time'

export const PIN_WINDOW_MS = PIN_WINDOW_MIN * 60_000
export const ANNOUNCE_SLACK_MS = ANNOUNCE_TAIL_S * 1000
// split_main: the main rows leave this gap after each pin, so at the first
// song break inside it only the pin qualifies. Bounded by the pin window.
export const SPLIT_MAIN_GAP_MS = 5 * 60_000
// Nightly AzuraCast stack restart (02:00 ET): windows touching this
// wall-clock band are refused for pins/announcements.
export const RESTART_BAND = { start: 1 * 60 + 55, end: 2 * 60 + 5 }
export const MAX_OCCURRENCES_PER_ANNOUNCEMENT = 2000

export { ANNOUNCE_STRATEGIES, PIN_STRATEGIES, type AnnounceStrategy, type PinStrategy }

export const WEIGHT_DEFAULT = 3
export const WEIGHT_LOW = 1
export const WEIGHT_HIGH = 25

export class CompileError extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'CompileError'
  }
}

export type CompileTrack = { position: number; mediaId: number; pinAt: Date | null }
export type CompileAnnouncement = {
  // the resolved station media id of the audio (stinger or upload)
  mediaId: number
  durationS: number
  mode: 'at' | 'every'
  at: Date | null
  everyMin: number | null
  from: Date | null
  until: Date | null
}
export type CompileInput = {
  event: {
    id: number
    version: number
    startsAt: Date
    endsAt: Date
    // contract paths.mainName(view): sanitized public title or 'Private event'
    mainName: string
    playlistOrder: 'shuffle' | 'sequential'
  }
  tracks: readonly CompileTrack[]
  announcements: readonly CompileAnnouncement[]
  settings: { maxRows: number; pinStrategy: PinStrategy; announceStrategy: AnnounceStrategy }
  now: Date
  // contract paths.pinName / annName (injected so the compiler stays pure
  // and the names stay defined in one place)
  names?: { pin: (eventId: number, n: number) => string; ann: (eventId: number, n: number) => string }
}

export type CompiledPlaylist = {
  key: string // 'main' | 's<n>' | 'a<n>' (stable within an event)
  role: 'main' | 'pin' | 'announce'
  name: string
  body: PlaylistBodyT
  mediaIds: number[] // membership (sequential main: in order)
  sequential: boolean
}

export type CompiledPlan = {
  v: 1
  eventId: number
  version: number
  startsAt: string
  endsAt: string
  pinStrategy: PinStrategy
  announceStrategy: AnnounceStrategy
  playlists: CompiledPlaylist[]
  rowCount: number
  warnings: string[]
  // Set by the worker (not the compiler): contract/build-key.ts of the
  // inputs this plan was compiled from.
  inputKey?: string
}


type Window = { startMs: number; endMs: number }

function assertDate(d: Date | null | undefined, what: string): number {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) throw new CompileError('invalid_time', { what })
  return d.getTime()
}

function minutesOf(ms: number): number {
  const p = etParts(ms)
  return p.hh * 60 + p.mm
}

// Same-date row from a window already known not to cross midnight.
function rowOf(w: Window, loopOnce: boolean): ScheduleItem {
  const segs = splitByEtDate(w.startMs, w.endMs)
  if (segs.length !== 1) throw new CompileError('internal_cross_midnight')
  const seg = segs[0]!
  const { start, end } = segmentMinutes(seg)
  if (!(end > start)) throw new CompileError('row_too_short', { date: seg.date, start: minutesToHhmm(start) })
  return { start_time: minutesToHhmm(start), end_time: minutesToHhmm(end), start_date: seg.date, end_date: seg.date, days: [], loop_once: loopOnce }
}

// Main rows: split per ET date; a sliver shorter than a minute at the edge
// of a date (window starting at 23:59:xx) is dropped rather than sent as a
// start == end row (AzuraCast's "play once" form).
function splitRows(w: Window, loopOnce: boolean): ScheduleItem[] {
  const out: ScheduleItem[] = []
  for (const seg of splitByEtDate(w.startMs, w.endMs)) {
    const { start, end } = segmentMinutes(seg)
    if (!(end > start)) continue
    out.push({ start_time: minutesToHhmm(start), end_time: minutesToHhmm(end), start_date: seg.date, end_date: seg.date, days: [], loop_once: loopOnce })
  }
  return out
}

function overlapsRestartBand(w: Window): boolean {
  for (const seg of splitByEtDate(w.startMs, w.endMs)) {
    const { start, end } = segmentMinutes(seg)
    // [start, end] against [01:55, 02:05)
    if (start < RESTART_BAND.end && end > RESTART_BAND.start) return true
    if (start === end && start >= RESTART_BAND.start && start < RESTART_BAND.end) return true
  }
  return false
}

// The repeated wall-clock hour of the fall-back day: a row there matches
// twice (once per pass), so pins/announcements may not touch it.
function touchesFallBackHour(w: Window): boolean {
  for (const seg of splitByEtDate(w.startMs, w.endMs)) {
    if (!isFallBackDate(seg.date)) continue
    const { start, end } = segmentMinutes(seg)
    if (start < 2 * 60 && end >= 1 * 60) return true
  }
  return false
}

// True when the instant's wall time is inside the repeated hour.
function inFallBackHour(ms: number): boolean {
  const p = etParts(ms)
  const date = `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
  return isFallBackDate(date) && p.hh === 1
}

function crossesMidnight(w: Window): boolean {
  return splitByEtDate(w.startMs, w.endMs).length > 1
}

function truncateAtMidnight(w: Window): Window {
  const segs = splitByEtDate(w.startMs, w.endMs)
  return { startMs: w.startMs, endMs: segs[0]!.endMs }
}

// Removes the [cut.start, cut.end) intervals from `w`.
function subtract(w: Window, cuts: readonly Window[]): Window[] {
  let parts: Window[] = [w]
  for (const c of cuts) {
    const next: Window[] = []
    for (const p of parts) {
      if (c.endMs <= p.startMs || c.startMs >= p.endMs) {
        next.push(p)
        continue
      }
      if (c.startMs > p.startMs) next.push({ startMs: p.startMs, endMs: c.startMs })
      if (c.endMs < p.endMs) next.push({ startMs: c.endMs, endMs: p.endMs })
    }
    parts = next
  }
  return parts.filter((p) => p.endMs > p.startMs)
}

function body(name: string, opts: { order: 'shuffle' | 'sequential'; weight: number; backend: BackendOption[]; avoidDuplicates: boolean; rows: ScheduleItem[] }): PlaylistBodyT {
  const b: PlaylistBodyT = {
    name,
    type: 'default',
    source: 'songs',
    order: opts.order,
    is_enabled: true,
    is_jingle: false,
    weight: opts.weight,
    include_in_requests: false,
    include_in_on_demand: false,
    avoid_duplicates: opts.avoidDuplicates,
    backend_options: [...opts.backend].sort((a, b) => BACKEND_OPTIONS.indexOf(a) - BACKEND_OPTIONS.indexOf(b)),
    schedule_items: opts.rows,
  }
  // The compiler never emits a body the wrapper would refuse.
  const r = PlaylistBody.safeParse(b)
  if (!r.success) throw new CompileError('invalid_body', { name, issues: r.error.issues.slice(0, 5).map((i) => i.message) })
  return b
}

export function compile(input: CompileInput): CompiledPlan {
  const { event, settings } = input
  const names = input.names ?? { pin: pinName, ann: annName }
  if (!Number.isSafeInteger(event.id) || event.id <= 0) throw new CompileError('invalid_event', { what: 'id' })
  if (!(PIN_STRATEGIES as readonly string[]).includes(settings.pinStrategy)) throw new CompileError('invalid_setting', { key: 'events_pin_strategy' })
  if (!(ANNOUNCE_STRATEGIES as readonly string[]).includes(settings.announceStrategy)) throw new CompileError('invalid_setting', { key: 'events_announce_strategy' })
  if (!Number.isSafeInteger(settings.maxRows) || settings.maxRows < 1) throw new CompileError('invalid_setting', { key: 'events_max_rows' })
  const start = floorMinute(assertDate(event.startsAt, 'startsAt'))
  const end = ceilMinute(assertDate(event.endsAt, 'endsAt'))
  if (!(end > start)) throw new CompileError('invalid_event', { what: 'window' })
  if (end <= input.now.getTime()) throw new CompileError('event_ended')
  if (!isMainName(event.mainName)) throw new CompileError('invalid_main_name')
  if (inFallBackHour(start) || inFallBackHour(end)) throw new CompileError('dst_ambiguous', { what: 'event boundary in the repeated fall-back hour' })
  const warnings: string[] = []
  if (crossesMidnight({ startMs: start, endMs: end })) warnings.push('crosses_midnight')
  if (overlapsRestartBand({ startMs: start, endMs: end })) warnings.push('overlaps_nightly_restart')

  // ---------------------------------------------------------- tracks ----
  const tracks = [...input.tracks].sort((a, b) => a.position - b.position)
  const seen = new Set<number>()
  for (const t of tracks) {
    if (!Number.isSafeInteger(t.mediaId) || t.mediaId <= 0) throw new CompileError('invalid_media_id', { position: t.position })
    if (seen.has(t.mediaId)) throw new CompileError('duplicate_song', { mediaId: t.mediaId })
    seen.add(t.mediaId)
  }
  const pinned = tracks.filter((t) => t.pinAt !== null)
  const mainTracks = tracks.filter((t) => t.pinAt === null)
  if (mainTracks.length === 0) throw new CompileError('no_main_songs')

  const pinWeight = settings.pinStrategy === 'overlap_weight' ? WEIGHT_HIGH : WEIGHT_DEFAULT
  const mainWeight = settings.pinStrategy === 'overlap_weight' ? WEIGHT_LOW : WEIGHT_DEFAULT
  const pinPlaylists: CompiledPlaylist[] = []
  const pinWindows: Window[] = []
  pinned
    .map((t) => ({ t, at: floorMinute(assertDate(t.pinAt, 'pinAt')) }))
    .sort((a, b) => a.at - b.at || a.t.position - b.t.position)
    .forEach(({ t, at }, i) => {
      const n = i + 1
      if (at < start || at >= end) throw new CompileError('pin_outside_event', { position: t.position })
      if (at > end - PIN_WINDOW_MS) throw new CompileError('pin_too_late', { position: t.position })
      let w: Window = { startMs: at, endMs: Math.min(at + PIN_WINDOW_MS, end) }
      if (crossesMidnight(w)) w = truncateAtMidnight(w)
      if (overlapsRestartBand(w)) throw new CompileError('pin_in_restart_window', { position: t.position })
      if (touchesFallBackHour(w)) throw new CompileError('dst_ambiguous', { position: t.position })
      const row = rowOf(w, true)
      pinWindows.push(w)
      pinPlaylists.push({
        key: `s${n}`,
        role: 'pin',
        name: names.pin(event.id, n),
        body: body(names.pin(event.id, n), { order: 'sequential', weight: pinWeight, backend: ['single_track'], avoidDuplicates: false, rows: [row] }),
        mediaIds: [t.mediaId],
        sequential: false,
      })
    })

  // ---------------------------------------------------- announcements ----
  const annWeight = settings.announceStrategy === 'interrupt_weight' ? WEIGHT_HIGH : WEIGHT_DEFAULT
  const byMedia = new Map<number, { rows: ScheduleItem[]; windows: Window[] }>()
  const allAnnWindows: Window[] = []
  input.announcements.forEach((a, idx) => {
    if (!Number.isSafeInteger(a.mediaId) || a.mediaId <= 0) throw new CompileError('invalid_media_id', { announcement: idx })
    if (!Number.isFinite(a.durationS) || a.durationS <= 0 || a.durationS > 24 * 3600) throw new CompileError('invalid_duration', { announcement: idx })
    const occurrences: number[] = []
    if (a.mode === 'at') {
      occurrences.push(floorMinute(assertDate(a.at, 'at')))
    } else if (a.mode === 'every') {
      if (![15, 20, 30, 60].includes(a.everyMin ?? -1)) throw new CompileError('bad_every', { announcement: idx })
      const from = a.from ? floorMinute(assertDate(a.from, 'from')) : start
      const until = a.until ? ceilMinute(assertDate(a.until, 'until')) : end
      if (!(until > from)) throw new CompileError('bad_every_range', { announcement: idx })
      const step = a.everyMin! * 60_000
      for (let t = from; t < until; t += step) {
        occurrences.push(t)
        if (occurrences.length > MAX_OCCURRENCES_PER_ANNOUNCEMENT) throw new CompileError('row_cap', { announcement: idx })
      }
    } else {
      throw new CompileError('bad_mode', { announcement: idx })
    }
    const slot = byMedia.get(a.mediaId) ?? { rows: [], windows: [] }
    for (const t of occurrences) {
      if (t < start || t >= end) throw new CompileError('announcement_outside_event', { announcement: idx, at: new Date(t).toISOString() })
      // The audio itself must finish inside the event (an interrupt row
      // cuts its track at the row's end); only the +1 min slack is clamped.
      if (t + a.durationS * 1000 > end) throw new CompileError('announcement_past_end', { announcement: idx, at: new Date(t).toISOString() })
      const w: Window = { startMs: t, endMs: Math.min(ceilMinute(t + a.durationS * 1000 + ANNOUNCE_SLACK_MS), end) }
      if (crossesMidnight(w)) throw new CompileError('announcement_crosses_midnight', { announcement: idx, at: new Date(t).toISOString() })
      if (overlapsRestartBand(w)) throw new CompileError('announcement_in_restart_window', { announcement: idx, at: new Date(t).toISOString() })
      if (touchesFallBackHour(w)) throw new CompileError('dst_ambiguous', { announcement: idx, at: new Date(t).toISOString() })
      for (const o of allAnnWindows) {
        if (w.startMs < o.endMs && o.startMs < w.endMs) throw new CompileError('announcement_overlap', { announcement: idx, at: new Date(t).toISOString() })
      }
      allAnnWindows.push(w)
      slot.windows.push(w)
      slot.rows.push(rowOf(w, true))
    }
    byMedia.set(a.mediaId, slot)
  })
  const annPlaylists: CompiledPlaylist[] = []
  let an = 0
  for (const [mediaId, slot] of byMedia) {
    if (slot.rows.length === 0) continue
    an++
    const rows = [...slot.rows].sort((x, y) => (x.start_date + String(x.start_time).padStart(4, '0')).localeCompare(y.start_date + String(y.start_time).padStart(4, '0')))
    annPlaylists.push({
      key: `a${an}`,
      role: 'announce',
      name: names.ann(event.id, an),
      body: body(names.ann(event.id, an), { order: 'sequential', weight: annWeight, backend: ['interrupt', 'single_track'], avoidDuplicates: false, rows }),
      mediaIds: [mediaId],
      sequential: false,
    })
  }

  // ------------------------------------------------------------- main ----
  const mainWindows =
    settings.pinStrategy === 'split_main'
      ? subtract(
          { startMs: start, endMs: end },
          pinWindows.map((w) => ({ startMs: w.startMs, endMs: Math.min(w.endMs, w.startMs + SPLIT_MAIN_GAP_MS) })),
        )
      : [{ startMs: start, endMs: end }]
  const mainRows = mainWindows.flatMap((w) => splitRows(w, false))
  if (mainRows.length === 0) throw new CompileError('no_main_rows')
  const sequential = event.playlistOrder === 'sequential'
  const main: CompiledPlaylist = {
    key: 'main',
    role: 'main',
    name: event.mainName,
    body: body(event.mainName, { order: sequential ? 'sequential' : 'shuffle', weight: mainWeight, backend: [], avoidDuplicates: !sequential, rows: mainRows }),
    mediaIds: mainTracks.map((t) => t.mediaId),
    sequential,
  }

  const playlists = [main, ...pinPlaylists, ...annPlaylists]
  const rowCount = playlists.reduce((n, p) => n + p.body.schedule_items.length, 0)
  if (rowCount > settings.maxRows) throw new CompileError('row_cap', { rows: rowCount, max: settings.maxRows })
  // Belt and braces for verify's invariant: no date-less, no cross-midnight
  // and no start == end rows anywhere.
  for (const p of playlists) {
    for (const r of p.body.schedule_items) {
      if (!r.start_date || r.start_date !== r.end_date || !(r.start_time < r.end_time)) throw new CompileError('internal_bad_row', { name: p.name })
    }
  }
  return {
    v: 1,
    eventId: event.id,
    version: event.version,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    pinStrategy: settings.pinStrategy,
    announceStrategy: settings.announceStrategy,
    playlists,
    rowCount,
    warnings,
  }
}
