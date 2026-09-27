// The ingest pipeline (plan §3.7 "ingest", P3). One `ingest` job per approved
// song walks ingest_runs.stage forward; every stage is idempotent, so a crash
// or retry resumes where it stopped:
//
//   finalize    artist gate (active artist, or wait for the new-artist item),
//               then a `finalize` request to the network-less probe
//   finalizing  the probe verifies approved_sha256 (= the PROBE-time sha the
//               reviewer previewed), strips + re-tags, publishes final.mp3;
//               the worker re-hashes what landed against final_sha256
//   ready       scan window (clock only) + serial pacing, then the path build
//               and a flushCache collision walk (ANY entry = taken; ` (2)`…
//               ` (9)`), then POST /files (the wrapper re-hashes the bytes)
//   uploaded    batch do=playlist with the approved ids that are still
//               assignable AND belong to station 1
//   playlists   GET verify, media_snapshots row, item → `verifying`
//
// Then an `ingest_verify` job runs after the next two scans: id + path +
// playlists intact → `live`; playlists missing → re-apply (bounded); row
// gone → recovery by path (≥ 3 polls and ≥ 20 min), metadata then playlists
// re-applied from the snapshot, ids remapped, alert.

import { createHash, randomUUID } from 'node:crypto'
import { constants as FS } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { audit } from '../../server/audit'
import { AzuraCastError, type StationMedia } from '../../server/azuracast/client'
import { ingestRuns, items, mediaSnapshots } from '../../server/db/schema'
import { enqueue } from '../../server/jobs'
import { resolveArtistGate } from '../../server/library/artists'
import { PathError, resolveIngestPath } from '../../server/paths/builder'
import { getSetting } from '../../server/settings'
import { FINAL_FILE_RE, readSpoolResult, writeSpoolRequest } from '../../server/spool/protocol'
import { Defer, Permanent } from '../handlers'
import { findMediaByPath, reapplySnapshot, RECOVERY_MIN_MS, RECOVERY_MIN_POLLS, remapMediaId } from '../library/recovery'
import { ingestPlaylistIds, stationPlaylistIds } from '../library/playlists'
import type { P3Ctx } from './context'
import { afterScans, getCaps, pacingWait, scanOffsetS, scanWindow, WindowConfigError } from './window'

export const FINALIZE_TIMEOUT_MS = 15 * 60_000
export const POLL_S = 5
const MAX_FINAL_BYTES = 40 * 1024 * 1024
const MAX_REPAIRS = 2
const MAX_RECOVERIES = 2

type Item = typeof items.$inferSelect
type Run = typeof ingestRuns.$inferSelect

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function loadItem(ctx: P3Ctx, id: number): Promise<Item | undefined> {
  return ctx.db.query.items.findFirst({ where: eq(items.id, id) })
}

async function loadRun(ctx: P3Ctx, id: number): Promise<Run | undefined> {
  return ctx.db.query.ingestRuns.findFirst({ where: eq(ingestRuns.itemId, id) })
}

async function setRun(ctx: P3Ctx, id: number, patch: Partial<typeof ingestRuns.$inferInsert>) {
  await ctx.db.update(ingestRuns).set({ ...patch, updatedAt: new Date(ctx.now()) }).where(eq(ingestRuns.itemId, id))
}

async function queuesPaused(ctx: P3Ctx): Promise<boolean> {
  return Boolean(await getSetting(ctx.db, 'queues_paused'))
}

// The window never opens if offset + 20 s > 150 s: alert (stop condition)
// and look again in an hour.
async function windowOrDefer(ctx: P3Ctx, itemId: number): Promise<number> {
  const offset = await scanOffsetS(ctx.db)
  try {
    const w = scanWindow(ctx.now(), offset)
    if (!w.open) throw new Defer(Math.ceil(w.waitMs / 1000), 'outside scan window')
  } catch (e) {
    if (e instanceof WindowConfigError) {
      await ctx.alert('scan window misconfigured: ingest held (stop and ask Jason)', { itemId, offset })
      throw new Defer(3600, e.message)
    }
    throw e
  }
  return offset
}

