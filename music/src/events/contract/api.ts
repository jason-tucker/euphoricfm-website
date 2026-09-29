// EFM Events Portal — zod schemas for every /api/ev request and response
// (contract "API"). Route handlers (A) parse requests with these; the UI (B)
// may parse responses with them. Errors are always `{ error: code }`.
//
// Schemas validate SHAPE and field limits only. Business rules (notice,
// clashes, ownership, re-approval) live in the events server state machine.

import { z } from 'zod'
import {
  ANNOUNCEMENTS_MAX,
  AUDIO_ARTIST_MAX,
  AUDIO_TITLE_MAX,
  DESCRIPTION_MAX,
  HOST_NAME_MAX,
  LOCATION_MAX,
  PENDING_LABEL,
  PRIVATE_LABEL,
  REASON_MAX,
  TITLE_MAX,
  TRACKS_MAX,
} from './rules'
import { EventsSettingsPatchSchema, EventsSettingsSchema } from './settings'
import {
  ANNOUNCEMENT_MODES,
  ANNOUNCEMENT_SOURCES,
  AUDIO_KINDS,
  AUDIO_STATUSES,
  EVENT_STATUSES,
  EVENT_TYPES,
  PLAYLIST_ORDERS,
  TRACK_SOURCES,
  VISIBILITIES,
} from './types'

// ------------------------------------------------------------ primitives

const CONTROL_EXCEPT_NL_TAB = /[\p{Cc}\p{Cf}\u2028\u2029]/u

/** One-line text: trimmed, no control/format/bidi characters. */
export const singleLine = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= min && s.length <= max, `length ${min}-${max}`)
    .refine((s) => !CONTROL_EXCEPT_NL_TAB.test(s), 'control characters')

/** Multi-line text: trimmed, newlines and tabs allowed, other controls refused. */
export const multiLine = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\r\n?/g, '\n'))
    .refine((s) => s.length >= min && s.length <= max, `length ${min}-${max}`)
    .refine((s) => !CONTROL_EXCEPT_NL_TAB.test(s.replace(/[\n\t]/g, '')), 'control characters')

/** Optional text: '' / whitespace-only becomes null. */
const nullableText = (inner: z.ZodType<string>) =>
  z.union([z.null(), z.string()]).transform((v, ctx) => {
    if (v === null || v.trim() === '') return null
    const r = inner.safeParse(v)
    if (!r.success) {
      for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: i.message })
      return z.NEVER
    }
    return r.data
  })

/** ISO-8601 instant with an explicit offset or Z (stored and returned as UTC). */
export const IsoInstant = z.iso.datetime({ offset: true })
export const Snowflake = z.string().regex(/^\d{17,20}$/)
export const PositiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
/** Path params arrive as strings. */
export const IdParam = z.string().regex(/^[1-9]\d{0,15}$/).transform(Number)
/** IANA zone name as entered by the requester (e.g. America/New_York, UTC). */
export const IanaTz = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/)
export const UploadId = z.string().regex(/^[0-9a-f]{32}$/)

export const EventStatusSchema = z.enum(EVENT_STATUSES)
export const VisibilitySchema = z.enum(VISIBILITIES)
export const PlaylistOrderSchema = z.enum(PLAYLIST_ORDERS)
export const EventTypeSchema = z.enum(EVENT_TYPES)
export const AudioKindSchema = z.enum(AUDIO_KINDS)
export const AudioStatusSchema = z.enum(AUDIO_STATUSES)
export const EveryMinSchema = z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(60)])
const PublicStatusSchema = z.enum(['approved', 'built', 'live', 'ended'])

export const ErrorResponse = z.object({ error: z.string() }).passthrough()

// ------------------------------------------------------- playlist pieces

export const EventTrackSchema = z
  .object({
    position: z.number().int().min(0).max(TRACKS_MAX),
    source: z.enum(TRACK_SOURCES),
    mediaId: PositiveId.nullable(),
    audioId: PositiveId.nullable(),
    pinAt: IsoInstant.nullable(),
  })
  .strict()
  .refine((t) => (t.source === 'library' ? t.mediaId !== null && t.audioId === null : t.audioId !== null && t.mediaId === null), 'library → mediaId, upload → audioId')

export const EventAnnouncementSchema = z
  .object({
    id: PositiveId.optional(),
    source: z.enum(ANNOUNCEMENT_SOURCES),
    mediaId: PositiveId.nullable(),
    audioId: PositiveId.nullable(),
    mode: z.enum(ANNOUNCEMENT_MODES),
    at: IsoInstant.nullable(),
    everyMin: EveryMinSchema.nullable(),
    from: IsoInstant.nullable(),
    until: IsoInstant.nullable(),
  })
  .strict()
  .refine((a) => (a.source === 'stinger' ? a.mediaId !== null && a.audioId === null : a.audioId !== null && a.mediaId === null), 'stinger → mediaId, upload → audioId')
  .refine(
    (a) =>
      a.mode === 'at'
        ? a.at !== null && a.everyMin === null && a.from === null && a.until === null
        : a.at === null && a.everyMin !== null && a.from !== null && a.until !== null && Date.parse(a.until) > Date.parse(a.from),
    'at → at; every → everyMin + from < until',
  )

