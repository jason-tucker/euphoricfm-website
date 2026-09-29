// Client-side shapes of the events HTTP API (contract: GET /api/ev/config,
// /api/ev/me, /api/ev/library, /api/ev/stingers, /api/ev/audio,
// /api/ev/availability). The event shapes come from the shared contract.

export type {
  AnnouncementMode,
  AnnouncementSource,
  EventAnnouncement,
  EventStatus,
  EventTrack,
  EventType,
  EventView,
  PlaylistOrder,
  TrackSource,
  Visibility,
} from '@/events/contract/types'

import type { z } from 'zod'
import type { AudioRow, AvailabilityRow, LibraryRow, MeResponse, StaffQueueResponse, StingerRow } from '@/events/contract/api'
import type { EventView } from '@/events/contract/types'

export type FullView = Extract<EventView, { kind: 'full' }>
export type PublicView = Extract<EventView, { kind: 'public' }>

export type EvConfig = {
  // = z.infer<typeof ConfigResponse>, with the URLs widened to string
  eventsEnabled: boolean
  uploadsEnabled: boolean
  autobuildEnabled: boolean
  minNoticeH: number
  warnNoticeH: number
  memberMaxHours: number
  horizonDays: number
  maxPending: number
  maxUpcoming: number
  gapMin: number
  freezeMin: number
  maxRows: number
  audioMaxItems: number
  endWaitS: number
  caps: { mp3Bytes: number; wavBytes: number; maxDurationS: number; minDurationS: number }
  stationListenUrl: string
  nowPlayingUrl: string
}

/** Launch defaults (contract settings), used until /api/ev/config answers. */
export const DEFAULT_CONFIG: EvConfig = {
  eventsEnabled: false,
  uploadsEnabled: false,
  autobuildEnabled: false,
  minNoticeH: 24,
  warnNoticeH: 48,
  memberMaxHours: 24,
  horizonDays: 180,
  maxPending: 5,
  maxUpcoming: 10,
  gapMin: 10,
  freezeMin: 30,
  maxRows: 150,
  audioMaxItems: 20,
  endWaitS: 90,
  caps: { mp3Bytes: 100 * 1024 * 1024, wavBytes: 250 * 1024 * 1024, maxDurationS: 24 * 60, minDurationS: 1 },
  stationListenUrl: 'https://euphoric.fm/listen/event/radio.mp3',
  nowPlayingUrl: 'https://euphoric.fm/api/nowplaying/event',
}

export type EvMe = z.infer<typeof MeResponse>
export type LibrarySong = z.infer<typeof LibraryRow>
export type Stinger = z.infer<typeof StingerRow>
export type AudioItem = z.infer<typeof AudioRow>
export type Busy = z.infer<typeof AvailabilityRow>
export type StaffQueue = z.infer<typeof StaffQueueResponse>

/** Lists may come back bare or wrapped ({items|results|events: [...]}); accept both. */
export function listOf<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[]
  if (body && typeof body === 'object') {
    for (const k of ['items', 'results', 'events', 'audio', 'stingers', 'busy', 'songs']) {
      const v = (body as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}
