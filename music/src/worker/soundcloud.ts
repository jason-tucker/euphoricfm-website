// SoundCloud links (v0.4.0, plan P5), worker side. The worker is the only
// party that talks to music-fetch, through its spool:
//
//   soundcloud_fetch job  (queued by the web with the item)
//     item 'probing' / fetch_stage 'queued'
//       → kill switch (off: the link waits, v0.4.1), one link at a time
//         (music-fetch works one job at a time; keeping at most one
//         outstanding request lets the result timeout measure the fetch
//         itself, not the queue), music-fetch alive (its out/.alive
//         heartbeat; v0.4.1): each wait is a RetryLater bounded by
//         FETCH_QUEUE_MAX_S, then 'rejected' sc_queue_timeout
//       → /spool/fetch/in/<fetch_request_id>.json
//       → fetch_stage 'fetching' (fetch_requested_at = now)
//   collectFetchResults  (every loop)
//     /spool/fetch/out/<fetch_request_id>.json (read-only mount, strict schema)
//       error → item 'rejected' (sc_<code>)
//       ok    → every path / format / URL re-checked, the metadata becomes the
//               pre-fill (clipTag: the ID3 pre-fill rule), a probe_fetch
//               request (id = fetch_request_id) to /spool/probe/in-worker
//               → fetch_stage 'converting', probe_request_id set
//       none after FETCH_RESULT_TIMEOUT_S → 'rejected' (sc_fetch_unanswered)
//     an item that left 'fetching' wakes the queued links (run_after = now)
//   collectProbeResults (handlers.ts) then takes the probe_fetch result like
//   an upload's probe result, and asks music-fetch to delete the raw media
//   (/spool/fetch/in/<id>.release).
//   reissueFetchReleases (at start-up, then every FETCH_RELEASE_REISSUE_S)
//     writes the marker again for every recent SoundCloud item that is no
//     longer 'probing', so a marker lost to a restart (or an item withdrawn by
//     retention) still frees the raw download before music-fetch's 24 h sweep.
//
// Every step is idempotent, so a worker restart at any point repeats at most
// a request that music-fetch / the probe answer once: a request is not
// written again once its result exists, both services never overwrite a
// result, music-fetch refuses a job whose directory exists, and every DB
// transition is a conditional UPDATE on the stage it expects.

import { join } from 'node:path'
import { and, eq, gt, isNotNull, ne, sql } from 'drizzle-orm'
import { MAX_DURATION_S } from '../lib/fit'
import { FETCH_CODEC, FETCH_EXT_FORMAT, FETCH_QUEUE_MAX_S, FETCH_RESULT_TIMEOUT_S, parseSoundCloudUrl } from '../lib/soundcloud'
import { clipTag } from '../probe/tags'
import { audit } from '../server/audit'
import { items, uploads } from '../server/db/schema'
import { soundcloudEnabled } from '../server/settings'
import { artworkPathOk, audioExtOf, canonicalUrlOk, fetchAlive, fetchResultExists, readFetchResult, writeFetchRelease, writeFetchRequest, type FetchAudioExt, type FetchOk } from '../server/spool/fetch'
import { readSmallFileNoFollow, writeSpoolRequest } from '../server/spool/protocol'
import { RetryLater, type WorkerCtx } from './handlers'
import type { P3Ctx } from './ingest/context'

export type FetchCtx = P3Ctx & {
  // /spool/fetch/in (rw): requests and release markers
  fetchInDir: string
  // /spool/fetch/out (ro): music-fetch's results
  fetchOutDir: string
}

export function isFetchCtx(ctx: WorkerCtx): ctx is FetchCtx {
  const c = ctx as Partial<FetchCtx>
  return typeof c.fetchInDir === 'string' && typeof c.fetchOutDir === 'string' && typeof c.spoolInDir === 'string'
}

type ItemRow = typeof items.$inferSelect

