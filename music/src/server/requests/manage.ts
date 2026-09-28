// Manager library actions (`manage`, plan §3.3): direct metadata edit,
// playlist change (the worker MERGES), archive and restore, and settling an
// archive or restore that stopped part way. v0.3.3: the release of a legacy
// (UNRELEASED) archived song, linking a member to an archived song, and the
// UNRELEASED import's dry run and confirm. The web holds no AzuraCast key,
// so each one validates, audits and queues a worker job.

import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit'
import type { Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { archive, artists, users } from '../db/schema'
import { badRequest, conflict, forbidden, notFound } from '../http/errors'
import { enqueue } from '../jobs'
import { newArtistFolder, PathError } from '../paths/builder'
import { getIntList } from '../settings'
import { isUsableArt, loadArt } from '../library/art'
import { escapeLike } from '../ui/library'
import { ARCHIVE_OP_STATUSES, archiveOpInProgress, liveArchiveJob } from './archive-state'
import { applyProposed, ArtIdSchema, freeText, mainArtist, mainArtistChanged, metaOf, ProposedSchema, resolveArtist, sameMeta } from './common'
import { enqueueImportJobs, importJobsLive, loadPlanState, newPlanId, PLAN_KEY, PLAN_MAX_AGE_MS, toQueue } from './legacy-import'
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
    await enqueue(tx, 'archive', { mediaId, reason: p.data.reason || null, ...actor(v) })
    await audit(tx, { ...actor(v), action: 'library.archive', targetType: 'media', targetId: mediaId, detail: { path: lib.path, reason: p.data.reason ?? null } })
    return { queued: 'archive', mediaId }
  })
}

export async function restoreSong(db: DB, v: Viewer, archiveId: number) {
  requireManage(v)
  const a = await db.query.archive.findFirst({ where: eq(archive.id, archiveId) })
  if (!a) throw notFound()
  // A legacy UNRELEASED song is released into an artist folder the manager
  // chooses (POST …/release), never put back where it came from.
  if (a.origin === 'legacy_unreleased') throw conflict('release_required')
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
    origin: a.origin,
    originalPath: a.originalPath,
    archivedPath: a.archivedPath,
    requestId: a.requestId,
    linkedUserId: a.linkedUserId,
    archivedAt: a.archivedAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  }))
}

// ------------------------------------------------ release (v0.3.3) ---

// {artist, newArtist?, playlistIds}: the artist folder the song goes to
// (an existing ACTIVE artist by name, folder or alias; or, with newArtist:
// true, a NEW artist under the strict sanitizer's folder, created active by
// this manager's decision, refused when that folder already belongs to
// another artist, like every new-artist approval) and the playlists, chosen
// explicitly (assignable only; none is fine).
const releaseSchema = z
  .object({
    artist: z.string().max(200),
    newArtist: z.boolean().optional(),
    playlistIds: z.array(z.number().int().positive().max(2_147_483_647)).max(16),
  })
  .strict()

