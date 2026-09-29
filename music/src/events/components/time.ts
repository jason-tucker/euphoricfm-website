// Pure time helpers for the events site. Every time shown on the site is
// either Eastern (America/New_York, the station's zone) or the viewer's local
// zone; the <When> component (tz.tsx) is the only place that renders one.
// Inputs in the request form are wall-clock date + time in the chosen zone
// and are converted to UTC ISO here before anything is sent.

export const ET = 'America/New_York'
export type TzMode = 'et' | 'local'

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

/** The IANA zone for a mode (undefined = the browser's own zone). */
export const zoneOf = (mode: TzMode): string | undefined => (mode === 'et' ? ET : undefined)

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const partsFmt = new Map<string, Intl.DateTimeFormat>()
function fmtFor(zone: string | undefined): Intl.DateTimeFormat {
  const key = zone ?? ''
  let f = partsFmt.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
    partsFmt.set(key, f)
  }
  return f
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock parts of an instant in a zone. */
export function partsIn(d: Date | number | string, zone: string | undefined): Parts {
  const date = d instanceof Date ? d : new Date(d)
  const p: Record<string, string> = {}
  for (const x of fmtFor(zone).formatToParts(date)) p[x.type] = x.value
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WD[p.weekday ?? 'Sun'] ?? 0,
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD' of an instant in a zone. */
export const dateKey = (d: Date | number | string, zone: string | undefined): string => {
  const p = partsIn(d, zone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** 'HH:MM' (24 h) of an instant in a zone. */
export const timeKey = (d: Date | number | string, zone: string | undefined): string => {
  const p = partsIn(d, zone)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** Offset (ms) of a zone from UTC at an instant: local wall time − UTC. */
function offsetAt(ms: number, zone: string | undefined): number {
  const p = partsIn(ms, zone)
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
  return wall - Math.floor(ms / MIN) * MIN
}

/**
 * The UTC instant of a wall-clock date ('YYYY-MM-DD') and time ('HH:MM') in a
 * zone. DST: a skipped time moves forward by the gap, a repeated time takes
 * the first occurrence. Returns null for malformed input.
 */
export function zonedToUtc(date: string, time: string, zone: string | undefined): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const tm = /^(\d{2}):(\d{2})$/.exec(time)
  if (!dm || !tm) return null
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])]
  const [h, mi] = [Number(tm[1]), Number(tm[2])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  const same = (t: number) => {
    const p = partsIn(t, zone)
    return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi
  }
  // Candidates from the offsets on either side of a possible DST change.
  const g1 = wall - offsetAt(wall, zone)
  const g2 = wall - offsetAt(g1, zone)
  const matches = [g1, g2, g1 - HOUR, g2 - HOUR].filter(same)
  // A repeated wall time (fall back) takes the earlier instant; a skipped
  // one (spring forward) lands after the gap.
  return new Date(matches.length ? Math.min(...matches) : Math.max(g1, g2))
}

/** Short zone label at an instant: "ET" for Eastern, else e.g. "CEST" / "GMT+2". */
export function zoneLabel(d: Date | number | string, mode: TzMode): string {
  if (mode === 'et') return 'ET'
  const date = d instanceof Date ? d : new Date(d)
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date)
    return p.find((x) => x.type === 'timeZoneName')?.value ?? 'local'
  } catch {
    return 'local'
  }
}

export type WhenFormat = 'datetime' | 'date' | 'time' | 'weekday-date' | 'short'

