// POST /api/uploads/art: a standalone album-art upload (art contract). This
// path sits under /api/uploads, which the middleware skips (tus), so the
// CSRF re-check (route()), the rate limit and the body cap all happen here.
import { createArtUpload, readArtUpload } from '@/server/art/uploads'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { HttpError } from '@/server/http/errors'
import { clientKey, LIMITS, RateLimiter } from '@/server/http/ratelimit'
import { jsonResponse, route } from '@/server/http/route'
import { diskPaused } from '@/server/uploads/caps'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const limiter = new RateLimiter()

export const POST = route(async (req) => {
  const r = limiter.hit(LIMITS.mutation, clientKey(req.headers))
  if (!r.ok) throw new HttpError(429, 'rate_limited', undefined, { 'Retry-After': String(r.retryAfterS) })
  const v = await requirePermission('submit')
  const env = webEnv()
  if (await diskPaused(env.STAGING_ART_IN_DIR)) throw new HttpError(503, 'uploads_paused', undefined, { 'Retry-After': '300' })
  const bytes = await readArtUpload(req)
  const res = await createArtUpload(getDb(), v, bytes, { artIn: env.STAGING_ART_IN_DIR, art: env.STAGING_ART_DIR, spoolIn: env.SPOOL_PROBE_IN_DIR, spoolOut: env.SPOOL_PROBE_OUT_DIR })
  return jsonResponse(202, res)
})
