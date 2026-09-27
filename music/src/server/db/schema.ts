// music-db schema (plan §3.1). Runtime applies the committed SQL migrations in
// ./drizzle (generated from this file, plus the hand-written append-only
// trigger migration). Web and worker connect as the non-owner `music_app`
// role, so they cannot ALTER/DISABLE the audit_log trigger or TRUNCATE.

import { sql } from 'drizzle-orm'
import {
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
    // converted it to the 320 kbps MP3 that is now the item's source. Null
    // for items probed before v0.3.0 (all MP3).
    inputFormat: text('input_format'),
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
  },
  (t) => [index('uploads_owner_status_idx').on(t.ownerUserId, t.status)],
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
  },
  (t) => [index('art_uploads_owner_idx').on(t.owner), index('art_uploads_status_idx').on(t.status, t.createdAt)],
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
