// Read-only queries behind the P4 pages: library browse and song detail
// (Music/Artists/** only), the reviewer's request queue, and the managers'
// archived list. Permission checks mirror plan §3.3.

import { and, asc, count, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { isReviewer, type Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { archive, artists, batches, items, libraryCache, mediaSnapshots, requests, users } from '../db/schema'
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

// Archived songs (v0.3.3 visibility, for every archive row, old and new):
// staff (review or manage) see all of them, with their state; a member sees
// an archived song only if they uploaded it through the portal (an item of
// a batch they own carries that media id) or a manager linked them to it,
// read-only: title, artist, when, and whether it is an Unreleased or a
// Removed song. Nothing else (no paths, no playlists, no files). The reason
// is staff-only (a manager's archive reason, or the removal request's), with
// one exception: a member sees the reason of their OWN removal request, the
// words they wrote themselves. Otherwise a member's row has reason null and
// the page shows a neutral status line.
export type ArchivedSong = {
  id: number
  label: 'Unreleased' | 'Removed'
  title: string | null
  artist: string | null
  fileName: string
  archivedAt: string
  reason: string | null
  staff?: {
    status: string
    origin: string
    mediaId: number
    folder: string | null
    originalPath: string
    requestId: number | null
    // The station playlists it had when archived (a hint for a release).
    playlistIds: number[]
    linkedUser: { id: string; name: string | null; discordId: string } | null
    uploader: { id: string; name: string | null } | null
    releaseArtistId: number | null
  }
}

export const ARCHIVED_PAGE_SIZE = 100

export type ArchivedPage = { rows: ArchivedSong[]; total: number; page: number; pages: number }

// Newest first, ARCHIVED_PAGE_SIZE per page (page 1 = newest); `total` is
// every row this viewer may see, so no row is ever silently cut off.
export async function archivedSongs(db: DB, v: Viewer, opts: { page?: number } = {}): Promise<ArchivedPage> {
  const staff = isReviewer(v)
  if (!staff && !v.perms.has('submit')) throw forbidden()
  const visible = staff
    ? sql`TRUE`
    : sql`(${archive.linkedUserId} = ${v.userId} OR EXISTS (
        SELECT 1 FROM items i JOIN batches b ON b.id = i.batch_id
        WHERE i.media_id = ${archive.mediaId} AND b.owner_user_id = ${v.userId}))`
  // 'restoring': a restore that stopped part way; Restore resumes it.
  // 'archiving': an archive that stopped part way; Resolve settles it (the
  // reconciler also does, once it is stale), Restore settles and restores.
  // Members see settled rows only.
  const statuses = staff ? (['archiving', 'archived', 'restoring'] as const) : (['archived'] as const)
  const where = and(inArray(archive.status, [...statuses]), visible)
  const [{ n: total } = { n: 0 }] = await db.select({ n: count() }).from(archive).where(where)
  const pages = Math.max(1, Math.ceil(total / ARCHIVED_PAGE_SIZE))
  const want = opts.page !== undefined && Number.isSafeInteger(opts.page) && opts.page >= 1 ? opts.page : 1
  const page = Math.min(want, pages)
  const rows = await db
    .select({
      a: archive,
      title: mediaSnapshots.title,
      artist: mediaSnapshots.artist,
      playlistIds: mediaSnapshots.playlistIds,
      requestReason: requests.reason,
      requestOwner: requests.ownerUserId,
      linkedName: users.name,
      linkedDiscordId: users.discordId,
    })
    .from(archive)
    .leftJoin(mediaSnapshots, eq(mediaSnapshots.id, archive.snapshotId))
    .leftJoin(requests, eq(requests.id, archive.requestId))
    .leftJoin(users, eq(users.id, archive.linkedUserId))
    .where(where)
    .orderBy(desc(archive.archivedAt), desc(archive.id))
    .limit(ARCHIVED_PAGE_SIZE)
    .offset((page - 1) * ARCHIVED_PAGE_SIZE)
  // Portal uploaders (staff only): the owner of the batch whose item went
  // live as this media id.
  const uploaders = new Map<number, { id: string; name: string | null }>()
  if (staff && rows.length) {
    const up = await db
      .select({ mediaId: items.mediaId, id: users.id, name: users.name })
      .from(items)
      .innerJoin(batches, eq(batches.id, items.batchId))
      .innerJoin(users, eq(users.id, batches.ownerUserId))
      .where(inArray(items.mediaId, [...new Set(rows.map((r) => r.a.mediaId))]))
    for (const u of up) if (u.mediaId !== null && !uploaders.has(u.mediaId)) uploaders.set(u.mediaId, { id: u.id, name: u.name })
  }
  const list = rows.map(({ a, title, artist, playlistIds, requestReason, requestOwner, linkedName, linkedDiscordId }): ArchivedSong => {
    const fileName = a.originalPath.slice(a.originalPath.lastIndexOf('/') + 1)
    const base: ArchivedSong = {
      id: a.id,
      label: a.origin === 'legacy_unreleased' ? 'Unreleased' : 'Removed',
      title: title ?? null,
      artist: artist ?? null,
      fileName,
      archivedAt: a.archivedAt.toISOString(),
      // archive.reason is always a manager's (manage.ts archiveLibrary); a
      // request's reason was written by the request's owner.
      reason: staff ? (a.reason ?? requestReason ?? null) : requestOwner === v.userId ? (requestReason ?? null) : null,
    }
    if (!staff) return base
    return {
      ...base,
      staff: {
        status: a.status,
        origin: a.origin,
        mediaId: a.mediaId,
        folder: a.origin === 'portal' ? folderOf(a.originalPath) : null,
        originalPath: a.originalPath,
        requestId: a.requestId,
        playlistIds: playlistIds ?? [],
        linkedUser: a.linkedUserId && linkedDiscordId ? { id: a.linkedUserId, name: linkedName ?? null, discordId: linkedDiscordId } : null,
        uploader: uploaders.get(a.mediaId) ?? null,
        releaseArtistId: a.releaseArtistId,
      },
    }
  })
  return { rows: list, total, page, pages }
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
