// music-db schema (plan §3.1). Runtime applies the committed SQL migrations in
// ./drizzle (generated from this file, plus the hand-written append-only
// trigger migration). Web and worker connect as the non-owner `music_app`
// role, so they cannot ALTER/DISABLE the audit_log trigger or TRUNCATE.

import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  AUDIO_KINDS,
  AUDIO_STATUSES,
  BUILD_STATUSES,
  EVENT_STATUSES,
  EVENT_TYPES,
  PLAYLIST_ORDERS,
  REGISTRY_ROLES,
  VISIBILITIES,
} from '../../events/contract/types'

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

// ------------------------------------------------------- Auth.js tables ---
// Column names follow @auth/drizzle-adapter's expectations. discord_id is our
// addition: the provider's profile() returns it, createUser persists it.

export const users = pgTable('user', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email'),
  emailVerified: ts('emailVerified'),
  image: text('image'),
  discordId: text('discord_id').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
})

// access_token / refresh_token hold AES-256-GCM envelopes (src/server/auth/tokens.ts).
export const accounts = pgTable(
  'account',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
)

export const sessions = pgTable(
  'session',
  {
    sessionToken: text('sessionToken').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: ts('expires').notNull(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
)

export const verificationTokens = pgTable(
  'verificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: ts('expires').notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

// ------------------------------------------------------------ membership ---

export const memberCache = pgTable('member_cache', {
  discordId: text('discord_id').primaryKey(),
  member: boolean('member').notNull(),
  pending: boolean('pending').notNull().default(false),
  roleIds: text('role_ids').array().notNull().default(sql`'{}'::text[]`),
  source: text('source').notNull(), // 'discord' | 'tickets'
  checkedAt: ts('checked_at').notNull(),
})

export const permissionEnum = pgEnum('role_permission', ['review', 'manage'])

export const roleBindings = pgTable(
  'role_bindings',
  {
    id: serial('id').primaryKey(),
    roleId: text('role_id').notNull(),
    permission: permissionEnum('permission').notNull(),
    note: text('note'),
    createdBy: text('created_by'), // discord id, or 'seed'
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('role_bindings_role_perm').on(t.roleId, t.permission)],
)

// Runtime config. station_id is deliberately NOT here (worker env only).
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: text('updated_by'),
})

// --------------------------------------------------------------- library ---

export const artistStatusEnum = pgEnum('artist_status', ['active', 'pending', 'denied', 'archived'])

export const artists = pgTable(
  'artists',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    folder: text('folder').notNull(), // verbatim folder name under Music/Artists/
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    status: artistStatusEnum('status').notNull().default('pending'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('artists_folder_uq').on(t.folder)],
)

export const libraryCache = pgTable(
  'library_cache',
  {
    mediaId: integer('media_id').primaryKey(),
    uniqueId: text('unique_id').notNull(),
    path: text('path').notNull(),
    title: text('title'),
    artist: text('artist'),
    album: text('album'),
    genre: text('genre'),
    playlistIds: integer('playlist_ids').array().notNull().default(sql`'{}'::int[]`),
    lengthS: integer('length_s'),
    mtime: integer('mtime'),
    // Current album art URL (art contract 2026-09-27): AzuraCast's `art` from
    // /files, else https://euphoric.fm/api/station/<shortcode>/art/<unique_id>.
    // Populated by the library sync (P3).
    artUrl: text('art_url'),
    refreshedAt: ts('refreshed_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('library_cache_path_uq').on(t.path)],
)

// ----------------------------------------------------------- submissions ---

export const batchStatusEnum = pgEnum('batch_status', ['draft', 'submitted', 'completed', 'closed', 'withdrawn'])

export const batches = pgTable(
  'batches',
  {
    id: serial('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    status: batchStatusEnum('status').notNull().default('draft'),
    attestedAt: ts('attested_at'),
    // Version of the rights statement the submitter attested (UI setting
    // rights_attestation.version), recorded with attested_at.
    attestVersion: text('attest_version'),
    submittedAt: ts('submitted_at'),
    ticketId: integer('ticket_id'),
    ticketNumber: integer('ticket_number'),
    ticketWebUrl: text('ticket_web_url'),
    ticketChannelUrl: text('ticket_channel_url'),
    ticketStatus: text('ticket_status'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('batches_owner_idx').on(t.ownerUserId), uniqueIndex('batches_ticket_uq').on(t.ticketId)],
)

export const itemKindEnum = pgEnum('item_kind', ['song', 'new_artist'])
export const itemSourceEnum = pgEnum('item_source', ['upload', 'soundcloud'])
export const itemStatusEnum = pgEnum('item_status', [
  'probing',
  'rejected', // probe refused the file
  'draft',
  'pending',
  'approved',
  'denied',
  'withdrawn',
  'applying',
  'verifying',
  'live',
  'failed',
])

export const items = pgTable(
  'items',
  {
    id: serial('id').primaryKey(),
    batchId: integer('batch_id')
      .notNull()
      .references(() => batches.id),
    // Denormalised owner so every ownership predicate is a single-row check.
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    kind: itemKindEnum('kind').notNull().default('song'),
    source: itemSourceEnum('source').notNull().default('upload'),
    status: itemStatusEnum('status').notNull(),
    uploadId: text('upload_id'), // tus id under /staging/uploads
    probeRequestId: uuid('probe_request_id'),
    probeSha256: text('probe_sha256'),
    probeError: text('probe_error'),
    approvedSha256: text('approved_sha256'),
    finalSha256: text('final_sha256'),
    coverFile: text('cover_file'), // cover-<uuid>.jpg under /staging/uploads, written by probe
    coverSha256: text('cover_sha256'),
    // Custom album art (art_uploads.id, art contract 2026-09-27). The
    // effective cover is custom, else the embedded one above.
    customArtId: uuid('custom_art_id').references(() => artUploads.id, { onDelete: 'set null' }),
    durationS: integer('duration_s'),
    bitrate: integer('bitrate'),
    // What the member uploaded (v0.3.0): 'mp3', or 'wav' when the probe
    // converted it to the MP3 that is now the item's source. Null for items
    // probed before v0.3.0 (all MP3).
    inputFormat: text('input_format'),
    // v0.3.5: the CBR bitrate (kbps: 320 / 256 / 192) of the MP3 the probe
    // ENCODED for this item (a WAV, or an MP3 too big to fit the final-file
    // cap). Null = the member's own MP3, untouched (or a WAV probed before
    // v0.3.5, which was always 320).
    transcodeKbps: integer('transcode_kbps'),
    // v0.4.0, source 'soundcloud' only (src/server/soundcloud.ts, worker
    // soundcloud/*). The item stays 'probing' while it is fetched and then
    // converted; fetch_stage says which:
    //   'queued'     the web recorded the link and queued a soundcloud_fetch job
    //   'fetching'   the worker wrote /spool/fetch/in/<fetch_request_id>.json
    //                (fetch_requested_at = then)
    //   'converting' music-fetch answered ok; the worker wrote the probe_fetch
    //                request (probe_request_id = fetch_request_id)
    // source_url: the link as validated and rebuilt by the web, replaced by
    // music-fetch's canonicalUrl once it answered (always
    // https://soundcloud.com/<user>/<track>). fetch_license: the track's
    // SoundCloud license id, shown next to the rights attestation.
    fetchRequestId: uuid('fetch_request_id'),
    fetchStage: text('fetch_stage'),
    fetchRequestedAt: ts('fetch_requested_at'),
    sourceUrl: text('source_url'),
    fetchLicense: text('fetch_license'),
    prefill: jsonb('prefill'),
    title: text('title'),
    artist: text('artist'),
    album: text('album'),
    genre: text('genre'),
    artistId: integer('artist_id').references(() => artists.id),
    newArtistName: text('new_artist_name'),
    playlistIds: integer('playlist_ids').array(),
    targetPath: text('target_path'),
    mediaId: integer('media_id'),
    denyReason: text('deny_reason'),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    selfApproved: boolean('self_approved').notNull().default(false),
    liveAt: ts('live_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('items_batch_idx').on(t.batchId),
    index('items_owner_idx').on(t.ownerUserId),
    index('items_status_idx').on(t.status),
    uniqueIndex('items_upload_uq').on(t.uploadId),
    uniqueIndex('items_probe_req_uq').on(t.probeRequestId),
    uniqueIndex('items_fetch_req_uq').on(t.fetchRequestId),
    index('items_owner_source_idx').on(t.ownerUserId, t.source, t.createdAt),
    check('items_fetch_stage', sql`${t.fetchStage} IS NULL OR ${t.fetchStage} IN ('queued', 'fetching', 'converting')`),
  ],
)

export const requestKindEnum = pgEnum('request_kind', ['edit', 'removal'])
export const requestStatusEnum = pgEnum('request_status', [
  'pending',
  'approved',
  'denied',
  'withdrawn',
  'applying',
  'verifying',
  'done',
  'failed',
])

export const requests = pgTable(
  'requests',
  {
    id: serial('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    kind: requestKindEnum('kind').notNull(),
    mediaId: integer('media_id').notNull(),
    targetPath: text('target_path').notNull(),
    // zod-typed {title?, artist?, album?, genre?} (src/server/requests.ts)
    proposed: jsonb('proposed'),
    reason: text('reason'),
    // P4: the library metadata at filing time ({path, title, artist, album,
    // genre, playlistIds}); the ticket card and the reviewer diff use it.
    snapshot: jsonb('snapshot'),
    denyReason: text('deny_reason'),
    // Machine code of the last failure (apply / move / archive / recovery).
    error: text('error'),
    // An edit whose new main artist is unknown waits on this artist's
    // new-artist approval before anything is written.
    pendingArtistId: integer('pending_artist_id').references(() => artists.id),
    appliedAt: ts('applied_at'),
    status: requestStatusEnum('status').notNull().default('pending'),
    ticketId: integer('ticket_id'),
    ticketNumber: integer('ticket_number'),
    ticketWebUrl: text('ticket_web_url'),
    ticketChannelUrl: text('ticket_channel_url'),
    ticketStatus: text('ticket_status'),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('requests_owner_idx').on(t.ownerUserId), uniqueIndex('requests_ticket_uq').on(t.ticketId)],
)

export const visibilityEnum = pgEnum('comment_visibility', ['all', 'staff'])
export const commentSourceEnum = pgEnum('comment_source', ['portal', 'ticket'])

export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    batchId: integer('batch_id').references(() => batches.id),
    itemId: integer('item_id').references(() => items.id),
    requestId: integer('request_id').references(() => requests.id),
    authorUserId: text('author_user_id').references(() => users.id),
    authorDiscordId: text('author_discord_id'),
    authorName: text('author_name'),
    source: commentSourceEnum('source').notNull(),
    visibility: visibilityEnum('visibility').notNull(),
    body: text('body').notNull(),
    // Set for comments that arrived through the tickets webhook.
    deliveryId: text('delivery_id'),
    // Set once a portal comment has been posted into the ticket.
    ticketMessageId: text('ticket_message_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('comments_delivery_uq').on(t.deliveryId),
    index('comments_batch_idx').on(t.batchId),
    index('comments_request_idx').on(t.requestId),
    check('comments_parent', sql`(${t.batchId} IS NOT NULL) <> (${t.requestId} IS NOT NULL)`),
    // A staff comment can never be a ticket-originated comment, and it can
    // never carry a ticket message id (it is never forwarded).
    check('comments_staff_local', sql`${t.visibility} <> 'staff' OR (${t.source} = 'portal' AND ${t.ticketMessageId} IS NULL)`),
  ],
)

// Signed-webhook delivery dedupe (plan §4.5 receiver rule 3).
export const hookDeliveries = pgTable('hook_deliveries', {
  deliveryId: uuid('delivery_id').primaryKey(),
  event: text('event').notNull(),
  ticketId: integer('ticket_id'),
  receivedAt: ts('received_at').notNull().defaultNow(),
})

// ------------------------------------------------------------ uploads ---
// Server-side record of every tus upload. `owner_user_id` is set from the
// session at creation and is the ONLY ownership source (the tus .json sidecar
// lives in a web-writable dir and client Upload-Metadata is discarded).

export const uploadStatusEnum = pgEnum('upload_status', ['uploading', 'complete', 'attached', 'expired'])

export const uploads = pgTable(
  'uploads',
  {
    id: text('id').primaryKey(), // tus id, 32 hex
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    length: integer('length').notNull(),
    status: uploadStatusEnum('status').notNull().default('uploading'),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    // v0.5.0: which portal instance (PORTAL_SITE) accepted the upload. Caps,
    // sweepers and attach routes only ever see their own site's rows.
    site: text('site').notNull().default('music'),
  },
  (t) => [index('uploads_owner_status_idx').on(t.ownerUserId, t.status), check('uploads_site', sql`${t.site} IN ('music', 'events')`)],
)

// ---------------------------------------------------------- album art ---
// Standalone art uploads (art contract 2026-09-27). The web stores the raw
// bytes at raw_path (/staging/art-in/<id>, web-writable) and spools an 'art'
// request; the network-less probe re-encodes it to a baseline JPEG at
// jpeg_path (/staging/art/<id>/cover.jpg, probe-written, read-only for web
// and worker) and reports its sha256. `owner` is users.id.

export const artStatusEnum = pgEnum('art_status', ['processing', 'ready', 'rejected', 'expired'])

export const artUploads = pgTable(
  'art_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    owner: text('owner')
      .notNull()
      .references(() => users.id),
    status: artStatusEnum('status').notNull().default('processing'),
    reason: text('reason'),
    rawPath: text('raw_path'),
    rawSize: integer('raw_size'),
    jpegPath: text('jpeg_path'),
    jpegSha256: text('jpeg_sha256'),
    width: integer('width'),
    height: integer('height'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    // v0.5.0: see uploads.site.
    site: text('site').notNull().default('music'),
  },
  (t) => [
    index('art_uploads_owner_idx').on(t.owner),
    index('art_uploads_status_idx').on(t.status, t.createdAt),
    check('art_uploads_site', sql`${t.site} IN ('music', 'events')`),
  ],
)

// -------------------------------------------------------- media safety ---

export const mediaSnapshots = pgTable(
  'media_snapshots',
  {
    id: serial('id').primaryKey(),
    mediaId: integer('media_id').notNull(),
    uniqueId: text('unique_id'),
    path: text('path').notNull(),
    title: text('title'),
    artist: text('artist'),
    album: text('album'),
    genre: text('genre'),
    playlistIds: integer('playlist_ids').array().notNull().default(sql`'{}'::int[]`),
    // P4 art: whether the row had custom art (art_updated_at > 0) and, when
    // the wrapper can fetch it, the sha256 of the old art bytes.
    hadArt: boolean('had_art'),
    artSha256: text('art_sha256'),
    reason: text('reason').notNull(),
    itemId: integer('item_id').references(() => items.id),
    requestId: integer('request_id').references(() => requests.id),
    takenAt: ts('taken_at').notNull().defaultNow(),
  },
  (t) => [index('media_snapshots_media_idx').on(t.mediaId)],
)

// Ingest pipeline state, one row per approved song (plan §3.7 "ingest", P3).
// The worker advances `stage` idempotently; `uploaded_at` drives the serial
// pacing (≥ ingestSpacingS between uploads, ≤ ingestPerHour per hour).
export const ingestStageEnum = pgEnum('ingest_stage', [
  'finalize', // artist gate, then submit `finalize` to the probe
  'finalizing', // waiting for the probe result
  'ready', // final file verified; waiting for the scan window + pacing
  'uploaded', // POST /files done; playlists next
  'playlists', // playlists set; GET verify + snapshot next
  'verifying', // waiting for the post-scan re-verify
  'recovering', // row lost after a scan: polling by path
  'live',
  'failed',
])

export const ingestRuns = pgTable(
  'ingest_runs',
  {
    itemId: integer('item_id')
      .primaryKey()
      .references(() => items.id),
    stage: ingestStageEnum('stage').notNull().default('finalize'),
    finalizeRequestId: uuid('finalize_request_id'),
    finalizeRequestedAt: ts('finalize_requested_at'),
    finalFile: text('final_file'), // <uuid>.mp3 under /staging/final
    finalRemovedAt: ts('final_removed_at'),
    playlistIds: integer('playlist_ids').array().notNull().default(sql`'{}'::int[]`),
    // Reserved right before the POST (after the window and pause checks),
    // together with upload_attempted_at (DB clock). A retry adopts the media
    // row at this path only when it is provably this run's upload
    // (pipeline.ts ownUpload). While the run is active no other run may
    // reserve the same path (partial unique index below).
    targetPath: text('target_path'),
    uploadAttemptedAt: ts('upload_attempted_at'),
    mediaId: integer('media_id'),
    uniqueId: text('unique_id'),
    uploadedAt: ts('uploaded_at'),
    verifyDueAt: ts('verify_due_at'),
    repairs: integer('repairs').notNull().default(0),
    recoveryPolls: integer('recovery_polls').notNull().default(0),
    recoveryStartedAt: ts('recovery_started_at'),
    recoveries: integer('recoveries').notNull().default(0),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('ingest_runs_uploaded_idx').on(t.uploadedAt),
    index('ingest_runs_stage_idx').on(t.stage),
    uniqueIndex('ingest_runs_target_path_active_uq')
      .on(t.targetPath)
      .where(sql`${t.targetPath} IS NOT NULL AND ${t.stage} NOT IN ('live', 'failed')`),
  ],
)

// 'archiving' is written (with the before_archive snapshot) BEFORE the first
// AzuraCast write and 'restoring' before the restore move, so a re-run after
// a crash or a lost response resumes from the recorded state instead of
// snapshotting a half-done one (requests/jobs.ts archiveMedia/restoreMedia).
export const archiveStatusEnum = pgEnum('archive_status', ['archiving', 'archived', 'restoring', 'restored', 'failed'])
// v0.3.6: where an archived song came from. 'portal': a removal request or a
// manager's archive of a library song (restore puts it back where it was).
// 'legacy_unreleased': imported from the pre-portal UNRELEASED folder
// (requests/legacy.ts); restoring one RELEASES it into Music/Artists/<folder>/
// (the manager picks the artist and the playlists), never back to UNRELEASED.
export const archiveOriginEnum = pgEnum('archive_origin', ['portal', 'legacy_unreleased'])

export const archive = pgTable(
  'archive',
  {
    id: serial('id').primaryKey(),
    mediaId: integer('media_id').notNull(),
    uniqueId: text('unique_id'),
    originalPath: text('original_path').notNull(),
    archivedPath: text('archived_path').notNull(),
    snapshotId: integer('snapshot_id').references(() => mediaSnapshots.id),
    requestId: integer('request_id').references(() => requests.id),
    origin: archiveOriginEnum('origin').notNull().default('portal'),
    // Why it was archived, when a manager said (their archive reason); a
    // removal request's reason stays on the request.
    reason: text('reason'),
    // A member a manager linked to this archived song (v0.3.6): besides the
    // portal uploader (items → batch owner of the media id), the only member
    // who may see it on the Archived songs page. Audited (archive.link).
    linkedUserId: text('linked_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Release of a legacy row (origin 'legacy_unreleased'), set by the
    // manager's Release: the artist whose folder it goes to and the playlists
    // chosen explicitly. restore_path is the exact target the worker picked
    // (the name, or ' (n)' on a collision), written BEFORE its first write.
    releaseArtistId: integer('release_artist_id').references(() => artists.id),
    releasePlaylistIds: integer('release_playlist_ids').array(),
    restorePath: text('restore_path'),
    status: archiveStatusEnum('status').notNull().default('archived'),
    archivedAt: ts('archived_at').notNull().defaultNow(),
    restoredAt: ts('restored_at'),
    // Set on every status write (and when a re-run resumes the row): an
    // 'archiving' / 'restoring' row that has not moved for a while and has
    // no live job is finished or rolled back by the reconciler
    // (requests/jobs.ts reconcileArchive).
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('archive_media_idx').on(t.mediaId),
    index('archive_linked_user_idx').on(t.linkedUserId),
    // At most one open (archiving / archived / restoring) row per media id.
    uniqueIndex('archive_media_open_uq')
      .on(t.mediaId)
      .where(sql`${t.status} NOT IN ('restored', 'failed')`),
  ],
)

export const jobStatusEnum = pgEnum('job_status', ['queued', 'running', 'done', 'failed', 'dead'])

export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: jobStatusEnum('status').notNull().default('queued'),
    runAfter: ts('run_after').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    lockedAt: ts('locked_at'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('jobs_ready_idx').on(t.status, t.runAfter),
    uniqueIndex('jobs_dedupe_uq').on(t.dedupeKey),
  ],
)

// Append-only; UPDATE/DELETE/TRUNCATE are refused by trigger (migration 0001).
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    actorUserId: text('actor_user_id'),
    actorDiscordId: text('actor_discord_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    detail: jsonb('detail'),
    ip: text('ip'),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_target_idx').on(t.targetType, t.targetId)],
)

// ------------------------------------------------------ events (v0.5.0) ---
// EFM Events Portal (events.euphoric.fm; contract "Tables", plan §3). Written
// by events-web and the events worker only; the music services never touch
// these tables except worker/library/sync.ts, which reads
// event_registry.playlist_id to keep event playlists foreign.

const inList = (col: unknown, values: readonly string[]) => sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    ownerDiscordId: text('owner_discord_id').notNull(),
    title: text('title').notNull(),
    hostName: text('host_name'),
    description: text('description'),
    location: text('location'),
    eventType: text('event_type').notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    enteredTz: text('entered_tz').notNull(),
    visibility: text('visibility').notNull(),
    status: text('status').notNull(),
    shortNotice: boolean('short_notice').notNull().default(false),
    playlistOrder: text('playlist_order').notNull().default('shuffle'),
    ticketId: integer('ticket_id'),
    ticketNumber: integer('ticket_number'),
    ticketUrl: text('ticket_url'),
    createdByStaff: boolean('created_by_staff').notNull().default(false),
    submittedAt: ts('submitted_at'),
    decidedAt: ts('decided_at'),
    decidedBy: text('decided_by'),
    denyReason: text('deny_reason'),
    // Bumped on every content edit; builds and their dedupe keys carry it.
    version: integer('version').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('events_status_starts_idx').on(t.status, t.startsAt),
    index('events_owner_status_idx').on(t.ownerUserId, t.status),
    check('events_ends_after_starts', sql`${t.endsAt} > ${t.startsAt}`),
    check('events_title_len', sql`char_length(${t.title}) BETWEEN 1 AND 80`),
    check('events_host_name_len', sql`${t.hostName} IS NULL OR char_length(${t.hostName}) <= 80`),
    check('events_description_len', sql`${t.description} IS NULL OR char_length(${t.description}) <= 2000`),
    check('events_location_len', sql`${t.location} IS NULL OR char_length(${t.location}) <= 120`),
    check('events_status', inList(t.status, EVENT_STATUSES)),
    check('events_visibility', inList(t.visibility, VISIBILITIES)),
    check('events_playlist_order', inList(t.playlistOrder, PLAYLIST_ORDERS)),
    check('events_event_type', inList(t.eventType, EVENT_TYPES)),
  ],
)

// A member's reusable custom audio (My audio). Lifecycle: probing → ready →
// ingesting → live (rejected / failed); deleted_at is the owner/staff delete.
export const eventAudio = pgTable(
  'event_audio',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id),
    ownerDiscordId: text('owner_discord_id').notNull(),
    uploadId: text('upload_id').references(() => uploads.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    artist: text('artist'),
    durationS: integer('duration_s'),
    status: text('status').notNull(),
    probeSha256: text('probe_sha256'),
    transcodeKbps: integer('transcode_kbps'),
    inputFormat: text('input_format'),
    mediaId: integer('media_id'),
    uniqueId: text('unique_id'),
    path: text('path'),
    lastError: text('last_error'),
    deletedAt: ts('deleted_at'),
    // Set when first attached to a submitted event (unused audio expires).
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('event_audio_owner_status_idx').on(t.ownerUserId, t.status),
    index('event_audio_status_idx').on(t.status, t.createdAt),
    check('event_audio_kind', inList(t.kind, AUDIO_KINDS)),
    check('event_audio_status', inList(t.status, AUDIO_STATUSES)),
  ],
)

export const eventTracks = pgTable(
  'event_tracks',
  {
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    source: text('source').notNull(),
    mediaId: integer('media_id'),
    audioId: bigint('audio_id', { mode: 'number' }).references(() => eventAudio.id),
    pinAt: ts('pin_at'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.position] }),
    index('event_tracks_audio_idx').on(t.audioId),
    check(
      'event_tracks_source',
      sql`(${t.source} = 'library' AND ${t.mediaId} IS NOT NULL AND ${t.audioId} IS NULL) OR (${t.source} = 'upload' AND ${t.audioId} IS NOT NULL AND ${t.mediaId} IS NULL)`,
    ),
  ],
)

export const eventAnnouncements = pgTable(
  'event_announcements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    mediaId: integer('media_id'),
    audioId: bigint('audio_id', { mode: 'number' }).references(() => eventAudio.id),
    mode: text('mode').notNull(),
    at: ts('at'),
    everyMin: integer('every_min'),
    fromAt: ts('from_at'),
    untilAt: ts('until_at'),
  },
  (t) => [
    index('event_announcements_event_idx').on(t.eventId),
    index('event_announcements_audio_idx').on(t.audioId),
    check(
      'event_announcements_source',
      sql`(${t.source} = 'stinger' AND ${t.mediaId} IS NOT NULL AND ${t.audioId} IS NULL) OR (${t.source} = 'upload' AND ${t.audioId} IS NOT NULL AND ${t.mediaId} IS NULL)`,
    ),
    check(
      'event_announcements_mode',
      sql`(${t.mode} = 'at' AND ${t.at} IS NOT NULL AND ${t.everyMin} IS NULL) OR (${t.mode} = 'every' AND ${t.everyMin} IN (15, 20, 30, 60) AND ${t.fromAt} IS NOT NULL AND ${t.untilAt} > ${t.fromAt})`,
    ),
  ],
)

