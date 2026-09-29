// Station wall-clock helpers (America/New_York) for the events rules: the
// 5-minute grid, the 01:55–02:05 ET nightly-restart window and per-ET-date
// row counting. Pure; DST handled by Intl (never by fixed offsets).

import { ANNOUNCE_GRID_MIN, NIGHTLY_RESTART_ET, STATION_TZ } from '../contract/rules'

const MIN = 60_000

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: STATION_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

export type EtParts = { y: number; m: number; d: number; hh: number; mm: number }

export function etParts(t: number): EtParts {
  const o: Record<string, number> = {}
  for (const p of partsFmt.formatToParts(new Date(t))) if (p.type !== 'literal') o[p.type] = Number(p.value)
  return { y: o.year!, m: o.month!, d: o.day!, hh: o.hour! % 24, mm: o.minute! }
}

/** Days since the epoch of the ET calendar date `t` falls on. */
export function etDayNumber(t: number): number {
  const p = etParts(t)
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000)
}

/** Number of ET calendar dates the half-open window [a, b) touches (≥ 1). */
export function etDatesSpanned(a: number, b: number): number {
  if (b <= a) return 1
  return etDayNumber(b - 1) - etDayNumber(a) + 1
}

/** On the 5-minute grid: whole minutes, minute % 5 = 0 (all US offsets are whole hours). */
export function onGrid(t: number): boolean {
  return t % (ANNOUNCE_GRID_MIN * MIN) === 0
}

const hm = (s: string) => {
  const [h, m] = s.split(':').map(Number)
  return h! * 60 + m!
}
const RESTART_FROM = hm(NIGHTLY_RESTART_ET.from)
const RESTART_UNTIL = hm(NIGHTLY_RESTART_ET.until)

const wallMinute = (p: EtParts) => p.hh * 60 + p.mm

/** Inside the repeated 1 AM hour of the fall-back day (its rows match twice). */
export function inRepeatedHour(t: number): boolean {
  if (etParts(t).hh !== 1) return false
  return etParts(t + 3600_000).hh === 1 || etParts(t - 3600_000).hh === 1
}

function unsafeMinute(t: number): boolean {
  const m = wallMinute(etParts(t))
  return (m >= RESTART_FROM && m < RESTART_UNTIL) || inRepeatedHour(t)
}

/**
 * Does the half-open window [a, b) touch 01:55–02:05 ET (the nightly stack
 * restart) or the repeated fall-back hour on any date? Pins and
 * announcements may not (the compiler refuses them too). Fast path when the
 * window sits on one ET date away from 01:00–02:05 wall time; otherwise
 * every minute boundary is checked, so DST days behave as the wall clock.
 */
export function overlapsNightlyRestart(a: number, b: number): boolean {
  if (b <= a) return false
  const pa = etParts(a)
  const pb = etParts(b - 1)
  const sameDay = pa.y === pb.y && pa.m === pb.m && pa.d === pb.d
  const ma = wallMinute(pa)
  const mb = wallMinute(pb)
  if (sameDay && mb >= ma && b - a < 6 * 3600_000 && (mb < 60 || ma >= RESTART_UNTIL)) return false
  if (unsafeMinute(a)) return true
  for (let t = Math.floor(a / MIN) * MIN + MIN; t < b; t += MIN) if (unsafeMinute(t)) return true
  return false
}

const whenFmt = new Intl.DateTimeFormat('en-US', { timeZone: STATION_TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: STATION_TZ, hour: 'numeric', minute: '2-digit' })

/** "Sat, Oct 4, 2026, 8:00 PM – 11:00 PM ET" (ticket bodies). */
export function whenText(startsAt: Date, endsAt: Date): string {
  const sameDay = etDayNumber(startsAt.getTime()) === etDayNumber(endsAt.getTime() - 1)
  return `${whenFmt.format(startsAt)} – ${sameDay ? timeFmt.format(endsAt) : whenFmt.format(endsAt)} ET`
}

export function timeText(t: Date): string {
  return `${timeFmt.format(t)} ET`
}