export async function releaseSong(db: DB, v: Viewer, archiveId: number, input: unknown) {
  requireManage(v)
  const p = releaseSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_release', { issues: p.error.issues.map((i) => i.message) })
  const a = await db.query.archive.findFirst({ where: eq(archive.id, archiveId) })
  if (!a) throw notFound()
  if (a.origin !== 'legacy_unreleased') throw conflict('not_a_release')
  if (a.status === 'archiving') throw conflict('archive_in_progress')
  if (a.status === 'restoring') {
    // A release that stopped part way: the worker resumes it with the
    // artist and playlists already recorded.
    if (await liveArchiveJob(db, a)) throw conflict('archive_job_pending')
    return db.transaction(async (tx) => {
      await enqueue(tx, 'restore', { archiveId: a.id, ...actor(v) })
      await audit(tx, { ...actor(v), action: 'library.release', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, resume: true } })
      return { queued: 'restore', archiveId: a.id, resume: true }
    })
  }
  if (a.status !== 'archived') throw conflict('not_archived')
  const chosen = [...new Set(p.data.playlistIds)].sort((x, y) => x - y)
  const assignable = new Set(await getIntList(db, 'assignable_playlist_ids'))
  if (chosen.some((id) => !assignable.has(id))) throw badRequest('playlist_not_assignable')
  const name = mainArtist(p.data.artist)
  if (!name) throw badRequest('invalid_release', { issues: ['artist required'] })
  return db.transaction(async (tx) => {
    let artistRow = await resolveArtist(tx, name)
    let created = false
    if (artistRow && artistRow.status === 'pending') throw conflict('artist_pending')
    if (artistRow && artistRow.status !== 'active') throw conflict('artist_not_active')
    if (!artistRow) {
      let folder: string
      try {
        folder = newArtistFolder(name)
      } catch (e) {
        if (e instanceof PathError) throw badRequest('artist_name_unusable')
        throw e
      }
      if (p.data.newArtist !== true) throw conflict('artist_unknown')
      const [taken] = await tx.select({ id: artists.id }).from(artists).where(sql`lower(${artists.folder}) = lower(${folder})`).limit(1)
      if (taken) throw conflict('artist_folder_taken')
      const [ins] = await tx.insert(artists).values({ name, folder, status: 'active' }).returning()
      artistRow = ins ?? null
      if (!artistRow) throw conflict('artist_folder_taken')
      created = true
      await audit(tx, { ...actor(v), action: 'artist.create', targetType: 'artist', targetId: artistRow!.id, detail: { name, folder, via: 'release', archiveId: a.id } })
    }
    const [row] = await tx
      .update(archive)
      .set({ releaseArtistId: artistRow!.id, releasePlaylistIds: chosen, restorePath: null, updatedAt: sql`now()` })
      .where(and(eq(archive.id, a.id), eq(archive.status, 'archived')))
      .returning()
    if (!row) throw conflict('state_changed')
    await enqueue(tx, 'restore', { archiveId: a.id, ...actor(v) })
    await audit(tx, {
      ...actor(v),
      action: 'library.release',
      targetType: 'archive',
      targetId: a.id,
      detail: { mediaId: a.mediaId, artistId: artistRow!.id, folder: artistRow!.folder, newArtist: created, playlistIds: chosen, from: a.archivedPath },
    })
    return { queued: 'restore', archiveId: a.id, artistId: artistRow!.id, folder: artistRow!.folder, newArtist: created, playlistIds: chosen }
  })
}

// ---------------------------------------- member links (v0.3.3) ---

// A manager links one portal user (someone who has signed in) to an
// archived song, so that member sees it on Archived songs; or unlinks.
// Audited with the previous link.
const linkSchema = z.object({ userId: z.string().min(1).max(64) }).strict()

export async function linkArchive(db: DB, v: Viewer, archiveId: number, input: unknown) {
  requireManage(v)
  const p = linkSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_link')
  const a = await db.query.archive.findFirst({ where: eq(archive.id, archiveId) })
  if (!a || a.status === 'restored' || a.status === 'failed') throw notFound()
  const u = await db.query.users.findFirst({ where: eq(users.id, p.data.userId) })
  if (!u) throw badRequest('unknown_user')
  return db.transaction(async (tx) => {
    await tx.update(archive).set({ linkedUserId: u.id }).where(eq(archive.id, a.id))
    await audit(tx, { ...actor(v), action: 'archive.link', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, userId: u.id, discordId: u.discordId, previousUserId: a.linkedUserId } })
    return { archiveId: a.id, linkedUser: { id: u.id, name: u.name, discordId: u.discordId } }
  })
}

