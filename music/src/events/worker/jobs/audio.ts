// Custom audio (contract "event_audio lifecycle", plan §3 "Audio caps" and
// §4 "Ingest pacing"):
//
//   probing   events-web wrote the probe request to the events in-web inbox
//             under probeRequestIdForUpload(upload_id); audio_collect reads
//             /spool/probe/out and moves the row to ready or rejected;
//   ready     audio_finalize writes the finalize request (server-set tags)
//             to the in-worker inbox → ingesting;
//   ingesting audio_ingest reads the probe's final file, waits for the scan
//             window and the pacing (≥ 90 s after the music worker's last
//             upload attempt and after our own, ≤ 4 per hour), then POSTs it
//             to Events/Uploads/<owner>/evt-a<id>.mp3; after two scans it
//             re-reads the row: same path, in NO playlist on any station
//             (a folder link would have attached it) → live;
//   delete    audio_delete: the narrow DELETE /file (wrapper re-checks the
//             exact path, deleted_at and that no active event uses it).

import { createHash, randomUUID } from 'node:crypto'
import { constants as FS } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { FINAL_FILE_RE, MAX_UPLOAD_BYTES, readSpoolResult, UPLOAD_ID_RE, writeSpoolRequest, type SpoolResult } from '../../../server/spool/protocol'
import { afterScans, pacingWaitMs, scanWindow } from '../../../worker/ingest/window'
import { EVENTS_UPLOAD_DIR, eventUploadPathFor } from '../../azuracast/allowlist'
import { EventsAzuraCastError } from '../../azuracast/client'
import { folderLinkCheck } from '../../azuracast/selfcheck'
import type { EventJobPayload } from '../../contract/jobs'
import { probeRequestIdForUpload, uuidV4FromHex } from '../../contract/paths'
import { EVENTS_ANNOUNCEMENT_MIN_DURATION_S, EVENTS_INGEST_PER_HOUR, EVENTS_INGEST_SPACING_S, EVENTS_SONG_MIN_DURATION_S } from '../../contract/rules'
import type { EventsCtx } from '../ctx'
import { Permanent, Wait, waitUntil } from '../errors'
import type { AudioRow } from '../store'
import { cardText } from './tickets'

export const PROBE_TIMEOUT_MS = 2 * 3600_000
export const FINALIZE_TIMEOUT_MS = 15 * 60_000
const MAX_FINAL_BYTES = 40 * 1024 * 1024
const INGEST_WAIT_MAX_AGE_S = 40 * 24 * 3600
export const EVENTS_TAG_ARTIST = 'EuphoricFM Events'
export const EVENT_VERSION_SUFFIX = ' (event version)'

// ----------------------------------------------------------- spool ids --

// The probe request id for an events upload is contract/paths.ts
// probeRequestIdForUpload: events-web writes the request under it and
// audio_collect reads the result under it (imported, never copied).

// The finalize request id: deterministic per (audio, upload, probe sha), so a
// retried job finds the result of its own earlier request.
export function finalizeRequestIdFor(a: Pick<AudioRow, 'id' | 'uploadId' | 'probeSha256'>): string {
  return uuidV4FromHex(createHash('sha256').update(`events-finalize:${a.id}:${a.uploadId}:${a.probeSha256}`).digest('hex').slice(0, 32))
}

// ------------------------------------------------------------ helpers --

async function fail(ctx: EventsCtx, a: AudioRow, reason: string, alert = false): Promise<void> {
  const moved = await ctx.store.updateAudio(a.id, { status: 'failed', lastError: reason.slice(0, 200) }, ['probing', 'ready', 'ingesting'])
  if (!moved) return
  await ctx.store.audit('events.audio.failed', 'event_audio', a.id, { reason })
  if (alert) await ctx.alert(`events audio #${a.id} failed: ${reason}`, { audioId: a.id, reason })
}