// A SoundCloud item fails: rejected with a code the UI explains, its staging
// charge released, and (release: true) music-fetch asked to drop whatever it
// still holds for the job. Conditional on the stage the caller saw.
export async function rejectFetchItem(ctx: WorkerCtx & Partial<FetchCtx>, it: ItemRow, code: string, opts: { release?: boolean; detail?: Record<string, unknown> } = {}): Promise<boolean> {
  const moved = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(items)
      .set({ status: 'rejected', probeError: code.slice(0, 64), fetchStage: null, updatedAt: new Date() })
      .where(and(eq(items.id, it.id), eq(items.status, 'probing'), it.fetchStage ? eq(items.fetchStage, it.fetchStage) : sql`${items.fetchStage} IS NULL`))
      .returning({ id: items.id })
    if (rows.length === 1 && it.uploadId) {
      await tx.update(uploads).set({ status: 'expired' }).where(and(eq(uploads.id, it.uploadId), eq(uploads.status, 'attached')))
    }
    if (rows.length === 1) {
      await audit(tx, { actorUserId: it.ownerUserId, action: 'item.soundcloud_rejected', targetType: 'item', targetId: it.id, detail: { code, stage: it.fetchStage, ...(opts.detail ?? {}) } })
    }
    return rows.length === 1
  })
  if (moved && opts.release && it.fetchRequestId && ctx.fetchInDir) await writeFetchRelease(ctx.fetchInDir, it.fetchRequestId)
  return moved
}

// v0.4.1 waits. Busy: another link is being fetched (collectFetchResults
// wakes the queue as soon as it leaves 'fetching', so this is a backstop,
// not the reaction time; was 10 s). Disabled: the kill switch is off (the
// link survives a short OFF; was an immediate sc_disabled). Down: music-fetch
// shows no heartbeat (the link waits instead of burning the 15-min result
// timeout, and one alert per hour says so).
export const FETCH_BUSY_RETRY_S = 30
export const FETCH_DISABLED_RETRY_S = 60
export const FETCH_DOWN_RETRY_S = 30
export const FETCH_DOWN_ALERT_EVERY_MS = 3600_000
export const fetchDownAlert = { at: 0 }

async function queuedTooLong(ctx: FetchCtx, it: ItemRow): Promise<boolean> {
  const [age] = await ctx.db.execute<{ s: number }>(sql`SELECT EXTRACT(EPOCH FROM now() - ${items.createdAt})::int AS s FROM ${items} WHERE ${items.id} = ${it.id}`)
  return Number(age?.s ?? 0) > FETCH_QUEUE_MAX_S
}

// A link that cannot go yet: rejected once it has waited FETCH_QUEUE_MAX_S,
// else the job is put back (no attempt spent). maxAgeS is the backstop the
// job loop applies (failOwner → sc_queue_timeout).
async function waitOrGiveUp(ctx: FetchCtx, it: ItemRow, delayS: number, why: string): Promise<void> {
  if (await queuedTooLong(ctx, it)) {
    await rejectFetchItem(ctx, it, 'sc_queue_timeout')
    return
  }
  throw new RetryLater(delayS, why, { exact: true, maxAgeS: FETCH_QUEUE_MAX_S + 3600 })
}

