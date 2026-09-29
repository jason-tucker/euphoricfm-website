// THE privacy projection (plan §3 "Privacy"): one viewEvent(event, viewer)
// feeds the calendar JSON, the ICS feed, the detail page and every list.
//
//   owner or staff (review)         → full
//   approved|built|live|ended       → public (visibility public) / private
//   pending                         → pending ("Pending" + time only)
//   anything else                   → null (the caller answers 404)
//
// Nothing but the projection's own fields ever leaves: the public/private/
// pending objects are built field by field, never by spreading the row.

import { buildInputKey } from '../contract/build-key'
import { CALENDAR_STATUSES, PENDING_LABEL, PRIVATE_LABEL, PUBLIC_STATUSES } from '../contract/rules'
import type { EventsSettings } from '../contract/settings'
import type { EventAnnouncement, EventStatus, EventTrack, EventType, EventView, FullEventView, PlaylistOrder, PublicStatus, Visibility } from '../contract/types'
import { announcementLabel, canEdit, freezeAt, trackLabel, type Actor, type Lookup } from './rules'

/** The `events` row columns a projection may read. */
export type EventRecord = {
  id: number
  ownerUserId: string
  ownerDiscordId: string
  title: string
  hostName: string | null
  description: string | null
  location: string | null
  eventType: string
  startsAt: Date
  endsAt: Date
  visibility: string
  status: string
  shortNotice: boolean
  playlistOrder: string
  ticketNumber: number | null
  ticketUrl: string | null
  denyReason: string | null
  version: number
}

/** What a full projection needs besides the row (loaded only when full). */
export type FullExtras = {
  tracks: readonly EventTrack[]
  announcements: readonly EventAnnouncement[]
  lookup: Lookup
  buildStatus: string | null
  // the latest APPLIED build: its version and the build-input key it was
  // compiled from (null for a plan without one)
  appliedBuild: { version: number; inputKey: string | null } | null
  ownerName: string | null
  settings: EventsSettings
  now: number
}

const REBUILDABLE: readonly string[] = ['approved', 'built', 'live']

/** The applied build is compiled from other inputs than the event has now. */
export function needsRebuild(ev: EventRecord, x: Pick<FullExtras, 'tracks' | 'announcements' | 'appliedBuild'>): boolean {
  const b = x.appliedBuild
  if (!b || !REBUILDABLE.includes(ev.status) || b.version === ev.version) return false
  return b.inputKey !== buildInputKey(ev, x.tracks, x.announcements)
}

/** Owner or staff: may see everything about this event. */
export function seesFull(ev: Pick<EventRecord, 'ownerUserId'>, viewer: Actor | null): boolean {
  return !!viewer && (viewer.staff || viewer.userId === ev.ownerUserId)
}

const iso = (d: Date) => d.toISOString()

/** Public / private / pending projection, or null when the status is hidden. */
export function publicView(ev: EventRecord): Exclude<EventView, { kind: 'full' }> | null {
  const status = ev.status as EventStatus
  if (status === 'pending') return { kind: 'pending', id: ev.id, startsAt: iso(ev.startsAt), endsAt: iso(ev.endsAt), status: 'pending', label: PENDING_LABEL }
  if (!PUBLIC_STATUSES.includes(status as PublicStatus)) return null
  const s = status as PublicStatus
  if (ev.visibility !== 'public') return { kind: 'private', id: ev.id, startsAt: iso(ev.startsAt), endsAt: iso(ev.endsAt), status: s, label: PRIVATE_LABEL }
  return {
    kind: 'public',
    id: ev.id,
    startsAt: iso(ev.startsAt),
    endsAt: iso(ev.endsAt),
    status: s,
    title: ev.title,
    hostName: ev.hostName,
    description: ev.description,
    location: ev.location,
    eventType: ev.eventType as EventType,
  }
}

export function fullView(ev: EventRecord, viewer: Actor | null, x: FullExtras): FullEventView {
  return {
    kind: 'full',
    id: ev.id,
    ownerDiscordId: ev.ownerDiscordId,
    startsAt: iso(ev.startsAt),
    endsAt: iso(ev.endsAt),
    status: ev.status as EventStatus,
    visibility: ev.visibility as Visibility,
    title: ev.title,
    hostName: ev.hostName,
    description: ev.description,
    location: ev.location,
    eventType: ev.eventType as EventType,
    shortNotice: ev.shortNotice,
    playlistOrder: ev.playlistOrder as PlaylistOrder,
    tracks: x.tracks.map((t) => withLabel({ position: t.position, source: t.source, mediaId: t.mediaId, audioId: t.audioId, pinAt: t.pinAt }, trackLabel(t, x.lookup))),
    announcements: x.announcements.map((a) =>
      withLabel(
        { ...(a.id !== undefined ? { id: a.id } : {}), source: a.source, mediaId: a.mediaId, audioId: a.audioId, mode: a.mode, at: a.at, everyMin: a.everyMin, from: a.from, until: a.until },
        announcementLabel(a, x.lookup),
      ),
    ),
    ticketUrl: ev.ticketUrl,
    freezeAt: iso(freezeAt(ev.startsAt, x.settings)),
    canEdit: canEdit({ ownerUserId: ev.ownerUserId, status: ev.status as EventStatus, startsAt: ev.startsAt, endsAt: ev.endsAt }, viewer, x.settings, x.now),
    buildStatus: x.buildStatus,
    needsRebuild: needsRebuild(ev, x),
    version: ev.version,
    denyReason: ev.denyReason,
    ownerName: x.ownerName,
    ticketNumber: ev.ticketNumber,
  }
}

function withLabel<T extends object>(o: T, label: EventTrack['label']): T {
  return label ? { ...o, label } : o
}

/**
 * The one projection. `full` is called only when the viewer is the owner or
 * staff (so the extras are loaded only then). Returns null when this viewer
 * may not see the event at all.
 */
export function viewEvent(ev: EventRecord, viewer: Actor | null, full: () => FullExtras): EventView | null {
  if (seesFull(ev, viewer)) return fullView(ev, viewer, full())
  return publicView(ev)
}

/** Calendar/ICS rows: only statuses the public calendar carries. */
export const onCalendar = (ev: Pick<EventRecord, 'status'>) => CALENDAR_STATUSES.includes(ev.status as EventStatus)
