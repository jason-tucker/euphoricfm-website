// Events booking rules (plan §3 "Rules", enforced here, not just in the UI).
// Pure functions over plain rows: timing/notice, clashes + gap, freeze,
// playlist validation (ownership, pins, announcements, row estimate) and
// the re-approval diff. Every refusal is an HttpError whose code is one of
// the UI's EV_ERROR_TEXT keys (events/components/ev-api.ts).

import { HttpError } from '../../server/http/errors'
import { ANNOUNCE_TAIL_S, AUDIO_USABLE_STATUSES, PIN_WINDOW_MIN, SLOT_HOLDING_STATUSES, TERMINAL_STATUSES } from '../contract/rules'
import type { EventsSettings } from '../contract/settings'
import type { AudioStatus, EventAnnouncement, EventStatus, EventTrack, MediaLabel, PlaylistOrder, Visibility } from '../contract/types'
import { isLibraryFile } from '../contract/paths'
import { announcementWindow, pinWindow } from '../azuracast/windows'
import { etDatesSpanned, inRepeatedHour, onGrid, overlapsNightlyRestart } from './time'

const MIN = 60_000
const HOUR = 3600_000
const DAY = 86_400_000

export { SLOT_HOLDING_STATUSES, TERMINAL_STATUSES }

export const bad = (code: string, extra?: Record<string, unknown>) => new HttpError(400, code, extra)
export const clash = (code: string, extra?: Record<string, unknown>) => new HttpError(409, code, extra)

/** Who is acting: members are bound by every limit; staff (review) are exempt. */
export type Actor = { userId: string; discordId: string; name: string | null; staff: boolean; manage: boolean }

/** The event columns the rules read (a subset of the `events` row). */
export type EventCore = {
  id: number
  ownerUserId: string
  status: EventStatus
  startsAt: Date
  endsAt: Date
  visibility: Visibility
  playlistOrder: PlaylistOrder
  version: number
}

// ------------------------------------------------------------ timing ----

/**
 * Notice / length / horizon for a proposed window. Members only (staff are
 * exempt except for the sanity checks). Returns the short-notice flag
 * (start inside events_warn_notice_h).
 */
export function checkTiming(w: { startsAt: number; endsAt: number }, actor: Actor, s: EventsSettings, now: number): { shortNotice: boolean } {
  if (!Number.isFinite(w.startsAt) || !Number.isFinite(w.endsAt) || w.endsAt <= w.startsAt) throw bad('bad_range')
  // A boundary inside the repeated fall-back hour cannot be scheduled
  // unambiguously (the compiler refuses it).
  if (inRepeatedHour(w.startsAt) || inRepeatedHour(w.endsAt)) throw bad('nightly_restart')
  const shortNotice = w.startsAt < now + s.events_warn_notice_h * HOUR
  if (actor.staff) {
    if (w.endsAt <= now) throw bad('bad_range')
    return { shortNotice }
  }
  if (w.startsAt < now + s.events_min_notice_h * HOUR) throw bad('too_soon', { minNoticeH: s.events_min_notice_h })
  if (w.endsAt - w.startsAt > s.events_member_max_hours * HOUR) throw bad('too_long', { maxHours: s.events_member_max_hours })
  if (w.startsAt > now + s.events_member_horizon_days * DAY) throw bad('too_far', { horizonDays: s.events_member_horizon_days })
  return { shortNotice }
}

// ------------------------------------------------------------ clashes ---

export type SlotRow = { id: number; startsAt: Date; endsAt: Date; status: EventStatus }

/**
 * No overlap, and events_gap_min between any two slot-holding events.
 * Staff may book adjacent (inside the gap, never overlapping): `adjacent`
 * then lists those neighbours (their kicks coalesce, plan §4).
 */
export function checkClash(w: { id?: number; startsAt: number; endsAt: number }, others: readonly SlotRow[], gapMin: number, actor: Actor): { adjacent: number[] } {
  const gap = gapMin * MIN
  const adjacent: number[] = []
  for (const o of others) {
    if (o.id === w.id || !SLOT_HOLDING_STATUSES.includes(o.status)) continue
    const os = o.startsAt.getTime()
    const oe = o.endsAt.getTime()
    if (w.startsAt < oe && os < w.endsAt) throw clash('overlap')
    if (w.startsAt < oe + gap && os < w.endsAt + gap) {
      if (!actor.staff) throw clash('overlap')
      adjacent.push(o.id)
    }
  }
  return { adjacent }
}

