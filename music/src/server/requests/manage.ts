// Manager library actions (`manage`, plan §3.3): direct metadata edit,
// playlist change (the worker MERGES), archive and restore, and settling an
// archive or restore that stopped part way. The web holds no AzuraCast key,
// so each one validates, audits and queues a worker job.

import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit'
import type { Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { archive } from '../db/schema'
import { badRequest, conflict, forbidden, notFound } from '../http/errors'
import { enqueue } from '../jobs'
import { getIntList } from '../settings'
import { isUsableArt, loadArt } from '../library/art'
import { ARCHIVE_OP_STATUSES, archiveOpInProgress, liveArchiveJob } from './archive-state'
import { applyProposed, ArtIdSchema, freeText, mainArtistChanged, metaOf, ProposedSchema, resolveArtist, sameMeta } from './common'
import { loadRequestTarget } from './service'

function requireManage(v: Viewer) {
  if (!v.perms.has('manage')) throw forbidden()
}

const actor = (v: Viewer) => ({ actorUserId: v.userId, actorDiscordId: v.discordId })

// An archive or restore of the song is in flight (or stopped part way): the
// worker would hold an edit, playlist or art change until it is settled, so
// say so now. (Archive is still allowed: the worker resumes the row.)
async function refuseDuringArchiveOp(db: DB, mediaId: number) {
  const op = await archiveOpInProgress(db, mediaId)
  if (op) throw conflict('archive_in_progress')
}

export async function directEdit(db: DB, v: Viewer, root: string, mediaId: number, input: unknown) {
  requireManage(v)
  const p = ProposedSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_edit', { issues: p.error.issues.map((i) => i.message) })
  if (p.data.artId !== undefined) throw badRequest('use_art_endpoint') // PUT /api/library/:mediaId/art
  const lib = await loadRequestTarget(db, root, mediaId)
  await refuseDuringArchiveOp(db, mediaId)
  const current = metaOf(lib)
  const next = applyProposed(current, p.data)
  if (sameMeta(next, current)) throw badRequest('no_change')
  // A direct edit cannot create an artist: approve the artist first.
  if (mainArtistChanged(current.artist, next.artist)) {
    const a = await resolveArtist(db, next.artist)
    if (!a || a.status !== 'active') throw conflict('artist_not_active')
  }
  return db.transaction(async (tx) => {
    // beforeArtist: a worker re-run after its metadata PUT must still see the
    // main-artist change and queue the folder move.
    await enqueue(tx, 'apply_edit', { mediaId, proposed: p.data, beforeArtist: current.artist, ...actor(v) })
    await audit(tx, { ...actor(v), action: 'library.edit', targetType: 'media', targetId: mediaId, detail: { path: lib.path, before: current, proposed: p.data } })
    return { queued: 'apply_edit', mediaId }
  })
}

const playlistsSchema = z.object({ playlistIds: z.array(z.number().int().positive().max(2_147_483_647)).max(16) }).strict()

export async function changePlaylists(db: DB, v: Viewer, root: string, mediaId: number, input: unknown) {
  requireManage(v)
  const p = playlistsSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_playlists')
  const chosen = [...new Set(p.data.playlistIds)]
  const assignable = new Set(await getIntList(db, 'assignable_playlist_ids'))
  if (chosen.some((id) => !assignable.has(id))) throw badRequest('playlist_not_assignable')
  const lib = await loadRequestTarget(db, root, mediaId)
  await refuseDuringArchiveOp(db, mediaId)
  return db.transaction(async (tx) => {
    await enqueue(tx, 'set_playlists', { mediaId, chosen, ...actor(v) })
    await audit(tx, { ...actor(v), action: 'library.playlists', targetType: 'media', targetId: mediaId, detail: { path: lib.path, chosen, before: lib.playlistIds } })
    return { queued: 'set_playlists', mediaId, playlistIds: chosen }
  })
}

const archiveSchema = z.object({ reason: freeText(500).optional() }).strict()

export async function archiveSong(db: DB, v: Viewer, root: string, mediaId: number, input: unknown) {
  requireManage(v)
  const p = archiveSchema.safeParse(input ?? {})
  if (!p.success) throw badRequest('invalid_archive')
  const lib = await loadRequestTarget(db, root, mediaId)
  return db.transaction(async (tx) => {
    await enqueue(tx, 'archive', { mediaId, ...actor(v) })
    await audit(tx, { ...actor(v), action: 'library.archive', targetType: 'media', targetId: mediaId, detail: { path: lib.path, reason: p.data.reason ?? null } })
    return { queued: 'archive', mediaId }
  })
}

export async function restoreSong(db: DB, v: Viewer, archiveId: number) {
  requireManage(v)
  const a = await db.query.archive.findFirst({ where: eq(archive.id, archiveId) })
  if (!a) throw notFound()
  if (a.status === 'archiving') {
    // An archive that stopped part way: the worker settles it first (finishes
    // it if the file reached Removed/, else puts the playlists back and the
    // song never left), then restores an archived song.
    if (await liveArchiveJob(db, a)) throw conflict('archive_job_pending')
    return db.transaction(async (tx) => {
      await enqueue(tx, 'reconcile_archive', { archiveId: a.id, manual: true, restoreAfter: true, ...actor(v) })
      await audit(tx, { ...actor(v), action: 'library.restore', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, originalPath: a.originalPath, status: a.status } })
      return { queued: 'reconcile_archive', archiveId: a.id }
    })
  }
  // 'restoring': an earlier restore stopped part way; the worker resumes it.
  if (a.status !== 'archived' && a.status !== 'restoring') throw conflict('not_archived')
  return db.transaction(async (tx) => {
    await enqueue(tx, 'restore', { archiveId: a.id, ...actor(v) })
    await audit(tx, { ...actor(v), action: 'library.restore', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, originalPath: a.originalPath } })
    return { queued: 'restore', archiveId: a.id }
  })
}

