// P4 worker jobs (plan §3.7): request tickets, apply_edit, move, archive,
// restore, manager playlist merges, and the post-scan re-verify with lost-row
// recovery. Every AzuraCast call goes through the wrapper, which re-asserts
// the allowlist, the station, the profile and the Portal-Test prefix.
//
// Order of checks for a file move (move / archive / restore): scan window →
// fresh GET → path assertions → not on air → collision (files/list with
// flushCache) → snapshot → batch move (non-empty errors[] = failure) → GET
// verify → playlists re-applied if needed → post snapshot → re-verify after
// the next two scans.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { AzuraCastError, mergePlaylists, type StationMedia } from '../../server/azuracast/client'
import { audit } from '../../server/audit'
import { archive, artists, mediaSnapshots, requests, users } from '../../server/db/schema'
import { enqueue, type JobKind } from '../../server/jobs'
import {
  archiveDirPath,
  artistDirPath,
  assertArtistFileSource,
  assertArtistMoveTarget,
  assertRestore,
  basename,
  dirname,
  newArtistFolder,
  PathError,
  patterns,
} from '../../server/paths/builder'
import {
  activeFolders,
  applyProposed,
  isRequestTarget,
  mainArtist,
  mainArtistChanged,
  META_KEYS,
  metaOf,
  ProposedSchema,
  resolveArtist,
  sameMeta,
  type Meta,
} from '../../server/requests/common'
import { getIntList } from '../../server/settings'
import { TicketsApiError } from '../../server/tickets/client'
import { Permanent, RetryLater, type WorkerCtx } from '../handlers'
import { OpFailed, remapMediaId, sameIds, snapshotMeta, stationIds, stationPlaylistSet, takeSnapshot, upsertLibrary, type Snapshot } from './media'
import { afterScansMs, assertMutationWindow, assertNotOnAir, assertQueuesRunning, Deferred, scanOffset } from './window'

export type RequestsCtx = WorkerCtx & {
  root: string // PORTAL_TEST_PREFIX or ''
  now?: () => number
  // Follow-up jobs; defaults to the jobs table (tests capture them).
  schedule?: (kind: JobKind, payload: Record<string, unknown>, opts?: { dedupeKey?: string; runAfter?: Date }) => Promise<void>
}

type Actor = { actorUserId?: string | null; actorDiscordId?: string | null }

const now = (ctx: RequestsCtx) => (ctx.now ? ctx.now() : Date.now())
const schedule = (ctx: RequestsCtx, kind: JobKind, payload: Record<string, unknown>, opts: { dedupeKey?: string; runAfter?: Date } = {}) =>
  ctx.schedule ? ctx.schedule(kind, payload, opts) : enqueue(ctx.db, kind, payload, opts)

const actorOf = (p: Actor) => ({ actorUserId: p.actorUserId ?? null, actorDiscordId: p.actorDiscordId ?? null })

async function getFile(ctx: RequestsCtx, id: number): Promise<StationMedia> {
  try {
    return await ctx.azuracast.getFile(id)
  } catch (e) {
    if (e instanceof AzuraCastError && e.code === 'not_found') throw new OpFailed('media_missing', { mediaId: id })
    throw e
  }
}

function pathCheck<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof PathError) throw new OpFailed(`path_${e.code}`)
    throw e
  }
}

async function loadRequest(ctx: RequestsCtx, id: number) {
  const r = await ctx.db.query.requests.findFirst({ where: eq(requests.id, id) })
  if (!r) throw new Permanent('request missing')
  return r
}

// approved → applying (or already applying on a re-run). false: the request
// left the approved path (withdrawn, failed, done…) and the job is a no-op.
async function claim(ctx: RequestsCtx, id: number): Promise<boolean> {
  const rows = await ctx.db
    .update(requests)
    .set({ status: 'applying', updatedAt: new Date() })
    .where(and(eq(requests.id, id), inArray(requests.status, ['approved', 'applying'])))
    .returning({ id: requests.id })
  return rows.length === 1
}

