// POST /api/uploads/art: a standalone album-art upload (art contract). This
// path sits under /api/uploads, which the middleware skips (tus), so the
// CSRF re-check (route()), the rate limit and the body cap all happen here.
// Nothing reads the body before the in-flight slot and the quota pre-check
// (acceptArtUpload; memory bound in server/art/uploads.ts).
import { acceptArtUpload } from '@/server/art/uploads'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { HttpError } from '@/server/http/errors'
import { clientKey, LIMITS, RateLimiter } from '@/server/http/ratelimit'
import { jsonResponse, route } from '@/server/http/route'
import { loadCaps } from '@/server/settings'
import { diskPaused } from '@/server/uploads/caps'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const limiter = new RateLimiter()

// Refusals before the body is read close the connection, so the unread body
// cannot be taken for the next request on a keep-alive socket.
const CLOSE = { Connection: 'close' }
const closing = (e: unknown) => (e instanceof HttpError ? new HttpError(e.status, e.code, e.extra, { ...e.headers, ...CLOSE }) : e)

export const POST = route(async (req) => {
  const r = limiter.hit(LIMITS.mutation, clientKey(req.headers))
  if (!r.ok) throw new HttpError(429, 'rate_limited', undefined, { 'Retry-After': String(r.retryAfterS), ...CLOSE })
  const v = await requirePermission('submit').catch((e: unknown) => {
    throw closing(e)
  })
  const env = webEnv()
  const db = getDb()
  const caps = await loadCaps(db)
  if (await diskPaused(env.STAGING_ART_IN_DIR, caps)) throw new HttpError(503, 'uploads_paused', undefined, { 'Retry-After': '300', ...CLOSE })
  const res = await acceptArtUpload(db, v, req, { artIn: env.STAGING_ART_IN_DIR, art: env.STAGING_ART_DIR, spoolIn: env.SPOOL_PROBE_IN_DIR, spoolOut: env.SPOOL_PROBE_OUT_DIR }, caps)
  return jsonResponse(202, res)
})
