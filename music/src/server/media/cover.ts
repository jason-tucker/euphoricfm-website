// The EFFECTIVE cover of a portal item (art contract 2026-09-27): the
// item's custom art (a ready, probe-made JPEG in art_uploads) when one is
// attached, else the probe-time embedded cover. The same rule finalize uses
// for the APIC, so what reviewers preview is what goes on air. A custom art
// row that is no longer usable (expired, rejected) is NOT silently replaced
// by the embedded cover: finalize would refuse it, so there is no cover.
//
// Paths are built from validated ids only (never from a stored path):
//   custom    <STAGING_ART_DIR>/<art uuid>/cover.jpg
//   embedded  <STAGING_UPLOADS_DIR>/cover-<uuid>.jpg

import { join } from 'node:path'
import type { DB } from '../db/client'
import type { items } from '../db/schema'
import { isUsableArt, loadArt } from '../library/art'
import { ART_JPEG_FILE, COVER_FILE_RE, UUID_RE } from '../spool/protocol'

type Item = Pick<typeof items.$inferSelect, 'coverFile' | 'customArtId' | 'probeSha256'>

export type CoverFile = { dir: string; name: string; source: 'custom' | 'embedded' }

// Cheap check without I/O: may this item have an effective cover at all?
export function mayHaveCover(it: Item): boolean {
  return Boolean(it.probeSha256) && (Boolean(it.customArtId) || Boolean(it.coverFile))
}

export async function effectiveCover(db: Pick<DB, 'select'>, it: Item, dirs: { uploads: string; art: string }): Promise<CoverFile | null> {
  // Only items whose audio the probe accepted have a cover to show.
  if (!it.probeSha256) return null
  if (it.customArtId) {
    if (!UUID_RE.test(it.customArtId)) return null
    const art = await loadArt(db, it.customArtId)
    if (!isUsableArt(art) || art.id !== it.customArtId) return null
    return { dir: join(dirs.art, art.id), name: ART_JPEG_FILE, source: 'custom' }
  }
  if (it.coverFile && COVER_FILE_RE.test(it.coverFile)) return { dir: dirs.uploads, name: it.coverFile, source: 'embedded' }
  return null
}
