// Public ICS feed (GET /api/ev/calendar.ics). Built ONLY from the anonymous
// projection (view.ts publicView), whoever asks, so a subscribed feed can
// never carry more than the public calendar. UIDs are opaque (HMAC of the
// event id), private and pending entries carry no DESCRIPTION / LOCATION /
// URL, only the fixed label and the time.

import { createHmac } from 'node:crypto'
import { deriveSubkey, parseEncKey } from '../../server/crypto'
import type { EventView } from '../contract/types'

let uidKey: Buffer | null = null
function key(): Buffer {
  if (!uidKey) uidKey = deriveSubkey(parseEncKey(process.env.APP_ENC_KEY), 'events-ics-uid-v1')
  return uidKey
}

export function icsUid(eventId: number, k: Buffer = key()): string {
  return `${createHmac('sha256', k).update(`event:${eventId}`).digest('hex').slice(0, 32)}@events.euphoric.fm`
}

/** RFC 5545 TEXT escaping; control characters dropped. */
export function icsText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
}

/** Fold a content line at 75 octets (continuation lines start with a space). */
export function foldLine(line: string): string {
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > (out.length === 0 ? 75 : 74)) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '')

export function buildIcs(views: readonly Exclude<EventView, { kind: 'full' }>[], opts: { now: Date; origin: string; k?: Buffer }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EuphoricFM//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:EuphoricFM Events',
    'X-WR-TIMEZONE:America/New_York',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ]
  const dtstamp = stamp(opts.now.toISOString())
  for (const v of views) {
    lines.push('BEGIN:VEVENT', `UID:${icsUid(v.id, opts.k)}`, `DTSTAMP:${dtstamp}`, `DTSTART:${stamp(v.startsAt)}`, `DTEND:${stamp(v.endsAt)}`)
    if (v.kind === 'public') {
      lines.push(`SUMMARY:${icsText(v.title)}`, 'STATUS:CONFIRMED')
      const desc = [v.hostName ? `Hosted by ${v.hostName}` : null, v.description].filter(Boolean).join('\n\n')
      if (desc) lines.push(`DESCRIPTION:${icsText(desc)}`)
      if (v.location) lines.push(`LOCATION:${icsText(v.location)}`)
      lines.push(`URL:${opts.origin}/events/${v.id}`)
    } else {
      lines.push(`SUMMARY:${icsText(v.label)}`, v.kind === 'pending' ? 'STATUS:TENTATIVE' : 'STATUS:CONFIRMED', 'CLASS:PRIVATE')
    }
    lines.push('TRANSP:OPAQUE', 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}