// ------------------------------------------------------------ event views

const base = { id: PositiveId, startsAt: IsoInstant, endsAt: IsoInstant }

export const PublicEventViewSchema = z.object({
  kind: z.literal('public'),
  ...base,
  status: PublicStatusSchema,
  title: z.string(),
  hostName: z.string().nullable(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  eventType: EventTypeSchema,
})
export const PrivateEventViewSchema = z.object({ kind: z.literal('private'), ...base, status: PublicStatusSchema, label: z.literal(PRIVATE_LABEL) })
export const PendingEventViewSchema = z.object({ kind: z.literal('pending'), ...base, status: z.literal('pending'), label: z.literal(PENDING_LABEL) })
export const FullEventViewSchema = z.object({
  kind: z.literal('full'),
  ...base,
  ownerDiscordId: Snowflake,
  status: EventStatusSchema,
  visibility: VisibilitySchema,
  title: z.string(),
  hostName: z.string().nullable(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  eventType: EventTypeSchema,
  shortNotice: z.boolean(),
  playlistOrder: PlaylistOrderSchema,
  tracks: z.array(EventTrackSchema),
  announcements: z.array(EventAnnouncementSchema),
  ticketUrl: z.string().nullable(),
  freezeAt: IsoInstant,
  canEdit: z.boolean(),
  buildStatus: z.string().nullable(),
})
export const EventViewSchema = z.discriminatedUnion('kind', [PublicEventViewSchema, PrivateEventViewSchema, PendingEventViewSchema, FullEventViewSchema])

// ------------------------------------------------------------ public reads

// GET /api/ev/config
export const ConfigResponse = z.object({
  eventsEnabled: z.boolean(),
  uploadsEnabled: z.boolean(),
  autobuildEnabled: z.boolean(),
  minNoticeH: z.number().int(),
  warnNoticeH: z.number().int(),
  memberMaxHours: z.number().int(),
  horizonDays: z.number().int(),
  maxPending: z.number().int(),
  maxUpcoming: z.number().int(),
  gapMin: z.number().int(),
  freezeMin: z.number().int(),
  maxRows: z.number().int(),
  audioMaxItems: z.number().int(),
  endWaitS: z.number().int(),
  caps: z.object({ mp3Bytes: z.number().int(), wavBytes: z.number().int(), maxDurationS: z.number().int(), minDurationS: z.number().int() }),
  stationListenUrl: z.literal('https://euphoric.fm/listen/event/radio.mp3'),
  nowPlayingUrl: z.literal('https://euphoric.fm/api/nowplaying/event'),
})

// GET /api/ev/me
export const MeResponse = z.discriminatedUnion('signedIn', [
  z.object({ signedIn: z.literal(false) }),
  z.object({
    signedIn: z.literal(true),
    userId: z.string(),
    discordId: Snowflake,
    name: z.string(),
    avatarUrl: z.string().nullable(),
    perms: z.object({ review: z.boolean(), manage: z.boolean(), admin: z.boolean() }),
  }),
])

// GET /api/ev/calendar?from&to (≤ CALENDAR_MAX_WINDOW_DAYS), GET /api/ev/availability?from&to
export const RangeQuery = z
  .object({ from: IsoInstant, to: IsoInstant })
  .refine((q) => Date.parse(q.to) > Date.parse(q.from), 'to must be after from')
export const CalendarQuery = RangeQuery
export const CalendarResponse = z.array(EventViewSchema)

// GET /api/ev/events/:id
export const EventResponse = EventViewSchema

// GET /api/ev/availability — busy intervals; `gap` rows are the padding
// around an event (events_gap_min) that a new event may not overlap either.
export const AvailabilityQuery = RangeQuery
export const AvailabilityRow = z.object({ startsAt: IsoInstant, endsAt: IsoInstant, kind: z.enum(['event', 'gap']) })
export const AvailabilityResponse = z.array(AvailabilityRow)

// ------------------------------------------------------------ member writes

const eventFields = {
  title: singleLine(1, TITLE_MAX),
  hostName: nullableText(singleLine(1, HOST_NAME_MAX)),
  description: nullableText(multiLine(1, DESCRIPTION_MAX)),
  location: nullableText(singleLine(1, LOCATION_MAX)),
  eventType: EventTypeSchema,
  startsAt: IsoInstant,
  endsAt: IsoInstant,
  enteredTz: IanaTz,
  visibility: VisibilitySchema,
  playlistOrder: PlaylistOrderSchema,
}

const endsAfterStart = (o: { startsAt?: string; endsAt?: string }) =>
  o.startsAt === undefined || o.endsAt === undefined || Date.parse(o.endsAt) > Date.parse(o.startsAt)

// POST /api/ev/events → { event: EventView(full) }
export const CreateEventRequest = z.object(eventFields).strict().refine(endsAfterStart, 'endsAt must be after startsAt')
export type CreateEventRequest = z.infer<typeof CreateEventRequest>

// PATCH /api/ev/events/:id — any subset of the create fields. `version`
// (optional) is the edit-conflict guard: when sent it must equal the row's.
export const PatchEventRequest = z
  .object({ ...eventFields, version: z.number().int().positive() })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).some((k) => k !== 'version'), 'empty patch')
  .refine(endsAfterStart, 'endsAt must be after startsAt')
