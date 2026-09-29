// EFM Events Portal — shared TS types (build contract v1, "Types").
//
// Every workstream imports these names; do not rename. The value arrays are
// the single source for the zod enums in api.ts and the DB text columns.

export const EVENT_STATUSES = ['draft', 'pending', 'approved', 'built', 'live', 'ended', 'denied', 'withdrawn', 'cancelled', 'expired', 'failed'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export const VISIBILITIES = ['public', 'private'] as const
export type Visibility = (typeof VISIBILITIES)[number]

export const PLAYLIST_ORDERS = ['shuffle', 'sequential'] as const
export type PlaylistOrder = (typeof PLAYLIST_ORDERS)[number]

export const TRACK_SOURCES = ['library', 'upload'] as const
export type TrackSource = (typeof TRACK_SOURCES)[number]

export const ANNOUNCEMENT_SOURCES = ['stinger', 'upload'] as const
export type AnnouncementSource = (typeof ANNOUNCEMENT_SOURCES)[number]

export const ANNOUNCEMENT_MODES = ['at', 'every'] as const
export type AnnouncementMode = (typeof ANNOUNCEMENT_MODES)[number]

export const AUDIO_KINDS = ['song', 'announcement'] as const
export type AudioKind = (typeof AUDIO_KINDS)[number]

export const AUDIO_STATUSES = ['probing', 'ready', 'ingesting', 'live', 'rejected', 'failed'] as const
export type AudioStatus = (typeof AUDIO_STATUSES)[number]

export const EVENT_TYPES = ['grand_opening', 'club_night', 'private_party', 'car_meet', 'business', 'community', 'special', 'other'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVERY_MIN_CHOICES = [15, 20, 30, 60] as const
export type EveryMin = (typeof EVERY_MIN_CHOICES)[number]

export const BUILD_STATUSES = ['pending', 'applying', 'applied', 'failed', 'torn_down'] as const
export type BuildStatus = (typeof BUILD_STATUSES)[number]

export const REGISTRY_ROLES = ['main', 'pin', 'announce'] as const
export type RegistryRole = (typeof REGISTRY_ROLES)[number]

/** Statuses a public projection may carry. */
export type PublicStatus = 'approved' | 'built' | 'live' | 'ended'

export interface EventTrack {
  position: number
  source: TrackSource
  mediaId: number | null
  audioId: number | null
  pinAt: string | null /* ISO UTC */
}

export interface EventAnnouncement {
  id?: number
  source: AnnouncementSource
  mediaId: number | null
  audioId: number | null
  mode: AnnouncementMode
  at: string | null
  everyMin: EveryMin | null
  from: string | null
  until: string | null
}

// What any viewer may see (output of viewEvent). kind decides which fields are present.
export type EventView =
  | { kind: 'public'; id: number; startsAt: string; endsAt: string; status: PublicStatus; title: string; hostName: string | null; description: string | null; location: string | null; eventType: EventType }
  | { kind: 'private'; id: number; startsAt: string; endsAt: string; status: PublicStatus; label: 'Booked · Private event' }
  | { kind: 'pending'; id: number; startsAt: string; endsAt: string; status: 'pending'; label: 'Pending' }
  | {
      kind: 'full' /* owner or staff */
      id: number
      ownerDiscordId: string
      startsAt: string
      endsAt: string
      status: EventStatus
      visibility: Visibility
      title: string
      hostName: string | null
      description: string | null
      location: string | null
      eventType: EventType
      shortNotice: boolean
      playlistOrder: PlaylistOrder
      tracks: EventTrack[]
      announcements: EventAnnouncement[]
      ticketUrl: string | null
      freezeAt: string
      canEdit: boolean
      buildStatus: string | null
    }

export type EventViewKind = EventView['kind']
export type FullEventView = Extract<EventView, { kind: 'full' }>
