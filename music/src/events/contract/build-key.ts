// EFM Events Portal — the build-input key (contract).
//
// A canonical string of everything of an event that its AzuraCast build is
// compiled from: the main playlist's name (sanitized public title, or
// 'Private event'), the window, the playlist order, the songs (in order,
// with their pins) and the announcements. Description, host, location,
// event type and a private event's title are NOT in it: editing them never
// makes an applied build stale.
//
// The worker stores the key of the inputs a build was compiled from on the
// build's plan (`inputKey`); the start / end kicks, verify and recheck
// accept an applied build whose key equals the key of the event as it is
// now (the raw `version` also moves on details-only edits), and the web
// derives `needsRebuild` the same way. Pure: the web (ISO strings) and the
// worker (Dates) feed it the same columns.

import { mainName } from './paths'
import type { Visibility } from './types'

type Instant = Date | string | number | null

const ms = (x: Instant): number | null => (x === null ? null : x instanceof Date ? x.getTime() : typeof x === 'string' ? Date.parse(x) : x)

export type BuildKeyEvent = { title: string; visibility: Visibility | string; startsAt: Instant; endsAt: Instant; playlistOrder: string }
export type BuildKeyTrack = { position: number; source: string; mediaId: number | null; audioId: number | null; pinAt: Instant }
export type BuildKeyAnnouncement = {
  source: string
  mediaId: number | null
  audioId: number | null
  mode: string
  at: Instant
  everyMin: number | null
  from: Instant
  until: Instant
}

export function buildInputKey(ev: BuildKeyEvent, tracks: readonly BuildKeyTrack[], announcements: readonly BuildKeyAnnouncement[]): string {
  const t = [...tracks].sort((a, b) => a.position - b.position).map((x) => [x.source, x.mediaId, x.audioId, ms(x.pinAt)])
  const a = announcements.map((x) => JSON.stringify([x.source, x.mediaId, x.audioId, x.mode, ms(x.at), x.everyMin, ms(x.from), ms(x.until)])).sort()
  return JSON.stringify({
    v: 1,
    name: mainName({ visibility: ev.visibility === 'public' ? 'public' : 'private', title: ev.title }),
    s: ms(ev.startsAt),
    e: ms(ev.endsAt),
    o: ev.playlistOrder,
    t,
    a,
  })
}
