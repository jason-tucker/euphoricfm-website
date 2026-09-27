// Album-art retention (art contract 2026-09-27), run by music-web next to
// the staging sweep:
//   * 'processing' for more than 24 h (the probe never answered): rejected;
//   * ready / rejected art older than 7 days that nothing still references:
//     expired; its raw bytes are deleted here (web owns art-in) and an
//     'art_release' request asks the probe (the only writer of the art dir)
//     to delete the JPEG.
// A reference keeps art alive until the referencing item or request is
// finished, plus 7 days: items.custom_art_id (P3's column; read through
// to_jsonb so this also runs before that column exists) and
// requests.proposed->>'artId' (P4's edit requests).

import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { and, eq, lt, sql } from 'drizzle-orm'
import { audit } from '../audit'
import type { DB } from '../db/client'
import { artUploads } from '../db/schema'
import { writeSpoolRequest } from '../spool/protocol'

const D = 24 * 3600_000

// Finished = no further use of the art is possible.
const ITEM_DONE = `('live', 'denied', 'withdrawn', 'rejected', 'failed')`
const REQUEST_DONE = `('done', 'denied', 'withdrawn', 'failed')`

export async function sweepArt(db: DB, dirs: { spoolIn: string }, now = Date.now()): Promise<{ expired: number; timedOut: number }> {
  const timedOut = await db
    .update(artUploads)
    .set({ status: 'rejected', reason: 'probe_timeout', updatedAt: new Date(now) })
    .where(and(eq(artUploads.status, 'processing'), lt(artUploads.createdAt, new Date(now - D))))
    .returning({ id: artUploads.id, rawPath: artUploads.rawPath })
  for (const r of timedOut) if (r.rawPath) await unlink(r.rawPath).catch(() => {})

  const cutoff = new Date(now - 7 * D)
  const cut = sql`${cutoff.toISOString()}::timestamptz`
  const stale = await db.execute<{ id: string; status: string; raw_path: string | null }>(sql`
    SELECT a.id::text AS id, a.status::text AS status, a.raw_path
    FROM art_uploads a
    WHERE a.status IN ('ready', 'rejected') AND a.created_at < ${cut}
      AND NOT EXISTS (
        SELECT 1 FROM items i
        WHERE to_jsonb(i) ->> 'custom_art_id' = a.id::text
          AND (i.status::text NOT IN ${sql.raw(ITEM_DONE)} OR i.updated_at > ${cut}))
      AND NOT EXISTS (
        SELECT 1 FROM requests r
        WHERE r.proposed ->> 'artId' = a.id::text
          AND (r.status::text NOT IN ${sql.raw(REQUEST_DONE)} OR r.updated_at > ${cut}))
    LIMIT 500`)
  let expired = 0
  for (const a of stale as unknown as { id: string; status: string; raw_path: string | null }[]) {
    const upd = await db
      .update(artUploads)
      .set({ status: 'expired', updatedAt: new Date(now) })
      .where(and(eq(artUploads.id, a.id), sql`${artUploads.status}::text = ${a.status}`))
      .returning({ id: artUploads.id })
    if (upd.length !== 1) continue
    if (a.raw_path) await unlink(a.raw_path).catch(() => {})
    if (a.status === 'ready') {
      await writeSpoolRequest(dirs.spoolIn, { v: 1, id: randomUUID(), type: 'art_release', artId: a.id }).catch(() => {})
    }
    await audit(db, { action: 'art.expired', targetType: 'art', targetId: a.id, detail: { previous: a.status } })
    expired++
  }
  return { expired, timedOut: timedOut.length }
}