// ------------------------------------------------------------ freeze ----

export const freezeAt = (startsAt: Date, s: EventsSettings) => new Date(startsAt.getTime() - s.events_freeze_min * MIN)

/** Member-editable statuses (before the freeze). */
export const MEMBER_EDITABLE: readonly EventStatus[] = ['draft', 'pending', 'approved', 'built']
/** Staff-editable statuses. */
export const STAFF_EDITABLE: readonly EventStatus[] = ['draft', 'pending', 'approved', 'built', 'live']

export function canEdit(ev: Pick<EventCore, 'ownerUserId' | 'status' | 'startsAt' | 'endsAt'>, actor: Actor | null, s: EventsSettings, now: number): boolean {
  if (!actor) return false
  if (actor.staff) return STAFF_EDITABLE.includes(ev.status) && ev.endsAt.getTime() > now
  if (ev.ownerUserId !== actor.userId) return false
  return MEMBER_EDITABLE.includes(ev.status) && now < freezeAt(ev.startsAt, s).getTime()
}

/** Throws the reason an edit is refused (not_editable / frozen), else returns. */
export function assertEditable(ev: EventCore, actor: Actor, s: EventsSettings, now: number): void {
  if (actor.staff) {
    if (!STAFF_EDITABLE.includes(ev.status) || ev.endsAt.getTime() <= now) throw clash('not_editable')
    return
  }
  if (!MEMBER_EDITABLE.includes(ev.status)) throw clash('not_editable')
  if (now >= freezeAt(ev.startsAt, s).getTime()) throw clash('frozen')
}

// ------------------------------------------------------------ playlist --

export type LibraryInfo = { mediaId: number; path: string; title: string | null; artist: string | null; lengthS: number | null; archived: boolean }
export type StingerInfo = { mediaId: number; title: string; lengthS: number }
export type AudioInfo = {
  id: number
  ownerUserId: string
  kind: 'song' | 'announcement'
  status: AudioStatus
  deletedAt: Date | null
  title: string
  artist: string | null
  durationS: number | null
}

export type Lookup = {
  library: ReadonlyMap<number, LibraryInfo>
  stingers: ReadonlyMap<number, StingerInfo>
  audio: ReadonlyMap<number, AudioInfo>
}

export type PlaylistInput = { tracks: readonly EventTrack[]; announcements: readonly EventAnnouncement[] }

export function trackLabel(t: Pick<EventTrack, 'source' | 'mediaId' | 'audioId'>, lk: Lookup): MediaLabel | undefined {
  if (t.source === 'library') {
    const l = t.mediaId === null ? undefined : lk.library.get(t.mediaId)
    return l ? { title: l.title ?? 'Untitled', artist: l.artist, lengthS: l.lengthS } : undefined
  }
  const a = t.audioId === null ? undefined : lk.audio.get(t.audioId)
  return a ? { title: a.title, artist: a.artist, lengthS: a.durationS } : undefined
}

export function announcementLabel(a: Pick<EventAnnouncement, 'source' | 'mediaId' | 'audioId'>, lk: Lookup): MediaLabel | undefined {
  if (a.source === 'stinger') {
    const s = a.mediaId === null ? undefined : lk.stingers.get(a.mediaId)
    return s ? { title: s.title, artist: null, lengthS: s.lengthS } : undefined
  }
  const u = a.audioId === null ? undefined : lk.audio.get(a.audioId)
  return u ? { title: u.title, artist: u.artist, lengthS: u.durationS } : undefined
}

/** Custom audio usable in `owner`'s event: theirs, ready|live, not deleted. */
function usableAudio(id: number, ownerUserId: string, lk: Lookup): AudioInfo {
  const a = lk.audio.get(id)
  // Someone else's audio answers exactly like a missing id (no probing).
  if (!a || a.ownerUserId !== ownerUserId || a.deletedAt) throw bad('media_not_allowed', { audioId: id })
  if (!AUDIO_USABLE_STATUSES.includes(a.status)) throw bad('audio_not_ready', { audioId: id })
  return a
}

