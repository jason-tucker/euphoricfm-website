// Read-only album-art URLs for the UI (art contract, "Display").
//
//  * Library songs: library_cache.art_url (the worker stores AzuraCast's art
//    URL there), else https://euphoric.fm/api/station/<shortcode>/art/<unique_id>.
//    The column comes from the foundation/P3 branches, so it is read through
//    to_jsonb and this works before and after that migration.
//  * Portal items: the signed, viewer-bound cover preview URL. After P3 the
//    cover route serves the EFFECTIVE cover (custom art, else embedded).

import { inArray, sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { items, libraryCache } from '../db/schema'
import { signMediaUrl } from '../media/signing'

export const ART_ORIGIN = 'https://euphoric.fm'
// Station shortcode for the fallback URL (settings.nowplaying_shortcode default).
const SHORTCODE = 'euphoricfm'

// Only https://euphoric.fm art is ever rendered (the CSP img-src allows it).
export function libraryArtUrl(artUrl: string | null | undefined, uniqueId: string | null | undefined): string | null {
  if (artUrl) {
    try {
      const u = new URL(artUrl)
      if (u.origin === ART_ORIGIN) return u.toString()
    } catch {
      // fall through
    }
  }
  if (uniqueId && /^[0-9a-f]{8,64}$/i.test(uniqueId)) return `${ART_ORIGIN}/api/station/${SHORTCODE}/art/${uniqueId}`
  return null
}

export async function libraryArt(db: DB, mediaIds: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>()
  const ids = [...new Set(mediaIds)]
  if (ids.length === 0) return out
  const rows = await db
    .select({ mediaId: libraryCache.mediaId, uniqueId: libraryCache.uniqueId, artUrl: sql<string | null>`to_jsonb(${libraryCache}) ->> 'art_url'` })
    .from(libraryCache)
    .where(inArray(libraryCache.mediaId, ids))
  for (const r of rows) out.set(r.mediaId, libraryArtUrl(r.artUrl, r.uniqueId))
  return out
}

// items.custom_art_id arrives with P3; read it without depending on it.
export function customArtIdOf(it: typeof items.$inferSelect): string | null {
  const v = (it as unknown as Record<string, unknown>).customArtId
  return v === null || v === undefined ? null : String(v)
}

export function itemHasArt(it: typeof items.$inferSelect): boolean {
  return Boolean(it.coverFile) || customArtIdOf(it) !== null
}

export function itemCoverUrl(viewerUserId: string, it: typeof items.$inferSelect): string | null {
  if (!it.probeSha256 || !itemHasArt(it)) return null
  try {
    return signMediaUrl('cover', it.id, viewerUserId)
  } catch {
    return null
  }
}
