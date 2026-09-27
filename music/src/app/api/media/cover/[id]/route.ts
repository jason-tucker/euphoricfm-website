import { eq } from 'drizzle-orm'
import { requirePermission } from '@/server/authz/viewer'
import { canPreviewItem } from '@/server/authz/predicates'
import { getDb } from '@/server/db/client'
import { items } from '@/server/db/schema'
import { webEnv } from '@/server/env'
import { forbidden, notFound } from '@/server/http/errors'
import { parseId, route } from '@/server/http/route'
import { verifyMediaSig } from '@/server/media/signing'
import { isJpeg, serveStagedFile } from '@/server/media/serve'
import { COVER_FILE_RE, UPLOAD_ID_RE } from '@/server/spool/protocol'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  const id = parseId(p.id)
  const it = await getDb().query.items.findFirst({ where: eq(items.id, id) })
  if (!it || !canPreviewItem(v, it)) throw notFound()
  const u = new URL(req.url)
  if (!verifyMediaSig('cover', id, v.userId, u.searchParams.get('exp'), u.searchParams.get('sig'))) throw forbidden('bad_signature')
  // Only bytes the probe accepted are ever served.
  if (!it.probeSha256) throw notFound()
  if (!it.coverFile || !COVER_FILE_RE.test(it.coverFile)) throw notFound()
  return serveStagedFile({ dir: webEnv().STAGING_UPLOADS_DIR, name: it.coverFile, contentType: 'image/jpeg', downloadName: `cover-${id}.jpg`, range: null, magic: isJpeg })
})
