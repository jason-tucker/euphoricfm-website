// EFM Events Portal — pure constants (build contract v1, plan §3/§4).
//
// No imports beyond the contract types and no side effects: safe for client
// components, the web and the events worker alike. Tunable numbers live in
// settings.ts (admin-editable); these are fixed by the plan.

import type { AudioStatus, EventStatus, EveryMin, PublicStatus } from './types'

/** The Euphoric Events station. The events worker refuses any other id. */
export const EVENTS_STATION_ID = 14
/** The music station and the other canaries the events key must NOT reach. */
export const EVENTS_DEFAULT_CANARY_STATION_IDS = [1, 7] as const
/** Station-14 playlists that predate the portal (74 Stinger … 78 Renfair). Never written. */
export const LEGACY_EVENT_PLAYLIST_IDS = [74, 75, 76, 77, 78] as const
/** The wrapper refuses PUT/DELETE on any playlist id at or below this floor. */
export const PLAYLIST_ID_FLOOR = 80

/** The station's wall clock: all per-date rows are split on this zone. */
export const STATION_TZ = 'America/New_York'

// ---- visibility / status sets (viewEvent, calendar, ICS, clash check) ----

/** Shown on the public calendar with the public or private projection. */
export const PUBLIC_STATUSES: readonly PublicStatus[] = ['approved', 'built', 'live', 'ended']
/** Everything the public calendar shows (PUBLIC_STATUSES + pending). */
export const CALENDAR_STATUSES: readonly EventStatus[] = ['pending', 'approved', 'built', 'live', 'ended']
/** Hold a slot: no overlap and EVENTS gap between any two of these. */
export const SLOT_HOLDING_STATUSES: readonly EventStatus[] = ['pending', 'approved', 'built', 'live']
/** Terminal: never change again. */
export const TERMINAL_STATUSES: readonly EventStatus[] = ['ended', 'denied', 'withdrawn', 'cancelled', 'expired', 'failed']
/** Member-visible only to owner/staff. */
export const HIDDEN_STATUSES: readonly EventStatus[] = ['draft', 'denied', 'withdrawn', 'cancelled', 'expired', 'failed']

export const PRIVATE_LABEL = 'Booked · Private event' as const
export const PENDING_LABEL = 'Pending' as const
/** Main playlist name for a private event (paths.ts mainName). */
export const PRIVATE_PLAYLIST_NAME = 'Private event' as const

// ---- event_audio ----

/** Count toward the per-user in-flight cap (uploads/caps.ts). */
export const AUDIO_INFLIGHT_STATUSES: readonly AudioStatus[] = ['probing', 'ready', 'ingesting']
/** May be attached to an event. */
export const AUDIO_USABLE_STATUSES: readonly AudioStatus[] = ['ready', 'live']

// ---- playlist builder / compile ----

export const EVERY_MIN_OPTIONS: readonly EveryMin[] = [15, 20, 30, 60]
/** `at` announcements and pins sit on a 5-minute grid. */
export const ANNOUNCE_GRID_MIN = 5
/** A pinned song's window: [pin, min(pin + 15 min, end)]; pins after end − 15 min are refused. */
export const PIN_WINDOW_MIN = 15
/** An announcement row spans [t, t + duration + 60 s]. */
export const ANNOUNCE_TAIL_S = 60
/** AzuraCast's nightly restart (ET): pins/announcements refused, events warned. */
export const NIGHTLY_RESTART_ET = { from: '01:55', until: '02:05' } as const
/** Hard ceiling on the event title part of the main playlist name. */
export const MAIN_NAME_MAX = 60

// ---- field limits (api.ts, schema.ts) ----

export const TITLE_MAX = 80
export const HOST_NAME_MAX = 80
export const DESCRIPTION_MAX = 2000
export const LOCATION_MAX = 120
export const REASON_MAX = 1000
export const AUDIO_TITLE_MAX = 120
export const AUDIO_ARTIST_MAX = 120
/** Upper bound on tracks per event in a request body (the row cap is a setting). */
export const TRACKS_MAX = 500
export const ANNOUNCEMENTS_MAX = 100

// ---- timing (worker) ----

export const START_KICK_DELAY_S = 5
export const START_KICK_RETRY_S = 30
/**
 * After every POST /backend/restart the worker confirms GET /status
 * backend_running: a read every RESTART_CONFIRM_POLL_S (each with a
 * RESTART_CONFIRM_STATUS_TIMEOUT_S timeout), until consecutive running reads
 * span RESTART_CONFIRM_SPAN_S (supervisord may briefly report a process that
 * is about to exit on a config it cannot parse), for at most
 * RESTART_CONFIRM_MAX_S of elapsed time. Bounded: never a restart loop.
 */
export const RESTART_CONFIRM_POLL_S = 3
export const RESTART_CONFIRM_MAX_S = 40
export const RESTART_CONFIRM_SPAN_S = 12
export const RESTART_CONFIRM_STATUS_TIMEOUT_S = 5
export const RECHECK_BEFORE_MIN = 60
export const PLAYLIST_DELETE_AFTER_H = 24
export const PENDING_EXPIRE_BEFORE_START_H = 12
export const PENDING_REMINDER_AFTER_D = 3
export const STINGER_SYNC_EVERY_H = 6
/** Events ingests: ≥ 90 s after the music worker's last upload, ≤ 4 per hour. */
export const EVENTS_INGEST_SPACING_S = 90
export const EVENTS_INGEST_PER_HOUR = 4
/**
 * Shortest custom audio per kind. Songs keep the music portal's 30 s; short
 * announcements are allowed from 3 s. The events probe runs with
 * PROBE_MIN_DURATION_S=3 (src/probe/min-duration.ts) and the worker's
 * audio_collect rejects a song under 30 s after its probe.
 */
export const EVENTS_SONG_MIN_DURATION_S = 30
export const EVENTS_ANNOUNCEMENT_MIN_DURATION_S = 3

// ---- API ----

export const CALENDAR_MAX_WINDOW_DAYS = 400
export const STATION_LISTEN_URL = 'https://euphoric.fm/listen/event/radio.mp3'
export const NOWPLAYING_URL = 'https://euphoric.fm/api/nowplaying/event'

// ---- tickets (outbound only in v1) ----

export const TICKET_CATEGORY_KEY = 'eventrequest'
export const ticketExternalRef = (eventId: number) => `event:${eventId}`

// ---- time-zone toggle ----

export const TZ_COOKIE = 'efm_tz'
export const TZ_VALUES = ['et', 'local'] as const
export type TzChoice = (typeof TZ_VALUES)[number]