// One compiled desired state per (event, version).
export const eventBuilds = pgTable(
  'event_builds',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => events.id),
    version: integer('version').notNull(),
    plan: jsonb('plan').notNull(),
    status: text('status').notNull().default('pending'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('event_builds_event_idx').on(t.eventId, t.version),
    check('event_builds_status', inList(t.status, BUILD_STATUSES)),
  ],
)

// Every AzuraCast playlist the events worker creates. The intent row is
// committed BEFORE the create (playlist_id null), then filled in. The music
// library sync treats every non-null playlist_id here as foreign.
export const eventRegistry = pgTable(
  'event_registry',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: bigint('event_id', { mode: 'number' })
      .notNull()
      .references(() => events.id),
    buildId: bigint('build_id', { mode: 'number' })
      .notNull()
      .references(() => eventBuilds.id),
    role: text('role').notNull(),
    intentName: text('intent_name').notNull(),
    playlistId: integer('playlist_id'),
    scheduleIds: integer('schedule_ids')
      .array()
      .notNull()
      .default(sql`'{}'::int[]`),
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('event_registry_event_idx').on(t.eventId),
    uniqueIndex('event_registry_playlist_uq')
      .on(t.playlistId)
      .where(sql`${t.playlistId} IS NOT NULL`),
    check('event_registry_role', inList(t.role, REGISTRY_ROLES)),
  ],
)

// Cache of `EFM Stingers/` (stinger_sync, every 6 h); the announcement
// picker reads it.
export const eventStingers = pgTable('event_stingers', {
  mediaId: integer('media_id').primaryKey(),
  path: text('path').notNull(),
  title: text('title').notNull(),
  lengthS: integer('length_s').notNull(),
  refreshedAt: ts('refreshed_at').notNull().defaultNow(),
})

// Same shape as `jobs`; claimed ONLY by the events worker.
export const eventJobs = pgTable(
  'event_jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: jobStatusEnum('status').notNull().default('queued'),
    runAfter: ts('run_after').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    lockedAt: ts('locked_at'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('event_jobs_ready_idx').on(t.status, t.runAfter),
    uniqueIndex('event_jobs_dedupe_uq').on(t.dedupeKey),
  ],
)
