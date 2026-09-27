// Album art for existing songs (art contract 2026-09-27, P4 part).
//
// STUB BOUNDARY: the foundation fix branch owns the `art_uploads` table
// (id, owner, status, reason, raw_path, jpeg_path, jpeg_sha256, created_at)
// and the wrapper's `uploadArt(mediaId, jpegPath, expectedSha256)`. Until
// they land, this module reads the table by the contract's column names with
// raw SQL (a missing table reads as "not ready"), and the worker looks the
// wrapper method up at runtime (src/worker/requests/art.ts). Replace both
// with the real schema object / typed method once merged.

import { sql } from 'drizzle-orm'
import type { DB } from '../db/client'

export type ReadyArt = { id: string; owner: string; jpegPath: string; jpegSha256: string }

type Row = { id: string; owner: string; jpeg_path: string | null; jpeg_sha256: string | null }

// A probe-processed art upload in status 'ready', or null.
export async function getReadyArt(db: Pick<DB, 'execute'>, artId: string): Promise<ReadyArt | null> {
  let rows: Row[]
  try {
    rows = (await db.execute<Row>(
      sql`SELECT id::text AS id, owner::text AS owner, jpeg_path, jpeg_sha256 FROM art_uploads WHERE id::text = ${artId} AND status = 'ready' LIMIT 1`,
    )) as unknown as Row[]
  } catch (e) {
    // 42P01 undefined_table: the foundation migration has not landed.
    if ((e as { code?: string })?.code === '42P01' || (e as { cause?: { code?: string } })?.cause?.code === '42P01') return null
    throw e
  }
  const r = rows[0]
  if (!r || !r.jpeg_path || !r.jpeg_sha256 || !/^[0-9a-f]{64}$/.test(r.jpeg_sha256)) return null
  return { id: r.id, owner: r.owner, jpegPath: r.jpeg_path, jpegSha256: r.jpeg_sha256 }
}
