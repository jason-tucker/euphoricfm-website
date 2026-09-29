// Pure request-form rules: field limits and the live time feedback (notice,
// length, horizon, clashes incl. the gap, the nightly restart). Members get
// errors; staff are exempt and see the same findings as warnings. The API
// enforces all of it again.

import { DESCRIPTION_MAX, HOST_NAME_MAX, LOCATION_MAX, TITLE_MAX } from '@/events/contract/rules'
import type { EventType, Visibility } from '@/events/contract/types'
import { DAY, formatIn, formatDuration, HOUR, MIN, overlaps, touchesNightlyRestart, type TzMode, zonedToUtc, zoneLabel, zoneOf } from './time'
import type { Busy, EvConfig } from './types'

export type Details = { title: string; hostName: string; description: string; location: string; eventType: EventType | '' }
export type When = { date: string; time: string; lengthMin: number }
export type Draft = Details & When & { visibility: Visibility | '' }

export const EMPTY_DRAFT: Draft = { title: '', hostName: '', description: '', location: '', eventType: '', date: '', time: '', lengthMin: 120, visibility: '' }

export function checkDetails(d: Details): Partial<Record<keyof Details, string>> {
  const e: Partial<Record<keyof Details, string>> = {}
  const t = d.title.trim()
  if (!t) e.title = 'Give your event a title.'
  else if (t.length > TITLE_MAX) e.title = `Keep the title to ${TITLE_MAX} characters or fewer.`
  if (d.hostName.trim().length > HOST_NAME_MAX) e.hostName = `Keep the host name to ${HOST_NAME_MAX} characters or fewer.`
  if (d.location.trim().length > LOCATION_MAX) e.location = `Keep the location to ${LOCATION_MAX} characters or fewer.`
  if (d.description.trim().length > DESCRIPTION_MAX) e.description = `Keep the description to ${DESCRIPTION_MAX} characters or fewer.`
  if (!d.eventType) e.eventType = 'Pick the kind of event.'
  return e
}

/** Length choices (minutes): 30-minute steps up to the member limit (staff: 72 h). */
export function lengthOptions(maxHours: number): number[] {
  const out: number[] = []
  for (let m = 30; m <= maxHours * 60; m += 30) out.push(m)
  return out
}

export type TimeCheck = { errors: string[]; warnings: string[]; startsAt: string | null; endsAt: string | null; otherZone: string | null }

/** Busy rows minus the event being edited (its own slot and the gaps that touch it). */
export function withoutSelf(busy: Busy[], self: { startsAt: string; endsAt: string } | null | undefined): Busy[] {
  if (!self) return busy
  const s = Date.parse(self.startsAt)
  const e = Date.parse(self.endsAt)
  return busy.filter((b) => {
    const bs = Date.parse(b.startsAt)
    const be = Date.parse(b.endsAt)
    if (b.kind === 'event') return !(bs === s && be === e)
    return !(be === s || bs === e)
  })
}

export function checkTime(input: {
  when: When
  mode: TzMode
  now: number
  config: EvConfig
  staff: boolean
  busy: Busy[]
}): TimeCheck {
  const { when, mode, now, config: c, staff, busy } = input
  const errors: string[] = []
  const warnings: string[] = []
  const rule = (msg: string) => (staff ? warnings.push(`Staff override: ${msg}`) : errors.push(msg))
  if (!when.date || !when.time) return { errors: ['Pick a date and a start time.'], warnings, startsAt: null, endsAt: null, otherZone: null }
  const start = zonedToUtc(when.date, when.time, zoneOf(mode))
  if (!start) return { errors: ['That date or time is not valid.'], warnings, startsAt: null, endsAt: null, otherZone: null }
  const s = start.getTime()
  const e = s + when.lengthMin * MIN
  if (when.lengthMin <= 0) errors.push('Pick how long the event runs.')
  if (s <= now) errors.push('That time has already passed.')
  else {
    const earliest = now + c.minNoticeH * HOUR
    if (s < earliest) rule(`Events must start at least ${c.minNoticeH} hours from now. The earliest start is ${formatIn(earliest, mode, 'datetime')} ${zoneLabel(earliest, mode)}.`)
    else if (s < now + c.warnNoticeH * HOUR) warnings.push(`Short notice: this starts in under ${c.warnNoticeH} hours. We'll try, but we may not be able to get it ready in time.`)
    if (s > now + c.horizonDays * DAY) rule(`You can book up to ${c.horizonDays} days ahead.`)
  }
  if (when.lengthMin > c.memberMaxHours * 60) rule(`Events can be up to ${c.memberMaxHours} hours long (this one is ${formatDuration(when.lengthMin * MIN)}).`)
  const clash = busy.find((b) => overlaps(s, e, Date.parse(b.startsAt), Date.parse(b.endsAt)))
  if (clash) {
    const msg =
      clash.kind === 'gap'
        ? `That is too close to another booking: events need ${c.gapMin} minutes between them.`
        : `That time clashes with another booking (${formatIn(clash.startsAt, mode, 'time')}–${formatIn(clash.endsAt, mode, 'time')} ${zoneLabel(clash.startsAt, mode)}).`
    if (staff && clash.kind === 'gap') warnings.push(`Staff override: ${msg}`)
    else errors.push(msg)
  }
  if (touchesNightlyRestart(s, e)) warnings.push('The station restarts every night at about 2:00 AM ET, so there may be a short gap in the music around then.')
  const other: TzMode = mode === 'et' ? 'local' : 'et'
  const otherZone = `${formatIn(s, other, 'datetime')} ${zoneLabel(s, other)}`
  return { errors, warnings, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), otherZone }
}

/** The requester's zone name for `enteredTz`. */
export function enteredTz(mode: TzMode): string {
  if (mode === 'et') return 'America/New_York'
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
