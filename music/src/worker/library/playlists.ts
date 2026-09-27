// Station playlist ids. GET /files and files/list aggregate memberships from
// EVERY station on the storage (P0d-B (d)), so every playlist write filters
// by the ids that belong to STATION_ID (setting `station_playlist_ids`,
// recorded by the library sync). Before the first sync it falls back to the
// admin-configured assignable + default ids.

import type { DB } from '../../server/db/client'
import { getIntList, getSetting } from '../../server/settings'

export async function stationPlaylistIds(db: DB): Promise<Set<number>> {
  const raw = await getSetting(db, 'station_playlist_ids')
  if (Array.isArray(raw) && raw.every((x) => Number.isSafeInteger(x) && x > 0)) return new Set(raw as number[])
  return new Set([...(await getIntList(db, 'assignable_playlist_ids')), ...(await getIntList(db, 'default_playlist_ids'))])
}

// The ids ingest may apply: the approved ids that are still assignable and
// belong to this station.
export async function ingestPlaylistIds(db: DB, approved: readonly number[]): Promise<number[]> {
  const assignable = new Set(await getIntList(db, 'assignable_playlist_ids'))
  const station = await stationPlaylistIds(db)
  return [...new Set(approved)].filter((id) => assignable.has(id) && station.has(id)).sort((a, b) => a - b)
}
