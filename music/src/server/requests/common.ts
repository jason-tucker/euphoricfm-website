// Pure pieces of the P4 request/library model, shared by web and worker.
//
//  * the target whitelist (plan §3.3 / §3.5): a request, direct edit, archive
//    or playlist change may name only a file directly inside an artist folder,
//    `<root>Music/Artists/<folder>/<file>`. ADS/, Events/, UNRELEASED-*,
//    Removed/ and (in production) Portal-Test/ are all outside it;
//  * the strict `proposed` shape {title?, artist?, album?, genre?};
//  * "main artist" comparison for edits (featured artists do not move files).

import { and, eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { DB } from '../db/client'
import { artists } from '../db/schema'
import { META_DISALLOWED_RE } from '../../probe/tags'
import { assertSafePath, patterns } from '../paths/builder'
import { UUID_RE } from '../spool/protocol'

export const META_KEYS = ['title', 'artist', 'album', 'genre'] as const
export type MetaKey = (typeof META_KEYS)[number]
export type Meta = Record<MetaKey, string>

// Song metadata text, wherever a member or reviewer sets it (edit requests
// here, the item PATCH in submissions.ts): NFC, trimmed, at most `max`
// characters after normalization, and none of META_DISALLOWED_RE (controls
// incl. \n and \t, \p{Cf} bidi / zero-width, U+2028 / U+2029). The probe
// cleans pre-filled tags with the same rule (probe/tags.ts clipTag).
export const metaText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.normalize('NFC').trim())
    .refine((s) => s.length <= max, 'too long')
    .refine((s) => !META_DISALLOWED_RE.test(s), 'control characters')

// Same character rules as the AzuraCast wrapper's metadata body (≤255, no
// control characters), trimmed, and title/artist may not be blank.
const metaValue = metaText(255)

// art_uploads id (contract: artId): the foundation's art ids are v4 UUIDs.
export const ArtIdSchema = z.string().regex(UUID_RE)

export const ProposedSchema = z
  .object({
    title: metaValue.refine((s) => s.length > 0, 'title cannot be blank').optional(),
    artist: metaValue.refine((s) => s.length > 0, 'artist cannot be blank').optional(),
    album: metaValue.optional(),
    genre: metaValue.optional(),
    artId: ArtIdSchema.optional(),
  })
  .strict()
  .refine((p) => META_KEYS.some((k) => p[k] !== undefined) || p.artId !== undefined, 'nothing proposed')
export type Proposed = z.infer<typeof ProposedSchema>

// Free text (reasons): newlines and tabs allowed, other control chars not.
export const freeText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .refine((s) => !/[\p{Cc}]/u.test(s.replace(/[\n\t]/g, '')), 'control characters')

export function metaOf(m: { title?: string | null; artist?: string | null; album?: string | null; genre?: string | null }): Meta {
  return { title: m.title ?? '', artist: m.artist ?? '', album: m.album ?? '', genre: m.genre ?? '' }
}

// Proposed fields over the current values, field by field (never a spread
// of user input into a request body).
export function applyProposed(current: Meta, p: Proposed): Meta {
  return {
    title: p.title ?? current.title,
    artist: p.artist ?? current.artist,
    album: p.album ?? current.album,
    genre: p.genre ?? current.genre,
  }
}

export function sameMeta(a: Meta, b: Meta): boolean {
  return META_KEYS.every((k) => a[k] === b[k])
}

// The whitelist. `root` is '' in production, PORTAL_TEST_PREFIX otherwise.
export function isRequestTarget(root: string, path: string): boolean {
  try {
    assertSafePath(path)
    return patterns(root).artistFile.test(path)
  } catch {
    return false
  }
}

export function folderOfPath(root: string, path: string): string {
  return path.slice(`${root}Music/Artists/`.length).split('/')[0] ?? ''
}

// "Main artist": the credited artist before any featured artists. Only a
// change of main artist moves the file to another artist folder.
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s+/i
export function mainArtist(artist: string | null | undefined): string {
  return (artist ?? '').normalize('NFC').split(FEAT)[0]!.replace(/\s+/g, ' ').trim()
}
export const artistKey = (s: string) => mainArtist(s).toLowerCase()

export function mainArtistChanged(before: string | null | undefined, after: string | null | undefined): boolean {
  return artistKey(before ?? '') !== artistKey(after ?? '')
}

// Finds the artists row for a main-artist name (name, folder or alias,
// case-insensitive), preferring an active one.
export async function resolveArtist(db: Pick<DB, 'select'>, name: string) {
  const n = artistKey(name)
  if (!n) return null
  const rows = await db
    .select()
    .from(artists)
    .where(
      or(
        eq(sql`lower(${artists.name})`, n),
        eq(sql`lower(${artists.folder})`, n),
        sql`EXISTS (SELECT 1 FROM unnest(${artists.aliases}) a WHERE lower(a) = ${n})`,
      ),
    )
    .orderBy(sql`(${artists.status} = 'active') DESC`, artists.id)
    .limit(1)
  return rows[0] ?? null
}

export async function activeFolders(db: Pick<DB, 'select'>): Promise<Set<string>> {
  const rows = await db.select({ folder: artists.folder }).from(artists).where(and(eq(artists.status, 'active')))
  return new Set(rows.map((r) => r.folder))
}

export const REQUEST_OPEN_STATUSES = ['pending', 'approved', 'applying', 'verifying'] as const

export const DEFAULT_REQUEST_CAPS = { edit: 10, removal: 10 } as const