export async function failRequest(ctx: RequestsCtx, requestId: number, code: string, detail: Record<string, unknown> = {}) {
  const rows = await ctx.db
    .update(requests)
    .set({ status: 'failed', error: code.slice(0, 100), updatedAt: new Date() })
    .where(and(eq(requests.id, requestId), inArray(requests.status, ['approved', 'applying', 'verifying'])))
    .returning({ id: requests.id })
  if (rows.length === 0) return
  await audit(ctx.db, { action: 'request.failed', targetType: 'request', targetId: requestId, detail: { code, ...detail } })
  await schedule(ctx, 'request_ticket_post', { requestId, event: 'failed' }, { dedupeKey: `request_ticket_post:${requestId}:failed` })
}

// Mutation done and verified: the request waits for the post-scan re-verify.
async function applied(ctx: RequestsCtx, requestId: number | null | undefined, post: Snapshot, offset: number) {
  if (requestId) {
    const rows = await ctx.db
      .update(requests)
      .set({ status: 'verifying', appliedAt: new Date(), error: null, updatedAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.status, 'applying')))
      .returning({ id: requests.id })
    if (rows.length) await schedule(ctx, 'request_ticket_post', { requestId, event: 'applied' }, { dedupeKey: `request_ticket_post:${requestId}:applied` })
  }
  await schedule(
    ctx,
    'reverify',
    { mediaId: post.mediaId, snapshotId: post.id, requestId: requestId ?? null, attempt: 0 },
    { dedupeKey: `reverify:${post.id}:0`, runAfter: new Date(afterScansMs(now(ctx), 2, offset)) },
  )
}

// ------------------------------------------------------------ tickets ---

