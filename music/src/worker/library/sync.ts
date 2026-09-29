// library_cache sync (plan §3.1, P3): the full paginated GET /files every
// 10 minutes and after mutations. Every row the portal keeps is on the
// Music/Artists/** surface; UNRELEASED*, Removed/ and Portal-Test/ never
// enter (the whitelist is anchored at the production root, so a
// Portal-Test/Music/Artists/… path is outside it too).
//
// It also seeds `artists` from the live layout (insert-if-absent; the folder
// is the actual path segment, the name the first-listed artist that matches
// it) and maintains station_playlist_ids (sync-owned; see stationSet).

import { createHash } from 'node:crypto'
import { notInArray, sql } from 'drizzle-orm'
import type { StationMedia } from '../../server/azuracast/client'
import { audit } from '../../server/audit'
import { artists, libraryCache, settings } from '../../server/db/schema'
import { mainArtist } from '../../server/library/artists'
import { assertExistingFolder, isLibrarySurface } from '../../server/paths/builder'
import { getIntList, getSetting } from '../../server/settings'
import type { P3Ctx } from '../ingest/context'

const EXCLUDED_SEGMENT = /^(UNRELEASED|Removed$|Portal-Test)/i

export function isLibraryPath(path: string): boolean {
  // Music/Artists/<folder>/<file…>: a file directly in Music/Artists has no artist folder.
  if (!isLibrarySurface('', path) || path.split('/').length < 4) return false
  return !path.split('/').some((seg) => EXCLUDED_SEGMENT.test(seg))
}

export function folderOf(path: string): string {
  return path.split('/')[2]!
}

// Folder → {name, aliases}: the name is the file artist whose main artist
// equals the folder (case-insensitive), else the folder itself; the other
// main-artist spellings become aliases (Grimm → GRIM).
export function artistsFromLibrary(rows: readonly Pick<StationMedia, 'path' | 'artist'>[]): Map<string, { name: string; aliases: string[] }> {
  const byFolder = new Map<string, string[]>()
  for (const r of rows) {
    const f = folderOf(r.path)
    const m = mainArtist(r.artist)
    const list = byFolder.get(f) ?? []
    if (m) list.push(m)
    byFolder.set(f, list)
  }
  const out = new Map<string, { name: string; aliases: string[] }>()
  for (const [folder, mains] of byFolder) {
    try {
      assertExistingFolder(folder)
    } catch {
      continue
    }
    const name = mains.find((m) => m.toLowerCase() === folder.toLowerCase()) ?? folder
    const aliases = [...new Map(mains.filter((m) => m.toLowerCase() !== name.toLowerCase()).map((m) => [m.toLowerCase(), m])).values()].slice(0, 20)
    out.set(folder, { name, aliases })
  }
  return out
}

async function putSetting(ctx: P3Ctx, key: string, value: unknown) {
  await ctx.db
    .insert(settings)
    .values({ key, value, updatedBy: 'worker' })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date(), updatedBy: 'worker' } })
}

// Current art for a library song (art contract): AzuraCast's own `art` URL
// when it is on the public AzuraCast origin (the CSP allows only that),
// else /api/station/<shortcode>/art/<unique_id> there.
export const ART_ORIGIN = 'https://euphoric.fm'

export function artUrlFor(m: Pick<StationMedia, 'unique_id'> & { art?: unknown }, shortcode: string): string {
  if (typeof m.art === 'string') {
    try {
      const u = new URL(m.art)
      if (u.origin === ART_ORIGIN && u.pathname.startsWith('/api/')) return u.href
    } catch {
      // fall through
    }
  }
  return `${ART_ORIGIN}/api/station/${encodeURIComponent(shortcode)}/art/${encodeURIComponent(m.unique_id)}`
}

// skipped (v0.4.1): the listing was the same as at the last sync, so the
// cache and the artists were left untouched.
export type SyncResult = { total: number; library: number; removed: number; artistsAdded: number; stationPlaylistIds: number[]; skipped: boolean }