export type PatchEventRequest = z.infer<typeof PatchEventRequest>

// PUT /api/ev/events/:id/playlist
export const PutPlaylistRequest = z
  .object({
    tracks: z.array(EventTrackSchema).max(TRACKS_MAX),
    announcements: z.array(EventAnnouncementSchema).max(ANNOUNCEMENTS_MAX),
    playlistOrder: PlaylistOrderSchema,
  })
  .strict()
  .refine((p) => new Set(p.tracks.map((t) => t.position)).size === p.tracks.length, 'duplicate track positions')
export type PutPlaylistRequest = z.infer<typeof PutPlaylistRequest>

// Every event mutation responds with the updated full view.
export const EventMutationResponse = z.object({ event: FullEventViewSchema })

// POST submit / withdraw / approve / build-now: no body (or {}).
export const EmptyRequest = z.object({}).strict()
// POST deny / cancel
export const ReasonRequest = z.object({ reason: multiLine(1, REASON_MAX) }).strict()
export const DenyRequest = ReasonRequest
export const CancelRequest = ReasonRequest
// POST build-now
export const BuildNowResponse = z.object({ queued: z.boolean() })

// POST /api/ev/staff/book — direct booking (approved, created_by_staff).
// ownerDiscordId: book on behalf of a member (else the staff member owns it).
// openTicket: open an `eventrequest` ticket for it (default false).
export const StaffBookRequest = z
  .object({ ...eventFields, ownerDiscordId: Snowflake.optional(), openTicket: z.boolean().default(false) })
  .strict()
  .refine(endsAfterStart, 'endsAt must be after startsAt')
export type StaffBookRequest = z.infer<typeof StaffBookRequest>

// GET /api/ev/my/events
export const MyEventsResponse = z.array(FullEventViewSchema)

// GET /api/ev/staff/queue
export const StaffQueueResponse = z.object({ pending: z.array(FullEventViewSchema), upcoming: z.array(FullEventViewSchema) })

// ------------------------------------------------------------ library / stingers

// GET /api/ev/library?q
export const LibraryQuery = z.object({ q: singleLine(0, 100).default('') })
export const LibraryRow = z.object({ mediaId: PositiveId, title: z.string(), artist: z.string().nullable(), lengthS: z.number().int().nullable(), artUrl: z.string().nullable() })
export const LibraryResponse = z.array(LibraryRow)

// GET /api/ev/stingers
export const StingerRow = z.object({ mediaId: PositiveId, path: z.string(), title: z.string(), lengthS: z.number().int() })
export const StingersResponse = z.array(StingerRow)

// ------------------------------------------------------------ my audio

// POST /api/ev/audio
export const CreateAudioRequest = z
  .object({ uploadId: UploadId, kind: AudioKindSchema, title: singleLine(1, AUDIO_TITLE_MAX), artist: nullableText(singleLine(1, AUDIO_ARTIST_MAX)).optional() })
  .strict()
export type CreateAudioRequest = z.infer<typeof CreateAudioRequest>

// GET /api/ev/audio → AudioRow[]; POST → { audio: AudioRow }; DELETE → { deleted: true }
// expiresAt: when an unused item will be swept (events_audio_unused_days), null once used.
export const AudioRow = z.object({
  id: PositiveId,
  kind: AudioKindSchema,
  title: z.string(),
  artist: z.string().nullable(),
  durationS: z.number().int().nullable(),
  status: AudioStatusSchema,
  lastError: z.string().nullable(),
  usedAt: IsoInstant.nullable(),
  expiresAt: IsoInstant.nullable(),
  createdAt: IsoInstant,
})
export const AudioListResponse = z.array(AudioRow)
export const AudioCreateResponse = z.object({ audio: AudioRow })
export const AudioDeleteResponse = z.object({ deleted: z.literal(true) })
// GET /api/ev/audio/:id/preview → { url } (signed, viewer-bound, existing media signing)
export const AudioPreviewResponse = z.object({ url: z.string() })

// ------------------------------------------------------------ admin settings

// GET /api/ev/admin/settings → full object; PUT with a strict partial patch → full object.
export const AdminSettingsResponse = EventsSettingsSchema
export const AdminSettingsPatchRequest = EventsSettingsPatchSchema