function fromTickets(e: unknown): never {
  if (e instanceof TicketsApiError) {
    if (e.retryable) throw new RetryLater(e.retryAfterS ?? 30, `${e.status} ${e.code}`)
    throw new Permanent(`${e.status} ${e.code}`)
  }
  throw e
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function requestCard(r: typeof requests.$inferSelect) {
  const snap = (r.snapshot ?? {}) as Partial<Meta>
  const proposed = (r.proposed ?? {}) as Partial<Meta>
  const lines = [clip(`Song: ${snap.artist || '?'} - ${snap.title || '?'}`, 200), clip(`Media id: ${r.mediaId}`, 200)]
  if (r.kind === 'edit') {
    for (const k of META_KEYS) {
      if (proposed[k] === undefined) continue
      const label = k[0]!.toUpperCase() + k.slice(1)
      lines.push(clip(`${label}: "${snap[k] ?? ''}" → "${proposed[k]}"`, 200))
    }
  }
  if (r.reason) lines.push(clip(`Reason: ${r.reason.replace(/\s+/g, ' ')}`, 200))
  return lines.slice(0, 25)
}

export async function requestTicketOpen(ctx: RequestsCtx, payload: { requestId: number }) {
  const r = await loadRequest(ctx, payload.requestId)
  if (r.ticketId) return
  const owner = await ctx.db.query.users.findFirst({ where: eq(users.id, r.ownerUserId) })
  if (!owner) throw new Permanent('owner missing')
  const what = r.kind === 'edit' ? 'edit' : 'removal'
  let res
  try {
    res = await ctx.tickets.openTicket({
      categoryKey: r.kind === 'edit' ? 'songedit' : 'songremoval',
      openerDiscordId: owner.discordId,
      subject: `Song ${what} request #${r.id}`,
      card: { title: clip(`Song ${what} request #${r.id}`, 100), lines: requestCard(r), link: { label: 'Open in portal', url: `${ctx.portalOrigin}/requests/${r.id}` } },
      externalRef: `request:${r.id}`,
    })
  } catch (e) {
    fromTickets(e)
  }
  await ctx.db
    .update(requests)
    .set({ ticketId: res.ticketId, ticketNumber: res.number, ticketWebUrl: res.webUrl, ticketChannelUrl: res.discordChannelUrl, ticketStatus: 'open', updatedAt: new Date() })
    .where(and(eq(requests.id, r.id), sql`${requests.ticketId} IS NULL`))
  await audit(ctx.db, { action: 'ticket.opened', targetType: 'request', targetId: r.id, detail: { ticketId: res.ticketId, created: res.created } })
}

const EVENTS = ['approved', 'denied', 'applied', 'failed'] as const

export async function requestTicketPost(ctx: RequestsCtx, payload: { requestId: number; event: string }) {
  if (!(EVENTS as readonly string[]).includes(payload.event)) throw new Permanent('unknown request event')
  const r = await loadRequest(ctx, payload.requestId)
  if (!r.ticketId) throw new RetryLater(60, 'ticket not open yet')
  const snap = (r.snapshot ?? {}) as Partial<Meta>
  const name = `${snap.artist || '?'} - ${snap.title || '?'}`
  const what = r.kind === 'edit' ? 'Edit' : 'Removal'
  const body =
    payload.event === 'approved'
      ? `${what} request approved: ${name}. It will be applied automatically.`
      : payload.event === 'denied'
        ? `${what} request denied: ${name}\nReason: ${r.denyReason ?? ''}`
        : payload.event === 'applied'
          ? r.kind === 'edit'
            ? `Edit applied: ${name}.`
            : `Removed from rotation and archived: ${name}.`
          : `${what} request could not be applied: ${name}. Managers have been alerted.${r.error ? ` (${r.error})` : ''}`
  try {
    await ctx.tickets.postMessage(r.ticketId, { kind: 'system', body: body.slice(0, 1800), itemRef: `request:${r.id}` }, `request:${r.id}:${payload.event}`)
  } catch (e) {
    fromTickets(e)
  }
}

// --------------------------------------------------------- apply_edit ---

type ApplyEditPayload = Actor & { requestId?: number; mediaId?: number; proposed?: unknown }

export async function applyEdit(ctx: RequestsCtx, payload: ApplyEditPayload) {
  const req = payload.requestId ? await loadRequest(ctx, payload.requestId) : null
  if (req && req.kind !== 'edit') throw new Permanent('not an edit request')
  if (req && req.status !== 'approved' && req.status !== 'applying') return
  const mediaId = req ? req.mediaId : Number(payload.mediaId)
  const parsed = ProposedSchema.safeParse(req ? req.proposed : payload.proposed)
  if (!parsed.success) throw new OpFailed('invalid_proposed')

  const media = await getFile(ctx, mediaId)
  if (!isRequestTarget(ctx.root, media.path)) throw new OpFailed('target_not_allowed', { path: media.path })
  const current = metaOf(media)
  const next = applyProposed(current, parsed.data)
  // "Before" is the value the member saw when filing, so a re-run after the
  // PUT still knows the main artist changed.
  const before = req ? (((req.snapshot ?? {}) as Partial<Meta>).artist ?? current.artist) : current.artist

  let moveTo: string | null = null
  if (mainArtistChanged(before, next.artist)) {
    let a = await resolveArtist(ctx.db, next.artist)
    if (!a) {
      if (!req) throw new OpFailed('artist_not_active')
      const name = mainArtist(next.artist)
      const folder = pathCheck(() => newArtistFolder(name))
      await ctx.db.insert(artists).values({ name, folder, status: 'pending' }).onConflictDoNothing()
      a = (await ctx.db.query.artists.findFirst({ where: eq(artists.folder, folder) })) ?? null
      if (!a) throw new OpFailed('artist_create_failed')
      await audit(ctx.db, { action: 'artist.proposed', targetType: 'artist', targetId: a.id, detail: { name: a.name, folder: a.folder, requestId: req.id } })
    }
    if (a.status === 'pending') {
      if (!req) throw new OpFailed('artist_not_active')
      // Park the request on the new-artist approval; nothing is written yet.
      await ctx.db
        .update(requests)
        .set({ status: 'approved', pendingArtistId: a.id, updatedAt: new Date() })
        .where(and(eq(requests.id, req.id), inArray(requests.status, ['approved', 'applying'])))
      await audit(ctx.db, { action: 'request.awaiting_artist', targetType: 'request', targetId: req.id, detail: { artistId: a.id, folder: a.folder } })
      return
    }
    if (a.status !== 'active') throw new OpFailed('artist_not_active')
    const dir = pathCheck(() => artistDirPath(ctx.root, a.folder))
    if (dir !== dirname(media.path)) moveTo = dir
  }

  if (req) {
    if (!(await claim(ctx, req.id))) return
    if (req.pendingArtistId) await ctx.db.update(requests).set({ pendingArtistId: null }).where(eq(requests.id, req.id))
  }
  const station = await stationPlaylistSet(ctx.db)
  await takeSnapshot(ctx.db, media, station, 'before_edit', { requestId: req?.id })
  // Strict {title, artist, album, genre} body, built field by field by the
  // wrapper. AzuraCast's tag write may fail silently (TXXX mp3, m4a): the
  // API still reports success and the DB values are the truth.
  if (!sameMeta(current, next)) {
    await assertQueuesRunning(ctx.db)
    await ctx.azuracast.updateMetadata(mediaId, next)
  }
  const after = await getFile(ctx, mediaId)
  if (!sameMeta(metaOf(after), next)) throw new OpFailed('metadata_verify_failed')
  await upsertLibrary(ctx.db, after)
  await audit(ctx.db, { ...actorOf(payload), action: 'media.edit', targetType: 'media', targetId: mediaId, detail: { before: current, after: next, requestId: req?.id ?? null, moveTo } })
  if (moveTo) {
    await schedule(ctx, 'move', { mediaId, toDir: moveTo, requestId: req?.id ?? null, ...actorOf(payload) }, req ? { dedupeKey: `move:request:${req.id}` } : {})
    return
  }
  const post = await takeSnapshot(ctx.db, after, station, 'after_edit', { requestId: req?.id })
  await applied(ctx, req?.id, post, await scanOffset(ctx.db))
}

// --------------------------------------------------------------- move ---

type MovePayload = Actor & { mediaId: number; toDir: string; requestId?: number | null }

export async function move(ctx: RequestsCtx, payload: MovePayload) {
  const req = payload.requestId ? await loadRequest(ctx, payload.requestId) : null
  if (req && req.status !== 'applying') return
  const offset = await assertMutationWindow(ctx.db, now(ctx))
  const media = await getFile(ctx, payload.mediaId)
  const dest = `${payload.toDir}/${basename(media.path)}`
  const station = await stationPlaylistSet(ctx.db)
  let expected: number[] | null = null
  if (media.path !== dest) {
    pathCheck(() => {
      assertArtistFileSource(ctx.root, media.path)
      return null
    })
    const folders = await activeFolders(ctx.db)
    pathCheck(() => assertArtistMoveTarget(ctx.root, payload.toDir, folders))
    await assertNotOnAir(ctx.db, ctx.azuracast, media)
    if (await ctx.azuracast.pathTaken(payload.toDir, dest)) {
      await ctx.alert('move refused: destination exists', { mediaId: media.id, dest })
      throw new OpFailed('collision', { dest })
    }
    const pre = await takeSnapshot(ctx.db, media, station, 'before_move', { requestId: req?.id })
    expected = pre.playlistIds
    await assertQueuesRunning(ctx.db)
    try {
      await ctx.azuracast.moveFile(media.path, payload.toDir)
    } catch (e) {
      if (e instanceof AzuraCastError && e.code === 'batch_errors') throw new OpFailed('move_failed', { errors: e.detail })
      throw e
    }
  }
  let after = await getFile(ctx, payload.mediaId)
  if (after.path !== dest) throw new OpFailed('move_verify_failed', { path: after.path })
  if (expected && !sameIds(stationIds(after, station), expected)) {
    // Completes the move just made (not a new mutation): no pause check.
    await ctx.azuracast.setPlaylists(dest, expected, new Set(expected))
    after = await getFile(ctx, payload.mediaId)
    if (!sameIds(stationIds(after, station), expected)) throw new OpFailed('playlists_verify_failed')
  }
  await upsertLibrary(ctx.db, after)
  const post = await takeSnapshot(ctx.db, after, station, 'after_move', { requestId: req?.id })
  await audit(ctx.db, { ...actorOf(payload), action: 'media.move', targetType: 'media', targetId: media.id, detail: { from: media.path, to: dest, requestId: req?.id ?? null } })
  await applied(ctx, req?.id, post, offset)
}

// ------------------------------------------------------------ archive ---

type ArchivePayload = Actor & { mediaId?: number; requestId?: number }

export async function archiveMedia(ctx: RequestsCtx, payload: ArchivePayload) {
  const req = payload.requestId ? await loadRequest(ctx, payload.requestId) : null
  if (req && req.kind !== 'removal') throw new Permanent('not a removal request')
  if (req && req.status !== 'approved' && req.status !== 'applying') return
  const mediaId = req ? req.mediaId : Number(payload.mediaId)
  const offset = await assertMutationWindow(ctx.db, now(ctx))
  const media = await getFile(ctx, mediaId)

  const done = await ctx.db.query.archive.findFirst({ where: and(eq(archive.mediaId, mediaId), eq(archive.status, 'archived')) })
  if (done && media.path === done.archivedPath) {
    // Re-run after the move already happened.
    if (req && !(await claim(ctx, req.id))) return
    const station = await stationPlaylistSet(ctx.db)
    await applied(ctx, req?.id, await takeSnapshot(ctx.db, media, station, 'after_archive', { requestId: req?.id }), offset)
    return
  }
  if (!isRequestTarget(ctx.root, media.path)) throw new OpFailed('target_not_allowed', { path: media.path })
  pathCheck(() => assertArtistFileSource(ctx.root, media.path))
  const archDir = pathCheck(() => archiveDirPath(ctx.root, mediaId))
  const dest = `${archDir}/${basename(media.path)}`
  await assertNotOnAir(ctx.db, ctx.azuracast, media)
  if (req && !(await claim(ctx, req.id))) return
  if (await ctx.azuracast.pathTaken(archDir, dest)) {
    await ctx.alert('archive refused: destination exists', { mediaId, dest })
    throw new OpFailed('collision', { dest })
  }
  const station = await stationPlaylistSet(ctx.db)
  const snap = await takeSnapshot(ctx.db, media, station, 'before_archive', { requestId: req?.id })
  const allowed = new Set(snap.playlistIds)
  const reapply = async () => {
    try {
      const cur = await ctx.azuracast.getFile(mediaId)
      if (cur.path === media.path) await ctx.azuracast.setPlaylists(media.path, snap.playlistIds, allowed)
      else await ctx.alert('archive rollback: file not at its original path', { mediaId, path: cur.path })
    } catch (e) {
      await ctx.alert('archive rollback failed: playlists NOT re-applied', { mediaId, snapshotId: snap.id, error: e instanceof Error ? e.message : 'error' })
    }
  }

  // 1. clear every membership (REPLACE with []), 2. verify zero memberships.
  // The pause is checked once, before the first write: clear + move (+ the
  // rollback) is one unit and is never left half done.
  await assertQueuesRunning(ctx.db)
  await ctx.azuracast.setPlaylists(media.path, [], allowed)
  const cleared = await getFile(ctx, mediaId)
  if (playlistCount(cleared) !== 0) {
    await reapply()
    throw new OpFailed('memberships_remain', { playlists: cleared.playlists?.map((p) => p.id) })
  }
  // 3. move to Removed/<media_id>/ (per-id folder: same file names never collide).
  let after: StationMedia
  try {
    await ctx.azuracast.moveFile(media.path, archDir)
    after = await ctx.azuracast.getFile(mediaId)
    if (after.path !== dest) throw new Error('archive_verify_failed')
  } catch (e) {
    await reapply()
    throw new OpFailed('archive_move_failed', { error: e instanceof Error ? e.message : 'error' })
  }
  await ctx.db.insert(archive).values({
    mediaId,
    uniqueId: media.unique_id,
    originalPath: media.path,
    archivedPath: dest,
    snapshotId: snap.id,
    requestId: req?.id ?? null,
    status: 'archived',
  })
  await upsertLibrary(ctx.db, after) // now under Removed/: off the request surface
  const post = await takeSnapshot(ctx.db, after, station, 'after_archive', { requestId: req?.id })
  await audit(ctx.db, { ...actorOf(payload), action: 'media.archive', targetType: 'media', targetId: mediaId, detail: { from: media.path, to: dest, snapshotId: snap.id, requestId: req?.id ?? null } })
  await applied(ctx, req?.id, post, offset)
}

const playlistCount = (m: StationMedia) => (m.playlists ?? []).length

// ------------------------------------------------------------ restore ---

export async function restoreMedia(ctx: RequestsCtx, payload: Actor & { archiveId: number }) {
  const a = await ctx.db.query.archive.findFirst({ where: eq(archive.id, payload.archiveId) })
  if (!a) throw new Permanent('archive row missing')
  if (a.status !== 'archived') return
  const offset = await assertMutationWindow(ctx.db, now(ctx))
  const media = await getFile(ctx, a.mediaId)
  if (media.path !== a.archivedPath) throw new OpFailed('archived_path_mismatch', { path: media.path })
  const { target } = pathCheck(() => assertRestore(ctx.root, media.path, a.originalPath, a))
  const dir = dirname(target)
  await assertNotOnAir(ctx.db, ctx.azuracast, media)
  if (await ctx.azuracast.pathTaken(dir, target)) {
    await ctx.alert('restore refused: original path is taken', { archiveId: a.id, target })
    throw new OpFailed('collision', { target })
  }
  const snap = a.snapshotId ? await ctx.db.query.mediaSnapshots.findFirst({ where: eq(mediaSnapshots.id, a.snapshotId) }) : null
  if (!snap) throw new OpFailed('archive_snapshot_missing')
  const station = await stationPlaylistSet(ctx.db)
  await takeSnapshot(ctx.db, media, station, 'before_restore')
  await assertQueuesRunning(ctx.db)
  try {
    await ctx.azuracast.moveFile(media.path, dir)
  } catch (e) {
    if (e instanceof AzuraCastError && e.code === 'batch_errors') throw new OpFailed('restore_move_failed', { errors: e.detail })
    throw e
  }
  let after = await getFile(ctx, a.mediaId)
  if (after.path !== target) throw new OpFailed('restore_verify_failed', { path: after.path })
  const want = snapshotMeta(snap)
  if (!sameMeta(metaOf(after), want)) await ctx.azuracast.updateMetadata(a.mediaId, want)
  // Re-apply the snapshot's station memberships (sequential positions are lost).
  await ctx.azuracast.setPlaylists(target, snap.playlistIds, new Set(snap.playlistIds))
  after = await getFile(ctx, a.mediaId)
  if (!sameIds(stationIds(after, station), snap.playlistIds)) throw new OpFailed('playlists_verify_failed')
  await ctx.db.update(archive).set({ status: 'restored', restoredAt: new Date() }).where(and(eq(archive.id, a.id), eq(archive.status, 'archived')))
  await upsertLibrary(ctx.db, after)
  const post = await takeSnapshot(ctx.db, after, station, 'after_restore')
  await audit(ctx.db, { ...actorOf(payload), action: 'media.restore', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, to: target, playlistIds: snap.playlistIds } })
  await applied(ctx, null, post, offset)
}