export async function readFinal(dir: string, file: string): Promise<Buffer> {
  if (!FINAL_FILE_RE.test(file)) throw new Permanent('bad final file name')
  let fh
  try {
    fh = await open(join(dir, file), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
  } catch {
    throw new IngestFailure('final_missing')
  }
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.size < 1 || st.size > MAX_FINAL_BYTES) throw new IngestFailure('final_not_regular')
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

class IngestFailure extends Error {
  constructor(readonly reason: string, readonly detail: Record<string, unknown> = {}) {
    super(reason)
    this.name = 'IngestFailure'
  }
}

// ------------------------------------------------------------- outcomes --

export async function failIngest(ctx: P3Ctx, itemId: number, reason: string, detail: Record<string, unknown> = {}): Promise<void> {
  const failed = await ctx.db
    .update(items)
    .set({ status: 'failed', updatedAt: new Date(ctx.now()) })
    .where(and(eq(items.id, itemId), inArray(items.status, ['approved', 'applying', 'verifying'])))
    .returning({ id: items.id })
  await setRun(ctx, itemId, { stage: 'failed', lastError: reason.slice(0, 200) })
  if (failed.length === 0) return
  await audit(ctx.db, { action: 'item.ingest.failed', targetType: 'item', targetId: itemId, detail: { reason, ...detail } })
  await ctx.alert(`ingest failed for item #${itemId}: ${reason}`, { itemId, reason, ...detail })
  await enqueue(ctx.db, 'ticket_item_event', { itemId, event: 'failed' }, { dedupeKey: `ticket_item_event:item:${itemId}:failed` })
}

async function goLive(ctx: P3Ctx, run: Run): Promise<void> {
  const now = new Date(ctx.now())
  const rows = await ctx.db
    .update(items)
    .set({ status: 'live', liveAt: now, updatedAt: now })
    .where(and(eq(items.id, run.itemId), eq(items.status, 'verifying')))
    .returning({ id: items.id })
  await setRun(ctx, run.itemId, { stage: 'live' })
  if (rows.length === 0) return
  await audit(ctx.db, { action: 'item.live', targetType: 'item', targetId: run.itemId, detail: { mediaId: run.mediaId, path: run.targetPath } })
  await enqueue(ctx.db, 'ticket_item_event', { itemId: run.itemId, event: 'live' }, { dedupeKey: `ticket_item_event:item:${run.itemId}:live` })
  await enqueue(ctx.db, 'library_sync', {}, { dedupeKey: `library_sync:after:item:${run.itemId}` })
}

// --------------------------------------------------------------- stages --

async function stageFinalize(ctx: P3Ctx, it: Item, run: Run): Promise<void> {
  if (await queuesPaused(ctx)) throw new Defer(600, 'queues paused')
  const gate = await resolveArtistGate(ctx.db, it)
  if (gate.kind === 'wait') throw new Defer(300, gate.reason)
  if (gate.kind === 'fail') throw new IngestFailure(gate.reason)
  if (!it.approvedSha256 || !it.uploadId) throw new IngestFailure('not_finalizable')
  if (!it.title?.trim() || !it.artist?.trim()) throw new IngestFailure('metadata_missing')
  const id = randomUUID()
  try {
    await writeSpoolRequest(ctx.spoolInDir, {
      v: 1,
      id,
      type: 'finalize',
      upload: it.uploadId,
      approvedSha256: it.approvedSha256,
      tags: { title: it.title, artist: it.artist, album: it.album ?? '', genre: it.genre ?? '' },
      cover: it.coverFile && it.coverSha256 ? { file: it.coverFile, sha256: it.coverSha256 } : null,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'ZodError') throw new IngestFailure('bad_finalize_request')
    throw e
  }
  await setRun(ctx, it.id, { stage: 'finalizing', finalizeRequestId: id, finalizeRequestedAt: new Date(ctx.now()) })
  await ctx.db.update(items).set({ status: 'applying', updatedAt: new Date(ctx.now()) }).where(and(eq(items.id, it.id), eq(items.status, 'approved')))
  throw new Defer(POLL_S, 'finalize submitted')
}

async function stageFinalizing(ctx: P3Ctx, it: Item, run: Run): Promise<void> {
  if (!run.finalizeRequestId) return setRun(ctx, it.id, { stage: 'finalize' })
  let r
  try {
    r = await readSpoolResult(ctx.spoolOutDir, run.finalizeRequestId)
  } catch {
    throw new IngestFailure('bad_finalize_result')
  }
  if (!r) {
    if (ctx.now() - (run.finalizeRequestedAt?.getTime() ?? 0) > FINALIZE_TIMEOUT_MS) throw new IngestFailure('finalize_timeout')
    throw new Defer(POLL_S, 'finalize pending')
  }
  if (r.source !== 'in-worker' || r.type !== 'finalize') throw new IngestFailure('wrong_result_source')
  if (!r.ok || !('finalSha256' in r)) throw new IngestFailure(`finalize_${'error' in r ? r.error : 'failed'}`)
  // The worker re-hashes the published bytes itself.
  const bytes = await readFinal(ctx.finalDir, r.file)
  const actual = sha256(bytes)
  if (actual !== r.finalSha256) throw new IngestFailure('final_sha_mismatch', { file: r.file })
  await ctx.db.update(items).set({ finalSha256: r.finalSha256, updatedAt: new Date(ctx.now()) }).where(eq(items.id, it.id))
  await setRun(ctx, it.id, { stage: 'ready', finalFile: r.file })
}

async function stageReady(ctx: P3Ctx, it: Item, run: Run): Promise<void> {
  if (await queuesPaused(ctx)) throw new Defer(600, 'queues paused')
  const offset = await windowOrDefer(ctx, it.id)
  const wait = await pacingWait(ctx.db, ctx.now(), await getCaps(ctx.db))
  if (wait > 0) throw new Defer(Math.ceil(wait / 1000), 'pacing')

  const chosen = await ingestPlaylistIds(ctx.db, run.playlistIds)
  if (run.playlistIds.length > 0 && chosen.length === 0) throw new IngestFailure('playlists_not_assignable', { approved: run.playlistIds })
  const gate = await resolveArtistGate(ctx.db, it)
  if (gate.kind === 'wait') throw new Defer(300, gate.reason)
  if (gate.kind === 'fail') throw new IngestFailure(gate.reason)
  if (!run.finalFile || !it.finalSha256) return setRun(ctx, it.id, { stage: 'finalize' })
  const bytes = await readFinal(ctx.finalDir, run.finalFile)
  if (sha256(bytes) !== it.finalSha256) throw new IngestFailure('final_sha_mismatch', { file: run.finalFile })

  // A previous attempt recorded its target and may have uploaded before it
  // could record the result: adopt that row instead of uploading twice.
  if (run.targetPath) {
    const m = await findMediaByPath(ctx.azuracast, run.targetPath)
    if (m) return recordUpload(ctx, it, run.targetPath, m, chosen)
  }

  let path: string
  try {
    path = await resolveIngestPath(ctx.root, gate.folder, it.artist ?? '', it.title ?? '', (dir, p) => ctx.azuracast.pathTaken(dir, p))
  } catch (e) {
    if (e instanceof PathError) throw new IngestFailure(e.code === 'collision_exhausted' ? 'collision_exhausted' : `path_${e.code}`, { folder: gate.folder })
    throw e
  }
  await setRun(ctx, it.id, { targetPath: path })
  // The listing took time: the POST itself must still start in the window.
  const w = scanWindow(ctx.now(), offset)
  if (!w.open) throw new Defer(Math.ceil(w.waitMs / 1000), 'window closed before upload')
  let media: StationMedia
  try {
    media = await ctx.azuracast.uploadFile(path, bytes, it.finalSha256)
  } catch (e) {
    if (e instanceof AzuraCastError && e.code === 'sha_mismatch') throw new IngestFailure('final_sha_mismatch')
    throw e
  }
  await recordUpload(ctx, it, path, media, chosen)
}

async function recordUpload(ctx: P3Ctx, it: Item, path: string, media: StationMedia, chosen: number[]) {
  const now = new Date(ctx.now())
  await setRun(ctx, it.id, { stage: 'uploaded', targetPath: path, mediaId: media.id, uniqueId: media.unique_id, uploadedAt: now, playlistIds: chosen })
  await ctx.db.update(items).set({ targetPath: path, mediaId: media.id, updatedAt: now }).where(eq(items.id, it.id))
  await audit(ctx.db, { action: 'item.ingest.uploaded', targetType: 'item', targetId: it.id, detail: { path, mediaId: media.id, playlistIds: chosen } })
}

async function stageUploaded(ctx: P3Ctx, it: Item, run: Run): Promise<void> {
  if (run.playlistIds.length > 0) await ctx.azuracast.setPlaylists(run.targetPath!, run.playlistIds, new Set(run.playlistIds))
  await setRun(ctx, it.id, { stage: 'playlists' })
}

async function getFileOrNull(ctx: P3Ctx, id: number): Promise<StationMedia | null> {
  try {
    return await ctx.azuracast.getFile(id)
  } catch (e) {
    if (e instanceof AzuraCastError && e.code === 'not_found') return null
    throw e
  }
}

const missingPlaylists = (f: StationMedia, want: readonly number[]) => want.filter((id) => !f.playlists.some((p) => p.id === id))

async function stagePlaylists(ctx: P3Ctx, it: Item, run: Run): Promise<void> {
  const f = await getFileOrNull(ctx, run.mediaId!)
  if (f && f.path === run.targetPath && missingPlaylists(f, run.playlistIds).length > 0) {
    if (run.repairs >= MAX_REPAIRS) throw new IngestFailure('playlists_not_applied')
    return setRun(ctx, it.id, { stage: 'uploaded', repairs: run.repairs + 1 })
  }
  // (A row already gone is left to the re-verify, which runs recovery from
  // the snapshot taken here.)
  const offset = await scanOffsetS(ctx.db)
  const due = new Date(afterScans(ctx.now(), 2, offset))
  await ctx.db.transaction(async (tx) => {
    await tx.insert(mediaSnapshots).values({
      mediaId: run.mediaId!,
      uniqueId: f?.unique_id ?? run.uniqueId,
      path: run.targetPath!,
      title: it.title,
      artist: it.artist,
      album: it.album,
      genre: it.genre,
      playlistIds: run.playlistIds,
      reason: 'ingest',
      itemId: it.id,
      takenAt: new Date(ctx.now()),
    })
    await tx.update(items).set({ status: 'verifying', updatedAt: new Date(ctx.now()) }).where(and(eq(items.id, it.id), eq(items.status, 'applying')))
    await tx
      .update(ingestRuns)
      .set({ stage: 'verifying', verifyDueAt: due, repairs: 0, lastError: f && f.path === run.targetPath ? null : 'missing_right_after_upload', updatedAt: new Date(ctx.now()) })
      .where(eq(ingestRuns.itemId, it.id))
    await enqueue(tx, 'ingest_verify', { itemId: it.id }, { dedupeKey: `ingest_verify:item:${it.id}`, runAfter: due })
  })
}

// ----------------------------------------------------------------- jobs --

export async function runIngest(ctx: P3Ctx, payload: { itemId: number }): Promise<void> {
  const itemId = payload.itemId
  const first = await loadItem(ctx, itemId)
  if (!first) throw new Permanent('item missing')
  if (first.kind !== 'song' || !['approved', 'applying'].includes(first.status)) return
  await ctx.db
    .insert(ingestRuns)
    .values({ itemId, playlistIds: first.playlistIds ?? [] })
    .onConflictDoNothing()
  try {
    for (let step = 0; step < 12; step++) {
      const it = (await loadItem(ctx, itemId))!
      const run = (await loadRun(ctx, itemId))!
      switch (run.stage) {
        case 'finalize':
          await stageFinalize(ctx, it, run)
          break
        case 'finalizing':
          await stageFinalizing(ctx, it, run)
          break
        case 'ready':
          await stageReady(ctx, it, run)
          break
        case 'uploaded':
          await stageUploaded(ctx, it, run)
          break
        case 'playlists':
          await stagePlaylists(ctx, it, run)
          break
        default:
          return // verifying / recovering (ingest_verify owns them), live, failed
      }
    }
    throw new Defer(POLL_S, 'step budget')
  } catch (e) {
    if (e instanceof IngestFailure) return failIngest(ctx, itemId, e.reason, e.detail)
    if (!(e instanceof Defer)) await setRun(ctx, itemId, { lastError: (e instanceof Error ? `${e.name}: ${e.message}` : 'error').slice(0, 200) }).catch(() => {})
    throw e
  }
}

export async function runIngestVerify(ctx: P3Ctx, payload: { itemId: number }): Promise<void> {
  const itemId = payload.itemId
  const run = await loadRun(ctx, itemId)
  if (!run || (run.stage !== 'verifying' && run.stage !== 'recovering')) return
  const now = ctx.now()
  if (run.verifyDueAt && now < run.verifyDueAt.getTime()) throw new Defer(Math.ceil((run.verifyDueAt.getTime() - now) / 1000), 'verify not due')
  const offset = await scanOffsetS(ctx.db)
  const next = (scans: number) => new Date(afterScans(ctx.now(), scans, offset))
  const snap = await ctx.db.query.mediaSnapshots.findFirst({ where: and(eq(mediaSnapshots.itemId, itemId), eq(mediaSnapshots.reason, 'ingest')), orderBy: desc(mediaSnapshots.id) })
  if (!snap) return failIngest(ctx, itemId, 'snapshot_missing')

  if (run.stage === 'verifying') {
    const f = await getFileOrNull(ctx, run.mediaId!)
    if (f && f.path === run.targetPath) {
      const missing = missingPlaylists(f, run.playlistIds)
      if (missing.length === 0) return goLive(ctx, run)
      if (run.repairs >= MAX_REPAIRS) return failIngest(ctx, itemId, 'playlists_lost', { missing })
      const stationIds = await stationPlaylistIds(ctx.db)
      const ids = snap.playlistIds.filter((id) => stationIds.has(id))
      await ctx.azuracast.setPlaylists(run.targetPath!, ids, new Set(ids))
      await setRun(ctx, itemId, { repairs: run.repairs + 1, verifyDueAt: next(2) })
      await audit(ctx.db, { action: 'item.ingest.playlists_repaired', targetType: 'item', targetId: itemId, detail: { missing } })
      throw new Defer(Math.ceil((next(2).getTime() - ctx.now()) / 1000), 'playlists re-applied')
    }
    await setRun(ctx, itemId, { stage: 'recovering', recoveryPolls: 0, recoveryStartedAt: new Date(now), verifyDueAt: next(1) })
    await ctx.alert(`item #${itemId}: media row lost after a scan, recovering by path`, { itemId, mediaId: run.mediaId, path: run.targetPath, foundPath: f?.path ?? null })
    throw new Defer(Math.ceil((next(1).getTime() - ctx.now()) / 1000), 'recovering')
  }

  // recovering
  const m = await findMediaByPath(ctx.azuracast, run.targetPath!)
  if (m) {
    const stationIds = await stationPlaylistIds(ctx.db)
    await reapplySnapshot(ctx.azuracast, m.id, run.targetPath!, snap, stationIds)
    await remapMediaId(ctx.db, run.mediaId!, m.id, m.unique_id)
    const recoveries = run.recoveries + 1
    await setRun(ctx, itemId, { stage: 'verifying', mediaId: m.id, uniqueId: m.unique_id, recoveries, recoveryPolls: 0, repairs: 0, verifyDueAt: next(2) })
    await audit(ctx.db, { action: 'item.ingest.recovered', targetType: 'item', targetId: itemId, detail: { oldMediaId: run.mediaId, newMediaId: m.id } })
    await ctx.alert(`item #${itemId}: lost media row recovered (id ${run.mediaId} → ${m.id})`, { itemId, oldMediaId: run.mediaId, newMediaId: m.id, path: run.targetPath })
    if (recoveries > MAX_RECOVERIES) return failIngest(ctx, itemId, 'recovery_loop', { recoveries })
    throw new Defer(Math.ceil((next(2).getTime() - ctx.now()) / 1000), 'recovered, re-verifying')
  }
  const polls = run.recoveryPolls + 1
  const elapsed = now - (run.recoveryStartedAt?.getTime() ?? now)
  if (polls >= RECOVERY_MIN_POLLS && elapsed >= RECOVERY_MIN_MS) return failIngest(ctx, itemId, 'recovery_failed', { polls, path: run.targetPath })
  await setRun(ctx, itemId, { recoveryPolls: polls, verifyDueAt: next(1) })
  throw new Defer(Math.ceil((next(1).getTime() - ctx.now()) / 1000), 'recovery poll')
}
