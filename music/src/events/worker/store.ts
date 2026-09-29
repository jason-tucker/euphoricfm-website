// The events worker's data access, as an interface: store-pg.ts is the
// Postgres implementation (Drizzle over the contract tables); the unit tests
// run every job handler against an in-memory implementation.

import type { EventJobKind, EventJobPayload } from '../contract/jobs'
import type { EventsSettings } from '../contract/settings'
import type { AudioStatus, BuildStatus, EventStatus, RegistryRole } from '../contract/types'

export type EventRow = {
  id: number
  ownerUserId: string
  ownerDiscordId: string
  title: string
  eventType: string
  visibility: 'public' | 'private'
  status: EventStatus
  startsAt: Date
  endsAt: Date
  playlistOrder: 'shuffle' | 'sequential'
  shortNotice: boolean
  createdByStaff: boolean
  submittedAt: Date | null
  ticketId: number | null
  ticketNumber: number | null
  ticketUrl: string | null
  version: number
}

export type TrackRow = { position: number; source: 'library' | 'upload'; mediaId: number | null; audioId: number | null; pinAt: Date | null }

export type AnnouncementRow = {
  id: number
  source: 'stinger' | 'upload'
  mediaId: number | null
  audioId: number | null
  mode: 'at' | 'every'
  at: Date | null
  everyMin: number | null
  fromAt: Date | null
  untilAt: Date | null
}