/** A human string for an instant in a zone (without the zone label). */
export function formatIn(d: Date | number | string, mode: TzMode, format: WhenFormat = 'datetime'): string {
  const date = d instanceof Date ? d : new Date(d)
  const timeZone = zoneOf(mode)
  const opts: Intl.DateTimeFormatOptions =
    format === 'date'
      ? { timeZone, month: 'short', day: 'numeric', year: 'numeric' }
      : format === 'weekday-date'
        ? { timeZone, weekday: 'short', month: 'short', day: 'numeric' }
        : format === 'time'
          ? { timeZone, hour: 'numeric', minute: '2-digit' }
          : format === 'short'
            ? { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
            : { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
  return new Intl.DateTimeFormat('en-US', opts).format(date)
}

/** "Sat, Oct 4, 8:00 PM – 11:00 PM" (end date shown only when it differs). */
export function formatRange(start: string | Date, end: string | Date, mode: TzMode): string {
  const zone = zoneOf(mode)
  const sameDay = dateKey(start, zone) === dateKey(end, zone)
  const a = `${formatIn(start, mode, 'weekday-date')}, ${formatIn(start, mode, 'time')}`
  const b = sameDay ? formatIn(end, mode, 'time') : `${formatIn(end, mode, 'weekday-date')}, ${formatIn(end, mode, 'time')}`
  return `${a} – ${b}`
}

/** "3 h 30 min" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (!h) return `${m} min`
  return m ? `${h} h ${m} min` : `${h} h`
}

/** "m:ss" / "h:mm:ss" for a song length in seconds. */
export function formatLength(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '–:––'
  const t = Math.max(0, Math.round(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const ss = pad(t % 60)
  return h ? `${h}:${pad(m)}:${ss}` : `${m}:${ss}`
}

/** 'YYYY-MM' of the month containing an instant, in a zone. */
export const monthKey = (d: Date | number | string, zone: string | undefined): string => dateKey(d, zone).slice(0, 7)

export function shiftMonth(m: string, by: number): string {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  const idx = y * 12 + (mo - 1) + by
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`
}

export const isMonthKey = (s: string | null | undefined): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

/** Month grid (Sunday first): 5–6 weeks of 'YYYY-MM-DD' keys; `inMonth` marks this month's days. */
export function monthGrid(m: string): { key: string; day: number; inMonth: boolean }[][] {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  const first = new Date(Date.UTC(y, mo - 1, 1))
  const start = Date.UTC(y, mo - 1, 1 - first.getUTCDay())
  const weeks: { key: string; day: number; inMonth: boolean }[][] = []
  for (let w = 0; w < 6; w++) {
    const row = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(start + (w * 7 + i) * DAY)
      row.push({ key: d.toISOString().slice(0, 10), day: d.getUTCDate(), inMonth: d.getUTCMonth() === mo - 1 })
    }
    if (w >= 4 && !row.some((c) => c.inMonth)) break
    weeks.push(row)
  }
  return weeks
}

/** Date keys (in a zone) an interval touches, inclusive, capped at 400 days. */
export function daysTouched(start: string | Date, end: string | Date, zone: string | undefined): string[] {
  const s = new Date(start).getTime()
  const e = new Date(end).getTime() - 1
  const out: string[] = []
  let k = dateKey(s, zone)
  const last = dateKey(Math.max(s, e), zone)
  for (let i = 0; i < 400; i++) {
    out.push(k)
    if (k >= last) break
    const [y, mo, d] = k.split('-').map(Number) as [number, number, number]
    k = new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10)
  }
  return out
}

/** UTC range covering a whole month in a zone, with a day of slack each side. */
export function monthRange(m: string, zone: string | undefined): { from: string; to: string } {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  const from = zonedToUtc(`${y}-${pad(mo)}-01`, '00:00', zone) ?? new Date(Date.UTC(y, mo - 1, 1))
  const nm = shiftMonth(m, 1)
  const to = zonedToUtc(`${nm}-01`, '00:00', zone) ?? new Date(Date.UTC(y, mo, 1))
  return { from: new Date(from.getTime() - DAY).toISOString(), to: new Date(to.getTime() + DAY).toISOString() }
}

/** Round an instant up to the next 5-minute mark. */
export const ceil5 = (ms: number): number => Math.ceil(ms / (5 * MIN)) * 5 * MIN
export const onGrid5 = (ms: number): boolean => ms % (5 * MIN) === 0

/** Every 5-minute instant in [from, to] (inclusive), as ms. */
export function slots5(from: number, to: number): number[] {
  const out: number[] = []
  for (let t = ceil5(from); t <= to && out.length < 2000; t += 5 * MIN) out.push(t)
  return out
}

/** Does [a1,a2) overlap [b1,b2)? */
export const overlaps = (a1: number, a2: number, b1: number, b2: number): boolean => a1 < b2 && b1 < a2

/** Does [s,e) touch 01:55–02:05 ET on any date (AzuraCast's nightly restart)? */
export function touchesNightlyRestart(s: number, e: number): boolean {
  for (const k of daysTouched(new Date(s), new Date(e), ET)) {
    const a = zonedToUtc(k, '01:55', ET)
    if (!a) continue
    const b = a.getTime() + 10 * MIN
    if (overlaps(s, e, a.getTime(), b)) return true
  }
  return false
}
