// Read-only library lookups for the submit and review UI: artist/album
// autocomplete, known-artist resolution with a proposed folder, and
// duplicate hints. Every library_cache result is whitelisted to
// Music/Artists/** (plan §3.3 "Search the library"): once in SQL (LIKE on the
// literal prefix) and again in JS through the path builder's own predicate.

import { and, asc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm'
import { isReviewer, type Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { artists, items, libraryCache } from '../db/schema'
import { isLibrarySurface, newArtistFolder, PathError } from '../paths/builder'

// The web process has no path prefix: it only ever reads the production
// library layout (the Portal-Test/ prefix lives in the worker).
const ROOT = ''
const SURFACE_LIKE = 'Music/Artists/%'

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export function onLibrarySurface(path: string): boolean {
  return isLibrarySurface(ROOT, path)
}

export type ArtistHit = { id: number; name: string; folder: string }

export async function searchArtists(db: DB, q: string, limit = 10): Promise<ArtistHit[]> {
  const pat = `%${escapeLike(q)}%`
  const rows = await db
    .select({ id: artists.id, name: artists.name, folder: artists.folder })
    .from(artists)
    .where(
      and(
        eq(artists.status, 'active'),
        or(ilike(artists.name, pat), ilike(artists.folder, pat), sql`EXISTS (SELECT 1 FROM unnest(${artists.aliases}) a WHERE a ILIKE ${pat})`),
      ),
    )
    .orderBy(asc(artists.name))
    .limit(limit)
  return rows
}

export type AlbumHit = { album: string; artist: string | null }

export async function searchAlbums(db: DB, q: string, limit = 10): Promise<AlbumHit[]> {
  const pat = `%${escapeLike(q)}%`
  const rows = await db
    .select({ album: libraryCache.album, artist: libraryCache.artist, path: libraryCache.path })
    .from(libraryCache)
    .where(and(sql`${libraryCache.path} LIKE ${SURFACE_LIKE}`, ilike(libraryCache.album, pat)))
    .orderBy(asc(libraryCache.album))
    .limit(200)
  const seen = new Set<string>()
  const out: AlbumHit[] = []
  for (const r of rows) {
    if (!r.album || !onLibrarySurface(r.path)) continue
    const k = `${r.album.toLowerCase()}|${(r.artist ?? '').toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ album: r.album, artist: r.artist })
    if (out.length >= limit) break
  }
  return out
}

export type ArtistLookup = {
  known: ArtistHit | null
  proposedFolder: string | null
  folderError: string | null
  // True when some artist row (any status) already uses the proposed folder.
  folderTaken: boolean
}

// Exact (case-insensitive) match on an active artist's name or alias. When
// there is none, the artist is NEW and the proposed folder comes from the
// real path builder, so the preview is exactly what ingest would create.
export async function lookupArtist(db: DB, name: string): Promise<ArtistLookup> {
  const n = name.trim()
  if (n === '') return { known: null, proposedFolder: null, folderError: 'empty_component', folderTaken: false }
  const [known] = await db
    .select({ id: artists.id, name: artists.name, folder: artists.folder })
    .from(artists)
    .where(
      and(
        eq(artists.status, 'active'),
        or(sql`lower(${artists.name}) = lower(${n})`, sql`EXISTS (SELECT 1 FROM unnest(${artists.aliases}) a WHERE lower(a) = lower(${n}))`),
      ),
    )
    .limit(1)
  if (known) return { known, proposedFolder: null, folderError: null, folderTaken: false }
  return { known: null, ...(await previewFolder(db, n)) }
}

// Live sanitizer preview for a folder name typed by a reviewer.
export async function previewFolder(db: DB, raw: string): Promise<Omit<ArtistLookup, 'known'>> {
  let folder: string
  try {
    folder = newArtistFolder(raw)
  } catch (e) {
    return { proposedFolder: null, folderError: e instanceof PathError ? e.code : 'invalid', folderTaken: false }
  }
  const [taken] = await db.select({ id: artists.id }).from(artists).where(sql`lower(${artists.folder}) = lower(${folder})`).limit(1)
  return { proposedFolder: folder, folderError: null, folderTaken: Boolean(taken) }
}

export type DuplicateHint =
  | { kind: 'library'; title: string | null; artist: string | null; album: string | null }
  | { kind: 'item'; itemId: number; batchId: number; title: string | null; artist: string | null; status: string; own: boolean }

// Same title + artist (case-insensitive) already in the library, or in a
// portal item that is still in play. Members only see their OWN items here;
// reviewers see every submission.
export async function findDuplicates(db: DB, v: Viewer, title: string, artist: string, excludeItemId?: number): Promise<DuplicateHint[]> {
  const t = title.trim()
  const a = artist.trim()
  if (!t || !a) return []
  const lib = await db
    .select({ title: libraryCache.title, artist: libraryCache.artist, album: libraryCache.album, path: libraryCache.path })
    .from(libraryCache)
    .where(and(sql`${libraryCache.path} LIKE ${SURFACE_LIKE}`, sql`lower(${libraryCache.title}) = lower(${t})`, sql`lower(${libraryCache.artist}) = lower(${a})`))
    .limit(5)
  const conds = [
    sql`lower(${items.title}) = lower(${t})`,
    sql`lower(${items.artist}) = lower(${a})`,
    inArray(items.status, ['pending', 'approved', 'applying', 'verifying', 'live']),
    eq(items.kind, 'song'),
  ]
  if (excludeItemId) conds.push(ne(items.id, excludeItemId))
  if (!isReviewer(v)) conds.push(eq(items.ownerUserId, v.userId))
  const its = await db
    .select({ id: items.id, batchId: items.batchId, title: items.title, artist: items.artist, status: items.status, owner: items.ownerUserId })
    .from(items)
    .where(and(...conds))
    .limit(5)
  return [
    ...lib.filter((r) => onLibrarySurface(r.path)).map((r) => ({ kind: 'library' as const, title: r.title, artist: r.artist, album: r.album })),
    ...its.map((i) => ({ kind: 'item' as const, itemId: i.id, batchId: i.batchId, title: i.title, artist: i.artist, status: i.status, own: i.owner === v.userId })),
  ]
}
