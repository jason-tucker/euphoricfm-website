// My audio (event_audio): attach a finished events tus upload, list,
// delete, preview. The web owns only the first step of the lifecycle
// (contract "event_audio lifecycle"): upload complete → row `probing` +
// the probe request in the events in-web inbox. The events worker collects
// the result (ready/rejected), finalizes and ingests.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { audit } from '../../server/audit'
import { loadEventsSettings } from '../../server/admin/events-settings'
import { oneOrConflict } from '../../server/authz/transitions'
import type { DB } from '../../server/db/client'
import { eventAnnouncements, eventAudio, events, eventTracks, uploads } from '../../server/db/schema'
import { webEnv } from '../../server/env'
import { badRequest, forbidden, HttpError, notFound } from '../../server/http/errors'
import { signMediaUrl, verifyMediaSig } from '../../server/media/signing'
import { serveStagedFile } from '../../server/media/serve'
import { loadCaps } from '../../server/settings'
import { MAX_MP3_UPLOAD_BYTES, MAX_WAV_UPLOAD_BYTES, UPLOAD_ID_RE, writeSpoolRequest } from '../../server/spool/protocol'
import { enqueueEventJob } from '../enqueue'
import { probeRequestIdForUpload } from '../contract/paths'
import type { CreateAudioRequest } from '../contract/api'
import type { AudioKind, AudioStatus } from '../contract/types'
import { lockUserAudio } from './repo'
import type { Actor } from './rules'

const DAY = 86_400_000

type AudioDbRow = typeof eventAudio.$inferSelect

export function audioRowView(a: AudioDbRow, unusedDays: number) {
  return {
    id: a.id,
    kind: a.kind as AudioKind,
    title: a.title,
    artist: a.artist,
    durationS: a.durationS,
    status: a.status as AudioStatus,
    lastError: a.lastError,
    usedAt: a.usedAt ? a.usedAt.toISOString() : null,
    expiresAt: a.usedAt ? null : new Date(a.createdAt.getTime() + unusedDays * DAY).toISOString(),
    createdAt: a.createdAt.toISOString(),
  }
}

/** Rows counted against events_audio_max_items (not deleted, not failed). */
const COUNTED = sql`${eventAudio.deletedAt} IS NULL AND ${eventAudio.status} NOT IN ('rejected', 'failed')`

/** GET /api/ev/audio — own audio; staff may pass another member's user id. */
export async function listAudio(db: DB, actor: Actor, ownerUserId?: string) {
  if (ownerUserId !== undefined && ownerUserId !== actor.userId && !actor.staff) throw forbidden()
  const s = await loadEventsSettings(db)
  const rows = await db
    .select()
    .from(eventAudio)
    .where(and(eq(eventAudio.ownerUserId, ownerUserId ?? actor.userId), isNull(eventAudio.deletedAt)))
    .orderBy(desc(eventAudio.createdAt), desc(eventAudio.id))
    .limit(500)
  return rows.map((r) => audioRowView(r, s.events_audio_unused_days))
}

/** POST /api/ev/audio: attach a complete events upload and queue the probe. */
export async function createAudio(db: DB, actor: Actor, input: CreateAudioRequest, spoolInDir = webEnv().SPOOL_PROBE_IN_DIR) {
  // Ingest refuses empty tags (worker): a song needs its artist.
  if (input.kind === 'song' && !input.artist) throw badRequest('invalid_body', { issues: ['artist: required for a song'] })
  const s = await loadEventsSettings(db)
  if (!s.events_uploads_enabled && !actor.staff) throw forbidden('uploads_disabled')
  const row = await db.transaction(async (tx) => {
    await lockUserAudio(tx, actor.userId)
    const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(eventAudio).where(and(eq(eventAudio.ownerUserId, actor.userId), COUNTED))
    if (Number(c?.n ?? 0) >= s.events_audio_max_items) throw new HttpError(409, 'audio_limit', { limit: s.events_audio_max_items })
    const up = oneOrConflict(
      await tx
        .update(uploads)
        .set({ status: 'attached' })
        .where(and(eq(uploads.id, input.uploadId), eq(uploads.ownerUserId, actor.userId), eq(uploads.status, 'complete'), eq(uploads.site, 'events')))
        .returning(),
      'upload_not_available',
    )
    const [a] = await tx
      .insert(eventAudio)
      .values({ ownerUserId: actor.userId, ownerDiscordId: actor.discordId, uploadId: up.id, kind: input.kind, title: input.title, artist: input.artist ?? null, status: 'probing' })
      .returning()
    await audit(tx, { actorUserId: actor.userId, actorDiscordId: actor.discordId, action: 'events.audio.add', targetType: 'event_audio', targetId: a!.id, detail: { uploadId: up.id, kind: input.kind } })
    return { a: a!, length: up.length }
  })
  try {
    const caps = await loadCaps(db)
    await writeSpoolRequest(spoolInDir, {
      v: 1,
      id: probeRequestIdForUpload(input.uploadId),
      type: 'probe',
      upload: input.uploadId,
      expectedSize: row.length,
      maxWavBytes: Math.min(caps.maxWavUploadBytes, MAX_WAV_UPLOAD_BYTES),
      maxMp3Bytes: Math.min(caps.maxMp3UploadBytes, MAX_MP3_UPLOAD_BYTES),
    })
  } catch {
    await db.update(eventAudio).set({ status: 'failed', lastError: 'spool_unavailable', updatedAt: new Date() }).where(eq(eventAudio.id, row.a.id))
    throw new HttpError(503, 'probe_unavailable')
  }
  return audioRowView(row.a, s.events_audio_unused_days)
}