export async function runSoundcloudFetch(ctx: FetchCtx, p: { itemId: number }): Promise<void> {
  const it = await ctx.db.query.items.findFirst({ where: eq(items.id, p.itemId) })
  // Anything else was handled already (a repeated job after a restart), or
  // the member cancelled the link (withdrawn while queued, v0.4.1).
  if (!it || it.source !== 'soundcloud' || it.status !== 'probing' || it.fetchStage !== 'queued' || !it.fetchRequestId || !it.sourceUrl) return
  if (!(await soundcloudEnabled(ctx.db))) return waitOrGiveUp(ctx, it, FETCH_DISABLED_RETRY_S, 'soundcloud fetch disabled')
  // Defence in depth: the stored link is re-validated (and rebuilt) here.
  const url = parseSoundCloudUrl(it.sourceUrl)
  if (!url.ok) {
    await rejectFetchItem(ctx, it, url.code)
    return
  }
  const [busy] = await ctx.db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.source, 'soundcloud'), eq(items.status, 'probing'), eq(items.fetchStage, 'fetching'), ne(items.id, it.id)))
    .limit(1)
  if (busy) return waitOrGiveUp(ctx, it, FETCH_BUSY_RETRY_S, 'music-fetch is busy with another link')
  // A result already there means the request was written before a restart.
  if (!(await fetchResultExists(ctx.fetchOutDir, it.fetchRequestId))) {
    if (!(await fetchAlive(ctx.fetchOutDir, ctx.now()))) {
      if (ctx.now() - fetchDownAlert.at > FETCH_DOWN_ALERT_EVERY_MS) {
        fetchDownAlert.at = ctx.now()
        await ctx.alert('music-fetch is not running (no heartbeat): SoundCloud links are waiting', { itemId: it.id })
      }
      return waitOrGiveUp(ctx, it, FETCH_DOWN_RETRY_S, 'music-fetch not running')
    }
    await writeFetchRequest(ctx.fetchInDir, { uuid: it.fetchRequestId, url: url.url, requestedBy: `item:${it.id}` })
  }
  await ctx.db
    .update(items)
    .set({ fetchStage: 'fetching', fetchRequestedAt: sql`now()`, updatedAt: new Date() })
    .where(and(eq(items.id, it.id), eq(items.status, 'probing'), eq(items.fetchStage, 'queued')))
}

// What the worker accepts from an ok result, or the rejection code.
export function checkFetchOk(uuid: string, r: FetchOk): { ok: true; ext: FetchAudioExt; format: 'mp4' | 'ogg' | 'mp3'; artworkSha256: string | null } | { ok: false; code: string } {
  const ext = audioExtOf(uuid, r.files.audio)
  if (!ext) return { ok: false, code: 'sc_bad_result' }
  const format = FETCH_EXT_FORMAT[ext]
  if (!format) return { ok: false, code: 'sc_codec_unsupported' }
  // music-fetch's container → the demuxer the probe will force. Vorbis
  // ('ogg'), WAV and FLAC are refused: SoundCloud streams are AAC, Opus, MP3.
  const container = { mp4: 'mp4', ogg: 'opus', mp3: 'mp3' }[format]
  if (r.ffmpegFormat !== format || r.container !== container) return { ok: false, code: 'sc_codec_unsupported' }
  if (!canonicalUrlOk(r.canonicalUrl)) return { ok: false, code: 'sc_bad_result' }
  if (r.meta.duration > MAX_DURATION_S) return { ok: false, code: 'sc_too_long' }
  const artworkSha256 = r.files.artwork && artworkPathOk(uuid, r.files.artwork) && r.artworkSha256 ? r.artworkSha256 : null
  return { ok: true, ext, format, artworkSha256 }
}

async function probeResultExists(outDir: string, id: string): Promise<boolean> {
  try {
    return (await readSmallFileNoFollow(join(outDir, `${id}.json`))) !== null
  } catch {
    return true // something is there (not a small regular file): never write over it
  }
}

