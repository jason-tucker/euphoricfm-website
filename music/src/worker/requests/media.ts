// Library-side helpers for the P4 jobs: station playlist filtering,
// media_snapshots, library_cache upkeep and id remapping after recovery.

import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { StationMedia } from '../../server/azuracast/client'
import type { DB } from '../../server/db/client'
import { archive, items, libraryCache, mediaSnapshots, requests } from '../../server/db/schema'
import { getSetting } from '../../server/settings'
import { metaOf, type Meta } from '../../server/requests/common'
import { Permanent } from '../handlers'

// A step failed for a reason retrying will not fix. `code` lands in
// requests.error and the ticket's "failed" post.
export class OpFailed extends Permanent {
  constructor(readonly code: string, readonly detail?: Record<string, unknown>) {
    super(code)
    this.name = 'OpFailed'
  }
}

const idList = z.array(z.number().int().positive()).min(1).max(512)

// Every playlist id that belongs to STATION_ID. Listings aggregate the
// memberships of every station on the storage (P0d-B (d): Events playlists
// show up too), so all playlist arithmetic is filtered through this set.
export async function stationPlaylistSet(db: DB): Promise<Set<number>> {
  const r = idList.safeParse(await getSetting(db, 'station_playlist_ids'))
  if (!r.success) throw new OpFailed('station_playlist_ids_unset')
  return new Set(r.data)
}

export function playlistIdsOf(media: StationMedia): number[] {
  return [...new Set((media.playlists ?? []).map((p) => p.id))].sort((a, b) => a - b)
}

export function stationIds(media: StationMedia, station: ReadonlySet<number>): number[] {
  return playlistIdsOf(media).filter((id) => station.has(id))
}

export function sameIds(a: readonly number[], b: readonly number[]): boolean {
  const x = [...new Set(a)].sort((p, q) => p - q)
  const y = [...new Set(b)].sort((p, q) => p - q)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

export type Snapshot = typeof mediaSnapshots.$inferSelect

export async function takeSnapshot(
  db: DB,
  media: StationMedia,
  station: ReadonlySet<number>,
  reason: string,
  links: { requestId?: number | null } = {},
): Promise<Snapshot> {
  const m = metaOf(media)
  const [row] = await db
    .insert(mediaSnapshots)
    .values({
      mediaId: media.id,
      uniqueId: media.unique_id,
      path: media.path,
      title: m.title,
      artist: m.artist,
      album: m.album,
      genre: m.genre,
      playlistIds: stationIds(media, station),
      reason,
      requestId: links.requestId ?? null,
    })
    .returning()
  return row!
}

export function snapshotMeta(s: Snapshot): Meta {
  return metaOf(s)
}

type Writer = Pick<DB, 'insert' | 'delete'>

export async function upsertLibrary(db: Writer, media: StationMedia): Promise<void> {
  const values = {
    mediaId: media.id,
    uniqueId: media.unique_id,
    path: media.path,
    title: media.title ?? null,
    artist: media.artist ?? null,
    album: media.album ?? null,
    genre: media.genre ?? null,
    playlistIds: playlistIdsOf(media),
    lengthS: typeof media.length === 'number' ? Math.round(media.length) : null,
    mtime: typeof media.mtime === 'number' ? Math.round(media.mtime) : null,
    refreshedAt: new Date(),
  }
  // A stale row may still hold this path (library_cache.path is unique).
  await db.delete(libraryCache).where(and(eq(libraryCache.path, media.path), ne(libraryCache.mediaId, media.id)))
  const { mediaId: _id, ...set } = values
  await db.insert(libraryCache).values(values).onConflictDoUpdate({ target: libraryCache.mediaId, set })
}

// Recovery: the row came back under a new id. Every table that names the
// media id follows it.
export async function remapMediaId(db: DB, oldId: number, media: StationMedia): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(libraryCache).where(eq(libraryCache.mediaId, oldId))
    await upsertLibrary(tx, media)
    await tx.update(items).set({ mediaId: media.id, updatedAt: new Date() }).where(eq(items.mediaId, oldId))
    await tx.update(requests).set({ mediaId: media.id, updatedAt: new Date() }).where(eq(requests.mediaId, oldId))
    await tx.update(archive).set({ mediaId: media.id, uniqueId: media.unique_id }).where(eq(archive.mediaId, oldId))
    await tx.update(mediaSnapshots).set({ mediaId: media.id }).where(eq(mediaSnapshots.mediaId, oldId))
  })
}