// "Resolve" for an archive or restore that stopped part way ('archiving' /
// 'restoring'): the worker's reconciler, now instead of after the stale
// threshold. Where the file actually is decides: an archive whose file
// reached Removed/ is finished, one whose file is still in the library is
// rolled back; a restore is finished or put back to 'archived'.
export async function reconcileArchiveRow(db: DB, v: Viewer, archiveId: number) {
  requireManage(v)
  const a = await db.query.archive.findFirst({ where: eq(archive.id, archiveId) })
  if (!a) throw notFound()
  if (!(ARCHIVE_OP_STATUSES as readonly string[]).includes(a.status)) throw conflict('not_in_progress')
  // A queued or running archive / restore job resumes the row itself.
  if (await liveArchiveJob(db, a)) throw conflict('archive_job_pending')
  return db.transaction(async (tx) => {
    await enqueue(tx, 'reconcile_archive', { archiveId: a.id, manual: true, ...actor(v) })
    await audit(tx, { ...actor(v), action: 'library.archive_reconcile', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, status: a.status, originalPath: a.originalPath } })
    return { queued: 'reconcile_archive', archiveId: a.id }
  })
}

// Archived songs, and archives / restores that stopped part way
// ('archiving', 'restoring'), which a manager can resolve or restore.
export async function listArchived(db: DB, v: Viewer) {
  requireManage(v)
  const rows = await db.query.archive.findMany({ where: inArray(archive.status, ['archiving', 'archived', 'restoring']), limit: 500 })
  return rows.map((a) => ({
    id: a.id,
    mediaId: a.mediaId,
    status: a.status,
    originalPath: a.originalPath,
    archivedPath: a.archivedPath,
    requestId: a.requestId,
    archivedAt: a.archivedAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }))
}

const artSchema = z.object({ artId: ArtIdSchema }).strict()

// Manager direct art change → worker apply_art. The upload must be ready
// (probe-verified); a manager may apply any member's ready upload (e.g. one
// attached to a request), as `manage` can already read every upload.
export async function setArt(db: DB, v: Viewer, root: string, mediaId: number, input: unknown) {
  requireManage(v)
  const p = artSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_art')
  const lib = await loadRequestTarget(db, root, mediaId)
  await refuseDuringArchiveOp(db, mediaId)
  const art = await loadArt(db, p.data.artId)
  if (!isUsableArt(art)) throw badRequest('art_not_ready')
  return db.transaction(async (tx) => {
    await enqueue(tx, 'apply_art', { mediaId, artId: art.id, ...actor(v) })
    await audit(tx, { ...actor(v), action: 'library.art', targetType: 'media', targetId: mediaId, detail: { path: lib.path, artId: art.id, jpegSha256: art.jpegSha256 } })
    return { queued: 'apply_art', mediaId, artId: art.id }
  })
}
