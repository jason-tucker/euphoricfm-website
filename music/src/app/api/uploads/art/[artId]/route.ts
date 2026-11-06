// GET /api/uploads/art/:artId: processing | ready | rejected (+ a signed
// preview URL when ready). Uploader or `review` only; everyone else 404.
import { getArtStatus } from '@/server/art/uploads'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { portalSite, webEnv } from '@/server/env'
import { notFound } from '@/server/http/errors'
import { jsonResponse, route } from '@/server/http/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<{ artId: string }>(async (_req, p) => {
  // v0.5.0 site gate (middleware skips /api/uploads/**): no album art on events.
  if (portalSite() === 'events') throw notFound()
  const v = await requirePermission('submit')
  const env = webEnv()
  return jsonResponse(200, await getArtStatus(getDb(), v, p.artId, { art: env.STAGING_ART_DIR, spoolOut: env.SPOOL_PROBE_OUT_DIR }))
})