async function loadVisibleAudio(db: Pick<DB, 'select'>, actor: Actor, id: number): Promise<AudioDbRow> {
  const [a] = await db.select().from(eventAudio).where(eq(eventAudio.id, id))
  if (!a || a.deletedAt || (a.ownerUserId !== actor.userId && !actor.staff)) throw notFound()
  return a
}

/** Events still to air (or waiting for review) that use this audio. */
const IN_USE_STATUSES = ['pending', 'approved', 'built', 'live']

/** DELETE /api/ev/audio/:id — owner or staff. The worker removes the station file once unused. */
export async function deleteAudio(db: DB, actor: Actor, id: number) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(eventAudio).where(eq(eventAudio.id, id)).for('update')
    if (!a || a.deletedAt || (a.ownerUserId !== actor.userId && !actor.staff)) throw notFound()
    const users = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          inArray(events.status, IN_USE_STATUSES),
          sql`(EXISTS (SELECT 1 FROM ${eventTracks} t WHERE t.event_id = ${events.id} AND t.audio_id = ${id})
            OR EXISTS (SELECT 1 FROM ${eventAnnouncements} x WHERE x.event_id = ${events.id} AND x.audio_id = ${id}))`,
        ),
      )
      .orderBy(asc(events.id))
    // Members cannot pull audio out from under an event that is booked or
    // under review; staff may (the worker still keeps the file until unused).
    if (users.length && !actor.staff) throw new HttpError(409, 'audio_in_use')
    await tx.update(eventAudio).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(eventAudio.id, id))
    await enqueueEventJob(tx, 'audio_delete', { audioId: id })
    await audit(tx, { actorUserId: actor.userId, actorDiscordId: actor.discordId, action: 'events.audio.delete', targetType: 'event_audio', targetId: id, detail: { byStaff: a.ownerUserId !== actor.userId, inUseBy: users.map((u) => u.id) } })
    return { deleted: true as const }
  })
}

// ------------------------------------------------------------ preview ---
// The portal's signed, viewer-bound media URLs (media/signing.ts), bound to
// the item id `ev-a<id>` so an events signature can never open a music
// item. Served here (the /api/media routes are not on the events host)
// from the staged upload while it is there (probed, not yet ingested; after
// ingest the staging copy is released and the preview answers 404
// preview_unavailable).

const previewItem = (id: number) => `ev-a${id}`

function previewable(a: AudioDbRow): boolean {
  return !!a.probeSha256 && !!a.uploadId && UPLOAD_ID_RE.test(a.uploadId) && (a.status === 'ready' || a.status === 'ingesting')
}

export async function previewUrl(db: DB, actor: Actor, id: number): Promise<{ url: string }> {
  const a = await loadVisibleAudio(db, actor, id)
  if (!previewable(a)) throw new HttpError(404, 'preview_unavailable')
  const signed = new URL(signMediaUrl('audio', previewItem(id), actor.userId), 'http://x')
  return { url: `/api/ev/audio/${id}/preview?exp=${signed.searchParams.get('exp')}&sig=${signed.searchParams.get('sig')}` }
}

export async function servePreview(db: DB, actor: Actor, id: number, req: Request): Promise<Response> {
  const a = await loadVisibleAudio(db, actor, id)
  const u = new URL(req.url)
  if (!verifyMediaSig('audio', previewItem(id), actor.userId, u.searchParams.get('exp'), u.searchParams.get('sig'))) throw forbidden('bad_signature')
  if (!previewable(a)) throw new HttpError(404, 'preview_unavailable')
  return serveStagedFile({ dir: webEnv().STAGING_UPLOADS_DIR, name: a.uploadId!, contentType: 'audio/mpeg', downloadName: `preview-a${id}.mp3`, range: req.headers.get('range') })
}
