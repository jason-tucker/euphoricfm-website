// America/New_York wall-clock helpers for the events compiler and the
// allowlist's schedule-item check (plan §4 "Rows"). Station 14 runs in
// America/New_York; AzuraCast stores a schedule row as HHMM integers plus
// Y-m-d date strings in the station's zone. Every conversion here goes
// through Intl (the runtime's tz database), per instant, so each occurrence
// gets its own offset (DST-safe). No dependency.

export const ET_ZONE = 'America/New_York'

const MINUTE = 60_000
const DAY = 86_400_000

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export type EtParts = { y: number; m: number; d: number; hh: number; mm: number; ss: number }

export function etParts(ms: number): EtParts {
  if (!Number.isFinite(ms)) throw new RangeError('bad instant')
  const o: Record<string, number> = {}
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value)
  return { y: o.year!, m: o.month!, d: o.day!, hh: o.hour! % 24, mm: o.minute!, ss: o.second! }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

// 'YYYY-MM-DD' of the instant in ET.
export function etDate(ms: number): string {
  const p = etParts(ms)
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`
}

// HHMM integer (AzuraCast's schedule format) of the instant in ET, seconds
// dropped.
export function etHhmm(ms: number): number {
  const p = etParts(ms)
  return p.hh * 100 + p.mm
}

// Wall-clock minus UTC, in ms (e.g. -4 h in EDT).
export function etOffsetMs(ms: number): number {
  const p = etParts(ms)
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss)
  return wall - Math.floor(ms / 1000) * 1000
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDate(date: string): { y: number; m: number; d: number } {
  const m = DATE_RE.exec(date)
  if (!m) throw new RangeError(`bad date ${date}`)
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new RangeError(`bad date ${date}`)
  return { y, m: mo, d }
}

export function isValidDate(date: string): boolean {
  try {
    parseDate(date)
    return true
  } catch {
    return false
  }
}

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseDate(date)
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY)
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

// ISO weekday (1 = Monday … 7 = Sunday) of an ET date.
export function isoWeekday(date: string): number {
  const { y, m, d } = parseDate(date)
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return wd === 0 ? 7 : wd
}

// The UTC instants at which the ET wall-clock time `date` + `minutes` (0 …
// 1439) occurs: none in the spring-forward gap, two in the fall-back
// repeated hour, one otherwise. Sorted ascending.
export function etWallToUtc(date: string, minutes: number): number[] {
  const { y, m, d } = parseDate(date)
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) throw new RangeError('bad minutes')
  const wall = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60)
  const out = new Set<number>()
  // The zone's offset is within [-5 h, -4 h]; try both candidate offsets
  // (taken from instants around the wall time) and keep the ones that
  // round-trip.
  for (const probe of [wall + 3 * 3600_000, wall + 6 * 3600_000]) {
    const u = wall - etOffsetMs(probe)
    const p = etParts(u)
    if (p.y === y && p.m === m && p.d === d && p.hh * 60 + p.mm === minutes) out.add(u)
  }
  return [...out].sort((a, b) => a - b)
}

// UTC instant of 00:00 ET on `date` (midnight is never inside a New York
// DST transition, which happens at 02:00).
export function etMidnightUtc(date: string): number {
  const u = etWallToUtc(date, 0)
  if (u.length !== 1) throw new RangeError(`midnight of ${date} is not a single instant`)
  return u[0]!
}

// True when `date` is the fall-back day (the 01:00–01:59 wall-clock hour
// occurs twice).
export function isFallBackDate(date: string): boolean {
  const a = etOffsetMs(etMidnightUtc(date))
  const b = etOffsetMs(etMidnightUtc(addDays(date, 1)))
  return a > b
}

export function isSpringForwardDate(date: string): boolean {
  const a = etOffsetMs(etMidnightUtc(date))
  const b = etOffsetMs(etMidnightUtc(addDays(date, 1)))
  return a < b
}

export const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE
export const ceilMinute = (ms: number) => Math.ceil(ms / MINUTE) * MINUTE

export type DaySegment = {
  date: string // ET date of the segment
  startMs: number
  endMs: number
  // true when the segment was cut at the next ET midnight
  cutAtMidnight: boolean
}

// Splits [startMs, endMs) into per-ET-date segments.
export function splitByEtDate(startMs: number, endMs: number): DaySegment[] {
  if (!(endMs > startMs)) return []
  const out: DaySegment[] = []
  let s = startMs
  let guard = 0
  while (s < endMs) {
    if (guard++ > 1000) throw new RangeError('window too long')
    const date = etDate(s)
    const mid = etMidnightUtc(addDays(date, 1))
    const e = Math.min(endMs, mid)
    // A window ending exactly at midnight counts as cut too (its end is 24:00).
    out.push({ date, startMs: s, endMs: e, cutAtMidnight: e === mid })
    s = e
  }
  return out
}

// Wall-clock minutes-of-day [start, end] of a same-date segment, with a
// segment that reaches midnight ending at 23:59 (HHMM has no 24:00).
export function segmentMinutes(seg: DaySegment): { start: number; end: number } {
  const sp = etParts(seg.startMs)
  const start = sp.hh * 60 + sp.mm
  if (seg.cutAtMidnight) return { start, end: 23 * 60 + 59 }
  const ep = etParts(seg.endMs)
  return { start, end: ep.hh * 60 + ep.mm }
}

export const minutesToHhmm = (min: number) => Math.floor(min / 60) * 100 + (min % 60)
export const hhmmToMinutes = (hhmm: number) => Math.floor(hhmm / 100) * 60 + (hhmm % 100)
export const isHhmm = (v: number) => Number.isInteger(v) && v >= 0 && v <= 2359 && v % 100 < 60
