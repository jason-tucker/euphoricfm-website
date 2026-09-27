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
//
// Archive and restore are resumable: the archive row is written with status
// 'archiving' (and the before_archive snapshot) before the first write, and
// flipped to 'restoring' before the restore move, so a re-run after a crash,
// a lost response or a transient error continues from where the file really
// is instead of snapshotting a half-done state.
//
// Every re-verify re-applies its snapshot only while that snapshot is still
// the latest portal snapshot of the media (a newer mutation supersedes it),
// and re-adds missing playlist memberships by merge, never by a REPLACE
// with an old set.

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { imageComplete, imageDims, sniffImage } from '../../probe/cover'
import { AzuraCastError, mergePlaylists, type StationMedia } from '../../server/azuracast/client'
import { audit } from '../../server/audit'
import { archive, artists, artUploads, mediaSnapshots, requests, users } from '../../server/db/schema'
import { enqueue, type JobKind } from '../../server/jobs'
import {
  archiveDirPath,
  artistDirPath,
  assertArchiveDir,
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
import { isUsableArt, loadArt } from '../../server/library/art'
import { assertQueuesNotPaused, QueuesPausedError } from '../../server/pause'
import { getIntList } from '../../server/settings'
import { TicketsApiError } from '../../server/tickets/client'
import { Permanent, RetryLater, TRANSIENT_MAX_AGE_S, type WorkerCtx } from '../handlers'
import { afterScans, assertMutationWindow, assertNotOnAir, scanOffsetS } from '../ingest/window'
import { findMediaByPath, reapplySnapshot, remapMediaId } from '../library/recovery'
import { OpFailed, playlistIdsOf, sameIds, snapshotMeta, stationIds, stationPlaylistSet, takeSnapshot, upsertLibrary, type Snapshot } from './media'

export type RequestsCtx = WorkerCtx & {
  root: string // PORTAL_TEST_PREFIX or ''
  now?: () => number
  // Follow-up jobs; defaults to the jobs table (tests capture them).
  schedule?: (kind: JobKind, payload: Record<string, unknown>, opts?: { dedupeKey?: string; runAfter?: Date }) => Promise<void>
}

export function isRequestsCtx(ctx: WorkerCtx): ctx is RequestsCtx {
  return typeof (ctx as Partial<RequestsCtx>).root === 'string'
}

type Actor = { actorUserId?: string | null; actorDiscordId?: string | null }

const now = (ctx: RequestsCtx) => (ctx.now ? ctx.now() : Date.now())
// The foundation's pause (server/pause.ts), re-checked right before each
// AzuraCast write; the wrapper's write gate refuses the write again.
const assertQueuesRunning = (db: RequestsCtx['db']) => assertQueuesNotPaused(db)
const mutationWindow = (ctx: RequestsCtx) => assertMutationWindow(ctx.db, now(ctx), ctx.alert)

// AzuraCast bumps `art_updated_at` (unix s, 0 = no custom art) when art is
// written. apply_art verifies by it moving forward.
export function artStamp(m: StationMedia): number {
  const v = (m as Record<string, unknown>).art_updated_at
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
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
    { dedupeKey: `reverify:${post.id}:0`, runAfter: new Date(afterScans(now(ctx), 2, offset)) },
  )
}

// ------------------------------------------------------------ tickets ---

