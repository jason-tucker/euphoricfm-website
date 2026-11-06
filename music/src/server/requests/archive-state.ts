// Open archive operations, shared by web (manager actions) and worker.
//
// An archive row in 'archiving' or 'restoring' means a file move of that
// media is in flight (or stopped part way): its snapshot is the only record
// of the memberships the song had. While such a row exists no other
// mutation may touch the media (edits, moves, playlist and art changes
// wait), and a row that has not moved for ARCHIVE_STALE_MS with no live job
// is finished or rolled back by the worker's reconciler (requests/jobs.ts
// reconcileArchive), so it can never stay open for good.

import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { archive } from '../db/schema'

export const ARCHIVE_OP_STATUSES = ['archiving', 'restoring'] as const
export const ARCHIVE_STALE_MS = 30 * 60_000

export type ArchiveRow = typeof archive.$inferSelect

export async function archiveOpInProgress(db: DB, mediaId: number): Promise<ArchiveRow | null> {
  const row = await db.query.archive.findFirst({
    where: and(eq(archive.mediaId, mediaId), inArray(archive.status, [...ARCHIVE_OP_STATUSES])),
    orderBy: desc(archive.id),
  })
  return row ?? null
}

// A queued or running job that will act on this row: an archive of the
// media (direct, or through any removal request of it; it resumes the row),
// a legacy import of the media (it resumes the row too), a restore of the
// row, and, when asked, a reconcile of it.
export async function liveArchiveJob(db: Pick<DB, 'execute'>, row: Pick<ArchiveRow, 'id' | 'mediaId'>, opts: { includeReconcile?: boolean } = {}): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM jobs
    WHERE status IN ('queued', 'running') AND (
      (kind = 'archive' AND (payload->>'mediaId' = ${String(row.mediaId)}
        OR payload->>'requestId' IN (SELECT id::text FROM requests WHERE media_id = ${row.mediaId})))
      OR (kind = 'import_legacy_archive' AND payload->>'mediaId' = ${String(row.mediaId)})
      OR (kind = 'restore' AND payload->>'archiveId' = ${String(row.id)})
      OR (${opts.includeReconcile === true} AND kind = 'reconcile_archive' AND payload->>'archiveId' = ${String(row.id)}))
    LIMIT 1`)
  return (rows as unknown as unknown[]).length > 0
}