// v0.4.1: everything the cache rows are built from. Unchanged since the last
// sync (and the row count agrees) → no rewrite of ~350 rows every 10 min.
export const LIBRARY_HASH_KEY = 'library_sync_hash'

export function listingHash(rows: readonly StationMedia[], foreign: ReadonlySet<number>, shortcode: string): string {
  const h = createHash('sha256')
  h.update(JSON.stringify([shortcode, [...foreign].sort((a, b) => a - b)]))
  for (const r of rows) {
    h.update(
      JSON.stringify([
        r.id,
        r.unique_id,
        r.path,
        r.title ?? null,
        r.artist ?? null,
        r.album ?? null,
        r.genre ?? null,
        r.playlists.map((p) => p.id),
        typeof r.length === 'number' ? Math.round(r.length) : null,
        typeof r.mtime === 'number' ? Math.round(r.mtime) : null,
        artUrlFor(r, shortcode),
      ]),
    )
    h.update('\n')
  }
  return h.digest('hex')
}

const intList = (v: unknown): number[] | null => (Array.isArray(v) && v.every((x) => Number.isSafeInteger(x) && x > 0) ? (v as number[]) : null)
const sorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b)

// station_playlist_ids is SYNC-OWNED (read-only in the admin UI; the admin
// control is foreign_playlist_ids, the Events station's playlists). The
// known set never shrinks by observation: it is the previous set plus the
// configured assignable/default ids plus every id seen on the library
// surface, minus the ids an admin marked foreign. A seen id that is neither
// known nor foreign may be a NEW Events playlist: it is alerted once and
// counted as station 1 (the safe side for merges, which then never drop the
// membership) and recorded in unconfirmed_playlist_ids, the only station ids
// an admin may still move to foreign. The first sync (no previous set) does
// the same for every observed id that is neither configured nor foreign:
// nothing has confirmed those either (a new Events playlist the default
// foreign list does not name must stay movable to foreign).
export function stationSet(opts: {
  prev: readonly number[] | null
  prevUnconfirmed: readonly number[]
  configured: readonly number[]
  foreign: ReadonlySet<number>
  observed: ReadonlySet<number>
}): { station: number[]; unconfirmed: number[]; fresh: number[] } {
  const configured = new Set(opts.configured)
  const known = new Set([...(opts.prev ?? []), ...configured])
  const fresh = sorted([...opts.observed].filter((id) => !known.has(id) && !opts.foreign.has(id)))
  const station = sorted([...known, ...opts.observed].filter((id) => configured.has(id) || !opts.foreign.has(id)))
  const unconfirmed = sorted([...opts.prevUnconfirmed, ...fresh].filter((id) => station.includes(id) && !configured.has(id)))
  return { station, unconfirmed, fresh }
}

