// Pure playlist-builder rules (mirrors the plan §3/§4; the API enforces them
// again). Songs: no duplicates, optional pin on the 5-minute grid inside the
// event and not later than end − 15 min. Announcements: "at" on the 5-minute
// grid inside the event, or "every 15/20/30/60 min" between two grid times.
// Neither may touch 01:55–02:05 ET (AzuraCast's nightly restart).

import { ANNOUNCE_GRID_MIN, ANNOUNCE_TAIL_S, EVERY_MIN_OPTIONS, PIN_WINDOW_MIN } from '@/events/contract/rules'
import type { EventAnnouncement, EventTrack, EveryMin, PlaylistOrder } from '@/events/contract/types'
import { daysTouched, ET, MIN, slots5, touchesNightlyRestart } from './time'

export type BTrack = {
  key: string
  source: 'library' | 'upload'
  mediaId: number | null
  audioId: number | null
  title: string
  artist: string | null
  lengthS: number | null
  pinAt: string | null
}

export type BAnn = {
  key: string
  source: 'stinger' | 'upload'
  mediaId: number | null
  audioId: number | null
  title: string
  lengthS: number | null
  mode: 'at' | 'every'
  at: string | null
  everyMin: EveryMin | null
  from: string | null
  until: string | null
}

export type Builder = { tracks: BTrack[]; anns: BAnn[]; order: PlaylistOrder }

export const trackId = (t: Pick<BTrack, 'source' | 'mediaId' | 'audioId'>) => `${t.source}:${t.source === 'library' ? t.mediaId : t.audioId}`

export function addTrack(list: BTrack[], t: BTrack): { list: BTrack[]; error: string | null } {
  if (list.some((x) => trackId(x) === trackId(t))) return { list, error: `"${t.title}" is already in the playlist. Each song can be added once.` }
  return { list: [...list, t], error: null }
}

export function moveTrack(list: BTrack[], i: number, dir: -1 | 1): BTrack[] {
  const j = i + dir
  if (i < 0 || j < 0 || i >= list.length || j >= list.length) return list
  const out = [...list]
  ;[out[i], out[j]] = [out[j]!, out[i]!]
  return out
}

export const removeAt = <T>(list: T[], i: number): T[] => list.filter((_, k) => k !== i)

const ms = (s: string | null) => (s ? Date.parse(s) : NaN)

/** Grid times a song may be pinned to: [start, end − 15 min]. */
export function pinSlots(start: string, end: string): number[] {
  return slots5(Date.parse(start), Date.parse(end) - PIN_WINDOW_MIN * MIN).filter((t) => !touchesNightlyRestart(t, t + PIN_WINDOW_MIN * MIN))
}

export function checkPin(pinAt: string | null, start: string, end: string): string | null {
  if (!pinAt) return null
  const t = ms(pinAt)
  const s = Date.parse(start)
  const e = Date.parse(end)
  if (!Number.isFinite(t)) return 'That pin time is not valid.'
  if (t % (ANNOUNCE_GRID_MIN * MIN) !== 0) return 'Pin times are on a 5-minute grid.'
  if (t < s || t > e - PIN_WINDOW_MIN * MIN) return 'A pinned song must be inside the event and at least 15 minutes before it ends.'
  if (touchesNightlyRestart(t, Math.min(t + PIN_WINDOW_MIN * MIN, e))) return 'Nothing can be pinned between 1:55 and 2:05 AM ET: the station restarts then.'
  return null
}

/** Grid times an "at" announcement (or an "every" window edge) may use: [start, end). */
export function annSlots(start: string, end: string): number[] {
  return slots5(Date.parse(start), Date.parse(end) - ANNOUNCE_GRID_MIN * MIN)
}

/** Instants an "every" announcement plays: from, from + n·every, … < until. */
export function everyOccurrences(from: string, until: string, everyMin: number): number[] {
  const out: number[] = []
  const a = Date.parse(from)
  const b = Date.parse(until)
  if (!Number.isFinite(a) || !Number.isFinite(b) || everyMin <= 0) return out
  for (let t = a; t < b && out.length < 1000; t += everyMin * MIN) out.push(t)
  return out
}

export function annOccurrences(a: Pick<BAnn, 'mode' | 'at' | 'from' | 'until' | 'everyMin'>): number[] {
  if (a.mode === 'at') return a.at ? [Date.parse(a.at)] : []
  return a.from && a.until && a.everyMin ? everyOccurrences(a.from, a.until, a.everyMin) : []
}

