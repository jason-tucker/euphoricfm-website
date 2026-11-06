// Ticket copy for the jobs events-web enqueues (the events worker sends
// them; outbound only in v1). Plain text, one idea per line, bounded to what
// the worker posts (1800). Never includes anything the ticket's readers
// (the owner and staff) may not see.

import type { PlaylistOrder, Visibility } from '../contract/types'
import { whenText } from './time'

// The worker posts bodies verbatim up to 1800 characters.
const BODY_MAX = 1800

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim()
const body = (lines: string[]) => clip(lines.filter((l) => l !== '').join('\n'), BODY_MAX)

export function approvedBody(autobuild: boolean): string {
  return body([
    'Approved by EuphoricFM staff.',
    autobuild
      ? 'The Events station will be set up automatically before the event starts.'
      : 'Staff will load it into the Events station before it starts.',
  ])
}

export const deniedBody = (reason: string) => body(['This request was denied.', `Reason: ${clip(oneLine(reason), 1000)}`])
export const cancelledBody = (reason: string) => body(['This event was cancelled by staff.', `Reason: ${clip(oneLine(reason), 1000)}`])
export const withdrawnBody = () => body(['The requester withdrew this event.'])

export type DiffSide = {
  title: string
  hostName: string | null
  description: string | null
  location: string | null
  eventType: string
  startsAt: Date
  endsAt: Date
  visibility: Visibility
  playlistOrder: PlaylistOrder
  songs: string[] // display names, in order
  pins: string[] // "<song> at <time>"
  announcements: string[] // "<label>: at 8:30 PM ET" / "every 30 min …"
}

function listDiff(what: string, a: string[], b: string[]): string[] {
  const added = b.filter((x) => !a.includes(x))
  const removed = a.filter((x) => !b.includes(x))
  const out: string[] = []
  if (added.length || removed.length) {
    out.push(`${what}: ${a.length} → ${b.length}`)
    for (const x of added.slice(0, 15)) out.push(`  + ${clip(oneLine(x), 120)}`)
    if (added.length > 15) out.push(`  + ${added.length - 15} more`)
    for (const x of removed.slice(0, 15)) out.push(`  − ${clip(oneLine(x), 120)}`)
    if (removed.length > 15) out.push(`  − ${removed.length - 15} more`)
  } else if (a.join('\u0000') !== b.join('\u0000')) {
    out.push(`${what}: order changed`)
  }
  return out
}

const quoted = (s: string | null) => (s === null || s === '' ? '(none)' : `“${clip(oneLine(s), 120)}”`)

/** Readable diff of an edit, for the ticket (`edited` post). Empty when nothing visible changed. */
export function diffLines(a: DiffSide, b: DiffSide): string[] {
  const out: string[] = []
  if (a.startsAt.getTime() !== b.startsAt.getTime() || a.endsAt.getTime() !== b.endsAt.getTime()) {
    out.push(`Time: ${whenText(a.startsAt, a.endsAt)} → ${whenText(b.startsAt, b.endsAt)}`)
  }
  if (a.visibility !== b.visibility) out.push(`Visibility: ${cap(a.visibility)} → ${cap(b.visibility)}`)
  if (a.title !== b.title) out.push(`Title: ${quoted(a.title)} → ${quoted(b.title)}`)
  if (a.hostName !== b.hostName) out.push(`Host: ${quoted(a.hostName)} → ${quoted(b.hostName)}`)
  if (a.location !== b.location) out.push(`Location: ${quoted(a.location)} → ${quoted(b.location)}`)
  if (a.eventType !== b.eventType) out.push(`Type: ${a.eventType.replace(/_/g, ' ')} → ${b.eventType.replace(/_/g, ' ')}`)
  if (a.description !== b.description) out.push('Description changed')
  if (a.playlistOrder !== b.playlistOrder) out.push(`Play order: ${a.playlistOrder} → ${b.playlistOrder}`)
  out.push(...listDiff('Songs', a.songs, b.songs))
  out.push(...listDiff('Pinned songs', a.pins, b.pins))
  out.push(...listDiff('Announcements', a.announcements, b.announcements))
  return out
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function editedBody(lines: string[], opts: { byStaff: boolean; reapproval: boolean }): string {
  return body([
    opts.byStaff ? 'Edited by EuphoricFM staff:' : 'The requester edited this event:',
    ...lines,
    opts.reapproval ? 'These changes need staff approval again. The time slot is kept while it waits.' : '',
  ])
}
