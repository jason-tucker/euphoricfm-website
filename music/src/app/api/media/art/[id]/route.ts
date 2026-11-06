// Signed preview of a READY art upload: the probe's re-encoded JPEG only,
// as image/jpeg with nosniff + CSP sandbox. Uploader or `review`, and the
// signature must be bound to this viewer.
import { loadArtVisible } from '@/server/art/uploads'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { forbidden, notFound } from '@/server/http/errors'
import { route } from '@/server/http/route'
import { verifyMediaSig } from '@/server/media/signing'
import { isJpeg, serveStagedFile } from '@/server/media/serve'
import { ART_JPEG_FILE } from '@/server/spool/protocol'
import { join } from 'node:path'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  const row = await loadArtVisible(getDb(), v, p.id)
  const u = new URL(req.url)
  if (!verifyMediaSig('art', row.id, v.userId, u.searchParams.get('exp'), u.searchParams.get('sig'))) throw forbidden('bad_signature')
  if (row.status !== 'ready') throw notFound()
  return serveStagedFile({ dir: join(webEnv().STAGING_ART_DIR, row.id), name: ART_JPEG_FILE, contentType: 'image/jpeg', downloadName: `art-${row.id}.jpg`, range: null, magic: isJpeg })
})
