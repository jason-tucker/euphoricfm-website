// Retention for /staging/uploads (plan §3.4 "Expiry"), run by music-web (the
// only container with that directory mounted read-write):
//   * tus uploads never completed: 24 h
//   * completed uploads never attached to an item (drafts): 7 days
//   * denied / withdrawn / rejected items: 7 days after the decision
//   * live items: 7 days after going live
// Only names matching the fixed id / cover patterns are ever unlinked.

import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { items, uploads } from '../db/schema'
import { COVER_FILE_RE, UPLOAD_ID_RE } from '../spool/protocol'

const H = 3600_000
const D = 24 * H

async function removeUploadFiles(dir: string, uploadId: string | null, coverFile: string | null) {
  if (uploadId && UPLOAD_ID_RE.test(uploadId)) {
    await unlink(join(dir, uploadId)).catch(() => {})
    await unlink(join(dir, `${uploadId}.json`)).catch(() => {})
  }
  if (coverFile && COVER_FILE_RE.test(coverFile)) await unlink(join(dir, coverFile)).catch(() => {})
}

export async function sweepStaging(db: DB, dir: string, now = Date.now()): Promise<{ removed: number }> {
  let removed = 0
  const stale = await db
    .select()
    .from(uploads)
    .where(
      sql`(${uploads.status} = 'uploading' AND ${uploads.createdAt} < ${new Date(now - D)})
       OR (${uploads.status} = 'complete' AND ${uploads.createdAt} < ${new Date(now - 7 * D)})`,
    )
    .limit(500)
  for (const u of stale) {
    await removeUploadFiles(dir, u.id, null)
    await db.update(uploads).set({ status: 'expired' }).where(eq(uploads.id, u.id))
    removed++
  }
  const done = await db
    .select({ id: items.id, uploadId: items.uploadId, coverFile: items.coverFile })
    .from(items)
    .where(
      sql`((${items.status} IN ('denied','withdrawn','rejected') AND ${items.updatedAt} < ${new Date(now - 7 * D)})
        OR (${items.status} = 'live' AND ${items.liveAt} < ${new Date(now - 7 * D)}))
        AND ${items.uploadId} IS NOT NULL`,
    )
    .limit(500)
  for (const it of done) {
    await removeUploadFiles(dir, it.uploadId, it.coverFile)
    if (it.uploadId) await db.update(uploads).set({ status: 'expired' }).where(and(eq(uploads.id, it.uploadId), inArray(uploads.status, ['attached', 'complete'])))
    await db.update(items).set({ uploadId: null, coverFile: null }).where(eq(items.id, it.id))
    removed++
  }
  return { removed }
}
