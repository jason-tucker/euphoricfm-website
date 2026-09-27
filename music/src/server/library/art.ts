// Read access to art_uploads (art contract 2026-09-27) for P3: attaching an
// upload to an item and handing its JPEG to finalize.
//
// The table, its migration and its drizzle declaration belong to the
// foundation branch (feat/music-portal-core). Until that merges, this reads
// it with raw SQL using the CONTRACT's column names
//   art_uploads(id, owner, status, reason, raw_path, jpeg_path, jpeg_sha256, created_at)
// so the two branches never declare the same table twice. After the merge
// this can switch to the declared table object.

import { sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { UUID_RE } from '../spool/protocol'

export type ArtUpload = { id: string; owner: string; status: string; jpegSha256: string | null }

type Q = Pick<DB, 'execute'>

export async function loadArt(db: Q, artId: string): Promise<ArtUpload | null> {
  if (!UUID_RE.test(artId)) return null
  const rows = (await db.execute<{ id: string; owner: string; status: string; jpeg_sha256: string | null }>(
    sql`SELECT id::text AS id, owner::text AS owner, status::text AS status, jpeg_sha256 FROM art_uploads WHERE id = ${artId}::uuid`,
  )) as unknown as { id: string; owner: string; status: string; jpeg_sha256: string | null }[]
  const r = rows[0]
  return r ? { id: r.id, owner: r.owner, status: r.status, jpegSha256: r.jpeg_sha256 } : null
}