export async function readFinal(dir: string, file: string): Promise<Buffer> {
  if (!FINAL_FILE_RE.test(file)) throw new Permanent('bad final file name')
  let fh
  try {
    fh = await open(join(dir, file), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
  } catch {
    throw new Permanent('final_missing')
  }
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size < 1 || st.size > MAX_FINAL_BYTES) throw new Permanent('final_not_regular')
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

// Server-set tags (plan §4 "Ingest pacing"): an announcement is
// "EuphoricFM Events" / its label; a song keeps the member's artist and
// title unless that pair is a library song's (then " (event version)").
// Empty tags are refused.
export async function serverTags(ctx: EventsCtx, a: AudioRow): Promise<{ title: string; artist: string; album: string; genre: string } | null> {
  let title = cardText(a.title ?? '', 200)
  let artist: string
  if (a.kind === 'announcement') {
    artist = EVENTS_TAG_ARTIST
  } else {
    artist = cardText(a.artist ?? '', 200)
    if (!artist) return null
    if (title && (await ctx.store.libraryTagCollision(artist, title))) title = `${title.slice(0, 200 - EVENT_VERSION_SUFFIX.length)}${EVENT_VERSION_SUFFIX}`
  }
  if (!title) return null
  return { title, artist, album: EVENTS_TAG_ARTIST, genre: '' }
}

// ------------------------------------------------------------ collect ---

export async function collectAudio(ctx: EventsCtx): Promise<number> {
  let n = 0
  for (const a of await ctx.store.audioByStatus('probing', 50)) {
    if (!a.uploadId) continue
    if (!UPLOAD_ID_RE.test(a.uploadId)) {
      await ctx.store.updateAudio(a.id, { status: 'rejected', lastError: 'bad_upload_id' }, ['probing'])
      continue
    }
    let r: SpoolResult | null
    try {
      r = await readSpoolResult(ctx.spoolOutDir, probeRequestIdForUpload(a.uploadId))
    } catch {
      await ctx.store.updateAudio(a.id, { status: 'rejected', lastError: 'bad_probe_result' }, ['probing'])
      continue
    }
    if (!r) {
      if (ctx.now() - a.createdAt.getTime() > PROBE_TIMEOUT_MS) await fail(ctx, a, 'probe_timeout')
      continue
    }
    if (r.source !== 'in-web' || r.type !== 'probe') {
      await ctx.store.updateAudio(a.id, { status: 'rejected', lastError: 'wrong_result_source' }, ['probing'])
      continue
    }
    if (r.ok && 'sha256' in r && r.type === 'probe') {
      // The events probe accepts files from 3 s (short announcements); a
      // song keeps the music portal's 30 s minimum. The web's staging sweep
      // releases the upload of a rejected row.
      const minS = a.kind === 'song' ? EVENTS_SONG_MIN_DURATION_S : EVENTS_ANNOUNCEMENT_MIN_DURATION_S
      if (!(r.durationS >= minS)) {
        await ctx.store.updateAudio(a.id, { status: 'rejected', durationS: Math.round(r.durationS), lastError: 'too_short' }, ['probing'])
        n++
        continue
      }
      const moved = await ctx.store.updateAudio(
        a.id,
        { status: 'ready', durationS: Math.round(r.durationS), probeSha256: r.sha256, transcodeKbps: r.transcodeKbps ?? null, inputFormat: r.inputFormat ?? 'mp3', lastError: null },
        ['probing'],
      )
      if (moved) {
        const replaced = r.inputFormat === 'wav' || r.transcodeKbps !== undefined
        if (replaced && r.size >= 1 && r.size <= MAX_UPLOAD_BYTES) await ctx.store.setUploadLength(a.uploadId, r.size)
        // Ingested as soon as it is ready (plan §3): it airs only when an
        // approved event's playlist names it.
        await ctx.store.enqueue('audio_finalize', { audioId: a.id })
      }
    } else {
      const released = !r.ok && 'released' in r && r.released === true
      const moved = await ctx.store.updateAudio(a.id, { status: 'rejected', lastError: ('error' in r ? String(r.error) : 'probe_failed').slice(0, 64) }, ['probing'])
      if (moved && released) await ctx.store.expireUpload(a.uploadId)
    }
    n++
  }
  return n
}

// ----------------------------------------------------------- finalize ---

export async function audioFinalize(ctx: EventsCtx, p: EventJobPayload<'audio_finalize'>): Promise<void> {
  const a = await ctx.store.getAudio(p.audioId)
  if (!a) throw new Permanent('audio missing')
  if (a.deletedAt) return
  if (a.status === 'ingesting') {
    await ctx.store.enqueue('audio_ingest', { audioId: a.id })
    return
  }
  if (a.status !== 'ready') return
  if (!a.uploadId || !a.probeSha256) return fail(ctx, a, 'not_finalizable')
  const tags = await serverTags(ctx, a)
  if (!tags) return fail(ctx, a, 'empty_tags')
  try {
    await writeSpoolRequest(ctx.spoolInDir, { v: 1, id: finalizeRequestIdFor(a), type: 'finalize', upload: a.uploadId, approvedSha256: a.probeSha256, tags, cover: null })
  } catch (e) {
    if (e instanceof Error && e.name === 'ZodError') return fail(ctx, a, 'bad_finalize_request')
    throw e
  }
  if (await ctx.store.updateAudio(a.id, { status: 'ingesting', lastError: null }, ['ready'])) {
    await ctx.store.enqueue('audio_ingest', { audioId: a.id })
  }
}

// ------------------------------------------------------------- ingest ---

const wait = (s: number, m: string, exact = false) => new Wait(s, m, { maxAgeS: INGEST_WAIT_MAX_AGE_S, exact })

async function assertIngestAllowed(ctx: EventsCtx): Promise<void> {
  if (ctx.ingestBlocked) throw wait(3600, `events ingest blocked: ${ctx.ingestBlocked}`)
  const links = await folderLinkCheck(ctx.az)
  if (!links.ok) {
    ctx.ingestBlocked = `folder link covers ${links.linked.map((l) => l.folder).join(', ')}`
    await ctx.alert('events ingest blocked: a station-14 playlist folder link covers Events/Uploads', { linked: links.linked })
    throw wait(3600, ctx.ingestBlocked)
  }
}

async function assertPacing(ctx: EventsCtx, offsetS: number): Promise<void> {
  const now = ctx.now()
  const w = scanWindow(now, offsetS)
  if (!w.open) throw wait(Math.ceil(w.waitMs / 1000), 'outside scan window', true)
  const music = await ctx.store.musicLastUploadAttemptMs()
  if (music !== null && music <= now && now - music < EVENTS_INGEST_SPACING_S * 1000) throw wait(Math.ceil((music + EVENTS_INGEST_SPACING_S * 1000 - now) / 1000), 'spacing after music upload', true)
  const ours = await ctx.store.eventsUploadAttemptsSince(now - 3600_000)
  const pace = pacingWaitMs(ours, now, { ingestSpacingS: EVENTS_INGEST_SPACING_S, ingestPerHour: EVENTS_INGEST_PER_HOUR })
  if (pace > 0) throw wait(Math.ceil(pace / 1000), 'events pacing', true)
}

async function finalizeResult(ctx: EventsCtx, a: AudioRow) {
  let r: SpoolResult | null
  try {
    r = await readSpoolResult(ctx.spoolOutDir, finalizeRequestIdFor(a))
  } catch {
    return { kind: 'bad' as const }
  }
  if (!r) return { kind: 'pending' as const }
  if (r.source !== 'in-worker' || r.type !== 'finalize') return { kind: 'bad' as const }
  if (!r.ok || !('finalSha256' in r)) return { kind: 'failed' as const, error: 'error' in r ? String(r.error) : 'failed' }
  return { kind: 'ok' as const, file: r.file, finalSha256: r.finalSha256 }
}

export async function audioIngest(ctx: EventsCtx, p: EventJobPayload<'audio_ingest'>): Promise<void> {
  const a = await ctx.store.getAudio(p.audioId)
  if (!a) throw new Permanent('audio missing')
  if (a.deletedAt) {
    if (a.mediaId !== null) await ctx.store.enqueue('audio_delete', { audioId: a.id })
    return
  }
  if (a.status !== 'ingesting') return
  const path = eventUploadPathFor(a.ownerDiscordId, a.id)
  const offset = await ctx.store.scanOffsetS()

  if (a.mediaId === null) {
    const fr = await finalizeResult(ctx, a)
    if (fr.kind === 'pending') {
      if (ctx.now() - a.updatedAt.getTime() > FINALIZE_TIMEOUT_MS) return fail(ctx, a, 'finalize_timeout')
      throw wait(5, 'finalize pending')
    }
    if (fr.kind === 'bad') return fail(ctx, a, 'bad_finalize_result')
    if (fr.kind === 'failed') return fail(ctx, a, `finalize_${fr.error}`.slice(0, 64))
    const bytes = await readFinal(ctx.finalDir, fr.file)
    if (sha256(bytes) !== fr.finalSha256) return fail(ctx, a, 'final_sha_mismatch', true)
    const tags = await serverTags(ctx, a)
    if (!tags) return fail(ctx, a, 'empty_tags')

    await assertIngestAllowed(ctx)
    await assertPacing(ctx, offset)

    // Our path is deterministic and only this worker writes under
    // Events/Uploads/: a row already there is an earlier attempt of ours
    // when it is a scanned media row of exactly this size.
    let existing: Awaited<ReturnType<typeof ctx.az.listDirectory>> = []
    try {
      existing = await ctx.az.listDirectory(`${EVENTS_UPLOAD_DIR}/${a.ownerDiscordId}`)
    } catch (e) {
      if (!(e instanceof EventsAzuraCastError && e.code === 'not_found')) throw e
    }
    const there = existing.find((e) => e.path === path)
    let media = there?.media ?? null
    if (there) {
      const size = (there as Record<string, unknown>).size
      if (!media || size !== bytes.length) {
        await ctx.alert(`events audio #${a.id}: ${path} is occupied by something that is not its upload`, { audioId: a.id, path })
        return fail(ctx, a, 'path_occupied')
      }
      await ctx.store.audit('events.audio.adopted', 'event_audio', a.id, { path, mediaId: media.id })
    } else {
      // The listing took time: the POST must still start inside the window.
      const w = scanWindow(ctx.now(), offset)
      if (!w.open) throw wait(Math.ceil(w.waitMs / 1000), 'window closed before upload', true)
      await ctx.store.recordUploadAttempt(a.id, path)
      media = await ctx.az.uploadFile(bytes, { ownerDiscordId: a.ownerDiscordId, audioId: a.id })
    }
    if ((media.title ?? '') !== tags.title || (media.artist ?? '') !== tags.artist) {
      await ctx.az.updateMetadata(media.id, tags, { mediaId: media.id, ownerDiscordId: a.ownerDiscordId, audioId: a.id })
    }
    await ctx.store.updateAudio(a.id, { mediaId: media.id, uniqueId: media.unique_id, path }, ['ingesting'])
    await ctx.store.audit('events.audio.uploaded', 'event_audio', a.id, { path, mediaId: media.id })
    throw waitUntil(ctx.now(), afterScans(ctx.now(), 2, offset), 'verify after two scans', INGEST_WAIT_MAX_AGE_S)
  }

  // Verify: after two scans the row must still be there, at our path, and
  // in no playlist on any station.
  const due = afterScans(a.updatedAt.getTime(), 2, offset)
  if (ctx.now() < due) throw waitUntil(ctx.now(), due, 'verify after two scans', INGEST_WAIT_MAX_AGE_S)
  const f = await ctx.az.getFileOrNull(a.mediaId)
  if (!f || f.path !== path) return fail(ctx, a, f ? 'moved_after_upload' : 'row_missing_after_scan', true)
  if (f.playlists.length > 0) {
    ctx.ingestBlocked = `a fresh upload (${path}) was put in playlist(s) ${f.playlists.map((x) => x.id).join(', ')}`
    return fail(ctx, a, 'folder_playlist_attached', true)
  }
  if (await ctx.store.updateAudio(a.id, { status: 'live', lastError: null }, ['ingesting'])) {
    await ctx.store.audit('events.audio.live', 'event_audio', a.id, { path, mediaId: a.mediaId })
    const fr = await finalizeResult(ctx, a)
    if (fr.kind === 'ok') await writeSpoolRequest(ctx.spoolInDir, { v: 1, id: randomUUID(), type: 'cleanup_final', file: fr.file }).catch(() => {})
  }
}

// ------------------------------------------------------------- delete ---

export async function audioDelete(ctx: EventsCtx, p: EventJobPayload<'audio_delete'>): Promise<void> {
  const a = await ctx.store.getAudio(p.audioId)
  if (!a) throw new Permanent('audio missing')
  if (!a.deletedAt) throw new Permanent('audio is not marked deleted')
  if (a.mediaId === null || a.path === null) return
  if (await ctx.store.audioInActiveEvent(a.id)) throw new Wait(3600, 'audio used by an approved/built/live event', { maxAgeS: 400 * 24 * 3600 })
  const reg = await ctx.store.registryIdsByActivity()
  try {
    await ctx.az.deleteFile(a.mediaId, { mediaId: a.mediaId, ownerDiscordId: a.ownerDiscordId, audioId: a.id, audioDeleted: true, activeRegistryIds: reg.active, inactiveRegistryIds: reg.inactive })
  } catch (e) {
    if (!(e instanceof EventsAzuraCastError && e.code === 'not_found')) throw e
  }
  await ctx.store.updateAudio(a.id, { path: null, lastError: 'deleted' })
  await ctx.store.audit('events.audio.deleted', 'event_audio', a.id, { mediaId: a.mediaId })
}
