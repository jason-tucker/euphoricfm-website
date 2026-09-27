// Manager library actions (`manage`, plan §3.3): direct metadata edit,
// playlist change (the worker MERGES), archive and restore. The web holds no
// AzuraCast key, so each one validates, audits and queues a worker job.

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit'
import type { Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { archive } from '../db/schema'
import { badRequest, conflict, forbidden, notFound } from '../http/errors'
import { enqueue } from '../jobs'
import { getIntList } from '../settings'
import { applyProposed, freeText, mainArtistChanged, metaOf, ProposedSchema, resolveArtist, sameMeta } from './common'
import { loadRequestTarget } from './service'

function requireManage(v: Viewer) {
  if (!v.perms.has('manage')) throw forbidden()
}

const actor = (v: Viewer) => ({ actorUserId: v.userId, actorDiscordId: v.discordId })

export async function directEdit(db: DB, v: Viewer, root: string, mediaId: number, input: unknown) {
  requireManage(v)
  const p = ProposedSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_edit', { issues: p.error.issues.map((i) => i.message) })
  const lib = await loadRequestTarget(db, root, mediaId)
  const current = metaOf(lib)
  const next = applyProposed(current, p.data)
  if (sameMeta(next, current)) throw badRequest('no_change')
  // A direct edit cannot create an artist: approve the artist first.
  if (mainArtistChanged(current.artist, next.artist)) {
    const a = await resolveArtist(db, next.artist)
    if (!a || a.status !== 'active') throw conflict('artist_not_active')
  }
  return db.transaction(async (tx) => {
    await enqueue(tx, 'apply_edit', { mediaId, proposed: p.data, ...actor(v) })
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
  if (a.status !== 'archived') throw conflict('not_archived')
  return db.transaction(async (tx) => {
    await enqueue(tx, 'restore', { archiveId: a.id, ...actor(v) })
    await audit(tx, { ...actor(v), action: 'library.restore', targetType: 'archive', targetId: a.id, detail: { mediaId: a.mediaId, originalPath: a.originalPath } })
    return { queued: 'restore', archiveId: a.id }
  })
}

export async function listArchived(db: DB, v: Viewer) {
  requireManage(v)
  const rows = await db.query.archive.findMany({ where: and(eq(archive.status, 'archived')), limit: 500 })
  return rows.map((a) => ({ id: a.id, mediaId: a.mediaId, originalPath: a.originalPath, archivedPath: a.archivedPath, requestId: a.requestId, archivedAt: a.archivedAt.toISOString() }))
}