export async function collectFetchResults(ctx: FetchCtx): Promise<number> {
  const waiting = await ctx.db.query.items.findMany({
    where: and(eq(items.source, 'soundcloud'), eq(items.status, 'probing'), eq(items.fetchStage, 'fetching')),
    limit: 20,
  })
  let n = 0
  for (const it of waiting) {
    const uuid = it.fetchRequestId
    if (!uuid || !it.uploadId) {
      await rejectFetchItem(ctx, it, 'sc_bad_result')
      n++
      continue
    }
    let r
    try {
      r = await readFetchResult(ctx.fetchOutDir, uuid)
    } catch (e) {
      await rejectFetchItem(ctx, it, 'sc_bad_result', { release: true, detail: { error: e instanceof Error ? e.message.slice(0, 200) : 'error' } })
      n++
      continue
    }
    if (!r) {
      const [late] = await ctx.db.execute<{ late: boolean }>(
        sql`SELECT (${items.fetchRequestedAt} IS NULL OR ${items.fetchRequestedAt} < now() - make_interval(secs => ${FETCH_RESULT_TIMEOUT_S})) AS late FROM ${items} WHERE ${items.id} = ${it.id}`,
      )
      if (late?.late) {
        await rejectFetchItem(ctx, it, 'sc_fetch_unanswered', { release: true })
        await ctx.alert('music-fetch did not answer a SoundCloud link in time', { itemId: it.id, fetchRequestId: uuid })
        n++
      }
      continue
    }
    if (r.status === 'error') {
      // music-fetch removed the job's directory itself.
      await rejectFetchItem(ctx, it, `sc_${r.errorCode}`)
      n++
      continue
    }
    const c = checkFetchOk(uuid, r)
    if (!c.ok) {
      await rejectFetchItem(ctx, it, c.code, { release: true })
      n++
      continue
    }
    const prefill = { title: clipTag(r.meta.title), artist: clipTag(r.meta.uploader), album: null, genre: clipTag(r.meta.genre ?? null), year: null }
    // The probe request's id is the fetch job's own (a separate spool), so a
    // restart between this write and the UPDATE below rewrites the same one.
    if (!(await probeResultExists(ctx.spoolOutDir, uuid))) {
      await writeSpoolRequest(ctx.spoolInDir, {
        v: 1,
        id: uuid,
        type: 'probe_fetch',
        fetchId: uuid,
        upload: it.uploadId,
        ext: c.ext,
        format: c.format,
        sha256: r.rawSha256,
        size: r.audioBytes,
        artworkSha256: c.artworkSha256,
        declaredDurationS: r.meta.duration,
      })
    }
    await ctx.db
      .update(items)
      .set({
        fetchStage: 'converting',
        probeRequestId: uuid,
        sourceUrl: r.canonicalUrl,
        fetchLicense: r.meta.license ?? null,
        prefill,
        title: prefill.title,
        artist: prefill.artist,
        genre: prefill.genre,
        inputFormat: FETCH_CODEC[c.format],
        updatedAt: new Date(),
      })
      .where(and(eq(items.id, it.id), eq(items.status, 'probing'), eq(items.fetchStage, 'fetching')))
    n++
  }
  // An item left 'fetching': the next queued link need not wait for its
  // RetryLater (the ticketOpen pattern, handlers.ts).
  if (n > 0) await wakeQueuedFetches(ctx)
  return n
}

export async function wakeQueuedFetches(ctx: Pick<FetchCtx, 'db'>): Promise<void> {
  await ctx.db.execute(sql`UPDATE jobs SET run_after = now() WHERE kind = 'soundcloud_fetch' AND status = 'queued' AND run_after > now()`)
}

// A marker the worker meant to write can be lost: a restart between an item's
// final DB transition and writeFetchRelease, or an item that left 'probing'
// some other way (retention). Re-issuing is harmless: music-fetch deletes a
// FINISHED job's staging dir, cancels a job still queued in in/, keeps the
// marker of the job it is fetching until its result is written, and drops a
// marker for a job it does not know. Only items no longer 'probing' qualify
// (a 'probing' one may still need its raw download), and only recent ones:
// music-fetch sweeps anything older than 24 h itself.
export const FETCH_RELEASE_REISSUE_S = 30 * 60
export const FETCH_RELEASE_WINDOW_S = 28 * 3600

export async function reissueFetchReleases(ctx: FetchCtx, limit = 500): Promise<number> {
  const rows = await ctx.db
    .select({ fetchRequestId: items.fetchRequestId })
    .from(items)
    .where(
      and(
        eq(items.source, 'soundcloud'),
        isNotNull(items.fetchRequestId),
        ne(items.status, 'probing'),
        gt(items.createdAt, sql`now() - make_interval(secs => ${FETCH_RELEASE_WINDOW_S})`),
      ),
    )
    .limit(limit)
  let n = 0
  for (const r of rows) {
    if (r.fetchRequestId && (await writeFetchRelease(ctx.fetchInDir, r.fetchRequestId))) n++
  }
  return n
}