// ------------------------------------------------- manager playlists ---

// MERGE (plan §3.3): only the assignable ids are replaced; every other
// station membership is kept, and foreign-station ids (Events, from the
// shared storage) are never sent back.
export async function setPlaylistsJob(ctx: RequestsCtx, payload: Actor & { mediaId: number; chosen: number[] }) {
  const media = await getFile(ctx, payload.mediaId)
  if (!isRequestTarget(ctx.root, media.path)) throw new OpFailed('target_not_allowed', { path: media.path })
  const station = await stationPlaylistSet(ctx.db)
  const assignable = new Set((await getIntList(ctx.db, 'assignable_playlist_ids')).filter((id) => station.has(id)))
  const current = (media.playlists ?? []).map((p) => p.id)
  let merged: number[]
  try {
    merged = mergePlaylists({ current, stationPlaylistIds: station, assignable, chosen: payload.chosen })
  } catch {
    throw new OpFailed('playlist_not_assignable')
  }
  const before = stationIds(media, station)
  await takeSnapshot(ctx.db, media, station, 'before_playlists')
  const allowed = new Set([...assignable, ...before])
  await assertQueuesRunning(ctx.db)
  await ctx.azuracast.setPlaylists(media.path, merged, allowed)
  const after = await getFile(ctx, payload.mediaId)
  if (!sameIds(stationIds(after, station), merged)) throw new OpFailed('playlists_verify_failed')
  await upsertLibrary(ctx.db, after)
  await audit(ctx.db, { ...actorOf(payload), action: 'media.playlists', targetType: 'media', targetId: media.id, detail: { before, after: merged, chosen: payload.chosen } })
}

