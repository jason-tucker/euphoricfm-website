// Read access to art_uploads (art contract 2026-09-27) for attaching an
// upload to an item or a request and for handing its JPEG to finalize /
// uploadArt. The table is the foundation's (server/db/schema.ts artUploads):
// `owner` is users.id, `jpeg_path` the absolute probe-published
// /staging/art/<id>/cover.jpg, `status` processing | ready | rejected |
// expired. Only a `ready` row with a sha256 is usable.

import { eq } from 'drizzle-orm'
import type { DB } from '../db/client'
import { artUploads } from '../db/schema'
import { UUID_RE } from '../spool/protocol'

export type ArtUpload = { id: string; owner: string; status: string; jpegPath: string | null; jpegSha256: string | null }

type Q = Pick<DB, 'select'>

export async function loadArt(db: Q, artId: string): Promise<ArtUpload | null> {
  if (!UUID_RE.test(artId)) return null
  const [r] = await db
    .select({ id: artUploads.id, owner: artUploads.owner, status: artUploads.status, jpegPath: artUploads.jpegPath, jpegSha256: artUploads.jpegSha256 })
    .from(artUploads)
    .where(eq(artUploads.id, artId))
    .limit(1)
  return r ?? null
}

// A usable upload: ready, probe-verified, published at the expected path.
export function isUsableArt(a: ArtUpload | null, expectedJpegPath?: string): a is ArtUpload & { jpegPath: string; jpegSha256: string } {
  if (!a || a.status !== 'ready' || !a.jpegSha256 || !a.jpegPath) return false
  return expectedJpegPath === undefined || a.jpegPath === expectedJpegPath
}
