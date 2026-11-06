// Pin and announcement schedule windows (plan §4 "AzuraCast compile"),
// shared by the compiler (compiler.ts) and the web's playlist validation
// (server/rules.ts), so the server never accepts a pin or announcement the
// compiler would refuse at build time. PURE: wall-clock ET math only.
//
//   pin:          [pin, min(pin + 15 min, end)], truncated at 23:59 of its
//                 date (one same-date row); refused when it touches
//                 01:55–02:05 (nightly restart) or the repeated 01:00 hour
//                 of the fall-back date, or when the truncated row would be
//                 under a minute (a pin at 23:59: start == end is
//                 AzuraCast's "play once" form, never sent);
//   announcement: [t, ceil(t + length + 1 min)] clamped to the end; refused
//                 when it crosses midnight, touches the restart band or the
//                 repeated hour.

import { ANNOUNCE_TAIL_S, PIN_WINDOW_MIN } from '../contract/rules'
import { ceilMinute, floorMinute, isFallBackDate, segmentMinutes, splitByEtDate } from './time'

export type Window = { startMs: number; endMs: number }

export const PIN_WINDOW_MS = PIN_WINDOW_MIN * 60_000
export const ANNOUNCE_SLACK_MS = ANNOUNCE_TAIL_S * 1000

// The nightly stack restart, 01:55–02:05 ET (minutes of the day).
export const RESTART_BAND = { start: 1 * 60 + 55, end: 2 * 60 + 5 }

export function crossesMidnight(w: Window): boolean {
  return splitByEtDate(w.startMs, w.endMs).length > 1
}

export function truncateAtMidnight(w: Window): Window {
  const segs = splitByEtDate(w.startMs, w.endMs)
  return { startMs: w.startMs, endMs: segs[0]!.endMs }
}

export function overlapsRestartBand(w: Window): boolean {
  for (const seg of splitByEtDate(w.startMs, w.endMs)) {
    const { start, end } = segmentMinutes(seg)
    // [start, end] against [01:55, 02:05)
    if (start < RESTART_BAND.end && end > RESTART_BAND.start) return true
    if (start === end && start >= RESTART_BAND.start && start < RESTART_BAND.end) return true
  }
  return false
}

// The repeated wall-clock hour of the fall-back day: a row there matches
// twice (once per pass), so pins/announcements may not touch it (a row
// ending at 01:00 included).
export function touchesFallBackHour(w: Window): boolean {
  for (const seg of splitByEtDate(w.startMs, w.endMs)) {
    if (!isFallBackDate(seg.date)) continue
    const { start, end } = segmentMinutes(seg)
    if (start < 2 * 60 && end >= 1 * 60) return true
  }
  return false
}

// A same-date row of at least one minute (HHMM end > start).
function rowTooShort(w: Window): boolean {
  const segs = splitByEtDate(w.startMs, w.endMs)
  if (segs.length !== 1) return true
  const { start, end } = segmentMinutes(segs[0]!)
  return !(end > start)
}

export type PinRefusal = 'pin_in_restart_window' | 'dst_ambiguous' | 'row_too_short'

/** A pin's window (minute-aligned, truncated at midnight) and why the compiler refuses it, if it does. */
export function pinWindow(pinAtMs: number, eventEndMs: number): { window: Window; refusal: PinRefusal | null } {
  const at = floorMinute(pinAtMs)
  const end = ceilMinute(eventEndMs)
  let w: Window = { startMs: at, endMs: Math.min(at + PIN_WINDOW_MS, end) }
  if (crossesMidnight(w)) w = truncateAtMidnight(w)
  if (overlapsRestartBand(w)) return { window: w, refusal: 'pin_in_restart_window' }
  if (touchesFallBackHour(w)) return { window: w, refusal: 'dst_ambiguous' }
  if (rowTooShort(w)) return { window: w, refusal: 'row_too_short' }
  return { window: w, refusal: null }
}

export type AnnouncementRefusal = 'announcement_crosses_midnight' | 'announcement_in_restart_window' | 'dst_ambiguous'

/** One announcement occurrence's window and why the compiler refuses it, if it does. */
export function announcementWindow(atMs: number, durationS: number, eventEndMs: number): { window: Window; refusal: AnnouncementRefusal | null } {
  const w: Window = { startMs: atMs, endMs: Math.min(ceilMinute(atMs + durationS * 1000 + ANNOUNCE_SLACK_MS), ceilMinute(eventEndMs)) }
  if (crossesMidnight(w)) return { window: w, refusal: 'announcement_crosses_midnight' }
  if (overlapsRestartBand(w)) return { window: w, refusal: 'announcement_in_restart_window' }
  if (touchesFallBackHour(w)) return { window: w, refusal: 'dst_ambiguous' }
  return { window: w, refusal: null }
}
