// Read-only queries behind the P4 pages: library browse and song detail
// (Music/Artists/** only), the reviewer's request queue, and the managers'
// archived list. Permission checks mirror plan §3.3.

import { and, asc, count, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { isReviewer, type Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { archive, artists, libraryCache, requests, users } from '../db/schema'
import { forbidden, notFound } from '../http/errors'
import { libraryArtUrl } from './art'
import { escapeLike, folderOf, onLibrarySurface, surfaceSql } from './library'

export { folderOf }

export const PAGE_SIZE = 50


function songView(v: Viewer, r: typeof libraryCache.$inferSelect) {
  return {
    mediaId: r.mediaId,
    title: r.title,
    artist: r.artist,
    album: r.album,
    genre: r.genre,
    lengthS: r.lengthS,
    folder: folderOf(r.path),
    fileName: r.path.slice(r.path.lastIndexOf('/') + 1),
    artUrl: libraryArtUrl(r.artUrl, r.uniqueId),
    // Playlist memberships are a staff concern.
    ...(isReviewer(v) ? { playlistIds: r.playlistIds } : {}),
  }
}
export type LibrarySong = ReturnType<typeof songView>

export async function browseLibrary(db: DB, v: Viewer, opts: { q?: string; page?: number }) {
  if (!v.perms.has('submit')) throw forbidden()
  const page = Math.max(1, Math.min(opts.page ?? 1, 1000))
  const conds = [surfaceSql(libraryCache.path)]
  if (opts.q) {
    const pat = `%${escapeLike(opts.q)}%`
    conds.push(or(ilike(libraryCache.title, pat), ilike(libraryCache.artist, pat), ilike(libraryCache.album, pat))!)
  }
  const where = and(...conds)
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(libraryCache)
      .where(where)
      .orderBy(asc(sql`lower(${libraryCache.artist})`), asc(sql`lower(${libraryCache.title})`))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(libraryCache).where(where),
  ])
  return {
    page,
    total: Number(total?.n ?? 0),
    songs: rows.filter((r) => onLibrarySurface(r.path)).map((r) => songView(v, r)),
  }
}

export async function librarySong(db: DB, v: Viewer, mediaId: number) {
  if (!v.perms.has('submit')) throw forbidden()
  const r = await db.query.libraryCache.findFirst({ where: eq(libraryCache.mediaId, mediaId) })
  if (!r || !onLibrarySurface(r.path)) throw notFound()
  const mine = await db.query.requests.findMany({
    where: and(eq(requests.mediaId, mediaId), eq(requests.ownerUserId, v.userId)),
    orderBy: desc(requests.id),
    limit: 10,
  })
  const [open] = await db
    .select({ n: count() })
    .from(requests)
    .where(and(eq(requests.mediaId, mediaId), inArray(requests.status, ['pending', 'approved', 'applying', 'verifying'])))
  return {
    song: songView(v, r),
    myRequests: mine.map((q) => ({ id: q.id, kind: q.kind, status: q.status, createdAt: q.createdAt.toISOString() })),
    openRequests: Number(open?.n ?? 0),
  }
}

export async function pendingRequests(db: DB, v: Viewer) {
  if (!isReviewer(v)) throw forbidden()
  const rows = await db
    .select({ r: requests, ownerName: users.name, ownerDiscordId: users.discordId })
    .from(requests)
    .innerJoin(users, eq(users.id, requests.ownerUserId))
    .where(eq(requests.status, 'pending'))
    .orderBy(asc(requests.createdAt), asc(requests.id))
    .limit(200)
  const ids = [...new Set(rows.map((x) => x.r.mediaId))]
  const current = ids.length ? await db.select().from(libraryCache).where(inArray(libraryCache.mediaId, ids)) : []
  const byId = new Map(current.map((c) => [c.mediaId, c]))
  return rows.map(({ r, ownerName, ownerDiscordId }) => {
    const c = byId.get(r.mediaId)
    return {
      id: r.id,
      kind: r.kind,
      mediaId: r.mediaId,
      targetPath: r.targetPath,
      proposed: (r.proposed ?? null) as Record<string, string> | null,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      isOwn: r.ownerUserId === v.userId,
      ownerName: ownerName ?? ownerDiscordId,
      ticket: r.ticketId ? { number: r.ticketNumber, webUrl: r.ticketWebUrl, channelUrl: r.ticketChannelUrl, status: r.ticketStatus } : null,
      current: c ? { title: c.title, artist: c.artist, album: c.album, genre: c.genre } : null,
      currentArtUrl: c ? libraryArtUrl(c.artUrl, c.uniqueId) : null,
      proposedArtId: r.proposed && typeof r.proposed === 'object' && 'artId' in r.proposed ? String((r.proposed as Record<string, unknown>).artId) : null,
    }
  })
}
export type PendingRequest = Awaited<ReturnType<typeof pendingRequests>>[number]

export async function archivedSongs(db: DB, v: Viewer) {
  if (!v.perms.has('manage')) throw forbidden()
  const rows = await db.query.archive.findMany({ where: eq(archive.status, 'archived'), orderBy: desc(archive.archivedAt), limit: 200 })
  return rows.map((a) => ({
    id: a.id,
    mediaId: a.mediaId,
    originalPath: a.originalPath,
    folder: folderOf(a.originalPath),
    fileName: a.originalPath.slice(a.originalPath.lastIndexOf('/') + 1),
    archivedAt: a.archivedAt.toISOString(),
    requestId: a.requestId,
  }))
}

// Approved edits parked on a new artist (P4: requests.pending_artist_id,
// artist status 'pending').
export async function artistsAwaitingApproval(db: DB, v: Viewer) {
  if (!isReviewer(v)) throw forbidden()
  const rows = await db
    .select({ id: requests.id, targetPath: requests.targetPath, proposed: requests.proposed, artistId: requests.pendingArtistId })
    .from(requests)
    .where(and(inArray(requests.status, ['approved', 'applying']), isNotNull(requests.pendingArtistId)))
    .orderBy(asc(requests.id))
    .limit(100)
  const ids = [...new Set(rows.map((r) => r.artistId).filter((n): n is number => typeof n === 'number' && n > 0))]
  if (ids.length === 0) return []
  const as = await db.select().from(artists).where(and(inArray(artists.id, ids), eq(artists.status, 'pending')))
  return as.map((a) => ({
    artistId: a.id,
    name: a.name,
    folder: a.folder,
    requests: rows
      .filter((r) => r.artistId === a.id)
      .map((r) => ({ id: r.id, targetPath: r.targetPath, proposed: (r.proposed ?? null) as Record<string, string> | null })),
  }))
}