export async function unlinkArchive(db: DB, v: Viewer, archiveId: number) {
  requireManage(v)
  const a = await db.query.archive.findFirst({ where: eq(archive.id, archiveId) })
  if (!a) throw notFound()
  if (!a.linkedUserId) return { archiveId: a.id, linkedUser: null }
  return db.transaction(async (tx) => {
    await tx.update(archive).set({ linkedUserId: null }).where(eq(archive.id, a.id))
    await audit(tx, { ...actor(v), action: 'archive.unlink', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, previousUserId: a.linkedUserId } })
    return { archiveId: a.id, linkedUser: null }
  })
}

// Portal users (anyone who has signed in) matching a name or Discord id.
export async function linkCandidates(db: DB, v: Viewer, q: string) {
  requireManage(v)
  const t = q.trim().slice(0, 100)
  if (t.length < 2) return []
  const pat = `%${escapeLike(t)}%`
  const rows = await db
    .select({ id: users.id, name: users.name, discordId: users.discordId })
    .from(users)
    .where(or(ilike(users.name, pat), ilike(users.discordId, `${escapeLike(t)}%`)))
    .orderBy(users.name)
    .limit(10)
  return rows
}

// ------------------------------------- UNRELEASED import (v0.3.3) ---

export async function legacyImportState(db: DB, v: Viewer) {
  requireManage(v)
  const [state, live, rows] = await Promise.all([
    loadPlanState(db),
    importJobsLive(db),
    db.execute<{ status: string; n: number }>(sql`SELECT status::text AS status, count(*)::int AS n FROM archive WHERE origin = 'legacy_unreleased' GROUP BY status`),
  ])
  const counts = Object.fromEntries((rows as unknown as { status: string; n: number }[]).map((r) => [r.status, Number(r.n)]))
  return { plan: state, jobsLive: live, archiveCounts: counts }
}

const importSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('dry_run') }).strict(), z.object({ action: z.literal('run'), planId: z.string().uuid() }).strict()])

export async function legacyImport(db: DB, v: Viewer, input: unknown, nowMs = Date.now()) {
  requireManage(v)
  const p = importSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_import')
  if (p.data.action === 'dry_run') {
    const id = newPlanId()
    const value = { id, status: 'queued', requestedAt: new Date(nowMs).toISOString(), requestedBy: v.userId }
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO settings (key, value, updated_by) VALUES (${PLAN_KEY}, ${JSON.stringify(value)}::jsonb, ${v.discordId})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`)
      await enqueue(tx, 'legacy_import_plan', { planId: id }, { dedupeKey: `legacy_import_plan:${id}` })
      await audit(tx, { ...actor(v), action: 'legacy_import.dry_run', targetType: 'legacy_import', targetId: id })
      return { planId: id, status: 'queued' }
    })
  }
  const state = await loadPlanState(db)
  if (!state || state.id !== p.data.planId) throw conflict('plan_stale')
  if (state.status === 'confirmed') throw conflict('plan_already_run')
  if (state.status !== 'ready') throw conflict('plan_not_ready')
  if (nowMs - Date.parse(state.readyAt) > PLAN_MAX_AGE_MS) throw conflict('plan_stale')
  if ((await importJobsLive(db)) > 0) throw conflict('import_in_progress')
  const files = toQueue(state.plan)
  if (files.length === 0) throw conflict('nothing_to_import')
  const confirmed = { ...state, status: 'confirmed', confirmedAt: new Date(nowMs).toISOString(), confirmedBy: v.userId, queued: files.length }
  // The plan is claimed (never queued twice) and its jobs queued in one
  // transaction.
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      UPDATE settings SET value = ${JSON.stringify(confirmed)}::jsonb, updated_at = now(), updated_by = ${v.discordId}
      WHERE key = ${PLAN_KEY} AND value->>'id' = ${state.id} AND value->>'status' = 'ready'
      RETURNING key`)
    if ((rows as unknown as unknown[]).length === 0) throw conflict('plan_already_run')
    const queued = await enqueueImportJobs(tx, state.id, files, actor(v), nowMs, 'web')
    return { planId: state.id, queued }
  })
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
