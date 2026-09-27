// Upload admission (plan §3.4): Upload-Length 1..35 MB, no defer-length, no
// concatenation, no creation-with-upload body; per user ≤1 GB in flight
// (uploading + complete + attached-but-undecided bytes) and
// ≤3 concurrent uploads; ≤5 GB staged globally (album art included, v0.2.1);
// pause above 85 % disk use.
// Header rules are pure (unit-tested); quota rules run in one transaction
// under advisory locks so concurrent creates cannot overshoot.

import { statfs } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { artUploads, uploads } from '../db/schema'
import { DEFAULT_CAPS, type Caps } from '../settings-defaults'

export type Refusal = { status: number; code: string; retryAfterS?: number }

export const UPLOAD_ID_RE = /^[0-9a-f]{32}$/

export function checkCreateHeaders(h: Headers, caps: Caps = DEFAULT_CAPS): Refusal | { length: number } {
  if (h.has('upload-defer-length')) return { status: 400, code: 'defer_length_disabled' }
  if (h.has('upload-concat')) return { status: 400, code: 'concatenation_disabled' }
  const cl = h.get('content-length')
  if ((cl !== null && cl !== '0') || h.has('transfer-encoding')) return { status: 400, code: 'creation_with_upload_disabled' }
  const raw = h.get('upload-length')
  if (raw === null || !/^\d{1,12}$/.test(raw)) return { status: 400, code: 'upload_length_required' }
  const length = Number(raw)
  if (length < 1) return { status: 400, code: 'upload_length_invalid' }
  if (length > caps.maxUploadBytes) return { status: 413, code: 'upload_too_large' }
  return { length }
}

export function checkPatchHeaders(h: Headers, caps: Caps = DEFAULT_CAPS): Refusal | null {
  const cl = h.get('content-length')
  if (cl === null || !/^\d{1,12}$/.test(cl)) return { status: 411, code: 'content_length_required' }
  if (Number(cl) > caps.chunkBytes) return { status: 413, code: 'chunk_too_large' }
  if (h.has('upload-concat') || h.has('upload-defer-length')) return { status: 400, code: 'extension_disabled' }
  return null
}

export async function diskPaused(dir: string, caps: Caps = DEFAULT_CAPS): Promise<boolean> {
  try {
    const s = await statfs(dir)
    const used = 1 - s.bavail / s.blocks
    return used * 100 > caps.diskPausePercent
  } catch {
    return true // cannot tell → do not accept bytes
  }
}

type Tx = Parameters<Parameters<DB['transaction']>[0]>[0]

// One lock for every admission that adds staged bytes (tus uploads here, art
// uploads in art/uploads.ts), so the shared maxStagingBytes cannot be
// overshot by the two racing each other.
export async function lockStaging(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('efm-music:uploads'))`)
}

// Staged bytes on the shared staging disk: tus uploads not yet released,
// plus album art (review SEC-2) while it is processing (raw bytes in
// art-in) or ready (the probe's JPEG, kept 7 days). Art is charged at its
// uploaded size: the row does not record the JPEG's, which is ≤1000 px and
// in practice smaller; the per-user daily count bounds any exception.
export async function stagedBytes(q: Pick<DB, 'execute'>): Promise<{ uploads: number; art: number }> {
  const [g] = await q.execute<{ uploads: string; art: string }>(
    sql`SELECT
          (SELECT COALESCE(SUM(length), 0) FROM ${uploads} WHERE status IN ('uploading','complete','attached'))::bigint AS uploads,
          (SELECT COALESCE(SUM(raw_size), 0) FROM ${artUploads} WHERE status IN ('processing','ready'))::bigint AS art`,
  )
  return { uploads: Number(g?.uploads ?? 0), art: Number(g?.art ?? 0) }
}

// Reserve quota and record the upload row (owner from the SESSION only).
export async function admitUpload(db: DB, userId: string, id: string, length: number, caps: Caps = DEFAULT_CAPS): Promise<Refusal | null> {
  return db.transaction(async (tx) => {
    await lockStaging(tx)
    const staged = await stagedBytes(tx)
    // Per-user "in flight" = every staged byte the user still holds that no
    // decision has released: uploads being written or finished but not
    // attached, plus attached uploads whose item is still undecided
    // (probing / draft / pending). The concurrency count is 'uploading' only.
    const [u] = await tx.execute<{ inflight: string; n: string }>(
      sql`SELECT
            COALESCE(SUM(up.length) FILTER (
              WHERE up.status IN ('uploading', 'complete')
                 OR (up.status = 'attached' AND EXISTS (
                      SELECT 1 FROM items i WHERE i.upload_id = up.id AND i.status IN ('probing', 'draft', 'pending')))
            ), 0)::bigint AS inflight,
            COUNT(*) FILTER (WHERE up.status = 'uploading')::int AS n
          FROM ${uploads} up WHERE up.owner_user_id = ${userId}`,
    )
    if (staged.uploads + staged.art + length > caps.maxStagingBytes) return { status: 503, code: 'staging_full', retryAfterS: 600 }
    if (Number(u?.n ?? 0) >= caps.maxConcurrentUploadsPerUser) return { status: 429, code: 'too_many_concurrent_uploads', retryAfterS: 30 }
    if (Number(u?.inflight ?? 0) + length > caps.maxInflightBytesPerUser) return { status: 429, code: 'inflight_quota', retryAfterS: 60 }
    await tx.insert(uploads).values({ id, ownerUserId: userId, length, status: 'uploading' })
    return null
  })
}
