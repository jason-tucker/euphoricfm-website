// Library-side helpers for the P4 jobs: station playlist filtering,
// media_snapshots and library_cache upkeep. (Id remapping after a lost row
// is library/recovery.ts remapMediaId, shared with the ingest re-verify.)

import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import type { StationMedia } from '../../server/azuracast/client'
import type { DB } from '../../server/db/client'
import { libraryCache, mediaSnapshots } from '../../server/db/schema'
import { getSetting } from '../../server/settings'
import { metaOf, type Meta } from '../../server/requests/common'
import { artUrlFor } from '../library/sync'
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

// Snapshots of state the portal actually APPLIED: the after_* snapshot of a
// mutation, taken only once it is verified, and the ingest snapshot. Only
// these supersede an older re-verify chain (requests/jobs.ts reverify, the
// ingest verify) or feed lost-row recovery. A before_* snapshot is taken
// before the first write; if that operation then fails or is refused, it
// records nothing the portal changed and must never win.
export const APPLIED_SNAPSHOT_REASONS = ['after_edit', 'after_move', 'after_art', 'after_playlists', 'after_archive', 'after_restore', 'ingest'] as const

export async function takeSnapshot(
  db: DB,
  media: StationMedia,
  station: ReadonlySet<number>,
  reason: string,
  links: { requestId?: number | null } = {},
  art: { hadArt?: boolean | null; artSha256?: string | null } = {},
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
      hadArt: art.hadArt ?? null,
      artSha256: art.artSha256 ?? null,
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
    // Current art (AzuraCast's `art`, which moves with art_updated_at), so an
    // apply_art shows at once instead of after the next library sync.
    artUrl: artUrlFor(media, 'euphoricfm'),
    refreshedAt: new Date(),
  }
  // A stale row may still hold this path (library_cache.path is unique).
  await db.delete(libraryCache).where(and(eq(libraryCache.path, media.path), ne(libraryCache.mediaId, media.id)))
  const { mediaId: _id, ...set } = values
  await db.insert(libraryCache).values(values).onConflictDoUpdate({ target: libraryCache.mediaId, set })
}