export function checkAnnouncement(a: BAnn, start: string, end: string): string | null {
  const s = Date.parse(start)
  const e = Date.parse(end)
  const grid = (t: number) => t % (ANNOUNCE_GRID_MIN * MIN) === 0
  const tail = ((a.lengthS ?? 0) + ANNOUNCE_TAIL_S) * 1000
  if (a.mode === 'at') {
    const t = ms(a.at)
    if (!Number.isFinite(t)) return 'Pick a time for the announcement.'
    if (!grid(t)) return 'Announcement times are on a 5-minute grid.'
    if (t < s || t >= e) return 'The announcement time must be inside the event.'
  } else {
    if (!a.everyMin || !EVERY_MIN_OPTIONS.includes(a.everyMin)) return 'Pick how often it plays: every 15, 20, 30 or 60 minutes.'
    const f = ms(a.from)
    const u = ms(a.until)
    if (!Number.isFinite(f) || !Number.isFinite(u)) return 'Pick the times it starts and stops repeating.'
    if (!grid(f) || !grid(u)) return 'Announcement times are on a 5-minute grid.'
    if (u <= f) return 'The "until" time must be after the "from" time.'
    if (f < s || u > e) return 'The repeat window must be inside the event.'
  }
  for (const t of annOccurrences(a)) {
    if (touchesNightlyRestart(t, Math.min(t + tail, e))) return 'No announcements between 1:55 and 2:05 AM ET: the station restarts then.'
  }
  return null
}

/** Sum of known song lengths (seconds) and how many songs have no length. */
export function runningLength(tracks: BTrack[]): { seconds: number; unknown: number } {
  let seconds = 0
  let unknown = 0
  for (const t of tracks) {
    if (t.lengthS == null) unknown++
    else seconds += t.lengthS
  }
  return { seconds, unknown }
}

/**
 * Estimated AzuraCast schedule rows: every row is split per ET date, so the
 * main playlist needs one per date the event touches, each pin one per date
 * its window touches, and each announcement occurrence one row.
 */
export function estimateRows(b: Pick<Builder, 'tracks' | 'anns'>, start: string, end: string): number {
  const e = Date.parse(end)
  let rows = daysTouched(start, end, ET).length
  for (const t of b.tracks) {
    if (!t.pinAt) continue
    const p = Date.parse(t.pinAt)
    rows += daysTouched(new Date(p), new Date(Math.min(p + PIN_WINDOW_MIN * MIN, e)), ET).length
  }
  for (const a of b.anns) rows += annOccurrences(a).length
  return rows
}

/** The PUT /api/ev/events/:id/playlist body. */
export function toPayload(b: Builder): { tracks: EventTrack[]; announcements: EventAnnouncement[]; playlistOrder: PlaylistOrder } {
  return {
    playlistOrder: b.order,
    tracks: b.tracks.map((t, i) => ({
      position: i,
      source: t.source,
      mediaId: t.source === 'library' ? t.mediaId : null,
      audioId: t.source === 'upload' ? t.audioId : null,
      pinAt: t.pinAt,
    })),
    announcements: b.anns.map((a) => ({
      source: a.source,
      mediaId: a.source === 'stinger' ? a.mediaId : null,
      audioId: a.source === 'upload' ? a.audioId : null,
      mode: a.mode,
      at: a.mode === 'at' ? a.at : null,
      everyMin: a.mode === 'every' ? a.everyMin : null,
      from: a.mode === 'every' ? a.from : null,
      until: a.mode === 'every' ? a.until : null,
    })),
  }
}

/** Every problem in a builder for an event window (for the review step). */
export function builderProblems(b: Builder, start: string, end: string, maxRows: number): string[] {
  const out: string[] = []
  if (!b.tracks.length) out.push('Add at least one song.')
  const seen = new Set<string>()
  for (const t of b.tracks) {
    const id = trackId(t)
    if (seen.has(id)) out.push(`"${t.title}" is in the playlist twice.`)
    seen.add(id)
    const p = checkPin(t.pinAt, start, end)
    if (p) out.push(`"${t.title}": ${p}`)
  }
  for (const a of b.anns) {
    const p = checkAnnouncement(a, start, end)
    if (p) out.push(`Announcement "${a.title}": ${p}`)
  }
  const rows = estimateRows(b, start, end)
  if (rows > maxRows) out.push(`This needs about ${rows} schedule entries; the limit is ${maxRows}. Remove some pins or announcements, or repeat them less often.`)
  return out
}
