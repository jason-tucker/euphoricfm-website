// Lost-row recovery (plan §3.7 "Recovery"): when a media id vanishes after a
// scan, poll by path after each later scan (≥ 3 cycles AND ≥ 20 min before
// giving up); once found, PUT the snapshot METADATA first, then re-apply the
// snapshot playlists (station ids only), remap the id everywhere, alert.
//
// Written for ingest (P3); moves / archive / restore (P4) can reuse
// findMediaByPath + reapplySnapshot + remapMediaId as they are.

import { eq, sql } from 'drizzle-orm'
import type { AzuraCastClient, StationMedia } from '../../server/azuracast/client'
import type { DB } from '../../server/db/client'
import { ingestRuns, mediaSnapshots } from '../../server/db/schema'
import { dirname } from '../../server/paths/builder'

export const RECOVERY_MIN_POLLS = 3
export const RECOVERY_MIN_MS = 20 * 60_000

type Snapshot = typeof mediaSnapshots.$inferSelect

// files/list (flushCache=true) on the parent dir; only a scanned media row
// counts ('File Processing' entries have media: null and are polled again).
export async function findMediaByPath(az: AzuraCastClient, path: string): Promise<StationMedia | null> {
  const entries = await az.listDirectory(dirname(path))
  const e = entries.find((x) => x.path === path)
  return e?.media ?? null
}

export function stationIdsOf(m: Pick<StationMedia, 'playlists'>, stationIds: ReadonlySet<number>): number[] {
  return [...new Set(m.playlists.map((p) => p.id).filter((id) => stationIds.has(id)))].sort((a, b) => a - b)
}

export async function reapplySnapshot(az: AzuraCastClient, mediaId: number, path: string, snap: Snapshot, stationIds: ReadonlySet<number>): Promise<number[]> {
  await az.updateMetadata(mediaId, { title: snap.title ?? '', artist: snap.artist ?? '', album: snap.album ?? '', genre: snap.genre ?? '' })
  const ids = snap.playlistIds.filter((id) => stationIds.has(id))
  await az.setPlaylists(path, ids, new Set(ids))
  return ids
}

// One transaction: every table that carries a media id.
export async function remapMediaId(db: DB, oldId: number, newId: number, uniqueId: string | null): Promise<void> {
  if (oldId === newId) return
  await db.transaction(async (tx) => {
    // The next library sync re-reads the new row; drop the stale one now so
    // the path's unique index never sees both.
    await tx.execute(sql`DELETE FROM library_cache WHERE media_id = ${oldId}`)
    await tx.execute(sql`UPDATE items SET media_id = ${newId}, updated_at = now() WHERE media_id = ${oldId}`)
    await tx.execute(sql`UPDATE requests SET media_id = ${newId}, updated_at = now() WHERE media_id = ${oldId}`)
    await tx.execute(sql`UPDATE archive SET media_id = ${newId}, unique_id = coalesce(${uniqueId}, unique_id) WHERE media_id = ${oldId}`)
    await tx.execute(sql`UPDATE media_snapshots SET media_id = ${newId}, unique_id = coalesce(${uniqueId}, unique_id) WHERE media_id = ${oldId}`)
    await tx.update(ingestRuns).set({ mediaId: newId, uniqueId, updatedAt: new Date() }).where(eq(ingestRuns.mediaId, oldId))
  })
}
