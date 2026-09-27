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
import { effectiveCover } from '@/server/media/cover'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  const id = parseId(p.id)
  const it = await getDb().query.items.findFirst({ where: eq(items.id, id) })
  if (!it || !canPreviewItem(v, it)) throw notFound()
  const u = new URL(req.url)
  if (!verifyMediaSig('cover', id, v.userId, u.searchParams.get('exp'), u.searchParams.get('sig'))) throw forbidden('bad_signature')
  // The EFFECTIVE cover (custom art, else embedded); only probe-made JPEGs
  // are ever served, and only for items whose audio the probe accepted.
  const env = webEnv()
  const cover = await effectiveCover(getDb(), it, { uploads: env.STAGING_UPLOADS_DIR, art: env.STAGING_ART_DIR })
  if (!cover) throw notFound()
  return serveStagedFile({ dir: cover.dir, name: cover.name, contentType: 'image/jpeg', downloadName: `cover-${id}.jpg`, range: null, magic: isJpeg })
})