function fromTickets(e: unknown): never {
  if (e instanceof TicketsApiError) {
    if (e.retryable) throw new RetryLater(e.retryAfterS ?? 30, `${e.status} ${e.code}`, { maxAgeS: TRANSIENT_MAX_AGE_S })
    throw new Permanent(`${e.status} ${e.code}`)
  }
  throw e
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function requestCard(r: typeof requests.$inferSelect) {
  const snap = (r.snapshot ?? {}) as Partial<Meta>
  const proposed = (r.proposed ?? {}) as Partial<Meta> & { artId?: string }
  const lines = [clip(`Song: ${snap.artist || '?'} - ${snap.title || '?'}`, 200), clip(`Media id: ${r.mediaId}`, 200)]
  if (r.kind === 'edit') {
    for (const k of META_KEYS) {
      if (proposed[k] === undefined) continue
      const label = k[0]!.toUpperCase() + k.slice(1)
      lines.push(clip(`${label}: "${snap[k] ?? ''}" → "${proposed[k]}"`, 200))
    }
  }
  if (r.kind === 'edit' && proposed.artId !== undefined) lines.push('New album art proposed')
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

// The ticket's "could not be applied" text: what a manager has to do for the
// failures a retry cannot fix, else the generic line. requests.error is
// `<code>` or `<code>: <detail>`.
export function requestFailureText(r: Pick<typeof requests.$inferSelect, 'error'>, what: string, name: string): string {
  const err = r.error ?? ''
  const code = err.split(':')[0]!
  const head = `${what} request could not be applied: ${name}.`
  if (code === 'in_events_playlists') {
    const ids = err.slice(code.length + 1).trim() || '?'
    return `${head} The song is also in Events playlist(s) ${ids} (station 14), so it was not removed and nothing was changed. A manager must take it out of those playlists in AzuraCast first, then queue the removal again. (${err})`
  }
  if (code === 'artist_folder_taken') {
    return `${head} The new artist name maps to a folder that already belongs to a different artist, so nothing was changed. A manager must choose another spelling (or merge the two artists by hand). (${err})`
  }
  return `${head} Managers have been alerted.${err ? ` (${err})` : ''}`
}

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
            ? `Edit applied: ${name}.${proposedArtId(r) ? ' The new album art is live.' : ''}`
            : `Removed from rotation and archived: ${name}.`
          : requestFailureText(r, what, name)
  try {
    await ctx.tickets.postMessage(r.ticketId, { kind: 'system', body: body.slice(0, 1800), itemRef: `request:${r.id}` }, `request:${r.id}:${payload.event}`)
  } catch (e) {
    fromTickets(e)
  }
}

// --------------------------------------------------------- apply_edit ---

// beforeArtist: the artist the manager saw when queueing a direct edit
// (server/requests/manage.ts directEdit).
type ApplyEditPayload = Actor & { requestId?: number; mediaId?: number; proposed?: unknown; beforeArtist?: unknown }

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
  // "Before" is the value the member saw when filing (or the manager when
  // queueing a direct edit), so a re-run after the PUT still knows the main
  // artist changed and still queues the folder move.
  const before = req
    ? (((req.snapshot ?? {}) as Partial<Meta>).artist ?? current.artist)
    : typeof payload.beforeArtist === 'string'
      ? payload.beforeArtist
      : current.artist

  let moveTo: string | null = null
  if (mainArtistChanged(before, next.artist)) {
    let a = await resolveArtist(ctx.db, next.artist)
    if (!a) {
      if (!req) throw new OpFailed('artist_not_active')
      const name = mainArtist(next.artist)
      const folder = pathCheck(() => newArtistFolder(name))
      // resolveArtist matched no name, folder or alias, so an artist that
      // already owns this sanitized folder ("AC DC" for "AC/DC") is a
      // DIFFERENT artist: never merge into its folder, and never wait on or
      // fail with its approval state. Same rule as the batch flow
      // (library/artists.ts approveNewArtist → artist_folder_taken).
      const taken = async () => {
        const owner = await ctx.db.query.artists.findFirst({ where: sql`lower(${artists.folder}) = lower(${folder})` })
        if (owner) throw new OpFailed('artist_folder_taken', { name, folder, artistId: owner.id, artistName: owner.name, artistStatus: owner.status, note: folder })
      }
      await taken()
      const [created] = await ctx.db.insert(artists).values({ name, folder, status: 'pending' }).onConflictDoNothing().returning()
      if (!created) await taken()
      if (!created) throw new OpFailed('artist_create_failed')
      a = created
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
  // Art comes after the metadata (and after any move).
  if (await chainArt(ctx, req, parsed.data.artId ?? null, mediaId, payload)) return
  await applied(ctx, req?.id, post, await scanOffsetS(ctx.db))
}

function proposedArtId(r: typeof requests.$inferSelect): string | null {
  const a = (r.proposed as { artId?: unknown } | null)?.artId
  return typeof a === 'string' && a.length > 0 ? a : null
}

async function chainArt(ctx: RequestsCtx, req: typeof requests.$inferSelect | null, artId: string | null, mediaId: number, a: Actor): Promise<boolean> {
  if (!artId) return false
  await schedule(ctx, 'apply_art', req ? { requestId: req.id } : { mediaId, artId, ...actorOf(a) }, req ? { dedupeKey: `apply_art:request:${req.id}` } : {})
  return true
}

// ---------------------------------------------------------- apply_art ---

type ApplyArtPayload = Actor & { requestId?: number | null; mediaId?: number; artId?: string }

// Snapshot (had art + the old art's sha256, read through the wrapper's
// read-only art GET) → uploadArt with the probe JPEG and its recorded sha
// (the wrapper re-hashes the bytes, resolves the media id to a
// Music/Artists file under the prefix and runs the write gate) → verify:
// art_updated_at moved AND the art AzuraCast now serves is ours (artCheck)
// → ticket post.
export async function applyArt(ctx: RequestsCtx, payload: ApplyArtPayload) {
  const req = payload.requestId ? await loadRequest(ctx, payload.requestId) : null
  if (req && req.status !== 'applying') return
  const artId = req ? proposedArtId(req) : (payload.artId ?? null)
  if (!artId) throw new OpFailed('no_art')
  const mediaId = req ? req.mediaId : Number(payload.mediaId)
  const offset = await mutationWindow(ctx)
  const media = await getFile(ctx, mediaId)
  if (!isRequestTarget(ctx.root, media.path)) throw new OpFailed('target_not_allowed', { path: media.path })
  const art = await loadArt(ctx.db, artId)
  if (!isUsableArt(art)) throw new OpFailed('art_not_ready', { artId })
  const [dims] = await ctx.db.select({ width: artUploads.width, height: artUploads.height }).from(artUploads).where(eq(artUploads.id, art.id)).limit(1)
  const station = await stationPlaylistSet(ctx.db)
  const before = artStamp(media)
  // The old art as AzuraCast serves it: its hash goes into the snapshot, so
  // a mistaken change can be identified and put back by hand.
  const old = await ctx.azuracast.getArt(mediaId)
  const oldSha = old.kind === 'art' ? old.sha256 : null
  await takeSnapshot(ctx.db, media, station, 'before_art', { requestId: req?.id }, { hadArt: before > 0 || old.kind === 'art', artSha256: oldSha })
  await assertQueuesRunning(ctx.db)
  try {
    await ctx.azuracast.uploadArt(mediaId, art.jpegPath, art.jpegSha256)
  } catch (e) {
    if (e instanceof AzuraCastError && ['sha_mismatch', 'art_missing', 'refused_art_path', 'refused_art_shape', 'refused_art_not_jpeg'].includes(e.code)) {
      throw new OpFailed(`art_${e.code}`, { artId })
    }
    throw e
  }
  const after = await getFile(ctx, mediaId)
  if (!(artStamp(after) > before)) throw new OpFailed('art_verify_failed', { reason: 'art_updated_at_unchanged' })
  const served = await ctx.azuracast.getArt(mediaId)
  const bad = artCheck(served, { sha256: art.jpegSha256, width: dims?.width ?? null, height: dims?.height ?? null }, oldSha)
  if (bad || served.kind !== 'art') throw new OpFailed('art_verify_failed', { reason: bad ?? 'no_art_served' })
  await upsertLibrary(ctx.db, after)
  const post = await takeSnapshot(ctx.db, after, station, 'after_art', { requestId: req?.id }, { hadArt: true, artSha256: served.sha256 })
  await audit(ctx.db, {
    ...actorOf(payload),
    action: 'media.art',
    targetType: 'media',
    targetId: mediaId,
    detail: { artId, jpegSha256: art.jpegSha256, servedSha256: served.sha256, hadArt: before > 0 || old.kind === 'art', oldArtSha256: oldSha, requestId: req?.id ?? null },
  })
  await applied(ctx, req?.id, post, offset)
}

// Is the art AzuraCast serves after the upload the probe JPEG we sent?
// AzuraCast stores a re-encoded copy (resized to ≤1500 px, and the probe's
// output is ≤1000 px, so the dimensions survive), so byte equality is not
// required: the exact probe bytes pass; otherwise it must be a complete JPEG
// with the probe output's dimensions, or, when those were not recorded, one
// that at least differs from the old art. Returns the failure reason.
export function artCheck(
  served: Awaited<ReturnType<RequestsCtx['azuracast']['getArt']>>,
  probe: { sha256: string; width: number | null; height: number | null },
  oldSha: string | null,
): string | null {
  if (served.kind !== 'art') return 'no_art_served'
  if (served.sha256 === probe.sha256) return null
  if (sniffImage(served.bytes) !== 'jpeg' || !imageComplete(served.bytes, 'jpeg')) return 'not_a_complete_jpeg'
  const d = imageDims(served.bytes, 'jpeg')
  if (!d) return 'unreadable_jpeg'
  if (probe.width && probe.height) return d.w === probe.width && d.h === probe.height ? null : 'dimensions_differ'
  if (oldSha && served.sha256 === oldSha) return 'unchanged'
  return null
}

// --------------------------------------------------------------- move ---

type MovePayload = Actor & { mediaId: number; toDir: string; requestId?: number | null }

export async function move(ctx: RequestsCtx, payload: MovePayload) {
  const req = payload.requestId ? await loadRequest(ctx, payload.requestId) : null
  if (req && req.status !== 'applying') return
  const offset = await mutationWindow(ctx)
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
  if (await chainArt(ctx, req, req ? proposedArtId(req) : null, media.id, payload)) return
  await applied(ctx, req?.id, post, offset)
}

// ------------------------------------------------------------ archive ---

type ArchivePayload = Actor & { mediaId?: number; requestId?: number }
type ArchiveRow = typeof archive.$inferSelect

// Move/batch failures AzuraCast (or the wrapper, before sending) reported
// definitively: the file was not moved, and retrying the same move will not
// help. Anything else (a timeout, a lost response, a 5xx) may or may not have
// moved it: the file's actual location decides.
function definitiveMoveError(e: unknown): boolean {
  return e instanceof AzuraCastError && ['batch_errors', 'move_source_missing', 'refused_move_collision'].includes(e.code)
}

const errText = (e: unknown) => (e instanceof AzuraCastError ? `${e.code}` : e instanceof Error ? e.message : 'error')

export async function archiveMedia(ctx: RequestsCtx, payload: ArchivePayload) {
  const req = payload.requestId ? await loadRequest(ctx, payload.requestId) : null
  if (req && req.kind !== 'removal') throw new Permanent('not a removal request')
  if (req && req.status !== 'approved' && req.status !== 'applying') return
  const mediaId = req ? req.mediaId : Number(payload.mediaId)
  const offset = await mutationWindow(ctx)
  const media = await getFile(ctx, mediaId)
  const station = await stationPlaylistSet(ctx.db)

  const open = await ctx.db.query.archive.findFirst({
    where: and(eq(archive.mediaId, mediaId), inArray(archive.status, ['archiving', 'archived', 'restoring'])),
    orderBy: desc(archive.id),
  })
  if (open?.status === 'archived' && media.path === open.archivedPath) {
    // Re-run after the archive completed.
    if (req && !(await claim(ctx, req.id))) return
    await applied(ctx, req?.id, await takeSnapshot(ctx.db, media, station, 'after_archive', { requestId: req?.id }), offset)
    return
  }
  if (open && open.status !== 'archiving') {
    // An archived row whose file is elsewhere, or a restore in progress:
    // another operation owns this media; a human has to look.
    await ctx.alert('archive refused: the media has an open archive row', { mediaId, archiveId: open.id, status: open.status, path: media.path })
    throw new OpFailed('archive_row_open', { archiveId: open.id, status: open.status })
  }

  let row: ArchiveRow
  let snap: Snapshot
  if (open) {
    // Resume (an earlier attempt died or lost a response after its first
    // write): its before_archive snapshot is the truth. Never re-snapshot:
    // the memberships may already be cleared.
    row = open
    const s0 = row.snapshotId ? await ctx.db.query.mediaSnapshots.findFirst({ where: eq(mediaSnapshots.id, row.snapshotId) }) : null
    if (!s0) throw new OpFailed('archive_snapshot_missing', { archiveId: row.id })
    snap = s0
    if (req && !(await claim(ctx, req.id))) return
    if (media.path === row.archivedPath) return finishArchive(ctx, req, row, media, snap, station, offset, payload)
    if (media.path !== row.originalPath) {
      await ctx.alert('archive: file is neither at its original nor at its archive path', { mediaId, archiveId: row.id, path: media.path })
      throw new OpFailed('archive_path_unexpected', { path: media.path })
    }
    await assertNotOnAir(ctx.db, ctx.azuracast, media)
  } else {
    if (!isRequestTarget(ctx.root, media.path)) throw new OpFailed('target_not_allowed', { path: media.path })
    pathCheck(() => assertArtistFileSource(ctx.root, media.path))
    // A song that is also in an Events (station 14) playlist is refused
    // before anything changes: the station-1 REPLACE cannot clear another
    // station's membership (memberships follow the media row, so Events
    // would keep playing it from Removed/). A manager takes it out of the
    // Events playlist first. (Any id outside the station set counts: an
    // unknown id may be a new Events playlist.)
    const foreign = playlistIdsOf(media).filter((id) => !station.has(id))
    if (foreign.length > 0) throw new OpFailed('in_events_playlists', { playlistIds: foreign, note: foreign.join(', ') })
    const archDir = pathCheck(() => archiveDirPath(ctx.root, mediaId))
    const dest = `${archDir}/${basename(media.path)}`
    await assertNotOnAir(ctx.db, ctx.azuracast, media)
    if (req && !(await claim(ctx, req.id))) return
    if (await ctx.azuracast.pathTaken(archDir, dest)) {
      await ctx.alert('archive refused: destination exists', { mediaId, dest })
      throw new OpFailed('collision', { dest })
    }
    await assertQueuesRunning(ctx.db) // a paused job leaves no row behind
    snap = await takeSnapshot(ctx.db, media, station, 'before_archive', { requestId: req?.id })
    // Recorded BEFORE the first write: a re-run resumes with this snapshot.
    const [ins] = await ctx.db
      .insert(archive)
      .values({ mediaId, uniqueId: media.unique_id, originalPath: media.path, archivedPath: dest, snapshotId: snap.id, requestId: req?.id ?? null, status: 'archiving' })
      .onConflictDoNothing()
      .returning()
    if (!ins) throw new OpFailed('archive_row_open')
    row = ins
  }

  const dest = row.archivedPath
  const archDir = pathCheck(() => assertArchiveDir(ctx.root, dirname(dest)))
  if (await ctx.azuracast.pathTaken(archDir, dest)) {
    await ctx.alert('archive refused: destination exists', { mediaId, dest })
    await rollbackArchive(ctx, row, snap, station)
    throw new OpFailed('collision', { dest })
  }

  // 1. clear every station membership (REPLACE with []), 2. verify none of
  // this station's are left (another station's are not ours to count, and
  // were refused above). The pause is checked once, before the first write
  // of this attempt; the wrapper's write gate checks every write again.
  await assertQueuesRunning(ctx.db)
  await ctx.azuracast.setPlaylists(media.path, [], new Set(snap.playlistIds))
  const cleared = await getFile(ctx, mediaId)
  const left = stationIds(cleared, station)
  if (left.length !== 0) {
    await rollbackArchive(ctx, row, snap, station)
    throw new OpFailed('memberships_remain', { playlists: left })
  }
  // 3. move to Removed/<media_id>/ (per-id folder: same file names never collide).
  let moveErr: unknown = null
  try {
    await ctx.azuracast.moveFile(media.path, archDir)
  } catch (e) {
    moveErr = e
  }
  // Where the file actually is decides, not the reply: a timeout or a failed
  // verify read after AzuraCast moved it must finish the archive, never
  // "roll back" a file that is already in Removed/.
  const cur = await getFile(ctx, mediaId)
  if (cur.path === dest) return finishArchive(ctx, req, row, cur, snap, station, offset, payload, moveErr)
  if (cur.path !== media.path) {
    await ctx.alert('archive: file moved somewhere unexpected', { mediaId, archiveId: row.id, path: cur.path })
    throw new OpFailed('archive_path_unexpected', { path: cur.path })
  }
  // Not moved. Put the memberships back (the song stays in rotation between
  // attempts). A verified rollback closes the row (a retry starts fresh
  // from the restored state); an unverified one keeps it 'archiving', so a
  // retry still resumes with the original snapshot. A definitive failure
  // fails the request; anything else is retried.
  const definitive = moveErr === null || definitiveMoveError(moveErr)
  await rollbackArchive(ctx, row, snap, station)
  if (definitive) throw new OpFailed('archive_move_failed', { error: moveErr === null ? 'not_moved' : errText(moveErr), errors: moveErr instanceof AzuraCastError ? moveErr.detail : undefined })
  throw moveErr
}

// Re-applies the snapshot memberships at the original path and checks them.
// A verified rollback marks the archive row failed (a later archive starts
// fresh from the restored state); an unverified one leaves it 'archiving',
// so a re-run still has the original snapshot.
async function rollbackArchive(ctx: RequestsCtx, row: ArchiveRow, snap: Snapshot, station: ReadonlySet<number>): Promise<void> {
  try {
    let cur = await ctx.azuracast.getFile(row.mediaId)
    if (cur.path !== row.originalPath) {
      await ctx.alert('archive rollback: file not at its original path', { mediaId: row.mediaId, path: cur.path })
      return
    }
    if (!sameIds(stationIds(cur, station), snap.playlistIds)) {
      await ctx.azuracast.setPlaylists(cur.path, snap.playlistIds, new Set(snap.playlistIds))
      cur = await ctx.azuracast.getFile(row.mediaId)
      if (!sameIds(stationIds(cur, station), snap.playlistIds)) {
        await ctx.alert('archive rollback: playlists NOT verified', { mediaId: row.mediaId, snapshotId: snap.id, expected: snap.playlistIds })
        return
      }
    }
    await ctx.db.update(archive).set({ status: 'failed' }).where(and(eq(archive.id, row.id), eq(archive.status, 'archiving')))
  } catch (e) {
    await ctx.alert('archive rollback failed: playlists NOT re-applied', { mediaId: row.mediaId, snapshotId: snap.id, error: errText(e) })
  }
}

async function finishArchive(
  ctx: RequestsCtx,
  req: typeof requests.$inferSelect | null,
  row: ArchiveRow,
  after: StationMedia,
  snap: Snapshot,
  station: ReadonlySet<number>,
  offset: number,
  payload: Actor,
  moveErr: unknown = null,
) {
  // Memberships were verified cleared before the move; if some came back,
  // the wrapper cannot touch playlists under Removed/: a human must.
  const left = stationIds(after, station)
  if (left.length) await ctx.alert('archived file still has station playlist memberships', { mediaId: after.id, path: after.path, playlists: left })
  await ctx.db.update(archive).set({ status: 'archived', archivedAt: new Date() }).where(and(eq(archive.id, row.id), eq(archive.status, 'archiving')))
  await upsertLibrary(ctx.db, after) // now under Removed/: off the request surface
  const post = await takeSnapshot(ctx.db, after, station, 'after_archive', { requestId: req?.id })
  await audit(ctx.db, {
    ...actorOf(payload),
    action: 'media.archive',
    targetType: 'media',
    targetId: after.id,
    detail: { from: row.originalPath, to: row.archivedPath, snapshotId: snap.id, archiveId: row.id, requestId: req?.id ?? null, moveReply: moveErr ? errText(moveErr) : 'ok' },
  })
  await applied(ctx, req?.id, post, offset)
}

// ------------------------------------------------------------ restore ---

export async function restoreMedia(ctx: RequestsCtx, payload: Actor & { archiveId: number }) {
  const a = await ctx.db.query.archive.findFirst({ where: eq(archive.id, payload.archiveId) })
  if (!a) throw new Permanent('archive row missing')
  if (a.status !== 'archived' && a.status !== 'restoring') return
  const offset = await mutationWindow(ctx)
  const media = await getFile(ctx, a.mediaId)
  const snap = a.snapshotId ? await ctx.db.query.mediaSnapshots.findFirst({ where: eq(mediaSnapshots.id, a.snapshotId) }) : null
  if (!snap) throw new OpFailed('archive_snapshot_missing')
  const { target } = pathCheck(() => assertRestore(ctx.root, a.archivedPath, a.originalPath, a))
  const dir = dirname(target)
  const station = await stationPlaylistSet(ctx.db)
  let after: StationMedia
  if (media.path === a.archivedPath) {
    await assertNotOnAir(ctx.db, ctx.azuracast, media)
    if (await ctx.azuracast.pathTaken(dir, target)) {
      await ctx.alert('restore refused: original path is taken', { archiveId: a.id, target })
      throw new OpFailed('collision', { target })
    }
    await takeSnapshot(ctx.db, media, station, 'before_restore')
    // Recorded before the move: a re-run after it resumes (below).
    await ctx.db.update(archive).set({ status: 'restoring' }).where(and(eq(archive.id, a.id), inArray(archive.status, ['archived', 'restoring'])))
    await assertQueuesRunning(ctx.db)
    let moveErr: unknown = null
    try {
      await ctx.azuracast.moveFile(media.path, dir)
    } catch (e) {
      moveErr = e
    }
    after = await getFile(ctx, a.mediaId)
    if (after.path !== target) {
      if (after.path !== a.archivedPath) throw new OpFailed('restore_verify_failed', { path: after.path })
      // Not moved: a definitive failure puts the row back to 'archived'
      // (Restore can be pressed again); anything else is retried.
      if (moveErr === null || definitiveMoveError(moveErr)) {
        await ctx.db.update(archive).set({ status: 'archived' }).where(and(eq(archive.id, a.id), eq(archive.status, 'restoring')))
        throw new OpFailed('restore_move_failed', { error: moveErr === null ? 'not_moved' : errText(moveErr), errors: moveErr instanceof AzuraCastError ? moveErr.detail : undefined })
      }
      throw moveErr
    }
  } else if (media.path === a.originalPath && (!a.uniqueId || media.unique_id === a.uniqueId)) {
    // An earlier attempt moved it back and then died (or lost a reply):
    // continue with the metadata and memberships.
    after = media
  } else {
    throw new OpFailed('archived_path_mismatch', { path: media.path })
  }
  const want = snapshotMeta(snap)
  if (!sameMeta(metaOf(after), want)) {
    await assertQueuesRunning(ctx.db)
    await ctx.azuracast.updateMetadata(a.mediaId, want)
  }
  // Re-add the snapshot's station memberships (merge; sequential positions
  // are lost). Memberships the row gained since stay.
  const current = stationIds(after, station)
  if (snap.playlistIds.some((id) => !current.includes(id))) {
    const ids = [...new Set([...current, ...snap.playlistIds])].sort((x, y) => x - y)
    await assertQueuesRunning(ctx.db)
    await ctx.azuracast.setPlaylists(target, ids, new Set(ids))
  }
  after = await getFile(ctx, a.mediaId)
  const now = stationIds(after, station)
  if (!snap.playlistIds.every((id) => now.includes(id))) throw new OpFailed('playlists_verify_failed')
  if (!sameMeta(metaOf(after), want)) throw new OpFailed('metadata_verify_failed')
  await ctx.db.update(archive).set({ status: 'restored', restoredAt: new Date() }).where(and(eq(archive.id, a.id), inArray(archive.status, ['archived', 'restoring'])))
  await upsertLibrary(ctx.db, after)
  const post = await takeSnapshot(ctx.db, after, station, 'after_restore')
  await audit(ctx.db, { ...actorOf(payload), action: 'media.restore', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, to: target, playlistIds: snap.playlistIds } })
  await applied(ctx, null, post, offset)
}

// ------------------------------------------------- manager playlists ---

// MERGE (plan §3.3): only the assignable ids are replaced; every other
// station membership is kept, and foreign-station ids (Events, from the
// shared storage) are never sent back. Snapshotted before and after like
// every mutation, with its own re-verify chain, so an older chain for the
// same media is superseded instead of putting its old set back.
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
  const post = await takeSnapshot(ctx.db, after, station, 'after_playlists')
  await audit(ctx.db, { ...actorOf(payload), action: 'media.playlists', targetType: 'media', targetId: media.id, detail: { before, after: merged, chosen: payload.chosen } })
  await applied(ctx, null, post, await scanOffsetS(ctx.db))
}

