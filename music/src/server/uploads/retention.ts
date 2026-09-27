// Retention for /staging/uploads (plan §3.4 "Expiry"), run by music-web (the
// only container with that directory mounted read-write):
//   * tus uploads never completed: 24 h
//   * completed uploads never attached to an item: 7 days
//   * drafts: items still probing / pending / draft in a batch that was never
//     submitted, 7 days after the item was added (the item becomes
//     'withdrawn' with probe_error 'draft_expired', its upload 'expired', and
//     an emptied old draft batch becomes 'withdrawn'); audited
//   * denied / withdrawn / rejected items: 7 days after the decision
//   * live items: 7 days after going live
// Only names matching the fixed id / cover patterns are ever unlinked.

import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import { audit } from '../audit'
import type { DB } from '../db/client'
import { batches, items, uploads } from '../db/schema'
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
      or(
        and(eq(uploads.status, 'uploading'), lt(uploads.createdAt, new Date(now - D))),
        and(eq(uploads.status, 'complete'), lt(uploads.createdAt, new Date(now - 7 * D))),
      ),
    )
    .limit(500)
  for (const u of stale) {
    await removeUploadFiles(dir, u.id, null)
    await db.update(uploads).set({ status: 'expired' }).where(eq(uploads.id, u.id))
    removed++
  }
  // Drafts: never submitted within 7 days. The conditional UPDATE runs first
  // (same status as selected, batch still a draft), so a submit that races
  // the sweep keeps its files.
  const drafts = await db
    .select({ id: items.id, status: items.status, uploadId: items.uploadId, coverFile: items.coverFile, batchId: items.batchId, ownerUserId: items.ownerUserId })
    .from(items)
    .innerJoin(batches, eq(batches.id, items.batchId))
    .where(and(eq(batches.status, 'draft'), inArray(items.status, ['probing', 'pending', 'draft']), lt(items.createdAt, new Date(now - 7 * D))))
    .limit(500)
  for (const it of drafts) {
    const upd = await db
      .update(items)
      .set({ status: 'withdrawn', probeError: 'draft_expired', uploadId: null, coverFile: null, updatedAt: new Date(now) })
      .where(
        and(
          eq(items.id, it.id),
          eq(items.status, it.status),
          sql`EXISTS (SELECT 1 FROM batches b WHERE b.id = ${items.batchId} AND b.status = 'draft')`,
        ),
      )
      .returning({ id: items.id })
    if (upd.length !== 1) continue
    if (it.uploadId) await db.update(uploads).set({ status: 'expired' }).where(and(eq(uploads.id, it.uploadId), inArray(uploads.status, ['attached', 'complete'])))
    await removeUploadFiles(dir, it.uploadId, it.coverFile)
    await audit(db, { actorUserId: it.ownerUserId, action: 'item.draft_expired', targetType: 'item', targetId: it.id, detail: { batchId: it.batchId, uploadId: it.uploadId, previousStatus: it.status } })
    removed++
  }
  // An old draft batch with nothing left to submit is closed as withdrawn.
  await db
    .update(batches)
    .set({ status: 'withdrawn', updatedAt: new Date(now) })
    .where(
      and(
        eq(batches.status, 'draft'),
        lt(batches.createdAt, new Date(now - 7 * D)),
        sql`NOT EXISTS (SELECT 1 FROM items i WHERE i.batch_id = ${batches.id} AND i.status IN ('probing', 'pending', 'draft'))`,
      ),
    )

  const done = await db
    .select({ id: items.id, uploadId: items.uploadId, coverFile: items.coverFile })
    .from(items)
    .where(
      and(
        isNotNull(items.uploadId),
        or(
          and(inArray(items.status, ['denied', 'withdrawn', 'rejected']), lt(items.updatedAt, new Date(now - 7 * D))),
          and(eq(items.status, 'live'), lt(items.liveAt, new Date(now - 7 * D))),
        ),
      ),
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