// ----------------------------------------------------------- reverify ---

const RECOVERY_MIN_CYCLES = 3
const RECOVERY_MIN_MS = 20 * 60_000

type ReverifyPayload = { mediaId: number; snapshotId: number; requestId?: number | null; attempt?: number; lostSince?: number }

async function reapplyState(ctx: RequestsCtx, id: number, snap: Snapshot, station: ReadonlySet<number>, media: StationMedia) {
  if (!patterns(ctx.root).artistFile.test(snap.path)) return // archived: no metadata/playlist writes under Removed/
  await assertQueuesRunning(ctx.db)
  if (!sameMeta(metaOf(media), snapshotMeta(snap))) await ctx.azuracast.updateMetadata(id, snapshotMeta(snap))
  if (!sameIds(stationIds(media, station), snap.playlistIds)) await ctx.azuracast.setPlaylists(snap.path, snap.playlistIds, new Set(snap.playlistIds))
}

async function done(ctx: RequestsCtx, requestId: number | null | undefined) {
  if (!requestId) return
  await ctx.db.update(requests).set({ status: 'done', updatedAt: new Date() }).where(and(eq(requests.id, requestId), eq(requests.status, 'verifying')))
}

export async function reverify(ctx: RequestsCtx, payload: ReverifyPayload) {
  const snap = await ctx.db.query.mediaSnapshots.findFirst({ where: eq(mediaSnapshots.id, payload.snapshotId) })
  if (!snap) throw new Permanent('snapshot missing')
  const attempt = payload.attempt ?? 0
  const station = await stationPlaylistSet(ctx.db)
  const offset = await scanOffset(ctx.db)
  const again = (extra: Partial<ReverifyPayload>, n = 1) =>
    schedule(
      ctx,
      'reverify',
      { ...payload, ...extra, attempt: attempt + 1 },
      { dedupeKey: `reverify:${snap.id}:${attempt + 1}`, runAfter: new Date(afterScansMs(now(ctx), n, offset)) },
    )

  let media: StationMedia | null
  try {
    media = await ctx.azuracast.getFile(payload.mediaId)
  } catch (e) {
    if (!(e instanceof AzuraCastError && e.code === 'not_found')) throw e
    media = null
  }

  if (media) {
    if (media.path !== snap.path) throw new OpFailed('reverify_path_changed', { expected: snap.path, actual: media.path })
    const ok = sameMeta(metaOf(media), snapshotMeta(snap)) && sameIds(stationIds(media, station), snap.playlistIds)
    if (ok) return done(ctx, payload.requestId)
    if (attempt >= 2) throw new OpFailed('reverify_mismatch')
    await reapplyState(ctx, media.id, snap, station, media)
    await audit(ctx.db, { action: 'media.reverify_reapplied', targetType: 'media', targetId: media.id, detail: { snapshotId: snap.id, attempt } })
    return again({})
  }

  // The id vanished after a scan: recovery. Look for the file at its path
  // (files/list with flushCache sees scanned and unscanned files).
  const entries = await ctx.azuracast.listDirectory(dirname(snap.path))
  const found = entries.find((e) => e.path === snap.path && e.media)?.media ?? null
  if (!found) {
    const lostSince = payload.lostSince ?? now(ctx)
    if (attempt + 1 >= RECOVERY_MIN_CYCLES && now(ctx) - lostSince >= RECOVERY_MIN_MS) {
      await ctx.alert('recovery failed: media row lost', { mediaId: payload.mediaId, path: snap.path, snapshotId: snap.id })
      throw new OpFailed('recovery_failed', { path: snap.path })
    }
    return again({ lostSince })
  }
  const oldId = payload.mediaId
  // Snapshot METADATA first, then the snapshot playlists, then remap ids.
  await reapplyState(ctx, found.id, snap, station, found)
  const fresh = await ctx.azuracast.getFile(found.id)
  await remapMediaId(ctx.db, oldId, fresh)
  const ok = fresh.path === snap.path && sameMeta(metaOf(fresh), snapshotMeta(snap)) && sameIds(stationIds(fresh, station), snap.playlistIds)
  await audit(ctx.db, { action: 'media.recovered', targetType: 'media', targetId: fresh.id, detail: { oldId, newId: fresh.id, path: snap.path, verified: ok } })
  await ctx.alert('media row recovered under a new id', { oldId, newId: fresh.id, path: snap.path })
  if (!ok) throw new OpFailed('recovery_verify_failed')
  await done(ctx, payload.requestId)
}