/** Announcement occurrence instants (the compiler's rule: from, from+every, … < until). */
export function occurrences(a: EventAnnouncement): number[] {
  if (a.mode === 'at') return a.at === null ? [] : [Date.parse(a.at)]
  if (a.from === null || a.until === null || a.everyMin === null) return []
  const out: number[] = []
  const until = Date.parse(a.until)
  for (let t = Date.parse(a.from); t < until && out.length <= 2000; t += a.everyMin * MIN) out.push(t)
  return out
}

/**
 * AzuraCast schedule-row estimate (plan §4): main rows split per ET date
 * (+1 per pin under split_main), one row per pin (truncated at midnight),
 * one per announcement occurrence. The compiler's count is authoritative.
 */
export function estimateRows(ev: { startsAt: Date; endsAt: Date }, p: PlaylistInput, s: Pick<EventsSettings, 'events_pin_strategy'>): number {
  const pins = p.tracks.filter((t) => t.pinAt !== null).length
  const main = etDatesSpanned(ev.startsAt.getTime(), ev.endsAt.getTime()) + (s.events_pin_strategy === 'split_main' ? pins : 0)
  const anns = p.announcements.reduce((n, a) => n + occurrences(a).length, 0)
  return main + pins + anns
}

/**
 * Validate a playlist against its event and the resolved ids. Throws the
 * first refusal. `staff` lifts the row cap only. Returns the row estimate.
 *
 * `structuralOnly` (a DRAFT's autosave, 0.5.3): only what makes the rows
 * storable — every id resolvable and allowed for the owner, no duplicate
 * songs, a length for every announcement. The timing rules (pin and
 * announcement windows, the nightly-restart band, the row cap) are deferred
 * to submit, which always runs the full check, so a half-built draft playlist
 * is never lost to a rule the member is still fixing.
 */
export function validatePlaylist(
  ev: { startsAt: Date; endsAt: Date; ownerUserId: string },
  p: PlaylistInput,
  lk: Lookup,
  s: EventsSettings,
  actor: Pick<Actor, 'staff'>,
  opts: { structuralOnly?: boolean } = {},
): { rows: number } {
  const timing = !opts.structuralOnly
  const start = ev.startsAt.getTime()
  const end = ev.endsAt.getTime()

  // Songs: no duplicates, every id resolvable and allowed.
  const seen = new Set<string>()
  for (const t of p.tracks) {
    const key = t.source === 'library' ? `m${t.mediaId}` : `a${t.audioId}`
    if (seen.has(key)) throw bad('duplicate_track', t.source === 'library' ? { mediaId: t.mediaId } : { audioId: t.audioId })
    seen.add(key)
    if (t.source === 'library') {
      const l = t.mediaId === null ? undefined : lk.library.get(t.mediaId)
      if (!l || l.archived || !isLibraryFile(l.path)) throw bad('media_not_allowed', { mediaId: t.mediaId })
    } else {
      usableAudio(t.audioId!, ev.ownerUserId, lk)
    }
    if (timing && t.pinAt !== null) {
      const at = Date.parse(t.pinAt)
      if (!onGrid(at) || at < start || at > end - PIN_WINDOW_MIN * MIN) throw bad('pin_out_of_range', { position: t.position })
      if (overlapsNightlyRestart(at, Math.min(at + PIN_WINDOW_MIN * MIN, end))) throw bad('nightly_restart', { position: t.position })
      // The compiler's own window rules (azuracast/windows.ts): a window
      // truncated at 23:59 under a minute, or touching the repeated
      // fall-back hour (a row ending at 01:00 included).
      const refusal = pinWindow(at, end).refusal
      if (refusal === 'row_too_short') throw bad('pin_out_of_range', { position: t.position })
      if (refusal) throw bad('nightly_restart', { position: t.position })
    }
  }

  // Announcements: resolvable, on the grid, inside the event, finishing
  // before the end, no midnight crossing, no two overlapping, never in the
  // nightly-restart band.
  const windows: [number, number][] = []
  p.announcements.forEach((a, idx) => {
    let lengthS: number | null
    if (a.source === 'stinger') {
      const st = a.mediaId === null ? undefined : lk.stingers.get(a.mediaId)
      if (!st) throw bad('media_not_allowed', { mediaId: a.mediaId })
      lengthS = st.lengthS
    } else {
      lengthS = usableAudio(a.audioId!, ev.ownerUserId, lk).durationS
    }
    if (!lengthS || lengthS <= 0) throw bad('audio_not_ready', { announcement: idx })
    if (!timing) return
    if (a.mode === 'every') {
      const from = Date.parse(a.from!)
      const until = Date.parse(a.until!)
      if (!onGrid(from) || !onGrid(until) || from < start || until > end || until <= from) throw bad('bad_announcement', { announcement: idx })
    }
    const occ = occurrences(a)
    if (occ.length === 0 || occ.length > 2000) throw bad('bad_announcement', { announcement: idx })
    for (const t of occ) {
      if (!onGrid(t) || t < start || t >= end || t + lengthS * 1000 > end) throw bad('bad_announcement', { announcement: idx, at: new Date(t).toISOString() })
      const w: [number, number] = [t, Math.min(Math.ceil((t + lengthS * 1000 + ANNOUNCE_TAIL_S * 1000) / MIN) * MIN, end)]
      if (etDatesSpanned(w[0], w[1]) > 1) throw bad('bad_announcement', { announcement: idx, at: new Date(t).toISOString(), reason: 'crosses_midnight' })
      if (overlapsNightlyRestart(w[0], w[1])) throw bad('nightly_restart', { announcement: idx, at: new Date(t).toISOString() })
      // The compiler's own window rules (azuracast/windows.ts).
      const refusal = announcementWindow(t, lengthS, end).refusal
      if (refusal === 'announcement_crosses_midnight') throw bad('bad_announcement', { announcement: idx, at: new Date(t).toISOString(), reason: 'crosses_midnight' })
      if (refusal) throw bad('nightly_restart', { announcement: idx, at: new Date(t).toISOString() })
      for (const o of windows) if (w[0] < o[1] && o[0] < w[1]) throw bad('bad_announcement', { announcement: idx, at: new Date(t).toISOString(), reason: 'overlap' })
      windows.push(w)
    }
  })

  const rows = estimateRows(ev, p, s)
  if (timing && !actor.staff && rows > s.events_max_rows) throw bad('too_many_rows', { rows, max: s.events_max_rows })
  return { rows }
}