// ----------------------------------------------------------- reverify ---

const RECOVERY_MIN_CYCLES = 3
const RECOVERY_MIN_MS = 20 * 60_000

type ReverifyPayload = { mediaId: number; snapshotId: number; requestId?: number | null; attempt?: number; lostSince?: number }

// The snapshot's metadata, and its station memberships re-added by MERGE:
// memberships the row gained since are kept (a REPLACE with this set would
// drop them).
async function reapplyState(ctx: RequestsCtx, id: number, snap: Snapshot, station: ReadonlySet<number>, media: StationMedia) {
  if (!patterns(ctx.root).artistFile.test(snap.path)) return // archived: no metadata/playlist writes under Removed/
  await assertQueuesRunning(ctx.db)
  if (!sameMeta(metaOf(media), snapshotMeta(snap))) await ctx.azuracast.updateMetadata(id, snapshotMeta(snap))
  const current = stationIds(media, station)
  const missing = snap.playlistIds.filter((p) => station.has(p) && !current.includes(p))
  if (missing.length) {
    const ids = [...new Set([...current, ...missing])].sort((x, y) => x - y)
    await ctx.azuracast.setPlaylists(snap.path, ids, new Set(ids))
  }
}

// The row holds the snapshot's state: its metadata, and at least its
// station memberships (extra ones are someone's later addition, not a loss).
function holds(media: StationMedia, snap: Snapshot, station: ReadonlySet<number>): boolean {
  const current = stationIds(media, station)
  return sameMeta(metaOf(media), snapshotMeta(snap)) && snap.playlistIds.filter((p) => station.has(p)).every((p) => current.includes(p))
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
  const offset = await scanOffsetS(ctx.db)
  const again = (extra: Partial<ReverifyPayload>, n = 1) =>
    schedule(
      ctx,
      'reverify',
      { ...payload, ...extra, attempt: attempt + 1 },
      { dedupeKey: `reverify:${snap.id}:${attempt + 1}`, runAfter: new Date(afterScans(now(ctx), n, offset)) },
    )
  // A newer portal snapshot of this media (a later edit, move, archive,
  // restore, art or playlist change) supersedes this chain: its own
  // re-verify checks the newer state, and re-applying this one would
  // revert that change (or ping-pong with it).
  const latest = await ctx.db.query.mediaSnapshots.findFirst({ where: eq(mediaSnapshots.mediaId, snap.mediaId), orderBy: desc(mediaSnapshots.id) })
  const newer = latest && latest.id > snap.id ? latest : null

  let media: StationMedia | null
  try {
    media = await ctx.azuracast.getFile(payload.mediaId)
  } catch (e) {
    if (!(e instanceof AzuraCastError && e.code === 'not_found')) throw e
    media = null
  }

  if (media) {
    if (newer) {
      await audit(ctx.db, { action: 'media.reverify_superseded', targetType: 'media', targetId: media.id, detail: { snapshotId: snap.id, by: newer.id, reason: newer.reason } })
      return done(ctx, payload.requestId)
    }
    if (media.path !== snap.path) throw new OpFailed('reverify_path_changed', { expected: snap.path, actual: media.path })
    if (holds(media, snap, station)) return done(ctx, payload.requestId)
    if (attempt >= 2) throw new OpFailed('reverify_mismatch')
    await reapplyState(ctx, media.id, snap, station, media)
    await audit(ctx.db, { action: 'media.reverify_reapplied', targetType: 'media', targetId: media.id, detail: { snapshotId: snap.id, attempt } })
    return again({})
  }

  // The id vanished after a scan: recovery (library/recovery.ts, shared
  // with the ingest re-verify), from the LATEST snapshot of the media (its
  // path and state are the newest the portal knows). Look for the file at
  // its path (files/list with flushCache; only a scanned media row counts).
  const eff = newer ?? snap
  const found = await findMediaByPath(ctx.azuracast, eff.path)
  if (!found) {
    const lostSince = payload.lostSince ?? now(ctx)
    if (attempt + 1 >= RECOVERY_MIN_CYCLES && now(ctx) - lostSince >= RECOVERY_MIN_MS) {
      await ctx.alert('recovery failed: media row lost', { mediaId: payload.mediaId, path: eff.path, snapshotId: eff.id })
      throw new OpFailed('recovery_failed', { path: eff.path })
    }
    return again({ lostSince })
  }
  const oldId = payload.mediaId
  // Snapshot METADATA first, then the snapshot playlists, then remap ids in
  // every table (library_cache, items, requests, archive, media_snapshots,
  // ingest_runs) and queued jobs. An archived file (Removed/<id>/) gets no
  // metadata or playlist writes: it is only re-linked.
  if (patterns(ctx.root).artistFile.test(eff.path)) {
    await assertQueuesRunning(ctx.db)
    await reapplySnapshot(ctx.azuracast, found.id, eff.path, eff, station)
  }
  const fresh = await ctx.azuracast.getFile(found.id)
  await remapMediaId(ctx.db, oldId, fresh.id, fresh.unique_id)
  await upsertLibrary(ctx.db, fresh)
  const ok = fresh.path === eff.path && holds(fresh, eff, station)
  await audit(ctx.db, { action: 'media.recovered', targetType: 'media', targetId: fresh.id, detail: { oldId, newId: fresh.id, path: eff.path, snapshotId: eff.id, verified: ok } })
  await ctx.alert('media row recovered under a new id', { oldId, newId: fresh.id, path: eff.path })
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

export const REQUEST_JOB_KINDS = new Set<string>(['request_ticket_open', 'request_ticket_post', 'apply_edit', 'apply_art', 'move', 'archive', 'restore', 'set_playlists', 'reverify'])

function transient(e: unknown): boolean {
  if (e instanceof OpFailed || e instanceof Permanent) return false
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
      case 'apply_art':
        return await applyArt(ctx, p as ApplyArtPayload)
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
    // Waits (scan window, on air, ticket not open, transient tickets errors)
    // and the queue pause are not failures: runJob requeues them without an
    // attempt (the pause parks the job until an operator clears it).
    if (e instanceof RetryLater || e instanceof QueuesPausedError) throw e
    if (e instanceof AzuraCastError && e.code === 'refused_queues_paused') throw e
    if (job.kind === 'request_ticket_open' || job.kind === 'request_ticket_post') throw e
    if (transient(e) && job.attempts < job.max_attempts) throw e
    const code = e instanceof OpFailed ? e.code : e instanceof AzuraCastError ? `azuracast_${e.code}` : e instanceof Error ? e.name : 'error'
    // requests.error: the code, plus the short detail a manager needs to act
    // (e.g. the Events playlist ids) when the failure carries one.
    const note = e instanceof OpFailed && typeof e.detail?.note === 'string' ? e.detail.note : null
    const requestId = typeof p.requestId === 'number' ? p.requestId : null
    if (requestId) await failRequest(ctx, requestId, note ? `${code}: ${note}` : code, e instanceof OpFailed ? (e.detail ?? {}) : {})
    await audit(ctx.db, { action: `job.${job.kind}.failed`, targetType: 'job', targetId: job.id, detail: { code, payload: p } })
    await ctx.alert(`${job.kind} failed (${code})`, { jobId: job.id, requestId, mediaId: p.mediaId ?? null, archiveId: p.archiveId ?? null, detail: e instanceof OpFailed ? (e.detail ?? null) : null })
  }
}