export async function syncLibrary(ctx: P3Ctx): Promise<SyncResult> {
  const all = await ctx.azuracast.listAllFiles(100)
  const rows = all.filter((f) => isLibraryPath(f.path))

  // Station playlist ids (stationSet above).
  const foreign = new Set(await getIntList(ctx.db, 'foreign_playlist_ids'))
  const observed = new Set<number>()
  for (const r of rows) for (const p of r.playlists) observed.add(p.id)
  const configured = [...(await getIntList(ctx.db, 'assignable_playlist_ids')), ...(await getIntList(ctx.db, 'default_playlist_ids'))]
  const prev = intList(await getSetting(ctx.db, 'station_playlist_ids'))
  const prevUnconfirmed = intList(await getSetting(ctx.db, 'unconfirmed_playlist_ids')) ?? []
  const { station: stationIds, unconfirmed, fresh } = stationSet({ prev, prevUnconfirmed, configured, foreign, observed })

  const [{ n: existing } = { n: 0 }] = (await ctx.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM library_cache`)) as unknown as { n: number }[]
  // A listing that suddenly shrinks by half is more likely an API problem
  // than a real mass removal: keep the old rows and alert.
  const prune = !(existing > 20 && rows.length < existing / 2)
  if (!prune) await ctx.alert('library sync: listing shrank by more than half; stale rows kept', { existing, now: rows.length })

  const sc = await getSetting(ctx.db, 'nowplaying_shortcode')
  const shortcode = typeof sc === 'string' && /^[a-z0-9_]{1,64}$/.test(sc) ? sc : 'euphoricfm'

  const hash = listingHash(rows, foreign, shortcode)
  const skipped = prune && existing === rows.length && (await getSetting(ctx.db, LIBRARY_HASH_KEY)) === hash

  let removed = 0
  let artistsAdded = 0
  if (!skipped) {
    await ctx.db.transaction(async (tx) => {
      const ids = rows.map((r) => r.id)
      if (prune) {
        const del = await tx
          .delete(libraryCache)
          .where(ids.length ? notInArray(libraryCache.mediaId, ids) : undefined)
          .returning({ id: libraryCache.mediaId })
        removed = del.length
      }
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100)
        // A path whose media id changed (a lost-and-reimported row) must free
        // the unique path first.
        for (const r of chunk) await tx.execute(sql`DELETE FROM library_cache WHERE path = ${r.path} AND media_id <> ${r.id}`)
        await tx
          .insert(libraryCache)
          .values(
            chunk.map((r) => ({
              mediaId: r.id,
              uniqueId: r.unique_id,
              path: r.path,
              title: r.title ?? null,
              artist: r.artist ?? null,
              album: r.album ?? null,
              genre: r.genre ?? null,
              playlistIds: r.playlists.map((p) => p.id).filter((id) => !foreign.has(id)),
              lengthS: typeof r.length === 'number' ? Math.round(r.length) : null,
              mtime: typeof r.mtime === 'number' ? Math.round(r.mtime) : null,
              artUrl: artUrlFor(r, shortcode),
              refreshedAt: new Date(ctx.now()),
            })),
          )
          .onConflictDoUpdate({
            target: libraryCache.mediaId,
            set: {
              uniqueId: sql`excluded.unique_id`,
              path: sql`excluded.path`,
              title: sql`excluded.title`,
              artist: sql`excluded.artist`,
              album: sql`excluded.album`,
              genre: sql`excluded.genre`,
              playlistIds: sql`excluded.playlist_ids`,
              lengthS: sql`excluded.length_s`,
              mtime: sql`excluded.mtime`,
              artUrl: sql`excluded.art_url`,
              refreshedAt: sql`excluded.refreshed_at`,
            },
          })
      }
    })

    for (const [folder, a] of artistsFromLibrary(rows)) {
      const ins = await ctx.db
        .insert(artists)
        .values({ name: a.name, folder, aliases: a.aliases, status: 'active' })
        .onConflictDoNothing({ target: artists.folder })
        .returning({ id: artists.id })
      artistsAdded += ins.length
    }
    if (artistsAdded > 0) await audit(ctx.db, { action: 'artists.seed', targetType: 'artists', detail: { added: artistsAdded } })
    // Only after a full, pruned sync: a shrunken listing (rows kept) is synced
    // again next time.
    if (prune) await putSetting(ctx, LIBRARY_HASH_KEY, hash)
  }

  if (JSON.stringify(prev) !== JSON.stringify(stationIds)) {
    await putSetting(ctx, 'station_playlist_ids', stationIds)
    await audit(ctx.db, { action: 'settings.station_playlist_ids', targetType: 'settings', detail: { from: prev ?? null, to: stationIds, fresh } })
  }
  if (JSON.stringify(prevUnconfirmed) !== JSON.stringify(unconfirmed)) await putSetting(ctx, 'unconfirmed_playlist_ids', unconfirmed)
  if (fresh.length > 0) {
    const what = prev === null ? 'first library sync: playlist id(s) not in the assignable, default or foreign lists' : 'library sync: new playlist id(s)'
    await ctx.alert(`${what} ${fresh.join(', ')} counted as station 1 (unconfirmed); if any belongs to the Events station, add it to foreign_playlist_ids (admin settings)`, {
      playlistIds: fresh,
      firstSync: prev === null,
    })
  }
  return { total: all.length, library: rows.length, removed, artistsAdded, stationPlaylistIds: stationIds, skipped }
}