/** Ready to submit: at least one song that is not pinned (the main playlist). */
export function assertSubmittable(p: PlaylistInput): void {
  if (!p.tracks.some((t) => t.pinAt === null)) throw bad('empty_playlist')
}

// ------------------------------------------------------------ edits -----

/** Canonical, order-stable form of a playlist for change detection. */
export function playlistKey(p: PlaylistInput & { playlistOrder: PlaylistOrder }): string {
  const tracks = [...p.tracks]
    .sort((a, b) => a.position - b.position)
    .map((t) => [t.source, t.mediaId, t.audioId, t.pinAt === null ? null : Date.parse(t.pinAt)])
  const anns = p.announcements
    .map((a) => [a.source, a.mediaId, a.audioId, a.mode, a.at && Date.parse(a.at), a.everyMin, a.from && Date.parse(a.from), a.until && Date.parse(a.until)])
    .map((x) => JSON.stringify(x))
    .sort()
  return JSON.stringify({ o: p.playlistOrder, t: tracks, a: anns })
}

export type DetailFields = {
  title: string
  hostName: string | null
  description: string | null
  location: string | null
  eventType: string
  startsAt: Date
  endsAt: Date
  visibility: Visibility
  playlistOrder: PlaylistOrder
}

/**
 * Fields whose change by a member sends an approved/built event back to
 * review. Title too: it names the public main playlist on the station (and
 * the public calendar), so staff see it before it airs.
 */
export const REAPPROVAL_FIELDS = ['title', 'startsAt', 'endsAt', 'visibility', 'playlistOrder'] as const

export function needsReapproval(changed: readonly string[], playlistChanged: boolean): boolean {
  return playlistChanged || changed.some((k) => (REAPPROVAL_FIELDS as readonly string[]).includes(k))
}

/** Which detail fields differ (dates compared by instant). */
export function changedFields(before: DetailFields, patch: Partial<DetailFields>): (keyof DetailFields)[] {
  const out: (keyof DetailFields)[] = []
  for (const k of Object.keys(patch) as (keyof DetailFields)[]) {
    const a = before[k]
    const b = patch[k]
    if (b === undefined) continue
    const same = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b
    if (!same) out.push(k)
  }
  return out
}