export type AudioRow = {
  id: number
  ownerUserId: string
  ownerDiscordId: string
  uploadId: string | null
  kind: 'song' | 'announcement'
  title: string
  artist: string | null
  durationS: number | null
  status: AudioStatus
  probeSha256: string | null
  transcodeKbps: number | null
  inputFormat: string | null
  mediaId: number | null
  uniqueId: string | null
  path: string | null
  lastError: string | null
  deletedAt: Date | null
  usedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type BuildRow = { id: number; eventId: number; version: number; plan: unknown; status: BuildStatus; lastError: string | null; createdAt: Date; updatedAt: Date }

export type RegistryRow = {
  id: number
  eventId: number
  buildId: number
  role: RegistryRole
  intentName: string
  playlistId: number | null
  scheduleIds: number[]
  deletedAt: Date | null
}

export type CreateAttemptMarker = { eventId: number; buildId: number; name: string; maxIdBefore: number }

export type StingerRow = { mediaId: number; path: string; title: string; lengthS: number }

export type ClaimedJob = { id: number; kind: string; payload: unknown; attempts: number; maxAttempts: number; ageS: number }

export type JobOutcome =
  | { status: 'done' }
  | { status: 'dead'; error: string }
  // requeue; refund = the attempt claimJob spent is given back (a Wait)
  | { status: 'queued'; error: string; delayS: number; refund: boolean }

export type EnqueueOpts = { dedupeKey?: string | null; dedupeExtra?: string | number; runAfter?: Date; maxAttempts?: number }

export type AudioPatch = Partial<Pick<AudioRow, 'status' | 'durationS' | 'probeSha256' | 'transcodeKbps' | 'inputFormat' | 'mediaId' | 'uniqueId' | 'path' | 'lastError' | 'deletedAt'>>

export interface EventsStore {
  // ---- jobs
  claimJob(mutatingKinds: readonly string[]): Promise<ClaimedJob | null>
  finishJob(id: number, outcome: JobOutcome): Promise<void>
  enqueue<K extends EventJobKind>(kind: K, payload: EventJobPayload<K>, opts?: EnqueueOpts): Promise<void>
  // Queued jobs of these kinds for the event run now (a ticket just opened).
  wakeEventJobs(eventId: number, kinds: readonly EventJobKind[]): Promise<void>
  // Whether a job of `kind` for the event exists in any state.
  hasEventJob(kind: EventJobKind, eventId: number): Promise<boolean>

  // ---- settings / pause
  settings(): Promise<EventsSettings>
  queuesPaused(): Promise<boolean>
  scanOffsetS(): Promise<number>

  // ---- events
  getEvent(id: number): Promise<EventRow | null>
  // Conditional status change; true when the row moved.
  setEventStatus(id: number, from: readonly EventStatus[], to: EventStatus): Promise<boolean>
  setTicket(id: number, t: { ticketId: number; ticketNumber: number; ticketUrl: string }): Promise<void>
  tracks(eventId: number): Promise<TrackRow[]>
  announcements(eventId: number): Promise<AnnouncementRow[]>
  // A built/live event (other than `eventId`) starting in [fromMs, toMs).
  eventStartingBetween(eventId: number, fromMs: number, toMs: number): Promise<EventRow | null>
  eventsByStatus(status: EventStatus, limit: number): Promise<EventRow[]>

  // ---- audio
  getAudio(id: number): Promise<AudioRow | null>
  audioByStatus(status: AudioStatus, limit: number): Promise<AudioRow[]>
  // Conditional update; true when the row matched (status ∈ whereStatus).
  updateAudio(id: number, patch: AudioPatch, whereStatus?: readonly AudioStatus[]): Promise<boolean>
  // Staging accounting on the upload row (only while 'attached').
  setUploadLength(uploadId: string, bytes: number): Promise<void>
  expireUpload(uploadId: string): Promise<void>
  // Referenced by any approved/built/live event (tracks or announcements).
  audioInActiveEvent(audioId: number): Promise<boolean>
  unusedAudio(createdBefore: Date, limit: number): Promise<AudioRow[]>
  // Sets deleted_at only while the row is still unused and not deleted.
  markAudioDeletedIfUnused(id: number, at: Date, reason: string): Promise<boolean>
  // A library song with the same artist and title (case-insensitive).
  libraryTagCollision(artist: string, title: string): Promise<boolean>
  // Ingest pacing inputs.
  musicLastUploadAttemptMs(): Promise<number | null>
  eventsUploadAttemptsSince(sinceMs: number): Promise<number[]>
  recordUploadAttempt(audioId: number, path: string): Promise<void>

  // ---- stingers
  stinger(mediaId: number): Promise<StingerRow | null>
  replaceStingers(rows: readonly StingerRow[]): Promise<void>

  // ---- builds / registry
  buildFor(eventId: number, version: number): Promise<BuildRow | null>
  getBuild(id: number): Promise<BuildRow | null>
  latestAppliedBuild(eventId: number): Promise<BuildRow | null>
  builds(eventId: number): Promise<BuildRow[]>
  createBuild(eventId: number, version: number, plan: unknown): Promise<BuildRow>
  setBuild(id: number, patch: { status?: BuildStatus; lastError?: string | null; plan?: unknown }): Promise<void>
  setBuildsStatus(eventId: number, from: readonly BuildStatus[], to: BuildStatus): Promise<void>
  // This event's live registry rows (deleted_at null).
  registry(eventId: number): Promise<RegistryRow[]>
  insertIntent(eventId: number, buildId: number, role: RegistryRole, intentName: string): Promise<RegistryRow>
  setRegistryPlaylist(rowId: number, playlistId: number, scheduleIds: number[]): Promise<void>
  markRegistryDeleted(rowId: number): Promise<void>
  // Every playlist id any registry row ever recorded (deleted rows too).
  everRegisteredPlaylistIds(): Promise<Set<number>>
  // Create-attempt marker of an intent row, committed right before its
  // POST /playlists: which build tried it and the highest station-14
  // playlist id that existed just before (AzuraCast ids only grow). The
  // only proof an orphan adoption accepts (build.ts).
  markCreateAttempt(rowId: number, marker: CreateAttemptMarker): Promise<void>
  createAttempt(rowId: number): Promise<CreateAttemptMarker | null>
  // Live registry playlist ids split by their event's status.
  registryIdsByActivity(): Promise<{ active: Set<number>; inactive: Set<number> }>
  // Serializes station-14 membership writes (pg_advisory_xact_lock).
  withMembershipLock<T>(fn: () => Promise<T>): Promise<T>

  audit(action: string, targetType: string, targetId: number, detail?: Record<string, unknown>): Promise<void>
  // When the last successful start kick of this event happened (audit log).
  lastStartKickMs(eventId: number): Promise<number | null>
}