// ---------------------------------------------------------- sweeping ---

// Requests parked on a new-artist approval: resume once the artist is
// active (whichever surface approved it), fail if it was denied.
export async function sweepParkedRequests(ctx: RequestsCtx): Promise<number> {
  const rows = await ctx.db
    .select({ id: requests.id, artistId: artists.id, artistStatus: artists.status })
    .from(requests)
    .innerJoin(artists, eq(artists.id, requests.pendingArtistId))
    .where(and(eq(requests.status, 'approved'), isNotNull(requests.pendingArtistId), inArray(artists.status, ['active', 'denied', 'archived'])))
    .limit(50)
  for (const r of rows) {
    if (r.artistStatus === 'active') await schedule(ctx, 'apply_edit', { requestId: r.id }, { dedupeKey: `apply_edit:request:${r.id}:artist:${r.artistId}` })
    else await failRequest(ctx, r.id, 'artist_denied', { artistId: r.artistId })
  }
  return rows.length
}

// ------------------------------------------------------------ runner ---

export const REQUEST_JOB_KINDS = new Set<string>(['request_ticket_open', 'request_ticket_post', 'apply_edit', 'move', 'archive', 'restore', 'set_playlists', 'reverify'])

function transient(e: unknown): boolean {
  if (e instanceof Deferred || e instanceof OpFailed || e instanceof Permanent) return false
  if (e instanceof RetryLater) return true
  if (e instanceof AzuraCastError) {
    const st = (e.detail as { status?: number } | undefined)?.status
    return e.code === 'http_error' && typeof st === 'number' && (st >= 500 || st === 429)
  }
  // fetch/network/timeout errors
  return e instanceof TypeError || (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))
}

type JobRow = { id: number; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }

// Runs one P4 job. A failure that retrying will not fix marks the request
// failed, posts to its ticket and alerts; the job itself then completes.
export async function runRequestJob(ctx: RequestsCtx, job: JobRow): Promise<void> {
  const p = job.payload
  try {
    switch (job.kind) {
      case 'request_ticket_open':
        return await requestTicketOpen(ctx, p as { requestId: number })
      case 'request_ticket_post':
        return await requestTicketPost(ctx, p as { requestId: number; event: string })
      case 'apply_edit':
        return await applyEdit(ctx, p as ApplyEditPayload)
      case 'move':
        return await move(ctx, p as MovePayload)
      case 'archive':
        return await archiveMedia(ctx, p as ArchivePayload)
      case 'restore':
        return await restoreMedia(ctx, p as Actor & { archiveId: number })
      case 'set_playlists':
        return await setPlaylistsJob(ctx, p as Actor & { mediaId: number; chosen: number[] })
      case 'reverify':
        return await reverify(ctx, p as ReverifyPayload)
      default:
        throw new Permanent(`unknown job kind ${job.kind}`)
    }
  } catch (e) {
    if (e instanceof Deferred) throw e
    if (job.kind === 'request_ticket_open' || job.kind === 'request_ticket_post') throw e
    if (transient(e) && job.attempts < job.max_attempts) throw e
    const code = e instanceof OpFailed ? e.code : e instanceof AzuraCastError ? `azuracast_${e.code}` : e instanceof Error ? e.name : 'error'
    const requestId = typeof p.requestId === 'number' ? p.requestId : null
    if (requestId) await failRequest(ctx, requestId, code)
    await audit(ctx.db, { action: `job.${job.kind}.failed`, targetType: 'job', targetId: job.id, detail: { code, payload: p } })
    await ctx.alert(`${job.kind} failed (${code})`, { jobId: job.id, requestId, mediaId: p.mediaId ?? null, archiveId: p.archiveId ?? null, detail: e instanceof OpFailed ? (e.detail ?? null) : null })
  }
}
